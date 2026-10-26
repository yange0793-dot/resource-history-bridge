'use strict';

// Harness host seams against the real installed event and call shapes. Every
// fixture below is the payload `@deepseek-ai/dsh-agent` / `dsh-agent-loop` /
// `dsh-session` 0.2.1-rc.1 actually produces: the same event types, the same
// `turn/end` reason vocabulary, the same `LlmError#failure` fields, and the same
// synchronous claim that `agent.followup()` performs.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createHarnessHost,
  foldHarnessSession,
  evaluateHarnessSnapshot,
  classifyHarnessFailure,
  HARNESS_MISSING_SEAM,
  HARNESS_EVENTS,
  HARNESS_CODE_TRANSLATION
} = require('../lib/harness-host');
const { turnFingerprint } = require('../lib/turn-continuation');

const SESSION = 'sess_synthetic_mock';

function createEventBus() {
  const listeners = new Map();
  return {
    on(name, handler) {
      const set = listeners.get(name) ?? new Set();
      set.add(handler);
      listeners.set(name, set);
      return () => set.delete(handler);
    },
    emit(name, ...args) {
      const set = listeners.get(name);
      if (set === undefined) return;
      for (const handler of [...set]) handler(...args);
    }
  };
}

// A harness stand-in that mirrors the loop's ordering: a queued message is
// spliced into the inbox, `followup()` claims it synchronously inside
// `turn/start`, and only the model work is asynchronous. `turn/end` is
// published while the agent is still running; the idle transition follows.
function createHarnessMock(options = {}) {
  const sessionId = options.sessionId ?? SESSION;
  const bus = createEventBus();
  const log = [];
  const sent = [];
  const plans = [];
  const inbox = { nextTurn: [], nextStep: [] };
  let seq = 0;
  let turn = 0;
  const session = { id: sessionId, snapshotEvents: () => Object.freeze([...log]) };
  const agent = {
    id: sessionId,
    session,
    inbox,
    status: 'idle',
    followup(message) { enqueue('next-turn', message); },
    steer(message) { enqueue('next-step', message); }
  };

  function append(type, data, extra) {
    const event = Object.freeze({ type, seq: seq++, time: 1_700_000_000_000 + seq, data, ...extra });
    log.push(event);
    bus.emit('session/event', session, event);
    return event;
  }

  function setStatus(status) {
    agent.status = status;
    bus.emit('agent/status', { agent, status });
  }

  function enqueue(target, message) {
    const list = target === 'next-turn' ? inbox.nextTurn : inbox.nextStep;
    const start = list.length;
    list.push(message);
    sent.push({ target, message });
    append('agent/inbox/spliced', { target, start, inserted: [message] });
    if (agent.status === 'idle' && target === 'next-turn') startTurn();
  }

  function startTurn() {
    const plan = plans.shift() ?? { kind: 'completed' };
    turn += 1;
    const current = turn;
    append('turn/start', { turn: current });
    const claimed = [];
    if (inbox.nextStep.length > 0) claimed.push(...inbox.nextStep.splice(0, inbox.nextStep.length));
    if (inbox.nextTurn.length > 0) claimed.push(...inbox.nextTurn.splice(0, 1));
    setStatus('running');
    for (const message of claimed) bus.emit('agent/inbox/claimed', { agent, message, turn: current });
    append('step/start', { turn: current, step: 1 });
    for (const message of claimed) append('user/message', message, { surfaceOp: 'append' });
    if (plan.kind === 'hang') return;
    setTimeout(() => finishTurn(current, plan), 0);
  }

  function finishTurn(current, plan) {
    append('step/end', { turn: current, step: 1 });
    if (plan.kind === 'error') {
      const failure = { message: plan.message ?? 'stream ended without done/error', code: plan.code ?? 'TRANSPORT' };
      if (plan.status !== undefined) failure.status = plan.status;
      if (plan.retryAfterMs !== undefined) failure.providerRetryAfterMs = plan.retryAfterMs;
      append('turn/end', { turn: current, reason: { kind: 'error', error: failure } });
    } else {
      append('turn/end', { turn: current, reason: { kind: plan.kind === 'blocked' ? 'blocked' : 'completed' } });
    }
    setStatus('idle');
  }

  // A turn that already failed before the host was asked to continue: the log
  // ends with `turn/end { reason: { kind: 'error' } }` and the agent is idle.
  function failTurn(spec = {}) {
    turn += 1;
    const current = turn;
    setStatus('running');
    append('turn/start', { turn: current });
    append('step/start', { turn: current, step: 1 });
    append('step/end', { turn: current, step: 1 });
    append('turn/end', {
      turn: current,
      reason: { kind: 'error', error: { message: spec.message ?? 'stream ended without done/error', code: spec.code ?? 'TRANSPORT' } }
    });
    setStatus('idle');
    return current;
  }

  // An already-open turn: another message the user (or a plugin) sent, with the
  // events that make it a real in-flight turn.
  function openTurn() {
    turn += 1;
    const current = turn;
    setStatus('running');
    append('turn/start', { turn: current });
    append('step/start', { turn: current, step: 1 });
    return current;
  }

  return {
    sessionId,
    events: { on: bus.on, emit: bus.emit },
    agent,
    log,
    sent,
    append,
    setStatus,
    failTurn,
    openTurn,
    planNext(spec) { plans.push(spec); },
    agentFor: id => (id === sessionId ? agent : undefined)
  };
}

