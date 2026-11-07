/**
 * HTTP client for the HT_TEAM/星瞰河山 platform REST API (P2).
 *
 * The contract is derived from the P0 spike (`docs/superpowers/spikes/
 * 2026-11-06-p0-findings.md`, Spike B):
 *
 *   - every request carries `Htwisdom-Auth: <token>` (no cookie/Basic auth);
 *   - every response is a `{ code, success, data, msg }` envelope where HTTP
 *     status and `code` move together on success (200);
 *   - the six endpoints needed by the sync engine are `user-auth-info`,
 *     paginated `task`, `task/detailByTaskCode/<code>`, `dict/business/
 *     dictionary?codes=…`, `remark/list` and `file/list` (POST).
 *
 * Contract at a glance:
 *
 *   - `createPlatformClient` validates configuration eagerly. An invalid
 *     `baseUrl` makes the factory THROW a `PlatformError`
 *     (`code:'invalid-base-url'`) before any fetch, so callers must
 *     try/catch it (or pre-validate with `normalizeBaseUrl`). Request methods,
 *     by contrast, never throw for expected failures and always resolve to a
 *     result object:
 *
 *       { ok: true, data }                                  on success
 *       { ok: false, code, status?, message }               on any expected failure
 *
 *   - Error taxonomy:
 *
 *       invalid-base-url      thrown by `createPlatformClient` (also returned
 *                              by `normalizeBaseUrl`) — configuration error
 *       invalid-request        missing/blank required argument, bad paging
 *       platform-unauthorized  HTTP 401 or envelope `code:401` — token rejected
 *       platform-not-found     HTTP 404 or envelope `code:404` — unknown task/route
 *       platform-http          any other non-2xx status; or an HTTP 2xx
 *                              failure envelope (`success:false` / `code!==200`)
 *       platform-bad-response  non-JSON body, non-object envelope, missing
 *                              `data`, or a shape the method cannot use
 *       platform-network       fetch rejection: connection failure, TLS error,
 *                              abort/timeout, or a blocked redirect (below)
 *
 *   - A 2xx failure envelope deliberately keeps `status:200` (the real HTTP
 *     status) and adds `upstreamCode` (the envelope's numeric `code`). A
 *     consumer such as Task 4 MUST NOT derive 502 from `status` alone; check
 *     `code === 'platform-http'` together with `status`/`upstreamCode`.
 *
 *   - Redirects are never followed: every fetch sets `redirect:'error'`, so a
 *     3xx response rejects and maps to `platform-network` instead of
 *     forwarding `Htwisdom-Auth` to the `Location` origin. (A custom
 *     `fetchImpl` that returns a 3xx Response without rejecting is mapped to
 *     `platform-http` with that status; the built-in fetch never does that
 *     under `redirect:'error'`.)
 *
 * Security invariants:
 *
 *   - the token is only ever written into the `Htwisdom-Auth` request header;
 *     it is never returned, logged, or interpolated into a result/error;
 *   - every message is a static Chinese template, so a token echoed by a
 *     misbehaving upstream can never leak through `message`;
 *   - `normalizeBaseUrl` rejects embedded credentials, query strings and
 *     fragments, and only accepts `http:`/`https:` (localhost is allowed for
 *     the local mock platform used by tests/live E2E).
 *
 * This module must stay dependency-free (relative imports only, no bare
 * package specifiers) because the plain-Node test runner imports it directly.
 */

/** Default request timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Dictionary codes required by the P2 UI; the endpoint rejects an empty `codes`. */
export const DICT_CODES = 'teamTaskStatus,teamTaskType,teamTaskPriority';

const AUTH_HEADER = 'Htwisdom-Auth';
const REMARK_TYPE_TASK = '001_TASK';

