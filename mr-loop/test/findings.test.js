/**
 * T4：findings 按工作区落盘（只记录、不做分析）。
 *
 * 覆盖：
 *   - `collectFindings(record)`：与 UI 共用的 FID 粒度判定（open / waived / skip / wontfix / fixed）；
 *   - JSONL 存储：路径（工作区 + projectPath 转义 + MR 分文件）、append-only、状态变化才追加、
 *     同一 MR 内按 `(fid, status, instruction.kind, instruction.noteId)` 去重；
 *   - 文本单行化 / 截断、坏行容错、跨重启去重、目录 0700 / 文件 0600、超阈值滚动。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectFindings, createFindingsStore, displayRoundIndex, resolveFindings, settledRoundIndex } from '../src/host/findings.js'
import { resolveConfig } from '../src/host/config.js'
import { createLedger } from '../src/host/ledger.js'
import { createService } from '../src/host/service.js'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const NOW = Date.parse('2026-11-16T10:10:00Z')

const finding = (over = {}) => ({
  fid: 'fid0000001',
  file: 'src/a.js',
  level: '中',
  gateCategory: '逻辑错误',
  location: 'src/a.js:3',
  problem: '问题',
  suggestion: '建议',
  reverifyCount: 1,
  ...over,
})

const roundOf = ({ sha = SHA_A, n = 1, blocking = [], nonBlocking = [], directives = [], verdict = 'changes' } = {}) => ({
  sha,
  n,
  binding: 'strong',
  observedAt: NOW,
  review: { noteId: 11, binding: 'strong', verdict, blocking, nonBlocking, historicalUnresolved: 0, verifiedFixed: 0, jobDuration: null },
  sensitive: null,
  mandatory: null,
  directives: {
    directives,
    directiveNotes: [],
    invalid: { count: 0, samples: [] },
    truncated: { directives: 0, directiveNotes: 0, notes: 0, lines: 0 },
  },
})

/** service 状态 / 账本记录同形：collectFindings 只读 binding / rounds / decisions。 */
const stateOf = ({ repoRoot = '/work/repo-a', projectPath = 'group/project', iid = 240, rounds = [roundOf()], decisions = {} } = {}) => ({
  sessionId: 's1',
  binding: {
    projectPath,
    iid,
    repoRoot,
    sourceBranch: 'feat-x',
    targetBranch: 'feature-y',
    boundAt: '2026-11-16T10:00:00.000Z',
  },
  round: rounds[rounds.length - 1],
  rounds,
  decisions,
  mr: {},
})

const tmp = () => mkdtemp(join(tmpdir(), 'mrloop-findings-'))

const linesOf = async (file) => {
  const text = await readFile(file, 'utf8')
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
}

const expectedFile = (dir, workspace, projectPath, iid) => join(
  dir,
  workspace,
  'findings',
  `${projectPath.split('/').join('__')}__${iid}.jsonl`,
)

// ---------------------------------------------------------------------------
// collectFindings：UI 与落盘共用同一份判定，不允许两套口径
// ---------------------------------------------------------------------------

test('collectFindings：本轮 finding 为 open，保留复验次数与 location 里的行号', () => {
  const findings = collectFindings(stateOf({ rounds: [roundOf({ blocking: [finding()] })] }))
  assert.equal(findings.length, 1)
  const [item] = findings
  assert.equal(item.fid, 'fid0000001')
  assert.equal(item.status, 'open')
  assert.equal(item.file, 'src/a.js')
  assert.equal(item.line, 3)
  assert.equal(item.level, '中')
  assert.equal(item.gateCategory, '逻辑错误')
  assert.equal(item.problem, '问题')
  assert.equal(item.suggestion, '建议')
  assert.equal(item.reverifyCount, 1)
  assert.equal(item.instruction, null)
})

test('collectFindings：MR 指令处置 → waived / skip / wontfix（kind 保留在 instruction）', () => {
  const expected = { waive: 'waived', skip: 'skip', wontfix: 'wontfix' }
  for (const kind of Object.keys(expected)) {
    const round = roundOf({
      blocking: [finding()],
      directives: [{ kind, fid: 'fid0000001', reason: `原因-${kind}`, noteId: 700 }],
    })
    const [item] = collectFindings(stateOf({ rounds: [round] }))
    assert.equal(item.status, expected[kind], kind)
    assert.deepEqual(item.instruction, { kind, reason: `原因-${kind}`, noteId: 700 })
  }
})

