'use strict';

// DeepSeek Harness host seams. `createHarnessTurnContinuation` in
// `./client-continuation` owns the policy but deliberately refuses to invent
// the three things only a host knows: what the durable session log says, when a
// turn reached a terminal state, and how to start one more turn in the same
// session. This module wraps the *installed* Harness in-process API
// (0.2.1-rc.1, `@deepseek-ai/dsh-agent` + `dsh-agent-loop` + `dsh-session`)
// into exactly those seams, and refuses by name where no public seam exists.
//
// Verified native facts this file is built on. Nothing here drives a UI, types
// keys, replays a prompt, rolls back a file, truncates context or writes user
// configuration.
//
//   Durable session log (`session.snapshotEvents()`, one `session/event`
//   observer per committed event, `(session, event)`):
//     turn/start          { turn }                     1-based integer per session
//     step/start          { turn, step }
//     step/end            { turn, step }
//     turn/end            { turn, reason: TurnEndReason }
//     assistant/message   { turn, step, message }      tool-call blocks live here
//     tool/call           { turn, step, callId }
//     tool/result         { turn, step, message }      message.source.callId
//     user/message        data IS the message          source.rpcId survives
//     agent/inbox/spliced { target, start, removedCount, inserted, outcome? }
//     approval/asked      { id, toolName, callId?, reason? }
//     approval/decided    { id, outcome }
//     llm/retry           { retryId, turn, step, provider, retry, maxRetries, ... }
//     llm/retry-started   { retryId, turn, step, retry }
//
//   `TurnEndReason.kind` is one of completed | blocked | aborted | interrupted |
//   error | max-tokens | forked. Only `error` carries a failure:
//   `{ kind: 'error', error: { message, code, status?, providerRetryAfterMs?, ... } }`
//   where `error` is `LlmError#failure`.
//
//   Live agent events (`agentEvents`/`emitAgentEvent`; every payload carries
//   `agent`):
//     agent/status        { status: 'idle' | 'running' }
//     agent/error         { turn, step, error }
//     agent/inbox/claimed { message, turn }
//
//   Driving the same session from a plugin (`Agent` handle via `ctx.agents`):
//     agent.followup(message)   queues the next turn and wakes the driver
//     agent.steer(message)      queues next-step input
//     agent.status              'idle' | 'running'
//     agent.session.snapshotEvents()
//     agent.inbox.nextTurn / nextStep
//     ctx.sessions.flush(session)   the durability barrier behind `session/flush`
//
// What the installed contract does NOT expose, and what this module does about
// each gap, is `HARNESS_MISSING_SEAM` and `docs/harness-plugin.md`.

const { randomUUID } = require('node:crypto');
const { createHarnessTurnContinuation } = require('./client-continuation');
const { turnFingerprint } = require('./turn-continuation');

// Public capabilities the installed build genuinely lacks. Every one is
// compensated for by folding the durable session log, never by guessing.
const HARNESS_MISSING_SEAM = Object.freeze([
  'no turn-level retry/continue call: a plugin starts the next turn with the Agent handle\'s followup()/steer(), not with a continuation RPC',
  'no requestId idempotency outside the session-controller\'s prompt; this host re-implements its hasPromptRequest() rule over the durable log',
  'no willRetry / nativeRetryPending flag on turn/end; derived from the open-turn state and unstarted llm/retry records',
  'no public pending-approval accessor; derived from approval/asked without a matching approval/decided inside the open turn',
  'no durable per-turn identity beyond the session id plus the 1-based integer turn counter',
  'no in-process seam for a cold session: an Agent that is not live in this process cannot be continued'
]);

// Documented event reference, exported so docs and tests cannot drift from the
// names this module actually subscribes to.
const HARNESS_EVENTS = Object.freeze({
  sessionEvent: 'session/event',
  agentStatus: 'agent/status',
  inboxClaimed: 'agent/inbox/claimed',
  turnStart: 'turn/start',
  turnEnd: 'turn/end',
  stepStart: 'step/start',
  stepEnd: 'step/end',
  assistantMessage: 'assistant/message',
  toolCall: 'tool/call',
  toolResult: 'tool/result',
  userMessage: 'user/message',
  inboxSpliced: 'agent/inbox/spliced',
  approvalAsked: 'approval/asked',
  approvalDecided: 'approval/decided',
  llmRetry: 'llm/retry',
  llmRetryStarted: 'llm/retry-started'
});

