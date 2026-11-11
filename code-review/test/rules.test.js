import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateRules,
  loadRules,
  renderRulesPrompt,
  loadRulesResilient,
  composeRules,
  PRINCIPLE_IDS,
} from '../src/host/rules.js'

const valid = [{
  id: 'SEC-002', dimension: 'security', severity: 'high', title: '敏感信息不得入日志',
  check: '日志参数不得出现 token', bad: 'logger.info(token)', good: 'logger.info("ok")',
}]

const principles = '# 原则\n不要吞异常。'

const scopedRule = (id, overrides = {}) => ({
  ...valid[0], id, ...overrides,
})

/** 按路径后缀分发的 readFile 假实现；值为 Error 时模拟读取失败。 */
function reader(files) {
  return async (path) => {
    const suffix = Object.keys(files).find((name) => String(path).endsWith(name))
    if (suffix === undefined) throw new Error(`ENOENT: no such file, open '${path}'`)
    const content = files[suffix]
    if (content instanceof Error) throw content
    return content
  }
}

const baseFiles = () => ({ 'rules.json': JSON.stringify(valid), 'principles.md': principles })

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

test('可选 sourceId 与 scope 合法时通过', () => {
  assert.doesNotThrow(() => validateRules([scopedRule('SEC-003', {
    sourceId: 'CR-011.01',
    scope: { extensions: ['.tsx', '.jsx'], globs: ['**/services/**'] },
  })]))
  assert.doesNotThrow(() => validateRules([scopedRule('SEC-004', {
    sourceId: 'CR-006.02',
    scope: { globs: ['src/**/*.ts'] },
  })]))
  assert.doesNotThrow(() => validateRules([scopedRule('SEC-005', {
    scope: { extensions: [], globs: ['src/**/*.ts'] },
  })]))
})

test('sourceId 必须是非空字符串', () => {
  for (const sourceId of ['', 42, null]) {
    assert.throws(
      () => validateRules([{ ...valid[0], sourceId }]),
      /rule "SEC-002" sourceId must be a non-empty string/,
    )
  }
})

test('scope 必须是对象', () => {
  for (const scope of [null, [], 'tsx', 7]) {
    assert.throws(
      () => validateRules([{ ...valid[0], scope }]),
      /rule "SEC-002" scope must be an object/,
    )
  }
})

test('scope 空对象或两个数组都为空时非法', () => {
  for (const scope of [{}, { extensions: [] }, { globs: [] }, { extensions: [], globs: [] }]) {
    assert.throws(
      () => validateRules([{ ...valid[0], scope }]),
      /rule "SEC-002" scope must have at least one non-empty array/,
    )
  }
})

test('scope 只允许 extensions/globs 两个键', () => {
  assert.throws(
    () => validateRules([{ ...valid[0], scope: { files: ['a.ts'] } }]),
    /rule "SEC-002" scope has unknown key "files"/,
  )
})

test('scope.extensions/globs 必须是数组', () => {
  assert.throws(
    () => validateRules([{ ...valid[0], scope: { extensions: '.tsx' } }]),
    /rule "SEC-002" scope\.extensions must be an array/,
  )
  assert.throws(
    () => validateRules([{ ...valid[0], scope: { globs: 'src/**' } }]),
    /rule "SEC-002" scope\.globs must be an array/,
  )
})

test('scope 数组元素必须是非空字符串', () => {
  assert.throws(
    () => validateRules([{ ...valid[0], scope: { extensions: [''] } }]),
    /rule "SEC-002" scope\.extensions entries must be non-empty strings/,
  )
  assert.throws(
    () => validateRules([{ ...valid[0], scope: { globs: [null] } }]),
    /rule "SEC-002" scope\.globs entries must be non-empty strings/,
  )
  assert.throws(
    () => validateRules([{ ...valid[0], scope: { globs: [''] } }]),
    /rule "SEC-002" scope\.globs entries must be non-empty strings/,
  )
})

test('scope.extensions 必须以 . 开头', () => {
  assert.throws(
    () => validateRules([{ ...valid[0], scope: { extensions: ['tsx'] } }]),
    /rule "SEC-002" scope\.extensions entries must start with "\."/,
  )
})

