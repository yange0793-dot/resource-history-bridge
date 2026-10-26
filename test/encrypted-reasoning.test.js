'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { gzipSync } = require('node:zlib');
const { createBridge } = require('../lib/bridge');
const { isEncryptedReasoningError, projectEncryptedReasoning } = require('../lib/encrypted-reasoning');
const { mockAgentRouter } = require('../scripts/mock-agentrouter.cjs');

const official = 'https://agentrouter.org/v1';
const cipherError = { type: 'invalid_request_error', code: 'invalid_encrypted_content', param: 'input', message: 'SYNTHETIC_CIPHER_REJECTED' };
const encrypted = JSON.stringify({ error: cipherError });
const resource = JSON.stringify({ error: { type: 'invalid_request_error', message: 'The requested item was created under a different Azure OpenAI resource.' } });
const frame = (type, fields = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const lifecycle = frame('response.created', { response: { status: 'in_progress', output: [] } });
const failed = frame('response.failed', { response: { status: 'failed', output: [], error: cipherError } });
const unnamed = `data: ${encrypted}\n\n`;
const completed = { status: 'completed', output: [
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SYNTHETIC_RESULT_42' }] },
  { type: 'function_call', call_id: 'call_next', name: 'Read', arguments: '{"file":"next.txt"}' }
] };
const jsonSuccess = JSON.stringify(completed);
const sseSuccess = frame('response.completed', { response: completed });
const identity = { 'content-type': 'application/json', authorization: 'Bearer SYNTHETIC_KEY',
  'x-session-id': 'SYNTHETIC_HEADER_SESSION', 'x-cache-key': 'SYNTHETIC_HEADER_CACHE', 'user-agent': 'encrypted-reasoning-fixture/1' };

function history() {
  return { model: 'synthetic-model', stream: true, store: false, reasoning: { effort: 'high' },
    prompt_cache_key: 'SYNTHETIC_CACHE', session_id: 'SYNTHETIC_SESSION',
    tools: [{ type: 'function', name: 'add', strict: false, parameters: { type: 'object', properties: { a: { type: 'number' } }, required: [] } }],
    input: [
      { type: 'reasoning', id: 'rs_opaque', encrypted_content: 'SYNTHETIC_OPAQUE_A+/=\u0000é', summary: [] },
      { type: 'reasoning', id: 'rs_summary', encrypted_content: 'SYNTHETIC_OPAQUE_B', summary: [{ type: 'summary_text', text: 'SYNTHETIC_SUMMARY' }] },
      { type: 'function_call', id: 'fc_keep', call_id: 'call_keep', name: 'add', arguments: '{"a":42}' },
      { type: 'function_call_output', call_id: 'call_keep', output: 'SYNTHETIC_TOOL_RESULT' }
    ] };
}

function frozen(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}

function downgrade(body) {
  const result = structuredClone(body);
  result.input = result.input.filter(item => {
    if (item.type !== 'reasoning' || !Object.hasOwn(item, 'encrypted_content')) return true;
    delete item.encrypted_content;
    delete item.id;
    return ['summary', 'content'].some(key => Array.isArray(item[key]) && item[key].some(part => part.text.length > 0));
  });
  return result;
}

for (const [name, status, payload] of [
  ['HTTP400 envelope', 400, { error: cipherError }],
  ['HTTP400 serialized envelope', 400, encrypted],
  ['HTTP200 nested typed error', 200, { type: 'error', error: cipherError }],
  ['HTTP200 flat typed error', 200, { type: 'error', code: cipherError.code, message: cipherError.message, param: 'input' }],
  ['HTTP200 response.failed', 200, { type: 'response.failed', response: { status: 'failed', output: [], error: cipherError } }],
  ['HTTP200 JSON failed response', 200, { object: 'response', status: 'failed', output: [], error: cipherError }]
]) test(`encrypted detector accepts exact structured ${name}`, () => {
  for (const upstream of [official, new URL('https://ps.air-outer.com/v1')]) assert.equal(isEncryptedReasoningError(payload, status, upstream), true);
});

for (const [name, status, payload] of [
  ['missing exact code', 400, { error: { type: 'invalid_request_error', message: 'Unable to decrypt encrypted content.' } }],
  ['generic invalid', 400, { error: { type: 'invalid_request_error', code: null, message: 'Bad request.' } }],
  ['code in text', 400, { error: { message: 'invalid_encrypted_content' } }],
  ['case variant', 400, { error: { ...cipherError, code: 'INVALID_ENCRYPTED_CONTENT' } }],
  ['code suffix', 400, { error: { ...cipherError, code: 'invalid_encrypted_content_extra' } }],
  ['nested unrelated code', 400, { error: { code: 'invalid_schema', message: 'Bad schema.', cause: cipherError } }],
  ['plain prose', 400, 'invalid_encrypted_content'],
  ['malformed JSON', 400, encrypted.slice(0, -1)],
  ['array envelope', 400, [{ error: cipherError }]],
  ['untyped standalone', 400, { code: cipherError.code, message: cipherError.message }],
  ['unknown envelope field', 400, { error: cipherError, future_output: 'unknown' }],
  ['unknown error field', 400, { error: { ...cipherError, future_output: 'unknown' } }],
  ['completed response', 200, { status: 'completed', output: [], error: cipherError }],
  ['failed text output', 200, { status: 'failed', output: [], output_text: ' ', error: cipherError }],
  ['failed reasoning output', 200, { status: 'failed', output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: '\n' }] }], error: cipherError }],
  ['failed tool output', 200, { type: 'response.failed', response: { status: 'failed', output: [{ type: 'function_call', name: 'Read', arguments: '' }], error: cipherError } }],
  ['unknown response field', 200, { status: 'failed', output: [], future_output: 'unknown', error: cipherError }]
]) test(`encrypted detector refuses ${name}`, () => assert.equal(isEncryptedReasoningError(payload, status, official), false));

