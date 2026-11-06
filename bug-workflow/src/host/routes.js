/**
 * Host HTTP API for the Bug workflow plugin.
 *
 * Routes (all exact, all JSON, all same-origin/loopback only):
 *
 *   GET  /bug-workflow/api/health          -> { ok, domainOpenedAt, tickets }
 *   GET  /bug-workflow/api/snapshot        -> { ok, workspace, settings, platform, dicts, tickets, serverTime }
 *   POST /bug-workflow/api/action          -> { ok, ticket } | { ok:false, code, message, ticket? }
 *                                              action:'create' + payload.code imports that
 *                                              platform task by code (see `importTask`)
 *   POST /bug-workflow/api/analyze         -> { ok, workflow:'analyzing', running }
 *                                              | { ok:false, code, message } (P3 real analysis)
 *   POST /bug-workflow/api/settings        -> { ok, settings }
 *   POST /bug-workflow/api/platform-token  -> { ok, tokenPresent } (token is only written, never read back)
 *   POST /bug-workflow/api/sync            -> { ok, synced, created, updated, total, filtered, lastSyncAt }
 *                                              | { ok:false, code, message }
 *
 * `createHandlers({ store, workspace, clock, tokenStore, analysis })` is pure over its
 * dependencies so
 * the tests can drive real `IncomingMessage`-shaped fake requests. `index.js`
 * calls `registerRoutes()` once the storage domain is open, and keeps
 * `registerUnavailableRoutes()` mounted while the domain is still opening or
 * when storage is unavailable (health 500 at a stable `stage`, other routes
 * 503). Route registration is deliberately split from handler logic: the web
 * server forbids duplicate exact paths, so a fallback must be disposed before
 * the real routes are mounted.
 *
 * Request admission (defense in depth — the Host header alone is spoofable):
 *   - transport: `socket.remoteAddress` must be loopback, AND `Host` must be a
 *     textual loopback allow-list value (no DNS resolution: rebinding-proof);
 *   - POST bodies: `Content-Type: application/json` (parameters allowed), else
 *     415 before one byte of the body is read. A cross-origin JSON `fetch`
 *     forces a CORS preflight this server never answers;
 *   - browser `Origin`, when present, must equal the request's own loopback
 *     host:port (http or https); a missing Origin stays allowed for local
 *     non-browser clients. Malformed/foreign origins are 403;
 *   - body: 64 KiB cap (413) and a 10 s read deadline (408, request destroyed).
 *
 * Error mapping (see the P1 plan's "宿主路由契约"):
 *   store invalid-input/invalid-payload/unknown-workspace/invalid-settings -> 400
 *   store action-id-reused/invalid-transition/duplicate-code             -> 409
 *   store not-found                                                      -> 404
 *   store invalid-record                                                 -> 500
 *   review-rounds-exhausted -> run `block` (actor system) first, then 409 with
 *   the blocked ticket (spec §12: exhausted rounds become a blocked ticket).
 *
 * P3 `/analyze` mapping: `ticket-not-found` 404, `invalid-state` 409,
 * `no-live-agent`/`analysis-unavailable` 503 (no wired analysis service or no
 * live session Agent), `unknown-workspace`/`invalid-code` 400, anything else 500.
 * The snapshot always carries `analysis:{running, errors}` (empty when the
 * analysis service is not wired) so the client never special-cases a missing
 * key.
 *
 * Failures are closed over: every handler is wrapped, and no handler lets an
 * exception escape into the HTTP server. The plugin loads without storage; the
 * fallback handlers are the contract for that state.
 *
 * Client-visible error messages are clipped to a short bounded string; the full
 * error goes only to the optional `log` dependency (host logger), never into an
 * HTTP response.
 */

import { ACTIONS } from './protocol.js';

/** Exact route paths; exported so index/tests/client agree on one source. */
export const API_PATHS = Object.freeze({
  health: '/bug-workflow/api/health',
  snapshot: '/bug-workflow/api/snapshot',
  action: '/bug-workflow/api/action',
  analyze: '/bug-workflow/api/analyze',
  settings: '/bug-workflow/api/settings',
  platformToken: '/bug-workflow/api/platform-token',
  sync: '/bug-workflow/api/sync',
});

/** Request-body cap for POST routes (64 KiB). */
export const MAX_BODY_BYTES = 64 * 1024;

/** Maximum time to receive a complete POST body before 408 (10 s). */
export const BODY_TIMEOUT_MS = 10_000;

