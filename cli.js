#!/usr/bin/env node
'use strict';

const { createBridge } = require('./index');
const { validateAgentRouterUpstream, isAgentRouterUpstream } = require('./lib/agentrouter');
const { resolveClientConfig } = require('./lib/client-config');

function numberFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) throw new TypeError(`Invalid ${name}.`);
  return Number(value);
}

function booleanFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  switch (value.trim().toLowerCase()) {
    case 'true': case '1': return true;
    case 'false': case '0': return false;
    default: throw new TypeError(`Invalid ${name}.`);
  }
}

function diagnosticsFromEnv() {
  const filePath = process.env.RHB_DIAGNOSTICS_PATH;
  if (filePath === undefined) return { enabled: false };
  if (!filePath.trim()) throw new TypeError('Invalid diagnostics path.');
  return {
    enabled: true,
    filePath,
    maxFileBytes: numberFromEnv('RHB_DIAGNOSTICS_MAX_BYTES', 1024 * 1024),
    maxFiles: numberFromEnv('RHB_DIAGNOSTICS_MAX_FILES', 3)
  };
}

async function main() {
  if (process.argv.length !== 2) throw new Error('No command-line arguments are accepted. Configure with environment variables.');
  const upstream = validateAgentRouterUpstream(process.env.RHB_UPSTREAM);
  const agentRouterRecovery = isAgentRouterUpstream(upstream);
  const { client, historyMode, upstreamProtocol } = resolveClientConfig(process.env);
  const port = numberFromEnv('RHB_PORT', 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RHB_PORT must be between 1 and 65535.');
  const harness = historyMode === 'harness';
  const historyStrategy = process.env.RHB_HISTORY_STRATEGY ?? 'on-error';
  if (!['on-error', 'portable'].includes(historyStrategy)) throw new TypeError('Invalid history strategy.');
  const bridge = createBridge({
    upstream: upstream.href,
    apiKey: process.env.RHB_API_KEY,
    keyHeader: process.env.RHB_KEY_HEADER,
    userAgent: process.env.RHB_USER_AGENT,
    host: process.env.RHB_HOST,
    upstreamProtocol,
    reasoningShape: process.env.RHB_REASONING_SHAPE,
    historyMode,
    historyStrategy,
    transparentRecovery: booleanFromEnv('RHB_TRANSPARENT_RECOVERY', historyMode !== 'minimal'),
    automaticRecovery: booleanFromEnv('RHB_AUTOMATIC_RECOVERY', harness),
    generic400Projection: booleanFromEnv('RHB_GENERIC_400_PROJECTION', harness),
    timeoutMs: numberFromEnv('RHB_TIMEOUT_MS', 180000),
    totalAttempts: numberFromEnv('RHB_TOTAL_ATTEMPTS', 10),
    transientAttempts: numberFromEnv('RHB_TRANSIENT_ATTEMPTS', 3),
    resourceAttempts: numberFromEnv('RHB_RESOURCE_ATTEMPTS', 10),
    retryDelayMs: numberFromEnv('RHB_RETRY_DELAY_MS', harness ? 250 : 1000),
    maxRetryDelayMs: numberFromEnv('RHB_MAX_RETRY_DELAY_MS', 2000),
    retryJitterRatio: numberFromEnv('RHB_RETRY_JITTER_RATIO', 0.2),
    requestLimit: numberFromEnv('RHB_REQUEST_LIMIT', 8 * 1024 * 1024),
    bufferLimit: numberFromEnv('RHB_BUFFER_LIMIT', 64 * 1024),
    diagnostics: diagnosticsFromEnv()
  });
  const address = await bridge.listen(port);
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const authSource = process.env.RHB_API_KEY === undefined ? 'client' : 'bridge override';
  const effectiveProtocol = agentRouterRecovery ? upstreamProtocol : 'passthrough';
  if (client === 'auto') process.stdout.write('Automatic request adaptation; no client selection required.\n');
  process.stdout.write(`Upstream: ${upstream.origin}\nAgentRouter recovery: ${agentRouterRecovery ? 'enabled' : 'disabled (passthrough)'}\nClient: ${client}; history: ${historyMode}; protocol: ${effectiveProtocol}; auth source: ${authSource}\nresource-history-bridge listening at http://${host}:${address.port}/v1\n`);
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await bridge.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch(() => {
  // Do not echo exception strings: an invalid URL could contain credentials.
  process.stderr.write('resource-history-bridge could not start. Check RHB_CLIENT, RHB_UPSTREAM, history/protocol overrides, loopback host, port, limits and key header; no arguments are accepted.\n');
  process.exitCode = 1;
});
