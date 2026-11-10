import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt, runReview, REVIEW_SCHEMA } from '../src/host/reviewer.js'

const files = [{ path: 'src/a.ts', display: 'src/a.ts', text: '@@ -1,1 +1,1 @@\n-a\n+b', added: 1, deleted: 1 }]

test('buildPrompt 带变更清单与 diff', () => {
  const prompt = buildPrompt({ rulesPrompt: 'RULES', files, skipped: [{ path: 'x.png', reason: 'binary' }] })
  assert.match(prompt, /RULES/)
  assert.match(prompt, /src\/a\.ts/)
  assert.match(prompt, /@@ -1,1 \+1,1 @@/)
  assert.match(prompt, /x\.png（binary）/)
  assert.match(prompt, /只返回 JSON/)
})

test('schema 要求 findings 数组', () => {
  assert.equal(REVIEW_SCHEMA.type, 'object')
  assert.deepEqual(REVIEW_SCHEMA.required, ['findings'])
})

function fakeSubagents(result) {
  return {
    calls: [],
    async startActivation(spec) {
      this.calls.push(spec)
      return { childId: 'child-1', result: Promise.resolve(result), dispose: async () => {} }
    },
  }
}

const validFinding = {
  ruleId: 'SEC-001', dimension: 'security', severity: 'high',
  location: 'src/a.ts:42', problem: 'p', suggestion: 's',
}

test('成功路径返回校验后的 findings', async () => {
  const subagents = fakeSubagents({ stopReason: 'completed', structured: { findings: [validFinding] } })
  const result = await runReview({
    subagents, agent: { id: 'a' }, preset: 'code-review', prompt: 'P', timeoutMs: 1000,
    signal: new AbortController().signal, allowedRuleIds: new Set(['SEC-001']), allowedPaths: new Set(['src/a.ts']),
  })
  assert.equal(result.ok, true)
  assert.equal(result.findings.length, 1)
  assert.equal(subagents.calls[0].provider, 'spawn')
  assert.equal(subagents.calls[0].delivery, 'caller')
  assert.equal(subagents.calls[0].request.agentPreset, 'code-review')
})

test('stopReason 非 completed 视为失败', async () => {
  const subagents = fakeSubagents({ stopReason: 'error', structured: undefined })
  const result = await runReview({
    subagents, agent: {}, preset: 'code-review', prompt: 'P', timeoutMs: 1000,
    signal: new AbortController().signal, allowedRuleIds: new Set(), allowedPaths: new Set(),
  })
  assert.deepEqual(result, { ok: false, reason: 'incomplete' })
})

test('超出规则或路径范围的 finding 被丢弃', async () => {
  const subagents = fakeSubagents({
    stopReason: 'completed',
    structured: {
      findings: [
        validFinding,
        { ...validFinding, ruleId: 'SEC-999' },
        { ...validFinding, location: 'src/zzz.ts:1' },
      ],
    },
  })
  const result = await runReview({
    subagents, agent: {}, preset: 'code-review', prompt: 'P', timeoutMs: 1000,
    signal: new AbortController().signal, allowedRuleIds: new Set(['SEC-001']), allowedPaths: new Set(['src/a.ts']),
  })
  assert.equal(result.ok, true)
  assert.equal(result.findings.length, 1)
})

test('structured 形状不对视为失败', async () => {
  const subagents = fakeSubagents({ stopReason: 'completed', structured: { nope: true } })
  const result = await runReview({
    subagents, agent: {}, preset: 'code-review', prompt: 'P', timeoutMs: 1000,
    signal: new AbortController().signal, allowedRuleIds: new Set(), allowedPaths: new Set(),
  })
  assert.deepEqual(result, { ok: false, reason: 'invalid-result' })
})

test('超时返回 timeout 并 dispose', async () => {
  let disposed = false
  const subagents = {
    async startActivation() {
      return { childId: 'c', result: new Promise(() => {}), dispose: async () => { disposed = true } }
    },
  }
  const result = await runReview({
    subagents, agent: {}, preset: 'code-review', prompt: 'P', timeoutMs: 20,
    signal: new AbortController().signal, allowedRuleIds: new Set(), allowedPaths: new Set(),
  })
  assert.deepEqual(result, { ok: false, reason: 'timeout' })
  assert.equal(disposed, true)
})

test('服务抛错返回 provider-error', async () => {
  const subagents = { async startActivation() { throw new Error('boom') } }
  const result = await runReview({
    subagents, agent: {}, preset: 'code-review', prompt: 'P', timeoutMs: 1000,
    signal: new AbortController().signal, allowedRuleIds: new Set(), allowedPaths: new Set(),
  })
  assert.deepEqual(result, { ok: false, reason: 'provider-error' })
})
