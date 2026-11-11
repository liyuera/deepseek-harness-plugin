/**
 * 把结构化 findings 渲染成回注给主代理的紧凑文本。
 * @module @liyuera/dsh-code-review/host/render
 */
const DIMENSION_LABEL = Object.freeze({
  correctness: '正确性',
  security: '安全',
  performance: '性能',
  maintainability: '可维护性',
  behavior: '行为',
})

/** 严重度排名：数字越小越严重。渲染与截断共用同一份顺序。 */
export const SEVERITY_RANK = Object.freeze({ high: 0, medium: 1, low: 2, nit: 3 })

/** `/review` 报告固定边界声明：报告不构成合入批准，未审项以覆盖行为准。 */
export const BOUNDARY_LINE = '边界: 本报告只覆盖本次改动与可读取文件；覆盖缺口见覆盖行，结论不构成合入批准。'

function bySeverity(findings) {
  return [...findings].sort(
    (left, right) => (SEVERITY_RANK[left.severity] ?? Number.MAX_SAFE_INTEGER)
      - (SEVERITY_RANK[right.severity] ?? Number.MAX_SAFE_INTEGER),
  )
}

/**
 * 按阻塞阈值切分 findings（只按 severity，保留给旧调用方）。
 * @param {readonly object[]} findings
 * @param {readonly string[]} blockingSeverities
 * @returns {{blocking: object[], passive: object[]}}
 */
export function partition(findings, blockingSeverities) {
  const blockingSet = new Set(blockingSeverities)
  const blocking = []
  const passive = []
  for (const finding of findings) (blockingSet.has(finding.severity) ? blocking : passive).push(finding)
  return { blocking, passive }
}

/**
 * v0.4 分类：在 severity 之上叠加 blocking / fixMode / 复验结论。
 * - auto：可自动修复的阻塞项；
 * - manual：需人工确认的阻塞项（生成代码/契约/权限/迁移等）；
 * - unverified：未复验或证据片段不符，只报告不修复；
 * - passive：非阻塞建议。
 * @param {readonly object[]} findings
 * @param {readonly string[]} blockingSeverities
 * @param {boolean} [respectFixPolicy]
 * @returns {{auto: object[], manual: object[], unverified: object[], passive: object[]}}
 */
export function classifyFindings(findings, blockingSeverities, respectFixPolicy = true) {
  const blockingSet = new Set(blockingSeverities)
  const buckets = { auto: [], manual: [], unverified: [], passive: [] }
  for (const finding of findings) {
    if (!blockingSet.has(finding.severity) || finding.blocking === false) {
      buckets.passive.push(finding)
      continue
    }
    if (finding.verified === 'unverified' || finding.evidenceStatus === 'mismatch') {
      buckets.unverified.push(finding)
      continue
    }
    const manual = respectFixPolicy && (finding.fixMode === 'manual' || finding.fixMode === 'forbidden')
    if (manual) buckets.manual.push(finding)
    else buckets.auto.push(finding)
  }
  return buckets
}

function findingLines(finding, label = '') {
  const dimension = DIMENSION_LABEL[finding.dimension] ?? finding.dimension
  const badge = label === '' ? '' : `[${label}] `
  // 跨轮重复：repeats=1 是首次报告，不打扰；≥2 才标注，提醒「报过但尚未确认修复」。
  const repeat = Number(finding.repeats) >= 2
    ? `（第 ${finding.repeats} 次报告，尚未修复）`
    : ''
  return [
    `${badge}[${finding.ruleId}] ${dimension}/${finding.severity}  ${finding.location}${repeat}`,
    `  问题: ${finding.problem}`,
    `  建议: ${finding.suggestion}`,
  ].join('\n')
}

function coverageLine(coverage) {
  if (coverage === undefined || coverage === null) return undefined
  if (coverage.missing === true) return '覆盖: 未申报（审查者未提供 coverage）'
  if (coverage.valid === false) return '覆盖: 申报无效（按未申报处理）'
  const total = coverage.reviewed + coverage.skipped
  const parts = [`已审 ${coverage.reviewed}/${total}`]
  if (coverage.skipped > 0) parts.push(`跳过 ${coverage.skipped}`)
  if (coverage.unaccounted > 0) parts.push(`未申报 ${coverage.unaccounted}`)
  return `覆盖: ${parts.join('，')}`
}

function suppressedLine(suppressed) {
  if (!Array.isArray(suppressed) || suppressed.length === 0) return undefined
  const items = suppressed.map((entry) => {
    const finding = entry.finding ?? entry
    return `[${finding.ruleId}] ${finding.location}（${entry.reason ?? '已抑制'}）`
  })
  return `已抑制（人工裁决，不再报告）: ${items.join('、')}`
}

/**
 * 渲染审查结果。
 *
 * - `report`：`/review` 报告，列出阻塞项、人工确认项、未复验项、非阻塞建议与覆盖；
 * - `steer`：自动回灌的阻塞项（含人工确认段，但不含修复指令）；没有可回灌内容时返回空串；
 * - `notify`：只列 `notifySeverities` 命中的非阻塞建议；
 * - `manual`：只列需人工确认/未复验的问题，用于「不触发修复轮」的通知。
 *
 * @param {{findings: readonly object[], skipped: readonly {path:string,reason:string}[], blockingSeverities: readonly string[], notifySeverities?: readonly string[], summary: {files:number,added:number,deleted:number}, mode?: 'report'|'steer'|'notify'|'manual', coverage?: object, suppressed?: readonly object[], respectFixPolicy?: boolean}} input
 * @returns {string} 无可回注内容时返回空串
 */
