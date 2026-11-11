/**
 * 证伪型复验：对阻塞级 finding 各起一个独立只读子代理，任务是**推翻**它。
 *
 * 判定语义（借鉴 dsh-review / @stardustlc 的对抗式复核）：
 * - confirmed=true 且理由足够长 → 保留，可参与修复；
 * - confirmed=false（明确反驳）→ 丢弃；
 * - 超时/失败/输出不可解析 → 视为未证实，保留为「仅报告」，不触发修复。
 * @module @liyuera/dsh-code-review/host/verify
 */
import { SEVERITY_RANK } from './render.js'

export const VERDICT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    confirmed: { type: 'boolean' },
    reason: { type: 'string' },
    witnesses: { type: 'array', items: { type: 'string' } },
  },
  required: ['confirmed', 'reason'],
  additionalProperties: false,
})

const MIN_REASON_LENGTH = 12

/**
 * 组装复验 prompt：只给 finding 与文件清单，不给首轮推理过程。
 * @param {{finding: object, files: readonly {path:string}[]}} input
 * @returns {string}
 */
export function buildVerifyPrompt({ finding, files }) {
  const evidence = typeof finding.evidence === 'object' && finding.evidence !== null
    ? finding.evidence.snippet
    : finding.evidence
  return [
    '## 任务：证伪一条代码审查 finding',
    '有人报告了下面的问题。你的任务是尝试**推翻它**，不是附和。'
      + '默认 confirmed:false，只有尝试证伪失败后才确认。',
    '',
    '## 待复核 finding',
    `- ruleId: ${finding.ruleId}`,
    `- location: ${finding.location}`,
    `- problem: ${finding.problem}`,
    `- suggestion: ${finding.suggestion}`,
    ...(typeof evidence === 'string' && evidence.length > 0 ? [`- evidence.snippet: ${evidence}`] : []),
    '',
    '## 送审文件（用只读工具核实，不要修改任何文件）',
    ...files.map((file) => `- ${file.path}`),
    '',
    '## 判定要求',
    '- 检查：引用的代码是否真实存在且可达？声称的输入/状态是否真的会发生？'
      + '是否已有别的保护阻止故障？',
    '- 能复现就复现；不能复现时必须给出具体反驳理由（代码/行号/保护逻辑）。',
    '- 不得提出修复方案，不得修改文件。',
    '只返回 JSON：{"confirmed":true|false,"reason":"...","witnesses":["..."]}；'
      + '不要在最终文本里输出 JSON。',
  ].join('\n')
}

/**
 * 校验一条复验结论。
 * @param {unknown} structured
 * @returns {'confirmed'|'rejected'|undefined}
 */
function verdictOf(structured) {
  if (typeof structured !== 'object' || structured === null) return undefined
  if (typeof structured.confirmed !== 'boolean') return undefined
  if (typeof structured.reason !== 'string' || structured.reason.trim().length < MIN_REASON_LENGTH) return undefined
  return structured.confirmed ? 'confirmed' : 'rejected'
}

/**
 * 跑一次复验 activation；任何失败都返回 undefined（调用方视为未证实）。
 * @returns {Promise<'confirmed'|'rejected'|undefined>}
 */
async function runVerdict({
  subagents, agent, preset, prompt, timeoutMs, signal, modelOverride,
}) {
  if (signal?.aborted) return undefined
  const controller = new AbortController()
  let activation
  let timedOut = false
  let aborted = false
  const deadlineSymbol = { timedOut: true }
  const abortSymbol = { aborted: true }
  let notifyAbort
  const abortPromise = new Promise((resolve) => { notifyAbort = resolve })
  const onAbort = () => {
    aborted = true
    controller.abort()
    notifyAbort(abortSymbol)
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(deadlineSymbol), timeoutMs)
  })
  try {
    const starting = Promise.resolve(subagents.startActivation({
      provider: 'spawn',
      label: 'code-review-verify',
      delivery: 'caller',
      signal: controller.signal,
      request: {
        parent: agent,
        agentPreset: preset,
        outputSchema: VERDICT_SCHEMA,
        ...(modelOverride === undefined ? {} : { agentOptions: modelOverride }),
        prompt: [{ type: 'text', text: prompt }],
      },
    }))
    // abort/deadline 可能在 startActivation 仍未返回时先赢得 race；迟到的 activation
    // 也必须 dispose，并观察 result 避免未处理拒绝。
    starting.then(
      (value) => {
        if (!timedOut && !aborted) return
        try {
          void Promise.resolve(value?.dispose?.()).catch(() => {})
        } catch {}
        try {
          void Promise.resolve(value?.result).catch(() => {})
        } catch {}
      },
      () => {},
    )
    const started = await Promise.race([starting, deadline, abortPromise])
    if (started === deadlineSymbol) {
      timedOut = true
      return undefined
    }
    if (started === abortSymbol) {
      aborted = true
      return undefined
    }
    activation = started
    const settled = await Promise.race([
      Promise.resolve(activation.result).then((value) => ({ value })),
      deadline,
      abortPromise,
    ])
    if (settled === deadlineSymbol) {
      timedOut = true
      return undefined
    }
    if (settled === abortSymbol) {
      aborted = true
      return undefined
    }
    if (settled.value?.stopReason !== 'completed') return undefined
    return verdictOf(settled.value.structured)
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (timedOut || aborted) {
      controller.abort()
      try {
        void Promise.resolve(activation?.dispose?.()).catch(() => {})
      } catch {}
    }
  }
}

