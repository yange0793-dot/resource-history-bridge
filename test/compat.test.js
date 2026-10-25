'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createBridge } = require('..');

const frame = (type, data = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const empty = frame('response.created', { response: { id: 'resp-mock', status: 'in_progress', output: [] } })
  + frame('response.completed', { response: { id: 'resp-mock', status: 'completed', output: [], usage: { input_tokens: 8, output_tokens: 0 } } });
const message = { type: 'message', id: 'msg-mock', role: 'assistant', content: [{ type: 'output_text', text: 'COMPAT_OK', annotations: [] }] };
const full = frame('response.completed', { response: { id: 'resp-mock', status: 'completed', output: [message], usage: { input_tokens: 8, output_tokens: 4 } } });
const resource = frame('error', { message: 'The requested item was created under a different Azure OpenAI resource.' });

async function fixture(t, handler, options = {}) {
  const received = [];
  const sockets = new Set();
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, body: Buffer.concat(chunks), headers: req.headers });
    handler(req, res, received.length);
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const bridge = createBridge({ upstream: `http://127.0.0.1:${upstream.address().port}/v1`, timeoutMs: 1000, resourceAttempts: 2, retryDelayMs: 0, ...options });
  const address = await bridge.listen(0);
  t.after(async () => {
    await bridge.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
  });
  return { address, received };
}

function request(address, path = '/v1/responses', body = { model: 'mock', input: 'hello', stream: true }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path, method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'MOCK' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function sse(res, body) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(body);
}

test('empty Responses completion is byte-preserving passthrough', async t => {
  const f = await fixture(t, (_req, res) => sse(res, empty));
  const result = await request(f.address);
  assert.equal(result.body, empty);
  assert.equal(f.received.length, 1);
});

test('legacy recoverEmpty option cannot enable empty-response replay', async t => {
  const f = await fixture(t, (_req, res, n) => sse(res, n === 1 ? empty : full), { recoverEmpty: true });
  const result = await request(f.address);
  assert.equal(result.status, 200);
  assert.equal(result.body, empty);
  assert.equal(f.received.length, 1);
});

test('empty completion is not replaced by a bridge error', async t => {
  const f = await fixture(t, (_req, res) => sse(res, empty));
  const result = await request(f.address);
  assert.equal(result.status, 200);
  assert.equal(result.body, empty);
  assert.equal(f.received.length, 1);
});

test('usage is not the empty criterion and terminal-only text is preserved', async t => {
  const f = await fixture(t, (_req, res) => sse(res, full), {});
  assert.equal((await request(f.address)).body, full);
  assert.equal(f.received.length, 1);
});

test('output already delivered prevents empty replay', async t => {
  const data = frame('response.output_text.delta', { delta: 'VISIBLE' }) + empty;
  const f = await fixture(t, (_req, res) => sse(res, data), {});
  assert.equal((await request(f.address)).body, data);
  assert.equal(f.received.length, 1);
});

test('unknown prefix and buffer overflow prevent empty replay', async t => {
  for (const data of [frame('unknown.event', { value: 1 }) + empty, ': ' + 'x'.repeat(70) + '\n\n' + empty]) {
    const f = await fixture(t, (_req, res) => sse(res, data), { recoverEmpty: true, bufferLimit: 64 });
    assert.equal((await request(f.address)).body, data);
    assert.equal(f.received.length, 1);
  }
});

test('JSON empty and max-token incomplete responses are not replayed', async t => {
  for (const payload of [{ status: 'completed', output: [] }, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }]) {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    const result = await request(f.address);
    assert.deepEqual(JSON.parse(result.body), payload);
    assert.equal(f.received.length, 1);
  }
});

test('Messages conversion is opt-in and ordinary messages continue to pass through', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"content":[]}');
  });
  await request(f.address, '/v1/messages', { model: 'mock', messages: [], max_tokens: 20 });
  assert.equal(f.received[0].url, '/v1/messages');
});

