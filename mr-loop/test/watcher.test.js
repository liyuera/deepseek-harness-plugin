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
function harness({ mr = mrOf(), notes = [], stateOver = {}, snapshot, report = () => 'REPORT', gitlabOver = {}, clock = 1000, notifyImpl, logger } = {}) {
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
    cfg, gitlab, service, logger,
    notify: ({ text }) => {
      if (notifyImpl !== undefined) return notifyImpl(text, notified)
      notified.push(text)
      return true
    },
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

test('notify 返回 false → 不推进 lastWake，下一次 tick 补发同一份报告', async () => {
  const attempted = []
  const h = harness({
    notes: [{ id: 1, body: 'AI Code Review' }],
    notifyImpl: (text, out) => {
      attempted.push(text)
      if (attempted.length === 1) return false
      out.push(text)
      return true
    },
  })

  await h.watcher.tick('s')
  assert.equal(h.notified.length, 0) // 没送达
  // 没送达就不能记账：pendingWake 必须留着，否则这份报告永远丢了。
  h.advance(31000) // 越过 30s 补发窗口
  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1)
  assert.equal(h.notified[0], attempted[0]) // 补发的是同一份报告
})

test('notify 返回 true → 记账落定，下一个 tick 不重复投递', async () => {
  const h = harness({
    notes: [{ id: 1, body: 'AI Code Review' }],
    notifyImpl: (text, out) => { out.push(text); return true },
  })

  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1)

  h.advance(31000) // 即使过了补发窗口，已送达的报告也不该再来一次
  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1)
})

test('notify 抛错 → tick 不崩、不推进 lastWake，下一次 tick 补发同一份报告', async () => {
  let attempts = 0
  const h = harness({
    notes: [{ id: 1, body: 'AI Code Review' }],
    notifyImpl: (text, out) => {
      attempts += 1
      if (attempts === 1) throw new Error('channel closed')
      out.push(text)
      return true
    },
  })

  // notify 的异常在 deliver 里被吞掉：tick 正常收工，不把 rejection 抛给定时器。
  await h.watcher.tick('s')
  assert.equal(h.notified.length, 0)
  assert.equal(h.timers.length, 1) // 照常排下一次

  // 失败不能把唤醒记成「已送达」：没有 lastWake 记录，下一次 tick 开头会补发挂起的报告。
  h.advance(31000)
  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1)
  assert.match(h.notified[0], /REPORT/)
})

test('定时器回调里 tick 失败 → 记一行日志并停表', async () => {
  const warnings = []
  const h = harness({
    logger: { warn: (line) => warnings.push(line) },
    notes: [{ id: 1, body: 'AI Code Review' }],
    // report 在 tick 里没有被 try/catch 包住：用它制造一条最简单的可达 reject。
    report: () => { throw new Error('report boom') },
  })

  h.watcher.start('s')
  assert.equal(h.timers.length, 1)

  h.timers[0].fn() // 直接触发定时回调，内部 tick 会 reject
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(h.cleared, [h.timers[0].id]) // 仍然停表，不改变 no-throw 行为
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0], '[mr-loop] tick 失败，停止监视：report boom')
})

test('listNotes 失败 → 记一行日志并继续排下一次', async () => {
  const warnings = []
  const h = harness({
    logger: { warn: (line) => warnings.push(line) },
    gitlabOver: { listNotes: async () => { throw new Error('boom') } },
  })
  await h.watcher.tick('s')
  assert.equal(h.timers.length, 1)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /\[mr-loop\] 拉取 notes 失败/)
})

test('applySnapshot 失败 → 记一行日志并停表', async () => {
  const warnings = []
  const h = harness({
    logger: { warn: (line) => warnings.push(line) },
    snapshot: () => { throw new Error('boom') },
  })
  await h.watcher.tick('s')
  assert.equal(h.timers.length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /\[mr-loop\] 应用快照失败/)
})
