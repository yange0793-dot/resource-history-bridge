'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createTurnContinuation,
  classifyContinuationFailure,
  turnFingerprint,
  RESOURCE_MESSAGE
} = require('../lib/turn-continuation');

const THREAD = 'thr_synthetic_001';
const sentinel = 'SYNTHETIC_UPSTREAM_SECRET_MESSAGE';

const failed = (turnId, error = { code: 'rateLimitExceeded' }) => ({
  threadId: THREAD, turnId, status: 'failed', terminal: true, error
});
const completed = turnId => ({ threadId: THREAD, turnId, status: 'completed', terminal: true, error: null });
const interrupted = turnId => ({ threadId: THREAD, turnId, status: 'interrupted', terminal: true, error: null });

let snapshots = 0;
const snapshotFor = (turn, overrides = {}) => ({
  snapshotId: `snap_${++snapshots}`,
  failedTurnId: turn.turnId,
  failedFingerprint: turnFingerprint(turn),
  durableCommitted: true,
  turnActive: false,
  pendingApproval: false,
  pendingTools: false,
  startedToolCallsSettled: true,
  ambiguousSideEffects: false,
  nativeRetryPending: false,
  ...overrides
});

function run(initialTurn, resumeTurn, extra = {}) {
  const coordinator = createTurnContinuation({ baseDelayMs: 0, maxDelayMs: 0, ...extra.options });
  return coordinator.run({
    threadId: THREAD,
    initialTurn,
    readSnapshot: extra.readSnapshot ?? attestation,
    resumeTurn,
    ...extra.input
  });
}

// A host that attests whatever the coordinator just asked about. Individual
// cases replace this with a stricter or lying host.
const attestation = async ctx => ({
  snapshotId: `snap_${++snapshots}`,
  failedTurnId: ctx.failedTurnId,
  failedFingerprint: ctx.failedFingerprint,
  durableCommitted: true,
  turnActive: false,
  pendingApproval: false,
  pendingTools: false,
  startedToolCallsSettled: true,
  ambiguousSideEffects: false,
  nativeRetryPending: false
});

test('classification whitelists transient failures and stops everything else', () => {
  for (const code of ['rateLimitExceeded', 'serverOverloaded', 'internalServerError', 'flexUnavailable',
    'httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected',
    'responseTooManyFailedAttempts']) {
    assert.equal(classifyContinuationFailure({ code }).classification, 'transient', code);
  }
  for (const status of [408, 429, 500, 502, 503, 504, 599]) {
    assert.equal(classifyContinuationFailure({ httpStatusCode: status }).classification, 'transient', String(status));
  }
  // Object-form CodexErrorInfo variants carry their HTTP status inside.
  assert.equal(classifyContinuationFailure({ code: { responseStreamDisconnected: { httpStatusCode: 503 } } }).classification, 'transient');
  assert.equal(classifyContinuationFailure({ code: { responseStreamDisconnected: { httpStatusCode: 400 } } }).reason, 'invalid_request');
});

test('classification stops context, quota, auth, policy and unknown failures', () => {
  const cases = new Map([
    ['contextWindowExceeded', 'context_exhausted'],
    ['sessionBudgetExceeded', 'budget_exhausted'],
    ['usageLimitExceeded', 'quota_exhausted'],
    ['unauthorized', 'authentication'],
    ['badRequest', 'invalid_request'],
    ['cyberPolicy', 'policy_blocked'],
    ['misalignmentPolicyViolation', 'policy_blocked'],
    ['tooManyDenials', 'policy_blocked'],
    ['sandboxError', 'sandbox_error'],
    ['activeTurnNotSteerable', 'unsupported_state'],
    ['somethingNewUpstreamInvented', 'unknown_failure']
  ]);
  for (const [code, reason] of cases) {
    const result = classifyContinuationFailure({ code });
    assert.equal(result.classification, 'stop', code);
    assert.equal(result.reason, reason, code);
  }
  for (const status of [400, 401, 402, 403, 404, 409, 413, 422]) {
    assert.equal(classifyContinuationFailure({ httpStatusCode: status }).classification, 'stop', String(status));
  }
  assert.equal(classifyContinuationFailure(null).reason, 'unknown_failure');
  assert.equal(classifyContinuationFailure({}).reason, 'unknown_failure');
});

