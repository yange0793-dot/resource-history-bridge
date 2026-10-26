'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { once } = require('node:events');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createBridge } = require('../lib/bridge');
const { projectResponsesHistory } = require('../lib/history');
const { isScopedHistoryFailure } = require('../lib/recovery');

const projectRoot = path.resolve(__dirname, '..');
const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const officialHosts = ['ps.air-outer.com', 'agentrouter.org'];
const resourceMessage = 'The requested item was created under a different Azure OpenAI resource.';
const scopedMessage = 'Upstream rejected the request as invalid [trace_id=synthetic.trace:1-2]';
const scopedPayload = () => ({ error: { message: scopedMessage, type: 'invalid_request_error', param: '', code: null } });
const frame = payload => `data: ${JSON.stringify(payload)}\n\n`;
const lifecycle = frame({ type: 'response.created', response: { status: 'in_progress', output: [] } });
const success = frame({ type: 'response.completed', response: {
  status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SYNTHETIC_RESULT_42' }] }]
} });

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function mixedHistory() {
  return {
    model: 'synthetic-codex-model', stream: true, reasoning: { effort: 'high', summary: 'auto' },
    prompt_cache_key: 'synthetic-cache-stable', prompt_cache_retention: '24h', session_id: 'synthetic-session-stable',
    metadata: { conversation_id: 'synthetic-conversation', id: 'metadata-id-keep' },
    store: false, parallel_tool_calls: false, instructions: 'Synthetic tool continuity fixture.',
    tools: [{ type: 'function', name: 'add', strict: false, parameters: {
      type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a']
    } }],
    input: [
      { type: 'message', id: 'system-remove', role: 'system', content: [{ type: 'input_text', text: 'Use the supplied synthetic tools.' }] },
      { type: 'additional_tools', id: 'additional-keep', role: 'developer', tools: [{
        type: 'namespace', name: 'synthetic', tools: [{ type: 'custom', name: 'run', format: { type: 'text' } }]
      }] },
      { type: 'message', id: 'user-remove', role: 'user', content: [
        { type: 'input_text', text: 'Add 19 and 23.', metadata: { id: 'nested-id-keep' } },
        { type: 'input_image', image_url: 'data:image/png;base64,U1lOVEhFVElD', detail: 'low' }
      ] },
      { type: 'reasoning', id: 'reasoning-remove-1', content: null, encrypted_content: 'SYNTHETIC_OPAQUE_REASONING_1', summary: [] },
      { type: 'message', id: 'commentary-remove', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'Calculating.', annotations: [] }] },
      { type: 'function_call', id: 'function-remove-1', status: 'completed', call_id: 'call-keep-1', name: 'add', arguments: '{"a":19,"b":23}' },
      { type: 'function_call_output', id: 'output-remove-1', status: 'completed', call_id: 'call-keep-1', output: '42' },
      { type: 'reasoning', id: 'reasoning-remove-2', content: null, encrypted_content: 'SYNTHETIC_OPAQUE_REASONING_2', summary: [{ type: 'summary_text', text: 'Verify the result.' }] },
      { type: 'function_call', id: 'function-remove-2', status: 'completed', call_id: 'call-keep-2', name: 'add', arguments: '{"a":20,"b":22}' },
      { type: 'function_call_output', id: 'output-remove-2', status: 'completed', call_id: 'call-keep-2', output: [
        { type: 'input_text', text: '42', metadata: { id: 'result-nested-keep' } },
        { type: 'input_image', image_url: 'https://images.example.invalid/synthetic.png', detail: 'auto' }
      ] },
      { type: 'custom_tool_call', id: 'custom-call-keep', status: 'completed', call_id: 'custom-pair-keep', name: 'run', input: 'print(42)\n' },
      { type: 'custom_tool_call_output', id: 'custom-output-keep', call_id: 'custom-pair-keep', output: { stdout: '42', exit_code: 0 } },
      { type: 'message', id: 'final-remove', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: '42', annotations: [] }] }
    ]
  };
}

