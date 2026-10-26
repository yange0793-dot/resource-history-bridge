'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { messagesToResponses, createMessagesRenderer } = require('../lib/messages');

function request(messages, extra = {}) {
  return { model: 'test-model', max_tokens: 100, messages, ...extra };
}

function renderer(stream = true, options = {}) {
  const chunks = [];
  let ends = 0;
  const result = createMessagesRenderer({ stream, model: 'fallback', write: chunk => chunks.push(chunk), end: () => ends++, ...options });
  return {
    ...result,
    events: () => chunks.join('').split('\n\n').filter(Boolean).map(chunk => JSON.parse(chunk.split('\ndata: ')[1])),
    json: () => JSON.parse(chunks.join('')),
    ends: () => ends
  };
}

function event(type, data = {}) { return { type, ...data }; }
function complete(output = [], extra = {}) { return event('response.completed', { response: { id: 'resp_test', model: 'upstream', status: 'completed', output, ...extra } }); }
function outputText(text, id = 'message_1') { return { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }; }
function tool(id, callId, name, args) { return { type: 'function_call', id, call_id: callId, name, arguments: args }; }
function errorCode(fn) { assert.throws(fn, error => error.code === 'unsupported_messages_content'); }
function assertProtocol(events, success = true) {
  const active = new Set();
  let started = false;
  let lastIndex = -1;
  let stopped = false;
  for (const value of events) {
    if (value.type === 'message_start') {
      assert.equal(started, false);
      started = true;
    } else if (value.type === 'content_block_start') {
      assert.equal(started, true);
      assert.ok(value.index > lastIndex);
      lastIndex = value.index;
      active.add(value.index);
    } else if (value.type === 'content_block_delta') assert.ok(active.has(value.index));
    else if (value.type === 'content_block_stop') {
      assert.ok(active.has(value.index));
      active.delete(value.index);
    } else if (value.type === 'message_stop') {
      assert.equal(active.size, 0);
      assert.equal(stopped, false);
      stopped = true;
    }
  }
  assert.equal(active.size, 0);
  assert.equal(stopped, success);
}

test('converts immutable history preserving block/tool/result order and schema optional fields', () => {
  const body = request([
    { role: 'user', content: 'read' },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'plain reasoning', signature: 'NOT_ENCRYPTED' },
      { type: 'text', text: 'reading' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/file' } }
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body' }, { type: 'text', text: 'continue' }] }
  ], {
    system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
    temperature: 0, top_p: 0.9, output_config: { effort: 'medium' },
    tools: [{ name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, limit: { type: 'integer' } }, required: ['file_path'], additionalProperties: true } }],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true }
  });
  const before = structuredClone(body);
  const result = messagesToResponses(body, { model: 'override' });
  assert.deepEqual(body, before);
  assert.equal(result.model, 'override');
  assert.equal(result.stream, true);
  assert.equal(result.store, false);
  assert.equal(result.max_output_tokens, 100);
  assert.equal(result.temperature, 0);
  assert.equal(result.top_p, 0.9);
  assert.deepEqual(result.reasoning, { effort: 'medium' });
  assert.equal(result.instructions, 'system');
  assert.deepEqual(result.input.map(item => item.type), ['message', 'reasoning', 'message', 'function_call', 'function_call_output', 'message']);
  assert.deepEqual(result.input[1], { type: 'reasoning', summary: [{ type: 'summary_text', text: 'plain reasoning' }] });
  assert.deepEqual(result.input[3], { type: 'function_call', call_id: 'toolu_1', name: 'Read', arguments: '{"file_path":"/tmp/file"}' });
  assert.deepEqual(result.input[4], { type: 'function_call_output', call_id: 'toolu_1', output: 'file body' });
  assert.equal(result.tools[0].strict, false);
  assert.deepEqual(result.tools[0].parameters, body.tools[0].input_schema);
  assert.equal(result.parallel_tool_calls, false);
  result.tools[0].parameters.required.push('limit');
  assert.deepEqual(body, before);
});

