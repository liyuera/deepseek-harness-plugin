import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReviewCommand } from '../src/host/command.js'
import { loadRulesResilient } from '../src/host/rules.js'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 从真实规则表 + 前端规则包加载，验证命令侧同样按变更文件过滤。 */
function loadFrontendRules() {
  return loadRulesResilient({
    rulesPath: join(PACKAGE_ROOT, 'rules/rules.json'),
    principlesPath: join(PACKAGE_ROOT, 'rules/principles.md'),
    packs: [join(PACKAGE_ROOT, 'rules/packs/frontend-smartui.json')],
  })
}

const HUNK = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+const a = 1'] }

const FINDING = {
  ruleId: 'COR-001',
  dimension: 'correctness',
  severity: 'high',
  location: 'a.js:1',
  problem: 'catch 吞掉异常',
  suggestion: '补异常处理',
}

/** 最小原始规则集：`getRules()` 现在返回 `{ rules, principles }`，由 command 侧 compose。 */
const LOADED_RULES = {
  rules: [{
    id: 'COR-001',
    dimension: 'correctness',
    severity: 'high',
    title: '不得吞掉异常',
    check: 'catch 块不得为空',
    bad: 'try { await save() } catch {}',
    good: 'try { await save() } catch (e) { throw new SaveError(e) }',
  }],
  principles: '# 原则\n只按原则审。',
}

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
      return LOADED_RULES
    },
    logger: {
      warn(...args) {
        state.warns.push(args)
      },
    },
    latestSeq: () => 7,
    isReviewing: () => false,
    tracker: { epochOf: () => 1 },
    chain: { filesOf: () => [{ path: 'a.js', turns: [1], added: 1, deleted: 0 }] },
    journal: undefined,
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

test('summary 抛错时返回中文错误文案而不是把异常抛给命令层', async () => {
  const harness = createCommand({
    workspaceChanges: {
      summary() {
        throw new Error('summary-boom')
      },
    },
  })

  const result = await harness.command.handler({ agent, signal: signal() })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /审查失败：summary-boom/)
  assert.equal(harness.state.starts, 0)
  assert.ok(harness.state.warns.some((args) => String(args[0]).includes('/review 失败')))
})

test('通过报告带未审清单与原因', async () => {
  const harness = createCommand({
    result: { stopReason: 'completed', structured: { findings: [] } },
    workspaceChanges: {
      summary() {
        return {
          turn: 1,
          files: [
            { path: 'a.js', display: 'a.js' },
            { path: 'notes.md', display: 'notes.md' },
          ],
          total: 2,
          added: 1,
          deleted: 0,
        }
      },
    },
  })

  const result = await harness.command.handler({ agent, signal: signal() })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /结论: 通过/)
  assert.match(result.text, /未审: notes\.md（not-code）/)
})

test('/review 透传规则表 severity 覆盖模型输出', async () => {
  const harness = createCommand({
    result: {
      stopReason: 'completed',
      structured: { findings: [{ ...FINDING, severity: 'low' }] },
    },
    deps: {
      getRules: async () => ({
        ...LOADED_RULES,
        rules: LOADED_RULES.rules.map((rule) => ({ ...rule, severity: 'medium' })),
      }),
    },
  })

  const result = await harness.command.handler({ agent, signal: signal() })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /\[COR-001\] 正确性\/medium/)
})

// —— 规则作用域过滤 ——

