'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  createCodexAppServerClient,
  createCodexSnapshotReader,
  createCodexAutoContinue,
  codexFailedFingerprint,
  METHODS
} = require('../lib/codex-app-server');
const { turnFingerprint } = require('../lib/turn-continuation');

const THREAD = 'thread_synthetic_0001';
const SENTINEL = 'SYNTHETIC_SECRET_FROM_PROMPT';

// ---------------------------------------------------------------------------
// A mock app-server written as a real stdio process. Used only to exercise the
// JSON-RPC transport: framing, ids, errors, server requests, exit.
// ---------------------------------------------------------------------------

const MOCK_SERVER = String.raw`
'use strict';
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
let approvalRequests = 0;
rl.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') {
    out({ id: message.id, result: { userAgent: 'mock-app-server/1.2.3', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' } });
    return;
  }
  if (message.method === 'initialized') {
    // A notification first, then a server-initiated request that must be
    // answered or the turn would hang.
    out({ method: 'thread/started', params: { thread: { id: 'redacted' } }, emittedAtMs: 1 });
    approvalRequests += 1;
    out({ id: 'srv-' + approvalRequests, method: 'item/commandExecution/requestApproval', params: { threadId: 'redacted' } });
    return;
  }
  if (message.method === undefined) {
    // An answer to one of our own requests.
    out({ method: 'observed', params: message });
    return;
  }
  switch (message.method) {
    case 'echo':
      out({ id: message.id, result: { params: message.params } });
      return;
    case 'fail':
      out({ id: message.id, error: { code: -32600, message: 'rejected by mock' } });
      return;
    case 'slow':
      return;
    case 'exiting':
      process.exit(3);
      return;
    case 'split': {
      const line = JSON.stringify({ id: message.id, result: { ok: true } }) + '\n';
      process.stdout.write(line.slice(0, 9));
      setTimeout(() => process.stdout.write(line.slice(9)), 20);
      return;
    }
    case 'batched':
      process.stdout.write(JSON.stringify({ id: message.id, result: { first: true } }) + '\r\n');
      process.stdout.write(JSON.stringify({ method: 'mock/batched', params: { n: 1 } }) + '\n');
      return;
    case 'garbage':
      process.stdout.write('this is not json\n');
      out({ id: message.id, result: { survived: true } });
      return;
    default:
      out({ id: message.id, error: { code: -32600, message: 'unknown variant' } });
  }
});
`;

function mockServerPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhb-codex-mock-'));
  const file = path.join(dir, 'mock-app-server.js');
  fs.writeFileSync(file, MOCK_SERVER);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

function mockClient(t, options = {}) {
  const file = mockServerPath(t);
  const client = createCodexAppServerClient({ command: process.execPath, args: [file], ...options });
  t.after(() => client.close());
  return client;
}

