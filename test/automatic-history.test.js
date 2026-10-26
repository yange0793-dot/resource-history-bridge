'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectResponsesHistory } = require('../lib/history');
const { projectEncryptedReasoning } = require('../lib/encrypted-reasoning');
const { resolveRequestProfile } = require('../lib/request-profile');

const standardTypes = new Set(['message', 'reasoning', 'function_call', 'function_call_output']);

function history() {
  return { model: 'synthetic-model[1M]', stream: true, store: false, include: ['reasoning.encrypted_content'],
    reasoning: { effort: 'high' }, prompt_cache_key: 'CACHE_KEEP', session_id: 'SESSION_KEEP',
    metadata: { id: 'METADATA_KEEP' }, authorization: 'BODY_FIELD_KEEP',
    tools: [{ type: 'function', name: 'add', strict: false, parameters: { type: 'object', properties: { a: { type: 'number' } }, required: [] } }],
    input: [
      { role: 'developer', content: 'Use supplied tools.' },
      { role: 'user', content: [{ type: 'input_text', text: 'Calculate.', metadata: { id: 'NESTED_KEEP' } }] },
      { type: 'message', id: 'MESSAGE_REMOVE', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'Calculating.', annotations: [], logprobs: null }] },
      { type: 'reasoning', id: 'OPAQUE_REMOVE', summary: [], content: null, encrypted_content: 'CIPHER_KEEP_A+/=\u0000é', status: 'completed' },
      { type: 'reasoning', id: 'SUMMARY_REMOVE', summary: [{ type: 'summary_text', text: 'Readable summary.' }], content: [{ type: 'reasoning_text', text: 'Readable content.' }], encrypted_content: 'CIPHER_KEEP_B' },
      { type: 'function_call', id: 'CALL_REMOVE', call_id: 'PAIR_KEEP', name: 'add', arguments: '{"a":42}', status: 'completed' },
      { type: 'function_call_output', id: 'OUTPUT_REMOVE', call_id: 'PAIR_KEEP', output: [
        { type: 'input_text', text: '42', metadata: { id: 'RESULT_NESTED_KEEP' } },
        { type: 'input_image', image_url: 'https://images.example.invalid/result.png', detail: 'original', metadata: { id: 'IMAGE_NESTED_KEEP' } }
      ], status: 'completed' },
      { type: 'additional_tools', id: 'ADDITIONAL_KEEP', role: 'developer', tools: [{ type: 'namespace', name: 'execution', description: 'Execution tools.', tools: [
        { type: 'custom', name: 'exec', description: 'Execute text.', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/', metadata: { id: 'GRAMMAR_NESTED_KEEP' } } },
        { type: 'function', name: 'wait', strict: false, parameters: { type: 'object', properties: { duration: { type: 'number' } }, required: [] } }
      ] }] },
      { type: 'custom_tool_call', id: 'CUSTOM_CALL_KEEP', call_id: 'CUSTOM_PAIR_KEEP', name: 'exec', input: 'print(42)\n', status: 'completed' },
      { type: 'custom_tool_call_output', id: 'CUSTOM_OUTPUT_KEEP', call_id: 'CUSTOM_PAIR_KEEP', output: { stdout: '42', id: 'CUSTOM_PAYLOAD_KEEP' }, status: 'completed' }
    ] };
}

function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

function idProjection(body) {
  const copy = structuredClone(body);
  for (const item of copy.input) if (standardTypes.has(item.type)) delete item.id;
  return copy;
}

function cipherProjection(body) {
  const copy = structuredClone(body);
  copy.input = copy.input.filter(item => {
    if (item.type !== 'reasoning' || !Object.hasOwn(item, 'encrypted_content')) return true;
    delete item.encrypted_content;
    delete item.id;
    return ['summary', 'content'].some(key => Array.isArray(item[key]) && item[key].some(part => part.text.trim().length > 0));
  });
  return copy;
}

function assertRefused(body, projector) {
  freeze(body);
  const before = JSON.stringify(body);
  const result = projector(body, { mode: 'auto' });
  assert.equal(result.ok, false);
  assert.equal(typeof result.code, 'string');
  assert.equal(typeof result.message, 'string');
  assert.equal(JSON.stringify(body), before);
}