function expectedProjection(body) {
  const expected = structuredClone(body);
  for (const item of expected.input) {
    if (['message', 'reasoning', 'function_call', 'function_call_output'].includes(item.type)) delete item.id;
  }
  return expected;
}

const headers = Object.freeze({
  'content-type': 'application/json', authorization: 'Bearer SYNTHETIC_KEY_NOT_REAL',
  'user-agent': 'synthetic-codex-fixture/1', 'x-session-id': 'synthetic-header-session',
  'x-cache-key': 'synthetic-header-cache', 'openai-beta': 'responses=experimental',
  'x-client-request-id': 'synthetic-request-id', 'x-codex-turn-id': 'synthetic-turn-id'
});

function requestHost(target) {
  if (target instanceof URL || typeof target === 'string') return new URL(target).hostname;
  return target.hostname || target.host || 'localhost';
}

// Official HTTPS hostnames are intercepted before transport/DNS. Neither these
// fixtures nor any unexpected request is allowed to reach an external address.
async function fixture(t, handler, options = {}) {
  const requests = [];
  const targets = [];
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
  const configuredUpstream = options.upstream || 'https://ps.air-outer.com/v1';
  const configuredHost = new URL(configuredUpstream).hostname;
  const originalHttp = http.request;
  const originalHttps = https.request;
  http.request = function guardedHttp(target, ...args) {
    assert.equal(loopback.has(requestHost(target)), true, 'test HTTP request must stay on loopback');
    return originalHttp.call(this, target, ...args);
  };
  https.request = function interceptedHttps(target, requestOptions, callback) {
    assert.equal(target instanceof URL, true, 'bridge must expose its fixed target before DNS');
    assert.equal(target.protocol, 'https:');
    assert.equal(target.hostname, configuredHost, 'only the configured synthetic upstream may be intercepted');
    targets.push(target.href);
    const local = new URL(target);
    local.protocol = 'http:';
    local.hostname = '127.0.0.1';
    local.port = String(upstream.address().port);
    return originalHttp.call(http, local, { ...requestOptions, agent: false }, callback);
  };
  let bridge;
  t.after(async () => {
    try {
      if (bridge) await bridge.close();
    } finally {
      http.request = originalHttp;
      https.request = originalHttps;
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => upstream.close(resolve));
    }
  });
  bridge = createBridge({
    upstream: configuredUpstream, historyMode: 'codex', timeoutMs: 2000,
    retryDelayMs: 0, retryJitterRatio: 0, ...options
  });
  const address = await bridge.listen(0);
  return { requests, targets, address };
}

function post(address, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path: '/v1/responses', method: 'POST', headers: { ...headers, ...extraHeaders } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks), text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function send(res, status, text, type = 'text/event-stream', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'x-synthetic-original': 'preserved', ...extra });
  res.end(text);
}

function assertIdentity(requests, body) {
  for (const entry of requests) {
    for (const [key, value] of Object.entries(headers)) assert.equal(entry.headers[key], value, key);
    assert.equal(entry.headers['accept-encoding'], 'identity');
    assert.equal(entry.headers['content-length'], String(entry.bytes.length));
    assert.equal(entry.path, '/v1/responses');
    const payload = JSON.parse(entry.bytes);
    for (const key of Object.keys(body).filter(key => key !== 'input')) assert.deepEqual(payload[key], body[key], key);
  }
}

test('scoped matcher accepts only the official hostname and exact observed plain HTTP400 shape', () => {
  const payload = freeze(scopedPayload());
  for (const host of officialHosts) {
    for (const upstream of [`https://${host}/v1`, new URL(`https://${host}/v1`), `http://${host}/v1`]) {
      assert.equal(isScopedHistoryFailure(payload, 400, upstream), true);
    }
  }
});

