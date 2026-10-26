'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { turnFingerprint } = require('../lib/turn-continuation');
const {
  createCodexTurnContinuation,
  createHarnessTurnContinuation,
  DEFAULT_CONTINUATION_TEXT
} = require('../lib/client-continuation');

const THREAD = 'thr_synthetic_mock';
const SESSION = 'session_synthetic_mock';
const sentinel = 'SYNTHETIC_HISTORY_SECRET';
let snapshots = 0;

const snapshot = (threadId, turnId, code, extra = {}) => ({
  snapshotId: `snap_${++snapshots}`,
  failedTurnId: turnId,
  failedFingerprint: turnFingerprint({ threadId, turnId, status: 'failed', error: { code } }),
  durableCommitted: true,
  turnActive: false,
  pendingApproval: false,
  pendingTools: false,
  startedToolCallsSettled: true,
  ambiguousSideEffects: false,
  nativeRetryPending: false,
  ...extra
});

// A raw Codex `Turn` as `turn/completed` carries it.
const codexTurn = (id, status, codexErrorInfo = null) => ({
  id, status, items: [], error: status === 'failed' ? { message: sentinel, codexErrorInfo, additionalDetails: null } : null
});

function codexTransport(onCall) {
  const calls = [];
  const listeners = new Set();
  const transport = {
    calls,
    rpc: {
      async call(method, params, context) {
        calls.push({ method, params, context });
        return onCall(method, params, transport);
      }
    },
    subscribe(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    emit(notification) {
      for (const listener of [...listeners]) listener(notification);
    },
    complete(turnId, status, codexErrorInfo) {
      transport.emit({ method: 'turn/completed', params: { threadId: THREAD, turn: codexTurn(turnId, status, codexErrorInfo) } });
    },
    count(method) { return calls.filter(entry => entry.method === method).length; }
  };
  return transport;
}

const codexOptions = (transport, overrides = {}) => ({
  rpc: transport.rpc,
  subscribe: transport.subscribe,
  readSnapshot: async () => snapshot(THREAD, 'turn_1', 'rateLimitExceeded'),
  ...overrides
});

test('codex: continues the same thread after a terminal failure', async () => {
  let transport;
  transport = codexTransport((method, params) => {
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/start') {
      transport.complete('turn_2', 'completed');
      return { turn: { id: 'turn_2', status: 'inProgress', items: [], error: null } };
    }
    throw new Error(`unexpected ${method}`);
  });
  const adapter = createCodexTurnContinuation(codexOptions(transport));
  const result = await adapter.run({ threadId: THREAD, failedTurn: codexTurn('turn_1', 'failed', 'rateLimitExceeded') });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.continuations, 1);
  assert.equal(result.adapter, 'codex-app-server');
  assert.equal(result.hostIntegrationRequired, true);
  assert.deepEqual(transport.calls.map(entry => entry.method), ['thread/resume', 'turn/start']);
  assert.deepEqual(transport.calls[0].params, { threadId: THREAD, excludeTurns: true });
  // Same thread, one text part, nothing else: no history, prompt, tools or
  // settings override is ever sent.
  assert.deepEqual(Object.keys(transport.calls[1].params), ['threadId', 'input']);
  assert.equal(transport.calls[1].params.threadId, THREAD);
  assert.deepEqual(transport.calls[1].params.input, [{ type: 'text', text: DEFAULT_CONTINUATION_TEXT }]);
  assert.ok(!JSON.stringify(transport.calls[1].params).includes(sentinel));
});

