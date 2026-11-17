/**
 * 「开始测试 / 测试不通过 / 测试通过」 host service (P7).
 *
 * The AI fix runs on a ticket-scoped scratch branch; the human tests on the
 * developer's version branch (`feat-<version>-<user>`, checked out in the main
 * working tree). This service owns the three git transitions of that test step:
 *
 *   start  : commit the worktree changes on the scratch branch, then fast-
 *            forward/merge it into the dev branch (merge record in meta);
 *   revert : hard-reset the dev branch back to the recorded pre-merge commit
 *            (the scratch branch keeps its commits for another AI round);
 *   pass   : verify the merge is still intact, remove the worktree + scratch
 *            branch, then apply `mark_test_passed` (fix_done -> done).
 *            The GitLab delivery chain is retired, so a passed test archives
 *            the ticket directly instead of entering `submitting`.
 *
 * Every git failure is a static Chinese message; a rejected request writes
 * nothing. `start`/`pass` are synchronous git work (no background job): a merge
 * of a few files is bounded by the git executor's 30 s per-command timeout.
 */

import { buildCommitMessage } from './delivery-service.js';
import {
  DEV_BRANCH_MESSAGES,
  checkDevReady,
  cleanupTicketWorktree,
  clearMergeRecord,
  mergeWorktreeIntoDev,
  readMergeRecord,
  revertDevMerge,
  writeMergeRecord,
} from './dev-branch.js';

/** Static messages for this service's own refusal codes. */
export const TEST_SERVICE_MESSAGES = Object.freeze({
  'ticket-not-found': '工单不存在',
  'not-fix-done': '工单不在人工测试阶段，不能执行该操作',
  'test-merged': '已经合并到开发分支，请先测试通过或测试不通过',
  'test-not-merged': '请先点「开始测试」把改动合并到开发分支',
  'test-no-changes': '工作树没有可提交的改动，请先重新修复',
  'worktree-missing': '找不到工作树，请重新执行修复',
  'dev-branch-missing': DEV_BRANCH_MESSAGES['dev-branch-missing'],
  'dev-dirty': DEV_BRANCH_MESSAGES['dev-dirty'],
  'dev-ahead': DEV_BRANCH_MESSAGES['dev-ahead'],
  'merge-conflict': DEV_BRANCH_MESSAGES['merge-conflict'],
  'dev-moved': DEV_BRANCH_MESSAGES['dev-moved'],
  'git-failed': DEV_BRANCH_MESSAGES['git-failed'],
  'test-unavailable': '测试服务不可用，请稍后重试',
  'invalid-workspace': '无法确定工作区路径',
  'internal': '操作失败，请重试',
});

/**
 * @param {object} deps
 * @param {object} deps.store opened store (`get/list/getMeta/setMeta/applyAction/getSettings`)
 * @param {object} deps.git `createGit()` result
 * @param {Function} [deps.clock] host clock (`() => ISO string`)
 */
