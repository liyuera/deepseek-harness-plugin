/** `/mr <url> | status | resume | stop [--forget]`：命令入口与工具共用同一个 service / watcher。 */
const USAGE = '用法：/mr <MR 链接> | /mr status | /mr resume | /mr stop [--forget]'

export function createCommand({ service, watcher = undefined }) {
  return {
    name: 'mr',
    description: '绑定一个 GitLab MR 并跟踪它的评审门禁闭环',
    input: { hint: '<MR 链接> | status | resume | stop [--forget]' },
    async handler({ agent, rawInput }) {
      const input = String(rawInput ?? '').trim()
      const sessionId = agent?.session?.id
      try {
        if (input === '' || input === 'status') {
          const { report } = await service.status({ sessionId })
          return { kind: 'success', text: report }
        }
        if (input === 'resume') {
          service.resume({ sessionId })
          // 命令不产生 user/message 事件，必须显式把 watcher 拉起来，否则「已恢复」只是句空话。
          watcher?.start(sessionId)
          const { report } = await service.status({ sessionId })
          return { kind: 'success', text: report }
        }
        if (input === 'stop' || input === 'stop --forget') {
          const forget = input.endsWith('--forget')
          // 先停定时器再解绑：避免解绑后还有一 tick 在途。
          watcher?.stop(sessionId)
          const result = await service.stop({ sessionId, forget })
          if (!result.stopped) return { kind: 'success', text: '当前会话没有绑定 MR。' }
          return { kind: 'success', text: forget ? '已停止跟踪并删除账本。' : '已停止跟踪该 MR（账本保留）。' }
        }
        if (!/^https?:\/\//i.test(input)) return { kind: 'error', text: USAGE }
        const { report, warnings } = await service.bind({ sessionId, url: input, repoRoot: agent?.session?.header?.cwd })
        const warningText = (warnings ?? []).map((item) => `⚠️ ${item.message}`).join('\n')
        return { kind: 'success', text: warningText === '' ? report : `${report}\n\n${warningText}` }
      } catch (error) {
        return { kind: 'error', text: String(error?.message ?? error) }
      }
    },
  }
}
