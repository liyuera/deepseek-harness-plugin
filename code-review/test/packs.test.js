import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { validateRules, renderRulesPrompt } from '../src/host/rules.js'

const pack = JSON.parse(
  await readFile(new URL('../rules/packs/frontend-smartui.json', import.meta.url), 'utf8'),
)
const baseRules = JSON.parse(
  await readFile(new URL('../rules/rules.json', import.meta.url), 'utf8'),
)
const packById = new Map(pack.map((rule) => [rule.id, rule]))
const baseById = new Map(baseRules.map((rule) => [rule.id, rule]))

test('前端规则包通过 validateRules，18 条且 id 唯一', () => {
  assert.doesNotThrow(() => validateRules(pack))
  assert.equal(pack.length, 18)
  assert.equal(new Set(pack.map((rule) => rule.id)).size, 18)
})

test('严重度为 5 条 medium（MNT-008~012）+ 13 条 low', () => {
  const medium = pack.filter((rule) => rule.severity === 'medium').map((rule) => rule.id)
  const low = pack.filter((rule) => rule.severity === 'low').map((rule) => rule.id)
  assert.deepEqual(medium, ['MNT-008', 'MNT-009', 'MNT-010', 'MNT-011', 'MNT-012'])
  assert.equal(low.length, 13)
  assert.equal(pack.length, medium.length + low.length)
})

test('每条规则都是 maintainability，且有 CR- 前缀 sourceId 与非空 scope', () => {
  for (const rule of pack) {
    assert.equal(rule.dimension, 'maintainability', `${rule.id} 的 dimension 必须为 maintainability`)
    assert.match(rule.sourceId, /^CR-/, `${rule.id} 缺少合法的 sourceId`)
    assert.ok(rule.scope && typeof rule.scope === 'object', `${rule.id} 缺少 scope`)
    const lists = [rule.scope.extensions, rule.scope.globs].filter(Array.isArray)
    assert.ok(
      lists.some((list) => list.length > 0),
      `${rule.id} 的 scope 至少需要一个非空数组`,
    )
  }
})

test('scope 映射与规格 §18.6 抽查一致', () => {
  assert.ok(packById.get('MNT-008').scope.extensions.includes('.tsx'))
  assert.ok(packById.get('MNT-010').scope.extensions.includes('.css'))
  assert.ok(packById.get('MNT-025').scope.extensions.includes('.css'))
  assert.ok(packById.get('MNT-009').scope.globs.some((glob) => glob.includes('**/services/**')))
  assert.ok(packById.get('MNT-012').scope.globs.some((glob) => glob.includes('**/services/**')))
  assert.deepEqual(packById.get('MNT-023').scope.extensions, ['.ts', '.tsx'])
})

test('renderRulesPrompt 为每条规则渲染 [sourceId] 来源标签', () => {
  const prompt = renderRulesPrompt({ rules: pack, principles: '# 原则' })
  for (const rule of pack) {
    assert.ok(prompt.includes(`[${rule.sourceId}]`), `${rule.id} 的渲染结果缺少 [${rule.sourceId}]`)
    assert.ok(prompt.includes(rule.id), `渲染结果缺少规则 ${rule.id}`)
  }
  assert.ok(prompt.includes('[CR-011.01]'))
})

test('filterRulesForFiles：.tsx 命中 Hooks 规则、不命中 CSS 规则', async () => {
  const { filterRulesForFiles } = await import('../src/host/scope.js')
  const ids = filterRulesForFiles(pack, ['src/pages/A.tsx']).map((rule) => rule.id)
  assert.ok(ids.includes('MNT-008'), '.tsx 应命中 MNT-008')
  assert.ok(!ids.includes('MNT-010'), '.tsx 不应命中 CSS 规则 MNT-010')
})

test('filterRulesForFiles：.less 命中 CSS 规则、不命中 Hooks 规则', async () => {
  const { filterRulesForFiles } = await import('../src/host/scope.js')
  const ids = filterRulesForFiles(pack, ['src/a.less']).map((rule) => rule.id)
  assert.ok(ids.includes('MNT-010'), '.less 应命中 MNT-010')
  assert.ok(!ids.includes('MNT-008'), '.less 不应命中 Hooks 规则 MNT-008')
})

test('filterRulesForFiles：services 路径命中接口契约规则', async () => {
  const { filterRulesForFiles } = await import('../src/host/scope.js')
  const ids = filterRulesForFiles(pack, ['src/services/user.ts']).map((rule) => rule.id)
  assert.ok(ids.includes('MNT-009'), 'services/** 应命中 MNT-009')
  assert.ok(ids.includes('MNT-012'), 'services/** 应命中 MNT-012')
})

test('filterRulesForFiles：README.md 只剩基础 24 条无 scope 规则', async () => {
  const { filterRulesForFiles } = await import('../src/host/scope.js')
  assert.ok(baseRules.every((rule) => rule.scope === undefined), '基础规则不应带 scope')
  const ids = filterRulesForFiles([...baseRules, ...pack], ['README.md']).map((rule) => rule.id)
  assert.deepEqual(ids, baseRules.map((rule) => rule.id))
  assert.equal(ids.length, 24)
})

test('基础规则表通过 validateRules，仍为 24 条', () => {
  assert.doesNotThrow(() => validateRules(baseRules))
  assert.equal(baseRules.length, 24)
  assert.equal(new Set(baseRules.map((rule) => rule.id)).size, 24)
})

test('MNT-002 收紧：禁 debugger/console.log/debug/info，允许错误路径 console.error/warn', () => {
  const rule = baseById.get('MNT-002')
  assert.equal(rule.severity, 'low')
  assert.equal(rule.title, '不得留下调试残留')
  assert.match(rule.check, /debugger/)
  assert.match(rule.check, /console\.log/)
  assert.match(rule.check, /console\.debug/)
  assert.match(rule.check, /console\.info/)
  assert.match(rule.check, /console\.error/)
  assert.match(rule.check, /console\.warn/)
})

test('MNT-003 收紧：≥3 处且每处 ≥5 行，或涉及核心业务/异常/权限分支', () => {
  const rule = baseById.get('MNT-003')
  assert.equal(rule.severity, 'low')
  assert.equal(rule.title, '不得复制粘贴近似代码块')
  assert.match(rule.check, /≥3/)
  assert.match(rule.check, /≥5/)
  assert.match(rule.check, /核心业务/)
  assert.match(rule.check, /异常/)
  assert.match(rule.check, /权限/)
})

test('MNT-007 收紧：>200 行强制、>100 行建议，文件 >500 行交给 MNT-011', () => {
  const rule = baseById.get('MNT-007')
  assert.equal(rule.severity, 'low')
  assert.equal(rule.title, '巨型函数必须拆分')
  assert.match(rule.check, /200/)
  assert.match(rule.check, /100/)
  assert.ok(!rule.check.includes('500'), 'MNT-007 不应包含文件行数口径（由 MNT-011 覆盖）')
  assert.match(packById.get('MNT-011').check, /500/)
})
