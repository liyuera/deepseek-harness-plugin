import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateMergeable } from '../src/host/mergeable.js'
// 命名空间导入：reviewTodo 缺失时是测试体失败，而不是整个文件在 import 阶段就报错。
import * as mergeable from '../src/host/mergeable.js'

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
  // changes 且没有任何 finding：按 I3 口径 verdict 不再单独拦（真实模板不会产出这种评审）。
  const emptyChanges = { verdict: 'changes', blocking: [], nonBlocking: [], historicalUnresolved: 0 }
  assert.equal(evaluateMergeable({ mr: mr(), round: round({ review: emptyChanges }), decisions: {} }).mergeable, true)
  const changes = { verdict: 'changes', blocking: [{ fid: 'aa', level: '中' }], nonBlocking: [], historicalUnresolved: 0 }
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
  assert.match(r1.missing[0], /评审有 2 处需要关注的问题（其中 2 处本轮新增未处置）/)
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
  assert.match(r.missing[0], /评审有 3 处需要关注的问题（其中 2 处本轮新增未处置）/)
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
  assert.match(r.missing[0], /评审有 1 处需要关注的问题（其中 1 处本轮新增未处置）：FID a1b2c3d4（低）/)
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

// ---------------------------------------------------------------------------
// reviewTodo：报告与唤醒共用的未处置 finding 口径
// ---------------------------------------------------------------------------

const todoRound = (review) => ({ review })

test('reviewTodo：total / fresh / fids 口径一致，fids 最多 3 个', () => {
  const review = {
    verdict: 'changes',
    blocking: [
      { fid: 'a1b2c3d4', level: '中', gateCategory: '逻辑错误', reverifyCount: 1 },
      { fid: 'b2c3d4e5', level: '低', gateCategory: '非阻塞建议' },
      { fid: 'c3d4e5f6', level: '中', gateCategory: '逻辑错误', reverifyCount: 2 },
    ],
    nonBlocking: [{ fid: 'd4e5f6a7', level: '低', gateCategory: '非阻塞建议', reverifyCount: 1 }],
    historicalUnresolved: 0,
  }
  const todo = mergeable.reviewTodo(todoRound(review), {})
  assert.equal(todo.total, 4)
  // 复验次数缺失（b2c3d4e5）或 <= 1（a1b2c3d4 / d4e5f6a7）算本轮新增。
  assert.equal(todo.fresh, 3)
  assert.deepEqual(todo.fids, ['FID a1b2c3d4（中）', 'FID b2c3d4e5（低）', 'FID c3d4e5f6（中）'])
})

test('reviewTodo：只有 waive / skip / wontfix 终结；fix / pending / 未知 kind 仍计入', () => {
  const review = {
    verdict: 'changes',
    blocking: [
      { fid: 'aa', level: '中' },
      { fid: 'bb', level: '低' },
      { fid: 'cc', level: '低' },
      { fid: 'dd', level: '低' },
    ],
    nonBlocking: [],
    historicalUnresolved: 0,
  }
  const waived = mergeable.reviewTodo(todoRound(review), {
    aa: { kind: 'waive' },
    bb: { kind: 'skip' },
    cc: { kind: 'wontfix' },
    dd: { kind: 'fix' },
  })
  // fresh 是全部 finding 口径：aa/bb/cc/dd 都没有复验次数 → 4 条都算本轮新增。
  assert.deepEqual(waived, { total: 1, fresh: 4, fids: ['FID dd（低）'], waived: [] })

  const pending = mergeable.reviewTodo(todoRound(review), {
    aa: { kind: 'pending' },
    bb: { kind: 'fix' },
    cc: { kind: 'unknown' },
  })
  assert.equal(pending.total, 4)
})

