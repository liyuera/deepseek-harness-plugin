/**
 * 抑制记忆：让团队已经裁决过的问题（wontfix / false-positive / intentional /
 * accepted-risk）不再阻塞、不再触发修复轮，但仍在报告里可见。
 *
 * 配置来自两处，按顺序合并：profile config 的 `suppressions`，以及仓库内的
 * `.dsh/code-review-suppressions.json`（可提交到版本库，作为人工裁决的桥）。
 * @module @liyuera/dsh-code-review/host/suppress
 */
import { createHash } from 'node:crypto'
import { readFile as readFileDefault } from 'node:fs/promises'
import { resolve } from 'node:path'
import { locationPath } from './evidence.js'
import { matchGlob } from './scope.js'

export const DEFAULT_SUPPRESSIONS_FILE = '.dsh/code-review-suppressions.json'
const DISPOSITIONS = new Set(['wontfix', 'false-positive', 'intentional', 'accepted-risk'])
const MAX_FILE_BYTES = 65536

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * 校验抑制规则数组；任何不合法都抛错（配置是产品的一部分，不静默兜底）。
 * @param {unknown} raw
 * @returns {object[]}
 */
export function validateSuppressions(raw) {
  if (!Array.isArray(raw)) throw new Error('code-review: suppressions must be an array')
  const rules = []
  for (const [index, rule] of raw.entries()) {
    const label = `code-review: suppressions[${index}]`
    if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) {
      throw new Error(`${label} must be an object`)
    }
    for (const field of ['ruleId', 'pathGlob', 'key', 'fingerprint']) {
      if (rule[field] !== undefined && !nonEmptyString(rule[field])) {
        throw new Error(`${label}.${field} must be a non-empty string`)
      }
    }
    if (!nonEmptyString(rule.reason)) throw new Error(`${label}.reason must be a non-empty string`)
    if (!rule.fingerprint && !rule.ruleId && !rule.pathGlob && !rule.key) {
      throw new Error(`${label} needs at least one of fingerprint/ruleId/pathGlob/key`)
    }
    if (rule.disposition !== undefined && !DISPOSITIONS.has(rule.disposition)) {
      throw new Error(`${label}.disposition must be one of ${[...DISPOSITIONS].join(', ')}`)
    }
    if (rule.expiresAt !== undefined) {
      if (typeof rule.expiresAt !== 'string' || Number.isNaN(Date.parse(rule.expiresAt))) {
        throw new Error(`${label}.expiresAt must be an ISO date string`)
      }
    }
    rules.push(Object.freeze({
      ...(rule.id === undefined ? {} : { id: String(rule.id) }),
      ...(rule.fingerprint === undefined ? {} : { fingerprint: rule.fingerprint }),
      ...(rule.ruleId === undefined ? {} : { ruleId: rule.ruleId }),
      ...(rule.pathGlob === undefined ? {} : { pathGlob: rule.pathGlob }),
      ...(rule.key === undefined ? {} : { key: rule.key }),
      reason: rule.reason,
      ...(rule.disposition === undefined ? {} : { disposition: rule.disposition }),
      ...(rule.expiresAt === undefined ? {} : { expiresAt: rule.expiresAt }),
    }))
  }
  return Object.freeze(rules)
}

/**
 * finding 指纹：不含行号，重排/行漂移不产生新身份；取 16 位十六进制展示。
 * @param {object} finding
 * @returns {string}
 */
export function fingerprintFinding(finding) {
  const path = locationPath(finding.location)
  const problem = String(finding.problem ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  return createHash('sha256').update(`${finding.ruleId}\0${path}\0${problem}`).digest('hex').slice(0, 16)
}

/**
 * 一条 finding 是否命中一条抑制规则。
 * @param {object} rule
 * @param {object} finding
 * @param {number} now
 * @returns {boolean}
 */
export function suppressionMatches(rule, finding, now = Date.now()) {
  if (rule.expiresAt !== undefined && Date.parse(rule.expiresAt) <= now) return false
  if (rule.fingerprint !== undefined) return rule.fingerprint === finding.fingerprint
  const path = locationPath(finding.location)
  if (rule.ruleId !== undefined && rule.ruleId !== finding.ruleId) return false
  if (rule.pathGlob !== undefined && !matchGlob(rule.pathGlob, path)) return false
  if (rule.key !== undefined
    && !String(finding.problem ?? '').toLowerCase().includes(rule.key.toLowerCase())) return false
  return rule.ruleId !== undefined || rule.pathGlob !== undefined || rule.key !== undefined
}

/**
 * 应用抑制：返回保留的 findings 与被抑制清单（抑制不等于删除记录）。
 * @param {readonly object[]} findings 已带 fingerprint 的 findings
 * @param {readonly object[]} rules
 * @param {number} [now]
 * @returns {{kept: object[], suppressed: Array<{finding: object, reason: string, disposition?: string}>}}
 */
export function applySuppressions(findings, rules, now = Date.now()) {
  const kept = []
  const suppressed = []
  for (const finding of findings) {
    const matched = rules.find((rule) => suppressionMatches(rule, finding, now))
    if (matched === undefined) kept.push(finding)
    else suppressed.push({
      finding,
      reason: matched.reason,
      ...(matched.disposition === undefined ? {} : { disposition: matched.disposition }),
    })
  }
  return { kept, suppressed }
}

/**
 * 读取仓库内抑制文件并合并 config.suppressions。
 * 文件不存在/解析失败/no 权限时只 warn，不影响审查。
 * @param {object} input
 * @param {object} input.config 已解析配置
 * @param {string} [input.cwd] 会话工作目录
 * @param {Function} [input.readFile]
 * @param {Function} [input.warn]
 * @returns {Promise<object[]>}
 */
export async function loadSuppressions({
  config, cwd, readFile = readFileDefault, warn,
}) {
  const merged = [...(config?.suppressions ?? [])]
  if (typeof cwd === 'string' && cwd.length > 0) {
    const file = resolve(cwd, config?.suppressionsFile ?? DEFAULT_SUPPRESSIONS_FILE)
    try {
      const raw = await readFile(file, 'utf8')
      if (String(raw).length > MAX_FILE_BYTES) {
        warn?.(`[code-review] 抑制文件超过 ${MAX_FILE_BYTES} 字节，已忽略：${file}`)
      } else {
        const parsed = JSON.parse(raw)
        const list = Array.isArray(parsed) ? parsed : parsed?.suppressions
        merged.push(...validateSuppressions(list))
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        warn?.(`[code-review] 抑制文件不可用，已忽略：${error.message}`)
      }
    }
  }
  return Object.freeze(merged)
}
