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
 *     `platform` here use `.default()`) and MUST also be written forward on
 *     open: `normalizeTicketRecords()` rewrites every row that lacks the new
 *     fields, so a single-layout write that stamps `unit.version:2` cannot
 *     leave v1-shaped rows behind a v2 stamp. Normalization is idempotent and
 *     runs on every open.
 *   - Keep a version in `compatibleVersions` until every row has been
 *     physically rewritten. Removing it too early makes the next open fail
 *     loud (`version-mismatch`) on a mixed-shape file; for example, a future v3
 *     that lists only `[2]` must never open rows still shaped like v1.
 *   - Every write passes the schema at the write boundary. A partial ticket
 *     must never be `tickets.put(...)`-ed directly: `upsertPlatformRecords`
 *     (Task 4) has to merge with the existing record and validate the merged
 *     result before writing.
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
 * The schema definitions themselves live in `./domain-spec.js`, which receives
 * these imports as parameters so the plain-Node tests and the Electron verifier
 * can rebuild the exact same declaration.
 *
 * The caller owns the returned handle: open once via this module (repeat calls
 * reuse the same promise, including a cached failure) and close it through
 * `closeDomain()` in the owning `ctx.effect` disposer. The facility's
 * single-open-per-name rule means a reloaded fiber can briefly race its
 * predecessor's asynchronous close; `openWithRetry` absorbs that `already-open`
 * window (10 x 100ms).
 */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

import {
  DOMAIN_NAME,
  DOMAIN_VERSION,
  buildDomainSchemas,
  buildDomainSpec,
  normalizeTicketRecords,
} from './domain-spec.js';
import { META_TABLE } from './store.js';

/** Domain identity. The name must satisfy UNIT_NAME_RE (/^[a-z][a-z0-9_]*$/). */
export { COMPATIBLE_VERSIONS, DOMAIN_NAME, DOMAIN_VERSION } from './domain-spec.js';

/** `already-open` retry budget for a fiber that races its predecessor's close. */
const OPEN_ATTEMPTS = 10;
const OPEN_RETRY_MS = 100;

/**
 * One-time marker in the `meta` table. Opening a domain is a pure read; this
 * record is the first write that materializes the backend file (the JSON
 * backend writes on `put` only). It is written once, then read back on every
 * reload, so it doubles as live evidence that records come from disk. When the
 * on-disk marker still carries an older domain version (a migrated file), the
 * marker is refreshed once so `meta` reports the format actually in use.
 */
const DOMAIN_MARKER_KEY = 'domain';

/**
 * Meta key recording the one-time physical write-forward of legacy ticket
 * rows. The storage-domain facility parses every record at open and keeps the
 * parsed value in memory, so a v1 row already reads as v2-shaped through the
 * ticket table (`source`/`platform` filled by the schema defaults). This
 * persisted marker is what distinguishes "the file was written forward" from
 * "the defaults only exist in memory": on the first open without it, every
 * ticket is rewritten (forced); afterwards the idempotent pass writes nothing.
 */
const NORMALIZATION_MARKER_KEY = 'migration:tickets-v2';

const schemas = buildDomainSchemas({ z });

/**
 * Record schemas re-exported for the host write-boundary validators and for
 * tests. They are the exact schemas in `domainSpec`, not copies.
 */
export const { platformSchema, ticketSchema, settingsSchema, metaSchema } = schemas;

/**
 * The single declaration instance shared by every open of this domain. The
 * domain layer calls `valueSchema.parse()` for every stored record at open;
 * an invalid record fails the open with `invalid-record` (fail-loud: tickets
 * and settings are user data, so no `invalidRecords: 'backup-and-skip'`).
 */
export const domainSpec = buildDomainSpec({ z, defineDomain, schemas });

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
 * After the open, legacy rows are written forward to the v2 shape
 * (`normalizeTicketRecords`): the first open after the upgrade forces every
 * ticket to be re-`put` (the storage layer has already applied the schema
 * defaults in memory) and records the fact in meta under
 * `migration:tickets-v2`; later opens take the idempotent pass. The domain
 * marker is refreshed when it still carries an older version. The returned
 * handle reports how many ticket rows were rewritten, so the caller can
 * surface the migration in diagnostics.
 *
 * If `ctx.storageDomain` is unavailable the returned promise rejects with
 * `stage: 'storage-service'`; an open failure rejects with `stage: 'open-domain'`
 * and the underlying domain `code` (`already-open`, `invalid-record`, ...).
 * A failed marker write rejects with `stage: 'init-domain'`; a failed
 * normalization rejects with `stage: 'normalize-tickets'` (fail-loud: a row is
 * never silently dropped). Failures are cached for this fiber: later calls
 * return the same rejection instead of retrying a broken medium on every
 * request.
 *
 * @param ctx context that carries the `storageDomain` facility
 * @returns {Promise<{domain: object, openedAt: number, normalized: number}>}
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

    let normalized = 0;
    try {
      const migrationNeeded = await ticketMigrationNeeded(domain);
      normalized = await normalizeTicketRecords(
        domain,
        (ticket) => ticketSchema.parse(ticket),
        { force: migrationNeeded },
      );
      if (migrationNeeded) await markTicketMigration(domain, normalized);
    } catch (error) {
      // Never leave a half-migrated domain attached to routes: fail the open
      // loud and let the next reload retry from the rows already written.
      await domain.close().catch(() => {});
      throw domainFailure(
        'normalize-tickets',
        `storage domain '${DOMAIN_NAME}' v2 记录归一化失败：${errorMessage(error)}`,
        {
          code: typeof error?.code === 'string' ? error.code : undefined,
          cause: error,
        },
      );
    }

    const openedAt = Date.now();
    domainContexts.set(domain, ctx);
    return { domain, openedAt, normalized };
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

/**
 * Materialize the domain file on first open; later opens only read it back.
 * When the marker exists but records an older domain version (a file written
 * before the v2 bump), rewrite it once so `meta.domain.value.version` matches
 * the format the file now carries. `initializedAt` is preserved.
 */
async function ensureDomainMarker(domain) {
  const meta = domain.table(META_TABLE);
  const existing = meta.get(DOMAIN_MARKER_KEY);

  if (existing !== undefined) {
    const value = isPlainObject(existing?.value) ? existing.value : {};
    if (value.version === DOMAIN_VERSION) return;
    await meta.put(DOMAIN_MARKER_KEY, {
      at: Date.now(),
      value: {
        ...value,
        version: DOMAIN_VERSION,
        upgradedAt: new Date().toISOString(),
      },
    });
    return;
  }

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

/**
 * True when this file still has to be written forward physically (or the
 * migration marker was never written, e.g. a file restored from an older
 * backup). The ticket table itself cannot answer the question: the storage
 * facility kept the schema-parsed record, defaults included, in memory.
 */
async function ticketMigrationNeeded(domain) {
  const meta = domain.table(META_TABLE);
  const record = meta.get(NORMALIZATION_MARKER_KEY);
  const version = isPlainObject(record?.value) ? record.value.version : undefined;
  return version !== DOMAIN_VERSION;
}

/** Persist the migration result so later opens take the idempotent fast path. */
async function markTicketMigration(domain, normalized) {
  const meta = domain.table(META_TABLE);
  await meta.put(NORMALIZATION_MARKER_KEY, {
    at: Date.now(),
    value: {
      version: DOMAIN_VERSION,
      normalized,
      normalizedAt: new Date().toISOString(),
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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
