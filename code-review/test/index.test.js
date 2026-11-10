import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, inject } from '../index.js'

const HUNK = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+const a = 1'] }

const FINDING = {
  ruleId: 'COR-001',
  dimension: 'correctness',
  severity: 'high',
  location: 'm.js:1',
  problem: 'catch 吞掉异常',
  suggestion: '补异常处理',
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 自包含运行时：只实现 index.js 依赖的表面，避免引入外部 mock 库。
 */
function createHarness(config = {}, options = {}) {
  const state = {
    steers: [],
    starts: [],
    disposed: 0,
    debug: [],
    warns: [],
    infos: [],
    commands: [],
    handlers: {},
    guard: undefined,
    summaries: new Map(),
    diffLine: '+const a = 1',
    activation: () => ({ result: Promise.resolve({ stopReason: 'completed', structured: { findings: [] } }) }),
  }

  const ctx = {
    tools: {
      guard(fn) {
        state.guard = fn
      },
    },
    commands: {
      register(def) {
        if (options.registerThrows) throw new Error('command "review" already registered')
        state.commands.push(def)
      },
    },
    logger: {
      debug(...args) {
        state.debug.push(args)
      },
      info(...args) {
        state.infos.push(args)
      },
      warn(...args) {
        state.warns.push(args)
      },
    },
    on(event, handler) {
      ;(state.handlers[event] ??= []).push(handler)
    },
    workspaceChanges: {
      summary(sessionId, seq) {
        return state.summaries.get(`${sessionId}:${seq}`)
      },
      async diff() {
        return {
          kind: 'text',
          hunks: [{ ...HUNK, lines: [state.diffLine] }],
          added: 1,
          deleted: 1,
        }
      },
    },
    subagents: {
      async startActivation(request) {
        state.starts.push(request)
        const activation = state.activation(request) ?? {}
        return {
          childId: `child-${state.starts.length}`,
          get result() {
            return activation.result
          },
          dispose() {
            state.disposed += 1
            return activation.dispose?.()
          },
        }
      },
    },
  }

  apply(ctx, config)

  const emit = (event, ...args) => Promise.all((state.handlers[event] ?? []).map((handler) => handler(...args)))

  const addSummary = ({
    sessionId = 's1',
    seq,
    turn,
    files = [{ path: 'm.js', display: 'm.js' }],
    total = files.length,
    added = 1,
    deleted = 0,
  }) => {
    state.summaries.set(`${sessionId}:${seq}`, { turn, files, total, added, deleted })
  }

  const markChanges = (seq, sessionId = 's1') =>
    emit('session/event', { id: sessionId, header: { origin: 'user' } }, { type: 'workspace/changes', seq })

  return { state, ctx, emit, addSummary, markChanges }
}

function makeAgent(state, sessionId = 's1') {
  return {
    session: { id: sessionId, header: { origin: undefined } },
    steer(message) {
      state.steers.push(message.content[0].text)
    },
  }
}

function signal() {
  return new AbortController().signal
}

function warnHas(state, text) {
  return state.warns.some((args) => String(args[0]).includes(text))
}

function debugHas(state, text) {
  return state.debug.some((args) => String(args[0]).includes(text))
}

test('正常阻塞注入：首轮 steer 提醒还会复审', async () => {
  const harness = createHarness({ maxRounds: 2 })
  harness.state.activation = () => ({
    result: Promise.resolve({ stopReason: 'completed', structured: { findings: [FINDING] } }),
  })
  harness.addSummary({ seq: 7, turn: 1 })
  await harness.markChanges(7)
  const agent = makeAgent(harness.state)

  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.starts.length, 1)
  assert.equal(harness.state.steers.length, 1)
  assert.match(harness.state.steers[0], /结论: 需修改/)
  assert.match(harness.state.steers[0], /修完会再复审一次/)

  const metric = harness.state.debug.find((args) => String(args[0]).startsWith('[code-review] reviewed'))
  assert.ok(metric, '成功后应有指标日志')
  assert.equal(metric[1], 1, '指标日志应记录 turn')
  assert.equal(metric[2], 1, '指标日志应记录文件数')
  assert.equal(metric[3], 1, '指标日志应记录 findings 数')
})

test('末轮文案不再承诺复审', async () => {
  const harness = createHarness({ maxRounds: 1 })
  harness.state.activation = () => ({
    result: Promise.resolve({ stopReason: 'completed', structured: { findings: [FINDING] } }),
  })
  harness.addSummary({ seq: 7, turn: 1 })
  await harness.markChanges(7)
  const agent = makeAgent(harness.state)

  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.steers.length, 1)
  assert.match(harness.state.steers[0], /不会再自动复审/)
  assert.equal(harness.state.steers[0].includes('修完会再复审一次'), false)
})

