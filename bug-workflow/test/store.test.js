/**
 * Unit tests for the persistent TicketStore.
 *
 * The store is exercised against an in-memory fake of the storage-domain
 * `Domain`/`KvTable` contract (`table(name)` returning get/put/delete/entries/
 * keys/size). Nothing here imports `domain.js`: that module owns the zod
 * schemas and is only loaded by the host runtime, which supplies zod through
 * the plugin "peerDependencies" contract.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SETTINGS,
  MAX_ACTION_RESULTS,
  createStore,
} from '../src/host/store.js';
import { initialTicket } from '../src/host/state-machine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * JSON round-trip so the fake backend behaves like the real single-file JSON
 * storage: reads and writes never share object identity with the caller.
 */
function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Minimal in-memory `Domain` double; mirrors the KvTable surface exactly.
 * `beforePut(table, key, value)` is an optional test hook awaited at the start
 * of a `put`, used to pause one write deterministically (write-queue tests).
 */
function createFakeDomain({ beforePut } = {}) {
  const tables = new Map();

  return {
    name: 'bug_workflow',
    /** Test-only access to the raw backing maps. */
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

/** Clock returning ISO timestamps in order; repeats the last one when exhausted. */
function clockFrom(...times) {
  let index = 0;
  return () => times[Math.min(index++, times.length - 1)];
}

/** A promise plus its settle functions; used to pause a fake write deterministically. */
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
 * Let every already-scheduled microtask (and one macrotask) run. Not a sleep:
 * it is the deterministic way to prove a queued write has NOT executed yet.
 */
function flushEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

const T1 = '2026-11-07T00:00:01.000Z';
const T2 = '2026-11-07T00:00:02.000Z';
const T3 = '2026-11-07T00:00:03.000Z';
const T4 = '2026-11-07T00:00:04.000Z';

/** Seed a record straight into the fake domain, bypassing the store. */
async function seedTicket(domain, ticket) {
  await domain.table('tickets').put(ticket.code, ticket);
}

/** A state-machine ticket placed directly in the `mr_open` phase. */
function mrOpenTicket(code, at, rounds) {
  const ticket = initialTicket({ code, title: code }, at);
  return {
    ...ticket,
    workflow: 'mr_open',
    mr: {
      iid: '17',
      url: 'https://gitlab.example.com/group/project/-/merge_requests/17',
      sourceBranch: `fix/${code}`,
      targetBranch: 'main',
      state: 'open',
      verdict: 'changes',
      blockingIssues: [],
      nonBlockingIssues: [],
      rounds,
    },
  };
}

/**
 * Domain-schema double for the store's injected write-boundary validator.
 * Mirrors the checks the host zod schemas perform on the review's examples.
 * A validator returns the normalized record or throws.
 */
function strictTicket(ticket) {
  if (ticket.plan !== null && typeof ticket.plan.summary !== 'string') {
    throw new Error('plan.summary 必须是字符串');
  }
  if (ticket.plan !== null && !Array.isArray(ticket.plan.changedFiles)) {
    throw new Error('plan.changedFiles 必须是数组');
  }
  if (ticket.blockedReason !== null && typeof ticket.blockedReason !== 'string') {
    throw new Error('blockedReason 必须是字符串');
  }
  if (ticket.mr !== null && !Number.isInteger(ticket.mr.rounds)) {
    throw new Error('mr.rounds 必须是整数');
  }
  return cloneJson(ticket);
}

/** Domain-schema double for settings; same contract as `strictTicket`. */
function strictSettings(settings) {
  for (const [field, value] of Object.entries(settings)) {
    // Domain v2 adds one boolean setting; every other declared field is a string.
    const expected = DEFAULT_SETTINGS[field] === true || DEFAULT_SETTINGS[field] === false
      ? 'boolean'
      : 'string';
    if (typeof value !== expected) {
      throw new Error(`settings.${field} 必须是${expected === 'boolean' ? '布尔值' : '字符串'}`);
    }
  }
  return cloneJson(settings);
}

const STRICT_VALIDATORS = Object.freeze({
  validateTicket: strictTicket,
  validateSettings: strictSettings,
});

/** Store wired like `index.js` wires it in the host: real validators at the boundary. */
function createStrictStore(domain, clock = () => T1) {
  return createStore(domain, clock, STRICT_VALIDATORS);
}

// ---------------------------------------------------------------------------
// create / get / list / snapshot
// ---------------------------------------------------------------------------

test('create() persists an inbox ticket and snapshot() reports it', async () => {
  const domain = createFakeDomain();
  const store = createStore(domain, () => T1);

  const created = await store.create({ code: ' BUG-1 ', title: '登录失败' });

  assert.equal(created.ok, true);
  assert.equal(created.ticket.code, 'BUG-1');
  assert.equal(created.ticket.title, '登录失败');
  assert.equal(created.ticket.workflow, 'inbox');
  assert.equal(created.ticket.createdAt, T1);
  assert.equal(created.ticket.updatedAt, T1);
  assert.equal(created.ticket.timeline.length, 1);
  // Domain v2 write-side defaults: manual tickets are explicit, never implied.
  assert.equal(created.ticket.source, 'manual');
  assert.equal(created.ticket.platform, null);

  const persisted = domain.table('tickets').get('BUG-1');
  assert.deepEqual(persisted, created.ticket);
  assert.equal(persisted.source, 'manual');
  assert.equal(persisted.platform, null);

  assert.deepEqual(store.get('BUG-1'), created.ticket);
  const snapshot = store.snapshot();
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.invalid, 0);
  assert.deepEqual(snapshot.tickets.map((ticket) => ticket.code), ['BUG-1']);
});

test('create() defaults the title to the code and fills optional fields', async () => {
  const domain = createFakeDomain();
  const store = createStore(domain, () => T1);

  const created = await store.create({
    code: 'BUG-2',
    type: '缺陷',
    version: 'V1.2.3',
    url: 'https://platform.example.com/issues/2',
  });

  assert.equal(created.ok, true);
  assert.equal(created.ticket.title, 'BUG-2');
  assert.equal(created.ticket.type, '缺陷');
  assert.equal(created.ticket.version, 'V1.2.3');
  assert.equal(created.ticket.priority, null);
});

test('create() rejects missing/duplicate codes and invalid field types', async () => {
  const domain = createFakeDomain();
  const store = createStore(domain, () => T1);
  await store.create({ code: 'BUG-3' });

  const missing = await store.create({ title: '没有编号' });
  assert.deepEqual(missing, {
    ok: false,
    code: 'invalid-input',
    message: '工单编号不能为空',
  });

  const duplicate = await store.create({ code: 'BUG-3', title: '覆盖尝试' });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'duplicate-code');
  assert.equal(domain.table('tickets').get('BUG-3').title, 'BUG-3');

  const badType = await store.create({ code: 'BUG-4', priority: 3 });
  assert.equal(badType.ok, false);
  assert.equal(badType.code, 'invalid-input');
  assert.equal(domain.table('tickets').get('BUG-4'), undefined);
});

