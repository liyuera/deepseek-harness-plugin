/**
 * Pure branch derivation rules for the bug workflow (P4 Task 1).
 *
 * Design spec §8.3 ("git 版本及 team 规范") is the source of truth:
 *
 *   - the integration-branch suffix `X` is the ticket's platform version
 *     (`versionName`, e.g. `V1.6.1.20261109`);
 *   - a normal ticket gets `feat-<X>-<branchUser>` and a failure ticket gets
 *     `hot-<X>-<branchUser>`; the personal branch may be overridden by the
 *     user in the board before fix starts;
 *   - the target branch follows the personal branch name:
 *     `feat-<X>-<user>` → `feature-<X>`, `hot-<X>-<user>` → `hotfix-<X>`;
 *     a personal override that does not end in `-<branchUser>` cannot be
 *     used to derive a target and is rejected as `invalid-branch`;
 *   - the target may be overridden explicitly as well.
 *
 * Normalization is deliberately narrow and deterministic:
 *
 *   - `X` keeps `[A-Za-z0-9._-]`, turns every other run of characters into a
 *     single `-`, collapses repeated `-` and trims `-` from both edges; a
 *     missing/blank platform version, or one whose sanitized form cannot be a
 *     ref component, is rejected as `invalid-version` (no `V0.0.0` fallback —
 *     the caller must supply the ticket version explicitly);
 *   - `branchUser` is one ref component: ASCII letters/digits/`_` first, then
 *     letters/digits/`.`/`_`/`-`, with no `..` and no trailing `.`;
 *   - overrides may contain `/` (nested branches such as
 *     `release/feature-x`), but must be a legal git ref name: no whitespace or
 *     control characters, no `..`, no leading `-`, no leading/trailing `/`, no
 *     empty/`.`/`..` path component, no `.lock` suffix, and at most 200 chars.
 *
 * All failures are a thrown `BranchError` with a STATIC `code` and a STATIC
 * Chinese `message`. Rejected input is never echoed: platform version strings
 * and branch users are untrusted and may contain control characters.
 *
 * The module has zero imports (not even `node:` builtins) so the plain-Node
 * test runner can load it directly; it does not touch git or the filesystem.
 */

/** Maximum length of any personal/target branch name (git checkpoint). */
export const BRANCH_LENGTH_LIMIT = 200;

/** Maximum length of the personal-branch suffix (`branchUser`). */
export const BRANCH_USER_LENGTH_LIMIT = 64;

/** Maximum length of the sanitized version suffix (`X`). */
export const VERSION_LENGTH_LIMIT = 100;

const MESSAGE = Object.freeze({
  invalidArguments: '分支参数不合法',
  invalidBranch: '分支名不合法',
  invalidBranchUser: '个人分支用户名不合法',
  invalidFamily: '分支类型必须是 feat 或 hot',
  invalidVersion: '版本号无法生成合法的分支名',
});

/**
 * Thrown for invalid branch derivation input. `code` is one of:
 *
 *   invalid-branch        invalid arguments, invalid override branch name, or
 *                         a personal branch that cannot derive a target
 *                         because it lacks the `-<branchUser>` suffix
 *   invalid-branch-user   missing or unsafe `branchUser`
 *   invalid-family        `family` is not `feat`/`hot`, or it contradicts the
 *                         family implied by the personal-branch override
 *   invalid-version       missing/unsafe version (`versionName` is required)
 */
export class BranchError extends Error {
  /**
   * @param {string} code static error code
   * @param {string} message static message (never interpolates input)
   */
  constructor(code, message) {
    super(message);
    this.name = 'BranchError';
    this.code = code;
  }
}

/**
 * Sanitize a platform version name into the integration-branch suffix.
 *
 * Keeps `[A-Za-z0-9._-]`, replaces every other run with `-`, collapses
 * repeated `-`, and trims `-` from both edges. A missing/non-string/blank
 * version returns `''`; `deriveBranches` rejects that as `invalid-version`
 * (there is no `V0.0.0` fallback). Note that this helper does NOT reject `..` /
 * `.lock` — `deriveBranches` performs the final ref-safety check.
 *
 * @param {unknown} versionName
 * @returns {string}
 */