test('同 turn 复审通过：第二次 steer 报告通过', async () => {
  const harness = createHarness({ maxRounds: 2 })
  let calls = 0
  harness.state.activation = () => {
    calls += 1
    return {
      result: Promise.resolve({
        stopReason: 'completed',
        structured: { findings: calls === 1 ? [FINDING] : [] },
      }),
    }
  }
  harness.addSummary({ seq: 7, turn: 1 })
  await harness.markChanges(7)
  const agent = makeAgent(harness.state)

  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })
  // 修完后的 diff 必须变化，否则会被同 diff 去重拦下。
  harness.state.diffLine = '+const a = 2'
  harness.addSummary({ seq: 8, turn: 1 })
  await harness.markChanges(8)
  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.steers.length, 2)
  assert.match(harness.state.steers[1], /结论: 通过/)
  assert.match(harness.state.steers[1], /可以收尾了/)
})

test('跨 turn 不泄漏上一轮的阻塞历史', async () => {
  const harness = createHarness({ maxRounds: 2 })
  let calls = 0
  harness.state.activation = () => {
    calls += 1
    return {
      result: Promise.resolve({
        stopReason: 'completed',
        structured: { findings: calls === 1 ? [FINDING] : [] },
      }),
    }
  }
  harness.addSummary({ seq: 7, turn: 1 })
  await harness.markChanges(7)
  const agent = makeAgent(harness.state)
  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })
  assert.equal(harness.state.steers.length, 1)

  harness.addSummary({ seq: 8, turn: 2 })
  await harness.markChanges(8)
  await harness.emit('agent/turn-stopping', { agent, turn: 2, signal: signal() })

  assert.equal(harness.state.steers.length, 1, '新 turn 干净不应注入通过')
})

test('stale summary 不消费轮次', async () => {
  const harness = createHarness({ maxRounds: 2 })
  harness.addSummary({ seq: 7, turn: 0 })
  await harness.markChanges(7)
  const agent = makeAgent(harness.state)

  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.starts.length, 0)
  assert.equal(harness.state.steers.length, 0)
  assert.ok(harness.state.debug.some((args) => String(args[0]).includes('stale-summary')))

  harness.addSummary({ seq: 8, turn: 1 })
  await harness.markChanges(8)
  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.starts.length, 1, 'stale 跳过后轮次应仍可用')
})

test('取消不计失败：两次中断后第三次仍能审查', async () => {
  const harness = createHarness({ maxRounds: 2 })
  harness.state.activation = () => ({
    result: Promise.resolve({ stopReason: 'incomplete', structured: undefined }),
  })
  const aborted = new AbortController()
  aborted.abort()
  const agent = makeAgent(harness.state)

  for (const turn of [1, 2]) {
    harness.addSummary({ seq: 6 + turn, turn })
    await harness.markChanges(6 + turn)
    await harness.emit('agent/turn-stopping', { agent, turn, signal: aborted.signal })
  }

  assert.equal(harness.state.starts.length, 0, '已取消的 turn 不应启动子代理')
  assert.equal(warnHas(harness.state, '连续失败'), false, '取消不应打开熔断')

  harness.state.activation = () => ({
    result: Promise.resolve({ stopReason: 'completed', structured: { findings: [] } }),
  })
  harness.addSummary({ seq: 9, turn: 3 })
  await harness.markChanges(9)
  await harness.emit('agent/turn-stopping', { agent, turn: 3, signal: signal() })

  assert.equal(harness.state.starts.length, 1, '取消后第三次应正常审查')
})

test('两次真实失败打开熔断，第三次跳过', async () => {
  const harness = createHarness({ maxRounds: 2 })
  harness.state.activation = () => ({
    result: Promise.resolve({ stopReason: 'error', structured: undefined }),
  })
  const agent = makeAgent(harness.state)

  for (const turn of [1, 2]) {
    harness.addSummary({ seq: 6 + turn, turn })
    await harness.markChanges(6 + turn)
    await harness.emit('agent/turn-stopping', { agent, turn, signal: signal() })
  }
  assert.equal(harness.state.starts.length, 2)
  assert.equal(warnHas(harness.state, '连续失败'), true)

  harness.addSummary({ seq: 9, turn: 3 })
  await harness.markChanges(9)
  await harness.emit('agent/turn-stopping', { agent, turn: 3, signal: signal() })

  assert.equal(harness.state.starts.length, 2, '熔断后不应再起子代理')
  assert.ok(harness.state.debug.some((args) => String(args[0]).includes('breaker-open')))
})

