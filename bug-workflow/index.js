/**
 * Host half of `@liyuera/dsh-bug-workflow`.
 *
 * P0 spike D: prove that this plugin's host half can start a subagent through
 * `ctx.subagents.startActivation(...)` and have that child modify a git worktree.
 *
 *   GET /bug-workflow/spike/subagent[?parent=<sessionId>]
 *
 * The route resolves an exact live parent Agent, starts a `spawn` child with
 * `delivery: 'caller'` and `cwd = bug-workflow/.tmp/worktree`, awaits the child
 * result, and answers with the worktree evidence (`git status --porcelain` and
 * the final `hello.txt`). The fixture is created by
 * `bug-workflow/scripts/make-temp-repo.mjs`.
 *
 * The route is a spike harness, not the product endpoint: it exists to capture
 * the live contract (services, event shape, parent acquisition, reload behavior)
 * in `docs/superpowers/spikes/2026-11-06-p0-findings.md`.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const BUNDLE_ROOT = dirname(fileURLToPath(import.meta.url));
const SPIKE_REPO = resolve(BUNDLE_ROOT, '.tmp', 'spike-repo');
const SPIKE_WORKTREE = resolve(BUNDLE_ROOT, '.tmp', 'worktree');
const SPIKE_ROUTE = '/bug-workflow/spike/subagent';
const SPIKE_PROVIDER = 'spawn';
const SPIKE_LABEL = 'p0-spike';
const START_TIMEOUT_MS = 120_000;
const RESULT_TIMEOUT_MS = 240_000;
const DISPOSE_TIMEOUT_MS = 10_000;
const RESULT_TEXT_LIMIT = 16_000;

/** Last Agent announced by `agent/created`; only a fallback — see `resolveParent`. */
let lastCreatedAgent;

/**
 * `webServer` is the only hard dependency: the spike must load in profiles
 * without subagents so the route can answer a typed error instead of staying
 * pending. `agents`/`subagents` are looked up per request.
 */
export const inject = ['webServer'];

export function apply(ctx) {
  // Agents that predate plugin load (including the currently running session)
  // never emit `agent/created`; this listener is a fallback for the first agent
  // created after load. The socket route prefers the live registry.
  ctx.on('agent/created', (payload) => {
    lastCreatedAgent = payload.agent;
  });

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SPIKE_ROUTE,
        handler: (req, res) => handleSpikeSubagent(ctx, req, res),
      }),
    'bug-workflow: spike D subagent route',
  );
}

/**
 * Run the spike once and answer JSON. Every failure is reported as
 * `{ ok: false, error, stage, ... }` with HTTP 500 — never thrown silently.
 * @param ctx - plugin context with `webServer` and optional `agents`/`subagents`.
 * @param req - inbound HTTP request.
 * @param res - response writer.
 */
async function handleSpikeSubagent(ctx, req, res) {
  const startedAt = Date.now();
  let stage = 'validate';
  let parentInfo;

  try {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'method not allowed; use GET', stage: 'validate' });
      return;
    }

    const url = new URL(req.url ?? SPIKE_ROUTE, 'http://127.0.0.1');
    const requestedParent = url.searchParams.get('parent');

    stage = 'validate-fixture';
    requireFixture();

    const agents = ctx.get('agents');
    const subagents = ctx.get('subagents');

    stage = 'resolve-parent';
    parentInfo = resolveParent(agents, requestedParent);
    if (parentInfo.error !== undefined) {
      sendJson(res, 500, {
        ok: false,
        error: parentInfo.error,
        stage,
        liveAgents: parentInfo.liveAgents,
        hint: 'pass ?parent=<sessionId> or open a session so a live Agent exists',
      });
      return;
    }

    if (subagents === undefined) {
      sendJson(res, 500, { ok: false, error: 'ctx.subagents service unavailable', stage: 'resolve-service' });
      return;
    }

    stage = 'snapshot-before';
    const before = await worktreeSnapshot();

    stage = 'start-activation';
    const prompt = buildPrompt();
    const activation = await subagents.startActivation({
      provider: SPIKE_PROVIDER,
      label: SPIKE_LABEL,
      delivery: 'caller',
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
      request: {
        prompt: [{ type: 'text', text: prompt }],
        parent: parentInfo.agent,
        cwd: SPIKE_WORKTREE,
      },
    });

    stage = 'await-result';
    const result = await withTimeout(activation.result, RESULT_TIMEOUT_MS, () =>
      withTimeout(activation.dispose(), DISPOSE_TIMEOUT_MS).catch(() => {}),
    );

    stage = 'snapshot-after';
    const after = await worktreeSnapshot();

    const outputText = result.output
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    stage = 'respond';
    sendJson(res, 200, {
      ok: true,
      spike: 'D',
      provider: SPIKE_PROVIDER,
      label: SPIKE_LABEL,
      delivery: 'caller',
      parent: { id: parentInfo.agent.id, via: parentInfo.via },
      liveAgents: parentInfo.liveAgents,
      childId: activation.childId,
      messageId: activation.messageId ?? null,
      cwd: SPIKE_WORKTREE,
      mainRepo: SPIKE_REPO,
      stopReason: result.stopReason,
      result: truncate(outputText),
      resultTruncated: outputText.length > RESULT_TEXT_LIMIT,
      structured: result.structured ?? null,
      diagnostic: result.diagnostic ?? null,
      files: after.files,
      porcelain: after.porcelain,
      before,
      after,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: errorMessage(error),
      stage,
      name: error?.name,
      code: typeof error?.code === 'string' ? error.code : undefined,
      stack: typeof error?.stack === 'string' ? error.stack : undefined,
      parent: parentInfo?.agent === undefined ? undefined : { id: parentInfo.agent.id, via: parentInfo.via },
      liveAgents: parentInfo?.liveAgents,
      elapsedMs: Date.now() - startedAt,
    });
  }
}

