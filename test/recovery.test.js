'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_RECOVERY_OPTIONS,
  normalizeRecoveryOptions,
  createRecoveryState,
  classifyRecoveryFailure,
  parseRetryAfter,
  reserveRecoveryAttempt,
  decideRecovery
} = require('../lib/recovery');
const { createOutputInspector } = require('../lib/output');

const RESOURCE_MESSAGE = 'The requested item was created under a different Azure OpenAI resource.';
const resourceError = () => ({ error: { type: 'invalid_request_error', code: 'invalid_resource', message: RESOURCE_MESSAGE } });
const failed = (error = null, output = [], extra = {}) => ({ type: 'response.failed', response: { object: 'response', status: 'failed', output, error, ...extra } });
const completed = (output = [], extra = {}) => ({ type: 'response.completed', response: { object: 'response', status: 'completed', output, error: null, ...extra } });
const decide = (failure, state = createRecoveryState({}, 1000), nowMs = 1000, random = 0) => decideRecovery({ state, failure, nowMs, random });

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const classificationCases = [
  ['strict Azure HTTP error', { status: 400, payload: resourceError() }, 'resource', 'azure_resource_mismatch'],
  ['strict Azure SSE failed event', { status: 200, payload: failed(resourceError().error) }, 'resource', 'azure_resource_mismatch'],
  ['JSON string Azure envelope', { status: 400, payload: JSON.stringify(resourceError()) }, 'resource', 'azure_resource_mismatch'],
  ['relay-proven Azure mismatch', { resourceMismatch: true }, 'resource', 'azure_resource_mismatch'],
  ['different-resource paraphrase stays generic 400', { status: 400, payload: { error: { message: 'Item belongs to another resource.' } } }, 'terminal', 'http_400'],
  ['raw Azure phrase is not a structured resource error', { status: 400, error: RESOURCE_MESSAGE }, 'terminal', 'http_400'],
  ['HTTP 408', { status: 408 }, 'transient', 'http_408'],
  ['HTTP 429', { statusCode: 429 }, 'transient', 'http_429'],
  ['HTTP 500', { status: 500 }, 'transient', 'http_500'],
  ['HTTP 502 with generic HTML error body', { status: 502, payload: '<html>bad gateway</html>' }, 'transient', 'http_502'],
  ['HTTP 503 from nested error status', { payload: { error: { status_code: 503, message: 'Retry later.' } } }, 'transient', 'http_503'],
  ['HTTP 599', { status: 599 }, 'transient', 'http_599'],
  ['upstream SSE error', { status: 200, payload: { type: 'error', error: { type: 'upstream_error', message: 'Backend temporarily failed.' } } }, 'transient', 'upstream_error'],
  ['server error without HTTP failure status', { error: { code: 'server_error' } }, 'transient', 'upstream_error'],
  ['explicit server error message', { error: { message: 'The server had an error while processing your request.' } }, 'transient', 'upstream_error'],
  ['explicit server failure kind', { failureKind: 'server_error' }, 'transient', 'upstream_error'],
  ['incorrect API key message wins over 400 projection candidate', { status: 400, error: { message: 'Incorrect API key provided.' } }, 'terminal', 'authentication'],
  ['explicit model access denial', { status: 400, error: { message: 'You do not have access to this model.' } }, 'terminal', 'permission'],
  ['schema expected-type message', { status: 503, error: { message: 'Expected input to be an array.' } }, 'terminal', 'request_schema'],
  ['content filtering message', { status: 500, error: { message: 'Content filtering blocked the request.' } }, 'terminal', 'content_filter'],
  ['overload error', { payload: failed({ code: 'overloaded_error', message: 'Capacity unavailable.' }) }, 'transient', 'upstream_error'],
  ['explicit rate-limit message', { error: { message: 'Rate limit reached. Try again later.' } }, 'transient', 'upstream_error'],
  ['explicit upstream timeout message', { error: { message: 'The upstream connection timed out.' } }, 'transient', 'upstream_error'],
  ['network errno', { error: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }, 'transient', 'pre_output_connection_failure'],
  ['nested fetch errno', { error: new Error('fetch failed', { cause: Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }) }) }, 'transient', 'pre_output_connection_failure'],
  ['explicit pre-output disconnect kind', { failureKind: 'pre_output_disconnect' }, 'transient', 'pre_output_connection_failure'],
  ['legacy transport kind', { kind: 'transport' }, 'transient', 'pre_output_connection_failure'],
  ['failed with null error and explicit empty output', { payload: failed() }, 'transient', 'empty_response_failed'],
  ['failed with empty error object', { payload: failed({}) }, 'transient', 'empty_response_failed'],
  ['failed with blank error fields', { payload: failed({ message: '', code: null, param: null }) }, 'transient', 'empty_response_failed'],
  ['failed JSON body with empty output', { payload: { object: 'response', status: 'failed', error: null, output: [] } }, 'transient', 'empty_response_failed'],
  ['completed with verified empty output', { payload: completed() }, 'transient', 'empty_response_completed'],
  ['completed JSON body with verified empty output', { payload: { object: 'response', status: 'completed', output: [] } }, 'transient', 'empty_response_completed'],
  ['failed missing output is not explicitly empty', { payload: { type: 'response.failed', response: { status: 'failed', error: null } } }, 'terminal', 'unclassified_error'],
  ['unknown nonempty failed error details', { payload: failed({ code: 'mystery_failure', message: 'Something happened.' }) }, 'terminal', 'unclassified_error'],
  ['incomplete response is not completed empty recovery', { payload: { object: 'response', status: 'incomplete', output: [] } }, 'none', 'not_a_retryable_failure'],
  ['generic 400', { status: 400 }, 'terminal', 'http_400'],
  ['generic invalid_request_error 400', { status: 400, payload: { error: { type: 'invalid_request_error', message: 'Bad request.' } } }, 'terminal', 'http_400'],
  ['gateway server_error label does not reinterpret 400', { status: 400, error: { type: 'server_error' } }, 'terminal', 'http_400'],
  ['HTTP 404', { status: 404 }, 'terminal', 'http_404'],
  ['HTTP 422', { status: 422 }, 'terminal', 'http_422'],
  ['HTTP 401 wins over HTTP transient evidence', { status: 401, error: { type: 'server_error' } }, 'terminal', 'authentication'],
  ['HTTP 403', { status: 403 }, 'terminal', 'permission'],
  ['authentication code wins over 429', { status: 429, error: { code: 'invalid_api_key' } }, 'terminal', 'authentication'],
  ['permission code wins over 500', { status: 500, error: { type: 'permission_error' } }, 'terminal', 'permission'],
  ['explicit schema wins over 503', { status: 503, error: { code: 'schema_validation_error', message: 'Bad input.' } }, 'terminal', 'request_schema'],
  ['explicit schema message', { status: 400, error: { message: 'Invalid request schema.' } }, 'terminal', 'request_schema'],
  ['explicit parameter message wins over overload', { status: 503, error: { message: 'Missing required parameter input.' } }, 'terminal', 'request_schema'],
  ['request error without 400 is still terminal', { status: 500, error: { type: 'invalid_request_error' } }, 'terminal', 'request_error'],
  ['content filter code wins over 429', { status: 429, error: { code: 'content_filter' } }, 'terminal', 'content_filter'],
  ['nested Azure content filter wins over 500', { status: 500, payload: { error: { message: 'Prompt blocked.', innererror: { code: 'ResponsibleAIPolicyViolation' } } } }, 'terminal', 'content_filter'],
  ['aborted caller', { status: 503, aborted: true }, 'terminal', 'cancelled'],
  ['AbortError', { error: Object.assign(new Error('request stopped'), { name: 'AbortError' }) }, 'terminal', 'cancelled'],
  ['shared deadline kind', { failureKind: 'deadline_expired' }, 'terminal', 'cancelled'],
  ['ordinary response metadata is not a failure', { payload: { type: 'response.created', response: { object: 'response', status: 'in_progress', output: [] } } }, 'none', 'not_a_retryable_failure']
];