function waitUntil(predicate, timeoutMs = 4000, label = 'condition') {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try { value = predicate(); } catch { value = false; }
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

test('client performs the documented initialize handshake and completes it with "initialized"', { timeout: 20000 }, async t => {
  const client = mockClient(t);
  const notifications = [];
  client.subscribe(event => notifications.push(event));
  const info = await client.initialize();
  assert.match(info.userAgent, /mock-app-server/);
  assert.equal(client.running, true);
  // The handshake notification is what makes the server start emitting, so the
  // server-side notification and approval request prove it was sent.
  await waitUntil(() => notifications.some(e => e.type === 'notification' && e.method === 'thread/started'), 4000, 'thread/started');
});

test('client correlates replies by id, including string ids, and keeps framing across chunk boundaries', { timeout: 20000 }, async t => {
  const client = mockClient(t);
  const info = await client.initialize();
  assert.ok(info);
  const echoed = await client.call('echo', { nested: { list: [1, 2, 3] } });
  assert.deepEqual(echoed, { params: { nested: { list: [1, 2, 3] } } });
  const split = await client.call('split', {});
  assert.deepEqual(split, { ok: true });
});

test('a JSON-RPC error reply is marked rpc:true with the server code, and never carries server text as an error code', { timeout: 20000 }, async t => {
  const client = mockClient(t);
  await client.initialize();
  await assert.rejects(client.call('fail', {}), error => {
    assert.equal(error.code, 'CODEX_APP_SERVER_RPC_ERROR');
    assert.equal(error.rpc, true);
    assert.equal(error.method, 'fail');
    assert.equal(error.rpcCode, -32600);
    assert.equal(error.rpcMessage, 'rejected by mock');
    return true;
  });
  // The connection survives a rejected request.
  const echoed = await client.call('echo', { after: 'error' });
  assert.deepEqual(echoed, { params: { after: 'error' } });
});

test('server-initiated requests are refused by default so an approval can never be granted silently', { timeout: 20000 }, async t => {
  const seen = [];
  const file = mockServerPath(t);
  const client = createCodexAppServerClient({ command: process.execPath, args: [file] });
  t.after(() => client.close());
  client.subscribe(event => seen.push(event));
  await client.initialize();
  const observed = await waitUntil(
    () => seen.find(e => e.type === 'notification' && e.method === 'observed' && String(e.params.id).startsWith('srv-')),
    4000,
    'refusal to reach the server'
  );
  assert.equal(observed.params.error.code, -32601);
  // Only method names reach observers: params may hold command lines or paths.
  const request = seen.find(e => e.type === 'server-request');
  assert.equal(request.method, 'item/commandExecution/requestApproval');
  assert.equal(request.params, undefined);
});

test('a call that is never answered times out with a distinct code instead of hanging', { timeout: 20000 }, async t => {
  const client = mockClient(t, { callTimeoutMs: 150 });
  await client.initialize();
  await assert.rejects(client.call('slow', {}), error => {
    assert.equal(error.code, 'CODEX_APP_SERVER_TIMEOUT');
    assert.equal(error.method, 'slow');
    return true;
  });
  const echoed = await client.call('echo', { after: 'timeout' });
  assert.deepEqual(echoed, { params: { after: 'timeout' } });
});

test('an abort signal rejects the call and leaves the client usable', { timeout: 20000 }, async t => {
  const client = mockClient(t);
  await client.initialize();
  const controller = new AbortController();
  const promise = client.call('slow', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, error => error.code === 'CODEX_APP_SERVER_ABORTED');
  const echoed = await client.call('echo', { after: 'abort' });
  assert.deepEqual(echoed, { params: { after: 'abort' } });
});

test('a server that exits rejects every pending call with the exit status', { timeout: 20000 }, async t => {
  const client = mockClient(t);
  await client.initialize();
  await assert.rejects(client.call('exiting', {}), error => {
    assert.equal(error.code, 'CODEX_APP_SERVER_EXITED');
    assert.equal(error.exit.code, 3);
    return true;
  });
  assert.equal(client.closed, true);
  await assert.rejects(client.call('echo', {}), error => error.code === 'CODEX_APP_SERVER_CLOSED');
});

test('a missing executable fails with a spawn code, and an already-closed client refuses calls', { timeout: 20000 }, async t => {
  const missing = createCodexAppServerClient({ command: 'rhb-definitely-not-installed-xyz' });
  await assert.rejects(missing.initialize(), error => error.code === 'CODEX_APP_SERVER_SPAWN_FAILED');
  await missing.close();

  const client = mockClient(t);
  await client.initialize();
  await client.close();
  assert.equal(client.closed, true);
  await assert.rejects(client.call('initialize', {}), error => error.code === 'CODEX_APP_SERVER_CLOSED');
  client.call('echo', {}).catch(() => {});
  await assert.rejects(client.call('echo', {}), error => error.code === 'CODEX_APP_SERVER_CLOSED');
});

test('unreadable output from the server does not take the transport down', { timeout: 20000 }, async t => {
  const client = mockClient(t);
  await client.initialize();
  const result = await client.call('garbage', {});
  assert.deepEqual(result, { survived: true });
  const notifications = [];
  const dispose = client.subscribe(event => notifications.push(event));
  await client.call('batched', {});
  await waitUntil(() => notifications.some(e => e.method === 'mock/batched'), 4000, 'batched notification');
  dispose();
  assert.equal(notifications.some(e => e.method === 'mock/batched'), true);
});

// ---------------------------------------------------------------------------
// Snapshot reader: only what the server reports
// ---------------------------------------------------------------------------

// An in-memory app-server that answers the three methods the reader and the
// adapter use. It models persisted turn state, not a script of replies, so a
// snapshot is read from something that can actually disagree with the caller.
function createFakeCodex(options = {}) {
  const state = {
    threadId: options.threadId ?? THREAD,
    status: options.status ?? 'idle',
    turns: (options.turns ?? []).map(turn => ({ itemsView: 'full', items: [], error: null, ...turn })),
    nextTurn: 1,
    calls: [],
    listeners: new Set(),
    turnStart: options.turnStart ?? (() => 'start')
  };
  const emit = event => { for (const listener of [...state.listeners]) listener(event); };
  const notify = (method, params) => emit({ type: 'notification', method, params });

  const client = {
    calls: state.calls,
    notify,
    get turns() { return state.turns; },
    subscribe(handler) {
      state.listeners.add(handler);
      return () => state.listeners.delete(handler);
    },
    count(method) { return state.calls.filter(entry => entry.method === method).length; },
    async call(method, params = {}, context = {}) {
      state.calls.push({ method, params, context });
      if (method === METHODS.threadResume) {
        return {
          thread: { id: state.threadId, status: { type: state.status }, turns: [] }
        };
      }
      if (method === METHODS.threadTurnsList) {
        const ordered = [...state.turns].reverse();
        const limit = Number.isSafeInteger(params.limit) ? params.limit : ordered.length;
        const full = params.itemsView === 'full';
        return {
          data: ordered.slice(0, limit).map(turn => {
            // The server decides how much of a turn it returns; a turn pinned to
            // "summary" stays a summary whatever the caller asks for.
            const view = full && turn.itemsView === 'full' ? 'full' : 'summary';
            return {
              id: turn.id,
              status: turn.status,
              items: view === 'full' ? turn.items : [],
              itemsView: view,
              error: turn.error
            };
          })
        };
      }
      if (method === METHODS.turnStart) {
        const behavior = state.turnStart(state.calls.filter(entry => entry.method === METHODS.turnStart).length);
        if (behavior === 'rpc-error') {
          const error = new Error('rejected');
          error.rpc = true;
          error.code = 'FAKE_RPC_ERROR';
          throw error;
        }
        if (behavior === 'transport-error') {
          const error = new Error('socket gone');
          error.code = 'FAKE_TRANSPORT';
          throw error;
        }
        const id = `turn_new_${state.nextTurn++}`;
        state.turns.push({ id, status: 'inProgress', items: [], itemsView: 'full', error: null });
        state.status = 'active';
        notify('turn/started', { threadId: state.threadId, turn: { id, status: 'inProgress', items: [] } });
        if (behavior === 'transport-error-after-create') {
          const error = new Error('socket gone after the turn was accepted');
          error.code = 'FAKE_TRANSPORT';
          throw error;
        }
        if (behavior === 'ack-terminal') {
          state.turns[state.turns.length - 1].status = 'completed';
          state.status = 'idle';
          return { turn: { id, status: 'completed', items: [] } };
        }
        return { turn: { id, status: 'inProgress', items: [] } };
      }
      throw new Error(`unexpected method ${method}`);
    },
    complete(turnId, status, errorCode = null) {
      const turn = state.turns.find(candidate => candidate.id === turnId);
      if (!turn) throw new Error(`no such turn ${turnId}`);
      turn.status = status;
      turn.error = errorCode === null ? null : { message: SENTINEL, codexErrorInfo: errorCode, additionalDetails: null };
      state.status = 'idle';
      notify('turn/completed', { threadId: state.threadId, turn });
    },
    failWithRetry(turnId, errorCode = 'serverOverloaded') {
      const turn = state.turns.find(candidate => candidate.id === turnId);
      notify('error', {
        threadId: state.threadId,
        turnId,
        willRetry: true,
        error: { message: SENTINEL, codexErrorInfo: errorCode, additionalDetails: null }
      });
      return turn;
    }
  };
  return client;
}

const failedTurn = (id, errorCode = 'serverOverloaded', extra = {}) => ({
  id, status: 'failed', items: [], itemsView: 'full',
  error: { message: SENTINEL, codexErrorInfo: errorCode, additionalDetails: null },
  ...extra
});

async function expectSnapshot(t, client, turnId, errorCode, expected) {
  const reader = createCodexSnapshotReader({ client });
  const snapshot = await reader.read({
    threadId: THREAD,
    failedTurnId: turnId,
    failedFingerprint: codexFailedFingerprint(THREAD, turnId, { codexErrorInfo: errorCode })
  });
  if (expected.refused) {
    assert.equal(snapshot.ok, false);
    assert.equal(snapshot.snapshotRefused, expected.refused);
  } else {
    assert.equal(snapshot.ok, true, JSON.stringify(snapshot));
    for (const [key, value] of Object.entries(expected.fields)) assert.equal(snapshot[key], value, key);
    assert.equal(snapshot.failedFingerprint, codexFailedFingerprint(THREAD, turnId, { codexErrorInfo: errorCode }));
  }
  return snapshot;
}

test('snapshot attests an idle thread whose newest turn is the failed one, with all tool items settled', { timeout: 20000 }, async t => {
  const client = createFakeCodex({
    turns: [{
      id: 'turn_1', status: 'failed',
      items: [
        { type: 'userMessage', content: [] },
        { type: 'commandExecution', status: 'completed' },
        { type: 'mcpToolCall', status: 'failed' },
        { type: 'reasoning', summary: [] }
      ],
      error: { message: SENTINEL, codexErrorInfo: 'serverOverloaded', additionalDetails: null }
    }]
  });
  const snapshot = await expectSnapshot(t, client, 'turn_1', 'serverOverloaded', {
    fields: {
      durableCommitted: true,
      turnActive: false,
      pendingApproval: false,
      pendingTools: false,
      startedToolCallsSettled: true,
      ambiguousSideEffects: false,
      nativeRetryPending: false
    }
  });
  // The server was asked to resume first: a thread that is not loaded cannot be
  // read, so resuming is what makes thread.status authoritative.
  assert.equal(client.calls[0].method, METHODS.threadResume);
  assert.equal(client.calls[1].method, METHODS.threadTurnsList);
  assert.equal(client.calls[1].params.itemsView, 'full');
  assert.match(snapshot.snapshotId, /^[0-9a-f]{32}$/);
});

test('snapshot refuses an active turn, an unsettled tool call, unloaded items and a superseded turn', { timeout: 20000 }, async t => {
  const active = createFakeCodex({
    status: 'active',
    turns: [{ id: 'turn_1', status: 'inProgress', items: [] }]
  });
  await expectSnapshot(t, active, 'turn_1', 'serverOverloaded', { refused: 'turn_active' });

  const unsettled = createFakeCodex({
    turns: [{ id: 'turn_1', status: 'failed', items: [{ type: 'commandExecution', status: 'inProgress' }],
      error: { message: SENTINEL, codexErrorInfo: 'serverOverloaded' } }]
  });
  const unsettledSnapshot = await expectSnapshot(t, unsettled, 'turn_1', 'serverOverloaded', {
    fields: { pendingTools: true, startedToolCallsSettled: false, ambiguousSideEffects: true }
  });
  assert.equal(unsettledSnapshot.ok, true);

  const notLoaded = createFakeCodex({
    turns: [{ id: 'turn_1', status: 'failed', items: [], itemsView: 'summary' }]
  });
  await expectSnapshot(t, notLoaded, 'turn_1', 'serverOverloaded', { refused: 'items_not_loaded' });

  const superseded = createFakeCodex({
    turns: [failedTurn('turn_1'), { id: 'turn_2', status: 'completed', items: [] }]
  });
  await expectSnapshot(t, superseded, 'turn_1', 'serverOverloaded', { refused: 'failed_turn_superseded' });
});

test('snapshot refuses when the server no longer reports the failure the caller names', { timeout: 20000 }, async t => {
  const client = createFakeCodex({ turns: [failedTurn('turn_1', 'serverOverloaded')] });
  const reader = createCodexSnapshotReader({ client });
  // Same turn id, different error code: the fingerprint is recomputed from the
  // server's own turn record, so a stale caller cannot authorize a send.
  const snapshot = await reader.read({
    threadId: THREAD,
    failedTurnId: 'turn_1',
    failedFingerprint: turnFingerprint({ threadId: THREAD, turnId: 'turn_1', status: 'failed', error: { code: 'rateLimitExceeded' } })
  });
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.snapshotRefused, 'snapshot_fingerprint_mismatch');
});

