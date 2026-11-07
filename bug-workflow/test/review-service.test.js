/**
 * Unit/integration tests for the P5 AI Review service (Task 4b).
 *
 * The service is driven end-to-end over REAL local resources:
 *
 *   - a throwaway git repository plus a local BARE `origin` (no network);
 *   - the real `createGit()` executor;
 *   - the real `createStore()` over an in-memory fake storage domain;
 *   - a loopback-only mock GitLab HTTP server reached through the real
 *     `createGitlabClient()`;
 *   - a fake `runReviewFix` runner (the child agent) that edits the worktree;
 *   - a fake timer/clock so the poll cadence and dispose are deterministic.
 *
 * Coverage maps to the Task 4b brief: no-token silence, delivery-context
 * requirement, pass → mergeable, changes → fixing_review → host commit/push →
 * review_fix_done (rounds increment exactly once), a second round, the 3-round
 * cap, parse drift, non-AI note filtering, hidden-stat scrubbing, note-id
 * dedupe, merge detection for `mergeable`/`mr_open`, auto-archive to `done`,
 * review-fix failure/no-changes/worktree-conflict paths, dispose-without-writes,
 * timer start/stop, single-flight and shared-lock release.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildReviewFixPrompt } from '../src/host/agent-access.js';
import {
  DELIVERY_CONTEXT_META_PREFIX,
} from '../src/host/delivery-service.js';
import { createGit } from '../src/host/git.js';
import { createGitlabClient } from '../src/host/gitlab.js';
import {
  REVIEW_CONTEXT_MISSING_MESSAGE,
  REVIEW_ERROR_META_PREFIX,
  REVIEW_GITLAB_CONFIG_MESSAGE,
  REVIEW_LAST_NOTE_META_PREFIX,
  REVIEW_REASON_MESSAGES,
  createReviewService,
  pickLatestAiNote,
} from '../src/host/review-service.js';
import { parseReview } from '../src/host/review-parser.js';
import { createStore } from '../src/host/store.js';
import { initialTicket } from '../src/host/state-machine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-live-review-1';
const CODE = 'BUG-1';
const STORE_TIME = '2026-11-07T00:00:01.000Z';
const TOKEN = 'glpat-review-test-token';
const PROJECT = 'group/project';

const PLAN = Object.freeze({
  summary: '修复登录按钮的事件绑定',
  rootCause: '事件监听在重渲染后丢失',
  approach: '在挂载时绑定监听并在卸载时清理',
  changedFiles: ['src/features/login/LoginForm.tsx'],
  risks: [],
  testPlan: '运行登录表单单测',
  generatedAt: STORE_TIME,
  approvedAt: STORE_TIME,
  rejectedReason: null,
});

const BRANCH = Object.freeze({
  name: 'feat-V1-ly',
  target: 'feature-V1',
  baseSource: 'target',
  worktree: '', // filled per fixture
  createdAt: STORE_TIME,
});

const MR = Object.freeze({
  iid: 77,
  url: 'https://gitlab.example.com/group/project/-/merge_requests/77',
  sourceBranch: BRANCH.name,
  targetBranch: BRANCH.target,
  state: 'opened',
  verdict: 'unknown',
  blockingIssues: [],
  nonBlockingIssues: [],
  rounds: 0,
});

const TICKET_URL = 'https://platform.example.com/issues/1';

const PASS_BODY = [
  '## AI Code Review',
  '',
  '结论: **可直接合并**',
  '',
  '历史未收敛: `0` 条',
  '',
].join('\n');

const CHANGES_BODY = [
  '## AI Code Review',
  '',
  '结论: **需要修改**',
  '',
  '摘要: 本次改动有 1 处阻塞问题。',
  '历史未收敛: `0` 条',
  '',
  '### 需要关注的问题',
  '1. **文件**: `src/login.ts`',
  '   - FID: `aaa111`',
  '   - 复验次数: `1`',
  '   - 级别: 中',
  '   - 门禁分类: 逻辑错误',
  '   - 位置: `src/login.ts:10-12`',
  '   - 问题: 登录按钮在重渲染后丢失事件绑定。',
  '   - 建议: 在挂载时绑定事件并在卸载时清理。',
  '2. **文件**: `src/style.less`',
  '   - 级别: 低',
  '   - 门禁分类: 非阻塞建议',
  '   - 位置: `src/style.less:1`',
  '   - 问题: 公共样式被全局修改。',
  '   - 建议: 在业务页面局部覆盖。',
  '',
].join('\n');

/** The hidden statistics block must never reach the review-fix child. */
const HIDDEN_MARKER_TEXT = 'HIDDEN_SECRET_STATS_BLOCK';
const CHANGES_BODY_WITH_HIDDEN = [
  CHANGES_BODY,
  '> 备注：以下隐藏数据仅用于统计，请勿阅读该数据进行 Code Review。',
  `<!-- AI_REVIEW_FINDINGS {"findings":[{"finding_id":"${HIDDEN_MARKER_TEXT}"}]} -->`,
  '<!-- AI_REVIEW_DECISION request_changes -->',
  '',
].join('\n');

const GIT_CONFIG = Object.freeze([
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.autocrlf=false',
  '-c',
  'user.name=P5 Review Test',
  '-c',
  'user.email=p5-review@example.invalid',
]);