test('reasoning content shape and explicit effort configuration', () => {
  const result = messagesToResponses(request([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'plain', signature: '' }] }], { thinking: { type: 'adaptive' }, output_config: { effort: 'max' } }), { reasoningShape: 'content' });
  assert.deepEqual(result.input[0], { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'plain' }] });
  assert.deepEqual(result.reasoning, { effort: 'max' });
});

test('preserves base64 and URL image data in messages and tool results', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } };
  const urlImage = { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } };
  const result = messagesToResponses(request([
    { role: 'user', content: [{ type: 'text', text: 'look' }, image, urlImage] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: [{ type: 'text', text: 'image' }, image] }] }
  ]));
  assert.deepEqual(result.input[0].content, [
    { type: 'input_text', text: 'look' },
    { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
    { type: 'input_image', image_url: 'https://example.test/image.png' }
  ]);
  assert.deepEqual(result.input[2].output, [{ type: 'input_text', text: 'image' }, { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }]);
});

for (const [name, messages] of [
  ['missing call ID', [{ role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: {} }] }]],
  ['missing tool result', [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'Read', input: {} }] }]],
  ['unpaired tool result', [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'ok' }] }]],
  ['redacted reasoning', [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'opaque' }] }]],
  ['unknown content', [{ role: 'user', content: [{ type: 'document', source: {} }] }]],
  ['unknown history field', [{ role: 'user', content: 'ok', id: 'server-reference' }]],
  ['tool result error', [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'Read', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'failed', is_error: true }] }]],
  ['duplicate result', [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'Read', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'a' }, { type: 'tool_result', tool_use_id: 'call', content: 'b' }] }]]
]) test(`rejects ${name} without repairing history`, () => errorCode(() => messagesToResponses(request(messages))));

for (const [name, extra] of [
  ['platform tools', { tools: [{ type: 'tool_search_tool_regex_20251119', name: 'ToolSearch' }] }],
  ['unknown tool metadata', { tools: [{ name: 'Read', input_schema: { type: 'object' }, unknown_tool_field: true }] }],
  ['thinking budget', { thinking: { type: 'enabled', budget_tokens: 1000 } }],
  ['stop sequences', { stop_sequences: ['STOP'] }],
  ['server history reference', { previous_response_id: 'server' }],
  ['unknown output config', { output_config: { format: { type: 'json_schema' } } }]
]) test(`rejects unsupported ${name}`, () => errorCode(() => messagesToResponses(request([{ role: 'user', content: 'ok' }], extra))));

