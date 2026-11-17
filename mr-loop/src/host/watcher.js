/**
 * 每会话一个 watcher。节拍：守卫 → 1 个 MR 请求 → 必要时拉 notes → 并快照 → 判断唤醒 → 排下一次。
 * 没有 LLM 调用；所有定时器可注入，单测里用假时钟。
 * 唤醒去抖：同一 (sha, verdict, 门禁摘要) 只唤醒一次，两次唤醒最小间隔 30s；
 * 被 30s 节流压住的报告不能丢——挂进 pendingWake，由下一个 tick 开头补发。
 * 终止路径（守卫暂停 / token / merged / closed）没有下一个 tick，唤醒立即送达；
 * 可合不是终止路径（决策 §2.4）：唤醒一次后继续轮询到合并，因此走普通 30s 节流。
 */
import { evaluateGuards } from './guards.js'
import { openFindings, reviewTodo } from './mergeable.js'
import { clipText } from './parse-directives.js'

const WAKE_MIN_GAP_MS = 30000
const DETAIL_LIMIT = 200
const WAIVER_HINT = '不打算改的用 mr_waive 出草稿，经用户「可以 / 自定义」确认后 post:true 回帖（#ai-skip / #ai-wontfix 同理）；最后给出结论：修了哪些、用了什么指令、并引用对应 MR 评论。'
const TERMINAL_PIPELINE = new Set(['success', 'failed', 'canceled'])
const TOKEN_ERRORS = new Set(['unauthorized', 'forbidden', 'no-token'])

const terminal = (status) => TERMINAL_PIPELINE.has(status)
const sleepSeconds = (ms) => Math.max(1, Math.round(ms / 1000))

/**
 * findings 签名：FID + 级别 + 复验次数的稳定序列（排序后拼接，与解析顺序无关）。
 * 同一评审 note 被编辑、或同 sha 又出一份评审时，签名用来判断「内容真的变了」。
 */
function findingsSignature(review) {
  const items = [
    ...(Array.isArray(review?.blocking) ? review.blocking : []),
    ...(Array.isArray(review?.nonBlocking) ? review.nonBlocking : []),
  ]
  return items
    .map((item) => `${String(item?.fid ?? '')}|${String(item?.level ?? '')}|${item?.reverifyCount ?? ''}`)
    .sort()
    .join(',')
}

/** 评审身份：note.id + findings 签名。同 sha 上「有没有新评审 / 内容变没变」只看这个。 */
function reviewIdentity(review) {
  if (review === null || review === undefined) return null
  return `${review.noteId ?? '?'}|${findingsSignature(review)}`
}

/**
 * 同一次评审只唤醒一次：sha + 评审 note.id + findings 签名 + verdict + 三套门禁。
 * 加入 note.id / findings 签名后，同一 sha 上因评论触发的新评审能唤醒（key 变了），
 * 同一轮内容不变（含豁免理由变更）不会重复唤醒（key 不变）。
 */
function wakeKey(round) {
  const sha = String(round?.sha ?? '')
  const review = round?.review?.verdict ?? 'none'
  const noteId = round?.review?.noteId ?? 'none'
  const findings = findingsSignature(round?.review)
  const sensitive = round?.sensitive?.verdict ?? 'none'
  const mandatory = round?.mandatory?.verdict ?? 'none'
  return `review:${sha}:${noteId}:${findings}:${review}:${sensitive}:${mandatory}`
}

/** note 派生文本进唤醒前先压单行、截断；缺失字段统一占位 `—`。 */
function fieldText(value, max = DETAIL_LIMIT) {
  const text = clipText(value, max)
  return text === '' ? '—' : text
}

/** 一条未处置 finding 的明细：问题 i/N · FID · 级别 · 门禁分类 · file:line + 问题/建议/复验次数。 */
function findingDetail(item, index, total) {
  const location = fieldText(item?.location, 120)
  const fileLine = location !== '—' ? location : fieldText(item?.file, 120)
  const count = Number.isFinite(item?.reverifyCount) ? String(item.reverifyCount) : '—'
  return [
    `问题 ${index + 1}/${total} · FID ${fieldText(item?.fid, 64)} · ${fieldText(item?.level, 40)} · ${fieldText(item?.gateCategory ?? item?.type, 40)} · ${fileLine}`,
    `  问题：${fieldText(item?.problem)}`,
    `  建议：${fieldText(item?.suggestion)}`,
    `  复验次数：${count}`,
  ].join('\n')
}

