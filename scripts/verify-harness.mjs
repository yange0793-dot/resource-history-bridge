#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, realpath, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { createBridge } = require('../index.js');
const modules = process.env.RHB_HARNESS_MODULES || '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules';
const provider = 'ag';
const model = 'gpt-6.1-sol';
const mockKey = 'RHB_HARNESS_MOCK_KEY_NOT_A_CREDENTIAL';
const session = 'rhb-installed-harness-loopback';
const azureMessage = 'The requested item was created under a different Azure OpenAI resource.';
const azureError = { error: { type: 'invalid_request_error', message: azureMessage } };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const errorMessage = error => error.name === 'AssertionError' ? error.message.split('\n')[0] : error.message;
const installed = name => path.join(modules, name);
const summary = {
  probe: 'installed-harness-pi-ai-loopback',
  startedAt: new Date().toISOString(),
  ok: false,
  node: process.version,
  platform: process.platform,
  installedModules: modules,
  evidenceKind: 'Installed native adapter against loopback mock; not a live Azure recovery experiment.',
  readsUserProfilesOrCredentials: false,
  checks: [],
  stages: [],
  requests: [],
  failures: []
};
let bridge;
let upstream;
let nativeFetch;
let stage;
const sockets = new Set();
const clientRequests = [];
const upstreamRequests = [];
const replayDegrades = [];
const responseCaptures = [];

function check(name, condition, details) {
  summary.checks.push({ name, ok: Boolean(condition), ...(details === undefined ? {} : { details }) });
  assert.ok(condition, name);
}

function frame(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function responseFor(name, output) {
  return {
    id: `resp_${name}`, object: 'response', created_at: 1, status: 'completed', model,
    output, usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 } }
  };
}

function textItem(name, text, phase = 'final_answer') {
  return { type: 'message', id: `msg_${name}`, role: 'assistant', status: 'completed', phase, content: [{ type: 'output_text', text, annotations: [] }] };
}

function toolItems(name, a, b) {
  return [
    { type: 'reasoning', id: `rs_${name}`, summary: [{ type: 'summary_text', text: `Synthetic reasoning for ${name}.` }], encrypted_content: `MOCK_ENCRYPTED_${name}_${'A+/='.repeat(768)}` },
    textItem(name, `Using sum_numbers for ${a} and ${b}.`, 'commentary'),
    { type: 'function_call', id: `fc_${name}`, call_id: `call_${name}`, name: 'sum_numbers', arguments: JSON.stringify({ a, b }), status: 'completed' }
  ];
}

function completionStream(name, output, backfillEncrypted = false) {
  const response = responseFor(name, output);
  const events = [frame({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })];
  for (const [index, item] of output.entries()) {
    const added = structuredClone(item);
    if (added.type === 'message') added.content = [];
    if (added.type === 'function_call') added.arguments = '';
    if (added.type === 'reasoning') delete added.encrypted_content;
    events.push(frame({ type: 'response.output_item.added', output_index: index, item: added }));
    if (item.type === 'message') {
      events.push(frame({ type: 'response.output_text.delta', output_index: index, content_index: 0, delta: item.content[0].text }));
    }
    if (item.type === 'reasoning') {
      events.push(frame({ type: 'response.reasoning_summary_text.delta', output_index: index, summary_index: 0, delta: item.summary[0].text }));
    }
    if (item.type === 'function_call') {
      events.push(frame({ type: 'response.function_call_arguments.delta', output_index: index, delta: item.arguments }));
      events.push(frame({ type: 'response.function_call_arguments.done', output_index: index, arguments: item.arguments }));
    }
    const done = structuredClone(item);
    if (backfillEncrypted && done.type === 'reasoning') delete done.encrypted_content;
    events.push(frame({ type: 'response.output_item.done', output_index: index, item: done }));
  }
  events.push(frame({ type: 'response.completed', response }));
  return events.join('');
}