test('create() refuses a schema-invalid ticket before writing', async () => {
  const domain = createFakeDomain();
  const store = createStore(domain, () => T1, {
    validateTicket: (ticket) => {
      if (ticket.status === 'X') throw new Error('status 非法');
      return ticket;
    },
  });

  const created = await store.create({ code: 'BUG-SCHEMA', status: 'X' });

  assert.equal(created.ok, false);
  assert.equal(created.code, 'invalid-payload');
  assert.match(created.message, /status/);
  assert.equal(domain.table('tickets').size, 0, 'invalid ticket must not be written');
  assert.deepEqual(store.snapshot(), { tickets: [], total: 0, invalid: 0 });
});

test('returned tickets do not alias the stored record', async () => {
  const domain = createFakeDomain();
  const store = createStrictStore(domain, () => T1);

  const created = await store.create({ code: 'BUG-CLONE', title: '原值' });
  created.ticket.title = '被调用方改坏';
  store.get('BUG-CLONE').title = '再改一次';
  store.list()[0].title = '列表改坏';

  assert.equal(domain.table('tickets').get('BUG-CLONE').title, '原值');
  assert.equal(store.get('BUG-CLONE').title, '原值');
});

// ---------------------------------------------------------------------------
// applyAction: transitions, persistence, structured errors
// ---------------------------------------------------------------------------

