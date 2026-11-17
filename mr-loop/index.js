/** Host 半边：装配 service、watcher 与工具/命令/技能。无 client 半边。 */
import { resolveConfig } from './src/host/config.js'
import { createLedger } from './src/host/ledger.js'
import { createFindingsStore } from './src/host/findings.js'
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
 * 会话销毁：先停该会话的 watcher，再释放 service 里的绑定（不写账本、不删账本）。
 * 必须释放绑定：否则已关闭的会话会永远留在 listStates()，挡住其它会话对同一 MR 的写
 * （bound-elsewhere 文案还让用户去已消失的会话 mr_stop，做不到，I-1）。
 * 两个操作各自兜错：会话销毁路径不能把插件带崩。
 */
export function releaseSession({ watcher, service }, sessionId) {
  try {
    watcher?.stop?.(sessionId)
  } catch {
    /* 定时器已经没了也不影响释放绑定 */
  }
  try {
    service?.release?.({ sessionId })
  } catch {
    /* 释放失败不能把插件带崩；下次重载会清空内存绑定 */
  }
}

/**
 * 账本 → 内存：插件重载 / 应用重启后，把「会话还活着」的绑定恢复出来并续盯。
 * 只看带 sessionId 的账本记录（0.2.6 起才写），终态 / 显式 stop 过的跳过；
 * 会话没有活 agent 时先不恢复（应用重启后还没被打开），等 agent/created 或用户发言再来。
 * 纯装配逻辑：ledger / service / watcher / agentOf 全部注入，可直接单测。
 *
 * @param {{ ledger: object, service: object, watcher: object, agentOf: (sessionId: string) => boolean,
 *           onlySessionId?: string, logger?: { warn?: Function } }} deps
 * @returns {Promise<{ indexed: string[], restored: string[] }>}
 */
export async function rehydrateBindings({ ledger, service, watcher, agentOf, onlySessionId = undefined, isActive = () => true, logger = undefined }) {
  let records
  try {
    records = await ledger.list()
  } catch {
    return { indexed: [], restored: [] }
  }
  const indexed = []
  const restored = []
  for (const record of records) {
    // 插件已经卸载（例如刚 apply 就被重载）：不要恢复出无人清理的定时器。
    if (isActive() === false) break
    const sessionId = record?.binding?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') continue
    if (typeof record.terminal === 'string' && record.terminal !== '') continue
    indexed.push(sessionId)
    if (onlySessionId !== undefined && sessionId !== onlySessionId) continue
    if (service.getState(sessionId) !== null) continue
    // 会话没活（应用重启后还没被打开）：先不恢复，等它被打开时再补。
    if (agentOf(sessionId) === false) continue
    const state = service.restore({ record })
    if (state === null) continue
    try {
      watcher.start(sessionId)
    } catch (error) {
      logger?.warn?.(`[mr-loop] 恢复 ${sessionId} 的监视失败：${error?.message ?? error}`)
      continue
    }
    restored.push(sessionId)
  }
  return { indexed, restored }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const ledger = createLedger({ dir: config.ledgerDir, keepRounds: config.ledgerKeepRounds })
  // T4：findings 只记录（不进判定、不写用户仓库）；写失败只 warn，不影响绑定与监视。
  const findings = createFindingsStore({
    dir: config.findingsDir,
    maxBytes: config.findingsMaxBytes,
    logger: ctx.logger,
  })
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
    findings,
    logger: ctx.logger,
    onBound: ({ sessionId }) => {
      // 新绑定也进索引：会话被重新打开时 agent/created 能据此触发恢复。
      boundSessions.add(sessionId)
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
  ctx.on('session/disposed', (session) => releaseSession({ watcher, service }, session.id))

  // 账本 → 内存的自动恢复：插件重载 / 应用重启后不用重新 /mr。
  const boundSessions = new Set()
  const agentOf = (sessionId) => {
    try {
      const agents = ctx.get?.('agents')
      if (agents === null || agents === undefined || typeof agents.get !== 'function') return false
      return agents.get(sessionId) !== undefined
    } catch {
      return false
    }
  }
  let disposed = false
  ctx.effect(() => () => { disposed = true }, 'mr-loop: rehydrate guard')
  const hasAgents = () => {
    try {
      const agents = ctx.get?.('agents')
      return agents !== null && agents !== undefined && typeof agents.get === 'function'
    } catch {
      return false
    }
  }
  const restoreFor = async (onlySessionId) => {
    if (disposed === true) return []
    const { indexed, restored } = await rehydrateBindings({
      ledger, service, watcher, agentOf, onlySessionId, isActive: () => disposed === false, logger: ctx.logger,
    })
    for (const id of indexed) boundSessions.add(id)
    return restored
  }
  // 没有 agents 服务（测试 / 精简宿主）时不做启动扫描：反正也判不出会话是否活着。
  const ready = hasAgents() ? restoreFor().catch(() => []) : Promise.resolve([])
  void ready.then((restored) => {
    if (Array.isArray(restored) && restored.length > 0) {
      ctx.logger?.info?.(`[mr-loop] 已恢复 ${restored.length} 个会话的 MR 监视`)
    }
  })

  // 会话被打开（agent 创建）：应用重启后账本里的绑定在这一刻恢复。
  ctx.on('agent/created', (payload) => {
    const sessionId = payload?.agent?.id ?? payload?.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    void ready.then(() => {
      if (boundSessions.has(sessionId) === false) return undefined
      return restoreFor(sessionId)
    }).catch(() => {})
  })

  // 用户发言续跑：会话里只要有人说话，就重新开始盯（暂停中的会话除外，等 /mr resume）。
  // 应用重启后会话第一次被使用时，绑定也在这里补恢复。
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') return
    const state = service.getState(session.id)
    if (state === null) {
      void ready.then(() => restoreFor(session.id)).catch(() => {})
      return
    }
    if (state.paused === null && watcher.isWatching(session.id) === false) {
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
