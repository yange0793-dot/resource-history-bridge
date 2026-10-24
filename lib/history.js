'use strict';

const RESOURCE_ERROR = /\bThe requested item was created under a different Azure OpenAI resource\b/i;
const OUTPUT_TYPES = new Set(['reasoning', 'function_call']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isKnownResourceError(value, depth = 0) {
  if (depth > 6) return false;
  if (typeof value === 'string') {
    if (RESOURCE_ERROR.test(value)) return true;
    try { return isKnownResourceError(JSON.parse(value), depth + 1); } catch { return false; }
  }
  if (!isObject(value)) return false;
  if (typeof value.message === 'string' && RESOURCE_ERROR.test(value.message)) return true;
  return ['error', 'response'].some(key => isKnownResourceError(value[key], depth + 1));
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
    if (!isObject(item)) continue;
    if (item.type === 'item_reference') {
      return cannotRecover('item_reference', 'An item_reference cannot be expanded locally. Send the full history item.');
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
