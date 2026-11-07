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
  normalizePlatformDescription,
} from '../src/host/sync.js';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const TASK_FIXTURE = JSON.parse(
  readFileSync(new URL('../scripts/fixtures/platform/tasks.json', import.meta.url), 'utf8'),
);
const DETAIL_FIXTURE = JSON.parse(
  readFileSync(new URL('../scripts/fixtures/platform/detail.json', import.meta.url), 'utf8'),
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

/**
 * In-memory Domain double, identical to `store.test.js` (JSON round-trip).
 * `beforePut(table, key, value)` is an optional test hook awaited at the start
 * of a `put`, used to pause one sync write deterministically.
 */
function createFakeDomain({ beforePut } = {}) {
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
 * it proves deterministically that a queued write has NOT executed yet.
 */
function flushEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
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
  participantTasks = [],
  baseUrl = BASE_URL,
  getUser,
  listMyTasks,
  listParticipantTasks,
  getTask,
  getDicts,
} = {}) {
  const calls = { user: 0, list: [], participantList: [], task: [], dicts: 0 };
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
    async listParticipantTasks(input = {}) {
      calls.participantList.push(cloneJson(input));
      if (typeof listParticipantTasks === 'function') return listParticipantTasks(input, calls);
      const page = input.page ?? 1;
      const size = input.size ?? 20;
      const start = (page - 1) * size;
      return {
        ok: true,
        data: {
          records: participantTasks.slice(start, start + size),
          total: String(participantTasks.length),
          size: String(size),
          current: String(page),
        },
      };
    },
    async getTask(code) {
      calls.task.push(code);
      if (typeof getTask === 'function') return getTask(code, calls);
      const detail = DETAIL_FIXTURE[code];
      if (detail === undefined) {
        return {
          ok: false,
          code: 'platform-not-found',
          status: 404,
          message: '平台接口或资源不存在',
        };
      }
      return { ok: true, data: cloneJson(detail) };
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
  const domain = options.domain ?? createFakeDomain();
  const store = createStore(domain, () => STORE_TIME, {
    validateTicket: options.validateTicket ?? strictTicket,
  });

  const tasks = options.tasks ?? cloneJson(TASK_FIXTURE);
  const fake = createFakePlatform({
    tasks,
    participantTasks: options.participantTasks ?? [],
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

test('participant-only tasks are merged with handled tasks and deduped by taskCode', async () => {
  // A bug handled by someone else but with the current user as participant
  // (live example: 632 handled by 李伟, participant 李昱) only appears in the
  // participantId view. Duplicates across both lists must collapse to one row.
  const participantOnly = {
    ...syntheticTask(2),
    taskCode: `${PROJECT_CODE}-632`,
    taskName: '精准承保-仅测试环境上传图片后有接口报错',
    taskTypeName: '缺陷',
  };
  const duplicateOfHandled = { ...syntheticTask(3), taskCode: `${PROJECT_CODE}-647` };
  const { store, sync, fake } = createSetup({
    participantTasks: [participantOnly, duplicateOfHandled],
  });

  const result = await sync.run(CWD);

  assert.deepEqual(result, {
    ok: true,
    synced: 3,
    created: 3,
    updated: 0,
    total: 4,
    filtered: 1,
    lastSyncAt: T1,
  });
  assert.deepEqual(fake.calls.participantList, [
    { participantId: '10086', page: 1, size: 100, descs: 'createdTime' },
  ]);
  const participantTicket = store.get(`${PROJECT_CODE}-632`);
  assert.equal(participantTicket.source, 'platform');
  assert.equal(participantTicket.workflow, 'inbox');
  assert.equal(participantTicket.title, participantOnly.taskName);
  // The duplicate did not create a second row and did not touch the handled one.
  assert.equal(store.list().filter((ticket) => ticket.code === `${PROJECT_CODE}-647`).length, 1);
});

test('a participant-list failure aborts the sync before writing tickets', async () => {
  const { store, sync } = createSetup({
    platform: {
      listParticipantTasks: () => ({
        ok: false,
        code: 'platform-http',
        status: 200,
        upstreamCode: 500,
        message: '平台请求失败',
      }),
    },
  });

  const result = await sync.run(CWD);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'platform-http');
  assert.equal(store.list().length, 0);
  assert.deepEqual(await sync.status(), {
    tokenPresent: true,
    lastSyncAt: null,
    lastSyncError: '平台请求失败，请稍后重试',
  });
});

test('normalizePlatformDescription decodes the live percent-encoded rich text', () => {
  // Live shape for a screenshot-only bug report (632): encoded <p><img …>.
  const encoded = encodeURIComponent('<p><img src="/oss/a.png" data-original-name="image.png"></p>');
  assert.equal(normalizePlatformDescription(encoded), '[图片]');
  assert.equal(
    normalizePlatformDescription('%3Cp%3E%E5%A4%8D%E7%8E%B0%E6%AD%A5%E9%AA%A4%3Cbr%3E%E7%AC%AC%E4%BA%8C%E6%AD%A5%3C%2Fp%3E'),
    '复现步骤\n第二步',
  );
  assert.equal(normalizePlatformDescription('纯文本描述'), '纯文本描述');
  assert.equal(normalizePlatformDescription('<p>a &amp; b<br>c</p>'), 'a & b\nc');
  assert.equal(normalizePlatformDescription('<script>alert(1)</script>安全'), '安全');
  assert.equal(normalizePlatformDescription(null), '');
  assert.equal(normalizePlatformDescription(''), '');
});

test('sync fills a missing list description from the detail endpoint once', async () => {
  const encoded = encodeURIComponent('<p><img src="/oss/a.png"></p>');
  const task = { ...TASK_FIXTURE[0], description: null };
  const { store, sync, fake } = createSetup({
    tasks: [task],
    platform: {
      getTask: (code) => ({ ok: true, data: { taskCode: code, description: encoded } }),
    },
  });

  const first = await sync.run(CWD);
  assert.equal(first.ok, true);
  const code = `${PROJECT_CODE}-647`;
  assert.equal(store.get(code).platform.description, '[图片]');
  assert.deepEqual(fake.calls.task, [code]);

  // A second sync reuses the stored description instead of re-fetching detail.
  const second = await sync.run(CWD);
  assert.equal(second.ok, true);
  assert.equal(store.get(code).platform.description, '[图片]');
  assert.deepEqual(fake.calls.task, [code]);
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

test('sync.run() racing a local action preserves the action', async () => {
  const entered = deferred();
  const release = deferred();
  let pauseArmed = false;
  const domain = createFakeDomain({
    beforePut: async (table, key) => {
      if (!pauseArmed || table !== 'tickets' || key !== `${PROJECT_CODE}-647`) return;
      pauseArmed = false;
      entered.resolve();
      await release.promise;
    },
  });
  const clock = clockFrom(T1, T2);
  const { store, sync, tasks } = createSetup({ domain, clock });

  const first = await sync.run(CWD);
  assert.equal(first.created, 2);
  // Make the second upsert observably different from the local ticket state.
  tasks[0].taskName = '工单列表筛选后分页显示为空（已更新）';

  pauseArmed = true;
  const second = sync.run(CWD);
  // The upsert built the merged clones and is now parked on tickets.put(647).
  await entered.promise;

  const action = store.applyAction(`${PROJECT_CODE}-647`, 'start_analysis', {});
  await flushEventLoop();
  assert.equal(
    domain.table('tickets').get(`${PROJECT_CODE}-647`).workflow,
    'inbox',
    'the action must queue behind the paused sync upsert',
  );
  assert.equal(domain.table('tickets').get(`${PROJECT_CODE}-647`).timeline.length, 1);

  release.resolve();
  const [synced, applied] = await Promise.all([second, action]);

  assert.equal(synced.ok, true);
  assert.equal(synced.updated, 2);
  assert.equal(applied.ok, true);
  const ticket = domain.table('tickets').get(`${PROJECT_CODE}-647`);
  assert.equal(ticket.title, '工单列表筛选后分页显示为空（已更新）');
  assert.equal(ticket.platform.syncedAt, Date.parse(T2));
  assert.equal(ticket.workflow, 'analyzing', 'the sync must not resurrect the pre-action clone');
  assert.equal(ticket.timeline.length, 2);
  assert.equal(ticket.timeline[1].kind, 'start_analysis');
  // The action's write is the last one: the sync's own metadata still lands.
  assert.equal(store.getMeta(LAST_SYNC_AT_KEY), T2);
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
// By-code import
// ---------------------------------------------------------------------------

const IMPORT_CODE = `${PROJECT_CODE}-647`;

test('importTask() maps the platform detail into a platform ticket with its url', async () => {
  const { store, sync, fake, factoryCalls, settingsCalls } = createSetup();

  const result = await sync.importTask(CWD, IMPORT_CODE);

  assert.equal(result.ok, true);
  assert.equal(result.created, 1);
  assert.equal(result.updated, 0);
  assert.deepEqual(settingsCalls, [CWD]);
  assert.equal(factoryCalls.length, 1);
  assert.equal(factoryCalls[0].token, 'test-token');
  // A by-code import never lists tasks or fetches dictionaries.
  assert.equal(fake.calls.user, 0);
  assert.equal(fake.calls.list.length, 0);
  assert.equal(fake.calls.dicts, 0);
  assert.deepEqual(fake.calls.task, [IMPORT_CODE]);

  const ticket = result.ticket;
  assert.equal(ticket.code, IMPORT_CODE);
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
    `${BASE_URL}/HT_TEAM/project/${PROJECT_CODE}/issues?issueCode=${IMPORT_CODE}`,
  );
  assert.deepEqual(ticket.platform, {
    taskId: '6470001',
    taskCode: IMPORT_CODE,
    typeKey: '001_BUG',
    typeName: '缺陷',
    statusKey: '002_DOING',
    statusName: '进行中',
    priorityKey: '001_HIGH',
    priorityName: '高',
    versionKey: '501',
    versionName: 'V1.2.0',
    // The detail fixture intentionally lacks the list-only refProjectName.
    projectId: '1001',
    projectName: null,
    assigneeId: '10086',
    assigneeName: '李昱',
    description: DETAIL_FIXTURE[IMPORT_CODE].description,
    url: ticket.url,
    syncedAt: Date.parse(T1),
  });
  assert.deepEqual(store.get(IMPORT_CODE), ticket);
  assert.deepEqual(store.list().map((row) => row.code), [IMPORT_CODE]);
  // An import is not a sync: it must not fabricate last-sync metadata.
  assert.equal(store.getMeta(LAST_SYNC_AT_KEY), undefined);
  assert.equal(store.getMeta(LAST_SYNC_ERROR_KEY), undefined);
  assert.equal(JSON.stringify(ticket).includes('test-token'), false);
});

test('importTask() upserts an existing ticket and preserves its local workflow', async () => {
  const { store, sync } = createSetup({ clock: clockFrom(T2) });
  const created = await store.applyAction(
    IMPORT_CODE,
    'create',
    { title: '本地手工工单' },
    { actionId: 'import-existing-create' },
  );
  assert.equal(created.ok, true);
  const advanced = await store.applyAction(
    IMPORT_CODE,
    'start_analysis',
    {},
    { actionId: 'import-existing-advance' },
  );
  assert.equal(advanced.ok, true);
  const before = store.get(IMPORT_CODE);
  assert.equal(before.source, 'manual');
  assert.equal(before.workflow, 'analyzing');

  const result = await sync.importTask(CWD, IMPORT_CODE);

  assert.equal(result.ok, true);
  assert.equal(result.created, 0);
  assert.equal(result.updated, 1);
  const after = store.get(IMPORT_CODE);
  assert.equal(after.source, 'platform');
  assert.equal(after.workflow, 'analyzing');
  assert.deepEqual(after.timeline, before.timeline);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.title, '工单列表筛选后分页显示为空');
  assert.equal(after.updatedAt, T2);
  assert.equal(after.platform.syncedAt, Date.parse(T2));
  assert.equal(store.list().length, 1);
});

test('importTask() uses the task-code project in the url when it is outside the sync filter', async () => {
  const { store, sync } = createSetup();

  const result = await sync.importTask(CWD, 'HTSMART-12');

  assert.equal(result.ok, true);
  assert.equal(result.ticket.source, 'platform');
  assert.equal(
    result.ticket.url,
    `${BASE_URL}/HT_TEAM/project/HTSMART/issues?issueCode=HTSMART-12`,
  );
  assert.equal(store.get('HTSMART-12').source, 'platform');
});

test('importTask() trims the code and tolerates a detail record without taskCode', async () => {
  const { store, sync, fake } = createSetup({
    platform: {
      getTask: () => ({ ok: true, data: { id: 9001, taskName: '无编号详情' } }),
    },
  });

  const result = await sync.importTask(CWD, '  ABC-77  ');

  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls.task, ['ABC-77']);
  assert.equal(result.ticket.code, 'ABC-77');
  assert.equal(result.ticket.source, 'platform');
  assert.equal(result.ticket.platform.taskId, '9001');
  assert.equal(store.get('ABC-77').title, '无编号详情');
});

test('importTask() rejects blank, overlong and unsafe codes before calling the platform', async () => {
  const { store, sync, factoryCalls } = createSetup();

  for (const code of ['', '   ', 'x'.repeat(129), 'BAD CODE', 'BAD/CODE', 'BAD\nCODE', 42, null, undefined]) {
    const result = await sync.importTask(CWD, code);
    assert.equal(result.ok, false, String(code));
    assert.equal(result.code, 'invalid-code', String(code));
  }

  assert.equal(factoryCalls.length, 0);
  assert.equal(store.list().length, 0);
});

test('importTask() without a token fails with no-platform-token and touches nothing', async () => {
  const { store, sync, factoryCalls } = createSetup({ token: null });

  const result = await sync.importTask(CWD, IMPORT_CODE);

  assert.deepEqual(result, {
    ok: false,
    code: 'no-platform-token',
    message: '未配置平台 token，请先在设置中保存 token',
  });
  assert.equal(factoryCalls.length, 0);
  assert.equal(store.list().length, 0);
  assert.equal(store.getMeta(LAST_SYNC_AT_KEY), undefined);
  assert.equal(store.getMeta(LAST_SYNC_ERROR_KEY), undefined);
});

test('importTask() maps an invalid platform configuration to invalid-platform-config', async () => {
  const { store, sync } = createSetup({
    platformClientFor: () => {
      throw new Error('平台地址不合法');
    },
  });

  const result = await sync.importTask(CWD, IMPORT_CODE);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-platform-config');
  assert.equal(store.list().length, 0);
  assert.equal(store.getMeta(LAST_SYNC_ERROR_KEY), undefined);
});

test('importTask() maps an upstream 401 to platform-unauthorized', async () => {
  const { store, sync } = createSetup({
    platform: {
      getTask: () => ({
        ok: false,
        code: 'platform-unauthorized',
        status: 401,
        message: '平台鉴权失败，请重新配置 token',
      }),
    },
  });

  const result = await sync.importTask(CWD, IMPORT_CODE);

  assert.deepEqual(result, {
    ok: false,
    code: 'platform-unauthorized',
    message: '平台鉴权失败，请重新配置 token',
  });
  assert.equal(store.list().length, 0);
});

test('importTask() maps an unknown task code to platform-not-found', async () => {
  const { store, sync } = createSetup();

  const result = await sync.importTask(CWD, 'UNKNOWN-999');

  assert.deepEqual(result, {
    ok: false,
    code: 'platform-not-found',
    message: '平台没有该工单',
  });
  assert.equal(store.list().length, 0);
});

test('importTask() maps a malformed detail response to platform-bad-response', async () => {
  const failures = createSetup({
    platform: {
      getTask: () => ({ ok: false, code: 'platform-bad-response', message: '平台响应结构异常' }),
    },
  });
  const failed = await failures.sync.importTask(CWD, IMPORT_CODE);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'platform-bad-response');
  assert.equal(failures.store.list().length, 0);

  // An `ok` result whose data is not a detail object is equally unusable.
  const notAnObject = createSetup({
    platform: { getTask: () => ({ ok: true, data: null }) },
  });
  const malformed = await notAnObject.sync.importTask(CWD, IMPORT_CODE);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'platform-bad-response');
  assert.equal(notAnObject.store.list().length, 0);
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
