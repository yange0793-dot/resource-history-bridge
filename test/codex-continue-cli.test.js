'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'rhb-codex-continue.js');
const THREAD = '0192f0aa-1111-7000-8000-000000000001';
const SENTINEL = 'SYNTHETIC_PROMPT_AND_TOOL_OUTPUT';

// A stand-in app server that speaks the real line-delimited JSON-RPC the CLI
// uses. It keeps persisted turn state so the CLI's snapshot reads and its
// reconcile queries are answered from state rather than from a script of
// replies. MOCK_CODEX_MODE selects the scenario.
const MOCK = String.raw`
'use strict';
const readline = require('node:readline');
const mode = process.env.MOCK_CODEX_MODE || 'complete';
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
let nextTurn = 2;
const turns = [{ id: 'turn_1', status: 'failed', items: [], itemsView: 'full',
  error: { message: process.env.MOCK_SENTINEL || 'x', codexErrorInfo: process.env.MOCK_INITIAL_CODE || 'serverOverloaded', additionalDetails: null } }];
let threadStatus = 'idle';

function complete(turnId, status, code) {
  const turn = turns.find(item => item.id === turnId);
  turn.status = status;
  turn.error = code ? { message: process.env.MOCK_SENTINEL || 'x', codexErrorInfo: code, additionalDetails: null } : null;
  threadStatus = 'idle';
  out({ method: 'turn/completed', params: { threadId: 'THREAD_ID', turn: { id: turn.id, status: turn.status, items: [], error: turn.error } }, emittedAtMs: Date.now() });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') {
    out({ id: message.id, result: { userAgent: 'mock/1.0.0', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' } });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'thread/resume') {
    out({ id: message.id, result: { approvalPolicy: 'never', approvalsReviewer: 'user', cwd: '/tmp', model: 'mock',
      modelProvider: 'mock', sandbox: {}, thread: { id: message.params.threadId, status: { type: threadStatus }, turns: [] } } });
    return;
  }
  if (message.method === 'thread/turns/list') {
    const ordered = [...turns].reverse();
    const limit = Number.isInteger(message.params.limit) ? message.params.limit : ordered.length;
    const full = message.params.itemsView === 'full';
    out({ id: message.id, result: { data: ordered.slice(0, limit).map(turn => ({
      id: turn.id, status: turn.status,
      items: full ? turn.items : [], itemsView: full ? 'full' : 'notLoaded', error: turn.error
    })) } });
    return;
  }
  if (message.method === 'turn/start') {
    if (mode === 'hang') return; // never acknowledges
    const id = 'turn_' + nextTurn++;
    turns.push({ id, status: 'inProgress', items: [], itemsView: 'full', error: null });
    threadStatus = 'active';
    out({ id: message.id, result: { turn: { id, status: 'inProgress', items: [] } } });
    if (mode === 'complete') {
      setTimeout(() => complete(id, 'completed', null), 30);
      return;
    }
    if (mode === 'fail-twice') {
      setTimeout(() => complete(id, 'failed', 'serverOverloaded'), 30);
      return;
    }
    if (mode === 'nonretryable') {
      setTimeout(() => complete(id, 'failed', 'contextWindowExceeded'), 30);
    }
  }
});
`.replaceAll('THREAD_ID', THREAD);

function writeMock(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhb-codex-cli-'));
  const file = path.join(dir, 'mock-codex.js');
  fs.writeFileSync(file, MOCK);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

function runCli(t, { args = [], mode = 'complete', initialCode = 'serverOverloaded', timeoutMs = 20000 } = {}) {
  const mock = writeMock(t);
  const child = spawn(process.execPath, [CLI, '--command', process.execPath, '--arg', mock, ...args], {
    env: {
      ...process.env,
      PATH: process.env.PATH,
      MOCK_CODEX_MODE: mode,
      MOCK_SENTINEL: SENTINEL,
      MOCK_INITIAL_CODE: initialCode
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const chunks = { stdout: [], stderr: [] };
  child.stdout.on('data', chunk => chunks.stdout.push(chunk));
  child.stderr.on('data', chunk => chunks.stderr.push(chunk));
  const finished = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(chunks.stdout).toString(),
        stderr: Buffer.concat(chunks.stderr).toString()
      });
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { child, finished };
}

test('the CLI continues a failed thread in the foreground and exits 0 on completion', { timeout: 30000 }, async t => {
  const { finished } = runCli(t, { args: ['--thread', THREAD] });
  const result = await finished;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /continuing turn turn_1/);
  assert.match(result.stdout, /continuation 1 completed/);
  assert.match(result.stdout, /status: completed/);
  assert.match(result.stdout, /continuations: 1/);
  // Nothing from the failed turn's message text reaches the terminal.
  assert.equal(result.stdout.includes(SENTINEL), false);
  assert.equal(result.stderr.includes(SENTINEL), false);
});

test('the CLI reports an exhausted budget with exit 1 when continuations keep failing', { timeout: 40000 }, async t => {
  const { finished } = runCli(t, { args: ['--thread', THREAD, '--max-continuations', '1'], mode: 'fail-twice' });
  const result = await finished;
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /status: exhausted/);
  assert.match(result.stdout, /continuation_budget_exhausted/);
  assert.equal(result.stdout.includes(SENTINEL), false);
});

