/**
 * GitLab REST client for the Bug workflow delivery/review services (P5).
 *
 * The contract is derived from the P0 spike (`docs/superpowers/spikes/
 * 2026-11-06-p0-findings.md`, Spike C) and covers only what P5 needs:
 *
 *   GET  /api/v4/user
 *   GET  /api/v4/projects/:encoded/merge_requests?state=opened&source_branch=…
 *   POST /api/v4/projects/:encoded/merge_requests
 *   GET  /api/v4/projects/:encoded/merge_requests/:iid
 *   GET  /api/v4/projects/:encoded/merge_requests/:iid/notes?sort=desc&…
 *
 * The client is strictly limited to those calls: it never merges, closes,
 * approves, resolves, deletes or force-pushes anything. `createMergeRequest`
 * is the only mutating request.
 *
 * ## Configuration and errors
 *
 * `createGitlabClient` validates its options eagerly:
 *
 *   - an invalid `baseUrl` throws a {@link GitlabError} with code
 *     `invalid-project` (the taxonomy has no separate configuration code; the
 *     same static code covers a malformed base URL and a malformed project
 *     path, and the message says which one is wrong);
 *   - a non-function `fetchImpl`/`tokenProvider` throws a `TypeError`
 *     (programming error, not an expected runtime failure).
 *
 * Every request method rejects with a {@link GitlabError}. `code` is stable and
 * `message` is a fixed Chinese template that never contains the token, the
 * request URL, or any upstream text:
 *
 *   no-token             tokenProvider returned null/empty/blank (or threw);
 *                        no HTTP request is issued
 *   unauthorized         HTTP 401 — token rejected
 *   forbidden            HTTP 403 — token lacks permission
 *   not-found            HTTP 404 — unknown project/MR
 *   conflict             HTTP 409 — resource state changed
 *   rate-limited         HTTP 429 — GitLab rate limit
 *   network              fetch rejection/connection failure, or HTTP 5xx
 *                        (server-side failures are treated as transient and
 *                        retryable; `status` carries the real code)
 *   timeout              the AbortController deadline expired
 *   bad-response         a blocked redirect (3xx), non-JSON/malformed body, an
 *                        oversized body (> MAX_RESPONSE_BYTES), or a payload
 *                        shape the method cannot use; other 4xx statuses also
 *                        fall back here
 *   invalid-project      malformed `baseUrl` or `project`
 *   invalid-merge-request malformed `iid`, branch name, or MR title/description
 *
 * ## Security invariants
 *
 *   - the token is only ever written into the `PRIVATE-TOKEN` header; it never
 *     appears in a URL, a resolved value, an error, or a log;
 *   - every request sets `redirect:'error'`, so Node's fetch rejects on a 3xx
 *     instead of forwarding `PRIVATE-TOKEN` to the `Location` origin; a custom
 *     fetch implementation that returns a 3xx `Response` is rejected too;
 *   - response bodies are capped at {@link MAX_RESPONSE_BYTES} while streaming;
 *   - `project` is untrusted configuration: it must be a `group/project` path
 *     (subgroups allowed), is validated segment by segment, and is then
 *     `encodeURIComponent`-ed into a single path segment (`/` → `%2F`), so a
 *     crafted value cannot inject a path/query/fragment;
 *   - tokenProvider failures are swallowed and mapped to `no-token`; provider
 *     diagnostics are never forwarded.
 *
 * This module is dependency-free on purpose (no imports at all, including
 * `node:` builtins): it is pure over the injected `fetch`, and the plain-Node
 * test runner imports it directly.
 */

/** Default per-request timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Maximum accepted response body size (1 MiB). */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** GitLab REST API prefix. */
const API_PREFIX = '/api/v4';

/** GitLab personal/project access token header. */
const AUTH_HEADER = 'PRIVATE-TOKEN';

/** Maximum path depth accepted for a `group/subgroup/…/project` path. */
const MAX_PROJECT_SEGMENTS = 20;