for (const status of [undefined, 0, 399, 401, 403, 408, 422, 429, 500, 503]) test(`HTTP${status} is not an encrypted downgrade status`, () => {
  assert.equal(isEncryptedReasoningError({ error: cipherError }, status, official), false);
});

for (const upstream of ['http://agentrouter.org/v1', 'http://ps.air-outer.com/v1', 'http://127.0.0.1:1/v1',
  'https://api.other.example.invalid/v1', 'https://agentrouter.org.evil.example.invalid/v1', 'https://sub.agentrouter.org/v1',
  'https://agentrouter.org./v1', 'https://key@agentrouter.org/v1', 'https://agentrouter.org/v1?provider=agentrouter', undefined]) {
  test(`encrypted detector does not activate for ${upstream}`, () => assert.equal(isEncryptedReasoningError({ error: cipherError }, 400, upstream), false));
}

for (const mode of ['minimal', 'codex', 'harness']) test(`${mode} ciphertext projection drops opaque-only reasoning and preserves all other identity`, () => {
  const body = history();
  body.input.push({ type: 'message', id: 'msg_keep', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: 'SYNTHETIC_MESSAGE', annotations: [] }] });
  body.input[3].id = 'fo_keep';
  body.input.push({ type: 'reasoning', id: 'rs_plain_keep', summary: [{ type: 'summary_text', text: 'Already plain.' }] });
  body.input.push({ type: 'reasoning', id: 'rs_content', summary: [], content: [{ type: 'reasoning_text', text: 'SYNTHETIC_INLINE_REASONING' }], encrypted_content: 'SYNTHETIC_OPAQUE_C' });
  frozen(body);
  const before = JSON.stringify(body);
  const projected = projectEncryptedReasoning(body, { mode });
  assert.equal(projected.ok, true);
  assert.equal(projected.lossy, true);
  assert.equal(projected.removedEncrypted, 3);
  assert.equal(projected.droppedReasoning, 1);
  assert.equal(projected.removedIds, 3);
  assert.deepEqual(projected.body, downgrade(body));
  assert.equal(JSON.stringify(body), before);
  assert.notEqual(projected.body, body);
  assert.equal(projected.body.tools[0].strict, false);
});

