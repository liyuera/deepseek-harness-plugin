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
    storageDomain: undefined,
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
      if (service === 'agents') return { get: (sessionId) => state.agents.get(sessionId) }
      if (service === 'storageDomain') return state.storageDomain
      return undefined
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

  // 既有失败路径用例假定「一次失败即结算」；重试专项用例显式开启。
  apply(ctx, { retryInvalidReview: false, ...config })

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
    // 真实服务在 summary.files[] 上带每文件行数；补齐默认值，链级累积才有 +N/-N。
    const normalized = files.map((file) => ({
      ...file,
      ...(file.added === undefined ? { added } : {}),
      ...(file.deleted === undefined ? { deleted } : {}),
    }))
    state.summaries.set(`${sessionId}:${seq}`, { turn, files: normalized, total, added, deleted })
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

/**
 * 让 `/review` 内部的 activation 立即完成，再执行命令读取输出里的 journal 脚注。
 * 命令是自动审查留痕唯一的对外观察点（journal 只接给命令）。
 */
async function reviewFoot(harness, agent, findings = [FINDING]) {
  harness.state.onStart = () => {
    // startActivation 先调 onStart、后把 entry 放进 pending，所以查找要延后到微任务。
    queueMicrotask(() => {
      const entry = harness.state.pending.find((item) => item.settled !== true)
      if (entry === undefined) return
      entry.settled = true
      entry.resolve(completed(findings))
    })
  }
  const command = harness.state.commands[0]
  assert.ok(command, '命令应已注册')
  return command.handler({ agent, rawInput: '', signal: signal() })
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

test('turn-stopping 未等 activation.result 就返回：pending 仍在等待、不注入', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)
  const turnSignal = signal()

  await harness.stop(agent, { seq: 7, turn: 1, signal: turnSignal })

  assert.equal(harness.state.starts.length, 1)
  // activation.result 仍未结算，handler 却已返回：这就是异步发起。
  assert.equal(harness.state.pending.length, 1, '结果应仍在等待，证明没有阻塞')
  assert.equal(harness.state.follows.length, 0)
  assert.equal(harness.state.steers.length, 0)
  assert.equal(harness.state.starts[0].delivery, 'caller')
  // 后台审查必须独立于 turn 信号（挂在 startReview 自己的控制信号上）。
  assert.notEqual(harness.state.starts[0].signal, turnSignal)
  assert.equal(harness.state.starts[0].signal.aborted, false)

  harness.resolveNext(completed())
  await tick()
})

