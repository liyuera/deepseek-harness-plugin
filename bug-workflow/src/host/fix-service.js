/**
 * Fix orchestration service for the Bug workflow plugin (P4 Task 2).
 *
 * The service owns 「开始修复」: it prepares a personal branch in an isolated
 * worktree, delegates the actual code change to the injected fix runner, then
 * persists the run metadata and advances the ticket. It is pure orchestration
 * over `{store, runner, git, getSettings, clock}` — no Cordis, no storage
 * backend, no bare imports — so the plain-Node test runner can drive a real
 * store over a fake domain and a fake git executor.
 *
 * Contracts (P4 plan + Task 2 brief):
 *
 *   - One fix per ticket: a duplicate `start()` while the in-memory job is
 *     running returns `running:true` without launching a second subagent.
 *   - One fix per repository (design spec §9: 修复类子代理并发 1（同工作区
 *     串行）). The repository root is resolved before any preparation and a
 *     second, different ticket in the same repo is rejected with `fix-busy`
 *     (HTTP 409) before any state write. The lock is held until the background
 *     job settles.
 *   - Service-level restart: `fix_done` only accepts `fixing`, and a failed fix
 *     blocks the ticket from `fixing`. `start()` therefore also restarts (a) a
 *     ticket already `fixing` with no in-memory job (crash, unload, previous
 *     host) without an initial state write, and (b) a ticket blocked with
 *     `blockedFrom:'fixing'` by applying `retry` back to `fixing`. Git
 *     preparation (settings, branch derivation, base resolution and
 *     `worktree add`) happens BEFORE that retry write, so a preparation
 *     failure leaves the ticket blocked instead of stranding it in `fixing`
 *     with no job, branch or error; the branch metadata is persisted after a
 *     successful retry, and a persistence failure rolls the ticket back to
 *     `blocked`. The runner availability check also happens before every
 *     write, so a 503 never leaves a half-restarted ticket.
 *   - Only an approved plan can be fixed (`plan-not-approved` otherwise).
 *   - Branches follow the team rule (`deriveBranches`, version from
 *     `platform.versionName ?? version`, family `hot` for type `故障`). The
 *     target base is resolved in this order and recorded as `baseSource`:
 *     `origin/<target>` ('origin'), local `<target>` ('target'), else `HEAD`
 *     ('HEAD', local/demo repositories) — all three values are valid contract.
 *     When `git worktree add` REUSES an already registered worktree
 *     (`created:false`) the worktree still sits on the base chosen by the
 *     earlier attempt, so the recorded `baseSource`/`createdAt` are preserved
 *     instead of being overwritten with the freshly resolved base; a new
 *     worktree (or old metadata pointing at another branch/path) records the
 *     fresh resolution.
 *   - A personal branch already recorded by another ticket of the same repo
 *     (same version/family/user maps to the same branch) is detected before
 *     `git worktree add`: the start fails with `fix-branch-busy`, a static
 *     Chinese reason, instead of an opaque git collision. A `fixing` ticket is
 *     blocked with that reason; a blocked restart keeps its blocked state.
 *   - All git work happens in `<repo>/.dsh-worktrees/<code>` through the
 *     injected git executor; P4 never commits or pushes. A worktree-add
 *     failure is returned to the route and the ticket keeps its workflow. If
 *     git created the branch but failed to register the worktree, the branch
 *     is left at the base (retries reuse it; the service never deletes a
 *     branch it cannot prove it created).
 *   - After the runner succeeds, `changedFiles` comes from
 *     `git status --porcelain` (tracked AND untracked `??` entries), while
 *     `diffStat`/`diff` are clipped (the persisted diff is a bounded excerpt,
 *     never the full patch). A successful status read with zero changes does
 *     NOT advance to `fix_done`: the run is stored as failed (`fix-no-changes`)
 *     and the ticket is blocked (design spec §7: fixing → fix_done requires
 *     worktree changes). A failed status read degrades to the runner list.
 *     The fixes entry is written through `store.patchTicket()` with
 *     `expectedWorkflow:'fixing'`, then `fix_done` uses the same conditional
 *     write: a late result that lands after the ticket advanced records only a
 *     static meta error and never regresses the workflow.
 *   - A runner failure maps to a static block reason + static meta error
 *     (`fix-timeout`/`fix-bad-output`/`no-live-agent`/`fix-failed`). The
 *     `block` write also carries `expectedWorkflow:'fixing'`; on a stale
 *     refusal only the meta error is written.
 *   - `dispose()` marks every running entry `cancelled` and only then aborts
 *     it. A cancelled job performs NO terminal write: plugin unload is not a
 *     fix failure, so the ticket stays `fixing` with no `fix.error` meta and
 *     the next host load restarts it through the orphan path. The cancelled
 *     flag is re-checked after every await in the finish path (including the
 *     git collection), so a dispose during post-run collection writes nothing.
 *     A start that races teardown likewise re-checks `disposed` after every
 *     await: a dispose during the final `clearError()` returns
 *     `fix-unavailable` without launching a job, and a preparation failure
 *     that lands after teardown writes no terminal block/meta.
 *     The drain is bounded and idempotent; the host awaits it before closing
 *     the domain.
 *   - The background job never rejects. Error messages are static Chinese
 *     strings: runner messages/diagnostics/stacks never reach meta or snapshot.
 */

import { sep } from 'node:path';

import { DEFAULT_FIX_TIMEOUT_MS } from './agent-access.js';
import { BranchError, deriveBranches } from './branch.js';

/** `meta` key prefix of a persisted fix error. */
export const FIX_ERROR_META_PREFIX = 'fix.error:';

/**
 * Static client-visible text per block reason. These are the only strings ever
 * persisted for a fix failure; runner diagnostics stay in the host.
 */
