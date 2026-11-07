/**
 * Contract tests for the injected git worktree executor (P4 Task 1).
 *
 * Most cases use a throwaway repository under `os.tmpdir()` and real git
 * (`init`, one commit, a `feature-V1` branch) so the argv arrays, worktree
 * bookkeeping and porcelain/diff output are exercised end to end:
 *
 *   - `repoRoot` works from a subdirectory and from `createGit()`'s default
 *     `execFile` (the promisified `node:child_process` path);
 *   - `refExists` is a boolean for local refs/HEAD;
 *   - `worktreeAdd` creates branch + directory, reuses an existing matching
 *     worktree (`created:false`) and reports `worktree-conflict` for a
 *     different branch at the same path;
 *   - `status`/`diffStat`/`diff` reflect a file change made inside the
 *     worktree; `diff` clips at `maxChars` with a static marker;
 *   - `worktreeRemove` refuses a dirty worktree unless forced;
 *   - a fake `execFile` deterministically covers timeout/error normalization
 *     and proves raw child stderr/messages never reach callers and that argv is
 *     passed without a shell.
 *
 * Every temporary directory is removed in the `after` hook; the repository is
 * created only under `os.tmpdir()` and never inside the checkout.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { DIFF_TRUNCATED_MARKER, DEFAULT_GIT_TIMEOUT_MS, createGit } from '../src/host/git.js';

/** Deterministic git for fixture setup only (the module under test is async). */
function gitSync(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

let root;
let repo;
let git;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-bw-git-'));
  repo = join(root, 'repo');
  mkdirSync(repo);

  gitSync(repo, ['init', '-q', '-b', 'main']);
  gitSync(repo, ['config', 'user.name', 'P4 Test']);
  gitSync(repo, ['config', 'user.email', 'p4-test@example.invalid']);
  writeFileSync(join(repo, 'readme.md'), 'hello\n');
  gitSync(repo, ['add', 'readme.md']);
  gitSync(repo, ['commit', '-q', '-m', 'init']);
  gitSync(repo, ['branch', 'feature-V1']);

  git = createGit();
});