function createHost(mock, overrides = {}) {
  return createHarnessHost({
    events: mock.events,
    agentFor: mock.agentFor,
    flushDurable: async () => true,
    now: () => 1,
    baseDelayMs: 0,
    deadlineMs: 5000,
    ...overrides
  });
}

function failureOf(code, extra = {}) {
  return classifyHarnessFailure({ kind: 'error', error: { message: 'mock failure', code, ...extra } });
}

function assistantToolCall(turn, callId) {
  return {
    turn, step: 1,
    message: { id: `msg_${callId}`, role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }], source: { kind: 'model' } }
  };
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// Description and refusal
// ---------------------------------------------------------------------------

test('describe() reports the real event names and the missing seams instead of inventing an API', () => {
  const host = createHost(createHarnessMock());
  const described = host.describe();
  assert.equal(described.adapter, 'deepseek-harness');
  assert.equal(described.events.sessionEvent, 'session/event');
  assert.equal(described.events.agentStatus, 'agent/status');
  assert.equal(described.events.inboxClaimed, 'agent/inbox/claimed');
  assert.equal(described.events.turnEnd, 'turn/end');
  assert.deepEqual(described.missingPublicSeam, HARNESS_MISSING_SEAM);
  // The seam list must say plainly that there is no continuation RPC.
  assert.ok(HARNESS_MISSING_SEAM.some(line => line.includes('no turn-level retry/continue call')));
  assert.ok(HARNESS_MISSING_SEAM.some(line => line.includes('requestId idempotency')));
  assert.ok(described.publicSurfaces.includes('agent.followup(message) / agent.steer(message)'));
  assert.ok(described.notSupported.includes('keyboard or UI automation'));
});

