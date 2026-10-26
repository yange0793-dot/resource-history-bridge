'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');

const cli = path.join(__dirname, '..', 'cli.js');
const STARTUP_ERROR = 'resource-history-bridge could not start.';

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^RHB_/i.test(name)) delete env[name];
  return { ...env, RHB_UPSTREAM: 'https://agentrouter.org/v1', ...extra };
}

// A subprocess intercepts only the CLI's bridge dependency, not its env parser.
// This makes option wiring observable without changing the public server API.
function configuredResult(env = {}) {
  const script = `
    const Module = require('node:module');
    const cli = process.argv[1];
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === './index' && parent.filename === cli) {
        return { createBridge(options) {
          process.stdout.write('OPTIONS ' + JSON.stringify(options) + '\\n');
          return { listen: async () => ({ address: '127.0.0.1', family: 'IPv4', port: 8790 }), close: async () => {} };
        } };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    process.argv = [process.execPath, cli];
    require(cli);
  `;
  return spawnSync(process.execPath, ['-e', script, cli], {
    env: cleanEnv(env), encoding: 'utf8', timeout: 5000
  });
}

function configuredOptions(env = {}) {
  const result = configuredResult(env);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const line = result.stdout.split('\n').find(value => value.startsWith('OPTIONS '));
  assert.ok(line, 'CLI did not pass options to createBridge');
  return JSON.parse(line.slice('OPTIONS '.length));
}

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startCli(t, env, cwd) {
  const child = spawn(process.execPath, [cli], {
    cwd, env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  closed.catch(() => {});
  const state = { output: '', errors: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { state.output += chunk; });
  child.stderr.on('data', chunk => { state.errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`CLI startup timed out: ${state.errors}`)), 5000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', ready);
      child.off('error', failed);
      child.off('exit', exited);
    };
    const finish = error => { cleanup(); error ? reject(error) : resolve(); };
    const ready = () => { if (state.output.includes('listening at')) finish(); };
    const failed = error => finish(error);
    const exited = (code, signal) => finish(new Error(`CLI exited before startup (${code}, ${signal}): ${state.errors}`));
    child.stdout.on('data', ready);
    child.once('error', failed);
    child.once('exit', exited);
    ready();
  });
  return { child, closed, state };
}

function post(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: '/v1/responses', agent: false,
      headers: { 'content-type': 'application/json', authorization: 'Bearer MOCK_CLIENT_SECRET' }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.once('end', () => resolve({ status: res.statusCode, body: text }));
      res.once('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('CLI POST timeout')));
    req.once('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function assertListenerClosed(port) {
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(5000, () => socket.destroy(new Error('Listener check timeout')));
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
  }), { code: 'ECONNREFUSED' });
}

test('CLI defaults to the official AgentRouter URL without contacting it', () => {
  const result = configuredResult({ RHB_UPSTREAM: undefined });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const options = configuredOptions({ RHB_UPSTREAM: undefined });
  assert.equal(options.upstream, 'https://agentrouter.org/v1');
  assert.equal(options.historyMode, 'minimal');
  assert.equal(options.upstreamProtocol, 'passthrough');
  assert.match(result.stdout, /Upstream: https:\/\/agentrouter\.org\n/);
  assert.match(result.stdout, /Client: generic; history: minimal; protocol: passthrough; auth source: client/);
});