/** Client-visible error messages never exceed this many characters. */
const MAX_ERROR_MESSAGE_CHARS = 300;

/** 503 message for an absent/failed credential service (never mentions a token). */
const CREDENTIALS_UNAVAILABLE_MESSAGE = '凭据服务不可用，暂时无法保存平台 token';

/** A rejected action name is echoed back truncated to this many characters. */
const MAX_ACTION_NAME_CHARS = 64;

/** HTTP method accepted by each route. */
const ROUTE_METHODS = Object.freeze({
  health: 'GET',
  snapshot: 'GET',
  action: 'POST',
  analyze: 'POST',
  settings: 'POST',
  platformToken: 'POST',
  sync: 'POST',
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

/**
 * Sync failure code -> HTTP status. Upstream 401 is the only error the user can
 * fix by re-entering the token; every other upstream/network failure is a 502
 * (bad gateway) and unexpected service failures are 500.
 */
const SYNC_ERROR_STATUS = Object.freeze({
  'no-platform-token': 400,
  'invalid-platform-config': 400,
  'unknown-workspace': 400,
  'platform-unauthorized': 401,
  'platform-network': 502,
  'platform-http': 502,
  'platform-not-found': 502,
  'platform-bad-response': 502,
  'invalid-request': 502,
  internal: 500,
});

/**
 * Import failure code -> HTTP status. A missing/unknown token or an invalid
 * code/config is a 400; an upstream 401 asks for a new token; an unknown task is
 * a 404; every other upstream/network failure is a 502.
 */
const IMPORT_ERROR_STATUS = Object.freeze({
  'invalid-code': 400,
  'no-platform-token': 400,
  'invalid-platform-config': 400,
  'platform-unauthorized': 401,
  'platform-not-found': 404,
  'platform-network': 502,
  'platform-http': 502,
  'platform-bad-response': 502,
  'invalid-request': 502,
  internal: 500,
});

/**
 * `POST /analyze` failure code -> HTTP status (P3 plan). A missing ticket is
 * 404, a state-machine refusal is 409, and "no live agent"/"service not wired"
 * is a retryable 503. Unknown codes are programming errors -> 500.
 */
const ANALYSIS_ERROR_STATUS = Object.freeze({
  'ticket-not-found': 404,
  'not-found': 404,
  'invalid-state': 409,
  'invalid-transition': 409,
  'unknown-workspace': 400,
  'invalid-code': 400,
  'invalid-input': 400,
  'invalid-payload': 400,
  'no-live-agent': 503,
  'analysis-unavailable': 503,
  internal: 500,
});

/** 503 message for a host built without the analysis service (older wiring). */
const ANALYSIS_UNAVAILABLE_MESSAGE = '分析服务不可用，请稍后重试';

/** Explicit allow-list of loopback Host header values (with optional port). */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Loopback socket addresses. `::ffff:127.0.0.1` is the IPv4-mapped form Node
 * reports for an IPv4 client on a dual-stack listener; it is still loopback.
 */
const LOOPBACK_REMOTE_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Build the seven route handlers over an already-open store.
 *
 * @param {object} deps
 * @param {object} deps.store `createStore()` result (or an equivalent double)
 * @param {{resolve: (sessionId: string) => {path: string|null, configured: boolean}}} deps.workspace
 * @param {object|null} [deps.tokenStore] `createTokenStore()` result; when null
 *   the snapshot reports `tokenPresent:false` and the token route answers 503
 * @param {object|null} [deps.sync] `createSyncService()` result; when null the
 *   sync route answers 503 and the snapshot falls back to token presence only
 * @param {((cwd: string|null, code: string) => Promise<object>)|null} [deps.importTask]
 *   `createSyncService().importTask`; when null an import request answers 503
 * @param {{service: object, runner?: object}|null} [deps.analysis]
 *   `createAnalysisService()` result (+ optional runner) for `POST /analyze` and
 *   the snapshot `analysis` block; when null `/analyze` answers 503
 *   `analysis-unavailable` and the snapshot reports empty analysis state
 * @param {() => string} [deps.clock] ISO 8601 server time for snapshots
 * @param {number|null} [deps.domainOpenedAt] domain open timestamp for health
 * @param {number} [deps.bodyTimeoutMs] POST body read deadline (default 10 s)
 * @param {((entry: {event: string, error: unknown}) => void)|null} [deps.log]
 *   optional host logger; receives full errors that are hidden from responses
 * @returns {{health: Function, snapshot: Function, action: Function, settings: Function, platformToken: Function, sync: Function}}
 */
export function createHandlers({
  store,
  workspace,
  tokenStore = null,
  sync = null,
  importTask = null,
  analysis = null,
  clock = defaultClock,
  domainOpenedAt = null,
  bodyTimeoutMs = BODY_TIMEOUT_MS,
  log = null,
} = {}) {
  assertStore(store);
  if (workspace === null || typeof workspace !== 'object' || typeof workspace.resolve !== 'function') {
    throw new TypeError('createHandlers() requires a workspace with resolve(sessionId)');
  }
  if (tokenStore !== null && tokenStore !== undefined) {
    for (const method of ['get', 'set', 'clear', 'present']) {
      if (typeof tokenStore[method] !== 'function') {
        throw new TypeError(`createHandlers() tokenStore.${method} must be a function`);
      }
    }
  }
  const tokenStoreSafe = tokenStore === undefined ? null : tokenStore;
  if (sync !== null && sync !== undefined) {
    for (const method of ['run', 'status']) {
      if (typeof sync[method] !== 'function') {
        throw new TypeError(`createHandlers() sync.${method} must be a function`);
      }
    }
  }
  const syncService = sync === undefined ? null : sync;
  if (importTask !== null && importTask !== undefined && typeof importTask !== 'function') {
    throw new TypeError('createHandlers() importTask must be a function');
  }
  const importTaskFn = importTask === undefined ? null : importTask;
  if (analysis !== null && analysis !== undefined) {
    if (typeof analysis !== 'object'
      || typeof analysis.service?.start !== 'function'
      || typeof analysis.service?.status !== 'function') {
      throw new TypeError(
        'createHandlers() analysis.service must expose start(sessionId, cwd, code) and status()',
      );
    }
  }
  const analysisDeps = analysis === undefined ? null : analysis;
  if (typeof clock !== 'function') {
    throw new TypeError('createHandlers() requires clock to be a function');
  }
  if (!Number.isFinite(bodyTimeoutMs) || bodyTimeoutMs <= 0) {
    throw new TypeError('createHandlers() requires bodyTimeoutMs to be a positive number');
  }
  if (log !== null && typeof log !== 'function') {
    throw new TypeError('createHandlers() requires log to be a function');
  }

  const safe = (handler) => wrap(handler, log);

  return {
    health: safe(async (req, res) => {
      if (!guard(req, res, ROUTE_METHODS.health)) return;
      if (!guardOrigin(req, res)) return;

      let tickets;
      try {
        tickets = store.list().length;
      } catch (error) {
        notifyLog(log, 'health-list', error);
        sendJsonSafe(res, 500, {
          ok: false,
          stage: 'list-tickets',
          error: clipMessage(errorMessage(error)),
        });
        return;
      }

      sendJsonSafe(res, 200, { ok: true, domainOpenedAt, tickets });
    }),

    snapshot: safe(async (req, res) => {
      if (!guard(req, res, ROUTE_METHODS.snapshot)) return;
      if (!guardOrigin(req, res)) return;

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
        // Task 4: platform status + dictionaries. Both readers degrade to
        // safe defaults so a failing sync/meta read cannot take down the board.
        platform: await readPlatformStatus(syncService, tokenStoreSafe),
        dicts: readDicts(store),
        // P3: analysis progress + static per-ticket errors. Absent wiring
        // reports empty state instead of an undefined key.
        analysis: readAnalysisStatus(analysisDeps),
        tickets: snapshot.tickets,
        serverTime: clock(),
      });
    }),

    action: safe(async (req, res) => {
      if (!guard(req, res, ROUTE_METHODS.action)) return;
      if (!guardJsonContentType(req, res)) return;
      if (!guardOrigin(req, res)) return;

      const body = await readJsonBody(req, bodyTimeoutMs);
      if (!body.ok) {
        sendError(res, body.status, body.code, body.message);
        if (body.destroyRequest === true) destroyRequest(req);
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
        sendError(
          res,
          400,
          'unknown-action',
          `未知动作：${clipMessage(String(action), MAX_ACTION_NAME_CHARS)}`,
        );
        return;
      }

      const payload = normalizePayload(input.payload);
      if (!payload.ok) {
        sendError(res, 400, payload.code, payload.message);
        return;
      }

      // P2 「从平台导入」 uses the existing create action with `payload.code`.
      // It must be handled before `store.applyAction('create')`, otherwise the
      // host would create a local manual ticket titled with the code instead of
      // importing the platform detail.
      const importCode = normalizeImportPayloadCode(payload.value);
      if (action === 'create' && importCode !== null) {
        if (importTaskFn === null) {
          sendError(res, 503, 'storage-unavailable', '平台导入服务不可用，请稍后重试');
          return;
        }

        const resolved = normalizeWorkspace(workspace.resolve(sessionId));
        const result = await importTaskFn(resolved.path, importCode);
        if (result?.ok === true) {
          sendJsonSafe(res, 200, { ok: true, ticket: result.ticket });
          return;
        }

        const failureCode = typeof result?.code === 'string' ? result.code : 'internal';
        const status = IMPORT_ERROR_STATUS[failureCode] ?? 500;
        sendError(
          res,
          status,
          failureCode,
          clipMessage(typeof result?.message === 'string' ? result.message : '平台工单导入失败'),
        );
        return;
      }

      // P1 actions are profile-global and do not require a bound workspace; the
      // sessionId is part of the client contract and is validated above only.
      const result = await store.applyAction(code, action, payload.value, { actionId });
      if (result?.ok === true) {
        sendJsonSafe(res, 200, { ok: true, ticket: result.ticket });
        return;
      }

      await sendActionFailure(res, store, { code, action, actionId, result, log });
    }),

    /**
     * Start the real (P3) analysis for one ticket: `{sessionId, code}`.
     *
     * The service persists `start_analysis`, then runs the read-only subagent in
     * the background; this route answers as soon as the ticket is `analyzing`.
     * A duplicate click for an already-running ticket is a 200 with
     * `running:true` rather than a second subagent. No-live-agent and an
     * unwired analysis service are retryable 503s.
     */
    analyze: safe(async (req, res) => {
      if (!guard(req, res, ROUTE_METHODS.analyze)) return;
      if (!guardJsonContentType(req, res)) return;
      if (!guardOrigin(req, res)) return;

      const body = await readJsonBody(req, bodyTimeoutMs);
      if (!body.ok) {
        sendError(res, body.status, body.code, body.message);
        if (body.destroyRequest === true) destroyRequest(req);
        return;
      }
      const input = body.value;

      const sessionId = normalizeSessionId(input.sessionId);
      if (sessionId === undefined) {
        sendError(res, 400, 'missing-session', '缺少有效的 sessionId');
        return;
      }

      const code = normalizeCode(input.code);
      if (code === undefined) {
        sendError(res, 400, 'invalid-code', '缺少有效的工单编号 code');
        return;
      }

      if (analysisDeps === null) {
        sendError(res, 503, 'analysis-unavailable', ANALYSIS_UNAVAILABLE_MESSAGE);
        return;
      }

      // The child agent must read a real workspace; an unbound session would
      // otherwise analyze the wrong directory (or none at all).
      const resolved = normalizeWorkspace(workspace.resolve(sessionId));
      if (resolved.path === null) {
        sendError(res, 400, 'unknown-workspace', '无法确定工作区路径，无法开始分析');
        return;
      }

      const result = await analysisDeps.service.start(sessionId, resolved.path, code);
      if (result?.ok === true) {
        sendJsonSafe(res, 200, {
          ok: true,
          workflow: 'analyzing',
          running: result.running === true,
        });
        return;
      }

      const failureCode = typeof result?.code === 'string' ? result.code : 'internal';
      const status = ANALYSIS_ERROR_STATUS[failureCode];
      if (status === undefined) {
        notifyLog(log, 'analysis-result', result);
        sendError(res, 500, 'internal', '分析启动失败');
        return;
      }
      sendError(
        res,
        status,
        failureCode,
        clipMessage(typeof result?.message === 'string' ? result.message : '分析启动失败'),
      );
    }),

    settings: safe(async (req, res) => {
      if (!guard(req, res, ROUTE_METHODS.settings)) return;
      if (!guardJsonContentType(req, res)) return;
      if (!guardOrigin(req, res)) return;

      const body = await readJsonBody(req, bodyTimeoutMs);
      if (!body.ok) {
        sendError(res, body.status, body.code, body.message);
        if (body.destroyRequest === true) destroyRequest(req);
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
          sendError(res, STORE_ERROR_STATUS[code], code, clipMessage(errorMessage(error)));
          return;
        }
        throw error;
      }
    }),

    /**
     * Run the platform → ticket-store sync for the caller's workspace. The
     * workspace cwd (not the session id) keys both the settings record and the
     * per-cwd single-flight in the sync service. Every failure is a structured
     * code; the mapping is in `SYNC_ERROR_STATUS` (no token/config 400,
     * upstream 401, network/upstream 502, unexpected 500).
     */
    sync: safe(async (req, res) => {
      if (!guard(req, res, ROUTE_METHODS.sync)) return;
      if (!guardJsonContentType(req, res)) return;
      if (!guardOrigin(req, res)) return;

      const body = await readJsonBody(req, bodyTimeoutMs);
      if (!body.ok) {
        sendError(res, body.status, body.code, body.message);
        if (body.destroyRequest === true) destroyRequest(req);
        return;
      }
      const input = body.value;

      const sessionId = normalizeSessionId(input.sessionId);
      if (sessionId === undefined) {
        sendError(res, 400, 'missing-session', '缺少有效的 sessionId');
        return;
      }

      if (syncService === null) {
        sendError(res, 503, 'sync-unavailable', '平台同步服务不可用，请稍后重试');
        return;
      }

      const resolved = normalizeWorkspace(workspace.resolve(sessionId));
      if (resolved.path === null) {
        // The platform base URL/project code live in workspace settings; an
        // unbound session would silently sync against the default real platform.
        sendError(res, 400, 'unknown-workspace', '无法确定工作区路径，无法同步平台工单');
        return;
      }

      const result = await syncService.run(resolved.path);
      if (result?.ok === true) {
        sendJsonSafe(res, 200, {
          ok: true,
          synced: numberOrZero(result.synced),
          created: numberOrZero(result.created),
          updated: numberOrZero(result.updated),
          total: numberOrZero(result.total),
          filtered: numberOrZero(result.filtered),
          lastSyncAt: typeof result.lastSyncAt === 'string' ? result.lastSyncAt : null,
        });
        return;
      }

      const code = typeof result?.code === 'string' ? result.code : 'internal';
      const status = SYNC_ERROR_STATUS[code] ?? 500;
      sendError(
        res,
        status,
        code,
        clipMessage(typeof result?.message === 'string' ? result.message : '平台同步失败'),
      );
    }),

    /**
     * Write or clear the platform token. The body is `{sessionId, token}`:
     * a string stores it, `null` clears it. Nothing from the credential store
     * is ever echoed: the response carries only `{ok, tokenPresent}`.
     *
     * The token is profile-global (it is not workspace-scoped), so an unbound
     * session may still configure it; only a missing/blank sessionId is
     * rejected, matching the action route's validation. The board still gates
     * the UI on a bound workspace.
     */
    platformToken: safe(async (req, res) => {
      if (!guard(req, res, ROUTE_METHODS.platformToken)) return;
      if (!guardJsonContentType(req, res)) return;
      if (!guardOrigin(req, res)) return;

      const body = await readJsonBody(req, bodyTimeoutMs);
      if (!body.ok) {
        sendError(res, body.status, body.code, body.message);
        if (body.destroyRequest === true) destroyRequest(req);
        return;
      }
      const input = body.value;

      const sessionId = normalizeSessionId(input.sessionId);
      if (sessionId === undefined) {
        sendError(res, 400, 'missing-session', '缺少有效的 sessionId');
        return;
      }

      if (tokenStoreSafe === null) {
        sendError(res, 503, 'credentials-unavailable', CREDENTIALS_UNAVAILABLE_MESSAGE);
        return;
      }

      const clear = input.token === null;
      if (!clear && typeof input.token !== 'string') {
        sendError(res, 400, 'invalid-token', 'token 必须是非空字符串，或传 null 清除');
        return;
      }

      try {
        if (clear) {
          await tokenStoreSafe.clear();
          sendJsonSafe(res, 200, { ok: true, tokenPresent: false });
          return;
        }
        await tokenStoreSafe.set(input.token);
        // Deliberately optimistic: a successful write means the token is now
        // present; reading it back is not needed (and must not leave the store).
        sendJsonSafe(res, 200, { ok: true, tokenPresent: true });
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : undefined;
        if (code === 'invalid-token') {
          sendError(res, 400, 'invalid-token', clipMessage(errorMessage(error)));
          return;
        }
        if (code === 'credentials-unavailable') {
          sendError(res, 503, 'credentials-unavailable', CREDENTIALS_UNAVAILABLE_MESSAGE);
          return;
        }
        throw error;
      }
    }),
  };
}

