'use strict';

const { createHash } = require('node:crypto');
const { anthropicToResponses, AnthropicStream, memorySink, collectAnthropicMessage } = require('./vendor/wire-responses');

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function unsupported(message) {
  const error = new TypeError(message);
  error.code = 'unsupported_messages_content';
  return error;
}
function fields(value, allowed, context) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw unsupported(`Unsupported ${context} fields.`);
}
function string(value, context) {
  if (typeof value !== 'string') throw unsupported(`${context} must be a string.`);
}
function cache(value) {
  if (value === undefined) return;
  fields(value, ['type', 'ttl'], 'cache hint');
  if (value.type !== 'ephemeral' || value.ttl !== undefined && !['5m', '1h'].includes(value.ttl)) throw unsupported('Unsupported cache hint.');
}
function content(block, role, references = false) {
  if (!object(block)) throw unsupported('Content blocks must be objects.');
  if (block.type === 'text') {
    fields(block, ['type', 'text', 'cache_control', 'citations'], 'text block');
    string(block.text, 'Text');
    if (block.citations != null && (!Array.isArray(block.citations) || block.citations.length)) throw unsupported('Citations cannot be represented.');
  } else if (block.type === 'image' && role === 'user') {
    fields(block, ['type', 'source', 'cache_control'], 'image block');
    const source = block.source;
    if (source && source.type === 'base64') {
      fields(source, ['type', 'media_type', 'data'], 'base64 source');
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(source.media_type) || typeof source.data !== 'string' || !source.data || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.data)) throw unsupported('Invalid base64 image.');
    } else if (source && source.type === 'url') {
      fields(source, ['type', 'url'], 'image URL source');
      let url;
      try { url = new URL(source.url); } catch { throw unsupported('Invalid image URL.'); }
      if (typeof source.url !== 'string' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw unsupported('Invalid image URL.');
    } else throw unsupported('Unsupported image source.');
  } else if (block.type === 'tool_reference' && references) {
    fields(block, ['type', 'tool_name'], 'tool reference');
    if (typeof block.tool_name !== 'string' || !block.tool_name) throw unsupported('Tool references require a name.');
  } else throw unsupported(`Unsupported ${String(block.type)} content block.`);
  cache(block.cache_control);
}

