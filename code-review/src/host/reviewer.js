/**
 * 审查者：把一个只读子代理跑成一次「diff 进、findings 出」的调用。
 * @module @liyuera/dsh-code-review/host/reviewer
 */

/** 审查者必须返回的结构。verdict 由插件推导，不由模型给。 */
export const REVIEW_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ruleId: { type: 'string' },
          dimension: { type: 'string', enum: ['correctness', 'security', 'performance', 'maintainability'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low', 'nit'] },
          location: { type: 'string' },
          problem: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['ruleId', 'dimension', 'severity', 'location', 'problem', 'suggestion'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
})

const DIMENSIONS = new Set(['correctness', 'security', 'performance', 'maintainability'])
const SEVERITIES = new Set(['high', 'medium', 'low', 'nit'])

/**
 * 组装审查者 prompt。
 * @param {{rulesPrompt: string, files: readonly object[], skipped: readonly {path:string,reason:string}[]}} input
 * @returns {string}
 */
export function buildPrompt({ rulesPrompt, files, skipped }) {
  const listing = files.map((file) => `- ${file.display}（+${file.added} / -${file.deleted}）`).join('\n')
  const diffs = files.map((file) => `### ${file.display}\n\`\`\`diff\n${file.text}\n\`\`\``).join('\n\n')
  const unread = skipped.length > 0
    ? `未审文件（不要猜测其内容）：${skipped.map((item) => `${item.path}（${item.reason}）`).join('、')}`
    : ''
  return [
    rulesPrompt,
    '',
    '## 待审变更',
    listing,
    unread,
    '',
    '## Diff',
    diffs,
    '',
    '## 输出要求',
    '只返回 JSON，形状为 {"findings":[{"ruleId","dimension","severity","location","problem","suggestion"}]}。',
    'ruleId 必须是上文硬规则里的 id，长尾问题用 PRINCIPLE-<dimension>；location 必须是 `路径:行号` 且落在本次 diff 的文件内。',
    '只报确有把握的问题；没有问题时返回 {"findings":[]}。不要调用任何工具。',
  ].filter((line) => line !== '').join('\n')
}

function normalizeFinding(finding, allowedRuleIds, allowedPaths) {
  if (typeof finding !== 'object' || finding === null) return undefined
  const { ruleId, dimension, severity, location, problem, suggestion } = finding
  const strings = [ruleId, dimension, severity, location, problem, suggestion]
  if (!strings.every((value) => typeof value === 'string' && value.length > 0)) return undefined
  if (!DIMENSIONS.has(dimension) || !SEVERITIES.has(severity)) return undefined
  const principled = ruleId.startsWith('PRINCIPLE-') && allowedRuleIds.has(`PRINCIPLE-${dimension}`)
  if (!allowedRuleIds.has(ruleId) && !principled) return undefined
  const path = location.split(':')[0]
  if (!allowedPaths.has(path)) return undefined
  return { ruleId, dimension, severity, location, problem, suggestion }
}

/**
 * 跑一次审查。
 * @param {object} input
 * @returns {Promise<{ok:true, findings: object[]} | {ok:false, reason: string}>}
 */
export async function runReview({
  subagents, agent, preset, prompt, timeoutMs, modelOverride, signal, allowedRuleIds, allowedPaths,
}) {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  let activation
  try {
    activation = await subagents.startActivation({
      provider: 'spawn',
      label: 'code-review',
      delivery: 'caller',
      signal: controller.signal,
      request: {
        parent: agent,
        agentPreset: preset,
        outputSchema: REVIEW_SCHEMA,
        ...(modelOverride === undefined ? {} : { agentOptions: modelOverride }),
        prompt: [{ type: 'text', text: prompt }],
      },
    })
  } catch {
    signal?.removeEventListener('abort', onAbort)
    return { ok: false, reason: 'provider-error' }
  }

  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
  })
  let outcome
  try {
    outcome = await Promise.race([activation.result.then((value) => ({ value })), timeout])
  } catch {
    return { ok: false, reason: 'provider-error' }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }

  if (outcome.timedOut === true) {
    controller.abort()
    await activation.dispose?.().catch(() => {})
    return { ok: false, reason: 'timeout' }
  }
  const result = outcome.value
  if (result?.stopReason !== 'completed' || result.structured === undefined) {
    return { ok: false, reason: 'incomplete' }
  }
  const raw = result.structured
  if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.findings)) {
    return { ok: false, reason: 'invalid-result' }
  }
  const findings = raw.findings
    .map((finding) => normalizeFinding(finding, allowedRuleIds, allowedPaths))
    .filter((finding) => finding !== undefined)
  return { ok: true, findings }
}
