'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiagnostics, summarizeRequest, summarizeError, summarizeHeaders } = require('../lib/diagnostics');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bridge-diagnostics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function noSecrets(value, secrets) {
  const encoded = JSON.stringify(value);
  for (const secret of secrets) assert.ok(!encoded.includes(secret), `Diagnostic leaked ${secret}`);
  return encoded;
}

function fullRequest(secret) {
  return {
    model: 'claude-sonnet-5-5', stream: true, instructions: secret, metadata: { credential: secret },
    previous_response_id: secret, reasoning: { effort: 'high', secret },
    input: [
      { type: 'message', id: secret, role: 'user', content: [
        { type: 'input_text', text: secret },
        { type: 'input_image', image_url: `data:image/png;base64,${secret}` }
      ] },
      { type: 'reasoning', id: secret, encrypted_content: secret, summary: [{ type: 'summary_text', text: secret }] },
      { type: 'function_call', id: secret, call_id: 'call-1', name: secret, arguments: secret },
      { type: 'function_call_output', call_id: 'call-1', output: { content: secret } },
      { type: 'custom_tool_call', call_id: 'custom-1', name: secret, input: secret },
      { type: 'custom_tool_call_output', call_id: 'custom-1', output: secret },
      { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: secret, strict: false, parameters: { type: 'object' } }] }
    ],
    tools: [{ type: 'function', name: secret, description: secret, strict: true, parameters: { type: 'object', properties: { [secret]: { type: 'string', description: secret } } } }],
    text: { format: { type: 'json_schema', name: secret, strict: true, schema: { type: 'object' } } },
    [secret]: secret
  };
}

test('request summary exposes structure but never history, credentials, schema names or ciphertext', () => {
  const secret = 'SENSITIVE_PromptAndToolSecret_xyz';
  const request = fullRequest(secret);
  const summary = summarizeRequest(request);
  noSecrets(summary, [secret, 'data:image/png;base64,']);
  assert.equal(summary.model, 'claude-sonnet-5-5');
  assert.equal(summary.effort, 'high');
  assert.equal(summary.inputCount, 7);
  assert.equal(summary.roles.user, 1);
  assert.equal(summary.roles.developer, 1);
  assert.equal(summary.itemTypes.function_call, 1);
  assert.equal(summary.resourceItemIdCount, 3);
  assert.equal(summary.imageCount, 1);
  assert.equal(summary.imageBytes, Buffer.byteLength(`data:image/png;base64,${secret}`));
  assert.equal(summary.textBytes, Buffer.byteLength(secret) * 2);
  assert.equal(summary.toolCount, 2);
  assert.equal(summary.schemaCount, 4);
  assert.equal(summary.schemaPropertyCount, 1);
  assert.equal(summary.strictTrueCount, 2);
  assert.equal(summary.strictFalseCount, 1);
  assert.equal(summary.pairingIssues.missingOutputs, 0);
  assert.deepEqual(request.input[2].arguments, secret);
});

test('Messages and Chat histories count inline images and pair tools without traversing tool payloads', () => {
  const secret = 'never-walk-this-tool-payload';
  const forbidden = {};
  Object.defineProperty(forbidden, 'text', { get() { throw new Error('Tool payload was traversed'); }, enumerable: true });
  const summary = summarizeRequest({ messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: secret, input: forbidden }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: forbidden }, { type: 'image', source: { type: 'base64', data: secret } }] },
    { role: 'assistant', tool_calls: [{ id: 'b', type: 'function', function: { arguments: forbidden } }] },
    { role: 'tool', tool_call_id: 'b', content: secret }
  ], tools: [{ name: secret, input_schema: { type: 'object' } }] });
  noSecrets(summary, [secret]);
  assert.equal(summary.imageCount, 1);
  assert.equal(summary.imageBytes, Buffer.byteLength(secret));
  assert.equal(summary.messageCount, 4);
  assert.equal(summary.schemaCount, 1);
  assert.equal(summary.pairingIssues.missingOutputs, 0);
});