function messagesToResponses(body, { model, reasoningShape = 'summary' } = {}) {
  fields(body, ['model', 'messages', 'system', 'max_tokens', 'stream', 'temperature', 'top_p', 'tools', 'tool_choice', 'thinking', 'context_management', 'output_config', 'metadata', 'stop_sequences', 'top_k', 'service_tier'], 'Messages request');
  const target = model === undefined ? body.model : model;
  if (typeof target !== 'string' || !target || !['summary', 'content'].includes(reasoningShape) || !Array.isArray(body.messages) || !body.messages.length) throw unsupported('A model and complete explicit Messages history are required.');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw unsupported('stream must be boolean.');
  if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1)) throw unsupported('max_tokens must be a positive integer.');
  if (body.top_k !== undefined || body.stop_sequences !== undefined && (!Array.isArray(body.stop_sequences) || body.stop_sequences.length) || body.service_tier !== undefined && body.service_tier !== 'auto') throw unsupported('Unsupported sampling/stop/service fields.');
  for (const key of ['temperature', 'top_p']) if (body[key] !== undefined && (typeof body[key] !== 'number' || !Number.isFinite(body[key]))) throw unsupported(`Invalid ${key}.`);
  if (body.metadata !== undefined) {
    fields(body.metadata, ['user_id'], 'metadata');
    if (body.metadata.user_id !== undefined) string(body.metadata.user_id, 'user_id');
  }
  if (body.thinking !== undefined) {
    fields(body.thinking, ['type', 'budget_tokens', 'display'], 'thinking configuration');
    if (!['enabled', 'disabled', 'adaptive'].includes(body.thinking.type) || body.thinking.budget_tokens !== undefined || body.thinking.display !== undefined && body.thinking.display !== 'omitted') throw unsupported('Unsupported thinking budget/display; use output_config.effort.');
    // Claude Code's omitted display hint has no Responses equivalent. Keep plaintext
    // reasoning for subsequent tool history; this bridge does not guarantee UI hiding.
  }
  if (body.context_management !== undefined) {
    fields(body.context_management, ['edits'], 'context management');
    if (body.context_management.edits !== undefined) {
      if (!Array.isArray(body.context_management.edits)) throw unsupported('Context edits must be an array.');
      for (const edit of body.context_management.edits) {
        fields(edit, ['type', 'keep'], 'context edit');
        if (edit.type !== 'clear_thinking_20251015' || edit.keep !== 'all') throw unsupported('Only the verified keep-all thinking no-op context edit is supported.');
      }
    }
  }
  if (body.output_config !== undefined) {
    fields(body.output_config, ['effort'], 'output configuration');
    if (body.output_config.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(body.output_config.effort)) throw unsupported('Unsupported reasoning effort.');
  }
  if (body.system !== undefined && typeof body.system !== 'string') {
    if (!Array.isArray(body.system)) throw unsupported('system must be text or text blocks.');
    for (const block of body.system) {
      if (!object(block) || block.type !== 'text') throw unsupported('Only text system blocks are supported.');
      content(block, 'system');
    }
  }
  const calls = new Set();
  const results = new Set();
  for (const message of body.messages) {
    fields(message, ['role', 'content'], 'message');
    if (!['user', 'assistant'].includes(message.role)) throw unsupported('Unsupported message role.');
    if (typeof message.content === 'string') continue;
    if (!Array.isArray(message.content)) throw unsupported('Message content must be text or blocks.');
    for (const block of message.content) {
      if (!object(block)) throw unsupported('Content must be an object.');
      if (block.type === 'thinking') {
        fields(block, ['type', 'thinking', 'signature'], 'thinking block');
        if (message.role !== 'assistant') throw unsupported('Only assistant thinking is supported.');
        string(block.thinking, 'Thinking');
        if (block.signature !== undefined) string(block.signature, 'Signature');
      } else if (block.type === 'tool_use') {
        fields(block, ['type', 'id', 'name', 'input', 'cache_control'], 'tool call');
        if (message.role !== 'assistant' || typeof block.id !== 'string' || !block.id || calls.has(block.id) || typeof block.name !== 'string' || !block.name || !object(block.input)) throw unsupported('Tool calls require original unique id/name/object input.');
        calls.add(block.id);
      } else if (block.type === 'tool_result') {
        fields(block, ['type', 'tool_use_id', 'content', 'is_error', 'cache_control'], 'tool result');
        if (message.role !== 'user' || !calls.has(block.tool_use_id) || results.has(block.tool_use_id) || !Object.hasOwn(block, 'content') || block.is_error !== undefined && block.is_error !== false) throw unsupported('Tool results require matching IDs; error flags cannot be represented exactly.');
        results.add(block.tool_use_id);
        if (typeof block.content !== 'string') {
          if (!Array.isArray(block.content)) throw unsupported('Unsupported tool result.');
          for (const part of block.content) {
            content(part, 'user', true);
            if (part.type === 'tool_reference' && (!body.tools || !body.tools.some(tool => tool.name === part.tool_name))) throw unsupported('Tool references require a fully declared ordinary tool.');
          }
        }
      } else content(block, message.role);
      cache(block.cache_control);
    }
  }
  if ([...calls].some(id => !results.has(id))) throw unsupported('A tool call is missing its matching result.');
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw unsupported('tools must be an array.');
    const names = new Set();
    for (const tool of body.tools) {
      fields(tool, ['name', 'description', 'input_schema', 'cache_control', 'defer_loading'], 'ordinary function tool');
      if (typeof tool.name !== 'string' || !tool.name || names.has(tool.name) || !object(tool.input_schema) || tool.input_schema.type !== 'object') throw unsupported('Only ordinary object-schema function tools are supported, not platform tool types.');
      if (tool.description !== undefined) string(tool.description, 'Tool description');
      if (tool.defer_loading !== undefined && typeof tool.defer_loading !== 'boolean') throw unsupported('Invalid defer_loading.');
      names.add(tool.name);
      cache(tool.cache_control);
    }
  }
  if (body.tool_choice !== undefined) {
    fields(body.tool_choice, ['type', 'name', 'disable_parallel_tool_use'], 'tool choice');
    const choice = body.tool_choice;
    if (!['auto', 'any', 'none', 'tool'].includes(choice.type) || choice.type !== 'tool' && choice.name !== undefined || choice.type === 'tool' && (!body.tools || !body.tools.some(tool => tool.name === choice.name))) throw unsupported('Unsupported tool choice.');
    if (choice.disable_parallel_tool_use !== undefined && typeof choice.disable_parallel_tool_use !== 'boolean') throw unsupported('Invalid parallel tool option.');
  }
  const result = anthropicToResponses(structuredClone(body), { model: target, reasoningShape });
  if (body.max_tokens !== undefined) result.max_output_tokens = body.max_tokens;
  for (const key of ['temperature', 'top_p']) if (body[key] !== undefined) result[key] = body[key];
  if (body.metadata && body.metadata.user_id !== undefined) {
    const user = body.metadata.user_id;
    result.user = user.length <= 64 ? user : createHash('sha256').update(user, 'utf8').digest('hex');
  }
  if (body.tool_choice && body.tool_choice.disable_parallel_tool_use !== undefined) result.parallel_tool_calls = !body.tool_choice.disable_parallel_tool_use;
  return result;
}