test('automatic ID projection removes exactly four standard IDs from immutable mixed history', () => {
  const original = freeze(history());
  const before = JSON.stringify(original);
  const result = projectResponsesHistory(original, { mode: 'auto' });
  assert.equal(result.ok, true);
  assert.equal(result.removed, 5);
  assert.deepEqual(result.body, idProjection(original));
  assert.equal(JSON.stringify(original), before);
  assert.equal(result.body.input[3].encrypted_content, original.input[3].encrypted_content);
  for (const index of [7, 8, 9]) assert.deepEqual(result.body.input[index], original.input[index]);
  result.body.input[6].output[0].text = 'Changed';
  result.body.metadata.id = 'Changed';
  assert.equal(original.input[6].output[0].text, '42');
  assert.equal(original.metadata.id, 'METADATA_KEEP');
});

test('automatic ciphertext projection drops only cipher and its reasoning ID or opaque-only item', () => {
  const original = freeze(history());
  const before = JSON.stringify(original);
  const result = projectEncryptedReasoning(original, { mode: 'auto' });
  assert.equal(result.ok, true);
  assert.equal(result.lossy, true);
  assert.equal(result.removedEncrypted, 2);
  assert.equal(result.droppedReasoning, 1);
  assert.equal(result.removedIds, 2);
  assert.deepEqual(result.body, cipherProjection(original));
  assert.equal(JSON.stringify(original), before);
  assert.equal(result.body.input[2].id, 'MESSAGE_REMOVE');
  assert.equal(result.body.input[4].id, 'CALL_REMOVE');
  assert.equal(result.body.input[5].id, 'OUTPUT_REMOVE');
  assert.deepEqual(result.body.input.slice(-3), original.input.slice(-3));
});

for (const role of ['user', 'developer', 'system']) {
  for (const content of ['Inline string.', [{ type: 'input_text', text: 'Inline array.' }], [{ type: 'input_image', image_url: 'data:image/png;base64,U1lOVEhFVElD' }]]) {
    test(`automatic history accepts easy ${role} ${typeof content === 'string' ? 'string' : content[0].type}`, () => {
      const body = history();
      body.input[0] = { role, content };
      assert.equal(projectResponsesHistory(freeze(body), { mode: 'auto' }).ok, true);
      assert.equal(projectEncryptedReasoning(body, { mode: 'auto' }).ok, true);
    });
  }
}

for (const role of ['user', 'developer', 'system', 'assistant']) {
  test(`automatic history accepts complete typed ${role} messages and absent status`, () => {
    const body = history();
    body.input[2].role = role;
    delete body.input[2].status;
    delete body.input[2].phase;
    assert.equal(projectResponsesHistory(freeze(body), { mode: 'auto' }).ok, true);
    assert.equal(projectEncryptedReasoning(body, { mode: 'auto' }).ok, true);
  });
}

for (const index of [7, 8, 9]) test(`automatic history keeps optional retained IDs absent at item ${index}`, () => {
  const body = history();
  delete body.input[index].id;
  for (const project of [projectResponsesHistory, projectEncryptedReasoning]) {
    const result = project(freeze(body), { mode: 'auto' });
    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(result.body.input.find(item => item.type === body.input[index].type), 'id'), false);
  }
});

for (const output of ['', '42', null, { stdout: '42', future_payload: { file_id: 'OPAQUE_NOT_A_REFERENCE' } }, ['opaque']]) {
  test(`automatic custom output payload stays opaque for ${JSON.stringify(output)}`, () => {
    const body = history();
    body.input[9].output = output;
    assert.deepEqual(projectResponsesHistory(freeze(body), { mode: 'auto' }).body, idProjection(body));
    assert.deepEqual(projectEncryptedReasoning(body, { mode: 'auto' }).body, cipherProjection(body));
  });
}

test('automatic schema validation preserves arbitrary JSON Schema and false/null strict values', () => {
  for (const strict of [false, true, null]) {
    const body = history();
    body.input[7].tools[0].tools[1].strict = strict;
    body.input[7].tools[0].tools[1].parameters = { type: 'object', properties: { arbitrary: { unknown_keyword: { id: 'SCHEMA_KEEP' } } }, custom_keyword: true };
    assert.deepEqual(projectResponsesHistory(freeze(body), { mode: 'auto' }).body, idProjection(body));
    assert.deepEqual(projectEncryptedReasoning(body, { mode: 'auto' }).body, cipherProjection(body));
  }
});

