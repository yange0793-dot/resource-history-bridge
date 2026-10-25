'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectResponseJson, createOutputInspector, parseSseFrame } = require('../lib/output');

const empty = { terminal: true, empty: true, hasOutput: false, unknown: false, error: false };
function response(output = [], status = 'completed') { return { status, output }; }
function message(content = [], stop_reason = 'end_turn') { return { type: 'message', role: 'assistant', content, stop_reason }; }
function chat(content = '', finish_reason = 'stop') { return { object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason }] }; }
function complete(inspector, output = []) { return inspector.observe({ type: 'response.completed', response: response(output) }); }
function startMessages(inspector, content = []) { return inspector.observe({ type: 'message_start', message: message(content, null) }); }
function stopMessages(inspector, stop_reason = 'end_turn') {
  inspector.observe({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 0 } });
  return inspector.observe({ type: 'message_stop' });
}

for (const [protocol, body] of [['responses', response()], ['messages', message()], ['chat', chat()]]) {
  test(`${protocol} JSON proves empty only from normal terminal and empty output`, () => {
    const before = JSON.stringify(body);
    assert.deepEqual(inspectResponseJson(protocol, body), empty);
    assert.equal(JSON.stringify(body), before);
  });
}

test('known message phase metadata is compatible while unknown phase blocks empty replay', () => {
  const body = response([{ type: 'message', role: 'assistant', phase: 'final_answer', content: [] }]);
  assert.equal(inspectResponseJson('responses', body).empty, true);
  body.output[0].phase = 'unknown';
  assert.equal(inspectResponseJson('responses', body).empty, false);
  assert.equal(inspectResponseJson('responses', body).unknown, true);
});

test('JSON status, usage and incomplete bodies are not empty evidence', () => {
  for (const [protocol, body] of [
    ['responses', { output: [], usage: { output_tokens: 0 } }],
    ['messages', { content: [], usage: { output_tokens: 0 } }],
    ['chat', { choices: [], usage: { completion_tokens: 0 } }],
    ['chat', { choices: [{ index: 0, message: {}, finish_reason: 'stop' }] }],
    ['responses', response([], 'incomplete')],
    ['messages', message([], 'max_tokens')],
    ['chat', chat('', 'length')],
    ['chat', chat('', 'content_filter')],
    ['unknown', response()],
    ['responses', null],
    ['responses', 'HTTP 200'],
    ['responses', { status: 'completed' }],
    ['responses', response(null)],
    ['messages', { ...message(), content: 'wrong' }]
  ]) assert.equal(inspectResponseJson(protocol, body).empty, false, `${protocol}: ${JSON.stringify(body)}`);
});

test('failed, error, cancelled and incomplete terminal events are never empty success', () => {
  for (const status of ['failed', 'cancelled', 'incomplete']) {
    const value = inspectResponseJson('responses', response([], status));
    assert.equal(value.terminal, true);
    assert.equal(value.empty, false);
    assert.equal(value.error, status !== 'incomplete');
  }
  for (const protocol of ['responses', 'messages', 'chat']) {
    const inspector = createOutputInspector(protocol);
    const value = inspector.observe(protocol === 'chat' ? { error: { message: 'rate limited' } } : { type: 'error', error: { message: 'rate limited' } });
    assert.equal(value.error, true);
    assert.equal(value.hold, false);
    assert.equal(value.empty, false);
  }
});

