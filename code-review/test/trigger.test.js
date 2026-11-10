import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldReview } from '../src/host/trigger.js'

const base = {
  config: { enabled: true, auto: true, maxRounds: 2 },
  origin: undefined, reviewing: false, rounds: 0, hasChanges: true, breakerOpen: false,
}

test('正常情况放行', () => {
  assert.deepEqual(shouldReview(base), { review: true, reason: 'ok' })
})

test('逐条拒绝并给出原因', () => {
  const cases = [
    [{ config: { enabled: false } }, 'disabled'],
    [{ config: { auto: false } }, 'manual-only'],
    [{ origin: 'subagent' }, 'subagent'],
    [{ reviewing: true }, 'reviewing'],
    [{ rounds: 2 }, 'rounds-exhausted'],
    [{ hasChanges: false }, 'no-changes'],
    [{ breakerOpen: true }, 'breaker-open'],
  ]
  for (const [patch, reason] of cases) {
    const input = {
      ...base,
      ...patch,
      ...(patch.config === undefined ? {} : { config: { ...base.config, ...patch.config } }),
    }
    assert.deepEqual(shouldReview(input), { review: false, reason }, reason)
  }
})
