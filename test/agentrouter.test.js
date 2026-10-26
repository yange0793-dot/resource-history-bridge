'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { DEFAULT_UPSTREAM, validateAgentRouterUpstream } = require('../lib/agentrouter');
const { createBridge } = require('../index');

function post(port, key, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/v1/responses', agent: false,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-session-id': 'MOCK_SESSION' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Mock request timed out.')));
    req.end(JSON.stringify(body));
  });
}

async function fixture(t, handle, options = {}) {
  const upstream = http.createServer(handle);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => upstream.close(resolve));
    upstream.closeAllConnections();
    await closed;
  });
  const bridge = createBridge({ upstream: `http://127.0.0.1:${upstream.address().port}/v1`, historyMode: 'codex', resourceAttempts: 2, retryDelayMs: 0, ...options });
  await bridge.listen(0);
  t.after(() => bridge.close());
  return bridge.server.address().port;
}

const history = { model: 'MOCK_MODEL', reasoning: { effort: 'high' }, metadata: { session: 'MOCK_SESSION' },
  input: [{ type: 'message', id: 'MOCK_RESOURCE_ID', role: 'user', content: [{ type: 'input_text', text: 'Mock verification.' }] }] };
const azureError = { error: { type: 'invalid_request_error', code: 400, param: '', message: 'The requested item was created under a different Azure OpenAI resource.' } };

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('default upstream is the official AgentRouter Responses base', () => {
  assert.equal(DEFAULT_UPSTREAM, 'https://agentrouter.org/v1');
  assert.equal(validateAgentRouterUpstream().href, DEFAULT_UPSTREAM);
});

test('library defaults can start a loopback listener without an explicit upstream or any upstream call', async t => {
  const bridge = createBridge({});
  t.after(() => bridge.close());
  const address = await bridge.listen(0);
  assert.equal(address.address, '127.0.0.1');
});

for (const url of ['https://agentrouter.org/v1', 'https://ps.air-outer.com/v1', 'https://AGENTROUTER.ORG/v1',
  'http://127.0.0.1:1234/v1', 'http://localhost:1234/v1', 'http://[::1]:1234/v1', 'https://localhost:1234/v1']) {
  test(`upstream contract accepts ${url}`, () => assert.equal(validateAgentRouterUpstream(url).href, new URL(url).href));
}

for (const url of ['http://agentrouter.org/v1', 'http://ps.air-outer.com/v1', 'https://example.com/v1',
  'https://agentrouter.org.evil.example/v1', 'https://agentrouter.org./v1', 'https://127.0.0.1.evil.example/v1',
  'http://0.0.0.0/v1', 'http://192.168.1.1/v1', 'file:///tmp/mock',
  'https://MOCK_USER:MOCK_SECRET@agentrouter.org/v1', 'https://agentrouter.org/v1?key=MOCK_SECRET', 'https://agentrouter.org/v1#mock']) {
  test(`upstream contract rejects ${url}`, () => {
    assert.throws(() => validateAgentRouterUpstream(url));
    assert.throws(() => createBridge({ upstream: url }));
  });
}

test('upstream URL is copied and other value types are rejected', () => {
  const original = new URL(DEFAULT_UPSTREAM);
  const result = validateAgentRouterUpstream(original);
  result.pathname = '/changed';
  assert.equal(original.href, DEFAULT_UPSTREAM);
  for (const value of [null, 42, {}, '']) assert.throws(() => validateAgentRouterUpstream(value));
});

test('valid client key rotation needs no bridge restart and retries freeze each request identity', async t => {
  const calls = [];
  const attempts = new Map();
  const port = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const key = req.headers.authorization;
    const attempt = (attempts.get(key) || 0) + 1;
    attempts.set(key, attempt);
    calls.push({ key, session: req.headers['x-session-id'], body });
    json(res, attempt === 1 ? 400 : 200, attempt === 1 ? azureError : { mock: 'OK' });
  });
  const original = structuredClone(history);
  assert.equal((await post(port, 'MOCK_KEY_A', history)).status, 200);
  assert.equal((await post(port, 'MOCK_KEY_B', history)).status, 200);
  assert.deepEqual(history, original);
  assert.deepEqual(calls.map(call => call.key), ['Bearer MOCK_KEY_A', 'Bearer MOCK_KEY_A', 'Bearer MOCK_KEY_B', 'Bearer MOCK_KEY_B']);
  const projected = structuredClone(history);
  delete projected.input[0].id;
  assert.deepEqual(calls.map(call => call.body), [history, projected, history, projected]);
  assert.ok(calls.every(call => call.session === 'MOCK_SESSION'));
});

test('bridge key override intentionally wins over later client key changes', async t => {
  const keys = [];
  const port = await fixture(t, async (req, res) => {
    for await (const _chunk of req) { /* Consume mock request. */ }
    keys.push(req.headers.authorization);
    json(res, 200, { mock: 'OK' });
  }, { apiKey: 'MOCK_BRIDGE_KEY' });
  await post(port, 'MOCK_KEY_A', history);
  await post(port, 'MOCK_KEY_B', history);
  assert.deepEqual(keys, ['Bearer MOCK_BRIDGE_KEY', 'Bearer MOCK_BRIDGE_KEY']);
});

test('loopback manager does not gain the official-host generic400 signature through spoofed headers', async t => {
  const calls = [];
  const error = { error: { type: 'invalid_request_error', param: '', code: null,
    message: 'Upstream rejected the request as invalid [trace_id=MOCK_TRACE]' } };
  const port = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader('x-upstream-host', 'agentrouter.org');
    json(res, 400, error);
  });
  const result = await post(port, 'MOCK_KEY', history);
  assert.equal(result.status, 400);
  assert.deepEqual(JSON.parse(result.body), error);
  assert.deepEqual(calls, [history]);
});

test('invalid replacement key returns the authentication error without projection or retry', async t => {
  const calls = [];
  const error = { error: { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key.' } };
  const port = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push(JSON.parse(Buffer.concat(chunks).toString()));
    json(res, 401, error);
  });
  const result = await post(port, 'MOCK_INVALID_KEY', history);
  assert.equal(result.status, 401);
  assert.deepEqual(JSON.parse(result.body), error);
  assert.deepEqual(calls, [history]);
});
