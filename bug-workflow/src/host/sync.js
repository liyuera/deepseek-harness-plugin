/**
 * Platform → ticket-store sync engine (P2 Task 4).
 *
 * `createSyncService()` is pure over its dependencies, so the plain-Node tests
 * drive it with a fake platform client and the real `createStore()` over a fake
 * domain. `index.js` assembles it with the real platform HTTP client
 * (`src/host/platform.js`) and the credentials-backed token store.
 *
 * One `run(cwd)`:
 *
 *   1. read the platform token (missing → `no-platform-token`, data untouched);
 *   2. read the workspace settings and build a platform client
 *      (`platformClientFor` may throw for an invalid base URL →
 *      `invalid-platform-config`, data untouched);
 *   3. `getUser()` for the platform user id, then page through
 *      `listMyTasks({assigneeId, page, size:100, descs:'createdTime'})` until
 *      `total` records, an empty page, or a hard cap (no infinite loop);
 *   4. fetch the three dictionaries;
 *   5. apply the optional `platformProjectCode` prefix filter
 *      (`<projectCode>-…`); dropped records are reported as `filtered`;
 *   6. map each record to the v2 Ticket shape (`source:'platform'`, display
 *      fields, `platform` snapshot) and merge it through
 *      `store.upsertPlatformRecords()`, which validates at the write boundary
 *      and preserves the existing workflow/plan/mr/fixes/timeline;
 *   7. persist dictionaries (`meta['platform.dicts']`), `lastSyncAt`, and clear
 *      `lastSyncError` on success.
 *
 * Failure policy: `run()` never throws. Every expected failure resolves to
 * `{ok:false, code, message}` with a static, token-free message; the same
 * message is stored in `meta['platform.lastSyncError']` (except
 * `no-platform-token`, which is a configuration gap rather than a failed sync).
 * The routes map `platform-unauthorized` → 401, network/upstream failures →
 * 502, configuration gaps → 400 and anything unexpected → 500. The 2xx failure
 * envelope from `platform.js` keeps `status:200` and adds `upstreamCode`, so
 * the mapping keys off `code`, never off `status`.
 *
 * Single-flight: concurrent `run(cwd)` calls for the same cwd coalesce to one
 * promise (the periodic interval and a manual sync cannot double-write).
 *
 * `importTask(cwd, code)` is the P2 「从平台导入」 path: it validates the code,
 * fetches one detail record (`platformClient.getTask`), maps it with the same
 * mapper `run()` uses, and upserts it through `store.upsertPlatformRecords()`.
 * It deliberately does not write `lastSyncAt`/`lastSyncError` (it is not a
 * sync) and preserves the local workflow of an existing ticket. Failure codes:
 * `invalid-code`/`no-platform-token`/`invalid-platform-config`/upstream codes,
 * all with static, token-free messages.
 *
 * This module must stay dependency-free (relative imports only, no packages)
 * so `node --test` can import it under plain Node.
 */

/** Page size requested from the platform list endpoint. */
export const SYNC_PAGE_SIZE = 100;

/** Hard cap of records synced by one run (10 pages of 100). */
export const SYNC_MAX_TASKS = 1000;

/** Hard cap of list requests per run, independent of a lying `total`. */
export const SYNC_MAX_PAGES = 12;

/** Meta key holding the last successful sync timestamp (ISO 8601 string). */
export const LAST_SYNC_AT_KEY = 'platform.lastSyncAt';

/** Meta key holding the last sync failure message (string) or null. */
export const LAST_SYNC_ERROR_KEY = 'platform.lastSyncError';

/** Longest accepted task code for a by-code import (defensive bound). */
export const IMPORT_CODE_MAX_LENGTH = 128;

/** Accepted task-code characters: project prefix + number, e.g. `ABC-12`. */
const IMPORT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Query sort passed to `listMyTasks`; matches the P0 list contract. */
const SYNC_SORT = 'createdTime';