for (const [name, failure, expected, reason] of classificationCases) {
  test(`classify: ${name}`, () => {
    const result = classifyRecoveryFailure(failure);
    assert.equal(result.classification, expected);
    assert.equal(result.reason, reason);
    const decision = decide(failure);
    assert.equal(decision.retry, expected === 'resource' || expected === 'transient');
    assert.equal(decision.projectHistory, expected === 'resource');
  });
}

test('metadata-only events remain held and preserve a subsequent empty-failed retry', () => {
  const inspector = createOutputInspector('responses');
  const metadata = [
    { type: 'response.created', response: { object: 'response', status: 'in_progress', output: [], metadata: { trace: 'test' } } },
    { type: 'response.in_progress', response: { object: 'response', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1', status: 'in_progress', role: 'assistant', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: 'm1', part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'reasoning', id: 'r1', summary: [] } }
  ];
  for (const event of metadata) {
    const observation = inspector.observe(event);
    assert.equal(observation.hold, true);
    assert.equal(observation.hasOutput, false);
    assert.equal(observation.unknown, false);
  }
  const event = failed();
  const output = inspector.observe(event);
  assert.equal(output.empty, false, 'empty means normal terminal completion, not failed output=[]');
  assert.equal(output.error, true);
  assert.equal(decide({ payload: event, output }).retry, true);
});

const outputCases = [
  ['body text', { type: 'response.output_text.delta', delta: 'Hello' }],
  ['reasoning text', { type: 'response.reasoning_text.delta', delta: 'Thinking' }],
  ['reasoning summary', { type: 'response.reasoning_summary_text.delta', delta: 'Plan' }],
  ['named function-call start', { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'f1', call_id: 'c1', name: 'bash', arguments: '' } }],
  ['minimal empty function-call start', { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', arguments: '' } }],
  ['function arguments', { type: 'response.function_call_arguments.delta', delta: '{"command":' }],
  ['unknown nonempty event', { type: 'future.execution_started', data: { value: 'unknown' } }],
  ['unknown response event', { type: 'response.future_delta', delta: 'unknown' }]
];

for (const [name, event] of outputCases) {
  test(`replay guard: ${name} blocks every recovery category`, () => {
    const inspector = createOutputInspector('responses');
    inspector.observe(event);
    const output = inspector.result();
    assert.equal(output.hasOutput || output.unknown, true);
    for (const failure of [{ status: 429 }, { status: 400, payload: resourceError() }, { payload: failed() }, { payload: completed() }, { error: { code: 'ECONNRESET' } }]) {
      const result = decide({ ...failure, output });
      assert.equal(result.retry, false);
      assert.equal(result.projectHistory, false);
      assert.equal(result.generic400ProjectionCandidate, false);
    }
  });
}

test('complete failed payload with text, reasoning or tools is blocked without caller flags', () => {
  const outputs = [
    [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'already generated' }] }],
    [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'already reasoned' }] }],
    [{ type: 'function_call', name: 'bash', call_id: 'c1', arguments: '' }],
    [{ type: 'future_output', payload: 'opaque' }]
  ];
  for (const output of outputs) {
    const result = decide({ payload: failed(resourceError().error, output) });
    assert.equal(result.retry, false);
    assert.equal(result.projectHistory, false);
  }
  assert.equal(decide({ payload: failed(null, [], { output_text: 'already emitted' }) }).retry, false);
});

