/** 装配层单测：用假 ctx 验证工具 / 命令 / 技能的接线，不触网、不写真实账本。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, releaseSession, rehydrateBindings } from '../index.js'

function fakeCtx({ failFirstTool = false } = {}) {
  const skills = []
  const registered = { tools: [], commands: [], effects: [], listeners: [], injects: [], webServerRoutes: [] }
  const warnings = []
  let toolCalls = 0
  const scoped = {
    get: (serviceName) => (serviceName === 'skills'
      ? { register: (skill) => { skills.push(skill); return () => {} } }
      : undefined),
    webServer: {
      register: (route) => { registered.webServerRoutes.push(route); return () => {} },
    },
    effect: (factory, label) => {
      const dispose = factory()
      registered.effects.push({ label, dispose })
    },
  }
  const ctx = {
    logger: { info: () => {}, warn: (line) => warnings.push(line) },
    tools: {
      register: (definition) => {
        toolCalls += 1
        if (failFirstTool && toolCalls === 1) throw new Error('duplicate tool')
        registered.tools.push(definition)
      },
    },
    commands: { register: (definition) => registered.commands.push(definition) },
    inject: (names, callback) => { registered.injects.push(names); callback(scoped) },
    effect: (factory, label) => {
      const dispose = factory()
      registered.effects.push({ label, dispose })
    },
    on: (event, handler) => registered.listeners.push({ event, handler }),
    get: () => undefined,
  }
  return { ctx, skills, warnings, ...registered }
}

test('apply() 注册 6 个工具、/mr 命令，并通过 skills 服务注册技能', () => {
  const h = fakeCtx()
  apply(h.ctx, {})

  assert.deepEqual(h.tools.map((tool) => tool.name), ['mr_bind', 'mr_status', 'mr_review', 'mr_waive', 'mr_stop', 'mr_resume'])
  assert.equal(h.commands.length, 1)
  assert.equal(h.commands[0].name, 'mr')
  // 只读 UI 路由（webServer）先注册，技能随后；两者都走 scoped ctx。
  assert.deepEqual(h.injects, [['webServer'], ['skills']])
  assert.equal(h.webServerRoutes.length, 1)
  assert.equal(h.webServerRoutes[0].path, '/mr-loop/ui/state')
  assert.equal(h.webServerRoutes[0].kind, 'exact')
  assert.equal(h.skills.length, 1)
  assert.equal(h.skills[0].name, 'mr-loop')
  // session/disposed 监听器必须存在：处理函数里会同时停 watcher + service.release。
  const disposed = h.listeners.find((item) => item.event === 'session/disposed')
  assert.ok(disposed !== undefined)
  assert.doesNotThrow(() => disposed.handler({ id: 'gone-session' }))
})

test('enabled=false 仍注册工具、命令与技能（只是没有 watcher）', () => {
  const h = fakeCtx()
  apply(h.ctx, { enabled: false })
  assert.equal(h.tools.length, 6)
  assert.equal(h.commands.length, 1)
  assert.equal(h.skills.length, 1)
})

test('没有 webServer 服务时只跳过 UI 路由，工具/命令/技能照常注册', () => {
  const h = fakeCtx()
  const originalInject = h.ctx.inject
  h.ctx.inject = (names, callback) => {
    if (names[0] !== 'webServer') return originalInject(names, callback)
    h.injects.push(names)
    // 模拟宿主没有 webServer：scoped ctx 缺少该服务，注册应当抛错并被兜住；
    // 其它 inject 走原始实现，证明失败只影响 UI 路由这一件事。
    callback({ get: () => undefined, effect: (factory) => { factory() } })
  }
  apply(h.ctx, {})

  assert.equal(h.tools.length, 6)
  assert.equal(h.commands.length, 1)
  assert.equal(h.skills.length, 1)
  assert.equal(h.warnings.filter((line) => /UI 路由注册失败/.test(line)).length, 1)
})

test('单个工具注册抛错不影响其余工具、命令与技能接线', () => {
  const h = fakeCtx({ failFirstTool: true })
  apply(h.ctx, {})

  // 6 次注册尝试，第一次失败；其余 5 个照常注册。
  assert.equal(h.tools.length, 5)
  assert.equal(h.commands.length, 1)
  assert.equal(h.skills.length, 1)
  assert.equal(h.warnings.filter((line) => /工具 mr_bind 注册失败/.test(line)).length, 1)
})

test('releaseSession：session/disposed 同时停 watcher 并释放 service 绑定', () => {
  const calls = []
  const result = releaseSession({
    watcher: { stop: (id) => calls.push(`stop:${id}`) },
    service: { release: ({ sessionId }) => calls.push(`release:${sessionId}`) },
  }, 'old')
  assert.deepEqual(calls, ['stop:old', 'release:old'])
  void result
})

test('releaseSession：watcher / service 任一抛错都不影响另一个（会话销毁不能把插件带崩）', () => {
  const calls = []
  assert.doesNotThrow(() => releaseSession({
    watcher: { stop: () => { throw new Error('watcher boom') } },
    service: { release: ({ sessionId }) => calls.push(sessionId) },
  }, 's'))
  assert.deepEqual(calls, ['s'])
  assert.doesNotThrow(() => releaseSession({
    watcher: { stop: () => {} },
    service: { release: () => { throw new Error('service boom') } },
  }, 's'))
  // service 没有 release（旧版本 / 假对象）也不能崩。
  assert.doesNotThrow(() => releaseSession({ watcher: { stop: () => {} }, service: {} }, 's'))
})

// ---------------------------------------------------------------------------
// 坑②：账本 → 内存的自动恢复（插件重载 / 应用重启后继续盯）
// ---------------------------------------------------------------------------

const RECORD = (iid, sessionId, over = {}) => ({
  version: 1,
  binding: { projectPath: 'g/p', iid, sessionId, repoRoot: '/r' },
  rounds: [{ sha: 'a'.repeat(40), n: 1, review: null }],
  decisions: {},
  mergeableAt: null,
  terminal: null,
  paused: null,
  ...over,
})

test('rehydrateBindings：只恢复会话还活着的绑定，并开始盯；老账本 / 终态跳过', async () => {
  const records = [
    RECORD(240, 's1'),
    RECORD(241, 's2'),                        // 会话没活：等它被打开时再恢复
    RECORD(242, 's3', { terminal: 'merged' }), // 终态：账本留着，不恢复
    RECORD(243, undefined),                   // 0.2.6 之前的老账本没有 sessionId
    RECORD(244, null),                        // 用户 stop 过的账本
  ]
  const calls = { restore: [], start: [] }
  const service = {
    getState: () => null,
    restore: ({ record }) => {
      calls.restore.push(record.binding.iid)
      return { sessionId: record.binding.sessionId }
    },
  }
  const result = await rehydrateBindings({
    ledger: { list: async () => records },
    service,
    watcher: { start: (id) => calls.start.push(id) },
    agentOf: (id) => id === 's1',
  })
  assert.deepEqual(result.indexed, ['s1', 's2'])
  assert.deepEqual(result.restored, ['s1'])
  assert.deepEqual(calls.restore, [240])
  assert.deepEqual(calls.start, ['s1'])
})

test('rehydrateBindings：onlySessionId 只处理指定会话；已有内存状态 / restore 拒绝 / 启动失败都不算恢复', async () => {
  const records = [RECORD(240, 's1'), RECORD(241, 's2')]
  const calls = { start: [] }
  const service = {
    getState: (id) => (id === 's2' ? { sessionId: 's2' } : null),
    restore: ({ record }) => (record.binding.iid === 240 ? { sessionId: 's1' } : null),
  }
  // 只处理 s1：s2 有内存状态（跳过），s1 正常恢复。
  const first = await rehydrateBindings({
    ledger: { list: async () => records },
    service,
    watcher: { start: (id) => calls.start.push(id) },
    agentOf: () => true,
    onlySessionId: 's1',
  })
  assert.deepEqual(first.restored, ['s1'])
  assert.deepEqual(calls.start, ['s1'])

  // watcher.start 抛错：this one 不能算恢复成功，也不能把整轮恢复打断。
  const broken = await rehydrateBindings({
    ledger: { list: async () => records },
    service: { getState: () => null, restore: () => ({ sessionId: 's1' }) },
    watcher: { start: () => { throw new Error('boom') } },
    agentOf: () => true,
    logger: { warn: () => {} },
  })
  assert.deepEqual(broken.restored, [])
})

test('rehydrateBindings：isActive=false（插件已卸载）不再恢复；账本读失败返回空', async () => {
  const service = { getState: () => null, restore: () => ({ sessionId: 's1' }) }
  const inactive = await rehydrateBindings({
    ledger: { list: async () => [RECORD(240, 's1')] },
    service,
    watcher: { start: () => { throw new Error('should not start') } },
    agentOf: () => true,
    isActive: () => false,
  })
  assert.deepEqual(inactive.restored, [])

  const failed = await rehydrateBindings({
    ledger: { list: async () => { throw new Error('io') } },
    service,
    watcher: { start: () => {} },
    agentOf: () => true,
  })
  assert.deepEqual(failed, { indexed: [], restored: [] })
})

test('apply() 注册 agent/created 监听：应用重启后会话被打开时补恢复', () => {
  const h = fakeCtx()
  apply(h.ctx, {})
  const created = h.listeners.find((item) => item.event === 'agent/created')
  assert.ok(created !== undefined)
  // 不认识的会话：什么也不做，也不许抛。
  assert.doesNotThrow(() => created.handler({ agent: { id: 'unknown-session' } }))
})
