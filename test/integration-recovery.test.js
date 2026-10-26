'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createBridge } = require('../lib/bridge');
const { mockAgentRouter } = require('../scripts/mock-agentrouter.cjs');

const known = 'The requested item was created under a different Azure OpenAI resource.';
const resource = JSON.stringify({ error: { type: 'invalid_request_error', message: known } });
const frame = (type, fields = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const lifecycle = frame('response.created', { response: { status: 'in_progress', output: [] } });
const emptyFailed = frame('response.failed', { response: { status: 'failed', output: [], error: null } });
const emptyCompleted = frame('response.completed', { response: { status: 'completed', output: [] } });
const success = frame('response.completed', { response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] } });
const history = {
  model: 'test', stream: true, prompt_cache_key: 'same-cache', session_id: 'same-session',
  input: [
    { type: 'reasoning', id: 'rs-test', encrypted_content: 'ENCRYPTED', summary: [] },
    { type: 'function_call', id: 'fc-test', call_id: 'call-test', name: 'add', arguments: '{"a":1}' },
    { type: 'function_call_output', call_id: 'call-test', output: '1' }
  ]
};
const raw = Buffer.from(JSON.stringify(history, null, 2));

async function fixture(t, handler, options = {}) {
  const requests = [];
  const sockets = new Set();
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ bytes: Buffer.concat(chunks), headers: req.headers, path: req.url });
    handler(req, res, requests.length);
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(mockAgentRouter(upstream.address().port));
  const bridge = createBridge({
    upstream: 'https://agentrouter.org/v1', timeoutMs: 2000,
    historyMode: 'harness', retryDelayMs: 0, retryJitterRatio: 0, ...options
  });
  const address = await bridge.listen(0);
  t.after(async () => {
    await bridge.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
  });
  return { requests, address, bridge, upstream };
}

function post(address, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path: options.path || '/v1/responses', method: 'POST', headers: {
      'content-type': 'application/json', authorization: 'Bearer TEST', 'x-session-id': 'same-header', 'x-cache-key': 'same-header-cache', ...options.headers
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks), text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(options.body === undefined ? raw : options.body);
  });
}

function send(res, status, text, type = 'application/json', headers = {}) {
  res.writeHead(status, { 'content-type': type, 'x-original-error': 'preserved', ...headers });
  res.end(text);
}

for (const status of [408, 429, 500, 503]) test(`HTTP ${status} retries exactly three attempts, preserving bytes/cache identity and final headers`, async t => {
  const original = JSON.stringify({ error: { type: status === 429 ? 'rate_limit_error' : 'server_error', message: 'Retry later.' } });
  const f = await fixture(t, (_req, res) => send(res, status, original, 'application/json', { 'retry-after': '0', 'content-length': Buffer.byteLength(original) }));
  const result = await post(f.address);
  assert.equal(f.requests.length, 3);
  assert.equal(result.status, status);
  assert.equal(result.text, original);
  assert.equal(result.headers['x-original-error'], 'preserved');
  assert.equal(result.headers['content-length'], String(Buffer.byteLength(original)));
  for (const entry of f.requests) {
    assert.deepEqual(entry.bytes, raw);
    assert.equal(entry.headers.authorization, 'Bearer TEST');
    assert.equal(entry.headers['x-session-id'], 'same-header');
    assert.equal(entry.headers['x-cache-key'], 'same-header-cache');
  }
});

for (const terminal of [emptyFailed, emptyCompleted]) test(`verified ${terminal.includes('response.failed') ? 'failed' : 'completed'} empty terminal recovers without leaking metadata`, async t => {
  const f = await fixture(t, (_req, res, n) => send(res, 200, n < 3 ? lifecycle + terminal : success, 'text/event-stream'));
  const result = await post(f.address);
  assert.equal(result.text, success);
  assert.equal(f.requests.length, 3);
  for (const entry of f.requests) assert.deepEqual(entry.bytes, raw);
});

for (const terminal of [emptyFailed, emptyCompleted]) test('exhausted empty terminal relays exact original SSE and status', async t => {
  const original = lifecycle + terminal;
  const f = await fixture(t, (_req, res) => send(res, 200, original, 'text/event-stream'));
  const result = await post(f.address);
  assert.equal(result.status, 200);
  assert.equal(result.text, original);
  assert.equal(f.requests.length, 3);
});

