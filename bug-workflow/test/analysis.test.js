/**
 * Unit tests for the analysis orchestration service (P3 Task 2).
 *
 * The service is pure orchestration over injected `{store, runner, clock}`:
 * these tests use the real `createStore()` + state machine over an in-memory
 * fake storage domain, and a fake runner that stands in for the subagent
 * delegation seam. No Cordis fiber, zod schema or storage backend is involved.
 *
 * Coverage maps to the P3 Task 2 brief: happy start -> analysis_done, duplicate
 * clicks, runner failure/timeout/bad-output/unavailable mapping, stale results
 * after a manual state change, dispose/abort, and the "background job never
 * throws" contract.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALYSIS_ERROR_META_PREFIX,
  createAnalysisService,
} from '../src/host/analysis-service.js';
import { createStore } from '../src/host/store.js';
import { initialTicket } from '../src/host/state-machine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-live-1';
const CWD = '/tmp/bug-workflow-workspace';
const T1 = '2026-11-07T00:00:01.000Z';

const STALE_MESSAGE = '分析结果已过期或状态已变化，已丢弃';

/** JSON round-trip so the fake backend never shares object identity. */
function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Minimal in-memory storage-domain double (same contract as store.test.js). */
function createFakeDomain() {
  const tables = new Map();
  return {
    name: 'bug_workflow',
    raw: tables,
    table(name) {
      let records = tables.get(name);
      if (records === undefined) {
        records = new Map();
        tables.set(name, records);
      }
      return {
        get: (key) => cloneJson(records.get(key)),
        put: async (key, value) => {
          records.set(key, cloneJson(value));
        },
        delete: async (key) => records.delete(key),
        entries: () => {
          const pairs = [];
          for (const [key, value] of records) pairs.push([key, cloneJson(value)]);
          return pairs[Symbol.iterator]();
        },
        keys: () => records.keys(),
        get size() {
          return records.size;
        },
        update: async (key, fn) => {
          const next = fn(cloneJson(records.get(key)));
          records.set(key, cloneJson(next));
          return cloneJson(next);
        },
      };
    },
    close: async () => {},
  };
}

/** Monotonic ISO clock for the analysis action ids. */
function createServiceClock() {
  let tick = 0;
  return () => `2026-11-07T01:00:${String(tick++).padStart(2, '0')}.000Z`;
}

