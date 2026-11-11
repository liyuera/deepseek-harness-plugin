import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyVerification,
  buildVerifyPrompt,
  VERDICT_SCHEMA,
  verifyFindings,
} from '../src/host/verify.js'

const finding = (over = {}) => ({
  ruleId: 'COR-001',
  dimension: 'correctness',
  severity: 'high',
  location: 'src/a.ts:7',
  problem: 'catch 吞掉异常',
  suggestion: '补异常处理',
  evidence: { snippet: 'catch {}' },
  blocking: true,
  evidenceStatus: 'ok',
  ...over,
})

/** 按调用顺序返回 verdict 的假 subagents。 */
function fakeSubagents(verdicts) {
  let index = 0
  return {
    calls: 0,
    async startActivation() {
      const verdict = verdicts[Math.min(index, verdicts.length - 1)]
      index += 1
      this.calls += 1
      return {
        childId: `v-${index}`,
        result: Promise.resolve(verdict),
        dispose: async () => {},
      }
    },
  }
}

const completed = (structured) => ({ stopReason: 'completed', structured })

test('buildVerifyPrompt 要求证伪、默认 false 并列出文件', () => {
  const prompt = buildVerifyPrompt({
    finding: finding(),
    files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
  })
  assert.match(prompt, /证伪/)
  assert.match(prompt, /默认 confirmed:false/)
  assert.match(prompt, /src\/a\.ts/)
  assert.match(prompt, /src\/b\.ts/)
  assert.match(prompt, /catch \{\}/)
  assert.match(prompt, /不得修改文件/)
})

test('VERDICT_SCHEMA 要求 confirmed/reason', () => {
  assert.deepEqual(VERDICT_SCHEMA.required, ['confirmed', 'reason'])
})

test('确认的 finding 标 confirmed，驳回的丢弃，失败标 unverified', async () => {
  const subagents = fakeSubagents([
    completed({ confirmed: true, reason: '已尝试证伪但代码确实会吞异常' }),
    completed({ confirmed: false, reason: '外层已有 try/catch 保护，不会发生' }),
  ])
  const result = await verifyFindings({
    subagents,
    agent: {},
    preset: 'code-review',
    findings: [finding(), finding({ severity: 'medium', problem: '第二个' })],
    files: [{ path: 'src/a.ts' }],
    blockingSeverities: ['high', 'medium'],
    maxFindings: 3,
    timeoutMs: 1000,
    signal: new AbortController().signal,
  })
  assert.equal(result.checked, 2)
  assert.equal(result.confirmed, 1)
  assert.equal(result.rejected, 1)
  assert.equal(result.unverified, 0)
  const merged = applyVerification([finding(), finding({ problem: '第二个' })], result.verdicts)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].verified, 'confirmed')
})

test('verifier 输出不合格/超时/抛错 → unverified，保留为仅报告', async () => {
  const subagents = {
    calls: 0,
    async startActivation() {
      this.calls += 1
      return {
        childId: 'v',
        result: Promise.resolve(completed({ confirmed: true, reason: '短' })),
        dispose: async () => {},
      }
    },
  }
  const result = await verifyFindings({
    subagents,
    agent: {},
    preset: 'code-review',
    findings: [finding()],
    files: [],
    blockingSeverities: ['high'],
    timeoutMs: 1000,
    signal: new AbortController().signal,
  })
  assert.equal(result.unverified, 1)
  const merged = applyVerification([finding()], result.verdicts)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].verified, 'unverified')
})

test('只复验阻塞且证据为 ok 的 findings，并受 maxFindings 限制', async () => {
  const subagents = fakeSubagents([completed({ confirmed: true, reason: '确认理由足够长一些' })])
  const findings = [
    finding({ severity: 'low' }),
    finding({ evidenceStatus: 'mismatch' }),
    finding({ severity: 'medium', location: 'src/a.ts:8' }),
    finding({ severity: 'high', location: 'src/a.ts:9' }),
  ]
  const result = await verifyFindings({
    subagents,
    agent: {},
    preset: 'code-review',
    findings,
    files: [],
    blockingSeverities: ['high', 'medium'],
    maxFindings: 1,
    timeoutMs: 1000,
    signal: new AbortController().signal,
  })
  assert.equal(result.checked, 1)
  assert.equal(subagents.calls, 1)
})

test('signal 已取消时不启动复验', async () => {
  const controller = new AbortController()
  controller.abort()
  const subagents = fakeSubagents([completed({ confirmed: true, reason: '确认理由足够长一些' })])
  const result = await verifyFindings({
    subagents,
    agent: {},
    preset: 'code-review',
    findings: [finding()],
    files: [],
    blockingSeverities: ['high'],
    timeoutMs: 1000,
    signal: controller.signal,
  })
  assert.equal(result.checked, 1)
  assert.equal(result.unverified, 1)
  assert.equal(subagents.calls, 0)
})

test('父 signal 取消时立即返回未证实并 dispose，不等 verifier 结算', async () => {
  let disposed = 0
  const subagents = {
    async startActivation() {
      return { childId: 'v', result: new Promise(() => {}), dispose: async () => { disposed += 1 } }
    },
  }
  const controller = new AbortController()
  const startedAt = Date.now()
  const pending = verifyFindings({
    subagents,
    agent: {},
    preset: 'code-review',
    findings: [finding()],
    files: [],
    blockingSeverities: ['high'],
    timeoutMs: 120000,
    signal: controller.signal,
  })
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  const result = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 1000)),
  ])
  assert.ok(Date.now() - startedAt < 1000)
  assert.equal(result.unverified, 1)
  assert.equal(disposed, 1)
})

test('abort 在 startActivation 返回前胜出：迟到 activation 仍被 dispose 且 result 被观察', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let disposed = 0
  const subagents = {
    async startActivation() {
      await gate
      const result = new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error('late-boom')), 0)
      })
      return { childId: 'v', result, dispose: async () => { disposed += 1 } }
    },
  }
  const controller = new AbortController()
  const pending = verifyFindings({
    subagents,
    agent: {},
    preset: 'code-review',
    findings: [finding()],
    files: [],
    blockingSeverities: ['high'],
    timeoutMs: 120000,
    signal: controller.signal,
  })
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  const result = await pending
  assert.equal(result.unverified, 1)
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(disposed, 1, '迟到的 activation 必须被 dispose')
})
