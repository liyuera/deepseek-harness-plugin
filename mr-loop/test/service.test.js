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
const reviewPass = (sha) => `## AI Code Review (feat-x -> feature-y)\n\n结论: **可直接合并**\n\n历史未收敛: \`0\` 条\n\n未发现必须修改的代码问题。\n\n<!-- AI_REVIEW_SHA ${sha} -->\n`
const sensitivePass = 'Sensitive Content Gate\n\n结论: 门禁通过\n\n扫描结果：共 15 条命中；历史豁免 15 条；当前有效 0 条。\n'
const sensitiveBlock = 'Sensitive Content Gate\n\n结论: **阻止合并**\n\n扫描结果：共 15 条命中；历史豁免 0 条；当前有效 15 条。\n阻断项: 15 条\n'
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
const notes = (sha = SHA) => ([
  { id: 11, system: false, created_at: '2026-11-13T10:02:00Z', body: reviewPass(sha) },
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

  const arrived = service.applySnapshot({ sessionId: 's', mr: current, notes: notes(current.sha) })
  assert.equal(arrived.newRound, false)
  assert.equal(arrived.reviewArrived, true)
  await service.stop({ sessionId: 's' })
  await rm(dir, { recursive: true, force: true })
})

test('同 sha 门禁翻面：gatesChanged 触发一次唤醒，报告带敏感行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const reviewNote = { id: 11, system: false, created_at: '2026-11-13T10:02:00Z', body: reviewPass(SHA) }
  const blockNote = { id: 12, system: false, created_at: '2026-11-13T10:05:00Z', body: sensitiveBlock }
  let currentMr = mr({ user_notes_count: 1 })
  let currentNotes = [reviewNote]
  const gitlab = { getMergeRequest: async () => currentMr, listNotes: async () => currentNotes, listDiscussions: async () => [], listPipelines: async () => [] }
  const config = resolveConfig({ baseUrl: 'https://git.x.com' })
  const service = createService({
    config,
    ledger: createLedger({ dir }),
    gitlab,
    repoState: async () => ({ root: '/r', host: 'git.x.com', projectPath: 'g/p', branch: 'feat-x' }),
    now: () => NOW,
  })
  const { report } = await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
  assert.match(report, /评审 {3}✅ 可直接合并/)

  // 同一份 notes 再并一次：三套门禁都没变。
  const unchanged = service.applySnapshot({ sessionId: 's', mr: currentMr, notes: currentNotes })
  assert.equal(unchanged.reviewArrived, false)
  assert.equal(unchanged.gatesChanged, false)

  // 评审先到、敏感门禁后到且翻成 block：reviewArrived 为假，只有 gatesChanged 为真。
  currentNotes = [reviewNote, blockNote]
  currentMr = mr({ user_notes_count: 2 })
  let snapshot
  const applySnapshot = service.applySnapshot
  service.applySnapshot = (input) => { snapshot = applySnapshot(input); return snapshot }

  const notified = []
  const watcher = createWatcher({
    cfg: config,
    gitlab,
    service,
    notify: ({ text }) => { notified.push(text); return true },
    now: () => NOW,
    setTimer: () => 1,
    clearTimer: () => {},
  })
  await watcher.tick('s')

  assert.equal(snapshot.gatesChanged, true)
  assert.equal(snapshot.reviewArrived, false)
  assert.equal(notified.length, 1)
  assert.match(notified[0], /敏感 {3}⛔ 阻止合并/)
  await service.stop({ sessionId: 's' })
  await rm(dir, { recursive: true, force: true })
})

