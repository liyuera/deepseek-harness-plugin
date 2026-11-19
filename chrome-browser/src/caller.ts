/**
 * Reading the calling agent from a tool execution context. Shared by the
 * activity tracker and the backend registry.
 * @module @liyuera/dsh-chrome-browser/caller
 */

/** The agent id of an execution, or undefined when there is none. */
export function agentIdOf(exec: unknown): string | undefined {
  const id = (exec as { agent?: { id?: unknown } } | null | undefined)?.agent?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** The session id of an execution, or undefined when there is none. */
export function sessionIdOf(exec: unknown): string | undefined {
  const session = (exec as { agent?: { session?: { id?: unknown } } } | null | undefined)?.agent?.session
  const id = session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}
