/**
 * Unit/integration tests for the P5 delivery orchestration service.
 *
 * The service is driven end-to-end over REAL local resources:
 *
 *   - a throwaway git repository plus a local BARE `origin` (no network);
 *   - the real `createGit()` executor;
 *   - the real `createStore()` over an in-memory fake storage domain;
 *   - a loopback-only mock GitLab HTTP server reached through the real
 *     `createGitlabClient()`;
 *   - an injected `execCommand` double for lint/test (no real npm).
 *
 * Coverage maps to the P5 Task 3 brief: full success path (commit message,
 * push/upstream, MR title/description/body), lint/test failure blocks BEFORE
 * any commit/push and writes only the delivery error namespace, missing
 * token/settings/worktree/branch/invalid workflow with zero writes, existing
 * MR reuse, push failure, duplicate/same-repo single-flight, cancellation via
 * `dispose()`, and a late `mr_created` that must not regress a moved ticket.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DELIVERY_COMMIT_META_PREFIX,
  DELIVERY_CONTEXT_META_PREFIX,
  DELIVERY_ERROR_META_PREFIX,
  DELIVERY_REASON_MESSAGES,
  DELIVERY_STALE_MESSAGE,
  DELIVERY_START_MESSAGES,
  buildCheckNote,
  buildCommitMessage,
  buildDescription,
  buildSkippedCheckMessage,
  createDeliveryService,
  createShellExecCommand,
} from '../src/host/delivery-service.js';
import { createGit } from '../src/host/git.js';
import { createGitlabClient } from '../src/host/gitlab.js';
import { createStore } from '../src/host/store.js';
import { initialTicket } from '../src/host/state-machine.js';
import { TICKET_WORKSPACE_META_PREFIX } from '../src/host/workspace.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-live-1';
const CODE = 'BUG-1';
const STORE_TIME = '2026-11-07T00:00:01.000Z';
const TOKEN = 'glpat-delivery-test-token';
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

const TICKET_URL = 'https://platform.example.com/issues/1';

const GIT_CONFIG = Object.freeze([
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.autocrlf=false',
  '-c',
  'user.name=P5 Delivery Test',
  '-c',
  'user.email=p5-delivery@example.invalid',
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
  const root = mkdtempSync(join(tmpdir(), 'dsh-bw-delivery-'));
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

/** Monotonic ISO clock for the service's action ids. */
function createServiceClock() {
  let tick = 0;
  return () => `2026-11-07T04:00:${String(tick++).padStart(2, '0')}.000Z`;
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

/** Tick macrotasks until the service has no running delivery (bounded). */
async function waitForIdle(service, limit = 4_000) {
  for (let index = 0; index < limit; index += 1) {
    if (service.status().running.length === 0) return;
    // Real loopback HTTP + git child processes need I/O turns, not just
    // microtasks; a 1 ms timer lets the event loop poll.
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('delivery job did not settle');
}

/** Tick macrotasks until `predicate()` is true (bounded). */
async function waitFor(predicate, label, limit = 4_000) {
  for (let index = 0; index < limit; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Fake GitLab token store; delivery only consumes `get()`. */
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

/** Fake lint/test executor; every call is recorded. */
function createFakeExec({ results = {}, onCall } = {}) {
  const calls = [];
  async function exec(command, options) {
    calls.push({ command, options });
    if (typeof onCall === 'function') {
      const override = await onCall(command, options, calls.length);
      if (override !== undefined) return override;
    }
    const result = results[command];
    if (typeof result === 'function') return result(command, options);
    return result ?? { ok: true, output: '' };
  }
  return { calls, exec };
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
 * Loopback-only mock GitLab supporting exactly the two MR endpoints the
 * delivery service uses. Requests are captured (auth header redacted) so a
 * test can assert the request body/title/description and that no create
 * happened.
 */
async function createMockGitlab(options = {}) {
  const token = options.token ?? TOKEN;
  const requests = [];

  const server = createServer((request, response) => {
    response.on('error', () => {});
    void handle(request, response).catch(() => sendJson(response, 500, { message: 'mock error' }));
  });

  async function handle(request, response) {
    const url = new URL(request.url ?? '/', 'http://mock.local');
    const raw = await readRequestBody(request);
    let body;
    if (raw.trim() !== '') {
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
    }
    const record = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { ...request.headers, 'private-token': 'REDACTED' },
      body,
    };
    requests.push(record);

    if (request.headers['private-token'] !== token) {
      sendJson(response, 401, { message: '401 Unauthorized' });
      return;
    }

    if (!url.pathname.endsWith('/merge_requests')) {
      sendJson(response, 404, { message: '404 Not Found' });
      return;
    }

    if (request.method === 'GET') {
      sendJson(response, 200, options.openMergeRequests ?? []);
      return;
    }
    if (request.method !== 'POST') {
      sendJson(response, 404, { message: '404 Not Found' });
      return;
    }

    if (typeof options.onCreate === 'function') await options.onCreate(record);
    sendJson(response, 201, options.createdMergeRequest ?? {
      iid: 77,
      web_url: 'https://gitlab.example.com/group/project/-/merge_requests/77',
      state: 'opened',
      source_branch: BRANCH.name,
      target_branch: BRANCH.target,
      title: `${BRANCH.name} -> ${BRANCH.target}`,
    });
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
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** Seed a raw persisted ticket in the requested workflow. */
async function seedTicket(domain, {
  code = CODE,
  workflow = 'submitting',
  plan = PLAN,
  branch = BRANCH,
  url = TICKET_URL,
  title = '登录按钮无响应',
} = {}) {
  const ticket = initialTicket({ code, title, url }, STORE_TIME);
  ticket.workflow = workflow;
  ticket.plan = plan === null ? null : cloneJson(plan);
  ticket.branch = branch === null ? null : cloneJson(branch);
  ticket.updatedAt = STORE_TIME;
  await domain.table('tickets').put(code, ticket);
  return ticket;
}

/**
 * Full harness: real git fixture + real store + loopback mock + service.
 * Cleanup is registered on the test context.
 */
async function createHarness(t, options = {}) {
  const fixture = options.fixture ?? createRepoFixture({
    branchName: options.fixtureBranch ?? BRANCH.name,
  });
  const mock = await createMockGitlab(options.mock ?? {});
  const domain = createFakeDomain();
  const store = createStore(domain, () => STORE_TIME);
  const tokenStore = options.tokenStore ?? createFakeTokenStore();
  const exec = options.exec ?? createFakeExec();
  const git = options.git ?? createGit();

  const gitlabClientFor = options.gitlabClientFor ?? ((settings) => createGitlabClient({
    baseUrl: settings.gitlabBaseUrl,
    tokenProvider: () => tokenStore.get(),
  }));

  const service = createDeliveryService({
    store,
    git,
    tokenStore,
    gitlabClientFor,
    clock: createServiceClock(),
    execCommand: options.execCommand ?? exec.exec,
    ...(options.commandTimeoutMs === undefined
      ? {}
      : { commandTimeoutMs: options.commandTimeoutMs }),
    drainTimeoutMs: options.drainTimeoutMs ?? 100,
    ...(options.lock === undefined ? {} : { lock: options.lock }),
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

  // A delivery needs a changed worktree (the fix subagent is what edits code).
  // Tests that assert `delivery-no-changes` simply leave `dirty` off.
  if (options.dirty === true) {
    writeFileSync(join(fixture.worktree, 'readme.md'), 'hello\nfixed by AI\n');
    writeFileSync(join(fixture.worktree, 'fix-note.txt'), 'new file from the fix run\n');
  }

  if (options.seed !== false) {
    await seedTicket(domain, {
      code: options.code ?? CODE,
      workflow: options.workflow ?? 'submitting',
      plan: options.plan === undefined ? PLAN : options.plan,
      branch,
      url: options.url === undefined ? TICKET_URL : options.url,
      title: options.title,
    });
  }

  const waitCommands = options.waitForCommands ?? 30;
  await store.putSettings(fixture.repo, {
    gitlabBaseUrl: mock.url,
    gitlabProjectPath: PROJECT,
    lintCommand: 'npm run lint',
    testCommand: 'npm test',
    commitType: 'fix',
    branchUser: 'ly',
    ...options.settings,
  });

  return {
    fixture,
    mock,
    domain,
    store,
    tokenStore,
    exec,
    git,
    service,
    branch,
    waitCommands,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test('start() runs lint/test, commits locally, pushes and creates the MR end-to-end', async (t) => {
  const h = await createHarness(t, { dirty: true });
  const repoHeadBefore = gitSync(h.fixture.repo, ['rev-parse', 'HEAD']);
  const before = structuredClone(h.store.get(CODE));

  const result = await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  assert.deepEqual(result, { ok: true, running: true });
  await waitForIdle(h.service);

  // 1. lint + test run INSIDE the worktree with the 5-minute budget.
  assert.deepEqual(h.exec.calls.map((call) => call.command), ['npm run lint', 'npm test']);
  for (const call of h.exec.calls) {
    assert.equal(call.options.cwd, h.fixture.worktree);
    assert.equal(call.options.timeoutMs, 300_000);
  }

  // 2. Exactly the team commit template; worktree clean; main repo untouched.
  const message = gitSync(h.fixture.worktree, ['log', '-1', '--format=%B']);
  assert.equal(message, `fix: 【jira单号】：${CODE}，【开发内容】：${PLAN.summary}`);
  assert.equal(gitSync(h.fixture.worktree, ['status', '--porcelain']), '');
  const sha = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(gitSync(h.fixture.repo, ['rev-parse', 'HEAD']), repoHeadBefore);
  // The only main-repo change is the untracked product worktree directory; the
  // fix/delivery work never leaks into the main working tree.
  assert.equal(gitSync(h.fixture.repo, ['status', '--porcelain']), '?? .dsh-worktrees/');

  // 3. Push landed on the local bare origin with upstream tracking.
  assert.equal(bareRef(h.fixture.origin, `refs/heads/${BRANCH.name}`), sha);
  assert.equal(
    gitSync(h.fixture.worktree, ['rev-parse', '--abbrev-ref', '@{upstream}']),
    `origin/${BRANCH.name}`,
  );

  // 4. Exactly one createMergeRequest with the contracted payload.
  const creates = h.mock.requests.filter((request) => request.method === 'POST');
  assert.equal(creates.length, 1);
  const create = creates[0];
  assert.equal(create.path, `/api/v4/projects/group%2Fproject/merge_requests`);
  assert.deepEqual(create.body, {
    source_branch: BRANCH.name,
    target_branch: BRANCH.target,
    title: `${BRANCH.name} -> ${BRANCH.target}`,
    description: [
      `工单：${TICKET_URL}`,
      `方案摘要：${PLAN.summary}`,
      '提交前检查：lint 已通过，test 已通过',
      `提交：${sha}`,
    ].join('\n'),
    remove_source_branch: false,
  });
  assert.equal(Object.hasOwn(create.body, 'reviewer_ids'), false);
  assert.equal(create.headers['private-token'], 'REDACTED');

  // 5. Ticket is `mr_open` with the persisted MR metadata + empty round ledger.
  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'mr_open');
  assert.deepEqual(ticket.mr, {
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
  assert.deepEqual(ticket.reviewRounds, []);
  assert.ok(ticket.timeline.some((event) => event.kind === 'submit_mr'));
  assert.ok(ticket.timeline.some((event) => event.kind === 'mr_created'));
  assert.notDeepEqual(before.mr, ticket.mr);

  // 6. No delivery error, no fix-error namespace leakage, service idle.
  assert.deepEqual(h.service.status(), { running: [], errors: {} });
  // Success clears the delivery error (meta value null), never creates one.
  assert.equal(h.store.getMeta(`${DELIVERY_ERROR_META_PREFIX}${CODE}`), null);
  assert.equal(h.store.getMeta(`fix.error:${CODE}`), undefined);

  // 7. The review context is persisted for the timer-driven review service:
  // exactly the session/workspace/GitLab settings it needs to rebuild its
  // client, and NEVER the GitLab token.
  const context = h.store.getMeta(`${DELIVERY_CONTEXT_META_PREFIX}${CODE}`);
  assert.deepEqual(context, {
    sessionId: SESSION_ID,
    cwd: h.fixture.repo,
    gitlabBaseUrl: h.mock.url,
    gitlabProjectPath: PROJECT,
    commitType: 'fix',
  });
  assert.deepEqual(
    Object.keys(context).sort(),
    ['commitType', 'cwd', 'gitlabBaseUrl', 'gitlabProjectPath', 'sessionId'],
  );
  assert.equal(JSON.stringify(context).includes(TOKEN), false);
});

test('an existing open MR is reused and no second MR is created', async (t) => {
  const existing = {
    iid: 5,
    web_url: 'https://gitlab.example.com/group/project/-/merge_requests/5',
    state: 'opened',
    source_branch: BRANCH.name,
    target_branch: BRANCH.target,
    title: `${BRANCH.name} -> ${BRANCH.target}`,
  };
  const h = await createHarness(t, { dirty: true, mock: { openMergeRequests: [existing] } });

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);

  assert.equal(h.mock.requests.filter((request) => request.method === 'POST').length, 0);
  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'mr_open');
  assert.equal(ticket.mr.iid, 5);
  assert.equal(ticket.mr.url, existing.web_url);
  // The commit/push still happened before the reuse decision.
  assert.equal(bareHasBranch(h.fixture.origin, BRANCH.name), true);
});

test('empty lint/test commands are skipped and recorded in the timeline/MR note', async (t) => {
  const h = await createHarness(t, {
    dirty: true,
    settings: { lintCommand: '', testCommand: '' },
  });

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);

  assert.deepEqual(h.exec.calls, []);
  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'mr_open');
  const submit = ticket.timeline.find((event) => event.kind === 'submit_mr');
  assert.equal(submit.message, '提交 MR（未配置 lint/test）');

  const create = h.mock.requests.find((request) => request.method === 'POST');
  assert.match(create.body.description, /提交前检查：未配置 lint，未配置 test/);
});

test('a plan-less ticket falls back to the title and a long summary is clipped', async (t) => {
  const title = '登录按钮点击无响应';
  const h = await createHarness(t, { dirty: true, plan: null, title });

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);

  assert.equal(
    gitSync(h.fixture.worktree, ['log', '-1', '--format=%B']),
    `fix: 【jira单号】：${CODE}，【开发内容】：${title}`,
  );

  // Pure builders: 120-char clip + no ticket URL line.
  const long = buildCommitMessage({ commitType: 'feat' }, CODE, {
    plan: null,
    title: 'x'.repeat(200),
    code: CODE,
  });
  assert.ok(long.length < 200 + 60);
  assert.equal(long, `feat: 【jira单号】：${CODE}，【开发内容】：${'x'.repeat(120)}`);
  assert.equal(
    buildDescription({ ticket: { url: null }, sha: 'a'.repeat(40), checks: { lint: 'passed', test: 'passed' } }),
    `提交前检查：lint 已通过，test 已通过\n提交：${'a'.repeat(40)}`,
  );
  assert.equal(buildCheckNote({ lint: 'skipped', test: 'passed' }), '未配置 lint，test 已通过');
  assert.equal(buildSkippedCheckMessage({ lint: 'passed', test: 'passed' }), undefined);
});

// ---------------------------------------------------------------------------
// Pre-submit checks: block BEFORE commit/push
// ---------------------------------------------------------------------------

test('a lint failure blocks with delivery-lint-failed and never commits or pushes', async (t) => {
  const h = await createHarness(t, {
    exec: createFakeExec({
      results: { 'npm run lint': { ok: false, output: 'lint exploded at line 3' } },
    }),
  });
  const headBefore = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedFrom, 'submitting');
  assert.equal(ticket.blockedReason, 'delivery-lint-failed');
  // Only lint ran; test/commit/push never happened.
  assert.deepEqual(h.exec.calls.map((call) => call.command), ['npm run lint']);
  assert.equal(gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(gitSync(h.fixture.worktree, ['status', '--porcelain']), '');
  assert.equal(bareHasBranch(h.fixture.origin, BRANCH.name), false);
  assert.equal(h.mock.requests.length, 0);

  const meta = h.store.getMeta(`${DELIVERY_ERROR_META_PREFIX}${CODE}`);
  assert.ok(meta.startsWith(DELIVERY_REASON_MESSAGES['delivery-lint-failed']));
  assert.match(meta, /lint exploded at line 3/);
  // Delivery errors never leak into the P4 fix namespace.
  assert.equal(h.store.getMeta(`fix.error:${CODE}`), undefined);
  assert.deepEqual(h.service.status(), {
    running: [],
    errors: { [CODE]: meta },
  });
});

test('a test failure blocks with delivery-test-failed after lint passes (no commit/push)', async (t) => {
  const h = await createHarness(t, {
    exec: createFakeExec({
      results: { 'npm test': { ok: false, output: '2 tests failed' } },
    }),
  });
  const headBefore = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedReason, 'delivery-test-failed');
  assert.deepEqual(h.exec.calls.map((call) => call.command), ['npm run lint', 'npm test']);
  assert.equal(gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(bareHasBranch(h.fixture.origin, BRANCH.name), false);
  assert.equal(h.mock.requests.length, 0);
  assert.match(
    h.store.getMeta(`${DELIVERY_ERROR_META_PREFIX}${CODE}`),
    /2 tests failed/,
  );
  assert.equal(h.store.getMeta(`fix.error:${CODE}`), undefined);
});

test('an executor that throws is a lint failure, never a job rejection', async (t) => {
  const h = await createHarness(t, {
    exec: createFakeExec({
      onCall: () => {
        throw new Error('spawn failed');
      },
    }),
  });

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);

  assert.equal(h.store.get(CODE).blockedReason, 'delivery-lint-failed');
  assert.equal(h.exec.calls.length, 1);
});

test('an empty worktree blocks with delivery-no-changes instead of an empty commit', async (t) => {
  const h = await createHarness(t);
  const headBefore = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedReason, 'delivery-no-changes');
  assert.match(
    h.store.getMeta(`${DELIVERY_ERROR_META_PREFIX}${CODE}`),
    new RegExp(DELIVERY_REASON_MESSAGES['delivery-no-changes']),
  );
  assert.equal(gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(bareHasBranch(h.fixture.origin, BRANCH.name), false);
  assert.equal(h.mock.requests.length, 0);
});

// ---------------------------------------------------------------------------
// Static validation failures: zero writes
// ---------------------------------------------------------------------------

test('a missing GitLab token answers 503 and writes nothing', async (t) => {
  const h = await createHarness(t, { tokenStore: createFakeTokenStore(null) });
  const before = structuredClone(h.store.get(CODE));

  const result = await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  assert.deepEqual(result, {
    ok: false,
    code: 'missing-gitlab-token',
    message: DELIVERY_START_MESSAGES['missing-gitlab-token'],
  });
  assert.deepEqual(h.store.get(CODE), before);
  assert.equal(h.domain.table('meta').size, 0);
  assert.deepEqual(h.exec.calls, []);
  assert.equal(h.mock.requests.length, 0);
  assert.deepEqual(h.service.status(), { running: [], errors: {} });
});

test('an unreadable token store is also missing-gitlab-token (no token text leaks)', async (t) => {
  const h = await createHarness(t, {
    tokenStore: createFakeTokenStore(new Error('keychain exploded: secret')),
  });
  const result = await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  assert.equal(result.code, 'missing-gitlab-token');
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('missing/malformed GitLab settings answer invalid-gitlab-settings and write nothing', async (t) => {
  const cases = [
    { settings: { gitlabProjectPath: '' } },
    { settings: { gitlabBaseUrl: '   ' } },
    { settings: { gitlabBaseUrl: 'not a url' } },
  ];
  for (const [index, options] of cases.entries()) {
    const h = await createHarness(t, options);
    const before = structuredClone(h.store.get(CODE));
    const result = await h.service.start(SESSION_ID, h.fixture.repo, CODE);
    assert.deepEqual(result, {
      ok: false,
      code: 'invalid-gitlab-settings',
      message: DELIVERY_START_MESSAGES['invalid-gitlab-settings'],
    }, `case ${index}`);
    assert.deepEqual(h.store.get(CODE), before, `case ${index}`);
    assert.equal(h.domain.table('meta').size, 0, `case ${index}`);
    assert.equal(h.mock.requests.length, 0, `case ${index}`);
    assert.equal(h.exec.calls.length, 0, `case ${index}`);
  }
});

test('missing branch metadata / missing worktree answer worktree-missing (zero writes)', async (t) => {
  const cases = [
    { name: 'no branch', options: { branch: null } },
    {
      name: 'worktree not on disk',
      options: {
        branch: { ...BRANCH, worktree: '/tmp/dsh-bw-delivery-missing-worktree' },
      },
    },
  ];
  for (const entry of cases) {
    const h = await createHarness(t, entry.options);
    const before = structuredClone(h.store.get(CODE));
    const result = await h.service.start(SESSION_ID, h.fixture.repo, CODE);
    assert.deepEqual(result, {
      ok: false,
      code: 'worktree-missing',
      message: DELIVERY_START_MESSAGES['worktree-missing'],
    }, entry.name);
    assert.deepEqual(h.store.get(CODE), before, entry.name);
    assert.equal(h.domain.table('meta').size, 0, entry.name);
    assert.deepEqual(h.exec.calls, [], entry.name);
  }

  // A worktree outside the resolved repository is refused too.
  const h = await createHarness(t, { branch: null });
  await seedTicket(h.domain, {
    code: 'BUG-2',
    branch: { name: 'feat-V1-other', target: 'feature-V1', worktree: h.fixture.root },
  });
  const outside = await h.service.start(SESSION_ID, h.fixture.repo, 'BUG-2');
  assert.equal(outside.code, 'worktree-missing');
});

test('a protected personal branch is refused synchronously (protected-branch, no git calls)', async (t) => {
  const h = await createHarness(t, { seed: false });
  await seedTicket(h.domain, {
    branch: { ...BRANCH, name: 'feature-V1', worktree: h.fixture.worktree },
  });
  const before = structuredClone(h.store.get(CODE));

  const result = await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'protected-branch');
  assert.deepEqual(h.store.get(CODE), before);
  assert.equal(h.domain.table('meta').size, 0);
  assert.deepEqual(h.exec.calls, []);
});

test('a non-submitting or unknown ticket is refused before any work', async (t) => {
  const invalid = await createHarness(t, { workflow: 'fix_done' });
  const notSubmitting = await invalid.service.start(SESSION_ID, invalid.fixture.repo, CODE);
  assert.equal(notSubmitting.ok, false);
  assert.equal(notSubmitting.code, 'not-submitting');
  assert.equal(invalid.domain.table('tickets').get(CODE).workflow, 'fix_done');
  assert.equal(invalid.domain.table('meta').size, 0);

  const missing = await createHarness(t, { seed: false });
  const notFound = await missing.service.start(SESSION_ID, missing.fixture.repo, CODE);
  assert.equal(notFound.ok, false);
  assert.equal(notFound.code, 'ticket-not-found');
  assert.equal(missing.domain.table('meta').size, 0);

  for (const code of ['', '   ', undefined, null, 42]) {
    const invalidCode = await missing.service.start(SESSION_ID, missing.fixture.repo, code);
    assert.equal(invalidCode.ok, false, String(code));
    assert.equal(invalidCode.code, 'invalid-code', String(code));
  }
});

test('an unbound workspace path is rejected without touching the store', async (t) => {
  const h = await createHarness(t);
  const result = await h.service.start(SESSION_ID, '   ', CODE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unknown-workspace');
  assert.equal(h.domain.table('meta').size, 0);
});

// ---------------------------------------------------------------------------
// Push / MR failures and single-flight
// ---------------------------------------------------------------------------

test('a push failure blocks with push-failed after the local commit (no MR)', async (t) => {
  const h = await createHarness(t, { dirty: true });
  gitSync(h.fixture.repo, [
    'remote',
    'set-url',
    'origin',
    join(h.fixture.root, 'does-not-exist.git'),
  ]);
  const headBefore = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedReason, 'push-failed');
  assert.match(
    h.store.getMeta(`${DELIVERY_ERROR_META_PREFIX}${CODE}`),
    new RegExp(DELIVERY_REASON_MESSAGES['push-failed']),
  );
  // The commit happened before the failed push; no MR request was made.
  assert.notEqual(gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(h.mock.requests.length, 0);
  assert.equal(ticket.mr, null);
});

test('an MR creation failure blocks with mr-failed and keeps the pushed branch', async (t) => {
  const h = await createHarness(t, {
    dirty: true,
    mock: {
      onCreate: () => {
        throw new Error('gitlab exploded');
      },
    },
  });

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedReason, 'mr-failed');
  assert.equal(ticket.mr, null);
  assert.equal(bareHasBranch(h.fixture.origin, BRANCH.name), true);
  assert.match(
    h.store.getMeta(`${DELIVERY_ERROR_META_PREFIX}${CODE}`),
    new RegExp(DELIVERY_REASON_MESSAGES['mr-failed']),
  );
});

test('a duplicate start and a second ticket in the same repo are delivery-busy', async (t) => {
  const gate = deferred();
  const commandStarted = deferred();
  const h = await createHarness(t, {
    dirty: true,
    exec: createFakeExec({
      onCall: async () => {
        commandStarted.resolve();
        await gate.promise;
        return { ok: true, output: '' };
      },
    }),
  });
  await seedTicket(h.domain, {
    code: 'BUG-2',
    // Same registered worktree/branch: the probe passes and the only reason to
    // refuse is the repository single-flight lock held by the first delivery.
    branch: h.branch,
  });

  assert.deepEqual(await h.service.start(SESSION_ID, h.fixture.repo, CODE), {
    ok: true,
    running: true,
  });
  await commandStarted.promise;

  const duplicate = await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'delivery-busy');
  const sameRepo = await h.service.start(SESSION_ID, h.fixture.repo, 'BUG-2');
  assert.equal(sameRepo.ok, false);
  assert.equal(sameRepo.code, 'delivery-busy');

  gate.resolve();
  await waitForIdle(h.service);
  assert.equal(h.store.get(CODE).workflow, 'mr_open');

  // The repository lock is released on success: another ticket can start.
  const after = await h.service.start(SESSION_ID, h.fixture.repo, 'BUG-2');
  assert.deepEqual(after, { ok: true, running: true });
  await waitForIdle(h.service);
});

test('a shared injected repo lock is honoured and released', async (t) => {
  const owners = new Map();
  const lock = {
    acquire(repo, owner) {
      if (owners.has(repo) && owners.get(repo) !== owner) return false;
      owners.set(repo, owner);
      return true;
    },
    release(repo, owner) {
      if (owners.get(repo) === owner) owners.delete(repo);
    },
  };
  const gate = deferred();
  const started = deferred();
  const h = await createHarness(t, {
    lock,
    exec: createFakeExec({
      onCall: async () => {
        started.resolve();
        await gate.promise;
        return { ok: true, output: '' };
      },
    }),
  });

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await started.promise;
  assert.equal(owners.size, 1);
  gate.resolve();
  await waitForIdle(h.service);
  assert.equal(owners.size, 0);
});

// ---------------------------------------------------------------------------
// Cancellation / late results
// ---------------------------------------------------------------------------

test('dispose() cancels a running delivery and writes no state', async (t) => {
  const gate = deferred();
  const started = deferred();
  const h = await createHarness(t, {
    exec: createFakeExec({
      onCall: async () => {
        started.resolve();
        await gate.promise;
        return { ok: true, output: '' };
      },
    }),
  });
  const before = structuredClone(h.store.get(CODE));
  const headBefore = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await started.promise;
  await h.service.dispose();
  assert.deepEqual(h.service.status().running, []);

  gate.resolve();
  await settle();
  assert.deepEqual(h.store.get(CODE), before);
  assert.equal(h.store.getMeta(`${DELIVERY_ERROR_META_PREFIX}${CODE}`), undefined);
  assert.equal(gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(bareHasBranch(h.fixture.origin, BRANCH.name), false);
  assert.equal(h.mock.requests.length, 0);

  const afterDispose = await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  assert.equal(afterDispose.ok, false);
  assert.equal(afterDispose.code, 'delivery-unavailable');
});

test('a late mr_created never regresses a ticket that moved on (meta only)', async (t) => {
  const releaseCreate = deferred();
  const createStarted = deferred();
  const h = await createHarness(t, {
    dirty: true,
    mock: {
      onCreate: async () => {
        createStarted.resolve();
        await releaseCreate.promise;
      },
    },
  });

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await createStarted.promise;

  // The ticket moves on while the MR request is in flight (e.g. a manual hold).
  const blocked = await h.store.applyAction(CODE, 'block', {
    reason: 'manual-hold',
    actor: 'user',
  });
  assert.equal(blocked.ok, true);
  assert.equal(blocked.ticket.workflow, 'blocked');

  releaseCreate.resolve();
  await waitForIdle(h.service);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedFrom, 'submitting');
  assert.equal(ticket.blockedReason, 'manual-hold');
  assert.equal(ticket.mr, null);
  assert.equal(
    h.store.getMeta(`${DELIVERY_ERROR_META_PREFIX}${CODE}`),
    DELIVERY_STALE_MESSAGE,
  );
  // The MR was created remotely, but no local state was fabricated.
  assert.equal(h.mock.requests.filter((request) => request.method === 'POST').length, 1);
});

test('a successful retry clears a stale delivery error', async (t) => {
  const h = await createHarness(t, { dirty: true });
  await h.store.setMeta(`${DELIVERY_ERROR_META_PREFIX}${CODE}`, '旧错误');

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);

  assert.equal(h.store.get(CODE).workflow, 'mr_open');
  assert.equal(h.store.getMeta(`${DELIVERY_ERROR_META_PREFIX}${CODE}`), null);
  assert.deepEqual(h.service.status(), { running: [], errors: {} });
});

test('the service never logs the GitLab token and validates its dependencies', async (t) => {
  const logged = [];
  const h = await createHarness(t, {
    dirty: true,
    log: (entry) => logged.push(entry),
    mock: {
      onCreate: () => {
        throw new Error('boom');
      },
    },
  });

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);

  const serialized = JSON.stringify(logged);
  assert.equal(serialized.includes(TOKEN), false);
  assert.equal(serialized.includes('private-token'), false);

  assert.throws(
    () => createDeliveryService({ store: h.store }),
    /requires a git executor/,
  );
  assert.throws(
    () => createDeliveryService({ store: h.store, git: h.git, tokenStore: {} }),
    /token store/,
  );
  assert.throws(
    () => createDeliveryService({ store: h.store, git: h.git, tokenStore: h.tokenStore, clock: 'nope' }),
    /clock/,
  );
});

test('the production execCommand runs through /bin/sh in the given cwd with a tail cap', async () => {
  const exec = createShellExecCommand();
  const ok = await exec('printf hello', { cwd: tmpdir(), timeoutMs: 5_000 });
  assert.deepEqual(ok, { ok: true, output: 'hello' });

  const failed = await exec('printf tail-output; exit 3', { cwd: tmpdir(), timeoutMs: 5_000 });
  assert.equal(failed.ok, false);
  assert.match(failed.output, /tail-output/);

  // The persisted tail keeps only the last 8 000 characters of a large output.
  const long = await exec('printf "%08000d" 7; printf END', { cwd: tmpdir(), timeoutMs: 5_000 });
  assert.equal(long.ok, true);
  assert.ok(long.output.length <= 8_000);
  assert.ok(long.output.endsWith('END'));
});

test('an unexpected store read failure is surfaced as a start failure, never an exception', async (t) => {
  const h = await createHarness(t);
  const originalGet = h.store.get;
  h.store.get = () => {
    throw new Error('domain closed');
  };
  const result = await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'internal');
  h.store.get = originalGet;
  assert.equal(existsSync(h.fixture.worktree), true);
});

// ---------------------------------------------------------------------------
// I1: hard timeout (process-group kill + timer-driven settle)
// ---------------------------------------------------------------------------

test('the production execCommand hard-kills a timed-out command and settles fast', async () => {
  const exec = createShellExecCommand();
  const commands = [
    // TERM is ignored (by the shell AND the inherited sleep), so only SIGKILL
    // ends it; without a timer-driven settle the promise waits for 'close'.
    "trap '' TERM; sleep 5",
    // A background grandchild inherits the stdout/stderr pipes; killing only
    // the shell would leave the promise waiting for the grandchild.
    'sleep 5 & wait',
  ];

  for (const command of commands) {
    const started = Date.now();
    const result = await exec(command, { cwd: tmpdir(), timeoutMs: 120 });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false, command);
    assert.equal(result.timedOut, true, command);
    assert.ok(elapsed < 1_500, `${command} settled after ${elapsed}ms`);
  }

  // A fast successful command is unaffected by the kill machinery.
  const fast = await exec('printf hello', { cwd: tmpdir(), timeoutMs: 5_000 });
  assert.deepEqual(fast, { ok: true, output: 'hello' });
});

test('a timed-out lint command blocks the delivery and releases both locks', async (t) => {
  const lock = createCountingLock();
  const h = await createHarness(t, {
    lock,
    commandTimeoutMs: 120,
    execCommand: createShellExecCommand(),
    settings: { lintCommand: "trap '' TERM; sleep 5", testCommand: '' },
  });
  // A second ticket in the same repo proves the repository lock is not stuck.
  await seedTicket(h.domain, { code: 'BUG-2', branch: h.branch });

  const started = Date.now();
  assert.deepEqual(
    await h.service.start(SESSION_ID, h.fixture.repo, CODE),
    { ok: true, running: true },
  );
  await waitForIdle(h.service);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `timed-out delivery settled after ${elapsed}ms`);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedReason, 'delivery-lint-failed');
  assert.match(
    h.store.getMeta(`${DELIVERY_ERROR_META_PREFIX}${CODE}`),
    new RegExp(DELIVERY_REASON_MESSAGES['delivery-lint-failed']),
  );
  assert.equal(h.mock.requests.length, 0);
  assert.equal(h.exec.calls.length, 0);
  assert.equal(bareHasBranch(h.fixture.origin, BRANCH.name), false);

  // The first job's running slot and repo lock are gone: another ticket in the
  // SAME repository starts (and times out) instead of answering delivery-busy.
  const second = await h.service.start(SESSION_ID, h.fixture.repo, 'BUG-2');
  assert.deepEqual(second, { ok: true, running: true });
  await waitForIdle(h.service);
  assert.equal(lock.owners.size, 0);
  assert.equal(lock.acquires.length, 2);
  assert.equal(lock.releases.length, 2);
});

