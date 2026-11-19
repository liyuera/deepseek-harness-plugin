# 沙箱后端注册表（BackendRegistry）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把插件从「单例后端」升级为「按 `agent.id` 分配沙箱实例」的注册表，让多个 agent（含子代理）并行驱动各自隔离的浏览器；扩展后端保留为共享的「用户真实浏览器」通道。

**Architecture:** 新增 `BackendRegistry` + `PortAllocator`，工具 execute 时用 `exec.agent.id` 解析后端。`backend: 'sandbox'` 时按 agent 懒建 owned CDP 实例（固定递增端口 + 独立 profile），池化 + 空闲回收 + `agent/disposed` 释放。扩展/CDP 单实例路径与 `@` 菜单、扩展桥路由不变。

**Tech Stack:** TypeScript + Cordis + 现有 `Chrome`/`CdpBackend`（CDP owned）+ Node 内建。**不引入 Playwright/Puppeteer。**

---

## Global Constraints

- **零新运行时依赖**：只用 Node 内建（`node:child_process` / `node:fs` / `node:path`）与现有 `@deepseek-ai/*` peer/dev 依赖。README「零浏览器自动化运行时依赖」承诺不变。
- **配置扁平命名**：`sandboxMaxConcurrent` / `sandboxIdleMs` / `sandboxHeadless`（不嵌套）。
- **键 = `agent.id`**（每个子代理独立沙箱），不是 `sessionId`。
- **`sandboxHeadless` 默认 `true`**（默认无头、不弹窗；设 `false` 才出现可见窗口）。
- 现有文件命名约定：`src/*.ts` 小写连字符，vitest 单测 `tests/*.spec.ts`，构建 `tsc -b`。
- TDD：每个任务先写失败测试，再实现，再跑绿，再 commit。commit message 用 `feat:` 前缀。
- 所有时间相关逻辑用 `vi.useFakeTimers()`，不依赖真实时钟。

---

## 文件结构

**新增：**
- `src/caller.ts` — `agentIdOf` / `sessionIdOf`（从 `activity.ts` 抽出）
- `src/ports.ts` — `PortAllocator`
- `src/backend-registry.ts` — `BackendRegistry` + `SandboxLease` + `SandboxFactory`
- `tests/caller.spec.ts`
- `tests/ports.spec.ts`
- `tests/backend-registry.spec.ts`

**修改：**
- `src/activity.ts` — `sessionIdOf` 改为从 `caller.ts` 导入（删本地副本）
- `src/chrome.ts` — `ResolvedChromeConfig` 增 3 字段 + `resolveChromeConfig` 默认值 + `chromeArgs` headless 分支
- `src/index.ts` — `Config`/`ChromePluginConfig` 增 3 字段；`apply()` 用 registry 取代单例；挂 `agent/disposed`
- `src/tools.ts` — `chromeToolDefinitions` 首个参数 `backend` → `resolve: (exec) => BrowserBackend`；16 个工具体首行插入 `const backend = resolve(_exec)`

**不改：** `src/backend.ts`、`src/help.ts`、`src/mentions.ts`、`src/console-log.ts`、`src/routes.ts`（仅 `/tabs` 路由的 backend 引用改指向 shared，见 M5）。

---

## Task 1: 抽出 caller 身份读取 helper

**Files:**
- Create: `src/caller.ts`
- Modify: `src/activity.ts:161-165`（删本地 `sessionIdOf`，改 import）
- Test: `tests/caller.spec.ts`

**Interfaces:**
- Produces: `agentIdOf(exec: unknown): string | undefined`（读 `exec.agent.id`）、`sessionIdOf(exec: unknown): string | undefined`（读 `exec.agent.session.id`）

- [ ] **Step 1: 写失败测试**

