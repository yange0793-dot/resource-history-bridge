'use strict';

// Transport-neutral turn continuation. This module owns policy only: it never
// sends a request, never reads a session log and never touches client state.
// The host supplies `readSnapshot` (durable attestation), `resumeTurn` (start a
// continuation turn on the same thread) and optionally `sendTurn` (start the
// first turn itself). Everything else here is budget, classification and
// refusal.

const RESOURCE_MESSAGE = 'The requested item was created under a different Azure OpenAI resource.';

// Only a turn that already ended can be continued. `inProgress` is a live turn,
// not a failure, and must never be treated as one.
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted']);

// Exact Codex app-server `CodexErrorInfo` variants that are transient by
// themselves: each one ends a turn only after the native retry loop is done
// with it. Anything not listed here stops.
const TRANSIENT_CODES = new Set([
  'rateLimitExceeded',
  'serverOverloaded',
  'internalServerError',
  'flexUnavailable',
  'httpConnectionFailed',
  'responseStreamConnectionFailed',
  'responseStreamDisconnected',
  'responseTooManyFailedAttempts'
]);

// Explicit terminal causes. Missing from this table and from the transient set
// means "unknown", which stops.
const STOP_CODES = new Map([
  ['contextWindowExceeded', 'context_exhausted'],
  ['context_length_exceeded', 'context_exhausted'],
  ['sessionBudgetExceeded', 'budget_exhausted'],
  ['usageLimitExceeded', 'quota_exhausted'],
  ['insufficient_quota', 'quota_exhausted'],
  ['unauthorized', 'authentication'],
  ['invalid_api_key', 'authentication'],
  ['permission_denied', 'authentication'],
  ['badRequest', 'invalid_request'],
  ['invalid_request_error', 'invalid_request'],
  ['invalid_encrypted_content', 'invalid_request'],
  ['cyberPolicy', 'policy_blocked'],
  ['misalignmentPolicyViolation', 'policy_blocked'],
  ['tooManyDenials', 'policy_blocked'],
  ['sandboxError', 'sandbox_error'],
  ['activeTurnNotSteerable', 'unsupported_state'],
  ['threadRollbackFailed', 'unsupported_state']
]);

const STOP_STATUSES = new Map([
  [400, 'invalid_request'],
  [401, 'authentication'],
  [402, 'quota_exhausted'],
  [403, 'authentication'],
  [404, 'not_found'],
  [409, 'conflict'],
  [413, 'context_exhausted'],
  [422, 'invalid_request']
]);

const DEFAULT_MAX_CONTINUATIONS = 3;
const MAX_CONTINUATIONS = 3;
const DEFAULT_DEADLINE_MS = 180000;
const MAX_DEADLINE_MS = 180000;
const DEFAULT_BASE_DELAY_MS = 250;
const MAX_BASE_DELAY_MS = 30000;
const DEFAULT_MAX_DELAY_MS = 2000;
const MAX_DELAY_MS = 30000;