test('applyAction() persists the next ticket and advances updatedAt', async () => {
  const domain = createFakeDomain();
  const store = createStrictStore(domain, clockFrom(T1, T2, T3));
  await store.create({ code: 'BUG-5' });

  const started = await store.applyAction('BUG-5', 'start_analysis', {});
  assert.equal(started.ok, true);
  assert.equal(started.ticket.workflow, 'analyzing');
  assert.equal(started.ticket.createdAt, T1);
  assert.equal(started.ticket.updatedAt, T2);
  assert.equal(started.ticket.timeline.length, 2);

  const persisted = domain.table('tickets').get('BUG-5');
  assert.equal(persisted.workflow, 'analyzing');
  assert.equal(persisted.updatedAt, T2);

  const analysed = await store.applyAction('BUG-5', 'analysis_done', {
    plan: { summary: '方案' },
  });
  assert.equal(analysed.ok, true);
  assert.equal(analysed.ticket.workflow, 'plan_review');
  assert.equal(analysed.ticket.plan.summary, '方案');
  assert.equal(analysed.ticket.updatedAt, T3);
});

test('applyAction() maps StateError to a structured failure and keeps state', async () => {
  const domain = createFakeDomain();
  const store = createStore(domain, clockFrom(T1, T2));
  await store.create({ code: 'BUG-6' });

  const rejected = await store.applyAction('BUG-6', 'mr_merged', {});

  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'invalid-transition');
  assert.match(rejected.message, /inbox/);
  assert.equal(domain.table('tickets').get('BUG-6').workflow, 'inbox');
  assert.equal(domain.table('tickets').get('BUG-6').timeline.length, 1);
});

test('applyAction() propagates review-rounds-exhausted without auto-blocking', async () => {
  const domain = createFakeDomain();
  const store = createStore(domain, () => T1);
  await seedTicket(domain, mrOpenTicket('BUG-7', T1, 3));

  const rejected = await store.applyAction('BUG-7', 'review_requests_changes', {});

  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'review-rounds-exhausted');
  const persisted = domain.table('tickets').get('BUG-7');
  assert.equal(persisted.workflow, 'mr_open');
  assert.equal(persisted.mr.rounds, 3);
  assert.equal(persisted.blockedFrom, null);
  assert.equal(persisted.blockedReason, null);
});

test('applyAction() reports missing tickets and unknown actions as failures', async () => {
  const domain = createFakeDomain();
  const store = createStore(domain, () => T1);

  const missing = await store.applyAction('BUG-404', 'start_analysis', {});
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'not-found');

  await store.create({ code: 'BUG-8' });
  const unknown = await store.applyAction('BUG-8', 'teleport', {});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'invalid-action');
});

test('applyAction() refuses a schema-invalid plan and leaves the stored ticket untouched', async () => {
  const domain = createFakeDomain();
  const store = createStrictStore(domain, clockFrom(T1, T2, T3));
  await store.create({ code: 'BUG-PLAN' });
  await store.applyAction('BUG-PLAN', 'start_analysis', {});
  const before = domain.table('tickets').get('BUG-PLAN');

  const rejected = await store.applyAction(
    'BUG-PLAN',
    'analysis_done',
    { plan: { summary: 42, changedFiles: 'src/a.js' } },
    { actionId: 'bad-plan' },
  );

  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'invalid-payload');
  assert.match(rejected.message, /plan\.summary/);
  assert.deepEqual(domain.table('tickets').get('BUG-PLAN'), before);
  assert.equal(domain.table('tickets').get('BUG-PLAN').workflow, 'analyzing');
  assert.equal(domain.table('meta').size, 0, 'failed validation must not persist the actionId');
});

test('applyAction() refuses schema-invalid block and MR payloads without writing', async () => {
  const domain = createFakeDomain();
  const store = createStrictStore(domain, () => T1);
  await store.create({ code: 'BUG-BLOCK' });

  const blocked = await store.applyAction('BUG-BLOCK', 'block', { reason: 123 });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'invalid-payload');
  assert.match(blocked.message, /blockedReason/);
  assert.equal(domain.table('tickets').get('BUG-BLOCK').workflow, 'inbox');

  await seedTicket(domain, { ...initialTicket({ code: 'BUG-MR' }, T1), workflow: 'submitting' });
  const mr = await store.applyAction('BUG-MR', 'mr_created', { mr: { iid: '1', rounds: '2' } });

  assert.equal(mr.ok, false);
  assert.equal(mr.code, 'invalid-payload');
  assert.match(mr.message, /mr\.rounds/);
  assert.equal(domain.table('tickets').get('BUG-MR').workflow, 'submitting');
  assert.equal(domain.table('tickets').get('BUG-MR').mr, null);
});

