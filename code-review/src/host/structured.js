/**
 * 结构化输出校验：schema 形状、规则/路径白名单、证据与 coverage。
 * 从 reviewer.js 拆出，保持 activation 生命周期与 prompt 组装的文件体积可控。
 * @module @liyuera/dsh-code-review/host/structured
 */
import { locationPath, validateFindingEvidence } from './evidence.js'
import { SEVERITY_RANK } from './render.js'

/** 单次审查最多保留的 findings：超出按严重度截断，避免回灌消息与修复成本失控。 */
export const MAX_FINDINGS = 20

const DIMENSIONS = new Set(['correctness', 'security', 'performance', 'maintainability'])
const SEVERITIES = new Set(['high', 'medium', 'low', 'nit'])
const LOCATION_SUFFIX = /^\d+(?:-\d+)?$/
const COVERAGE_STATUSES = new Set(['reviewed', 'sampled', 'skipped'])

export function normalizeFinding(finding, allowedRuleIds, allowedPaths, ruleSeverities) {
  if (typeof finding !== 'object' || finding === null) return undefined
  const { ruleId, dimension, severity, location, problem, suggestion, evidence } = finding
  const strings = [ruleId, dimension, severity, location, problem, suggestion]
  if (!strings.every((value) => typeof value === 'string' && value.length > 0)) return undefined
  if (!DIMENSIONS.has(dimension) || !SEVERITIES.has(severity)) return undefined
  const knownRule = allowedRuleIds.has(ruleId)
  const principled = knownRule && ruleId === `PRINCIPLE-${dimension}`
  if (!knownRule || (ruleId.startsWith('PRINCIPLE-') && !principled)) return undefined
  const separator = location.lastIndexOf(':')
  if (separator <= 0) return undefined
  const path = location.slice(0, separator)
  if (!LOCATION_SUFFIX.test(location.slice(separator + 1))) return undefined
  if (!allowedPaths.has(path)) return undefined
  // 硬规则的 severity 以规则表为权威；PRINCIPLE-* 不在表里，保留模型判断。
  const authoritative = ruleSeverities?.has(ruleId) ? ruleSeverities.get(ruleId) : severity
  return {
    ruleId, dimension, severity: authoritative, location, problem, suggestion,
    ...(evidence === undefined ? {} : { evidence }),
  }
}

/**
 * 校验 coverage 块。
 * @param {unknown} raw
 * @param {Set<string>} allowedPaths
 * @returns {{valid:boolean, missing:boolean, invalid?:boolean, files:object[], reviewed:number, skipped:number, unaccounted:number}}
 */
export function normalizeCoverage(raw, allowedPaths) {
  const empty = {
    valid: false, missing: true, files: [], reviewed: 0, skipped: 0,
    unaccounted: allowedPaths.size,
  }
  if (raw === undefined || raw === null) return empty
  if (typeof raw !== 'object' || !Array.isArray(raw.files)) return { ...empty, missing: false, invalid: true }
  const files = []
  const seen = new Set()
  let valid = true
  for (const entry of raw.files) {
    if (typeof entry !== 'object' || entry === null) { valid = false; continue }
    const { path, status, reason } = entry
    if (typeof path !== 'string' || path.length === 0 || !allowedPaths.has(path)) { valid = false; continue }
    if (seen.has(path) || !COVERAGE_STATUSES.has(status)) { valid = false; continue }
    if (status === 'skipped' && (typeof reason !== 'string' || reason.length === 0)) { valid = false; continue }
    seen.add(path)
    files.push({ path, status, ...(status === 'skipped' ? { reason } : {}) })
  }
  return {
    valid,
    missing: false,
    files,
    reviewed: files.filter((file) => file.status !== 'skipped').length,
    skipped: files.filter((file) => file.status === 'skipped').length,
    unaccounted: [...allowedPaths].filter((path) => !seen.has(path)).length,
  }
}

/**
 * 校验结构化输出并落成 findings。
 *
 * 证据上下文（`evidenceContext.files`）存在时，每个 finding 都要通过 evidence.js 的校验；
 * 缺失/不可读按模式保留，片段不符在 warn 下保留但标记，enforce 下丢弃。
 *
 * @param {unknown} structured
 * @param {{allowedRuleIds: Set<string>, allowedPaths: Set<string>, ruleSeverities?: Map<string,string>, logger?: object, evidenceContext?: object, evidenceMode?: 'warn'|'enforce', coverageMode?: 'warn'|'enforce'}} input
 * @returns {{ok:true, findings: object[], evidence: string[], coverage: object} | {ok:false, reason:string}}
 */
