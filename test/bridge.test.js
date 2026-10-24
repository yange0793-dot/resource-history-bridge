'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createBridge } = require('..');

const known = 'The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it.';
const native = {
  model: 'mock-model', stream: true, prompt_cache_key: 'same-cache', session_id: 'same-session',
  input: [
    { type: 'reasoning', id: 'rs-mock', encrypted_content: 'MOCK_ENCRYPTED', summary: [] },
    { type: 'function_call', id: 'fc-mock', call_id: 'call-mock', name: 'add', arguments: '{"a":19,"b":23}' },
    { type: 'function_call_output', call_id: 'call-mock', output: '42' }
  ]
};
const raw = Buffer.from(JSON.stringify(native, null, 2));
const resourceError = JSON.stringify({ error: { message: known, type: 'invalid_request_error' } });
const frame = (type, fields = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const lifecycle = frame('response.created', { response: { id: 'response-mock', status: 'in_progress', output: [] } });
const failed = frame('response.failed', { response: { error: { message: known } } });
const delta = frame('response.output_text.delta', { delta: 'RESULT_42' });

async function fixture(t, handler, options = {}) {
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, body: Buffer.concat(chunks), headers: req.headers });
    handler(req, res, received.length);
  });
  const sockets = new Set();
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const bridge = createBridge({ upstream: `http://127.0.0.1:${upstream.address().port}/v1`, timeoutMs: 2000, ...options });
  const address = await bridge.listen(0);
  t.after(async () => {
    await bridge.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
  });
  return { bridge, address, received, upstream };
}

function request(address, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path: options.path || '/v1/responses', method: options.method || 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer MOCK_KEY', 'x-session-id': 'same-header', ...options.headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(options.body === undefined ? raw : options.body);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'x-mock-upstream': 'yes' });
  res.end(body);
}

test('ordinary request body and identity headers pass unchanged', async t => {
  const f = await fixture(t, (_req, res) => json(res, 200, '{"output":"ok"}'));
  const result = await request(f.address);
  assert.equal(result.status, 200);
  assert.equal(f.received.length, 1);
  assert.deepEqual(f.received[0].body, raw);
  assert.equal(f.received[0].headers.authorization, 'Bearer MOCK_KEY');
  assert.equal(f.received[0].headers['x-session-id'], 'same-header');
  assert.equal(f.received[0].url, '/v1/responses');
});

test('known HTTP400 projects once preserving model/key/session/cache/encrypted/tool data', async t => {
  const f = await fixture(t, (_req, res, number) => json(res, number === 1 ? 400 : 200, number === 1 ? resourceError : '{"output":"RESULT_42"}'));
  const result = await request(f.address);
  assert.equal(result.status, 200);
  assert.equal(f.received.length, 2);
  assert.deepEqual(f.received[0].body, raw);
  const projected = JSON.parse(f.received[1].body);
  const expected = structuredClone(native);
  delete expected.input[0].id;
  delete expected.input[1].id;
  assert.deepEqual(projected, expected);
  assert.equal(f.received[0].headers.authorization, f.received[1].headers.authorization);
  assert.equal(f.received[0].headers['x-session-id'], f.received[1].headers['x-session-id']);
});

for (const [name, status, body] of [
  ['schema 400', 400, '{"error":{"message":"invalid schema"}}'],
  ['authentication', 401, resourceError],
  ['rate limit', 429, resourceError],
  ['server 500', 500, resourceError],
  ['bad JSON', 400, 'not json']
]) {
  test(`does not retry ${name}`, async t => {
    const f = await fixture(t, (_req, res) => json(res, status, body));
    const result = await request(f.address);
    assert.equal(result.status, status);
    assert.equal(result.body, body);
    assert.equal(f.received.length, 1);
  });
}

test('second known error passes unchanged and never sends a third request', async t => {
  const f = await fixture(t, (_req, res) => json(res, 400, resourceError));
  const result = await request(f.address);
  assert.equal(result.status, 400);
  assert.equal(result.body, resourceError);
  assert.equal(result.headers['x-mock-upstream'], 'yes');
  assert.equal(f.received.length, 2);
});