function createMessagesRenderer({ stream = true, model, write, end = () => {}, tools, opaqueReasoning = 'omit' } = {}) {
  if (typeof stream !== 'boolean' || typeof write !== 'function' || typeof end !== 'function' || !['omit', 'error'].includes(opaqueReasoning)) throw new TypeError('Renderer requires stream, write/end callbacks and a supported opaqueReasoning option.');
  const sink = stream ? { res: { writableEnded: false, destroyed: false, write } } : memorySink();
  const converter = new AnthropicStream(sink.res, model || '', { tools });
  const byId = new Map();
  const byIndex = new Map();
  const items = new Set();
  const callIds = new Map();
  const texts = new Map();
  let terminal = false;
  let terminalResponse;
  let ended = false;

  function fail(message, code = 'api_error') {
    if (ended) return;
    if (stream) converter.finishTerminal('failed', { message: String(message), code });
    else write(JSON.stringify({ type: 'error', error: { type: code === 'rate_limit_exceeded' || code === 'rate_limit_error' ? 'rate_limit_error' : code === 'unsupported_messages_content' ? 'invalid_request_error' : 'api_error', message: String(message), ...(code !== 'api_error' ? { code } : {}) } }));
    ended = true;
    end();
  }
  function itemFor(event, value, type) {
    const id = value && value.id !== undefined ? value.id : event.item_id;
    const index = event.output_index;
    if (id !== undefined && (typeof id !== 'string' || !id) || index !== undefined && (!Number.isInteger(index) || index < 0)) throw unsupported('Invalid output coordinates.');
    const a = byId.get(id), b = byIndex.get(index);
    if (a && b && a !== b) throw unsupported('Conflicting output identities.');
    let item = a || b;
    if (!item && items.size === 1) {
      const candidate = [...items][0];
      if (id === undefined && index === undefined || candidate.id === undefined && candidate.index === undefined) item = candidate;
    }
    if (!item && id === undefined && index === undefined && items.size > 1) throw unsupported('Ambiguous content without output identity.');
    if (!item) { item = { key: `item${items.size}`, args: '', type }; items.add(item); }
    if (id !== undefined) {
      if (item.id !== undefined && item.id !== id) throw unsupported('Output ID changed.');
      item.id = id; byId.set(id, item);
    }
    if (index !== undefined) {
      if (item.index !== undefined && item.index !== index) throw unsupported('Output index changed.');
      item.index = index; byIndex.set(index, item);
    }
    const actual = value && value.type || type;
    if (actual) {
      if (!['message', 'reasoning', 'function_call', 'custom_tool_call'].includes(actual) || item.type && item.type !== actual) throw unsupported('Unsupported or changed output type.');
      item.type = actual;
    }
    return item;
  }
  function text(item, kind, index, value, append = false) {
    string(value, 'Output text');
    if (!Number.isInteger(index) || index < 0) throw unsupported('Invalid content index.');
    const key = `${item.key}:${kind}:${index}`;
    const had = texts.get(key) || '';
    const full = append ? had + value : value;
    if (!full.startsWith(had)) throw unsupported('Text snapshot conflicts with deltas.');
    if (texts.has(key) && full === had) return;
    texts.set(key, full);
    converter.handle({ type: kind === 'text' || kind === 'refusal' ? 'response.output_text.done' : 'response.reasoning_text.done', bridge_key: key, text: full });
  }
  function tool(item, value, complete = false) {
    for (const key of ['name', 'call_id']) if (value[key] !== undefined) {
      if (typeof value[key] !== 'string' || !value[key] || item[key] !== undefined && item[key] !== value[key]) throw unsupported('Invalid tool name/call_id.');
      if (key === 'call_id') {
        if (callIds.has(value[key]) && callIds.get(value[key]) !== item) throw unsupported('Duplicate tool call_id.');
        callIds.set(value[key], item);
      }
      item[key] = value[key];
    }
    const raw = item.type === 'custom_tool_call' ? value.input : value.arguments;
    if (raw !== undefined) {
      const full = object(raw) ? JSON.stringify(raw) : raw;
      string(full, 'Tool input');
      if (!full.startsWith(item.args)) throw unsupported('Tool input conflicts with deltas.');
      item.args = full;
    }
    if (complete) {
      let input;
      try { input = JSON.parse(item.args); } catch { throw unsupported('Tool input is not complete JSON; free-form custom tools are unsupported.'); }
      if (!object(input)) throw unsupported('Tool input must be a JSON object.');
      if (!item.name || !item.call_id) return;
      if (item.emitted) return;
      item.emitted = true;
      converter.handle({ type: 'response.output_item.done', bridge_key: item.key, item: { type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.args } });
    }
  }
  function part(item, value, index, summary = false) {
    if (!object(value)) throw unsupported('Invalid content part.');
    if (value.type === 'output_text') {
      fields(value, ['type', 'text', 'annotations', 'logprobs'], 'output text');
      if (value.annotations && (!Array.isArray(value.annotations) || value.annotations.length)) throw unsupported('Annotations cannot be represented.');
      text(item, 'text', index, value.text);
    } else if (value.type === 'refusal') { fields(value, ['type', 'refusal'], 'refusal'); text(item, 'refusal', index, value.refusal); }
    else if (value.type === 'summary_text' || value.type === 'reasoning_text') { fields(value, ['type', 'text'], 'reasoning part'); text(item, summary ? 'summary' : 'reasoning', index, value.text); }
    else throw unsupported('Unsupported output content part.');
  }
  function snapshot(event, value, complete) {
    if (!object(value)) throw unsupported('Invalid output item.');
    const item = itemFor(event, value);
    const common = ['id', 'type', 'status'];
    fields(value, item.type === 'message' ? [...common, 'role', 'content', 'phase'] : item.type === 'reasoning' ? [...common, 'summary', 'content', 'encrypted_content'] : [...common, 'call_id', 'name', item.type === 'function_call' ? 'arguments' : 'input'], 'output item');
    if (item.type === 'function_call' || item.type === 'custom_tool_call') tool(item, value, complete);
    else if (item.type === 'message') {
      if (value.phase !== undefined && !['final_answer', 'commentary'].includes(value.phase)) throw unsupported('Unsupported output message phase.');
      if (value.role !== undefined && value.role !== 'assistant') throw unsupported('Invalid output role.');
      if (value.content !== undefined) {
        if (!Array.isArray(value.content)) throw unsupported('Output content must be an array.');
        value.content.forEach((valuePart, index) => part(item, valuePart, index));
      }
    } else {
      for (const key of ['summary', 'content']) if (value[key] !== undefined) {
        if (!Array.isArray(value[key])) throw unsupported('Reasoning parts must be an array.');
        value[key].forEach((valuePart, index) => part(item, valuePart, index, key === 'summary'));
      }
      if (value.encrypted_content) {
        if (complete && opaqueReasoning === 'error' && ![...texts].some(([key, value]) => key.startsWith(`${item.key}:`) && value)) throw unsupported('Encrypted-only reasoning has no Messages representation.');
        // Lossy compatibility with the vendored converter: do not expose ciphertext
        // as thinking/signature. The caller retains the original Responses event.
      }
    }
  }
  function handle(event) {
    if (ended) return;
    try {
      if (!object(event) || typeof event.type !== 'string') throw unsupported('Invalid Responses event.');
      const type = event.type;
      if (type === 'error' || type === 'response.failed') {
        const error = type === 'error' ? event.error || event : event.response && event.response.error;
        return fail(error && error.message || 'The upstream failed.', error && error.code || 'api_error');
      }
      if (type === '__done__') {
        fields(event, ['type'], 'stream completion marker');
        if (!terminal) throw unsupported('Stream completion marker arrived before a terminal response.');
        return;
      }
      if (terminal) throw unsupported('Event after terminal response.');
      if (['response.created', 'response.queued', 'response.in_progress', 'response.completed', 'response.incomplete'].includes(type)) {
        fields(event, ['type', 'sequence_number', 'response'], 'lifecycle event');
        const response = event.response;
        if (!object(response)) throw unsupported('Missing response object.');
        converter.handle({ type: 'response.created', response });
        const done = type === 'response.completed' || type === 'response.incomplete';
        if (response.output !== undefined) {
          if (!Array.isArray(response.output)) throw unsupported('Invalid response output.');
          response.output.forEach((value, index) => snapshot({ output_index: index }, value, done));
        }
        if (response.output_text !== undefined) {
          string(response.output_text, 'response.output_text');
          const current = [...texts].filter(([key]) => key.includes(':text:')).map(([, value]) => value).join('');
          if (response.output_text && !current) text(itemFor({ output_index: response.output && response.output.length || 0 }, null, 'message'), 'text', 0, response.output_text);
          else if (response.output_text && response.output_text !== current) throw unsupported('response.output_text conflicts with content.');
        }
        if (done) {
          if (response.usage != null) {
            const usage = response.usage;
            if (!object(usage) || !Number.isInteger(usage.input_tokens) || usage.input_tokens < 0 || !Number.isInteger(usage.output_tokens) || usage.output_tokens < 0) throw unsupported('Malformed Responses usage.');
            const cached = usage.input_tokens_details && usage.input_tokens_details.cached_tokens;
            if (cached !== undefined && (!Number.isInteger(cached) || cached < 0 || cached > usage.input_tokens)) throw unsupported('Malformed cached usage.');
          }
          if (response.error) throw unsupported('A successful terminal response carries an error.');
          if (response.status !== undefined && response.status !== type.slice(9)) throw unsupported('Terminal status mismatch.');
          if (type === 'response.incomplete' && !['max_output_tokens', 'max_tokens'].includes(response.incomplete_details && response.incomplete_details.reason)) throw unsupported('Unsupported incomplete reason.');
          for (const item of items) if (item.type === 'function_call' || item.type === 'custom_tool_call') {
            tool(item, {}, true);
            if (!item.name || !item.call_id) throw unsupported('Tool call is missing name/call_id.');
          }
          terminalResponse = { kind: type.slice(9), usage: response.usage, reason: type === 'response.incomplete' ? 'max_output_tokens' : '' };
          terminal = true;
        }
      } else if (type === 'response.output_item.added' || type === 'response.output_item.done') snapshot(event, event.item, type.endsWith('.done'));
      else if (type.endsWith('.delta') || type.endsWith('.done')) {
        const coordinates = ['type', 'sequence_number', 'item_id', 'output_index', 'content_index', 'summary_index', 'obfuscation'];
        if (['response.function_call_arguments.delta', 'response.function_call_arguments.done', 'response.custom_tool_call_input.delta', 'response.custom_tool_call_input.done'].includes(type)) {
          fields(event, [...coordinates, 'name', 'call_id', 'delta', 'arguments', 'input'], 'tool event');
          const item = itemFor(event, null, type.includes('custom_tool') ? 'custom_tool_call' : 'function_call');
          if (type.endsWith('.delta')) { string(event.delta, 'Tool delta'); item.args += event.delta; }
          tool(item, event, type.endsWith('.done'));
        } else if (['response.output_text.delta', 'response.output_text.done', 'response.refusal.delta', 'response.refusal.done', 'response.reasoning_text.delta', 'response.reasoning_text.done', 'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done'].includes(type)) {
          fields(event, [...coordinates, 'text', 'refusal', 'delta', 'logprobs'], 'text event');
          const item = itemFor(event, null, type.includes('reasoning') ? 'reasoning' : 'message');
          const kind = type.includes('summary') ? 'summary' : type.includes('reasoning') ? 'reasoning' : type.includes('refusal') ? 'refusal' : 'text';
          text(item, kind, kind === 'summary' ? event.summary_index ?? 0 : event.content_index ?? 0, type.endsWith('.delta') ? event.delta : kind === 'refusal' ? event.refusal : event.text, type.endsWith('.delta'));
        } else if (type === 'response.content_part.done' || type === 'response.reasoning_summary_part.done') part(itemFor(event, null, type.includes('reasoning') ? 'reasoning' : 'message'), event.part, event.content_index ?? event.summary_index ?? 0, type.includes('summary'));
        else throw unsupported(`Unsupported Responses content event: ${type}.`);
      } else if (type === 'response.content_part.added' || type === 'response.reasoning_summary_part.added') part(itemFor(event, null, type.includes('reasoning') ? 'reasoning' : 'message'), event.part, event.content_index ?? event.summary_index ?? 0, type.includes('summary'));
      else fields(event, ['type', 'sequence_number', 'response_id', 'item_id', 'output_index', 'content_index', 'summary_index', 'status', 'created_at', 'obfuscation'], 'metadata-only event');
    } catch (error) { fail(error.message, error.code || 'api_error'); }
  }
  function finish() {
    if (ended) return;
    if (!terminal) return fail('The Responses stream ended without a terminal event.', 'incomplete_upstream_stream');
    try {
      converter.finishTerminal(terminalResponse.kind, terminalResponse);
      if (!stream) write(JSON.stringify(collectAnthropicMessage(sink.text())));
      ended = true;
      end();
    } catch (error) { fail(error.message, error.code || 'api_error'); }
  }
  return { handle, finish, fail };
}

module.exports = { messagesToResponses, createMessagesRenderer };