for (const mode of ['codex', 'harness']) test(`${mode} downgrade retains custom/additional IDs and exact tool protocol`, () => {
  const body = history();
  body.input.push(
    { type: 'additional_tools', id: 'tools_keep', role: 'developer', tools: [{ type: 'custom', name: 'exec', format: { type: 'text' } }] },
    { type: 'custom_tool_call', id: 'ctc_keep', call_id: 'custom_keep', name: 'exec', input: 'read synthetic.txt', status: 'completed' },
    { type: 'custom_tool_call_output', id: 'cto_keep', call_id: 'custom_keep', output: 'SYNTHETIC_CUSTOM_RESULT' });
  const projected = projectEncryptedReasoning(frozen(body), { mode });
  assert.equal(projected.ok, true);
  assert.deepEqual(projected.body, downgrade(body));
  assert.deepEqual(projected.body.input.slice(-3), body.input.slice(-3));
});

test('Harness encrypted projection supports easy messages and optional custom/additional IDs', () => {
  const body = history();
  body.input.unshift({ role: 'developer', content: 'Use tools.' }, { role: 'user', content: [{ type: 'input_text', text: 'Compute.' }] });
  body.input.push({ type: 'additional_tools', role: 'developer', tools: [{ type: 'custom', name: 'exec', format: { type: 'text' } }] },
    { type: 'custom_tool_call', call_id: 'custom', name: 'exec', input: 'read' },
    { type: 'custom_tool_call_output', call_id: 'custom', output: '42' });
  assert.deepEqual(projectEncryptedReasoning(frozen(body), { mode: 'harness' }).body, downgrade(body));
});

test('cipher projection counts only existing reasoning IDs and accepts cipher without an ID', () => {
  const body = history();
  delete body.input[0].id;
  delete body.input[1].id;
  const result = projectEncryptedReasoning(frozen(body));
  assert.equal(result.ok, true);
  assert.equal(result.removedIds, 0);
  assert.equal(result.removedEncrypted, 2);
  assert.deepEqual(result.body, downgrade(body));
});

for (const [name, modify] of [
  ['no ciphertext', b => { for (const item of b.input) delete item.encrypted_content; }],
  ['server previous_response_id', b => { b.previous_response_id = 'resp_server'; }],
  ['server conversation', b => { b.conversation = { id: 'conv_server' }; }],
  ['string input', b => { b.input = 'not explicit history'; }],
  ['empty input', b => { b.input = []; }],
  ['null item', b => { b.input.push(null); }],
  ['item reference', b => { b.input.push({ type: 'item_reference', id: 'ref_keep' }); }],
  ['compaction item', b => { b.input.push({ type: 'compaction', encrypted_content: 'UNSUPPORTED_COMPACTION' }); }],
  ['context compaction item', b => { b.input.push({ type: 'context_compaction', encrypted_content: 'UNSUPPORTED_COMPACTION' }); }],
  ['unknown item without ID', b => { b.input.push({ type: 'future_item', content: 'unknown' }); }],
  ['cipher on message', b => { b.input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }], encrypted_content: 'UNSUPPORTED_CIPHER' }); }],
  ['cipher on function output', b => { b.input[3].encrypted_content = 'UNSUPPORTED_CIPHER'; }],
  ['missing reasoning summary', b => { delete b.input[0].summary; }],
  ['null reasoning summary', b => { b.input[0].summary = null; }],
  ['bad reasoning part', b => { b.input[1].summary[0].type = 'output_text'; }],
  ['bad reasoning text', b => { b.input[1].summary[0].text = 42; }],
  ['bad reasoning content', b => { b.input[0].content = 'not inline'; }],
  ['invalid ciphertext', b => { b.input[0].encrypted_content = ''; }],
  ['invalid reasoning ID', b => { b.input[0].id = null; }],
  ['unknown reasoning status', b => { b.input[0].status = 'in_progress'; }],
  ['unknown reasoning field', b => { b.input[0].future_content = 'unknown'; }],
  ['missing function output', b => { b.input.pop(); }],
  ['output before call', b => { [b.input[2], b.input[3]] = [b.input[3], b.input[2]]; }],
  ['duplicate call', b => { b.input.splice(3, 0, structuredClone(b.input[2])); }],
  ['duplicate output', b => { b.input.push(structuredClone(b.input[3])); }],
  ['bad output value', b => { b.input[3].output = {}; }],
  ['missing arguments', b => { delete b.input[2].arguments; }],
  ['unknown easy message', b => { b.input.push({ role: 'assistant', content: 'not an emitted easy shape' }); }]
]) test(`cipher projection refuses ${name} without mutating its source`, () => {
  const body = history(); modify(body); frozen(body);
  const before = JSON.stringify(body);
  const result = projectEncryptedReasoning(body, { mode: 'harness' });
  assert.equal(result.ok, false);
  assert.equal(typeof result.code, 'string');
  assert.equal(typeof result.message, 'string');
  assert.equal(JSON.stringify(body), before);
});