export function sanitizeVersion(versionName) {
  if (typeof versionName !== 'string') return '';

  return versionName
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Check whether a value is a safe branch name for `override`.
 *
 * Conservative on purpose: this is the guard between untrusted ticket/user
 * input and `git` argv. It allows nested `a/b` branches (the team spec uses
 * `feature-*` / `hotfix-*`, but an operator may point at `release/x`).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeBranchName(value) {
  if (typeof value !== 'string') return false;
  const name = value.trim();
  if (name === '' || name.length > BRANCH_LENGTH_LIMIT) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  // `@` alone and `@{` are special git ref syntax.
  if (name === '@' || name.includes('@{')) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) return false;
  if (name.includes('//') || name.includes('..')) return false;
  if (name.startsWith('.') || name.endsWith('.')) return false;

  for (const component of name.split('/')) {
    if (component === '' || component === '.' || component === '..') return false;
    if (component.startsWith('.')) return false;
    if (component.endsWith('.')) return false;
    if (component.endsWith('.lock')) return false;
  }
  return true;
}

/**
 * Check whether `branchUser` can be used as the suffix of a personal branch.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeBranchUser(value) {
  if (typeof value !== 'string') return false;
  const user = value.trim();
  if (user === '' || user.length > BRANCH_USER_LENGTH_LIMIT) return false;
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(user)) return false;
  if (user.includes('..') || user.endsWith('.') || user.endsWith('.lock')) return false;
  return true;
}

/**
 * Derive the personal + target branch for one ticket.
 *
 * @param {object} input
 * @param {unknown} input.versionName ticket platform version (`X` source)
 * @param {unknown} [input.ticketType] ticket type label (`故障` = failure)
 * @param {unknown} [input.typeKey] best-effort legacy hint: a type key
 *   containing `FAILURE` is treated as a failure ticket; Task 2 should pass the
 *   synced ticket type/type name instead
 * @param {unknown} input.branchUser workspace setting (e.g. `ly`)
 * @param {'feat'|'hot'} [input.family] explicit family override
 * @param {{personalBranch?: unknown, targetBranch?: unknown}} [input.override]
 *   board-level branch overrides
 * @returns {{personalBranch: string, targetBranch: string, family: 'feat'|'hot', baseHint: string}}
 * @throws {BranchError} static `invalid-branch*` / `invalid-family` /
 *   `invalid-version` codes
 */
export function deriveBranches(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new BranchError('invalid-branch', MESSAGE.invalidArguments);
  }

  const overrides = normalizeOverride(input.override);
  const version = normalizeVersion(input.versionName);
  const branchUser = normalizeBranchUser(input.branchUser);
  const family = resolveFamily({
    family: input.family,
    ticketType: input.ticketType,
    typeKey: input.typeKey,
    personalOverride: overrides.personalBranch,
  });

  const personalBranch = overrides.personalBranch
    ?? `${family === 'hot' ? 'hot' : 'feat'}-${version}-${branchUser}`;

  const targetBranch = overrides.targetBranch
    ?? deriveTargetFromPersonal(personalBranch, family, version, branchUser);

  // Defensive: both values are constructed from validated pieces, but keep the
  // factory guarantee even if a future edit forgets a bound.
  assertSafeBranch(personalBranch);
  assertSafeBranch(targetBranch);

  return {
    personalBranch,
    targetBranch,
    family,
    baseHint: targetBranch,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Normalize + validate the override object; absent means `{}`. */
function normalizeOverride(override) {
  if (override === undefined || override === null) return {};
  if (typeof override !== 'object' || Array.isArray(override)) {
    throw new BranchError('invalid-branch', MESSAGE.invalidArguments);
  }

  return {
    personalBranch: normalizeOverrideBranch(override.personalBranch),
    targetBranch: normalizeOverrideBranch(override.targetBranch),
  };
}

function normalizeOverrideBranch(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new BranchError('invalid-branch', MESSAGE.invalidBranch);
  }
  const name = value.trim();
  if (!isSafeBranchName(name)) {
    throw new BranchError('invalid-branch', MESSAGE.invalidBranch);
  }
  return name;
}