export const FIX_REASON_MESSAGES = Object.freeze({
  'fix-timeout': '修复超时，请重试',
  'fix-bad-output': '修复结果格式不正确，请重试',
  'no-live-agent': '当前没有可用的会话 Agent',
  'fix-failed': '修复子代理执行失败，请重试',
  // A successful runner result with an empty `git status`: the child reported
  // a fix but the worktree has no changes (design spec §7 requires changes).
  'fix-no-changes': '修复未产生任何代码改动，请重试',
  // Another ticket of this repository already has the same personal branch
  // checked out (same version/type/user derives the same branch name).
  'fix-branch-busy': '个人分支已被其它工单的工作树占用，请先清理后再试',
});

/** `start()` refusal when another ticket is already fixing in this repository. */
export const FIX_BUSY_MESSAGE = '当前工作区已有修复任务在执行，请稍后重试';

/** A result that arrived after the ticket stopped being fixable. */
export const STALE_FIX_MESSAGE = '修复结果已过期或状态已变化，已丢弃';

/**
 * A persistence failure that is NOT a stale-workflow race (invalid payload,
 * closed domain, clock error). Keeping this distinct from the stale copy stops
 * a lost successful run from looking like a harmless late result.
 */
export const SAVE_FAILED_MESSAGE = '修复结果保存失败，请重试（详情见宿主日志）';

/** A blocked restart whose git preparation failed: the ticket was NOT retried. */
export const FIX_START_FAILED_MESSAGE = '修复启动失败，请检查分支与工作树后重试';

/**
 * Persisted `diff` excerpt cap. The client never renders the full patch, and
 * the snapshot is polled every 3 s, so a single run must not store (or ship)
 * the whole 20 k git-module diff. The plan contract only requires `diffStat`.
 */
export const FIX_DIFF_MAX_CHARS = 4_000;

/** Free-text cap for the persisted summary/testResult/notes (schema mirrors it). */
const FIX_TEXT_MAX_CHARS = 8_000;

/**
 * Bounds mirrored from the host `fixRunSchema` (`domain-spec.js`). The writer
 * normalizes every optional field it emits to these limits, so a clock/runner
 * anomaly (fractional or negative elapsed, an overlong child id or path) can
 * never turn an otherwise successful run into `invalid-payload`/SAVE_FAILED
 * and lose the `fixes` entry (review N1).
 */
const FIX_CHILD_ID_MAX_CHARS = 200;
const FIX_CHANGED_FILE_MAX_CHARS = 4_096;
const FIX_CHANGED_FILES_MAX = 2_000;

/** Runner failure code -> persisted block reason. */
const RUNNER_CODE_TO_REASON = Object.freeze({
  'analysis-timeout': 'fix-timeout',
  'analysis-bad-output': 'fix-bad-output',
  'analysis-unavailable': 'no-live-agent',
  'analysis-failed': 'fix-failed',
});

/** Fallback fix budget when the caller does not inject one (15 minutes). */
const DEFAULT_TIMEOUT_MS = DEFAULT_FIX_TIMEOUT_MS;

/**
 * Upper bound on `dispose()` draining aborted jobs. The host awaits the drain
 * before closing the storage domain, so a runner that ignores its abort signal
 * must not hang plugin unload.
 */
const DEFAULT_DRAIN_TIMEOUT_MS = 3_000;

const UNAVAILABLE_MESSAGE = '修复服务不可用，请稍后重试';
const INTERNAL_MESSAGE = '修复启动失败，请重试';

/**
 * Create the fix service.
 *
 * @param {object} deps
 * @param {object} deps.store opened ticket store
 *   (`get/list/applyAction/patchTicket/getMeta/setMeta`)
 * @param {object} deps.runner `createAgentRunner()` result (`available/runFix`)
 * @param {object} deps.git `createGit()` result (`repoRoot/refExists/
 *   worktreePath/worktreeAdd/status/diffStat/diff`)
 * @param {(cwd: string) => object} [deps.getSettings] workspace settings reader
 *   (defaults to `store.getSettings`)
 * @param {(() => string) | {now: () => string}} [deps.clock] action-id/timestamp clock
 * @param {number} [deps.timeoutMs] fix budget forwarded to the runner
 * @param {number} [deps.drainTimeoutMs] bound on `dispose()` draining jobs
 * @returns {{
 *   start: (sessionId: string, cwd: string, code: string) => Promise<object>,
 *   status: () => {running: string[], errors: Record<string, string>},
 *   dispose: () => Promise<void>,
 * }}
 */
