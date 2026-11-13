/**
 * 可合并判定（设计 §5.6）。全部满足才算；缺哪项用中文写进 missing，报告直接展示。
 * 反模式：只盯 AI 评审。三套门禁 + GitLab 自己的详细合并态一起看，unknown 不当 pass。
 * 必过项是建议性的：只在有本轮结论时计入（它通常只在 MR 早期出现一次）。
 * 阻塞项处置只认终态：fix / pending / 未知 kind 都不算，避免账本中间态把判定放过去。
 */
const DISPOSED_KINDS = new Set(['waive', 'skip', 'wontfix'])

export function evaluateMergeable({ mr, round, decisions = {} }) {
  const missing = []
  let degraded = false

  if (mr?.state !== 'opened') missing.push(`MR 状态是 ${mr?.state ?? 'unknown'}`)
  if (mr?.draft === true) missing.push('MR 还是草稿')
  if (mr?.has_conflicts === true) missing.push('与目标分支有冲突')
  // 14.9 没有 detailed_merge_status，但给了这个字段；false 就是明确不可合。
  if (mr?.blocking_discussions_resolved === false) missing.push('仍有未解决的阻塞讨论')

  const verdict = round?.review?.verdict ?? 'unknown'
  if (verdict !== 'pass') missing.push(verdict === 'changes' ? 'AI 评审结论为需要修改' : 'AI 评审结论未知（未出或解析失败）')

  const blocking = Array.isArray(round?.review?.blocking) ? round.review.blocking : []
  const unresolved = blocking.filter((item) => {
    const kind = decisions?.[item?.fid]?.kind
    return typeof kind !== 'string' || DISPOSED_KINDS.has(kind) === false
  })
  if (unresolved.length > 0) missing.push(`有 ${unresolved.length} 条阻塞问题未处置`)

  const sensitive = round?.sensitive?.verdict ?? 'unknown'
  if (sensitive !== 'pass') missing.push(sensitive === 'block' ? '敏感内容门禁未通过' : '敏感内容门禁本轮无结论')

  if (round?.mandatory?.verdict === 'block') missing.push('必过项完整性检查未通过')

  if (typeof mr?.detailed_merge_status === 'string') {
    if (mr.detailed_merge_status !== 'mergeable') missing.push(`GitLab 合并态：${mr.detailed_merge_status}`)
  } else {
    degraded = true
    if (mr?.merge_status !== 'can_be_merged') missing.push(`GitLab 合并态：${mr?.merge_status ?? 'unknown'}`)
  }

  return { mergeable: missing.length === 0, missing, degraded }
}
