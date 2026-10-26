#!/usr/bin/env node
'use strict';

// Foreground supervisor that keeps one Codex app-server thread going after a
// turn fails once the native retry loop is finished with it.
//
// It reads and writes only through the documented app-server JSON-RPC surface.
// Nothing it prints comes from a prompt, a tool result or a credential: every
// line is a fact this process observed about turn state, error codes included.
//
// Usage:
//   rhb-codex-continue --thread <thread-id> [--watch] [--max-continuations n]
//                      [--deadline-ms n] [--json]
//                      [--command <path>] [--arg <value> ...]
//
// Exit codes:
//   0  a continuation turn completed
//   1  stopped, idle or out of budget
//   2  invalid usage
//   3  the app server could not be started or spoke something unreadable
//   130 interrupted

const {
  createCodexAppServerClient,
  createCodexAutoContinue,
  METHODS
} = require('../lib/codex-app-server');

const EXIT = Object.freeze({ completed: 0, stopped: 1, usage: 2, transport: 3, interrupted: 130 });
const MAX_ARG_COUNT = 64;

const USAGE = `Usage: rhb-codex-continue --thread <thread-id> [options]

Keeps one Codex app-server thread running after a terminal failed turn.

Options:
  --thread <id>              Thread to supervise (required)
  --watch                    Keep watching for later failures in the same thread
  --max-continuations <n>    Continuation turns per run, 1-3 (default 3)
  --deadline-ms <n>          Hard limit for the whole run, 1-180000 (default 180000)
  --command <path>           app-server executable (default: codex)
  --arg <value>              One argument for the executable (repeatable)
  --json                     Print the final result as one JSON object
  --help                     Print this message

Environment: nothing is read from environment variables except PATH.
`;

function integerOption(value, min, max, name) {
  if (!/^\d+$/.test(value)) throw new UsageError(`--${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new UsageError(`--${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    threadId: null,
    watch: false,
    maxContinuations: undefined,
    deadlineMs: undefined,
    command: undefined,
    args: [],
    json: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    // `--arg` takes the next token verbatim: it is an argument for the app
    // server, and those routinely start with a dash.
    const takeValue = (verbatim = false) => {
      const value = argv[index + 1];
      if (value === undefined || (!verbatim && value.startsWith('--'))) throw new UsageError(`${flag} needs a value.`);
      index += 1;
      return value;
    };
    switch (flag) {
      case '--thread':
        if (options.threadId !== null) throw new UsageError('--thread was given twice.');
        options.threadId = takeValue();
        break;
      case '--watch':
        options.watch = true;
        break;
      case '--max-continuations':
        options.maxContinuations = integerOption(takeValue(), 1, 3, 'max-continuations');
        break;
      case '--deadline-ms':
        options.deadlineMs = integerOption(takeValue(), 1, 180000, 'deadline-ms');
        break;
      case '--command':
        if (options.command !== undefined) throw new UsageError('--command was given twice.');
        options.command = takeValue();
        break;
      case '--arg':
        if (options.args.length >= MAX_ARG_COUNT) throw new UsageError('Too many --arg values.');
        options.args.push(takeValue(true));
        break;
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new UsageError(`Unknown option: ${flag}`);
    }
  }
  if (options.help) return options;
  if (options.threadId === null || options.threadId.length === 0) throw new UsageError('--thread is required.');
  return options;
}

// Human-readable facts only. Turn ids and error codes are opaque values the
// server itself reported.
function eventLine(event) {
  switch (event.type) {
    case 'turn_terminal':
      return `turn ${event.turnId} ended ${event.status}${event.code ? ` (${event.code})` : ''}`;
    case 'error_observed':
      return `error on turn ${event.turnId}${event.willRetry ? ', native retry still pending' : ''}`;
    case 'continuation_requested':
      return `continuing turn ${event.turnId}${event.code ? ` after ${event.code}` : ''}`;
    case 'continuation_started':
      return `continuation ${event.continuationIndex} started${event.code ? ` (${event.code})` : ''}`;
    case 'continuation_failed':
      return `continuation ${event.continuationIndex} ended ${event.status}${event.code ? ` (${event.code})` : ''}`;
    case 'continuation_completed':
      return `continuation ${event.continuationIndex} completed`;
    case 'continuation_stopped':
      return `continuation ${event.continuationIndex} stopped: ${event.reason}`;
    case 'continuation_finished':
      return `continuation run ended ${event.status}: ${event.reason}`;
    case 'turn_started':
      return `turn ${event.turnId} started`;
    default:
      return `event ${event.type}`;
  }
}

function summary(result) {
  const parts = [`status: ${result.status}`, `reason: ${result.reason}`];
  if (result.threadId) parts.push(`thread: ${result.threadId}`);
  parts.push(`continuations: ${result.continuations}`);
  if (result.lastRefusal) parts.push(`snapshot: ${result.lastRefusal}`);
  return parts.join('  ');
}

function exitCodeFor(result, interrupted) {
  if (interrupted) return EXIT.interrupted;
  if (result.status === 'completed') return EXIT.completed;
  if (result.reason === 'app_server_unavailable') return EXIT.transport;
  return EXIT.stopped;
}

async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`${error.message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    throw error;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }

  const client = createCodexAppServerClient({
    ...(options.command === undefined ? {} : { command: options.command }),
    ...(options.args.length === 0 ? {} : { args: options.args })
  });
  const controller = new AbortController();
  let interrupted = false;
  let forceExit = false;
  const onInterrupt = () => {
    if (interrupted) {
      // A second Ctrl+C never leaves a half-open child behind.
      forceExit = true;
      client.close().finally(() => process.exit(EXIT.interrupted));
      return;
    }
    interrupted = true;
    stderr.write('interrupted, stopping after the current step\n');
    controller.abort();
  };
  const signals = ['SIGINT', 'SIGTERM'];
  for (const name of signals) process.on(name, onInterrupt);

  try {
    await client.initialize();
    const runner = createCodexAutoContinue({
      client,
      watch: options.watch,
      ...(options.maxContinuations === undefined ? {} : { maxContinuations: options.maxContinuations }),
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs })
    });
    const result = await runner.run({
      threadId: options.threadId,
      signal: controller.signal,
      onProgress: event => {
        if (options.json) return;
        stdout.write(`${eventLine(event)}\n`);
      }
    });
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(`${summary(result)}\n`);
    // A cancelled run is reported as interrupted only when this process asked for
    // it; an abort from the caller's signal is not an interrupt.
    return exitCodeFor(result, interrupted && result.status === 'cancelled');
  } catch (error) {
    if (forceExit) return EXIT.interrupted;
    if (interrupted) return EXIT.interrupted;
    // Only the error's own code: messages can carry upstream text.
    if (error && typeof error.code === 'string' && error.code.startsWith('CODEX_APP_SERVER_')) {
      stderr.write(`app server unavailable: ${error.code}\n`);
      return EXIT.transport;
    }
    stderr.write(`failed: ${error && typeof error.code === 'string' ? error.code : 'unknown'}\n`);
    return EXIT.stopped;
  } finally {
    for (const name of signals) process.removeListener(name, onInterrupt);
    await client.close();
  }
}

module.exports = { main, parseArgs, eventLine, summary, USAGE, EXIT, METHODS };

if (require.main === module) {
  main(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    () => { process.exitCode = EXIT.stopped; }
  );
}
