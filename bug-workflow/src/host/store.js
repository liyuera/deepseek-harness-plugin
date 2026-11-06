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

/** Workspace settings defaults; also the schema key list in `domain.js`. */
export const DEFAULT_SETTINGS = Object.freeze({
  platformBaseUrl: 'https://ecard.htwisdom.cn',
  platformProjectCode: '',
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

  async function create(rawInput) {
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

  async function applyAction(rawCode, action, payload = {}, options = {}) {
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

    if (action === 'create') {
      const input = isPlainObject(payload) ? { ...payload, code } : { code };
      const created = await create(input);
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

  async function putSettings(rawCwd, input) {
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

  return { list, get, snapshot, create, applyAction, getSettings, putSettings };
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

function failure(code, message) {
  return { ok: false, code, message };
}

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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