test('新 sha 门禁先到、评审未出：gatesChanged 为真也不唤醒', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const SHA2 = 'c'.repeat(40)
  const reviewNote = { id: 11, system: false, created_at: '2026-11-13T10:02:00Z', body: reviewPass(SHA) }
  const gateNote = { id: 12, system: false, created_at: '2026-11-13T10:05:00Z', body: sensitivePass }
  let currentMr = mr({ user_notes_count: 1 })
  let currentNotes = [reviewNote]
  const gitlab = { getMergeRequest: async () => currentMr, listNotes: async () => currentNotes, listDiscussions: async () => [], listPipelines: async () => [] }
  const config = resolveConfig({ baseUrl: 'https://git.x.com' })
  const service = createService({
    config,
    ledger: createLedger({ dir }),
    gitlab,
    repoState: async () => ({ root: '/r', host: 'git.x.com', projectPath: 'g/p', branch: 'feat-x' }),
    now: () => NOW,
  })
  const url = 'https://git.x.com/g/p/-/merge_requests/240'
  await service.bind({ sessionId: 's', url, repoRoot: '/r' })

  // 新 sha 的首个快照只有门禁 note：评审还没出，gatesChanged 只是门禁「先到」。
  currentMr = mr({ sha: SHA2, user_notes_count: 1 })
  currentNotes = [gateNote]
  let snapshot
  const applySnapshot = service.applySnapshot
  service.applySnapshot = (input) => { snapshot = applySnapshot(input); return snapshot }

  const notified = []
  const watcher = createWatcher({
    cfg: config,
    gitlab,
    service,
    notify: ({ text }) => { notified.push(text); return true },
    now: () => NOW,
    setTimer: () => 1,
    clearTimer: () => {},
  })
  await watcher.tick('s')

  assert.equal(snapshot.newRound, true)
  assert.equal(snapshot.state.round.review, null)
  assert.equal(snapshot.gatesChanged, true)
  assert.equal(notified.length, 0)
  await service.stop({ sessionId: 's' })
  await rm(dir, { recursive: true, force: true })
})

test('未绑定 → not-bound；同 sha 重复绑定复用轮次，不新增', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const service = createService({ config: resolveConfig({ baseUrl: 'https://git.x.com' }), ledger: createLedger({ dir }), gitlab: harness().gitlab, repoState: harness().repoImpl, now: () => Date.parse('2026-11-13T10:10:00Z') })
  await assert.rejects(service.status({ sessionId: 'nobody' }), (e) => e.code === 'not-bound')
  const url = 'https://git.x.com/g/p/-/merge_requests/240'
  await service.bind({ sessionId: 's', url, repoRoot: '/r' })
  // 空账本的首次绑定就是第 1 轮。
  assert.equal(service.getState('s').round.n, 1)
  assert.equal(service.getState('s').rounds.length, 1)

  // head sha 没变：第二次绑定应覆盖账本最后一条，轮次号与条数都不变。
  await service.bind({ sessionId: 's', url, repoRoot: '/r' })
  const state = service.getState('s')
  assert.equal(state.round.n, 1)
  assert.equal(state.round.sha, SHA)
  assert.deepEqual(state.rounds.map((item) => item.n), [1])
  const saved = await service.ledger.load({ projectPath: 'g/p', iid: 240 })
  assert.deepEqual(saved.rounds.map((item) => item.n), [1])
  assert.equal(saved.rounds[0].sha, SHA)
  await rm(dir, { recursive: true, force: true })
})

test('MR 换 sha 后再 bind：轮次 +1、账本追加', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const SHA2 = 'b'.repeat(40)
  let current = mr()
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger: createLedger({ dir }),
    gitlab: { ...harness().gitlab, getMergeRequest: async () => current, listNotes: async () => notes(current.sha) },
    repoState: harness().repoImpl,
    now: () => Date.parse('2026-11-13T10:10:00Z'),
  })
  const url = 'https://git.x.com/g/p/-/merge_requests/240'
  await service.bind({ sessionId: 's', url, repoRoot: '/r' })
  assert.equal(service.getState('s').round.n, 1)

  current = mr({ sha: SHA2 })
  await service.bind({ sessionId: 's', url, repoRoot: '/r' })
  const state = service.getState('s')
  assert.equal(state.round.n, 2)
  assert.equal(state.round.sha, SHA2)
  assert.deepEqual(state.rounds.map((item) => item.n), [1, 2])
  const saved = await service.ledger.load({ projectPath: 'g/p', iid: 240 })
  assert.deepEqual(saved.rounds.map((item) => item.n), [1, 2])
  assert.equal(saved.rounds[1].sha, SHA2)
  await rm(dir, { recursive: true, force: true })
})