test('CLI wires each client preset with final history-mode recovery defaults', () => {
  for (const [client, historyMode, upstreamProtocol] of [
    ['codex', 'codex', 'passthrough'], ['harness', 'harness', 'passthrough'],
    ['claude-code', 'minimal', 'responses'], ['generic', 'minimal', 'passthrough']
  ]) {
    const options = configuredOptions({ RHB_CLIENT: client });
    assert.equal(options.historyMode, historyMode);
    assert.equal(options.upstreamProtocol, upstreamProtocol);
    assert.equal(options.retryDelayMs, historyMode === 'harness' ? 250 : 1000);
    assert.equal(options.generic400Projection, historyMode === 'harness');
  }
  const minimal = configuredOptions({ RHB_CLIENT: 'harness', RHB_HISTORY_MODE: 'minimal', RHB_UPSTREAM_PROTOCOL: 'responses' });
  assert.equal(minimal.historyMode, 'minimal');
  assert.equal(minimal.upstreamProtocol, 'responses');
  assert.equal(minimal.retryDelayMs, 1000);
  assert.equal(minimal.generic400Projection, false);
  const harness = configuredOptions({ RHB_CLIENT: 'codex', RHB_HISTORY_MODE: 'harness' });
  assert.equal(harness.retryDelayMs, 250);
  assert.equal(harness.generic400Projection, true);
});

test('CLI rejects unsafe upstreams and invalid clients before creating the bridge', () => {
  for (const env of [
    { RHB_UPSTREAM: 'file:///tmp/mock' },
    { RHB_UPSTREAM: 'https://agentrouter.org/v1?key=MOCK_URL_SECRET' },
    { RHB_UPSTREAM: 'https://agentrouter.org/v1#MOCK_URL_SECRET' },
    { RHB_UPSTREAM: '' }, { RHB_CLIENT: '' }, { RHB_CLIENT: 'unknown' }
  ]) {
    const result = configuredResult(env);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.startsWith(STARTUP_ERROR));
    assert.doesNotMatch(result.stderr, /api\.example\.com|evil\.test|unknown/);
  }
});

test('CLI accepts other fixed HTTP(S) hosts but reports recovery disabled and effective passthrough', () => {
  for (const upstream of ['https://api.example.com/v1', 'http://agentrouter.org/v1', 'https://agentrouter.org.evil.test/v1']) {
    const result = configuredResult({ RHB_UPSTREAM: upstream, RHB_CLIENT: 'claude-code' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /AgentRouter recovery: disabled \(passthrough\)/);
    assert.match(result.stdout, /Client: claude-code; history: minimal; protocol: passthrough; auth source: client/);
    assert.equal(result.stdout.includes(`Upstream: ${new URL(upstream).origin}\n`), true);
  }
});

test('CLI loopback is permanently passthrough for every client preset', () => {
  for (const client of ['claude-code', 'codex', 'harness', 'generic']) {
    const result = configuredResult({ RHB_UPSTREAM: 'http://127.0.0.1:1/v1', RHB_CLIENT: client });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /AgentRouter recovery: disabled \(passthrough\)/);
    assert.match(result.stdout, /protocol: passthrough/);
  }
});

test('CLI official HTTPS AgentRouter targets automatically enable recovery', () => {
  for (const upstream of ['https://agentrouter.org/v1', 'https://ps.air-outer.com/v1']) {
    const result = configuredResult({ RHB_UPSTREAM: upstream });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /AgentRouter recovery: enabled\n/);
  }
});

test('CLI Harness defaults wire the bounded recovery policy and disable diagnostics', () => {
  const options = configuredOptions({ RHB_HISTORY_MODE: 'harness' });
  assert.equal(options.totalAttempts, 10);
  assert.equal(options.transientAttempts, 3);
  assert.equal(options.resourceAttempts, 10);
  assert.equal(options.timeoutMs, 180000);
  assert.equal(options.retryDelayMs, 250);
  assert.equal(options.maxRetryDelayMs, 2000);
  assert.equal(options.retryJitterRatio, 0.2);
  assert.equal(options.generic400Projection, true);
  assert.equal(options.historyStrategy, 'on-error');
  assert.deepEqual(options.diagnostics, { enabled: false });
});

test('CLI preserves legacy retry and generic 400 defaults outside Harness mode', () => {
  for (const env of [{}, { RHB_HISTORY_MODE: 'minimal' }, { RHB_HISTORY_MODE: 'codex' }]) {
    const options = configuredOptions(env);
    assert.equal(options.retryDelayMs, 1000);
    assert.equal(options.generic400Projection, false);
    assert.equal(options.historyStrategy, 'on-error');
    assert.deepEqual(options.diagnostics, { enabled: false });
  }
});

