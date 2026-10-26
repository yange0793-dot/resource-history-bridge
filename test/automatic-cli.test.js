'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function post(port, endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: endpoint, agent: false,
      headers: { 'content-type': 'application/json', authorization: 'Bearer SYNTHETIC_CLIENT_KEY' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.once('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Automatic CLI mock request timed out.')));
    req.end(body);
  });
}

test('default CLI handles Messages and resource-bound Responses in one process without choosing a client', { timeout: 20000 }, async t => {
  const requests = [];
  let nativeAttempts = 0;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const body = JSON.parse(bytes);
    requests.push({ path: req.url, auth: req.headers.authorization, bytes, body });
    const native = body.input.some(item => item.id === 'rs_synthetic');
    if (native && ++nativeAttempts === 1) {
      res.writeHead(400, { 'content-type': 'text/event-stream' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'The requested item was created under a different Azure OpenAI resource.' } }));
      return;
    }
    const response = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'RESULT_42' }] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const port = await unusedPort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(RHB_|NODE_OPTIONS|NODE_PATH|NODE_TEST_CONTEXT)/i.test(key)));
  const child = spawn(process.execPath, ['--require', path.join(__dirname, '..', 'scripts', 'mock-agentrouter.cjs'), path.join(__dirname, '..', 'cli.js')], {
    env: { ...env, RHB_TEST_MOCK_PORT: String(upstream.address().port), RHB_PORT: String(port), RHB_RETRY_DELAY_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  closed.catch(() => {});
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Automatic CLI startup timed out.')), 5000);
    const finish = error => {
      clearTimeout(timer);
      child.stdout.off('data', ready);
      child.off('error', failed);
      child.off('exit', exited);
      error ? reject(error) : resolve();
    };
    const ready = () => { if (output.includes('listening at')) finish(); };
    const failed = error => finish(error);
    const exited = () => finish(new Error('Automatic CLI exited before readiness.'));
    child.stdout.on('data', ready);
    child.once('error', failed);
    child.once('exit', exited);
    ready();
  });
  assert.match(output, /Client: auto; history: auto; protocol: auto; auth source: client/);
  assert.doesNotMatch(output, /\[codex\]|SYNTHETIC_CLIENT_KEY/);
  const message = await post(port, '/v1/messages', JSON.stringify({ model: 'synthetic-model', max_tokens: 20, stream: false, messages: [{ role: 'user', content: 'Compute.' }] }));
  assert.equal(message.status, 200);
  assert.equal(JSON.parse(message.text).content[0].text, 'RESULT_42');
  const history = { model: 'synthetic-model', stream: true, store: false, input: [
    { role: 'developer', content: 'Use the result.' },
    { type: 'message', id: 'msg_synthetic', role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] },
    { type: 'reasoning', id: 'rs_synthetic', summary: [], encrypted_content: 'SYNTHETIC_CIPHER' },
    { type: 'function_call', id: 'fc_synthetic', call_id: 'call_synthetic', name: 'sum', arguments: '{"a":19,"b":23}' },
    { type: 'function_call_output', id: 'fo_synthetic', call_id: 'call_synthetic', output: '42' }
  ] };
  const raw = Buffer.from(' \n' + JSON.stringify(history, null, 2));
  const result = await post(port, '/v1/responses', raw);
  assert.equal(result.status, 200);
  assert.match(result.text, /RESULT_42/);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1].bytes, raw);
  const expected = structuredClone(history);
  for (const item of expected.input) delete item.id;
  assert.deepEqual(requests[2].body, expected);
  assert.equal(requests[2].body.input[2].encrypted_content, 'SYNTHETIC_CIPHER');
  assert.equal(requests.every(request => request.path === '/v1/responses' && request.auth === 'Bearer SYNTHETIC_CLIENT_KEY'), true);
  assert.equal(errors, '');
  child.kill('SIGTERM');
  await closed;
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
  }), { code: 'ECONNREFUSED' });
});
