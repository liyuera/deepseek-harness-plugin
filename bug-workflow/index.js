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
 * P0 spike E: prove that a domain opened through the storage service survives a
 * host-half reload. `apply` opens the `bug_workflow_spike` domain once the
 * `storageDomain` service exists and this half registers
 *
 *   GET /bug-workflow/spike/state?action=write|read[&value=<string>]
 *
 * `write` stores `{ id: 'spike', at: Date.now(), value? }` and returns the
 * record; `read` returns the stored record or `{ empty: true }`. Every failure
 * is answered as `{ ok: false, error }` with HTTP 500 and never thrown. The
 * domain handle is closed by this plugin's `ctx.effect` disposer.
 *
 * Both routes are spike harnesses, not product endpoints: they exist to capture
 * the live contract (services, event shape, parent acquisition, storage
 * persistence, reload behavior) in
 * `docs/superpowers/spikes/2026-11-06-p0-findings.md`.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

// Spike E: the storage-domain facility rejects names outside UNIT_NAME_RE
// (`/^[a-z][a-z0-9_]*$/`), so the spike name uses underscores, not hyphens.
const SPIKE_STATE_ROUTE = '/bug-workflow/spike/state';
const SPIKE_DOMAIN_NAME = 'bug_workflow_spike';
const SPIKE_DOMAIN_VERSION = 1;
const SPIKE_TABLE = 'state';
const SPIKE_RECORD_KEY = 'spike';
const DOMAIN_PACKAGE = '@deepseek-ai/dsh-storage-domain';
// A reloaded fiber can briefly race its predecessor's async `domain.close()`;
// the facility keeps the name reserved (`already-open`) until teardown ends.
const OPEN_ATTEMPTS = 20;
const OPEN_RETRY_MS = 100;

/**
 * Record schema for the spike table.
 *
 * The domain contract asks for a zod schema (`table().parse` runs on every
 * stored record at open). This bundle is linked without its own `node_modules`
 * and has no build step, so it validates the exact record shape it writes with
 * a minimal `parse`-shaped object; the findings record the real zod contract.
 */
const SPIKE_RECORD_SCHEMA = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('spike record must be a JSON object');
    }
    if (value.id !== SPIKE_RECORD_KEY) {
      throw new Error(`spike record.id must be '${SPIKE_RECORD_KEY}'`);
    }
    if (!Number.isFinite(value.at)) {
      throw new Error('spike record.at must be a finite number');
    }
    if (value.value !== undefined && typeof value.value !== 'string') {
      throw new Error('spike record.value must be a string when present');
    }
    return value;
  },
};

/** Equivalent spec used when the host package cannot be imported — see `loadDomainHelpers`. */
const SPIKE_DOMAIN_SPEC = {
  name: SPIKE_DOMAIN_NAME,
  version: SPIKE_DOMAIN_VERSION,
  tables: { [SPIKE_TABLE]: { valueSchema: SPIKE_RECORD_SCHEMA } },
};

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

  // Spike E state. `pending` stays undefined until `storageDomain` is mounted;
  // `ctx.inject` starts the open exactly when the service becomes available,
  // without making it a hard dependency of the existing spike D route.
  const spikeState = {
    status: 'waiting-for-service',
    specSource: undefined,
    domainName: SPIKE_DOMAIN_NAME,
    table: SPIKE_TABLE,
    openError: undefined,
    openedAt: undefined,
    pending: undefined,
  };

  ctx.inject(['storageDomain'], (storageCtx) => {
    spikeState.status = 'opening';
    const pending = openSpikeDomain(storageCtx.storageDomain, spikeState);
    spikeState.pending = pending;
    pending.then(
      () => {
        spikeState.status = 'open';
        spikeState.openedAt = Date.now();
      },
      (error) => {
        spikeState.status = 'failed';
        spikeState.openError = errorMessage(error);
      },
    );
    // No request may have observed the open yet; keep its rejection handled.
    pending.catch(() => {});

    // The caller owns the handle: close it when this fiber is disposed (plugin
    // unload/reload). The disposer awaits the open so a late success is closed
    // too; `close()` is idempotent, so the facility's own closeAll fallback is
    // harmless. Both the route and this effect disappear with the same fiber.
    storageCtx.effect(
      () => async () => {
        const domain = await pending.catch(() => undefined);
        if (domain !== undefined) await domain.close().catch(() => {});
      },
      'bug-workflow: spike E domain lifetime',
    );
  });

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SPIKE_STATE_ROUTE,
        handler: (req, res) => handleSpikeState(spikeState, req, res),
      }),
    'bug-workflow: spike E storage route',
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

/**
 * Handle one spike E storage read/write. Every failure becomes
 * `{ ok: false, error, stage }` with HTTP 500 — nothing escapes the handler.
 * @param spikeState - per-apply open state (see `apply`).
 * @param req - inbound HTTP request.
 * @param res - response writer.
 */
