'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { createRecoverySession } = require('../lib/recovery-session');

const official = 'https://agentrouter.org/v1';
const resource = { error: { type: 'invalid_request_error', message: 'The requested item was created under a different Azure OpenAI resource.' } };
const cipher = { error: { type: 'invalid_request_error', code: 'invalid_encrypted_content', message: 'SYNTHETIC_CIPHER_ERROR' } };
const proof = () => ({ hasOutput: false, unknown: false, committed: false });
const failure = (payload = resource, extra = {}) => ({ statusCode: 400, payload, inspectionComplete: true, responseComplete: true, complete: true, output: proof(), ...extra });
const history = () => ({ model: 'synthetic-model', stream: true, store: false, reasoning: { effort: 'high' },
  prompt_cache_key: 'SYNTHETIC_CACHE', session_id: 'SYNTHETIC_SESSION', tools: [{ type: 'function', name: 'add', strict: false,
    parameters: { type: 'object', properties: { a: { type: 'number' } }, required: [] } }], input: [
    { type: 'reasoning', id: 'rs_cipher', summary: [], encrypted_content: 'SYNTHETIC_OPAQUE' },
    { type: 'reasoning', id: 'rs_summary', summary: [{ type: 'summary_text', text: 'SYNTHETIC_SUMMARY' }], encrypted_content: 'SYNTHETIC_OPAQUE_B' },
    { type: 'function_call', id: 'fc_id', call_id: 'call_keep', name: 'add', arguments: '{"a":42}' },
    { type: 'function_call_output', call_id: 'call_keep', output: '42' }
  ] });
const session = (options = {}) => createRecoverySession({ upstream: official, body: history(), now: () => 1000, random: () => 0, retryDelayMs: 0, ...options });
function idProjection(body) {
  const projected = structuredClone(body);
  for (const item of projected.input) if (['reasoning', 'function_call', 'message', 'function_call_output'].includes(item.type)) delete item.id;
  return projected;
}
function cipherProjection(body) {
  const projected = structuredClone(body);
  projected.input = projected.input.filter(item => {
    if (item.type !== 'reasoning' || !Object.hasOwn(item, 'encrypted_content')) return true;
    delete item.encrypted_content;
    delete item.id;
    return item.summary.some(part => part.text.trim().length > 0);
  });
  return projected;
}

function frozen(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}

test('embedded session creates no listener, request, timer or transport', () => {
  const originals = { createServer: http.createServer, httpRequest: http.request, httpsRequest: https.request, timeout: global.setTimeout };
  try {
    http.createServer = http.request = https.request = global.setTimeout = () => { throw new Error('Embedded recovery must not start transport.'); };
    const s = session({ historyMode: 'minimal' });
    assert.equal(s.decide(failure()).retry, true);
    assert.equal(s.current().attempt, 2);
  } finally {
    http.createServer = originals.createServer;
    http.request = originals.httpRequest;
    https.request = originals.httpsRequest;
    global.setTimeout = originals.timeout;
  }
});

test('initial exact Buffer, body, projection and decision snapshots are isolated from caller mutation', () => {
  const body = history(), before = structuredClone(body);
  const rawBody = Buffer.from(' \t\r\n' + JSON.stringify(body, null, 2) + '\n');
  const bytes = Buffer.from(rawBody);
  const s = session({ body, rawBody, historyMode: 'minimal' });
  body.input[0].encrypted_content = 'CALLER_CHANGED';
  rawBody.fill(0);
  let current = s.current();
  assert.deepEqual(current.body, before);
  assert.deepEqual(current.rawBody, bytes);
  current.body.input[0].id = 'PUBLIC_CHANGED';
  current.rawBody.fill(0);
  assert.throws(() => { current.state.attempt = 100; }, TypeError);
  const decision = s.decide(frozen(failure()));
  assert.equal(decision.retry, true);
  assert.deepEqual(decision.body, idProjection(before));
  assert.throws(() => { decision.nextState.attempt = 1; }, TypeError);
  decision.body.input[0].encrypted_content = 'PUBLIC_CHANGED_AGAIN';
  decision.rawBody.fill(0);
  decision.projection.body.input[0].encrypted_content = 'PROJECTION_CHANGED';
  current = s.current();
  assert.deepEqual(current.body, idProjection(before));
  assert.deepEqual(current.rawBody, Buffer.from(JSON.stringify(idProjection(before))));
  assert.equal(current.attempt, 2);
});

