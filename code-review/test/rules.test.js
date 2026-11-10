import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateRules,
  loadRules,
  renderRulesPrompt,
  loadRulesResilient,
  PRINCIPLE_IDS,
} from '../src/host/rules.js'

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

const principles = '# 原则\n不要吞异常。'

/** 按路径分发的 readFile 假实现；rulesBody 为 undefined 时表示规则文件读取失败。 */
function makeReader(rulesBody) {
  return async (path) => {
    if (path.endsWith('rules.json')) {
      if (rulesBody === undefined) throw new Error(`ENOENT: no such file, open '${path}'`)
      return rulesBody
    }
    if (path.endsWith('principles.md')) return principles
    throw new Error(`unexpected path: ${path}`)
  }
}

const options = (readFile, warn) => ({
  rulesPath: 'rules/rules.json',
  principlesPath: 'rules/principles.md',
  readFile,
  warn,
})

test('loadRulesResilient 正常路径返回双层 prompt 与规则白名单', async () => {
  const warnings = []
  const result = await loadRulesResilient(options(makeReader(JSON.stringify(valid)), (m) => warnings.push(m)))
  assert.match(result.prompt, /## 原则/)
  assert.match(result.prompt, /## 硬规则/)
  assert.match(result.prompt, /SEC-002/)
  assert.match(result.prompt, /不要吞异常/)
  assert.deepEqual(warnings, [])
  assert.deepEqual([...result.allowedRuleIds], [
    'SEC-002',
    'PRINCIPLE-correctness',
    'PRINCIPLE-security',
    'PRINCIPLE-performance',
    'PRINCIPLE-maintainability',
  ])
  assert.ok(result.ruleSeverities instanceof Map, '应返回 ruleSeverities Map')
  assert.equal(result.ruleSeverities.size, 1)
  assert.equal(result.ruleSeverities.get('SEC-002'), 'high')
})

test('loadRulesResilient 从真实规则表返回全部 24 条 severity 映射', async () => {
  const rulesPath = new URL('../rules/rules.json', import.meta.url)
  const principlesPath = new URL('../rules/principles.md', import.meta.url)
  const result = await loadRulesResilient({ rulesPath, principlesPath })
  assert.equal(result.ruleSeverities.size, 24)
  assert.equal(result.ruleSeverities.get('COR-001'), 'high')
  assert.equal(result.ruleSeverities.get('MNT-006'), 'nit')
})

test('loadRulesResilient 规则文件缺失时降级为只用原则层', async () => {
  const warnings = []
  const result = await loadRulesResilient(options(makeReader(undefined), (m) => warnings.push(m)))
  assert.equal(result.prompt, principles)
  assert.deepEqual([...result.allowedRuleIds], [...PRINCIPLE_IDS])
  assert.equal(result.ruleSeverities.size, 0, '降级时应为空 Map')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /降级为只用原则层/)
  assert.match(warnings[0], /rules\.json/)
})

test('loadRulesResilient 规则 JSON 非法时降级为只用原则层', async () => {
  const warnings = []
  const result = await loadRulesResilient(options(makeReader('not json'), (m) => warnings.push(m)))
  assert.equal(result.prompt, principles)
  assert.deepEqual([...result.allowedRuleIds], [...PRINCIPLE_IDS])
  assert.equal(result.ruleSeverities.size, 0, '降级时应为空 Map')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /降级为只用原则层/)
  assert.match(warnings[0], /not valid JSON/)
})

test('loadRulesResilient 原则文件也不可读时抛错', async () => {
  const warnings = []
  const readFile = async (path) => {
    throw new Error(`EACCES: permission denied, open '${path}'`)
  }
  await assert.rejects(
    () => loadRulesResilient(options(readFile, (m) => warnings.push(m))),
    /principles\.md/,
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /降级为只用原则层/)
})

test('loadRulesResilient 每次调用都重新读盘，不缓存', async () => {
  let rulesReads = 0
  const readFile = async (path) => {
    if (path.endsWith('rules.json')) {
      rulesReads += 1
      const title = rulesReads === 1 ? '标题 A' : '标题 B'
      return JSON.stringify([{ ...valid[0], title }])
    }
    return principles
  }
  const first = await loadRulesResilient(options(readFile))
  const second = await loadRulesResilient(options(readFile))
  assert.match(first.prompt, /标题 A/)
  assert.doesNotMatch(first.prompt, /标题 B/)
  assert.match(second.prompt, /标题 B/)
  assert.doesNotMatch(second.prompt, /标题 A/)
  assert.equal(rulesReads, 2)
})