test('snapshot counts an unanswered approval as pending, and clears it when the server reports it resolved', { timeout: 20000 }, async t => {
  const client = createFakeCodex({ turns: [failedTurn('turn_1')] });
  const approvals = new Set(['srv-1']);
  const reader = createCodexSnapshotReader({ client, pendingApprovals: () => approvals.size });
  const pending = await reader.read({
    threadId: THREAD, failedTurnId: 'turn_1', failedFingerprint: codexFailedFingerprint(THREAD, 'turn_1', { codexErrorInfo: 'serverOverloaded' })
  });
  assert.equal(pending.pendingApproval, true);
  approvals.clear();
  const cleared = await reader.read({
    threadId: THREAD, failedTurnId: 'turn_1', failedFingerprint: codexFailedFingerprint(THREAD, 'turn_1', { codexErrorInfo: 'serverOverloaded' })
  });
  assert.equal(cleared.pendingApproval, false);
});

test('snapshot treats an unreadable thread as unattested rather than assuming it is idle', { timeout: 20000 }, async () => {
  const reader = createCodexSnapshotReader({
    client: { call: async () => { throw new Error('boom'); } }
  });
  const snapshot = await reader.read({
    threadId: THREAD, failedTurnId: 'turn_1', failedFingerprint: 'x'
  });
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.snapshotRefused, 'thread_unreadable');
});

