#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { createBridge } = require('../index.js');
const { mockAgentRouter } = require('./mock-agentrouter.cjs');
let restoreTransport;
const modules = process.env.RHB_HARNESS_MODULES || '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules';
const provider = 'ag';
const model = 'gpt-6.1-sol';
const key = 'RHB_PARITY_MOCK_NOT_A_CREDENTIAL';
const session = 'rhb-parity-mock-session';
const hash = value => createHash('sha256').update(value).digest('hex');
const frame = payload => `data: ${JSON.stringify(payload)}\n\n`;
const runtimeFiles = {
  adapter: path.join(modules, '@deepseek-ai/dsh-llm-pi-ai/lib/index.js'),
  piResponses: path.join(modules, '@earendil-works/pi-ai/dist/api/openai-responses.js'),
  piShared: path.join(modules, '@earendil-works/pi-ai/dist/api/openai-responses-shared.js'),
  openaiStreaming: path.join(modules, 'openai/core/streaming.mjs')
};
const summary = {
  kind: 'Installed PiAiAdapter native Responses focused parity against loopback mocks',
  startedAt: new Date().toISOString(), node: process.version, ok: false,
  readsProfilesOrCredentials: false, modifiesInstalledFiles: false, realUpstreamCalls: 0,
  stages: [], checks: [], failures: []
};
const nativeFetch = globalThis.fetch;
const sockets = new Set();
let upstream, bridge, legacyBridge, current;

function check(name, condition) {
  summary.checks.push({ name, ok: Boolean(condition) });
  assert.ok(condition, name);
}

function textItem(text = 'PARITY_OK') {
  return { type: 'message', id: 'msg_parity', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [] }] };
}

const lifecycle = frame({ type: 'response.created', response: { id: 'resp_parity', object: 'response', status: 'in_progress', output: [] } });
const rate = frame({ error: { code: 'rate_limit_exceeded', message: 'Rate limit reached.' } });
const completed = () => {
  const item = textItem();
  return lifecycle
    + frame({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } })
    + frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'PARITY_OK' })
    + frame({ type: 'response.output_item.done', output_index: 0, item })
    + frame({ type: 'response.completed', response: {
      id: 'resp_parity', object: 'response', status: 'completed', model, output: [item],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 } }
    } });
};

async function adapterFor(baseURL) {
  const { Config, PiAiAdapter, apply } = await import(pathToFileURL(runtimeFiles.adapter));
  let registered;
  apply({
    fiber: { entry: { options: { id: 'llm-pi-ai' } } }, inject() {}, on() {}, get() {},
    logger: { warn() {}, error() {} }, llm: {
      registerConfigurableProviders() { return { replace() {} }; }, registerModelDiscovery() {},
      registerAdapter(_routes, value) { registered = value; return { replace() {} }; }
    }
  }, Config({ providers: { [provider]: {
    api: 'openai-responses', baseURL, apiKeyEnv: 'RHB_PARITY_MOCK',
    models: [{ id: model, input: ['text'], contextWindow: 262144, maxTokens: 32768, reasoningEfforts: { low: 'low' } }],
    compat: { supportsStrictMode: true }, reasoning: 'low', transport: 'sse', cacheRetention: 'short',
    timeoutMs: 10000, streamIdleTimeoutMs: 10000
  } } }));
  return new PiAiAdapter({
    ...registered.config, resolveApiKey: async () => key,
    auth: { credentials: { async read() {}, async list() { return []; }, async modify() { throw new Error('Writes forbidden'); }, async delete() { throw new Error('Writes forbidden'); } },
      authContext: { async env() {}, async fileExists() { return false; } } }
  });
}

async function run(adapter, name, fault, expectedAttempts, expectedKind, expectedCode, retrySuccess = false) {
  current = { name, fault, retrySuccess, requests: [], clientRequests: [], wire: [] };
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Synthetic local parity test.' }] }];
  const before = JSON.stringify(messages);
  const chunks = [];
  for await (const chunk of adapter.stream({
    provider, model, messages, reasoningEffort: 'low', maxTokens: 64, sessionId: session,
    tools: [{ name: 'Read', description: 'Synthetic non-executed test tool', parameters: { type: 'object', properties: { file: { type: 'string' } }, required: [] } }],
    signal: AbortSignal.timeout(10000)
  })) chunks.push(chunk);
  await Promise.all(current.wire.map(entry => entry.saved));
  const finish = chunks.findLast(chunk => chunk.type === 'finish');
  check(`${name}: expected upstream calls`, current.requests.length === expectedAttempts);
  check(`${name}: one adapter HTTP request, no outer SDK replay`, current.clientRequests.length === 1);
  check(`${name}: correct native finish`, finish?.reason.kind === expectedKind && (expectedCode === undefined || finish.reason.failure?.code === expectedCode));
  check(`${name}: history unchanged`, JSON.stringify(messages) === before);
  check(`${name}: raw request and identity unchanged across retries`, current.requests.every(entry => {
    const body = JSON.parse(entry.bytes);
    return entry.bytes.equals(current.clientRequests[0]) && body.model === model && body.reasoning.effort === 'low'
      && body.prompt_cache_key === session && body.tools[0].strict === false && entry.headers.authorization === `Bearer ${key}` && entry.headers.session_id === session;
  }));
  const expectedWire = fault === 'success' || retrySuccess ? completed() : faultBody(fault);
  check(`${name}: exact final SSE bytes retained`, current.wire[0].text === expectedWire);
  if (expectedKind === 'stop') check(`${name}: usage without reasoning_tokens accepted`, chunks.find(chunk => chunk.type === 'usage')?.usage.outputTokens === 10 && chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'PARITY_OK'));
  summary.stages.push({
    name, upstreamCalls: current.requests.length, clientCalls: current.clientRequests.length,
    finish: finish?.reason, chunks: chunks.map(chunk => chunk.type),
    response: { status: current.wire[0].status, bytes: Buffer.byteLength(current.wire[0].text), sha256: hash(current.wire[0].text) },
    requestHashes: current.requests.map(entry => hash(entry.bytes))
  });
}