const USER_PATH = '/api/htwisdom-system/user-auth-info';
const TASK_LIST_PATH = '/api/htwisdom-team/task';
const TASK_DETAIL_PREFIX = '/api/htwisdom-team/task/detailByTaskCode/';
const DICT_PATH = '/api/htwisdom-system/dict/business/dictionary';
const REMARK_PATH = '/api/htwisdom-team/remark/list';
const FILE_LIST_PATH = '/api/htwisdom-team/file/list';

const MESSAGE = Object.freeze({
  invalidBaseUrl: '平台地址不合法',
  invalidRequest: '平台请求参数不合法',
  unauthorized: '平台鉴权失败，请重新配置 token',
  notFound: '平台接口或资源不存在',
  http: '平台请求失败',
  badResponse: '平台响应结构异常',
  network: '无法连接平台或请求超时',
});

/**
 * Error thrown by `createPlatformClient` for constructor-time configuration
 * problems (currently only an invalid `baseUrl`). It also exposes the same
 * structured shape the request methods return, so callers can either catch it
 * or convert with `toResult()`.
 */
export class PlatformError extends Error {
  /**
   * @param {{code: string, message: string, status?: number}} failure
   */
  constructor(failure) {
    super(failure.message);
    this.name = 'PlatformError';
    this.ok = false;
    this.code = failure.code;
    if (failure.status !== undefined) this.status = failure.status;
  }

  /** Structured result equivalent of this error (`{ok:false, code, …}`). */
  toResult() {
    const result = { ok: false, code: this.code, message: this.message };
    if (this.status !== undefined) result.status = this.status;
    return result;
  }
}

/**
 * Validate and normalize a platform base URL.
 *
 * Accepted: absolute `http:`/`https:` URLs with an optional path (kept for a
 * reverse-proxied base) and an optional port. Rejected: any other scheme,
 * embedded username/password, query string, fragment, blank input and
 * non-string input. A trailing slash is always appended so `baseUrl + path`
 * joins predictably.
 *
 * @param {unknown} input
 * @returns {{ok: true, baseUrl: string} | {ok: false, code: 'invalid-base-url', message: string}}
 */
export function normalizeBaseUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return invalidBaseUrl('平台地址不能为空');
  }

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return invalidBaseUrl('平台地址不是合法的 URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return invalidBaseUrl('平台地址只支持 http 或 https');
  }
  if (url.username !== '' || url.password !== '') {
    return invalidBaseUrl('平台地址不能包含用户名或密码');
  }
  if (url.search !== '') {
    return invalidBaseUrl('平台地址不能包含查询参数');
  }
  if (url.hash !== '') {
    return invalidBaseUrl('平台地址不能包含片段');
  }

  // Preserve a base path (reverse proxy) but normalize redundant trailing
  // slashes so the client never produces `//api/...` when concatenating.
  const pathname = url.pathname.replace(/\/+$/, '');
  return { ok: true, baseUrl: `${url.origin}${pathname}/` };
}

/**
 * Percent-encode a query string for a path. Array values become repeated
 * parameters (`taskStatusList=a&taskStatusList=b`), which is exactly what the
 * platform list endpoint expects. `undefined`/`null`/`''` values are omitted.
 *
 * @param {string} path absolute path starting with `/`
 * @param {Record<string, unknown>} [params]
 * @returns {string} `path` or `path?query`
 */
export function buildPath(path, params = {}) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new TypeError('buildPath(path) requires an absolute path starting with "/"');
  }
  if (params === null || typeof params !== 'object') {
    throw new TypeError('buildPath(path, params) requires a params object');
  }

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === undefined || item === null || item === '') continue;
      search.append(key, String(item));
    }
  }

  const query = search.toString();
  return query === '' ? path : `${path}?${query}`;
}

