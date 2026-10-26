'use strict';

const DEFAULT_UPSTREAM = 'https://agentrouter.org/v1';
const AGENTROUTER_HOSTS = new Set(['agentrouter.org', 'ps.air-outer.com']);

function validateAgentRouterUpstream(value = DEFAULT_UPSTREAM) {
  if (!(typeof value === 'string' || value instanceof URL)) throw new TypeError('Invalid upstream.');
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError('Upstream must not contain credentials, query or fragment.');
  }
  if (!url.hostname || !['http:', 'https:'].includes(url.protocol)) throw new TypeError('Use a fixed HTTP(S) upstream.');
  return url;
}

function isAgentRouterUpstream(value) {
  if (!(typeof value === 'string' || value instanceof URL)) return false;
  try {
    const url = validateAgentRouterUpstream(value);
    return url.protocol === 'https:' && AGENTROUTER_HOSTS.has(url.hostname);
  } catch { return false; }
}

module.exports = { DEFAULT_UPSTREAM, validateAgentRouterUpstream, isAgentRouterUpstream };