test('pairing diagnostics count duplicate, orphaned, missing and wrong-type pairs without emitting IDs', () => {
  const summary = summarizeRequest({ input: [
    { type: 'function_call_output', call_id: 'orphan', output: 'private' },
    { type: 'function_call', call_id: 'duplicate', arguments: '{}' },
    { type: 'function_call', call_id: 'duplicate', arguments: '{}' },
    { type: 'custom_tool_call_output', call_id: 'duplicate', output: 'private' },
    { type: 'function_call_output', call_id: 'duplicate', output: 'private' },
    { type: 'function_call', call_id: 'missing-output', arguments: '{}' },
    { type: 'function_call', call_id: null, arguments: '{}' }
  ] });
  assert.deepEqual(summary.pairingIssues, { duplicateCalls: 1, duplicateOutputs: 1, missingCalls: 1, missingOutputs: 1, invalidIds: 1, typeMismatches: 1 });
  noSecrets(summary, ['orphan', 'duplicate"', 'missing-output', 'private']);
});

test('unknown top-level keys, roles, item types, effort and invalid model never escape', () => {
  const secret = 'INJECTED secret\n{ "credential": "sk-test" }';
  const summary = summarizeRequest({ [secret]: secret, model: secret, reasoning: { effort: secret }, input: [{ type: secret, role: secret }] });
  noSecrets(summary, [secret, 'credential', 'sk-test']);
  assert.deepEqual(summary.topLevelKeys, ['model', 'input', 'reasoning']);
  assert.equal(summary.roles.unknown, 1);
  assert.equal(summary.itemTypes.unknown, 1);
  assert.equal(summary.modelHash.sha256.length, 64);
  assert.equal(summary.model, undefined);
  assert.equal(summary.effort, undefined);
  for (const model of ['sk-longapikey', 'Bearer-secret', 'api_key-private', 'token-private', 'password-private']) {
    assert.equal(summarizeRequest({ model }).model, undefined);
  }
});

test('bounded structural traversal tolerates cyclic schemas and truncates oversized histories', () => {
  const parameters = { type: 'object', properties: {} };
  parameters.properties.cycle = parameters;
  const summary = summarizeRequest({ input: Array.from({ length: 11000 }, () => ({ role: 'user', content: 'x' })), tools: [{ parameters }] });
  assert.equal(summary.inputCount, 11000);
  assert.equal(summary.roles.user, 10000);
  assert.equal(summary.truncated, true);
  const cyclic = summarizeRequest({ tools: [{ parameters }] });
  assert.equal(cyclic.schemaCount, 1);
  assert.equal(cyclic.schemaPropertyCount, 1);
});

test('headers allow only upstream request and trace IDs and hash unusual values', () => {
  const secret = 'Bearer sk-HeaderCredential\nInjected: private';
  const summary = summarizeHeaders({
    'X-Request-ID': 'req_abc123',
    'x-ms-request-id': 'a1234567-b123-c123-d123-123456789abc',
    traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    'x-amzn-trace-id': 'Root=1-12345678-0123456789abcdef01234567',
    'x-correlation-id': secret,
    Authorization: secret, 'proxy-authorization': secret, 'api-key': secret,
    cookie: secret, 'set-cookie': secret, [secret]: secret
  });
  noSecrets(summary, [secret, 'HeaderCredential', 'Authorization', 'api-key']);
  assert.equal(summary['x-request-id'], 'req_abc123');
  assert.equal(summary['x-ms-request-id'], 'a1234567-b123-c123-d123-123456789abc');
  assert.equal(typeof summary.traceparent, 'string');
  assert.equal(typeof summary['x-amzn-trace-id'], 'string');
  assert.equal(summary['x-correlation-id'].sha256.length, 64);
  assert.equal(summary['x-correlation-id'].bytes, Buffer.byteLength(secret));
  if (typeof Headers !== 'undefined') assert.deepEqual(summarizeHeaders(new Headers({ 'x-request-id': 'req_native', authorization: 'private' })), { 'x-request-id': 'req_native' });
});

test('error summaries never serialize raw messages, stack, param, nested secrets or unknown codes', () => {
  const secret = 'ERROR_secret_payload_xyz';
  const error = new Error(secret, { cause: Object.assign(new Error(secret), { code: 'ECONNRESET' }) });
  error.statusCode = 502;
  error.param = secret;
  error.code = secret;
  error.response = fullRequest(secret);
  const summary = summarizeError(error);
  noSecrets(summary, [secret, 'stack', 'param', 'response']);
  assert.equal(summary.statusCode, 502);
  assert.equal(summary.code, 'econnreset');
  assert.equal(summary.codeHash.sha256.length, 64);
  assert.equal(summary.message.sha256.length, 64);
  assert.equal(summary.message.bytes, Buffer.byteLength(secret));
  assert.equal(summarizeError(secret).category, 'unknown');
  assert.equal(summarizeError({ error: { type: 'invalid_request_error', message: secret, status: '400' } }).statusCode, 400);
});