function makePlan(overrides = {}) {
  return {
    summary: '修复摘要',
    rootCause: '根因说明',
    approach: '修复方案',
    changedFiles: ['src/host/example.js'],
    risks: ['回归风险'],
    testPlan: '运行 node --test',
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Fake agent runner; `run` may return a promise that the test controls. */
function createFakeRunner({ available = true, run } = {}) {
  const calls = [];
  return {
    calls,
    available() {
      return available;
    },
    runAnalysis(input) {
      calls.push(input);
      if (typeof run === 'function') return run(input);
      return Promise.resolve({
        ok: true,
        plan: makePlan(),
        childId: 'child-1',
        elapsedMs: 7,
      });
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Build a real store over a fake domain plus the analysis service.
 * `store` uses a constant clock: the persisted timestamps are not under test.
 */
function setup({ runner = createFakeRunner(), timeoutMs = 5_000 } = {}) {
  const domain = createFakeDomain();
  const store = createStore(domain, () => T1);
  const service = createAnalysisService({
    store,
    runner,
    clock: createServiceClock(),
    timeoutMs,
  });
  return { domain, store, service, runner };
}

async function createTicket(store, code = 'BUG-1') {
  const result = await store.create({ code, title: code });
  assert.equal(result.ok, true);
  return result.ticket;
}

/** Seed an arbitrary ticket state directly into the domain (test-only). */
async function seedTicket(domain, code, patch = {}) {
  const ticket = {
    ...initialTicket({ code, title: code }, T1),
    ...patch,
  };
  await domain.table('tickets').put(code, ticket);
  return ticket;
}

/** Tick macrotasks until the service has no running analysis (bounded). */
async function waitForIdle(service, limit = 500) {
  for (let index = 0; index < limit; index += 1) {
    if (service.status().running.length === 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('analysis job did not settle');
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('start() moves inbox -> analyzing and applies the plan when the runner succeeds', async () => {
  const { store, service, runner } = setup();
  await createTicket(store);

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.deepEqual(result, { ok: true, running: true, workflow: 'analyzing' });

  const started = store.get('BUG-1');
  assert.equal(started.workflow, 'analyzing');
  assert.equal(started.timeline.at(-1).kind, 'start_analysis');
  assert.equal(started.timeline.at(-1).actor, 'user');
  assert.equal(service.status().running[0], 'BUG-1');

  await waitForIdle(service);

  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'plan_review');
  assert.equal(ticket.plan.summary, '修复摘要');
  assert.equal(ticket.plan.rootCause, '根因说明');
  assert.equal(ticket.plan.approach, '修复方案');
  assert.deepEqual(ticket.plan.changedFiles, ['src/host/example.js']);
  assert.deepEqual(ticket.plan.risks, ['回归风险']);
  assert.equal(ticket.plan.testPlan, '运行 node --test');
  assert.equal(typeof ticket.plan.generatedAt, 'string');
  assert.equal(ticket.plan.approvedAt, null);
  assert.equal(ticket.timeline.at(-1).kind, 'analysis_done');
  assert.equal(ticket.timeline.at(-1).actor, 'agent');

  // The runner received the exact contract inputs, including an AbortSignal.
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].sessionId, SESSION_ID);
  assert.equal(runner.calls[0].cwd, CWD);
  assert.equal(runner.calls[0].ticket.code, 'BUG-1');
  assert.ok(runner.calls[0].signal instanceof AbortSignal);
  assert.equal(runner.calls[0].signal.aborted, false);
  assert.equal(runner.calls[0].timeoutMs, 5_000);

  assert.deepEqual(service.status(), { running: [], errors: {} });
  assert.equal(store.getMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1'), undefined);
});

test('a duplicate start while running does not launch a second runner call', async () => {
  const pending = deferred();
  const runner = createFakeRunner({ run: () => pending.promise });
  const { store, service } = setup({ runner });
  await createTicket(store);

  const first = service.start(SESSION_ID, CWD, 'BUG-1');
  // Same tick, before the first `applyAction` settles: the in-flight entry is
  // already reserved, so the duplicate must not queue a second analysis.
  const duplicate = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.deepEqual(duplicate, { ok: true, running: true, workflow: 'analyzing' });

  const started = await first;
  assert.equal(started.ok, true);
  assert.equal(service.status().running.length, 1);

  pending.resolve({ ok: true, plan: makePlan(), childId: 'child-1', elapsedMs: 3 });
  await waitForIdle(service);

  assert.equal(runner.calls.length, 1);
  assert.equal(store.get('BUG-1').workflow, 'plan_review');
  assert.equal(store.get('BUG-1').timeline.filter((entry) => entry.kind === 'start_analysis').length, 1);
});

test('start() clears a previously persisted analysis error on success', async () => {
  const { store, service } = setup();
  await createTicket(store);
  await store.setMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1', '旧的分析错误');
  assert.equal(service.status().errors['BUG-1'], '旧的分析错误');

  await service.start(SESSION_ID, CWD, 'BUG-1');
  await waitForIdle(service);

  assert.equal(store.getMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1'), null);
  assert.deepEqual(service.status().errors, {});
});

// ---------------------------------------------------------------------------
// Runner failure -> blocked + persisted, static error
// ---------------------------------------------------------------------------

const FAILURE_CASES = [
  ['analysis-timeout', 'analysis-timeout', '分析超时，请重试'],
  ['analysis-bad-output', 'analysis-bad-output', '分析结果格式不正确，请重试'],
  ['analysis-unavailable', 'no-live-agent', '当前没有可用的会话 Agent'],
  ['analysis-failed', 'analysis-failed', '分析子代理执行失败，请重试'],
];

for (const [runnerCode, reason, message] of FAILURE_CASES) {
  test(`runner ${runnerCode} blocks the ticket with reason ${reason} and persists a static error`, async () => {
    const runner = createFakeRunner({
      run: () => Promise.resolve({ ok: false, code: runnerCode, message: 'internal detail' }),
    });
    const { store, service } = setup({ runner });
    await createTicket(store);

    const result = await service.start(SESSION_ID, CWD, 'BUG-1');
    assert.equal(result.ok, true);
    await waitForIdle(service);

    const ticket = store.get('BUG-1');
    assert.equal(ticket.workflow, 'blocked');
    assert.equal(ticket.blockedFrom, 'analyzing');
    assert.equal(ticket.blockedReason, reason);
    assert.equal(ticket.plan, null);
    assert.equal(ticket.timeline.at(-1).kind, 'blocked');

    assert.equal(store.getMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1'), message);
    assert.deepEqual(service.status(), { running: [], errors: { 'BUG-1': message } });

    // The persisted meta is the source of truth for a later service instance.
    const restarted = createAnalysisService({
      store,
      runner,
      clock: createServiceClock(),
    });
    assert.deepEqual(restarted.status(), { running: [], errors: { 'BUG-1': message } });
  });
}

test('a blocking failure after the ticket left analyzing only records the error', async () => {
  const pending = deferred();
  const runner = createFakeRunner({ run: () => pending.promise });
  const { store, service } = setup({ runner });
  await createTicket(store);

  await service.start(SESSION_ID, CWD, 'BUG-1');
  // User/system blocks the ticket while the analysis is still running.
  const blocked = await store.applyAction(
    'BUG-1',
    'block',
    { reason: 'manual-stop', actor: 'user' },
    { actionId: 'manual-block' },
  );
  assert.equal(blocked.ok, true);

  pending.resolve({ ok: false, code: 'analysis-timeout', message: 'timeout' });
  await waitForIdle(service);

  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedReason, 'manual-stop');
  assert.equal(store.getMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1'), '分析超时，请重试');
  assert.equal(
    ticket.timeline.filter((entry) => entry.kind === 'blocked').length,
    1,
  );
});

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

test('start() returns ticket-not-found for an unknown code', async () => {
  const { service, runner } = setup();
  const result = await service.start(SESSION_ID, CWD, 'NOPE-1');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'ticket-not-found');
  assert.equal(typeof result.message, 'string');
  assert.equal(runner.calls.length, 0);
  assert.deepEqual(service.status().running, []);
});

test('start() returns invalid-state for a ticket outside inbox and leaves it untouched', async () => {
  const { domain, store, runner, service } = setup();
  await seedTicket(domain, 'DONE-1', { workflow: 'done' });

  const result = await service.start(SESSION_ID, CWD, 'DONE-1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-state');
  assert.equal(runner.calls.length, 0);
  assert.equal(store.get('DONE-1').workflow, 'done');
});

test('start() returns analysis-unavailable before mutating state when no runner is available', async () => {
  const runner = createFakeRunner({ available: false });
  const { store, service } = setup({ runner });
  await createTicket(store);

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'analysis-unavailable');
  assert.equal(runner.calls.length, 0);
  assert.equal(store.get('BUG-1').workflow, 'inbox');
  assert.deepEqual(service.status().running, []);
});

test('start() propagates a structured store failure instead of throwing', async () => {
  const { store, service } = setup();
  await createTicket(store);
  store.applyAction = async () => ({
    ok: false,
    code: 'invalid-transition',
    message: '工单状态 inbox 不能执行 start_analysis',
  });

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-transition');
  assert.deepEqual(service.status().running, []);
});

// ---------------------------------------------------------------------------
// Stale result
// ---------------------------------------------------------------------------

test('a completed analysis is discarded when the ticket is no longer analyzing', async () => {
  const pending = deferred();
  const runner = createFakeRunner({ run: () => pending.promise });
  const { store, service } = setup({ runner });
  await createTicket(store);

  await service.start(SESSION_ID, CWD, 'BUG-1');
  const blocked = await store.applyAction(
    'BUG-1',
    'block',
    { reason: 'manual-stop', actor: 'user' },
    { actionId: 'manual-block' },
  );
  assert.equal(blocked.ok, true);

  pending.resolve({ ok: true, plan: makePlan(), childId: 'child-1', elapsedMs: 5 });
  await waitForIdle(service);

  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedReason, 'manual-stop');
  assert.equal(ticket.plan, null);
  assert.equal(ticket.timeline.some((entry) => entry.kind === 'analysis_done'), false);
  assert.equal(store.getMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1'), STALE_MESSAGE);
  assert.deepEqual(service.status().errors, { 'BUG-1': STALE_MESSAGE });
});

// ---------------------------------------------------------------------------
// Robustness / dispose
// ---------------------------------------------------------------------------

test('a rejecting runner never surfaces out of the background job', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const runner = createFakeRunner({
      run: () => Promise.reject(new Error('runner exploded')),
    });
    const { store, service } = setup({ runner });
    await createTicket(store);

    const result = await service.start(SESSION_ID, CWD, 'BUG-1');
    assert.equal(result.ok, true);
    await waitForIdle(service);
    await new Promise((resolve) => setImmediate(resolve));

    const ticket = store.get('BUG-1');
    assert.equal(ticket.workflow, 'blocked');
    assert.equal(ticket.blockedReason, 'analysis-failed');
    assert.equal(
      store.getMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1'),
      '分析子代理执行失败，请重试',
    );
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('dispose() aborts running work, clears running and is idempotent', async () => {
  const runner = createFakeRunner({
    run: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        resolve({ ok: false, code: 'analysis-failed', message: 'aborted' });
      }, { once: true });
    }),
  });
  const { store, service } = setup({ runner });
  await createTicket(store);

  await service.start(SESSION_ID, CWD, 'BUG-1');
  const { signal } = runner.calls[0];
  assert.deepEqual(service.status().running, ['BUG-1']);
  assert.equal(signal.aborted, false);

  service.dispose();
  assert.equal(signal.aborted, true);
  assert.deepEqual(service.status().running, []);
  // Idempotent: a second teardown must not throw or re-abort.
  service.dispose();
  assert.deepEqual(service.status().running, []);

  // A disposed service refuses new work with the 503-mapped code.
  const after = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.equal(after.ok, false);
  assert.equal(after.code, 'analysis-unavailable');

  // Let the aborted job settle: the failure is still handled exactly once.
  await waitForIdle(service);
  assert.equal(store.get('BUG-1').workflow, 'blocked');
  assert.equal(store.get('BUG-1').blockedReason, 'analysis-failed');
});