test('a host with no event seam refuses by name instead of guessing', () => {
  assert.throws(() => createHarnessHost({}), error => {
    assert.equal(error.code, 'HARNESS_HOST_SEAM_MISSING');
    assert.deepEqual(error.missingSeam, ['events']);
    return true;
  });
  const mock = createHarnessMock();
  assert.throws(() => createHarnessHost({ events: mock.events, agentFor: 'not-a-function' }), error => {
    assert.equal(error.code, 'HARNESS_HOST_SEAM_MISSING');
    assert.deepEqual(error.missingSeam, ['agentFor']);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Durable fold and snapshot attestation
// ---------------------------------------------------------------------------

test('the fold closes settled tool calls, approvals and retries the way the loop does', () => {
  const mock = createHarnessMock();
  const turn = mock.openTurn();
  mock.append('assistant/message', assistantToolCall(turn, 'call_1'));
  mock.append('tool/call', { turn, step: 1, callId: 'call_1' });
  mock.append('tool/result', {
    turn, step: 1,
    message: { id: 'msg_result_1', role: 'tool', toolCallId: 'call_1', isError: false, content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: 'call_1' } }
  }, { surfaceOp: 'append' });
  mock.append('approval/asked', { id: 'ap_1', toolName: 'bash' });
  mock.append('approval/decided', { id: 'ap_1', outcome: 'allowed' });
  mock.append('llm/retry', { retryId: 'r_1', turn, step: 1, provider: 'ag', retry: 1, maxRetries: 50 });
  mock.append('llm/retry-started', { retryId: 'r_1', turn, step: 1, retry: 1 });

  const fold = foldHarnessSession(mock.log);
  assert.equal(fold.openTurn, turn);
  assert.equal(fold.pendingTools, 0);
  assert.equal(fold.unsettledStartedCalls, 0);
  assert.deepEqual(fold.pendingApprovals, []);
  assert.deepEqual(fold.openRetries, []);
  assert.deepEqual(fold.ambiguousTurns, []);
});

test('a started tool call closed only by a recovery result marks the turn ambiguous', () => {
  const mock = createHarnessMock();
  const turn = mock.failTurn({ code: 'TRANSPORT' });
  // The loop rolls a conservative result in before `step/end`, so the turn can
  // close with no unanswered call and still leave the side effect unknown.
  mock.log.length = 0;
  mock.append('turn/start', { turn });
  mock.append('step/start', { turn, step: 1 });
  mock.append('assistant/message', assistantToolCall(turn, 'call_9'));
  mock.append('tool/call', { turn, step: 1, callId: 'call_9' });
  mock.append('tool/result', {
    turn, step: 1,
    message: { id: 'interrupted-tool-result-call_9-7', role: 'tool', toolCallId: 'call_9', isError: true, content: [{ type: 'text', text: 'started' }], source: { kind: 'tool', callId: 'call_9' } }
  }, { surfaceOp: 'append' });
  mock.append('step/end', { turn, step: 1 });
  mock.append('turn/end', { turn, reason: { kind: 'error', error: { message: 'reset', code: 'TRANSPORT' } } });

  const fold = foldHarnessSession(mock.log);
  assert.deepEqual(fold.ambiguousTurns, [turn]);
  const verdict = evaluateHarnessSnapshot({
    sessionId: SESSION, failedTurnId: String(turn), fold, agentStatus: 'idle', durableCommitted: true
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'ambiguous_side_effects');
  // The core has a field for exactly this state, so it names it too.
  assert.equal(verdict.snapshot.ambiguousSideEffects, true);
});

test('readSnapshot attests an idle, settled, committed failed turn', async () => {
  const mock = createHarnessMock();
  const turn = mock.failTurn({ code: 'TRANSPORT' });
  const host = createHost(mock);
  const fingerprint = turnFingerprint({ threadId: SESSION, turnId: String(turn), status: 'failed', error: { code: 'httpConnectionFailed' } });
  const snapshot = await host.readSnapshot({ threadId: SESSION, failedTurnId: String(turn), failedFingerprint: fingerprint });
  assert.deepEqual(snapshot, {
    snapshotId: `${SESSION}\u0000${turn}\u0000${mock.log.at(-1).seq}`,
    failedTurnId: String(turn),
    failedFingerprint: fingerprint,
    durableCommitted: true,
    turnActive: false,
    pendingApproval: false,
    pendingTools: false,
    startedToolCallsSettled: true,
    ambiguousSideEffects: false,
    nativeRetryPending: false
  });
  // Deterministic id: the same durable position cannot authorize twice.
  const again = await host.readSnapshot({ threadId: SESSION, failedTurnId: String(turn), failedFingerprint: fingerprint });
  assert.equal(again.snapshotId, snapshot.snapshotId);
});

test('an unreadable durability barrier withholds the attestation', async () => {
  const mock = createHarnessMock();
  const turn = mock.failTurn({ code: 'TRANSPORT' });
  const host = createHost(mock, { flushDurable: async () => false });
  const snapshot = await host.readSnapshot({ threadId: SESSION, failedTurnId: String(turn) });
  assert.equal(snapshot.durableCommitted, false);
  assert.equal(host.diagnostics().lastRefusal.reason, 'snapshot_not_committed');
});

test('a turn that is not the newest one cannot be continued', async () => {
  const mock = createHarnessMock();
  const first = mock.failTurn({ code: 'TRANSPORT' });
  mock.failTurn({ code: 'TRANSPORT' });
  const host = createHost(mock);
  const snapshot = await host.readSnapshot({ threadId: SESSION, failedTurnId: String(first) });
  assert.equal(snapshot, undefined);
  assert.equal(host.diagnostics().lastRefusal.reason, 'stale_failed_turn');
});

// ---------------------------------------------------------------------------
// Automatic continuation end to end
// ---------------------------------------------------------------------------

test('a transient failure ends in one continuation turn that completes', async () => {
  const mock = createHarnessMock();
  const host = createHost(mock);
  const turn = mock.failTurn({ code: 'TRANSPORT' });
  mock.planNext({ kind: 'completed' });

  const result = await host.continueAfterFailure({ sessionId: SESSION, turnId: String(turn), failure: failureOf('TRANSPORT') });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.reason, 'turn_completed');
  assert.equal(result.continuations, 1);
  assert.equal(result.adapter, 'deepseek-harness');
  assert.equal(mock.sent.length, 1);
  const [{ target, message }] = mock.sent;
  // The same session, an ordinary queued next turn, an identified user message.
  assert.equal(target, 'next-turn');
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'user');
  assert.match(message.source.rpcId, /rhb-continuation/);
  assert.equal(message.content[0].type, 'text');
  assert.ok(message.content[0].text.length > 0);
});

test('a provider failure that the core reads as decided never sends a turn', async () => {
  const mock = createHarnessMock();
  const host = createHost(mock);
  const turn = mock.failTurn({ code: 'AUTH' });

  const result = await host.continueAfterFailure({ sessionId: SESSION, turnId: String(turn), failure: failureOf('AUTH') });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'authentication');
  assert.equal(mock.sent.length, 0);
});

test('an unmapped native code stops instead of being guessed to be transient', async () => {
  const mock = createHarnessMock();
  const host = createHost(mock);
  const turn = mock.failTurn({ code: 'EMPTY_RESPONSE' });
  const result = await host.continueAfterFailure({ sessionId: SESSION, turnId: String(turn), failure: failureOf('EMPTY_RESPONSE') });
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'unknown_failure');
  assert.equal(mock.sent.length, 0);
  assert.equal(classifyHarnessFailure({ kind: 'error', error: { code: 'EMPTY_RESPONSE' } }).code, 'EMPTY_RESPONSE');
});

