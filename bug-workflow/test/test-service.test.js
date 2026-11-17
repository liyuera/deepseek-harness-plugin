/**
 * Unit tests for the P7 test-step service (`src/host/test-service.js`):
 * commit the worktree -> merge into the dev branch -> revert / pass+cleanup.
 *
 * A fake git executor stands in for the repository; the real store + state
 * machine run over an in-memory fake domain, so the `mark_test_passed`
 * transition and the meta merge record are the real implementations.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createStore } from '../src/host/store.js';
import { initialTicket } from '../src/host/state-machine.js';
import { DEV_MERGE_META_PREFIX, readMergeRecord } from '../src/host/dev-branch.js';
import { createTestService } from '../src/host/test-service.js';

const CODE = 'BUG-1';
const CWD = '/tmp/bug-workflow-repo';
const WORKTREE = `${CWD}/.dsh-worktrees/${CODE}`;
const DEV = 'feat-V1.6.1-ly';
const SCRATCH = 'feat-V1.6.1-ly-1';
const DEV_BEFORE = 'a'.repeat(40);
const DEV_AFTER = 'b'.repeat(40);
const STORE_TIME = '2026-11-09T00:00:01.000Z';

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createFakeDomain() {
  const tables = new Map();
  return {
    name: 'bug_workflow',
    raw: tables,
    table(name) {
      let records = tables.get(name);
      if (records === undefined) {
        records = new Map();
        tables.set(name, records);
      }
      return {
        get: (key) => cloneJson(records.get(key)),
        put: async (key, value) => {
          records.set(key, cloneJson(value));
        },
        delete: async (key) => records.delete(key),
        entries: () => {
          const pairs = [];
          for (const [key, value] of records) pairs.push([key, cloneJson(value)]);
          return pairs[Symbol.iterator]();
        },
        keys: () => records.keys(),
        get size() {
          return records.size;
        },
        update: async (key, fn) => {
          const next = fn(cloneJson(records.get(key)));
          records.set(key, cloneJson(next));
          return cloneJson(next);
        },
      };
    },
    close: async () => {},
  };
}

/** Fake git executor with the narrow surface test-service uses. */
function createFakeGit(options = {}) {
  const calls = { commitAll: [], mergeBranch: [], resetHard: [], worktreeRemove: [], deleteBranch: [], checkoutBranch: [] };
  const state = {
    branch: options.branch ?? DEV,
    head: options.head ?? DEV_BEFORE,
    status: options.status ?? '',
  };
  return {
    calls,
    state,
    async repoRoot() {
      return options.repo ?? CWD;
    },
    async status() {
      return typeof state.status === 'function' ? state.status() : state.status;
    },
    async currentBranch() {
      return state.branch;
    },
    async checkoutBranch(input) {
      calls.checkoutBranch.push(input);
      state.branch = input.branch;
      return undefined;
    },
    async refExists(_repo, ref) {
      return { ok: true, exists: (options.refs ?? {})[ref] === true || ref === DEV };
    },
    async revParse(_repo, ref) {
      if (ref === 'HEAD') return state.head;
      if (ref === DEV) return state.head;
      if (ref === DEV_AFTER) return DEV_AFTER;
      return options.revParse?.[ref] ?? DEV_BEFORE;
    },
    async mergeBranch(input) {
      calls.mergeBranch.push(input);
      if (options.mergeResult === 'conflict') return { ok: false, code: 'git-failed', message: 'merge conflict', command: 'git merge' };
      state.head = DEV_AFTER;
      return undefined;
    },
    async resetHard(input) {
      calls.resetHard.push(input);
      state.head = input.sha;
      return undefined;
    },
    async log() {
      return options.ahead ?? [];
    },
    async commitAll(input) {
      calls.commitAll.push(input);
      if (options.commitResult !== undefined) return options.commitResult;
      return { ok: true, sha: 'c'.repeat(40) };
    },
    async probeWorktree() {
      return { ok: true, state: options.probe ?? 'same' };
    },
    async worktreeRemove(input) {
      calls.worktreeRemove.push(input);
      return undefined;
    },
    async deleteBranch(_repo, branch) {
      calls.deleteBranch.push(branch);
      return undefined;
    },
  };
}

async function seedFixDone(domain, overrides = {}) {
  const ticket = {
    ...initialTicket({ code: CODE, title: 't', version: 'V1.6.1' }, STORE_TIME),
    workflow: 'fix_done',
    branch: {
      name: SCRATCH,
      devBranch: DEV,
      target: 'feature-V1.6.1',
      baseSource: 'origin',
      worktree: WORKTREE,
      createdAt: STORE_TIME,
    },
    ...overrides,
  };
  await domain.table('tickets').put(CODE, ticket);
  return ticket;
}

function setup(options = {}) {
  const domain = createFakeDomain();
  const store = createStore(domain, () => STORE_TIME);
  const git = createFakeGit(options.git);
  const service = createTestService({ store, git, clock: () => STORE_TIME });
  return { domain, store, git, service };
}