function send(res, status, body, contentType = 'text/event-stream') {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

const tools = [{
  name: 'sum_numbers', description: 'Read-only local arithmetic: return the sum of a and b.',
  parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' }, note: { type: 'string' } }, required: ['a', 'b'], additionalProperties: false }
}];
const initialMessages = [
  { role: 'system', content: [{ type: 'text', text: 'Synthetic compatibility test. No external actions.' }] },
  { role: 'user', content: [{ type: 'text', text: 'Use sum_numbers for 19+23 and then 40+2, waiting for each result.' }] }
];

function requestShape(record) {
  const body = JSON.parse(record.bytes);
  return {
    stage: record.stage, attempt: record.attempt, bytes: record.bytes.length, sha256: sha256(record.bytes),
    endpoint: record.url, model: body.model, stream: body.stream, store: body.store,
    authenticationIsMock: record.headers.authorization === `Bearer ${mockKey}`,
    sessionPreserved: record.headers.session_id === session && record.headers['x-client-request-id'] === session,
    promptCachePreserved: body.prompt_cache_key === session,
    inputs: body.input.map(item => ({
      type: item.type || 'role-only-message', role: item.role, hasId: Object.hasOwn(item, 'id'), phase: item.phase,
      contentKinds: Array.isArray(item.content) ? item.content.map(part => part.type) : typeof item.content,
      encryptedBytes: typeof item.encrypted_content === 'string' ? Buffer.byteLength(item.encrypted_content) : 0,
      ...(typeof item.encrypted_content === 'string' ? { encryptedSha256: sha256(item.encrypted_content) } : {}),
      ...(item.call_id ? { callIdSha256: sha256(item.call_id) } : {})
    })),
    tools: (body.tools || []).map(tool => ({ type: tool.type, name: tool.name, strict: tool.strict, required: tool.parameters?.required }))
  };
}

async function run(adapter, name, messages, output, resourceFailures = 0, mode = 'complete', backfillEncrypted = false) {
  stage = { name, attempt: 0, output, resourceFailures, mode, backfillEncrypted };
  const before = JSON.stringify(messages);
  const chunks = [];
  let thrown;
  try {
    for await (const chunk of adapter.stream({
      provider, model, messages, tools, reasoningEffort: 'low', maxTokens: 512,
      sessionId: session, signal: AbortSignal.timeout(15000)
    })) chunks.push(chunk);
  } catch (error) {
    thrown = { name: error.name, code: error.code, message: errorMessage(error) };
  }
  await Promise.all(responseCaptures.filter(record => record.stage === name).map(record => record.saved));
  const blocks = chunks.filter(chunk => chunk.type === 'block-end').sort((a, b) => a.index - b.index).map(chunk => chunk.block);
  const finish = chunks.findLast(chunk => chunk.type === 'finish');
  const result = { blocks, finish, chunks, thrown };
  summary.stages.push({
    name, attempts: stage.attempt, chunkCount: chunks.length, blockTypes: blocks.map(block => block.type),
    faultInjection: resourceFailures ? { count: resourceFailures, status: 400, contentType: 'text/event-stream', body: 'complete JSON known Azure resource error' } : mode,
    clientResponse: responseCaptures.filter(record => record.stage === name).map(record => ({ status: record.status, contentType: record.contentType, readError: record.readError, ...(typeof record.text === 'string' ? { bytes: Buffer.byteLength(record.text), sha256: sha256(record.text) } : {}) })),
    finishReason: finish?.reason, thrown,
    replay: finish?.replayState ? {
      kind: finish.replayState.response.kind, version: finish.replayState.response.version,
      signatures: finish.replayState.blocks.map(block => ({ type: block.type, text: typeof block.textSignature === 'string', reasoning: typeof block.thinkingSignature === 'string' }))
    } : undefined
  });
  check(`${name}: caller history is immutable`, JSON.stringify(messages) === before);
  return result;
}

function appendToolResult(messages, result, expectedA, expectedB) {
  check('tool finish uses native tool-call state', result.finish?.reason.kind === 'tool-calls');
  const call = result.blocks.find(block => block.type === 'tool-call');
  check('fixed read-only tool declared by name', call?.name === 'sum_numbers');
  const args = JSON.parse(call.arguments);
  assert.deepEqual(args, { a: expectedA, b: expectedB });
  const value = args.a + args.b;
  check('fixed read-only arithmetic returns 42', value === 42);
  const state = result.finish.replayState;
  check('native reasoning and ordinary text signatures retained', state.blocks.some(block => block.thinkingSignature) && state.blocks.some(block => block.textSignature));
  return [...messages,
    { role: 'assistant', content: result.blocks, source: { provider, model, replayState: state } },
    { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: String(value) }], isError: false }
  ];
}