// ---------------------------------------------------------------------------
// I2: worktree registration / branch identity
// ---------------------------------------------------------------------------

test('a plain directory inside the repo is refused before any commit (worktree-missing)', async (t) => {
  const h = await createHarness(t, { seed: false });
  const plain = join(h.fixture.repo, '.dsh-worktrees', 'PLAIN-DIR');
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, 'evil.txt'), 'must never reach the main repository\n');
  await seedTicket(h.domain, {
    code: CODE,
    branch: { ...BRANCH, worktree: plain },
  });
  const before = structuredClone(h.store.get(CODE));
  const mainHeadBefore = gitSync(h.fixture.repo, ['rev-parse', 'HEAD']);

  const result = await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  assert.deepEqual(result, {
    ok: false,
    code: 'worktree-missing',
    message: DELIVERY_START_MESSAGES['worktree-missing'],
  });

  // The fix: `git add -A`/commit never runs in the non-worktree directory, so
  // the main repository's current branch cannot move.
  assert.equal(gitSync(h.fixture.repo, ['rev-parse', 'HEAD']), mainHeadBefore);
  assert.equal(gitSync(h.fixture.repo, ['status', '--porcelain']), '?? .dsh-worktrees/');
  assert.deepEqual(h.store.get(CODE), before);
  assert.equal(h.domain.table('meta').size, 0);
  assert.equal(bareHasBranch(h.fixture.origin, BRANCH.name), false);
  assert.equal(h.mock.requests.length, 0);
});

