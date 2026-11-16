/**
 * @module @liyuera/dsh-mr-loop/host/parse-gates
 *
 * 两类门禁 note 的解析。只认自己的模板；任何认不出的形状返回 unknown，
 * 由调用方按 fail-closed 处理（unknown ≠ pass）。
 * raw 保留原文前 200 字，供报告取证，不参与任何判定。
 */
const RAW_LIMIT = 200

const CONCLUSION_RE = /^\s*(?:\*\*)?结论(?:\*\*)?\s*[:：]\s*(.*)$/m
const TOTAL_RE = /共\s*(\d+)\s*条命中/
const WAIVED_RE = /历史豁免\s*(\d+)\s*条/
const EFFECTIVE_RE = /当前有效\s*(\d+)\s*条/
const BLOCKING_RE = /阻断项\s*[:：]\s*(\d+)\s*条/

const conclusionOf = (body) => {
  const match = CONCLUSION_RE.exec(body)
  if (!match) return null
  return match[1].replace(/\*\*/g, '').trim()
}

const verdictOf = (body, passText, blockText) => {
  const value = conclusionOf(body)
  if (value === null) return 'unknown'
  if (value.startsWith(passText)) return 'pass'
  if (value.startsWith(blockText)) return 'block'
  return 'unknown'
}

const numberAfter = (body, pattern) => {
  const match = pattern.exec(body)
  if (!match) return null
  const value = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(value) ? value : null
}

/**
 * 敏感门禁的判定顺序（新模板不是 unknown）：
 * 1. 结论直接写「门禁通过」/「阻止合并」——旧模板，最高优先。
 * 2. 结论写「发现敏感信息风险」——标题只报告风险，正文的「门禁通过」才是结论。
 * 3. 新模板下正文没有「门禁通过」时，只有阻断项 > 0 或当前有效 > 0 才判 block；
 *    两个数字都缺失或为 0 时保持 unknown（不猜）。
 * 4. 其它形状一律 unknown。
 */
const sensitiveVerdict = (body) => {
  const value = conclusionOf(body)
  if (value === null) return 'unknown'
  if (value.startsWith('门禁通过')) return 'pass'
  if (value.startsWith('阻止合并')) return 'block'
  if (!value.startsWith('发现敏感信息风险')) return 'unknown'
  if (body.includes('门禁通过')) return 'pass'
  if ((numberAfter(body, BLOCKING_RE) ?? 0) > 0) return 'block'
  if ((numberAfter(body, EFFECTIVE_RE) ?? 0) > 0) return 'block'
  return 'unknown'
}

const rawOf = (body) => String(body ?? '').trim().slice(0, RAW_LIMIT)

/**
 * @param {string} body GitLab note markdown
 * @returns {{ verdict: 'pass'|'block'|'unknown', total: number|null, waived: number|null, effective: number|null, blocking: number|null, raw: string }}
 */
export function parseSensitiveGate(body) {
  const text = String(body ?? '')
  return {
    verdict: sensitiveVerdict(text),
    total: numberAfter(text, TOTAL_RE),
    waived: numberAfter(text, WAIVED_RE),
    effective: numberAfter(text, EFFECTIVE_RE),
    blocking: numberAfter(text, BLOCKING_RE),
    raw: rawOf(text),
  }
}

const subItem = (body, label) => {
  const pattern = new RegExp(`${label}\\s*[:：]\\s*([^；;\\n]+)`)
  const match = pattern.exec(String(body ?? ''))
  return match ? match[1].replace(/\*\*/g, '').trim() : null
}

/**
 * @param {string} body GitLab note markdown
 * @returns {{ verdict: 'pass'|'block'|'unknown', items: { sensitive: string|null, review: string|null, evidence: string|null }, raw: string }}
 */
export function parseMandatoryGate(body) {
  const text = String(body ?? '')
  return {
    verdict: verdictOf(text, '通过', '阻止合并'),
    items: {
      sensitive: subItem(text, '敏感信息门禁'),
      review: subItem(text, 'AI 代码评审'),
      evidence: subItem(text, 'AI 评审证据检查'),
    },
    raw: rawOf(text),
  }
}
