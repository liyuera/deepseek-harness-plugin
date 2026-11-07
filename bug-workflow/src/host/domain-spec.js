/**
 * Zod schema and domain declaration for `bug_workflow` (v2), reachable from
 * plain Node.
 *
 * `domain.js` imports both `zod` and `@deepseek-ai/dsh-storage-domain` as bare
 * specifiers, which only the DSH host can resolve. The plain-Node test runner
 * (`node --test bug-workflow/test/*.test.js`) cannot, so the schema definitions
 * live here and receive those libraries as parameters:
 *
 *   - `domain.js` passes the host's live `z`/`defineDomain` imports;
 *   - `scripts/verify-domain-v2.mjs` (Electron-as-node) passes the installed
 *     app.asar copies, so the verifier exercises the exact zod instance the
 *     running host uses instead of a stand-in.
 *
 * Nothing in this module may import a bare package: only relative,
 * dependency-free host modules are allowed, which is what keeps
 * `test/domain-v2.test.js` runnable under plain Node.
 *
 * Tables are declared as plain `{ valueSchema }` objects. That is exactly what
 * `domainTable()` returns in the storage-domain package (an identity helper),
 * and using the literal shape keeps `defineDomain` the only host dependency.
 *
 * Versioning policy: see the header of `domain.js`; this module only owns the
 * declaration, not the open lifecycle.
 */

import { STATES } from './protocol.js';
import {
  DEFAULT_SETTINGS,
  META_TABLE,
  SETTINGS_TABLE,
  TICKETS_TABLE,
} from './store.js';
import { withPlatformDefaults } from './ticket-defaults.js';

/** Domain identity. The name must satisfy UNIT_NAME_RE (/^[a-z][a-z0-9_]*$/). */
export const DOMAIN_NAME = 'bug_workflow';
export const DOMAIN_VERSION = 2;
/** Older on-disk versions this schema still accepts (v1 has no source/platform). */
export const COMPATIBLE_VERSIONS = Object.freeze([1]);

/** The 17 platform snapshot fields of the P2 contract, in declaration order. */
export const PLATFORM_FIELDS = Object.freeze([
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
  'projectId',
  'projectName',
  'assigneeId',
  'assigneeName',
  'description',
  'url',
  'syncedAt',
]);

/**
 * Build the record schemas from a zod namespace.
 *
 * @param {{z: object}} deps the zod namespace (`import { z } from 'zod'`)
 * @returns {{platformSchema: object, ticketSchema: object, settingsSchema: object, metaSchema: object, fixRunSchema: object, reviewRoundSchema: object}}
 */
