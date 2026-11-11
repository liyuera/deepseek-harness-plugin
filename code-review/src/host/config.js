/** 配置默认值。冻结，避免被调用方改写。 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  auto: true,
  maxRounds: 2,
  blockingSeverities: Object.freeze(['high', 'medium']),
  notifySeverities: Object.freeze([]),
  codeExtensions: Object.freeze([
    '.js', '.jsx', '.ts', '.tsx', '.vue', '.py', '.go', '.java', '.rs', '.css', '.less', '.scss',
  ]),
  maxDiffBytes: 200000,
  reviewerTimeoutMs: 120000,
  asyncReviewerTimeoutMs: 600000,
  reviewerPreset: 'code-review',
  rulesFile: 'rules/rules.json',
  principlesFile: 'rules/principles.md',
  rulePacks: Object.freeze([]),
})

const KEYS = new Set([...Object.keys(DEFAULTS), 'modelOverride'])
const SEVERITIES = new Set(['high', 'medium', 'low', 'nit'])

function assertPositiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`code-review: ${name} must be a positive integer`)
  }
}

/**
 * 校验并冻结一份配置。未知键、非法枚举、负值一律抛错，不静默兜底。
 * @param {object} [raw] 用户配置
 * @returns {Readonly<object>}
 */
export function resolveConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('code-review: config must be an object')
  }
  for (const key of Object.keys(raw)) {
    if (!KEYS.has(key)) throw new Error(`code-review: unknown config key "${key}"`)
  }
  const merged = { ...DEFAULTS, ...raw }

  for (const field of ['enabled', 'auto']) {
    if (typeof merged[field] !== 'boolean') throw new Error(`code-review: ${field} must be a boolean`)
  }
  assertPositiveInteger('maxRounds', merged.maxRounds)
  assertPositiveInteger('maxDiffBytes', merged.maxDiffBytes)
  assertPositiveInteger('reviewerTimeoutMs', merged.reviewerTimeoutMs)
  assertPositiveInteger('asyncReviewerTimeoutMs', merged.asyncReviewerTimeoutMs)

  if (!Array.isArray(merged.blockingSeverities) || merged.blockingSeverities.length === 0) {
    throw new Error('code-review: blockingSeverities must be a non-empty array')
  }
  for (const severity of merged.blockingSeverities) {
    if (!SEVERITIES.has(severity)) throw new Error(`code-review: invalid severity "${severity}"`)
  }
  if (!Array.isArray(merged.notifySeverities)) {
    throw new Error('code-review: notifySeverities must be an array')
  }
  for (const severity of merged.notifySeverities) {
    if (!SEVERITIES.has(severity)) throw new Error(`code-review: invalid severity "${severity}"`)
  }
  if (!Array.isArray(merged.codeExtensions)) {
    throw new Error('code-review: codeExtensions must be an array')
  }
  for (const extension of merged.codeExtensions) {
    if (typeof extension !== 'string' || !extension.startsWith('.')) {
      throw new Error('code-review: codeExtensions entries must start with "."')
    }
  }
  for (const field of ['reviewerPreset', 'rulesFile', 'principlesFile']) {
    if (typeof merged[field] !== 'string' || merged[field].length === 0) {
      throw new Error(`code-review: ${field} must be a non-empty string`)
    }
  }
  if (!Array.isArray(merged.rulePacks)) {
    throw new Error('code-review: rulePacks must be an array')
  }
  for (const pack of merged.rulePacks) {
    if (typeof pack !== 'string' || pack.length === 0) {
      throw new Error('code-review: rulePacks entries must be non-empty strings')
    }
  }

  let modelOverride
  if (merged.modelOverride !== undefined) {
    const { provider, model } = merged.modelOverride ?? {}
    if (typeof provider !== 'string' || typeof model !== 'string' || !provider || !model) {
      throw new Error('code-review: modelOverride needs both provider and model')
    }
    modelOverride = Object.freeze({ provider, model })
  }

  return Object.freeze({
    enabled: merged.enabled,
    auto: merged.auto,
    maxRounds: merged.maxRounds,
    blockingSeverities: Object.freeze([...merged.blockingSeverities]),
    notifySeverities: Object.freeze([...merged.notifySeverities]),
    codeExtensions: Object.freeze([...merged.codeExtensions]),
    maxDiffBytes: merged.maxDiffBytes,
    reviewerTimeoutMs: merged.reviewerTimeoutMs,
    asyncReviewerTimeoutMs: merged.asyncReviewerTimeoutMs,
    reviewerPreset: merged.reviewerPreset,
    rulesFile: merged.rulesFile,
    principlesFile: merged.principlesFile,
    rulePacks: Object.freeze([...merged.rulePacks]),
    ...(modelOverride === undefined ? {} : { modelOverride }),
  })
}
