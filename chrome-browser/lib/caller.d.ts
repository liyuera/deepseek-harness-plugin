/**
 * Reading the calling agent from a tool execution context. Shared by the
 * activity tracker and the backend registry.
 * @module @liyuera/dsh-chrome-browser/caller
 */
/** The agent id of an execution, or undefined when there is none. */
export declare function agentIdOf(exec: unknown): string | undefined;
/** The session id of an execution, or undefined when there is none. */
export declare function sessionIdOf(exec: unknown): string | undefined;
