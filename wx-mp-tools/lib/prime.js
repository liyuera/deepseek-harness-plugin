/**
 * Preset priming: preload the `wx-mp` skill body into sessions that run a
 * configured agent preset (default 李昱模式 = `liyu`).
 *
 * Why the plugin does this instead of the preset document: a preset's plugin
 * rows resolve from the harness installation, so a preset cannot name this
 * profile-installed package, and duplicating the skill body into the generated
 * preset would drift from `skill.js`. The plugin is mounted globally, watches
 * `agent/created`, and registers a scoped system-prompt section only for the
 * whitelisted preset ids — every other preset stays untouched, and the section
 * is disposed with the agent scope.
 * @module @liyuera/dsh-wx-mp-tools/prime
 */

import { SKILL_CONTENT } from './skill.js'

/** Section name inside the agent scope; unique per agent and disposed with it. */
export const PRIME_SECTION_NAME = 'wx-mp:primed-skill'

/**
 * Prompt position: after the tool-family guidance (TOOL_* runs 1000-3000 and
 * MCP 3100) and before the PTC SDK section at 5000.
 */
export const PRIME_SECTION_ORDER = 4000

/**
 * Heading that tells the model the body is already loaded. Without it the
 * model sees the same content twice (once preloaded, once through the `skill`
 * tool) and may spend a call reloading it.
 */
export const PRIME_HEADING = '# 预载技能：wx-mp（微信小程序控制）\n\n'
  + '以下是 `wx-mp` 技能的完整正文，已随当前预设默认载入，无需再调用 `skill(name=\'wx-mp\')`。'
  + '若与工具的实际返回冲突，以工具结果为准。'

/**
 * Full model-facing section text: heading plus the exact skill body, so the
 * preloaded copy and `skill(name='wx-mp')` can never disagree.
 * @returns {string} the section text.
 */
export function primeText() {
  return `${PRIME_HEADING}\n\n${SKILL_CONTENT}`
}

/**
 * The durable preset id of one agent's session, when recorded.
 * @param {unknown} agent - live agent handle.
 * @returns {string | undefined} the preset id.
 */
export function presetOf(agent) {
  const header = agent !== null && typeof agent === 'object' ? /** @type {Record<string, any>} */ (agent).session?.header : undefined
  const value = header?.agentPreset
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Install the preset priming listener and return the runtime view the status
 * tool reports.
 *
 * Priming covers newly created AND resumed sessions: both emit
 * `agent/created` with a `source`. In-process subagents created by the standard
 * spawn/fork providers inherit their parent's preset id in the durable header
 * and are primed too; teammates created by the experimental agent-team profile
 * run under their own preset (`cordis` on this deployment) and are therefore
 * not primed — that is intentional, not a whitelist miss.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's root context.
 * @param {{ presets: readonly string[] }} options - configured preset ids.
 * @returns {{
 *   presets: readonly string[],
 *   primed(agent: unknown): boolean,
 *   presetOf(agent: unknown): string | undefined,
 *   sectionOrder: number,
 * }} the runtime view used by `wx_mp_status`.
 */
export function installPresetPriming(ctx, options) {
  const presets = options.presets
  /** @type {WeakSet<object>} agents already carrying the section. */
  const primedAgents = new WeakSet()

  /**
   * Prime one live agent when its durable preset is whitelisted. Safe to call
   * more than once per agent: the WeakSet makes the second call a no-op.
   * @param {unknown} agent - live agent handle.
   */
  const primeAgent = agent => {
    if (agent === null || typeof agent !== 'object' || primedAgents.has(agent)) return
    const preset = presetOf(agent)
    if (preset === undefined || !presets.includes(preset)) return
    const prompt = /** @type {Record<string, any>} */ (agent).ctx?.get?.('systemPrompt')
    if (prompt === undefined || prompt === null) return
    primedAgents.add(agent);
    /** @type {Record<string, any>} */ (agent).ctx.effect(() => prompt.section({
      name: PRIME_SECTION_NAME,
      order: PRIME_SECTION_ORDER,
      text: primeText(),
      // The body is literal prose: never run strict `{{variable}}`
      // interpolation over it.
      interpolate: false,
    }), 'wx-mp-tools: preset prime')
  }

  if (presets.length > 0) {
    ctx.on('agent/created', payload => {
      const agent = payload !== null && typeof payload === 'object' ? /** @type {Record<string, any>} */ (payload).agent : undefined
      primeAgent(agent)
    })
    // A plugin reload/enable inside a running app: existing sessions created
    // before this listener registered are primed immediately rather than only
    // after the next new/resumed session. Absent `agents` service: no-op.
    const agents = ctx.get?.('agents')
    if (typeof agents?.list === 'function') {
      for (const agent of agents.list()) {
        try {
          primeAgent(agent)
        } catch {
          // A disposed agent racing this pass must not fail plugin activation.
        }
      }
    }
  }
  return {
    presets,
    primed: agent => (agent !== null && typeof agent === 'object' ? primedAgents.has(agent) : false),
    presetOf,
    sectionOrder: PRIME_SECTION_ORDER,
  }
}
