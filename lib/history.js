'use strict';

const RESOURCE_ERROR = /\bThe requested item was created under a different Azure OpenAI resource\b/i;
const OUTPUT_TYPES = new Set(['reasoning', 'function_call']);

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

function projectResponsesHistory(body) {
  if (!isObject(body)) return cannotRecover('invalid_body', 'Recovery requires a JSON object.');
  if (body.previous_response_id != null || body.conversation != null) {
    return cannotRecover('server_history_reference', 'Server-side conversation or previous_response_id cannot be reconstructed. Send complete explicit input history without server references.');
  }
  if (!Array.isArray(body.input) || body.input.length === 0) {
    return cannotRecover('explicit_history_required', 'Recovery requires complete explicit Responses input history.');
  }
  const calls = new Map();
  const outputs = new Set();
  let removed = 0;
  for (const item of body.input) {
    if (!isObject(item)) {
      return cannotRecover('invalid_history_item', 'Every explicit Responses input item must be an object; malformed history cannot be safely projected.');
    }
    if (item.type === 'item_reference') {
      return cannotRecover('item_reference', 'An item_reference cannot be expanded locally. Send the full history item.');
    }
    if (Object.hasOwn(item, 'id') && !OUTPUT_TYPES.has(item.type)) {
      return cannotRecover('unsupported_item_id', 'An item ID outside reasoning/function_call is not verified portable. Recovery will not remove it or replay an uncertain projection.');
    }
    if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name || typeof item.arguments !== 'string' || calls.has(item.call_id)) {
        return cannotRecover('invalid_tool_pair', 'Function calls must retain unique call_id, name and arguments.');
      }
      calls.set(item.call_id, item);
    }
    if (item.type === 'function_call_output') {
      if (typeof item.call_id !== 'string' || !calls.has(item.call_id) || outputs.has(item.call_id) || !Object.hasOwn(item, 'output')) {
        return cannotRecover('invalid_tool_pair', 'Each tool output must follow exactly one matching function call with the same call_id.');
      }
      outputs.add(item.call_id);
    }
    if (OUTPUT_TYPES.has(item.type) && Object.hasOwn(item, 'id')) removed++;
  }
  if ([...calls.keys()].some(callId => !outputs.has(callId))) {
    return cannotRecover('invalid_tool_pair', 'A function call is missing its matching tool output.');
  }
  if (removed === 0) {
    return cannotRecover('no_supported_item_ids', 'No supported reasoning/function_call item IDs can be projected; other IDs are deliberately not removed.');
  }
  const projected = structuredClone(body);
  for (const item of projected.input) {
    if (isObject(item) && OUTPUT_TYPES.has(item.type)) delete item.id;
  }
  return { ok: true, body: projected, removed };
}

module.exports = { isKnownResourceError, projectResponsesHistory };
