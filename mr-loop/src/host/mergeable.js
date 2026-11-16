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

/**
 * 报告与判定共用同一口径，避免「报告说无阻塞、判定说不能合」。
 * 只认 waive / skip / wontfix 三种对外终结。**草稿不是处置（M4）**：mr_waive 的草稿
 * 不写 decisions、也不写 MR，所以这里永远看不到草稿；只有 MR 里真实出现的指令或
 * 回帖成功写进 decisions 的处置才算。
 */
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

/** 本轮 review 里该 FID 对应的 MR 指令；没有则 null。FID 大小写不敏感。 */
export function directiveFor(round, fid) {
  const list = Array.isArray(round?.directives?.directives) ? round.directives.directives : []
  if (list.length === 0 || typeof fid !== 'string' || fid === '') return null
  const key = fid.toLowerCase()
  return list.find((item) => String(item?.fid ?? '').toLowerCase() === key) ?? null
}

/**
 * 账本 decisions 的 FID 查找。账本由插件写入时大小写与评审一致，但人工回填 /
 * 大小写不同的旧账本不该让豁免失效：按小写再兜一次。
 * 导出给 UI / 服务写路径复用，避免各处再写一套大小写兜底（M3）。
 */
export function decisionFor(decisions, fid) {
  if (decisions === null || typeof decisions !== 'object' || typeof fid !== 'string' || fid === '') return undefined
  if (decisions[fid] !== undefined) return decisions[fid]
  const key = fid.toLowerCase()
  for (const [id, decision] of Object.entries(decisions)) {
    if (id.toLowerCase() === key) return decision
  }
  return undefined
}

/**
 * 已处置 = 账本里有 waive / skip / wontfix，或 MR 评论里有该 FID 的有效指令。
 * 两处并存时任一命中即算（决策文档 §2.1：有有效指令的 FID 视为已处置，不拦合并）。
 * M4：草稿不算处置——草稿不落 decisions、不发 MR，只有真正出现的来源才在这里生效。
 */
export function isDisposedFinding(round, decisions = {}, fid) {
  return isDisposed(decisionFor(decisions, fid)) || directiveFor(round, fid) !== null
}

/** 未被账本处置、也没有 MR 指令豁免的 finding；处置口径与报告共用。 */
export function openFindings(round, decisions = {}) {
  return reviewFindings(round?.review).filter((item) => isDisposedFinding(round, decisions, item?.fid) === false)
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

/** 单条 finding 的 FID 预览：`FID a1b2c3d4（低）`，级别缺失时省略括号。 */
function fidLabel(item) {
  const fid = scalar(item?.fid) || '?'
  const level = scalar(item?.level)
  return `FID ${fid}${level ? `（${level}）` : ''}`
}

/**
 * 未处置 finding 的统一口径：报告（合并行的缺口）与唤醒（前置指令）共用，
 * 避免「报告说有 1 处、唤醒却说没有」。`fids` 只给前 3 个预览，总数看 `total`。
 * `waived` 只列本轮 review 里真实存在、且被 MR 指令豁免的 FID（账本处置不塞进来），
 * 报告据此单独展示指令来源；`total` 仍同时扣掉账本处置与指令豁免，计数一致。
 * @returns {{ total: number, fresh: number, fids: string[], waived: Array<{fid:string,kind:string,reason:string,noteId:number|null}> }}
 */
export function reviewTodo(round, decisions = {}) {
  const findings = reviewFindings(round?.review)
  const open = findings.filter((item) => isDisposedFinding(round, decisions, item?.fid) === false)
  const seen = new Set()
  const waived = []
  for (const item of findings) {
    const found = directiveFor(round, item?.fid)
    if (found === null) continue
    const key = String(found.fid ?? '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    waived.push({ fid: found.fid, kind: found.kind, reason: found.reason, noteId: found.noteId ?? null })
  }
  return {
    total: open.length,
    // 「本轮新增」统一为全部 finding 口径（含已豁免），报告直接用它；合并缺口里的
    // 「其中 N 处本轮新增未处置」只取未处置子集，标签写清，两个数字含义不混。
    fresh: findings.filter(isNewFinding).length,
    fids: open.slice(0, FID_PREVIEW).map(fidLabel),
    waived,
  }
}

/**
 * 把「需要关注的问题」与「本轮新增」合成一条 missing：
 * `评审有 2 处需要关注的问题（其中 1 处本轮新增未处置）：FID a1b2c3d4（低）、…`。
 * 缺口里只强调**未处置**的新增（已豁免的不用再修）；报告行的「本轮新增」是全部
 * finding 口径（`reviewTodo.fresh`），两处标签写清，数字含义不混。
 */
function findingGap({ total, fresh, fids }) {
  const freshSuffix = fresh > 0 ? `（其中 ${fresh} 处本轮新增未处置）` : ''
  const more = total > fids.length ? `等 ${total} 处` : ''
  return `评审有 ${total} 处需要关注的问题${freshSuffix}：${fids.join('、')}${more}`
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
    // 用户口径：结论 + 需要关注的问题 + 历史未收敛 + 本轮新增，四个维度都为 0/通过才提示合并。
    const todo = reviewTodo(round, decisions)
    const history = historyGap(review)
    if (round?.binding !== 'strong') {
      missing.push('AI 评审为弱绑定（无 SHA 证明），需人工确认')
    } else if (verdict !== 'pass') {
      // I3：verdict=changes 但所有 finding 都已被指令/账本处置、且历史未收敛为 0 时，
      // 不再把 verdict 本身当成缺口——决策文档「有效指令的 FID 视为已处置，不拦合并」。
      const excused = verdict === 'changes' && todo.total === 0 && history === null
      if (!excused) missing.push(verdict === 'changes' ? 'AI 评审结论为需要修改' : 'AI 评审结论未知（未出或解析失败）')
    }
    if (todo.total > 0) {
      // 缺口里的「本轮新增」只算未处置（已豁免的不必再修）；todo.fresh 是全部 finding 口径。
      const openFresh = openFindings(round, decisions).filter(isNewFinding).length
      missing.push(findingGap({ ...todo, fresh: openFresh }))
    }
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