test('Claude Messages can consume a Responses terminal-only payload', async t => {
  const f = await fixture(t, (_req, res) => sse(res, full), { upstreamProtocol: 'responses' });
  const result = await request(f.address, '/v1/messages', { model: 'mock', messages: [{ role: 'user', content: 'hello' }], max_tokens: 30, stream: false });
  assert.equal(f.received[0].url, '/v1/responses');
  const sent = JSON.parse(f.received[0].body);
  assert.equal(sent.store, false);
  assert.equal(sent.stream, true);
  assert.equal(f.received[0].headers.authorization, 'Bearer MOCK');
  assert.equal(f.received[0].headers['x-api-key'], undefined);
  assert.equal(result.status, 200);
  assert.equal(result.type, 'application/json');
  assert.equal(JSON.parse(result.body).content.find(block => block.type === 'text').text, 'COMPAT_OK');
});

test('streaming Claude Messages gets valid events without empty-response replay', async t => {
  const f = await fixture(t, (_req, res) => sse(res, full), { upstreamProtocol: 'responses' });
  const result = await request(f.address, '/v1/messages', { model: 'mock', messages: [{ role: 'user', content: 'hello' }], max_tokens: 30, stream: true });
  assert.equal(f.received.length, 1);
  assert.match(result.body, /event: message_start/);
  assert.match(result.body, /COMPAT_OK/);
  assert.match(result.body, /event: message_stop/);
  assert.equal((result.body.match(/event: message_start/g) || []).length, 1);
});

test('Messages conversion rejects unknown history blocks instead of dropping them', async t => {
  const f = await fixture(t, (_req, res) => sse(res, full), { upstreamProtocol: 'responses' });
  const result = await request(f.address, '/v1/messages', { model: 'mock', messages: [{ role: 'user', content: [{ type: 'unknown_block' }] }], max_tokens: 30 });
  assert.equal(result.status, 400);
  assert.equal(f.received.length, 0);
});

test('Claude SDK fixed beta query is accepted but arbitrary query is rejected', async t => {
  const f = await fixture(t, (_req, res) => sse(res, full), { upstreamProtocol: 'responses' });
  const body = { model: 'mock', messages: [{ role: 'user', content: 'hello' }], max_tokens: 30, stream: true };
  assert.equal((await request(f.address, '/v1/messages?beta=true', body)).status, 200);
  assert.equal(f.received[0].url, '/v1/responses');
  assert.equal((await request(f.address, '/v1/messages?beta=true&target=evil', body)).status, 404);
  assert.equal(f.received.length, 1);
});

test('native lifecycle-only stream is not rewritten by empty inspection', async t => {
  const data = frame('response.created', { response: { id: 'resp-mock', output: [], status: 'in_progress' } });
  const f = await fixture(t, (_req, res) => sse(res, data));
  const result = await request(f.address);
  assert.equal(result.status, 200);
  assert.equal(result.body, data);
  assert.equal(f.received.length, 1);
});

test('comment plus real content in one frame is not discarded or retried', async t => {
  const data = ': ping\n' + frame('response.output_text.delta', { delta: 'VISIBLE' }) + empty;
  const f = await fixture(t, (_req, res) => sse(res, data), {});
  assert.equal((await request(f.address)).body, data);
  assert.equal(f.received.length, 1);
});

test('resource recovery followed by empty completion stops without empty replay', async t => {
  const native = { model: 'mock', input: [{ type: 'reasoning', id: 'rs-mock', summary: [], encrypted_content: 'MOCK' }], stream: true };
  const f = await fixture(t, (_req, res, n) => {
    if (n === 1) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'The requested item was created under a different Azure OpenAI resource.' } }));
    } else sse(res, n === 2 ? empty : full);
  }, {});
  const result = await request(f.address, '/v1/responses', native);
  assert.equal(result.body, empty);
  assert.equal(f.received.length, 2);
  assert.equal(Object.hasOwn(JSON.parse(f.received[0].body).input[0], 'id'), true);
  assert.equal(Object.hasOwn(JSON.parse(f.received[1].body).input[0], 'id'), false);
});

test('Messages conversion preserves real upstream JSON errors and status', async t => {
  const error = JSON.stringify({ error: { type: 'invalid_request_error', message: 'summary is required' } });
  const f = await fixture(t, (_req, res) => {
    res.writeHead(400, { 'content-type': 'text/event-stream' });
    res.end(error);
  }, { upstreamProtocol: 'responses' });
  const result = await request(f.address, '/v1/messages', { model: 'mock', messages: [{ role: 'user', content: 'hello' }], max_tokens: 30, stream: true });
  assert.equal(result.status, 400);
  assert.equal(result.body, error);
  assert.equal(result.type, 'application/json');
  assert.equal(f.received.length, 1);
});

