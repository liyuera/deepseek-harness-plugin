/**
 * Unit tests for the P4 fix orchestration service (`src/host/fix-service.js`).
 *
 * The service is pure orchestration over `{store, runner, git, getSettings,
 * clock}`: these tests use the real `createStore()` + state machine over an
 * in-memory fake storage domain, a fake git executor (no real repository) and a
 * fake fix runner that stands in for the subagent delegation seam. No Cordis
 * fiber, zod schema or storage backend is involved.
 *
 * Coverage maps to the P4 Task 2 brief: branch derivation + origin/target/HEAD
 * base resolution, worktree creation/persistence, success -> fixes entry +
 * fix_done, failure -> blocked + static meta, cancelled -> no terminal write,
 * blocked(fixing) restart + availability, orphan fixing restart, duplicate
 * single-flight, late results, and dispose drain. The review-fix block at the
 * end covers I1 (restart ordering/rollback), I3 (zero-change guard), I4
 * (per-repo lock + branch-in-use), M1 (cancel during collection), M2 (diff
 * cap) and M3 (non-stale save-failure copy).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FIX_BUSY_MESSAGE,
  FIX_DIFF_MAX_CHARS,
  FIX_ERROR_META_PREFIX,
  FIX_REASON_MESSAGES,
  SAVE_FAILED_MESSAGE,
  STALE_FIX_MESSAGE,
  createFixService,
} from '../src/host/fix-service.js';
import { createStore } from '../src/host/store.js';
import { initialTicket } from '../src/host/state-machine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-live-1';
const CWD = '/tmp/bug-workflow-workspace';
const REPO = '/tmp/bug-workflow-repo';
const STORE_TIME = '2026-11-07T00:00:01.000Z';

const WORKTREE = `${REPO}/.dsh-worktrees/BUG-1`;

const PLAN = Object.freeze({
  summary: '修复登录按钮的事件绑定',
  rootCause: '事件监听在重渲染后丢失',
  approach: '在挂载时绑定监听并在卸载时清理',
  changedFiles: ['src/features/login/LoginForm.tsx'],
  risks: ['可能影响注册表单'],
  testPlan: '运行登录表单单测',
});

const SUCCESS_RESULT = Object.freeze({
  ok: true,
  result: Object.freeze({
    summary: '已修复事件绑定并补充清理逻辑',
    changedFiles: ['src/from-runner.tsx'],
    testResult: 'node --test：通过',
    notes: '未运行端到端测试',
  }),
  childId: 'child-1',
  elapsedMs: 5,
});

/** JSON round-trip so the fake backend never shares object identity. */
function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Minimal in-memory storage-domain double (same contract as other tests). */
function createFakeDomain({ beforePut } = {}) {
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
          if (typeof beforePut === 'function') await beforePut(name, key, value);
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

/** Monotonic ISO clock for the service's action ids and timestamps. */
function createServiceClock() {
  let tick = 0;
  return () => `2026-11-07T03:00:${String(tick++).padStart(2, '0')}.000Z`;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Fake git executor; every method records its call and returns an override. */
function createFakeGit(options = {}) {
  const calls = {
    repoRoot: [],
    refExists: [],
    worktreePath: [],
    worktreeAdd: [],
    status: [],
    diffStat: [],
    diff: [],
  };
  const refs = options.refs ?? {};

  return {
    calls,
    async repoRoot(cwd) {
      calls.repoRoot.push(cwd);
      if (options.repoRootResult !== undefined) return options.repoRootResult;
      return options.repo ?? REPO;
    },
    async refExists(repo, ref) {
      calls.refExists.push({ repo, ref });
      if (typeof options.refExistsResult === 'function') {
        const result = options.refExistsResult(repo, ref);
        if (result !== undefined) return result;
      }
      return { ok: true, exists: refs[ref] === true };
    },
    worktreePath(input) {
      calls.worktreePath.push(input);
      if (options.worktreePathResult !== undefined) return options.worktreePathResult;
      return { ok: true, path: `${input.repo}/.dsh-worktrees/${input.code}` };
    },
    async worktreeAdd(input) {
      calls.worktreeAdd.push(input);
      if (options.worktreeAddResult !== undefined) return options.worktreeAddResult;
      return { created: true };
    },
    async status(root) {
      calls.status.push(root);
      // A function lets a test gate the post-run collection (cancel window).
      if (typeof options.statusResult === 'function') return options.statusResult(root);
      if (options.statusResult !== undefined) return options.statusResult;
      return options.status ?? '';
    },
    async diffStat(root) {
      calls.diffStat.push(root);
      if (options.diffStatResult !== undefined) return options.diffStatResult;
      return options.diffStat ?? '';
    },
    async diff(root) {
      calls.diff.push(root);
      if (options.diffResult !== undefined) return options.diffResult;
      return options.diff ?? '';
    },
  };
}

/** Fake fix runner; `run` may return a promise the test controls. */
function createFakeRunner({ available = true, run } = {}) {
  const calls = [];
  return {
    calls,
    available() {
      return typeof available === 'function' ? available() : available;
    },
    runFix(input) {
      calls.push(input);
      if (typeof run === 'function') return run(input);
      return Promise.resolve(cloneJson(SUCCESS_RESULT));
    },
  };
}

/**
 * Build a real store over a fake domain plus the fix service.
 * `store` uses a constant clock: the persisted timestamps are not under test.
 */
function setup({
  gitOptions,
  runnerOptions,
  settings = { branchUser: 'ly' },
  domain: providedDomain,
  store: providedStore,
  ...serviceOptions
} = {}) {
  const domain = providedDomain ?? createFakeDomain();
  const store = providedStore ?? createStore(domain, () => STORE_TIME);
  const git = createFakeGit(gitOptions);
  const runner = createFakeRunner(runnerOptions);
  const settingsCalls = [];
  const service = createFixService({
    store,
    runner,
    git,
    getSettings: (cwd) => {
      settingsCalls.push(cwd);
      return settings;
    },
    clock: serviceOptions.clock ?? createServiceClock(),
    ...(serviceOptions.timeoutMs === undefined ? {} : { timeoutMs: serviceOptions.timeoutMs }),
    ...(serviceOptions.drainTimeoutMs === undefined
      ? {}
      : { drainTimeoutMs: serviceOptions.drainTimeoutMs }),
  });
  return { domain, store, git, runner, service, settingsCalls };
}

/** Seed a ticket directly into the fake domain (test-only, bypasses the store). */
async function seedRaw(domain, code, patch = {}) {
  const ticket = { ...initialTicket({ code, title: code }, STORE_TIME), ...patch };
  await domain.table('tickets').put(code, ticket);
  return ticket;
}

/**
 * Create a normal ticket and drive it through the real state machine to
 * `fixing` with an approved plan (the state P4 expects).
 */
async function seedFixing(store, { code = 'BUG-1', type = '缺陷', version = 'V1.6.1' } = {}) {
  const created = await store.create({ code, title: code, type, version });
  assert.equal(created.ok, true);
  const started = await store.applyAction(code, 'start_analysis', { actor: 'user' });
  assert.equal(started.ok, true);
  const analyzed = await store.applyAction(code, 'analysis_done', { plan: cloneJson(PLAN), actor: 'agent' });
  assert.equal(analyzed.ok, true);
  const approved = await store.applyAction(code, 'approve_plan', { actor: 'user' });
  assert.equal(approved.ok, true);
  assert.equal(approved.ticket.workflow, 'fixing');
  return approved.ticket;
}

/** Seed a ticket blocked by a failed fix (`blockedFrom:'fixing'`). */
async function seedBlockedFromFixing(store) {
  await seedFixing(store);
  const blocked = await store.applyAction('BUG-1', 'block', {
    reason: 'fix-failed',
    actor: 'system',
  });
  assert.equal(blocked.ok, true);
  assert.equal(blocked.ticket.blockedFrom, 'fixing');
  return blocked.ticket;
}

/** Tick macrotasks until the service has no running fix (bounded). */
async function waitForIdle(service, limit = 500) {
  for (let index = 0; index < limit; index += 1) {
    if (service.status().running.length === 0) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('fix job did not settle');
}

// ---------------------------------------------------------------------------
// Happy path: branch/worktree + fix_done
// ---------------------------------------------------------------------------

test('start() creates the personal worktree from origin, records metadata and applies fix_done', async () => {
  const { store, git, runner, service, settingsCalls } = setup({
    gitOptions: {
      refs: { 'origin/feature-V1.6.1': true },
      status: ' M src/a.js\n?? "src/new file.js"\n',
      diffStat: ' 2 files changed, 3 insertions(+)',
      diff: 'diff --git a/src/a.js b/src/a.js\n+fixed',
    },
  });
  await seedFixing(store);

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.deepEqual(result, { ok: true, running: true, workflow: 'fixing' });
  assert.deepEqual(settingsCalls, [CWD]);

  // Repo/branch/worktree wiring.
  assert.deepEqual(git.calls.repoRoot, [CWD]);
  assert.deepEqual(git.calls.refExists, [
    { repo: REPO, ref: 'origin/feature-V1.6.1' },
  ]);
  assert.deepEqual(git.calls.worktreePath, [{ repo: REPO, code: 'BUG-1' }]);
  assert.deepEqual(git.calls.worktreeAdd, [{
    repo: REPO,
    path: WORKTREE,
    branch: 'feat-V1.6.1-ly',
    base: 'origin/feature-V1.6.1',
  }]);

  // Branch metadata is persisted before the job starts.
  const started = store.get('BUG-1');
  assert.equal(started.workflow, 'fixing');
  assert.equal(started.branch.name, 'feat-V1.6.1-ly');
  assert.equal(started.branch.target, 'feature-V1.6.1');
  assert.equal(started.branch.baseSource, 'origin');
  assert.equal(started.branch.worktree, WORKTREE);
  assert.equal(typeof started.branch.createdAt, 'string');
  assert.equal(started.timeline.at(-1).kind, 'worktree');
  assert.equal(started.timeline.at(-1).actor, 'system');

  assert.equal(runner.calls.length, 1);
  const call = runner.calls[0];
  assert.equal(call.sessionId, SESSION_ID);
  assert.equal(call.worktreePath, WORKTREE);
  assert.equal(call.branch, 'feat-V1.6.1-ly');
  assert.equal(call.target, 'feature-V1.6.1');
  assert.equal(call.ticket.code, 'BUG-1');
  assert.equal(call.plan.summary, PLAN.summary);
  assert.ok(call.signal instanceof AbortSignal);
  assert.equal(call.signal.aborted, false);
  assert.equal(call.timeoutMs, 900_000);

  assert.deepEqual(service.status().running, ['BUG-1']);
  await waitForIdle(service);

  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'fix_done');
  assert.deepEqual(ticket.branch, started.branch, 'branch metadata must survive fix_done');
  assert.equal(ticket.fixes.length, 1);
  const entry = ticket.fixes[0];
  assert.equal(entry.status, 'succeeded');
  assert.equal(typeof entry.runId, 'string');
  assert.equal(entry.childId, 'child-1');
  assert.equal(entry.summary, SUCCESS_RESULT.result.summary);
  assert.equal(entry.testResult, SUCCESS_RESULT.result.testResult);
  assert.equal(entry.notes, SUCCESS_RESULT.result.notes);
  assert.deepEqual(entry.changedFiles, ['src/a.js', 'src/new file.js']);
  assert.equal(entry.diffStat, ' 2 files changed, 3 insertions(+)');
  assert.ok(entry.diff.includes('+fixed'));
  assert.equal(typeof entry.startedAt, 'string');
  assert.equal(typeof entry.finishedAt, 'string');
  assert.equal(entry.elapsedMs, 5);

  assert.equal(ticket.timeline.at(-1).kind, 'fix_done');
  assert.equal(ticket.timeline.at(-1).actor, 'agent');
  assert.equal(store.getMeta(FIX_ERROR_META_PREFIX + 'BUG-1'), undefined);
  assert.deepEqual(service.status(), { running: [], errors: {} });

  assert.deepEqual(git.calls.status, [WORKTREE]);
  assert.deepEqual(git.calls.diffStat, [WORKTREE]);
  assert.deepEqual(git.calls.diff, [WORKTREE]);
});

test('start() records baseSource target when only the local target branch exists', async () => {
  const { store, git, service } = setup({
    gitOptions: { refs: { 'feature-V1.6.1': true } },
    settings: { branchUser: 'zz' },
  });
  await seedFixing(store);

  await service.start(SESSION_ID, CWD, 'BUG-1');
  await waitForIdle(service);

  assert.deepEqual(git.calls.refExists.map((call) => call.ref), [
    'origin/feature-V1.6.1',
    'feature-V1.6.1',
  ]);
  assert.equal(git.calls.worktreeAdd[0].base, 'feature-V1.6.1');
  assert.equal(git.calls.worktreeAdd[0].branch, 'feat-V1.6.1-zz');
  const ticket = store.get('BUG-1');
  assert.equal(ticket.branch.baseSource, 'target');
  assert.equal(ticket.branch.name, 'feat-V1.6.1-zz');
});

test('start() falls back to HEAD and uses the hot family for failure tickets', async () => {
  const { store, git, service } = setup();
  await seedFixing(store, { type: '故障' });

  await service.start(SESSION_ID, CWD, 'BUG-1');
  await waitForIdle(service);

  assert.deepEqual(git.calls.refExists.map((call) => call.ref), [
    'origin/hotfix-V1.6.1',
    'hotfix-V1.6.1',
  ]);
  assert.deepEqual(git.calls.worktreeAdd[0], {
    repo: REPO,
    path: WORKTREE,
    branch: 'hot-V1.6.1-ly',
    base: 'HEAD',
  });
  const ticket = store.get('BUG-1');
  assert.equal(ticket.branch.baseSource, 'HEAD');
  assert.equal(ticket.branch.target, 'hotfix-V1.6.1');
});

test('start() prefers platform.versionName over the ticket version', async () => {
  const { domain, store, git, service } = setup();
  await seedFixing(store);
  const ticket = store.get('BUG-1');
  await domain.table('tickets').put('BUG-1', {
    ...ticket,
    version: 'V1.0.0',
    platform: {
      taskId: '1',
      taskCode: 'BUG-1',
      typeKey: 'BUG',
      typeName: '缺陷',
      statusKey: 's',
      statusName: 's',
      priorityKey: 'p',
      priorityName: 'p',
      versionKey: 'v',
      versionName: 'V2.0.0',
      projectId: null,
      projectName: null,
      assigneeId: null,
      assigneeName: null,
      description: '',
      url: '',
      syncedAt: 0,
    },
  });

  await service.start(SESSION_ID, CWD, 'BUG-1');
  await waitForIdle(service);

  assert.equal(git.calls.worktreeAdd[0].branch, 'feat-V2.0.0-ly');
  assert.equal(store.get('BUG-1').branch.target, 'feature-V2.0.0');
});

test('start() reuses an orphaned fixing ticket without a state write', async () => {
  const { store, service } = setup({ gitOptions: { status: ' M src/a.js\n' } });
  await seedFixing(store);
  const before = store.get('BUG-1');
  const kindsBefore = before.timeline.map((entry) => entry.kind);

  await service.start(SESSION_ID, CWD, 'BUG-1');
  await waitForIdle(service);

  const after = store.get('BUG-1');
  assert.equal(after.workflow, 'fix_done');
  const kindsAfter = after.timeline.map((entry) => entry.kind);
  assert.deepEqual(kindsAfter.slice(0, kindsBefore.length), kindsBefore, 'no state write before the job');
  assert.equal(kindsAfter.includes('retry'), false);
  assert.equal(kindsAfter.filter((kind) => kind === 'start_analysis').length, 1);
  assert.equal(after.timeline.filter((entry) => entry.kind === 'worktree').length, 1);
});

// ---------------------------------------------------------------------------
// Preconditions / single-flight
// ---------------------------------------------------------------------------

test('start() returns plan-not-approved and does not touch git or the runner', async () => {
  const { domain, store, git, runner, service } = setup();
  await seedRaw(domain, 'BUG-1', {
    workflow: 'fixing',
    plan: { ...cloneJson(PLAN), approvedAt: null },
  });

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.deepEqual(result, {
    ok: false,
    code: 'plan-not-approved',
    message: '方案尚未审核通过，无法开始修复',
  });
  assert.equal(runner.calls.length, 0);
  assert.deepEqual(git.calls.repoRoot, []);
  assert.equal(store.get('BUG-1').workflow, 'fixing');
});

test('start() returns invalid-state for a ticket that is not fixing', async () => {
  const { store, runner, service } = setup();
  await store.create({ code: 'BUG-1', title: 'BUG-1' });

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-state');
  assert.equal(runner.calls.length, 0);
  assert.equal(store.get('BUG-1').workflow, 'inbox');
});

test('start() returns ticket-not-found for an unknown code', async () => {
  const { runner, service } = setup();
  const result = await service.start(SESSION_ID, CWD, 'NOPE-1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ticket-not-found');
  assert.equal(runner.calls.length, 0);
});

test('start() returns invalid-version before creating a worktree when the version is missing', async () => {
  const { store, git, runner, service } = setup();
  await store.create({ code: 'BUG-1', title: 'BUG-1' });
  await store.applyAction('BUG-1', 'start_analysis', { actor: 'user' });
  await store.applyAction('BUG-1', 'analysis_done', { plan: cloneJson(PLAN), actor: 'agent' });
  await store.applyAction('BUG-1', 'approve_plan', { actor: 'user' });

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-version');
  assert.equal(runner.calls.length, 0);
  assert.deepEqual(git.calls.worktreeAdd, []);
  assert.equal(store.get('BUG-1').workflow, 'fixing');
  assert.equal(store.get('BUG-1').branch, null);
});

test('a duplicate start while running does not launch a second runner call', async () => {
  const pending = deferred();
  const { store, runner, service } = setup({
    gitOptions: { status: ' M src/a.js\n' },
    runnerOptions: { run: () => pending.promise },
  });
  await seedFixing(store);

  const first = service.start(SESSION_ID, CWD, 'BUG-1');
  const duplicate = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.deepEqual(duplicate, { ok: true, running: true, workflow: 'fixing' });

  const started = await first;
  assert.equal(started.ok, true);
  assert.equal(runner.calls.length, 1);
  assert.equal(service.status().running.length, 1);

  pending.resolve(cloneJson(SUCCESS_RESULT));
  await waitForIdle(service);

  assert.equal(runner.calls.length, 1);
  assert.equal(store.get('BUG-1').timeline.filter((entry) => entry.kind === 'worktree').length, 1);
  assert.equal(store.get('BUG-1').workflow, 'fix_done');
});

// ---------------------------------------------------------------------------
// Failure mapping
// ---------------------------------------------------------------------------

const FAILURE_CASES = [
  ['analysis-timeout', 'fix-timeout'],
  ['analysis-bad-output', 'fix-bad-output'],
  ['analysis-unavailable', 'no-live-agent'],
  ['analysis-failed', 'fix-failed'],
];

for (const [runnerCode, reason] of FAILURE_CASES) {
  test(`runner ${runnerCode} blocks the ticket with reason ${reason} and a static error`, async () => {
    const { store, service } = setup({
      runnerOptions: {
        run: () => Promise.resolve({ ok: false, code: runnerCode, message: 'internal detail' }),
      },
    });
    await seedFixing(store);
    const worktreeBefore = (await service.start(SESSION_ID, CWD, 'BUG-1')).ok;
    assert.equal(worktreeBefore, true);
    await waitForIdle(service);

    const ticket = store.get('BUG-1');
    assert.equal(ticket.workflow, 'blocked');
    assert.equal(ticket.blockedFrom, 'fixing');
    assert.equal(ticket.blockedReason, reason);
    assert.deepEqual(ticket.fixes, []);
    assert.equal(ticket.timeline.at(-1).kind, 'blocked');
    assert.equal(ticket.branch.name, 'feat-V1.6.1-ly', 'branch metadata is kept for the restart');

    const message = FIX_REASON_MESSAGES[reason];
    assert.equal(store.getMeta(FIX_ERROR_META_PREFIX + 'BUG-1'), message);
    assert.deepEqual(service.status(), { running: [], errors: { 'BUG-1': message } });

    // The persisted meta is the source of truth for a later host load.
    const restarted = createFixService({
      store,
      runner: { available: () => true, runFix: () => Promise.resolve(SUCCESS_RESULT) },
      git: createFakeGit(),
      getSettings: () => ({ branchUser: 'ly' }),
      clock: createServiceClock(),
    });
    assert.deepEqual(restarted.status().errors, { 'BUG-1': message });
  });
}

test('a runner failure after the ticket moved on only records the static error', async () => {
  const pending = deferred();
  const { store, service } = setup({ runnerOptions: { run: () => pending.promise } });
  await seedFixing(store);
  await service.start(SESSION_ID, CWD, 'BUG-1');

  const blocked = await store.applyAction(
    'BUG-1',
    'block',
    { reason: 'manual-stop', actor: 'user' },
    { actionId: 'manual-block' },
  );
  assert.equal(blocked.ok, true);

  pending.resolve({ ok: false, code: 'analysis-timeout', message: 'timeout' });
  await waitForIdle(service);

  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedReason, 'manual-stop', 'a late failure must not overwrite the reason');
  assert.equal(ticket.timeline.filter((entry) => entry.kind === 'blocked').length, 1);
  assert.equal(store.getMeta(FIX_ERROR_META_PREFIX + 'BUG-1'), FIX_REASON_MESSAGES['fix-timeout']);
});

test('a late success after the ticket moved on writes no fixes and no fix_done', async () => {
  const pending = deferred();
  const { store, service } = setup({ runnerOptions: { run: () => pending.promise } });
  await seedFixing(store);
  await service.start(SESSION_ID, CWD, 'BUG-1');

  await store.applyAction(
    'BUG-1',
    'block',
    { reason: 'manual-stop', actor: 'user' },
    { actionId: 'manual-block' },
  );

  pending.resolve(cloneJson(SUCCESS_RESULT));
  await waitForIdle(service);

  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'blocked');
  assert.deepEqual(ticket.fixes, [], 'a stale success must not be recorded');
  assert.equal(ticket.timeline.some((entry) => entry.kind === 'fix_done'), false);
  assert.equal(store.getMeta(FIX_ERROR_META_PREFIX + 'BUG-1'), STALE_FIX_MESSAGE);
});