// ---------------------------------------------------------------------------
// Automatic continuation
// ---------------------------------------------------------------------------

test('a terminal failed turn is continued on the same thread and the run reports completion', { timeout: 25000 }, async t => {
  const client = createFakeCodex({ turns: [failedTurn('turn_1')] });
  const events = [];
  const auto = createCodexAutoContinue({ client });
  const promise = auto.run({ threadId: THREAD, onProgress: event => events.push(event) });
  await waitUntil(() => client.count(METHODS.turnStart) === 1, 4000, 'turn/start');
  const started = await waitUntil(
    () => client.turns.find(turn => turn.status === 'inProgress'),
    4000,
    'the continuation turn to exist'
  );
  client.complete(started.id, 'completed');
  const result = await promise;
  assert.equal(result.status, 'completed');
  assert.equal(result.reason, 'turn_completed');
  assert.equal(result.continuations, 1);
  assert.equal(client.count(METHODS.turnStart), 1);
  // Only the two documented fields are sent, so the thread keeps its own model,
  // sandbox and tools.
  const startCall = client.calls.find(entry => entry.method === METHODS.turnStart);
  assert.deepEqual(Object.keys(startCall.params).sort(), ['input', 'threadId']);
  assert.equal(startCall.params.threadId, THREAD);
  assert.equal(startCall.params.input.length, 1);
  assert.equal(startCall.params.input[0].type, 'text');
  // The continuation text is the only thing this component writes into the
  // thread; the failed prompt is never replayed.
  assert.equal(startCall.params.input[0].text.includes(SENTINEL), false);
  assert.equal(events.some(event => event.type === 'continuation_requested'), true);
});