test('ordinary Bash schema and selected tool remain non-strict', () => {
  const result = messagesToResponses(request([{ role: 'user', content: 'run' }], {
    tools: [{ name: 'Bash', description: 'Run shell', input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'], additionalProperties: false } }],
    tool_choice: { type: 'tool', name: 'Bash' }
  }));
  assert.deepEqual(result.tool_choice, { type: 'function', name: 'Bash' });
  assert.deepEqual(result.tools[0].parameters.required, ['command']);
  assert.equal(result.tools[0].parameters.additionalProperties, false);
});

test('stream text deltas plus done and terminal snapshot are never duplicated', () => {
  const r = renderer();
  r.handle(event('response.created', { response: { id: 'resp_test', model: 'upstream', output: [] } }));
  r.handle(event('response.output_text.delta', { item_id: 'message_1', output_index: 0, content_index: 0, delta: 'he' }));
  r.handle(event('response.output_text.delta', { item_id: 'message_1', output_index: 0, content_index: 0, delta: 'llo' }));
  r.handle(event('response.output_text.done', { item_id: 'message_1', output_index: 0, content_index: 0, text: 'hello' }));
  r.handle(complete([outputText('hello')], { usage: { input_tokens: 20, output_tokens: 3, input_tokens_details: { cached_tokens: 12 }, output_tokens_details: { reasoning_tokens: 1 } } }));
  r.finish();
  r.finish();
  const events = r.events();
  assertProtocol(events);
  assert.equal(events[0].message.id, 'resp_test');
  assert.equal(events[0].message.model, 'upstream');
  assert.equal(events.filter(value => value.delta && value.delta.type === 'text_delta').map(value => value.delta.text).join(''), 'hello');
  const delta = events.find(value => value.type === 'message_delta');
  assert.deepEqual(delta.usage, { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 12 });
  assert.equal(delta.delta.stop_reason, 'end_turn');
  assert.equal(r.ends(), 1);
});

test('done-only text/refusal/reasoning events emit missing content', () => {
  const r = renderer(false);
  r.handle(event('response.reasoning_summary_text.done', { item_id: 'r', output_index: 0, summary_index: 0, text: 'reason' }));
  r.handle(event('response.output_text.done', { item_id: 'm', output_index: 1, content_index: 0, text: 'answer' }));
  r.handle(event('response.refusal.done', { item_id: 'm', output_index: 1, content_index: 1, refusal: 'no' }));
  r.handle(complete());
  r.finish();
  assert.deepEqual(r.json().content, [{ type: 'thinking', thinking: 'reason', signature: '' }, { type: 'text', text: 'answer' }, { type: 'text', text: 'no' }]);
  assert.equal(r.json().content[0].signature, '');
});

test('terminal-output-only response renders tools/text/thinking with native call IDs', () => {
  const r = renderer(false);
  r.handle(complete([
    { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'plan' }] },
    outputText('ready'),
    tool('fc', 'toolu_native', 'Read', '{"file_path":"/tmp/file"}')
  ]));
  r.finish();
  assert.deepEqual(r.json().content, [
    { type: 'thinking', thinking: 'plan', signature: '' },
    { type: 'text', text: 'ready' },
    { type: 'tool_use', id: 'toolu_native', name: 'Read', input: { file_path: '/tmp/file' } }
  ]);
  assert.equal(r.json().stop_reason, 'tool_use');
});

test('terminal snapshots supplement text suffix omitted from deltas', () => {
  const r = renderer(false);
  r.handle(event('response.output_text.delta', { item_id: 'message_1', output_index: 0, delta: 'par' }));
  r.handle(complete([outputText('partial')], { usage: { input_tokens: 0, output_tokens: 0 } }));
  r.finish();
  assert.deepEqual(r.json().content, [{ type: 'text', text: 'partial' }]);
  assert.deepEqual(r.json().usage, { input_tokens: 0, output_tokens: 0 });
});

test('output_item.done-only completes tool arguments without duplication', () => {
  const r = renderer();
  r.handle(event('response.output_item.done', { output_index: 0, item: tool('fc', 'call', 'Bash', '{"command":"pwd"}') }));
  r.handle(complete([tool('fc', 'call', 'Bash', '{"command":"pwd"}') ]));
  r.finish();
  const events = r.events();
  assertProtocol(events);
  assert.equal(events.filter(value => value.delta && value.delta.type === 'input_json_delta').map(value => value.delta.partial_json).join(''), '{"command":"pwd"}');
});

test('interleaved tool parameter deltas stay associated by item and index', () => {
  const r = renderer(false);
  r.handle(event('response.output_item.added', { output_index: 0, item: tool('fc_a', 'call_a', 'Read', '') }));
  r.handle(event('response.output_item.added', { output_index: 1, item: tool('fc_b', 'call_b', 'Bash', '') }));
  r.handle(event('response.function_call_arguments.delta', { item_id: 'fc_b', delta: '{"command":' }));
  r.handle(event('response.function_call_arguments.delta', { output_index: 0, delta: '{"file_path":' }));
  r.handle(event('response.function_call_arguments.delta', { item_id: 'fc_b', output_index: 1, delta: '"pwd"}' }));
  r.handle(event('response.function_call_arguments.delta', { item_id: 'fc_a', output_index: 0, delta: '"/tmp/file"}' }));
  r.handle(event('response.function_call_arguments.done', { item_id: 'fc_a', arguments: '{"file_path":"/tmp/file"}' }));
  r.handle(event('response.function_call_arguments.done', { item_id: 'fc_b', arguments: '{"command":"pwd"}' }));
  r.handle(complete([tool('fc_a', 'call_a', 'Read', '{"file_path":"/tmp/file"}'), tool('fc_b', 'call_b', 'Bash', '{"command":"pwd"}') ]));
  r.finish();
  assert.deepEqual(r.json().content, [{ type: 'tool_use', id: 'call_a', name: 'Read', input: { file_path: '/tmp/file' } }, { type: 'tool_use', id: 'call_b', name: 'Bash', input: { command: 'pwd' } }]);
});

