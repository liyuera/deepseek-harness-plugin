/**
 * 可合并判定（设计 §5.6）。全部满足才算；缺哪项用中文写进 missing，报告直接展示。
 * 反模式：只盯 AI 评审。三套门禁 + GitLab 自己的详细合并态一起看，unknown 不当 pass。
 * 必过项是建议性的：只在有本轮结论时计入（它通常只在 MR 早期出现一次）。
 */
/** 只有这三种处置算「对外终结」；fix/pending/空壳对象都不算（fail-closed）。 */
export const DISPOSED_KINDS = new Set(['waive', 'skip', 'wontfix'])

/**
 * 流水线终态里只有 failed / canceled 算「未通过」；running / pending / created
 * 等只是「未完成」。两种说法都拦合并，但报告不能把还没跑完的流水线写成失败。
 */
const PIPELINE_FAILED_STATUSES = new Set(['failed', 'canceled'])
const pipelineGap = (status) => `${PIPELINE_FAILED_STATUSES.has(status) ? '流水线未通过' : '流水线未完成'}（${status}）`

/** 报告与判定共用同一口径，避免「报告说无阻塞、判定说不能合」。 */
export function isDisposed(decision) {
  return typeof decision?.kind === 'string' && DISPOSED_KINDS.has(decision.kind)
}

export function evaluateMergeable({ mr, round, decisions = {} }) {
  const missing = []
  let degraded = false

  if (mr?.state !== 'opened') missing.push(`MR 状态是 ${mr?.state ?? 'unknown'}`)
  if (mr?.draft === true) missing.push('MR 还是草稿')
  if (mr?.has_conflicts === true) missing.push('与目标分支有冲突')
  // 14.9 没有 detailed_merge_status，但给了这个字段；false 就是明确不可合。
  if (mr?.blocking_discussions_resolved === false) missing.push('仍有未解决的阻塞讨论')

  // 设计 §5.2：弱绑定（无 SHA 证明）只能当 unknown 参与判定，正文写 pass 也不能进可合。
  // 强绑定是接受评审结论的前提；评审缺失时仍按「未知」拦。
  const review = round?.review ?? null
  const verdict = review?.verdict ?? 'unknown'
  if (review === null) {
    missing.push('AI 评审结论未知（未出或解析失败）')
  } else if (round?.binding !== 'strong') {
    missing.push('AI 评审为弱绑定（无 SHA 证明），需人工确认')
  } else if (verdict !== 'pass') {
    missing.push(verdict === 'changes' ? 'AI 评审结论为需要修改' : 'AI 评审结论未知（未出或解析失败）')
  }

  const blocking = Array.isArray(round?.review?.blocking) ? round.review.blocking : []
  // 只有这三种处置才算「对外终结」；fix/pending/空壳对象都不能顶掉阻塞项（fail-closed）。
  const unresolved = blocking.filter((item) => isDisposed(decisions?.[item?.fid]) === false)
  if (unresolved.length > 0) missing.push(`有 ${unresolved.length} 条阻塞问题未处置`)

  const sensitive = round?.sensitive?.verdict ?? 'unknown'
  if (sensitive !== 'pass') missing.push(sensitive === 'block' ? '敏感内容门禁未通过' : '敏感内容门禁本轮无结论')

  if (round?.mandatory?.verdict === 'block') missing.push('必过项完整性检查未通过')

  // 14.9 的 merge_status 只看冲突，不反映流水线：有 head_pipeline 时必须单独要求 success。
  // 字段缺失 / null 是文档里的「没有挂 CI」路径，不拦。
  const pipeline = mr?.head_pipeline
  if (pipeline !== null && pipeline !== undefined && pipeline.status !== 'success') {
    missing.push(pipelineGap(pipeline.status ?? 'unknown'))
  }

  if (typeof mr?.detailed_merge_status === 'string') {
    if (mr.detailed_merge_status !== 'mergeable') missing.push(`GitLab 合并态：${mr.detailed_merge_status}`)
  } else {
    degraded = true
    if (mr?.merge_status !== 'can_be_merged') missing.push(`GitLab 合并态：${mr?.merge_status ?? 'unknown'}`)
  }

  return { mergeable: missing.length === 0, missing, degraded }
}