/**
 * 对阻塞级 findings 逐条复验。
 *
 * @param {object} input
 * @param {object} input.subagents
 * @param {object} input.agent
 * @param {string} input.preset
 * @param {readonly object[]} input.findings 已带 blocking/evidenceStatus 的 findings
 * @param {readonly {path:string}[]} input.files 送审文件清单
 * @param {readonly string[]} input.blockingSeverities
 * @param {number} [input.maxFindings]
 * @param {number} [input.timeoutMs]
 * @param {AbortSignal} [input.signal]
 * @param {object} [input.modelOverride]
 * @param {object} [input.logger]
 * @returns {Promise<{verdicts: Map<number, 'confirmed'|'rejected'|'unverified'>, checked:number, confirmed:number, rejected:number, unverified:number}>}
 */
export async function verifyFindings({
  subagents, agent, preset, findings, files, blockingSeverities,
  maxFindings = 3, timeoutMs = 180000, signal, modelOverride, logger,
}) {
  const verdicts = new Map()
  const blockingSet = new Set(blockingSeverities)
  const candidates = findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => blockingSet.has(finding.severity)
      && finding.blocking !== false
      && finding.evidenceStatus === 'ok')
    .sort((left, right) => (SEVERITY_RANK[left.finding.severity] ?? Number.MAX_SAFE_INTEGER)
      - (SEVERITY_RANK[right.finding.severity] ?? Number.MAX_SAFE_INTEGER))
    .slice(0, maxFindings)
  if (candidates.length === 0 || subagents === undefined) {
    return { verdicts, checked: 0, confirmed: 0, rejected: 0, unverified: 0 }
  }
  const deadline = Date.now() + timeoutMs
  let confirmed = 0
  let rejected = 0
  let unverified = 0
  for (const candidate of candidates) {
    const remaining = deadline - Date.now()
    if (signal?.aborted || remaining <= 0) {
      verdicts.set(candidate.index, 'unverified')
      unverified += 1
      continue
    }
    const verdict = await runVerdict({
      subagents,
      agent,
      preset,
      prompt: buildVerifyPrompt({ finding: candidate.finding, files }),
      timeoutMs: remaining,
      signal,
      modelOverride,
    })
    if (verdict === 'confirmed') confirmed += 1
    else if (verdict === 'rejected') rejected += 1
    else unverified += 1
    verdicts.set(candidate.index, verdict ?? 'unverified')
  }
  logger?.debug?.('[code-review] verification confirmed=%d rejected=%d unverified=%d', confirmed, rejected, unverified)
  return { verdicts, checked: candidates.length, confirmed, rejected, unverified }
}

/**
 * 把复验结论合并回 findings：rejected 丢弃，unverified 标 `verified:'unverified'`，
 * confirmed 标 `verified:'confirmed'`。
 * @param {readonly object[]} findings
 * @param {Map<number, string>} verdicts
 * @returns {object[]}
 */
export function applyVerification(findings, verdicts) {
  const merged = []
  findings.forEach((finding, index) => {
    const verdict = verdicts.get(index)
    if (verdict === 'rejected') return
    if (verdict === 'unverified') merged.push({ ...finding, verified: 'unverified' })
    else if (verdict === 'confirmed') merged.push({ ...finding, verified: 'confirmed' })
    else merged.push(finding)
  })
  return merged
}