// Native `LlmError` codes translated into the only vocabulary the
// transport-neutral classifier knows. Each entry is the closest exact twin; the
// turn this module hands to the adapter keeps the native code beside the
// translated one, so nothing is lost in reporting. A code absent from this
// table is passed through as-is, which the classifier treats as unknown and
// therefore stops.
const HARNESS_CODE_TRANSLATION = Object.freeze({
  // transient: the provider retry loop already gave up on them
  TRANSPORT: 'httpConnectionFailed',
  STREAM_CLOSED: 'responseStreamDisconnected',
  TIMEOUT: 'responseStreamConnectionFailed',
  RATE_LIMIT: 'rateLimitExceeded',
  SERVER: 'internalServerError',
  // terminal: continuing would spend budget on a decided failure
  AUTH: 'unauthorized',
  INVALID_CREDENTIAL: 'invalid_api_key',
  QUOTA: 'insufficient_quota',
  ACCOUNT_QUOTA: 'insufficient_quota',
  CONTEXT_WINDOW_EXCEEDED: 'context_length_exceeded',
  INVALID_REQUEST: 'badRequest',
  IMAGE_OFFLOAD_REQUIRED: 'invalid_request_error'
});

// `TurnEndReason.kind` -> the terminal status the continuation core understands.
// `blocked` (a pre-step rejection, e.g. the archived-session gate) and the
// closing kinds produced by recovery never carry a failure, so they are
// reported as `interrupted`, which the core refuses to continue.
const TURN_END_STATUS = Object.freeze({
  completed: 'completed',
  'max-tokens': 'completed',
  error: 'failed',
  aborted: 'interrupted',
  interrupted: 'interrupted',
  blocked: 'interrupted',
  forked: 'interrupted'
});

// `ToolCallRecovery` (dsh-session) folds a conservative error result into the
// log for a tool call whose real outcome was lost. Its message id is
// `${cause}-tool-result-${callId}-${seq}`, so a started-but-unanswered call is
// recognizable as "the side effect may or may not have happened".
const RECOVERY_RESULT_ID = /^(?:interrupted|forked|error)-tool-result-/;

const DEFAULT_MAX_AUTO_RUNS = 3;
const MAX_AUTO_RUNS = 3;

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

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

function codedError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  return Object.assign(error, extra);
}

function seamError(missing) {
  return codedError(`Harness host is missing required seam(s): ${missing.join(', ')}.`,
    'HARNESS_HOST_SEAM_MISSING', { missingSeam: Object.freeze([...missing]) });
}

function translateCode(code) {
  if (typeof code !== 'string' || code.length === 0) return 'UNKNOWN';
  return HARNESS_CODE_TRANSLATION[code] ?? code;
}

function retryAfter(error) {
  return Number.isFinite(error?.providerRetryAfterMs) && error.providerRetryAfterMs > 0
    ? Math.ceil(error.providerRetryAfterMs) : 0;
}

// One failed `turn/end` reason as the normalized failure view. `code` is the
// translated twin the classifier matches; `nativeCode` keeps what the provider
// actually said.
function classifyHarnessFailure(reason) {
  const failure = record(reason) && record(reason.error) ? reason.error : {};
  const nativeCode = typeof failure.code === 'string' && failure.code.length > 0 ? failure.code : 'UNKNOWN';
  return freeze({
    nativeCode,
    code: translateCode(nativeCode),
    message: typeof failure.message === 'string' ? failure.message : '',
    // `LlmError#failure` names the HTTP status `status`; the classifier reads
    // `httpStatusCode`.
    httpStatusCode: Number.isSafeInteger(failure.status) ? failure.status : null,
    retryAfterMs: retryAfter(failure)
  });
}

// ---------------------------------------------------------------------------
// Durable session fold
// ---------------------------------------------------------------------------

