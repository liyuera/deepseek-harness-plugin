/**
 * Host half of `@liyuera/dsh-code-review`.
 * @module @liyuera/dsh-code-review
 */
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from './src/host/config.js'
import { collect, fingerprint, isCodeFile } from './src/host/collect.js'
import { composeRules, loadRulesResilient } from './src/host/rules.js'
import { classifyFindings, renderFindings } from './src/host/render.js'
import { buildFullPrompt, buildPrompt, startReview } from './src/host/reviewer.js'
import { finalizeFindings } from './src/host/finalize.js'
import { loadSuppressions } from './src/host/suppress.js'
import { readWorkspaceTexts } from './src/host/readfile.js'
import { shouldReview } from './src/host/trigger.js'
import { createTracker } from './src/host/loop.js'
import { createReviewCommand } from './src/host/command.js'
import { createReviewerGuard } from './src/host/guard.js'
import { createJournal } from './src/host/journal.js'
import { createChainStore } from './src/host/chain.js'
import { annotateRepeats, LEDGER_WINDOW } from './src/host/ledger.js'

export const name = 'code-review'
export const inject = ['commands', 'subagents', 'workspaceChanges', 'tools', 'agentPresets', 'agents']

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

/**
 * 构造一条插件来源的消息。`plugin:code-review` 来源不会重置链预算，也不会被当成人类输入。
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
  const journal = createJournal({ ctx, logger: ctx.logger })
  const chain = createChainStore({ maxFiles: resolved.fullReviewMaxFiles })
  /** 已宣告但尚未并入链的 workspace/changes：`sessionId` → [{seq, epoch, turn}]。 */
  const pendingChanges = new Map()
  /** 本链最近一次成功审查的 findings（全量复审去重用）：`sessionId` → findings。 */
  const lastFindings = new Map()
  /** 在途审查的 journal key：sessionId → key，结算/取消后删除。 */
  const journalKeys = new Map()
  const latestSeq = new Map()
  // 同一条链内上一次成功审查的 diff 指纹：`sessionId` → fingerprint。
  const lastFingerprint = new Map()
  // 在途审查：`sessionId` → { result, cancel }。一个会话同时只允许一个。
  const inflight = new Map()
  // 启动中的审查：`sessionId` → AbortController，用于 disposed/插件卸载时叫停 startReview。
  const starting = new Map()
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
    // 新增：在途留痕标为 cancelled，并关闭存储 domain
    for (const key of journalKeys.values()) journal.cancel(key, 'plugin-disposed')
    journalKeys.clear()
    void journal.dispose()
    // 以下为现有清理逻辑，保持不动
    lifetime.abort()
    for (const handle of inflight.values()) handle.cancel('plugin-disposed')
    inflight.clear()
    for (const control of starting.values()) control.abort()
    starting.clear()
    generations.clear()
  }, 'code-review: dispose in-flight reviews')

  const getRules = async () => {
    // 返回原始规则表（含未过滤的 scope），由调用方按本次变更文件 compose。
    return loadRulesResilient({
      rulesPath: join(PACKAGE_ROOT, resolved.rulesFile),
      principlesPath: join(PACKAGE_ROOT, resolved.principlesFile),
      packs: resolved.rulePacks.map((pack) => (isAbsolute(pack) ? pack : join(PACKAGE_ROOT, pack))),
      warn: warnOnce,
    })
  }

  try {
    ctx.commands.register(createReviewCommand({
      config: resolved,
      workspaceChanges: ctx.workspaceChanges,
      subagents: ctx.subagents,
      getRules,
      logger: ctx.logger,
      latestSeq: (sessionId) => latestSeq.get(sessionId),
      isReviewing: (sessionId) => tracker.isReviewing(sessionId),
      chain,
      tracker,
      journal,
    }))
  } catch (error) {
    // 命令重名只影响手动入口，自动审查仍应可用。
    ctx.logger.warn(`[code-review] /review 命令注册失败（可能与其他插件重名）：${error.message}`)
  }

  /**
   * 全量模式需要读链内文件当前内容来校验证据；turn 模式直接复用已采的 hunks。
   * 读不到的文件在 evidenceContext 里没有 text，校验时按「不可读」保留 finding。
   */
  const buildEvidenceContext = async (agent, filesForReview, fullRound, collected) => {
    if (!fullRound) return { mode: 'turn', files: collected.files }
    const cwd = agent.session?.header?.cwd
    const texts = await readWorkspaceTexts({
      cwd,
      paths: filesForReview.map((file) => file.path),
    })
    return {
      mode: 'full',
      files: filesForReview.map((file) => ({ path: file.path, text: texts.get(file.path) })),
    }
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
      // 正常情况下卸载钩子已经取消并摘掉了 key；这里只兜底尚未收口的记录，
      // 避免用 'dispose' 覆盖掉 'session-disposed' / 'plugin-disposed' 原因。
      const pendingKey = journalKeys.get(sessionId)
      if (pendingKey !== undefined) {
        journalKeys.delete(sessionId)
        journal.cancel(pendingKey, lifetime.signal.aborted ? 'plugin-disposed' : 'dispose')
      }
      ctx.logger.debug?.(`[code-review] drop: session ${sessionId} 的审查结果已失效`)
      return
    }

    try {
      if (outcome.ok !== true) {
        journalKeys.delete(sessionId)
        journal.settle(meta.journalKey, {
          // 审查阶段超时（timer 调 handle.cancel('timeout')）单列 timeout 状态。
          status: outcome.reason === 'timeout' ? 'timeout' : 'failed',
          reason: outcome.reason,
        })
        ctx.logger.debug?.(`[code-review] review failed: ${outcome.reason}`)
        if (tracker.recordFailure(sessionId)) {
          ctx.logger.warn('[code-review] 连续失败，已暂停本会话的自动审查')
        }
        return
      }

      let final
      try {
        final = await finalizeFindings({
          findings: outcome.findings,
          evidence: outcome.evidence,
          ruleFixModes: meta.composed?.ruleFixModes,
          ruleBlocking: meta.composed?.ruleBlocking,
          config: resolved,
          suppressions: meta.suppressions ?? [],
          files: meta.filesForReview ?? [],
          subagents: ctx.subagents,
          agent: meta.agent,
          preset: resolved.reviewerPreset,
          signal: lifetime.signal,
          logger: ctx.logger,
          modelOverride: resolved.modelOverride,
        })
      } catch (error) {
        // 收口失败（抑制/复验的意外异常）不能让留痕卡在 running，也不能丢已校验的 findings。
        ctx.logger.warn(`[code-review] finalize failed: ${error.message}`)
        final = {
          findings: outcome.findings,
          suppressed: [],
          verification: { checked: 0, confirmed: 0, rejected: 0, unverified: 0 },
        }
      }
      // 跨轮账本：同一指纹历史已报过就标 repeats，渲染时提示「第 N 次报告」。
      // journal 在途记录状态为 running，不会被计入历史。
      const findings = annotateRepeats(final.findings, journal.recent(sessionId, LEDGER_WINDOW))
      // 复验可能耗时较长：期间会话关闭/插件卸载时 journal 已被 cancel，
      // 这里不再把记录回写成 completed，也不回灌。
      if (lifetime.signal.aborted || (generations.get(sessionId) ?? 0) !== meta.generation) {
        ctx.logger.debug?.(`[code-review] drop: session ${sessionId} 的审查结果在收口期间失效`)
        return
      }

      const recordCompleted = (injected) => {
        journalKeys.delete(sessionId)
        journal.settle(meta.journalKey, {
          status: 'completed',
          findings,
          injected,
          coverage: outcome.coverage,
          verification: final.verification,
          suppressed: final.suppressed.length,
        })
      }

      // 审查本身已成功跑完：无论按不按当前链口径回灌，都要清零熔断失败计数。
      tracker.recordSuccess(sessionId)
      // 复验把收口窗口拉长到分钟级：期间人类消息可能已开启新链，
      // 旧链结果不得回灌，也不得污染新链的去重指纹/全量状态/已报问题。
      const sameChain = meta.epoch === tracker.epochOf(sessionId)
      if (!sameChain) {
        ctx.logger.debug?.(`[code-review] drop: session ${sessionId} 的审查结果属于已重置的旧链`)
        recordCompleted(false)
        return
      }
      lastFingerprint.set(sessionId, meta.hash)
      if (meta.fullRound) chain.markFull(sessionId, meta.epoch)
      lastFindings.set(sessionId, findings)
      const elapsed = Date.now() - meta.startedAt
      const totalFiles = meta.summary.total ?? meta.summary.files.length
      ctx.logger.debug?.(
        '[code-review] reviewed rounds=%d files=%d findings=%d skipped=%d elapsed=%dms',
        meta.rounds,
        totalFiles,
        findings.length,
        meta.collected.skipped.length,
        elapsed,
      )
      if (totalFiles > meta.summary.files.length) {
        ctx.logger.debug?.('[code-review] truncated files=%d kept=%d', totalFiles, meta.summary.files.length)
      }

      const scope = { files: totalFiles, added: meta.summary.added, deleted: meta.summary.deleted }
      const baseRender = {
        findings,
        skipped: meta.collected.skipped,
        blockingSeverities: resolved.blockingSeverities,
        notifySeverities: resolved.notifySeverities,
        summary: scope,
        coverage: outcome.coverage,
        suppressed: final.suppressed,
        respectFixPolicy: resolved.respectFixPolicy,
      }
      const buckets = classifyFindings(findings, resolved.blockingSeverities, resolved.respectFixPolicy)
      // 结算时实时读链轮次：人类重置链后 rounds=0，不能再用旧链的「最后一轮」口径。
      const lastRound = tracker.roundsOf(sessionId) >= resolved.maxRounds
      const note = lastRound
        ? '本轮已达到自动复审上限，修完不会再自动复审，请人工确认。'
        : '修完会再复审一次。'
      const notifySet = new Set(resolved.notifySeverities)
      const notified = buckets.passive.filter((finding) => notifySet.has(finding.severity))
      let payload = ''
      if (buckets.auto.length > 0) {
        const blockingText = renderFindings({ ...baseRender, mode: 'steer' })
        const suggest = notified.length > 0 ? '；非阻塞建议可选择性处理' : ''
        const hints = []
        if (buckets.manual.length > 0) hints.push('标注[人工]的问题需人工确认，不要自动修改')
        if (buckets.unverified.length > 0) hints.push('标注[未复验]的问题仅作报告，不要据此修复')
        const hintText = hints.length > 0 ? `${hints.join('；')}。` : ''
        const instruction = `请按上面每条阻塞 finding 修复${suggest}。${hintText}${note}`
        payload = [blockingText, '', `${instruction}如与用户新指令冲突，以用户指令为准。`].join('\n')
      } else if (buckets.manual.length > 0 || buckets.unverified.length > 0) {
        const manualText = renderFindings({ ...baseRender, mode: 'manual' })
        if (manualText === '') {
          recordCompleted(false)
          return
        }
        const action = buckets.manual.length > 0
          ? '以上问题需人工确认，请勿自动修改。'
          : '以上问题未通过复验/证据不足，仅作报告；请人工确认，不要据此自动修改。'
        const actionLine = `${action}如与用户新指令冲突，以用户指令为准。`
        payload = [manualText, '', actionLine].join('\n')
      } else if (resolved.notifySeverities.length > 0) {
        const notifyText = renderFindings({ ...baseRender, mode: 'notify' })
        // 没有命中 notifySeverities 的建议（或本轮干净）：仍然静默。
        if (notifyText === '') {
          recordCompleted(false)
          return
        }
        const suffix = '如与用户新指令冲突，以用户指令为准。'
        payload = [
          notifyText,
          '',
          `以上为非阻塞建议，可选择不改；若认同可顺手修复。${note}${suffix}`,
        ].join('\n')
      } else {
        // v2 默认行为：通过/只有非阻塞建议时静默，不注入「结论: 通过」。
        recordCompleted(false)
        return
      }

      // 会话已关闭或同 id 换了一个 agent：丢弃结果，不抛。
      const live = ctx.get?.('agents')?.get(sessionId)
      if (live !== meta.agent) {
        recordCompleted(false)
        ctx.logger.debug?.(`[code-review] drop: session ${sessionId} 的 agent 已关闭或更换`)
        return
      }

      try {
        live.followup(message(payload))
        recordCompleted(true)
      } catch (error) {
        // followup 失败时审查本身仍算完成，但结果没有回灌。
        recordCompleted(false)
        ctx.logger.warn(`[code-review] followup 失败：${error.message}`)
      }
    } catch (error) {
      ctx.logger.warn(`[code-review] settle failed: ${error.message}`)
    }
  }

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'workspace/changes') {
      latestSeq.set(session.id, event.seq)
      // 先排队，等 turn-stopping 时再统一读 summary 观察：事件可能早于摘要落库，
      // 且同一条链里多轮变更要按各自 seq 逐条并入。
      const queue = pendingChanges.get(session.id) ?? []
      queue.push({ seq: event.seq, epoch: tracker.epochOf(session.id), turn: event.data?.turn })
      pendingChanges.set(session.id, queue)
      return
    }
    // 只有人类消息开启新链；插件注入的 followup 是 plugin 来源，不得重置。
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
      tracker.resetRounds(session.id)
      lastFingerprint.delete(session.id)
      lastFindings.delete(session.id)
    }
  })

  ctx.on('session/disposed', (session) => {
    generations.set(session.id, (generations.get(session.id) ?? 0) + 1)
    const journalKey = journalKeys.get(session.id)
    if (journalKey !== undefined) {
      journalKeys.delete(session.id)
      journal.cancel(journalKey, 'session-disposed')
    }
    const handle = inflight.get(session.id)
    if (handle !== undefined) {
      handle.cancel('session-disposed')
      inflight.delete(session.id)
    }
    // 启动尚未返回：叫停 startReview，拿到 activation 后它会自行 dispose。
    starting.get(session.id)?.abort()
    starting.delete(session.id)
    latestSeq.delete(session.id)
    lastFingerprint.delete(session.id)
    pendingChanges.delete(session.id)
    lastFindings.delete(session.id)
    chain.forget(session.id)
    tracker.forget(session.id)
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const sessionId = agent.session.id
    // 先把此前宣告的 workspace/changes 并入链。摘要可能尚未落库或形状不对：
    // 一律跳过，不把 turn 变成错误。人类消息已换链的旧 epoch 队列直接丢弃，
    // 否则 chain.observe 会用旧 epoch 覆盖新链状态。
    const flushChain = () => {
      const queue = pendingChanges.get(sessionId) ?? []
      pendingChanges.delete(sessionId)
      const epoch = tracker.epochOf(sessionId)
      for (const item of queue) {
        if (item.epoch !== epoch) continue
        let queued
        try {
          queued = ctx.workspaceChanges.summary(sessionId, item.seq)
        } catch {
          continue
        }
        if (queued === undefined || !Array.isArray(queued.files)) continue
        chain.observe(
          sessionId,
          item.epoch,
          item.seq,
          queued.turn,
          queued.files,
          (path) => isCodeFile(path, resolved.codeExtensions),
        )
      }
    }
    flushChain()
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
    // 链身份在 begin 后固化：人类消息可能在本审查在途时重置链。
    const epoch = tracker.epochOf(sessionId)
    // 末轮全量：链内触达文件多于本轮取材结果时才值得全量复审；每条链只做一次。
    const chainFiles = chain.filesOf(sessionId, epoch)
    const fullRound = resolved.fullReview
      && rounds >= resolved.maxRounds
      && chainFiles.length > collected.files.length
      && !chain.isFull(sessionId, epoch)
    const filesForReview = fullRound ? chainFiles : collected.files
    const journalKey = journal.start({
      sessionId,
      turn: summary.turn,
      seq,
      mode: fullRound ? 'full' : 'turn',
      files: filesForReview.length,
    })
    journalKeys.set(sessionId, journalKey)

    // 抑制记忆：profile 配置 + 仓库内 .dsh 文件；读取失败只 warn，不影响审查。
    const cwd = agent.session?.header?.cwd
    const suppressions = await loadSuppressions({
      config: resolved,
      cwd,
      warn: (text) => ctx.logger.warn(text),
    })

    // 启动阶段也要有界、可取消：独立控制信号，disposed/插件卸载会 abort 它。
    const control = new AbortController()
    starting.set(sessionId, control)

    let handle
    let startupTimer
    let composed
    let evidenceContext
    try {
      const loaded = await getRules()
      // 规则表、白名单、severity 权威表都按本次实际送审的文件过滤。
      composed = composeRules({ ...loaded, filePaths: filesForReview.map((file) => file.path) })
      evidenceContext = await buildEvidenceContext(agent, filesForReview, fullRound, collected)
      // 总预算从 handler 开始计：取材/读规则花掉的时间会挤占启动与审查的时间。
      const budget = Math.max(1, resolved.asyncReviewerTimeoutMs - (Date.now() - startedAt))
      const startupTimedOut = Symbol('startup-timeout')
      const deadline = new Promise((resolve) => {
        startupTimer = setTimeout(() => resolve(startupTimedOut), budget)
      })
      const prompt = fullRound
        ? buildFullPrompt({
            rulesPrompt: composed.prompt,
            files: filesForReview,
            knownFindings: lastFindings.get(sessionId) ?? [],
          })
        : buildPrompt({ rulesPrompt: composed.prompt, files: collected.files, skipped: collected.skipped })
      const startup = startReview({
        subagents: ctx.subagents,
        agent,
        preset: resolved.reviewerPreset,
        prompt,
        signal: control.signal,
        modelOverride: resolved.modelOverride,
        allowedRuleIds: composed.allowedRuleIds,
        allowedPaths: new Set(filesForReview.map((file) => file.path)),
        ruleSeverities: composed.ruleSeverities,
        logger: ctx.logger,
        evidenceContext,
        evidenceMode: resolved.evidenceMode,
        coverageMode: resolved.coverageMode,
      })
      // 超时返回后 startReview 的迟到 reject 不得变成 unhandled rejection。
      startup.catch(() => {})
      const started = await Promise.race([startup, deadline])
      if (started === startupTimedOut) {
        control.abort()
        // 启动期间会话被释放/插件卸载：静默丢弃，不记失败。
        if (lifetime.signal.aborted || (generations.get(sessionId) ?? 0) !== generation) {
          ctx.logger.debug?.(`[code-review] drop: session ${sessionId} 的启动已失效`)
          return
        }
        ctx.logger.debug?.('[code-review] start timeout')
        journalKeys.delete(sessionId)
        journal.settle(journalKey, { status: 'timeout', reason: 'timeout' })
        ctx.logger.debug?.('[code-review] review failed: timeout')
        if (tracker.recordFailure(sessionId)) {
          ctx.logger.warn('[code-review] 连续失败，已暂停本会话的自动审查')
        }
        // 启动失败不消耗链预算。
        tracker.releaseRound(sessionId)
        tracker.end(sessionId)
        return
      }
      handle = started
    } catch (error) {
      // 启动期间会话被释放/插件卸载：不算失败，也不碰可能已重建的新链状态。
      if (lifetime.signal.aborted || (generations.get(sessionId) ?? 0) !== generation) return
      // 启动失败由这里记一次失败并释放锁；不占用 inflight 表。
      journalKeys.delete(sessionId)
      journal.settle(journalKey, { status: 'failed', reason: 'start-failed' })
      ctx.logger.debug?.(`[code-review] start failed: ${error.message}`)
      if (tracker.recordFailure(sessionId)) {
        ctx.logger.warn('[code-review] 连续失败，已暂停本会话的自动审查')
      }
      tracker.releaseRound(sessionId)
      tracker.end(sessionId)
      return
    } finally {
      clearTimeout(startupTimer)
      // disposed/新一代可能已覆盖这条记录，只删自己。
      if (starting.get(sessionId) === control) starting.delete(sessionId)
    }

    // 启动期间会话被释放/插件卸载：拿到 activation 后立刻取消，不留下后台定时器。
    if ((generations.get(sessionId) ?? 0) !== generation || lifetime.signal.aborted) {
      handle.cancel(lifetime.signal.aborted ? 'plugin-disposed' : 'session-disposed')
      return
    }

    inflight.set(sessionId, handle)
    // 启动花掉的时间从总预算里扣，保证「启动 + 审查」不超过 asyncReviewerTimeoutMs。
    const reviewBudget = Math.max(1, resolved.asyncReviewerTimeoutMs - (Date.now() - startedAt))
    const timer = setTimeout(() => handle.cancel('timeout'), reviewBudget)
    const meta = {
      agent, summary, collected, hash, rounds, epoch, generation, fullRound, journalKey,
      startedAt, timer, composed, suppressions, filesForReview, evidenceContext,
    }

    // 后台结算：handler 到这里就返回，不等待审查结果。
    void handle.result
      .then((outcome) => settle(sessionId, handle, meta, outcome))
      .catch((error) => ctx.logger.warn(`[code-review] settle crashed: ${error.message}`))
  })

  ctx.logger.info(`[code-review] loaded preset=${resolved.reviewerPreset} maxRounds=${resolved.maxRounds}`)
}