/** Maximum accepted length of a full project path. */
const MAX_PROJECT_LENGTH = 1024;

/** Maximum accepted length of one project path segment. */
const MAX_PROJECT_SEGMENT_LENGTH = 255;

/** Maximum accepted branch name length (git checkpoint; mirrors branch.js). */
const MAX_BRANCH_LENGTH = 255;

const MESSAGE = Object.freeze({
  invalidBaseUrlBlank: 'GitLab 地址不能为空',
  invalidBaseUrlSyntax: 'GitLab 地址不是合法的 URL',
  invalidBaseUrlScheme: 'GitLab 地址只支持 http 或 https',
  invalidBaseUrlCredentials: 'GitLab 地址不能包含用户名或密码',
  invalidBaseUrlQuery: 'GitLab 地址不能包含查询参数',
  invalidBaseUrlHash: 'GitLab 地址不能包含片段',
  invalidProject: 'GitLab 项目路径不合法（应形如 group/project）',
  invalidMergeRequest: 'GitLab MR 参数不合法',
  noToken: '未配置 GitLab token',
  unauthorized: 'GitLab 鉴权失败，请检查 token',
  forbidden: 'GitLab 拒绝访问，token 权限不足',
  notFound: 'GitLab 项目或 MR 不存在',
  conflict: 'GitLab 请求冲突，资源状态已变化',
  rateLimited: 'GitLab 请求过于频繁，请稍后重试',
  network: '无法连接 GitLab 或服务暂时不可用',
  timeout: 'GitLab 请求超时',
  badResponse: 'GitLab 响应结构异常',
});

/**
 * Structured GitLab failure. `code` is stable; callers branch on it and never
 * parse `message` (which is always a static template). `status` is the real
 * HTTP status when one exists, for diagnostics only.
 */
export class GitlabError extends Error {
  /**
   * @param {string} code stable failure code (see the module contract)
   * @param {string} message static, token-free description
   * @param {number} [status] HTTP status if the failure came from a response
   */
  constructor(code, message, status) {
    super(message);
    this.name = 'GitlabError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Validate and normalize a GitLab base URL.
 *
 * Accepted: absolute `http:`/`https:` URLs, optionally with a base path (a
 * reverse proxy) and port. Rejected: any other scheme, embedded
 * username/password, query string, fragment, blank input, non-string input,
 * and anything the URL parser rejects. Trailing slashes are stripped; the
 * caller concatenates `/api/v4/...` paths.
 *
 * @param {unknown} input
 * @returns {{ok: true, baseUrl: string}
 *   | {ok: false, code: 'invalid-project', message: string}}
 */
export function normalizeBaseUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, code: 'invalid-project', message: MESSAGE.invalidBaseUrlBlank };
  }

  let url;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, code: 'invalid-project', message: MESSAGE.invalidBaseUrlSyntax };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: 'invalid-project', message: MESSAGE.invalidBaseUrlScheme };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, code: 'invalid-project', message: MESSAGE.invalidBaseUrlCredentials };
  }
  if (url.search !== '') {
    return { ok: false, code: 'invalid-project', message: MESSAGE.invalidBaseUrlQuery };
  }
  if (url.hash !== '') {
    return { ok: false, code: 'invalid-project', message: MESSAGE.invalidBaseUrlHash };
  }

  // Preserve a reverse-proxy base path but normalize trailing slashes so the
  // client never produces `//api/v4/...` when concatenating.
  const pathname = url.pathname.replace(/\/+$/, '');
  return { ok: true, baseUrl: `${url.origin}${pathname}` };
}

