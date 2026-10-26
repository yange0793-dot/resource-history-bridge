'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexAutoContinue, METHODS } = require('../lib/codex-app-server');

const THREAD = 'thread_deadline_0001';
// Keep the global timer far away; the injected clock leaves the wait only 1 ms.
const DEADLINE_MS = 180000;

function createWaitingClient(status, onRead) {
  const listeners = new Set();
  const calls = [];
  let waitSignal;
  let unsubscribed = false;
  const turn = { id: 'turn_existing_0001', status, error: null };
  const client = {
    calls,
    get signal() { return waitSignal; },
    get unsubscribed() { return unsubscribed; },
    subscribe(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
        unsubscribed = true;
      };
    },
    notify(method, params) {
      for (const listener of [...listeners]) listener({ type: 'notification', method, params });
    },
    async call(method, params, context) {
      calls.push({ method, params });
      assert.equal(method, METHODS.threadTurnsList);
      waitSignal = context.signal;
      onRead(client, turn);
      return { data: [{ ...turn }] };
    }
  };
  return client;
}

function assertNoContinuation(result, client) {
  assert.equal(result.continuations, 0);
  assert.equal(result.lastTurn, null);
  assert.equal(result.deadlineAtMs, DEADLINE_MS);
  assert.equal(client.unsubscribed, true);
  assert.deepEqual(client.calls, [{
    method: METHODS.threadTurnsList,
    params: { threadId: THREAD, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' }
  }]);
}

test('in-progress wait timeout stays deadline_expired before the global timer or injected clock expires', { timeout: 5000 }, async () => {
  let current = 0;
  const client = createWaitingClient('inProgress', () => { current = DEADLINE_MS - 1; });
  const runner = createCodexAutoContinue({ client, deadlineMs: DEADLINE_MS, now: () => current });
  const result = await runner.run({ threadId: THREAD });

  assert.equal(current, DEADLINE_MS - 1);
  assert.equal(client.signal.aborted, false);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'deadline_expired');
  assert.deepEqual(result.events, []);
  assertNoContinuation(result, client);
});

test('watch waiting for a different turn retains its own timeout even when the newest completed turn was observed', { timeout: 5000 }, async () => {
  let current = 0;
  const client = createWaitingClient('completed', (fake, turn) => {
    current = DEADLINE_MS - 1;
    fake.notify('turn/completed', { threadId: THREAD, turn: { ...turn } });
  });
  const runner = createCodexAutoContinue({ client, watch: true, deadlineMs: DEADLINE_MS, now: () => current });
  const result = await runner.run({ threadId: THREAD });

  assert.equal(current, DEADLINE_MS - 1);
  assert.equal(client.signal.aborted, false);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'deadline_expired');
  assert.deepEqual(result.events, [{
    type: 'turn_terminal', turnId: 'turn_existing_0001', status: 'completed', code: null
  }]);
  assertNoContinuation(result, client);
});

test('caller cancellation while waiting before the deadline remains cancelled/aborted', { timeout: 5000 }, async t => {
  let current = 0;
  const controller = new AbortController();
  let abortImmediate;
  t.after(() => {
    clearImmediate(abortImmediate);
    controller.abort();
  });
  const client = createWaitingClient('inProgress', () => {
    current = 100;
    abortImmediate = setImmediate(() => controller.abort());
  });
  const runner = createCodexAutoContinue({ client, deadlineMs: DEADLINE_MS, now: () => current });
  const result = await runner.run({ threadId: THREAD, signal: controller.signal });

  assert.equal(current, 100);
  assert.equal(client.signal.aborted, true);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason, 'aborted');
  assert.deepEqual(result.events, []);
  assertNoContinuation(result, client);
});

test('signal cancellation after the injected clock reaches the deadline remains stopped/deadline_expired', { timeout: 5000 }, async t => {
  let current = 0;
  const controller = new AbortController();
  let abortImmediate;
  t.after(() => {
    clearImmediate(abortImmediate);
    controller.abort();
  });
  const client = createWaitingClient('inProgress', () => {
    current = 100;
    abortImmediate = setImmediate(() => {
      current = DEADLINE_MS;
      controller.abort();
    });
  });
  const runner = createCodexAutoContinue({ client, deadlineMs: DEADLINE_MS, now: () => current });
  const result = await runner.run({ threadId: THREAD, signal: controller.signal });

  assert.equal(current, DEADLINE_MS);
  assert.equal(client.signal.aborted, true);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'deadline_expired');
  assert.deepEqual(result.events, []);
  assertNoContinuation(result, client);
});
