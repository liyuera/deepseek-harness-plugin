/**
 * 轮次与熔断状态机。全部在内存，会话释放即清空。
 *
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
  const key = (sessionId, turn) => `${sessionId}:${turn}`

  return {
    /** 加锁并记一轮；同一会话已在审查中返回 false。 */
    begin(sessionId, turn) {
      if (reviewing.has(sessionId)) return false
      const slot = key(sessionId, turn)
      rounds.set(slot, (rounds.get(slot) ?? 0) + 1)
      reviewing.add(sessionId)
      return true
    },
    /** 标记本轮审查结束（无论成败）。 */
    end(sessionId) {
      reviewing.delete(sessionId)
    },
    /**
     * 回滚「已 begin 但最终没有真正审查」的一轮计数（最低 0）。
     *
     * 用于取材为空、内容指纹与同一 turn 上一轮重复等跳过场景：这些跳过不该消耗轮次，
     * 也不触碰 `reviewing` 锁与 failures/breaker。调用方仍需在 finally 里 end() 释放锁。
     */
    abandonRound(sessionId, turn) {
      const slot = key(sessionId, turn)
      const count = rounds.get(slot) ?? 0
      if (count > 0) rounds.set(slot, count - 1)
    },
    roundsOf(sessionId, turn) {
      return rounds.get(key(sessionId, turn)) ?? 0
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
    forget(sessionId) {
      failures.delete(sessionId)
      reviewing.delete(sessionId)
      for (const slot of [...rounds.keys()]) if (slot.startsWith(`${sessionId}:`)) rounds.delete(slot)
    },
  }
}
