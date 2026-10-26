'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { gzipSync } = require('node:zlib');
const { createBridge } = require('../lib/bridge');
const { messagesToResponses } = require('../lib/messages');
const { version } = require('../package.json');
const { mockAgentRouter } = require('../scripts/mock-agentrouter.cjs');

const official = 'https://agentrouter.org/v1';
const resource = Buffer.from(' \t\r\n' + JSON.stringify({ error: { type: 'invalid_request_error', message: 'The requested item was created under a different Azure OpenAI resource.' } }) + '\n');
const scoped = Buffer.from(JSON.stringify({ error: { type: 'invalid_request_error', param: '', code: null,
  message: 'Upstream rejected the request as invalid [trace_id=SYNTHETIC_AUTO_TRACE]' } }));
const cipher = Buffer.from(JSON.stringify({ error: { type: 'invalid_request_error', code: 'invalid_encrypted_content', message: 'SYNTHETIC_CIPHER_FAILURE' } }));
const success = Buffer.from(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text: 'SYNTHETIC_AUTO_RESULT' }] }], usage: { input_tokens: 12, output_tokens: 5 } }));
const frame = (type, fields = {}) => Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
const empty = frame('response.completed', { response: { status: 'completed', output: [] } });
const lifecycle = frame('response.created', { response: { status: 'in_progress', output: [] } });
const failed = frame('response.failed', { response: { status: 'failed', output: [], error: JSON.parse(resource).error } });
const identity = { 'content-type': 'application/json', authorization: 'Bearer SYNTHETIC_AUTO_KEY', 'x-session-id': 'SYNTHETIC_SESSION',
  'x-cache-key': 'SYNTHETIC_CACHE', 'user-agent': 'automatic-bridge-fixture/1' };
const history = () => ({ model: 'synthetic-auto-model', stream: false, store: false, reasoning: { effort: 'high' },
  prompt_cache_key: 'SYNTHETIC_CACHE', session_id: 'SYNTHETIC_SESSION', input: [
    { role: 'developer', content: 'Use the complete supplied tool history.' },
    { role: 'user', content: [{ type: 'input_text', text: 'Compute 19 + 23.' }] },
    { type: 'message', id: 'msg_auto', status: 'completed', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Call the synthetic tool.' }] },
    { type: 'reasoning', id: 'rs_auto', summary: [{ type: 'summary_text', text: 'SYNTHETIC_SUMMARY' }], encrypted_content: 'SYNTHETIC_OPAQUE' },
    { type: 'function_call', id: 'fc_auto', call_id: 'call_auto', name: 'add', arguments: '{"a":19,"b":23}' },
    { type: 'function_call_output', id: 'fo_auto', call_id: 'call_auto', output: '42', status: 'completed' }
  ], tools: [{ type: 'function', name: 'add', strict: false, parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: [] } }] });
const messages = () => ({ model: 'synthetic-messages-model', max_tokens: 50, stream: false,
  tools: [{ name: 'add', input_schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: [] } }], messages: [
    { role: 'user', content: 'Compute 19 + 23.' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'SYNTHETIC_THINKING', signature: 'SYNTHETIC_SIGNATURE' },
      { type: 'tool_use', id: 'call_messages', name: 'add', input: { a: 19, b: 23 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_messages', content: '42' }] }
  ] });
function projected(body) {
  const copy = structuredClone(body);
  for (const item of copy.input) if (['message', 'reasoning', 'function_call', 'function_call_output'].includes(item.type)) delete item.id;
  return copy;
}

async function fixture(t, handler, options = {}, bypass = false) {
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
  const restore = bypass ? () => {} : mockAgentRouter(upstream.address().port);
  let bridge;
  t.after(async () => {
    try { if (bridge) await bridge.close(); }
    finally { restore(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => upstream.close(resolve)); }
  });
  bridge = createBridge({ upstream: bypass ? `http://127.0.0.1:${upstream.address().port}/v1` : official,
    timeoutMs: 3000, retryDelayMs: 0, resourceAttempts: 4, diagnostics: { enabled: true, onEvent: event => events.push(event) }, ...options });
  const address = await bridge.listen(0);
  return { address, bridge, requests, events };
}
function request(address, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...identity, ...options.headers };
    for (const name of Object.keys(headers)) if (headers[name] === undefined) delete headers[name];
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path: options.path || '/v1/responses', method: options.method || 'POST',
      agent: false, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks), text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Synthetic automatic bridge request timed out.')));
    req.end(options.body === undefined ? Buffer.from(JSON.stringify(history(), null, 2)) : options.body);
  });
}
function send(res, status, bytes, type = 'application/json', headers = {}) {
  res.writeHead(status, { 'content-type': type, 'x-original-upstream': 'preserved', 'content-length': String(bytes.length), ...headers });
  res.end(bytes);
}

