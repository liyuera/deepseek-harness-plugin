/**
 * Merge/revert/cleanup helpers for the "test on the dev branch" flow.
 *
 * The AI fix runs on a ticket-scoped scratch branch inside
 * `<repo>/.dsh-worktrees/<code>`; the developer's version branch
 * (`feat-<version>-<user>`) is checked out in the main working tree and is the
 * branch the human tests on and the MR is opened from:
 *
 *   scratch branch --merge--> dev branch --push--> MR: dev -> feature-<version>
 *
 * All git access is injected (`createGit()`); every failure is a static object
 * (`{ok:false, code, message}`), never a thrown error, so the host routes can
 * map them to HTTP statuses without leaking repository paths or git output.
 *
 * Safety rules (destructive operations):
 *
 *   - the main working tree must be clean before a merge or a revert;
 *   - a merge requires the dev branch to be checked out there (or a clean
 *     checkout can switch to it);
 *   - the dev branch must not be ahead of `origin/<target>` before the merge,
 *     so an MR opened from the dev branch can only contain this workflow's
 *     commits;
 *   - a revert only runs while the dev branch still points at the recorded
 *     merge result and the tree is clean — otherwise the user moved on and the
 *     workflow refuses instead of discarding their work.
 */

/** `meta` key holding the merge record of one ticket. */
export const DEV_MERGE_META_PREFIX = 'test.merge:';

/** Static failure copy (client-visible). */
export const DEV_BRANCH_MESSAGES = Object.freeze({
  'dev-dirty': '开发分支目录有未提交改动，请先提交或暂存后再试',
  'dev-branch-missing': '找不到开发分支，请先创建并推送你的版本分支',
  'dev-ahead': '开发分支上有与本单无关的提交，请先合并/清理后再试',
  'merge-conflict': '合并到开发分支失败（可能有冲突），请手动处理后重试',
  'dev-moved': '开发分支在合并后又有新提交，无法自动回滚，请手动处理',
  'git-failed': 'git 操作失败，请检查仓库状态后重试',
});

/** A merge record read back from `meta`. */
export function readMergeRecord(store, code) {
  let value;
  try {
    value = store.getMeta(DEV_MERGE_META_PREFIX + code);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const field of ['devBranch', 'scratchBranch', 'worktree', 'devBefore', 'devAfter']) {
    if (typeof value[field] !== 'string' || value[field] === '') return null;
  }
  return value;
}

/** Persist the merge record (best effort; the caller treats failure as fatal). */
export async function writeMergeRecord(store, code, record) {
  await store.setMeta(DEV_MERGE_META_PREFIX + code, record);
}

/** Forget the merge record after a successful delivery/cleanup. */
export async function clearMergeRecord(store, code) {
  try {
    await store.setMeta(DEV_MERGE_META_PREFIX + code, null);
  } catch {
    // A stale record only makes the board show "merged"; delivery re-verifies.
  }
}

/**
 * Merge the ticket scratch branch into the dev branch checked out in the main
 * working tree.
 *
 * @param {{git:object, repo:string, scratchBranch:string, devBranch:string,
 *   target:string, baseRef?:string|null}} input
 * @returns {Promise<{ok:true, devBefore:string, devAfter:string}
 *   | {ok:false, code:string, message:string, ahead?:string[]}>}
 */
export async function mergeWorktreeIntoDev({ git, repo, scratchBranch, devBranch, target }) {
  if (scratchBranch === devBranch) {
    return fail('dev-ahead', ['同一分支无需合并']);
  }

  const ready = await checkDevReady({ git, repo, devBranch, target });
  if (ready.ok !== true) return ready;

  let devBefore;
  try {
    devBefore = await git.revParse(repo, devBranch);
  } catch {
    devBefore = undefined;
  }
  if (typeof devBefore !== 'string') return fail('git-failed');

  const merged = await safeCall(() => git.mergeBranch({ repo, branch: scratchBranch }));
  if (merged !== undefined) return fail('merge-conflict');

  let devAfter;
  try {
    devAfter = await git.revParse(repo, 'HEAD');
  } catch {
    devAfter = undefined;
  }
  if (typeof devAfter !== 'string') return fail('git-failed');
  if (devAfter === devBefore) return fail('merge-conflict');

  return { ok: true, devBefore, devAfter };
}

