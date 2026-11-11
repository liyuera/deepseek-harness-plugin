/**
 * 跨轮 finding 账本：基于 journal 历史计算 repeats / 未再见。
 *
 * 账本只做展示与人工裁决辅助，不写回「已修复」，也不自动关闭问题：
 * - repeats ≥ 2 表示同一指纹在历史轮次已经报过，报告里标「第 N 次报告（尚未修复）」；
 * - 「未再见」只统计**确实审过该 finding 所在文件**的轮次：turn 轮只覆盖当轮 diff，
 *   相邻 turn 改不同文件时缺省不算缺席；连续 {@link RESOLVE_AFTER_MISSES} 轮审过该文件
 *   却未再出现，才提示人工确认，避免把「没审」和「模型漏报」当成修复。
 * @module @liyuera/dsh-code-review/host/ledger
 */
import { locationPath } from './evidence.js'

/** 连续多少轮未再出现才提示「可人工确认已修复」。 */
export const RESOLVE_AFTER_MISSES = 2

/** 计算账本时回看的 journal 记录条数上限（单会话 journal 最多保留 50 条）。 */
export const LEDGER_WINDOW = 20

const findingsOf = (record) => (Array.isArray(record?.findings) ? record.findings : [])

const fingerprintOf = (finding) => (
  typeof finding?.fingerprint === 'string' && finding.fingerprint.length > 0
    ? finding.fingerprint
    : undefined
)

/**
 * 一轮审查实际覆盖的路径集合。老记录没有 `paths` 时返回 undefined：
 * 无法证明它审过某个文件，账本按「未覆盖」保守处理，不累计缺席。
 * @param {readonly string[] | undefined} paths
 * @returns {Set<string> | undefined}
 */
function coverageOf(paths) {
  if (!Array.isArray(paths)) return undefined
  return new Set(paths.filter((path) => typeof path === 'string' && path.length > 0))
}

/**
 * 给本轮 findings 标注历史重复次数，不修改入参。
 * @param {readonly object[]} findings 本轮已带 fingerprint 的 findings
 * @param {readonly object[]} priorRecords journal 记录（顺序不限，只有 completed 参与统计）
 * @returns {object[]}
 */
export function annotateRepeats(findings, priorRecords) {
  const history = new Map()
  const ordered = [...(priorRecords ?? [])].sort(
    (left, right) => (left?.startedAt ?? 0) - (right?.startedAt ?? 0),
  )
  for (const record of ordered) {
    if (record?.status !== 'completed') continue
    for (const finding of findingsOf(record)) {
      const fingerprint = fingerprintOf(finding)
      if (fingerprint === undefined) continue
      const entry = history.get(fingerprint)
      if (entry === undefined) {
        history.set(fingerprint, { firstSeenAt: record.startedAt ?? 0, runs: 1 })
      } else {
        entry.runs += 1
      }
    }
  }
  return findings.map((finding) => {
    const entry = history.get(fingerprintOf(finding))
    if (entry === undefined) return finding
    return { ...finding, repeats: entry.runs + 1, firstSeenAt: entry.firstSeenAt }
  })
}

/**
 * 历史 finding 中「本轮及最近若干轮都审过其文件、却未再出现」且连续缺席达阈值的条目。
 *
 * 本轮被抑制的问题要计入 `currentFingerprints`（人工裁决不等于已修复）。
 * 本轮或中间任一轮没有覆盖该 finding 的文件时，不推断「已修复」——turn 轮只审当轮改动，
 * 没送审不能算缺席；没有 `paths` 的老记录同样不参与累计。
 *
 * @param {readonly object[]} priorRecords journal 记录（只有 completed 参与统计）
 * @param {ReadonlySet<string>} currentFingerprints 本轮仍在跟踪的指纹（含被抑制项）
 * @param {readonly string[]} currentPaths 本轮实际送审的文件路径
 * @returns {object[]} finding 副本，额外带 `missedRuns`（连续审过该文件且未出现的轮次，含本轮）
 */
export function notObservedFindings(priorRecords, currentFingerprints, currentPaths) {
  const currentCoverage = coverageOf(currentPaths)
  // 没有本轮审查范围（或老调用方不传）就无法证明「未见」，不产生任何推断。
  if (currentCoverage === undefined) return []
  const ordered = [...(priorRecords ?? [])]
    .filter((record) => record?.status === 'completed')
    .sort((left, right) => (right?.startedAt ?? 0) - (left?.startedAt ?? 0))
  const latest = new Map()
  ordered.forEach((record, index) => {
    for (const finding of findingsOf(record)) {
      const fingerprint = fingerprintOf(finding)
      if (fingerprint === undefined || latest.has(fingerprint)) continue
      // 只记最近一次出现；它之后的轮次按「该文件是否送审」逐轮核对。
      latest.set(fingerprint, { finding, index })
    }
  })
  const result = []
  for (const [fingerprint, entry] of latest) {
    if (currentFingerprints.has(fingerprint)) continue
    const path = locationPath(entry.finding.location)
    if (!currentCoverage.has(path)) continue
    let missedRuns = 1 // 本轮审过该文件且未出现
    let coveredEveryRound = true
    for (let index = 0; index < entry.index; index += 1) {
      const coverage = coverageOf(ordered[index].paths)
      if (coverage === undefined || !coverage.has(path)) {
        // 有一轮没审这个文件：不能把这段空白算成「连续未见」。
        coveredEveryRound = false
        break
      }
      missedRuns += 1
    }
    if (!coveredEveryRound || missedRuns < RESOLVE_AFTER_MISSES) continue
    result.push({ ...entry.finding, missedRuns })
  }
  return result
}

/**
 * 近期运行统计，供 journal 脚注一次性展示。
 * @param {readonly object[]} records
 * @returns {{total:number, completed:number, incomplete:number, findings:number, suppressed:number, coverageReviewed:number, coverageSkipped:number, verificationChecked:number, verificationConfirmed:number}}
 */
export function summarizeRecords(records) {
  const summary = {
    total: 0,
    completed: 0,
    incomplete: 0,
    findings: 0,
    suppressed: 0,
    coverageReviewed: 0,
    coverageSkipped: 0,
    verificationChecked: 0,
    verificationConfirmed: 0,
  }
  for (const record of records ?? []) {
    summary.total += 1
    if (record?.status !== 'completed') {
      summary.incomplete += 1
      continue
    }
    summary.completed += 1
    summary.findings += Number(record.findingsTotal) || 0
    summary.suppressed += Number(record.suppressed) || 0
    if (record.coverage?.valid === true) {
      summary.coverageReviewed += Number(record.coverage.reviewed) || 0
      summary.coverageSkipped += Number(record.coverage.skipped) || 0
    }
    if (record.verification !== undefined) {
      summary.verificationChecked += Number(record.verification.checked) || 0
      summary.verificationConfirmed += Number(record.verification.confirmed) || 0
    }
  }
  return summary
}