for (const [name, payload, status, upstream] of [
  ['ordinary400', { error: { message: 'Bad request.', type: 'invalid_request_error', param: '', code: null } }, 400, 'https://ps.air-outer.com/v1'],
  ['missing trace', { error: { ...scopedPayload().error, message: 'Upstream rejected the request as invalid' } }, 400, 'https://ps.air-outer.com/v1'],
  ['empty trace', { error: { ...scopedPayload().error, message: 'Upstream rejected the request as invalid [trace_id=]' } }, 400, 'https://ps.air-outer.com/v1'],
  ['trace too long', { error: { ...scopedPayload().error, message: `Upstream rejected the request as invalid [trace_id=${'a'.repeat(257)}]` } }, 400, 'https://ps.air-outer.com/v1'],
  ['trailing newline', { error: { ...scopedPayload().error, message: scopedMessage + '\n' } }, 400, 'https://ps.air-outer.com/v1'],
  ['trace with space', { error: { ...scopedPayload().error, message: 'Upstream rejected the request as invalid [trace_id=synthetic trace]' } }, 400, 'https://ps.air-outer.com/v1'],
  ['missing param', { error: { message: scopedMessage, type: 'invalid_request_error', code: null } }, 400, 'https://ps.air-outer.com/v1'],
  ['missing code', { error: { message: scopedMessage, type: 'invalid_request_error', param: '' } }, 400, 'https://ps.air-outer.com/v1'],
  ['null param', { error: { ...scopedPayload().error, param: null } }, 400, 'https://ps.air-outer.com/v1'],
  ['numeric code', { error: { ...scopedPayload().error, code: 400 } }, 400, 'https://ps.air-outer.com/v1'],
  ['filter code', { error: { ...scopedPayload().error, code: 'content_filter' } }, 400, 'https://ps.air-outer.com/v1'],
  ['auth type', { error: { ...scopedPayload().error, type: 'authentication_error' } }, 400, 'https://ps.air-outer.com/v1'],
  ['typed event error', { type: 'error', ...scopedPayload() }, 400, 'https://ps.air-outer.com/v1'],
  ['response.failed event', { type: 'response.failed', response: { status: 'failed', output: [], ...scopedPayload() } }, 400, 'https://ps.air-outer.com/v1'],
  ['outer unknown field', { ...scopedPayload(), surprise: 'unknown' }, 400, 'https://ps.air-outer.com/v1'],
  ['inner unknown field', { error: { ...scopedPayload().error, surprise: 'unknown' } }, 400, 'https://ps.air-outer.com/v1'],
  ['null-prototype outer', Object.assign(Object.create(null), scopedPayload()), 400, 'https://ps.air-outer.com/v1'],
  ['null-prototype error', { error: Object.assign(Object.create(null), scopedPayload().error) }, 400, 'https://ps.air-outer.com/v1'],
  ['JSON text instead of payload', JSON.stringify(scopedPayload()), 400, 'https://ps.air-outer.com/v1'],
  ['HTTP200', scopedPayload(), 200, 'https://ps.air-outer.com/v1'],
  ['string status', scopedPayload(), '400', 'https://ps.air-outer.com/v1'],
  ['unknown hostname', scopedPayload(), 400, 'https://unknown.example.invalid/v1'],
  ['suffix hostname', scopedPayload(), 400, 'https://ps.air-outer.com.example.invalid/v1'],
  ['subdomain hostname', scopedPayload(), 400, 'https://sub.agentrouter.org/v1'],
  ['trailing-dot hostname', scopedPayload(), 400, 'https://agentrouter.org./v1'],
  ['credentials in URL', scopedPayload(), 400, 'https://synthetic:synthetic@ps.air-outer.com/v1'],
  ['unsupported URL protocol', scopedPayload(), 400, 'ftp://ps.air-outer.com/v1'],
  ['missing upstream', scopedPayload(), 400, undefined],
  ['malformed upstream', scopedPayload(), 400, 'not-a-url']
]) test(`scoped matcher rejects ${name}`, () => {
  assert.equal(isScopedHistoryFailure(payload, status, upstream), false);
});