test('start() commits the worktree, merges it into the dev branch and records it', async () => {
  const { domain, store, git, service } = setup();
  await seedFixDone(domain);

  const result = await service.start('session-1', CWD, CODE);
  assert.equal(result.ok, true);
  assert.equal(result.merged.devBranch, DEV);
  assert.equal(result.merged.devBefore, DEV_BEFORE);
  assert.equal(result.merged.devAfter, DEV_AFTER);

  assert.equal(git.calls.commitAll.length, 1);
  assert.equal(git.calls.commitAll[0].root, WORKTREE);
  assert.match(git.calls.commitAll[0].message, /【jira单号】：BUG-1/);
  assert.deepEqual(git.calls.mergeBranch[0], { repo: CWD, branch: SCRATCH });

  const record = readMergeRecord(store, CODE);
  assert.equal(record.devBranch, DEV);
  assert.equal(record.scratchBranch, SCRATCH);
  assert.equal(record.worktree, WORKTREE);
  assert.equal(store.get(CODE).workflow, 'fix_done');
});

test('start() refuses to merge over a dirty dev branch', async () => {
  const { domain, git, service } = setup({ git: { status: ' M src/a.js\n' } });
  await seedFixDone(domain);

  const result = await service.start('session-1', CWD, CODE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'dev-dirty');
  assert.equal(git.calls.mergeBranch.length, 0);
  assert.equal(git.calls.commitAll.length, 0);
});

test('start() refuses a dev branch with unrelated commits', async () => {
  const { domain, git, service } = setup({
    git: { ahead: ['abc123 unrelated work'], refs: { 'origin/feature-V1.6.1': true } },
  });
  await seedFixDone(domain);

  const result = await service.start('session-1', CWD, CODE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'dev-ahead');
  assert.deepEqual(result.ahead, ['abc123 unrelated work']);
  assert.equal(git.calls.mergeBranch.length, 0);
});

test('start() requires the fix_done workflow', async () => {
  const { domain, service } = setup();
  await seedFixDone(domain, { workflow: 'fixing' });

  const result = await service.start('session-1', CWD, CODE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-fix-done');
});

test('revert() resets the dev branch only while it still points at the merge result', async () => {
  const { domain, store, git, service } = setup();
  await seedFixDone(domain);
  await service.start('session-1', CWD, CODE);
  assert.equal(readMergeRecord(store, CODE) !== null, true);

  const reverted = await service.revert('session-1', CWD, CODE);
  assert.equal(reverted.ok, true);
  assert.deepEqual(git.calls.resetHard[0], { repo: CWD, sha: DEV_BEFORE });
  assert.equal(readMergeRecord(store, CODE), null);

  // A second revert has nothing to undo.
  assert.equal((await service.revert('session-1', CWD, CODE)).code, 'test-not-merged');
});

test('revert() refuses when the dev branch moved after the merge', async () => {
  const { domain, git, service } = setup();
  await seedFixDone(domain);
  await service.start('session-1', CWD, CODE);
  git.state.head = 'd'.repeat(40);

  const result = await service.revert('session-1', CWD, CODE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'dev-moved');
  assert.equal(git.calls.resetHard.length, 0);
});

test('pass() cleans the worktree and archives fix_done -> done', async () => {
  const { domain, store, git, service } = setup();
  await seedFixDone(domain);
  await service.start('session-1', CWD, CODE);

  const result = await service.pass('session-1', CWD, CODE);
  assert.equal(result.ok, true);
  assert.equal(result.ticket.workflow, 'done');
  assert.equal(store.get(CODE).workflow, 'done');
  assert.deepEqual(git.calls.deleteBranch, [SCRATCH]);
  assert.equal(git.calls.worktreeRemove.length, 1);
  assert.equal(git.calls.worktreeRemove[0].path, WORKTREE);
  assert.equal(readMergeRecord(store, CODE), null);
  // The merge record meta is cleared, not left behind for delivery.
  assert.equal(store.getMeta(DEV_MERGE_META_PREFIX + CODE), null);
});

test('pass() requires the merge step first', async () => {
  const { domain, service } = setup();
  await seedFixDone(domain);

  const result = await service.pass('session-1', CWD, CODE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'test-not-merged');
});

test('pass() refuses when the dev branch moved during the test', async () => {
  const { domain, git, service } = setup();
  await seedFixDone(domain);
  await service.start('session-1', CWD, CODE);
  git.state.head = 'e'.repeat(40);

  const result = await service.pass('session-1', CWD, CODE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'dev-moved');
  assert.equal(git.calls.deleteBranch.length, 0);
});

test('status() reports the merged tickets for the snapshot', async () => {
  const { domain, service } = setup();
  await seedFixDone(domain);
  assert.deepEqual(service.status(), { merged: {} });

  await service.start('session-1', CWD, CODE);
  const status = service.status();
  assert.equal(status.merged[CODE].devBranch, DEV);
});