test('cipher projection refuses invalid body and mode without throwing', () => {
  for (const body of [null, [], 'text']) assert.equal(projectEncryptedReasoning(body).ok, false);
  assert.equal(projectEncryptedReasoning(history(), { mode: 'unknown' }).ok, false);
});

async function fixture(t, handler, options = {}, bypass = false) {
  const requests = [], events = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ bytes: Buffer.concat(chunks), headers: req.headers, path: req.url });
    handler(req, res, requests.length);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const restore = bypass ? () => {} : mockAgentRouter(upstream.address().port);
  let bridge;
  t.after(async () => {
    try { if (bridge) await bridge.close(); }
    finally { restore(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
  });
  bridge = createBridge({ upstream: bypass ? `http://127.0.0.1:${upstream.address().port}/v1` : official,
    timeoutMs: 2000, retryDelayMs: 0, retryJitterRatio: 0,
    diagnostics: { enabled: true, onEvent: event => events.push(event) }, ...options });
  const address = await bridge.listen(0);
  return { address, bridge, requests, events };
}

function post(address, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path: options.path || '/v1/responses', method: 'POST', agent: false, headers: identity }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks), text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Synthetic encrypted recovery request timed out.')));
    req.end(options.body === undefined ? Buffer.from(' \t\r\n' + JSON.stringify(history(), null, 2) + '\n') : options.body);
  });
}

function send(res, status, bytes, type = 'application/json', headers = {}) {
  res.writeHead(status, { 'content-type': type, 'x-original-upstream': 'preserved', ...headers });
  res.end(bytes);
}

function assertIdentity(request) {
  for (const [name, value] of Object.entries(identity)) assert.equal(request.headers[name], value, name);
  assert.equal(request.path, '/v1/responses');
}

for (const [name, status, payload, type] of [
  ['HTTP400 JSON', 400, encrypted, 'application/json'],
  ['HTTP400 SSE-mislabeled JSON', 400, ' \t\r\n' + encrypted, 'text/event-stream'],
  ['HTTP200 typed JSON', 200, JSON.stringify({ type: 'error', error: cipherError }), 'application/json'],
  ['HTTP200 flat typed JSON', 200, JSON.stringify({ type: 'error', code: cipherError.code, message: cipherError.message }), 'application/json'],
  ['HTTP200 JSON failed', 200, JSON.stringify({ status: 'failed', output: [], error: cipherError }), 'application/json'],
  ['HTTP200 SSE failed', 200, lifecycle + failed, 'text/event-stream'],
  ['HTTP200 unnamed SSE error', 200, lifecycle + unnamed, 'text/event-stream']
]) test(`${name} downgrades once before native tool-capable SSE success`, async t => {
  const f = await fixture(t, (_req, res, n) => send(res, n === 1 ? status : 200, n === 1 ? payload : sseSuccess, n === 1 ? type : 'text/event-stream'));
  const original = Buffer.from(' \t\r\n' + JSON.stringify(history(), null, 2) + '\n');
  const result = await post(f.address, { body: original });
  assert.equal(result.status, 200);
  assert.equal(result.text, sseSuccess, 'no bridge SSE event or old failure may be inserted');
  assert.equal(result.headers['x-rhb-recovery'], 'encrypted-reasoning-dropped');
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0].bytes, original);
  assert.deepEqual(JSON.parse(f.requests[1].bytes), downgrade(history()));
  for (const request of f.requests) assertIdentity(request);
});

