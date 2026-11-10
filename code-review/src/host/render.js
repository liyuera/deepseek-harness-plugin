/**
 * 把结构化 findings 渲染成回注给主代理的紧凑文本。
 * @module @liyuera/dsh-code-review/host/render
 */
const DIMENSION_LABEL = Object.freeze({
  correctness: '正确性',
  security: '安全',
  performance: '性能',
  maintainability: '可维护性',
})

/**
 * 按阻塞阈值切分 findings。
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

function findingLines(finding) {
  const label = DIMENSION_LABEL[finding.dimension] ?? finding.dimension
  return [
    `[${finding.ruleId}] ${label}/${finding.severity}  ${finding.location}`,
    `  问题: ${finding.problem}`,
    `  建议: ${finding.suggestion}`,
  ].join('\n')
}

/**
 * 渲染审查结果。
 * @param {{findings: readonly object[], skipped: readonly {path:string,reason:string}[], blockingSeverities: readonly string[], summary: {files:number,added:number,deleted:number}, mode?: 'report'|'steer'}} input
 * @returns {string} 无可回注内容时返回空串
 */
export function renderFindings({ findings, skipped, blockingSeverities, summary, mode = 'report' }) {
  if (findings.length === 0) return ''
  const { blocking, passive } = partition(findings, blockingSeverities)
  if (mode === 'steer' && blocking.length === 0) return ''
  const scope = `本次 ${summary.files} 文件 / ${summary.added + summary.deleted} 行变更`
  const advise = mode === 'report' && passive.length > 0
  const head = blocking.length > 0
    ? `结论: 需修改（${blocking.length} 处阻塞${advise ? `，${passive.length} 处建议` : ''}）`
    : `结论: 需修改（0 处阻塞，${passive.length} 处建议）`
  const sections = []
  if (blocking.length > 0) sections.push(blocking.map(findingLines).join('\n'))
  if (advise) sections.push(`非阻塞建议:\n${passive.map(findingLines).join('\n')}`)
  if (skipped.length > 0) sections.push(`未审: ${skipped.map((item) => `${item.path}（${item.reason}）`).join('、')}`)
  return [`${head} · ${scope}`, ...sections].join('\n')
}

/**
 * 复审通过时的一行结果。
 * @param {{summary: {files:number,added:number,deleted:number}}} input
 * @returns {string}
 */
export function renderPass({ summary }) {
  return `结论: 通过（本次 ${summary.files} 文件 / ${summary.added + summary.deleted} 行变更）`
}
