#!/usr/bin/env node
'use strict';

const { createBridge } = require('./index');

function numberFromEnv(name, fallback) {
  return process.env[name] === undefined ? fallback : Number(process.env[name]);
}

async function main() {
  if (process.argv.length !== 2) throw new Error('No command-line arguments are accepted. Configure with environment variables.');
  if (!process.env.RHB_UPSTREAM) throw new Error('Set RHB_UPSTREAM to a fixed upstream API base URL, for example https://api.example.com/v1.');
  const port = numberFromEnv('RHB_PORT', 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('RHB_PORT must be between 1 and 65535.');
  const bridge = createBridge({
    upstream: process.env.RHB_UPSTREAM,
    apiKey: process.env.RHB_API_KEY,
    keyHeader: process.env.RHB_KEY_HEADER,
    host: process.env.RHB_HOST,
    timeoutMs: numberFromEnv('RHB_TIMEOUT_MS', 180000),
    requestLimit: numberFromEnv('RHB_REQUEST_LIMIT', 8 * 1024 * 1024),
    bufferLimit: numberFromEnv('RHB_BUFFER_LIMIT', 64 * 1024)
  });
  const address = await bridge.listen(port);
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  process.stdout.write(`resource-history-bridge listening at http://${host}:${address.port}/v1\n`);
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
  process.stderr.write('resource-history-bridge could not start. Check RHB_UPSTREAM, loopback host, port, limits and key header; no arguments are accepted.\n');
  process.exitCode = 1;
});
