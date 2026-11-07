/**
 * AI Review polling + review-fix runs + merge detection / auto-archive
 * (P5 Task 4b).
 *
 * The service is timer-driven (60 s by default) and owns everything that
 * happens AFTER a delivery put the ticket into `mr_open`:
 *
 *   merged detection
 *     mergeable  --mr_merged--> merged --dismiss(system)--> done (leaves board)
 *     mr_open / fixing_review + merged externally
 *                --block('review-merged-manually')--> blocked
 *
 *   newest AI Code Review note (deduped by note id)
 *     pass     --review_pass--> mergeable
 *     changes  --review_requests_changes--> fixing_review
 *                 -> ONE background review-fix subagent in the ticket worktree
 *                 -> host commit + push
 *                 -> fixes[]/reviewRounds[] append + review_fix_done --> mr_open
 *     unknown  --block('review-parse-failed')--> blocked (no auto-retry)
 *
 * Contracts:
 *
 *   - `tick()` is public and testable; `start(timer)` only registers the
 *     interval (`timer.interval(callback, delay)` returns a disposer). The
 *     service never ticks on `start()` and never overlaps ticks (single-flight:
 *     a call made while a tick runs returns that same promise).
 *   - The timer has no live session/workspace, so every ticket is processed
 *     from the bounded `meta['delivery.context:<code>']` record written by the
 *     delivery service: `{sessionId, cwd, gitlabBaseUrl, gitlabProjectPath,
 *     commitType}`. A missing/invalid record only writes the static
 *     `review.error:<code>` message 「缺少交付上下文，请重新交付」 and never
 *     mutates the workflow.
 *   - No GitLab token (`tokenStore.get()` returns null/throws) means NO request
 *     and NO write at all: the tick is a silent no-op.
 *   - The newest note whose body carries the AI marker AND a `结论:` line is
 *     the only candidate (system notes are skipped). It is deduped by id via
 *     `meta['review.last-note:<code>']`, so the same note never triggers a
 *     second fix round. `parseReview()` is the canonical parser; only an
 *     AI-target note that parses to `unknown` blocks (template drift).
 *   - `review_requests_changes` increments `mr.rounds` (state machine). A 4th
 *     changes request at `MAX_REVIEW_ROUNDS` (3) blocks with
 *     `review-rounds-exhausted` instead of transitioning. A successful
 *     `review_fix_done` must NOT increment rounds a second time.
 *   - The review-fix job requires the stored worktree to be a REGISTERED
 *     worktree of the ticket repository checked out on `branch.name`
 *     (`git.probeWorktree === 'same'`). Otherwise it blocks
 *     `review-fix-failed` before any git write. On success the host (not the
 *     child) runs `git add -A`/commit/revParse/push; a clean worktree blocks
 *     `review-fix-no-changes`.
 *   - Jobs share the injected repository single-flight lock with delivery
 *     (`owner = review:<code>`), so a delivery and a review-fix can never touch
 *     the same repository at once. The lock is acquired BEFORE the
 *     `review_requests_changes` transition and released on every path; a busy
 *     lock simply skips the ticket for this tick (the note stays unprocessed).
 *   - Every state write goes through the store write queue with
 *     `expectedWorkflow`; late results never regress a moved ticket. `dispose()`
 *     clears the interval, marks running jobs cancelled, aborts them and writes
 *     NO state (no block/error/meta).
 *   - Hard boundary: this module never calls createMergeRequest/merge/close/
 *     approve/resolve or force-pushes; the only mutating GitLab call is none —
 *     the client is used read-only (`getMergeRequest` + `listNotes`).
 */

import {
  DELIVERY_CONTEXT_META_PREFIX,
  buildCommitMessage,
  createRepoLock,
} from './delivery-service.js';
import { MAX_REVIEW_ROUNDS } from './protocol.js';
import { parseReview } from './review-parser.js';

/** `meta` key prefix of a persisted review error (suffix = ticket code). */
export const REVIEW_ERROR_META_PREFIX = 'review.error:';

/** `meta` key prefix of the last processed AI review note id. */
export const REVIEW_LAST_NOTE_META_PREFIX = 'review.last-note:';

/** Default poll cadence (60 s). */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/** Upper bound on `dispose()` draining aborted review-fix jobs. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 3_000;

/** Persisted `diff` excerpt cap for a review-fix run (schema bound is 8 000). */
export const REVIEW_DIFF_MAX_CHARS = 4_000;

/** Free-text cap for summary/testResult/notes persisted in `fixes[]`. */
export const REVIEW_TEXT_MAX_CHARS = 8_000;

/** Bounds mirrored from the host `fixRunSchema` / `reviewRoundSchema`. */
export const REVIEW_CHANGED_FILES_MAX = 2_000;
export const REVIEW_CHANGED_FILE_MAX_CHARS = 4_096;
export const REVIEW_CHILD_ID_MAX_CHARS = 200;
export const REVIEW_DIFF_STAT_MAX_CHARS = 4_000;