test('tool metadata arriving after parameter deltas is required before a block starts', () => {
  const r = renderer();
  r.handle(event('response.function_call_arguments.delta', { item_id: 'fc', output_index: 0, delta: '{"n":1}' }));
  assert.equal(r.events().length, 0);
  r.handle(event('response.output_item.done', { output_index: 0, item: tool('fc', 'call', 'add', '{"n":1}') }));
  r.handle(complete());
  r.finish();
  assertProtocol(r.events());
  assert.equal(r.events().find(value => value.type === 'content_block_start').content_block.id, 'call');
});

test('arguments.done-only metadata may be completed by the terminal snapshot', () => {
  const r = renderer(false);
  r.handle(event('response.function_call_arguments.done', { item_id: 'fc', output_index: 0, arguments: '{"n":1}' }));
  r.handle(complete([tool('fc', 'call', 'add', '{"n":1}')]));
  r.finish();
  assert.deepEqual(r.json().content, [{ type: 'tool_use', id: 'call', name: 'add', input: { n: 1 } }]);
});

test('custom tool calls only convert when input is a JSON object', () => {
  const r = renderer(false);
  r.handle(complete([{ type: 'custom_tool_call', id: 'ct', call_id: 'custom_call', name: 'custom', input: '{"path":"x"}' }]));
  r.finish();
  assert.deepEqual(r.json().content, [{ type: 'tool_use', id: 'custom_call', name: 'custom', input: { path: 'x' } }]);
});

test('custom tool grammar input is buffered until verified and never emits a tool block', () => {
  const r = renderer();
  r.handle(event('response.output_item.added', { output_index: 0, item: { type: 'custom_tool_call', id: 'ct', call_id: 'call', name: 'patch', input: '' } }));
  r.handle(event('response.custom_tool_call_input.delta', { item_id: 'ct', output_index: 0, delta: '*** Begin Patch' }));
  assert.equal(r.events().length, 0);
  r.handle(event('response.custom_tool_call_input.done', { item_id: 'ct', output_index: 0, input: '*** Begin Patch' }));
  r.finish();
  assert.equal(r.events().some(value => value.type === 'content_block_start'), false);
  assert.equal(r.events().at(-1).type, 'error');
});

test('an explicitly empty text part is preserved', () => {
  const r = renderer(false);
  r.handle(complete([outputText('')]));
  r.finish();
  assert.deepEqual(r.json().content, [{ type: 'text', text: '' }]);
});

test('raw reasoning_text events convert to unsigned thinking', () => {
  const r = renderer(false);
  r.handle(event('response.reasoning_text.delta', { item_id: 'r', output_index: 0, content_index: 0, delta: 'plain' }));
  r.handle(event('response.reasoning_text.done', { item_id: 'r', output_index: 0, content_index: 0, text: 'plain' }));
  r.handle(complete([{ type: 'reasoning', id: 'r', content: [{ type: 'reasoning_text', text: 'plain' }] }]));
  r.finish();
  assert.deepEqual(r.json().content, [{ type: 'thinking', thinking: 'plain', signature: '' }]);
});

test('incomplete max-output response maps to max_tokens', () => {
  const r = renderer(false);
  r.handle(event('response.incomplete', { response: { status: 'incomplete', output: [outputText('partial')], incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 2, output_tokens: 100 } } }));
  r.finish();
  assert.equal(r.json().stop_reason, 'max_tokens');
  assert.equal(r.json().usage.output_tokens, 100);
});

