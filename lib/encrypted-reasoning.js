'use strict';

const { isAgentRouterUpstream } = require('./agentrouter');
const {
  ERROR_FIELDS, FAILED_RESPONSE_FIELDS, hasOnlyFields, isObject,
  validateInlineResponsesHistory, hasReadableReasoning
} = require('./history');

const ERROR_ENVELOPE_FIELDS = new Set(['error', 'type', 'sequence_number', 'request_id', 'trace_id']);
const FAILED_EVENT_FIELDS = new Set(['type', 'sequence_number', 'response']);

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

function project(body, mode) {
  const validated = validateInlineResponsesHistory(body, { mode });
  if (!validated.ok) return validated;
  const { removedEncrypted, droppedReasoning, removedIds, usable } = validated;
  if (!removedEncrypted) return refused('no_encrypted_reasoning', 'No verified encrypted reasoning is available to downgrade.');
  if (!usable) return refused('empty_projected_input', 'Removing encrypted-only reasoning would leave no usable explicit input.');
  const projected = structuredClone(body);
  projected.input = projected.input.filter(item => {
    if (item.type !== 'reasoning' || !Object.hasOwn(item, 'encrypted_content')) return true;
    delete item.encrypted_content;
    delete item.id;
    return hasReadableReasoning(item.summary) || hasReadableReasoning(item.content);
  });
  return { ok: true, body: projected, removedEncrypted, droppedReasoning, removedIds, lossy: true };
}

function projectEncryptedReasoning(body, { mode = 'minimal' } = {}) {
  try { return project(body, mode); } catch { return refused('invalid_history_item', 'The explicit history could not be safely validated or copied.'); }
}

module.exports = { isEncryptedReasoningError, projectEncryptedReasoning };
