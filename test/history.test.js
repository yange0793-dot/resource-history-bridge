'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isKnownResourceError, projectResponsesHistory } = require('..');
const { classifyFrame } = require('../lib/sse');

const known = 'The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it.';
function history() {
  return {
    model: 'mock-model', prompt_cache_key: 'cache-same', session_id: 'session-same', metadata: { conversation_id: 'metadata-same' },
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add 19 and 23', metadata: { id: 'nested-keep' } }] },
      { type: 'reasoning', id: 'reasoning-remove', encrypted_content: 'MOCK_ENCRYPTED', summary: [] },
      { type: 'function_call', id: 'function-remove', call_id: 'call-keep', name: 'add', arguments: '{"a":19,"b":23}' },
      { type: 'function_call_output', call_id: 'call-keep', output: '42' }
    ]
  };
}

test('known error recognizes JSON wrappers and response.failed but not other failures', () => {
  assert.equal(isKnownResourceError({ error: { message: known, type: 'invalid_request_error', code: null } }), true);
  assert.equal(isKnownResourceError(JSON.stringify({ error: { message: `${known} [trace_id=mock]` } })), true);
  assert.equal(isKnownResourceError({ message: known, type: 'invalid_request_error', code: null }), true);
  assert.equal(isKnownResourceError({ type: 'error', message: known }), true);
  assert.equal(isKnownResourceError({ type: 'response.failed', response: { error: { message: known } } }), true);
  assert.equal(isKnownResourceError({ error: { message: `ag API error (400): ${JSON.stringify({ message: known })}` } }), true);
  for (const value of ['different resource', 'session expired', { error: { message: 'Invalid encrypted content' } }, null, { input: known }]) {
    assert.equal(isKnownResourceError(value), false);
  }
});

for (const [name, value] of [
  ['raw error sentence', known],
  ['JSON string sentence', JSON.stringify(known)],
  ['bare message', { message: known }],
  ['prompt', { prompt: known }],
  ['text delta', { type: 'response.output_text.delta', delta: known }],
  ['error hidden in delta', { type: 'response.output_text.delta', error: { message: known } }],
  ['JSON envelope output', { error: { message: known }, output: ['semantic'] }],
  ['JSON envelope unknown', { error: { message: known }, surprise: 'unknown' }],
  ['JSON error unknown', { error: { message: known, surprise: 'unknown' } }],
  ['failed response output', { type: 'response.failed', response: { error: { message: known }, output: [{ type: 'message' }] } }],
  ['failed response unknown', { type: 'response.failed', response: { error: { message: known }, surprise: 'unknown' } }],
  ['failed event delta', { type: 'response.failed', delta: 'semantic', response: { error: { message: known } } }]
]) {
  test(`matcher rejects ${name}`, () => assert.equal(isKnownResourceError(value), false));
}

test('projection removes only supported item IDs and preserves complete original and tool/cache/session data', () => {
  const original = history();
  const before = JSON.stringify(original);
  const result = projectResponsesHistory(original);
  assert.equal(result.ok, true);
  assert.equal(result.removed, 2);
  assert.equal(JSON.stringify(original), before);
  assert.equal(result.body.input[1].encrypted_content, 'MOCK_ENCRYPTED');
  assert.equal(result.body.input[2].call_id, 'call-keep');
  assert.equal(result.body.input[3].call_id, 'call-keep');
  assert.equal(result.body.input[0].content[0].metadata.id, 'nested-keep');
  assert.equal(result.body.prompt_cache_key, original.prompt_cache_key);
  assert.equal(result.body.session_id, original.session_id);
  assert.deepEqual(result.body.metadata, original.metadata);
  assert.equal(Object.hasOwn(result.body.input[1], 'id'), false);
  assert.equal(Object.hasOwn(result.body.input[2], 'id'), false);
  result.body.metadata.conversation_id = 'new';
  assert.equal(original.metadata.conversation_id, 'metadata-same');
});

