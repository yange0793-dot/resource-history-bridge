'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createServiceManager, SERVICE_ID, installEnvironment, environmentFromProcess, xml, psString, windowsArgument, unitString, unitArgument, windowsRuntimeCommand } = require('../lib/service-manager');
const { main, HELP } = require('../service-cli');

function fixture(t, platform = 'darwin', overrides = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rhb-service-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'user space 中文'), sourceDir = path.join(root, 'source');
  fs.mkdirSync(home); fs.mkdirSync(sourceDir); fs.mkdirSync(path.join(sourceDir, 'lib'));
  for (const name of ['cli.js', 'index.js', 'service-cli.js']) fs.writeFileSync(path.join(sourceDir, name), "'use strict';\n");
  fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({ name: 'resource-history-bridge', version: '0.2.0' }));
  fs.writeFileSync(path.join(sourceDir, 'lib', 'runtime.js'), "'use strict';\n");
  fs.mkdirSync(path.join(sourceDir, 'lib', 'vendor'));
  fs.writeFileSync(path.join(sourceDir, 'lib', 'vendor', 'LICENSE'), 'License preserved\n');
  fs.writeFileSync(path.join(sourceDir, 'lib', 'vendor', 'NOTICE'), 'Pinned real origin\n');
  const events = [], commands = [], state = { exists: false, owned: true, running: false, failed: false };
  const backend = {
    async inspect() { events.push('inspect'); return { ...state }; },
    async userId() { events.push('sid'); return 'S-1-5-21-111-222-333-1001'; },
    async secureDirectory() { events.push('secure'); },
    async perform(action) {
      events.push(action);
      if (action === 'install') { state.exists = true; state.running = true; }
      if (action === 'start') { state.exists = true; state.running = true; state.failed = false; }
      if (action === 'stop') { state.running = false; state.failed = false; if (platform === 'darwin') state.exists = false; }
      if (action === 'uninstall' && platform !== 'linux') state.exists = false;
    }
  };
  const io = new Proxy(fs, { get(target, name) {
    if (name === 'lstatSync') return file => { const stat = target.lstatSync(file); return new Proxy(stat, { get(item, property) { if (property === 'uid') return 501; if (property === 'mode' && process.platform === 'win32') return (item.mode & ~0o777) | (item.isDirectory() ? 0o700 : 0o600); return typeof item[property] === 'function' ? item[property].bind(item) : item[property]; } }); };
    return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
  } });
  let occupied = false;
  const configuration = { fs: io, platform, path, home, sourceDir, nodePath: path.join(home, 'Node folder', 'node'), uid: 501, backend, ...(platform === 'win32' ? { systemRoot: path.join(home, 'Windows'), powerShell: path.join(home, 'Windows', 'powershell.exe') } : {}), timeoutMs: 30, intervalMs: 10, now: () => 0, delay: async () => events.push('wait'), health: async () => ({ service: 'resource-history-bridge', version: '0.2.0', status: 'ready' }), portOccupied: async () => occupied, exec: async (file, args) => { commands.push({ file, args }); return { code: 0, stdout: '', stderr: '' }; }, ...overrides };
  return { manager: createServiceManager(configuration), configuration, root, home, sourceDir, state, backend, events, commands, setOccupied(value) { occupied = value; } };
}
const isCode = code => error => error.code === code;

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform} dry-run plans only local owned runtime files and never invokes native hooks`, async t => {
    const f = fixture(t, platform);
    fs.mkdirSync(path.join(f.sourceDir, 'lib', 'tests'));
    fs.writeFileSync(path.join(f.sourceDir, 'lib', 'tests', 'secret.json'), '{"secret":"should-not-copy"}');
    fs.writeFileSync(path.join(f.sourceDir, 'lib', '.env'), 'secret=not-runtime');
    fs.mkdirSync(path.join(f.sourceDir, 'test'));
    fs.writeFileSync(path.join(f.sourceDir, 'test', 'no.js'), 'no');
    const before = fs.readdirSync(f.home);
    const plan = await f.manager.install({ RHB_PORT: '8799', RHB_UPSTREAM: 'https://agentrouter.org/v1' }, { dryRun: true });
    assert.deepEqual(fs.readdirSync(f.home), before);
    assert.deepEqual(f.events, []); assert.deepEqual(f.commands, []);
    assert.equal(plan.service, SERVICE_ID); assert.equal(plan.port, 8799);
    assert.match(plan.releaseId, /^0\.2\.0-[a-f0-9]{16}$/);
    assert.ok(plan.files.some(file => file.path.endsWith(path.join('vendor', 'LICENSE'))));
    assert.ok(plan.files.some(file => file.path.endsWith('service-cli.js')));
    assert.ok(plan.files.every(file => file.mode === '0600'));
    assert.ok(!JSON.stringify(plan).includes('should-not-copy'));
    assert.ok(!plan.files.some(file => /[\\/](?:test|tests|docs|\.git|\.env)[\\/]/.test(file.path)));
    assert.notEqual(plan.workingDir, plan.releaseDir);
    assert.ok(!JSON.stringify(plan.commands).includes('com.tufu.resource-history-bridge'));
  });

  test(`${platform} install verifies readiness, is idempotent, stop preserves other port owner and uninstall preserves logs`, async t => {
    const f = fixture(t, platform), plan = f.manager.planInstall({ RHB_PORT: '8822' });
    const result = await f.manager.install({ RHB_PORT: '8822' });
    assert.equal(result.status, 'running'); assert.equal(result.ready, true);
    assert.deepEqual(f.events.filter(event => ['install', 'start', 'stop', 'uninstall'].includes(event)), ['install']);
    assert.equal((await f.manager.install({ RHB_PORT: '8822' })).ready, true);
    fs.writeFileSync(plan.stdoutPath, 'private runtime output');
    f.setOccupied(true);
    const stopped = await f.manager.stop();
    assert.equal(stopped.running, false); assert.equal(stopped.status, 'port-occupied');
    assert.equal((await f.manager.status()).status, 'port-occupied');
    const stoppedAgain = await f.manager.stop(); assert.equal(stoppedAgain.running, false);
    await assert.rejects(f.manager.start(), isCode('PORT_OCCUPIED'));
    const removed = await f.manager.uninstall();
    assert.equal(removed.installed, false); assert.equal(removed.preservedDataDirectory, true);
    assert.equal(fs.readFileSync(plan.stdoutPath, 'utf8'), 'private runtime output');
    assert.equal(fs.existsSync(plan.definitionPath), false);
    assert.equal(fs.existsSync(plan.manifestPath), false);
    assert.ok(fs.existsSync(path.join(plan.dataDir, 'ownership.json')));
    if (platform === 'linux') f.state.exists = false;
    f.setOccupied(false);
    assert.equal((await f.manager.install({ RHB_PORT: '8822' })).ready, true);
    assert.equal(fs.readFileSync(plan.stdoutPath, 'utf8'), 'private runtime output');
    assert.ok(f.commands.every(command => command.args.join(' ') === '--user daemon-reload'));
  });

  test(`${platform} modified owned definition is preserved before any stop/removal`, async t => {
    const f = fixture(t, platform), plan = f.manager.planInstall();
    await f.manager.install();
    fs.appendFileSync(plan.definitionPath, '\nforeign change');
    const before = [...f.events];
    await assert.rejects(f.manager.stop(), isCode('OWNERSHIP_CONFLICT'));
    await assert.rejects(f.manager.uninstall(), isCode('OWNERSHIP_CONFLICT'));
    await assert.rejects(f.manager.install(), isCode('OWNERSHIP_CONFLICT'));
    assert.deepEqual(f.events, before);
    assert.match(fs.readFileSync(plan.definitionPath, 'utf8'), /foreign change/);
    assert.ok(fs.existsSync(plan.manifestPath));
  });

  test(`${platform} install startup timeout rolls back only created artifacts`, async t => {
    const f = fixture(t, platform, { health: async () => null });
    const plan = f.manager.planInstall();
    await assert.rejects(f.manager.install(), isCode('READINESS_TIMEOUT'));
    assert.equal(fs.existsSync(plan.definitionPath), false);
    assert.equal(fs.existsSync(plan.dataDir), false);
    assert.equal(f.state.running, false);
    assert.ok(f.events.includes('stop'));
    assert.equal(fs.existsSync(`${plan.dataDir}.operation.lock`), false);
  });
}

test('install environment allowlist rejects keys and credential URL without exposing values', () => {
  for (const value of ['secret-key', '']) assert.throws(() => installEnvironment({ RHB_API_KEY: value }), error => error.code === 'SECRET_ENV' && !error.message.includes('secret-key'));
  for (const name of ['ANTHROPIC_AUTH_TOKEN', 'RHB_HOST', 'RHB_DIAGNOSTICS_PATH', 'NODE_OPTIONS', 'PATH', 'RHB_USER_AGENT']) assert.throws(() => installEnvironment({ [name]: 'secret' }), isCode('INVALID_ENV'));
  for (const RHB_UPSTREAM of ['https://name:password@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/#secret']) assert.throws(() => installEnvironment({ RHB_UPSTREAM }), error => error.code === 'INVALID_ENV' && !error.message.includes('password'));
  assert.deepEqual(environmentFromProcess({ RHB_PORT: '9000', ANTHROPIC_AUTH_TOKEN: 'do-not-store', NODE_OPTIONS: '--require malicious.js' }), { RHB_PORT: '9000' });
  assert.deepEqual(installEnvironment({ RHB_HISTORY_MODE: 'codex', RHB_UPSTREAM_PROTOCOL: 'responses', RHB_CLIENT: 'generic' }), { RHB_HISTORY_MODE: 'codex', RHB_UPSTREAM_PROTOCOL: 'responses', RHB_CLIENT: 'generic' });
});

test('invalid ports and legacy client configuration are rejected', () => {
  for (const RHB_PORT of ['0', '65536', '-1', '10.1', '1e3', ' 8790', '']) assert.throws(() => installEnvironment({ RHB_PORT }), isCode('INVALID_ENV'));
  for (const env of [{ RHB_CLIENT: 'unknown' }, { RHB_HISTORY_MODE: 'automatic' }, { RHB_UPSTREAM_PROTOCOL: 'chat' }, { RHB_PORT: 8790 }]) assert.throws(() => installEnvironment(env), isCode('INVALID_ENV'));
});

test('escaping contracts cover XML, PowerShell single quotes, Windows trailing slashes and systemd specifiers', () => {
  assert.equal(xml('<&"\'>'), '&lt;&amp;&quot;&apos;&gt;');
  assert.equal(psString("C:\\User's 中文"), "'C:\\User''s 中文'");
  assert.equal(windowsArgument('C:\\a b\\'), '"C:\\a b\\\\"');
  assert.equal(windowsArgument('a"b'), '"a\\"b"');
  assert.equal(unitString('/home/100%/a"b'), '"/home/100%%/a\\"b"');
  assert.equal(unitArgument('/home/$USER space/100%/node'), '"/home/$$USER space/100%%/node"');
  assert.equal(unitString('/home/$USER space/100%/work'), '"/home/$USER space/100%%/work"');
});

test('Windows dry-run uses fixed absolute node action, XML least privilege and encoded exact PowerShell', async t => {
  const f = fixture(t, 'win32');
  const manager = createServiceManager({ ...f.configuration, path: path.win32, home: "C:\\Users\\User's 中文", nodePath: 'C:\\Program Files\\Node\\node.exe', systemRoot: 'C:\\Windows', powerShell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' });
  const plan = manager.planInstall();
  const definition = plan.files.find(file => file.path === plan.definitionPath).content;
  assert.match(definition, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(definition, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(definition, /<Command>C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe<\/Command>/);
  assert.match(definition, /User&apos;s 中文/);
  assert.match(definition, /&quot;-EncodedCommand&quot; &quot;/);
  const runtime = windowsRuntimeCommand({ ...plan, p: path.win32 });
  assert.match(runtime.script, /& 'C:\\Program Files\\Node\\node.exe'/);
  assert.match(runtime.script, /Get-ChildItem Env:/);
  assert.ok(!runtime.args.includes('-ExecutionPolicy'));
  assert.ok(plan.taskName.startsWith(`${SERVICE_ID}-`));
  const command = plan.commands[0];
  assert.equal(Buffer.from(command.args.at(-1), 'base64').toString('utf16le'), command.script);
  assert.match(command.script, /User''s 中文/);
  assert.ok(!command.script.includes('RunAs'));
  assert.deepEqual(f.events, []);
});

test('generated bootstrap clears inherited credentials and dangerous Node runtime env', t => {
  const f = fixture(t), plan = f.manager.planInstall({ RHB_PORT: '8800' });
  const code = plan.files.find(file => file.path === plan.bootstrapPath).content;
  const processMock = { env: { RHB_API_KEY: 'secret', RHB_HOST: '0.0.0.0', NODE_OPTIONS: '--inspect', HOME: 'foreign' } };
  vm.runInNewContext(code, { process: processMock });
  assert.deepEqual(processMock.env, { RHB_PORT: '8800' });
});

test('Windows generated runtime log is capped at 1MiB without truncating prior evidence', t => {
  const f = fixture(t, 'win32'), plan = f.manager.planInstall();
  const code = plan.files.find(file => file.path === plan.bootstrapPath).content;
  fs.mkdirSync(path.dirname(plan.stdoutPath), { recursive: true });
  fs.writeFileSync(plan.stdoutPath, Buffer.alloc(1024 * 1024 - 4, 'x'));
  const descriptors = new Set();
  const logFs = new Proxy(fs, { get(target, name) {
    if (name === 'openSync') return (...args) => { const fd = target.openSync(...args); descriptors.add(fd); return fd; };
    return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
  } });
  const logRequire = name => { assert.equal(name, 'node:fs'); return logFs; };
  try {
    const processMock = { env: { RHB_API_KEY: 'secret' }, stdout: {}, stderr: {} };
    vm.runInNewContext(code, { process: processMock, require: logRequire, Buffer });
    let calls = 0;
    processMock.stdout.write('123456789', () => { calls++; });
    processMock.stderr.write('must-not-append', () => { calls++; });
    assert.equal(fs.statSync(plan.stdoutPath).size, 1024 * 1024);
    assert.equal(fs.readFileSync(plan.stdoutPath).subarray(-4).toString(), '1234');
    assert.equal(calls, 2);
    const nextProcess = { env: {}, stdout: {}, stderr: {} };
    vm.runInNewContext(code, { process: nextProcess, require: logRequire, Buffer });
    nextProcess.stdout.write('after-restart');
    assert.equal(fs.statSync(plan.stdoutPath).size, 1024 * 1024);
    assert.equal(descriptors.size, 2);
  } finally {
    for (const fd of descriptors) fs.closeSync(fd);
    descriptors.clear();
  }
  assert.equal(descriptors.size, 0);
});

test('Linux native definition escapes dollar expansion only in ExecStart', t => {
  const f = fixture(t, 'linux');
  const manager = createServiceManager({ ...f.configuration, home: path.join(f.home, '$USER space 100%'), nodePath: path.join(f.home, '$NODE space 100%', 'node') });
  const plan = manager.planInstall(), definition = plan.files.find(file => file.path === plan.definitionPath).content;
  const lines = definition.split('\n');
  assert.ok(lines.find(line => line.startsWith('ExecStart=')).includes('$$NODE space 100%%'));
  assert.ok(lines.find(line => line.startsWith('ExecStart=')).includes('$$USER space 100%%'));
  assert.ok(lines.find(line => line.startsWith('WorkingDirectory=')).includes('$USER space 100%%'));
  assert.ok(!lines.find(line => line.startsWith('WorkingDirectory=')).includes('$$USER'));
});

test('private owned directories and files use 0700 and 0600 on Unix', async t => {
  const f = fixture(t), plan = f.manager.planInstall();
  await f.manager.install();
  if (process.platform !== 'win32') {
    for (const directory of plan.directories) assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    for (const file of plan.files) assert.equal(fs.statSync(file.path).mode & 0o777, 0o600);
  }
});

test('foreign directory and native definition are refused without mutation', async t => {
  const f = fixture(t), plan = f.manager.planInstall();
  fs.mkdirSync(plan.dataDir, { recursive: true });
  fs.writeFileSync(path.join(plan.dataDir, 'keep.txt'), 'foreign');
  await assert.rejects(f.manager.install(), isCode('OWNERSHIP_CONFLICT'));
  assert.equal(fs.readFileSync(path.join(plan.dataDir, 'keep.txt'), 'utf8'), 'foreign');
  assert.deepEqual(f.events, []);
});

test('foreign native identity and occupied port are never adopted even with matching health', async t => {
  const f = fixture(t), plan = f.manager.planInstall();
  f.state.exists = true; f.state.owned = false; f.state.running = true;
  await assert.rejects(f.manager.install(), isCode('OWNERSHIP_CONFLICT'));
  await assert.rejects(f.manager.status(), isCode('OWNERSHIP_CONFLICT'));
  assert.equal(fs.existsSync(plan.dataDir), false);
  assert.ok(!f.events.includes('stop'));
  f.state.exists = false; f.state.running = false; f.setOccupied(true);
  await assert.rejects(f.manager.install(), isCode('PORT_OCCUPIED'));
  assert.equal((await f.manager.status()).status, 'port-occupied');
});

test('native ownership mismatch after install blocks every destructive action', async t => {
  const f = fixture(t), plan = f.manager.planInstall();
  await f.manager.install();
  f.state.owned = false;
  const before = f.events.filter(event => event !== 'inspect');
  for (const action of ['start', 'stop', 'uninstall', 'status']) await assert.rejects(f.manager[action](), isCode('OWNERSHIP_CONFLICT'));
  assert.deepEqual(f.events.filter(event => event !== 'inspect'), before);
  assert.ok(fs.existsSync(plan.manifestPath));
});

test('native failure during startup preserves foreign native service instead of rolling it back', async t => {
  const f = fixture(t), plan = f.manager.planInstall();
  f.backend.perform = async action => { f.events.push(action); if (action === 'install') { f.state.exists = true; f.state.owned = false; throw new Error('replaced'); } };
  await assert.rejects(f.manager.install(), isCode('ROLLBACK_PRESERVED'));
  assert.ok(fs.existsSync(plan.manifestPath));
  assert.ok(!f.events.includes('stop')); assert.ok(!f.events.includes('uninstall'));
});

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform} file transaction flush uses a writable non-truncating handle before atomic publish`, async t => {
    const f = fixture(t, platform), flags = new Map(), flushed = new Set();
    const base = f.configuration.fs;
    const io = new Proxy(base, { get(target, name) {
      if (name === 'openSync') return (file, flag, ...args) => { const fd = target.openSync(file, flag, ...args); flags.set(fd, flag); return fd; };
      if (name === 'fsyncSync') return fd => {
        assert.equal(flags.get(fd), 'r+', 'Windows FlushFileBuffers requires write access; do not skip fsync or truncate the staged file.');
        target.fsyncSync(fd); flushed.add(fd);
      };
      if (name === 'closeSync') return fd => { flags.delete(fd); return target.closeSync(fd); };
      return target[name];
    } });
    const manager = createServiceManager({ ...f.configuration, fs: io });
    assert.equal((await manager.install()).ready, true);
    assert.ok(flushed.size > 0);
    assert.equal(flags.size, 0);
  });
}