test('an error notification with willRetry=true never starts a turn', { timeout: 25000 }, async t => {
  const client = createFakeCodex({ turns: [{ id: 'turn_1', status: 'inProgress', items: [] }], status: 'active' });
  const auto = createCodexAutoContinue({ client, deadlineMs: 400, watch: true });
  const promise = auto.run({ threadId: THREAD });
  await delay(50);
  client.failWithRetry('turn_1');
  const result = await promise;
  assert.equal(client.count(METHODS.turnStart), 0);
  assert.notEqual(result.status, 'completed');
  assert.equal(result.reason, 'deadline_expired');
});

test('a retry flag left on the failed turn stops the run instead of continuing it', { timeout: 25000 }, async t => {
  // The native loop said it would retry and this client never saw a new attempt
  // start, so the turn is not this component's to continue.
  const client = createFakeCodex({ turns: [failedTurn('turn_1')] });
  const auto = createCodexAutoContinue({ client, deadlineMs: 2000 });
  const promise = auto.run({ threadId: THREAD });
  await waitUntil(() => client.count(METHODS.threadTurnsList) >= 1, 4000, 'first state read');
  client.failWithRetry('turn_1');
  const result = await promise;
  assert.equal(result.reason, 'native_retry_pending');
  assert.equal(client.count(METHODS.turnStart), 0);
});

