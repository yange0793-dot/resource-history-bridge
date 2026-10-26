'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createBridge } = require('../lib/bridge');
const { mockAgentRouter } = require('../scripts/mock-agentrouter.cjs');

const frame = payload => `data: ${JSON.stringify(payload)}\n\n`;
const lifecycle = frame({ type: 'response.created', response: { status: 'in_progress', output: [] } });
const completed = frame({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] } });
const raw = Buffer.from(JSON.stringify({
  model: 'test', stream: true, prompt_cache_key: 'same-cache', reasoning: { effort: 'low' },
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]
}, null, 2));

async function fixture(t, handler, options = {}) {
  const requests = [];
  const sockets = new Set();
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ bytes: Buffer.concat(chunks), headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-original-attempt': String(requests.length) });
    res.end(handler(requests.length));
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(mockAgentRouter(upstream.address().port));
  const bridge = createBridge({
    upstream: 'https://agentrouter.org/v1', historyMode: 'harness',
    timeoutMs: 2000, retryDelayMs: 0, retryJitterRatio: 0, ...options
  });
  const address = await bridge.listen(0);
  t.after(async () => {
    await bridge.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
  });
  return { requests, address };
}

function post(address, path = '/v1/responses') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path, method: 'POST', headers: {
      'content-type': 'application/json', authorization: 'Bearer TEST', session_id: 'same-session'
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(raw);
  });
}

function preserved(requests) {
  for (const request of requests) {
    assert.deepEqual(request.bytes, raw);
    assert.equal(request.headers.authorization, 'Bearer TEST');
    assert.equal(request.headers.session_id, 'same-session');
  }
}

for (const prefix of ['', lifecycle]) {
  test(`Harness ${prefix ? 'metadata-only' : 'empty'} clean SSE EOF recovers within the transient budget`, async t => {
    const f = await fixture(t, n => n < 3 ? prefix : completed);
    const result = await post(f.address);
    assert.equal(f.requests.length, 3);
    assert.equal(result.text, completed);
    assert.equal(result.headers['x-original-attempt'], '3');
    preserved(f.requests);
  });

  test(`Harness exhausted ${prefix ? 'metadata-only' : 'empty'} EOF returns the last original stream`, async t => {
    const f = await fixture(t, () => prefix);
    const result = await post(f.address);
    assert.equal(f.requests.length, 3);
    assert.equal(result.status, 200);
    assert.equal(result.text, prefix);
    assert.equal(result.headers['x-original-attempt'], '3');
    preserved(f.requests);
  });
}

for (const error of [
  { code: 'rate_limit_exceeded', message: 'Rate limit reached.' },
  { type: 'server_error', message: 'Backend temporarily unavailable.' }
]) {
  test(`unnamed SSE error envelope ${error.code || error.type} recovers without changing bytes`, async t => {
    const original = lifecycle + frame({ error });
    const f = await fixture(t, n => n === 1 ? original : completed);
    const result = await post(f.address);
    assert.equal(f.requests.length, 2);
    assert.equal(result.text, completed);
    preserved(f.requests);
  });

  test(`unnamed SSE error envelope ${error.code || error.type} retains its last original error`, async t => {
    const original = lifecycle + frame({ error });
    const f = await fixture(t, () => original);
    const result = await post(f.address);
    assert.equal(f.requests.length, 3);
    assert.equal(result.text, original);
    assert.equal(result.headers['x-original-attempt'], '3');
  });
}

for (const payload of [
  { error: { code: 'invalid_api_key' } },
  { error: { code: 'invalid_tool_schema' } },
  { error: { code: 'content_filter' } },
  { error: { code: 'permission_denied' } },
  { error: { code: 'rate_limit_exceeded' }, output: 'unrecognized generated content' }
]) test('unnamed terminal/unknown SSE error envelopes are never retried', async t => {
  const original = frame(payload);
  const f = await fixture(t, () => original);
  assert.equal((await post(f.address)).text, original);
  assert.equal(f.requests.length, 1);
});

for (const prefix of [
  frame({ type: 'response.output_text.delta', delta: ' ' }),
  frame({ type: 'response.reasoning_text.delta', delta: '\n' }),
  frame({ type: 'response.output_item.added', item: { type: 'function_call', name: 'Read', call_id: 'call', arguments: '' } }),
  frame({ type: 'response.future_event', value: 'unknown' }),
  ': ping\n\n',
  'data: {"type":"response.output_text.delta","delta":"'
]) test('output/unknown/partial SSE before clean EOF remains an exact no-replay barrier', async t => {
  const original = lifecycle + prefix;
  const f = await fixture(t, () => original);
  assert.equal((await post(f.address)).text, original);
  assert.equal(f.requests.length, 1);
});

for (const mode of ['minimal', 'codex']) test(`${mode} clean EOF and unnamed SSE error keep single-attempt defaults`, async t => {
  for (const original of ['', lifecycle, frame({ error: { code: 'rate_limit_exceeded' } })]) {
    const f = await fixture(t, () => original, { historyMode: mode });
    assert.equal((await post(f.address)).text, original);
    assert.equal(f.requests.length, 1);
  }
});

for (const path of ['/v1/messages', '/v1/chat/completions', '/v1/responses/compact']) test(`Harness ${path} clean EOF stays outside native Responses recovery`, async t => {
  const f = await fixture(t, () => '');
  assert.equal((await post(f.address, path)).text, '');
  assert.equal(f.requests.length, 1);
});
