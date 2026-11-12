/**
 * 结构化输出校验：schema 形状、规则/路径白名单、证据与 coverage。
 * 从 reviewer.js 拆出，保持 activation 生命周期与 prompt 组装的文件体积可控。
 * @module @liyuera/dsh-code-review/host/structured
 */
import { locationLine, locationPath, validateFindingEvidence } from './evidence.js'
import { RULE_DIMENSIONS } from './rules.js'
import { SEVERITY_RANK } from './render.js'

/** 单次审查最多保留的 findings：超出按严重度截断，避免回灌消息与修复成本失控。 */
export const MAX_FINDINGS = 20

const DIMENSIONS = new Set(RULE_DIMENSIONS)
const SEVERITIES = new Set(['high', 'medium', 'low', 'nit'])
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
  if (locationLine(location) === undefined) return undefined
  const path = locationPath(location)
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

/** 输出形状的单一说明，prompt 与文档共用。 */
export const OUTPUT_SHAPE = '{"findings":[{"ruleId","dimension","severity","location","problem","suggestion","evidence"}],'
  + '"coverage":{"files":[{"path","status","reason?"}]}}'

/**
 * 从模型最终文本里提取第一个 JSON 对象：优先 ```json 围栏，其次整段里的首个 `{` 到末个 `}`。
 * 文本模式下 provider 不会校验 JSON，这里必须容错（围栏外可有说明、围栏语言可省略）。
 * @param {unknown} text
 * @returns {object | undefined}
 */
export function extractJsonFromText(text) {
  const source = String(text ?? '')
  const candidates = [...source.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)].map((match) => match[1])
  candidates.push(source)
  for (const candidate of candidates) {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1))
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch {
      // 尝试下一个候选
    }
  }
  return undefined
}

/**
 * 从 activation 结算结果里取结构化输出：
 * - 工具模式（outputSchema）走 `result.structured`；
 * - 文本模式从 `result.output` 的 text block 解析，避免 provider 校验 tool-call 参数 JSON。
 * @param {unknown} result
 * @returns {unknown | undefined}
 */
export function structuredFromResult(result) {
  if (result?.structured !== undefined) return result.structured
  const output = result?.output
  const text = typeof output === 'string'
    ? output
    : Array.isArray(output)
      ? output.filter((block) => block?.type === 'text').map((block) => String(block.text ?? '')).join('\n')
      : ''
  return extractJsonFromText(text)
}

/**
 * 校验一次 activation 的结算结果：先要求正常跑完，再校验结构化输出
 * （structured 优先，文本 JSON 回退）。
 *
 * @param {unknown} result
 * @param {object} options
 * @returns {{ok:true, findings: object[], evidence: string[], coverage: object} | {ok:false, reason:string}}
 */
export function validateResult(result, options) {
  if (result?.stopReason !== 'completed') return { ok: false, reason: 'incomplete' }
  const structured = structuredFromResult(result)
  if (structured === undefined) return { ok: false, reason: 'invalid-result' }
  return validateStructured(structured, options)
}

