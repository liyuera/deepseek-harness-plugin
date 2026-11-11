import test from 'node:test'
import assert from 'node:assert/strict'
import { finalizeFindings } from '../src/host/finalize.js'
import { validateSuppressions } from '../src/host/suppress.js'

const finding = (over = {}) => ({
  ruleId: 'COR-001', dimension: 'correctness', severity: 'high',
  location: 'src/a.ts:7', problem: 'catch 吞掉异常', suggestion: '补异常处理',
  ...over,
})

function fakeSubagents(verdict) {
  const state = { calls: 0 }
  return {
    state,
    async startActivation() {
      state.calls += 1
      return { childId: 'v', result: Promise.resolve(verdict), dispose: async () => {} }
    },
  }
}

const baseConfig = {
  verify: 'blocking',
  blockingSeverities: ['high', 'medium'],
  maxVerifiedFindings: 3,
  verifyTimeoutMs: 1000,
  respectFixPolicy: true,
  manualFixGlobs: [],
  forbiddenFixGlobs: [],
}

test('抑制先于复验：被抑制的 finding 不花 verifier 调用', async () => {
  const subagents = fakeSubagents({ stopReason: 'completed', structured: { confirmed: true, reason: '已尝试证伪但确认可触发且路径可达' } })
  const result = await finalizeFindings({
    findings: [finding()],
    evidence: ['ok'],
    config: baseConfig,
    suppressions: validateSuppressions([{ ruleId: 'COR-001', reason: '产品决策' }]),
    files: [],
    subagents,
    agent: {},
    preset: 'code-review',
  })
  assert.equal(result.findings.length, 0)
  assert.equal(result.suppressed.length, 1)
  assert.equal(subagents.state.calls, 0)
})

test('复验关闭时只做装饰与指纹，不启动子代理', async () => {
  const subagents = fakeSubagents({})
  const result = await finalizeFindings({
    findings: [finding()],
    evidence: ['ok'],
    config: { ...baseConfig, verify: 'off' },
    files: [],
    subagents,
    agent: {},
    preset: 'code-review',
  })
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].fixMode, 'auto')
  assert.match(result.findings[0].fingerprint, /^[0-9a-f]{16}$/)
  assert.equal(subagents.state.calls, 0)
})

test('manual 路径写入 fixMode=manual，复验仍可进行', async () => {
  const subagents = fakeSubagents({ stopReason: 'completed', structured: { confirmed: true, reason: '已尝试证伪但确认可触发且路径可达' } })
  const result = await finalizeFindings({
    findings: [finding({ location: 'src/generated/a.ts:1' })],
    evidence: ['ok'],
    config: { ...baseConfig, manualFixGlobs: ['**/generated/**'] },
    files: [],
    subagents,
    agent: {},
    preset: 'code-review',
  })
  assert.equal(result.findings[0].fixMode, 'manual')
  assert.equal(result.findings[0].verified, 'confirmed')
})
