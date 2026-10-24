'use strict';

const { isKnownResourceError } = require('./history');
const LIFECYCLE = new Set(['response.created', 'response.queued', 'response.in_progress']);
const { TextDecoder } = require('node:util');
const RESPONSE_FIELDS = new Set(['id', 'object', 'created_at', 'status', 'background', 'error', 'incomplete_details', 'instructions', 'max_output_tokens', 'max_tool_calls', 'model', 'output', 'output_text', 'parallel_tool_calls', 'previous_response_id', 'reasoning', 'store', 'temperature', 'text', 'tool_choice', 'tools', 'top_p', 'truncation', 'usage', 'user', 'metadata', 'service_tier', 'prompt_cache_key', 'prompt_cache_retention', 'safety_identifier', 'conversation']);

function findFrameEnd(buffer) {
  let end = null;
  for (const separator of ['\r\n\r\n', '\n\n', '\r\r']) {
    const index = buffer.indexOf(separator);
    if (index !== -1 && (end === null || index < end.start)) end = { start: index, end: index + separator.length };
  }
  return end;
}

function classifyFrame(frame) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(frame); } catch { return 'commit'; }
  const lines = text.split(/\r\n|\r|\n/);
  const data = [];
  let event;
  for (const line of lines) {
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) return 'commit';
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    else if (field === 'event' && event === undefined) event = value;
    else return 'commit';
  }
  if (data.length === 0) return 'commit';
  let payload;
  try { payload = JSON.parse(data.join('\n')); } catch { return 'commit'; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'commit';
  const type = payload.type || event;
  if (!type || (event && payload.type && event !== payload.type)) return 'commit';
  if ((type === 'error' || type === 'response.failed') && isKnownResourceError(payload)) {
    const fields = type === 'error' ? ['type', 'sequence_number', 'code', 'message', 'param', 'error'] : ['type', 'sequence_number', 'response'];
    if (Object.keys(payload).some(key => !fields.includes(key))) return 'commit';
    const failedResponse = payload.response;
    if (failedResponse && (Object.keys(failedResponse).some(key => !RESPONSE_FIELDS.has(key)) || failedResponse.output_text || failedResponse.output != null && (!Array.isArray(failedResponse.output) || failedResponse.output.length))) return 'commit';
    return 'recover';
  }
  if (!LIFECYCLE.has(type)) return 'commit';
  if (Object.keys(payload).some(key => !['type', 'response', 'sequence_number'].includes(key))) return 'commit';
  const response = payload.response;
  if (!response || typeof response !== 'object' || Array.isArray(response)) return 'commit';
  if (response.output != null && (!Array.isArray(response.output) || response.output.length)) return 'commit';
  if (response.output_text || response.error || response.incomplete_details || Object.keys(response).some(key => !RESPONSE_FIELDS.has(key))) return 'commit';
  return 'hold';
}

module.exports = { findFrameEnd, classifyFrame };