test('only the exact resource message classifies as resource', () => {
  assert.equal(classifyContinuationFailure({ message: RESOURCE_MESSAGE }).classification, 'resource');
  assert.equal(classifyContinuationFailure({ message: `wrapped: ${RESOURCE_MESSAGE}` }).classification, 'resource');
  assert.equal(classifyContinuationFailure({ message: 'resource problem' }).classification, 'stop');
  assert.equal(classifyContinuationFailure({ message: RESOURCE_MESSAGE.slice(0, 30) }).classification, 'stop');
});

test('turn fingerprint is deterministic and host reproducible', () => {
  const a = turnFingerprint({ threadId: THREAD, turnId: 'turn_1', status: 'failed', error: { code: 'serverOverloaded' } });
  const b = turnFingerprint({ threadId: THREAD, turnId: 'turn_1', status: 'failed', error: { code: 'serverOverloaded' } });
  const c = turnFingerprint({ threadId: THREAD, turnId: 'turn_2', status: 'failed', error: { code: 'serverOverloaded' } });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(!a.includes(sentinel));
});

test('one continuation that completes finishes the run', async () => {
  const calls = [];
  const result = await run(failed('turn_1'), async ctx => {
    calls.push(ctx);
    return completed('turn_2');
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.continuations, 1);
  assert.equal(result.lastTurn.turnId, 'turn_2');
  assert.equal(result.hostIntegrationRequired, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].failedTurnId, 'turn_1');
  assert.equal(typeof calls[0].snapshotId, 'string');
  assert.equal(calls[0].continuationIndex, 1);
});

test('budget caps the run at three continuations and then reports exhaustion', async () => {
  let index = 1;
  const seen = [];
  const result = await run(failed('turn_0'), async ctx => {
    seen.push(ctx.continuationIndex);
    index += 1;
    return failed(`turn_${index}`);
  });
  assert.equal(result.status, 'exhausted');
  assert.equal(result.reason, 'continuation_budget_exhausted');
  assert.equal(result.ok, false);
  assert.equal(result.continuations, 3);
  assert.deepEqual(seen, [1, 2, 3]);
});

test('readSnapshot receives the failed turn and must attest it', async () => {
  let observed;
  const initial = failed('turn_1');
  await run(initial, async () => completed('turn_2'), {
    readSnapshot: async ctx => { observed = ctx; return snapshotFor(initial); }
  });
  assert.equal(observed.failedTurnId, 'turn_1');
  assert.equal(observed.failedFingerprint, turnFingerprint(initial));
  assert.equal(observed.threadId, THREAD);
});

test('unsafe or unattested snapshots stop before any continuation turn', async () => {
  const initial = failed('turn_1');
  const cases = [
    [snapshot => { delete snapshot.durableCommitted; }, 'snapshot_unattested'],
    [snapshot => { snapshot.durableCommitted = 'yes'; }, 'snapshot_unattested'],
    [snapshot => { snapshot.durableCommitted = false; }, 'snapshot_not_committed'],
    [snapshot => { snapshot.turnActive = true; }, 'turn_active'],
    [snapshot => { snapshot.pendingApproval = true; }, 'pending_approval'],
    [snapshot => { snapshot.pendingTools = true; }, 'pending_tools'],
    [snapshot => { snapshot.startedToolCallsSettled = false; }, 'unsettled_tool_calls'],
    [snapshot => { snapshot.ambiguousSideEffects = true; }, 'ambiguous_side_effects'],
    [snapshot => { snapshot.nativeRetryPending = true; }, 'native_retry_pending'],
    [snapshot => { delete snapshot.startedToolCallsSettled; }, 'snapshot_unattested'],
    [snapshot => { snapshot.failedTurnId = 'turn_other'; }, 'snapshot_turn_mismatch'],
    [snapshot => { snapshot.failedFingerprint = 'fingerprint_other'; }, 'snapshot_fingerprint_mismatch'],
    [snapshot => { snapshot.snapshotId = ''; }, 'snapshot_unattested']
  ];
  for (const [mutate, reason] of cases) {
    let resumeCalls = 0;
    const result = await run(initial, async () => { resumeCalls += 1; return completed('turn_2'); }, {
      readSnapshot: async () => { const snapshot = snapshotFor(initial); mutate(snapshot); return snapshot; }
    });
    assert.equal(result.status, 'stopped', String(mutate));
    assert.equal(result.reason, reason, String(mutate));
    assert.equal(resumeCalls, 0, String(mutate));
  }
});

