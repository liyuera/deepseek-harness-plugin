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
 *   - Service-level restart: `fix_done` only accepts `fixing`, and a failed fix
 *     blocks the ticket from `fixing`. `start()` therefore also restarts (a) a
 *     ticket already `fixing` with no in-memory job (crash, unload, previous
 *     host) without a state write, and (b) a ticket blocked with
 *     `blockedFrom:'fixing'` by applying `retry` back to `fixing`. The runner
 *     availability check happens BEFORE that retry write, so a 503 never leaves
 *     a half-restarted ticket; a retry that does not end in `fixing` is a lost
 *     race (`invalid-state`).
 *   - Only an approved plan can be fixed (`plan-not-approved` otherwise).
 *   - Branches follow the team rule (`deriveBranches`, version from
 *     `platform.versionName ?? version`, family `hot` for type `故障`). The
 *     target base is resolved in this order and recorded as `baseSource`:
 *     `origin/<target>` ('origin'), local `<target>` ('target'), else `HEAD`
 *     ('HEAD', local/demo repositories).
 *   - All git work happens in `<repo>/.dsh-worktrees/<code>` through the
 *     injected git executor; P4 never commits or pushes. A worktree-add
 *     failure is returned to the route and the ticket keeps its workflow.
 *   - After the runner succeeds, `changedFiles` comes from
 *     `git status --porcelain` (tracked AND untracked `??` entries), while
 *     `diffStat`/`diff` are clipped by the git module. The fixes entry is
 *     written through `store.patchTicket()` with `expectedWorkflow:'fixing'`,
 *     then `fix_done` uses the same conditional write: a late result that lands
 *     after the ticket advanced records only a static meta error and never
 *     regresses the workflow (`stale-workflow`).
 *   - A runner failure maps to a static block reason + static meta error
 *     (`fix-timeout`/`fix-bad-output`/`no-live-agent`/`fix-failed`). The
 *     `block` write also carries `expectedWorkflow:'fixing'`; on a stale
 *     refusal only the meta error is written.
 *   - `dispose()` marks every running entry `cancelled` and only then aborts
 *     it. A cancelled job performs NO terminal write: plugin unload is not a
 *     fix failure, so the ticket stays `fixing` with no `fix.error` meta and
 *     the next host load restarts it through the orphan path. The drain is
 *     bounded and idempotent; the host awaits it before closing the domain.
 *   - The background job never rejects. Error messages are static Chinese
 *     strings: runner messages/diagnostics/stacks never reach meta or snapshot.
 */

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
});