test('file transaction failure restores no files and keeps preexisting directories', async t => {
  const f = fixture(t), plan = f.manager.planInstall();
  const realIo = f.configuration.fs;
  let links = 0;
  const io = new Proxy(realIo, { get(target, name) { if (name === 'linkSync') return (source, destination) => { if (++links === 3) throw new Error('injected rename failure'); return target.linkSync(source, destination); }; return target[name]; } });
  const manager = createServiceManager({ ...f.configuration, fs: io });
  await assert.rejects(manager.install(), isCode('INSTALL_FAILED'));
  assert.equal(fs.existsSync(plan.dataDir), false);
  assert.deepEqual(fs.readdirSync(f.home), []);
  assert.ok(!f.events.includes('install'));
});

test('immediate native exit fails startup rather than trusting matching health', async t => {
  const f = fixture(t);
  const perform = f.backend.perform;
  f.backend.perform = async (action, plan) => { await perform(action, plan); if (action === 'install') { f.state.running = false; f.state.failed = true; } };
  await assert.rejects(f.manager.install(), isCode('START_FAILED'));
  assert.ok(!f.state.exists);
});

test('wrong-version health fails bounded startup, never claims success', async t => {
  const f = fixture(t, 'darwin', { health: async () => ({ service: 'resource-history-bridge', version: 'foreign', status: 'ready' }) });
  await assert.rejects(f.manager.install(), isCode('READINESS_TIMEOUT'));
  assert.equal(f.events.filter(event => event === 'wait').length, 2);
});

