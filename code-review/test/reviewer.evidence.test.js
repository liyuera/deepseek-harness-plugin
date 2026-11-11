import test from 'node:test'
import assert from 'node:assert/strict'
import { REVIEW_SCHEMA, runReview } from '../src/host/reviewer.js'
import { RULE_DIMENSIONS } from '../src/host/rules.js'
import { fakeSubagents } from './helpers.js'

const FILE = {
  path: 'src/a.ts',
  display: 'src/a.ts',
  added: 1,
  deleted: 1,
  text: '@@ -1,1 +1,1 @@\n+const a = 1',
  hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+const a = 1'] }],
}

const finding = (over = {}) => ({
  ruleId: 'SEC-001',
  dimension: 'security',
  severity: 'high',
  location: 'src/a.ts:1',
  problem: 'p',
  suggestion: 's',
  evidence: { snippet: 'const a = 1' },
  ...over,
})

async function review(structured, options = {}) {
  const subagents = fakeSubagents({ stopReason: 'completed', structured })
  return runReview({
    subagents,
    agent: {},
    preset: 'code-review',
    prompt: 'P',
    timeoutMs: 1000,
    signal: new AbortController().signal,
    allowedRuleIds: new Set(['SEC-001']),
    allowedPaths: new Set(['src/a.ts']),
    evidenceContext: { mode: 'turn', files: [FILE] },
    ...options,
  })
}

test('schema 要求每条 finding 带 evidence.snippet，coverage 可选', () => {
  const item = REVIEW_SCHEMA.properties.findings.items
  assert.ok(item.required.includes('evidence'))
  assert.ok(item.properties.evidence.required.includes('snippet'))
  assert.ok(REVIEW_SCHEMA.properties.coverage)
  assert.deepEqual(REVIEW_SCHEMA.required, ['findings'])
})

test('证据命中变更行 → ok，并返回 coverage 缺失状态', async () => {
  const result = await review({ findings: [finding()] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.evidence, ['ok'])
  assert.equal(result.coverage.missing, true)
})

test('证据片段伪造 → warn 模式保留并标记 mismatch，不丢 finding', async () => {
  const result = await review({ findings: [finding({ evidence: { snippet: 'const fake = 1' } })] })
  assert.equal(result.ok, true)
  assert.equal(result.findings.length, 1)
  assert.deepEqual(result.evidence, ['mismatch'])
})

test('证据片段伪造 → enforce 模式丢弃，全丢为 invalid-result', async () => {
  const result = await review(
    { findings: [finding({ evidence: { snippet: 'const fake = 1' } })] },
    { evidenceMode: 'enforce' },
  )
  assert.deepEqual(result, { ok: false, reason: 'invalid-result' })
})

test('缺少证据 → warn 保留为 missing，enforce 丢弃', async () => {
  const structured = { findings: [finding({ evidence: undefined })] }
  const warned = await review(structured)
  assert.equal(warned.ok, true)
  assert.deepEqual(warned.evidence, ['missing'])

  const strict = await review(structured, { evidenceMode: 'enforce' })
  assert.deepEqual(strict, { ok: false, reason: 'invalid-result' })
})

test('location 落在 hunk 外（旧代码冒充新问题）总是丢弃', async () => {
  const result = await review({ findings: [finding({ location: 'src/a.ts:99' })] })
  assert.deepEqual(result, { ok: false, reason: 'invalid-result' })
})

test('coverage 合法时返回统计；未知路径判为无效', async () => {
  const valid = await review({
    findings: [finding()],
    coverage: { files: [{ path: 'src/a.ts', status: 'reviewed' }] },
  })
  assert.equal(valid.coverage.valid, true)
  assert.equal(valid.coverage.reviewed, 1)
  assert.equal(valid.coverage.skipped, 0)
  assert.equal(valid.coverage.unaccounted, 0)

  const invalid = await review({
    findings: [],
    coverage: { files: [{ path: 'src/other.ts', status: 'reviewed' }] },
  })
  assert.equal(invalid.coverage.valid, false)
  assert.equal(invalid.coverage.unaccounted, 1)
})

test('coverageMode=enforce 且未申报时返回 missing-coverage', async () => {
  const result = await review({ findings: [] }, { coverageMode: 'enforce' })
  assert.deepEqual(result, { ok: false, reason: 'missing-coverage' })
})

test('skipped 必须带 reason，否则 coverage 无效', async () => {
  const result = await review({
    findings: [],
    coverage: { files: [{ path: 'src/a.ts', status: 'skipped' }] },
  })
  assert.equal(result.coverage.valid, false)
})

test('文本模式（full）按当前文件内容校验证据', async () => {
  const result = await review(
    {
      findings: [
        finding({ location: 'src/a.ts:5', evidence: { snippet: 'const a = 1' } }),
        finding({ location: 'src/a.ts:6', evidence: { snippet: 'const fake = 1' } }),
      ],
    },
    {
      evidenceContext: { mode: 'full', files: [{ path: 'src/a.ts', text: 'const a = 1\nconst b = 2' }] },
    },
  )
  assert.equal(result.ok, true)
  assert.deepEqual(result.evidence, ['ok', 'mismatch'])
})

test('behavior 维度 finding 能通过校验（BEH 规则与 PRINCIPLE-behavior）', async () => {
  const beh = finding({
    ruleId: 'BEH-001',
    dimension: 'behavior',
    severity: 'low',
  })
  const behResult = await review({ findings: [beh] }, {
    allowedRuleIds: new Set(['BEH-001', 'PRINCIPLE-behavior']),
  })
  assert.equal(behResult.ok, true)
  assert.equal(behResult.findings[0].dimension, 'behavior')

  const principle = finding({
    ruleId: 'PRINCIPLE-behavior',
    dimension: 'behavior',
    severity: 'medium',
  })
  const principleResult = await review({ findings: [principle] }, {
    allowedRuleIds: new Set(['BEH-001', 'PRINCIPLE-behavior']),
  })
  assert.equal(principleResult.ok, true)
  assert.equal(principleResult.findings[0].ruleId, 'PRINCIPLE-behavior')
})

test('REVIEW_SCHEMA 的 dimension enum 与规则维度单一来源一致', () => {
  const dimensions = REVIEW_SCHEMA.properties.findings.items.properties.dimension.enum
  assert.deepEqual(dimensions, [...RULE_DIMENSIONS])
  assert.ok(dimensions.includes('behavior'))
})