test('one default bridge auto-selects native and Messages contracts per request, not per process', async t => {
  const counts = new Map();
  const f = await fixture(t, (req, res) => {
    const body = JSON.parse(f.requests.at(-1).bytes);
    counts.set(body.model, (counts.get(body.model) || 0) + 1);
    send(res, counts.get(body.model) === 1 ? 400 : 200, counts.get(body.model) === 1 ? resource : success);
  });
  const nativeRaw = Buffer.from(' \t\r\n' + JSON.stringify(history(), null, 2) + '\n');
  const converted = messagesToResponses(messages());
  const native = await request(f.address, { body: nativeRaw });
  assert.equal(native.status, 200);
  assert.deepEqual(native.bytes, success);
  const convertedResult = await request(f.address, { path: '/v1/messages?beta=true', body: JSON.stringify(messages()),
    headers: { authorization: undefined, 'x-api-key': 'SYNTHETIC_MESSAGES_KEY' } });
  assert.equal(convertedResult.status, 200);
  assert.equal(JSON.parse(convertedResult.text).content[0].text, 'SYNTHETIC_AUTO_RESULT');
  assert.equal(f.requests.length, 4);
  assert.deepEqual(f.requests[0].bytes, nativeRaw);
  assert.deepEqual(JSON.parse(f.requests[1].bytes), projected(history()));
  assert.deepEqual(JSON.parse(f.requests[2].bytes), converted);
  assert.deepEqual(f.requests[3].bytes, f.requests[2].bytes);
  for (const received of f.requests) assert.equal(received.path, '/v1/responses');
  assert.equal(f.requests[0].headers.authorization, identity.authorization);
  assert.equal(f.requests[1].headers.authorization, identity.authorization);
  assert.equal(f.requests[2].headers.authorization, 'Bearer SYNTHETIC_MESSAGES_KEY');
  assert.equal(f.requests[3].headers.authorization, 'Bearer SYNTHETIC_MESSAGES_KEY');
  assert.equal(JSON.parse(f.requests[1].bytes).input[3].encrypted_content, 'SYNTHETIC_OPAQUE');
  assert.equal(JSON.parse(f.requests[1].bytes).tools[0].strict, false);
});

test('concurrent native and Messages requests do not bleed converted/history state', async t => {
  const counts = new Map();
  const f = await fixture(t, (_req, res) => {
    const body = JSON.parse(f.requests.at(-1).bytes);
    const count = (counts.get(body.model) || 0) + 1;
    counts.set(body.model, count);
    setTimeout(() => send(res, count === 1 ? 400 : 200, count === 1 ? scoped : success), body.model.includes('messages') ? 3 : 8);
  });
  const [native, converted] = await Promise.all([
    request(f.address), request(f.address, { path: '/v1/messages', body: JSON.stringify(messages()) })
  ]);
  assert.deepEqual(native.bytes, success);
  assert.equal(JSON.parse(converted.text).content[0].text, 'SYNTHETIC_AUTO_RESULT');
  assert.equal(f.requests.length, 4);
  const nativeRequests = f.requests.filter(item => JSON.parse(item.bytes).model === history().model);
  const messagesRequests = f.requests.filter(item => JSON.parse(item.bytes).model === messages().model);
  assert.deepEqual(JSON.parse(nativeRequests[1].bytes), projected(history()));
  assert.deepEqual(messagesRequests[0].bytes, messagesRequests[1].bytes);
});