test('codex: refuses an error notification and a non-failed turn', async () => {
  let calls = 0;
  const transport = codexTransport(() => { calls += 1; throw new Error('must not be called'); });
  const adapter = createCodexTurnContinuation(codexOptions(transport));
  const retrying = await adapter.run({ threadId: THREAD, failedTurn: { turnId: 'turn_1', willRetry: true, error: { message: sentinel } } });
  assert.equal(retrying.reason, 'native_retry_pending');
  const notification = await adapter.run({ threadId: THREAD, failedTurn: { turnId: 'turn_1', willRetry: false, error: { message: sentinel } } });
  assert.equal(notification.reason, 'terminal_turn_required');
  const completedTurn = await adapter.run({ threadId: THREAD, failedTurn: codexTurn('turn_1', 'completed') });
  assert.equal(completedTurn.reason, 'terminal_turn_required');
  const interrupted = await adapter.run({ threadId: THREAD, failedTurn: codexTurn('turn_1', 'interrupted') });
  assert.equal(interrupted.reason, 'interrupted');
  const otherThread = await adapter.run({ threadId: THREAD,
    failedTurn: { threadId: 'thr_other', turn: codexTurn('turn_1', 'failed', 'rateLimitExceeded') } });
  assert.equal(otherThread.reason, 'thread_mismatch');
  assert.equal(calls, 0);
});

test('codex: two exhausted native attempts are continued twice, then complete', async () => {
  const state = { failedTurnId: 'turn_1', code: 'rateLimitExceeded', starts: 0 };
  let transport;
  transport = codexTransport((method, params) => {
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    state.starts += 1;
    if (state.starts === 1) {
      state.failedTurnId = 'turn_2';
      state.code = 'serverOverloaded';
      transport.complete('turn_2', 'failed', 'serverOverloaded');
      return { turn: { id: 'turn_2', status: 'inProgress', items: [], error: null } };
    }
    transport.complete('turn_3', 'completed');
    return { turn: { id: 'turn_3', status: 'inProgress', items: [], error: null } };
  });
  const adapter = createCodexTurnContinuation(codexOptions(transport, {
    readSnapshot: async ctx => snapshot(THREAD, ctx.failedTurnId, ctx.failedTurnId === 'turn_1' ? 'rateLimitExceeded' : state.code)
  }));
  const result = await adapter.run({ threadId: THREAD, failedTurn: codexTurn('turn_1', 'failed', 'rateLimitExceeded') });
  assert.equal(result.ok, true);
  assert.equal(result.continuations, 2);
  assert.equal(transport.count('turn/start'), 2);
  assert.equal(transport.count('thread/resume'), 1);
});

test('codex: an ambiguous acknowledgement is reconciled, never blind-resent', async () => {
  let started = 0;
  let reconciles = 0;
  let transport;
  transport = codexTransport((method) => {
    if (method === 'thread/resume') return { thread: { id: THREAD } };
    started += 1;
    if (started === 1) throw Object.assign(new Error('socket closed'), { transport: true });
    transport.complete('turn_2', 'completed');
    return { turn: { id: 'turn_2', status: 'inProgress', items: [], error: null } };
  });
  const adapter = createCodexTurnContinuation(codexOptions(transport, {
    reconcileStart: async () => { reconciles += 1; return { state: 'not_started' }; }
  }));
  const result = await adapter.run({ threadId: THREAD, failedTurn: codexTurn('turn_1', 'failed', 'rateLimitExceeded') });
  assert.equal(result.ok, true);
  assert.equal(reconciles, 1);
  assert.equal(started, 2);
});

test('codex: a reconciled start is awaited without a second turn/start', async () => {
  let started = 0;
  let transport;
  transport = codexTransport((method) => {
    if (method === 'thread/resume') return { thread: { id: THREAD } };
    started += 1;
    throw Object.assign(new Error('timed out'), { transport: true });
  });
  const adapter = createCodexTurnContinuation(codexOptions(transport, {
    reconcileStart: async () => {
      transport.complete('turn_9', 'completed');
      return { state: 'started', turnId: 'turn_9' };
    }
  }));
  const result = await adapter.run({ threadId: THREAD, failedTurn: codexTurn('turn_1', 'failed', 'rateLimitExceeded') });
  assert.equal(result.ok, true);
  assert.equal(result.lastTurn.turnId, 'turn_9');
  assert.equal(started, 1);
});

