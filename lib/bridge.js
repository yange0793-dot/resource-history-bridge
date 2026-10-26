'use strict';

const http = require('node:http');
const https = require('node:https');
const { TextDecoder } = require('node:util');
const { randomUUID } = require('node:crypto');
const { normalizeRecoveryOptions, isScopedHistoryFailure, requestsLegacyBudget } = require('./recovery');
const { createRecoverySession } = require('./recovery-session');
const { resolveRequestProfile } = require('./request-profile');
const { version } = require('../package.json');
const { validateAgentRouterUpstream, isAgentRouterUpstream } = require('./agentrouter');
const { createDiagnostics } = require('./diagnostics');
const { setTimeout: delay } = require('node:timers/promises');
const { isKnownResourceError } = require('./history');
const { isEncryptedReasoningError } = require('./encrypted-reasoning');
const { findFrameEnd, classifyFrame } = require('./sse');
const { inspectResponseJson, createOutputInspector, parseSseFrame, isSafeHeartbeatFrame } = require('./output');
const { messagesToResponses, createMessagesRenderer } = require('./messages');

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
const ENDPOINTS = new Set(['responses', 'responses/compact', 'chat/completions', 'messages']);

function boundedInteger(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${name}.`);
  return value;
}

function configure(options = {}) {
  const upstream = validateAgentRouterUpstream(options.upstream);
  upstream.pathname = upstream.pathname.replace(/\/$/, '');
  const agentRouterRecovery = isAgentRouterUpstream(upstream);
  const host = options.host || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new TypeError('Only loopback binding is supported.');
  const keyHeader = options.keyHeader || 'authorization';
  if (!['authorization', 'api-key', 'x-api-key'].includes(keyHeader)) throw new TypeError('Unsupported key header.');
  if (options.apiKey != null && (typeof options.apiKey !== 'string' || /[\r\n]/.test(options.apiKey))) throw new TypeError('Invalid API key.');
  if (options.userAgent !== undefined && (typeof options.userAgent !== 'string' || /[\r\n]/.test(options.userAgent))) throw new TypeError('Invalid user agent.');
  const historyMode = options.historyMode || 'auto';
  if (!['auto', 'minimal', 'codex', 'harness'].includes(historyMode)) throw new TypeError('Unsupported history mode.');
  const upstreamProtocol = options.upstreamProtocol || (['minimal', 'codex', 'harness'].includes(options.historyMode) ? 'passthrough' : 'auto');
  if (!['auto', 'passthrough', 'responses'].includes(upstreamProtocol)) throw new TypeError('Unsupported upstream protocol.');
  const reasoningShape = options.reasoningShape || 'summary';
  if (!['summary', 'content'].includes(reasoningShape)) throw new TypeError('Unsupported reasoning shape.');
  const historyStrategy = options.historyStrategy || 'on-error';
  if (!['on-error', 'portable'].includes(historyStrategy)) throw new TypeError('Unsupported history strategy.');
  if (options.generic400Projection !== undefined && typeof options.generic400Projection !== 'boolean') throw new TypeError('Invalid generic400Projection.');
  if (options.automaticRecovery !== undefined && typeof options.automaticRecovery !== 'boolean') throw new TypeError('Invalid automaticRecovery.');
  if (options.transparentRecovery !== undefined && typeof options.transparentRecovery !== 'boolean') throw new TypeError('Invalid transparentRecovery.');
  const automaticRecovery = options.automaticRecovery ?? historyMode === 'harness';
  // Undefined keeps the per-request default (on for auto/codex/harness, off for
  // minimal and the converted Messages profile). Explicit values win. A caller
  // that explicitly set a pre-transparent budget keeps that wider legacy shape
  // instead of failing startup on the tighter transparent envelope.
  const transparentRecovery = options.transparentRecovery;
  const legacyBudget = transparentRecovery === undefined && requestsLegacyBudget(options);
  const transparentByMode = (transparentRecovery ?? historyMode !== 'minimal') && !legacyBudget;
  // An unset setting stays undefined so each request can apply its own profile
  // (converted Messages are minimal). A legacy-budget caller is pinned off here
  // or the per-request default would re-enable transparent recovery without a
  // compatible shared policy.
  const configuredTransparent = transparentRecovery === undefined && legacyBudget ? false : transparentRecovery;
  const legacyTimeoutMs = boundedInteger(options.timeoutMs, 180000, 1, 1800000, 'timeoutMs');
  const legacyResourceAttempts = boundedInteger(options.resourceAttempts, 10, 1, 100, 'resourceAttempts');
  const legacyRetryDelayMs = boundedInteger(options.retryDelayMs, 1000, 0, 60000, 'retryDelayMs');
  const recoveryPolicy = automaticRecovery || transparentByMode ? normalizeRecoveryOptions({
    totalAttempts: options.totalAttempts,
    transientAttempts: options.transientAttempts,
    resourceAttempts: options.resourceAttempts,
    deadlineMs: options.timeoutMs,
    baseDelayMs: options.retryDelayMs,
    maxDelayMs: options.maxRetryDelayMs,
    jitterRatio: options.retryJitterRatio
  }) : null;
  const timeoutMs = recoveryPolicy ? recoveryPolicy.deadlineMs : legacyTimeoutMs;
  const resourceAttempts = recoveryPolicy ? recoveryPolicy.resourceAttempts : legacyResourceAttempts;
  const retryDelayMs = recoveryPolicy ? recoveryPolicy.baseDelayMs : legacyRetryDelayMs;
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const sleep = options.sleep || ((ms, signal) => delay(ms, undefined, { signal }));
  if (![now, random, sleep].every(value => typeof value === 'function')) throw new TypeError('Invalid injected recovery dependencies.');
  return {
    upstream, agentRouterRecovery, host, keyHeader, apiKey: options.apiKey, userAgent: options.userAgent,
    upstreamProtocol: agentRouterRecovery ? upstreamProtocol : 'passthrough', reasoningShape, historyMode,
    historyStrategy, generic400Projection: agentRouterRecovery && (options.generic400Projection ?? historyMode === 'harness'),
    automaticRecovery: agentRouterRecovery && automaticRecovery, transparentRecovery: agentRouterRecovery ? configuredTransparent : false,
    recoveryPolicy, timeoutMs, resourceAttempts, retryDelayMs, now, random, sleep,
    legacyTimeoutMs, legacyResourceAttempts, legacyRetryDelayMs,
    requestLimit: boundedInteger(options.requestLimit, 8 * 1024 * 1024, 1, 64 * 1024 * 1024, 'requestLimit'),
    bufferLimit: boundedInteger(options.bufferLimit, 64 * 1024, 1, 64 * 1024, 'bufferLimit')
  };
}

function safeHeaders(headers, preserveLength = false) {
  const excluded = new Set(HOP_HEADERS);
  if (preserveLength) excluded.delete('content-length');
  for (const token of String(headers.connection || '').split(',')) excluded.add(token.trim().toLowerCase());
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!excluded.has(key.toLowerCase()) && value !== undefined) result[key] = value;
  }
  return result;
}

function localError(res, status, code, message, type = 'resource_history_bridge_error') {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  const body = JSON.stringify({ error: { type, code, message } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

function allowedHost(value, port) {
  if (typeof value !== 'string') return false;
  return ['127.0.0.1', 'localhost', '[::1]'].some(host => value.toLowerCase() === `${host}:${port}` || (port === 80 && value.toLowerCase() === host));
}

function endpointFor(rawUrl, preserveBeta = false) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) return null;
  const endpoint = rawUrl.replace(/^\/(?:v1\/)?/, '');
  // Claude Code's fixed SDK flag is preserved only for native passthrough.
  if (endpoint === 'messages?beta=true') return preserveBeta ? endpoint : 'messages';
  return ENDPOINTS.has(endpoint) ? endpoint : null;
}

async function writeChunk(res, chunk) {
  if (res.destroyed) throw new Error('client_closed');
  if (!res.write(chunk)) {
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        res.off('drain', drained);
        res.off('close', closed);
        res.off('error', failed);
      };
      const drained = () => { cleanup(); resolve(); };
      const closed = () => { cleanup(); reject(new Error('client_closed')); };
      const failed = () => { cleanup(); reject(new Error('client_failed')); };
      res.once('drain', drained);
      res.once('close', closed);
      res.once('error', failed);
      if (res.destroyed) closed();
    });
  }
}

function partialIsUnknown(buffer) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  const lines = text.split(/\r\n|\r|\n/);
  return lines.some(line => line && !['data:', 'event:'].some(prefix => line.startsWith(prefix) || prefix.startsWith(line)));
}

// The legacy inspector counts printable text. Recovery treats even whitespace
// as generation, without changing the converter's public inspection behavior.
function textStarted(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(textStarted);
  for (const key of ['text', 'thinking', 'refusal', 'delta', 'reasoning_content', 'reasoning', 'content', 'partial_json', 'arguments', 'name']) {
    if (typeof value[key] === 'string' && value[key].length) return true;
  }
  if (typeof value.output_text === 'string' && value.output_text.length) return true;
  return ['response', 'output', 'item', 'part', 'content', 'summary', 'message', 'content_block', 'choices', 'function', 'tool_calls', 'function_call', 'delta']
    .some(key => value[key] && typeof value[key] === 'object' && textStarted(value[key]));
}

function parseJson(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { return undefined; }
}

function inspectJson(protocol, payload, config, statusCode) {
  if (protocol === 'responses' && isEncryptedReasoningError(payload, statusCode, config.upstream)) {
    if (payload.type === 'response.failed') return createOutputInspector('responses').observe(payload);
    if (payload.status !== 'failed') return { terminal: true, error: true, hasOutput: false, unknown: false };
  }
  // Error envelopes are not Response objects. Recognized tracing fields are
  // metadata, but unexpected envelope content remains an output barrier.
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.error != null && !payload.status && !payload.output) {
    return { terminal: true, error: true, hasOutput: false, unknown: Object.keys(payload).some(key => !['error', 'type', 'sequence_number', 'request_id', 'trace_id'].includes(key)) };
  }
  return inspectResponseJson(protocol, payload);
}

function upstreamRequest(config, endpoint, rawBody, requestHeaders, signal) {
  const target = new URL(config.upstream);
  const [pathname, query] = endpoint.split('?');
  target.pathname = `${target.pathname}/${pathname}`.replace(/\/{2,}/g, '/');
  if (query) target.search = query;
  const headers = safeHeaders(requestHeaders);
  headers['content-length'] = String(rawBody.length);
  // Recovery inspection requires uncompressed content; passthrough does not.
  if (config.agentRouterRecovery) headers['accept-encoding'] = 'identity';
  if (config.userAgent !== undefined) headers['user-agent'] = config.userAgent;
  if (config.apiKey !== undefined) {
    delete headers.authorization;
    delete headers['api-key'];
    delete headers['x-api-key'];
    headers[config.keyHeader] = config.keyHeader === 'authorization' ? `Bearer ${config.apiKey}` : config.apiKey;
  }
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, { method: 'POST', headers, signal }, response => resolve({ request, response }));
    request.on('error', reject);
    request.end(rawBody);
  });
}

function conversionSink(res, body, statusCode) {
  let started = false;
  const start = (text = '') => {
    if (started || res.destroyed) return;
    let status = statusCode >= 200 && statusCode < 300 ? 200 : statusCode;
    try {
      const payload = body.stream ? parseSseFrame(Buffer.from(text)).event : JSON.parse(text);
      if (status === 200 && (payload?.type === 'error' || payload?.error)) {
        const type = payload.error?.type;
        status = type === 'rate_limit_error' ? 429 : type === 'authentication_error' ? 401 : type === 'permission_error' ? 403 : type === 'invalid_request_error' ? 400 : 502;
      }
    } catch { /* Regular data uses the upstream success status. */ }
    res.writeHead(status, { 'content-type': body.stream ? 'text/event-stream' : 'application/json', 'cache-control': 'no-store' });
    started = true;
  };
  const renderer = createMessagesRenderer({
    stream: body.stream === true, model: body.model, tools: body.tools,
    write(text) { start(text); if (!res.destroyed) res.write(text); },
    end() { start(); if (!res.destroyed) res.end(); }
  });
  return { renderer, started: () => started };
}

async function relayPassthrough(config, endpoint, rawBody, headers, res, signal) {
  const { request, response } = await upstreamRequest(config, endpoint, rawBody, headers, signal);
  try {
    res.writeHead(response.statusCode, safeHeaders(response.headers, true));
    res.flushHeaders();
    for await (const chunk of response) await writeChunk(res, chunk);
    if (response.complete) res.end();
    else res.destroy();
    return { statusCode: response.statusCode, headers: response.headers };
  } finally {
    if (!response.complete) response.destroy();
    request.destroy();
  }
}

// Only metadata and complete pre-output failures are held. The returned relay
// closes over original bytes/headers so a declined retry never invents an error.
async function relayAttempt(config, endpoint, rawBody, headers, res, signal, messagesBody) {
  const convert = Boolean(messagesBody);
  const outgoingHeaders = { ...headers };
  if (convert && config.apiKey === undefined && !outgoingHeaders.authorization && typeof outgoingHeaders['x-api-key'] === 'string') {
    outgoingHeaders.authorization = `Bearer ${outgoingHeaders['x-api-key']}`;
    delete outgoingHeaders['x-api-key'];
  }
  let request, response;
  try { ({ request, response } = await upstreamRequest(config, convert ? 'responses' : endpoint, rawBody, outgoingHeaders, signal)); } catch (error) {
    if (signal.aborted) throw error;
    return { failure: { error, failureKind: 'pre_output_connection_failure', inspectionComplete: true, responseComplete: false, complete: true,
      output: { hasOutput: false, unknown: false, committed: false } } };
  }
  const statusCode = response.statusCode;
  const responseHeaders = safeHeaders(response.headers, true);
  delete responseHeaders['x-rhb-recovery'];
  if (config.encryptedReasoningDropped) responseHeaders['x-rhb-recovery'] = 'encrypted-reasoning-dropped';
  const successful = statusCode >= 200 && statusCode < 300;
  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase();
  const protocol = convert || endpoint.startsWith('responses') ? 'responses' : endpoint === 'messages' ? 'messages' : 'chat';
  const sse = contentType.startsWith('text/event-stream');
  const json = /\bapplication\/(?:[\w.-]+\+)?json\b/.test(contentType);
  let mode = sse && !successful ? 'prefix' : sse ? 'sse' : 'json';
  let committed = false, held = [], events = [], size = 0, pending = Buffer.alloc(0), terminalPayload;
  let retryBlocked = encoding !== 'identity' || !sse && !json && (successful || statusCode === 400);
  const output = createOutputInspector(protocol);
  let outputStarted = false, unknown = false;
  const sink = convert ? conversionSink(res, messagesBody, statusCode) : null;
  const commit = async () => {
    if (committed) return;
    committed = true;
    retryBlocked = true;
    if (convert && mode === 'sse') {
      for (const event of events) sink.renderer.handle(event);
      events = [];
      held = [];
    } else if (!convert) {
      res.writeHead(statusCode, responseHeaders);
      for (const chunk of held) await writeChunk(res, chunk);
      held = [];
    }
  };
  const conversionFailure = () => {
    if (sink.started()) sink.renderer.fail('The upstream stream ended without a valid, convertible response.', 'upstream_transport');
    else localError(res, 502, 'upstream_transport', 'The upstream stream ended without a valid, convertible response.');
  };
  const relay = async (complete = response.complete) => {
    if (res.destroyed || res.writableEnded) return;
    if (!convert) {
      await commit();
      if (complete) res.end();
      else { res.flushHeaders(); res.destroy(); }
      return;
    }
    if (mode === 'sse') {
      await commit();
      if (!complete || pending.length) conversionFailure();
      else sink.renderer.finish();
      return;
    }
    const bytes = Buffer.concat(held, size);
    const payload = parseJson(bytes);
    if (!successful) {
      // Keep real upstream JSON errors (even mislabeled SSE) as JSON, matching
      // the established opt-in Messages conversion compatibility path.
      res.writeHead(statusCode, { ...responseHeaders, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) });
      res.end(bytes);
    } else if (!complete || payload === undefined) conversionFailure();
    else {
      const state = inspectResponseJson('responses', payload);
      if (!['completed', 'incomplete', 'failed'].includes(payload.status) || !state.terminal || payload.status !== 'failed' && !Array.isArray(payload.output)) {
        localError(res, 502, 'invalid_upstream_completion', 'The upstream JSON did not contain a valid terminal Responses payload.');
      } else {
        sink.renderer.handle({ type: `response.${payload.status}`, response: payload });
        sink.renderer.finish();
      }
    }
  };
  const processFrames = async () => {
    let boundary;
    while ((boundary = findFrameEnd(pending))) {
      const frame = pending.subarray(0, boundary.end);
      pending = pending.subarray(boundary.end);
      const parsed = parseSseFrame(frame);
      // A verified comment-only frame (heartbeat/keepalive) carries no data, no
      // event and no unknown field. Under active recovery it is transport
      // metadata, not model output, so it must not commit a replay barrier.
      // Legacy resource-only clients keep treating every comment as a barrier.
      const safeHeartbeat = (config.automaticRecovery || config.transparentRecovery) && isSafeHeartbeatFrame(parsed);
      if (!parsed.ok || parsed.unknown || parsed.comment && parsed.event !== null && !safeHeartbeat) {
        unknown = true;
        await commit();
        if (convert && (!parsed.ok || parsed.unknown)) throw new Error('invalid_upstream_sse');
      }
      if (!parsed.event) {
        if (!safeHeartbeat) { unknown = true; await commit(); }
        continue;
      }
      const event = parsed.event;
      if (!committed) {
        // OpenAI's native SSE reader also accepts unnamed { error } envelopes.
        // Normalize inspection only; held bytes and the final error stay original.
        const encryptedError = endpoint === 'responses' && !convert && isEncryptedReasoningError(event, statusCode, config.upstream);
        const nativeHistoryError = (endpoint === 'responses' || convert)
          && (isKnownResourceError(event) || isScopedHistoryFailure(event, statusCode, config.upstream) || encryptedError);
        const unnamedError = event.type === undefined && event.error != null
          && (encryptedError || Object.keys(event).length === 1
            && (nativeHistoryError || (config.automaticRecovery || config.transparentRecovery) && !convert && endpoint === 'responses'));
        // The cipher matcher already validates complete error fields. Normalize
        // only inspector metadata, never the bytes returned to the client.
        const inspectedEvent = encryptedError && event.type !== 'response.failed'
          ? { type: 'error', error: event.error || event }
          : unnamedError ? { type: 'error', error: event.error } : event;
        const state = output.observe(inspectedEvent);
        outputStarted ||= state.hasOutput || textStarted(event);
        unknown ||= state.unknown;
        events.push(event);
        if (state.terminal && event.type !== '__done__') terminalPayload = event;
        // A terminal failure is held just like metadata until EOF. Trailing
        // output/unknown frames are inspected before any recovery decision.
        const legacyCommit = !config.automaticRecovery && !config.transparentRecovery && !convert && !nativeHistoryError && classifyFrame(frame) === 'commit';
        if (outputStarted || unknown || legacyCommit || !state.hold && !state.terminal) await commit();
      } else if (convert) sink.renderer.handle(event);
    }
    if (!committed && partialIsUnknown(pending)) {
      unknown = true;
      await commit();
    }
  };
  try {
    if (convert && encoding !== 'identity') {
      localError(res, 502, 'compressed_conversion', 'The upstream returned compressed content that cannot be converted.');
      return { statusCode, headers: response.headers };
    }
    for await (const chunk of response) {
      if (committed && !convert) { await writeChunk(res, chunk); continue; }
      size += chunk.length;
      if (convert && mode !== 'sse' && size > config.requestLimit) throw new Error('conversion_body_too_large');
      if (!committed) held.push(chunk);
      else if (convert && mode !== 'sse') held.push(chunk);
      if (size > config.bufferLimit || retryBlocked) await commit();
      if (!convert && committed) continue;
      if (mode === 'json') continue;
      pending = Buffer.concat([pending, chunk]);
      if (convert && pending.length > config.requestLimit) throw new Error('conversion_frame_too_large');
      if (mode === 'prefix') {
        const first = pending.findIndex(byte => ![0x20, 0x09, 0x0a, 0x0d].includes(byte));
        if (first === -1) continue;
        mode = pending[first] === 0x7b ? 'json' : 'sse';
        if (mode === 'json') { pending = Buffer.alloc(0); continue; }
      }
      await processFrames();
    }
    if (committed) { await relay(); return { statusCode, headers: response.headers }; }
    const bytes = Buffer.concat(held, size);
    let payload = terminalPayload;
    if (mode === 'json') {
      payload = parseJson(bytes);
      if (payload !== undefined) {
        const inspection = inspectJson(protocol, payload, config, statusCode);
        outputStarted ||= inspection.hasOutput || textStarted(payload);
        unknown ||= inspection.unknown;
      } else if (successful || json || sse || statusCode === 400) unknown = true;
    } else if (pending.length) unknown = true;
    const failure = {
      statusCode, headers: response.headers, payload, upstream: config.upstream,
      inspectionComplete: true, responseComplete: response.complete, complete: true,
      output: { ...output.result(), hasOutput: outputStarted, unknown: unknown || retryBlocked
        || !response.complete && isEncryptedReasoningError(payload, statusCode, config.upstream), committed },
      outputStarted, unknownOutput: unknown || retryBlocked
        || !response.complete && isEncryptedReasoningError(payload, statusCode, config.upstream),
      ...(mode === 'sse' && !terminalPayload && !pending.length ? { failureKind: 'pre_output_disconnect' } : {})
    };
    // Native Responses requires a terminal event even when HTTP ends cleanly.
    // Recovery only replays a fully inspected pre-output EOF; other paths retain
    // their passthrough policy and exhaustion relays the actual last stream.
    if (response.complete && mode === 'sse' && !terminalPayload
      && (!config.automaticRecovery || convert || endpoint !== 'responses')) delete failure.failureKind;
    return { statusCode, headers: response.headers, failure, relay };
  } catch (error) {
    if (signal.aborted) throw error;
    if (!(config.automaticRecovery || config.transparentRecovery) && !committed) {
      if (convert) conversionFailure();
      else localError(res, 502, 'upstream_transport', 'The upstream connection failed or ended before its body completed.');
      return { statusCode, headers: response.headers };
    }
    if (committed || outputStarted || unknown || pending.length || mode !== 'sse' && size) {
      if (convert) conversionFailure();
      else if (committed) res.destroy();
      else await relay(false);
      return { statusCode, headers: response.headers };
    }
    return {
      statusCode, headers: response.headers,
      failure: { statusCode, headers: response.headers, payload: terminalPayload, error, failureKind: 'pre_output_disconnect',
        inspectionComplete: true, responseComplete: false, complete: true,
        output: { ...output.result(), hasOutput: outputStarted, unknown: unknown || retryBlocked
          || isEncryptedReasoningError(terminalPayload, statusCode, config.upstream), committed },
        upstream: config.upstream, unknownOutput: isEncryptedReasoningError(terminalPayload, statusCode, config.upstream) },
      relay: convert ? async () => conversionFailure() : async () => relay(false)
    };
  } finally {
    if (!response.complete) response.destroy();
    request.destroy();
  }
}

async function relayFailure(result, res, projectionError) {
  if (projectionError) localError(res, 409, projectionError.code, projectionError.message);
  else if (result.relay) await result.relay();
  else localError(res, 502, 'upstream_transport', 'The upstream connection failed before a response was received.');
}

async function sleepWithAbort(config, milliseconds, signal) {
  signal.throwIfAborted();
  let aborted;
  const stopped = new Promise((_, reject) => {
    aborted = () => reject(signal.reason || new Error('aborted'));
    signal.addEventListener('abort', aborted, { once: true });
  });
  try { await Promise.race([config.sleep(milliseconds, signal), stopped]); } finally { signal.removeEventListener('abort', aborted); }
  signal.throwIfAborted();
}

function createBridge(options = {}) {
  const bridgeConfig = configure(options);
  const config = bridgeConfig;
  const diagnostics = createDiagnostics(options.diagnostics);
  const controllers = new Set();
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    // A premature downstream disconnect can error independently of close.
    res.on('error', () => {});
    const port = req.socket.localPort;
    if (!allowedHost(req.headers.host, port) || req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
      localError(res, 403, 'local_only', 'Only non-browser loopback clients are supported.');
      req.resume();
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      const body = JSON.stringify({ service: 'resource-history-bridge', version, status: 'ready' });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
      res.end(body);
      req.resume();
      return;
    }
    const endpoint = endpointFor(req.url, !bridgeConfig.agentRouterRecovery);
    if (req.method !== 'POST' || !endpoint) {
      localError(res, 404, 'unsupported_endpoint', 'Use POST /v1/responses, /v1/responses/compact, /v1/chat/completions or /v1/messages.');
      req.resume();
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))
      || bridgeConfig.agentRouterRecovery && req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      localError(res, 415, 'json_required', bridgeConfig.agentRouterRecovery ? 'An uncompressed application/json body is required.' : 'An application/json body is required.');
      req.resume();
      return;
    }
    // Harness continuity recovery is native Responses-only. Other protocols
    // keep their compatibility path unless explicitly opted into recovery.
    const profile = resolveRequestProfile({ endpoint, upstream: bridgeConfig.upstream,
      historyMode: bridgeConfig.historyMode, upstreamProtocol: bridgeConfig.upstreamProtocol });
    const automaticRecovery = bridgeConfig.automaticRecovery && (endpoint === 'responses' || options.automaticRecovery === true);
    // Converted Messages keep the client's own retry loop; transparent recovery
    // is native Responses-only even when a caller asks for it globally.
    const transparentRecovery = profile.convert ? false
      : bridgeConfig.transparentRecovery === undefined
        ? profile.historyMode !== 'minimal' : bridgeConfig.transparentRecovery;
    const recoveryActive = automaticRecovery || transparentRecovery;
    const requestTimeoutMs = recoveryActive && bridgeConfig.recoveryPolicy
      ? bridgeConfig.recoveryPolicy.deadlineMs : bridgeConfig.legacyTimeoutMs;
    const config = { ...bridgeConfig, historyMode: profile.historyMode, automaticRecovery, transparentRecovery,
      timeoutMs: requestTimeoutMs, resourceAttempts: bridgeConfig.legacyResourceAttempts, retryDelayMs: bridgeConfig.legacyRetryDelayMs };
    const controller = new AbortController();
    controllers.add(controller);
    const requestId = randomUUID();
    const startedAtMs = config.now();
    let state = { attempt: 1, startedAtMs, deadlineAtMs: startedAtMs + requestTimeoutMs };
    let timedOut = false, lastResult;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      if (!req.complete || !recoveryActive) localError(res, 504, 'timeout', 'The total request deadline expired.');
      if (!req.complete) req.destroy();
    }, requestTimeoutMs);
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', cancel);
    res.once('close', cancel);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > config.requestLimit) {
          localError(res, 413, 'request_too_large', 'The request exceeds the configured byte limit.');
          req.resume();
          return;
        }
        chunks.push(chunk);
      }
      const rawBody = Buffer.concat(chunks, size);
      if (!config.agentRouterRecovery) {
        const attemptId = randomUUID(), startedAt = config.now();
        diagnostics.emit(() => ({ type: 'attempt_start', requestId, attemptId, attempt: 1, headers: req.headers, budget: state }));
        const result = await relayPassthrough(config, endpoint, rawBody, req.headers, res, controller.signal);
        diagnostics.emit(() => ({ type: 'attempt_result', requestId, attemptId, attempt: 1, statusCode: result.statusCode, durationMs: Math.max(0, config.now() - startedAt), headers: result.headers }));
        return;
      }
      const body = parseJson(rawBody);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        localError(res, 400, 'invalid_json', 'The request body must be a valid JSON object.');
        return;
      }
      const convert = profile.convert;
      let upstreamBody = body;
      try { if (convert) upstreamBody = messagesToResponses(body, { reasoningShape: config.reasoningShape }); } catch (error) {
        localError(res, 400, error.code || 'unsupported_messages_content', error.message);
        return;
      }
      const originalHeaders = Object.freeze({ ...req.headers });
      // The first clock read keeps body parsing/conversion inside the original
      // request deadline. Subsequent session reads use the live injected clock.
      let initializing = true;
      const session = createRecoverySession({
        upstream: config.upstream, endpoint, body: upstreamBody,
        rawBody: convert ? Buffer.from(JSON.stringify(upstreamBody)) : rawBody,
        historyMode: config.historyMode, converted: convert, automaticRecovery: config.automaticRecovery,
        transparentRecovery: config.transparentRecovery,
        generic400Projection: config.generic400Projection, historyStrategy: config.historyStrategy,
        resourceAttempts: config.resourceAttempts, retryDelayMs: config.retryDelayMs,
        timeoutMs: config.timeoutMs, recoveryPolicy: config.recoveryPolicy,
        now: () => initializing ? startedAtMs : config.now(), random: config.random
      });
      initializing = false;
      let current = session.current();
      state = current.state;
      if (current.projection) diagnostics.emit(() => ({ type: 'projection', requestId, attempt: state.attempt, projection: current.projection }));
      while (!controller.signal.aborted) {
        if (config.now() >= state.deadlineAtMs) { timedOut = true; controller.abort(); break; }
        lastResult = undefined;
        const attemptId = randomUUID(), startedAt = config.now();
        const attempt = state.attempt;
        diagnostics.emit(() => ({ type: 'attempt_start', requestId, attemptId, attempt, headers: req.headers, request: current.body, budget: state }));
        const result = await relayAttempt(config, endpoint, current.rawBody, originalHeaders, res, controller.signal, convert ? body : null);
        diagnostics.emit(() => ({ type: 'attempt_result', requestId, attemptId, attempt: state.attempt, statusCode: result.statusCode, durationMs: Math.max(0, config.now() - startedAt), headers: result.headers, error: result.failure?.payload ?? result.failure?.error }));
        if (!result.failure) return;
        lastResult = result;
        if (controller.signal.aborted) break;
        const decision = session.decide({ ...result.failure, attempt });
        if (decision.projection) diagnostics.emit(() => ({ type: decision.projection.lossy && decision.retry ? 'encrypted_reasoning_downgrade' : 'projection',
          requestId, attemptId, attempt, projection: decision.projection }));
        if (decision.lossy) {
          config.encryptedReasoningDropped = true;
          if (!res.headersSent) res.setHeader('x-rhb-recovery', 'encrypted-reasoning-dropped');
        }
        if (config.automaticRecovery || config.transparentRecovery) diagnostics.emit(() => ({ type: 'recovery', requestId, attemptId, attempt, classification: decision.classification, retry: decision, budget: state }));
        state = decision.nextState;
        if (!decision.retry) {
          await relayFailure(result, res, decision.projectionError);
          return;
        }
        if (decision.delayMs) await sleepWithAbort(config, decision.delayMs, controller.signal);
        current = session.current();
      }
      if (timedOut) {
        if (lastResult?.relay) await lastResult.relay();
        else localError(res, 504, 'timeout', 'The total request deadline expired.');
      }
    } catch (error) {
      diagnostics.emit(() => ({ type: 'request_failed', requestId, attempt: state.attempt, error, durationMs: Math.max(0, config.now() - state.startedAtMs) }));
      if (timedOut && lastResult?.relay) await lastResult.relay().catch(() => res.destroy());
      else if (timedOut) localError(res, 504, 'timeout', 'The total request deadline expired.');
      else if (!controller.signal.aborted) localError(res, 502, 'upstream_transport', 'The upstream connection failed or ended before its body completed.');
    } finally {
      diagnostics.emit(() => ({ type: 'request_end', requestId, attempt: state.attempt, statusCode: res.statusCode, durationMs: Math.max(0, config.now() - state.startedAtMs), budget: state }));
      clearTimeout(timer);
      controller.abort();
      controllers.delete(controller);
      req.off('aborted', cancel);
      res.off('close', cancel);
    }
  });
  server.requestTimeout = config.timeoutMs;
  server.headersTimeout = Math.min(config.timeoutMs, 30000);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  return {
    server,
    listen(port = 8790) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, config.host, () => { server.off('error', reject); resolve(server.address()); });
      });
    },
    async close() {
      for (const controller of controllers) controller.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
      await diagnostics.close();
    }
  };
}

module.exports = { createBridge };