export function validateStructured(structured, {
  allowedRuleIds, allowedPaths, ruleSeverities, logger,
  evidenceContext, evidenceMode = 'warn', coverageMode = 'warn',
}) {
  if (typeof structured !== 'object' || structured === null || !Array.isArray(structured.findings)) {
    return { ok: false, reason: 'invalid-result' }
  }
  const fileMap = new Map()
  if (evidenceContext !== undefined && Array.isArray(evidenceContext.files)) {
    for (const file of evidenceContext.files) {
      if (typeof file?.path === 'string') fileMap.set(file.path, file)
    }
  }
  const rawFindings = structured.findings
  const candidates = []
  let invalid = 0
  let outside = 0
  let mismatchDropped = 0
  let missingDropped = 0
  for (const raw of rawFindings) {
    const finding = normalizeFinding(raw, allowedRuleIds, allowedPaths, ruleSeverities)
    if (finding === undefined) { invalid += 1; continue }
    let status = 'unchecked'
    if (evidenceContext !== undefined) {
      const file = fileMap.get(locationPath(finding.location))
      status = validateFindingEvidence(finding, file).status
      if (status === 'outside') { outside += 1; continue }
      if (status === 'mismatch' && evidenceMode === 'enforce') { mismatchDropped += 1; continue }
      if (status === 'missing' && evidenceMode === 'enforce') { missingDropped += 1; continue }
    }
    candidates.push({ finding, status })
  }
  const dropped = rawFindings.length - candidates.length
  if (invalid > 0) logger?.warn?.(`[code-review] 丢弃 ${invalid} 条非法 finding`)
  if (outside > 0) logger?.warn?.(`[code-review] 丢弃 ${outside} 条定位不在本轮变更 hunk 内的 finding`)
  if (mismatchDropped > 0) {
    logger?.warn?.(`[code-review] 证据片段不符，丢弃 ${mismatchDropped} 条 finding`)
  }
  if (missingDropped > 0) {
    logger?.warn?.(`[code-review] 缺少证据片段，丢弃 ${missingDropped} 条 finding`)
  }
  // 全被丢弃说明模型输出不可用（规则/路径/格式/证据全不合规），不能当成「没有问题」。
  if (dropped > 0 && candidates.length === 0) return { ok: false, reason: 'invalid-result' }
  // 超出上限：按严重度取前 MAX_FINDINGS 条，避免回灌消息与修复成本失控。
  candidates.sort(
    (left, right) => (SEVERITY_RANK[left.finding.severity] ?? Number.MAX_SAFE_INTEGER)
      - (SEVERITY_RANK[right.finding.severity] ?? Number.MAX_SAFE_INTEGER),
  )
  const kept = candidates.slice(0, MAX_FINDINGS)
  if (candidates.length > MAX_FINDINGS) {
    logger?.warn?.(`[code-review] findings 超过 ${MAX_FINDINGS} 条，按严重度截断`)
  }
  const coverage = normalizeCoverage(structured.coverage, allowedPaths)
  if (coverageMode === 'enforce' && !coverage.valid) {
    return { ok: false, reason: coverage.invalid === true ? 'invalid-coverage' : 'missing-coverage' }
  }
  const mismatch = candidates.slice(0, MAX_FINDINGS).filter((entry) => entry.status === 'mismatch').length
  if (mismatch > 0 && evidenceMode !== 'enforce') {
    logger?.warn?.(`[code-review] 证据片段不符，${mismatch} 条 finding 降级为仅报告`)
  }
  return {
    ok: true,
    findings: kept.map((entry) => entry.finding),
    evidence: kept.map((entry) => entry.status),
    coverage,
  }
}

/**
 * 校验一次 activation 的结算结果：先要求正常跑完，再校验 structured。
 *
 * @param {unknown} result
 * @param {object} options
 * @returns {{ok:true, findings: object[], evidence: string[], coverage: object} | {ok:false, reason:string}}
 */
export function validateResult(result, options) {
  if (result?.stopReason !== 'completed' || result.structured === undefined) {
    return { ok: false, reason: 'incomplete' }
  }
  return validateStructured(result.structured, options)
}

