'use strict';

const { isKnownResourceError } = require('./history');
const { isAgentRouterUpstream } = require('./agentrouter');
const { createOutputInspector, inspectResponseJson } = require('./output');

const DEFAULT_RECOVERY_OPTIONS = Object.freeze({
  totalAttempts: 10,
  transientAttempts: 3,
  resourceAttempts: 10,
  deadlineMs: 180000,
  baseDelayMs: 250,
  maxDelayMs: 2000,
  jitterRatio: 0.2
});

const AUTH_CODES = new Set(['authentication_error', 'authentication_failed', 'invalid_api_key', 'missing_api_key', 'invalid_token', 'expired_token', 'token_expired', 'invalid_credentials']);
const PERMISSION_CODES = new Set(['permission_error', 'permission_denied', 'access_denied', 'forbidden', 'insufficient_permissions', 'not_authorized', 'authorizationfailed']);
const FILTER_CODES = new Set(['content_filter', 'content_filter_error', 'content_policy_violation', 'policy_violation', 'responsibleaipolicyviolation', 'content_blocked']);
const SCHEMA_CODES = new Set(['invalid_json', 'invalid_schema', 'schema_validation_error', 'invalid_parameter', 'invalid_parameters', 'invalid_argument', 'missing_required_parameter', 'unknown_parameter', 'unsupported_parameter', 'invalid_type', 'invalid_value', 'invalid_function_parameters', 'invalid_tool_schema', 'context_length_exceeded', 'max_tokens_exceeded', 'request_too_large', 'input_too_long', 'unsupported_model', 'model_not_found', 'invalid_api_version']);
const REQUEST_CODES = new Set(['invalid_request_error', 'bad_request', 'bad_request_error']);
const TRANSIENT_CODES = new Set(['server_error', 'internal_server_error', 'internal_error', 'upstream_error', 'upstream_failure', 'upstream_unavailable', 'upstream_timeout', 'upstream_connect_error', 'upstream_connection_error', 'upstream_transport', 'rate_limit_error', 'rate_limit_exceeded', 'too_many_requests', 'overloaded_error', 'overloaded', 'overload', 'service_unavailable', 'temporarily_unavailable', 'timeout_error', 'request_timeout', 'api_error']);
const CONNECTION_CODES = new Set(['econnrefused', 'econnreset', 'epipe', 'etimedout', 'ehostunreach', 'enetunreach', 'enotfound', 'eai_again', 'und_err_connect_timeout', 'und_err_socket', 'und_err_headers_timeout', 'und_err_body_timeout']);
const CONNECTION_KINDS = new Set(['network', 'network_error', 'transport', 'transport_error', 'connection', 'connection_error', 'disconnect', 'stream_disconnect', 'pre_output_disconnect', 'pre_output_connection_failure', 'upstream_transport']);
const ERROR_METADATA = new Set(['request_id', 'trace_id', 'sequence_number']);

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${name}.`);
  return value;
}

function clock(value) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new TypeError('Invalid nowMs. Inject a finite nonnegative clock value.');
  return value;
}

function normalizeRecoveryOptions(options = {}) {
  if (!record(options)) throw new TypeError('Invalid recovery options.');
  const defaults = DEFAULT_RECOVERY_OPTIONS;
  const policy = {
    totalAttempts: integer(options.totalAttempts, defaults.totalAttempts, 1, 10, 'totalAttempts'),
    transientAttempts: integer(options.transientAttempts, defaults.transientAttempts, 1, 3, 'transientAttempts'),
    resourceAttempts: integer(options.resourceAttempts, defaults.resourceAttempts, 1, 10, 'resourceAttempts'),
    deadlineMs: integer(options.deadlineMs ?? options.timeoutMs, defaults.deadlineMs, 1, 180000, 'deadlineMs'),
    // Legacy zero-delay configuration still yields a scheduled, non-busy retry.
    baseDelayMs: integer(options.baseDelayMs ?? options.retryDelayMs, defaults.baseDelayMs, 0, 2000, 'baseDelayMs'),
    maxDelayMs: integer(options.maxDelayMs, defaults.maxDelayMs, 1, 2000, 'maxDelayMs'),
    jitterRatio: options.jitterRatio === undefined ? defaults.jitterRatio : options.jitterRatio
  };
  policy.baseDelayMs = Math.max(1, policy.baseDelayMs);
  if (policy.baseDelayMs > policy.maxDelayMs || !Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1) throw new TypeError('Invalid recovery backoff.');
  return Object.freeze(policy);
}

// The original request is attempt 1 for every category. Category counters below
// count only additional calls, so transientAttempts=3 allows two replays total.
function createRecoveryState(options = {}, nowMs) {
  const policy = normalizeRecoveryOptions(options);
  const startedAtMs = clock(nowMs);
  const deadlineAtMs = startedAtMs + policy.deadlineMs;
  if (deadlineAtMs > Number.MAX_SAFE_INTEGER) throw new TypeError('Invalid recovery deadline.');
  return Object.freeze({ policy, attempt: 1, transientRetries: 0, resourceRetries: 0, projectionRetries: 0, startedAtMs, deadlineAtMs, lastNowMs: startedAtMs });
}

function normalizeCode(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[.\s-]+/g, '_') : '';
}

function decodePayload(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function responseOf(payload) {
  if (!record(payload)) return null;
  if (typeof payload.type === 'string' && payload.type.startsWith('response.')) return record(payload.response) ? payload.response : null;
  if (payload.object === 'response' || ['completed', 'failed', 'incomplete', 'cancelled'].includes(payload.status)) return payload;
  return null;
}

function errorSources(failure, payload, response) {
  const sources = [];
  const seen = new Set();
  function visit(value, depth = 0) {
    if (value == null || seen.has(value) || depth > 3) return;
    if (typeof value === 'string') { if (value.trim()) sources.push(value); return; }
    if (!record(value)) { sources.push(value); return; }
    seen.add(value);
    sources.push(value);
    for (const key of ['cause', 'innererror', 'inner_error']) visit(value[key], depth + 1);
  }
  visit(failure.error);
  if (record(payload)) {
    visit(payload.error);
    if (response && response !== payload) visit(response.error);
    if (payload.type === 'error' || payload.code !== undefined || payload.message !== undefined) visit(payload);
  } else if (typeof payload === 'string') visit(payload);
  return sources;
}

function meaningful(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (record(value)) return Object.keys(value).length > 0;
  return true;
}

function hasErrorDetails(sources) {
  return sources.some(source => {
    if (!record(source)) return meaningful(source);
    if (meaningful(source.message) || meaningful(source.code) || meaningful(source.param)) return true;
    return Object.entries(source).some(([key, value]) => !ERROR_METADATA.has(key) && !(key === 'type' && value === 'error') && meaningful(value));
  });
}

function httpStatus(value) {
  if (typeof value === 'string' && /^\d{3}$/.test(value)) value = Number(value);
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function statusOf(failure, payload, sources) {
  const candidates = [failure.status, failure.statusCode, record(payload) && payload.status_code, record(payload) && payload.status];
  for (const source of sources) if (record(source)) candidates.push(source.status, source.status_code, source.statusCode);
  for (const candidate of candidates) {
    const status = httpStatus(candidate);
    if (status !== null) return status;
  }
  return null;
}

function unknownBytes(value) {
  return value === true || typeof value === 'number' && value > 0 || typeof value === 'string' && value.length > 0 || Buffer.isBuffer(value) && value.length > 0;
}

function nonemptyText(value) {
  return typeof value === 'string' && value.length > 0;
}

function responseTextStarted(payload, response) {
  if (record(payload) && /^response\.(?:output_text|reasoning_text|reasoning_summary_text)\.(?:delta|done)$/.test(payload.type) && (nonemptyText(payload.delta) || nonemptyText(payload.text))) return true;
  const partStarted = part => record(part) && ['text', 'thinking', 'refusal'].some(key => nonemptyText(part[key]));
  if (record(payload) && partStarted(payload.part)) return true;
  const itemStarted = item => record(item) && (item.type === 'function_call' || ['content', 'summary'].some(key => Array.isArray(item[key]) && item[key].some(partStarted)));
  if (record(payload) && itemStarted(payload.item)) return true;
  return response && (nonemptyText(response.output_text) || Array.isArray(response.output) && response.output.some(itemStarted));
}

function replayBlockReason(failure, payload, response) {
  const observations = [failure.output, failure.outputState, failure.inspection, failure.outputInspector].filter(record);
  if (failure.committed === true || failure.outputCommitted === true || observations.some(value => value.committed === true)) return 'downstream_committed';
  if (failure.outputStarted === true || failure.hasOutput === true || failure.toolStarted === true || observations.some(value => value.hasOutput === true) || responseTextStarted(payload, response)) return 'output_started';
  if (failure.unknownOutput === true || unknownBytes(failure.unknownBytes) || observations.some(value => value.unknown === true)) return 'unknown_output';
  // Inspect complete Responses payloads too: callers need not repeat unwrapping,
  // and a terminal error carrying a tool/reasoning item is never replayed.
  let inspection;
  if (record(payload) && typeof payload.type === 'string' && payload.type.startsWith('response.')) inspection = createOutputInspector('responses').observe(payload);
  else if (response) inspection = inspectResponseJson('responses', response);
  if (inspection?.hasOutput) return 'output_started';
  if (inspection?.unknown) return 'unknown_output';
  return null;
}

// A single observed gateway signature, not generic invalid-request prose, proves
// this scoped history candidate. Typed/event envelopes deliberately do not match.
function isScopedHistoryFailure(payload, status, upstream) {
  const plain = value => record(value) && Object.getPrototypeOf(value) === Object.prototype;
  if (status !== 400 || !plain(payload) || Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'error')) return false;
  const error = payload.error;
  const fields = ['message', 'type', 'param', 'code'];
  if (!plain(error) || Object.keys(error).some(key => !fields.includes(key)) || !fields.every(key => Object.hasOwn(error, key))
    || error.type !== 'invalid_request_error' || typeof error.message !== 'string' || error.param !== '' || error.code !== null) return false;
  const signature = error.message.match(/^Upstream rejected the request as invalid \[trace_id=[A-Za-z0-9._:-]{1,256}\]$/);
  if (!signature || signature[0] !== error.message || !(typeof upstream === 'string' || upstream instanceof URL)) return false;
  return isAgentRouterUpstream(upstream);
}

function classification(kind, reason, candidate = false) {
  return { classification: kind, reason, generic400ProjectionCandidate: candidate };
}

function classifyRecoveryFailure(failure = {}) {
  if (!record(failure)) throw new TypeError('Invalid recovery failure.');
  const payload = decodePayload(failure.payload === undefined ? failure.event : failure.payload);
  const response = responseOf(payload);
  const blocked = replayBlockReason(failure, payload, response);
  if (blocked) return classification('terminal', blocked);
  const sources = errorSources(failure, payload, response);
  const status = statusOf(failure, payload, sources);
  const codes = sources.flatMap(source => record(source) ? [normalizeCode(source.type), normalizeCode(source.code)] : []);
  const messages = sources.flatMap(source => typeof source === 'string' ? [source] : record(source) && typeof source.message === 'string' ? [source.message] : []);
  const hasCode = set => codes.some(code => set.has(code));
  const hasMessage = pattern => messages.some(message => pattern.test(message));
  const kind = normalizeCode(failure.failureKind ?? failure.kind);

  if (failure.aborted === true || failure.cancelled === true || ['aborted', 'cancelled', 'deadline', 'deadline_expired', 'client_closed'].includes(kind) || codes.some(code => ['abort_err', 'aborterror', 'client_closed'].includes(code)) || sources.some(source => record(source) && source.name === 'AbortError')) return classification('terminal', 'cancelled');
  if (status === 401 || hasCode(AUTH_CODES) || codes.some(code => /^unaut.hori[sz]ed$/.test(code)) || hasMessage(/\b(?:authentication (?:failed|error|required)|(?:invalid|incorrect) (?:api[ _-]?key|token|(?:authentication )?credentials?)|api[ _-]?key (?:is )?(?:invalid|missing|not valid)|expired token|unaut.hori[sz]ed)\b/i)) return classification('terminal', 'authentication');
  if (status === 403 || hasCode(PERMISSION_CODES) || hasMessage(/\b(?:permission denied|access (?:is )?denied|insufficient permissions?|forbidden|not permitted|do(?:es)? not have (?:permission|access))\b/i)) return classification('terminal', 'permission');
  if (hasCode(FILTER_CODES) || hasMessage(/\b(?:content[ _-]filter(?:ing|ed)?|content policy|responsible ai|blocked by (?:a |the )?filter)\b/i)) return classification('terminal', 'content_filter');

  if (hasCode(SCHEMA_CODES) || hasMessage(/\b(?:(?:invalid|malformed) (?:request )?(?:json|schema)|schema(?: validation)? (?:failed|error)|(?:missing|unknown|unsupported|invalid) (?:required )?(?:parameter|field|property|argument)|(?:unexpected|unrecognized) field|invalid (?:type|value) (?:for|at)|(?:field|parameter|argument|property) (?:is )?required|must be (?:an? |of type )?(?:array|object|string|integer|number|boolean))\b|\bexpected\b[^\r\n]{0,120}\b(?:array|object|string|integer|number|boolean)\b/i)) return classification('terminal', 'request_schema');
  // Both strict history signatures share the existing resource retry budget.
  // resourceMismatch is an explicit proof supplied by the relay's same detector.
  if (failure.resourceMismatch === true || isKnownResourceError(payload) || isKnownResourceError(failure.error)) return classification('resource', 'azure_resource_mismatch');
  if (isScopedHistoryFailure(payload, status, failure.upstream)) return classification('resource', 'native_history_recovery');
  // Do not reinterpret a generic 400 as a server failure, even if an unreliable
  // gateway labels it server_error. A caller may validate a single full-copy
  // projection separately, using reserveRecoveryAttempt to count that call.
  if (status === 400) return classification('terminal', 'http_400', true);
  if (hasCode(REQUEST_CODES)) return classification('terminal', 'request_error');
  if (status === 408 || status === 429 || status >= 500) return classification('transient', `http_${status}`);
  if (status !== null && status >= 400) return classification('terminal', `http_${status}`);
  if (hasCode(TRANSIENT_CODES) || TRANSIENT_CODES.has(kind) || kind === 'rate_limit' || hasMessage(/\b(?:internal server error|server (?:is )?(?:unavailable|overloaded)|rate[ _-]?limit(?:ed|ing)?|too many requests|overload(?:ed)?|temporarily unavailable)\b|\b(?:upstream|server)\b.{0,120}\b(?:error|fail(?:ed|ure)?|unavailable|timeout|timed out|disconnect(?:ed)?|reset|closed|busy)\b/i)) return classification('transient', 'upstream_error');
  if (hasCode(CONNECTION_CODES) || CONNECTION_KINDS.has(kind) || hasMessage(/\b(?:socket hang up|connection (?:reset|refused|closed|lost|terminated|failed)|network error|fetch failed)\b/i)) return classification('transient', 'pre_output_connection_failure');

  const failed = record(payload) && payload.type === 'response.failed' || response?.status === 'failed';
  const completed = record(payload) && payload.type === 'response.completed' || response?.status === 'completed';
  const explicitlyEmpty = response && Array.isArray(response.output) && response.output.length === 0 && !meaningful(response.output_text);
  if (explicitlyEmpty && !hasErrorDetails(sources)) {
    if (failed) return classification('transient', 'empty_response_failed');
    if (completed && response.incomplete_details == null) return classification('transient', 'empty_response_completed');
  }
  if (failed || sources.length || ['response_failed', 'response_failed_error', 'response_failed_without_details'].includes(kind)) return classification('terminal', 'unclassified_error');
  return classification('none', 'not_a_retryable_failure');
}

function headerValues(headers, wanted) {
  if (!headers) return [];
  if (typeof headers.get === 'function') {
    const value = headers.get(wanted);
    return value == null ? [] : Array.isArray(value) ? value : [value];
  }
  if (!record(headers)) return [];
  return Object.entries(headers).filter(([name]) => name.toLowerCase() === wanted).flatMap(([, value]) => Array.isArray(value) ? value : [value]);
}

function numericDelay(value, multiplier) {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const delay = Number(text) * multiplier;
  // A syntactically valid enormous hint is not an absent hint. Saturation keeps
  // it representable and always causes the bounded deadline to stop the retry.
  return Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(delay));
}

// Returns the longest valid server hint in milliseconds, or null. Server hints
// are never capped at the local backoff ceiling or shortened to the deadline.
function parseRetryAfter(headers, nowMs) {
  const now = clock(nowMs);
  const hints = [];
  for (const value of headerValues(headers, 'retry-after')) {
    let delay = numericDelay(value, 1000);
    if (delay === null && typeof value === 'string') {
      const text = value.trim();
      // Only HTTP-date shapes reach Date.parse: '-1' and 'garbage' stay invalid.
      if (/^(?:[A-Za-z]{3},\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT|[A-Za-z]+,\s+\d{1,2}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+GMT|[A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})$/i.test(text)) {
        const date = Date.parse(text);
        if (Number.isFinite(date)) delay = Math.max(0, Math.ceil(date - now));
      }
    }
    if (delay !== null) hints.push(delay);
  }
  for (const value of headerValues(headers, 'x-ms-retry-after-ms')) {
    const delay = numericDelay(value, 1);
    if (delay !== null) hints.push(delay);
  }
  return hints.length ? Math.max(...hints) : null;
}

function validateState(state) {
  if (!record(state) || !record(state.policy)) throw new TypeError('Invalid recovery state.');
  const { policy } = state;
  const normalized = normalizeRecoveryOptions(policy);
  if (Object.keys(normalized).some(key => normalized[key] !== policy[key])) throw new TypeError('Inconsistent recovery policy.');
  for (const key of ['attempt', 'transientRetries', 'resourceRetries', 'projectionRetries']) if (!Number.isSafeInteger(state[key]) || state[key] < (key === 'attempt' ? 1 : 0)) throw new TypeError('Invalid recovery counters.');
  if (state.attempt !== 1 + state.transientRetries + state.resourceRetries + state.projectionRetries || state.attempt > policy.totalAttempts || state.transientRetries >= policy.transientAttempts || state.resourceRetries >= policy.resourceAttempts || state.projectionRetries > 1) throw new TypeError('Inconsistent recovery counters.');
  clock(state.startedAtMs);
  clock(state.lastNowMs);
  clock(state.deadlineAtMs);
  if (state.deadlineAtMs !== state.startedAtMs + policy.deadlineMs) throw new TypeError('Inconsistent recovery deadline.');
}

function randomUnit(random) {
  const value = typeof random === 'function' ? random() : random === undefined ? 0.5 : random;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new TypeError('Invalid injected random value.');
  return value;
}

// Budget-only entry point for a caller-confirmed single projection candidate.
// This does not classify errors, inspect request history, or change request IDs.
function reserveRecoveryAttempt({ state, classification: kind, nowMs, random, headers } = {}) {
  validateState(state);
  const now = Math.max(clock(nowMs), state.startedAtMs, state.lastNowMs);
  const remainingMs = Math.max(0, state.deadlineAtMs - now);
  const stopped = reason => ({ retry: false, reason, delayMs: 0, remainingMs, nextState: state });
  if (!['transient', 'resource', 'projection'].includes(kind)) return stopped('not_retryable');
  if (!remainingMs) return stopped('deadline_expired');
  if (state.attempt >= state.policy.totalAttempts) return stopped('total_attempt_budget');
  if (kind === 'transient' && state.transientRetries >= state.policy.transientAttempts - 1) return stopped('transient_attempt_budget');
  if (kind === 'resource' && state.resourceRetries >= state.policy.resourceAttempts - 1) return stopped('resource_attempt_budget');
  if (kind === 'projection' && state.projectionRetries >= 1) return stopped('projection_attempt_budget');
  const base = Math.min(state.policy.maxDelayMs, state.policy.baseDelayMs * 2 ** (state.attempt - 1));
  const localDelayMs = Math.min(state.policy.maxDelayMs, Math.max(1, Math.ceil(base + base * state.policy.jitterRatio * randomUnit(random))));
  const retryAfterMs = parseRetryAfter(headers, now);
  const delayMs = Math.max(localDelayMs, retryAfterMs ?? 0);
  if (delayMs >= remainingMs) return { ...stopped('retry_delay_exceeds_deadline'), requiredDelayMs: delayMs, localDelayMs, retryAfterMs };
  const counter = kind === 'transient' ? 'transientRetries' : kind === 'resource' ? 'resourceRetries' : 'projectionRetries';
  const nextState = Object.freeze({ ...state, attempt: state.attempt + 1, [counter]: state[counter] + 1, lastNowMs: now });
  return { retry: true, reason: 'retry_scheduled', delayMs, localDelayMs, retryAfterMs, remainingMs, nextAttemptAtMs: now + delayMs, nextState };
}

function decideRecovery({ state, failure = {}, nowMs, random } = {}) {
  validateState(state);
  const classified = classifyRecoveryFailure(failure);
  const reserved = reserveRecoveryAttempt({ state, classification: classified.classification, nowMs, random, headers: failure.headers });
  return {
    ...classified,
    ...reserved,
    reason: reserved.retry ? classified.reason : reserved.reason === 'not_retryable' ? classified.reason : reserved.reason,
    projectHistory: reserved.retry && classified.classification === 'resource',
    projectionCandidate: classified.generic400ProjectionCandidate ? { kind: 'full_history_copy', automatic: false, maxAttempts: 1 } : null
  };
}

// Resource-only clients retain their wider legacy budget and fixed delay. They
// share classification/output guards, not Harness transient or empty policies.
function decideResourceRecovery({ state, failure = {}, resourceAttempts = 10, retryDelayMs = 1000 } = {}) {
  if (!record(state) || !Number.isSafeInteger(state.attempt) || state.attempt < 1) throw new TypeError('Invalid resource recovery state.');
  const attempts = integer(resourceAttempts, 10, 1, 100, 'resourceAttempts');
  const delayMs = integer(retryDelayMs, 1000, 0, 60000, 'retryDelayMs');
  const classified = classifyRecoveryFailure(failure);
  const stopped = reason => ({ ...classified, retry: false, reason, delayMs: 0, nextState: state, projectHistory: false, generic400ProjectionCandidate: false });
  if (classified.classification !== 'resource') return stopped(classified.reason);
  const status = failure.statusCode;
  if (status !== 400 && !(status >= 200 && status < 300)) return stopped('resource_http_status');
  if (state.attempt >= attempts) return stopped('resource_attempt_budget');
  return { ...classified, retry: true, delayMs, nextState: { ...state, attempt: state.attempt + 1 }, projectHistory: true };
}

module.exports = { DEFAULT_RECOVERY_OPTIONS, normalizeRecoveryOptions, createRecoveryState, isScopedHistoryFailure, classifyRecoveryFailure, parseRetryAfter, reserveRecoveryAttempt, decideRecovery, decideResourceRecovery };
