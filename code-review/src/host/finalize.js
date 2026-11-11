/**
 * 审查结果收口：证据状态 → 修复策略 → 抑制 → 复验，产出可直接渲染/留痕的 findings。
 * 自动审查与 `/review` 共用同一条路径，保证两边口径一致。
 * @module @liyuera/dsh-code-review/host/finalize
 */
import { decorateFindings } from './fixmode.js'
import { applySuppressions, fingerprintFinding } from './suppress.js'
import { applyVerification, verifyFindings } from './verify.js'

/**
 * @param {object} input
 * @param {readonly object[]} input.findings reviewer 校验后的 findings
 * @param {readonly string[]} [input.evidence] 与 findings 对齐的证据状态
 * @param {Map<string,string>} [input.ruleFixModes]
 * @param {Map<string,boolean>} [input.ruleBlocking]
 * @param {object} input.config 已解析配置（允许来自测试的部分字段）
 * @param {readonly object[]} [input.suppressions]
 * @param {readonly {path:string}[]} [input.files]
 * @param {object} [input.subagents]
 * @param {object} [input.agent]
 * @param {string} [input.preset]
 * @param {AbortSignal} [input.signal]
 * @param {object} [input.logger]
 * @param {object} [input.modelOverride]
 * @returns {Promise<{findings: object[], suppressed: object[], verification: {checked:number,confirmed:number,rejected:number,unverified:number}}>}
 */
export async function finalizeFindings({
  findings, evidence = [], ruleFixModes, ruleBlocking, config = {},
  suppressions = [], files = [], subagents, agent, preset, signal, logger, modelOverride,
}) {
  const decorated = decorateFindings(findings, {
    ruleFixModes, ruleBlocking, config, evidence,
  }).map((finding) => ({ ...finding, fingerprint: fingerprintFinding(finding) }))
  const { kept, suppressed } = applySuppressions(decorated, suppressions)

  let verification = { checked: 0, confirmed: 0, rejected: 0, unverified: 0 }
  if (config.verify === 'blocking' && subagents !== undefined) {
    const result = await verifyFindings({
      subagents,
      agent,
      preset,
      findings: kept,
      files,
      blockingSeverities: config.blockingSeverities ?? ['high', 'medium'],
      maxFindings: config.maxVerifiedFindings ?? 3,
      timeoutMs: config.verifyTimeoutMs ?? 180000,
      signal,
      modelOverride,
      logger,
    })
    verification = {
      checked: result.checked,
      confirmed: result.confirmed,
      rejected: result.rejected,
      unverified: result.unverified,
    }
    return { findings: applyVerification(kept, result.verdicts), suppressed, verification }
  }
  return { findings: kept, suppressed, verification }
}
