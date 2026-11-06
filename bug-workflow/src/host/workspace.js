/**
 * Resolve a live DSH session to the workspace (git repo) it belongs to.
 *
 * The board is partitioned by workspace: tickets are global per profile in P1,
 * while settings are stored under the workspace cwd (see `store.js`). The only
 * authoritative source for that cwd is the live session header maintained by
 * `ctx.sessions`; a persisted/archived session is not visible here, which is
 * deliberate — the board is opened from a live tab and binds to that tab's
 * workspace.
 *
 * The returned `configured` flag answers "did this session resolve to a
 * workspace directory?", which is what the P1 client uses to decide whether it
 * can show/edit workspace settings. It does NOT mean the user saved custom
 * settings: `store.getSettings(cwd)` returns defaults for an unsaved cwd, so
 * P1 cannot distinguish defaults from an explicitly saved default record. The
 * `settingsStore` input is accepted for the future version that can make that
 * distinction; it is intentionally unused today.
 */

/**
 * Resolve the workspace of one session.
 *
 * Never throws: a missing/blank session id, a session without `header.cwd`, or
 * a failing `ctx.sessions` lookup all degrade to
 * `{ path: null, configured: false }`, so a broken session must not take down
 * the board.
 *
 * @param {object} deps
 * @param {object} deps.sessions `ctx.sessions` (only `get(id)` is used)
 * @param {object} [deps.settingsStore] reserved; see the module comment
 * @param {string} sessionId session id supplied by the client slot/qerystring
 * @returns {{path: string|null, configured: boolean}}
 */
export function resolveWorkspace({ sessions } = {}, sessionId) {
  const id = normalizeSessionId(sessionId);
  if (id === undefined) return unbound();

  let session;
  try {
    session = sessions?.get?.(id);
  } catch {
    // A session store that cannot answer must not break the snapshot route.
    return unbound();
  }

  const cwd = session?.header?.cwd;
  if (typeof cwd !== 'string' || cwd.trim() === '') return unbound();

  // Keep the cwd byte-for-byte: settings are keyed by this exact string. Adding
  // or removing a trailing slash would silently create a second settings row.
  return { path: cwd, configured: true };
}

function unbound() {
  return { path: null, configured: false };
}

function normalizeSessionId(sessionId) {
  if (typeof sessionId !== 'string') return undefined;
  const trimmed = sessionId.trim();
  return trimmed === '' ? undefined : trimmed;
}