export function buildDomainSchemas({ z } = {}) {
  if (z === null || typeof z !== 'object' || typeof z.looseObject !== 'function') {
    throw new TypeError('buildDomainSchemas({ z }) requires the zod namespace');
  }

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
    // P4 fix-service records where the worktree base came from. Optional so a
    // branch written by an earlier host (or a hand-edited row) still loads.
    baseSource: z.enum(['origin', 'target', 'HEAD']).optional(),
    // P4 fix-service persists the run's worktree path and start timestamp on
    // the branch; the client's MR card renders `worktree`. Declared (bounded)
    // here so tightening this object later cannot silently drop them.
    worktree: z.string().max(4096).optional(),
    createdAt: z.string().max(64).optional(),
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
   * One review-round ledger entry (P5 Task 4). The format is part of the v2
   * ticket metadata (no domain version bump): `patchTicket()` appends entries
   * after a review-fix run. The shape is bounded here and mirrored by the
   * dependency-free `isReviewRoundEntry()` gate in `store.js` (the plain-Node
   * store tests run without zod).
   */
  const reviewRoundSchema = z.looseObject({
    round: z.number().int().nonnegative(),
    noteId: z.union([z.string(), z.number()]),
    verdict: z.enum(['pass', 'changes', 'unknown']),
    startedAt: z.string().min(1).max(64),
    finishedAt: z.string().min(1).max(64),
    changedFiles: z.array(z.string().max(4096)).max(2000),
    status: z.enum(['succeeded', 'failed', 'cancelled']),
    childId: z.string().min(1).max(200).optional(),
  });

  /**
   * One `ticket.fixes[]` entry as written by `fix-service` (P4). This closes
   * the P4 prerequisite that the array was `z.array(z.unknown())`: the host
   * now enforces the run metadata it persists and the snapshot re-sends.
   *
   * Optionality is deliberately lenient for forward/backward compatibility:
   * `diff`/`notes`/`childId`/`elapsedMs`/`error` may be absent, and
   * `looseObject` keeps fields a later P4/P5 run adds. Required fields are the
   * ones every writer has always produced. Bounds are defensive: the writer
   * already clips `diff` to 4 000 characters and free text to 8 000, so a
   * snapshot (polled by the client) can never carry an unbounded patch.
   */
  const fixRunSchema = z.looseObject({
    runId: z.string().min(1).max(200),
    childId: z.string().max(200).optional(),
    startedAt: z.string().min(1).max(64),
    finishedAt: z.string().min(1).max(64),
    changedFiles: z.array(z.string().max(4096)).max(2000),
    diffStat: z.string().max(4000),
    diff: z.string().max(8000).optional(),
    summary: z.string().max(8000),
    testResult: z.string().max(8000),
    notes: z.string().max(8000).optional(),
    error: z.string().max(200).optional(),
    status: z.enum(['succeeded', 'failed', 'cancelled']),
    elapsedMs: z.number().int().nonnegative().optional(),
  });

  /**
   * Platform snapshot carried by a synced ticket (domain v2). It is a
   * point-in-time copy of the platform record, not the local workflow state:
   * `statusKey`/`statusName` describe the platform side, which is deliberately
   * separate from `ticket.workflow` (the local state machine). `project*` and
   * `assignee*` are nullable because the platform can omit them; unknown keys
   * are kept so a future platform field can ride along without a domain bump.
   */
  const platformSchema = z.looseObject({
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
  const ticketSchema = z.looseObject({
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
    fixes: z.array(fixRunSchema),
    // Optional: every ticket written before Task 4 simply has no ledger yet.
    reviewRounds: z.array(reviewRoundSchema).optional(),
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
  const settingsSchema = z.looseObject(
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
  const metaSchema = z.looseObject({
    at: z.number(),
    value: z.unknown(),
  });

  return { platformSchema, ticketSchema, settingsSchema, metaSchema, fixRunSchema, reviewRoundSchema };
}

/**
 * Build the `bug_workflow` v2 domain declaration.
 *
 * @param {object} deps
 * @param {object} deps.z the zod namespace
 * @param {(spec: object) => object} deps.defineDomain the storage-domain helper
 * @param {object} [deps.schemas] prebuilt result of `buildDomainSchemas({ z })`;
 *   `domain.js` passes it so the exported schemas and the spec share one instance
 * @returns {object} the domain spec handed to `storageDomain.open()`
 */
export function buildDomainSpec({ z, defineDomain, schemas } = {}) {
  if (typeof defineDomain !== 'function') {
    throw new TypeError('buildDomainSpec({ defineDomain }) requires the storage-domain defineDomain helper');
  }
  const built = schemas ?? buildDomainSchemas({ z });

  return defineDomain({
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    compatibleVersions: COMPATIBLE_VERSIONS,
    tables: {
      [TICKETS_TABLE]: { valueSchema: built.ticketSchema },
      [SETTINGS_TABLE]: { valueSchema: built.settingsSchema },
      [META_TABLE]: { valueSchema: built.metaSchema },
    },
  });
}

/**
 * Write-forward legacy ticket records after a domain open.
 *
 * A single-layout backend stamps the unit with the current version on the first
 * write, but untouched rows keep their old physical shape. If a future v3 listed
 * only `[2]`, a file containing v1-shaped rows would then fail to open. Running
 * this on every open (idempotently) guarantees that rows behind a v2 stamp are
 * v2-shaped: a row missing either `source` or `platform` is filled with the
 * shared defaults, validated with the real ticket schema and `put` back.
 *
 * `force: true` rewrites every row, including rows that already show the v2
 * fields. The host needs it for the one-time migration: the storage-domain
 * facility validates records with this same schema at open and keeps the
 * PARSED record in memory, so a physically v1 row already reads as
 * `source:'manual', platform:null` through `entries()`. The persisted
 * `migration:tickets-v2` meta marker tells the host when that first physical
 * rewrite still has to happen; afterwards the default (non-forced) pass runs
 * on every open and writes nothing.
 *
 * Records that fail validation, or a failed `put`, reject the open instead of
 * being skipped: tickets are authoritative user data (fail-loud).
 *
 * @param {{table: (name: string) => object}} domain opened (`bug_workflow`) domain
 * @param {(ticket: object) => object} validateTicket schema validator returning
 *   the normalized record (the host passes `ticketSchema.parse`)
 * @param {{force?: boolean}} [options] `force` rewrites already-v2 rows too
 * @returns {Promise<number>} how many records were physically rewritten
 */
export async function normalizeTicketRecords(domain, validateTicket, options = {}) {
  if (domain === null || typeof domain !== 'object' || typeof domain.table !== 'function') {
    throw new TypeError('normalizeTicketRecords(domain) requires an opened storage domain');
  }
  if (typeof validateTicket !== 'function') {
    throw new TypeError('normalizeTicketRecords(domain, validateTicket) requires a validator');
  }
  const force = options?.force === true;

  const tickets = domain.table(TICKETS_TABLE);
  let normalized = 0;

  for (const [key, raw] of tickets.entries()) {
    if (!isPlainObject(raw)) {
      throw new TypeError(`工单 ${String(key)} 的存储记录不是对象，无法归一化`);
    }
    // Already v2-shaped: never rewrite a row that is up to date (idempotence),
    // unless the one-time migration asked for a forced physical rewrite.
    if (!force && raw.source !== undefined && raw.platform !== undefined) continue;

    const checked = validateTicket(withPlatformDefaults(raw));
    if (!isPlainObject(checked)) {
      throw new TypeError(`工单 ${String(key)} 归一化后的记录不是对象`);
    }
    await tickets.put(key, checked);
    normalized += 1;
  }

  return normalized;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
