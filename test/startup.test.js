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

const root = path.join(__dirname, '..');
const windows = process.platform === 'win32';

function startupEnv() {
  const env = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'PSModulePath']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const pathName = windows ? 'Path' : 'PATH';
  env[pathName] = `${path.dirname(process.execPath)}${path.delimiter}${env[pathName] || env.PATH || ''}`;
  if (windows) delete env.PATH;
  return env;
}

function powershell() {
  const candidates = process.env.RHB_TEST_POWERSHELL === 'powershell.exe' ? ['powershell.exe'] : ['pwsh', 'powershell.exe'];
  for (const command of candidates) {
    const result = spawnSync(command, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
      env: startupEnv(), stdio: 'ignore', timeout: 5000
    });
    if (!result.error && result.status === 0) return command;
  }
  return null;
}

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function closeServer(server) {
  const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}

function waitForStartup(child, state) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Launcher startup timeout: stdout=${state.output}; stderr=${state.errors}`)), 20000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', ready);
      child.off('error', failed);
      child.off('exit', exited);
    };
    const finish = error => { cleanup(); error ? reject(error) : resolve(); };
    const ready = () => { if (state.output.includes('listening at')) finish(); };
    const failed = error => finish(error);
    const exited = (code, signal) => finish(new Error(`Launcher exited before listening (${code}, ${signal}): ${state.errors}`));
    child.stdout.on('data', ready);
    child.once('error', failed);
    child.once('exit', exited);
    ready();
  });
}

async function startLauncher(t, env, input) {
  const shell = windows ? powershell() : 'bash';
  assert.ok(shell, 'Windows verification requires PowerShell');
  const script = path.join(root, 'scripts', windows ? 'start-windows.ps1' : 'start-macos.command');
  const args = windows ? ['-NoProfile', ...(input === undefined ? ['-NonInteractive'] : []), '-File', script] : [script];
  const child = spawn(shell, args, {
    cwd: os.tmpdir(), env: { ...startupEnv(), ...env }, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  closed.catch(() => {});
  t.after(async () => { await killTree(child, 'SIGKILL'); await closed; });
  const state = { output: '', errors: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { state.output += chunk; });
  child.stderr.on('data', chunk => { state.errors += chunk; });
  if (input !== undefined) child.stdin.end(input);
  await waitForStartup(child, state);
  return { child, closed, state };
}

function post(port, body, requestPath = '/v1/messages') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, method: 'POST', path: requestPath, agent: false,
      headers: { 'content-type': 'application/json', authorization: 'Bearer MOCK_CLIENT_KEY' }
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.once('end', () => resolve({ status: res.statusCode, body: text }));
      res.once('error', reject);
    });
    req.setTimeout(10000, () => req.destroy(new Error('Mock POST timeout')));
    req.once('error', reject);
    req.end(body);
  });
}

async function killTree(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (windows) {
    // Windows terminates PowerShell without forwarding SIGTERM to its Node child.
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      env: startupEnv(), stdio: 'ignore'
    });
    const [code] = await once(killer, 'exit');
    if (code !== 0 && child.exitCode === null && child.signalCode === null) throw new Error('Could not stop launcher process tree');
  } else child.kill(signal);
}

async function listenerClosed(port) {
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(5000, () => socket.destroy(new Error('Listener check timeout')));
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
  }), { code: 'ECONNREFUSED' });
}

test('launcher runs from another cwd, preserves configured env and forwards locally', { timeout: 45000 }, async t => {
  const shell = windows ? powershell() : 'bash';
  assert.ok(shell, 'Windows launcher requires powershell.exe or pwsh; missing shell is a verification failure');
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rhb startup cwd '));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const requests = [];
  // Normal empty completions reach the client unchanged without another request.
  const emptyMessage = JSON.stringify({
    id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock', content: [],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 }
  });
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(requests.length === 1 ? emptyMessage : '{"unexpected":"retry"}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => closeServer(upstream));
  const port = await unusedPort();
  const script = path.join(root, 'scripts', windows ? 'start-windows.ps1' : 'start-macos.command');
  const args = windows ? ['-NoProfile', '-NonInteractive', '-File', script] : [script];
  const child = spawn(shell, args, {
    cwd,
    env: {
      ...startupEnv(), RHB_UPSTREAM: `http://127.0.0.1:${upstream.address().port}/mock-base`,
      RHB_PORT: String(port), RHB_HOST: '127.0.0.1', RHB_CLIENT: 'generic', RHB_UPSTREAM_PROTOCOL: 'passthrough',
      RHB_API_KEY: 'MOCK_STARTUP_KEY'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  // Attach a rejection handler now in case spawn fails before startup is awaited.
  closed.catch(() => {});
  t.after(async () => { await killTree(child, 'SIGKILL'); await closed; });
  const state = { output: '', errors: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { state.output += chunk; });
  child.stderr.on('data', chunk => { state.errors += chunk; });
  await waitForStartup(child, state);

  const body = JSON.stringify({ model: 'mock', max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] });
  const result = await post(port, body);
  assert.equal(result.status, 200);
  assert.equal(result.body, emptyMessage);
  assert.deepEqual(requests, [{ method: 'POST', url: '/mock-base/messages', authorization: 'Bearer MOCK_STARTUP_KEY', body }]);
  assert.equal(state.errors, '');
  assert.match(state.output, /Client: generic; history: minimal; protocol: passthrough; auth source: bridge override/);
  assert.doesNotMatch(state.output, /\[codex\]/);
  assert.equal(state.output.includes('MOCK_STARTUP_KEY'), false);
  assert.equal(state.output.includes('MOCK_CLIENT_KEY'), false);

  await killTree(child, 'SIGTERM');
  const [code, signal] = await closed;
  if (!windows) {
    assert.equal(code, 0);
    assert.equal(signal, null);
  }
  await listenerClosed(port);
});

