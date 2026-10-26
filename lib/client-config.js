'use strict';

const CLIENT_PRESETS = Object.freeze({
  auto: Object.freeze({ historyMode: 'auto', upstreamProtocol: 'auto' }),
  codex: Object.freeze({ historyMode: 'codex', upstreamProtocol: 'passthrough' }),
  harness: Object.freeze({ historyMode: 'harness', upstreamProtocol: 'passthrough' }),
  'claude-code': Object.freeze({ historyMode: 'minimal', upstreamProtocol: 'responses' }),
  generic: Object.freeze({ historyMode: 'minimal', upstreamProtocol: 'passthrough' })
});

function resolveClientConfig(env = {}) {
  const legacyHistory = env.RHB_HISTORY_MODE !== undefined && env.RHB_HISTORY_MODE !== 'auto';
  const client = env.RHB_CLIENT ?? (legacyHistory ? 'generic' : 'auto');
  if (!Object.hasOwn(CLIENT_PRESETS, client)) throw new TypeError('Invalid client.');
  const preset = CLIENT_PRESETS[client];
  const historyMode = env.RHB_HISTORY_MODE ?? preset.historyMode;
  const upstreamProtocol = env.RHB_UPSTREAM_PROTOCOL ?? preset.upstreamProtocol;
  if (!['auto', 'minimal', 'codex', 'harness'].includes(historyMode)) throw new TypeError('Invalid history mode.');
  if (!['auto', 'passthrough', 'responses'].includes(upstreamProtocol)) throw new TypeError('Invalid upstream protocol.');
  return { client, historyMode, upstreamProtocol };
}

module.exports = { CLIENT_PRESETS, resolveClientConfig };
