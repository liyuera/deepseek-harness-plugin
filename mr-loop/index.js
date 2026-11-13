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

  for (const definition of createTools({ service })) ctx.tools.register(definition)

  try {
    ctx.commands.register(createCommand({ service }))
  } catch (error) {
    ctx.logger?.warn?.(`[mr-loop] /mr 命令注册失败（可能重名）：${error.message}`)
  }

  registerMrLoopSkill(ctx)
  ctx.effect(() => () => service.dispose(), 'mr-loop: dispose bindings')
  ctx.logger?.info?.(`[mr-loop] loaded baseUrl=${config.baseUrl}`)
}