/**
 * Pre-flight before any write: the dev worktree must be clean, on (or
 * switchable to) the dev branch, and must not carry commits the integration
 * branch does not have — otherwise the MR opened from it would include them.
 *
 * @returns {Promise<{ok:true} | {ok:false, code:string, message:string, ahead?:string[]}>}
 */
export async function checkDevReady({ git, repo, devBranch, target }) {
  const statusText = await safeValue(() => git.status(repo));
  if (typeof statusText !== 'string') return fail('git-failed');
  if (statusText.trim() !== '') return fail('dev-dirty');

  const current = await safeValue(() => git.currentBranch(repo));
  if (typeof current !== 'string') return fail('git-failed');

  if (current !== devBranch) {
    const exists = await safeValue(() => git.refExists(repo, devBranch));
    if (exists === null || typeof exists !== 'object' || exists.ok !== true || exists.exists !== true) {
      return fail('dev-branch-missing');
    }
    const switched = await safeCall(() => git.checkoutBranch({ repo, branch: devBranch }));
    if (switched !== undefined) return fail('git-failed');
  }

  const ahead = await commitsAhead(git, repo, target, devBranch);
  if (Array.isArray(ahead) && ahead.length > 0) return fail('dev-ahead', ahead);
  return { ok: true };
}

/**
 * Undo one recorded merge: hard reset the dev branch back to the pre-merge
 * commit, but only while the branch still points at the merge result and the
 * tree is clean.
 */
export async function revertDevMerge({ git, repo, record }) {
  const { devBranch, devBefore, devAfter } = record === null || typeof record !== 'object' ? {} : record;
  if (typeof devBranch !== 'string' || typeof devBefore !== 'string' || typeof devAfter !== 'string') {
    return fail('git-failed');
  }

  const current = await safeValue(() => git.currentBranch(repo));
  if (current !== devBranch) return fail('dev-moved');

  const statusText = await safeValue(() => git.status(repo));
  if (typeof statusText !== 'string' || statusText.trim() !== '') return fail('dev-dirty');

  const head = await safeValue(() => git.revParse(repo, 'HEAD'));
  if (typeof head !== 'string' || head !== devAfter) return fail('dev-moved');

  const reset = await safeCall(() => git.resetHard({ repo, sha: devBefore }));
  if (reset !== undefined) return fail('git-failed');
  return { ok: true };
}

/**
 * Remove the ticket worktree and delete its scratch branch. Best effort: a
 * missing worktree/branch is already cleaned enough, and the merge has
 * already landed on the dev branch.
 */
export async function cleanupTicketWorktree({ git, repo, worktree, scratchBranch, devBranch }) {
  if (typeof scratchBranch === 'string' && scratchBranch !== '' && scratchBranch !== devBranch) {
    await safeCall(() => git.deleteBranch(repo, scratchBranch));
  }
  if (typeof worktree === 'string' && worktree !== '') {
    await safeCall(() => git.worktreeRemove({ repo, path: worktree, force: true }));
  }
  return { ok: true };
}

/** Lines of `origin/<target>..<dev>` (or `<target>..<dev>`), or `null`. */
async function commitsAhead(git, repo, target, devBranch) {
  if (typeof target !== 'string' || target === '') return null;
  for (const base of [`origin/${target}`, target]) {
    const exists = await safeValue(() => git.refExists(repo, base));
    if (exists === null || typeof exists !== 'object' || exists.ok !== true || exists.exists !== true) {
      continue;
    }
    const lines = await safeValue(() => git.log(repo, `${base}..${devBranch}`, { max: 20 }));
    if (Array.isArray(lines)) return lines;
  }
  return null;
}

function fail(code, ahead) {
  return {
    ok: false,
    code,
    message: DEV_BRANCH_MESSAGES[code] ?? DEV_BRANCH_MESSAGES['git-failed'],
    ...(Array.isArray(ahead) ? { ahead } : {}),
  };
}

/** Call a git method, returning the failure object or `undefined` on success. */
async function safeCall(fn) {
  let result;
  try {
    result = await fn();
  } catch {
    return { ok: false };
  }
  return result === undefined ? undefined : result;
}

/** Call a git method, swallowing throws into `undefined`. */
async function safeValue(fn) {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}
