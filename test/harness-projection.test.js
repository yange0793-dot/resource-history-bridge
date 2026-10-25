'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectResponsesHistory } = require('..');

function history() {
  return { model: 'gpt-6.1-sol', input: [
    { role: 'developer', content: 'Use tools.' },
    { role: 'user', content: [{ type: 'input_text', text: 'Calculate.' }] },
    { type: 'message', id: 'msg_mock', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'Calculating.', annotations: [] }] },
    { type: 'reasoning', id: 'rs_mock', encrypted_content: 'MOCK_OPAQUE', summary: [] },
    { type: 'additional_tools', role: 'developer', tools: [{ type: 'custom', name: 'add', format: { type: 'text' } }] },
    { type: 'custom_tool_call', call_id: 'call_mock', name: 'add', input: '19+23' },
    { type: 'custom_tool_call_output', call_id: 'call_mock', output: '42' }
  ] };
}

function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

test('Harness projection accepts optional custom/additional IDs without inventing them', () => {
  const original = freeze(history());
  const before = JSON.stringify(original);
  const result = projectResponsesHistory(original, { mode: 'harness' });
  assert.equal(result.ok, true);
  assert.equal(result.removed, 2);
  const expected = structuredClone(original);
  delete expected.input[2].id;
  delete expected.input[3].id;
  assert.deepEqual(result.body, expected);
  assert.equal(JSON.stringify(original), before);
});

test('Harness projection preserves existing custom/additional and nested IDs', () => {
  const body = history();
  for (const index of [4, 5, 6]) body.input[index].id = `keep_${index}`;
  body.input[2].content[0].metadata = { id: 'nested_keep' };
  const result = projectResponsesHistory(body, { mode: 'harness' });
  assert.equal(result.ok, true);
  for (const index of [4, 5, 6]) assert.deepEqual(result.body.input[index], body.input[index]);
  assert.equal(result.body.input[2].content[0].metadata.id, 'nested_keep');
});

for (const [name, modify, code] of [
  ['invalid assistant status', b => { b.input[2].status = 'in_progress'; }, 'invalid_history_item'],
  ['null assistant phase', b => { b.input[2].phase = null; }, 'invalid_history_item'],
  ['missing assistant content', b => { delete b.input[2].content; }, 'invalid_history_item'],
  ['easy message unknown role', b => { b.input[0].role = 'assistant'; }, 'invalid_history_item'],
  ['easy instruction missing content', b => { delete b.input[0].content; }, 'invalid_history_item'],
  ['easy user string content', b => { b.input[1].content = 'not an emitted shape'; }, 'invalid_history_item'],
  ['easy message ID', b => { b.input[0].id = 'unknown'; }, 'unsupported_item_id'],
  ['custom ID null', b => { b.input[5].id = null; }, 'invalid_tool_pair'],
  ['custom output ID empty', b => { b.input[6].id = ''; }, 'invalid_tool_pair'],
  ['additional ID null', b => { b.input[4].id = null; }, 'invalid_history_item'],
  ['additional schema missing', b => { delete b.input[4].tools; }, 'invalid_history_item'],
  ['additional wrong role', b => { b.input[4].role = 'user'; }, 'invalid_history_item'],
  ['custom call unknown status', b => { b.input[5].status = 'incomplete'; }, 'invalid_tool_pair'],
  ['custom missing call_id', b => { delete b.input[5].call_id; }, 'invalid_tool_pair'],
  ['custom missing result', b => { b.input.pop(); }, 'invalid_tool_pair'],
  ['custom result before call', b => { [b.input[5], b.input[6]] = [b.input[6], b.input[5]]; }, 'invalid_tool_pair'],
  ['unknown top-level ID', b => { b.input.push({ type: 'future_item', id: 'unknown' }); }, 'unsupported_item_id'],
  ['server reference', b => { b.previous_response_id = 'resp_mock'; }, 'server_history_reference'],
  ['item reference', b => { b.input.push({ type: 'item_reference', id: 'item_mock' }); }, 'item_reference']
]) {
  test(`Harness projection refuses ${name} without mutating history`, () => {
    const body = history(); modify(body); freeze(body);
    const before = JSON.stringify(body);
    const result = projectResponsesHistory(body, { mode: 'harness' });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(JSON.stringify(body), before);
  });
}
