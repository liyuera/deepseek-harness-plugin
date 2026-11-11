/** 配置默认值。冻结，避免被调用方改写。 */
import { DEFAULT_MANUAL_GLOBS } from './fixmode.js'
import { DEFAULT_SENSITIVE_GLOBS } from './scope.js'
import { DEFAULT_SUPPRESSIONS_FILE, validateSuppressions } from './suppress.js'

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
  fullReview: true,
  fullReviewMaxFiles: 20,
  reviewerPreset: 'code-review',
  rulesFile: 'rules/rules.json',
  principlesFile: 'rules/principles.md',
  rulePacks: Object.freeze([]),
  // v0.4：证据、复验、覆盖、修复策略、抑制记忆。
  evidenceMode: 'warn',
  coverageMode: 'warn',
  verify: 'blocking',
  maxVerifiedFindings: 3,
  verifyTimeoutMs: 180000,
  respectFixPolicy: true,
  manualFixGlobs: Object.freeze([...DEFAULT_MANUAL_GLOBS]),
  forbiddenFixGlobs: Object.freeze([]),
  suppressionsFile: DEFAULT_SUPPRESSIONS_FILE,
  suppressions: Object.freeze([]),
  // R3：范围审查（/review --range / --patch）、分块与敏感路径。
  maxFileDiffBytes: 61440,
  maxRangeBytes: 4000000,
  rangeTimeoutMs: 900000,
  rangeChunkTimeoutMs: 240000,
  rangeConcurrency: 1,
  reviewerTimeoutPerKbMs: 500,
  reviewerTimeoutMaxMs: 900000,
  sensitiveGlobs: Object.freeze([...DEFAULT_SENSITIVE_GLOBS]),
})

const KEYS = new Set([...Object.keys(DEFAULTS), 'modelOverride'])
const SEVERITIES = new Set(['high', 'medium', 'low', 'nit'])
const EVIDENCE_MODES = new Set(['warn', 'enforce'])
const COVERAGE_MODES = new Set(['warn', 'enforce'])
const VERIFY_MODES = new Set(['off', 'blocking'])

function assertPositiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`code-review: ${name} must be a positive integer`)
  }
}

function assertStringArray(name, value) {
  if (!Array.isArray(value)) throw new Error(`code-review: ${name} must be an array`)
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`code-review: ${name} entries must be non-empty strings`)
    }
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

  for (const field of ['enabled', 'auto', 'fullReview', 'respectFixPolicy']) {
    if (typeof merged[field] !== 'boolean') throw new Error(`code-review: ${field} must be a boolean`)
  }
  assertPositiveInteger('maxRounds', merged.maxRounds)
  assertPositiveInteger('maxDiffBytes', merged.maxDiffBytes)
  assertPositiveInteger('reviewerTimeoutMs', merged.reviewerTimeoutMs)
  assertPositiveInteger('asyncReviewerTimeoutMs', merged.asyncReviewerTimeoutMs)
  assertPositiveInteger('fullReviewMaxFiles', merged.fullReviewMaxFiles)
  assertPositiveInteger('maxVerifiedFindings', merged.maxVerifiedFindings)
  assertPositiveInteger('verifyTimeoutMs', merged.verifyTimeoutMs)
  for (const field of [
    'maxFileDiffBytes', 'maxRangeBytes', 'rangeTimeoutMs', 'rangeChunkTimeoutMs',
    'reviewerTimeoutPerKbMs', 'reviewerTimeoutMaxMs',
  ]) {
    assertPositiveInteger(field, merged[field])
  }
  if (!Number.isSafeInteger(merged.rangeConcurrency) || merged.rangeConcurrency < 1 || merged.rangeConcurrency > 2) {
    throw new Error('code-review: rangeConcurrency must be 1 or 2')
  }

  if (!EVIDENCE_MODES.has(merged.evidenceMode)) {
    throw new Error(`code-review: evidenceMode must be one of ${[...EVIDENCE_MODES].join(', ')}`)
  }
  if (!COVERAGE_MODES.has(merged.coverageMode)) {
    throw new Error(`code-review: coverageMode must be one of ${[...COVERAGE_MODES].join(', ')}`)
  }
  if (!VERIFY_MODES.has(merged.verify)) {
    throw new Error(`code-review: verify must be one of ${[...VERIFY_MODES].join(', ')}`)
  }

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
  for (const field of ['reviewerPreset', 'rulesFile', 'principlesFile', 'suppressionsFile']) {
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
  assertStringArray('manualFixGlobs', merged.manualFixGlobs)
  assertStringArray('forbiddenFixGlobs', merged.forbiddenFixGlobs)
  assertStringArray('sensitiveGlobs', merged.sensitiveGlobs)

  let modelOverride
  if (merged.modelOverride !== undefined) {
    const { provider, model } = merged.modelOverride ?? {}
    if (typeof provider !== 'string' || typeof model !== 'string' || !provider || !model) {
      throw new Error('code-review: modelOverride needs both provider and model')
    }
    modelOverride = Object.freeze({ provider, model })
  }

  const suppressions = validateSuppressions(merged.suppressions)

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
    fullReview: merged.fullReview,
    fullReviewMaxFiles: merged.fullReviewMaxFiles,
    reviewerPreset: merged.reviewerPreset,
    rulesFile: merged.rulesFile,
    principlesFile: merged.principlesFile,
    rulePacks: Object.freeze([...merged.rulePacks]),
    evidenceMode: merged.evidenceMode,
    coverageMode: merged.coverageMode,
    verify: merged.verify,
    maxVerifiedFindings: merged.maxVerifiedFindings,
    verifyTimeoutMs: merged.verifyTimeoutMs,
    respectFixPolicy: merged.respectFixPolicy,
    manualFixGlobs: Object.freeze([...merged.manualFixGlobs]),
    forbiddenFixGlobs: Object.freeze([...merged.forbiddenFixGlobs]),
    suppressionsFile: merged.suppressionsFile,
    suppressions,
    maxFileDiffBytes: merged.maxFileDiffBytes,
    maxRangeBytes: merged.maxRangeBytes,
    rangeTimeoutMs: merged.rangeTimeoutMs,
    rangeChunkTimeoutMs: merged.rangeChunkTimeoutMs,
    rangeConcurrency: merged.rangeConcurrency,
    reviewerTimeoutPerKbMs: merged.reviewerTimeoutPerKbMs,
    reviewerTimeoutMaxMs: merged.reviewerTimeoutMaxMs,
    sensitiveGlobs: Object.freeze([...merged.sensitiveGlobs]),
    ...(modelOverride === undefined ? {} : { modelOverride }),
  })
}