test('CLI env maps recovery controls and diagnostics paths without losing spaces', () => {
  const filePath = path.join(os.tmpdir(), 'rhb diagnostics path', 'events.jsonl');
  const options = configuredOptions({
    RHB_TOTAL_ATTEMPTS: '4', RHB_TRANSIENT_ATTEMPTS: '2', RHB_RESOURCE_ATTEMPTS: '5',
    RHB_HISTORY_STRATEGY: 'portable', RHB_GENERIC_400_PROJECTION: 'false',
    RHB_TIMEOUT_MS: '12345', RHB_RETRY_DELAY_MS: '25', RHB_MAX_RETRY_DELAY_MS: '500',
    RHB_RETRY_JITTER_RATIO: '0.35', RHB_DIAGNOSTICS_PATH: filePath,
    RHB_DIAGNOSTICS_MAX_BYTES: '4096', RHB_DIAGNOSTICS_MAX_FILES: '2'
  });
  assert.equal(options.totalAttempts, 4);
  assert.equal(options.transientAttempts, 2);
  assert.equal(options.resourceAttempts, 5);
  assert.equal(options.historyStrategy, 'portable');
  assert.equal(options.generic400Projection, false);
  assert.equal(options.timeoutMs, 12345);
  assert.equal(options.retryDelayMs, 25);
  assert.equal(options.maxRetryDelayMs, 500);
  assert.equal(options.retryJitterRatio, 0.35);
  assert.deepEqual(options.diagnostics, { enabled: true, filePath, maxFileBytes: 4096, maxFiles: 2 });
  const defaults = configuredOptions({ RHB_DIAGNOSTICS_PATH: filePath });
  assert.deepEqual(defaults.diagnostics, { enabled: true, filePath, maxFileBytes: 1024 * 1024, maxFiles: 3 });
});

test('CLI accepts explicit strict boolean spellings, including false and zero', () => {
  for (const value of ['true', '1', ' TRUE ']) assert.equal(configuredOptions({ RHB_GENERIC_400_PROJECTION: value }).generic400Projection, true);
  for (const value of ['false', '0', ' FALSE ']) assert.equal(configuredOptions({ RHB_GENERIC_400_PROJECTION: value }).generic400Projection, false);
});

