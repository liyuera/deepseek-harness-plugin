/**
 * Fixed-increment debug-port allocation with reuse. Never uses an OS ephemeral
 * port (Chrome 151 no longer writes DevToolsActivePort for a dedicated profile),
 * so the port is always a concrete number the CDP HTTP endpoint can bind.
 * @module @liyuera/dsh-chrome-browser/ports
 */
export class PortAllocator {
  private next: number
  private readonly free: number[] = []

  constructor(basePort: number) {
    this.next = basePort
  }

  allocate(): number {
    return this.free.pop() ?? this.next++
  }

  release(port: number): void {
    this.free.push(port)
  }
}