test('同 sha 重复绑定保留上一轮 observedAt 基线，不往后推', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  let current = NOW
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger: createLedger({ dir }),
    gitlab: harness().gitlab,
    repoState: harness().repoImpl,
    now: () => current,
  })
  const url = 'https://git.x.com/g/p/-/merge_requests/240'
  await service.bind({ sessionId: 's', url, repoRoot: '/r' })
  const firstObservedAt = service.getState('s').round.observedAt
  assert.equal(firstObservedAt, NOW)

  current += 3_600_000
  await service.bind({ sessionId: 's', url, repoRoot: '/r' })
  const state = service.getState('s')
  assert.equal(state.round.n, 1)
  // observedAt 是弱绑定的兜底基线：重复绑定不能把基线后移、削弱弱绑定证据。
  assert.equal(state.round.observedAt, firstObservedAt)
  const saved = await service.ledger.load({ projectPath: 'g/p', iid: 240 })
  assert.equal(saved.rounds[saved.rounds.length - 1].observedAt, firstObservedAt)
  await rm(dir, { recursive: true, force: true })
})

test('mr.sha 缺失或空串时不误复用已有轮次', async () => {
  for (const sha of [undefined, '']) {
    const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
    const ledger = createLedger({ dir })
    await ledger.save({
      binding: { projectPath: 'g/p', iid: 240 },
      rounds: [{ n: 7, sha, observedAt: NOW }],
      decisions: {},
    })
    const service = createService({
      config: resolveConfig({ baseUrl: 'https://git.x.com' }),
      ledger,
      gitlab: { ...harness().gitlab, getMergeRequest: async () => mr({ sha }) },
      repoState: harness().repoImpl,
      now: () => NOW,
    })
    await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
    const state = service.getState('s')
    assert.equal(state.round.n, 8, `sha=${String(sha)} 时不应复用轮次号`)
    assert.deepEqual(state.rounds.map((item) => item.n), [7, 8])
    await rm(dir, { recursive: true, force: true })
  }
})

test('同 sha 重绑收敛账本尾部连续重复轮次：保留最小 n 与首次观测基线', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const ledger = createLedger({ dir })
  const firstObservedAt = NOW - 3000
  await ledger.save({
    binding: { projectPath: 'g/p', iid: 240 },
    rounds: [1, 2, 3, 4].map((n, index) => ({ n, sha: SHA, observedAt: firstObservedAt + index * 1000 })),
    decisions: {},
  })
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger,
    gitlab: harness().gitlab,
    repoState: harness().repoImpl,
    now: () => NOW,
  })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
  const state = service.getState('s')
  // 脏账本 [1(S),2(S),3(S),4(S)] 收敛成一条，轮次号取最早那条。
  assert.equal(state.round.n, 1)
  assert.equal(state.round.observedAt, firstObservedAt)
  assert.deepEqual(state.rounds.map((item) => item.n), [1])
  assert.equal(state.rounds[0].sha, SHA)
  const saved = await service.ledger.load({ projectPath: 'g/p', iid: 240 })
  assert.deepEqual(saved.rounds.map((item) => item.n), [1])
  await rm(dir, { recursive: true, force: true })
})