function verifyAttempts(name, count, reasoningItems) {
  const records = upstreamRequests.filter(record => record.stage === name);
  const originals = clientRequests.filter(record => record.stage === name);
  check(`${name}: no SDK/client retries`, originals.length === 1);
  check(`${name}: bounded expected upstream attempts`, records.length === count);
  check(`${name}: original raw request bytes preserved`, records[0].bytes.equals(originals[0].bytes));
  check(`${name}: native User-Agent preserved on every attempt`, records.every(record => record.headers['user-agent'] === originals[0].headers['user-agent']));
  const original = JSON.parse(records[0].bytes);
  check(`${name}: strict:false preserves optional note`, original.tools.every(tool => tool.strict === false && !tool.parameters.required.includes('note')));
  check(`${name}: model and cache identity preserved`, records.every(record => {
    const body = JSON.parse(record.bytes);
    return body.model === model && body.prompt_cache_key === session && body.store === false && record.headers.authorization === `Bearer ${mockKey}` && record.headers.session_id === session && record.headers['x-client-request-id'] === session;
  }));
  if (count === 1) return;
  const expected = structuredClone(original);
  const removed = [];
  for (const [index, item] of expected.input.entries()) {
    if (['message', 'reasoning', 'function_call'].includes(item.type) && Object.hasOwn(item, 'id')) {
      removed.push({ index, type: item.type });
      delete item.id;
    }
  }
  check(`${name}: all expected item IDs present in actual native history`, removed.length === reasoningItems.length * 3);
  assert.deepEqual(JSON.parse(records[1].bytes), expected, 'projection may change only the three item ID classes');
  check(`${name}: only message/reasoning/function_call IDs removed`, true, removed);
  check(`${name}: repeated resource error reuses identical projection`, records.slice(1).every(record => record.bytes.equals(records[1].bytes)));
  const reasoning = expected.input.filter(item => item.type === 'reasoning');
  check(`${name}: complete encrypted reasoning preserved`, reasoning.length === reasoningItems.length && reasoning.every((item, index) => {
    const wanted = structuredClone(reasoningItems[index]);
    delete wanted.id;
    assert.deepEqual(item, wanted);
    return true;
  }));
  const calls = expected.input.filter(item => item.type === 'function_call');
  const outputs = expected.input.filter(item => item.type === 'function_call_output');
  check(`${name}: call_id pairing and outputs preserved`, calls.length === reasoningItems.length && calls.every(call => outputs.filter(output => output.call_id === call.call_id && output.output === '42').length === 1));
}

