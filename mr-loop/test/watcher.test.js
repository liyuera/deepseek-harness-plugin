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

/** 一条未处置的评审问题：用于断言唤醒消息前置修复指令。 */
const REVIEW_WITH_FINDING = {
  verdict: 'changes',
  blocking: [{ fid: 'a1b2c3d4', level: '低', gateCategory: '非阻塞建议', reverifyCount: 1 }],
  nonBlocking: [],
  historicalUnresolved: 0,
}

/** 自定义快照：把状态推进到「本轮评审已到」，用于控制唤醒正文的输入。 */
const snapshotWithReview = (review) => ({ mr: nextMr, setState }) => ({
  state: setState({ mr: nextMr, round: { sha: SHA, n: 1, observedAt: 1, review, sensitive: null, mandatory: null } }),
  newRound: false,
  reviewArrived: true,
  becameMergeable: false,
})

/** 控制快照：把给定 round 片段写回 state，并返回指定事件标志（T1 唤醒正文用）。 */
const snapshotRound = (patch, flags = {}) => ({ mr: nextMr, setState }) => ({
  state: setState({
    mr: nextMr,
    notesCount: nextMr.user_notes_count,
    round: { sha: nextMr.sha, n: 1, observedAt: 1, review: null, sensitive: null, mandatory: null, ...patch },
  }),
  newRound: false,
  reviewArrived: false,
  gatesChanged: false,
  becameMergeable: false,
  ...flags,
})

/** 多次 tick 的评审快照：首轮按「评审到达」唤醒，此后同 sha 只靠内容变化触发。 */
const sequenceSnapshot = (patches) => {
  let call = 0
  return (input) => {
    const patch = patches[Math.min(call, patches.length - 1)]
    const reviewArrived = call === 0
    call += 1
    return snapshotRound(patch, { reviewArrived })(input)
  }
}

/** 多 tick 场景的 harness：每 tick 换一个 MR 副本（user_notes_count 递增 → 会拉 notes）。 */
const multiTick = (patches) => {
  const mrs = [mrOf({ user_notes_count: 2 }), mrOf({ user_notes_count: 3 }), mrOf({ user_notes_count: 4 })]
  return harness({
    mr: mrs[0],
    notes: [{ id: 1, body: 'AI Code Review' }],
    gitlabOver: { getMergeRequest: async () => mrs.shift() },
    snapshot: sequenceSnapshot(patches),
  })
}

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
      if (snapshot !== undefined) return snapshot({ mr: nextMr, notes: fetched, getState: () => state, getNow: () => current, setState })
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
  return { watcher, service, notified, calls, timers, cleared, setState, advance, getState: () => state, getNow: () => current }
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

test('gatesChanged 单独触发唤醒；与 reviewArrived 同时为真时只唤醒一次', async () => {
  const stateOver = { round: { sha: SHA, n: 1, observedAt: 1, review: { verdict: 'pass' }, sensitive: null, mandatory: null } }
  const run = async (reviewArrived) => {
    const h = harness({
      stateOver,
      snapshot: ({ mr: nextMr, setState }) => ({
        state: setState({ mr: nextMr }),
        newRound: false,
        reviewArrived,
        gatesChanged: true,
        becameMergeable: false,
      }),
    })
    await h.watcher.tick('s')
    return h
  }

  const gateOnly = await run(false)
  assert.equal(gateOnly.notified.length, 1)

  // 两个条件同时为真时走 reviewArrived 分支，不能各唤醒一次。
  const both = await run(true)
  assert.equal(both.notified.length, 1)
})

test('gatesChanged：新 sha 只有门禁、评审未出 → 不唤醒（避免每次 push 多一条报告）', async () => {
  const h = harness({
    snapshot: ({ mr: nextMr, setState }) => ({
      state: setState({
        mr: nextMr,
        round: { sha: OTHER, n: 2, observedAt: 2, review: null, sensitive: { verdict: 'pass' }, mandatory: null },
      }),
      newRound: true,
      reviewArrived: false,
      gatesChanged: true,
      becameMergeable: false,
    }),
  })

  await h.watcher.tick('s')
  assert.equal(h.notified.length, 0)
  assert.equal(h.timers.length, 1) // 继续等评审，不是停表
})

