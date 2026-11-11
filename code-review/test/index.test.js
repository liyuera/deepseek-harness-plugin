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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const signal = () => new AbortController().signal

/** 轮询等待异步副作用出现，避免用固定 sleep 猜时序。 */
async function waitFor(predicate, { timeout = 2000, interval = 5 } = {}) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    if (predicate()) return
    await delay(interval)
  }
  throw new Error('waitFor timeout')
}

/** 一次成功的 activation 结算。 */
const completed = (findings = []) => ({ stopReason: 'completed', structured: { findings } })

/**
 * 自包含运行时：只实现 index.js 依赖的表面，避免引入外部 mock 库。
 *
 * `startActivation` 返回的 result 由测试手动 resolve/reject，用来观察
 * 「先返回、后结算」的异步行为；每次 activation 的 dispose 单独计数。
 */
function createHarness(config = {}, options = {}) {
  const state = {
    follows: [],
    steers: [],
    starts: [],
    pending: [],
    disposed: 0,
    debug: [],
    warns: [],
    infos: [],
    commands: [],
    handlers: {},
    effects: [],
    guard: undefined,
    summaries: new Map(),
    agents: new Map(),
    diffLine: '+const a = 1',
    startError: undefined,
    startGate: undefined,
    onStart: undefined,
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
    effect(execute, label) {
      const disposer = execute()
      state.effects.push({ disposer, label })
      return disposer
    },
    get(service) {
      if (service !== 'agents') return undefined
      return { get: (sessionId) => state.agents.get(sessionId) }
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
        state.onStart?.(request)
        if (state.startError !== undefined) throw state.startError
        // 允许测试把「startActivation 尚未返回」的窗口拉长，观察会话释放竞态。
        if (state.startGate !== undefined) await state.startGate
        const entry = { request, disposed: 0, settled: false }
        const result = new Promise((resolve, reject) => {
          entry.resolve = resolve
          entry.reject = reject
        })
        entry.activation = {
          childId: `child-${state.starts.length}`,
          result,
          dispose() {
            state.disposed += 1
            entry.disposed += 1
            // 被取消的 activation 不再参与 resolveNext 的选择。
            entry.settled = true
          },
        }
        state.pending.push(entry)
        return entry.activation
      },
    },
  }

  apply(ctx, config)

  const emit = (event, ...args) =>
    Promise.all((state.handlers[event] ?? []).map((handler) => handler(...args)))

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
    emit(
      'session/event',
      { id: sessionId, header: { origin: 'user' } },
      { type: 'workspace/changes', seq },
    )

  const userMessage = ({ sessionId = 's1', source = { kind: 'user' } } = {}) =>
    emit(
      'session/event',
      { id: sessionId, header: { origin: 'user' } },
      { type: 'user/message', data: { source, content: [] } },
    )

  /** 驱动一轮 turn-stopping。diff 变化时调用方需要显式传 `diff`。 */
  const stop = async (agent, {
    turn = 1, seq, diff, files, total, signal: turnSignal,
  } = {}) => {
    assert.notEqual(seq, undefined, 'stop 需要 seq')
    if (diff !== undefined) state.diffLine = diff
    addSummary({
      seq,
      turn,
      ...(files === undefined ? {} : { files }),
      ...(total === undefined ? {} : { total }),
    })
    await markChanges(seq)
    return emit('agent/turn-stopping', {
      agent,
      turn,
      signal: turnSignal ?? signal(),
    })
  }

  /** 结算最早的未结算 activation：多次发起时按顺序手动 resolve。 */
  const resolveNext = (value) => {
    const entry = state.pending.find((item) => item.settled !== true)
    assert.ok(entry, '没有在途 activation 可结算')
    entry.settled = true
    entry.resolve(value)
    return entry
  }

  /** 调用 ctx.effect 的 disposer，模拟插件卸载。 */
  const dispose = async () => {
    for (const { disposer } of state.effects) await disposer()
    await tick()
  }

  return {
    state, ctx, emit, addSummary, markChanges, userMessage, stop, resolveNext, dispose,
  }
}

function makeAgent(harness, sessionId = 's1') {
  const agent = {
    session: { id: sessionId, header: { origin: undefined } },
    followup(message) {
      harness.state.follows.push(message)
    },
    steer(message) {
      harness.state.steers.push(message.content[0].text)
    },
  }
  harness.state.agents.set(sessionId, agent)
  return agent
}

const followText = (state, index) => state.follows[index]?.content[0]?.text

function warnHas(state, text) {
  return state.warns.some((args) => String(args[0]).includes(text))
}

function debugHas(state, text) {
  return state.debug.some((args) => args.some((arg) => String(arg).includes(text)))
}

