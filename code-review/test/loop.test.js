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

test('begin 加锁并累计链轮次，end 后可继续累加', () => {
  const tracker = createTracker()
  assert.equal(tracker.begin('s1'), true)
  assert.equal(tracker.roundsOf('s1'), 1)
  assert.equal(tracker.isReviewing('s1'), true)
  tracker.end('s1')
  assert.equal(tracker.isReviewing('s1'), false)
  assert.equal(tracker.begin('s1'), true)
  assert.equal(tracker.roundsOf('s1'), 2)
  assert.equal(tracker.roundsOf('s2'), 0)
})

test('重复 begin（已锁）返回 false 且不增加轮次', () => {
  const tracker = createTracker()
  assert.equal(tracker.begin('s1'), true)
  assert.equal(tracker.begin('s1'), false)
  assert.equal(tracker.roundsOf('s1'), 1)
  assert.equal(tracker.isReviewing('s1'), true)
})

test('resetRounds 归零但锁仍在，且不影响熔断计数', () => {
  const tracker = createTracker()
  assert.equal(tracker.begin('s1'), true)
  assert.equal(tracker.roundsOf('s1'), 1)
  tracker.resetRounds('s1')
  assert.equal(tracker.roundsOf('s1'), 0)
  assert.equal(tracker.isReviewing('s1'), true)
  assert.equal(tracker.begin('s1'), false)
  tracker.end('s1')
  assert.equal(tracker.recordFailure('s1'), false)
  tracker.resetRounds('s1')
  assert.equal(tracker.recordFailure('s1'), true)
})

test('forget 清空轮次、锁与熔断状态', () => {
  const tracker = createTracker()
  assert.equal(tracker.begin('s1'), true)
  assert.equal(tracker.roundsOf('s1'), 1)
  assert.equal(tracker.recordFailure('s1'), false)
  assert.equal(tracker.recordFailure('s1'), true)
  assert.equal(tracker.isBreakerOpen('s1'), true)
  tracker.forget('s1')
  assert.equal(tracker.roundsOf('s1'), 0)
  assert.equal(tracker.isReviewing('s1'), false)
  assert.equal(tracker.isBreakerOpen('s1'), false)
  assert.equal(tracker.begin('s1'), true)
  assert.equal(tracker.roundsOf('s1'), 1)
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
