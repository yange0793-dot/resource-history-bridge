'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { once } = require('node:events');
const { gzipSync } = require('node:zlib');
const { createBridge } = require('../lib/bridge');

const azure = { error: { type: 'invalid_request_error', code: 400,
  message: 'The requested item was created under a different Azure OpenAI resource.' } };
const generic = { error: { type: 'invalid_request_error', param: '', code: null,
  message: 'Upstream rejected the request as invalid [trace_id=SYNTHETIC_TRACE]' } };
const frame = payload => `data: ${JSON.stringify(payload)}\n\n`;
const lifecycle = frame({ type: 'response.created', response: { status: 'in_progress', output: [] } });
const empty = frame({ type: 'response.completed', response: { status: 'completed', output: [] } });
const history = {
  model: 'OTHER_PROVIDER_MODEL', stream: true, store: false, reasoning: { effort: 'high' },
  prompt_cache_key: 'UNCHANGED_CACHE', session_id: 'UNCHANGED_SESSION',
  tools: [{ type: 'function', name: 'Read', strict: false, parameters: { type: 'object', properties: { file: { type: 'string' } }, required: [] } }],
  input: [
    { type: 'message', id: 'UNCHANGED_MESSAGE_ID', role: 'user', content: [{ type: 'input_text', text: 'Synthetic input.' }] },
    { type: 'reasoning', id: 'UNCHANGED_REASONING_ID', encrypted_content: 'OPAQUE_A+/=\u0000é', summary: [] },
    { type: 'function_call', id: 'UNCHANGED_TOOL_ID', call_id: 'UNCHANGED_PAIR', name: 'Read', arguments: '{"file":"/synthetic"}' },
    { type: 'function_call_output', id: 'UNCHANGED_OUTPUT_ID', call_id: 'UNCHANGED_PAIR', output: '42' }
  ]
};
const raw = Buffer.from(' \t\r\n' + JSON.stringify(history, null, 2) + '\n');
const identity = {
  'content-type': 'application/json', authorization: 'Bearer OTHER_PROVIDER_KEY',
  'x-session-id': 'UNCHANGED_HEADER_SESSION', 'x-cache-key': 'UNCHANGED_HEADER_CACHE',
  'x-client-request-id': 'UNCHANGED_REQUEST', 'user-agent': 'other-provider-fixture/1',
  'accept-encoding': 'gzip, br', 'openai-beta': 'responses=experimental'
};

// Remote fixed targets are redirected before DNS/transport; no external calls.
async function fixture(t, handler, options = {}) {
  const requests = [], targets = [], events = [], sockets = new Set();
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ bytes: Buffer.concat(chunks), headers: req.headers, path: req.url });
    handler(req, res, requests.length);
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const configured = new URL(options.upstream || `http://127.0.0.1:${upstream.address().port}/v1`);
  const originalHttp = http.request, originalHttps = https.request;
  function intercept(original, transport) {
    return function guarded(target, ...args) {
      if (!(target instanceof URL)) {
        assert.equal(transport, 'http:');
        assert.equal(target.hostname, '127.0.0.1', 'client request must stay on loopback');
        return original.call(this, target, ...args);
      }
      assert.equal(target.origin, configured.origin, 'only the fixed synthetic target may be used');
      targets.push(target.href);
      const local = new URL(target);
      local.protocol = 'http:';
      local.hostname = '127.0.0.1';
      local.port = String(upstream.address().port);
      return originalHttp.call(http, local, ...args);
    };
  }
  http.request = intercept(originalHttp, 'http:');
  https.request = intercept(originalHttps, 'https:');
  let bridge;
  t.after(async () => {
    try { if (bridge) await bridge.close(); }
    finally {
      http.request = originalHttp;
      https.request = originalHttps;
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => upstream.close(resolve));
    }
  });
  bridge = createBridge({
    upstream: configured.href, historyMode: 'harness', automaticRecovery: true,
    generic400Projection: true, historyStrategy: 'portable', upstreamProtocol: 'responses',
    timeoutMs: 2000, retryDelayMs: 0, retryJitterRatio: 0,
    sleep() { throw new Error('Bypass must not schedule any replay.'); },
    diagnostics: { enabled: true, onEvent: event => events.push(event) }, ...options
  });
  const address = await bridge.listen(0);
  return { address, requests, targets, events, configured };
}