test('collectFindings：账本 decisions 优先于指令；上一轮消失的 FID 记 fixed，已处置的不记', () => {
  const first = roundOf({ blocking: [finding({ fid: 'AAAA' }), finding({ fid: 'BBBB' })] })
  const second = roundOf({ sha: SHA_B, n: 2, blocking: [], verdict: 'pass' })
  const decisions = { bbbb: { kind: 'wontfix', reason: '业务决定', noteId: 31 } }
  const findings = collectFindings(stateOf({ rounds: [first, second], decisions }))
  assert.equal(findings.length, 1)
  assert.equal(findings[0].fid, 'AAAA')
  assert.equal(findings[0].status, 'fixed')
  assert.equal(findings[0].fixedAtRound, 2)

  const disposed = collectFindings(stateOf({
    rounds: [roundOf({
      blocking: [finding({ fid: 'CCCC' })],
      directives: [{ kind: 'waive', fid: 'CCCC', reason: '指令原因', noteId: 9 }],
    })],
    decisions: { cccc: { kind: 'skip', reason: '账本原因', noteId: 10 } },
  }))
  assert.equal(disposed[0].status, 'skip')
  assert.equal(disposed[0].instruction.reason, '账本原因')
})

test('collectFindings：当前轮评审未出 / unknown 时不判 fixed；有新评审结论才判', () => {
  const first = roundOf({ blocking: [finding({ fid: 'AAAA' })] })
  const makeRound = (review) => ({
    ...roundOf({ sha: SHA_B, n: 2, blocking: [], verdict: 'pass' }),
    review,
  })

  // push 后新 sha 已建轮、评审还没出：不能把上一轮 FID 写成「已修」。
  assert.deepEqual(collectFindings(stateOf({ rounds: [first, makeRound(null)] })), [])
  // 评审 note 在但解析 unknown：同样证不了修复。
  const unknownReview = { ...roundOf({ blocking: [], verdict: 'pass' }).review, verdict: 'unknown', blocking: [], nonBlocking: [] }
  assert.deepEqual(collectFindings(stateOf({ rounds: [first, makeRound(unknownReview)] })), [])
  // 完整的新一轮评审（pass，无该 FID）才允许判 fixed。
  const settled = makeRound(roundOf({ blocking: [], verdict: 'pass' }).review)
  const fixed = collectFindings(stateOf({ rounds: [first, settled] }))
  assert.equal(fixed.length, 1)
  assert.equal(fixed[0].fid, 'AAAA')
  assert.equal(fixed[0].status, 'fixed')
})

// ---------------------------------------------------------------------------
// 存储：路径 / 结构 / append-only / 去重
// ---------------------------------------------------------------------------

test('路径：<workspace>/findings/<projectPath 的 / 换成 __>__<iid>.jsonl，record 一行一条', async () => {
  const dir = await tmp()
  const store = createFindingsStore({ dir, now: () => NOW })
  const workspace = 'wisdom-financial-credit-platform-web'
  const projectPath = 'wisdom-financial-service-platform/wisdom-financial-credit-platform-web'
  await store.record(stateOf({
    repoRoot: `/work/${workspace}`,
    projectPath,
    iid: 240,
    rounds: [roundOf({ blocking: [finding()] })],
  }))
  const file = expectedFile(dir, workspace, projectPath, 240)
  const raw = await readFile(file, 'utf8')
  assert.equal(raw.trim().split('\n').length, 1, 'JSONL 必须一行一条')
  const [line] = await linesOf(file)
  assert.deepEqual(line, {
    v: 1,
    at: new Date(NOW).toISOString(),
    workspace,
    projectPath,
    iid: 240,
    sha: SHA_A,
    round: 1,
    fid: 'fid0000001',
    file: 'src/a.js',
    line: 3,
    level: '中',
    type: null,
    gateCategory: '逻辑错误',
    problem: '问题',
    suggestion: '建议',
    reverifyCount: 1,
    status: 'open',
    instruction: null,
  })
  await rm(dir, { recursive: true, force: true })
})