test('Responses lifecycle and empty text block frames can be held but EOF is not a terminal', () => {
  const inspector = createOutputInspector('responses');
  for (const event of [
    { type: 'response.created', response: { id: 'r', output: [], status: 'in_progress' } },
    { type: 'response.queued', response: { output: [] } },
    { type: 'response.in_progress', response: { output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', content: [] } },
    { type: 'response.content_part.added', part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', delta: ' \n\t ' },
    { type: 'response.output_text.done', text: '' }
  ]) assert.equal(inspector.observe(event).hold, true);
  assert.deepEqual(inspector.result(), { terminal: false, empty: false, hasOutput: false, unknown: false, error: false });
  assert.equal(complete(inspector).empty, true);
});

test('whitespace values in known fields differ from unknown fields, even blank unknown fields', () => {
  assert.equal(inspectResponseJson('responses', { ...response(), output_text: ' \n ' }).empty, true);
  for (const body of [
    { ...response(), surprise: '' },
    response([{ type: 'message', content: [{ type: 'output_text', text: '', extra: '' }] }]),
    { ...message(), surprise: null },
    { ...chat(), mystery: 0 },
    response([{ type: 'unrecognized', text: '' }])
  ]) {
    const protocol = body.content ? 'messages' : body.choices ? 'chat' : 'responses';
    const value = inspectResponseJson(protocol, body);
    assert.equal(value.unknown, true);
    assert.equal(value.empty, false);
  }
  const inspector = createOutputInspector('responses');
  assert.equal(inspector.observe({ type: 'new.event', delta: '' }).unknown, true);
  assert.equal(complete(inspector).empty, false);
});

for (const [name, output] of [
  ['text', [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }]],
  ['reasoning', [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought' }] }]],
  ['function name', [{ type: 'function_call', name: 'lookup', arguments: '' }]],
  ['function call ID', [{ type: 'function_call', call_id: 'call-1', arguments: '' }]],
  ['function arguments', [{ type: 'function_call', arguments: '{"q":1}' }]],
  ['refusal', [{ type: 'message', content: [{ type: 'refusal', refusal: '' }] }]],
  ['image', [{ type: 'message', content: [{ type: 'output_image', image_url: 'mock' }] }]],
  ['audio', [{ type: 'message', content: [{ type: 'output_audio', data: 'mock' }] }]],
  ['builtin tool', [{ type: 'web_search_call', id: 'tool-1', action: { type: 'search', query: 'q' } }]]
]) {
  test(`Responses terminal-only ${name} is output and must not be retried`, () => {
    const value = complete(createOutputInspector('responses'), output);
    assert.equal(value.hasOutput, true);
    assert.equal(value.hold, false);
    assert.equal(value.empty, false);
    assert.equal(inspectResponseJson('responses', response(output)).hasOutput, true);
  });
}

test('once content is observed later blank terminal output cannot erase it', () => {
  const inspector = createOutputInspector('responses');
  assert.equal(inspector.observe({ type: 'response.output_text.delta', delta: 'answer' }).hasOutput, true);
  assert.equal(inspector.observe({ type: 'response.output_text.delta', delta: '' }).hold, false);
  assert.equal(complete(inspector).empty, false);
  assert.equal(inspector.result().hasOutput, true);
});

test('opaque reasoning and incomplete tool items commit without treating them as printable output', () => {
  for (const item of [
    { type: 'reasoning', summary: [], encrypted_content: 'opaque' },
    { type: 'reasoning', summary: [], encrypted_content: '' },
    { type: 'reasoning', summary: [], future_metadata: 'opaque' },
    { type: 'function_call', id: 'item', arguments: '' }
  ]) {
    const inspector = createOutputInspector('responses');
    const value = inspector.observe({ type: 'response.output_item.added', item });
    assert.equal(value.unknown, true);
    assert.equal(value.hasOutput, false);
    assert.equal(value.hold, false);
    assert.equal(complete(inspector).empty, false);
  }
});

test('Responses argument and refusal deltas cannot be mistaken for an empty stream', () => {
  for (const event of [
    { type: 'response.function_call_arguments.delta', delta: '{}' },
    { type: 'response.function_call_arguments.done', arguments: '{}', name: 'f' },
    { type: 'response.refusal.delta', delta: '' },
    { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
    { type: 'response.audio.delta', delta: 'opaque' }
  ]) {
    const inspector = createOutputInspector('responses');
    assert.equal(inspector.observe(event).hasOutput, true);
    assert.equal(complete(inspector).empty, false);
  }
  const inspector = createOutputInspector('responses');
  assert.equal(inspector.observe({ type: 'response.function_call_arguments.delta', delta: '' }).unknown, true);
});

test('Messages empty lifecycle, text and thinking blocks need a normal message_stop', () => {
  const inspector = createOutputInspector('messages');
  assert.equal(startMessages(inspector).hold, true);
  for (const event of [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' \t' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: '\n' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'ping' }
  ]) assert.equal(inspector.observe(event).hold, true);
  assert.equal(inspector.result().empty, false);
  assert.equal(inspector.result().terminal, false);
  assert.equal(stopMessages(inspector).empty, true);
});

for (const [name, content] of [
  ['text', [{ type: 'text', text: 'answer' }]],
  ['thinking', [{ type: 'thinking', thinking: 'thought', signature: '' }]],
  ['tool', [{ type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} }]],
  ['image', [{ type: 'image', source: { type: 'base64', data: 'mock' } }]],
  ['refusal', [{ type: 'refusal', refusal: '' }]]
]) {
  test(`Messages complete message_start ${name} is not missed`, () => {
    const inspector = createOutputInspector('messages');
    assert.equal(startMessages(inspector, content).hasOutput, true);
    assert.equal(stopMessages(inspector).empty, false);
    assert.equal(inspectResponseJson('messages', message(content)).hasOutput, true);
  });
}

test('Messages signature and redacted thinking are opaque, not empty text', () => {
  for (const content of [
    [{ type: 'thinking', thinking: '', signature: 'signature' }],
    [{ type: 'redacted_thinking', data: 'opaque' }]
  ]) {
    const value = inspectResponseJson('messages', message(content));
    assert.equal(value.unknown, true);
    assert.equal(value.hasOutput, false);
    assert.equal(value.empty, false);
  }
  const inspector = createOutputInspector('messages');
  startMessages(inspector);
  inspector.observe({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  assert.equal(inspector.observe({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque' } }).unknown, true);
  assert.equal(stopMessages(inspector).empty, false);
});

test('Messages missing start, unknown delta, abnormal stop and refusal are not empty', () => {
  assert.equal(createOutputInspector('messages').observe({ type: 'message_stop' }).empty, false);
  for (const reason of ['max_tokens', 'pause_turn', 'model_context_window_exceeded', 'unknown', 'tool_use', 'refusal']) {
    const inspector = createOutputInspector('messages');
    startMessages(inspector);
    const value = stopMessages(inspector, reason);
    assert.equal(value.empty, false);
    if (reason === 'refusal') assert.equal(value.hasOutput, true);
  }
  const inspector = createOutputInspector('messages');
  startMessages(inspector);
  assert.equal(inspector.observe({ type: 'content_block_delta', index: 0, delta: { type: 'future_delta', content: '' } }).unknown, true);
  assert.equal(stopMessages(inspector).empty, false);
});

test('Chat blank deltas, usage-only and DONE prove empty only after an actual choice', () => {
  const inspector = createOutputInspector('chat');
  assert.equal(inspector.observe({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }).hold, true);
  assert.equal(inspector.observe({ object: 'chat.completion.chunk', choices: [], usage: { completion_tokens: 0 } }).hold, true);
  assert.equal(inspector.result().terminal, false);
  assert.equal(inspector.observe({ type: '__done__' }).empty, true);
  const usageOnly = createOutputInspector('chat');
  usageOnly.observe({ choices: [], usage: { completion_tokens: 0 } });
  assert.equal(usageOnly.observe({ type: '__done__' }).empty, false);
  assert.equal(usageOnly.result().unknown, true);
});

test('Chat terminal-only text, thought, tool, refusal and audio are output', () => {
  for (const value of [
    { role: 'assistant', content: 'answer' },
    { content: null, reasoning_content: 'thought' },
    { content: null, reasoning: 'thought' },
    { content: null, tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'lookup', arguments: '' } }] },
    { content: null, function_call: { name: 'lookup', arguments: '' } },
    { content: null, refusal: '' },
    { content: null, audio: { data: 'opaque' } },
    { content: [{ type: 'image', source: 'mock' }] }
  ]) {
    const body = { choices: [{ index: 0, message: value, finish_reason: 'stop' }] };
    const inspector = createOutputInspector('chat');
    assert.equal(inspector.observe(body).hasOutput, true);
    assert.equal(inspector.observe({ type: '__done__' }).empty, false);
    assert.equal(inspectResponseJson('chat', body).hasOutput, true);
  }
});

test('Chat malformed and partial tool bodies, opaque thought and unknown structures are not empty', () => {
  for (const delta of [
    { tool_calls: [{ index: 0, function: { arguments: '' } }] },
    { reasoning: { encrypted_content: 'opaque' } },
    { unknown_output: '' },
    { content: {} }
  ]) {
    const inspector = createOutputInspector('chat');
    const value = inspector.observe({ choices: [{ index: 0, delta, finish_reason: 'stop' }] });
    assert.equal(value.unknown, true);
    assert.equal(value.empty, false);
    assert.equal(value.hold, false);
  }
});

test('SSE parses LF, CRLF, CR and multiple data lines with strict event typing', () => {
  for (const separator of ['\n', '\r\n', '\r']) {
    assert.deepEqual(parseSseFrame(Buffer.from(`event: message_start${separator}data: {${separator}data: "message": {"content": []}${separator}data: }${separator}${separator}`)), {
      ok: true, event: { type: 'message_start', message: { content: [] } }, comment: false
    });
  }
  assert.deepEqual(parseSseFrame(Buffer.from('data: [DONE]\n\n')), { ok: true, event: { type: '__done__' }, comment: false });
  assert.equal(parseSseFrame(Buffer.from('event: error\ndata: {"type":"message_start"}\n\n')).ok, false);
  assert.equal(parseSseFrame(Buffer.from('event: a\nevent: b\ndata: {}\n\n')).ok, false);
});

test('SSE blank and comment frames remain non-output and unknown fields are not body', () => {
  for (const frame of ['', '\n\n', ': ping\n\n']) assert.deepEqual(parseSseFrame(Buffer.from(frame)), { ok: true, event: null, comment: true });
  assert.deepEqual(parseSseFrame(Buffer.from(': ping\ndata: {"type":"ping"}\n\n')), { ok: true, event: { type: 'ping' }, comment: true });
  for (const field of ['id', 'retry', 'unknown']) {
    const value = parseSseFrame(Buffer.from(`${field}: value\ndata: {"type":"ping"}\n\n`));
    assert.equal(value.ok, true);
    assert.equal(value.unknown, true);
    assert.deepEqual(value.event, { type: 'ping' });
  }
});

test('SSE malformed JSON, UTF-8, primitive payloads and multiple frames are rejected', () => {
  for (const frame of [
    Buffer.from('data: not-json\n\n'),
    Buffer.from('data: null\n\n'),
    Buffer.from('data: []\n\n'),
    Buffer.from('data: "text"\n\n'),
    Buffer.concat([Buffer.from('data: {"text":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n\n')]),
    Buffer.from('data: {}\n\ndata: {}\n\n'),
    'data: {}\n\n'
  ]) assert.deepEqual(parseSseFrame(frame), { ok: false });
});

test('wrong semantic fields, opaque nested reasoning and contradictory lifecycle are unknown', () => {
  for (const body of [
    response([{ type: 'message', role: 'user', content: [] }]),
    response([{ type: 'message', content: [{ type: 'output_text', text: '', thinking: 'hidden' }] }]),
    { ...response(), reasoning: { encrypted_content: 'opaque' } },
    { ...response(), object: 'unknown' },
    response([{ type: 'reasoning' }])
  ]) {
    const value = inspectResponseJson('responses', body);
    assert.equal(value.unknown, true);
    assert.equal(value.empty, false);
  }
  const inspector = createOutputInspector('responses');
  assert.equal(inspector.observe({ type: 'response.created', response: response() }).unknown, true);
  assert.equal(complete(inspector).empty, false);
  const delta = createOutputInspector('responses');
  assert.equal(delta.observe({ type: 'response.output_text.delta', delta: '', text: 'hidden' }).unknown, true);
});

test('multi-choice chat does not finish when only one choice is done', () => {
  const inspector = createOutputInspector('chat');
  const value = inspector.observe({ choices: [
    { index: 0, delta: { content: '' }, finish_reason: 'stop' },
    { index: 1, delta: { content: '' }, finish_reason: null }
  ] });
  assert.equal(value.terminal, false);
  assert.equal(value.empty, false);
  assert.equal(inspectResponseJson('chat', { choices: [
    { index: 0, message: { content: '' }, finish_reason: 'stop' },
    { index: 1, message: { content: '' }, finish_reason: null }
  ] }).empty, false);
  assert.equal(inspector.observe({ type: '__done__' }).empty, true);
});

test('Messages incompatible block deltas and abnormal finishes stay unsafe', () => {
  const inspector = createOutputInspector('messages');
  startMessages(inspector);
  inspector.observe({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  assert.equal(inspector.observe({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }).unknown, true);
  assert.equal(stopMessages(inspector).empty, false);
  const truncated = createOutputInspector('messages');
  startMessages(truncated);
  assert.equal(truncated.observe({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }).hold, false);
  assert.equal(stopMessages(truncated).empty, false);
});

test('Responses DONE is optional metadata only after a terminal, never empty proof itself', () => {
  const inspector = createOutputInspector('responses');
  complete(inspector);
  assert.equal(inspector.observe({ type: '__done__' }).empty, true);
  const noTerminal = createOutputInspector('responses');
  assert.equal(noTerminal.observe({ type: '__done__' }).unknown, true);
  assert.equal(noTerminal.result().terminal, false);
  const failed = createOutputInspector('responses');
  failed.observe({ type: 'response.failed', response: response([], 'failed') });
  assert.equal(failed.observe({ type: '__done__' }).empty, false);
});

test('JSON errors are terminal failures and unfinished Messages blocks prevent an empty result', () => {
  assert.deepEqual(inspectResponseJson('responses', { error: { code: 'rate_limit' } }), {
    terminal: true, empty: false, hasOutput: false, unknown: false, error: true
  });
  const inspector = createOutputInspector('messages');
  startMessages(inspector);
  inspector.observe({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  assert.equal(stopMessages(inspector).unknown, true);
  assert.equal(inspector.result().empty, false);
});

test('events after terminal cannot erase previous contradictory or unknown state', () => {
  const inspector = createOutputInspector('responses');
  inspector.observe({ type: 'response.incomplete', response: response([], 'incomplete') });
  assert.equal(complete(inspector).empty, false);
  assert.equal(inspector.result().unknown, true);
  const chatInspector = createOutputInspector('chat');
  chatInspector.observe({ choices: [{ index: 0, delta: {}, finish_reason: null }] });
  chatInspector.observe({ type: '__done__' });
  assert.equal(chatInspector.observe({ choices: [], usage: {} }).unknown, true);
  assert.equal(chatInspector.result().empty, false);
});

test('public inspector API exposes only observe and result', () => {
  assert.deepEqual(Object.keys(createOutputInspector('responses')).sort(), ['observe', 'result']);
});

test('inspection never changes upstream objects', () => {
  for (const protocol of ['responses', 'messages', 'chat']) {
    const event = protocol === 'responses' ? { type: 'response.completed', response: response([{ type: 'function_call', name: 'f', arguments: '' }]) }
      : protocol === 'messages' ? { type: 'message_start', message: message([{ type: 'text', text: 'x' }]) }
        : { choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] };
    const before = JSON.stringify(event);
    Object.freeze(event);
    createOutputInspector(protocol).observe(event);
    assert.equal(JSON.stringify(event), before);
  }
});