function post(address, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...identity, ...options.headers };
    for (const name of Object.keys(headers)) if (headers[name] === undefined) delete headers[name];
    const req = http.request({ hostname: '127.0.0.1', port: address.port, method: 'POST',
      path: options.path || '/v1/responses', agent: false, headers }, res => {
      const chunks = [];
      res.on('data', chunk => { chunks.push(chunk); if (options.onData) options.onData(chunk); });
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.once('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Synthetic bypass request timed out.')));
    req.end(options.body === undefined ? raw : options.body);
  });
}

function send(res, status, bytes, contentType = 'application/json', headers = {}) {
  res.writeHead(status, { 'content-type': contentType, 'x-original-upstream': 'preserved', ...headers });
  res.end(bytes);
}

function unchanged(f, bytes = raw, path = '/v1/responses', headers = identity) {
  assert.equal(f.requests.length, 1, 'bypass must make exactly one upstream call');
  assert.deepEqual(f.requests[0].bytes, bytes, 'all model/history/tool/encrypted bytes must remain original');
  assert.equal(f.requests[0].path, path);
  for (const [key, value] of Object.entries(headers)) assert.equal(f.requests[0].headers[key], value, key);
  assert.equal(f.events.filter(event => event.type === 'projection' || event.type === 'recovery').length, 0);
}

for (const [name, status, payload, contentType] of [
  ['JSON success', 200, JSON.stringify({ id: 'OTHER_RESPONSE', output: history.input }), 'application/json'],
  ['JSON empty success', 200, '{"status":"completed","output":[]}', 'application/json'],
  ['JSON overloaded error', 200, '{"type":"error","error":{"type":"overloaded_error"}}', 'application/json'],
  ['JSON Azure error', 400, JSON.stringify(azure), 'application/json'],
  ['JSON generic invalid', 400, JSON.stringify(generic), 'application/json'],
  ['SSE success', 200, lifecycle + frame({ type: 'response.completed', response: { status: 'completed', output: history.input } }), 'text/event-stream'],
  ['SSE Azure error', 200, lifecycle + frame({ type: 'response.failed', response: { status: 'failed', output: [], ...azure } }), 'text/event-stream'],
  ['SSE generic invalid', 400, frame(generic), 'text/event-stream'],
  ['SSE-mislabeled JSON Azure error', 400, ' \t\r\n' + JSON.stringify(azure), 'text/event-stream'],
  ['SSE-mislabeled JSON generic invalid', 400, JSON.stringify(generic), 'text/event-stream'],
  ['ordinary JSON invalid request', 400, '{"error":{"type":"invalid_request_error","message":"Bad request."}}', 'application/json'],
  ['raw non-JSON error', 400, 'unparsed provider error', 'text/plain']
]) test(`loopback ${name} bypasses all configured AgentRouter transformations`, async t => {
  const bytes = Buffer.from(payload);
  const f = await fixture(t, (_req, res) => send(res, status, bytes, contentType));
  const result = await post(f.address);
  assert.equal(result.status, status);
  assert.equal(result.headers['content-type'], contentType);
  assert.equal(result.headers['x-original-upstream'], 'preserved');
  assert.deepEqual(result.bytes, bytes);
  unchanged(f);
});