test('strict HTTP400 with SSE headers and JSON body projects once across repeated resource failures', async t => {
  const f = await fixture(t, (_req, res, n) => send(res, n < 4 ? 400 : 200, n < 4 ? ' \t\r\n' + resource : success, 'text/event-stream'), { resourceAttempts: 4 });
  assert.equal((await post(f.address)).text, success);
  assert.equal(f.requests.length, 4);
  assert.deepEqual(f.requests[0].bytes, raw);
  const expected = structuredClone(history);
  delete expected.input[0].id;
  delete expected.input[1].id;
  assert.deepEqual(JSON.parse(f.requests[1].bytes), expected);
  for (const entry of f.requests.slice(1)) assert.deepEqual(entry.bytes, f.requests[1].bytes);
  assert.deepEqual(history.input[0].id, 'rs-test');
});

test('strict resource budget defaults to ten total calls and preserves final failure', async t => {
  const f = await fixture(t, (_req, res) => send(res, 400, resource));
  const result = await post(f.address);
  assert.equal(f.requests.length, 10);
  assert.equal(result.status, 400);
  assert.equal(result.text, resource);
});

test('mixed recovery categories share total budget without losing projection', async t => {
  const f = await fixture(t, (_req, res, n) => n === 1 ? send(res, 503, '{"error":{"type":"server_error"}}') : send(res, 400, resource), { totalAttempts: 4 });
  assert.equal((await post(f.address)).text, resource);
  assert.equal(f.requests.length, 4);
  assert.deepEqual(f.requests[0].bytes, f.requests[1].bytes);
  assert.equal(Object.hasOwn(JSON.parse(f.requests[2].bytes).input[0], 'id'), false);
  assert.deepEqual(f.requests[2].bytes, f.requests[3].bytes);
});

for (const enabled of [undefined, false, true]) test(`generic400Projection=${enabled} is explicitly scoped and at most one retry`, async t => {
  const error = '{"error":{"type":"invalid_request_error","message":"Bad request."}}';
  const f = await fixture(t, (_req, res) => send(res, 400, error), { generic400Projection: enabled });
  const result = await post(f.address);
  assert.equal(result.text, error);
  assert.equal(f.requests.length, enabled !== false ? 2 : 1);
  if (enabled !== false) assert.equal(Object.hasOwn(JSON.parse(f.requests[1].bytes).input[0], 'id'), false);
});

for (const error of [
  { type: 'authentication_error', message: 'Invalid credentials.' },
  { code: 'invalid_tool_schema', message: 'Bad tool.' },
  { message: 'Expected input to be an array.' },
  { code: 'content_filter', message: 'Blocked.' },
  { code: 'permission_denied' }
]) test(`generic400 cannot replay ${JSON.stringify(error)}`, async t => {
  const original = JSON.stringify({ error });
  const f = await fixture(t, (_req, res) => send(res, 400, original), { generic400Projection: true });
  assert.equal((await post(f.address)).text, original);
  assert.equal(f.requests.length, 1);
});

for (const body of [
  { ...history, input: 'hello' },
  { ...history, previous_response_id: 'server' },
  { ...history, input: history.input.slice(0, 2) },
  { ...history, input: [{ type: 'item_reference', id: 'opaque' }] }
]) test('invalid/incomplete full-copy projection preserves actual upstream 400', async t => {
  const f = await fixture(t, (_req, res) => send(res, 400, resource), { generic400Projection: true });
  const result = await post(f.address, { body: JSON.stringify(body) });
  assert.equal(result.status, 400);
  assert.equal(result.text, resource);
  assert.equal(f.requests.length, 1);
});

test('portable projects first outgoing request only when safely possible', async t => {
  const f = await fixture(t, (_req, res) => send(res, 200, success, 'text/event-stream'), { historyStrategy: 'portable' });
  await post(f.address);
  assert.equal(Object.hasOwn(JSON.parse(f.requests[0].bytes).input[0], 'id'), false);
  const unsupported = Buffer.from(JSON.stringify({ ...history, previous_response_id: 'server' }));
  await post(f.address, { body: unsupported });
  assert.deepEqual(f.requests[1].bytes, unsupported);
});