for (const [name, mutate] of [
  ['unknown message field', b => { b.input[2].future_output = 'UNKNOWN'; }],
  ['unknown easy field', b => { b.input[0].future_role = 'UNKNOWN'; }],
  ['unknown text-part field', b => { b.input[2].content[0].future_text = 'UNKNOWN'; }],
  ['unknown reasoning field', b => { b.input[3].future_content = 'UNKNOWN'; }],
  ['unknown tool call field', b => { b.input[4].future_arguments = 'UNKNOWN'; }],
  ['unknown result field', b => { b.input[5].future_output = 'UNKNOWN'; }],
  ['incomplete tool pair', b => { b.input.pop(); }],
  ['server-side history', b => { b.previous_response_id = 'server_reference'; }]
]) test(`default transparent recovery still refuses ${name} and retains the actual exact upstream response`, async t => {
  const f = await fixture(t, (_req, res) => send(res, 400, resource));
  const body = history(); mutate(body);
  const raw = Buffer.from(' \n' + JSON.stringify(body, null, 2));
  const result = await request(f.address, { body: raw });
  assert.equal(result.status, 400);
  assert.deepEqual(result.bytes, resource);
  assert.equal(result.headers['content-length'], String(resource.length));
  assert.equal(result.headers['x-original-upstream'], 'preserved');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].bytes, raw);
});

test('default transparent recovery replays an unprojectable builtin search item without altering one byte', async t => {
  const body = history();
  body.input.push({ type: 'web_search_call', id: 'ws_builtin', status: 'completed', action: { type: 'search', query: 'synthetic' } });
  const raw = Buffer.from(' \n' + JSON.stringify(body, null, 2));
  const f = await fixture(t, (_req, res) => send(res, 400, resource));
  const result = await request(f.address, { body: raw });
  assert.equal(result.status, 400);
  assert.deepEqual(result.bytes, resource);
  assert.equal(f.requests.length, 4);
  for (const received of f.requests) {
    assert.deepEqual(received.bytes, raw);
    assert.equal(received.headers.authorization, identity.authorization);
  }
});

for (const [name, mutate] of [
  ['unknown message field', b => { b.input[2].future_output = 'UNKNOWN'; }],
  ['unknown easy field', b => { b.input[0].future_role = 'UNKNOWN'; }],
  ['unknown text-part field', b => { b.input[2].content[0].future_text = 'UNKNOWN'; }],
  ['unknown reasoning field', b => { b.input[3].future_content = 'UNKNOWN'; }],
  ['unknown tool call field', b => { b.input[4].future_arguments = 'UNKNOWN'; }],
  ['unknown result field', b => { b.input[5].future_output = 'UNKNOWN'; }],
  ['incomplete tool pair', b => { b.input.pop(); }],
  ['server-side history', b => { b.previous_response_id = 'server_reference'; }]
]) test(`explicit transparentRecovery:false keeps ${name} a single unchanged attempt`, async t => {
  const f = await fixture(t, (_req, res) => send(res, 400, resource), { transparentRecovery: false });
  const body = history(); mutate(body);
  const raw = Buffer.from(' \n' + JSON.stringify(body, null, 2));
  const result = await request(f.address, { body: raw });
  assert.equal(result.status, 400);
  assert.deepEqual(result.bytes, resource);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].bytes, raw);
});

for (const [name, status, bytes, type] of [
  ['rate limit', 429, Buffer.from('{"error":{"type":"rate_limit_error"}}'), 'application/json'],
  ['server error', 503, Buffer.from('{"error":{"type":"server_error"}}'), 'application/json']
]) test(`default transparent recovery hides repeated ${name} failures and returns the final upstream response`, async t => {
  const f = await fixture(t, (_req, res) => send(res, status, bytes, type));
  const native = await request(f.address);
  assert.equal(native.status, status);
  assert.deepEqual(native.bytes, bytes);
  assert.equal(f.requests.length, 3);
  for (const received of f.requests) assert.deepEqual(received.bytes, f.requests[0].bytes);
});

