/**
 * Persistent ticket store for the Bug workflow plugin.
 *
 * The store is the only writer of the `bug_workflow` storage domain. It keeps
 * three tables:
 *
 *   tickets   key = ticket code, value = persisted Ticket
 *   settings  key = workspace cwd, value = workspace settings
 *   meta      key = `action:<actionId>`, value = { at, value: { action, code, result } }
 *
 * `meta` is the idempotency ledger for the host action route: the first
 * successful result of an `actionId` is persisted and replayed verbatim on a
 * retry. Failed actions are deliberately NOT memoized — a rerun after the
 * ticket state changed should be re-evaluated by the state machine. The ledger
 * keeps at most `MAX_ACTION_RESULTS` (500) entries per domain and evicts the
 * oldest on write; `meta` is bounded so the single-file JSON backend does not
 * grow without limit.
 *
 * This module is pure logic + domain adapter and must stay importable with no
 * runtime dependencies: the unit tests run under plain Node, where zod/the
 * storage-domain package are not resolvable. Record schemas for on-open
 * validation live in `domain.js`; the host passes their `parse` functions in as
 * `validateTicket`/`validateSettings` so every write is checked against the
 * exact schema the domain uses on open. Without that check a state-machine
 * output with a wrong-typed payload field could be persisted and fail loud on
 * the next reload, making the domain (and the board) unopenable.
 *
 * Error contract: `create()`/`applyAction()` return
 * `{ ok: false, code, message }` for expected failures (invalid input, invalid
 * payload, duplicate code, unknown ticket, illegal transition, corrupted
 * record). StateError from the state machine is mapped this way; anything else
 * is a programming or storage failure and is rethrown. `putSettings()` throws a
 * `StoreError` with `code: 'unknown-workspace'` when the caller has no
 * workspace path and `code: 'invalid-settings'` when the record fails the
 * domain settings schema; Task 3 maps those to HTTP responses.
 *
 * Write serialization (P2 whole-branch review): every mutating public method
 * runs its whole read-modify-write inside one in-process queue (`withWrite`).
 * Without it, a platform sync/import that read an existing ticket and parked on
 * `tickets.put()` could overwrite a local action that landed in between: the
 * action's `workflow`/`timeline` would silently revert to the stale clone (the
 * reviewer reproduced exactly that). Reads stay lock-free against the domain's
 * synchronous in-memory tables. The queue serializes one store instance, i.e.
 * one host process; two processes writing the same storage file are still
 * last-write-wins (DSH desktop is a single host process).
 */

import {
  STATES,
  StateError,
  apply,
  initialTicket,
} from './state-machine.js';
import { withPlatformDefaults } from './ticket-defaults.js';

/**
 * Structured error thrown by store APIs that cannot return a result object
 * (currently only `putSettings()`). `code` is stable; callers should branch on
 * it rather than on the message.
 */
export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

/** Table names of the `bug_workflow` domain; shared with `domain.js`. */
export const TICKETS_TABLE = 'tickets';
export const SETTINGS_TABLE = 'settings';
export const META_TABLE = 'meta';

/** Meta key prefix of a persisted action result. */
export const ACTION_KEY_PREFIX = 'action:';

/** Upper bound of persisted action results (oldest evicted first). */
export const MAX_ACTION_RESULTS = 500;

/** Meta key holding the mapped platform dictionaries (Task 4). */
export const PLATFORM_DICTS_KEY = 'platform.dicts';

/**
 * Ticket fields `patchTicket()` is allowed to change. P4 needed the git
 * branch/worktree metadata and the fix-run ledger; P5 adds the delivery
 * metadata (`mr`) and the review-round ledger (`reviewRounds`). Every workflow
 * transition still goes through `applyAction()`/the state machine.
 */
export const PATCHABLE_TICKET_FIELDS = Object.freeze([
  'branch',
  'fixes',
  'mr',
  'reviewRounds',
]);

/** Dictionary groups exposed by `/snapshot`; every group is always an array. */
export const DICT_GROUPS = Object.freeze(['status', 'type', 'priority']);

/** Ticket fields a platform sync is allowed to overwrite on an existing row. */
const SYNCED_TICKET_FIELDS = Object.freeze([
  'title',
  'type',
  'status',
  'version',
  'priority',
  'assignee',
  'url',
]);

/** Workspace settings defaults; also the schema key list in `domain.js`. */
export const DEFAULT_SETTINGS = Object.freeze({
  platformBaseUrl: 'https://ecard.htwisdom.cn',
  platformProjectCode: '',
  // P5 GitLab API root. Added without a domain bump: the settings schema is a
  // looseObject built from this object, so an older row without the key reads
  // the default here and on open.
  gitlabBaseUrl: 'https://git.htwisdom.cn',
  gitlabProjectPath: '',
  branchUser: 'ly',
  gitlabReviewer: '',
  commitType: 'fix',
  lintCommand: '',
  testCommand: '',
  devCommand: '',
  previewUrl: '',
  writebackStatus: false,
});