// ---------------------------------------------------------------------------
// Blocked(fixing) restart
// ---------------------------------------------------------------------------

test('start() restarts a ticket blocked from fixing via retry, then runs the fix', async () => {
  const { store, service } = setup({ gitOptions: { status: ' M src/a.js\n' } });
  await seedBlockedFromFixing(store);

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.deepEqual(result, { ok: true, running: true, workflow: 'fixing' });

  // The retry transition happened before the job; the worktree metadata was
  // persisted afterwards and the workflow is fixing while the job runs.
  const running = store.get('BUG-1');
  assert.equal(running.workflow, 'fixing');
  assert.equal(running.blockedFrom, null);
  assert.equal(running.blockedReason, null);
  assert.equal(running.timeline.at(-2).kind, 'retry');
  assert.equal(running.timeline.at(-1).kind, 'worktree');

  await waitForIdle(service);
  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'fix_done');
  assert.equal(ticket.fixes.length, 1);
  assert.deepEqual(service.status(), { running: [], errors: {} });
});

test('a blocked restart checks runner availability before the retry write', async () => {
  const { store, runner, service } = setup({ runnerOptions: { available: false } });
  await seedBlockedFromFixing(store);
  const before = store.get('BUG-1');

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.deepEqual(result, {
    ok: false,
    code: 'fix-unavailable',
    message: FIX_REASON_MESSAGES['no-live-agent'],
  });

  const after = store.get('BUG-1');
  assert.equal(after.workflow, 'blocked');
  assert.equal(after.blockedFrom, 'fixing');
  assert.deepEqual(after.timeline, before.timeline, 'no write may happen on an unavailable runner');
  assert.equal(runner.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Worktree failure
// ---------------------------------------------------------------------------

test('start() returns a structured worktree failure and keeps the ticket fixing', async () => {
  const { store, runner, service } = setup({
    gitOptions: {
      worktreeAddResult: {
        ok: false,
        code: 'worktree-conflict',
        message: '工作树已存在且分支与目标分支不一致',
        command: 'git worktree add',
      },
    },
  });
  await seedFixing(store);

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.deepEqual(result, {
    ok: false,
    code: 'worktree-conflict',
    message: '工作树已存在且分支与目标分支不一致',
  });
  assert.equal(runner.calls.length, 0);
  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'fixing');
  assert.equal(ticket.branch, null);
  assert.deepEqual(service.status().running, []);
});

test('start() maps a git timeout to a retryable, static failure', async () => {
  const { store, runner, service } = setup({
    gitOptions: {
      repoRootResult: {
        ok: false,
        code: 'git-timeout',
        message: 'git 命令执行超时',
        command: 'git rev-parse --show-toplevel',
      },
    },
  });
  await seedFixing(store);

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'git-timeout');
  assert.equal(result.message, 'git 命令执行超时');
  assert.equal(runner.calls.length, 0);
  assert.equal(store.get('BUG-1').workflow, 'fixing');
});

// ---------------------------------------------------------------------------
// Cancellation / dispose
// ---------------------------------------------------------------------------

test('dispose() cancels a running fix without blocking the ticket or persisting an error', async () => {
  const pending = deferred();
  const { store, runner, service } = setup({
    runnerOptions: { run: () => pending.promise },
    drainTimeoutMs: 200,
  });
  await seedFixing(store);
  await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.equal(runner.calls[0].signal.aborted, false);

  const firstDispose = service.dispose();
  assert.equal(service.dispose(), firstDispose, 'dispose() is idempotent');
  assert.equal(runner.calls[0].signal.aborted, true, 'the runner signal must be aborted');

  pending.resolve(cloneJson(SUCCESS_RESULT));
  await firstDispose;
  await waitForIdle(service);

  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'fixing');
  assert.deepEqual(ticket.fixes, []);
  assert.equal(ticket.timeline.some((entry) => entry.kind === 'fix_done'), false);
  assert.equal(ticket.timeline.some((entry) => entry.kind === 'blocked'), false);
  assert.equal(store.getMeta(FIX_ERROR_META_PREFIX + 'BUG-1'), undefined);
  assert.deepEqual(service.status(), { running: [], errors: {} });

  // A start after teardown is a 503 and never launches a job.
  const afterDispose = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.equal(afterDispose.ok, false);
  assert.equal(afterDispose.code, 'fix-unavailable');
  assert.equal(runner.calls.length, 1);
});

