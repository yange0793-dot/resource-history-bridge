'use strict';

const http = require('node:http');
const https = require('node:https');
const { TextDecoder } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { isKnownResourceError, projectResponsesHistory } = require('./history');
const { findFrameEnd, classifyFrame } = require('./sse');
const { inspectResponseJson, createOutputInspector, parseSseFrame } = require('./output');
const { messagesToResponses, createMessagesRenderer } = require('./messages');

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
const ENDPOINTS = new Set(['responses', 'responses/compact', 'chat/completions', 'messages']);

function boundedInteger(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${name}.`);
  return value;
}

function configure(options = {}) {
  const upstream = new URL(options.upstream);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new TypeError('Upstream must be a fixed HTTP(S) base URL without credentials, query or fragment.');
  }
  upstream.pathname = upstream.pathname.replace(/\/$/, '');
  const host = options.host || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new TypeError('Only loopback binding is supported.');
  const keyHeader = options.keyHeader || 'authorization';
  if (!['authorization', 'api-key', 'x-api-key'].includes(keyHeader)) throw new TypeError('Unsupported key header.');
  if (options.apiKey != null && (typeof options.apiKey !== 'string' || /[\r\n]/.test(options.apiKey))) throw new TypeError('Invalid API key.');
  if (options.userAgent !== undefined && (typeof options.userAgent !== 'string' || /[\r\n]/.test(options.userAgent))) throw new TypeError('Invalid user agent.');
  const historyMode = options.historyMode || 'minimal';
  if (!['minimal', 'codex', 'harness'].includes(historyMode)) throw new TypeError('Unsupported history mode.');
  const upstreamProtocol = options.upstreamProtocol || 'passthrough';
  if (!['passthrough', 'responses'].includes(upstreamProtocol)) throw new TypeError('Unsupported upstream protocol.');
  const reasoningShape = options.reasoningShape || 'summary';
  if (!['summary', 'content'].includes(reasoningShape)) throw new TypeError('Unsupported reasoning shape.');
  return {
    upstream, host, keyHeader, apiKey: options.apiKey, userAgent: options.userAgent, upstreamProtocol, reasoningShape, historyMode,
    requestLimit: boundedInteger(options.requestLimit, 8 * 1024 * 1024, 1, 64 * 1024 * 1024, 'requestLimit'),
    bufferLimit: boundedInteger(options.bufferLimit, 64 * 1024, 1, 64 * 1024, 'bufferLimit'),
    timeoutMs: boundedInteger(options.timeoutMs, 180000, 1, 1800000, 'timeoutMs'),
    resourceAttempts: boundedInteger(options.resourceAttempts, 10, 1, 100, 'resourceAttempts'),
    retryDelayMs: boundedInteger(options.retryDelayMs, 1000, 0, 60000, 'retryDelayMs')
  };
}

function safeHeaders(headers) {
  const excluded = new Set(HOP_HEADERS);
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

function endpointFor(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) return null;
  const endpoint = rawUrl.replace(/^\/(?:v1\/)?/, '');
  // Claude Code's official SDK adds this fixed beta flag; it is not a proxy target or upstream query.
  if (endpoint === 'messages?beta=true') return 'messages';
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
  let text;
  try { text = new TextDecoder('utf-8', { fatal: false }).decode(buffer); } catch { return true; }
  const lines = text.split(/\r\n|\r|\n/);
  return lines.some(line => line && !['data:', 'event:'].some(prefix => line.startsWith(prefix) || prefix.startsWith(line)));
}

function upstreamRequest(config, endpoint, rawBody, requestHeaders, signal) {
  const target = new URL(config.upstream);
  target.pathname = `${target.pathname}/${endpoint}`.replace(/\/{2,}/g, '/');
  const headers = safeHeaders(requestHeaders);
  headers['content-length'] = String(rawBody.length);
  // Inspection requires an uncompressed error/stream; no payload or identity fields change.
  headers['accept-encoding'] = 'identity';
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

async function relayAttempt(config, endpoint, rawBody, headers, res, signal, inspect) {
  const { request, response } = await upstreamRequest(config, endpoint, rawBody, headers, signal);
  const responseHeaders = safeHeaders(response.headers);
  let committed = false;
  const commit = () => {
    if (committed) return;
    if (res.destroyed) throw new Error('client_closed');
    res.writeHead(response.statusCode, responseHeaders);
    committed = true;
  };
  const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase();
  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  const successful = response.statusCode >= 200 && response.statusCode < 300;
  const inspectJson = inspect && response.statusCode === 400 && /\bapplication\/(?:[\w.-]+\+)?json\b/.test(contentType) && encoding === 'identity';
  const inspectSse = inspect && (response.statusCode === 400 || successful) && contentType.startsWith('text/event-stream') && encoding === 'identity';
  let mode = inspectJson ? 'json' : inspectSse && response.statusCode === 400 ? 'prefix' : 'sse';
  let held = [];
  let size = 0;
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of response) {
      if (!inspectJson && !inspectSse || committed) {
        commit();
        await writeChunk(res, chunk);
        continue;
      }
      if (size + chunk.length > config.bufferLimit) {
        commit();
        for (const part of held) await writeChunk(res, part);
        held = [];
        await writeChunk(res, chunk);
        continue;
      }
      held.push(chunk);
      size += chunk.length;
      if (mode === 'json') continue;
      pending = Buffer.concat([pending, chunk]);
      if (mode === 'prefix') {
        const first = pending.findIndex(byte => ![0x20, 0x09, 0x0a, 0x0d].includes(byte));
        if (first === -1) continue;
        if (pending[first] === 0x7b) {
          mode = 'json';
          pending = Buffer.alloc(0);
          continue;
        }
        mode = 'sse';
      }
      let boundary;
      while ((boundary = findFrameEnd(pending))) {
        const frame = pending.subarray(0, boundary.end);
        pending = pending.subarray(boundary.end);
        let classification = inspect ? classifyFrame(frame) : 'commit';
        // Only a lone, complete error frame can be replayed; anything still buffered is
        // relayed so a partial or trailing payload is never dropped by a recovery.
        if (classification === 'recover' && pending.length) classification = 'commit';
        if (classification === 'recover') {
          response.destroy();
          request.destroy();
          return { recover: true };
        }
        if (classification === 'commit') {
          commit();
          for (const part of held) await writeChunk(res, part);
          held = [];
          break;
        }
      }
      if (!committed && partialIsUnknown(pending)) {
        commit();
        for (const part of held) await writeChunk(res, part);
        held = [];
      }
    }
    if ((inspectJson || inspectSse) && mode === 'json' && !committed && response.complete) {
      let payload;
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(held, size));
        payload = JSON.parse(text);
      } catch { /* Invalid bodies are relayed unchanged. */ }
      if (response.statusCode === 400 && isKnownResourceError(payload)) return { recover: true };
    }
    commit();
    for (const part of held) await writeChunk(res, part);
    res.end();
    return { recover: false };
  } finally {
    if (!response.complete) response.destroy();
    request.destroy();
  }
}

async function relayMessagesAttempt(config, rawBody, headers, res, signal, policy, body) {
  const outgoingHeaders = { ...headers };
  if (config.apiKey === undefined && !outgoingHeaders.authorization && typeof outgoingHeaders['x-api-key'] === 'string') {
    outgoingHeaders.authorization = `Bearer ${outgoingHeaders['x-api-key']}`;
    delete outgoingHeaders['x-api-key'];
  }
  const { request, response } = await upstreamRequest(config, 'responses', rawBody, outgoingHeaders, signal);
  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase();
  const successful = response.statusCode >= 200 && response.statusCode < 300;
  let started = false;
  const start = (text = '') => {
    if (started) return;
    started = true;
    let status = response.statusCode >= 200 && response.statusCode < 300 ? 200 : response.statusCode;
    try {
      const payload = body.stream ? parseSseFrame(Buffer.from(text)).event : JSON.parse(text);
      if (status === 200 && (payload?.type === 'error' || payload?.error)) {
        const type = payload.error?.type;
        status = type === 'rate_limit_error' ? 429 : type === 'authentication_error' ? 401 : type === 'permission_error' ? 403 : type === 'invalid_request_error' ? 400 : 502;
      }
    } catch { /* Regular data is emitted with the upstream success status. */ }
    res.writeHead(status, { 'content-type': body.stream ? 'text/event-stream' : 'application/json', 'cache-control': 'no-store' });
  };
  const renderer = createMessagesRenderer({
    stream: body.stream === true, model: body.model, tools: body.tools,
    write(text) { start(text); res.write(text); },
    end() { start(); res.end(); }
  });
  const output = createOutputInspector('responses');
  let held = [], heldBytes = 0, seenBytes = 0, pending = Buffer.alloc(0), committed = false;
  const commit = () => {
    if (committed) return;
    committed = true;
    for (const event of held) renderer.handle(event);
    held = [];
  };
  try {
    if (encoding !== 'identity') {
      localError(res, 502, 'compressed_conversion', 'The upstream returned compressed content that cannot be converted.');
      return {};
    }
    if (!contentType.startsWith('text/event-stream') || response.statusCode < 200 || response.statusCode >= 300) {
      const chunks = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > config.requestLimit) throw new Error('conversion_body_too_large');
        chunks.push(chunk);
      }
      let payload;
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch {
        if (contentType.startsWith('text/event-stream')) pending = Buffer.concat(chunks);
        else throw new Error('invalid_upstream_json');
      }
      if (payload) {
        if (response.statusCode === 400 && policy.resource && size <= config.bufferLimit && isKnownResourceError(payload)) return { recover: true };
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const bytes = Buffer.concat(chunks);
          res.writeHead(response.statusCode, { 'content-type': 'application/json', 'content-length': bytes.length, 'cache-control': 'no-store' });
          res.end(bytes);
          return {};
        }
        const state = inspectResponseJson('responses', payload);
        if (!['completed', 'incomplete', 'failed'].includes(payload.status) || !state.terminal || payload.status !== 'failed' && !Array.isArray(payload.output)) {
          localError(res, 502, 'invalid_upstream_completion', 'The upstream JSON did not contain a valid terminal Responses payload.');
          return {};
        }
        renderer.handle({ type: `response.${payload.status}`, response: payload });
        renderer.finish();
        return {};
      }
    }
    const process = () => {
      let boundary;
      while ((boundary = findFrameEnd(pending))) {
        const frame = pending.subarray(0, boundary.end);
        pending = pending.subarray(boundary.end);
        const parsed = parseSseFrame(frame);
        if (!parsed.ok || parsed.unknown) throw new Error('invalid_upstream_sse');
        if (!parsed.event) continue;
        const event = parsed.event;
        if (!committed && policy.resource && (response.statusCode === 400 || response.statusCode >= 200 && response.statusCode < 300) && seenBytes <= config.bufferLimit && isKnownResourceError(event) && !pending.length) {
          return { recover: true };
        }
        const state = output.observe(event);
        if (!committed) {
          held.push(event);
          heldBytes += frame.length;
          if ((state.hold || state.empty) && heldBytes <= config.bufferLimit) continue;
          commit();
        } else renderer.handle(event);
      }
      return null;
    };
    if (pending.length) {
      seenBytes = pending.length;
      if (seenBytes > config.bufferLimit) commit();
      const result = process();
      if (result) return result;
    }
    for await (const chunk of response) {
      seenBytes += chunk.length;
      pending = Buffer.concat([pending, chunk]);
      if (!committed && seenBytes > config.bufferLimit) commit();
      if (pending.length > config.requestLimit) throw new Error('conversion_frame_too_large');
      const result = process();
      if (result) return result;
    }
    if (pending.length) throw new Error('incomplete_upstream_sse');
    commit();
    renderer.finish();
    return {};
  } catch {
    if (started) renderer.fail('The upstream stream ended without a valid, convertible response.', 'upstream_transport');
    else localError(res, 502, 'upstream_transport', 'The upstream stream ended without a valid, convertible response.');
    return {};
  } finally {
    if (!response.complete) response.destroy();
    request.destroy();
  }
}

function createBridge(options) {
  const config = configure(options);
  const controllers = new Set();
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    // A premature downstream disconnect can emit an error independently of the close handler.
    res.on('error', () => {});
    const port = req.socket.localPort;
    if (!allowedHost(req.headers.host, port) || req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
      localError(res, 403, 'local_only', 'Only non-browser loopback clients are supported.');
      req.resume();
      return;
    }
    const endpoint = endpointFor(req.url);
    if (req.method !== 'POST' || !endpoint) {
      localError(res, 404, 'unsupported_endpoint', 'Use POST /v1/responses, /v1/responses/compact, /v1/chat/completions or /v1/messages.');
      req.resume();
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || '')) || req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      localError(res, 415, 'json_required', 'An uncompressed application/json body is required.');
      req.resume();
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      localError(res, 504, 'timeout', 'The total request deadline expired.');
      req.destroy();
    }, config.timeoutMs);
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
      let body;
      try { body = JSON.parse(rawBody.toString('utf8')); } catch {
        localError(res, 400, 'invalid_json', 'The request body must be valid JSON.');
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        localError(res, 400, 'invalid_json', 'The request body must be a JSON object.');
        return;
      }
      const convert = endpoint === 'messages' && config.upstreamProtocol === 'responses';
      let upstreamBody = body;
      try {
        if (convert) upstreamBody = messagesToResponses(body, { reasoningShape: config.reasoningShape });
      } catch (error) {
        localError(res, 400, error.code || 'unsupported_messages_content', error.message);
        return;
      }
      let bytes = convert ? Buffer.from(JSON.stringify(upstreamBody)) : rawBody;
      let projectedOnce = false;
      for (let attempt = 0; attempt < config.resourceAttempts; attempt++) {
        const policy = { resource: (endpoint === 'responses' || convert) && attempt + 1 < config.resourceAttempts };
        const result = convert
          ? await relayMessagesAttempt(config, bytes, req.headers, res, controller.signal, policy, body)
          : await relayAttempt(config, endpoint, bytes, req.headers, res, controller.signal, policy.resource);
        if (controller.signal.aborted || !result.recover) return;
        if (!projectedOnce) {
          const projected = projectResponsesHistory(upstreamBody, { mode: config.historyMode });
          // Messages conversion already sends explicit history without resource-bound IDs.
          // A known resource failure can retry those same bytes; native history still must
          // pass projection validation rather than silently dropping opaque state.
          if (!projected.ok && !(convert && projected.code === 'no_supported_item_ids')) {
            localError(res, 409, projected.code, projected.message);
            return;
          }
          if (projected.ok) {
            upstreamBody = projected.body;
            bytes = Buffer.from(JSON.stringify(upstreamBody));
          }
          projectedOnce = true;
        }
        // A pool may land on a different Azure resource again. Replay the identical
        // projection only on this exact pre-output error, within the original deadline.
        if (config.retryDelayMs) await delay(config.retryDelayMs, undefined, { signal: controller.signal });
      }
    } catch {
      if (!res.destroyed && !controller.signal.aborted) localError(res, 502, 'upstream_transport', 'The upstream connection failed or ended before its body completed.');
      else if (timedOut) localError(res, 504, 'timeout', 'The total request deadline expired.');
    } finally {
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
    close() {
      for (const controller of controllers) controller.abort();
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
    }
  };
}

module.exports = { createBridge };