test('两个仓库写两处互不干扰；同一工作区两个 MR 分文件；取不到 repoRoot 用 unknown', async () => {
  const dir = await tmp()
  const store = createFindingsStore({ dir, now: () => NOW })
  await store.record(stateOf({
    repoRoot: '/work/repo-a',
    projectPath: 'group/proj-a',
    iid: 1,
    rounds: [roundOf({ blocking: [finding()] })],
  }))
  await store.record(stateOf({
    repoRoot: '/work/repo-b',
    projectPath: 'group/proj-b',
    iid: 2,
    rounds: [roundOf({ blocking: [finding()] })],
  }))
  await store.record(stateOf({
    repoRoot: '/work/repo-a',
    projectPath: 'group/proj-a',
    iid: 3,
    rounds: [roundOf({ blocking: [finding()] })],
  }))
  assert.equal((await linesOf(expectedFile(dir, 'repo-a', 'group/proj-a', 1))).length, 1)
  assert.equal((await linesOf(expectedFile(dir, 'repo-b', 'group/proj-b', 2))).length, 1)
  assert.equal((await linesOf(expectedFile(dir, 'repo-a', 'group/proj-a', 3))).length, 1)

  await store.record(stateOf({
    repoRoot: null,
    projectPath: 'group/proj-a',
    iid: 4,
    rounds: [roundOf({ blocking: [finding()] })],
  }))
  assert.equal((await linesOf(expectedFile(dir, 'unknown', 'group/proj-a', 4))).length, 1)
  await rm(dir, { recursive: true, force: true })
})

test('追加：同状态再次快照不新增；状态变化（指令来源）追加新行且历史不重写', async () => {
  const dir = await tmp()
  const store = createFindingsStore({ dir, now: () => NOW })
  const round = roundOf({ blocking: [finding()] })
  const state = stateOf({ rounds: [round] })
  await store.record(state)
  await store.record(state)
  const file = expectedFile(dir, 'repo-a', 'group/project', 240)
  assert.equal((await linesOf(file)).length, 1, '同状态快照不重复追加')

  const waived = stateOf({
    rounds: [roundOf({
      blocking: [finding()],
      directives: [{ kind: 'waive', fid: 'fid0000001', reason: '已评估：本 MR 不涉及', noteId: 75200 }],
    })],
  })
  await store.record(waived)
  const lines = await linesOf(file)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].status, 'open')
  assert.equal(lines[1].status, 'waived')
  assert.deepEqual(lines[1].instruction, { kind: 'waive', reason: '已评估：本 MR 不涉及', noteId: 75200 })
  await rm(dir, { recursive: true, force: true })
})

test('状态变化：下一轮 FID 消失 → fixed 追加', async () => {
  const dir = await tmp()
  const store = createFindingsStore({ dir, now: () => NOW })
  const first = roundOf({ blocking: [finding()] })
  const second = roundOf({ sha: SHA_B, n: 2, blocking: [], verdict: 'pass' })
  await store.record(stateOf({ rounds: [first] }))
  await store.record(stateOf({ rounds: [first, second] }))
  const lines = await linesOf(expectedFile(dir, 'repo-a', 'group/project', 240))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].status, 'open')
  assert.equal(lines[1].status, 'fixed')
  assert.equal(lines[1].round, 2)
  assert.equal(lines[1].sha, SHA_B)
  await rm(dir, { recursive: true, force: true })
})

