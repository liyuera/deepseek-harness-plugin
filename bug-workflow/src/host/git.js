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
 *     refExists(repo, ref)                  -> Promise<boolean>,
 *     worktreeAdd({repo,path,branch,base})  -> Promise<{created:boolean}>,
 *     status(root)                          -> Promise<string>,   // porcelain
 *     diffStat(root)                        -> Promise<string>,
 *     diff(root, {maxChars?})               -> Promise<string>,
 *     worktreeRemove({repo,path,force?})    -> Promise<void>,
 *   }
 *
 * Success values are the raw values shown above (string/boolean/undefined);
 * any expected failure resolves to a STATIC structured object instead of
 * throwing:
 *
 *   { ok:false, code:'git-failed'|'git-timeout'|'worktree-conflict',
 *     message:<static Chinese>, command:<static command label> }
 *
 * `refExists` keeps a boolean success contract: a non-zero `rev-parse --verify`
 * exit (the normal "ref missing" case) is `false`, while a timeout is still a
 * structured `git-timeout` failure so a hung git is never mistaken for "no
 * ref".
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
 * The only imports are `node:child_process` (default execFile) and
 * `node:util` (promisify); the module uses git itself instead of `node:fs` so
 * the test/host seam stays one injected dependency.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Default per-command timeout (P4 global constraint). */
export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/** Default diff clip length, matching the plan's `maxChars = 20000`. */
export const DIFF_MAX_CHARS = 20_000;

/** Hard upper bound for a `diff()` caller-provided limit. */
const DIFF_MAX_CHARS_CAP = 200_000;

/** Child stdout/stderr buffer bound. */
const MAX_BUFFER = 10 * 1024 * 1024;

/** Static marker appended when a diff is clipped. */
export const DIFF_TRUNCATED_MARKER = '\n…（diff 已截断）';

const MESSAGE = Object.freeze({
  failed: 'git 命令执行失败',
  timeout: 'git 命令执行超时',
  conflict: '工作树已存在且分支与目标分支不一致',
  invalid: 'git 命令参数不合法',
});

/** Static command labels carried by failures (never include argv/paths). */
const COMMAND = Object.freeze({
  repoRoot: 'git rev-parse --show-toplevel',
  refExists: 'git rev-parse --verify',
  branchAt: 'git rev-parse --abbrev-ref',
  worktreeAdd: 'git worktree add',
  status: 'git status --porcelain',
  diffStat: 'git diff --stat',
  diff: 'git diff',
  worktreeRemove: 'git worktree remove',
});

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
   * @param {{command: string}} labels static failure label
   * @returns {Promise<{ok: true, stdout: string} | {ok: false, code: string, message: string, command: string}>}
   */
  async function run(dir, args, { command }) {
    if (!isSafePath(dir)) return failure('git-failed', MESSAGE.invalid, command);

    let result;
    try {
      result = await execFile('git', ['-C', dir, ...args], {
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
        windowsHide: true,
      });
    } catch (error) {
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
   * @param {unknown} repo
   * @param {unknown} ref
   * @returns {Promise<boolean | {ok: false, code: string, message: string, command: string}>}
   */
  async function refExists(repo, ref) {
    if (!isSafePath(repo) || !isSafeRef(ref)) {
      return failure('git-failed', MESSAGE.invalid, COMMAND.refExists);
    }

    const result = await run(repo, ['rev-parse', '--verify', '--quiet', ref], {
      command: COMMAND.refExists,
    });
    if (result.ok) return true;
    if (result.code === 'git-timeout') return result;
    return false;
  }

  /** Branch name at an existing directory, used to decide reuse vs conflict. */
  async function branchAt(path) {
    const result = await run(path, ['rev-parse', '--abbrev-ref', 'HEAD'], {
      command: COMMAND.branchAt,
    });
    if (!result.ok) return result;
    return { ok: true, branch: result.stdout.trim() };
  }

  /**
   * Create a worktree on a new branch, or reuse one already at `path`.
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

    // Probe the target path. A missing/non-repo path simply means "no existing
    // worktree"; a timeout must not be mistaken for that.
    const existing = await branchAt(path);
    if (existing.ok === false && existing.code === 'git-timeout') {
      return failure('git-timeout', MESSAGE.timeout, COMMAND.worktreeAdd);
    }
    if (existing.ok === true) {
      if (existing.branch === branch) return { created: false };
      return failure('worktree-conflict', MESSAGE.conflict, COMMAND.worktreeAdd);
    }

    const added = await run(repo, ['worktree', 'add', '-b', branch, '--', path, base], {
      command: COMMAND.worktreeAdd,
    });
    if (added.ok) return { created: true };

    // A concurrent caller may have won the race between probe and add. Reuse a
    // matching worktree, report a mismatch as a conflict, otherwise surface the
    // original static failure (e.g. an existing non-worktree directory).
    const raced = await branchAt(path);
    if (raced.ok === false && raced.code === 'git-timeout') {
      return failure('git-timeout', MESSAGE.timeout, COMMAND.worktreeAdd);
    }
    if (raced.ok === true) {
      if (raced.branch === branch) return { created: false };
      return failure('worktree-conflict', MESSAGE.conflict, COMMAND.worktreeAdd);
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
   * marker. The default is 20 000 chars; the cap is 200 000.
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

  return { repoRoot, refExists, worktreeAdd, status, diffStat, diff, worktreeRemove };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failure(code, message, command) {
  return { ok: false, code, message, command };
}

/**
 * Map a rejected `execFile` to a static failure. The raw error is inspected
 * only for the timeout flags; its `message`/`stderr` are deliberately dropped.
 */
function normalizeFailure(error, command) {
  const timedOut = error !== null
    && typeof error === 'object'
    && (
      error.killed === true
      || error.signal === 'SIGTERM'
      || error.code === 'ETIMEDOUT'
      || error.code === 'ABORT_ERR'
    );

  return timedOut
    ? failure('git-timeout', MESSAGE.timeout, command)
    : failure('git-failed', MESSAGE.failed, command);
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
