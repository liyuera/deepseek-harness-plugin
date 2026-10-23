import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  installPresetPriming,
  presetOf,
  primeText,
  PRIME_SECTION_NAME,
  PRIME_SECTION_ORDER,
} from '../lib/prime.js'
import { SKILL_CONTENT } from '../lib/skill.js'

/** Fake root context capturing `agent/created` listeners. */
function listenerHarness(presets = ['liyu']) {
  const listeners = []
  const ctx = {
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {}
    },
  }
  const priming = installPresetPriming(ctx, { presets })
  return { listeners, priming }
}

/** Fake live agent with a scoped system-prompt face. */
function fakeAgent(preset) {
  const sections = []
  const agent = {
    session: { header: { agentPreset: preset } },
    ctx: {
      get: service => (service === 'systemPrompt'
        ? { section: section => { sections.push(section); return () => {} } }
        : undefined),
      effect: factory => {
        factory()
      },
    },
  }
  return { agent, sections }
}

test('prime text is exactly the wx-mp skill body behind a preloaded heading', () => {
  const text = primeText()
  assert.match(text, /^# 预载技能：wx-mp（微信小程序控制）/u)
  assert.match(text, /无需再调用 `skill\(name='wx-mp'\)`/u)
  assert.ok(text.includes(SKILL_CONTENT), 'the preloaded copy carries the exact skill body')
})

test('presetOf reads the durable session header defensively', () => {
  assert.equal(presetOf({ session: { header: { agentPreset: 'liyu' } } }), 'liyu')
  assert.equal(presetOf({ session: { header: {} } }), undefined)
  assert.equal(presetOf({}), undefined)
  assert.equal(presetOf(null), undefined)
})

test('a whitelisted preset gets the section exactly once', () => {
  const { listeners, priming } = listenerHarness()
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0].event, 'agent/created')
  const { agent, sections } = fakeAgent('liyu')
  listeners[0].handler({ agent })
  listeners[0].handler({ agent })
  assert.equal(sections.length, 1)
  const section = sections[0]
  assert.equal(section.name, PRIME_SECTION_NAME)
  assert.equal(section.order, PRIME_SECTION_ORDER)
  assert.equal(section.interpolate, false)
  assert.ok(section.text.includes(SKILL_CONTENT))
  assert.equal(priming.primed(agent), true)
  assert.equal(priming.presetOf(agent), 'liyu')
})

test('a non-whitelisted preset is never touched', () => {
  const { listeners, priming } = listenerHarness(['liyu'])
  const { agent, sections } = fakeAgent('standard')
  listeners[0].handler({ agent })
  assert.equal(sections.length, 0)
  assert.equal(priming.primed(agent), false)
})

test('an empty preset list installations no listener at all', () => {
  const { listeners } = listenerHarness([])
  assert.equal(listeners.length, 0)
})

test('an agent without a system-prompt service is skipped without throwing', () => {
  const { listeners, priming } = listenerHarness(['liyu'])
  const agent = { session: { header: { agentPreset: 'liyu' } }, ctx: { get: () => undefined, effect: () => {} } }
  assert.doesNotThrow(() => listeners[0].handler({ agent }))
  assert.equal(priming.primed(agent), false)
})