test('dispose() drain is bounded when the runner ignores its abort signal', async () => {
  const { store, service } = setup({
    runnerOptions: { run: () => new Promise(() => {}) },
    drainTimeoutMs: 30,
  });
  await seedFixing(store);
  await service.start(SESSION_ID, CWD, 'BUG-1');

  const startedAt = Date.now();
  await service.dispose();
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1_000, `dispose() must not hang unload (took ${elapsed}ms)`);
  assert.equal(store.get('BUG-1').workflow, 'fixing');
  assert.equal(store.getMeta(FIX_ERROR_META_PREFIX + 'BUG-1'), undefined);
});

test('a fix cancelled before the job settles re-runs through the orphan path on the next host', async () => {
  const pending = deferred();
  const domain = createFakeDomain();
  const store = createStore(domain, () => STORE_TIME);
  const first = setup({
    domain,
    store,
    runnerOptions: { run: () => pending.promise },
    drainTimeoutMs: 200,
  });
  await seedFixing(store);
  await first.service.start(SESSION_ID, CWD, 'BUG-1');
  const disposePromise = first.service.dispose();
  pending.resolve(cloneJson(SUCCESS_RESULT));
  await disposePromise;
  assert.equal(store.get('BUG-1').workflow, 'fixing');

  // A new host instance sees `fixing` with no in-memory job and restarts it.
  const second = setup({ domain, store, gitOptions: { status: ' M src/a.js\n' } });
  const result = await second.service.start(SESSION_ID, CWD, 'BUG-1');
  assert.equal(result.ok, true);
  await waitForIdle(second.service);
  assert.equal(store.get('BUG-1').workflow, 'fix_done');
});

