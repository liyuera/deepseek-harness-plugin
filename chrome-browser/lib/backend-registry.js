/**
 * Per-agent browser backends: the extension backend stays a shared singleton
 * (the user's real browser), while sandbox backends are created per agent id,
 * pooled with a cap, idle-reclaimed, and released when the agent disposes.
 * @module @liyuera/dsh-chrome-browser/backend-registry
 */
import { defaultProfileDir } from './chrome.js';
import { agentIdOf } from './caller.js';
import { PortAllocator } from './ports.js';
/**
 * Owns the lifecycle of every browser backend the plugin drives. `shared` is
 * built once (extension or single cdp); sandboxes are pooled per agent id.
 */
export class BackendRegistry {
    config;
    shared;
    factory;
    leases = new Map();
    ports;
    constructor(config, shared, factory) {
        this.config = config;
        this.shared = shared;
        this.factory = factory;
        this.ports = new PortAllocator(config.port);
    }
    /**
     * The backend one tool call should drive.
     *
     * An explicit `'user'` preference always means the shared backend (the user's
     * real Chrome via the extension bridge). Otherwise — in sandbox mode, with an
     * agent — the call drives that agent's own sandbox; outside sandbox mode
     * there is no sandbox to drive, so the preference is effectively ignored and
     * the shared backend answers.
     * @param exec - execution context carrying the calling agent's id.
     * @param backend - optional per-call preference; omitted means `'sandbox'`.
     */
    resolve(exec, backend) {
        if (backend === 'user')
            return this.shared;
        if (this.config.backend !== 'sandbox')
            return this.shared;
        const agentId = agentIdOf(exec);
        if (agentId === undefined)
            return this.shared;
        return this.ensureSandbox(agentId).backend;
    }
    /** Release one agent's sandbox and return its port. Idempotent. */
    release(agentId) {
        const lease = this.leases.get(agentId);
        if (lease === undefined)
            return;
        this.leases.delete(agentId);
        clearTimeout(lease.idleTimer);
        this.ports.release(lease.port);
        lease.backend.dispose();
    }
    /** Release every sandbox and the shared backend. */
    dispose() {
        for (const agentId of [...this.leases.keys()])
            this.release(agentId);
        this.shared.dispose();
    }
    ensureSandbox(agentId) {
        const existing = this.leases.get(agentId);
        if (existing !== undefined) {
            existing.lastUsedAt = Date.now();
            this.armIdle(existing);
            return existing;
        }
        this.evictIdle();
        if (this.leases.size >= this.config.sandboxMaxConcurrent) {
            throw new Error(`chrome-browser 沙箱池已达上限(${this.config.sandboxMaxConcurrent});`
                + '没有可回收的空闲会话。等待其它会话空闲回收，或调大 sandboxMaxConcurrent。');
        }
        const port = this.ports.allocate();
        const backend = this.factory(this.sandboxConfig(port));
        const lease = { agentId, backend, port, lastUsedAt: Date.now() };
        this.leases.set(agentId, lease);
        this.armIdle(lease);
        return lease;
    }
    /**
     * Per-instance config: owned mode + independent profile keyed by port.
     *
     * `attachOnly`/`autoRelaunch` are pinned off: a sandbox must spawn its own
     * Chrome, never attach to (or relaunch) whatever already answers on its port.
     */
    sandboxConfig(port) {
        return {
            ...this.config,
            backend: 'cdp',
            mode: 'owned',
            attachOnly: false,
            autoRelaunch: false,
            port,
            profileDir: defaultProfileDir(port),
        };
    }
    armIdle(lease) {
        if (!(this.config.sandboxIdleMs > 0))
            return;
        clearTimeout(lease.idleTimer);
        const timer = setTimeout(() => {
            if (this.leases.get(lease.agentId) === lease)
                this.release(lease.agentId);
        }, this.config.sandboxIdleMs);
        timer.unref?.();
        lease.idleTimer = timer;
    }
    evictIdle() {
        if (!(this.config.sandboxIdleMs > 0))
            return;
        const now = Date.now();
        for (const [agentId, lease] of this.leases) {
            if (now - lease.lastUsedAt >= this.config.sandboxIdleMs)
                this.release(agentId);
        }
    }
}
//# sourceMappingURL=backend-registry.js.map