/** Static context failures (client-visible via `snapshot.review.errors`). */
export const REVIEW_CONTEXT_MISSING_MESSAGE = '缺少交付上下文，请重新交付';
export const REVIEW_GITLAB_CONFIG_MESSAGE = 'GitLab 配置无效，请重新交付';
export const REVIEW_WORKSPACE_FAILED_MESSAGE = '无法解析工作区仓库，请稍后重试';
export const REVIEW_MR_FETCH_FAILED_MESSAGE = '获取 MR 状态失败，请稍后重试';
export const REVIEW_NOTES_FETCH_FAILED_MESSAGE = '获取 MR 评论失败，请稍后重试';
export const REVIEW_SAVE_FAILED_MESSAGE = 'Review 结果保存失败，请重试（详情见宿主日志）';
export const REVIEW_STALE_MESSAGE = 'Review 结果已过期或状态已变化，已丢弃';

/** Block reasons persisted by this service (static, never interpolated). */
export const REVIEW_REASON_MESSAGES = Object.freeze({
  'review-parse-failed': 'AI Review 结论解析失败，请人工检查 MR 评论',
  'review-rounds-exhausted': `AI Review 修复已满 ${MAX_REVIEW_ROUNDS} 轮，需人工介入`,
  'review-fix-failed': 'AI Review 修复失败，请检查工作区后重试',
  'review-fix-no-changes': 'AI Review 修复未产生改动，请人工检查',
  'review-merged-manually': 'MR 在 AI Review 通过前被合并，请人工确认',
});

/** Workflows the poller owns. `mergeable`/`merged` are merge-detection only. */
const POLLABLE_WORKFLOWS = new Set(['mr_open', 'fixing_review', 'mergeable', 'merged']);

/** The AI note marker (same string the canonical parser requires). */
const AI_MARKER = 'AI Code Review';

/** Conclusion line marker; both marker and conclusion must be present. */
const VERDICT_MARKER_RE = /结论[ \t]*[:：]/;

const EMPTY_TICK = Object.freeze({ checked: 0, transitioned: 0 });

/**
 * Create the review service.
 *
 * @param {object} deps
 * @param {object} deps.store opened ticket store
 *   (`get/list/applyAction/patchTicket/getMeta/setMeta`)
 * @param {object} deps.git `createGit()` result; review uses
 *   `repoRoot`/`probeWorktree`/`status`/`diffStat`/`diff`/`commitAll`/
 *   `revParse`/`pushBranch`
 * @param {object} deps.runner `createAgentRunner()` result (`runReviewFix`)
 * @param {{get: () => Promise<string|null>}} deps.tokenStore GitLab token store
 *   (only `get` is used; the token never leaves the client/token store)
 * @param {(settings: {gitlabBaseUrl: string, gitlabProjectPath: string}) => object}
 *   deps.gitlabClientFor per-workspace GitLab client factory (read-only client:
 *   `getMergeRequest` + `listNotes`)
 * @param {(() => string) | {now: () => string}} [deps.clock] action-id/run clock
 * @param {{acquire: Function, release: Function}} [deps.lock] shared repo lock
 *   (defaults to a private `createRepoLock()`; the host injects the same
 *   instance it gives the delivery service)
 * @param {Function} [deps.getSettings] accepted for wiring symmetry; the
 *   delivery context is the source of truth for the timer path
 * @param {number} [deps.pollIntervalMs] interval passed to `start(timer)`
 * @param {number} [deps.drainTimeoutMs] bound on `dispose()` draining jobs
 * @param {Function} [deps.log] optional host logger (`{event,error}`); never
 *   receives the token or raw note bodies
 * @returns {{
 *   start: (timer: {interval: Function}) => boolean,
 *   tick: () => Promise<{checked: number, transitioned: number}>,
 *   status: () => {running: string[], errors: Record<string, string>},
 *   dispose: () => Promise<void>,
 * }}
 */