test('changedFiles parses porcelain renames, quoted paths and falls back when status fails', async () => {
  const { store, service } = setup({
    gitOptions: {
      // `??` untracked, a rename and a quoted UTF-8 path (git octal escapes).
      status: '?? "src/\\344\\270\\255.js"\nR  old.js -> new.js\nM  src/a.js\n',
    },
  });
  await seedFixing(store);
  await service.start(SESSION_ID, CWD, 'BUG-1');
  await waitForIdle(service);

  assert.deepEqual(store.get('BUG-1').fixes[0].changedFiles, [
    'src/中.js',
    'new.js',
    'src/a.js',
  ]);

  const failing = setup({
    gitOptions: {
      statusResult: { ok: false, code: 'git-failed', message: 'git 命令执行失败' },
    },
  });
  await seedFixing(failing.store);
  await failing.service.start(SESSION_ID, CWD, 'BUG-1');
  await waitForIdle(failing.service);

  const ticket = failing.store.get('BUG-1');
  assert.equal(ticket.workflow, 'fix_done', 'a status read failure must not fail the whole fix');
  assert.deepEqual(ticket.fixes[0].changedFiles, SUCCESS_RESULT.result.changedFiles);
  assert.equal(ticket.fixes[0].diffStat, '');
});

// ---------------------------------------------------------------------------
// P4 Task 2 review fixes: I1 restart ordering, I3 zero changes, I4 concurrency,
// M1 cancel re-check, M2 diff cap, M3 failure labelling
// ---------------------------------------------------------------------------