test('a turn that is still in progress is not a failure and never triggers a continuation', { timeout: 25000 }, async t => {
  const client = createFakeCodex({ status: 'active', turns: [{ id: 'turn_1', status: 'inProgress', items: [] }] });
  const auto = createCodexAutoContinue({ client, deadlineMs: 300 });
  const result = await auto.run({ threadId: THREAD });
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'deadline_expired');
  assert.equal(client.count(METHODS.turnStart), 0);
});

test('a completed newest turn is left alone: nothing is idle-continued', { timeout: 20000 }, async t => {
  const client = createFakeCodex({ turns: [{ id: 'turn_1', status: 'completed', items: [] }] });
  const auto = createCodexAutoContinue({ client, deadlineMs: 1000 });
  const result = await auto.run({ threadId: THREAD });
  assert.equal(result.status, 'idle');
  assert.equal(result.reason, 'no_failed_turn');
  assert.equal(client.count(METHODS.turnStart), 0);
});

test('an unattested snapshot stops the run with the specific reason and no turn/start', { timeout: 20000 }, async t => {
  const cases = [
    { turns: [failedTurn('turn_1', 'serverOverloaded', { items: [{ type: 'fileChange', status: 'inProgress' }] })], reason: 'pending_tools' },
    { turns: [failedTurn('turn_1', 'serverOverloaded', { itemsView: 'summary' })], reason: 'snapshot_unattested' }
  ];
  for (const item of cases) {
    const client = createFakeCodex({ turns: item.turns });
    if (item.reason === 'snapshot_unattested') {
      // The reader names its own refusal; the continuation core sees an
      // unattested snapshot. Both are recorded on the result.
      const auto = createCodexAutoContinue({ client, deadlineMs: 2000 });
      const result = await auto.run({ threadId: THREAD });
      assert.equal(result.reason, 'snapshot_unattested');
      assert.equal(result.lastRefusal, 'items_not_loaded');
    } else {
      const auto = createCodexAutoContinue({ client, deadlineMs: 2000 });
      const result = await auto.run({ threadId: THREAD });
      assert.equal(result.reason, item.reason);
    }
    assert.equal(client.count(METHODS.turnStart), 0);
  }
});

test('a non-transient failure is refused before any resume or turn/start', { timeout: 20000 }, async t => {
  const client = createFakeCodex({ turns: [failedTurn('turn_1', 'contextWindowExceeded')] });
  const auto = createCodexAutoContinue({ client, deadlineMs: 2000 });
  const result = await auto.run({ threadId: THREAD });
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'context_exhausted');
  assert.equal(client.count(METHODS.turnStart), 0);
  assert.equal(client.count(METHODS.threadResume), 0);
});

test('a lost acknowledgement is reconciled with the real thread state and re-sent only after "not started"', { timeout: 25000 }, async t => {
  let attempt = 0;
  const client = createFakeCodex({
    turns: [failedTurn('turn_1')],
    turnStart: () => {
      attempt += 1;
      return attempt === 1 ? 'transport-error' : 'start';
    }
  });
  const auto = createCodexAutoContinue({ client, startTimeoutMs: 500, deadlineMs: 20000 });
  const promise = auto.run({ threadId: THREAD });
  await waitUntil(() => client.count(METHODS.turnStart) === 2, 6000, 'the re-sent turn/start');
  // The reconcile proof came from the server, not from a retry counter.
  assert.ok(client.count(METHODS.threadResume) >= 3);
  const started = await waitUntil(() => client.turns.find(turn => turn.status === 'inProgress'), 4000, 'the continuation turn');
  client.complete(started.id, 'completed');
  const result = await promise;
  assert.equal(result.status, 'completed');
  assert.equal(client.count(METHODS.turnStart), 2);
});