for (const [name, status, bytes, type] of [
  ['rate limit', 429, Buffer.from('{"error":{"type":"rate_limit_error"}}'), 'application/json'],
  ['server error', 503, Buffer.from('{"error":{"type":"server_error"}}'), 'application/json'],
  ['completed empty', 200, empty, 'text/event-stream'],
  ['failed empty', 200, frame('response.failed', { response: { status: 'failed', output: [], error: null } }), 'text/event-stream'],
  ['metadata EOF', 200, lifecycle, 'text/event-stream'],
  ['generic400', 400, Buffer.from('{"error":{"type":"invalid_request_error","message":"Bad request."}}'), 'application/json']
]) test(`explicit transparentRecovery:false keeps ${name} a single unchanged attempt`, async t => {
  const f = await fixture(t, (_req, res) => send(res, status, bytes, type), { transparentRecovery: false });
  const native = await request(f.address);
  assert.equal(native.status, status);
  assert.deepEqual(native.bytes, bytes);
  assert.equal(f.requests.length, 1);
});

for (const [name, status, bytes, type] of [
  ['completed empty', 200, empty, 'text/event-stream'],
  ['failed empty', 200, frame('response.failed', { response: { status: 'failed', output: [], error: null } }), 'text/event-stream'],
  ['metadata EOF', 200, lifecycle, 'text/event-stream'],
  ['generic400', 400, Buffer.from('{"error":{"type":"invalid_request_error","message":"Bad request."}}'), 'application/json']
]) test(`default auto still treats ${name} as a single completed response`, async t => {
  const f = await fixture(t, (_req, res) => send(res, status, bytes, type));
  const native = await request(f.address);
  assert.equal(native.status, status);
  assert.deepEqual(native.bytes, bytes);
  assert.equal(f.requests.length, 1);
});

for (const [status, bytes] of [[429, Buffer.from('{"error":{"type":"rate_limit_error","message":"Synthetic limit."}}')], [200, empty]]) {
  test('default Messages conversion retains single-attempt transient/empty semantics', async t => {
    const f = await fixture(t, (_req, res) => send(res, status, bytes, status === 200 ? 'text/event-stream' : 'application/json'));
    const result = await request(f.address, { path: '/v1/messages', body: JSON.stringify(messages()) });
    assert.equal(result.status, status);
    if (status === 200) assert.deepEqual(JSON.parse(result.text).content, []);
    else assert.deepEqual(result.bytes, bytes);
    assert.equal(f.requests.length, 1);
  });
}

test('default cipher recovery exposes lossy marker only after actual applied downgrade', async t => {
  const f = await fixture(t, (_req, res, n) => send(res, n === 1 ? 400 : 200, n === 1 ? cipher : success));
  const body = history();
  const raw = Buffer.from(JSON.stringify(body, null, 2));
  const result = await request(f.address, { body: raw });
  assert.deepEqual(result.bytes, success);
  assert.equal(result.headers['x-rhb-recovery'], 'encrypted-reasoning-dropped');
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0].bytes, raw);
  const expected = structuredClone(body);
  delete expected.input[3].encrypted_content;
  delete expected.input[3].id;
  assert.deepEqual(JSON.parse(f.requests[1].bytes), expected);
});

for (const bytes of [Buffer.concat([lifecycle, failed, Buffer.from('data: {"type":"response.output_text.delta"')]),
  Buffer.concat([lifecycle, frame('response.output_text.delta', { delta: ' ' }), failed]),
  Buffer.concat([lifecycle, frame('future.output', { content: 'UNKNOWN' }), failed])]) {
  test('default auto inspects complete SSE tails and blocks unknown or generated output', async t => {
    const f = await fixture(t, (_req, res) => send(res, 200, bytes, 'text/event-stream'));
    const result = await request(f.address);
    assert.deepEqual(result.bytes, bytes);
    assert.equal(f.requests.length, 1);
  });
}

test('explicit legacy minimal still refuses unverified message ID with legacy409', async t => {
  const f = await fixture(t, (_req, res) => send(res, 400, resource), { historyMode: 'minimal', upstreamProtocol: 'passthrough' });
  const result = await request(f.address);
  assert.equal(result.status, 409);
  assert.equal(JSON.parse(result.text).error.code, 'unsupported_item_id');
  assert.equal(f.requests.length, 1);
});

