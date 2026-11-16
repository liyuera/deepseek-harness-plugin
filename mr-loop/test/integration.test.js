/**
 * 服务层 + watcher 的真实接缝：不替身任何一方，只替换 GitLab / 时钟 / 定时器 / 账本目录。
 * 覆盖「评审先到、门禁后翻面唤醒」→「新 sha 可合停表」这条主链路。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/host/config.js'
import { createLedger } from '../src/host/ledger.js'
import { createService } from '../src/host/service.js'
import { createWatcher } from '../src/host/watcher.js'
import { createTools } from '../src/host/tools.js'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const NOW = Date.parse('2026-11-13T10:40:00Z')
const BASELINE_A = '2026-11-13T09:59:00Z'
const BASELINE_B = '2026-11-13T10:30:00Z'

/** 真实评审 note 形状：带 AI_REVIEW_SHA 标记 → 强绑定。 */
const reviewBody = ({ sha, verdict }) => {
  const items = verdict === 'changes'
    ? [
        '### 需要关注的问题',
        '1. **文件**: `src/a.js`',
        '   - FID: `aaaa0001`',
        '   - 复验次数: `0`',
        '   - 级别: 中',
        '   - 门禁分类: 逻辑错误',
        '   - 位置: `src/a.js:1`',
        '   - 问题: 问题 aaaa0001',
        '   - 建议: 修复',
      ].join('\n')
    : '未发现必须修改的代码问题。'
  return [
    '## AI Code Review (feat-x -> feature-y)',
    '',
    `结论: **${verdict === 'pass' ? '可直接合并' : '需要修改'}**`,
    '',
    '历史未收敛: `0` 条',
    '',
    items,
    '',
    `<!-- AI_REVIEW_SHA ${sha} -->`,
    '',
  ].join('\n')
}

const sensitiveBody = (verdict) => (verdict === 'pass'
  ? 'Sensitive Content Gate\n\n结论: 门禁通过\n\n扫描结果：共 15 条命中；历史豁免 15 条；当前有效 0 条。\n'
  : 'Sensitive Content Gate\n\n结论: **阻止合并**\n\n扫描结果：共 15 条命中；历史豁免 0 条；当前有效 15 条。\n阻断项: 15 条\n')

const mrOf = ({ sha, notesCount, baseline }) => ({
  iid: 240,
  sha,
  state: 'opened',
  draft: false,
  has_conflicts: false,
  detailed_merge_status: 'mergeable',
  user_notes_count: notesCount,
  source_branch: 'feat-x',
  target_branch: 'feature-y',
  head_pipeline: { id: 7181, status: 'success', created_at: baseline },
})