test('the CLI stops instead of continuing a failure that cannot be continued', { timeout: 30000 }, async t => {
  // contextWindowExceeded is terminal by itself: the CLI must not even resume.
  const { finished } = runCli(t, { args: ['--thread', THREAD], mode: 'nonretryable', initialCode: 'contextWindowExceeded' });
  const result = await finished;
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /context_exhausted/);
  assert.equal(/continuing turn/.test(result.stdout), false);
});

test('the CLI exits cleanly on Ctrl+C while a turn is unacknowledged', { timeout: 30000 }, async t => {
  const { child, finished } = runCli(t, { args: ['--thread', THREAD], mode: 'hang' });
  // Give the handshake and the first state read time to happen.
  await new Promise(resolve => setTimeout(resolve, 700));
  child.kill('SIGINT');
  const result = await finished;
  assert.equal(result.code, 130, result.stderr);
  assert.match(result.stderr, /interrupted/);
});

test('the CLI prints one JSON object with --json and never a prompt or tool payload', { timeout: 30000 }, async t => {
  const { finished } = runCli(t, { args: ['--thread', THREAD, '--json'] });
  const result = await finished;
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.threadId, THREAD);
  assert.equal(parsed.continuations, 1);
  assert.ok(Array.isArray(parsed.events));
  assert.equal(JSON.stringify(parsed).includes(SENTINEL), false);
});

test('the CLI refuses invalid usage and documents itself', { timeout: 20000 }, async t => {
  const help = runCli(t, { args: ['--help'] });
  const helpResult = await help.finished;
  assert.equal(helpResult.code, 0);
  assert.match(helpResult.stdout, /Usage: rhb-codex-continue --thread/);

  const missing = runCli(t, { args: [] });
  const missingResult = await missing.finished;
  assert.equal(missingResult.code, 2);
  assert.match(missingResult.stderr, /--thread is required/);

  const unknown = runCli(t, { args: ['--thread', THREAD, '--nope'] });
  assert.equal((await unknown.finished).code, 2);

  const badBudget = runCli(t, { args: ['--thread', THREAD, '--max-continuations', '9'] });
  const badBudgetResult = await badBudget.finished;
  assert.equal(badBudgetResult.code, 2);
  assert.match(badBudgetResult.stderr, /--max-continuations must be between 1 and 3/);
});

test('the CLI reports an unavailable app server with its own exit code', { timeout: 20000 }, async t => {
  const child = spawn(process.execPath, [CLI, '--thread', THREAD, '--command', 'rhb-definitely-not-installed-xyz'], {
    env: { PATH: process.env.PATH },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const chunks = { stdout: [], stderr: [] };
  child.stdout.on('data', chunk => chunks.stdout.push(chunk));
  child.stderr.on('data', chunk => chunks.stderr.push(chunk));
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 3);
  assert.match(Buffer.concat(chunks.stderr).toString(), /app server unavailable: CODEX_APP_SERVER_SPAWN_FAILED/);
});

test('parseArgs rejects duplicate and valueless flags in one place', { timeout: 10000 }, () => {
  const { parseArgs } = require('../bin/rhb-codex-continue');
  assert.throws(() => parseArgs(['--thread', 'a', '--thread', 'b']), /--thread was given twice/);
  assert.throws(() => parseArgs(['--thread']), /--thread needs a value/);
  assert.throws(() => parseArgs(['--thread', 'a', '--deadline-ms', '0']), /--deadline-ms must be between/);
  const parsed = parseArgs(['--thread', 'a', '--watch', '--max-continuations', '2', '--arg', '--weird']);
  assert.equal(parsed.watch, true);
  assert.equal(parsed.maxContinuations, 2);
  assert.deepEqual(parsed.args, ['--weird']);
});