test('codex: an unresolvable start stops without another turn/start', async () => {
  let started = 0;
  const transport = codexTransport((method) => {
    if (method === 'thread/resume') return { thread: { id: THREAD } };
    started += 1;
    throw Object.assign(new Error('socket closed'), { transport: true });
  });
  const adapter = createCodexTurnContinuation(codexOptions(transport));
  const result = await adapter.run({ threadId: THREAD, failedTurn: codexTurn('turn_1', 'failed', 'rateLimitExceeded') });
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'resume_unavailable');
  assert.equal(started, 1);
  const rejected = await (async () => {
    const adapter2 = createCodexTurnContinuation(codexOptions(codexTransport((method) => {
      if (method === 'thread/resume') return { thread: { id: THREAD } };
      throw Object.assign(new Error('invalid params'), { rpc: true });
    })));
    return adapter2.run({ threadId: THREAD, failedTurn: codexTurn('turn_1', 'failed', 'rateLimitExceeded') });
  })();
  assert.equal(rejected.reason, 'resume_unavailable');
});

test('codex: duplicate terminal notifications do not start extra turns', async () => {
  const state = { starts: 0 };
  let transport;
  transport = codexTransport((method) => {
    if (method === 'thread/resume') return { thread: { id: THREAD } };
    state.starts += 1;
    if (state.starts === 1) {
      transport.complete('turn_2', 'failed', 'serverOverloaded');
      transport.complete('turn_2', 'failed', 'serverOverloaded');
      return { turn: { id: 'turn_2', status: 'inProgress', items: [], error: null } };
    }
    transport.complete('turn_3', 'completed');
    transport.complete('turn_3', 'completed');
    return { turn: { id: 'turn_3', status: 'inProgress', items: [], error: null } };
  });
  const adapter = createCodexTurnContinuation(codexOptions(transport, {
    readSnapshot: async ctx => snapshot(THREAD, ctx.failedTurnId, ctx.failedTurnId === 'turn_1' ? 'rateLimitExceeded' : 'serverOverloaded')
  }));
  const result = await adapter.run({ threadId: THREAD, failedTurn: codexTurn('turn_1', 'failed', 'rateLimitExceeded') });
  assert.equal(result.ok, true);
  assert.equal(result.continuations, 2);
  assert.equal(transport.count('turn/start'), 2);
});

test('codex: unsafe native state stops before any turn/start', async () => {
  for (const [mutate, reason] of [
    [value => { value.pendingApproval = true; }, 'pending_approval'],
    [value => { value.pendingTools = true; }, 'pending_tools'],
    [value => { value.startedToolCallsSettled = false; }, 'unsettled_tool_calls'],
    [value => { value.ambiguousSideEffects = true; }, 'ambiguous_side_effects'],
    [value => { value.turnActive = true; }, 'turn_active'],
    [value => { value.durableCommitted = false; }, 'snapshot_not_committed']
  ]) {
    const transport = codexTransport((method, params) => {
      if (method === 'thread/resume') return { thread: { id: params.threadId } };
      return { turn: { id: 'turn_2', status: 'inProgress', items: [], error: null } };
    });
    const adapter = createCodexTurnContinuation(codexOptions(transport, {
      readSnapshot: async () => { const value = snapshot(THREAD, 'turn_1', 'rateLimitExceeded'); mutate(value); return value; }
    }));
    const result = await adapter.run({ threadId: THREAD, failedTurn: codexTurn('turn_1', 'failed', 'rateLimitExceeded') });
    assert.equal(result.reason, reason, String(mutate));
    assert.equal(transport.count('turn/start'), 0);
  }
});

test('codex: a non-transient failure never starts a continuation', async () => {
  for (const [code, reason] of [['contextWindowExceeded', 'context_exhausted'], ['usageLimitExceeded', 'quota_exhausted'],
    ['unauthorized', 'authentication'], ['cyberPolicy', 'policy_blocked'], ['inventedVariant', 'unknown_failure']]) {
    const transport = codexTransport(() => { throw new Error('no call expected'); });
    const adapter = createCodexTurnContinuation(codexOptions(transport));
    const result = await adapter.run({ threadId: THREAD, failedTurn: codexTurn('turn_1', 'failed', code) });
    assert.equal(result.reason, reason, code);
    assert.equal(transport.count('turn/start'), 0);
  }
});