function metric(state) {
  return state.debug.find((args) => String(args[0]).startsWith('[code-review] reviewed'))
}

// —— 接口与异步发起 ——

test('inject 声明 agents 与 agentPresets', () => {
  assert.ok(inject.includes('agents'), `inject=${inject.join(',')}`)
  assert.ok(inject.includes('agentPresets'), `inject=${inject.join(',')}`)
})

test('turn-stopping 立即返回：不等待审查结果、不注入', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)
  const turnSignal = signal()

  await harness.stop(agent, { seq: 7, turn: 1, signal: turnSignal })

  assert.equal(harness.state.starts.length, 1)
  assert.equal(harness.state.pending.length, 1, '结果应仍在等待，证明没有阻塞')
  assert.equal(harness.state.follows.length, 0)
  assert.equal(harness.state.steers.length, 0)
  assert.equal(harness.state.starts[0].delivery, 'caller')
  // 后台审查必须挂在插件生命周期信号上，而不是 turn 信号。
  assert.notEqual(harness.state.starts[0].signal, turnSignal)
  assert.equal(harness.state.starts[0].signal.aborted, false)

  harness.resolveNext(completed())
  await tick()
})

test('结果回灌：followup 带 plugin 来源、结论与修复要求', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  harness.resolveNext(completed([FINDING]))
  await tick()

  assert.equal(harness.state.follows.length, 1)
  const message = harness.state.follows[0]
  assert.deepEqual(message.source, { kind: 'plugin', plugin: 'code-review' })
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string')
  assert.match(followText(harness.state, 0), /结论: 需修改/)
  assert.match(followText(harness.state, 0), /修完会再复审一次/)
  assert.doesNotMatch(followText(harness.state, 0), /不会再自动复审/)
  assert.equal(harness.state.steers.length, 0, 'v2 不再 steer')
  assert.ok(metric(harness.state), '成功结算应记录 reviewed 指标')
})

test('审查通过时静默：无 followup、无 steer', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  harness.resolveNext(completed([]))
  await tick()

  assert.equal(harness.state.follows.length, 0)
  assert.equal(harness.state.steers.length, 0)
  assert.ok(metric(harness.state), '通过也应记录 reviewed 指标')
})

test('链预算：maxRounds=2 只发起两次，第二次注入末轮文案，第三次 rounds-exhausted', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  harness.resolveNext(completed([FINDING]))
  await tick()

  await harness.stop(agent, { seq: 8, turn: 2, diff: '+const a = 2' })
  harness.resolveNext(completed([FINDING]))
  await tick()

  assert.equal(harness.state.starts.length, 2)
  assert.equal(harness.state.follows.length, 2)
  assert.match(followText(harness.state, 0), /修完会再复审一次/)
  assert.match(followText(harness.state, 1), /不会再自动复审/)
  assert.doesNotMatch(followText(harness.state, 1), /修完会再复审一次/)

  await harness.stop(agent, { seq: 9, turn: 3, diff: '+const a = 3' })

  assert.equal(harness.state.starts.length, 2, '链预算用尽后不应再发起')
  assert.equal(harness.state.follows.length, 2)
  assert.ok(debugHas(harness.state, 'rounds-exhausted'))
})