test('a 5xx with a real status is transient, and Retry-After is carried as a floor', async () => {
  const mock = createHarnessMock();
  const host = createHost(mock, { baseDelayMs: 0 });
  const turn = mock.failTurn({ code: 'PI_AI_ERROR' });
  mock.planNext({ kind: 'completed' });
  const failure = classifyHarnessFailure({ kind: 'error', error: { message: 'gateway', code: 'PI_AI_ERROR', status: 503, providerRetryAfterMs: 5 } });
  assert.equal(failure.httpStatusCode, 503);
  assert.equal(failure.retryAfterMs, 5);
  const result = await host.continueAfterFailure({ sessionId: SESSION, turnId: String(turn), failure });
  assert.equal(result.status, 'completed');
});

// ---------------------------------------------------------------------------
// Gates that must not trigger
// ---------------------------------------------------------------------------

test('the same failed turn is never continued twice', async () => {
  const mock = createHarnessMock();
  const host = createHost(mock);
  const turn = mock.failTurn({ code: 'TRANSPORT' });
  mock.planNext({ kind: 'completed' });

  const first = await host.continueAfterFailure({ sessionId: SESSION, turnId: String(turn), failure: failureOf('TRANSPORT') });
  assert.equal(first.status, 'completed');
  const sentAfterFirst = mock.sent.length;

  const second = await host.continueAfterFailure({ sessionId: SESSION, turnId: String(turn), failure: failureOf('TRANSPORT') });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'failed_turn_already_continued');
  assert.equal(mock.sent.length, sentAfterFirst);
});

test('a native retry still in flight blocks the snapshot', async () => {
  const mock = createHarnessMock();
  const host = createHost(mock);
  const turn = mock.failTurn({ code: 'TRANSPORT' });
  const open = mock.openTurn();
  // `llm-retry` appends the retry record before its cancellable wait, so an
  // un-started retry is exactly "the native loop still owns this turn".
  mock.append('llm/retry', { retryId: 'r_2', turn: open, step: 1, provider: 'ag', retry: 3, maxRetries: 50 });

  const result = await host.continueAfterFailure({ sessionId: SESSION, turnId: String(turn), failure: failureOf('TRANSPORT') });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'stopped');
  // Because the other turn is open as well, the core names the earlier gate.
  assert.equal(result.reason, 'turn_active');
  assert.equal(host.diagnostics().lastRefusal.reason, 'native_retry_pending');
  assert.equal(mock.sent.length, 0);
});

