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
