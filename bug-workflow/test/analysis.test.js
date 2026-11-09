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
import { TICKET_WORKSPACE_META_PREFIX } from '../src/host/workspace.js';

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

/**
 * Minimal in-memory storage-domain double (same contract as store.test.js).
 * `beforePut(table, key, value)` is an optional test hook awaited at the start
 * of a `put`, so one queued write can be parked deterministically.
 */
function createFakeDomain({ beforePut } = {}) {
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
          if (typeof beforePut === 'function') await beforePut(name, key, value);
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
      return typeof available === 'function' ? available() : available;
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

/** Real-timer delay used to make terminal writes land after dispose() starts. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a real store over a fake domain plus the analysis service.
 * `store` uses a constant clock: the persisted timestamps are not under test.
 */
function setup({
  runner = createFakeRunner(),
  timeoutMs = 5_000,
  drainTimeoutMs,
  attachments,
} = {}) {
  const domain = createFakeDomain();
  const store = createStore(domain, () => T1);
  const service = createAnalysisService({
    store,
    runner,
    clock: createServiceClock(),
    timeoutMs,
    ...(drainTimeoutMs === undefined ? {} : { drainTimeoutMs }),
    ...(attachments === undefined ? {} : { attachments }),
  });
  return { domain, store, service, runner, attachments };
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

/** Ticket left blocked by a failed analysis (the state a host reload sees). */
async function seedBlockedFromAnalysis(domain, code, reason = 'analysis-failed') {
  return seedTicket(domain, code, {
    workflow: 'blocked',
    blockedFrom: 'analyzing',
    blockedReason: reason,
    timeline: [
      { at: T1, kind: 'created', actor: 'system', message: '工单已创建' },
      { at: T1, kind: 'start_analysis', actor: 'user', message: '开始分析工单' },
      { at: T1, kind: 'blocked', actor: 'system', message: '工单已阻塞' },
    ],
  });
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

test('platform images are downloaded before the child runs and passed as local evidence paths', async () => {
  const attachments = {
    prepared: [],
    cleaned: [],
    async prepare(cwd, code) {
      this.prepared.push([cwd, code]);
      return {
        ok: true,
        dir: '/tmp/bug-workflow-attachments/BUG-1',
        images: [{ name: 'shot.png', path: '/tmp/bug-workflow-attachments/BUG-1/01-shot.png', bytes: 1024 }],
        files: [],
      };
    },
    async cleanup(dir) {
      this.cleaned.push(dir);
    },
  };
  const { store, service, runner } = setup({ attachments });
  await createTicket(store);

  await service.start(SESSION_ID, CWD, 'BUG-1');
  await waitForIdle(service);

  assert.deepEqual(attachments.prepared, [[CWD, 'BUG-1']]);
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(runner.calls[0].ticket.analysisAttachments.images, [
    { name: 'shot.png', path: '/tmp/bug-workflow-attachments/BUG-1/01-shot.png', bytes: 1024 },
  ]);
  // Evidence is transient: the directory is cleaned after the analysis.
  assert.deepEqual(attachments.cleaned, ['/tmp/bug-workflow-attachments/BUG-1']);
  // The ticket itself is not mutated with the evidence.
  assert.equal(store.get('BUG-1').analysisAttachments, undefined);
});

test('a failing attachment downloader degrades to the text-only prompt', async () => {
  const attachments = {
    async prepare() {
      throw new Error('download exploded');
    },
    async cleanup() {},
  };
  const { store, service, runner } = setup({ attachments });
  await createTicket(store);

  await service.start(SESSION_ID, CWD, 'BUG-1');
  await waitForIdle(service);

  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].ticket.analysisAttachments, undefined);
  assert.equal(store.get('BUG-1').workflow, 'plan_review');
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

test('start() maps an unexpected store read failure to internal, not ticket-not-found', async () => {
  const { store, service, runner } = setup();
  await createTicket(store);
  store.get = () => {
    throw new Error('storage read failed');
  };

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'internal');
  assert.equal(typeof result.message, 'string');
  assert.equal(runner.calls.length, 0);
  assert.deepEqual(service.status().running, []);
});

// ---------------------------------------------------------------------------
// Restart semantics (P3 Task 2 review findings)
//
// A failure blocks the ticket from `analyzing`; `start_analysis` only accepts
// `inbox`, so without service-level restart a blocked ticket could never be
// analyzed again. The service retries the ticket back to `analyzing` itself.
// ---------------------------------------------------------------------------

test('a blocked analysis restarts through retry, clears the stale error and launches one job', async () => {
  const pending = deferred();
  const attempts = [];
  const runner = createFakeRunner({
    run: () => {
      attempts.push('run');
      if (attempts.length === 1) {
        return Promise.resolve({ ok: false, code: 'analysis-timeout', message: 'timeout' });
      }
      return pending.promise;
    },
  });
  const { store, service } = setup({ runner });
  await createTicket(store);

  await service.start(SESSION_ID, CWD, 'BUG-1');
  await waitForIdle(service);
  const failed = store.get('BUG-1');
  assert.equal(failed.workflow, 'blocked');
  assert.equal(failed.blockedFrom, 'analyzing');
  assert.equal(store.getMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1'), '分析超时，请重试');

  const callsBefore = runner.calls.length;
  const restarted = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.deepEqual(restarted, { ok: true, running: true, workflow: 'analyzing' });
  assert.equal(runner.calls.length, callsBefore + 1);

  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'analyzing');
  assert.equal(ticket.blockedFrom, null);
  assert.equal(ticket.blockedReason, null);
  assert.equal(ticket.timeline.at(-1).kind, 'retry');
  assert.equal(ticket.timeline.at(-1).actor, 'user');
  // The restart must not smuggle in a second `start_analysis` transition.
  assert.equal(
    ticket.timeline.filter((entry) => entry.kind === 'start_analysis').length,
    1,
  );
  // The stale error is cleared when the restart is accepted, not only after
  // the new runner eventually settles.
  assert.equal(store.getMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1'), null);
  assert.deepEqual(service.status().errors, {});

  pending.resolve({ ok: true, plan: makePlan(), childId: 'child-2', elapsedMs: 5 });
  await waitForIdle(service);
  assert.equal(store.get('BUG-1').workflow, 'plan_review');
});

test('an orphaned analyzing ticket restarts without another start_analysis transition', async () => {
  const pending = deferred();
  const runner = createFakeRunner({ run: () => pending.promise });
  const { domain, store, service } = setup({ runner });
  // Shape left behind when the host unloaded mid-analysis: `analyzing` with no
  // in-memory running job and a persisted failure error.
  await seedTicket(domain, 'BUG-1', {
    workflow: 'analyzing',
    timeline: [
      { at: T1, kind: 'created', actor: 'system', message: '工单已创建' },
      { at: T1, kind: 'start_analysis', actor: 'user', message: '开始分析工单' },
    ],
  });
  await store.setMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1', '分析子代理执行失败，请重试');
  assert.equal(service.status().errors['BUG-1'], '分析子代理执行失败，请重试');

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.deepEqual(result, { ok: true, running: true, workflow: 'analyzing' });
  assert.equal(runner.calls.length, 1);

  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'analyzing');
  assert.equal(
    ticket.timeline.filter((entry) => entry.kind === 'start_analysis').length,
    1,
  );
  assert.equal(store.getMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1'), null);
  assert.deepEqual(service.status().errors, {});

  pending.resolve({ ok: true, plan: makePlan(), childId: 'child-3', elapsedMs: 4 });
  await waitForIdle(service);
  assert.equal(store.get('BUG-1').workflow, 'plan_review');
});

test('a ticket blocked for a non-analysis reason is not restarted', async () => {
  const { domain, store, runner, service } = setup();
  await seedTicket(domain, 'BUG-1', {
    workflow: 'blocked',
    blockedFrom: 'plan_review',
    blockedReason: 'plan-rejected',
  });

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-state');
  assert.equal(runner.calls.length, 0);

  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedFrom, 'plan_review');
  assert.equal(ticket.blockedReason, 'plan-rejected');
  assert.equal(ticket.timeline.some((entry) => entry.kind === 'retry'), false);
  assert.deepEqual(service.status().running, []);
});

test('two concurrent restarts of a blocked analysis launch exactly one runner', async () => {
  const pending = deferred();
  const runner = createFakeRunner({ run: () => pending.promise });
  const { domain, store, service } = setup({ runner });
  await seedBlockedFromAnalysis(domain, 'BUG-1');

  const first = service.start(SESSION_ID, CWD, 'BUG-1');
  const duplicate = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.deepEqual(duplicate, { ok: true, running: true, workflow: 'analyzing' });

  const restarted = await first;
  assert.deepEqual(restarted, { ok: true, running: true, workflow: 'analyzing' });
  assert.equal(runner.calls.length, 1);
  assert.equal(
    store.get('BUG-1').timeline.filter((entry) => entry.kind === 'retry').length,
    1,
  );

  pending.resolve({ ok: true, plan: makePlan(), childId: 'child-4', elapsedMs: 6 });
  await waitForIdle(service);
  assert.equal(store.get('BUG-1').workflow, 'plan_review');
});

test('restarting a blocked analysis with no live agent leaves the ticket blocked', async () => {
  let available = true;
  const runner = createFakeRunner({ available: () => available });
  const { domain, store, service } = setup({ runner });
  await seedBlockedFromAnalysis(domain, 'BUG-1');
  await store.setMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1', '分析子代理执行失败，请重试');
  available = false;

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'analysis-unavailable');
  assert.equal(result.message, '当前没有可用的会话 Agent');

  // Availability is checked before any write: no retry transition, no runner.
  assert.equal(runner.calls.length, 0);
  assert.ok(store.get('BUG-1').timeline.every((entry) => entry.kind !== 'retry'));
  assert.equal(store.get('BUG-1').workflow, 'blocked');
  assert.equal(store.get('BUG-1').blockedFrom, 'analyzing');
  assert.equal(store.getMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1'), '分析子代理执行失败，请重试');
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

test('a late failure never blocks a ticket that already advanced past analyzing', async () => {
  const pending = deferred();
  const runner = createFakeRunner({ run: () => pending.promise });
  const { store, service } = setup({ runner });
  await createTicket(store);

  await service.start(SESSION_ID, CWD, 'BUG-1');
  // Manual/system completion while the child is still running: the ticket is
  // already in plan_review when the job later reports a failure.
  const done = await store.applyAction(
    'BUG-1',
    'analysis_done',
    { plan: makePlan(), actor: 'agent' },
    { actionId: 'manual-analysis-done' },
  );
  assert.equal(done.ok, true);
  assert.equal(done.ticket.workflow, 'plan_review');

  pending.resolve({ ok: false, code: 'analysis-failed', message: 'late boom' });
  await waitForIdle(service);

  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'plan_review');
  assert.equal(ticket.blockedFrom, null);
  assert.equal(ticket.blockedReason, null);
  assert.equal(ticket.timeline.some((entry) => entry.kind === 'blocked'), false);
  // The static reason is still recorded for the user, but no state write.
  assert.equal(
    store.getMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1'),
    '分析子代理执行失败，请重试',
  );
});

test('a failure queued behind an advance cannot regress the advanced ticket', async () => {
  const pending = deferred();
  const runner = createFakeRunner({ run: () => pending.promise });
  const entered = deferred();
  const release = deferred();
  let pauseArmed = false;
  const domain = createFakeDomain({
    beforePut: async (table, key) => {
      if (!pauseArmed || table !== 'tickets' || key !== 'BUG-1') return;
      pauseArmed = false;
      entered.resolve();
      await release.promise;
    },
  });
  const store = createStore(domain, () => T1);
  const service = createAnalysisService({
    store,
    runner,
    clock: createServiceClock(),
    timeoutMs: 5_000,
  });
  await createTicket(store);
  await service.start(SESSION_ID, CWD, 'BUG-1');

  // Park the plan_review write inside the store queue. The persisted ticket is
  // still `analyzing`, which is exactly the stale view the old failure path
  // read before it queued its `block`.
  pauseArmed = true;
  const advance = store.applyAction(
    'BUG-1',
    'analysis_done',
    { plan: makePlan(), actor: 'agent' },
    { actionId: 'race-advance' },
  );
  await entered.promise;

  // Record the failure's block enqueue so the test knows it read + queued while
  // the advance was still paused (the block then waits behind that write).
  const blockQueued = deferred();
  let blockSeen = false;
  const originalApply = store.applyAction.bind(store);
  store.applyAction = (...args) => {
    if (!blockSeen && args[1] === 'block') {
      blockSeen = true;
      blockQueued.resolve(args);
    }
    return originalApply(...args);
  };

  pending.resolve({ ok: false, code: 'analysis-failed', message: 'late boom' });
  await blockQueued.promise;
  assert.equal(store.get('BUG-1').workflow, 'analyzing', 'the advance is still parked');

  release.resolve();
  await advance;
  await waitForIdle(service);

  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'plan_review');
  assert.equal(ticket.blockedFrom, null);
  assert.equal(ticket.blockedReason, null);
  assert.equal(ticket.timeline.some((entry) => entry.kind === 'blocked'), false);
  // The failure is still visible as static metadata; only the state write is
  // refused because the ticket already advanced.
  assert.equal(
    store.getMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1'),
    '分析子代理执行失败，请重试',
  );
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

test('dispose() aborts running work without turning teardown into an analysis failure', async () => {
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

  const drained = service.dispose();
  assert.equal(signal.aborted, true);
  assert.deepEqual(service.status().running, []);
  // Idempotent: a second teardown returns the same in-flight drain.
  assert.equal(service.dispose(), drained);
  assert.deepEqual(service.status().running, []);

  // A disposed service refuses new work with the 503-mapped code.
  const after = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.equal(after.ok, false);
  assert.equal(after.code, 'analysis-unavailable');

  // Unload is not a real analysis failure: the ticket stays `analyzing` (the
  // next host load restarts it through the orphan path) and no false error is
  // persisted for the user.
  await drained;
  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'analyzing');
  assert.equal(ticket.blockedFrom, null);
  assert.equal(ticket.timeline.some((entry) => entry.kind === 'blocked'), false);
  assert.equal(store.getMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1'), undefined);
  assert.deepEqual(service.status().errors, {});
});

test('dispose() waits for the aborted job to settle before resolving', async () => {
  const runner = createFakeRunner({
    run: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        // Deliberate delay: a dispose() that resolved right after abort() would
        // resolve before the runner had settled, so the test can tell them
        // apart. No terminal write follows a cancelled job (asserted below).
        setTimeout(() => resolve({ ok: false, code: 'analysis-failed', message: 'aborted' }), 25);
      }, { once: true });
    }),
  });
  const { store, service } = setup({ runner });
  await createTicket(store);
  await service.start(SESSION_ID, CWD, 'BUG-1');

  const startedAt = Date.now();
  const drained = service.dispose();
  assert.equal(typeof drained?.then, 'function');
  assert.deepEqual(service.status().running, []);
  assert.equal(store.get('BUG-1').workflow, 'analyzing');

  let settled = false;
  drained.then(() => { settled = true; });
  await delay(5);
  assert.equal(settled, false, 'dispose() must not resolve before the aborted runner settles');

  await drained;
  assert.ok(Date.now() - startedAt >= 15, 'the drain must include the runner settlement');
  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'analyzing');
  assert.equal(store.getMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1'), undefined);
});