/**
 * Validate a GitLab project path and encode it as ONE URL path segment.
 *
 * `project` comes from untrusted workspace configuration. It must be a
 * `namespace/project` path (GitLab subgroups are allowed, hence at least two
 * segments); a bare segment is rejected because the API also accepts numeric
 * project ids and this client deliberately supports path ids only.
 *
 * Rejected: blank/non-string values, surrounding or embedded whitespace,
 * leading/trailing/double slashes, `.`/`..` segments, `%` (pre-encoded input),
 * backslash, `?`, `#`, control characters, more than
 * {@link MAX_PROJECT_SEGMENTS} segments, and oversized values. The returned
 * `encoded` is `encodeURIComponent(project)`, so `/` becomes `%2F`.
 *
 * @param {unknown} input
 * @returns {{ok: true, project: string, encoded: string}
 *   | {ok: false, code: 'invalid-project', message: string}}
 */
export function normalizeProject(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, code: 'invalid-project', message: MESSAGE.invalidProject };
  }
  if (input.length > MAX_PROJECT_LENGTH) {
    return { ok: false, code: 'invalid-project', message: MESSAGE.invalidProject };
  }
  // Reject surrounding/embedded whitespace, including non-ASCII whitespace.
  if (/\s/.test(input)) {
    return { ok: false, code: 'invalid-project', message: MESSAGE.invalidProject };
  }
  // Characters that would either need double encoding or could confuse a
  // reviewer reading the URL/logs. encodeURIComponent would neutralize most of
  // them, but pre-encoded input (`%2F`) must never be accepted as a path.
  if (/[%\\?#]/.test(input) || /[\u0000-\u001f\u007f]/.test(input)) {
    return { ok: false, code: 'invalid-project', message: MESSAGE.invalidProject };
  }

  const segments = input.split('/');
  if (segments.length < 2 || segments.length > MAX_PROJECT_SEGMENTS) {
    return { ok: false, code: 'invalid-project', message: MESSAGE.invalidProject };
  }
  for (const segment of segments) {
    if (
      segment === ''
      || segment === '.'
      || segment === '..'
      || segment.length > MAX_PROJECT_SEGMENT_LENGTH
    ) {
      return { ok: false, code: 'invalid-project', message: MESSAGE.invalidProject };
    }
  }

  return { ok: true, project: input, encoded: encodeURIComponent(input) };
}

/**
 * Create a GitLab client bound to one base URL and one token provider.
 *
 * The token is resolved lazily, once per request, so a rotated credential is
 * picked up on the next call. When the provider yields no token, the method
 * rejects with `no-token` before any fetch is issued.
 *
 * @param {object} options
 * @param {string} options.baseUrl GitLab origin (localhost allowed for mocks)
 * @param {() => Promise<string|null>|string|null} options.tokenProvider
 *   `tokenStore.get()` from credentials.js; the value is used only in the
 *   `PRIVATE-TOKEN` header
 * @param {typeof fetch} [options.fetchImpl] injectable fetch for tests
 * @param {number} [options.timeoutMs] per-request timeout (default 15s)
 * @returns {{
 *   getCurrentUser: () => Promise<{id: number, username: string}>,
 *   findOpenMergeRequest: (input: {project: string, sourceBranch: string}) => Promise<object|null>,
 *   createMergeRequest: (input: object) => Promise<object>,
 *   getMergeRequest: (input: {project: string, iid: number|string}) => Promise<object>,
 *   listNotes: (input: {project: string, iid: number|string}) => Promise<object[]>,
 * }}
 * @throws {GitlabError} code `invalid-project` for an invalid base URL
 * @throws {TypeError} for a non-function fetchImpl/tokenProvider
 */
