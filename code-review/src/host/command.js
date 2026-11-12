/**
 * `/review` 手动入口：只把报告返回给 UI，不回注、不 steer。
 * @module @liyuera/dsh-code-review/host/command
 */
import { chunkFiles, mapWithLimit, mergeReviews, timeoutFor } from './chunk.js'
import { collect } from './collect.js'
import { finalizeFindings } from './finalize.js'
import { collectPatch, collectRange } from './git.js'
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
    description: '通用代码审查：审查本轮改动、git 范围或补丁文件并输出报告',
    input: { hint: '可留空；--full 复审整条链，--range <base>..<head> 审 git 范围，--patch <file> 审补丁文件' },
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
        // 范围审查（--range / --patch）：同步、只报告、不占自动轮次、不回灌。
        // 取材走只读 git / 宿主补丁文件；分块送审，合并后统一做证据校验/复验/渲染。
        const runRangeReview = async ({ range, patchFile }) => {
          const cwd = agent.session?.header?.cwd
          if (typeof cwd !== 'string' || cwd.length === 0) {
            return { kind: 'error', text: withJournal('会话没有工作目录，无法执行范围审查。') }
          }
          let collected
          try {
            collected = patchFile === undefined
              ? await collectRange({ cwd, range, config })
              : await collectPatch({ cwd, patchFile, config })
          } catch (error) {
            logger?.warn?.(`[code-review] 范围审查取材失败：${error.message}`)
            return { kind: 'error', text: withJournal(`范围审查取材失败：${error.message}`) }
          }
          if (collected.files.length === 0) {
            return { kind: 'error', text: withJournal('该范围没有可审查的代码文件（可能全是二进制或超出预算）。') }
          }
          const loaded = await getRules()
          const composed = composeRules({ ...loaded, filePaths: collected.files.map((file) => file.path) })
          const suppressions = await loadSuppressions({ config, cwd, warn: logger?.warn })
          const chunks = chunkFiles(collected.files, config.maxDiffBytes)
          const label = patchFile === undefined ? `范围 ${range}` : `补丁 ${patchFile}`
          const startedAt = Date.now()
          const chunkBytesOf = (files) => files.reduce(
            (total, file) => total + Buffer.byteLength(String(file.text ?? ''), 'utf8'),
            0,
          )
          // 单块审查：范围块超时以 rangeChunkTimeoutMs 为下限（reviewer 会用 read/grep
          // 核对上下文，turn 模式的 2 分钟基准经常不够）；再受总预算 rangeTimeoutMs 约束。
          const reviewChunk = (chunk, index, { retry = false } = {}) => {
            if (signal?.aborted) return Promise.resolve({ ok: false, reason: 'aborted' })
            const remaining = config.rangeTimeoutMs - (Date.now() - startedAt)
            if (remaining <= 0) return Promise.resolve({ ok: false, reason: 'timeout' })
            const base = Math.max(config.rangeChunkTimeoutMs, timeoutFor(chunkBytesOf(chunk), {
              baseMs: config.reviewerTimeoutMs,
              perKbMs: config.reviewerTimeoutPerKbMs,
              maxMs: config.reviewerTimeoutMaxMs,
            }))
            return runReview({
              subagents,
              agent,
              preset: config.reviewerPreset,
              prompt: buildPrompt({
                rulesPrompt: composed.prompt,
                files: chunk,
                skipped: [],
                header: [
                  `${label} 的第 ${index + 1}/${chunks.length} 块（本块 ${chunk.length} 个文件${retry ? '，重试' : ''}）。`,
                  '只审查本块内出现的 diff；不要推测未提供的文件，也不要跨块重复报告同一问题。',
                  '本块 diff 已完整提供：不要用 grep/read 探索无关文件；只在必须核对被 diff 引用的定义时读文件。',
                  'finding 控制在 8 条以内、阻塞项优先；evidence 每个只引一行片段，最后输出 json 代码块即可。',
                ],
              }),
              timeoutMs: Math.min(remaining, base),
              modelOverride: config.modelOverride,
              signal,
              allowedRuleIds: composed.allowedRuleIds,
              allowedPaths: new Set(chunk.map((file) => file.path)),
              ruleSeverities: composed.ruleSeverities,
              logger,
              evidenceContext: { mode: 'turn', files: chunk },
              evidenceMode: config.evidenceMode,
              coverageMode: config.coverageMode,
            })
          }
          // 块失败先拆半重试一次（rebase 后的大 diff 常出现 provider 输出畸形/超时）；
          // 单文件块原样重试一次。拆分重试仍失败才计入覆盖缺口。
          const reviewWithRetry = async (chunk, index) => {
            const first = await reviewChunk(chunk, index)
            if (first?.ok === true || signal?.aborted) return [first]
            logger?.warn?.(`[code-review] ${label} 第 ${index + 1}/${chunks.length} 块失败（${first?.reason ?? 'unknown'}），重试`)
            if (chunk.length > 1) {
              const half = Math.ceil(chunk.length / 2)
              const retried = await Promise.all([
                reviewChunk(chunk.slice(0, half), index, { retry: true }),
                reviewChunk(chunk.slice(half), index, { retry: true }),
              ])
              const ok = retried.filter((outcome) => outcome?.ok === true)
              if (ok.length > 0) return ok
              return [{ ok: false, reason: retried.map((outcome) => outcome?.reason ?? 'unknown').join('+') }]
            }
            const retried = await reviewChunk(chunk, index, { retry: true })
            return retried?.ok === true
              ? [retried]
              : [{ ok: false, reason: `${first?.reason ?? 'unknown'}+${retried?.reason ?? 'unknown'}` }]
          }
          const chunkOutcomes = await mapWithLimit(chunks, config.rangeConcurrency, reviewWithRetry)
          if (signal?.aborted) {
            return { kind: 'error', text: withJournal('范围审查已取消。') }
          }
          const results = []
          const failedReasons = []
          chunkOutcomes.forEach((outcomes, index) => {
            for (const outcome of outcomes) {
              if (outcome?.ok === true) {
                results.push(outcome)
                continue
              }
              failedReasons.push(`第 ${index + 1} 块 ${outcome?.reason ?? 'unknown'}`)
              logger?.warn?.(`[code-review] ${label} 第 ${index + 1}/${chunks.length} 块最终失败：${outcome?.reason ?? 'unknown'}`)
            }
          })
          const failedChunks = chunkOutcomes.filter((outcomes) => outcomes.every((outcome) => outcome?.ok !== true)).length
          if (results.length === 0) {
            return {
              kind: 'error',
              text: withJournal(
                `${label} 审查未完成（${failedChunks}/${chunks.length} 块失败）：${[...new Set(failedReasons)].join('；') || '未知原因'}`,
              ),
            }
          }
          const merged = mergeReviews(results)
          const final = await finalizeFindings({
            findings: merged.findings,
            evidence: merged.evidence,
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
          const added = collected.files.reduce((total, file) => total + (file.added ?? 0), 0)
          const deleted = collected.files.reduce((total, file) => total + (file.deleted ?? 0), 0)
          const scope = { files: collected.files.length + collected.skipped.length, added, deleted }
          const ledger = withLedger(final.findings, final.suppressed, collected.files.map((file) => file.path))
          const rendered = renderFindings({
            findings: ledger.findings,
            skipped: collected.skipped,
            blockingSeverities: config.blockingSeverities,
            notifySeverities: config.notifySeverities ?? [],
            summary: scope,
            mode: 'report',
            coverage: merged.coverage,
            suppressed: final.suppressed,
            respectFixPolicy: config.respectFixPolicy,
          })
          const verification = verificationLine(final.verification)
          const body = rendered === ''
            ? renderPass({ summary: scope, skipped: collected.skipped, coverage: merged.coverage })
            : rendered
          const gap = failedChunks > 0
            ? `覆盖缺口: ${failedChunks}/${chunks.length} 块审查失败（${[...new Set(failedReasons)].join('；')}），本报告 NOT clean，请人工确认未覆盖面。`
            : ''
          return {
            kind: 'success',
            text: withJournal([body, verification, ledger.ledger, gap].filter((line) => line !== '').join('\n')),
          }
        }
        // 现有调用方可能不传 rawInput：统一转字符串，避免 undefined.trim()。
        // 支持的参数：空（最近一轮）、--full、--range <base>..<head>、--patch <file>。
        const rawInputText = String(rawInput ?? '').trim()
        const rangeMatch = /^--range\s+(\S.*)$/.exec(rawInputText)
        const patchMatch = /^--patch\s+(\S.*)$/.exec(rawInputText)
        const wantFull = rawInputText === '--full'
        if (rawInputText.startsWith('--range') && rangeMatch === null) {
          return { kind: 'error', text: '用法：/review --range <base>..<head>' }
        }
        if (rawInputText.startsWith('--patch') && patchMatch === null) {
          return { kind: 'error', text: '用法：/review --patch <补丁文件（相对会话工作目录）>' }
        }
        if (rawInputText !== '' && !wantFull && rangeMatch === null && patchMatch === null) {
          return { kind: 'error', text: '未知参数；可用 --full、--range <base>..<head> 或 --patch <file>。' }
        }
        if (rangeMatch !== null || patchMatch !== null) {
          return await runRangeReview({
            range: rangeMatch?.[1],
            patchFile: patchMatch?.[1],
          })
        }
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