test('stop deadline failure leaves all artifacts intact', async t => {
  const f = fixture(t), plan = f.manager.planInstall();
  await f.manager.install();
  f.backend.perform = async action => f.events.push(action);
  await assert.rejects(f.manager.uninstall(), isCode('STOP_TIMEOUT'));
  assert.ok(fs.existsSync(plan.manifestPath));
  assert.ok(!f.events.includes('uninstall'));
});

test('release hashes reject modified and extra files before stopping service', async t => {
  const f = fixture(t), plan = f.manager.planInstall();
  await f.manager.install();
  fs.writeFileSync(path.join(plan.releaseDir, 'extra.js'), 'foreign');
  await assert.rejects(f.manager.uninstall(), isCode('OWNERSHIP_CONFLICT'));
  fs.unlinkSync(path.join(plan.releaseDir, 'extra.js'));
  fs.appendFileSync(path.join(plan.releaseDir, 'lib', 'runtime.js'), 'foreign');
  await assert.rejects(f.manager.stop(), isCode('OWNERSHIP_CONFLICT'));
  assert.ok(!f.events.includes('stop'));
});

test('source symlinks and destination symlink ancestors are refused', async t => {
  const f = fixture(t), plan = f.manager.planInstall();
  if (process.platform === 'win32') return t.skip('Symlink creation needs user-specific Windows privilege; other ownership boundaries are tested.');
  fs.symlinkSync(path.join(f.sourceDir, 'cli.js'), path.join(f.sourceDir, 'lib', 'link.js'));
  assert.throws(() => f.manager.planInstall(), isCode('UNSAFE_SOURCE'));
  fs.unlinkSync(path.join(f.sourceDir, 'lib', 'link.js'));
  fs.mkdirSync(path.dirname(plan.dataDir), { recursive: true });
  const foreign = path.join(f.root, 'foreign'); fs.mkdirSync(foreign);
  fs.symlinkSync(foreign, plan.dataDir);
  await assert.rejects(f.manager.install(), isCode('OWNERSHIP_CONFLICT'));
  assert.deepEqual(fs.readdirSync(foreign), []);
});