test('dispose() leaves no terminal write for a cancelled analysis', async () => {
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

  const writes = [];
  store.applyAction = async (...args) => {
    writes.push(['applyAction', args[1]]);
    throw new Error('domain closed');
  };
  store.setMeta = async (...args) => {
    writes.push(['setMeta', args[0]]);
    throw new Error('domain closed');
  };

  await service.dispose();
  assert.deepEqual(writes, [], 'a cancelled analysis must not write a false failure');
  assert.deepEqual(service.status().running, []);
  assert.equal(store.get('BUG-1').workflow, 'analyzing');
  assert.equal(store.getMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1'), undefined);
});

test('a dispose-cancelled analysis is restartable through the orphan path', async () => {
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
  await service.dispose();

  // Simulate the next host load: a fresh service instance over the same store
  // sees `analyzing` with no in-memory job and restarts it without a second
  // start_analysis transition.
  const restartedRunner = createFakeRunner();
  const restartedService = createAnalysisService({
    store,
    runner: restartedRunner,
    clock: createServiceClock(),
    timeoutMs: 5_000,
  });
  const restarted = await restartedService.start(SESSION_ID, CWD, 'BUG-1');
  assert.deepEqual(restarted, { ok: true, running: true, workflow: 'analyzing' });
  assert.equal(restartedRunner.calls.length, 1);

  await waitForIdle(restartedService);
  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'plan_review');
  assert.equal(
    ticket.timeline.filter((entry) => entry.kind === 'start_analysis').length,
    1,
    'the orphan restart must not write a second start_analysis',
  );
  assert.equal(store.getMeta(ANALYSIS_ERROR_META_PREFIX + 'BUG-1'), undefined);
});