test('nonempty whitespace text is output, while empty metadata shells remain non-output', () => {
  for (const payload of [
    { type: 'response.output_text.delta', delta: ' ' },
    { type: 'response.reasoning_text.delta', delta: '\n' },
    failed(null, [], { output_text: ' ' }),
    failed(null, [{ type: 'reasoning', summary: [{ type: 'summary_text', text: ' ' }] }])
  ]) assert.equal(decide({ status: 503, payload }).reason, 'output_started');
  assert.equal(decide({ payload: completed([], { output_text: '' }) }).retry, true);
});

test('unknown response metadata/opaque content conservatively blocks replay', () => {
  for (const payload of [failed(null, [], { future_output: 'opaque' }), failed(null, [{ type: 'reasoning', summary: [], encrypted_content: 'opaque' }])]) {
    const result = decide({ payload });
    assert.equal(result.retry, false);
    assert.equal(result.reason, 'unknown_output');
  }
});

test('explicit output, unknown bytes and downstream commit guards win over resource proof', () => {
  for (const flags of [
    { outputStarted: true }, { hasOutput: true }, { toolStarted: true },
    { output: { hasOutput: true } }, { outputState: { unknown: true } },
    { outputInspector: { unknown: true } }, { inspection: { committed: true } },
    { committed: true }, { outputCommitted: true }, { unknownOutput: true },
    { unknownBytes: true }, { unknownBytes: 1 }, { unknownBytes: Buffer.from('x') }
  ]) {
    const result = decide({ resourceMismatch: true, ...flags });
    assert.equal(result.retry, false);
    assert.equal(result.projectHistory, false);
  }
  assert.equal(decide({ error: { code: 'ECONNRESET' }, unknownBytes: 0 }).retry, true);
});