test('gatesChanged：同 sha 评审在场、敏感门禁翻面 → 唤醒一次', async () => {
  const round = { sha: SHA, n: 1, observedAt: 1, review: { verdict: 'pass' }, sensitive: null, mandatory: null }
  const h = harness({
    stateOver: { round },
    snapshot: ({ mr: nextMr, setState }) => ({
      state: setState({ mr: nextMr, round: { ...round, sensitive: { verdict: 'block' } } }),
      newRound: false,
      reviewArrived: false,
      gatesChanged: true,
      becameMergeable: false,
    }),
  })

  await h.watcher.tick('s')
  assert.equal(h.notified.filter((text) => /REPORT/.test(text)).length, 1)
})

const FINDING_AA = {
  fid: 'aa', level: '中', gateCategory: '逻辑错误', location: 'src/a.ts:10-20',
  file: 'src/a.ts', problem: '可能空指针', suggestion: '先判空', reverifyCount: 2,
}
const FINDING_BB = {
  fid: 'bb', level: '低', gateCategory: '非阻塞建议', location: 'src/b.ts:5',
  file: 'src/b.ts', problem: '命名不一致', suggestion: '统一命名', reverifyCount: 1,
}
const FINDING_CC = {
  fid: 'cc', level: '低', gateCategory: '非阻塞建议', location: 'src/c.ts:1',
  file: 'src/c.ts', problem: '重复代码', suggestion: '抽公共函数', reverifyCount: 1,
}
const reviewOf = (blocking, over = {}) => ({ noteId: 100, verdict: 'changes', blocking, nonBlocking: [], historicalUnresolved: 0, ...over })
const waiverOf = (fid, kind = 'waive', over = {}) => ({ fid, kind, reason: `${kind} 原因`, noteId: 74000, ...over })
const roundDirectives = (list, over = {}) => ({
  directives: list,
  directiveNotes: [],
  invalid: { count: 0, samples: [] },
  truncated: { directives: 0, directiveNotes: 0, notes: 0, lines: 0 },
  ...over,
})

test('有未处置 finding → 指令段 + 报告 + 全量问题明细三段；已豁免 FID 不进明细', async () => {
  const h = harness({
    notes: [{ id: 1, body: 'AI Code Review' }],
    report: () => 'REPORT',
    snapshot: snapshotRound(
      {
        review: reviewOf([FINDING_AA, FINDING_BB, FINDING_CC]),
        // cc 已被指令豁免：它不出现在待处置数里，也不进明细；但「已收到 M 条」要算它。
        directives: roundDirectives([waiverOf('cc')]),
      },
      { reviewArrived: true },
    ),
  })

  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1)
  assert.equal(h.notified[0], [
    '有 2 处评审问题待处置（FID aa（中）、FID bb（低））：全部问题见下方明细，修哪些由你决定；可以按问题分组并行派 subagent。',
    '已收到 1 条 MR 指令（#ai-waive/#ai-skip/#ai-wontfix），对应 FID 已计入豁免。',
    '不打算改的用 mr_waive 出草稿，经用户「可以 / 自定义」确认后 post:true 回帖（#ai-skip / #ai-wontfix 同理）；最后给出结论：修了哪些、用了什么指令、并引用对应 MR 评论。',
    '',
    'REPORT',
    '',
    '问题明细：',
    '问题 1/2 · FID aa · 中 · 逻辑错误 · src/a.ts:10-20',
    '  问题：可能空指针',
    '  建议：先判空',
    '  复验次数：2',
    '问题 2/2 · FID bb · 低 · 非阻塞建议 · src/b.ts:5',
    '  问题：命名不一致',
    '  建议：统一命名',
    '  复验次数：1',
  ].join('\n'))
})

