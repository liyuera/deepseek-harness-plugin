import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateMergeable } from '../src/host/mergeable.js'

const mr = (over = {}) => ({ state: 'opened', draft: false, has_conflicts: false, detailed_merge_status: 'mergeable', ...over })
const round = (over = {}) => ({
  binding: 'strong',
  review: { verdict: 'pass', blocking: [], nonBlocking: [], historicalUnresolved: 0 },
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

test('评审 changes / 敏感阻止 / 冲突 / 合并态不许', () => {
  const changes = { verdict: 'changes', blocking: [], nonBlocking: [], historicalUnresolved: 0 }
  assert.equal(evaluateMergeable({ mr: mr(), round: round({ review: changes }), decisions: {} }).mergeable, false)
  assert.equal(evaluateMergeable({ mr: mr(), round: round({ sensitive: { verdict: 'block' } }), decisions: {} }).mergeable, false)
  assert.equal(evaluateMergeable({ mr: mr({ has_conflicts: true }), round: round(), decisions: {} }).mergeable, false)
  assert.equal(evaluateMergeable({ mr: mr({ blocking_discussions_resolved: false }), round: round(), decisions: {} }).mergeable, false)
  assert.equal(evaluateMergeable({ mr: mr({ detailed_merge_status: 'ci_must_pass' }), round: round(), decisions: {} }).mergeable, false)
})

test('结论 pass + 0 findings + 历史未收敛 0 → 可合并', () => {
  const r = evaluateMergeable({ mr: mr(), round: round(), decisions: {} })
  assert.equal(r.mergeable, true)
  assert.deepEqual(r.missing, [])
})

test('结论 pass + 只有 1 条低/非阻塞建议未处置 → 不可合并（不再按分类放行）', () => {
  const review = {
    verdict: 'pass',
    blocking: [],
    nonBlocking: [{ fid: 'a1b2c3d4', level: '低', gateCategory: '非阻塞建议', reverifyCount: 1 }],
    historicalUnresolved: 0,
  }
  const r = evaluateMergeable({ mr: mr(), round: round({ review }), decisions: {} })
  assert.equal(r.mergeable, false)
  assert.equal(r.missing.length, 1)
  assert.match(r.missing[0], /评审有 1 处需要关注的问题/)
  assert.match(r.missing[0], /FID a1b2c3d4（低）/)
  assert.match(r.missing[0], /本轮新增/)
})

test('pass 但仍有未处置问题 → 只有豁免过才可合并', () => {
  const blocking = [{ fid: 'aa', level: '中' }, { fid: 'bb', level: '低' }]
  const review = { verdict: 'pass', blocking, nonBlocking: [], historicalUnresolved: 0 }
  const r1 = evaluateMergeable({ mr: mr(), round: round({ review }), decisions: {} })
  assert.equal(r1.mergeable, false)
  assert.equal(r1.missing.length, 1)
  assert.match(r1.missing[0], /评审有 2 处需要关注的问题（其中 2 处本轮新增）/)
  assert.match(r1.missing[0], /FID aa（中）、FID bb（低）/)
  const r2 = evaluateMergeable({ mr: mr(), round: round({ review }), decisions: { aa: { kind: 'waive' }, bb: { kind: 'skip' } } })
  assert.equal(r2.mergeable, true)
  // 中间态不是处置记录：只要账本里出现 fix / pending / 未知 kind 就 fail-closed，只有三种终结算数。
  const notDisposed = (decisions) => evaluateMergeable({ mr: mr(), round: round({ review }), decisions })
  assert.equal(notDisposed({ aa: { kind: 'fix' }, bb: { kind: 'wontfix' } }).mergeable, false)
  assert.equal(notDisposed({ aa: { kind: 'pending' }, bb: { kind: 'waive' } }).mergeable, false)
  assert.equal(notDisposed({ aa: { kind: 'wontfix-later' }, bb: { kind: 'skip' } }).mergeable, false)
})

test('豁免同时覆盖 blocking 与 nonBlocking：已处置即不拦', () => {
  const review = {
    verdict: 'pass',
    blocking: [{ fid: 'bb', level: '中', gateCategory: '逻辑错误', reverifyCount: 2 }],
    nonBlocking: [{ fid: 'cc', level: '低', gateCategory: '非阻塞建议', reverifyCount: 1 }],
    historicalUnresolved: 0,
  }
  const r = evaluateMergeable({ mr: mr(), round: round({ review }), decisions: { bb: { kind: 'wontfix' }, cc: { kind: 'waive' } } })
  assert.equal(r.mergeable, true)
  // 只处置其中一条仍然拦：任何未处置 finding 都是缺口。
  assert.equal(evaluateMergeable({ mr: mr(), round: round({ review }), decisions: { bb: { kind: 'wontfix' } } }).mergeable, false)
})

test('历史未收敛 > 0 → 不可合并；= 0 才放行', () => {
  const review = { verdict: 'pass', blocking: [], nonBlocking: [], historicalUnresolved: 2 }
  const r = evaluateMergeable({ mr: mr(), round: round({ review }), decisions: {} })
  assert.equal(r.mergeable, false)
  assert.equal(r.missing.length, 1)
  assert.match(r.missing[0], /历史未收敛问题 2 条/)
})

test('历史未收敛字段缺失（null）→ fail-closed，报告能看出是「未声明」', () => {
  for (const value of [undefined, null]) {
    const review = { verdict: 'pass', blocking: [], nonBlocking: [], historicalUnresolved: value }
    const r = evaluateMergeable({ mr: mr(), round: round({ review }), decisions: {} })
    assert.equal(r.mergeable, false)
    assert.deepEqual(r.missing, ['历史未收敛问题未声明'])
  }
})

test('本轮新增按复验次数判定：缺失 / <= 1 算本轮首次发现，>= 2 不算', () => {
  const review = {
    verdict: 'pass',
    blocking: [
      { fid: 'new1', level: '中', gateCategory: '逻辑错误', reverifyCount: 1 },
      { fid: 'new2', level: '低', gateCategory: '非阻塞建议' },
      { fid: 'old1', level: '中', gateCategory: '逻辑错误', reverifyCount: 2 },
    ],
    nonBlocking: [],
    historicalUnresolved: 0,
  }
  const r = evaluateMergeable({ mr: mr(), round: round({ review }), decisions: {} })
  assert.equal(r.mergeable, false)
  assert.match(r.missing[0], /评审有 3 处需要关注的问题（其中 2 处本轮新增）/)
})

test('三类缺口合成 1~2 条 missing：findings 一条、历史未收敛一条，不重复', () => {
  const review = {
    verdict: 'pass',
    blocking: [{ fid: 'a1b2c3d4', level: '低', gateCategory: '非阻塞建议', reverifyCount: 1 }],
    nonBlocking: [],
    historicalUnresolved: 1,
  }
  const r = evaluateMergeable({ mr: mr(), round: round({ review }), decisions: {} })
  assert.equal(r.mergeable, false)
  assert.equal(r.missing.length, 2)
  assert.match(r.missing[0], /评审有 1 处需要关注的问题（其中 1 处本轮新增）：FID a1b2c3d4（低）/)
  assert.match(r.missing[1], /历史未收敛问题 1 条/)
})

test('FID 最多列 3 个，其余用「等」收口', () => {
  const review = {
    verdict: 'pass',
    blocking: ['a', 'b', 'c', 'd'].map((fid) => ({ fid, level: '中', gateCategory: '逻辑错误', reverifyCount: 2 })),
    nonBlocking: [],
    historicalUnresolved: 0,
  }
  const r = evaluateMergeable({ mr: mr(), round: round({ review }), decisions: {} })
  assert.equal(r.mergeable, false)
  assert.match(r.missing[0], /FID a（中）、FID b（中）、FID c（中）等 4 处/)
  assert.doesNotMatch(r.missing[0], /FID d/)
})

test('敏感门禁只有「阻止合并」才拦：unknown / 无本轮结论都不拦', () => {
  const unknown = evaluateMergeable({ mr: mr(), round: round({ sensitive: { verdict: 'unknown' } }), decisions: {} })
  assert.equal(unknown.mergeable, true)
  assert.deepEqual(unknown.missing, [])

  const none = evaluateMergeable({ mr: mr(), round: round({ sensitive: null }), decisions: {} })
  assert.equal(none.mergeable, true)
  assert.deepEqual(none.missing, [])

  const block = evaluateMergeable({ mr: mr(), round: round({ sensitive: { verdict: 'block' } }), decisions: {} })
  assert.equal(block.mergeable, false)
  assert.deepEqual(block.missing, ['敏感内容门禁阻止合并'])
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

test('降级判定的 head pipeline：failed / canceled 未通过，running / pending 未完成，success / 无流水线不拦', () => {
  const degradedMr = (over = {}) => ({ state: 'opened', draft: false, has_conflicts: false, merge_status: 'can_be_merged', ...over })

  const failed = evaluateMergeable({ mr: degradedMr({ head_pipeline: { status: 'failed' } }), round: round(), decisions: {} })
  assert.equal(failed.mergeable, false)
  assert.deepEqual(failed.missing, ['流水线未通过（failed）'])

  const canceled = evaluateMergeable({ mr: degradedMr({ head_pipeline: { status: 'canceled' } }), round: round(), decisions: {} })
  assert.equal(canceled.mergeable, false)
  assert.deepEqual(canceled.missing, ['流水线未通过（canceled）'])

  const running = evaluateMergeable({ mr: degradedMr({ head_pipeline: { status: 'running' } }), round: round(), decisions: {} })
  assert.equal(running.mergeable, false)
  assert.deepEqual(running.missing, ['流水线未完成（running）'])

  const pending = evaluateMergeable({ mr: degradedMr({ head_pipeline: { status: 'pending' } }), round: round(), decisions: {} })
  assert.equal(pending.mergeable, false)
  assert.deepEqual(pending.missing, ['流水线未完成（pending）'])

  const success = evaluateMergeable({ mr: degradedMr({ head_pipeline: { status: 'success' } }), round: round(), decisions: {} })
  assert.equal(success.mergeable, true)
  assert.deepEqual(success.missing, [])
  assert.equal(success.degraded, true)

  // 没有挂 CI 是文档里的合法路径：字段缺失 / null 都不能拦。
  assert.equal(evaluateMergeable({ mr: degradedMr(), round: round(), decisions: {} }).mergeable, true)
  assert.equal(evaluateMergeable({ mr: degradedMr({ head_pipeline: null }), round: round(), decisions: {} }).mergeable, true)
})