test('dispose() is bounded when a runner ignores the abort signal', async () => {
  const runner = createFakeRunner({ run: () => new Promise(() => {}) });
  const { store, service } = setup({ runner, drainTimeoutMs: 25 });
  await createTicket(store);
  await service.start(SESSION_ID, CWD, 'BUG-1');

  const startedAt = Date.now();
  await service.dispose();
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 10, `drain returned too early: ${elapsed}ms`);
  assert.ok(elapsed < 1_000, `drain was not bounded: ${elapsed}ms`);
  assert.deepEqual(service.status().running, []);
});

test('dispose() during start() prevents the background job from launching', async () => {
  const pending = deferred();
  const runner = createFakeRunner();
  const { store, service } = setup({ runner });
  await createTicket(store);
  // Hold `start_analysis` in flight, then tear down while start() awaits it.
  store.applyAction = () => pending.promise;

  const started = service.start(SESSION_ID, CWD, 'BUG-1');
  assert.deepEqual(service.status().running, ['BUG-1']);
  const drained = service.dispose();
  pending.resolve({ ok: true, ticket: { ...store.get('BUG-1'), workflow: 'analyzing' } });

  const result = await started;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'analysis-unavailable');
  assert.equal(runner.calls.length, 0);
  assert.deepEqual(service.status().running, []);
  await drained;
  // The held write was never followed by a launch, so the ticket stays inbox.
  assert.equal(store.get('BUG-1').workflow, 'inbox');
});