test('人类消息重置链：轮次与指纹一起清空，同 diff 可再发起', async () => {
  const harness = createHarness({ maxRounds: 1 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  harness.resolveNext(completed([FINDING]))
  await tick()
  assert.equal(harness.state.starts.length, 1)

  // 同一份 diff、新 seq：预算已尽，先被门禁拦下。
  await harness.stop(agent, { seq: 8, turn: 2, diff: '+const a = 1' })
  assert.equal(harness.state.starts.length, 1)
  assert.ok(debugHas(harness.state, 'rounds-exhausted'))

  await harness.userMessage({ source: { kind: 'user' } })

  // 同 diff 再次 stopping：轮次与指纹都重置了，应该重新发起。
  await harness.stop(agent, { seq: 9, turn: 3, diff: '+const a = 1' })
  assert.equal(harness.state.starts.length, 2)
  assert.equal(harness.state.follows.length, 1)

  harness.resolveNext(completed([]))
  await tick()
})

test('非人类来源消息不重置链，杜绝自激循环', async () => {
  const harness = createHarness({ maxRounds: 1 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  harness.resolveNext(completed([FINDING]))
  await tick()

  await harness.userMessage({ source: { kind: 'plugin', plugin: 'code-review' } })
  await harness.stop(agent, { seq: 8, turn: 2, diff: '+const a = 2' })

  assert.equal(harness.state.starts.length, 1, '插件消息不得重置链预算')
  assert.ok(debugHas(harness.state, 'rounds-exhausted'))
})

test('同 diff 指纹去重不占轮：diff 变化后仍能使用剩余预算', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  harness.resolveNext(completed([FINDING]))
  await tick()
  assert.equal(harness.state.starts.length, 1)

  // 同一份未变 diff 以新 seq 再次宣告：跳过且不占轮。
  await harness.stop(agent, { seq: 8, turn: 2, diff: '+const a = 1' })
  assert.equal(harness.state.starts.length, 1)
  assert.equal(harness.state.follows.length, 1)
  assert.ok(debugHas(harness.state, 'duplicate-diff'))

  // 若去重占了一轮，这里 round=2 会撞 maxRounds 而不再发起。
  await harness.stop(agent, { seq: 9, turn: 3, diff: '+const a = 2' })
  assert.equal(harness.state.starts.length, 2, '去重不得消耗轮次')

  harness.resolveNext(completed([]))
  await tick()
})

test('失败熔断：连续两次失败后第三次门禁 breaker-open', async () => {
  const harness = createHarness({ maxRounds: 5 })
  const agent = makeAgent(harness)

  for (const [index, seq] of [7, 8].entries()) {
    await harness.stop(agent, { seq, turn: index + 1, diff: `+const a = ${index + 1}` })
    harness.resolveNext({ stopReason: 'error', structured: undefined })
    await tick()
  }

  assert.equal(harness.state.starts.length, 2)
  assert.ok(warnHas(harness.state, '连续失败'), '第二次失败应告警熔断')
  assert.ok(debugHas(harness.state, 'review failed: incomplete'))

  await harness.stop(agent, { seq: 9, turn: 3, diff: '+const a = 9' })

  assert.equal(harness.state.starts.length, 2, '熔断后不应再发起')
  assert.ok(debugHas(harness.state, 'breaker-open'))
})

test('agent 已关闭：成功结果被丢弃，不 followup、不抛错', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  harness.state.agents.delete('s1')
  harness.resolveNext(completed([FINDING]))
  await tick()

  assert.equal(harness.state.follows.length, 0)
  assert.equal(harness.state.steers.length, 0)
  assert.ok(debugHas(harness.state, 'drop'))
  assert.equal(warnHas(harness.state, '连续失败'), false)
})

test('session/disposed 取消在途审查并释放锁与轮次', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  assert.equal(harness.state.pending.length, 1)
  assert.equal(harness.state.disposed, 0)

  await harness.emit('session/disposed', { id: 's1' })
  await tick()

  assert.equal(harness.state.disposed, 1, '在途 activation 必须 dispose')
  assert.equal(harness.state.follows.length, 0)
  assert.equal(debugHas(harness.state, 'review failed'), false, '会话关闭的取消不计失败')

  // 同 id 重建（tests 里的假会话）：锁与轮次应已清空，可以重新发起。
  await harness.stop(agent, { seq: 8, turn: 1, diff: '+const a = 2' })
  assert.equal(harness.state.starts.length, 2)

  harness.resolveNext(completed([]))
  await tick()
})

test('session/disposed 撞上 startActivation 等待：返回后立刻取消，不留下定时器', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)
  let release
  harness.state.startGate = new Promise((resolve) => {
    release = resolve
  })
  let markStarted
  const startCalled = new Promise((resolve) => {
    markStarted = resolve
  })
  harness.state.onStart = markStarted

  harness.addSummary({ seq: 7, turn: 1 })
  await harness.markChanges(7)
  const stopping = harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })
  await startCalled
  assert.equal(harness.state.starts.length, 1, 'startActivation 应已进入但未返回')
  assert.equal(harness.state.pending.length, 0)

  await harness.emit('session/disposed', { id: 's1' })
  release()
  await stopping
  await tick()

  assert.equal(harness.state.pending.length, 1)
  assert.equal(harness.state.disposed, 1, 'startActivation 返回后必须立刻 dispose')
  assert.equal(harness.state.follows.length, 0)

  // 同 id 重建：锁与轮次已清空，可以重新发起。
  harness.state.startGate = undefined
  await harness.stop(agent, { seq: 8, turn: 1, diff: '+const a = 2' })
  assert.equal(harness.state.starts.length, 2)

  harness.resolveNext(completed())
  await tick()
})

