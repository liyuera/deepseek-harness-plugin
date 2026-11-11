/**
 * 修复策略：区分「可自动修」与「只能人工确认」的 finding。
 *
 * 团队口径是 auto_safe / manual_only / forbidden；我们落在 finding 的 `fixMode` 上：
 * - 规则显式 fixMode 优先；
 * - 路径命中 forbidden 列表 → forbidden（只报告，禁止修改）；
 * - 路径命中 manual 列表（生成代码、契约、迁移、权限、支付、workflow）→ manual；
 * - 其余 auto（现有“请修复”语义）。
 * `respectFixPolicy: false` 时忽略路径策略，全部按 auto 处理。
 * @module @liyuera/dsh-code-review/host/fixmode
 */
import { locationPath } from './evidence.js'
import { matchGlob } from './scope.js'

export const FIX_MODES = Object.freeze(['auto', 'manual', 'forbidden'])

/** 默认人工确认路径：生成代码、类型契约、迁移、权限、支付、CI workflow。 */
export const DEFAULT_MANUAL_GLOBS = Object.freeze([
  '**/generated/**',
  '**/*.generated.*',
  '**/kubb/**',
  '**/*.d.ts',
  '**/contracts/**',
  '**/migrations/**',
  '**/auth/**',
  '**/payment/**',
  '**/.github/workflows/**',
])

/**
 * 判断路径是否命中任一 glob。
 * @param {readonly string[]} globs
 * @param {string} path
 * @returns {boolean}
 */
function matchesAny(globs, path) {
  return Array.isArray(globs) && globs.some((glob) => matchGlob(glob, path))
}

/**
 * 计算单条 finding 的修复模式。
 * @param {object} finding
 * @param {{ruleFixModes?: Map<string,string>, config: object}} input
 * @returns {'auto'|'manual'|'forbidden'}
 */
export function classifyFixMode(finding, { ruleFixModes, config }) {
  const explicit = ruleFixModes?.get(finding.ruleId)
  if (explicit !== undefined) return explicit
  if (config?.respectFixPolicy === false) return 'auto'
  const path = locationPath(finding.location)
  if (matchesAny(config?.forbiddenFixGlobs, path)) return 'forbidden'
  if (matchesAny(config?.manualFixGlobs, path)) return 'manual'
  return 'auto'
}

/**
 * 给 findings 补上渲染/回灌需要的字段。
 * @param {readonly object[]} findings
 * @param {{ruleFixModes?: Map<string,string>, ruleBlocking?: Map<string,boolean>, config: object, evidence?: readonly string[]}} input
 * @returns {object[]}
 */
export function decorateFindings(findings, { ruleFixModes, ruleBlocking, config, evidence = [] }) {
  return findings.map((finding, index) => ({
    ...finding,
    fixMode: classifyFixMode(finding, { ruleFixModes, config }),
    blocking: ruleBlocking?.get(finding.ruleId) ?? true,
    evidenceStatus: evidence[index] ?? 'unchecked',
  }))
}
