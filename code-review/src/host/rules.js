/**
 * 规范层：加载并校验两层规范（原则 + 硬规则），渲染成审查者 prompt 片段。
 * @module @liyuera/dsh-code-review/host/rules
 */
import { readFile as readFileDefault } from 'node:fs/promises'

const PREFIX_BY_DIMENSION = Object.freeze({
  correctness: 'COR',
  security: 'SEC',
  performance: 'PRF',
  maintainability: 'MNT',
})
const SEVERITIES = new Set(['high', 'medium', 'low', 'nit'])
const FIELDS = ['id', 'dimension', 'severity', 'title', 'check', 'bad', 'good']

/** 原则层没有硬规则 id，finding 可引用这组固定 id。 */
export const PRINCIPLE_IDS = Object.freeze([
  'PRINCIPLE-correctness',
  'PRINCIPLE-security',
  'PRINCIPLE-performance',
  'PRINCIPLE-maintainability',
])

/**
 * 校验规则表。任何不合法都抛错——规范是产品的一部分，不静默降级。
 * @param {readonly object[]} rules
 */
export function validateRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('code-review: rules must be a non-empty array')
  }
  const seen = new Set()
  for (const rule of rules) {
    for (const field of FIELDS) {
      if (typeof rule?.[field] !== 'string' || rule[field].length === 0) {
        throw new Error(`code-review: rule "${rule?.id ?? '?'}" is missing "${field}"`)
      }
    }
    if (seen.has(rule.id)) throw new Error(`code-review: duplicate rule id "${rule.id}"`)
    seen.add(rule.id)
    const prefix = PREFIX_BY_DIMENSION[rule.dimension]
    if (prefix === undefined) {
      throw new Error(`code-review: rule "${rule.id}" has invalid dimension "${rule.dimension}"`)
    }
    if (!rule.id.startsWith(`${prefix}-`)) {
      throw new Error(`code-review: rule "${rule.id}" prefix does not match dimension "${rule.dimension}"`)
    }
    if (!SEVERITIES.has(rule.severity)) {
      throw new Error(`code-review: rule "${rule.id}" has invalid severity "${rule.severity}"`)
    }
  }
}

/**
 * 从磁盘加载两层规范。
 * @param {{rulesPath:string, principlesPath:string, readFile?:Function}} input
 * @returns {Promise<{rules: object[], principles: string}>}
 */
export async function loadRules({ rulesPath, principlesPath, readFile = readFileDefault }) {
  let rawRules
  try {
    rawRules = await readFile(rulesPath, 'utf8')
  } catch (error) {
    throw new Error(`code-review: cannot read rules file ${rulesPath}: ${error.message}`)
  }
  let rules
  try {
    rules = JSON.parse(rawRules)
  } catch (error) {
    throw new Error(`code-review: rules file is not valid JSON: ${error.message}`)
  }
  validateRules(rules)
  const principles = await readFile(principlesPath, 'utf8')
  return { rules, principles }
}

/**
 * 渲染成审查者 prompt 的一段文本。
 * @param {{rules: readonly object[], principles: string}} input
 * @returns {string}
 */
export function renderRulesPrompt({ rules, principles }) {
  const table = rules
    .map((rule) => [
      `### ${rule.id} · ${rule.dimension} · ${rule.severity} · ${rule.title}`,
      `检查条件：${rule.check}`,
      `反例：${rule.bad}`,
      `正例：${rule.good}`,
    ].join('\n'))
    .join('\n\n')
  return [
    '## 原则（先读，用于判断长尾问题）',
    principles.trim(),
    '',
    '## 硬规则（逐条核对，finding 必须引用下列 id 之一）',
    table,
  ].join('\n')
}

/**
 * 每轮从磁盘加载规范；规则文件不可用时降级为只用原则层（fail-open）。
 * 原则文件也读不到时抛错，由调用方决定如何记录。
 *
 * `ruleSeverities` 是硬规则 severity 的权威表：审查者的 finding severity 以它为准，
 * 防止模型把 high 规则报成 low 而静默不阻塞。
 * @param {{rulesPath:string, principlesPath:string, warn?:Function, readFile?:Function}} input
 * @returns {Promise<{prompt: string, allowedRuleIds: Set<string>, ruleSeverities: Map<string, string>}>}
 */
export async function loadRulesResilient({ rulesPath, principlesPath, warn, readFile = readFileDefault }) {
  try {
    const loaded = await loadRules({ rulesPath, principlesPath, readFile })
    return {
      prompt: renderRulesPrompt(loaded),
      allowedRuleIds: new Set([...loaded.rules.map((rule) => rule.id), ...PRINCIPLE_IDS]),
      ruleSeverities: new Map(loaded.rules.map((rule) => [rule.id, rule.severity])),
    }
  } catch (error) {
    warn?.(`[code-review] 规则文件不可用，降级为只用原则层：${error.message}`)
    return {
      prompt: await readFile(principlesPath, 'utf8'),
      allowedRuleIds: new Set(PRINCIPLE_IDS),
      ruleSeverities: new Map(),
    }
  }
}