for (const status of [408, 429, 500, 502, 503, 504]) test(`bypass HTTP${status} is a single raw call despite Harness/automaticRecovery`, async t => {
  const bytes = Buffer.from('{"error":{"type":"server_error","message":"Retry later."}}');
  const f = await fixture(t, (_req, res) => send(res, status, bytes, 'application/json', { 'retry-after': '0', 'x-ms-retry-after-ms': '1' }));
  const result = await post(f.address);
  assert.equal(result.status, status);
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.headers['retry-after'], '0');
  unchanged(f);
});

for (const payload of ['', lifecycle, lifecycle + empty,
  frame({ status: 'completed', output: [] }), frame({ error: { code: 'rate_limit_exceeded' } }),
  lifecycle + 'data: {"type":"response.output_text.delta"']) {
  test('bypass empty, metadata EOF, transient SSE and partial EOF are not replayed', async t => {
    const f = await fixture(t, (_req, res) => send(res, 200, payload, 'text/event-stream'));
    const result = await post(f.address);
    assert.equal(result.status, 200);
    assert.deepEqual(result.bytes, Buffer.from(payload));
    unchanged(f);
  });
}

test('bypass SSE forwards metadata immediately instead of waiting for inspection or EOF', async t => {
  let upstreamResponse;
  const f = await fixture(t, (_req, res) => {
    upstreamResponse = res;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(lifecycle);
  });
  let metadataDelivered;
  const delivered = new Promise(resolve => { metadataDelivered = resolve; });
  const chunks = [];
  const pending = post(f.address, { onData(chunk) {
    chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (bytes.length >= Buffer.byteLength(lifecycle)) metadataDelivered(bytes);
  } });
  const received = await Promise.race([delivered, pending.then(() => { throw new Error('Stream ended before metadata was forwarded.'); })]);
  assert.deepEqual(received, Buffer.from(lifecycle));
  upstreamResponse.end(empty);
  const result = await pending;
  assert.deepEqual(result.bytes, Buffer.from(lifecycle + empty));
  unchanged(f);
});

test('bypass pre-header connection failure does not enter automatic transient recovery', async t => {
  const f = await fixture(t, req => req.socket.destroy());
  const result = await post(f.address);
  assert.equal(result.status, 502);
  unchanged(f);
});

test('bypass truncated SSE aborts downstream without a replay or invented completion', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(lifecycle);
    setTimeout(() => res.destroy(), 5);
  });
  await assert.rejects(post(f.address));
  unchanged(f);
});

test('bypass unrecoverable history returns actual Azure400 instead of a local409', async t => {
  const bytes = Buffer.from(JSON.stringify({ ...history, previous_response_id: 'SERVER_REFERENCE', input: [{ type: 'item_reference', id: 'OPAQUE_ITEM' }, null] }));
  const error = Buffer.from(JSON.stringify(azure));
  const f = await fixture(t, (_req, res) => send(res, 400, error), { historyMode: 'minimal', automaticRecovery: false });
  const result = await post(f.address, { body: bytes });
  assert.equal(result.status, 400);
  assert.deepEqual(result.bytes, error);
  unchanged(f, bytes);
});

for (const path of ['/messages?beta=true', '/v1/messages?beta=true']) test(`bypass ${path} keeps unsupported Messages content, beta query and x-api-key`, async t => {
  const bytes = Buffer.from(JSON.stringify({ model: 'OTHER_MESSAGES_MODEL', max_tokens: 50, stream: true,
    thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: [{ type: 'provider_specific_block', encrypted: 'DO_NOT_INTERPRET' }] }] }));
  const response = Buffer.from('event: provider_specific\ndata: {"opaque":"UNCHANGED"}\n\n');
  const headers = { ...identity, authorization: undefined, 'x-api-key': 'OTHER_MESSAGES_KEY', 'anthropic-version': '2023-06-01' };
  delete headers.authorization;
  const f = await fixture(t, (_req, res) => send(res, 200, response, 'text/event-stream'));
  const result = await post(f.address, { path, body: bytes, headers: { ...headers, authorization: undefined } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.bytes, response);
  unchanged(f, bytes, '/v1/messages?beta=true', headers);
  assert.equal(f.requests[0].headers.authorization, undefined, 'x-api-key must not become Bearer authentication');
});