test('同 sha 重绑只收敛尾部连续段，前面不同 sha 的轮次原样保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const SHA2 = 'b'.repeat(40)
  const ledger = createLedger({ dir })
  const firstObservedAt = NOW - 4000
  await ledger.save({
    binding: { projectPath: 'g/p', iid: 240 },
    rounds: [
      { n: 1, sha: SHA, observedAt: firstObservedAt },
      { n: 2, sha: SHA2, observedAt: firstObservedAt + 1000 },
      { n: 3, sha: SHA2, observedAt: firstObservedAt + 2000 },
    ],
    decisions: {},
  })
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger,
    gitlab: { ...harness().gitlab, getMergeRequest: async () => mr({ sha: SHA2 }) },
    repoState: harness().repoImpl,
    now: () => NOW,
  })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
  const state = service.getState('s')
  assert.equal(state.round.n, 2)
  assert.equal(state.round.observedAt, firstObservedAt + 1000)
  assert.deepEqual(state.rounds.map((item) => item.n), [1, 2])
  assert.deepEqual(state.rounds.map((item) => item.sha), [SHA, SHA2])
  await rm(dir, { recursive: true, force: true })
})

test('同 sha 脏账本尾段含坏 n 时收敛为最小合法 n，不先涨后回退', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const ledger = createLedger({ dir })
  await ledger.save({
    binding: { projectPath: 'g/p', iid: 240 },
    rounds: [
      { n: 5, sha: SHA, observedAt: NOW - 5000 },
      { n: 'x', sha: SHA, observedAt: NOW - 1000 },
    ],
    decisions: {},
  })
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger,
    gitlab: harness().gitlab,
    repoState: harness().repoImpl,
    now: () => NOW,
  })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
  const state = service.getState('s')
  // 收敛段里只保留 n 最小的合法条目：坏尾条不算「先涨到 6 再回退」。
  assert.equal(state.round.n, 5)
  assert.deepEqual(state.rounds.map((item) => item.n), [5])
  const saved = await service.ledger.load({ projectPath: 'g/p', iid: 240 })
  assert.deepEqual(saved.rounds.map((item) => item.n), [5])
  await rm(dir, { recursive: true, force: true })
})

test('脏账本尾段同 sha + 新 sha 重绑：先收敛再新增，n 不虚高', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const SHA2 = 'b'.repeat(40)
  const ledger = createLedger({ dir })
  const firstObservedAt = NOW - 4000
  await ledger.save({
    binding: { projectPath: 'g/p', iid: 240 },
    rounds: [1, 2, 3, 4].map((n, index) => ({ n, sha: SHA, observedAt: firstObservedAt + index * 1000 })),
    decisions: {},
  })
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger,
    gitlab: { ...harness().gitlab, getMergeRequest: async () => mr({ sha: SHA2 }) },
    repoState: harness().repoImpl,
    now: () => NOW,
  })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
  const state = service.getState('s')
  assert.equal(state.round.n, 2)
  assert.deepEqual(state.rounds.map((item) => item.n), [1, 2])
  assert.deepEqual(state.rounds.map((item) => item.sha), [SHA, SHA2])
  await rm(dir, { recursive: true, force: true })
})

test('账本最后一条 n=0 不复用，走新增路径', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const ledger = createLedger({ dir })
  await ledger.save({
    binding: { projectPath: 'g/p', iid: 240 },
    rounds: [{ n: 0, sha: SHA, observedAt: NOW - 1000 }],
    decisions: {},
  })
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger,
    gitlab: harness().gitlab,
    repoState: harness().repoImpl,
    now: () => NOW,
  })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
  const state = service.getState('s')
  assert.equal(state.round.n, 1)
  assert.deepEqual(state.rounds.map((item) => item.n), [0, 1])
  await rm(dir, { recursive: true, force: true })
})

test('账本最后一条 n 为负数时也不复用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const ledger = createLedger({ dir })
  await ledger.save({
    binding: { projectPath: 'g/p', iid: 240 },
    rounds: [{ n: -3, sha: SHA, observedAt: NOW - 1000 }],
    decisions: {},
  })
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger,
    gitlab: harness().gitlab,
    repoState: harness().repoImpl,
    now: () => NOW,
  })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
  const state = service.getState('s')
  assert.equal(state.round.n, 1)
  assert.deepEqual(state.rounds.map((item) => item.n), [-3, 1])
  await rm(dir, { recursive: true, force: true })
})

