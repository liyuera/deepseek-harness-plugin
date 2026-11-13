import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateMergeable } from '../src/host/mergeable.js'

const mr = (over = {}) => ({ state: 'opened', draft: false, has_conflicts: false, detailed_merge_status: 'mergeable', ...over })
const round = (over = {}) => ({
  binding: 'strong',
  review: { verdict: 'pass', blocking: [], nonBlocking: [] },
  sensitive: { verdict: 'pass' },
  mandatory: null,
  ...over,
})

test('全绿 → 可合并', () => {
  const r = evaluateMergeable({ mr: mr(), round: round(), decisions: {} })
  assert.equal(r.mergeable, true)
  assert.deepEqual(r.missing, [])
  assert.equal(r.degraded, false)
})

test('强绑定 + pass → 可合并', () => {
  const r = evaluateMergeable({ mr: mr(), round: round({ binding: 'strong' }), decisions: {} })
  assert.equal(r.mergeable, true)
  assert.deepEqual(r.missing, [])
})

test('弱绑定 + pass → 不可合并，要求人工确认', () => {
  const r = evaluateMergeable({ mr: mr(), round: round({ binding: 'weak' }), decisions: {} })
  assert.equal(r.mergeable, false)
  assert.deepEqual(r.missing, ['AI 评审为弱绑定（无 SHA 证明），需人工确认'])
})

test('评审 changes / 敏感未过 / 冲突 / 合并态不许', () => {
  assert.equal(evaluateMergeable({ mr: mr(), round: round({ review: { verdict: 'changes', blocking: [], nonBlocking: [] } }), decisions: {} }).mergeable, false)
  assert.equal(evaluateMergeable({ mr: mr(), round: round({ sensitive: { verdict: 'block' } }), decisions: {} }).mergeable, false)
  assert.equal(evaluateMergeable({ mr: mr({ has_conflicts: true }), round: round(), decisions: {} }).mergeable, false)
  assert.equal(evaluateMergeable({ mr: mr({ blocking_discussions_resolved: false }), round: round(), decisions: {} }).mergeable, false)
  assert.equal(evaluateMergeable({ mr: mr({ detailed_merge_status: 'ci_must_pass' }), round: round(), decisions: {} }).mergeable, false)
})

test('pass 但仍有阻塞项 → 只有豁免过才可合并', () => {
  const blocking = [{ fid: 'aa', level: '中' }, { fid: 'bb', level: '低' }]
  const r1 = evaluateMergeable({ mr: mr(), round: round({ review: { verdict: 'pass', blocking, nonBlocking: [] } }), decisions: {} })
  assert.equal(r1.mergeable, false)
  assert.equal(r1.missing.length, 1)
  assert.match(r1.missing[0], /2 条阻塞/)
  const r2 = evaluateMergeable({ mr: mr(), round: round({ review: { verdict: 'pass', blocking, nonBlocking: [] } }), decisions: { aa: { kind: 'waive' }, bb: { kind: 'skip' } } })
  assert.equal(r2.mergeable, true)
  // 中间态不是处置记录：只要账本里出现 fix / pending / 未知 kind 就 fail-open，只有三种终结算数。
  const notDisposed = (decisions) => evaluateMergeable({ mr: mr(), round: round({ review: { verdict: 'pass', blocking, nonBlocking: [] } }), decisions })
  assert.equal(notDisposed({ aa: { kind: 'fix' }, bb: { kind: 'wontfix' } }).mergeable, false)
  assert.equal(notDisposed({ aa: { kind: 'pending' }, bb: { kind: 'waive' } }).mergeable, false)
  assert.equal(notDisposed({ aa: { kind: 'wontfix-later' }, bb: { kind: 'skip' } }).mergeable, false)
})

test('必过项只在有本轮结论时计入', () => {
  assert.equal(evaluateMergeable({ mr: mr(), round: round({ mandatory: { verdict: 'block' } }), decisions: {} }).mergeable, false)
  assert.equal(evaluateMergeable({ mr: mr(), round: round({ mandatory: { verdict: 'pass' } }), decisions: {} }).mergeable, true)
  assert.equal(evaluateMergeable({ mr: mr(), round: round({ mandatory: null }), decisions: {} }).mergeable, true)
})

test('缺 detailed_merge_status → 降级到 merge_status 并标注', () => {
  const r = evaluateMergeable({ mr: { state: 'opened', draft: false, has_conflicts: false, merge_status: 'can_be_merged' }, round: round(), decisions: {} })
  assert.equal(r.mergeable, true)
  assert.equal(r.degraded, true)
  const r2 = evaluateMergeable({ mr: { state: 'opened', draft: false, has_conflicts: false, merge_status: 'cannot_be_merged' }, round: round(), decisions: {} })
  assert.equal(r2.mergeable, false)
})

test('降级判定的 head pipeline：failed / running 拦，success / 无流水线不拦', () => {
  const degradedMr = (over = {}) => ({ state: 'opened', draft: false, has_conflicts: false, merge_status: 'can_be_merged', ...over })

  const failed = evaluateMergeable({ mr: degradedMr({ head_pipeline: { status: 'failed' } }), round: round(), decisions: {} })
  assert.equal(failed.mergeable, false)
  assert.deepEqual(failed.missing, ['流水线未通过（failed）'])

  const running = evaluateMergeable({ mr: degradedMr({ head_pipeline: { status: 'running' } }), round: round(), decisions: {} })
  assert.equal(running.mergeable, false)
  assert.deepEqual(running.missing, ['流水线未通过（running）'])

  const success = evaluateMergeable({ mr: degradedMr({ head_pipeline: { status: 'success' } }), round: round(), decisions: {} })
  assert.equal(success.mergeable, true)
  assert.deepEqual(success.missing, [])
  assert.equal(success.degraded, true)

  // 没有挂 CI 是文档里的合法路径：字段缺失 / null 都不能拦。
  assert.equal(evaluateMergeable({ mr: degradedMr(), round: round(), decisions: {} }).mergeable, true)
  assert.equal(evaluateMergeable({ mr: degradedMr({ head_pipeline: null }), round: round(), decisions: {} }).mergeable, true)
})