export function createFixService({
  store,
  runner,
  git,
  getSettings,
  clock = defaultClock,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
} = {}) {
  assertStore(store);
  assertRunner(runner);
  assertGit(git);
  const readNow = normalizeClock(clock);
  const readSettings = normalizeSettingsReader(getSettings, store);
  const fixTimeoutMs = positiveNumber(timeoutMs) ?? DEFAULT_TIMEOUT_MS;
  const disposeTimeoutMs = positiveNumber(drainTimeoutMs) ?? DEFAULT_DRAIN_TIMEOUT_MS;

  /** code -> { controller, cancelled } for fixes currently running. */
  const running = new Map();
  /** resolved repo root -> code of the running fix that owns the repository. */
  const repoLocks = new Map();
  /** Promises of background jobs that have not settled yet (dispose drain). */
  const jobs = new Set();
  /** Codes known to carry a fix error (meta is still the source of truth). */
  const errorCodes = new Set();
  /** Action ids already used by this service instance (clock can be coarse). */
  const usedActionIds = new Set();
  let duplicateActionIdSuffix = 0;
  let disposed = false;
  let disposePromise;

  /**
   * Start one fix. Returns after the branch/worktree metadata is persisted and
   * the background job is launched; the subagent settles the ticket later.
   *
   * @param {string} sessionId live parent session id (subagent resolution)
   * @param {string} cwd resolved workspace path
   * @param {string} code ticket code
   * @returns {Promise<{ok:true, running:boolean, workflow:'fixing'}
   *   | {ok:false, code:string, message:string}>}
   */
  async function start(sessionId, cwd, code) {
    if (disposed) return failure('fix-unavailable', UNAVAILABLE_MESSAGE);

    const key = normalizeCode(code);
    if (key === undefined) return failure('invalid-code', '缺少有效的工单编号 code');

    const found = readTicket(key);
    if (!found.ok) {
      // A read failure is a host problem (500), never a 404: only a genuinely
      // missing record may tell the user the ticket does not exist.
      return found.reason === 'error'
        ? failure('internal', '读取工单失败，请重试')
        : failure('ticket-not-found', `工单 ${key} 不存在`);
    }
    const current = found.ticket;

    // Duplicate click / concurrent request: never launch a second subagent.
    if (running.has(key)) return { ok: true, running: true, workflow: 'fixing' };

    // Service-level restart: a failure blocks from `fixing` and `fix_done`
    // only accepts `fixing`, so without these branches a failed (or
    // crash-orphaned) fix could never be started again.
    const blockedRestart = current.workflow === 'blocked' && current.blockedFrom === 'fixing';
    if (current.workflow !== 'fixing' && !blockedRestart) {
      return failure('invalid-state', `工单状态 ${String(current.workflow)} 不能开始修复`);
    }
    if (!hasApprovedPlan(current)) {
      return failure('plan-not-approved', '方案尚未审核通过，无法开始修复');
    }
    // Service wiring check only: `runner.available()` reports whether the
    // `subagents`/`agents` services are wired, NOT whether a live parent Agent
    // exists. An unwired service is a synchronous 503 before any state write
    // (notably the blocked restart's `retry`); a wired service with no live
    // parent passes here, is accepted with 200 and blocks later as
    // `no-live-agent` from the background run.
    if (!runnerAvailable()) {
      return failure('fix-unavailable', FIX_REASON_MESSAGES['no-live-agent']);
    }

    // Resolve the repository BEFORE reserving: the per-workspace concurrency
    // lock is keyed by the real repository (the session cwd can be a
    // subdirectory), and the single-flight check must be repeated after this
    // await so two same-tick requests for the same ticket still collapse.
    const repo = await git.repoRoot(cwd);
    if (typeof repo !== 'string' || repo.trim() === '') return gitFailure(repo);
    if (disposed) return failure('fix-unavailable', UNAVAILABLE_MESSAGE);
    if (running.has(key)) return { ok: true, running: true, workflow: 'fixing' };

    // Design spec §9: one fix subagent per workspace. A different ticket in
    // the same repository is rejected before any state write (HTTP 409).
    if (!lockRepo(repo, key)) return failure('fix-busy', FIX_BUSY_MESSAGE);

    const entry = reserve(key);
    let launched = false;
    try {
      // Git preparation happens BEFORE the blocked restart's `retry` write:
      // a failing preparation must leave the ticket in its previous state
      // instead of stranding it in `fixing` with no job, branch or error.
      const prepared = await prepareWorktree(key, current, cwd, repo);
      if (!prepared.ok) {
        await reportStartFailure(key, blockedRestart, prepared.failure);
        return prepared.failure;
      }
      if (disposed) return disposedStart(key, entry);

      if (blockedRestart) {
        const retried = await applyRetry(key);
        if (!retried.ok) return retried.failure;
        if (disposed) return disposedStart(key, entry);
      }

      // The branch metadata is persisted only after the ticket is `fixing`.
      const branched = await persistBranch(key, prepared, current);
      if (!branched.ok) {
        // A retry that already moved the ticket is rolled back to `blocked`
        // when its metadata cannot be stored; otherwise the ticket would be
        // left in `fixing` without a job or an error, which the board cannot
        // recover from (review I1).
        if (blockedRestart) await restoreBlockedAfterRetry(key, branched);
        return branched.failure;
      }
      if (disposed) return disposedStart(key, entry);

      await clearError(key);
      // Final re-check before activation: a dispose can land while the error
      // meta is cleared. Teardown must never launch a job (or return 200).
      if (disposed) return disposedStart(key, entry);
      launchJob({
        entry,
        key,
        repo,
        sessionId,
        worktreePath: prepared.worktreePath,
        branch: prepared.branch,
        target: prepared.target,
        ticket: branched.ticket,
      });
      launched = true;
      return { ok: true, running: true, workflow: 'fixing' };
    } catch {
      return failure('internal', INTERNAL_MESSAGE);
    } finally {
      if (!launched) {
        clearRunning(key, entry);
        unlockRepo(repo, key);
      }
    }
  }

  /**
   * Apply `retry` to a ticket blocked from `fixing`. The caller checked runner
   * availability first. A retry that does not end in `fixing` (racing manual
   * action) is reported as a lost race, never treated as success.
   */
  async function applyRetry(key) {
    let applied;
    try {
      applied = await store.applyAction(
        key,
        'retry',
        { actor: 'user' },
        { actionId: nextActionId('fix-retry', key) },
      );
    } catch {
      return { ok: false, failure: failure('internal', INTERNAL_MESSAGE) };
    }

    if (applied?.ok !== true || applied.ticket?.workflow !== 'fixing') {
      return {
        ok: false,
        failure: failure('invalid-state', '工单状态已变化，请刷新后重试'),
      };
    }
    return { ok: true, ticket: applied.ticket };
  }

  /**
   * Git preparation only: settings -> branch names -> branch ownership ->
   * worktree path -> base -> `worktree add`. Nothing is persisted here, which
   * lets `start()` run this BEFORE the blocked restart's `retry` write: a
   * failure then leaves the ticket in its previous state instead of stranding
   * it in `fixing` (review I1). `baseSource` is one of 'origin', 'target' or
   * 'HEAD' and is persisted later by `persistBranch()`.
   */
  async function prepareWorktree(key, ticket, cwd, repo) {
    let settings;
    try {
      settings = await readSettings(cwd);
    } catch {
      return { ok: false, failure: failure('internal', '读取工作区设置失败，请重试') };
    }

    const versionName = ticket.platform?.versionName ?? ticket.version;
    let branches;
    try {
      branches = deriveBranches({
        versionName,
        ticketType: ticket.type,
        branchUser: settings?.branchUser || 'ly',
        family: ticket.type === '故障' ? 'hot' : 'feat',
      });
    } catch (error) {
      if (error instanceof BranchError && typeof error.code === 'string') {
        return {
          ok: false,
          failure: failure(error.code, typeof error.message === 'string' ? error.message : '分支参数不合法'),
        };
      }
      return { ok: false, failure: failure('internal', INTERNAL_MESSAGE) };
    }

    // Another ticket of the same version/type/user derives the same personal
    // branch. Letting `git worktree add` collide would surface as an opaque
    // `git-failed` 500; fail with a static, actionable reason instead.
    const collision = await detectBranchCollision(repo, key, branches.personalBranch);
    if (collision.ok !== true) return { ok: false, failure: collision.failure };

    const tree = git.worktreePath({ repo, code: key });
    if (tree?.ok !== true) {
      return {
        ok: false,
        failure: failure(
          typeof tree?.code === 'string' ? tree.code : 'invalid-worktree-path',
          typeof tree?.message === 'string' ? tree.message : '工单号无法生成安全的工作树路径',
        ),
      };
    }

    const base = await resolveBase(repo, branches.targetBranch);
    if (!base.ok) return { ok: false, failure: base.failure };

    const added = await git.worktreeAdd({
      repo,
      path: tree.path,
      branch: branches.personalBranch,
      base: base.base,
    });
    if (added?.ok === false) {
      // If git created the personal branch but failed to register the
      // worktree, the branch is left at the base. Retries reuse it; the
      // service never deletes a branch it cannot prove it created (M5).
      return { ok: false, failure: gitFailure(added) };
    }

    return {
      ok: true,
      worktreePath: tree.path,
      branch: branches.personalBranch,
      target: branches.targetBranch,
      baseSource: base.source,
      // `git worktree add` reuses an already registered worktree at `path`
      // (`{created:false}`); its content then still sits on the base chosen by
      // the earlier attempt, NOT on the base just resolved. The caller must
      // not overwrite the recorded baseline in that case (review I1).
      created: added?.created === true,
    };
  }

  /**
   * Persist the personal branch/worktree metadata after the ticket is
   * `fixing`. The write carries `expectedWorkflow:'fixing'` so a ticket that
   * moved on during the (possibly slow) git work is not overwritten.
   *
   * When the worktree is REUSED (`prepared.created:false`) the existing branch
   * metadata already describes where that worktree actually sits, so its
   * `baseSource`/`createdAt` are preserved: re-resolving `origin/<target>`
   * after an integration branch appeared would otherwise record a baseline the
   * worktree was never created from. A new worktree (or metadata pointing at a
   * different branch/path, e.g. an externally removed then re-added worktree)
   * records the freshly resolved base and timestamp.
   */
  async function persistBranch(key, prepared, ticket) {
    const existing = isPlainObject(ticket?.branch) ? ticket.branch : {};
    const reused = prepared.created !== true;
    const sameTarget = existing.name === prepared.branch
      && existing.worktree === prepared.worktreePath;
    const keepBase = reused && sameTarget && typeof existing.baseSource === 'string';
    const keepCreatedAt = reused && sameTarget && typeof existing.createdAt === 'string';

    let patched;
    try {
      patched = await store.patchTicket(
        key,
        {
          branch: {
            name: prepared.branch,
            target: prepared.target,
            baseSource: keepBase ? existing.baseSource : prepared.baseSource,
            worktree: prepared.worktreePath,
            createdAt: keepCreatedAt ? existing.createdAt : readNow(),
          },
        },
        { actionId: nextActionId('fix-branch', key), expectedWorkflow: 'fixing' },
      );
    } catch {
      return { ok: false, failure: failure('internal', INTERNAL_MESSAGE) };
    }

    if (patched?.ok !== true) {
      if (patched?.code === 'stale-workflow') {
        return {
          ok: false,
          storeCode: 'stale-workflow',
          failure: failure('invalid-state', '工单状态已变化，请刷新后重试'),
        };
      }
      return {
        ok: false,
        storeCode: patched?.code,
        failure: failure(
          typeof patched?.code === 'string' ? patched.code : 'internal',
          typeof patched?.message === 'string' ? patched.message : INTERNAL_MESSAGE,
        ),
      };
    }

    return { ok: true, ticket: patched.ticket };
  }

  /**
   * Check whether another ticket of this repository already records the same
   * personal branch with a live worktree. Best-effort on purpose: a failing
   * store read or git probe falls through to `git worktree add` (the real
   * authority) so this guard never becomes a new failure source.
   */
  async function detectBranchCollision(repo, key, branchName) {
    let tickets;
    try {
      tickets = store.list();
    } catch {
      return { ok: true };
    }
    if (!Array.isArray(tickets)) return { ok: true };

    for (const other of tickets) {
      if (!isPlainObject(other)) continue;
      const otherKey = normalizeCode(other.code);
      if (otherKey === undefined || otherKey === key) continue;
      const branch = other.branch;
      if (!isPlainObject(branch) || branch.name !== branchName) continue;
      const worktree = branch.worktree;
      if (typeof worktree !== 'string' || worktree === '') continue;
      if (!isInsideRepo(repo, worktree)) continue;

      let status;
      try {
        status = await git.status(worktree);
      } catch {
        continue;
      }
      // A readable status proves the recorded worktree still exists, so the
      // branch is actually checked out there.
      if (typeof status === 'string') {
        return { ok: false, failure: failure('fix-branch-busy', FIX_REASON_MESSAGES['fix-branch-busy']) };
      }
    }
    return { ok: true };
  }

  /**
   * Record a static error for a start that failed before launching. A blocked
   * restart keeps its blocked state (its old reason is still valid) and only
   * refreshes the meta message. A branch owned by another worktree is a
   * terminal conflict for this start, so a `fixing` ticket is blocked with the
   * same static reason.
   */
  async function reportStartFailure(key, blockedRestart, startFailure) {
    // A dispose during preparation is teardown, not a fix failure: write no
    // terminal block or error meta after the service is disposed (N2). The
    // start still returns the structured preparation failure.
    if (disposed) return;
    const code = startFailure?.code;
    if (code === 'fix-branch-busy') {
      if (blockedRestart) await rememberError(key, FIX_REASON_MESSAGES['fix-branch-busy']);
      else await blockWithReason(key, 'fix-branch-busy');
      return;
    }
    if (blockedRestart) await rememberError(key, startFailureMessage(code));
  }

  /**
   * A blocked restart already applied `retry` before the branch metadata write
   * failed. Put the ticket back to `blocked(fixing)` with a static reason so
   * the user can retry. A stale-workflow failure means the ticket moved on, so
   * touching it would be wrong: only the static meta is written.
   */
  async function restoreBlockedAfterRetry(key, branched) {
    if (branched?.storeCode === 'stale-workflow') {
      await rememberError(key, STALE_FIX_MESSAGE);
      return;
    }
    let blocked;
    try {
      blocked = await store.applyAction(
        key,
        'block',
        { reason: 'fix-failed', actor: 'system' },
        { actionId: nextActionId('fix-restore', key), expectedWorkflow: 'fixing' },
      );
    } catch {
      blocked = undefined;
    }
    await rememberError(
      key,
      blocked?.ok === true
        ? FIX_REASON_MESSAGES['fix-failed']
        : startFailureMessage(branched?.failure?.code),
    );
  }

  /**
   * Resolve the worktree base: `origin/<target>` when it exists, else the local
   * `<target>`, else `HEAD` (documented fallback for local/demo repositories).
   * The chosen source is recorded in the branch metadata as `baseSource`, one
   * of the three contract values `'origin' | 'target' | 'HEAD'`.
   *
   * @returns {Promise<{ok:true, base:string, source:'origin'|'target'|'HEAD'}
   *   | {ok:false, failure:object}>}
   */
  async function resolveBase(repo, target) {
    const remoteRef = `origin/${target}`;
    const remote = await git.refExists(repo, remoteRef);
    if (remote?.ok !== true) return { ok: false, failure: gitFailure(remote) };
    if (remote.exists === true) return { ok: true, base: remoteRef, source: 'origin' };

    const local = await git.refExists(repo, target);
    if (local?.ok !== true) return { ok: false, failure: gitFailure(local) };
    if (local.exists === true) return { ok: true, base: target, source: 'target' };

    return { ok: true, base: 'HEAD', source: 'HEAD' };
  }

  /**
   * Snapshot view: currently running codes plus persisted static errors, read
   * from `meta['fix.error:<code>']` for every stored ticket. Any store read
   * failure degrades to empty.
   *
   * @returns {{running: string[], errors: Record<string, string>}}
   */
  function status() {
    const codes = new Set(errorCodes);
    try {
      const tickets = store.list();
      if (Array.isArray(tickets)) {
        for (const ticket of tickets) {
          const code = normalizeCode(ticket?.code);
          if (code !== undefined) codes.add(code);
        }
      }
    } catch {
      // A failing ticket scan only hides errors; it must not break a snapshot.
    }

    const errors = {};
    for (const code of codes) {
      const message = readPersistedError(code);
      if (message !== undefined) errors[code] = message;
      else errorCodes.delete(code);
    }
    return { running: [...running.keys()], errors };
  }

  /**
   * Cancel every running job and drain it. Each entry is marked `cancelled`
   * BEFORE the abort, so the job writes neither `block` nor an error meta: the
   * ticket stays `fixing` and a later host load restarts it. Idempotent.
   *
   * @returns {Promise<void>}
   */
  function dispose() {
    if (disposePromise !== undefined) return disposePromise;
    disposed = true;
    const entries = [...running.values()];
    running.clear();
    for (const entry of entries) {
      entry.cancelled = true;
      try {
        entry.controller.abort();
      } catch {
        // A hostile signal implementation must not break teardown.
      }
    }
    disposePromise = drainJobs([...jobs], disposeTimeoutMs);
    return disposePromise;
  }

  /** Reserve the running entry before the first await of a start branch. */
  function reserve(key) {
    const entry = { controller: new AbortController(), cancelled: false };
    running.set(key, entry);
    return entry;
  }

  /** A start that raced teardown: drop the reservation, never launch, 503. */
  function disposedStart(key, entry) {
    clearRunning(key, entry);
    return failure('fix-unavailable', UNAVAILABLE_MESSAGE);
  }

  /**
   * Fire-and-forget background job. `run()` never throws, its completion always
   * releases the running entry and the repository lock, and the promise stays
   * in `jobs` until it settles so `dispose()` can drain it.
   */
  function launchJob({ entry, key, repo, sessionId, worktreePath, branch, target, ticket }) {
    const job = run({ entry, key, sessionId, worktreePath, branch, target, ticket });
    jobs.add(job);
    void job
      .finally(() => {
        jobs.delete(job);
        clearRunning(key, entry);
        unlockRepo(repo, key);
      })
      .catch(() => {
        // `run()` contains every failure; belt-and-braces only.
      });
  }

  async function run({ entry, key, sessionId, worktreePath, branch, target, ticket }) {
    let startedAt;
    try {
      startedAt = readNow();
    } catch {
      // A broken injected clock must not make the background job reject; the
      // run metadata is diagnostic, the workflow write is what matters.
      startedAt = new Date().toISOString();
    }
    let result;
    try {
      result = await runner.runFix({
        sessionId,
        worktreePath,
        ticket,
        plan: ticket.plan,
        branch,
        target,
        signal: entry.controller.signal,
        timeoutMs: fixTimeoutMs,
      });
    } catch {
      result = { ok: false, code: 'analysis-failed' };
    }

    // Teardown cancelled this fix: unload/app quit is not a failure. Do not
    // block the ticket and do not persist an error; the orphan path on the
    // next host load restarts it from `fixing`.
    if (entry.cancelled === true) return;

    try {
      if (result?.ok === true) {
        await applyFixResult({ entry, key, worktreePath, startedAt, result });
      } else {
        await applyFixFailure(key, result?.code, entry);
      }
    } catch {
      // The store/domain may already be closing (host unload). The outcome
      // must never escape the background job.
    }
  }

  /**
   * Persist one run, then either advance to `fix_done` (real changes) or block
   * with `fix-no-changes` (successful status read, empty worktree).
   */
  async function applyFixResult({ entry, key, worktreePath, startedAt, result }) {
    const current = readTicket(key);
    if (!current.ok) {
      // Missing/invalid record vs a store read failure: only the former means
      // the result is genuinely stale (M3).
      await rememberError(
        key,
        current.reason === 'error' ? SAVE_FAILED_MESSAGE : STALE_FIX_MESSAGE,
      );
      return;
    }
    if (current.ticket.workflow !== 'fixing') {
      await rememberError(key, STALE_FIX_MESSAGE);
      return;
    }

    const collected = await collectChanges(worktreePath, result.result);
    // A dispose can land while the three git reads await; unload is not a
    // failure, so no fixes entry / fix_done / block may be written (M1).
    if (entry.cancelled === true) return;

    // Design spec §7: fixing → fix_done requires worktree changes. A status
    // read that SUCCEEDED with an empty porcelain output means the child
    // reported a fix but changed nothing: record a failed run and block.
    // (A failed status read keeps the old degrade-and-succeed behavior: the
    // host cannot verify changes then.) Lint/test execution is intentionally
    // deferred; see the P4 Task 2 fix report.
    const noChanges = collected.statusOk === true && collected.changedFiles.length === 0;
    const fixes = Array.isArray(current.ticket.fixes) ? current.ticket.fixes : [];
    const patchActionId = nextActionId('fix-patch', key);
    let finishedAt;
    try {
      finishedAt = readNow();
    } catch {
      finishedAt = new Date().toISOString();
    }
    // Normalize the run metadata to the host `fixRunSchema` bounds before the
    // patch. A fractional/negative elapsedMs, an overlong child id or an
    // overlong changed-file path would otherwise make the host reject the whole
    // record (`invalid-payload`) although the fix itself succeeded (N1).
    const changedFiles = (Array.isArray(collected.changedFiles) ? collected.changedFiles : [])
      .filter((file) => typeof file === 'string')
      .slice(0, FIX_CHANGED_FILES_MAX)
      .map((file) => file.slice(0, FIX_CHANGED_FILE_MAX_CHARS));
    const fixEntry = {
      runId: patchActionId,
      ...(typeof result.childId === 'string' && result.childId !== ''
        ? { childId: result.childId.slice(0, FIX_CHILD_ID_MAX_CHARS) }
        : {}),
      startedAt,
      finishedAt,
      changedFiles,
      diffStat: clipText(collected.diffStat, 4_000),
      diff: collected.diff,
      summary: clipText(result.result?.summary, FIX_TEXT_MAX_CHARS),
      testResult: clipText(result.result?.testResult, FIX_TEXT_MAX_CHARS),
      notes: clipText(result.result?.notes, FIX_TEXT_MAX_CHARS),
      status: noChanges ? 'failed' : 'succeeded',
      ...(noChanges ? { error: 'fix-no-changes' } : {}),
      ...(Number.isFinite(result.elapsedMs)
        ? { elapsedMs: Math.max(0, Math.trunc(result.elapsedMs)) }
        : {}),
    };

    let patched;
    try {
      patched = await store.patchTicket(
        key,
        { fixes: [...fixes, fixEntry] },
        { actionId: patchActionId, expectedWorkflow: 'fixing' },
      );
    } catch {
      await rememberError(key, SAVE_FAILED_MESSAGE);
      return;
    }
    if (patched?.ok !== true) {
      await rememberError(key, patchFailureMessage(patched));
      return;
    }
    // No terminal write after cancellation (a dispose during the patch write
    // is rare but must still not advance/block the ticket).
    if (entry.cancelled === true) return;

    if (noChanges) {
      await applyFixFailure(key, 'fix-no-changes', entry);
      return;
    }

    try {
      const applied = await store.applyAction(
        key,
        'fix_done',
        { actor: 'agent' },
        { expectedWorkflow: 'fixing' },
      );
      if (applied?.ok === true) {
        await clearError(key);
        return;
      }
      await rememberError(key, patchFailureMessage(applied));
      return;
    } catch {
      await rememberError(key, SAVE_FAILED_MESSAGE);
    }
  }

  /**
   * Block the ticket with the mapped reason and persist the static message.
   * `block` is legal from many workflows, so the write carries
   * `expectedWorkflow:'fixing'`: the store re-reads inside its write-queue
   * critical section and refuses (`stale-workflow`) when the ticket already
   * advanced. On a stale refusal only the static meta is written.
   *
   * @param {string} key ticket code
   * @param {string} runnerCode runner failure code or a block reason
   * @param {{cancelled?: boolean}} [entry] running entry (cancel re-check)
   */
  async function applyFixFailure(key, runnerCode, entry) {
    if (entry?.cancelled === true) return;
    const reason = RUNNER_CODE_TO_REASON[runnerCode]
      ?? (Object.hasOwn(FIX_REASON_MESSAGES, runnerCode) ? runnerCode : 'fix-failed');
    await blockWithReason(key, reason);
  }

  /** `block` with a static reason (stale refusal still records the meta). */
  async function blockWithReason(key, reason) {
    const message = FIX_REASON_MESSAGES[reason] ?? FIX_REASON_MESSAGES['fix-failed'];
    try {
      await store.applyAction(
        key,
        'block',
        { reason, actor: 'system' },
        { expectedWorkflow: 'fixing' },
      );
    } catch {
      // A block that lost a race (or a closing store) is not an error.
    }
    await rememberError(key, message);
  }

  /**
   * Collect the worktree changes. `changedFiles` comes from
   * `git status --porcelain` (tracked changes AND untracked `??` entries; a
   * `git diff` alone would miss new files). `statusOk` distinguishes an empty
   * worktree from a failed status read: only the former is `fix-no-changes`.
   * The persisted `diff` is a bounded excerpt (the snapshot is polled often and
   * the client renders `diffStat`, not the patch).
   */
  async function collectChanges(worktreePath, fixResult) {
    let changedFiles = Array.isArray(fixResult?.changedFiles)
      ? fixResult.changedFiles.slice()
      : [];
    let diffStat = '';
    let diff = '';

    const status = await git.status(worktreePath);
    const statusOk = typeof status === 'string';
    if (statusOk) changedFiles = parsePorcelainFiles(status);

    const stat = await git.diffStat(worktreePath);
    if (typeof stat === 'string') diffStat = stat;

    const patch = await git.diff(worktreePath);
    if (typeof patch === 'string') diff = clipText(patch, FIX_DIFF_MAX_CHARS, '\n…（diff 已截断）');

    return { changedFiles, diffStat, diff, statusOk };
  }

  /** Persist one static error; the in-memory index is a status convenience. */
  async function rememberError(key, message) {
    errorCodes.add(key);
    try {
      await store.setMeta(FIX_ERROR_META_PREFIX + key, message);
    } catch {
      // Keep the in-memory entry: the running host can still show it.
    }
  }

  /** Clear a persisted error (meta `null`) after a successful transition. */
  async function clearError(key) {
    if (!errorCodes.has(key) && readPersistedError(key) === undefined) return;
    errorCodes.delete(key);
    try {
      await store.setMeta(FIX_ERROR_META_PREFIX + key, null);
    } catch {
      errorCodes.add(key);
    }
  }

  /** Read `meta['fix.error:<code>']` as a non-empty string (or undefined). */
  function readPersistedError(key) {
    let value;
    try {
      value = store.getMeta(FIX_ERROR_META_PREFIX + key);
    } catch {
      return undefined;
    }
    if (typeof value !== 'string' || value === '') return undefined;
    errorCodes.add(key);
    return value;
  }

  function clearRunning(key, entry) {
    if (running.get(key) === entry) running.delete(key);
  }

  /** Try to take the per-repository lock for `key` (1 fix per workspace). */
  function lockRepo(repo, key) {
    const owner = repoLocks.get(repo);
    if (owner !== undefined && owner !== key) return false;
    repoLocks.set(repo, key);
    return true;
  }

  /** Release the repository lock only when `key` still owns it. */
  function unlockRepo(repo, key) {
    if (repoLocks.get(repo) === key) repoLocks.delete(repo);
  }

  /**
   * Read the persisted ticket, distinguishing "missing" from "read failed".
   * A thrown read is an unexpected host error (500); only an absent/invalid
   * record may be reported as 404.
   */
  function readTicket(key) {
    let ticket;
    try {
      ticket = store.get(key);
    } catch {
      return { ok: false, reason: 'error' };
    }
    if (!isPlainObject(ticket) || typeof ticket.workflow !== 'string') {
      return { ok: false, reason: 'missing' };
    }
    return { ok: true, ticket };
  }

  function runnerAvailable() {
    if (typeof runner.available !== 'function') return true;
    try {
      return runner.available() === true;
    } catch {
      return false;
    }
  }

  /**
   * Unique action id for one write. The injected clock may be coarse (tests use
   * one constant timestamp); a collision within this instance gets a numeric
   * suffix so a second write can never replay the first one's cached result.
   */
  function nextActionId(prefix, key) {
    const base = `${prefix}-${key}-${readNow()}`;
    let actionId = base;
    while (usedActionIds.has(actionId)) {
      duplicateActionIdSuffix += 1;
      actionId = `${base}-${duplicateActionIdSuffix}`;
    }
    usedActionIds.add(actionId);
    return actionId;
  }

  return { start, status, dispose };
}

