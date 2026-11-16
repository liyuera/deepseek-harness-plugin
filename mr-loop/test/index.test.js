/** 装配层单测：用假 ctx 验证工具 / 命令 / 技能的接线，不触网、不写真实账本。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

function fakeCtx({ failFirstTool = false } = {}) {
  const skills = []
  const registered = { tools: [], commands: [], effects: [], listeners: [], injects: [] }
  const warnings = []
  let toolCalls = 0
  const scoped = {
    get: (serviceName) => (serviceName === 'skills'
      ? { register: (skill) => { skills.push(skill); return () => {} } }
      : undefined),
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

test('apply() 注册 5 个工具、/mr 命令，并通过 skills 服务注册技能', () => {
  const h = fakeCtx()
  apply(h.ctx, {})

  assert.deepEqual(h.tools.map((tool) => tool.name), ['mr_bind', 'mr_status', 'mr_review', 'mr_stop', 'mr_resume'])
  assert.equal(h.commands.length, 1)
  assert.equal(h.commands[0].name, 'mr')
  // 技能必须走 ctx.inject(['skills']) 拿 scoped ctx，而不是直接用根 ctx。
  assert.deepEqual(h.injects, [['skills']])
  assert.equal(h.skills.length, 1)
  assert.equal(h.skills[0].name, 'mr-loop')
})

test('enabled=false 仍注册工具、命令与技能（只是没有 watcher）', () => {
  const h = fakeCtx()
  apply(h.ctx, { enabled: false })
  assert.equal(h.tools.length, 5)
  assert.equal(h.commands.length, 1)
  assert.equal(h.skills.length, 1)
})

test('单个工具注册抛错不影响其余工具、命令与技能接线', () => {
  const h = fakeCtx({ failFirstTool: true })
  apply(h.ctx, {})

  // 5 次注册尝试，第一次失败；其余 4 个照常注册。
  assert.equal(h.tools.length, 4)
  assert.equal(h.commands.length, 1)
  assert.equal(h.skills.length, 1)
  assert.equal(h.warnings.filter((line) => /工具 mr_bind 注册失败/.test(line)).length, 1)
})
