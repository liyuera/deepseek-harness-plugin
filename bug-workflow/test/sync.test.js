/**
 * Unit tests for the platform → ticket-store sync engine (P2 Task 4).
 *
 * The engine runs against a scripted fake platform client and the REAL
 * `createStore()` over the in-memory domain double used by the store tests: the
 * merge/preserve logic and the write-boundary validation are the production
 * ones. The platform fixtures are the same `scripts/fixtures/platform/*.json`
 * the mock server serves, so the field mapping is exercised against the P0
 * record shape (list-only fields included).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DEFAULT_SETTINGS, createStore } from '../src/host/store.js';
import {
  LAST_SYNC_AT_KEY,
  LAST_SYNC_ERROR_KEY,
  createSyncService,
  mapDicts,
} from '../src/host/sync.js';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const TASK_FIXTURE = JSON.parse(
  readFileSync(new URL('../scripts/fixtures/platform/tasks.json', import.meta.url), 'utf8'),
);
const DICT_FIXTURE = JSON.parse(
  readFileSync(new URL('../scripts/fixtures/platform/dicts.json', import.meta.url), 'utf8'),
);

const CWD = '/tmp/bug-workflow-sync-workspace';
const BASE_URL = 'http://127.0.0.1:65500';
const PROJECT_CODE = 'YGFNXDJRFWDJSYJJYY';
const STORE_TIME = '2026-11-07T02:00:00.000Z';
const T1 = '2026-11-07T02:00:01.000Z';
const T2 = '2026-11-07T02:00:02.000Z';

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** In-memory Domain double, identical to `store.test.js` (JSON round-trip). */
function createFakeDomain() {
  const tables = new Map();
  return {
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

function clockFrom(...times) {
  let index = 0;
  return () => times[Math.min(index++, times.length - 1)];
}

/**
 * Domain-schema double for the store's injected validator. It mirrors the v2
 * ticket/platform shapes on the fields a sync touches; a validator throws on a
 * violation, which is what the write-boundary contract relies on.
 */
function strictTicket(ticket) {
  if (ticket.source !== 'platform' && ticket.source !== 'manual') {
    throw new Error('source 必须是 platform|manual');
  }
  if (ticket.platform !== null) {
    const p = ticket.platform;
    for (const field of [
      'taskId',
      'taskCode',
      'typeKey',
      'typeName',
      'statusKey',
      'statusName',
      'priorityKey',
      'priorityName',
      'versionKey',
      'versionName',
      'description',
      'url',
    ]) {
      if (typeof p[field] !== 'string') throw new Error(`platform.${field} 必须是字符串`);
    }
    for (const field of ['projectId', 'projectName', 'assigneeId', 'assigneeName']) {
      if (p[field] !== null && typeof p[field] !== 'string') {
        throw new Error(`platform.${field} 必须是字符串或 null`);
      }
    }
    if (!Number.isInteger(p.syncedAt) || p.syncedAt < 0) {
      throw new Error('platform.syncedAt 必须是非负整数');
    }
  }
  if (ticket.mr !== null && !Number.isInteger(ticket.mr.rounds)) {
    throw new Error('mr.rounds 必须是整数');
  }
  return cloneJson(ticket);
}

/**
 * Scripted platform client. The defaults page the given task array exactly like
 * the mock server; individual methods can be overridden per test.
 */
function createFakePlatform({
  tasks = [],
  baseUrl = BASE_URL,
  getUser,
  listMyTasks,
  getDicts,
} = {}) {
  const calls = { user: 0, list: [], dicts: 0 };
  const client = {
    baseUrl,
    async getUser() {
      calls.user += 1;
      if (typeof getUser === 'function') return getUser(calls);
      return { ok: true, data: { id: 10086, name: '李昱' } };
    },
    async listMyTasks(input = {}) {
      calls.list.push(cloneJson(input));
      if (typeof listMyTasks === 'function') return listMyTasks(input, calls);
      const page = input.page ?? 1;
      const size = input.size ?? 20;
      const start = (page - 1) * size;
      return {
        ok: true,
        data: {
          records: tasks.slice(start, start + size),
          total: String(tasks.length),
          size: String(size),
          current: String(page),
        },
      };
    },
    async getDicts() {
      calls.dicts += 1;
      if (typeof getDicts === 'function') return getDicts(calls);
      return { ok: true, data: cloneJson(DICT_FIXTURE) };
    },
  };
  return { client, calls };
}

/** Wire the real store + fake platform + sync service for one test. */
function createSetup(options = {}) {
  const domain = createFakeDomain();
  const store = createStore(domain, () => STORE_TIME, {
    validateTicket: options.validateTicket ?? strictTicket,
  });

  const tasks = options.tasks ?? cloneJson(TASK_FIXTURE);
  const fake = createFakePlatform({
    tasks,
    baseUrl: options.baseUrl ?? BASE_URL,
    ...(options.platform ?? {}),
  });

  const token = options.token === undefined ? 'test-token' : options.token;
  const tokenCalls = { get: 0, present: 0 };
  const tokenStore = {
    async get() {
      tokenCalls.get += 1;
      if (options.tokenGetThrows === true) throw new Error('credentials unavailable');
      return token;
    },
    async set() {},
    async clear() {},
    async present() {
      tokenCalls.present += 1;
      return typeof token === 'string' && token.trim() !== '';
    },
  };

  const settings = {
    ...DEFAULT_SETTINGS,
    platformProjectCode: PROJECT_CODE,
    ...(options.settings ?? {}),
  };
  const factoryCalls = [];
  const settingsCalls = [];
  const sync = createSyncService({
    store,
    tokenStore,
    getSettings: (cwd) => {
      settingsCalls.push(cwd);
      return { ...settings };
    },
    platformClientFor: (receivedSettings, receivedToken) => {
      factoryCalls.push({ settings: receivedSettings, token: receivedToken });
      if (typeof options.platformClientFor === 'function') {
        return options.platformClientFor(receivedSettings, receivedToken);
      }
      return fake.client;
    },
    clock: options.clock ?? clockFrom(T1),
  });

  return { domain, store, sync, fake, tasks, factoryCalls, settingsCalls, tokenCalls };
}

/** A minimal list record for pagination/cap tests. */
function syntheticTask(index) {
  return {
    id: 7000000 + index,
    taskCode: `P-${index}`,
    taskName: `任务 ${index}`,
    taskType: '001_BUG',
    taskTypeName: '缺陷',
    taskStatus: '001_CREATE',
    taskStatusName: '待处理',
    taskPriority: '003_LOW',
    taskPriorityName: '低',
    refHandlePersonId: 10086,
    refHandlePersonName: '李昱',
    refProjectId: 77,
    refProjectName: '示例项目',
    description: '',
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('first run creates platform tickets with mapped display fields and snapshot', async () => {
  const { store, sync, fake, factoryCalls, settingsCalls } = createSetup();

  const result = await sync.run(CWD);

  assert.deepEqual(result, {
    ok: true,
    synced: 2,
    created: 2,
    updated: 0,
    total: 3,
    filtered: 1,
    lastSyncAt: T1,
  });
  assert.deepEqual(settingsCalls, [CWD]);
  assert.equal(factoryCalls.length, 1);
  assert.equal(factoryCalls[0].token, 'test-token');
  assert.equal(factoryCalls[0].settings.platformProjectCode, PROJECT_CODE);
  assert.equal(fake.calls.user, 1);
  assert.deepEqual(fake.calls.list, [
    { assigneeId: '10086', page: 1, size: 100, descs: 'createdTime' },
  ]);

  const ticket = store.get(`${PROJECT_CODE}-647`);
  assert.equal(ticket.source, 'platform');
  assert.equal(ticket.workflow, 'inbox');
  assert.equal(ticket.title, '工单列表筛选后分页显示为空');
  assert.equal(ticket.type, '缺陷');
  assert.equal(ticket.status, '进行中');
  assert.equal(ticket.priority, '高');
  assert.equal(ticket.version, 'V1.2.0');
  assert.equal(ticket.assignee, '李昱');
  assert.equal(
    ticket.url,
    `${BASE_URL}/HT_TEAM/project/${PROJECT_CODE}/issues?issueCode=${PROJECT_CODE}-647`,
  );
  assert.deepEqual(ticket.platform, {
    taskId: '6470001',
    taskCode: `${PROJECT_CODE}-647`,
    typeKey: '001_BUG',
    typeName: '缺陷',
    statusKey: '002_DOING',
    statusName: '进行中',
    priorityKey: '001_HIGH',
    priorityName: '高',
    versionKey: '501',
    versionName: 'V1.2.0',
    projectId: '1001',
    projectName: '星瞰河山一体化平台',
    assigneeId: '10086',
    assigneeName: '李昱',
    description: TASK_FIXTURE[0].description,
    url: ticket.url,
    syncedAt: Date.parse(T1),
  });
  // The third fixture task belongs to another project and was filtered out.
  assert.deepEqual(store.list().map((row) => row.code).sort(), [
    `${PROJECT_CODE}-647`,
    `${PROJECT_CODE}-648`,
  ]);
  assert.equal(store.get('HTSMART-12'), undefined);
});

test('run() stores mapped dictionaries in meta and reports them via status()', async () => {
  const { store, sync } = createSetup();
  assert.deepEqual(store.getDicts(), { status: [], type: [], priority: [] });

  await sync.run(CWD);

  const dicts = store.getDicts();
  assert.deepEqual(
    dicts.status,
    DICT_FIXTURE.teamTaskStatus.map((entry) => ({
      key: entry.dictKey,
      value: entry.dictValue,
      color: entry.color,
    })),
  );
  assert.deepEqual(
    dicts.type,
    DICT_FIXTURE.teamTaskType.map((entry) => ({
      key: entry.dictKey,
      value: entry.dictValue,
      color: entry.color,
    })),
  );
  assert.equal(dicts.priority.length, DICT_FIXTURE.teamTaskPriority.length);
  assert.deepEqual(store.getMeta('platform.dicts'), dicts);
  assert.deepEqual(await sync.status(), {
    tokenPresent: true,
    lastSyncAt: T1,
    lastSyncError: null,
  });
});

test('mapDicts() maps dictKey/dictValue/color and tolerates bad groups', () => {
  const mapped = mapDicts({
    teamTaskStatus: [
      { dictKey: '002_DOING', dictValue: '进行中', color: '#2' },
      { dictKey: '001_CREATE', dictValue: '待处理', color: '#1', sort: 1 },
      { dictValue: '缺少 key', color: '#3' },
    ],
    teamTaskType: 'not-an-array',
  });
  assert.deepEqual(mapped.status, [
    { key: '001_CREATE', value: '待处理', color: '#1' },
    { key: '002_DOING', value: '进行中', color: '#2' },
  ]);
  assert.deepEqual(mapped.type, []);
  assert.deepEqual(mapped.priority, []);
});

test('second run updates display fields but preserves workflow and timeline', async () => {
  const clock = clockFrom(T1, T2);
  const { store, sync, tasks } = createSetup({ clock });

  const first = await sync.run(CWD);
  assert.equal(first.created, 2);

  const advanced = await store.applyAction(
    `${PROJECT_CODE}-647`,
    'start_analysis',
    {},
    { actionId: 'sync-test-advance' },
  );
  assert.equal(advanced.ok, true);
  const before = store.get(`${PROJECT_CODE}-647`);
  assert.equal(before.workflow, 'analyzing');

  tasks[0].taskName = '工单列表筛选后分页显示为空（已更新）';

  const second = await sync.run(CWD);
  assert.deepEqual(second, {
    ok: true,
    synced: 2,
    created: 0,
    updated: 2,
    total: 3,
    filtered: 1,
    lastSyncAt: T2,
  });

  const after = store.get(`${PROJECT_CODE}-647`);
  assert.equal(after.title, '工单列表筛选后分页显示为空（已更新）');
  assert.equal(after.workflow, 'analyzing');
  assert.equal(after.blockedFrom, before.blockedFrom);
  assert.equal(after.blockedReason, before.blockedReason);
  assert.deepEqual(after.plan, before.plan);
  assert.deepEqual(after.mr, before.mr);
  assert.deepEqual(after.fixes, before.fixes);
  assert.deepEqual(after.timeline, before.timeline);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.updatedAt, T2);
  assert.equal(after.platform.syncedAt, Date.parse(T2));
  assert.equal(store.list().length, 2);
});

test('an empty platformProjectCode keeps every record and reports nothing filtered', async () => {
  const { store, sync } = createSetup({ settings: { platformProjectCode: '' } });

  const result = await sync.run(CWD);

  assert.equal(result.ok, true);
  assert.equal(result.synced, 3);
  assert.equal(result.filtered, 0);
  assert.equal(result.total, 3);
  assert.equal(store.list().length, 3);
  // No configured prefix: the URL falls back to the task-code project segment.
  assert.equal(
    store.get('HTSMART-12').url,
    `${BASE_URL}/HT_TEAM/project/HTSMART/issues?issueCode=HTSMART-12`,
  );
});

test('pagination merges every page and respects the reported total', async () => {
  const tasks = Array.from({ length: 130 }, (_, index) => syntheticTask(index + 1));
  const { store, sync, fake } = createSetup({ tasks, settings: { platformProjectCode: '' } });

  const result = await sync.run(CWD);

  assert.equal(result.ok, true);
  assert.equal(result.synced, 130);
  assert.equal(result.created, 130);
  assert.equal(result.total, 130);
  assert.deepEqual(fake.calls.list.map((call) => call.page), [1, 2]);
  assert.equal(store.list().length, 130);
});

// ---------------------------------------------------------------------------
// Configuration / auth failures
// ---------------------------------------------------------------------------

test('a missing token fails with no-platform-token and never calls the platform', async () => {
  const { store, sync, factoryCalls } = createSetup({ token: null });

  const result = await sync.run(CWD);

  assert.deepEqual(result, {
    ok: false,
    code: 'no-platform-token',
    message: '未配置平台 token，请先在设置中保存 token',
  });
  assert.equal(factoryCalls.length, 0);
  assert.equal(store.list().length, 0);
  // A configuration gap is not a failed sync: no error banner is written.
  assert.equal(store.getMeta(LAST_SYNC_ERROR_KEY), undefined);
  assert.deepEqual(await sync.status(), {
    tokenPresent: false,
    lastSyncAt: null,
    lastSyncError: null,
  });
});

test('an unavailable credential service is treated as a missing token', async () => {
  const { sync } = createSetup({ tokenGetThrows: true });

  const result = await sync.run(CWD);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'no-platform-token');
});

test('an invalid platform configuration maps to invalid-platform-config and leaves data alone', async () => {
  const { store, sync } = createSetup({
    platformClientFor: () => {
      throw new Error('平台地址不合法');
    },
  });

  const result = await sync.run(CWD);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-platform-config');
  assert.equal(store.list().length, 0);
  const status = await sync.status();
  assert.equal(status.lastSyncAt, null);
  assert.equal(status.lastSyncError, result.message);
});

test('a 401 switches to platform-unauthorized, changes no data and stores the error', async () => {
  const { store, sync } = createSetup({
    platform: {
      getUser: () => ({
        ok: false,
        code: 'platform-unauthorized',
        status: 401,
        message: '平台鉴权失败，请重新配置 token',
      }),
    },
  });

  const result = await sync.run(CWD);

  assert.deepEqual(result, {
    ok: false,
    code: 'platform-unauthorized',
    message: '平台鉴权失败，请重新配置 token',
  });
  assert.equal(store.list().length, 0);
  assert.deepEqual(store.getDicts(), { status: [], type: [], priority: [] });
  assert.deepEqual(await sync.status(), {
    tokenPresent: true,
    lastSyncAt: null,
    lastSyncError: '平台鉴权失败，请重新配置 token',
  });
});

test('network failures and upstream HTTP envelopes propagate their codes', async () => {
  const network = createSetup({
    platform: {
      getUser: () => ({ ok: false, code: 'platform-network', message: '无法连接平台或请求超时' }),
    },
  });
  const networkResult = await network.sync.run(CWD);
  assert.equal(networkResult.code, 'platform-network');

  const upstream = createSetup({
    platform: {
      listMyTasks: () => ({
        ok: false,
        code: 'platform-http',
        status: 200,
        upstreamCode: 500,
        message: '平台请求失败',
      }),
    },
  });
  const upstreamResult = await upstream.sync.run(CWD);
  assert.equal(upstreamResult.code, 'platform-http');
  assert.equal(upstreamResult.ok, false);
  assert.equal(upstream.store.list().length, 0);
});

test('a dictionary failure aborts before any ticket is written', async () => {
  const { store, sync } = createSetup({
    platform: {
      getDicts: () => ({ ok: false, code: 'platform-bad-response', message: '平台响应结构异常' }),
    },
  });

  const result = await sync.run(CWD);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'platform-bad-response');
  assert.equal(store.list().length, 0);
  assert.equal(store.getMeta(LAST_SYNC_ERROR_KEY), '平台响应结构异常');
});

test('a later successful run clears the previous lastSyncError', async () => {
  let mode = 'unauthorized';
  const { store, sync } = createSetup({
    clock: () => T2,
    platform: {
      getUser: () => (mode === 'unauthorized'
        ? { ok: false, code: 'platform-unauthorized', status: 401, message: '平台鉴权失败，请重新配置 token' }
        : { ok: true, data: { id: 10086 } }),
    },
  });

  const failed = await sync.run(CWD);
  assert.equal(failed.code, 'platform-unauthorized');
  assert.equal((await sync.status()).lastSyncError, '平台鉴权失败，请重新配置 token');

  mode = 'ok';
  const succeeded = await sync.run(CWD);
  assert.equal(succeeded.ok, true);
  assert.deepEqual(await sync.status(), {
    tokenPresent: true,
    lastSyncAt: T2,
    lastSyncError: null,
  });
  assert.equal(store.getMeta(LAST_SYNC_ERROR_KEY), null);
});

// ---------------------------------------------------------------------------
// Write boundary / single flight
// ---------------------------------------------------------------------------

test('write-boundary validation runs before every put and leaves the table untouched', async () => {
  const { store, sync } = createSetup({
    validateTicket: (ticket) => {
      if (ticket.code.endsWith('-648')) throw new Error('simulated schema violation');
      return strictTicket(ticket);
    },
  });

  const result = await sync.run(CWD);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'internal');
  // Both records were merged and validated before the first `put`.
  assert.equal(store.list().length, 0);
  assert.equal(store.getMeta(LAST_SYNC_AT_KEY), undefined);
  assert.equal(typeof store.getMeta(LAST_SYNC_ERROR_KEY), 'string');
});