test('没有 finding 时不建文件（不给干净 MR 留空目录）', async () => {
  const dir = await tmp()
  const store = createFindingsStore({ dir, now: () => NOW })
  await store.record(stateOf({ rounds: [roundOf({ blocking: [], verdict: 'pass' })] }))
  await assert.rejects(readdir(join(dir, 'repo-a', 'findings')), /ENOENT/)
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 跨重启去重 / 文本边界 / 坏行容错 / 权限 / 滚动 / 失败兜底
// ---------------------------------------------------------------------------

test('跨重启去重：新实例读回已有 JSONL 后，同内容不再追加', async () => {
  const dir = await tmp()
  const state = stateOf({ rounds: [roundOf({ blocking: [finding()] })] })
  const first = createFindingsStore({ dir, now: () => NOW })
  await first.record(state)
  const file = expectedFile(dir, 'repo-a', 'group/project', 240)
  assert.equal((await linesOf(file)).length, 1)

  const restarted = createFindingsStore({ dir, now: () => NOW + 60_000 })
  await restarted.record(state)
  assert.equal((await linesOf(file)).length, 1, '重启后同内容不能重复追加')
  await rm(dir, { recursive: true, force: true })
})

test('文本单行化 + 截断：problem/suggestion ≤500、file ≤300、控制字符压掉', async () => {
  const dir = await tmp()
  const store = createFindingsStore({ dir, now: () => NOW })
  const problem = `${'长'.repeat(600)}\n第二行\u0000\u001b`
  const suggestion = '建'.repeat(620)
  const file = 'x'.repeat(400)
  await store.record(stateOf({
    rounds: [roundOf({ blocking: [finding({ problem, suggestion, file })] })],
  }))
  const target = expectedFile(dir, 'repo-a', 'group/project', 240)
  const raw = await readFile(target, 'utf8')
  assert.equal(raw.trim().split('\n').length, 1, 'JSONL 必须物理单行')
  const [line] = await linesOf(target)
  assert.equal(line.problem.length, 500)
  assert.equal(line.suggestion.length, 500)
  assert.equal(line.file.length, 300)
  assert.equal(line.problem.includes('\n'), false)
  await rm(dir, { recursive: true, force: true })
})

test('坏行容错：已有文件里的坏行跳过，有效行仍参与去重', async () => {
  const dir = await tmp()
  const target = expectedFile(dir, 'repo-a', 'group/project', 240)
  await mkdir(join(dir, 'repo-a', 'findings'), { recursive: true })
  const goodLine = JSON.stringify({ fid: 'fid0000001', status: 'open', instruction: null })
  await writeFile(target, `not-json\n{"broken":\n${goodLine}\n`, 'utf8')

  const store = createFindingsStore({ dir, now: () => NOW })
  await store.record(stateOf({
    rounds: [roundOf({ blocking: [finding(), finding({ fid: 'fid0000002' })] })],
  }))
  const raw = await readFile(target, 'utf8')
  const rows = raw.split('\n').filter((line) => line.trim() !== '')
  assert.equal(rows.length, 4, '坏行原样保留，只追加未去重的那条')
  const appended = JSON.parse(rows[rows.length - 1])
  assert.equal(appended.fid, 'fid0000002')
  await rm(dir, { recursive: true, force: true })
})

test('目录 0700、文件 0600（与账本一致）', async () => {
  const dir = await tmp()
  const store = createFindingsStore({ dir, now: () => NOW })
  await store.record(stateOf({ rounds: [roundOf({ blocking: [finding()] })] }))
  const target = expectedFile(dir, 'repo-a', 'group/project', 240)
  const dirStat = await stat(join(dir, 'repo-a', 'findings'))
  const fileStat = await stat(target)
  assert.equal(dirStat.mode & 0o777, 0o700)
  assert.equal(fileStat.mode & 0o777, 0o600)
  await rm(dir, { recursive: true, force: true })
})

test('体积滚动：超阈值滚动成 <name>.1.jsonl（只留一代）并继续写新文件', async () => {
  const dir = await tmp()
  // 阈值设得比任意一行小：第二次追加必然触发滚动，不依赖行长度。
  const store = createFindingsStore({ dir, maxBytes: 100, now: () => NOW })
  const stateFor = (fid) => stateOf({ rounds: [roundOf({ blocking: [finding({ fid })] })] })
  await store.record(stateFor('fid0000001'))
  await store.record(stateFor('fid0000002'))

  const active = expectedFile(dir, 'repo-a', 'group/project', 240)
  const rolled = join(dir, 'repo-a', 'findings', 'group__project__240.1.jsonl')
  assert.equal((await linesOf(rolled)).length, 1, '滚动后旧内容在 .1')
  assert.equal((await linesOf(active)).length, 1, '新记录写进新文件')

  await store.record(stateFor('fid0000003'))
  const names = await readdir(join(dir, 'repo-a', 'findings'))
  assert.deepEqual(names.sort(), ['group__project__240.1.jsonl', 'group__project__240.jsonl'], '只保留一代')
  assert.equal((await linesOf(rolled)).length, 1)
  assert.equal((await linesOf(active)).length, 1)
  await rm(dir, { recursive: true, force: true })
})

test('失败兜底：目录创建失败时 record 不抛，只 log warn（不打断绑定 / 监视 / 回帖）', async () => {
  const dir = await tmp()
  await mkdir(join(dir, 'repo-a'), { recursive: true })
  // 用一个普通文件占住 findings 目录位置，mkdir 必然失败。
  await writeFile(join(dir, 'repo-a', 'findings'), 'blocked', 'utf8')
  const warnings = []
  const store = createFindingsStore({ dir, logger: { warn: (line) => warnings.push(line) }, now: () => NOW })
  await store.record(stateOf({ rounds: [roundOf({ blocking: [finding()] })] }))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /findings 写入失败/)
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// service 接线：bind / applySnapshot / postWaiver 三个触发点，fire-and-forget
// ---------------------------------------------------------------------------
const blockingReview = (fids) => {
  const items = fids.map((fid, index) => [
    `${index + 1}. **文件**: \`src/a.js\``,
    `   - FID: \`${fid}\``,
    '   - 复验次数: `0`',
    '   - 级别: 中',
    '   - 门禁分类: 逻辑错误',
    '   - 位置: `src/a.js:1`',
    `   - 问题: 问题 ${fid}`,
    '   - 建议: 修复',
  ].join('\n')).join('\n')
  return `## AI Code Review (feat-x -> feature-y)\n\n结论: **需要修改**\n\n历史未收敛: \`0\` 条\n\n### 需要关注的问题\n${items}\n`
}

const passReview = (sha) => `## AI Code Review (feat-x -> feature-y)\n\n结论: **可直接合并**\n\n历史未收敛: \`0\` 条\n\n未发现必须修改的代码问题。\n\n<!-- AI_REVIEW_SHA ${sha} -->\n`

const reviewNotes = (fids = ['aaaa000001']) => [
  { id: 11, system: false, created_at: '2026-11-16T10:02:00Z', body: blockingReview(fids) },
]

const mrOf = (over = {}) => ({
  iid: 240,
  sha: SHA_A,
  state: 'opened',
  draft: false,
  has_conflicts: false,
  detailed_merge_status: 'mergeable',
  user_notes_count: 1,
  source_branch: 'feat-x',
  target_branch: 'feature-y',
  head_pipeline: { status: 'success', created_at: '2026-11-16T09:59:00Z' },
  ...over,
})

const BIND_URL = 'https://git.x.com/group/project/-/merge_requests/240'
const REPO_ROOT = '/work/repo-a'

function makeGitlab({ fids = ['aaaa000001'] } = {}) {
  let mr = mrOf()
  let notes = reviewNotes(fids)
  const posted = []
  const gitlab = {
    getMergeRequest: async () => mr,
    listNotes: async () => notes,
    listDiscussions: async () => [],
    listPipelines: async () => [],
    postNote: async ({ body }) => {
      const note = { id: 901 + posted.length, body, created_at: '2026-11-16T10:10:00Z' }
      posted.push(note)
      return note
    },
  }
  return {
    gitlab,
    posted,
    getMr: () => mr,
    setMr: (over) => { mr = { ...mr, ...over } },
    getNotes: () => notes,
    setNotes: (next) => { notes = next },
  }
}

function serviceOf({ dir, gitlab, findings, logger }) {
  return createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger: createLedger({ dir: join(dir, 'ledger') }),
    gitlab,
    repoState: async () => ({ root: REPO_ROOT, host: 'git.x.com', projectPath: 'group/project', branch: 'feat-x' }),
    now: () => NOW,
    findings,
    logger: logger ?? { warn: () => {} },
  })
}

const findingsDirOf = (dir) => join(dir, 'findings')

test('service：bind 成功即落一条 open（fire-and-forget，await flush 后可读）', async () => {
  const dir = await tmp()
  const g = makeGitlab()
  const store = createFindingsStore({ dir: findingsDirOf(dir), now: () => NOW })
  const service = serviceOf({ dir, gitlab: g.gitlab, findings: store })
  const { report } = await service.bind({ sessionId: 's1', url: BIND_URL, repoRoot: REPO_ROOT })
  assert.match(report, /MR !240/)
  await store.flush()
  const lines = await linesOf(expectedFile(findingsDirOf(dir), 'repo-a', 'group/project', 240))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].status, 'open')
  assert.equal(lines[0].fid, 'aaaa000001')
  await service.stop({ sessionId: 's1' })
  await rm(dir, { recursive: true, force: true })
})