test('service + watcher：评审先到 → 门禁翻面唤醒 → 新 sha 可合停表，账本 2 轮', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-integration-'))
  const cfg = resolveConfig({ baseUrl: 'https://git.x.com' })
  let current = NOW

  const reviewA = { id: 11, system: false, created_at: '2026-11-13T10:02:00Z', body: reviewBody({ sha: SHA_A, verdict: 'changes' }) }
  const sensitiveBlock = { id: 12, system: false, created_at: '2026-11-13T10:05:00Z', body: sensitiveBody('block') }
  const reviewB = { id: 21, system: false, created_at: '2026-11-13T10:31:00Z', body: reviewBody({ sha: SHA_B, verdict: 'pass' }) }
  const sensitivePass = { id: 22, system: false, created_at: '2026-11-13T10:32:00Z', body: sensitiveBody('pass') }

  let mr = mrOf({ sha: SHA_A, notesCount: 1, baseline: BASELINE_A })
  let notes = [reviewA]
  const gitlab = {
    getMergeRequest: async () => mr,
    listNotes: async () => notes,
  }

  const service = createService({
    config: cfg,
    ledger: createLedger({ dir }),
    gitlab,
    repoState: async () => ({ root: '/r', host: 'git.x.com', projectPath: 'g/p', branch: 'feat-x' }),
    now: () => current,
  })

  let timerSeq = 0
  const timers = []
  const cleared = []
  const notified = []
  const watcher = createWatcher({
    cfg,
    gitlab,
    service,
    notify: ({ text }) => { notified.push(text); return true },
    now: () => current,
    setTimer: (fn, ms) => { const id = ++timerSeq; timers.push({ id, fn, ms }); return id },
    clearTimer: (id) => { cleared.push(id) },
  })

  // 1. 绑定：本轮评审已经是「需要修改」。
  const bound = await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
  assert.match(bound.report, /评审 {3}⛔ 需要修改/)
  watcher.start('s') // 等价于 service 的 onBound 回调
  assert.equal(watcher.isWatching('s'), true)

  // 2. bind 之后才出现敏感门禁 block：同 sha 只有门禁翻面，必须唤醒一次。
  notes = [reviewA, sensitiveBlock]
  mr = mrOf({ sha: SHA_A, notesCount: 2, baseline: BASELINE_A })
  await watcher.tick('s')
  assert.equal(notified.length, 1)
  assert.match(notified[0], /需要修改/)
  assert.match(notified[0], /敏感 {3}⛔ 阻止合并/)
  assert.equal(watcher.isWatching('s'), true)

  // 3. push 新 sha：强绑定 pass 评审 + 敏感 pass，门禁全绿 → 可合并并停表。
  current += 60000
  notes = [reviewA, sensitiveBlock, reviewB, sensitivePass]
  mr = mrOf({ sha: SHA_B, notesCount: 4, baseline: BASELINE_B })
  const timersBefore = timers.length
  await watcher.tick('s')

  // 4. 恰好 2 次唤醒；可合之后不再排定时器；账本落盘 2 轮。
  assert.equal(notified.length, 2)
  assert.match(notified[1], /可合/)
  assert.match(notified[1], /可合并，监视结束/)
  assert.equal(watcher.isWatching('s'), false)
  assert.equal(timers.length, timersBefore)
  assert.ok(cleared.length > 0)

  await service.stop({ sessionId: 's' })
  const saved = await service.ledger.load({ projectPath: 'g/p', iid: 240 })
  assert.equal(saved.rounds.length, 2)
  assert.deepEqual(saved.rounds.map((round) => round.n), [1, 2])
  await rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// T2 写路径真实接缝：service + tools 不替身任何一方，只替换 GitLab / 账本目录 / 时钟。
// 防「工具调用的 service 方法名 / 返回结构与真实 service 不一致」这类假 service 看不出的错。
// ---------------------------------------------------------------------------
test('T2 service + tools：mr_waive 草稿 → post → 幂等，评论只发一条、decisions 落账本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-integration-'))
  const cfg = resolveConfig({ baseUrl: 'https://git.x.com' })
  const posted = []
  const review = { id: 11, system: false, created_at: '2026-11-13T10:02:00Z', body: reviewBody({ sha: SHA_A, verdict: 'changes' }) }
  const gitlab = {
    getMergeRequest: async () => mrOf({ sha: SHA_A, notesCount: 1, baseline: BASELINE_A }),
    listNotes: async () => [review],
    postNote: async ({ body }) => {
      posted.push(body)
      return { id: 9001, body, created_at: '2026-11-13T10:40:00Z', author: { id: 7, username: 'me', name: 'Me' } }
    },
  }
  const service = createService({
    config: cfg,
    ledger: createLedger({ dir }),
    gitlab,
    repoState: async () => ({ root: '/r', host: 'git.x.com', projectPath: 'g/p', branch: 'feat-x' }),
    now: () => NOW,
  })
  await service.bind({ sessionId: 's', url: 'https://git.x.com/g/p/-/merge_requests/240', repoRoot: '/r' })
  const waive = createTools({ service }).find((tool) => tool.name === 'mr_waive')
  const exec = { agent: { session: { id: 's', header: { cwd: '/r' } } } }

  // 1. 草稿：只返回 body，不写 decisions、不发评论。
  const draft = await waive.execute({ fid: 'AAAA0001', reason: '评审误报' }, exec)
  assert.equal(draft.ok, true)
  assert.deepEqual(draft.data, { body: '#ai-waive aaaa0001 reason=评审误报', fid: 'aaaa0001', kind: 'waive', reason: '评审误报', mrLabel: 'MR !240 · g/p', posted: false })
  assert.match(waive.output.render({}, draft).map((part) => part.text).join(''), /MR !240 · g\/p 豁免草稿/)
  assert.match(waive.output.render({}, draft).map((part) => part.text).join(''), /可以 \/ 自定义/)
  assert.equal(service.getState('s').decisions.aaaa0001, undefined)
  assert.equal(posted.length, 0)

  // 2. 用户确认后 post:true：发一条评论并落 decisions。
  const post = await waive.execute({ fid: 'aaaa0001', reason: '评审误报', post: true }, exec)
  assert.equal(post.ok, true)
  assert.deepEqual(post.data, { posted: true, noteId: 9001, url: 'https://git.x.com/g/p/-/merge_requests/240#note_9001' })
  assert.deepEqual(posted, ['#ai-waive aaaa0001 reason=评审误报'])
  assert.equal(service.getState('s').decisions.aaaa0001.noteId, 9001)

  // 3. 再 post 一次：幂等命中，不再发第二条。
  const again = await waive.execute({ fid: 'aaaa0001', reason: '评审误报', post: true }, exec)
  assert.equal(again.ok, true)
  assert.deepEqual(again.data, { posted: false, noteId: 9001, existing: true })
  assert.equal(posted.length, 1)
  assert.match(again.message, /已有同 kind 指令/)

  await service.stop({ sessionId: 's' })
  const saved = await service.ledger.load({ projectPath: 'g/p', iid: 240 })
  assert.equal(saved.decisions.aaaa0001.noteId, 9001)
  assert.equal(saved.decisions.aaaa0001.source, 'comment')
  await rm(dir, { recursive: true, force: true })
})