for (const mode of ['codex', 'harness']) {
  test(`${mode} mixed native history has an exact immutable four-ID-type projection`, () => {
    const original = freeze(mixedHistory());
    const before = JSON.stringify(original);
    const result = projectResponsesHistory(original, { mode });
    assert.equal(result.ok, true);
    assert.equal(result.removed, 10);
    assert.deepEqual(result.body, expectedProjection(original));
    assert.equal(JSON.stringify(original), before);
    assert.equal(result.body.input[3].content, null);
    assert.equal(result.body.input[7].content, null);
    for (const index of [1, 10, 11]) assert.deepEqual(result.body.input[index], original.input[index]);
    result.body.input[9].output[0].text = 'changed';
    assert.equal(original.input[9].output[0].text, '42');
  });

  for (const output of ['', '42', [{ type: 'input_text', text: '' }], [{ type: 'output_text', text: '42' }], [
    { type: 'input_text', text: '42' }, { type: 'input_image', image_url: 'data:image/png;base64,U1lOVEhFVElD' }
  ], [{ type: 'input_image', image_url: 'https://images.example.invalid/synthetic.png' }]]) {
    test(`${mode} removes a paired standard output ID with a complete inline payload`, () => {
      const original = freeze({ model: 'synthetic', input: [
        { type: 'function_call', call_id: 'pair', name: 'add', arguments: '{}' },
        { type: 'function_call_output', id: 'output-remove', status: 'completed', call_id: 'pair', output }
      ] });
      const result = projectResponsesHistory(original, { mode });
      assert.equal(result.ok, true);
      assert.equal(result.removed, 1);
      assert.deepEqual(result.body, expectedProjection(original));
    });
  }

  for (const [name, modify] of [
    ['empty ID', item => { item.id = ''; }],
    ['null ID', item => { item.id = null; }],
    ['numeric ID', item => { item.id = 1; }],
    ['in-progress status', item => { item.status = 'in_progress'; }],
    ['incomplete status', item => { item.status = 'incomplete'; }],
    ['null status', item => { item.status = null; }],
    ['object payload', item => { item.output = { stdout: '42' }; }],
    ['null payload', item => { item.output = null; }],
    ['numeric payload', item => { item.output = 42; }],
    ['empty content array', item => { item.output = []; }],
    ['missing output', item => { delete item.output; }],
    ['missing inline text', item => { item.output = [{ type: 'input_text' }]; }],
    ['unknown inline content', item => { item.output = [{ type: 'future_content', text: '42' }]; }],
    ['referenced image', item => { item.output = [{ type: 'input_image', file_id: 'server-image' }]; }],
    ['mixed inline and referenced image', item => { item.output = [{ type: 'input_image', image_url: 'data:image/png;base64,U1lOVEhFVElD', file_id: 'server-image' }]; }],
    ['relative image', item => { item.output = [{ type: 'input_image', image_url: 'synthetic.png' }]; }],
    ['empty image data', item => { item.output = [{ type: 'input_image', image_url: 'data:image/png;base64,' }]; }],
    ['non-object content', item => { item.output = ['42']; }]
  ]) test(`${mode} refuses identified standard output with ${name} without mutation`, () => {
    const original = mixedHistory();
    modify(original.input[6]);
    freeze(original);
    const before = JSON.stringify(original);
    const result = projectResponsesHistory(original, { mode });
    assert.equal(result.ok, false);
    assert.equal(result.code, ['empty ID', 'null ID', 'numeric ID'].includes(name) ? 'invalid_item_id' : 'invalid_history_item');
    assert.equal(JSON.stringify(original), before);
  });
}

