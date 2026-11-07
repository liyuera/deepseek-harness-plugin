/**
 * Dependency-injected git worktree executor for the bug workflow (P4 Task 1).
 *
 * P4 never commits or pushes: the fix subagent works in
 * `<repo>/.dsh-worktrees/<code>`, and this module owns the small git surface
 * needed to create, inspect and remove that worktree. The host wires it with
 * the result of `createGit()`; tests inject a fake `execFile`.
 *
 * Contract:
 *
 *   createGit({ execFile?, timeoutMs? }) -> {
 *     repoRoot(cwd)                         -> Promise<string>,
 *     refExists(repo, ref)                  -> Promise<{ok:true, exists:boolean}>,
 *     worktreePath({repo, code})            -> {ok:true, path:string}, // sync
 *     worktreeAdd({repo,path,branch,base})  -> Promise<{created:boolean}>,
 *     listWorktrees(repo)                   -> Promise<{ok:true, entries:Array<{path,branch}>}>,
 *     probeWorktree(repo, path, branch)     -> Promise<{ok:true, state:'absent'|'unregistered'|'same'|'different'}>,
 *     status(root)                          -> Promise<string>,   // porcelain
 *     diffStat(root)                        -> Promise<string>,
 *     diff(root, {maxChars?})               -> Promise<string>,
 *     worktreeRemove({repo,path,force?})    -> Promise<void>,
 *     revParse(repo, ref)                   -> Promise<string>,   // full sha
 *     commitAll({root, message})            -> Promise<{ok:true, sha:string|null}>,
 *     pushBranch({root,remote?,branch})     -> Promise<{ok:true, branch, remote}>,
 *   }
 *
 * P5 adds the delivery half: `commitAll` stages everything inside the worktree
 * and creates exactly one commit (never an empty one), `pushBranch` pushes the
 * personal branch to `origin` with upstream tracking and NEVER force-pushes,
 * and {@link assertPushableBranch} refuses every protected integration branch
 * (`main`/`master`/`dev`/`develop`, `feature-*`, `hotfix-*`, `release-*`,
 * case-insensitive, with or without the `refs/heads/` prefix) before git is
 * even spawned.
 *
 * `listWorktrees` / `probeWorktree` were private P4 closures; they are public
 * P5 API because the branch/worktree conflict diagnosis (and later the review
 * service) needs the same registered-worktree mapping outside `worktreeAdd`.
 *
 * Success values are the raw values shown above (string/boolean/undefined);
 * any expected failure resolves to a STATIC structured object instead of
 * throwing:
 *
 *   { ok:false, code:'git-failed'|'git-timeout'|'worktree-conflict'
 *                     |'invalid-worktree-path',
 *     message:<static Chinese>, command:<static command label> }
 *
 * `refExists` wraps its boolean in `{ok:true, exists}` so a failure object can
 * never be coerced into "the ref exists". A `rev-parse --verify --quiet` exit
 * code 1 (the normal "ref missing" case) is `{ok:true, exists:false}`; any
 * other failure (timeout, not a repository, permissions) is a structured
 * failure. Callers must branch on `.ok`; `if (await refExists(...))` would
 * treat any object as true and is wrong.
 *
 * `worktreePath` is a pure synchronous helper: it rejects a ticket code that is
 * not `[A-Za-z0-9._-]{1,120}` (or is `.`/`..`) with `invalid-worktree-path`, so
 * callers never hand raw ticket text to the filesystem.
 *
 * `worktreeAdd` distinguishes a *registered* worktree from any directory that
 * merely sits inside a repository (the product path is inside the repo, so a
 * plain directory there is not evidence of a worktree):
 *
 *   - `git -C <repo> worktree list --porcelain` is matched against the
 *     realpath of `path`, and `git -C <path> rev-parse --show-toplevel` must
 *     equal that realpath as well;
 *   - a registered worktree on the requested branch is reused
 *     (`{created:false}`), a different branch is `worktree-conflict`;
 *   - a path that is absent or not registered is passed to
 *     `git worktree add` (an existing empty directory works; a non-empty
 *     plain directory becomes `git-failed`);
 *   - when the branch already exists (e.g. the retained branch after
 *     `worktreeRemove`, or a manual `git worktree add` elsewhere), the add
 *     omits `-b` and checks the branch out; if the branch is already checked
 *     out in ANOTHER registered worktree the result is
 *     `worktree-conflict` (409), never `git-failed`.
 *
 * Safety:
 *
 *   - `execFile('git', [...argv])` only — no shell, so ticket/user text can
 *     never be interpreted as a command; everything after the repo path is an
 *     argv element.
 *   - `-C <dir>` plus a `--` separator before worktree paths, and leading `-`
 *     is rejected for refs/branches, so a value cannot become a git option.
 *   - paths/refs containing newline, carriage return or NUL are rejected before
 *     spawning; blank/non-string values too.
 *   - every git invocation has a 30 s default timeout and a bounded buffer.
 *   - child `message`/`stderr` are never copied into a result or message, so a
 *     repository path or remote URL echoed by git cannot leak through errors.
 *
 * Imports are `node:child_process` (default execFile), `node:util`
 * (promisify), `node:fs/promises` (realpath comparison only) and `node:path`
 * (pure path join). The module reads paths but never writes the filesystem;
 * git itself owns creation/removal.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { isSafeBranchName } from './branch.js';

/** Default per-command timeout (P4 global constraint). */
export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/** `git push` network budget (P5 delivery). */
export const PUSH_TIMEOUT_MS = 60_000;

