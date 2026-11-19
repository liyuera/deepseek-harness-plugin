/**
 * Per-agent browser backends: the extension backend stays a shared singleton
 * (the user's real browser), while sandbox backends are created per agent id,
 * pooled with a cap, idle-reclaimed, and released when the agent disposes.
 * @module @liyuera/dsh-chrome-browser/backend-registry
 */

import type { BrowserBackend } from './backend.ts'
import type { ResolvedChromeConfig } from './chrome.ts'
import { defaultProfileDir } from './chrome.ts'
import { agentIdOf } from './caller.ts'
import { PortAllocator } from './ports.ts'

/** One pooled per-agent sandbox plus its reclamation bookkeeping. */
export interface SandboxLease {
  readonly agentId: string
  readonly backend: BrowserBackend
  readonly port: number
  lastUsedAt: number
  idleTimer?: NodeJS.Timeout
}

/** Creates one sandbox backend for a fully-built per-port config. */
export type SandboxFactory = (config: ResolvedChromeConfig) => BrowserBackend

/**
 * Owns the lifecycle of every browser backend the plugin drives. `shared` is
 * built once (extension or single cdp); sandboxes are pooled per agent id.
 */
export class BackendRegistry {
  private readonly leases = new Map<string, SandboxLease>()
  private readonly ports: PortAllocator

  constructor(
    private readonly config: ResolvedChromeConfig,
    private readonly shared: BrowserBackend,
    private readonly factory: SandboxFactory,
  ) {
    this.ports = new PortAllocator(config.port)
  }

  /** The backend one tool call should drive. Sandbox mode resolves per agent id. */
  resolve(exec: unknown): BrowserBackend {
    if (this.config.backend !== 'sandbox') return this.shared
    const agentId = agentIdOf(exec)
    if (agentId === undefined) return this.shared
    return this.ensureSandbox(agentId).backend
  }

  /** Release one agent's sandbox and return its port. Idempotent. */
  release(agentId: string): void {
    const lease = this.leases.get(agentId)
    if (lease === undefined) return
    this.leases.delete(agentId)
    clearTimeout(lease.idleTimer)
    this.ports.release(lease.port)
    lease.backend.dispose()
  }

  /** Release every sandbox and the shared backend. */
  dispose(): void {
    for (const agentId of [...this.leases.keys()]) this.release(agentId)
    this.shared.dispose()
  }

  private ensureSandbox(agentId: string): SandboxLease {
    const existing = this.leases.get(agentId)
    if (existing !== undefined) {
      existing.lastUsedAt = Date.now()
      this.armIdle(existing)
      return existing
    }
    this.evictIdle()
    if (this.leases.size >= this.config.sandboxMaxConcurrent) {
      throw new Error(
        `chrome-browser 沙箱池已达上限(${this.config.sandboxMaxConcurrent});`
        + '没有可回收的空闲会话。等待其它会话空闲回收，或调大 sandboxMaxConcurrent。',
      )
    }
    const port = this.ports.allocate()
    const backend = this.factory(this.sandboxConfig(port))
    const lease: SandboxLease = { agentId, backend, port, lastUsedAt: Date.now() }
    this.leases.set(agentId, lease)
    this.armIdle(lease)
    return lease
  }

  /**
   * Per-instance config: owned mode + independent profile keyed by port.
   *
   * `attachOnly`/`autoRelaunch` are pinned off: a sandbox must spawn its own
   * Chrome, never attach to (or relaunch) whatever already answers on its port.
   */
  private sandboxConfig(port: number): ResolvedChromeConfig {
    return {
      ...this.config,
      backend: 'cdp',
      mode: 'owned',
      attachOnly: false,
      autoRelaunch: false,
      port,
      profileDir: defaultProfileDir(port),
    }
  }

  private armIdle(lease: SandboxLease): void {
    if (!(this.config.sandboxIdleMs > 0)) return
    clearTimeout(lease.idleTimer)
    const timer = setTimeout(() => {
      if (this.leases.get(lease.agentId) === lease) this.release(lease.agentId)
    }, this.config.sandboxIdleMs)
    ;(timer as { unref?: () => void }).unref?.()
    lease.idleTimer = timer
  }

  private evictIdle(): void {
    if (!(this.config.sandboxIdleMs > 0)) return
    const now = Date.now()
    for (const [agentId, lease] of this.leases) {
      if (now - lease.lastUsedAt >= this.config.sandboxIdleMs) this.release(agentId)
    }
  }
}