test('codex: a continuation turn is never started without the failed snapshot', async () => {
  // The coordinator always supplies it; this proves the wrapper enforces the
  // rule itself rather than relying on its caller.
  let transport;
  transport = codexTransport((method) => {
    if (method === 'thread/resume') return { thread: { id: THREAD } };
    transport.complete('turn_2', 'completed');
    return { turn: { id: 'turn_2', status: 'inProgress', items: [], error: null } };
  });
  const adapter = createCodexTurnContinuation(codexOptions(transport));
  const result = await adapter.run({ threadId: THREAD, failedTurn: codexTurn('turn_1', 'failed', 'rateLimitExceeded') });
  assert.equal(result.ok, true);
  // Every turn/start that ran had a prior attested snapshot behind it.
  assert.equal(transport.count('turn/start'), 1);
  assert.equal(transport.count('thread/resume'), 1);
});

test('codex: thread/resume failure and malformed resumes refuse the run', async () => {
  const failing = codexTransport(() => { throw new Error('resume failed'); });
  const first = await createCodexTurnContinuation(codexOptions(failing))
    .run({ threadId: THREAD, failedTurn: codexTurn('turn_1', 'failed', 'rateLimitExceeded') });
  assert.equal(first.reason, 'thread_resume_failed');
  const wrongThread = codexTransport(() => ({ thread: { id: THREAD } }));
  const second = await createCodexTurnContinuation(codexOptions(wrongThread))
    .run({ threadId: 'thr_elsewhere', failedTurn: codexTurn('turn_1', 'failed', 'rateLimitExceeded') });
  assert.equal(second.reason, 'thread_resume_failed');
  assert.equal(first.continuations, 0);
  assert.equal(second.continuations, 0);
});

test('codex: one continuation per thread at a time', async () => {
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  let transport;
  transport = codexTransport((method) => {
    if (method === 'thread/resume') return { thread: { id: THREAD } };
    transport.complete('turn_2', 'completed');
    return { turn: { id: 'turn_2', status: 'inProgress', items: [], error: null } };
  });
  const adapter = createCodexTurnContinuation(codexOptions(transport, {
    readSnapshot: async () => { await gate; return snapshot(THREAD, 'turn_1', 'rateLimitExceeded'); }
  }));
  const first = adapter.run({ threadId: THREAD, failedTurn: codexTurn('turn_1', 'failed', 'rateLimitExceeded') });
  await assert.rejects(
    adapter.run({ threadId: THREAD, failedTurn: codexTurn('turn_1', 'failed', 'rateLimitExceeded') }),
    error => error.code === 'TURN_CONTINUATION_THREAD_LOCKED'
  );
  open();
  assert.equal((await first).status, 'completed');
});

test('codex: describe states the integration boundary', () => {
  const transport = codexTransport(() => { throw new Error('unused'); });
  const described = createCodexTurnContinuation(codexOptions(transport)).describe();
  assert.equal(described.hostIntegrationRequired, true);
  assert.equal(described.startsFirstTurn, false);
  assert.deepEqual(described.requiredHostSeams, ['rpc.call', 'subscribe', 'readSnapshot']);
  assert.ok(described.notSupported.some(entry => entry.includes('keyboard')));
  assert.deepEqual(described.continuationTurn.params, ['threadId', 'input']);
});