for (const [name, body, code] of [
  ['previous response', { ...native, previous_response_id: 'server' }, 'server_history_reference'],
  ['conversation', { ...native, conversation: 'server' }, 'server_history_reference'],
  ['reference', { ...native, input: [{ type: 'item_reference', id: 'server' }] }, 'item_reference'],
  ['tool pairing', { ...native, input: native.input.slice(0, 2) }, 'invalid_tool_pair'],
  ['unsupported ID', { ...native, input: [...native.input, { type: 'message', id: 'msg-unknown', content: [] }] }, 'unsupported_item_id'],
  ['malformed item', { ...native, input: [...native.input, null] }, 'invalid_history_item']
]) {
  test(`known error clearly refuses unrecoverable ${name}`, async t => {
    const f = await fixture(t, (_req, res) => json(res, 400, resourceError));
    const result = await request(f.address, { body: JSON.stringify(body) });
    assert.equal(result.status, 409);
    assert.equal(JSON.parse(result.body).error.code, code);
    assert.equal(f.received.length, 1);
  });
}

for (const path of ['/v1/responses/compact', '/v1/chat/completions', '/v1/messages']) {
  test(`${path} passes through and never recovers`, async t => {
    const f = await fixture(t, (_req, res) => json(res, 400, resourceError));
    const result = await request(f.address, { path });
    assert.equal(result.status, 400);
    assert.equal(f.received.length, 1);
    assert.equal(f.received[0].url, path);
  });
}

test('SSE empty lifecycle then response.failed recovers before commit', async t => {
  const f = await fixture(t, (_req, res, number) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (number === 2) return res.end(delta);
    res.write(lifecycle.slice(0, 13));
    res.write(lifecycle.slice(13));
    res.end(failed);
  });
  const result = await request(f.address);
  assert.equal(result.body, delta);
  assert.equal(f.received.length, 2);
});

test('HTTP400 SSE known error recovers before commit', async t => {
  const f = await fixture(t, (_req, res, number) => {
    res.writeHead(number === 1 ? 400 : 200, { 'content-type': 'text/event-stream' });
    res.end(number === 1 ? failed : delta);
  });
  const result = await request(f.address);
  assert.equal(result.status, 200);
  assert.equal(result.body, delta);
  assert.equal(f.received.length, 2);
});

test('HTTP400 SSE output blocks recovery', async t => {
  const payload = delta + failed;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(400, { 'content-type': 'text/event-stream' });
    res.end(payload);
  });
  const result = await request(f.address);
  assert.equal(result.status, 400);
  assert.equal(result.body, payload);
  assert.equal(f.received.length, 1);
});

test('HTTP401 SSE known error cannot recover', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(401, { 'content-type': 'text/event-stream' });
    res.end(failed);
  });
  assert.equal((await request(f.address)).body, failed);
  assert.equal(f.received.length, 1);
});

test('SSE known error event can recover without lifecycle frames', async t => {
  const event = frame('error', { message: known });
  const f = await fixture(t, (_req, res, number) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(number === 1 ? event : delta);
  });
  assert.equal((await request(f.address)).body, delta);
  assert.equal(f.received.length, 2);
});

for (const [name, prefix] of [
  ['text delta', delta],
  ['tool delta', frame('response.function_call_arguments.delta', { delta: '{"a":19}' })],
  ['unknown event', frame('new.event', { data: 'unknown' })],
  ['malformed frame', 'data: not-json\n\n'],
  ['unknown bytes', 'unknown raw bytes'],
  ['comment heartbeat', ': ping\n\n'],
  ['lifecycle with output', frame('response.created', { response: { output: [{ type: 'message', content: 'text' }] } })]
]) {
  test(`SSE ${name} commits and blocks recovery`, async t => {
    const payload = lifecycle + prefix + failed;
    const f = await fixture(t, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(payload);
    });
    const result = await request(f.address);
    assert.equal(result.body, payload);
    assert.equal(f.received.length, 1);
  });
}

test('unknown partial bytes immediately commit before a later known error', async t => {
  const prefix = 'garbage';
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(prefix);
    setTimeout(() => res.end(failed), 15);
  });
  assert.equal((await request(f.address)).body, prefix + failed);
  assert.equal(f.received.length, 1);
});

test('SSE lifecycle buffer cap commits instead of allowing retry', async t => {
  const payload = lifecycle + failed;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(payload);
  }, { bufferLimit: 20 });
  assert.equal((await request(f.address)).body, payload);
  assert.equal(f.received.length, 1);
});

