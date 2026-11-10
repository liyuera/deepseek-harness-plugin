import test from 'node:test'
import assert from 'node:assert/strict'
import { isCodeFile, renderHunks, collect, fingerprint } from '../src/host/collect.js'

const config = { codeExtensions: ['.js', '.ts'], maxDiffBytes: 100 }

/** 运行时真实形状：行数不在 diff 上，而在 summary.files 上。 */
function textDiff(path, hunks = []) {
  return { kind: 'text', path, display: path, hunks, coarse: false }
}

/** 单行新增的 hunk，正文为 content。 */
function addHunk(content) {
  return { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`+${content}`] }
}

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
    summary: () => ({
      files: [
        { path: 'a.js', display: 'a.js', added: 1, deleted: 1 },
        { path: 'b.js', display: 'b.js', added: 1, deleted: 1 },
        { path: 'c.js', display: 'c.js', added: 1, deleted: 1 },
      ],
      total: 3,
      added: 3,
      deleted: 3,
    }),
    diff: async (_s, _q, index) => {
      if (index === 0) return { kind: 'binary', path: 'a.js', display: 'a.js' }
      if (index === 1) return { kind: 'oversized', path: 'b.js', display: 'b.js' }
      return textDiff('c.js', [addHunk('c')])
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
    summary: () => ({
      files: [
        { path: 'a.js', display: 'a.js', added: 1, deleted: 0 },
        { path: 'b.js', display: 'b.js', added: 1, deleted: 0 },
        { path: 'c.js', display: 'c.js', added: 1, deleted: 0 },
      ],
      total: 3,
      added: 3,
      deleted: 0,
    }),
    diff: async (_s, _q, index) => {
      const path = ['a.js', 'b.js', 'c.js'][index]
      return textDiff(path, [addHunk(big)])
    },
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
    summary: () => ({ files: [{ path: 'a.js', display: 'a.js' }], total: 1, added: 1, deleted: 0 }),
    diff: async () => textDiff('a.js', [addHunk(cjk)]),
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

test('added/deleted 取自 summary.files，缺失时回退 0', async () => {
  const workspaceChanges = {
    summary: () => ({
      files: [
        { path: 'a.js', display: 'a.js', added: 3, deleted: 2 },
        { path: 'b.js', display: 'b.js' },
      ],
      total: 2,
      added: 3,
      deleted: 2,
    }),
    diff: async (_s, _q, index) => textDiff(['a.js', 'b.js'][index], [addHunk('x')]),
  }
  const result = await collect({ workspaceChanges, sessionId: 's', seq: 7, config, signal: undefined })
  assert.deepEqual(
    result.files.map((file) => ({ added: file.added, deleted: file.deleted })),
    [{ added: 3, deleted: 2 }, { added: 0, deleted: 0 }],
  )
})

test('coarse diff 记为 coarse 跳过，不进 files 也不计字节', async () => {
  const big = 'x'.repeat(200)
  const workspaceChanges = {
    summary: () => ({
      files: [
        { path: 'a.js', display: 'a.js', added: 5, deleted: 5 },
        { path: 'b.js', display: 'b.js', added: 1, deleted: 0 },
      ],
      total: 2,
      added: 6,
      deleted: 5,
    }),
    diff: async (_s, _q, index) => index === 0
      ? { ...textDiff('a.js', [addHunk(big)]), coarse: true }
      : textDiff('b.js', [addHunk('ok')]),
  }
  const result = await collect({ workspaceChanges, sessionId: 's', seq: 7, config, signal: undefined })
  assert.deepEqual(result.files.map((file) => file.path), ['b.js'])
  assert.deepEqual(result.skipped, [{ path: 'a.js', reason: 'coarse' }])
  assert.equal(result.bytes, Buffer.byteLength(result.files[0].text, 'utf8'))
})

test('fingerprint 相同内容稳定，路径或文本变化即变，空数组稳定', () => {
  const a = { path: 'a.js', text: '+a' }
  const b = { path: 'b.js', text: '+b' }
  assert.equal(fingerprint([a, b]), fingerprint([{ ...a }, { ...b }]))
  assert.notEqual(fingerprint([a, b]), fingerprint([{ ...a, path: 'x.js' }, b]))
  assert.notEqual(fingerprint([a, b]), fingerprint([{ ...a, text: '+a ' }, b]))
  assert.equal(fingerprint([]).length, 64)
  assert.equal(fingerprint([]), fingerprint([]))
})