test('a blocked(fixing) restart keeps the ticket blocked when worktree preparation fails', async () => {
  const { store, git, runner, service } = setup({
    gitOptions: {
      worktreeAddResult: { ok: false, code: 'git-timeout', message: 'git 命令执行超时' },
    },
  });
  await seedBlockedFromFixing(store);
  const branchMetadata = {
    name: 'feat-V1.6.1-ly',
    target: 'feature-V1.6.1',
    baseSource: 'origin',
    worktree: WORKTREE,
    createdAt: STORE_TIME,
  };
  await store.patchTicket('BUG-1', { branch: branchMetadata });
  const before = store.get('BUG-1');

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');

  assert.deepEqual(result, {
    ok: false,
    code: 'git-timeout',
    message: 'git 命令执行超时',
  });
  const after = store.get('BUG-1');
  assert.equal(after.workflow, 'blocked', 'a failed preparation must not strand the ticket in fixing');
  assert.equal(after.blockedFrom, 'fixing');
  assert.equal(after.blockedReason, before.blockedReason);
  assert.deepEqual(after.branch, branchMetadata, 'branch metadata must not degrade');
  assert.deepEqual(after.timeline, before.timeline, 'no retry/timeline write may happen');
  assert.equal(runner.calls.length, 0);
  assert.equal(store.getMeta(FIX_ERROR_META_PREFIX + 'BUG-1'), FIX_REASON_MESSAGES['fix-timeout']);
  assert.deepEqual(service.status(), {
    running: [],
    errors: { 'BUG-1': FIX_REASON_MESSAGES['fix-timeout'] },
  });
  assert.deepEqual(git.calls.worktreeAdd, [{
    repo: REPO,
    path: WORKTREE,
    branch: 'feat-V1.6.1-ly',
    base: 'HEAD',
  }]);
});