for (const prefix of [
  frame('response.output_text.delta', { delta: ' ' }),
  frame('response.reasoning_text.delta', { delta: '\n' }),
  frame('response.reasoning_summary_text.delta', { delta: '\t' }),
  frame('response.output_item.added', { item: { type: 'function_call', name: 'Read', call_id: 'c', arguments: '' } }),
  frame('response.function_call_arguments.delta', { delta: ' ' }),
  frame('future.event', { payload: 'unknown' }),
  'unknown raw bytes',
  ': ping\n\n'
]) test('any output/unknown bytes block retry even when followed by empty or overload failure', async t => {
  const original = lifecycle + prefix + emptyFailed;
  const f = await fixture(t, (_req, res) => send(res, 200, original, 'text/event-stream'));
  assert.equal((await post(f.address)).text, original);
  assert.equal(f.requests.length, 1);
});

for (const output of [
  { status: 'completed', output: [], output_text: ' ' },
  { status: 'failed', error: { code: 'overloaded_error' }, output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: '\n' }] }] },
  { status: 'failed', error: { code: 'server_error' }, output: [{ type: 'function_call', name: 'Read', arguments: '' }] },
  { status: 'completed', output: [], future_output: 'unknown' }
]) test('terminal JSON output/unknown content is never replayed', async t => {
  const original = JSON.stringify(output);
  const f = await fixture(t, (_req, res) => send(res, 200, original));
  assert.equal((await post(f.address)).text, original);
  assert.equal(f.requests.length, 1);
});

test('metadata-only pre-output disconnect recovers and drops old metadata', async t => {
  const f = await fixture(t, (_req, res, n) => {
    if (n === 2) return send(res, 200, success, 'text/event-stream');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(lifecycle);
    setTimeout(() => res.destroy(), 5);
  });
  assert.equal((await post(f.address)).text, success);
  assert.equal(f.requests.length, 2);
});

test('partial/unknown frame disconnect does not replay possibly generated bytes', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(lifecycle + 'data: {"type":"response.output_text.delta","delta":"');
    setTimeout(() => res.destroy(), 5);
  });
  await assert.rejects(post(f.address));
  assert.equal(f.requests.length, 1);
});

test('disconnect after output does not issue another call', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame('response.output_text.delta', { delta: ' ' }));
    setTimeout(() => res.destroy(), 5);
  });
  await assert.rejects(post(f.address));
  assert.equal(f.requests.length, 1);
});

test('pre-header transport failures exhaust transient budget with local502', async t => {
  const f = await fixture(t, (req) => req.socket.destroy());
  const result = await post(f.address);
  assert.equal(result.status, 502);
  assert.equal(JSON.parse(result.text).error.code, 'upstream_transport');
  assert.equal(f.requests.length, 3);
});

test('Retry-After respects longest server hint via injected clock/sleep', async t => {
  let now = 1000;
  const delays = [];
  const f = await fixture(t, (_req, res, n) => n === 1
    ? send(res, 429, '{"error":{"type":"rate_limit_error"}}', 'application/json', { 'Retry-After': '4', 'x-ms-retry-after-ms': '5000' })
    : send(res, 200, success, 'text/event-stream'), {
    timeoutMs: 15000, now: () => now, random: () => 0,
    sleep: async (ms, signal) => { assert.equal(signal.aborted, false); delays.push(ms); now += ms; }
  });
  assert.equal((await post(f.address)).text, success);
  assert.deepEqual(delays, [5000]);
  assert.equal(f.requests.length, 2);
});

test('Retry-After exceeding deadline immediately relays actual error', async t => {
  const original = '{"error":{"type":"rate_limit_error"}}';
  const f = await fixture(t, (_req, res) => send(res, 429, original, 'application/json', { 'retry-after': '10' }), { timeoutMs: 40 });
  const result = await post(f.address);
  assert.equal(result.status, 429);
  assert.equal(result.text, original);
  assert.equal(f.requests.length, 1);
});

test('injected sleep cannot bypass shared deadline or cancellation', async t => {
  let sleeping;
  const started = new Promise(resolve => { sleeping = resolve; });
  const f = await fixture(t, (_req, res) => send(res, 503, '{"error":{"type":"server_error"}}'), {
    timeoutMs: 40, sleep: () => { sleeping(); return new Promise(() => {}); }
  });
  const request = post(f.address);
  await started;
  const result = await request;
  assert.equal(result.status, 503);
  assert.equal(f.requests.length, 1);
});

test('request body read consumes the same deadline before any upstream call', async t => {
  const f = await fixture(t, (_req, res) => send(res, 200, success, 'text/event-stream'), { timeoutMs: 40 });
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: f.address.port, path: '/v1/responses', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write('{');
  });
  assert.equal(result, 504);
  assert.equal(f.requests.length, 0);
});