test('取消会中断已发布的审查（不等 120s 超时）', async () => {
  const harness = createHarness({ maxRounds: 2, reviewerTimeoutMs: 3000 })
  let publish
  const published = new Promise((resolve) => {
    publish = resolve
  })
  harness.state.activation = () => {
    const never = new Promise(() => {})
    return {
      get result() {
        publish()
        return never
      },
    }
  }
  harness.addSummary({ seq: 7, turn: 1 })
  await harness.markChanges(7)
  const agent = makeAgent(harness.state)
  const controller = new AbortController()

  const stopping = harness.emit('agent/turn-stopping', { agent, turn: 1, signal: controller.signal })
  await published
  const abortedAt = Date.now()
  controller.abort()
  const outcome = await Promise.race([stopping.then(() => 'done'), delay(1000).then(() => 'timeout')])

  assert.equal(outcome, 'done', '取消后 handler 必须很快返回')
  assert.ok(Date.now() - abortedAt < 1000)
  assert.equal(harness.state.disposed, 1, '已发布的 activation 必须 dispose')
  assert.equal(harness.state.steers.length, 0)
  assert.equal(warnHas(harness.state, '连续失败'), false)

  harness.state.activation = () => ({
    result: Promise.resolve({ stopReason: 'completed', structured: { findings: [] } }),
  })
  harness.addSummary({ seq: 8, turn: 2 })
  await harness.markChanges(8)
  await harness.emit('agent/turn-stopping', { agent, turn: 2, signal: signal() })
  assert.equal(harness.state.starts.length, 2, '取消后熔断未打开，下一次应继续审查')
})

// —— 以下三条覆盖 B3/B4/B5：成功竞态取消、摘要读取 fail-open、截断文件计数 ——

test('成功结果到达时已取消则不再 steer', async () => {
  const harness = createHarness({ maxRounds: 2 })
  harness.state.activation = () => ({
    result: Promise.resolve({ stopReason: 'completed', structured: { findings: [FINDING] } }),
  })
  const controller = new AbortController()
  const originalDebug = harness.ctx.logger.debug
  harness.ctx.logger.debug = (...args) => {
    originalDebug(...args)
    if (String(args[0]).startsWith('[code-review] reviewed')) controller.abort()
  }
  harness.addSummary({ seq: 7, turn: 1 })
  await harness.markChanges(7)
  const agent = makeAgent(harness.state)

  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: controller.signal })

  assert.equal(harness.state.starts.length, 1)
  assert.equal(harness.state.steers.length, 0, '取消后成功结果不应唤醒 turn')
  assert.equal(warnHas(harness.state, '连续失败'), false)
})

test('summary 读取抛错时 fail-open，不冒泡且只警告一次', async () => {
  const harness = createHarness({ maxRounds: 2 })
  harness.addSummary({ seq: 7, turn: 1 })
  await harness.markChanges(7)
  harness.ctx.workspaceChanges.summary = () => {
    throw new Error('summary-boom')
  }
  const agent = makeAgent(harness.state)

  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })
  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.starts.length, 0)
  assert.equal(harness.state.steers.length, 0)
  const summaryWarns = harness.state.warns.filter((args) => String(args[0]).includes('无法读取变更摘要'))
  assert.equal(summaryWarns.length, 1, '摘要读取失败只记一次警告')
})

test('报告文件数使用 summary.total 而不是截断后的 files.length', async () => {
  const harness = createHarness({ maxRounds: 2 })
  harness.state.activation = () => ({
    result: Promise.resolve({
      stopReason: 'completed',
      structured: { findings: [{ ...FINDING, location: 'a.js:1' }] },
    }),
  })
  harness.addSummary({
    seq: 7,
    turn: 1,
    files: [
      { path: 'a.js', display: 'a.js' },
      { path: 'b.js', display: 'b.js' },
    ],
    total: 5,
  })
  await harness.markChanges(7)
  const agent = makeAgent(harness.state)

  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.steers.length, 1)
  assert.match(harness.state.steers[0], /本次 5 文件/)
  assert.ok(harness.state.debug.some((args) => String(args[0]).includes('truncated')))
})

// —— 终审 D 批：同 diff 去重、通过判定、失败可观测、命令/渲染健壮性 ——

test('inject 声明 agentPresets，审查者 preset 可由 preset registry 提供', () => {
  assert.ok(inject.includes('agentPresets'), `inject=${inject.join(',')}`)
})

