/** Host 半边：装配 service、watcher 与工具/命令/技能。无 client 半边。 */
import { resolveConfig } from './src/host/config.js'
import { createLedger } from './src/host/ledger.js'
import { createGitlabClient } from './src/host/gitlab.js'
import { readToken } from './src/host/token.js'
import { createService } from './src/host/service.js'
import { createWatcher } from './src/host/watcher.js'
import { createTools } from './src/host/tools.js'
import { createCommand } from './src/host/command.js'
import { registerMrLoopSkill } from './src/host/skill.js'
import { createUiState, registerUiRoute } from './src/host/ui.js'

export const name = 'mr-loop'
export const inject = ['tools', 'commands']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const ledger = createLedger({ dir: config.ledgerDir, keepRounds: config.ledgerKeepRounds })
  // token 文件权限告警每个插件实例只记一次日志；告警文本只有路径，永远不含 token。
  let tokenWarningLogged = false
  const gitlab = createGitlabClient({
    baseUrl: config.baseUrl,
    tokenProvider: async () => {
      const { token, warning } = await readToken({ tokenFile: config.tokenFile })
      if (warning !== undefined && tokenWarningLogged === false) {
        tokenWarningLogged = true
        ctx.logger?.warn?.('[mr-loop] ' + warning)
      }
      return token
    },
    timeoutMs: config.requestTimeoutMs,
  })
  // 绑定成功时启动 watcher；service 先于 watcher 创建，所以用 ref 延后到实际调用时再取。
  let watcherRef = null
  const service = createService({
    config,
    ledger,
    gitlab,
    onBound: ({ sessionId }) => {
      try {
        watcherRef?.start(sessionId)
      } catch {
        /* watcher 启动失败不影响绑定结果 */
      }
    },
  })
  // 先挂释放钩子：后面任何一步注册失败，service 都不会留下绑定。
  ctx.effect(() => () => service.dispose(), 'mr-loop: dispose bindings')
  const watcher = config.enabled
    ? createWatcher({
        cfg: config,
        gitlab,
        service,
        logger: ctx.logger,
        // 唤醒 = 往会话里塞一条插件来源的消息；会话已关闭时 agent 取不到，必须静默。
        // 返回值是 watcher 的唯一送达凭据：只有 followup 真的没抛错才算送到。
        notify: ({ sessionId, text }) => {
          let agent
          try {
            // agents 服务是可选的：没注入/取不到时只丢唤醒，不能让 watcher 崩。
            agent = ctx.get?.('agents')?.get(sessionId)
          } catch {
            agent = undefined
          }
          if (agent === undefined || agent === null) return false
          try {
            agent.followup({
              id: crypto.randomUUID(),
              role: 'user',
              source: { kind: 'plugin:mr-loop' },
              content: [{ type: 'text', text }],
            })
          } catch (error) {
            // 日志只带错误信息，永远不包含 token 或报告正文。
            ctx.logger?.warn?.(`[mr-loop] followup 失败：${error.message}`)
            return false
          }
          return true
        },
      })
    // enabled=false：只留工具与命令（设计 §6.5），所有 watcher 入口都是空操作。
    : { tick: async () => {}, start() {}, stop() {}, stopAll() {}, isWatching: () => false }
  watcherRef = watcher
  ctx.on('session/disposed', (session) => watcher.stop(session.id))

  // 用户发言续跑：会话里只要有人说话，就重新开始盯（暂停中的会话除外，等 /mr resume）。
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') return
    const state = service.getState(session.id)
    if (state !== null && state.paused === null && watcher.isWatching(session.id) === false) {
      watcher.start(session.id)
    }
  })

  // 工具重名会让 register 抛错并中断 apply：逐个兜住，坏一个不影响其余接线。
  for (const definition of createTools({ service, watcher })) {
    try {
      ctx.tools.register(definition)
    } catch (error) {
      ctx.logger?.warn?.(`[mr-loop] 工具 ${definition?.name} 注册失败（可能重名）：${error.message}`)
    }
  }

  try {
    ctx.commands.register(createCommand({ service, watcher }))
  } catch (error) {
    ctx.logger?.warn?.(`[mr-loop] /mr 命令注册失败（可能重名）：${error.message}`)
  }

  // 插件卸载时停掉所有会话的定时器（不依赖 effect disposer 的相对顺序：
  // 即使 service 先被清空，tick 也会因 getState() 为 null 而自行收工）。
  ctx.effect(() => () => watcher.stopAll(), 'mr-loop: stop watchers')

  // UI 只读聚合：/mr-loop/ui/state。webServer 可选，没有就静默跳过（不影响工具与监视）。
  try {
    const ui = createUiState({ config, service, logger: ctx.logger })
    registerUiRoute({ ctx, ui, logger: ctx.logger })
  } catch (error) {
    ctx.logger?.warn?.(`[mr-loop] UI 路由注册失败：${error.message}`)
  }

  registerMrLoopSkill(ctx)
  ctx.logger?.info?.(`[mr-loop] loaded baseUrl=${config.baseUrl}`)
}