Create `tests/caller.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { agentIdOf, sessionIdOf } from '../src/caller.ts'

describe('caller helpers', () => {
  it('reads agent id from the execution context', () => {
    expect(agentIdOf({ agent: { id: 'a-1' } })).toBe('a-1')
    expect(agentIdOf({})).toBeUndefined()
    expect(agentIdOf(null)).toBeUndefined()
    expect(agentIdOf({ agent: {} })).toBeUndefined()
    expect(agentIdOf({ agent: { id: '' } })).toBeUndefined()
    expect(agentIdOf({ agent: { id: 42 } })).toBeUndefined()
  })

  it('reads session id from the execution context', () => {
    expect(sessionIdOf({ agent: { session: { id: 's-1' } } })).toBe('s-1')
    expect(sessionIdOf({})).toBeUndefined()
    expect(sessionIdOf({ agent: { session: { id: '' } } })).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test tests/caller.spec.ts`
Expected: FAIL — `Cannot find module '../src/caller.ts'`

- [ ] **Step 3: 实现 `src/caller.ts`**

```ts
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
```

- [ ] **Step 4: 改 `activity.ts` 用共享 helper**

In `src/activity.ts`：
- 在 import 区加：`import { sessionIdOf } from './caller.ts'`
- 删除本地 `sessionIdOf` 函数（原第 160-165 行）：

```ts
/** The executing session id, as the tracker reads it from the execution. */
function sessionIdOf(exec: unknown): string | undefined {
  const session = (exec as { agent?: { session?: { id?: unknown } } } | null | undefined)?.agent?.session
  const id = session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test tests/caller.spec.ts tests/activity.spec.ts`
Expected: PASS（caller 两用例 + activity 既有用例仍绿）

- [ ] **Step 6: Commit**

```bash
git add src/caller.ts src/activity.ts tests/caller.spec.ts
git commit -m "feat: extract agentIdOf/sessionIdOf caller helpers"
```

---

## Task 2: PortAllocator

**Files:**
- Create: `src/ports.ts`
- Test: `tests/ports.spec.ts`

**Interfaces:**
- Produces: `class PortAllocator { constructor(basePort: number); allocate(): number; release(port: number): void }`

- [ ] **Step 1: 写失败测试**

Create `tests/ports.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PortAllocator } from '../src/ports.ts'

describe('PortAllocator', () => {
  it('allocates incrementing ports from the base', () => {
    const ports = new PortAllocator(9222)
    expect(ports.allocate()).toBe(9222)
    expect(ports.allocate()).toBe(9223)
    expect(ports.allocate()).toBe(9224)
  })

  it('reuses released ports before incrementing', () => {
    const ports = new PortAllocator(9222)
    const first = ports.allocate() // 9222
    ports.allocate()               // 9223
    ports.release(first)
    expect(ports.allocate()).toBe(9222)
    expect(ports.allocate()).toBe(9224)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test tests/ports.spec.ts`
Expected: FAIL — `Cannot find module '../src/ports.ts'`

- [ ] **Step 3: 实现**

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test tests/ports.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ports.ts tests/ports.spec.ts
git commit -m "feat: add fixed-increment port allocator"
```

---

## Task 3: BackendRegistry

**Files:**
- Create: `src/backend-registry.ts`
- Test: `tests/backend-registry.spec.ts`

**Interfaces:**
- Consumes: `agentIdOf`（Task 1）、`PortAllocator`（Task 2）、`BrowserBackend`（`src/backend.ts`）、`ResolvedChromeConfig`（`src/chrome.ts`）
- Produces: `class BackendRegistry { constructor(config, shared, factory); resolve(exec): BrowserBackend; release(agentId): void; dispose(): void }`，`type SandboxFactory = (config: ResolvedChromeConfig) => BrowserBackend`

- [ ] **Step 1: 写失败测试**

Create `tests/backend-registry.spec.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BackendRegistry } from '../src/backend-registry.ts'
import type { BrowserBackend } from '../src/backend.ts'
import type { ResolvedChromeConfig } from '../src/chrome.ts'

/** Minimal resolved config for sandbox-mode tests. */
function sandboxConfig(over: Partial<ResolvedChromeConfig> = {}): ResolvedChromeConfig {
  return {
    backend: 'sandbox', port: 9222, profileDir: '/tmp/p', mode: 'owned',
    autoRelaunch: false, attachOnly: false, timeoutMs: 15000, readTextLimit: 30000,
    waitLoadMs: 8000, screenshotDir: '/tmp/s', consoleIdleMs: 300000,
    bridgePort: 21987, sandboxMaxConcurrent: 2, sandboxIdleMs: 600000, sandboxHeadless: false,
    ...over,
  }
}

