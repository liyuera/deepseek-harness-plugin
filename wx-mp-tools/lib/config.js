/**
 * Plugin configuration: defaults, validation, and environment fallbacks.
 *
 * Every field is optional. The bundle patch row may override any of them; the
 * CLI access token additionally falls back to `WECHAT_DEVTOOLS_CLI_TOKEN` so a
 * secret never has to be committed to `cordis.patch.yml`.
 * @module @liyuera/dsh-wx-mp-tools/config
 */

/** Default client name shown in the WeChat DevTools authorization dialog. */
export const DEFAULT_CLIENT_NAME = 'dsh'

/** Default bound for one `wechatide` invocation (ms). */
export const DEFAULT_TIMEOUT_MS = 180_000

/** Default model-facing text cap for one tool result (characters). */
export const DEFAULT_MAX_TEXT_CHARS = 60_000

/** Client names are echoed back by the IDE and used as an identity key. */
const CLIENT_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/

/**
 * Agent presets that get the `wx-mp` skill body preloaded into the system
 * prompt. Defaults to 李昱模式 (`liyu`) because that is this deployment's
 * default preset; set `primePresets: []` to disable priming entirely.
 */
export const DEFAULT_PRIME_PRESETS = Object.freeze(['liyu'])

/**
 * Read one optional non-empty string.
 * @param {unknown} value - candidate value.
 * @param {string | undefined} fallback - value used when the candidate is absent.
 * @returns {string | undefined} the resolved string.
 */
function optionalString(value, fallback) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return fallback
}

/**
 * Read a finite positive integer, falling back when the value is invalid.
 * @param {unknown} value - candidate value.
 * @param {number} fallback - value used when the candidate is invalid.
 * @returns {number} the resolved integer.
 */
function positiveInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.max(1, Math.round(value))
}

/**
 * Resolve the plugin configuration once, at activation.
 * @param {Record<string, unknown>} [raw] - the loader row config.
 * @param {NodeJS.ProcessEnv} [env] - environment source (tests inject one).
 * @returns {{
 *   cliPath: string | undefined,
 *   clientName: string,
 *   token: string | undefined,
 *   project: string | undefined,
 *   timeoutMs: number,
 *   maxTextChars: number,
 *   skillVersion: string | undefined,
 *   primePresets: readonly string[],
 * }} the resolved configuration.
 */
/**
 * Read the preset-id whitelist for skill priming.
 * @param {unknown} value - candidate value (array or comma-separated string).
 * @returns {string[]} validated preset ids; empty disables priming.
 */
function primePresetList(value) {
  if (Array.isArray(value)) {
    return value
      .filter(item => typeof item === 'string' && item.trim() !== '')
      .map(item => item.trim())
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return value.split(',').map(item => item.trim()).filter(item => item !== '')
  }
  return [...DEFAULT_PRIME_PRESETS]
}

export function resolveConfig(raw = {}, env = process.env) {
  const clientName = optionalString(raw.clientName, DEFAULT_CLIENT_NAME)
  const token = optionalString(raw.token, optionalString(env.WECHAT_DEVTOOLS_CLI_TOKEN, undefined))
  const cliPath = optionalString(raw.cliPath, optionalString(env.WECHATIDE_CLI_PATH, undefined))
  return {
    cliPath,
    clientName: CLIENT_NAME_PATTERN.test(clientName ?? '') ? clientName : DEFAULT_CLIENT_NAME,
    token,
    project: optionalString(raw.project, undefined),
    timeoutMs: positiveInt(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxTextChars: positiveInt(raw.maxTextChars, DEFAULT_MAX_TEXT_CHARS),
    // Optional override for `check_wechatide_status --skill-version`. Omitted by
    // default: this plugin consumes the CLI tool surface, not the skill files,
    // so a version mismatch is informational rather than blocking.
    skillVersion: optionalString(raw.skillVersion, undefined),
    primePresets: primePresetList(raw.primePresets),
  }
}