/** Hard upper bound for a commit message (defensive only). */
export const MAX_COMMIT_MESSAGE_CHARS = 10_000;

/** Default diff clip length (module constant; not read from the plan). */
export const DIFF_MAX_CHARS = 20_000;

/** Hard upper bound for a `diff()` caller-provided limit. */
const DIFF_MAX_CHARS_CAP = 200_000;

/** Child stdout/stderr buffer bound. */
const MAX_BUFFER = 10 * 1024 * 1024;

/** Product worktree directory, always directly below the repository root. */
export const WORKTREE_DIR = '.dsh-worktrees';

/** Accepted ticket codes for a worktree directory component. */
const WORKTREE_CODE_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;

/** Static marker appended when a diff is clipped. */
export const DIFF_TRUNCATED_MARKER = '\n…（diff 已截断）';

const MESSAGE = Object.freeze({
  failed: 'git 命令执行失败',
  timeout: 'git 命令执行超时',
  conflict: '工作树已存在且分支与目标分支不一致',
  branchBusy: '个人分支已在其它工作树中检出，请先清理该工作树',
  invalid: 'git 命令参数不合法',
  invalidWorktreePath: '工单号无法生成安全的工作树路径',
  invalidBranch: '分支名不合法，不允许推送',
  protectedBranch: '受保护的分支不允许推送',
  invalidMessage: '提交信息不合法',
});

/** Static command labels carried by failures (never include argv/paths). */
const COMMAND = Object.freeze({
  repoRoot: 'git rev-parse --show-toplevel',
  refExists: 'git rev-parse --verify',
  showToplevel: 'git rev-parse --show-toplevel',
  worktreeList: 'git worktree list --porcelain',
  worktreeAdd: 'git worktree add',
  status: 'git status --porcelain',
  diffStat: 'git diff --stat',
  diff: 'git diff',
  worktreeRemove: 'git worktree remove',
  revParse: 'git rev-parse',
  addAll: 'git add -A',
  stagedCheck: 'git diff --cached --quiet',
  commit: 'git commit',
  push: 'git push -u',
});

/**
 * Branches that must never be pushed. The integration branches are matched
 * case-insensitively after the `refs/heads/` prefix (if any) is stripped:
 * `main`, `master`, `dev`, `develop`, `feature-*`, `hotfix-*`, `release-*`.
 * `master`/`develop` are included as the conservative aliases of the spec's
 * `main`/`dev` rules.
 */
