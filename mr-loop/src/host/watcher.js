/**
 * 每会话一个 watcher。节拍：守卫 → 1 个 MR 请求 → 必要时拉 notes → 并快照 → 判断唤醒 → 排下一次。
 * 没有 LLM 调用；所有定时器可注入，单测里用假时钟。
 * 唤醒去抖：同一 (sha, verdict, 门禁摘要) 只唤醒一次，两次唤醒最小间隔 30s。
 */
import { evaluateGuards } from './guards.js'

const WAKE_MIN_GAP_MS = 30000
const TERMINAL_PIPELINE = new Set(['success', 'failed', 'canceled'])
const TOKEN_ERRORS = new Set(['unauthorized', 'forbidden', 'no-token'])

const terminal = (status) => TERMINAL_PIPELINE.has(status)
const sleepSeconds = (ms) => Math.max(1, Math.round(ms / 1000))

/** 同一次评审（同一 sha、同一组门禁结论）只唤醒一次，避免 reviewArrived 反复触发。 */
function wakeKey(round) {
  const sha = String(round?.sha ?? '')
  const review = round?.review?.verdict ?? 'none'
  const sensitive = round?.sensitive?.verdict ?? 'none'
  const mandatory = round?.mandatory?.verdict ?? 'none'
  return `review:${sha}:${review}:${sensitive}:${mandatory}`
}

/**
 * @param {{ cfg: object, gitlab: object, service: object, notify: (input: { sessionId: string, text: string }) => void,
 *           now?: () => number, setTimer?: Function, clearTimer?: Function }} deps
 */
export function createWatcher({ cfg, gitlab, service, notify, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const timers = new Map()
  /** sessionId → 上次唤醒时刻（最小间隔判据）。 */
  const lastWakeAt = new Map()
  /** sessionId → 上次唤醒的去抖 key（同一评审只唤醒一次）。 */
  const lastWakeKey = new Map()

  function clear(sessionId) {
    const timer = timers.get(sessionId)
    if (timer !== undefined) clearTimer(timer)
    timers.delete(sessionId)
  }

  function schedule(sessionId, delayMs) {
    clear(sessionId)
    if (!Number.isFinite(delayMs) || delayMs <= 0) return
    // 定时回调不 await tick：异步失败必须自己吞掉，否则会成为 unhandled rejection。
    timers.set(sessionId, setTimer(() => { void tick(sessionId).catch(() => clear(sessionId)) }, delayMs))
  }

  function wake(sessionId, text, key = undefined) {
    const nowMs = now()
    const previous = lastWakeAt.get(sessionId)
    // 从没唤醒过时不能把「0」当成上次唤醒时刻：假时钟（now=1000）会把第一次唤醒也拒掉。
    if (previous !== undefined && nowMs - previous < WAKE_MIN_GAP_MS) return false
    if (key !== undefined && lastWakeKey.get(sessionId) === key) return false
    lastWakeAt.set(sessionId, nowMs)
    if (key !== undefined) lastWakeKey.set(sessionId, key)
    notify({ sessionId, text })
    return true
  }

  async function tick(sessionId) {
    const state = service.getState(sessionId)
    if (state === null || state === undefined) { clear(sessionId); return }
    if (state.paused !== null && state.paused !== undefined) { clear(sessionId); return }

    const guard = evaluateGuards({ state, now: now(), cfg })
    if (guard !== null) {
      try {
        service.pause({ sessionId, reason: guard.reason })
      } catch {
        // 状态在 tick 期间被 stop 掉了：没有可暂停的绑定，直接收工。
        clear(sessionId)
        return
      }
      wake(sessionId, `已暂停监视（${guard.reason}）。用 /mr resume 继续。`)
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
        wake(sessionId, `GitLab token 不可用（${code}）。放好 token 后 /mr resume。`)
        clear(sessionId)
        return
      }
      wake(sessionId, `拉取 MR 失败（${code}），${sleepSeconds(cfg.pollWatchingMs)}s 后重试。`)
      schedule(sessionId, cfg.pollWatchingMs)
      return
    }

    if (mr.state === 'merged' || mr.state === 'closed') {
      // 终态是永久的：同一个 (state, sha) 只唤醒一次，避免用户下一句话又把 watcher 拉起来重复唤醒。
      wake(sessionId, `MR 已 ${mr.state}，停止监视。`, `mr:${mr.state}:${String(mr.sha ?? '')}`)
      clear(sessionId)
      return
    }

    const pipelineStatus = mr.head_pipeline?.status ?? null
    const hasReview = state.round?.review !== null && state.round?.review !== undefined
    const shouldFetchNotes = hasReview === false
      || mr.sha !== state.round?.sha
      || mr.user_notes_count !== state.notesCount
      || (terminal(pipelineStatus) && pipelineStatus !== state.pipelineStatus)

    let notes
    if (shouldFetchNotes) {
      try {
        notes = await gitlab.listNotes({ project, iid })
      } catch {
        schedule(sessionId, cfg.pollAwaitingMs)
        return
      }
    }

    let result
    try {
      result = service.applySnapshot({ sessionId, mr, notes })
    } catch {
      // 快照期间被 stop/解绑：静默收工，别把异常抛给定时器。
      clear(sessionId)
      return
    }
    const next = result.state

    const reviewVerdict = next.round?.review?.verdict
    const reviewArrived = reviewVerdict !== undefined && reviewVerdict !== null && (result.newRound || result.reviewArrived)
    // 可合并是终点：无论是否在本次 tick 里「变成」可合并，都必须停表；
    // 但只有状态真的发生变化时才唤醒，避免 bind 已经给过报告后又重复推一遍。
    if (next.mergeability?.mergeable === true) {
      if (result.becameMergeable === true) {
        wake(sessionId, `${service.report(next)}\n\n可合并，监视结束。`, `mergeable:${String(next.round?.sha ?? '')}`)
      }
      clear(sessionId)
      return
    }
    if (reviewArrived) wake(sessionId, service.report(next), wakeKey(next))

    const delay = !terminal(pipelineStatus)
      ? (pipelineStatus === null ? cfg.pollNoPipelineMs : cfg.pollAwaitingMs)
      : cfg.pollSettleMs
    schedule(sessionId, delay)
  }

  return {
    tick,
    start(sessionId) {
      const state = service.getState(sessionId)
      if (state === null || state === undefined) { clear(sessionId); return }
      if (state.paused !== null && state.paused !== undefined) { clear(sessionId); return }
      schedule(sessionId, cfg.pollAwaitingMs)
    },
    stop(sessionId) { clear(sessionId) },
    stopAll() { for (const sessionId of [...timers.keys()]) clear(sessionId) },
    isWatching(sessionId) { return timers.has(sessionId) },
  }
}