test('supplied raw JSON must match body while whitespace and property ordering stay exact', () => {
  const body = history();
  const reordered = { input: body.input, tools: body.tools, session_id: body.session_id, prompt_cache_key: body.prompt_cache_key,
    reasoning: body.reasoning, store: body.store, stream: body.stream, model: body.model };
  const rawBody = Buffer.from(' \t\r\n' + JSON.stringify(reordered, null, 2) + '\n');
  const s = session({ body, rawBody, historyMode: 'minimal' });
  assert.deepEqual(s.current().rawBody, rawBody);
  assert.deepEqual(s.current().body, body);
  const differentModel = { ...body, model: 'OTHER_MODEL' };
  const differentHistory = history();
  differentHistory.input[2].arguments = '{"a":0}';
  const invalidUtf8 = Buffer.concat([Buffer.from('{"model":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
  for (const bytes of [Buffer.from(JSON.stringify(differentModel)), Buffer.from(JSON.stringify(differentHistory)),
    Buffer.from('{}'), Buffer.from('[]'), Buffer.from('{'), invalidUtf8]) {
    assert.throws(() => session({ body, rawBody: bytes }), TypeError);
  }
});

test('session rejects nonJSON values that serialization would silently change', () => {
  for (const extra of [{ optional: undefined }, { count: NaN }, { count: Infinity }, { date: new Date(0) }, { map: new Map() }]) {
    assert.throws(() => session({ body: { ...history(), ...extra } }), TypeError);
  }
});

for (const [name, extra, reason] of [
  ['absent inspection completion', { inspectionComplete: undefined }, 'incomplete_failure'],
  ['false inspection completion', { inspectionComplete: false }, 'incomplete_failure'],
  ['truthy nonboolean inspection completion', { inspectionComplete: 'yes' }, 'incomplete_failure'],
  ['absent output inspection', { output: undefined }, 'output_inspection_required'],
  ['missing commit proof', { output: { hasOutput: false, unknown: false } }, 'output_inspection_required'],
  ['missing unknown proof', { output: { hasOutput: false, committed: false } }, 'output_inspection_required'],
  ['missing output proof', { output: { unknown: false, committed: false } }, 'output_inspection_required'],
  ['truthy nonboolean output proof', { output: { hasOutput: 0, unknown: false, committed: false } }, 'output_inspection_required'],
  ['only top-level false flags', { output: undefined, committed: false, outputStarted: false, unknownOutput: false }, 'output_inspection_required']
]) test(`session refuses ${name} for every replay category`, () => {
  for (const payload of [resource, cipher, { status: 'completed', output: [] }, { error: { type: 'server_error' } }]) {
    const s = session({ historyMode: 'minimal', automaticRecovery: true });
    const decision = s.decide(failure(payload, { statusCode: payload.error?.type === 'server_error' ? 503 : payload.status ? 200 : 400, ...extra }));
    assert.equal(decision.retry, false);
    assert.equal(decision.reason, reason);
    assert.equal(s.current().attempt, 1);
    assert.equal(s.current().lossy, false);
  }
});

for (const [name, extra, reason] of [
  ['committed', { output: { ...proof(), committed: true } }, 'downstream_committed'],
  ['visible output', { output: { ...proof(), hasOutput: true } }, 'output_started'],
  ['unknown output', { output: { ...proof(), unknown: true } }, 'unknown_output'],
  ['top-level commit', { committed: true }, 'downstream_committed'],
  ['top-level output', { outputStarted: true }, 'output_started'],
  ['top-level unknown', { unknownOutput: true }, 'unknown_output'],
  ['tool has started', { toolStarted: true }, 'output_started'],
  ['unknown bytes', { unknownBytes: Buffer.from('data: incomplete') }, 'unknown_output']
]) test(`${name} permanently blocks replay, even after caller drops its flags`, () => {
  const s = session({ historyMode: 'minimal', automaticRecovery: true });
  assert.equal(s.decide(failure(resource, extra)).reason, reason);
  assert.equal(s.decide(failure()).retry, false);
  assert.equal(s.current().attempt, 1);
});

test('complete failed payload with tool output cannot override inspector proof', () => {
  const s = session({ automaticRecovery: true });
  const payload = { type: 'response.failed', response: { status: 'failed', output: [{ type: 'function_call', call_id: 'new', name: 'Read', arguments: '' }], error: resource.error } };
  assert.equal(s.decide(failure(payload, { statusCode: 200 })).reason, 'output_started');
  assert.equal(s.current().attempt, 1);
});

test('official constructor URL is copied and failure upstream declarations cannot redirect scope', () => {
  const upstream = new URL(official);
  const s = session({ upstream, historyMode: 'minimal' });
  upstream.hostname = 'other.example.invalid';
  assert.equal(s.decide(failure(cipher, { upstream: 'http://127.0.0.1:1/v1' })).retry, true);
  assert.equal(s.current().lossy, true);
});

for (const upstream of ['http://127.0.0.1:1/v1', 'http://agentrouter.org/v1', 'https://agentrouter.org.evil.invalid/v1', 'https://other.example.invalid/v1']) {
  test(`${upstream} cannot activate from a failure or provider header`, () => {
    const s = session({ upstream, automaticRecovery: true, generic400Projection: true, historyStrategy: 'portable' });
    assert.deepEqual(s.current().body, history());
    assert.equal(s.current().projection, undefined);
    const decision = s.decide(failure(resource, { upstream: official, headers: { 'x-upstream-provider': 'agentrouter' } }));
    assert.equal(decision.retry, false);
    assert.equal(decision.reason, 'unsupported_upstream');
    assert.deepEqual(decision.body, history());
  });
}

for (const endpoint of ['messages', 'responses/compact', 'chat/completions', 'responses?target=official', '/v1/responses']) {
  test(`${endpoint} cannot gain recovery from Responses error content`, () => {
    const s = session({ endpoint, automaticRecovery: true, historyStrategy: 'portable' });
    assert.equal(s.decide(failure()).reason, 'projection_endpoint');
    assert.equal(s.current().attempt, 1);
    assert.deepEqual(s.current().body, history());
  });
}

test('accepted reservation is consumed before sending and same failure cannot reserve twice', () => {
  const s = session({ historyMode: 'minimal', resourceAttempts: 3 });
  const firstFailure = failure();
  const first = s.decide(firstFailure);
  assert.equal(first.retry, true);
  assert.equal(s.current().attempt, 2);
  assert.equal(s.decide(firstFailure).reason, 'failure_already_decided');
  assert.equal(s.current().attempt, 2);
  assert.equal(s.decide(failure()).retry, true);
  assert.equal(s.current().attempt, 3);
  assert.equal(s.decide(failure()).reason, 'resource_attempt_budget');
  assert.equal(s.decide(failure()).retry, false);
});

test('mutable failure object can report later attempts with explicit matching attempt context', () => {
  const s = session({ historyMode: 'minimal', resourceAttempts: 4 });
  const reused = failure(resource, { attempt: 1 });
  assert.equal(s.decide(reused).retry, true);
  assert.equal(s.decide(reused).reason, 'failure_attempt_mismatch');
  assert.equal(s.current().attempt, 2);
  reused.attempt = 2;
  assert.equal(s.decide(reused).retry, true);
  reused.attempt = 3;
  assert.equal(s.decide(reused).retry, true);
  reused.attempt = 4;
  assert.equal(s.decide(reused).reason, 'resource_attempt_budget');
  assert.equal(s.current().attempt, 4);
});

for (const responseComplete of [undefined, false, 'true']) test(`history replay requires explicit true response completion (${responseComplete})`, () => {
  for (const payload of [resource, cipher, { error: { type: 'invalid_request_error', message: 'Bad request.' } }]) {
    const s = session({ historyMode: 'minimal', automaticRecovery: true, generic400Projection: true });
    const decision = s.decide(failure(payload, { responseComplete }));
    assert.equal(decision.retry, false);
    assert.equal(decision.reason, 'response_incomplete');
    assert.equal(decision.lossy, false);
    assert.equal(s.current().attempt, 1);
    assert.deepEqual(s.current().body, history());
  }
});

test('legacy complete alias alone does not prove full inspection', () => {
  const s = session({ historyMode: 'minimal' });
  assert.equal(s.decide(failure(resource, { inspectionComplete: undefined, complete: true })).reason, 'incomplete_failure');
});

test('fully inspected metadata-only or pre-header transient can retry after response disconnect', () => {
  for (const failureKind of ['pre_output_disconnect', 'pre_output_connection_failure']) {
    const s = session({ historyMode: 'minimal', automaticRecovery: true });
    const decision = s.decide({ failureKind, inspectionComplete: true, responseComplete: false, output: proof() });
    assert.equal(decision.retry, true);
    assert.equal(decision.classification, 'transient');
    assert.deepEqual(decision.body, history());
  }
});

test('structured transient terminal cannot be replayed from a truncated response', () => {
  for (const responseComplete of [undefined, false]) {
    const s = session({ automaticRecovery: true });
    const decision = s.decide(failure({ status: 'failed', output: [], error: { type: 'server_error' } }, { statusCode: 200, responseComplete }));
    assert.equal(decision.retry, false);
    assert.equal(decision.reason, 'response_incomplete');
  }
});

test('legacy wider resource budget stays bounded at 100 with immutable current bytes', () => {
  const s = session({ historyMode: 'minimal', resourceAttempts: 100, timeoutMs: 1800000, retryDelayMs: 60000 });
  for (let attempt = 1; attempt < 100; attempt++) {
    const decision = s.decide(failure());
    assert.equal(decision.retry, true);
    assert.equal(decision.delayMs, 60000);
    assert.equal(s.current().attempt, attempt + 1);
  }
  assert.equal(s.decide(failure()).reason, 'resource_attempt_budget');
  assert.deepEqual(s.current().body, idProjection(history()));
});

for (const order of [['id', 'cipher'], ['cipher', 'id']]) test(`${order.join(' then ')} composes once on current body without reviving cipher`, () => {
  const s = session({ historyMode: 'minimal', resourceAttempts: 5 });
  let expected = history();
  for (const kind of order) {
    const decision = s.decide(failure(kind === 'id' ? resource : cipher));
    assert.equal(decision.retry, true);
    expected = kind === 'id' ? idProjection(expected) : cipherProjection(expected);
    assert.deepEqual(decision.body, expected);
    assert.deepEqual(s.current().body, expected);
  }
  const again = s.decide(failure());
  assert.equal(again.retry, true);
  assert.equal(again.projection, null);
  assert.equal(again.lossy, true);
  assert.deepEqual(again.body, expected);
  assert.deepEqual(again.recoveryHeaders, { 'x-rhb-recovery': 'encrypted-reasoning-dropped' });
  assert.equal(s.decide(failure(cipher)).reason, 'encrypted_attempt_budget');
});

test('portable projection and recovery share exactly one ID application', () => {
  const s = session({ historyMode: 'minimal', historyStrategy: 'portable' });
  assert.equal(s.current().projection.ok, true);
  assert.deepEqual(s.current().body, idProjection(history()));
  assert.equal(s.decide(failure()).projection, null);
  assert.deepEqual(s.current().body, idProjection(history()));
});

test('cipher, transient and resource replays share the automatic total budget', () => {
  const s = session({ historyMode: 'minimal', automaticRecovery: true, recoveryPolicy: { totalAttempts: 3, resourceAttempts: 10, baseDelayMs: 1, jitterRatio: 0 } });
  assert.equal(s.decide(failure(cipher)).retry, true);
  const transient = s.decide(failure({ error: { type: 'server_error' } }, { statusCode: 503 }));
  assert.equal(transient.retry, true);
  assert.equal(transient.lossy, true);
  assert.deepEqual(transient.body, cipherProjection(history()));
  assert.equal(s.decide(failure()).reason, 'total_attempt_budget');
  assert.equal(s.current().state.encryptedRetries, 1);
  assert.equal(s.current().state.transientRetries, 1);
});

test('deadline uses live monotonic observations and cannot be reset by public snapshots', () => {
  let now = 1000;
  const s = session({ historyMode: 'minimal', now: () => now, timeoutMs: 100 });
  now = 1050;
  assert.equal(s.decide(failure()).retry, true);
  now = 1020;
  assert.equal(s.decide(failure()).retry, true);
  assert.equal(s.current().state.lastNowMs, 1050);
  now = 1100;
  assert.equal(s.decide(failure()).reason, 'deadline_expired');
  now = 1000;
  assert.equal(s.decide(failure()).retry, false);
  assert.equal(s.current().deadlineAtMs, 1100);
});

test('server backoff exceeding automatic deadline reserves nothing and applies no projection', () => {
  const s = session({ historyMode: 'minimal', automaticRecovery: true, timeoutMs: 100 });
  const decision = s.decide(failure(cipher, { headers: { 'retry-after': '1' } }));
  assert.equal(decision.reason, 'retry_delay_exceeds_deadline');
  assert.equal(decision.retry, false);
  assert.equal(decision.lossy, false);
  assert.deepEqual(decision.body, history());
  assert.equal(s.current().attempt, 1);
});

for (const cancellation of [{ cancelled: true }, { aborted: true }, { failureKind: 'client_closed' }, { error: Object.assign(new Error('Stopped'), { name: 'AbortError' }) }]) {
  test('cancellation is terminal without completion proof and cannot be undone', () => {
    const s = session({ historyMode: 'minimal' });
    assert.equal(s.decide(cancellation).reason, 'cancelled');
    assert.equal(s.decide(failure()).retry, false);
    assert.equal(s.current().attempt, 1);
  });
}

test('legacy explicit minimal retains local409 projection metadata but auto keeps actual upstream error', () => {
  const body = { ...history(), previous_response_id: 'server-only' };
  const legacy = session({ body, historyMode: 'minimal' }).decide(failure());
  assert.equal(legacy.retry, false);
  assert.equal(legacy.projectionError.code, 'server_history_reference');
  for (const options of [{ historyMode: 'auto' }, { historyMode: 'codex' }, { historyMode: 'minimal', automaticRecovery: true }]) {
    const decision = session({ body, ...options }).decide(failure());
    assert.equal(decision.retry, false);
    assert.equal(decision.projectionError, null);
    assert.deepEqual(decision.body, body);
  }
});

test('converted Messages may replay no-ID validated history but never drop encrypted reasoning', () => {
  const body = { model: 'synthetic', input: [{ role: 'user', content: 'Hello.' }] };
  const s = session({ body, endpoint: 'messages', converted: true, historyMode: 'minimal' });
  const first = s.decide(failure());
  assert.equal(first.retry, true);
  assert.equal(first.projection.code, 'no_supported_item_ids');
  assert.deepEqual(first.body, body);
  assert.equal(s.decide(failure()).projection, null);
  assert.equal(s.decide(failure(cipher)).reason, 'projection_endpoint');
  assert.equal(s.current().lossy, false);
});

for (const payload of [{ error: { type: 'server_error' } }, { status: 'completed', output: [] }, { status: 'failed', output: [], error: null }]) {
  test('automatic history selection alone never enables transient or empty replays', () => {
    const decision = session().decide(failure(payload, { statusCode: payload.error?.type ? 503 : 200 }));
    assert.equal(decision.retry, false);
    assert.equal(decision.lossy, false);
    assert.equal(decision.nextState.attempt, 1);
  });
}

test('explicit generic400 projection is one reservation within the automatic budget', () => {
  const s = session({ historyMode: 'minimal', automaticRecovery: true, generic400Projection: true });
  const generic = { error: { type: 'invalid_request_error', message: 'Bad request.' } };
  const first = s.decide(failure(generic));
  assert.equal(first.retry, true);
  assert.equal(first.classification, 'projection');
  assert.equal(first.reason, 'validated_generic_400_projection');
  assert.equal(first.nextState.projectionRetries, 1);
  assert.equal(s.decide(failure(generic)).retry, false);
  assert.equal(s.current().attempt, 2);
});

test('session rejects invalid body, bytes, clock, destination and legacy bounds explicitly', () => {
  for (const options of [{ body: null }, { body: [] }, { rawBody: '{}' }, { now: () => NaN }, { now: () => -1 },
    { upstream: 'https://secret@agentrouter.org/v1' }, { upstream: 'https://agentrouter.org/v1?key=secret' },
    { historyMode: 'unknown' }, { historyStrategy: 'unknown' }, { automaticRecovery: 'true' },
    { resourceAttempts: 101 }, { resourceAttempts: 0 }, { timeoutMs: 1800001 }, { retryDelayMs: 60001 }]) {
    assert.throws(() => session(options), TypeError);
  }
});