test('a blocked restart whose branch metadata cannot be persisted falls back to blocked', async () => {
  const { store, service } = setup({ gitOptions: { status: ' M src/a.js\n' } });
  await seedBlockedFromFixing(store);
  const originalPatch = store.patchTicket.bind(store);
  store.patchTicket = async (code, patch, options) => {
    if (patch !== null && typeof patch === 'object' && patch.branch !== undefined) {
      return { ok: false, code: 'invalid-payload', message: '工单数据未通过校验' };
    }
    return originalPatch(code, patch, options);
  };

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-payload');
  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'blocked', 'the retry must be rolled back');
  assert.equal(ticket.blockedFrom, 'fixing');
  assert.equal(ticket.blockedReason, 'fix-failed');
  assert.equal(store.getMeta(FIX_ERROR_META_PREFIX + 'BUG-1'), FIX_REASON_MESSAGES['fix-failed']);
  assert.deepEqual(service.status().running, []);
});

test('a successful runner result with an empty worktree blocks with fix-no-changes instead of fix_done', async () => {
  const { store, service } = setup({ gitOptions: { status: '' } });
  await seedFixing(store);

  const started = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.deepEqual(started, { ok: true, running: true, workflow: 'fixing' });
  await waitForIdle(service);

  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedFrom, 'fixing');
  assert.equal(ticket.blockedReason, 'fix-no-changes');
  assert.equal(ticket.timeline.some((entry) => entry.kind === 'fix_done'), false);
  assert.equal(ticket.fixes.length, 1);
  assert.equal(ticket.fixes[0].status, 'failed');
  assert.equal(ticket.fixes[0].error, 'fix-no-changes');
  assert.deepEqual(ticket.fixes[0].changedFiles, []);
  assert.equal(ticket.branch.name, 'feat-V1.6.1-ly');
  assert.equal(store.getMeta(FIX_ERROR_META_PREFIX + 'BUG-1'), FIX_REASON_MESSAGES['fix-no-changes']);
});