test('CLI rejects invalid env options with a sanitized startup error', { timeout: 30000 }, () => {
  const invalid = [
    { RHB_TOTAL_ATTEMPTS: '0' }, { RHB_TOTAL_ATTEMPTS: '11' }, { RHB_TOTAL_ATTEMPTS: '1.5' },
    { RHB_TOTAL_ATTEMPTS: '' }, { RHB_TOTAL_ATTEMPTS: 'NaN' }, { RHB_TOTAL_ATTEMPTS: 'Infinity' },
    { RHB_TOTAL_ATTEMPTS: '0xA' }, { RHB_TOTAL_ATTEMPTS: '10junk' },
    { RHB_TRANSIENT_ATTEMPTS: '0' }, { RHB_TRANSIENT_ATTEMPTS: '4' },
    { RHB_RESOURCE_ATTEMPTS: '0' }, { RHB_RETRY_DELAY_MS: '-1' },
    { RHB_RETRY_DELAY_MS: '2001' }, { RHB_MAX_RETRY_DELAY_MS: '0' },
    { RHB_MAX_RETRY_DELAY_MS: '2001' }, { RHB_RETRY_DELAY_MS: '501', RHB_MAX_RETRY_DELAY_MS: '500' },
    { RHB_RETRY_JITTER_RATIO: '-0.1' }, { RHB_RETRY_JITTER_RATIO: '1.1' },
    { RHB_RETRY_JITTER_RATIO: ' ' }, { RHB_HISTORY_STRATEGY: 'unknown' }, { RHB_HISTORY_STRATEGY: '' },
    { RHB_GENERIC_400_PROJECTION: '' }, { RHB_GENERIC_400_PROJECTION: 'yes' },
    { RHB_GENERIC_400_PROJECTION: '2' }, { RHB_GENERIC_400_PROJECTION: 'falsejunk' },
    { RHB_DIAGNOSTICS_PATH: ' ' },
    { RHB_DIAGNOSTICS_PATH: path.join(os.tmpdir(), 'mock.jsonl'), RHB_DIAGNOSTICS_MAX_BYTES: '0' },
    { RHB_DIAGNOSTICS_PATH: path.join(os.tmpdir(), 'mock.jsonl'), RHB_DIAGNOSTICS_MAX_FILES: '0' },
    { RHB_HOST: '0.0.0.0' }, { RHB_PORT: '0' },
    { RHB_CLIENT: 'unknown' }, { RHB_CLIENT: '' },
    { RHB_HISTORY_MODE: 'unknown' }, { RHB_HISTORY_MODE: '' },
    { RHB_UPSTREAM_PROTOCOL: 'unknown' }, { RHB_UPSTREAM_PROTOCOL: '' },
    { RHB_REASONING_SHAPE: 'unknown' }, { RHB_USER_AGENT: 'MOCK_SECRET\r\nheader' }
  ];
  for (const env of invalid) {
    const result = spawnSync(process.execPath, [cli], {
      env: cleanEnv({ RHB_HISTORY_MODE: 'harness', RHB_API_KEY: 'MOCK_ENV_SECRET', ...env }), encoding: 'utf8', timeout: 3000
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, JSON.stringify(env));
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.startsWith(STARTUP_ERROR), result.stderr);
    assert.doesNotMatch(result.stderr, /MOCK_ENV_SECRET|MOCK_SECRET|TypeError|\n\s+at /);
  }
});

test('CLI keeps no-argv and credential sanitization guards', () => {
  for (const [args, upstream] of [
    [[], 'http://MOCK_USER:MOCK_URL_SECRET@127.0.0.1/v1'],
    [['--api-key', 'MOCK_ARG_SECRET'], 'http://127.0.0.1:1/v1']
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      env: cleanEnv({ RHB_UPSTREAM: upstream, RHB_API_KEY: 'MOCK_ENV_SECRET' }),
      encoding: 'utf8', timeout: 3000
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.startsWith(STARTUP_ERROR));
    assert.doesNotMatch(result.stderr, /MOCK_USER|MOCK_URL_SECRET|MOCK_ARG_SECRET|MOCK_ENV_SECRET/);
  }
});

test('index exposes recovery and diagnostics helpers without replacing existing APIs', () => {
  const api = require('../index');
  for (const name of ['history', 'output', 'messages', 'recovery', 'diagnostics', 'bridge']) {
    for (const [key, value] of Object.entries(require(`../lib/${name}`))) assert.equal(api[key], value, `${name}.${key}`);
  }
  assert.equal(typeof api.createBridge, 'function');
  assert.equal(typeof api.projectResponsesHistory, 'function');
  assert.equal(typeof api.decideRecovery, 'function');
  assert.equal(typeof api.createDiagnostics, 'function');
});

test('CLI startup logs omit valid upstream paths and bridge credentials', { timeout: 15000 }, async t => {
  const port = await unusedPort();
  const { child, closed, state } = await startCli(t, {
    RHB_UPSTREAM: 'http://127.0.0.1:1/MOCK_PATH_SECRET/v1', RHB_PORT: String(port),
    RHB_CLIENT: 'claude-code', RHB_API_KEY: 'MOCK_ENV_SECRET', RHB_USER_AGENT: 'MOCK_HEADER_SECRET'
  });
  assert.equal(state.errors, '');
  assert.match(state.output, /Upstream: http:\/\/127\.0\.0\.1:1\n/);
  assert.match(state.output, /Client: claude-code; history: minimal; protocol: passthrough; auth source: bridge override/);
  assert.doesNotMatch(state.output, /MOCK_PATH_SECRET|MOCK_ENV_SECRET|MOCK_HEADER_SECRET/);
  child.kill('SIGTERM');
  await closed;
  await assertListenerClosed(port);
});