test('a worktree checked out on another branch is refused (worktree-conflict)', async (t) => {
  const h = await createHarness(t, { dirty: true, seed: false });
  await seedTicket(h.domain, {
    code: CODE,
    branch: { ...BRANCH, name: 'feat-V1-other', worktree: h.fixture.worktree },
  });
  const before = structuredClone(h.store.get(CODE));
  const headBefore = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);

  const result = await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  assert.deepEqual(result, {
    ok: false,
    code: 'worktree-conflict',
    message: DELIVERY_START_MESSAGES['worktree-conflict'],
  });

  assert.equal(gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']), headBefore);
  assert.match(gitSync(h.fixture.worktree, ['status', '--porcelain']), /fix-note\.txt/);
  assert.deepEqual(h.store.get(CODE), before);
  assert.equal(h.domain.table('meta').size, 0);
  assert.equal(bareHasBranch(h.fixture.origin, BRANCH.name), false);
  assert.equal(h.mock.requests.length, 0);
});

test('a commit that does not land on the personal branch blocks before push', async (t) => {
  const realGit = createGit();
  const h = await createHarness(t, {
    dirty: true,
    // Simulate a `-C` resolution surprise: the local commit happened, but the
    // branch ref the push would use points somewhere else.
    git: { ...realGit, revParse: async () => 'c'.repeat(40) },
  });
  const headBefore = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedReason, 'worktree-mismatch');
  assert.match(
    h.store.getMeta(`${DELIVERY_ERROR_META_PREFIX}${CODE}`),
    new RegExp(DELIVERY_REASON_MESSAGES['worktree-mismatch']),
  );
  // The local commit exists, but the branch was never pushed and no MR exists.
  assert.notEqual(gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']), headBefore);
  assert.equal(bareHasBranch(h.fixture.origin, BRANCH.name), false);
  assert.equal(h.mock.requests.length, 0);
});