// ---------------------------------------------------------------------------
// Validation / helpers
// ---------------------------------------------------------------------------

function assertStore(store) {
  if (store === null || typeof store !== 'object') {
    throw new TypeError('createFixService() requires an opened store');
  }
  for (const method of [
    'get',
    'list',
    'applyAction',
    'patchTicket',
    'getMeta',
    'setMeta',
    'getSettings',
  ]) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(`createFixService() store.${method} must be a function`);
    }
  }
}

function assertRunner(runner) {
  if (runner === null || typeof runner !== 'object' || typeof runner.runFix !== 'function') {
    throw new TypeError('createFixService() requires a runner with runFix()');
  }
}

function assertGit(git) {
  if (git === null || typeof git !== 'object') {
    throw new TypeError('createFixService() requires a git executor');
  }
  for (const method of [
    'repoRoot',
    'refExists',
    'worktreePath',
    'worktreeAdd',
    'status',
    'diffStat',
    'diff',
  ]) {
    if (typeof git[method] !== 'function') {
      throw new TypeError(`createFixService() git.${method} must be a function`);
    }
  }
}

/** Accept a settings reader injection; fall back to the store's own reader. */
function normalizeSettingsReader(getSettings, store) {
  if (typeof getSettings === 'function') return (cwd) => getSettings(cwd);
  return (cwd) => store.getSettings(cwd);
}