test('applyAction(create) creates the ticket named by the route code', async () => {
  const domain = createFakeDomain();
  const store = createStore(domain, () => T1);

  const created = await store.applyAction('BUG-9', 'create', { title: '假引擎建单' });

  assert.equal(created.ok, true);
  assert.equal(created.ticket.code, 'BUG-9');
  assert.equal(created.ticket.title, '假引擎建单');
  assert.equal(created.ticket.workflow, 'inbox');
  assert.equal(store.list().length, 1);
});

// ---------------------------------------------------------------------------
// actionId idempotency
// ---------------------------------------------------------------------------

test('the same actionId returns the first result exactly once and persists once', async () => {
  const domain = createFakeDomain();
  const store = createStore(domain, clockFrom(T1, T2, T3));
  await store.create({ code: 'BUG-10' });

  const first = await store.applyAction('BUG-10', 'start_analysis', {}, { actionId: 'req-1' });
  assert.equal(first.ok, true);
  assert.equal(first.ticket.updatedAt, T2);

  // Replaying from `analyzing` would be an invalid transition; the actionId
  // cache must answer instead of running the state machine again.
  const replay = await store.applyAction('BUG-10', 'start_analysis', {}, { actionId: 'req-1' });
  assert.deepEqual(replay, first);
  assert.equal(domain.table('tickets').get('BUG-10').timeline.length, 2);
  assert.equal(domain.table('tickets').get('BUG-10').updatedAt, T2);

  const metaRecord = domain.table('meta').get('action:req-1');
  assert.equal(metaRecord.value.action, 'start_analysis');
  assert.equal(metaRecord.value.code, 'BUG-10');
  assert.deepEqual(metaRecord.value.result, first);

  const withoutActionId = await store.applyAction('BUG-10', 'start_analysis', {});
  assert.equal(withoutActionId.ok, false);
  assert.equal(withoutActionId.code, 'invalid-transition');

  const otherActionId = await store.applyAction('BUG-10', 'start_analysis', {}, { actionId: 'req-2' });
  assert.equal(otherActionId.ok, false);
  assert.equal(otherActionId.code, 'invalid-transition');
});

test('the same actionId for create is idempotent too', async () => {
  const domain = createFakeDomain();
  const store = createStore(domain, () => T1);

  const first = await store.applyAction('BUG-11', 'create', { title: '幂等建单' }, { actionId: 'create-1' });
  assert.equal(first.ok, true);

  const replay = await store.applyAction('BUG-11', 'create', { title: '幂等建单' }, { actionId: 'create-1' });
  assert.deepEqual(replay, first);
  assert.equal(domain.table('tickets').size, 1);
});

test('an actionId reused for another ticket or action is rejected', async () => {
  const domain = createFakeDomain();
  const store = createStore(domain, clockFrom(T1, T2, T3));
  await store.create({ code: 'BUG-ID-1' });
  await store.create({ code: 'BUG-ID-2' });

  const first = await store.applyAction('BUG-ID-1', 'start_analysis', {}, { actionId: 'shared-1' });
  assert.equal(first.ok, true);

  const otherTicket = await store.applyAction('BUG-ID-2', 'start_analysis', {}, { actionId: 'shared-1' });
  assert.equal(otherTicket.ok, false);
  assert.equal(otherTicket.code, 'action-id-reused');
  assert.match(otherTicket.message, /BUG-ID-1/);
  assert.equal(domain.table('tickets').get('BUG-ID-2').workflow, 'inbox');

  const otherAction = await store.applyAction(
    'BUG-ID-1',
    'analysis_done',
    { plan: { summary: '方案' } },
    { actionId: 'shared-1' },
  );
  assert.equal(otherAction.ok, false);
  assert.equal(otherAction.code, 'action-id-reused');
  assert.equal(domain.table('tickets').get('BUG-ID-1').workflow, 'analyzing');

  // The original request still replays the original result.
  const replay = await store.applyAction('BUG-ID-1', 'start_analysis', {}, { actionId: 'shared-1' });
  assert.deepEqual(replay, first);
});