/** Ticket fields accepted from `create()` input; everything else is ignored. */
const CREATE_FIELDS = Object.freeze([
  'title',
  'type',
  'status',
  'version',
  'priority',
  'assignee',
  'url',
]);

/**
 * Create the ticket store for an already opened domain.
 *
 * Reads are synchronous against the domain's in-memory tables (the KvTable
 * contract); writes resolve after the backend persisted the record.
 *
 * @param domain opened `Domain` handle of `bug_workflow`
 * @param clock returns an ISO 8601 timestamp; injected by tests
 * @param options optional write-boundary validators from `domain.js`:
 *   `validateTicket(ticket)` / `validateSettings(settings)` return the record
 *   to persist (or throw on a schema violation). The host passes the domain's
 *   real zod `parse` functions; tests pass equivalent doubles. Omitting them
 *   keeps the legacy behaviour and is only meant for fake domains.
 * @returns TicketStore
 */
export function createStore(domain, clock = defaultClock, options = {}) {
  if (domain === null || typeof domain !== 'object' || typeof domain.table !== 'function') {
    throw new TypeError('createStore(domain) requires an opened storage domain');
  }
  if (typeof clock !== 'function') {
    throw new TypeError('createStore(domain, clock) requires clock to be a function');
  }
  if (options === null || typeof options !== 'object') {
    throw new TypeError('createStore(domain, clock, options) requires options to be an object');
  }

  const { validateTicket, validateSettings } = options;
  if (validateTicket !== undefined && typeof validateTicket !== 'function') {
    throw new TypeError('createStore() options.validateTicket must be a function');
  }
  if (validateSettings !== undefined && typeof validateSettings !== 'function') {
    throw new TypeError('createStore() options.validateSettings must be a function');
  }

  const tickets = domain.table(TICKETS_TABLE);
  const settingsTable = domain.table(SETTINGS_TABLE);
  const metaTable = domain.table(META_TABLE);

  // Oldest-first actionIds currently persisted in `meta`, rebuilt on each plugin
  // load so the cap survives host-half reloads. Corrupted ledger entries are
  // treated as oldest and pruned naturally rather than blocking the store.
  const actionOrder = readActionOrder(metaTable);

  /**
   * In-process write queue: one promise-chain tail shared by every mutating
   * method. KvTable reads are synchronous but `put`/`delete` are asynchronous,
   * so two interleaved read-modify-writes can each build a clone from the same
   * old row and the later `put` silently wins. Platform sync/import does
   * exactly this shape (read ticket → await put), which is how a local action
   * could be overwritten after the sync started. Keeping the whole method
   * (including the actionId ledger check and write) on the tail makes the
   * operations atomic with respect to each other, in call order.
   *
   * A rejected write must not wedge the chain: the tail handed to the next
   * write is always a fulfilled promise, while the rejected caller still
   * receives its own rejection from the returned promise.
   */
  let writeTail = Promise.resolve();

  function withWrite(fn) {
    const result = writeTail.then(() => fn());
    writeTail = result.then(noop, noop);
    return result;
  }

  /**
   * Read the raw persisted ticket for `code` with a minimal shape check. A
   * record that fails the check is reported instead of silently treated as
   * absent, so a corrupted row can never be overwritten by `create()`.
   */
  function readTicket(code) {
    const raw = tickets.get(code);
    if (raw === undefined) return { ok: false, reason: 'missing' };
    if (!isStoredTicket(raw, code)) return { ok: false, reason: 'invalid' };
    return { ok: true, ticket: raw };
  }

  /** Scan the whole table, clone valid tickets, sort by createdAt then code. */
  function scan() {
    const found = [];
    let invalid = 0;
    for (const [key, value] of tickets.entries()) {
      if (isStoredTicket(value, key)) found.push(value);
      else invalid += 1;
    }
    found.sort(compareTickets);
    return { tickets: found.map(cloneTicket), invalid };
  }

  /**
   * Check the exact object about to be persisted. `isStoredTicket` is the
   * dependency-free structural pre-check; the host-supplied domain schema parse
   * is the authority and returns the normalized record. Never call this after
   * a write: a rejected ticket must leave the stored state and ledger intact.
   */
  function checkTicket(ticket) {
    if (!isPlainObject(ticket) || !isStoredTicket(ticket, ticket.code)) {
      return failure('invalid-payload', '工单数据不符合持久化结构');
    }
    if (validateTicket === undefined) return { ok: true, ticket };
    try {
      const parsed = validateTicket(ticket);
      return { ok: true, ticket: isPlainObject(parsed) ? parsed : ticket };
    } catch (error) {
      return failure('invalid-payload', `工单数据未通过校验：${errorMessage(error)}`);
    }
  }

  /** Validate the merged settings record with the domain schema before put. */
  function checkSettings(settings) {
    if (validateSettings === undefined) return settings;
    try {
      const parsed = validateSettings(settings);
      return isPlainObject(parsed) ? parsed : settings;
    } catch (error) {
      throw new StoreError('invalid-settings', `settings 未通过校验：${errorMessage(error)}`);
    }
  }

  function list() {
    return scan().tickets;
  }

  function get(code) {
    const key = normalizeCode(code);
    if (key === undefined) return undefined;
    const found = readTicket(key);
    return found.ok ? cloneTicket(found.ticket) : undefined;
  }

  function snapshot() {
    const { tickets: rows, invalid } = scan();
    return { tickets: rows, total: rows.length, invalid };
  }

  /**
   * Create a manual ticket. Queued: the duplicate check and the put are one
   * critical section, so two racing creates cannot both pass the check.
   *
   * @param {object} rawInput ticket fields; `code` is required
   * @returns {Promise<{ok:true, ticket:object} | {ok:false, code:string, message:string}>}
   */
  function create(rawInput) {
    return withWrite(() => createUnlocked(rawInput));
  }

  async function createUnlocked(rawInput) {
    const input = isPlainObject(rawInput) ? rawInput : undefined;
    if (input === undefined) return failure('invalid-input', '工单数据必须是对象');

    const code = normalizeCode(input.code);
    if (code === undefined) return failure('invalid-input', '工单编号不能为空');

    for (const field of CREATE_FIELDS) {
      const value = input[field];
      if (value !== undefined && value !== null && typeof value !== 'string') {
        return failure('invalid-input', `工单字段 ${field} 必须是字符串`);
      }
    }

    const existing = readTicket(code);
    if (existing.ok) return failure('duplicate-code', `工单 ${code} 已存在`);
    if (existing.reason === 'invalid') {
      return failure('invalid-record', `工单 ${code} 的存储记录损坏，请人工检查`);
    }

    const at = readNow(clock);
    // Domain v2: every created ticket states its provenance explicitly. The
    // defaults live in a dependency-free module so the plain-Node tests cover
    // them; the zod schema declares the same fallbacks for v1 records at open.
    const ticket = withPlatformDefaults(initialTicket({ ...pickCreateFields(input), code }, at));
    // A ticket without a title is unusable on the board; fall back to the code.
    if (typeof ticket.title !== 'string' || ticket.title.trim() === '') {
      ticket.title = code;
    }

    const checked = checkTicket(ticket);
    if (!checked.ok) return checked;

    await tickets.put(code, checked.ticket);
    return { ok: true, ticket: cloneTicket(checked.ticket) };
  }

  /**
   * Apply one state-machine action to an existing ticket, optionally
   * idempotent through `options.actionId`. Queued as a whole: the ledger
   * lookup, the ticket read, the transition, the put and the ledger write are
   * one critical section, so a retry racing the original replay sees the first
   * persisted result instead of running the state machine twice.
   *
   * `options.expectedWorkflow` is an optimistic concurrency guard for callers
   * that must not regress a ticket which advanced while they were deciding.
   * It is checked AFTER the queued function starts, i.e. against the ticket as
   * it is when this action's turn arrives — never against an earlier
   * lock-free read. On mismatch the call returns `{ok:false,
   * code:'stale-workflow'}` without writing the ticket or the action ledger.
   * A replayed `actionId` still returns its persisted result (that transition
   * already happened), so idempotent retries keep working.
   *
   * @param {string} rawCode ticket code
   * @param {string} action protocol action
   * @param {object} [payload] action payload
   * @param {{actionId?:string, expectedWorkflow?:string}} [options] idempotency key
   *   and optional in-queue workflow guard
   * @returns {Promise<{ok:true, ticket:object} | {ok:false, code:string, message:string}>}
   */
  function applyAction(rawCode, action, payload = {}, options = {}) {
    return withWrite(() => applyActionUnlocked(rawCode, action, payload, options));
  }

  async function applyActionUnlocked(rawCode, action, payload = {}, options = {}) {
    const code = normalizeCode(rawCode);
    if (code === undefined) return failure('invalid-input', '工单编号不能为空');

    let actionId;
    if (options !== undefined && options !== null && options.actionId !== undefined) {
      actionId = normalizeActionId(options.actionId);
      if (actionId === undefined) {
        return failure('invalid-input', 'actionId 必须是非空字符串');
      }
      const cached = readActionResult(metaTable, actionId, code, action);
      if (cached !== undefined) {
        // A retry must replay the same ticket+action; reusing an id for another
        // request is a client bug and must not leak the first ticket's result.
        if (cached.reused === true) {
          return failure(
            'action-id-reused',
            `actionId ${actionId} 已用于工单 ${String(cached.code)} 的动作 ${String(cached.action)}`,
          );
        }
        return cached.result;
      }
    }

    let expectedWorkflow;
    if (options !== undefined && options !== null && options.expectedWorkflow !== undefined) {
      expectedWorkflow = normalizeCode(options.expectedWorkflow);
      if (expectedWorkflow === undefined) {
        return failure('invalid-input', 'expectedWorkflow 必须是非空字符串');
      }
    }

    if (action === 'create') {
      const input = isPlainObject(payload) ? { ...payload, code } : { code };
      // Already inside this call's critical section: never re-enter withWrite()
      // (the promise chain would wait on itself and deadlock).
      const created = await createUnlocked(input);
      if (created.ok && actionId !== undefined) {
        await rememberActionResult(actionId, code, action, created);
      }
      return created;
    }

    const found = readTicket(code);
    if (!found.ok) {
      return found.reason === 'invalid'
        ? failure('invalid-record', `工单 ${code} 的存储记录损坏，请人工检查`)
        : failure('not-found', `工单 ${code} 不存在`);
    }

    // The guard MUST live inside the queue: a caller that read the ticket
    // outside the lock may have seen an older workflow. Returning before
    // `apply()` leaves both the ticket and the ledger untouched.
    if (expectedWorkflow !== undefined && found.ticket.workflow !== expectedWorkflow) {
      return failure(
        'stale-workflow',
        `工单 ${code} 已不在 ${expectedWorkflow} 状态（当前 ${found.ticket.workflow}）`,
      );
    }

    let next;
    try {
      next = apply(found.ticket, action, payload, readNow(clock));
    } catch (error) {
      if (isStateError(error)) return failure(error.code, error.message);
      throw error;
    }

    const checked = checkTicket(next);
    if (!checked.ok) return checked;

    await tickets.put(code, checked.ticket);
    const result = { ok: true, ticket: cloneTicket(checked.ticket) };
    if (actionId !== undefined) {
      await rememberActionResult(actionId, code, action, result);
    }
    return result;
  }

  /**
   * Patch whitelisted metadata fields of an existing ticket (P4/P5).
   *
   * `fix-service` owns the ticket lifecycle, but `branch`/`fixes` are not a
   * state transition: they are git worktree metadata and the fix-run ledger.
   * This method is the only supported way to persist them, so they still pass
   * the write queue and the domain schema. P5 extends the same mechanism to
   * `mr` and `reviewRounds`. Everything else (workflow, plan, blocked fields,
   * ...) must go through `applyAction()`.
   *
   * Queued as a whole: the actionId replay check, ticket read, expected
   * workflow guard, merge and put are one critical section. Unknown fields are
   * rejected before any state is read, `checkTicket()` validates the merged
   * record BEFORE the put (a schema-invalid patch leaves the stored ticket and
   * the action ledger untouched), `updatedAt` is bumped and exactly one static
   * timeline event is appended:
   *
   *   branch present      -> kind `worktree`, actor `system`
   *   else fixes present  -> kind `fix-run`,  actor `agent`
   *   else (mr/rounds)    -> kind `patch`,    actor `system`
   *
   * When several fields are present the call is still one event; the order is
   * `branch` > `fixes` > `patch`. This is what stops an `mr`-only delivery
   * patch from claiming "AI 修复已执行".
   *
   * @param {string} rawCode ticket code
   * @param {{branch?: object|null, fixes?: object[], mr?: object|null,
   *   reviewRounds?: object[]}} patch whitelisted fields (`fixes` entries and
   *   `mr` are validated by the domain `ticketSchema` at the write boundary,
   *   i.e. the injected `checkTicket()` validator)
   * @param {{actionId?: string, expectedWorkflow?: string}} [options]
   *   idempotency key and optional in-queue workflow guard (same semantics as
   *   `applyAction()`; a stale guard writes neither the ticket nor the ledger)
   * @returns {Promise<{ok:true, ticket:object} | {ok:false, code:string, message:string}>}
   */
  function patchTicket(rawCode, patch, options = {}) {
    return withWrite(() => patchTicketUnlocked(rawCode, patch, options));
  }

  async function patchTicketUnlocked(rawCode, patch, options = {}) {
    const code = normalizeCode(rawCode);
    if (code === undefined) return failure('invalid-input', '工单编号不能为空');

    let actionId;
    if (options !== undefined && options !== null && options.actionId !== undefined) {
      actionId = normalizeActionId(options.actionId);
      if (actionId === undefined) {
        return failure('invalid-input', 'actionId 必须是非空字符串');
      }
      const cached = readActionResult(metaTable, actionId, code, 'patch');
      if (cached !== undefined) {
        if (cached.reused === true) {
          return failure(
            'action-id-reused',
            `actionId ${actionId} 已用于工单 ${String(cached.code)} 的动作 ${String(cached.action)}`,
          );
        }
        return cached.result;
      }
    }

    let expectedWorkflow;
    if (options !== undefined && options !== null && options.expectedWorkflow !== undefined) {
      expectedWorkflow = normalizeCode(options.expectedWorkflow);
      if (expectedWorkflow === undefined) {
        return failure('invalid-input', 'expectedWorkflow 必须是非空字符串');
      }
    }

    if (!isPlainObject(patch)) return failure('invalid-input', 'patch 必须是普通对象');
    const fields = Object.keys(patch);
    if (fields.length === 0) return failure('invalid-input', 'patch 至少包含一个字段');
    for (const field of fields) {
      // Checking every key (not just the known ones) makes an attempt to patch
      // `workflow`/`plan` an explicit error instead of a silent no-op.
      if (!PATCHABLE_TICKET_FIELDS.includes(field)) {
        return failure(
          'invalid-input',
          'patchTicket 只允许修改 branch、fixes、mr 与 reviewRounds',
        );
      }
      if (patch[field] === undefined) {
        return failure('invalid-input', 'patch 字段不能为 undefined');
      }
    }
    if (patch.fixes !== undefined && !Array.isArray(patch.fixes)) {
      return failure('invalid-input', 'fixes 必须是数组');
    }
    if (patch.branch !== undefined && patch.branch !== null && !isPlainObject(patch.branch)) {
      return failure('invalid-input', 'branch 必须是普通对象或 null');
    }
    if (patch.mr !== undefined && patch.mr !== null && !isPlainObject(patch.mr)) {
      return failure('invalid-input', 'mr 必须是普通对象或 null');
    }
    if (patch.reviewRounds !== undefined) {
      if (!Array.isArray(patch.reviewRounds)) {
        return failure('invalid-input', 'reviewRounds 必须是对象数组');
      }
      if (!patch.reviewRounds.every(isReviewRoundEntry)) {
        return failure('invalid-input', 'reviewRounds 条目字段不合法');
      }
    }

    const found = readTicket(code);
    if (!found.ok) {
      return found.reason === 'invalid'
        ? failure('invalid-record', `工单 ${code} 的存储记录损坏，请人工检查`)
        : failure('not-found', `工单 ${code} 不存在`);
    }

    if (expectedWorkflow !== undefined && found.ticket.workflow !== expectedWorkflow) {
      return failure(
        'stale-workflow',
        `工单 ${code} 已不在 ${expectedWorkflow} 状态（当前 ${found.ticket.workflow}）`,
      );
    }

    const at = readNow(clock);
    const next = cloneTicket(found.ticket);
    for (const field of fields) next[field] = structuredClone(patch[field]);
    next.updatedAt = at;
    // Exactly one timeline event per patch. Order: branch (worktree created) >
    // fixes (AI run recorded) > patch (delivery metadata update). An `mr`-only
    // patch must never look like a fix run.
    let event;
    if (Object.prototype.hasOwnProperty.call(patch, 'branch')) {
      event = { kind: 'worktree', actor: 'system', message: '已创建个人分支与工作树' };
    } else if (Object.prototype.hasOwnProperty.call(patch, 'fixes')) {
      event = { kind: 'fix-run', actor: 'agent', message: 'AI 修复已执行' };
    } else {
      event = { kind: 'patch', actor: 'system', message: '交付信息已更新' };
    }
    next.timeline = [
      ...(Array.isArray(next.timeline) ? next.timeline : []),
      { at, ...event },
    ];

    const checked = checkTicket(next);
    if (!checked.ok) return checked;

    await tickets.put(code, checked.ticket);
    const result = { ok: true, ticket: cloneTicket(checked.ticket) };
    if (actionId !== undefined) {
      await rememberActionResult(actionId, code, 'patch', result);
    }
    return result;
  }

  async function rememberActionResult(actionId, code, action, result) {
    const key = ACTION_KEY_PREFIX + actionId;
    const at = parseTicketTimestamp(result.ticket) ?? Date.now();
    await metaTable.put(key, { at, value: { action, code, result } });

    const previous = actionOrder.indexOf(actionId);
    if (previous >= 0) actionOrder.splice(previous, 1);
    actionOrder.push(actionId);
    while (actionOrder.length > MAX_ACTION_RESULTS) {
      const evicted = actionOrder.shift();
      await metaTable.delete(ACTION_KEY_PREFIX + evicted);
    }
  }

  function getSettings(rawCwd) {
    const cwd = normalizeCwd(rawCwd);
    // A session without a working directory still needs a readable board.
    if (cwd === undefined) return { ...DEFAULT_SETTINGS };
    return mergeSettings(settingsTable.get(cwd));
  }

  /**
   * Persist workspace settings. Queued: the merge-from-current read and the put
   * are one critical section, so two concurrent partial updates cannot drop
   * each other's field.
   *
   * @param {string} rawCwd workspace cwd
   * @param {object} input settings fields to merge over the stored record
   * @returns {Promise<object>} the persisted settings
   * @throws {StoreError} `unknown-workspace` / `invalid-settings`
   */
  function putSettings(rawCwd, input) {
    return withWrite(() => putSettingsUnlocked(rawCwd, input));
  }

  async function putSettingsUnlocked(rawCwd, input) {
    const cwd = normalizeCwd(rawCwd);
    if (cwd === undefined) {
      // Task 3 maps this to its "workspace not resolved" HTTP response.
      throw new StoreError('unknown-workspace', '无法确定工作区路径，settings 未保存');
    }
    if (!isPlainObject(input)) {
      throw new StoreError('invalid-settings', 'settings 必须是普通对象');
    }

    const next = mergeSettings(settingsTable.get(cwd));
    for (const field of Object.keys(DEFAULT_SETTINGS)) {
      const value = input[field];
      if (value === undefined) continue;
      const expected = settingsFieldType(field);
      if (typeof value !== expected) {
        throw new StoreError(
          'invalid-settings',
          `settings.${field} 必须是${expected === 'boolean' ? '布尔值' : '字符串'}`,
        );
      }
      next[field] = value;
    }

    const validated = checkSettings(next);
    await settingsTable.put(cwd, validated);
    return structuredClone(validated);
  }

  /**
   * Merge platform-synced records into the ticket table (P2 Task 4).
   *
   * Each record carries `{ code, title, type, status, version, priority,
   * assignee, url, source:'platform', platform }` where `platform` is the
   * domain-v2 snapshot. An existing ticket keeps its local workflow state
   * (`workflow`, `blockedFrom`, `blockedReason`, `plan`, `branch`, `mr`,
   * `fixes`, `timeline`, `createdAt`) and only the display fields plus
   * `platform` are refreshed. A new ticket starts at `inbox` through
   * `initialTicket()`. Every merged record is validated with the injected
   * `validateTicket` BEFORE any `put`, so a schema-invalid sync result cannot
   * leave a partially updated table behind. Duplicate codes in one batch are
   * collapsed last-wins.
   *
   * @param {object[]} records mapped platform records
   * @param {string} [now] ISO 8601 timestamp for `updatedAt`/`createdAt`
   * @returns {Promise<{created: number, updated: number}>}
   * @throws {StoreError} `invalid-input` for malformed batches, `invalid-payload`
   *   when a merged record fails the domain schema
   */
  function upsertPlatformRecords(records, now) {
    return withWrite(() => upsertPlatformRecordsUnlocked(records, now));
  }

  async function upsertPlatformRecordsUnlocked(records, now) {
    if (!Array.isArray(records)) {
      throw new StoreError('invalid-input', '平台同步记录必须是数组');
    }
    const at = now === undefined ? readNow(clock) : normalizeTimestamp(now);

    // Dedupe by code: the same ticket must never be counted as both created and
    // updated in one run.
    const byCode = new Map();
    for (const raw of records) {
      if (!isPlainObject(raw)) {
        throw new StoreError('invalid-input', '平台同步记录必须是对象');
      }
      const code = normalizeCode(raw.code);
      if (code === undefined) {
        throw new StoreError('invalid-input', '平台同步记录缺少工单编号');
      }
      if (!isPlainObject(raw.platform)) {
        throw new StoreError('invalid-payload', `工单 ${code} 缺少平台快照`);
      }
      byCode.set(code, raw);
    }

    const pending = [];
    let created = 0;
    let updated = 0;

    for (const [code, record] of byCode) {
      const existing = readTicket(code);
      if (existing.reason === 'invalid') {
        throw new StoreError('invalid-record', `工单 ${code} 的存储记录损坏，请人工检查`);
      }

      let next;
      if (existing.ok) {
        next = cloneTicket(existing.ticket);
        for (const field of SYNCED_TICKET_FIELDS) {
          if (record[field] !== undefined) next[field] = record[field];
        }
        next.source = 'platform';
        next.platform = record.platform;
        next.updatedAt = at;
        updated += 1;
      } else {
        next = withPlatformDefaults(
          initialTicket(
            {
              code,
              ...pickSyncedFields(record),
            },
            at,
          ),
        );
        next.source = 'platform';
        next.platform = record.platform;
        created += 1;
      }

      // A board ticket without a display title is unusable; the platform name
      // normally wins, the code is only the last-resort fallback.
      if (typeof next.title !== 'string' || next.title.trim() === '') next.title = code;

      const checked = checkTicket(next);
      if (!checked.ok) throw new StoreError(checked.code, checked.message);
      pending.push([code, checked.ticket]);
    }

    for (const [code, ticket] of pending) {
      await tickets.put(code, ticket);
    }

    return { created, updated };
  }

  /**
   * Read one `meta` record's value. Meta rows are `{ at, value }` envelopes;
   * the raw envelope never leaves the store. Corrupted entries count as absent.
   *
   * @param {string} key meta key
   * @returns {unknown} the stored value, or undefined
   */
  function getMeta(key) {
    if (typeof key !== 'string' || key.trim() === '') return undefined;
    const record = metaTable.get(key);
    return isPlainObject(record) ? record.value : undefined;
  }

  /**
   * Persist one `meta` value. `at` orders eviction for the action ledger and is
   * irrelevant for the platform status keys; wall-clock `Date.now()` is enough.
   *
   * @param {string} key non-empty meta key
   * @param {unknown} value JSON-safe value (`null` clears a stored error)
   */
  function setMeta(key, value) {
    return withWrite(() => setMetaUnlocked(key, value));
  }

  async function setMetaUnlocked(key, value) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new StoreError('invalid-input', 'meta key 必须是非空字符串');
    }
    await metaTable.put(key, { at: Date.now(), value });
    return value;
  }

  /**
   * Mapped platform dictionaries for the board filters. Always returns all
   * three groups as arrays, so the snapshot/client never special-cases a
   * missing dictionary.
   *
   * @returns {{status: object[], type: object[], priority: object[]}}
   */
  function getDicts() {
    return normalizeDicts(getMeta(PLATFORM_DICTS_KEY));
  }

  /** Validate and persist the mapped dictionaries; returns the normalized copy. */
  function setDicts(dicts) {
    return withWrite(() => setDictsUnlocked(dicts));
  }

  async function setDictsUnlocked(dicts) {
    const normalized = normalizeDicts(dicts);
    // Queued write calling the unlocked meta writer: never re-enter withWrite()
    // from inside a critical section.
    await setMetaUnlocked(PLATFORM_DICTS_KEY, normalized);
    return normalized;
  }

  return {
    list,
    get,
    snapshot,
    create,
    applyAction,
    patchTicket,
    getSettings,
    putSettings,
    upsertPlatformRecords,
    getMeta,
    setMeta,
    getDicts,
    setDicts,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default clock: wall-clock ISO 8601 UTC, matching state-machine timestamps. */
function defaultClock() {
  return new Date().toISOString();
}

function readNow(clock) {
  let at;
  try {
    at = clock();
  } catch (error) {
    throw new TypeError(`clock() 调用失败：${errorMessage(error)}`, { cause: error });
  }
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
    throw new TypeError('clock() 必须返回 ISO 8601 时间字符串');
  }
  return at;
}