/**
 * Create a platform client bound to one base URL + token.
 *
 * `listMyTasks` needs the platform user id (`assigneeId`); call `getUser()`
 * first and pass `user.id` (Task 4 does exactly that). The token is expected to
 * come from `ctx.credentials`; this module never persists or returns it.
 *
 * @param {object} options
 * @param {string} options.baseUrl platform origin (localhost allowed for mocks)
 * @param {string} options.token `Htwisdom-Auth` token
 * @param {typeof fetch} [options.fetchImpl] injectable fetch for tests
 * @param {number} [options.timeoutMs] per-request timeout (default 15s)
 * @returns {{
 *   baseUrl: string,
 *   getUser: () => Promise<Result>,
 *   listMyTasks: (options?: object) => Promise<Result>,
 *   getTask: (code: string) => Promise<Result>,
 *   getDicts: () => Promise<Result>,
 *   getRemarks: (code: string) => Promise<Result>,
 *   listFiles: (taskId: string | number) => Promise<Result>,
 * }}
 * @throws {PlatformError} code `invalid-base-url` before any fetch is issued
 */
export function createPlatformClient(options = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError('createPlatformClient(options) requires an options object');
  }

  const normalized = normalizeBaseUrl(options.baseUrl);
  if (!normalized.ok) throw new PlatformError(normalized);

  const fetchImpl = options.fetchImpl ?? fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createPlatformClient() options.fetchImpl must be a function');
  }

  const baseUrl = normalized.baseUrl;
  // An empty token is deliberately not rejected here: the sync route owns the
  // "no token configured" response, and sending no header lets the platform
  // answer 401, which maps to platform-unauthorized.
  const token = typeof options.token === 'string' ? options.token : '';
  const timeoutMs = positiveInteger(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS;

  /**
   * Issue one request and unwrap the platform envelope.
   *
   * @param {{method?: string, path: string, query?: object, body?: object}} request
   */
  async function call({ method = 'GET', path, query, body }) {
    const target = `${baseUrl}${buildPath(path, query).replace(/^\/+/, '')}`;

    const headers = { Accept: 'application/json' };
    if (token !== '') headers[AUTH_HEADER] = token;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchImpl(target, {
        method,
        headers,
        body: payload,
        // Fail closed. Node's fetch follows redirects by default and forwards
        // custom headers (including Htwisdom-Auth) to the redirect target,
        // even cross-origin. `redirect:'error'` makes fetch reject instead;
        // the catch below maps that to platform-network and the token never
        // reaches another origin.
        redirect: 'error',
        // Node 22's fetch supports AbortSignal.timeout; the platform mock only
        // adds latency, so the timeout is normally exercised by tests.
        signal: AbortSignal.timeout(timeoutMs),
        credentials: 'omit',
      });
    } catch {
      return failure('platform-network', MESSAGE.network);
    }

    if (
      response === null
      || typeof response !== 'object'
      || typeof response.status !== 'number'
      || typeof response.text !== 'function'
    ) {
      return failure('platform-bad-response', MESSAGE.badResponse);
    }

    // Map the status before consuming the body, but still drain it so the
    // connection can be reused; a body read failure is a network error unless
    // the status already tells us more.
    const statusFailure = failureForStatus(response.status);
    let text;
    try {
      text = await response.text();
    } catch {
      return statusFailure ?? failure('platform-network', MESSAGE.network);
    }
    if (statusFailure !== undefined) return statusFailure;

    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      return failure('platform-bad-response', MESSAGE.badResponse);
    }
    if (!isPlainObject(envelope)) {
      return failure('platform-bad-response', MESSAGE.badResponse);
    }

    // Success is HTTP 2xx (already established) + not `success:false` + a
    // `code` of 200 whenever the envelope carries one.
    const envelopeCode = envelope.code;
    const envelopeOk = envelope.success !== false
      && (envelopeCode === undefined || envelopeCode === 200 || envelopeCode === '200');
    if (!envelopeOk) {
      const code = Number(envelopeCode);
      if (code === 401) return failure('platform-unauthorized', MESSAGE.unauthorized, 401);
      if (code === 404) return failure('platform-not-found', MESSAGE.notFound, 404);
      const result = failure('platform-http', MESSAGE.http, response.status);
      if (Number.isFinite(code)) result.upstreamCode = code;
      return result;
    }

    if (!('data' in envelope)) {
      return failure('platform-bad-response', MESSAGE.badResponse);
    }
    return { ok: true, data: envelope.data };
  }

  /** GET `/user-auth-info` → `data.user`. */
  async function getUser() {
    const result = await call({ path: USER_PATH });
    if (!result.ok) return result;
    const user = isPlainObject(result.data) ? result.data.user : undefined;
    if (!isPlainObject(user)) return failure('platform-bad-response', MESSAGE.badResponse);
    return { ok: true, data: user };
  }

  /**
   * Shared paginated task-list request: both "handled by me" and "participated
   * by me" use `GET /task` with a different user-id query parameter.
   *
   * @param {object} input raw `list*Tasks` input
   * @param {string} idField query parameter carrying the user id
   * @param {string} methodName used in the error copy
   * @returns {Promise<Result>}
   */
  async function listTasksBy(input, idField, methodName) {
    if (!isPlainObject(input)) {
      return failure('invalid-request', MESSAGE.invalidRequest);
    }

    const userId = normalizeId(input.userId ?? input.assigneeId ?? input.participantId);
    if (userId === undefined) {
      return failure('invalid-request', `${methodName} 需要 userId（先调用 getUser 获取用户 id）`);
    }

    const page = positiveInteger(input.page) ?? (input.page === undefined ? 1 : undefined);
    const size = positiveInteger(input.size) ?? (input.size === undefined ? 20 : undefined);
    if (page === undefined || size === undefined) {
      return failure('invalid-request', '分页参数 page/size 必须是正整数');
    }

    const statuses = normalizeStatusList(input.taskStatusList);
    if (statuses === undefined) {
      return failure('invalid-request', 'taskStatusList 必须是字符串或字符串数组');
    }

    const query = {
      current: page,
      size,
      [idField]: userId,
    };
    if (typeof input.descs === 'string' && input.descs.trim() !== '') query.descs = input.descs.trim();
    if (statuses.length > 0) query.taskStatusList = statuses;

    const result = await call({ path: TASK_LIST_PATH, query });
    if (!result.ok) return result;
    if (!isPlainObject(result.data) || !Array.isArray(result.data.records)) {
      return failure('platform-bad-response', MESSAGE.badResponse);
    }
    return { ok: true, data: result.data };
  }

  /**
   * GET the paginated "my tasks" list. `assigneeId` must be the platform user
   * id from `getUser()` (the query parameter is `refHandlerPersonId`, note the
   * extra `r` compared with the record field `refHandlePersonId`).
   *
   * @param {{page?: number, size?: number, assigneeId?: string|number,
   *   descs?: string, taskStatusList?: string|string[]}} [input]
   */
  function listMyTasks(input = {}) {
    return listTasksBy(input, 'refHandlerPersonId', 'listMyTasks');
  }

  /**
   * GET the paginated "participated tasks" list. The platform's task list also
   * returns issues where the user is only a participant (e.g. a bug handled by
   * someone else but with the user attached); `GET /task?participantId=<id>`
   * is that view, and the two lists are merged by the sync engine.
   *
   * @param {{page?: number, size?: number, participantId?: string|number,
   *   descs?: string, taskStatusList?: string|string[]}} [input]
   */
  function listParticipantTasks(input = {}) {
    return listTasksBy(input, 'participantId', 'listParticipantTasks');
  }

  /** GET `detailByTaskCode/<code>` → `data` (the full task record). */
  async function getTask(code) {
    const taskCode = normalizeId(code);
    if (taskCode === undefined) {
      return failure('invalid-request', 'getTask 需要非空的工单编号');
    }
    const result = await call({ path: `${TASK_DETAIL_PREFIX}${encodeURIComponent(taskCode)}` });
    if (!result.ok) return result;
    if (!isPlainObject(result.data)) return failure('platform-bad-response', MESSAGE.badResponse);
    return { ok: true, data: result.data };
  }

  /** GET the three UI dictionaries → `{teamTaskStatus, teamTaskType, teamTaskPriority}`. */
  async function getDicts() {
    const result = await call({ path: DICT_PATH, query: { codes: DICT_CODES } });
    if (!result.ok) return result;
    if (!isPlainObject(result.data)) return failure('platform-bad-response', MESSAGE.badResponse);
    return { ok: true, data: result.data };
  }

  /**
   * GET remarks for a task. The platform stores `content` as
   * `encodeURIComponent` text; decode it when possible and keep the raw value
   * when it is not valid percent-encoding.
   */
  async function getRemarks(code) {
    const taskCode = normalizeId(code);
    if (taskCode === undefined) {
      return failure('invalid-request', 'getRemarks 需要非空的工单编号');
    }
    const result = await call({
      path: REMARK_PATH,
      query: { refTaskCode: taskCode, remarkType: REMARK_TYPE_TASK },
    });
    if (!result.ok) return result;
    if (!Array.isArray(result.data)) return failure('platform-bad-response', MESSAGE.badResponse);
    return { ok: true, data: result.data.map(decodeRemark) };
  }

  /**
   * POST `file/list` with `{refBusinessIdList:[taskId]}`. The response shape is
   * not verified by P0 (the call was code-level only), so `data` is returned
   * as-is for the sync/UI layer to interpret.
   */
  async function listFiles(taskId) {
    const businessId = normalizeId(taskId);
    if (businessId === undefined) {
      return failure('invalid-request', 'listFiles 需要非空的工单 id');
    }
    return call({
      method: 'POST',
      path: FILE_LIST_PATH,
      body: { refBusinessIdList: [businessId] },
    });
  }

  return { baseUrl, getUser, listMyTasks, listParticipantTasks, getTask, getDicts, getRemarks, listFiles };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failure(code, message, status) {
  const result = { ok: false, code, message };
  if (status !== undefined) result.status = status;
  return result;
}