test('service：applySnapshot 同 sha 指令到达 → 追加 waived；同内容再快照不追加', async () => {
  const dir = await tmp()
  const g = makeGitlab()
  const store = createFindingsStore({ dir: findingsDirOf(dir), now: () => NOW })
  const service = serviceOf({ dir, gitlab: g.gitlab, findings: store })
  await service.bind({ sessionId: 's1', url: BIND_URL, repoRoot: REPO_ROOT })
  await store.flush()

  g.setNotes([
    ...reviewNotes(),
    { id: 21, system: false, created_at: '2026-11-16T10:05:00Z', body: '#ai-waive aaaa000001 reason=已评估：本 MR 不涉及\n' },
  ])
  service.applySnapshot({ sessionId: 's1', mr: g.getMr(), notes: g.getNotes() })
  await store.flush()
  const file = expectedFile(findingsDirOf(dir), 'repo-a', 'group/project', 240)
  let lines = await linesOf(file)
  assert.equal(lines.length, 2)
  assert.equal(lines[1].status, 'waived')
  assert.deepEqual(lines[1].instruction, { kind: 'waive', reason: '已评估：本 MR 不涉及', noteId: 21 })

  service.applySnapshot({ sessionId: 's1', mr: g.getMr(), notes: g.getNotes() })
  await store.flush()
  lines = await linesOf(file)
  assert.equal(lines.length, 2, '同状态快照不重复追加')
  await service.stop({ sessionId: 's1' })
  await rm(dir, { recursive: true, force: true })
})