/** Sanitize + validate the version suffix; missing/empty is invalid. */
function normalizeVersion(versionName) {
  const version = sanitizeVersion(versionName);
  if (version === '') {
    throw new BranchError('invalid-version', MESSAGE.invalidVersion);
  }

  if (
    version.length > VERSION_LENGTH_LIMIT
    || version === '.'
    || version === '..'
    || version.startsWith('.')
    || version.endsWith('.')
    || version.includes('..')
    || version === '@'
    || version.includes('@{')
    || version.endsWith('.lock')
  ) {
    throw new BranchError('invalid-version', MESSAGE.invalidVersion);
  }
  return version;
}

function normalizeBranchUser(branchUser) {
  if (!isSafeBranchUser(branchUser)) {
    throw new BranchError('invalid-branch-user', MESSAGE.invalidBranchUser);
  }
  return branchUser.trim();
}

/**
 * Family precedence: explicit `family` is validated first; if the personal
 * override states the opposite family it is a contradiction and rejected as
 * `invalid-family`. Without an explicit family, the personal override prefix
 * decides; otherwise a best-effort ticket-type hint decides (`故障`, or a
 * `FAILURE`-containing `typeKey` — a legacy heuristic only, Task 2 passes the
 * synced `ticket.type`/type name), defaulting to `feat`.
 */
function resolveFamily({ family, ticketType, typeKey, personalOverride }) {
  if (family !== undefined && family !== null && family !== 'feat' && family !== 'hot') {
    throw new BranchError('invalid-family', MESSAGE.invalidFamily);
  }

  const overrideFamily = familyOfPersonalBranch(personalOverride);
  const explicit = family === 'feat' || family === 'hot';

  if (explicit && overrideFamily !== undefined && overrideFamily !== family) {
    throw new BranchError('invalid-family', MESSAGE.invalidFamily);
  }
  if (overrideFamily !== undefined) return overrideFamily;
  if (explicit) return family;

  const hint = `${typeof ticketType === 'string' ? ticketType : ''} ${
    typeof typeKey === 'string' ? typeKey : ''
  }`.toLowerCase();
  if (hint.includes('故障') || hint.includes('failure')) {
    return 'hot';
  }
  return 'feat';
}

/** Family implied by a personal-branch prefix, or `undefined`. */
function familyOfPersonalBranch(personalBranch) {
  if (typeof personalBranch !== 'string') return undefined;
  if (personalBranch.startsWith('hot-')) return 'hot';
  if (personalBranch.startsWith('feat-')) return 'feat';
  return undefined;
}

/**
 * Spec rule: target follows the personal branch name. The known prefix picks
 * `feature-`/`hotfix-` and the required `-<branchUser>` suffix is stripped
 * exactly (`feat-custom-ly` → `feature-custom`). A personal override that does
 * not end with `-<branchUser>` is rejected: deriving a target from another
 * user's branch would silently cross the team branch rule. Unknown custom
 * prefixes fall back to the derived `<feature|hotfix>-<X>`.
 */
function deriveTargetFromPersonal(personalBranch, family, version, branchUser) {
  const suffix = `-${branchUser}`;
  if (!personalBranch.endsWith(suffix)) {
    throw new BranchError('invalid-branch', MESSAGE.invalidBranch);
  }

  const base = personalBranch.slice(0, -suffix.length);
  const rules = [
    ['hot-', 'hotfix-'],
    ['feat-', 'feature-'],
  ];

  for (const [prefix, targetPrefix] of rules) {
    if (!base.startsWith(prefix)) continue;
    const rest = base.slice(prefix.length);
    if (rest !== '') return `${targetPrefix}${rest}`;
    break;
  }

  return `${family === 'hot' ? 'hotfix' : 'feature'}-${version}`;
}

function assertSafeBranch(name) {
  if (!isSafeBranchName(name)) {
    throw new BranchError('invalid-branch', MESSAGE.invalidBranch);
  }
}