// ---------------------------------------------------------------------------
// I3: retry after a post-commit failure reuses the recorded commit
// ---------------------------------------------------------------------------

test('a retry after push-failed reuses the recorded commit instead of delivery-no-changes', async (t) => {
  const h = await createHarness(t, { dirty: true });
  const realOrigin = h.fixture.origin;
  gitSync(h.fixture.repo, [
    'remote',
    'set-url',
    'origin',
    join(h.fixture.root, 'missing-origin.git'),
  ]);

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);
  assert.equal(h.store.get(CODE).workflow, 'blocked');
  assert.equal(h.store.get(CODE).blockedReason, 'push-failed');

  const sha = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);
  // Captured now, asserted after the retry so a pre-fix run fails on the real
  // symptom (the retry blocks delivery-no-changes) rather than on metadata.
  const record = h.store.getMeta(`${DELIVERY_COMMIT_META_PREFIX}${CODE}`);

  // Fix the remote and retry exactly as the UI copy tells the user to.
  gitSync(h.fixture.repo, ['remote', 'set-url', 'origin', realOrigin]);
  const retried = await h.store.applyAction(CODE, 'retry', { actor: 'user' });
  assert.equal(retried.ok, true);
  assert.equal(retried.ticket.workflow, 'submitting');

  assert.deepEqual(
    await h.service.start(SESSION_ID, h.fixture.repo, CODE),
    { ok: true, running: true },
  );
  await waitForIdle(h.service);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'mr_open');
  assert.equal(ticket.mr.iid, 77);
  // No second empty/duplicate commit: init + exactly one delivery commit.
  assert.equal(gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']), sha);
  assert.equal(gitSync(h.fixture.worktree, ['rev-list', '--count', 'HEAD']), '2');
  assert.equal(gitSync(h.fixture.worktree, ['status', '--porcelain']), '');
  assert.equal(bareRef(realOrigin, `refs/heads/${BRANCH.name}`), sha);
  assert.equal(h.mock.requests.filter((request) => request.method === 'POST').length, 1);
  assert.equal(record.sha, sha);
  assert.equal(record.branch, BRANCH.name);
  assert.equal(record.worktree, h.fixture.worktree);
  assert.equal(h.store.getMeta(`${DELIVERY_COMMIT_META_PREFIX}${CODE}`), null);
});