test('a second ticket in the same repository is rejected with fix-busy while a fix runs', async () => {
  const pending = deferred();
  const { store, runner, service } = setup({
    gitOptions: { status: ' M src/a.js\n' },
    runnerOptions: { run: () => pending.promise },
  });
  await seedFixing(store, { code: 'BUG-1', version: 'V1.6.1' });
  await seedFixing(store, { code: 'BUG-2', version: 'V1.7.0' });

  const first = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.equal(first.ok, true);

  // Same-ticket single-flight is unchanged (200 running, no second runner).
  const duplicate = await service.start(SESSION_ID, CWD, 'BUG-1');
  assert.deepEqual(duplicate, { ok: true, running: true, workflow: 'fixing' });

  const busy = await service.start(SESSION_ID, CWD, 'BUG-2');
  assert.deepEqual(busy, { ok: false, code: 'fix-busy', message: FIX_BUSY_MESSAGE });
  assert.equal(runner.calls.length, 1);
  assert.equal(store.get('BUG-2').workflow, 'fixing');
  assert.equal(store.get('BUG-2').branch, null, 'a busy refusal writes nothing');

  pending.resolve(cloneJson(SUCCESS_RESULT));
  await waitForIdle(service);

  const second = await service.start(SESSION_ID, CWD, 'BUG-2');
  assert.equal(second.ok, true, 'the repository lock is released when the first job settles');
  await waitForIdle(service);
  assert.equal(store.get('BUG-2').workflow, 'fix_done');
});