for (const mode of ['codex', 'harness']) {
  test(`${mode} accepts an identified standard output without inventing an absent status`, () => {
    const original = freeze({ input: [
      { type: 'function_call', call_id: 'pair', name: 'add', arguments: '{}' },
      { type: 'function_call_output', id: 'output-remove', call_id: 'pair', output: '' }
    ] });
    const result = projectResponsesHistory(original, { mode });
    assert.equal(result.ok, true);
    assert.deepEqual(result.body, expectedProjection(original));
    assert.equal(Object.hasOwn(result.body.input[1], 'status'), false);
  });

  for (const [name, modify] of [
    ['orphan output', body => { body.input.splice(5, 1); }],
    ['output before call', body => { [body.input[5], body.input[6]] = [body.input[6], body.input[5]]; }],
    ['duplicate identified output', body => { body.input.push(structuredClone(body.input[6])); }],
    ['missing output', body => { body.input.splice(6, 1); }],
    ['cross-type output', body => { body.input[6].call_id = 'custom-pair-keep'; }]
  ]) test(`${mode} refuses a standard output ID with ${name}`, () => {
    const original = mixedHistory();
    modify(original);
    freeze(original);
    const before = JSON.stringify(original);
    const result = projectResponsesHistory(original, { mode });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_tool_pair');
    assert.equal(JSON.stringify(original), before);
  });
}

test('minimal standard output ID refusal remains unchanged', () => {
  const original = freeze({ input: [
    { type: 'function_call', id: 'function-remove', call_id: 'pair', name: 'add', arguments: '{}' },
    { type: 'function_call_output', id: 'output-not-minimal', call_id: 'pair', output: '42' }
  ] });
  assert.equal(projectResponsesHistory(original).code, 'unsupported_item_id');
  assert.deepEqual(projectResponsesHistory(original, { mode: 'minimal' }), projectResponsesHistory(original));
});

for (const mode of ['codex', 'harness']) {
  for (const host of officialHosts) {
    for (const format of ['raw JSON with SSE MIME', 'data-only SSE']) {
      test(`${mode} strict ${format} from ${host} projects once and succeeds without changing identity`, async t => {
        const original = freeze(mixedHistory());
        const before = JSON.stringify(original);
        const raw = Buffer.from(' \t\r\n' + JSON.stringify(original, null, 2) + '\n');
        const error = format.startsWith('raw') ? ' \t\r\n' + JSON.stringify(scopedPayload()) : frame(scopedPayload());
        const f = await fixture(t, (_req, res, attempt) => send(res, attempt < 3 ? 400 : 200, attempt < 3 ? error : success), {
          upstream: `https://${host}/v1`, historyMode: mode, resourceAttempts: 3, generic400Projection: false
        });
        const result = await post(f.address, raw);
        assert.equal(result.status, 200);
        assert.equal(result.text, success);
        assert.equal(result.headers['x-synthetic-original'], 'preserved');
        assert.equal(f.requests.length, 3);
        assert.deepEqual(f.requests[0].bytes, raw);
        const expectedBytes = Buffer.from(JSON.stringify(expectedProjection(original)));
        for (const entry of f.requests.slice(1)) assert.deepEqual(entry.bytes, expectedBytes);
        assert.deepEqual(f.targets, Array(3).fill(`https://${host}/v1/responses`));
        assertIdentity(f.requests, original);
        assert.equal(JSON.stringify(original), before);
      });
    }
  }

  test(`${mode} repeated strict scoped failures stop at the shared cap and preserve the last actual error`, async t => {
    const original = freeze(mixedHistory());
    const raw = Buffer.from(JSON.stringify(original, null, 2));
    const lastError = ' \t\r\n' + JSON.stringify(scopedPayload());
    const f = await fixture(t, (_req, res, attempt) => send(res, 400, lastError, 'text/event-stream', { 'x-attempt': String(attempt) }), {
      historyMode: mode, automaticRecovery: true, totalAttempts: 3, resourceAttempts: 10, generic400Projection: false
    });
    const result = await post(f.address, raw);
    assert.equal(f.requests.length, 3);
    assert.equal(result.status, 400);
    assert.equal(result.text, lastError);
    assert.equal(result.headers['x-attempt'], '3');
    assert.equal(result.headers['content-type'], 'text/event-stream');
    assert.deepEqual(f.requests[0].bytes, raw);
    for (const entry of f.requests.slice(1)) assert.deepEqual(entry.bytes, Buffer.from(JSON.stringify(expectedProjection(original))));
    assertIdentity(f.requests, original);
  });

  test(`${mode} transient and strict scoped failures share one cap and one projection`, async t => {
    const original = freeze(mixedHistory());
    const raw = Buffer.from(JSON.stringify(original, null, 2));
    const transient = JSON.stringify({ error: { type: 'server_error', message: 'Synthetic temporary failure.' } });
    const scoped = JSON.stringify(scopedPayload());
    const f = await fixture(t, (_req, res, attempt) => send(res, attempt === 1 ? 503 : 400, attempt === 1 ? transient : scoped), {
      historyMode: mode, automaticRecovery: true, totalAttempts: 4, resourceAttempts: 10
    });
    const result = await post(f.address, raw);
    assert.equal(f.requests.length, 4);
    assert.equal(result.status, 400);
    assert.equal(result.text, scoped);
    assert.deepEqual(f.requests[0].bytes, raw);
    assert.deepEqual(f.requests[1].bytes, raw);
    for (const entry of f.requests.slice(2)) assert.deepEqual(entry.bytes, Buffer.from(JSON.stringify(expectedProjection(original))));
    assertIdentity(f.requests, original);
  });
}