test('a retry after mr-failed reuses the pushed commit and creates the MR', async (t) => {
  let creates = 0;
  const h = await createHarness(t, {
    dirty: true,
    mock: {
      onCreate: () => {
        creates += 1;
        if (creates === 1) throw new Error('gitlab exploded');
      },
    },
  });

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);
  const first = h.store.get(CODE);
  assert.equal(first.workflow, 'blocked');
  assert.equal(first.blockedReason, 'mr-failed');
  const sha = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);
  assert.equal(bareRef(h.fixture.origin, `refs/heads/${BRANCH.name}`), sha);

  const retried = await h.store.applyAction(CODE, 'retry', { actor: 'user' });
  assert.equal(retried.ticket.workflow, 'submitting');
  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'mr_open');
  assert.equal(ticket.mr.iid, 77);
  assert.equal(gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']), sha);
  assert.equal(gitSync(h.fixture.worktree, ['rev-list', '--count', 'HEAD']), '2');
  assert.equal(h.mock.requests.filter((request) => request.method === 'POST').length, 2);
  assert.equal(h.store.getMeta(`${DELIVERY_COMMIT_META_PREFIX}${CODE}`), null);
});

// ---------------------------------------------------------------------------
// M1: project-path validation happens before commit/push
// ---------------------------------------------------------------------------

