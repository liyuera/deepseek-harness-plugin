/**
 * Host half of `@liyuera/dsh-code-review`.
 * @module @liyuera/dsh-code-review
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from './src/host/config.js'
import { collect } from './src/host/collect.js'
import { loadRules, renderRulesPrompt } from './src/host/rules.js'
import { renderFindings, renderPass } from './src/host/render.js'
import { buildPrompt, runReview } from './src/host/reviewer.js'
import { shouldReview } from './src/host/trigger.js'
import { createTracker } from './src/host/loop.js'
import { createReviewCommand } from './src/host/command.js'
import { createReviewerGuard } from './src/host/guard.js'

export const name = 'code-review'
export const inject = ['commands', 'subagents', 'workspaceChanges', 'tools']

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
const PRINCIPLE_IDS = [
  'PRINCIPLE-correctness',
  'PRINCIPLE-security',
  'PRINCIPLE-performance',
  'PRINCIPLE-maintainability',
]

/** 构造一条可被 steer 注入的用户消息。source 必填，漏了渲染时会崩。 */
function message(text) {
  return { id: crypto.randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

/** 加载规范；失败时降级为只用原则层，不阻塞会话。 */
async function loadRulesOrFallback(logger, config) {
  const rulesPath = join(PACKAGE_ROOT, config.rulesFile)
  const principlesPath = join(PACKAGE_ROOT, config.principlesFile)
  try {
    const loaded = await loadRules({ rulesPath, principlesPath })
    return {
      prompt: renderRulesPrompt(loaded),
      allowedRuleIds: new Set([...loaded.rules.map((rule) => rule.id), ...PRINCIPLE_IDS]),
    }
  } catch (error) {
    logger.warn(`[code-review] 规则文件不可用，降级为只用原则层：${error.message}`)
    return { prompt: await readFile(principlesPath, 'utf8'), allowedRuleIds: new Set(PRINCIPLE_IDS) }
  }
}

/**
 * 挂载插件。规范按需加载并记忆，避免在 apply 里做异步初始化。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  ctx.tools.guard(createReviewerGuard(resolved.reviewerPreset))
  const tracker = createTracker()
  const latestSeq = new Map()
  const previousBlocking = new Map()
  let rulesPromise

  const getRules = () => {
    rulesPromise ??= loadRulesOrFallback(ctx.logger, resolved).catch((error) => {
      rulesPromise = undefined
      throw error
    })
    return rulesPromise
  }

  ctx.commands.register(createReviewCommand({
    config: resolved,
    workspaceChanges: ctx.workspaceChanges,
    subagents: ctx.subagents,
    getRules,
    logger: ctx.logger,
    latestSeq: (sessionId) => latestSeq.get(sessionId),
  }))

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'workspace/changes') latestSeq.set(session.id, event.seq)
  })

  ctx.on('session/disposed', (session) => {
    latestSeq.delete(session.id)
    previousBlocking.delete(session.id)
    tracker.forget(session.id)
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const sessionId = agent.session.id
    const seq = latestSeq.get(sessionId)
    const decision = shouldReview({
      config: resolved,
      origin: agent.session.header?.origin,
      reviewing: tracker.isReviewing(sessionId),
      rounds: tracker.roundsOf(sessionId, turn),
      hasChanges: seq !== undefined,
      breakerOpen: tracker.isBreakerOpen(sessionId),
    })
    if (!decision.review) {
      ctx.logger.debug?.(`[code-review] skip: ${decision.reason}`)
      return
    }

    // 先确认摘要属于本 turn 且确有改动，避免消费轮次后才发现无可审内容。
    const summary = ctx.workspaceChanges.summary(sessionId, seq)
    if (summary === undefined || summary.turn !== turn || summary.files.length === 0) {
      ctx.logger.debug?.(`[code-review] skip: stale-summary turn=${turn}`)
      return
    }
    if (!tracker.begin(sessionId, turn)) return

    try {
      const rules = await getRules()
      const collected = await collect({
        workspaceChanges: ctx.workspaceChanges,
        sessionId,
        seq,
        config: resolved,
        signal,
      })
      if (collected.files.length === 0) return

      const reviewed = await runReview({
        subagents: ctx.subagents,
        agent,
        preset: resolved.reviewerPreset,
        prompt: buildPrompt({ rulesPrompt: rules.prompt, files: collected.files, skipped: collected.skipped }),
        timeoutMs: resolved.reviewerTimeoutMs,
        modelOverride: resolved.modelOverride,
        signal,
        allowedRuleIds: rules.allowedRuleIds,
        allowedPaths: new Set(collected.files.map((file) => file.path)),
      })

      if (!reviewed.ok) {
        if (signal?.aborted) return
        if (tracker.recordFailure(sessionId)) {
          ctx.logger.warn('[code-review] 连续失败，已暂停本会话的自动审查')
        }
        return
      }
      tracker.recordSuccess(sessionId)

      const scope = { files: summary.files.length, added: summary.added, deleted: summary.deleted }
      const text = renderFindings({
        findings: reviewed.findings,
        skipped: collected.skipped,
        blockingSeverities: resolved.blockingSeverities,
        summary: scope,
        mode: 'steer',
      })
      const previous = previousBlocking.get(sessionId)
      const hadBlocking = previous?.turn === turn && previous.blocking === true
      previousBlocking.set(sessionId, { turn, blocking: text !== '' })

      if (text !== '') {
        agent.steer(message(`${text}\n\n请按上面每条 finding 修复；修完会再复审一次。如与用户新指令冲突，以用户指令为准。`))
      } else if (hadBlocking) {
        agent.steer(message(`${renderPass({ summary: scope })}\n\n可以收尾了。`))
      }
    } catch (error) {
      if (signal?.aborted) return
      ctx.logger.warn(`[code-review] review failed: ${error.message}`)
      tracker.recordFailure(sessionId)
    } finally {
      tracker.end(sessionId)
    }
  })

  ctx.logger.info(`[code-review] loaded preset=${resolved.reviewerPreset} maxRounds=${resolved.maxRounds}`)
}