test('a lost acknowledgement is not re-sent when the server shows the turn did start', { timeout: 25000 }, async t => {
  let attempt = 0;
  const client = createFakeCodex({
    turns: [failedTurn('turn_1')],
    turnStart: () => {
      attempt += 1;
      return attempt === 1 ? 'transport-error-after-create' : 'start';
    }
  });
  const auto = createCodexAutoContinue({ client, startTimeoutMs: 500, deadlineMs: 20000 });
  const promise = auto.run({ threadId: THREAD });
  await waitUntil(() => client.count(METHODS.turnStart) === 1, 4000, 'the first turn/start');
  // Give the reconcile path time to run and decide.
  await delay(150);
  assert.equal(client.count(METHODS.turnStart), 1);
  const started = await waitUntil(() => client.turns.find(turn => turn.status === 'inProgress'), 4000, 'the created turn');
  client.complete(started.id, 'completed');
  const result = await promise;
  assert.equal(result.status, 'completed');
  assert.equal(client.count(METHODS.turnStart), 1);
});

test('the continuation budget is shared and stops the run at its limit', { timeout: 25000 }, async t => {
  const client = createFakeCodex({ turns: [failedTurn('turn_1')] });
  const auto = createCodexAutoContinue({ client, maxContinuations: 1, deadlineMs: 20000, baseDelayMs: 0, maxDelayMs: 0 });
  const promise = auto.run({ threadId: THREAD });
  await waitUntil(() => client.count(METHODS.turnStart) === 1, 4000, 'turn/start');
  const started = await waitUntil(() => client.turns.find(turn => turn.status === 'inProgress'), 4000, 'the continuation turn');
  client.complete(started.id, 'failed', 'serverOverloaded');
  const result = await promise;
  assert.equal(result.status, 'exhausted');
  assert.equal(result.reason, 'continuation_budget_exhausted');
  assert.equal(result.continuations, 1);
  assert.equal(client.count(METHODS.turnStart), 1);
});

test('repeat failures up to the budget are each continued once, then the run is exhausted', { timeout: 30000 }, async t => {
  const client = createFakeCodex({ turns: [failedTurn('turn_1')] });
  const auto = createCodexAutoContinue({ client, maxContinuations: 2, deadlineMs: 25000, baseDelayMs: 0, maxDelayMs: 0 });
  const promise = auto.run({ threadId: THREAD });
  for (let index = 0; index < 2; index += 1) {
    await waitUntil(() => client.count(METHODS.turnStart) === index + 1, 6000, `turn/start ${index + 1}`);
    const started = await waitUntil(() => client.turns.find(turn => turn.status === 'inProgress'), 4000, 'the continuation turn');
    client.complete(started.id, 'failed', 'serverOverloaded');
  }
  const result = await promise;
  assert.equal(result.status, 'exhausted');
  assert.equal(result.continuations, 2);
  assert.equal(client.count(METHODS.turnStart), 2);
  // A continuation never re-uses the same failed turn twice.
  const started = client.calls.filter(entry => entry.method === METHODS.turnStart);
  assert.equal(new Set(started.map(entry => entry.params.threadId)).size, 1);
});

test('cancellation stops the run and never starts another turn', { timeout: 20000 }, async t => {
  const client = createFakeCodex({ turns: [failedTurn('turn_1')] });
  const controller = new AbortController();
  const auto = createCodexAutoContinue({ client, deadlineMs: 20000 });
  const promise = auto.run({ threadId: THREAD, signal: controller.signal });
  await waitUntil(() => client.count(METHODS.turnStart) === 1, 4000, 'turn/start');
  controller.abort();
  const result = await promise;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'aborted');
  assert.equal(client.count(METHODS.turnStart), 1);
});