export function createGitlabClient(options = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError('createGitlabClient(options) requires an options object');
  }

  const normalized = normalizeBaseUrl(options.baseUrl);
  if (!normalized.ok) throw new GitlabError(normalized.code, normalized.message);
  const baseUrl = normalized.baseUrl;

  const fetchImpl = options.fetchImpl ?? fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createGitlabClient() options.fetchImpl must be a function');
  }
  if (typeof options.tokenProvider !== 'function') {
    throw new TypeError('createGitlabClient() options.tokenProvider must be a function');
  }
  const tokenProvider = options.tokenProvider;
  const timeoutMs = positiveInteger(options.timeoutMs) ?? DEFAULT_TIMEOUT_MS;

  /**
   * Resolve the token for one request. Provider failures and empty values both
   * become `no-token`; the provider's message is deliberately dropped.
   *
   * @returns {Promise<string>}
   */
  async function resolveToken() {
    let value;
    try {
      value = await tokenProvider();
    } catch {
      throw failure('no-token', MESSAGE.noToken);
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw failure('no-token', MESSAGE.noToken);
    }
    return value.trim();
  }

  /**
   * Issue one request, enforce the timeout/size caps and parse the JSON body.
   *
   * @param {{method?: string, path: string, query?: object, body?: object}} request
   * @returns {Promise<unknown>} parsed JSON payload of a 2xx response
   */
  async function call({ method = 'GET', path, query, body }) {
    const token = await resolveToken();
    const target = buildUrl(baseUrl, path, query);

    const headers = { Accept: 'application/json', [AUTH_HEADER]: token };
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch {
        // AbortController.abort() does not throw in supported runtimes; keep
        // the timeout classification even if it ever does.
      }
    }, timeoutMs);

    try {
      let response;
      try {
        response = await fetchImpl(target, {
          method,
          headers,
          body: payload,
          // Fail closed: never forward PRIVATE-TOKEN to a redirect target.
          redirect: 'error',
          signal: controller.signal,
          credentials: 'omit',
        });
      } catch (error) {
        if (timedOut) throw failure('timeout', MESSAGE.timeout);
        if (isRedirectRejection(error)) throw failure('bad-response', MESSAGE.badResponse);
        throw failure('network', MESSAGE.network);
      }

      if (timedOut) throw failure('timeout', MESSAGE.timeout);
      if (!isResponseLike(response)) throw failure('bad-response', MESSAGE.badResponse);

      const status = response.status;
      // A custom fetch implementation may return a 3xx Response instead of
      // rejecting under redirect:'error'; never follow it.
      if (status >= 300 && status < 400) {
        cancelBody(response);
        throw failure('bad-response', MESSAGE.badResponse, status);
      }
      if (status < 200 || status >= 300) {
        cancelBody(response);
        throw failureForStatus(status);
      }

      const decoded = await readBody(response);
      if (!decoded.ok) {
        if (timedOut) throw failure('timeout', MESSAGE.timeout);
        if (decoded.oversized || decoded.unusable) {
          throw failure('bad-response', MESSAGE.badResponse, status);
        }
        throw failure('network', MESSAGE.network);
      }

      try {
        return JSON.parse(decoded.text);
      } catch {
        throw failure('bad-response', MESSAGE.badResponse, status);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET `/user` → `{id, username}`. */
  async function getCurrentUser() {
    const payload = await call({ path: '/user' });
    if (!isPlainObject(payload)) throw failure('bad-response', MESSAGE.badResponse);
    const id = positiveInteger(payload.id);
    const username = typeof payload.username === 'string' && payload.username.trim() !== ''
      ? payload.username
      : undefined;
    if (id === undefined || username === undefined) {
      throw failure('bad-response', MESSAGE.badResponse);
    }
    return { id, username };
  }

  /**
   * Find the open MR whose `source_branch` is exactly `sourceBranch`.
   *
   * The API is already asked to filter (`state=opened&source_branch=…`), but a
   * real response is still matched defensively: non-object entries, a different
   * branch, a non-`opened` state and entries without a usable `iid` are
   * skipped. No match (or an empty list) resolves to `null`.
   *
   * @param {{project: string, sourceBranch: string}} input
   * @returns {Promise<object|null>}
   */
  async function findOpenMergeRequest(input) {
    const args = isPlainObject(input) ? input : {};
    const project = requireProject(args.project);
    const sourceBranch = requireBranch(args.sourceBranch);

    const payload = await call({
      path: `/projects/${project.encoded}/merge_requests`,
      query: { state: 'opened', source_branch: sourceBranch, per_page: 100 },
    });
    if (!Array.isArray(payload)) throw failure('bad-response', MESSAGE.badResponse);

    for (const entry of payload) {
      if (!isPlainObject(entry)) continue;
      if (entry.source_branch !== sourceBranch) continue;
      if (entry.state !== 'opened') continue;
      const mergeRequest = mapMergeRequest(entry, { sourceBranch });
      if (mergeRequest !== undefined) return mergeRequest;
    }
    return null;
  }

  /**
   * POST one MR with exactly `{source_branch, target_branch, title,
   * description, remove_source_branch:false}`. No `reviewer_ids` (or any other
   * field) is sent; this method never mutates any other resource.
   *
   * @param {{project: string, sourceBranch: string, targetBranch: string,
   *   title: string, description?: string}} input
   * @returns {Promise<object>} mapped MR
   */
  async function createMergeRequest(input) {
    const args = isPlainObject(input) ? input : {};
    const project = requireProject(args.project);
    const sourceBranch = requireBranch(args.sourceBranch);
    const targetBranch = requireBranch(args.targetBranch);
    const title = requireTitle(args.title);
    const description = requireDescription(args.description);

    const payload = await call({
      method: 'POST',
      path: `/projects/${project.encoded}/merge_requests`,
      body: {
        source_branch: sourceBranch,
        target_branch: targetBranch,
        title,
        description,
        remove_source_branch: false,
      },
    });

    // `iid` + `state` must come from GitLab (they identify the MR); the
    // display fields may fall back to what was requested when absent.
    const mergeRequest = mapMergeRequest(payload, {
      sourceBranch,
      targetBranch,
      title,
    });
    if (mergeRequest === undefined) throw failure('bad-response', MESSAGE.badResponse);
    return mergeRequest;
  }

  /**
   * GET one MR by iid.
   *
   * @param {{project: string, iid: number|string}} input
   * @returns {Promise<object>} mapped MR
   */
  async function getMergeRequest(input) {
    const args = isPlainObject(input) ? input : {};
    const project = requireProject(args.project);
    const iid = requireIid(args.iid);

    const payload = await call({
      path: `/projects/${project.encoded}/merge_requests/${iid}`,
    });
    const mergeRequest = mapMergeRequest(payload);
    if (mergeRequest === undefined) throw failure('bad-response', MESSAGE.badResponse);
    return mergeRequest;
  }

  /**
   * GET the notes of one MR, newest first (`sort=desc&order_by=created_at`).
   *
   * Mapping is defensive: a missing/non-string `body` becomes `''`, a missing
   * `author.username` becomes `''`, and `system` is a strict boolean. A numeric
   * string `id` is coerced; notes without a usable positive integer `id` are
   * dropped because the review service dedupes by note id — a note that cannot
   * be identified can never be processed safely. Upstream order is preserved
   * (the query requests the sort; consumers that need "latest" should
   * order/compare themselves).
   *
   * @param {{project: string, iid: number|string}} input
   * @returns {Promise<Array<{id: number, body: string, createdAt: string,
   *   authorUsername: string, system: boolean}>>}
   */
  async function listNotes(input) {
    const args = isPlainObject(input) ? input : {};
    const project = requireProject(args.project);
    const iid = requireIid(args.iid);

    const payload = await call({
      path: `/projects/${project.encoded}/merge_requests/${iid}/notes`,
      query: { sort: 'desc', order_by: 'created_at', per_page: 100 },
    });
    if (!Array.isArray(payload)) throw failure('bad-response', MESSAGE.badResponse);

    const notes = [];
    for (const entry of payload) {
      const note = mapNote(entry);
      if (note !== undefined) notes.push(note);
    }
    return notes;
  }

  return {
    getCurrentUser,
    findOpenMergeRequest,
    createMergeRequest,
    getMergeRequest,
    listNotes,
  };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function buildUrl(baseUrl, path, query) {
  const search = new URLSearchParams();
  if (query !== undefined && query !== null) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      search.append(key, String(value));
    }
  }
  const suffix = search.toString();
  return `${baseUrl}${API_PREFIX}${path}${suffix === '' ? '' : `?${suffix}`}`;
}