test('没有未处置 finding → 唤醒消息保持原样，不追加派发指令', async () => {
  const plain = harness({ notes: [{ id: 1, body: 'AI Code Review' }] })
  await plain.watcher.tick('s')
  assert.equal(plain.notified.length, 1)
  assert.equal(plain.notified[0], 'REPORT')

  // 已 waive 的 finding 也不再触发前缀：唤醒与报告共用同一处置口径。
  const waived = harness({
    notes: [{ id: 1, body: 'AI Code Review' }],
    report: () => 'REPORT',
    stateOver: { decisions: { a1b2c3d4: { kind: 'waive' } } },
    snapshot: snapshotWithReview(REVIEW_WITH_FINDING),
  })
  await waived.watcher.tick('s')
  assert.equal(waived.notified.length, 1)
  assert.equal(waived.notified[0], 'REPORT')
  assert.doesNotMatch(waived.notified[0], /派发修复|评审问题待处置/)
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

// ---------------------------------------------------------------------------
// T3：盯到合并——可合不停表、merged / closed 才是终点、可合后不触发 stall/idle 守卫
// ---------------------------------------------------------------------------

/** 可合快照：第 transitionTick 次 tick 报 `becameMergeable`，之后保持可合（模拟「已可合」稳态）。 */
const becameMergeableSnapshot = (transitionTick = 0) => {
  let call = 0
  return ({ mr: nextMr, setState }) => {
    const isTransition = call === transitionTick
    call += 1
    return {
      state: setState({ mr: nextMr, mergeability: { mergeable: true, missing: [], degraded: false } }),
      newRound: false,
      reviewArrived: false,
      gatesChanged: false,
      becameMergeable: isTransition,
    }
  }
}

test('可合 → 唤醒一次「可合并，继续监视到合并」但不停表，后续 tick 不重复唤醒', async () => {
  const h = harness({ snapshot: becameMergeableSnapshot() })
  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1)
  assert.equal(h.notified[0], 'REPORT\n\n可合并，继续监视到合并。')
  assert.equal(h.timers.length, 1) // 可合不再停表：继续排下一次
  assert.equal(h.watcher.isWatching('s'), true)

  h.advance(31000)
  await h.watcher.tick('s')
  h.advance(31000)
  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1) // 同一 sha 的可合只唤醒一次
  assert.equal(h.timers.length, 3) // 每次 tick 都继续排下一次
  assert.equal(h.watcher.isWatching('s'), true)
})

test('可合后 MR 变 merged → 唤醒「已合并」一次并停表', async () => {
  let currentMr = mrOf()
  const h = harness({
    gitlabOver: { getMergeRequest: async () => currentMr },
    snapshot: becameMergeableSnapshot(),
  })
  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1)
  assert.equal(h.watcher.isWatching('s'), true)
  const timersBefore = h.timers.length

  currentMr = mrOf({ state: 'merged' })
  h.advance(31000)
  await h.watcher.tick('s')
  assert.equal(h.notified.length, 2)
  assert.equal(h.notified[1], `MR !240 已合并（sha ${SHA}），监视结束；不需要发评论。`)
  assert.equal(h.timers.length, timersBefore) // 终态不再排下一次
  assert.equal(h.watcher.isWatching('s'), false)
})

test('closed → 唤醒「未合并关闭」一次并停表；同一 (state, sha) 不重复', async () => {
  const h = harness({ mr: mrOf({ state: 'closed' }) })
  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1)
  assert.equal(h.notified[0], 'MR 已关闭（未合并），监视结束。')
  assert.equal(h.timers.length, 0)
  assert.equal(h.watcher.isWatching('s'), false)

  // 再 tick 一次：同一个 (state, sha) 不能重复唤醒。
  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1)
  assert.equal(h.timers.length, 0)
})