test('manifest path traversal and identity tampering are refused', async t => {
  const f = fixture(t), plan = f.manager.planInstall();
  await f.manager.install();
  const manifest = JSON.parse(fs.readFileSync(plan.manifestPath));
  manifest.releaseHashes['../foreign'] = crypto.createHash('sha256').update('foreign').digest('hex');
  fs.writeFileSync(plan.manifestPath, JSON.stringify(manifest));
  await assert.rejects(f.manager.uninstall(), isCode('OWNERSHIP_CONFLICT'));
  assert.ok(fs.existsSync(plan.definitionPath));
});

test('a changed version or settings never overwrites an owned installation', async t => {
  const f = fixture(t), plan = f.manager.planInstall();
  await f.manager.install();
  const original = fs.readFileSync(plan.definitionPath);
  await assert.rejects(f.manager.install({ RHB_PORT: '8899' }), isCode('ALREADY_INSTALLED'));
  fs.writeFileSync(path.join(f.sourceDir, 'cli.js'), 'new runtime version');
  await assert.rejects(f.manager.install(), isCode('ALREADY_INSTALLED'));
  assert.deepEqual(fs.readFileSync(plan.definitionPath), original);
  assert.ok(!f.events.includes('uninstall'));
});

test('metadata status contains no env, logs, credentials or model calls', async t => {
  let healthCalls = 0;
  const f = fixture(t, 'darwin', { health: async () => { healthCalls++; return { service: 'resource-history-bridge', version: '0.2.0', status: 'ready' }; } });
  await f.manager.install({ RHB_UPSTREAM: 'https://private-example.com/v1' });
  const status = await f.manager.status();
  assert.equal(status.ready, true); assert.ok(healthCalls >= 2);
  assert.ok(!JSON.stringify(status).includes('private-example'));
  assert.ok(!Object.hasOwn(status, 'environment'));
  assert.ok(!Object.hasOwn(status, 'logs'));
});