test('reviewTodo：无评审 / 无 finding → 零值，fids 为空', () => {
  assert.deepEqual(mergeable.reviewTodo(null, {}), { total: 0, fresh: 0, fids: [], waived: [] })
  assert.deepEqual(
    mergeable.reviewTodo(todoRound({ verdict: 'pass', blocking: [], nonBlocking: [] }), {}),
    { total: 0, fresh: 0, fids: [], waived: [] },
  )
})

// ---------------------------------------------------------------------------
// T1：MR 指令（#ai-waive / #ai-skip / #ai-wontfix）也计入已处置
// ---------------------------------------------------------------------------

/** 带指令的 round：结构同 buildRound 输出的 round.directives。 */
const directiveRound = (review, directives) => ({
  review,
  directives: {
    directives,
    directiveNotes: [],
    invalid: { count: 0, samples: [] },
    truncated: { directives: 0, directiveNotes: 0, notes: 0, lines: 0 },
  },
})
const directive = (fid, kind = 'waive', over = {}) => ({ fid, kind, reason: `${kind} 原因`, noteId: 75200, ...over })

test('isDisposedFinding：账本 decision 或 round 指令任一命中即已处置（FID 大小写不敏感）', () => {
  const round = directiveRound({ verdict: 'pass', blocking: [{ fid: 'a1b2c3d4' }], nonBlocking: [] }, [directive('A1B2C3D4')])
  assert.equal(mergeable.isDisposedFinding(round, {}, 'a1b2c3d4'), true)
  assert.equal(mergeable.isDisposedFinding(round, {}, 'bb'), false)
  assert.equal(mergeable.isDisposedFinding(round, { bb: { kind: 'skip' } }, 'bb'), true)
  // 中间态 / 未知 kind 不算处置（与账本口径一致，fail-closed）。
  assert.equal(mergeable.isDisposedFinding(round, { bb: { kind: 'fix' } }, 'bb'), false)
  // 账本 key 的大小写也不敏感：同一 FID 换个大小写写进账本仍然算处置。
  assert.equal(mergeable.isDisposedFinding(round, { A1B2C3D4: { kind: 'wontfix' } }, 'a1b2c3d4'), true)
  assert.equal(mergeable.isDisposedFinding({}, {}, 'aa'), false)
  assert.equal(mergeable.isDisposedFinding(null, {}, 'aa'), false)
})

test('reviewTodo：指令处置后 total/fids 只算剩余，waived 带出指令来源', () => {
  const review = {
    verdict: 'pass',
    blocking: [
      { fid: 'aa', level: '中', gateCategory: '逻辑错误', reverifyCount: 1 },
      { fid: 'bb', level: '低', gateCategory: '非阻塞建议', reverifyCount: 2 },
    ],
    nonBlocking: [],
    historicalUnresolved: 0,
  }
  const round = directiveRound(review, [directive('aa', 'waive', { reason: '风险已评估' })])
  assert.deepEqual(mergeable.reviewTodo(round, {}), {
    total: 1,
    // fresh 统一为「全部 finding 的本轮新增」口径（含已豁免），报告与合并缺口共用。
    fresh: 1,
    fids: ['FID bb（低）'],
    waived: [{ fid: 'aa', kind: 'waive', reason: '风险已评估', noteId: 75200 }],
  })
})

test('reviewTodo：全部豁免 → 零未处置，waived 保留全部指令（按 finding 顺序）', () => {
  const review = {
    verdict: 'pass',
    blocking: [{ fid: 'bb', level: '低' }],
    nonBlocking: [{ fid: 'aa', level: '低' }],
    historicalUnresolved: 0,
  }
  const round = directiveRound(review, [directive('aa', 'skip'), directive('bb', 'wontfix')])
  assert.deepEqual(mergeable.reviewTodo(round, {}), {
    total: 0,
    fresh: 2,
    fids: [],
    waived: [
      { fid: 'bb', kind: 'wontfix', reason: 'wontfix 原因', noteId: 75200 },
      { fid: 'aa', kind: 'skip', reason: 'skip 原因', noteId: 75200 },
    ],
  })
})

