/**
 * 链式轮次与熔断状态机。全部在内存，会话释放即清空。
 *
 * 轮次按「会话链」计数：一条人类消息开启一条新链，链内最多自动审查 maxRounds 次。
 * 熔断可恢复：连续失败达到阈值后进入冷却期，冷却期内拒绝新的自动审查；
 * 冷却期结束后进入半开（放行一次），再次失败重新打开，成功则清零。
 * @module @liyuera/dsh-code-review/host/loop
 */

/** 连续失败多少次后熔断。 */
const BREAKER_THRESHOLD = 2

/** 默认冷却时长（毫秒）：熔断后 5 分钟内不再自动审查。 */
const DEFAULT_COOLDOWN_MS = 300000

/**
 * @param {{cooldownMs?: number, now?: () => number}} [options]
 * @returns {object} tracker
 */
export function createTracker(options = {}) {
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const now = options.now ?? (() => Date.now())
  const rounds = new Map()
  const failures = new Map()
  const reviewing = new Set()

  return {
    /** 加锁并把当前链的轮次 +1；同一会话已在审查中返回 false（且不增轮）。 */
    begin(sessionId) {
      if (reviewing.has(sessionId)) return false
      rounds.set(sessionId, (rounds.get(sessionId) ?? 0) + 1)
      reviewing.add(sessionId)
      return true
    },
    /** 释放锁（无论审查成败）。 */
    end(sessionId) {
      reviewing.delete(sessionId)
    },
    /** 当前链已自动审查的次数。 */
    roundsOf(sessionId) {
      return rounds.get(sessionId) ?? 0
    },
    /** 人类消息开启新链：只清轮次，不动锁与熔断计数。 */
    resetRounds(sessionId) {
      rounds.delete(sessionId)
    },
    isReviewing(sessionId) {
      return reviewing.has(sessionId)
    },
    /**
     * 记一次失败；达到或处于阈值时打开/重新打开熔断并返回 true。
     * 计数封顶在阈值，冷却期后再次失败只刷新 openedAt。
     */
    recordFailure(sessionId) {
      const state = failures.get(sessionId) ?? { count: 0, openedAt: 0 }
      state.count = Math.min(state.count + 1, BREAKER_THRESHOLD)
      if (state.count >= BREAKER_THRESHOLD) state.openedAt = now()
      failures.set(sessionId, state)
      return state.count >= BREAKER_THRESHOLD
    },
    recordSuccess(sessionId) {
      failures.delete(sessionId)
    },
    /** 冷却期内为 true；冷却期结束后为 false（半开，允许一次尝试）。 */
    isBreakerOpen(sessionId) {
      const state = failures.get(sessionId)
      if (state === undefined || state.count < BREAKER_THRESHOLD) return false
      return now() - state.openedAt < cooldownMs
    },
    /** 会话释放：清空轮次、锁与熔断状态。 */
    forget(sessionId) {
      rounds.delete(sessionId)
      reviewing.delete(sessionId)
      failures.delete(sessionId)
    },
  }
}
