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

function bySeverity(findings) {
  return [...findings].sort(
    (left, right) => (SEVERITY_RANK[left.severity] ?? Number.MAX_SAFE_INTEGER)
      - (SEVERITY_RANK[right.severity] ?? Number.MAX_SAFE_INTEGER),
  )
}

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
 *
 * - `report`：`/review` 报告，列出阻塞项与全部非阻塞建议；
 * - `steer`：自动回灌的阻塞项；若配置了 `notifySeverities`，阻塞项之外命中的建议
 *   也会附在「非阻塞建议」段里；没有阻塞项时返回空串（由调用方决定是否走 notify）；
 * - `notify`：只列 `notifySeverities` 命中的非阻塞建议，结论为「通过（N 处建议）」，
 *   用于「建议回灌但不要求修复」；没有命中时返回空串。
 *
 * @param {{findings: readonly object[], skipped: readonly {path:string,reason:string}[], blockingSeverities: readonly string[], notifySeverities?: readonly string[], summary: {files:number,added:number,deleted:number}, mode?: 'report'|'steer'|'notify'}} input
 * @returns {string} 无可回注内容时返回空串
 */
export function renderFindings({
  findings, skipped, blockingSeverities, notifySeverities = [], summary, mode = 'report',
}) {
  if (findings.length === 0) return ''
  const partitioned = partition(findings, blockingSeverities)
  // notify 是「只看向非阻塞建议」的视图，阻塞项不参与。
  const blocking = mode === 'notify' ? [] : bySeverity(partitioned.blocking)
  const passive = bySeverity(partitioned.passive)
  const notifySet = new Set(notifySeverities)
  const notified = passive.filter((finding) => notifySet.has(finding.severity))
  const adviseList = mode === 'report' ? passive : notified
  if (mode === 'steer' && blocking.length === 0) return ''
  if (mode === 'notify' && notified.length === 0) return ''
  const scope = `本次 ${summary.files} 文件 / ${summary.added + summary.deleted} 行变更`
  const head = blocking.length > 0
    ? `结论: 需修改（${blocking.length} 处阻塞${adviseList.length > 0 ? `，${adviseList.length} 处建议` : ''}）`
    : `结论: 通过（${mode === 'report' ? passive.length : notified.length} 处建议）`
  const sections = []
  if (blocking.length > 0) sections.push(blocking.map(findingLines).join('\n'))
  if (adviseList.length > 0) sections.push(`非阻塞建议:\n${adviseList.map(findingLines).join('\n')}`)
  if (skipped.length > 0) sections.push(`未审: ${skipped.map((item) => `${item.path}（${item.reason}）`).join('、')}`)
  return [`${head} · ${scope}`, ...sections].join('\n')
}

/**
 * 复审通过时的一行结果。
 * @param {{summary: {files:number,added:number,deleted:number}, skipped?: readonly {path:string,reason:string}[]}} input
 * @returns {string}
 */
export function renderPass({ summary, skipped = [] }) {
  const head = `结论: 通过（本次 ${summary.files} 文件 / ${summary.added + summary.deleted} 行变更）`
  if (skipped.length === 0) return head
  return `${head}\n未审: ${skipped.map((item) => `${item.path}（${item.reason}）`).join('、')}`
}
