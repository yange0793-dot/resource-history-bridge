'use strict';

const { isAgentRouterUpstream } = require('./agentrouter');
const {
  ERROR_FIELDS, FAILED_RESPONSE_FIELDS, hasOnlyFields, isObject, isNonemptyString,
  isCompleteToolSchema, isCompleteMessageContent, isCompleteMessage,
  isCompleteEasyMessage, hasOptionalNonemptyId, isCompleteReasoning
} = require('./history');

const ERROR_ENVELOPE_FIELDS = new Set(['error', 'type', 'sequence_number', 'request_id', 'trace_id']);
const FAILED_EVENT_FIELDS = new Set(['type', 'sequence_number', 'response']);
const ITEM_FIELDS = {
  message: new Set(['type', 'id', 'role', 'content', 'status', 'phase']),
  reasoning: new Set(['type', 'id', 'summary', 'content', 'encrypted_content', 'status']),
  function_call: new Set(['type', 'id', 'call_id', 'name', 'arguments', 'status']),
  function_call_output: new Set(['type', 'id', 'call_id', 'output', 'status']),
  custom_tool_call: new Set(['type', 'id', 'call_id', 'name', 'input', 'status']),
  custom_tool_call_output: new Set(['type', 'id', 'call_id', 'output', 'status']),
  additional_tools: new Set(['type', 'id', 'role', 'tools'])
};
const EASY_FIELDS = new Set(['role', 'content']);
const TEXT_FIELDS = new Set(['type', 'text', 'annotations', 'logprobs', 'metadata']);
const IMAGE_FIELDS = new Set(['type', 'image_url', 'detail', 'metadata']);
const REASONING_TEXT_FIELDS = new Set(['type', 'text']);

function exactError(value, enclosed) {
  return hasOnlyFields(value, ERROR_FIELDS)
    && value.code === 'invalid_encrypted_content'
    && typeof value.message === 'string'
    && (enclosed || value.type === 'error' || typeof value.type === 'string' && value.type.endsWith('_error'));
}

function emptyFailedResponse(value) {
  return hasOnlyFields(value, FAILED_RESPONSE_FIELDS)
    && (value.status === undefined || value.status === 'failed')
    && (value.object === undefined || value.object === 'response')
    && (value.output == null || Array.isArray(value.output) && value.output.length === 0)
    && (value.output_text === undefined || value.output_text === '')
    && value.incomplete_details == null
    && exactError(value.error, true);
}

function isEncryptedReasoningError(payload, statusCode, upstream) {
  if (!isAgentRouterUpstream(upstream) || statusCode !== 400 && !(statusCode >= 200 && statusCode < 300)) return false;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return false; }
  }
  if (!isObject(payload)) return false;
  if (payload.type === 'response.failed') {
    return hasOnlyFields(payload, FAILED_EVENT_FIELDS) && emptyFailedResponse(payload.response);
  }
  if (payload.status === 'failed' && (payload.object === undefined || payload.object === 'response')) return emptyFailedResponse(payload);
  if (Object.hasOwn(payload, 'error')) {
    return hasOnlyFields(payload, ERROR_ENVELOPE_FIELDS)
      && (payload.type === undefined || payload.type === 'error')
      && exactError(payload.error, true);
  }
  return exactError(payload, false);
}

function refused(code, message) { return { ok: false, code, message }; }
function completed(item) { return !Object.hasOwn(item, 'status') || item.status === 'completed'; }
function readable(parts) { return Array.isArray(parts) && parts.some(part => typeof part.text === 'string' && part.text.trim().length > 0); }
function completeContent(content) {
  return isCompleteMessageContent(content) && content.every(part => hasOnlyFields(part, part.type === 'input_image' ? IMAGE_FIELDS : TEXT_FIELDS)
    && (!Object.hasOwn(part, 'detail') || ['auto', 'low', 'high', 'original'].includes(part.detail))
    && (!Object.hasOwn(part, 'annotations') || Array.isArray(part.annotations))
    && (!Object.hasOwn(part, 'logprobs') || part.logprobs === null || Array.isArray(part.logprobs)));
}
function completeReasoning(item) {
  return isCompleteReasoning(item) && item.summary.every(part => hasOnlyFields(part, REASONING_TEXT_FIELDS))
    && (item.content == null || item.content.every(part => hasOnlyFields(part, REASONING_TEXT_FIELDS)));
}
function usableMessage(item) {
  return typeof item.content === 'string' ? item.content.trim().length > 0
    : item.content.some(part => part.type === 'input_image' || typeof part.text === 'string' && part.text.trim().length > 0);
}