test('event allowlist blocks injection in event keys and structured recovery fields', () => {
  const secret = 'event-secret\n{"type":"forged"}';
  let delivered;
  const diagnostics = createDiagnostics({ enabled: true, onEvent(event) { delivered = event; } });
  const safe = diagnostics.emit({
    type: secret, requestId: secret, attemptId: secret, attempt: 2, durationMs: 12, statusCode: 503,
    request: fullRequest(secret), headers: { 'x-request-id': secret, authorization: secret }, error: new Error(secret),
    classification: { classification: 'transient', reason: secret, generic400ProjectionCandidate: false, [secret]: secret },
    projection: { ok: false, code: 'invalid_tool_pair', message: secret, body: fullRequest(secret), removed: 2 },
    retry: { retry: true, reason: 'retry_scheduled', delayMs: 25, body: secret, unknown: secret },
    budget: { totalAttempts: 10, policy: { deadlineMs: 100, prompt: secret }, nextState: { attempt: 3, request: secret }, secret },
    message: secret, body: fullRequest(secret), [secret]: secret,
    toJSON() { throw new Error('User serialization hook must not run'); }
  });
  assert.equal(safe, delivered);
  noSecrets(safe, [secret, 'forged', 'body', 'prompt', 'message":"']);
  assert.equal(safe.type, 'unknown');
  assert.equal(safe.requestId.sha256.length, 64);
  assert.deepEqual(safe.classification, { generic400ProjectionCandidate: false, classification: 'transient' });
  assert.deepEqual(safe.projection, { removed: 2, ok: false, code: 'invalid_tool_pair' });
  assert.deepEqual(safe.retry, { delayMs: 25, retry: true, reason: 'retry_scheduled' });
  assert.deepEqual(safe.budget, { totalAttempts: 10, policy: { deadlineMs: 100 }, nextState: { attempt: 3 } });
  assert.equal(Object.isFrozen(safe), true);
  assert.equal(Object.isFrozen(safe.request), true);
});

test('known core and dotted lifecycle event names survive sanitization with correlated IDs', () => {
  const events = [];
  const diagnostics = createDiagnostics({ enabled: true, onEvent: event => events.push(event) });
  const requestId = '01234567-89ab-cdef-0123-456789abcdef';
  const names = ['attempt_start', 'attempt_result', 'recovery', 'projection', 'request_failed', 'request.start', 'attempt.start', 'attempt.end', 'request.end', 'recovery.decision', 'history.projected'];
  for (const type of names) {
    const event = diagnostics.emit({ type, requestId, attemptId: 'attempt_1', headers: { 'x-request-id': 'req_upstream', authorization: 'private' }, classification: 'transient' });
    assert.equal(event.type, type);
    assert.equal(event.requestId, requestId);
    assert.equal(event.headers['x-request-id'], 'req_upstream');
    assert.equal(event.headers.authorization, undefined);
  }
  assert.equal(events.length, names.length);
  assert.equal(diagnostics.emit({ type: 'request.secret_payload' }).type, 'unknown');
});

test('disabled diagnostics never execute factories, getters, callbacks or filesystem operations', () => {
  let calls = 0;
  const options = { enabled: false };
  for (const key of ['onEvent', 'filePath', 'maxFileBytes', 'maxFiles']) Object.defineProperty(options, key, { get() { calls++; throw new Error('Disabled option read'); } });
  const diagnostics = createDiagnostics(options);
  const event = new Proxy({}, { get() { calls++; throw new Error('Disabled traversal'); }, ownKeys() { calls++; throw new Error('Disabled traversal'); } });
  diagnostics.emit(() => { calls++; throw new Error('Disabled factory'); });
  diagnostics.emit(event);
  diagnostics.close();
  assert.equal(diagnostics.enabled, false);
  assert.equal(calls, 0);
  assert.equal(createDiagnostics().enabled, false);
});

