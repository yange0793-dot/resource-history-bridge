'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createBridge } = require('..');
const { mockAgentRouter } = require('../scripts/mock-agentrouter.cjs');

const known = JSON.stringify({ error: { type: 'invalid_request_error', message: 'The requested item was created under a different Azure OpenAI resource.' } });
const done = `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'RESULT_42' }] }] } })}\n\n`;

function history() {
  return { model: 'gpt-6.1-sol', stream: true, store: false, prompt_cache_key: 'harness_session_mock', input: [
    { role: 'developer', content: 'Use the tools.' },
    { role: 'user', content: [{ type: 'input_text', text: 'Compute 19+23.' }] },
    { type: 'message', id: 'msg_mock', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'I will calculate.', annotations: [] }] },
    { type: 'reasoning', id: 'rs_mock', summary: [], encrypted_content: 'MOCK_ENCRYPTED' },
    { type: 'function_call', id: 'fc_mock', call_id: 'call_mock', name: 'add', arguments: '{"a":19,"b":23}' },
    { type: 'function_call_output', call_id: 'call_mock', output: '42' }
  ], tools: [{ type: 'function', name: 'add', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a'] }, strict: false }] };
}

async function fixture(t, respond, options = {}) {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ bytes: Buffer.concat(chunks), headers: req.headers, url: req.url });
    respond(res, requests.length);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(mockAgentRouter(upstream.address().port));
  const bridge = createBridge({ upstream: 'https://agentrouter.org/v1', historyMode: 'harness', resourceAttempts: 3, retryDelayMs: 0, timeoutMs: 2000, ...options });
  const address = await bridge.listen(0);
  t.after(async () => { await bridge.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  return { address, requests };
}

function post(address, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: address.port, method: 'POST', path: '/v1/responses', headers: {
      'content-type': 'application/json', authorization: 'Bearer MOCK_KEY', 'user-agent': 'Harness/mock', session_id: 'harness_session_mock', 'x-client-request-id': 'harness_session_mock'
    } }, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.end(body);
  });
}

function send(res, status, text) { res.writeHead(status, { 'content-type': 'text/event-stream' }); res.end(text); }

test('Harness first request is byte-preserving and retains session headers', async t => {
  const f = await fixture(t, res => send(res, 200, done));
  const bytes = JSON.stringify(history(), null, 2);
  const result = await post(f.address, bytes);
  assert.equal(result.text, done);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].bytes.toString(), bytes);
  assert.equal(f.requests[0].url, '/v1/responses');
  assert.equal(f.requests[0].headers.session_id, 'harness_session_mock');
  assert.equal(f.requests[0].headers['x-client-request-id'], 'harness_session_mock');
  assert.equal(f.requests[0].headers['user-agent'], 'Harness/mock');
});

test('Harness mixed text, encrypted reasoning and tool result recover without native metadata loss', async t => {
  const f = await fixture(t, (res, count) => send(res, count < 3 ? 400 : 200, count < 3 ? known : done));
  const body = history();
  const result = await post(f.address, JSON.stringify(body));
  assert.equal(result.status, 200);
  assert.equal(result.text, done);
  assert.equal(f.requests.length, 3);
  const expected = structuredClone(body);
  for (const item of expected.input) if (['message', 'reasoning', 'function_call'].includes(item.type)) delete item.id;
  assert.deepEqual(JSON.parse(f.requests[1].bytes), expected);
  assert.deepEqual(f.requests[1].bytes, f.requests[2].bytes);
  assert.equal(f.requests.every(r => r.headers.authorization === 'Bearer MOCK_KEY'), true);
  assert.equal(body.input[3].id, 'rs_mock');
});

test('Harness custom calls and inline tool updates may omit item IDs', async t => {
  const f = await fixture(t, (res, count) => send(res, count === 1 ? 400 : 200, count === 1 ? known : done));
  const body = history();
  body.input.splice(4, 2,
    { type: 'additional_tools', role: 'developer', tools: [{ type: 'custom', name: 'calculate', format: { type: 'text' } }] },
    { type: 'custom_tool_call', call_id: 'custom_mock', name: 'calculate', input: '19+23' },
    { type: 'custom_tool_call_output', call_id: 'custom_mock', output: '42' });
  assert.equal((await post(f.address, JSON.stringify(body))).status, 200);
  const projected = JSON.parse(f.requests[1].bytes);
  assert.deepEqual(projected.input.slice(4), body.input.slice(4));
});

test('Harness empty completion retries within transient budget and returns the actual last completion', async t => {
  const empty = `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}\n\n`;
  const f = await fixture(t, res => send(res, 200, empty));
  assert.equal((await post(f.address, JSON.stringify(history()))).text, empty);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.requests[0].bytes, f.requests[1].bytes);
  assert.deepEqual(f.requests[1].bytes, f.requests[2].bytes);
});

test('Harness generic 400 permits one validated projection and returns the actual last error', async t => {
  const error = '{"error":{"type":"invalid_request_error","message":"Unrelated invalid request"}}';
  const f = await fixture(t, res => send(res, 400, error));
  const result = await post(f.address, JSON.stringify(history()));
  assert.equal(result.status, 400);
  assert.equal(result.text, error);
  assert.equal(f.requests.length, 2);
  const expected = history();
  for (const item of expected.input) if (['message', 'reasoning', 'function_call'].includes(item.type)) delete item.id;
  assert.deepEqual(JSON.parse(f.requests[1].bytes), expected);
});

test('Harness output commit prevents replay even if a resource error follows', async t => {
  const output = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"VISIBLE"}\n\n';
  const failed = `event: error\ndata: ${known}\n\n`;
  const f = await fixture(t, res => send(res, 200, output + failed));
  assert.equal((await post(f.address, JSON.stringify(history()))).text, output + failed);
  assert.equal(f.requests.length, 1);
});