test('锚条缺 observedAt 时基线取段内最早有效时间，不退回 now()', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const ledger = createLedger({ dir })
  const segmentObservedAt = NOW - 5000
  await ledger.save({
    binding: { projectPath: 'g/p', iid: 240 },
    rounds: [
      { n: 1, sha: SHA },
      { n: 2, sha: SHA, observedAt: segmentObservedAt },
    ],
    decisions: {},
  })
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger,
    gitlab: harness().gitlab,
    repoState: harness().repoImpl,
    now: () => NOW,
  })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
  const state = service.getState('s')
  assert.equal(state.round.n, 1)
  assert.equal(state.round.observedAt, segmentObservedAt)
  assert.deepEqual(state.rounds.map((item) => item.n), [1])
  await rm(dir, { recursive: true, force: true })
})

test('同 sha 重绑只覆盖尾部最后一条，不收敛更早的不同 sha 轮次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const SHA2 = 'b'.repeat(40)
  const ledger = createLedger({ dir })
  const firstObservedAt = NOW - 4000
  await ledger.save({
    binding: { projectPath: 'g/p', iid: 240 },
    rounds: [
      { n: 1, sha: SHA, observedAt: firstObservedAt },
      { n: 2, sha: SHA2, observedAt: firstObservedAt + 1000 },
    ],
    decisions: {},
  })
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger,
    gitlab: { ...harness().gitlab, getMergeRequest: async () => mr({ sha: SHA2 }) },
    repoState: harness().repoImpl,
    now: () => NOW,
  })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
  const state = service.getState('s')
  assert.equal(state.round.n, 2)
  assert.equal(state.round.observedAt, firstObservedAt + 1000)
  assert.deepEqual(state.rounds.map((item) => item.n), [1, 2])
  assert.deepEqual(state.rounds.map((item) => item.sha), [SHA, SHA2])
  await rm(dir, { recursive: true, force: true })
})

test('同 sha 重绑继承 mergeableAt，新 sha 轮次不继承', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-service-'))
  const SHA2 = 'b'.repeat(40)
  const mergeableAt = '2026-11-13T10:00:00.000Z'
  const ledger = createLedger({ dir })
  await ledger.save({
    binding: { projectPath: 'g/p', iid: 240 },
    rounds: [{ n: 1, sha: SHA, observedAt: NOW - 1000 }],
    decisions: {},
    mergeableAt,
  })
  let current = mr()
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger,
    gitlab: { ...harness().gitlab, getMergeRequest: async () => current },
    repoState: harness().repoImpl,
    now: () => NOW,
  })
  const url = 'https://git.x.com/g/p/-/merge_requests/240'
  await service.bind({ sessionId: 's', url, repoRoot: '/r' })
  assert.equal(service.getState('s').mergeableAt, mergeableAt)
  const saved = await service.ledger.load({ projectPath: 'g/p', iid: 240 })
  assert.equal(saved.mergeableAt, mergeableAt)

  // 新 sha = 新一轮：不继承上一轮的 mergeableAt。
  current = mr({ sha: SHA2 })
  await service.bind({ sessionId: 's', url, repoRoot: '/r' })
  assert.equal(service.getState('s').mergeableAt, undefined)
  const resaved = await service.ledger.load({ projectPath: 'g/p', iid: 240 })
  assert.equal(resaved.mergeableAt, null)
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
  // 两次并发绑定之间 MR 已换 sha：串行执行才可能看到 [1, 2] 而不是互相覆盖。
  const SHA2 = 'b'.repeat(40)
  let calls = 0
  const mrImpl = async () => { calls += 1; return mr({ sha: calls === 1 ? SHA : SHA2 }) }
  const service = createService({
    config: resolveConfig({ baseUrl: 'https://git.x.com' }),
    ledger: createLedger({ dir }),
    gitlab: harness({ mrImpl }).gitlab,
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