for (const [name, modify] of [
  ['previous_response_id', b => { b.previous_response_id = 'SERVER_REF'; }],
  ['conversation', b => { b.conversation = { id: 'SERVER_REF' }; }],
  ['item_reference', b => { b.input.push({ type: 'item_reference', id: 'SERVER_REF' }); }],
  ['compaction', b => { b.input.push({ type: 'compaction', encrypted_content: 'OPAQUE' }); }],
  ['context_compaction', b => { b.input.push({ type: 'context_compaction', encrypted_content: 'OPAQUE' }); }],
  ['unknown item without ID', b => { b.input.push({ type: 'future_item', payload: 'UNKNOWN' }); }],
  ['unknown item with ID', b => { b.input.push({ type: 'future_item', id: 'UNKNOWN' }); }],
  ['inherited item schema name', b => { b.input.push({ type: 'constructor' }); }],
  ['non-string item type', b => { b.input.push({ type: ['additional_tools'], role: 'developer', tools: [] }); }],
  ['untyped assistant', b => { b.input[0] = { role: 'assistant', content: 'Unknown easy shape.' }; }],
  ['untyped unknown role', b => { b.input[0].role = 'tool'; }],
  ['untyped ID', b => { b.input[0].id = 'UNKNOWN_ID'; }],
  ['untyped missing content', b => { delete b.input[0].content; }],
  ['untyped malformed content', b => { b.input[0].content = ['not a block']; }],
  ['typed raw string content', b => { b.input[2].role = 'user'; b.input[2].content = 'Not typed inline array.'; }],
  ['unknown message phase', b => { b.input[2].phase = 'future_phase'; }],
  ['null message phase', b => { b.input[2].phase = null; }],
  ['missing reasoning summary without ID', b => { delete b.input[3].summary; delete b.input[3].id; }],
  ['null reasoning summary', b => { b.input[3].summary = null; }],
  ['wrong reasoning part', b => { b.input[4].summary[0].type = 'output_text'; }],
  ['unknown reasoning part field', b => { b.input[4].summary[0].future_text = 'UNKNOWN'; }],
  ['unknown reasoning content field', b => { b.input[4].content[0].future_text = 'UNKNOWN'; }],
  ['invalid ciphertext', b => { b.input[3].encrypted_content = ''; }],
  ['missing function arguments without ID', b => { delete b.input[5].arguments; delete b.input[5].id; }],
  ['missing function result', b => { b.input.splice(6, 1); }],
  ['orphan function result', b => { b.input.splice(5, 1); }],
  ['function result before call', b => { [b.input[5], b.input[6]] = [b.input[6], b.input[5]]; }],
  ['duplicate function call', b => { b.input.push(structuredClone(b.input[5])); }],
  ['duplicate function output', b => { b.input.push(structuredClone(b.input[6])); }],
  ['invalid standard output without ID', b => { delete b.input[6].id; b.input[6].output = {}; }],
  ['missing standard output payload', b => { delete b.input[6].output; }],
  ['empty standard output content', b => { b.input[6].output = []; }],
  ['missing custom input', b => { delete b.input[8].input; }],
  ['missing custom output', b => { b.input.pop(); }],
  ['missing custom output payload', b => { delete b.input[9].output; }],
  ['cross-type result', b => { b.input[9].call_id = b.input[5].call_id; }],
  ['duplicate cross-type call_id', b => { b.input[8].call_id = b.input[5].call_id; }],
  ['unknown additional schema field', b => { b.input[7].tools[0].future_tool = true; }],
  ['unknown custom format field', b => { b.input[7].tools[0].tools[0].format.future_format = true; }],
  ['invalid function strict', b => { b.input[7].tools[0].tools[1].strict = 'false'; }],
  ['invalid tool description', b => { b.input[7].tools[0].description = 1; }],
  ['referenced additional schema', b => { b.input[7].tools = ['SERVER_TOOL']; }],
  ['missing additional schema parameters', b => { delete b.input[7].tools[0].tools[1].parameters; }],
  ['invalid additional role', b => { b.input[7].role = 'user'; }],
  ['null item', b => { b.input.push(null); }],
  ['string item', b => { b.input.push('text'); }],
  ['array item', b => { b.input.push([]); }],
  ['input string', b => { b.input = 'not full inline history'; }],
  ['empty input', b => { b.input = []; }]
]) test(`automatic history rejects ${name} for both projections without mutation`, () => {
  for (const project of [projectResponsesHistory, projectEncryptedReasoning]) {
    const body = history();
    modify(body);
    assertRefused(body, project);
  }
});

