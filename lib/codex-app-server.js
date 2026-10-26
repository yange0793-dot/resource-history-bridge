'use strict';

// Codex app-server transport plus the host seams that turn it into automatic
// turn continuation. Policy stays in `./turn-continuation`; the native adapter
// stays in `./client-continuation`. This file only supplies what those two
// modules demand from a host: a real JSON-RPC transport, a `readSnapshot` built
// from state the server actually reports, and a `reconcileStart` that never
// guesses.
//
// Everything below is written against codex-cli 0.162.1, verified by
// `codex app-server generate-json-schema` and by a live `codex app-server
// --listen stdio://` handshake:
//
//   * JSON-RPC 2.0, one JSON object per line, over stdin/stdout.
//   * Request ids may be integers or strings; the response echoes the same id.
//   * A failure is `{ id, error: { code, message } }`. In practice `data` is
//     absent, so the echoed id is the only thing that ties a failure to its
//     request.
//   * Server notifications are `{ method, params, emittedAtMs }`. `emittedAtMs`
//     is a server extension, not part of JSON-RPC.
//   * Server-initiated requests (approvals, user input, MCP elicitation, tool
//     calls) reuse the same envelope: `id` plus `method`, with neither `result`
//     nor `error`. They must be answered or the turn hangs.
//   * `initialize` is answered first; the client then sends an `initialized`
//     notification. Methods gated behind `experimentalApi` are refused with
//     `-32600 ... requires experimentalApi capability`.
//   * Reading a thread that is not loaded fails with
//     `-32600 thread not loaded: <id>`, so every snapshot first resumes.
//
// No prompt, tool output or credential is ever copied into an event, a log line
// or an error message produced here.

const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { turnFingerprint, classifyContinuationFailure } = require('./turn-continuation');
const { createCodexTurnContinuation, DEFAULT_CONTINUATION_TEXT } = require('./client-continuation');

const DEFAULT_COMMAND = 'codex';
// `--listen stdio://` is the documented default, but passing it explicitly keeps
// the transport pinned if the CLI default ever changes.
const DEFAULT_ARGS = Object.freeze(['app-server', '--listen', 'stdio://']);
const DEFAULT_CALL_TIMEOUT_MS = 30000;
const MAX_CALL_TIMEOUT_MS = 300000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5000;
const MAX_CLOSE_TIMEOUT_MS = 60000;
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const METHOD_NOT_SUPPORTED = -32601;

// Real method names, taken from the server's own rejection list and from the
// generated v2 schema. Kept here so callers cannot silently invent a spelling.
const METHODS = Object.freeze({
  initialize: 'initialize',
  threadResume: 'thread/resume',
  threadRead: 'thread/read',
  threadTurnsList: 'thread/turns/list',
  threadItemsList: 'thread/items/list',
  turnStart: 'turn/start',
  turnInterrupt: 'turn/interrupt'
});

const NOTIFICATIONS = Object.freeze({
  initialized: 'initialized',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  error: 'error',
  serverRequestResolved: 'serverRequest/resolved',
  threadStatusChanged: 'thread/status/changed',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed'
});

// A tool item that started and never reached a terminal status is exactly the
// unattested state the continuation gate exists for.
const TERMINAL_ITEM_STATUSES = new Set(['completed', 'failed', 'declined', 'interrupted']);

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

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`Invalid ${name}.`);
  return value;
}

function isSignal(value) {
  return record(value) && typeof value.addEventListener === 'function' && typeof value.aborted === 'boolean';
}

function clientError(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  if (extra) Object.assign(error, extra);
  return error;
}

function packageVersion() {
  try {
    const version = require('../package.json').version;
    if (typeof version === 'string' && version.length > 0) return version;
  } catch { /* a packaged build without package.json still works */ }
  return '0.0.0';
}

// ---------------------------------------------------------------------------
// JSON-RPC over the app-server's stdio
// ---------------------------------------------------------------------------

