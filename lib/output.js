'use strict';

const { TextDecoder } = require('node:util');

const RESPONSE_FIELDS = new Set(['id', 'object', 'created_at', 'status', 'background', 'error', 'incomplete_details', 'instructions', 'max_output_tokens', 'max_tool_calls', 'model', 'output', 'output_text', 'parallel_tool_calls', 'previous_response_id', 'reasoning', 'store', 'temperature', 'text', 'tool_choice', 'tools', 'top_p', 'truncation', 'usage', 'user', 'metadata', 'service_tier', 'prompt_cache_key', 'prompt_cache_retention', 'safety_identifier', 'conversation']);
const MESSAGE_FIELDS = new Set(['id', 'type', 'role', 'content', 'model', 'stop_reason', 'stop_sequence', 'usage', 'container']);
const CHAT_FIELDS = new Set(['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier']);
const RESPONSE_LIFECYCLE = new Set(['response.created', 'response.queued', 'response.in_progress']);
const MEDIA_TYPES = new Set(['image', 'output_image', 'audio', 'output_audio', 'video', 'document']);
const RESPONSE_TOOLS = new Set(['web_search_call', 'file_search_call', 'computer_call', 'code_interpreter_call', 'image_generation_call', 'local_shell_call', 'shell_call', 'apply_patch_call', 'mcp_call', 'mcp_list_tools', 'mcp_approval_request', 'custom_tool_call']);
const MESSAGE_TOOLS = new Set(['server_tool_use', 'tool_result', 'web_search_tool_result', 'web_fetch_tool_result', 'code_execution_tool_result', 'bash_code_execution_tool_result', 'text_editor_code_execution_tool_result', 'container_upload']);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonblank(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseSseFrame(frame) {
  if (!Buffer.isBuffer(frame)) return { ok: false };
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(frame); } catch { return { ok: false }; }
  const data = [];
  let eventName;
  let comment = false;
  let unknown = false;
  let ended = false;
  let seen = false;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === '') {
      if (seen) ended = true;
      continue;
    }
    if (ended) return { ok: false };
    seen = true;
    if (line.startsWith(':')) {
      comment = true;
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    else if (field === 'event') {
      if (eventName !== undefined && eventName !== value) return { ok: false };
      eventName = value;
    } else unknown = true;
  }
  if (data.length === 0) {
    const result = { ok: true, event: null, comment: comment || !seen };
    if (unknown || eventName !== undefined) result.unknown = true;
    return result;
  }
  let event;
  if (data.join('\n').trim() === '[DONE]') event = { type: '__done__' };
  else {
    try { event = JSON.parse(data.join('\n')); } catch { return { ok: false }; }
    if (!record(event)) return { ok: false };
  }
  if (eventName) {
    if (event.type !== undefined && event.type !== eventName) return { ok: false };
    if (event.type === undefined) event = { ...event, type: eventName };
  }
  const result = { ok: true, event, comment };
  if (unknown) result.unknown = true;
  return result;
}

// A comment-only SSE frame carries no data, no event field and no unknown field.
// It is transport metadata (heartbeat/keepalive), never model output, so it may
// be held without committing a replay barrier. Any comment mixed with data or an
// event name is not comment-only and stays a barrier.
function isSafeHeartbeatFrame(parsed) {
  return parsed !== null && typeof parsed === 'object' && parsed.ok === true
    && parsed.event === null && parsed.comment === true && !parsed.unknown;
}