test('unknown and malformed converted streams produce errors, never normal success', async t => {
  for (const data of ['data: broken\n\n', frame('unknown.content.event', { text: 'uninterpretable' })]) {
    const f = await fixture(t, (_req, res) => sse(res, data), { upstreamProtocol: 'responses' });
    const result = await request(f.address, '/v1/messages', { model: 'mock', messages: [{ role: 'user', content: 'hello' }], max_tokens: 30, stream: true });
    assert.ok(result.status === 502 || result.status === 400 && /event: error/.test(result.body));
    assert.doesNotMatch(result.body, /event: message_stop/);
    assert.equal(f.received.length, 1);
  }
});

test('Responses conversion errors after output remain visible protocol failures', async t => {
  const data = frame('response.output_item.added', { output_index: 0, item: { type: 'message', id: 'msg-mock', role: 'assistant', content: [] } })
    + frame('response.output_text.delta', { output_index: 0, item_id: 'msg-mock', content_index: 0, delta: 'VISIBLE' }) + 'data: bad\n\n';
  const f = await fixture(t, (_req, res) => sse(res, data), { upstreamProtocol: 'responses' });
  const result = await request(f.address, '/v1/messages', { model: 'mock', messages: [{ role: 'user', content: 'hello' }], max_tokens: 30, stream: true });
  assert.equal(result.status, 200);
  assert.match(result.body, /VISIBLE/);
  assert.match(result.body, /event: error/);
  assert.doesNotMatch(result.body, /event: message_stop/);
  assert.equal(f.received.length, 1);
});

test('explicit User-Agent applies to both resource attempts and default auth is preserved', async t => {
  const body = { model: 'mock', stream: true, input: [{ type: 'reasoning', id: 'rs-mock', summary: [], encrypted_content: 'MOCK' }] };
  const f = await fixture(t, (_req, res, n) => sse(res, n === 1 ? resource : full), { userAgent: 'MOCK_UA' });
  await request(f.address, '/v1/responses', body);
  assert.equal(f.received.length, 2);
  for (const entry of f.received) {
    assert.equal(entry.headers['user-agent'], 'MOCK_UA');
    assert.equal(entry.headers['x-api-key'], 'MOCK');
  }
});

test('conversion cannot recover a known SSE resource error under HTTP401', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(401, { 'content-type': 'text/event-stream' });
    res.end(frame('error', { message: 'The requested item was created under a different Azure OpenAI resource.' }));
  }, { upstreamProtocol: 'responses' });
  const result = await request(f.address, '/v1/messages', { model: 'mock', messages: [{ role: 'user', content: 'hello' }], max_tokens: 30, stream: true });
  assert.equal(result.status, 401);
  assert.match(result.body, /event: error/);
  assert.equal(f.received.length, 1);
});

test('converted HTTP400 empty-looking SSE is not classified as empty success', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(400, { 'content-type': 'text/event-stream' });
    res.end(empty);
  }, { upstreamProtocol: 'responses' });
  const result = await request(f.address, '/v1/messages', { model: 'mock', messages: [{ role: 'user', content: 'hello' }], max_tokens: 30, stream: true });
  assert.equal(result.status, 400);
  assert.equal(f.received.length, 1);
});

test('converted empty response beyond buffer limit is not replayed', async t => {
  const f = await fixture(t, (_req, res) => sse(res, empty), { upstreamProtocol: 'responses', bufferLimit: 20 });
  const result = await request(f.address, '/v1/messages', { model: 'mock', messages: [{ role: 'user', content: 'hello' }], max_tokens: 30, stream: true });
  assert.equal(result.status, 200);
  assert.equal(f.received.length, 1);
});

test('uncommitted Responses rate limit is presented as HTTP429, not empty HTTP200', async t => {
  const f = await fixture(t, (_req, res) => sse(res, frame('response.failed', { response: { status: 'failed', output: [], error: { code: 'rate_limit_exceeded', message: 'MOCK rate limit' } } })), { upstreamProtocol: 'responses' });
  const result = await request(f.address, '/v1/messages', { model: 'mock', messages: [{ role: 'user', content: 'hello' }], max_tokens: 30, stream: true });
  assert.equal(result.status, 429);
  assert.match(result.body, /rate_limit_error/);
  assert.doesNotMatch(result.body, /event: message_stop/);
  assert.equal(f.received.length, 1);
});

