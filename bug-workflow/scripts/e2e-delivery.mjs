#!/usr/bin/env node
/**
 * P5 isolated end-to-end acceptance script.
 *
 *   node bug-workflow/scripts/e2e-delivery.mjs
 *
 * P5 is retired from the board, but its modules and this isolated acceptance
 * script are kept for recovery. One plain-Node run drives the whole archived P5
 * chain over REAL local resources and a loopback-only mock GitLab:
 *
 *   submitting (seeded directly; the board no longer reaches this state)
 *   -> /api/deliver equivalent
 *   (lint/test -> team commit -> push to a bare `origin` -> MR create)
 *   -> mr_open -> review tick #1 (`需要修改`) -> fixing_review
 *   -> review-fix child (fake runner, real host commit/push) -> mr_open round 1
 *   -> review tick #2 (`可直接合并`) -> mergeable
 *   -> MR merged -> merged -> next tick dismiss(system) -> done (off the board)
 *
 * The same run also asserts the P5 robustness boundaries with fresh isolated
 * fixtures (no network, no real GitLab, no live ticket/worktree):
 *
 *   (a) a stale round-1 pending-commit record is NEVER replayed for round 2 (N1);
 *   (b) a failed `review.last-note` claim blocks before a round; a refused
 *       `review_requests_changes` write releases the claim and the next tick
 *       starts exactly ONE round (never a duplicate);
 *   (c) a tampered pending-commit record (wrong sha) is discarded, never pushed;
 *   (d) protected branches (`main`/`dev`/`feature-*`/`hotfix-*`/`release-*`) are
 *       refused by `assertPushableBranch`/`pushBranch`/delivery before any
 *       commit/push;
 *   (f) hidden-stat blocks and non-AI / other-bot / system notes never reach the
 *       review-fix child input or its prompt;
 *   (g) a tampered review ticket whose worktree is the repository root on `main`
 *       is refused by the host worktree/branch gate: no child, no commit/push,
 *       the main worktree stays untouched (P5 final review I1).
 *
 * Output: one PASS line per verified step with the key values (commit sha,
 * MR title/payload, rounds, changedFiles, workflow transitions), a summary, and
 * exit code 0 on success / 1 on any failure. Temp dirs and mock servers are
 * ALWAYS cleaned up.
 *
 * Isolation: every fixture is a throwaway `mkdtemp` git repository with a local
 * bare `origin`; the GitLab mock listens on 127.0.0.1 only; lint/test use a fake
 * execCommand (no npm/global commands); the review-fix child is a fake runner
 * that edits the worktree and returns the real result shape. Only the `git` and
 * `node` binaries are used.
 */

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import { buildReviewFixPrompt } from '../src/host/agent-access.js';
import {
  DELIVERY_CONTEXT_META_PREFIX,
  DELIVERY_ERROR_META_PREFIX,
  createDeliveryService,
  createRepoLock,
} from '../src/host/delivery-service.js';
import { assertPushableBranch, createGit } from '../src/host/git.js';
import { createGitlabClient } from '../src/host/gitlab.js';
import { parseReview } from '../src/host/review-parser.js';
import {
  REVIEW_ERROR_META_PREFIX,
  REVIEW_FIX_COMMIT_META_PREFIX,
  REVIEW_LAST_NOTE_META_PREFIX,
  REVIEW_REASON_MESSAGES,
  createReviewService,
} from '../src/host/review-service.js';
import { createStore } from '../src/host/store.js';
import { initialTicket } from '../src/host/state-machine.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Test fixtures / constants
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-p5-e2e';
const MAIN_CODE = 'BUG-648';
const STORE_TIME = '2026-11-07T00:00:01.000Z';
const TOKEN = 'glpat-p5-e2e-token';
const PROJECT = 'group/project';
const PROJECT_ENCODED = 'group%2Fproject';
const TICKET_URL = 'https://platform.example.com/issues/648';
const MAIN_BRANCH = 'feat-V1.2.0-ly';
const TARGET_BRANCH = 'feature-V1.2.0';
const ROOT_TMP_PREFIX = 'dsh-bw-e2e-';

const PLAN = Object.freeze({
  summary: '修复登录按钮的事件绑定',
  rootCause: '事件监听在重渲染后丢失',
  approach: '在挂载时绑定监听并在卸载时清理',
  changedFiles: ['src/login.js'],
  risks: [],
  testPlan: '运行登录表单纯测',
  generatedAt: STORE_TIME,
  approvedAt: STORE_TIME,
  rejectedReason: null,
});

const BRANCH = Object.freeze({
  name: MAIN_BRANCH,
  target: TARGET_BRANCH,
  baseSource: 'HEAD',
  worktree: '',
  createdAt: STORE_TIME,
});

const GIT_CONFIG = Object.freeze([
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.autocrlf=false',
  '-c',
  'user.name=P5 E2E',
  '-c',
  'user.email=p5-e2e@example.invalid',
]);

