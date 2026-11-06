/**
 * Storage domain declaration and lifecycle for the Bug workflow plugin.
 *
 * Domain `bug_workflow` (version 2) owns three tables:
 *
 *   tickets   value = persisted Ticket (matches `state-machine.js`)
 *   settings  value = workspace settings keyed by cwd
 *   meta      value = { at, value } ledger for actionId idempotency
 *
 * Versioning policy (domain v2):
 *
 *   - `version` is the current domain format version; `compatibleVersions`
 *     lists older versions whose records this schema still accepts. The JSON
 *     single-layout backend reads a v1 file when v1 is listed, upgrades the
 *     in-memory unit, and stamps the next write as v2.
 *   - An INCOMPATIBLE change (removed/retyped field, new required data that old
 *     rows cannot supply) MUST bump `version` and add the previous version to
 *     `compatibleVersions`; an old version's schema is never edited in place.
 *   - An ADDITIVE-with-defaults change keeps old records readable (`source` and
 *     `platform` here use `.default()`), so it needs no migration code: v1 rows
 *     parse, gain the defaults, and persist them on their next write.
 *   - Schema violations fail loud: `invalidRecords` is deliberately not set to
 *     `'backup-and-skip'`, because tickets and settings are authoritative user
 *     data. A bad record must stop the open with `invalid-record` instead of
 *     silently disappearing.
 *
 * Both `@deepseek-ai/dsh-storage-domain` and `zod` are imported as bare
 * specifiers and declared in the bundle's `peerDependencies`. The running host
 * resolves them from its own installation (`app.asar/dsh/node_modules/...`) and
 * shares that single instance with this plugin, which is what the P0 Spike E
 * findings require. Do not replace these imports with an `app.asar` path or an
 * inline schema: record validation and error identity must stay on the host copy.
 *
 * The caller owns the returned handle: open once via this module (repeat calls
 * reuse the same promise, including a cached failure) and close it through
 * `closeDomain()` in the owning `ctx.effect` disposer. The facility's
 * single-open-per-name rule means a reloaded fiber can briefly race its
 * predecessor's asynchronous close; `openWithRetry` absorbs that `already-open`
 * window (10 x 100ms).
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

import { STATES } from './protocol.js';
import {
  DEFAULT_SETTINGS,
  META_TABLE,
  SETTINGS_TABLE,
  TICKETS_TABLE,
} from './store.js';

/** Domain identity. The name must satisfy UNIT_NAME_RE (/^[a-z][a-z0-9_]*$/). */
export const DOMAIN_NAME = 'bug_workflow';
export const DOMAIN_VERSION = 2;
/** Older on-disk versions this schema still accepts (v1 has no source/platform). */
export const COMPATIBLE_VERSIONS = Object.freeze([1]);

/** `already-open` retry budget for a fiber that races its predecessor's close. */
const OPEN_ATTEMPTS = 10;
const OPEN_RETRY_MS = 100;

/**
 * One-time marker in the `meta` table. Opening a domain is a pure read; this
 * record is the first write that materializes the backend file (the JSON
 * backend writes on `put` only). It is written once, then read back on every
 * reload, so it doubles as live evidence that records come from disk.
 */
const DOMAIN_MARKER_KEY = 'domain';

const nullableString = z.string().nullable();

const timelineEventSchema = z.looseObject({
  at: z.string(),
  kind: z.string(),
  actor: z.enum(['user', 'agent', 'system']),
  message: z.string(),
});

const planSchema = z.looseObject({
  summary: z.string(),
  rootCause: z.string(),
  approach: z.string(),
  changedFiles: z.array(z.string()),
  risks: z.array(z.string()),
  testPlan: z.string(),
  generatedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  rejectedReason: z.string().nullable(),
});

const branchSchema = z.looseObject({
  name: z.string(),
  target: z.string(),
});

const mrSchema = z.looseObject({
  iid: z.union([z.string(), z.number()]).nullable(),
  url: nullableString,
  sourceBranch: nullableString,
  targetBranch: nullableString,
  state: nullableString,
  verdict: nullableString,
  blockingIssues: z.array(z.unknown()),
  nonBlockingIssues: z.array(z.unknown()),
  rounds: z.number().int().nonnegative(),
});