for (const mode of ['codex', 'harness']) {
  for (const wrapper of [
    { error: { type: 'invalid_request_error', code: 400, message: resourceMessage } },
    { error: { type: 'invalid_request_error', code: 400, message: `ag API error (400): ${JSON.stringify({ message: resourceMessage, code: 400 })}` } }
  ]) test(`${mode} numeric Azure wrapper recovers an exact mixed history projection`, async t => {
    const original = freeze(mixedHistory());
    const before = JSON.stringify(original);
    const raw = Buffer.from(' \t\r\n' + JSON.stringify(original, null, 2) + '\n');
    const error = ' \t\r\n' + JSON.stringify(wrapper);
    const f = await fixture(t, (_req, res, attempt) => send(res, attempt === 1 ? 400 : 200, attempt === 1 ? error : success), { historyMode: mode });
    const result = await post(f.address, raw);
    assert.equal(result.status, 200);
    assert.equal(result.text, success);
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.requests[0].bytes, raw);
    assert.deepEqual(f.requests[1].bytes, Buffer.from(JSON.stringify(expectedProjection(original))));
    assert.deepEqual(f.targets, ['https://ps.air-outer.com/v1/responses', 'https://ps.air-outer.com/v1/responses']);
    assertIdentity(f.requests, original);
    assert.equal(JSON.stringify(original), before);
  });
}