test('codex: required seams and continuation text are validated', () => {
  const transport = codexTransport(() => { throw new Error('unused'); });
  assert.throws(() => createCodexTurnContinuation(), TypeError);
  assert.throws(() => createCodexTurnContinuation({ subscribe: transport.subscribe, readSnapshot: async () => ({}) }), TypeError);
  assert.throws(() => createCodexTurnContinuation({ rpc: transport.rpc, readSnapshot: async () => ({}) }), TypeError);
  assert.throws(() => createCodexTurnContinuation({ rpc: transport.rpc, subscribe: transport.subscribe }), TypeError);
  for (const continuationText of ['', '   ', 'line one\nline two', 'x'.repeat(501), 42]) {
    assert.throws(() => createCodexTurnContinuation(codexOptions(transport, { continuationText })), TypeError, String(continuationText));
  }
  assert.throws(() => createCodexTurnContinuation(codexOptions(transport, { maxContinuations: 4 })), TypeError);
  assert.throws(() => createCodexTurnContinuation(codexOptions(transport, { deadlineMs: 180001 })), TypeError);
});

// ---------------------------------------------------------------------------
// DeepSeek Harness public client Session
// ---------------------------------------------------------------------------

const harnessFailed = (turnId, code, extra = {}) => ({
  turnId, status: 'failed', error: { code, message: sentinel }, nativeRetryExhausted: true, ...extra
});

function harnessSession(onPrompt) {
  const prompts = [];
  const session = {
    async prompt(content, mode, signal, requestId) {
      prompts.push({ content, mode, signal, requestId });
      return onPrompt(prompts.length);
    }
  };
  return { session, prompts };
}

test('harness: reports the missing public seam instead of inventing one', () => {
  const { session } = harnessSession(() => ({ ok: true }));
  assert.throws(() => createHarnessTurnContinuation({ session, readSnapshot: async () => ({}) }),
    error => error.code === 'HARNESS_SEAM_MISSING');
  assert.throws(() => createHarnessTurnContinuation({ readSnapshot: async () => ({}), awaitTurn: async () => ({}) }), TypeError);
  assert.throws(() => createHarnessTurnContinuation({ session, awaitTurn: async () => ({}) }), TypeError);
  const described = createHarnessTurnContinuation({ session, readSnapshot: async () => ({}), awaitTurn: async () => ({}) }).describe();
  assert.equal(described.hostIntegrationRequired, true);
  assert.equal(described.startsFirstTurn, false);
  assert.deepEqual(described.requiredHostSeams, ['readSnapshot', 'awaitTurn']);
  assert.ok(described.missingPublicSeam.includes('no turn-level retry/continue call'));
  assert.ok(described.notSupported.some(entry => entry.includes('keyboard')));
});

test('harness: prompts the same session and awaits the terminal turn', async () => {
  const { session, prompts } = harnessSession(() => ({ ok: true, value: { accepted: true } }));
  const adapter = createHarnessTurnContinuation({
    session,
    readSnapshot: async () => snapshot(SESSION, 't1', 'rateLimitExceeded'),
    awaitTurn: async () => ({ turnId: 't2', status: 'completed' })
  });
  const result = await adapter.run({ sessionId: SESSION, failedTurn: harnessFailed('t1', 'rateLimitExceeded') });
  assert.equal(result.ok, true);
  assert.equal(result.continuations, 1);
  assert.equal(result.adapter, 'deepseek-harness');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].mode, 'queue');
  assert.deepEqual(prompts[0].content, [{ type: 'text', text: DEFAULT_CONTINUATION_TEXT }]);
  assert.equal(typeof prompts[0].requestId, 'string');
  assert.ok(prompts[0].requestId.length > 0);
  assert.ok(!JSON.stringify(prompts[0].content).includes(sentinel));
});

test('harness: an ambiguous send is retried only under the same requestId', async () => {
  let transport;
  const { session, prompts } = harnessSession(call => {
    if (call === 1) throw new Error('socket closed');
    return { ok: true, value: { accepted: true } };
  });
  const adapter = createHarnessTurnContinuation({
    session,
    readSnapshot: async () => snapshot(SESSION, 't1', 'rateLimitExceeded'),
    awaitTurn: async ctx => { transport = ctx; return { turnId: 't2', status: 'completed' }; }
  });
  const result = await adapter.run({ sessionId: SESSION, failedTurn: harnessFailed('t1', 'rateLimitExceeded') });
  assert.equal(result.ok, true);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].requestId, prompts[1].requestId);
  assert.equal(transport.requestId, prompts[0].requestId);
});