function isResponseLike(value) {
  return value !== null
    && typeof value === 'object'
    && typeof value.status === 'number';
}

/**
 * Read a response body with the {@link MAX_RESPONSE_BYTES} cap enforced while
 * streaming. Returns a discriminated result instead of throwing so the caller
 * can distinguish `timeout`/body-read failure from an unusable response object.
 *
 * `unusable` means the object cannot produce a body at all (a broken fetch
 * double); `failed` means a genuine stream/read error (network or abort).
 *
 * @returns {Promise<{ok: true, text: string}
 *   | {ok: false, oversized: boolean, unusable: boolean, failed: boolean}>}
 */
async function readBody(response) {
  const declared = contentLength(response);
  if (declared !== undefined && declared > MAX_RESPONSE_BYTES) {
    cancelBody(response);
    return { ok: false, oversized: true, unusable: false, failed: false };
  }

  if (response.body !== null && response.body !== undefined && typeof response.body.getReader === 'function') {
    let reader;
    try {
      reader = response.body.getReader();
    } catch {
      return { ok: false, oversized: false, unusable: true, failed: false };
    }

    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined || value === null) continue;
        const chunk = value instanceof Uint8Array
          ? value
          : new TextEncoder().encode(String(value));
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // The socket may already be gone; the oversized verdict stands.
          }
          return { ok: false, oversized: true, unusable: false, failed: false };
        }
        chunks.push(chunk);
      }
    } catch {
      return { ok: false, oversized: false, unusable: false, failed: true };
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, text: new TextDecoder('utf-8').decode(merged) };
  }

  // Fallback for a fetch double that exposes only `text()`.
  if (typeof response.text !== 'function') {
    return { ok: false, oversized: false, unusable: true, failed: false };
  }
  let text;
  try {
    text = await response.text();
  } catch {
    return { ok: false, oversized: false, unusable: false, failed: true };
  }
  if (typeof text !== 'string') {
    return { ok: false, oversized: false, unusable: true, failed: false };
  }
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    return { ok: false, oversized: true, unusable: false, failed: false };
  }
  return { ok: true, text };
}