/**
 * Platform snapshot carried by a synced ticket (domain v2). It is a
 * point-in-time copy of the platform record, not the local workflow state:
 * `statusKey`/`statusName` describe the platform side, which is deliberately
 * separate from `ticket.workflow` (the local state machine). `project*` and
 * `assignee*` are nullable because the platform can omit them; unknown keys
 * are kept so a future platform field can ride along without a domain bump.
 */
export const platformSchema = z.looseObject({
  taskId: z.string(),
  taskCode: z.string(),
  typeKey: z.string(),
  typeName: z.string(),
  statusKey: z.string(),
  statusName: z.string(),
  priorityKey: z.string(),
  priorityName: z.string(),
  versionKey: z.string(),
  versionName: z.string(),
  projectId: nullableString,
  projectName: nullableString,
  assigneeId: nullableString,
  assigneeName: nullableString,
  description: z.string(),
  url: z.string(),
  syncedAt: z.number().int().nonnegative(),
});

/** Persisted Ticket. `looseObject` keeps unknown keys so a future field survives a load. */
export const ticketSchema = z.looseObject({
  code: z.string().min(1),
  title: nullableString,
  type: nullableString,
  status: nullableString,
  version: nullableString,
  priority: nullableString,
  assignee: nullableString,
  url: nullableString,
  // Domain v2. Defaults keep v1 records readable and match `withPlatformDefaults`.
  source: z.enum(['platform', 'manual']).default('manual'),
  platform: platformSchema.nullable().default(null),
  workflow: z.enum(STATES),
  blockedFrom: z.enum(STATES).nullable(),
  blockedReason: nullableString,
  plan: planSchema.nullable(),
  branch: branchSchema.nullable(),
  mr: mrSchema.nullable(),
  fixes: z.array(z.unknown()),
  timeline: z.array(timelineEventSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Workspace settings record. Fields default from DEFAULT_SETTINGS so a record
 * written by an older version (or a partial hand edit) still opens: forward
 * compatibility is handled by filling missing keys, not by failing the domain.
 * The value type follows the default (`writebackStatus` is boolean; the rest
 * are strings), which is the same derivation the store uses at its write
 * boundary.
 */
export const settingsSchema = z.looseObject(
  Object.fromEntries(
    Object.entries(DEFAULT_SETTINGS).map(([field, fallback]) => [
      field,
      typeof fallback === 'boolean'
        ? z.boolean().default(fallback)
        : z.string().default(fallback),
    ]),
  ),
);

/** `meta` ledger record: `at` orders eviction, `value` is the stored payload. */
export const metaSchema = z.looseObject({
  at: z.number(),
  value: z.unknown(),
});

/**
 * The single declaration instance shared by every open of this domain. The
 * domain layer calls `valueSchema.parse()` for every stored record at open;
 * an invalid record fails the open with `invalid-record` (fail-loud: tickets
 * and settings are user data, so no `invalidRecords: 'backup-and-skip'`).
 */
export const domainSpec = defineDomain({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  compatibleVersions: COMPATIBLE_VERSIONS,
  tables: {
    [TICKETS_TABLE]: domainTable(ticketSchema),
    [SETTINGS_TABLE]: domainTable(settingsSchema),
    [META_TABLE]: domainTable(metaSchema),
  },
});

/**
 * Per-fiber open promise, so repeated calls reuse one open (or one cached
 * failure) without retrying a broken medium on every request.
 *
 * Keyed by the `ctx.inject(['storageDomain'], ...)` child context, never by the
 * facility: this module's URL is stable, so the host's ESM cache may keep the
 * module (and these maps) alive across host-half reloads while the facility
 * itself is a long-lived singleton. A facility-keyed cache would leak a failed
 * open into the next fiber and make recovery impossible; the child context is
 * fresh per fiber and becomes garbage once that fiber is disposed.
 */
const openStates = new WeakMap();

/** Reverse lookup used by `closeDomain()`; avoids exposing the context on the handle. */
const domainContexts = new WeakMap();

/** Handles already closed through this module; makes repeat closes a no-op. */
const closedDomains = new WeakSet();

/**
 * Open the `bug_workflow` domain once per plugin fiber and return its handle.
 *
 * Pass the child context from `ctx.inject(['storageDomain'], (storageCtx) => ...)`
 * so repeated calls during one `apply` share a single open.
 *
 * If `ctx.storageDomain` is unavailable the returned promise rejects with
 * `stage: 'storage-service'`; an open failure rejects with `stage: 'open-domain'`
 * and the underlying domain `code` (`already-open`, `invalid-record`, ...).
 * Failures are cached for this fiber: later calls return the same rejection
 * instead of retrying a broken medium on every request.
 *
 * @param ctx context that carries the `storageDomain` facility
 * @returns {Promise<{domain: object, openedAt: number}>}
 */
export function openDomain(ctx) {
  const facility = ctx?.storageDomain;
  if (facility === undefined || facility === null || typeof facility.open !== 'function') {
    return Promise.reject(
      domainFailure('storage-service', 'ctx.storageDomain service unavailable'),
    );
  }

  const cached = openStates.get(ctx);
  if (cached !== undefined && cached.pending !== undefined) return cached.pending;

  const state = { pending: undefined };
  openStates.set(ctx, state);

  // `pending` stays assigned on failure, so the rejection is cached and every
  // later call for this fiber returns it instead of retrying a broken medium.
  state.pending = (async () => {
    const domain = await openWithRetry(facility);
    try {
      await ensureDomainMarker(domain);
    } catch (error) {
      // A domain that cannot persist its own marker cannot persist tickets.
      await domain.close().catch(() => {});
      throw domainFailure(
        'init-domain',
        `storage domain '${DOMAIN_NAME}' 初始化记录写入失败：${errorMessage(error)}`,
        {
          code: typeof error?.code === 'string' ? error.code : undefined,
          cause: error,
        },
      );
    }

    const openedAt = Date.now();
    domainContexts.set(domain, ctx);
    return { domain, openedAt };
  })();

  return state.pending;
}

/**
 * Close a handle returned by `openDomain()`. Idempotent: a second call for the
 * same handle (or a handle already closed by the facility fallback) is a no-op,
 * and a later `openDomain()` on a fresh fiber is free to open again.
 *
 * @param handle result of `openDomain()`, or undefined when the open failed
 */
export async function closeDomain(handle) {
  const domain = handle?.domain;
  if (domain === undefined || domain === null) return;
  if (closedDomains.has(domain)) return;
  closedDomains.add(domain);

  const context = domainContexts.get(domain);

  try {
    if (typeof domain.close === 'function') await domain.close();
  } finally {
    domainContexts.delete(domain);
    if (context !== undefined) openStates.delete(context);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Materialize the domain file on first open; later opens only read it back. */
async function ensureDomainMarker(domain) {
  const meta = domain.table(META_TABLE);
  if (meta.get(DOMAIN_MARKER_KEY) !== undefined) return;
  await meta.put(DOMAIN_MARKER_KEY, {
    at: Date.now(),
    value: {
      kind: 'domain-initialized',
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      initializedAt: new Date().toISOString(),
    },
  });
}

async function openWithRetry(facility) {
  let lastError;
  for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt += 1) {
    try {
      return await facility.open(domainSpec);
    } catch (error) {
      lastError = error;
      if (error?.code !== 'already-open' || attempt === OPEN_ATTEMPTS) break;
      await delay(OPEN_RETRY_MS);
    }
  }

  throw domainFailure(
    'open-domain',
    `storage domain '${DOMAIN_NAME}' 打开失败：${errorMessage(lastError)}`,
    {
      code: typeof lastError?.code === 'string' ? lastError.code : undefined,
      cause: lastError,
    },
  );
}

function domainFailure(stage, message, options = {}) {
  const error = new Error(message, options.cause === undefined ? undefined : { cause: options.cause });
  error.name = 'BugWorkflowDomainError';
  error.stage = stage;
  if (options.code !== undefined) error.code = options.code;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