test('service：新 sha + 完整新一轮评审（FID 消失）→ applySnapshot 追加 fixed', async () => {
  const dir = await tmp()
  const g = makeGitlab()
  const store = createFindingsStore({ dir: findingsDirOf(dir), now: () => NOW })
  const service = serviceOf({ dir, gitlab: g.gitlab, findings: store })
  await service.bind({ sessionId: 's1', url: BIND_URL, repoRoot: REPO_ROOT })
  await store.flush()

  g.setMr({ sha: SHA_B, head_pipeline: { status: 'success', created_at: '2026-11-16T10:20:00Z' }, user_notes_count: 1 })
  g.setNotes([{ id: 21, system: false, created_at: '2026-11-16T10:22:00Z', body: passReview(SHA_B) }])
  service.applySnapshot({ sessionId: 's1', mr: g.getMr(), notes: g.getNotes() })
  await store.flush()
  const lines = await linesOf(expectedFile(findingsDirOf(dir), 'repo-a', 'group/project', 240))
  assert.equal(lines.length, 2)
  assert.equal(lines[1].status, 'fixed')
  assert.equal(lines[1].round, 2)
  assert.equal(lines[1].sha, SHA_B)
  await service.stop({ sessionId: 's1' })
  await rm(dir, { recursive: true, force: true })
})