test('merged 之后会话再触发 tick → 去重、不复活监视', async () => {
  const h = harness({ mr: mrOf({ state: 'merged' }) })
  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1)
  assert.equal(h.timers.length, 0)

  // 等价于 index.js 在用户发言后 watcher.start：再拉起来也只会走终态分支。
  h.watcher.start('s')
  assert.equal(h.timers.length, 1)
  h.timers.at(-1).fn()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(h.notified.length, 1) // 同一 (state, sha) 只唤醒一次
  assert.equal(h.timers.length, 1) // 没有新排
  assert.equal(h.watcher.isWatching('s'), false) // 又停表，不会复活
})

test('可合后等 30 分钟：stall / idle 守卫不暂停会话', async () => {
  const h = harness({
    stateOver: {
      mergeability: { mergeable: true, missing: [], degraded: false },
      stallStreak: 99,
      lastProgressAt: 0,
    },
    snapshot: pinnedSnapshot,
  })
  h.advance(cfg.idleStopMs + 1) // 非可合状态在这里必定 stalled / idle
  await h.watcher.tick('s')
  assert.equal(h.getState().paused, null)
  assert.equal(h.watcher.isWatching('s'), true)
  assert.equal(h.timers.length, 1)
})

test('可合唤醒也走既有 30s 节流：被压住时挂起，由下一 tick 补发', async () => {
  let call = 0
  const h = harness({
    snapshot: (input) => {
      const phase = call
      call += 1
      if (phase === 0) {
        // 首次 tick：评审（pass、无未处置问题）到达 → 普通唤醒。
        return snapshotRound({ review: reviewOf([], { verdict: 'pass' }) }, { reviewArrived: true })(input)
      }
      return {
        state: input.setState({ mr: input.mr, mergeability: { mergeable: true, missing: [], degraded: false } }),
        newRound: false,
        reviewArrived: false,
        gatesChanged: false,
        becameMergeable: phase === 1,
      }
    },
  })

  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1)
  h.advance(1000)
  await h.watcher.tick('s') // 距上次唤醒 1s：可合唤醒被 30s 节流压住
  assert.equal(h.notified.length, 1)
  h.advance(30000)
  await h.watcher.tick('s') // 越过 30s：补发挂起的可合唤醒
  assert.equal(h.notified.length, 2)
  assert.equal(h.notified[1], 'REPORT\n\n可合并，继续监视到合并。')
  assert.equal(h.watcher.isWatching('s'), true) // 可合后仍继续监视
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

// ---------------------------------------------------------------------------
// 配置项真正生效：roundTimeoutMs / gateSettleMs / pollWatchingMs
// ---------------------------------------------------------------------------

const OTHER = 'b'.repeat(40)
/** 不做任何状态推进的快照：只把 MR 副本写回，评审保持原样。 */
const pinnedSnapshot = ({ mr: nextMr, setState }) => ({
  state: setState({ mr: nextMr }),
  newRound: false,
  reviewArrived: false,
  gatesChanged: false,
  becameMergeable: false,
})

test('roundTimeoutMs：阈值到点只唤醒一次「评审超时」，之后不重复', async () => {
  const h = harness({ notes: [], snapshot: pinnedSnapshot })

  await h.watcher.tick('s')
  assert.equal(h.notified.length, 0)
  assert.equal(h.timers.at(-1).ms, cfg.pollAwaitingMs) // 评审未出：继续按等待间隔

  h.advance(cfg.roundTimeoutMs - 1)
  await h.watcher.tick('s')
  assert.equal(h.notified.filter((text) => /评审超时/.test(text)).length, 0)

  h.advance(1)
  await h.watcher.tick('s')
  const wakes = h.notified.filter((text) => /评审超时/.test(text))
  assert.equal(wakes.length, 1)
  assert.match(wakes[0], /已等待 15 分钟仍未出结论/)
  assert.equal(h.timers.at(-1).ms, cfg.pollAwaitingMs) // 超时不是终止：仍然排下一次

  h.advance(cfg.pollAwaitingMs)
  await h.watcher.tick('s')
  assert.equal(h.notified.filter((text) => /评审超时/.test(text)).length, 1)
})

test('roundTimeoutMs：观测到新 sha 后重新计时，不继承上一轮的等待时长', async () => {
  let currentSha = SHA
  const h = harness({
    notes: [],
    gitlabOver: { getMergeRequest: async () => mrOf({ sha: currentSha }) },
    snapshot: ({ mr: nextMr, getState, getNow, setState }) => {
      const before = getState().round
      const newRound = before.sha !== nextMr.sha
      return {
        state: setState({
          mr: nextMr,
          // 新 sha 是本轮的「进展」：不更新它，30min idle 守卫会先于 timeout 触发。
          lastProgressAt: newRound ? getNow() : getState().lastProgressAt,
          round: newRound ? { sha: nextMr.sha, n: 2, observedAt: 1, review: null, sensitive: null, mandatory: null } : before,
        }),
        newRound,
        reviewArrived: false,
        gatesChanged: false,
        becameMergeable: false,
      }
    },
  })

  await h.watcher.tick('s') // t=1000 起等 SHA
  h.advance(cfg.roundTimeoutMs - 1000)
  currentSha = OTHER
  await h.watcher.tick('s') // 观测到新 sha：等待计时归零，不能立刻报超时
  assert.equal(h.notified.filter((text) => /评审超时/.test(text)).length, 0)

  h.advance(cfg.roundTimeoutMs)
  await h.watcher.tick('s')
  const wakes = h.notified.filter((text) => /评审超时/.test(text))
  assert.equal(wakes.length, 1)
  assert.match(wakes[0], new RegExp(`sha ${OTHER.slice(0, 8)}`))
})

test('gateSettleMs：评审已到、敏感门禁未出，窗口到点只唤醒一次「门禁未出」', async () => {
  const h = harness({
    mr: mrOf({ head_pipeline: { status: 'success', id: 9 } }),
    stateOver: {
      pipelineStatus: 'success',
      round: { sha: SHA, n: 1, observedAt: 1, review: { verdict: 'changes' }, sensitive: null, mandatory: { verdict: 'pass' } },
    },
    snapshot: pinnedSnapshot,
  })

  await h.watcher.tick('s')
  assert.equal(h.notified.length, 0)
  assert.equal(h.timers.at(-1).ms, cfg.pollSettleMs) // settle 窗口内仍用 pollSettleMs

  h.advance(cfg.gateSettleMs - 1)
  await h.watcher.tick('s')
  assert.equal(h.notified.filter((text) => /门禁未出/.test(text)).length, 0)

  h.advance(1)
  await h.watcher.tick('s')
  const wakes = h.notified.filter((text) => /门禁未出/.test(text))
  assert.equal(wakes.length, 1)
  assert.match(wakes[0], /3 分钟仍无结论（敏感）/)

  h.advance(cfg.gateSettleMs)
  await h.watcher.tick('s')
  assert.equal(h.notified.filter((text) => /门禁未出/.test(text)).length, 1)
})

test('gateSettleMs：敏感门禁已出、必过缺失 → 窗口关闭，不唤醒「门禁未出」', async () => {
  const h = harness({
    mr: mrOf({ head_pipeline: { status: 'success', id: 9 } }),
    stateOver: {
      pipelineStatus: 'success',
      round: { sha: SHA, n: 1, observedAt: 1, review: { verdict: 'changes' }, sensitive: { verdict: 'pass' }, mandatory: null },
    },
    snapshot: pinnedSnapshot,
  })

  await h.watcher.tick('s')
  assert.equal(h.timers.at(-1).ms, cfg.pollWatchingMs) // 敏感门禁已出：不进入 settle 窗口

  h.advance(cfg.gateSettleMs)
  await h.watcher.tick('s')
  h.advance(cfg.gateSettleMs)
  await h.watcher.tick('s')
  assert.equal(h.notified.filter((text) => /门禁未出/.test(text)).length, 0)
  assert.equal(h.timers.at(-1).ms, cfg.pollWatchingMs)
})

test('pollWatchingMs：评审与门禁都已出、不可合 → 用等新 sha 的间隔', async () => {
  const h = harness({
    mr: mrOf({ head_pipeline: { status: 'success', id: 9 } }),
    stateOver: {
      pipelineStatus: 'success',
      round: {
        sha: SHA, n: 1, observedAt: 1,
        review: { verdict: 'changes' },
        sensitive: { verdict: 'pass' },
        mandatory: { verdict: 'pass' },
      },
    },
    snapshot: pinnedSnapshot,
  })

  await h.watcher.tick('s')
  assert.equal(h.timers.length, 1)
  assert.equal(h.timers[0].ms, cfg.pollWatchingMs) // 60s，而不是恒定的 pollSettleMs
  assert.notEqual(cfg.pollWatchingMs, cfg.pollSettleMs)
})

test('轮询间隔：评审未出用 pollAwaitingMs，MR 没挂流水线用 pollNoPipelineMs', async () => {
  const awaiting = harness({ notes: [], snapshot: pinnedSnapshot })
  await awaiting.watcher.tick('s')
  assert.equal(awaiting.timers[0].ms, cfg.pollAwaitingMs)

  const noPipeline = harness({
    mr: mrOf({ head_pipeline: null }),
    stateOver: {
      round: {
        sha: SHA, n: 1, observedAt: 1,
        review: { verdict: 'pass' },
        sensitive: { verdict: 'pass' },
        mandatory: { verdict: 'pass' },
      },
    },
    snapshot: pinnedSnapshot,
  })
  await noPipeline.watcher.tick('s')
  assert.equal(noPipeline.timers[0].ms, cfg.pollNoPipelineMs)
})

// ---------------------------------------------------------------------------
// T1：MR 指令 → 已豁免不吵；唤醒去重 key 含评审 note.id + findings 签名
// ---------------------------------------------------------------------------

test('全部豁免 → 唤醒正文只有报告，不追加指令段与明细段', async () => {
  const h = harness({
    notes: [{ id: 1, body: 'AI Code Review' }],
    report: () => 'REPORT',
    snapshot: snapshotRound(
      {
        review: reviewOf([FINDING_AA, FINDING_BB]),
        directives: roundDirectives([waiverOf('aa', 'waive'), waiverOf('bb', 'wontfix')]),
      },
      { reviewArrived: true },
    ),
  })

  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1)
  assert.equal(h.notified[0], 'REPORT')
})