test('oversized HTTP400 error buffer is passed through without recovery', async t => {
  const body = JSON.stringify({ error: { message: known }, padding: 'x'.repeat(1000) });
  const f = await fixture(t, (_req, res) => json(res, 400, body), { bufferLimit: 20 });
  assert.equal((await request(f.address)).body, body);
  assert.equal(f.received.length, 1);
});

test('second SSE failure is passed verbatim without third request', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(lifecycle + failed);
  });
  assert.equal((await request(f.address)).body, lifecycle + failed);
  assert.equal(f.received.length, 2);
});

for (const [name, options, status] of [
  ['foreign Host', { headers: { host: 'evil.example' } }, 403],
  ['browser Origin', { headers: { origin: 'https://evil.example' } }, 403],
  ['browser fetch metadata', { headers: { 'sec-fetch-site': 'cross-site' } }, 403],
  ['non JSON', { headers: { 'content-type': 'text/plain' } }, 415],
  ['compressed input', { headers: { 'content-encoding': 'gzip' } }, 415],
  ['invalid JSON', { body: '{' }, 400],
  ['array JSON', { body: '[]' }, 400],
  ['absolute URL', { path: 'http://evil.example/v1/responses' }, 404],
  ['query injection', { path: '/v1/responses?target=evil' }, 404],
  ['unsupported method', { method: 'GET' }, 404]
]) {
  test(`rejects ${name} before contacting upstream`, async t => {
    const f = await fixture(t, (_req, res) => json(res, 200, '{}'));
    assert.equal((await request(f.address, options)).status, status);
    assert.equal(f.received.length, 0);
  });
}

test('request byte cap rejects input without contacting upstream', async t => {
  const f = await fixture(t, (_req, res) => json(res, 200, '{}'), { requestLimit: 10 });
  assert.equal((await request(f.address)).status, 413);
  assert.equal(f.received.length, 0);
});

test('environment-style key override affects both attempts consistently', async t => {
  const f = await fixture(t, (_req, res, number) => json(res, number === 1 ? 400 : 200, number === 1 ? resourceError : '{}'), { apiKey: 'MOCK_CONFIGURED', keyHeader: 'api-key' });
  assert.equal((await request(f.address)).status, 200);
  assert.equal(f.received.length, 2);
  for (const received of f.received) {
    assert.equal(received.headers['api-key'], 'MOCK_CONFIGURED');
    assert.equal(received.headers.authorization, undefined);
  }
});

test('truncated upstream body before commit returns transport error and does not retry', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json', 'content-length': resourceError.length + 10 });
    res.write(resourceError);
    setTimeout(() => res.destroy(), 15);
  });
  const result = await request(f.address);
  assert.equal(result.status, 502);
  assert.equal(f.received.length, 1);
});

test('truncated upstream stream after commit aborts downstream and does not retry', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(delta);
    setTimeout(() => res.destroy(), 15);
  });
  await assert.rejects(request(f.address));
  assert.equal(f.received.length, 1);
});

test('total timeout closes stalled upstream without retry', async t => {
  let closed;
  const closedPromise = new Promise(resolve => { closed = resolve; });
  const f = await fixture(t, (req, res) => { res.on('close', closed); }, { timeoutMs: 40 });
  const result = await request(f.address);
  assert.equal(result.status, 504);
  await closedPromise;
  assert.equal(f.received.length, 1);
});

test('client cancellation cleans upstream and does not retry', async t => {
  let started;
  let closed;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const closedPromise = new Promise(resolve => { closed = resolve; });
  const f = await fixture(t, (_req, res) => { res.on('close', closed); started(); });
  const req = http.request({ hostname: '127.0.0.1', port: f.address.port, path: '/v1/responses', method: 'POST', headers: { 'content-type': 'application/json' } });
  req.on('error', () => {});
  req.end(raw);
  await startedPromise;
  req.destroy();
  await closedPromise;
  assert.equal(f.received.length, 1);
});

for (const [name, body] of [
  ['bare message', JSON.stringify({ message: known })],
  ['ordinary delta', JSON.stringify({ type: 'response.output_text.delta', delta: known })],
  ['unknown envelope field', JSON.stringify({ error: { message: known }, surprise: 'unknown' })],
  ['unknown error field', JSON.stringify({ error: { message: known, surprise: 'unknown' } })],
  ['body output', JSON.stringify({ error: { message: known }, output: [{ type: 'message' }] })]
]) {
  test(`HTTP400 ${name} is relayed without retry`, async t => {
    const f = await fixture(t, (_req, res) => json(res, 400, body));
    assert.equal((await request(f.address)).body, body);
    assert.equal(f.received.length, 1);
  });
}

