import test from 'node:test'
import assert from 'node:assert/strict'
import { createTracker } from '../src/host/loop.js'

/** 可控时钟，advance 推进毫秒。 */
function clock(start = 1000) {
  let time = start
  return {
    now: () => time,
    advance: (ms) => {
      time += ms
    },
  }
}

test('begin 加锁并计轮，end 解锁后同一 turn 可再计一轮', () => {
  const tracker = createTracker()
  assert.equal(tracker.begin('s1', 1), true)
  assert.equal(tracker.begin('s1', 1), false)
  assert.equal(tracker.isReviewing('s1'), true)
  tracker.end('s1')
  assert.equal(tracker.begin('s1', 1), true)
  assert.equal(tracker.roundsOf('s1', 1), 2)
  assert.equal(tracker.roundsOf('s1', 9), 0)
})

test('连续两次失败打开熔断，成功清零', () => {
  const tracker = createTracker()
  assert.equal(tracker.recordFailure('s1'), false)
  assert.equal(tracker.recordFailure('s1'), true)
  assert.equal(tracker.isBreakerOpen('s1'), true)
  tracker.recordSuccess('s1')
  assert.equal(tracker.isBreakerOpen('s1'), false)
})

test('不同会话互不影响', () => {
  const tracker = createTracker()
  tracker.recordFailure('s1')
  tracker.recordFailure('s1')
  assert.equal(tracker.isBreakerOpen('s2'), false)
})

test('会话释放后状态清空', () => {
  const tracker = createTracker()
  tracker.begin('s1', 1)
  tracker.forget('s1')
  assert.equal(tracker.isReviewing('s1'), false)
  assert.equal(tracker.roundsOf('s1', 1), 0)
  assert.equal(tracker.begin('s1', 1), true)
})

test('两次失败后熔断打开', () => {
  const time = clock()
  const tracker = createTracker({ cooldownMs: 1000, now: time.now })
  assert.equal(tracker.recordFailure('s1'), false)
  assert.equal(tracker.recordFailure('s1'), true)
  assert.equal(tracker.isBreakerOpen('s1'), true)
})

test('冷却期结束前熔断仍然打开', () => {
  const time = clock()
  const tracker = createTracker({ cooldownMs: 1000, now: time.now })
  tracker.recordFailure('s1')
  tracker.recordFailure('s1')
  time.advance(999)
  assert.equal(tracker.isBreakerOpen('s1'), true)
})

test('冷却期结束后熔断关闭（半开）', () => {
  const time = clock()
  const tracker = createTracker({ cooldownMs: 1000, now: time.now })
  tracker.recordFailure('s1')
  tracker.recordFailure('s1')
  time.advance(1000)
  assert.equal(tracker.isBreakerOpen('s1'), false)
})

test('冷却期后再次失败会重新打开熔断', () => {
  const time = clock()
  const tracker = createTracker({ cooldownMs: 1000, now: time.now })
  tracker.recordFailure('s1')
  tracker.recordFailure('s1')
  time.advance(1000)
  assert.equal(tracker.isBreakerOpen('s1'), false)
  assert.equal(tracker.recordFailure('s1'), true)
  assert.equal(tracker.isBreakerOpen('s1'), true)
  time.advance(999)
  assert.equal(tracker.isBreakerOpen('s1'), true)
  time.advance(1)
  assert.equal(tracker.isBreakerOpen('s1'), false)
})

test('成功清除熔断状态', () => {
  const time = clock()
  const tracker = createTracker({ cooldownMs: 1000, now: time.now })
  tracker.recordFailure('s1')
  tracker.recordFailure('s1')
  assert.equal(tracker.isBreakerOpen('s1'), true)
  tracker.recordSuccess('s1')
  assert.equal(tracker.isBreakerOpen('s1'), false)
})

test('forget 同样清除熔断状态', () => {
  const time = clock()
  const tracker = createTracker({ cooldownMs: 1000, now: time.now })
  tracker.recordFailure('s1')
  tracker.recordFailure('s1')
  assert.equal(tracker.isBreakerOpen('s1'), true)
  tracker.forget('s1')
  assert.equal(tracker.isBreakerOpen('s1'), false)
})

test('abandonRound 回滚一轮且不出现负数', () => {
  const tracker = createTracker()
  assert.equal(tracker.begin('s1', 1), true)
  assert.equal(tracker.roundsOf('s1', 1), 1)
  tracker.abandonRound('s1', 1)
  assert.equal(tracker.roundsOf('s1', 1), 0)
  tracker.abandonRound('s1', 1)
  assert.equal(tracker.roundsOf('s1', 1), 0)
  tracker.end('s1')
  assert.equal(tracker.begin('s1', 1), true)
  assert.equal(tracker.roundsOf('s1', 1), 1)
  tracker.abandonRound('s1', 1)
  assert.equal(tracker.roundsOf('s1', 1), 0)
})

test('abandonRound 不释放 reviewing 锁', () => {
  const tracker = createTracker()
  tracker.begin('s1', 1)
  tracker.abandonRound('s1', 1)
  assert.equal(tracker.isReviewing('s1'), true)
  assert.equal(tracker.begin('s1', 2), false)
  tracker.end('s1')
  assert.equal(tracker.isReviewing('s1'), false)
})

test('abandonRound 不影响已打开的熔断', () => {
  const tracker = createTracker()
  assert.equal(tracker.recordFailure('s1'), false)
  assert.equal(tracker.recordFailure('s1'), true)
  assert.equal(tracker.isBreakerOpen('s1'), true)
  tracker.begin('s1', 1)
  tracker.abandonRound('s1', 1)
  assert.equal(tracker.isBreakerOpen('s1'), true)
  assert.equal(tracker.roundsOf('s1', 1), 0)
})