// One pass over the committed log, answering the questions the loop's own
// projections answer. Pending tool calls follow `ToolCallRecovery` exactly: a
// call is closed by a matching append-origin `tool/result` in the same
// turn+step, and every step or turn boundary discards what is left.
function foldHarnessSession(events) {
  const pendingCalls = new Map();
  const pendingApprovals = new Set();
  const openRetries = new Set();
  const rpcIds = new Set();
  const messageIds = new Set();
  const ambiguousTurns = new Set();
  const turnEnds = new Map();
  let openTurn = null;
  let lastTurnEnd = null;
  let lastSeq = 0;

  const closeStep = () => {
    for (const entry of pendingCalls.values()) if (entry.started) ambiguousTurns.add(entry.turn);
    pendingCalls.clear();
  };

  for (const event of events) {
    if (!record(event) || typeof event.type !== 'string') continue;
    if (Number.isSafeInteger(event.seq) && event.seq > lastSeq) lastSeq = event.seq;
    const data = record(event.data) ? event.data : {};
    switch (event.type) {
      case 'turn/start':
        closeStep();
        openRetries.clear();
        pendingApprovals.clear();
        openTurn = Number.isSafeInteger(data.turn) ? data.turn : openTurn;
        break;
      case 'turn/end': {
        const turn = Number.isSafeInteger(data.turn) ? data.turn : openTurn;
        closeStep();
        openRetries.clear();
        // An ask inside a turn is answered or withdrawn before that turn ends,
        // so nothing un-decided survives a closed turn.
        pendingApprovals.clear();
        openTurn = null;
        lastTurnEnd = { turn, reason: record(data.reason) ? data.reason : { kind: 'interrupted' }, seq: event.seq };
        if (Number.isSafeInteger(turn)) turnEnds.set(turn, lastTurnEnd);
        break;
      }
      case 'step/end':
        closeStep();
        break;
      case 'assistant/message': {
        const message = record(data.message) ? data.message : {};
        if (!Array.isArray(message.content)) break;
        for (const block of message.content) {
          if (!record(block) || block.type !== 'tool-call' || typeof block.id !== 'string') continue;
          pendingCalls.set(block.id, { turn: data.turn, step: data.step, started: false });
        }
        break;
      }
      case 'tool/call': {
        const entry = pendingCalls.get(data.callId);
        if (entry !== undefined) entry.started = true;
        break;
      }
      case 'tool/result': {
        const message = record(data.message) ? data.message : {};
        const callId = record(message.source) ? message.source.callId : undefined;
        const entry = typeof callId === 'string' ? pendingCalls.get(callId) : undefined;
        if (entry === undefined) break;
        const recovered = typeof message.id === 'string' && RECOVERY_RESULT_ID.test(message.id);
        // A recovery result closes the call on paper while leaving the real
        // side effect unknown.
        if (recovered && entry.started) ambiguousTurns.add(entry.turn);
        if (event.surfaceOp === 'append' && entry.turn === data.turn && entry.step === data.step) pendingCalls.delete(callId);
        break;
      }
      case 'approval/asked':
        if (typeof data.id === 'string') pendingApprovals.add(data.id);
        break;
      case 'approval/decided':
        if (typeof data.id === 'string') pendingApprovals.delete(data.id);
        break;
      case 'llm/retry':
        if (typeof data.retryId === 'string') openRetries.add(data.retryId);
        break;
      case 'llm/retry-started':
        if (typeof data.retryId === 'string') openRetries.delete(data.retryId);
        break;
      case 'user/message':
        if (record(data.source) && data.source.kind === 'user' && typeof data.source.rpcId === 'string') {
          rpcIds.add(data.source.rpcId);
        }
        break;
      case 'agent/inbox/spliced':
        if (Array.isArray(data.inserted)) {
          for (const message of data.inserted) if (record(message) && typeof message.id === 'string') messageIds.add(message.id);
        }
        break;
      default: break;
    }
  }

  return freeze({
    lastSeq,
    openTurn,
    lastTurnEnd,
    turnEnds,
    rpcIds,
    messageIds,
    pendingApprovals: [...pendingApprovals],
    openRetries: [...openRetries],
    ambiguousTurns: [...ambiguousTurns],
    pendingTools: pendingCalls.size,
    unsettledStartedCalls: [...pendingCalls.values()].filter(entry => entry.started).length
  });
}

// The core reads a snapshot in this fixed order and reports the first field
// that is not at its safe value, so the same order names the blocking state.
const SNAPSHOT_GATES = Object.freeze([
  ['durable_committed', 'snapshot_not_committed'],
  ['turn_active', 'turn_active'],
  ['pending_approval', 'pending_approval'],
  ['pending_tools', 'pending_tools'],
  ['unsettled_tool_calls', 'unsettled_tool_calls'],
  ['ambiguous_side_effects', 'ambiguous_side_effects'],
  ['native_retry_pending', 'native_retry_pending']
]);