/** Accept the host clock convention (function) and an object `{now()}`. */
function normalizeClock(clock) {
  if (typeof clock === 'function') {
    return () => {
      const value = clock();
      if (typeof value !== 'string' || value === '') {
        throw new TypeError('clock() 必须返回非空字符串');
      }
      return value;
    };
  }
  if (isPlainObject(clock) && typeof clock.now === 'function') {
    return () => {
      const value = clock.now();
      if (typeof value !== 'string' || value === '') {
        throw new TypeError('clock.now() 必须返回非空字符串');
      }
      return value;
    };
  }
  throw new TypeError('createFixService() requires a clock function or {now()}');
}

function defaultClock() {
  return new Date().toISOString();
}

function positiveNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return undefined;
}

function normalizeCode(code) {
  if (typeof code !== 'string') return undefined;
  const trimmed = code.trim();
  return trimmed === '' ? undefined : trimmed;
}

function hasApprovedPlan(ticket) {
  return isPlainObject(ticket?.plan)
    && typeof ticket.plan.approvedAt === 'string'
    && ticket.plan.approvedAt !== '';
}

/** Map a structured git failure to a service failure (static text only). */
function gitFailure(value) {
  return failure(
    typeof value?.code === 'string' ? value.code : 'git-failed',
    typeof value?.message === 'string' ? value.message : 'git 命令执行失败',
  );
}

