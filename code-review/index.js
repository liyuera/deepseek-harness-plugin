/**
 * Host half of `@liyuera/dsh-code-review`.
 * @module @liyuera/dsh-code-review
 */
import { resolveConfig } from './src/host/config.js'

export const name = 'code-review'
export const inject = ['commands']

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] 用户配置
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  ctx.logger.info(`[code-review] loaded preset=${resolved.reviewerPreset} maxRounds=${resolved.maxRounds}`)
}