test('preexisting lock refuses concurrency without overwriting it', async t => {
  const f = fixture(t), plan = f.manager.planInstall();
  fs.mkdirSync(path.dirname(plan.dataDir), { recursive: true });
  fs.writeFileSync(`${plan.dataDir}.operation.lock`, 'foreign lock');
  await assert.rejects(f.manager.install(), isCode('BUSY'));
  assert.equal(fs.readFileSync(`${plan.dataDir}.operation.lock`, 'utf8'), 'foreign lock');
  assert.deepEqual(f.events, []);
});

test('Unix private installation directory rejects group/world access after install', async t => {
  const f = fixture(t), plan = f.manager.planInstall();
  await f.manager.install();
  if (process.platform === 'win32') return;
  fs.chmodSync(plan.dataDir, 0o755);
  await assert.rejects(f.manager.stop(), isCode('OWNERSHIP_CONFLICT'));
  assert.ok(!f.events.includes('stop'));
});

test('owned extra empty release directory is preserved rather than recursively deleted', async t => {
  const f = fixture(t), plan = f.manager.planInstall();
  await f.manager.install();
  fs.mkdirSync(path.join(plan.releaseDir, 'foreign-empty'));
  await assert.rejects(f.manager.uninstall(), isCode('OWNERSHIP_CONFLICT'));
  assert.ok(fs.existsSync(path.join(plan.releaseDir, 'foreign-empty')));
});