/** 无效指令条数：新结构 `{count,samples}`，旧账本里可能还是数组（只用于提示，不参与判定）。 */
function invalidCountOf(round) {
  const invalid = round?.directives?.invalid
  if (Array.isArray(invalid)) return invalid.length
  return typeof invalid?.count === 'number' ? invalid.count : 0
}

/** 全量问题明细段：只列未处置 finding（已豁免的不进，避免让主代理重复决策）。 */
function findingsDetail(open) {
  return `问题明细：\n${open.map((item, index) => findingDetail(item, index, open.length)).join('\n')}`
}

/**
 * 唤醒正文 = 动作指令段 → 报告 → 全量问题明细段。
 * 指令只属于唤醒这一层，报告本身仍是事实陈述（「合并」行说差几项）；
 * 没有未处置问题时原样返回报告，不加指令段也不加明细段，避免给既有唤醒加噪音。
 */
function withReviewDirective(state, text) {
  const round = state?.round
  const todo = reviewTodo(round, state?.decisions)
  if (todo.total === 0) return text
  const open = openFindings(round, state?.decisions)
  const preview = `${todo.fids.join('、')}${todo.total > todo.fids.length ? '、…' : ''}`
  const lines = [
    `有 ${todo.total} 处评审问题待处置（${preview}）：全部问题见下方明细，修哪些由你决定；可以按问题分组并行派 subagent。`,
  ]
  // #8：只算真正命中本轮的豁免条数——旧轮 / 不相关 FID 的指令不该冒充「已豁免 M 条」。
  if (todo.waived.length > 0) {
    lines.push(`已收到 ${todo.waived.length} 条 MR 指令（#ai-waive/#ai-skip/#ai-wontfix），对应 FID 已计入豁免。`)
  }
  // #6：格式不对的指令不生效，但要让主代理知道「写了但没生效」，只提示条数。
  const invalidCount = invalidCountOf(round)
  if (invalidCount > 0) lines.push(`另有 ${invalidCount} 条 #ai-* 指令格式不对，未生效。`)
  lines.push(WAIVER_HINT)
  return `${lines.join('\n')}\n\n${text}\n\n${findingsDetail(open)}`
}

/**
 * @param {{ cfg: object, gitlab: object, service: object, notify: (input: { sessionId: string, text: string }) => boolean,
 *           logger?: { warn?: Function }, now?: () => number, setTimer?: Function, clearTimer?: Function }} deps
 */