const PROTECTED_EXACT = Object.freeze(['main', 'master', 'dev', 'develop']);

/** `feature-*` / `feature/…` (and the hotfix/release families). */
const PROTECTED_PREFIX = /^(?:feature|hotfix|release)(?:-|\/|$)/i;

/**
 * Thrown for a branch that must not be pushed. `code` is `protected-branch`
 * for an integration branch and `invalid-branch` for a malformed name; the
 * message is static and never echoes the rejected value.
 */
export class GitError extends Error {
  /**
   * @param {'protected-branch'|'invalid-branch'} code stable failure code
   * @param {string} message static Chinese description
   */
  constructor(code, message) {
    super(message);
    this.name = 'GitError';
    this.code = code;
  }
}

/**
 * Refuse a protected or malformed push target before any git invocation.
 *
 * Accepts the personal branch shapes `feat-<X>-<user>` / `hot-<X>-<user>` and
 * any other non-protected, ref-safe branch name. `refs/heads/<name>` is
 * accepted for the check and normalized to `<name>` (that is also what
 * `pushBranch` pushes). Rejection is a thrown {@link GitError}; the delivery
 * service maps it to a static `protected-branch` failure.
 *
 * @param {unknown} name branch name
 * @returns {string} normalized branch name that may be pushed
 * @throws {GitError} `protected-branch` / `invalid-branch`
 */
export function assertPushableBranch(name) {
  const branch = normalizePushBranch(name);
  if (branch === undefined || !isSafeBranchName(branch)) {
    throw new GitError('invalid-branch', MESSAGE.invalidBranch);
  }
  if (isProtectedBranch(branch)) {
    throw new GitError('protected-branch', MESSAGE.protectedBranch);
  }
  return branch;
}

/**
 * Build and validate the product worktree path for one ticket.
 *
 * Pure and synchronous. The ticket code is untrusted: only
 * `[A-Za-z0-9._-]{1,120}` is accepted, and `.`/`..` are rejected so the
 * returned path can never escape `<repo>/.dsh-worktrees`.
 *
 * @param {{repo?: unknown, code?: unknown}} input
 * @returns {{ok:true, path:string} | {ok:false, code:'invalid-worktree-path', message:string, command:string}}
 */
export function worktreePath(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return failure('invalid-worktree-path', MESSAGE.invalidWorktreePath, COMMAND.worktreeAdd);
  }

  const { repo, code } = input;
  if (!isSafePath(repo)) {
    return failure('invalid-worktree-path', MESSAGE.invalidWorktreePath, COMMAND.worktreeAdd);
  }
  if (typeof code !== 'string' || !WORKTREE_CODE_PATTERN.test(code) || code === '.' || code === '..') {
    return failure('invalid-worktree-path', MESSAGE.invalidWorktreePath, COMMAND.worktreeAdd);
  }

  return { ok: true, path: join(repo, WORKTREE_DIR, code) };
}

/**
 * Create a git executor bound to one injected `execFile` and timeout.
 *
 * `execFile` is expected to be promisified: `(file, args, options) =>
 * Promise<{stdout, stderr}>`. The default is exactly
 * `promisify(node:child_process.execFile)`. Passing a non-function throws a
 * `TypeError` at construction time (configuration error), while every runtime
 * git failure resolves to the structured object documented above.
 *
 * @param {{execFile?: Function, timeoutMs?: number}} [options]
 * @returns {object} the git surface listed in the file header
 * @throws {TypeError} invalid options / non-function execFile
 */