for (const [choice, historyMode, upstreamProtocol] of [
  ['', 'codex', 'passthrough'], ['codex', 'codex', 'passthrough'],
  ['harness', 'harness', 'passthrough'], ['claude-code', 'minimal', 'responses'],
  ['generic', 'minimal', 'passthrough']
]) {
  test(`launcher asks only for client and selects ${choice || 'default codex'}`, { timeout: 45000 }, async t => {
    const port = await unusedPort();
    const client = choice || 'codex';
    const { child, closed, state } = await startLauncher(t, {
      RHB_UPSTREAM: 'https://agentrouter.org/v1', RHB_PORT: String(port)
    }, `${choice}\n`);
    assert.match(state.output, /codex \/ harness \/ claude-code \/ generic \[codex\]/);
    assert.match(state.output, new RegExp(`Client: ${client}; history: ${historyMode}; protocol: ${upstreamProtocol}; auth source: client`));
    assert.doesNotMatch(state.output, /Upstream API Base URL|上游 API Base URL|Choose responses|选择 responses/);
    assert.equal(state.errors, '');
    await killTree(child, 'SIGTERM');
    await closed;
    await listenerClosed(port);
  });
}

test('launcher preserves preset overrides and advanced env without prompting', { timeout: 45000 }, async t => {
  const port = await unusedPort();
  const { child, closed, state } = await startLauncher(t, {
    RHB_UPSTREAM: 'https://agentrouter.org/preserved-base', RHB_PORT: String(port),
    RHB_CLIENT: 'harness', RHB_HISTORY_MODE: 'minimal', RHB_UPSTREAM_PROTOCOL: 'responses',
    RHB_RETRY_DELAY_MS: '5000', RHB_GENERIC_400_PROJECTION: 'false'
  });
  assert.match(state.output, /Upstream: https:\/\/agentrouter\.org\n/);
  assert.doesNotMatch(state.output, /preserved-base/);
  assert.match(state.output, /Client: harness; history: minimal; protocol: responses; auth source: client/);
  assert.doesNotMatch(state.output, /\[codex\]/);
  assert.equal(state.errors, '');
  await killTree(child, 'SIGTERM');
  await closed;
  await listenerClosed(port);
});