for (const [name, bad] of [
  ['invalid JSON tool args', complete([tool('fc', 'call', 'Read', '{bad')])],
  ['array tool args', complete([tool('fc', 'call', 'Read', '[]')])],
  ['missing call ID', complete([{ type: 'function_call', id: 'fc', name: 'Read', arguments: '{}' }])],
  ['free-form custom input', complete([{ type: 'custom_tool_call', id: 'ct', call_id: 'call', name: 'patch', input: '*** Begin Patch' }])],
  ['unknown output item', complete([{ type: 'web_search_call', id: 'w', action: {} }])],
  ['unknown content part', complete([{ type: 'message', id: 'm', content: [{ type: 'output_audio', data: 'opaque' }] }])],
  ['content-bearing unknown event', event('response.new_content.delta', { delta: 'unknown' })],
  ['known event unknown content field', event('response.output_text.delta', { item_id: 'm', delta: 'a', surprise_content: 'b' })],
  ['unknown tool snapshot content field', complete([{ ...tool('fc', 'call', 'Read', '{}'), secret_content: 'b' }])],
  ['unknown text part field', complete([{ type: 'message', id: 'm', content: [{ type: 'output_text', text: 'a', secret_content: 'b' }] }])],
  ['duplicate tool call IDs', complete([tool('fc_a', 'call', 'Read', '{}'), tool('fc_b', 'call', 'Bash', '{}')])],
  ['usage malformed', complete([], { usage: { input_tokens: -1, output_tokens: 1 } })],
  ['unsupported incomplete reason', event('response.incomplete', { response: { output: [], incomplete_details: { reason: 'content_filter' } } })]
]) test(`renderer fails ${name} without message_stop`, () => {
  const r = renderer();
  r.handle(bad);
  r.finish();
  assertProtocol(r.events(), false);
  assert.equal(r.events().at(-1).type, 'error');
  assert.equal(r.ends(), 1);
});

for (const type of ['error', 'response.failed']) test(`${type} closes started blocks and does not claim success`, () => {
  const r = renderer();
  r.handle(event('response.output_text.delta', { item_id: 'm', output_index: 0, delta: 'partial' }));
  r.handle(type === 'error' ? event(type, { error: { message: 'upstream failed', code: 'rate_limit' } }) : event(type, { response: { error: { message: 'upstream failed', code: 'rate_limit' } } }));
  r.finish();
  assertProtocol(r.events(), false);
  assert.deepEqual(r.events().at(-1).error, { type: 'api_error', code: 'rate_limit', message: 'upstream failed' });
});

for (const stream of [true, false]) test(`optional DONE after a terminal response preserves success (stream=${stream})`, () => {
  const r = renderer(stream);
  r.handle(complete([outputText('DONE_OK')]));
  r.handle(event('__done__'));
  r.finish();
  if (stream) {
    assertProtocol(r.events());
    assert.equal(r.events().some(value => value.type === 'error'), false);
    assert.equal(r.events().filter(value => value.delta && value.delta.type === 'text_delta').map(value => value.delta.text).join(''), 'DONE_OK');
  } else assert.deepEqual(r.json().content, [{ type: 'text', text: 'DONE_OK' }]);
  assert.equal(r.ends(), 1);
});

for (const stream of [true, false]) test(`DONE without a terminal response remains an error (stream=${stream})`, () => {
  const r = renderer(stream);
  r.handle(event('__done__'));
  r.finish();
  if (stream) {
    assertProtocol(r.events(), false);
    assert.equal(r.events().at(-1).type, 'error');
  } else assert.equal(r.json().type, 'error');
  assert.equal(r.ends(), 1);
});