export function renderFindings({
  findings, skipped, blockingSeverities, notifySeverities = [], summary,
  mode = 'report', coverage, suppressed = [], respectFixPolicy = true,
}) {
  if (findings.length === 0 && suppressed.length === 0) return ''
  const buckets = classifyFindings(findings, blockingSeverities, respectFixPolicy)
  const auto = bySeverity(buckets.auto)
  const manual = bySeverity(buckets.manual)
  const unverified = bySeverity(buckets.unverified)
  const passive = bySeverity(buckets.passive)
  const notifySet = new Set(notifySeverities)
  const notified = passive.filter((finding) => notifySet.has(finding.severity))
  const adviseList = mode === 'report' || mode === 'manual' ? passive : notified
  if (mode === 'steer' && auto.length === 0 && manual.length === 0 && unverified.length === 0) return ''
  if (mode === 'notify' && notified.length === 0) return ''
  if (mode === 'manual' && manual.length === 0 && unverified.length === 0) {
    return ''
  }

  const scope = `本次 ${summary.files} 文件 / ${summary.added + summary.deleted} 行变更`
  const manualPart = manual.length > 0 ? `，${manual.length} 处人工确认` : ''
  const unverifiedPart = unverified.length > 0 ? `，${unverified.length} 处未复验` : ''
  const advisePart = adviseList.length > 0 ? `，${adviseList.length} 处建议` : ''
  let head
  if (auto.length > 0) {
    head = `结论: 需修改（${auto.length} 处阻塞${manualPart}${advisePart}）`
  } else if (manual.length > 0) {
    head = `结论: 需人工确认（${manual.length} 处人工确认${unverifiedPart}）`
  } else if (unverified.length > 0) {
    head = `结论: 仅报告（${unverified.length} 处未复验/证据不足，需人工确认）`
  } else {
    head = `结论: 通过（${mode === 'report' ? passive.length : notified.length} 处建议）`
  }
  const sections = []
  if (auto.length > 0) sections.push(auto.map((finding) => findingLines(finding)).join('\n'))
  if (manual.length > 0) {
    const lines = manual.map((finding) => findingLines(finding, '人工')).join('\n')
    sections.push(`需人工确认（不要自动修改）:\n${lines}`)
  }
  if (unverified.length > 0) {
    const lines = unverified.map((finding) => findingLines(finding, '未复验')).join('\n')
    sections.push(`仅报告（未复验/证据不足，不要据此修复）:\n${lines}`)
  }
  if (adviseList.length > 0) sections.push(`非阻塞建议:\n${adviseList.map((finding) => findingLines(finding)).join('\n')}`)
  if (skipped.length > 0) sections.push(`未审: ${skipped.map((item) => `${item.path}（${item.reason}）`).join('、')}`)
  if (mode === 'report' || mode === 'manual') {
    const coverageText = coverageLine(coverage)
    if (coverageText !== undefined) sections.push(coverageText)
    const suppressedText = suppressedLine(suppressed)
    if (suppressedText !== undefined) sections.push(suppressedText)
    sections.push(BOUNDARY_LINE)
  } else if (coverage !== undefined && coverage !== null && coverage.unaccounted > 0) {
    sections.push(coverageLine(coverage))
  }
  return [`${head} · ${scope}`, ...sections].join('\n')
}

/**
 * 复审通过时的一行结果。
 * @param {{summary: {files:number,added:number,deleted:number}, skipped?: readonly {path:string,reason:string}[], coverage?: object}} input
 * @returns {string}
 */
export function renderPass({ summary, skipped = [], coverage }) {
  const head = `结论: 通过（本次 ${summary.files} 文件 / ${summary.added + summary.deleted} 行变更）`
  const lines = [head]
  if (skipped.length > 0) lines.push(`未审: ${skipped.map((item) => `${item.path}（${item.reason}）`).join('、')}`)
  const coverageText = coverageLine(coverage)
  if (coverageText !== undefined) lines.push(coverageText)
  lines.push(BOUNDARY_LINE)
  return lines.join('\n')
}

/**
 * 账本脚注：只列「连续 N 轮未再出现」的历史 finding，供人工确认后移出跟踪。
 * 不自动关闭、不写回修复状态。
 * @param {readonly object[]} findings notObservedFindings 的返回值
 * @returns {string} 无内容时返回空串
 */
export function renderLedger(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return ''
  const ordered = [...findings].sort(
    (left, right) => (SEVERITY_RANK[left.severity] ?? Number.MAX_SAFE_INTEGER)
      - (SEVERITY_RANK[right.severity] ?? Number.MAX_SAFE_INTEGER),
  )
  const lines = ordered.map((finding) => (
    `- [${finding.ruleId}] ${finding.location}`
    + `（连续 ${finding.missedRuns} 轮未再出现，可人工确认后移出跟踪；不自动关闭）`
  ))
  return ['账本（人工裁决，不自动关闭）:', ...lines].join('\n')
}