export function createGit(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createGit(options) requires an options object');
  }

  const execFile = options.execFile ?? promisify(nodeExecFile);
  if (typeof execFile !== 'function') {
    throw new TypeError('createGit() options.execFile must be a function');
  }
  const timeoutMs = positiveInteger(options.timeoutMs) ?? DEFAULT_GIT_TIMEOUT_MS;

  /**
   * Run one `git -C <dir> ...` command.
   *
   * @param {unknown} dir repository or worktree directory (`-C` target)
   * @param {string[]} args git argv (without the leading `git -C dir`)
   * @param {{command: string, missingRef?: boolean, timeout?: number,
   *   allowedExitCodes?: number[]}} labels static failure label;
   *   `missingRef` maps a `rev-parse --verify --quiet` exit code 1 to a
   *   successful "missing" outcome instead of a failure; `allowedExitCodes`
   *   turns specific non-zero exit codes (e.g. 1 for "diff exists") into
   *   `{ok:true, exitCode}` results
   * @returns {Promise<{ok: true, stdout: string, exitCode?: number, missing?: boolean} | {ok: false, code: string, message: string, command: string}>}
   */
  async function run(dir, args, {
    command,
    missingRef = false,
    timeout = timeoutMs,
    allowedExitCodes,
  }) {
    if (!isSafePath(dir)) return failure('git-failed', MESSAGE.invalid, command);

    let result;
    try {
      result = await execFile('git', ['-C', dir, ...args], {
        timeout,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        windowsHide: true,
      });
    } catch (error) {
      if (missingRef && isMissingRef(error)) {
        return { ok: true, stdout: '', missing: true };
      }
      if (isAllowedExit(error, allowedExitCodes)) {
        return { ok: true, stdout: '', exitCode: error.code };
      }
      return normalizeFailure(error, command);
    }
    return { ok: true, stdout: stdoutOf(result) };
  }

  /** @param {unknown} cwd */
  async function repoRoot(cwd) {
    const result = await run(cwd, ['rev-parse', '--show-toplevel'], { command: COMMAND.repoRoot });
    if (!result.ok) return result;

    const root = result.stdout.trim();
    if (!isSafePath(root)) return failure('git-failed', MESSAGE.invalid, COMMAND.repoRoot);
    return root;
  }

  /**
   * Check whether a ref exists.
   *
   * @param {unknown} repo
   * @param {unknown} ref
   * @returns {Promise<{ok:true, exists:boolean} | {ok:false, code: string, message: string, command: string}>}
   */
  async function refExists(repo, ref) {
    if (!isSafePath(repo) || !isSafeRef(ref)) {
      return failure('git-failed', MESSAGE.invalid, COMMAND.refExists);
    }

    const result = await run(repo, ['rev-parse', '--verify', '--quiet', ref], {
      command: COMMAND.refExists,
      missingRef: true,
    });
    if (!result.ok) return result;
    return { ok: true, exists: result.missing !== true };
  }

  /** List registered worktrees of `repo`; porcelain output is parsed locally. */
  async function listWorktrees(repo) {
    const result = await run(repo, ['worktree', 'list', '--porcelain'], {
      command: COMMAND.worktreeList,
    });
    if (!result.ok) return result;
    return { ok: true, entries: parseWorktreeList(result.stdout) };
  }

  /**
   * Classify `path` relative to the requested worktree.
   *
   * Returns one of `{state:'absent'}` (path does not exist),
   * `{state:'unregistered'}` (exists but is not a registered worktree of this
   * repo, e.g. a plain directory inside the repository),
   * `{state:'same'}` (registered worktree checked out on `branch`), or
   * `{state:'different'}` (registered worktree on another/detached HEAD).
   *
   * @returns {Promise<{ok:true, state:string} | {ok:false, code:string, message:string, command:string}>}
   */
  async function probeWorktree(repo, path, branch) {
    const targetReal = await realpathOrNull(path);
    if (targetReal === null) return { ok: true, state: 'absent' };

    const listed = await listWorktrees(repo);
    if (!listed.ok) return listed;

    let entry;
    for (const candidate of listed.entries) {
      const candidateReal = await realpathOrNull(candidate.path);
      if (candidateReal !== null && candidateReal === targetReal) {
        entry = candidate;
        break;
      }
    }
    if (entry === undefined) return { ok: true, state: 'unregistered' };

    // The registration must actually resolve back to this exact directory;
    // otherwise a stale/reused entry is not evidence of an existing worktree.
    const top = await run(path, ['rev-parse', '--show-toplevel'], {
      command: COMMAND.showToplevel,
    });
    if (!top.ok) {
      if (top.code === 'git-timeout') return top;
      return { ok: true, state: 'unregistered' };
    }
    const topReal = await realpathOrNull(top.stdout.trim());
    if (topReal === null || topReal !== targetReal) return { ok: true, state: 'unregistered' };

    if (entry.branch === `refs/heads/${branch}`) return { ok: true, state: 'same' };
    return { ok: true, state: 'different' };
  }

  /**
   * True when `branch` is checked out in a registered worktree other than
   * `path`. Used to diagnose the "already checked out elsewhere" refusal of
   * `git worktree add` (a user-created manual worktree) as a static 409
   * instead of an opaque `git-failed`. A failed `worktree list` returns false
   * so the caller keeps the original failure.
   */
  async function branchCheckedOutElsewhere(repo, path, branch) {
    const listed = await listWorktrees(repo);
    if (listed.ok !== true) return false;
    const targetReal = await realpathOrNull(path);
    for (const entry of listed.entries) {
      if (entry.branch !== `refs/heads/${branch}`) continue;
      const entryReal = await realpathOrNull(entry.path);
      if (entryReal === null) continue;
      if (targetReal === null || entryReal !== targetReal) return true;
    }
    return false;
  }

  /**
   * Create a worktree on `branch`, or reuse a registered one already at `path`.
   *
   * @param {{repo?: unknown, path?: unknown, branch?: unknown, base?: unknown}} input
   * @returns {Promise<{created: boolean} | {ok: false, code: string, message: string, command: string}>}
   */
  async function worktreeAdd(input = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return failure('git-failed', MESSAGE.invalid, COMMAND.worktreeAdd);
    }
    const { repo, path, branch, base } = input;
    if (!isSafePath(repo) || !isSafePath(path) || !isSafeRef(branch) || !isSafeRef(base)) {
      return failure('git-failed', MESSAGE.invalid, COMMAND.worktreeAdd);
    }

    const probe = await probeWorktree(repo, path, branch);
    if (probe.ok === false) {
      return failure(probe.code, probe.message, COMMAND.worktreeAdd);
    }
    if (probe.state === 'same') return { created: false };
    if (probe.state === 'different') {
      return failure('worktree-conflict', MESSAGE.conflict, COMMAND.worktreeAdd);
    }

    // Re-adding a branch whose worktree was removed must not pass `-b` again;
    // in that case the existing branch itself is the commit-ish to check out.
    const branchState = await refExists(repo, branch);
    if (branchState.ok === false) {
      return failure(branchState.code, branchState.message, COMMAND.worktreeAdd);
    }
    const args = ['worktree', 'add'];
    if (branchState.exists === true) {
      args.push('--', path, branch);
    } else {
      args.push('-b', branch, '--', path, base);
    }

    const added = await run(repo, args, { command: COMMAND.worktreeAdd });
    if (added.ok) return { created: true };

    // A concurrent caller may have won the race between probe and add. Reuse a
    // matching worktree, report a mismatch as a conflict, otherwise surface the
    // original static failure (e.g. an existing non-empty non-worktree dir).
    const raced = await probeWorktree(repo, path, branch);
    if (raced.ok === false) return added;
    if (raced.state === 'same') return { created: false };
    if (raced.state === 'different') {
      return failure('worktree-conflict', MESSAGE.conflict, COMMAND.worktreeAdd);
    }
    // The add can also fail because `branch` is already checked out in a
    // DIFFERENT registered worktree (the user ran `git worktree add` manually);
    // the target path itself is still absent, so re-probing it cannot see that.
    const elsewhere = await branchCheckedOutElsewhere(repo, path, branch);
    if (elsewhere === true) {
      return failure('worktree-conflict', MESSAGE.branchBusy, COMMAND.worktreeAdd);
    }
    return added;
  }

  /** `git status --porcelain`; leading status columns are preserved. */
  async function status(root) {
    const result = await run(root, ['status', '--porcelain'], { command: COMMAND.status });
    if (!result.ok) return result;
    return result.stdout.trimEnd();
  }

  /** `git diff --stat` (working-tree changes). */
  async function diffStat(root) {
    const result = await run(root, ['diff', '--stat'], { command: COMMAND.diffStat });
    if (!result.ok) return result;
    return result.stdout.trimEnd();
  }

  /**
   * `git diff` (working-tree changes), clipped to `maxChars` with a static
   * marker. The default is the module constant `DIFF_MAX_CHARS` (20 000); the
   * cap is 200 000.
   *
   * @param {unknown} root worktree path
   * @param {{maxChars?: number}} [options]
   */
  async function diff(root, options = {}) {
    const { maxChars } = options !== null && typeof options === 'object' ? options : {};
    const limit = Math.min(positiveInteger(maxChars) ?? DIFF_MAX_CHARS, DIFF_MAX_CHARS_CAP);
    const result = await run(root, ['diff', '--no-color'], { command: COMMAND.diff });
    if (!result.ok) return result;

    const text = result.stdout.trimEnd();
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}${DIFF_TRUNCATED_MARKER}`;
  }

  /**
   * Remove a worktree. A dirty worktree is refused by git unless `force` is
   * true; the branch itself is kept (P5 pushes it later).
   *
   * @param {{repo?: unknown, path?: unknown, force?: boolean}} input
   * @returns {Promise<void | {ok: false, code: string, message: string, command: string}>}
   */
  async function worktreeRemove(input = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return failure('git-failed', MESSAGE.invalid, COMMAND.worktreeRemove);
    }
    const { repo, path, force } = input;
    if (!isSafePath(repo) || !isSafePath(path)) {
      return failure('git-failed', MESSAGE.invalid, COMMAND.worktreeRemove);
    }

    const args = ['worktree', 'remove'];
    if (force === true) args.push('--force');
    args.push('--', path);

    const result = await run(repo, args, { command: COMMAND.worktreeRemove });
    if (!result.ok) return result;
    return undefined;
  }

  /**
   * Resolve one ref to its full object name (sha).
   *
   * @param {unknown} repo repository/worktree path
   * @param {unknown} ref ref or commit-ish (never an option: `--` is not used,
   *   so a leading `-` is rejected)
   * @returns {Promise<string | {ok:false, code:string, message:string, command:string}>}
   */
  async function revParse(repo, ref) {
    if (!isSafePath(repo) || !isSafeRef(ref)) {
      return failure('git-failed', MESSAGE.invalid, COMMAND.revParse);
    }
    const result = await run(repo, ['rev-parse', '--verify', ref], { command: COMMAND.revParse });
    if (!result.ok) return result;
    const sha = result.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
      return failure('git-failed', MESSAGE.failed, COMMAND.revParse);
    }
    return sha;
  }

  /**
   * Stage every change inside `root` and create one commit.
   *
   * `git add -A` runs first; `git diff --cached --quiet` then decides whether
   * there is anything to commit (exit 1 means staged changes exist). An empty
   * worktree resolves to `{ok:true, sha:null}` and creates NO empty commit.
   * The commit message is passed as a single `-m` argv element — no shell, so
   * ticket text in the template can never be interpreted as a command.
   *
   * @param {{root?: unknown, message?: unknown}} input
   * @returns {Promise<{ok:true, sha:string|null}
   *   | {ok:false, code:string, message:string, command:string}>}
   */
  async function commitAll(input = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return failure('git-failed', MESSAGE.invalid, COMMAND.commit);
    }
    const { root, message } = input;
    if (!isSafePath(root) || !isSafeCommitMessage(message)) {
      return failure('git-failed', MESSAGE.invalidMessage, COMMAND.commit);
    }

    const added = await run(root, ['add', '-A'], { command: COMMAND.addAll });
    if (!added.ok) return added;

    const staged = await run(root, ['diff', '--cached', '--quiet'], {
      command: COMMAND.stagedCheck,
      allowedExitCodes: [1],
    });
    if (!staged.ok) return staged;
    if (staged.exitCode !== 1) return { ok: true, sha: null };

    const committed = await run(root, ['commit', '-m', message], { command: COMMAND.commit });
    if (!committed.ok) return committed;

    const sha = await revParse(root, 'HEAD');
    if (typeof sha !== 'string') {
      return failure(sha?.code === 'git-timeout' ? 'git-timeout' : 'git-failed', MESSAGE.failed, COMMAND.commit);
    }
    return { ok: true, sha };
  }

  /**
   * Push one personal branch to a remote with upstream tracking.
   *
   * The branch is validated by {@link assertPushableBranch} BEFORE any git
   * process is spawned; a protected branch resolves to
   * `{ok:false, code:'protected-branch'}` (never a git error). The argv is
   * exactly `push -u <remote> <branch>` — no `--force`, no force-with-lease,
   * no arbitrary refspec — and the command gets the 60 s push budget.
   *
   * @param {{root?: unknown, remote?: unknown, branch?: unknown}} input
   * @returns {Promise<{ok:true, branch:string, remote:string}
   *   | {ok:false, code:string, message:string, command:string}>}
   */
  async function pushBranch(input = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return failure('git-failed', MESSAGE.invalid, COMMAND.push);
    }
    const { root, remote = 'origin', branch: rawBranch } = input;
    if (!isSafePath(root) || !isSafeRemote(remote)) {
      return failure('git-failed', MESSAGE.invalid, COMMAND.push);
    }

    let branch;
    try {
      branch = assertPushableBranch(rawBranch);
    } catch (error) {
      if (error instanceof GitError) return failure(error.code, error.message, COMMAND.push);
      return failure('git-failed', MESSAGE.invalid, COMMAND.push);
    }

    const result = await run(root, ['push', '-u', remote, branch], {
      command: COMMAND.push,
      timeout: PUSH_TIMEOUT_MS,
    });
    if (!result.ok) return result;
    return { ok: true, branch, remote };
  }

  return {
    repoRoot,
    refExists,
    worktreePath,
    worktreeAdd,
    listWorktrees,
    probeWorktree,
    status,
    diffStat,
    diff,
    worktreeRemove,
    revParse,
    commitAll,
    pushBranch,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failure(code, message, command) {
  return { ok: false, code, message, command };
}

/** Parse `git worktree list --porcelain` blocks into `{path, branch}` entries. */
function parseWorktreeList(text) {
  const entries = [];
  let current;

  for (const line of text.split('\n')) {
    if (line === '') {
      current = undefined;
      continue;
    }
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: undefined };
      entries.push(current);
    } else if (current !== undefined && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    }
  }

  return entries;
}

/** `realpath` with a null result for a missing/unreadable path. */
async function realpathOrNull(path) {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/**
 * Map a rejected `execFile` to a static failure. The raw error is inspected
 * only for the timeout/maxBuffer flags; its `message`/`stderr` are deliberately
 * dropped.
 */
function normalizeFailure(error, command) {
  if (isMaxBufferError(error)) return failure('git-failed', MESSAGE.failed, command);

  return isTimeoutError(error)
    ? failure('git-timeout', MESSAGE.timeout, command)
    : failure('git-failed', MESSAGE.failed, command);
}

/**
 * A bounded stdout/stderr overflow is a normal `git-failed`, never a timeout
 * (the child is often killed while being stopped for the buffer limit).
 */
function isMaxBufferError(error) {
  return error !== null
    && typeof error === 'object'
    && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

function isTimeoutError(error) {
  return error !== null
    && typeof error === 'object'
    && (
      error.killed === true
      || error.signal === 'SIGTERM'
      || error.code === 'ETIMEDOUT'
      || error.code === 'ABORT_ERR'
    );
}

/**
 * `rev-parse --verify --quiet` exits 1 when the ref cannot be resolved; that is
 * the only non-zero result that means "missing" rather than a git failure.
 */
function isMissingRef(error) {
  if (isMaxBufferError(error) || isTimeoutError(error)) return false;
  return error !== null
    && typeof error === 'object'
    && error.code === 1
    && error.signal == null;
}

/**
 * A caller-declared tolerable exit code (e.g. 1 for `git diff --cached
 * --quiet`). Timeouts and buffer overflows are never tolerated.
 */
function isAllowedExit(error, allowedExitCodes) {
  if (!Array.isArray(allowedExitCodes) || allowedExitCodes.length === 0) return false;
  if (isMaxBufferError(error) || isTimeoutError(error)) return false;
  return error !== null
    && typeof error === 'object'
    && error.signal == null
    && typeof error.code === 'number'
    && allowedExitCodes.includes(error.code);
}

/** Strip an optional `refs/heads/` prefix and validate the snapshot shape. */
function normalizePushBranch(value) {
  if (typeof value !== 'string') return undefined;
  let branch = value.trim();
  if (branch.toLowerCase().startsWith('refs/heads/')) {
    branch = branch.slice('refs/heads/'.length);
  }
  // Only a plain branch name may be pushed. Any other full ref (`refs/tags/…`,
  // `refs/remotes/…`) could smuggle a non-branch refspec into `git push`.
  if (branch.toLowerCase().startsWith('refs/')) return undefined;
  return branch === '' ? undefined : branch;
}

/** True for every protected integration branch family (case-insensitive). */
function isProtectedBranch(branch) {
  const lower = branch.toLowerCase();
  if (PROTECTED_EXACT.includes(lower)) return true;
  return PROTECTED_PREFIX.test(lower);
}

/**
 * A push remote is operator configuration (`origin` by default): a non-blank
 * string that cannot become a git option and contains no control characters.
 * It is deliberately broader than a ref name because it may be a path or URL.
 */
function isSafeRemote(value) {
  if (typeof value !== 'string') return false;
  const remote = value.trim();
  if (remote === '' || remote.length > 1024) return false;
  if (remote.startsWith('-')) return false;
  return !/[\u0000\r\n\t\s]/.test(remote);
}

/** A commit message: non-empty, bounded, NUL-free (newlines are allowed). */
function isSafeCommitMessage(value) {
  if (typeof value !== 'string') return false;
  if (value.trim() === '') return false;
  if (value.length > MAX_COMMIT_MESSAGE_CHARS) return false;
  return !value.includes('\u0000');
}

/** Default `execFile` resolves `{stdout, stderr}`; accept a bare string too. */
function stdoutOf(result) {
  if (typeof result === 'string') return result;
  if (result !== null && typeof result === 'object') {
    if (typeof result.stdout === 'string') return result.stdout;
    if (Buffer.isBuffer(result.stdout)) return result.stdout.toString('utf8');
  }
  return '';
}

/** A cwd/worktree path: non-blank string without newline/CR/NUL. */
function isSafePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return !/[\u0000\r\n]/.test(value);
}

/** A ref/commit-ish argument: no whitespace/control, no leading `-`, no `..`. */
function isSafeRef(value) {
  if (typeof value !== 'string') return false;
  const ref = value.trim();
  if (ref === '' || ref.length > 512) return false;
  if (ref.startsWith('-')) return false;
  if (/[\u0000\r\n\s]/.test(ref)) return false;
  if (ref === '@' || ref.includes('@{') || ref.includes('..')) return false;
  return true;
}

/** Parse a positive safe integer from a number or numeric string. */
function positiveInteger(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}