after(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

test('repoRoot resolves the toplevel from the repo and a subdirectory', async () => {
  const expected = realpathSync(repo);
  assert.equal(realpathSync(await git.repoRoot(repo)), expected);

  const subdirectory = join(repo, 'src');
  mkdirSync(subdirectory);
  assert.equal(realpathSync(await git.repoRoot(subdirectory)), expected);

  // The default factory path really is `promisify(node:child_process.execFile)`.
  const defaultGit = createGit();
  assert.equal(realpathSync(await defaultGit.repoRoot(subdirectory)), expected);
});

test('refExists reports local refs and HEAD, and false for unknown refs', async () => {
  assert.equal(await git.refExists(repo, 'feature-V1'), true);
  assert.equal(await git.refExists(repo, 'HEAD'), true);
  assert.equal(await git.refExists(repo, 'main'), true);
  assert.equal(await git.refExists(repo, 'feature-does-not-exist'), false);
  assert.equal(await git.refExists(repo, 'refs/remotes/origin/nope'), false);
});

test('worktreeAdd creates a branch + directory and reuses the same worktree', async () => {
  const worktreePath = join(root, 'feat-V1-ly');

  const first = await git.worktreeAdd({
    repo,
    path: worktreePath,
    branch: 'feat-V1-ly',
    base: 'feature-V1',
  });
  assert.deepEqual(first, { created: true });
  assert.equal(existsSync(worktreePath), true);
  assert.equal(gitSync(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feat-V1-ly');
  assert.equal(readFileSync(join(worktreePath, 'readme.md'), 'utf8'), 'hello\n');

  // Idempotent second call: the path already carries the requested branch.
  const second = await git.worktreeAdd({
    repo,
    path: worktreePath,
    branch: 'feat-V1-ly',
    base: 'feature-V1',
  });
  assert.deepEqual(second, { created: false });

  // Same path, different branch: never checked out silently.
  const conflict = await git.worktreeAdd({
    repo,
    path: worktreePath,
    branch: 'feat-V1-other',
    base: 'feature-V1',
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'worktree-conflict');
  assert.equal(conflict.message, '工作树已存在且分支与目标分支不一致');
  assert.equal(conflict.command, 'git worktree add');
  assert.equal(gitSync(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feat-V1-ly');

  // A pre-existing non-empty directory is not a worktree and must not be reused.
  const blockedPath = join(root, 'blocked-path');
  mkdirSync(blockedPath);
  writeFileSync(join(blockedPath, 'keep.txt'), 'not a worktree\n');
  const blocked = await git.worktreeAdd({
    repo,
    path: blockedPath,
    branch: 'feat-V1-blocked',
    base: 'feature-V1',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'git-failed');
  assert.equal(blocked.command, 'git worktree add');
});

test('status, diffStat and diff reflect a change inside the worktree', async () => {
  const worktreePath = join(root, 'feat-V1-ly');
  writeFileSync(join(worktreePath, 'readme.md'), 'hello\nchanged by fix agent\n');
  writeFileSync(join(worktreePath, 'new-file.txt'), 'new\n');

  const status = await git.status(worktreePath);
  assert.ok(status.split('\n').includes(' M readme.md'), status);
  assert.ok(status.split('\n').includes('?? new-file.txt'), status);

  const diffStat = await git.diffStat(worktreePath);
  assert.match(diffStat, /readme\.md/);
  assert.match(diffStat, /1 \+/);

  const patch = await git.diff(worktreePath);
  assert.match(patch, /\+changed by fix agent/);

  const clipped = await git.diff(worktreePath, { maxChars: 20 });
  assert.ok(clipped.endsWith(DIFF_TRUNCATED_MARKER), clipped);
  assert.ok(clipped.length <= 20 + DIFF_TRUNCATED_MARKER.length);
  assert.equal(clipped.slice(0, 20), patch.slice(0, 20));
});

test('worktreeRemove refuses a dirty worktree unless forced', async () => {
  const cleanPath = join(root, 'feat-V1-clean');
  const created = await git.worktreeAdd({
    repo,
    path: cleanPath,
    branch: 'feat-V1-clean',
    base: 'feature-V1',
  });
  assert.deepEqual(created, { created: true });
  assert.equal(await git.worktreeRemove({ repo, path: cleanPath }), undefined);
  assert.equal(existsSync(cleanPath), false);

  const dirtyPath = join(root, 'feat-V1-ly');
  const refused = await git.worktreeRemove({ repo, path: dirtyPath });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'git-failed');
  assert.equal(refused.command, 'git worktree remove');
  assert.equal(existsSync(dirtyPath), true);

  assert.equal(await git.worktreeRemove({ repo, path: dirtyPath, force: true }), undefined);
  assert.equal(existsSync(dirtyPath), false);
  // Removing the worktree keeps the branch for P5 (commit/push later).
  assert.equal(await git.refExists(repo, 'feat-V1-ly'), true);
});

test('execFile timeout is normalized to a static git-timeout failure', async () => {
  const calls = [];
  const timeoutGit = createGit({
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      throw Object.assign(new Error('fatal: secret-token'), {
        code: null,
        killed: true,
        signal: 'SIGTERM',
        stderr: 'secret-token',
      });
    },
  });

  const result = await timeoutGit.status('/tmp/injected');
  assert.deepEqual(result, {
    ok: false,
    code: 'git-timeout',
    message: 'git 命令执行超时',
    command: 'git status --porcelain',
  });
  assert.ok(!JSON.stringify(result).includes('secret-token'));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'git');
  assert.deepEqual(calls[0].args, ['-C', '/tmp/injected', 'status', '--porcelain']);
  assert.equal(calls[0].options.timeout, DEFAULT_GIT_TIMEOUT_MS);
  assert.equal(calls[0].options.encoding, 'utf8');
  assert.equal(calls[0].options.shell, undefined);
});

test('a failing child is normalized without leaking stderr or message', async () => {
  const failingGit = createGit({
    execFile: async () => {
      throw Object.assign(new Error('fatal: secret-token'), {
        code: 128,
        stderr: 'secret-token\n',
      });
    },
  });

  const result = await failingGit.diff('/tmp/injected');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'git-failed');
  assert.equal(result.message, 'git 命令执行失败');
  assert.equal(result.command, 'git diff');
  assert.ok(!JSON.stringify(result).includes('secret-token'));

  // refExists treats a missing ref (non-zero exit) as false, not as an error.
  assert.equal(await failingGit.refExists('/tmp/injected', 'nope'), false);

  // A timeout during refExists must stay visible instead of becoming false.
  const timeoutRef = createGit({
    execFile: async () => {
      throw Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' });
    },
  });
  const timedOut = await timeoutRef.refExists('/tmp/injected', 'feature-V1');
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.code, 'git-timeout');
  assert.equal(timedOut.command, 'git rev-parse --verify');
});

test('invalid cwd/path/ref values are rejected before spawning git', async () => {
  let calls = 0;
  const strictGit = createGit({
    execFile: async () => {
      calls += 1;
      throw new Error('must not be called');
    },
  });

  for (const badPath of [undefined, null, 42, '', '   ', 'bad\npath', 'bad\rpath', 'bad\u0000path']) {
    const result = await strictGit.repoRoot(badPath);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'git-failed');
    assert.equal(result.message, 'git 命令参数不合法');
    assert.equal(result.command, 'git rev-parse --show-toplevel');
  }

  const badWorktree = await strictGit.worktreeAdd({
    repo,
    path: join(root, 'never-created'),
    branch: '-bad-branch',
    base: 'HEAD',
  });
  assert.equal(badWorktree.ok, false);
  assert.equal(badWorktree.code, 'git-failed');

  const badRef = await strictGit.refExists(repo, 'bad ref');
  assert.equal(badRef.ok, false);
  assert.equal(badRef.code, 'git-failed');

  assert.equal(calls, 0);
});
