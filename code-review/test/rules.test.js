import test from 'node:test'
import assert from 'node:assert/strict'
import { validateRules, loadRules, renderRulesPrompt } from '../src/host/rules.js'

const valid = [{
  id: 'SEC-002', dimension: 'security', severity: 'high', title: '敏感信息不得入日志',
  check: '日志参数不得出现 token', bad: 'logger.info(token)', good: 'logger.info("ok")',
}]

test('合法规则通过', () => { assert.doesNotThrow(() => validateRules(valid)) })

test('重复 id 拒绝', () => {
  assert.throws(() => validateRules([...valid, { ...valid[0] }]), /duplicate rule id "SEC-002"/)
})

test('id 前缀必须匹配维度', () => {
  assert.throws(
    () => validateRules([{ ...valid[0], id: 'SEC-003', dimension: 'performance' }]),
    /rule "SEC-003" prefix does not match dimension "performance"/,
  )
})

test('缺字段拒绝', () => {
  const { check, ...rest } = valid[0]
  assert.throws(() => validateRules([rest]), /rule "SEC-002" is missing "check"/)
})

test('非法严重度拒绝', () => {
  assert.throws(() => validateRules([{ ...valid[0], severity: 'blocker' }]), /rule "SEC-002" has invalid severity "blocker"/)
})

test('loadRules 读两个文件并校验', async () => {
  const readFile = async (path) => {
    if (path.endsWith('rules.json')) return JSON.stringify(valid)
    return '# 原则\n不要吞异常。'
  }
  const result = await loadRules({ rulesPath: 'rules/rules.json', principlesPath: 'rules/principles.md', readFile })
  assert.equal(result.rules.length, 1)
  assert.match(result.principles, /吞异常/)
})

test('loadRules 在规则文件非法时抛错', async () => {
  const readFile = async () => 'not json'
  await assert.rejects(
    () => loadRules({ rulesPath: 'r.json', principlesPath: 'p.md', readFile }),
    /rules file is not valid JSON/,
  )
})

test('renderRulesPrompt 带 id 与正反例', () => {
  const text = renderRulesPrompt({ rules: valid, principles: '# 原则' })
  assert.match(text, /SEC-002/)
  assert.match(text, /logger\.info\(token\)/)
  assert.match(text, /# 原则/)
})
