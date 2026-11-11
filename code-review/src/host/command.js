/**
 * `/review` 手动入口：只把报告返回给 UI，不回注、不 steer。
 * @module @liyuera/dsh-code-review/host/command
 */
import { collect } from './collect.js'
import { finalizeFindings } from './finalize.js'
import { formatJournal } from './journal.js'
import { annotateRepeats, LEDGER_WINDOW, notObservedFindings } from './ledger.js'
import { readWorkspaceTexts } from './readfile.js'
import { renderFindings, renderLedger, renderPass } from './render.js'
import { buildFullPrompt, buildPrompt, runReview } from './reviewer.js'
import { composeRules } from './rules.js'
import { loadSuppressions } from './suppress.js'

/** 把复验统计拼成一行，供报告脚注展示。 */
function verificationLine(verification) {
  if (verification === undefined || verification.checked === 0) return ''
  const parts = [`复验 ${verification.checked} 条`]
  if (verification.confirmed > 0) parts.push(`确认 ${verification.confirmed}`)
  if (verification.rejected > 0) parts.push(`驳回 ${verification.rejected}`)
  if (verification.unverified > 0) parts.push(`未证实 ${verification.unverified}`)
  return `复验: ${parts.join('，')}`
}

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
        const cwd = agent.session?.header?.cwd
        // 自动审查的留痕通过命令输出回看；没有记录时不改变原有输出。
        // 一次读取账本窗口：脚注固定展示最近 5 条，重复/未再见统计用完整窗口。
        const journalRecords = journal?.recent?.(sessionId, LEDGER_WINDOW) ?? []
        const withJournal = (text) => {
          const footer = formatJournal(journalRecords.slice(0, 5))
          return footer === '' ? text : `${text}\n\n${footer}`
        }
        // 跨轮账本：本轮 findings 标历史重复次数；历史遗留问题连续缺席 2 轮才提示人工确认。
        const withLedger = (findings, suppressed, currentPaths) => {
          const annotated = annotateRepeats(findings, journalRecords)
          const tracked = new Set(
            [...annotated, ...suppressed.map((entry) => entry.finding ?? entry)]
              .map((finding) => finding?.fingerprint)
              .filter((fingerprint) => typeof fingerprint === 'string'),
          )
          return {
            findings: annotated,
            ledger: renderLedger(notObservedFindings(journalRecords, tracked, currentPaths)),
          }
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
          const suppressions = await loadSuppressions({ config, cwd, warn: logger?.warn })
          const texts = await readWorkspaceTexts({ cwd, paths: chainFiles.map((file) => file.path) })
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
            evidenceContext: {
              mode: 'full',
              files: chainFiles.map((file) => ({ path: file.path, text: texts.get(file.path) })),
            },
            evidenceMode: config.evidenceMode,
            coverageMode: config.coverageMode,
          })
          if (!reviewed.ok) {
            logger.warn(`[code-review] /review --full failed: ${reviewed.reason}`)
            return { kind: 'error', text: withJournal(`全量审查未完成（${reviewed.reason}）。`) }
          }
          const final = await finalizeFindings({
            findings: reviewed.findings,
            evidence: reviewed.evidence,
            ruleFixModes: composed.ruleFixModes,
            ruleBlocking: composed.ruleBlocking,
            config,
            suppressions,
            files: chainFiles,
            subagents,
            agent,
            preset: config.reviewerPreset,
            signal,
            logger,
            modelOverride: config.modelOverride,
          })
          const scope = { files: chainFiles.length, added: 0, deleted: 0 }
          const ledger = withLedger(
            final.findings,
            final.suppressed,
            chainFiles.map((file) => file.path),
          )
          const rendered = renderFindings({
            findings: ledger.findings,
            skipped: [],
            blockingSeverities: config.blockingSeverities,
            notifySeverities: config.notifySeverities ?? [],
            summary: scope,
            mode: 'report',
            coverage: reviewed.coverage,
            suppressed: final.suppressed,
            respectFixPolicy: config.respectFixPolicy,
          })
          const verification = verificationLine(final.verification)
          const body = rendered === ''
            ? renderPass({ summary: scope, skipped: [], coverage: reviewed.coverage })
            : rendered
          return {
            kind: 'success',
            text: withJournal([body, verification, ledger.ledger].filter((line) => line !== '').join('\n')),
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
        const suppressions = await loadSuppressions({ config, cwd, warn: logger?.warn })

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
          evidenceContext: { mode: 'turn', files: collected.files },
          evidenceMode: config.evidenceMode,
          coverageMode: config.coverageMode,
        })

        if (!reviewed.ok) {
          logger.warn(`[code-review] /review failed: ${reviewed.reason}`)
          return { kind: 'error', text: withJournal(`审查未完成（${reviewed.reason}）。`) }
        }

        const final = await finalizeFindings({
          findings: reviewed.findings,
          evidence: reviewed.evidence,
          ruleFixModes: composed.ruleFixModes,
          ruleBlocking: composed.ruleBlocking,
          config,
          suppressions,
          files: collected.files,
          subagents,
          agent,
          preset: config.reviewerPreset,
          signal,
          logger,
          modelOverride: config.modelOverride,
        })
        const ledger = withLedger(
          final.findings,
          final.suppressed,
          collected.files.map((file) => file.path),
        )
        const rendered = renderFindings({
          findings: ledger.findings,
          skipped: collected.skipped,
          blockingSeverities: config.blockingSeverities,
          notifySeverities: config.notifySeverities ?? [],
          summary: scope,
          mode: 'report',
          coverage: reviewed.coverage,
          suppressed: final.suppressed,
          respectFixPolicy: config.respectFixPolicy,
        })
        const verification = verificationLine(final.verification)
        const body = rendered === ''
          ? renderPass({ summary: scope, skipped: collected.skipped, coverage: reviewed.coverage })
          : rendered
        return {
          kind: 'success',
          text: withJournal([body, verification, ledger.ledger].filter((line) => line !== '').join('\n')),
        }
      } catch (error) {
        logger?.warn?.(`[code-review] /review 失败：${error.message}`)
        return { kind: 'error', text: `审查失败：${error.message}` }
      }
    },
  }
}