test('native commands and environment never operate on the legacy service', async t => {
  const f = fixture(t);
  for (const platform of ['darwin', 'linux', 'win32']) {
    const manager = createServiceManager({ ...f.configuration, platform, ...(platform === 'win32' ? { systemRoot: path.join(f.home, 'Windows'), powerShell: path.join(f.home, 'Windows', 'powershell.exe') } : {}) });
    for (const action of ['install', 'status', 'start', 'stop', 'uninstall']) {
      const plan = await manager.plan(action);
      assert.ok(!JSON.stringify(plan).includes('com.tufu.resource-history-bridge'));
      assert.ok(plan.commands.every(command => !['kill', 'taskkill'].some(unsafe => command.file.endsWith(unsafe))));
      if (action === 'install' && platform !== 'win32') assert.ok(plan.files.find(file => file.path === plan.bootstrapPath).content.includes('Object.keys(process.env)'));
    }
  }
  assert.deepEqual(f.events, []);
});

test('platform/path/user checks reject unsupported systems, root and control characters', t => {
  const f = fixture(t);
  assert.throws(() => createServiceManager({ ...f.configuration, platform: 'freebsd' }), isCode('UNSUPPORTED_PLATFORM'));
  assert.throws(() => createServiceManager({ ...f.configuration, uid: 0 }), isCode('ROOT_USER'));
  assert.throws(() => createServiceManager({ ...f.configuration, nodePath: `${f.home}\nnode` }), isCode('INVALID_PATH'));
});

