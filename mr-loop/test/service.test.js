import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/host/config.js'
import { createLedger } from '../src/host/ledger.js'
import { createService, ServiceError } from '../src/host/service.js'
import { createWatcher } from '../src/host/watcher.js'

const SHA = 'a'.repeat(40)
const NOW = Date.parse('2026-11-13T10:10:00Z')
const reviewPass = `## AI Code Review (feat-x -> feature-y)\n\n结论: **可直接合并**\n\n历史未收敛: \`0\` 条\n\n未发现必须修改的代码问题。\n`
const sensitivePass = 'Sensitive Content Gate\n\n结论: 门禁通过\n\n扫描结果：共 15 条命中；历史豁免 15 条；当前有效 0 条。\n'
/** 构造一条「需要修改」评审，blocking 的 FID 由调用方给定（可重复、可乱序）。 */
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
const blockingNotes = (fids) => [
  { id: 11, system: false, created_at: '2026-11-13T10:02:00Z', body: blockingReview(fids) },
]

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

test('forget 删除账本失败 → storage-failed 且保留绑定', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger: createLedger({ dir }),
    gitlab: harness().gitlab,
    repoState: harness().repoImpl,
    now: () => Date.parse('2026-11-13T10:10:00Z'),
  })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
  service.ledger.forget = async () => { throw new Error('EPERM: operation not permitted') }
  await assert.rejects(
    service.stop({ sessionId: 's', forget: true }),
    { name: 'ServiceError', code: 'storage-failed', message: /账本删除失败/ },
  )
  assert.ok(service.getState('s') !== null)
  assert.equal(service.getState('s').binding.iid, 240)
  await rm(dir, { recursive: true, force: true })
})

test('守卫计数按轮次：5 次同 sha 快照不累计 stallStreak', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const h = harness({ notesImpl: async () => blockingNotes(['aa']) })
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger: createLedger({ dir }),
    gitlab: h.gitlab,
    repoState: h.repoImpl,
    now: () => NOW,
  })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
  assert.equal(service.getState('s').round.review.blocking.length, 1)
  assert.equal(service.getState('s').stallKey, 'aa')

  for (let i = 0; i < 5; i += 1) {
    const result = service.applySnapshot({ sessionId: 's', mr: mr(), notes: blockingNotes(['aa']) })
    assert.equal(result.newRound, false)
  }
  // 同 sha 的快照（watcher 每 tick、/mr status）不得推进任何守卫计数。
  assert.equal(service.getState('s').stallStreak, 0)
  assert.equal(service.getState('s').reverifyStreak, 0)
  assert.equal(service.getState('s').stallKey, 'aa')
  await service.stop({ sessionId: 's' })
  await rm(dir, { recursive: true, force: true })
})

test('守卫计数按轮次：连续 3 个新 sha 阻塞集合相同 → stallStreak 3', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const h = harness({ notesImpl: async () => blockingNotes(['aa']) })
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger: createLedger({ dir }),
    gitlab: h.gitlab,
    repoState: h.repoImpl,
    now: () => NOW,
  })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })

  for (const char of ['b', 'c', 'd']) {
    const result = service.applySnapshot({ sessionId: 's', mr: mr({ sha: char.repeat(40) }), notes: blockingNotes(['aa']) })
    assert.equal(result.newRound, true)
  }
  // 绑定轮是基线；之后连续 3 轮同集合才到阈值（stallRounds 默认 3）。
  assert.equal(service.getState('s').stallStreak, 3)
  await service.stop({ sessionId: 's' })
  await rm(dir, { recursive: true, force: true })
})

test('守卫计数按轮次：新 sha 的阻塞集合变小即清零', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const h = harness({ notesImpl: async () => blockingNotes(['aa', 'bb']) })
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger: createLedger({ dir }),
    gitlab: h.gitlab,
    repoState: h.repoImpl,
    now: () => NOW,
  })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
  for (const char of ['b', 'c', 'd']) {
    service.applySnapshot({ sessionId: 's', mr: mr({ sha: char.repeat(40) }), notes: blockingNotes(['aa', 'bb']) })
  }
  assert.equal(service.getState('s').stallStreak, 3)

  const reset = service.applySnapshot({ sessionId: 's', mr: mr({ sha: 'e'.repeat(40) }), notes: blockingNotes(['aa']) })
  assert.equal(reset.newRound, true)
  assert.equal(service.getState('s').stallStreak, 0)
  assert.equal(service.getState('s').stallKey, 'aa')
  await service.stop({ sessionId: 's' })
  await rm(dir, { recursive: true, force: true })
})

