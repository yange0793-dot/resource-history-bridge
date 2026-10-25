'use strict';

const RESOURCE_ERROR = /\bThe requested item was created under a different Azure OpenAI resource\b/i;
const OUTPUT_TYPES = new Set(['reasoning', 'function_call']);
const MESSAGE_ROLES = new Set(['user', 'developer', 'system', 'assistant']);
const MESSAGE_PHASES = new Set(['commentary', 'final_answer']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const ERROR_FIELDS = new Set(['message', 'type', 'code', 'param', 'status', 'status_code', 'request_id', 'trace_id', 'sequence_number']);
const FAILED_RESPONSE_FIELDS = new Set(['id', 'object', 'created_at', 'status', 'background', 'error', 'incomplete_details', 'instructions', 'max_output_tokens', 'max_tool_calls', 'model', 'output', 'output_text', 'parallel_tool_calls', 'previous_response_id', 'reasoning', 'store', 'temperature', 'text', 'tool_choice', 'tools', 'top_p', 'truncation', 'usage', 'user', 'metadata', 'service_tier', 'prompt_cache_key', 'prompt_cache_retention', 'safety_identifier', 'conversation']);

function hasOnlyFields(value, fields) {
  return isObject(value) && Object.keys(value).every(key => fields.has(key));
}

function matchesErrorObject(value, enclosed = false) {
  if (!hasOnlyFields(value, ERROR_FIELDS) || typeof value.message !== 'string') return false;
  if (!enclosed && value.type !== 'error' && !(typeof value.type === 'string' && value.type.endsWith('_error'))) return false;
  return RESOURCE_ERROR.test(value.message);
}

function isKnownResourceError(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return false; }
  }
  if (!isObject(value)) return false;
  if (value.type === 'response.failed') {
    if (!hasOnlyFields(value, new Set(['type', 'sequence_number', 'response']))) return false;
    const response = value.response;
    if (!hasOnlyFields(response, FAILED_RESPONSE_FIELDS)) return false;
    if (response.output != null && (!Array.isArray(response.output) || response.output.length) || response.output_text) return false;
    return matchesErrorObject(response.error, true);
  }
  if (Object.hasOwn(value, 'error')) {
    const envelopeFields = new Set(['error', 'type', 'sequence_number', 'request_id', 'trace_id']);
    if (!hasOnlyFields(value, envelopeFields) || value.type != null && value.type !== 'error') return false;
    return matchesErrorObject(value.error, true);
  }
  return matchesErrorObject(value);
}