async function main() {
  const runtimeFiles = {
    adapter: installed('@deepseek-ai/dsh-llm-pi-ai/lib/index.js'),
    piResponses: installed('@earendil-works/pi-ai/dist/api/openai-responses.js'),
    piResponsesShared: installed('@earendil-works/pi-ai/dist/api/openai-responses-shared.js')
  };
  try {
    await Promise.all(Object.values(runtimeFiles).map(file => access(file)));
  } catch {
    throw new Error(`Installed DeepSeek Harness dependency missing under ${modules}. Set RHB_HARNESS_MODULES to its dsh/node_modules directory. The probe is not skipped.`);
  }
  const piPackage = JSON.parse(await readFile(installed('@earendil-works/pi-ai/package.json'), 'utf8'));
  const adapterPackage = JSON.parse(await readFile(installed('@deepseek-ai/dsh-llm-pi-ai/package.json'), 'utf8'));
  summary.versions = { adapter: adapterPackage.version, piAi: piPackage.version, piAiNodeRequirement: piPackage.engines?.node };
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 19)) {
    throw new Error(`Installed pi-ai probe requires Node.js >=22.19.0; got ${process.version}. This is the installed adapter dependency, not the bridge's Node.js requirement.`);
  }
  summary.runtimeHashes = Object.fromEntries(await Promise.all(Object.entries(runtimeFiles).map(async ([name, file]) => [name, sha256(await readFile(file))])));
  summary.bridgeRuntimeHashes = Object.fromEntries(await Promise.all(['bridge', 'history'].map(async name => [name, sha256(await readFile(new URL(`../lib/${name}.js`, import.meta.url)))])));
  summary.probeSha256 = sha256(await readFile(new URL(import.meta.url)));
  const { Config, PiAiAdapter, apply } = await import(pathToFileURL(runtimeFiles.adapter));

  upstream = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const attempt = ++stage.attempt;
      upstreamRequests.push({ stage: stage.name, attempt, bytes: Buffer.concat(chunks), headers: req.headers, url: req.url });
      assert.equal(req.url, '/v1/responses');
      if (attempt <= stage.resourceFailures) return send(res, 400, JSON.stringify(azureError));
      if (stage.mode === 'unrelated-error') return send(res, 400, JSON.stringify({ error: { type: 'invalid_request_error', message: 'Unrelated synthetic invalid request.' } }));
      if (stage.mode === 'output-then-error') {
        const item = textItem('partial', 'VISIBLE', 'commentary');
        const prefix = frame({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } }) + frame({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'VISIBLE' });
        return send(res, 200, prefix + frame({ type: 'error', code: 'invalid_request_error', message: azureMessage }));
      }
      return send(res, 200, completionStream(stage.name, stage.output, stage.backfillEncrypted));
    } catch (error) {
      summary.failures.push({ stage: stage?.name, source: 'mock-upstream', message: errorMessage(error) });
      send(res, 500, JSON.stringify({ error: { message: 'Synthetic mock fixture failed.' } }), 'application/json');
    }
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  bridge = createBridge({ upstream: `http://127.0.0.1:${upstream.address().port}/v1`, historyMode: 'harness', resourceAttempts: 3, retryDelayMs: 0, timeoutMs: 10000 });
  const address = await bridge.listen(0);
  const bridgeBase = `http://127.0.0.1:${address.port}/v1`;
  nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== `http://127.0.0.1:${address.port}` || url.pathname !== '/v1/responses') {
      throw new Error('Harness probe blocked non-fixture network access.');
    }
    const bytes = typeof init?.body === 'string' ? Buffer.from(init.body) : Buffer.from(await input.clone().text());
    clientRequests.push({ stage: stage.name, bytes, headers: Object.fromEntries(new Headers(init?.headers ?? input?.headers)) });
    const response = await nativeFetch(input, init);
    const capture = { stage: stage.name, status: response.status, contentType: response.headers.get('content-type') };
    capture.saved = response.clone().text().then(text => { capture.text = text; }).catch(error => { capture.readError = errorMessage(error); });
    responseCaptures.push(capture);
    return response;
  };

  let registered;
  const rawConfig = {
    providers: { [provider]: {
      api: 'openai-responses', baseURL: bridgeBase, apiKeyEnv: 'RHB_HARNESS_MOCK',
      models: [{ id: model, input: ['text'], contextWindow: 262144, maxTokens: 32768, reasoningEfforts: { low: 'low' } }],
      compat: { supportsStrictMode: true }, reasoning: 'low', transport: 'sse', cacheRetention: 'short', timeoutMs: 10000, streamIdleTimeoutMs: 10000
    } }
  };
  // The public plugin seam resolves the synthetic profiles; no private resolver export or app configuration is needed.
  apply({
    fiber: { entry: { options: { id: 'llm-pi-ai' } } }, inject() {}, on() {},
    get() { return undefined; }, logger: { warn() {}, error() {} },
    llm: {
      registerConfigurableProviders() { return { replace() {} }; }, registerModelDiscovery() {},
      registerAdapter(_routes, value) { registered = value; return { replace() {} }; }
    }
  }, Config(rawConfig));
  check('public seam registers actual installed PiAiAdapter', registered instanceof PiAiAdapter);
  const adapter = new PiAiAdapter({
    ...registered.config,
    resolveApiKey: async (route, profile) => { assert.equal(route, provider); assert.equal(String(profile.apiKeyEnv), 'RHB_HARNESS_MOCK'); return mockKey; },
    auth: {
      credentials: { async read() { return undefined; }, async list() { return []; }, async modify() { throw new Error('Credential writes prohibited.'); }, async delete() { throw new Error('Credential writes prohibited.'); } },
      authContext: { async env() { return undefined; }, async fileExists() { return false; } }
    },
    onReplayDegrade: event => replayDegrades.push(event.reason)
  });
  const resolved = await adapter.resolveModel(provider, model);
  check('synthetic explicit model resolves without discovery', resolved.provider === provider && resolved.id === model);
  summary.metadataContract = 'Installed finish.replayState v2 plus source.replayState, including textSignature/thinkingSignature; not an invented nativeMetadata wrapper.';
  summary.resolvedModel = { provider: resolved.provider, id: resolved.id, inputModalities: resolved.inputModalities, context: resolved.context };

  const text = await run(adapter, 'text', initialMessages, [textItem('text', 'HARNESS_BRIDGE_OK')]);
  check('native adapter text succeeds', !text.thrown && text.finish?.reason.kind === 'stop' && text.blocks.some(block => block.text === 'HARNESS_BRIDGE_OK'));
  verifyAttempts('text', 1, []);
  const firstItems = toolItems('tool_first', 19, 23);
  const first = await run(adapter, 'tool-first', initialMessages, firstItems, 0, 'complete', true);
  verifyAttempts('tool-first', 1, []);
  const historyOne = appendToolResult(initialMessages, first, 19, 23);
  const secondItems = toolItems('tool_second', 40, 2);
  const second = await run(adapter, 'tool-continuation-one', historyOne, secondItems, 2);
  verifyAttempts('tool-continuation-one', 3, [firstItems[0]]);
  const historyTwo = appendToolResult(historyOne, second, 40, 2);
  const final = await run(adapter, 'tool-continuation-two', historyTwo, [textItem('final', 'RESULT_42')], 2);
  verifyAttempts('tool-continuation-two', 3, [firstItems[0], secondItems[0]]);
  check('native adapter completes two executed tool continuations', !final.thrown && final.finish?.reason.kind === 'stop' && final.blocks.some(block => block.text === 'RESULT_42'));
  check('native replay never degrades', replayDegrades.length === 0);

  const exhausted = await run(adapter, 'resource-budget-exhausted', historyTwo, [], 3);
  verifyAttempts('resource-budget-exhausted', 3, [firstItems[0], secondItems[0]]);
  const exhaustedWire = responseCaptures.find(record => record.stage === 'resource-budget-exhausted');
  check('exhausted budget returns actual last upstream 400', exhaustedWire?.status === 400 && exhaustedWire.text === JSON.stringify(azureError) && exhausted.finish?.reason.kind === 'error');
  const unrelated = await run(adapter, 'unrelated-400', historyTwo, [], 0, 'unrelated-error');
  verifyAttempts('unrelated-400', 1, []);
  check('unrelated 400 remains a native adapter failure', unrelated.finish?.reason.kind === 'error');
  const partial = await run(adapter, 'stream-output-no-replay', historyTwo, [], 0, 'output-then-error');
  verifyAttempts('stream-output-no-replay', 1, []);
  check('visible stream output prevents resource replay', partial.chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'VISIBLE') && partial.finish?.reason.kind === 'error');
  const empty = await run(adapter, 'valid-empty', historyTwo, []);
  verifyAttempts('valid-empty', 1, []);
  const emptyWire = responseCaptures.find(record => record.stage === 'valid-empty');
  check('valid empty completion passes through bridge without retries', emptyWire?.status === 200 && emptyWire.text === completionStream('valid-empty', []));
  check('installed adapter reports its native empty policy separately', empty.finish?.reason.kind === 'error' && empty.finish.reason.failure?.code === 'EMPTY_RESPONSE');
  summary.emptyCompletion = { bridge: 'Normal completed SSE, one attempt, no synthetic error or retry', installedAdapter: 'EMPTY_RESPONSE (native installed adapter policy, not bridge policy)' };
  const finalHashes = Object.fromEntries(await Promise.all(Object.entries(runtimeFiles).map(async ([name, file]) => [name, sha256(await readFile(file))])));
  check('installed runtime files unchanged', JSON.stringify(finalHashes) === JSON.stringify(summary.runtimeHashes));
  summary.ok = summary.failures.length === 0;
}

