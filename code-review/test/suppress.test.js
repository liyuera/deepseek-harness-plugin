import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applySuppressions,
  fingerprintFinding,
  loadSuppressions,
  suppressionMatches,
  validateSuppressions,
} from '../src/host/suppress.js'

const finding = (over = {}) => ({
  ruleId: 'BEH-001',
  dimension: 'behavior',
  severity: 'low',
  location: 'src/app/form.ts:12',
  problem: '纯数字输入被静默丢弃',
  suggestion: '给用户反馈',
  ...over,
})

test('指纹不含行号：行号漂移不产生新身份', () => {
  const a = fingerprintFinding(finding({ location: 'src/app/form.ts:12' }))
  const b = fingerprintFinding(finding({ location: 'src/app/form.ts:99' }))
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{16}$/)
})

test('指纹随规则/路径/问题文本变化', () => {
  const base = fingerprintFinding(finding())
  assert.notEqual(base, fingerprintFinding(finding({ ruleId: 'BEH-002' })))
  assert.notEqual(base, fingerprintFinding(finding({ location: 'src/app/other.ts:12' })))
  assert.notEqual(base, fingerprintFinding(finding({ problem: '另一件事' })))
})

test('validateSuppressions 校验字段与 matcher 组合', () => {
  assert.doesNotThrow(() => validateSuppressions([{ ruleId: 'BEH-001', reason: '产品决策' }]))
  assert.throws(() => validateSuppressions([{ reason: 'no matcher' }]), /at least one of/)
  assert.throws(() => validateSuppressions([{ ruleId: 'BEH-001' }]), /reason must be a non-empty string/)
  assert.throws(
    () => validateSuppressions([{ ruleId: 'BEH-001', reason: 'x', expiresAt: 'not-a-date' }]),
    /expiresAt must be an ISO date string/,
  )
  assert.throws(
    () => validateSuppressions([{ ruleId: 'BEH-001', reason: 'x', disposition: 'meh' }]),
    /disposition must be one of/,
  )
})

test('匹配顺序：指纹优先，其次 ruleId+glob/key；过期失效', () => {
  const target = finding()
  const expired = { ruleId: 'BEH-001', reason: '过期', expiresAt: '2020-01-01T00:00:00Z' }
  assert.equal(suppressionMatches(expired, target, Date.parse('2026-01-01T00:00:00Z')), false)
  assert.equal(
    suppressionMatches({ ruleId: 'BEH-001', reason: '规则' }, target),
    true,
  )
  assert.equal(
    suppressionMatches({ ruleId: 'BEH-001', pathGlob: '**/other/**', reason: '路径' }, target),
    false,
  )
  assert.equal(
    suppressionMatches({ key: '静默丢弃', reason: '关键词' }, target),
    true,
  )
  assert.equal(
    suppressionMatches({ fingerprint: 'deadbeefdeadbeef', reason: '指纹' }, { ...target, fingerprint: 'deadbeefdeadbeef' }),
    true,
  )
})

test('applySuppressions 保留可见性：返回 kept 与 suppressed 清单', () => {
  const rules = validateSuppressions([{ ruleId: 'BEH-001', reason: '产品决策', disposition: 'wontfix' }])
  const { kept, suppressed } = applySuppressions([finding(), finding({ ruleId: 'COR-001' })], rules)
  assert.equal(kept.length, 1)
  assert.equal(kept[0].ruleId, 'COR-001')
  assert.equal(suppressed.length, 1)
  assert.equal(suppressed[0].finding.ruleId, 'BEH-001')
  assert.equal(suppressed[0].reason, '产品决策')
  assert.equal(suppressed[0].disposition, 'wontfix')
})

test('loadSuppressions 合并 config 与仓库文件；文件缺失/损坏只警告', async () => {
  const config = {
    suppressions: validateSuppressions([{ ruleId: 'BEH-001', reason: '配置' }]),
    suppressionsFile: '.dsh/code-review-suppressions.json',
  }
  const reads = []
  const readFile = async (path) => {
    reads.push(path)
    return JSON.stringify({ version: 1, suppressions: [{ ruleId: 'COR-001', reason: '仓库' }] })
  }
  const merged = await loadSuppressions({ config, cwd: '/work', readFile })
  assert.equal(merged.length, 2)
  assert.equal(reads[0], '/work/.dsh/code-review-suppressions.json')

  const warnings = []
  const missing = await loadSuppressions({
    config: { suppressions: [], suppressionsFile: 'x.json' },
    cwd: '/work',
    readFile: async () => { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error },
    warn: (text) => warnings.push(text),
  })
  assert.equal(missing.length, 0)
  assert.deepEqual(warnings, [])

  const broken = await loadSuppressions({
    config: { suppressions: [], suppressionsFile: 'x.json' },
    cwd: '/work',
    readFile: async () => 'not json',
    warn: (text) => warnings.push(text),
  })
  assert.equal(broken.length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /抑制文件不可用/)
})