for (const mode of ['minimal', 'codex', 'harness']) test(`${mode} default enables bounded encrypted recovery with exact JSON success`, async t => {
  const body = history(); body.stream = false;
  const f = await fixture(t, (_req, res, n) => send(res, n === 1 ? 400 : 200, n === 1 ? encrypted : jsonSuccess), { historyMode: mode });
  const result = await post(f.address, { body: JSON.stringify(body) });
  assert.equal(result.text, jsonSuccess);
  assert.equal(result.headers['x-rhb-recovery'], 'encrypted-reasoning-dropped');
  assert.equal(f.requests.length, 2);
  assert.deepEqual(JSON.parse(f.requests[1].bytes), downgrade(body));
});

test('a second encrypted rejection is final, even with a large shared retry budget', async t => {
  const f = await fixture(t, (_req, res) => send(res, 400, encrypted, 'application/json', { 'content-length': Buffer.byteLength(encrypted) }), { historyMode: 'harness', totalAttempts: 10 });
  const result = await post(f.address);
  assert.equal(f.requests.length, 2);
  assert.equal(result.status, 400);
  assert.equal(result.text, encrypted);
  assert.equal(result.headers['content-length'], String(Buffer.byteLength(encrypted)));
  assert.equal(result.headers['x-original-upstream'], 'preserved');
  assert.equal(result.headers['x-rhb-recovery'], 'encrypted-reasoning-dropped');
});

for (const options of [{ historyMode: 'harness', totalAttempts: 1 }, { historyMode: 'minimal', resourceAttempts: 1 }]) test('one-call budget returns exact ciphertext error without applying a downgrade', async t => {
  const f = await fixture(t, (_req, res) => send(res, 400, encrypted), options);
  const result = await post(f.address);
  assert.equal(result.status, 400);
  assert.equal(result.text, encrypted);
  assert.equal(result.headers['x-rhb-recovery'], undefined);
  assert.equal(f.requests.length, 1);
  assert.equal(f.events.some(event => event.type === 'encrypted_reasoning_downgrade'), false);
});

for (const sequence of [[resource, encrypted], [encrypted, resource]]) test(`${sequence[0] === resource ? 'ID then cipher' : 'cipher then ID'} projections compose on current body without reviving ciphertext`, async t => {
  const f = await fixture(t, (_req, res, n) => send(res, n < 3 ? 400 : 200, n < 3 ? sequence[n - 1] : jsonSuccess), { historyMode: 'harness', totalAttempts: 3 });
  const result = await post(f.address);
  assert.equal(result.text, jsonSuccess);
  assert.equal(result.headers['x-rhb-recovery'], 'encrypted-reasoning-dropped');
  assert.equal(f.requests.length, 3);
  const idProjected = body => {
    const clone = structuredClone(body);
    for (const item of clone.input) if (['message', 'reasoning', 'function_call', 'function_call_output'].includes(item.type)) delete item.id;
    return clone;
  };
  const first = sequence[0] === resource ? idProjected(history()) : downgrade(history());
  const second = sequence[0] === resource ? downgrade(first) : idProjected(first);
  assert.deepEqual(JSON.parse(f.requests[1].bytes), first);
  assert.deepEqual(JSON.parse(f.requests[2].bytes), second);
});

test('encrypted downgrade consumes the same total budget as transient recovery', async t => {
  const f = await fixture(t, (_req, res, n) => send(res, n === 1 ? 503 : 400, n === 1 ? '{"error":{"type":"server_error"}}' : encrypted), { historyMode: 'harness', totalAttempts: 2 });
  const result = await post(f.address);
  assert.equal(result.status, 400);
  assert.equal(result.text, encrypted);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0].bytes, f.requests[1].bytes);
  assert.equal(result.headers['x-rhb-recovery'], undefined);
});

