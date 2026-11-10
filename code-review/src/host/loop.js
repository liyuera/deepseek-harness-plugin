/**
 * 轮次与熔断状态机。全部在内存，会话释放即清空。
 * @module @liyuera/dsh-code-review/host/loop
 */

/** 连续失败多少次后熔断。 */
const BREAKER_THRESHOLD = 2

/**
 * @returns {object} tracker
 */
export function createTracker() {
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
    roundsOf(sessionId, turn) {
      return rounds.get(key(sessionId, turn)) ?? 0
    },
    isReviewing(sessionId) {
      return reviewing.has(sessionId)
    },
    /** 记一次失败；达到阈值返回 true 表示刚打开熔断。 */
    recordFailure(sessionId) {
      const count = (failures.get(sessionId) ?? 0) + 1
      failures.set(sessionId, count)
      return count === BREAKER_THRESHOLD
    },
    recordSuccess(sessionId) {
      failures.delete(sessionId)
    },
    isBreakerOpen(sessionId) {
      return (failures.get(sessionId) ?? 0) >= BREAKER_THRESHOLD
    },
    forget(sessionId) {
      failures.delete(sessionId)
      reviewing.delete(sessionId)
      for (const slot of [...rounds.keys()]) if (slot.startsWith(`${sessionId}:`)) rounds.delete(slot)
    },
  }
}