test('enabled startup rejects invalid explicit paths and size bounds; disabled bypasses validation', () => {
  for (const filePath of ['', '   ', null, 123, 'unsafe\0path']) {
    assert.throws(() => createDiagnostics({ enabled: true, filePath }), /Invalid diagnostic filePath/);
    assert.equal(createDiagnostics({ enabled: false, filePath }).enabled, false);
  }
  for (const maxFileBytes of [0, -1, null, '1024', Infinity, 1.5, 16 * 1024 * 1024 + 1]) {
    assert.throws(() => createDiagnostics({ enabled: true, maxFileBytes }), /Invalid diagnostic maxFileBytes/);
    assert.equal(createDiagnostics({ enabled: false, maxFileBytes }).enabled, false);
  }
  for (const maxFiles of [0, -1, null, '3', Infinity, 1.5, 11]) {
    assert.throws(() => createDiagnostics({ enabled: true, maxFiles }), /Invalid diagnostic maxFiles/);
    assert.equal(createDiagnostics({ enabled: false, maxFiles }).enabled, false);
  }
  assert.equal(createDiagnostics({ enabled: true }).enabled, true);
  assert.equal(createDiagnostics({ enabled: true, maxFileBytes: 1, maxFiles: 1 }).enabled, true);
  assert.equal(createDiagnostics({ enabled: true, maxFileBytes: 16 * 1024 * 1024, maxFiles: 10 }).enabled, true);
});

test('logging ignores object getters and serialization hooks', () => {
  let calls = 0;
  const request = { model: 'gpt-5', input: [{ role: 'user' }] };
  Object.defineProperty(request.input[0], 'content', { get() { calls++; throw new Error('Secret getter'); } });
  Object.defineProperty(request, 'tools', { get() { calls++; throw new Error('Secret getter'); } });
  request.toJSON = () => { calls++; return 'private'; };
  const diagnostics = createDiagnostics({ enabled: true });
  assert.doesNotThrow(() => diagnostics.emit({ type: 'request', request }));
  assert.equal(calls, 0);
});

test('throwing factories, callbacks and filesystem failures cannot fail a request', t => {
  const directory = temporary(t);
  const unavailable = path.join(directory, 'not-a-directory');
  fs.writeFileSync(unavailable, 'existing-user-file');
  let calls = 0;
  const diagnostics = createDiagnostics({ enabled: true, filePath: path.join(unavailable, 'events.jsonl'), onEvent() { calls++; throw new Error('consumer failure'); } });
  assert.doesNotThrow(() => diagnostics.emit(() => { throw new Error('factory failure'); }));
  assert.equal(calls, 0);
  assert.doesNotThrow(() => diagnostics.emit({ type: 'request', request: { model: 'gpt-5' } }));
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(unavailable, 'utf8'), 'existing-user-file');
  diagnostics.close();
  diagnostics.close();
  assert.doesNotThrow(() => diagnostics.emit(() => { throw new Error('closed factory'); }));
  assert.equal(calls, 1);
});