/**
 * Register the seven real routes on `ctx.webServer` and return a disposer.
 *
 * The caller must have opened the domain and built the store already. Register
 * this only after disposing `registerUnavailableRoutes()`: duplicate exact paths
 * are rejected by the web server.
 *
 * @param {object} ctx Cordis context carrying `webServer`
 * @param {object} deps same deps as {@link createHandlers}
 * @returns {() => void} idempotent disposer removing all seven routes
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
 * The data routes answer 503 so a client polling the board sees a
 * retryable "storage unavailable" state instead of a missing route.
 *
 * @param {object} ctx Cordis context carrying `webServer`
 * @param {{status?: string, stage?: string, error?: string}} [health] shared health state
 * @returns {() => void} idempotent disposer removing all seven routes
 */
export function registerUnavailableRoutes(ctx, health = {}) {
  const webServer = getWebServer(ctx);
  if (webServer === undefined) {
    throw new Error('bug-workflow: ctx.webServer service unavailable');
  }

  const handlers = {
    health: wrap(async (req, res) => {
      if (!guard(req, res, ROUTE_METHODS.health)) return;
      if (!guardOrigin(req, res)) return;
      answerFallbackHealth(res, health);
    }),
    snapshot: unavailableHandler(ROUTE_METHODS.snapshot, health),
    action: unavailableHandler(ROUTE_METHODS.action, health),
    analyze: unavailableHandler(ROUTE_METHODS.analyze, health),
    settings: unavailableHandler(ROUTE_METHODS.settings, health),
    platformToken: unavailableHandler(ROUTE_METHODS.platformToken, health),
    sync: unavailableHandler(ROUTE_METHODS.sync, health),
  };
  return registerHandlers(webServer, handlers);
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a handler so no exception escapes into the HTTP server. If the failure
 * happens before any response was written, answer a JSON 500; a partially sent
 * response is left untouched. The full error is handed to `log` (when present)
 * and only a clipped summary is sent to the client.
 */
function wrap(handler, log = null) {
  return async function safeHandler(req, res) {
    try {
      await handler(req, res);
    } catch (error) {
      notifyLog(log, 'internal', error);
      sendJsonSafe(res, 500, {
        ok: false,
        code: 'internal',
        message: clipMessage(errorMessage(error)),
      });
    }
  };
}

/**
 * Transport/host/method preflight, in that order:
 *   1. `socket.remoteAddress` must be loopback (a spoofable Host is not enough);
 *   2. `Host` must be a loopback allow-list value;
 *   3. the route's method must match.
 * POST media-type and Origin checks follow separately so a cross-site
 * `text/plain` POST is rejected as 415 before its Origin is even considered.
 */
function guard(req, res, method) {
  if (!isLoopbackRemote(req)) {
    sendJsonSafe(res, 403, {
      ok: false,
      code: 'forbidden-remote',
      message: '只接受本机回环地址的连接',
    });
    return false;
  }

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

/**
 * POST bodies must be announced as JSON before a single byte is consumed.
 * A cross-origin browser cannot send this media type without a CORS preflight,
 * which this server never answers; `text/plain` is the classic no-preflight
 * bypass and is rejected here.
 */
function guardJsonContentType(req, res) {
  if (isJsonContentType(req?.headers?.['content-type'])) return true;
  sendJsonSafe(res, 415, {
    ok: false,
    code: 'unsupported-media-type',
    message: 'POST 请求必须使用 application/json 内容类型',
  });
  return false;
}

/**
 * Browser cross-origin requests always carry `Origin`. It must match the
 * request's own origin (same host:port as the Host header; http or https,
 * since the local scheme depends on the deployment). A missing Origin is a
 * non-browser local client (curl, scripts) and stays allowed.
 */
function guardOrigin(req, res) {
  const reason = checkOrigin(req);
  if (reason === null) return true;
  sendJsonSafe(res, 403, {
    ok: false,
    code: 'forbidden-origin',
    message: reason,
  });
  return false;
}

function checkOrigin(req) {
  const raw = req?.headers?.origin;
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || raw.trim() === '') return 'Origin 头不合法';

  const host = normalizeHostHeader(req?.headers?.host);
  if (host === undefined) return 'Origin 与请求 Host 不一致';

  let origin;
  try {
    origin = new URL(raw);
  } catch {
    return 'Origin 头不合法';
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return 'Origin 头不合法';
  // `URL.host` normalizes IPv6 brackets and drops default ports; the validated
  // Host header uses the same textual form.
  if (origin.host.toLowerCase() !== host) return '拒绝跨站请求：Origin 与请求 Host 不一致';
  return null;
}

function sendError(res, status, code, message) {
  sendJsonSafe(res, status, { ok: false, code, message });
}

/**
 * Snapshot flag only: ask the token store whether a credential exists. A
 * missing or failing credentials service must not take the whole board down,
 * so any failure reads as `false`.
 */
async function readTokenPresent(tokenStore) {
  if (tokenStore === null || tokenStore === undefined) return false;
  try {
    return (await tokenStore.present()) === true;
  } catch {
    return false;
  }
}

/**
 * Snapshot `platform` object. The sync service is the source of truth for both
 * token presence and the last-sync meta; without it (or if its status read
 * throws) the snapshot degrades to token presence + null timestamps so the
 * board keeps rendering.
 */
async function readPlatformStatus(syncService, tokenStore) {
  if (syncService !== null && syncService !== undefined) {
    try {
      const status = await syncService.status();
      if (isPlainObject(status)) {
        return {
          tokenPresent: status.tokenPresent === true,
          lastSyncAt: typeof status.lastSyncAt === 'string' ? status.lastSyncAt : null,
          lastSyncError: typeof status.lastSyncError === 'string' ? status.lastSyncError : null,
        };
      }
    } catch {
      // Fall through to the token-only default.
    }
  }
  return {
    tokenPresent: await readTokenPresent(tokenStore),
    lastSyncAt: null,
    lastSyncError: null,
  };
}

/**
 * Snapshot `dicts` object. Always all three groups as arrays (the client never
 * special-cases a missing dictionary); a store without `getDicts()` (fake store
 * in tests, older host) or a corrupted meta record reads as empty.
 */
function readDicts(store) {
  const empty = emptyDicts();
  if (typeof store.getDicts !== 'function') return empty;

  let dicts;
  try {
    dicts = store.getDicts();
  } catch {
    return empty;
  }

  const out = emptyDicts();
  for (const group of ['status', 'type', 'priority']) {
    const entries = isPlainObject(dicts) ? dicts[group] : undefined;
    if (!Array.isArray(entries)) continue;
    out[group] = entries
      .filter((entry) => isPlainObject(entry) && typeof entry.key === 'string')
      .map((entry) => ({
        key: entry.key,
        value: typeof entry.value === 'string' ? entry.value : '',
        color: typeof entry.color === 'string' ? entry.color : '',
      }));
  }
  return out;
}

function emptyDicts() {
  return { status: [], type: [], priority: [] };
}

/**
 * Snapshot `analysis` object. The analysis service is optional (older wiring, a
 * profile without subagent services, or a failed service construction), so a
 * missing/failing `status()` degrades to empty state and the board keeps
 * rendering. Only static strings persisted by the service are exposed.
 */
function readAnalysisStatus(analysis) {
  const empty = { running: [], errors: {} };
  if (analysis === null || analysis === undefined) return empty;
  if (typeof analysis.service?.status !== 'function') return empty;

  let status;
  try {
    status = analysis.service.status();
  } catch {
    return empty;
  }
  if (!isPlainObject(status)) return empty;

  const running = Array.isArray(status.running)
    ? status.running.filter((code) => typeof code === 'string' && code !== '')
    : [];
  const errors = {};
  if (isPlainObject(status.errors)) {
    for (const [code, message] of Object.entries(status.errors)) {
      if (typeof message === 'string' && message !== '') errors[code] = message;
    }
  }
  return { running, errors };
}

/** Coerce a sync stat to a non-negative integer; anything else counts as 0. */
function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
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
      error: clipMessage(
        typeof status.error === 'string' ? status.error : 'storage domain 打开失败',
      ),
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
    error: clipMessage(
      typeof status.error === 'string'
        ? status.error
        : 'ctx.storageDomain / ctx.sessions service unavailable',
    ),
  });
}