/** Best-effort numeric timestamp of a ticket, used only for the meta ledger order. */
function parseTicketTimestamp(ticket) {
  if (!isPlainObject(ticket)) return undefined;
  for (const field of ['updatedAt', 'createdAt']) {
    const value = ticket[field];
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return undefined;
}

/**
 * Minimal persisted-ticket invariant. The domain's zod schema is the primary
 * gate at open; this check protects the store from records that bypassed it
 * (hand-edited JSON, a future schema change, a fake domain in tests).
 */
function isStoredTicket(value, key) {
  if (!isPlainObject(value)) return false;
  if (typeof value.code !== 'string' || value.code.length === 0) return false;
  if (value.code !== key) return false;
  if (!STATES.includes(value.workflow)) return false;
  if (value.title !== null && typeof value.title !== 'string') return false;
  if (!Array.isArray(value.timeline)) return false;
  if (!Array.isArray(value.fixes)) return false;
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') return false;
  return true;
}

function compareTickets(a, b) {
  const byCreatedAt = compareTimestamps(a.createdAt, b.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  return a.code.localeCompare(b.code);
}

/**
 * Compare two stored timestamps as instants, not as text: an injected clock may
 * emit different UTC offsets, and `08:00+08:00` is earlier than `02:00Z` even
 * though its text sorts later. Unparseable values fall back to a stable string
 * comparison so corrupt records still have a deterministic order.
 */
function compareTimestamps(a, b) {
  const left = typeof a === 'string' ? Date.parse(a) : Number.NaN;
  const right = typeof b === 'string' ? Date.parse(b) : Number.NaN;
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Rebuild the ledger order from the persisted meta table (oldest first). */
function readActionOrder(metaTable) {
  const entries = [];
  for (const [key, value] of metaTable.entries()) {
    if (typeof key !== 'string' || !key.startsWith(ACTION_KEY_PREFIX)) continue;
    const actionId = key.slice(ACTION_KEY_PREFIX.length);
    if (actionId === '') continue;
    const at = isPlainObject(value) && Number.isFinite(value.at) ? value.at : 0;
    entries.push({ actionId, at });
  }
  entries.sort((a, b) => a.at - b.at);
  return entries.map((entry) => entry.actionId);
}

/**
 * Replay a persisted successful result, but only for the same ticket+action.
 * Corrupted ledger entries count as a miss; a valid entry for another request
 * is reported as reused so the caller can answer `action-id-reused`.
 */
function readActionResult(metaTable, actionId, code, action) {
  const record = metaTable.get(ACTION_KEY_PREFIX + actionId);
  if (!isPlainObject(record) || !isPlainObject(record.value)) return undefined;
  const { code: storedCode, action: storedAction, result } = record.value;
  if (!isPlainObject(result) || result.ok !== true || !isPlainObject(result.ticket)) {
    return undefined;
  }
  if (storedCode !== code || storedAction !== action) {
    return { reused: true, code: storedCode, action: storedAction };
  }
  return { reused: false, result: structuredClone(result) };
}

/** Fill every declared settings field from `raw`, falling back to the defaults. */
function mergeSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS };
  if (isPlainObject(raw)) {
    for (const field of Object.keys(DEFAULT_SETTINGS)) {
      const value = raw[field];
      if (typeof value === settingsFieldType(field)) merged[field] = value;
    }
  }
  return merged;
}

/**
 * Runtime type of one declared settings field, derived from its default:
 * domain v2 adds the boolean `writebackStatus`, everything else stays a string.
 * The matching zod schema in `domain.js` uses the same derivation, so the store
 * boundary and the on-open schema cannot disagree about a field's type.
 */
function settingsFieldType(field) {
  return typeof DEFAULT_SETTINGS[field] === 'boolean' ? 'boolean' : 'string';
}

function normalizeCode(code) {
  if (typeof code !== 'string') return undefined;
  const trimmed = code.trim();
  return trimmed === '' ? undefined : trimmed;
}

function normalizeActionId(actionId) {
  if (typeof actionId !== 'string') return undefined;
  const trimmed = actionId.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Resolve the workspace settings key. `undefined` means "no workspace": reads
 * fall back to defaults, writes reject with `unknown-workspace`.
 */
function normalizeCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return undefined;
  return cwd;
}

function pickCreateFields(input) {
  const picked = {};
  for (const field of CREATE_FIELDS) {
    if (typeof input[field] === 'string') picked[field] = input[field];
  }
  return picked;
}

/** Same projection for a synced platform record (`null` stays `null`). */
function pickSyncedFields(record) {
  const picked = {};
  for (const field of SYNCED_TICKET_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' || value === null) picked[field] = value;
  }
  return picked;
}

/** Validate an injected "now" timestamp; the store only persists ISO strings. */
function normalizeTimestamp(value) {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  throw new StoreError('invalid-input', 'now 必须是 ISO 8601 时间字符串');
}

/**
 * Normalize a `{status,type,priority}` dictionary map to the snapshot shape.
 * Unknown groups are dropped, non-array groups become empty, and every entry is
 * reduced to `{key,value,color}` with string values. Missing dictionaries are
 * NOT an error: the board simply shows no filter options.
 */
function normalizeDicts(raw) {
  const normalized = { status: [], type: [], priority: [] };
  if (!isPlainObject(raw)) return normalized;

  for (const group of DICT_GROUPS) {
    const entries = raw[group];
    if (!Array.isArray(entries)) continue;
    normalized[group] = entries
      .filter((entry) => isPlainObject(entry) && typeof entry.key === 'string' && entry.key !== '')
      .map((entry) => ({
        key: entry.key,
        value: typeof entry.value === 'string' ? entry.value : '',
        color: typeof entry.color === 'string' ? entry.color : '',
      }));
  }
  return normalized;
}

function failure(code, message) {
  return { ok: false, code, message };
}

/** Settle-handler used to keep the write queue tail fulfilled after a rejection. */
function noop() {}

function cloneTicket(ticket) {
  return structuredClone(ticket);
}

function isStateError(error) {
  return error instanceof StateError
    || (error !== null && typeof error === 'object' && error.name === 'StateError' && typeof error.code === 'string');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * `reviewRounds` is the review-run ledger (P5 Task 4): one entry per review
 * round, appended by `patchTicket()` after the review-fix run. The domain
 * `ticketSchema` models the same shape (`domain-spec.js`); keep both in sync.
 * This dependency-free check is the store's write-boundary gate so a malformed
 * patch is rejected even when no domain validator is injected (fake domains).
 */
const REVIEW_ROUND_VERDICTS = new Set(['pass', 'changes', 'unknown']);
const REVIEW_ROUND_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const REVIEW_ROUND_TEXT_MAX = 64;
const REVIEW_ROUND_CHILD_ID_MAX = 200;
const REVIEW_ROUND_CHANGED_FILES_MAX = 2_000;
const REVIEW_ROUND_FILE_MAX = 4_096;

/**
 * One review-round entry: `{round int>=0, noteId number|string, verdict
 * 'pass'|'changes'|'unknown', startedAt, finishedAt, changedFiles string[],
 * status 'succeeded'|'failed'|'cancelled', childId?}` with bounded strings and
 * arrays. Anything else would poison the board/retry logic after write.
 *
 * @param {unknown} entry
 * @returns {boolean}
 */
export function isReviewRoundEntry(entry) {
  if (!isPlainObject(entry)) return false;
  if (!Number.isSafeInteger(entry.round) || entry.round < 0) return false;
  if (typeof entry.noteId === 'number') {
    if (!Number.isFinite(entry.noteId)) return false;
  } else if (typeof entry.noteId !== 'string') {
    return false;
  }
  if (!REVIEW_ROUND_VERDICTS.has(entry.verdict)) return false;
  if (!isBoundedText(entry.startedAt, REVIEW_ROUND_TEXT_MAX)) return false;
  if (!isBoundedText(entry.finishedAt, REVIEW_ROUND_TEXT_MAX)) return false;
  if (!Array.isArray(entry.changedFiles)) return false;
  if (entry.changedFiles.length > REVIEW_ROUND_CHANGED_FILES_MAX) return false;
  if (!entry.changedFiles.every((file) => typeof file === 'string' && file.length <= REVIEW_ROUND_FILE_MAX)) {
    return false;
  }
  if (!REVIEW_ROUND_STATUSES.has(entry.status)) return false;
  if (
    entry.childId !== undefined
    && !isBoundedText(entry.childId, REVIEW_ROUND_CHILD_ID_MAX)
  ) {
    return false;
  }
  return true;
}

/** Non-empty string with a length cap (timestamps/ids). */
function isBoundedText(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
