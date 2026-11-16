/**
 * 进度守卫（设计 §5.7）：只在「没在改善」时停，不看轮数。
 * 触发只返回原因，由调用方 pause + 通知；绑定与账本都保留。
 */
export function evaluateGuards({ state, now, cfg }) {
  if (cfg.maxRounds > 0 && Array.isArray(state.rounds) && state.rounds.length >= cfg.maxRounds) {
    return { reason: 'stalled' }
  }
  if (state.stallStreak >= cfg.stallRounds) return { reason: 'stalled' }
  if (state.reverifyStreak >= cfg.reverifyStreak) return { reason: 'stalled' }
  if (now - state.startedAt >= cfg.wallClockMs) return { reason: 'budget' }
  if (now - state.lastProgressAt >= cfg.idleStopMs) return { reason: 'idle' }
  return null
}
