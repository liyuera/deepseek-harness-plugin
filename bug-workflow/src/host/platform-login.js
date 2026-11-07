/**
 * Platform (星瞰河山 / HT_TEAM) login orchestration for the bug workflow.
 *
 * The platform login page is a plain account + password + image-captcha form:
 *
 *   GET  {baseUrl}/api/htwisdom-auth/oauth/captcha
 *        -> flat `{ key, image }` (`image` is a `data:image/png;base64,…` URL)
 *   POST {baseUrl}/api/htwisdom-auth/oauth/token
 *        headers: Tenant-Id / Captcha-key / Captcha-code / Dept-Id / Role-Id
 *        body:    { type:'account', scope:'all', grant_type:'captcha',
 *                   deptId:'', roleId:'', tenantId, username,
 *                   password: md5(rawPassword), code }
 *        -> `{ code:200, success:true, data:{ access_token, token_type, … } }`
 *
 * The resulting `access_token` is what the rest of the plugin sends as
 * `Htwisdom-Auth: <token>` (the P0 spike proved no cookie/Basic auth is needed).
 *
 * Security contract (the reason this lives on the host, not the client):
 *
 *   - the password is hashed (MD5, matching the platform frontend) and used for
 *     exactly ONE request; it is never stored, cached, logged or returned;
 *   - the token is returned to the route only long enough to write it into the
 *     credentials service (write-only); this module never logs it either;
 *   - every expected failure resolves to a static Chinese message (the platform
 *     `msg` is never echoed back — it could contain environment details);
 *   - `redirect: 'error'` and a hard timeout keep a login attempt from following
 *     a redirect or hanging forever.
 *
 * The service is pure over its injected `fetchImpl` so the plain-Node test
 * runner can drive a loopback mock platform.
 */

import { createHash } from 'node:crypto';

import { normalizeBaseUrl } from './platform.js';

/** Login request budget (the platform is on the intranet). */
export const DEFAULT_LOGIN_TIMEOUT_MS = 15_000;

/** Default tenant used by the platform login page when none is configured. */
export const DEFAULT_TENANT_ID = '000000';

/** Captcha images are ~10-40 KiB base64; cap well above that. */
export const MAX_CAPTCHA_IMAGE_CHARS = 400_000;

/** Upstream JSON bodies are small envelopes; cap the trusted read. */
export const MAX_LOGIN_RESPONSE_BYTES = 512 * 1024;

/**
 * A browser-like User-Agent. The login gateway's "platform info" check rejects
 * requests that do not look like the login page's own XHR, so the host mirrors
 * the browser headers the page sends (no credentials are involved).
 */
export const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** Field length caps (defensive: the platform form accepts short values). */
export const MAX_USERNAME_CHARS = 100;
export const MAX_PASSWORD_CHARS = 200;
export const MAX_CAPTCHA_CODE_CHARS = 16;
export const MAX_CAPTCHA_KEY_CHARS = 200;
export const MAX_TENANT_ID_CHARS = 64;

/** Static, user-facing messages (never interpolate credentials). */
const MESSAGE = Object.freeze({
  invalidBaseUrl: '平台地址无效，请检查设置',
  invalidUsername: '请输入平台账号',
  invalidPassword: '请输入平台密码',
  invalidCode: '请输入图形验证码',
  invalidCaptchaKey: '验证码已失效，请点击图片刷新',
  invalidTenant: '租户参数不合法',
  captchaUnavailable: '获取验证码失败，请稍后重试',
  captchaBadResponse: '平台验证码响应异常，请稍后重试',
  captchaTooLarge: '平台验证码图片过大，已拒绝',
  loginUnavailable: '无法连接平台登录服务，请检查网络后重试',
  loginTimeout: '登录请求超时，请稍后重试',
  loginBadResponse: '平台登录响应异常，请稍后重试',
  captchaInvalid: '验证码错误或已过期，请重新输入',
  invalidCredentials: '账号或密码错误，请检查后重试',
  loginFailed: '平台登录失败，请稍后重试',
});

