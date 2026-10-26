'use strict';

const { TextDecoder, isDeepStrictEqual } = require('node:util');
const { validateAgentRouterUpstream, isAgentRouterUpstream } = require('./agentrouter');
const { normalizeRecoveryOptions, createRecoveryState, classifyRecoveryFailure, decideRecovery, decideResourceRecovery, reserveRecoveryAttempt, validateUnprojectedHistory, requestsLegacyBudget } = require('./recovery');
const { projectResponsesHistory } = require('./history');
const { projectEncryptedReasoning } = require('./encrypted-reasoning');

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${name}.`);
  return value;
}
function clock(value) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new TypeError('Invalid recovery clock.');
  return value;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// The session owns request copies and reservations, not transport. An accepted
// decision consumes its budget immediately, even if the host never sends it.
function createRecoverySession(options = {}) {
  if (!record(options) || !record(options.body)) throw new TypeError('Recovery requires a JSON request object.');
  const upstream = validateAgentRouterUpstream(options.upstream).href;
  const official = isAgentRouterUpstream(upstream);
  const endpoint = options.endpoint ?? 'responses';
  const historyMode = options.historyMode ?? 'auto';
  const historyStrategy = options.historyStrategy ?? 'on-error';
  if (!['auto', 'minimal', 'codex', 'harness'].includes(historyMode)) throw new TypeError('Unsupported history mode.');
  if (!['on-error', 'portable'].includes(historyStrategy)) throw new TypeError('Unsupported history strategy.');
  if (typeof endpoint !== 'string') throw new TypeError('Invalid recovery endpoint.');
  for (const key of ['converted', 'automaticRecovery', 'generic400Projection', 'transparentRecovery']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new TypeError(`Invalid ${key}.`);
  }
  if (options.rawBody !== undefined && !Buffer.isBuffer(options.rawBody)) throw new TypeError('rawBody must be a Buffer.');
  const bodyCopy = structuredClone(options.body);
  let serializedBody;
  try { serializedBody = JSON.stringify(bodyCopy); } catch { throw new TypeError('Recovery requires a JSON request object.'); }
  if (!isDeepStrictEqual(JSON.parse(serializedBody), bodyCopy)) throw new TypeError('Recovery requires a JSON request object.');
  const initialBytes = options.rawBody === undefined ? Buffer.from(serializedBody) : Buffer.from(options.rawBody);
  let parsedBytes;
  try { parsedBytes = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(initialBytes)); }
  catch { throw new TypeError('rawBody must contain the same valid JSON request object.'); }
  if (!isDeepStrictEqual(parsedBytes, bodyCopy)) throw new TypeError('rawBody must contain the same JSON request object as body.');
  const converted = options.converted === true;
  const automaticRecovery = official && options.automaticRecovery === true;
  const projectionEndpoint = endpoint === 'responses' || endpoint === 'messages' && converted;
  const nativeResponses = endpoint === 'responses' && !converted;
  // Transparent recovery is the default for the automatic history modes that
  // already validate complete inline history. Explicit false keeps the older
  // resource-only behavior; explicit true can opt a minimal caller in. Converted
  // Messages stay single-attempt: Claude Code already retries on its side and a
  // second bridge-level loop must not stack on top of it.
  const transparentRecovery = official && nativeResponses
    && (options.transparentRecovery ?? (historyMode !== 'minimal' && !requestsLegacyBudget(options)));
  const recoveryActive = transparentRecovery || automaticRecovery;
  const transparentOnly = transparentRecovery && !automaticRecovery;
  const generic400Projection = official && options.generic400Projection === true;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  if (typeof now !== 'function' || typeof random !== 'function') throw new TypeError('Invalid injected recovery dependencies.');
  const policy = recoveryActive ? normalizeRecoveryOptions(options.recoveryPolicy ?? {
    totalAttempts: options.totalAttempts,
    transientAttempts: options.transientAttempts,
    resourceAttempts: options.resourceAttempts,
    deadlineMs: options.timeoutMs,
    baseDelayMs: options.retryDelayMs,
    maxDelayMs: options.maxRetryDelayMs,
    jitterRatio: options.retryJitterRatio
  }) : null;
  const timeoutMs = recoveryActive ? policy.deadlineMs : integer(options.timeoutMs, 180000, 1, 1800000, 'timeoutMs');
  const resourceAttempts = recoveryActive ? policy.resourceAttempts : integer(options.resourceAttempts, 10, 1, 100, 'resourceAttempts');
  const retryDelayMs = recoveryActive ? policy.baseDelayMs : integer(options.retryDelayMs, 1000, 0, 60000, 'retryDelayMs');
  const startedAtMs = clock(now());
  if (startedAtMs + timeoutMs > Number.MAX_SAFE_INTEGER) throw new TypeError('Invalid recovery deadline.');
  let state = recoveryActive ? createRecoveryState(policy, startedAtMs)
    : Object.freeze({ attempt: 1, encryptedRetries: 0, startedAtMs, deadlineAtMs: startedAtMs + timeoutMs, lastNowMs: startedAtMs });
  let body = bodyCopy;
  let rawBody = initialBytes;
  let projectedOnce = false, lossy = false, terminalReason, initialProjection, projectionSkippedReason = null;
  const observed = new WeakSet();

  const stateCopy = () => freeze(structuredClone(state));
  const recoveryHeaders = () => Object.freeze(lossy ? { 'x-rhb-recovery': 'encrypted-reasoning-dropped' } : {});
  const applyBody = projected => {
    body = projected.body;
    rawBody = Buffer.from(JSON.stringify(body));
  };
  const applyProjection = projected => { applyBody(projected); projectedOnce = true; };
  if (official && projectionEndpoint && historyStrategy === 'portable') {
    initialProjection = projectResponsesHistory(body, { mode: historyMode });
    if (initialProjection.ok) applyProjection(initialProjection);
  }
  function current() {
    return { body: structuredClone(body), rawBody: Buffer.from(rawBody), attempt: state.attempt,
      deadlineAtMs: state.deadlineAtMs, lossy, state: stateCopy(), recoveryHeaders: recoveryHeaders(),
      ...(initialProjection ? { projection: structuredClone(initialProjection) } : {}) };
  }
  function result(decision, projection, projectionError) {
    return { ...decision, nextState: stateCopy(), body: structuredClone(body), rawBody: Buffer.from(rawBody), lossy,
      projection: projection ? structuredClone(projection) : null,
      projectionError: projectionError ? structuredClone(projectionError) : null,
      projectionSkipped: projectionSkippedReason === null ? null : { reason: projectionSkippedReason },
      recoveryHeaders: recoveryHeaders() };
  }
  function stopped(reason, classified = {}) {
    return result({ ...classified, classification: classified.classification ?? 'terminal', retry: false, reason, delayMs: 0,
      projectHistory: false, projectEncryptedReasoning: false, generic400ProjectionCandidate: false, projectionCandidate: null });
  }
  function decide(failure = {}) {
    if (!record(failure)) throw new TypeError('Invalid recovery failure.');
    if (terminalReason) return stopped(terminalReason);
    // Classify against the constructor's fixed destination, never a declaration
    // from a failed response, body, provider header or caller-owned URL object.
    const fixedFailure = { ...failure, upstream };
    const classified = classifyRecoveryFailure(fixedFailure);
    if (classified.reason === 'cancelled') { terminalReason = 'cancelled'; return stopped(terminalReason); }
    if (!official) { terminalReason = 'unsupported_upstream'; return stopped(terminalReason); }
    if (!projectionEndpoint) { terminalReason = 'projection_endpoint'; return stopped(terminalReason); }
    const nowMs = Math.max(clock(now()), state.startedAtMs, state.lastNowMs);
    if (nowMs >= state.deadlineAtMs) { terminalReason = 'deadline_expired'; return stopped(terminalReason); }
    // Hosts may reuse a mutable failure object only with the attempted session
    // number. Without it, each completed attempt needs a distinct snapshot.
    if (failure.attempt !== undefined) {
      if (!Number.isSafeInteger(failure.attempt) || failure.attempt !== state.attempt) return stopped('failure_attempt_mismatch');
    } else if (observed.has(failure)) return stopped('failure_already_decided');
    observed.add(failure);
    // Skip metadata belongs to this decision only; never carry it to another one.
    projectionSkippedReason = null;
    // Full inspection includes EOF/disconnect and all buffered bytes. A terminal
    // event alone proves neither inspection nor HTTP response completion.
    if (failure.inspectionComplete !== true) { terminalReason = 'incomplete_failure'; return stopped(terminalReason); }
    if (!record(failure.output) || !['hasOutput', 'unknown', 'committed'].every(key => typeof failure.output[key] === 'boolean')) {
      terminalReason = 'output_inspection_required'; return stopped(terminalReason);
    }
    if (['downstream_committed', 'output_started', 'unknown_output'].includes(classified.reason)) {
      terminalReason = classified.reason; return stopped(terminalReason, classified);
    }
    const historyFailure = ['resource', 'encrypted'].includes(classified.classification)
      || classified.generic400ProjectionCandidate && generic400Projection;
    const hasTerminalPayload = failure.payload !== undefined || failure.event !== undefined;
    if (historyFailure && failure.responseComplete !== true
      || classified.classification === 'transient' && (hasTerminalPayload ? failure.responseComplete !== true : typeof failure.responseComplete !== 'boolean')) {
      terminalReason = 'response_incomplete'; return stopped(terminalReason, classified);
    }
    // Transparent mode never invents a retry for a legal empty completion or a
    // failed response without detail. The legacy automatic opt-in keeps its
    // separate empty-output policy.
    if (transparentOnly && classified.classification === 'transient' && /^empty_response_/.test(classified.reason)) {
      return result({ ...classified, retry: false, reason: classified.reason, delayMs: 0,
        projectHistory: false, projectEncryptedReasoning: false, generic400ProjectionCandidate: false, projectionCandidate: null });
    }
    let decision = recoveryActive
      ? decideRecovery({ state, failure: fixedFailure, nowMs, random })
      : decideResourceRecovery({ state, failure: fixedFailure, resourceAttempts, retryDelayMs });
    let projection, projectionError;
    if (decision.classification === 'encrypted' && decision.retry) {
      if (!nativeResponses) decision = { ...decision, retry: false, reason: 'projection_endpoint' };
      else {
        projection = projectEncryptedReasoning(body, { mode: historyMode });
        if (!projection.ok) decision = { ...decision, retry: false, reason: projection.code };
        else { applyBody(projection); lossy = true; }
      }
    }
    const resourceRetry = decision.classification === 'resource' && decision.retry;
    const genericProjection = !resourceRetry && decision.generic400ProjectionCandidate
      && generic400Projection && nativeResponses && !projectedOnce;
    if (!projectedOnce && (resourceRetry || genericProjection)) {
      // Never cache a projection across a cipher mutation: both paths operate on
      // current history, so a later ID projection cannot resurrect ciphertext.
      projection = projectResponsesHistory(body, { mode: historyMode });
      if (genericProjection && projection.ok && automaticRecovery) {
        const reserved = reserveRecoveryAttempt({ state, classification: 'projection', nowMs, random, headers: failure.headers });
        decision = { ...decision, ...reserved, classification: 'projection', reason: reserved.retry ? 'validated_generic_400_projection' : reserved.reason };
      }
      if (decision.retry) {
        if (projection.ok) applyProjection(projection);
        else if (converted && projection.code === 'no_supported_item_ids') projectedOnce = true;
        else if (transparentRecovery && resourceRetry && validateUnprojectedHistory(body, { mode: historyMode }).ok) {
          // The complete candidate carries a real builtin item whose upstream ID
          // must not be deleted, so no projection is available. Transparent mode
          // retries the current bytes exactly under the same shared budget and
          // reports the skip instead of claiming a projection.
          projectionSkippedReason = projection.code;
          projection = null;
          decision = { ...decision, retry: true, reason: 'unprojected_resource_retry', projectHistory: false };
        } else {
          if (!automaticRecovery && historyMode === 'minimal' && decision.reason !== 'native_history_recovery') projectionError = projection;
          decision = { ...decision, retry: false, reason: projection.code };
        }
      }
    }
    if (decision.retry) {
      state = Object.freeze({ ...decision.nextState, lastNowMs: nowMs });
    } else terminalReason = decision.reason;
    return result(decision, projection, projectionError);
  }
  return Object.freeze({ current, decide });
}

module.exports = { createRecoverySession };
