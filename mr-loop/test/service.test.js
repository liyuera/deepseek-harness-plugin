import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/host/config.js'
import { createLedger } from '../src/host/ledger.js'
import { createService, ServiceError } from '../src/host/service.js'

const SHA = 'a'.repeat(40)
const reviewPass = `## AI Code Review (feat-x -> feature-y)\n\n结论: **可直接合并**\n\n历史未收敛: \`0\` 条\n\n未发现必须修改的代码问题。\n`
const sensitivePass = 'Sensitive Content Gate\n\n结论: 门禁通过\n\n扫描结果：共 15 条命中；历史豁免 15 条；当前有效 0 条。\n'

const mr = (over = {}) => ({
  iid: 240, sha: SHA, state: 'opened', draft: false, has_conflicts: false,
  detailed_merge_status: 'mergeable', user_notes_count: 2,
  source_branch: 'feat-x', target_branch: 'feature-y',
  head_pipeline: { status: 'success', created_at: '2026-11-13T09:59:00Z' }, ...over,
})
const notes = () => ([
  { id: 11, system: false, created_at: '2026-11-13T10:02:00Z', body: reviewPass },
  { id: 12, system: false, created_at: '2026-11-13T10:03:00Z', body: sensitivePass },
])

function harness({ mrImpl = async () => mr(), notesImpl = async () => notes(), repoImpl = async () => ({ root: '/r', host: 'git.x.com', projectPath: 'g/p', branch: 'feat-x' }) } = {}) {
  return { gitlab: { getMergeRequest: mrImpl, listNotes: notesImpl, listDiscussions: async () => [], listPipelines: async () => [] }, repoImpl }
}

test('bind 成功：报告可合、账本落盘、轮次 1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const h = harness()
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger: createLedger({ dir }),
    gitlab: h.gitlab,
    repoState: h.repoImpl,
    now: () => Date.parse('2026-11-13T10:10:00Z'),
  })
  const { report, warnings } = await service.bind({ sessionId: 's1', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
  assert.match(report, /MR !240/)
  assert.match(report, /强绑定|弱绑定/)
  assert.deepEqual(warnings, [])
  const state = service.getState('s1')
  assert.equal(state.round.n, 1)
  assert.equal(state.mergeability.mergeable, true)
  const saved = await service.ledger.load({ projectPath: 'g/p', iid: 240 })
  assert.equal(saved.rounds.length, 1)
  await rm(dir, { recursive: true, force: true })
})

test('错误码：invalid-url / mr-not-open / repo-mismatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const cfg = resolveConfig({ baseUrl: 'https://git.x.com' })
  const mkService = (opts) => createService({ config: cfg, ledger: createLedger({ dir }), gitlab: harness(opts).gitlab, repoState: harness(opts).repoImpl, now: () => 1 })
  const url = 'https://git.x.com/g/p/-/merge_requests/240'

  await assert.rejects(mkService().bind({ sessionId: 's', url: 'https://evil.com/g/p/-/merge_requests/1', repoRoot: '/r' }), (e) => e instanceof ServiceError && e.code === 'invalid-url')
  await assert.rejects(mkService({ mrImpl: async () => mr({ state: 'merged' }) }).bind({ sessionId: 's', url, repoRoot: '/r' }), (e) => e.code === 'mr-not-open')
  await assert.rejects(mkService({ repoImpl: async () => ({ root: '/r', host: 'git.x.com', projectPath: 'other/repo', branch: 'x' }) }).bind({ sessionId: 's', url, repoRoot: '/r' }), (e) => e.code === 'repo-mismatch')
  await assert.rejects(mkService({ repoImpl: async () => { throw new Error('nope') } }).bind({ sessionId: 's', url, repoRoot: '/r' }), (e) => e.code === 'repo-mismatch')
  await rm(dir, { recursive: true, force: true })
})

test('origin host 与 baseUrl 不一致 → repo-mismatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger: createLedger({ dir }),
    gitlab: harness().gitlab,
    repoState: async () => ({ root: '/r', host: 'git.other.com', projectPath: 'g/p', branch: 'feat-x' }),
    now: () => 1,
  })
  await assert.rejects(
    service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' }),
    (e) => e instanceof ServiceError && e.code === 'repo-mismatch',
  )
  await rm(dir, { recursive: true, force: true })
})

test('status 重新拉取；review 返回当前轮与处置', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  let calls = 0
  const h = harness({ mrImpl: async () => { calls += 1; return mr() } })
  const service = createService({ config: resolveConfig({ baseUrl: 'https://git.x.com' }), ledger: createLedger({ dir }), gitlab: h.gitlab, repoState: h.repoImpl, now: () => Date.parse('2026-11-13T10:10:00Z') })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
  const before = calls
  const { report } = await service.status({ sessionId: 's' })
  assert.match(report, /合并/)
  assert.ok(calls > before)
  const { round, decisions } = service.review({ sessionId: 's' })
  assert.equal(round.review.verdict, 'pass')
  assert.deepEqual(decisions, {})
  // status 内部 applySnapshot 的落盘是 fire-and-forget；stop 的 await persist 排在队列后面，
  // 等它完成即可排空写队列，避免 rm 与在途写竞争（ENOTEMPTY 抖动）。
  await service.stop({ sessionId: 's' })
  await rm(dir, { recursive: true, force: true })
})

