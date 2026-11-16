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

/**
 * 本轮评审的全部 finding。`parse-review` 按「门禁分类=非阻塞建议 / 级别=低」分出
 * nonBlocking 只是展示口径：可合判定不再据此放行——任何一条未处置的问题都拦。
 */
export function reviewFindings(review) {
  return [
    ...(Array.isArray(review?.blocking) ? review.blocking : []),
    ...(Array.isArray(review?.nonBlocking) ? review.nonBlocking : []),
  ]
}

/** 未被 waive / skip / wontfix 终结的 finding；处置白名单与报告共用。 */
export function openFindings(review, decisions = {}) {
  return reviewFindings(review).filter((item) => isDisposed(decisions?.[item?.fid]) === false)
}

/**
 * 本轮首次被评审看到的 finding：复验次数缺失或 <= 1。
 * 字段缺失按「无法证明不是新问题」处理（fail-closed），不能因为解析不到就当旧问题。
 */
export function isNewFinding(item) {
  const count = Number(item?.reverifyCount)
  return !(Number.isFinite(count) && count > 1)
}

/** note 派生标量进 missing 前先压成单行并截断，避免改写报告行结构。 */
const SCALAR_LIMIT = 60
function scalar(value) {
  if (value === null || value === undefined) return ''
  const collapsed = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
  return collapsed.length > SCALAR_LIMIT ? `${collapsed.slice(0, SCALAR_LIMIT)}…` : collapsed
}

const FID_PREVIEW = 3

/**
 * 把「需要关注的问题」与「本轮新增」合成一条 missing：
 * `评审有 2 处需要关注的问题（其中 1 处本轮新增）：FID a1b2c3d4（低）、…`。
 * 两者有重叠，但不拆成两条——用户要的是一个结论，不是重复计数。
 */
function findingGap(open, fresh) {
  const freshSuffix = fresh > 0 ? `（其中 ${fresh} 处本轮新增）` : ''
  const preview = open.slice(0, FID_PREVIEW).map((item) => {
    const fid = scalar(item?.fid) || '?'
    const level = scalar(item?.level)
    return `FID ${fid}${level ? `（${level}）` : ''}`
  })
  const more = open.length > FID_PREVIEW ? `等 ${open.length} 处` : ''
  return `评审有 ${open.length} 处需要关注的问题${freshSuffix}：${preview.join('、')}${more}`
}

/**
 * 历史未收敛必须是 0 才能放行。字段缺失（null / undefined）表示 note 没写这个
 * 字段，无法证明是 0 —— fail-closed 单独写成「未声明」，报告一眼能看出原因。
 */
function historyGap(review) {
  const value = review?.historicalUnresolved
  if (value === null || value === undefined) return '历史未收敛问题未声明'
  if (value === 0) return null
  return `历史未收敛问题 ${scalar(value)} 条`
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
  } else {
    if (round?.binding !== 'strong') {
      missing.push('AI 评审为弱绑定（无 SHA 证明），需人工确认')
    } else if (verdict !== 'pass') {
      missing.push(verdict === 'changes' ? 'AI 评审结论为需要修改' : 'AI 评审结论未知（未出或解析失败）')
    }
    // 用户口径：结论 + 需要关注的问题 + 历史未收敛 + 本轮新增，四个维度都为 0/通过才提示合并。
    const open = openFindings(review, decisions)
    if (open.length > 0) missing.push(findingGap(open, open.filter(isNewFinding).length))
    const history = historyGap(review)
    if (history !== null) missing.push(history)
  }

  // 用户口径：敏感门禁只有「阻止合并」才拦；pass / unknown / 无本轮结论都不拦，
  // 但报告行会如实标注后两者的状态（14.9 上该 bot 并非每次重发）。
  const sensitive = round?.sensitive?.verdict ?? null
  if (sensitive === 'block') missing.push('敏感内容门禁阻止合并')

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
