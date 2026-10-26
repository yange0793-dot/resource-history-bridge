'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createBridge } = require('../lib/bridge');
const { decideResourceRecovery } = require('../lib/recovery');

const resource = JSON.stringify({ error: {
  type: 'invalid_request_error', message: 'The requested item was created under a different Azure OpenAI resource.'
} });
const transient = '{"error":{"type":"server_error","message":"Temporarily unavailable."}}';
const generic = '{"error":{"type":"invalid_request_error","message":"Bad request."}}';
const frame = payload => `data: ${JSON.stringify(payload)}\n\n`;
const completed = frame({ type: 'response.completed', response: {
  status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }]
} });
const history = { model: 'synthetic', stream: true, prompt_cache_key: 'stable-cache', input: [
  { type: 'reasoning', id: 'remove', summary: [], content: null, encrypted_content: 'SYNTHETIC_OPAQUE' }
] };
const raw = Buffer.from(' \n' + JSON.stringify(history, null, 2));

async function fixture(t, handler, options = {}) {
  const requests = [], events = [], sockets = new Set();
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ bytes: Buffer.concat(chunks), headers: req.headers, path: req.url });
    handler(req, res, requests.length);
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  let bridge;
  t.after(async () => {
    if (bridge) await bridge.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
  });
  bridge = createBridge({
    upstream: `http://127.0.0.1:${upstream.address().port}/v1`, timeoutMs: 2000, retryDelayMs: 0,
    retryJitterRatio: 0, diagnostics: { enabled: true, onEvent: event => events.push(event) }, ...options
  });
  const address = await bridge.listen(0);
  return { requests, events, address };
}

function post(address, body = raw, path = '/v1/responses') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: address.port, method: 'POST', path, headers: {
      'content-type': 'application/json', authorization: 'Bearer SYNTHETIC',
      'x-session-id': 'stable-session', 'user-agent': 'synthetic-engine-test'
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function send(res, status, text, type = 'application/json', headers = {}) {
  res.writeHead(status, { 'content-type': type, ...headers });
  res.end(text);
}

function identity(requests) {
  for (const request of requests) {
    assert.equal(request.headers.authorization, 'Bearer SYNTHETIC');
    assert.equal(request.headers['x-session-id'], 'stable-session');
    assert.equal(request.headers['user-agent'], 'synthetic-engine-test');
    assert.equal(request.headers['content-length'], String(request.bytes.length));
    assert.equal(request.headers['accept-encoding'], 'identity');
  }
}

for (const automaticRecovery of [false, true]) {
  test(`shared execution projects only once and relays last failure (automatic=${automaticRecovery})`, async t => {
    const f = await fixture(t, (_req, res, attempt) => send(res, 400, resource, 'application/json', { 'x-final-attempt': String(attempt) }), {
      automaticRecovery, resourceAttempts: 4, totalAttempts: 4
    });
    const result = await post(f.address);
    assert.equal(result.status, 400);
    assert.equal(result.text, resource);
    assert.equal(result.headers['x-final-attempt'], '4');
    assert.equal(f.requests.length, 4);
    assert.deepEqual(f.requests[0].bytes, raw);
    const expected = structuredClone(history);
    delete expected.input[0].id;
    for (const request of f.requests.slice(1)) assert.deepEqual(request.bytes, Buffer.from(JSON.stringify(expected)));
    assert.equal(f.events.filter(event => event.type === 'projection').length, 1);
    identity(f.requests);
  });

  test(`portable and recovery share one apply path (automatic=${automaticRecovery})`, async t => {
    const f = await fixture(t, (_req, res, attempt) => send(res, attempt < 3 ? 400 : 200, attempt < 3 ? resource : completed,
      attempt < 3 ? 'application/json' : 'text/event-stream'), { automaticRecovery, historyStrategy: 'portable' });
    assert.equal((await post(f.address)).text, completed);
    assert.equal(f.requests.length, 3);
    assert.equal(f.events.filter(event => event.type === 'projection').length, 1);
    assert.equal(Object.hasOwn(JSON.parse(f.requests[0].bytes).input[0], 'id'), false);
    for (const request of f.requests) assert.deepEqual(request.bytes, f.requests[0].bytes);
  });

  test(`converted no-ID history is retransmitted unchanged (automatic=${automaticRecovery})`, async t => {
    const f = await fixture(t, (_req, res, attempt) => send(res, attempt < 3 ? 400 : 200, attempt < 3 ? resource : completed,
      attempt < 3 ? 'application/json' : 'text/event-stream'), { automaticRecovery, upstreamProtocol: 'responses' });
    const body = JSON.stringify({ model: 'synthetic', max_tokens: 20, messages: [{ role: 'user', content: 'Hello.' }] });
    const result = await post(f.address, body, '/v1/messages');
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.text).content[0].text, 'OK');
    assert.equal(f.requests.length, 3);
    assert.equal(f.events.filter(event => event.type === 'projection').length, 1);
    for (const request of f.requests) {
      assert.deepEqual(request.bytes, f.requests[0].bytes);
      assert.equal(request.path, '/v1/responses');
    }
    identity(f.requests);
  });
}