test('generic 400 only advertises a caller-confirmed full-copy candidate', () => {
  const result = decide({ status: 400, payload: { error: { type: 'invalid_request_error', message: 'Bad request.' } } });
  assert.equal(result.retry, false);
  assert.equal(result.classification, 'terminal');
  assert.equal(result.projectHistory, false);
  assert.equal(result.generic400ProjectionCandidate, true);
  assert.deepEqual(result.projectionCandidate, { kind: 'full_history_copy', automatic: false, maxAttempts: 1 });
  assert.equal(result.nextState.attempt, 1);
  for (const error of [{ code: 'invalid_json' }, { code: 'invalid_api_key' }, { code: 'permission_denied' }, { code: 'content_filter' }]) assert.equal(decide({ status: 400, error }).projectionCandidate, null);
});

test('default policy caps total/resource/transient calls and total deadline', () => {
  assert.deepEqual(normalizeRecoveryOptions(), DEFAULT_RECOVERY_OPTIONS);
  const state = createRecoveryState({}, 1234);
  assert.equal(state.attempt, 1);
  assert.equal(state.transientRetries, 0);
  assert.equal(state.resourceRetries, 0);
  assert.equal(state.deadlineAtMs, 181234);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.policy), true);
});

test('transient budget permits exactly three calls including the original', () => {
  let state = createRecoveryState({}, 0);
  let nowMs = 0;
  const attempts = [state.attempt];
  for (let index = 0; index < 2; index++) {
    const result = decide({ status: 503 }, state, nowMs);
    assert.equal(result.retry, true);
    nowMs += result.delayMs;
    state = result.nextState;
    attempts.push(state.attempt);
  }
  const exhausted = decide({ status: 503 }, state, nowMs);
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal(exhausted.retry, false);
  assert.equal(exhausted.reason, 'transient_attempt_budget');
  assert.equal(exhausted.nextState, state);
});

test('resource budget permits exactly ten calls with low-latency capped backoff', () => {
  let state = createRecoveryState({}, 0);
  let nowMs = 0;
  const delays = [];
  for (let index = 0; index < 9; index++) {
    const result = decide({ status: 400, payload: resourceError() }, state, nowMs);
    assert.equal(result.retry, true);
    assert.equal(result.projectHistory, true);
    delays.push(result.delayMs);
    nowMs += result.delayMs;
    state = result.nextState;
  }
  assert.deepEqual(delays, [250, 500, 1000, 2000, 2000, 2000, 2000, 2000, 2000]);
  assert.equal(state.attempt, 10);
  assert.equal(state.resourceRetries, 9);
  const exhausted = decide({ status: 400, payload: resourceError() }, state, nowMs);
  assert.equal(exhausted.retry, false);
  assert.equal(exhausted.reason, 'total_attempt_budget');
});