test('an acknowledgement that already carries a completed turn finishes without waiting for a notification', { timeout: 20000 }, async t => {
  const client = createFakeCodex({ turns: [failedTurn('turn_1')], turnStart: () => 'ack-terminal' });
  const auto = createCodexAutoContinue({ client, deadlineMs: 10000 });
  const result = await auto.run({ threadId: THREAD });
  assert.equal(result.status, 'completed');
  assert.equal(result.continuations, 1);
});

test('a completion that lands during the state read is not waited for again', { timeout: 20000 }, async t => {
  // Deterministic version of the race: `thread/turns/list` answers with a stale
  // "inProgress" while the terminal notification is already on its way.
  const client = createFakeCodex({ status: 'active', turns: [{ id: 'turn_1', status: 'inProgress', items: [] }] });
  const originalCall = client.call;
  let raced = false;
  client.call = async (method, params, context) => {
    const answered = await originalCall(method, params, context);
    if (method === METHODS.threadTurnsList && !raced && params.itemsView === 'notLoaded') {
      raced = true;
      // Delivered before the watcher registers its waiter.
      client.complete('turn_1', 'failed', 'serverOverloaded');
    }
    return answered;
  };
  const auto = createCodexAutoContinue({ client, deadlineMs: 15000 });
  const promise = auto.run({ threadId: THREAD });
  await waitUntil(() => client.count(METHODS.turnStart) === 1, 5000, 'the continuation turn to be started from the delivered completion');
  const started = await waitUntil(() => client.turns.find(turn => turn.status === 'inProgress'), 4000, 'the continuation turn');
  client.complete(started.id, 'completed');
  const result = await promise;
  assert.equal(raced, true);
  assert.equal(result.status, 'completed');
});

test('the auto-continue instance is single-use and refuses a second run', { timeout: 20000 }, async t => {
  const client = createFakeCodex({ turns: [{ id: 'turn_1', status: 'completed', items: [] }] });
  const auto = createCodexAutoContinue({ client, deadlineMs: 500 });
  assert.equal((await auto.run({ threadId: THREAD })).status, 'idle');
  await assert.rejects(auto.run({ threadId: THREAD }), error => error.code === 'TURN_CONTINUATION_CLOSED');
});

// ---------------------------------------------------------------------------
// Real protocol smoke test: handshake only, no model call, no user data
// ---------------------------------------------------------------------------

test('real codex app-server accepts the handshake and enforces the documented method surface', async t => {
  const probe = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 20000 });
  if (probe.error || probe.status !== 0) {
    // Explicit skip, never a silent pass.
    console.log(`SKIPPED real app-server smoke: codex is not installed (${probe.error?.code ?? `exit ${probe.status}`})`);
    t.skip('codex CLI not installed');
    return;
  }
  const version = (probe.stdout ?? '').trim();
  const client = createCodexAppServerClient();
  t.after(() => client.close());
  const info = await client.initialize();
  assert.equal(info.platformFamily !== undefined || info.userAgent !== undefined, true);
  console.log(`REAL SMOKE: ${version}; initialize returned keys ${Object.keys(info).join(',')}`);
  // A method the server does not implement is refused, and the refusal is tied
  // back to this client's request id. This proves request/response correlation
  // against the real binary without touching a thread.
  await assert.rejects(client.call('rhb/no/such/method', {}), error => {
    assert.equal(error.rpc, true);
    assert.equal(error.rpcCode, -32600);
    return true;
  });
  // A well-formed method with an unknown thread is answered with the real
  // not-loaded error, which is the same guard the snapshot reader relies on.
  const unknownThread = '00000000-0000-0000-0000-000000000000';
  await assert.rejects(client.call(METHODS.threadResume, { threadId: unknownThread, excludeTurns: true }), error => {
    assert.equal(error.rpc, true);
    assert.match(error.rpcMessage, /thread|rollout/i);
    console.log(`REAL SMOKE: thread/resume on a nil thread -> ${error.rpcCode} ${error.rpcMessage}`);
    return true;
  });
  // No turn was started, no model was called, and no local history was read:
  // this only lists which threads the server has loaded in this connection.
  const loaded = await client.call('thread/loaded/list', {});
  assert.equal(Array.isArray(loaded.data), true);
  console.log(`REAL SMOKE: thread/loaded/list -> ${loaded.data.length} loaded thread(s), no model call made`);
});
