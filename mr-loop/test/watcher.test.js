import test from 'node:test'
import assert from 'node:assert/strict'
import { createWatcher } from '../src/host/watcher.js'
import { resolveConfig } from '../src/host/config.js'

const SHA = 'a'.repeat(40)
const cfg = resolveConfig({})
const mrOf = (over = {}) => ({
  sha: SHA, state: 'opened', user_notes_count: 2,
  head_pipeline: { status: 'running', created_at: '2026-11-13T09:59:00Z' }, ...over,
})

/**
 * 假时钟 + 假定时器：`advance` 推进 now，`timers` 记录所有 setTimer 调用，
 * 这样「不再排下一次」是真的计数断言，30s 节流也能被测到。
 */
function harness({ mr = mrOf(), notes = [], stateOver = {}, snapshot, report = () => 'REPORT', gitlabOver = {}, clock = 1000 } = {}) {
  const notified = []
  const calls = { mr: 0, notes: 0 }
  const timers = []
  const cleared = []
  let timerSeq = 0
  let current = clock
  const now = () => current
  const advance = (ms) => { current += ms }
  let state = {
    sessionId: 's', binding: { projectPath: 'group/project', iid: 240 },
    mr, round: { sha: SHA, n: 1, observedAt: 1, review: null, sensitive: null, mandatory: null },
    mergeability: { mergeable: false, missing: [], degraded: false }, paused: null,
    notesCount: 2, pipelineStatus: null, startedAt: 0, lastProgressAt: 0,
    stallStreak: 0, reverifyStreak: 0, stallKey: '', rounds: [], decisions: {}, ...stateOver,
  }
  const setState = (next) => {
    state = typeof next === 'function' ? next(state) : { ...state, ...next }
    return state
  }
  const service = {
    getState: () => state,
    report: () => report(state),
    // 只为测试用的最小快照语义：拉过 notes 才算「有新评审」，否则保持原样。
    applySnapshot: ({ mr: nextMr, notes: fetched }) => {
      if (snapshot !== undefined) return snapshot({ mr: nextMr, notes: fetched, getState: () => state, setState })
      const hadReview = state.round.review !== null && state.round.review !== undefined
      const next = setState({
        mr: nextMr,
        notesCount: nextMr.user_notes_count,
        round: { ...state.round, review: fetched === undefined ? state.round.review : { verdict: 'pass' } },
      })
      return { state: next, newRound: false, reviewArrived: fetched !== undefined && !hadReview, becameMergeable: false }
    },
    pause: ({ reason }) => setState({ paused: { reason, at: 'now' } }),
  }
  const gitlab = {
    getMergeRequest: async () => { calls.mr += 1; return mr },
    listNotes: async () => { calls.notes += 1; return notes },
    ...gitlabOver,
  }
  const watcher = createWatcher({
    cfg, gitlab, service,
    notify: ({ text }) => notified.push(text),
    now,
    setTimer: (fn, ms) => { const id = ++timerSeq; timers.push({ id, fn, ms }); return id },
    clearTimer: (id) => { cleared.push(id) },
  })
  return { watcher, service, notified, calls, timers, cleared, setState, advance, getState: () => state }
}

test('每 tick 只发 1 个请求；有评审变化才拉 notes 并唤醒', async () => {
  const h = harness({ notes: [{ id: 1, body: 'AI Code Review' }] })
  await h.watcher.tick('s')
  assert.equal(h.calls.mr, 1)
  assert.equal(h.calls.notes, 1)
  assert.equal(h.notified.length, 1)
  assert.equal(h.timers.length, 1)
})

test('已有本轮评审且计数不变 → 不拉 notes、不唤醒', async () => {
  const h = harness({ stateOver: { round: { sha: SHA, n: 1, observedAt: 1, review: { verdict: 'changes' }, sensitive: null, mandatory: null } } })
  await h.watcher.tick('s')
  assert.equal(h.calls.mr, 1)
  assert.equal(h.calls.notes, 0)
  assert.equal(h.notified.length, 0)
})

test('守卫触发 → pause 且不再排下一次', async () => {
  const h = harness({ stateOver: { stallStreak: 99 } })
  await h.watcher.tick('s')
  assert.equal(h.getState().paused.reason, 'stalled')
  assert.equal(h.calls.mr, 0) // 先判守卫，再发请求
  assert.equal(h.timers.length, 0) // 停表，不是靠下一 tick 才发现 paused
})

test('没有绑定 → 直接退出，不发请求', async () => {
  const h = harness()
  h.service.getState = () => null
  await h.watcher.tick('s')
  assert.equal(h.calls.mr, 0)
  assert.equal(h.timers.length, 0)
})