test('an unsettled tool call in another open turn blocks the snapshot', async () => {
  const mock = createHarnessMock();
  const host = createHost(mock);
  const turn = mock.failTurn({ code: 'TRANSPORT' });
  const open = mock.openTurn();
  mock.append('assistant/message', assistantToolCall(open, 'call_live'));
  mock.append('tool/call', { turn: open, step: 1, callId: 'call_live' });

  const result = await host.continueAfterFailure({ sessionId: SESSION, turnId: String(turn), failure: failureOf('TRANSPORT') });

  assert.equal(result.status, 'stopped');
  assert.equal(host.diagnostics().lastRefusal.reason, 'unsettled_tool_calls');
  assert.equal(mock.sent.length, 0);
});

test('a tool call the assistant announced but never started still blocks', async () => {
  const mock = createHarnessMock();
  const host = createHost(mock);
  const turn = mock.failTurn({ code: 'TRANSPORT' });
  const open = mock.openTurn();
  mock.append('assistant/message', assistantToolCall(open, 'call_announced'));

  const result = await host.continueAfterFailure({ sessionId: SESSION, turnId: String(turn), failure: failureOf('TRANSPORT') });

  assert.equal(result.status, 'stopped');
  assert.equal(host.diagnostics().lastRefusal.reason, 'pending_tools');
  assert.equal(mock.sent.length, 0);
});

test('an unanswered approval blocks the snapshot', async () => {
  const mock = createHarnessMock();
  const host = createHost(mock);
  const turn = mock.failTurn({ code: 'TRANSPORT' });
  const open = mock.openTurn();
  mock.append('approval/asked', { id: 'ap_live', toolName: 'bash', callId: 'call_live' });

  const result = await host.continueAfterFailure({ sessionId: SESSION, turnId: String(turn), failure: failureOf('TRANSPORT') });

  assert.equal(result.status, 'stopped');
  assert.equal(host.diagnostics().lastRefusal.reason, 'pending_approval');
  assert.equal(mock.sent.length, 0);
  assert.equal(foldHarnessSession(mock.log).pendingApprovals.length, 1);
  void open;
});

test('a blocked or user-cancelled turn is reported terminal and never continued', async () => {
  const mock = createHarnessMock();
  const host = createHost(mock, { autoContinue: true });
  mock.append('turn/start', { turn: 1 });
  mock.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } });
  mock.append('turn/start', { turn: 2 });
  mock.append('turn/end', { turn: 2, reason: { kind: 'blocked' } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(mock.sent.length, 0);
  assert.equal(host.diagnostics().lastRefusal, null);
});

// ---------------------------------------------------------------------------
// Budget, cancellation and the automatic trigger
// ---------------------------------------------------------------------------

test('the automatic trigger continues once and refuses a second failure beyond its budget', async () => {
  const mock = createHarnessMock();
  const host = createHost(mock, { autoContinue: true, maxAutoRuns: 1 });
  mock.planNext({ kind: 'completed' });

  mock.failTurn({ code: 'TRANSPORT' });
  await waitFor(() => mock.sent.length === 1, 'the first automatic continuation');
  // Let the continuation turn finish and the run settle before the next failure,
  // so the second failure is judged by the budget rather than by a busy run.
  await waitFor(() => mock.agent.status === 'idle', 'the continuation turn to end');
  await new Promise(resolve => setTimeout(resolve, 20));

  mock.failTurn({ code: 'TRANSPORT' });
  await waitFor(() => host.diagnostics().lastRefusal?.reason === 'auto_budget_exhausted', 'the budget refusal');
  assert.equal(mock.sent.length, 1);
});

test('a failure produced inside a run is handled by that run, not by a second one', async () => {
  const mock = createHarnessMock();
  const host = createHost(mock, { autoContinue: true, maxAutoRuns: 3 });
  // The continuation turn itself fails with a decided cause, so the run ends
  // after one continuation instead of spending its whole budget.
  mock.planNext({ kind: 'error', code: 'AUTH' });

  mock.failTurn({ code: 'TRANSPORT' });
  await waitFor(() => mock.sent.length === 1, 'the automatic continuation');
  await waitFor(() => mock.agent.status === 'idle', 'the continuation turn to end');
  await new Promise(resolve => setTimeout(resolve, 20));

  // Any later idle transition must not revive the failure the run already owned.
  mock.setStatus('idle');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(mock.sent.length, 1);
});

test('the automatic trigger does nothing while autoContinue is off', async () => {
  const mock = createHarnessMock();
  createHost(mock);
  mock.failTurn({ code: 'TRANSPORT' });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(mock.sent.length, 0);
});