test('a personal branch already checked out by another ticket fails with fix-branch-busy', async () => {
  const { store, git, runner, service } = setup({ gitOptions: { status: ' M src/a.js\n' } });
  await seedFixing(store, { code: 'BUG-1' });
  await seedFixing(store, { code: 'BUG-2' });
  await store.patchTicket('BUG-2', {
    branch: {
      name: 'feat-V1.6.1-ly',
      target: 'feature-V1.6.1',
      baseSource: 'origin',
      worktree: `${REPO}/.dsh-worktrees/BUG-2`,
      createdAt: STORE_TIME,
    },
  });

  const result = await service.start(SESSION_ID, CWD, 'BUG-1');

  assert.deepEqual(result, {
    ok: false,
    code: 'fix-branch-busy',
    message: FIX_REASON_MESSAGES['fix-branch-busy'],
  });
  assert.deepEqual(git.calls.worktreeAdd, [], 'git must not be allowed to collide');
  assert.deepEqual(git.calls.status, [`${REPO}/.dsh-worktrees/BUG-2`]);
  assert.equal(runner.calls.length, 0);
  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedFrom, 'fixing');
  assert.equal(ticket.blockedReason, 'fix-branch-busy');
  assert.equal(ticket.branch, null);
  assert.equal(store.getMeta(FIX_ERROR_META_PREFIX + 'BUG-1'), FIX_REASON_MESSAGES['fix-branch-busy']);
});

test('a dispose during post-run git collection performs no state write', async () => {
  const gate = deferred();
  const { store, git, service } = setup({
    gitOptions: { statusResult: () => gate.promise },
  });
  await seedFixing(store);

  await service.start(SESSION_ID, CWD, 'BUG-1');
  for (let index = 0; index < 200 && git.calls.status.length === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(git.calls.status.length, 1, 'the runner finished and git status is awaited');

  const disposePromise = service.dispose();
  gate.resolve(' M src/a.js\n');
  await disposePromise;
  await waitForIdle(service);

  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'fixing');
  assert.deepEqual(ticket.fixes, []);
  assert.equal(ticket.timeline.some((entry) => entry.kind === 'fix_done'), false);
  assert.equal(ticket.timeline.some((entry) => entry.kind === 'blocked'), false);
  assert.equal(store.getMeta(FIX_ERROR_META_PREFIX + 'BUG-1'), undefined);
  assert.deepEqual(service.status(), { running: [], errors: {} });
});

test('the persisted diff is clipped to a bounded excerpt', async () => {
  const longDiff = `diff --git a/src/a.js b/src/a.js\n${'+x'.repeat(9000)}`;
  const { store, service } = setup({
    gitOptions: { status: ' M src/a.js\n', diff: longDiff },
  });
  await seedFixing(store);

  await service.start(SESSION_ID, CWD, 'BUG-1');
  await waitForIdle(service);

  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'fix_done');
  const entry = ticket.fixes[0];
  assert.equal(entry.status, 'succeeded');
  assert.ok(entry.diff.length <= FIX_DIFF_MAX_CHARS, `diff length ${entry.diff.length}`);
  assert.ok(entry.diff.includes('…（diff 已截断）'));
});

test('a non-stale persistence failure uses the save-failed copy, not the stale copy', async () => {
  const { store, runner, service } = setup({ gitOptions: { status: ' M src/a.js\n' } });
  await seedFixing(store);
  const originalPatch = store.patchTicket.bind(store);
  store.patchTicket = async (code, patch, options) => {
    if (patch !== null && typeof patch === 'object' && Array.isArray(patch.fixes)) {
      return { ok: false, code: 'invalid-payload', message: '工单数据未通过校验' };
    }
    return originalPatch(code, patch, options);
  };

  await service.start(SESSION_ID, CWD, 'BUG-1');
  await waitForIdle(service);

  assert.equal(runner.calls.length, 1);
  const ticket = store.get('BUG-1');
  assert.equal(ticket.workflow, 'fixing', 'a failed write must not advance the ticket');
  assert.deepEqual(ticket.fixes, []);
  const meta = store.getMeta(FIX_ERROR_META_PREFIX + 'BUG-1');
  assert.equal(meta, SAVE_FAILED_MESSAGE);
  assert.notEqual(meta, STALE_FIX_MESSAGE);
});