test('同一轮内容不变不重复唤醒；评审内容（findings 签名）变化才再唤醒', async () => {
  const changedLevel = { ...FINDING_AA, level: '高' }
  // 第一次：评审 note 100，aa 级别中；第二次：同 sha 同 note.id，findings 级别变高。
  const h = multiTick([{ review: reviewOf([FINDING_AA]) }, { review: reviewOf([changedLevel]) }])
  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1)

  h.advance(31000)
  await h.watcher.tick('s')
  // 内容变了：唤醒 key（含 findings 签名）不同 → 再唤醒一次。
  assert.equal(h.notified.length, 2)
  assert.match(h.notified[1], /问题明细：/)
})

test('唤醒去重 key 含 findings 签名：同 note.id、同内容 + 门禁翻面不重复唤醒', async () => {
  let call = 0
  const mrs = [mrOf({ user_notes_count: 2 }), mrOf({ user_notes_count: 3 }), mrOf({ user_notes_count: 4 })]
  const h = harness({
    mr: mrs[0],
    notes: [{ id: 1, body: 'AI Code Review' }],
    gitlabOver: { getMergeRequest: async () => mrs.shift() },
    snapshot: (input) => {
      // 第一次评审到达；第二次同内容但门禁翻面；第三次同内容、无事件。
      const flags = call === 0 ? { reviewArrived: true } : call === 1 ? { gatesChanged: true } : {}
      call += 1
      return snapshotRound({ review: reviewOf([FINDING_AA]) }, flags)(input)
    },
  })

  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1)

  h.advance(31000)
  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1) // 同 key：门禁翻面也不重复推

  h.advance(31000)
  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1) // 无事件：更不该推
})