/** Static, token-free client-visible messages. */
const MESSAGES = Object.freeze({
  'no-platform-token': '未配置平台 token，请先在设置中保存 token',
  'invalid-platform-config': '平台连接配置无效，请检查平台地址设置',
  'platform-unauthorized': '平台鉴权失败，请重新配置 token',
  'platform-network': '无法连接平台或请求超时',
  'platform-http': '平台请求失败，请稍后重试',
  'platform-not-found': '平台接口或资源不存在',
  'platform-bad-response': '平台响应结构异常',
  'invalid-request': '平台请求参数不合法',
  internal: '平台同步失败，请稍后重试',
});

/**
 * Import-specific messages. A 404 here means the platform has no ticket with
 * the requested code (not a missing route), and `invalid-code` is the client's
 * input problem rather than a sync failure.
 */
const IMPORT_MESSAGES = Object.freeze({
  'no-platform-token': MESSAGES['no-platform-token'],
  'invalid-platform-config': MESSAGES['invalid-platform-config'],
  'invalid-code': '工单编号不合法：仅支持字母、数字、点、下划线和短横线，最长 128 字符',
  'platform-unauthorized': MESSAGES['platform-unauthorized'],
  'platform-not-found': '平台没有该工单',
  'platform-network': MESSAGES['platform-network'],
  'platform-http': MESSAGES['platform-http'],
  'platform-bad-response': MESSAGES['platform-bad-response'],
  internal: '平台工单导入失败，请稍后重试',
});

/** Platform-client failure codes copied through to the route layer. */
const UPSTREAM_CODES = new Set([
  'platform-unauthorized',
  'platform-network',
  'platform-http',
  'platform-not-found',
  'platform-bad-response',
  'invalid-request',
]);

/**
 * Create the sync service.
 *
 * @param {object} deps
 * @param {object} deps.store `createStore()` result; needs
 *   `upsertPlatformRecords`, `getDicts`, `setDicts`, `getMeta`, `setMeta` and `get`
 * @param {{get: () => Promise<string|null>, present: () => Promise<boolean>}} deps.tokenStore
 * @param {(cwd: string|null) => object} deps.getSettings workspace settings for a cwd
 * @param {(settings: object, token: string) => object} deps.platformClientFor
 *   builds the platform client; may throw for invalid configuration
 * @param {() => string} deps.clock returns an ISO 8601 timestamp
 * @returns {{
 *   run: (cwd: string|null) => Promise<object>,
 *   importTask: (cwd: string|null, code: string) => Promise<object>,
 *   status: () => Promise<object>,
 * }}
 */
