import harness from '../lib/harness-host.js';

export const name = 'harness-auto-continue';
export const inject = ['agents', 'sessions'];

export function apply(ctx) {
  const logger = ctx.logger(name);
  const host = harness.createHarnessHost({
    ctx,
    autoContinue: true,
    maxAutoRuns: 3,
    logger
  });
  ctx.effect(() => () => host.dispose(), 'harness-auto-continue: dispose host');
  logger.info('harness-auto-continue: enabled (same-session continuation, max 3 runs)');
}

export default { name, inject, apply };
