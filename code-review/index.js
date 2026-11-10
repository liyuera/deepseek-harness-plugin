/**
 * Host half of `@liyuera/dsh-code-review`.
 * @module @liyuera/dsh-code-review
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from './src/host/config.js'
import { collect, fingerprint } from './src/host/collect.js'
import { loadRulesResilient } from './src/host/rules.js'
import { renderFindings, renderPass } from './src/host/render.js'
import { buildPrompt, runReview } from './src/host/reviewer.js'
import { shouldReview } from './src/host/trigger.js'
import { createTracker } from './src/host/loop.js'
import { createReviewCommand } from './src/host/command.js'
import { createReviewerGuard } from './src/host/guard.js'

export const name = 'code-review'
export const inject = ['commands', 'subagents', 'workspaceChanges', 'tools', 'agentPresets']

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

/** 构造一条可被 steer 注入的用户消息。source 必填，漏了渲染时会崩。 */
function message(text) {
  return { id: crypto.randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

/**
 * 挂载插件。规范每轮审查前从包目录读盘，改完下一轮即生效；不做缓存。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  ctx.tools.guard(createReviewerGuard(resolved.reviewerPreset))
  const tracker = createTracker()
  const latestSeq = new Map()
  const previousBlocking = new Map()
  // 同一 turn 内已成功审查过的内容指纹：`${sessionId}:${turn}` → fingerprint。
  const reviewedFingerprint = new Map()
  let warned = false
  let summaryWarned = false

  const warnOnce = (text) => {
    if (warned) return
    warned = true
    ctx.logger.warn(text)
  }

  /** steer 失败只告警：审查本身已成功，不能当成审查失败去动熔断。 */
  const steerSafely = (target, text) => {
    try {
      target.steer(message(text))
    } catch (error) {
      ctx.logger.warn(`[code-review] steer 失败：${error.message}`)
    }
  }

  const getRules = () => loadRulesResilient({
    rulesPath: join(PACKAGE_ROOT, resolved.rulesFile),
    principlesPath: join(PACKAGE_ROOT, resolved.principlesFile),
    warn: warnOnce,
  })

  try {
    ctx.commands.register(createReviewCommand({
      config: resolved,
      workspaceChanges: ctx.workspaceChanges,
      subagents: ctx.subagents,
      getRules,
      logger: ctx.logger,
      latestSeq: (sessionId) => latestSeq.get(sessionId),
      isReviewing: (sessionId) => tracker.isReviewing(sessionId),
    }))
  } catch (error) {
    // 命令重名只影响手动入口，自动审查仍应可用。
    ctx.logger.warn(`[code-review] /review 命令注册失败（可能与其他插件重名）：${error.message}`)
  }

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'workspace/changes') latestSeq.set(session.id, event.seq)
  })

  ctx.on('session/disposed', (session) => {
    latestSeq.delete(session.id)
    previousBlocking.delete(session.id)
    for (const key of reviewedFingerprint.keys()) {
      if (key.startsWith(`${session.id}:`)) reviewedFingerprint.delete(key)
    }
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
    // 第三方 summary 实现抛错时 fail-open：记一次警告后跳过，不把 turn 变成错误。
    let summary
    try {
      summary = ctx.workspaceChanges.summary(sessionId, seq)
      // 形状校验也放在 try 内：第三方 summary 实现缺字段时按 stale 跳过，而不是把 turn 变 error。
      if (
        summary === undefined
        || !Array.isArray(summary.files)
        || summary.files.length === 0
        || summary.turn !== turn
      ) {
        ctx.logger.debug?.(`[code-review] skip: stale-summary turn=${turn}`)
        return
      }
    } catch (error) {
      if (!summaryWarned) {
        summaryWarned = true
        ctx.logger.warn(`[code-review] 无法读取变更摘要，跳过自动审查：${error.message}`)
      }
      return
    }
    if (!tracker.begin(sessionId, turn)) return
    const rounds = tracker.roundsOf(sessionId, turn)
    const lastRound = rounds >= resolved.maxRounds
    const startedAt = Date.now()

    try {
      const rules = await getRules()
      const collected = await collect({
        workspaceChanges: ctx.workspaceChanges,
        sessionId,
        seq,
        config: resolved,
        signal,
      })
      if (collected.files.length === 0) {
        // 没有可审内容，回滚本轮：不能白烧 maxRounds。
        ctx.logger.debug?.('[code-review] skip: empty-collect turn=%d', turn)
        tracker.abandonRound(sessionId, turn)
        return
      }
      // workspace-changes 每个 turn-stopping 都会以新 seq 重新宣告同一份未变 diff，
      // 用内容指纹去重，避免同一 turn 内重复审查/重复注入。
      const dedupKey = `${sessionId}:${turn}`
      const hash = fingerprint(collected.files)
      if (reviewedFingerprint.get(dedupKey) === hash) {
        ctx.logger.debug?.('[code-review] skip: duplicate-diff turn=%d', turn)
        tracker.abandonRound(sessionId, turn)
        return
      }

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
        ruleSeverities: rules.ruleSeverities,
        logger: ctx.logger,
      })

      if (!reviewed.ok) {
        ctx.logger.debug?.('[code-review] review failed: %s', reviewed.reason)
        if (signal?.aborted) return
        if (tracker.recordFailure(sessionId)) {
          ctx.logger.warn('[code-review] 连续失败，已暂停本会话的自动审查')
        }
        return
      }
      tracker.recordSuccess(sessionId)
      // 只有成功审查才占去重位；失败时允许同一 diff 重试。
      reviewedFingerprint.set(dedupKey, hash)

      const elapsed = Date.now() - startedAt
      const totalFiles = summary.total ?? summary.files.length
      ctx.logger.debug?.(
        '[code-review] reviewed turn=%d files=%d findings=%d skipped=%d elapsed=%dms',
        turn,
        totalFiles,
        reviewed.findings.length,
        collected.skipped.length,
        elapsed,
      )
      if (totalFiles > summary.files.length) {
        ctx.logger.debug?.('[code-review] truncated files=%d kept=%d', totalFiles, summary.files.length)
      }
      if (signal?.aborted) return

      const scope = { files: totalFiles, added: summary.added, deleted: summary.deleted }
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
        const repair = lastRound
          ? '请按上面每条 finding 修复。本轮已达到自动复审上限，修完不会再自动复审，请人工确认。如与用户新指令冲突，以用户指令为准。'
          : '请按上面每条 finding 修复；修完会再复审一次。如与用户新指令冲突，以用户指令为准。'
        steerSafely(agent, `${text}\n\n${repair}`)
      } else if (hadBlocking) {
        steerSafely(agent, `${renderPass({ summary: scope, skipped: collected.skipped })}\n\n可以收尾了。`)
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
