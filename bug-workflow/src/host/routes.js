/**
 * Host HTTP API for the Bug workflow plugin.
 *
 * Routes (all exact, all JSON, all same-origin/loopback only):
 *
 *   GET  /bug-workflow/api/health    -> { ok, domainOpenedAt, tickets }
 *   GET  /bug-workflow/api/snapshot  -> { ok, workspace, settings, tickets, serverTime }
 *   POST /bug-workflow/api/action    -> { ok, ticket } | { ok:false, code, message, ticket? }
 *   POST /bug-workflow/api/settings  -> { ok, settings }
 *
 * `createHandlers({ store, workspace, clock })` is pure over its dependencies so
 * the tests can drive real `IncomingMessage`-shaped fake requests. `index.js`
 * calls `registerRoutes()` once the storage domain is open, and keeps
 * `registerUnavailableRoutes()` mounted while the domain is still opening or
 * when storage is unavailable (health 500 at a stable `stage`, other routes
 * 503). Route registration is deliberately split from handler logic: the web
 * server forbids duplicate exact paths, so a fallback must be disposed before
 * the real routes are mounted.
 *
 * Error mapping (see the P1 plan's "宿主路由契约"):
 *   store invalid-input/invalid-payload/unknown-workspace/invalid-settings -> 400
 *   store action-id-reused/invalid-transition/duplicate-code             -> 409
 *   store not-found                                                      -> 404
 *   store invalid-record                                                 -> 500
 *   review-rounds-exhausted -> run `block` (actor system) first, then 409 with
 *   the blocked ticket (spec §12: exhausted rounds become a blocked ticket).
 *
 * Failures are closed over: every handler is wrapped, and no handler lets an
 * exception escape into the HTTP server. The plugin loads without storage; the
 * fallback handlers are the contract for that state.
 */

import { ACTIONS } from './protocol.js';

/** Exact route paths; exported so index/tests/client agree on one source. */
export const API_PATHS = Object.freeze({
  health: '/bug-workflow/api/health',
  snapshot: '/bug-workflow/api/snapshot',
  action: '/bug-workflow/api/action',
  settings: '/bug-workflow/api/settings',
});

/** Request-body cap for POST routes (64 KiB). */
export const MAX_BODY_BYTES = 64 * 1024;

/** HTTP method accepted by each route. */
const ROUTE_METHODS = Object.freeze({
  health: 'GET',
  snapshot: 'GET',
  action: 'POST',
  settings: 'POST',
});

/** Store failure code -> HTTP status. Unknown codes are protocol bugs -> 500. */
const STORE_ERROR_STATUS = Object.freeze({
  'invalid-input': 400,
  'invalid-payload': 400,
  'unknown-workspace': 400,
  'invalid-settings': 400,
  'action-id-reused': 409,
  'invalid-transition': 409,
  'duplicate-code': 409,
  'not-found': 404,
  'invalid-record': 500,
});

/** Explicit allow-list of loopback Host header values (with optional port). */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Build the four route handlers over an already-open store.
 *
 * @param {object} deps
 * @param {object} deps.store `createStore()` result (or an equivalent double)
 * @param {{resolve: (sessionId: string) => {path: string|null, configured: boolean}}} deps.workspace
 * @param {() => string} [deps.clock] ISO 8601 server time for snapshots
 * @param {number|null} [deps.domainOpenedAt] domain open timestamp for health
 * @returns {{health: Function, snapshot: Function, action: Function, settings: Function}}
 */