for (const [name, payload] of [
  ['delta quotes exact error', frame('response.output_text.delta', { delta: known })],
  ['unknown failed event field', frame('response.failed', { surprise: 'unknown', response: { error: { message: known } } })],
  ['unknown failed response field', frame('response.failed', { response: { surprise: 'unknown', error: { message: known } } })],
  ['unknown error object field', frame('error', { message: known, surprise: 'unknown' })]
]) {
  test(`SSE ${name} is relayed without retry`, async t => {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(payload);
    });
    assert.equal((await request(f.address)).body, payload);
    assert.equal(f.received.length, 1);
  });
}

test('SSE event:error without payload type remains a valid error envelope', async t => {
  const payload = `event: error\ndata: ${JSON.stringify({ message: known, code: null })}\n\n`;
  const f = await fixture(t, (_req, res, number) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(number === 1 ? payload : delta);
  });
  assert.equal((await request(f.address)).body, delta);
  assert.equal(f.received.length, 2);
});

test('SSE failure carrying output cannot be treated as output-free error', async t => {
  const payload = frame('response.failed', { response: { error: { message: known }, output: [{ type: 'message', content: 'semantic' }] } });
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(payload);
  });
  assert.equal((await request(f.address)).body, payload);
  assert.equal(f.received.length, 1);
});

test('SSE failed frame with trailing unknown bytes is committed without retry', async t => {
  const payload = failed + 'unrecognized trailing bytes';
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(payload);
  });
  assert.equal((await request(f.address)).body, payload);
  assert.equal(f.received.length, 1);
});

test('normal EOF with an incomplete SSE frame is relayed without retry', async t => {
  const payload = lifecycle + 'data: {"type":"response.output_text.delta"';
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(payload);
  });
  assert.equal((await request(f.address)).body, payload);
  assert.equal(f.received.length, 1);
});

test('upstream compressed error is not inspected or retried', async t => {
  const compressed = require('node:zlib').gzipSync(resourceError);
  const f = await fixture(t, (_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(compressed);
  });
  const result = await request(f.address);
  assert.equal(result.status, 400);
  assert.equal(result.headers['content-encoding'], 'gzip');
  assert.equal(f.received.length, 1);
});

test('total deadline is shared across initial and recovery attempts', async t => {
  const f = await fixture(t, (_req, res, number) => {
    if (number === 1) setTimeout(() => json(res, 400, resourceError), 40);
    else setTimeout(() => json(res, 200, '{}'), 55);
  }, { timeoutMs: 70 });
  const result = await request(f.address);
  assert.equal(result.status, 504);
  assert.equal(f.received.length, 2);
});

test('upstream connection refusal returns 502 without retry', async t => {
  const f = await fixture(t, (_req, res) => json(res, 200, '{}'));
  await new Promise(resolve => f.upstream.close(resolve));
  const result = await request(f.address);
  assert.equal(result.status, 502);
  assert.equal(f.received.length, 0);
});

test('closing bridge aborts all active upstreams and client sockets', async t => {
  let started;
  let closed;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const closedPromise = new Promise(resolve => { closed = resolve; });
  const f = await fixture(t, (_req, res) => { res.on('close', closed); started(); });
  const client = request(f.address);
  const rejected = assert.rejects(client);
  await startedPromise;
  await f.bridge.close();
  await rejected;
  await closedPromise;
  assert.equal(f.received.length, 1);
});

test('rejects non-loopback binding and unsafe upstream URLs', () => {
  for (const options of [
    { upstream: 'http://example.com/v1', host: '0.0.0.0' },
    { upstream: 'http://user:password@example.com/v1' },
    { upstream: 'http://example.com/v1?key=secret' },
    { upstream: 'http://example.com/v1#fragment' },
    { upstream: 'file:///tmp/local' },
    { upstream: 'http://example.com/v1', bufferLimit: 65537 },
    { upstream: 'http://example.com/v1', apiKey: 'MOCK\r\nINJECTION' }
  ]) assert.throws(() => createBridge(options));
});