test('CLI loopback is raw passthrough despite Harness portable history and Azure400', { timeout: 15000 }, async t => {
  const requests = [];
  const error = '{"error":{"type":"invalid_request_error","message":"The requested item was created under a different Azure OpenAI resource."}}';
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ bytes: Buffer.concat(chunks), url: req.url, authorization: req.headers.authorization });
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(error);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const port = await unusedPort();
  const { child, closed, state } = await startCli(t, {
    RHB_UPSTREAM: `http://127.0.0.1:${upstream.address().port}/v1`, RHB_PORT: String(port),
    RHB_CLIENT: 'harness', RHB_HISTORY_STRATEGY: 'portable',
    RHB_UPSTREAM_PROTOCOL: 'responses', RHB_RETRY_DELAY_MS: '0'
  });
  const body = { model: 'OTHER_MODEL', previous_response_id: 'OTHER_SERVER_REFERENCE', input: [
    { type: 'reasoning', id: 'OTHER_RESOURCE_ID', encrypted_content: 'OTHER_OPAQUE_BYTES', summary: [] }
  ] };
  assert.deepEqual(await post(port, body), { status: 400, body: error });
  assert.deepEqual(requests, [{ bytes: Buffer.from(JSON.stringify(body)), url: '/v1/responses', authorization: 'Bearer MOCK_CLIENT_SECRET' }]);
  assert.match(state.output, /AgentRouter recovery: disabled \(passthrough\)/);
  assert.match(state.output, /Client: harness; history: harness; protocol: passthrough; auth source: client/);
  assert.equal(state.errors, '');
  child.kill('SIGTERM');
  await closed;
  await assertListenerClosed(port);
});

test('CLI starts from another cwd, relays locally, and SIGTERM closes its listener', { timeout: 15000 }, async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rhb cli cwd '));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    let bytes = '';
    for await (const chunk of req) bytes += chunk;
    requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(bytes) });
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end('{"mock":"RESULT_42"}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => upstream.close(resolve));
    upstream.closeAllConnections();
    await closed;
  });
  const port = await unusedPort();
  const { child, closed, state } = await startCli(t, {
    RHB_UPSTREAM: `http://127.0.0.1:${upstream.address().port}/base`, RHB_PORT: String(port),
    RHB_HOST: '127.0.0.1', RHB_API_KEY: 'MOCK_ENV_SECRET',
    RHB_TOTAL_ATTEMPTS: '2', RHB_TRANSIENT_ATTEMPTS: '2', RHB_HISTORY_STRATEGY: 'on-error',
    RHB_GENERIC_400_PROJECTION: 'false', RHB_RETRY_DELAY_MS: '0',
    RHB_MAX_RETRY_DELAY_MS: '10', RHB_RETRY_JITTER_RATIO: '0'
  }, cwd);
  const body = { model: 'mock', input: 'hello' };
  const result = await post(port, body);
  assert.deepEqual(result, { status: 200, body: '{"mock":"RESULT_42"}' });
  assert.deepEqual(requests, [{ url: '/base/responses', authorization: 'Bearer MOCK_ENV_SECRET', body }]);
  assert.equal(state.errors, '');
  assert.doesNotMatch(state.output, /MOCK_ENV_SECRET|MOCK_CLIENT_SECRET/);
  child.kill('SIGTERM');
  const [code, signal] = await closed;
  // On Windows SIGTERM terminates Node rather than delivering its signal handler.
  if (process.platform !== 'win32') {
    assert.equal(code, 0);
    assert.equal(signal, null);
  }
  await assertListenerClosed(port);
  assert.deepEqual(await fs.readdir(cwd), [], 'Diagnostics must not write files unless a path is configured');
});
