/**
 * `/review` 手动入口：只把报告返回给 UI，不回注、不 steer。
 * @module @liyuera/dsh-code-review/host/command
 */
import { collect } from './collect.js'
import { formatJournal } from './journal.js'
import { renderFindings, renderPass } from './render.js'
import { buildFullPrompt, buildPrompt, runReview } from './reviewer.js'
import { composeRules } from './rules.js'

/**
 * 组装命令定义。
 * @param {object} deps
 * @returns {object} CommandDefinition
 */
export function createReviewCommand({
  config, workspaceChanges, subagents, getRules, logger, latestSeq, isReviewing,
  chain, tracker, journal,
}) {
  return {
    name: 'review',
    description: '通用代码审查：审查本轮改动并输出报告',
    input: { hint: '可留空；输入 --full 复审整条链的改动' },
    async handler({ agent, rawInput, signal }) {
      try {
        const sessionId = agent.session.id
        // 自动审查的留痕通过命令输出回看；没有记录时不改变原有输出。
        const withJournal = (text) => {
          const footer = journal === undefined ? '' : formatJournal(journal.recent(sessionId, 5))
          return footer === '' ? text : `${text}\n\n${footer}`
        }
        if (isReviewing?.(sessionId)) {
          return { kind: 'error', text: '已有审查在进行中，请稍后再试。' }
        }
        // 现有调用方可能不传 rawInput：统一转字符串，避免 undefined.trim()。
        const wantFull = String(rawInput ?? '').trim() === '--full'
        if (wantFull) {
          const epoch = tracker.epochOf(sessionId)
          const chainFiles = chain.filesOf(sessionId, epoch)
          if (chainFiles.length === 0) {
            return { kind: 'error', text: '本条链没有可审查的改动。' }
          }
          const loaded = await getRules()
          // 与自动全量同一口径：规则表与白名单按链内文件过滤。
          const composed = composeRules({ ...loaded, filePaths: chainFiles.map((file) => file.path) })
          const reviewed = await runReview({
            subagents,
            agent,
            preset: config.reviewerPreset,
            prompt: buildFullPrompt({ rulesPrompt: composed.prompt, files: chainFiles }),
            timeoutMs: config.reviewerTimeoutMs,
            modelOverride: config.modelOverride,
            signal,
            allowedRuleIds: composed.allowedRuleIds,
            allowedPaths: new Set(chainFiles.map((file) => file.path)),
            ruleSeverities: composed.ruleSeverities,
            logger,
          })
          if (!reviewed.ok) {
            logger.warn(`[code-review] /review --full failed: ${reviewed.reason}`)
            return { kind: 'error', text: withJournal(`全量审查未完成（${reviewed.reason}）。`) }
          }
          const scope = { files: chainFiles.length, added: 0, deleted: 0 }
          const text = renderFindings({
            findings: reviewed.findings,
            skipped: [],
            blockingSeverities: config.blockingSeverities,
            summary: scope,
            mode: 'report',
          })
          return {
            kind: 'success',
            text: withJournal(text === '' ? renderPass({ summary: scope, skipped: [] }) : text),
          }
        }
        const seq = latestSeq(sessionId)
        if (seq === undefined) return { kind: 'error', text: '本轮没有可审查的改动。' }

        const summary = workspaceChanges?.summary?.(sessionId, seq)
        if (summary === undefined) {
          return { kind: 'error', text: '本轮没有可审查的改动。' }
        }

        const collected = await collect({ workspaceChanges, sessionId, seq, config, signal })
        if (collected.files.length === 0) {
          return { kind: 'error', text: '本轮没有可审查的代码文件（可能是二进制或已超预算）。' }
        }

        const loaded = await getRules()
        // 与自动审查同一口径：规则表、白名单、severity 权威表按本次变更文件过滤。
        const composed = composeRules({ ...loaded, filePaths: collected.files.map((file) => file.path) })

        const scope = {
          files: summary.total ?? summary.files.length,
          added: summary.added,
          deleted: summary.deleted,
        }
        const reviewed = await runReview({
          subagents,
          agent,
          preset: config.reviewerPreset,
          prompt: buildPrompt({ rulesPrompt: composed.prompt, files: collected.files, skipped: collected.skipped }),
          timeoutMs: config.reviewerTimeoutMs,
          modelOverride: config.modelOverride,
          signal,
          allowedRuleIds: composed.allowedRuleIds,
          allowedPaths: new Set(collected.files.map((file) => file.path)),
          ruleSeverities: composed.ruleSeverities,
          logger,
        })

        if (!reviewed.ok) {
          logger.warn(`[code-review] /review failed: ${reviewed.reason}`)
          return { kind: 'error', text: withJournal(`审查未完成（${reviewed.reason}）。`) }
        }

        const text = renderFindings({
          findings: reviewed.findings,
          skipped: collected.skipped,
          blockingSeverities: config.blockingSeverities,
          summary: scope,
        })
        return {
          kind: 'success',
          text: withJournal(text === '' ? renderPass({ summary: scope, skipped: collected.skipped }) : text),
        }
      } catch (error) {
        logger?.warn?.(`[code-review] /review 失败：${error.message}`)
        return { kind: 'error', text: `审查失败：${error.message}` }
      }
    },
  }
}
