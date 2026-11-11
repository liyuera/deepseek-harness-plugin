/**
 * 规范层：加载并校验两层规范（原则 + 硬规则），渲染成审查者 prompt 片段。
 *
 * v3 起硬规则支持可选 `sourceId`（外部规范编号）与 `scope`（按变更文件过滤），
 * 并支持按顺序合并可插拔的规则包；单个包失败只跳过该包（fail-open）。
 * @module @liyuera/dsh-code-review/host/rules
 */
import { readFile as readFileDefault } from 'node:fs/promises'
import { filterRulesForFiles } from './scope.js'

const PREFIX_BY_DIMENSION = Object.freeze({
  correctness: 'COR',
  security: 'SEC',
  performance: 'PRF',
  maintainability: 'MNT',
  behavior: 'BEH',
})
const SEVERITIES = new Set(['high', 'medium', 'low', 'nit'])
const FIELDS = ['id', 'dimension', 'severity', 'title', 'check', 'bad', 'good']
const SCOPE_KEYS = ['extensions', 'globs']

/** 原则层没有硬规则 id，finding 可引用这组固定 id。 */
export const PRINCIPLE_IDS = Object.freeze([
  'PRINCIPLE-correctness',
  'PRINCIPLE-security',
  'PRINCIPLE-performance',
  'PRINCIPLE-maintainability',
  'PRINCIPLE-behavior',
])

/**
 * 校验可选的 `scope`：只允许 extensions/globs，元素为非空字符串，extensions 以 `.` 开头，
 * 且至少有一个非空数组。
 * @param {object} rule
 */
function validateScope(rule) {
  const { scope } = rule
  if (scope === undefined) return
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new Error(`code-review: rule "${rule.id}" scope must be an object`)
  }
  for (const key of Object.keys(scope)) {
    if (!SCOPE_KEYS.includes(key)) {
      throw new Error(`code-review: rule "${rule.id}" scope has unknown key "${key}"`)
    }
  }
  let nonEmptyArrays = 0
  for (const key of SCOPE_KEYS) {
    const entries = scope[key]
    if (entries === undefined) continue
    if (!Array.isArray(entries)) {
      throw new Error(`code-review: rule "${rule.id}" scope.${key} must be an array`)
    }
    if (entries.length > 0) nonEmptyArrays += 1
    for (const entry of entries) {
      if (typeof entry !== 'string' || entry.length === 0) {
        throw new Error(`code-review: rule "${rule.id}" scope.${key} entries must be non-empty strings`)
      }
      if (key === 'extensions' && !entry.startsWith('.')) {
        throw new Error(`code-review: rule "${rule.id}" scope.extensions entries must start with "."`)
      }
    }
  }
  if (nonEmptyArrays === 0) {
    throw new Error(`code-review: rule "${rule.id}" scope must have at least one non-empty array`)
  }
}

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
    if (rule.sourceId !== undefined && (typeof rule.sourceId !== 'string' || rule.sourceId.length === 0)) {
      throw new Error(`code-review: rule "${rule.id}" sourceId must be a non-empty string`)
    }
    validateScope(rule)
  }
}

/**
 * 从磁盘加载两层规范（基础规则 + 原则）。
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
 * 读取并解析一个规则包文件。
 * @param {string} packPath
 * @param {Function} readFile
 * @returns {Promise<unknown>}
 */
async function loadPack(packPath, readFile) {
  let raw
  try {
    raw = await readFile(packPath, 'utf8')
  } catch (error) {
    throw new Error(`cannot read rules pack ${packPath}: ${error.message}`)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`rules pack ${packPath} is not valid JSON: ${error.message}`)
  }
}

/**
 * 渲染成审查者 prompt 的一段文本。规则表每行带 `[sourceId]`（如有）；
 * `rules` 为空时退化为「只按原则审」，原则层始终保留。
 * @param {{rules: readonly object[], principles: string}} input
 * @returns {string}
 */
export function renderRulesPrompt({ rules, principles }) {
  const sections = [
    '## 原则（先读，用于判断长尾问题）',
    principles.trim(),
    '',
  ]
  if (rules.length === 0) {
    sections.push(
      '## 硬规则',
      '本轮没有适用的硬规则，只按原则审。findings 仍可引用 PRINCIPLE-<dimension>。',
    )
  } else {
    const table = rules
      .map((rule) => {
        const source = typeof rule.sourceId === 'string' && rule.sourceId.length > 0
          ? ` [${rule.sourceId}]`
          : ''
        return [
          `### ${rule.id} · ${rule.dimension} · ${rule.severity} ·${source} ${rule.title}`,
          `检查条件：${rule.check}`,
          `反例：${rule.bad}`,
          `正例：${rule.good}`,
        ].join('\n')
      })
      .join('\n\n')
    sections.push('## 硬规则（逐条核对，finding 必须引用下列 id 之一）', table)
  }
  return sections.join('\n')
}

/**
 * 按本次变更文件过滤规则，再一次性产出审查者需要的三样东西：
 * prompt 里的规则表、`allowedRuleIds` 白名单、`ruleSeverities` 权威表。
 * 三者来自同一份过滤结果，保证不适用规则的 id 不会被接受。
 * @param {{rules: readonly object[], principles: string, filePaths?: readonly (string|{path?: string})[]}} input
 * @returns {{prompt: string, allowedRuleIds: Set<string>, ruleSeverities: Map<string, string>}}
 */
export function composeRules({ rules, principles, filePaths = [] }) {
  const applicable = filterRulesForFiles(rules, filePaths)
  return {
    prompt: renderRulesPrompt({ rules: applicable, principles }),
    allowedRuleIds: new Set([...applicable.map((rule) => rule.id), ...PRINCIPLE_IDS]),
    ruleSeverities: new Map(applicable.map((rule) => [rule.id, rule.severity])),
  }
}

/**
 * 每轮从磁盘加载规范；基础规则文件不可用时降级为只用原则层（fail-open），
 * 原则文件也读不到时抛错，由调用方决定如何记录。
 *
 * 规则包按 `packs` 顺序加载并合并；单个包读不到/JSON 非法/校验失败/与已加载规则
 * id 重复时记一次警告并整包跳过，基础规则不受影响。基础规则自身失败时降级为
 * 「只用原则层」，不再加载规则包（§8.3 / §18.3）。
 *
 * @param {{rulesPath:string, principlesPath:string, packs?: readonly string[], warn?:Function, readFile?:Function}} input
 * @returns {Promise<{rules: object[], principles: string}>}
 */
export async function loadRulesResilient({
  rulesPath,
  principlesPath,
  packs = [],
  warn,
  readFile = readFileDefault,
}) {
  let base
  try {
    base = await loadRules({ rulesPath, principlesPath, readFile })
  } catch (error) {
    warn?.(`[code-review] 规则文件不可用，降级为只用原则层：${error.message}`)
    return { rules: [], principles: await readFile(principlesPath, 'utf8') }
  }

  const rules = [...base.rules]
  const seen = new Set(rules.map((rule) => rule.id))
  for (const packPath of packs) {
    try {
      const parsed = await loadPack(packPath, readFile)
      validateRules(parsed)
      const duplicate = parsed.find((rule) => seen.has(rule.id))
      if (duplicate !== undefined) {
        throw new Error(`duplicate rule id "${duplicate.id}"`)
      }
      for (const rule of parsed) {
        seen.add(rule.id)
        rules.push(rule)
      }
    } catch (error) {
      warn?.(`[code-review] 规则包 ${packPath} 不可用，已跳过：${error.message}`)
    }
  }
  return { rules, principles: base.principles }
}
