/**
 * 进度守卫（设计 §5.7）：只在「没在改善」时停，不看轮数。
 * 可合之后是「等合并」不是「没进展」（决策 §2.4）：跳过 stall / reverify / idle，
 * 否则永远等不到 merged；墙钟预算仍兜底，暂停后可 /mr resume。
 * 触发只返回原因，由调用方 pause + 通知；绑定与账本都保留。
 */
export function evaluateGuards({ state, now, cfg }) {
  const awaitingMerge = state?.mergeability?.mergeable === true
  if (awaitingMerge === false) {
    if (cfg.maxRounds > 0 && Array.isArray(state.rounds) && state.rounds.length >= cfg.maxRounds) {
      return { reason: 'stalled' }
    }
    if (state.stallStreak >= cfg.stallRounds) return { reason: 'stalled' }
    if (state.reverifyStreak >= cfg.reverifyStreak) return { reason: 'stalled' }
  }
  if (now - state.startedAt >= cfg.wallClockMs) return { reason: 'budget' }
  if (awaitingMerge === false && now - state.lastProgressAt >= cfg.idleStopMs) return { reason: 'idle' }
  return null
}
