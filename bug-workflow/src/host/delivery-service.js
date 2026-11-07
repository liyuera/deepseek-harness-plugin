/**
 * Delivery orchestration service for the Bug workflow plugin (P5 Task 3).
 *
 * The service owns 「提交并创建 MR」 for a ticket that already passed manual
 * testing (`submitting`):
 *
 *   lint/test (configured commands, run inside the worktree)
 *     -> git add -A + commit (team message template)
 *     -> git push -u origin <personal branch> (never forced, never protected)
 *     -> findOpenMergeRequest (reuse) or createMergeRequest
 *     -> submit_mr intent + mr_created (conditional on `submitting`)
 *
 * It is pure orchestration over `{store, git, tokenStore, gitlabClientFor,
 * clock, lock, execCommand}` — no Cordis, no storage backend — so the
 * plain-Node test runner can drive a real store, a real temporary git
 * repository and a loopback GitLab mock.
 *
 * Contracts:
 *
 *   - Only `submitting` tickets are accepted (`not-submitting`, HTTP 409).
 *     Delivery is launched after `mark_test_passed`; an earlier/failed state
 *     must never create an MR.
 *   - A GitLab token is mandatory (`missing-gitlab-token`, 503) and is read
 *     through the injected token store; it never appears in a log, message or
 *     persisted record. All settings (base URL + project path) are validated
 *     (`invalid-gitlab-settings`, 400) before any state write.
 *   - The branch metadata written by the fix service is required
 *     (`worktree-missing`, 400): `branch.name`/`branch.target`/
 *     `branch.worktree`, the worktree must exist as a directory below the
 *     resolved repository, and `branch.name` must be pushable
 *     (`protected-branch` / `invalid-branch`, 409/400). Nothing is written for
 *     an invalid request.
 *   - One delivery per ticket and one delivery per repository at a time
 *     (`delivery-busy`, 409). The repository lock is released on every path;
 *     `lock` accepts an injected `{acquire(repo, owner), release(repo, owner)}`
 *     so a later review service can share the same workspace lock.
 *   - Configured lint/test commands run FIRST in the worktree (300 s budget,
 *     bounded output tail). The budget is a HARD limit: on expiry the whole
 *     process group is signalled (SIGTERM, then SIGKILL after a short grace),
 *     a timer-driven fallback settles the promise even when a TERM-ignoring
 *     command or a surviving grandchild still holds the stdio pipes, and the
 *     result is always `ok:false` (never "timed out but exited 0"). A failure
 *     writes the output tail to `meta['delivery.error:<ticket code>']`, blocks
 *     with the static reason `delivery-lint-failed` / `delivery-test-failed`,
 *     and never commits or pushes. Skipped commands are reported in the
 *     `submit_mr` timeline event.
 *   - The branch worktree must be a REGISTERED worktree of the resolved
 *     repository checked out on `branch.name` (`git.probeWorktree === 'same'`).
 *     A plain directory, an unregistered path or a worktree on another branch
 *     is refused with `worktree-missing` / `worktree-conflict` before any
 *     `git add -A`, so a commit can never land on the main worktree or on the
 *     wrong branch. After the commit, the branch ref must resolve to the new
 *     sha (`git.revParse`) before the push, otherwise the ticket blocks with
 *     `worktree-mismatch`.
 *   - The commit message is exactly
 *     `<commitType>: 【jira单号】：<code>，【开发内容】：<summary>`
 *     (`commitType` defaults to `fix`; the summary is `plan.summary`, clipped
 *     to 120 chars, else the ticket title). An empty worktree blocks with
 *     `delivery-no-changes` instead of creating an empty commit — UNLESS a
 *     previous attempt already recorded its commit for this branch
 *     (`meta['delivery.commit:<code>']`) and the branch still points at it, in
 *     which case a retry after a push/MR failure resumes from that sha instead
 *     of short-circuiting. The record is cleared on success.
 *   - `branch.target` must be a safe branch name whose family matches the
 *     personal branch (`feat-*` → `feature-*`, `hot-*` → `hotfix-*`) and must
 *     never be `main`/`master`/`dev`/`develop` or a `release-*` branch
 *     (`invalid-branch`, 400, before any git work). `gitlabProjectPath` is
 *     normalized (`normalizeProject`) before the job starts, so a malformed
 *     non-empty path is a static `invalid-gitlab-settings` instead of a failure
 *     after the push.
 *   - The push target is validated again by `git.pushBranch`; protected
 *     branches are refused before git runs and a push failure blocks with
 *     `push-failed`. `--force` is never used.
 *   - The MR title is exactly `<sourceBranch> -> <targetBranch>`; the
 *     description carries the ticket URL (when present), the plan summary, the
 *     pre-submit check note and the commit sha. An existing open MR for the
 *     same source branch is reused (no duplicate), and `remove_source_branch`
 *     is always false.
 *   - State writes are queued through the store with `expectedWorkflow:
 *     'submitting'`: a ticket that moved on while the MR request was in flight
 *     is never regressed; only a static `delivery.error:<code>` meta is
 *     written. The error namespace is delivery-specific and NEVER touches
 *     `fix.error:<code>` (the P4 fix service owns that key and clears it on its
 *     next start).
 *   - `dispose()` marks running jobs cancelled and aborts them; a cancelled
 *     job performs no block/error/meta write. The drain is bounded.
 *   - Hard boundary: this module never merges, closes, approves, resolves,
 *     deletes or force-pushes anything; the only mutating GitLab call is the
 *     injected `createMergeRequest`.
 */

import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { sep } from 'node:path';

import { isSafeBranchName } from './branch.js';
import { GitError, assertPushableBranch } from './git.js';
import { createGitlabClient, normalizeProject } from './gitlab.js';

