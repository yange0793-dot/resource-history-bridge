'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { gzipSync } = require('node:zlib');
const { createBridge } = require('../lib/bridge');
const { createRecoverySession } = require('../lib/recovery-session');
const { mockAgentRouter } = require('../scripts/mock-agentrouter.cjs');

const official = 'https://agentrouter.org/v1';
const resourceMessage = 'The requested item was created under a different Azure OpenAI resource.';
const resource = { error: { type: 'invalid_request_error', message: resourceMessage } };
const scoped = { error: { type: 'invalid_request_error', message: 'Upstream rejected the request as invalid [trace_id=SYNTHETIC_TRANSPARENT_TRACE]', param: '', code: null } };
const transient = { error: { type: 'server_error', message: 'Synthetic backend temporarily unavailable.' } };
const cipher = { error: { type: 'invalid_request_error', code: 'invalid_encrypted_content', message: 'SYNTHETIC_CIPHER_FAILURE' } };
const json = value => Buffer.from(JSON.stringify(value));
const frame = (type, fields = {}) => Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
const lifecycle = frame('response.created', { response: { status: 'in_progress', output: [] } });
const heartbeat = Buffer.from(':keepalive\n\n');
const success = json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SYNTHETIC_TRANSPARENT_RESULT' }] }] });
const completed = frame('response.completed', { response: JSON.parse(success) });
const failed = payload => frame('response.failed', { response: { status: 'failed', output: [], error: payload.error } });
const identity = { 'content-type': 'application/json', authorization: 'Bearer SYNTHETIC_TRANSPARENT_KEY',
  'x-session-id': 'SYNTHETIC_SESSION', 'x-cache-key': 'SYNTHETIC_CACHE', 'user-agent': 'transparent-recovery-fixture/1' };
const history = () => ({ model: 'synthetic-transparent-model', stream: false, store: false, session_id: 'SYNTHETIC_SESSION',
  prompt_cache_key: 'SYNTHETIC_CACHE', reasoning: { effort: 'high' }, tools: [{ type: 'function', name: 'add', strict: false,
    parameters: { type: 'object', properties: { a: { type: 'number' } }, required: [] } }], input: [
    { role: 'user', content: [{ type: 'input_text', text: 'Compute the supplied tool result.' }] },
    { type: 'reasoning', id: 'rs_keep', summary: [{ type: 'summary_text', text: 'SYNTHETIC_SUMMARY' }], encrypted_content: 'SYNTHETIC_OPAQUE' },
    { type: 'function_call', id: 'fc_keep', call_id: 'call_keep', name: 'add', arguments: '{"a":42}' },
    { type: 'function_call_output', id: 'fo_keep', call_id: 'call_keep', output: '42' }
  ] });
function builtinHistory() {
  const body = history();
  body.input.push({ type: 'web_search_call', id: 'ws_keep', status: 'completed', action: { type: 'search', query: 'SYNTHETIC_QUERY' } });
  return body;
}
function rawHistory(body = builtinHistory()) {
  const reordered = { input: body.input, tools: body.tools, reasoning: body.reasoning, prompt_cache_key: body.prompt_cache_key,
    session_id: body.session_id, store: body.store, stream: body.stream, model: body.model };
  return Buffer.from(' \t\r\n' + JSON.stringify(reordered, null, 2) + '\n');
}
// The shared retry keeps the exact current bytes after reporting why projection
// was skipped; the code is the verified projection's own failure reason.
const skippedReason = { auto: 'invalid_history_item', codex: 'unsupported_item_id', harness: 'unsupported_item_id' };
const proof = () => ({ hasOutput: false, unknown: false, committed: false });
const failure = (payload = resource, statusCode = 400, extra = {}) => ({ payload, statusCode, inspectionComplete: true,
  responseComplete: true, output: proof(), ...extra });
const session = (options = {}) => createRecoverySession({ upstream: official, body: history(), now: () => 1000,
  retryDelayMs: 0, random: () => 0, ...options });
function frozen(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}