for (const [name, modify] of [
  ['no cipher', b => { for (const item of b.input) delete item.encrypted_content; }],
  ['server ref', b => { b.previous_response_id = 'resp_server'; }],
  ['item reference', b => { b.input.push({ type: 'item_reference', id: 'ref_server' }); }],
  ['unknown input', b => { b.input.push({ type: 'future_item', id: 'future_id' }); }],
  ['unpaired tool', b => { b.input.pop(); }],
  ['malformed reasoning', b => { b.input[0].summary = null; }]
]) test(`${name} prevents cipher recovery and relays actual error instead of local409`, async t => {
  const body = history(); modify(body);
  const raw = Buffer.from(JSON.stringify(body, null, 2));
  const f = await fixture(t, (_req, res) => send(res, 400, encrypted), { historyMode: 'harness' });
  const result = await post(f.address, { body: raw });
  assert.equal(result.status, 400);
  assert.equal(result.text, encrypted);
  assert.equal(result.headers['x-rhb-recovery'], undefined);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].bytes, raw);
});

for (const prefix of [
  frame('response.output_text.delta', { delta: 'VISIBLE' }),
  frame('response.output_text.delta', { delta: ' ' }),
  frame('response.reasoning_text.delta', { delta: '\n' }),
  frame('response.reasoning_summary_text.delta', { delta: '\t' }),
  frame('response.output_item.added', { item: { type: 'function_call', call_id: 'call_new', name: 'Read', arguments: '' } }),
  frame('response.function_call_arguments.delta', { delta: ' ' }),
  frame('future.event', { payload: 'UNKNOWN' }),
  'unknown raw bytes\n\n'
]) test('output, whitespace, reasoning, tools or unknown SSE before cipher rejection prohibit replay', async t => {
  const original = lifecycle + prefix + failed;
  const f = await fixture(t, (_req, res) => send(res, 200, original, 'text/event-stream'), { historyMode: 'harness' });
  const result = await post(f.address);
  assert.equal(result.text, original);
  assert.equal(f.requests.length, 1);
  assert.equal(result.headers['x-rhb-recovery'], undefined);
});

test('a comment-only heartbeat before a cipher failure is metadata and not a replay barrier', async t => {
  const original = lifecycle + ': ping\n\n' + failed;
  const f = await fixture(t, (_req, res) => send(res, 200, original, 'text/event-stream'), { historyMode: 'harness' });
  const result = await post(f.address);
  assert.equal(result.text, original);
  assert.equal(f.requests.length, 2);
});

for (const suffix of ['unknown tail', 'data: {"type":"response.failed"', frame('future.event', { payload: 'UNKNOWN' }), frame('response.output_text.delta', { delta: 'TRAILING' })]) {
  test('trailing or partial EOF bytes after cipher error are not hidden by replay', async t => {
    const original = lifecycle + failed + suffix;
    const f = await fixture(t, (_req, res) => send(res, 200, original, 'text/event-stream'), { historyMode: 'harness' });
    const result = await post(f.address);
    assert.equal(result.text, original);
    assert.equal(f.requests.length, 1);
    assert.equal(result.headers['x-rhb-recovery'], undefined);
  });
}

for (const [name, payload, type, headers, options] of [
  ['truncated JSON', encrypted.slice(0, -1), 'application/json', {}, {}],
  ['unknown JSON field', JSON.stringify({ error: cipherError, future_output: 'UNKNOWN' }), 'application/json', {}, {}],
  ['text/plain', encrypted, 'text/plain', {}, {}],
  ['compressed cipher error', gzipSync(encrypted), 'application/json', { 'content-encoding': 'gzip' }, {}],
  ['buffer overflow', lifecycle + failed, 'text/event-stream', {}, { bufferLimit: 20 }]
]) test(`${name} does not cause encrypted replay`, async t => {
  const f = await fixture(t, (_req, res) => send(res, name === 'buffer overflow' ? 200 : 400, payload, type, headers), { historyMode: 'harness', generic400Projection: false, ...options });
  const result = await post(f.address);
  assert.deepEqual(result.bytes, Buffer.from(payload));
  assert.equal(f.requests.length, 1);
  assert.equal(result.headers['x-rhb-recovery'], undefined);
});

