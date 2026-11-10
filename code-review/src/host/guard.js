/** Tools that can mutate the workspace, run commands, or delegate work; the reviewer must never get them. */
export const MUTATING_TOOLS = new Set([
  'write',
  'edit',
  'apply_patch',
  'applyPatch',
  'str_replace_editor',
  'bash',
  'pwsh',
  'subagent',
  'subagent_fork',
  'workflow',
  'create_worktree',
  'jobs',
])

/**
 * Deny mutating tools for agents composed from the reviewer preset.
 * @param {string} reviewerPreset preset id used for reviewer children
 * @returns {(exec: {name: string, agent?: {session?: {header?: {agentPreset?: string}}}}) => string | undefined}
 */
export function createReviewerGuard(reviewerPreset) {
  return (exec) => {
    const preset = exec?.agent?.session?.header?.agentPreset
    if (preset !== reviewerPreset) return undefined
    if (!MUTATING_TOOLS.has(exec.name)) return undefined
    return `code-review: 审查者（${reviewerPreset}）只读，${exec.name} 被拒绝`
  }
}