export function createSyncService(deps = {}) {
  if (deps === null || typeof deps !== 'object') {
    throw new TypeError('createSyncService() requires a dependency object');
  }
  const { store, tokenStore, getSettings, platformClientFor, clock } = deps;

  if (store === null || typeof store !== 'object') {
    throw new TypeError('createSyncService() requires a store');
  }
  for (const method of ['upsertPlatformRecords', 'getDicts', 'setDicts', 'getMeta', 'setMeta', 'get']) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(`createSyncService() store.${method} must be a function`);
    }
  }
  if (tokenStore === null || typeof tokenStore !== 'object') {
    throw new TypeError('createSyncService() requires a tokenStore');
  }
  for (const method of ['get', 'present']) {
    if (typeof tokenStore[method] !== 'function') {
      throw new TypeError(`createSyncService() tokenStore.${method} must be a function`);
    }
  }
  if (typeof getSettings !== 'function') {
    throw new TypeError('createSyncService() requires getSettings(cwd)');
  }
  if (typeof platformClientFor !== 'function') {
    throw new TypeError('createSyncService() requires platformClientFor(settings, token)');
  }
  if (typeof clock !== 'function') {
    throw new TypeError('createSyncService() requires clock');
  }

  /** cwd key → in-flight run promise (single-flight per workspace). */
  const inflight = new Map();

  /**
   * Run one sync for a workspace. Concurrent calls with the same cwd share the
   * first promise; other workspaces run independently.
   *
   * @param {string|null} cwd workspace path (null = defaults settings)
   * @returns {Promise<{ok:true, synced:number, created:number, updated:number,
   *   total:number, filtered:number, lastSyncAt:string} |
   *   {ok:false, code:string, message:string}>}
   */
  function run(cwd) {
    const key = typeof cwd === 'string' && cwd.trim() !== '' ? cwd : '';
    const running = inflight.get(key);
    if (running !== undefined) return running;

    const pending = execute(cwd);
    inflight.set(key, pending);
    const cleanup = () => {
      if (inflight.get(key) === pending) inflight.delete(key);
    };
    // Both handlers keep the derived promise settled; execute() resolves by
    // contract, this is only a belt-and-braces guard against a future throw.
    pending.then(cleanup, cleanup);
    return pending;
  }

  /**
   * Snapshot status: whether a token exists plus the persisted last-sync state.
   * Every read is failure-tolerant so the board snapshot cannot be taken down
   * by a missing meta record or a broken credential service.
   *
   * @returns {Promise<{tokenPresent:boolean, lastSyncAt:string|null, lastSyncError:string|null}>}
   */
  async function status() {
    let tokenPresent = false;
    try {
      tokenPresent = (await tokenStore.present()) === true;
    } catch {
      tokenPresent = false;
    }

    let lastSyncAt = null;
    try {
      const value = store.getMeta(LAST_SYNC_AT_KEY);
      if (typeof value === 'string') lastSyncAt = value;
    } catch {
      lastSyncAt = null;
    }

    let lastSyncError = null;
    try {
      const value = store.getMeta(LAST_SYNC_ERROR_KEY);
      if (typeof value === 'string') lastSyncError = value;
    } catch {
      lastSyncError = null;
    }

    return { tokenPresent, lastSyncAt, lastSyncError };
  }

  /**
   * Import one platform ticket by code (P2 「从平台导入」).
   *
   * The code is validated before any platform call, then resolved through
   * `getTask(code)` and mapped with the very same `mapRecordToPlatformTicket()`
   * used by `run()`. The single record is upserted through
   * `store.upsertPlatformRecords([record], now)`, so an existing ticket keeps
   * its local workflow/timeline and a new one starts at `inbox` with
   * `source:'platform'`.
   *
   * Unlike `run()`, an import is not a sync: it never writes
   * `meta['platform.lastSyncAt']` or `meta['platform.lastSyncError']`, so a
   * failed import cannot masquerade as a failed sync in the header.
   *
   * @param {string|null} cwd workspace path (null = defaults settings)
   * @param {string} code platform task code entered by the user
   * @returns {Promise<
   *   {ok:true, ticket:object, created:number, updated:number} |
   *   {ok:false, code:string, message:string}>}
   */
  async function importTask(cwd, code) {
    const taskCode = normalizeImportCode(code);
    if (taskCode === undefined) return importFailure('invalid-code');

    let token;
    try {
      token = await tokenStore.get();
    } catch {
      token = null;
    }
    if (typeof token !== 'string' || token.trim() === '') {
      return importFailure('no-platform-token');
    }

    let settings;
    try {
      settings = await getSettings(cwd);
    } catch {
      return importFailure('internal');
    }
    const safeSettings = isPlainObject(settings) ? settings : {};

    let client;
    try {
      client = platformClientFor(safeSettings, token.trim());
    } catch {
      // `createPlatformClient` throws PlatformError for an invalid baseUrl.
      return importFailure('invalid-platform-config');
    }
    if (!isUsableClient(client, ['getTask'])) {
      return importFailure('invalid-platform-config');
    }

    let detail;
    try {
      detail = await client.getTask(taskCode);
    } catch {
      return importFailure('internal');
    }
    if (!detail?.ok) return importFailure(importUpstreamCode(detail));
    if (!isPlainObject(detail.data)) return importFailure('platform-bad-response');

    let now;
    try {
      now = readNow(clock);
    } catch {
      return importFailure('internal');
    }

    // The detail endpoint is the full record (it also carries `id`); a detail
    // shape may omit taskCode, in which case the requested code identifies it.
    const record = {
      ...detail.data,
      taskCode: textValue(detail.data.taskCode) ?? taskCode,
    };
    const mapped = mapRecordToPlatformTicket(record, {
      baseUrl: pickBaseUrl(client, safeSettings),
      projectCode: textValue(safeSettings.platformProjectCode) ?? '',
      now,
    });
    if (mapped === null) return importFailure('platform-bad-response');

    let counts;
    try {
      counts = await store.upsertPlatformRecords([mapped], now);
    } catch {
      // Covers schema rejection and storage failures: run() does the same and
      // reports a static failure instead of leaking the internal error.
      return importFailure('internal');
    }

    let ticket;
    try {
      ticket = store.get(mapped.code);
    } catch {
      return importFailure('internal');
    }

    return {
      ok: true,
      ticket,
      created: countOf(counts?.created),
      updated: countOf(counts?.updated),
    };
  }

  // -------------------------------------------------------------------------
  // Run pipeline
  // -------------------------------------------------------------------------

  /** Top-level pipeline; converts every unexpected throw into `internal`. */
  async function execute(cwd) {
    let token;
    try {
      token = await tokenStore.get();
    } catch {
      // An unavailable credential service is reported as "no token configured":
      // the snapshot only exposes presence, and sync cannot proceed either way.
      token = null;
    }
    if (typeof token !== 'string' || token.trim() === '') {
      return failure('no-platform-token');
    }

    let settings;
    try {
      settings = await getSettings(cwd);
    } catch {
      return failRecorded('internal');
    }
    const safeSettings = isPlainObject(settings) ? settings : {};

    let client;
    try {
      client = platformClientFor(safeSettings, token.trim());
    } catch {
      // `createPlatformClient` throws PlatformError for an invalid baseUrl.
      return failRecorded('invalid-platform-config');
    }
    if (!isUsableClient(client)) {
      return failRecorded('invalid-platform-config');
    }

    try {
      return await syncWithClient({ settings: safeSettings, client });
    } catch {
      // Never let an unexpected failure escape: the interval and the route both
      // rely on a structured result, and no error detail is needed client-side.
      return failRecorded('internal');
    }
  }

  /** Fetch user/list/dicts, map, then write tickets + metadata. */
  async function syncWithClient({ settings, client }) {
    const user = await client.getUser();
    if (!user?.ok) return failUpstream(user);
    const assigneeId = normalizeId(user.data?.id);
    if (assigneeId === undefined) return failRecorded('platform-bad-response');

    const listed = await listAllTasks(client, assigneeId);
    if (!listed.ok) return listed;

    const dicts = await client.getDicts();
    if (!dicts?.ok) return failUpstream(dicts);

    const projectCode = textValue(settings.platformProjectCode) ?? '';
    const kept = [];
    let filtered = 0;
    for (const record of listed.records) {
      const code = textValue(record?.taskCode);
      if (code === undefined) continue; // unusable record: cannot key a ticket
      if (projectCode !== '' && !code.startsWith(`${projectCode}-`)) {
        filtered += 1;
        continue;
      }
      kept.push({ code, record });
    }

    const now = readNow(clock);
    const baseUrl = pickBaseUrl(client, settings);
    const mapped = kept
      .map(({ record }) => mapRecordToPlatformTicket(record, { baseUrl, projectCode, now }))
      // Kept records always carry a code, so this only guards a future change.
      .filter((ticket) => ticket !== null);

    let counts;
    try {
      counts = await store.upsertPlatformRecords(mapped, now);
    } catch {
      return failRecorded('internal');
    }

    try {
      await store.setDicts(mapDicts(dicts.data));
    } catch {
      return failRecorded('internal');
    }

    try {
      await store.setMeta(LAST_SYNC_AT_KEY, now);
      // Clearing the previous failure is what makes the board banner disappear.
      await store.setMeta(LAST_SYNC_ERROR_KEY, null);
    } catch {
      return failRecorded('internal');
    }

    return {
      ok: true,
      synced: mapped.length,
      created: counts.created,
      updated: counts.updated,
      total: listed.total,
      filtered,
      lastSyncAt: now,
    };
  }

  /**
   * Page through `listMyTasks` until the reported total, an empty page, or the
   * hard cap. The loop is bounded three ways so a lying `total` cannot hang it.
   */
  async function listAllTasks(client, assigneeId) {
    const records = [];
    let total = 0;
    let page = 1;

    while (page <= SYNC_MAX_PAGES) {
      const result = await client.listMyTasks({
        assigneeId,
        page,
        size: SYNC_PAGE_SIZE,
        descs: SYNC_SORT,
      });
      if (!result?.ok) return failUpstream(result);

      const data = isPlainObject(result.data) ? result.data : {};
      const batch = Array.isArray(data.records) ? data.records : [];
      const pageTotal = countValue(data.total);
      if (pageTotal !== undefined) total = pageTotal;

      records.push(...batch);
      if (batch.length === 0) break;
      if (total > 0 && records.length >= total) break;
      if (records.length >= SYNC_MAX_TASKS) break;
      page += 1;
    }

    const capped = records.slice(0, SYNC_MAX_TASKS);
    return { ok: true, records: capped, total: total > 0 ? total : capped.length };
  }

  /** Persist a static failure message (except for the no-token gap). */
  async function failRecorded(code) {
    const message = MESSAGES[code] ?? MESSAGES.internal;
    try {
      await store.setMeta(LAST_SYNC_ERROR_KEY, message);
    } catch {
      // The sync result still reports the failure; the banner is best-effort.
    }
    return { ok: false, code, message };
  }

  /** A platform client failure: copy its known code, otherwise treat as HTTP. */
  async function failUpstream(result) {
    const code = typeof result?.code === 'string' && UPSTREAM_CODES.has(result.code)
      ? result.code
      : 'platform-http';
    return failRecorded(code);
  }

  /** A failure that must not touch the persisted error banner. */
  function failure(code) {
    return { ok: false, code, message: MESSAGES[code] ?? MESSAGES.internal };
  }

  return { run, importTask, status };
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

