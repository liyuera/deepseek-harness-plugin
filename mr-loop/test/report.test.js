import test from 'node:test'
import assert from 'node:assert/strict'
import { renderReport } from '../src/host/report.js'

const binding = { projectPath: 'g/p', iid: 240, sourceBranch: 'feat-ly', targetBranch: 'feature-x' }
const mr = { sha: '0e2a9007aaaa', user_notes_count: 30, detailed_merge_status: 'mergeable' }
const round = {
  sha: '0e2a9007aaaa',
  n: 1,
  binding: 'strong',
  review: { verdict: 'pass', blocking: [], nonBlocking: [], historicalUnresolved: 0, verifiedFixed: 1, jobDuration: '10s' },
  sensitive: { verdict: 'pass', total: 15, waived: 15, effective: 0 },
  mandatory: null,
}

test('全绿报告形状稳定', () => {
  const text = renderReport({
    binding, mr, round, decisions: {},
    mergeability: { mergeable: true, missing: [], degraded: false },
    paused: null, now: Date.parse('2026-11-13T10:00:30Z'),
  })
  assert.match(text, /^MR !240 · g\/p$/m)
  assert.match(text, /第 1 轮 · sha 0e2a9007（强绑定）/)
  assert.match(text, /评审 {3}✅ 可直接合并 · 历史未收敛 0 · 本轮已验证修复 1 · Job 10s/)
  assert.match(text, /敏感 {3}✅ 门禁通过 · 共 15 \/ 历史豁免 15 \/ 当前有效 0/)
  assert.match(text, /必过 {3}⏳ 无本轮结论/)
  assert.match(text, /合并 {3}✅ 可合/)
  assert.doesNotMatch(text, /请修复/)
})

test('弱绑定 + 降级 + 未处置阻塞 + 暂停', () => {
  const text = renderReport({
    binding, mr: { ...mr, detailed_merge_status: undefined }, round: { ...round, binding: 'weak', review: { verdict: 'changes', blocking: [{ fid: 'aa', level: '高' }], nonBlocking: [], historicalUnresolved: 0, verifiedFixed: 0, jobDuration: '48s' }, sensitive: { verdict: 'block', total: 15, waived: 0, effective: 15 } },
    decisions: {},
    mergeability: { mergeable: false, missing: ['AI 评审结论为需要修改'], degraded: true },
    paused: { reason: 'stalled', at: '2026-11-13T10:05:00Z' },
    now: Date.parse('2026-11-13T10:00:30Z'),
  })
  assert.match(text, /弱绑定/)
  assert.match(text, /⚠️ 降级判定/)
  assert.match(text, /阻塞 {3}#aa/)
  assert.match(text, /暂停 {3}stalled/)
  assert.match(text, /合并 {3}⛔ 差 1 项/)
})

test('阻塞行与可合并判定共用处置口径：中间态不算已处置', () => {
  const text = renderReport({
    binding, mr, round: { ...round, review: { verdict: 'changes', blocking: [{ fid: 'aa', level: '高' }], nonBlocking: [], historicalUnresolved: 0, verifiedFixed: 0, jobDuration: '48s' } },
    decisions: { aa: { kind: 'pending' } },
    mergeability: { mergeable: false, missing: ['有 1 条阻塞问题未处置'], degraded: false },
    paused: null, now: Date.parse('2026-11-13T10:00:30Z'),
  })
  assert.match(text, /^阻塞 {3}#aa · 高$/m)
  assert.doesNotMatch(text, /^阻塞 {3}无$/m)
})

test('整份报告逐字快照：行序与完整性一次钉死', () => {
  const text = renderReport({
    binding, mr, round, decisions: {},
    mergeability: { mergeable: true, missing: [], degraded: false },
    paused: null, now: Date.parse('2026-11-13T10:00:30Z'),
  })
  assert.equal(text, [
    'MR !240 · g/p',
    'feat-ly → feature-x · 第 1 轮 · sha 0e2a9007（强绑定）',
    '评审   ✅ 可直接合并 · 历史未收敛 0 · 本轮已验证修复 1 · Job 10s',
    '敏感   ✅ 门禁通过 · 共 15 / 历史豁免 15 / 当前有效 0',
    '必过   ⏳ 无本轮结论',
    '阻塞   无',
    '待点头  （无）',
    '合并   ✅ 可合 · 无流水线',
  ].join('\n'))
})

test('合并行展示流水线现状：预绑定失败不再被降级判定掩盖', () => {
  const base = { binding, round, decisions: {}, paused: null, now: Date.parse('2026-11-13T10:00:30Z') }
  const failed = renderReport({ ...base, mr: { ...mr, head_pipeline: { id: 7181, status: 'failed' } }, mergeability: { mergeable: false, missing: ['流水线未通过（failed）'], degraded: true } })
  assert.match(failed, /合并 {3}⛔ 差 1 项：流水线未通过（failed）（⚠️ 降级判定） · 流水线 #7181 failed/)
  const ok = renderReport({ ...base, mr: { ...mr, head_pipeline: { id: 7181, status: 'success' } }, mergeability: { mergeable: true, missing: [], degraded: false } })
  assert.match(ok, /合并 {3}✅ 可合 · 流水线 #7181 success/)
  const none = renderReport({ ...base, mr, mergeability: { mergeable: true, missing: [], degraded: false } })
  assert.match(none, /合并 {3}✅ 可合 · 无流水线/)
})

test('阻塞行用处置白名单：pending 不算已处置，待点头统计草稿', () => {
  const text = renderReport({
    binding, mr,
    round: { ...round, review: { verdict: 'pass', blocking: [{ fid: 'aa', level: '中' }], nonBlocking: [], historicalUnresolved: 0, verifiedFixed: 0, jobDuration: '10s' } },
    decisions: { aa: { kind: 'pending' }, bb: { kind: 'waive' } },
    mergeability: { mergeable: false, missing: ['有 1 条阻塞问题未处置'], degraded: false },
    paused: null, now: Date.parse('2026-11-13T10:00:30Z'),
  })
  assert.match(text, /阻塞 {3}#aa/)
  assert.match(text, /待点头 {2}1 条豁免草稿/)
})