function contentLength(response) {
  const headers = response.headers;
  if (headers === null || headers === undefined || typeof headers.get !== 'function') return undefined;
  let raw;
  try {
    raw = headers.get('content-length');
  } catch {
    return undefined;
  }
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function cancelBody(response) {
  if (response.body === null || response.body === undefined) return;
  if (typeof response.body.cancel !== 'function') return;
  try {
    const result = response.body.cancel();
    if (result !== null && typeof result === 'object' && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch {
    // Releasing a body is best-effort; never mask the status failure.
  }
}

/**
 * Node's fetch with `redirect:'error'` rejects with a TypeError whose `cause`
 * says "unexpected redirect". Map that to `bad-response` (a 3xx was received
 * and deliberately not followed) instead of the generic `network` class. Only
 * the classification reads the error text; the message itself is never
 * forwarded, so a token in it cannot leak.
 */
function isRedirectRejection(error) {
  if (error === null || typeof error !== 'object') return false;
  if (typeof error.name === 'string' && error.name === 'RedirectError') return true;
  const cause = error.cause;
  const text = cause !== null && typeof cause === 'object' && typeof cause.message === 'string'
    ? cause.message
    : (typeof error.message === 'string' ? error.message : '');
  return /redirect/i.test(text);
}

function failureForStatus(status) {
  if (status === 401) return failure('unauthorized', MESSAGE.unauthorized, 401);
  if (status === 403) return failure('forbidden', MESSAGE.forbidden, 403);
  if (status === 404) return failure('not-found', MESSAGE.notFound, 404);
  if (status === 409) return failure('conflict', MESSAGE.conflict, 409);
  if (status === 429) return failure('rate-limited', MESSAGE.rateLimited, 429);
  // 5xx: the request reached GitLab but the server failed. Treated as the
  // transport/retryable class; the real status is kept for diagnostics.
  if (status >= 500) return failure('network', MESSAGE.network, status);
  // Other 4xx (400/422/…) mean GitLab rejected the request; there is no
  // dedicated code in the P5 taxonomy, so they map to the malformed-response
  // fallback and still carry the status.
  return failure('bad-response', MESSAGE.badResponse, status);
}

// ---------------------------------------------------------------------------
// Argument / payload mapping helpers
// ---------------------------------------------------------------------------

function requireProject(value) {
  const normalized = normalizeProject(value);
  if (!normalized.ok) throw new GitlabError(normalized.code, normalized.message);
  return normalized;
}

function requireIid(value) {
  const iid = positiveInteger(value);
  if (iid === undefined) throw failure('invalid-merge-request', MESSAGE.invalidMergeRequest);
  return iid;
}

/**
 * A conservative git branch name check. Mirrors `isSafeBranchName` from
 * branch.js without importing it (this module stays import-free). Branch
 * names never enter a URL path unencoded — they are query/body values — but a
 * malformed value is still rejected before the request.
 */
function requireBranch(value) {
  if (!isSafeBranchName(value)) {
    throw failure('invalid-merge-request', MESSAGE.invalidMergeRequest);
  }
  return value;
}

function requireTitle(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw failure('invalid-merge-request', MESSAGE.invalidMergeRequest);
  }
  return value;
}

function requireDescription(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw failure('invalid-merge-request', MESSAGE.invalidMergeRequest);
  }
  return value;
}

function isSafeBranchName(value) {
  if (typeof value !== 'string') return false;
  const name = value;
  if (name === '' || name.length > MAX_BRANCH_LENGTH) return false;
  if (name.trim() !== name) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  if (name === '@' || name.includes('@{')) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) return false;
  if (name.includes('//') || name.includes('..')) return false;
  if (name.startsWith('.') || name.endsWith('.')) return false;
  for (const component of name.split('/')) {
    if (component === '' || component === '.' || component === '..') return false;
    if (component.startsWith('.') || component.endsWith('.')) return false;
    if (component.endsWith('.lock')) return false;
  }
  return true;
}

