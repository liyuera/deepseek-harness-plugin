/**
 * 跨轮 finding 账本：基于 journal 历史计算 repeats / 未再见。
 *
 * 账本只做展示与人工裁决辅助，不写回「已修复」，也不自动关闭问题：
 * - repeats ≥ 2 表示同一指纹在历史轮次已经报过，报告里标「第 N 次报告（尚未修复）」；
 * - 连续 {@link RESOLVE_AFTER_MISSES} 轮未再出现才提示人工确认，避免把「模型漏报」当成修复。
 * @module @liyuera/dsh-code-review/host/ledger
 */

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
 * 历史 finding 中「本轮未再出现」且连续缺失达阈值的条目。
 *
 * 本轮被抑制的问题要计入 `currentFingerprints`（人工裁决不等于已修复）。
 * @param {readonly object[]} priorRecords journal 记录（只有 completed 参与统计）
 * @param {ReadonlySet<string>} currentFingerprints 本轮仍在跟踪的指纹（含被抑制项）
 * @returns {object[]} finding 副本，额外带 `missedRuns`（缺失的连续轮次，含本轮）
 */
export function notObservedFindings(priorRecords, currentFingerprints) {
  const ordered = [...(priorRecords ?? [])]
    .filter((record) => record?.status === 'completed')
    .sort((left, right) => (right?.startedAt ?? 0) - (left?.startedAt ?? 0))
  const latest = new Map()
  ordered.forEach((record, index) => {
    for (const finding of findingsOf(record)) {
      const fingerprint = fingerprintOf(finding)
      if (fingerprint === undefined || latest.has(fingerprint)) continue
      // 只记最近一次出现；它之后的轮次（含本轮）都算「未再见」。
      latest.set(fingerprint, { finding, missedRuns: index + 1 })
    }
  })
  const result = []
  for (const [fingerprint, entry] of latest) {
    if (currentFingerprints.has(fingerprint)) continue
    if (entry.missedRuns < RESOLVE_AFTER_MISSES) continue
    result.push({ ...entry.finding, missedRuns: entry.missedRuns })
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