test('reviewTodo：指令与账本处置叠加计数一致；waived 只来自指令', () => {
  const review = {
    verdict: 'pass',
    blocking: [
      { fid: 'aa', level: '中', reverifyCount: 1 },
      { fid: 'bb', level: '低', reverifyCount: 1 },
      { fid: 'cc', level: '低', reverifyCount: 2 },
    ],
    nonBlocking: [],
    historicalUnresolved: 0,
  }
  const round = directiveRound(review, [directive('aa')])
  const todo = mergeable.reviewTodo(round, { bb: { kind: 'skip' } })
  assert.equal(todo.total, 1)
  // fresh 用全部 finding 口径：aa/bb 复验 1 算本轮新增，cc 复验 2 不算 → 2。
  assert.equal(todo.fresh, 2)
  assert.deepEqual(todo.fids, ['FID cc（低）'])
  assert.deepEqual(todo.waived, [{ fid: 'aa', kind: 'waive', reason: 'waive 原因', noteId: 75200 }])
})

test('reviewTodo：waived 只列本轮 review 里真实存在的 FID（旧轮指令不冒充豁免）', () => {
  const review = {
    verdict: 'pass',
    blocking: [{ fid: 'aa', level: '中' }],
    nonBlocking: [],
    historicalUnresolved: 0,
  }
  const round = directiveRound(review, [directive('zzzz9999'), directive('aa')])
  const todo = mergeable.reviewTodo(round, {})
  assert.equal(todo.total, 0)
  assert.deepEqual(todo.waived.map((item) => item.fid), ['aa'])
})

test('evaluateMergeable：指令豁免后不再拦合并；部分豁免只拦剩余', () => {
  const review = {
    verdict: 'pass',
    blocking: [{ fid: 'aa', level: '中' }, { fid: 'bb', level: '低' }],
    nonBlocking: [],
    historicalUnresolved: 0,
  }
  const partial = directiveRound(review, [directive('aa', 'wontfix')])
  const blocked = evaluateMergeable({ mr: mr(), round: round({ review, ...partial }), decisions: {} })
  assert.equal(blocked.mergeable, false)
  assert.equal(blocked.missing.length, 1)
  assert.match(blocked.missing[0], /评审有 1 处需要关注的问题/)
  assert.match(blocked.missing[0], /FID bb（低）/)
  assert.doesNotMatch(blocked.missing[0], /FID aa/)

  const allWaived = directiveRound(review, [directive('aa', 'wontfix'), directive('bb', 'skip')])
  const merged = evaluateMergeable({ mr: mr(), round: round({ review, ...allWaived }), decisions: {} })
  assert.equal(merged.mergeable, true)
  assert.deepEqual(merged.missing, [])

  // 指令 + 账本各豁免一条，叠加后同样放行。
  const combined = evaluateMergeable({
    mr: mr(),
    round: round({ review, ...directiveRound(review, [directive('aa')]) }),
    decisions: { bb: { kind: 'skip' } },
  })
  assert.equal(combined.mergeable, true)
})

test('evaluateMergeable：有指令时「需要关注 / 本轮新增」只统计未处置项', () => {
  const review = {
    verdict: 'pass',
    blocking: [
      { fid: 'aa', level: '中', reverifyCount: 1 }, // 已豁免且是本轮新增：进 fresh，但不进缺口
      { fid: 'bb', level: '高', reverifyCount: 2 }, // 未处置、旧问题
      { fid: 'cc', level: '低', reverifyCount: 1 }, // 未处置、本轮新增
    ],
    nonBlocking: [],
    historicalUnresolved: 0,
  }
  const r = evaluateMergeable({
    mr: mr(),
    round: round({ review, ...directiveRound(review, [directive('aa')]) }),
    decisions: {},
  })
  assert.equal(r.mergeable, false)
  // fresh 统一为全部 finding：aa（已豁免）与 cc 都算本轮新增 → 2。
  assert.match(r.missing[0], /评审有 2 处需要关注的问题（其中 1 处本轮新增未处置）：FID bb（高）、FID cc（低）/)
  assert.doesNotMatch(r.missing[0], /FID aa/)
})

