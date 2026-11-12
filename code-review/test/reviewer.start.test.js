import test from 'node:test'
import assert from 'node:assert/strict'
import { REVIEW_SCHEMA, startReview } from '../src/host/reviewer.js'
import { fakeSubagents } from './helpers.js'

function startInput(overrides = {}) {
  const corFinding = {
    ruleId: 'COR-001', dimension: 'correctness', severity: 'high',
    location: 'src/a.ts:7', problem: 'p', suggestion: 's',
  }
  return {
    subagents: fakeSubagents({ stopReason: 'completed', structured: { findings: [corFinding] } }),
    agent: { id: 'agent-1' }, preset: 'code-review', prompt: 'P',
    allowedRuleIds: new Set(['COR-001']), allowedPaths: new Set(['src/a.ts']),
    ...overrides,
  }
}

test('startReview 正常路径返回 childId 与校验后的 findings，启动参数与 runReview 一致', async () => {
  const agent = { id: 'agent-1' }
  const subagents = fakeSubagents({
    stopReason: 'completed',
    structured: {
      findings: [{
        ruleId: 'COR-001', dimension: 'correctness', severity: 'high',
        location: 'src/a.ts:7', problem: 'p', suggestion: 's',
      }],
    },
  })
  const handle = await startReview({
    subagents, agent, preset: 'code-review', prompt: 'P',
    allowedRuleIds: new Set(['COR-001']), allowedPaths: new Set(['src/a.ts']),
  })
  assert.equal(typeof handle.childId, 'string')
  assert.ok(handle.childId.length > 0)
  const outcome = await handle.result
  assert.equal(outcome.ok, true)
  assert.equal(outcome.findings.length, 1)
  assert.equal(outcome.findings[0].ruleId, 'COR-001')

  const spec = subagents.calls[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.label, 'code-review')
  assert.equal(spec.delivery, 'caller')
  assert.equal(spec.request.parent, agent)
  assert.equal(spec.request.agentPreset, 'code-review')
  assert.equal(spec.request.outputSchema, undefined, '默认文本模式不挂 outputSchema（避免 provider 校验 tool 参数 JSON）')
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: 'P' }])
})

test('startReview 显式 outputMode=tool 时仍挂 outputSchema（回退路径）', async () => {
  const subagents = fakeSubagents({
    stopReason: 'completed',
    structured: { findings: [] },
  })
  const handle = await startReview({ ...startInput({ subagents }), outputMode: 'tool' })
  assert.equal(subagents.calls[0].request.outputSchema, REVIEW_SCHEMA)
  const outcome = await handle.result
  assert.equal(outcome.ok, true)
})

test('startReview 文本模式从最终文本解析 json 代码块', async () => {
  const subagents = fakeSubagents({
    stopReason: 'completed',
    output: [{
      type: 'text',
      text: '审查完成。\n```json\n{"findings":[],"coverage":{"files":[{"path":"src/a.ts","status":"reviewed"}]}}\n```\n',
    }],
  })
  const handle = await startReview(startInput({ subagents }))
  assert.equal(subagents.calls[0].request.outputSchema, undefined)
  const outcome = await handle.result
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.findings, [])
  assert.equal(outcome.coverage.valid, true)
})

test('startReview cancel 以 cancelled 结算、dispose 一次且幂等', async () => {
  let disposed = 0
  const subagents = {
    async startActivation() {
      return {
        childId: 'child-1',
        result: new Promise(() => {}),
        dispose: async () => { disposed += 1 },
      }
    },
  }
  const handle = await startReview(startInput({ subagents }))
  handle.cancel()
  assert.deepEqual(await handle.result, { ok: false, reason: 'cancelled' })
  assert.equal(disposed, 1)
  handle.cancel('again')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(disposed, 1, '重复 cancel 不应重复 dispose')
  assert.deepEqual(await handle.result, { ok: false, reason: 'cancelled' })
})

test('startReview 父 signal abort 时以 aborted 结算并 dispose', async () => {
  let disposed = 0
  const subagents = {
    async startActivation() {
      return {
        childId: 'child-1',
        result: new Promise(() => {}),
        dispose: async () => { disposed += 1 },
      }
    },
  }
  const controller = new AbortController()
  const handle = await startReview(startInput({ subagents, signal: controller.signal }))
  controller.abort()
  assert.deepEqual(await handle.result, { ok: false, reason: 'aborted' })
  assert.equal(disposed, 1)
})

test('startReview 的 activation.result 拒绝时为 provider-error，不 reject', async () => {
  const subagents = {
    async startActivation() {
      return { childId: 'child-1', result: Promise.reject(new Error('boom')), dispose: async () => {} }
    },
  }
  const handle = await startReview(startInput({ subagents }))
  assert.deepEqual(await handle.result, { ok: false, reason: 'provider-error' })
})

test('startReview 的 startActivation 抛错时整体 reject，不吞成 result', async () => {
  const subagents = { async startActivation() { throw new Error('start-boom') } }
  await assert.rejects(startReview(startInput({ subagents })), /start-boom/)
})

test('startReview 同样以规则表 severity 为权威', async () => {
  const subagents = fakeSubagents({
    stopReason: 'completed',
    structured: {
      findings: [{
        ruleId: 'COR-001', dimension: 'correctness', severity: 'low',
        location: 'src/a.ts:7', problem: 'p', suggestion: 's',
      }],
    },
  })
  const handle = await startReview(startInput({
    subagents,
    ruleSeverities: new Map([['COR-001', 'high']]),
  }))
  const outcome = await handle.result
  assert.equal(outcome.ok, true)
  assert.equal(outcome.findings[0].severity, 'high')
})

test('startActivation 返回前父 signal abort：拿到 activation 后立即 dispose 并以 aborted 结算', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let disposed = 0
  let spec
  const subagents = {
    async startActivation(request) {
      spec = request
      await gate
      return {
        childId: 'child-1',
        result: new Promise(() => {}),
        dispose: async () => { disposed += 1 },
      }
    },
  }
  const controller = new AbortController()
  const pending = startReview(startInput({ subagents, signal: controller.signal }))
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  release()
  const handle = await pending
  assert.deepEqual(await handle.result, { ok: false, reason: 'aborted' })
  assert.equal(disposed, 1)
  assert.equal(spec.signal.aborted, true)
})
