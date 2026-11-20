/**
 * Fixed-increment debug-port allocation with reuse. Never uses an OS ephemeral
 * port (Chrome 151 no longer writes DevToolsActivePort for a dedicated profile),
 * so the port is always a concrete number the CDP HTTP endpoint can bind.
 * @module @liyuera/dsh-chrome-browser/ports
 */
export declare class PortAllocator {
    private next;
    private readonly free;
    constructor(basePort: number);
    allocate(): number;
    release(port: number): void;
}