// Attest one failed turn from the durable fold plus the live agent status.
// Every field is a literal boolean; a caller that cannot prove one never sees a
// permissive default. When the blocking state is one the core has a field for,
// the returned object states every gate truthfully and lets the core name the
// first failing one; a state the core has no field for returns nothing at all,
// with the precise reason kept in `diagnostics()`.
function evaluateHarnessSnapshot(input) {
  const { sessionId, failedTurnId, failedFingerprint, fold, agentStatus, durableCommitted } = input;
  const turnId = String(failedTurnId ?? '');
  if (turnId.length === 0) return { ok: false, reason: 'terminal_turn_required' };
  const end = fold.turnEnds.get(Number(turnId));
  if (end === undefined) return { ok: false, reason: 'failed_turn_not_found' };
  if (end.reason?.kind !== 'error') return { ok: false, reason: 'terminal_turn_required' };
  // A later turn already ran: continuing the older failure would interleave a
  // new turn with work the user (or another plugin) already started.
  if (fold.lastTurnEnd !== null && fold.lastTurnEnd.turn !== end.turn) return { ok: false, reason: 'stale_failed_turn' };
  if (agentStatus !== 'idle' && agentStatus !== 'running') return { ok: false, reason: 'agent_status_unknown' };

  const failure = classifyHarnessFailure(end.reason);
  const expected = turnFingerprint({ threadId: sessionId, turnId, status: 'failed', error: { code: failure.code } });
  const gates = {
    durable_committed: durableCommitted === true,
    turn_active: fold.openTurn === null && agentStatus === 'idle',
    pending_approval: fold.pendingApprovals.length === 0,
    pending_tools: fold.pendingTools === 0,
    unsettled_tool_calls: fold.unsettledStartedCalls === 0,
    ambiguous_side_effects: !fold.ambiguousTurns.includes(end.turn),
    native_retry_pending: fold.openRetries.length === 0
  };
  const snapshot = freeze({
    // Deterministic: the same durable position and failed turn produce the same
    // id, so a host that answers twice from unmoved state is caught.
    snapshotId: `${sessionId}\u0000${turnId}\u0000${fold.lastSeq}`,
    failedTurnId: turnId,
    failedFingerprint: expected,
    durableCommitted: gates.durable_committed,
    turnActive: !gates.turn_active,
    pendingApproval: !gates.pending_approval,
    pendingTools: !gates.pending_tools,
    startedToolCallsSettled: gates.unsettled_tool_calls,
    ambiguousSideEffects: !gates.ambiguous_side_effects,
    nativeRetryPending: !gates.native_retry_pending
  });

  const blocked = SNAPSHOT_GATES.find(([gate]) => !gates[gate]);
  if (blocked !== undefined) {
    // The core reports the first failing field in its own order; `reason` names
    // the most specific blocking state for diagnostics, which matters when e.g.
    // an open turn and a pending approval are both true (the core says
    // `turn_active`, the log's actual blocker is the approval).
    return { ok: false, reason: specificReason(gates, fold) ?? blocked[1], coreReason: blocked[1], snapshot };
  }
  if (typeof failedFingerprint === 'string' && failedFingerprint !== expected) {
    return { ok: false, reason: 'snapshot_fingerprint_mismatch' };
  }
  return { ok: true, snapshot };
}

