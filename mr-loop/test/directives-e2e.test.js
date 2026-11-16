/**
 * I3 端到端：真实 fixture 评审 note（verdict=需要修改、2 条 finding）
 * + 两条 MR 豁免指令，走真实 parseReview → buildRound → evaluateMergeable → renderReport。
 * 断言「有效指令的 FID 视为已处置」后不再因 verdict=changes 拦住合并。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveConfig } from '../src/host/config.js'
import { buildRound } from '../src/host/rounds.js'
import { evaluateMergeable } from '../src/host/mergeable.js'
import { renderReport } from '../src/host/report.js'

const cfg = resolveConfig({})
const FIXTURE = readFileSync(new URL('./fixtures/review-needs-fix.md', import.meta.url), 'utf8')
// fixture 自带的 sha 标记是 40 个 0：用它当当前 sha 就能走强绑定。
const SHA = '0'.repeat(40)
const CREATED = '2026-11-16T10:00:00Z'
const note = (id, body, over = {}) => ({
  id, system: false, body, author: { username: 'human' }, created_at: CREATED, ...over,
})
const mr = {
  sha: SHA,
  state: 'opened',
  draft: false,
  has_conflicts: false,
  detailed_merge_status: 'mergeable',
  user_notes_count: 3,
  head_pipeline: { id: 7181, status: 'success', created_at: '2026-11-16T09:59:00Z' },
}
const binding = { projectPath: 'group/project', iid: 240, sourceBranch: 'feat-EXAMPLE-ly', targetBranch: 'feature-EXAMPLE' }
const notes = [
  note(900, FIXTURE, { author: { username: 'ai-review-bot' }, created_at: '2026-11-16T10:05:00Z' }),
  note(901, '#ai-waive aaaaaaaaaa reason=已评估：该路径本 MR 不涉及', { created_at: '2026-11-16T10:06:00Z' }),
  note(902, '#ai-waive bbbbbbbbbb reason=公共样式改动可接受', { created_at: '2026-11-16T10:07:00Z' }),
]
const round = { ...buildRound({ mr, notes, cfg, observedAt: Date.parse('2026-11-16T10:10:00Z') }), n: 1 }

test('I3 端到端：fixture 的 changes + 两条豁免指令 → 可合，报告标出「问题已全部豁免」', () => {
  // 前提：真实解析确实认为需要修改、且确实采到了两条人类指令。
  assert.equal(round.review.verdict, 'changes')
  assert.deepEqual([...round.review.blocking, ...round.review.nonBlocking].map((item) => item.fid), ['aaaaaaaaaa', 'bbbbbbbbbb'])
  assert.deepEqual(round.directives.directives.map((item) => item.fid), ['aaaaaaaaaa', 'bbbbbbbbbb'])

  const decisions = {}
  const mergeability = evaluateMergeable({ mr, round, decisions })
  assert.deepEqual(mergeability.missing, [])
  assert.equal(mergeability.mergeable, true)

  const report = renderReport({ binding, mr, round, decisions, mergeability, paused: null, now: Date.parse('2026-11-16T10:20:00Z') })
  assert.match(report, /^评审 {3}⛔ 需要修改 · 发现 2（本轮新增 2，已豁免 2） · 问题已全部豁免 · 历史未收敛 0/m)
  assert.match(report, /^阻塞 {3}无$/m)
  assert.match(report, /^豁免 {3}aaaaaaaaaa · #ai-waive（评论 #901） · 已评估：该路径本 MR 不涉及；bbbbbbbbbb · #ai-waive（评论 #902） · 公共样式改动可接受$/m)
  assert.match(report, /^合并 {3}✅ 可合 · 流水线 #7181 success$/m)
})

test('I3 端到端：只豁免一条 → 仍不可合，缺口只列另一条', () => {
  const partialNotes = [notes[0], notes[1]]
  const partialRound = { ...buildRound({ mr, notes: partialNotes, cfg, observedAt: Date.parse('2026-11-16T10:10:00Z') }), n: 1 }
  const mergeability = evaluateMergeable({ mr, round: partialRound, decisions: {} })
  assert.equal(mergeability.mergeable, false)
  assert.deepEqual(mergeability.missing, [
    'AI 评审结论为需要修改',
    '评审有 1 处需要关注的问题（其中 1 处本轮新增未处置）：FID bbbbbbbbbb（低）',
  ])
})