test('legacy execution allows all 100 resource calls and never schedules a zero delay', async t => {
  const f = await fixture(t, (_req, res, attempt) => send(res, 400, resource, 'application/json', { 'x-final-attempt': String(attempt) }), {
    resourceAttempts: 100, timeoutMs: 1800000, retryDelayMs: 0,
    sleep() { throw new Error('Legacy zero delay must not invoke sleep.'); }
  });
  const result = await post(f.address);
  assert.equal(result.status, 400);
  assert.equal(result.text, resource);
  assert.equal(result.headers['x-final-attempt'], '100');
  assert.equal(f.requests.length, 100);
  assert.equal(f.events.filter(event => event.type === 'projection').length, 1);
});

test('legacy fixed 60000ms delay remains fixed and ignores server backoff hints', async t => {
  let now = 0;
  const delays = [];
  const f = await fixture(t, (_req, res, attempt) => send(res, attempt < 3 ? 400 : 200, attempt < 3 ? resource : completed,
    attempt < 3 ? 'application/json' : 'text/event-stream', { 'retry-after': '999999' }), {
    timeoutMs: 1800000, retryDelayMs: 60000, now: () => now,
    sleep: async ms => { delays.push(ms); now += ms; }
  });
  assert.equal((await post(f.address)).text, completed);
  assert.deepEqual(delays, [60000, 60000]);
  assert.equal(f.requests.length, 3);
});

test('Harness transient, generic projection and resource retry share the capped execution budget', async t => {
  let now = 0;
  const delays = [];
  const f = await fixture(t, (_req, res, attempt) => send(res,
    attempt === 1 ? 503 : 400, attempt === 1 ? transient : attempt === 2 ? generic : resource), {
    historyMode: 'harness', totalAttempts: 4, resourceAttempts: 10, retryDelayMs: 20,
    now: () => now, sleep: async ms => { delays.push(ms); now += ms; }
  });
  assert.equal((await post(f.address)).text, resource);
  assert.equal(f.requests.length, 4);
  assert.deepEqual(delays, [20, 40, 80]);
  assert.deepEqual(f.requests[0].bytes, raw);
  assert.deepEqual(f.requests[1].bytes, raw);
  assert.deepEqual(f.requests[2].bytes, f.requests[3].bytes);
  assert.equal(Object.hasOwn(JSON.parse(f.requests[2].bytes).input[0], 'id'), false);
  assert.equal(f.events.filter(event => event.type === 'projection').length, 1);
  identity(f.requests);
});

for (const [mode, automaticRecovery, status] of [
  ['minimal', false, 409], ['codex', false, 400], ['harness', true, 400], ['minimal', true, 400]
]) test(`${mode} projection rejection keeps its existing error policy (automatic=${automaticRecovery})`, async t => {
  const f = await fixture(t, (_req, res) => send(res, 400, resource), { historyMode: mode, automaticRecovery });
  const body = JSON.stringify({ ...history, previous_response_id: 'synthetic-reference' });
  const result = await post(f.address, body);
  assert.equal(result.status, status);
  if (status === 409) assert.equal(JSON.parse(result.text).error.code, 'server_history_reference');
  else assert.equal(result.text, resource);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].bytes, Buffer.from(body));
});

for (const mode of ['minimal', 'codex']) test(`${mode} default does not inherit Harness transient, empty or EOF recovery`, async t => {
  for (const [status, text, type] of [
    [503, transient, 'application/json'],
    [200, frame({ type: 'response.completed', response: { status: 'completed', output: [] } }), 'text/event-stream'],
    [200, '', 'text/event-stream']
  ]) {
    const f = await fixture(t, (_req, res) => send(res, status, text, type), { historyMode: mode });
    const result = await post(f.address);
    assert.equal(result.status, status);
    assert.equal(result.text, text);
    assert.equal(f.requests.length, 1);
  }
});

for (const automaticRecovery of [false, true]) test(`output, unknown and partial tails prohibit resource replay (automatic=${automaticRecovery})`, async t => {
  const failure = frame({ type: 'response.failed', response: { status: 'failed', output: [], error: JSON.parse(resource).error } });
  for (const text of [
    frame({ type: 'response.output_text.delta', delta: ' ' }) + failure,
    frame({ type: 'future.event', content: 'unknown' }) + failure,
    failure + 'data: {"type":"response.output_text.delta","delta":"'
  ]) {
    const f = await fixture(t, (_req, res) => send(res, 200, text, 'text/event-stream'), { automaticRecovery });
    assert.equal((await post(f.address)).text, text);
    assert.equal(f.requests.length, 1);
  }
});

test('resource-only planner retains wider immutable state and suppresses non-resource candidates', () => {
  const state = Object.freeze({ attempt: 99, startedAtMs: 0, deadlineAtMs: 1800000 });
  const decision = decideResourceRecovery({ state, failure: { statusCode: 400, payload: JSON.parse(resource) }, resourceAttempts: 100, retryDelayMs: 60000 });
  assert.equal(decision.retry, true);
  assert.equal(decision.delayMs, 60000);
  assert.equal(decision.nextState.attempt, 100);
  assert.equal(decision.nextState.deadlineAtMs, 1800000);
  assert.equal(state.attempt, 99);
  assert.equal(decideResourceRecovery({ state: decision.nextState, failure: { statusCode: 400, payload: JSON.parse(resource) }, resourceAttempts: 100 }).reason, 'resource_attempt_budget');
  for (const failure of [{ statusCode: 503 }, { statusCode: 400 }, { statusCode: 200, payload: { status: 'completed', output: [] } }]) {
    const stopped = decideResourceRecovery({ state, failure });
    assert.equal(stopped.retry, false);
    assert.equal(stopped.generic400ProjectionCandidate, false);
    assert.equal(stopped.nextState, state);
  }
});