test('client cancellation aborts retry sleep without another upstream call', async t => {
  let sleeping, signal;
  const started = new Promise(resolve => { sleeping = resolve; });
  const f = await fixture(t, (_req, res) => send(res, 503, '{"error":{"type":"server_error"}}'), {
    sleep: (_ms, supplied) => { signal = supplied; sleeping(); return new Promise(() => {}); }
  });
  const req = http.request({ hostname: '127.0.0.1', port: f.address.port, path: '/v1/responses', method: 'POST', headers: { 'content-type': 'application/json' } });
  req.on('error', () => {});
  req.end(raw);
  await started;
  req.destroy();
  await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(f.requests.length, 1);
});

for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses/compact']) test(`${path} remains byte preserving and cannot project Responses IDs`, async t => {
  const f = await fixture(t, (_req, res) => send(res, 400, resource), { generic400Projection: true });
  assert.equal((await post(f.address, { path })).text, resource);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].bytes, raw);
});

for (const stream of [true, false]) test(`explicitly opted-in Messages conversion participates in pre-output recovery (stream=${stream})`, async t => {
  const f = await fixture(t, (_req, res, n) => send(res, 200, n === 1 ? emptyFailed : success, 'text/event-stream'), { upstreamProtocol: 'responses', automaticRecovery: true });
  const result = await post(f.address, { path: '/v1/messages?beta=true', body: JSON.stringify({ model: 'test', stream, max_tokens: 20, messages: [{ role: 'user', content: 'hello' }] }) });
  assert.equal(result.status, 200);
  assert.match(result.text, /OK/);
  if (stream) assert.equal((result.text.match(/event: message_start/g) || []).length, 1);
  else assert.equal(JSON.parse(result.text).content[0].text, 'OK');
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0].bytes, f.requests[1].bytes);
});

test('Messages conversion preserves real JSON error payload with SSE content type', async t => {
  const original = '{"error":{"type":"invalid_request_error","message":"summary is required"}}';
  const f = await fixture(t, (_req, res) => send(res, 400, original, 'text/event-stream'), { upstreamProtocol: 'responses' });
  const result = await post(f.address, { path: '/v1/messages', body: JSON.stringify({ model: 'test', max_tokens: 20, messages: [{ role: 'user', content: 'hello' }] }) });
  assert.equal(result.status, 400);
  assert.equal(result.text, original);
  assert.match(result.headers['content-type'], /application\/json/);
  assert.equal(f.requests.length, 1);
});

test('buffer overflow commits metadata and prevents replay', async t => {
  const original = lifecycle + emptyFailed;
  const f = await fixture(t, (_req, res) => send(res, 200, original, 'text/event-stream'), { bufferLimit: 20 });
  assert.equal((await post(f.address)).text, original);
  assert.equal(f.requests.length, 1);
});

for (const status of [401, 403, 422]) test(`HTTP ${status} never retries even with a server error label`, async t => {
  const original = '{"error":{"type":"server_error","message":"Retry later."}}';
  const f = await fixture(t, (_req, res) => send(res, status, original));
  assert.equal((await post(f.address)).text, original);
  assert.equal(f.requests.length, 1);
});

for (const payload of [emptyCompleted, emptyFailed]) test('optional DONE does not overwrite recoverable terminal evidence', async t => {
  const f = await fixture(t, (_req, res, n) => send(res, 200, n === 1 ? payload + 'data: [DONE]\n\n' : success, 'text/event-stream'));
  assert.equal((await post(f.address)).text, success);
  assert.equal(f.requests.length, 2);
});

for (const payload of [
  { status: 'failed', error: null, output: [] },
  { status: 'completed', output: [] },
  { type: 'error', error: { type: 'overloaded_error', message: 'Capacity unavailable.' } }
]) test('verified JSON empty/overload errors share transient recovery policy', async t => {
  const f = await fixture(t, (_req, res, n) => send(res, 200, n === 1 ? JSON.stringify(payload) : '{"status":"completed","output":[],"output_text":"OK"}'));
  assert.equal(JSON.parse((await post(f.address)).text).output_text, 'OK');
  assert.equal(f.requests.length, 2);
});

for (const type of ['text/plain', 'application/octet-stream']) test(`HTTP400 ${type} is not treated as a JSON resource error`, async t => {
  const f = await fixture(t, (_req, res) => send(res, 400, resource, type), { generic400Projection: true });
  assert.equal((await post(f.address)).text, resource);
  assert.equal(f.requests.length, 1);
});