function project(body, mode) {
  if (!['minimal', 'codex', 'harness'].includes(mode)) return refused('unsupported_history_mode', 'History projection mode must be minimal, codex or harness.');
  if (!isObject(body)) return refused('invalid_body', 'Recovery requires a JSON object.');
  if (body.previous_response_id != null || body.conversation != null) return refused('server_history_reference', 'Encrypted reasoning recovery requires full explicit history without server references.');
  if (!Array.isArray(body.input) || body.input.length === 0) return refused('explicit_history_required', 'Recovery requires complete explicit Responses input history.');
  const extended = mode !== 'minimal';
  const harness = mode === 'harness';
  const calls = new Map(), outputs = new Set();
  let removedEncrypted = 0, droppedReasoning = 0, removedIds = 0, usable = false;
  for (const item of body.input) {
    if (!isObject(item)) return refused('invalid_history_item', 'Every explicit history item must be a complete object.');
    if (item.type === 'item_reference') return refused('item_reference', 'An item_reference cannot be expanded locally.');
    if (['compaction', 'context_compaction'].includes(item.type)) return refused('unsupported_encrypted_history', 'Compacted history cannot be reconstructed by dropping ciphertext.');
    const easy = !Object.hasOwn(item, 'type');
    if (easy) {
      const valid = hasOnlyFields(item, EASY_FIELDS) && (harness ? isCompleteEasyMessage(item)
        : ['user', 'developer', 'system'].includes(item.role) && (typeof item.content === 'string' || completeContent(item.content)));
      if (!valid || Array.isArray(item.content) && !completeContent(item.content)) return refused('invalid_history_item', 'Easy messages require a verified role and complete inline content.');
      usable ||= usableMessage(item);
      continue;
    }
    if (!ITEM_FIELDS[item.type] || !hasOnlyFields(item, ITEM_FIELDS[item.type]) || !hasOptionalNonemptyId(item) || !completed(item)) {
      return refused('invalid_history_item', 'Unknown, incomplete or unsupported history shapes cannot be safely downgraded.');
    }
    if (item.type === 'message') {
      const inlineString = mode === 'minimal' && ['user', 'developer', 'system'].includes(item.role) && typeof item.content === 'string' && !Object.hasOwn(item, 'phase');
      if (!inlineString && (!isCompleteMessage(item) || !completeContent(item.content))) return refused('invalid_history_item', 'Message history requires complete inline content and a known role and phase.');
      usable ||= usableMessage(item);
    } else if (item.type === 'reasoning') {
      if (!completeReasoning(item)) return refused('invalid_history_item', 'Reasoning requires a valid summary and complete optional content, even without an item ID.');
      const hasText = readable(item.summary) || readable(item.content);
      if (Object.hasOwn(item, 'encrypted_content')) {
        removedEncrypted++;
        if (Object.hasOwn(item, 'id')) removedIds++;
        if (!hasText) droppedReasoning++;
      }
      usable ||= hasText;
    } else if (item.type === 'additional_tools') {
      if (!extended || item.role !== 'developer' || !Array.isArray(item.tools) || !item.tools.every(isCompleteToolSchema) || !harness && !isNonemptyString(item.id)) {
        return refused('invalid_history_item', 'Additional tools require verified inline schemas and the selected history contract.');
      }
    } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const custom = item.type === 'custom_tool_call';
      if (custom && (!extended || !harness && !isNonemptyString(item.id))
        || !isNonemptyString(item.call_id) || !isNonemptyString(item.name) || typeof item[custom ? 'input' : 'arguments'] !== 'string' || calls.has(item.call_id)) {
        return refused('invalid_tool_pair', 'Tool calls require a unique call_id, name and complete original input.');
      }
      calls.set(item.call_id, item.type);
      usable = true;
    } else {
      const custom = item.type === 'custom_tool_call_output';
      if (custom && (!extended || !harness && !isNonemptyString(item.id))
        || !isNonemptyString(item.call_id) || calls.get(item.call_id) !== (custom ? 'custom_tool_call' : 'function_call') || outputs.has(item.call_id)
        || !Object.hasOwn(item, 'output') || !custom && !(typeof item.output === 'string' || completeContent(item.output))) {
        return refused('invalid_tool_pair', 'Every tool result must follow exactly one matching complete call.');
      }
      outputs.add(item.call_id);
    }
  }
  if ([...calls.keys()].some(id => !outputs.has(id))) return refused('invalid_tool_pair', 'A tool call is missing its matching output.');
  if (!removedEncrypted) return refused('no_encrypted_reasoning', 'No verified encrypted reasoning is available to downgrade.');
  if (!usable) return refused('empty_projected_input', 'Removing encrypted-only reasoning would leave no usable explicit input.');
  const projected = structuredClone(body);
  projected.input = projected.input.filter(item => {
    if (item.type !== 'reasoning' || !Object.hasOwn(item, 'encrypted_content')) return true;
    delete item.encrypted_content;
    delete item.id;
    return readable(item.summary) || readable(item.content);
  });
  return { ok: true, body: projected, removedEncrypted, droppedReasoning, removedIds, lossy: true };
}

function projectEncryptedReasoning(body, { mode = 'minimal' } = {}) {
  try { return project(body, mode); } catch { return refused('invalid_history_item', 'The explicit history could not be safely validated or copied.'); }
}

module.exports = { isEncryptedReasoningError, projectEncryptedReasoning };
