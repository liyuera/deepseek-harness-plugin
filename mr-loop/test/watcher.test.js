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

function harness({ mr = mrOf(), notes = [], stateOver = {} } = {}) {
  const notified = []
  const calls = { mr: 0, notes: 0 }
  let state = {
    sessionId: 's', binding: { projectPath: 'group/project', iid: 240 },
    mr, round: { sha: SHA, n: 1, observedAt: 1, review: null, sensitive: null, mandatory: null },
    mergeability: { mergeable: false, missing: [], degraded: false }, paused: null,
    notesCount: 2, pipelineStatus: null, startedAt: 0, lastProgressAt: 0,
    stallStreak: 0, reverifyStreak: 0, stallKey: '', rounds: [], decisions: {}, ...stateOver,
  }
  const service = {
    getState: () => state,
    report: () => 'REPORT',
    // 只为测试用的最小快照语义：拉过 notes 才算「有新评审」，否则保持原样。
    applySnapshot: ({ mr: nextMr, notes: fetched }) => {
      const hadReview = state.round.review !== null && state.round.review !== undefined
      state = {
        ...state,
        mr: nextMr,
        notesCount: nextMr.user_notes_count,
        round: { ...state.round, review: fetched === undefined ? state.round.review : { verdict: 'pass' } },
      }
      return { state, newRound: false, reviewArrived: fetched !== undefined && !hadReview, becameMergeable: false }
    },
    pause: ({ reason }) => { state = { ...state, paused: { reason, at: 'now' } }; return state },
  }
  const gitlab = {
    getMergeRequest: async () => { calls.mr += 1; return mr },
    listNotes: async () => { calls.notes += 1; return notes },
  }
  const watcher = createWatcher({
    cfg, gitlab, service,
    notify: ({ text }) => notified.push(text),
    now: () => 1000,
    setTimer: () => 1,
    clearTimer: () => {},
  })
  return { watcher, service, notified, calls, getState: () => state }
}

test('每 tick 只发 1 个请求；有评审变化才拉 notes 并唤醒', async () => {
  const h = harness({ notes: [{ id: 1, body: 'AI Code Review' }] })
  await h.watcher.tick('s')
  assert.equal(h.calls.mr, 1)
  assert.equal(h.calls.notes, 1)
  assert.equal(h.notified.length, 1)
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
})

test('没有绑定 → 直接退出，不发请求', async () => {
  const h = harness({ stateOver: { sessionId: undefined } })
  h.service.getState = () => null
  await h.watcher.tick('s')
  assert.equal(h.calls.mr, 0)
})
