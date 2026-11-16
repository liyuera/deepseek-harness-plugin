import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateGuards } from '../src/host/guards.js'
import { resolveConfig } from '../src/host/config.js'

const cfg = resolveConfig({})
const base = { startedAt: 0, lastProgressAt: 0, stallStreak: 0, reverifyStreak: 0 }

test('无触发 → null', () => {
  assert.equal(evaluateGuards({ state: base, now: 1000, cfg }), null)
})

test('空闲 / 预算 / 阻塞不变 / 复验递增', () => {
  assert.equal(evaluateGuards({ state: { ...base, lastProgressAt: 0 }, now: cfg.idleStopMs + 1, cfg })?.reason, 'idle')
  assert.equal(evaluateGuards({ state: { ...base, startedAt: 0, lastProgressAt: cfg.wallClockMs + 1 }, now: cfg.wallClockMs + 2, cfg })?.reason, 'budget')
  assert.equal(evaluateGuards({ state: { ...base, stallStreak: cfg.stallRounds }, now: 1, cfg })?.reason, 'stalled')
  assert.equal(evaluateGuards({ state: { ...base, reverifyStreak: cfg.reverifyStreak }, now: 1, cfg })?.reason, 'stalled')
})

test('轮次上限只在 maxRounds > 0 时生效', () => {
  const capped = resolveConfig({ maxRounds: 2 })
  // 真实的 service state 里 rounds 是历次轮次数组（service.js），所以这里用数组而不是数字。
  assert.equal(evaluateGuards({ state: { ...base, rounds: [{ n: 1 }, { n: 2 }] }, now: 1, cfg: capped })?.reason, 'stalled')
  assert.equal(evaluateGuards({ state: { ...base, rounds: Array.from({ length: 99 }, (_, index) => ({ n: index + 1 })) }, now: 1, cfg }), null)
})