test('service：新 sha 评审还没出 → 不把上一轮 FID 写成 fixed（C1）', async () => {
  const dir = await tmp()
  const g = makeGitlab()
  const store = createFindingsStore({ dir: findingsDirOf(dir), now: () => NOW })
  const service = serviceOf({ dir, gitlab: g.gitlab, findings: store })
  await service.bind({ sessionId: 's1', url: BIND_URL, repoRoot: REPO_ROOT })
  await store.flush()

  g.setMr({ sha: SHA_B, head_pipeline: { status: 'running', created_at: '2026-11-16T10:20:00Z' }, user_notes_count: 0 })
  g.setNotes([])
  service.applySnapshot({ sessionId: 's1', mr: g.getMr(), notes: [] })
  await store.flush()
  const lines = await linesOf(expectedFile(findingsDirOf(dir), 'repo-a', 'group/project', 240))
  assert.equal(lines.length, 1, '评审未出时不能追加任何行（尤其不能是 fixed）')
  assert.equal(lines[0].status, 'open')
  await service.stop({ sessionId: 's1' })
  await rm(dir, { recursive: true, force: true })
})

test('service：postWaiver 写 decisions 后追加处置状态（wontfix + instruction）', async () => {
  const dir = await tmp()
  const g = makeGitlab()
  const store = createFindingsStore({ dir: findingsDirOf(dir), now: () => NOW })
  const service = serviceOf({ dir, gitlab: g.gitlab, findings: store })
  await service.bind({ sessionId: 's1', url: BIND_URL, repoRoot: REPO_ROOT })
  await store.flush()
  service.waiverDraft({ sessionId: 's1', fid: 'aaaa000001', kind: 'wontfix', reason: '业务决定不修' })
  const result = await service.postWaiver({
    sessionId: 's1', fid: 'aaaa000001', kind: 'wontfix', reason: '业务决定不修', post: true,
  })
  assert.equal(result.posted, true)
  await store.flush()
  const lines = await linesOf(expectedFile(findingsDirOf(dir), 'repo-a', 'group/project', 240))
  assert.equal(lines.length, 2)
  assert.equal(lines[1].status, 'wontfix')
  assert.deepEqual(lines[1].instruction, { kind: 'wontfix', reason: '业务决定不修', noteId: 901 })
  await service.stop({ sessionId: 's1' })
  await rm(dir, { recursive: true, force: true })
})

test('service：findings.record 同步抛错时 bind / applySnapshot / postWaiver 仍成功，只 warn', async () => {
  const dir = await tmp()
  const g = makeGitlab()
  const warnings = []
  const findings = { record: () => { throw new Error('disk full') } }
  const service = serviceOf({ dir, gitlab: g.gitlab, findings, logger: { warn: (line) => warnings.push(line) } })

  const { report } = await service.bind({ sessionId: 's1', url: BIND_URL, repoRoot: REPO_ROOT })
  assert.match(report, /MR !240/)
  const snapshot = service.applySnapshot({ sessionId: 's1', mr: g.getMr(), notes: g.getNotes() })
  assert.equal(snapshot.state.round.n, 1)
  service.waiverDraft({ sessionId: 's1', fid: 'aaaa000001', kind: 'waive', reason: '已评估' })
  const result = await service.postWaiver({ sessionId: 's1', fid: 'aaaa000001', kind: 'waive', reason: '已评估', post: true })
  assert.equal(result.posted, true)

  assert.ok(warnings.filter((line) => line.includes('findings 写入失败')).length >= 3)
  await service.stop({ sessionId: 's1' })
  await rm(dir, { recursive: true, force: true })
})

