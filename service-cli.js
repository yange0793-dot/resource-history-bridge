#!/usr/bin/env node
'use strict';

const { createServiceManager, environmentFromProcess, ServiceError, SERVICE_ID } = require('./lib/service-manager');

const HELP = `Usage: node service-cli.js install|status|start|stop|uninstall|help [--dry-run]

Optional native per-user background runtime (Node.js >=18).
install registers login autostart and waits for loopback readiness.
status reads owned service metadata and /health only, never model requests or logs.
start/stop act only on the verified owned native service, never arbitrary PIDs.
uninstall preserves modified/foreign files and runtime logs.
--dry-run prints planned files and native commands without changing anything.

Service identity: ${SERVICE_ID}
Windows task name adds a stable per-user home hash; its current-user SID is verified.
Install settings: explicit RHB_UPSTREAM/RHB_PORT; optional legacy RHB_CLIENT,
RHB_HISTORY_MODE/RHB_UPSTREAM_PROTOCOL. No arbitrary environment is saved.
RHB_API_KEY persistence is refused. Keep authentication in the client.
No administrator elevation, downloads, client configuration changes or old service takeover.
`;

async function main({ argv = process.argv.slice(2), env = process.env, manager, stdout = process.stdout, stderr = process.stderr } = {}) {
  const actions = ['install', 'status', 'start', 'stop', 'uninstall', 'help'];
  const action = argv[0] || 'help';
  if (!actions.includes(action) || argv.slice(1).some(value => value !== '--dry-run') || argv.filter(value => value === '--dry-run').length > 1) {
    stderr.write(HELP);
    return 1;
  }
  if (action === 'help') { stdout.write(HELP); return 0; }
  try {
    const service = manager || createServiceManager();
    const dryRun = argv.includes('--dry-run');
    const environment = action === 'install' ? environmentFromProcess(env) : {};
    const result = dryRun ? await service.plan(action, environment) : action === 'install' ? await service.install(environment) : await service[action]();
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(error instanceof ServiceError ? `${error.code}: ${error.message}\n` : 'Service operation failed. Existing services and files have not been force-cleaned.\n');
    return 1;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });
module.exports = { main, HELP };
