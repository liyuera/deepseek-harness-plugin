/**
 * @module @liyuera/dsh-mr-loop/host/parse-gates
 *
 * 两类门禁 note 的解析。只认自己的模板；任何认不出的形状返回 unknown，
 * 由调用方按 fail-closed 处理（unknown ≠ pass）。
 * raw 保留原文前 200 字，供报告取证，不参与任何判定。
 */
const RAW_LIMIT = 200

const verdictOf = (body, passText, blockText) => {
  const match = /^\s*(?:\*\*)?结论(?:\*\*)?\s*[:：]\s*(.*)$/m.exec(body)
  if (!match) return 'unknown'
  const value = match[1].replace(/\*\*/g, '').trim()
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

const rawOf = (body) => String(body ?? '').trim().slice(0, RAW_LIMIT)

/**
 * @param {string} body GitLab note markdown
 * @returns {{ verdict: 'pass'|'block'|'unknown', total: number|null, waived: number|null, effective: number|null, blocking: number|null, raw: string }}
 */
export function parseSensitiveGate(body) {
  const text = String(body ?? '')
  const verdict = verdictOf(text, '门禁通过', '阻止合并')
  return {
    verdict,
    total: numberAfter(text, /共\s*(\d+)\s*条命中/),
    waived: numberAfter(text, /历史豁免\s*(\d+)\s*条/),
    effective: numberAfter(text, /当前有效\s*(\d+)\s*条/),
    blocking: numberAfter(text, /阻断项\s*[:：]\s*(\d+)\s*条/),
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