test('mixed categories share the original global attempt budget', () => {
  let state = createRecoveryState({}, 0);
  let nowMs = 0;
  const sequence = ['transient', 'resource', 'resource', 'transient', 'resource', 'resource', 'resource', 'resource', 'resource'];
  for (const classification of sequence) {
    const result = reserveRecoveryAttempt({ state, classification, nowMs, random: 0 });
    assert.equal(result.retry, true);
    nowMs += result.delayMs;
    state = result.nextState;
  }
  assert.equal(state.attempt, 10);
  assert.equal(state.transientRetries, 2);
  assert.equal(state.resourceRetries, 7);
  assert.equal(reserveRecoveryAttempt({ state, classification: 'resource', nowMs, random: 0 }).reason, 'total_attempt_budget');
});

test('caller-confirmed generic 400 projection is limited to one call and shares total budget', () => {
  let state = createRecoveryState({ totalAttempts: 3 }, 0);
  const candidate = decide({ status: 400 }, state, 0);
  assert.equal(candidate.retry, false);
  assert.equal(candidate.generic400ProjectionCandidate, true);
  const manual = reserveRecoveryAttempt({ state, classification: 'projection', nowMs: 0, random: 0 });
  assert.equal(manual.retry, true);
  assert.equal(manual.nextState.attempt, 2);
  assert.equal(manual.nextState.projectionRetries, 1);
  assert.equal(manual.nextState.transientRetries, 0);
  assert.equal(manual.nextState.resourceRetries, 0);
  state = manual.nextState;
  assert.equal(reserveRecoveryAttempt({ state, classification: 'projection', nowMs: 250 }).reason, 'projection_attempt_budget');
  const other = decide({ status: 503 }, state, 250);
  assert.equal(other.retry, true);
  state = other.nextState;
  assert.equal(state.attempt, 3);
  assert.equal(decide({ status: 503 }, state, 1000).reason, 'total_attempt_budget');
});

test('lower category budgets still count the original call', () => {
  assert.equal(decide({ status: 429 }, createRecoveryState({ transientAttempts: 1 }, 0), 0).reason, 'transient_attempt_budget');
  assert.equal(decide({ resourceMismatch: true }, createRecoveryState({ resourceAttempts: 1 }, 0), 0).reason, 'resource_attempt_budget');
  assert.equal(decide({ status: 503 }, createRecoveryState({ totalAttempts: 1 }, 0), 0).reason, 'total_attempt_budget');
});

test('Retry-After parses seconds, fractional seconds, millisecond hints, dates and longest hint', () => {
  const now = Date.parse('Sun, 25 Oct 2026 03:00:00 GMT');
  assert.equal(parseRetryAfter({ 'retry-after': '3' }, now), 3000);
  assert.equal(parseRetryAfter({ 'Retry-After': ' 0.25 ' }, now), 250);
  assert.equal(parseRetryAfter({ 'RETRY-AFTER': 2 }, now), 2000);
  assert.equal(parseRetryAfter({ 'x-ms-retry-after-ms': '1500' }, now), 1500);
  assert.equal(parseRetryAfter({ 'X-MS-RETRY-AFTER-MS': '250.2' }, now), 251);
  assert.equal(parseRetryAfter({ 'retry-after': 'Sun, 25 Oct 2026 03:00:04 GMT' }, now), 4000);
  assert.equal(parseRetryAfter({ 'retry-after': 'Sun, 25 Oct 2026 02:59:00 GMT' }, now), 0);
  assert.equal(parseRetryAfter({ 'retry-after': '2', 'x-ms-retry-after-ms': '3500' }, now), 3500);
  assert.equal(parseRetryAfter({ 'retry-after': ['1', 'Sun, 25 Oct 2026 03:00:04 GMT'], 'x-ms-retry-after-ms': ['1000', '5000'] }, now), 5000);
  assert.equal(parseRetryAfter(new Headers({ 'Retry-After': '2' }), now), 2000);
});