/**
 * Map a GitLab MR payload to the internal MR shape.
 *
 * `web_url` is the GitLab field; `url` is accepted as a fallback (and is what
 * the internal shape uses). Returns `undefined` when the payload cannot be a
 * usable MR: not an object, no positive integer `iid`, or no non-empty `state`
 * (a response that cannot identify the MR lifecycle is rejected). The display
 * fields (`source_branch`/`target_branch`/`title`) may fall back to the values
 * the caller requested.
 */
function mapMergeRequest(payload, fallback = {}) {
  if (!isPlainObject(payload)) return undefined;
  const iid = positiveInteger(payload.iid);
  if (iid === undefined) return undefined;

  const state = firstString(payload.state, fallback.state);
  if (state === undefined) return undefined;

  return {
    iid,
    url: firstString(payload.web_url, payload.url, fallback.url) ?? '',
    sourceBranch: firstString(payload.source_branch, fallback.sourceBranch) ?? '',
    targetBranch: firstString(payload.target_branch, fallback.targetBranch) ?? '',
    state,
    title: firstString(payload.title, fallback.title) ?? '',
  };
}

function mapNote(payload) {
  if (!isPlainObject(payload)) return undefined;
  const id = positiveInteger(payload.id);
  // Without an id the review service cannot dedupe the note safely; drop it.
  if (id === undefined) return undefined;
  const author = isPlainObject(payload.author) ? payload.author : {};
  return {
    id,
    body: typeof payload.body === 'string' ? payload.body : '',
    createdAt: typeof payload.created_at === 'string' ? payload.created_at : '',
    authorUsername: typeof author.username === 'string' ? author.username : '',
    system: payload.system === true,
  };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** Parse a positive integer from a number or numeric string; undefined otherwise. */
function positiveInteger(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function failure(code, message, status) {
  return new GitlabError(code, message, status);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
