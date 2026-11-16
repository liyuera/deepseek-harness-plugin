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

const recordOf = ({ iid, round, decisions = {} }) => ({
  version: 1,
  binding: { projectPath: 'group/project', iid, sourceBranch: 'feat-x', targetBranch: 'feature-y', boundAt: '2026-11-16T10:00:00Z' },
  rounds: [round],
  decisions,
  mergeableAt: null,
  terminal: null,
  paused: null,
  updatedAt: '2026-11-16T10:10:00Z',
})

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