function cannotRecover(code, message) {
  return { ok: false, code, message };
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isCompleteToolSchema(tool) {
  if (!isObject(tool) || !isNonemptyString(tool.name)) return false;
  if (tool.type === 'function') return isObject(tool.parameters);
  if (tool.type === 'namespace') return Array.isArray(tool.tools) && tool.tools.every(isCompleteToolSchema);
  if (tool.type !== 'custom' || !isObject(tool.format)) return false;
  if (tool.format.type === 'text') return true;
  return tool.format.type === 'grammar' && ['lark', 'regex'].includes(tool.format.syntax) && isNonemptyString(tool.format.definition);
}

function isInlineImageUrl(value) {
  if (!isNonemptyString(value)) return false;
  if (/^data:image\/[^;,]+(?:;[^,]*)?,.+$/is.test(value)) return true;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch { return false; }
}

function isCompleteMessage(item) {
  if (!MESSAGE_ROLES.has(item.role) || !Array.isArray(item.content) || item.content.length === 0) return false;
  if (Object.hasOwn(item, 'id') && !isNonemptyString(item.id)) return false;
  if (Object.hasOwn(item, 'phase') && !MESSAGE_PHASES.has(item.phase)) return false;
  return item.content.every(part => {
    if (!isObject(part)) return false;
    if (part.type === 'input_text' || part.type === 'output_text') return typeof part.text === 'string';
    if (part.type === 'input_image') return isInlineImageUrl(part.image_url) && !Object.hasOwn(part, 'file_id');
    return false;
  });
}

function projectResponsesHistory(body, { mode = 'minimal' } = {}) {
  if (mode !== 'minimal' && mode !== 'codex') {
    return cannotRecover('unsupported_history_mode', 'History projection mode must be minimal or codex.');
  }
  if (!isObject(body)) return cannotRecover('invalid_body', 'Recovery requires a JSON object.');
  if (body.previous_response_id != null || body.conversation != null) {
    return cannotRecover('server_history_reference', 'Server-side conversation or previous_response_id cannot be reconstructed. Send complete explicit input history without server references.');
  }
  if (!Array.isArray(body.input) || body.input.length === 0) {
    return cannotRecover('explicit_history_required', 'Recovery requires complete explicit Responses input history.');
  }
  const calls = new Map();
  const outputs = new Set();
  const removableTypes = mode === 'codex' ? new Set([...OUTPUT_TYPES, 'message']) : OUTPUT_TYPES;
  let removed = 0;
  for (const item of body.input) {
    if (!isObject(item)) {
      return cannotRecover('invalid_history_item', 'Every explicit Responses input item must be an object; malformed history cannot be safely projected.');
    }
    if (item.type === 'item_reference') {
      return cannotRecover('item_reference', 'An item_reference cannot be expanded locally. Send the full history item.');
    }
    const codexCustomCall = mode === 'codex' && item.type === 'custom_tool_call';
    const codexCustomOutput = mode === 'codex' && item.type === 'custom_tool_call_output';
    const codexAdditionalTools = mode === 'codex' && item.type === 'additional_tools';
    if (mode === 'codex' && item.type === 'message' && !isCompleteMessage(item)) {
      return cannotRecover('invalid_history_item', 'Codex message projection requires a complete role, inline content and known phase.');
    }
    if (codexAdditionalTools && (!isNonemptyString(item.id) || item.role !== 'developer' || !Array.isArray(item.tools) || !item.tools.every(isCompleteToolSchema))) {
      return cannotRecover('invalid_history_item', 'Codex additional_tools requires its full ID, developer role and inline tool schemas.');
    }
    if (Object.hasOwn(item, 'id') && !removableTypes.has(item.type) && !codexCustomCall && !codexCustomOutput && !codexAdditionalTools) {
      return cannotRecover('unsupported_item_id', mode === 'minimal'
        ? 'An item ID outside reasoning/function_call is not verified portable. Recovery will not remove it or replay an uncertain projection.'
        : 'An item ID outside the selected verified history shapes is not portable. Recovery will not remove it or replay an uncertain projection.');
    }
    if (item.type === 'function_call' || codexCustomCall) {
      const inputField = codexCustomCall ? 'input' : 'arguments';
      if (!isNonemptyString(item.call_id) || !isNonemptyString(item.name) || typeof item[inputField] !== 'string' || calls.has(item.call_id) || codexCustomCall && (!isNonemptyString(item.id) || Object.hasOwn(item, 'status') && item.status !== 'completed')) {
        return cannotRecover('invalid_tool_pair', codexCustomCall
          ? 'Custom tool calls must retain a unique call_id, name, input, ID and known status.'
          : 'Function calls must retain unique call_id, name and arguments.');
      }
      calls.set(item.call_id, item);
    }
    if (item.type === 'function_call_output' || codexCustomOutput) {
      const expectedType = codexCustomOutput ? 'custom_tool_call' : 'function_call';
      if (typeof item.call_id !== 'string' || !calls.has(item.call_id) || calls.get(item.call_id).type !== expectedType || outputs.has(item.call_id) || !Object.hasOwn(item, 'output') || codexCustomOutput && !isNonemptyString(item.id)) {
        return cannotRecover('invalid_tool_pair', mode === 'minimal'
          ? 'Each tool output must follow exactly one matching function call with the same call_id.'
          : 'Each tool output must follow exactly one matching call of the same type with the same call_id.');
      }
      outputs.add(item.call_id);
    }
    if (removableTypes.has(item.type) && Object.hasOwn(item, 'id')) removed++;
  }
  if ([...calls.keys()].some(callId => !outputs.has(callId))) {
    return cannotRecover('invalid_tool_pair', mode === 'minimal'
      ? 'A function call is missing its matching tool output.'
      : 'A tool call is missing its matching tool output.');
  }
  if (removed === 0) {
    return cannotRecover('no_supported_item_ids', mode === 'minimal'
      ? 'No supported reasoning/function_call item IDs can be projected; other IDs are deliberately not removed.'
      : 'No supported message/reasoning/function_call item IDs can be projected; retained IDs are deliberately not removed.');
  }
  const projected = structuredClone(body);
  for (const item of projected.input) {
    if (isObject(item) && removableTypes.has(item.type)) delete item.id;
  }
  return { ok: true, body: projected, removed };
}

module.exports = { isKnownResourceError, projectResponsesHistory };