/** Fail fast with an actionable message when the spike fixture was never built. */
function requireFixture() {
  const helloPath = resolve(SPIKE_WORKTREE, 'hello.txt');
  if (!existsSync(helloPath)) {
    throw new Error(
      `spike worktree missing at ${SPIKE_WORKTREE}; run \`node bug-workflow/scripts/make-temp-repo.mjs\``,
    );
  }
}

/**
 * Resolve the exact live parent Agent for the child.
 *
 * The live `agents` service exposes `get(id)`, `list()`, and `roots()`, so no
 * disposable worker Agent is needed: this route uses the most recently
 * registered live root Agent (a top-level session Agent), which is the
 * production parent of a workflow-started child. `?parent=<sessionId>` pins an
 * exact Agent when several live sessions exist.
 *
 * Returns `{ error }` instead of throwing so the HTTP layer can answer 500.
 */
function resolveParent(agents, requestedParent) {
  if (agents === undefined) {
    return { error: 'ctx.agents service unavailable', liveAgents: undefined };
  }

  const live = typeof agents.list === 'function' ? agents.list() : [];
  const liveAgents = {
    total: live.length,
    roots: typeof agents.roots === 'function' ? agents.roots().length : 0,
  };

  if (typeof requestedParent === 'string' && requestedParent.length > 0) {
    const exact = typeof agents.get === 'function' ? agents.get(requestedParent) : undefined;
    if (exact === undefined) {
      return { error: `no live agent with id ${requestedParent}`, liveAgents };
    }
    return { agent: exact, via: 'agents.get(query.parent)', liveAgents };
  }

  const roots = typeof agents.roots === 'function' ? agents.roots() : [];
  if (roots.length > 0) {
    return { agent: roots[roots.length - 1], via: 'agents.roots()[last]', liveAgents };
  }
  if (live.length > 0) {
    return { agent: live[live.length - 1], via: 'agents.list()[last]', liveAgents };
  }
  if (lastCreatedAgent !== undefined) {
    return { agent: lastCreatedAgent, via: 'agent/created listener', liveAgents };
  }
  return { error: 'no live agent', liveAgents };
}

/** The standalone child prompt: cwd is the worktree, so a relative edit proves it. */
function buildPrompt() {
  return [
    `当前工作目录是一个 git worktree：${SPIKE_WORKTREE}（分支 spike-branch）。`,
    '请只做这一件事：',
    '1. 把相对路径 hello.txt 的内容从 hello 改成 hello p0（末尾保留一个换行）；',
    '2. 运行 git status --porcelain 确认改动；',
    '3. 在最终回复里说明改了哪些文件、hello.txt 的新内容，以及 pwd 的输出。',
    '不要 git commit，不要修改其它文件。',
  ].join('\n');
}

/** Read the worktree's uncommitted-change evidence from the host process. */
async function worktreeSnapshot() {
  const porcelain = await gitOutput(['status', '--porcelain']);
  const hello = await readFile(resolve(SPIKE_WORKTREE, 'hello.txt'), 'utf8');
  return { porcelain, hello: hello.replace(/\n$/, ''), files: parsePorcelain(porcelain) };
}

async function gitOutput(args) {
  const { stdout } = await execFileAsync('git', ['-C', SPIKE_WORKTREE, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  // Keep the leading status column: ` M hello.txt` is a two-column porcelain
  // record, and `.trim()` would turn it into `M hello.txt` (path `ello.txt`).
  return stdout.replace(/\n+$/, '');
}

/** Turn `git status --porcelain` lines into `{ status, path }` records. */
function parsePorcelain(text) {
  if (text === '') return [];
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }));
}

function sendJson(res, status, payload) {
  if (res.writableEnded || res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Bound a promise; `onTimeout` runs only when the bound itself expires. */
async function withTimeout(promise, ms, onTimeout) {
  let timer;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } catch (error) {
    if (timedOut && onTimeout !== undefined) await onTimeout(error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function truncate(text) {
  return text.length > RESULT_TEXT_LIMIT
    ? `${text.slice(0, RESULT_TEXT_LIMIT)}\n…[truncated ${text.length - RESULT_TEXT_LIMIT} chars]`
    : text;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