test('JSONL rotates within byte and file bounds, remains parseable and uses private file permissions', t => {
  const directory = temporary(t);
  const file = path.join(directory, 'nested', 'events.jsonl');
  const diagnostics = createDiagnostics({ enabled: true, filePath: file, maxFileBytes: 256, maxFiles: 3 });
  for (let attempt = 1; attempt <= 50; attempt++) diagnostics.emit({ type: 'attempt_start', attempt, statusCode: 503, error: { code: 'server_error' } });
  diagnostics.close();
  const names = fs.readdirSync(path.dirname(file)).sort();
  assert.deepEqual(names, ['events.jsonl', 'events.jsonl.1', 'events.jsonl.2']);
  let finalAttempt = 0;
  for (const name of names) {
    const target = path.join(path.dirname(file), name);
    const stat = fs.statSync(target);
    assert.ok(stat.size > 0 && stat.size <= 256);
    if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
    const lines = fs.readFileSync(target, 'utf8').trim().split('\n');
    for (const line of lines) {
      const event = JSON.parse(line);
      finalAttempt = Math.max(finalAttempt, event.attempt);
      assert.equal(event.error.code, 'server_error');
    }
  }
  assert.equal(finalAttempt, 50);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test('file and directory modes are handled without chmod on existing user directories', t => {
  if (process.platform === 'win32') return;
  const directory = temporary(t);
  fs.chmodSync(directory, 0o755);
  const file = path.join(directory, 'events.jsonl');
  fs.writeFileSync(file, '', { mode: 0o644 });
  const diagnostics = createDiagnostics({ enabled: true, filePath: file });
  diagnostics.emit({ type: 'request' });
  assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('oversized lines are dropped rather than breaching limits or producing partial JSON', t => {
  const directory = temporary(t);
  const file = path.join(directory, 'events.jsonl');
  let callbacks = 0;
  const diagnostics = createDiagnostics({ enabled: true, filePath: file, maxFileBytes: 32, maxFiles: 1, onEvent() { callbacks++; } });
  diagnostics.emit({ type: 'request', request: fullRequest('private') });
  assert.equal(fs.existsSync(file), false);
  diagnostics.emit({ type: 'request' });
  for (let i = 0; i < 5; i++) diagnostics.emit({ type: 'request' });
  assert.equal(fs.statSync(file).size, Buffer.byteLength('{"type":"request"}\n'));
  assert.deepEqual(fs.readdirSync(directory), ['events.jsonl']);
  assert.equal(callbacks, 7);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'request' });
});

test('symlink files, rotated files and parent directories are not followed or replaced', t => {
  if (process.platform === 'win32') return;
  const directory = temporary(t);
  const target = path.join(directory, 'private-target');
  fs.writeFileSync(target, 'sensitive-original', { mode: 0o644 });
  const link = path.join(directory, 'events.jsonl');
  fs.symlinkSync(target, link);
  let callbacks = 0;
  const diagnostics = createDiagnostics({ enabled: true, filePath: link, maxFileBytes: 64, onEvent() { callbacks++; } });
  diagnostics.emit({ type: 'request' });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'sensitive-original');
  assert.equal(fs.statSync(target).mode & 0o777, 0o644);
  assert.equal(callbacks, 1);
  const realFile = path.join(directory, 'rotation.jsonl');
  fs.writeFileSync(realFile, 'existing-log');
  fs.symlinkSync(target, `${realFile}.1`);
  createDiagnostics({ enabled: true, filePath: realFile, maxFileBytes: 16 }).emit({ type: 'request' });
  assert.equal(fs.readFileSync(realFile, 'utf8'), 'existing-log');
  assert.equal(fs.lstatSync(`${realFile}.1`).isSymbolicLink(), true);
  const parent = path.join(directory, 'parent');
  fs.symlinkSync(directory, parent);
  createDiagnostics({ enabled: true, filePath: path.join(parent, 'new-log') }).emit({ type: 'request' });
  assert.equal(fs.existsSync(path.join(directory, 'new-log')), false);
});

test('standard macOS temp aliases work while user-created descendant symlinks remain refused', t => {
  if (process.platform !== 'darwin') return;
  for (const parent of [os.tmpdir(), '/tmp']) {
    const directory = fs.mkdtempSync(path.join(parent, 'bridge-diagnostics-alias-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'events.jsonl');
    const diagnostics = createDiagnostics({ enabled: true, filePath: file });
    diagnostics.emit({ type: 'request' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'request' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const link = path.join(directory, 'user-link');
    fs.symlinkSync(directory, link);
    createDiagnostics({ enabled: true, filePath: path.join(link, 'must-not-write.jsonl') }).emit({ type: 'request' });
    assert.equal(fs.existsSync(path.join(directory, 'must-not-write.jsonl')), false);
  }
});

test('hardlinked logs and writable non-sticky parent directories are refused', t => {
  if (process.platform === 'win32') return;
  const directory = temporary(t);
  const target = path.join(directory, 'target');
  const file = path.join(directory, 'events.jsonl');
  fs.writeFileSync(target, 'existing-target');
  fs.linkSync(target, file);
  createDiagnostics({ enabled: true, filePath: file }).emit({ type: 'request' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'existing-target');
  const shared = path.join(directory, 'shared');
  fs.mkdirSync(shared, { mode: 0o777 });
  fs.chmodSync(shared, 0o777);
  createDiagnostics({ enabled: true, filePath: path.join(shared, 'events.jsonl') }).emit({ type: 'request' });
  assert.equal(fs.existsSync(path.join(shared, 'events.jsonl')), false);
  assert.equal(fs.statSync(shared).mode & 0o777, 0o777);
});

test('cyclic recovery metadata and namespace tools are bounded without arbitrary recursion', () => {
  const cyclic = { totalAttempts: 10 };
  cyclic.policy = cyclic;
  cyclic.nextState = cyclic;
  const namespace = { type: 'namespace', tools: [] };
  namespace.tools.push(namespace);
  const diagnostics = createDiagnostics({ enabled: true });
  const safe = diagnostics.emit({ type: 'retry', budget: cyclic, request: { tools: [namespace] } });
  assert.equal(safe.budget.totalAttempts, 10);
  assert.equal(safe.budget.nextState.policy.totalAttempts, 10);
  assert.equal(safe.request.toolCount, 1);
});

test('partial synchronous writes are completed and failed partial lines are rolled back', t => {
  const directory = temporary(t);
  const file = path.join(directory, 'events.jsonl');
  const diagnostics = createDiagnostics({ enabled: true, filePath: file });
  const write = fs.writeSync;
  let writes = 0;
  try {
    fs.writeSync = (fd, buffer, offset, length) => { writes++; return write(fd, buffer, offset, Math.min(5, length)); };
    diagnostics.emit({ type: 'request' });
  } finally { fs.writeSync = write; }
  assert.ok(writes > 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'request' });
  const original = fs.readFileSync(file, 'utf8');
  writes = 0;
  try {
    fs.writeSync = (fd, buffer, offset, length) => {
      if (++writes > 1) throw new Error('Disk full after partial write');
      return write(fd, buffer, offset, Math.min(5, length));
    };
    assert.doesNotThrow(() => diagnostics.emit({ type: 'request' }));
  } finally { fs.writeSync = write; }
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('append-handle truncation failure reopens the same file without append and rolls back the partial line', t => {
  const directory = temporary(t);
  const file = path.join(directory, 'events.jsonl');
  const diagnostics = createDiagnostics({ enabled: true, filePath: file });
  diagnostics.emit({ type: 'request' });
  const original = fs.readFileSync(file, 'utf8');
  const write = fs.writeSync;
  const truncate = fs.ftruncateSync;
  const open = fs.openSync;
  const close = fs.closeSync;
  const opens = [];
  const truncations = [];
  const closed = [];
  let writes = 0;
  let appendFd;
  try {
    fs.openSync = (target, flags, ...args) => {
      const fd = open(target, flags, ...args);
      opens.push({ target, flags, fd });
      if (flags & fs.constants.O_APPEND) appendFd = fd;
      return fd;
    };
    fs.writeSync = (fd, buffer, offset, length) => {
      if (++writes > 1) throw new Error('Synthetic disk full after partial write');
      return write(fd, buffer, offset, Math.min(5, length));
    };
    fs.ftruncateSync = (fd, length) => {
      truncations.push({ fd, length });
      if (fd === appendFd) throw new Error('Synthetic append handle cannot truncate');
      return truncate(fd, length);
    };
    fs.closeSync = fd => { closed.push(fd); return close(fd); };
    assert.doesNotThrow(() => diagnostics.emit({ type: 'request' }));
  } finally {
    fs.writeSync = write;
    fs.ftruncateSync = truncate;
    fs.openSync = open;
    fs.closeSync = close;
    diagnostics.close();
  }
  assert.equal(writes, 2);
  assert.equal(truncations.length, 2);
  const appendIndex = opens.findIndex(entry => entry.fd === appendFd && entry.flags & fs.constants.O_APPEND);
  const rollback = opens[appendIndex + 1];
  assert.ok(appendIndex >= 0);
  assert.ok(rollback);
  assert.equal(rollback.target, file);
  assert.equal(rollback.flags & fs.constants.O_APPEND, 0);
  assert.equal(rollback.flags & fs.constants.O_TRUNC, 0);
  assert.equal(rollback.flags & fs.constants.O_CREAT, 0);
  assert.equal(rollback.flags & fs.constants.O_WRONLY, fs.constants.O_WRONLY);
  if (fs.constants.O_NOFOLLOW) assert.equal(rollback.flags & fs.constants.O_NOFOLLOW, fs.constants.O_NOFOLLOW);
  assert.deepEqual(truncations, [
    { fd: appendFd, length: Buffer.byteLength(original) },
    { fd: rollback.fd, length: Buffer.byteLength(original) }
  ]);
  assert.ok(closed.includes(appendFd));
  assert.ok(closed.includes(rollback.fd));
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'request' });
});

test('append rollback refuses a reopened file whose identity changed without truncating it', t => {
  const directory = temporary(t);
  const file = path.join(directory, 'events.jsonl');
  const diagnostics = createDiagnostics({ enabled: true, filePath: file });
  diagnostics.emit({ type: 'request' });
  const original = fs.readFileSync(file, 'utf8');
  const write = fs.writeSync;
  const truncate = fs.ftruncateSync;
  const stat = fs.fstatSync;
  const open = fs.openSync;
  const close = fs.closeSync;
  const truncated = [];
  const closed = [];
  let writes = 0;
  let appendFd;
  let rollbackFd;
  let needsRollback = false;
  try {
    fs.openSync = (target, flags, ...args) => {
      const fd = open(target, flags, ...args);
      if (flags & fs.constants.O_APPEND) appendFd = fd;
      else if (needsRollback) rollbackFd = fd;
      return fd;
    };
    fs.writeSync = (fd, buffer, offset, length) => {
      if (++writes > 1) throw new Error('Synthetic disk full after partial write');
      return write(fd, buffer, offset, Math.min(5, length));
    };
    fs.ftruncateSync = (fd, length) => {
      truncated.push(fd);
      if (fd === appendFd) {
        needsRollback = true;
        throw new Error('Synthetic append handle cannot truncate');
      }
      return truncate(fd, length);
    };
    fs.fstatSync = fd => {
      const current = stat(fd);
      if (fd === rollbackFd) {
        return { isFile: () => true, nlink: current.nlink, uid: current.uid, dev: current.dev, ino: current.ino + 1 };
      }
      return current;
    };
    fs.closeSync = fd => { closed.push(fd); return close(fd); };
    assert.doesNotThrow(() => diagnostics.emit({ type: 'request' }));
  } finally {
    fs.writeSync = write;
    fs.ftruncateSync = truncate;
    fs.fstatSync = stat;
    fs.openSync = open;
    fs.closeSync = close;
    diagnostics.close();
  }
  assert.equal(writes, 2);
  assert.notEqual(rollbackFd, undefined);
  assert.deepEqual(truncated, [appendFd]);
  assert.ok(closed.includes(appendFd));
  assert.ok(closed.includes(rollbackFd));
  assert.equal(fs.readFileSync(file, 'utf8'), original + '{"typ');
});

test('existing archives are tightened to private permissions without changing directory permissions', t => {
  if (process.platform === 'win32') return;
  const directory = temporary(t);
  fs.chmodSync(directory, 0o755);
  const file = path.join(directory, 'events.jsonl');
  fs.writeFileSync(file, 'existing-log-that-needs-rotation', { mode: 0o644 });
  fs.writeFileSync(`${file}.1`, 'older-log', { mode: 0o644 });
  createDiagnostics({ enabled: true, filePath: file, maxFileBytes: 32 }).emit({ type: 'request' });
  for (const name of fs.readdirSync(directory)) assert.equal(fs.statSync(path.join(directory, name)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
});

test('rejected asynchronous callbacks and factories are consumed without unhandled rejections', async () => {
  const diagnostics = createDiagnostics({ enabled: true, async onEvent() { throw new Error('async consumer failure'); } });
  assert.doesNotThrow(() => diagnostics.emit({ type: 'request' }));
  assert.doesNotThrow(() => diagnostics.emit(async () => { throw new Error('async factory failure'); }));
  await new Promise(resolve => setImmediate(resolve));
});

test('filesystem write and close failures are isolated and callback cannot poison file output', t => {
  const directory = temporary(t);
  const file = path.join(directory, 'events.jsonl');
  let calls = 0;
  const diagnostics = createDiagnostics({ enabled: true, filePath: file, onEvent(event) { calls++; event.injected = 'private'; } });
  const write = fs.writeSync;
  try {
    fs.writeSync = () => { throw new Error('disk unavailable'); };
    assert.doesNotThrow(() => diagnostics.emit({ type: 'request' }));
  } finally { fs.writeSync = write; }
  assert.equal(calls, 1);
  assert.equal(fs.statSync(file).size, 0);
  assert.doesNotThrow(() => diagnostics.emit({ type: 'request' }));
  assert.equal(calls, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { type: 'request' });
  const close = fs.closeSync;
  try {
    fs.closeSync = fd => { close(fd); throw new Error('close unavailable'); };
    assert.doesNotThrow(() => diagnostics.emit({ type: 'request' }));
  } finally { fs.closeSync = close; }
  assert.equal(calls, 3);
});