function createInspector(protocol) {
  const state = { terminal: false, normal: false, hasOutput: false, unknown: false, error: false };
  const choices = new Map();
  const blocks = new Map();
  const closedBlocks = new Set();
  let messageStarted = false;
  let messageFinish;
  let abnormalMessageFinish = false;
  let abnormalChatFinish = false;
  let chatDone = false;

  function unknown() { state.unknown = true; }
  function output() { state.hasOutput = true; }
  function fields(value, allowed) {
    if (!record(value)) { unknown(); return false; }
    if (Object.keys(value).some(key => !allowed.has(key))) unknown();
    return true;
  }
  function keys(value, allowed) { return fields(value, new Set(allowed)); }
  function text(value) {
    if (typeof value !== 'string') unknown();
    else if (nonblank(value)) output();
  }
  function opaque(value) {
    if (value !== undefined && value !== null) unknown();
  }
  function array(value, visit) {
    if (!Array.isArray(value)) { unknown(); return false; }
    for (const item of value) visit(item);
    return true;
  }
  function part(value) {
    if (!record(value)) { unknown(); return; }
    if (['output_text', 'text', 'summary_text', 'reasoning_text', 'thinking'].includes(value.type)) {
      keys(value, value.type === 'thinking' ? ['type', 'thinking', 'signature'] : ['type', 'text', 'annotations', 'logprobs', 'citations']);
      text(value.type === 'thinking' ? value.thinking : value.text);
      if (value.signature !== undefined && value.signature !== '') opaque(value.signature);
      if (value.annotations != null && (!Array.isArray(value.annotations) || value.annotations.length)) unknown();
      if (value.citations != null && (!Array.isArray(value.citations) || value.citations.length)) unknown();
    } else if (value.type === 'refusal') {
      keys(value, ['type', 'refusal']);
      output();
    } else if (MEDIA_TYPES.has(value.type)) output();
    else if (value.type === 'redacted_thinking') {
      keys(value, ['type', 'data']);
      unknown();
    } else unknown();
  }
  function responseItem(value) {
    if (!record(value)) { unknown(); return; }
    if (value.type === 'message') {
      keys(value, ['type', 'id', 'status', 'role', 'content', 'phase']);
      if (value.role !== undefined && value.role !== 'assistant') unknown();
      if (value.phase !== undefined && !['commentary', 'final_answer'].includes(value.phase)) unknown();
      array(value.content, part);
    } else if (value.type === 'reasoning') {
      keys(value, ['type', 'id', 'status', 'summary', 'content', 'encrypted_content']);
      if (value.summary !== undefined) array(value.summary, part);
      if (value.content !== undefined) array(value.content, part);
      if (value.summary === undefined && value.content === undefined) unknown();
      opaque(value.encrypted_content);
    } else if (value.type === 'function_call') {
      keys(value, ['type', 'id', 'status', 'call_id', 'name', 'arguments']);
      if (nonblank(value.name) || nonblank(value.call_id) || nonblank(value.arguments)) output();
      else unknown();
    } else if (RESPONSE_TOOLS.has(value.type) || MEDIA_TYPES.has(value.type)) output();
    else unknown();
  }
  function response(value, terminalType) {
    if (!fields(value, RESPONSE_FIELDS)) return;
    if (value.output !== undefined) array(value.output, responseItem);
    if (value.output_text !== undefined) text(value.output_text);
    if (value.object !== undefined && value.object !== 'response') unknown();
    if (value.reasoning != null) keys(value.reasoning, ['effort', 'summary', 'generate_summary']);
    if (value.error != null) {
      state.error = true;
      state.terminal = true;
    }
    const status = terminalType || value.status;
    if (terminalType && value.status !== undefined && value.status !== terminalType) unknown();
    if (status === 'completed') {
      state.terminal = true;
      state.normal = true;
      if (!Array.isArray(value.output)) unknown();
      if (value.incomplete_details != null) { state.normal = false; unknown(); }
    } else if (status === 'failed' || status === 'cancelled') {
      state.terminal = true;
      state.normal = false;
      state.error = true;
    } else if (status === 'incomplete') {
      state.terminal = true;
      state.normal = false;
    } else if (status !== undefined && !['in_progress', 'queued'].includes(status)) unknown();
  }
  function messageBlock(value) {
    if (!record(value)) { unknown(); return; }
    if (value.type === 'tool_use' || value.type === 'server_tool_use') {
      keys(value, ['type', 'id', 'name', 'input']);
      if (nonblank(value.id) || nonblank(value.name)) output();
      else unknown();
    } else if (MESSAGE_TOOLS.has(value.type) || MEDIA_TYPES.has(value.type)) output();
    else part(value);
  }
  function setMessageFinish(reason) {
    if (reason === null || reason === undefined) return;
    messageFinish = reason;
    if (!['end_turn', 'stop_sequence'].includes(reason)) {
      abnormalMessageFinish = true;
      state.terminal = true;
      state.normal = false;
    }
    if (reason === 'refusal') output();
    else if (reason === 'tool_use' && !state.hasOutput) unknown();
    else if (!['end_turn', 'stop_sequence', 'max_tokens', 'tool_use', 'pause_turn', 'model_context_window_exceeded'].includes(reason)) unknown();
  }
  function message(value, json) {
    if (!fields(value, MESSAGE_FIELDS)) return;
    if (value.type !== undefined && value.type !== 'message') unknown();
    if (value.role !== undefined && value.role !== 'assistant') unknown();
    array(value.content, messageBlock);
    setMessageFinish(value.stop_reason);
    if (json && value.stop_reason != null) {
      state.terminal = true;
      state.normal = !abnormalMessageFinish && ['end_turn', 'stop_sequence'].includes(messageFinish);
    }
  }
  function toolCall(value, legacy) {
    if (!record(value)) { unknown(); return; }
    keys(value, legacy ? ['name', 'arguments'] : ['index', 'id', 'type', 'function']);
    if (!legacy && value.type !== undefined && value.type !== 'function') unknown();
    const fn = legacy ? value : value.function;
    if (fn !== undefined && !keys(fn, ['name', 'arguments'])) return;
    if (nonblank(value.id) || fn && (nonblank(fn.name) || nonblank(fn.arguments))) output();
    else unknown();
  }
  function chatMessage(value) {
    if (!keys(value, ['role', 'content', 'refusal', 'tool_calls', 'function_call', 'reasoning_content', 'reasoning', 'audio', 'annotations'])) return;
    if (value.role !== undefined && value.role !== 'assistant') unknown();
    if (value.content !== undefined && value.content !== null) {
      if (Array.isArray(value.content)) array(value.content, part);
      else text(value.content);
    }
    if (value.reasoning_content !== undefined && value.reasoning_content !== null) text(value.reasoning_content);
    if (value.reasoning !== undefined && value.reasoning !== null) {
      if (typeof value.reasoning === 'string') text(value.reasoning);
      else unknown();
    }
    if (value.refusal !== undefined && value.refusal !== null) output();
    if (value.tool_calls !== undefined && value.tool_calls !== null) array(value.tool_calls, item => toolCall(item, false));
    if (value.function_call !== undefined && value.function_call !== null) toolCall(value.function_call, true);
    if (value.audio !== undefined && value.audio !== null) output();
    if (value.annotations != null && (!Array.isArray(value.annotations) || value.annotations.length)) unknown();
  }
  function chat(value, json) {
    if (!fields(value, CHAT_FIELDS)) return;
    if (value.object !== undefined && !['chat.completion', 'chat.completion.chunk'].includes(value.object)) unknown();
    if (!Array.isArray(value.choices)) { unknown(); return; }
    if (json && value.choices.length === 0) unknown();
    for (const choice of value.choices) {
      if (!keys(choice, ['index', 'message', 'delta', 'finish_reason', 'logprobs'])) continue;
      if (!Number.isInteger(choice.index) || choice.index < 0) unknown();
      if (!choices.has(choice.index)) choices.set(choice.index, false);
      if (choice.message !== undefined) chatMessage(choice.message);
      if (choice.delta !== undefined) chatMessage(choice.delta);
      if (choice.message === undefined && choice.delta === undefined) unknown();
      const finish = choice.finish_reason;
      if (finish != null) {
        choices.set(choice.index, true);
        if (finish === 'stop') state.normal = true;
        else {
          abnormalChatFinish = true;
          state.normal = false;
          if (!['length', 'content_filter', 'tool_calls', 'function_call'].includes(finish)) unknown();
          if (['tool_calls', 'function_call'].includes(finish) && !state.hasOutput) unknown();
        }
      } else if (json) unknown();
      if (json && (!record(choice.message) || choice.message.content === undefined)) unknown();
    }
    state.terminal = choices.size > 0 && [...choices.values()].every(Boolean);
    if (abnormalChatFinish) state.normal = false;
  }
  function responseEvent(event) {
    const type = event.type;
    if (type === '__done__') {
      keys(event, ['type']);
      if (!state.terminal) unknown();
      return state.terminal && state.normal;
    }
    if (RESPONSE_LIFECYCLE.has(type)) {
      keys(event, ['type', 'sequence_number', 'response']);
      response(event.response);
      if (state.terminal) unknown();
      return !state.terminal;
    }
    if (['response.completed', 'response.failed', 'response.incomplete'].includes(type)) {
      keys(event, ['type', 'sequence_number', 'response']);
      const status = type.slice('response.'.length);
      state.terminal = true;
      if (status === 'failed') state.error = true;
      response(event.response, status);
      return status === 'completed';
    }
    if (type === 'error') {
      keys(event, ['type', 'sequence_number', 'error', 'code', 'message', 'param']);
      state.terminal = true;
      state.error = true;
      return false;
    }
    if (['response.output_item.added', 'response.output_item.done'].includes(type)) {
      keys(event, ['type', 'sequence_number', 'output_index', 'item']);
      responseItem(event.item);
      return true;
    }
    if (['response.content_part.added', 'response.content_part.done', 'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done'].includes(type)) {
      keys(event, ['type', 'sequence_number', 'item_id', 'output_index', 'content_index', 'summary_index', 'part']);
      part(event.part);
      return true;
    }
    if (/^response\.(output_text|reasoning_text|reasoning_summary_text)\.(delta|done)$/.test(type)) {
      const field = type.endsWith('.delta') ? 'delta' : 'text';
      keys(event, ['type', 'sequence_number', 'item_id', 'output_index', 'content_index', 'summary_index', field, 'logprobs']);
      text(event[field]);
      return true;
    }
    if (/^response\.refusal\.(delta|done)$/.test(type)) {
      keys(event, ['type', 'sequence_number', 'item_id', 'output_index', 'content_index', 'delta', 'refusal']);
      output();
      return false;
    }
    if (/^response\.function_call_arguments\.(delta|done)$/.test(type)) {
      keys(event, ['type', 'sequence_number', 'item_id', 'output_index', 'delta', 'arguments', 'name']);
      if (nonblank(event.name) || nonblank(type.endsWith('.delta') ? event.delta : event.arguments)) output();
      else if (!state.hasOutput) unknown();
      return false;
    }
    if (/^response\.(audio|output_audio|audio_transcript|output_audio_transcript)\.(delta|done)$/.test(type)) {
      output();
      return false;
    }
    unknown();
    return false;
  }
  function messageEvent(event) {
    if (event.type === 'message_start') {
      keys(event, ['type', 'message']);
      if (messageStarted) unknown();
      messageStarted = true;
      message(event.message, false);
      return true;
    }
    if (event.type === 'content_block_start') {
      keys(event, ['type', 'index', 'content_block']);
      if (!messageStarted || !Number.isInteger(event.index) || event.index < 0) unknown();
      if (blocks.has(event.index)) unknown();
      blocks.set(event.index, record(event.content_block) ? event.content_block.type : undefined);
      messageBlock(event.content_block);
      return true;
    }
    if (event.type === 'content_block_delta') {
      keys(event, ['type', 'index', 'delta']);
      if (!messageStarted || !blocks.has(event.index) || closedBlocks.has(event.index)) unknown();
      if (!record(event.delta)) { unknown(); return false; }
      const delta = event.delta;
      if (delta.type === 'text_delta' || delta.type === 'thinking_delta') {
        const field = delta.type === 'text_delta' ? 'text' : 'thinking';
        keys(delta, ['type', field]);
        if (blocks.get(event.index) !== (field === 'text' ? 'text' : 'thinking')) unknown();
        text(delta[field]);
      } else if (delta.type === 'input_json_delta') {
        keys(delta, ['type', 'partial_json']);
        if (!['tool_use', 'server_tool_use'].includes(blocks.get(event.index))) unknown();
        if (nonblank(delta.partial_json)) output();
        else if (!state.hasOutput) unknown();
      } else if (delta.type === 'signature_delta') {
        keys(delta, ['type', 'signature']);
        if (blocks.get(event.index) !== 'thinking' || typeof delta.signature !== 'string') unknown();
        if (delta.signature !== '') opaque(delta.signature);
      } else unknown();
      return true;
    }
    if (event.type === 'content_block_stop') {
      keys(event, ['type', 'index']);
      if (!messageStarted || !blocks.has(event.index) || closedBlocks.has(event.index)) unknown();
      closedBlocks.add(event.index);
      return true;
    }
    if (event.type === 'message_delta') {
      keys(event, ['type', 'delta', 'usage']);
      if (!messageStarted) unknown();
      if (keys(event.delta, ['stop_reason', 'stop_sequence'])) setMessageFinish(event.delta.stop_reason);
      return true;
    }
    if (event.type === 'message_stop') {
      keys(event, ['type']);
      state.terminal = true;
      state.normal = messageStarted && !abnormalMessageFinish && ['end_turn', 'stop_sequence'].includes(messageFinish);
      if (!messageStarted || messageFinish === undefined || blocks.size !== closedBlocks.size) unknown();
      return state.normal;
    }
    if (event.type === 'ping') {
      keys(event, ['type']);
      return true;
    }
    if (event.type === 'error') {
      keys(event, ['type', 'error']);
      state.terminal = true;
      state.error = true;
      return false;
    }
    unknown();
    return false;
  }
  function result() {
    return {
      terminal: state.terminal,
      empty: state.terminal && state.normal && !state.hasOutput && !state.unknown && !state.error,
      hasOutput: state.hasOutput,
      unknown: state.unknown,
      error: state.error
    };
  }
  function observe(event) {
    let safe = false;
    if (state.terminal && protocol !== 'chat' && record(event) && !(protocol === 'responses' && event.type === '__done__')) unknown();
    if (chatDone) unknown();
    if (!record(event)) unknown();
    else if (protocol === 'responses') safe = responseEvent(event);
    else if (protocol === 'messages') safe = messageEvent(event);
    else if (protocol === 'chat') {
      if (event.type === '__done__') {
        keys(event, ['type']);
        chatDone = true;
        state.terminal = true;
        state.normal = choices.size > 0 && !abnormalChatFinish;
        if (choices.size === 0) unknown();
        safe = state.normal;
      } else if (event.error !== undefined) {
        keys(event, ['error']);
        state.terminal = true;
        state.error = true;
      } else { chat(event, false); safe = true; }
    } else unknown();
    const current = result();
    return { hold: safe && !state.hasOutput && !state.unknown && !state.error && (!state.terminal || state.normal), ...current };
  }
  function inspectJson(body) {
    if (!['responses', 'messages', 'chat'].includes(protocol) || !record(body)) unknown();
    else if (body.error != null && protocol !== 'responses') {
      state.terminal = true;
      state.error = true;
      if (Object.keys(body).some(key => key !== 'error')) unknown();
    } else if (protocol === 'responses') response(body);
    else if (protocol === 'messages') message(body, true);
    else if (protocol === 'chat') chat(body, true);
    else unknown();
    return result();
  }
  return { observe, result, inspectJson };
}

function createOutputInspector(protocol) {
  const { observe, result } = createInspector(protocol);
  return { observe, result };
}

function inspectResponseJson(protocol, body) {
  return createInspector(protocol).inspectJson(body);
}

module.exports = { inspectResponseJson, createOutputInspector, parseSseFrame, isSafeHeartbeatFrame };