test('Retry-After rejects invalid, negative, infinite and non-HTTP-date values', () => {
  for (const value of ['', '-1', 'Infinity', 'NaN', 'garbage', '2026-10-25', '1e3', null, {}]) assert.equal(parseRetryAfter({ 'retry-after': value }, 0), null);
  for (const value of ['-1', 'Infinity', '', null]) assert.equal(parseRetryAfter({ 'x-ms-retry-after-ms': value }, 0), null);
  assert.equal(parseRetryAfter(null, 0), null);
  assert.equal(parseRetryAfter({}, 0), null);
});

test('valid enormous Retry-After hints stop at the deadline rather than being ignored', () => {
  const huge = '9'.repeat(400);
  for (const name of ['retry-after', 'x-ms-retry-after-ms']) {
    assert.equal(parseRetryAfter({ [name]: huge }, 0), Number.MAX_SAFE_INTEGER);
    const result = decide({ status: 429, headers: { [name]: huge } }, createRecoveryState({}, 0), 0);
    assert.equal(result.retry, false);
    assert.equal(result.reason, 'retry_delay_exceeds_deadline');
    assert.equal(result.requiredDelayMs, Number.MAX_SAFE_INTEGER);
  }
});

test('429 obeys server delay even above local two-second cap', () => {
  const result = decide({ status: 429, headers: { 'Retry-After': '10', 'x-ms-retry-after-ms': '12000' } });
  assert.equal(result.retry, true);
  assert.equal(result.localDelayMs, 250);
  assert.equal(result.retryAfterMs, 12000);
  assert.equal(result.delayMs, 12000);
  assert.equal(result.nextAttemptAtMs, 13000);
});

test('total deadline includes previous calls and blocks waits equal to remaining time', () => {
  const state = createRecoveryState({}, 1000);
  const expired = decide({ status: 503 }, state, 181000);
  assert.equal(expired.retry, false);
  assert.equal(expired.reason, 'deadline_expired');
  assert.equal(expired.remainingMs, 0);
  const tooLate = decide({ status: 503 }, state, 180750);
  assert.equal(tooLate.retry, false);
  assert.equal(tooLate.reason, 'retry_delay_exceeds_deadline');
  assert.equal(tooLate.requiredDelayMs, 250);
  assert.equal(tooLate.nextState, state);
  const possible = decide({ status: 503 }, state, 180749);
  assert.equal(possible.retry, true);
  assert.equal(possible.remainingMs, 251);
});

test('long Retry-After never gets shortened to fit the total deadline', () => {
  const state = createRecoveryState({}, 0);
  for (const headers of [{ 'Retry-After': '180' }, { 'x-ms-retry-after-ms': '200000' }]) {
    const result = decide({ status: 429, headers }, state, 0);
    assert.equal(result.retry, false);
    assert.equal(result.reason, 'retry_delay_exceeds_deadline');
    assert.equal(result.requiredDelayMs >= 180000, true);
    assert.equal(result.nextState, state);
  }
  const now = Date.parse('Sun, 25 Oct 2026 03:00:00 GMT');
  const result = decide({ status: 429, headers: { 'Retry-After': 'Sun, 25 Oct 2026 03:03:01 GMT' } }, createRecoveryState({}, now), now);
  assert.equal(result.requiredDelayMs, 181000);
  assert.equal(result.retry, false);
});

test('jitter is injected, reproducible and bounded by the local ceiling', () => {
  const state = createRecoveryState({}, 0);
  assert.equal(decide({ status: 503 }, state, 0, 0).delayMs, 250);
  assert.equal(decide({ status: 503 }, state, 0, 1).delayMs, 300);
  assert.equal(decideRecovery({ state, failure: { status: 503 }, nowMs: 0 }).delayMs, 275);
  assert.equal(decide({ status: 503 }, state, 0, () => 0.5).delayMs, 275);
  const capped = createRecoveryState({ baseDelayMs: 2000 }, 0);
  assert.equal(decide({ resourceMismatch: true }, capped, 0, 1).delayMs, 2000);
});

