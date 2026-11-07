/**
 * Contract tests for the injected git worktree executor (P4 Task 1).
 *
 * Every test builds its own throwaway repository under `os.tmpdir()` and runs
 * real git (`init`, one commit, a `feature-V1` branch), so a single-test run
 * (`node --test --test-name-pattern ...`) is self-sufficient and no test
 * depends on mutation order. Fixtures use `git init` + `git branch -M main`
 * (not `git init -b`, which needs git >= 2.28) and local
 * `-c commit.gpgsign=false -c core.autocrlf=false -c user.name/email`, so the
 * host configuration cannot influence the result. Cleanup is registered per
 * test with `t.after`.
 *
 * Coverage:
 *
 *   - `repoRoot` works from a subdirectory and from the default promisified
 *     `execFile`;
 *   - `refExists` returns `{ok:true, exists}` for local refs/HEAD, distinguishes
 *     a missing ref (exit 1) from a real git failure, and keeps timeouts
 *     visible;
 *   - `worktreePath` builds `<repo>/.dsh-worktrees/<code>` only for a safe
 *     ticket code;
 *   - `worktreeAdd` creates a worktree inside the repository, reuses it
 *     (`created:false`), conflicts on a different branch, accepts an existing
 *     empty directory, rejects a non-empty plain directory as `git-failed`
 *     (never `worktree-conflict`), and re-adds a retained branch after
 *     `worktreeRemove` without `-b`;
 *   - `status`/`diffStat`/`diff` reflect a change inside the worktree and
 *     `diff` clips with a static marker;
 *   - `worktreeRemove` refuses a dirty worktree unless forced and keeps the
 *     branch;
 *   - a fake `execFile` deterministically covers timeout, maxBuffer overflow,
 *     error normalization and argv safety (no shell, no leaked stderr).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_GIT_TIMEOUT_MS,
  DIFF_TRUNCATED_MARKER,
  GitError,
  PUSH_TIMEOUT_MS,
  WORKTREE_DIR,
  assertPushableBranch,
  createGit,
  worktreePath,
} from '../src/host/git.js';

/** Local config for every fixture git command (never rely on the host). */
const GIT_CONFIG = Object.freeze([
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.autocrlf=false',
  '-c',
  'user.name=P4 Test',
  '-c',
  'user.email=p4-test@example.invalid',
]);

/** Deterministic git for fixture setup only (the module under test is async). */
function gitSync(cwd, args) {
  return execFileSync('git', [...GIT_CONFIG, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Build an isolated repository: one commit on `main` plus `feature-V1`.
 * The caller registers `cleanup` with `t.after`.
 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bw-git-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);

  gitSync(repo, ['init', '-q']);
  gitSync(repo, ['branch', '-M', 'main']);
  writeFileSync(join(repo, 'readme.md'), 'hello\n');
  gitSync(repo, ['add', 'readme.md']);
  gitSync(repo, ['commit', '-q', '-m', 'init']);
  gitSync(repo, ['branch', 'feature-V1']);

  return {
    root,
    repo,
    git: createGit(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Product path under the repository, using the tested helper. */
function productPath(repo, code) {
  const result = worktreePath({ repo, code });
  assert.equal(result.ok, true);
  return result.path;
}

test('repoRoot resolves the toplevel from the repo and a subdirectory', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);

  const expected = realpathSync(fixture.repo);
  assert.equal(realpathSync(await fixture.git.repoRoot(fixture.repo)), expected);

  const subdirectory = join(fixture.repo, 'src');
  mkdirSync(subdirectory);
  assert.equal(realpathSync(await fixture.git.repoRoot(subdirectory)), expected);

  // The default factory path really is `promisify(node:child_process.execFile)`.
  const defaultGit = createGit();
  assert.equal(realpathSync(await defaultGit.repoRoot(subdirectory)), expected);
});

test('refExists returns {ok:true, exists} and distinguishes failures from misses', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const { git, repo, root } = fixture;

  assert.deepEqual(await git.refExists(repo, 'feature-V1'), { ok: true, exists: true });
  assert.deepEqual(await git.refExists(repo, 'HEAD'), { ok: true, exists: true });
  assert.deepEqual(await git.refExists(repo, 'main'), { ok: true, exists: true });
  assert.deepEqual(await git.refExists(repo, 'feature-does-not-exist'), {
    ok: true,
    exists: false,
  });
  assert.deepEqual(await git.refExists(repo, 'refs/remotes/origin/nope'), {
    ok: true,
    exists: false,
  });

  // A non-repository directory is a git failure, not "the ref does not exist".
  const plain = join(root, 'plain');
  mkdirSync(plain);
  const notRepo = await git.refExists(plain, 'main');
  assert.equal(notRepo.ok, false);
  assert.equal(notRepo.code, 'git-failed');
  assert.equal(notRepo.command, 'git rev-parse --verify');

  const invalid = await git.refExists(repo, 'bad ref');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'git-failed');
  assert.equal(invalid.message, 'git 命令参数不合法');
});