test('同一 turn 同一 diff 重复 stopping 只审一次，diff 变化后再审且未多耗轮次', async () => {
  const harness = createHarness({ maxRounds: 2 })
  harness.state.activation = () => ({
    result: Promise.resolve({ stopReason: 'completed', structured: { findings: [FINDING] } }),
  })
  harness.addSummary({ seq: 7, turn: 1 })
  await harness.markChanges(7)
  const agent = makeAgent(harness.state)

  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })
  assert.equal(harness.state.starts.length, 1)
  assert.equal(harness.state.steers.length, 1)

  // 同一份未变 diff 以新 seq 再次宣告：内容指纹相同，应跳过。
  harness.addSummary({ seq: 8, turn: 1 })
  await harness.markChanges(8)
  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.starts.length, 1, '重复 diff 不应再起子代理')
  assert.equal(harness.state.steers.length, 1, '重复 diff 不应重复注入')
  assert.ok(debugHas(harness.state, 'duplicate-diff'), '应记录 duplicate-diff')

  // 去重跳过回滚了轮次：maxRounds=2，第三次仍能审查（第二次真实审查取第 2 轮）。
  harness.state.diffLine = '+const a = 2'
  harness.addSummary({ seq: 9, turn: 1 })
  await harness.markChanges(9)
  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.starts.length, 2, 'diff 变化后应能再次审查')
  assert.equal(harness.state.steers.length, 2)
})

test('session/disposed 清理同 diff 去重记录，重建同 id 会话后可再审', async () => {
  const harness = createHarness({ maxRounds: 2 })
  harness.state.activation = () => ({
    result: Promise.resolve({ stopReason: 'completed', structured: { findings: [FINDING] } }),
  })
  harness.addSummary({ seq: 7, turn: 1 })
  await harness.markChanges(7)
  await harness.emit('agent/turn-stopping', { agent: makeAgent(harness.state), turn: 1, signal: signal() })
  assert.equal(harness.state.starts.length, 1)

  await harness.emit('session/disposed', { id: 's1' })

  // 同 id、同 turn、同 seq、同内容：去重记录应已随会话清理，必须重新审查。
  harness.addSummary({ seq: 7, turn: 1 })
  await harness.markChanges(7)
  await harness.emit('agent/turn-stopping', { agent: makeAgent(harness.state), turn: 1, signal: signal() })
  assert.equal(harness.state.starts.length, 2)
})

test('取材为空不启动子代理、不消耗轮次，之后同 turn 正常 diff 仍能审', async () => {
  const harness = createHarness({ maxRounds: 2 })
  harness.state.activation = () => ({
    result: Promise.resolve({ stopReason: 'completed', structured: { findings: [FINDING] } }),
  })
  harness.addSummary({ seq: 7, turn: 1, files: [{ path: 'README.md', display: 'README.md' }] })
  await harness.markChanges(7)
  const agent = makeAgent(harness.state)

  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.starts.length, 0)
  assert.equal(harness.state.steers.length, 0)
  assert.ok(debugHas(harness.state, 'empty-collect'), '应记录 empty-collect')

  harness.addSummary({ seq: 8, turn: 1, files: [{ path: 'm.js', display: 'm.js' }] })
  await harness.markChanges(8)
  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.starts.length, 1, '空取材回滚后轮次仍可用')
})

test('全部 finding 被丢弃不算通过：不注入通过结论', async () => {
  const harness = createHarness({ maxRounds: 3 })
  harness.state.activation = () => ({
    result: Promise.resolve({ stopReason: 'completed', structured: { findings: [FINDING] } }),
  })
  harness.addSummary({ seq: 7, turn: 1 })
  await harness.markChanges(7)
  const agent = makeAgent(harness.state)

  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })
  assert.equal(harness.state.steers.length, 1)
  assert.match(harness.state.steers[0], /结论: 需修改/)

  // 第二轮模型输出全部非法（未知规则 + 越界路径），findings 被清空。
  harness.state.activation = () => ({
    result: Promise.resolve({
      stopReason: 'completed',
      structured: {
        findings: [
          { ...FINDING, ruleId: 'SEC-999' },
          { ...FINDING, location: '/etc/passwd:1' },
        ],
      },
    }),
  })
  harness.state.diffLine = '+const a = 2'
  harness.addSummary({ seq: 8, turn: 1 })
  await harness.markChanges(8)
  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.steers.length, 1, '全部丢弃时不应再注入')
  assert.equal(
    harness.state.steers.some((text) => text.includes('结论: 通过')),
    false,
    '上一轮阻塞后不能因模型输出不可用而注入通过',
  )
})

