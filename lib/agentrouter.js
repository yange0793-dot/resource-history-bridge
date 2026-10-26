'use strict';

const DEFAULT_UPSTREAM = 'https://agentrouter.org/v1';
const AGENTROUTER_HOSTS = new Set(['agentrouter.org', 'ps.air-outer.com']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function validateAgentRouterUpstream(value = DEFAULT_UPSTREAM) {
  if (!(typeof value === 'string' || value instanceof URL)) throw new TypeError('Invalid AgentRouter upstream.');
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError('Upstream must not contain credentials, query or fragment.');
  }
  const official = AGENTROUTER_HOSTS.has(url.hostname) && url.protocol === 'https:';
  const local = LOOPBACK_HOSTS.has(url.hostname) && ['http:', 'https:'].includes(url.protocol);
  if (!official && !local) throw new TypeError('Use an HTTPS AgentRouter endpoint or a fixed loopback proxy.');
  return url;
}

module.exports = { DEFAULT_UPSTREAM, validateAgentRouterUpstream };