/** `meta` key prefix of a persisted delivery error (suffix = ticket code). */
export const DELIVERY_ERROR_META_PREFIX = 'delivery.error:';

/** `meta` key prefix of the commit staged for a retryable delivery. */
export const DELIVERY_COMMIT_META_PREFIX = 'delivery.commit:';

/** Upper bound for one configured lint/test command (5 minutes). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;

/** Persisted command-output tail cap. */
export const COMMAND_OUTPUT_MAX_CHARS = 8_000;

/** `plan.summary` clip applied inside the commit-message template. */
export const DELIVERY_SUMMARY_MAX_CHARS = 120;

/** Upper bound on `dispose()` draining aborted jobs. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 3_000;

/** Grace after SIGTERM before the whole process group gets SIGKILL. */
export const COMMAND_KILL_GRACE_MS = 100;

/** Upper bound for the ticket URL embedded in the MR description. */
export const DESCRIPTION_URL_MAX_CHARS = 2_000;

/** Start refusal while another delivery owns the ticket/repository. */
export const DELIVERY_BUSY_MESSAGE = '当前工作区已有交付任务在执行，请稍后重试';

/** A state write that lost a race against a ticket that moved on. */
export const DELIVERY_STALE_MESSAGE = '交付结果已过期或状态已变化，已丢弃';

/** Static meta message when a state write failed for a non-stale reason. */
export const DELIVERY_SAVE_FAILED_MESSAGE = '交付结果保存失败，请重试（详情见宿主日志）';

/** Block reasons persisted by this service (static, never interpolated). */
export const DELIVERY_REASON_MESSAGES = Object.freeze({
  'delivery-lint-failed': '提交前 lint 未通过，请修复后重试',
  'delivery-test-failed': '提交前测试未通过，请修复后重试',
  'delivery-no-changes': '没有可提交的改动，请确认修复已保存',
  'push-failed': '推送个人分支失败，请检查远程仓库后重试',
  'mr-failed': '创建 GitLab MR 失败，请稍后重试',
  'worktree-mismatch': '提交未落在个人分支上，已停止推送，请重新执行修复',
  'git-failed': '提交失败，请检查工作树后重试',
});

/** Start failure messages (static, client-visible). */
export const DELIVERY_START_MESSAGES = Object.freeze({
  'ticket-not-found': '工单不存在',
  'not-submitting': '工单尚未通过人工测试，不能提交 MR',
  'invalid-code': '缺少有效的工单编号 code',
  'unknown-workspace': '无法确定工作区路径，无法提交 MR',
  'worktree-missing': '未找到可提交的工作树，请先执行修复',
  'worktree-conflict': '工作树当前分支与个人分支不一致，请重新执行修复',
  'invalid-gitlab-settings': 'GitLab 配置无效，请检查 GitLab 地址与项目路径',
  'missing-gitlab-token': '未配置 GitLab token，请先在设置中保存 GitLab token',
  'delivery-busy': DELIVERY_BUSY_MESSAGE,
  'protected-branch': '个人分支受保护，禁止推送',
  'invalid-branch': '个人分支或目标分支不合法，无法提交 MR',
  'git-failed': '无法解析工作区仓库，无法提交 MR',
  'delivery-unavailable': '交付服务不可用，请稍后重试',
  internal: '交付启动失败，请重试',
});

const UNAVAILABLE_MESSAGE = DELIVERY_START_MESSAGES['delivery-unavailable'];
const GIT_FAILED_MESSAGE = DELIVERY_START_MESSAGES['git-failed'];

/**
 * Create the per-repository single-flight lock shared by delivery (and later
 * review-fix) jobs. The contract is intentionally tiny so the host can inject
 * one instance into several services:
 *
 *   lock.acquire(repo, owner) -> boolean  // false when another owner holds it
 *   lock.release(repo, owner)             // no-op unless `owner` still owns it
 *
 * Ownership convention: every service namespaces its owner by service, e.g.
 * `delivery:<code>` / `review:<code>`. Plain ticket codes must not be used:
 * two services for the same ticket would otherwise look like a re-entrant
 * acquire and run concurrently on one repository. A different owner always
 * blocks, even on the same ticket (the state machine already makes delivery and
 * review-fix mutually exclusive, but the lock must not rely on it).
 *
 * @returns {{acquire: Function, release: Function}}
 */
export function createRepoLock() {
  const owners = new Map();
  return {
    acquire(repo, owner) {
      if (typeof repo !== 'string' || repo === '') return false;
      const current = owners.get(repo);
      if (current !== undefined && current !== owner) return false;
      owners.set(repo, owner);
      return true;
    },
    release(repo, owner) {
      if (owners.get(repo) === owner) owners.delete(repo);
    },
  };
}

/**
 * Production `execCommand`: run one configured shell command with `cwd` set to
 * the ticket worktree, a HARD timeout, and a bounded output tail.
 *
 * The command comes from the operator's workspace settings and is deliberately
 * executed through `/bin/sh -c` (it is a shell snippet, not an argv array). Git
 * and GitLab credentials are never added to the environment; a command that
 * prints secrets can only leak into the (bounded) persisted error tail that
 * the operator configured themselves. Windows is not supported by this default
 * (the P5 findings list it as a user-verification item).
 *
 * Timeout handling is deliberately not `child.kill('SIGTERM')` + wait for
 * `close`:
 *
 *   - POSIX children are spawned `detached` so SIGTERM/SIGKILL can target the
 *     whole process group (a shell that exits still leaves npm/jest/server
 *     grandchildren holding the stdout/stderr pipes);
 *   - SIGTERM is followed by SIGKILL after {@link COMMAND_KILL_GRACE_MS};
 *   - a timer settles the promise at `timeoutMs + grace` with
 *     `{ok:false, timedOut:true}` even if `close` never fires, so a
 *     TERM-ignoring command can neither be reported as success nor hang the
 *     delivery job/repo lock;
 *   - an abort (host teardown) also kills the process group and settles fast.
 *
 * @param {{shell?: string}} [options]
 * @returns {(command: string, options?: {cwd?: string, timeoutMs?: number, signal?: AbortSignal}) => Promise<{ok:boolean, output:string, timedOut?:boolean}>}
 */