for (const [name, modify, code] of [
  ['previous_response_id', b => { b.previous_response_id = 'server'; }, 'server_history_reference'],
  ['conversation', b => { b.conversation = { id: 'server' }; }, 'server_history_reference'],
  ['reference-only', b => { b.input = [{ type: 'item_reference', id: 'server' }]; }, 'item_reference'],
  ['text-only', b => { b.input = 'Hello'; }, 'explicit_history_required'],
  ['unknown IDs', b => { b.input = [{ type: 'message', id: 'keep', content: [] }]; }, 'unsupported_item_id'],
  ['message ID mixed with supported IDs', b => { b.input[0].id = 'message-keep'; }, 'unsupported_item_id'],
  ['tool output ID mixed with supported IDs', b => { b.input[3].id = 'output-keep'; }, 'unsupported_item_id'],
  ['unknown type ID mixed with supported IDs', b => { b.input.push({ type: 'unknown_type', id: 'unknown-keep' }); }, 'unsupported_item_id'],
  ['no supported IDs', b => { b.input = [{ type: 'message', content: [] }]; }, 'no_supported_item_ids'],
  ['string history item', b => { b.input.push('user text'); }, 'invalid_history_item'],
  ['null history item', b => { b.input.push(null); }, 'invalid_history_item'],
  ['array history item', b => { b.input.push([]); }, 'invalid_history_item'],
  ['number history item', b => { b.input.push(42); }, 'invalid_history_item'],
  ['missing output', b => { b.input.pop(); }, 'invalid_tool_pair'],
  ['orphan output', b => { b.input.splice(2, 1); }, 'invalid_tool_pair'],
  ['output before call', b => { [b.input[2], b.input[3]] = [b.input[3], b.input[2]]; }, 'invalid_tool_pair'],
  ['duplicate call', b => { b.input.push(b.input[2]); }, 'invalid_tool_pair'],
  ['duplicate output', b => { b.input.push(b.input[3]); }, 'invalid_tool_pair'],
  ['missing arguments', b => { delete b.input[2].arguments; }, 'invalid_tool_pair'],
  ['missing output payload', b => { delete b.input[3].output; }, 'invalid_tool_pair']
]) {
  test(`projection refuses ${name} without changing history`, () => {
    const body = history();
    modify(body);
    const before = JSON.stringify(body);
    const result = projectResponsesHistory(body);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(JSON.stringify(body), before);
  });
}

