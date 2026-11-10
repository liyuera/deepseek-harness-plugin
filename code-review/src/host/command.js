/**
 * `/review` 手动入口：只把报告返回给 UI，不回注、不 steer。
 * @module @liyuera/dsh-code-review/host/command
 */
import { collect } from './collect.js'
import { renderFindings, renderPass } from './render.js'
import { buildPrompt, runReview } from './reviewer.js'

/**
 * 组装命令定义。
 * @param {object} deps
 * @returns {object} CommandDefinition
 */
export function createReviewCommand({ config, workspaceChanges, subagents, getRules, logger, latestSeq, isReviewing }) {
  return {
    name: 'review',
    description: '通用代码审查：审查本轮改动并输出报告',
    async handler({ agent, signal }) {
      const sessionId = agent.session.id
      if (isReviewing?.(sessionId)) {
        return { kind: 'error', text: '已有审查在进行中，请稍后再试。' }
      }
      const seq = latestSeq(sessionId)
      if (seq === undefined) return { kind: 'error', text: '本轮没有可审查的改动。' }

      const summary = workspaceChanges?.summary?.(sessionId, seq)
      if (summary === undefined) {
        return { kind: 'error', text: '本轮没有可审查的改动。' }
      }

      const rules = await getRules()
      const collected = await collect({ workspaceChanges, sessionId, seq, config, signal })
      if (collected.files.length === 0) {
        return { kind: 'error', text: '本轮没有可审查的代码文件（可能是二进制或已超预算）。' }
      }

      const scope = {
        files: summary.total ?? summary.files.length,
        added: summary.added,
        deleted: summary.deleted,
      }
      const reviewed = await runReview({
        subagents,
        agent,
        preset: config.reviewerPreset,
        prompt: buildPrompt({ rulesPrompt: rules.prompt, files: collected.files, skipped: collected.skipped }),
        timeoutMs: config.reviewerTimeoutMs,
        modelOverride: config.modelOverride,
        signal,
        allowedRuleIds: rules.allowedRuleIds,
        allowedPaths: new Set(collected.files.map((file) => file.path)),
        logger,
      })

      if (!reviewed.ok) {
        logger.warn(`[code-review] /review failed: ${reviewed.reason}`)
        return { kind: 'error', text: `审查未完成（${reviewed.reason}）。` }
      }

      const text = renderFindings({
        findings: reviewed.findings,
        skipped: collected.skipped,
        blockingSeverities: config.blockingSeverities,
        summary: scope,
      })
      return { kind: 'success', text: text === '' ? renderPass({ summary: scope }) : text }
    },
  }
}