const ABORTED = Symbol('aborted');

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${name}.`);
  return value;
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`Invalid ${name}.`);
  return value;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function isSignal(value) {
  return record(value) && typeof value.addEventListener === 'function' && typeof value.aborted === 'boolean';
}

function normalizeCode(value) {
  if (typeof value === 'string' && value.length > 0) return { code: value, httpStatusCode: null };
  if (record(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      const inner = value[keys[0]];
      const status = record(inner) && Number.isSafeInteger(inner.httpStatusCode) ? inner.httpStatusCode : null;
      return { code: keys[0], httpStatusCode: status };
    }
  }
  return { code: null, httpStatusCode: null };
}

// Classify one failed terminal turn. Callers pass a normalized view (code plus
// optional status, message and Retry-After); nothing here inspects a prompt,
// a tool payload or a session log.
function classifyContinuationFailure(error) {
  if (!record(error)) return Object.freeze({ classification: 'stop', reason: 'unknown_failure', code: null, retryAfterMs: 0 });
  const normalized = normalizeCode(error.code ?? error.codexErrorInfo ?? null);
  const code = normalized.code;
  const status = Number.isSafeInteger(error.httpStatusCode) ? error.httpStatusCode : normalized.httpStatusCode;
  const message = typeof error.message === 'string' ? error.message : '';
  const retryAfterMs = Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : 0;
  const transient = reason => Object.freeze({ classification: 'transient', reason, code, retryAfterMs });
  const stop = reason => Object.freeze({ classification: 'stop', reason, code, retryAfterMs: 0 });
  // The one exact resource error this project already recognizes. It may be
  // continued only because the snapshot gate below still has to pass.
  if (code === 'resourceMismatch' || message.includes(RESOURCE_MESSAGE)) {
    return Object.freeze({ classification: 'resource', reason: 'resource_mismatch', code, retryAfterMs });
  }
  if (code !== null && STOP_CODES.has(code)) return stop(STOP_CODES.get(code));
  // A definitive 4xx is the server's own answer, so it stops even when the
  // alongside code names a connection problem.
  if (status !== null && STOP_STATUSES.has(status)) return stop(STOP_STATUSES.get(status));
  if (code !== null && TRANSIENT_CODES.has(code)) return transient('transient_upstream');
  if (status !== null) {
    if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return transient('transient_upstream');
  }
  return stop('unknown_failure');
}

// Opaque, deterministic identity of one failed turn. Hosts must compute the
// same value for `readSnapshot().failedFingerprint`; no secret material is
// involved, only the thread id, turn id and error code the host already holds.
function turnFingerprint(turn) {
  const source = record(turn) ? turn : {};
  const normalized = normalizeCode(source.error?.code ?? source.code ?? null);
  return ['rhb-turn-v1', String(source.threadId ?? ''), String(source.turnId ?? ''),
    String(source.status ?? 'failed'), normalized.code ?? ''].join('\u0000');
}

function normalizeTurn(value, expectedThreadId) {
  if (!record(value)) return { ok: false, reason: 'invalid_turn_result' };
  const threadId = typeof value.threadId === 'string' ? value.threadId : '';
  const turnId = typeof value.turnId === 'string' ? value.turnId : '';
  if (threadId.length === 0 || turnId.length === 0) return { ok: false, reason: 'invalid_turn_result' };
  if (threadId !== expectedThreadId) return { ok: false, reason: 'thread_mismatch' };
  if (!TERMINAL_STATUSES.has(value.status)) return { ok: false, reason: 'turn_not_terminal' };
  if (value.terminal !== true) return { ok: false, reason: 'turn_not_terminal' };
  // `willRetry` from an app-server error notification means the native loop is
  // still going to run: never start our own turn on top of it.
  if (value.nativeRetryPending === true) return { ok: false, reason: 'native_retry_pending' };
  if (value.nativeRetryExhausted === false) return { ok: false, reason: 'native_retry_pending' };
  const error = value.error === undefined ? null : value.error;
  if (error !== null && !record(error)) return { ok: false, reason: 'invalid_turn_result' };
  const turn = {
    threadId, turnId, status: value.status, terminal: true,
    error: error === null ? null : structuredClone(error),
    // `false` was rejected above, so this is either an explicit `true` or an
    // unattested `null`: a terminal turn that never said anything about its
    // native retry loop.
    nativeRetryExhausted: value.nativeRetryExhausted === true
  };
  turn.fingerprint = typeof value.fingerprint === 'string' && value.fingerprint.length > 0
    ? value.fingerprint : turnFingerprint(turn);
  return { ok: true, turn: freeze(turn) };
}

// Every field is required to have the exact safe value. A host that cannot
// prove one of them must not report it at all: missing or non-boolean values
// stop the run instead of being read as "fine".
function normalizeSnapshot(value, turn) {
  if (!record(value)) return { ok: false, reason: 'snapshot_unattested' };
  const booleans = [
    ['durableCommitted', true, 'snapshot_not_committed'],
    ['turnActive', false, 'turn_active'],
    ['pendingApproval', false, 'pending_approval'],
    ['pendingTools', false, 'pending_tools'],
    ['startedToolCallsSettled', true, 'unsettled_tool_calls'],
    ['ambiguousSideEffects', false, 'ambiguous_side_effects'],
    ['nativeRetryPending', false, 'native_retry_pending']
  ];
  for (const [key, expected, reason] of booleans) {
    if (typeof value[key] !== 'boolean') return { ok: false, reason: 'snapshot_unattested' };
    if (value[key] !== expected) return { ok: false, reason };
  }
  if (typeof value.snapshotId !== 'string' || value.snapshotId.length === 0) return { ok: false, reason: 'snapshot_unattested' };
  if (typeof value.failedTurnId !== 'string' || value.failedTurnId.length === 0) return { ok: false, reason: 'snapshot_unattested' };
  if (typeof value.failedFingerprint !== 'string' || value.failedFingerprint.length === 0) return { ok: false, reason: 'snapshot_unattested' };
  if (value.failedTurnId !== turn.turnId) return { ok: false, reason: 'snapshot_turn_mismatch' };
  if (value.failedFingerprint !== turn.fingerprint) return { ok: false, reason: 'snapshot_fingerprint_mismatch' };
  return { ok: true, snapshot: { snapshotId: value.snapshotId, failedTurnId: value.failedTurnId, failedFingerprint: value.failedFingerprint } };
}

function createTurnContinuation(options = {}) {
  if (!record(options)) throw new TypeError('Turn continuation requires an options object.');
  const maxContinuations = integer(options.maxContinuations, DEFAULT_MAX_CONTINUATIONS, 1, MAX_CONTINUATIONS, 'maxContinuations');
  const deadlineMs = integer(options.deadlineMs, DEFAULT_DEADLINE_MS, 1, MAX_DEADLINE_MS, 'deadlineMs');
  const baseDelayMs = integer(options.baseDelayMs, DEFAULT_BASE_DELAY_MS, 0, MAX_BASE_DELAY_MS, 'baseDelayMs');
  const maxDelayMs = integer(options.maxDelayMs, DEFAULT_MAX_DELAY_MS, 0, MAX_DELAY_MS, 'maxDelayMs');
  if (maxDelayMs < baseDelayMs) throw new TypeError('Invalid maxDelayMs.');
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') throw new TypeError('Invalid continuation clock.');

  let running = false;
  let closed = false;

  return Object.freeze({ run });

  async function run(input = {}) {
    if (running) {
      const error = new Error('Turn continuation is already running.');
      error.code = 'TURN_CONTINUATION_BUSY';
      throw error;
    }
    if (closed) {
      const error = new Error('Turn continuation has already completed.');
      error.code = 'TURN_CONTINUATION_CLOSED';
      throw error;
    }
    if (!record(input)) throw new TypeError('Turn continuation requires a run input object.');
    const threadId = nonEmptyString(input.threadId, 'threadId');
    const hasInitial = input.initialTurn !== undefined;
    const hasSend = input.sendTurn !== undefined;
    if (hasInitial === hasSend) throw new TypeError('Provide exactly one of initialTurn or sendTurn.');
    if (hasSend && typeof input.sendTurn !== 'function') throw new TypeError('sendTurn must be a function.');
    if (typeof input.resumeTurn !== 'function') throw new TypeError('resumeTurn must be a function.');
    if (typeof input.readSnapshot !== 'function') throw new TypeError('readSnapshot must be a function.');
    if (input.signal !== undefined && !isSignal(input.signal)) throw new TypeError('Invalid continuation signal.');
    if (input.onProgress !== undefined && typeof input.onProgress !== 'function') throw new TypeError('onProgress must be a function.');

    const startedAtMs = clock(now());
    const deadlineAtMs = startedAtMs + deadlineMs;
    // A run is single-use: it owns exactly one terminal outcome.
    running = true;
    closed = true;
    const progress = input.onProgress;
    const controller = new AbortController();
    let deadlineHit = false;
    // Referenced on purpose, for the same reason as the backoff timer: while a
    // run is in flight the run itself is the pending work. Unref'ing this let a
    // host whose resumeTurn/readSnapshot holds no socket or timer drain the
    // event loop and exit before the deadline could abort, so the caller's
    // promise never settled and nothing was ever reported.
    const timer = setTimeout(() => {
      deadlineHit = true;
      controller.abort();
    }, deadlineMs);
    const external = input.signal;
    const forwardAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', forwardAbort, { once: true });
    }
    const signal = controller.signal;
    // snapshotId -> failed-turn fingerprint. A snapshot may authorize exactly
    // one continuation; reusing it means the native state did not move forward,
    // so the run ends instead of spending the rest of the budget.
    const consumedSnapshots = new Map();
    let lastAttemptedFingerprint;
    let continuations = 0;
    let turn = null;

    const emit = event => {
      if (!progress) return;
      try { progress(freeze({ hostIntegrationRequired: true, maxContinuations, deadlineAtMs, ...event })); }
      catch { /* progress is metadata only; a broken reporter must not change the outcome */ }
    };

    const finish = (status, reason, extra = {}) => freeze({
      ok: status === 'completed',
      status,
      reason,
      continuations,
      lastTurn: turn,
      hostIntegrationRequired: true,
      deadlineAtMs,
      ...extra
    });

    const stoppedBySignal = () => (deadlineHit || clock(now()) >= deadlineAtMs
      ? finish('stopped', 'deadline_expired')
      : finish('cancelled', 'aborted'));

    const continuationDelay = (attempt, retryAfterMs) => Math.max(
      Math.min(baseDelayMs * 2 ** Math.min(attempt, 16), maxDelayMs),
      retryAfterMs
    );

    try {
      let accepted;
      if (hasInitial) {
        accepted = normalizeTurn(input.initialTurn, threadId);
        if (!accepted.ok) return finish('stopped', accepted.reason);
        turn = accepted.turn;
      } else {
        let raw;
        try {
          raw = await invoke(input.sendTurn, { threadId, signal }, signal);
        } catch (error) {
          return error === ABORTED ? stoppedBySignal() : finish('stopped', 'send_turn_failed');
        }
        accepted = normalizeTurn(raw, threadId);
        if (!accepted.ok) return finish('stopped', accepted.reason);
        turn = accepted.turn;
      }
      emit({ type: 'turn_observed', status: turn.status, code: classifyContinuationFailure(turn.error).code });

      for (;;) {
        if (signal.aborted) return stoppedBySignal();
        if (turn.status === 'completed') return finish('completed', 'turn_completed');
        if (turn.status === 'interrupted') return finish('stopped', 'interrupted');
        const failure = classifyContinuationFailure(turn.error);
        if (failure.classification === 'stop') return finish('stopped', failure.reason);
        if (continuations >= maxContinuations) return finish('exhausted', 'continuation_budget_exhausted');
        if (clock(now()) >= deadlineAtMs || deadlineHit) return finish('stopped', 'deadline_expired');
        if (lastAttemptedFingerprint !== undefined && turn.fingerprint === lastAttemptedFingerprint) {
          return finish('stopped', 'failed_turn_already_continued');
        }

        let raw;
        try {
          raw = await invoke(input.readSnapshot, {
            threadId, failedTurnId: turn.turnId, failedFingerprint: turn.fingerprint, signal
          }, signal);
        } catch (error) {
          return error === ABORTED ? stoppedBySignal() : finish('stopped', 'snapshot_unavailable');
        }
        const attested = normalizeSnapshot(raw, turn);
        if (!attested.ok) return finish('stopped', attested.reason);
        const snapshotId = attested.snapshot.snapshotId;
        // A continuation is only ever started against a fresh, attested
        // snapshot of this exact failed turn.
        if (consumedSnapshots.has(snapshotId)) {
          const previous = consumedSnapshots.get(snapshotId);
          return finish('stopped', previous === turn.fingerprint ? 'snapshot_reused' : 'snapshot_fingerprint_mismatch');
        }
        if (attested.snapshot.failedFingerprint !== turn.fingerprint || attested.snapshot.failedTurnId !== turn.turnId) {
          return finish('stopped', 'snapshot_fingerprint_mismatch');
        }

        continuations += 1;
        consumedSnapshots.set(snapshotId, turn.fingerprint);
        lastAttemptedFingerprint = turn.fingerprint;
        const continuationIndex = continuations;
        emit({ type: 'continuation_started', continuationIndex, classification: failure.classification, code: failure.code });

        try {
          raw = await invoke(input.resumeTurn, {
            threadId,
            failedTurnId: turn.turnId,
            failedFingerprint: turn.fingerprint,
            // Both names carry the same value so a host written against either
            // spelling cannot silently drop the attestation it continues from.
            snapshotId,
            failedSnapshotId: snapshotId,
            continuationIndex,
            signal
          }, signal);
        } catch (error) {
          if (error === ABORTED) return stoppedBySignal();
          const reason = error?.code === 'TURN_CONTINUATION_SNAPSHOT_REQUIRED'
            ? 'snapshot_required' : 'resume_unavailable';
          emit({ type: 'continuation_stopped', continuationIndex, reason });
          return finish('stopped', reason);
        }
        const next = normalizeTurn(raw, threadId);
        if (!next.ok) {
          emit({ type: 'continuation_stopped', continuationIndex, reason: next.reason });
          return finish('stopped', next.reason);
        }
        turn = next.turn;
        if (turn.status === 'completed') {
          emit({ type: 'continuation_completed', continuationIndex });
          return finish('completed', 'turn_completed');
        }
        emit({ type: 'continuation_failed', continuationIndex, status: turn.status,
          code: classifyContinuationFailure(turn.error).code });
        // Back off before another continuation. A host-provided Retry-After is
        // honoured as a floor and never shortened.
        if (continuations < maxContinuations) {
          const wait = continuationDelay(continuations - 1, classifyContinuationFailure(turn.error).retryAfterMs);
          if (wait > 0) {
            if (deadlineAtMs - clock(now()) <= wait) return finish('stopped', 'deadline_expired');
            const slept = await sleep(wait, signal);
            if (slept !== true) return stoppedBySignal();
          }
        }
      }
    } finally {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', forwardAbort);
      running = false;
    }
  }
}

function clock(value) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new TypeError('Invalid continuation clock.');
  return Math.floor(value);
}

function invoke(fn, argument, signal) {
  if (signal.aborted) return Promise.reject(ABORTED);
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (settle, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      settle(value);
    };
    const onAbort = () => done(reject, ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => fn(argument)).then(
      value => done(resolve, value),
      error => done(reject, error)
    );
  });
}

function sleep(delayMs, signal) {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    // A backoff wait is real pending work: leaving this timer referenced keeps
    // the host process alive until the run resumes or aborts. Unref'ing it made
    // Node treat the event loop as drained and cancel the pending run.
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

module.exports = {
  createTurnContinuation,
  classifyContinuationFailure,
  turnFingerprint,
  RESOURCE_MESSAGE
};