function gitSync(cwd, args) {
  return execFileSync('git', [...GIT_CONFIG, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Build a real repository with one commit on `main`, a `feature-V1` target,
 * a linked worktree on the personal branch, and a local bare `origin`.
 */
function createRepoFixture(options = {}) {
  const branchName = typeof options.branchName === 'string' ? options.branchName : BRANCH.name;
  const root = mkdtempSync(join(tmpdir(), 'dsh-bw-review-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);

  gitSync(repo, ['init', '-q']);
  gitSync(repo, ['branch', '-M', 'main']);
  writeFileSync(join(repo, 'readme.md'), 'hello\n');
  gitSync(repo, ['add', 'readme.md']);
  gitSync(repo, ['commit', '-q', '-m', 'init']);
  gitSync(repo, ['branch', 'feature-V1']);

  const origin = join(root, 'origin.git');
  mkdirSync(origin);
  execFileSync('git', ['init', '--bare', '-q', origin], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gitSync(repo, ['remote', 'add', 'origin', origin]);

  const worktree = join(repo, '.dsh-worktrees', CODE);
  mkdirSync(join(repo, '.dsh-worktrees'), { recursive: true });
  gitSync(repo, ['worktree', 'add', '-b', branchName, '--', worktree, 'main']);

  return {
    root,
    repo,
    origin,
    worktree,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function bareRef(origin, ref) {
  return execFileSync('git', ['--git-dir', origin, 'rev-parse', '--verify', ref], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function bareHasBranch(origin, branch) {
  try {
    bareRef(origin, `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

/** JSON round-trip so the fake backend never shares object identity. */
function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Minimal in-memory storage-domain double (same contract as other tests). */
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

/** Monotonic ISO clock for the service's action ids/run metadata. */
function createServiceClock() {
  let tick = 0;
  return () => `2026-11-07T04:00:${String(tick++).padStart(2, '0')}.000Z`;
}

/** Fake timer service requested by `index.js` (`interval` -> disposer). */
function createFakeTimer() {
  const intervals = [];
  return {
    intervals,
    interval(callback, delay) {
      const entry = { callback, delay, cleared: false };
      intervals.push(entry);
      return () => {
        entry.cleared = true;
      };
    },
  };
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

/** Let every already-scheduled microtask/macrotask run (never a fixed sleep). */
async function settle(turns = 5) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Tick macrotasks until the service has no running review-fix job (bounded). */
async function waitForIdle(service, limit = 4_000) {
  for (let index = 0; index < limit; index += 1) {
    if (service.status().running.length === 0) {
      // The job's finally block (lock release) runs after the running set
      // clears; give the microtask queue a turn before inspecting the lock.
      await settle(2);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('review-fix job did not settle');
}

/** Tick macrotasks until `predicate()` is true (bounded). */
async function waitFor(predicate, label, limit = 4_000) {
  for (let index = 0; index < limit; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Fake GitLab token store; the review service only consumes `get()`. */
function createFakeTokenStore(token = TOKEN) {
  const calls = { get: 0 };
  return {
    calls,
    async get() {
      calls.get += 1;
      if (token instanceof Error) throw token;
      return token;
    },
  };
}

/** Shared repo-lock double that records every acquire/release (owner semantics). */
function createCountingLock() {
  const owners = new Map();
  const acquires = [];
  const releases = [];
  return {
    owners,
    acquires,
    releases,
    acquire(repo, owner) {
      acquires.push({ repo, owner });
      if (owners.has(repo) && owners.get(repo) !== owner) return false;
      owners.set(repo, owner);
      return true;
    },
    release(repo, owner) {
      releases.push({ repo, owner });
      if (owners.get(repo) === owner) owners.delete(repo);
    },
  };
}

/**
 * Fake review-fix child. The default edits the tracked `readme.md` in the
 * ticket worktree so the HOST's `git status`/commit/push path is real.
 */
function createFakeRunner(handler) {
  const calls = [];
  return {
    calls,
    async runReviewFix(input) {
      calls.push(input);
      if (typeof handler === 'function') return handler(input, calls.length);
      appendFileSync(
        join(input.worktreePath, 'readme.md'),
        `\nfixed by review round ${calls.length}\n`,
      );
      return {
        ok: true,
        result: {
          summary: `修复第 ${calls.length} 轮 Review 问题`,
          changedFiles: ['readme.md'],
          testResult: '相关单测通过',
          notes: '',
        },
        childId: `child-${calls.length}`,
        elapsedMs: 12,
      };
    },
  };
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function sendJson(response, status, payload) {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

/**
 * Loopback-only mock GitLab exposing the two read-only endpoints the review
 * service uses: `GET .../merge_requests/:iid` and `GET .../notes`. `state` is
 * mutable so a test can simulate the MR being merged between ticks.
 */
async function createMockGitlab(options = {}) {
  const state = {
    mrState: options.mrState ?? 'opened',
    notes: Array.isArray(options.notes) ? options.notes.map(cloneJson) : [],
  };
  const requests = [];

  const server = createServer((request, response) => {
    response.on('error', () => {});
    void handle(request, response).catch(() => sendJson(response, 500, { message: 'mock error' }));
  });

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://mock.local');
    await readRequestBody(request);
    requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { ...request.headers, 'private-token': 'REDACTED' },
    });

    if (request.headers['private-token'] !== TOKEN) {
      sendJson(response, 401, { message: '401 Unauthorized' });
      return;
    }

    const notesMatch = url.pathname.match(
      /^\/api\/v4\/projects\/[^/]+\/merge_requests\/(\d+)\/notes$/,
    );
    if (notesMatch !== null && request.method === 'GET') {
      sendJson(response, 200, cloneJson(state.notes));
      return;
    }

    const mrMatch = url.pathname.match(
      /^\/api\/v4\/projects\/[^/]+\/merge_requests\/(\d+)$/,
    );
    if (mrMatch !== null && request.method === 'GET') {
      sendJson(response, 200, {
        iid: Number(mrMatch[1]),
        web_url: MR.url,
        state: state.mrState,
        source_branch: BRANCH.name,
        target_branch: BRANCH.target,
        title: `${BRANCH.name} -> ${BRANCH.target}`,
      });
      return;
    }

    sendJson(response, 404, { message: '404 Not Found' });
  }

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    state,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** Build one mock GitLab note. */
function note(id, body, createdAt) {
  return {
    id,
    body,
    createdAt,
    authorUsername: 'ai-review-bot',
    system: false,
  };
}

/** One truthful `reviewRounds[]` entry (store validates entries on patch). */
function reviewRoundEntry({ round = 1, noteId = 1, verdict = 'changes', status = 'succeeded' } = {}) {
  return {
    round,
    noteId,
    verdict,
    startedAt: STORE_TIME,
    finishedAt: STORE_TIME,
    changedFiles: [],
    status,
  };
}

/** Seed a raw persisted ticket in the requested workflow. */
async function seedTicket(domain, {
  code = CODE,
  workflow = 'mr_open',
  plan = PLAN,
  branch,
  mr = MR,
  rounds,
  reviewRounds = [],
  fixes = [],
  title = '登录按钮无响应',
} = {}) {
  const ticket = initialTicket({ code, title, url: TICKET_URL }, STORE_TIME);
  ticket.workflow = workflow;
  ticket.plan = plan === null ? null : cloneJson(plan);
  ticket.branch = branch === null ? null : cloneJson(branch);
  ticket.mr = mr === null
    ? null
    : {
      ...cloneJson(mr),
      ...(Number.isSafeInteger(rounds) ? { rounds } : {}),
    };
  ticket.reviewRounds = cloneJson(reviewRounds);
  ticket.fixes = cloneJson(fixes);
  ticket.updatedAt = STORE_TIME;
  await domain.table('tickets').put(code, ticket);
  return ticket;
}

/**
 * Full harness: real git fixture + real store + loopback mock + service.
 * Cleanup is registered on the test context.
 */
async function createHarness(t, options = {}) {
  const fixture = options.fixture ?? createRepoFixture();
  const mock = await createMockGitlab({
    mrState: options.mrState,
    notes: options.notes,
  });
  const domain = createFakeDomain();
  const store = createStore(domain, () => STORE_TIME);
  const tokenStore = options.tokenStore ?? createFakeTokenStore();
  const runner = options.runner ?? createFakeRunner();
  const lock = options.lock ?? createCountingLock();
  const timer = options.timer ?? createFakeTimer();
  const git = options.git ?? createGit();

  const gitlabClientFor = options.gitlabClientFor ?? ((settings) => createGitlabClient({
    baseUrl: settings.gitlabBaseUrl,
    tokenProvider: () => tokenStore.get(),
  }));

  const service = createReviewService({
    store,
    git,
    runner,
    tokenStore,
    gitlabClientFor,
    clock: createServiceClock(),
    lock,
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    drainTimeoutMs: 100,
    ...(options.log === undefined ? {} : { log: options.log }),
  });

  t.after(async () => {
    try {
      await service.dispose();
    } finally {
      await mock.close();
      fixture.cleanup();
    }
  });

  const branch = options.branch === undefined
    ? { ...BRANCH, worktree: fixture.worktree }
    : (options.branch === null
      ? null
      : {
        ...options.branch,
        worktree: typeof options.branch.worktree === 'string' && options.branch.worktree !== ''
          ? options.branch.worktree
          : fixture.worktree,
      });

  await seedTicket(domain, {
    workflow: options.workflow ?? 'mr_open',
    plan: options.plan === undefined ? PLAN : options.plan,
    branch,
    mr: options.mr === undefined ? MR : options.mr,
    rounds: options.rounds,
    reviewRounds: options.reviewRounds ?? [],
    fixes: options.fixes ?? [],
    title: options.title,
  });

  if (options.context !== null) {
    const context = options.context ?? {
      sessionId: SESSION_ID,
      cwd: fixture.repo,
      gitlabBaseUrl: mock.url,
      gitlabProjectPath: PROJECT,
      commitType: 'fix',
    };
    await store.setMeta(DELIVERY_CONTEXT_META_PREFIX + CODE, context);
  }

  if (options.lastNoteId !== undefined) {
    await store.setMeta(REVIEW_LAST_NOTE_META_PREFIX + CODE, { id: options.lastNoteId });
  }

  return {
    fixture,
    mock,
    domain,
    store,
    tokenStore,
    runner,
    lock,
    timer,
    git,
    service,
    branch,
  };
}

// ---------------------------------------------------------------------------
// Token / context guards
// ---------------------------------------------------------------------------

test('tick() is a silent no-op without a GitLab token (no requests, no writes)', async (t) => {
  const h = await createHarness(t, {
    tokenStore: createFakeTokenStore(null),
    notes: [note(1, CHANGES_BODY, '2026-11-07T04:00:10.000Z')],
  });
  const before = structuredClone(h.store.get(CODE));
  const result = await h.service.tick();

  assert.deepEqual(result, { checked: 0, transitioned: 0 });
  assert.equal(h.mock.requests.length, 0);
  assert.deepEqual(h.store.get(CODE), before);
  assert.equal(h.store.getMeta(REVIEW_ERROR_META_PREFIX + CODE), undefined);
  assert.equal(h.store.getMeta(REVIEW_LAST_NOTE_META_PREFIX + CODE), undefined);
  assert.equal(h.tokenStore.calls.get, 1);

  // A throwing credential read is treated exactly like a missing token.
  const throwing = await createHarness(t, {
    tokenStore: createFakeTokenStore(new Error('credentials unavailable')),
    notes: [note(2, CHANGES_BODY, '2026-11-07T04:00:10.000Z')],
  });
  const throwingBefore = structuredClone(throwing.store.get(CODE));
  assert.deepEqual(await throwing.service.tick(), { checked: 0, transitioned: 0 });
  assert.equal(throwing.mock.requests.length, 0);
  assert.deepEqual(throwing.store.get(CODE), throwingBefore);
});

test('a missing/invalid delivery context writes only the static review error', async (t) => {
  const missing = await createHarness(t, {
    context: null,
    notes: [note(10, PASS_BODY, '2026-11-07T04:00:10.000Z')],
  });
  const before = structuredClone(missing.store.get(CODE));
  const result = await missing.service.tick();

  assert.equal(result.transitioned, 0);
  assert.equal(missing.mock.requests.length, 0);
  // No workflow/state mutation: only the static error meta.
  assert.deepEqual(missing.store.get(CODE), before);
  assert.equal(
    missing.store.getMeta(REVIEW_ERROR_META_PREFIX + CODE),
    REVIEW_CONTEXT_MISSING_MESSAGE,
  );
  assert.deepEqual(missing.service.status(), {
    running: [],
    errors: { [CODE]: REVIEW_CONTEXT_MISSING_MESSAGE },
  });

  const invalid = await createHarness(t, {
    context: {
      sessionId: SESSION_ID,
      cwd: missing.fixture.repo,
      gitlabBaseUrl: '',
      gitlabProjectPath: PROJECT,
      commitType: 'fix',
    },
  });
  const invalidBefore = structuredClone(invalid.store.get(CODE));
  await invalid.service.tick();
  assert.deepEqual(invalid.store.get(CODE), invalidBefore);
  assert.equal(
    invalid.store.getMeta(REVIEW_ERROR_META_PREFIX + CODE),
    REVIEW_CONTEXT_MISSING_MESSAGE,
  );
});

test('a GitLab client construction failure writes a static error and skips the ticket', async (t) => {
  const h = await createHarness(t, {
    notes: [note(11, PASS_BODY, '2026-11-07T04:00:10.000Z')],
    gitlabClientFor: () => {
      throw new Error('invalid base url');
    },
  });
  const before = structuredClone(h.store.get(CODE));
  await h.service.tick();

  assert.equal(h.mock.requests.length, 0);
  assert.deepEqual(h.store.get(CODE), before);
  assert.equal(
    h.store.getMeta(REVIEW_ERROR_META_PREFIX + CODE),
    REVIEW_GITLAB_CONFIG_MESSAGE,
  );
});

// ---------------------------------------------------------------------------
// Review verdicts
// ---------------------------------------------------------------------------

test('a pass note transitions mr_open -> mergeable and records the MR verdict', async (t) => {
  const h = await createHarness(t, {
    notes: [note(20, PASS_BODY, '2026-11-07T04:00:10.000Z')],
  });

  const result = await h.service.tick();
  assert.equal(result.checked, 1);
  assert.equal(result.transitioned, 1);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'mergeable');
  assert.equal(ticket.mr.verdict, 'pass');
  assert.equal(ticket.mr.rounds, 0);
  assert.ok(ticket.timeline.some((event) => event.kind === 'review_pass'));
  const lastNote = h.store.getMeta(REVIEW_LAST_NOTE_META_PREFIX + CODE);
  assert.equal(lastNote.id, 20);
  assert.equal(lastNote.verdict, 'pass');
  assert.equal(typeof lastNote.at, 'string');
  assert.deepEqual(h.service.status(), { running: [], errors: {} });
  // Only the MR state + notes were read; nothing was written to GitLab.
  assert.deepEqual(
    h.mock.requests.map((request) => request.method),
    ['GET', 'GET'],
  );
  assert.match(h.mock.requests[1].path, /\/notes$/);
  assert.equal(h.mock.requests[1].query.sort, 'desc');
});

test('a changes note starts ONE review-fix run: host commit + push, ledger append, review_fix_done', async (t) => {
  const h = await createHarness(t, {
    notes: [note(30, CHANGES_BODY, '2026-11-07T04:00:10.000Z')],
  });
  const mainHeadBefore = gitSync(h.fixture.repo, ['rev-parse', 'HEAD']);
  const branchHeadBefore = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);
  const expected = parseReview(CHANGES_BODY);

  const result = await h.service.tick();
  assert.equal(result.transitioned, 1);
  // The transition is applied BEFORE the background job and rounds is exactly 1.
  let ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'fixing_review');
  assert.equal(ticket.mr.rounds, 1);
  assert.equal(ticket.mr.verdict, 'changes');
  assert.deepEqual(ticket.mr.blockingIssues, expected.blocking);
  assert.deepEqual(ticket.mr.nonBlockingIssues, expected.nonBlocking);
  assert.ok(ticket.timeline.some((event) => event.kind === 'review_requests_changes'));

  // The runner receives exactly the parsed findings, the delivery session and
  // the ticket worktree as its cwd.
  await waitFor(() => h.runner.calls.length === 1, 'review-fix runner call');
  const input = h.runner.calls[0];
  assert.equal(input.sessionId, SESSION_ID);
  assert.equal(input.worktreePath, h.fixture.worktree);
  assert.equal(input.ticket.code, CODE);
  assert.equal(input.mr.iid, MR.iid);
  assert.deepEqual(input.findings.blocking, expected.blocking);
  assert.deepEqual(input.findings.nonBlocking, expected.nonBlocking);
  assert.equal(input.findings.blocking.length, 1);
  assert.equal(input.findings.nonBlocking.length, 1);
  assert.match(input.findings.blocking[0].problem, /登录按钮/);
  assert.ok(input.signal instanceof AbortSignal);

  await waitForIdle(h.service);
  ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'mr_open');
  // review_requests_changes already incremented; review_fix_done must NOT.
  assert.equal(ticket.mr.rounds, 1);
  assert.equal(ticket.mr.state, 'opened');

  // 1. Host commit on the personal branch with the team message template.
  const message = gitSync(h.fixture.worktree, ['log', '-1', '--format=%B']);
  assert.equal(message, `fix: 【jira单号】：${CODE}，【开发内容】：${PLAN.summary}`);
  const sha = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);
  assert.notEqual(sha, branchHeadBefore);
  assert.equal(gitSync(h.fixture.worktree, ['status', '--porcelain']), '');
  // The main worktree was never touched.
  assert.equal(gitSync(h.fixture.repo, ['rev-parse', 'HEAD']), mainHeadBefore);
  assert.equal(gitSync(h.fixture.repo, ['status', '--porcelain']), '?? .dsh-worktrees/');

  // 2. Push landed on the local bare origin.
  assert.equal(bareRef(h.fixture.origin, `refs/heads/${BRANCH.name}`), sha);

  // 3. fixes[] entry: one succeeded run with the bounded metadata.
  assert.equal(ticket.fixes.length, 1);
  const fixEntry = ticket.fixes[0];
  assert.equal(fixEntry.status, 'succeeded');
  assert.equal(typeof fixEntry.runId, 'string');
  assert.equal(fixEntry.childId, 'child-1');
  assert.equal(fixEntry.elapsedMs, 12);
  assert.deepEqual(fixEntry.changedFiles, ['readme.md']);
  assert.equal(typeof fixEntry.summary, 'string');
  assert.match(fixEntry.summary, /修复第 1 轮/);
  assert.equal(fixEntry.testResult, '相关单测通过');
  assert.ok(fixEntry.diff.includes('fixed by review round 1'));
  assert.ok(fixEntry.diff.length <= 4_000);

  // 4. reviewRounds[] entry: round 1, changes, succeeded.
  assert.equal(ticket.reviewRounds.length, 1);
  const roundEntry = ticket.reviewRounds[0];
  assert.equal(roundEntry.round, 1);
  assert.equal(roundEntry.noteId, 30);
  assert.equal(roundEntry.verdict, 'changes');
  assert.equal(roundEntry.status, 'succeeded');
  assert.equal(roundEntry.childId, 'child-1');
  assert.deepEqual(roundEntry.changedFiles, ['readme.md']);
  assert.equal(typeof roundEntry.startedAt, 'string');
  assert.equal(typeof roundEntry.finishedAt, 'string');

  // 5. Mr rounds is NOT double-incremented and the last note is recorded once.
  assert.equal(ticket.mr.rounds, 1);
  assert.equal(h.store.getMeta(REVIEW_LAST_NOTE_META_PREFIX + CODE).id, 30);
  assert.equal(h.store.getMeta(REVIEW_ERROR_META_PREFIX + CODE), null);
  assert.deepEqual(h.service.status(), { running: [], errors: {} });
});

test('a second changes note runs round 2 and keeps mr.rounds in step', async (t) => {
  const h = await createHarness(t, {
    notes: [note(40, CHANGES_BODY, '2026-11-07T04:00:10.000Z')],
  });

  await h.service.tick();
  await waitForIdle(h.service);
  assert.equal(h.store.get(CODE).mr.rounds, 1);

  h.mock.state.notes.push(note(41, CHANGES_BODY, '2026-11-07T04:00:20.000Z'));
  const second = await h.service.tick();
  assert.equal(second.transitioned, 1);
  assert.equal(h.store.get(CODE).workflow, 'fixing_review');
  assert.equal(h.store.get(CODE).mr.rounds, 2);

  await waitForIdle(h.service);
  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'mr_open');
  assert.equal(ticket.mr.rounds, 2);
  assert.equal(ticket.reviewRounds.length, 2);
  assert.deepEqual(ticket.reviewRounds.map((entry) => entry.round), [1, 2]);
  assert.deepEqual(ticket.reviewRounds.map((entry) => entry.noteId), [40, 41]);
  assert.equal(ticket.fixes.length, 2);
  assert.equal(h.runner.calls.length, 2);
  // Two host commits, both pushed.
  assert.match(gitSync(h.fixture.worktree, ['log', '-1', '--format=%B']), /【jira单号】：BUG-1/);
  assert.equal(
    bareRef(h.fixture.origin, `refs/heads/${BRANCH.name}`),
    gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']),
  );
});

test('a 4th changes request at the 3-round cap blocks with review-rounds-exhausted', async (t) => {
  const h = await createHarness(t, {
    rounds: 3,
    reviewRounds: [1, 2, 3].map((round) => reviewRoundEntry({ round, noteId: `n${round}` })),
    notes: [note(50, CHANGES_BODY, '2026-11-07T04:00:10.000Z')],
  });
  const headBefore = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);

  const result = await h.service.tick();
  assert.equal(result.transitioned, 1);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedFrom, 'mr_open');
  assert.equal(ticket.blockedReason, 'review-rounds-exhausted');
  assert.equal(ticket.mr.rounds, 3);
  assert.equal(h.runner.calls.length, 0);
  assert.equal(gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(bareHasBranch(h.fixture.origin, BRANCH.name), false);
  assert.equal(
    h.store.getMeta(REVIEW_ERROR_META_PREFIX + CODE),
    REVIEW_REASON_MESSAGES['review-rounds-exhausted'],
  );
});

test('template drift (unknown verdict) blocks review-parse-failed and does not auto-retry', async (t) => {
  // `需要修改` with no parsable item is exactly the template-drift shape.
  const driftBody = [
    '## AI Code Review',
    '',
    '结论: **需要修改**',
    '',
    '历史未收敛: `0` 条',
    '',
    '### 需要关注的问题',
    '格式已经改变，没有条目列表。',
    '',
  ].join('\n');
  assert.equal(parseReview(driftBody).verdict, 'unknown');

  const h = await createHarness(t, {
    notes: [note(55, driftBody, '2026-11-07T04:00:10.000Z')],
  });
  const result = await h.service.tick();
  assert.equal(result.transitioned, 1);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedFrom, 'mr_open');
  assert.equal(ticket.blockedReason, 'review-parse-failed');
  assert.equal(h.runner.calls.length, 0);
  assert.equal(
    h.store.getMeta(REVIEW_ERROR_META_PREFIX + CODE),
    REVIEW_REASON_MESSAGES['review-parse-failed'],
  );

  // The ticket is no longer pollable: a repeated tick performs no GitLab
  // request and cannot rewrite anything.
  const requestsBefore = h.mock.requests.length;
  const blocked = structuredClone(h.store.get(CODE));
  const again = await h.service.tick();
  assert.deepEqual(again, { checked: 0, transitioned: 0 });
  assert.equal(h.mock.requests.length, requestsBefore);
  assert.deepEqual(h.store.get(CODE), blocked);
});

test('non-AI notes, other bots and system notes are filtered before the latest-note pick', async (t) => {
  const h = await createHarness(t, {
    notes: [
      // Newest, but not an AI review at all.
      note(60, '## Sensitive Content Gate\n\n结论: 需要修改\n', '2026-11-07T04:00:30.000Z'),
      // AI marker without a 结论 line: not a review.
      note(61, '## AI Code Review\n\n摘要: 正在分析，暂无结论。\n', '2026-11-07T04:00:20.000Z'),
      // A system note carrying both markers is still not a user review.
      {
        id: 62,
        body: PASS_BODY,
        createdAt: '2026-11-07T04:00:25.000Z',
        authorUsername: 'gitlab',
        system: true,
      },
    ],
  });

  await h.service.tick();
  assert.equal(h.store.get(CODE).workflow, 'mr_open');
  assert.equal(h.runner.calls.length, 0);
  assert.equal(h.store.getMeta(REVIEW_LAST_NOTE_META_PREFIX + CODE), undefined);

  // An OLDER genuine AI pass note still wins over newer non-AI chatter: the
  // filter runs first, then recency among AI notes only.
  h.mock.state.notes.push(note(63, PASS_BODY, '2026-11-07T04:00:05.000Z'));
  await h.service.tick();
  assert.equal(h.store.get(CODE).workflow, 'mergeable');

  assert.equal(pickLatestAiNote(h.mock.state.notes).id, 63);
});

test('the hidden statistics block never reaches the review-fix child or its prompt', async (t) => {
  assert.ok(CHANGES_BODY_WITH_HIDDEN.includes(HIDDEN_MARKER_TEXT));
  const h = await createHarness(t, {
    notes: [note(70, CHANGES_BODY_WITH_HIDDEN, '2026-11-07T04:00:10.000Z')],
  });

  await h.service.tick();
  await waitFor(() => h.runner.calls.length === 1, 'review-fix runner call');
  await waitForIdle(h.service);

  const input = h.runner.calls[0];
  const serializedFindings = JSON.stringify(input.findings);
  for (const secret of [HIDDEN_MARKER_TEXT, 'AI_REVIEW_FINDINGS', '以下隐藏数据']) {
    assert.equal(serializedFindings.includes(secret), false);
  }
  assert.equal(input.ticket.title.includes(HIDDEN_MARKER_TEXT), false);

  const prompt = buildReviewFixPrompt({
    ticket: input.ticket,
    plan: input.plan,
    mr: input.mr,
    findings: input.findings,
    worktreePath: input.worktreePath,
  });
  for (const secret of [HIDDEN_MARKER_TEXT, 'AI_REVIEW_FINDINGS', '以下隐藏数据']) {
    assert.equal(prompt.includes(secret), false);
  }
  // Sanity: the genuine blocking finding is in the prompt.
  assert.match(prompt, /登录按钮/);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'mr_open');
  assert.equal(ticket.fixes.length, 1);
});

test('the same note id never triggers a second fix (dedupe by note id)', async (t) => {
  const h = await createHarness(t, {
    lastNoteId: 80,
    notes: [note(80, CHANGES_BODY, '2026-11-07T04:00:10.000Z')],
  });
  const before = structuredClone(h.store.get(CODE));

  const result = await h.service.tick();
  assert.equal(result.checked, 1);
  assert.equal(result.transitioned, 0);
  assert.equal(h.runner.calls.length, 0);
  assert.deepEqual(h.store.get(CODE), before);
  // The note list was fetched (it is the newest AI note) but nothing else ran.
  assert.deepEqual(
    h.mock.requests.map((request) => request.method),
    ['GET', 'GET'],
  );
});

// ---------------------------------------------------------------------------
// Merge detection / auto-archive
// ---------------------------------------------------------------------------

test('mergeable + merged -> merged, then the next tick auto-dismisses to done', async (t) => {
  const h = await createHarness(t, {
    workflow: 'mergeable',
    mrState: 'opened',
  });

  // Still open: mergeable is merge-detection-only, no note handling.
  assert.deepEqual(await h.service.tick(), { checked: 1, transitioned: 0 });
  assert.equal(h.store.get(CODE).workflow, 'mergeable');
  assert.equal(h.mock.requests.filter((request) => request.path.endsWith('/notes')).length, 0);

  h.mock.state.mrState = 'merged';
  const mergedTick = await h.service.tick();
  assert.equal(mergedTick.transitioned, 1);
  let ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'merged');
  assert.equal(ticket.mr.state, 'merged');

  const archiveTick = await h.service.tick();
  assert.equal(archiveTick.transitioned, 1);
  ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'done');
  const dismiss = ticket.timeline.find((event) => event.kind === 'dismiss');
  assert.equal(dismiss.actor, 'system');

  // `done` is terminal and no longer pollable.
  const requestsBefore = h.mock.requests.length;
  assert.deepEqual(await h.service.tick(), { checked: 0, transitioned: 0 });
  assert.equal(h.mock.requests.length, requestsBefore);
});

test('an MR merged while still in mr_open blocks review-merged-manually (no fake review pass)', async (t) => {
  const h = await createHarness(t, {
    mrState: 'merged',
    notes: [note(85, PASS_BODY, '2026-11-07T04:00:10.000Z')],
  });
  const headBefore = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);

  const result = await h.service.tick();
  assert.equal(result.transitioned, 1);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedFrom, 'mr_open');
  assert.equal(ticket.blockedReason, 'review-merged-manually');
  assert.notEqual(ticket.mr.verdict, 'pass');
  assert.equal(h.runner.calls.length, 0);
  assert.equal(gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(
    h.store.getMeta(REVIEW_ERROR_META_PREFIX + CODE),
    REVIEW_REASON_MESSAGES['review-merged-manually'],
  );
  // Merge detection happens first: no notes request was made.
  assert.deepEqual(
    h.mock.requests.map((request) => request.method),
    ['GET'],
  );
});

// ---------------------------------------------------------------------------
// Review-fix failure paths
// ---------------------------------------------------------------------------

test('a failed review-fix run blocks review-fix-failed without commit/push', async (t) => {
  const h = await createHarness(t, {
    notes: [note(90, CHANGES_BODY, '2026-11-07T04:00:10.000Z')],
    runner: createFakeRunner(() => ({
      ok: false,
      code: 'analysis-failed',
      message: 'child failed',
    })),
  });
  const branchHeadBefore = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);

  await h.service.tick();
  await waitForIdle(h.service);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedFrom, 'fixing_review');
  assert.equal(ticket.blockedReason, 'review-fix-failed');
  assert.ok(ticket.blockedReason !== 'review-fix-timeout');
  assert.equal(h.runner.calls.length, 1);
  assert.equal(gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']), branchHeadBefore);
  assert.equal(bareHasBranch(h.fixture.origin, BRANCH.name), false);
  assert.equal(ticket.fixes.length, 0);
  assert.equal(ticket.reviewRounds.length, 0);
  assert.equal(
    h.store.getMeta(REVIEW_ERROR_META_PREFIX + CODE),
    REVIEW_REASON_MESSAGES['review-fix-failed'],
  );
});

test('a successful child that changed nothing blocks review-fix-no-changes', async (t) => {
  const h = await createHarness(t, {
    notes: [note(95, CHANGES_BODY, '2026-11-07T04:00:10.000Z')],
    // The child reports success but the host sees a clean worktree.
    runner: createFakeRunner(() => ({
      ok: true,
      result: { summary: '什么都没改', changedFiles: [], testResult: '', notes: '' },
      childId: 'child-empty',
      elapsedMs: 3,
    })),
  });
  const branchHeadBefore = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);

  await h.service.tick();
  await waitForIdle(h.service);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedFrom, 'fixing_review');
  assert.equal(ticket.blockedReason, 'review-fix-no-changes');
  assert.equal(gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']), branchHeadBefore);
  assert.equal(bareHasBranch(h.fixture.origin, BRANCH.name), false);
  assert.equal(ticket.fixes.length, 0);
  assert.equal(
    h.store.getMeta(REVIEW_ERROR_META_PREFIX + CODE),
    REVIEW_REASON_MESSAGES['review-fix-no-changes'],
  );
});

test('an unregistered/unrelated worktree blocks review-fix-failed before any git write', async (t) => {
  // Create the harness first so the fixture exists, then point the branch at a
  // plain directory inside the repository (NOT a registered worktree).
  const h = await createHarness(t, {
    notes: [note(97, CHANGES_BODY, '2026-11-07T04:00:10.000Z')],
  });
  const plain = join(h.fixture.repo, 'plain-dir');
  mkdirSync(plain);
  // Mutate the persisted branch metadata directly: the worktree path is stored
  // metadata, and the service must never trust it as proof.
  const ticket = h.store.get(CODE);
  ticket.branch = { ...ticket.branch, worktree: plain };
  await h.domain.table('tickets').put(CODE, ticket);
  const branchHeadBefore = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);

  await h.service.tick();
  await waitForIdle(h.service);

  const after = h.store.get(CODE);
  assert.equal(after.workflow, 'blocked');
  assert.equal(after.blockedFrom, 'fixing_review');
  assert.equal(after.blockedReason, 'review-fix-failed');
  assert.equal(h.runner.calls.length, 0);
  assert.equal(gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']), branchHeadBefore);
  assert.equal(bareHasBranch(h.fixture.origin, BRANCH.name), false);
});

// ---------------------------------------------------------------------------
// Lifecycle: dispose / timer / single-flight
// ---------------------------------------------------------------------------

test('dispose() aborts an in-flight review-fix job without writing any state', async (t) => {
  const gate = deferred();
  const h = await createHarness(t, {
    notes: [note(100, CHANGES_BODY, '2026-11-07T04:00:10.000Z')],
    runner: createFakeRunner(() => gate.promise),
  });
  h.service.start(h.timer);
  const branchHeadBefore = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);

  await h.service.tick();
  assert.equal(h.store.get(CODE).workflow, 'fixing_review');
  await waitFor(() => h.runner.calls.length === 1, 'review-fix runner call');
  assert.deepEqual(h.service.status().running, [CODE]);

  const disposing = h.service.dispose();
  // Let the aborted job observe cancellation and settle.
  gate.resolve({
    ok: true,
    result: { summary: 'late result', changedFiles: ['readme.md'], testResult: '', notes: '' },
    childId: 'child-late',
    elapsedMs: 1,
  });
  await disposing;
  await settle();

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'fixing_review');
  assert.equal(ticket.fixes.length, 0);
  assert.equal(ticket.reviewRounds.length, 0);
  // The changes round cleared the error slot before the job started; the
  // disposed job must not add a block/error afterwards.
  assert.equal(h.store.getMeta(REVIEW_ERROR_META_PREFIX + CODE), null);
  assert.equal(h.store.getMeta(REVIEW_LAST_NOTE_META_PREFIX + CODE).id, 100);
  assert.equal(gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']), branchHeadBefore);
  assert.equal(h.timer.intervals[0].cleared, true);
  assert.deepEqual(h.service.status().running, []);
});

test('start(timer) registers one 60 s interval; dispose clears it and stops polling', async (t) => {
  const h = await createHarness(t, {
    notes: [note(110, PASS_BODY, '2026-11-07T04:00:10.000Z')],
  });

  assert.equal(h.service.start(h.timer), true);
  assert.equal(h.service.start(h.timer), true); // idempotent
  assert.equal(h.timer.intervals.length, 1);
  assert.equal(h.timer.intervals[0].delay, 60_000);

  // The interval callback drives a real tick.
  h.timer.intervals[0].callback();
  await waitFor(() => h.store.get(CODE).workflow === 'mergeable', 'timer-driven pass');
  assert.equal(h.mock.requests.length, 2);

  await h.service.dispose();
  assert.equal(h.timer.intervals[0].cleared, true);
  const requestsAfterDispose = h.mock.requests.length;
  h.timer.intervals[0].callback();
  await settle();
  assert.equal(h.mock.requests.length, requestsAfterDispose);
  assert.equal(h.store.get(CODE).workflow, 'mergeable');
});

test('concurrent ticks are single-flight and the shared repo lock is released', async (t) => {
  const h = await createHarness(t, {
    notes: [note(120, CHANGES_BODY, '2026-11-07T04:00:10.000Z')],
  });

  const first = h.service.tick();
  const second = h.service.tick();
  assert.equal(first, second); // the second call joins the running tick
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);

  await waitForIdle(h.service);

  // One fix run, one notes fetch, one lock acquire/release with the service
  // owner namespace.
  assert.equal(h.runner.calls.length, 1);
  assert.equal(
    h.mock.requests.filter((request) => request.path.endsWith('/notes')).length,
    1,
  );
  const repo = await h.git.repoRoot(h.fixture.repo);
  assert.deepEqual(h.lock.acquires, [{ repo, owner: `review:${CODE}` }]);
  assert.deepEqual(h.lock.releases, [{ repo, owner: `review:${CODE}` }]);
  assert.equal(h.lock.owners.size, 0);
  assert.equal(h.store.get(CODE).workflow, 'mr_open');
  assert.equal(h.store.get(CODE).mr.rounds, 1);
});

test('a busy repository lock postpones the fix round without mutating the ticket', async (t) => {
  const h = await createHarness(t, {
    notes: [note(125, CHANGES_BODY, '2026-11-07T04:00:10.000Z')],
  });
  const repo = await h.git.repoRoot(h.fixture.repo);
  assert.equal(h.lock.acquire(repo, 'delivery:BUG-OTHER'), true);

  const result = await h.service.tick();
  assert.deepEqual(result, { checked: 1, transitioned: 0 });
  assert.equal(h.store.get(CODE).workflow, 'mr_open');
  assert.equal(h.store.get(CODE).mr.rounds, 0);
  assert.equal(h.runner.calls.length, 0);
  // The note was NOT recorded: the next tick can still process it.
  assert.equal(h.store.getMeta(REVIEW_LAST_NOTE_META_PREFIX + CODE), undefined);

  h.lock.release(repo, 'delivery:BUG-OTHER');
  const retried = await h.service.tick();
  assert.equal(retried.transitioned, 1);
  await waitForIdle(h.service);
  assert.equal(h.store.get(CODE).mr.rounds, 1);
  assert.equal(h.runner.calls.length, 1);
});

test('status() exposes running review-fix jobs and persisted review errors', async (t) => {
  const gate = deferred();
  const runningHarness = await createHarness(t, {
    notes: [note(130, CHANGES_BODY, '2026-11-07T04:00:10.000Z')],
    runner: createFakeRunner(() => gate.promise),
  });
  await runningHarness.service.tick();
  await waitFor(() => runningHarness.runner.calls.length === 1, 'runner started');
  assert.deepEqual(runningHarness.service.status(), { running: [CODE], errors: {} });

  gate.resolve({ ok: false, code: 'analysis-failed', message: 'boom' });
  await runningHarness.service.dispose();
  await settle();

  const errorHarness = await createHarness(t, { context: null });
  await errorHarness.service.tick();
  assert.deepEqual(errorHarness.service.status(), {
    running: [],
    errors: { [CODE]: REVIEW_CONTEXT_MISSING_MESSAGE },
  });
});

test('the host commit uses the commitType persisted in the delivery context', async (t) => {
  const h = await createHarness(t, {
    notes: [note(140, CHANGES_BODY, '2026-11-07T04:00:10.000Z')],
  });
  // Rewrite the context with `commitType:'feat'` (as a workspace setting would)
  // while keeping the reachable mock URL, then run a changes round.
  await h.store.setMeta(DELIVERY_CONTEXT_META_PREFIX + CODE, {
    sessionId: SESSION_ID,
    cwd: h.fixture.repo,
    gitlabBaseUrl: h.mock.url,
    gitlabProjectPath: PROJECT,
    commitType: 'feat',
  });

  await h.service.tick();
  await waitForIdle(h.service);

  assert.equal(
    gitSync(h.fixture.worktree, ['log', '-1', '--format=%B']),
    `feat: 【jira单号】：${CODE}，【开发内容】：${PLAN.summary}`,
  );
});