function invalidBaseUrl(message) {
  return { ok: false, code: 'invalid-base-url', message };
}

/**
 * Map an HTTP status to a failure before the body is parsed. 3xx normally never
 * reaches this helper because `call()` uses `redirect:'error'` (fetch rejects,
 * which becomes platform-network); a custom fetchImpl returning a 3xx Response
 * directly is reported as platform-http rather than followed.
 */
function failureForStatus(status) {
  if (status === 401) return failure('platform-unauthorized', MESSAGE.unauthorized, 401);
  if (status === 404) return failure('platform-not-found', MESSAGE.notFound, 404);
  if (status < 200 || status >= 300) {
    return failure('platform-http', `${MESSAGE.http}（HTTP ${status}）`, status);
  }
  return undefined;
}

/**
 * Decode a remark's `content` field without mutating the response object.
 * Malformed percent-encoding (bare `%`, truncated UTF-8) keeps the raw value.
 */
function decodeRemark(remark) {
  if (!isPlainObject(remark) || typeof remark.content !== 'string') return remark;
  try {
    return { ...remark, content: decodeURIComponent(remark.content) };
  } catch {
    return remark;
  }
}

/** Normalize an id (string or finite number) to a non-empty trimmed string. */
function normalizeId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return undefined;
}

/** Parse a positive integer from a number or numeric string; undefined otherwise. */
function positiveInteger(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

/** Normalize `taskStatusList`; `undefined` means an unsupported input type. */
function normalizeStatusList(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim()];
  if (!Array.isArray(value)) return undefined;
  const statuses = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') statuses.push(item.trim());
    else if (typeof item === 'number' && Number.isFinite(item)) statuses.push(String(item));
    else if (item !== undefined && item !== null) return undefined;
  }
  return statuses;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