// ---------------------------------------------------------------------------
// Owned-workspace record (P6 follow-up)
// ---------------------------------------------------------------------------

test('a fresh analysis records its workspace for the fix service', async () => {
  const { store, service } = setup();
  await createTicket(store);

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.deepEqual(result, { ok: true, running: true, workflow: 'analyzing' });
  assert.equal(store.getMeta(TICKET_WORKSPACE_META_PREFIX + 'BUG-1'), CWD);

  await waitForIdle(service);
  assert.equal(store.getMeta(TICKET_WORKSPACE_META_PREFIX + 'BUG-1'), CWD);
  assert.equal(store.get('BUG-1').workflow, 'plan_review');
});

test('restarting an orphaned analysis keeps the recorded workspace', async () => {
  const OTHER = '/tmp/bug-workflow-original-workspace';
  const { domain, store, service } = setup();
  await seedTicket(domain, 'BUG-1', {
    workflow: 'analyzing',
    timeline: [
      { at: T1, kind: 'created', actor: 'system', message: '工单已创建' },
      { at: T1, kind: 'start_analysis', actor: 'user', message: '开始分析工单' },
    ],
  });
  await store.setMeta(TICKET_WORKSPACE_META_PREFIX + 'BUG-1', OTHER);

  // The orphan restart may be clicked from another board: it must not steal
  // the ticket's owning workspace.
  const result = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.deepEqual(result, { ok: true, running: true, workflow: 'analyzing' });
  assert.equal(store.getMeta(TICKET_WORKSPACE_META_PREFIX + 'BUG-1'), OTHER);

  await waitForIdle(service);
});
