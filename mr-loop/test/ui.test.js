/**
 * #9：UI 只读聚合的问题状态必须与合并判定同口径——
 * MR 评论里的有效 `#ai-*` 指令也让 FID 显示为 waived / 带 instruction，
 * 不能只在账本 decisions 里找处置，否则面板和报告互相矛盾。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUiState } from '../src/host/ui.js'

const SHA = 'a'.repeat(40)
const config = (dir) => ({ ledgerDir: dir, baseUrl: 'https://git.htwisdom.cn' })

const roundOf = ({ decisionsFinding = { fid: 'aaaaaaaaaa', level: '中' }, directives = [] } = {}) => ({
  sha: SHA,
  n: 1,
  binding: 'strong',
  review: {
    verdict: 'changes',
    blocking: [{ ...decisionsFinding, gateCategory: '逻辑错误', file: 'src/a.ts', location: 'src/a.ts:1', problem: '问题描述', suggestion: '建议', reverifyCount: 1 }],
    nonBlocking: [],
    historicalUnresolved: 0,
  },
  sensitive: null,
  mandatory: null,
  directives: {
    directives,
    directiveNotes: [],
    invalid: { count: 0, samples: [] },
    truncated: { directives: 0, directiveNotes: 0, notes: 0, lines: 0 },
  },
})

const recordOf = ({ iid, round, decisions = {}, terminal = null }) => ({
  version: 1,
  binding: { projectPath: 'group/project', iid, sourceBranch: 'feat-x', targetBranch: 'feature-y', boundAt: '2026-11-16T10:00:00Z' },
  rounds: [round],
  decisions,
  mergeableAt: null,
  terminal,
  paused: null,
  updatedAt: '2026-11-16T10:10:00Z',
})

/** 带 live 绑定的快照：service.listStates 返回内存状态，用来钉住「活绑定必须算合并判定」 */
async function snapshotWithLive(records, liveStates) {
  const dir = await mkdtemp(join(tmpdir(), 'mr-loop-ui-'))
  try {
    for (const [index, record] of records.entries()) {
      await writeFile(join(dir, `mr-${index}.json`), JSON.stringify(record), 'utf8')
    }
    const ui = createUiState({ config: config(dir), service: { listStates: () => liveStates } })
    return await ui.snapshot({ scope: 'all' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function snapshotOf(records) {
  const dir = await mkdtemp(join(tmpdir(), 'mr-loop-ui-'))
  try {
    for (const [index, record] of records.entries()) {
      await writeFile(join(dir, `mr-${index}.json`), JSON.stringify(record), 'utf8')
    }
    const ui = createUiState({ config: config(dir), service: { listStates: () => [] } })
    return await ui.snapshot({ scope: 'all' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('#9：MR 指令豁免的 FID 在 UI 里是 waived，并带 instruction（kind/reason/noteId）', async () => {
  const directives = [{ kind: 'waive', fid: 'aaaaaaaaaa', reason: '已评估：本 MR 不涉及', noteId: 75200 }]
  const snapshot = await snapshotOf([recordOf({ iid: 240, round: roundOf({ directives }) })])
  assert.equal(snapshot.mrs.length, 1)
  const [problem] = snapshot.mrs[0].problems
  assert.equal(problem.fid, 'aaaaaaaaaa')
  assert.equal(problem.status, 'waived')
  assert.deepEqual(problem.instruction, { kind: 'waive', reason: '已评估：本 MR 不涉及', noteId: 75200 })
  // 面板的待处理计数与合并判定同口径：指令豁免后不再 pending。
  assert.equal(snapshot.mrs[0].pending, 0)
})

test('#9：账本 decisions 的处置仍然生效（两种来源并存时以账本为准）', async () => {
  const round = roundOf({ decisionsFinding: { fid: 'bbbbbbbbbb', level: '低' }, directives: [] })
  const snapshot = await snapshotOf([
    recordOf({ iid: 241, round, decisions: { bbbbbbbbbb: { kind: 'skip', reason: '不适用', noteId: 31 } } }),
  ])
  const [problem] = snapshot.mrs[0].problems
  assert.equal(problem.status, 'waived')
  assert.deepEqual(problem.instruction, { kind: 'skip', reason: '不适用', noteId: 31 })
  assert.equal(snapshot.mrs[0].pending, 0)
})

test('#9：没有豁免（指令/账本都没有）的 FID 仍是 open 且无 instruction', async () => {
  const snapshot = await snapshotOf([recordOf({ iid: 242, round: roundOf() })])
  const [problem] = snapshot.mrs[0].problems
  assert.equal(problem.status, 'open')
  assert.equal(problem.instruction, undefined)
  assert.equal(snapshot.mrs[0].pending, 1)
})

// ---------------------------------------------------------------------------
// M3：账本 decisions 的 FID 大小写与评审不一致时，UI 也要算已处置（与 mergeable 同口径）
// ---------------------------------------------------------------------------
test('M3：账本里的 FID 大小写与评审不一致，面板仍是 waived 且带 instruction', async () => {
  const round = roundOf({ decisionsFinding: { fid: 'bbbbbbbbbb', level: '低' }, directives: [] })
  const snapshot = await snapshotOf([
    recordOf({ iid: 243, round, decisions: { BBBBBBBBBB: { kind: 'wontfix', reason: '大小写不同', noteId: 77 } } }),
  ])
  const [problem] = snapshot.mrs[0].problems
  assert.equal(problem.fid, 'bbbbbbbbbb')
  assert.equal(problem.status, 'waived')
  assert.deepEqual(problem.instruction, { kind: 'wontfix', reason: '大小写不同', noteId: 77 })
  // 面板的待处理计数与合并判定同口径：大小写不同也必须扣掉。
  assert.equal(snapshot.mrs[0].pending, 0)
})

test('C1：新一轮评审还没出时，problems 回落上一轮但不能把上一轮的 FID 显示成 fixed', async () => {
  const first = roundOf()
  const pendingRound = { ...roundOf(), sha: 'b'.repeat(40), n: 2, review: null }
  const record = { ...recordOf({ iid: 244, round: first }) }
  record.rounds = [first, pendingRound]
  const snapshot = await snapshotOf([record])
  const [problem] = snapshot.mrs[0].problems
  // 回落：上一轮的问题仍然显示（评审未出 ≠ 空白），但状态只能是「待复验」，绝不能是 fixed。
  assert.equal(snapshot.mrs[0].problems.length, 1)
  assert.equal(problem.fid, 'aaaaaaaaaa')
  assert.equal(problem.status, 'open')
  assert.equal(problem.unverified, true, '上一轮的未处理只能标「待复验」')
  assert.equal(snapshot.mrs[0].problemsRound.n, 1)
  assert.equal(snapshot.mrs[0].problemsRound.current, false)
  // 待处理计数与可合判定仍只认当前轮：回落只影响展示。
  assert.equal(snapshot.mrs[0].pending, 0)
  assert.deepEqual(snapshot.mrs[0].rounds.map((round) => [round.n, round.verdict, round.total]), [[1, 'changes', 1], [2, null, 0]])
  assert.equal(snapshot.mrs[0].rounds[1].current, true)
})

test('活绑定的 MR 必须给出实时 state 与合并判定（回归：曾读取 live.mr 导致 merge 恒为 null）', async () => {
  const round = roundOf({ decisionsFinding: { fid: 'bbbbbbbbbb', level: '低' }, directives: [] })
  round.review.verdict = 'pass'
  round.review.blocking = []
  const record = recordOf({ iid: 241, round })
  const liveState = {
    sessionId: 'session-live',
    binding: { projectPath: 'group/project', iid: 241 },
    mr: {
      state: 'opened',
      sha: SHA,
      draft: false,
      has_conflicts: false,
      blocking_discussions_resolved: true,
      merge_status: 'can_be_merged',
      head_pipeline: { id: 7298, status: 'success' },
    },
    round,
    rounds: [round],
    decisions: {},
  }

  const snapshot = await snapshotWithLive([record], [liveState])
  const mr = snapshot.mrs[0]
  assert.equal(mr.live, true)
  assert.equal(mr.state, 'opened')
  assert.equal(mr.session.id, 'session-live')
  assert.equal(mr.merge.mergeable, true)
  assert.equal(mr.merge.pipeline.status, 'success')
})

test('I1：账本 terminal=merged → UI state 为 merged，「已合并」计数正确', async () => {
  const snapshot = await snapshotOf([recordOf({ iid: 245, round: roundOf(), terminal: 'merged' })])
  assert.equal(snapshot.mrs[0].state, 'merged')
  assert.equal(snapshot.mrs[0].live, false)
  assert.equal(snapshot.counts.merged, 1)
})

// ---------------------------------------------------------------------------
// M1：live 优先（内存状态比账本新）+ live.mr 与 round 必须同 sha
// ---------------------------------------------------------------------------
const liveMrOf = (sha) => ({
  state: 'opened',
  sha,
  draft: false,
  has_conflicts: false,
  blocking_discussions_resolved: true,
  merge_status: 'can_be_merged',
  head_pipeline: { id: 7299, status: 'success' },
})

test('M1：live 存在时用内存状态（轮次更新），updatedAt 回落磁盘；sha 不一致则 merge=null', async () => {
  const diskRound = roundOf() // 第 1 轮、还有一个 open 问题
  const disk = recordOf({ iid: 246, round: diskRound })
  // 内存状态已到第 2 轮：评审 pass、无问题（比 fire-and-forget 的账本新）。
  const liveRound = {
    ...roundOf(),
    sha: 'b'.repeat(40),
    n: 2,
    review: { ...roundOf().review, verdict: 'pass', blocking: [], nonBlocking: [], historicalUnresolved: 0 },
  }
  const liveState = {
    sessionId: 'session-live',
    binding: { projectPath: 'group/project', iid: 246 },
    mr: liveMrOf('b'.repeat(40)),
    round: liveRound,
    rounds: [liveRound],
    decisions: {},
  }
  const snapshot = await snapshotWithLive([disk], [liveState])
  const mr = snapshot.mrs[0]
  assert.equal(mr.round, 2, 'live 的内存状态必须优先于磁盘')
  assert.equal(mr.problems.length, 0)
  assert.equal(mr.pending, 0)
  assert.equal(mr.merge.mergeable, true)
  assert.equal(mr.updatedAt, disk.updatedAt, 'live state 不维护 updatedAt，回落磁盘')

  // 快照还没并到当前轮（live.mr.sha 与 round.sha 不一致）时不能拿它算合并判定。
  const stale = await snapshotWithLive([disk], [{ ...liveState, mr: liveMrOf('c'.repeat(40)) }])
  assert.equal(stale.mrs[0].merge, null)
})

// ---------------------------------------------------------------------------
// M2：webUrl 用配置的 baseUrl（含子路径），不写死实例 host
// ---------------------------------------------------------------------------
test('M2：账本记录的 webUrl 用 config.baseUrl 拼（含子路径）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mr-loop-ui-'))
  try {
    await writeFile(join(dir, 'mr-0.json'), JSON.stringify(recordOf({ iid: 240, round: roundOf() })), 'utf8')
    const ui = createUiState({
      config: { ledgerDir: dir, baseUrl: 'https://git.example.com/gitlab' },
      service: { listStates: () => [] },
    })
    const snapshot = await ui.snapshot({ scope: 'all' })
    assert.equal(snapshot.mrs[0].webUrl, 'https://git.example.com/gitlab/group/project/-/merge_requests/240')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('指令豁免的问题带评论原文（body/author/createdAt/noteId），供面板展开显示', async () => {
  const round = roundOf({ directives: [{ kind: 'waive', fid: 'aaaaaaaaaa', reason: '风险已评估', noteId: 75200, author: 'liyu', createdAt: '2026-11-16T10:00:00Z' }] })
  round.directiveNotes = [{ noteId: 75200, body: '#ai-waive aaaaaaaaaa reason=风险已评估' }]
  const record = recordOf({ iid: 242, round, decisions: {} })

  const snapshot = await snapshotOf([record])
  const problem = snapshot.mrs[0].problems[0]
  assert.equal(problem.status, 'waived')
  assert.equal(problem.instruction.noteId, 75200)
  assert.equal(problem.comment.noteId, 75200)
  assert.equal(problem.comment.body, '#ai-waive aaaaaaaaaa reason=风险已评估')
  assert.equal(problem.comment.author, 'liyu')
  assert.equal(problem.comment.createdAt, '2026-11-16T10:00:00Z')
})

// ---------------------------------------------------------------------------
// 面板回落 + 轮次摘要：当前轮评审没出时，面板不能整块变空（0.2.5）
// ---------------------------------------------------------------------------

const passReviewOf = (over = {}) => ({
  ...roundOf().review,
  verdict: 'pass',
  blocking: [],
  nonBlocking: [],
  historicalUnresolved: 0,
  ...over,
})

test('面板：当前轮评审未出时回落到上一轮结论，rounds 给出逐轮条数与已修数', async () => {
  const first = { ...roundOf(), n: 1, review: { ...roundOf().review, verdict: 'changes' } }
  const second = { ...roundOf(), n: 2, sha: 'b'.repeat(40), review: passReviewOf() }
  const third = { ...roundOf(), n: 3, sha: 'c'.repeat(40), review: null }
  const record = { ...recordOf({ iid: 247, round: first }), rounds: [first, second, third] }
  const snapshot = await snapshotOf([record])
  const mr = snapshot.mrs[0]

  assert.equal(mr.round, 3)
  assert.deepEqual(mr.problemsRound, { n: 2, sha: 'b'.repeat(40), current: false })
  // 回落看第 2 轮：第 1 轮的 FID 在那一轮已被评审确认消失 → 已修（不受回落影响）。
  assert.deepEqual(mr.problems.map((problem) => [problem.fid, problem.status, problem.unverified]), [
    ['aaaaaaaaaa', 'fixed', undefined],
  ])
  // 待处理计数与可合判定仍只认当前轮：回落只改展示。
  assert.equal(mr.pending, 0)
  assert.deepEqual(
    mr.rounds.map((round) => [round.n, round.verdict, round.total, round.open, round.fixed, round.current]),
    [
      [1, 'changes', 1, 1, 0, false],
      [2, 'pass', 0, 0, 1, false],
      [3, null, 0, 0, 0, true],
    ],
  )
})

test('面板：当前轮评审已落地时 problemsRound 指向当前轮，问题不标「待复验」', async () => {
  const snapshot = await snapshotOf([recordOf({ iid: 249, round: roundOf() })])
  const mr = snapshot.mrs[0]
  assert.deepEqual(mr.problemsRound, { n: 1, sha: SHA, current: true })
  assert.equal(mr.problems[0].status, 'open')
  assert.equal('unverified' in mr.problems[0], false)
  assert.deepEqual(mr.rounds.map((round) => [round.n, round.current]), [[1, true]])
})

test('面板：每轮摘要都带自己的问题正文（历史轮点开即可查看）', async () => {
  const first = {
    ...roundOf(),
    n: 1,
    review: {
      ...roundOf().review,
      verdict: 'changes',
      blocking: [{ ...roundOf().review.blocking[0], fid: 'old0000001', problem: '第 1 轮的问题', level: '中' }],
    },
  }
  const second = {
    ...roundOf(),
    n: 2,
    sha: 'b'.repeat(40),
    review: {
      ...passReviewOf(),
      nonBlocking: [{ ...roundOf().review.blocking[0], fid: 'new0000002', problem: '第 2 轮的问题', level: '低' }],
    },
  }
  const third = { ...roundOf(), n: 3, sha: 'c'.repeat(40), review: null }
  const record = { ...recordOf({ iid: 250, round: first }), rounds: [first, second, third] }
  const snapshot = await snapshotOf([record])
  const mr = snapshot.mrs[0]

  // 默认视图 = 最近一次落地的评审（第 2 轮）：本轮问题 + 上一轮被本轮确认修好的。
  assert.equal(mr.problemsRound.n, 2)
  assert.deepEqual(mr.problems.map((problem) => [problem.fid, problem.status]), [
    ['new0000002', 'open'],
    ['old0000001', 'fixed'],
  ])
  // 轮次摘要里每一轮都有自己的正文，客户端点开历史轮直接渲染，不需要再请求。
  const [r1, r2, r3] = mr.rounds
  assert.deepEqual(r1.problems.map((problem) => [problem.fid, problem.status]), [['old0000001', 'open']])
  assert.deepEqual(r2.problems.map((problem) => [problem.fid, problem.status]), [
    ['new0000002', 'open'],
    ['old0000001', 'fixed'],
  ])
  assert.equal(r2.fixed, 1)
  assert.deepEqual(r3.problems, [])
  // 历史轮的问题不标 unverified（那是「当前视图」的语义）。
  assert.equal('unverified' in r1.problems[0], false)
})

// ---------------------------------------------------------------------------
// 终态：merged / closed 的 MR 不再显示「差 N 项：MR 状态是 merged」，也不再报待处理
// ---------------------------------------------------------------------------

test('面板：已合并的 live MR → merge 带 terminal、missing 为空、pending 归零', async () => {
  const mergedMr = {
    state: 'merged',
    sha: SHA,
    draft: false,
    has_conflicts: false,
    blocking_discussions_resolved: true,
    merge_status: 'can_be_merged',
    head_pipeline: { id: 7364, status: 'success', sha: SHA },
  }
  const round = { ...roundOf(), review: { ...roundOf().review, verdict: 'changes' }, n: 9 }
  const record = { ...recordOf({ iid: 251, round }), rounds: [round], terminal: 'merged' }
  const liveState = {
    sessionId: 'session-live',
    binding: { projectPath: 'group/project', iid: 251 },
    mr: mergedMr,
    round,
    rounds: [round],
    decisions: {},
    terminal: 'merged',
  }
  const snapshot = await snapshotWithLive([record], [liveState])
  const mr = snapshot.mrs[0]
  assert.equal(mr.state, 'merged')
  assert.deepEqual(mr.merge, {
    mergeable: false,
    missing: [],
    terminal: 'merged',
    pipeline: { id: 7364, status: 'success', sha: SHA },
  })
  // 问题照常能看到（历史），但不再计入待处理。
  assert.equal(mr.problems.length, 1)
  assert.equal(mr.pending, 0)
})

test('面板：只有账本的已合并 MR（没有 live 快照）也给 terminal 的 merge', async () => {
  const snapshot = await snapshotOf([recordOf({ iid: 252, round: roundOf(), terminal: 'merged' })])
  const mr = snapshot.mrs[0]
  assert.equal(mr.live, false)
  assert.deepEqual(mr.merge, { mergeable: false, missing: [], terminal: 'merged', pipeline: null })
  assert.equal(snapshot.counts.merged, 1)
  assert.equal(snapshot.counts.mergeable, 0, '已合并不能算进「可合」')
  assert.equal(mr.pending, 0)
})