for (const historyMode of ['minimal', 'codex', 'harness']) test(`explicit legacy ${historyMode} keeps omitted protocol as passthrough`, async t => {
  const f = await fixture(t, (_req, res) => send(res, 400, resource), { historyMode, retryDelayMs: 0 });
  const raw = Buffer.from(JSON.stringify(messages(), null, 2));
  const result = await request(f.address, { path: '/v1/messages', body: raw });
  assert.deepEqual(result.bytes, resource);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, '/v1/messages');
  assert.deepEqual(f.requests[0].bytes, raw);
});

test('explicit legacy passthrough disables automatic Messages conversion on official upstream', async t => {
  const f = await fixture(t, (_req, res) => send(res, 400, resource), { upstreamProtocol: 'passthrough' });
  const raw = Buffer.from(JSON.stringify(messages(), null, 2));
  const result = await request(f.address, { path: '/v1/messages', body: raw });
  assert.deepEqual(result.bytes, resource);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, '/v1/messages');
  assert.deepEqual(f.requests[0].bytes, raw);
});

test('nonofficial default bridge preserves native Messages bytes, beta query, compression and authentication', async t => {
  const response = gzipSync(resource);
  const f = await fixture(t, (_req, res) => send(res, 400, response, 'application/json', { 'content-encoding': 'gzip' }), {}, true);
  const raw = gzipSync(Buffer.from(JSON.stringify({ ...messages(), provider_specific_field: 'MUST_NOT_CONVERT' })));
  const result = await request(f.address, { path: '/v1/messages?beta=true', body: raw, headers: {
    authorization: undefined, 'x-api-key': 'SYNTHETIC_OTHER_KEY', 'content-encoding': 'gzip', 'accept-encoding': 'gzip, br'
  } });
  assert.deepEqual(result.bytes, response);
  assert.equal(result.headers['content-encoding'], 'gzip');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].bytes, raw);
  assert.equal(f.requests[0].path, '/v1/messages?beta=true');
  assert.equal(f.requests[0].headers.authorization, undefined);
  assert.equal(f.requests[0].headers['x-api-key'], 'SYNTHETIC_OTHER_KEY');
  assert.equal(f.requests[0].headers['accept-encoding'], 'gzip, br');
  assert.equal(f.requests[0].headers['content-encoding'], 'gzip');
});

test('default Messages converter rejects unknown content before upstream instead of dropping it', async t => {
  const f = await fixture(t, (_req, res) => send(res, 200, success));
  const body = messages();
  body.messages[0].content = [{ type: 'provider_specific', encrypted: 'DO_NOT_DROP' }];
  const result = await request(f.address, { path: '/v1/messages', body: JSON.stringify(body) });
  assert.equal(result.status, 400);
  assert.equal(JSON.parse(result.text).error.code, 'unsupported_messages_content');
  assert.equal(f.requests.length, 0);
});

test('GET health identifies only this ready local service without secrets or upstream request', async t => {
  const f = await fixture(t, (_req, res) => send(res, 200, success), { apiKey: 'SYNTHETIC_SECRET_KEY' });
  const result = await request(f.address, { path: '/health', method: 'GET', body: Buffer.alloc(0) });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.text), { service: 'resource-history-bridge', version, status: 'ready' });
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.text.includes('SYNTHETIC_SECRET'), false);
  assert.equal(result.text.includes('model'), false);
  assert.equal(f.requests.length, 0);
});

for (const [name, options, status] of [
  ['foreign Host', { headers: { host: 'evil.example' } }, 403],
  ['Origin', { headers: { origin: 'http://localhost' } }, 403],
  ['fetch metadata', { headers: { 'sec-fetch-site': 'same-origin' } }, 403],
  ['query', { path: '/health?target=official' }, 404],
  ['v1 alias', { path: '/v1/health' }, 404],
  ['POST', { method: 'POST' }, 404]
]) test(`health retains local guard and exact route for ${name}`, async t => {
  const f = await fixture(t, (_req, res) => send(res, 200, success));
  const result = await request(f.address, { path: '/health', method: 'GET', body: Buffer.alloc(0), ...options });
  assert.equal(result.status, status);
  assert.equal(f.requests.length, 0);
});