test('a syntactically invalid non-empty gitlabProjectPath is rejected before any work', async (t) => {
  const invalidProjects = [
    'group//project',
    ' group/project ',
    '%2Fgroup%2Fproject',
    'project',
  ];
  for (const projectPath of invalidProjects) {
    const h = await createHarness(t, { settings: { gitlabProjectPath: projectPath } });
    const before = structuredClone(h.store.get(CODE));
    const result = await h.service.start(SESSION_ID, h.fixture.repo, CODE);
    assert.deepEqual(result, {
      ok: false,
      code: 'invalid-gitlab-settings',
      message: DELIVERY_START_MESSAGES['invalid-gitlab-settings'],
    }, projectPath);
    assert.deepEqual(h.store.get(CODE), before, projectPath);
    assert.equal(h.domain.table('meta').size, 0, projectPath);
    assert.deepEqual(h.exec.calls, [], projectPath);
    assert.equal(h.mock.requests.length, 0, projectPath);
  }
});

test('a subgroup gitlabProjectPath is accepted and encoded as one segment', async (t) => {
  const h = await createHarness(t, {
    dirty: true,
    settings: { gitlabProjectPath: 'group/sub/project' },
  });

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);

  assert.equal(h.store.get(CODE).workflow, 'mr_open');
  const create = h.mock.requests.find((request) => request.method === 'POST');
  assert.equal(create.path, '/api/v4/projects/group%2Fsub%2Fproject/merge_requests');
});

