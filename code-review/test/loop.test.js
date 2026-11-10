import test from 'node:test'
import assert from 'node:assert/strict'
import { createTracker } from '../src/host/loop.js'

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