/** Error codes -> HTTP status used by the routes layer. */
export const PLATFORM_LOGIN_ERROR_STATUS = Object.freeze({
  'invalid-input': 400,
  'invalid-base-url': 400,
  'invalid-settings': 400,
  'captcha-invalid': 400,
  'captcha-unavailable': 502,
  'captcha-bad-response': 502,
  'login-timeout': 504,
  'login-unavailable': 502,
  'login-bad-response': 502,
  'invalid-credentials': 401,
  'login-failed': 502,
  'login-unavailable-service': 503,
  'credentials-unavailable': 503,
});

/** Thrown for expected login failures; `code` is static. */
export class PlatformLoginError extends Error {
  /**
   * @param {string} code static error code (see PLATFORM_LOGIN_ERROR_STATUS)
   * @param {string} message static Chinese message
   * @param {number} [status] upstream HTTP status, diagnostics only
   */
  constructor(code, message, status) {
    super(message);
    this.name = 'PlatformLoginError';
    this.code = code;
    this.status = status;
  }
}

/**
 * MD5 hex digest, matching the platform frontend (`js-md5` of the raw password).
 * Exported for the test that locks the wire format.
 *
 * @param {string} value raw password (never logged)
 * @returns {string} 32-char lowercase hex
 */
export function hashPassword(value) {
  return createHash('md5').update(String(value), 'utf8').digest('hex');
}

/** A non-empty password string (NOT trimmed: spaces may be significant). */
function normalizePassword(value) {
  if (typeof value !== 'string' || value === '' || value.length > MAX_PASSWORD_CHARS) return undefined;
  return value;
}

/** Trimmed non-empty string within `max` characters, or `undefined`. */
function normalizeField(value, max) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > max) return undefined;
  return trimmed;
}

/** A trimmed non-empty tenant id (letters/digits/`_`/`-`), or undefined. */
function normalizeTenant(value) {
  if (value === undefined || value === null) return DEFAULT_TENANT_ID;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return DEFAULT_TENANT_ID;
  if (trimmed.length > MAX_TENANT_ID_CHARS) return undefined;
  return /^[0-9A-Za-z_-]+$/.test(trimmed) ? trimmed : undefined;
}

/** JSON object guard. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validated platform base URL with a trailing slash (the platform client's
 * {@link normalizeBaseUrl} returns a result object, not a bare string).
 */
function requireBaseUrl(input) {
  const normalized = normalizeBaseUrl(input);
  if (normalized === null || normalized === undefined || normalized.ok !== true
    || typeof normalized.baseUrl !== 'string') {
    throw new PlatformLoginError('invalid-base-url', MESSAGE.invalidBaseUrl);
  }
  return normalized.baseUrl;
}

/**
 * The OAuth client pair is publicly readable from the platform's login
 * bootstrap endpoint (the same values the frontend puts in `Authorization:
 * Basic`). They are application-level credentials, not the user's password;
 * they are re-fetched per login attempt and never persisted by this module.
 *
 * @param {string} baseUrl normalized base URL (trailing slash)
 * @returns {Promise<{clientId: string, clientSecret: string, defaultTenant: string|null}>}
 */
async function readOauthClient(baseUrl, requestJsonFn) {
  const { body } = await requestJsonFn(
    `${baseUrl}api/htwisdom-system/system/open-api/system-config?tenantId=${encodeURIComponent(DEFAULT_TENANT_ID)}`,
    { method: 'GET', headers: { Accept: 'application/json' } },
    'login',
  );
  const data = isPlainObject(body.data) ? body.data : {};
  const envelopeCode = typeof body.code === 'number' ? body.code : NaN;
  const clientId = typeof data.clientId === 'string' ? data.clientId.trim() : '';
  const clientSecret = typeof data.clientSecret === 'string' ? data.clientSecret.trim() : '';
  if (envelopeCode !== 200 || clientId === '' || clientSecret === ''
    || clientId.length > MAX_USERNAME_CHARS || clientSecret.length > MAX_PASSWORD_CHARS) {
    throw new PlatformLoginError('login-bad-response', MESSAGE.loginBadResponse);
  }
  const defaultTenant = typeof data.defaultTenant === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(data.defaultTenant)
    ? data.defaultTenant
    : null;
  return { clientId, clientSecret, defaultTenant };
}