test('truncated transport after a cipher terminal does not manufacture success or replay', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(lifecycle + failed);
    setTimeout(() => res.destroy(), 50);
  }, { historyMode: 'harness' });
  await assert.rejects(post(f.address));
  assert.equal(f.requests.length, 1);
});

test('Retry-After beyond the shared deadline preserves cipher error without downgrade', async t => {
  const f = await fixture(t, (_req, res) => send(res, 400, encrypted, 'application/json', { 'retry-after': '10' }), { historyMode: 'harness', timeoutMs: 2000 });
  const result = await post(f.address);
  assert.equal(result.text, encrypted);
  assert.equal(f.requests.length, 1);
  assert.equal(result.headers['x-rhb-recovery'], undefined);
});

test('client cancellation during encrypted recovery sleep prevents another call', async t => {
  let startedSleep, suppliedSignal;
  const sleeping = new Promise(resolve => { startedSleep = resolve; });
  const f = await fixture(t, (_req, res) => send(res, 400, encrypted), { historyMode: 'harness', timeoutMs: 5000,
    sleep: (_ms, signal) => { suppliedSignal = signal; startedSleep(); return new Promise(() => {}); } });
  const req = http.request({ hostname: '127.0.0.1', port: f.address.port, method: 'POST', path: '/v1/responses', agent: false, headers: identity });
  req.on('error', () => {});
  req.end(JSON.stringify(history()));
  await sleeping;
  const aborted = suppliedSignal.aborted ? Promise.resolve() : once(suppliedSignal, 'abort');
  req.destroy();
  await aborted;
  assert.equal(f.requests.length, 1);
});

for (const mode of ['minimal', 'harness']) test(`${mode} generic invalid prose never removes cipher or adds recovery header`, async t => {
  const original = '{"error":{"type":"invalid_request_error","message":"Unable to decrypt encrypted content."}}';
  const f = await fixture(t, (_req, res) => send(res, 400, original), { historyMode: mode });
  const result = await post(f.address);
  assert.equal(result.text, original);
  assert.equal(result.headers['x-rhb-recovery'], undefined);
  assert.equal(f.requests.length, mode === 'harness' ? 2 : 1, 'legacy Harness generic projection remains available');
  for (const request of f.requests) assert.equal(JSON.parse(request.bytes).input[0].encrypted_content, history().input[0].encrypted_content);
  assert.equal(f.events.some(event => event.type === 'encrypted_reasoning_downgrade'), false);
});

for (const path of ['/v1/chat/completions', '/v1/responses/compact', '/v1/messages']) test(`${path} does not acquire new encrypted recovery`, async t => {
  const f = await fixture(t, (_req, res) => send(res, 400, encrypted), { historyMode: 'harness', automaticRecovery: true });
  const raw = Buffer.from(JSON.stringify(history(), null, 2));
  const result = await post(f.address, { path, body: raw });
  assert.equal(result.status, 400);
  assert.equal(result.text, encrypted);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].bytes, raw);
  assert.equal(result.headers['x-rhb-recovery'], undefined);
});

test('real loopback upstream is unchanged despite all recovery options and provider-spoofing headers', async t => {
  const f = await fixture(t, (_req, res) => send(res, 400, encrypted, 'application/json', { 'x-upstream-provider': 'agentrouter' }), {
    historyMode: 'harness', automaticRecovery: true, generic400Projection: true, historyStrategy: 'portable', upstreamProtocol: 'responses',
    sleep() { throw new Error('Bypass must not replay.'); }
  }, true);
  const raw = Buffer.from(JSON.stringify(history(), null, 2));
  const result = await post(f.address, { body: raw });
  assert.equal(result.status, 400);
  assert.equal(result.text, encrypted);
  assert.equal(result.headers['x-rhb-recovery'], undefined);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].bytes, raw);
  assert.equal(f.events.some(event => ['projection', 'recovery', 'encrypted_reasoning_downgrade'].includes(event.type)), false);
});