test('normal EOF without terminal event is error, not synthetic message_stop', () => {
  const r = renderer();
  r.handle(event('response.output_text.delta', { item_id: 'm', output_index: 0, delta: 'partial' }));
  r.finish();
  assertProtocol(r.events(), false);
  assert.equal(r.events().at(-1).error.type, 'api_error');
  assert.equal(r.events().at(-1).error.code, 'incomplete_upstream_stream');
});

test('nonstream fail writes only a Messages error envelope and ends once', () => {
  const r = renderer(false);
  r.handle(event('response.output_text.delta', { item_id: 'm', output_index: 0, delta: 'partial' }));
  r.fail('transport failed');
  r.finish();
  assert.deepEqual(r.json(), { type: 'error', error: { type: 'api_error', message: 'transport failed' } });
  assert.equal(r.ends(), 1);
});

test('unknown metadata-only events are safe but opaque content is not', () => {
  const r = renderer();
  r.handle(event('response.future_status', { sequence_number: 3, status: 'pending' }));
  r.handle(complete([outputText('ok')]));
  r.finish();
  assertProtocol(r.events());
});

test('unindexed single-message deltas bind to their later snapshot without repetition', () => {
  const r = renderer(false);
  r.handle(event('response.output_text.delta', { delta: 'one' }));
  r.handle(complete([outputText('one')]));
  r.finish();
  assert.deepEqual(r.json().content, [{ type: 'text', text: 'one' }]);
});

test('captured Claude Code keep-all context edit and omitted display preserve reasoning history', () => {
  const body = request([
    { role: 'user', content: 'continue' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'retain this history', signature: '' }] }
  ], {
    model: 'gpt-6.1-sol', thinking: { type: 'adaptive', display: 'omitted' },
    context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
    output_config: { effort: 'low' }
  });
  const before = structuredClone(body);
  const projected = messagesToResponses(body);
  assert.deepEqual(body, before);
  assert.deepEqual(projected.reasoning, { effort: 'low' });
  assert.deepEqual(projected.input[1], { type: 'reasoning', summary: [{ type: 'summary_text', text: 'retain this history' }] });
  assert.equal(Object.hasOwn(projected, 'context_management'), false);
  assert.equal(Object.hasOwn(projected, 'thinking'), false);
  const r = renderer(false);
  r.handle(complete([{ type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'new history' }] }]));
  r.finish();
  assert.deepEqual(r.json().content, [{ type: 'thinking', thinking: 'new history', signature: '' }]);
});

for (const context_management of [
  { edits: [{ type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: 1 } }] },
  { edits: [{ type: 'clear_tool_uses_20250919', keep: 'all' }] },
  { edits: [{ type: 'clear_thinking_20251015', keep: 'all', trigger: {} }] },
  { edits: [], unknown_policy: true }
]) test(`rejects non-no-op context policy ${JSON.stringify(context_management)}`, () => {
  errorCode(() => messagesToResponses(request([{ role: 'user', content: 'hello' }], { context_management })));
});

test('gpt-6.1-sol explicitly selects summary history without globally changing vendor defaults', () => {
  const body = request([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'history', signature: '' }] }]);
  const summary = messagesToResponses(body, { model: 'gpt-6.1-sol', reasoningShape: 'summary' });
  assert.deepEqual(summary.input, [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'history' }] }]);
  const content = messagesToResponses(body, { model: 'deepseek-test', reasoningShape: 'content' });
  assert.deepEqual(content.input, [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'history' }] }]);
  const originalDefault = require('../lib/vendor/wire-responses').anthropicToResponses(body, { model: 'deepseek-test' });
  assert.deepEqual(originalDefault.input, content.input);
});