test('异步超时：asyncReviewerTimeoutMs 到点 dispose 且不注入，记一次失败', async () => {
  const harness = createHarness({ maxRounds: 2, asyncReviewerTimeoutMs: 20 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  await waitFor(() => harness.state.disposed === 1)
  await tick()

  assert.equal(harness.state.disposed, 1, '超时应 dispose activation')
  assert.equal(harness.state.follows.length, 0)
  assert.ok(debugHas(harness.state, 'review failed: timeout'))
  assert.equal(warnHas(harness.state, '连续失败'), false, '单次超时不应告警熔断')
})

test('末轮文案（maxRounds=1）不再承诺复审', async () => {
  const harness = createHarness({ maxRounds: 1 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  harness.resolveNext(completed([FINDING]))
  await tick()

  assert.equal(harness.state.follows.length, 1)
  assert.match(followText(harness.state, 0), /不会再自动复审/)
  assert.doesNotMatch(followText(harness.state, 0), /修完会再复审一次/)
})

test('成功结算的指标：rounds/files/findings/skipped/elapsed 与截断提示', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, {
    seq: 7,
    turn: 1,
    files: [
      { path: 'a.js', display: 'a.js' },
      { path: 'notes.md', display: 'notes.md' },
    ],
    total: 5,
    added: 2,
    deleted: 1,
  })
  harness.resolveNext(completed([{ ...FINDING, location: 'a.js:1' }]))
  await tick()

  const logged = metric(harness.state)
  assert.ok(logged, '应有 reviewed 指标')
  assert.equal(logged[1], 1, '指标应记录链轮次')
  assert.equal(logged[2], 5, '文件数应使用 summary.total')
  assert.equal(logged[3], 1, '指标应记录 findings 数')
  assert.equal(logged[4], 1, '指标应记录 skipped 数')
  assert.equal(typeof logged[5], 'number', '指标应记录 elapsed')
  assert.ok(harness.state.debug.some((args) => String(args[0]).includes('truncated') && args[1] === 5 && args[2] === 2))
  assert.match(followText(harness.state, 0), /本次 5 文件/)
  assert.match(followText(harness.state, 0), /未审: notes\.md（not-code）/)
})

test('失败不写指纹：同一份 diff 可以重试', async () => {
  const harness = createHarness({ maxRounds: 3 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  harness.resolveNext({ stopReason: 'error', structured: undefined })
  await tick()
  assert.equal(harness.state.starts.length, 1)

  await harness.stop(agent, { seq: 8, turn: 2, diff: '+const a = 1' })
  assert.equal(harness.state.starts.length, 2, '失败后同 diff 不应被去重')

  harness.resolveNext(completed([]))
  await tick()
  assert.equal(harness.state.follows.length, 0)
})

// —— 预检、取材与预检失败路径 ——

test('stale summary 与缺 files 都不消费轮次', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  harness.addSummary({ seq: 7, turn: 0 })
  await harness.markChanges(7)
  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  harness.state.summaries.set('s1:8', { turn: 1 })
  await harness.markChanges(8)
  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.starts.length, 0)
  assert.ok(debugHas(harness.state, 'stale-summary'))

  harness.addSummary({ seq: 9, turn: 1 })
  await harness.markChanges(9)
  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.starts.length, 1, 'stale 跳过后轮次仍可用')

  harness.resolveNext(completed())
  await tick()
})

test('summary 读取抛错时 fail-open，不冒泡且只警告一次', async () => {
  const harness = createHarness({ maxRounds: 2 })
  harness.addSummary({ seq: 7, turn: 1 })
  await harness.markChanges(7)
  harness.ctx.workspaceChanges.summary = () => {
    throw new Error('summary-boom')
  }
  const agent = makeAgent(harness)

  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })
  await harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })

  assert.equal(harness.state.starts.length, 0)
  assert.equal(harness.state.follows.length, 0)
  assert.equal(
    harness.state.warns.filter((args) => String(args[0]).includes('无法读取变更摘要')).length,
    1,
    '摘要读取失败只记一次警告',
  )
})

test('取材为空不启动子代理、不消耗轮次，之后正常 diff 仍能审', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, {
    seq: 7,
    turn: 1,
    files: [{ path: 'README.md', display: 'README.md' }],
  })

  assert.equal(harness.state.starts.length, 0)
  assert.equal(harness.state.follows.length, 0)
  assert.ok(debugHas(harness.state, 'empty-collect'))

  await harness.stop(agent, { seq: 8, turn: 2, diff: '+const a = 2' })
  assert.equal(harness.state.starts.length, 1, '空取材回滚后轮次仍可用')

  harness.resolveNext(completed())
  await tick()
})