test('启动 deadline：startActivation 永不返回时 handler 在总预算内返回并记失败', async () => {
  const harness = createHarness({ maxRounds: 2, asyncReviewerTimeoutMs: 20 })
  const agent = makeAgent(harness)
  harness.state.startGate = new Promise(() => {})

  const startedAt = Date.now()
  await harness.stop(agent, { seq: 7, turn: 1 })
  const elapsed = Date.now() - startedAt

  assert.ok(elapsed < 100, `handler 应在启动预算内返回，实际 ${elapsed}ms`)
  assert.equal(harness.state.pending.length, 0, '未拿到 activation，不应有在途句柄')
  assert.equal(harness.state.follows.length, 0)
  assert.ok(debugHas(harness.state, 'start timeout'), '应记录启动超时')
  assert.ok(debugHas(harness.state, 'review failed'), '启动超时应计一次失败')

  // 超时释放了锁与轮次：下一次仍能发起（maxRounds=2，若未释放轮次也还有一次）。
  harness.state.startGate = undefined
  await harness.stop(agent, { seq: 8, turn: 2, diff: '+const a = 2' })
  assert.equal(harness.state.starts.length, 2, '启动超时后不得留下 reviewing 锁')

  harness.resolveNext(completed([]))
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
  assert.deepEqual(message.source, { kind: 'plugin:code-review' })
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

test('maxRounds=2：最后一轮自动切链级全量审查，prompt 含链内文件', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  // 第 1 轮：改 a.js（finding 必须落在 a.js，才会被记入已报问题）
  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1', files: [{ path: 'a.js', display: 'a.js' }] })
  harness.resolveNext(completed([{ ...FINDING, location: 'a.js:1' }]))
  await tick()

  // 第 2 轮：只改 b.js；链内已有 a.js（2 个文件 > 本轮 1 个），rounds=2 为最后一轮 → full
  await harness.stop(agent, { seq: 8, turn: 2, diff: '+const b = 2', files: [{ path: 'b.js', display: 'b.js' }] })

  const prompt = startedPrompt(harness, 1)
  try {
    assert.match(prompt, /链级全量复审/)
    assert.match(prompt, /a\.js（第 1 轮，\+1 \/ -0）/)
    assert.match(prompt, /b\.js（第 2 轮，\+1 \/ -0）/)
    // 第 1 轮的 finding 应作为「已报告过的问题」带入全量 prompt，避免重复报告。
    assert.match(prompt, /已报告过的问题/)
    assert.match(prompt, /- \[COR-001\] a\.js:1 /)
  } finally {
    harness.resolveNext(completed([]))
    await tick()
  }

  // 留痕 mode 也应按全量记录，供 /review 脚注回看。
  const foot = await reviewFoot(harness, agent, [])
  assert.equal(foot.kind, 'success')
  assert.match(foot.text, /· 全量 ·/)
})

test('敏感路径命中即强制链级全量，且不受 fullReview:false 降级', async () => {
  const harness = createHarness({ maxRounds: 3, fullReview: false, sensitiveGlobs: ['**/auth/**'] })
  const agent = makeAgent(harness)

  await harness.stop(agent, {
    seq: 7,
    turn: 1,
    diff: '+const token = 1',
    files: [{ path: 'src/auth/login.js', display: 'src/auth/login.js' }],
  })
  const prompt = startedPrompt(harness, 0)
  try {
    assert.match(prompt, /链级全量复审/)
    assert.match(prompt, /src\/auth\/login\.js/)
  } finally {
    harness.resolveNext(completed([]))
    await tick()
  }
})

test('非敏感路径首轮仍是单轮审查，不被敏感规则误触发', async () => {
  const harness = createHarness({ maxRounds: 3, sensitiveGlobs: ['**/auth/**'] })
  const agent = makeAgent(harness)

  await harness.stop(agent, {
    seq: 7,
    turn: 1,
    diff: '+const a = 1',
    files: [{ path: 'src/utils/a.js', display: 'src/utils/a.js' }],
  })
  const prompt = startedPrompt(harness, 0)
  try {
    assert.doesNotMatch(prompt, /链级全量复审/)
  } finally {
    harness.resolveNext(completed([]))
    await tick()
  }
})

test('fullReview=false：末轮不切全量，仍审本轮 diff', async () => {
  const harness = createHarness({ maxRounds: 2, fullReview: false })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1', files: [{ path: 'a.js', display: 'a.js' }] })
  harness.resolveNext(completed([]))
  await tick()

  await harness.stop(agent, { seq: 8, turn: 2, diff: '+const b = 2', files: [{ path: 'b.js', display: 'b.js' }] })

  const prompt = startedPrompt(harness, 1)
  try {
    assert.doesNotMatch(prompt, /链级全量复审/)
    assert.match(prompt, /@@ -1,1 \+1,1 @@/, '关闭全量后仍应带本轮 diff')
  } finally {
    harness.resolveNext(completed([]))
    await tick()
  }
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

test('在途审查跨人类重置：结算按当前链口径，旧链结果不写新链指纹', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  // 先把链推进到第二次审查（rounds=2，即旧口径下的末轮）。
  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  harness.resolveNext(completed([FINDING]))
  await tick()

  await harness.stop(agent, { seq: 8, turn: 2, diff: '+const a = 2' })
  assert.equal(harness.state.starts.length, 2)
  assert.equal(harness.state.pending.length, 2)

  // 审查在途时人类发消息：轮次归零、epoch +1、指纹清空。
  await harness.userMessage({ source: { kind: 'user' } })

  // 旧链结果在人类消息之后才结算：不得回灌到新链（复验会放大这段窗口）。
  harness.resolveNext(completed([FINDING]))
  await tick()
  assert.equal(harness.state.follows.length, 1, '旧链结果不得再回灌')
  assert.ok(debugHas(harness.state, '属于已重置的旧链'))

  // 旧链结果不得写指纹：同一份 diff 再 stopping 应能重新发起。
  await harness.stop(agent, { seq: 9, turn: 3, diff: '+const a = 2' })
  assert.equal(harness.state.starts.length, 3, '旧链结果不得污染新链去重')
  assert.equal(debugHas(harness.state, 'duplicate-diff'), false)

  harness.resolveNext(completed([]))
  await tick()
})

test('非人类来源消息不重置链，杜绝自激循环', async () => {
  const harness = createHarness({ maxRounds: 1 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  harness.resolveNext(completed([FINDING]))
  await tick()

  await harness.userMessage({ source: { kind: 'plugin:code-review' } })
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

test('agent 被替换：成功结果被丢弃，不 followup、不抛错', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })

  // 同 id 换了另一个 agent 对象：结果不得注入旧 agent，也不得抛错。
  const replacementFollows = []
  harness.state.agents.set('s1', {
    session: { id: 's1', header: { origin: undefined } },
    followup(message) {
      replacementFollows.push(message)
    },
  })
  harness.resolveNext(completed([FINDING]))
  await tick()

  assert.equal(harness.state.follows.length, 0, '不得 followup 旧 agent')
  assert.equal(replacementFollows.length, 0, '也不得 followup 新 agent')
  assert.ok(debugHas(harness.state, 'agent 已关闭或更换'))
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

test('启动中被 disposed：abort startReview、不记失败，handler 由 startup deadline 有界返回', async () => {
  const harness = createHarness({ maxRounds: 2, asyncReviewerTimeoutMs: 20 })
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
  const startedAt = Date.now()
  const stopping = harness.emit('agent/turn-stopping', { agent, turn: 1, signal: signal() })
  await startCalled
  assert.equal(harness.state.starts.length, 1, 'startActivation 应已进入但未返回')
  assert.equal(harness.state.pending.length, 0)

  await harness.emit('session/disposed', { id: 's1' })
  assert.equal(
    harness.state.starts[0].signal.aborted,
    true,
    'disposed 必须 abort 启动中的 startReview（透传到 startActivation 的 signal）',
  )

  // startActivation 仍挂起；handler 只能靠 startup deadline 收尾，不允许无限等待。
  const bounded = await Promise.race([
    stopping.then(() => 'returned'),
    delay(100).then(() => 'timeout'),
  ])
  assert.equal(bounded, 'returned', '启动中被 disposed 后 handler 仍须有界返回')
  assert.ok(Date.now() - startedAt < 100, `handler 应有界返回，实际 ${Date.now() - startedAt}ms`)
  assert.equal(debugHas(harness.state, 'review failed'), false, '会话关闭的取消不计失败')
  assert.equal(warnHas(harness.state, '连续失败'), false, '会话关闭不得累计熔断')
  assert.equal(harness.state.follows.length, 0)

  // 放行启动：startReview 拿到 activation 后应立即 dispose，不留活句柄。
  release()
  await tick()
  assert.equal(harness.state.disposed, 1, '取消后拿到的 activation 必须 dispose')
})

test('插件 dispose 叫停启动中的 startReview，结果丢弃且不计失败', async () => {
  const harness = createHarness({ maxRounds: 2, asyncReviewerTimeoutMs: 20 })
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
  assert.equal(harness.state.starts.length, 1)

  await harness.dispose()
  assert.equal(
    harness.state.starts[0].signal.aborted,
    true,
    '插件卸载必须 abort starting 里的控制信号',
  )

  release()
  await stopping
  await tick()

  assert.equal(harness.state.disposed, 1, '取消后拿到的 activation 必须 dispose')
  assert.equal(harness.state.follows.length, 0)
  assert.equal(debugHas(harness.state, 'review failed'), false, '插件卸载的取消不计失败')
  assert.equal(warnHas(harness.state, '连续失败'), false)
})

test('session/disposed 撞上 startActivation 等待：启动中被 disposed 会取消 startReview', async () => {
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
  assert.equal(harness.state.starts[0].signal.aborted, true, 'disposed 应取消启动中的 startReview')
  release()
  await stopping
  await tick()

  // 启动阶段本身由 startup deadline 兜底（见上一条用例）；这里验证的是
  // disposed 会立刻取消 startReview，并让返回后的 activation 被 dispose。
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

// —— 规则作用域过滤 ——

/** 自动发起时送给 reviewer 的 prompt 文本。 */
function startedPrompt(harness, index = 0) {
  return harness.state.starts[index]?.request?.prompt?.[0]?.text
}

test('按本次变更文件过滤规则：tsx 变更带组件规则、不带样式规则', async () => {
  const harness = createHarness({
    maxRounds: 2,
    rulePacks: ['rules/packs/frontend-smartui.json'],
  })
  const agent = makeAgent(harness)

  await harness.stop(agent, {
    seq: 7,
    turn: 1,
    files: [{ path: 'src/pages/A.tsx', display: 'src/pages/A.tsx' }],
  })

  assert.equal(harness.state.starts.length, 1)
  const prompt = startedPrompt(harness)
  assert.match(prompt, /\[CR-011\.01\]/, 'tsx 变更应带入 Hooks 规则（MNT-008）')
  assert.doesNotMatch(prompt, /\[CR-008\.0/, 'tsx 变更不应带样式规则（MNT-010）')

  harness.resolveNext(completed())
  await tick()
})

test('按本次变更文件过滤规则：less 变更带样式规则、不带组件规则', async () => {
  const harness = createHarness({
    maxRounds: 2,
    rulePacks: ['rules/packs/frontend-smartui.json'],
  })
  const agent = makeAgent(harness)

  await harness.stop(agent, {
    seq: 7,
    turn: 1,
    files: [{ path: 'src/styles/a.less', display: 'src/styles/a.less' }],
  })

  assert.equal(harness.state.starts.length, 1)
  const prompt = startedPrompt(harness)
  assert.match(prompt, /\[CR-008\.0/, 'less 变更应带入样式规则（MNT-010）')
  assert.doesNotMatch(prompt, /\[CR-011\.01\]/, 'less 变更不应带 Hooks 规则（MNT-008）')

  harness.resolveNext(completed())
  await tick()
})

test('无 scope 的基础规则不参与作用域过滤，始终进入 prompt', async () => {
  const harness = createHarness({
    maxRounds: 2,
    rulePacks: ['rules/packs/frontend-smartui.json'],
  })
  const agent = makeAgent(harness)

  await harness.stop(agent, {
    seq: 7,
    turn: 1,
    files: [{ path: 'src/pages/A.tsx', display: 'src/pages/A.tsx' }],
  })

  assert.match(startedPrompt(harness), /### COR-001/)

  harness.resolveNext(completed())
  await tick()
})

test('未启用规则包时前端规则不进入 prompt', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, {
    seq: 7,
    turn: 1,
    files: [{ path: 'src/pages/A.tsx', display: 'src/pages/A.tsx' }],
  })

  const prompt = startedPrompt(harness)
  assert.doesNotMatch(prompt, /\[CR-011\.01\]/, '默认 rulePacks=[] 不应加载前端规则包')
  assert.doesNotMatch(prompt, /\[CR-008\.0/)
  assert.doesNotMatch(prompt, /MNT-008/)
  assert.match(prompt, /### COR-001/, '基础规则仍在')

  harness.resolveNext(completed())
  await tick()
})

test('白名单按文件过滤：不适用规则的 finding 被丢弃，不算通过', async () => {
  const harness = createHarness({
    maxRounds: 2,
    rulePacks: ['rules/packs/frontend-smartui.json'],
  })
  const agent = makeAgent(harness)

  await harness.stop(agent, {
    seq: 7,
    turn: 1,
    files: [{ path: 'src/pages/A.tsx', display: 'src/pages/A.tsx' }],
  })
  // MNT-010（样式规则）不适用于 tsx：prompt 里没有它，白名单也必须拒绝它。
  harness.resolveNext(completed([{
    ruleId: 'MNT-010',
    dimension: 'maintainability',
    severity: 'medium',
    location: 'src/pages/A.tsx:1',
    problem: '顶层 :global 选择器',
    suggestion: '收进局部容器',
  }]))
  await tick()

  assert.equal(harness.state.follows.length, 0, '不适用规则的 finding 不得触发回灌')
  assert.equal(harness.state.steers.length, 0)
  assert.ok(warnHas(harness.state, '丢弃 1 条非法 finding'))
  assert.ok(debugHas(harness.state, 'review failed: invalid-result'))
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

test('启动失败不消耗链轮次：maxRounds=1 时下一次仍能发起', async () => {
  const harness = createHarness({ maxRounds: 1 })
  const agent = makeAgent(harness)
  harness.state.startError = new Error('spawn-boom')

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  assert.equal(harness.state.starts.length, 1)
  assert.ok(debugHas(harness.state, 'start failed: spawn-boom'))

  harness.state.startError = undefined
  await harness.stop(agent, { seq: 8, turn: 2, diff: '+const a = 2' })

  assert.equal(harness.state.starts.length, 2, '启动失败不得消耗链轮次')
  assert.equal(debugHas(harness.state, 'rounds-exhausted'), false)

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

// —— 非阻塞建议回灌（notifySeverities） ——

const LOW_FINDING = {
  ruleId: 'MNT-004',
  dimension: 'maintainability',
  severity: 'low',
  location: 'm.js:1',
  problem: '注释写两次、循环跑三次',
  suggestion: '把注释改成与实际循环一致',
}

test('notifySeverities 配置后：只有低严重度建议也回灌，且不要求修复', async () => {
  const harness = createHarness({ maxRounds: 2, notifySeverities: ['low'] })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  harness.resolveNext(completed([LOW_FINDING]))
  await tick()

  assert.equal(harness.state.follows.length, 1)
  assert.deepEqual(harness.state.follows[0].source, { kind: 'plugin:code-review' })
  const text = followText(harness.state, 0)
  assert.match(text, /结论: 通过（1 处建议）/)
  assert.match(text, /非阻塞建议:/)
  assert.match(text, /\[MNT-004\] 可维护性\/low {2}m\.js:1/)
  assert.match(text, /可选择不改/)
  assert.doesNotMatch(text, /结论: 需修改/)
})

test('notifySeverities 默认空：低严重度建议仍静默', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  harness.resolveNext(completed([LOW_FINDING]))
  await tick()

  assert.equal(harness.state.follows.length, 0)
  assert.equal(harness.state.steers.length, 0)
  assert.ok(metric(harness.state), '非阻塞不注入仍记 reviewed 指标')
})

test('notifySeverities 与阻塞项同轮：一条消息同时列出阻塞和建议', async () => {
  const harness = createHarness({ maxRounds: 2, notifySeverities: ['low'] })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  harness.resolveNext(completed([FINDING, LOW_FINDING]))
  await tick()

  assert.equal(harness.state.follows.length, 1)
  const text = followText(harness.state, 0)
  assert.match(text, /结论: 需修改（1 处阻塞，1 处建议）/)
  assert.match(text, /非阻塞建议:/)
  assert.match(text, /可选择性处理/)
  assert.doesNotMatch(text, /可选择不改/)
})

test('notifySeverities 末轮：非阻塞回灌也声明不再自动复审', async () => {
  const harness = createHarness({ maxRounds: 1, notifySeverities: ['low'] })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  harness.resolveNext(completed([LOW_FINDING]))
  await tick()

  assert.equal(harness.state.follows.length, 1)
  const text = followText(harness.state, 0)
  assert.match(text, /可选择不改/)
  assert.match(text, /不会再自动复审/)
  assert.doesNotMatch(text, /修完会再复审一次/)
})

// —— journal 留痕 ——

test('自动审查遇到 incomplete 时重试一次并成功回灌', async () => {
  const harness = createHarness({ maxRounds: 2, retryInvalidReview: true })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  harness.resolveNext({ stopReason: 'incomplete' })
  await waitFor(() => harness.state.starts.length === 2)
  harness.resolveNext(completed([FINDING]))
  await waitFor(() => harness.state.follows.length === 1)

  assert.match(followText(harness.state, 0), /结论: 需修改/)
  assert.ok(debugHas(harness.state, 'retry recovered'))
})

test('自动审查重试仍失败：只发起两次，记 failed 且不重复熔断', async () => {
  const harness = createHarness({ maxRounds: 2, retryInvalidReview: true })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  harness.resolveNext({ stopReason: 'incomplete' })
  await waitFor(() => harness.state.starts.length === 2)
  harness.resolveNext({ stopReason: 'incomplete' })
  await waitFor(() => debugHas(harness.state, 'review failed: incomplete'))

  assert.equal(harness.state.starts.length, 2)
  assert.equal(harness.state.follows.length, 0)
})

test('人类消息重置链后不重试旧链审查', async () => {
  const harness = createHarness({ maxRounds: 2, retryInvalidReview: true })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  harness.resolveNext({ stopReason: 'incomplete' })
  harness.userMessage()
  await waitFor(() => debugHas(harness.state, 'review failed: incomplete'))

  assert.equal(harness.state.starts.length, 1, '旧链结果不应触发重试')
  assert.equal(harness.state.follows.length, 0)
})

test('审查完成写留痕；/review 脚注显示自动审查记录', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  harness.resolveNext(completed([FINDING]))
  await tick()
  assert.equal(harness.state.follows.length, 1, '前置：自动审查已回灌')

  // 触发一次 /review：命令会跑一次同步审查并追加 journal 脚注
  const result = await reviewFoot(harness, agent)

  assert.equal(result.kind, 'success')
  assert.match(result.text, /自动审查记录/)
  assert.match(result.text, /完成 · 1 条建议/)
  assert.match(result.text, /已回灌/)
})

test('同一链两轮报同一问题：第二轮回灌标注「第 2 次报告」', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  harness.resolveNext(completed([FINDING]))
  await tick()
  assert.equal(harness.state.follows.length, 1, '前置：第一轮已回灌')

  // 换一行 diff，避免 duplicate-diff 跳过；同一 finding 命中历史指纹 → repeats=2。
  await harness.stop(agent, { seq: 8, turn: 2, diff: '+const b = 2' })
  harness.resolveNext(completed([FINDING]))
  await tick()

  assert.equal(harness.state.follows.length, 2)
  assert.match(followText(harness.state, 1), /（第 2 次报告，尚未修复）/)
})

test('审查通过（未回灌）也写留痕：completed + injected=false', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  harness.resolveNext(completed([]))
  await tick()
  assert.equal(harness.state.follows.length, 0, '前置：无阻塞项时静默')

  const result = await reviewFoot(harness, agent, [])

  assert.equal(result.kind, 'success')
  assert.match(result.text, /完成 · 0 条建议（未回灌）/)
})

test('审查失败写留痕：failed + 原因', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  harness.resolveNext({ stopReason: 'incomplete' })
  await tick()
  assert.equal(harness.state.follows.length, 0)

  const result = await reviewFoot(harness, agent)

  assert.equal(result.kind, 'success')
  assert.match(result.text, /失败（incomplete）/)
})

test('审查超时写留痕：timeout', async () => {
  const harness = createHarness({ maxRounds: 2, asyncReviewerTimeoutMs: 20 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  await waitFor(() => harness.state.disposed === 1)
  await tick()

  const result = await reviewFoot(harness, agent)

  assert.equal(result.kind, 'success')
  assert.match(result.text, /超时 · 未出结论/)
})

test('session/disposed 取消在途审查写留痕：cancelled + session-disposed', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  assert.equal(harness.state.pending.length, 1, '前置：已有在途审查')

  await harness.emit('session/disposed', { id: 's1' })
  await tick()

  // 会话释放清空了 latestSeq：重新宣告一次变更后 /review 才能读到留痕。
  harness.addSummary({ seq: 8, turn: 1 })
  await harness.markChanges(8)

  const result = await reviewFoot(harness, agent)

  assert.equal(result.kind, 'success')
  assert.match(result.text, /已取消（session-disposed）/)
})

test('插件卸载取消在途审查写留痕：cancelled + plugin-disposed', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1 })
  await harness.dispose()

  // 插件卸载后 tracker 仍持有旧锁（实例已随插件丢弃）；先释放会话再读留痕。
  await harness.emit('session/disposed', { id: 's1' })
  harness.addSummary({ seq: 7, turn: 1 })
  await harness.markChanges(7)

  const result = await reviewFoot(harness, agent)

  assert.equal(result.kind, 'success')
  assert.match(result.text, /已取消（plugin-disposed）/)
})

// —— v0.4：证据、复验、修复策略、抑制、覆盖 ——

const FINDING_EVIDENCE = {
  ...FINDING,
  evidence: { snippet: 'const a = 1' },
}

test('证据命中变更行 → 触发复验；确认后正常回灌', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  harness.resolveNext(completed([FINDING_EVIDENCE]))

  await waitFor(() => harness.state.starts.length === 2, { timeout: 1000 })
  assert.equal(harness.state.starts[1].request.agentPreset, 'code-review')
  assert.equal(harness.state.starts[1].label, 'code-review-verify')
  harness.resolveNext({ stopReason: 'completed', structured: { confirmed: true, reason: '确实会吞掉异常且路径可达' } })
  await waitFor(() => harness.state.follows.length === 1, { timeout: 1000 })

  assert.match(followText(harness.state, 0), /结论: 需修改/)
  assert.match(followText(harness.state, 0), /\[COR-001\]/)
})

test('复验驳回的 finding 被丢弃，不触发修复轮', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  harness.resolveNext(completed([FINDING_EVIDENCE]))
  await waitFor(() => harness.state.starts.length === 2, { timeout: 1000 })
  harness.resolveNext({ stopReason: 'completed', structured: { confirmed: false, reason: '外层已有 try/catch 保护不会触发' } })
  await tick()

  assert.equal(harness.state.follows.length, 0)
  assert.equal(harness.state.steers.length, 0)
})

test('生成代码命中 manual 策略：只要求人工确认，不写“请修复”', async () => {
  const harness = createHarness({ maxRounds: 2, verify: 'off' })
  const agent = makeAgent(harness)

  await harness.stop(agent, {
    seq: 7,
    turn: 1,
    diff: '+const a = 1',
    files: [{ path: 'src/generated/x.ts', display: 'src/generated/x.ts' }],
  })
  harness.resolveNext(completed([{ ...FINDING_EVIDENCE, location: 'src/generated/x.ts:1' }]))
  await waitFor(() => harness.state.follows.length === 1, { timeout: 1000 })

  const text = followText(harness.state, 0)
  assert.match(text, /结论: 需人工确认/)
  assert.match(text, /需人工确认（不要自动修改）:/)
  assert.match(text, /\[人工\] \[COR-001\]/)
  assert.doesNotMatch(text, /请按上面每条阻塞 finding 修复/)
  assert.doesNotMatch(text, /修完会再复审一次/)
})

test('配置抑制命中：finding 不回灌；/review 脚注显示抑制数', async () => {
  const harness = createHarness({
    maxRounds: 2,
    verify: 'off',
    suppressions: [{ ruleId: 'COR-001', reason: '产品决策' }],
  })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  harness.resolveNext(completed([FINDING_EVIDENCE]))
  await tick()
  assert.equal(harness.state.follows.length, 0)

  const result = await reviewFoot(harness, agent, [])
  assert.equal(result.kind, 'success')
  assert.match(result.text, /抑制 1/)
})

test('证据片段不符（warn）：降级为仅报告，但仍注入可见提示', async () => {
  const harness = createHarness({ maxRounds: 2, verify: 'off' })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  harness.resolveNext(completed([{ ...FINDING_EVIDENCE, evidence: { snippet: 'const fake = 1' } }]))
  await waitFor(() => harness.state.follows.length === 1, { timeout: 1000 })

  const text = followText(harness.state, 0)
  assert.match(text, /结论: 仅报告/)
  assert.match(text, /未复验\/证据不足/)
  assert.doesNotMatch(text, /请按上面每条阻塞 finding 修复/)
  assert.ok(warnHas(harness.state, '证据片段不符'))
})

test('证据片段不符（enforce）：视为 invalid-result，不伪装成通过', async () => {
  const harness = createHarness({ maxRounds: 2, evidenceMode: 'enforce', verify: 'off' })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  harness.resolveNext(completed([{ ...FINDING_EVIDENCE, evidence: { snippet: 'const fake = 1' } }]))
  await tick()

  assert.equal(harness.state.follows.length, 0)
  assert.ok(debugHas(harness.state, 'review failed: invalid-result'))
})

test('coverage 申报有效时写入留痕，/review 脚注展示覆盖', async () => {
  const harness = createHarness({ maxRounds: 2, verify: 'off' })
  const agent = makeAgent(harness)

  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  harness.resolveNext({
    stopReason: 'completed',
    structured: {
      findings: [FINDING_EVIDENCE],
      coverage: { files: [{ path: 'm.js', status: 'reviewed' }] },
    },
  })
  await waitFor(() => harness.state.follows.length === 1, { timeout: 1000 })

  const result = await reviewFoot(harness, agent, [])
  assert.equal(result.kind, 'success')
  assert.match(result.text, /覆盖 1\/1/)
})

test('旧链成功结算仍清零熔断计数，不因跨链丢弃而提前熔断', async () => {
  const harness = createHarness({ maxRounds: 5, verify: 'off' })
  const agent = makeAgent(harness)

  // 1) 先制造一次失败（计数 1）。
  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1' })
  harness.resolveNext({ stopReason: 'error' })
  await tick()

  // 2) 第二次审查在途时人类重置链，旧链随后成功结算（结果不回灌）。
  await harness.stop(agent, { seq: 8, turn: 2, diff: '+const a = 2' })
  await harness.userMessage({ source: { kind: 'user' } })
  harness.resolveNext(completed([]))
  await tick()

  // 3) 再失败一次：若旧链成功没清零，计数会到 2 并打开熔断。
  await harness.stop(agent, { seq: 9, turn: 3, diff: '+const a = 3' })
  harness.resolveNext({ stopReason: 'error' })
  await tick()
  assert.equal(warnHas(harness.state, '连续失败'), false, '旧链成功应清零失败计数')

  // 4) 熔断未打开，仍能发起下一次审查。
  await harness.stop(agent, { seq: 10, turn: 4, diff: '+const a = 4' })
  assert.equal(harness.state.starts.length, 4)
  harness.resolveNext(completed([]))
  await tick()
})