export function createTestService({ store, git, clock } = {}) {
  assertStore(store);
  assertGit(git);
  const readNow = typeof clock === 'function' ? clock : () => new Date().toISOString();

  /**
   * Merge the ticket's worktree changes into the dev branch.
   *
   * @returns {Promise<{ok:true, merged:object}
   *   | {ok:false, code:string, message:string, ahead?:string[]}>}
   */
  async function start(sessionId, cwd, code) {
    void sessionId;
    const key = normalizeCode(code);
    if (key === undefined) return failure('ticket-not-found', '缺少有效的工单编号 code');
    if (typeof cwd !== 'string' || cwd.trim() === '') return failure('invalid-workspace');

    const ticket = readTicket(key);
    if (ticket === undefined) return failure('ticket-not-found');
    if (ticket.workflow !== 'fix_done') return failure('not-fix-done');
    if (readMergeRecord(store, key) !== null) return failure('test-merged');

    const branch = readBranch(ticket);
    if (branch === undefined) return failure('worktree-missing');

    const repo = await repoRootOf(cwd);
    if (repo === undefined) return failure('git-failed');

    const probe = await probeWorktree(repo, branch);
    if (probe !== true) return failure('worktree-missing');

    // Validate the dev worktree BEFORE committing anything: a dirty tree or a
    // dev branch with unrelated commits must not leave a new scratch commit.
    const ready = await checkDevReady({ git, repo, devBranch: branch.devBranch, target: branch.target });
    if (ready.ok !== true) return failure(ready.code, undefined, ready.ahead);

    const settings = readSettings(cwd);
    const message = buildCommitMessage(settings, key, ticket);

    // Commit the AI's uncommitted changes on the scratch branch first: only
    // commits can be merged into the dev branch.
    const committed = await commitWorktree(branch.worktree, message);
    if (committed === undefined) return failure('git-failed');
    if (committed === null) {
      // A clean worktree is only fine when the scratch branch already carries
      // commits (e.g. a retry after a failed merge).
      const ahead = await worktreeAhead(repo, branch);
      if (ahead === null) return failure('test-no-changes');
    }

    const merged = await mergeWorktreeIntoDev({
      git,
      repo,
      scratchBranch: branch.name,
      devBranch: branch.devBranch,
      target: branch.target,
    });
    if (merged.ok !== true) return failure(merged.code, undefined, merged.ahead);

    const record = {
      devBranch: branch.devBranch,
      scratchBranch: branch.name,
      worktree: branch.worktree,
      devBefore: merged.devBefore,
      devAfter: merged.devAfter,
      at: timeOrNow(readNow),
    };
    try {
      await writeMergeRecord(store, key, record);
    } catch {
      return failure('internal');
    }
    return { ok: true, merged: record };
  }

  /**
   * Undo the recorded merge (test failed). The worktree keeps its commits for
   * another AI round.
   */
  async function revert(sessionId, cwd, code) {
    void sessionId;
    const key = normalizeCode(code);
    if (key === undefined) return failure('ticket-not-found', '缺少有效的工单编号 code');
    if (typeof cwd !== 'string' || cwd.trim() === '') return failure('invalid-workspace');

    const ticket = readTicket(key);
    if (ticket === undefined) return failure('ticket-not-found');
    if (ticket.workflow !== 'fix_done') return failure('not-fix-done');

    const record = readMergeRecord(store, key);
    if (record === null) return failure('test-not-merged');

    const repo = await repoRootOf(cwd);
    if (repo === undefined) return failure('git-failed');

    const reverted = await revertDevMerge({ git, repo, record });
    if (reverted.ok !== true) return failure(reverted.code);
    await clearMergeRecord(store, key);
    return { ok: true };
  }

  /**
   * Test passed: verify the merge, clean the worktree/scratch branch, then
   * archive the ticket (`fix_done -> done`; the GitLab delivery chain that
   * used to follow is retired).
   */
  async function pass(sessionId, cwd, code) {
    void sessionId;
    const key = normalizeCode(code);
    if (key === undefined) return failure('ticket-not-found', '缺少有效的工单编号 code');
    if (typeof cwd !== 'string' || cwd.trim() === '') return failure('invalid-workspace');

    const ticket = readTicket(key);
    if (ticket === undefined) return failure('ticket-not-found');
    if (ticket.workflow !== 'fix_done') return failure('not-fix-done');

    const record = readMergeRecord(store, key);
    if (record === null) return failure('test-not-merged');

    const repo = await repoRootOf(cwd);
    if (repo === undefined) return failure('git-failed');

    // The dev branch must still be exactly the merge result: if the user (or
    // anything else) committed on top, cleaning up now would hide a divergence.
    const current = await safeValue(() => git.currentBranch(repo));
    if (current !== record.devBranch) return failure('dev-moved');
    const head = await safeValue(() => git.revParse(repo, 'HEAD'));
    if (typeof head !== 'string' || head !== record.devAfter) return failure('dev-moved');

    await cleanupTicketWorktree({
      git,
      repo,
      worktree: record.worktree,
      scratchBranch: record.scratchBranch,
      devBranch: record.devBranch,
    });

    let applied;
    try {
      applied = await store.applyAction(
        key,
        'mark_test_passed',
        { actor: 'user' },
        { actionId: `test-pass-${key}-${timeOrNow(readNow)}` },
      );
    } catch {
      return failure('internal');
    }
    if (applied?.ok !== true) {
      return failure(
        typeof applied?.code === 'string' ? applied.code : 'internal',
        typeof applied?.message === 'string' ? applied.message : undefined,
      );
    }
    await clearMergeRecord(store, key);
    return { ok: true, ticket: applied.ticket };
  }

  /** Snapshot view: `{ merged: { [code]: record } }` for every merged ticket. */
  function status() {
    const merged = {};
    let tickets;
    try {
      tickets = store.list();
    } catch {
      return { merged };
    }
    if (!Array.isArray(tickets)) return { merged };
    for (const ticket of tickets) {
      const code = normalizeCode(ticket?.code);
      if (code === undefined) continue;
      const record = readMergeRecord(store, code);
      if (record !== null) merged[code] = record;
    }
    return { merged };
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  function readTicket(key) {
    let ticket;
    try {
      ticket = store.get(key);
    } catch {
      return undefined;
    }
    if (ticket === null || typeof ticket !== 'object') return undefined;
    return typeof ticket.workflow === 'string' ? ticket : undefined;
  }

  function readSettings(cwd) {
    try {
      return store.getSettings(cwd);
    } catch {
      return {};
    }
  }

  async function repoRootOf(cwd) {
    const repo = await safeValue(() => git.repoRoot(cwd));
    return typeof repo === 'string' && repo.trim() !== '' ? repo : undefined;
  }

  async function probeWorktree(repo, branch) {
    const probe = await safeValue(() => git.probeWorktree(repo, branch.worktree, branch.name));
    return probe !== null && typeof probe === 'object' && probe.ok === true && probe.state === 'same';
  }

  /** Commit the worktree; `undefined` = git failure, `null` = nothing staged. */
  async function commitWorktree(worktree, message) {
    const committed = await safeValue(() => git.commitAll({ root: worktree, message }));
    if (committed === null || typeof committed !== 'object' || committed.ok !== true) return undefined;
    return typeof committed.sha === 'string' && committed.sha !== '' ? committed.sha : null;
  }

  /** Commits on the scratch branch ahead of the dev branch, or `null`. */
  async function worktreeAhead(repo, branch) {
    const lines = await safeValue(
      () => git.log(repo, `${branch.devBranch}..${branch.name}`, { max: 1 }),
    );
    return Array.isArray(lines) && lines.length > 0 ? lines : null;
  }

  return { start, revert, pass, status };
}

// ---------------------------------------------------------------------------
// Validation / helpers
// ---------------------------------------------------------------------------

/** Fix-service branch metadata required by this service. */
function readBranch(ticket) {
  const branch = ticket !== null && typeof ticket === 'object' ? ticket.branch : null;
  if (branch === null || typeof branch !== 'object') return undefined;
  for (const field of ['name', 'target', 'worktree', 'devBranch']) {
    if (typeof branch[field] !== 'string' || branch[field] === '') return undefined;
  }
  return {
    name: branch.name,
    target: branch.target,
    worktree: branch.worktree,
    devBranch: branch.devBranch,
  };
}

function normalizeCode(code) {
  if (typeof code !== 'string') return undefined;
  const trimmed = code.trim();
  if (trimmed === '' || trimmed.length > 120) return undefined;
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : undefined;
}

function timeOrNow(readNow) {
  try {
    const value = readNow();
    return typeof value === 'string' && value !== '' ? value : new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function failure(code, message, ahead) {
  return {
    ok: false,
    code,
    message: typeof message === 'string'
      ? message
      : (TEST_SERVICE_MESSAGES[code] ?? TEST_SERVICE_MESSAGES.internal),
    ...(Array.isArray(ahead) ? { ahead } : {}),
  };
}

async function safeValue(fn) {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

function assertStore(store) {
  if (store === null || typeof store !== 'object') {
    throw new TypeError('createTestService() requires an opened store');
  }
  for (const method of ['get', 'list', 'getMeta', 'setMeta', 'applyAction', 'getSettings']) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(`createTestService() store.${method} must be a function`);
    }
  }
}

function assertGit(git) {
  if (git === null || typeof git !== 'object') {
    throw new TypeError('createTestService() requires a git executor');
  }
  for (const method of [
    'repoRoot', 'status', 'currentBranch', 'checkoutBranch', 'mergeBranch',
    'resetHard', 'revParse', 'log', 'commitAll', 'probeWorktree', 'worktreeRemove',
    'deleteBranch', 'refExists',
  ]) {
    if (typeof git[method] !== 'function') {
      throw new TypeError(`createTestService() git.${method} must be a function`);
    }
  }
}