test('Claude Code ordinary ToolSearch results load fully declared deferred Read tools', () => {
  const body = request([
    { role: 'user', content: 'find Read' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'search_call', name: 'ToolSearch', input: { query: 'Read' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'search_call', content: [{ type: 'tool_reference', tool_name: 'Read' }] }] }
  ], { tools: [
    { name: 'ToolSearch', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'Read', defer_loading: true, input_schema: { type: 'object', properties: { file_path: { type: 'string' }, pages: { type: 'string' } }, required: ['file_path'] } }
  ] });
  const projected = messagesToResponses(body);
  assert.equal(projected.input[2].output, 'Read');
  assert.equal(projected.tools[1].name, 'Read');
  assert.equal(projected.tools[1].strict, false);
  assert.deepEqual(projected.tools[1].parameters.required, ['file_path']);
  const r = renderer(false, { tools: body.tools });
  r.handle(complete([tool('fc', 'read_call', 'Read', '{"file_path":"/tmp/file","pages":""}')]));
  r.finish();
  assert.deepEqual(r.json().content, [{ type: 'tool_use', id: 'read_call', name: 'Read', input: { file_path: '/tmp/file' } }]);
});

test('tool input pruning preserves required empty strings, false and zero', () => {
  const tools = [{ name: 'Edit', input_schema: { type: 'object', required: ['new_string'] } }];
  const r = renderer(false, { tools });
  r.handle(complete([tool('fc', 'edit_call', 'Edit', '{"new_string":"","optional":"","replace_all":false,"offset":0}')]));
  r.finish();
  assert.deepEqual(r.json().content[0].input, { new_string: '', replace_all: false, offset: 0 });
});

for (const phase of ['final_answer', 'commentary']) test(`recognized Responses message phase ${phase} retains text without mutating source`, () => {
  const value = complete([{ ...outputText('answer'), phase }]);
  const before = structuredClone(value);
  const r = renderer(false);
  r.handle(value);
  r.finish();
  assert.deepEqual(value, before);
  assert.deepEqual(r.json().content, [{ type: 'text', text: 'answer' }]);
});

test('unknown Responses message phase is invalid_request_error before any content', () => {
  const r = renderer();
  r.handle(complete([{ ...outputText('answer'), phase: 'unknown_phase' }]));
  r.finish();
  assert.equal(r.events().length, 1);
  assert.equal(r.events()[0].type, 'error');
  assert.equal(r.events()[0].error.type, 'invalid_request_error');
  assert.equal(r.events()[0].error.code, 'unsupported_messages_content');
});

test('terminal output_text fallback is retained', () => {
  const r = renderer(false);
  r.handle(complete([], { output_text: 'fallback' }));
  r.finish();
  assert.deepEqual(r.json().content, [{ type: 'text', text: 'fallback' }]);
});

test('undeclared tool_reference cannot be silently converted into unloaded tools', () => {
  errorCode(() => messagesToResponses(request([
    { role: 'assistant', content: [{ type: 'tool_use', id: 's', name: 'ToolSearch', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's', content: [{ type: 'tool_reference', tool_name: 'Missing' }] }] }
  ])));
});

for (const stream of [true, false]) test(`opaque reasoning followed by text/tools succeeds without ciphertext exposure (stream=${stream})`, () => {
  const opaque = { type: 'reasoning', id: 'r', summary: [], encrypted_content: 'CIPHERTEXT_NOT_A_SIGNATURE' };
  const terminal = complete([opaque, outputText('answer'), tool('fc', 'call_native', 'Read', '{"file_path":"/tmp/file"}')]);
  const before = structuredClone(terminal);
  const r = renderer(stream);
  r.handle(event('response.output_item.added', { output_index: 0, item: opaque }));
  r.handle(terminal);
  r.finish();
  assert.deepEqual(terminal, before);
  if (stream) {
    assertProtocol(r.events());
    assert.equal(JSON.stringify(r.events()).includes('CIPHERTEXT_NOT_A_SIGNATURE'), false);
    assert.equal(r.events().some(value => value.content_block && value.content_block.type === 'thinking'), false);
    assert.equal(r.events().find(value => value.type === 'message_delta').delta.stop_reason, 'tool_use');
  } else {
    assert.deepEqual(r.json().content, [{ type: 'text', text: 'answer' }, { type: 'tool_use', id: 'call_native', name: 'Read', input: { file_path: '/tmp/file' } }]);
    assert.equal(JSON.stringify(r.json()).includes('CIPHERTEXT_NOT_A_SIGNATURE'), false);
  }
});

