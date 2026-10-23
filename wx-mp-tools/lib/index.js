/**
 * wx-mp-tools, host half. Registers twelve intent-shaped model tools that drive
 * 微信开发者工具 through its official agent CLI (`wechatide`), plus the `wx-mp`
 * agent skill. Every call spawns the CLI from the Host process — no server, no
 * extra dependency, no sandbox inside the IDE.
 *
 * The plugin degrades honestly: with the developer tools missing, unstarted, or
 * unauthorized, the tools still register and `wx_mp_status` names the missing
 * step instead of failing opaquely.
 * @module @liyuera/dsh-wx-mp-tools
 */

import { resolveConfig } from './config.js'
import { WechatideCli } from './cli.js'
import { ProjectResolver } from './project.js'
import { registerWxMpSkill } from './skill.js'
import { toolDefinitions } from './tools.js'

/** Plugin identity. */
export const name = 'wx-mp-tools'

/**
 * Services required by the host half. `tools` is the only hard dependency: the
 * skill registry and any other service are reached structurally so this bundle
 * works in every composition.
 */
export const inject = ['tools']

/**
 * Register the wx-mp-tools plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis context with the tool registry.
 * @param {Record<string, unknown>} [rawConfig] - the bundle patch row config.
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const cli = new WechatideCli(config)
  const resolver = new ProjectResolver(cli, config)
  for (const definition of toolDefinitions({ cli, resolver, config })) {
    ctx.tools.register(definition)
  }
  registerWxMpSkill(ctx)
  // Kill only the children this plugin owns; the IDE itself is the user's.
  ctx.effect(() => () => cli.dispose(), 'wx-mp-tools: wechatide children')
}
