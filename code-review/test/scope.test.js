import test from 'node:test'
import assert from 'node:assert/strict'
import { matchGlob, ruleAppliesToFile, filterRulesForFiles } from '../src/host/scope.js'

test('matchGlob：* 只在段内匹配，不跨目录', () => {
  assert.equal(matchGlob('src/*.ts', 'src/a.ts'), true)
  assert.equal(matchGlob('src/*.ts', 'src/a/b.ts'), false)
  assert.equal(matchGlob('*.ts', 'src/a.ts'), false)
  assert.equal(matchGlob('*.ts', 'a.ts'), true)
})

test('matchGlob：** 跨任意层目录', () => {
  assert.equal(matchGlob('src/**/*.ts', 'src/a.ts'), true)
  assert.equal(matchGlob('src/**/*.ts', 'src/a/b.ts'), true)
  assert.equal(matchGlob('**/services/**', 'src/pages/a/services/b.ts'), true)
  assert.equal(matchGlob('**/services/**', 'services/b.ts'), true)
  assert.equal(matchGlob('src/**/services/**', 'src/pages/home/services/a.ts'), true)
  assert.equal(matchGlob('src/**/services/**', 'src/pages/home/other/a.ts'), false)
})

test('matchGlob：? 匹配单个非 / 字符', () => {
  assert.equal(matchGlob('src/?.ts', 'src/a.ts'), true)
  assert.equal(matchGlob('src/?.ts', 'src/ab.ts'), false)
  assert.equal(matchGlob('src/?.ts', 'src/a/b.ts'), false)
  assert.equal(matchGlob('src?x.ts', 'src/x.ts'), false)
})

test('matchGlob：多段路径命中与无匹配', () => {
  assert.equal(matchGlob('src/pages/*/services/*.ts', 'src/pages/home/services/a.ts'), true)
  assert.equal(matchGlob('src/pages/*/services/*.ts', 'src/pages/home/other/a.ts'), false)
  assert.equal(matchGlob('src/pages/*/services/*.ts', 'src/pages/home/services/a/b.ts'), false)
  assert.equal(matchGlob('lib/**/*.js', 'src/a.js'), false)
})

test('matchGlob：大小写按原样比较', () => {
  assert.equal(matchGlob('src/*.ts', 'SRC/A.TS'), false)
  assert.equal(matchGlob('src/*.TS', 'src/a.ts'), false)
})

test('matchGlob：正则特殊字符按字面匹配', () => {
  assert.equal(matchGlob('src/a+b/(c).ts', 'src/a+b/(c).ts'), true)
  assert.equal(matchGlob('src/a+b/(c).ts', 'src/aab/(c).ts'), false)
})

test('matchGlob：路径以 / 规范化（反斜杠与前导 ./）', () => {
  assert.equal(matchGlob('src/*.ts', './src/a.ts'), true)
  assert.equal(matchGlob('src/*.ts', 'src\\a.ts'), true)
})

const scoped = (scope) => ({ id: 'MNT-008', scope })

test('ruleAppliesToFile：无 scope 恒适用', () => {
  assert.equal(ruleAppliesToFile({ id: 'COR-001' }, 'any/file.ts'), true)
  assert.equal(ruleAppliesToFile({ id: 'COR-001', scope: undefined }, 'README.md'), true)
})

test('ruleAppliesToFile：extensions 命中且大小写不敏感', () => {
  const rule = scoped({ extensions: ['.tsx', '.jsx'] })
  assert.equal(ruleAppliesToFile(rule, 'src/App.tsx'), true)
  assert.equal(ruleAppliesToFile(rule, 'src/App.TSX'), true)
  assert.equal(ruleAppliesToFile(rule, 'src/App.ts'), false)
  assert.equal(ruleAppliesToFile(rule, 'src/App.tsx.bak'), false)
})

test('ruleAppliesToFile：globs 命中/未命中', () => {
  const rule = scoped({ globs: ['**/services/**'] })
  assert.equal(ruleAppliesToFile(rule, 'src/pages/a/services/b.ts'), true)
  assert.equal(ruleAppliesToFile(rule, 'src/pages/a/utils/b.ts'), false)
})

test('ruleAppliesToFile：extensions 与 globs 是 OR', () => {
  const rule = scoped({ extensions: ['.css'], globs: ['**/styles/**'] })
  assert.equal(ruleAppliesToFile(rule, 'app/main.css'), true)
  assert.equal(ruleAppliesToFile(rule, 'src/styles/theme.ts'), true)
  assert.equal(ruleAppliesToFile(rule, 'src/other/theme.ts'), false)
})

test('filterRulesForFiles：空文件列表时只剩无 scope 规则', () => {
  const rules = [validRule, scopedRule]
  const kept = filterRulesForFiles(rules, [])
  assert.deepEqual(kept.map((rule) => rule.id), ['SEC-002'])
  assert.equal(kept[0], validRule, '应保留原对象引用')
})

test('filterRulesForFiles：任一文件命中作用域即保留', () => {
  const rules = [validRule, scopedRule]
  const kept = filterRulesForFiles(rules, ['src/a.ts', 'src/App.tsx'])
  assert.deepEqual(kept.map((rule) => rule.id), ['SEC-002', 'SEC-003'])
})

test('filterRulesForFiles：接受 { path } 形式的文件条目', () => {
  const kept = filterRulesForFiles([validRule, scopedRule], [{ path: 'src/App.tsx' }])
  assert.deepEqual(kept.map((rule) => rule.id), ['SEC-002', 'SEC-003'])
})

const validRule = {
  id: 'SEC-002', dimension: 'security', severity: 'high', title: '敏感信息不得入日志',
  check: '日志参数不得出现 token', bad: 'logger.info(token)', good: 'logger.info("ok")',
}
const scopedRule = { ...validRule, id: 'SEC-003', scope: { extensions: ['.tsx', '.jsx'] } }