/**
 * Map one platform record to the v2 Ticket fields understood by
 * `store.upsertPlatformRecords()`. Top-level fields hold the display names the
 * board renders; `platform` keeps the raw keys next to them, because the
 * platform status is deliberately separate from the local workflow.
 *
 * Shared by `run()` (list records) and `importTask()` (detail records): the
 * detail shape also carries `id`, may leave `description` null and may omit
 * list-only fields such as `refProjectName`, all of which map the same way.
 *
 * @param {object} record platform list or detail record
 * @param {{baseUrl: string, projectCode: string, now: string}} options
 *   `now` is an ISO 8601 timestamp; `syncedAt` is stored as epoch milliseconds
 * @returns {object|null} mapped record, or null when the record has no code
 */
function mapRecordToPlatformTicket(record, { baseUrl, projectCode, now } = {}) {
  const code = textValue(record?.taskCode);
  if (code === undefined) return null;
  const url = buildPlatformUrl(baseUrl, projectSegment(projectCode, code), code);
  return {
    code,
    title: textValue(record.taskName) ?? code,
    type: textValue(record.taskTypeName),
    status: textValue(record.taskStatusName),
    version: textValue(record.refVersionUnitName),
    priority: textValue(record.taskPriorityName),
    assignee: textValue(record.refHandlePersonName),
    url,
    source: 'platform',
    platform: {
      taskId: normalizeId(record.id) ?? code,
      taskCode: code,
      typeKey: textValue(record.taskType) ?? '',
      typeName: textValue(record.taskTypeName) ?? '',
      statusKey: textValue(record.taskStatus) ?? '',
      statusName: textValue(record.taskStatusName) ?? '',
      priorityKey: textValue(record.taskPriority) ?? '',
      priorityName: textValue(record.taskPriorityName) ?? '',
      versionKey: normalizeId(record.refVersionUnitId) ?? '',
      versionName: textValue(record.refVersionUnitName) ?? '',
      projectId: normalizeId(record.refProjectId) ?? null,
      projectName: textValue(record.refProjectName) ?? null,
      assigneeId: normalizeId(record.refHandlePersonId) ?? null,
      assigneeName: textValue(record.refHandlePersonName) ?? null,
      description: typeof record.description === 'string' ? record.description : '',
      url,
      syncedAt: Date.parse(now),
    },
  };
}

