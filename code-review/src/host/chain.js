/**
 * 链级累积器：把一条链内所有 turn 的 workspace/changes 文件合并，
 * 供“最后一轮全量审查”和 `/review --full` 使用。
 * @module @liyuera/dsh-code-review/host/chain
 */
export function createChainStore({ maxFiles = 20 } = {}) {
  const chains = new Map()

  const stateOf = (sessionId, epoch) => {
    const current = chains.get(sessionId)
    if (current !== undefined && current.epoch === epoch) return current
    const fresh = { epoch, files: new Map(), full: false, touch: 0 }
    chains.set(sessionId, fresh)
    return fresh
  }

  return {
    observe(sessionId, epoch, seq, turn, files, isCode) {
      const state = stateOf(sessionId, epoch)
      for (const file of files ?? []) {
        const path = file.path
        if (typeof path !== 'string' || path.length === 0) continue
        if (typeof isCode === 'function' && isCode(path) !== true) continue
        const item = state.files.get(path) ?? {
          path, display: file.display ?? path, lastSeq: seq, turns: [], added: 0, deleted: 0, order: 0,
        }
        if (!item.turns.includes(turn)) item.turns.push(turn)
        item.turns.sort((left, right) => left - right)
        item.lastSeq = Math.max(item.lastSeq, seq)
        item.order = ++state.touch
        item.added += file.added ?? 0
        item.deleted += file.deleted ?? 0
        state.files.set(path, item)
      }
      if (state.files.size > maxFiles) {
        const kept = [...state.files.values()]
          .sort((left, right) => right.lastSeq - left.lastSeq || right.order - left.order)
          .slice(0, maxFiles)
        state.files = new Map(kept.map((item) => [item.path, item]))
      }
    },
    filesOf(sessionId, epoch) {
      const state = chains.get(sessionId)
      if (state === undefined || state.epoch !== epoch) return []
      return [...state.files.values()]
        .sort((left, right) => left.lastSeq - right.lastSeq)
        .map(({ order, ...item }) => item)
    },
    isFull(sessionId, epoch) {
      const state = chains.get(sessionId)
      return state !== undefined && state.epoch === epoch && state.full === true
    },
    markFull(sessionId, epoch) {
      stateOf(sessionId, epoch).full = true
    },
    forget(sessionId) {
      chains.delete(sessionId)
    },
  }
}