test('partial terminal SSE frames pass unchanged without replay', async t => {
  for (const original of [lifecycle + 'data: {"type":"response.failed"']) {
    const f = await fixture(t, (_req, res) => send(res, 200, original, 'text/event-stream'));
    assert.equal((await post(f.address)).text, original);
    assert.equal(f.requests.length, 1);
  }
});

test('compressed upstream error is never decoded or retried', async t => {
  const original = require('node:zlib').gzipSync(resource);
  const f = await fixture(t, (_req, res) => send(res, 400, original, 'text/event-stream', { 'content-encoding': 'gzip' }));
  const result = await post(f.address);
  assert.deepEqual(result.bytes, original);
  assert.equal(result.headers['content-encoding'], 'gzip');
  assert.equal(f.requests.length, 1);
});

for (const stream of [true, false]) test(`Messages JSON conversion keeps terminal-only tools/text (stream=${stream})`, async t => {
  const output = [
    { type: 'reasoning', summary: [], encrypted_content: 'OPAQUE_NOT_SIGNATURE' },
    { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'ready' }] },
    { type: 'function_call', call_id: 'call-native', name: 'Read', arguments: '{"file_path":"/tmp/x"}' }
  ];
  const f = await fixture(t, (_req, res) => send(res, 200, JSON.stringify({ status: 'completed', output })), { upstreamProtocol: 'responses' });
  const result = await post(f.address, { path: '/v1/messages', body: JSON.stringify({ model: 'test', stream, max_tokens: 20, messages: [{ role: 'user', content: 'hello' }] }) });
  assert.equal(result.status, 200);
  assert.match(result.text, /ready/);
  assert.match(result.text, /call-native/);
  assert.doesNotMatch(result.text, /OPAQUE_NOT_SIGNATURE/);
  assert.equal(f.requests.length, 1);
});

test('Messages tool args observed before renderer output prevent retry', async t => {
  const original = frame('response.function_call_arguments.delta', { item_id: 'f', output_index: 0, delta: '{"file_path":' }) + emptyFailed;
  const f = await fixture(t, (_req, res) => send(res, 200, original, 'text/event-stream'), { upstreamProtocol: 'responses' });
  const result = await post(f.address, { path: '/v1/messages', body: JSON.stringify({ model: 'test', stream: true, max_tokens: 20, messages: [{ role: 'user', content: 'hello' }] }) });
  assert.match(result.text, /event: error/);
  assert.equal(f.requests.length, 1);
});

test('diagnostics events correlate attempts without exposing source payloads', async t => {
  const events = [];
  const f = await fixture(t, (_req, res, n) => send(res, n === 1 ? 400 : 200, n === 1 ? resource : success, n === 1 ? 'application/json' : 'text/event-stream'), {
    diagnostics: { enabled: true, onEvent: event => events.push(event) }
  });
  assert.equal((await post(f.address)).text, success);
  const attempts = events.filter(event => event.type === 'attempt_start');
  assert.deepEqual(attempts.map(event => event.attempt), [1, 2]);
  assert.equal(attempts[0].requestId, attempts[1].requestId);
  assert.notEqual(attempts[0].attemptId, attempts[1].attemptId);
  assert.equal(events.filter(event => event.type === 'attempt_result').length, 2);
  const serialized = JSON.stringify(events);
  for (const secret of ['ENCRYPTED', 'same-cache', 'same-session', 'same-header', 'Bearer TEST', 'call-test', known]) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(attempts[0].request.resourceItemIdCount, 2);
  assert.equal(attempts[1].request.resourceItemIdCount, 0);
});

test('Messages JSON empty completion over buffer limit is converted once without replay', async t => {
  const f = await fixture(t, (_req, res) => send(res, 200, '{"status":"completed","output":[]}'), { upstreamProtocol: 'responses', bufferLimit: 10 });
  const result = await post(f.address, { path: '/v1/messages', body: JSON.stringify({ model: 'test', stream: false, max_tokens: 20, messages: [{ role: 'user', content: 'hello' }] }) });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.text).content, []);
  assert.equal(f.requests.length, 1);
});

for (const mode of ['minimal', 'codex']) test(`${mode} default keeps transient/empty recovery disabled`, async t => {
  for (const [status, original, type] of [[429, '{"error":{"type":"rate_limit_error"}}', 'application/json'], [200, emptyCompleted, 'text/event-stream']]) {
    const f = await fixture(t, (_req, res) => send(res, status, original, type), { historyMode: mode });
    assert.equal((await post(f.address)).text, original);
    assert.equal(f.requests.length, 1);
  }
});

