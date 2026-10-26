'use strict';

// Native turn-continuation adapters. Two supported native surfaces exist in the
// installed builds this project targets:
//
//   * Codex app-server: `thread/resume` then `turn/start` on the same thread,
//     with `turn/completed` as the only terminal signal.
//   * DeepSeek Harness public client Session: `prompt(content, mode, signal,
//     requestId)`, whose documented requestId idempotency deduplicates an
//     identical re-send.
//
// Neither adapter injects keystrokes, drives a UI, replays a command or prompt,
// rolls back files, truncates context or touches client configuration. Policy
// lives in `./turn-continuation`; both refuse when the host cannot attest the
// durable state.

const { randomUUID } = require('node:crypto');
const { createTurnContinuation, classifyContinuationFailure } = require('./turn-continuation');

const DEFAULT_CONTINUATION_TEXT = 'Continue from where the previous turn stopped.';
const MAX_CONTINUATION_TEXT = 500;
const DEFAULT_START_TIMEOUT_MS = 30000;
const MAX_START_TIMEOUT_MS = 300000;

// One lock per native thread or session, shared by every adapter instance in
// this process: two continuations must never race the same conversation.
const conversationLocks = new Map();

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${name}.`);
  return value;
}

function isSignal(value) {
  return record(value) && typeof value.addEventListener === 'function' && typeof value.aborted === 'boolean';
}

function acquireLock(kind, key) {
  const id = `${kind}\u0000${key}`;
  if (conversationLocks.has(id)) {
    const error = new Error(`A turn continuation is already running for this ${kind}.`);
    error.code = 'TURN_CONTINUATION_THREAD_LOCKED';
    throw error;
  }
  const token = Symbol(id);
  conversationLocks.set(id, token);
  return () => { if (conversationLocks.get(id) === token) conversationLocks.delete(id); };
}

function continuationText(options) {
  const text = options.continuationText ?? DEFAULT_CONTINUATION_TEXT;
  if (typeof text !== 'string') throw new TypeError('Invalid continuationText.');
  // One short line: never a concatenated command, never a multi-step script.
  if (text.trim().length === 0 || text.length > MAX_CONTINUATION_TEXT || /[\r\n]/.test(text)) {
    throw new TypeError('Invalid continuationText.');
  }
  return text;
}

function limitsOf(options) {
  const limits = {
    maxContinuations: integer(options.maxContinuations, undefined, 1, 3, 'maxContinuations'),
    deadlineMs: integer(options.deadlineMs, undefined, 1, 180000, 'deadlineMs'),
    baseDelayMs: integer(options.baseDelayMs, undefined, 0, 30000, 'baseDelayMs'),
    maxDelayMs: integer(options.maxDelayMs, undefined, 0, 30000, 'maxDelayMs'),
    now: options.now
  };
  if (limits.now !== undefined && typeof limits.now !== 'function') throw new TypeError('Invalid continuation clock.');
  return limits;
}

function refusal(adapter, reason, extra = {}) {
  return freeze({
    ok: false, status: 'stopped', reason, continuations: 0, lastTurn: null,
    adapter, hostIntegrationRequired: true, ...extra
  });
}

// Normalize a native error record into the shape the classifier reads. No
// message is logged or copied anywhere else.
function failureError(raw) {
  if (!record(raw)) return null;
  return {
    code: raw.codexErrorInfo ?? raw.code ?? raw.errorInfo ?? null,
    message: typeof raw.message === 'string' ? raw.message : '',
    httpStatusCode: Number.isSafeInteger(raw.httpStatusCode) ? raw.httpStatusCode : null,
    retryAfterMs: Number.isSafeInteger(raw.retryAfterMs) ? raw.retryAfterMs : 0
  };
}

function continuationParams(threadId, text) {
  // Only these two fields: no tool output, model, cwd, sandbox, approval or
  // output-schema override, so the continuation reuses the thread's own
  // persisted tools and settings.
  return Object.freeze({ threadId, input: Object.freeze([Object.freeze({ type: 'text', text })]) });
}

// A continuation turn may only start from an attested snapshot of the turn that
// failed. A host that lost or replaced it must not continue at all.
function requireSnapshotContext(context) {
  const failedSnapshotId = context?.failedSnapshotId;
  if (typeof failedSnapshotId !== 'string' || failedSnapshotId.length === 0
    || failedSnapshotId !== context.snapshotId
    || typeof context.failedFingerprint !== 'string' || context.failedFingerprint.length === 0
    || typeof context.failedTurnId !== 'string' || context.failedTurnId.length === 0) {
    const error = new Error('A continuation requires the failed turn\'s attested snapshot.');
    error.code = 'TURN_CONTINUATION_SNAPSHOT_REQUIRED';
    throw error;
  }
  return failedSnapshotId;
}

// ---------------------------------------------------------------------------
// Codex app-server
// ---------------------------------------------------------------------------

function createCodexTurnContinuation(options = {}) {
  if (!record(options)) throw new TypeError('Codex turn continuation requires an options object.');
  const rpc = options.rpc;
  if (!record(rpc) || typeof rpc.call !== 'function') throw new TypeError('Codex turn continuation requires rpc.call(method, params, context).');
  if (typeof options.subscribe !== 'function') throw new TypeError('Codex turn continuation requires subscribe(handler).');
  if (typeof options.readSnapshot !== 'function') throw new TypeError('Codex turn continuation requires readSnapshot(context).');
  if (options.reconcileStart !== undefined && typeof options.reconcileStart !== 'function') throw new TypeError('Invalid reconcileStart.');
  const text = continuationText(options);
  const limits = limitsOf(options);
  const startTimeoutMs = integer(options.startTimeoutMs, DEFAULT_START_TIMEOUT_MS, 1, MAX_START_TIMEOUT_MS, 'startTimeoutMs');

  return Object.freeze({ run, describe });

  function describe() {
    return freeze({
      adapter: 'codex-app-server',
      hostIntegrationRequired: true,
      implementation: 'native',
      requiredHostSeams: ['rpc.call', 'subscribe', 'readSnapshot'],
      optionalHostSeams: ['reconcileStart'],
      startsFirstTurn: false,
      resume: { method: 'thread/resume', params: ['threadId', 'excludeTurns'], sameThread: true },
      continuationTurn: { method: 'turn/start', params: ['threadId', 'input'], sameThread: true },
      terminalSignal: 'turn/completed',
      startTimeoutMs,
      notSupported: [
        'keyboard or UI automation',
        'replaying the original prompt, command or tool output',
        'starting the thread\'s first turn on the host\'s behalf',
        'filesystem rollback, context truncation, quota bypass or cancellation',
        'treating an error notification with willRetry=true as a failed turn',
        'sending a second turn/start while an earlier one is unresolved'
      ]
    });
  }

  async function run(input = {}) {
    if (!record(input)) throw new TypeError('Codex turn continuation requires a run input object.');
    if (typeof input.threadId !== 'string' || input.threadId.length === 0) throw new TypeError('Invalid threadId.');
    if (input.signal !== undefined && !isSignal(input.signal)) throw new TypeError('Invalid continuation signal.');
    if (input.onProgress !== undefined && typeof input.onProgress !== 'function') throw new TypeError('onProgress must be a function.');
    const failed = codexFailedTurn(input.failedTurn, input.threadId);
    if (!failed.ok) return refusal('codex-app-server', failed.reason, { threadId: input.threadId });
    // A terminal cause that this component never continues is refused before
    // any RPC, so nothing is resumed for it.
    const classification = classifyContinuationFailure(failed.turn.error);
    if (classification.classification === 'stop') {
      return refusal('codex-app-server', classification.reason, { threadId: input.threadId });
    }

    const release = acquireLock('thread', input.threadId);
    let channel;
    try {
      // Terminal precondition: the thread ended a turn, so resuming is safe.
      let resumed;
      try {
        resumed = await rpc.call('thread/resume', { threadId: input.threadId, excludeTurns: true }, { signal: input.signal });
      } catch {
        return refusal('codex-app-server', 'thread_resume_failed', { threadId: input.threadId });
      }
      if (!record(resumed) || !record(resumed.thread) || resumed.thread.id !== input.threadId) {
        return refusal('codex-app-server', 'thread_resume_failed', { threadId: input.threadId });
      }
      // Subscribed before any turn/start so a fast turn cannot complete unseen.
      channel = createCodexChannel(options.subscribe);
      const coordinator = createTurnContinuation(limits);
      const result = await coordinator.run({
        threadId: input.threadId,
        initialTurn: failed.turn,
        signal: input.signal,
        onProgress: input.onProgress,
        readSnapshot: options.readSnapshot,
        resumeTurn: context => startContinuationTurn(channel, context)
      });
      return freeze({ ...result, adapter: 'codex-app-server', threadId: input.threadId });
    } finally {
      channel?.dispose();
      release();
    }
  }

  async function startContinuationTurn(channel, context) {
    requireSnapshotContext(context);
    const started = await startTurn(continuationParams(context.threadId, text), context.signal, true);
    if (started.turn) return started.turn;
    return channel.wait(started.turnId, context.threadId);
  }

  // Returns either the terminal turn the ACK already carried, or the id to wait
  // for. A transport-level failure or a missing ACK is ambiguous and is handed
  // to the host's reconcileStart; the same turn/start is only re-sent after the
  // host says it never started.
  async function startTurn(params, signal, mayRetry) {
    let ack;
    try {
      ack = await withTimeout(rpc.call('turn/start', params, { signal }), startTimeoutMs, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error?.rpc === true) throw error; // the server answered: nothing started
      return reconcile(params, signal, mayRetry);
    }
    const turn = record(ack) && record(ack.turn) ? ack.turn : null;
    if (turn && typeof turn.id === 'string' && turn.id.length > 0) {
      if (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'interrupted') {
        return { turn: { threadId: params.threadId, turnId: turn.id, status: turn.status, terminal: true,
          error: turn.status === 'failed' ? failureError(turn.error) : null, nativeRetryExhausted: true } };
      }
      return { turnId: turn.id };
    }
    return reconcile(params, signal, mayRetry);
  }

  async function reconcile(params, signal, mayRetry) {
    if (!options.reconcileStart) throw ambiguous();
    let probe;
    try {
      probe = await options.reconcileStart({ threadId: params.threadId, method: 'turn/start', signal });
    } catch {
      throw ambiguous();
    }
    if (record(probe) && probe.state === 'started' && typeof probe.turnId === 'string' && probe.turnId.length > 0) {
      return { turnId: probe.turnId };
    }
    if (probe === 'not_started' || (record(probe) && probe.state === 'not_started')) {
      if (!mayRetry) throw ambiguous();
      let ack;
      try {
        ack = await withTimeout(rpc.call('turn/start', params, { signal }), startTimeoutMs, signal);
      } catch {
        throw ambiguous();
      }
      const turn = record(ack) && record(ack.turn) ? ack.turn : null;
      if (!turn || typeof turn.id !== 'string' || turn.id.length === 0) throw ambiguous();
      if (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'interrupted') {
        return { turn: { threadId: params.threadId, turnId: turn.id, status: turn.status, terminal: true,
          error: turn.status === 'failed' ? failureError(turn.error) : null, nativeRetryExhausted: true } };
      }
      return { turnId: turn.id };
    }
    throw ambiguous();
  }
}

function ambiguous() {
  const error = new Error('turn/start outcome is unknown.');
  error.code = 'TURN_CONTINUATION_AMBIGUOUS_START';
  return error;
}

const START_TIMEOUT = Object.assign(new Error('turn/start acknowledgement timed out.'), { code: 'TURN_CONTINUATION_START_TIMEOUT' });

function withTimeout(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      settle(value);
    };
    const onAbort = () => done(reject, Object.assign(new Error('aborted'), { code: 'TURN_CONTINUATION_ABORTED' }));
    const timer = setTimeout(() => done(reject, START_TIMEOUT), timeoutMs);
    // Referenced on purpose: an unanswered turn/start is pending work owned by
    // this run. Unref'ing it let a host whose rpc.call holds no socket or timer
    // drain the loop and exit before the timeout fired, so the ambiguous
    // acknowledgement was never reported as ambiguous and the caller silently
    // got nothing.
    signal?.addEventListener?.('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => done(resolve, value), error => done(reject, error));
  });
}

// Only a `turn/completed` record with `status: "failed"` qualifies. An
// app-server error notification is not proof that the turn ended, and one with
// `willRetry: true` explicitly says the native loop still owns the turn.
function codexFailedTurn(raw, threadId) {
  if (!record(raw)) return { ok: false, reason: 'terminal_turn_required' };
  if (raw.willRetry === true) return { ok: false, reason: 'native_retry_pending' };
  if (raw.willRetry === false) return { ok: false, reason: 'terminal_turn_required' };
  if (typeof raw.threadId === 'string' && raw.threadId !== threadId) return { ok: false, reason: 'thread_mismatch' };
  const turn = record(raw.turn) ? raw.turn : raw;
  const turnId = typeof turn.id === 'string' ? turn.id : (typeof raw.turnId === 'string' ? raw.turnId : '');
  if (turnId.length === 0) return { ok: false, reason: 'terminal_turn_required' };
  if (turn.status !== 'failed') return { ok: false, reason: turn.status === 'interrupted' ? 'interrupted' : 'terminal_turn_required' };
  return {
    ok: true,
    turn: {
      threadId, turnId, status: 'failed', terminal: true,
      // A durably completed failed turn is already past the native retry loop;
      // no app-server notification can still add an attempt to it.
      nativeRetryExhausted: true,
      error: failureError(turn.error)
    }
  };
}

function createCodexChannel(subscribe) {
  const turns = new Map();
  const waiters = new Map();
  const listener = notification => {
    if (!record(notification) || notification.method !== 'turn/completed') return;
    const params = notification.params;
    if (!record(params) || typeof params.threadId !== 'string' || !record(params.turn)) return;
    const turn = params.turn;
    if (typeof turn.id !== 'string' || turn.id.length === 0) return;
    if (turn.status !== 'completed' && turn.status !== 'failed' && turn.status !== 'interrupted') return;
    if (turns.has(turn.id)) return; // duplicate deliveries never resolve twice
    const normalized = freeze({
      threadId: params.threadId, turnId: turn.id, status: turn.status, terminal: true,
      error: turn.status === 'failed' ? failureError(turn.error) : null,
      nativeRetryExhausted: true
    });
    turns.set(turn.id, normalized);
    const waiting = waiters.get(turn.id);
    if (waiting) {
      waiters.delete(turn.id);
      for (const resolve of waiting) resolve(normalized);
    }
  };
  const disposeSubscription = subscribe(listener);
  return {
    wait(turnId, threadId) {
      const done = turns.get(turnId);
      if (done) {
        turns.delete(turnId);
        return Promise.resolve(done.threadId === threadId ? done : null);
      }
      return new Promise(resolve => {
        const list = waiters.get(turnId) ?? [];
        list.push(resolve);
        waiters.set(turnId, list);
      });
    },
    dispose() {
      turns.clear();
      waiters.clear();
      if (typeof disposeSubscription === 'function') disposeSubscription();
    }
  };
}

// ---------------------------------------------------------------------------
// DeepSeek Harness public client Session
// ---------------------------------------------------------------------------

function createHarnessTurnContinuation(options = {}) {
  if (!record(options)) throw new TypeError('Harness turn continuation requires an options object.');
  const session = options.session;
  if (!record(session) || typeof session.prompt !== 'function') {
    throw new TypeError('Harness turn continuation requires session.prompt(content, mode, signal, requestId).');
  }
  if (typeof options.readSnapshot !== 'function') throw new TypeError('Harness turn continuation requires readSnapshot(context).');
  // The installed public client contract has no turn-level continuation call and
  // no durable turn identity. Rather than inventing one from the running bit or
  // a projection snapshot, require the host seam and say so.
  if (typeof options.awaitTurn !== 'function') {
    const error = new TypeError('Harness turn continuation requires awaitTurn(context): the installed public client contract exposes no supported terminal-turn seam.');
    error.code = 'HARNESS_SEAM_MISSING';
    throw error;
  }
  const text = continuationText(options);
  const limits = limitsOf(options);

  return Object.freeze({ run, describe });

  function describe() {
    return freeze({
      adapter: 'deepseek-harness',
      hostIntegrationRequired: true,
      implementation: 'native',
      publicApi: ['session.prompt(content, mode, signal, requestId)'],
      requiredHostSeams: ['readSnapshot', 'awaitTurn'],
      startsFirstTurn: false,
      continuationTurn: { mode: 'queue', sameSession: true, requestId: 'stable per continuation attempt' },
      nativeRetry: '@deepseek-ai/dsh-llm-retry retries inside the same open turn; a terminal failed turn is past that loop.',
      missingPublicSeam: 'The public client contract exposes no turn-level retry/continue call and no durable turn identity; awaitTurn and readSnapshot must come from the host.',
      notSupported: [
        'keyboard or UI automation',
        'replaying the original prompt, command or tool output',
        'starting the session\'s first turn on the host\'s behalf',
        'filesystem rollback, context truncation, quota bypass or cancellation',
        'retrying a prompt under a fresh requestId after an ambiguous send'
      ]
    });
  }

  async function run(input = {}) {
    if (!record(input)) throw new TypeError('Harness turn continuation requires a run input object.');
    if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) throw new TypeError('Invalid sessionId.');
    if (input.signal !== undefined && !isSignal(input.signal)) throw new TypeError('Invalid continuation signal.');
    if (input.onProgress !== undefined && typeof input.onProgress !== 'function') throw new TypeError('onProgress must be a function.');
    const failed = harnessFailedTurn(input.failedTurn, input.sessionId);
    if (!failed.ok) return refusal('deepseek-harness', failed.reason, { sessionId: input.sessionId });
    const classification = classifyContinuationFailure(failed.turn.error);
    if (classification.classification === 'stop') {
      return refusal('deepseek-harness', classification.reason, { sessionId: input.sessionId });
    }

    const release = acquireLock('session', input.sessionId);
    try {
      // requestIds must be unique per run, or a later run's prompt would
      // collapse onto an earlier acceptance and never start a turn.
      const runId = randomUUID();
      const coordinator = createTurnContinuation(limits);
      const result = await coordinator.run({
        threadId: input.sessionId,
        initialTurn: failed.turn,
        signal: input.signal,
        onProgress: input.onProgress,
        readSnapshot: options.readSnapshot,
        resumeTurn: context => continueSession(runId, context)
      });
      return freeze({ ...result, adapter: 'deepseek-harness', sessionId: input.sessionId });
    } finally {
      release();
    }
  }

  async function continueSession(runId, context) {
    requireSnapshotContext(context);
    const requestId = `${context.threadId}\u0000rhb-continuation\u0000${runId}\u0000${context.continuationIndex}`;
    const content = Object.freeze([Object.freeze({ type: 'text', text })]);
    let result;
    try {
      result = await session.prompt(content, 'queue', context.signal, requestId);
    } catch (error) {
      if (context.signal?.aborted) throw error;
      // One identical re-send under the same requestId: the documented rule
      // returns the original acceptance instead of inserting another message.
      result = await session.prompt(content, 'queue', context.signal, requestId);
    }
    if (result && result.ok === false) {
      const error = new Error('Harness prompt was rejected.');
      error.code = result.error?.code ?? 'TURN_CONTINUATION_PROMPT_REJECTED';
      throw error;
    }
    const terminal = await options.awaitTurn({
      sessionId: context.threadId,
      requestId,
      continuationIndex: context.continuationIndex,
      signal: context.signal
    });
    const normalized = harnessTerminalTurn(terminal, context.threadId);
    if (!normalized.ok) {
      const error = new Error('Harness turn did not report a terminal result.');
      error.code = 'TURN_CONTINUATION_NOT_TERMINAL';
      throw error;
    }
    return normalized.turn;
  }
}

function harnessFailedTurn(raw, sessionId) {
  if (!record(raw)) return { ok: false, reason: 'terminal_turn_required' };
  if (raw.nativeRetryPending === true) return { ok: false, reason: 'native_retry_pending' };
  if (typeof raw.sessionId === 'string' && raw.sessionId !== sessionId) return { ok: false, reason: 'thread_mismatch' };
  if (typeof raw.turnId !== 'string' || raw.turnId.length === 0) return { ok: false, reason: 'terminal_turn_required' };
  if (raw.status !== 'failed') return { ok: false, reason: raw.status === 'interrupted' ? 'interrupted' : 'terminal_turn_required' };
  // Harness provider retry re-runs the failed step inside the same open turn,
  // so a failed turn is only continuable once the host states that loop ended.
  if (raw.nativeRetryExhausted !== true) return { ok: false, reason: 'native_retry_pending' };
  return {
    ok: true,
    turn: { threadId: sessionId, turnId: raw.turnId, status: 'failed', terminal: true,
      nativeRetryExhausted: true, error: failureError(raw.error) }
  };
}

function harnessTerminalTurn(raw, sessionId) {
  if (!record(raw)) return { ok: false };
  if (typeof raw.turnId !== 'string' || raw.turnId.length === 0) return { ok: false };
  if (raw.status !== 'completed' && raw.status !== 'failed' && raw.status !== 'interrupted') return { ok: false };
  return {
    ok: true,
    turn: {
      threadId: sessionId, turnId: raw.turnId, status: raw.status, terminal: true,
      error: raw.status === 'failed' ? failureError(raw.error) : null,
      nativeRetryExhausted: true
    }
  };
}

module.exports = {
  createCodexTurnContinuation,
  createHarnessTurnContinuation,
  DEFAULT_CONTINUATION_TEXT
};