test('concurrent run() calls for the same cwd coalesce into one sync', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { store, sync, fake } = createSetup({
    platform: {
      getUser: async () => {
        await gate;
        return { ok: true, data: { id: 10086 } };
      },
    },
  });

  const first = sync.run(CWD);
  const second = sync.run(CWD);
  assert.equal(first, second, 'single-flight must return the same promise');

  release();
  const [left, right] = await Promise.all([first, second]);

  assert.deepEqual(left, right);
  assert.equal(left.ok, true);
  assert.equal(fake.calls.user, 1);
  assert.equal(fake.calls.list.length, 1);
  assert.equal(store.list().length, 2);

  // The map is cleaned after settling: a new run starts a new sync.
  const again = await sync.run(CWD);
  assert.equal(again.ok, true);
  assert.equal(fake.calls.user, 2);
});

test('the platform token never lands in tickets, dicts or meta', async () => {
  const { store, sync } = createSetup();
  await sync.run(CWD);

  const persisted = JSON.stringify({
    tickets: store.snapshot(),
    dicts: store.getDicts(),
    meta: {
      lastSyncAt: store.getMeta(LAST_SYNC_AT_KEY),
      lastSyncError: store.getMeta(LAST_SYNC_ERROR_KEY),
    },
  });
  assert.equal(persisted.includes('test-token'), false);
});