test('CLI help, injected actions, dry-run and secret errors never invoke real service backend', async () => {
  let output = '', errorOutput = '';
  const stdout = { write(value) { output += value; } }, stderr = { write(value) { errorOutput += value; } };
  const events = [], manager = {
    async plan(action, env) { events.push(['plan', action, env]); return { dryRun: true }; },
    async install(env) { events.push(['install', env]); return { ready: true }; },
    async status() { events.push(['status']); return { installed: false }; }
  };
  assert.equal(await main({ argv: [], stdout, stderr }), 0); assert.equal(output, HELP);
  output = '';
  assert.equal(await main({ argv: ['install', '--dry-run'], env: { RHB_PORT: '8792', ANTHROPIC_AUTH_TOKEN: 'secret' }, manager, stdout, stderr }), 0);
  assert.deepEqual(events.at(-1), ['plan', 'install', { RHB_PORT: '8792' }]);
  assert.equal(await main({ argv: ['install'], env: { RHB_API_KEY: 'do-not-echo' }, manager, stdout, stderr }), 1);
  assert.ok(errorOutput.includes('SECRET_ENV')); assert.ok(!errorOutput.includes('do-not-echo'));
  assert.equal(await main({ argv: ['status'], manager, stdout, stderr }), 0);
  assert.equal(await main({ argv: ['stop', '--force'], manager, stdout, stderr }), 1);
});