export function createHandlers({
  store,
  workspace,
  clock = defaultClock,
  domainOpenedAt = null,
} = {}) {
  assertStore(store);
  if (workspace === null || typeof workspace !== 'object' || typeof workspace.resolve !== 'function') {
    throw new TypeError('createHandlers() requires a workspace with resolve(sessionId)');
  }
  if (typeof clock !== 'function') {
    throw new TypeError('createHandlers() requires clock to be a function');
  }

  return {
    health: wrap(async (req, res) => {
      if (!guard(req, res, ROUTE_METHODS.health)) return;

      let tickets;
      try {
        tickets = store.list().length;
      } catch (error) {
        sendJsonSafe(res, 500, {
          ok: false,
          stage: 'list-tickets',
          error: errorMessage(error),
        });
        return;
      }

      sendJsonSafe(res, 200, { ok: true, domainOpenedAt, tickets });
    }),

    snapshot: wrap(async (req, res) => {
      if (!guard(req, res, ROUTE_METHODS.snapshot)) return;

      const sessionId = normalizeSessionId(readQueryParam(req, 'sessionId'));
      if (sessionId === undefined) {
        sendError(res, 400, 'missing-session', '缺少有效的 sessionId');
        return;
      }

      const resolved = normalizeWorkspace(workspace.resolve(sessionId));
      const snapshot = store.snapshot();
      sendJsonSafe(res, 200, {
        ok: true,
        workspace: resolved,
        settings: store.getSettings(resolved.path),
        tickets: snapshot.tickets,
        serverTime: clock(),
      });
    }),

    action: wrap(async (req, res) => {
      if (!guard(req, res, ROUTE_METHODS.action)) return;

      const body = await readJsonBody(req);
      if (!body.ok) {
        sendError(res, body.status, body.code, body.message);
        return;
      }
      const input = body.value;

      const sessionId = normalizeSessionId(input.sessionId);
      if (sessionId === undefined) {
        sendError(res, 400, 'missing-session', '缺少有效的 sessionId');
        return;
      }

      const actionId = normalizeActionId(input.actionId);
      if (actionId === undefined) {
        sendError(res, 400, 'missing-action-id', '缺少有效的 actionId');
        return;
      }

      const code = normalizeCode(input.code);
      if (code === undefined) {
        sendError(res, 400, 'missing-code', '缺少有效的工单编号 code');
        return;
      }

      const action = input.action;
      if (typeof action !== 'string' || !ACTIONS.includes(action)) {
        sendError(res, 400, 'unknown-action', `未知动作：${String(action)}`);
        return;
      }

      const payload = normalizePayload(input.payload);
      if (!payload.ok) {
        sendError(res, 400, payload.code, payload.message);
        return;
      }

      // P1 actions are profile-global and do not require a bound workspace; the
      // sessionId is part of the client contract and is validated above only.
      const result = await store.applyAction(code, action, payload.value, { actionId });
      if (result?.ok === true) {
        sendJsonSafe(res, 200, { ok: true, ticket: result.ticket });
        return;
      }

      await sendActionFailure(res, store, { code, action, actionId, result });
    }),

    settings: wrap(async (req, res) => {
      if (!guard(req, res, ROUTE_METHODS.settings)) return;

      const body = await readJsonBody(req);
      if (!body.ok) {
        sendError(res, body.status, body.code, body.message);
        return;
      }
      const input = body.value;

      const sessionId = normalizeSessionId(input.sessionId);
      if (sessionId === undefined) {
        sendError(res, 400, 'missing-session', '缺少有效的 sessionId');
        return;
      }

      if (!isPlainObject(input.settings)) {
        sendError(res, 400, 'invalid-settings', 'settings 必须是普通对象');
        return;
      }

      const resolved = normalizeWorkspace(workspace.resolve(sessionId));
      try {
        const saved = await store.putSettings(resolved.path, input.settings);
        sendJsonSafe(res, 200, { ok: true, settings: saved });
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : undefined;
        if (code !== undefined && STORE_ERROR_STATUS[code] !== undefined) {
          sendError(res, STORE_ERROR_STATUS[code], code, errorMessage(error));
          return;
        }
        throw error;
      }
    }),
  };
}