function specificReason(gates, fold) {
  if (!gates.pending_approval) return 'pending_approval';
  if (!gates.unsettled_tool_calls) return 'unsettled_tool_calls';
  if (!gates.pending_tools) return 'pending_tools';
  if (!gates.ambiguous_side_effects) return 'ambiguous_side_effects';
  if (!gates.native_retry_pending) return 'native_retry_pending';
  if (!gates.turn_active) return fold.openTurn === null ? 'agent_running' : 'turn_active';
  if (!gates.durable_committed) return 'snapshot_not_committed';
  return undefined;
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

function createHarnessHost(options = {}) {
  if (!record(options)) throw new TypeError('Harness host requires an options object.');
  const ctx = record(options.ctx) ? options.ctx : undefined;
  const events = options.events ?? (ctx !== undefined && typeof ctx.on === 'function'
    ? { on: (name, handler) => { const dispose = ctx.on(name, handler); return typeof dispose === 'function' ? dispose : () => {}; } }
    : undefined);
  if (!record(events) || typeof events.on !== 'function') throw seamError(['events']);
  const agentFor = options.agentFor ?? (sessionId => ctx?.agents?.get?.(sessionId));
  if (typeof agentFor !== 'function') throw seamError(['agentFor']);
  const flushDurable = options.flushDurable ?? (session => {
    const sessions = ctx?.sessions;
    // Without the session store's own barrier there is no durability
    // attestation, so the snapshot refuses instead of assuming the log reached
    // storage.
    if (!sessions || typeof sessions.flush !== 'function') return Promise.resolve(false);
    return Promise.resolve(sessions.flush(session)).then(participated => participated === true, () => false);
  });
  if (typeof flushDurable !== 'function') throw seamError(['flushDurable']);
  const createMessage = options.createMessage;
  if (createMessage !== undefined && typeof createMessage !== 'function') throw new TypeError('Invalid createMessage.');
  const logger = record(options.logger) ? options.logger : undefined;
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') throw new TypeError('Invalid host clock.');
  const autoContinue = options.autoContinue === true;
  // A run already spends up to three continuation turns; capping automatic runs
  // per session keeps a flapping provider from spending turns without end.
  const maxAutoRuns = options.maxAutoRuns === undefined
    ? DEFAULT_MAX_AUTO_RUNS : integer(options.maxAutoRuns, 1, MAX_AUTO_RUNS, 'maxAutoRuns');
  const budget = {
    maxContinuations: options.maxContinuations,
    deadlineMs: options.deadlineMs,
    baseDelayMs: options.baseDelayMs,
    maxDelayMs: options.maxDelayMs,
    continuationText: options.continuationText
  };

  const arms = new Map(); // requestId -> correlation entry
  const armsByMessage = new Map(); // messageId -> correlation entry
  const liveTurnEnds = new Map(); // `${sessionId}\u0000${turn}` -> terminal turn
  const idleWaiters = new Map(); // sessionId -> Set<resolver>
  const sessions = new Map(); // sessionId -> per-session state
  const diagnostics = { lastRefusal: null, refusals: [] };

  function sessionState(sessionId) {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      state = { pendingFailure: null, consumed: new Set(), runs: 0, running: false, continuation: null };
      sessions.set(sessionId, state);
    }
    return state;
  }

  function noteRefusal(sessionId, reason, extra = {}) {
    const entry = freeze({ at: now(), sessionId, reason, ...extra });
    diagnostics.lastRefusal = entry;
    if (diagnostics.refusals.length < 32) diagnostics.refusals.push(entry);
    return entry;
  }

  // --- live listeners -----------------------------------------------------

  const onSessionEvent = (session, event) => {
    if (!record(event) || typeof event.type !== 'string') return;
    const sessionId = session?.id;
    if (typeof sessionId !== 'string' || event.type !== 'turn/end') return;
    const turn = event.data?.turn;
    if (!Number.isSafeInteger(turn)) return;
    const reason = record(event.data?.reason) ? event.data.reason : { kind: 'interrupted' };
    const key = `${sessionId}\u0000${turn}`;
    const armEntry = [...arms.values()].find(entry => entry.sessionId === sessionId && entry.claimTurn === turn);
    if (armEntry !== undefined) {
      armEntry.terminal = terminalTurn(sessionId, reason, turn);
      liveTurnEnds.set(key, armEntry.terminal);
      settleArm(armEntry);
    }
    if (reason.kind === 'error') {
      const failure = classifyHarnessFailure(reason);
      const state = sessionState(sessionId);
      if (state.running) {
        // A failure produced by a continuation turn belongs to the run that
        // started it; letting it queue here would spawn a second run for a turn
        // the current run is already handling.
        state.consumed.add(`${turn}\u0000${failure.code}`);
        return;
      }
      // The loop only returns to idle after `turn()` has thrown, so the failure
      // is recorded here and fired from the idle transition below.
      state.pendingFailure = { sessionId, turnId: String(turn), failure };
      maybeContinue(sessionId);
    }
  };

  const onAgentStatus = payload => {
    const sessionId = payload?.agent?.id ?? payload?.agent?.session?.id;
    if (typeof sessionId !== 'string') return;
    if (payload.status !== 'idle') return;
    const waiters = idleWaiters.get(sessionId);
    if (waiters !== undefined) {
      idleWaiters.delete(sessionId);
      for (const resolve of waiters) resolve();
    }
    maybeContinue(sessionId);
  };

  const onInboxClaimed = payload => {
    const messageId = payload?.message?.id;
    if (typeof messageId !== 'string') return;
    const armEntry = armsByMessage.get(messageId);
    if (armEntry === undefined) return;
    armEntry.claimTurn = payload.turn;
  };

  const disposers = [
    events.on(HARNESS_EVENTS.sessionEvent, onSessionEvent),
    events.on(HARNESS_EVENTS.agentStatus, onAgentStatus),
    events.on(HARNESS_EVENTS.inboxClaimed, onInboxClaimed)
  ];

  // --- correlation --------------------------------------------------------

  function arm(sessionId, requestId, messageId) {
    const entry = { sessionId, requestId, messageId, claimTurn: undefined, terminal: undefined, waiters: [] };
    arms.set(requestId, entry);
    armsByMessage.set(messageId, entry);
    return entry;
  }

  function disarm(entry) {
    if (entry === undefined) return;
    if (arms.get(entry.requestId) === entry) arms.delete(entry.requestId);
    if (armsByMessage.get(entry.messageId) === entry) armsByMessage.delete(entry.messageId);
    if (entry.claimTurn !== undefined) liveTurnEnds.delete(`${entry.sessionId}\u0000${entry.claimTurn}`);
  }

  function settleArm(entry) {
    const waiters = entry.waiters.splice(0);
    for (const resolve of waiters) resolve(entry.terminal ?? null);
  }

  // --- prompt shim: the adapter's session.prompt() over the in-process Agent

  function createSessionAdapter(sessionId) {
    return Object.freeze({
      async prompt(content, mode, signal, requestId) {
        if (isSignal(signal) && signal.aborted) throw codedError('Harness continuation aborted.', 'HARNESS_TURN_CANCELLED');
        if (typeof requestId !== 'string' || requestId.length === 0) throw new TypeError('Harness prompt requires a requestId.');
        const agent = agentFor(sessionId);
        if (!agent || typeof agent.followup !== 'function') {
          throw codedError(`Session "${sessionId}" has no live Agent in this process.`, 'HARNESS_SESSION_NOT_LIVE', { sessionId });
        }
        // The session-controller's own rule, replayed over the durable log: an
        // identical requestId that is already queued or admitted is the same
        // acceptance and must not insert a second message.
        if (hasAcceptedPrompt(agent, requestId)) {
          const existing = arms.get(requestId);
          if (existing === undefined) {
            throw codedError('The prompt was already accepted, but its turn is no longer correlated.',
              'HARNESS_TURN_CORRELATION_MISSING', { sessionId, requestId });
          }
          return freeze({ ok: true, accepted: true, deduplicated: true, messageId: existing.messageId });
        }
        const message = makeUserMessage(content, requestId);
        if (message === undefined) throw new TypeError('Invalid continuation content.');
        // Armed *before* the queue write: `followup()` claims its input
        // synchronously, so a listener installed afterwards would miss the
        // claim that names our turn.
        const entry = arm(sessionId, requestId, message.id);
        try {
          if (mode === 'steer') agent.steer(message);
          else agent.followup(message);
        } catch (error) {
          disarm(entry);
          throw error;
        }
        return freeze({ ok: true, accepted: true, messageId: message.id });
      }
    });
  }

  function makeUserMessage(content, requestId) {
    if (!Array.isArray(content) || content.length === 0) return undefined;
    const blocks = [];
    for (const block of content) {
      if (!record(block) || block.type !== 'text' || typeof block.text !== 'string' || block.text.trim().length === 0) return undefined;
      blocks.push({ type: 'text', text: block.text });
    }
    const input = { role: 'user', content: blocks, source: { kind: 'user', rpcId: requestId } };
    if (createMessage !== undefined) return createMessage(input);
    // The same construction `createUserMessage` performs, without importing
    // `@deepseek-ai/dsh-llm` from inside a profile plugin (that specifier does
    // not resolve for a plugin loaded by absolute path).
    return { ...input, id: randomUUID() };
  }

  // --- the three seams ----------------------------------------------------

  async function readSnapshot(context) {
    const sessionId = context?.threadId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
    const agent = agentFor(sessionId);
    const session = agent?.session;
    if (!session || typeof session.snapshotEvents !== 'function') {
      noteRefusal(sessionId, 'session_not_live');
      return undefined;
    }
    let durableCommitted = false;
    try {
      durableCommitted = (await flushDurable(session)) === true;
    } catch {
      durableCommitted = false;
    }
    // Fold after the barrier, so the attestation covers exactly what is durable.
    const fold = foldHarnessSession(session.snapshotEvents());
    const verdict = evaluateHarnessSnapshot({
      sessionId,
      failedTurnId: context?.failedTurnId,
      failedFingerprint: context?.failedFingerprint,
      fold,
      agentStatus: agent.status,
      durableCommitted
    });
    if (!verdict.ok) {
      noteRefusal(sessionId, verdict.reason, {
        failedTurnId: String(context?.failedTurnId ?? ''),
        ...(verdict.coreReason === undefined ? {} : { coreReason: verdict.coreReason })
      });
    }
    // A snapshot the core has no field for is withheld entirely rather than
    // reported as a state it would misread.
    return verdict.snapshot;
  }

  function awaitTurn(context) {
    const sessionId = context?.sessionId;
    const requestId = context?.requestId;
    const signal = context?.signal;
    if (typeof sessionId !== 'string' || typeof requestId !== 'string') {
      return Promise.reject(new TypeError('Harness awaitTurn requires sessionId and requestId.'));
    }
    const armEntry = arms.get(requestId);
    if (armEntry === undefined) {
      return Promise.reject(codedError('No armed continuation turn for this requestId.',
        'HARNESS_TURN_CORRELATION_MISSING', { sessionId, requestId }));
    }
    // A turn can end before the caller starts waiting; never lose that.
    const cached = armEntry.terminal
      ?? (armEntry.claimTurn === undefined ? undefined : liveTurnEnds.get(`${sessionId}\u0000${armEntry.claimTurn}`));
    if (cached !== undefined) {
      const terminal = cached;
      return idleThen(sessionId, signal).then(() => {
        disarm(armEntry);
        return terminal;
      });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (settle, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.('abort', onAbort);
        if (settle === resolve) disarm(armEntry);
        settle(value);
      };
      const onAbort = () => done(reject, codedError('Harness continuation aborted.', 'HARNESS_TURN_CANCELLED'));
      if (isSignal(signal)) {
        if (signal.aborted) { done(reject, codedError('Harness continuation aborted.', 'HARNESS_TURN_CANCELLED')); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      armEntry.waiters.push(terminal => {
        if (terminal == null) {
          done(reject, codedError('The continuation turn did not reach a terminal state.', 'HARNESS_TURN_NOT_TERMINAL'));
          return;
        }
        idleThen(sessionId, signal).then(() => done(resolve, terminal), error => done(reject, error));
      });
    });
  }

  // The loop publishes a turn failure before it returns to idle, and the
  // snapshot gate requires `turnActive === false`; waiting for the idle
  // transition is part of observing a terminal turn, not an extra assumption.
  function idleThen(sessionId, signal) {
    if (agentFor(sessionId)?.status === 'idle') return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => finish(reject, codedError('Harness continuation aborted.', 'HARNESS_TURN_CANCELLED'));
      const finish = (settle, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.('abort', onAbort);
        const waiters = idleWaiters.get(sessionId);
        if (waiters !== undefined) {
          waiters.delete(onIdle);
          if (waiters.size === 0) idleWaiters.delete(sessionId);
        }
        settle(value);
      };
      const onIdle = () => finish(resolve);
      if (isSignal(signal)) {
        if (signal.aborted) { finish(reject, codedError('Harness continuation aborted.', 'HARNESS_TURN_CANCELLED')); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const waiters = idleWaiters.get(sessionId) ?? new Set();
      waiters.add(onIdle);
      idleWaiters.set(sessionId, waiters);
    });
  }

  function continuationFor(sessionId) {
    const state = sessionState(sessionId);
    state.continuation ??= createHarnessTurnContinuation({
      session: createSessionAdapter(sessionId),
      readSnapshot,
      awaitTurn,
      ...budget
    });
    return state.continuation;
  }

  // --- automatic continuation --------------------------------------------

  function maybeContinue(sessionId) {
    if (!autoContinue) return;
    const state = sessionState(sessionId);
    if (state.pendingFailure === null || state.running) return;
    if (agentFor(sessionId)?.status !== 'idle') return;
    const pending = state.pendingFailure;
    state.pendingFailure = null;
    void continueAfterFailure(pending).catch(error => {
      logger?.warn?.(`harness-auto-continue: continuation threw (${error?.code ?? 'unknown'})`, error);
    });
  }

  async function continueAfterFailure(pending) {
    const sessionId = pending?.sessionId;
    if (typeof sessionId !== 'string') throw new TypeError('Harness continuation requires a sessionId.');
    const turnId = String(pending.turnId ?? '');
    const failure = record(pending.failure) ? pending.failure : classifyHarnessFailure(null);
    const state = sessionState(sessionId);
    const key = `${turnId}\u0000${failure.code}`;
    if (state.consumed.has(key)) {
      return freeze({ ok: false, status: 'stopped', reason: 'failed_turn_already_continued', sessionId, turnId });
    }
    if (state.runs >= maxAutoRuns) {
      noteRefusal(sessionId, 'auto_budget_exhausted', { turnId });
      return freeze({ ok: false, status: 'stopped', reason: 'auto_budget_exhausted', sessionId, turnId, autoRuns: state.runs });
    }
    state.consumed.add(key);
    state.runs += 1;
    state.running = true;
    try {
      return await continuationFor(sessionId).run({
        sessionId,
        // A `turn/end` with reason `error` is only reported after `llm-retry`
        // declined to retry, so the native retry loop is done with this turn.
        failedTurn: { sessionId, turnId, status: 'failed', nativeRetryExhausted: true, error: failure },
        onProgress: event => logger?.debug?.('harness-auto-continue: progress', event)
      });
    } finally {
      state.running = false;
    }
  }

  // --- description --------------------------------------------------------

  function describe() {
    return freeze({
      adapter: 'deepseek-harness',
      host: 'dsh-in-process',
      autoContinue,
      maxAutoRuns,
      events: { ...HARNESS_EVENTS },
      publicSurfaces: [
        'ctx.agents.get(sessionId) -> Agent',
        'agent.followup(message) / agent.steer(message)',
        'agent.status',
        'agent.session.snapshotEvents()',
        'agent.inbox.nextTurn / nextStep',
        'ctx.sessions.flush(session)',
        'ctx.on("session/event", (session, event))',
        'ctx.on("agent/status" | "agent/inbox/claimed", payload)'
      ],
      codeTranslation: { ...HARNESS_CODE_TRANSLATION },
      missingPublicSeam: HARNESS_MISSING_SEAM,
      notSupported: [
        'keyboard or UI automation',
        'replaying the original prompt, command or tool output',
        'continuing a session whose Agent is not live in this process',
        'continuing an interrupted (user-cancelled) turn',
        'filesystem rollback, context truncation, quota bypass or cancellation'
      ]
    });
  }

  return Object.freeze({
    describe,
    readSnapshot,
    awaitTurn,
    prompt: (sessionId, content, mode, signal, requestId) => createSessionAdapter(sessionId).prompt(content, mode, signal, requestId),
    continuationFor,
    continueAfterFailure,
    diagnostics: () => freeze({ lastRefusal: diagnostics.lastRefusal, refusals: [...diagnostics.refusals] }),
    dispose() {
      for (const off of disposers) {
        try { off(); } catch { /* one failing disposer must not hide the rest */ }
      }
      for (const entry of [...arms.values()]) settleArm(entry);
      arms.clear();
      armsByMessage.clear();
      liveTurnEnds.clear();
      idleWaiters.clear();
    }
  });
}

function terminalTurn(sessionId, reason, turn) {
  const status = TURN_END_STATUS[reason?.kind] ?? 'interrupted';
  const failure = status === 'failed' ? classifyHarnessFailure(reason) : null;
  return freeze({
    sessionId,
    turnId: String(turn),
    status,
    terminal: true,
    // `harnessTerminalTurn` reads `error.code` for both the classifier and the
    // fingerprint; the native code rides along for reporting.
    error: failure === null ? null : {
      code: failure.code,
      nativeCode: failure.nativeCode,
      message: failure.message,
      httpStatusCode: failure.httpStatusCode,
      retryAfterMs: failure.retryAfterMs
    }
  });
}

// The session-controller's rule, applied to the durable log instead of its
// Remote method: an identical requestId already queued or admitted is the same
// acceptance.
function hasAcceptedPrompt(agent, requestId) {
  const matches = message => record(message)
    && record(message.source)
    && message.source.kind === 'user'
    && message.source.rpcId === requestId;
  const inbox = agent.inbox;
  if (inbox !== undefined) {
    if (Array.isArray(inbox.nextTurn) && inbox.nextTurn.some(matches)) return true;
    if (Array.isArray(inbox.nextStep) && inbox.nextStep.some(matches)) return true;
  }
  const session = agent.session;
  if (!session || typeof session.snapshotEvents !== 'function') return false;
  return session.snapshotEvents().some(event => event?.type === 'user/message' && matches(event.data));
}

function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${name}.`);
  return value;
}

module.exports = {
  createHarnessHost,
  foldHarnessSession,
  evaluateHarnessSnapshot,
  classifyHarnessFailure,
  HARNESS_MISSING_SEAM,
  HARNESS_EVENTS,
  HARNESS_CODE_TRANSLATION
};
