import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_FINDINGS } from '../src/host/structured.js'
import { chunkFiles, mapWithLimit, mergeCoverage, mergeReviews, timeoutFor } from '../src/host/chunk.js'

const file = (path, text) => ({ path, text, hunks: [] })

test('chunkFiles 按字节上限顺序装块，单文件超限独占一块', () => {
  const files = [file('a.js', 'x'.repeat(60)), file('b.js', 'y'.repeat(60)), file('c.js', 'z'.repeat(200))]
  const chunks = chunkFiles(files, 130)
  assert.deepEqual(chunks.map((chunk) => chunk.map((item) => item.path)), [
    ['a.js', 'b.js'],
    ['c.js'],
  ])
  assert.deepEqual(chunkFiles([], 100), [])
})

test('chunkFiles 对非法上限回退默认值而不是无限装块', () => {
  const files = [file('a.js', 'x'.repeat(10))]
  assert.equal(chunkFiles(files, 0).length, 1)
  assert.equal(chunkFiles(files, undefined).length, 1)
})

test('timeoutFor 按 KB 放大并夹在 maxMs', () => {
  assert.equal(timeoutFor(0, { baseMs: 1000, perKbMs: 100, maxMs: 10000 }), 1000)
  assert.equal(timeoutFor(1024, { baseMs: 1000, perKbMs: 100, maxMs: 10000 }), 1100)
  assert.equal(timeoutFor(2048, { baseMs: 1000, perKbMs: 100, maxMs: 10000 }), 1200)
  assert.equal(timeoutFor(10 * 1024 * 1024, { baseMs: 1000, perKbMs: 100, maxMs: 10000 }), 10000)
  assert.equal(timeoutFor(-5, { baseMs: 1000, perKbMs: 100, maxMs: 10000 }), 1000)
})

test('mergeReviews 跨块去重（ruleId+path+规范化 problem），evidence 对齐', () => {
  const finding = (over = {}) => ({
    ruleId: 'COR-001',
    dimension: 'correctness',
    severity: 'high',
    location: 'a.js:1',
    problem: 'catch 吞掉异常',
    suggestion: '补异常处理',
    ...over,
  })
  const merged = mergeReviews([
    { findings: [finding()], evidence: ['ok'], coverage: { valid: true, missing: false, reviewed: 1, skipped: 0, unaccounted: 0 } },
    {
      findings: [finding({ problem: 'catch   吞掉异常' }), finding({ location: 'b.js:2', problem: '另一个问题' })],
      evidence: ['mismatch', 'ok'],
      coverage: { valid: true, missing: false, reviewed: 2, skipped: 1, unaccounted: 0 },
    },
  ])
  // 同 key 的重复 finding 只保留第一份（evidence 也取第一份）。
  assert.equal(merged.findings.length, 2)
  assert.deepEqual(merged.evidence, ['ok', 'ok'])
  assert.equal(merged.findings[1].location, 'b.js:2')
  assert.deepEqual(merged.coverage, {
    valid: true, missing: false, files: [], reviewed: 3, skipped: 1, unaccounted: 0,
  })
})

test('mergeReviews 超过 MAX_FINDINGS 按严重度截断并给出 truncated 数', () => {
  const findings = Array.from({ length: MAX_FINDINGS + 3 }, (_, index) => ({
    ruleId: 'MNT-001',
    dimension: 'maintainability',
    severity: 'low',
    location: `a.js:${index + 1}`,
    problem: `问题 ${index}`,
    suggestion: '修',
  }))
  const merged = mergeReviews([{ findings, evidence: Array(findings.length).fill('ok') }])
  assert.equal(merged.findings.length, MAX_FINDINGS)
  assert.equal(merged.evidence.length, MAX_FINDINGS)
  assert.equal(merged.truncated, 3)
})

test('mergeCoverage 任一块未申报即 missing，计数累加', () => {
  assert.deepEqual(mergeReviews([]).coverage, {
    valid: false, missing: true, files: [], reviewed: 0, skipped: 0, unaccounted: 0,
  })
  const merged = mergeCoverage([
    { valid: true, missing: false, reviewed: 1, skipped: 0, unaccounted: 0 },
    { valid: false, missing: true, reviewed: 0, skipped: 0, unaccounted: 2 },
  ])
  assert.equal(merged.valid, false)
  assert.equal(merged.missing, false)
  assert.equal(merged.reviewed, 1)
  assert.equal(merged.unaccounted, 2)
})

test('mapWithLimit 保持结果顺序且并发不超过上限', async () => {
  let active = 0
  let peak = 0
  const delay = () => new Promise((resolve) => setTimeout(resolve, 2))
  const results = await mapWithLimit([1, 2, 3, 4, 5], 2, async (item) => {
    active += 1
    peak = Math.max(peak, active)
    await delay()
    active -= 1
    return item * 2
  })
  assert.deepEqual(results, [2, 4, 6, 8, 10])
  assert.ok(peak <= 2, `并发峰值应 <=2，实际 ${peak}`)
  assert.deepEqual(await mapWithLimit([], 2, async (item) => item), [])
})