test('steer 抛错不记审查失败，熔断仍关闭', async () => {
  const harness = createHarness({ maxRounds: 5 })
  harness.state.activation = () => ({
    result: Promise.resolve({ stopReason: 'completed', structured: { findings: [FINDING] } }),
  })
  const agent = makeAgent(harness.state)
  agent.steer = () => {
    throw new Error('steer-boom')
  }

  for (let index = 0; index < 2; index += 1) {
    harness.state.diffLine = `+const a = ${index + 1}`
    harness.addSummary({ seq: 7 + index, turn: 1 })
    await harness.markChanges(7 + index)
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })
  }

  assert.equal(harness.state.starts.length, 2)
  assert.ok(warnHas(harness.state, 'steer 失败'), '应记录 steer 失败警告')
  assert.equal(warnHas(harness.state, '连续失败'), false, 'steer 失败不应打开熔断')

  harness.state.activation = () => ({
    result: Promise.resolve({ stopReason: 'completed', structured: { findings: [] } }),
  })
  harness.state.diffLine = '+const a = 9'
  harness.addSummary({ seq: 9, turn: 1 })
  await harness.markChanges(9)
  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.starts.length, 3, '熔断未打开，第三次应正常审查')
})

test('summary 缺 files 时按 stale 跳过，不抛错也不启动子代理', async () => {
  const harness = createHarness({ maxRounds: 2 })
  harness.state.summaries.set('s1:7', { turn: 1 })
  await harness.markChanges(7)
  const agent = makeAgent(harness.state)

  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.starts.length, 0)
  assert.equal(harness.state.steers.length, 0)
  assert.ok(debugHas(harness.state, 'stale-summary'))
})

test('审查失败时 debug 记录原因', async () => {
  const harness = createHarness({ maxRounds: 2 })
  harness.state.activation = () => ({
    result: Promise.resolve({ stopReason: 'error', structured: undefined }),
  })
  harness.addSummary({ seq: 7, turn: 1 })
  await harness.markChanges(7)
  const agent = makeAgent(harness.state)

  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.ok(
    harness.state.debug.some((args) => String(args[0]).includes('review failed:') && String(args[1]).includes('incomplete')),
    'debug 应带 review failed: 与失败原因',
  )
})

test('复审通过时带未审清单与原因', async () => {
  const harness = createHarness({ maxRounds: 3 })
  let calls = 0
  harness.state.activation = () => {
    calls += 1
    return {
      result: Promise.resolve({
        stopReason: 'completed',
        structured: { findings: calls === 1 ? [FINDING] : [] },
      }),
    }
  }
  const files = [
    { path: 'm.js', display: 'm.js' },
    { path: 'notes.md', display: 'notes.md' },
  ]
  harness.addSummary({ seq: 7, turn: 1, files })
  await harness.markChanges(7)
  const agent = makeAgent(harness.state)

  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })
  harness.state.diffLine = '+const a = 2'
  harness.addSummary({ seq: 8, turn: 1, files })
  await harness.markChanges(8)
  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.steers.length, 2)
  assert.match(harness.state.steers[1], /结论: 通过/)
  assert.match(harness.state.steers[1], /未审: notes\.md（not-code）/)
})

test('maxRounds 封顶：连续三轮只审两轮，第三轮记录 rounds-exhausted', async () => {
  const harness = createHarness({ maxRounds: 2 })
  harness.state.activation = () => ({
    result: Promise.resolve({ stopReason: 'completed', structured: { findings: [FINDING] } }),
  })
  const agent = makeAgent(harness.state)

  for (let index = 0; index < 3; index += 1) {
    harness.state.diffLine = `+const a = ${index + 1}`
    harness.addSummary({ seq: 7 + index, turn: 1 })
    await harness.markChanges(7 + index)
    await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })
  }

  assert.equal(harness.state.starts.length, 2)
  assert.equal(harness.state.steers.length, 2)
  assert.ok(debugHas(harness.state, 'rounds-exhausted'))
})

test('命令注册冲突时警告并继续提供自动审查', async () => {
  const harness = createHarness({ maxRounds: 2 }, { registerThrows: true })
  assert.ok(warnHas(harness.state, '/review 命令注册失败'), '应警告命令注册失败')
  assert.equal(harness.state.commands.length, 0)

  harness.addSummary({ seq: 7, turn: 1 })
  await harness.markChanges(7)
  const agent = makeAgent(harness.state)
  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.starts.length, 1, '命令注册失败不应拖垮自动审查')
})