function codexHistory() {
  const body = history();
  body.input[0].id = 'user-remove';
  body.input.unshift({
    type: 'additional_tools', id: 'tools-keep', role: 'developer',
    tools: [{ type: 'custom', name: 'exec', description: 'Execute a script', format: { type: 'text' } }]
  });
  body.input.push(
    { type: 'message', id: 'assistant-remove', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Calculating.' }] },
    { type: 'custom_tool_call', id: 'custom-keep', call_id: 'custom-call-keep', name: 'exec', input: 'print(19 + 23)\n', status: 'completed' },
    { type: 'custom_tool_call_output', id: 'custom-output-keep', call_id: 'custom-call-keep', output: { stdout: '42', exit_code: 0 } }
  );
  return body;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test('explicit minimal mode preserves the default projection and refusals', () => {
  assert.deepEqual(projectResponsesHistory(history(), { mode: 'minimal' }), projectResponsesHistory(history()));
  const body = codexHistory();
  assert.deepEqual(projectResponsesHistory(body, { mode: 'minimal' }), projectResponsesHistory(body));
  assert.equal(projectResponsesHistory(body).code, 'unsupported_item_id');
});

test('default mode refuses retained Codex IDs when standard IDs are otherwise supported', () => {
  const codex = codexHistory();
  for (const item of [codex.input[0], codex.input[6], codex.input[7]]) {
    const body = history();
    body.input.push(structuredClone(item));
    assert.equal(projectResponsesHistory(body).code, 'unsupported_item_id');
  }
});

test('projection refuses unknown history modes without changing the body', () => {
  const body = freeze(history());
  for (const mode of ['automatic', '', null, 1]) {
    const result = projectResponsesHistory(body, { mode });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unsupported_history_mode');
  }
});

test('Codex projection removes only message and standard IDs from complete immutable history', () => {
  const original = freeze(codexHistory());
  const before = JSON.stringify(original);
  const result = projectResponsesHistory(original, { mode: 'codex' });
  assert.equal(result.ok, true);
  assert.equal(result.removed, 4);
  const expected = structuredClone(original);
  for (const item of expected.input) {
    if (['message', 'reasoning', 'function_call'].includes(item.type)) delete item.id;
  }
  assert.deepEqual(result.body, expected);
  assert.equal(JSON.stringify(original), before);
  assert.equal(result.body.input[0].id, 'tools-keep');
  assert.equal(result.body.input[6].id, 'custom-keep');
  assert.equal(result.body.input[7].id, 'custom-output-keep');
  result.body.input[0].tools[0].description = 'Changed';
  result.body.input[7].output.stdout = 'Changed';
  assert.equal(original.input[0].tools[0].description, 'Execute a script');
  assert.equal(original.input[7].output.stdout, '42');
});

for (const role of ['user', 'developer', 'system', 'assistant']) {
  test(`Codex projection accepts a complete ${role} message`, () => {
    const body = { model: 'mock-model', input: [{ type: 'message', id: 'remove', role, content: [{ type: 'input_text', text: 'Inline history' }] }] };
    const result = projectResponsesHistory(body, { mode: 'codex' });
    assert.equal(result.ok, true);
    assert.equal(result.removed, 1);
    assert.equal(Object.hasOwn(result.body.input[0], 'id'), false);
  });
}

for (const phase of ['commentary', 'final_answer']) {
  test(`Codex projection preserves known message phase ${phase}`, () => {
    const body = codexHistory();
    body.input[5].phase = phase;
    const result = projectResponsesHistory(body, { mode: 'codex' });
    assert.equal(result.ok, true);
    assert.equal(result.body.input[5].phase, phase);
  });
}

test('Codex projection accepts standard history and preserves complete unknown items without IDs', () => {
  const body = history();
  body.input.push({ type: 'future_type', payload: { id: 'nested-keep' } });
  assert.deepEqual(projectResponsesHistory(body, { mode: 'codex' }), projectResponsesHistory(body));
});

test('Codex projection preserves complete inline image content and nested IDs', () => {
  for (const image_url of ['data:image/png;base64,MOCK', 'https://example.invalid/image.png', 'http://example.invalid/image.png']) {
    const body = { input: [{ type: 'message', id: 'remove', role: 'user', content: [{ type: 'input_image', image_url, detail: 'auto', metadata: { id: 'nested-keep' } }] }] };
    const result = projectResponsesHistory(body, { mode: 'codex' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.body.input[0].content, body.input[0].content);
  }
});

test('Codex projection preserves recursive namespace, function and custom grammar schemas', () => {
  for (const syntax of ['lark', 'regex']) {
    const body = codexHistory();
    body.input[0].tools = [{
      type: 'namespace', name: 'functions', description: 'Execution tools',
      tools: [
        { type: 'custom', name: 'exec', description: 'Execute a script', format: { type: 'grammar', syntax, definition: 'start: /.+/', metadata: { id: 'grammar-keep' } } },
        { type: 'namespace', name: 'nested', tools: [{ type: 'function', name: 'wait', strict: false, parameters: { type: 'object', properties: { duration: { type: 'number' } }, required: ['duration'], additionalProperties: false } }] }
      ]
    }];
    freeze(body);
    const result = projectResponsesHistory(body, { mode: 'codex' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.body.input[0], body.input[0]);
    assert.equal(result.body.input[0].tools[0].tools[1].tools[0].strict, false);
  }
});

test('Codex projection preserves absent message phase and custom status without inventing fields', () => {
  const body = codexHistory();
  delete body.input[5].phase;
  delete body.input[6].status;
  const result = projectResponsesHistory(body, { mode: 'codex' });
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.body.input[5], 'phase'), false);
  assert.equal(Object.hasOwn(result.body.input[6], 'status'), false);
});

test('Codex custom outputs preserve string, object and null payloads without interpretation', () => {
  for (const output of ['42', { stdout: '42' }, null]) {
    const body = codexHistory();
    body.input[7].output = output;
    const result = projectResponsesHistory(body, { mode: 'codex' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.body.input[7].output, output);
    assert.equal(result.body.input[6].input, 'print(19 + 23)\n');
  }
});

for (const [name, modify, code] of [
  ['missing message role', b => { delete b.input[1].role; }, 'invalid_history_item'],
  ['unknown message role', b => { b.input[1].role = 'tool'; }, 'invalid_history_item'],
  ['missing message content', b => { delete b.input[1].content; }, 'invalid_history_item'],
  ['empty message content', b => { b.input[1].content = []; }, 'invalid_history_item'],
  ['string message content', b => { b.input[1].content = 'Not expanded'; }, 'invalid_history_item'],
  ['unknown message phase', b => { b.input[5].phase = 'future_phase'; }, 'invalid_history_item'],
  ['null message phase', b => { b.input[5].phase = null; }, 'invalid_history_item'],
  ['invalid message ID', b => { b.input[1].id = null; }, 'invalid_history_item'],
  ['non-object content', b => { b.input[1].content = ['text']; }, 'invalid_history_item'],
  ['missing text payload', b => { b.input[1].content = [{ type: 'input_text' }]; }, 'invalid_history_item'],
  ['referenced message content', b => { b.input[1].content = [{ type: 'item_reference', id: 'server' }]; }, 'invalid_history_item'],
  ['unknown content type', b => { b.input[1].content = [{ type: 'future_content', data: 'opaque' }]; }, 'invalid_history_item'],
  ['referenced image content', b => { b.input[1].content = [{ type: 'input_image', file_id: 'server' }]; }, 'invalid_history_item'],
  ['incomplete image content', b => { b.input[1].content = [{ type: 'input_image' }]; }, 'invalid_history_item'],
  ['relative image URL', b => { b.input[1].content = [{ type: 'input_image', image_url: 'image.png' }]; }, 'invalid_history_item'],
  ['unsupported image URL scheme', b => { b.input[1].content = [{ type: 'input_image', image_url: 'file:///image.png' }]; }, 'invalid_history_item'],
  ['empty data image', b => { b.input[1].content = [{ type: 'input_image', image_url: 'data:image/png;base64,' }]; }, 'invalid_history_item'],
  ['mixed inline and server image content', b => { b.input[1].content = [{ type: 'input_image', image_url: 'data:image/png;base64,MOCK', file_id: 'server' }]; }, 'invalid_history_item'],
  ['missing additional_tools ID', b => { delete b.input[0].id; }, 'invalid_history_item'],
  ['wrong additional_tools role', b => { b.input[0].role = 'user'; }, 'invalid_history_item'],
  ['missing additional_tools schemas', b => { delete b.input[0].tools; }, 'invalid_history_item'],
  ['referenced additional_tools schema', b => { b.input[0].tools = ['server-tool']; }, 'invalid_history_item'],
  ['empty additional_tools schema object', b => { b.input[0].tools = [{}]; }, 'invalid_history_item'],
  ['unknown additional_tools schema type', b => { b.input[0].tools = [{ type: 'future_tool', name: 'exec' }]; }, 'invalid_history_item'],
  ['missing function parameters', b => { b.input[0].tools = [{ type: 'function', name: 'wait' }]; }, 'invalid_history_item'],
  ['referenced function parameters', b => { b.input[0].tools = [{ type: 'function', name: 'wait', parameters: 'server-schema' }]; }, 'invalid_history_item'],
  ['missing namespace name', b => { b.input[0].tools = [{ type: 'namespace', tools: [] }]; }, 'invalid_history_item'],
  ['missing namespace tools', b => { b.input[0].tools = [{ type: 'namespace', name: 'functions' }]; }, 'invalid_history_item'],
  ['incomplete nested namespace tool', b => { b.input[0].tools = [{ type: 'namespace', name: 'functions', tools: [{}] }]; }, 'invalid_history_item'],
  ['missing custom format', b => { b.input[0].tools = [{ type: 'custom', name: 'exec' }]; }, 'invalid_history_item'],
  ['unknown custom format', b => { b.input[0].tools = [{ type: 'custom', name: 'exec', format: { type: 'future_format' } }]; }, 'invalid_history_item'],
  ['missing grammar definition', b => { b.input[0].tools = [{ type: 'custom', name: 'exec', format: { type: 'grammar', syntax: 'lark' } }]; }, 'invalid_history_item'],
  ['empty grammar definition', b => { b.input[0].tools = [{ type: 'custom', name: 'exec', format: { type: 'grammar', syntax: 'lark', definition: '' } }]; }, 'invalid_history_item'],
  ['unknown grammar syntax', b => { b.input[0].tools = [{ type: 'custom', name: 'exec', format: { type: 'grammar', syntax: 'unknown', definition: 'start: /.+/' } }]; }, 'invalid_history_item'],
  ['missing custom call ID', b => { delete b.input[6].id; }, 'invalid_tool_pair'],
  ['missing custom call_id', b => { delete b.input[6].call_id; }, 'invalid_tool_pair'],
  ['missing custom name', b => { delete b.input[6].name; }, 'invalid_tool_pair'],
  ['missing custom input', b => { delete b.input[6].input; }, 'invalid_tool_pair'],
  ['non-string custom input', b => { b.input[6].input = { script: 'print(42)' }; }, 'invalid_tool_pair'],
  ['in-progress custom status', b => { b.input[6].status = 'in_progress'; }, 'invalid_tool_pair'],
  ['incomplete custom status', b => { b.input[6].status = 'incomplete'; }, 'invalid_tool_pair'],
  ['null custom status', b => { b.input[6].status = null; }, 'invalid_tool_pair'],
  ['unknown custom status', b => { b.input[6].status = 'unknown'; }, 'invalid_tool_pair'],
  ['missing custom output ID', b => { delete b.input[7].id; }, 'invalid_tool_pair'],
  ['missing custom output payload', b => { delete b.input[7].output; }, 'invalid_tool_pair'],
  ['missing custom output', b => { b.input.pop(); }, 'invalid_tool_pair'],
  ['orphan custom output', b => { b.input.splice(6, 1); }, 'invalid_tool_pair'],
  ['custom output before call', b => { [b.input[6], b.input[7]] = [b.input[7], b.input[6]]; }, 'invalid_tool_pair'],
  ['duplicate custom call', b => { b.input.push(structuredClone(b.input[6])); }, 'invalid_tool_pair'],
  ['duplicate custom output', b => { b.input.push(structuredClone(b.input[7])); }, 'invalid_tool_pair'],
  ['cross-type duplicate call', b => { b.input[6].call_id = b.input[3].call_id; }, 'invalid_tool_pair'],
  ['function output for custom call', b => { b.input[7] = { type: 'function_call_output', call_id: b.input[6].call_id, output: '42' }; }, 'invalid_tool_pair'],
  ['custom output for function call', b => { b.input[4] = { type: 'custom_tool_call_output', id: 'keep', call_id: b.input[3].call_id, output: '42' }; }, 'invalid_tool_pair'],
  ['unknown top-level ID type', b => { b.input.push({ type: 'future_type', id: 'unknown' }); }, 'unsupported_item_id'],
  ['standard tool output ID', b => { b.input[4].id = 'unknown'; }, 'unsupported_item_id'],
  ['server previous_response_id', b => { b.previous_response_id = 'server'; }, 'server_history_reference'],
  ['server conversation', b => { b.conversation = { id: 'server' }; }, 'server_history_reference'],
  ['server item reference', b => { b.input.push({ type: 'item_reference', id: 'server' }); }, 'item_reference'],
  ['only retained IDs', b => { b.input = [b.input[0], b.input[6], b.input[7]]; }, 'no_supported_item_ids'],
  ['no message or standard IDs', b => { for (const item of b.input) if (['message', 'reasoning', 'function_call'].includes(item.type)) delete item.id; }, 'no_supported_item_ids']
]) {
  test(`Codex projection refuses ${name} without changing history`, () => {
    const body = codexHistory();
    modify(body);
    const before = JSON.stringify(body);
    freeze(body);
    const result = projectResponsesHistory(body, { mode: 'codex' });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(JSON.stringify(body), before);
  });
}

test('SSE classifier holds only recognized empty lifecycle frames', () => {
  const frame = value => Buffer.from(`data: ${JSON.stringify(value)}\n\n`);
  assert.equal(classifyFrame(frame({ type: 'response.created', response: { id: 'response', output: [] } })), 'hold');
  assert.equal(classifyFrame(frame({ type: 'response.failed', response: { error: { message: known } } })), 'recover');
  for (const value of [
    { type: 'response.created', response: { output: [{ type: 'message' }] } },
    { type: 'response.created', delta: 'text', response: {} },
    { type: 'response.created', response: { surprise: 'unknown' } },
    { type: 'response.output_text.delta', delta: 'text' },
    { type: 'response.failed', response: { error: { message: 'schema' } } }
  ]) assert.equal(classifyFrame(frame(value)), 'commit');
  assert.equal(classifyFrame(Buffer.from(': heartbeat\n\n')), 'commit');
  assert.equal(classifyFrame(Buffer.from('data: not-json\n\n')), 'commit');
  assert.equal(classifyFrame(Buffer.from('event: error\ndata: {"type":"response.created","response":{}}\n\n')), 'commit');
});

module.exports = { history, known };
