import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLedger } from '../src/host/ledger.js'

const tmp = () => mkdtemp(join(tmpdir(), 'mrloop-ledger-'))
const rec = (over = {}) => ({
  version: 1,
  binding: { projectPath: 'g/p', iid: 240 },
  rounds: [],
  decisions: {},
  mergeableAt: null,
  terminal: null,
  paused: null,
  updatedAt: '2026-11-13T10:00:00.000Z',
  ...over,
})

test('保存后可读回，文件名稳定', async () => {
  const dir = await tmp()
  const ledger = createLedger({ dir })
  const path = ledger.pathOf({ projectPath: 'g/sub/p', iid: 240 })
  assert.equal(path, join(dir, 'g-sub-p-240.json'))
  await ledger.save(rec())
  const loaded = await ledger.load({ projectPath: 'g/p', iid: 240 })
  assert.equal(loaded.binding.iid, 240)
  await rm(dir, { recursive: true, force: true })
})

test('原子写：目录里不留 .tmp，且并发写不撕裂', async () => {
  const dir = await tmp()
  const ledger = createLedger({ dir })
  await Promise.all(Array.from({ length: 20 }, (_, i) => ledger.save(rec({ updatedAt: `2026-11-13T10:00:${String(i).padStart(2, '0')}.000Z` }))))
  const files = await readdir(dir)
  assert.deepEqual(files.filter((name) => name.endsWith('.json')), ['g-p-240.json'])
  const loaded = await ledger.load({ projectPath: 'g/p', iid: 240 })
  assert.equal(loaded.version, 1)
  await rm(dir, { recursive: true, force: true })
})

test('坏文件按不存在处理', async () => {
  const dir = await tmp()
  const ledger = createLedger({ dir })
  await writeFile(ledger.pathOf({ projectPath: 'g/p', iid: 1 }), '{not json', 'utf8')
  assert.equal(await ledger.load({ projectPath: 'g/p', iid: 1 }), null)
  await rm(dir, { recursive: true, force: true })
})

test('裁剪：轮次与处置超限只留最新', async () => {
  const dir = await tmp()
  const ledger = createLedger({ dir, keepRounds: 3, keepDecisions: 2 })
  const decisions = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}`, { kind: 'waive', at: `2026-11-13T10:00:0${i}.000Z` }]))
  await ledger.save(rec({ rounds: [1, 2, 3, 4, 5].map((n) => ({ n })), decisions }))
  const loaded = await ledger.load({ projectPath: 'g/p', iid: 240 })
  assert.deepEqual(loaded.rounds.map((r) => r.n), [3, 4, 5])
  assert.deepEqual(Object.keys(loaded.decisions).sort(), ['f3', 'f4'])
  assert.equal(loaded.trimmed, 5) // 2 轮 + 3 条处置
  await rm(dir, { recursive: true, force: true })
})

test('forget 删除文件且幂等', async () => {
  const dir = await tmp()
  const ledger = createLedger({ dir })
  await ledger.save(rec())
  await ledger.forget({ projectPath: 'g/p', iid: 240 })
  assert.equal(await ledger.load({ projectPath: 'g/p', iid: 240 }), null)
  await assert.doesNotReject(ledger.forget({ projectPath: 'g/p', iid: 240 }))
  const raw = await readFile(join(dir, 'g-p-240.json'), 'utf8').catch(() => 'missing')
  assert.equal(raw, 'missing')
  await rm(dir, { recursive: true, force: true })
})