test('encrypted diagnostics expose lossy counts but no cipher, summary, history, tool or identity data', async t => {
  const f = await fixture(t, (_req, res, n) => send(res, n === 1 ? 400 : 200, n === 1 ? encrypted : jsonSuccess), { historyMode: 'harness' });
  assert.equal((await post(f.address)).text, jsonSuccess);
  const downgrades = f.events.filter(event => event.type === 'encrypted_reasoning_downgrade');
  assert.equal(downgrades.length, 1);
  const counters = downgrades[0].projection || downgrades[0];
  assert.equal(counters.lossy, true);
  assert.equal(counters.removedEncrypted, 2);
  assert.equal(counters.droppedReasoning, 1);
  assert.equal(counters.removedIds, 2);
  const serialized = JSON.stringify(f.events);
  for (const secret of [history().input[0].encrypted_content, 'SYNTHETIC_OPAQUE_B', 'SYNTHETIC_SUMMARY',
    'SYNTHETIC_TOOL_RESULT', 'call_keep', 'rs_summary', '{"a":42}', 'SYNTHETIC_CACHE', 'SYNTHETIC_SESSION',
    'SYNTHETIC_HEADER_SESSION', 'SYNTHETIC_HEADER_CACHE', 'Bearer SYNTHETIC_KEY', cipherError.message]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  const attempts = f.events.filter(event => event.type === 'attempt_start');
  assert.deepEqual(attempts.map(event => event.attempt), [1, 2]);
  assert.equal(attempts[0].requestId, attempts[1].requestId);
  assert.notEqual(attempts[0].attemptId, attempts[1].attemptId);
});

test('HTTP500 exact encrypted error is terminal, not a blind transient replay', async t => {
  const f = await fixture(t, (_req, res) => send(res, 500, encrypted), { historyMode: 'harness' });
  const result = await post(f.address);
  assert.equal(result.status, 500);
  assert.equal(result.text, encrypted);
  assert.equal(result.headers['x-rhb-recovery'], undefined);
  assert.equal(f.requests.length, 1);
  assert.equal(f.events.some(event => event.type === 'encrypted_reasoning_downgrade'), false);
});

test('transient recovery after ciphertext downgrade replays only current projected bytes', async t => {
  const f = await fixture(t, (_req, res, n) => {
    if (n === 1) send(res, 400, encrypted);
    else if (n === 2) send(res, 503, '{"error":{"type":"server_error","message":"Retry later."}}');
    else send(res, 200, jsonSuccess);
  }, { historyMode: 'harness', totalAttempts: 3 });
  const result = await post(f.address);
  assert.equal(result.text, jsonSuccess);
  assert.equal(result.headers['x-rhb-recovery'], 'encrypted-reasoning-dropped');
  assert.equal(f.requests.length, 3);
  assert.deepEqual(JSON.parse(f.requests[1].bytes), downgrade(history()));
  assert.deepEqual(f.requests[2].bytes, f.requests[1].bytes);
  assert.equal(f.events.filter(event => event.type === 'encrypted_reasoning_downgrade').length, 1);
});

test('upstream cannot spoof an applied ciphertext downgrade header', async t => {
  const f = await fixture(t, (_req, res) => send(res, 200, jsonSuccess, 'application/json', { 'x-rhb-recovery': 'encrypted-reasoning-dropped' }));
  const result = await post(f.address);
  assert.equal(result.text, jsonSuccess);
  assert.equal(result.headers['x-rhb-recovery'], undefined);
  assert.equal(f.requests.length, 1);
  assert.equal(f.events.some(event => event.type === 'encrypted_reasoning_downgrade'), false);
});
