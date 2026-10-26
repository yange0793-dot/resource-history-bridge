'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { validateAgentRouterUpstream } = require('./agentrouter');
const { resolveClientConfig } = require('./client-config');

const SERVICE_ID = 'org.resource-history-bridge.user';
const ENV_NAMES = Object.freeze(['RHB_UPSTREAM', 'RHB_PORT', 'RHB_CLIENT', 'RHB_HISTORY_MODE', 'RHB_UPSTREAM_PROTOCOL']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const xml = value => String(value).replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]);
const psString = value => `'${String(value).replace(/'/g, "''")}'`;
const windowsArgument = value => `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
const unitString = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
const unitArgument = value => unitString(String(value).replace(/\$/g, '$$$$'));

class ServiceError extends Error {
  constructor(code, message) { super(message); this.name = 'ServiceError'; this.code = code; }
}
function refuse(code, message) { throw new ServiceError(code, message); }
function cleanPath(value, p) {
  if (typeof value !== 'string' || !p.isAbsolute(value) || /[\x00-\x1f]/.test(value)) refuse('INVALID_PATH', 'Service paths must be absolute and contain no control characters.');
  return p.normalize(value);
}
function installEnvironment(input = {}) {
  if (Object.hasOwn(input, 'RHB_API_KEY')) refuse('SECRET_ENV', 'Service installation cannot save RHB_API_KEY. Keep authentication in the client; client credentials are forwarded.');
  const env = {};
  for (const name of Object.keys(input)) {
    if (!ENV_NAMES.includes(name)) refuse('INVALID_ENV', 'Service installation accepts only explicit upstream, port and legacy client/protocol settings.');
    if (typeof input[name] !== 'string' || /[\x00-\x1f]/.test(input[name])) refuse('INVALID_ENV', 'Invalid service environment setting.');
    env[name] = input[name];
  }
  if (env.RHB_UPSTREAM !== undefined) {
    try { env.RHB_UPSTREAM = validateAgentRouterUpstream(env.RHB_UPSTREAM).href; }
    catch { refuse('INVALID_ENV', 'Invalid service upstream URL; credentials, queries and fragments are not accepted.'); }
  }
  if (env.RHB_PORT !== undefined && (!/^\d+$/.test(env.RHB_PORT) || Number(env.RHB_PORT) < 1 || Number(env.RHB_PORT) > 65535)) refuse('INVALID_ENV', 'RHB_PORT must be between 1 and 65535.');
  try { resolveClientConfig(env); } catch { refuse('INVALID_ENV', 'Invalid legacy client/history/protocol setting.'); }
  return env;
}
function environmentFromProcess(env = {}) {
  const selected = {};
  for (const name of [...ENV_NAMES, 'RHB_API_KEY']) if (Object.hasOwn(env, name)) selected[name] = env[name];
  return installEnvironment(selected);
}
function powerShellCommand(binary, script) {
  return { file: binary, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], script };
}
function windowsRuntimeCommand(plan) {
  const cli = plan.p.join(plan.releaseDir, 'cli.js');
  const script = `$ErrorActionPreference = 'Stop'; Get-ChildItem Env: | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name, $null, 'Process') }; $env:SystemRoot=${psString(plan.systemRoot)}; & ${psString(plan.nodePath)} '--require' ${psString(plan.bootstrapPath)} ${psString(cli)}; exit $LASTEXITCODE`;
  return powerShellCommand(plan.powerShell, script);
}
function nativeDefinition(plan) {
  const { platform, nodePath, releaseDir, workingDir, bootstrapPath, definitionPath, taskName, userId } = plan;
  const cli = plan.p.join(releaseDir, 'cli.js');
  if (platform === 'darwin') {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${SERVICE_ID}</string>\n<key>ProgramArguments</key><array>${['/usr/bin/env', '-i', nodePath, '--require', bootstrapPath, cli].map(value => `<string>${xml(value)}</string>`).join('')}</array>\n<key>WorkingDirectory</key><string>${xml(workingDir)}</string>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>5</integer><key>Umask</key><integer>63</integer>\n<key>StandardOutPath</key><string>${xml(plan.stdoutPath)}</string>\n<key>StandardErrorPath</key><string>${xml(plan.stderrPath)}</string>\n</dict></plist>\n`;
  }
  if (platform === 'linux') {
    return `[Unit]\nDescription=Resource history bridge user service\nStartLimitIntervalSec=30\nStartLimitBurst=5\n\n[Service]\nType=simple\nWorkingDirectory=${unitString(workingDir)}\nExecStart=/usr/bin/env -i ${[nodePath, '--require', bootstrapPath, cli].map(unitArgument).join(' ')}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=15\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=default.target\n`;
  }
  const runtime = windowsRuntimeCommand(plan);
  const argumentsText = runtime.args.map(windowsArgument).join(' ');
  const fingerprint = hash(json({ command: runtime.file, arguments: argumentsText, nodePath, cli, bootstrapPath, workingDir, taskName, userId }));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n<RegistrationInfo><Description>${SERVICE_ID}:${fingerprint}</Description><URI>\\${xml(taskName)}</URI></RegistrationInfo>\n<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(userId)}</UserId></LogonTrigger></Triggers>\n<Principals><Principal id="Author"><UserId>${xml(userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>\n<Actions Context="Author"><Exec><Command>${xml(runtime.file)}</Command><Arguments>${xml(argumentsText)}</Arguments><WorkingDirectory>${xml(workingDir)}</WorkingDirectory></Exec></Actions>\n</Task>\n`;
}
function bootstrapDefinition(plan) {
  const logging = plan.platform === 'win32' ? `\nconst fs = require('node:fs');\nconst log = fs.openSync(${JSON.stringify(plan.stdoutPath)}, 'a', 0o600);\nlet remaining = Math.max(0, 1024 * 1024 - fs.fstatSync(log).size);\nfor (const stream of [process.stdout, process.stderr]) stream.write = (chunk, encoding, callback) => {\n  if (typeof encoding === 'function') callback = encoding;\n  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');\n  if (remaining > 0) remaining -= fs.writeSync(log, bytes.subarray(0, remaining));\n  if (callback) callback();\n  return true;\n};\n` : '\n';
  return `'use strict';\nfor (const name of Object.keys(process.env)) delete process.env[name];\nObject.assign(process.env, ${JSON.stringify(plan.environment)});${logging}`;
}

function defaultExec(file, args, options) {
  return new Promise((resolve, reject) => execFile(file, args, options, (error, stdout, stderr) => {
    if (error && typeof error.code !== 'number') return reject(new ServiceError('NATIVE_UNAVAILABLE', 'The native per-user service manager could not be executed.'));
    resolve({ code: error ? error.code : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
  }));
}
function defaultHealth(port, timeoutMs = 500) {
  return new Promise(resolve => {
    let settled = false, timer;
    const done = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const request = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: timeoutMs, agent: false }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 4096) { response.destroy(); done(null); } });
      response.on('end', () => { try { done(response.statusCode === 200 ? JSON.parse(body) : null); } catch { done(null); } });
      response.on('error', () => done(null));
    });
    timer = setTimeout(() => { request.destroy(); done(null); }, timeoutMs);
    request.on('timeout', () => { request.destroy(); done(null); });
    request.on('error', () => done(null));
  });
}
function defaultPortOccupied(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function createServiceManager(options = {}) {
  const io = options.fs || fs;
  const platform = options.platform || process.platform;
  if (!['darwin', 'linux', 'win32'].includes(platform)) refuse('UNSUPPORTED_PLATFORM', 'Only native macOS, Linux and Windows per-user services are supported.');
  const p = options.path || (platform === 'win32' ? path.win32 : path.posix);
  const home = cleanPath(options.home || os.homedir(), p);
  const sourceDir = options.sourceDir || path.resolve(__dirname, '..');
  const nodePath = cleanPath(options.nodePath || process.execPath, p);
  const uid = options.uid ?? (process.getuid ? process.getuid() : undefined);
  if (platform !== 'win32' && uid === 0) refuse('ROOT_USER', 'Run this installer as your normal user, not root or an administrator.');
  const dataDir = p.join(home, ...(platform === 'darwin' ? ['Library', 'Application Support'] : platform === 'win32' ? ['AppData', 'Local'] : ['.local', 'share']), SERVICE_ID);
  const taskName = `${SERVICE_ID}-${hash(home).slice(0, 12)}`;
  const definitionPath = platform === 'darwin' ? p.join(home, 'Library', 'LaunchAgents', `${SERVICE_ID}.plist`) : platform === 'linux' ? p.join(home, '.config', 'systemd', 'user', `${SERVICE_ID}.service`) : p.join(dataDir, 'task.xml');
  const manifestPath = p.join(dataDir, 'installation.json');
  const ownerPath = p.join(dataDir, 'ownership.json');
  const ownerContents = Buffer.from(json({ schema: 1, service: SERVICE_ID, home, platform }));
  const powerShell = options.powerShell || p.join(options.systemRoot || (platform === 'win32' ? process.env.SystemRoot || 'C:\\Windows' : 'C:\\Windows'), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const execute = options.exec || defaultExec;
  const health = options.health || defaultHealth;
  const portOccupied = options.portOccupied || defaultPortOccupied;
  const delay = options.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 10000;
  const intervalMs = options.intervalMs ?? 100;
  const now = options.now || Date.now;
  let sequence = 0;
  const fail = message => refuse('OWNERSHIP_CONFLICT', message || 'Service files or native definition are foreign or modified; they have been preserved.');
  const exists = file => { try { return io.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  function checkPath(file) {
    let cursor = file;
    while (cursor !== p.dirname(cursor)) {
      const stat = exists(cursor);
      if (stat && stat.isSymbolicLink()) fail('Service paths must not contain symbolic links; existing paths have been preserved.');
      cursor = p.dirname(cursor);
    }
  }
  function readRegular(file) {
    checkPath(file);
    const stat = exists(file);
    if (!stat || !stat.isFile() || (platform !== 'win32' && uid !== undefined && stat.uid !== uid)) fail();
    return io.readFileSync(file);
  }
  async function run(command, checked = true) {
    const env = platform === 'win32' ? { SystemRoot: options.systemRoot || process.env.SystemRoot || 'C:\\Windows', USERPROFILE: home } : { HOME: home, PATH: '/usr/bin:/bin', ...(platform === 'linux' ? { XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus` } : {}) };
    const result = await execute(command.file, command.args, { env, windowsHide: true, timeout: 10000, maxBuffer: 128 * 1024 });
    if (checked && result.code !== 0) refuse('NATIVE_FAILURE', 'The native per-user service operation failed. No administrator elevation or PID cleanup was attempted.');
    return result;
  }
  const ps = script => powerShellCommand(powerShell, `$ErrorActionPreference = 'Stop'; ${script}`);
  function nativeCommands(plan, action) {
    const target = `gui/${uid}/${SERVICE_ID}`;
    if (platform === 'darwin') {
      const launchctl = args => ({ file: '/bin/launchctl', args });
      return action === 'install' ? [launchctl(['bootstrap', `gui/${uid}`, definitionPath])] : action === 'start-loaded' ? [launchctl(['kickstart', target])] : action === 'start' ? [launchctl(['bootstrap', `gui/${uid}`, definitionPath])] : action === 'stop' || action === 'uninstall' ? [launchctl(['bootout', target])] : [launchctl(['print', target])];
    }
    if (platform === 'linux') {
      const systemctl = args => ({ file: '/usr/bin/systemctl', args: ['--user', ...args] });
      return action === 'install' ? [systemctl(['daemon-reload']), systemctl(['enable', `${SERVICE_ID}.service`]), systemctl(['start', `${SERVICE_ID}.service`])] : action === 'uninstall' ? [systemctl(['disable', `${SERVICE_ID}.service`])] : action === 'status' ? [systemctl(['show', `${SERVICE_ID}.service`, '--no-pager', '--property=LoadState,ActiveState,SubState,Result,FragmentPath,DropInPaths,ExecStart'])] : [systemctl([action, `${SERVICE_ID}.service`])];
    }
    const select = `-TaskName ${psString(taskName)} -TaskPath '\\'`;
    return [ps(action === 'install' ? `$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if ($sid -ne ${psString(plan.userId)}) { throw 'Wrong user' }; if (Get-ScheduledTask ${select} -ErrorAction SilentlyContinue) { throw 'Task exists' }; Register-ScheduledTask ${select} -Xml ([IO.File]::ReadAllText(${psString(definitionPath)})) | Out-Null; Start-ScheduledTask ${select}` : action === 'uninstall' ? `Unregister-ScheduledTask ${select} -Confirm:$false` : action === 'start' ? `Start-ScheduledTask ${select}` : action === 'stop' ? `Stop-ScheduledTask ${select}` : `Get-ScheduledTask ${select} | Select-Object TaskName,TaskPath,State | ConvertTo-Json -Compress`)];
  }
  const defaultBackend = {
    async userId() {
      const result = await run(ps(`[Security.Principal.WindowsIdentity]::GetCurrent().User.Value`));
      const sid = result.stdout.trim();
      if (!/^S-1-5-(?:\d+-)*\d+$/.test(sid)) refuse('NATIVE_FAILURE', 'Could not verify the current Windows user SID.');
      return sid;
    },
    async inspect(plan) {
      if (platform === 'darwin') {
        const result = await run(nativeCommands(plan, 'status')[0], false);
        if (result.code !== 0) {
          if (/could not find service|service not found/i.test(result.stderr)) return { exists: false, owned: true, running: false };
          refuse('NATIVE_FAILURE', 'Could not inspect the current user LaunchAgent.');
        }
        const match = result.stdout.match(/\barguments = \{([\s\S]*?)\n\s*\}/);
        const args = match ? match[1].split('\n').map(line => line.trim()).filter(Boolean) : [];
        const expected = plan.releaseDir ? ['/usr/bin/env', '-i', plan.nodePath, '--require', plan.bootstrapPath, p.join(plan.releaseDir, 'cli.js')] : [];
        const pathMatches = result.stdout.split('\n').some(line => line.trim() === `path = ${definitionPath}`);
        const running = /\bstate = running\b/.test(result.stdout);
        return { exists: true, owned: pathMatches && json(args) === json(expected), running, failed: !running && /\blast exit code = [1-9]\d*/.test(result.stdout) };
      }
      if (platform === 'linux') {
        const result = await run(nativeCommands(plan, 'status')[0], false);
        const values = Object.fromEntries(result.stdout.split('\n').filter(line => line.includes('=')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
        if (values.LoadState === 'not-found') return { exists: false, owned: true, running: false };
        if (result.code !== 0 || !values.LoadState) refuse('NATIVE_FAILURE', 'Could not inspect the current user systemd service.');
        const invocation = values.ExecStart?.match(/^\{ path=\/usr\/bin\/env ; argv\[\]=([\s\S]*?) ; ignore_errors=no ;/);
        const expected = plan.releaseDir ? ['/usr/bin/env', '-i', plan.nodePath, '--require', plan.bootstrapPath, p.join(plan.releaseDir, 'cli.js')] : [];
        const escaped = expected.map(value => value.replace(/\\/g, '\\\\').replace(/ /g, '\\x20').replace(/\t/g, '\\x09')).join(' ');
        const owned = values.FragmentPath === definitionPath && !values.DropInPaths && invocation && [expected.join(' '), escaped].includes(invocation[1]);
        return { exists: true, owned: Boolean(owned), running: values.ActiveState === 'active' && values.SubState === 'running', failed: values.ActiveState === 'failed' };
      }
      const select = `-TaskName ${psString(taskName)} -TaskPath '\\'`;
      const script = `$t=Get-ScheduledTask ${select} -ErrorAction SilentlyContinue; if (!$t) { '{"exists":false}'; exit 0 }; $info=Get-ScheduledTaskInfo ${select}; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; [pscustomobject]@{exists=$true; sid=$sid; name=$t.TaskName; path=$t.TaskPath; state=[string]$t.State; actions=@($t.Actions | ForEach-Object { [pscustomobject]@{command=$_.Execute; arguments=$_.Arguments; working=$_.WorkingDirectory} }); user=$t.Principal.UserId; level=[string]$t.Principal.RunLevel; logon=[string]$t.Principal.LogonType; description=$t.Description; triggers=@($t.Triggers | ForEach-Object { [pscustomobject]@{class=$_.CimClass.CimClassName; user=$_.UserId; enabled=$_.Enabled} }); enabled=$t.Settings.Enabled; multiple=[string]$t.Settings.MultipleInstances; limit=$t.Settings.ExecutionTimeLimit; result=$info.LastTaskResult} | ConvertTo-Json -Depth 6 -Compress`;
      const result = await run(ps(script));
      let value;
      try { value = JSON.parse(result.stdout); } catch { refuse('NATIVE_FAILURE', 'Could not decode the current user Scheduled Task metadata.'); }
      if (!value.exists) return { exists: false, owned: true, running: false };
      if (!plan.releaseDir) return { exists: true, owned: false, running: value.state === 'Running' };
      const cli = p.join(plan.releaseDir, 'cli.js');
      const runtime = windowsRuntimeCommand(plan), argumentsText = runtime.args.map(windowsArgument).join(' ');
      const fingerprint = hash(json({ command: runtime.file, arguments: argumentsText, nodePath: plan.nodePath, cli, bootstrapPath: plan.bootstrapPath, workingDir: plan.workingDir, taskName, userId: plan.userId }));
      const expectedAction = [{ command: runtime.file, arguments: argumentsText, working: plan.workingDir }];
      const expectedTriggers = [{ class: 'MSFT_TaskLogonTrigger', user: plan.userId, enabled: true }];
      const owned = value.sid === plan.userId && value.user === plan.userId && value.name === taskName && value.path === '\\' && value.level === 'Limited' && value.logon === 'Interactive' && value.description === `${SERVICE_ID}:${fingerprint}` && json(value.actions) === json(expectedAction) && json(value.triggers) === json(expectedTriggers) && value.enabled === true && value.multiple === 'IgnoreNew' && value.limit === 'PT0S';
      return { exists: true, owned, running: value.state === 'Running', failed: value.state !== 'Running' && value.result !== 0 && value.result !== 267011 };
    },
    async perform(action, plan) {
      if (platform === 'darwin' && action === 'start' && (await this.inspect(plan)).exists) action = 'start-loaded';
      if (platform === 'win32') {
        const runtime = windowsRuntimeCommand(plan), expectedArguments = runtime.args.map(windowsArgument).join(' ');
        const guard = `$t=Get-ScheduledTask -TaskName ${psString(taskName)} -TaskPath '\\' -ErrorAction SilentlyContinue; if ($t) { $a=@($t.Actions); if ($a.Count -ne 1 -or $a[0].Execute -cne ${psString(runtime.file)} -or $a[0].Arguments -cne ${psString(expectedArguments)} -or $a[0].WorkingDirectory -cne ${psString(plan.workingDir)} -or $t.Principal.UserId -ne ${psString(plan.userId)}) { throw 'Foreign task' } }; if (${psString(action)} -ne 'install' -and !$t) { throw 'Missing task' }; `;
        for (const command of nativeCommands(plan, action)) await run(ps(guard + command.script));
        return;
      }
      for (const command of nativeCommands(plan, action)) await run(command);
    },
    async secureDirectory(plan) {
      if (platform === 'win32') await run({ file: p.join(options.systemRoot || process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), args: [dataDir, '/inheritance:r', '/grant:r', `*${plan.userId}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'] });
    }
  };
  const backend = options.backend || defaultBackend;

  function basePlan(environment, version, releaseId, userId) {
    const releaseDir = p.join(dataDir, 'releases', releaseId);
    return { p, service: SERVICE_ID, platform, home, dataDir, definitionPath, manifestPath, taskName, userId, nodePath, ...(platform === 'win32' ? { powerShell, systemRoot: options.systemRoot || process.env.SystemRoot || 'C:\\Windows' } : {}), releaseDir, releaseId, version, environment, port: Number(environment.RHB_PORT || 8790), workingDir: p.join(dataDir, 'work'), bootstrapPath: p.join(dataDir, 'service-environment.cjs'), stdoutPath: p.join(dataDir, 'logs', 'runtime.log'), stderrPath: p.join(dataDir, 'logs', 'runtime-error.log') };
  }
  function sourceFiles() {
    const files = {};
    function collect(relative) {
      const absolute = path.join(sourceDir, relative);
      const stat = io.lstatSync(absolute);
      if (stat.isSymbolicLink()) refuse('UNSAFE_SOURCE', 'Runtime release sources must not contain symbolic links.');
      if (/[\x00-\x1f]/.test(relative)) refuse('UNSAFE_SOURCE', 'Runtime release filenames must not contain control characters.');
      if (stat.isDirectory()) {
        for (const name of io.readdirSync(absolute).sort()) {
          if (['test', 'tests', 'docs', '.git', 'node_modules'].includes(name) || name.startsWith('.')) continue;
          collect(path.join(relative, name));
        }
      } else if (stat.isFile()) {
        const name = path.basename(relative);
        if (/\.(?:js|cjs|json)$/.test(name) || ['LICENSE', 'NOTICE'].includes(name)) files[relative.split(path.sep).join('/')] = io.readFileSync(absolute);
      } else refuse('UNSAFE_SOURCE', 'Runtime sources contain an unsupported file type.');
    }
    for (const relative of ['cli.js', 'index.js', 'package.json', 'service-cli.js', 'lib']) collect(relative);
    return files;
  }
  function publicPlan(plan, action) {
    const { p: ignoredPath, buffers: ignoredBuffers, ...value } = plan;
    return { ...value, action, dryRun: true, commands: nativeCommands(plan, action), ...(platform === 'win32' && action === 'install' ? { permissions: { file: p.join(options.systemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), args: [dataDir, '/inheritance:r', '/grant:r', `*${plan.userId}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'] } } : {}) };
  }
  function planInstall(input = {}, userId = platform === 'win32' ? '<current-user-sid>' : undefined) {
    const environment = installEnvironment(input);
    const sources = sourceFiles();
    let version;
    try { const pkg = JSON.parse(sources['package.json']); if (pkg.name !== 'resource-history-bridge' || !/^[0-9A-Za-z._-]+$/.test(pkg.version)) throw new Error(); version = pkg.version; }
    catch { refuse('INVALID_SOURCE', 'Runtime package identity/version is invalid.'); }
    const releaseHashes = Object.fromEntries(Object.entries(sources).map(([name, contents]) => [name, hash(contents)]));
    const releaseId = `${version}-${hash(json(releaseHashes)).slice(0, 16)}`;
    const plan = basePlan(environment, version, releaseId, userId);
    if (platform === 'win32') { cleanPath(plan.powerShell, p); cleanPath(plan.systemRoot, p); }
    const buffers = Object.fromEntries(Object.entries(sources).map(([name, contents]) => [p.join(plan.releaseDir, ...name.split('/')), contents]));
    buffers[plan.bootstrapPath] = Buffer.from(bootstrapDefinition(plan));
    buffers[definitionPath] = Buffer.from(nativeDefinition(plan));
    const manifest = { schema: 1, service: SERVICE_ID, platform, home, nodePath, version, releaseId, userId, environment, releaseHashes, definitionHash: hash(buffers[definitionPath]), bootstrapHash: hash(buffers[plan.bootstrapPath]) };
    buffers[manifestPath] = Buffer.from(json(manifest));
    buffers[ownerPath] = ownerContents;
    return { ...plan, manifest, buffers, files: Object.entries(buffers).map(([file, contents]) => ({ path: file, sha256: hash(contents), mode: '0600', ...(file === definitionPath || file === plan.bootstrapPath ? { content: contents.toString() } : {}) })), directories: [dataDir, p.join(dataDir, 'releases'), plan.releaseDir, plan.workingDir, p.join(dataDir, 'logs')] };
  }
  function installedPlan() {
    checkPath(dataDir); checkPath(definitionPath);
    if (exists(dataDir)) {
      if (!exists(dataDir).isDirectory() || !exists(ownerPath) || !readRegular(ownerPath).equals(ownerContents)) fail('The data directory is foreign or has no matching ownership record; it has been preserved.');
      if (platform !== 'win32' && (exists(dataDir).uid !== uid || (exists(dataDir).mode & 0o077))) fail('The owned data directory must be private to the installing user.');
    }
    if (!exists(manifestPath)) {
      if (exists(definitionPath)) fail('A native definition exists without its ownership manifest; it has been preserved.');
      return null;
    }
    let manifest;
    try { manifest = JSON.parse(readRegular(manifestPath)); } catch { fail(); }
    if (manifest.schema !== 1 || manifest.service !== SERVICE_ID || manifest.platform !== platform || manifest.home !== home || !/^[0-9A-Za-z._-]+-[a-f0-9]{16}$/.test(manifest.releaseId) || !/^[0-9A-Za-z._-]+$/.test(manifest.version)) fail();
    if (platform === 'win32' && !/^S-1-5-(?:\d+-)*\d+$/.test(manifest.userId)) fail();
    cleanPath(manifest.nodePath, p);
    let environment;
    try { environment = installEnvironment(manifest.environment); } catch { fail(); }
    if (json(environment) !== json(manifest.environment) || !manifest.releaseHashes || typeof manifest.releaseHashes !== 'object') fail();
    if (manifest.releaseId !== `${manifest.version}-${hash(json(manifest.releaseHashes)).slice(0, 16)}`) fail();
    const plan = { ...basePlan(environment, manifest.version, manifest.releaseId, manifest.userId), nodePath: manifest.nodePath, manifest };
    if (hash(nativeDefinition(plan)) !== manifest.definitionHash || hash(bootstrapDefinition(plan)) !== manifest.bootstrapHash || hash(readRegular(definitionPath)) !== manifest.definitionHash || hash(readRegular(plan.bootstrapPath)) !== manifest.bootstrapHash) fail();
    for (const required of ['cli.js', 'index.js', 'package.json', 'service-cli.js']) if (!Object.hasOwn(manifest.releaseHashes, required)) fail();
    let installedVersion;
    try { const pkg = JSON.parse(readRegular(p.join(plan.releaseDir, 'package.json'))); if (pkg.name !== 'resource-history-bridge') fail(); installedVersion = pkg.version; } catch { fail(); }
    if (installedVersion !== manifest.version) fail();
    for (const [name, expected] of Object.entries(manifest.releaseHashes)) {
      if (/[\x00-\x1f]/.test(name) || !/^[a-f0-9]{64}$/.test(expected) || name.includes('\\') || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..') || !(name.startsWith('lib/') || ['cli.js', 'index.js', 'package.json', 'service-cli.js'].includes(name))) fail();
      if (hash(readRegular(p.join(plan.releaseDir, ...name.split('/')))) !== expected) fail();
    }
    function checkRelease(directory, relative = '') {
      for (const name of io.readdirSync(directory)) {
        const child = p.join(directory, name), stat = exists(child), key = relative ? `${relative}/${name}` : name;
        if (stat.isSymbolicLink()) fail();
        if (stat.isDirectory()) {
          if (!Object.keys(manifest.releaseHashes).some(file => file.startsWith(`${key}/`))) fail();
          checkRelease(child, key);
        }
        else if (!stat.isFile() || !Object.hasOwn(manifest.releaseHashes, key)) fail();
      }
    }
    checkRelease(plan.releaseDir);
    return plan;
  }
  async function inspect(plan) {
    const native = await backend.inspect(plan || { service: SERVICE_ID, platform, definitionPath, taskName });
    if (native.exists && (!plan || !native.owned)) fail('The native per-user service identity does not match this installation; it has been preserved.');
    return native;
  }
  function metadata(plan, native, ready, occupied) {
    return { service: SERVICE_ID, platform, installed: Boolean(plan), running: Boolean(native.running), ready: Boolean(ready), status: !plan ? (occupied ? 'port-occupied' : 'not-installed') : native.failed ? 'failed' : native.running ? (ready ? 'running' : 'starting') : occupied ? 'port-occupied' : 'installed', ...(plan ? { version: plan.version, port: plan.port, dataDir, definitionPath, ...(platform === 'win32' ? { taskName } : {}) } : {}) };
  }
  const isReady = (value, plan) => value && value.service === 'resource-history-bridge' && value.version === plan.version && value.status === 'ready';
  async function status() {
    const plan = installedPlan(), native = await inspect(plan);
    const ready = plan && native.exists && native.owned && native.running && isReady(await health(plan.port), plan);
    const occupied = ready ? false : await portOccupied(plan ? plan.port : 8790);
    return metadata(plan, native, ready, occupied);
  }
  async function waitFor(plan, running) {
    const attempts = Math.max(1, Math.ceil(timeoutMs / Math.max(1, intervalMs))), deadline = now() + timeoutMs;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (now() >= deadline && attempt > 0) break;
      installedPlan();
      const native = await inspect(plan);
      if (!running && !native.running) return metadata(plan, native, false, await portOccupied(plan.port));
      if (running && native.failed) refuse('START_FAILED', 'The owned service exited before readiness. Inspect native service metadata; no other process was stopped.');
      if (running && native.running && isReady(await health(plan.port), plan)) return metadata(plan, native, true, false);
      if (attempt + 1 < attempts && now() < deadline) await delay(Math.min(intervalMs, deadline - now()));
    }
    refuse(running ? 'READINESS_TIMEOUT' : 'STOP_TIMEOUT', running ? 'The owned service did not become ready within the startup deadline.' : 'The owned service did not stop within the shutdown deadline.');
  }
  function makeDirectory(directory, created) {
    checkPath(directory);
    if (exists(directory)) { if (!exists(directory).isDirectory()) fail(); return; }
    makeDirectory(p.dirname(directory), created);
    io.mkdirSync(directory, { mode: 0o700 });
    created.push(directory);
  }
  function writeNew(file, contents, createdFiles, createdDirs) {
    makeDirectory(p.dirname(file), createdDirs);
    if (exists(file)) fail();
    const temporary = `${file}.tmp-${process.pid}-${sequence++}`;
    try {
      io.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
      const fd = io.openSync(temporary, 'r+');
      try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
      io.linkSync(temporary, file);
      createdFiles.push([file, hash(contents)]);
    } finally { if (exists(temporary)) io.unlinkSync(temporary); }
  }
  function removeFiles(files, directories) {
    for (const [file, expected] of files.slice().reverse()) {
      if (exists(file)) { if (hash(readRegular(file)) !== expected) fail('A file changed during removal; remaining owned files have been preserved.'); io.unlinkSync(file); }
    }
    for (const directory of directories.slice().reverse()) { try { io.rmdirSync(directory); } catch (error) { if (!['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(error.code)) throw error; } }
  }
  async function install(input = {}, settings = {}) {
    const proposed = planInstall(input);
    if (settings.dryRun) return publicPlan(proposed, 'install');
    const current = installedPlan();
    if (current) {
      await inspect(current);
      if (current.releaseId !== proposed.releaseId || json(current.environment) !== json(proposed.environment) || current.nodePath !== proposed.nodePath) refuse('ALREADY_INSTALLED', 'A different owned installation exists. Use verified uninstall first; automatic replacement is not supported.');
      return start();
    }
    await inspect(null);
    if (await portOccupied(proposed.port)) refuse('PORT_OCCUPIED', 'The requested loopback port is already occupied. Change RHB_PORT; no endpoint or process was taken over.');
    const userId = platform === 'win32' ? await backend.userId() : undefined;
    const plan = platform === 'win32' ? planInstall(input, userId) : proposed;
    const createdFiles = [], createdDirs = [];
    let nativeAttempted = false;
    try {
      makeDirectory(dataDir, createdDirs);
      if (backend.secureDirectory) await backend.secureDirectory(plan);
      for (const directory of plan.directories) makeDirectory(directory, createdDirs);
      for (const [file, contents] of Object.entries(plan.buffers)) {
        if (file === ownerPath && exists(file) && readRegular(file).equals(ownerContents)) continue;
        writeNew(file, contents, createdFiles, createdDirs);
      }
      installedPlan();
      nativeAttempted = true;
      await backend.perform('install', plan);
      return await waitFor(plan, true);
    } catch (error) {
      if (nativeAttempted) {
        try {
          installedPlan();
          let native = await inspect(plan);
          if (native.running || (platform === 'darwin' && native.exists)) { await backend.perform('stop', plan); await waitFor(plan, false); native = await inspect(plan); }
          if (native.exists) await backend.perform('uninstall', plan);
          const remaining = await inspect(plan);
          if (remaining.running || (platform === 'win32' && remaining.exists)) refuse('ROLLBACK_PRESERVED', 'Native rollback was not confirmed.');
        } catch { refuse('ROLLBACK_PRESERVED', 'Installation failed and safe native rollback could not be verified. Owned files have been preserved; no foreign service was removed.'); }
      }
      removeFiles(createdFiles, createdDirs);
      if (platform === 'linux' && nativeAttempted) { try { await run({ file: '/usr/bin/systemctl', args: ['--user', 'daemon-reload'] }); } catch { /* Removed files remain removed even if the user manager is unavailable. */ } }
      if (error instanceof ServiceError) throw error;
      refuse('INSTALL_FAILED', 'Service installation failed; newly created files were rolled back.');
    }
  }
  async function start(settings = {}) {
    const plan = installedPlan();
    if (!plan) refuse('NOT_INSTALLED', 'Install the user service first.');
    if (settings.dryRun) return publicPlan(plan, 'start');
    const native = await inspect(plan);
    if (native.running) return waitFor(plan, true);
    if (await portOccupied(plan.port)) refuse('PORT_OCCUPIED', 'The loopback port is occupied by an unverified process; nothing was stopped.');
    if ((platform === 'linux' || platform === 'win32') && !native.exists) refuse('NATIVE_MISSING', 'The owned native definition is not registered. Use verified uninstall and install.');
    await backend.perform('start', plan);
    return waitFor(plan, true);
  }
  async function stop(settings = {}) {
    const plan = installedPlan();
    if (!plan) refuse('NOT_INSTALLED', 'The user service is not installed.');
    if (settings.dryRun) return publicPlan(plan, 'stop');
    const native = await inspect(plan);
    if (native.exists && (native.running || platform === 'darwin')) { await backend.perform('stop', plan); return waitFor(plan, false); }
    return metadata(plan, native, false, await portOccupied(plan.port));
  }
  async function uninstall(settings = {}) {
    const plan = installedPlan();
    if (!plan) { await inspect(null); return { service: SERVICE_ID, installed: false, running: false, status: 'not-installed' }; }
    if (settings.dryRun) return publicPlan(plan, 'uninstall');
    let native = await inspect(plan);
    if (native.running || (platform === 'darwin' && native.exists)) { await backend.perform('stop', plan); await waitFor(plan, false); native = await inspect(plan); }
    installedPlan();
    if (native.exists) await backend.perform('uninstall', plan);
    const after = await inspect(plan);
    if (platform === 'win32' && after.exists) refuse('UNINSTALL_FAILED', 'The native Scheduled Task was not removed; owned files have been preserved.');
    const files = Object.entries(plan.manifest.releaseHashes).map(([name, expected]) => [p.join(plan.releaseDir, ...name.split('/')), expected]);
    files.push([manifestPath, hash(readRegular(manifestPath))], [plan.bootstrapPath, plan.manifest.bootstrapHash], [definitionPath, plan.manifest.definitionHash]);
    const dirs = new Set([dataDir, p.join(dataDir, 'releases'), plan.releaseDir, plan.workingDir, p.join(dataDir, 'logs')]);
    for (const [file] of files) { let parent = p.dirname(file); while (parent.startsWith(`${dataDir}${p.sep}`)) { dirs.add(parent); parent = p.dirname(parent); } }
    removeFiles(files, [...dirs].sort((a, b) => a.length - b.length));
    if (platform === 'linux') await run({ file: '/usr/bin/systemctl', args: ['--user', 'daemon-reload'] });
    return { service: SERVICE_ID, platform, installed: false, running: false, status: 'not-installed', preservedDataDirectory: Boolean(exists(dataDir)) };
  }
  async function locked(operation, args) {
    if (args?.dryRun) return operation(args);
    const directories = [], lockPath = `${dataDir}.operation.lock`;
    makeDirectory(p.dirname(lockPath), directories);
    checkPath(lockPath);
    const contents = Buffer.from(json({ service: SERVICE_ID, token: crypto.randomBytes(16).toString('hex') }));
    let reserved = false;
    try {
      try { io.writeFileSync(lockPath, contents, { flag: 'wx', mode: 0o600 }); reserved = true; }
      catch (error) { if (error.code === 'EEXIST') refuse('BUSY', 'Another service operation or an unverified lock exists; it has been preserved.'); throw error; }
      return await operation(args);
    } finally {
      if (reserved && exists(lockPath) && readRegular(lockPath).equals(contents)) io.unlinkSync(lockPath);
      for (const directory of directories.reverse()) { try { io.rmdirSync(directory); } catch (error) { if (!['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(error.code)) throw error; } }
    }
  }
  return {
    install: (input = {}, settings = {}) => settings.dryRun ? install(input, settings) : locked(() => install(input, settings)),
    status,
    start: settings => locked(start, settings),
    stop: settings => locked(stop, settings),
    uninstall: settings => locked(uninstall, settings),
    planInstall: (input = {}) => publicPlan(planInstall(input), 'install'),
    plan: async (action, input = {}) => action === 'install' ? publicPlan(planInstall(input), action) : action === 'status' ? { service: SERVICE_ID, platform, action, dryRun: true, commands: nativeCommands({}, action), files: [] } : publicPlan(installedPlan() || planInstall(input), action)
  };
}

module.exports = { SERVICE_ID, ENV_NAMES, ServiceError, createServiceManager, installEnvironment, environmentFromProcess, xml, psString, windowsArgument, unitString, unitArgument, windowsRuntimeCommand };
