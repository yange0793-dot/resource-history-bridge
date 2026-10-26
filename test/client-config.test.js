'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CLIENT_PRESETS, resolveClientConfig } = require('../lib/client-config');

test('client presets select only history and protocol without reading ambient env', () => {
  assert.deepEqual(resolveClientConfig(), { client: 'generic', historyMode: 'minimal', upstreamProtocol: 'passthrough' });
  for (const [client, preset] of Object.entries(CLIENT_PRESETS)) {
    assert.deepEqual(resolveClientConfig({ RHB_CLIENT: client }), { client, ...preset });
    assert.deepEqual(Object.keys(preset), ['historyMode', 'upstreamProtocol']);
    assert.equal(Object.isFrozen(preset), true);
  }
  assert.equal(Object.isFrozen(CLIENT_PRESETS), true);
});

test('explicit legacy history and protocol override each client preset independently', () => {
  for (const client of Object.keys(CLIENT_PRESETS)) {
    assert.deepEqual(resolveClientConfig({ RHB_CLIENT: client, RHB_HISTORY_MODE: 'harness', RHB_UPSTREAM_PROTOCOL: 'responses' }), {
      client, historyMode: 'harness', upstreamProtocol: 'responses'
    });
    assert.equal(resolveClientConfig({ RHB_CLIENT: client, RHB_HISTORY_MODE: 'minimal' }).upstreamProtocol, CLIENT_PRESETS[client].upstreamProtocol);
    assert.equal(resolveClientConfig({ RHB_CLIENT: client, RHB_UPSTREAM_PROTOCOL: 'passthrough' }).historyMode, CLIENT_PRESETS[client].historyMode);
  }
});

test('client config rejects invalid, empty and inherited-looking client names', () => {
  for (const client of ['', ' ', 'Codex', 'unknown', '__proto__', 'constructor', 'toString']) {
    assert.throws(() => resolveClientConfig({ RHB_CLIENT: client }), { name: 'TypeError', message: 'Invalid client.' });
  }
  for (const value of ['', ' ', 'unknown']) {
    assert.throws(() => resolveClientConfig({ RHB_HISTORY_MODE: value }), { name: 'TypeError', message: 'Invalid history mode.' });
    assert.throws(() => resolveClientConfig({ RHB_UPSTREAM_PROTOCOL: value }), { name: 'TypeError', message: 'Invalid upstream protocol.' });
  }
});
