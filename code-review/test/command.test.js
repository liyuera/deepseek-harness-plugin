import test from 'node:test'
import assert from 'node:assert/strict'
import { createReviewCommand } from '../src/host/command.js'

const HUNK = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+const a = 1'] }

const FINDING = {
  ruleId: 'COR-001',
  dimension: 'correctness',
  severity: 'high',
  location: 'a.js:1',
  problem: 'catch 吞掉异常',
  suggestion: '补异常处理',
}

const RULES = { prompt: 'RULES', allowedRuleIds: new Set(['COR-001']) }

const VALID_RESULT = { stopReason: 'completed', structured: { findings: [FINDING] } }

function createCommand(overrides = {}) {
  const state = {
    starts: 0,
    rulesCalls: 0,
    diffCalls: 0,
    warns: [],
    requests: [],
  }

  const workspaceChanges = {
    summary() {
      return {
        turn: 1,
        files: [{ path: 'a.js', display: 'a.js' }],
        total: 1,
        added: 1,
        deleted: 0,
      }
    },
    async diff() {
      state.diffCalls += 1
      return { kind: 'text', hunks: [HUNK], added: 1, deleted: 0 }
    },
    ...overrides.workspaceChanges,
  }

  const subagents = {
    async startActivation(request) {
      state.starts += 1
      state.requests.push(request)
      return {
        childId: `child-${state.starts}`,
        result: Promise.resolve(overrides.result ?? VALID_RESULT),
        dispose: async () => {},
      }
    },
    ...overrides.subagents,
  }

  const command = createReviewCommand({
    config: {
      reviewerPreset: 'code-review',
      reviewerTimeoutMs: 1000,
      blockingSeverities: ['high', 'medium'],
      codeExtensions: ['.js'],
      maxDiffBytes: 200000,
      modelOverride: undefined,
      ...overrides.config,
    },
    workspaceChanges,
    subagents,
    getRules: async () => {
      state.rulesCalls += 1
      return RULES
    },
    logger: {
      warn(...args) {
        state.warns.push(args)
      },
    },
    latestSeq: () => 7,
    isReviewing: () => false,
    ...overrides.deps,
  })

  return { command, state, workspaceChanges }
}

const agent = { session: { id: 's1', header: { origin: 'user' } } }
const signal = () => new AbortController().signal

test('/review 撞上自动审查锁时直接返回错误，不启动第二个 reviewer', async () => {
  const harness = createCommand({ deps: { isReviewing: () => true } })

  const result = await harness.command.handler({ agent, signal: signal() })

  assert.deepEqual(result, { kind: 'error', text: '已有审查在进行中，请稍后再试。' })
  assert.equal(harness.state.rulesCalls, 0, '锁检查应在读规则之前')
  assert.equal(harness.state.starts, 0)
})

test('/review 取不到 summary 时返回错误文案而不是 TypeError', async () => {
  const harness = createCommand()
  delete harness.workspaceChanges.summary

  const result = await harness.command.handler({ agent, signal: signal() })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /本轮没有可审查的改动/)
  assert.equal(harness.state.starts, 0)
})

test('/review 报告文件数使用 summary.total', async () => {
  const harness = createCommand({
    workspaceChanges: {
      summary() {
        return {
          turn: 1,
          files: [
            { path: 'a.js', display: 'a.js' },
            { path: 'b.js', display: 'b.js' },
          ],
          total: 5,
          added: 1,
          deleted: 0,
        }
      },
    },
  })

  const result = await harness.command.handler({ agent, signal: signal() })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /本次 5 文件/)
  assert.equal(harness.state.diffCalls, 2)
})

test('/review 把 logger 传给 reviewer，丢弃非法 finding 时有日志', async () => {
  const harness = createCommand({
    result: {
      stopReason: 'completed',
      structured: {
        findings: [FINDING, { ...FINDING, ruleId: 'SEC-999' }],
      },
    },
  })

  const result = await harness.command.handler({ agent, signal: signal() })

  assert.equal(result.kind, 'success')
  assert.ok(harness.state.warns.some((args) => String(args[0]).includes('丢弃 1 条非法 finding')))
})
