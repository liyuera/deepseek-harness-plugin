/**
 * Fixed-increment debug-port allocation with reuse. Never uses an OS ephemeral
 * port (Chrome 151 no longer writes DevToolsActivePort for a dedicated profile),
 * so the port is always a concrete number the CDP HTTP endpoint can bind.
 * @module @liyuera/dsh-chrome-browser/ports
 */
export class PortAllocator {
    next;
    free = [];
    constructor(basePort) {
        this.next = basePort;
    }
    allocate() {
        return this.free.pop() ?? this.next++;
    }
    release(port) {
        this.free.push(port);
    }
}
//# sourceMappingURL=ports.js.map