test('explicit automaticRecovery enables bounded recovery outside Harness', async t => {
  const f = await fixture(t, (_req, res, n) => send(res, 200, n === 1 ? emptyFailed : success, 'text/event-stream'), { historyMode: 'minimal', automaticRecovery: true });
  assert.equal((await post(f.address)).text, success);
  assert.equal(f.requests.length, 2);
});

test('legacy non-Harness configuration preserves wider Azure retry bounds', async t => {
  const f = await fixture(t, (_req, res) => send(res, 200, '{"output":"ok"}'), { historyMode: 'minimal', timeoutMs: 1800000, resourceAttempts: 100, retryDelayMs: 60000 });
  assert.equal((await post(f.address)).status, 200);
  assert.equal(f.requests.length, 1);
});

test('retry that stalls under shared deadline does not relay an older attempt', async t => {
  const f = await fixture(t, (_req, res, n) => { if (n === 1) send(res, 503, '{"error":{"type":"server_error"}}'); }, { timeoutMs: 45 });
  const result = await post(f.address);
  assert.equal(result.status, 504);
  assert.equal(f.requests.length, 2);
});

test('explicit SSE authentication followed by disconnect never becomes transient retry', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(frame('response.failed', { response: { status: 'failed', output: [], error: { code: 'invalid_api_key' } } }));
    setTimeout(() => res.destroy(), 5);
  });
  await assert.rejects(post(f.address));
  assert.equal(f.requests.length, 1);
});

for (const path of ['/v1/messages', '/v1/chat/completions', '/v1/responses/compact']) test(`Harness launcher keeps ${path} automatic recovery disabled`, async t => {
  for (const [status, original, type] of [[429, '{"error":{"type":"rate_limit_error"}}', 'application/json'], [200, emptyCompleted, 'text/event-stream']]) {
    const f = await fixture(t, (_req, res) => send(res, status, original, type));
    assert.equal((await post(f.address, { path })).text, original);
    assert.equal(f.requests.length, 1);
  }
});

test('Harness Messages conversion keeps empty terminal single-attempt semantics', async t => {
  const f = await fixture(t, (_req, res) => send(res, 200, emptyCompleted, 'text/event-stream'), { upstreamProtocol: 'responses' });
  const result = await post(f.address, { path: '/v1/messages', body: JSON.stringify({ model: 'test', stream: false, max_tokens: 20, messages: [{ role: 'user', content: 'hello' }] }) });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.text).content, []);
  assert.equal(f.requests.length, 1);
});

for (const status of [429, 503]) test(`HTTP ${status} mislabeled JSON with SSE headers recovers after complete body`, async t => {
  const original = JSON.stringify({ error: { type: status === 429 ? 'rate_limit_error' : 'server_error', message: 'Retry later.' } });
  const f = await fixture(t, (_req, res, n) => send(res, n === 1 ? status : 200, n === 1 ? ' \t\r\n' + original : success, 'text/event-stream'));
  assert.equal((await post(f.address)).text, success);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0].bytes, f.requests[1].bytes);
});

for (const status of [429, 503]) test(`HTTP ${status} mislabeled JSON final failure retains exact headers and bytes`, async t => {
  const original = '{"error":{"message":"Retry later."}}';
  const f = await fixture(t, (_req, res) => send(res, status, original, 'text/event-stream'));
  const result = await post(f.address);
  assert.equal(result.status, status);
  assert.equal(result.text, original);
  assert.equal(result.headers['content-type'], 'text/event-stream');
  assert.equal(f.requests.length, 3);
});

for (const original of ['unknown error bytes', '{"error":broken']) test('nonJSON SSE error body remains conservative no-retry boundary', async t => {
  const f = await fixture(t, (_req, res) => send(res, 503, original, 'text/event-stream'));
  assert.equal((await post(f.address)).text, original);
  assert.equal(f.requests.length, 1);
});

test('terminal failure with delayed unknown trailing bytes never retries', async t => {
  const original = emptyFailed + 'unknown tail';
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(emptyFailed);
    setTimeout(() => res.end('unknown tail'), 5);
  });
  assert.equal((await post(f.address)).text, original);
  assert.equal(f.requests.length, 1);
});
