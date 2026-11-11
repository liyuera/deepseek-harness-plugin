import test from 'node:test'
import assert from 'node:assert/strict'
import { createJournalCore, formatJournal } from '../src/host/journal.js'

function fakeTable() {
  const rows = new Map()
  return {
    rows,
    get: (key) => rows.get(key),
    put: async (key, value) => { rows.set(key, value) },
    delete: async (key) => { rows.delete(key) },
    deleteMany: async (keys) => { for (const key of keys) rows.delete(key) },
    entries: () => rows.entries(),
    keys: () => rows.keys(),
  }
}

const META = { sessionId: 's1', turn: 2, seq: 7, mode: 'turn', files: 3 }

test('start 记录 running，settle 更新完成态与 findings', async () => {
  const table = fakeTable()
  const journal = createJournalCore({ now: () => 1000 })
  journal.attach(table, { close: async () => {} })
  const key = journal.start(META)
  assert.equal(journal.recent('s1')[0].status, 'running')

  journal.settle(key, {
    findings: [{ ruleId: 'MNT-004', dimension: 'maintainability', severity: 'low', location: 'a.ts:1', problem: 'x', suggestion: 'y' }],
    injected: true,
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const record = journal.recent('s1')[0]
  assert.equal(record.status, 'completed')
  assert.equal(record.findingsTotal, 1)
  assert.equal(record.injected, true)
  assert.equal(record.finishedAt, 1000)
})

test('cancel 记录取消原因，recent 按时间倒序', () => {
  const journal = createJournalCore({ now: () => 1 })
  journal.start({ ...META, startedAt: 100 })
  journal.cancel(journal.start({ ...META, seq: 8 }), 'dispose')
  const list = journal.recent('s1')
  assert.equal(list[0].status, 'cancelled')
  assert.equal(list[0].reason, 'dispose')
  assert.equal(list[1].status, 'running')
})

test('每个会话最多保留 50 条', () => {
  const journal = createJournalCore({ now: () => 0 })
  for (let i = 0; i < 60; i += 1) journal.start({ ...META, seq: i })
  assert.equal(journal.recent('s1', 100).length, 50)
})

test('存储写失败只 warn，内存仍然可用', async () => {
  const warns = []
  const table = fakeTable()
  table.put = async () => { throw new Error('disk-full') }
  const journal = createJournalCore({ logger: { warn: (text) => warns.push(text) }, now: () => 0 })
  journal.attach(table, { close: async () => {} })
  journal.start(META)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(journal.recent('s1').length, 1)
  assert.ok(warns.some((text) => text.includes('留痕写入失败')))
})

test('formatJournal 渲染完成/取消/超时与未结论提示', () => {
  const records = [
    { sessionId: 's1', turn: 3, mode: 'full', startedAt: 0, finishedAt: 1, status: 'completed', reason: null, findingsTotal: 2, injected: true },
    { sessionId: 's1', turn: 2, mode: 'turn', startedAt: 0, finishedAt: 1, status: 'cancelled', reason: 'dispose', findingsTotal: 0, injected: false },
  ]
  const text = formatJournal(records, { now: () => 0 })
  assert.match(text, /自动审查记录/)
  assert.match(text, /turn 3 · 全量 · 完成 · 2 条建议（已回灌）/)
  assert.match(text, /已取消（dispose）/)
  assert.match(text, /⚠/)
  assert.equal(formatJournal([]), '')
})