function unavailableHandler(method, health) {
  return wrap(async (req, res) => {
    if (!guard(req, res, method)) return;
    // The media-type guard is a POST-body guard: a browser GET (notably the
    // snapshot poll) legitimately carries no Content-Type and must still reach
    // the documented retryable 503 instead of a misleading 415.
    if (method === 'POST' && !guardJsonContentType(req, res)) return;
    if (!guardOrigin(req, res)) return;
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

async function sendActionFailure(res, store, { code, action, actionId, result, log = null }) {
  const errorCode = typeof result?.code === 'string' ? result.code : undefined;
  const message = clipMessage(
    typeof result?.message === 'string' ? result.message : '动作执行失败',
  );

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
  notifyLog(log, 'store-result', result);
  sendJsonSafe(res, 500, {
    ok: false,
    code: 'internal',
    message: clipMessage(errorCode === undefined ? message : `${message} (${errorCode})`),
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

/** Sentinel that wins the body-read race when the deadline expires. */
const BODY_TIMEOUT = Symbol('bug-workflow.body-timeout');

/**
 * Read and parse one JSON object body, enforcing the 64 KiB cap and a read
 * deadline (default 10 s). On a deadline miss the caller answers 408 and then
 * destroys the stalled request (`destroyRequest` in the returned object).
 *
 * @param {object} req IncomingMessage-shaped request
 * @param {number} [timeoutMs] body read deadline
 * @returns {Promise<{ok:true, value: object} | {ok:false, status:number, code:string, message:string, destroyRequest?: boolean}>}
 */
async function readJsonBody(req, timeoutMs = BODY_TIMEOUT_MS) {
  const declared = Number(req?.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    drain(req);
    return tooLarge();
  }

  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(BODY_TIMEOUT), timeoutMs);
  });

  let outcome;
  try {
    outcome = await Promise.race([readRawBody(req), deadline]);
  } finally {
    clearTimeout(timer);
  }

  if (outcome === BODY_TIMEOUT) {
    return {
      ok: false,
      status: 408,
      code: 'body-timeout',
      message: '请求体读取超时',
      // Answer 408 first (the handler does), then drop the stalled stream.
      destroyRequest: true,
    };
  }
  if (!outcome.ok) return outcome;

  if (outcome.total === 0) {
    return {
      ok: false,
      status: 400,
      code: 'invalid-json',
      message: '请求体不能为空',
    };
  }

  let value;
  try {
    value = JSON.parse(outcome.buffer.toString('utf8'));
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

/** Accumulate the raw body without ever throwing; the cap is checked live. */
async function readRawBody(req) {
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
    return { ok: true, total, buffer: Buffer.concat(chunks) };
  } catch {
    return {
      ok: false,
      status: 400,
      code: 'invalid-json',
      message: '读取请求体失败',
    };
  }
}

/** Destroy a request whose body outlived the read deadline; never throws. */
function destroyRequest(req) {
  try {
    req?.destroy?.();
  } catch {
    // The socket may already be gone; the 408 was written first.
  }
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

/**
 * `payload.code` of a create request, when it is a non-empty string. This is
 * the 「从平台导入」 trigger; every other create (the demo ticket, which sends
 * only title/type/version) keeps the P1 local-create path. The actual code
 * validation (length/charset) belongs to `importTask`, so a bad code answers
 * 400 `invalid-code` instead of silently creating a manual ticket.
 */
function normalizeImportPayloadCode(payload) {
  if (!isPlainObject(payload)) return null;
  const value = payload.code;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
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

/** True when `socket.remoteAddress` is exactly a loopback address. */
function isLoopbackRemote(req) {
  const address = req?.socket?.remoteAddress;
  if (typeof address !== 'string') return false;
  return LOOPBACK_REMOTE_ADDRESSES.has(address.trim().toLowerCase());
}

/** True for `application/json`, ignoring parameters such as `; charset=utf-8`. */
function isJsonContentType(header) {
  if (typeof header !== 'string') return false;
  const semicolon = header.indexOf(';');
  const mediaType = (semicolon === -1 ? header : header.slice(0, semicolon)).trim().toLowerCase();
  return mediaType === 'application/json';
}

/** Lower-cased, trimmed Host header text (already validated by isLoopbackHost). */
function normalizeHostHeader(header) {
  if (typeof header !== 'string') return undefined;
  const host = header.trim().toLowerCase();
  return host === '' ? undefined : host;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Bound a client-visible message; zod reports/OS errors can be huge. */
function clipMessage(value, max = MAX_ERROR_MESSAGE_CHARS) {
  const text = typeof value === 'string' ? value : String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Best-effort host logger; a broken logger must not change the response. */
function notifyLog(log, event, error) {
  if (typeof log !== 'function') return;
  try {
    log({ event, error });
  } catch {
    // Logging is diagnostic only.
  }
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