export function createReviewService({
  store,
  git,
  runner,
  tokenStore,
  gitlabClientFor,
  clock = defaultClock,
  lock,
  getSettings, // eslint-disable-line no-unused-vars -- reserved wiring symmetry
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  log = null,
} = {}) {
  assertStore(store);
  assertGit(git);
  assertRunner(runner);
  assertTokenStore(tokenStore);
  if (typeof gitlabClientFor !== 'function') {
    throw new TypeError('createReviewService() gitlabClientFor must be a function');
  }
  const readNow = normalizeClock(clock);
  const repoLock = normalizeLock(lock);
  const intervalMs = positiveNumber(pollIntervalMs) ?? DEFAULT_POLL_INTERVAL_MS;
  const disposeBudgetMs = positiveNumber(drainTimeoutMs) ?? DEFAULT_DRAIN_TIMEOUT_MS;

  /** code -> { controller, cancelled } for review-fix jobs currently running. */
  const fixJobs = new Map();
  /** Promises of background jobs that have not settled yet (dispose drain). */
  const jobs = new Set();
  /** Codes known to carry a review error (meta is still the source of truth). */
  const errorCodes = new Set();
  /** Action ids already used by this instance (an injected clock can be coarse). */
  const usedActionIds = new Set();
  let duplicateActionIdSuffix = 0;
  let disposed = false;
  let disposePromise;
  let tickPromise;
  let pollDisposer;

  /**
   * Register the poll interval. Idempotent; a disposed service never starts.
   * The timer contract is `{interval(callback, delay) -> disposer}` — the same
   * optional service `index.js` reads with `readTimer()`.
   *
   * @param {{interval: Function}} timer
   * @returns {boolean} true when the interval is registered
   */
  function start(timer) {
    if (disposed) return false;
    if (pollDisposer !== undefined) return true;
    if (
      timer === null
      || typeof timer !== 'object'
      || typeof timer.interval !== 'function'
    ) {
      throw new TypeError('createReviewService() start(timer) requires interval(callback, delay)');
    }
    const disposer = timer.interval(() => {
      void tick();
    }, intervalMs);
    pollDisposer = typeof disposer === 'function' ? disposer : () => {};
    return true;
  }

  /**
   * One polling pass. Serial (one ticket at a time), single-flight (a call made
   * while another runs joins it) and never throws: a terminal GitLab/runner
   * failure is a static `review.error` or a `block`, and an unexpected error is
   * caught per ticket so the remaining tickets still get their turn.
   *
   * @returns {Promise<{checked: number, transitioned: number}>}
   */
  function tick() {
    if (disposed) return Promise.resolve({ ...EMPTY_TICK });
    if (tickPromise !== undefined) return tickPromise;
    const run = runTick().catch(() => ({ ...EMPTY_TICK }));
    tickPromise = run.finally(() => {
      tickPromise = undefined;
    });
    return tickPromise;
  }

  async function runTick() {
    if (disposed) return { ...EMPTY_TICK };
    if (!(await hasToken())) return { ...EMPTY_TICK };
    if (disposed) return { ...EMPTY_TICK };

    const tickets = scanTickets();
    let checked = 0;
    let transitioned = 0;
    for (const ticket of tickets) {
      if (disposed) break;
      try {
        const result = await processTicket(ticket);
        checked += 1;
        if (result?.transitioned === true) transitioned += 1;
      } catch (error) {
        notifyLog(log, 'review-ticket', error);
      }
    }
    return { checked, transitioned };
  }

  /**
   * Process one ticket snapshot: merge detection first, then the newest AI
   * review note. Returns whether a state transition was applied (for `tick()`'s
   * result and tests); never throws.
   */
  async function processTicket(snapshot) {
    const code = normalizeCode(snapshot?.code);
    if (code === undefined) return { transitioned: false };

    const context = readContext(code);
    if (context === null) {
      await rememberError(code, REVIEW_CONTEXT_MISSING_MESSAGE);
      return { transitioned: false };
    }
    const client = buildClient(context);
    if (client === null) {
      await rememberError(code, REVIEW_GITLAB_CONFIG_MESSAGE);
      return { transitioned: false };
    }

    // Re-read inside the tick: a background fix may have advanced the ticket
    // since the list scan. All writes below still carry `expectedWorkflow`.
    const current = readTicket(code);
    if (!current.ok || !isPollable(current.ticket)) return { transitioned: false };
    const ticket = current.ticket;
    const workflow = ticket.workflow;
    const iid = ticket.mr?.iid;

    // --- 1. Merge detection first -----------------------------------------
    let mergeRequest;
    try {
      mergeRequest = await client.getMergeRequest({
        project: context.gitlabProjectPath,
        iid,
      });
    } catch {
      if (!disposed) await rememberError(code, REVIEW_MR_FETCH_FAILED_MESSAGE);
      return { transitioned: false };
    }
    if (disposed) return { transitioned: false };
    if (!isPlainObject(mergeRequest) || typeof mergeRequest.state !== 'string') {
      await rememberError(code, REVIEW_MR_FETCH_FAILED_MESSAGE);
      return { transitioned: false };
    }

    if (mergeRequest.state === 'merged') {
      return handleMerged({ code, workflow });
    }

    // --- 2. Newest AI review note -----------------------------------------
    // Do not start a second fix while one is running for this ticket. An
    // in-flight job still gets its merge check above.
    if (workflow === 'fixing_review' && fixJobs.has(code)) {
      return { transitioned: false };
    }
    if (workflow !== 'mr_open' && workflow !== 'fixing_review') {
      return { transitioned: false };
    }

    let notes;
    try {
      notes = await client.listNotes({
        project: context.gitlabProjectPath,
        iid,
      });
    } catch {
      if (!disposed) await rememberError(code, REVIEW_NOTES_FETCH_FAILED_MESSAGE);
      return { transitioned: false };
    }
    if (disposed) return { transitioned: false };

    const note = pickLatestAiNote(notes);
    if (note === null) return { transitioned: false };
    if (sameNoteId(readLastNoteId(code), note.id)) return { transitioned: false };

    const parsed = parseReview(typeof note.body === 'string' ? note.body : '');
    if (parsed.verdict === 'pass') {
      const applied = await applyActionSafe(
        code,
        'review_pass',
        { actor: 'system' },
        'mr_open',
        'review-pass',
      );
      if (disposed) return { transitioned: false };
      if (applied?.ok !== true) {
        await rememberError(code, writeFailureMessage(applied));
        return { transitioned: false };
      }
      await writeLastNote(code, note, 'pass');
      await clearError(code);
      return { transitioned: true };
    }

    if (parsed.verdict === 'changes') {
      return startChangesRound({ code, ticket, note, parsed, context });
    }

    // Marker + 结论 present but the template no longer parses: never guess.
    const blocked = await blockTicket(code, 'review-parse-failed', 'mr_open');
    return { transitioned: blocked };
  }

  /**
   * Merge detection outcome for one workflow snapshot.
   *
   * `mergeable` -> `mr_merged` -> `merged` (next tick dismisses).
   * `merged`    -> `dismiss(system)` -> `done` (auto-archive, leaves the board).
   * `mr_open`/`fixing_review` + merged externally -> block
   * `review-merged-manually` (never fake a review pass).
   */
  async function handleMerged({ code, workflow }) {
    if (workflow === 'mergeable') {
      const applied = await applyActionSafe(
        code,
        'mr_merged',
        { actor: 'system' },
        'mergeable',
        'review-merged',
      );
      if (applied?.ok !== true) {
        if (!disposed) await rememberError(code, writeFailureMessage(applied));
        return { transitioned: false };
      }
      await clearError(code);
      return { transitioned: true };
    }

    if (workflow === 'merged') {
      const applied = await applyActionSafe(
        code,
        'dismiss',
        { actor: 'system' },
        'merged',
        'review-dismiss',
      );
      if (applied?.ok !== true) {
        if (!disposed) await rememberError(code, writeFailureMessage(applied));
        return { transitioned: false };
      }
      await clearError(code);
      return { transitioned: true };
    }

    if (workflow === 'mr_open' || workflow === 'fixing_review') {
      // An in-flight fix would race the block; cancel it first (it writes
      // nothing once cancelled).
      abortFix(code);
      const blocked = await blockTicket(code, 'review-merged-manually', workflow);
      return { transitioned: blocked };
    }

    return { transitioned: false };
  }

  /**
   * Apply one `review_requests_changes` round and start its single background
   * fix job. The repository lock is taken BEFORE the transition: a busy/failed
   * lock leaves the ticket in `mr_open` (the note stays unprocessed) instead of
   * stranding it in `fixing_review` with no job.
   */
  async function startChangesRound({ code, ticket, note, parsed, context }) {
    const rounds = Number.isSafeInteger(ticket.mr?.rounds) ? ticket.mr.rounds : 0;
    if (rounds >= MAX_REVIEW_ROUNDS) {
      const blocked = await blockTicket(code, 'review-rounds-exhausted', 'mr_open');
      return { transitioned: blocked };
    }

    let repo;
    try {
      repo = await git.repoRoot(context.cwd);
    } catch {
      repo = undefined;
    }
    if (typeof repo !== 'string' || repo.trim() === '') {
      await rememberError(code, REVIEW_WORKSPACE_FAILED_MESSAGE);
      return { transitioned: false };
    }

    const owner = `review:${code}`;
    if (!repoLock.acquire(repo, owner)) {
      // Another job owns this repository; try again on the next tick.
      return { transitioned: false };
    }

    const findings = {
      blocking: Array.isArray(parsed.blocking) ? parsed.blocking : [],
      nonBlocking: Array.isArray(parsed.nonBlocking) ? parsed.nonBlocking : [],
    };
    const applied = await applyActionSafe(
      code,
      'review_requests_changes',
      {
        actor: 'system',
        blockingIssues: findings.blocking,
        nonBlockingIssues: findings.nonBlocking,
      },
      'mr_open',
      'review-changes',
    );
    if (disposed) {
      repoLock.release(repo, owner);
      return { transitioned: false };
    }
    if (applied?.ok !== true) {
      repoLock.release(repo, owner);
      if (applied?.code !== 'stale-workflow') {
        await rememberError(code, writeFailureMessage(applied));
      }
      return { transitioned: false };
    }

    await writeLastNote(code, note, 'changes');
    await clearError(code);
    if (disposed) {
      repoLock.release(repo, owner);
      return { transitioned: true };
    }

    const transitionedTicket = isPlainObject(applied.ticket) ? applied.ticket : ticket;
    const round = Number.isSafeInteger(transitionedTicket.mr?.rounds)
      ? transitionedTicket.mr.rounds
      : rounds + 1;
    startFixJob({
      code,
      repo,
      owner,
      context,
      ticket: transitionedTicket,
      findings,
      round,
      noteId: note.id,
    });
    return { transitioned: true };
  }

  /**
   * Register ONE background review-fix job for `code`. Callers hold the
   * repository lock; the job's `finally` releases it on every path.
   */
  function startFixJob({ code, repo, owner, context, ticket, findings, round, noteId }) {
    if (disposed || fixJobs.has(code)) {
      repoLock.release(repo, owner);
      return;
    }
    const entry = { controller: new AbortController(), cancelled: false };
    fixJobs.set(code, entry);
    const startedAt = nowOrIso();
    const job = runFixJob({
      entry,
      code,
      repo,
      context,
      ticket,
      findings,
      round,
      noteId,
      startedAt,
    });
    jobs.add(job);
    void job
      .finally(() => {
        jobs.delete(job);
        if (fixJobs.get(code) === entry) fixJobs.delete(code);
        repoLock.release(repo, owner);
      })
      .catch(() => {
        // runFixJob contains every failure; belt-and-braces only.
      });
  }

  /**
   * One background review-fix run: probe the registered worktree, run the
   * write-capable child, verify changes, commit/push from the HOST, then append
   * the ledger entries and advance. Never rejects; cancelled/disposed runs
   * write nothing.
   */
  async function runFixJob({ entry, code, repo, context, ticket, findings, round, noteId, startedAt }) {
    try {
      if (disposed || entry.cancelled) return;
      const branch = readBranch(ticket);
      if (branch === null) {
        await failFix(code, 'review-fix-failed', entry);
        return;
      }

      // The stored path is metadata, not proof: a plain directory or a worktree
      // on another branch must block BEFORE `git add -A`. `repo` is the same
      // resolved root the repository lock was taken on.
      let probe;
      try {
        probe = await git.probeWorktree(repo, branch.worktree, branch.name);
      } catch {
        probe = null;
      }
      if (entry.cancelled || disposed) return;
      if (!isPlainObject(probe) || probe.ok !== true || probe.state !== 'same') {
        await failFix(code, 'review-fix-failed', entry);
        return;
      }

      let result;
      try {
        result = await runner.runReviewFix({
          sessionId: context.sessionId,
          worktreePath: branch.worktree,
          ticket,
          plan: ticket.plan,
          mr: ticket.mr,
          findings: {
            blocking: findings.blocking,
            nonBlocking: findings.nonBlocking,
          },
          signal: entry.controller.signal,
        });
      } catch {
        result = { ok: false, code: 'analysis-failed' };
      }
      if (entry.cancelled || disposed) return;
      if (!isPlainObject(result) || result.ok !== true) {
        await failFix(code, 'review-fix-failed', entry);
        return;
      }

      let statusText;
      try {
        statusText = await git.status(branch.worktree);
      } catch {
        statusText = undefined;
      }
      if (entry.cancelled || disposed) return;
      if (typeof statusText !== 'string') {
        await failFix(code, 'review-fix-failed', entry);
        return;
      }
      if (statusText.trim() === '') {
        await failFix(code, 'review-fix-no-changes', entry);
        return;
      }

      let diffStat = '';
      let diff = '';
      try {
        const stat = await git.diffStat(branch.worktree);
        if (typeof stat === 'string') diffStat = stat;
      } catch {
        // diffStat is diagnostic only; the commit/push contract still holds.
      }
      try {
        const patch = await git.diff(branch.worktree, { maxChars: REVIEW_DIFF_MAX_CHARS });
        if (typeof patch === 'string') diff = clipText(patch, REVIEW_DIFF_MAX_CHARS, '\n…（diff 已截断）');
      } catch {
        // diff is diagnostic only.
      }
      if (entry.cancelled || disposed) return;

      const changedFiles = boundChangedFiles(parsePorcelainFiles(statusText));
      const message = buildCommitMessage(
        { commitType: context.commitType },
        code,
        ticket,
      );
      let committed;
      try {
        committed = await git.commitAll({ root: branch.worktree, message });
      } catch {
        committed = undefined;
      }
      if (entry.cancelled || disposed) return;
      if (!isPlainObject(committed) || committed.ok !== true) {
        await failFix(code, 'review-fix-failed', entry);
        return;
      }
      if (committed.sha === null) {
        await failFix(code, 'review-fix-no-changes', entry);
        return;
      }
      if (typeof committed.sha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(committed.sha)) {
        await failFix(code, 'review-fix-failed', entry);
        return;
      }
      const sha = committed.sha;

      // Second identity gate: the ref we are about to push must resolve to the
      // commit the host just created (never the main worktree / another branch).
      let head;
      try {
        head = await git.revParse(branch.worktree, branch.name);
      } catch {
        head = undefined;
      }
      if (entry.cancelled || disposed) return;
      if (typeof head !== 'string' || head !== sha) {
        await failFix(code, 'review-fix-failed', entry);
        return;
      }

      let pushed;
      try {
        pushed = await git.pushBranch({
          root: branch.worktree,
          remote: 'origin',
          branch: branch.name,
        });
      } catch {
        pushed = undefined;
      }
      if (entry.cancelled || disposed) return;
      if (!isPlainObject(pushed) || pushed.ok !== true) {
        await failFix(code, 'review-fix-failed', entry);
        return;
      }

      await persistFixDone({
        entry,
        code,
        round,
        noteId,
        startedAt,
        result,
        changedFiles,
        diffStat,
        diff,
      });
    } catch (error) {
      notifyLog(log, 'review-fix-job', error);
      if (!entry.cancelled && !disposed) {
        await failFix(code, 'review-fix-failed', entry);
      }
    }
  }

  /**
   * Persist one successful review-fix run through the write queue: append to
   * `fixes[]`, append to `reviewRounds[]`, refresh `mr.state`, then
   * `review_fix_done` (which must NOT increment `mr.rounds` again — the
   * transition into `fixing_review` already did).
   */
  async function persistFixDone({
    entry,
    code,
    round,
    noteId,
    startedAt,
    result,
    changedFiles,
    diffStat,
    diff,
  }) {
    const current = readTicket(code);
    if (!current.ok) {
      if (!disposed) {
        await rememberError(
          code,
          current.reason === 'error' ? REVIEW_SAVE_FAILED_MESSAGE : REVIEW_STALE_MESSAGE,
        );
      }
      return;
    }
    if (current.ticket.workflow !== 'fixing_review') {
      if (!disposed) await rememberError(code, REVIEW_STALE_MESSAGE);
      return;
    }

    const fixes = Array.isArray(current.ticket.fixes) ? current.ticket.fixes : [];
    const reviewRounds = Array.isArray(current.ticket.reviewRounds)
      ? current.ticket.reviewRounds
      : [];
    const finishedAt = nowOrIso();
    const childId = boundChildId(result.childId);
    const elapsedMs = Number.isFinite(result.elapsedMs)
      ? Math.max(0, Math.trunc(result.elapsedMs))
      : undefined;
    const summary = clipText(result.result?.summary, REVIEW_TEXT_MAX_CHARS);
    const testResult = clipText(result.result?.testResult, REVIEW_TEXT_MAX_CHARS);
    const notes = typeof result.result?.notes === 'string'
      ? clipText(result.result.notes, REVIEW_TEXT_MAX_CHARS)
      : undefined;
    const runId = nextActionId('review-fix', code);

    const fixEntry = {
      runId,
      ...(childId === undefined ? {} : { childId }),
      startedAt,
      finishedAt,
      changedFiles,
      diffStat: clipText(diffStat, REVIEW_DIFF_STAT_MAX_CHARS),
      diff,
      summary,
      testResult,
      ...(notes === undefined ? {} : { notes }),
      status: 'succeeded',
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
    };
    const roundEntry = {
      round: Number.isSafeInteger(round) && round >= 0 ? round : 0,
      noteId: normalizeNoteId(noteId),
      verdict: 'changes',
      startedAt,
      finishedAt,
      changedFiles,
      ...(childId === undefined ? {} : { childId }),
      status: 'succeeded',
    };
    const nextMr = {
      ...(isPlainObject(current.ticket.mr) ? current.ticket.mr : {}),
      state: 'opened',
    };

    let patched;
    try {
      patched = await store.patchTicket(
        code,
        { fixes: [...fixes, fixEntry], reviewRounds: [...reviewRounds, roundEntry], mr: nextMr },
        { actionId: runId, expectedWorkflow: 'fixing_review' },
      );
    } catch {
      patched = undefined;
    }
    if (entry.cancelled || disposed) return;
    if (patched?.ok !== true) {
      await rememberError(code, writeFailureMessage(patched));
      return;
    }

    const applied = await applyActionSafe(
      code,
      'review_fix_done',
      { actor: 'system', mr: nextMr },
      'fixing_review',
      'review-fix-done',
    );
    if (entry.cancelled || disposed) return;
    if (applied?.ok !== true) {
      await rememberError(code, writeFailureMessage(applied));
      return;
    }
    await clearError(code);
  }

  /** Block with a static reason and persist the matching static error meta. */
  async function blockTicket(code, reason, expectedWorkflow) {
    if (disposed) return false;
    const applied = await applyActionSafe(
      code,
      'block',
      { reason, actor: 'system' },
      expectedWorkflow,
      'review-block',
    );
    await rememberError(code, REVIEW_REASON_MESSAGES[reason] ?? REVIEW_REASON_MESSAGES['review-fix-failed']);
    return applied?.ok === true;
  }

  /** Block a ticket whose review-fix run failed, unless it was cancelled. */
  async function failFix(code, reason, entry) {
    if (disposed || entry?.cancelled === true) return;
    await blockTicket(code, reason, 'fixing_review');
  }

  /**
   * Snapshot view: review-fix codes currently running plus persisted static
   * errors read from `meta['review.error:<code>']` for every stored ticket.
   * A failing store read degrades to the in-memory set.
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
    return { running: [...fixJobs.keys()], errors };
  }

  /**
   * Clear the interval, cancel/abort every in-flight review-fix job and drain
   * them. Each entry is marked `cancelled` BEFORE the abort, so an aborted job
   * writes no block/error/meta: plugin unload is not a review failure.
   * Idempotent and bounded.
   *
   * @returns {Promise<void>}
   */
  function dispose() {
    if (disposePromise !== undefined) return disposePromise;
    disposed = true;
    if (pollDisposer !== undefined) {
      const clear = pollDisposer;
      pollDisposer = undefined;
      try {
        clear();
      } catch {
        // A hostile disposer must not break teardown.
      }
    }
    const entries = [...fixJobs.values()];
    fixJobs.clear();
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

  // -------------------------------------------------------------------------
  // Context / client / ticket helpers
  // -------------------------------------------------------------------------

  /** Read and validate `meta['delivery.context:<code>']`; null when unusable. */
  function readContext(code) {
    let value;
    try {
      value = store.getMeta(DELIVERY_CONTEXT_META_PREFIX + code);
    } catch {
      return null;
    }
    return normalizeContext(value);
  }

  /** Build the per-workspace read-only GitLab client; null when construction fails. */
  function buildClient(context) {
    let client;
    try {
      client = gitlabClientFor({
        gitlabBaseUrl: context.gitlabBaseUrl,
        gitlabProjectPath: context.gitlabProjectPath,
      });
    } catch {
      return null;
    }
    if (
      !isPlainObject(client)
      || typeof client.getMergeRequest !== 'function'
      || typeof client.listNotes !== 'function'
    ) {
      return null;
    }
    return client;
  }

  function readTicket(code) {
    let ticket;
    try {
      ticket = store.get(code);
    } catch {
      return { ok: false, reason: 'error' };
    }
    if (!isPlainObject(ticket) || typeof ticket.workflow !== 'string') {
      return { ok: false, reason: 'missing' };
    }
    return { ok: true, ticket };
  }

  function scanTickets() {
    let tickets;
    try {
      tickets = store.list();
    } catch {
      return [];
    }
    if (!Array.isArray(tickets)) return [];
    return tickets.filter((ticket) => isPollable(ticket));
  }

  async function hasToken() {
    try {
      const token = await tokenStore.get();
      return typeof token === 'string' && token.trim() !== '';
    } catch {
      return false;
    }
  }

  function readLastNoteId(code) {
    let value;
    try {
      value = store.getMeta(REVIEW_LAST_NOTE_META_PREFIX + code);
    } catch {
      return undefined;
    }
    if (isPlainObject(value)) return value.id;
    return value;
  }

  /**
   * Record the processed note id. Written only after a successful transition so
   * a refused transition retries the same note instead of silently dropping it;
   * the next tick's transition guard keeps that retry from double-incrementing.
   */
  function writeLastNote(code, note, verdict) {
    if (disposed) return Promise.resolve();
    const record = {
      id: normalizeNoteId(note?.id),
      verdict,
      at: nowOrIso(),
    };
    try {
      return store.setMeta(REVIEW_LAST_NOTE_META_PREFIX + code, record).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  // -------------------------------------------------------------------------
  // Write helpers (conditional, dispose-safe)
  // -------------------------------------------------------------------------

  /**
   * Apply one action with a generated unique actionId and an in-queue
   * `expectedWorkflow` guard. A disposed service or a stale workflow writes
   * nothing and returns undefined.
   */
  async function applyActionSafe(code, action, payload, expectedWorkflow, prefix) {
    if (disposed) return undefined;
    try {
      return await store.applyAction(code, action, payload, {
        actionId: nextActionId(prefix, code),
        expectedWorkflow,
      });
    } catch {
      return undefined;
    }
  }

  function rememberError(code, message) {
    if (disposed) return Promise.resolve();
    errorCodes.add(code);
    try {
      return store.setMeta(REVIEW_ERROR_META_PREFIX + code, message).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  function clearError(code) {
    if (disposed) return Promise.resolve();
    errorCodes.delete(code);
    try {
      return store.setMeta(REVIEW_ERROR_META_PREFIX + code, null).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  function readPersistedError(code) {
    let value;
    try {
      value = store.getMeta(REVIEW_ERROR_META_PREFIX + code);
    } catch {
      return undefined;
    }
    if (typeof value !== 'string' || value === '') return undefined;
    errorCodes.add(code);
    return value;
  }

  /** Cancel one in-flight fix job (writes nothing itself). */
  function abortFix(code) {
    const entry = fixJobs.get(code);
    if (entry === undefined) return;
    fixJobs.delete(code);
    entry.cancelled = true;
    try {
      entry.controller.abort();
    } catch {
      // The runner owns its abort handling.
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

  /** Best-effort ISO timestamp for run metadata (a broken clock never fails a job). */
  function nowOrIso() {
    try {
      return readNow();
    } catch {
      return defaultClock();
    }
  }

  return { start, tick, status, dispose };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** True for `{code, workflow, mr}` tickets the poller owns. */
function isPollable(ticket) {
  return isPlainObject(ticket)
    && typeof ticket.code === 'string'
    && POLLABLE_WORKFLOWS.has(ticket.workflow)
    && isPlainObject(ticket.mr);
}

/**
 * Latest genuine AI review note, or null. "Genuine" = a non-system note whose
 * body carries both the `AI Code Review` marker and a `结论:` line; the parser
 * then decides pass/changes/unknown. Ordering is done here because the GitLab
 * client preserves the upstream order and consumers must not trust it.
 */
export function pickLatestAiNote(notes) {
  if (!Array.isArray(notes)) return null;
  let best = null;
  for (const note of notes) {
    if (!isAiReviewNote(note)) continue;
    if (best === null || compareNoteRecency(note, best) > 0) best = note;
  }
  return best;
}

function isAiReviewNote(note) {
  if (!isPlainObject(note)) return false;
  if (note.system === true) return false;
  const body = typeof note.body === 'string' ? note.body : '';
  if (!body.includes(AI_MARKER)) return false;
  return VERDICT_MARKER_RE.test(body);
}

/** Negative when `a` is older, positive when newer (ISO strings, then id). */
function compareNoteRecency(a, b) {
  const ta = Date.parse(typeof a.createdAt === 'string' ? a.createdAt : '');
  const tb = Date.parse(typeof b.createdAt === 'string' ? b.createdAt : '');
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  const sa = typeof a.createdAt === 'string' ? a.createdAt : '';
  const sb = typeof b.createdAt === 'string' ? b.createdAt : '';
  if (sa !== sb) return sa.localeCompare(sb);
  return numericNoteId(a.id) - numericNoteId(b.id);
}

function numericNoteId(id) {
  if (typeof id === 'number' && Number.isFinite(id)) return id;
  if (typeof id === 'string' && /^\d+$/.test(id)) return Number(id);
  return 0;
}

function normalizeNoteId(id) {
  if (typeof id === 'number' && Number.isFinite(id)) return id;
  if (typeof id === 'string' && id !== '') return id.slice(0, 200);
  return 0;
}

function sameNoteId(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return false;
  return String(a) === String(b);
}

/** Validate the delivery context record; never trust a persisted row. */
function normalizeContext(value) {
  if (!isPlainObject(value)) return null;
  const sessionId = boundedText(value.sessionId, 200);
  const cwd = boundedText(value.cwd, 4_096);
  const gitlabBaseUrl = boundedText(value.gitlabBaseUrl, 2_048);
  const gitlabProjectPath = boundedText(value.gitlabProjectPath, 2_048);
  if (
    sessionId === undefined
    || cwd === undefined
    || gitlabBaseUrl === undefined
    || gitlabProjectPath === undefined
  ) {
    return null;
  }
  return {
    sessionId,
    cwd,
    gitlabBaseUrl,
    gitlabProjectPath,
    commitType: boundedText(value.commitType, 64) ?? 'fix',
  };
}

function readBranch(ticket) {
  const branch = isPlainObject(ticket?.branch) ? ticket.branch : null;
  if (branch === null) return null;
  const name = boundedText(branch.name, 255);
  const worktree = boundedText(branch.worktree, 4_096);
  if (name === undefined || worktree === undefined) return null;
  return { name, worktree };
}

function boundChildId(value) {
  if (typeof value !== 'string' || value === '') return undefined;
  return value.slice(0, REVIEW_CHILD_ID_MAX_CHARS);
}

function boundChangedFiles(files) {
  const list = Array.isArray(files) ? files : [];
  return list
    .filter((file) => typeof file === 'string' && file !== '')
    .slice(0, REVIEW_CHANGED_FILES_MAX)
    .map((file) => file.slice(0, REVIEW_CHANGED_FILE_MAX_CHARS));
}

/**
 * Parse `git status --porcelain` into a changed-file list (same shape the P4
 * fix service persists). Handles `XY path`, renames (`old -> new`), git's
 * quoted paths and untracked `??` entries, deduplicated in status order.
 */
function parsePorcelainFiles(text) {
  const files = [];
  const seen = new Set();
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue;
    // `XY path`: the path begins at column 3 (a leading-space status is common).
    let path = line.length > 3 ? line.slice(3) : '';
    if (path.startsWith('"') && path.endsWith('"')) {
      path = path.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    const arrow = path.indexOf(' -> ');
    if (arrow >= 0) path = path.slice(arrow + 4);
    path = path.trim();
    if (path === '' || seen.has(path)) continue;
    seen.add(path);
    files.push(path);
  }
  return files;
}

/** Clip a persisted text field; `marker` is appended only when clipped. */
function clipText(value, max, marker = '…') {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

function boundedText(value, max) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > max) return undefined;
  return trimmed;
}

function writeFailureMessage(result) {
  return result?.code === 'stale-workflow' ? REVIEW_STALE_MESSAGE : REVIEW_SAVE_FAILED_MESSAGE;
}

function notifyLog(log, event, error) {
  if (typeof log !== 'function') return;
  try {
    log({ event, error });
  } catch {
    // Diagnostics only: a broken logger must not reject a tick/job.
  }
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
  throw new TypeError('createReviewService() requires a clock function or {now()}');
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

function normalizeLock(lock) {
  if (lock === undefined || lock === null) return createRepoLock();
  if (typeof lock.acquire !== 'function' || typeof lock.release !== 'function') {
    throw new TypeError('createReviewService() lock must expose acquire(repo, owner) and release(repo, owner)');
  }
  return lock;
}

function assertStore(store) {
  if (store === null || typeof store !== 'object') {
    throw new TypeError('createReviewService() requires a store');
  }
  for (const method of ['get', 'list', 'applyAction', 'patchTicket', 'getMeta', 'setMeta']) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(`createReviewService() store.${method} must be a function`);
    }
  }
}

function assertGit(git) {
  if (git === null || typeof git !== 'object') {
    throw new TypeError('createReviewService() requires a git executor');
  }
  for (const method of [
    'repoRoot',
    'probeWorktree',
    'status',
    'diffStat',
    'diff',
    'commitAll',
    'revParse',
    'pushBranch',
  ]) {
    if (typeof git[method] !== 'function') {
      throw new TypeError(`createReviewService() git.${method} must be a function`);
    }
  }
}

function assertRunner(runner) {
  if (runner === null || typeof runner !== 'object' || typeof runner.runReviewFix !== 'function') {
    throw new TypeError('createReviewService() requires a runner with runReviewFix()');
  }
}

function assertTokenStore(tokenStore) {
  if (tokenStore === null || typeof tokenStore !== 'object' || typeof tokenStore.get !== 'function') {
    throw new TypeError('createReviewService() requires a tokenStore with get()');
  }
}

/** Bound the `dispose()` drain: `Promise.allSettled` cannot hang unload. */
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
    Promise.allSettled(pending.map((job) => Promise.resolve(job))).then(finish, finish);
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