test('守卫计数：阻塞集合比较忽略顺序与重复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const h = harness({ notesImpl: async () => blockingNotes(['aa', 'bb']) })
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger: createLedger({ dir }),
    gitlab: h.gitlab,
    repoState: h.repoImpl,
    now: () => NOW,
  })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })

  service.applySnapshot({ sessionId: 's', mr: mr({ sha: 'b'.repeat(40) }), notes: blockingNotes(['bb', 'aa', 'aa']) })
  assert.equal(service.getState('s').stallStreak, 1)
  service.applySnapshot({ sessionId: 's', mr: mr({ sha: 'c'.repeat(40) }), notes: blockingNotes(['bb', 'aa', 'bb']) })
  assert.equal(service.getState('s').stallStreak, 2)
  await service.stop({ sessionId: 's' })
  await rm(dir, { recursive: true, force: true })
})

test('resume 清零守卫计数并落盘：下一个 tick 不再暂停', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const config = resolveConfig({ baseUrl: 'https://git.x.com' })
  let current = NOW
  const h = harness({ notesImpl: async () => blockingNotes(['aa']) })
  const service = createService({
    config,
    ledger: createLedger({ dir }),
    gitlab: h.gitlab,
    repoState: h.repoImpl,
    now: () => current,
  })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })

  // 连推 3 个同集合的 sha：stallStreak 到阈值，watcher 下一 tick 应按守卫暂停。
  for (const char of ['b', 'c', 'd']) {
    current += 1000
    service.applySnapshot({ sessionId: 's', mr: mr({ sha: char.repeat(40) }), notes: blockingNotes(['aa']) })
  }
  assert.equal(service.getState('s').stallStreak, 3)

  const notified = []
  const watcher = createWatcher({
    cfg: config,
    gitlab: { getMergeRequest: async () => mr({ sha: 'd'.repeat(40) }), listNotes: async () => blockingNotes(['aa']) },
    service,
    notify: ({ text }) => notified.push(text),
    now: () => current,
    setTimer: () => 1,
    clearTimer: () => {},
  })

  await watcher.tick('s')
  assert.equal(service.getState('s').paused?.reason, 'stalled')
  assert.equal(notified.length, 1)

  await service.resume({ sessionId: 's' })
  assert.equal(service.getState('s').paused, null)
  assert.equal(service.getState('s').stallStreak, 0)
  assert.equal(service.getState('s').reverifyStreak, 0)
  assert.equal(service.getState('s').stallKey, 'aa')
  assert.equal(service.getState('s').startedAt, current)

  // 恢复后的第一个 tick：同 sha、无新证据，守卫不能再按暂停时的 streak 立刻重停。
  await watcher.tick('s')
  assert.equal(service.getState('s').paused, null)
  await service.stop({ sessionId: 's' })
  await rm(dir, { recursive: true, force: true })
})

test('resume 落盘失败 → storage-failed，但内存状态不留在 paused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger: createLedger({ dir }),
    gitlab: harness().gitlab,
    repoState: harness().repoImpl,
    now: () => NOW,
  })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
  service.pause({ sessionId: 's', reason: 'stalled' })
  assert.equal(service.getState('s').paused.reason, 'stalled')
  // pause 的落盘是 fire-and-forget：先排到写队列末尾排空它，再替换 save，
  // 否则测试清理 rm 会与在途的 tmp+rename 竞争（ENOTEMPTY 抖动）。
  await service.ledger.save({
    binding: service.getState('s').binding,
    rounds: service.getState('s').rounds,
    decisions: {},
  })

  service.ledger.save = async () => { throw new Error('EACCES') }
  await assert.rejects(service.resume({ sessionId: 's' }), { name: 'ServiceError', code: 'storage-failed' })
  assert.equal(service.getState('s').paused, null)
  assert.equal(service.getState('s').stallStreak, 0)
  await service.stop({ sessionId: 's' })
  await rm(dir, { recursive: true, force: true })
})