for (const mode of ['codex', 'harness']) {
  for (const [name, modify] of [
    ['server previous response', body => { body.previous_response_id = 'synthetic-server-reference'; }],
    ['server conversation', body => { body.conversation = { id: 'synthetic-server-conversation' }; }],
    ['item reference', body => { body.input.push({ type: 'item_reference', id: 'synthetic-item-reference' }); }],
    ['missing standard output', body => { body.input.splice(6, 1); }],
    ['missing custom output', body => { body.input.splice(11, 1); }],
    ['incomplete message', body => { delete body.input[2].content; }],
    ['identified malformed output', body => { body.input[6].output = null; }],
    ['unknown top-level item ID', body => { body.input.push({ type: 'future_item', id: 'synthetic-unknown' }); }],
    ['non-object history item', body => { body.input.push(null); }],
    ['reference-only history', body => { body.input = [{ type: 'item_reference', id: 'synthetic-item-reference' }]; }],
    ['non-array history', body => { body.input = 'not complete inline history'; }]
  ]) test(`${mode} Azure failure preserves original bytes for ${name}`, async t => {
    const original = mixedHistory();
    modify(original);
    freeze(original);
    const raw = Buffer.from(' \t\r\n' + JSON.stringify(original, null, 2) + '\n');
    const before = JSON.stringify(original);
    const error = ' \t\r\n' + JSON.stringify({ error: { type: 'invalid_request_error', message: resourceMessage, code: 400 } });
    const f = await fixture(t, (_req, res) => send(res, 400, error), { historyMode: mode });
    const result = await post(f.address, raw);
    assert.equal(result.status, 400);
    assert.equal(result.text, error);
    assert.equal(result.headers['content-type'], 'text/event-stream');
    assert.equal(result.headers['x-synthetic-original'], 'preserved');
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.requests[0].bytes, raw);
    assert.equal(JSON.stringify(original), before);
  });
}

for (const mode of ['codex', 'harness']) {
  for (const [name, error, upstream, status] of [
    ['ordinary400', JSON.stringify({ error: { type: 'invalid_request_error', message: 'Bad request.', param: '', code: null } }), undefined, 400],
    ['unknown host', JSON.stringify(scopedPayload()), 'https://unknown.example.invalid/v1', 400],
    ['hostname suffix', JSON.stringify(scopedPayload()), 'https://ps.air-outer.com.example.invalid/v1', 400],
    ['content filter', JSON.stringify({ error: { ...scopedPayload().error, code: 'content_filter' } }), undefined, 400],
    ['authentication', JSON.stringify({ error: { ...scopedPayload().error, type: 'authentication_error' } }), undefined, 400],
    ['permission', JSON.stringify({ error: { ...scopedPayload().error, code: 'permission_denied' } }), undefined, 400],
    ['schema', JSON.stringify({ error: { ...scopedPayload().error, code: 'invalid_tool_schema' } }), undefined, 400],
    ['missing trace', JSON.stringify({ error: { ...scopedPayload().error, message: 'Upstream rejected the request as invalid' } }), undefined, 400],
    ['missing param', JSON.stringify({ error: { message: scopedMessage, type: 'invalid_request_error', code: null } }), undefined, 400],
    ['missing code', JSON.stringify({ error: { message: scopedMessage, type: 'invalid_request_error', param: '' } }), undefined, 400],
    ['typed SSE', frame({ type: 'error', ...scopedPayload() }), undefined, 400],
    ['named SSE event:error', `event: error\ndata: ${JSON.stringify(scopedPayload())}\n\n`, undefined, 400],
    ['typed raw JSON', JSON.stringify({ type: 'error', ...scopedPayload() }), undefined, 400],
    ['outer unknown content', JSON.stringify({ ...scopedPayload(), output: 'unknown output' }), undefined, 400],
    ['HTTP401', JSON.stringify(scopedPayload()), undefined, 401],
    ['HTTP403', JSON.stringify(scopedPayload()), undefined, 403],
    ['malformed raw JSON', '{"error":broken', undefined, 400],
    ['partial data frame', `data: ${JSON.stringify(scopedPayload())}`, undefined, 400]
  ]) test(`${mode} strict scope barrier ${name} preserves exact response and request bytes`, async t => {
    const raw = Buffer.from(JSON.stringify(freeze(mixedHistory()), null, 2));
    const f = await fixture(t, (_req, res) => send(res, status, error), {
      historyMode: mode, automaticRecovery: true, generic400Projection: false,
      ...(upstream ? { upstream } : {})
    });
    const result = await post(f.address, raw);
    assert.equal(result.status, status);
    assert.equal(result.text, error);
    assert.equal(result.headers['content-type'], 'text/event-stream');
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.requests[0].bytes, raw);
  });

  for (const [name, modify] of [
    ['incomplete history', body => { body.input.splice(6, 1); }],
    ['malformed history', body => { body.input.push(null); }],
    ['server history', body => { body.previous_response_id = 'synthetic-reference'; }],
    ['invalid output payload', body => { body.input[6].output = {}; }]
  ]) test(`${mode} strict scoped error declines ${name} without a replay or byte rewrite`, async t => {
    const original = mixedHistory();
    modify(original);
    freeze(original);
    const raw = Buffer.from(' \t\r\n' + JSON.stringify(original, null, 2) + '\n');
    const error = ' \t\r\n' + JSON.stringify(scopedPayload());
    const f = await fixture(t, (_req, res) => send(res, 400, error), { historyMode: mode, automaticRecovery: true });
    const result = await post(f.address, raw);
    assert.equal(result.status, 400);
    assert.equal(result.text, error);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.requests[0].bytes, raw);
  });
}

