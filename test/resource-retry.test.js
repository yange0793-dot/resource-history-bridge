'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createBridge } = require('..');

const known = 'The requested item was created under a different Azure OpenAI resource.';
const error = JSON.stringify({ error: { type: 'invalid_request_error', message: known } });
const frame = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const success = frame('response.completed', { response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'RESULT_42' }] }] } });
const history = { model: 'mock', stream: true, prompt_cache_key: 'same', input: [
  { type: 'reasoning', id: 'rs_mock', summary: [], encrypted_content: 'MOCK_OPAQUE' },
  { type: 'function_call', id: 'fc_mock', call_id: 'call_mock', name: 'add', arguments: '{"a":19,"b":23}' },
  { type: 'function_call_output', call_id: 'call_mock', output: '42' }
] };

async function fixture(t, handler, options = {}) {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ bytes: Buffer.concat(chunks), auth: req.headers.authorization });
    handler(res, requests.length);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const bridge = createBridge({ upstream: `http://127.0.0.1:${upstream.address().port}/v1`, resourceAttempts: 4, retryDelayMs: 0, timeoutMs: 2000, ...options });
  const address = await bridge.listen(0);
  t.after(async () => {
    await bridge.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  return { address, bridge, requests };
}

function post(address, body = history, path = '/v1/responses') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path, method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer MOCK' } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function send(res, status, body, type = 'text/event-stream') {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

test('repeated Azure errors replay identical projected history without stripping opaque state', async t => {
  const f = await fixture(t, (res, n) => send(res, n <= 3 ? 400 : 200, n <= 3 ? error : success));
  const result = await post(f.address);
  assert.equal(result.status, 200);
  assert.equal(result.text, success);
  assert.equal(f.requests.length, 4);
  assert.deepEqual(JSON.parse(f.requests[0].bytes), history);
  const expected = structuredClone(history);
  delete expected.input[0].id;
  delete expected.input[1].id;
  assert.deepEqual(JSON.parse(f.requests[1].bytes), expected);
  for (const entry of f.requests.slice(1)) {
    assert.deepEqual(entry.bytes, f.requests[1].bytes);
    assert.equal(entry.auth, 'Bearer MOCK');
  }
});

test('Codex mixed encrypted history preserves custom IDs and pairings across repeated resource errors', async t => {
  const body = { ...history, input: [
    { type: 'additional_tools', id: 'tools_mock', role: 'developer', tools: [{ type: 'custom', name: 'exec', format: { type: 'text' } }] },
    { type: 'message', id: 'msg_mock', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Read, then add.' }] },
    { type: 'custom_tool_call', id: 'ctc_read', call_id: 'call_read', name: 'exec', input: 'read input.txt', status: 'completed' },
    { type: 'custom_tool_call_output', id: 'cto_read', call_id: 'call_read', output: '19\n23\n' },
    { type: 'reasoning', id: 'rs_mock', summary: [], encrypted_content: 'MOCK_OPAQUE' },
    { type: 'custom_tool_call', id: 'ctc_add', call_id: 'call_add', name: 'exec', input: 'add 19 23', status: 'completed' },
    { type: 'custom_tool_call_output', id: 'cto_add', call_id: 'call_add', output: '42' }
  ] };
  const f = await fixture(t, (res, n) => send(res, n < 4 ? 400 : 200, n < 4 ? error : success), { historyMode: 'codex' });
  const result = await post(f.address, body);
  assert.equal(result.status, 200);
  assert.equal(result.text, success);
  assert.equal(f.requests.length, 4);
  assert.deepEqual(f.requests[0].bytes, Buffer.from(JSON.stringify(body)));
  const expected = structuredClone(body);
  delete expected.input[1].id;
  delete expected.input[4].id;
  assert.deepEqual(JSON.parse(f.requests[1].bytes), expected);
  for (const entry of f.requests.slice(1)) assert.deepEqual(entry.bytes, f.requests[1].bytes);
});

test('repeated resource failure returns the actual final upstream error, not a new bridge status', async t => {
  const f = await fixture(t, res => send(res, 400, error), { resourceAttempts: 3 });
  const result = await post(f.address);
  assert.equal(result.status, 400);
  assert.equal(result.text, error);
  assert.equal(f.requests.length, 3);
});

test('only resource errors are replayed after projection; rate limits and empty output stop replay', async t => {
  for (const [status, body] of [[429, '{"error":{"message":"mock rate limit"}}'], [200, frame('response.completed', { response: { status: 'completed', output: [] } })]]) {
    const f = await fixture(t, (res, n) => send(res, n === 1 ? 400 : status, n === 1 ? error : body));
    const result = await post(f.address);
    assert.equal(result.status, status);
    assert.equal(result.text, body);
    assert.equal(f.requests.length, 2);
  }
});

test('known SSE failure can retry repeatedly before any output', async t => {
  const failure = frame('response.failed', { response: { status: 'failed', output: [], error: { message: known } } });
  const f = await fixture(t, (res, n) => send(res, 200, n < 3 ? failure : success));
  assert.equal((await post(f.address)).text, success);
  assert.equal(f.requests.length, 3);
});

test('projected response content commits and prevents a third resource replay', async t => {
  const payload = frame('response.output_text.delta', { delta: 'VISIBLE' }) + frame('response.failed', { response: { error: { message: known } } });
  const f = await fixture(t, (res, n) => send(res, n === 1 ? 400 : 200, n === 1 ? error : payload));
  assert.equal((await post(f.address)).text, payload);
  assert.equal(f.requests.length, 2);
});

test('Messages with no removable IDs can replay unchanged converted history on a known resource error', async t => {
  const body = { model: 'mock', max_tokens: 50, stream: false, messages: [{ role: 'user', content: 'hello' }] };
  const f = await fixture(t, (res, n) => send(res, n < 3 ? 400 : 200, n < 3 ? error : success), { upstreamProtocol: 'responses' });
  const result = await post(f.address, body, '/v1/messages');
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.text).content[0].text, 'RESULT_42');
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.requests[0].bytes, f.requests[1].bytes);
  assert.deepEqual(f.requests[1].bytes, f.requests[2].bytes);
});

test('request deadline cancels retry delay without issuing another upstream call', async t => {
  const f = await fixture(t, res => send(res, 400, error), { timeoutMs: 60, retryDelayMs: 1000 });
  const result = await post(f.address);
  assert.equal(result.status, 504);
  assert.equal(f.requests.length, 1);
});

test('bridge close cancels an in-flight retry delay', async t => {
  let signal;
  const received = new Promise(resolve => { signal = resolve; });
  const f = await fixture(t, res => { send(res, 400, error); signal(); }, { retryDelayMs: 1000 });
  const request = post(f.address).catch(() => null);
  await received;
  await f.bridge.close();
  await request;
  assert.equal(f.requests.length, 1);
});

for (const options of [{ resourceAttempts: 0 }, { resourceAttempts: 101 }, { resourceAttempts: 1.5 }, { retryDelayMs: -1 }, { retryDelayMs: 60001 }]) {
  test(`rejects invalid resource retry options ${JSON.stringify(options)}`, () => {
    assert.throws(() => createBridge({ upstream: 'http://127.0.0.1:1/v1', ...options }), TypeError);
  });
}
