#!/usr/bin/env node
/**
 * Build the Spike D git fixture: a throwaway main repo plus one linked worktree.
 *
 *   bug-workflow/.tmp/spike-repo/   main repo, one commit: hello.txt = "hello"
 *   bug-workflow/.tmp/worktree/     linked worktree on branch `spike-branch`
 *
 * The host route `/bug-workflow/spike/subagent` starts a subagent with
 * `cwd = .tmp/worktree`; the child edits `hello.txt`, then the route reports
 * `git status --porcelain` from the worktree as evidence. Keeping the worktree
 * dirty/clean state deterministic is what makes the spike repeatable:
 *
 *   - a missing/broken fixture is rebuilt from scratch;
 *   - an existing fixture is reset to its committed state (`reset --hard` +
 *     `clean -fd`), so the next run starts clean instead of inheriting the
 *     previous run's `hello p0` edit;
 *   - everything lives under the gitignored `bug-workflow/.tmp/`.
 *
 * Usage:
 *
 *   node bug-workflow/scripts/make-temp-repo.mjs            # build or reset
 *   node bug-workflow/scripts/make-temp-repo.mjs --rebuild  # force rebuild
 *
 * Output is a short summary; exit code 1 on any failure.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TMP_ROOT = resolve(BUNDLE_ROOT, '.tmp');
const REPO_DIR = resolve(TMP_ROOT, 'spike-repo');
const WORKTREE_DIR = resolve(TMP_ROOT, 'worktree');
const BRANCH = 'spike-branch';
const HELLO = 'hello\n';

function git(cwd, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(
      `git ${args.join(' ')} failed in ${cwd}${stderr ? `: ${stderr}` : `: ${error?.message ?? error}`}`,
    );
  }
}

/** Only ever delete paths this script created inside `.tmp/`. */
function assertManaged(target) {
  if (!target.startsWith(`${TMP_ROOT}${sep}`) || target === TMP_ROOT) {
    throw new Error(`refusing to touch unmanaged path: ${target}`);
  }
}

function worktreeRegistered() {
  const listing = git(REPO_DIR, ['worktree', 'list', '--porcelain'], { allowFailure: true });
  if (!listing) return false;
  return listing
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => resolve(line.slice('worktree '.length)) === WORKTREE_DIR);
}

/** Reset the existing fixture to its committed state, or report why it must be rebuilt. */
function resetExisting() {
  if (!existsSync(REPO_DIR)) return { state: 'absent' };
  if (!existsSync(resolve(REPO_DIR, '.git'))) return { state: 'broken', reason: 'spike-repo/.git missing' };
  if (!git(REPO_DIR, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true })) {
    return { state: 'broken', reason: 'spike-repo has no commit' };
  }
  if (!worktreeRegistered()) return { state: 'stale', reason: 'worktree not registered' };
  if (!existsSync(resolve(WORKTREE_DIR, 'hello.txt'))) {
    return { state: 'stale', reason: 'worktree/hello.txt missing' };
  }

  git(WORKTREE_DIR, ['reset', '--hard', 'HEAD']);
  git(WORKTREE_DIR, ['clean', '-fdq']);
  return { state: 'ready' };
}

function rebuild() {
  for (const target of [WORKTREE_DIR, REPO_DIR]) {
    assertManaged(target);
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(TMP_ROOT, { recursive: true });
  mkdirSync(REPO_DIR, { recursive: true });

  git(REPO_DIR, ['init', '-q']);
  git(REPO_DIR, ['config', 'user.name', 'P0 Spike Fixture']);
  git(REPO_DIR, ['config', 'user.email', 'p0-spike@example.invalid']);
  writeFileSync(resolve(REPO_DIR, 'hello.txt'), HELLO);
  git(REPO_DIR, ['add', 'hello.txt']);
  git(REPO_DIR, ['commit', '-q', '-m', 'spike fixture: hello']);
  git(REPO_DIR, ['worktree', 'add', '../worktree', '-b', BRANCH]);
}

function verify() {
  if (!existsSync(WORKTREE_DIR)) throw new Error(`worktree missing: ${WORKTREE_DIR}`);
  if (!worktreeRegistered()) throw new Error(`worktree is not registered in ${REPO_DIR}`);

  const branch = git(WORKTREE_DIR, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== BRANCH) throw new Error(`worktree branch is ${branch}, expected ${BRANCH}`);

  const hello = readFileSync(resolve(WORKTREE_DIR, 'hello.txt'), 'utf8');
  if (hello !== HELLO) {
    throw new Error(`worktree hello.txt is ${JSON.stringify(hello)}, expected ${JSON.stringify(HELLO)}`);
  }

  const status = git(WORKTREE_DIR, ['status', '--porcelain']);
  if (status !== '') throw new Error(`worktree is not clean:\n${status}`);

  return {
    mainRepo: REPO_DIR,
    worktree: WORKTREE_DIR,
    branch,
    head: git(WORKTREE_DIR, ['rev-parse', '--short', 'HEAD']),
    hello: hello.trimEnd(),
    status: 'clean',
  };
}

function display(target) {
  return target.startsWith(`${BUNDLE_ROOT}${sep}`)
    ? `bug-workflow/${target.slice(BUNDLE_ROOT.length + 1)}`
    : target;
}

function main() {
  const force = process.argv.includes('--rebuild');
  let outcome;

  if (force) {
    rebuild();
    outcome = 'rebuilt (--rebuild)';
  } else {
    const existing = resetExisting();
    if (existing.state === 'ready') {
      outcome = 'existing fixture reset to its committed state';
    } else {
      rebuild();
      outcome = `rebuilt (${existing.state}${existing.reason ? `: ${existing.reason}` : ''})`;
    }
  }

  const fixture = verify();
  console.log('Spike D fixture ready');
  console.log(`  outcome:   ${outcome}`);
  console.log(`  main repo: ${display(fixture.mainRepo)}`);
  console.log(`  worktree:  ${display(fixture.worktree)} (branch ${fixture.branch}, head ${fixture.head})`);
  console.log(`  hello.txt: ${JSON.stringify(fixture.hello)}`);
  console.log(`  git status: ${fixture.status}`);
}

try {
  main();
} catch (error) {
  console.error(`make-temp-repo failed: ${error?.message ?? error}`);
  process.exitCode = 1;
}
