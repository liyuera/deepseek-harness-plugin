# 沙箱浏览器后端注册表（BackendRegistry）设计方案

> **状态：** 已评审，决策已锁定（见 §9）。最终实现代码见 [sandbox-backend-registry-plan.md](sandbox-backend-registry-plan.md)。
> **目标：** 让插件从「单例后端」升级为「按会话分配沙箱实例」，使多个 agent 能**并行**驱动各自隔离的浏览器；扩展后端保留为「用户真实浏览器」通道。

**Architecture:** 在 `apply()` 的单例 `buildBackend()` 之上加一层 `BackendRegistry`：扩展后端仍是共享单例，沙箱后端按 `sessionId` 懒建、池化、空闲回收、会话结束释放。工具 execute 用 `exec.agent.session.id` 解析后端，其余（activity / routes / help）不动或仅微调。

**Tech Stack:** TypeScript + Cordis（`@deepseek-ai/cordis`）+ 现有 `Chrome`/`CdpBackend`（CDP owned 模式）+ Node 内建。**不引入 Playwright/Puppeteer。**

---

## 0. 已验证的 DSH 事实（本方案的底座）

| 事实 | 依据 |
| --- | --- |
| `isConcurrencySafe` 只作用于「单 agent 单步内的工具批」，不跨会话 | `@deepseek-ai/dsh-tools/src/pipeline.ts:106` + `batch.ts:50`（barrier/pool 全是批内局部变量，无跨批锁） |
| 每个会话有独立 loop，各自 `tools.execute()`，无全局闸门 | `@deepseek-ai/dsh-agent-loop/src/agent.ts:594-599`（`this`=该 agent、自己的 `signal`） |
| `maxParallelToolCalls`（默认 10）是单步内重叠上限，非跨会话门 | `@deepseek-ai/dsh-agent-loop/src/index.ts:295` |
| 会话身份在工具执行时可得：`exec.agent.session.id` | 插件现有 `activity.ts:161` 的 `sessionIdOf` |
| 会话结束事件：`agent/disposed`（payload `{ agent }`）、`session/disposed` | `@deepseek-ai/dsh-agent/src/runtime-types.ts:300` |
| `Chrome` 实例按 `port` + `profileDir` 绑定，`defaultProfileDir(port)` 按端口区分 profile，多实例天然隔离 | `chrome.ts:423` / `chrome.ts:279` |
| `Chrome.ensure()` 惰性 spawn，构造函数不 spawn | `chrome.ts:466` |
| `owned` 模式 dispose 会 SIGTERM 杀掉自己的实例，绝不杀用户浏览器 | `chrome.ts:658` |

**结论（上一条已确认）：并行卡点 100% 在插件自己的单例后端，不在 harness。本方案把它拆掉。**

---

## 1. 后端选择模型（Decision Point #1，需拍板）

扩展后端是「用户真实浏览器」：单租户、含登录态/已打开标签页。沙箱是「AI 自己的浏览」：隔离、可并行、无登录态。二者是**正交能力，不是主备**。落地有三种选择：

| 方案 | 说明 | 代价 |
| --- | --- | --- |
| **A. 配置开关（推荐 v1）** | `backend` 新增 `'sandbox'`；开启后工具默认走按会话沙箱，`@` 菜单/标签页路由始终走扩展 | 最小、正确；v1 内工具无法按调用切到用户浏览器 |
| B. 逐调用参数 | 每个 `chrome_*` 加 `backend: 'sandbox' | 'user'` | 灵活但 17 个工具都改、模型要学何时选 |
| C. 混合自动 | 默认沙箱；`@` 引用注入上下文带「用户浏览器」标记时路由到扩展 | 最贴合语义，但要在 mentions 上下文里加标记 + 解析，改动最大 |

**推荐 A（v1）+ B/C 作为 v2 的逐任务选择**。理由：先交付并行能力，用户浏览器通道不丢（`backend: 'extension'` 保留原行为），per-call 选择留到并行跑通后再加。

---

## 2. 核心接口

> **评审后调整：** 键按 `agent.id`（每个子代理独立）而非 `sessionId`；`sandboxHeadless` 默认 `false`。下面代码块里的 `sessionIdOf`/`sessionId` 请读作 `agentIdOf`/`agentId`；最终代码以 [实现计划](sandbox-backend-registry-plan.md) 为准。

新增 `src/backend-registry.ts`。命名沿用现有文件风格（小写 + 连字符）。