test('the actionId cache is capped at MAX_ACTION_RESULTS, evicting the oldest', async () => {
  const domain = createFakeDomain();
  const meta = domain.table('meta');
  for (let index = 0; index < MAX_ACTION_RESULTS; index += 1) {
    await meta.put(`action:old-${index}`, {
      at: index + 1,
      value: {
        action: 'start_analysis',
        code: 'BUG-SEED',
        result: { ok: true, ticket: initialTicket({ code: 'BUG-SEED' }, T1) },
      },
    });
  }
  await seedTicket(domain, initialTicket({ code: 'BUG-12' }, T1));

  const store = createStore(domain, () => T2);
  const applied = await store.applyAction('BUG-12', 'start_analysis', {}, { actionId: 'new-action' });
  assert.equal(applied.ok, true);

  assert.equal(meta.size, MAX_ACTION_RESULTS);
  assert.equal(meta.get('action:old-0'), undefined);
  assert.notEqual(meta.get('action:new-action'), undefined);
  assert.notEqual(meta.get('action:old-1'), undefined);
});

// ---------------------------------------------------------------------------
// write serialization (P2 whole-branch review)
// ---------------------------------------------------------------------------

/** A mapped platform record accepted by `upsertPlatformRecords()`. */
function platformRecord(code, overrides = {}) {
  const url = `https://platform.example.com/issues/${code}`;
  return {
    code,
    title: '平台标题',
    type: '缺陷',
    status: '进行中',
    version: 'V1.2.0',
    priority: '高',
    assignee: '李昱',
    url,
    source: 'platform',
    platform: {
      taskId: `id-${code}`,
      taskCode: code,
      typeKey: '001_BUG',
      typeName: '缺陷',
      statusKey: '002_DOING',
      statusName: '进行中',
      priorityKey: '001_HIGH',
      priorityName: '高',
      versionKey: '501',
      versionName: 'V1.2.0',
      projectId: '1001',
      projectName: '示例项目',
      assigneeId: '10086',
      assigneeName: '李昱',
      description: '',
      url,
      syncedAt: Date.parse(T2),
    },
    ...overrides,
  };
}

test('a paused platform upsert cannot overwrite a locally started action', async () => {
  const entered = deferred();
  const release = deferred();
  let pauseArmed = false;
  const domain = createFakeDomain({
    beforePut: async (table, key) => {
      if (!pauseArmed || table !== 'tickets' || key !== 'SYNC-RACE-1') return;
      pauseArmed = false;
      entered.resolve();
      await release.promise;
    },
  });
  const store = createStrictStore(domain, clockFrom(T1, T2, T3));
  await store.create({ code: 'SYNC-RACE-1', title: '本地标题' });

  const record = platformRecord('SYNC-RACE-1');
  pauseArmed = true;
  const syncPromise = store.upsertPlatformRecords([record], T2);
  await entered.promise;

  // The upsert is parked inside tickets.put(). A local action must queue behind
  // it; before write serialization it ran here and was then overwritten by the
  // stale clone the upsert had already built.
  const actionPromise = store.applyAction('SYNC-RACE-1', 'start_analysis', {}, { actionId: 'race-action' });
  await flushEventLoop();
  assert.equal(
    domain.table('tickets').get('SYNC-RACE-1').workflow,
    'inbox',
    'the action must not run inside the paused upsert',
  );
  assert.equal(domain.table('tickets').get('SYNC-RACE-1').timeline.length, 1);

  release.resolve();
  const [synced, applied] = await Promise.all([syncPromise, actionPromise]);

  assert.deepEqual(synced, { created: 0, updated: 1 });
  assert.equal(applied.ok, true);

  const finalTicket = domain.table('tickets').get('SYNC-RACE-1');
  // Both effects survive: the platform fields from the upsert AND the local
  // workflow/timeline from the action (the reproduced bug lost the action).
  assert.equal(finalTicket.title, '平台标题');
  assert.equal(finalTicket.status, '进行中');
  assert.equal(finalTicket.source, 'platform');
  assert.deepEqual(finalTicket.platform, record.platform);
  assert.equal(finalTicket.workflow, 'analyzing');
  assert.deepEqual(finalTicket.timeline.map((event) => event.kind), ['created', 'start_analysis']);
});