// ---------------------------------------------------------------------------
// M2: target-branch family consistency and protected targets
// ---------------------------------------------------------------------------

test('an inconsistent or protected target branch is refused before any work', async (t) => {
  const cases = [
    ['protected main', { ...BRANCH, target: 'main' }],
    ['protected dev', { ...BRANCH, target: 'Dev' }],
    ['release family', { ...BRANCH, target: 'release-V1' }],
    ['feat personal/hotfix target', { ...BRANCH, target: 'hotfix-V1' }],
    ['hot personal/feature target', { ...BRANCH, name: 'hot-V1-ly', target: 'feature-V1' }],
    ['custom self target', { ...BRANCH, name: 'bugfix-1', target: 'bugfix-1' }],
  ];
  for (const [name, branch] of cases) {
    const h = await createHarness(t, { seed: false });
    await seedTicket(h.domain, {
      code: CODE,
      branch: { ...branch, worktree: h.fixture.worktree },
    });
    const before = structuredClone(h.store.get(CODE));
    const result = await h.service.start(SESSION_ID, h.fixture.repo, CODE);
    assert.equal(result.ok, false, name);
    assert.equal(result.code, 'invalid-branch', name);
    assert.deepEqual(h.store.get(CODE), before, name);
    assert.equal(h.domain.table('meta').size, 0, name);
    assert.deepEqual(h.exec.calls, [], name);
    assert.equal(h.mock.requests.length, 0, name);
  }
});