for (const bytes of [Buffer.from('{'), Buffer.from('[]'), Buffer.from('null'), Buffer.from('other provider opaque bytes')]) {
  test('bypass does not impose AgentRouter JSON-object parsing on raw request bytes', async t => {
    const response = Buffer.from('{"provider":"accepted original bytes"}');
    const f = await fixture(t, (_req, res) => send(res, 200, response));
    const result = await post(f.address, { body: bytes });
    assert.equal(result.status, 200);
    assert.deepEqual(result.bytes, response);
    unchanged(f, bytes);
  });
}

test('bypass compressed request and response bytes/encodings are never decoded or changed', async t => {
  const request = gzipSync(raw), response = gzipSync(JSON.stringify(azure));
  const headers = { ...identity, 'content-encoding': 'gzip' };
  const f = await fixture(t, (_req, res) => send(res, 400, response, 'application/json', { 'content-encoding': 'gzip' }));
  const result = await post(f.address, { body: request, headers });
  assert.equal(result.status, 400);
  assert.equal(result.headers['content-encoding'], 'gzip');
  assert.deepEqual(result.bytes, response);
  unchanged(f, request, '/v1/responses', headers);
});

for (const upstream of ['https://api.other.example.invalid/v1', 'http://api.other.example.invalid/v1',
  'http://agentrouter.org/v1', 'http://ps.air-outer.com/v1', 'https://agentrouter.org.evil.example.invalid/v1',
  'https://sub.agentrouter.org/v1', 'https://agentrouter.org./v1', 'http://127.0.0.1.evil.example.invalid/v1']) {
  test(`${upstream} is permanently bypassed by its fixed target`, async t => {
    const error = Buffer.from(JSON.stringify(azure));
    const f = await fixture(t, (_req, res) => send(res, 400, error), { upstream });
    const result = await post(f.address);
    assert.equal(result.status, 400);
    assert.deepEqual(result.bytes, error);
    unchanged(f);
    assert.deepEqual(f.targets, [new URL('responses', upstream + '/').href]);
  });
}

test('spoofed client and upstream host/provider declarations cannot enable loopback recovery', async t => {
  const error = Buffer.from(JSON.stringify(azure));
  const spoofed = { ...identity, 'x-upstream-host': 'agentrouter.org', 'x-provider': 'agentrouter', 'x-upstream-provider': 'agentrouter', 'x-request-provider': 'agentrouter' };
  const f = await fixture(t, (_req, res) => send(res, 400, error, 'application/json', { 'x-upstream-host': 'agentrouter.org', 'x-upstream-provider': 'agentrouter' }));
  const result = await post(f.address, { headers: spoofed });
  assert.equal(result.status, 400);
  assert.deepEqual(result.bytes, error);
  unchanged(f, raw, '/v1/responses', spoofed);
});

for (const [name, options, status] of [
  ['foreign Host', { headers: { host: 'evil.example' } }, 403],
  ['browser Origin', { headers: { origin: 'https://evil.example' } }, 403],
  ['browser fetch metadata', { headers: { 'sec-fetch-site': 'cross-site' } }, 403],
  ['absolute request URL', { path: 'http://evil.example/v1/responses' }, 404],
  ['arbitrary target query', { path: '/v1/responses?target=evil.example' }, 404],
  ['beta plus target query', { path: '/messages?beta=true&target=evil.example' }, 404]
]) test(`bypass retains loopback and fixed-route guard for ${name}`, async t => {
  const f = await fixture(t, (_req, res) => send(res, 200, '{}'));
  const result = await post(f.address, options);
  assert.equal(result.status, status);
  assert.equal(f.requests.length, 0);
});