async function fixture(t, handler, options = {}, bypass = false) {
  const requests = [], events = [], sockets = new Set();
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const entry = { bytes: Buffer.concat(chunks), headers: req.headers, path: req.url };
    requests.push(entry);
    handler(req, res, requests.length, entry);
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
    timeoutMs: 3000, retryDelayMs: 0, retryJitterRatio: 0,
    diagnostics: { enabled: true, onEvent: event => events.push(event) }, ...options });
  return { address: await bridge.listen(0), bridge, requests, events };
}
function send(res, status, bytes, type = 'application/json', headers = {}) {
  res.writeHead(status, { 'content-type': type, 'content-length': String(bytes.length), 'x-original-upstream': 'preserved', ...headers });
  res.end(bytes);
}
function post(address, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path: options.path || '/v1/responses', method: 'POST',
      agent: false, headers: { ...identity, ...options.headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Synthetic transparent recovery request timed out.')));
    req.end(options.body === undefined ? rawHistory() : options.body);
  });
}
function preserved(requests, bytes, headers = identity) {
  for (const request of requests) {
    assert.deepEqual(request.bytes, bytes);
    for (const name of ['authorization', 'x-session-id', 'x-cache-key', 'user-agent']) assert.equal(request.headers[name], headers[name]);
    assert.equal(request.path, '/v1/responses');
    assert.equal(request.headers['content-length'], String(bytes.length));
  }
}

for (const [name, status, payload] of [
  ['408 timeout', 408, { error: { code: 'request_timeout', message: 'Synthetic request timeout.' } }],
  ['409 conflict', 409, { error: { code: 'conflict', message: 'Synthetic temporary conflict.' } }],
  ['429 temporary rate limit', 429, { error: { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'Rate limit reached. Try again shortly.' } }],
  ['500', 500, transient], ['502', 502, transient], ['503', 503, transient], ['504', 504, transient]
]) test(`default transparent official ${name} retries invisibly with exact current bytes`, async t => {
  const raw = rawHistory();
  const f = await fixture(t, (_req, res, n) => send(res, n <= 2 ? status : 200, n <= 2 ? json(payload) : success,
    'application/json', { 'x-original-attempt': String(n) }));
  const result = await post(f.address, { body: raw });
  assert.equal(result.status, 200);
  assert.deepEqual(result.bytes, success);
  assert.equal(result.headers['x-original-attempt'], '3');
  assert.equal(result.headers['x-rhb-recovery'], undefined);
  assert.equal(f.requests.length, 3);
  preserved(f.requests, raw);
});

for (const [name, status, payload] of [
  ['authentication', 401, { error: { code: 'invalid_api_key', message: 'Synthetic invalid API key.' } }],
  ['authentication labeled 503', 503, { error: { type: 'authentication_error' } }],
  ['permission', 403, { error: { code: 'permission_denied' } }],
  ['schema', 400, { error: { code: 'invalid_tool_schema' } }],
  ['schema labeled 503', 503, { error: { code: 'invalid_schema' } }],
  ['quota 429', 429, { error: { type: 'insufficient_quota', message: 'Synthetic quota exhausted.' } }],
  ['billing 429', 429, { error: { code: 'billing_hard_limit_reached', message: 'Synthetic billing hard limit reached.' } }],
  ['quota masked as rate limit', 429, { error: { type: 'rate_limit_error', code: 'insufficient_quota', message: 'Synthetic quota exhausted.' } }],
  ['context', 400, { error: { code: 'context_length_exceeded' } }],
  ['policy', 400, { error: { code: 'content_policy_violation' } }],
  ['generic invalid request', 400, { error: { type: 'invalid_request_error', message: 'Bad request.' } }],
  ['generic 400 mislabeled server', 400, transient],
  ['unproven scoped history prose', 400, { error: { type: 'invalid_request_error', message: scoped.error.message } }]
]) test(`transparent recovery leaves ${name} terminal and preserves actual upstream bytes`, async t => {
  const bytes = Buffer.from(' \t\n' + JSON.stringify(payload, null, 2) + '\n');
  const f = await fixture(t, (_req, res) => send(res, status, bytes));
  const result = await post(f.address);
  assert.equal(result.status, status);
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.headers['content-length'], String(bytes.length));
  assert.equal(result.headers['x-original-upstream'], 'preserved');
  assert.equal(result.headers['x-rhb-recovery'], undefined);
  assert.equal(f.requests.length, 1);
});

for (const payload of [resource, scoped]) for (const historyMode of ['auto', 'codex', 'harness']) {
  test(`${historyMode} unprojectable builtin ${payload === resource ? 'Azure' : 'official wrapper'} history retries current exact bytes`, async t => {
    const raw = rawHistory();
    const f = await fixture(t, (_req, res, n) => send(res, n <= 2 ? 400 : 200, n <= 2 ? json(payload) : success),
      { historyMode, automaticRecovery: false });
    const result = await post(f.address, { body: raw });
    assert.equal(result.status, 200);
    assert.deepEqual(result.bytes, success);
    assert.equal(result.headers['x-rhb-recovery'], undefined);
    assert.equal(f.requests.length, 3);
    preserved(f.requests, raw);
    assert.equal(f.events.some(event => event.type === 'encrypted_reasoning_downgrade'), false);
    assert.equal(f.events.some(event => event.type === 'projection' && event.projection?.ok), false);
  });
}