for (const index of [2, 3, 4, 5, 6, 7, 8, 9]) {
  for (const withId of [false, true]) {
    test(`automatic history rejects unknown item field at ${index} with ID ${withId}`, () => {
      for (const project of [projectResponsesHistory, projectEncryptedReasoning]) {
        const body = history();
        if (!withId) delete body.input[index].id;
        body.input[index].future_content = 'UNKNOWN';
        assertRefused(body, project);
      }
    });
  }
  test(`automatic history rejects invalid optional item ID at ${index}`, () => {
    for (const project of [projectResponsesHistory, projectEncryptedReasoning]) {
      const body = history();
      body.input[index].id = null;
      assertRefused(body, project);
    }
  });
}

for (const index of [2, 3, 4, 5, 6, 8, 9]) {
  for (const status of ['in_progress', 'incomplete', null, 'failed']) {
    test(`automatic history rejects item ${index} status ${status} even without ID`, () => {
      for (const project of [projectResponsesHistory, projectEncryptedReasoning]) {
        const body = history();
        delete body.input[index].id;
        body.input[index].status = status;
        assertRefused(body, project);
      }
    });
  }
}

for (const content of [
  [{ type: 'input_text' }], [{ type: 'output_text', text: 1 }], [{ type: 'input_text', text: '42', future_content: true }],
  [{ type: 'input_text', text: '42', annotations: null }], [{ type: 'input_text', text: '42', logprobs: {} }],
  [{ type: 'input_image', file_id: 'SERVER_IMAGE' }],
  [{ type: 'input_image', image_url: 'https://images.example.invalid/inline.png', file_id: 'SERVER_IMAGE' }],
  [{ type: 'input_image', image_url: 'inline.png' }], [{ type: 'input_image', image_url: 'data:image/png;base64,' }],
  [{ type: 'input_image', image_url: 'https://images.example.invalid/inline.png', detail: 'future' }],
  [{ type: 'input_image', image_url: 'https://images.example.invalid/inline.png', future_content: true }]
]) test(`automatic history rejects malformed or referenced inline content ${JSON.stringify(content)}`, () => {
  for (const project of [projectResponsesHistory, projectEncryptedReasoning]) {
    for (const [index, field] of [[1, 'content'], [2, 'content'], [6, 'output']]) {
      const body = history();
      delete body.input[index].id;
      body.input[index][field] = content;
      assertRefused(body, project);
    }
  }
});

test('automatic ID and ciphertext projections compose without restoring removed fields', () => {
  const body = freeze(history());
  const idFirst = projectResponsesHistory(body, { mode: 'auto' });
  const cipherAfterId = projectEncryptedReasoning(idFirst.body, { mode: 'auto' });
  const cipherFirst = projectEncryptedReasoning(body, { mode: 'auto' });
  const idAfterCipher = projectResponsesHistory(cipherFirst.body, { mode: 'auto' });
  assert.equal(cipherAfterId.ok, true);
  assert.equal(idAfterCipher.ok, true);
  assert.deepEqual(cipherAfterId.body, idAfterCipher.body);
  assert.deepEqual(cipherAfterId.body, cipherProjection(idProjection(body)));
});

test('automatic ciphertext recovery needs usable input after dropping opaque-only reasoning', () => {
  const body = { input: [{ type: 'reasoning', id: 'OPAQUE', summary: [], encrypted_content: 'CIPHER' }] };
  assert.equal(projectEncryptedReasoning(freeze(body), { mode: 'auto' }).code, 'empty_projected_input');
  assert.equal(projectResponsesHistory(body, { mode: 'auto' }).ok, true);
  const noIds = history();
  for (const item of noIds.input) if (standardTypes.has(item.type)) delete item.id;
  assert.equal(projectResponsesHistory(freeze(noIds), { mode: 'auto' }).code, 'no_supported_item_ids');
  assert.equal(projectEncryptedReasoning(noIds, { mode: 'auto' }).ok, true);
  const noCipher = history();
  for (const item of noCipher.input) delete item.encrypted_content;
  assert.equal(projectEncryptedReasoning(freeze(noCipher), { mode: 'auto' }).code, 'no_encrypted_reasoning');
});