export function createWatcher({ cfg, gitlab, service, notify, logger = undefined, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const timers = new Map()
  /** sessionId → 上次唤醒时刻（最小间隔判据）。 */
  const lastWakeAt = new Map()
  /** sessionId → 上次唤醒的去抖 key（同一评审只唤醒一次）。 */
  const lastWakeKey = new Map()
  /** sessionId → 被 30s 节流压住、等待下一个 tick 补发的唤醒（`{ text, key }`）。 */
  const pendingWake = new Map()
  /**
   * sessionId → 单轮计时：当前 sha、从何时开始等这条 sha 的评审、评审首次出现的时刻，
   * 以及 timeout / gateSettle 的一次性唤醒标记（同一个 sha 只提醒一次）。
   */
  const roundClocks = new Map()

  /** 取当前 sha 的计时记录；sha 变了就重开一轮（awaitingSince 从「观测到新 sha」起算）。 */
  function roundClock(sessionId, round) {
    const sha = String(round?.sha ?? '')
    const existing = roundClocks.get(sessionId)
    if (existing !== undefined && existing.sha === sha) return existing
    const fresh = { sha, awaitingSince: now(), reviewSettledAt: null, timeoutWoken: false, gateSettleWoken: false, noPipelineWoken: false }
    roundClocks.set(sessionId, fresh)
    return fresh
  }

  function clear(sessionId) {
    const timer = timers.get(sessionId)
    if (timer !== undefined) clearTimer(timer)
    timers.delete(sessionId)
  }

  function schedule(sessionId, delayMs) {
    clear(sessionId)
    if (!Number.isFinite(delayMs) || delayMs <= 0) return
    // 定时回调不 await tick：异步失败必须自己吞掉，否则会成为 unhandled rejection。
    // 但「吞掉」不等于静默：记一行日志再停表，否则监视会无声无息地消失。
    timers.set(sessionId, setTimer(() => {
      void tick(sessionId).catch((error) => {
        logger?.warn?.('[mr-loop] tick 失败，停止监视：' + (error?.message ?? error))
        clear(sessionId)
      })
    }, delayMs))
  }

  /** @returns {boolean} 是否真的送达（notify 返回假值或抛错都算没送达）。 */
  function deliver(sessionId, { text, key }) {
    let delivered = false
    try {
      delivered = Boolean(notify({ sessionId, text }))
    } catch {
      // notify 自身的异常不能中断 tick：按「没送达」处理，报告留在 pendingWake 里补发。
      delivered = false
    }
    if (!delivered) {
      // 投递失败：把这次唤醒挂回 pendingWake，且不推进 lastWakeAt / lastWakeKey。
      // 没有记账，下一次 tick 的 flush 会把同一份报告再送一次。
      pendingWake.set(sessionId, { text, key })
      return false
    }
    // 只有 notify 真的返回真值才记「已唤醒」。
    lastWakeAt.set(sessionId, now())
    if (key !== undefined) lastWakeKey.set(sessionId, key)
    pendingWake.delete(sessionId)
    return true
  }

  /**
   * @param {boolean} immediate 终止路径用：没有下一个 tick 可补发，绕过 30s 间隔直接送达。
   *   同 key 的去重仍然生效（merged/closed 被会话重新拉起时不会重复推）。
   */
  function wake(sessionId, text, key = undefined, immediate = false) {
    if (key !== undefined && lastWakeKey.get(sessionId) === key) return false
    if (!immediate) {
      const previous = lastWakeAt.get(sessionId)
      // 从没唤醒过时不能把「0」当成上次唤醒时刻：假时钟（now=1000）会把第一次唤醒也拒掉。
      if (previous !== undefined && now() - previous < WAKE_MIN_GAP_MS) {
        // 报告已经算出、状态也可能已推进，下一 tick 不会再触发：必须挂起补发，不能丢。
        pendingWake.set(sessionId, { text, key })
        return false
      }
    }
    return deliver(sessionId, { text, key })
  }

  /** tick 开头补发：只有距上次唤醒已满 30s 才发，否则继续等。 */
  function flushPendingWake(sessionId) {
    const pending = pendingWake.get(sessionId)
    if (pending === undefined) return
    const previous = lastWakeAt.get(sessionId)
    if (previous !== undefined && now() - previous < WAKE_MIN_GAP_MS) return
    deliver(sessionId, pending)
  }

  async function tick(sessionId) {
    const state = service.getState(sessionId)
    if (state === null || state === undefined) { clear(sessionId); return }
    if (state.paused !== null && state.paused !== undefined) { clear(sessionId); return }
    // 上一个 tick 被 30s 节流压住的报告在这里补发（此时绑定仍在、会话仍活着）。
    flushPendingWake(sessionId)

    const guard = evaluateGuards({ state, now: now(), cfg })
    if (guard !== null) {
      try {
        service.pause({ sessionId, reason: guard.reason })
      } catch {
        // 状态在 tick 期间被 stop 掉了：没有可暂停的绑定，直接收工。
        clear(sessionId)
        return
      }
      // 暂停后没有下一个 tick：立即送达，不能被 30s 节流压住。
      wake(sessionId, `已暂停监视（${guard.reason}）。用 /mr resume 继续。`, undefined, true)
      clear(sessionId)
      return
    }

    const project = state.binding.projectPath
    const iid = state.binding.iid
    let mr
    try {
      mr = await gitlab.getMergeRequest({ project, iid })
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'network'
      if (TOKEN_ERRORS.has(code)) {
        try {
          service.pause({ sessionId, reason: 'token' })
        } catch {
          clear(sessionId)
          return
        }
        // token 暂停后没有下一个 tick：立即送达。
        wake(sessionId, `GitLab token 不可用（${code}）。放好 token 后 /mr resume。`, undefined, true)
        clear(sessionId)
        return
      }
      wake(sessionId, `拉取 MR 失败（${code}），${sleepSeconds(cfg.pollWatchingMs)}s 后重试。`)
      schedule(sessionId, cfg.pollWatchingMs)
      return
    }

    // await 期间可能被 rebind / stop：旧 tick 不能拿旧 MR 去写新绑定。
    const latest = service.getState(sessionId)
    if (latest === null || latest === undefined || latest !== state) { clear(sessionId); return }

    if (mr.state === 'merged' || mr.state === 'closed') {
      // I1：终态先落账本（UI 才能看到「已合并」）；落账本失败只 warn，唤醒与停表照旧。
      try {
        await service.markTerminal({ sessionId, mr })
      } catch (error) {
        logger?.warn?.(`[mr-loop] 终态落账本失败（${mr.state}）：${error?.message ?? error}`)
      }
      // 终态是永久的：同一个 (state, sha) 只唤醒一次，避免用户下一句话又把 watcher 拉起来重复唤醒。
      // 终态后没有下一个 tick：立即送达。文案只说事实，合并收尾不写评论（决策 §2.4 / 用户决策 5）。
      const iid = state.binding.iid
      const text = mr.state === 'merged'
        ? `MR !${iid} 已合并（sha ${String(mr.sha ?? '?')}），监视结束；不需要发评论。`
        : 'MR 已关闭（未合并），监视结束。'
      wake(sessionId, text, `mr:${mr.state}:${String(mr.sha ?? '')}`, true)
      clear(sessionId)
      return
    }

    const pipelineStatus = mr.head_pipeline?.status ?? null
    // 这笔提交到底有没有流水线：GitLab 的 head_pipeline 是「这个 MR 最新的流水线」，
    // 新 push 之后它可能还停在上一个 commit 上（sha 不一致）——此时评审不会被自动产出。
    // 实例没给 sha / 当前 sha 缺失时无法证明，按「未知」处理，绝不误报。
    const headSha = typeof mr.sha === 'string' ? mr.sha : ''
    const pipelineSha = typeof mr.head_pipeline?.sha === 'string' ? mr.head_pipeline.sha : null
    const pipelineForHead = mr.head_pipeline === null || mr.head_pipeline === undefined
      ? false
      : pipelineSha === null || headSha === ''
        ? true
        : pipelineSha === headSha
    // 给唤醒文案用：评审卡在哪条流水线上（或根本没有）。
    const pipelineLabel = () => {
      const latest = mr.head_pipeline
      if (latest === null || latest === undefined) return '无流水线'
      const short = String(latest.sha ?? '').slice(0, 8)
      const where = short === '' ? '' : `（${short}）`
      return `#${latest.id ?? '?'}${where}`
    }
    // 设计 §5.4：流水线 failed/canceled 立刻唤醒（评审可能根本没产出，不要静默等到超时）。
    if ((pipelineStatus === 'failed' || pipelineStatus === 'canceled') && pipelineStatus !== state.pipelineStatus) {
      wake(sessionId, `流水线 ${pipelineStatus}（#${mr.head_pipeline?.id ?? '?'}）：评审可能没有产出，先看 job 日志或等下一轮。`)
    }
    const hasReview = state.round?.review !== null && state.round?.review !== undefined
    const shouldFetchNotes = hasReview === false
      || mr.sha !== state.round?.sha
      || mr.user_notes_count !== state.notesCount
      || (terminal(pipelineStatus) && pipelineStatus !== state.pipelineStatus)

    let notes
    if (shouldFetchNotes) {
      try {
        notes = await gitlab.listNotes({ project, iid })
      } catch (error) {
        logger?.warn?.(`[mr-loop] 拉取 notes 失败（${error?.code ?? 'network'}），${sleepSeconds(cfg.pollAwaitingMs)}s 后重试。`)
        schedule(sessionId, cfg.pollAwaitingMs)
        return
      }
      // 拉 notes 也是 await：期间同样可能被 rebind / stop，写快照前再复核一次。
      const latestAfterNotes = service.getState(sessionId)
      if (latestAfterNotes === null || latestAfterNotes === undefined || latestAfterNotes !== state) { clear(sessionId); return }
    }

    // 快照前记下评审身份：同 sha 上「新评审 / 评审内容变化」靠它判定（服务层只报 verdict 变化）。
    const reviewBefore = state.round?.review ?? null
    let result
    try {
      result = service.applySnapshot({ sessionId, mr, notes })
    } catch (error) {
      // 快照期间被 stop/解绑：记一条日志再收工，别把异常抛给定时器。
      logger?.warn?.(`[mr-loop] 应用快照失败，停止本会话监视：${error?.message ?? error}`)
      clear(sessionId)
      return
    }
    const next = result.state

    const reviewVerdict = next.round?.review?.verdict
    const reviewPresent = next.round?.review !== null && next.round?.review !== undefined
    const reviewArrived = reviewVerdict !== undefined && reviewVerdict !== null && (result.newRound || result.reviewArrived)
    // 同一 sha、同一评审 verdict 下，新 note.id 或 findings 签名变化也要唤醒（决策文档 §2.2）：
    // 例如「评论触发的第二次评审」verdict 可能与上一份相同，但 note.id 是新的。
    const identityBefore = reviewIdentity(reviewBefore)
    const identityAfter = reviewIdentity(next.round?.review)
    const reviewChanged = result.newRound !== true && identityBefore !== null && identityAfter !== null && identityBefore !== identityAfter
    // 可合不是终点（决策 §2.4）：唤醒一次「可合并，继续监视到合并」，但**不停表**，
    // 继续按原节拍轮询直到 merged / closed；去重靠 `mergeable:<sha>`，同一 sha 只推一次。
    // 此时还有下一个 tick 可补发，所以走普通 30s 节流，不再 immediate。
    const mergeableNow = next.mergeability?.mergeable === true
    const mergeableWoken = mergeableNow && result.becameMergeable === true
    if (mergeableWoken) {
      wake(sessionId, withReviewDirective(next, `${service.report(next)}\n\n可合并，继续监视到合并。`), `mergeable:${String(next.round?.sha ?? '')}`)
    }
    // 「变成可合」的那次快照里往往同时有评审到达：报告已经在上面推过，同一 tick 不再推第二条。
    if (mergeableWoken === false) {
      if (reviewArrived || reviewChanged) wake(sessionId, withReviewDirective(next, service.report(next)), wakeKey(next.round))
      // 评审已经到、门禁后来才翻面（同 sha）时 reviewArrived 为假：单独补一条门禁唤醒。
      // 两个条件同时为真时只走上面那条，wake key 已含三套 verdict，不会双唤醒。
      // 新 sha 的首个快照还没有本轮评审：门禁只是先到，不能当成「门禁变化」唤醒，
      // 否则每次 push 都可能多一条「评审未出」的噪声；评审到达走上面的 reviewArrived。
      else if (result.gatesChanged === true && reviewPresent) wake(sessionId, withReviewDirective(next, service.report(next)), wakeKey(next.round))
    }

    // 单轮计时：新 sha 观测到就重开；评审首次出现记 reviewSettledAt。
    const tickAt = now()
    const clock = roundClock(sessionId, next.round)
    if (reviewPresent) {
      if (clock.reviewSettledAt === null) clock.reviewSettledAt = tickAt
    } else {
      // 评审从本轮消失（例如 note 被删除后重解析）：重新按「未出」计时。
      clock.reviewSettledAt = null
      clock.gateSettleWoken = false
    }
    // 设计 §5.6 第 4 条：mandatory 是建议性的（常只在早期出现一次），不参与 settle 判定；
    // 窗口只盯 sensitive，任何 verdict（含 pass/block）出现即关闭窗口。
    const gatesMissing = next.round?.sensitive == null

    // 设计 §5.7：单轮兜底超时只唤醒一次；不停表，下一 tick 继续等。
    // key 带上 roundTimeout:<sha>，同一 sha 的重复 tick 不会重复提醒。
    if (reviewPresent === false && clock.timeoutWoken === false && tickAt - clock.awaitingSince >= cfg.roundTimeoutMs) {
      const shortSha = String(next.round?.sha ?? '').slice(0, 8)
      const minutes = Math.max(1, Math.round((tickAt - clock.awaitingSince) / 60000))
      const pipelineText = pipelineForHead
        ? `流水线 ${pipelineStatus ?? '无'}。`
        : `这笔提交没有流水线（最新 ${pipelineLabel()} 还停在上一笔提交）。`
      wake(
        sessionId,
        `评审超时：sha ${shortSha} 已等待 ${minutes} 分钟仍未出结论。${pipelineText}`,
        `roundTimeout:${clock.sha}`,
      )
      clock.timeoutWoken = true
    }

    // 新提交长时间没有流水线：评审不会自己来，提前叫一次（draw 设计 §5.4 补丁），
    // 不要让它静默等到 roundTimeoutMs。同一个 sha 只提醒一次。
    if (
      pipelineForHead === false
      && reviewPresent === false
      && clock.noPipelineWoken === false
      && tickAt - clock.awaitingSince >= cfg.noPipelineWakeMs
    ) {
      const shortSha = String(next.round?.sha ?? headSha).slice(0, 8)
      const minutes = Math.max(1, Math.round((tickAt - clock.awaitingSince) / 60000))
      const latest = mr.head_pipeline
      const text = latest === null || latest === undefined
        ? `评审不会自己来：sha ${shortSha} 已经 ${minutes} 分钟没有流水线。重新 push 或手动跑一次流水线。`
        : `评审不会自己来：sha ${shortSha} 已经 ${minutes} 分钟没有流水线，最新流水线 ${pipelineLabel()} 还停在上一笔提交。重新 push 或手动跑一次流水线。`
      wake(sessionId, text, `noPipeline:${clock.sha}`)
      clock.noPipelineWoken = true
    }

    // 设计 §5.4：评审已到、敏感门禁仍未出时，等满 gateSettleMs 只提醒一次；
    // key 与评审唤醒分开，避免被 30s 节流吞掉。
    if (reviewPresent && clock.gateSettleWoken === false && gatesMissing && tickAt - clock.reviewSettledAt >= cfg.gateSettleMs) {
      const minutes = Math.max(1, Math.round((tickAt - clock.reviewSettledAt) / 60000))
      wake(sessionId, `门禁未出：${minutes} 分钟仍无结论（敏感）。`, `gateSettle:${clock.sha}`)
      clock.gateSettleWoken = true
    }

    // 轮次静默后按 pollWatchingMs 等新 sha（设计 §6.5）；流水线/评审还在跑仍用等待间隔，
    // 门禁 settle 窗口内用 pollSettleMs。没有流水线时保持 pollNoPipelineMs。
    const gateSettlePending = reviewPresent && clock.gateSettleWoken === false && gatesMissing
    let delay
    // 评审还没出、这笔提交又没流水线：评审不会很快来，放慢到 pollNoPipelineMs；
    // 评审已经在场时仍按原节拍（流水线 sha 落后可能只是 GitLab 延迟）。
    if (reviewPresent === false && pipelineForHead === false) delay = cfg.pollNoPipelineMs
    else if (pipelineStatus === null) delay = cfg.pollNoPipelineMs
    else if (terminal(pipelineStatus) === false || reviewPresent === false) delay = cfg.pollAwaitingMs
    else if (gateSettlePending) delay = cfg.pollSettleMs
    else delay = cfg.pollWatchingMs
    schedule(sessionId, delay)
  }

  return {
    tick,
    start(sessionId) {
      // 重新开始盯时丢掉旧的挂起报告：rebind 后它可能属于上一个 MR。
      pendingWake.delete(sessionId)
      const state = service.getState(sessionId)
      if (state === null || state === undefined) { clear(sessionId); return }
      if (state.paused !== null && state.paused !== undefined) { clear(sessionId); return }
      // 绑定即有评审时，从「开始盯」起算门禁 settle 窗口；同 sha 重启保留原计时。
      const clock = roundClock(sessionId, state.round)
      if (state.round?.review != null && clock.reviewSettledAt === null) clock.reviewSettledAt = now()
      schedule(sessionId, cfg.pollAwaitingMs)
    },
    stop(sessionId) {
      // 显式停表（/mr stop、会话销毁、插件卸载）时丢弃未补发的报告：
      // 绑定可能已经解绑/换 MR，旧报告的上下文不再成立。
      pendingWake.delete(sessionId)
      roundClocks.delete(sessionId)
      clear(sessionId)
    },
    stopAll() { for (const sessionId of [...timers.keys()]) clear(sessionId) },
    isWatching(sessionId) { return timers.has(sessionId) },
  }
}