for (const [name, prefix, tail] of [
  ['text output', frame({ type: 'response.output_text.delta', delta: ' ' }), ''],
  ['reasoning output', frame({ type: 'response.reasoning_text.delta', delta: '\n' }), ''],
  ['tool output', frame({ type: 'response.output_item.added', item: { type: 'function_call', name: 'add', call_id: 'emitted', arguments: '' } }), ''],
  ['unknown event', frame({ type: 'response.future_event', unknown: true }), ''],
  ['unknown raw prefix', 'not-an-sse-frame\n\n', ''],
  ['comment prefix', ': synthetic heartbeat\n\n', ''],
  ['unknown tail', '', 'unknown trailing bytes'],
  ['partial tail', '', 'data: {"type":"response.output_text.delta","delta":"']
]) test(`native Codex ${name} is an exact no-replay boundary`, async t => {
  const raw = Buffer.from(JSON.stringify(freeze(mixedHistory()), null, 2));
  const failure = frame({ type: 'response.failed', response: { status: 'failed', output: [], error: { type: 'invalid_request_error', message: resourceMessage } } });
  const original = lifecycle + prefix + failure + tail;
  const f = await fixture(t, (_req, res) => send(res, 200, original), { automaticRecovery: true, generic400Projection: false });
  const result = await post(f.address, raw);
  assert.equal(result.status, 200);
  assert.equal(result.text, original);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].bytes, raw);
});

test('native Codex complete terminal followed by delayed unknown bytes never replays', async t => {
  const raw = Buffer.from(JSON.stringify(freeze(mixedHistory()), null, 2));
  const terminal = frame({ type: 'response.failed', response: { status: 'failed', output: [], error: { type: 'invalid_request_error', message: resourceMessage } } });
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(terminal);
    setTimeout(() => res.end('unknown tail'), 5);
  }, { automaticRecovery: true, generic400Projection: false });
  assert.equal((await post(f.address, raw)).text, terminal + 'unknown tail');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].bytes, raw);
});

test('standalone bridge loads and listens with all external project dependencies rejected', () => {
  const probe = `
    const Module = require('node:module');
    const path = require('node:path');
    const root = process.argv[1];
    const original = Module._load;
    Module._load = function(request, parent, isMain) {
      if (/mixrouter/i.test(request)) throw new Error('Mixrouter dependency: ' + request);
      if (!Module.isBuiltin(request)) {
        const resolved = Module._resolveFilename(request, parent, isMain);
        const relative = path.relative(root, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('External project dependency: ' + resolved);
      }
      return original.apply(this, arguments);
    };
    const { createBridge } = require(path.join(root, 'lib', 'bridge.js'));
    const bridge = createBridge({ upstream: 'http://127.0.0.1:1/v1', historyMode: 'codex' });
    bridge.listen(0).then(() => bridge.close()).catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', probe, projectRoot], {
    cwd: projectRoot, timeout: 5000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr.toString());
});