function fakeBackend(): BrowserBackend & { disposed: boolean } {
  return {
    disposed: false,
    ensure: async () => {},
    activeTabId: async () => 't',
    listTabs: async () => [],
    openTab: async () => ({ id: 't', title: '', url: '', active: true, favicon: '' }),
    closeTab: async () => {},
    read: async () => ({ title: '', url: '', text: '', html: '' }),
    inventory: async () => ({ title: '', url: '', matched: 0, items: [] }),
    navigate: async () => {},
    waitForLoad: async () => {},
    evaluate: async () => undefined,
    lastEvalWorld: undefined,
    webmcpTools: async () => ({ available: false, tools: [] }),
    webmcpCall: async () => ({ tool: '' }),
    click: async () => ({ matched: 0, clicked: 0, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0 }),
    hover: async () => ({ matched: 0, hovered: false }),
    press: async () => ({ found: false, pressed: false, submitted: false }),
    select: async () => ({ matched: 0, changed: false, value: '', options: [] }),
    waitFor: async () => false,
    type: async () => {},
    screenshot: async () => ({ data: '' }),
    startConsole: async () => {},
    stopConsole: async () => {},
    dispose() { this.disposed = true },
  }
}

const execOf = (id: string): unknown => ({ agent: { id } })

describe('BackendRegistry', () => {
  afterEach(() => vi.useRealTimers())

  it('returns shared backend when backend is not sandbox', () => {
    const shared = fakeBackend()
    const reg = new BackendRegistry(sandboxConfig({ backend: 'extension' }), shared, () => fakeBackend())
    expect(reg.resolve(execOf('a1'))).toBe(shared)
    expect(reg.resolve({})).toBe(shared)
  })

  it('returns shared backend for agent-less calls in sandbox mode', () => {
    const shared = fakeBackend()
    const reg = new BackendRegistry(sandboxConfig(), shared, () => fakeBackend())
    expect(reg.resolve({})).toBe(shared)
  })

  it('creates one sandbox per agent and reuses it', () => {
    const shared = fakeBackend()
    const made: string[] = []
    const reg = new BackendRegistry(sandboxConfig(), shared, () => {
      made.push('x')
      return fakeBackend()
    })
    const a = reg.resolve(execOf('a1'))
    const b = reg.resolve(execOf('a1'))
    expect(a).toBe(b)
    expect(made).toHaveLength(1)
    expect(reg.resolve(execOf('a2'))).not.toBe(a)
    expect(made).toHaveLength(2)
  })

  it('reuses freed ports', () => {
    const shared = fakeBackend()
    const ports: number[] = []
    const reg = new BackendRegistry(sandboxConfig({ sandboxMaxConcurrent: 4 }), shared, (cfg) => {
      ports.push(cfg.port)
      return fakeBackend()
    })
    reg.resolve(execOf('a1'))
    reg.resolve(execOf('a2'))
    reg.release('a1')
    reg.resolve(execOf('a3'))
    expect(ports).toEqual([9222, 9223, 9222])
  })

  it('release disposes and is idempotent', () => {
    const shared = fakeBackend()
    const sandbox = fakeBackend()
    const reg = new BackendRegistry(sandboxConfig(), shared, () => sandbox)
    reg.resolve(execOf('a1'))
    reg.release('a1')
    expect(sandbox.disposed).toBe(true)
    reg.release('a1') // no throw
  })

  it('rejects when at capacity with no idle lease to reclaim', () => {
    const shared = fakeBackend()
    const reg = new BackendRegistry(sandboxConfig({ sandboxMaxConcurrent: 2 }), shared, () => fakeBackend())
    reg.resolve(execOf('a1'))
    reg.resolve(execOf('a2'))
    expect(() => reg.resolve(execOf('a3'))).toThrow(/上限/)
  })

  it('reclaims an idle lease instead of rejecting', () => {
    vi.useFakeTimers()
    const shared = fakeBackend()
    const created: Array<BrowserBackend & { disposed: boolean }> = []
    const reg = new BackendRegistry(sandboxConfig({ sandboxMaxConcurrent: 2, sandboxIdleMs: 1000 }), shared, () => {
      const backend = fakeBackend()
      created.push(backend)
      return backend
    })
    reg.resolve(execOf('a1'))
    reg.resolve(execOf('a2'))
    vi.advanceTimersByTime(2000)
    const a3 = reg.resolve(execOf('a3'))
    expect(a3).toBeDefined()
    expect(created.some(backend => backend.disposed)).toBe(true)
  })

  it('dispose releases every sandbox and the shared backend', () => {
    const shared = fakeBackend()
    const reg = new BackendRegistry(sandboxConfig({ sandboxMaxConcurrent: 4 }), shared, () => fakeBackend())
    reg.resolve(execOf('a1'))
    reg.resolve(execOf('a2'))
    reg.dispose()
    expect(shared.disposed).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test tests/backend-registry.spec.ts`
Expected: FAIL — `Cannot find module '../src/backend-registry.ts'`

- [ ] **Step 3: 实现 `src/backend-registry.ts`**

```ts
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

  /** Per-instance config: owned mode + independent profile keyed by port. */
  private sandboxConfig(port: number): ResolvedChromeConfig {
    return {
      ...this.config,
      backend: 'cdp',
      mode: 'owned',
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
    const now = Date.now()
    for (const [agentId, lease] of this.leases) {
      if (now - lease.lastUsedAt >= this.config.sandboxIdleMs) this.release(agentId)
    }
  }
}
```



- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test tests/backend-registry.spec.ts`
Expected: PASS（8 用例）

- [ ] **Step 5: Commit**

```bash
git add src/backend-registry.ts tests/backend-registry.spec.ts
git commit -m "feat: add per-agent sandbox backend registry"
```

---

## Task 4: 配置 schema + headless 旗标

**Files:**
- Modify: `src/chrome.ts:44-78`（`ResolvedChromeConfig` 增 3 字段）、`src/chrome.ts:333-356`（`resolveChromeConfig` 默认值）、`src/chrome.ts:754-766`（`chromeArgs` headless）
- Modify: `src/index.ts:43-78`（`ChromePluginConfig` 接口）、`src/index.ts:81-95`（`Config` schema）
- Test: `tests/chrome.spec.ts`（追加用例）

**Interfaces:**
- Consumes: 无
- Produces: `ResolvedChromeConfig.sandboxMaxConcurrent: number`、`.sandboxIdleMs: number`、`.sandboxHeadless: boolean`；`Config` 同名字段

- [ ] **Step 1: 写失败测试（chrome.spec.ts 追加）**

在 `tests/chrome.spec.ts` 里追加（若该文件无 `resolveChromeConfig`/`chromeArgs` 相关既有用例，则新建 describe）：

```ts
import { describe, expect, it } from 'vitest'
import { resolveChromeConfig } from '../src/chrome.ts'

describe('sandbox config defaults', () => {
  it('resolves sandbox pool defaults', () => {
    const cfg = resolveChromeConfig({ backend: 'sandbox' })
    expect(cfg.sandboxMaxConcurrent).toBe(4)
    expect(cfg.sandboxIdleMs).toBe(10 * 60_000)
    expect(cfg.sandboxHeadless).toBe(true)
  })

  it('honours explicit sandbox values', () => {
    const cfg = resolveChromeConfig({ backend: 'sandbox', sandboxMaxConcurrent: 8, sandboxIdleMs: 0, sandboxHeadless: true })
    expect(cfg.sandboxMaxConcurrent).toBe(8)
    expect(cfg.sandboxIdleMs).toBe(0)
    expect(cfg.sandboxHeadless).toBe(true)
  })
})
```

> `chromeArgs` 是 `Chrome` 的私有方法，不直接单测。headless 旗标用 smoke 验证（Task 6），或给 `chromeArgs` 抽成可导出纯函数 `buildChromeArgs(config, profileDir, extra, startupUrl)` 再单测。若走后者，`chrome.spec.ts` 追加：

```ts
import { buildChromeArgs } from '../src/chrome.ts'

it('appends --headless=new when sandboxHeadless', () => {
  const cfg = resolveChromeConfig({ backend: 'sandbox', sandboxHeadless: true })
  expect(buildChromeArgs(cfg, '/p', [], undefined)).toContain('--headless=new')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test tests/chrome.spec.ts`
Expected: FAIL — `cfg.sandboxMaxConcurrent` 为 `undefined`（或 `buildChromeArgs` 不存在）

- [ ] **Step 3: `src/chrome.ts` 增字段与默认值**

在 `ResolvedChromeConfig` 接口（第 77 行 `bridgePort: number` 之后）加：

```ts
  /** Max concurrent sandbox instances (backend:'sandbox' only). */
  sandboxMaxConcurrent: number
  /** Idle reclamation bound in ms for a sandbox; 0 = never. */
  sandboxIdleMs: number
  /** Run sandbox Chrome headless. */
  sandboxHeadless: boolean
```

在 `resolveChromeConfig` 返回对象（第 354 行 `bridgePort` 之后）加：

```ts
    sandboxMaxConcurrent: config.sandboxMaxConcurrent ?? 4,
    sandboxIdleMs: config.sandboxIdleMs ?? 10 * 60_000,
    sandboxHeadless: config.sandboxHeadless ?? true,
```

把 `chromeArgs`（原 754-766）抽成导出纯函数，并加 headless 分支：

```ts
export function buildChromeArgs(
  config: ResolvedChromeConfig,
  profileDir: string,
  extra: readonly string[],
  startupUrl?: string,
): string[] {
  const args = [
    `--remote-debugging-port=${config.port}`,
    `--user-data-dir=${profileDir}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    ...(config.sandboxHeadless ? ['--headless=new'] : []),
    ...extra,
  ]
  if (startupUrl !== undefined) args.push(startupUrl)
  return args
}
```

把 `Chrome` 类里原 `chromeArgs` 私有方法删除，`spawnChrome` 里 `this.chromeArgs(profileDir, extra, startupUrl)` 改为 `buildChromeArgs(this.config, profileDir, extra, startupUrl)`。

- [ ] **Step 4: `src/index.ts` 增 schema**

`ChromePluginConfig` 接口（第 78 行 `bridgePort` 之后）加：

```ts
  /** Max concurrent sandbox instances (backend:'sandbox' only). */
  sandboxMaxConcurrent?: number
  /** Idle reclamation bound in ms for a sandbox; 0 = never. */
  sandboxIdleMs?: number
  /** Run sandbox Chrome headless (default false = visible window). */
  sandboxHeadless?: boolean
```

`Config` schema（第 94 行 `bridgePort` 之后）加：

```ts
  sandboxMaxConcurrent: z.number().step(1).min(1).default(4),
  sandboxIdleMs: z.number().step(1).min(0).default(10 * 60_000),
  sandboxHeadless: z.boolean().default(true),
```

并把 `backend` 联合（第 82 行）加 `'sandbox'`：

```ts
  backend: z.union([z.const('extension'), z.const('cdp'), z.const('sandbox')]).default('extension'),
```

`ChromePluginConfig.backend`（第 44-45 行）类型同步加：

```ts
  backend?: 'extension' | 'cdp' | 'sandbox'
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test tests/chrome.spec.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/chrome.ts src/index.ts tests/chrome.spec.ts
git commit -m "feat: add sandbox pool config and headless flag"
```

---

## Task 5: 接线（单例 → registry）

**Files:**
- Modify: `src/index.ts:104-145`（`apply()`）
- Modify: `src/tools.ts:238-242`（签名）、`src/tools.ts` 各工具体

**Interfaces:**
- Consumes: `BackendRegistry`（Task 3）、`buildBackend`（现有）、`Chrome`/`CdpBackend`（现有）
- Produces: 无新导出；`chromeToolDefinitions` 首个参数类型变为 `(exec: unknown) => BrowserBackend`

- [ ] **Step 1: 改 `tools.ts` 签名与工具体**

`src/tools.ts` 第 238-242 行签名改为：

```ts
export function chromeToolDefinitions(
  resolve: (exec: unknown) => BrowserBackend,
  config: ResolvedChromeConfig,
  consoleLog: ConsoleLog,
  help: HelpChannel,
): ToolDefinition[] {
```

在函数体最开头加一行本地解析（供 `resolveTabId` 等使用不必改）：

```ts
  // 每个工具 execute 首行统一：const backend = resolve(_exec)
```

然后**在以下 16 个工具的 `execute` 回调体第一行**插入 `const backend = resolve(_exec)`（`chrome_request_help` 除外，它只用 `help`）：
`chrome_tabs`、`chrome_read`、`chrome_navigate`、`chrome_open`、`chrome_close`、`chrome_screenshot`、`chrome_click`、`chrome_hover`、`chrome_type`、`chrome_press`、`chrome_select`、`chrome_eval`、`chrome_webmcp_list`、`chrome_webmcp_call`、`chrome_wait`、`chrome_console`。

代表示例（`chrome_navigate`，原 379-385 行）：

```ts
      execute: async (args: { url: string; tabId?: string; waitLoad?: boolean }, _exec: unknown): Promise<JsonValue> => {
        const backend = resolve(_exec)
        assertOperableUrl('chrome_navigate', args.url, false)
        const tabId = await resolveTabId(backend, _exec, args.tabId)
        await backend.navigate(tabId, args.url, args.waitLoad !== false, config.waitLoadMs)
        return { tabId, url: args.url } as unknown as JsonValue
      },
```

> `chrome_tabs` / `chrome_open` / `chrome_close` 原 execute 没有 `resolveTabId`，但仍要加 `const backend = resolve(_exec)`，并把体里的 `backend.xxx` 保持（闭包 `backend` 变量名已改为局部变量，无冲突）。`resolveTabId` 函数本身（原 220-228 行）不用改。

- [ ] **Step 2: 改 `index.ts` `apply()`**

替换 `src/index.ts` 第 104-145 行的 `apply` 实现（关键片段）：

```ts
import { buildBackend } from './backend.ts'
import { CdpBackend } from './backend.ts'
import { Chrome } from './chrome.ts'
import { BackendRegistry } from './backend-registry.ts'
import type { SandboxFactory } from './backend-registry.ts'
```

`apply` 内：

```ts
  const { backend: shared, chrome } = buildBackend(resolved, (tabId, message) => {
    consoleLog.append(tabId, message)
  })
  if (chrome !== undefined) chrome.reclaimOwnedLeftover()

  // 沙箱工厂：每个 agent 一个 owned CDP 实例，console 汇入共享缓冲。
  const factory: SandboxFactory = (cfg) => {
    const instance = new Chrome(cfg)
    return new CdpBackend(instance, (tabId, message) => consoleLog.append(tabId, message))
  }
  const registry = new BackendRegistry(resolved, shared, factory)

  const help = new HelpChannel()
  const activity = new ActivityTracker()
  for (const definition of chromeToolDefinitions(exec => registry.resolve(exec), resolved, consoleLog, help)) {
    ctx.tools.register(withActivity(definition, activity))
  }
  registerHelpChannel(ctx, help)
  // 扩展桥与路由仍针对「用户真实浏览器」（shared），不是 per-agent 沙箱。
  const bridge = resolved.backend === 'extension'
    ? installExtensionBridge(ctx, shared, resolved.screenshotDir, resolved.bridgePort)
    : undefined
  registerChromeRoutes(ctx, shared, resolved.screenshotDir, activity, bridge)
  registerChromeSkill(ctx)

  // 会话/子代理结束 → 释放其沙箱。
  ctx.on('agent/disposed', (payload) => {
    const id = (payload as { agent?: { id?: unknown } }).agent?.id
    if (typeof id === 'string' && id !== '') registry.release(id)
  })

  ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const messages = await expandTabMentions(decision.messages, () => shared.listTabs())
    return messages === undefined ? decision : { ...decision, messages }
  }, { prepend: true })

  ctx.effect(() => () => {
    consoleLog.releaseAll()
    activity.clear()
    registry.dispose()
  }, 'chrome-browser: backend lifecycle')
```

> 注意两处语义变化：
> 1. `expandTabMentions` 的 `listTabs` 从 `backend.listTabs()` 改为 `shared.listTabs()` —— `@` 引用始终指向用户真实浏览器。
> 2. `agent/disposed` 若从根 `ctx.on` 收不到（scope-filtered emit），改在实现时验证：现有 `agent/pre-step` 已从根 `ctx.on` 生效，故预期可行；若不行，换 `session/disposed` 或按 agent 作用域注册。

- [ ] **Step 3: 改 `routes.ts` `/tabs` 引用**

`src/routes.ts` 的 `registerChromeRoutes` 入参已是 `backend`（现由 index.ts 传 `shared`），**无需改代码**。仅确认调用点传的是 `shared` 而非 `registry`。

- [ ] **Step 4: typecheck + 全量单测**

Run: `pnpm exec tsc -b --force && pnpm test`
Expected: typecheck 通过，既有 spec 全绿（`chromeToolDefinitions` 调用点只有 `index.ts` 一处，签名改动已被 Step 2 覆盖）。

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts src/index.ts
git commit -m "feat: wire backend registry into tool resolution"
```

---

## Task 6: 并行 smoke + README

**Files:**
- Modify: `tests/smoke.spec.ts`（追加并行隔离用例）
- Modify: `README.md`（工具表/配置节增 sandbox 说明）

- [ ] **Step 1: smoke 并行用例**

在 `tests/smoke.spec.ts` 追加（仅在 `DSH_CHROME_SMOKE=1` 下跑）：

```ts
it('sandbox instances are isolated per agent', async () => {
  // 需要本机可启动 headless/headful Chrome；用两个伪造 agentId 并发 resolve，
  // 各自 openTab 后 listTabs 只看到自己的标签页。
  const execA = { agent: { id: 'smoke-a' } }
  const execB = { agent: { id: 'smoke-b' } }
  const backendA = registry.resolve(execA)
  const backendB = registry.resolve(execB)
  expect(backendA).not.toBe(backendB)
  const tabA = await backendA.openTab('data:text/html,<title>A</title>')
  const tabsA = await backendA.listTabs()
  const tabsB = await backendB.listTabs()
  expect(tabsA.some(t => t.id === tabA.id)).toBe(true)
  expect(tabsB.some(t => t.id === tabA.id)).toBe(false)
})
```

> smoke 依赖真实 Chrome 与 `registry` 实例；若 `tests/smoke.spec.ts` 现有结构无 registry 入口，改为在 `backend-registry.spec.ts` 用真 `CdpBackend` + 真 `Chrome` 各建两个实例做同断言（`DSH_CHROME_SMOKE=1` 门控）。

- [ ] **Step 2: 跑 smoke**

Run: `DSH_CHROME_SMOKE=1 pnpm test:smoke`
Expected: PASS（本机 Chrome 起两个实例，隔离断言通过）

- [ ] **Step 3: README**

在 `README.md` 功能表加一行，配置节补 `backend: 'sandbox'` 与三个 `sandbox*` 字段说明（值、默认、语义：按 agent 并行隔离、空闲回收、headless 默认 false）。

- [ ] **Step 4: Commit**

```bash
git add tests/smoke.spec.ts README.md
git commit -m "docs: document sandbox backend mode"
```

---

## Self-Review

- **Spec 覆盖**：后端选择模型（`backend:'sandbox'`）→ Task 4/5；按 agent 键 → Task 3（`agentIdOf`）+ Task 5（`agent/disposed`）；端口分配 → Task 2；并发上限/空闲回收 → Task 3；headless 默认 false → Task 4；配置扁平 → Task 4；session 结束释放 → Task 5。全部覆盖。
- **占位符扫描**：无 TBD；`chromeArgs` 抽纯函数后单测路径已给出；`agent/disposed` 收不到时的兜底已明确写为验证步骤。
- **类型一致性**：`SandboxFactory = (config: ResolvedChromeConfig) => BrowserBackend`（Task 3）与 Task 5 工厂实现一致；`resolve(exec): BrowserBackend` 与 `chromeToolDefinitions(resolve, ...)` 一致；`sandboxMaxConcurrent/sandboxIdleMs/sandboxHeadless` 三处（`ChromePluginConfig`/`Config`/`ResolvedChromeConfig`）命名一致。
