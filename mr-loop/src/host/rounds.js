/**
 * 轮次归属：一条评审属于哪个 sha、哪一轮，只认证据（见设计 §5.2）。
 *   强绑定：note 里 <!-- AI_REVIEW_SHA ... --> 与当前 sha 相等（允许短 sha 前缀）
 *   弱绑定：无标记，但 created_at >= baselineAt（该 sha 的 head_pipeline.created_at，
 *          取不到时用本轮首次观测时间），且标题前缀匹配
 *   其余：stale，进 dropped[]，不参与任何判定
 * 纯函数：不碰网络、不碰时钟（baselineAt / observedAt 由调用方注入）。
 */
import { parseReview, isReviewBody } from './parse-review.js'
import { parseSensitiveGate, parseMandatoryGate } from './parse-gates.js'
import { parseDirectives, authorOf, clipText, hasDirectiveLine, visibleBody } from './parse-directives.js'

const SHA_MARKER_RE = /<!--\s*AI_REVIEW_SHA\s+([0-9a-f]{7,64})\s*-->/i

/** 该 sha 的流水线创建时间，作为 push 时间的近似；缺失返回 0。 */
export function baselineOf(mr) {
  const createdAt = mr?.head_pipeline?.created_at
  const parsed = typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

/** 从 note 正文提取 AI_REVIEW_SHA 标记值。 */
export function reviewShaOf(body) {
  const match = SHA_MARKER_RE.exec(String(body ?? ''))
  return match ? match[1].toLowerCase() : null
}

/**
 * 这笔提交到底有没有流水线：GitLab 的 head_pipeline 是「这个 MR 最新的流水线」，
 * 新 push 之后它可能还停在上一个 commit 上（sha 不一致）——此时评审不会被自动产出。
 * 返回 false 表示**已知**没有本提交的流水线；实例没给 sha / 当前 sha 缺失时无法证明，
 * 按 true（未知）处理，绝不误报。
 */
export function pipelineForHead(mr) {
  if (mr?.head_pipeline === null || mr?.head_pipeline === undefined) return false
  const headSha = typeof mr.sha === 'string' ? mr.sha : ''
  const pipelineSha = typeof mr.head_pipeline.sha === 'string' ? mr.head_pipeline.sha : null
  if (pipelineSha === null || headSha === '') return true
  return pipelineSha === headSha
}

/**
 * 伪轮次：没有任何评审结论、且没有本提交流水线的轮次。
 *
 * 用户口径（0.3.0）：**轮次 = 一次评审**。push 了一笔提交但流水线没跑起来时，
 * 评审不会自己来，这一笔不能把轮次 +1。真实状态仍留在 `state.round` 内部（watcher
 * 要按它等评审 / 提醒没流水线），只是不进面板轮次条、不占用轮次号。
 *
 * 证据字段 `pipelineForHead` 由服务层每次快照写入；老账本没有该字段时：
 * 非末轮且无评审 → 判定为伪轮次（它从未产出过结论，重编号后不丢信息）；
 * 末轮保留（可能是旧版本正在等待评审的当前轮，不能静默吞掉）。
 * @param {object} round
 * @param {{ last?: boolean }} [options]
 */
export function isPhantomRound(round, options = {}) {
  if (round === null || typeof round !== 'object') return true
  if (round.review !== null && round.review !== undefined) return false
  if (round.pipelineForHead === true) return false
  if (round.pipelineForHead === false) return true
  // 老账本没有证据字段：末轮保留（可能正是旧版本在等评审的当前轮，不能静默吞掉）；
  // 非末轮且 `binding` 明确为 null（buildRound 的「没有评审」）才判定伪轮次。
  // 只带 n / sha 的精简账本（测试或人工回填）不误删。
  if (options.last === true) return false
  return round.binding === null
}

/**
 * 面板 / 账本恢复用的轮次规范化：去掉伪轮次并重编号，保证「轮次号连续、不因没流水线的
 * 提交跳号」。没有伪轮次时原样返回（保留账本裁剪后的起始编号，不把历史轮改成第 1 轮）。
 * @param {object[]} rounds
 * @returns {object[]}
 */
export function normalizeRounds(rounds) {
  const list = Array.isArray(rounds) ? rounds : []
  const kept = []
  for (let index = 0; index < list.length; index += 1) {
    if (isPhantomRound(list[index], { last: index === list.length - 1 })) continue
    kept.push(list[index])
  }
  if (kept.length === list.length) return list
  // 以第一个保留轮次的编号为基准往后排：账本裁剪（只留最近 N 轮）时不会把起始轮改成第 1 轮。
  const base = Number.isSafeInteger(kept[0]?.n) && kept[0].n > 0 ? kept[0].n - 1 : 0
  return kept.map((round, index) => ({ ...round, n: base + index + 1 }))
}

const SHA_RE = /^[0-9a-f]{7,64}$/

/**
 * 当前 sha 与标记必须都是非空十六进制串，再允许短前缀互相匹配。
 * 少了这道校验，缺失的 sha 会因 `marker.startsWith('')` 恒真而 fail-open 成强绑定——
 * 那正好是反陈旧核心最不该出错的地方。
 */
const shaMatches = (marker, sha) => {
  const value = String(marker ?? '').trim().toLowerCase()
  const target = String(sha ?? '').trim().toLowerCase()
  if (!SHA_RE.test(value) || !SHA_RE.test(target)) return false
  return value === target || target.startsWith(value) || value.startsWith(target)
}

/**
 * @returns {{ binding: 'strong'|'weak' } | { stale: true, reason: 'other-sha'|'no-baseline'|'before-baseline'|'title-mismatch' }}
 */
export function classifyReviewNote({ note, sha, baselineAt, cfg }) {
  const marker = reviewShaOf(note?.body)
  if (marker) return shaMatches(marker, sha) ? { binding: 'strong' } : { stale: true, reason: 'other-sha' }
  // 没有基线就无法证明「晚于本轮」：宁可判 stale，也不 fail-open 成弱绑定。
  if (!Number.isFinite(baselineAt)) return { stale: true, reason: 'no-baseline' }
  const createdAt = Date.parse(note?.created_at ?? '')
  if (!Number.isFinite(createdAt)) return { stale: true, reason: 'before-baseline' }
  if (createdAt < baselineAt) return { stale: true, reason: 'before-baseline' }
  // 标题必须起始首行：正文里顺口提到 `AI Code Review (` 的人话不算评审。
  if (!startsWithTitle(note?.body, cfg.reviewTitlePrefix)) return { stale: true, reason: 'title-mismatch' }
  return { binding: 'weak' }
}

/**
 * 门禁 note 必须由标题**起始**（首行），不能只看 body 里包不包含标题：
 * 人在回复里整段引用一条门禁 note（以 `>` 开头）时，包含关系会成立，
 * 于是引用文本会被误当成新的门禁结论。
 */
function startsWithTitle(body, title) {
  const firstLine = String(body ?? '').split('\n').find((line) => line.trim() !== '') ?? ''
  // CommonMark 中 4 空格缩进即代码块：只容 0–3 格行首缩进（tab 不算），`#` 标题前缀可选。
  // 除「缩进 + # 前缀」外不再 strip 任何字符：`>` 引用因此仍会被排除。
  const prefix = /^ {0,3}(?:#+[ \t]*)?/.exec(firstLine)?.[0] ?? ''
  return firstLine.slice(prefix.length).startsWith(title)
}
const isSensitiveNote = (body, cfg) => startsWithTitle(body, cfg.sensitiveTitle)
const isMandatoryNote = (body, cfg) => startsWithTitle(body, cfg.mandatoryTitle)

/** 同 sha 多条命中取 note.id 最大的一条。 */
const latestBy = (items) => items.reduce((best, item) => (best === null || item.note.id > best.note.id ? item : best), null)

const COMMENT_LIMIT = 5
const EXCERPT_LIMIT = 120

/**
 * 指令扫描的输入（I2）：只有「非系统 + 不是评审 note + 不是敏感/必过门禁 note」的
 * 评论才可能携带有效指令。评审 / 门禁正文里写 `#ai-*` 不能豁免任何东西——否则机器人
 * 或引用文本可以自己放行自己。
 */
function directiveCandidates({ notes, reviewOptions, cfg }) {
  const candidates = []
  for (const note of notes ?? []) {
    if (!note || typeof note !== 'object' || note.system === true) continue
    const body = String(note.body ?? '')
    if (isReviewBody(body, reviewOptions)) continue
    if (isSensitiveNote(body, cfg) || isMandatoryNote(body, cfg)) continue
    candidates.push(note)
  }
  return candidates
}

/**
 * 其它评论（非系统 / 非评审 / 非门禁 / 非指令）：最近 5 条，新的在前。
 * 指令评论（含 reason 写错的无效指令）不进这里——它们已在 directives 里单独呈现，
 * 混进「普通评论」只会让主代理重复读同一段文本；原文由 directiveNotes 有界保存。
 */
function otherComments({ notes, reviewOptions, cfg }) {
  const comments = []
  for (const note of notes ?? []) {
    if (!note || note.system === true) continue
    const body = String(note.body ?? '')
    if (isReviewBody(body, reviewOptions)) continue
    if (isSensitiveNote(body, cfg) || isMandatoryNote(body, cfg)) continue
    if (hasDirectiveLine(body)) continue
    comments.push({
      noteId: note.id ?? null,
      author: authorOf(note),
      createdAt: typeof note.created_at === 'string' ? note.created_at : null,
      // excerpt 只取可见正文：HTML 注释 / 隐藏统计块里的内容不该展示成普通评论（M1）。
      excerpt: clipText(visibleBody(body), EXCERPT_LIMIT),
    })
  }
  // 评论里没有可靠的时间字符串可用时按 note.id 排序：GitLab 的 id 单调递增，等价于「新的在前」。
  const idOf = (item) => (typeof item.noteId === 'number' ? item.noteId : -Infinity)
  comments.sort((left, right) => idOf(right) - idOf(left))
  return comments.slice(0, COMMENT_LIMIT)
}

/**
 * 把一次 notes 快照归并成一整轮。
 * @param {{ mr: object, notes: object[], cfg: object, observedAt: number }} input
 */
export function buildRound({ mr, notes, cfg, observedAt }) {
  const sha = mr?.sha
  const observed = Number.isFinite(observedAt) && observedAt > 0 ? observedAt : null
  // 基线 = 该 sha 的流水线创建时间；拿不到就用本轮首次观测时间；两者都没有就是 null（禁止弱绑定）。
  const baselineAt = baselineOf(mr) || observed
  const dropped = []
  const reviewHits = []
  const sensitiveHits = []
  const mandatoryHits = []
  // 评审标记来自配置 reviewMarker：与 reviewTitlePrefix / sensitiveTitle 一样是
  // 「评审机器人格式变了」时的可配置出口（设计 §12）。
  const reviewOptions = { marker: cfg?.reviewMarker }
  const parsedDirectives = parseDirectives(directiveCandidates({ notes, reviewOptions, cfg }))
  // 评论原文（directiveNotes）单独放 round 顶层：directive 条目本身不再复制 body，
  // 账本 / mr_review 里每条指令只留结构化字段（C1 有界）。
  const { directiveNotes, ...directives } = parsedDirectives

  for (const note of notes ?? []) {
    if (!note || note.system === true) continue
    const body = String(note.body ?? '')

    if (isReviewBody(body, reviewOptions)) {
      const verdict = classifyReviewNote({ note, sha, baselineAt, cfg })
      if (verdict.stale) {
        dropped.push({ noteId: note.id, reason: 'stale', detail: verdict.reason })
        continue
      }
      reviewHits.push({ note, binding: verdict.binding, parsed: parseReview(body, reviewOptions) })
      continue
    }

    const createdAt = Date.parse(note.created_at ?? '')
    // 基线为 null 时不能把任意旧门禁判成本轮结论（`createdAt >= null` 会被强转成 >= 0）。
    const fresh = Number.isFinite(baselineAt) && Number.isFinite(createdAt) && createdAt >= baselineAt

    if (isSensitiveNote(body, cfg)) {
      if (!fresh) {
        dropped.push({ noteId: note.id, reason: 'stale', detail: 'before-baseline' })
        continue
      }
      sensitiveHits.push({ note, parsed: parseSensitiveGate(body) })
      continue
    }
    if (isMandatoryNote(body, cfg)) {
      if (!fresh) {
        dropped.push({ noteId: note.id, reason: 'stale', detail: 'before-baseline' })
        continue
      }
      mandatoryHits.push({ note, parsed: parseMandatoryGate(body) })
    }
  }

  const review = latestBy(reviewHits)
  const sensitive = latestBy(sensitiveHits)
  const mandatory = latestBy(mandatoryHits)

  return {
    sha,
    n: null,
    observedAt,
    baselineAt,
    binding: review?.binding ?? null,
    review: review === null ? null : {
      noteId: review.note.id,
      binding: review.binding,
      verdict: review.parsed.verdict,
      blocking: review.parsed.blocking,
      nonBlocking: review.parsed.nonBlocking,
      historicalUnresolved: countOf(review.note.body, /历史未收敛\s*[:：]\s*`?(\d+)/),
      verifiedFixed: countOf(review.note.body, /本轮已验证修复\s*[:：]\s*`?(\d+)/),
      jobDuration: durationOf(review.note.body),
    },
    sensitive: sensitive === null ? null : { noteId: sensitive.note.id, ...sensitive.parsed },
    mandatory: mandatory === null ? null : { noteId: mandatory.note.id, ...mandatory.parsed },
    directives,
    directiveNotes,
    comments: otherComments({ notes, reviewOptions, cfg }),
    dropped,
  }
}

function countOf(body, pattern) {
  const match = pattern.exec(String(body ?? ''))
  return match ? Number.parseInt(match[1], 10) : null
}

function durationOf(body) {
  const match = /Job耗时\s*:\s*`?([^`\n|]+)`?/.exec(String(body ?? ''))
  return match ? match[1].trim() : null
}

/**
 * 已合并 / 已关闭 MR 的**历史补录**：只按评审 note 里的 `AI_REVIEW_SHA` 重建轮次。
 *
 * 一个 sha 一轮；同 sha 多条评审取 note.id 最大的一条（重跑一次评审取最新结论）。
 * 没有 sha 标记的评审 note 无法证明归属——丢弃并记进 `dropped`，补录宁可少一轮也不张冠李戴。
 * 门禁 note 没有 sha 证据，补录不重建（`sensitive` / `mandatory` = null，面板显示 `—`）；
 * 指令 / 普通评论只在整条 MR 上扫一次、挂在最后一轮，不假装它们属于历史上某一轮。
 * 纯函数：不碰网络 / 时钟，数据全部来自调用方传入的 MR 快照与 notes。
 * @param {{ mr: object, notes: object[], cfg: object }} input
 */
export function rebuildRounds({ mr, notes, cfg }) {
  const reviewOptions = { marker: cfg?.reviewMarker }
  const dropped = []
  const groups = new Map()
  for (const note of notes ?? []) {
    if (!note || typeof note !== 'object' || note.system === true) continue
    const body = String(note.body ?? '')
    if (!isReviewBody(body, reviewOptions)) continue
    const sha = reviewShaOf(body)
    if (sha === null) { dropped.push({ noteId: note.id ?? null, reason: 'stale', detail: 'no-sha' }); continue }
    const bucket = groups.get(sha) ?? []
    bucket.push(note)
    groups.set(sha, bucket)
  }
  const timeOf = (note) => {
    const parsed = Date.parse(note?.created_at ?? '')
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
  }
  // 轮次顺序 = 该组第一条评审 note 的时间；同一时间用 note.id 兜底（GitLab id 单调递增）。
  const ordered = [...groups.entries()].sort((left, right) => {
    const delta = Math.min(...left[1].map(timeOf)) - Math.min(...right[1].map(timeOf))
    if (delta !== 0) return delta
    return (left[1][0]?.id ?? 0) - (right[1][0]?.id ?? 0)
  })
  const parsedDirectives = parseDirectives(directiveCandidates({ notes, reviewOptions, cfg }))
  const { directiveNotes, ...directivePayload } = parsedDirectives
  const comments = otherComments({ notes, reviewOptions, cfg })
  const emptyDirectives = { directives: [], invalid: { count: 0, samples: [] }, truncated: { directives: 0, directiveNotes: 0, notes: 0, lines: 0 } }
  return ordered.map(([sha, bucket], index) => {
    const latest = latestBy(bucket.map((note) => ({ note })))?.note ?? bucket[bucket.length - 1]
    const parsed = parseReview(latest?.body, reviewOptions)
    const observedAt = timeOf(latest)
    const isLast = index === ordered.length - 1
    return {
      sha,
      n: index + 1,
      observedAt: Number.isFinite(observedAt) ? observedAt : null,
      baselineAt: null,
      // 强绑定有证据（sha 标记就是这一轮的 sha）；门禁没有证据就不编。
      binding: 'strong',
      review: {
        noteId: latest?.id ?? null,
        binding: 'strong',
        verdict: parsed.verdict,
        blocking: parsed.blocking,
        nonBlocking: parsed.nonBlocking,
        historicalUnresolved: countOf(latest?.body, /历史未收敛\s*[:：]\s*`?(\d+)/),
        verifiedFixed: countOf(latest?.body, /本轮已验证修复\s*[:：]\s*`?(\d+)/),
        jobDuration: durationOf(latest?.body),
      },
      sensitive: null,
      mandatory: null,
      // 补录的轮次都有评审，不可能是「提了但没流水线」的伪轮次。
      pipelineForHead: true,
      directives: isLast ? directivePayload : emptyDirectives,
      directiveNotes: isLast ? directiveNotes : [],
      comments: isLast ? comments : [],
      dropped: isLast ? dropped : [],
    }
  })
}