/**
 * Map the platform dictionary payload to the snapshot/client shape:
 * `{status:[{key,value,color}], type, priority}` from `dictKey`/`dictValue`.
 * Entries are sorted by the platform `sort` when present and invalid groups
 * degrade to an empty array.
 */
export function mapDicts(data) {
  const source = isPlainObject(data) ? data : {};
  return {
    status: mapDictEntries(source.teamTaskStatus),
    type: mapDictEntries(source.teamTaskType),
    priority: mapDictEntries(source.teamTaskPriority),
  };
}

function mapDictEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => isPlainObject(entry) && typeof entry.dictKey === 'string' && entry.dictKey !== '')
    .map((entry) => ({
      key: entry.dictKey,
      value: typeof entry.dictValue === 'string' ? entry.dictValue : '',
      color: typeof entry.color === 'string' ? entry.color : '',
      sort: Number.isFinite(entry.sort) ? entry.sort : Number.MAX_SAFE_INTEGER,
    }))
    .sort((left, right) => left.sort - right.sort)
    .map(({ key, value, color }) => ({ key, value, color }));
}

/** `<baseUrl>/HT_TEAM/project/<projectCode>/issues?issueCode=<code>` */
function buildPlatformUrl(baseUrl, projectCode, code) {
  const origin = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
  if (origin === '') return '';
  const project = encodeURIComponent(projectCode);
  return `${origin}/HT_TEAM/project/${project}/issues?issueCode=${encodeURIComponent(code)}`;
}

