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
 *   recovery (fixing_review with NO in-flight job — retry after a failure,
 *   host reload, dispose)
 *     lost review_fix_done      -> retry the action (idempotent ledger replay)
 *     pending commit record     -> validate worktree+branch+sha AND that the
 *                                  record belongs to the CURRENT round/note,
 *                                  push, append the ledger once, review_fix_done
 *     persisted findings exist  -> restart the child (rounds NOT incremented)
 *     no findings               -> block('review-recovery-unavailable')
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
 *     `review.error:<code>` message 「缺少交付上下文，需人工检查（P4/P5 交接）」 and
 *     never mutates the workflow.
 *   - No GitLab token (`tokenStore.get()` returns null/throws) means NO request
 *     and NO write at all: the tick is a silent no-op.
 *   - The newest note whose OWN top-level lines carry the AI marker AND a
 *     `结论:` line is the only candidate (`isReviewBody`, system notes skipped;
 *     a human reply quoting/pasting a note is not a review). It is deduped by
 *     id via `meta['review.last-note:<code>']`; the changes path writes that
 *     claim BEFORE the transition and blocks if it cannot, so the same note
 *     never starts a second round. `parseReview()` is the canonical parser;
 *     only an AI-target note that parses to `unknown` blocks (template drift).
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
 *   - A pending-commit record is bound to the round and note that produced it:
 *     recovery only replays a record whose `round === mr.rounds` and whose
 *     `noteId` matches `review.last-note`. A record left behind by an earlier
 *     round (dispose/clear failure) is dropped, never pushed, so it can never
 *     fake completion of a later round (N1). The changes path also purges any
 *     old record when it claims a new note for the next round.
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
import { isReviewBody, parseReview } from './review-parser.js';

/** `meta` key prefix of a persisted review error (suffix = ticket code). */
export const REVIEW_ERROR_META_PREFIX = 'review.error:';

/** `meta` key prefix of the last processed AI review note id. */
export const REVIEW_LAST_NOTE_META_PREFIX = 'review.last-note:';

/**
 * `meta` key prefix of a review-fix commit that was created but could not be
 * pushed (or whose host crashed between commit and transition). Recovery pushes
 * exactly this commit instead of rerunning the child (a clean worktree would
 * otherwise be misread as `review-fix-no-changes`).
 */
export const REVIEW_FIX_COMMIT_META_PREFIX = 'review.fix-commit:';

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

/**
 * Bounds for the findings persisted to `mr.blockingIssues`/`nonBlockingIssues`
 * (and passed to the child). The snapshot is re-sent to every client, so one
 * giant note must never be persisted verbatim; the caps mirror the review-fix
 * prompt renderer (`blocking` 20 / `nonBlocking` 10 / 600 chars per field).
 */
export const REVIEW_BLOCKING_ISSUES_MAX = 20;
export const REVIEW_NON_BLOCKING_ISSUES_MAX = 10;
export const REVIEW_ISSUE_FIELD_MAX_CHARS = 600;

/** Static context failures (client-visible via `snapshot.review.errors`). */
export const REVIEW_CONTEXT_MISSING_MESSAGE = '缺少交付上下文，需人工检查（P4/P5 交接）';
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
  'review-fix-timeout': 'AI Review 修复超时，请稍后重试',
  'review-fix-unavailable': '无法启动 AI Review 修复子代理，请检查会话与工作区后重试',
  'review-save-failed': 'Review 记录保存失败，请重试',
  'review-recovery-unavailable': 'Review 修复恢复条件不足，请人工检查',
  'review-fix-write-failed': 'Review 修复结果写入失败，请重试',
  'review-merged-manually': 'MR 在 AI Review 通过前被合并，请人工确认',
});