test('同 sha 上因评论触发的新评审（note.id 变）能再次唤醒', async () => {
  const h = multiTick([
    { review: reviewOf([FINDING_AA]) },
    { review: reviewOf([FINDING_AA], { noteId: 101 }) },
  ])
  await h.watcher.tick('s')
  assert.equal(h.notified.length, 1)
  assert.equal(h.notified[0].startsWith('有 1 处评审问题待处置（FID aa（中））'), true)

  h.advance(31000)
  await h.watcher.tick('s')
  assert.equal(h.notified.length, 2)
  assert.match(h.notified[1], /问题 1\/1 · FID aa · 中 · 逻辑错误 · src\/a\.ts:10-20/)
})

test('明细段：问题/建议单行化并截断 ≤200 字，第三方文本不能改写段结构', async () => {
  const h = harness({
    notes: [{ id: 1, body: 'AI Code Review' }],
    report: () => 'REPORT',
    snapshot: snapshotRound(
      {
        review: reviewOf([{
          ...FINDING_AA,
          problem: `第一行\n第二行 ${'x'.repeat(400)}`,
          suggestion: `建议\n改法 ${'y'.repeat(400)}`,
        }]),
      },
      { reviewArrived: true },
    ),
  })

  await h.watcher.tick('s')
  const text = h.notified[0]
  // 换行被压成空格：明细段行数固定，不会被 note 内容插入新行。
  assert.match(text, /  问题：第一行 第二行 x+…\n  建议：建议 改法 y+…\n  复验次数：2$/)
  const problemLine = text.split('\n').find((line) => line.startsWith('  问题：'))
  assert.equal(problemLine.length, '  问题：'.length + 200)
  assert.equal(problemLine.endsWith('…'), true)
})