/**
 * Register the four real routes on `ctx.webServer` and return a disposer.
 *
 * The caller must have opened the domain and built the store already. Register
 * this only after disposing `registerUnavailableRoutes()`: duplicate exact paths
 * are rejected by the web server.
 *
 * @param {object} ctx Cordis context carrying `webServer`
 * @param {object} deps same deps as {@link createHandlers}
 * @returns {() => void} idempotent disposer removing all four routes
 */
export function registerRoutes(ctx, deps) {
  const webServer = getWebServer(ctx);
  if (webServer === undefined) {
    throw new Error('bug-workflow: ctx.webServer service unavailable');
  }
  return registerHandlers(webServer, createHandlers(deps));
}

/**
 * Register the fallback routes used while storage is unavailable or opening.
 *
 * Health answers the Task 2 contract: 500 `{stage:'storage-service'}` when the
 * inject never ran, 503 while opening, 500 `{stage,error}` after a failure.
 * The three data routes answer 503 so a client polling the board sees a
 * retryable "storage unavailable" state instead of a missing route.
 *
 * @param {object} ctx Cordis context carrying `webServer`
 * @param {{status?: string, stage?: string, error?: string}} [health] shared health state
 * @returns {() => void} idempotent disposer removing all four routes
 */
export function registerUnavailableRoutes(ctx, health = {}) {
  const webServer = getWebServer(ctx);
  if (webServer === undefined) {
    throw new Error('bug-workflow: ctx.webServer service unavailable');
  }

  const handlers = {
    health: wrap(async (req, res) => {
      if (!guard(req, res, ROUTE_METHODS.health)) return;
      answerFallbackHealth(res, health);
    }),
    snapshot: unavailableHandler(ROUTE_METHODS.snapshot, health),
    action: unavailableHandler(ROUTE_METHODS.action, health),
    settings: unavailableHandler(ROUTE_METHODS.settings, health),
  };
  return registerHandlers(webServer, handlers);
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a handler so no exception escapes into the HTTP server. If the failure
 * happens before any response was written, answer a JSON 500; a partially sent
 * response is left untouched.
 */
function wrap(handler) {
  return async function safeHandler(req, res) {
    try {
      await handler(req, res);
    } catch (error) {
      sendJsonSafe(res, 500, {
        ok: false,
        code: 'internal',
        message: errorMessage(error),
      });
    }
  };
}

/** Common preflight: loopback Host first, then the route's HTTP method. */
function guard(req, res, method) {
  if (!isLoopbackHost(req?.headers?.host)) {
    sendJsonSafe(res, 403, {
      ok: false,
      code: 'forbidden-host',
      message: '只接受来自本机回环地址的请求',
    });
    return false;
  }

  if (req?.method !== method) {
    sendJsonSafe(res, 405, {
      ok: false,
      code: 'method-not-allowed',
      message: `该接口仅支持 ${method}`,
    }, { allow: method });
    return false;
  }
  return true;
}

function sendError(res, status, code, message) {
  sendJsonSafe(res, status, { ok: false, code, message });
}

/** A response writer that also survives a client that already disconnected. */
function sendJsonSafe(res, status, payload, headers) {
  try {
    sendJson(res, status, payload, headers);
  } catch {
    // Nothing is left to report to; the handler still must not throw.
  }
}

function sendJson(res, status, payload, headers = {}) {
  if (res === null || res === undefined) return;
  if (res.writableEnded === true || res.headersSent === true) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function answerFallbackHealth(res, health) {
  const status = health ?? {};
  if (status.status === 'failed') {
    sendJsonSafe(res, 500, {
      ok: false,
      stage: typeof status.stage === 'string' ? status.stage : 'open-domain',
      error: typeof status.error === 'string' ? status.error : 'storage domain 打开失败',
    });
    return;
  }
  if (status.status === 'opening') {
    sendJsonSafe(res, 503, {
      ok: false,
      stage: typeof status.stage === 'string' ? status.stage : 'open-domain',
      error: 'storage domain 仍在打开',
    });
    return;
  }
  sendJsonSafe(res, 500, {
    ok: false,
    stage: typeof status.stage === 'string' ? status.stage : 'storage-service',
    error: typeof status.error === 'string'
      ? status.error
      : 'ctx.storageDomain / ctx.sessions service unavailable',
  });
}

function unavailableHandler(method, health) {
  return wrap(async (req, res) => {
    if (!guard(req, res, method)) return;
    sendJsonSafe(res, 503, {
      ok: false,
      code: 'storage-unavailable',
      message: '存储服务尚未就绪，请稍后重试',
      stage: typeof health?.stage === 'string' ? health.stage : 'storage-service',
    });
  });
}

// ---------------------------------------------------------------------------
// Action result mapping
// ---------------------------------------------------------------------------

async function sendActionFailure(res, store, { code, action, actionId, result }) {
  const errorCode = typeof result?.code === 'string' ? result.code : undefined;
  const message = typeof result?.message === 'string' ? result.message : '动作执行失败';

  if (errorCode === 'review-rounds-exhausted') {
    // Spec §12: exhausted review rounds must end in `blocked`, not just an
    // error response. The host is responsible for running the single-step
    // `block` transition; the original action stays rejected (409).
    const block = await blockAfterReviewExhausted(store, { code, actionId });
    const ticket = block?.ok === true ? block.ticket : safeGet(store, code);
    sendJsonSafe(res, 409, {
      ok: false,
      code: 'review-rounds-exhausted',
      message,
      ...(ticket === undefined ? {} : { ticket }),
      // Diagnostic only, e.g. a race already moved the ticket to done/blocked.
      ...(block?.ok === true || block?.code === undefined ? {} : { blockError: block.code }),
    });
    return;
  }

  // A retry of the rejected review action reaches the state machine after the
  // ticket is already blocked, so it can only report `invalid-transition`.
  // Reconstruct the deterministic §12 answer from the persisted block instead
  // of downgrading a lost-response retry to a different error.
  if (errorCode === 'invalid-transition' && action === 'review_requests_changes') {
    const current = safeGet(store, code);
    if (current?.workflow === 'blocked' && current.blockedReason === 'review-rounds-exhausted') {
      sendJsonSafe(res, 409, {
        ok: false,
        code: 'review-rounds-exhausted',
        message: 'Review 轮次已耗尽，工单已阻塞',
        ticket: current,
      });
      return;
    }
  }

  if (errorCode !== undefined && STORE_ERROR_STATUS[errorCode] !== undefined) {
    sendError(res, STORE_ERROR_STATUS[errorCode], errorCode, message);
    return;
  }

  // The store promises structured results; anything else is a server bug and
  // must not look like a client error.
  sendJsonSafe(res, 500, {
    ok: false,
    code: 'internal',
    message: errorCode === undefined ? message : `${message} (${errorCode})`,
  });
}

/**
 * Execute the host-owned `block` transition. A deterministic derived actionId
 * makes a retried `review_requests_changes` replay the already-blocked result
 * instead of appending a second blocked event.
 */
async function blockAfterReviewExhausted(store, { code, actionId }) {
  try {
    return await store.applyAction(
      code,
      'block',
      { reason: 'review-rounds-exhausted', actor: 'system' },
      { actionId: `${actionId}:review-rounds-exhausted` },
    );
  } catch (error) {
    return { ok: false, code: 'block-failed', message: errorMessage(error) };
  }
}

function safeGet(store, code) {
  try {
    return store.get(code);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

/**
 * Read and parse one JSON object body, enforcing the 64 KiB cap.
 * @returns {Promise<{ok:true, value: object} | {ok:false, status:number, code:string, message:string}>}
 */
async function readJsonBody(req) {
  const declared = Number(req?.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    drain(req);
    return tooLarge();
  }

  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_BODY_BYTES) {
        drain(req);
        return tooLarge();
      }
      chunks.push(buffer);
    }
  } catch {
    return {
      ok: false,
      status: 400,
      code: 'invalid-json',
      message: '读取请求体失败',
    };
  }

  if (total === 0) {
    return {
      ok: false,
      status: 400,
      code: 'invalid-json',
      message: '请求体不能为空',
    };
  }

  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {
      ok: false,
      status: 400,
      code: 'invalid-json',
      message: '请求体不是合法 JSON',
    };
  }

  if (!isPlainObject(value)) {
    return {
      ok: false,
      status: 400,
      code: 'invalid-body',
      message: '请求体必须是 JSON 对象',
    };
  }

  return { ok: true, value };
}

