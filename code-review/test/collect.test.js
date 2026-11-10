import test from 'node:test'
import assert from 'node:assert/strict'
import { isCodeFile, renderHunks, collect } from '../src/host/collect.js'

const config = { codeExtensions: ['.js', '.ts'], maxDiffBytes: 100 }

test('isCodeFile 按扩展名匹配', () => {
  assert.equal(isCodeFile('src/a.js', ['.js']), true)
  assert.equal(isCodeFile('src/a.tsx', ['.ts']), false)
  assert.equal(isCodeFile('README.md', ['.js']), false)
})

test('renderHunks 输出 unified diff 片段', () => {
  const text = renderHunks([
    { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-const a = 1', '+const a = 2'] },
  ])
  assert.equal(text, '@@ -3,1 +3,1 @@\n-const a = 1\n+const a = 2')
})

test('未匹配扩展名的文件记为 not-code，不取 diff', async () => {
  const workspaceChanges = {
    summary: () => ({ files: [{ path: 'README.md', display: 'README.md' }], total: 1, added: 0, deleted: 0 }),
    diff: async () => { throw new Error('should not be called') },
  }
  const result = await collect({ workspaceChanges, sessionId: 's', seq: 7, config, signal: undefined })
  assert.deepEqual(result.files, [])
  assert.deepEqual(result.skipped, [{ path: 'README.md', reason: 'not-code' }])
})

test('二进制与超限文件进入 skipped，不中断其它文件', async () => {
  const workspaceChanges = {
    summary: () => ({ files: [{ path: 'a.js' }, { path: 'b.js' }, { path: 'c.js' }], total: 3, added: 0, deleted: 0 }),
    diff: async (_s, _q, index) => {
      if (index === 0) return { kind: 'binary', path: 'a.js', display: 'a.js' }
      if (index === 1) return { kind: 'oversized', path: 'b.js', display: 'b.js' }
      return { kind: 'text', path: 'c.js', display: 'c.js', hunks: [], added: 1, deleted: 1 }
    },
  }
  const result = await collect({ workspaceChanges, sessionId: 's', seq: 7, config, signal: undefined })
  assert.deepEqual(result.skipped, [{ path: 'a.js', reason: 'binary' }, { path: 'b.js', reason: 'oversized' }])
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].path, 'c.js')
})

test('超过 maxDiffBytes 后停止累积并标记剩余文件', async () => {
  const big = 'x'.repeat(60)
  const workspaceChanges = {
    summary: () => ({ files: [{ path: 'a.js' }, { path: 'b.js' }, { path: 'c.js' }], total: 3, added: 0, deleted: 0 }),
    diff: async (_s, _q, index) => ({
      kind: 'text',
      path: ['a.js', 'b.js', 'c.js'][index],
      display: ['a.js', 'b.js', 'c.js'][index],
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`+${big}`] }],
      added: 1,
      deleted: 0,
    }),
  }
  const result = await collect({ workspaceChanges, sessionId: 's', seq: 7, config, signal: undefined })
  assert.deepEqual(result.files.map((file) => file.path), ['a.js'])
  assert.deepEqual(result.skipped, [
    { path: 'b.js', reason: 'budget' },
    { path: 'c.js', reason: 'budget' },
  ])
})

test('summary 缺失时返回空结果而不是抛错', async () => {
  const result = await collect({
    workspaceChanges: { summary: () => undefined, diff: async () => undefined },
    sessionId: 's', seq: 7, config, signal: undefined,
  })
  assert.deepEqual(result, { files: [], skipped: [], bytes: 0 })
})

test('预算按 UTF-8 字节计，而非 UTF-16 code unit', async () => {
  const cjk = '汉'.repeat(30)
  const workspaceChanges = {
    summary: () => ({ files: [{ path: 'a.js' }], total: 1, added: 0, deleted: 0 }),
    diff: async () => ({
      kind: 'text',
      path: 'a.js',
      display: 'a.js',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`+${cjk}`] }],
      added: 1,
      deleted: 0,
    }),
  }
  const result = await collect({ workspaceChanges, sessionId: 's', seq: 7, config, signal: undefined })
  assert.deepEqual(result.files, [])
  assert.deepEqual(result.skipped, [{ path: 'a.js', reason: 'budget' }])
  assert.equal(result.bytes, 0)
})

test('服务返回 refusal 时原样记为 skipped reason', async () => {
  const workspaceChanges = {
    summary: () => ({ files: [{ path: 'a.js', display: 'a.js' }], total: 1, added: 0, deleted: 0 }),
    diff: async () => ({ kind: 'refusal', path: 'a.js', display: 'a.js' }),
  }
  const result = await collect({ workspaceChanges, sessionId: 's', seq: 7, config, signal: undefined })
  assert.deepEqual(result.files, [])
  assert.deepEqual(result.skipped, [{ path: 'a.js', reason: 'refusal' }])
})