// ---------------------------------------------------------------------------
// I3：verdict=changes 但问题已全部豁免 → 不再因 verdict 拦合并
// ---------------------------------------------------------------------------

const changesReview = (blocking, over = {}) => ({
  verdict: 'changes', blocking, nonBlocking: [], historicalUnresolved: 0, ...over,
})

test('I3：changes + 问题全被指令豁免 + 历史未收敛 0 → 可合；报告口径另测', () => {
  const review = changesReview([{ fid: 'aa', level: '中', reverifyCount: 1 }, { fid: 'bb', level: '低', reverifyCount: 1 }])
  const roundWithWaivers = round({ review, ...directiveRound(review, [directive('aa'), directive('bb', 'wontfix')]) })
  const r = evaluateMergeable({ mr: mr(), round: roundWithWaivers, decisions: {} })
  assert.equal(r.mergeable, true)
  assert.deepEqual(r.missing, [])

  // 账本处置同样算「已处置」：changes + 全部 waive 也能放行。
  const byLedger = evaluateMergeable({
    mr: mr(),
    round: round({ review, ...directiveRound(review, []) }),
    decisions: { aa: { kind: 'waive' }, bb: { kind: 'skip' } },
  })
  assert.equal(byLedger.mergeable, true)
})

test('I3：还有未处置 finding 时 changes 仍然拦（不因豁免了一部分就放行 verdict）', () => {
  const review = changesReview([{ fid: 'aa', level: '中', reverifyCount: 1 }, { fid: 'bb', level: '低', reverifyCount: 1 }])
  const r = evaluateMergeable({
    mr: mr(),
    round: round({ review, ...directiveRound(review, [directive('aa')]) }),
    decisions: {},
  })
  assert.equal(r.mergeable, false)
  assert.deepEqual(r.missing, [
    'AI 评审结论为需要修改',
    '评审有 1 处需要关注的问题（其中 1 处本轮新增未处置）：FID bb（低）',
  ])
})

test('I3：历史未收敛非 0 / 未声明时，changes 不因全豁免而放行 verdict', () => {
  const review = changesReview([{ fid: 'aa', level: '中', reverifyCount: 1 }], { historicalUnresolved: 1 })
  const roundWaived = round({ review, ...directiveRound(review, [directive('aa')]) })
  const withHistory = evaluateMergeable({ mr: mr(), round: roundWaived, decisions: {} })
  assert.equal(withHistory.mergeable, false)
  assert.deepEqual(withHistory.missing, ['AI 评审结论为需要修改', '历史未收敛问题 1 条'])

  const undeclared = changesReview([{ fid: 'aa', level: '中', reverifyCount: 1 }], { historicalUnresolved: null })
  const nullHistory = evaluateMergeable({ mr: mr(), round: round({ review: undeclared, ...directiveRound(undeclared, [directive('aa')]) }), decisions: {} })
  assert.equal(nullHistory.mergeable, false)
  assert.deepEqual(nullHistory.missing, ['AI 评审结论为需要修改', '历史未收敛问题未声明'])
})

test('已结束的 MR（merged / closed）不再判「差几项」：missing 为空、带 terminal', () => {
  const merged = evaluateMergeable({ mr: mr({ state: 'merged' }), round: round(), decisions: {} })
  assert.deepEqual(merged, { mergeable: false, missing: [], degraded: false, terminal: 'merged' })
  const closed = evaluateMergeable({ mr: mr({ state: 'closed' }), round: round(), decisions: {} })
  assert.deepEqual(closed, { mergeable: false, missing: [], degraded: false, terminal: 'closed' })
  // 回归：以前 merged 会走进 missing 列表，显示「差 1 项：MR 状态是 merged」。
  assert.equal(merged.missing.includes('MR 状态是 merged'), false)
})