test('pure helper no-option defaults retain minimal rather than automatic behavior', () => {
  const body = history();
  assert.deepEqual(projectResponsesHistory(freeze(body)), projectResponsesHistory(body, { mode: 'minimal' }));
  assert.equal(projectResponsesHistory(body).ok, false);
  assert.equal(projectResponsesHistory(body, { mode: 'auto' }).ok, true);
  assert.deepEqual(projectEncryptedReasoning(body), projectEncryptedReasoning(body, { mode: 'minimal' }));
  assert.equal(projectEncryptedReasoning(body).ok, false);
  assert.equal(projectEncryptedReasoning(body, { mode: 'auto' }).ok, true);
});

test('legacy modes retain easy-message and unknown-ID-less item behavior', () => {
  const body = { input: [
    { type: 'reasoning', id: 'REMOVE', summary: [], encrypted_content: 'CIPHER' },
    { type: 'future_item', future_content: 'LEGACY_KEEP' }
  ] };
  for (const mode of ['minimal', 'codex', 'harness']) assert.equal(projectResponsesHistory(freeze(body), { mode }).ok, true);
  assert.equal(projectResponsesHistory(body, { mode: 'auto' }).ok, false);
  const easy = history();
  easy.input[1] = { role: 'user', content: 'Automatic easy string.' };
  assert.equal(projectResponsesHistory(freeze(easy), { mode: 'harness' }).ok, false);
  assert.equal(projectResponsesHistory(easy, { mode: 'auto' }).ok, true);
});

for (const upstream of ['https://agentrouter.org/v1', 'https://ps.air-outer.com/v1', new URL('https://agentrouter.org/v1')]) {
  for (const upstreamProtocol of ['auto', 'responses']) {
    test(`automatic profile converts Messages for ${upstream} with ${upstreamProtocol}`, () => {
      assert.deepEqual(resolveRequestProfile({ endpoint: 'messages', upstream, upstreamProtocol }), { historyMode: 'minimal', convert: true });
      assert.deepEqual(resolveRequestProfile({ endpoint: 'responses', upstream, upstreamProtocol }), { historyMode: 'auto', convert: false });
    });
  }
  for (const historyMode of ['minimal', 'codex', 'harness']) test(`automatic protocol preserves explicit legacy mode ${historyMode} for ${upstream}`, () => {
    assert.deepEqual(resolveRequestProfile({ endpoint: 'messages', upstream, historyMode }), { historyMode, convert: true });
  });
}

for (const upstream of ['http://agentrouter.org/v1', 'http://ps.air-outer.com/v1', 'http://127.0.0.1:1/v1',
  'https://other.example.invalid/v1', 'https://agentrouter.org.evil.example.invalid/v1', 'https://sub.agentrouter.org/v1',
  'https://agentrouter.org./v1', 'https://key@agentrouter.org/v1', 'https://agentrouter.org/v1?provider=agentrouter', undefined]) {
  for (const upstreamProtocol of ['auto', 'responses', 'passthrough']) test(`profile does not infer provider behind ${upstream} for ${upstreamProtocol}`, () => {
    assert.deepEqual(resolveRequestProfile({ endpoint: 'messages', upstream, upstreamProtocol,
      userAgent: 'Claude-Code Harness Codex', headers: { 'x-upstream-provider': 'agentrouter' } }), { historyMode: 'auto', convert: false });
  });
}

for (const endpoint of ['responses', 'compact', 'chat', 'responses/compact', 'chat/completions', undefined, 'future']) {
  for (const upstreamProtocol of ['auto', 'responses']) test(`automatic profile never converts ${endpoint} for ${upstreamProtocol}`, () => {
    assert.deepEqual(resolveRequestProfile({ endpoint, upstream: 'https://agentrouter.org/v1', upstreamProtocol }), { historyMode: 'auto', convert: false });
  });
}

test('passthrough protocol disables Messages conversion on official targets', () => {
  assert.deepEqual(resolveRequestProfile({ endpoint: 'messages', upstream: 'https://agentrouter.org/v1', upstreamProtocol: 'passthrough' }), { historyMode: 'auto', convert: false });
});

test('request profile rejects invalid explicit modes rather than guessing from names', () => {
  for (const historyMode of ['automatic', 'claude-code', '', null, 1]) assert.throws(() => resolveRequestProfile({ historyMode }), TypeError);
  for (const upstreamProtocol of ['messages', '', null, 1]) assert.throws(() => resolveRequestProfile({ upstreamProtocol }), TypeError);
});
