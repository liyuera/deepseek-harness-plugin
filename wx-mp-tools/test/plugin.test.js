import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply, inject, name } from '../lib/index.js'

/** Minimal Cordis context surface the plugin touches. */
function fakeContext() {
  const registered = []
  const effects = []
  const injected = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    on(event, handler) {
      effects.push({ label: `on:${event}` })
      return () => {}
    },
    inject(services, callback) {
      injected.push(services)
      callback({ get: () => undefined, effect: () => () => {} })
    },
    effect(factory, label) {
      effects.push({ label })
      factory()
    },
  }
  return { ctx, registered, effects, injected }
}

test('plugin identity and injection match the bundle contract', () => {
  assert.equal(name, 'wx-mp-tools')
  assert.deepEqual(inject, ['tools'])
})

test('apply registers twelve tools, the skill hook, and a cleanup effect', () => {
  const { ctx, registered, effects, injected } = fakeContext()
  apply(ctx, { clientName: 'dsh' })
  assert.equal(registered.length, 12)
  assert.deepEqual(registered.map(definition => definition.name).sort(), [
    'wx_mp_act', 'wx_mp_authorize', 'wx_mp_compile', 'wx_mp_eval', 'wx_mp_inspect', 'wx_mp_logs',
    'wx_mp_publish', 'wx_mp_raw', 'wx_mp_screenshot', 'wx_mp_status', 'wx_mp_task', 'wx_mp_window',
  ].sort())
  assert.ok(injected.some(services => services.includes('skills')))
  assert.ok(effects.some(entry => entry.label === 'wx-mp-tools: wechatide children'))
})

test('apply tolerates a missing skills service', () => {
  const { ctx } = fakeContext()
  ctx.inject = () => {}
  assert.doesNotThrow(() => apply(ctx, {}))
})
