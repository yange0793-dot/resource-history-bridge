'use strict';

const http = require('node:http');
const https = require('node:https');
const { TextDecoder } = require('node:util');
const { isKnownResourceError, projectResponsesHistory } = require('./history');
const { findFrameEnd, classifyFrame } = require('./sse');

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
  return {
    upstream, host, keyHeader, apiKey: options.apiKey,
    requestLimit: boundedInteger(options.requestLimit, 8 * 1024 * 1024, 1, 64 * 1024 * 1024, 'requestLimit'),
    bufferLimit: boundedInteger(options.bufferLimit, 64 * 1024, 1, 64 * 1024, 'bufferLimit'),
    timeoutMs: boundedInteger(options.timeoutMs, 180000, 1, 1800000, 'timeoutMs')
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

function localError(res, status, code, message) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  const body = JSON.stringify({ error: { type: 'resource_history_bridge_error', code, message } });
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
  const inspectJson = inspect && response.statusCode === 400 && /\bapplication\/(?:[\w.-]+\+)?json\b/.test(contentType) && encoding === 'identity';
  const inspectSse = inspect && response.statusCode >= 200 && response.statusCode < 300 && contentType.startsWith('text/event-stream') && encoding === 'identity';
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
      if (!inspectSse) continue;
      pending = Buffer.concat([pending, chunk]);
      let boundary;
      while ((boundary = findFrameEnd(pending))) {
        const frame = pending.subarray(0, boundary.end);
        pending = pending.subarray(boundary.end);
        let classification = classifyFrame(frame);
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
    if (inspectJson && !committed) {
      let payload;
      try { payload = JSON.parse(Buffer.concat(held, size).toString('utf8')); } catch { /* Invalid bodies are relayed unchanged. */ }
      if (isKnownResourceError(payload)) return { recover: true };
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
      const first = await relayAttempt(config, endpoint, rawBody, req.headers, res, controller.signal, endpoint === 'responses');
      if (!first.recover || controller.signal.aborted) return;
      const projected = projectResponsesHistory(body);
      if (!projected.ok) {
        localError(res, 409, projected.code, projected.message);
        return;
      }
      await relayAttempt(config, endpoint, Buffer.from(JSON.stringify(projected.body)), req.headers, res, controller.signal, false);
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
    listen(port = 8787) {
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