/**
 * Redact secrets and token-like blobs from an upstream error message before it
 * is shown to the user (the platform's own login copy is useful, but a token or
 * echoed credential must never reach the board).
 *
 * @param {string} message raw upstream `msg`
 * @param {string[]} secrets values that must never be echoed
 * @returns {string} clipped, redacted copy ('' when nothing safe is left)
 */
export function safeUpstreamDetail(message, secrets = []) {
  if (typeof message !== 'string' || message === '') return '';
  let text = message;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      text = text.split(secret).join('***');
    }
  }
  text = text.replace(/[A-Za-z0-9+/=_-]{32,}/g, '…');
  text = text.replace(/[\r\n\t]+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/**
 * Create the login service.
 *
 * @param {{fetchImpl?: Function, timeoutMs?: number}} [options]
 * @returns {{captcha: Function, login: Function, hashPassword: Function}}
 */
export function createPlatformLogin(options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_LOGIN_TIMEOUT_MS;

  /**
   * One JSON request to the platform. Resolves `{ok:true, body}` or throws a
   * PlatformLoginError with a static code. Never follows redirects, never keeps
   * more than {@link MAX_LOGIN_RESPONSE_BYTES}.
   */
  async function requestJson(url, requestInit, failureCodeBase) {
    let response;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller === null
      ? null
      : setTimeout(() => {
        try {
          controller.abort();
        } catch {
          // Already settled.
        }
      }, timeoutMs);
    try {
      response = await fetchImpl(url, {
        ...requestInit,
        redirect: 'error',
        signal: controller === null ? undefined : controller.signal,
      });
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.name === 'AbortError') {
        if (failureCodeBase === 'captcha') {
          throw new PlatformLoginError('captcha-unavailable', MESSAGE.captchaUnavailable);
        }
        throw new PlatformLoginError('login-timeout', MESSAGE.loginTimeout);
      }
      throw new PlatformLoginError(
        failureCodeBase === 'captcha' ? 'captcha-unavailable' : 'login-unavailable',
        failureCodeBase === 'captcha' ? MESSAGE.captchaUnavailable : MESSAGE.loginUnavailable,
      );
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    // Read with a byte cap; `response.text()` is not bounded, so stream it.
    let text;
    try {
      if (response !== null && typeof response === 'object' && response.body !== null && response.body !== undefined
        && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        const chunks = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done === true) break;
          if (value !== undefined && value !== null) {
            bytes += value.byteLength ?? 0;
            if (bytes > MAX_LOGIN_RESPONSE_BYTES) {
              try {
                await reader.cancel();
              } catch {
                // Already cancelled.
              }
              throw new PlatformLoginError(
                failureCodeBase === 'captcha' ? 'captcha-bad-response' : 'login-bad-response',
                failureCodeBase === 'captcha' ? MESSAGE.captchaBadResponse : MESSAGE.loginBadResponse,
              );
            }
            chunks.push(decoder.decode(value, { stream: true }));
          }
        }
        chunks.push(decoder.decode());
        text = chunks.join('');
      } else {
        text = await response.text();
        if (typeof text === 'string' && text.length > MAX_LOGIN_RESPONSE_BYTES) {
          throw new PlatformLoginError(
            failureCodeBase === 'captcha' ? 'captcha-bad-response' : 'login-bad-response',
            failureCodeBase === 'captcha' ? MESSAGE.captchaBadResponse : MESSAGE.loginBadResponse,
          );
        }
      }
    } catch (error) {
      if (error instanceof PlatformLoginError) throw error;
      throw new PlatformLoginError(
        failureCodeBase === 'captcha' ? 'captcha-bad-response' : 'login-bad-response',
        failureCodeBase === 'captcha' ? MESSAGE.captchaBadResponse : MESSAGE.loginBadResponse,
      );
    }


    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new PlatformLoginError(
        failureCodeBase === 'captcha' ? 'captcha-bad-response' : 'login-bad-response',
        failureCodeBase === 'captcha' ? MESSAGE.captchaBadResponse : MESSAGE.loginBadResponse,
        typeof response.status === 'number' ? response.status : undefined,
      );
    }
    if (!isPlainObject(body)) {
      throw new PlatformLoginError(
        failureCodeBase === 'captcha' ? 'captcha-bad-response' : 'login-bad-response',
        failureCodeBase === 'captcha' ? MESSAGE.captchaBadResponse : MESSAGE.loginBadResponse,
        typeof response.status === 'number' ? response.status : undefined,
      );
    }
    return { ok: response.ok !== false, body, status: response.status };
  }

  /**
   * Fetch one image captcha.
   *
   * @param {{baseUrl: string}} input platform root (from workspace settings)
   * @returns {Promise<{key: string, image: string}>} base64 image data URL + key
   */
  async function captcha(input = {}) {
    const baseUrl = requireBaseUrl(input.baseUrl);

    const { body } = await requestJson(
      `${baseUrl}api/htwisdom-auth/oauth/captcha`,
      { method: 'GET', headers: { Accept: 'application/json' } },
      'captcha',
    );

    // The endpoint answers a flat `{key, image}` (no `{code,data}` envelope).
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    const image = typeof body.image === 'string' ? body.image.trim() : '';
    if (key === '' || key.length > MAX_CAPTCHA_KEY_CHARS) {
      throw new PlatformLoginError('captcha-bad-response', MESSAGE.captchaBadResponse);
    }
    if (!/^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) {
      throw new PlatformLoginError('captcha-bad-response', MESSAGE.captchaBadResponse);
    }
    if (image.length > MAX_CAPTCHA_IMAGE_CHARS) {
      throw new PlatformLoginError('captcha-bad-response', MESSAGE.captchaTooLarge);
    }
    return { key, image };
  }

  /**
   * Log in with account + password + captcha code and return the access token.
   *
   * @param {object} input
   * @param {string} input.baseUrl platform root
   * @param {string} input.username account name
   * @param {string} input.password raw password (hashed here, never returned)
   * @param {string} input.code image captcha code
   * @param {string} input.captchaKey key returned by {@link captcha}
   * @param {string} [input.tenantId] optional tenant id (default `000000`)
   * @returns {Promise<{token: string, tokenType: string|null, username: string|null}>}
   */
  async function login(input = {}) {
    const baseUrl = requireBaseUrl(input.baseUrl);

    const username = normalizeField(input.username, MAX_USERNAME_CHARS);
    if (username === undefined) throw new PlatformLoginError('invalid-input', MESSAGE.invalidUsername);
    const password = normalizePassword(input.password);
    if (password === undefined) throw new PlatformLoginError('invalid-input', MESSAGE.invalidPassword);
    const code = normalizeField(input.code, MAX_CAPTCHA_CODE_CHARS);
    if (code === undefined) throw new PlatformLoginError('invalid-input', MESSAGE.invalidCode);
    const captchaKey = normalizeField(input.captchaKey, MAX_CAPTCHA_KEY_CHARS);
    if (captchaKey === undefined) throw new PlatformLoginError('invalid-input', MESSAGE.invalidCaptchaKey);
    const tenantId = normalizeTenant(input.tenantId);
    if (tenantId === undefined) throw new PlatformLoginError('invalid-input', MESSAGE.invalidTenant);

    // The public login bootstrap config carries the OAuth client pair the
    // frontend embeds in every request as `Authorization: Basic ...`. The login
    // endpoint silences a request without it (HTTP 200, empty body), so the pair
    // MUST be fetched before the token POST.
    const client = await readOauthClient(baseUrl, requestJson);
    const basic = Buffer.from(`${client.clientId}:${client.clientSecret}`, 'utf8').toString('base64');

    const resolvedTenant = input.tenantId === undefined || input.tenantId === null || input.tenantId === ''
      ? (client.defaultTenant !== null ? client.defaultTenant : tenantId)
      : tenantId;
    // The platform parses the token request from a querystring body; JSON is
    // ignored and answered with "Missing grant type".
    const form = new URLSearchParams({
      type: 'account',
      scope: 'all',
      grant_type: 'captcha',
      deptId: '',
      roleId: '',
      tenantId: resolvedTenant,
      username,
      password: hashPassword(password),
      code,
    }).toString();

    // The platform gateway rejects non-browser callers with
    // '登录请求缺少平台信息' unless the request looks like the login page's own
    // XHR (same-origin headers + the frontend's Menu-Classify marker).
    const origin = baseUrl.replace(/\/+$/, '');
    const { body, status } = await requestJson(
      `${baseUrl}api/htwisdom-auth/oauth/token`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basic}`,
          Origin: origin,
          Referer: `${origin}/user/login`,
          'User-Agent': BROWSER_USER_AGENT,
          'X-Requested-With': 'XMLHttpRequest',
          'Menu-Classify': '1',
          'Tenant-Id': resolvedTenant,
          'Captcha-key': captchaKey,
          'Captcha-code': code,
          'Dept-Id': '',
          'Role-Id': '',
        },
        body: form,
      },
      'login',
    );

    const envelopeCode = typeof body.code === 'number' ? body.code : (typeof body.code === 'string' ? Number(body.code) : NaN);
    if (envelopeCode !== 200 || body.success === false) {
      const upstreamMsg = typeof body.msg === 'string' ? body.msg : '';
      // Distinguish captcha failures from credential failures without echoing the
      // upstream message (it can contain environment details).
      if (/验证码|captcha/i.test(upstreamMsg)) {
        throw new PlatformLoginError('captcha-invalid', MESSAGE.captchaInvalid, status);
      }
      if (/密码|账号|用户|password|username|bad credentials|invalid_grant|unauthorized/i.test(upstreamMsg)) {
        throw new PlatformLoginError('invalid-credentials', MESSAGE.invalidCredentials, status);
      }
      const detail = safeUpstreamDetail(upstreamMsg, [password, username]);
      throw new PlatformLoginError(
        'login-failed',
        detail === '' ? MESSAGE.loginFailed : `${MESSAGE.loginFailed}（平台：${detail}）`,
        status,
      );
    }

    const data = isPlainObject(body.data) ? body.data : {};
    const rawToken = typeof data.access_token === 'string'
      ? data.access_token
      : (typeof body.access_token === 'string' ? body.access_token : '');
    const token = rawToken.trim();
    if (token === '' || token.length > 4096) {
      throw new PlatformLoginError('login-bad-response', MESSAGE.loginBadResponse, status);
    }
    const tokenType = typeof data.token_type === 'string' && data.token_type.trim() !== ''
      ? data.token_type.trim()
      : null;

    // Best-effort identity for the UI ("已登录为 xxx"). A failure here never
    // invalidates a successful login.
    let resolvedUsername = null;
    try {
      const info = await requestJson(
        `${baseUrl}api/htwisdom-system/user-auth-info`,
        { method: 'GET', headers: { Accept: 'application/json', 'Htwisdom-Auth': token } },
        'login',
      );
      const infoData = isPlainObject(info.body.data) ? info.body.data : {};
      const candidate = typeof infoData.username === 'string'
        ? infoData.username
        : (typeof infoData.account === 'string' ? infoData.account : null);
      if (candidate !== null && candidate.trim() !== '') resolvedUsername = candidate.trim().slice(0, MAX_USERNAME_CHARS);
    } catch {
      // Identity is a nice-to-have; the token itself is what matters.
    }

    return { token, tokenType, username: resolvedUsername };
  }

  return { captcha, login, hashPassword };
}