test('an unchanged native snapshot or a repeated failed turn is never continued twice', async () => {
  const initial = failed('turn_1');
  const frozenSnapshot = snapshotFor(initial);
  let resumeCalls = 0;
  const repeated = await run(initial, async () => {
    resumeCalls += 1;
    return failed('turn_1');
  }, { readSnapshot: async () => frozenSnapshot });
  assert.equal(repeated.reason, 'failed_turn_already_continued');
  assert.equal(resumeCalls, 1);

  let second = 0;
  let firstSnapshotId;
  const reused = await run(initial, async () => {
    second += 1;
    return failed('turn_2');
  }, {
    readSnapshot: async () => {
      if (second === 0) {
        const snapshot = snapshotFor(initial);
        firstSnapshotId = snapshot.snapshotId;
        return snapshot;
      }
      // A host re-reporting the already consumed snapshot has not observed any
      // forward progress, so the run ends instead of spending more budget.
      return { ...snapshotFor(failed('turn_2')), snapshotId: firstSnapshotId };
    }
  });
  assert.equal(reused.reason, 'snapshot_fingerprint_mismatch');
  assert.equal(reused.continuations, 1);
  assert.equal(second, 1);
});

test('every continuation attempt receives the attested failed snapshot', async () => {
  const contexts = [];
  const result = await run(failed('turn_1'), async ctx => {
    contexts.push(ctx);
    return failed(`turn_${contexts.length + 1}`, { code: 'serverOverloaded' });
  });
  assert.equal(result.status, 'exhausted');
  assert.equal(contexts.length, 3);
  for (const [index, context] of contexts.entries()) {
    assert.equal(typeof context.failedSnapshotId, 'string');
    assert.equal(context.failedSnapshotId, context.snapshotId);
    assert.equal(context.failedFingerprint, turnFingerprint(failed(`turn_${index + 1}`, { code: index === 0 ? 'rateLimitExceeded' : 'serverOverloaded' })));
    assert.equal(context.failedTurnId, `turn_${index + 1}`);
    assert.equal(context.continuationIndex, index + 1);
  }
  // Distinct snapshots are required for each continuation.
  assert.equal(new Set(contexts.map(context => context.snapshotId)).size, 3);
});

test('a host that rejects the snapshot context stops the run', async () => {
  let resumeCalls = 0;
  const result = await run(failed('turn_1'), async () => {
    resumeCalls += 1;
    throw Object.assign(new Error('snapshot missing'), { code: 'TURN_CONTINUATION_SNAPSHOT_REQUIRED' });
  });
  assert.equal(result.reason, 'snapshot_required');
  assert.equal(result.continuations, 1);
  assert.equal(resumeCalls, 1);
});

test('native retry still pending or a non-terminal turn never starts a continuation', async () => {
  for (const turn of [
    { ...failed('turn_1'), nativeRetryPending: true },
    { ...failed('turn_1'), nativeRetryExhausted: false },
    { ...failed('turn_1'), terminal: false },
    { threadId: THREAD, turnId: 'turn_1', status: 'inProgress', terminal: true, error: null },
    { threadId: THREAD, turnId: '', status: 'failed', terminal: true, error: null },
    { threadId: 'thr_other', turnId: 'turn_1', status: 'failed', terminal: true, error: null },
    null,
    'failed'
  ]) {
    let resumeCalls = 0;
    const result = await run(turn, async () => { resumeCalls += 1; return completed('turn_2'); });
    assert.notEqual(result.status, 'completed');
    assert.equal(result.continuations, 0);
    assert.equal(resumeCalls, 0);
  }
  assert.equal((await run({ ...failed('turn_1'), nativeRetryPending: true }, async () => completed('turn_2'))).reason, 'native_retry_pending');
  assert.equal((await run({ threadId: THREAD, turnId: 'turn_1', status: 'inProgress', terminal: true }, async () => completed('turn_2'))).reason, 'turn_not_terminal');
  assert.equal((await run({ ...failed('turn_1'), threadId: 'thr_other' }, async () => completed('turn_2'))).reason, 'thread_mismatch');
});

