'use strict';

const { isAgentRouterUpstream } = require('./agentrouter');

function resolveRequestProfile({ endpoint, upstream, historyMode = 'auto', upstreamProtocol = 'auto' } = {}) {
  if (!['minimal', 'codex', 'harness', 'auto'].includes(historyMode)) throw new TypeError('Invalid historyMode.');
  if (!['passthrough', 'responses', 'auto'].includes(upstreamProtocol)) throw new TypeError('Invalid upstreamProtocol.');
  const convert = endpoint === 'messages' && isAgentRouterUpstream(upstream)
    && (upstreamProtocol === 'auto' || upstreamProtocol === 'responses');
  return { historyMode: convert && historyMode === 'auto' ? 'minimal' : historyMode, convert };
}

module.exports = { resolveRequestProfile };
