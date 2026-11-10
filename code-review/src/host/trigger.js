/**
 * 门禁真值表：按固定顺序短路求值，返回放行与否及原因。
 * @module @liyuera/dsh-code-review/host/trigger
 */

/**
 * @param {{config: object, origin: string|undefined, reviewing: boolean, rounds: number, hasChanges: boolean, breakerOpen: boolean}} input
 * @returns {{review: boolean, reason: string}}
 */
export function shouldReview({ config, origin, reviewing, rounds, hasChanges, breakerOpen }) {
  if (!config.enabled) return { review: false, reason: 'disabled' }
  if (!config.auto) return { review: false, reason: 'manual-only' }
  if (origin === 'subagent') return { review: false, reason: 'subagent' }
  if (reviewing) return { review: false, reason: 'reviewing' }
  if (rounds >= config.maxRounds) return { review: false, reason: 'rounds-exhausted' }
  if (!hasChanges) return { review: false, reason: 'no-changes' }
  if (breakerOpen) return { review: false, reason: 'breaker-open' }
  return { review: true, reason: 'ok' }
}