test('default macOS native backend verifies path and exact action rather than PID or health', async t => {
  const f = fixture(t), installed = f.manager.planInstall();
  await f.manager.install();
  const calls = [];
  const exec = async (file, args, options) => {
    calls.push({ file, args, options });
    return { code: 0, stderr: '', stdout: `gui/501/${SERVICE_ID} = {\n path = ${installed.definitionPath}\n state = running\n arguments = {\n /usr/bin/env\n -i\n ${installed.nodePath}\n --require\n ${installed.bootstrapPath}\n ${path.join(installed.releaseDir, 'cli.js')}\n }\n}` };
  };
  const manager = createServiceManager({ ...f.configuration, backend: undefined, exec });
  assert.equal((await manager.status()).ready, true);
  assert.deepEqual(calls[0].args, ['print', `gui/501/${SERVICE_ID}`]);
  assert.ok(!Object.hasOwn(calls[0].options.env, 'RHB_API_KEY'));
  const badManager = createServiceManager({ ...f.configuration, backend: undefined, exec: async () => ({ code: 0, stderr: '', stdout: `path = ${installed.definitionPath}\nstate = running\narguments = {\n /usr/bin/env\n -i\n foreign\n }\n` }) });
  await assert.rejects(badManager.stop(), isCode('OWNERSHIP_CONFLICT'));
});

test('default Windows native backend verifies principal, encoded action and triggers before stopping', async t => {
  const f = fixture(t, 'win32');
  await f.manager.install();
  const plan = { ...f.manager.planInstall(), p: path, userId: 'S-1-5-21-111-222-333-1001' };
  const runtime = windowsRuntimeCommand(plan), argumentsText = runtime.args.map(windowsArgument).join(' ');
  const cli = path.join(plan.releaseDir, 'cli.js');
  const fingerprint = crypto.createHash('sha256').update(`${JSON.stringify({ command: runtime.file, arguments: argumentsText, nodePath: plan.nodePath, cli, bootstrapPath: plan.bootstrapPath, workingDir: plan.workingDir, taskName: plan.taskName, userId: plan.userId }, null, 2)}\n`).digest('hex');
  const value = { exists: true, sid: plan.userId, user: plan.userId, name: plan.taskName, path: '\\', state: 'Running', actions: [{ command: runtime.file, arguments: argumentsText, working: plan.workingDir }], level: 'Limited', logon: 'Interactive', description: `${SERVICE_ID}:${fingerprint}`, triggers: [{ class: 'MSFT_TaskLogonTrigger', user: plan.userId, enabled: true }], enabled: true, multiple: 'IgnoreNew', limit: 'PT0S', result: 0 };
  const manager = createServiceManager({ ...f.configuration, backend: undefined, exec: async () => ({ code: 0, stdout: JSON.stringify(value), stderr: '' }) });
  assert.equal((await manager.status()).ready, true);
  for (const change of [{ user: 'S-1-5-18' }, { sid: 'S-1-5-18' }, { level: 'Highest' }, { logon: 'Password' }, { path: '\\foreign\\' }, { actions: [...value.actions, ...value.actions] }, { triggers: [] }, { multiple: 'Parallel' }, { description: 'foreign' }]) {
    const wrong = createServiceManager({ ...f.configuration, backend: undefined, exec: async () => ({ code: 0, stdout: JSON.stringify({ ...value, ...change }), stderr: '' }) });
    await assert.rejects(wrong.stop(), isCode('OWNERSHIP_CONFLICT'));
  }
});

test('default Linux native backend rejects drop-ins and action substitutions', async t => {
  const f = fixture(t, 'linux'), installed = f.manager.planInstall();
  await f.manager.install();
  const expected = ['/usr/bin/env', '-i', installed.nodePath, '--require', installed.bootstrapPath, path.join(installed.releaseDir, 'cli.js')].join(' ');
  const base = `LoadState=loaded\nActiveState=active\nSubState=running\nFragmentPath=${installed.definitionPath}\nDropInPaths=\nExecStart={ path=/usr/bin/env ; argv[]=${expected} ; ignore_errors=no ; start_time=[n/a] ; }\n`;
  const manager = createServiceManager({ ...f.configuration, backend: undefined, exec: async () => ({ code: 0, stdout: base, stderr: '' }) });
  assert.equal((await manager.status()).ready, true);
  for (const stdout of [base.replace('DropInPaths=\n', 'DropInPaths=/foreign/override.conf\n'), base.replace(`argv[]=${expected}`, `argv[]=${expected} --inspect`), base.replace(`FragmentPath=${installed.definitionPath}`, 'FragmentPath=/foreign/service')]) {
    const wrong = createServiceManager({ ...f.configuration, backend: undefined, exec: async () => ({ code: 0, stdout, stderr: '' }) });
    await assert.rejects(wrong.stop(), isCode('OWNERSHIP_CONFLICT'));
  }
});