test('explicit Codex history recovery preserves namespaces and custom tool identities', async t => {
  const body = { model: 'mock', stream: true, input: [
    { type: 'additional_tools', id: 'tools-mock', role: 'developer', tools: [{ type: 'namespace', name: 'functions', description: 'MOCK', tools: [{ type: 'custom', name: 'exec', description: 'MOCK', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } }] }] },
    { type: 'message', id: 'msg-user', role: 'user', content: [{ type: 'input_text', text: 'add 19 23' }] },
    { type: 'message', id: 'msg-assistant', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Computing' }] },
    { type: 'custom_tool_call', id: 'ctc-mock', call_id: 'call-mock', name: 'exec', input: 'print(19+23)', status: 'completed' },
    { type: 'custom_tool_call_output', id: 'cto-mock', call_id: 'call-mock', output: '42' }
  ] };
  const f = await fixture(t, (_req, res, n) => {
    if (n === 1) {
      res.writeHead(400, { 'content-type': 'text/event-stream' });
      res.end(JSON.stringify({ error: { message: 'The requested item was created under a different Azure OpenAI resource.' } }));
    } else sse(res, full);
  }, { historyMode: 'codex' });
  const result = await request(f.address, '/v1/responses', body);
  assert.equal(result.body, full);
  assert.equal(f.received.length, 2);
  const projected = JSON.parse(f.received[1].body);
  const expected = structuredClone(body);
  delete expected.input[1].id;
  delete expected.input[2].id;
  assert.deepEqual(projected, expected);
});

test('converted optional DONE after terminal preserves success without replay', async t => {
  const data = full + 'data: [DONE]\n\n';
  for (const stream of [true, false]) {
    const f = await fixture(t, (_req, res) => sse(res, data), { upstreamProtocol: 'responses' });
    const result = await request(f.address, '/v1/messages', { model: 'mock', messages: [{ role: 'user', content: 'hello' }], max_tokens: 30, stream });
    assert.equal(result.status, 200);
    assert.equal(f.received.length, 1);
    assert.match(result.body, /COMPAT_OK/);
    if (stream) {
      assert.match(result.body, /event: message_stop/);
      assert.doesNotMatch(result.body, /event: error/);
    } else assert.equal(JSON.parse(result.body).stop_reason, 'end_turn');
  }
});

test('converted JSON requires an explicit valid terminal instead of inventing empty success', async t => {
  for (const payload of [{}, { status: 'in_progress', output: [] }, { status: 'completed' }, { status: 'completed', output: null }]) {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    }, { upstreamProtocol: 'responses' });
    const result = await request(f.address, '/v1/messages', { model: 'mock', messages: [{ role: 'user', content: 'hello' }], max_tokens: 30, stream: false });
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.body).error.code, 'invalid_upstream_completion');
    assert.equal(f.received.length, 1);
  }
});

test('converted valid JSON terminal delivers visible content', async t => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'completed', output: [message], usage: { input_tokens: 8, output_tokens: 4 } }));
  }, { upstreamProtocol: 'responses' });
  const result = await request(f.address, '/v1/messages', { model: 'mock', messages: [{ role: 'user', content: 'hello' }], max_tokens: 30, stream: false });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).content[0].text, 'COMPAT_OK');
  assert.equal(f.received.length, 1);
});

test('valid empty Messages conversion finishes normally without 422 or retry', async t => {
  for (const stream of [true, false]) {
    const f = await fixture(t, (_req, res) => sse(res, empty + 'data: [DONE]\n\n'), { upstreamProtocol: 'responses' });
    const result = await request(f.address, '/v1/messages', { model: 'mock', messages: [{ role: 'user', content: 'hello' }], max_tokens: 30, stream });
    assert.equal(result.status, 200);
    if (stream) {
      assert.match(result.body, /event: message_stop/);
      assert.doesNotMatch(result.body, /event: error/);
    } else {
      assert.deepEqual(JSON.parse(result.body).content, []);
      assert.equal(JSON.parse(result.body).stop_reason, 'end_turn');
    }
    assert.equal(f.received.length, 1);
  }
});
