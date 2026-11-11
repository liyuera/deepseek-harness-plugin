import assert from 'node:assert/strict'
import test from 'node:test'
import {
  annotateRepeats,
  LEDGER_WINDOW,
  notObservedFindings,
  RESOLVE_AFTER_MISSES,
  summarizeRecords,
} from '../src/host/ledger.js'
import { formatJournal } from '../src/host/journal.js'

const record = (startedAt, findings, over = {}) => ({
  sessionId: 's1',
  turn: startedAt,
  mode: 'turn',
  startedAt,
  finishedAt: startedAt + 1,
  status: 'completed',
  reason: null,
  findingsTotal: Array.isArray(findings) ? findings.length : 0,
  findings: findings ?? [],
  injected: true,
  ...over,
})

const finding = (over = {}) => ({
  ruleId: 'COR-001',
  dimension: 'correctness',
  severity: 'high',
  location: 'src/a.ts:1',
  problem: '问题',
  fingerprint: 'fp-1',
  ...over,
})

test('annotateRepeats 无历史时原样返回', () => {
  const findings = [finding()]
  const annotated = annotateRepeats(findings, [])
  assert.deepEqual(annotated, findings)
  assert.equal('repeats' in annotated[0], false)
})

test('annotateRepeats 历史出现次数决定 repeats，firstSeenAt 取最早一轮', () => {
  const prior = [
    record(100, [finding({ fingerprint: 'fp-1' })]),
    record(200, [finding({ fingerprint: 'fp-1' })]),
  ]
  const [annotated] = annotateRepeats([finding()], prior)
  assert.equal(annotated.repeats, 3)
  assert.equal(annotated.firstSeenAt, 100)
})

test('annotateRepeats 只统计 completed，且无 fingerprint 的记录/条目被忽略', () => {
  const prior = [
    record(100, [finding({ fingerprint: 'fp-1' })]),
    record(200, [{ ...finding({ fingerprint: 'fp-1' }) }], { status: 'running' }),
    record(300, [finding({ fingerprint: '' })]),
    { sessionId: 's1', status: 'completed', findings: undefined, startedAt: 400 },
  ]
  const [annotated] = annotateRepeats([finding()], prior)
  assert.equal(annotated.repeats, 2)
  assert.equal(annotated.firstSeenAt, 100)
})

test('notObservedFindings 连续缺席达到阈值才列出，本轮仍跟踪的排除', () => {
  const prior = [
    record(300, [finding({ fingerprint: 'fp-b' })]),
    record(200, [finding({ fingerprint: 'fp-a' })]),
    record(100, [finding({ fingerprint: 'fp-a' })]),
  ]
  // fp-a 最近一次在 200（新一轮 300 与当前轮都缺席）→ missedRuns=2，列出；
  // fp-b 最近一次在 300（当前轮缺席）→ missedRuns=1，不列出。
  const unresolved = notObservedFindings(prior, new Set())
  assert.deepEqual(unresolved.map((item) => item.fingerprint), ['fp-a'])
  assert.equal(unresolved[0].missedRuns, RESOLVE_AFTER_MISSES)
})

test('notObservedFindings 本轮仍跟踪或已抑制的指纹不算未再见', () => {
  const prior = [
    record(200, [finding({ fingerprint: 'fp-a' })]),
    record(100, [finding({ fingerprint: 'fp-a' })]),
  ]
  assert.deepEqual(notObservedFindings(prior, new Set(['fp-a'])), [])
})

test('notObservedFindings 只看最近一次出现，不重复计数', () => {
  const prior = [
    record(300, []),
    record(200, [finding({ fingerprint: 'fp-a' })]),
    record(100, [finding({ fingerprint: 'fp-a' })]),
  ]
  const unresolved = notObservedFindings(prior, new Set())
  assert.equal(unresolved.length, 1)
  assert.equal(unresolved[0].missedRuns, 2)
})

test('summarizeRecords 汇总完成/未结论、findings、覆盖、复验与抑制', () => {
  const records = [
    record(100, [finding()], {
      findingsTotal: 2,
      coverage: { valid: true, reviewed: 2, skipped: 1, unaccounted: 0 },
      verification: { checked: 2, confirmed: 1, rejected: 1, unverified: 0 },
      suppressed: 1,
    }),
    { ...record(200, [], { findingsTotal: 0 }), status: 'cancelled' },
  ]
  assert.deepEqual(summarizeRecords(records), {
    total: 2,
    completed: 1,
    incomplete: 1,
    findings: 2,
    suppressed: 1,
    coverageReviewed: 2,
    coverageSkipped: 1,
    verificationChecked: 2,
    verificationConfirmed: 1,
  })
  assert.equal(LEDGER_WINDOW > 0, true)
})

test('formatJournal 带近期汇总行，老记录缺字段也不抛', () => {
  const text = formatJournal([
    record(100, [finding()], {
      findingsTotal: 1,
      verification: { checked: 1, confirmed: 1, rejected: 0, unverified: 0 },
    }),
    record(50, []),
  ])
  assert.match(text, /近期: 完成 2\/2/)
  assert.match(text, /findings 1/)
  assert.match(text, /复验确认 1\/1/)
})