function failure(code, message) {
  return { ok: false, code, message };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True when `candidate` is strictly below `repo` (path separator aware). */
function isInsideRepo(repo, candidate) {
  if (typeof repo !== 'string' || typeof candidate !== 'string') return false;
  const root = repo.endsWith(sep) ? repo.slice(0, -1) : repo;
  return root !== '' && candidate.startsWith(root + sep);
}

/** Static message for a failed start that never reached the runner. */
function startFailureMessage(code) {
  if (code === 'git-timeout') return FIX_REASON_MESSAGES['fix-timeout'];
  if (code === 'fix-branch-busy') return FIX_REASON_MESSAGES['fix-branch-busy'];
  return FIX_START_FAILED_MESSAGE;
}

/**
 * Static meta message for a failed store write. Only a real in-queue
 * `stale-workflow` refusal is "the result is stale"; a schema/domain failure
 * gets its own copy so a lost successful run is not silently disguised as a
 * harmless late result (M3).
 */
function patchFailureMessage(result) {
  return result?.code === 'stale-workflow' ? STALE_FIX_MESSAGE : SAVE_FAILED_MESSAGE;
}

/** Clip a persisted text field; `marker` is appended only when clipped. */
function clipText(value, max, marker = '…') {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

/**
 * Parse `git status --porcelain` lines into the changed-file list.
 *
 * Handles the v1 `XY path` shape, rename entries (`old -> new`, the new path is
 * the change), git's quoted paths and untracked `??` entries. Deduplicates while
 * preserving status order.
 *
 * @param {string} text porcelain output
 * @returns {string[]}
 */
function parsePorcelainFiles(text) {
  const files = [];
  const seen = new Set();
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue;
    // `XY path`; anything shorter is malformed and skipped.
    let path = line.length > 3 ? line.slice(3) : '';
    if (path === '') continue;

    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) path = path.slice(arrow + 4);
    path = unquotePorcelainPath(path);
    if (path === '' || seen.has(path)) continue;
    seen.add(path);
    files.push(path);
  }
  return files;
}