/**
 * URL project segment. The configured project code wins for codes that belong
 * to it (the sync is filtered to that prefix). A by-code import may target a
 * ticket from another project, where the task-code prefix is the correct
 * segment; an unprefixed code falls back to the configured project, then ''.
 */
function projectSegment(projectCode, code) {
  const configured = textValue(projectCode);
  if (configured !== undefined && code.startsWith(`${configured}-`)) return configured;
  const dash = code.indexOf('-');
  if (dash > 0) return code.slice(0, dash);
  return configured ?? '';
}

/** Prefer the normalized client base URL (has the trailing slash stripped). */
function pickBaseUrl(client, settings) {
  if (typeof client.baseUrl === 'string' && client.baseUrl.trim() !== '') return client.baseUrl;
  return textValue(settings.platformBaseUrl) ?? '';
}

function isUsableClient(client, methods = ['getUser', 'listMyTasks', 'getDicts']) {
  if (client === null || typeof client !== 'object') return false;
  for (const method of methods) {
    if (typeof client[method] !== 'function') return false;
  }
  return true;
}

function readNow(clock) {
  const value = clock();
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new TypeError('sync clock() 必须返回 ISO 8601 时间字符串');
  }
  return value;
}

function textValue(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function normalizeId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return undefined;
}

function countValue(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/**
 * Trim and validate a user-entered platform code. Only the documented shape
 * (`PROJECT-123`) is sent upstream; anything else is a 400-class input error
 * rather than an upstream request.
 */
function normalizeImportCode(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > IMPORT_CODE_MAX_LENGTH) return undefined;
  if (!IMPORT_CODE_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

/** Static import failure; never writes the sync error banner. */
function importFailure(code) {
  return {
    ok: false,
    code,
    message: IMPORT_MESSAGES[code] ?? IMPORT_MESSAGES.internal,
  };
}

/**
 * Map a platform-client failure to the import error vocabulary. `invalid-request`
 * can only mean the code itself was rejected, so it becomes `invalid-code`
 * (400 at the route) instead of an upstream 502.
 */
function importUpstreamCode(result) {
  const code = typeof result?.code === 'string' ? result.code : 'platform-http';
  if (code === 'invalid-request') return 'invalid-code';
  return UPSTREAM_CODES.has(code) ? code : 'platform-http';
}

/** Non-negative integer count from the store upsert result. */
function countOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
