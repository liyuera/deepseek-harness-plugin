/**
 * Platform-token storage for the Bug workflow plugin.
 *
 * The token is a secret: it only ever travels between this module and the DSH
 * `ctx.credentials` service. Nothing here logs, formats, or returns the value
 * to an HTTP client — `get()` is host-internal (the sync engine calls it), and
 * `present()` answers the snapshot's `tokenPresent` flag without reading it.
 *
 * ## Credential key
 *
 * The P2 plan names the credential `bug-workflow.platform-token`. That string
 * is not addressable in either half of the credentials seam: a `CredentialRef`
 * must match `^[A-Za-z_][A-Za-z0-9_]*$` (environment-variable shape) and a
 * `CredentialKey` is `<scope>/<id>` with lowercase-hyphenated segments. Storing
 * the dotted form in the provider-managed file would be rejected when
 * `dsh-credentials-local` re-reads the document (and would make the provider
 * fail its next boot), so this module uses the reference-shaped key
 * `BUG_WORKFLOW_PLATFORM_TOKEN` — the smallest legal mapping of the planned
 * name and the same shape a platform API key would take.
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

/** Reference name used in the DSH credential store (environment-variable shape). */
export const PLATFORM_TOKEN_REF = 'BUG_WORKFLOW_PLATFORM_TOKEN';

/** Maximum accepted token length in characters (8192). */
export const MAX_TOKEN_LENGTH = 8192;

/** Methods the credential service must expose for the reference half. */
const REQUIRED_METHODS = Object.freeze(['set', 'resolve', 'describe', 'unset']);

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
 * Build the platform-token store over a `ctx.credentials` service.
 *
 * The service is captured once. Pass `undefined` when the service is not
 * available: the plugin still loads, `present()` stays false, and writes fail
 * with `credentials-unavailable` (the route maps that to HTTP 503).
 *
 * @param {object|undefined|null} credentials `ctx.credentials` service
 * @returns {{get: () => Promise<string|null>, set: (token: string) => Promise<void>, clear: () => Promise<void>, present: () => Promise<boolean>}}
 */
export function createTokenStore(credentials) {
  const service = normalizeCredentials(credentials);

  async function get() {
    if (service === null) throw unavailable();
    let resolved;
    try {
      resolved = await service.resolve(PLATFORM_TOKEN_REF);
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
      await service.set(PLATFORM_TOKEN_REF, value);
    } catch {
      // Same rule as get(): no provider detail, and certainly no token.
      throw unavailable();
    }
  }

  async function clear() {
    if (service === null) throw unavailable();
    try {
      await service.unset(PLATFORM_TOKEN_REF);
    } catch {
      throw unavailable();
    }
  }

  async function present() {
    if (service === null) return false;
    try {
      const info = await service.describe(PLATFORM_TOKEN_REF);
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

function unavailable() {
  return new TokenStoreError('credentials-unavailable', '凭据服务不可用，无法读写平台 token');
}
