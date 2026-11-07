/**
 * Host token storage for the Bug workflow plugin.
 *
 * One implementation backs both credentials: the platform sync token (P2) and
 * the GitLab API token (P5). They differ only by credential reference, so
 * `createTokenStore(credentials, { ref })` keeps the get/set/clear/present and
 * validation rules identical for both.
 *
 * A token is a secret: it only ever travels between this module and the DSH
 * `ctx.credentials` service. Nothing here logs, formats, or returns the value
 * to an HTTP client — `get()` is host-internal (the sync/delivery/review
 * services call it), and `present()` answers the snapshot's `tokenPresent` flag
 * without reading it.
 *
 * ## Credential keys
 *
 * The P2 plan names the platform credential `bug-workflow.platform-token`. That
 * string is not addressable in either half of the credentials seam: a
 * `CredentialRef` must match `^[A-Za-z_][A-Za-z0-9_]*$` (environment-variable
 * shape) and a `CredentialKey` is `<scope>/<id>` with lowercase-hyphenated
 * segments. Storing the dotted form in the provider-managed file would be
 * rejected when `dsh-credentials-local` re-reads the document (and would make
 * the provider fail its next boot), so this module uses the reference-shaped
 * key `BUG_WORKFLOW_PLATFORM_TOKEN` — the smallest legal mapping of the planned
 * name and the same shape a platform API key would take. P5 adds the GitLab
 * reference `BUG_WORKFLOW_GITLAB_TOKEN` following the same rule.
 *
 * ## Error contract
 *
 * `set()`/`clear()`/`get()` reject with a {@link TokenStoreError} carrying a
 * stable `code`:
 *
 *   - `invalid-token`          the caller passed something other than a
 *                              non-empty string of at most `MAX_TOKEN_LENGTH`;
 *   - `credentials-unavailable` the `credentials` service (or one of its four
 *                              reference methods) is absent, or the provider
 *                              failed. Provider messages are replaced by a
 *                              generic message: a provider diagnostic must
 *                              never quote the secret back to the caller.
 *
 * `present()` never throws: an unavailable or failing service reads as
 * `false`, so the board snapshot stays available when storage is fine but
 * credentials is not.
 */

/** Reference name of the platform sync token (environment-variable shape). */
export const PLATFORM_TOKEN_REF = 'BUG_WORKFLOW_PLATFORM_TOKEN';

/** Reference name of the GitLab API token (P5, environment-variable shape). */
export const GITLAB_TOKEN_REF = 'BUG_WORKFLOW_GITLAB_TOKEN';

/** Maximum accepted token length in characters (8192). */
export const MAX_TOKEN_LENGTH = 8192;

/** Methods the credential service must expose for the reference half. */
const REQUIRED_METHODS = Object.freeze(['set', 'resolve', 'describe', 'unset']);

/** Reference keys are environment-variable shaped (the seam's contract). */
const REF_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Structured token-store failure. `code` is stable; callers branch on it and
 * never parse `message` (which is always static, never derived from the token).
 */
export class TokenStoreError extends Error {
  /**
   * @param {'invalid-token'|'credentials-unavailable'} code stable failure code
   * @param {string} message fixed, token-free description
   */
  constructor(code, message) {
    super(message);
    this.name = 'TokenStoreError';
    this.code = code;
  }
}

/**
 * Build a token store over a `ctx.credentials` service for one reference.
 *
 * The service is captured once. Pass `undefined` when the service is not
 * available: the plugin still loads, `present()` stays false, and writes fail
 * with `credentials-unavailable` (the routes map that to HTTP 503).
 *
 * `options.ref` selects the credential reference and defaults to
 * `PLATFORM_TOKEN_REF`, so every single-argument call made before P5 keeps the
 * exact platform-token behaviour. The two stores are independent even when
 * they share one credentials service.
 *
 * @param {object|undefined|null} credentials `ctx.credentials` service
 * @param {{ref?: string}|undefined|null} [options]
 * @returns {{get: () => Promise<string|null>, set: (token: string) => Promise<void>, clear: () => Promise<void>, present: () => Promise<boolean>}}
 */
export function createTokenStore(credentials, options = {}) {
  const service = normalizeCredentials(credentials);
  const ref = normalizeRef(options);

  async function get() {
    if (service === null) throw unavailable();
    let resolved;
    try {
      resolved = await service.resolve(ref);
    } catch {
      // The provider's message may quote internals; never forward it.
      throw unavailable();
    }
    if (resolved === null || resolved === undefined) return null;
    const value = resolved.value;
    if (typeof value !== 'string' || value.length === 0) return null;
    return value;
  }

  async function set(token) {
    const value = normalizeToken(token);
    if (service === null) throw unavailable();
    try {
      await service.set(ref, value);
    } catch {
      // Same rule as get(): no provider detail, and certainly no token.
      throw unavailable();
    }
  }

  async function clear() {
    if (service === null) throw unavailable();
    try {
      await service.unset(ref);
    } catch {
      throw unavailable();
    }
  }

  async function present() {
    if (service === null) return false;
    try {
      const info = await service.describe(ref);
      return info !== null && typeof info === 'object' && info.configured === true;
    } catch {
      return false;
    }
  }

  return { get, set, clear, present };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A token must be a non-empty string of at most MAX_TOKEN_LENGTH characters. */
function normalizeToken(token) {
  if (typeof token !== 'string') {
    throw new TokenStoreError('invalid-token', 'token 必须是非空字符串');
  }
  // Tokens are copied from localStorage; tolerate accidental surrounding
  // whitespace but never store it.
  const value = token.trim();
  if (value === '') {
    throw new TokenStoreError('invalid-token', 'token 不能为空');
  }
  if (value.length > MAX_TOKEN_LENGTH) {
    throw new TokenStoreError('invalid-token', `token 长度不能超过 ${MAX_TOKEN_LENGTH} 字符`);
  }
  return value;
}

/** Resolve the service only when every reference method exists. */
function normalizeCredentials(credentials) {
  if (credentials === null || typeof credentials !== 'object') return null;
  for (const method of REQUIRED_METHODS) {
    if (typeof credentials[method] !== 'function') return null;
  }
  return credentials;
}

/**
 * Resolve the credential reference. Missing options keep the pre-P5 platform
 * default; a malformed ref is a programming error (the credentials seam only
 * accepts environment-variable shaped references) and is rejected loudly
 * rather than silently writing to the wrong credential.
 */
function normalizeRef(options) {
  if (options === undefined || options === null) return PLATFORM_TOKEN_REF;
  if (typeof options !== 'object') {
    throw new TypeError('createTokenStore() options must be an object');
  }
  const ref = options.ref;
  if (ref === undefined) return PLATFORM_TOKEN_REF;
  if (typeof ref !== 'string' || !REF_RE.test(ref)) {
    throw new TypeError('createTokenStore() ref must be an environment-variable-shaped reference');
  }
  return ref;
}

function unavailable() {
  return new TokenStoreError('credentials-unavailable', '凭据服务不可用，无法读写 token');
}