function faultBody(fault) {
  if (fault === 'empty-eof') return '';
  if (fault === 'metadata-eof') return lifecycle;
  if (fault === 'rate') return lifecycle + rate;
  if (fault === 'text-rate') return frame({ type: 'response.output_item.added', output_index: 0, item: { ...textItem(), phase: 'commentary', content: [] } })
    + frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: ' ' }) + rate;
  if (fault === 'reasoning-rate') return frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_parity', summary: [] } })
    + frame({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '\n' }) + rate;
  if (fault === 'tool-rate') return frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_parity', call_id: 'call_parity', name: 'Read', arguments: '' } }) + rate;
  return completed();
}

try {
  summary.runtimeHashes = Object.fromEntries(await Promise.all(Object.entries(runtimeFiles).map(async ([name, file]) => [name, hash(await readFile(file))])));
  summary.bridgeHashes = Object.fromEntries(await Promise.all(['bridge', 'recovery', 'output', 'history', 'sse'].map(async name => [name, hash(await readFile(new URL(`../lib/${name}.js`, import.meta.url)))])));
  summary.probeSha256 = hash(await readFile(new URL(import.meta.url)));
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    current.requests.push({ bytes: Buffer.concat(chunks), headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(current.retrySuccess && current.requests.length > 1 ? completed() : faultBody(current.fault));
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  restoreTransport = mockAgentRouter(upstream.address().port);
  const upstreamUrl = 'https://agentrouter.org/v1';
  bridge = createBridge({ upstream: upstreamUrl, historyMode: 'harness', retryDelayMs: 0, retryJitterRatio: 0, timeoutMs: 10000 });
  legacyBridge = createBridge({ upstream: upstreamUrl, historyMode: 'harness', automaticRecovery: false, transparentRecovery: false, timeoutMs: 10000 });
  const address = await bridge.listen(0);
  const legacy = await legacyBridge.listen(0);
  const origins = new Set([`http://127.0.0.1:${address.port}`, `http://127.0.0.1:${legacy.port}`]);
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!origins.has(url.origin) || url.pathname !== '/v1/responses') throw new Error('Non-fixture network blocked');
    current.clientRequests.push(Buffer.from(typeof init?.body === 'string' ? init.body : await input.clone().text()));
    const response = await nativeFetch(input, init);
    const wire = { status: response.status };
    wire.saved = response.clone().text().then(text => { wire.text = text; });
    current.wire.push(wire);
    // Finish the independent byte capture before the SDK aborts its error stream.
    await wire.saved;
    return response;
  };
  const adapter = await adapterFor(`http://127.0.0.1:${address.port}/v1`);
  const legacyAdapter = await adapterFor(`http://127.0.0.1:${legacy.port}/v1`);
  await run(legacyAdapter, 'native-clean-eof-classification', 'metadata-eof', 1, 'error', 'TRANSPORT');
  await run(legacyAdapter, 'native-unnamed-rate-classification', 'rate', 1, 'error', 'RATE_LIMIT');
  await run(adapter, 'missing-reasoning-tokens-is-not-an-error', 'success', 1, 'stop');
  await run(adapter, 'empty-eof-recovers', 'empty-eof', 2, 'stop', undefined, true);
  await run(adapter, 'metadata-eof-recovers', 'metadata-eof', 2, 'stop', undefined, true);
  await run(adapter, 'metadata-eof-exhaustion-retains-original', 'metadata-eof', 3, 'error', 'TRANSPORT');
  await run(adapter, 'unnamed-rate-recovers', 'rate', 2, 'stop', undefined, true);
  await run(adapter, 'unnamed-rate-exhaustion-retains-original', 'rate', 3, 'error', 'RATE_LIMIT');
  for (const fault of ['text-rate', 'reasoning-rate', 'tool-rate']) await run(adapter, `${fault}-no-replay`, fault, 1, 'error', 'RATE_LIMIT');
  const final = Object.fromEntries(await Promise.all(Object.entries(runtimeFiles).map(async ([name, file]) => [name, hash(await readFile(file))])));
  check('Installed runtime source unchanged', JSON.stringify(final) === JSON.stringify(summary.runtimeHashes));
  summary.ok = true;
} catch (error) {
  summary.failures.push({ stage: current?.name, name: error.name, message: error.message });
} finally {
  globalThis.fetch = nativeFetch;
  await bridge?.close();
  await legacyBridge?.close();
  restoreTransport?.();
  const closures = [...sockets].map(socket => new Promise(resolve => socket.once('close', resolve)));
  for (const socket of sockets) socket.destroy();
  if (upstream) await new Promise(resolve => upstream.close(resolve));
  await Promise.all(closures);
  summary.cleanup = { bridgeListening: Boolean(bridge?.server.listening), legacyBridgeListening: Boolean(legacyBridge?.server.listening), upstreamListening: Boolean(upstream?.listening), sockets: sockets.size };
  summary.completedAt = new Date().toISOString();
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}