for (const payload of [resource, scoped]) test(`unprojectable ${payload === resource ? 'Azure' : 'wrapper'} exhaustion returns last actual error after ten total calls`, async t => {
  const raw = rawHistory();
  const f = await fixture(t, (_req, res, n) => send(res, 400, Buffer.from(` \n${JSON.stringify(payload)}\n${' '.repeat(n)}`),
    'application/json', { 'x-original-attempt': String(n) }));
  const result = await post(f.address, { body: raw });
  assert.equal(f.requests.length, 10);
  assert.equal(result.status, 400);
  assert.deepEqual(result.bytes, Buffer.from(` \n${JSON.stringify(payload)}\n${' '.repeat(10)}`));
  assert.equal(result.headers['x-original-attempt'], '10');
  assert.equal(result.headers['x-rhb-recovery'], undefined);
  preserved(f.requests, raw);
});

test('embedded unprojectable resource retry records a skipped-projection reason, not a fictitious projection', () => {
  const body = builtinHistory(), before = structuredClone(body), raw = rawHistory(body);
  const s = session({ body: frozen(body), rawBody: raw });
  const decision = s.decide(frozen(failure()));
  assert.equal(decision.retry, true);
  assert.equal(decision.classification, 'resource');
  assert.deepEqual(decision.projectionSkipped, { reason: 'invalid_history_item' });
  assert.deepEqual(Object.keys(decision.projectionSkipped), ['reason']);
  assert.equal(decision.projectHistory, false);
  assert.equal(decision.projection, null);
  assert.equal(decision.projectionError, null);
  assert.equal(decision.lossy, false);
  assert.deepEqual(decision.recoveryHeaders, {});
  assert.deepEqual(decision.rawBody, raw);
  assert.deepEqual(decision.body, before);
  assert.deepEqual(body, before);
  assert.equal(s.current().state.resourceRetries, 1);
});

for (const historyMode of ['auto', 'codex', 'harness']) test(`embedded ${historyMode} unprojectable history reports the shared skipped reason on every replay`, () => {
  const body = builtinHistory(), raw = rawHistory(body);
  const s = session({ body, rawBody: raw, historyMode });
  for (let n = 0; n < 3; n++) {
    const decision = s.decide(failure());
    assert.equal(decision.retry, true);
    assert.equal(decision.classification, 'resource');
    assert.deepEqual(decision.projectionSkipped, { reason: skippedReason[historyMode] });
    assert.equal(decision.projection, null);
    assert.equal(decision.projectHistory, false);
    assert.deepEqual(decision.rawBody, raw);
  }
  assert.equal(s.current().state.resourceRetries, 3);
});

for (const [name, item] of [
  ['searching status', { type: 'web_search_call', id: 'w_status', status: 'searching', action: { type: 'search', query: 'SYNTHETIC_QUERY' } }],
  ['absent status', { type: 'web_search_call', id: 'w_absent', action: { type: 'search', query: 'SYNTHETIC_QUERY' } }],
  ['incomplete status', { type: 'web_search_call', id: 'w_incomplete', status: 'incomplete', action: { type: 'search', query: 'SYNTHETIC_QUERY' } }],
  ['search with url', { type: 'web_search_call', id: 'w_url', status: 'completed', action: { type: 'search', query: 'SYNTHETIC_QUERY', url: 'https://example.invalid' } }],
  ['empty search query', { type: 'web_search_call', id: 'w_empty', status: 'completed', action: { type: 'search', query: '' } }],
  ['find without pattern', { type: 'web_search_call', id: 'w_find', status: 'completed', action: { type: 'find', url: 'https://example.invalid' } }],
  ['unknown action type', { type: 'web_search_call', id: 'w_unknown', status: 'completed', action: { type: 'browse', query: 'SYNTHETIC_QUERY' } }],
  ['extra action subfield', { type: 'web_search_call', id: 'w_sources', status: 'completed', action: { type: 'search', query: 'SYNTHETIC_QUERY', sources: [] } }]
]) test(`builtin ${name} is not a verified builtin and never becomes a transparent retry candidate`, async t => {
  const body = history();
  body.input.push(item);
  const s = session({ body, historyMode: 'auto' });
  assert.equal(s.decide(failure()).retry, false);
  assert.equal(s.current().attempt, 1);
  const f = await fixture(t, (_req, res) => send(res, 400, json(resource)));
  const result = await post(f.address, { body: Buffer.from(JSON.stringify(body)) });
  assert.equal(result.status, 400);
  assert.deepEqual(result.bytes, json(resource));
  assert.equal(f.requests.length, 1);
});