test('/review 按本次变更文件过滤规则：tsx 带组件规则、不带样式规则', async () => {
  const harness = createCommand({
    config: { codeExtensions: ['.tsx', '.less'] },
    workspaceChanges: {
      summary() {
        return {
          turn: 1,
          files: [{ path: 'src/pages/A.tsx', display: 'src/pages/A.tsx' }],
          total: 1,
          added: 1,
          deleted: 0,
        }
      },
    },
    result: {
      stopReason: 'completed',
      structured: { findings: [{ ...FINDING, location: 'src/pages/A.tsx:1' }] },
    },
    deps: { getRules: loadFrontendRules },
  })

  const result = await harness.command.handler({ agent, signal: signal() })

  assert.equal(result.kind, 'success')
  const prompt = harness.state.requests[0].request.prompt[0].text
  assert.match(prompt, /\[CR-011\.01\]/, 'tsx 变更应带入 Hooks 规则（MNT-008）')
  assert.doesNotMatch(prompt, /\[CR-008\.0/, 'tsx 变更不应带样式规则（MNT-010）')
  assert.match(prompt, /### COR-001/)
})

test('/review 白名单按文件过滤：不适用规则的 finding 被丢弃', async () => {
  const harness = createCommand({
    config: { codeExtensions: ['.tsx', '.less'] },
    workspaceChanges: {
      summary() {
        return {
          turn: 1,
          files: [{ path: 'src/pages/A.tsx', display: 'src/pages/A.tsx' }],
          total: 1,
          added: 1,
          deleted: 0,
        }
      },
    },
    result: {
      stopReason: 'completed',
      structured: {
        findings: [{
          ...FINDING,
          ruleId: 'MNT-010',
          dimension: 'maintainability',
          location: 'src/pages/A.tsx:1',
        }],
      },
    },
    deps: { getRules: loadFrontendRules },
  })

  const result = await harness.command.handler({ agent, signal: signal() })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /invalid-result/)
  assert.ok(harness.state.warns.some((args) => String(args[0]).includes('丢弃 1 条非法 finding')))
})

test('/review 按本次变更文件过滤规则：less 带样式规则、不带组件规则', async () => {
  const harness = createCommand({
    config: { codeExtensions: ['.tsx', '.less'] },
    workspaceChanges: {
      summary() {
        return {
          turn: 1,
          files: [{ path: 'src/styles/a.less', display: 'src/styles/a.less' }],
          total: 1,
          added: 1,
          deleted: 0,
        }
      },
    },
    result: {
      stopReason: 'completed',
      structured: { findings: [{ ...FINDING, location: 'src/styles/a.less:1' }] },
    },
    deps: { getRules: loadFrontendRules },
  })

  const result = await harness.command.handler({ agent, signal: signal() })

  assert.equal(result.kind, 'success')
  const prompt = harness.state.requests[0].request.prompt[0].text
  assert.match(prompt, /\[CR-008\.0/, 'less 变更应带入样式规则（MNT-010）')
  assert.doesNotMatch(prompt, /\[CR-011\.01\]/, 'less 变更不应带 Hooks 规则（MNT-008）')
  assert.match(prompt, /### COR-001/)
})

// —— journal 脚注 ——

const COMPLETED_RECORD = {
  sessionId: 's1',
  turn: 1,
  seq: 7,
  mode: 'turn',
  startedAt: Date.now() - 60_000,
  finishedAt: Date.now(),
  status: 'completed',
  reason: null,
  files: 1,
  findingsTotal: 1,
  findings: [],
  injected: true,
}

const TIMEOUT_RECORD = {
  ...COMPLETED_RECORD,
  status: 'timeout',
  reason: 'timeout',
  findingsTotal: 0,
  injected: false,
}

test('/review 成功时追加自动审查留痕脚注', async () => {
  const recentCalls = []
  const harness = createCommand({
    deps: {
      journal: {
        recent(sessionId, limit) {
          recentCalls.push([sessionId, limit])
          return [COMPLETED_RECORD]
        },
      },
    },
  })

  const result = await harness.command.handler({ agent, signal: signal() })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /结论: 需修改/)
  assert.match(result.text, /自动审查记录（最近 5 条）:/)
  assert.match(result.text, /完成 · 1 条建议（已回灌）/)
  assert.ok(result.text.indexOf('结论') < result.text.indexOf('自动审查记录'), '脚注必须在报告之后')
  assert.deepEqual(recentCalls, [['s1', 5]])
})

test('/review 审查未完成时也追加留痕脚注', async () => {
  const harness = createCommand({
    result: { stopReason: 'incomplete' },
    deps: { journal: { recent: () => [TIMEOUT_RECORD] } },
  })

  const result = await harness.command.handler({ agent, signal: signal() })

  assert.equal(result.kind, 'error')
  assert.match(result.text, /^审查未完成（incomplete）。/)
  assert.match(result.text, /自动审查记录/)
  assert.match(result.text, /超时 · 未出结论/)
})

test('/review 无 journal 或无记录时输出保持不变', async () => {
  const plain = createCommand()
  const plainResult = await plain.command.handler({ agent, signal: signal() })
  assert.equal(plainResult.kind, 'success')
  assert.doesNotMatch(plainResult.text, /自动审查记录/)

  const empty = createCommand({ deps: { journal: { recent: () => [] } } })
  const emptyResult = await empty.command.handler({ agent, signal: signal() })
  assert.equal(emptyResult.text, plainResult.text, '无记录时不得追加空脚注')
})

// —— 全量审查（--full） ——

test('/review --full 用链内文件集合发起全量审查并输出报告', async () => {
  const harness = createCommand()
  const result = await harness.command.handler({ agent, rawInput: '--full', signal: signal() })

  assert.equal(result.kind, 'success')
  assert.equal(harness.state.starts, 1)
  assert.match(harness.state.requests[0].request.prompt[0].text, /链级全量复审/)
  assert.match(result.text, /结论/)
})

test('/review --full 在链内无文件时直接返回错误，不启动 reviewer', async () => {
  const harness = createCommand({ deps: { chain: { filesOf: () => [] } } })
  const result = await harness.command.handler({ agent, rawInput: '--full', signal: signal() })

  assert.deepEqual(result, { kind: 'error', text: '本条链没有可审查的改动。' })
  assert.equal(harness.state.starts, 0)
})

// —— v0.4：证据、复验、覆盖报告 ——

const EVIDENCE_FINDING = { ...FINDING, evidence: { snippet: 'const a = 1' } }

test('/review 报告带 coverage 覆盖行与复验统计', async () => {
  const harness = createCommand({
    result: {
      stopReason: 'completed',
      structured: {
        findings: [EVIDENCE_FINDING],
        coverage: { files: [{ path: 'a.js', status: 'reviewed' }] },
      },
    },
    config: { verify: 'blocking' },
  })

  const result = await harness.command.handler({ agent, signal: signal() })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /覆盖: 已审 1\/1/)
  // 复验只对证据 ok 的阻塞项发起；假 subagents 对复验返回的是 review 结果，按未证实降级。
  assert.match(result.text, /复验 1 条，未证实 1/)
  assert.equal(harness.state.starts, 2)
})

test('/review 证据片段伪造（warn）：finding 仅报告，不阻塞', async () => {
  const harness = createCommand({
    result: {
      stopReason: 'completed',
      structured: { findings: [{ ...EVIDENCE_FINDING, evidence: { snippet: 'const fake = 1' } }] },
    },
  })

  const result = await harness.command.handler({ agent, signal: signal() })

  assert.equal(result.kind, 'success')
  assert.match(result.text, /结论: 需人工确认/)
  assert.match(result.text, /未复验\/证据不足/)
})
