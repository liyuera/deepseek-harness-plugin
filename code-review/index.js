/**
 * Host half of `@liyuera/dsh-code-review`.
 * @module @liyuera/dsh-code-review
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from './src/host/config.js'
import { collect, fingerprint } from './src/host/collect.js'
import { loadRulesResilient } from './src/host/rules.js'
import { renderFindings } from './src/host/render.js'
import { buildPrompt, startReview } from './src/host/reviewer.js'
import { shouldReview } from './src/host/trigger.js'
import { createTracker } from './src/host/loop.js'
import { createReviewCommand } from './src/host/command.js'
import { createReviewerGuard } from './src/host/guard.js'

export const name = 'code-review'
export const inject = ['commands', 'subagents', 'workspaceChanges', 'tools', 'agentPresets', 'agents']

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * 构造一条插件来源的消息。`plugin` 来源不会重置链预算，也不会被当成人类输入。
 * source 必填，漏了渲染时会崩。
 */
function message(text) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    source: { kind: 'plugin:code-review' },
    content: [{ type: 'text', text }],
  }
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
  // 同一条链内上一次成功审查的 diff 指纹：`sessionId` → fingerprint。
  const lastFingerprint = new Map()
  // 在途审查：`sessionId` → { result, cancel }。一个会话同时只允许一个。
  const inflight = new Map()
  // 会话代次：disposed 时 +1，用于识别启动过程中被关闭的会话。
  const generations = new Map()
  // 后台审查的生命周期信号：不随 turn 结束/取消而中断。
  const lifetime = new AbortController()
  let warned = false
  let summaryWarned = false

  const warnOnce = (text) => {
    if (warned) return
    warned = true
    ctx.logger.warn(text)
  }

  ctx.effect(() => () => {
    lifetime.abort()
    for (const handle of inflight.values()) handle.cancel('plugin-disposed')
    inflight.clear()
  }, 'code-review: dispose in-flight reviews')

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

  /**
   * 后台审查结算：先释放资源，再按结果回灌或静默丢弃。
   * 自己吞掉所有异常，绝不让后台 promise 变成 unhandled rejection。
   */
  const settle = async (sessionId, handle, meta, outcome) => {
    clearTimeout(meta.timer)
    const active = inflight.get(sessionId) === handle
    if (active) {
      inflight.delete(sessionId)
      tracker.end(sessionId)
    }

    // 会话关闭/插件卸载时句柄已被摘除：结果一律丢弃，也不计失败。
    if (!active || lifetime.signal.aborted) {
      ctx.logger.debug?.(`[code-review] drop: session ${sessionId} 的审查结果已失效`)
      return
    }

    try {
      if (outcome.ok !== true) {
        ctx.logger.debug?.(`[code-review] review failed: ${outcome.reason}`)
        if (tracker.recordFailure(sessionId)) {
          ctx.logger.warn('[code-review] 连续失败，已暂停本会话的自动审查')
        }
        return
      }

      tracker.recordSuccess(sessionId)
      // 只有成功审查才写指纹；失败/取消允许同一份 diff 重试。
      lastFingerprint.set(sessionId, meta.hash)
      const elapsed = Date.now() - meta.startedAt
      const totalFiles = meta.summary.total ?? meta.summary.files.length
      ctx.logger.debug?.(
        '[code-review] reviewed rounds=%d files=%d findings=%d skipped=%d elapsed=%dms',
        meta.rounds,
        totalFiles,
        outcome.findings.length,
        meta.collected.skipped.length,
        elapsed,
      )
      if (totalFiles > meta.summary.files.length) {
        ctx.logger.debug?.('[code-review] truncated files=%d kept=%d', totalFiles, meta.summary.files.length)
      }

      const scope = { files: totalFiles, added: meta.summary.added, deleted: meta.summary.deleted }
      const text = renderFindings({
        findings: outcome.findings,
        skipped: meta.collected.skipped,
        blockingSeverities: resolved.blockingSeverities,
        summary: scope,
        mode: 'steer',
      })
      // v2：通过/只有非阻塞建议时静默，不再注入「结论: 通过」。
      if (text === '') return

      // 会话已关闭或同 id 换了一个 agent：丢弃结果，不抛。
      const live = ctx.get?.('agents')?.get(sessionId)
      if (live !== meta.agent) {
        ctx.logger.debug?.(`[code-review] drop: session ${sessionId} 的 agent 已关闭或更换`)
        return
      }

      const repair = meta.lastRound
        ? '请按上面每条 finding 修复。本轮已达到自动复审上限，修完不会再自动复审，请人工确认。如与用户新指令冲突，以用户指令为准。'
        : '请按上面每条 finding 修复；修完会再复审一次。如与用户新指令冲突，以用户指令为准。'
      try {
        live.followup(message(`${text}\n\n${repair}`))
      } catch (error) {
        ctx.logger.warn(`[code-review] followup 失败：${error.message}`)
      }
    } catch (error) {
      ctx.logger.warn(`[code-review] settle failed: ${error.message}`)
    }
  }

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'workspace/changes') {
      latestSeq.set(session.id, event.seq)
      return
    }
    // 只有人类消息开启新链；插件注入的 followup 是 plugin 来源，不得重置。
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
      tracker.resetRounds(session.id)
      lastFingerprint.delete(session.id)
    }
  })

  ctx.on('session/disposed', (session) => {
    generations.set(session.id, (generations.get(session.id) ?? 0) + 1)
    const handle = inflight.get(session.id)
    if (handle !== undefined) {
      handle.cancel('session-disposed')
      inflight.delete(session.id)
    }
    latestSeq.delete(session.id)
    lastFingerprint.delete(session.id)
    tracker.forget(session.id)
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const sessionId = agent.session.id
    const generation = generations.get(sessionId) ?? 0
    const seq = latestSeq.get(sessionId)
    const decision = shouldReview({
      config: resolved,
      origin: agent.session.header?.origin,
      reviewing: tracker.isReviewing(sessionId),
      rounds: tracker.roundsOf(sessionId),
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

    const startedAt = Date.now()
    let collected
    try {
      collected = await collect({
        workspaceChanges: ctx.workspaceChanges,
        sessionId,
        seq,
        config: resolved,
        signal,
      })
    } catch (error) {
      ctx.logger.warn(`[code-review] collect failed: ${error.message}`)
      return
    }
    if (collected.files.length === 0) {
      // 没有可审内容：还没占用轮次，直接跳过。
      ctx.logger.debug?.('[code-review] skip: empty-collect')
      return
    }

    // workspace-changes 每个 turn-stopping 都会以新 seq 重新宣告同一份未变 diff，
    // 用内容指纹去重，避免同一份 diff 重复审查/重复注入；去重不消耗轮次。
    const hash = fingerprint(collected.files)
    if (lastFingerprint.get(sessionId) === hash) {
      ctx.logger.debug?.('[code-review] skip: duplicate-diff')
      return
    }

    // 取材期间会话被释放：不再占轮次，也不发起审查。
    if ((generations.get(sessionId) ?? 0) !== generation) return

    if (!tracker.begin(sessionId)) {
      // 与门禁之间的竞态兜底：另一个 turn-stopping 已经拿到锁。
      ctx.logger.debug?.('[code-review] skip: reviewing')
      return
    }
    const rounds = tracker.roundsOf(sessionId)
    const lastRound = rounds >= resolved.maxRounds

    let handle
    try {
      const rules = await getRules()
      handle = await startReview({
        subagents: ctx.subagents,
        agent,
        preset: resolved.reviewerPreset,
        prompt: buildPrompt({ rulesPrompt: rules.prompt, files: collected.files, skipped: collected.skipped }),
        signal: lifetime.signal,
        modelOverride: resolved.modelOverride,
        allowedRuleIds: rules.allowedRuleIds,
        allowedPaths: new Set(collected.files.map((file) => file.path)),
        ruleSeverities: rules.ruleSeverities,
        logger: ctx.logger,
      })
    } catch (error) {
      // 启动失败由这里记一次失败并释放锁；不占用 inflight 表。
      ctx.logger.debug?.(`[code-review] start failed: ${error.message}`)
      if (tracker.recordFailure(sessionId)) {
        ctx.logger.warn('[code-review] 连续失败，已暂停本会话的自动审查')
      }
      tracker.end(sessionId)
      return
    }

    // 启动期间会话被释放：拿到 activation 后立刻取消，不留下 10 分钟定时器。
    if ((generations.get(sessionId) ?? 0) !== generation) {
      handle.cancel('session-disposed')
      tracker.end(sessionId)
      return
    }

    inflight.set(sessionId, handle)
    const timer = setTimeout(() => handle.cancel('timeout'), resolved.asyncReviewerTimeoutMs)
    const meta = { agent, summary, collected, hash, rounds, lastRound, startedAt, timer }

    // 后台结算：handler 到这里就返回，不等待审查结果。
    void handle.result
      .then((outcome) => settle(sessionId, handle, meta, outcome))
      .catch((error) => ctx.logger.warn(`[code-review] settle crashed: ${error.message}`))
  })

  ctx.logger.info(`[code-review] loaded preset=${resolved.reviewerPreset} maxRounds=${resolved.maxRounds}`)
}