test('a terminal non-transient failure stops without continuing', async () => {
  for (const [code, reason] of [['contextWindowExceeded', 'context_exhausted'], ['unauthorized', 'authentication'],
    ['invalid_encrypted_content', 'invalid_request'], ['mystery', 'unknown_failure']]) {
    let resumeCalls = 0;
    const result = await run(failed('turn_1', { code }), async () => { resumeCalls += 1; return completed('turn_2'); });
    assert.equal(result.reason, reason, code);
    assert.equal(resumeCalls, 0, code);
  }
});

test('interrupted and completed turns terminate immediately', async () => {
  let resumeCalls = 0;
  const done = await run(completed('turn_1'), async () => { resumeCalls += 1; return completed('turn_2'); });
  assert.equal(done.status, 'completed');
  assert.equal(done.continuations, 0);
  const stopped = await run(interrupted('turn_1'), async () => { resumeCalls += 1; return completed('turn_2'); });
  assert.equal(stopped.reason, 'interrupted');
  assert.equal(resumeCalls, 0);
});

test('sendTurn starts the first turn and is mutually exclusive with initialTurn', async () => {
  let sends = 0;
  const coordinator = createTurnContinuation({ baseDelayMs: 0 });
  const result = await coordinator.run({
    threadId: THREAD,
    sendTurn: async () => { sends += 1; return failed('turn_1'); },
    readSnapshot: async () => snapshotFor(failed('turn_1')),
    resumeTurn: async () => completed('turn_2')
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.continuations, 1);
  assert.equal(sends, 1);

  const invalid = createTurnContinuation({});
  await assert.rejects(invalid.run({ threadId: THREAD, sendTurn: async () => completed('a'), initialTurn: completed('a'),
    readSnapshot: async () => ({}), resumeTurn: async () => completed('b') }), /exactly one of/);
  await assert.rejects(invalid.run({ threadId: THREAD, readSnapshot: async () => ({}), resumeTurn: async () => completed('b') }), /exactly one of/);
});

test('sendTurn failure and invalid send results stop the run', async () => {
  const thrown = await createTurnContinuation({}).run({
    threadId: THREAD,
    sendTurn: async () => { throw new Error('socket closed'); },
    readSnapshot: async () => ({}),
    resumeTurn: async () => completed('turn_2')
  });
  assert.equal(thrown.reason, 'send_turn_failed');
  const mismatched = await createTurnContinuation({}).run({
    threadId: THREAD,
    sendTurn: async () => ({ ...failed('turn_1'), threadId: 'thr_other' }),
    readSnapshot: async () => ({}),
    resumeTurn: async () => completed('turn_2')
  });
  assert.equal(mismatched.reason, 'thread_mismatch');
});

test('a run is single use and rejects a concurrent run', async () => {
  const coordinator = createTurnContinuation({ baseDelayMs: 0 });
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  const input = () => ({
    threadId: THREAD,
    initialTurn: failed('turn_1'),
    readSnapshot: async () => { await gate; return snapshotFor(failed('turn_1')); },
    resumeTurn: async () => completed('turn_2')
  });
  const first = coordinator.run(input());
  await assert.rejects(coordinator.run(input()), error => error.code === 'TURN_CONTINUATION_BUSY');
  open();
  assert.equal((await first).status, 'completed');
  await assert.rejects(coordinator.run(input()), error => error.code === 'TURN_CONTINUATION_CLOSED');
});

test('abort cancels before and during a continuation', async () => {
  const pre = new AbortController();
  pre.abort();
  let resumeCalls = 0;
  const cancelled = await run(failed('turn_1'), async () => { resumeCalls += 1; return completed('turn_2'); },
    { input: { signal: pre.signal } });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.reason, 'aborted');
  assert.equal(resumeCalls, 0);

  const live = new AbortController();
  const during = await run(failed('turn_1'), async () => { resumeCalls += 1; return completed('turn_2'); }, {
    input: { signal: live.signal },
    readSnapshot: async () => { live.abort(); return snapshotFor(failed('turn_1')); }
  });
  assert.equal(during.status, 'cancelled');
  assert.equal(resumeCalls, 0);
});

