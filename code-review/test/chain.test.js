import test from 'node:test'
import assert from 'node:assert/strict'
import { createChainStore } from '../src/host/chain.js'

const isCode = (path) => /\.(ts|tsx|js|jsx|vue)$/.test(path)
const file = (path, added = 1, deleted = 0) => ({ path, display: path, added, deleted })

test('跨轮累积同一文件：合并轮次与增删，按 lastSeq 排序', () => {
  const chain = createChainStore({ maxFiles: 20 })
  chain.observe('s1', 1, 10, 1, [file('a.tsx', 3, 1)], isCode)
  chain.observe('s1', 1, 12, 2, [file('b.ts', 2, 0), file('a.tsx', 1, 0)], isCode)
  const files = chain.filesOf('s1', 1)
  assert.deepEqual(files.map((item) => item.path), ['a.tsx', 'b.ts'])
  assert.deepEqual(files[0].turns, [1, 2])
  assert.equal(files[0].added, 4)
  assert.equal(files[0].deleted, 1)
})

test('非代码文件被忽略；超过 maxFiles 保留最近变更', () => {
  const chain = createChainStore({ maxFiles: 2 })
  chain.observe('s1', 1, 1, 1, [file('README.md')], isCode)
  chain.observe('s1', 1, 2, 1, [file('a.ts'), file('b.ts')], isCode)
  chain.observe('s1', 1, 3, 2, [file('c.ts')], isCode)
  assert.deepEqual(chain.filesOf('s1', 1).map((item) => item.path).sort(), ['b.ts', 'c.ts'])
})

test('epoch 变化即新链；markFull 按 epoch 隔离', () => {
  const chain = createChainStore({ maxFiles: 20 })
  chain.observe('s1', 1, 1, 1, [file('a.ts')], isCode)
  chain.markFull('s1', 1)
  assert.equal(chain.isFull('s1', 1), true)
  assert.deepEqual(chain.filesOf('s1', 2), [])
  chain.observe('s1', 2, 2, 1, [file('b.ts')], isCode)
  assert.equal(chain.isFull('s1', 2), false)
  assert.deepEqual(chain.filesOf('s1', 1), [])
})