for (const item of [
  { type: 'web_search_call', id: 'w_open', status: 'completed', action: { type: 'open_page', url: 'https://example.invalid' } },
  { type: 'web_search_call', id: 'w_find', status: 'completed', action: { type: 'find', url: 'https://example.invalid', pattern: 'SYNTHETIC_PATTERN' } }
]) test(`builtin ${item.action.type} is verified and retries current exact bytes`, async t => {
  const body = history();
  body.input.push(item);
  const raw = Buffer.from(JSON.stringify(body, null, 2));
  const f = await fixture(t, (_req, res, n) => send(res, n <= 2 ? 400 : 200, n <= 2 ? json(resource) : success));
  const result = await post(f.address, { body: raw });
  assert.deepEqual(result.bytes, success);
  assert.equal(f.requests.length, 3);
  preserved(f.requests, raw);
});

test('converted official Messages stays single-attempt even when transparentRecovery is requested', async t => {
  const bytes = json(transient), raw = json({ model: 'synthetic-messages-model', max_tokens: 20, stream: false, messages: [{ role: 'user', content: 'Hello.' }] });
  const f = await fixture(t, (_req, res) => send(res, 503, bytes), { transparentRecovery: true });
  const result = await post(f.address, { path: '/v1/messages', body: raw });
  assert.equal(result.status, 503);
  assert.deepEqual(result.bytes, bytes);
  assert.equal(f.requests.length, 1);
  assert.equal(JSON.parse(f.requests[0].bytes).model, 'synthetic-messages-model');
  assert.equal(Object.hasOwn(JSON.parse(f.requests[0].bytes), 'messages'), false);
});

test('native responses still retry with the same global transparent option', async t => {
  const raw = rawHistory();
  const f = await fixture(t, (_req, res, n) => send(res, n <= 2 ? 503 : 200, n <= 2 ? json(transient) : success), { transparentRecovery: true });
  assert.deepEqual((await post(f.address, { body: raw })).bytes, success);
  assert.equal(f.requests.length, 3);
  preserved(f.requests, raw);
});

test('transparent defaults have a single 10/3/10 budget and 180000ms deadline', () => {
  const s = session();
  const current = s.current();
  assert.equal(current.state.policy.totalAttempts, 10);
  assert.equal(current.state.policy.transientAttempts, 3);
  assert.equal(current.state.policy.resourceAttempts, 10);
  assert.equal(current.deadlineAtMs, 181000);
  assert.equal(s.decide(failure(transient, 503)).retry, true);
  assert.equal(s.current().state.transientRetries, 1);
});

test('transient and unprojectable resource retries compose without resetting raw body, count or deadline', () => {
  let now = 1000;
  const body = builtinHistory(), raw = rawHistory(body);
  const s = session({ body, rawBody: raw, now: () => now });
  for (let n = 0; n < 2; n++) {
    now += 10;
    assert.equal(s.decide(failure(transient, 503)).retry, true);
  }
  for (let n = 0; n < 7; n++) {
    now += 10;
    const decision = s.decide(failure());
    assert.equal(decision.retry, true);
    assert.deepEqual(decision.projectionSkipped, { reason: 'invalid_history_item' });
    assert.deepEqual(decision.rawBody, raw);
    assert.equal(s.current().deadlineAtMs, 181000);
  }
  assert.equal(s.current().attempt, 10);
  assert.equal(s.current().state.transientRetries, 2);
  assert.equal(s.current().state.resourceRetries, 7);
  assert.equal(s.decide(failure()).reason, 'total_attempt_budget');
  assert.equal(s.current().attempt, 10);
});

test('bridge transient-to-resource composition shares ten total calls and final upstream failure', async t => {
  const raw = rawHistory();
  const f = await fixture(t, (_req, res, n) => send(res, n <= 2 ? 503 : 400, n <= 2 ? json(transient) : json(resource),
    'application/json', { 'x-original-attempt': String(n) }));
  const result = await post(f.address, { body: raw });
  assert.equal(f.requests.length, 10);
  assert.equal(result.status, 400);
  assert.deepEqual(result.bytes, json(resource));
  assert.equal(result.headers['x-original-attempt'], '10');
  preserved(f.requests, raw);
});

test('resource retry cannot reset the transient category budget', () => {
  const s = session({ body: builtinHistory() });
  assert.equal(s.decide(failure(transient, 503)).retry, true);
  assert.equal(s.decide(failure()).retry, true);
  assert.equal(s.decide(failure(transient, 503)).retry, true);
  assert.equal(s.decide(failure()).retry, true);
  assert.equal(s.decide(failure(transient, 503)).reason, 'transient_attempt_budget');
  assert.equal(s.current().attempt, 5);
});