test('loadRules 读两个文件并校验', async () => {
  const result = await loadRules({ rulesPath: 'rules/rules.json', principlesPath: 'rules/principles.md', readFile: reader(baseFiles()) })
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

test('renderRulesPrompt 有 sourceId 时渲染来源标签', () => {
  const text = renderRulesPrompt({
    rules: [scopedRule('MNT-008', { dimension: 'maintainability', title: 'Hooks 依赖', sourceId: 'CR-011.01' })],
    principles,
  })
  assert.match(text, /### MNT-008 · maintainability · high · \[CR-011\.01\] Hooks 依赖/)
})

test('renderRulesPrompt 无 sourceId 时不渲染来源标签', () => {
  const text = renderRulesPrompt({ rules: valid, principles })
  assert.match(text, /### SEC-002 · security · high · 敏感信息不得入日志/)
  assert.doesNotMatch(text, /\[\]/)
  assert.doesNotMatch(text, /\[CR-/)
})

test('renderRulesPrompt 空规则时提示只按原则审，并保留原则层', () => {
  const text = renderRulesPrompt({ rules: [], principles })
  assert.match(text, /本轮没有适用的硬规则，只按原则审/)
  assert.match(text, /不要吞异常/)
  assert.doesNotMatch(text, /SEC-002/)
})

test('composeRules 按文件过滤后 prompt/白名单/severity 三者一致', () => {
  const rules = [
    valid[0],
    scopedRule('SEC-003', { scope: { extensions: ['.tsx'] }, sourceId: 'CR-001.01' }),
    scopedRule('SEC-004', { scope: { globs: ['**/styles/**'] } }),
  ]
  const composed = composeRules({ rules, principles, filePaths: ['src/App.tsx'] })

  assert.deepEqual([...composed.allowedRuleIds], ['SEC-002', 'SEC-003', ...PRINCIPLE_IDS])
  assert.deepEqual([...composed.ruleSeverities.keys()], ['SEC-002', 'SEC-003'])
  assert.match(composed.prompt, /SEC-002/)
  assert.match(composed.prompt, /SEC-003/)
  assert.match(composed.prompt, /\[CR-001\.01\]/)
  assert.doesNotMatch(composed.prompt, /SEC-004/)
  assert.equal(composed.ruleSeverities.size, composed.allowedRuleIds.size - PRINCIPLE_IDS.length)
})

test('composeRules 空文件列表只保留无 scope 规则', () => {
  const rules = [valid[0], scopedRule('SEC-003', { scope: { extensions: ['.tsx'] } })]
  const composed = composeRules({ rules, principles, filePaths: [] })
  assert.deepEqual([...composed.allowedRuleIds], ['SEC-002', ...PRINCIPLE_IDS])
  assert.equal(composed.ruleSeverities.size, 1)
})

test('composeRules 无规则适用时 prompt 退化为原则层文案', () => {
  const rules = [scopedRule('SEC-003', { scope: { extensions: ['.tsx'] } })]
  const composed = composeRules({ rules, principles, filePaths: ['README.md'] })
  assert.match(composed.prompt, /本轮没有适用的硬规则，只按原则审/)
  assert.match(composed.prompt, /不要吞异常/)
  assert.deepEqual([...composed.allowedRuleIds], [...PRINCIPLE_IDS])
  assert.equal(composed.ruleSeverities.size, 0)
})

test('loadRulesResilient 正常路径返回规则与原则', async () => {
  const warnings = []
  const result = await loadRulesResilient({
    rulesPath: 'rules/rules.json',
    principlesPath: 'rules/principles.md',
    readFile: reader(baseFiles()),
    warn: (message) => warnings.push(message),
  })
  assert.deepEqual(Object.keys(result).sort(), ['principles', 'rules'])
  assert.deepEqual(result.rules, valid)
  assert.equal(result.principles, principles)
  assert.deepEqual(warnings, [])
})

test('loadRulesResilient 从真实规则表返回全部 24 条', async () => {
  const result = await loadRulesResilient({
    rulesPath: new URL('../rules/rules.json', import.meta.url),
    principlesPath: new URL('../rules/principles.md', import.meta.url),
  })
  assert.equal(result.rules.length, 24)
  assert.ok(result.rules.some((rule) => rule.id === 'COR-001'))
  assert.ok(result.rules.some((rule) => rule.id === 'MNT-006'))
})

test('loadRulesResilient 规则文件缺失时降级为空规则 + 原则层', async () => {
  const warnings = []
  const files = baseFiles()
  files['rules.json'] = new Error("ENOENT: no such file, open 'rules/rules.json'")
  const result = await loadRulesResilient({
    rulesPath: 'rules/rules.json',
    principlesPath: 'rules/principles.md',
    readFile: reader(files),
    warn: (message) => warnings.push(message),
  })
  assert.deepEqual(result.rules, [])
  assert.equal(result.principles, principles)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /降级为只用原则层/)
  assert.match(warnings[0], /rules\.json/)
})

test('loadRulesResilient 规则 JSON 非法时降级为空规则 + 原则层', async () => {
  const warnings = []
  const files = baseFiles()
  files['rules.json'] = 'not json'
  const result = await loadRulesResilient({
    rulesPath: 'rules/rules.json',
    principlesPath: 'rules/principles.md',
    readFile: reader(files),
    warn: (message) => warnings.push(message),
  })
  assert.deepEqual(result.rules, [])
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
    () => loadRulesResilient({
      rulesPath: 'rules/rules.json',
      principlesPath: 'rules/principles.md',
      readFile,
      warn: (message) => warnings.push(message),
    }),
    /principles\.md/,
  )
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /降级为只用原则层/)
})

test('loadRulesResilient 每次调用都重新读盘，不缓存', async () => {
  let rulesReads = 0
  const readFile = async (path) => {
    if (String(path).endsWith('rules.json')) {
      rulesReads += 1
      const title = rulesReads === 1 ? '标题 A' : '标题 B'
      return JSON.stringify([{ ...valid[0], title }])
    }
    return principles
  }
  const options = { rulesPath: 'rules/rules.json', principlesPath: 'rules/principles.md', readFile }
  const first = await loadRulesResilient(options)
  const second = await loadRulesResilient(options)
  assert.equal(first.rules[0].title, '标题 A')
  assert.equal(second.rules[0].title, '标题 B')
  assert.equal(rulesReads, 2)
})

test('loadRulesResilient 按顺序合并规则包', async () => {
  const files = {
    ...baseFiles(),
    'front.json': JSON.stringify([scopedRule('SEC-003')]),
    'backend.json': JSON.stringify([scopedRule('SEC-004')]),
  }
  const warnings = []
  const result = await loadRulesResilient({
    rulesPath: 'rules/rules.json',
    principlesPath: 'rules/principles.md',
    packs: ['rules/packs/front.json', 'rules/packs/backend.json'],
    readFile: reader(files),
    warn: (message) => warnings.push(message),
  })
  assert.deepEqual(result.rules.map((rule) => rule.id), ['SEC-002', 'SEC-003', 'SEC-004'])
  assert.deepEqual(warnings, [])
})

test('loadRulesResilient 规则包缺失时警告并跳过，基础规则仍在', async () => {
  const warnings = []
  const result = await loadRulesResilient({
    rulesPath: 'rules/rules.json',
    principlesPath: 'rules/principles.md',
    packs: ['rules/packs/missing.json'],
    readFile: reader(baseFiles()),
    warn: (message) => warnings.push(message),
  })
  assert.deepEqual(result.rules.map((rule) => rule.id), ['SEC-002'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /规则包/)
  assert.match(warnings[0], /missing\.json/)
  assert.match(warnings[0], /跳过/)
})

test('loadRulesResilient 规则包 JSON 非法时警告并跳过', async () => {
  const warnings = []
  const files = { ...baseFiles(), 'broken.json': 'not json' }
  const result = await loadRulesResilient({
    rulesPath: 'rules/rules.json',
    principlesPath: 'rules/principles.md',
    packs: ['rules/packs/broken.json'],
    readFile: reader(files),
    warn: (message) => warnings.push(message),
  })
  assert.deepEqual(result.rules.map((rule) => rule.id), ['SEC-002'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /broken\.json/)
  assert.match(warnings[0], /not valid JSON/)
})

test('loadRulesResilient 规则包校验失败时警告并跳过', async () => {
  const warnings = []
  const files = {
    ...baseFiles(),
    'invalid.json': JSON.stringify([{ ...scopedRule('SEC-003'), severity: 'blocker' }]),
  }
  const result = await loadRulesResilient({
    rulesPath: 'rules/rules.json',
    principlesPath: 'rules/principles.md',
    packs: ['rules/packs/invalid.json'],
    readFile: reader(files),
    warn: (message) => warnings.push(message),
  })
  assert.deepEqual(result.rules.map((rule) => rule.id), ['SEC-002'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /invalid\.json/)
  assert.match(warnings[0], /invalid severity "blocker"/)
})

test('loadRulesResilient 规则包与基础规则 id 重复时整包跳过', async () => {
  const warnings = []
  const files = { ...baseFiles(), 'dup.json': JSON.stringify([scopedRule('SEC-003'), { ...valid[0] }]) }
  const result = await loadRulesResilient({
    rulesPath: 'rules/rules.json',
    principlesPath: 'rules/principles.md',
    packs: ['rules/packs/dup.json'],
    readFile: reader(files),
    warn: (message) => warnings.push(message),
  })
  assert.deepEqual(result.rules.map((rule) => rule.id), ['SEC-002'], '整个包应被跳过，SEC-003 也不得进入')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /dup\.json/)
  assert.match(warnings[0], /duplicate rule id "SEC-002"/)
})

test('loadRulesResilient 规则包之间 id 重复时后加载的包跳过', async () => {
  const warnings = []
  const files = {
    ...baseFiles(),
    'first.json': JSON.stringify([scopedRule('SEC-003')]),
    'second.json': JSON.stringify([scopedRule('SEC-003')]),
  }
  const result = await loadRulesResilient({
    rulesPath: 'rules/rules.json',
    principlesPath: 'rules/principles.md',
    packs: ['rules/packs/first.json', 'rules/packs/second.json'],
    readFile: reader(files),
    warn: (message) => warnings.push(message),
  })
  assert.deepEqual(result.rules.map((rule) => rule.id), ['SEC-002', 'SEC-003'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /second\.json/)
  assert.match(warnings[0], /duplicate rule id "SEC-003"/)
})

test('loadRulesResilient 包内重复 id 时整包跳过', async () => {
  const warnings = []
  const files = { ...baseFiles(), 'self-dup.json': JSON.stringify([scopedRule('SEC-003'), scopedRule('SEC-003')]) }
  const result = await loadRulesResilient({
    rulesPath: 'rules/rules.json',
    principlesPath: 'rules/principles.md',
    packs: ['rules/packs/self-dup.json'],
    readFile: reader(files),
    warn: (message) => warnings.push(message),
  })
  assert.deepEqual(result.rules.map((rule) => rule.id), ['SEC-002'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /duplicate rule id "SEC-003"/)
})

test('loadRulesResilient 基础规则失败时不加载规则包（只用原则层）', async () => {
  const warnings = []
  const files = baseFiles()
  files['rules.json'] = new Error("ENOENT: no such file, open 'rules/rules.json'")
  files['front.json'] = JSON.stringify([scopedRule('SEC-003')])
  let packReads = 0
  const baseReader = reader(files)
  const readFile = async (path) => {
    if (String(path).endsWith('front.json')) packReads += 1
    return baseReader(path)
  }
  const result = await loadRulesResilient({
    rulesPath: 'rules/rules.json',
    principlesPath: 'rules/principles.md',
    packs: ['rules/packs/front.json'],
    readFile,
    warn: (message) => warnings.push(message),
  })
  assert.deepEqual(result.rules, [])
  assert.equal(result.principles, principles)
  assert.equal(packReads, 0)
})