export function createShellExecCommand(options = {}) {
  const shell = typeof options.shell === 'string' && options.shell.trim() !== ''
    ? options.shell
    : '/bin/sh';

  return function execCommand(command, execOptions = {}) {
    const {
      cwd,
      timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
      signal,
    } = execOptions;

    return new Promise((resolve) => {
      if (typeof command !== 'string' || command.trim() === '') {
        resolve({ ok: false, output: '' });
        return;
      }
      if (typeof cwd !== 'string' || cwd.trim() === '') {
        resolve({ ok: false, output: '' });
        return;
      }

      let child;
      try {
        child = spawn(shell, ['-c', command], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          // Own process group on POSIX so the whole tree can be killed.
          detached: process.platform !== 'win32',
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        resolve({ ok: false, output: '' });
        return;
      }

      let output = '';
      let settled = false;
      let timedOut = false;
      let graceTimer;
      const append = (chunk) => {
        output = tailClip(output + String(chunk), COMMAND_OUTPUT_MAX_CHARS);
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);

      /** Signal the child's whole process group when possible. */
      const killTree = (signalName) => {
        if (typeof child.pid !== 'number' || child.pid <= 0) return;
        if (process.platform !== 'win32') {
          try {
            process.kill(-child.pid, signalName);
            return;
          } catch {
            // Fall through to the single-process kill (e.g. already reaped).
          }
        }
        try {
          child.kill(signalName);
        } catch {
          // The child may already be gone.
        }
      };

      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        child.stdout?.removeAllListeners('data');
        child.stderr?.removeAllListeners('data');
        try {
          child.stdout?.destroy();
          child.stderr?.destroy();
        } catch {
          // Stream teardown is best effort.
        }
        if (signal !== undefined && typeof signal.removeEventListener === 'function') {
          try {
            signal.removeEventListener('abort', onAbort);
          } catch {
            // A hostile signal implementation must not block the settlement.
          }
        }
        // A command that ignored SIGTERM and later exits 0 must never be
        // reported as a passing check.
        resolve(timedOut ? { ok: false, output, timedOut: true } : { ok, output });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree('SIGTERM');
        graceTimer = setTimeout(() => {
          killTree('SIGKILL');
          finish(false);
        }, COMMAND_KILL_GRACE_MS);
      }, timeoutMs);

      const onAbort = () => {
        killTree('SIGKILL');
        finish(false);
      };
      if (signal !== undefined && typeof signal.addEventListener === 'function') {
        if (signal.aborted === true) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('error', () => finish(false));
      child.on('close', (code, killedBy) => finish(code === 0 && killedBy === null && !timedOut));
    });
  };
}

/**
 * Create the delivery service.
 *
 * @param {object} deps
 * @param {object} deps.store opened ticket store
 *   (`get/list/applyAction/patchTicket/getSettings/getMeta/setMeta`)
 * @param {object} deps.git `createGit()` result; delivery uses
 *   `repoRoot`/`probeWorktree`/`revParse`/`commitAll`/`pushBranch`
 * @param {{get: () => Promise<string|null>}} deps.tokenStore GitLab token store
 *   (only `get` is used; the token never leaves the service)
 * @param {(settings: object) => object} [deps.gitlabClientFor] per-workspace
 *   GitLab client factory (the Task 2 review M4 contract). Called on every
 *   `start()` with the current workspace settings; a construction failure is
 *   mapped to `invalid-gitlab-settings`.
 * @param {object} [deps.gitlab] alternatively a pre-built client (legacy plan
 *   shape; the factory is preferred because `baseUrl` is per-workspace)
 * @param {Function} [deps.fetchImpl] fetch used by the built-in fallback
 *   factory (global `fetch` by default)
 * @param {(() => string) | {now: () => string}} [deps.clock] action-id clock
 * @param {{acquire: Function, release: Function}} [deps.lock] shared repo lock
 * @param {Function} [deps.execCommand] `(command, {cwd,timeoutMs,signal}) ->
 *   Promise<{ok, output}>`; defaults to {@link createShellExecCommand}
 * @param {number} [deps.commandTimeoutMs] lint/test budget override
 * @param {number} [deps.drainTimeoutMs] bound on `dispose()` draining jobs
 * @param {Function} [deps.log] optional host logger (`{event,error}`); never
 *   receives the token or a raw command output
 * @returns {{
 *   start: (sessionId: string, cwd: string, code: string) => Promise<object>,
 *   status: () => {running: string[], errors: Record<string, string>},
 *   dispose: () => Promise<void>,
 * }}
 */