```ts
// src/backend-registry.ts
import type { BrowserBackend } from './backend.ts'
import { CdpBackend } from './backend.ts'
import type { ResolvedChromeConfig } from './chrome.ts'
import { Chrome } from './chrome.ts'
import type { ConsoleLog } from './console-log.ts'
import { sessionIdOf } from './caller.ts' // 从 activity.ts 抽出的共享 helper

/** 一个按会话租用的沙箱实例及其回收簿记。 */
interface SandboxLease {
  readonly sessionId: string
  readonly backend: CdpBackend
  readonly chrome: Chrome
  readonly port: number
  lastUsedAt: number
  idleTimer?: NodeJS.Timeout
}

/** 端口分配：固定递增 + 释放回用；绝不改用 OS 端口 0（Chrome 151 不写 DevToolsActivePort）。 */
class PortAllocator {
  private next: number
  private readonly free: number[] = []
  constructor(basePort: number) { this.next = basePort }
  allocate(): number { return this.free.pop() ?? this.next++ }
  release(port: number): void { this.free.push(port) }
}

/**
 * 拥有插件驱动的所有浏览器后端：
 * - shared = 扩展后端（backend:'extension'）或单实例 CDP（backend:'cdp'），只建一次；
 * - sandboxes = 按 sessionId 池化的 owned CDP 实例（backend:'sandbox'）。
 */
export class BackendRegistry {
  private readonly shared: BrowserBackend
  private readonly sandboxes = new Map<string, SandboxLease>()
  private readonly ports: PortAllocator

  constructor(
    private readonly config: ResolvedChromeConfig,
    private readonly consoleLog: ConsoleLog,
    private readonly sharedBackend: BrowserBackend,
  ) {
    this.ports = new PortAllocator(config.port)
    this.shared = sharedBackend
  }

  /** 一次工具调用该驱动哪个后端。sandbox 模式按会话；否则回退 shared。 */
  resolve(exec: unknown): BrowserBackend {
    if (this.config.backend !== 'sandbox') return this.shared
    const sessionId = sessionIdOf(exec)
    if (sessionId === undefined) return this.shared // 无会话身份的调用（服务/agent-less）走 shared
    return this.ensureSandbox(sessionId).backend
  }

  /** 触摸 + 必要时回收空闲/建新实例。spawn 是惰性的：Chrome.ensure() 在首次操作时才拉起。 */
  private ensureSandbox(sessionId: string): SandboxLease {
    const existing = this.sandboxes.get(sessionId)
    if (existing !== undefined) {
      existing.lastUsedAt = Date.now()
      this.armIdle(existing)
      return existing
    }
    this.evictIdle()
    if (this.sandboxes.size >= this.config.sandboxMaxConcurrent) {
      throw new Error(
        `chrome-browser 沙箱池已达上限(${this.config.sandboxMaxConcurrent});`
        + '没有可回收的空闲会话。等待其它会话空闲回收，或调大 sandboxMaxConcurrent。',
      )
    }
    const port = this.ports.allocate()
    const chrome = new Chrome(this.sandboxConfig(port))
    const backend = new CdpBackend(chrome, (tabId, msg) => this.consoleLog.append(tabId, msg))
    const lease: SandboxLease = { sessionId, backend, chrome, port, lastUsedAt: Date.now() }
    this.sandboxes.set(sessionId, lease)
    this.armIdle(lease)
    return lease
  }

  /** 会话结束：释放并销毁该会话的沙箱，归还端口。幂等。 */
  release(sessionId: string): void {
    const lease = this.sandboxes.get(sessionId)
    if (lease === undefined) return
    this.sandboxes.delete(sessionId)
    clearTimeout(lease.idleTimer)
    this.ports.release(lease.port)
    lease.backend.dispose() // → chrome.dispose()：owned 模式 SIGTERM，绝不杀用户浏览器
  }

  /** 插件卸载：释放全部沙箱 + shared。 */
  dispose(): void {
    for (const sessionId of [...this.sandboxes.keys()]) this.release(sessionId)
    this.shared.dispose()
  }

  /** 每个沙箱用独立端口 → 独立 profile（defaultProfileDir 已按端口区分）。 */
  private sandboxConfig(port: number): ResolvedChromeConfig {
    return { ...this.config, port, profileDir: undefined }
  }

  /** 空闲超时回收（安全网：会话没触发 agent/disposed 时也能被回收）。 */
  private armIdle(lease: SandboxLease): void {
    if (!(this.config.sandboxIdleMs > 0)) return
    clearTimeout(lease.idleTimer)
    const timer = setTimeout(() => {
      if (this.sandboxes.get(lease.sessionId) === lease) this.release(lease.sessionId)
    }, this.config.sandboxIdleMs)
    ;(timer as { unref?: () => void }).unref?.()
    lease.idleTimer = timer
  }

  private evictIdle(): void {
    // 只回收「已超空闲阈值」的租约，绝不回收仍有活动的租约。
    const now = Date.now()
    for (const [sessionId, lease] of this.sandboxes) {
      if (now - lease.lastUsedAt >= this.config.sandboxIdleMs) this.release(sessionId)
    }
  }
}
```

