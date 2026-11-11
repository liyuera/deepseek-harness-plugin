import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evidenceIndex,
  locationLine,
  locationPath,
  validateFindingEvidence,
} from '../src/host/evidence.js'
import { readWorkspaceTexts } from '../src/host/readfile.js'

const FILE = {
  path: 'src/a.ts',
  hunks: [{
    oldStart: 10, oldLines: 3, newStart: 10, newLines: 4,
    lines: [
      ' context before',
      '-const old = 1',
      '+const next = 2',
      '+const value = next + 1',
      ' context after',
    ],
  }],
}

const finding = (over = {}) => ({
  ruleId: 'COR-001',
  dimension: 'correctness',
  severity: 'high',
  location: 'src/a.ts:11',
  problem: 'p',
  suggestion: 's',
  evidence: { snippet: 'const value = next + 1' },
  ...over,
})

test('locationLine/locationPath 解析 path:line 与 path:start-end', () => {
  assert.equal(locationLine('src/a.ts:42'), 42)
  assert.equal(locationLine('src/a.ts:88-96'), 88)
  assert.equal(locationLine('src/a.ts'), undefined)
  assert.equal(locationLine('src/a.ts:x'), undefined)
  assert.equal(locationPath('src/a.ts:42'), 'src/a.ts')
  assert.equal(locationPath('src/a.ts:88-96'), 'src/a.ts')
})

test('evidenceIndex 区分新增/删除/上下文行并给出 new 侧范围', () => {
  const index = evidenceIndex(FILE)
  assert.deepEqual([...index.changed].sort(), ['const next = 2', 'const old = 1', 'const value = next + 1'])
  assert.deepEqual([...index.context].sort(), ['context after', 'context before'].sort())
  assert.deepEqual(index.ranges, [{ start: 10, end: 13 }])
})

test('文本模式的 evidenceIndex 允许任意当前文件行', () => {
  const index = evidenceIndex({ path: 'a.ts', text: 'const a = 1\nconst b = 2' })
  assert.deepEqual([...index.all], ['const a = 1', 'const b = 2'])
  assert.deepEqual(index.ranges, [])
})

test('片段命中新增行且 location 在 hunk 内 → ok', () => {
  assert.deepEqual(validateFindingEvidence(finding(), FILE), { status: 'ok' })
})

test('片段只引用上下文行（未修改代码）→ mismatch', () => {
  assert.deepEqual(
    validateFindingEvidence(finding({ evidence: { snippet: 'context before' } }), FILE),
    { status: 'mismatch' },
  )
})

test('片段含伪造行 → mismatch', () => {
  assert.deepEqual(
    validateFindingEvidence(finding({ evidence: { snippet: 'const value = next + 1\nconst fake = true' } }), FILE),
    { status: 'mismatch' },
  )
})

test('location 落在 hunk 外 → outside', () => {
  assert.deepEqual(
    validateFindingEvidence(finding({ location: 'src/a.ts:99' }), FILE),
    { status: 'outside' },
  )
})

test('没有 evidence/空片段 → missing', () => {
  assert.deepEqual(validateFindingEvidence(finding({ evidence: undefined }), FILE), { status: 'missing' })
  assert.deepEqual(validateFindingEvidence(finding({ evidence: { snippet: '  ' } }), FILE), { status: 'missing' })
})

test('拿不到文件内容 → unreadable；文本模式命中当前文件 → ok', () => {
  assert.deepEqual(validateFindingEvidence(finding(), undefined), { status: 'unreadable' })
  assert.deepEqual(
    validateFindingEvidence(finding({ evidence: { snippet: 'const b = 2' } }), { path: 'a.ts', text: 'const a = 1\nconst b = 2' }),
    { status: 'ok' },
  )
})

test('readWorkspaceTexts 只读 cwd 内文件，越界/超限跳过', async () => {
  const files = new Map([
    ['/work/a.ts', Buffer.from('const a = 1')],
    ['/work/b.ts', Buffer.alloc(2048, 65)],
  ])
  const texts = await readWorkspaceTexts({
    cwd: '/work',
    paths: ['a.ts', 'b.ts', '../etc/passwd', '/abs/c.ts'],
    maxFileBytes: 1024,
    readFile: async (path) => files.get(path) ?? Promise.reject(new Error('ENOENT')),
    realpath: async (path) => path,
  })
  assert.deepEqual([...texts.keys()], ['a.ts'])
  assert.equal(texts.get('a.ts'), 'const a = 1')
})

test('readWorkspaceTexts 缺少 cwd 时返回空 Map', async () => {
  assert.equal((await readWorkspaceTexts({ cwd: undefined, paths: ['a.ts'] })).size, 0)
})

test('片段被反引号/代码块包裹时仍可匹配', () => {
  assert.deepEqual(
    validateFindingEvidence(finding({ evidence: { snippet: '```\nconst value = next + 1\n```' } }), FILE),
    { status: 'ok' },
  )
  assert.deepEqual(
    validateFindingEvidence(finding({ evidence: { snippet: '`const value = next + 1`' } }), FILE),
    { status: 'ok' },
  )
})