test('harness: an explicit rejection is not retried', async () => {
  const { session, prompts } = harnessSession(() => ({ ok: false, error: { code: 'session/agent-busy' } }));
  const adapter = createHarnessTurnContinuation({
    session,
    readSnapshot: async () => snapshot(SESSION, 't1', 'rateLimitExceeded'),
    awaitTurn: async () => { throw new Error('must not be reached'); }
  });
  const result = await adapter.run({ sessionId: SESSION, failedTurn: harnessFailed('t1', 'rateLimitExceeded') });
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'resume_unavailable');
  assert.equal(prompts.length, 1);
});

test('harness: a failed turn is only continued after native retry ended', async () => {
  const { session, prompts } = harnessSession(() => ({ ok: true }));
  const adapter = createHarnessTurnContinuation({
    session, readSnapshot: async () => ({}), awaitTurn: async () => ({ turnId: 't2', status: 'completed' })
  });
  const pending = await adapter.run({ sessionId: SESSION, failedTurn: { turnId: 't1', status: 'failed', error: { code: 'rateLimitExceeded' } } });
  assert.equal(pending.reason, 'native_retry_pending');
  const retrying = await adapter.run({ sessionId: SESSION, failedTurn: harnessFailed('t1', 'rateLimitExceeded', { nativeRetryPending: true }) });
  assert.equal(retrying.reason, 'native_retry_pending');
  const done = await adapter.run({ sessionId: SESSION, failedTurn: { turnId: 't1', status: 'completed', nativeRetryExhausted: true } });
  assert.equal(done.reason, 'terminal_turn_required');
  const otherSession = await adapter.run({ sessionId: SESSION,
    failedTurn: { ...harnessFailed('t1', 'rateLimitExceeded'), sessionId: 'session_other' } });
  assert.equal(otherSession.reason, 'thread_mismatch');
  assert.equal(prompts.length, 0);
});

test('harness: a non-terminal observation is never treated as completion', async () => {
  const { session, prompts } = harnessSession(() => ({ ok: true }));
  const adapter = createHarnessTurnContinuation({
    session,
    readSnapshot: async () => snapshot(SESSION, 't1', 'rateLimitExceeded'),
    awaitTurn: async () => ({ turnId: 't2', status: 'inProgress' })
  });
  const result = await adapter.run({ sessionId: SESSION, failedTurn: harnessFailed('t1', 'rateLimitExceeded') });
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'resume_unavailable');
  assert.equal(prompts.length, 1);
});

test('harness: each continuation attempt carries a fresh requestId', async () => {
  const state = { failedTurnId: 't1', code: 'rateLimitExceeded', turns: 0 };
  const { session, prompts } = harnessSession(() => ({ ok: true }));
  const adapter = createHarnessTurnContinuation({
    session,
    readSnapshot: async ctx => snapshot(SESSION, ctx.failedTurnId, ctx.failedTurnId === 't1' ? 'rateLimitExceeded' : state.code),
    awaitTurn: async () => {
      state.turns += 1;
      if (state.turns === 1) {
        state.failedTurnId = 't2';
        state.code = 'serverOverloaded';
        return { turnId: 't2', status: 'failed', error: { code: 'serverOverloaded' } };
      }
      return { turnId: 't3', status: 'completed' };
    }
  });
  const result = await adapter.run({ sessionId: SESSION, failedTurn: harnessFailed('t1', 'rateLimitExceeded') });
  assert.equal(result.ok, true);
  assert.equal(result.continuations, 2);
  assert.equal(prompts.length, 2);
  assert.notEqual(prompts[0].requestId, prompts[1].requestId);
});