> 注：`profileDir: undefined` 依赖 `resolveChromeConfig` 的默认值逻辑（`owned` 模式 → `defaultProfileDir(port)`）。实现时若 `sandboxConfig` 直接改 `port` 后仍保留旧 `profileDir`，会造成两个实例抢同一 profile——**必须让 profileDir 随 port 重算**（见「集成点改动」第 3 条，用 `resolveChromeConfig` 或显式 `defaultProfileDir(port)`）。

---

## 3. 配置面（Decision Point #2：字段命名，可改）

沿用现有扁平风格，`Config` / `ChromePluginConfig` / `ResolvedChromeConfig` 三处同步加：

```ts
// backend 联合新增 'sandbox'
backend: z.union([z.const('extension'), z.const('cdp'), z.const('sandbox')]).default('extension')

// 仅 backend === 'sandbox' 时生效：
sandboxMaxConcurrent: z.number().step(1).min(1).default(4)
sandboxIdleMs: z.number().step(1).min(0).default(10 * 60_000) // 0 = 永不空闲回收
sandboxHeadless: z.boolean().default(false)
```

`resolveChromeConfig` 需补这些默认值，并在 `chromeArgs` 里当 `sandboxHeadless` 时追加 `--headless=new`（当前 [chrome.ts:754](src/chrome.ts#L754) 无 headless 分支）。

---

## 4. 文件结构

**新增：**
- `src/backend-registry.ts` —— 上面的注册表 + `PortAllocator` + `SandboxLease`
- `src/caller.ts` —— 从 `activity.ts` 抽出 `sessionIdOf`（activity 与 registry 共用）
- `tests/backend-registry.spec.ts` —— 注册表单测（见 §7）
- `tests/caller.spec.ts` —— `sessionIdOf` 单测（若 activity 已有覆盖则并入）

**修改：**
- `src/index.ts:104-128` —— `apply()` 用 `BackendRegistry` 取代单例；挂 `agent/disposed` 回收
- `src/tools.ts:238` —— `chromeToolDefinitions` 的入参从 `backend` 改为 `registry`（或一个 `resolveBackend: (exec) => BrowserBackend` 函数）；`resolveTabId` 改成先解析后端
- `src/activity.ts:161` —— `sessionIdOf` 抽出（或 export 供 caller.ts 引用）
- `src/chrome.ts` —— `chromeArgs` 加 headless 分支；确认 `resolveChromeConfig` 默认值
- `src/routes.ts` —— `/chrome-browser/tabs` 仍走 **shared（扩展）** 后端，`@` 菜单永远列用户标签页

**不动：** `src/backend.ts`（`CdpBackend`/`ExtensionBackend` 已够用）、`src/help.ts`、`src/mentions.ts`、`src/console-log.ts`（tabId 为 CDP target UUID，跨实例不冲突，单实例共享 `ConsoleLog` 即可）。

---

## 5. 集成点改动（关键步骤，按序）

1. **`tools.ts` 的后端解析**：把 `chromeToolDefinitions(backend, config, consoleLog, help)` 的第 1 个参数换成 `registry: BackendRegistry`。每个工具 execute 里，`resolveTabId` 之前先 `const backend = registry.resolve(exec)`，再用该 `backend` 做 `listTabs/read/click/...`。17 个工具的 execute 都是「先拿 backend 再操作」，改动机械但量大——用一次 `sed` 级重构：把闭包里的 `backend` 改成 `exec` 处解析。

   更稳的替代：保留工具闭包签名不变，只把「闭包捕获的 backend」从常量换成 `exec => registry.resolve(exec)`，即给 `chromeToolDefinitions` 传一个 `resolve: (exec: unknown) => BrowserBackend` 函数。这样 17 个工具体不用逐个改，只要 `resolveTabId` 改成接收 `backend` 并在调用点先解析。

2. **`index.ts`**：`const registry = new BackendRegistry(resolved, consoleLog, buildBackend(resolved, sink).backend)`；工具注册传 `registry`；新增：
   ```ts
   ctx.on('agent/disposed', (payload) => {
     const id = (payload as { agent?: { session?: { id?: unknown } } }).agent?.session?.id
     if (typeof id === 'string' && id !== '') registry.release(id)
   })
   ```
   `ctx.effect` 卸载钩子里 `registry.dispose()`（替代现在的 `backend.dispose()`）。

3. **profileDir 随 port 重算**：`sandboxConfig(port)` 必须产出「port=port 且 profileDir=defaultProfileDir(port)」的 config。实现用 `resolveChromeConfig({ ...this.config, port })` 让它按新 port 重算默认 profileDir，而不是手拼 `profileDir: undefined`。

4. **`routes.ts`**：`/chrome-browser/tabs` handler 现在闭包持有 `backend`——改成持有 **shared 后端**（`registry` 里暴露 `shared`，或直接保留扩展后端引用）。`/chrome-browser/activity` 不动（已按 sessionId）。

5. **`chrome_console` 的 `capturingTabs`**：现在 `consoleLog.tracked()` 会跨所有沙箱并集。若想按会话隔离展示，后续再改 `ConsoleLog` 加 sessionId 维度；v1 接受「全局并集」这一可读性折衷（不影响正确性）。

---

## 6. 边界情况

| 场景 | 处理 |
| --- | --- |
| 无会话身份（agent-less / 服务调用） | `resolve` 回退 shared 后端 |
| 沙箱池满且无空闲可回收 | 抛明确错误，提示等空闲或调大 `sandboxMaxConcurrent`（**绝不回收活动中的租约**） |
| 会话结束但未触发事件 | `sandboxIdleMs` 空闲回收兜底 |
| 会话结束事件 payload 形状 | 用 `agent/disposed`（payload `{ agent }`，读 `agent.session.id`）；实现时验证根上下文能否收到 scope-filtered 事件（现有 `agent/pre-step` 已从根 `ctx.on` 生效，大概率可行；不行则换 `session/disposed`） |
| 子代理（subagent / agent team） | **Decision Point #3**：当前按 `sessionId` 键，同 session 的子代理共享一个沙箱。若要求「每个子代理一个沙箱」，键改成 agent 身份（`agent.id` 或 agent 对象引用）。v1 先用 sessionId，标记待定 |
| 端口耗尽（大量会话） | `PortAllocator` 只会 `next++`，不设上界；由 `sandboxMaxConcurrent` 约束实际实例数，端口与实例 1:1，不会无限增长 |
| `chrome_open` 幂等去重跨沙箱 | 每个 `CdpBackend` 各自有「同 URL 复用已有 tab」逻辑（[backend.ts:1131](src/backend.ts#L1131)），跨实例不共享、互不干扰，符合预期 |

---

## 7. 测试策略

`tests/backend-registry.spec.ts`（纯单测，注入假 backend / 假 Chrome，不碰真浏览器）：

- `resolve`：`backend:'extension'` → 恒 shared；`backend:'sandbox'` 且无 sessionId → shared；有 sessionId → 同 session 返回同一实例、不同 session 返回不同实例。
- `PortAllocator`：递增、释放回用、不重号。
- 空闲回收：假时钟推进 `sandboxIdleMs` 后 release（用 `vi.useFakeTimers`）。
- 池上限：造满 `maxConcurrent` 个活跃会话后，再建抛错且不回收活跃租约。
- `release` 幂等 + 归还端口 + 调 `backend.dispose()`。
- `dispose` 释放全部 + shared。
- headless 旗标：`chromeArgs` 在 `sandboxHeadless` 时含 `--headless=new`。

`tests/caller.spec.ts`：`sessionIdOf` 对 `{agent:{session:{id}}}` / 缺省 / 非字符串 的归一。

smoke（`DSH_CHROME_SMOKE=1`）：两个伪造 sessionId 并发 `resolve` → 各自 `chrome_tabs` 返回各自实例的标签页，验证并行隔离。

---

## 8. 实现顺序（评审通过后拆 TDD 计划）

1. **M1** `caller.ts` 抽出 `sessionIdOf` + 单测。
2. **M2** `PortAllocator` + 单测。
3. **M3** `BackendRegistry`（resolve/ensure/release/dispose/空闲回收）+ 单测。
4. **M4** `Config` 增 `sandbox*` + `chromeArgs` headless 分支 + 单测。
5. **M5** `index.ts`/`tools.ts`/`routes.ts` 接线（单例 → registry）。
6. **M6** smoke 并行验证 + README 更新。

---

## 9. 已拍板决策

| 决策点 | 结论 |
| --- | --- |
| 后端选择模型 | **A 配置开关**：`backend` 新增 `'sandbox'`；`@` 菜单/标签页路由始终走扩展 |
| 配置字段命名 | **扁平**：`sandboxMaxConcurrent` / `sandboxIdleMs` / `sandboxHeadless` |
| 子代理键 | **按 agent 身份**：键用 `agent.id`（每个子代理独立沙箱） |
| headless 默认 | **`false`**（沙箱默认有窗口，可被用户看到） |