test('current raw bytes and body are isolated from caller and public decision mutation', () => {
  const body = builtinHistory(), before = structuredClone(body), raw = rawHistory(body), bytes = Buffer.from(raw);
  const s = session({ body, rawBody: raw });
  body.input.at(-1).action.query = 'CALLER_MUTATED';
  raw.fill(0);
  const decision = s.decide(frozen(failure()));
  assert.equal(decision.retry, true);
  assert.deepEqual(decision.body, before);
  assert.deepEqual(decision.rawBody, bytes);
  decision.body.input[1].encrypted_content = 'PUBLIC_MUTATED';
  decision.rawBody.fill(0);
  assert.throws(() => { decision.nextState.attempt = 99; }, TypeError);
  assert.deepEqual(s.current().rawBody, bytes);
  assert.deepEqual(s.current().body, before);
});

test('concurrent requests isolate transient/resource counts and identity', async t => {
  const counts = new Map();
  const f = await fixture(t, (_req, res, _n, entry) => {
    const body = JSON.parse(entry.bytes), count = (counts.get(body.model) || 0) + 1;
    counts.set(body.model, count);
    const resourceRequest = body.model === 'synthetic-resource-model';
    const retry = count <= (resourceRequest ? 4 : 2);
    setImmediate(() => send(res, retry ? resourceRequest ? 400 : 503 : 200, retry ? json(resourceRequest ? resource : transient) : success));
  });
  const resourceBody = builtinHistory(), transientBody = builtinHistory();
  resourceBody.model = 'synthetic-resource-model'; transientBody.model = 'synthetic-transient-model';
  const a = rawHistory(resourceBody), b = rawHistory(transientBody);
  const headersA = { ...identity, 'x-session-id': 'SYNTHETIC_SESSION_A', 'x-cache-key': 'SYNTHETIC_CACHE_A' };
  const headersB = { ...identity, authorization: 'Bearer SYNTHETIC_OTHER_KEY', 'x-session-id': 'SYNTHETIC_SESSION_B' };
  const results = await Promise.all([post(f.address, { body: a, headers: headersA }), post(f.address, { body: b, headers: headersB })]);
  for (const result of results) { assert.deepEqual(result.bytes, success); assert.equal(result.headers['x-rhb-recovery'], undefined); }
  const entriesA = f.requests.filter(entry => JSON.parse(entry.bytes).model === resourceBody.model);
  const entriesB = f.requests.filter(entry => JSON.parse(entry.bytes).model === transientBody.model);
  assert.equal(entriesA.length, 5); assert.equal(entriesB.length, 3);
  preserved(entriesA, a, headersA); preserved(entriesB, b, headersB);
});

for (const [name, status, bytes, type] of [
  ['temporary HTTP error', 503, json(transient), 'application/json'],
  ['resource HTTP error', 400, json(resource), 'application/json'],
  ['SSE transient error', 200, Buffer.concat([heartbeat, lifecycle, failed(transient)]), 'text/event-stream']
]) test(`nonofficial ${name} remains exact single-attempt passthrough despite transparent opt-in`, async t => {
  const raw = rawHistory();
  const f = await fixture(t, (_req, res) => send(res, status, bytes, type), { transparentRecovery: true, automaticRecovery: true }, true);
  const result = await post(f.address, { body: raw });
  assert.equal(result.status, status); assert.deepEqual(result.bytes, bytes);
  assert.equal(f.requests.length, 1); preserved(f.requests, raw);
});

test('nonofficial compressed native Messages retain beta query, bytes and authentication unchanged', async t => {
  const raw = gzipSync(json({ model: 'synthetic-other', messages: [{ role: 'user', content: 'Synthetic input.' }], provider_specific: 'PRESERVE' }));
  const bytes = gzipSync(json(transient));
  const f = await fixture(t, (_req, res) => send(res, 503, bytes, 'application/json', { 'content-encoding': 'gzip' }),
    { transparentRecovery: true }, true);
  const result = await post(f.address, { path: '/v1/messages?beta=true', body: raw,
    headers: { 'content-encoding': 'gzip', 'x-api-key': 'SYNTHETIC_NATIVE_KEY', 'accept-encoding': 'gzip, br' } });
  assert.deepEqual(result.bytes, bytes); assert.equal(result.headers['content-encoding'], 'gzip');
  assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0].bytes, raw);
  assert.equal(f.requests[0].path, '/v1/messages?beta=true');
  assert.equal(f.requests[0].headers['x-api-key'], 'SYNTHETIC_NATIVE_KEY');
  assert.equal(f.requests[0].headers.authorization, identity.authorization);
  assert.equal(f.requests[0].headers['accept-encoding'], 'gzip, br');
});