test('legacy zero-delay configuration still schedules a positive wait', () => {
  const state = createRecoveryState({ retryDelayMs: 0 }, 0);
  assert.equal(state.policy.baseDelayMs, 1);
  assert.equal(decide({ status: 503 }, state, 0).delayMs, 1);
});

test('clock regression does not move the original deadline or undo observed time', () => {
  const state = createRecoveryState({}, 1000);
  const first = decide({ resourceMismatch: true }, state, 2000);
  const regressed = decide({ resourceMismatch: true }, first.nextState, 1500);
  assert.equal(regressed.nextState.deadlineAtMs, state.deadlineAtMs);
  assert.equal(regressed.remainingMs, 179000);
  assert.equal(regressed.nextAttemptAtMs, 2500);
});

test('classification and budget planning do not mutate payload, cache or session identity', () => {
  const payload = deepFreeze(failed());
  const identity = deepFreeze({ prompt_cache_key: 'stable-cache', session_id: 'stable-session' });
  const failure = deepFreeze({ status: 200, payload, headers: { 'Retry-After': '1' }, ...identity });
  const state = createRecoveryState({}, 0);
  const snapshot = JSON.stringify({ failure, state });
  const first = decide(failure, state, 0, 0.5);
  const second = decide(failure, state, 0, 0.5);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify({ failure, state }), snapshot);
  assert.equal(first.nextState.attempt, 2);
  assert.equal(state.attempt, 1);
  assert.equal('payload' in first.nextState, false);
  assert.equal('prompt_cache_key' in first.nextState, false);
  assert.equal('session_id' in first.nextState, false);
});

test('no global clock or random source is read', () => {
  const originalNow = Date.now;
  const originalRandom = Math.random;
  try {
    Date.now = () => { throw new Error('Unexpected global clock read'); };
    Math.random = () => { throw new Error('Unexpected global RNG read'); };
    const state = createRecoveryState({}, 0);
    const result = decideRecovery({ state, failure: { status: 503 }, nowMs: 0 });
    assert.equal(result.delayMs, 275);
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
  }
});

test('invalid policy, missing clock, forged counters and invalid injected randomness fail explicitly', () => {
  for (const options of [{ totalAttempts: 0 }, { totalAttempts: 11 }, { transientAttempts: 4 }, { resourceAttempts: 11 }, { deadlineMs: 180001 }, { baseDelayMs: -1 }, { maxDelayMs: 2001 }, { jitterRatio: -0.1 }, { jitterRatio: Infinity }]) assert.throws(() => createRecoveryState(options, 0), TypeError);
  assert.throws(() => createRecoveryState({}), TypeError);
  assert.throws(() => createRecoveryState({}, -1), TypeError);
  assert.throws(() => parseRetryAfter({}, undefined), TypeError);
  const state = createRecoveryState({}, 0);
  assert.throws(() => decideRecovery({ state, failure: { status: 503 } }), TypeError);
  assert.throws(() => decideRecovery({ state: { ...state, attempt: 2 }, failure: { status: 503 }, nowMs: 0 }), TypeError);
  assert.throws(() => decideRecovery({ state: { ...state, policy: { ...state.policy, totalAttempts: Infinity } }, failure: { status: 503 }, nowMs: 0 }), TypeError);
  for (const random of [-0.1, 1.1, Infinity, () => NaN]) assert.throws(() => decide({ status: 503 }, state, 0, random), TypeError);
});

test('terminal decisions neither consume a call nor sample randomness', () => {
  const state = createRecoveryState({}, 0);
  const result = decide({ status: 401 }, state, 0, () => { throw new Error('Terminal result should not sample RNG'); });
  assert.equal(result.retry, false);
  assert.equal(result.nextState, state);
  assert.equal(result.delayMs, 0);
});
