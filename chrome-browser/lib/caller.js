/**
 * Reading the calling agent from a tool execution context. Shared by the
 * activity tracker and the backend registry.
 * @module @liyuera/dsh-chrome-browser/caller
 */
/** The agent id of an execution, or undefined when there is none. */
export function agentIdOf(exec) {
    const id = exec?.agent?.id;
    return typeof id === 'string' && id !== '' ? id : undefined;
}
/** The session id of an execution, or undefined when there is none. */
export function sessionIdOf(exec) {
    const session = exec?.agent?.session;
    const id = session?.id;
    return typeof id === 'string' && id !== '' ? id : undefined;
}
//# sourceMappingURL=caller.js.map