function tooLarge() {
  return {
    ok: false,
    status: 413,
    code: 'payload-too-large',
    message: `请求体超过 ${MAX_BODY_BYTES} 字节上限`,
  };
}

/** Drain an unread request body so the socket can be reused/closed cleanly. */
function drain(req) {
  try {
    req.resume?.();
  } catch {
    // The stream may already be destroyed; the response is still valid.
  }
}

function readQueryParam(req, name) {
  try {
    const url = new URL(typeof req?.url === 'string' ? req.url : '/', 'http://localhost');
    return url.searchParams.get(name);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Validation / normalization
// ---------------------------------------------------------------------------

function normalizeSessionId(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function normalizeActionId(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function normalizeCode(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function normalizePayload(value) {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (!isPlainObject(value)) {
    return { ok: false, code: 'invalid-payload', message: 'payload 必须是普通对象' };
  }
  return { ok: true, value };
}

function normalizeWorkspace(resolved) {
  const path = typeof resolved?.path === 'string' && resolved.path !== '' ? resolved.path : null;
  return { path, configured: path !== null && resolved?.configured === true };
}

/**
 * True for `127.0.0.1`, `localhost` and `[::1]`, with an optional numeric port.
 * The Host header is attacker-controlled during DNS rebinding, so the check is
 * a strict textual allow-list rather than a DNS resolution.
 */
function isLoopbackHost(header) {
  if (typeof header !== 'string') return false;
  const host = header.trim().toLowerCase();
  if (host === '') return false;

  let hostname;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return false;
    hostname = host.slice(1, end);
    const rest = host.slice(end + 1);
    if (rest !== '' && !/^:\d{1,5}$/.test(rest)) return false;
  } else {
    const firstColon = host.indexOf(':');
    if (firstColon === -1) {
      hostname = host;
    } else {
      if (host.indexOf(':', firstColon + 1) !== -1) return false;
      if (!/^\d{1,5}$/.test(host.slice(firstColon + 1))) return false;
      hostname = host.slice(0, firstColon);
    }
  }
  return LOOPBACK_HOSTNAMES.has(hostname);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function registerHandlers(webServer, handlers) {
  const disposers = [];
  try {
    for (const name of Object.keys(API_PATHS)) {
      const path = API_PATHS[name];
      const handler = handlers[name];
      if (typeof handler !== 'function') {
        throw new TypeError(`bug-workflow: missing handler for ${path}`);
      }
      disposers.push(webServer.register({ kind: 'exact', path, handler }));
    }
  } catch (error) {
    disposeAll(disposers);
    throw error;
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    disposeAll(disposers);
  };
}

function disposeAll(disposers) {
  for (const dispose of disposers) {
    try {
      dispose();
    } catch {
      // A route disposer must never mask teardown; best-effort is enough.
    }
  }
}

function getWebServer(ctx) {
  if (ctx?.webServer !== undefined) return ctx.webServer;
  if (typeof ctx?.get === 'function') return ctx.get('webServer');
  return undefined;
}

function defaultClock() {
  return new Date().toISOString();
}

function assertStore(store) {
  if (store === null || typeof store !== 'object') {
    throw new TypeError('createHandlers() requires an opened store');
  }
  for (const method of ['list', 'snapshot', 'get', 'applyAction', 'getSettings', 'putSettings']) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(`createHandlers() store.${method} must be a function`);
    }
  }
}