test('两次唤醒间隔不足 30s：第二次挂起，下一个 tick 补发', async () => {
  const mrs = [
    mrOf({ sha: 'a'.repeat(40) }),
    mrOf({ sha: 'b'.repeat(40), user_notes_count: 3 }),
    // 第三次 tick 故意换新 sha c：如果没有 flush，普通 review 唤醒会推出 REPORT c；
    // 只有真的补发了挂起的 b，第二个通知才是 REPORT b。断言因此有判别力。
    mrOf({ sha: 'c'.repeat(40), user_notes_count: 4 }),
  ]
  const h = harness({
    report: (state) => `REPORT ${String(state.round?.sha ?? '').slice(0, 1)}`,
    snapshot: ({ mr: nextMr, getState, setState }) => {
      const next = setState({
        mr: nextMr,
        notesCount: nextMr.user_notes_count,
        round: {
          sha: nextMr.sha,
          n: (getState().round?.n ?? 0) + 1,
          observedAt: 1,
          review: { verdict: 'changes' },
          sensitive: null,
          mandatory: null,
        },
      })
      return { state: next, newRound: true, reviewArrived: false, becameMergeable: false }
    },
    gitlabOver: { getMergeRequest: async () => mrs.shift() },
  })

  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1)
  assert.match(h.notified[0], /REPORT a/)

  h.advance(1000) // 距上次唤醒 1s：第二次必须被 30s 间隔压住
  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1)

  h.advance(40000) // 距上次唤醒 41s：下一个 tick 开头补发
  await h.watcher.tick('s')
  assert.equal(h.notified.length, 2)
  // 必须是挂起的 b；若删掉 flush，这里会是 c（第三次 tick 自己的普通 review 唤醒）。
  assert.equal(h.notified[1], 'REPORT b')
})

test('getMergeRequest 期间被 rebind → 旧 tick 不写新绑定', async () => {
  let rebound = false
  const h = harness({
    gitlabOver: { getMergeRequest: async () => { rebound = true; return mrOf() } },
  })
  const initialState = h.getState()
  const reboundState = { ...initialState, binding: { projectPath: 'other/repo', iid: 241 } }
  let snapshotCalls = 0
  const applySnapshot = h.service.applySnapshot
  h.service.applySnapshot = (input) => { snapshotCalls += 1; return applySnapshot(input) }
  const getState = h.service.getState
  h.service.getState = () => (rebound ? reboundState : getState())

  await h.watcher.tick('s')

  assert.equal(snapshotCalls, 0) // 旧 tick 的快照不许落进新绑定
  assert.equal(h.notified.length, 0)
  assert.equal(h.timers.length, 0)
})

test('流水线 failed/canceled 立刻唤醒一次', async () => {
  const h = harness({
    mr: mrOf({ head_pipeline: { status: 'failed', id: 9 } }),
    stateOver: {
      pipelineStatus: 'running',
      round: { sha: SHA, n: 1, observedAt: 1, review: { verdict: 'changes' }, sensitive: null, mandatory: null },
    },
  })
  await h.watcher.tick('s')
  const pipelineWakes = h.notified.filter((text) => /流水线 failed/.test(text))
  assert.equal(pipelineWakes.length, 1)
  assert.equal(h.timers.length, 1) // 失败不是终止：继续排下一次
})

test('token 失效 → pause(token) + 一次唤醒 + 不再排下一次', async () => {
  const h = harness({
    gitlabOver: {
      getMergeRequest: async () => {
        const error = new Error('unauthorized')
        error.code = 'unauthorized'
        throw error
      },
    },
  })
  await h.watcher.tick('s')
  assert.equal(h.getState().paused?.reason, 'token')
  assert.equal(h.notified.length, 1)
  assert.match(h.notified[0], /token/)
  assert.equal(h.timers.length, 0)
})

test('merged / 可合 → 唤醒后不再排下一次', async () => {
  const merged = harness({ mr: mrOf({ state: 'merged' }) })
  await merged.watcher.tick('s')
  assert.equal(merged.notified.length, 1)
  assert.match(merged.notified[0], /merged/)
  assert.equal(merged.timers.length, 0)

  const mergeable = harness({
    snapshot: ({ mr: nextMr, setState }) => ({
      state: setState({ mr: nextMr, mergeability: { mergeable: true, missing: [], degraded: false } }),
      newRound: false,
      reviewArrived: false,
      becameMergeable: true,
    }),
  })
  await mergeable.watcher.tick('s')
  assert.equal(mergeable.notified.length, 1)
  assert.match(mergeable.notified[0], /可合并/)
  assert.equal(mergeable.timers.length, 0)
})