test('a hotfix delivery accepts the matching hotfix-* target', async (t) => {
  const branch = { ...BRANCH, name: 'hot-V1-ly', target: 'hotfix-V1' };
  const h = await createHarness(t, {
    dirty: true,
    branch,
    fixtureBranch: 'hot-V1-ly',
    mock: {
      createdMergeRequest: {
        iid: 88,
        web_url: 'https://gitlab.example.com/group/project/-/merge_requests/88',
        state: 'opened',
        source_branch: 'hot-V1-ly',
        target_branch: 'hotfix-V1',
        title: 'hot-V1-ly -> hotfix-V1',
      },
    },
  });

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'mr_open');
  assert.equal(ticket.mr.sourceBranch, 'hot-V1-ly');
  assert.equal(ticket.mr.targetBranch, 'hotfix-V1');
  const create = h.mock.requests.find((request) => request.method === 'POST');
  assert.equal(create.body.target_branch, 'hotfix-V1');
});

// ---------------------------------------------------------------------------
// M3: MR description single-line/size hardening
// ---------------------------------------------------------------------------

test('buildDescription sanitizes and clips the ticket URL', () => {
  const sha = 'a'.repeat(40);
  const checks = { lint: 'passed', test: 'passed' };
  const injected = buildDescription({
    ticket: { url: 'https://x/issue/1\n恶意：已批准\u0001已合并' },
    sha,
    checks,
  });
  assert.equal(injected.split('\n')[0], '工单：https://x/issue/1 恶意：已批准 已合并');
  assert.equal(injected.includes('\n恶意'), false);
  assert.equal(injected.split('\n').length, 3);

  const clipped = buildDescription({
    ticket: { url: `https://x/${'a'.repeat(2_500)}` },
    sha,
    checks,
  });
  assert.equal(clipped.split('\n')[0].length, '工单：'.length + 2_000);
});

// ---------------------------------------------------------------------------
// M5: remaining failure/lock coverage
// ---------------------------------------------------------------------------

test('an existing open MR for a different target branch blocks with mr-failed', async (t) => {
  const existing = {
    iid: 5,
    web_url: 'https://gitlab.example.com/group/project/-/merge_requests/5',
    state: 'opened',
    source_branch: BRANCH.name,
    target_branch: 'feature-OTHER',
  };
  const h = await createHarness(t, { dirty: true, mock: { openMergeRequests: [existing] } });

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);

  const ticket = h.store.get(CODE);
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedReason, 'mr-failed');
  assert.equal(ticket.mr, null);
  assert.equal(h.mock.requests.filter((request) => request.method === 'POST').length, 0);
});

test('a push failure releases the repository lock', async (t) => {
  const lock = createCountingLock();
  const h = await createHarness(t, { dirty: true, lock });
  gitSync(h.fixture.repo, [
    'remote',
    'set-url',
    'origin',
    join(h.fixture.root, 'missing-origin.git'),
  ]);

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await waitForIdle(h.service);

  assert.equal(h.store.get(CODE).blockedReason, 'push-failed');
  assert.equal(lock.owners.size, 0);
  assert.equal(lock.acquires.length, 1);
  assert.equal(lock.releases.length, 1);
});

test('dispose() aborts a real lint command promptly and leaves no writes', async (t) => {
  const lock = createCountingLock();
  const realExec = createShellExecCommand();
  const started = deferred();
  const h = await createHarness(t, {
    lock,
    execCommand: (command, options) => {
      started.resolve();
      return realExec(command, options);
    },
    settings: { lintCommand: 'sleep 5', testCommand: '' },
  });
  const before = structuredClone(h.store.get(CODE));

  await h.service.start(SESSION_ID, h.fixture.repo, CODE);
  await started.promise;
  const disposeStarted = Date.now();
  await h.service.dispose();
  const elapsed = Date.now() - disposeStarted;
  assert.ok(elapsed < 2_000, `dispose() took ${elapsed}ms`);

  await settle(2);
  assert.deepEqual(h.store.get(CODE), before);
  assert.equal(h.store.getMeta(`${DELIVERY_ERROR_META_PREFIX}${CODE}`), undefined);
  assert.equal(h.domain.table('meta').size, 0);
  assert.equal(gitSync(h.fixture.worktree, ['status', '--porcelain']), '');
  assert.equal(bareHasBranch(h.fixture.origin, BRANCH.name), false);
  assert.equal(h.mock.requests.length, 0);
  assert.equal(lock.owners.size, 0);
  assert.equal(lock.releases.length, 1);
});

test('a delivery started from another workspace uses the owning workspace', async (t) => {
  const OWNING = '/tmp/bug-workflow-owning-workspace';
  const CLICKED = '/tmp/bug-workflow-clicked-workspace';
  const repoRootCalls = [];
  const real = createGit();
  let fixtureRepo;
  const wrapped = {
    ...real,
    async repoRoot(cwd) {
      repoRootCalls.push(cwd);
      if (cwd === OWNING) return fixtureRepo;
      // Proves the service did not fall back to the requesting workspace.
      if (cwd === CLICKED) throw new Error('wrong workspace');
      return real.repoRoot(cwd);
    },
  };

  const h = await createHarness(t, { git: wrapped, dirty: true });
  fixtureRepo = h.fixture.repo;
  await h.store.putSettings(OWNING, {
    gitlabBaseUrl: h.mock.url,
    gitlabProjectPath: PROJECT,
    lintCommand: 'npm run lint',
    testCommand: 'npm test',
    commitType: 'fix',
    branchUser: 'ly',
  });
  await h.store.setMeta(TICKET_WORKSPACE_META_PREFIX + CODE, OWNING);

  const started = await h.service.start(SESSION_ID, CLICKED, CODE);
  assert.deepEqual(started, { ok: true, running: true });
  assert.deepEqual(repoRootCalls.slice(0, 2), [OWNING, OWNING]);
  assert.ok(!repoRootCalls.includes(CLICKED));
});
