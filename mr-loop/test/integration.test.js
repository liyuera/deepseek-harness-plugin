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
        '   - FID: `aa`',
        '   - 复验次数: `0`',
        '   - 级别: 中',
        '   - 门禁分类: 逻辑错误',
        '   - 位置: `src/a.js:1`',
        '   - 问题: 问题 aa',
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