function createCodexAppServerClient(options = {}) {
  if (!record(options)) throw new TypeError('Codex app server client requires an options object.');
  const command = options.command === undefined ? DEFAULT_COMMAND : nonEmptyString(options.command, 'command');
  const args = options.args === undefined
    ? DEFAULT_ARGS.slice()
    : (Array.isArray(options.args) && options.args.every(item => typeof item === 'string')
      ? options.args.slice()
      : (() => { throw new TypeError('Invalid args.'); })());
  const env = options.env === undefined ? process.env : options.env;
  if (!record(env)) throw new TypeError('Invalid env.');
  const cwd = options.cwd === undefined ? undefined : nonEmptyString(options.cwd, 'cwd');
  const callTimeoutMs = integer(options.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS, 1, MAX_CALL_TIMEOUT_MS, 'callTimeoutMs');
  const initTimeoutMs = integer(options.initTimeoutMs, callTimeoutMs, 1, MAX_CALL_TIMEOUT_MS, 'initTimeoutMs');
  const closeTimeoutMs = integer(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, 1, MAX_CLOSE_TIMEOUT_MS, 'closeTimeoutMs');
  const maxLineBytes = integer(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES, 1024, 256 * 1024 * 1024, 'maxLineBytes');
  const maxStderrBytes = integer(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES, 0, 16 * 1024 * 1024, 'maxStderrBytes');
  if (options.onServerRequest !== undefined && typeof options.onServerRequest !== 'function') {
    throw new TypeError('Invalid onServerRequest.');
  }
  const onServerRequest = options.onServerRequest;
  const clientInfo = freeze({
    name: 'resource-history-bridge',
    version: packageVersion(),
    ...(record(options.clientInfo) ? options.clientInfo : {})
  });
  const capabilities = freeze(record(options.capabilities) ? { ...options.capabilities } : {});

  let child = null;
  let startPromise = null;
  let initPromise = null;
  let state = 'idle'; // idle | starting | open | closed
  let exitInfo = null;
  let nextRequestId = 1;
  let serverInfo = null;
  let decoderOut = null;
  let outBuffer = '';
  let decoderErr = null;
  let stderrLines = [];
  let stderrBytes = 0;
  const pending = new Map();
  const subscribers = new Set();

  const client = {
    get closed() { return state === 'closed'; },
    get running() { return state === 'open'; },
    get pid() { return child?.pid ?? null; },
    get serverInfo() { return serverInfo; },
    get exit() { return exitInfo; },
    initialize: initialized,
    call,
    notify,
    subscribe,
    respond,
    close,
    stderrTail: () => stderrLines.slice(),
    stderrBytes: () => stderrBytes
  };
  return Object.freeze(client);

  // -- lifecycle ------------------------------------------------------------

  function start() {
    if (startPromise) return startPromise;
    if (state === 'closed') return Promise.reject(closedError());
    state = 'starting';
    startPromise = new Promise((resolve, reject) => {
      let settled = false;
      let spawned;
      try {
        spawned = spawn(command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
          ...(cwd === undefined ? {} : { cwd }),
          shell: false
        });
      } catch (error) {
        state = 'closed';
        reject(clientError('CODEX_APP_SERVER_SPAWN_FAILED', `Failed to start ${command}.`, { cause: error }));
        return;
      }
      child = spawned;
      decoderOut = new StringDecoder('utf8');
      decoderErr = new StringDecoder('utf8');
      // A closed stdin surfaces as EPIPE on write; the exit handler reports the
      // real reason, so this listener only stops it from being unhandled.
      spawned.stdin.on('error', () => {});
      spawned.stdout.on('data', chunk => onStdout(chunk));
      spawned.stderr.on('data', chunk => onStderr(chunk));
      spawned.once('spawn', () => {
        settled = true;
        state = 'open';
        resolve(client);
      });
      spawned.once('error', error => {
        if (!settled) {
          settled = true;
          state = 'closed';
          reject(clientError('CODEX_APP_SERVER_SPAWN_FAILED', `Failed to start ${command}.`, { cause: error }));
          return;
        }
        emit({ type: 'transport-error', code: 'CODEX_APP_SERVER_SPAWN_FAILED' });
      });
      spawned.once('exit', (code, signal) => {
        const requested = state === 'closed';
        exitInfo = freeze({ code: code === undefined ? null : code, signal: signal ?? null });
        state = 'closed';
        const error = clientError('CODEX_APP_SERVER_EXITED', 'The Codex app server exited.', { exit: exitInfo });
        settleAll(error);
        emit({ type: 'exit', code: exitInfo.code, signal: exitInfo.signal, requested });
        // Every pending call has already been rejected; nothing else can start.
        if (!settled) {
          settled = true;
          reject(clientError('CODEX_APP_SERVER_EXITED', 'The Codex app server exited before it was ready.', { exit: exitInfo }));
        }
      });
    });
    return startPromise;
  }

  function initialized() {
    if (initPromise) return initPromise;
    initPromise = start()
      .then(() => request(METHODS.initialize, { clientInfo, capabilities }, { timeoutMs: initTimeoutMs }))
      .then(result => {
        if (!record(result)) {
          throw clientError('CODEX_APP_SERVER_PROTOCOL_ERROR', 'initialize did not return an object.');
        }
        serverInfo = freeze({ ...result });
        // The handshake the protocol documents; not a substitute for anything.
        send({ method: NOTIFICATIONS.initialized });
        return serverInfo;
      });
    return initPromise;
  }

  function close(options = {}) {
    const timeoutMs = options === undefined || options === null
      ? closeTimeoutMs
      : integer(record(options) ? options.timeoutMs : undefined, closeTimeoutMs, 1, MAX_CLOSE_TIMEOUT_MS, 'close timeout');
    if (state === 'closed') return Promise.resolve();
    state = 'closed';
    settleAll(closedError());
    const target = child;
    if (!target) return Promise.resolve();
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        try { target.kill('SIGKILL'); } catch { /* already gone */ }
        finish();
      }, timeoutMs);
      target.once('exit', finish);
      try { target.stdin.end(); } catch { /* already closed */ }
      try { target.kill('SIGTERM'); } catch { /* already gone */ }
    });
  }

  // -- requests -------------------------------------------------------------

  async function call(method, params, context = {}) {
    if (typeof method !== 'string' || method.length === 0) throw new TypeError('Invalid method.');
    if (params !== undefined && !record(params)) throw new TypeError('Invalid params.');
    if (context !== undefined && context !== null && !record(context)) throw new TypeError('Invalid call context.');
    const settings = context ?? {};
    if (settings.signal !== undefined && !isSignal(settings.signal)) throw new TypeError('Invalid call signal.');
    if (state === 'closed') throw closedError();
    // Every call waits for the documented handshake. A caller that asks for
    // `initialize` explicitly gets the same single handshake back rather than
    // sending a second one the server would reject.
    if (method === METHODS.initialize) return initialized();
    await initialized();
    return request(method, params ?? {}, settings);
  }

  function request(method, params, settings) {
    const timeoutMs = settings.timeoutMs === undefined
      ? callTimeoutMs
      : integer(settings.timeoutMs, callTimeoutMs, 1, MAX_CALL_TIMEOUT_MS, 'timeoutMs');
    const signal = settings.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(clientError('CODEX_APP_SERVER_ABORTED', 'The call was aborted.'));
        return;
      }
      if (state !== 'open') {
        reject(closedError());
        return;
      }
      const id = nextRequestId++;
      let settled = false;
      const finish = (settle, value) => {
        if (settled) return;
        settled = true;
        pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        settle(value);
      };
      const onAbort = () => finish(reject, clientError('CODEX_APP_SERVER_ABORTED', 'The call was aborted.'));
      // Referenced on purpose: an unanswered request is real pending work, so the
      // timeout must be able to fire and be reported instead of letting the host
      // drain its event loop and vanish.
      const timer = setTimeout(() => finish(reject, clientError('CODEX_APP_SERVER_TIMEOUT', `${method} timed out.`, { method })), timeoutMs);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      pending.set(id, {
        method,
        resolve: value => finish(resolve, value),
        reject: error => finish(reject, error)
      });
      try {
        send({ id, method, params });
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  // Fire-and-forget notification. Not part of the continuation path; exposed so a
  // host can complete the documented handshake by other means.
  function notify(method, params) {
    if (typeof method !== 'string' || method.length === 0) throw new TypeError('Invalid method.');
    if (params !== undefined && !record(params)) throw new TypeError('Invalid params.');
    if (state !== 'open') throw closedError();
    send(params === undefined ? { method } : { method, params });
  }

  function respond(id, result) {
    if (state !== 'open') throw closedError();
    send({ id, result });
  }

  function respondError(id, code, message, data) {
    if (state !== 'open') throw closedError();
    send({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  function send(message) {
    if (state !== 'open' || !child) throw closedError();
    try {
      child.stdin.write(JSON.stringify(message) + '\n');
    } catch (error) {
      throw clientError('CODEX_APP_SERVER_WRITE_FAILED', 'Failed to write to the Codex app server.', { cause: error });
    }
  }

  function closedError() {
    return clientError('CODEX_APP_SERVER_CLOSED', 'The Codex app server client is closed.', { exit: exitInfo });
  }

  function settleAll(error) {
    for (const entry of [...pending.values()]) entry.reject(error);
    pending.clear();
  }

  // -- framing --------------------------------------------------------------

  function onStdout(chunk) {
    outBuffer += decoderOut.write(chunk);
    let index;
    while ((index = outBuffer.indexOf('\n')) >= 0) {
      const line = outBuffer.slice(0, index).replace(/\r$/, '');
      outBuffer = outBuffer.slice(index + 1);
      if (line.length === 0) continue;
      onLine(line);
    }
    if (outBuffer.length > maxLineBytes) {
      onProtocolError('CODEX_APP_SERVER_LINE_TOO_LONG');
      outBuffer = '';
      try { child?.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }

  function onStderr(chunk) {
    if (maxStderrBytes === 0) return;
    const text = decoderErr.write(chunk);
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      stderrLines.push(line);
      stderrBytes += Buffer.byteLength(line) + 1;
      while ((stderrBytes > maxStderrBytes || stderrLines.length > 200) && stderrLines.length > 0) {
        stderrBytes -= Buffer.byteLength(stderrLines.shift()) + 1;
      }
    }
  }

  function onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      onProtocolError('CODEX_APP_SERVER_MALFORMED_LINE');
      return;
    }    if (!record(message)) {
      onProtocolError('CODEX_APP_SERVER_MALFORMED_MESSAGE');
      return;
    }
    const hasId = message.id !== undefined && message.id !== null;
    const isResponse = hasId && (message.result !== undefined || message.error !== undefined);
    if (isResponse) {
      onResponse(message);
      return;
    }
    if (hasId && typeof message.method === 'string') {
      handleServerRequest(message);
      return;
    }
    if (typeof message.method === 'string') {
      emit({ type: 'notification', method: message.method, params: record(message.params) ? message.params : {} });
      return;
    }
    onProtocolError('CODEX_APP_SERVER_MALFORMED_MESSAGE');
  }

  function onResponse(message) {
    const entry = pending.get(message.id);
    // A response to a request that already timed out or was aborted is dropped:
    // the caller was told the outcome is unknown and must reconcile.
    if (!entry) return;
    if (message.error !== undefined) {
      const error = record(message.error) ? message.error : {};
      entry.reject(clientError('CODEX_APP_SERVER_RPC_ERROR', 'The Codex app server rejected the request.', {
        // `rpc: true` is the contract `./client-continuation` reads to decide
        // that the server answered and therefore nothing was started.
        rpc: true,
        method: entry.method,
        rpcCode: Number.isSafeInteger(error.code) ? error.code : null,
        rpcMessage: typeof error.message === 'string' ? error.message : ''
      }));
      return;
    }
    entry.resolve(message.result);
  }

  // Server-initiated requests are never answered with an approval from here.
  // An unanswered approval request hangs the turn, so the default is an explicit
  // refusal the server can act on.
  function handleServerRequest(message) {
    const id = message.id;
    const method = message.method;
    let settled = false;
    const answer = message => {
      if (settled) return;
      settled = true;
      try { send(message); } catch { /* the caller already saw the failure */ }
    };
    const respondResult = result => answer({ id, result });
    const respondFailure = (code, text, data) => answer({
      id,
      error: { code: Number.isSafeInteger(code) ? code : METHOD_NOT_SUPPORTED, message: typeof text === 'string' ? text : 'refused', ...(data === undefined ? {} : { data }) }
    });
    // Only the method name and, when the server names one, the thread id reach
    // subscribers: an approval's params can carry a command line or a path.
    emit({
      type: 'server-request',
      id,
      method,
      ...(record(message.params) && typeof message.params.threadId === 'string'
        ? { threadId: message.params.threadId }
        : {})
    });
    if (!onServerRequest) {
      respondFailure(METHOD_NOT_SUPPORTED, 'resource-history-bridge does not answer this request.');
      return;
    }
    let outcome;
    try {
      outcome = onServerRequest({ id, method, params: record(message.params) ? message.params : {}, respond: respondResult, reject: respondFailure });
    } catch {
      respondFailure(METHOD_NOT_SUPPORTED, 'resource-history-bridge failed to handle this request.');
      return;
    }
    if (outcome === 'handled') return;
    Promise.resolve(outcome).then(
      value => { if (value !== 'handled') respondFailure(METHOD_NOT_SUPPORTED, 'resource-history-bridge does not answer this request.'); },
      () => respondFailure(METHOD_NOT_SUPPORTED, 'resource-history-bridge failed to handle this request.')
    );
  }

  // A line this client cannot parse cannot be correlated with any request, so
  // failing every live call over it would be wrong: the server may answer the
  // real request on the next line. It is reported and then left to the per-call
  // timeout, which produces an explicit error the caller can act on.
  function onProtocolError(code) {
    emit({ type: 'protocol-error', reason: code });
  }

  function subscribe(handler) {
    if (typeof handler !== 'function') throw new TypeError('Invalid subscriber.');
    subscribers.add(handler);
    return () => { subscribers.delete(handler); };
  }

  function emit(event) {
    if (subscribers.size === 0) return;
    const frozen = freeze({ ...event });
    for (const handler of [...subscribers]) {
      try { handler(frozen); } catch { /* a broken observer must not change the transport */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot reader: only what the server actually reports
// ---------------------------------------------------------------------------

function threadStatusType(status) {
  if (!record(status)) return 'unknown';
  return typeof status.type === 'string' ? status.type : 'unknown';
}

function itemStatus(item) {
  return record(item) && typeof item.status === 'string' ? item.status : null;
}

function digest(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

// A snapshot is an attestation, never a default. Every field is derived from a
// response this client read; when one cannot be derived the returned object
// simply does not carry it, and the continuation core stops with the reason
// recorded in `snapshotRefused`.
function createCodexSnapshotReader(options = {}) {
  if (!record(options)) throw new TypeError('Codex snapshot reader requires an options object.');
  const client = options.client;
  if (!record(client) || typeof client.call !== 'function') throw new TypeError('Codex snapshot reader requires client.call.');
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') throw new TypeError('Invalid snapshot clock.');
  const turnsLimit = integer(options.turnsLimit, 20, 1, 100, 'turnsLimit');
  // Outstanding approval/user-input requests the transport has seen and not seen
  // resolved; supplied by the caller that owns the subscription.
  const pendingApprovals = options.pendingApprovals ?? (() => 0);
  if (typeof pendingApprovals !== 'function') throw new TypeError('Invalid pendingApprovals.');
  // `true` only when the caller observed an error notification for this turn with
  // `willRetry: true` and has not seen the turn end since.
  const nativeRetryPending = options.nativeRetryPending ?? (() => false);
  if (typeof nativeRetryPending !== 'function') throw new TypeError('Invalid nativeRetryPending.');
  const onRefusal = options.onRefusal;

  let attestation = null;
  return Object.freeze({ read, getAttestation });

  function getAttestation() { return attestation; }

  function refuse(reason, proven) {
    if (typeof onRefusal === 'function') {
      try { onRefusal(reason); } catch { /* diagnostics only */ }
    }
    return freeze({ ok: false, snapshotRefused: reason, ...(proven ?? {}) });
  }

  async function read(context = {}) {
    const threadId = context.threadId;
    const failedTurnId = context.failedTurnId;
    const failedFingerprint = context.failedFingerprint;
    if (typeof threadId !== 'string' || threadId.length === 0
      || typeof failedTurnId !== 'string' || failedTurnId.length === 0
      || typeof failedFingerprint !== 'string' || failedFingerprint.length === 0) {
      return refuse('snapshot_context_invalid');
    }
    attestation = null;
    const signal = context.signal;

    // 1. Rejoin the thread. The server refuses to read a thread that is not
    //    loaded (`-32600 thread not loaded`), and the rejoin is also what makes
    //    `thread.status` authoritative for "is a turn running right now".
    let resumed;
    try {
      resumed = await client.call(METHODS.threadResume, { threadId, excludeTurns: true }, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      return refuse('thread_unreadable');
    }
    const thread = record(resumed) && record(resumed.thread) ? resumed.thread : null;
    if (!record(thread) || thread.id !== threadId) return refuse('thread_mismatch');
    const status = threadStatusType(thread.status);
    if (status === 'active') {
      // Proven: a turn is running. Not a candidate for any continuation.
      return refuse('turn_active', { durableCommitted: true, turnActive: true });
    }
    if (status !== 'idle') return refuse(`thread_status_${status}`, { durableCommitted: true, turnActive: false });

    // 2. The failed turn must still be the newest turn, and it must come back
    //    with its items, or nothing about tool state can be attested.
    let listed;
    try {
      listed = await client.call(METHODS.threadTurnsList, {
        threadId, limit: turnsLimit, sortDirection: 'desc', itemsView: 'full'
      }, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      return refuse('turns_unreadable', { durableCommitted: false, turnActive: false });
    }
    const turns = record(listed) && Array.isArray(listed.data) ? listed.data : null;
    if (turns === null || turns.length === 0) {
      return refuse('turn_not_found', { durableCommitted: false, turnActive: false });
    }
    const newest = turns[0];
    if (!record(newest) || typeof newest.id !== 'string' || newest.id.length === 0) {
      return refuse('turn_unreadable', { durableCommitted: false, turnActive: false });
    }
    if (newest.id !== failedTurnId) {
      // A newer turn exists. Whatever it is, this is not the failed turn's
      // snapshot and the native state did move on.
      return refuse('failed_turn_superseded', { durableCommitted: true, turnActive: false });
    }
    if (newest.status !== 'failed') {
      return refuse(`turn_status_${typeof newest.status === 'string' ? newest.status : 'unknown'}`, {
        durableCommitted: true, turnActive: false
      });
    }
    const target = turns.find(turn => record(turn) && turn.id === failedTurnId);
    if (!record(target)) return refuse('turn_unreadable', { durableCommitted: false, turnActive: false });
    // `itemsView` says how much of `items` the server actually returned. Without
    // full items there is no way to rule out an unsettled tool call.
    if (target.itemsView !== 'full' || !Array.isArray(target.items)) {
      return refuse('items_not_loaded', { durableCommitted: true, turnActive: false });
    }

    // 3. Tool state, read from the persisted items themselves.
    let unsettled = 0;
    const itemDigest = [];
    for (const item of target.items) {
      if (!record(item)) return refuse('items_unreadable', { durableCommitted: true, turnActive: false });
      const status = itemStatus(item);
      itemDigest.push([typeof item.type === 'string' ? item.type : 'unknown', status]);
      // An item that reported a status and never reached a terminal one is an
      // effect of unknown outcome. Items without a status have none by design
      // (messages, reasoning, plans).
      if (status !== null && !TERMINAL_ITEM_STATUSES.has(status)) unsettled += 1;
    }

    // 4. The fingerprint is recomputed from the server's own persisted turn, not
    //    copied from the caller's context. A mismatch means the caller is asking
    //    about a failure this thread no longer reports.
    const serverFingerprint = codexFailedFingerprint(threadId, failedTurnId, target.error);
    if (serverFingerprint !== failedFingerprint) {
      return refuse('snapshot_fingerprint_mismatch', { durableCommitted: true, turnActive: false });
    }

    const outstanding = pendingApprovals();
    const approvals = Number.isSafeInteger(outstanding) && outstanding > 0 ? outstanding : 0;
    const retryPending = nativeRetryPending(threadId, failedTurnId) === true;

    const snapshot = freeze({
      ok: true,
      snapshotId: digest([threadId, failedTurnId, 'failed', approvals, retryPending, itemDigest]),
      failedTurnId,
      failedFingerprint: serverFingerprint,
      // The failed turn came back from the server's own persisted turn list with
      // a terminal status, which is the durable commit this reader can see.
      durableCommitted: true,
      turnActive: false,
      pendingApproval: approvals > 0,
      pendingTools: unsettled > 0,
      startedToolCallsSettled: unsettled === 0,
      ambiguousSideEffects: unsettled > 0,
      nativeRetryPending: retryPending,
      readAtMs: clock(now())
    });
    // Recorded so `reconcileStart` can prove the thread was idle and which turn
    // was newest at the moment this snapshot authorized a send.
    attestation = freeze({ threadId, failedTurnId, newestTurnId: newest.id, atMs: clock(now()) });
    return snapshot;
  }
}

function clock(value) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new TypeError('Invalid clock.');
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// Automatic continuation over the real transport
// ---------------------------------------------------------------------------

function createCodexAutoContinue(options = {}) {
  if (!record(options)) throw new TypeError('Codex auto-continue requires an options object.');
  const client = options.client;
  if (!record(client) || typeof client.call !== 'function' || typeof client.subscribe !== 'function') {
    throw new TypeError('Codex auto-continue requires client.call and client.subscribe.');
  }
  const maxContinuations = integer(options.maxContinuations, 3, 1, 3, 'maxContinuations');
  const deadlineMs = integer(options.deadlineMs, 180000, 1, 180000, 'deadlineMs');
  const baseDelayMs = integer(options.baseDelayMs, undefined, 0, 30000, 'baseDelayMs');
  const maxDelayMs = integer(options.maxDelayMs, undefined, 0, 30000, 'maxDelayMs');
  const startTimeoutMs = integer(options.startTimeoutMs, undefined, 1, 300000, 'startTimeoutMs');
  const callTimeoutMs = integer(options.callTimeoutMs, 30000, 1, 300000, 'callTimeoutMs');
  const turnsLimit = integer(options.turnsLimit, 20, 1, 100, 'turnsLimit');
  const maxEvents = integer(options.maxEvents, 4, 1, 16, 'maxEvents');
  const watch = options.watch === true;
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') throw new TypeError('Invalid continuation clock.');
  const continuationText = options.continuationText ?? DEFAULT_CONTINUATION_TEXT;
  // Answering an approval or user-input request is the user's decision. This
  // adapter never provides a handler, and the transport refuses by default.
  if (options.onServerRequest !== undefined) {
    throw new TypeError('Codex auto-continue does not accept onServerRequest.');
  }

  let running = false;
  let closed = false;

  return Object.freeze({ run, describe });

  function describe() {
    return freeze({
      adapter: 'codex-app-server',
      transport: 'jsonrpc-stdio',
      methods: { ...METHODS },
      notifications: { ...NOTIFICATIONS },
      triggersOnlyOn: 'turn/completed with status "failed"',
      ignores: 'error notifications themselves, and any turn that is not terminal',
      snapshotSource: ['thread/resume thread.status', 'thread/turns/list with itemsView "full"', 'per-item status'],
      reconcileStart: 'thread/resume + thread/turns/list; only an idle thread whose newest turn is still the failed one proves "not started"',
      defaultLimits: { maxContinuations, deadlineMs, maxEvents, watch },
      notSupported: [
        'answering approval, user-input or MCP elicitation requests on the user\'s behalf',
        'replaying the original prompt, command or tool output',
        'starting a thread\'s first turn',
        'filesystem rollback, context truncation or quota bypass',
        'resending turn/start without an explicit "not started" proof'
      ]
    });
  }

  async function run(input = {}) {
    if (running) {
      const error = new Error('Codex auto-continue is already running.');
      error.code = 'TURN_CONTINUATION_BUSY';
      throw error;
    }
    if (closed) {
      const error = new Error('Codex auto-continue has already completed.');
      error.code = 'TURN_CONTINUATION_CLOSED';
      throw error;
    }
    if (!record(input)) throw new TypeError('Codex auto-continue requires a run input object.');
    const threadId = nonEmptyString(input.threadId, 'threadId');
    if (input.signal !== undefined && !isSignal(input.signal)) throw new TypeError('Invalid continuation signal.');
    if (input.onProgress !== undefined && typeof input.onProgress !== 'function') throw new TypeError('onProgress must be a function.');
    running = true;
    closed = true;

    const deadlineAtMs = clock(now()) + deadlineMs;
    const controller = new AbortController();
    let deadlineHit = false;
    // Referenced on purpose: while the watch is armed the watch is the pending
    // work. Unref'ing it would let a host with no other handles exit while a
    // continuation was still owed.
    const deadlineTimer = setTimeout(() => { deadlineHit = true; controller.abort(); }, deadlineMs);
    const external = input.signal;
    const forwardAbort = () => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', forwardAbort, { once: true });
    }
    const signal = controller.signal;
    const report = input.onProgress;

    // Observation state. Everything here is something the transport delivered or
    // the server answered; nothing is inferred.
    const willRetry = new Map();
    const terminal = new Map();
    const waiters = new Set();
    const approvals = new Set();
    const continuedTurnIds = new Set();
    const events = [];
    let continuations = 0;
    let lastTurn = null;
    let lastRefusal = null;
    const reader = createCodexSnapshotReader({
      client,
      now,
      turnsLimit,
      pendingApprovals: () => approvals.size,
      // Understood only for the thread being watched; another thread's retry flag
      // must never be read as this one's.
      nativeRetryPending: (thread, turn) => thread === threadId && willRetry.get(turn) === true,
      onRefusal: reason => { lastRefusal = reason; }
    });

    const emit = event => {
      const entry = freeze({ ...event });
      events.push(entry);
      if (!report) return;
      try { report(entry); } catch { /* progress is metadata only */ }
    };

    const unsubscribe = client.subscribe(event => {
      if (event.type === 'server-request') {
        // An unanswered approval means the turn is not free to continue. A
        // request the server tagged with another thread is not this thread's
        // blocker.
        if (event.threadId !== undefined && event.threadId !== threadId) return;
        approvals.add(event.id);
        return;
      }
      if (event.type !== 'notification') return;
      const params = event.params;
      if (event.method === NOTIFICATIONS.error) {
        if (params.threadId !== threadId || typeof params.turnId !== 'string') return;
        // `willRetry: true` says the native retry loop still owns this turn, so
        // this notification is not a failure and never triggers anything.
        willRetry.set(params.turnId, params.willRetry === true);
        emit({ type: 'error_observed', turnId: params.turnId, willRetry: params.willRetry === true });
        return;
      }
      if (event.method === NOTIFICATIONS.turnStarted) {
        if (params.threadId !== threadId || !record(params.turn)) return;
        if (typeof params.turn.id !== 'string') return;
        // A new attempt of the same turn resets the retry flag for it.
        willRetry.delete(params.turn.id);
        emit({ type: 'turn_started', turnId: params.turn.id });
        return;
      }
      if (event.method === NOTIFICATIONS.turnCompleted) {
        if (params.threadId !== threadId || !record(params.turn)) return;
        const turn = params.turn;
        if (typeof turn.id !== 'string' || typeof turn.status !== 'string') return;
        const record_ = freeze({
          id: turn.id,
          status: turn.status,
          errorCode: errorCodeOf(turn.error),
          // Kept for classification only (a definitive HTTP status can make even
          // a transient-looking code stop). Never written to an event.
          error: record(turn.error) ? { ...turn.error } : null
        });
        terminal.set(turn.id, record_);
        emit({ type: 'turn_terminal', turnId: turn.id, status: turn.status, code: record_.errorCode });
        for (const waiter of [...waiters]) {
          if (!waiter.match(turn.id, record_)) continue;
          waiters.delete(waiter);
          // A consumed terminal record is not replayed to the next waiter.
          terminal.delete(turn.id);
          waiter.done({ id: record_.id, status: record_.status, error: record_.error });
        }
        return;
      }
      if (event.method === NOTIFICATIONS.serverRequestResolved) {
        if (params.threadId !== undefined && params.threadId !== threadId) return;
        if (params.requestId !== undefined) approvals.delete(params.requestId);
      }
    });

    const finish = (status, reason, extra = {}) => freeze({
      ok: status === 'completed',
      status,
      reason,
      threadId,
      adapter: 'codex-app-server',
      transport: 'jsonrpc-stdio',
      continuations,
      lastTurn,
      lastRefusal,
      events,
      deadlineAtMs,
      // Unlike the bare adapter, this layer supplies every host seam itself
      // (transport, readSnapshot, reconcileStart), so a caller does not have to.
      hostIntegrationRequired: false,
      hostSeamsSupplied: ['rpc.call', 'subscribe', 'readSnapshot', 'reconcileStart'],
      ...extra
    });

    // The deadline timer and the per-wait timer below can expire in the same
    // millisecond, so a reason decided from the flag alone depends on which one
    // happened to run first. Both are the same event: the budget ran out.
    const budgetExpired = () => deadlineHit || clock(now()) >= deadlineAtMs;
    // A wait's own timer is measured from the same deadline, so it can fire a
    // millisecond before the deadline timer sets the flag. Reading only the flag
    // and the clock then calls an expired budget a cancellation, so a wait that
    // ended on its own timer says so instead.
    const waitReason = wait => (wait?.timedOut === true || budgetExpired() ? 'deadline_expired' : 'aborted');
    const stoppedBySignal = () => (budgetExpired()
      ? finish('stopped', 'deadline_expired')
      : finish('cancelled', 'aborted'));

    try {
      let next = await nextCandidate();
      for (let round = 0; ; round += 1) {
        if (!next.ok) {
          if (next.reason === 'aborted' || next.reason === 'deadline_expired') return stoppedBySignal();
          // Only "there is nothing to do" is idle. A thread this client could not
          // read is a stop, not a quiet exit.
          const idle = next.reason === 'no_failed_turn' || next.reason === 'turn_completed';
          return finish(idle ? 'idle' : 'stopped', next.reason);
        }
        if (signal.aborted) return stoppedBySignal();
        if (clock(now()) >= deadlineAtMs || deadlineHit) return finish('stopped', 'deadline_expired');
        if (continuations >= maxContinuations) return finish('exhausted', 'continuation_budget_exhausted');
        if (round >= maxEvents) return finish('stopped', 'event_budget_exhausted');
        const candidate = next.turn;
        if (continuedTurnIds.has(candidate.id)) return finish('stopped', 'failed_turn_already_continued');
        // Only a turn the native loop has finished with may be continued.
        if (willRetry.get(candidate.id) === true) return finish('stopped', 'native_retry_pending');
        // Classified here as well as in the adapter, so a cause that can never be
        // continued is reported without a "continuing" event that never happens.
        const failure = classifyContinuationFailure(adapterTurnError(candidate.error));
        if (failure.classification === 'stop') return finish('stopped', failure.reason);

        continuedTurnIds.add(candidate.id);
        emit({ type: 'continuation_requested', turnId: candidate.id, code: candidate.errorCode });
        const outcome = await runContinuation(candidate);
        if (outcome.lastTurn) lastTurn = outcome.lastTurn;
        continuations += outcome.continuations;
        emit({ type: 'continuation_finished', status: outcome.status, reason: outcome.reason, added: outcome.continuations });
        if (outcome.status === 'completed') return finish('completed', 'turn_completed');
        if (outcome.status === 'exhausted') return finish('exhausted', outcome.reason);
        if (outcome.status === 'cancelled') return stoppedBySignal();
        if (!watch || !RETRYABLE_STOPS.has(outcome.reason)) return finish('stopped', outcome.reason);
        // Watching again only ever acts on a *different* failed turn: the one
        // just handled stays in `continuedTurnIds`.
        next = await nextCandidate();
      }
    } finally {
      clearTimeout(deadlineTimer);
      if (external) external.removeEventListener('abort', forwardAbort);
      unsubscribe();
      running = false;
    }

    async function runContinuation(turn) {
      const remaining = maxContinuations - continuations;
      if (remaining <= 0) return { status: 'exhausted', reason: 'continuation_budget_exhausted', continuations: 0, lastTurn: null };
      const adapter = createCodexTurnContinuation({
        rpc: {
          call: (method, params, context) => client.call(method, params, {
            signal: context?.signal,
            timeoutMs: callTimeoutMs
          })
        },
        // The adapter's channel reads raw `{ method, params }` notifications.
        subscribe: handler => client.subscribe(event => {
          if (event.type === 'notification') handler({ method: event.method, params: event.params });
        }),
        readSnapshot: reader.read,
        reconcileStart,
        continuationText,
        maxContinuations: remaining,
        deadlineMs: Math.max(1, deadlineAtMs - clock(now())),
        ...(baseDelayMs === undefined ? {} : { baseDelayMs }),
        ...(maxDelayMs === undefined ? {} : { maxDelayMs }),
        ...(startTimeoutMs === undefined ? {} : { startTimeoutMs }),
        now
      });
      let result;
      try {
        result = await adapter.run({
          threadId,
          // The terminal turn exactly as `turn/completed` delivered it. No
          // `willRetry` key: a record that carries one is an error notification,
          // and the adapter refuses those outright.
          failedTurn: { threadId, turn: { id: turn.id, status: 'failed', error: adapterTurnError(turn.error) } },
          signal,
          onProgress: emit
        });
      } catch (error) {
        if (signal.aborted) return { status: 'cancelled', reason: 'aborted', continuations: 0, lastTurn: null };
        if (error?.code === AMBIGUOUS_START) return { status: 'stopped', reason: 'ambiguous_start', continuations: 0, lastTurn: null };
        return { status: 'stopped', reason: 'adapter_failed', continuations: 0, lastTurn: null };
      }
      return {
        status: result.status,
        reason: result.reason,
        continuations: Number.isSafeInteger(result.continuations) ? result.continuations : 0,
        lastTurn: result.lastTurn ?? null
      };
    }

    // Which turn, if any, is worth acting on. The newest turn on disk is the
    // starting point; a running turn is waited for; anything already handled is
    // skipped rather than continued twice.
    async function nextCandidate() {
      for (;;) {
        if (signal.aborted) return { ok: false, reason: budgetExpired() ? 'deadline_expired' : 'aborted' };
        const newest = await readNewestTurn();
        if (newest === undefined) return { ok: false, reason: 'thread_unreadable' };
        if (newest === null) return { ok: false, reason: 'no_failed_turn' };
        if (newest.status === 'inProgress') {
          const settled = await waitForTerminal(id => id === newest.id);
          if (settled?.stop) return { ok: false, reason: waitReason(settled) };
          if (settled.status === 'failed') {
            if (continuedTurnIds.has(settled.id)) continue;
            return { ok: true, turn: { id: settled.id, error: settled.error, errorCode: errorCodeOf(settled.error) } };
          }
          if (!watch) return { ok: false, reason: 'turn_completed' };
          continue;
        }
        if (newest.status === 'failed') {
          if (continuedTurnIds.has(newest.id)) {
            if (!watch) return { ok: false, reason: 'failed_turn_already_continued' };
            const later = await waitForTerminal(id => id !== newest.id);
            if (later?.stop) return { ok: false, reason: waitReason(later) };
            if (later.status === 'failed') {
              return { ok: true, turn: { id: later.id, error: later.error, errorCode: errorCodeOf(later.error) } };
            }
            continue;
          }
          return { ok: true, turn: { id: newest.id, error: newest.error, errorCode: errorCodeOf(newest.error) } };
        }
        // The newest turn ended well or was interrupted: nothing to continue.
        if (!watch) return { ok: false, reason: 'no_failed_turn' };
        const later = await waitForTerminal(id => id !== newest.id);
        if (later?.stop) return { ok: false, reason: waitReason(later) };
        if (later.status === 'failed') {
          return { ok: true, turn: { id: later.id, error: later.error, errorCode: errorCodeOf(later.error) } };
        }
      }
    }

    // `undefined` means the read failed, `null` means the thread has no turns.
    async function readNewestTurn() {
      let listed;
      try {
        listed = await client.call(METHODS.threadTurnsList, {
          threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded'
        }, { signal, timeoutMs: callTimeoutMs });
      } catch {
        return undefined;
      }
      const data = record(listed) && Array.isArray(listed.data) ? listed.data : null;
      if (data === null) return undefined;
      if (data.length === 0) return null;
      const turn = data[0];
      if (!record(turn) || typeof turn.id !== 'string' || typeof turn.status !== 'string') return undefined;
      return { id: turn.id, status: turn.status, error: record(turn.error) ? { ...turn.error } : null };
    }

    // Resolves with the next terminal turn matching `match`, or null when the
    // watch is aborted or its deadline passes.
    function waitForTerminal(match) {
      if (signal.aborted) return Promise.resolve({ stop: true, timedOut: false });
      // A turn can end between the state read above and this registration, so the
      // already-delivered terminal records are consulted first. Without this a
      // notification that landed in that window would be waited for forever.
      for (const [id, value] of terminal) {
        if (!match(id, value)) continue;
        terminal.delete(id);
        return Promise.resolve({ id, status: value.status, error: value.error });
      }
      return new Promise(resolve => {
        let settled = false;
        const done = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          waiters.delete(waiter);
          resolve(value);
        };
        const onAbort = () => done({ stop: true, timedOut: false });
        const timer = setTimeout(() => done({ stop: true, timedOut: true }), Math.max(1, deadlineAtMs - clock(now())));
        const waiter = { match, done };
        waiters.add(waiter);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }

    // Real proof that `turn/start` did or did not start. A turn id is returned
    // only for an active thread showing a turn newer than the failed one;
    // `not_started` only for an idle thread whose newest turn is still the failed
    // one. Everything else throws, and the adapter then stops rather than send.
    async function reconcileStart(context = {}) {
      if (context.method !== METHODS.turnStart) throw ambiguousStart();
      const attestation = reader.getAttestation();
      if (!attestation || attestation.threadId !== threadId) throw ambiguousStart();
      // The proof must come from this attempt, not from an earlier continuation.
      const freshness = (startTimeoutMs ?? 30000) + 5000;
      if (clock(now()) - attestation.atMs > freshness) throw ambiguousStart();
      let resumed;
      let listed;
      try {
        resumed = await client.call(METHODS.threadResume, { threadId, excludeTurns: true }, { signal, timeoutMs: callTimeoutMs });
        listed = await client.call(METHODS.threadTurnsList, {
          threadId, limit: 2, sortDirection: 'desc', itemsView: 'notLoaded'
        }, { signal, timeoutMs: callTimeoutMs });
      } catch {
        throw ambiguousStart();
      }
      const status = threadStatusType(record(resumed) && record(resumed.thread) ? resumed.thread.status : null);
      const data = record(listed) && Array.isArray(listed.data) ? listed.data : null;
      if (data === null || data.length === 0) throw ambiguousStart();
      const newest = data[0];
      if (!record(newest) || typeof newest.id !== 'string') throw ambiguousStart();
      if (status === 'active' && newest.id !== attestation.failedTurnId) {
        return { state: 'started', turnId: newest.id };
      }
      // Idle and still the same newest turn: the send never landed. A new turn
      // that already ended could have been anyone's, so it is not re-sent.
      if (status === 'idle' && newest.id === attestation.failedTurnId) return { state: 'not_started' };
      throw ambiguousStart();
    }
  }
}

// Stops that leave room for a *different* failed turn later in the same watch.
const RETRYABLE_STOPS = new Set(['ambiguous_start', 'adapter_failed', 'snapshot_unavailable']);

function errorCodeOf(error) {
  if (!record(error)) return null;
  const info = error.codexErrorInfo;
  if (typeof info === 'string' && info.length > 0) return info;
  if (record(info)) {
    const keys = Object.keys(info);
    if (keys.length === 1) return keys[0];
  }
  return null;
}

// The classifier view handed to `./client-continuation`. Two adjustments to the
// raw `TurnError`, both deliberate:
//   * `message` is dropped. It is upstream text and never needs to leave here.
//   * The upstream HTTP status is lifted out of the `codexErrorInfo` variant
//     object, because that module reads a top-level `httpStatusCode`. A
//     definitive 4xx then stops even when the variant name looks transient.
function adapterTurnError(error) {
  if (!record(error)) return null;
  const info = error.codexErrorInfo ?? null;
  const variant = record(info) ? info[Object.keys(info)[0]] : null;
  const httpStatusCode = Number.isSafeInteger(error.httpStatusCode)
    ? error.httpStatusCode
    : (record(variant) && Number.isSafeInteger(variant.httpStatusCode) ? variant.httpStatusCode : undefined);
  return httpStatusCode === undefined
    ? { codexErrorInfo: info }
    : { codexErrorInfo: info, httpStatusCode };
}

// The continuation core fingerprints a failed turn from its thread id, turn id,
// status and error code. Hosts and tests that need to compare against the
// snapshot attestation use this instead of copying the shape.
function codexFailedFingerprint(threadId, turnId, error) {
  return turnFingerprint({ threadId, turnId, status: 'failed', error: { code: errorCodeOf(error) } });
}

module.exports = {
  createCodexAppServerClient,
  createCodexSnapshotReader,
  createCodexAutoContinue,
  codexFailedFingerprint,
  errorCodeOf,
  METHODS,
  NOTIFICATIONS,
  DEFAULT_ARGS
};