test('service：findings.record 返回 rejected Promise 时同样只 warn，不产生 unhandled rejection', async () => {
  const dir = await tmp()
  const g = makeGitlab()
  const warnings = []
  const findings = { record: async () => { throw new Error('EACCES') } }
  const service = serviceOf({ dir, gitlab: g.gitlab, findings, logger: { warn: (line) => warnings.push(line) } })
  await service.bind({ sessionId: 's1', url: BIND_URL, repoRoot: REPO_ROOT })
  service.applySnapshot({ sessionId: 's1', mr: g.getMr(), notes: g.getNotes() })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(warnings.filter((line) => line.includes('findings 写入失败')).length >= 2)
  await service.stop({ sessionId: 's1' })
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 面板回落：collectFindings 可以「看更早的一轮」，但落盘路径永远只看最后一轮
// ---------------------------------------------------------------------------

test('collectFindings：roundIndex 指定看哪一轮；回落只改展示，不改「fixed 相对哪一轮」', () => {
  const first = roundOf({ blocking: [finding({ fid: 'AAAA' })] })
  const second = roundOf({ sha: SHA_B, n: 2, blocking: [], verdict: 'pass' })
  const pending = { ...roundOf({ sha: 'c'.repeat(40), n: 3 }), review: null }
  const record = stateOf({ rounds: [first, second, pending] })

  // 缺省 = 最后一轮（评审未出）→ 空，与旧行为一致：落盘走这条，绝不把上一轮当已修。
  assert.deepEqual(collectFindings(record), [])
  // 显式看第 2 轮：上一轮的 AAAA 在那一轮已消失 → fixed，并记下 fixedAtRound=2。
  assert.deepEqual(
    collectFindings(record, { roundIndex: 1 }).map((item) => [item.fid, item.status, item.fixedAtRound]),
    [['AAAA', 'fixed', 2]],
  )
  // 看第 1 轮：当时 AAAA 还是 open。
  assert.deepEqual(collectFindings(record, { roundIndex: 0 }).map((item) => [item.fid, item.status]), [['AAAA', 'open']])
  // 非法下标回落最后一轮，不抛错。
  assert.deepEqual(collectFindings(record, { roundIndex: 9 }), [])
  assert.deepEqual(collectFindings(record, { roundIndex: -1 }), [])

  // 「该看哪一轮」：当前轮评审没落地 → 回落到最近一次落地的评审（第 2 轮）。
  assert.equal(settledRoundIndex(record), 1)
  assert.equal(displayRoundIndex(record), 1)
  // 当前轮评审已落地 → 就是当前轮。
  assert.equal(displayRoundIndex(stateOf({ rounds: [first, second] })), 1)
  // 一条评审都没落地 → -1（面板显示空，而不是假装有结论）。
  assert.equal(displayRoundIndex(stateOf({ rounds: [pending] })), -1)
  assert.equal(settledRoundIndex(stateOf({ rounds: [pending] })), -1)
})

test('resolveFindings：历史轮里后来被修好的 FID 改判 fixed（带确认轮），仍在最新评审里的保持 open', () => {
  const first = roundOf({ n: 1, blocking: [finding({ fid: 'AAAA' })] })
  const second = roundOf({ sha: SHA_B, n: 2, blocking: [] })
  const third = roundOf({ sha: 'c'.repeat(40), n: 3, blocking: [finding({ fid: 'CCCC' })], verdict: 'pass' })
  const record = stateOf({ rounds: [first, second, third] })

  // 第 1 轮视角：AAAA 在第 2 轮消失 → fixed@2。
  const firstView = resolveFindings(collectFindings(record, { roundIndex: 0 }), record, 0)
  assert.deepEqual(firstView.map((item) => [item.fid, item.status, item.fixedAtRound]), [['AAAA', 'fixed', 2]])

  // 看最新一轮：后面没有已落地评审，原样返回（open 保持 open）。
  const lastView = resolveFindings(collectFindings(record, { roundIndex: 2 }), record, 2)
  assert.deepEqual(lastView.map((item) => [item.fid, item.status]), [['CCCC', 'open']])

  // 中间轮（第 2 轮）视图：本轮没提新问题，但「第 1 轮那条被本轮确认修好」→ fixed@2。
  assert.deepEqual(
    resolveFindings(collectFindings(record, { roundIndex: 1 }), record, 1).map((item) => [item.fid, item.status, item.fixedAtRound]),
    [['AAAA', 'fixed', 2]],
  )

  // 在最新评审里还在的 FID 不能被历史轮视图误判成已修。
  const stillOpen = { ...record }
  stillOpen.rounds = [first, second, roundOf({ sha: 'c'.repeat(40), n: 3, blocking: [finding({ fid: 'AAAA' })], verdict: 'pass' })]
  const view = resolveFindings(collectFindings(stillOpen, { roundIndex: 0 }), stillOpen, 0)
  assert.deepEqual(view.map((item) => [item.fid, item.status]), [['AAAA', 'open']])
})