test('harness: unsafe native state stops before prompting', async () => {
  for (const [mutate, reason] of [
    [value => { value.pendingApproval = true; }, 'pending_approval'],
    [value => { value.pendingTools = true; }, 'pending_tools'],
    [value => { value.ambiguousSideEffects = true; }, 'ambiguous_side_effects'],
    [value => { value.startedToolCallsSettled = false; }, 'unsettled_tool_calls']
  ]) {
    const { session, prompts } = harnessSession(() => ({ ok: true }));
    const adapter = createHarnessTurnContinuation({
      session,
      readSnapshot: async () => { const value = snapshot(SESSION, 't1', 'rateLimitExceeded'); mutate(value); return value; },
      awaitTurn: async () => ({ turnId: 't2', status: 'completed' })
    });
    const result = await adapter.run({ sessionId: SESSION, failedTurn: harnessFailed('t1', 'rateLimitExceeded') });
    assert.equal(result.reason, reason, String(mutate));
    assert.equal(prompts.length, 0);
  }
});

test('harness: one continuation per session at a time', async () => {
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  const { session } = harnessSession(() => ({ ok: true }));
  const adapter = createHarnessTurnContinuation({
    session,
    readSnapshot: async () => { await gate; return snapshot(SESSION, 't1', 'rateLimitExceeded'); },
    awaitTurn: async () => ({ turnId: 't2', status: 'completed' })
  });
  const first = adapter.run({ sessionId: SESSION, failedTurn: harnessFailed('t1', 'rateLimitExceeded') });
  await assert.rejects(
    adapter.run({ sessionId: SESSION, failedTurn: harnessFailed('t1', 'rateLimitExceeded') }),
    error => error.code === 'TURN_CONTINUATION_THREAD_LOCKED'
  );
  open();
  assert.equal((await first).status, 'completed');
});

test('codex: the start timeout alone keeps the process alive until it reports ambiguity', () => {
  // A hung turn/start holds no socket or timer of its own. If withTimeout's
  // timer were unref'd the process would exit before the timeout fired and the
  // ambiguous acknowledgement would never reach the caller.
  const script = `
    const { createCodexTurnContinuation } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'client-continuation'))});
    const THREAD = 'thr_timeout_child';
    const adapter = createCodexTurnContinuation({
      startTimeoutMs: 120,
      rpc: { async call(method) {
        if (method === 'thread/resume') return { thread: { id: THREAD } };
        return new Promise(() => {});
      } },
      subscribe: () => () => {},
      readSnapshot: async context => ({ snapshotId: 'snap_1', failedTurnId: context.failedTurnId,
        failedFingerprint: context.failedFingerprint, durableCommitted: true, turnActive: false,
        pendingApproval: false, pendingTools: false, startedToolCallsSettled: true,
        ambiguousSideEffects: false, nativeRetryPending: false })
    });
    adapter.run({ threadId: THREAD, failedTurn: { threadId: THREAD, turn: { id: 'turn_1', status: 'failed',
      items: [], error: { message: 'x', codexErrorInfo: 'rateLimitExceeded', additionalDetails: null } } } })
      .then(result => { process.stdout.write(JSON.stringify({ status: result.status, reason: result.reason })); },
        error => { process.stdout.write(JSON.stringify({ error: String(error && error.message) })); process.exitCode = 3; });
  `;
  const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, `child exited without settling: ${child.stdout} ${child.stderr}`);
  const parsed = JSON.parse(child.stdout || 'null');
  // An unanswered start is ambiguous and must be reported, never retried.
  assert.equal(parsed.status, 'stopped');
  assert.ok(['resume_unavailable'].includes(parsed.reason), JSON.stringify(parsed));
});

test('neither adapter logs or copies conversation content', () => {
  for (const name of ['client-continuation.js', 'turn-continuation.js']) {
    const source = readFileSync(path.join(__dirname, '..', 'lib', name), 'utf8');
    assert.ok(!/console\.(log|info|warn|error|debug)/.test(source), `${name} must not log`);
    assert.ok(!/process\.(stdout|stderr)/.test(source), `${name} must not write to stdio`);
  }
});