/** C-style escapes git uses inside a quoted porcelain path. */
const PORCELAIN_ESCAPES = Object.freeze({
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  '"': '"',
});

/**
 * Unquote a git porcelain path. Git wraps paths with special characters in
 * double quotes and uses C-style escapes (octal bytes for non-ASCII), so the
 * changed-file list shown to the user stays readable.
 */
function unquotePorcelainPath(value) {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const inner = value.slice(1, -1);
  let out = '';
  // Consecutive octal escapes are UTF-8 bytes of one character; collect and
  // decode them together so a Chinese filename is not split into mojibake.
  let pendingBytes = [];
  const flushBytes = () => {
    if (pendingBytes.length === 0) return;
    out += Buffer.from(pendingBytes).toString('utf8');
    pendingBytes = [];
  };

  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (character !== '\\') {
      flushBytes();
      out += character;
      continue;
    }
    const next = inner[index + 1];
    if (next === undefined) {
      flushBytes();
      out += '\\';
      continue;
    }
    if (/[0-7]/.test(next)) {
      let octal = next;
      let consumed = 1;
      while (consumed < 3 && /[0-7]/.test(inner[index + 1 + consumed] ?? '')) {
        octal += inner[index + 1 + consumed];
        consumed += 1;
      }
      pendingBytes.push(Number.parseInt(octal, 8));
      index += consumed;
      continue;
    }
    flushBytes();
    out += PORCELAIN_ESCAPES[next] ?? next;
    index += 1;
  }
  flushBytes();
  return out;
}

/**
 * Wait for every job to settle, but never longer than `timeoutMs`. Used by
 * `dispose()` so a stuck runner cannot hang plugin unload.
 *
 * @param {Promise<unknown>[]} pending job promises (already started)
 * @param {number} timeoutMs drain bound
 * @returns {Promise<void>}
 */
function drainJobs(pending, timeoutMs) {
  if (pending.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    Promise.allSettled(pending).then(finish, finish);
  });
}