try {
  await main();
} catch (error) {
  summary.failures.push({ stage: stage?.name, source: 'probe', name: error.name, message: errorMessage(error) });
} finally {
  if (nativeFetch) globalThis.fetch = nativeFetch;
  if (bridge) await bridge.close().catch(error => summary.failures.push({ source: 'bridge-cleanup', message: errorMessage(error) }));
  const socketClosures = [...sockets].map(socket => new Promise(resolve => socket.once('close', resolve)));
  for (const socket of sockets) socket.destroy();
  if (upstream) await new Promise(resolve => upstream.close(resolve));
  await Promise.all(socketClosures);
  summary.cleanup = { bridgeListening: Boolean(bridge?.server.listening), upstreamListening: Boolean(upstream?.listening), fixtureSockets: sockets.size };
  summary.requests = upstreamRequests.map(requestShape);
  summary.completedAt = new Date().toISOString();
  summary.ok = summary.ok && summary.failures.length === 0 && !summary.cleanup.bridgeListening && !summary.cleanup.upstreamListening;
  if (process.env.RHB_HARNESS_EVIDENCE) {
    const destination = path.resolve(process.env.RHB_HARNESS_EVIDENCE);
    const temporaryRoot = await realpath(tmpdir());
    const parent = await realpath(path.dirname(destination));
    const relative = path.relative(temporaryRoot, parent);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('RHB_HARNESS_EVIDENCE must be a new file under the operating system temporary directory.');
    }
    await writeFile(destination, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
}