test('worktreeAdd creates <repo>/.dsh-worktrees/<code> and reuses a matching worktree', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const { git, repo } = fixture;

  const worktree = productPath(repo, 'feat-V1-ly');
  assert.equal(worktree, join(repo, WORKTREE_DIR, 'feat-V1-ly'));

  const first = await git.worktreeAdd({
    repo,
    path: worktree,
    branch: 'feat-V1-ly',
    base: 'feature-V1',
  });
  assert.deepEqual(first, { created: true });
  assert.equal(existsSync(worktree), true);
  assert.equal(gitSync(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feat-V1-ly');
  assert.equal(readFileSync(join(worktree, 'readme.md'), 'utf8'), 'hello\n');

  // Idempotent second call: registered worktree, requested branch.
  const second = await git.worktreeAdd({
    repo,
    path: worktree,
    branch: 'feat-V1-ly',
    base: 'feature-V1',
  });
  assert.deepEqual(second, { created: false });

  // Same registered path, different branch: conflict, never checked out silently.
  const conflict = await git.worktreeAdd({
    repo,
    path: worktree,
    branch: 'feat-V1-other',
    base: 'feature-V1',
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'worktree-conflict');
  assert.equal(conflict.message, '工作树已存在且分支与目标分支不一致');
  assert.equal(conflict.command, 'git worktree add');
  assert.equal(gitSync(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feat-V1-ly');
});

test('a plain directory inside the repo is not mistaken for a registered worktree', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const { git, repo } = fixture;

  // Regression: an empty plain directory inside the repo must be created, not
  // reported as an existing worktree (the old HEAD probe saw the repo's branch).
  const empty = join(repo, WORKTREE_DIR, 'EMPTY-1');
  mkdirSync(empty, { recursive: true });
  const created = await git.worktreeAdd({
    repo,
    path: empty,
    branch: 'feat-V1-empty',
    base: 'main',
  });
  assert.deepEqual(created, { created: true });
  assert.equal(gitSync(empty, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feat-V1-empty');

  // Regression: a non-empty plain directory inside the repo must surface the
  // real git refusal (`git-failed`), never `worktree-conflict`.
  const blocked = join(repo, WORKTREE_DIR, 'BLOCKED-1');
  mkdirSync(blocked, { recursive: true });
  writeFileSync(join(blocked, 'keep.txt'), 'not a worktree\n');

  const refused = await git.worktreeAdd({
    repo,
    path: blocked,
    branch: 'feat-V1-blocked',
    base: 'main',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'git-failed');
  assert.equal(refused.message, 'git 命令执行失败');
  assert.equal(refused.command, 'git worktree add');
  assert.equal(existsSync(join(blocked, 'keep.txt')), true);
  // The plain directory itself was never turned into a worktree.
  assert.equal(gitSync(blocked, ['rev-parse', '--is-inside-work-tree']), 'true');
  const listed = gitSync(repo, ['worktree', 'list', '--porcelain']);
  assert.ok(!listed.includes(realpathSync(blocked)));
  assert.ok(listed.includes(realpathSync(empty)));
});

test('an external worktree on the same branch maps to worktree-conflict, not git-failed', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const { git, repo } = fixture;

  const first = productPath(repo, 'feat-V1-shared');
  assert.deepEqual(
    await git.worktreeAdd({ repo, path: first, branch: 'feat-V1-shared', base: 'main' }),
    { created: true },
  );

  // A user manually checked the same personal branch out in another worktree.
  // `git worktree add` refuses with a raw error; the executor must diagnose the
  // real condition (409 worktree-conflict) instead of an opaque git-failed.
  const second = productPath(repo, 'feat-V1-second');
  const result = await git.worktreeAdd({
    repo,
    path: second,
    branch: 'feat-V1-shared',
    base: 'main',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'worktree-conflict');
  assert.equal(result.message, '个人分支已在其它工作树中检出，请先清理该工作树');
  assert.equal(result.command, 'git worktree add');
  assert.equal(existsSync(second), false);
  assert.deepEqual(await git.probeWorktree(repo, second, 'feat-V1-shared'), {
    ok: true,
    state: 'absent',
  });
});

test('worktreeAdd re-adds a retained branch after worktreeRemove', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const { git, repo } = fixture;

  const worktree = productPath(repo, 'feat-V1-readd');
  const input = {
    repo,
    path: worktree,
    branch: 'feat-V1-readd',
    base: 'main',
  };

  assert.deepEqual(await git.worktreeAdd(input), { created: true });
  assert.equal(await git.worktreeRemove({ repo, path: worktree }), undefined);
  assert.equal(existsSync(worktree), false);
  // worktreeRemove deliberately keeps the branch for P5.
  assert.deepEqual(await git.refExists(repo, 'feat-V1-readd'), { ok: true, exists: true });

  // The branch exists now, so the add must omit `-b` and check it out.
  assert.deepEqual(await git.worktreeAdd(input), { created: true });
  assert.equal(gitSync(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feat-V1-readd');
  assert.equal(readFileSync(join(worktree, 'readme.md'), 'utf8'), 'hello\n');
});

test('status, diffStat and diff reflect a change inside the worktree', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const { git, repo } = fixture;

  const worktree = productPath(repo, 'feat-V1-diff');
  assert.deepEqual(
    await git.worktreeAdd({ repo, path: worktree, branch: 'feat-V1-diff', base: 'main' }),
    { created: true },
  );

  writeFileSync(join(worktree, 'readme.md'), 'hello\nchanged by fix agent\n');
  writeFileSync(join(worktree, 'new-file.txt'), 'new\n');

  const status = await git.status(worktree);
  assert.ok(status.split('\n').includes(' M readme.md'), status);
  assert.ok(status.split('\n').includes('?? new-file.txt'), status);

  const diffStat = await git.diffStat(worktree);
  assert.match(diffStat, /readme\.md/);
  assert.match(diffStat, /1 \+/);

  const patch = await git.diff(worktree);
  assert.match(patch, /\+changed by fix agent/);

  const clipped = await git.diff(worktree, { maxChars: 20 });
  assert.ok(clipped.endsWith(DIFF_TRUNCATED_MARKER), clipped);
  assert.ok(clipped.length <= 20 + DIFF_TRUNCATED_MARKER.length);
  assert.equal(clipped.slice(0, 20), patch.slice(0, 20));
});

test('worktreeRemove refuses a dirty worktree unless forced and keeps the branch', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const { git, repo } = fixture;

  const clean = productPath(repo, 'feat-V1-clean');
  assert.deepEqual(
    await git.worktreeAdd({ repo, path: clean, branch: 'feat-V1-clean', base: 'main' }),
    { created: true },
  );
  assert.equal(await git.worktreeRemove({ repo, path: clean }), undefined);
  assert.equal(existsSync(clean), false);

  const dirty = productPath(repo, 'feat-V1-dirty');
  assert.deepEqual(
    await git.worktreeAdd({ repo, path: dirty, branch: 'feat-V1-dirty', base: 'main' }),
    { created: true },
  );
  writeFileSync(join(dirty, 'untracked.txt'), 'dirty\n');

  const refused = await git.worktreeRemove({ repo, path: dirty });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'git-failed');
  assert.equal(refused.command, 'git worktree remove');
  assert.equal(existsSync(dirty), true);

  assert.equal(await git.worktreeRemove({ repo, path: dirty, force: true }), undefined);
  assert.equal(existsSync(dirty), false);
  assert.deepEqual(await git.refExists(repo, 'feat-V1-dirty'), { ok: true, exists: true });
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

test('a timeout during the registered-worktree probe stays visible', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);

  // The path exists, so worktreeAdd lists worktrees before attempting the add.
  const worktree = join(fixture.repo, WORKTREE_DIR, 'TIMEOUT-1');
  mkdirSync(worktree, { recursive: true });

  const timeoutGit = createGit({
    execFile: async () => {
      throw Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' });
    },
  });
  const result = await timeoutGit.worktreeAdd({
    repo: fixture.repo,
    path: worktree,
    branch: 'feat-V1-timeout',
    base: 'main',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'git-timeout');
  assert.equal(result.command, 'git worktree add');
});

test('a maxBuffer overflow is git-failed, not git-timeout', async () => {
  const overflowGit = createGit({
    execFile: async () => {
      throw Object.assign(new Error('stdout maxBuffer length exceeded'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        killed: true,
        signal: 'SIGTERM',
      });
    },
  });

  const diff = await overflowGit.diff('/tmp/injected');
  assert.equal(diff.ok, false);
  assert.equal(diff.code, 'git-failed');
  assert.equal(diff.message, 'git 命令执行失败');
  assert.equal(diff.command, 'git diff');

  // refExists must not turn an overflow into `exists:false` either.
  const ref = await overflowGit.refExists('/tmp/injected', 'main');
  assert.equal(ref.ok, false);
  assert.equal(ref.code, 'git-failed');
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

  // A general git failure (exit 128) is not a boolean "missing ref".
  const repoError = await failingGit.refExists('/tmp/injected', 'nope');
  assert.equal(repoError.ok, false);
  assert.equal(repoError.code, 'git-failed');

  // Exit code 1 from `rev-parse --verify --quiet` is the documented miss.
  const missingGit = createGit({
    execFile: async () => {
      throw Object.assign(new Error('missing'), { code: 1, signal: null });
    },
  });
  assert.deepEqual(await missingGit.refExists('/tmp/injected', 'nope'), {
    ok: true,
    exists: false,
  });

  const existingGit = createGit({ execFile: async () => ({ stdout: 'abc123\n', stderr: '' }) });
  assert.deepEqual(await existingGit.refExists('/tmp/injected', 'main'), {
    ok: true,
    exists: true,
  });

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

test('invalid cwd/path/ref values are rejected before spawning git', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);

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
    repo: fixture.repo,
    path: join(fixture.root, 'never-created'),
    branch: '-bad-branch',
    base: 'HEAD',
  });
  assert.equal(badWorktree.ok, false);
  assert.equal(badWorktree.code, 'git-failed');

  const badRef = await strictGit.refExists(fixture.repo, 'bad ref');
  assert.equal(badRef.ok, false);
  assert.equal(badRef.code, 'git-failed');

  assert.equal(calls, 0);
});

test('worktreePath only accepts a safe ticket code', () => {
  const good = worktreePath({ repo: '/tmp/repo', code: 'YGFNXDJRFWDJSYJJYY-648' });
  assert.deepEqual(good, {
    ok: true,
    path: join('/tmp/repo', WORKTREE_DIR, 'YGFNXDJRFWDJSYJJYY-648'),
  });

  const maxLength = 'a'.repeat(120);
  assert.equal(worktreePath({ repo: '/tmp/repo', code: maxLength }).ok, true);

  // The git object exposes the same helper for Task 2.
  const git = createGit({
    execFile: async () => {
      throw new Error('must not be called');
    },
  });
  assert.deepEqual(git.worktreePath({ repo: '/tmp/repo', code: 'A_1.2-3' }), {
    ok: true,
    path: join('/tmp/repo', WORKTREE_DIR, 'A_1.2-3'),
  });

  const invalidCodes = [
    undefined,
    null,
    42,
    '',
    '   ',
    '.',
    '..',
    '../escape',
    'a/b',
    'a\\b',
    'a b',
    'a\nb',
    'a\u0000b',
    '张三',
    'a'.repeat(121),
  ];

  for (const code of invalidCodes) {
    const result = worktreePath({ repo: '/tmp/repo', code });
    assert.equal(result.ok, false, `expected unsafe code: ${JSON.stringify(code)}`);
    assert.equal(result.code, 'invalid-worktree-path');
    assert.equal(result.message, '工单号无法生成安全的工作树路径');
    assert.equal(result.command, 'git worktree add');
  }

  for (const input of [undefined, null, [], 'x']) {
    const result = worktreePath(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid-worktree-path');
  }

  for (const repo of [undefined, null, '', '   ', 'bad\nrepo']) {
    const result = worktreePath({ repo, code: 'OK-1' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid-worktree-path');
  }
});

// ---------------------------------------------------------------------------
// P5: public worktree inspection, push safety, commit/push
// ---------------------------------------------------------------------------

/** Build a local bare repository to act as `origin`; no network is used. */
function makeBareOrigin(root) {
  const origin = join(root, 'origin.git');
  mkdirSync(origin);
  execFileSync('git', ['init', '--bare', '-q', origin], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return origin;
}

test('listWorktrees/probeWorktree are public and map registered worktrees', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const { git, repo } = fixture;

  const worktree = productPath(repo, 'feat-V1-probe');
  assert.deepEqual(
    await git.worktreeAdd({ repo, path: worktree, branch: 'feat-V1-probe', base: 'main' }),
    { created: true },
  );

  const listed = await git.listWorktrees(repo);
  assert.equal(listed.ok, true);
  const paths = listed.entries.map((entry) => realpathSync(entry.path));
  assert.ok(paths.includes(realpathSync(repo)), 'main worktree is listed');
  assert.ok(paths.includes(realpathSync(worktree)), 'linked worktree is listed');
  const entry = listed.entries.find((item) => realpathSync(item.path) === realpathSync(worktree));
  assert.equal(entry.branch, 'refs/heads/feat-V1-probe');

  assert.deepEqual(await git.probeWorktree(repo, worktree, 'feat-V1-probe'), {
    ok: true,
    state: 'same',
  });
  assert.deepEqual(await git.probeWorktree(repo, worktree, 'other-branch'), {
    ok: true,
    state: 'different',
  });
  assert.deepEqual(
    await git.probeWorktree(repo, join(repo, WORKTREE_DIR, 'MISSING-1'), 'feat-V1-probe'),
    { ok: true, state: 'absent' },
  );

  const plain = join(repo, WORKTREE_DIR, 'PLAIN-1');
  mkdirSync(plain, { recursive: true });
  assert.deepEqual(await git.probeWorktree(repo, plain, 'feat-V1-probe'), {
    ok: true,
    state: 'unregistered',
  });

  // A probe on a non-repository is a structured git failure, not "absent".
  const notRepo = await git.listWorktrees(join(fixture.root, 'nope'));
  assert.equal(notRepo.ok, false);
  assert.equal(notRepo.code, 'git-failed');
  assert.equal(notRepo.command, 'git worktree list --porcelain');
});

test('assertPushableBranch rejects every protected family and accepts personal branches', () => {
  const protectedNames = [
    'main',
    'MAIN',
    'dev',
    'Dev',
    'master',
    'develop',
    'feature-V1',
    'Feature-X',
    'feature/x',
    'hotfix-1',
    'release-2',
    'refs/heads/main',
    'refs/heads/feature-V1',
    'refs/heads/Release-2',
  ];
  for (const name of protectedNames) {
    assert.throws(
      () => assertPushableBranch(name),
      (error) => error instanceof GitError && error.code === 'protected-branch',
      `expected protected branch rejection for ${name}`,
    );
  }

  const invalidNames = [
    '',
    '   ',
    undefined,
    null,
    42,
    '-x',
    'bad ref',
    'a..b',
    'a.lock',
    'refs/heads/',
    // Only branch refs may be pushed; a tag/remote ref would smuggle a
    // non-branch refspec into `git push`.
    'refs/tags/v1.0.0',
    'refs/remotes/origin/main',
  ];
  for (const name of invalidNames) {
    assert.throws(
      () => assertPushableBranch(name),
      (error) => error instanceof GitError && error.code === 'invalid-branch',
      `expected invalid branch rejection for ${JSON.stringify(name)}`,
    );
  }

  // Personal branches and other non-protected names are allowed; the refs/heads/
  // form is normalized so callers always push the plain branch name.
  assert.equal(assertPushableBranch('feat-V1.6.1-ly'), 'feat-V1.6.1-ly');
  assert.equal(assertPushableBranch('hot-V1-ly'), 'hot-V1-ly');
  assert.equal(assertPushableBranch('feat-custom-user'), 'feat-custom-user');
  assert.equal(assertPushableBranch('bugfix-123'), 'bugfix-123');
  assert.equal(assertPushableBranch('refs/heads/feat-V1-ly'), 'feat-V1-ly');
});

test('revParse resolves a full sha and reports missing/invalid refs statically', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const { git, repo } = fixture;

  const head = await git.revParse(repo, 'HEAD');
  assert.equal(typeof head, 'string');
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.equal(head, gitSync(repo, ['rev-parse', 'HEAD']));

  const missing = await git.revParse(repo, 'does-not-exist');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'git-failed');
  assert.equal(missing.command, 'git rev-parse');

  const invalid = await git.revParse(repo, 'bad ref');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'git-failed');
  assert.equal(invalid.message, 'git 命令参数不合法');
  assert.equal(invalid.command, 'git rev-parse');
});

test('commitAll creates one commit with the exact message and refuses an empty commit', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const { git, repo } = fixture;

  const worktree = productPath(repo, 'feat-V1-commit');
  assert.deepEqual(
    await git.worktreeAdd({ repo, path: worktree, branch: 'feat-V1-commit', base: 'main' }),
    { created: true },
  );
  const before = gitSync(worktree, ['rev-list', '--count', 'HEAD']);

  writeFileSync(join(worktree, 'readme.md'), 'hello\nchanged\n');
  writeFileSync(join(worktree, 'new-file.txt'), 'new\n');
  // Shell metacharacters in the message must stay literal: an argv array is
  // used, never a shell string.
  const message = 'fix: 【jira单号】：BUG-1，【开发内容】：修复登录 $(touch PWNED) ; echo hi';
  const committed = await git.commitAll({ root: worktree, message });

  assert.equal(committed.ok, true);
  assert.match(committed.sha, /^[0-9a-f]{40}$/);
  assert.equal(gitSync(worktree, ['log', '-1', '--format=%B']), message);
  assert.equal(gitSync(worktree, ['status', '--porcelain']), '');
  assert.equal(existsSync(join(worktree, 'PWNED')), false);
  assert.equal(gitSync(worktree, ['rev-list', '--count', 'HEAD']), String(Number(before) + 1));

  // No changes -> sha null, no empty commit.
  const again = await git.commitAll({ root: worktree, message: 'fix: empty' });
  assert.deepEqual(again, { ok: true, sha: null });
  assert.equal(gitSync(worktree, ['rev-list', '--count', 'HEAD']), String(Number(before) + 1));
});

test('commitAll passes the message as one argv element and never spawns a shell', async () => {
  const calls = [];
  const fakeGit = createGit({
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      if (args.includes('add')) return { stdout: '', stderr: '' };
      if (args.includes('--cached')) {
        throw Object.assign(new Error('changes'), { code: 1, signal: null });
      }
      if (args.includes('commit')) return { stdout: '', stderr: '' };
      if (args.includes('rev-parse')) return { stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    },
  });

  const message = 'fix: 【jira单号】：BUG-1，【开发内容】：$(touch pwned); rm -rf /';
  const result = await fakeGit.commitAll({ root: '/tmp/fake-worktree', message });
  assert.deepEqual(result, { ok: true, sha: 'a'.repeat(40) });

  const commitCall = calls.find((call) => call.args.includes('commit'));
  assert.deepEqual(commitCall.args, ['-C', '/tmp/fake-worktree', 'commit', '-m', message]);
  assert.equal(commitCall.options.shell, undefined);

  // Invalid messages never reach git.
  const noCalls = [];
  const strictGit = createGit({
    execFile: async (file, args) => {
      noCalls.push(args);
      return { stdout: '' };
    },
  });
  for (const bad of ['', '   ', null, 42, 'a\u0000b']) {
    const rejected = await strictGit.commitAll({ root: '/tmp/fake-worktree', message: bad });
    assert.equal(rejected.ok, false, String(bad));
    assert.equal(rejected.code, 'git-failed');
    assert.equal(rejected.message, '提交信息不合法');
  }
  assert.equal(noCalls.length, 0);
});

test('pushBranch pushes to a local bare origin, sets upstream and never forces', async (t) => {
  const fixture = makeFixture();
  t.after(fixture.cleanup);
  const { git, repo, root } = fixture;
  const origin = makeBareOrigin(root);
  gitSync(repo, ['remote', 'add', 'origin', origin]);

  const worktree = productPath(repo, 'feat-V1-push');
  assert.deepEqual(
    await git.worktreeAdd({ repo, path: worktree, branch: 'feat-V1-push', base: 'main' }),
    { created: true },
  );
  writeFileSync(join(worktree, 'readme.md'), 'hello\npush me\n');
  const committed = await git.commitAll({ root: worktree, message: 'fix: 【jira单号】：BUG-1' });
  assert.equal(committed.ok, true);

  const pushed = await git.pushBranch({ root: worktree, remote: 'origin', branch: 'feat-V1-push' });
  assert.deepEqual(pushed, { ok: true, branch: 'feat-V1-push', remote: 'origin' });
  assert.equal(
    gitSync(worktree, ['rev-parse', '--abbrev-ref', '@{upstream}']),
    'origin/feat-V1-push',
  );
  assert.equal(
    execFileSync('git', ['--git-dir', origin, 'rev-parse', '--verify', 'refs/heads/feat-V1-push'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim(),
    committed.sha,
  );

  // Protected branches are rejected before git runs; nothing is spawned.
  const calls = [];
  const fakeGit = createGit({
    execFile: async (file, args, options) => {
      calls.push({ args, options });
      return { stdout: '' };
    },
  });
  for (const branch of ['main', 'refs/heads/main', 'feature-V1', 'hotfix-1', 'release-1']) {
    const rejected = await fakeGit.pushBranch({ root: '/tmp/fake-worktree', branch });
    assert.equal(rejected.ok, false, branch);
    assert.equal(rejected.code, 'protected-branch', branch);
    assert.equal(rejected.command, 'git push -u', branch);
  }
  assert.equal(calls.length, 0);

  // Exact argv + 60 s budget for a pushable branch, and no force flag.
  const allowed = await fakeGit.pushBranch({
    root: '/tmp/fake-worktree',
    remote: 'origin',
    branch: 'feat-V1-ly',
  });
  assert.deepEqual(allowed, { ok: true, branch: 'feat-V1-ly', remote: 'origin' });
  assert.deepEqual(calls[0].args, [
    '-C',
    '/tmp/fake-worktree',
    'push',
    '-u',
    'origin',
    'feat-V1-ly',
  ]);
  assert.equal(calls[0].options.timeout, PUSH_TIMEOUT_MS);
  assert.equal(calls[0].options.shell, undefined);
  assert.ok(!calls[0].args.some((arg) => arg.includes('force')));

  // A failed push is a static git failure with no child output leaked.
  const failingGit = createGit({
    execFile: async () => {
      throw Object.assign(new Error('fatal: secret-remote-token'), {
        code: 128,
        stderr: 'secret-remote-token\n',
      });
    },
  });
  const failed = await failingGit.pushBranch({
    root: '/tmp/fake-worktree',
    branch: 'feat-V1-ly',
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'git-failed');
  assert.equal(failed.command, 'git push -u');
  assert.ok(!JSON.stringify(failed).includes('secret-remote-token'));
});
