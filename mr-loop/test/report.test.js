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
