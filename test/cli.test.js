'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');

const cli = path.join(__dirname, '..', 'cli.js');

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('CLI starts via env, relays mock request and SIGTERM closes listener', async t => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* Consume mock request. */ }
    assert.equal(req.headers.authorization, 'Bearer MOCK_CLI_KEY');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"mock":"RESULT_42"}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const port = await unusedPort();
  const child = spawn(process.execPath, [cli], {
    env: { ...process.env, RHB_UPSTREAM: `http://127.0.0.1:${upstream.address().port}/v1`, RHB_PORT: String(port), RHB_API_KEY: 'MOCK_CLI_KEY' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CLI startup timeout')), 2000);
    const finish = () => {
      if (output.includes('listening at')) { clearTimeout(timer); child.stdout.off('data', finish); resolve(); }
    };
    child.stdout.on('data', finish);
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json' } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end('{"model":"mock","input":"hello"}');
  });
  assert.equal(result.status, 200);
  assert.equal(result.body, '{"mock":"RESULT_42"}');
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const [code] = await exited;
  // Windows terminates Node for SIGTERM instead of invoking its signal handler.
  if (process.platform !== 'win32') assert.equal(code, 0);
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
  assert.equal(errors, '');
  assert.equal(output.includes('MOCK_CLI_KEY'), false);
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('connect', () => { socket.destroy(); resolve(); });
    socket.on('error', reject);
  }));
});

test('CLI rejects invalid recovery and conversion options without exposing values', () => {
  for (const env of [
    { RHB_RESOURCE_ATTEMPTS: '0' },
    { RHB_RETRY_DELAY_MS: '-1' },
    { RHB_HISTORY_MODE: 'unknown' },
    { RHB_UPSTREAM_PROTOCOL: 'unknown' },
    { RHB_REASONING_SHAPE: 'unknown' },
    { RHB_USER_AGENT: 'bad\r\nheader' }
  ]) {
    const result = spawnSync(process.execPath, [cli], { env: { ...process.env, RHB_UPSTREAM: 'http://127.0.0.1:1/v1', ...env }, encoding: 'utf8', timeout: 2000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /bad\r\nheader/);
  }
});

test('CLI accepts no argv and does not expose unsafe URL or keys on startup error', () => {
  for (const args of [[], ['--api-key', 'MOCK_ARG_SECRET']]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      env: { ...process.env, RHB_UPSTREAM: 'http://MOCK_USER:MOCK_URL_SECRET@127.0.0.1/v1', RHB_API_KEY: 'MOCK_ENV_SECRET' },
      encoding: 'utf8', timeout: 2000
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    for (const secret of ['MOCK_USER', 'MOCK_URL_SECRET', 'MOCK_ARG_SECRET', 'MOCK_ENV_SECRET']) assert.equal(result.stderr.includes(secret), false);
  }
});
