/** Host 半边：装配 service 与工具/命令/技能。无 client 半边。 */
import { resolveConfig } from './src/host/config.js'
import { createLedger } from './src/host/ledger.js'
import { createGitlabClient } from './src/host/gitlab.js'
import { readToken } from './src/host/token.js'
import { createService } from './src/host/service.js'
import { createTools } from './src/host/tools.js'
import { createCommand } from './src/host/command.js'
import { registerMrLoopSkill } from './src/host/skill.js'

export const name = 'mr-loop'
export const inject = ['tools', 'commands']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const ledger = createLedger({ dir: config.ledgerDir, keepRounds: config.ledgerKeepRounds })
  const gitlab = createGitlabClient({
    baseUrl: config.baseUrl,
    tokenProvider: async () => (await readToken({ tokenFile: config.tokenFile })).token,
    timeoutMs: config.requestTimeoutMs,
  })
  const service = createService({ config, ledger, gitlab })
  // 先挂释放钩子：后面任何一步注册失败，service 都不会留下绑定。
  ctx.effect(() => () => service.dispose(), 'mr-loop: dispose bindings')

  // 工具重名会让 register 抛错并中断 apply：逐个兜住，坏一个不影响其余接线。
  for (const definition of createTools({ service })) {
    try {
      ctx.tools.register(definition)
    } catch (error) {
      ctx.logger?.warn?.(`[mr-loop] 工具 ${definition?.name} 注册失败（可能重名）：${error.message}`)
    }
  }

  try {
    ctx.commands.register(createCommand({ service }))
  } catch (error) {
    ctx.logger?.warn?.(`[mr-loop] /mr 命令注册失败（可能重名）：${error.message}`)
  }

  registerMrLoopSkill(ctx)
  ctx.logger?.info?.(`[mr-loop] loaded baseUrl=${config.baseUrl}`)
}