test('cancelling the run stops the wait without sending another turn', async () => {
  const mock = createHarnessMock();
  const host = createHost(mock, { deadlineMs: 5000 });
  const turn = mock.failTurn({ code: 'TRANSPORT' });
  mock.planNext({ kind: 'hang' });

  const controller = new AbortController();
  const running = host.continuationFor(SESSION).run({
    sessionId: SESSION,
    failedTurn: { sessionId: SESSION, turnId: String(turn), status: 'failed', nativeRetryExhausted: true, error: failureOf('TRANSPORT') },
    signal: controller.signal
  });
  await waitFor(() => mock.sent.length === 1, 'the continuation prompt');
  controller.abort();
  const result = await running;

  assert.equal(result.ok, false);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'aborted');
  assert.equal(mock.sent.length, 1);
});

test('a turn that never becomes terminal expires on the deadline', async () => {
  const mock = createHarnessMock();
  const host = createHost(mock, { deadlineMs: 40 });
  const turn = mock.failTurn({ code: 'TRANSPORT' });
  mock.planNext({ kind: 'hang' });

  const result = await host.continuationFor(SESSION).run({
    sessionId: SESSION,
    failedTurn: { sessionId: SESSION, turnId: String(turn), status: 'failed', nativeRetryExhausted: true, error: failureOf('TRANSPORT') }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'deadline_expired');
});

// ---------------------------------------------------------------------------
// Prompt seam: idempotency and cold sessions
// ---------------------------------------------------------------------------

test('an identical requestId is one acceptance, never a second message', async () => {
  const mock = createHarnessMock();
  const host = createHost(mock);
  mock.planNext({ kind: 'hang' });
  const content = [{ type: 'text', text: 'continue' }];

  const first = await host.prompt(SESSION, content, 'queue', undefined, 'rid_fixed');
  assert.equal(first.accepted, true);
  assert.equal(first.deduplicated, undefined);
  const second = await host.prompt(SESSION, content, 'queue', undefined, 'rid_fixed');
  assert.equal(second.deduplicated, true);
  assert.equal(second.messageId, first.messageId);
  assert.equal(mock.sent.length, 1);
  // The same rule the session controller applies to its own prompt path.
  assert.ok(mock.log.some(event => event.type === 'user/message' && event.data.source.rpcId === 'rid_fixed'));
});

test('a cold session is refused by name rather than continued blind', async () => {
  const mock = createHarnessMock();
  const host = createHarnessHost({
    events: mock.events,
    agentFor: () => undefined,
    flushDurable: async () => true,
    now: () => 1
  });
  mock.failTurn({ code: 'TRANSPORT' });

  await assert.rejects(host.prompt(SESSION, [{ type: 'text', text: 'continue' }], 'queue', undefined, 'rid_cold'), error => {
    assert.equal(error.code, 'HARNESS_SESSION_NOT_LIVE');
    return true;
  });

  const turn = mock.log.find(event => event.type === 'turn/end')?.data.turn ?? 1;
  const result = await host.continueAfterFailure({ sessionId: SESSION, turnId: String(turn), failure: failureOf('TRANSPORT') });
  assert.equal(result.status, 'stopped');
  assert.equal(host.diagnostics().lastRefusal.reason, 'session_not_live');
  assert.equal(mock.sent.length, 0);
});

// ---------------------------------------------------------------------------
// Native vocabulary translation
// ---------------------------------------------------------------------------

test('native codes keep their translated twin and their original name', () => {
  const transport = classifyHarnessFailure({ kind: 'error', error: { message: 'reset', code: 'TRANSPORT' } });
  assert.equal(transport.code, HARNESS_CODE_TRANSLATION.TRANSPORT);
  assert.equal(transport.nativeCode, 'TRANSPORT');
  assert.equal(classifyHarnessFailure({ kind: 'error', error: { code: 'AUTH' } }).code, 'unauthorized');
  assert.equal(classifyHarnessFailure({ kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED' } }).code, 'context_length_exceeded');
  // A reason without an error record is an unknown failure, not a transient one.
  const empty = classifyHarnessFailure({ kind: 'error' });
  assert.equal(empty.code, 'UNKNOWN');
  assert.equal(empty.nativeCode, 'UNKNOWN');
  // The documented event names are the ones the host subscribes to.
  assert.equal(HARNESS_EVENTS.inboxSpliced, 'agent/inbox/spliced');
  assert.equal(HARNESS_EVENTS.llmRetryStarted, 'llm/retry-started');
});
