import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractJsonFromText,
  structuredFromResult,
  validateResult,
} from '../src/host/structured.js'

const options = {
  allowedRuleIds: new Set(['COR-001']),
  allowedPaths: new Set(['src/a.ts']),
  evidenceContext: { mode: 'full', files: [{ path: 'src/a.ts', text: 'const a = 1' }] },
  evidenceMode: 'warn',
  coverageMode: 'warn',
}

const payload = {
  findings: [{
    ruleId: 'COR-001', dimension: 'correctness', severity: 'high',
    location: 'src/a.ts:1', problem: 'p', suggestion: 's',
    evidence: { snippet: 'const a = 1' },
  }],
  coverage: { files: [{ path: 'src/a.ts', status: 'reviewed' }] },
}

test('extractJsonFromText 支持 json 围栏、无语言围栏与围栏外说明', () => {
  assert.deepEqual(extractJsonFromText('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJsonFromText('说明\n```\n{"a":2}\n```\n结尾'), { a: 2 })
  assert.deepEqual(extractJsonFromText('前缀 {"a":3} 后缀'), { a: 3 })
  assert.equal(extractJsonFromText('没有任何 JSON'), undefined)
  assert.equal(extractJsonFromText('```json\n{坏掉的\n```'), undefined)
})

test('structuredFromResult 优先 structured，其次解析 output 里的 text block', () => {
  assert.deepEqual(structuredFromResult({ structured: { x: 1 } }), { x: 1 })
  const result = {
    stopReason: 'completed',
    output: [
      { type: 'text', text: '审查完成。' },
      { type: 'text', text: '```json\n' + JSON.stringify(payload) + '\n```' },
    ],
  }
  assert.deepEqual(structuredFromResult(result), payload)
  assert.equal(structuredFromResult({ output: [{ type: 'text', text: '没有 JSON' }] }), undefined)
})

test('validateResult 文本模式解析成功并走 schema/证据校验', () => {
  const result = {
    stopReason: 'completed',
    output: [{ type: 'text', text: '```json\n' + JSON.stringify(payload) + '\n```' }],
  }
  const validated = validateResult(result, options)
  assert.equal(validated.ok, true)
  assert.equal(validated.findings.length, 1)
  assert.deepEqual(validated.evidence, ['ok'])
})

test('validateResult 文本 JSON 坏掉时记 invalid-result，不抛异常', () => {
  const result = {
    stopReason: 'completed',
    output: [{ type: 'text', text: '```json\n{"findings":[}\n```' }],
  }
  assert.deepEqual(validateResult(result, options), { ok: false, reason: 'invalid-result' })
})

test('validateResult 未完成时仍记 incomplete（不解析文本）', () => {
  const result = {
    stopReason: 'max-tokens',
    output: [{ type: 'text', text: '```json\n' + JSON.stringify(payload) + '\n```' }],
  }
  assert.deepEqual(validateResult(result, options), { ok: false, reason: 'incomplete' })
})