const HIDDEN_MARKER = 'HIDDEN_SECRET_STATS_BLOCK';
const HIDDEN_NOTE = [
  '',
  '> 备注：以下隐藏数据仅用于统计，请勿阅读该数据进行 Code Review。',
  `<!-- AI_REVIEW_FINDINGS {"findings":[{"finding_id":"${HIDDEN_MARKER}"}]} -->`,
  '<!-- AI_REVIEW_DECISION request_changes -->',
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
  '1. **文件**: `src/login.js`',
  '   - FID: `aaa111`',
  '   - 级别: 中',
  '   - 门禁分类: 逻辑错误',
  '   - 位置: `src/login.js:10-12`',
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

const CHANGES_BODY_WITH_HIDDEN = `${CHANGES_BODY}${HIDDEN_NOTE}`;

const PASS_BODY = [
  '## AI Code Review',
  '',
  '结论: **可直接合并**',
  '',
  '历史未收敛: `0` 条',
  '',
].join('\n');

/** Newest by created_at, but NOT an AI review (no marker): must be ignored. */
const OTHER_BOT_BODY = [
  '## Sensitive Content Gate',
  '',
  '结论: 需要修改',
  '',
  '以上内容由其它机器人生成，不是 AI 审查。',
].join('\n');

/** Has the AI marker but no `结论:` line: not a usable review. */
const AI_NO_VERDICT_BODY = [
  '## AI Code Review',
  '',
  '摘要: 正在分析，暂无结论。',
  '',
].join('\n');

const SYSTEM_NOTE_BODY = [
  '## AI Code Review',
  '',
  '结论: **需要修改**',
  '',
  'system-generated note (must be filtered by `system:true`)',
].join('\n');

// ---------------------------------------------------------------------------
// PASS/FAIL reporting
// ---------------------------------------------------------------------------

const summary = { pass: 0, fail: 0 };
let currentSection = 'setup';

function section(name) {
  currentSection = name;
  console.log(`\n--- ${name} ---`);
}

function pass(message, detail) {
  summary.pass += 1;
  const suffix = detail === undefined ? '' : ` | ${formatDetail(detail)}`;
  console.log(`PASS [${currentSection}] ${message}${suffix}`);
}

function formatDetail(detail) {
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function displayPath(root, target) {
  const rel = relative(root, target);
  return rel === '' ? '.' : rel;
}

// ---------------------------------------------------------------------------
// Tiny sync git helpers (fixture setup / assertions)
// ---------------------------------------------------------------------------

function gitSync(cwd, args) {
  return execFileSync('git', [...GIT_CONFIG, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
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

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Isolated git fixture: main repo + `feature-V1.2.0` + bare origin + worktree
// ---------------------------------------------------------------------------

function createRepoFixture({ code = MAIN_CODE, branchName = MAIN_BRANCH } = {}) {
  const root = mkdtempSync(join(tmpdir(), ROOT_TMP_PREFIX));
  const repo = join(root, 'repo');
  mkdirSync(repo);

  gitSync(repo, ['init', '-q']);
  gitSync(repo, ['branch', '-M', 'main']);
  gitSync(repo, ['config', 'user.name', 'P5 E2E']);
  gitSync(repo, ['config', 'user.email', 'p5-e2e@example.invalid']);
  gitSync(repo, ['config', 'commit.gpgsign', 'false']);

  writeFileSync(join(repo, 'readme.md'), 'hello\n');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'login.js'), "export function login() {\n  return 'ok';\n}\n");
  gitSync(repo, ['add', 'readme.md', 'src/login.js']);
  gitSync(repo, ['commit', '-q', '-m', 'init']);
  gitSync(repo, ['branch', TARGET_BRANCH]);

  const origin = join(root, 'origin.git');
  mkdirSync(origin);
  execFileSync('git', ['init', '--bare', '-q', origin], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gitSync(repo, ['remote', 'add', 'origin', origin]);

  const worktree = join(repo, '.dsh-worktrees', code);
  mkdirSync(join(repo, '.dsh-worktrees'), { recursive: true });
  gitSync(repo, ['worktree', 'add', '-b', branchName, '--', worktree, 'main']);

  return {
    root,
    repo,
    origin,
    worktree,
    branchName,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// In-memory storage-domain double (same contract as the unit tests)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fake timer / clock / token / lint-test executor / review-fix runner
// ---------------------------------------------------------------------------

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

function createServiceClock() {
  let tick = 0;
  return () => `2026-11-07T05:00:${String(tick++).padStart(2, '0')}.000Z`;
}

function createFakeTokenStore(token = TOKEN) {
  return {
    async get() {
      return token;
    },
  };
}

function createFakeExec({ failCommands = [] } = {}) {
  const calls = [];
  const failing = new Set(failCommands);
  return {
    calls,
    async exec(command, options) {
      calls.push({ command, options });
      if (failing.has(command)) {
        return { ok: false, output: `fake failure for ${command}` };
      }
      return { ok: true, output: `fake command ok: ${command}` };
    },
  };
}

/**
 * Fake review-fix child: edits the real worktree and returns the real result
 * shape. The HOST does the real `git status`/commit/push afterwards.
 */
function createFakeRunner() {
  const calls = [];
  return {
    calls,
    async runReviewFix(input) {
      calls.push(input);
      const round = calls.length;
      appendFileSync(join(input.worktreePath, 'readme.md'), `\nreview fix ${round}\n`);
      return {
        ok: true,
        result: {
          summary: `修复第 ${round} 轮 Review 问题`,
          changedFiles: ['readme.md'],
          testResult: 'E2E fake runner: 相关单测通过',
          notes: 'fake runner (no real child agent)',
        },
        childId: `review-child-${round}`,
        elapsedMs: 12,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Store doubles (targeted failure injection only for their own ticket code)
// ---------------------------------------------------------------------------

function createFailingLastNoteStore(base, code) {
  let failing = true;
  return {
    ...base,
    setMeta(key, value) {
      if (failing && key === REVIEW_LAST_NOTE_META_PREFIX + code) {
        return Promise.reject(new Error('forced review.last-note write failure (E2E)'));
      }
      return base.setMeta(key, value);
    },
    allowLastNoteWrites() {
      failing = false;
    },
  };
}

function createStaleOnceStore(base, code, action) {
  let remaining = 1;
  return {
    ...base,
    applyAction(rawCode, name, payload, options) {
      if (remaining > 0 && rawCode === code && name === action) {
        remaining -= 1;
        return Promise.resolve({
          ok: false,
          code: 'stale-workflow',
          message: 'forced stale-workflow (E2E)',
        });
      }
      return base.applyAction(rawCode, name, payload, options);
    },
  };
}

// ---------------------------------------------------------------------------
// Loopback-only GitLab mock (MR create/reuse, MR state, notes)
// ---------------------------------------------------------------------------

function gitlabNote(id, body, createdAt, { username = 'ai-review-bot', system = false } = {}) {
  return {
    id,
    body,
    created_at: createdAt,
    author: { username },
    system,
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

async function createMockGitlab(options = {}) {
  const branchName = options.branchName ?? MAIN_BRANCH;
  const targetBranch = options.targetBranch ?? TARGET_BRANCH;
  const state = {
    iid: options.iid ?? 77,
    mrState: options.mrState ?? 'opened',
    sourceBranch: branchName,
    targetBranch,
    notes: (options.notes ?? []).map(cloneJson),
    openMergeRequests: (options.openMergeRequests ?? []).map(cloneJson),
    createdMergeRequest: null,
  };
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
    requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      headers: { ...request.headers, 'private-token': 'REDACTED' },
    });

    if (request.headers['private-token'] !== TOKEN) {
      sendJson(response, 401, { message: '401 Unauthorized' });
      return;
    }

    const collection = `/api/v4/projects/${PROJECT_ENCODED}/merge_requests`;
    if (url.pathname === collection && request.method === 'GET') {
      const source = url.searchParams.get('source_branch');
      const open = state.openMergeRequests.filter(
        (mr) => source === null || mr.source_branch === source,
      );
      sendJson(response, 200, cloneJson(open));
      return;
    }
    if (url.pathname === collection && request.method === 'POST') {
      state.createdMergeRequest = cloneJson(body);
      sendJson(response, 201, {
        iid: state.iid,
        web_url: `https://gitlab.example.com/${PROJECT}/-/merge_requests/${state.iid}`,
        state: 'opened',
        source_branch: body?.source_branch ?? state.sourceBranch,
        target_branch: body?.target_branch ?? state.targetBranch,
        title: body?.title ?? `${state.sourceBranch} -> ${state.targetBranch}`,
      });
      return;
    }

    const single = url.pathname.match(
      new RegExp(`^/api/v4/projects/${PROJECT_ENCODED}/merge_requests/(\\d+)$`),
    );
    if (single !== null && request.method === 'GET') {
      sendJson(response, 200, {
        iid: Number(single[1]),
        web_url: `https://gitlab.example.com/${PROJECT}/-/merge_requests/${single[1]}`,
        state: state.mrState,
        source_branch: state.sourceBranch,
        target_branch: state.targetBranch,
        title: `${state.sourceBranch} -> ${state.targetBranch}`,
      });
      return;
    }

    const notes = url.pathname.match(
      new RegExp(`^/api/v4/projects/${PROJECT_ENCODED}/merge_requests/(\\d+)/notes$`),
    );
    if (notes !== null && request.method === 'GET') {
      sendJson(response, 200, cloneJson(state.notes));
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

// ---------------------------------------------------------------------------
// Harness: real git/store/delivery/review + loopback mock + fake runner/exec
// ---------------------------------------------------------------------------

const cleanups = [];

function buildMr({ branch, iid, rounds = 0, verdict = 'unknown', blockingIssues = [], nonBlockingIssues = [] }) {
  return {
    iid,
    url: `https://gitlab.example.com/${PROJECT}/-/merge_requests/${iid}`,
    sourceBranch: branch.name,
    targetBranch: branch.target,
    state: 'opened',
    verdict,
    blockingIssues: cloneJson(blockingIssues),
    nonBlockingIssues: cloneJson(nonBlockingIssues),
    rounds,
  };
}

async function seedTicket(domain, {
  code,
  workflow,
  branch,
  mr = null,
  reviewRounds = [],
  fixes = [],
  plan = PLAN,
  title = '登录按钮无响应',
} = {}) {
  const ticket = initialTicket({ code, title, url: TICKET_URL }, STORE_TIME);
  ticket.workflow = workflow;
  ticket.plan = plan === null ? null : cloneJson(plan);
  ticket.branch = branch === null ? null : cloneJson(branch);
  ticket.mr = mr === null ? null : cloneJson(mr);
  ticket.reviewRounds = cloneJson(reviewRounds);
  ticket.fixes = cloneJson(fixes);
  ticket.updatedAt = STORE_TIME;
  await domain.table('tickets').put(code, ticket);
  return ticket;
}

async function createHarness(options = {}) {
  const code = options.code ?? MAIN_CODE;
  const fixture = createRepoFixture({
    code,
    branchName: options.branchName ?? MAIN_BRANCH,
  });

  let mock;
  try {
    mock = await createMockGitlab({
      iid: options.mrIid ?? 77,
      mrState: options.mrState ?? 'opened',
      branchName: options.branchName ?? MAIN_BRANCH,
      targetBranch: options.targetBranch ?? TARGET_BRANCH,
      notes: options.notes ?? [],
      openMergeRequests: options.openMergeRequests ?? [],
    });

    const domain = createFakeDomain();
    const baseStore = createStore(domain, () => STORE_TIME);
    const store = typeof options.storeFactory === 'function'
      ? options.storeFactory(baseStore, code)
      : baseStore;
    const tokenStore = createFakeTokenStore(options.token === undefined ? TOKEN : options.token);

    const gitCalls = [];
    const git = createGit({
      execFile: (file, args, execOptions) => {
        gitCalls.push({ file, args: [...args] });
        return execFileAsync(file, args, execOptions);
      },
    });

    // ONE real lock shared by delivery and the review-fix job (the same
    // `createRepoLock()` instance index.js injects into both services).
    const lock = createRepoLock();
    const exec = createFakeExec(options.exec);
    const runner = createFakeRunner();
    const timer = createFakeTimer();
    const clock = createServiceClock();

    const gitlabClientFor = (settings) => createGitlabClient({
      baseUrl: settings.gitlabBaseUrl,
      tokenProvider: () => tokenStore.get(),
    });

    const delivery = createDeliveryService({
      store,
      git,
      tokenStore,
      gitlabClientFor,
      clock,
      lock,
      execCommand: exec.exec,
      drainTimeoutMs: 200,
    });
    const review = createReviewService({
      store,
      git,
      runner,
      tokenStore,
      gitlabClientFor,
      clock,
      lock,
      drainTimeoutMs: 200,
    });

    await baseStore.putSettings(fixture.repo, {
      gitlabBaseUrl: mock.url,
      gitlabProjectPath: PROJECT,
      branchUser: 'ly',
      commitType: 'fix',
      lintCommand: 'npm run lint',
      testCommand: 'npm test',
      ...options.settings,
    });

    if (options.dirty === true) {
      writeFileSync(join(fixture.worktree, 'readme.md'), 'hello\nhuman fix\n');
      writeFileSync(join(fixture.worktree, 'fix-note.txt'), 'new file from the fix run\n');
    }

    const branch = {
      ...(options.branch ?? {
        ...BRANCH,
        name: options.branchName ?? BRANCH.name,
        target: options.targetBranch ?? BRANCH.target,
      }),
      worktree: fixture.worktree,
    };
    const mr = options.mr === undefined
      ? buildMr({
        branch,
        iid: options.mrIid ?? 77,
        rounds: options.rounds ?? 0,
        verdict: options.verdict ?? 'unknown',
        blockingIssues: options.blockingIssues ?? [],
        nonBlockingIssues: options.nonBlockingIssues ?? [],
      })
      : options.mr;

    if (options.seed !== false) {
      await seedTicket(domain, {
        code,
        workflow: options.workflow ?? 'mr_open',
        branch,
        mr,
        reviewRounds: options.reviewRounds ?? [],
        fixes: options.fixes ?? [],
        plan: options.plan,
        title: options.title,
      });
    }

    if (options.seedContext === true) {
      await store.setMeta(DELIVERY_CONTEXT_META_PREFIX + code, {
        sessionId: SESSION_ID,
        cwd: fixture.repo,
        gitlabBaseUrl: mock.url,
        gitlabProjectPath: PROJECT,
        commitType: 'fix',
      });
    }
    if (options.lastNoteId !== undefined) {
      await store.setMeta(REVIEW_LAST_NOTE_META_PREFIX + code, { id: options.lastNoteId });
    }
    if (options.pendingRecord !== undefined) {
      await store.setMeta(REVIEW_FIX_COMMIT_META_PREFIX + code, options.pendingRecord);
    }

    let closed = false;
    async function close() {
      if (closed) return;
      closed = true;
      try {
        await review.dispose();
      } catch {
        // teardown only
      }
      try {
        await delivery.dispose();
      } catch {
        // teardown only
      }
      try {
        await mock.close();
      } catch {
        // teardown only
      }
      try {
        fixture.cleanup();
      } catch {
        // teardown only
      }
    }

    const harness = {
      code,
      fixture,
      mock,
      domain,
      baseStore,
      store,
      tokenStore,
      git,
      gitCalls,
      lock,
      exec,
      runner,
      timer,
      delivery,
      review,
      branch,
      close,
    };
    cleanups.push(harness);
    return harness;
  } catch (error) {
    try {
      await mock?.close();
    } catch {
      // teardown only
    }
    fixture.cleanup();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Async wait helpers
// ---------------------------------------------------------------------------

async function settle(turns = 3) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitFor(predicate, label, limit = 6_000) {
  for (let index = 0; index < limit; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForIdle(service, label) {
  await waitFor(() => service.status().running.length === 0, label);
  // The job's finally block (lock release) runs after the running set clears.
  await settle(3);
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function assertPushRejected(branch) {
  let error;
  try {
    assertPushableBranch(branch);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `assertPushableBranch(${branch}) should throw`);
  assert.equal(error.code, 'protected-branch', `${branch} should be protected`);
}

function assertNoForcedGit(gitCalls) {
  for (const call of gitCalls) {
    for (const arg of call.args) {
      assert.notEqual(arg, '--force', `forced git push leaked: ${call.args.join(' ')}`);
      assert.notEqual(arg, '--force-with-lease', `forced git push leaked: ${call.args.join(' ')}`);
      assert.notEqual(arg, '-f', `forced git push leaked: ${call.args.join(' ')}`);
    }
  }
}

function gitPushCalls(harness) {
  return harness.gitCalls.filter(
    (call) => call.args[0] === '-C' && call.args[2] === 'push',
  );
}

// ---------------------------------------------------------------------------
// Main chain: submitting -> delivery/MR -> review rounds -> done
// ---------------------------------------------------------------------------

async function runMainChain() {
  section('main chain');

  const h = await createHarness({
    code: MAIN_CODE,
    dirty: true,
    // The GitLab delivery flow is retired from the board, so the archived chain
    // starts at `submitting` directly. (`mark_test_passed` now archives
    // fix_done -> done, which would bypass delivery.)
    workflow: 'submitting',
    seedContext: false,
    settings: { lintCommand: 'npm run lint', testCommand: 'npm test' },
  });

  // 1. Seeded at the archived entry state.
  let ticket = h.store.get(MAIN_CODE);
  assert.equal(ticket.workflow, 'submitting');
  assert.equal(ticket.branch.name, MAIN_BRANCH);
  assert.equal(ticket.branch.target, TARGET_BRANCH);
  pass('ticket seeded at submitting', `code=${MAIN_CODE} name="${ticket.title}" worktree=${displayPath(h.fixture.root, h.fixture.worktree)}`);

  // 2. Delivery (lint/test -> commit -> push -> MR).
  const started = await h.delivery.start(SESSION_ID, h.fixture.repo, MAIN_CODE);
  assert.deepEqual(started, { ok: true, running: true });
  pass('delivery.start accepted', '{ok:true, running:true} (background job)');

  await waitForIdle(h.delivery, 'delivery job');
  assert.deepEqual(h.exec.calls.map((call) => call.command), ['npm run lint', 'npm test']);
  for (const call of h.exec.calls) {
    assert.equal(call.options.cwd, h.fixture.worktree);
    assert.equal(call.options.timeoutMs, 300_000);
  }
  pass('lint/test executed in worktree', `commands=${h.exec.calls.map((call) => call.command).join(',')} cwd=${displayPath(h.fixture.root, h.fixture.worktree)} timeoutMs=300000`);

  const deliveryMessage = gitSync(h.fixture.worktree, ['log', '-1', '--format=%B']);
  const deliverySha = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);
  assert.equal(deliveryMessage, `fix: 【jira单号】：${MAIN_CODE}，【开发内容】：${PLAN.summary}`);
  assert.equal(gitSync(h.fixture.worktree, ['status', '--porcelain']), '');
  assert.equal(gitSync(h.fixture.repo, ['rev-parse', 'HEAD']), gitSync(h.fixture.worktree, ['rev-parse', 'HEAD~1']));
  pass('team commit created', `sha=${deliverySha} message=${deliveryMessage}`);

  assert.equal(bareRef(h.fixture.origin, `refs/heads/${MAIN_BRANCH}`), deliverySha);
  assert.equal(
    gitSync(h.fixture.worktree, ['rev-parse', '--abbrev-ref', '@{upstream}']),
    `origin/${MAIN_BRANCH}`,
  );
  pass('push landed on bare origin', `refs/heads/${MAIN_BRANCH}=${deliverySha} upstream=origin/${MAIN_BRANCH}`);

  const creates = h.mock.requests.filter((request) => request.method === 'POST');
  assert.equal(creates.length, 1);
  const create = creates[0];
  assert.equal(create.path, `/api/v4/projects/${PROJECT_ENCODED}/merge_requests`);
  assert.deepEqual(create.body, {
    source_branch: MAIN_BRANCH,
    target_branch: TARGET_BRANCH,
    title: `${MAIN_BRANCH} -> ${TARGET_BRANCH}`,
    description: [
      `工单：${TICKET_URL}`,
      `方案摘要：${PLAN.summary}`,
      '提交前检查：lint 已通过，test 已通过',
      `提交：${deliverySha}`,
    ].join('\n'),
    remove_source_branch: false,
  });
  assert.equal(Object.hasOwn(create.body, 'reviewer_ids'), false);
  pass('MR created', `title="${create.body.title}" remove_source_branch=${create.body.remove_source_branch} reviewer_ids=absent`);

  ticket = h.store.get(MAIN_CODE);
  assert.equal(ticket.workflow, 'mr_open');
  assert.deepEqual(ticket.mr, {
    iid: 77,
    url: `https://gitlab.example.com/${PROJECT}/-/merge_requests/77`,
    sourceBranch: MAIN_BRANCH,
    targetBranch: TARGET_BRANCH,
    state: 'opened',
    verdict: 'unknown',
    blockingIssues: [],
    nonBlockingIssues: [],
    rounds: 0,
  });
  assert.deepEqual(ticket.reviewRounds, []);
  const deliveryKinds = ticket.timeline.map((event) => event.kind);
  assert.ok(deliveryKinds.includes('submit_mr'));
  assert.ok(deliveryKinds.includes('mr_created'));
  pass('ticket mr_open', `mr.iid=${ticket.mr.iid} rounds=${ticket.mr.rounds} reviewRounds=${ticket.reviewRounds.length} timeline=${deliveryKinds.join(',')}`);

  const context = h.store.getMeta(DELIVERY_CONTEXT_META_PREFIX + MAIN_CODE);
  assert.deepEqual(context, {
    sessionId: SESSION_ID,
    cwd: h.fixture.repo,
    gitlabBaseUrl: h.mock.url,
    gitlabProjectPath: PROJECT,
    commitType: 'fix',
  });
  assert.equal(JSON.stringify(context).includes(TOKEN), false);
  assert.equal(h.store.getMeta(DELIVERY_ERROR_META_PREFIX + MAIN_CODE), null);
  assert.deepEqual(h.delivery.status(), { running: [], errors: {} });
  pass('delivery context persisted', `sessionId=${context.sessionId} project=${context.gitlabProjectPath} token=absent delivery.error=null`);

  // 3. Review tick #1 through the captured 60 s interval callback.
  const parsedChanges = parseReview(CHANGES_BODY_WITH_HIDDEN);
  assert.equal(parsedChanges.verdict, 'changes');
  assert.equal(parsedChanges.blocking.length, 1);
  assert.equal(parsedChanges.nonBlocking.length, 1);
  h.mock.state.notes.push(
    gitlabNote(9100, CHANGES_BODY_WITH_HIDDEN, '2026-11-07T04:00:40.000Z'),
    gitlabNote(9101, OTHER_BOT_BODY, '2026-11-07T04:00:50.000Z', { username: 'other-bot' }),
    gitlabNote(9102, AI_NO_VERDICT_BODY, '2026-11-07T04:00:45.000Z'),
    gitlabNote(9103, SYSTEM_NOTE_BODY, '2026-11-07T04:00:55.000Z', { username: 'gitlab', system: true }),
  );

  assert.equal(h.review.start(h.timer), true);
  assert.equal(h.timer.intervals.length, 1);
  assert.equal(h.timer.intervals[0].delay, 60_000);
  pass('review poll timer registered', `delay=${h.timer.intervals[0].delay}ms`);

  const tick1Promise = (() => {
    h.timer.intervals[0].callback();
    return h.review.tick();
  })();
  const tick1 = await tick1Promise;
  assert.equal(tick1.transitioned, 1);
  ticket = h.store.get(MAIN_CODE);
  assert.equal(
    ticket.workflow,
    'fixing_review',
    `tick1 workflow=${ticket.workflow} blockedReason=${ticket.blockedReason} reviewError=${h.store.getMeta(REVIEW_ERROR_META_PREFIX + MAIN_CODE)}`,
  );
  assert.equal(ticket.mr.rounds, 1);
  assert.equal(ticket.mr.verdict, 'changes');
  assert.deepEqual(ticket.mr.blockingIssues, parsedChanges.blocking);
  assert.deepEqual(ticket.mr.nonBlockingIssues, parsedChanges.nonBlocking);
  pass('review tick #1 (interval callback): 需要修改', `workflow mr_open -> fixing_review rounds=${ticket.mr.rounds} blocking=${ticket.mr.blockingIssues.length} nonBlocking=${ticket.mr.nonBlockingIssues.length}`);

  await waitFor(() => h.runner.calls.length === 1, 'review-fix runner call');
  const runnerInput = h.runner.calls[0];
  assert.equal(runnerInput.sessionId, SESSION_ID);
  assert.equal(runnerInput.worktreePath, h.fixture.worktree);
  assert.equal(runnerInput.ticket.code, MAIN_CODE);
  assert.equal(runnerInput.mr.iid, 77);
  assert.deepEqual(runnerInput.findings, {
    blocking: parsedChanges.blocking,
    nonBlocking: parsedChanges.nonBlocking,
  });
  const serializedInput = JSON.stringify({ findings: runnerInput.findings, ticket: runnerInput.ticket });
  for (const secret of [HIDDEN_MARKER, 'AI_REVIEW_FINDINGS', '以下隐藏数据', 'Sensitive Content Gate']) {
    assert.equal(serializedInput.includes(secret), false, `hidden/non-AI secret leaked: ${secret}`);
  }
  const prompt = buildReviewFixPrompt({
    ticket: runnerInput.ticket,
    plan: runnerInput.plan,
    mr: runnerInput.mr,
    findings: runnerInput.findings,
    worktreePath: runnerInput.worktreePath,
  });
  for (const secret of [HIDDEN_MARKER, 'AI_REVIEW_FINDINGS', '以下隐藏数据', 'Sensitive Content Gate']) {
    assert.equal(prompt.includes(secret), false, `hidden/non-AI secret leaked into prompt: ${secret}`);
  }
  assert.match(prompt, /登录按钮/);
  pass('review-fix runner input', `session=${runnerInput.sessionId} findings=${runnerInput.findings.blocking.length}+${runnerInput.findings.nonBlocking.length} hidden-stats=absent other-bot=absent`);

  await waitForIdle(h.review, 'review-fix job');
  ticket = h.store.get(MAIN_CODE);
  assert.equal(ticket.workflow, 'mr_open');
  assert.equal(ticket.mr.rounds, 1);
  assert.equal(ticket.reviewRounds.length, 1);
  assert.equal(ticket.fixes.length, 1);
  const reviewFix = ticket.fixes[0];
  assert.equal(reviewFix.status, 'succeeded');
  assert.deepEqual(reviewFix.changedFiles, ['readme.md']);
  const reviewSha = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);
  assert.notEqual(reviewSha, deliverySha);
  assert.equal(gitSync(h.fixture.worktree, ['rev-list', '--count', 'HEAD']), '3');
  assert.equal(gitSync(h.fixture.worktree, ['status', '--porcelain']), '');
  assert.equal(bareRef(h.fixture.origin, `refs/heads/${MAIN_BRANCH}`), reviewSha);
  assert.equal(
    gitSync(h.fixture.worktree, ['log', '-1', '--format=%B']),
    `fix: 【jira单号】：${MAIN_CODE}，【开发内容】：${PLAN.summary}`,
  );
  assert.equal(h.store.getMeta(REVIEW_LAST_NOTE_META_PREFIX + MAIN_CODE).id, 9100);
  assert.equal(h.store.getMeta(REVIEW_ERROR_META_PREFIX + MAIN_CODE), null);
  pass('review-fix host commit + push', `sha=${reviewSha} changedFiles=${reviewFix.changedFiles.length} commits=3`);
  pass('review fix done', `workflow fixing_review -> mr_open rounds=${ticket.mr.rounds} reviewRounds=[${ticket.reviewRounds.map((entry) => entry.round).join(',')}] fixes=${ticket.fixes.length} note=9100`);

  // 4. Tick #2: a new pass note -> mergeable.
  h.mock.state.notes.push(gitlabNote(9200, PASS_BODY, '2026-11-07T04:02:00.000Z'));
  const tick2 = await h.review.tick();
  assert.equal(tick2.transitioned, 1);
  ticket = h.store.get(MAIN_CODE);
  assert.equal(ticket.workflow, 'mergeable');
  assert.equal(ticket.mr.verdict, 'pass');
  assert.ok(ticket.timeline.some((event) => event.kind === 'review_pass'));
  pass('review tick #2: 可直接合并', 'workflow mr_open -> mergeable verdict=pass');

  // 5. Merge detection + auto-archive (dismiss) out of the board.
  h.mock.state.mrState = 'merged';
  const tick3 = await h.review.tick();
  assert.equal(tick3.transitioned, 1);
  ticket = h.store.get(MAIN_CODE);
  assert.equal(ticket.workflow, 'merged');
  assert.equal(ticket.mr.state, 'merged');
  assert.ok(ticket.timeline.some((event) => event.kind === 'mr_merged'));
  pass('MR state merged detected', 'workflow mergeable -> merged');

  const tick4 = await h.review.tick();
  assert.equal(tick4.transitioned, 1);
  ticket = h.store.get(MAIN_CODE);
  assert.equal(ticket.workflow, 'done');
  const dismiss = ticket.timeline.find((event) => event.kind === 'dismiss');
  assert.equal(dismiss.actor, 'system');
  assert.equal(
    h.store.list().filter((entry) => entry.workflow !== 'done').some((entry) => entry.code === MAIN_CODE),
    false,
  );
  pass('next tick auto-archive', `workflow merged -> done dismiss(actor=${dismiss.actor}) board=not-visible`);

  // 6. Read-only GitLab request audit (hard boundaries: never merge/close/etc.).
  const methods = new Set(h.mock.requests.map((request) => request.method));
  assert.deepEqual([...methods].sort(), ['GET', 'POST']);
  assert.equal(h.mock.requests.filter((request) => request.method === 'POST').length, 1);
  const allowedPath = new RegExp(
    `^/api/v4/projects/${PROJECT_ENCODED}/merge_requests(?:/\\d+)?(?:/notes)?$`,
  );
  const forbiddenPath = /\/(?:merge|close|approve|unapprove|rebase|discussions|resolve|todo|reviewers)(?:\/|$)/;
  for (const request of h.mock.requests) {
    assert.match(request.path, allowedPath);
    assert.equal(forbiddenPath.test(request.path), false);
  }
  const notesRequests = h.mock.requests.filter((request) => request.path.endsWith('/notes'));
  for (const request of notesRequests) {
    assert.equal(request.query.per_page, '100');
    assert.equal(Object.hasOwn(request.query, 'page'), false);
  }
  pass('GitLab request audit', `methods=GET+POST createMR=1 forbiddenEndpoints=0 notesRequests=${notesRequests.length} per_page=100`);

  // 7. Hard-boundary checks that are cheap and read-only.
  assertNoForcedGit(h.gitCalls);
  const pushes = gitPushCalls(h);
  assert.equal(pushes.length, 2); // initial delivery + one review round
  assert.deepEqual(pushes[0].args.slice(2), ['push', '-u', 'origin', MAIN_BRANCH]);
  assert.deepEqual(pushes[1].args.slice(2), ['push', '-u', 'origin', MAIN_BRANCH]);
  pass('git command audit', `pushes=${pushes.length} refspecs=push -u origin ${MAIN_BRANCH} force=absent`);

  for (const branch of ['main', 'master', 'dev', 'develop', TARGET_BRANCH, 'hotfix-V1.2.0', 'release-V1.2.0']) {
    assertPushRejected(branch);
  }
  const pushCountBefore = gitPushCalls(h).length;
  const refusedPush = await h.git.pushBranch({ root: h.fixture.worktree, branch: 'main' });
  assert.equal(refusedPush.ok, false);
  assert.equal(refusedPush.code, 'protected-branch');
  assert.equal(gitPushCalls(h).length, pushCountBefore);
  assert.equal(bareHasBranch(h.fixture.origin, 'main'), false);
  pass('protected branch push refused', 'main/master/dev/develop/feature-*/hotfix-*/release-* => code=protected-branch (no git push spawned)');

  const protectedCode = 'BUG-PROTECTED';
  await seedTicket(h.domain, {
    code: protectedCode,
    workflow: 'submitting',
    branch: {
      name: 'main',
      target: TARGET_BRANCH,
      baseSource: 'HEAD',
      worktree: h.fixture.worktree,
      createdAt: STORE_TIME,
    },
    mr: null,
  });
  const protectedBefore = structuredClone(h.store.get(protectedCode));
  const protectedStart = await h.delivery.start(SESSION_ID, h.fixture.repo, protectedCode);
  assert.equal(protectedStart.ok, false);
  assert.equal(protectedStart.code, 'protected-branch');
  assert.deepEqual(h.store.get(protectedCode), protectedBefore);
  assert.equal(gitPushCalls(h).length, pushCountBefore);
  await h.domain.table('tickets').delete(protectedCode);
  pass('delivery refuses protected-branch ticket', 'code=protected-branch zero ticket writes zero pushes');

  const reDeliver = await h.delivery.start(SESSION_ID, h.fixture.repo, MAIN_CODE);
  assert.equal(reDeliver.ok, false);
  assert.equal(reDeliver.code, 'not-submitting');
  pass('re-delivery guard', `${MAIN_CODE} workflow=done => code=not-submitting`);

  return h;
}

// ---------------------------------------------------------------------------
// (a) N1: a stale round-1 pending-commit record must never replay for round 2
// ---------------------------------------------------------------------------

async function runStaleRecordBoundary() {
  section('boundary (a): N1 stale cross-round record');

  const code = 'BUG-N1';
  const blocking = parseReview(CHANGES_BODY).blocking;
  const nonBlocking = parseReview(CHANGES_BODY).nonBlocking;
  const h = await createHarness({
    code,
    branchName: 'feat-V1.2.0-n1',
    workflow: 'mr_open',
    rounds: 1,
    verdict: 'changes',
    blockingIssues: blocking,
    nonBlockingIssues: nonBlocking,
    reviewRounds: [{
      round: 1,
      noteId: 40,
      verdict: 'changes',
      startedAt: STORE_TIME,
      finishedAt: STORE_TIME,
      childId: 'seed-child-1',
      changedFiles: ['readme.md'],
      status: 'succeeded',
    }],
    fixes: [{
      runId: 'seed-fix-round-1',
      childId: 'seed-child-1',
      startedAt: STORE_TIME,
      finishedAt: STORE_TIME,
      changedFiles: ['readme.md'],
      diffStat: '1 file changed',
      diff: '',
      summary: 'seed round 1',
      testResult: 'ok',
      status: 'succeeded',
    }],
    lastNoteId: 40,
    notes: [gitlabNote(41, CHANGES_BODY, '2026-11-07T04:00:20.000Z')],
    seedContext: true,
  });
  const actualStaleSha = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);
  await h.store.setMeta(REVIEW_FIX_COMMIT_META_PREFIX + code, {
    sha: actualStaleSha,
    worktree: h.fixture.worktree,
    branch: 'feat-V1.2.0-n1',
    round: 1,
    noteId: 40,
    startedAt: STORE_TIME,
    finishedAt: STORE_TIME,
    changedFiles: ['readme.md'],
    diffStat: '1 file changed',
    diff: '',
    summary: 'seed round 1 pending commit',
    testResult: 'ok',
    runId: 'seed-fix-round-1',
    status: 'succeeded',
  });

  const tick = await h.review.tick();
  assert.equal(tick.transitioned, 1);
  await waitFor(() => h.runner.calls.length === 1, 'round-2 review-fix runner');
  await waitForIdle(h.review, 'round-2 review-fix job');

  const ticket = h.store.get(code);
  assert.equal(ticket.workflow, 'mr_open');
  assert.equal(ticket.mr.rounds, 2);
  assert.deepEqual(ticket.reviewRounds.map((entry) => entry.round), [1, 2]);
  assert.equal(ticket.fixes.length, 2);
  assert.equal(h.runner.calls.length, 1);
  assert.equal(h.runner.calls[0].mr.rounds, 2);
  assert.equal(h.store.getMeta(REVIEW_FIX_COMMIT_META_PREFIX + code), null);
  const head = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);
  assert.notEqual(head, actualStaleSha);
  assert.equal(gitSync(h.fixture.worktree, ['rev-list', '--count', 'HEAD']), '2');
  assert.equal(bareRef(h.fixture.origin, 'refs/heads/feat-V1.2.0-n1'), head);
  pass('stale round-1 record is not replayed', `runnerRanForRound=${h.runner.calls[0].mr.rounds} rounds=${ticket.mr.rounds} reviewRounds=[${ticket.reviewRounds.map((entry) => entry.round).join(',')}] fixes=${ticket.fixes.length} head=${head}`);
  await h.close();
}

// ---------------------------------------------------------------------------
// (b) claim failure blocks; refused transition retries one round (no duplicate)
// ---------------------------------------------------------------------------

async function runClaimBoundary() {
  section('boundary (b): claim failure / refused transition');

  const code = 'BUG-CLAIM';
  let failingStore;
  const h = await createHarness({
    code,
    branchName: 'feat-V1.2.0-claim',
    workflow: 'mr_open',
    rounds: 0,
    notes: [gitlabNote(200, CHANGES_BODY, '2026-11-07T04:00:10.000Z')],
    seedContext: true,
    storeFactory: (base, ticketCode) => {
      failingStore = createFailingLastNoteStore(base, ticketCode);
      return failingStore;
    },
  });

  const first = await h.review.tick();
  assert.equal(first.transitioned, 1);
  let ticket = h.store.get(code);
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedFrom, 'mr_open');
  assert.equal(ticket.blockedReason, 'review-save-failed');
  assert.equal(ticket.mr.rounds, 0);
  assert.equal(h.runner.calls.length, 0);
  assert.equal(h.store.getMeta(REVIEW_LAST_NOTE_META_PREFIX + code), undefined);
  pass('claim failure blocks before the round starts', `workflow mr_open -> blocked reason=review-save-failed rounds=${ticket.mr.rounds} runnerCalls=${h.runner.calls.length}`);

  failingStore.allowLastNoteWrites();
  const retried = await h.store.applyAction(code, 'retry', { actor: 'user' });
  assert.equal(retried.ok, true);
  assert.equal(retried.ticket.workflow, 'mr_open');
  const second = await h.review.tick();
  assert.equal(second.transitioned, 1);
  await waitForIdle(h.review, 'retried review-fix job');
  ticket = h.store.get(code);
  assert.equal(ticket.workflow, 'mr_open');
  assert.equal(ticket.mr.rounds, 1);
  assert.equal(ticket.reviewRounds.length, 1);
  assert.equal(ticket.fixes.length, 1);
  assert.equal(h.runner.calls.length, 1);
  pass('retry after claim recovery starts exactly one round', `rounds=${ticket.mr.rounds} reviewRounds=${ticket.reviewRounds.length} fixes=${ticket.fixes.length} runnerCalls=${h.runner.calls.length}`);
  await h.close();

  const staleCode = 'BUG-STALE';
  let staleStore;
  const h2 = await createHarness({
    code: staleCode,
    branchName: 'feat-V1.2.0-stale',
    workflow: 'mr_open',
    rounds: 0,
    notes: [gitlabNote(300, CHANGES_BODY, '2026-11-07T04:00:10.000Z')],
    seedContext: true,
    storeFactory: (base, ticketCode) => {
      staleStore = createStaleOnceStore(base, ticketCode, 'review_requests_changes');
      return staleStore;
    },
  });

  const refused = await h2.review.tick();
  assert.equal(refused.transitioned, 0);
  let staleTicket = h2.store.get(staleCode);
  assert.equal(staleTicket.workflow, 'mr_open');
  assert.equal(staleTicket.mr.rounds, 0);
  assert.equal(h2.runner.calls.length, 0);
  assert.equal(h2.store.getMeta(REVIEW_LAST_NOTE_META_PREFIX + staleCode) ?? null, null);
  pass('refused transition releases the claim (no round started)', `workflow=mr_open rounds=${staleTicket.mr.rounds} runnerCalls=${h2.runner.calls.length} claim=released`);

  const retryTick = await h2.review.tick();
  assert.equal(retryTick.transitioned, 1);
  await waitForIdle(h2.review, 'retried refused-transition job');
  staleTicket = h2.store.get(staleCode);
  assert.equal(staleTicket.workflow, 'mr_open');
  assert.equal(staleTicket.mr.rounds, 1);
  assert.equal(staleTicket.reviewRounds.length, 1);
  assert.equal(staleTicket.fixes.length, 1);
  assert.equal(h2.runner.calls.length, 1);
  pass('next tick starts exactly ONE round for the same note', `rounds=${staleTicket.mr.rounds} reviewRounds=${staleTicket.reviewRounds.length} fixes=${staleTicket.fixes.length} runnerCalls=${h2.runner.calls.length}`);
  await h2.close();
}

// ---------------------------------------------------------------------------
// (c) tampered pending-commit record (wrong sha) is discarded, never pushed
// ---------------------------------------------------------------------------

async function runTamperedRecordBoundary() {
  section('boundary (c): tampered pending-commit record');

  const code = 'BUG-TAMPER';
  const wrongSha = 'a'.repeat(40);
  const blocking = parseReview(CHANGES_BODY).blocking;
  const h = await createHarness({
    code,
    branchName: 'feat-V1.2.0-tamper',
    workflow: 'fixing_review',
    rounds: 1,
    verdict: 'changes',
    blockingIssues: blocking,
    nonBlockingIssues: [],
    reviewRounds: [],
    fixes: [],
    lastNoteId: 50,
    seedContext: true,
  });
  await h.store.setMeta(REVIEW_FIX_COMMIT_META_PREFIX + code, {
    sha: wrongSha,
    worktree: h.fixture.worktree,
    branch: 'feat-V1.2.0-tamper',
    round: 1,
    noteId: 50,
    startedAt: STORE_TIME,
    finishedAt: STORE_TIME,
    changedFiles: ['readme.md'],
    diffStat: '1 file changed',
    diff: '',
    summary: 'tampered record',
    testResult: 'ok',
    runId: 'tampered-run',
    status: 'succeeded',
  });

  const tick = await h.review.tick();
  assert.equal(tick.transitioned, 0); // recovery restart is not a transition
  await waitFor(() => h.runner.calls.length === 1, 'tampered recovery runner');
  await waitForIdle(h.review, 'tampered recovery job');

  const ticket = h.store.get(code);
  assert.equal(ticket.workflow, 'mr_open');
  assert.equal(ticket.mr.rounds, 1);
  assert.equal(ticket.reviewRounds.length, 1);
  assert.equal(ticket.fixes.length, 1);
  assert.equal(h.store.getMeta(REVIEW_FIX_COMMIT_META_PREFIX + code), null);
  const head = gitSync(h.fixture.worktree, ['rev-parse', 'HEAD']);
  assert.notEqual(head, wrongSha);
  assert.notEqual(head, gitSync(h.fixture.worktree, ['rev-parse', 'HEAD~1']));
  assert.equal(gitSync(h.fixture.worktree, ['rev-list', '--count', 'HEAD']), '2');
  assert.equal(bareRef(h.fixture.origin, 'refs/heads/feat-V1.2.0-tamper'), head);
  const pushes = gitPushCalls(h);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].args.slice(2)[0], 'push');
  assert.equal(pushes.some((call) => call.args.includes(wrongSha)), false);
  pass('tampered record discarded', `wrongSha=${wrongSha} pushed=never runnerRan=true rounds=${ticket.mr.rounds} reviewRounds=${ticket.reviewRounds.length} fixes=${ticket.fixes.length} head=${head}`);
  await h.close();
}

// ---------------------------------------------------------------------------
// (g) a main-worktree review ticket is refused before the child/commit/push
// ---------------------------------------------------------------------------

async function runMainWorktreeBoundary() {
  section('boundary (g): main-worktree review-fix refused');

  const code = 'BUG-MAIN-WT';
  const h = await createHarness({
    code,
    branchName: 'feat-V1.2.0-mainwt',
    notes: [gitlabNote(4001, CHANGES_BODY, '2026-11-07T04:00:10.000Z')],
    seedContext: true,
  });

  // Persisted branch metadata is untrusted: simulate a tampered/legacy ticket
  // that points the review fix at the repository root (the MAIN worktree) on
  // the protected `main` branch.
  let ticket = h.store.get(code);
  ticket.branch = { ...ticket.branch, name: 'main', worktree: h.fixture.repo };
  ticket.mr = { ...ticket.mr, sourceBranch: 'main' };
  await h.domain.table('tickets').put(code, ticket);

  const mainHeadBefore = gitSync(h.fixture.repo, ['rev-parse', 'HEAD']);
  const mainStatusBefore = gitSync(h.fixture.repo, ['status', '--porcelain']);

  const tick = await h.review.tick();
  assert.equal(tick.transitioned, 1); // the changes round still transitions...
  await waitForIdle(h.review, 'main-worktree refusal');

  ticket = h.store.get(code);
  assert.equal(ticket.workflow, 'blocked');
  assert.equal(ticket.blockedFrom, 'fixing_review');
  assert.equal(ticket.blockedReason, 'review-fix-failed');
  assert.equal(ticket.fixes.length, 0);
  assert.equal(ticket.reviewRounds.length, 0);
  // ...but the hard worktree/branch gate refuses before the child and git write.
  assert.equal(h.runner.calls.length, 0);
  const gitWrites = h.gitCalls.filter((call) => call.args[0] === '-C'
    && (call.args[2] === 'add' || call.args[2] === 'commit' || call.args[2] === 'push'));
  assert.deepEqual(gitWrites, []);
  assert.equal(gitSync(h.fixture.repo, ['rev-parse', 'HEAD']), mainHeadBefore);
  assert.equal(gitSync(h.fixture.repo, ['status', '--porcelain']), mainStatusBefore);
  assert.equal(h.store.getMeta(REVIEW_FIX_COMMIT_META_PREFIX + code), null);
  assert.equal(bareHasBranch(h.fixture.origin, 'main'), false);
  assert.equal(
    h.store.getMeta(REVIEW_ERROR_META_PREFIX + code),
    REVIEW_REASON_MESSAGES['review-fix-failed'],
  );
  pass(
    'main-worktree ticket refused before child/commit/push',
    `branch=main worktree=repo-root runnerCalls=${h.runner.calls.length} gitWrites=0 mainAdvanced=false reason=review-fix-failed`,
  );
  await h.close();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  console.log('P5 isolated delivery/review E2E');
  console.log(`  node=${process.version}`);
  console.log(`  isolation: temp git repos + bare origin + loopback GitLab mock only`);

  await runMainChain();
  await runStaleRecordBoundary();
  await runClaimBoundary();
  await runTamperedRecordBoundary();
  await runMainWorktreeBoundary();

  section('summary');
  console.log(`PASS ${summary.pass} / FAIL ${summary.fail}`);
  console.log('E2E PASS (exit 0)');
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  summary.fail += 1;
  console.error('\nFAIL [e2e] uncaught assertion/error');
  console.error(error?.stack ?? error);
  console.error(`\nSUMMARY: PASS ${summary.pass} / FAIL ${summary.fail}`);
  console.error('E2E FAIL (exit 1)');
} finally {
  for (const harness of [...cleanups].reverse()) {
    try {
      await harness.close();
    } catch {
      // teardown only; never mask the real result
    }
  }
  process.exitCode = exitCode;
}