async function handleSpikeState(spikeState, req, res) {
  const startedAt = Date.now();
  let stage = 'validate';

  try {
    if (req.method !== 'GET') {
      sendJsonSafe(res, 500, {
        ok: false,
        error: 'method not allowed; use GET',
        stage,
        route: SPIKE_STATE_ROUTE,
      });
      return;
    }

    const url = new URL(req.url ?? SPIKE_STATE_ROUTE, 'http://127.0.0.1');
    const action = url.searchParams.get('action');
    if (action !== 'write' && action !== 'read') {
      sendJsonSafe(res, 500, {
        ok: false,
        error: `action must be 'write' or 'read', got ${JSON.stringify(action)}`,
        stage,
        route: SPIKE_STATE_ROUTE,
      });
      return;
    }

    stage = 'await-domain';
    if (spikeState.pending === undefined) {
      sendJsonSafe(res, 500, {
        ok: false,
        error: 'ctx.storageDomain service unavailable',
        stage: 'storage-service',
        domain: SPIKE_DOMAIN_NAME,
        status: spikeState.status,
      });
      return;
    }

    let domain;
    try {
      domain = await spikeState.pending;
    } catch (error) {
      sendJsonSafe(res, 500, {
        ok: false,
        error: `storage domain open failed: ${errorMessage(error)}`,
        stage: 'open-domain',
        code: typeof error?.code === 'string' ? error.code : undefined,
        domain: spikeState.domainName,
        specSource: spikeState.specSource,
      });
      return;
    }

    const table = domain.table(SPIKE_TABLE);
    const base = {
      ok: true,
      action,
      domain: domain.name,
      domainOpenedAt: spikeState.openedAt,
      domainOpenedAtIso: spikeState.openedAt === undefined ? undefined : new Date(spikeState.openedAt).toISOString(),
      table: SPIKE_TABLE,
      key: SPIKE_RECORD_KEY,
      specSource: spikeState.specSource,
    };

    if (action === 'write') {
      stage = 'write';
      const record = { id: SPIKE_RECORD_KEY, at: Date.now() };
      const value = url.searchParams.get('value');
      if (value !== null) record.value = value;
      await table.put(SPIKE_RECORD_KEY, record);
      sendJsonSafe(res, 200, {
        ...base,
        record,
        atIso: new Date(record.at).toISOString(),
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }

    stage = 'read';
    const record = table.get(SPIKE_RECORD_KEY);
    const payload = {
      ...base,
      record: record ?? null,
      empty: record === undefined,
      elapsedMs: Date.now() - startedAt,
    };
    if (record !== undefined) payload.atIso = new Date(record.at).toISOString();
    sendJsonSafe(res, 200, payload);
  } catch (error) {
    sendJsonSafe(res, 500, {
      ok: false,
      error: errorMessage(error),
      stage,
      code: typeof error?.code === 'string' ? error.code : undefined,
      domain: spikeState.domainName,
      specSource: spikeState.specSource,
      elapsedMs: Date.now() - startedAt,
    });
  }
}

/**
 * Load the domain declaration helpers from the copy the running host mounted.
 *
 * This bundle is a linked directory without its own `node_modules`, so a bare
 * `@deepseek-ai/dsh-storage-domain` import is not resolvable from its real path
 * on this installation. Prefer the exact package the desktop host loaded from
 * `app.asar` (Electron's `process.resourcesPath`), then try the bare specifier
 * for installed/bundled layouts, and fall back to the equivalent inline spec so
 * the spike route still answers instead of failing to load the plugin.
 * @returns `{ module, source }` or `undefined` when no copy could be imported.
 */
async function loadDomainHelpers() {
  const candidates = [];
  const resources = typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined;
  if (resources !== undefined) {
    candidates.push({
      source: 'app.asar dsh/node_modules/@deepseek-ai/dsh-storage-domain',
      specifier: pathToFileURL(
        join(
          resources,
          'app.asar',
          'dsh',
          'node_modules',
          '@deepseek-ai',
          'dsh-storage-domain',
          'lib',
          'index.js',
        ),
      ).href,
    });
  }
  candidates.push({ source: `bare ${DOMAIN_PACKAGE}`, specifier: DOMAIN_PACKAGE });

  for (const candidate of candidates) {
    try {
      const module = await import(candidate.specifier);
      if (typeof module.defineDomain === 'function' && typeof module.domainTable === 'function') {
        return { module, source: candidate.source };
      }
    } catch {
      // Try the next resolution route.
    }
  }
  return undefined;
}

/**
 * Declare and open the spike domain. `defineDomain`/`domainTable` come from the
 * host package when importable; the inline spec is shape-identical otherwise.
 * @param facility - mounted `ctx.storageDomain` facility.
 * @param spikeState - receives the resolved spec source for the route response.
 */
async function openSpikeDomain(facility, spikeState) {
  const helpers = await loadDomainHelpers();
  spikeState.specSource = helpers === undefined ? 'inline spec (defineDomain unavailable)' : helpers.source;
  const spec =
    helpers === undefined
      ? SPIKE_DOMAIN_SPEC
      : helpers.module.defineDomain({
          name: SPIKE_DOMAIN_NAME,
          version: SPIKE_DOMAIN_VERSION,
          tables: { [SPIKE_TABLE]: helpers.module.domainTable(SPIKE_RECORD_SCHEMA) },
        });
  return openWithRetry(facility, spec);
}

/**
 * Open the domain, retrying the short `already-open` window where a reloaded
 * fiber races its predecessor's asynchronous close.
 * @param facility - mounted `ctx.storageDomain` facility.
 * @param spec - domain declaration.
 */
async function openWithRetry(facility, spec) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await facility.open(spec);
    } catch (error) {
      if (error?.code !== 'already-open' || attempt >= OPEN_ATTEMPTS) throw error;
      await delay(OPEN_RETRY_MS);
    }
  }
}

/** A response writer that also survives a client that already disconnected. */
function sendJsonSafe(res, status, payload) {
  try {
    sendJson(res, status, payload);
  } catch {
    // Nothing is left to report to; the handler still must not throw.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