test('two concurrent applyAction calls are serialized in call order', async () => {
  const domain = createFakeDomain();
  const store = createStrictStore(domain, clockFrom(T1, T2, T3));
  await store.create({ code: 'RACE-2' });

  const started = store.applyAction('RACE-2', 'start_analysis', {});
  const analysed = store.applyAction('RACE-2', 'analysis_done', { plan: { summary: '方案' } });
  const [first, second] = await Promise.all([started, analysed]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  // The second action is only legal from `analyzing`; without the queue both
  // calls read `inbox` and `analysis_done` fails as an invalid transition.
  const ticket = domain.table('tickets').get('RACE-2');
  assert.equal(ticket.workflow, 'plan_review');
  assert.equal(ticket.plan.summary, '方案');
  assert.deepEqual(ticket.timeline.map((event) => event.kind), [
    'created',
    'start_analysis',
    'analysis_done',
  ]);
  // Deterministic order: the first enqueued call owns the first transition.
  assert.equal(first.ticket.workflow, 'analyzing');
  assert.equal(second.ticket.workflow, 'plan_review');
});

test('applyAction() applies expectedWorkflow inside the write queue', async () => {
  const entered = deferred();
  const release = deferred();
  let pauseArmed = false;
  const domain = createFakeDomain({
    beforePut: async (table, key) => {
      if (!pauseArmed || table !== 'tickets' || key !== 'EXPECT-1') return;
      pauseArmed = false;
      entered.resolve();
      await release.promise;
    },
  });
  const store = createStrictStore(domain, clockFrom(T1, T2, T3));
  await store.create({ code: 'EXPECT-1' });

  // Park the inbox -> analyzing write; the persisted workflow is still `inbox`.
  pauseArmed = true;
  const startPromise = store.applyAction('EXPECT-1', 'start_analysis', {}, { actionId: 'expected-start' });
  await entered.promise;

  // This guard is checked AFTER the queued write runs, so at enqueue time the
  // ticket still looks `inbox`; only an in-critical-section check can see
  // `analyzing` and apply the block.
  const blockPromise = store.applyAction(
    'EXPECT-1',
    'block',
    { reason: 'manual-stop', actor: 'system' },
    { actionId: 'expected-block', expectedWorkflow: 'analyzing' },
  );
  await flushEventLoop();
  assert.equal(domain.table('tickets').get('EXPECT-1').workflow, 'inbox');

  release.resolve();
  const [started, blocked] = await Promise.all([startPromise, blockPromise]);

  assert.equal(started.ok, true);
  assert.equal(blocked.ok, true);
  assert.equal(blocked.ticket.workflow, 'blocked');
  assert.equal(blocked.ticket.blockedFrom, 'analyzing');
  assert.deepEqual(blocked.ticket.timeline.map((event) => event.kind), [
    'created',
    'start_analysis',
    'blocked',
  ]);
});

test('applyAction() refuses a stale expectedWorkflow without writing or memoizing', async () => {
  const domain = createFakeDomain();
  const store = createStrictStore(domain, clockFrom(T1, T2, T3));
  await store.create({ code: 'EXPECT-2' });

  const stale = await store.applyAction(
    'EXPECT-2',
    'block',
    { reason: 'late-failure', actor: 'system' },
    { actionId: 'expected-stale', expectedWorkflow: 'analyzing' },
  );

  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale-workflow');
  assert.equal(typeof stale.message, 'string');
  const ticket = domain.table('tickets').get('EXPECT-2');
  assert.equal(ticket.workflow, 'inbox');
  assert.deepEqual(ticket.timeline.map((event) => event.kind), ['created']);
  // No idempotency ledger entry: a later replay must be able to retry for real.
  assert.equal(domain.table('meta').get('action:expected-stale'), undefined);

  // Callers that do not pass the guard keep the legacy behaviour: `block` is
  // legal from `inbox` in the state machine and must still apply.
  const blocked = await store.applyAction('EXPECT-2', 'block', { reason: 'manual-stop', actor: 'user' });
  assert.equal(blocked.ok, true);
  assert.equal(blocked.ticket.workflow, 'blocked');
});

test('applyAction() validates expectedWorkflow as a non-empty string', async () => {
  const domain = createFakeDomain();
  const store = createStrictStore(domain, () => T1);
  await store.create({ code: 'EXPECT-3' });

  const rejected = await store.applyAction(
    'EXPECT-3',
    'start_analysis',
    {},
    { expectedWorkflow: '   ' },
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'invalid-input');
  assert.equal(store.get('EXPECT-3').workflow, 'inbox');
});

test('concurrent actionId retries replay the first result only once', async () => {
  const domain = createFakeDomain();
  let validations = 0;
  const store = createStore(domain, () => T1, {
    validateTicket: (ticket) => {
      validations += 1;
      return strictTicket(ticket);
    },
  });
  await seedTicket(domain, initialTicket({ code: 'RACE-3' }, T1));
  validations = 0;

  const [first, second] = await Promise.all([
    store.applyAction('RACE-3', 'start_analysis', {}, { actionId: 'race-id' }),
    store.applyAction('RACE-3', 'start_analysis', {}, { actionId: 'race-id' }),
  ]);

  assert.equal(first.ok, true);
  assert.deepEqual(second, first, 'the retry replays the first result verbatim');
  // A second state-machine run would validate and write again; the ledger
  // replay inside the same critical section must short-circuit it.
  assert.equal(validations, 1);
  const ticket = domain.table('tickets').get('RACE-3');
  assert.equal(ticket.workflow, 'analyzing');
  assert.equal(ticket.timeline.length, 2);
  assert.equal(domain.table('meta').size, 1);
  assert.deepEqual(domain.table('meta').get('action:race-id').value.result, first);
});

test('a rejected write does not wedge the queue and keeps its own error', async () => {
  const domain = createFakeDomain();
  const store = createStrictStore(domain, () => T1);

  const rejected = store.upsertPlatformRecords(null);
  const created = store.create({ code: 'AFTER-REJECT' });

  await assert.rejects(rejected, (error) => error.name === 'StoreError' && error.code === 'invalid-input');
  const createdResult = await created;
  assert.equal(createdResult.ok, true);
  assert.equal(store.get('AFTER-REJECT').workflow, 'inbox');

  // The tail is still usable after the rejection (and after a second failure).
  await assert.rejects(store.setMeta('', 'x'), (error) => error.code === 'invalid-input');
  assert.equal((await store.create({ code: 'AFTER-REJECT-2' })).ok, true);
});

test('concurrent partial putSettings calls merge instead of dropping a field', async () => {
  const domain = createFakeDomain();
  const store = createStrictStore(domain, () => T1);

  const [first, second] = await Promise.all([
    store.putSettings('/workspace/race', { branchUser: 'aa' }),
    store.putSettings('/workspace/race', { testCommand: 'npm test' }),
  ]);

  assert.equal(first.branchUser, 'aa');
  assert.equal(second.branchUser, 'aa');
  const stored = domain.table('settings').get('/workspace/race');
  assert.equal(stored.branchUser, 'aa');
  assert.equal(stored.testCommand, 'npm test');
});

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

test('getSettings() returns defaults until putSettings() writes a workspace record', async () => {
  const domain = createFakeDomain();
  const store = createStrictStore(domain, () => T1);

  const defaults = store.getSettings('/workspace/a');
  assert.deepEqual(defaults, DEFAULT_SETTINGS);
  assert.notEqual(defaults, DEFAULT_SETTINGS, 'callers must not receive the shared default object');
  // Domain v2 settings defaults.
  assert.equal(defaults.platformBaseUrl, 'https://ecard.htwisdom.cn');
  assert.equal(defaults.writebackStatus, false);

  const saved = await store.putSettings('/workspace/a', {
    gitlabProjectPath: 'group/project',
    branchUser: 'zs',
  });
  assert.equal(saved.gitlabProjectPath, 'group/project');
  assert.equal(saved.branchUser, 'zs');
  assert.equal(saved.commitType, 'fix');
  assert.equal(saved.platformBaseUrl, 'https://ecard.htwisdom.cn');
  assert.equal(saved.writebackStatus, false);
  assert.deepEqual(store.getSettings('/workspace/a'), saved);

  assert.deepEqual(domain.table('settings').get('/workspace/a'), saved);
  assert.deepEqual(store.getSettings('/workspace/b'), DEFAULT_SETTINGS);

  const merged = await store.putSettings('/workspace/a', { testCommand: 'npm test' });
  assert.equal(merged.gitlabProjectPath, 'group/project', 'partial updates keep saved fields');
  assert.equal(merged.testCommand, 'npm test');
  assert.deepEqual(store.getSettings('/workspace/a'), merged);

  const toggled = await store.putSettings('/workspace/a', { writebackStatus: true });
  assert.equal(toggled.writebackStatus, true, 'the boolean platform setting is writable');
  assert.equal(toggled.testCommand, 'npm test');
  assert.deepEqual(store.getSettings('/workspace/a'), toggled);
});

test('getSettings() falls back to defaults when the workspace is unknown or empty', () => {
  const domain = createFakeDomain();
  const store = createStore(domain, () => T1);

  for (const cwd of [null, undefined, '', '   ', 42]) {
    assert.deepEqual(store.getSettings(cwd), DEFAULT_SETTINGS);
  }
  assert.equal(domain.table('settings').size, 0);
});

test('putSettings() reports unknown-workspace and invalid-settings as structured errors', async () => {
  const domain = createFakeDomain();
  const store = createStore(domain, () => T1, {
    validateSettings: (settings) => {
      if (settings.gitlabReviewer.length > 10) throw new Error('gitlabReviewer 过长');
      return settings;
    },
  });

  const expectCode = (code) => (error) => {
    assert.equal(error.name, 'StoreError');
    assert.equal(error.code, code);
    return true;
  };

  await assert.rejects(store.putSettings(null, { testCommand: 'npm test' }), expectCode('unknown-workspace'));
  await assert.rejects(store.putSettings('', { testCommand: 'npm test' }), expectCode('unknown-workspace'));
  await assert.rejects(store.putSettings('/workspace/a', null), expectCode('invalid-settings'));
  await assert.rejects(
    store.putSettings('/workspace/a', { branchUser: 42 }),
    expectCode('invalid-settings'),
  );
  await assert.rejects(
    store.putSettings('/workspace/a', { writebackStatus: 'no' }),
    expectCode('invalid-settings'),
  );
  await assert.rejects(
    store.putSettings('/workspace/a', { gitlabReviewer: 'x'.repeat(11) }),
    expectCode('invalid-settings'),
  );
  assert.equal(domain.table('settings').size, 0);
});

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

test('list() orders tickets by createdAt and breaks ties by code', async () => {
  const domain = createFakeDomain();
  const store = createStore(domain, clockFrom(T1, T2, T3));
  await store.create({ code: 'BUG-A' });
  await store.create({ code: 'BUG-B' });
  await store.create({ code: 'BUG-C' });

  // Simulate an out-of-order record (e.g. a clock skew or manual restore).
  const a = domain.table('tickets').get('BUG-A');
  await domain.table('tickets').put('BUG-A', { ...a, createdAt: T4 });
  await seedTicket(domain, initialTicket({ code: 'BUG-D' }, T2));

  assert.deepEqual(
    store.list().map((ticket) => ticket.code),
    ['BUG-B', 'BUG-D', 'BUG-C', 'BUG-A'],
  );
});

test('list() orders createdAt by instant, not by the offset text', async () => {
  const domain = createFakeDomain();
  const store = createStore(domain, () => T1);

  // `08:00+08:00` is 00:00Z — earlier than `02:00Z`, but sorts later as text.
  const early = { ...initialTicket({ code: 'BUG-EARLY' }, T1), createdAt: '2026-11-07T08:00:00+08:00' };
  const late = { ...initialTicket({ code: 'BUG-LATE' }, T1), createdAt: '2026-11-07T02:00:00Z' };
  await seedTicket(domain, late);
  await seedTicket(domain, early);

  assert.deepEqual(store.list().map((ticket) => ticket.code), ['BUG-EARLY', 'BUG-LATE']);
});

// ---------------------------------------------------------------------------
// corrupted records
// ---------------------------------------------------------------------------

test('corrupted ticket records are skipped, counted, and never overwritten', async () => {
  const domain = createFakeDomain();
  const tickets = domain.table('tickets');
  await tickets.put('bad-null', null);
  await tickets.put('bad-shape', { code: 'bad-shape', title: 42 });
  await tickets.put('key-mismatch', initialTicket({ code: 'other' }, T1));
  await seedTicket(domain, initialTicket({ code: 'BUG-OK' }, T1));

  const store = createStore(domain, () => T1);

  assert.deepEqual(store.list().map((ticket) => ticket.code), ['BUG-OK']);
  const snapshot = store.snapshot();
  assert.equal(snapshot.total, 1);
  assert.equal(snapshot.invalid, 3);
  assert.equal(store.get('bad-null'), undefined);
  assert.equal(store.get('bad-shape'), undefined);

  const applied = await store.applyAction('bad-shape', 'start_analysis', {});
  assert.equal(applied.ok, false);
  assert.equal(applied.code, 'invalid-record');

  const recreated = await store.create({ code: 'key-mismatch' });
  assert.equal(recreated.ok, false);
  assert.equal(recreated.code, 'invalid-record');
  assert.equal(tickets.get('key-mismatch').code, 'other', 'corrupted record left untouched');
});