// ---------------------------------------------------------------------------
// #8 / #6：唤醒里的指令计数只算命中本轮、无效指令只提示 count
// ---------------------------------------------------------------------------

test('#8：「已收到 M 条 MR 指令」用真正命中本轮的豁免条数，不是指令总数', async () => {
  const h = harness({
    notes: [{ id: 1, body: 'AI Code Review' }],
    report: () => 'REPORT',
    snapshot: snapshotRound(
      {
        review: reviewOf([FINDING_AA, FINDING_BB]),
        // 第二条指令属于旧问题（FID 不在本轮 review）：计入 directive 总数，但不是本轮豁免。
        directives: roundDirectives([waiverOf('aa'), waiverOf('zzzz9999')]),
      },
      { reviewArrived: true },
    ),
  })
  await h.watcher.tick('s')
  const text = h.notified[0]
  assert.match(text, /已收到 1 条 MR 指令/)
  assert.doesNotMatch(text, /已收到 2 条/)
})

test('#6：唤醒里提示无效指令条数（只给 count），待处置计数不受影响', async () => {
  const h = harness({
    notes: [{ id: 1, body: 'AI Code Review' }],
    report: () => 'REPORT',
    snapshot: snapshotRound(
      {
        review: reviewOf([FINDING_AA]),
        directives: roundDirectives([], {
          invalid: { count: 3, samples: [{ noteId: 9, line: 1, why: 'invalid-fid' }] },
        }),
      },
      { reviewArrived: true },
    ),
  })
  await h.watcher.tick('s')
  const text = h.notified[0]
  assert.match(text, /有 1 处评审问题待处置/)
  assert.match(text, /另有 3 条 #ai-\* 指令格式不对，未生效。/)
})
