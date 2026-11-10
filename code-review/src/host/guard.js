/**
 * Tools the reviewer may call: read-only inspection plus structured result submission.
 * This is an allowlist on purpose: any tool not listed here is denied for reviewer
 * agents, so new tools (shell, terminal, plugin management, scheduling, delegation,
 * messaging, persistence) fail closed instead of silently reaching the reviewer.
 */
export const READONLY_TOOLS = new Set([
  'read',
  'read_image',
  'glob',
  'grep',
  'structured_output',
])

/**
 * Allow only read-only tools for agents composed from the reviewer preset.
 * Non-reviewer agents, and calls with no exec/agent/preset, abstain (undefined).
 * Reviewer calls not in the allowlist are denied, including a missing tool name.
 * @param {string} reviewerPreset preset id used for reviewer children
 * @returns {(exec?: {name?: string, agent?: {session?: {header?: {agentPreset?: string}}}}) => string | undefined}
 */
export function createReviewerGuard(reviewerPreset) {
  return (exec) => {
    const preset = exec?.agent?.session?.header?.agentPreset
    if (preset !== reviewerPreset) return undefined
    if (READONLY_TOOLS.has(exec?.name)) return undefined
    return `code-review: 审查者（${reviewerPreset}）只读，${String(exec?.name)} 不在只读白名单内，已拒绝`
  }
}