test('applySnapshot：同 sha 只刷新，新 sha 开新一轮，评审到达可识别', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  let current = mr()
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger: createLedger({ dir }),
    gitlab: { getMergeRequest: async () => current, listNotes: async () => notes(), listDiscussions: async () => [], listPipelines: async () => [] },
    repoState: async () => ({ root: '/r', host: 'git.x.com', projectPath: 'g/p', branch: 'feat-x' }),
    now: () => Date.parse('2026-11-13T10:10:00Z'),
  })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })

  const same = service.applySnapshot({ sessionId: 's', mr: current, notes: notes() })
  assert.equal(same.newRound, false)
  assert.equal(same.reviewArrived, false)
  assert.equal(same.becameMergeable, false)
  assert.equal(same.state.round.n, 1)

  current = mr({ sha: 'b'.repeat(40), detailed_merge_status: 'checking' })
  const next = service.applySnapshot({ sessionId: 's', mr: current, notes: [] })
  assert.equal(next.newRound, true)
  assert.equal(next.state.round.n, 2)
  assert.equal(next.state.mergeability.mergeable, false)
  assert.equal(next.becameMergeable, false)

  const arrived = service.applySnapshot({ sessionId: 's', mr: current, notes: notes() })
  assert.equal(arrived.newRound, false)
  assert.equal(arrived.reviewArrived, true)
  await service.stop({ sessionId: 's' })
  await rm(dir, { recursive: true, force: true })
})

test('未绑定 → not-bound；重复绑定同 MR 会新增一轮', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const service = createService({ config: resolveConfig({ baseUrl: 'https://git.x.com' }), ledger: createLedger({ dir }), gitlab: harness().gitlab, repoState: harness().repoImpl, now: () => Date.parse('2026-11-13T10:10:00Z') })
  await assert.rejects(service.status({ sessionId: 'nobody' }), (e) => e.code === 'not-bound')
  const url = 'https://git.x.com/g/p/-/merge_requests/240'
  await service.bind({ sessionId: 's', url, repoRoot: '/r' })
  await service.bind({ sessionId: 's', url, repoRoot: '/r' })
  assert.equal(service.getState('s').round.n, 2)
  await rm(dir, { recursive: true, force: true })
})

test('账本裁剪后轮次号仍单调：取已有最大 n + 1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const ledger = createLedger({ dir })
  await ledger.save({
    binding: { projectPath: 'g/p', iid: 240 },
    rounds: [{ n: 50, sha: 'a'.repeat(40) }, { n: 51, sha: 'b'.repeat(40) }],
    decisions: {},
  })
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger,
    gitlab: harness().gitlab,
    repoState: harness().repoImpl,
    now: () => Date.parse('2026-11-13T10:10:00Z'),
  })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
  assert.equal(service.getState('s').round.n, 52)
  assert.deepEqual(service.getState('s').rounds.map((item) => item.n), [50, 51, 52])
  await rm(dir, { recursive: true, force: true })
})

test('账本写入失败 → storage-failed，且不留半绑定', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const ledger = createLedger({ dir })
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger: { ...ledger, save: async () => { throw new Error('EACCES') } },
    gitlab: harness().gitlab,
    repoState: harness().repoImpl,
    now: () => 1,
  })
  await assert.rejects(
    service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' }),
    { name: 'ServiceError', code: 'storage-failed', message: /账本写入失败/ },
  )
  assert.equal(service.getState('s'), null)
  await rm(dir, { recursive: true, force: true })
})

test('并发绑定同一会话：串行执行、轮次连续、只留一个 state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger: createLedger({ dir }),
    gitlab: harness().gitlab,
    repoState: harness().repoImpl,
    now: () => Date.parse('2026-11-13T10:10:00Z'),
  })
  const url = 'https://git.x.com/g/p/-/merge_requests/240'
  const results = await Promise.allSettled([
    service.bind({ sessionId: 's', url, repoRoot: '/r' }),
    service.bind({ sessionId: 's', url, repoRoot: '/r' }),
  ])
  assert.deepEqual(results.map((item) => item.status), ['fulfilled', 'fulfilled'])
  assert.deepEqual(service.getState('s').rounds.map((item) => item.n), [1, 2])
  assert.equal(service.getState('s').round.n, 2)
  const saved = await service.ledger.load({ projectPath: 'g/p', iid: 240 })
  assert.deepEqual(saved.rounds.map((item) => item.n), [1, 2])
  await rm(dir, { recursive: true, force: true })
})