for (const [name, bytes] of [
  ['legitimate empty completion', frame('response.completed', { response: { status: 'completed', output: [] } })],
  ['no-detail failed response', frame('response.failed', { response: { status: 'failed', output: [], error: null } })],
  ['empty clean EOF', Buffer.alloc(0)], ['metadata clean EOF', lifecycle], ['heartbeat clean EOF', heartbeat]
]) {
  for (const historyMode of ['auto', 'codex', 'harness']) test(`transparent-only ${historyMode} ${name} is not replayed`, async t => {
    const f = await fixture(t, (_req, res) => send(res, 200, bytes, 'text/event-stream'), { historyMode, automaticRecovery: false });
    const result = await post(f.address);
    assert.deepEqual(result.bytes, bytes); assert.equal(result.status, 200); assert.equal(f.requests.length, 1);
  });
  test(`legacy automaticRecovery opt-in may recover ${name}`, async t => {
    const raw = rawHistory();
    const f = await fixture(t, (_req, res, n) => send(res, 200, n <= 2 ? bytes : completed, 'text/event-stream'), { automaticRecovery: true });
    const result = await post(f.address, { body: raw });
    assert.deepEqual(result.bytes, completed); assert.equal(f.requests.length, 3); preserved(f.requests, raw);
  });
}

for (const prefix of [heartbeat, lifecycle, Buffer.concat([heartbeat, lifecycle, heartbeat])]) {
  test('comment-only heartbeats and lifecycle plus pure transient SSE failure retry before output', async t => {
    const raw = rawHistory(), original = Buffer.concat([prefix, failed(transient)]);
    const f = await fixture(t, (_req, res, n) => send(res, 200, n <= 2 ? original : completed, 'text/event-stream'));
    const result = await post(f.address, { body: raw });
    assert.deepEqual(result.bytes, completed); assert.equal(f.requests.length, 3); preserved(f.requests, raw);
  });
}

test('SSE transient exhaustion retains exact last metadata/error stream, not an invented bridge error', async t => {
  const original = Buffer.concat([heartbeat, lifecycle, failed(transient)]);
  const f = await fixture(t, (_req, res, n) => send(res, 200, original, 'text/event-stream', { 'x-original-attempt': String(n) }));
  const result = await post(f.address);
  assert.equal(f.requests.length, 3); assert.equal(result.status, 200); assert.deepEqual(result.bytes, original);
  assert.equal(result.headers['x-original-attempt'], '3');
});

for (const [name, prefix, tail] of [
  ['text', frame('response.output_text.delta', { delta: 'VISIBLE' })],
  ['whitespace text', frame('response.output_text.delta', { delta: ' ' })],
  ['reasoning', frame('response.reasoning_text.delta', { delta: 'SYNTHETIC_THINKING' })],
  ['whitespace reasoning', frame('response.reasoning_summary_text.delta', { delta: '\n' })],
  ['tool', frame('response.output_item.added', { output_index: 0, item: { type: 'function_call', call_id: 'call_new', name: 'Read', arguments: '' } })],
  ['builtin tool', frame('response.output_item.added', { output_index: 0, item: { type: 'web_search_call', id: 'ws_new', status: 'in_progress' } })],
  ['unknown event', frame('response.future_event', { future_content: 'UNKNOWN' })],
  ['unknown lifecycle field', frame('response.created', { future_content: 'UNKNOWN', response: { status: 'in_progress', output: [] } })],
  ['unknown SSE field', Buffer.from('id: unknown\n\n')],
  ['event-only heartbeat', Buffer.from(':keepalive\nevent: ping\n\n')],
  ['malformed data', Buffer.from('data: {not JSON}\n\n')],
  ['scalar data', Buffer.from('data: "UNKNOWN"\n\n')],
  ['partial trailing frame', Buffer.alloc(0), Buffer.from('data: {"type":"response.output_text.delta"')]
]) test(`${name} SSE is an exact irreversible no-replay barrier`, async t => {
  const bytes = Buffer.concat([lifecycle, prefix, failed(transient), tail || Buffer.alloc(0)]);
  const f = await fixture(t, (_req, res) => send(res, 200, bytes, 'text/event-stream'));
  const result = await post(f.address);
  assert.deepEqual(result.bytes, bytes); assert.equal(f.requests.length, 1);
});

test('pre-header network failures retry transparently and remain within three total transient calls', async t => {
  const raw = rawHistory();
  const f = await fixture(t, (req, res, n) => { if (n <= 2) req.socket.destroy(); else send(res, 200, success); });
  const result = await post(f.address, { body: raw });
  assert.deepEqual(result.bytes, success); assert.equal(f.requests.length, 3); preserved(f.requests, raw);
});

