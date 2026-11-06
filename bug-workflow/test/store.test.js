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

/** Minimal in-memory `Domain` double; mirrors the KvTable surface exactly. */
function createFakeDomain() {
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
        get: (key) => records.get(key),
        put: async (key, value) => {
          records.set(key, value);
        },
        delete: async (key) => records.delete(key),
        entries: () => records.entries(),
        keys: () => records.keys(),
        get size() {
          return records.size;
        },
        update: async (key, fn) => {
          const next = fn(records.get(key));
          records.set(key, next);
          return next;
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

  const persisted = domain.table('tickets').get('BUG-1');
  assert.deepEqual(persisted, created.ticket);

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

// ---------------------------------------------------------------------------
// applyAction: transitions, persistence, structured errors
// ---------------------------------------------------------------------------

test('applyAction() persists the next ticket and advances updatedAt', async () => {
  const domain = createFakeDomain();
  const store = createStore(domain, clockFrom(T1, T2, T3));
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
// settings
// ---------------------------------------------------------------------------

test('getSettings() returns defaults until putSettings() writes a workspace record', async () => {
  const domain = createFakeDomain();
  const store = createStore(domain, () => T1);

  const defaults = store.getSettings('/workspace/a');
  assert.deepEqual(defaults, DEFAULT_SETTINGS);
  assert.notEqual(defaults, DEFAULT_SETTINGS, 'callers must not receive the shared default object');

  const saved = await store.putSettings('/workspace/a', {
    gitlabProjectPath: 'group/project',
    branchUser: 'zs',
  });
  assert.equal(saved.gitlabProjectPath, 'group/project');
  assert.equal(saved.branchUser, 'zs');
  assert.equal(saved.commitType, 'fix');
  assert.deepEqual(store.getSettings('/workspace/a'), saved);

  assert.deepEqual(domain.table('settings').get('/workspace/a'), saved);
  assert.deepEqual(store.getSettings('/workspace/b'), DEFAULT_SETTINGS);

  const merged = await store.putSettings('/workspace/a', { testCommand: 'npm test' });
  assert.equal(merged.gitlabProjectPath, 'group/project', 'partial updates keep saved fields');
  assert.equal(merged.testCommand, 'npm test');
  assert.deepEqual(store.getSettings('/workspace/a'), merged);
});

test('settings reject invalid input and missing workspace keys', async () => {
  const domain = createFakeDomain();
  const store = createStore(domain, () => T1);

  await assert.rejects(
    () => store.putSettings('/workspace/a', { branchUser: 42 }),
    TypeError,
  );
  await assert.rejects(() => store.putSettings('/workspace/a', null), TypeError);
  assert.throws(() => store.getSettings(''), TypeError);
  assert.throws(() => store.getSettings(undefined), TypeError);
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
