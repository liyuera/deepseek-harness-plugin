/**
 * Per-agent browser backends: the extension backend stays a shared singleton
 * (the user's real browser), while sandbox backends are created per agent id,
 * pooled with a cap, idle-reclaimed, and released when the agent disposes.
 * @module @liyuera/dsh-chrome-browser/backend-registry
 */
import type { BrowserBackend } from './backend.ts';
import type { ResolvedChromeConfig } from './chrome.ts';
/** One pooled per-agent sandbox plus its reclamation bookkeeping. */
export interface SandboxLease {
    readonly agentId: string;
    readonly backend: BrowserBackend;
    readonly port: number;
    lastUsedAt: number;
    idleTimer?: NodeJS.Timeout;
}
/** Creates one sandbox backend for a fully-built per-port config. */
export type SandboxFactory = (config: ResolvedChromeConfig) => BrowserBackend;
/**
 * Owns the lifecycle of every browser backend the plugin drives. `shared` is
 * built once (extension or single cdp); sandboxes are pooled per agent id.
 */
export declare class BackendRegistry {
    private readonly config;
    private readonly shared;
    private readonly factory;
    private readonly leases;
    private readonly ports;
    constructor(config: ResolvedChromeConfig, shared: BrowserBackend, factory: SandboxFactory);
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
    resolve(exec: unknown, backend?: 'sandbox' | 'user'): BrowserBackend;
    /** Release one agent's sandbox and return its port. Idempotent. */
    release(agentId: string): void;
    /** Release every sandbox and the shared backend. */
    dispose(): void;
    private ensureSandbox;
    /**
     * Per-instance config: owned mode + independent profile keyed by port.
     *
     * `attachOnly`/`autoRelaunch` are pinned off: a sandbox must spawn its own
     * Chrome, never attach to (or relaunch) whatever already answers on its port.
     */
    private sandboxConfig;
    private armIdle;
    private evictIdle;
}