test('全部 finding 被丢弃不算通过，也不注入通过结论', async () => {
  const harness = createHarness({ maxRounds: 3 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  harness.resolveNext(completed([
    { ...FINDING, ruleId: 'SEC-999' },
    { ...FINDING, location: '/etc/passwd:1' },
  ]))
  await tick()

  assert.equal(harness.state.follows.length, 0)
  assert.equal(harness.state.steers.length, 0)
  assert.ok(debugHas(harness.state, 'review failed: invalid-result'))
  assert.ok(warnHas(harness.state, '丢弃 2 条非法 finding'))
})

// —— followup 与启动失败 ——

test('followup 抛错只告警，不影响审查成功与熔断状态', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)
  agent.followup = () => {
    throw new Error('followup-boom')
  }

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  harness.resolveNext(completed([FINDING]))
  await tick()

  assert.ok(warnHas(harness.state, 'followup 失败'))
  assert.ok(metric(harness.state), 'followup 失败不改变成功结算')
  assert.equal(warnHas(harness.state, '连续失败'), false, 'followup 失败不算审查失败')

  await harness.stop(agent, { seq: 8, turn: 2, diff: '+const a = 2' })
  assert.equal(harness.state.starts.length, 2, '熔断未打开，下一轮仍可审查')

  harness.resolveNext(completed([]))
  await tick()
})

test('startReview 启动失败：记录失败、释放锁，下一次仍可发起', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)
  harness.state.startError = new Error('spawn-boom')

  await harness.stop(agent, { seq: 7, turn: 1 })
  assert.equal(harness.state.starts.length, 1)
  assert.equal(harness.state.follows.length, 0)
  assert.ok(debugHas(harness.state, 'start failed: spawn-boom'))
  assert.equal(harness.state.pending.length, 0, '启动失败不应产生在途 activation')

  harness.state.startError = undefined
  await harness.stop(agent, { seq: 8, turn: 2, diff: '+const a = 2' })
  assert.equal(harness.state.starts.length, 2, '启动失败后必须释放 reviewing 锁')

  harness.resolveNext(completed([]))
  await tick()
})

// —— 生命周期、命令与并发门禁 ——

test('命令注册冲突时警告并继续提供自动审查', async () => {
  const harness = createHarness({ maxRounds: 2 }, { registerThrows: true })
  assert.ok(warnHas(harness.state, '/review 命令注册失败'))
  assert.equal(harness.state.commands.length, 0)

  const agent = makeAgent(harness)
  await harness.stop(agent, { seq: 7, turn: 1 })
  assert.equal(harness.state.starts.length, 1)

  harness.resolveNext(completed())
  await tick()
})

test('session/disposed 清理指纹，同 id 会话同 diff 可再审', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  harness.resolveNext(completed([FINDING]))
  await tick()
  assert.equal(harness.state.starts.length, 1)

  await harness.emit('session/disposed', { id: 's1' })
  await tick()

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  assert.equal(harness.state.starts.length, 2, '会话释放后指纹应已清空')

  harness.resolveNext(completed([]))
  await tick()
})

test('插件 dispose 取消在途审查，结果被丢弃', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  assert.equal(harness.state.pending.length, 1)

  const effect = harness.state.effects.find((item) => String(item.label).includes('code-review'))
  assert.ok(effect, '应通过 ctx.effect 注册生命周期清理')
  await harness.dispose()

  assert.equal(harness.state.disposed, 1, '插件卸载应 dispose 在途 activation')
  assert.equal(harness.state.pending[0].disposed, 1)
  assert.equal(harness.state.follows.length, 0)
  assert.equal(debugHas(harness.state, 'review failed'), false, '插件卸载的取消不计失败')
})

test('reviewing 门禁：在途审查期间新的 stopping 不发起第二个', async () => {
  const harness = createHarness({ maxRounds: 3 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  assert.equal(harness.state.starts.length, 1)

  await harness.stop(agent, { seq: 8, turn: 2, diff: '+const a = 2' })
  assert.equal(harness.state.starts.length, 1, '在途期间不得并发发起')
  assert.ok(debugHas(harness.state, 'reviewing'))

  harness.resolveNext(completed([]))
  await tick()
  assert.equal(harness.state.follows.length, 0)

  await harness.stop(agent, { seq: 9, turn: 3, diff: '+const a = 3' })
  assert.equal(harness.state.starts.length, 2, '结算释放锁后应继续')

  harness.resolveNext(completed([]))
  await tick()
})

test('turn 信号取消不影响后台审查：结果仍会回灌', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)
  const controller = new AbortController()

  await harness.stop(agent, { seq: 7, turn: 1, signal: controller.signal })
  controller.abort()
  harness.resolveNext(completed([FINDING]))
  await tick()

  assert.equal(harness.state.follows.length, 1, 'turn 取消不应连带取消后台审查')
  assert.equal(harness.state.disposed, 0)
})
