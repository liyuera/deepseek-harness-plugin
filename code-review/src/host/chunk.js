/**
 * 范围审查的分块与归并：把大 diff 切成每次 reviewer 调用可承受的块，
 * 合并多块 findings（去重、按严重度截断）与 coverage；超时按字节数自适应。
 * @module @liyuera/dsh-code-review/host/chunk
 */
import { locationPath } from './evidence.js'
import { SEVERITY_RANK } from './render.js'
import { MAX_FINDINGS } from './structured.js'

/**
 * 按顺序把文件装块，单块 diff 字节数不超过 `maxDiffBytes`。
 * 单文件本身超过上限时独占一块（正常路径下 collect 已按 maxFileDiffBytes 拦住）。
 * @param {readonly object[]} files
 * @param {number} maxDiffBytes
 * @returns {object[][]}
 */
export function chunkFiles(files, maxDiffBytes) {
  const limit = Number.isSafeInteger(maxDiffBytes) && maxDiffBytes > 0 ? maxDiffBytes : 200000
  const chunks = []
  let current = []
  let bytes = 0
  for (const file of files) {
    const size = Buffer.byteLength(String(file?.text ?? ''), 'utf8')
    if (current.length > 0 && bytes + size > limit) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(file)
    bytes += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * 以最多 `limit` 个并发执行 mapper，结果按输入顺序返回。
 * 用于 rangeConcurrency：默认 1（串行），最大 2。
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} mapper
 * @returns {Promise<R[]>}
 */
export async function mapWithLimit(items, limit, mapper) {
  const list = Array.isArray(items) ? items : []
  const results = new Array(list.length)
  let next = 0
  const width = Math.max(1, Math.min(Number.isSafeInteger(limit) ? limit : 1, list.length))
  const worker = async () => {
    while (next < list.length) {
      const index = next
      next += 1
      results[index] = await mapper(list[index], index)
    }
  }
  await Promise.all(Array.from({ length: width }, () => worker()))
  return results
}

/**
 * 按块字节数放大 reviewer 超时：`min(maxMs, baseMs + ceil(KB) * perKbMs)`。
 * @param {number} bytes
 * @param {{baseMs?: number, perKbMs?: number, maxMs?: number}} [options]
 * @returns {number}
 */
export function timeoutFor(bytes, { baseMs = 120000, perKbMs = 500, maxMs = 900000 } = {}) {
  const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  const extra = Math.ceil(size / 1024) * Math.max(0, perKbMs)
  return Math.min(maxMs, baseMs + extra)
}

const findingKey = (finding) => [
  String(finding.ruleId ?? ''),
  locationPath(finding.location),
  String(finding.problem ?? '').trim().toLowerCase().replace(/\s+/g, ' '),
].join('\0')

/**
 * 合并多块审查结果：
 * - findings 按 `(ruleId, path, 规范化 problem)` 去重（同一问题被相邻块重复报只留一份）；
 * - evidence 与合并后的 findings 对齐；
 * - 超过 MAX_FINDINGS 按严重度截断；
 * - coverage 按块累加，任一块未申报即标记缺失。
 *
 * @param {readonly {findings: object[], evidence?: string[], coverage?: object}[]} results
 * @returns {{findings: object[], evidence: string[], coverage: object, truncated: number}}
 */
export function mergeReviews(results) {
  const seen = new Set()
  const pairs = []
  for (const result of results ?? []) {
    const findings = Array.isArray(result?.findings) ? result.findings : []
    const evidence = Array.isArray(result?.evidence) ? result.evidence : []
    findings.forEach((finding, index) => {
      const key = findingKey(finding)
      if (seen.has(key)) return
      seen.add(key)
      pairs.push({ finding, status: evidence[index] ?? 'unchecked' })
    })
  }
  pairs.sort(
    (left, right) => (SEVERITY_RANK[left.finding.severity] ?? Number.MAX_SAFE_INTEGER)
      - (SEVERITY_RANK[right.finding.severity] ?? Number.MAX_SAFE_INTEGER),
  )
  const kept = pairs.slice(0, MAX_FINDINGS)
  return {
    findings: kept.map((pair) => pair.finding),
    evidence: kept.map((pair) => pair.status),
    coverage: mergeCoverage((results ?? []).map((result) => result?.coverage)),
    truncated: Math.max(0, pairs.length - kept.length),
  }
}

/**
 * 合并多个 coverage 块。
 * @param {readonly (object | undefined)[]} coverages
 * @returns {{valid:boolean, missing:boolean, files:object[], reviewed:number, skipped:number, unaccounted:number}}
 */
export function mergeCoverage(coverages) {
  const present = (coverages ?? []).filter((coverage) => coverage !== undefined && coverage !== null)
  let reviewed = 0
  let skipped = 0
  let unaccounted = 0
  for (const coverage of present) {
    reviewed += Number(coverage.reviewed) || 0
    skipped += Number(coverage.skipped) || 0
    unaccounted += Number(coverage.unaccounted) || 0
  }
  return {
    valid: present.length > 0 && present.every((coverage) => coverage.valid === true),
    missing: present.length === 0 || present.every((coverage) => coverage.missing === true),
    files: [],
    reviewed,
    skipped,
    unaccounted,
  }
}