export function createDeliveryService({
  store,
  git,
  tokenStore,
  gitlabClientFor,
  gitlab,
  fetchImpl,
  clock = defaultClock,
  lock,
  execCommand,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  log = null,
} = {}) {
  assertStore(store);
  assertGit(git);
  assertTokenStore(tokenStore);
  const readNow = normalizeClock(clock);
  const clientFor = normalizeClientFactory({ gitlabClientFor, gitlab, tokenStore, fetchImpl });
  const repoLock = normalizeLock(lock);
  const runCommand = execCommand === undefined ? createShellExecCommand() : execCommand;
  if (typeof runCommand !== 'function') {
    throw new TypeError('createDeliveryService() execCommand must be a function');
  }
  const commandBudgetMs = positiveNumber(commandTimeoutMs) ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const disposeBudgetMs = positiveNumber(drainTimeoutMs) ?? DEFAULT_DRAIN_TIMEOUT_MS;

  /** code -> { controller, cancelled } for deliveries currently running. */
  const running = new Map();
  /** Promises of background jobs that have not settled yet (dispose drain). */
  const jobs = new Set();
  /** Codes known to carry a delivery error (meta is still the source of truth). */
  const errorCodes = new Set();
  /** Action ids already used by this instance (an injected clock can be coarse). */
  const usedActionIds = new Set();
  let duplicateActionIdSuffix = 0;
  let disposed = false;
  let disposePromise;

  /**
   * Start one delivery. Returns after all configuration/state validation and
   * the launch of the background job; lint/test/commit/push/MR happen later.
   *
   * All validations up to and including the GitLab client construction are
   * side-effect free: a rejected request writes NOTHING (no state, no meta, no
   * cache/CHANGELOG mutation).
   *
   * @param {string} sessionId live parent session id (unused by the job, kept
   *   for the route/service contract symmetry with /analyze and /fix)
   * @param {string} cwd resolved workspace path (repository root or a subdir)
   * @param {string} code ticket code
   * @returns {Promise<{ok:true, running:true} | {ok:false, code:string, message:string}>}
   */
  async function start(sessionId, cwd, code) {
    if (disposed) return failure('delivery-unavailable', UNAVAILABLE_MESSAGE);

    const key = normalizeCode(code);
    if (key === undefined) return failure('invalid-code', DELIVERY_START_MESSAGES['invalid-code']);
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      return failure('unknown-workspace', DELIVERY_START_MESSAGES['unknown-workspace']);
    }

    const found = readTicket(key);
    if (!found.ok) {
      return found.reason === 'error'
        ? failure('internal', DELIVERY_START_MESSAGES.internal)
        : failure('ticket-not-found', DELIVERY_START_MESSAGES['ticket-not-found']);
    }
    const ticket = found.ticket;
    if (ticket.workflow !== 'submitting') {
      return failure('not-submitting', DELIVERY_START_MESSAGES['not-submitting']);
    }

    let settings;
    try {
      settings = store.getSettings(cwd);
    } catch {
      return failure('invalid-gitlab-settings', DELIVERY_START_MESSAGES['invalid-gitlab-settings']);
    }
    if (!isUsableGitlabSettings(settings)) {
      return failure('invalid-gitlab-settings', DELIVERY_START_MESSAGES['invalid-gitlab-settings']);
    }
    // A non-empty but syntactically invalid project path (double slash,
    // whitespace, pre-encoded `%2F`, bare segment) would otherwise only fail on
    // the first GitLab call AFTER the commit/push. Validate it here, while the
    // request is still side-effect free.
    const project = normalizeProject(settings.gitlabProjectPath);
    if (project.ok !== true) {
      return failure('invalid-gitlab-settings', DELIVERY_START_MESSAGES['invalid-gitlab-settings']);
    }

    // Read the token before any state write; a missing/unreadable credential
    // is a retryable 503 and must not leave a block/error behind.
    let token;
    try {
      token = await tokenStore.get();
    } catch {
      token = null;
    }
    if (typeof token !== 'string' || token.trim() === '') {
      return failure('missing-gitlab-token', DELIVERY_START_MESSAGES['missing-gitlab-token']);
    }

    const branch = readBranch(ticket);
    if (!branch.ok) return branch.failure;
    let pushableName;
    try {
      pushableName = assertPushableBranch(branch.name);
    } catch (error) {
      const failureCode = error instanceof GitError && error.code === 'protected-branch'
        ? 'protected-branch'
        : 'invalid-branch';
      return failure(failureCode, DELIVERY_START_MESSAGES[failureCode]);
    }
    // The target is persisted metadata: never trust it blindly. A `feat-*`
    // personal branch may only target `feature-*`, `hot-*` only `hotfix-*`, and
    // an integration branch (main/dev/develop, release-*) is never a valid MR
    // target for this workflow.
    if (!isValidDeliveryTarget(pushableName, branch.target)) {
      return failure('invalid-branch', DELIVERY_START_MESSAGES['invalid-branch']);
    }

    let worktreeStat;
    try {
      worktreeStat = await stat(branch.worktree);
    } catch {
      worktreeStat = null;
    }
    if (worktreeStat === null || worktreeStat.isDirectory() !== true) {
      return failure('worktree-missing', DELIVERY_START_MESSAGES['worktree-missing']);
    }

    // Per-workspace client construction: the settings are read from THIS
    // workspace, and an invalid base URL/project path is a static 400 (never an
    // unhandled GitlabError from index startup).
    let client;
    try {
      client = clientFor(settings);
    } catch {
      client = null;
    }
    if (!isUsableGitlabClient(client)) {
      return failure('invalid-gitlab-settings', DELIVERY_START_MESSAGES['invalid-gitlab-settings']);
    }

    if (disposed) return failure('delivery-unavailable', UNAVAILABLE_MESSAGE);
    if (running.has(key)) return failure('delivery-busy', DELIVERY_BUSY_MESSAGE);

    // The per-repository lock key is the real main repository root (a linked
    // worktree resolves to itself, so lock through the session cwd instead).
    let repo;
    try {
      repo = await git.repoRoot(cwd);
    } catch {
      repo = undefined;
    }
    if (typeof repo !== 'string' || repo.trim() === '') {
      return failure('git-failed', GIT_FAILED_MESSAGE);
    }
    // `git rev-parse --show-toplevel` returns a real path; the stored worktree
    // may go through a symlinked tmp/workspace root (e.g. macOS /var ->
    // /private/var), so compare real paths instead of raw strings.
    const [repoReal, worktreeReal] = await Promise.all([
      realpathOrSelf(repo),
      realpathOrSelf(branch.worktree),
    ]);
    if (!isInsideRepo(repoReal, worktreeReal)) {
      return failure('worktree-missing', DELIVERY_START_MESSAGES['worktree-missing']);
    }

    // The stored `branch.worktree` is persisted metadata, not proof: a plain
    // directory below the repo would make `git -C` resolve to the MAIN
    // worktree, and a worktree checked out on another branch would commit to
    // the wrong ref. Require a registered worktree on exactly `branch.name`
    // BEFORE anything is staged or committed.
    const probe = await git.probeWorktree(repo, branch.worktree, pushableName);
    if (probe === null || typeof probe !== 'object' || probe.ok !== true) {
      return failure('git-failed', GIT_FAILED_MESSAGE);
    }
    if (probe.state === 'different') {
      return failure('worktree-conflict', DELIVERY_START_MESSAGES['worktree-conflict']);
    }
    if (probe.state !== 'same') {
      return failure('worktree-missing', DELIVERY_START_MESSAGES['worktree-missing']);
    }

    if (disposed) return failure('delivery-unavailable', UNAVAILABLE_MESSAGE);
    if (running.has(key)) return failure('delivery-busy', DELIVERY_BUSY_MESSAGE);
    // Namespaced owner: a future review-fix job shares this lock instance with
    // `review:<code>` and must not accidentally be treated as re-entrant with
    // a delivery for the same ticket code.
    const lockOwner = `delivery:${key}`;
    if (!repoLock.acquire(repo, lockOwner)) {
      return failure('delivery-busy', DELIVERY_BUSY_MESSAGE);
    }

    const entry = { controller: new AbortController(), cancelled: false };
    running.set(key, entry);
    const job = runDelivery({
      entry,
      key,
      ticket,
      settings,
      branch,
      client,
    });
    jobs.add(job);
    void job
      .finally(() => {
        jobs.delete(job);
        if (running.get(key) === entry) running.delete(key);
        repoLock.release(repo, lockOwner);
      })
      .catch(() => {
        // runDelivery contains every failure; belt-and-braces only.
      });

    return { ok: true, running: true };
  }

  /**
   * One background delivery. Never rejects, never writes after cancellation,
   * and releases the running/lock slots through the caller's `finally`.
   */
  async function runDelivery({ entry, key, ticket, settings, branch, client }) {
    let checks;
    try {
      const lint = await runCheck(settings.lintCommand, entry, branch.worktree);
      if (entry.cancelled || lint.status === 'cancelled') return;
      if (lint.status === 'failed') {
        await failDelivery(key, 'delivery-lint-failed', lint.output);
        return;
      }

      const test = await runCheck(settings.testCommand, entry, branch.worktree);
      if (entry.cancelled || test.status === 'cancelled') return;
      if (test.status === 'failed') {
        await failDelivery(key, 'delivery-test-failed', test.output);
        return;
      }
      checks = { lint: lint.status, test: test.status };

      const message = buildCommitMessage(settings, key, ticket);
      const committed = await git.commitAll({ root: branch.worktree, message });
      if (entry.cancelled) return;
      if (isPlainObject(committed) === false || committed.ok !== true) {
        await failDelivery(key, 'git-failed', '');
        return;
      }

      let sha;
      if (committed.sha === null) {
        // The worktree is clean. That is a genuine no-op on a first delivery,
        // but on a retry after `push-failed`/`mr-failed` the commit already
        // exists: resume from the recorded sha (the branch ref is verified
        // below) instead of blocking before the push/MR can be retried.
        const recorded = readRecordedCommit(key, branch);
        if (recorded === undefined) {
          await failDelivery(key, 'delivery-no-changes', '');
          return;
        }
        sha = recorded.sha;
      } else {
        sha = committed.sha;
        // Persist BEFORE the push: if the push/MR fails, the retry must find
        // this commit instead of hitting `delivery-no-changes`.
        await rememberCommit(key, {
          sha,
          worktree: branch.worktree,
          branch: branch.name,
          message,
        });
        if (entry.cancelled) return;
      }

      // Second identity gate: the ref we are about to push must resolve to the
      // commit we just staged. This also catches a `git -C` surprise where the
      // commit landed somewhere other than the personal branch.
      const head = await git.revParse(branch.worktree, branch.name);
      if (entry.cancelled) return;
      if (typeof head !== 'string' || head !== sha) {
        await failDelivery(key, 'worktree-mismatch', '');
        return;
      }

      const pushed = await git.pushBranch({
        root: branch.worktree,
        remote: 'origin',
        branch: branch.name,
      });
      if (entry.cancelled) return;
      if (isPlainObject(pushed) === false || pushed.ok !== true) {
        await failDelivery(key, 'push-failed', '');
        return;
      }

      let mr;
      try {
        const existing = await client.findOpenMergeRequest({
          project: settings.gitlabProjectPath,
          sourceBranch: branch.name,
        });
        if (existing !== null && existing !== undefined) {
          if (
            typeof existing.targetBranch === 'string'
            && existing.targetBranch !== ''
            && existing.targetBranch !== branch.target
          ) {
            // Reusing an MR into a different target branch would silently
            // deliver to the wrong integration branch.
            await failDelivery(key, 'mr-failed', '');
            return;
          }
          mr = existing;
        } else {
          mr = await client.createMergeRequest({
            project: settings.gitlabProjectPath,
            sourceBranch: branch.name,
            targetBranch: branch.target,
            title: `${branch.name} -> ${branch.target}`,
            description: buildDescription({ ticket, sha, checks }),
          });
        }
      } catch (error) {
        notifyLog(log, 'delivery-mr', error);
        if (entry.cancelled) return;
        await failDelivery(key, 'mr-failed', '');
        return;
      }
      if (entry.cancelled) return;

      await persistDelivered({ key, branch, mr, checks, sha });
    } catch (error) {
      notifyLog(log, 'delivery-job', error);
      if (entry.cancelled) return;
      await rememberError(key, DELIVERY_SAVE_FAILED_MESSAGE);
    }
  }

  /**
   * Run one configured pre-submit command. An empty command is `skipped` (the
   * UI/timeline records 「未配置 lint/test」); a non-zero exit/thrown executor
   * is `failed` with the bounded output tail.
   */
  async function runCheck(command, entry, worktree) {
    if (typeof command !== 'string' || command.trim() === '') {
      return { status: 'skipped' };
    }

    let result;
    try {
      result = await runCommand(command, {
        cwd: worktree,
        timeoutMs: commandBudgetMs,
        signal: entry.controller.signal,
      });
    } catch {
      result = { ok: false, output: '' };
    }
    if (entry.cancelled) return { status: 'cancelled' };
    if (isPlainObject(result) && result.ok === true) return { status: 'passed' };
    const output = isPlainObject(result) && typeof result.output === 'string'
      ? result.output
      : '';
    return { status: 'failed', output: tailClip(output, COMMAND_OUTPUT_MAX_CHARS) };
  }

  /**
   * Block the ticket with the static reason and persist the delivery error.
   * The block write carries `expectedWorkflow:'submitting'`: a ticket that
   * already moved on is left untouched (only the meta is written).
   */
  async function failDelivery(key, reason, output) {
    if (disposed) return;
    const message = buildFailureMessage(reason, output);
    try {
      await store.applyAction(
        key,
        'block',
        { reason, actor: 'system' },
        { expectedWorkflow: 'submitting' },
      );
    } catch {
      // A block that lost a race (or a closing store) is not an error.
    }
    await rememberError(key, message);
  }

  /**
   * Persist the successful delivery: `submit_mr` intent, `mr_created` (the only
   * action that moves the ticket to `mr_open`), then the review-round ledger
   * initialization. Every write is conditional on the expected workflow, so a
   * late result cannot regress a ticket that moved on.
   */
  async function persistDelivered({ key, branch, mr, checks, sha }) {
    const submitMessage = buildSkippedCheckMessage(checks);
    let submitted;
    try {
      submitted = await store.applyAction(
        key,
        'submit_mr',
        {
          actor: 'system',
          ...(submitMessage === undefined ? {} : { message: submitMessage }),
        },
        { actionId: nextActionId('deliver-submit', key), expectedWorkflow: 'submitting' },
      );
    } catch {
      await rememberError(key, DELIVERY_SAVE_FAILED_MESSAGE);
      return;
    }
    if (submitted?.ok !== true) {
      await rememberError(key, writeFailureMessage(submitted));
      return;
    }

    const previous = isPlainObject(submitted.ticket?.mr) ? submitted.ticket.mr : {};
    const created = await applyConditional(key, 'mr_created', {
      actor: 'system',
      mr: {
        iid: mr.iid ?? previous.iid ?? null,
        url: typeof mr.url === 'string' && mr.url !== '' ? mr.url : null,
        sourceBranch: typeof mr.sourceBranch === 'string' && mr.sourceBranch !== ''
          ? mr.sourceBranch
          : branch.name,
        targetBranch: typeof mr.targetBranch === 'string' && mr.targetBranch !== ''
          ? mr.targetBranch
          : branch.target,
        state: typeof mr.state === 'string' && mr.state !== '' ? mr.state : 'opened',
        verdict: typeof previous.verdict === 'string' ? previous.verdict : 'unknown',
        blockingIssues: Array.isArray(previous.blockingIssues) ? previous.blockingIssues : [],
        nonBlockingIssues: Array.isArray(previous.nonBlockingIssues)
          ? previous.nonBlockingIssues
          : [],
      },
    }, 'deliver-mr');
    if (created?.ok !== true) {
      await rememberError(key, writeFailureMessage(created));
      return;
    }

    // `reviewRounds` is not part of the state machine: initialize the ledger
    // once, conditionally on `mr_open`, so Task 4 can append rounds.
    const current = readTicket(key);
    if (
      current.ok
      && current.ticket.workflow === 'mr_open'
      && !Array.isArray(current.ticket.reviewRounds)
    ) {
      try {
        await store.patchTicket(
          key,
          { reviewRounds: [] },
          { actionId: nextActionId('deliver-rounds', key), expectedWorkflow: 'mr_open' },
        );
      } catch {
        // The MR is already persisted; a ledger-initialization failure must not
        // turn a successful delivery into a visible error.
      }
    }

    notifyLog(log, 'delivery-done', { code: key, sha, iid: mr.iid ?? null, url: mr.url ?? null });
    await clearError(key);
    // The retry record has served its purpose; a future delivery of this ticket
    // starts from a fresh commit.
    await clearCommit(key);
  }

  /** Apply an action with a generated actionId and `expectedWorkflow:'submitting'`. */
  async function applyConditional(key, action, payload, prefix) {
    try {
      return await store.applyAction(key, action, payload, {
        actionId: nextActionId(prefix, key),
        expectedWorkflow: 'submitting',
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Snapshot view: currently running codes plus persisted static delivery
   * errors read from `meta['delivery.error:<code>']` for every stored ticket.
   * A store read failure degrades to the in-memory set.
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
   * Cancel every running delivery and drain it. Each entry is marked
   * `cancelled` BEFORE the abort, so the job writes no block/error/meta:
   * plugin unload is not a delivery failure and the ticket stays `submitting`
   * for the next host load. Idempotent and bounded.
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
    disposePromise = drainJobs([...jobs], disposeBudgetMs);
    return disposePromise;
  }

  function rememberError(key, message) {
    errorCodes.add(key);
    try {
      return store.setMeta(DELIVERY_ERROR_META_PREFIX + key, message).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  function clearError(key) {
    errorCodes.delete(key);
    try {
      return store.setMeta(DELIVERY_ERROR_META_PREFIX + key, null).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  /**
   * Record the commit staged for this ticket/branch. Persisted before the
   * push so a push/MR failure remains retryable; best effort (a metadata write
   * failure must not turn a successful delivery into an error).
   */
  function rememberCommit(key, record) {
    try {
      return store.setMeta(DELIVERY_COMMIT_META_PREFIX + key, record).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  /** Forget the retry record after a successful delivery. */
  function clearCommit(key) {
    try {
      return store.setMeta(DELIVERY_COMMIT_META_PREFIX + key, null).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  /**
   * Read the commit recorded by a previous attempt, but only when it was
   * staged for THIS worktree and THIS personal branch. A corrupt/foreign
   * record is ignored (falls back to `delivery-no-changes`).
   */
  function readRecordedCommit(key, branch) {
    let value;
    try {
      value = store.getMeta(DELIVERY_COMMIT_META_PREFIX + key);
    } catch {
      return undefined;
    }
    if (!isPlainObject(value)) return undefined;
    if (typeof value.sha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(value.sha)) return undefined;
    if (value.worktree !== branch.worktree || value.branch !== branch.name) return undefined;
    return value;
  }

  function readPersistedError(key) {
    let value;
    try {
      value = store.getMeta(DELIVERY_ERROR_META_PREFIX + key);
    } catch {
      return undefined;
    }
    if (typeof value !== 'string' || value === '') return undefined;
    errorCodes.add(key);
    return value;
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

  return { start, status, dispose };
}

// ---------------------------------------------------------------------------
// Pure builders / validation / helpers
// ---------------------------------------------------------------------------

/** The exact team commit-message template (single line, bounded summary). */
export function buildCommitMessage(settings, code, ticket) {
  const type = typeof settings?.commitType === 'string' && settings.commitType.trim() !== ''
    ? settings.commitType.trim()
    : 'fix';
  const summary = resolveSummary(ticket);
  return `${type}: 【jira单号】：${code}，【开发内容】：${summary}`;
}

/**
 * Description body for the created MR: ticket URL (when present), plan summary,
 * the pre-submit check note and the commit sha. All values are normalized to a
 * single line so a ticket/plan text cannot forge extra markdown sections.
 */
export function buildDescription({ ticket, sha, checks }) {
  const lines = [];
  const url = normalizeOneLine(ticket?.url ?? '', DESCRIPTION_URL_MAX_CHARS);
  if (url !== '') lines.push(`工单：${url}`);
  const summary = planSummary(ticket);
  if (summary !== '') lines.push(`方案摘要：${summary}`);
  lines.push(`提交前检查：${buildCheckNote(checks)}`);
  lines.push(`提交：${sha}`);
  return lines.join('\n');
}

/** `提交前检查` note, e.g. `lint 已通过，未配置 test`. */
export function buildCheckNote(checks) {
  const lint = checks?.lint === 'skipped' ? '未配置 lint' : 'lint 已通过';
  const test = checks?.test === 'skipped' ? '未配置 test' : 'test 已通过';
  return `${lint}，${test}`;
}

/** `submit_mr` timeline note for skipped checks, or undefined when both ran. */
export function buildSkippedCheckMessage(checks) {
  const skipped = [];
  if (checks?.lint === 'skipped') skipped.push('lint');
  if (checks?.test === 'skipped') skipped.push('test');
  if (skipped.length === 0) return undefined;
  return `提交 MR（未配置 ${skipped.join('/')}）`;
}

/** Plan summary clipped for the MR description (never the 120-char commit cap). */
function planSummary(ticket) {
  const value = ticket?.plan?.summary;
  return isPlainObject(ticket?.plan) && typeof value === 'string'
    ? normalizeOneLine(value, 4_000)
    : '';
}

/** Commit summary: `plan.summary` clipped to 120 chars, else the title, else code. */
function resolveSummary(ticket) {
  const plan = isPlainObject(ticket?.plan) && typeof ticket.plan.summary === 'string'
    ? ticket.plan.summary
    : '';
  const title = typeof ticket?.title === 'string' ? ticket.title : '';
  const source = plan.trim() !== '' ? plan : title;
  const summary = normalizeOneLine(source, DELIVERY_SUMMARY_MAX_CHARS);
  return summary !== '' ? summary : normalizeOneLine(String(ticket?.code ?? ''), DELIVERY_SUMMARY_MAX_CHARS);
}

/** Collapse control characters/line breaks into spaces and clip to `max`. */
function normalizeOneLine(value, max) {
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text.length <= max ? text : text.slice(0, max);
}

/** Static reason text plus the bounded command-output tail (lint/test only). */
function buildFailureMessage(reason, output) {
  const base = DELIVERY_REASON_MESSAGES[reason] ?? DELIVERY_SAVE_FAILED_MESSAGE;
  const tail = typeof output === 'string' ? output.trim() : '';
  return tail === '' ? base : `${base}\n${tail}`;
}

/** Static meta message for a failed store write (stale vs save failure). */
function writeFailureMessage(result) {
  return result?.code === 'stale-workflow' ? DELIVERY_STALE_MESSAGE : DELIVERY_SAVE_FAILED_MESSAGE;
}

/** Keep only the last `max` characters of a command's output. */
function tailClip(value, max) {
  const text = typeof value === 'string' ? value : '';
  return text.length <= max ? text : text.slice(-max);
}

function normalizeCode(code) {
  if (typeof code !== 'string') return undefined;
  const trimmed = code.trim();
  return trimmed === '' ? undefined : trimmed;
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

/** `realpath` with a fallback to the input (a broken link still gets checked). */
async function realpathOrSelf(path) {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** Both GitLab settings are required; whitespace-only counts as unset. */
function isUsableGitlabSettings(settings) {
  return isPlainObject(settings)
    && typeof settings.gitlabBaseUrl === 'string'
    && settings.gitlabBaseUrl.trim() !== ''
    && typeof settings.gitlabProjectPath === 'string'
    && settings.gitlabProjectPath.trim() !== '';
}

/** Integration branches that may never be the target of an automatic MR. */
const FORBIDDEN_TARGET_EXACT = new Set(['main', 'master', 'dev', 'develop']);

/**
 * True for the `{personal, target}` pair written by the fix service:
 *
 *   - target is a syntactically safe branch name;
 *   - target is not the personal branch itself;
 *   - target is not an integration branch (`main`/`master`/`dev`/`develop`)
 *     and not the protected `release-*` family;
 *   - family consistency: `feat-*` personal branches deliver to `feature-*`,
 *     `hot-*` personal branches to `hotfix-*`. Custom personal branches keep
 *     the (non-protected) target the operator recorded.
 *
 * `personal` is the value returned by `assertPushableBranch` (refs/heads/
 * stripped). This is defense in depth: `branch.target` is persisted metadata
 * that a hand edit or a future override UI could otherwise point at `main`.
 */
function isValidDeliveryTarget(personal, target) {
  if (!isSafeBranchName(target)) return false;
  if (personal === target) return false;
  const lower = target.toLowerCase();
  if (FORBIDDEN_TARGET_EXACT.has(lower)) return false;
  if (/^release(?:[-/]|$)/i.test(lower)) return false;

  const personalLower = personal.toLowerCase();
  if (personalLower.startsWith('feat-')) return lower.startsWith('feature-');
  if (personalLower.startsWith('hot-')) return lower.startsWith('hotfix-');
  return true;
}

function isUsableGitlabClient(client) {
  return isPlainObject(client)
    && typeof client.findOpenMergeRequest === 'function'
    && typeof client.createMergeRequest === 'function';
}

/** Branch metadata written by the fix service (P4). */
function readBranch(ticket) {
  const branch = isPlainObject(ticket?.branch) ? ticket.branch : null;
  if (
    branch === null
    || typeof branch.name !== 'string'
    || branch.name.trim() === ''
    || typeof branch.target !== 'string'
    || branch.target.trim() === ''
    || typeof branch.worktree !== 'string'
    || branch.worktree.trim() === ''
  ) {
    return {
      ok: false,
      failure: failure('worktree-missing', DELIVERY_START_MESSAGES['worktree-missing']),
    };
  }
  return {
    ok: true,
    name: branch.name.trim(),
    target: branch.target.trim(),
    worktree: branch.worktree,
  };
}

function assertStore(store) {
  if (store === null || typeof store !== 'object') {
    throw new TypeError('createDeliveryService() requires an opened store');
  }
  for (const method of [
    'get',
    'list',
    'applyAction',
    'patchTicket',
    'getSettings',
    'getMeta',
    'setMeta',
  ]) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(`createDeliveryService() store.${method} must be a function`);
    }
  }
}

function assertGit(git) {
  if (git === null || typeof git !== 'object') {
    throw new TypeError('createDeliveryService() requires a git executor');
  }
  for (const method of [
    'repoRoot',
    'probeWorktree',
    'revParse',
    'commitAll',
    'pushBranch',
  ]) {
    if (typeof git[method] !== 'function') {
      throw new TypeError(`createDeliveryService() git.${method} must be a function`);
    }
  }
}

function assertTokenStore(tokenStore) {
  if (tokenStore === null || typeof tokenStore !== 'object' || typeof tokenStore.get !== 'function') {
    throw new TypeError('createDeliveryService() requires a token store with get()');
  }
}

/**
 * Resolve the GitLab client factory. Preferred shape (Task 2 review M4):
 * `gitlabClientFor(settings)` builds a client per workspace because the base
 * URL is a per-workspace setting. A pre-built client object is still accepted
 * for direct tests, and the built-in fallback uses the injected token store.
 */
function normalizeClientFactory({ gitlabClientFor, gitlab, tokenStore, fetchImpl }) {
  if (typeof gitlabClientFor === 'function') {
    return (settings) => gitlabClientFor(settings);
  }
  if (isPlainObject(gitlab)) {
    return () => gitlab;
  }
  return (settings) => createGitlabClient({
    baseUrl: settings.gitlabBaseUrl,
    tokenProvider: () => tokenStore.get(),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}

/** Normalize the injected shared repo lock (or create a private one). */
function normalizeLock(lock) {
  if (lock === undefined || lock === null) return createRepoLock();
  if (
    typeof lock !== 'object'
    || typeof lock.acquire !== 'function'
    || typeof lock.release !== 'function'
  ) {
    throw new TypeError(
      'createDeliveryService() lock must expose acquire(repo, owner) and release(repo, owner)',
    );
  }
  return lock;
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
  throw new TypeError('createDeliveryService() requires a clock function or {now()}');
}

function defaultClock() {
  return new Date().toISOString();
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Best-effort logger; never receives tokens, never changes the outcome. */
function notifyLog(log, event, detail) {
  if (typeof log !== 'function') return;
  try {
    log({ event, error: detail });
  } catch {
    // Diagnostics only.
  }
}

/**
 * Wait for every job to settle, but never longer than `timeoutMs`. Used by
 * `dispose()` so a command that ignores its abort signal cannot hang unload.
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