/** A successful result that arrived after the ticket stopped being fixable. */
export const STALE_FIX_MESSAGE = '修复结果已过期或状态已变化，已丢弃';

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
    // The entry below is reserved before the first await, so two same-tick
    // requests cannot both pass this check.
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
    // Availability is checked before any state write (notably the blocked
    // restart's `retry`): with no live agent there is nothing to run and the
    // ticket must stay where it is (route 503).
    if (!runnerAvailable()) {
      return failure('fix-unavailable', FIX_REASON_MESSAGES['no-live-agent']);
    }

    const entry = reserve(key);
    try {
      let ticket = current;

      if (blockedRestart) {
        const retried = await applyRetry(key);
        if (!retried.ok) {
          clearRunning(key, entry);
          return retried.failure;
        }
        ticket = retried.ticket;
        if (disposed) return disposedStart(key, entry);
      }

      await clearError(key);
      // Re-check AFTER every await: dispose() may have aborted the reserved
      // entry while a write was in flight. No job may launch then.
      if (disposed) return disposedStart(key, entry);

      const prepared = await prepareWorktree(key, ticket, cwd);
      if (!prepared.ok) {
        clearRunning(key, entry);
        return prepared.failure;
      }
      if (disposed) return disposedStart(key, entry);

      launchJob({
        entry,
        key,
        sessionId,
        worktreePath: prepared.worktreePath,
        branch: prepared.branch,
        target: prepared.target,
        ticket: prepared.ticket,
      });
      return { ok: true, running: true, workflow: 'fixing' };
    } catch {
      clearRunning(key, entry);
      return failure('internal', INTERNAL_MESSAGE);
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
   * Settings -> branch names -> repo root -> worktree path -> base -> worktree
   * -> persisted branch metadata. Every step returns a static failure instead
   * of throwing; nothing is written until the worktree actually exists. The
   * branch patch carries `expectedWorkflow:'fixing'` so a ticket that moved on
   * during the (possibly slow) git work is not overwritten.
   */
  async function prepareWorktree(key, ticket, cwd) {
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

    const repo = await git.repoRoot(cwd);
    if (typeof repo !== 'string' || repo.trim() === '') {
      return { ok: false, failure: gitFailure(repo) };
    }

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
    if (added?.ok === false) return { ok: false, failure: gitFailure(added) };

    let patched;
    try {
      patched = await store.patchTicket(
        key,
        {
          branch: {
            name: branches.personalBranch,
            target: branches.targetBranch,
            baseSource: base.source,
            worktree: tree.path,
            createdAt: readNow(),
          },
        },
        { actionId: nextActionId('fix-branch', key), expectedWorkflow: 'fixing' },
      );
    } catch {
      return { ok: false, failure: failure('internal', INTERNAL_MESSAGE) };
    }

    if (patched?.ok !== true) {
      if (patched?.code === 'stale-workflow') {
        return { ok: false, failure: failure('invalid-state', '工单状态已变化，请刷新后重试') };
      }
      return {
        ok: false,
        failure: failure(
          typeof patched?.code === 'string' ? patched.code : 'internal',
          typeof patched?.message === 'string' ? patched.message : INTERNAL_MESSAGE,
        ),
      };
    }

    return {
      ok: true,
      ticket: patched.ticket,
      worktreePath: tree.path,
      branch: branches.personalBranch,
      target: branches.targetBranch,
    };
  }

  /**
   * Resolve the worktree base: `origin/<target>` when it exists, else the local
   * `<target>`, else `HEAD` (documented fallback for local/demo repositories).
   * The chosen source is recorded in the branch metadata as `baseSource`.
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
   * releases the running entry, and the promise stays in `jobs` until it
   * settles so `dispose()` can drain it.
   */
  function launchJob({ entry, key, sessionId, worktreePath, branch, target, ticket }) {
    const job = run({ entry, key, sessionId, worktreePath, branch, target, ticket });
    jobs.add(job);
    void job
      .finally(() => {
        jobs.delete(job);
        clearRunning(key, entry);
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
        await applyFixResult({ key, worktreePath, startedAt, result });
      } else {
        await applyFixFailure(key, result?.code);
      }
    } catch {
      // The store/domain may already be closing (host unload). The outcome
      // must never escape the background job.
    }
  }

  /** Persist one successful run, then advance the state machine to `fix_done`. */
  async function applyFixResult({ key, worktreePath, startedAt, result }) {
    const current = readTicket(key);
    if (!current.ok || current.ticket.workflow !== 'fixing') {
      await rememberError(key, STALE_FIX_MESSAGE);
      return;
    }

    const collected = await collectChanges(worktreePath, result.result);
    const fixes = Array.isArray(current.ticket.fixes) ? current.ticket.fixes : [];
    const patchActionId = nextActionId('fix-patch', key);
    let finishedAt;
    try {
      finishedAt = readNow();
    } catch {
      finishedAt = new Date().toISOString();
    }
    const fixEntry = {
      runId: patchActionId,
      ...(typeof result.childId === 'string' && result.childId !== ''
        ? { childId: result.childId }
        : {}),
      startedAt,
      finishedAt,
      changedFiles: collected.changedFiles,
      diffStat: collected.diffStat,
      diff: collected.diff,
      summary: result.result.summary,
      testResult: result.result.testResult,
      notes: result.result.notes,
      status: 'succeeded',
      ...(Number.isFinite(result.elapsedMs) ? { elapsedMs: result.elapsedMs } : {}),
    };

    let patched;
    try {
      patched = await store.patchTicket(
        key,
        { fixes: [...fixes, fixEntry] },
        { actionId: patchActionId, expectedWorkflow: 'fixing' },
      );
    } catch {
      await rememberError(key, STALE_FIX_MESSAGE);
      return;
    }
    if (patched?.ok !== true) {
      await rememberError(key, STALE_FIX_MESSAGE);
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
    } catch {
      // Fall through to the static stale error; the workflow is untouched.
    }
    await rememberError(key, STALE_FIX_MESSAGE);
  }

  /**
   * Block the ticket with the mapped reason and persist the static message.
   * `block` is legal from many workflows, so the write carries
   * `expectedWorkflow:'fixing'`: the store re-reads inside its write-queue
   * critical section and refuses (`stale-workflow`) when the ticket already
   * advanced. On a stale refusal only the static meta is written.
   */
  async function applyFixFailure(key, runnerCode) {
    const reason = RUNNER_CODE_TO_REASON[runnerCode] ?? 'fix-failed';
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
   * `git diff` alone would miss new files). `diffStat`/`diff` are clipped by
   * the git module. A failing status/diff read falls back to the runner's own
   * changedFiles and empty diff metadata instead of failing the whole fix.
   */
  async function collectChanges(worktreePath, fixResult) {
    let changedFiles = Array.isArray(fixResult?.changedFiles)
      ? fixResult.changedFiles.slice()
      : [];
    let diffStat = '';
    let diff = '';

    const status = await git.status(worktreePath);
    if (typeof status === 'string') changedFiles = parsePorcelainFiles(status);

    const stat = await git.diffStat(worktreePath);
    if (typeof stat === 'string') diffStat = stat;

    const patch = await git.diff(worktreePath);
    if (typeof patch === 'string') diff = patch;

    return { changedFiles, diffStat, diff };
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
