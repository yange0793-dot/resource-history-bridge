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