test('the run deadline bounds the whole sequence', async () => {
  let clockMs = 0;
  const result = await run(failed('turn_1'), async () => failed('turn_2'), {
    options: { deadlineMs: 500, now: () => clockMs },
    readSnapshot: async () => { clockMs += 10000; return snapshotFor(failed('turn_1')); }
  });
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'deadline_expired');
  assert.equal(result.continuations, 1);
});

test('a Retry-After longer than the remaining budget stops instead of waiting', async () => {
  let resumeCalls = 0;
  const result = await run(failed('turn_1'), async () => {
    resumeCalls += 1;
    return failed('turn_2', { code: 'rateLimitExceeded', retryAfterMs: 900000 });
  }, { options: { deadlineMs: 1000, baseDelayMs: 0 } });
  assert.equal(result.reason, 'deadline_expired');
  assert.equal(resumeCalls, 1);
});

test('progress carries metadata only', async () => {
  const events = [];
  const result = await run(failed('turn_1', { code: 'rateLimitExceeded', message: sentinel }), async () => completed('turn_2'), {
    input: { onProgress: event => events.push(event) }
  });
  assert.equal(result.status, 'completed');
  assert.ok(events.length >= 3);
  assert.ok(events.every(event => event.hostIntegrationRequired === true));
  assert.equal(events[0].type, 'turn_observed');
  assert.ok(events.some(event => event.type === 'continuation_started'));
  assert.ok(events.some(event => event.type === 'continuation_completed'));
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes(sentinel));
  assert.ok(!serialized.includes('turn_1') && !serialized.includes('turn_2'));
});

test('a throwing progress reporter cannot change the outcome', async () => {
  const result = await run(failed('turn_1'), async () => completed('turn_2'), {
    input: { onProgress: () => { throw new Error('reporter exploded'); } }
  });
  assert.equal(result.status, 'completed');
});

test('options and inputs are validated', async () => {
  for (const options of [{ maxContinuations: 4 }, { maxContinuations: 0 }, { deadlineMs: 180001 },
    { deadlineMs: 0 }, { baseDelayMs: -1 }, { maxDelayMs: 30001 }, { now: 'later' }]) {
    assert.throws(() => createTurnContinuation(options), TypeError, JSON.stringify(options));
  }
  assert.throws(() => createTurnContinuation({ baseDelayMs: 2000, maxDelayMs: 1000 }), TypeError);
  for (const input of [{}, { threadId: '' }, { threadId: THREAD, initialTurn: completed('a') },
    { threadId: THREAD, initialTurn: completed('a'), resumeTurn: 'nope', readSnapshot: async () => ({}) },
    { threadId: THREAD, initialTurn: completed('a'), resumeTurn: async () => completed('b') },
    { threadId: THREAD, initialTurn: completed('a'), resumeTurn: async () => completed('b'), readSnapshot: async () => ({}), onProgress: 'yes' },
    { threadId: THREAD, initialTurn: completed('a'), resumeTurn: async () => completed('b'), readSnapshot: async () => ({}), signal: {} }]) {
    await assert.rejects(createTurnContinuation({}).run(input), TypeError, JSON.stringify(input));
  }
});

test('a resume that throws stops without a second attempt', async () => {
  let resumeCalls = 0;
  const result = await run(failed('turn_1'), async () => { resumeCalls += 1; throw new Error('turn/start failed'); });
  assert.equal(result.reason, 'resume_unavailable');
  assert.equal(resumeCalls, 1);
});

test('a resume result on another thread or not terminal stops the run', async () => {
  const other = await run(failed('turn_1'), async () => ({ ...completed('turn_2'), threadId: 'thr_other' }));
  assert.equal(other.reason, 'thread_mismatch');
  const notTerminal = await run(failed('turn_1'), async () => ({ threadId: THREAD, turnId: 'turn_2', status: 'inProgress', terminal: true }));
  assert.equal(notTerminal.reason, 'turn_not_terminal');
});