/** Workflows the poller owns. `mergeable`/`merged` are merge-detection only. */
const POLLABLE_WORKFLOWS = new Set(['mr_open', 'fixing_review', 'mergeable', 'merged']);

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

    // --- 2. Recover a stranded `fixing_review` ----------------------------
    // A review-fix job can die (runner failure -> block -> retry, host reload,
    // dispose) leaving the ticket in `fixing_review` with NO job. The note path
    // below only accepts `mr_open`, so without this branch the ticket would
    // spin forever (and a brand-new note could never recover it). Recovery runs
    // BEFORE note polling: while a round is unfinished a new note must not
    // re-enter `review_requests_changes` (it would increment rounds twice).
    if (workflow === 'fixing_review') {
      if (fixJobs.has(code)) return { transitioned: false };
      return recoverFixRound({ code, ticket, context });
    }

    // `mergeable`/`merged` are merge-detection only. A successful poll with
    // nothing to do clears a stale transient error instead of keeping it until
    // an unrelated transition happens.
    if (workflow !== 'mr_open') {
      await clearError(code);
      return { transitioned: false };
    }

    // --- 3. Newest AI review note -----------------------------------------
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
    if (note === null) {
      await clearError(code);
      return { transitioned: false };
    }
    if (sameNoteId(readLastNoteId(code), note.id)) {
      await clearError(code);
      return { transitioned: false };
    }

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
   * fix job. The repository lock and the note dedupe claim are taken BEFORE the
   * transition: a busy lock/refused claim leaves the ticket in `mr_open` (the
   * note stays retryable) instead of stranding it in `fixing_review` with no
   * job, and a failed claim can never start the same note twice.
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

    const findings = boundFindings(parsed.blocking, parsed.nonBlocking);

    // Persist the dedupe claim BEFORE the round starts. A best-effort claim was
    // the M2 duplicate-round bug: a failed write left the same note unclaimed,
    // so the next tick started round 2 for one note. A failed claim now blocks
    // (and the ticket never enters a round it cannot dedupe).
    //
    // Known narrow window (N2): a refused transition write releases the claim
    // below, but if the process dies AFTER this claim and BEFORE that write the
    // restarted host still sees `mr_open` while the note is already claimed, so
    // that note is skipped forever. That is the fail-safe direction (skip, never
    // duplicate); a full fix needs a pending-round claim plus an `mr_open`
    // reconciliation. Accepted as a known limitation here.
    const claimed = await writeLastNote(code, note, 'changes');
    if (disposed) {
      repoLock.release(repo, owner);
      return { transitioned: false };
    }
    if (!claimed) {
      repoLock.release(repo, owner);
      const blocked = await blockTicket(code, 'review-save-failed', 'mr_open');
      return { transitioned: blocked };
    }

    // A claimed note means a NEW round starts below: any pending-commit record
    // still stored for this ticket belongs to an earlier round (a dispose/clear
    // failure can leave one behind) and must never be replayed for this round.
    // Best effort here; the hard gate is the round/note binding in
    // `pushRecordedFix()` / `finishRecordedFix()` (N1).
    await clearFixCommitRecord(code);

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
      // The round never started: release the claim so a later tick retries the
      // same note. Failing to release fails safe (skip, never duplicate).
      await forgetLastNote(code);
      return { transitioned: false };
    }

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
   * Recover one `fixing_review` ticket that has NO in-flight review-fix job.
   * This is the C1 recovery path: `retry` returns a blocked ticket to
   * `fixing_review`, and a host reload/dispose leaves the same shape, but the
   * note path only accepts `mr_open`. Order matters:
   *
   *   1. The ledger patch already succeeded and `review_fix_done` was lost
   *      (I2): retry that action idempotently (no duplicate ledger/commit).
   *   2. A host commit exists but was never pushed (I1): validate it against
   *      the registered worktree/branch, push it, append the ledger ONCE, then
   *      finish the transition — no second child run.
   *   3. Otherwise restart the child from the findings persisted by
   *      `review_requests_changes` (rounds were already incremented).
   *   4. No persisted findings: block with a static reason instead of spinning.
   */
  async function recoverFixRound({ code, ticket, context }) {
    const reconciled = await reconcileFixDone({ code, ticket });
    if (reconciled !== undefined) return reconciled;

    const pushed = await pushRecordedFix({ code, ticket, context });
    if (pushed !== undefined) return pushed;

    return restartFixJob({ code, ticket, context });
  }

  /**
   * Retry a lost `review_fix_done` when the ledger already proves the round
   * completed: the last `reviewRounds[]` entry is `succeeded` for the current
   * `mr.rounds`. Reusing a fresh actionId is safe because the transition is
   * idempotent; `expectedWorkflow` keeps a moved ticket untouched. If the retry
   * itself fails, block (retryable) instead of leaving the ticket stranded.
   */
  async function reconcileFixDone({ code, ticket }) {
    const rounds = Array.isArray(ticket.reviewRounds) ? ticket.reviewRounds : [];
    const last = rounds[rounds.length - 1];
    const mrRounds = Number.isSafeInteger(ticket.mr?.rounds) ? ticket.mr.rounds : 0;
    if (!isPlainObject(last) || last.status !== 'succeeded' || last.round !== mrRounds) {
      return undefined;
    }
    // The ledger entry must belong to the round that is still claimed as the
    // last processed note; otherwise fall through to the commit-ledger replay.
    if (!sameNoteId(readLastNoteId(code), last.noteId)) return undefined;

    const nextMr = { ...(isPlainObject(ticket.mr) ? ticket.mr : {}), state: 'opened' };
    const applied = await applyActionSafe(
      code,
      'review_fix_done',
      { actor: 'system', mr: nextMr },
      'fixing_review',
      'review-reconcile-done',
    );
    if (disposed) return { transitioned: false };
    if (applied?.ok === true) {
      await clearFixCommitRecord(code);
      await clearError(code);
      return { transitioned: true };
    }

    const blocked = await blockTicket(code, 'review-fix-write-failed', 'fixing_review');
    return { transitioned: blocked };
  }

  /**
   * Push the commit recorded by a failed/unclean previous run (I1). Returns
   * `undefined` when there is nothing valid to push (stale record discarded), so
   * the caller can restart the child; a busy repository lock waits for the next
   * tick. The record is only trusted when it still matches THIS registered
   * worktree and ITS branch tip — a foreign ref is never pushed — AND when it
   * belongs to the CURRENT round and claimed note: replaying an older round's
   * record would append the old ledger entry and fake completion of this round
   * (N1), so a mismatch discards the record and falls through to the restart.
   */
  async function pushRecordedFix({ code, ticket, context }) {
    const branch = readBranch(ticket);
    if (branch === null) return undefined;
    const record = readFixCommitRecord(code, branch);
    if (record === undefined) return undefined;

    // Round/note binding (N1). `mr.rounds` is incremented by the transition
    // that started THIS round and `review.last-note` is the note it claimed;
    // a record written by any other round must never complete this one.
    const mrRounds = Number.isSafeInteger(ticket.mr?.rounds) ? ticket.mr.rounds : 0;
    if (record.round !== mrRounds || !sameNoteId(record.noteId, readLastNoteId(code))) {
      await clearFixCommitRecord(code);
      return undefined;
    }

    let repo;
    try {
      repo = await git.repoRoot(context.cwd);
    } catch {
      repo = undefined;
    }
    if (typeof repo !== 'string' || repo.trim() === '') {
      const blocked = await blockTicket(code, 'review-recovery-unavailable', 'fixing_review');
      return { transitioned: blocked };
    }

    let probe;
    try {
      probe = await git.probeWorktree(repo, branch.worktree, branch.name);
    } catch {
      probe = null;
    }
    if (disposed) return { transitioned: false };
    if (!isPlainObject(probe) || probe.ok !== true || probe.state !== 'same') {
      await clearFixCommitRecord(code);
      return undefined;
    }

    let head;
    try {
      head = await git.revParse(branch.worktree, branch.name);
    } catch {
      head = undefined;
    }
    if (disposed) return { transitioned: false };
    if (typeof head !== 'string' || head !== record.sha) {
      await clearFixCommitRecord(code);
      return undefined;
    }

    const owner = `review:${code}`;
    if (!repoLock.acquire(repo, owner)) {
      // Another job owns this repository; retry the recovery next tick.
      return { transitioned: false };
    }
    try {
      if (disposed) return { transitioned: false };
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
      if (disposed) return { transitioned: false };
      if (!isPlainObject(pushed) || pushed.ok !== true) {
        // Keep the record: the next retry must push this exact commit again.
        const blocked = await blockTicket(code, 'review-fix-failed', 'fixing_review');
        return { transitioned: blocked };
      }
      return await finishRecordedFix({ code, record });
    } finally {
      repoLock.release(repo, owner);
    }
  }

  /**
   * Append the recorded ledger entries (exactly once) and complete the round.
   * The patch reuses `record.runId` as its idempotency key, so a replay of an
   * already-applied patch returns the cached result instead of appending twice.
   * The record must still belong to the CURRENT round/note (N1): a mismatch
   * drops it and returns `undefined` so the caller restarts this round.
   */
  async function finishRecordedFix({ code, record }) {
    const current = readTicket(code);
    if (!current.ok || current.ticket.workflow !== 'fixing_review') {
      await clearFixCommitRecord(code);
      return { transitioned: false };
    }
    const ticket = current.ticket;
    // Defensive re-check of the binding: the caller validated it before the
    // push, but the ticket could have moved (or a stale record could be passed
    // in) — never append an older round's ledger entry here.
    const mrRounds = Number.isSafeInteger(ticket.mr?.rounds) ? ticket.mr.rounds : 0;
    if (record.round !== mrRounds || !sameNoteId(record.noteId, readLastNoteId(code))) {
      await clearFixCommitRecord(code);
      return undefined;
    }
    const fixes = Array.isArray(ticket.fixes) ? ticket.fixes : [];
    const reviewRounds = Array.isArray(ticket.reviewRounds) ? ticket.reviewRounds : [];
    // A succeeded entry only proves THIS run was applied when it is for the same
    // round AND the same claimed note; the `fixes[]` run id is the second link.
    const alreadyApplied = reviewRounds.some(
      (entry) => isPlainObject(entry)
        && entry.round === record.round
        && entry.status === 'succeeded'
        && sameNoteId(entry.noteId, record.noteId),
    ) || fixes.some(
      (entry) => isPlainObject(entry) && entry.runId === record.runId,
    );

    if (!alreadyApplied) {
      const nextMr = { ...(isPlainObject(ticket.mr) ? ticket.mr : {}), state: 'opened' };
      let patched;
      try {
        patched = await store.patchTicket(
          code,
          {
            fixes: [...fixes, buildFixEntry(record)],
            reviewRounds: [...reviewRounds, buildRoundEntry(record)],
            mr: nextMr,
          },
          { actionId: record.runId, expectedWorkflow: 'fixing_review' },
        );
      } catch {
        patched = undefined;
      }
      if (disposed) return { transitioned: false };
      if (patched?.ok !== true) {
        await rememberError(code, writeFailureMessage(patched));
        return { transitioned: false };
      }
    }

    const nextMr = { ...(isPlainObject(ticket.mr) ? ticket.mr : {}), state: 'opened' };
    const applied = await applyActionSafe(
      code,
      'review_fix_done',
      { actor: 'system', mr: nextMr },
      'fixing_review',
      'review-recovered-done',
    );
    if (disposed) return { transitioned: false };
    if (applied?.ok !== true) {
      // The ledger is written; the next tick reconciles this exact case.
      await rememberError(code, writeFailureMessage(applied));
      return { transitioned: false };
    }
    await clearFixCommitRecord(code);
    await clearError(code);
    return { transitioned: true };
  }

  /**
   * Restart a review-fix job from the findings persisted with
   * `review_requests_changes` (C1). `mr.rounds` was already incremented by the
   * reducer, so this path never calls that action again, never writes the
   * last-note claim and never increments the round.
   */
  async function restartFixJob({ code, ticket, context }) {
    const findings = boundFindings(ticket.mr?.blockingIssues, ticket.mr?.nonBlockingIssues);
    if (findings.blocking.length === 0 && findings.nonBlocking.length === 0) {
      const blocked = await blockTicket(code, 'review-recovery-unavailable', 'fixing_review');
      return { transitioned: blocked };
    }

    let repo;
    try {
      repo = await git.repoRoot(context.cwd);
    } catch {
      repo = undefined;
    }
    if (typeof repo !== 'string' || repo.trim() === '') {
      const blocked = await blockTicket(code, 'review-recovery-unavailable', 'fixing_review');
      return { transitioned: blocked };
    }

    const owner = `review:${code}`;
    if (!repoLock.acquire(repo, owner)) {
      // Another job owns this repository; retry the recovery next tick.
      return { transitioned: false };
    }
    if (disposed) {
      repoLock.release(repo, owner);
      return { transitioned: false };
    }

    const round = Number.isSafeInteger(ticket.mr?.rounds) ? ticket.mr.rounds : 0;
    const lastNoteId = readLastNoteId(code);
    await clearError(code);
    startFixJob({
      code,
      repo,
      owner,
      context,
      ticket,
      findings,
      round,
      noteId: lastNoteId,
    });
    return { transitioned: false };
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
        await failFix(code, fixFailureReason(result), entry);
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

      // The child succeeded and the host committed. Build the ledger entries
      // NOW and persist the commit record BEFORE the push: a push/host failure
      // must be recoverable by pushing THIS commit, never by rerunning the
      // child (a clean worktree would otherwise look like no-changes).
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
      const record = {
        sha,
        worktree: branch.worktree,
        branch: branch.name,
        round: roundEntry.round,
        noteId: roundEntry.noteId,
        startedAt,
        finishedAt,
        changedFiles,
        diffStat: fixEntry.diffStat,
        diff,
        summary,
        testResult,
        ...(notes === undefined ? {} : { notes }),
        ...(childId === undefined ? {} : { childId }),
        ...(elapsedMs === undefined ? {} : { elapsedMs }),
        runId,
        status: 'succeeded',
      };
      await writeFixCommitRecord(code, record);
      if (entry.cancelled || disposed) return;

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

      await persistFixDone({ entry, code, runId, fixEntry, roundEntry });
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
   * transition into `fixing_review` already did). The patch reuses `runId` as
   * its idempotency key so a lost action can be reconciled without a second
   * ledger entry.
   */
  async function persistFixDone({ entry, code, runId, fixEntry, roundEntry }) {
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
    // Ledger + action are committed. Clearing is still best effort (a dispose
    // race can skip it), but a leftover record is harmless: the next round
    // purges it when it claims a note and recovery never replays a record whose
    // round/note do not match (N1).
    await clearFixCommitRecord(code);
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
   * Record the processed note id. Returns false when the claim could not be
   * persisted. The changes path writes this BEFORE `review_requests_changes`
   * and treats a failure as a hard error: without the claim the same note could
   * start a second round on a later tick (M2, rounds 1 -> 2).
   */
  async function writeLastNote(code, note, verdict) {
    if (disposed) return false;
    const record = {
      id: normalizeNoteId(note?.id),
      verdict,
      at: nowOrIso(),
    };
    try {
      await store.setMeta(REVIEW_LAST_NOTE_META_PREFIX + code, record);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Best-effort release of a note claim written before a refused transition:
   * the round never started, so the note must stay retryable. A failed release
   * fails safe (the note is skipped, never run twice).
   */
  function forgetLastNote(code) {
    if (disposed) return Promise.resolve();
    try {
      return store.setMeta(REVIEW_LAST_NOTE_META_PREFIX + code, null).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  /**
   * Persist the review-fix commit BEFORE the push (I1). The record is bounded
   * (no token, no raw note body) and carries everything needed to append the
   * ledger entry without a second child run.
   */
  function writeFixCommitRecord(code, record) {
    if (disposed) return Promise.resolve();
    try {
      return store.setMeta(REVIEW_FIX_COMMIT_META_PREFIX + code, record).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  /** Forget the pending-commit record after the round completed (or is stale). */
  function clearFixCommitRecord(code) {
    if (disposed) return Promise.resolve();
    try {
      return store.setMeta(REVIEW_FIX_COMMIT_META_PREFIX + code, null).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  /**
   * Read and bound the pending-commit record. Only a record staged for THIS
   * worktree and THIS personal branch is returned; a corrupt/foreign record is
   * ignored. The caller additionally binds it to the current `mr.rounds` /
   * `review.last-note` and verifies the branch tip via `probeWorktree` +
   * `revParse` before pushing anything.
   */
  function readFixCommitRecord(code, branch) {
    let value;
    try {
      value = store.getMeta(REVIEW_FIX_COMMIT_META_PREFIX + code);
    } catch {
      return undefined;
    }
    if (!isPlainObject(value)) return undefined;
    if (typeof value.sha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(value.sha)) return undefined;
    if (value.worktree !== branch.worktree || value.branch !== branch.name) return undefined;
    if (!Number.isSafeInteger(value.round) || value.round < 0) return undefined;
    if (typeof value.startedAt !== 'string' || value.startedAt === '') return undefined;
    if (typeof value.finishedAt !== 'string' || value.finishedAt === '') return undefined;
    if (typeof value.runId !== 'string' || value.runId === '') return undefined;
    return {
      sha: value.sha,
      worktree: branch.worktree,
      branch: branch.name,
      round: value.round,
      noteId: value.noteId === undefined ? 0 : normalizeNoteId(value.noteId),
      startedAt: value.startedAt,
      finishedAt: value.finishedAt,
      changedFiles: boundChangedFiles(value.changedFiles),
      diffStat: clipText(value.diffStat, REVIEW_DIFF_STAT_MAX_CHARS),
      diff: clipText(value.diff, REVIEW_DIFF_MAX_CHARS),
      summary: clipText(value.summary, REVIEW_TEXT_MAX_CHARS),
      testResult: clipText(value.testResult, REVIEW_TEXT_MAX_CHARS),
      ...(typeof value.notes === 'string'
        ? { notes: clipText(value.notes, REVIEW_TEXT_MAX_CHARS) }
        : {}),
      ...(typeof value.childId === 'string' && value.childId !== ''
        ? { childId: value.childId.slice(0, REVIEW_CHILD_ID_MAX_CHARS) }
        : {}),
      ...(Number.isFinite(value.elapsedMs)
        ? { elapsedMs: Math.max(0, Math.trunc(value.elapsedMs)) }
        : {}),
      runId: value.runId,
      status: 'succeeded',
    };
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
 * OWN top-level lines carry both the `AI Code Review` marker and a `结论:` line
 * (delegated to the canonical `isReviewBody()` so a human reply that quotes or
 * pastes a note is never treated as template drift). The parser then decides
 * pass/changes/unknown. Ordering is done here because the GitLab client
 * preserves the upstream order and consumers must not trust it.
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
  return isReviewBody(typeof note.body === 'string' ? note.body : '');
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
 * Bound the findings persisted with `review_requests_changes` and handed to the
 * child. A single giant note must not blow up the snapshot (which every client
 * receives) nor the prompt data budget; the caps mirror the prompt renderer.
 */
function boundFindings(blocking, nonBlocking) {
  return {
    blocking: boundIssueList(blocking, REVIEW_BLOCKING_ISSUES_MAX),
    nonBlocking: boundIssueList(nonBlocking, REVIEW_NON_BLOCKING_ISSUES_MAX),
  };
}

function boundIssueList(items, maxItems) {
  if (!Array.isArray(items) || maxItems <= 0) return [];
  const result = [];
  for (const item of items) {
    if (result.length >= maxItems) break;
    if (!isPlainObject(item)) continue;
    result.push({
      file: clipText(item.file, REVIEW_ISSUE_FIELD_MAX_CHARS),
      fid: clipText(item.fid, REVIEW_ISSUE_FIELD_MAX_CHARS),
      level: clipText(item.level, REVIEW_ISSUE_FIELD_MAX_CHARS),
      gateCategory: clipText(item.gateCategory, REVIEW_ISSUE_FIELD_MAX_CHARS),
      location: clipText(item.location, REVIEW_ISSUE_FIELD_MAX_CHARS),
      problem: clipText(item.problem, REVIEW_ISSUE_FIELD_MAX_CHARS),
      suggestion: clipText(item.suggestion, REVIEW_ISSUE_FIELD_MAX_CHARS),
    });
  }
  return result;
}

/** Rebuild the `fixes[]` entry recorded by a pending-commit record (I1). */
function buildFixEntry(record) {
  return {
    runId: record.runId,
    ...(record.childId === undefined ? {} : { childId: record.childId }),
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    changedFiles: Array.isArray(record.changedFiles) ? record.changedFiles : [],
    diffStat: record.diffStat,
    diff: record.diff,
    summary: record.summary,
    testResult: record.testResult,
    ...(record.notes === undefined ? {} : { notes: record.notes }),
    status: 'succeeded',
    ...(record.elapsedMs === undefined ? {} : { elapsedMs: record.elapsedMs }),
  };
}

/** Rebuild the `reviewRounds[]` entry recorded by a pending-commit record. */
function buildRoundEntry(record) {
  return {
    round: record.round,
    noteId: record.noteId,
    verdict: 'changes',
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    changedFiles: Array.isArray(record.changedFiles) ? record.changedFiles : [],
    ...(record.childId === undefined ? {} : { childId: record.childId }),
    status: 'succeeded',
  };
}

/**
 * Map the runner's internal failure code to a client-visible static reason.
 * `analysis-timeout` / `analysis-unavailable` are actionable (timeout vs. a
 * host/session problem) and must not be flattened into "check your workspace".
 */
function fixFailureReason(result) {
  const code = isPlainObject(result) ? result.code : undefined;
  if (code === 'analysis-timeout') return 'review-fix-timeout';
  if (code === 'analysis-unavailable') return 'review-fix-unavailable';
  return 'review-fix-failed';
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