test('pre-header network exhaustion stops after three calls with transport failure', async t => {
  const f = await fixture(t, req => req.socket.destroy());
  const result = await post(f.address);
  assert.equal(result.status, 502); assert.equal(f.requests.length, 3);
  assert.equal(JSON.parse(result.bytes).error.code, 'upstream_transport');
});

test('metadata-only real disconnect retries while clean metadata EOF does not', async t => {
  const raw = rawHistory();
  const f = await fixture(t, (_req, res, n) => {
    if (n > 1) return send(res, 200, completed, 'text/event-stream');
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(lifecycle);
    setImmediate(() => res.destroy());
  });
  const result = await post(f.address, { body: raw });
  assert.deepEqual(result.bytes, completed); assert.equal(f.requests.length, 2); preserved(f.requests, raw);
});

test('transparent deadline stays monotonic across resource and transient reservations', () => {
  let now = 1000;
  const s = session({ body: builtinHistory(), timeoutMs: 100, now: () => now });
  now = 1030; assert.equal(s.decide(failure()).retry, true);
  now = 1070; assert.equal(s.decide(failure(transient, 503)).retry, true);
  now = 1050; assert.equal(s.decide(failure()).retry, true);
  assert.equal(s.current().state.lastNowMs, 1070);
  assert.equal(s.current().deadlineAtMs, 1100);
  now = 1100; assert.equal(s.decide(failure()).reason, 'deadline_expired');
  now = 1000; assert.equal(s.decide(failure()).retry, false);
  assert.equal(s.current().attempt, 4);
});

test('server retry delay beyond deadline relays last actual error without another upstream call', async t => {
  const bytes = json(transient);
  // Still far below the 10 s hint, so the branch is unchanged; the larger budget
  // only keeps one loopback round trip from deciding the test on a busy machine.
  const f = await fixture(t, (_req, res) => send(res, 503, bytes, 'application/json', { 'retry-after': '10' }), { timeoutMs: 1000 });
  const result = await post(f.address);
  assert.equal(result.status, 503); assert.deepEqual(result.bytes, bytes); assert.equal(f.requests.length, 1);
});

test('shared deadline expiring during retry delay preserves last actual upstream response', async t => {
  let now = 1000;
  const f = await fixture(t, (_req, res) => send(res, 503, json(transient)),
    { timeoutMs: 100, now: () => now, sleep: async () => { now += 200; } });
  const result = await post(f.address);
  assert.equal(result.status, 503); assert.deepEqual(result.bytes, json(transient)); assert.equal(f.requests.length, 1);
});

const sleepReached = promise => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('Transparent recovery never entered its retry sleep.')), 1000).unref())]);

test('downstream cancellation aborts retry sleep without issuing another call', { timeout: 5000 }, async t => {
  let sleeping, cancelled;
  const reachedSleep = new Promise(resolve => { sleeping = resolve; });
  const sawAbort = new Promise(resolve => { cancelled = resolve; });
  const f = await fixture(t, (_req, res) => send(res, 503, json(transient)), { sleep: (_ms, signal) => {
    sleeping();
    return new Promise((_, reject) => signal.addEventListener('abort', () => { cancelled(); reject(new Error('SYNTHETIC_CANCELLED')); }, { once: true }));
  } });
  const req = http.request({ hostname: '127.0.0.1', port: f.address.port, path: '/v1/responses', method: 'POST', headers: identity });
  req.on('error', () => {}); req.end(rawHistory());
  await sleepReached(reachedSleep); req.destroy();
  await Promise.race([sawAbort, new Promise((_, reject) => setTimeout(() => reject(new Error('Cancellation did not abort the retry sleep.')), 1000).unref())]);
  assert.equal(f.requests.length, 1);
});

test('bridge shutdown cancels transparent retry sleep without another upstream call', { timeout: 5000 }, async t => {
  let sleeping;
  const reachedSleep = new Promise(resolve => { sleeping = resolve; });
  const f = await fixture(t, (_req, res) => send(res, 503, json(transient)), { sleep: (_ms, signal) => {
    sleeping();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('SYNTHETIC_SHUTDOWN')), { once: true }));
  } });
  const result = post(f.address).catch(() => null);
  await sleepReached(reachedSleep); await f.bridge.close(); await result;
  assert.equal(f.requests.length, 1);
});

for (const output of [{ hasOutput: true }, { unknown: true }, { committed: true }]) test('embedded output barrier is permanent after caller drops its flags', () => {
  const s = session({ body: builtinHistory() });
  assert.equal(s.decide(failure(transient, 503, { output: { ...proof(), ...output } })).retry, false);
  assert.equal(s.decide(failure()).retry, false); assert.equal(s.current().attempt, 1);
});