for (const stream of [true, false]) test(`opaque-only completed response follows omit mode without an empty-output error (stream=${stream})`, () => {
  const r = renderer(stream);
  r.handle(complete([{ type: 'reasoning', id: 'r', summary: [], encrypted_content: 'CIPHERTEXT_NOT_A_SIGNATURE' }]));
  r.finish();
  if (stream) {
    assertProtocol(r.events());
    assert.equal(r.events().some(value => value.type === 'error'), false);
    assert.equal(JSON.stringify(r.events()).includes('CIPHERTEXT_NOT_A_SIGNATURE'), false);
  } else {
    assert.deepEqual(r.json().content, []);
    assert.equal(r.json().stop_reason, 'end_turn');
    assert.equal(JSON.stringify(r.json()).includes('CIPHERTEXT_NOT_A_SIGNATURE'), false);
  }
  assert.equal(r.ends(), 1);
});

for (const stream of [true, false]) test(`valid empty completion finishes normally (stream=${stream})`, () => {
  const r = renderer(stream);
  r.handle(complete());
  r.finish();
  if (stream) {
    assertProtocol(r.events());
    assert.equal(r.events().some(value => value.type === 'error'), false);
  } else {
    assert.deepEqual(r.json().content, []);
    assert.equal(r.json().stop_reason, 'end_turn');
  }
  assert.equal(r.ends(), 1);
});

test('strict opaque reasoning option rejects even when visible text accompanies it', () => {
  const r = renderer(false, { opaqueReasoning: 'error' });
  r.handle(complete([{ type: 'reasoning', id: 'r', summary: [], encrypted_content: 'opaque' }, outputText('answer')]));
  r.finish();
  assert.equal(r.json().error.code, 'unsupported_messages_content');
});

for (const stream of [true, false]) test(`rate_limit_exceeded maps to Messages rate_limit_error (stream=${stream})`, () => {
  const r = renderer(stream);
  r.handle(event('error', { code: 'rate_limit_exceeded', message: 'upstream limit' }));
  r.finish();
  const error = stream ? r.events().at(-1).error : r.json().error;
  assert.deepEqual(error, { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'upstream limit' });
  if (stream) {
    assertProtocol(r.events(), false);
    assert.equal(r.events().length, 1);
    assert.equal(r.events()[0].type, 'error');
  }
});

test('long Claude metadata user identity is hashed stably without modifying the request', () => {
  const body = request([{ role: 'user', content: 'hello' }], { metadata: { user_id: 'client_identity_'.repeat(10) } });
  const before = structuredClone(body);
  const first = messagesToResponses(body);
  const second = messagesToResponses(body);
  assert.deepEqual(body, before);
  assert.match(first.user, /^[0-9a-f]{64}$/);
  assert.equal(first.user, second.user);
  assert.equal(first.user, require('node:crypto').createHash('sha256').update(body.metadata.user_id, 'utf8').digest('hex'));
  assert.equal(first.user.includes('client_identity'), false);
  const other = messagesToResponses({ ...body, metadata: { user_id: body.metadata.user_id + 'x' } });
  assert.notEqual(other.user, first.user);
});

for (const user of ['', 'short-client-id', 'x'.repeat(64)]) test(`metadata user identity length ${user.length} is preserved exactly`, () => {
  const body = request([{ role: 'user', content: 'hello' }], { metadata: { user_id: user } });
  const before = structuredClone(body);
  assert.equal(messagesToResponses(body).user, user);
  assert.deepEqual(body, before);
});

test('conflicting done snapshots fail rather than replacing streamed content', () => {
  const r = renderer();
  r.handle(event('response.output_text.delta', { item_id: 'm', output_index: 0, delta: 'a' }));
  r.handle(event('response.output_text.done', { item_id: 'm', output_index: 0, text: 'b' }));
  r.finish();
  assertProtocol(r.events(), false);
});