test('launcher rejects invalid selection and unsafe upstream without logging secrets', { timeout: 15000 }, () => {
  const shell = windows ? powershell() : 'bash';
  assert.ok(shell, 'Windows verification requires PowerShell');
  const script = path.join(root, 'scripts', windows ? 'start-windows.ps1' : 'start-macos.command');
  for (const [extra, input] of [
    [{ RHB_CLIENT: 'unknown', RHB_UPSTREAM: 'http://127.0.0.1:1/v1' }, undefined],
    [{ RHB_CLIENT: 'generic', RHB_UPSTREAM: 'https://MOCK_USER:MOCK_URL_SECRET@agentrouter.org/v1' }, undefined],
    [{ RHB_UPSTREAM: 'http://127.0.0.1:1/v1' }, 'unknown\n']
  ]) {
    const args = windows ? ['-NoProfile', ...(input === undefined ? ['-NonInteractive'] : []), '-File', script] : [script];
    const result = spawnSync(shell, args, {
      env: { ...startupEnv(), RHB_API_KEY: 'MOCK_ENV_SECRET', ...extra }, input,
      encoding: 'utf8', timeout: 5000
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /listening at|MOCK_USER|MOCK_URL_SECRET|MOCK_ENV_SECRET|api\.example\.com/);
    if (input === undefined) assert.doesNotMatch(result.stdout, /\[codex\]/);
  }
});

test('launcher accepts remote fixed upstream in disabled passthrough mode without contacting it', { timeout: 45000 }, async t => {
  const port = await unusedPort();
  const { child, closed, state } = await startLauncher(t, {
    RHB_CLIENT: 'claude-code', RHB_UPSTREAM: 'https://api.example.com/v1', RHB_PORT: String(port)
  });
  assert.match(state.output, /Upstream: https:\/\/api\.example\.com\n/);
  assert.match(state.output, /AgentRouter recovery: disabled \(passthrough\)/);
  assert.match(state.output, /Client: claude-code; history: minimal; protocol: passthrough; auth source: client/);
  assert.equal(state.errors, '');
  await killTree(child, 'SIGTERM');
  await closed;
  await listenerClosed(port);
});

test('launcher without upstream env uses AgentRouter default without contacting it', { timeout: 45000 }, async t => {
  const port = await unusedPort();
  const { child, closed, state } = await startLauncher(t, { RHB_CLIENT: 'claude-code', RHB_PORT: String(port) });
  assert.match(state.output, /Upstream: https:\/\/agentrouter\.org\n/);
  assert.match(state.output, /Client: claude-code; history: minimal; protocol: responses; auth source: client/);
  assert.doesNotMatch(state.output, /\[codex\]/);
  assert.equal(state.errors, '');
  await killTree(child, 'SIGTERM');
  await closed;
  await listenerClosed(port);
});

for (const historyMode of ['codex', 'harness']) {
test(`launcher converts Messages and recovers native Responses resource errors in ${historyMode} mode`, { timeout: 45000 }, async t => {
  const shell = windows ? powershell() : 'bash';
  assert.ok(shell, 'Windows verification requires PowerShell');
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'rhb converted cwd '));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const requests = [];
  let nativeCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    let bytes = '';
    for await (const chunk of req) bytes += chunk;
    const body = JSON.parse(bytes);
    requests.push({ bytes, body, auth: req.headers.authorization, url: req.url });
    const native = body.input.some(item => item.type === 'reasoning');
    if (native && ++nativeCalls === 1) {
      res.writeHead(400, { 'content-type': 'text/event-stream' });
      res.end(JSON.stringify({ error: { message: 'The requested item was created under a different Azure OpenAI resource.', type: 'invalid_request_error' } }));
      return;
    }
    const response = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'RESULT_42' }] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => closeServer(upstream));
  const port = await unusedPort();
  const script = path.join(root, 'scripts', windows ? 'start-windows.ps1' : 'start-macos.command');
  const child = spawn(shell, windows ? ['-NoProfile', '-NonInteractive', '-File', script] : [script], {
    cwd, env: { ...startupEnv(), NODE_OPTIONS: `--require="${path.join(root, 'scripts', 'mock-agentrouter.cjs')}"`, RHB_TEST_MOCK_PORT: String(upstream.address().port), RHB_UPSTREAM: 'https://agentrouter.org/v1', RHB_PORT: String(port), RHB_UPSTREAM_PROTOCOL: 'responses', RHB_HISTORY_MODE: historyMode, RHB_RETRY_DELAY_MS: '0', RHB_RESOURCE_ATTEMPTS: '3' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const closed = once(child, 'close');
  closed.catch(() => {});
  t.after(async () => { await killTree(child, 'SIGKILL'); await closed; });
  const state = { output: '', errors: '' };
  child.stdout.on('data', chunk => { state.output += chunk; });
  child.stderr.on('data', chunk => { state.errors += chunk; });
  await waitForStartup(child, state);
  const converted = await post(port, JSON.stringify({ model: 'mock', max_tokens: 50, stream: false, messages: [{ role: 'user', content: 'hello' }] }));
  assert.equal(converted.status, 200);
  assert.equal(JSON.parse(converted.body).content[0].text, 'RESULT_42');
  assert.equal(requests[0].url, '/v1/responses');
  assert.equal(requests[0].body.stream, true);
  const native = { model: 'mock', stream: true, input: [
    { type: 'message', id: 'msg_mock', role: 'user', content: [{ type: 'input_text', text: 'compute' }] },
    { type: 'reasoning', id: 'rs_mock', summary: [], encrypted_content: 'MOCK_ENCRYPTED' },
    { type: 'function_call', id: 'fc_mock', call_id: 'call_mock', name: 'add', arguments: '{"a":19,"b":23}' },
    { type: 'function_call_output', call_id: 'call_mock', output: '42' }
  ] };
  const original = JSON.stringify(native);
  const recovered = await post(port, original, '/v1/responses');
  assert.equal(recovered.status, 200);
  assert.match(recovered.body, /RESULT_42/);
  assert.equal(nativeCalls, 2);
  assert.equal(requests[1].bytes, original);
  const expected = structuredClone(native);
  for (const item of expected.input) if (['message', 'reasoning', 'function_call'].includes(item.type)) delete item.id;
  assert.deepEqual(requests[2].body, expected);
  assert.equal(requests.length, 3);
  assert.equal(requests.every(entry => entry.auth === 'Bearer MOCK_CLIENT_KEY'), true);
  assert.equal(state.errors, '');
  assert.match(state.output, new RegExp(`Client: generic; history: ${historyMode}; protocol: responses; auth source: client`));
  assert.doesNotMatch(state.output, /\[codex\]/);
  await killTree(child, 'SIGTERM');
  await closed;
  await listenerClosed(port);
});
}
