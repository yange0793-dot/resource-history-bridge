'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');

const officialHosts = new Set(['agentrouter.org', 'ps.air-outer.com']);
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const mappings = new Map();
let originalHttp, originalHttps;

// Test-only transport mapping. The configured provider stays an official HTTPS
// target; requests are redirected before DNS and unexpected network is blocked.
function mockAgentRouter(port) {
  assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535);
  const token = Symbol('mock');
  mappings.set(token, port);
  if (mappings.size === 1) {
    originalHttp = http.request;
    originalHttps = https.request;
    http.request = function guardedHttp(target, ...args) {
      const hostname = target instanceof URL || typeof target === 'string' ? new URL(target).hostname : target.hostname || target.host || 'localhost';
      assert.ok(loopbackHosts.has(hostname), 'test HTTP request must stay on loopback');
      return originalHttp.call(this, target, ...args);
    };
    https.request = function mappedHttps(target, options, callback) {
      assert.ok(target instanceof URL, 'bridge must expose its fixed target before DNS');
      assert.equal(target.protocol, 'https:');
      assert.ok(officialHosts.has(target.hostname), 'only official synthetic AgentRouter targets may be mapped');
      const local = new URL(target);
      local.protocol = 'http:';
      local.hostname = '127.0.0.1';
      local.port = String([...mappings.values()].at(-1));
      return originalHttp.call(http, local, { ...options, agent: false }, callback);
    };
  }
  return () => {
    mappings.delete(token);
    if (!mappings.size) { http.request = originalHttp; https.request = originalHttps; }
  };
}

module.exports = { mockAgentRouter };

// CLI/launcher fixtures load this helper with --require, never production code.
if (process.env.RHB_TEST_MOCK_PORT !== undefined) mockAgentRouter(Number(process.env.RHB_TEST_MOCK_PORT));