for (const cancellation of [{ cancelled: true }, { aborted: true }, { failureKind: 'client_closed' }]) test('embedded cancellation cannot reserve an attempt or restart later', () => {
  const s = session({ body: builtinHistory() });
  assert.equal(s.decide(cancellation).reason, 'cancelled');
  assert.equal(s.decide(failure()).retry, false); assert.equal(s.current().attempt, 1);
});

test('default auto and codex still leave empty completion single-attempt without any opt-in', async t => {
  const bytes = frame('response.completed', { response: { status: 'completed', output: [] } });
  for (const historyMode of ['auto', 'codex']) {
    const f = await fixture(t, (_req, res) => send(res, 200, bytes, 'text/event-stream'), { historyMode });
    assert.deepEqual((await post(f.address)).bytes, bytes);
    assert.equal(f.requests.length, 1);
  }
});

test('default harness keeps its legacy empty-recovery preset while transparent adds transient retries', async t => {
  const raw = rawHistory();
  const empty = frame('response.completed', { response: { status: 'completed', output: [] } });
  const f = await fixture(t, (_req, res, n) => send(res, n === 2 ? 503 : 200,
    n === 1 ? empty : n === 2 ? json(transient) : completed,
    n === 2 ? 'application/json' : 'text/event-stream'), { historyMode: 'harness' });
  const result = await post(f.address, { body: raw });
  assert.deepEqual(result.bytes, completed);
  assert.equal(f.requests.length, 3);
  preserved(f.requests, raw);
});

test('default harness empty recovery and transparent retries share the legacy empty preset budget', async t => {
  const empty = frame('response.completed', { response: { status: 'completed', output: [] } });
  const f = await fixture(t, (_req, res) => send(res, 200, empty, 'text/event-stream'), { historyMode: 'harness' });
  assert.deepEqual((await post(f.address)).bytes, empty);
  assert.equal(f.requests.length, 3);
});

test('default minimal keeps transparent retries off until explicitly enabled', async t => {
  const bytes = json(transient);
  const f = await fixture(t, (_req, res) => send(res, 503, bytes), { historyMode: 'minimal' });
  const result = await post(f.address);
  assert.equal(result.status, 503);
  assert.deepEqual(result.bytes, bytes);
  assert.equal(f.requests.length, 1);
});

for (const historyMode of ['auto', 'codex', 'harness']) test(`transparentRecovery:false retains ${historyMode} legacy no-transient behavior when automaticRecovery:false`, async t => {
  const f = await fixture(t, (_req, res) => send(res, 503, json(transient)), { historyMode, transparentRecovery: false, automaticRecovery: false });
  const result = await post(f.address);
  assert.equal(result.status, 503); assert.deepEqual(result.bytes, json(transient)); assert.equal(f.requests.length, 1);
});

test('transparentRecovery:false leaves unprojectable legacy auto history as original single-attempt failure', async t => {
  const f = await fixture(t, (_req, res) => send(res, 400, json(resource)), { transparentRecovery: false });
  const result = await post(f.address);
  assert.equal(result.status, 400); assert.deepEqual(result.bytes, json(resource)); assert.equal(f.requests.length, 1);
});

test('minimal mode stays transparent-disabled by default but explicit opt-in works', () => {
  const legacy = session({ historyMode: 'minimal' });
  assert.equal(legacy.decide(failure(transient, 503)).retry, false);
  const opted = session({ historyMode: 'minimal', transparentRecovery: true });
  assert.equal(opted.decide(failure(transient, 503)).retry, true);
  assert.equal(opted.current().attempt, 2);
});

for (const transparentRecovery of [false, true]) test(`cipher downgrade remains single-use with transparentRecovery:${transparentRecovery}`, () => {
  const body = history(), before = structuredClone(body);
  const s = session({ body: frozen(body), transparentRecovery });
  const first = s.decide(frozen(failure(cipher)));
  assert.equal(first.retry, true); assert.equal(first.lossy, true);
  assert.equal(first.recoveryHeaders['x-rhb-recovery'], 'encrypted-reasoning-dropped');
  assert.equal(first.body.input[1].encrypted_content, undefined);
  assert.equal(s.current().state.encryptedRetries, 1);
  assert.equal(s.decide(failure(cipher)).retry, false);
  assert.equal(s.current().attempt, 2);
  assert.deepEqual(body, before);
});

for (const value of ['true', 1, null]) test(`transparentRecovery rejects nonboolean ${JSON.stringify(value)}`, () => {
  assert.throws(() => session({ transparentRecovery: value }), TypeError);
  assert.throws(() => createBridge({ upstream: official, transparentRecovery: value }), TypeError);
});
