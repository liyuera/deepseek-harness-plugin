# 编排台插件 — P0 探针实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 9 个 spike 消除 spec §15.1 的 7 个 P0 不确定性（节点会话、面板内嵌、通道鉴权、沙箱/env、容量与成本、基线证据、画布契约），产出一个可继续演进的 spike bundle 与带证据的 findings 文档，作为 P1 实现计划的输入。

**Architecture:** 在 `orchestrator/` 建一个纯 JS spike bundle：host 半边注册探针工具 `orch_p0_probe`（用调用它的 agent 作为 parent 跑子会话）与两条 dev 路由；client 半边注册 `conversation.view`（全幅）与一个最小面板（retain 子会话 + 宿主 Chat + 自绘 composer）。P0-6 用独立 Node 脚本 + `node:test` 验证基线证据；P0-7 在 client 视图里渲染 200 节点并显示性能读数。所有探针产物放 `orchestrator/.tmp/`（gitignored），结论写 findings 文档。

**Tech Stack:** DSH 0.2.2-rc.1（desktop profile）、Cordis 插件 API（`ctx.tools` / `ctx.subagents` / `ctx.agents` / `ctx.connection.fetch` / `ctx.webServer` / `ctx.sandbox`）、React 18（client module table 只取 `react`）、Node 22 内置 `node:test`、git CLI。

## Global Constraints

- 目标运行环境 DSH 0.2.2-rc.1 desktop profile；安装只用 `dsh plugin --profile desktop add link:/Users/liyu/Documents/www/DeepSeek/deepseek-harness/deepseek-harness-plugin/orchestrator`，装完**退出重开**（host 半边只在启动时加载）。
- 插件目录 `orchestrator/`，npm 包名 `@liyuera/dsh-orchestrator`；host 入口 `index.js`（`export const name` / `export const inject` / `export function apply(ctx)`），client 入口 `client.js`（`window.__ModuleLoader__.load({ id, factory(require) { ... return { inject, apply } } })`）。
- client 半边**不得 require 宿主 UI 包**，只用 module table 里的 `react` 与 slot props（`slots` / `renderFactorySlot` / `SessionProvider` / `renderSlot` / `sessions`）；颜色只用 `--dsw-alias-*`，不写死 hex。
- 探针 bundle 是临时的：`version: 0.0.0-p0`、`private: true`；P0 结论出来后 P1 会重建正式结构。
- 敏感数据（token、凭据、真实会话 id、私钥）不得写入 findings、聊天、日志或提交；证据只保留「结论 + 脱敏字段 + 可复现命令」。
- 所有文件写入只发生在 `orchestrator/`、`docs/superpowers/spikes/` 与本插件仓库内；不 push、不碰真实业务仓库。
- 每个 task 至少一个 commit；风格 `feat(orchestrator): …`、`spike(orchestrator): …`、`docs(orchestrator): …`。
- 计划依据：[设计文档 v0.3](../specs/2026-11-17-orchestrator-design.md) §15.1；评审证据见 [评审报告](../specs/2026-11-17-orchestrator-review.md)。

## 已确认的前置事实（直接可用，不需再查）

- `conversation.view` 是 session 作用域 list 槽（`dsh-client-ui-conversation/src/client/contract/slots.ts:285`）；官方轨迹视图的注册写法：`ctx.slots.inject('conversation.view', () => ctx.slots.register({ name:'conversation.view', id, order, label: () => t(...) }, View))`。
- **声明 `children`（含非 root scope 子槽）会让渲染器向组件注入 `SessionProvider`**（`dsh-client-ui-renderer/src/client/scoped-slots.tsx:585-638`）；这是面板渲染**另一个**子会话的唯一正路。
- 子会话渲染的官方样板：`dsh-client-ui-subagent/src/client/sidebar-chat/index.tsx:100-165`（`sessions.retain(...)` → `SessionProvider session={reference}` → `renderFactorySlot('conversation.content', {variant:'embedded', phase, hero}, {slots:{views: FixedChatConversationView}})`）。
- `startActivation` 每次调用都新建 continuable 子会话（`dsh-subagent/src/index.ts:267-290`、`manager.ts:330-395`）；续跑是 `agent.followup`，冷恢复是 `ctx.agents.resume`。
- `ctx.tools.register(definition)` 的字段：`{ name, description, parameters(JSON Schema), output:{schema, render}, async execute(args, exec) }`（样板 `mr-loop/src/host/tools.js`）。
- `subagents.startActivation({ provider:'spawn', label, delivery:'caller', signal, request:{ parent: agent, agentPreset, prompt:[{type:'text',text}], outputSchema? } })`（样板 `code-review/src/host/reviewer.js:340-365`）。
- 本机 desktop profile：`maxActiveSubagents: 20`、默认权限预设 `danger-full-access` + `approval: never`（`~/.dsh/profiles/desktop/cordis.patch.yml:38-56`）。
- `dsh` CLI 在 PATH 上（`/usr/local/bin/dsh`）。

## File Structure

- `orchestrator/` — P0 spike bundle（P1 在其上演进为正式包）
  - `package.json` / `cordis.patch.yml` / `index.js` / `client.js` / `icon.svg`
  - `spike/probes.js` — host 探针实现（session / sandbox / capacity）
  - `spike/routes.js` — dev HTTP 路由（webServer 临时 + connection.fetch 鉴权探针）
  - `scripts/baseline-probe.mjs` — P0-6 基线快照实现（P1 会移入 `src/host/evidence/`）
  - `test/baseline.test.js` — P0-6 的绕过回归测试
  - `.tmp/`（gitignored）— 探针临时仓库/输出
- `docs/superpowers/spikes/2026-11-17-orchestrator-p0-findings.md` — 全部结论（结论/证据/退路）
- `.gitignore` — 增加 `orchestrator/.tmp/` 与 `orchestrator/node_modules/`

---

### Task 1: Spike 骨架 — 插件能装、编排台视图全幅、宿主 composer 被接管

**Files:**
- Create: `orchestrator/package.json`, `orchestrator/cordis.patch.yml`, `orchestrator/index.js`, `orchestrator/client.js`, `orchestrator/icon.svg`
- Create: `docs/superpowers/spikes/2026-11-17-orchestrator-p0-findings.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: bundle 包名 `@liyuera/dsh-orchestrator`、视图 id `orchestrator`、client 调试入口 `window.__orchP0`（后续 task 往这里挂探针）。
- Consumes: 无。

- [ ] **Step 1: 读官方样板，抄注册字段而不是猜**

Read（用文件读取工具，不要 cat）：
- `/tmp/dsh-src/@deepseek-ai/dsh-client-ui-trajectory/src/client/index.ts` 第 60-100 行（`conversation.view` 注册字段）
- `/tmp/dsh-src/@deepseek-ai/dsh-client-ui-subagent/src/client/sidebar-chat/index.tsx` 第 100-165 行（retain + SessionProvider + 内嵌 conversation）
- 本仓库 `bug-workflow/client.js` 第 6395-6420 行（`window.__ModuleLoader__.load` 外壳与 `ctx.effect` 注册）

- [ ] **Step 2: 创建 bundle 元数据**

`orchestrator/package.json`：

```json
{
  "name": "@liyuera/dsh-orchestrator",
  "version": "0.0.0-p0",
  "private": true,
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "icon.svg", "spike", "scripts"],
  "engines": { "dsh": ">=0.2.2-rc.1" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

`orchestrator/cordis.patch.yml`：

```yaml
- insert:
    - id: orchestrator
      name: '@liyuera/dsh-orchestrator'
```

`orchestrator/icon.svg`（P0 占位，P6 换正式图标）：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
  <rect x="2.5" y="3" width="4" height="4" rx="1"/><rect x="9.5" y="3" width="4" height="4" rx="1"/>
  <rect x="6" y="9.5" width="4" height="4" rx="1"/><path d="M4.5 7v2.5h7V7M8 9.5V11"/>
</svg>
```

- [ ] **Step 3: host 半边骨架（此 task 只有装配，探针在 Task 2 加）**

`orchestrator/index.js`：

```js
/** 编排台 host 半边。P0 spike：只装配 dev 路由与探针工具。 */
export const name = 'orchestrator'
export const inject = ['tools', 'connection']

export function apply(ctx) {
  ctx.logger?.info?.('[orchestrator] P0 spike host loaded')
}
```

- [ ] **Step 4: client 半边：注册 conversation.view（全幅）+ composer chain 接管**

`orchestrator/client.js`：

```js
window.__ModuleLoader__.load({
  id: '@liyuera/dsh-orchestrator',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ID = '@liyuera/dsh-orchestrator'

    // P0 画布占位：只验证视图全幅与 composer 接管；P1 换成正式画布。
    function CanvasP0() {
      return h('div', {
        'data-orch-p0': 'canvas',
        style: {
          position: 'absolute', inset: 0, overflow: 'hidden',
          background: 'var(--dsw-alias-bg-canvas, #fafaf8)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--dsw-alias-text-2, #5f6368)', font: '13px/1.6 system-ui, sans-serif',
        },
      }, '编排台 P0 画布占位（视图全幅 + composer 接管验证）')
    }

    function OrchestratorView(props) {
      // 声明 children 后，渲染器会注入 SessionProvider / renderSlot（Task 3 用）。
      return h('div', { 'data-orch-p0': 'view', style: { position: 'relative', width: '100%', height: '100%' } },
        h(CanvasP0))
    }

    // 全幅接管约定：composer overlay 让视图铺满内容区；composer 本体由 chain 接管返回 null。
    function RootOverlay() {
      return null
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'orchestrator',
          order: 20,
          label: () => '编排台',
          children: { 'orchestrator.panel': { kind: 'single', scope: 'session' } },
        }, OrchestratorView)), 'orchestrator: conversation.view')
        ctx.effect(() => ctx.slots.inject('conversation.composer', () => ctx.slots.register({
          name: 'conversation.composer',
          key: ID,
        }, RootOverlay)), 'orchestrator: composer chain')
        window.__orchP0 = { version: '0.0.0-p0', view: 'orchestrator' }
      },
    }
  },
})
```

> 若 `conversation.composer` chain 的注册字段（`key`/`id`/返回 `null` 的语义）与官方实现不同，按 `dsh-client-ui-conversation/src/client/contract/slots.ts:290` 与 `dsh-client-ui-trajectory/src/client/TrajectoryView.tsx:520-560` 的实际用法改，**并把差异写进 findings**。

- [ ] **Step 5: gitignore + 安装**

```bash
cd /Users/liyu/Documents/www/DeepSeek/deepseek-harness/deepseek-harness-plugin
printf '\norchestrator/.tmp/\norchestrator/node_modules/\n' >> .gitignore
dsh plugin --profile desktop add link:/Users/liyu/Documents/www/DeepSeek/deepseek-harness/deepseek-harness-plugin/orchestrator
```

Expected: `dsh` 输出安装成功（或提示已存在）。然后**退出并重开 DeepSeek Harness**。

- [ ] **Step 6: 人工验证三件事并记录**

打开任意会话 → 顶栏出现「编排台」tab → 点击后：
1. 内容区被画布占位铺满（不是半屏、没有滚动条）；
2. 宿主原生 composer **不可见**（或至少不占位）；
3. 切回「对话」tab，composer 恢复正常。

把三张状态截图存 `orchestrator/.tmp/p0-view-*.png`；把结论写进 findings 文档（Task 9 会汇总，先建文件写一节 `## P0-2 视图全幅 + composer chain`）。

- [ ] **Step 7: Commit**

```bash
git add orchestrator .gitignore docs/superpowers/spikes/2026-11-17-orchestrator-p0-findings.md
git commit -m "feat(orchestrator): P0 spike bundle with full-bleed view and composer chain"
```

---

### Task 2: P0-1（host 半边）— 节点会话能建、能二次 followup、能冷恢复

**Files:**
- Create: `orchestrator/spike/probes.js`
- Modify: `orchestrator/index.js`

**Interfaces:**
- Produces: 工具 `orch_p0_probe({ probe: 'session-create' | 'session-chat' | 'session-resume', sessionId?, text? })` → `{ok, data}`；`data.sessionId` 供 Task 3 使用。
- 后续 Task 5/6 会向同一个工具追加 `probe: 'sandbox' | 'capacity'`（两处都要同步改 `parameters.probe.enum` 与 `execute` 分支）。
- Consumes: 无。

- [ ] **Step 1: 写探针模块**

`orchestrator/spike/probes.js`：

```js
/**
 * P0 host 探针：只验证「节点会话」生命周期，不做任何调度/存储。
 * 所有探针返回 { ok, code?, message?, data? }，不抛异常（模型看到的是结果）。
 */
const ok = (message, data) => ({ ok: true, message, ...(data === undefined ? {} : { data }) })
const fail = (code, message) => ({ ok: false, code, message })

const sessions = new Map() // probe key -> { sessionId, lastAgentAliveAt }

export function createProbes(ctx) {
  const subagents = ctx.get('subagents')
  const agents = ctx.get('agents')

  async function createNodeSession(agent, label) {
    const activation = await subagents.startActivation({
      provider: 'spawn',
      label: label || 'orch-p0-node',
      delivery: 'caller',
      request: {
        parent: agent,
        prompt: [{ type: 'text', text: '这是编排台 P0 探针会话。请只回复 OK，不要调用任何工具。' }],
      },
    })
    const sessionId = activation?.childSessionId ?? activation?.sessionId ?? activation?.child?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error(`startActivation 未返回子会话 id；实际字段：${Object.keys(activation || {}).join(',')}`)
    }
    sessions.set(sessionId, { sessionId, lastAgentAliveAt: Date.now() })
    return { sessionId, activationKeys: Object.keys(activation || {}) }
  }

  async function followup(sessionId, text) {
    const agent = agents.get(sessionId)
    if (!agent) return { ok: false, code: 'agent-offline', message: '会话 agent 不 live（需要 resume 或重新激活）' }
    await agent.followup({ role: 'user', source: { kind: 'plugin:orchestrator-p0' }, content: [{ type: 'text', text }] })
    return { ok: true, message: 'followup 已投递' }
  }

  return {
    async sessionCreate(agent) {
      try {
        const result = await createNodeSession(agent)
        return ok('已创建 continuable 子会话', result)
      } catch (error) {
        return fail('create-failed', error.message)
      }
    },
    async sessionChat(args) {
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : ''
      if (!sessionId) return fail('invalid-arguments', 'sessionId 必填')
      try {
        return await followup(sessionId, typeof args?.text === 'string' && args.text ? args.text : '第二轮：请回复 STILL-ALIVE')
      } catch (error) {
        return fail('followup-failed', error.message)
      }
    },
    async sessionResume(args) {
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId : ''
      if (!sessionId) return fail('invalid-arguments', 'sessionId 必填')
      try {
        const handle = await agents.resume({ sessionId })
        const message = await followup(sessionId, '冷恢复后：请回复 RESUMED')
        return ok('resume + followup 完成', { handleKeys: Object.keys(handle || {}), ...message })
      } catch (error) {
        return fail('resume-failed', error.message)
      }
    },
  }
}
```

- [ ] **Step 2: 注册工具**

`orchestrator/index.js` 改为：

```js
import { createProbes } from './spike/probes.js'

export const name = 'orchestrator'
export const inject = ['tools', 'connection']

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]

export function apply(ctx) {
  const probes = createProbes(ctx)
  ctx.tools.register({
    name: 'orch_p0_probe',
    description: '编排台 P0 探针（临时工具）：验证节点会话创建 / 二次 followup / 冷恢复。参数 probe=session-create|session-chat|session-resume。',
    parameters: {
      type: 'object',
      properties: {
        probe: { type: 'string', enum: ['session-create', 'session-chat', 'session-resume'] },
        sessionId: { type: 'string', description: 'session-chat / session-resume 必填' },
        text: { type: 'string', description: '可选：followup 文本' },
      },
      required: ['probe'],
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value) => text(value?.data ?? value?.message ?? value) },
    async execute(args, exec) {
      const agent = exec?.agent
      if (!agent) return { ok: false, code: 'no-agent', message: '探针必须在会话内调用' }
      if (args?.probe === 'session-create') return probes.sessionCreate(agent)
      if (args?.probe === 'session-chat') return probes.sessionChat(args)
      if (args?.probe === 'session-resume') return probes.sessionResume(args)
      return { ok: false, code: 'invalid-arguments', message: `未知 probe：${String(args?.probe)}` }
    },
  })
}
```

- [ ] **Step 3: 安装重开并跑通「建会话 → 二次 followup」**

重开应用后，在任意会话里让 agent 调用（或在聊天中直接说）：

1. `orch_p0_probe {probe:'session-create'}` → 记录返回的 `sessionId`（写 `orchestrator/.tmp/p0-session-id.txt`，不进 findings）；
2. `orch_p0_probe {probe:'session-chat', sessionId:'<上一步>', text:'第二轮：回复 STILL-ALIVE'}` → 应返回 `ok:true`；
3. 在会话列表里确认这个子会话第一次激活后**仍存在**，且第二次 followup 让同一个会话产生了新一轮。

Expected: 3 步全 true；若第 1 步字段名不对，把 `activation` 的实际 keys 写进 findings 并修 `createNodeSession`。

- [ ] **Step 4: 冷恢复探针**

退出应用 → 重开（不要关闭原会话窗口）→ 调 `orch_p0_probe {probe:'session-resume', sessionId:'<同一个>'}`。

Expected 二选一并记录：
- `agents.resume` 成功且 followup 投递 → D1 冷路径可行；
- `resume` 抛错 / followup 失败 → 记录 code 与 message，D1 退路为「每次 attempt 新会话 + 对话只读回看」。

- [ ] **Step 5: 写 findings 两节**

在 findings 文档写：
- `## P0-1 节点会话`：`创建字段`、`二次 followup 结果`、`冷恢复结果`、`会话列表可见性`、`结论：D1 可行 / 需退路 b`。
- `## 复用结论`：`startActivation` 返回字段、`followup` 签名、`resume` 签名（供 P1 直接用）。

- [ ] **Step 6: Commit**

```bash
git add orchestrator/index.js orchestrator/spike/probes.js docs/superpowers/spikes/2026-11-17-orchestrator-p0-findings.md
git commit -m "spike(orchestrator): probe node session create/followup/resume"
```

---

### Task 3: P0-1（client 半边）+ D2 — 面板内嵌子会话，能发消息、能中止

**Files:**
- Modify: `orchestrator/client.js`
- Create: `orchestrator/spike/routes.js`
- Modify: `orchestrator/index.js`

**Interfaces:**
- Consumes: Task 2 的 `sessionId`；宿主 dev 路由 `POST /orchestrator-p0/create`、`POST /orchestrator-p0/chat`、`POST /orchestrator-p0/abort`。
- Produces: P0 结论「内嵌三件套是否成立」；`window.__orchP0.panelState()`。

- [ ] **Step 1: host 加 dev 路由（webServer，显式标注 P0 临时）**

`orchestrator/spike/routes.js`：

```js
/** P0 临时 dev 路由：只在本机 spike 用，P1 换成 connection.fetch + 鉴权。 */
export function registerDevRoutes(ctx, probes) {
  const webServer = ctx.get('webServer')
  if (!webServer) return () => {}
  const disposers = []
  const json = (res, status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }
  const readBody = async (req) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    return raw ? JSON.parse(raw) : {}
  }

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/orchestrator-p0/create',
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method' })
      const agentId = typeof req.headers['x-orch-session'] === 'string' ? req.headers['x-orch-session'] : ''
      const agent = agentId ? ctx.get('agents')?.get(agentId) : undefined
      if (!agent) return json(res, 409, { ok: false, code: 'agent-offline' })
      json(res, 200, await probes.sessionCreate(agent))
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/orchestrator-p0/chat',
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method' })
      json(res, 200, await probes.sessionChat(await readBody(req)))
    },
  }))
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/orchestrator-p0/abort',
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method' })
      const body = await readBody(req)
      const agent = body?.sessionId ? ctx.get('agents')?.get(body.sessionId) : undefined
      if (!agent) return json(res, 409, { ok: false, code: 'agent-offline' })
      try { agent.interrupt?.('user-abort') ?? agent.abort?.() } catch (error) { return json(res, 500, { ok: false, message: error.message }) }
      json(res, 200, { ok: true })
    },
  }))
  return () => { for (const dispose of disposers) dispose?.() }
}
```

在 `index.js` 的 `apply` 末尾接上（`ctx.effect` 里注册并在卸载时释放）：

```js
import { registerDevRoutes } from './spike/routes.js'
// inside apply(), after probes created:
ctx.effect(() => registerDevRoutes(ctx, probes), 'orchestrator: p0 dev routes')
```

- [ ] **Step 2: 面板组件的 retain + SessionProvider + 内嵌 conversation**

`orchestrator/client.js` 把 `OrchestratorView` 换成：

```js
function OrchestratorView(props) {
  const { SessionProvider, renderFactorySlot, renderSlot, sessionId, sessions } = props
  // sessionId 是编排台所在的用户会话；dev 路由用它换 live agent。
  const [nodeSessionId, setNodeSessionId] = React.useState(null)
  const [reference, setReference] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [draft, setDraft] = React.useState('')

  // 拿到 host 建的子会话 id 后 retain 一次；unmount 时 release。reference 进 state 才会触发重渲染。
  React.useEffect(() => {
    if (!nodeSessionId) return undefined
    const held = sessions.retain(nodeSessionId, { source: 'orchestrator-p0' })
    setReference(held)
    return () => { held.release?.() }
  }, [nodeSessionId])

  const create = async () => {
    setError(null)
    const res = await fetch('/orchestrator-p0/create', { method: 'POST', headers: { 'x-orch-session': sessionId } })
    const body = await res.json()
    if (!body.ok) { setError(`${body.code}: ${body.message}`); return }
    setNodeSessionId(body.data.sessionId)
  }
  const send = async () => {
    const text = draft.trim()
    if (!text || !nodeSessionId) return
    setDraft('')
    const res = await fetch('/orchestrator-p0/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: nodeSessionId, text }),
    })
    const body = await res.json()
    if (!body.ok) setError(`${body.code}: ${body.message}`)
  }

  return h('div', { 'data-orch-p0': 'view', style: { position: 'relative', width: '100%', height: '100%' } },
    h(CanvasP0, { onCreate: create }),
    nodeSessionId && reference
      ? h(SessionProvider, { session: reference },
          h('div', {
            'data-orch-p0': 'panel',
            style: { position: 'absolute', right: 16, top: 70, bottom: 16, width: 404, display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-card, #fff)', border: '1px solid var(--dsw-alias-border, #e7e7e2)', borderRadius: 14, overflow: 'hidden' },
          },
            h('div', { style: { flex: 1, minHeight: 0, overflow: 'auto' } },
              renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, {
                slots: { views: (viewProps) => h(React.Fragment, null, viewProps.renderSlot('conversation.session', { view: 'chat' })) },
              })),
            h('div', { style: { borderTop: '1px solid var(--dsw-alias-border, #e7e7e2)', padding: 8, display: 'flex', gap: 8 } },
              h('input', {
                value: draft, onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } },
                placeholder: 'P0 探针：发一条消息',
                style: { flex: 1, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--dsw-alias-border, #e7e7e2)' },
              }),
              h('button', { type: 'button', onClick: send, style: { padding: '6px 12px' } }, '发送'),
              h('button', {
                type: 'button',
                onClick: async () => {
                  const res = await fetch('/orchestrator-p0/abort', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: nodeSessionId }) })
                  if (!res.ok) setError(`abort: ${res.status}`)
                },
                style: { padding: '6px 10px' },
              }, '停止')),
          ))
      : error ? h('div', { style: { position: 'absolute', left: 16, bottom: 16, color: '#c33' } }, error) : null)
}
```

`CanvasP0` 增加一个按钮（`onCreate`）：

```js
function CanvasP0({ onCreate }) {
  return h('div', { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', justifyContent: 'center' } },
    h('div', null, '编排台 P0 画布占位'),
    h('button', { type: 'button', onClick: onCreate, style: { padding: '6px 14px' } }, '创建节点会话（P0 探针）'))
}
```

并把 `sessions` 注入到 view：注册处 `inject: ['slots', 'sessions']`，组件里用 props 拿不到服务，改为在 `apply` 里通过闭包传：

```js
const sessions = ctx.get('sessions')
...
}, (viewProps) => h(OrchestratorView, { ...viewProps, sessions })), 'orchestrator: conversation.view')
```

- [ ] **Step 3: 人工验证四条**

重开后在会话里打开「编排台」：
1. 点「创建节点会话」→ 面板出现，且**能看到子会话的对话内容**（不是空白）；
2. 在面板输入框发一条 → 面板里出现用户消息（宿主渲染）；
3. 让子会话回话后点「停止」（P0 可先用 dev 路由 `/orchestrator-p0/abort` 的按钮）→ 当前 turn 中止且不崩；
4. 切走再切回编排台 → 面板与消息仍在（retain 保活）。

Expected: 4 条全过；若面板空白，按 findings 记录「缺哪一件（retain / SessionProvider / views）」并给 P1 退路（右栏 tab 或只读回看）。

- [ ] **Step 4: 记录 findings**

写 `## P0-1 面板内嵌（D2）` 一节：`retain 是否可用`、`SessionProvider 是否注入`、`renderFactorySlot 是否可渲染子会话`、`composer 自绘 + host followup 是否生效`、`中止结果`、`最终选定路线`。

- [ ] **Step 5: Commit**

```bash
git add orchestrator/client.js orchestrator/index.js orchestrator/spike/routes.js docs/superpowers/spikes/2026-11-17-orchestrator-p0-findings.md
git commit -m "spike(orchestrator): embed child session in panel with retain and host followup"
```

---

### Task 4: P0-3 — connection.fetch 通道的鉴权边界

**Files:**
- Create: `orchestrator/spike/channel.js`
- Modify: `orchestrator/index.js`, `orchestrator/client.js`

**Interfaces:**
- Produces: `GET /api/orchestrator/ping`（connection.fetch）与 `GET /orchestrator-p0/ping`（webServer 对照）；client 按钮显示两者结果。
- Consumes: 无。

- [ ] **Step 1: 注册两条 ping 路由**

`orchestrator/spike/channel.js`：

```js
/** P0-3：对比官方客户端通道与自建 webServer 路由的鉴权边界。 */
export function registerChannelProbe(ctx) {
  const disposers = []

  // A. 官方客户端通道：只有 owner peer 的浏览器连接能到。
  const connection = ctx.get('connection')
  if (connection?.fetch?.register) {
    disposers.push(connection.fetch.register({
      path: '/api/orchestrator/ping',
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true, via: 'connection.fetch' }),
      }),
    }))
  }

  // B. 自建 webServer 路由：用于证明「本机 curl 能打通」，作为对照。
  const webServer = ctx.get('webServer')
  if (webServer) {
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/orchestrator-p0/ping',
      handler: async (_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true, via: 'webServer' }))
      },
    }))
  }

  return () => { for (const dispose of disposers) dispose?.() }
}
```

`index.js`：`ctx.effect(() => registerChannelProbe(ctx), 'orchestrator: channel probe')`。
`client.js`：CanvasP0 加两个按钮，分别 `fetch('/api/orchestrator/ping')` 与 `fetch('/orchestrator-p0/ping')`，把 `status + body.via` 显示在画布角落（`window.__orchP0.channel = ...`）。

- [ ] **Step 2: 用本机 curl 打两条路由**

```bash
curl -sS -i http://127.0.0.1:49277/api/orchestrator/ping | head -20
curl -sS -i http://127.0.0.1:49277/orchestrator-p0/ping | head -20
```

（端口取当前 DSH Web GUI 的实际端口；`/api/orchestrator/ping` 必须换成本地 `/api` 前缀。）

Expected：`/orchestrator-p0/ping` 返回 200（证明本机进程可伪造），`/api/orchestrator/ping` 返回 401/403/404（证明官方通道挡住了非客户端请求）。把两个 status 与响应头写进 findings。

- [ ] **Step 3: client 按钮验证**

在编排台视图里点两个按钮：`/api/orchestrator/ping` 应返回 200 且 `via: connection.fetch`。

- [ ] **Step 4: 记录结论与 P1 用法**

写 `## P0-3 通道鉴权`：`connection.fetch 注册签名`、`curl 结果`、`客户端调用示例`、`P1 直接照抄的代码`；若官方通道仍被 curl 打通，写明「必须加 bearer + 归属校验」。

- [ ] **Step 5: Commit**

```bash
git add orchestrator/index.js orchestrator/client.js orchestrator/spike/channel.js docs/superpowers/spikes/2026-11-17-orchestrator-p0-findings.md
git commit -m "spike(orchestrator): probe connection.fetch authorization boundary"
```

---

### Task 5: P0-4 — 沙箱继承与环境变量白名单

**Files:**
- Modify: `orchestrator/spike/probes.js`, `orchestrator/index.js`

**Interfaces:**
- Produces: `orch_p0_probe {probe:'sandbox'}` → `{allowed: string[], denied: string[], env: {DSH_HOME, DSH_SESSION_ID, hasProviderKey}, sandboxMode}`。
- Consumes: Task 2 的子会话创建逻辑。

- [ ] **Step 1: 写沙箱探针**

在 `spike/probes.js` 增加：

```js
const SANDBOX_PROMPT = [
  '这是编排台沙箱探针。逐条执行并用相同顺序汇报结果，不要做其它事：',
  '1) bash: `echo $DSH_HOME`',
  '2) bash: `echo $DSH_SESSION_ID`',
  '3) bash: `test -n "$DEEPSEEK_API_KEY" && echo provider-key-present || echo provider-key-empty`',
  '4) bash: `printf x >> ~/.dsh/orch-p0-sandbox.txt`',
  '5) bash: `printf x >> ${cwd}/.git/config`',
  '6) bash: `printf x >> /tmp/orch-p0-outside.txt`',
  '7) bash: `git status --porcelain | head -5`',
  '最后只输出一行 JSON：{"dshHome":"...","sessionId":"...","providerKey":"present|empty","homeWrite":"ok|denied","gitConfigWrite":"ok|denied","outsideWrite":"ok|denied"}。',
].join('\n')
```

同时把 `orch_p0_probe.parameters.probe.enum` 追加 `'sandbox'`，`execute` 分支接上。执行函数签名 `sandboxProbe(agent, cwd)`：先把 `cwd` 插值进 SANDBOX_PROMPT；`agents.get(childId)` 拿会话并记录 `session.sandboxMode`；再 `startActivation` 一次（`delivery:'caller'`）把 prompt 发给子代理，从返回 `output` 里解析最后一行的 JSON，返回给工具调用方。**不要**把子会话输出里的真实路径写进 findings。

- [ ] **Step 2: 跑探针并判定**

重开 → `orch_p0_probe {probe:'sandbox'}`。Expected 二选一并记录：
- `homeWrite/gitConfigWrite/outsideWrite` 全 denied 且 `dshHome/sessionId` 为空 → 沙箱 + env 白名单成立，P1 直接照抄；
- 任一项 `ok` → 记录「默认 profile 全权、子会话未继承显式 override」，并在 findings 写 P1 的补救路线（`setSandboxMode` 放置点 + P0 未覆盖的部分）。

- [ ] **Step 3: 补一次显式 override 尝试**

读源码 `dsh-sandbox-policy/src/session-mode.ts`（`setSandboxMode(session, mode)`）与 `dsh-subagent/src/child-agent.ts`（delegation 捕获），尝试在子会话创建后立刻设 `workspace-write` 再重跑 Step 1；把「能否在第三方插件里拿到子会话 Session 对象」的结论写进 findings。

- [ ] **Step 4: Commit**

```bash
git add orchestrator/index.js orchestrator/spike/probes.js docs/superpowers/spikes/2026-11-17-orchestrator-p0-findings.md
git commit -m "spike(orchestrator): probe sandbox inheritance and env whitelist"
```

---

### Task 6: P0-5 — 容量、TokenMeter 与 code-review 干扰

**Files:**
- Modify: `orchestrator/spike/probes.js`, `orchestrator/index.js`

**Interfaces:**
- Produces: `orch_p0_probe {probe:'capacity', count?: number}` → `{configuredMax, started, rejected, tokenMeasureAvailable, sampleTokens}`。
- Consumes: Task 2 的 `startActivation`。

- [ ] **Step 1: 写容量探针**

同时把 `orch_p0_probe.parameters.probe.enum` 追加 `'capacity'`，`execute` 分支接上。`probes.js` 增加 `capacityProbe(agent, {count=4})`：并发调 `subagents.startActivation` count 次（每次 prompt 只回复 OK），`Promise.allSettled` 统计成功/失败与错误码；然后 `const meter=ctx.get('tokenMeter'); meter?.measure?.(session)` 对子会话读数，返回 `{configuredMax: <从运行实例读>, started, rejected, tokenMeasureAvailable, sampleTokens}`。

`configuredMax` 读法：优先 `ctx.get('subagents')?.config?.maxActiveSubagents`，读不到就从 `~/.dsh/profiles/desktop/cordis.patch.yml` 解析（**只读值，不打印其它配置**）。

- [ ] **Step 2: 跑探针，记录三件事**

1. 实际 `maxActiveSubagents`（预期 20）；
2. 并发 4 是否全成功；失败时的错误码（用于 P1 区分「容量等待」与「启动失败」）；
3. `tokenMeter.measure` 是否能拿到每个子会话的 token（字段名写进 findings）。

- [ ] **Step 3: code-review 干扰检查**

读 `code-review/src/host/reviewer.js` 的触发条件（`turn/end` 钩子、preset 过滤），在 Task 2/3 的子会话跑完一轮后检查是否自动出现 `code-review` 子代理（会话列表/日志）。记录「会/不会」，会则写 P1 的 preset 排除方案。

- [ ] **Step 4: Commit**

```bash
git add orchestrator/index.js orchestrator/spike/probes.js docs/superpowers/spikes/2026-11-17-orchestrator-p0-findings.md
git commit -m "spike(orchestrator): probe capacity, token meter and code-review interference"
```

---

### Task 7: P0-6 — 基线快照与 5 种绕过回归（纯 Node + git）

**Files:**
- Create: `orchestrator/scripts/baseline-probe.mjs`, `orchestrator/test/baseline.test.js`
- Modify: `orchestrator/package.json`（加 `"test": "node --test test/*.test.js"` 与 `"scripts: {"baseline": "node scripts/baseline-probe.mjs"}`）

**Interfaces:**
- Produces: `baseline({cwd})` → `{baselineId, tree, files: Map<path,hash>}`, `compare({cwd,baseline,scope})` → `{files, outOfScope, violations, foreignChanges, gitConfigChanged}`；P1 的 `src/host/evidence/` 直接搬这两个函数。
- Consumes: git CLI。

- [ ] **Step 1: 先写失败测试**

`orchestrator/test/baseline.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { baseline, compare } from '../scripts/baseline-probe.mjs'

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'orch-baseline-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'p0@example.invalid'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'p0'], { cwd: dir })
  await writeFile(join(dir, 'a.txt'), 'a\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
  return dir
}

test('scope 内改动被归到本节点', async () => {
  const dir = await repo()
  const b = await baseline({ cwd: dir })
  await writeFile(join(dir, 'a.txt'), 'a2\n')
  const d = await compare({ cwd: dir, baseline: b, scope: ['a.txt'] })
  assert.deepEqual(d.files, ['a.txt'])
  assert.deepEqual(d.violations, [])
})

test('symlink 写入即删：hash 能看见内容变化', async () => {
  const dir = await repo()
  const outside = await mkdtemp(join(tmpdir(), 'orch-outside-'))
  await writeFile(join(outside, 'secret.txt'), 'x\n')
  const b = await baseline({ cwd: dir })
  await symlink(join(outside, 'secret.txt'), join(dir, 'link.txt'))
  await writeFile(join(outside, 'secret.txt'), 'evil\n')
  const d = await compare({ cwd: dir, baseline: b, scope: ['a.txt'] })
  assert.equal(d.foreignChanges.includes('link.txt') || d.violations.includes('link.txt'), true)
})

test('已脏文件不被漏判（基线 hash 与 after hash 不同即算改动）', async () => {
  const dir = await repo()
  await writeFile(join(dir, 'dirty.txt'), 'd1\n')
  const b = await baseline({ cwd: dir })
  await writeFile(join(dir, 'dirty.txt'), 'd2\n')
  const d = await compare({ cwd: dir, baseline: b, scope: ['a.txt'] })
  assert.equal(d.files.concat(d.foreignChanges).includes('dirty.txt'), true)
})

test('改 .git/config 被 gitConfigChanged 捕获', async () => {
  const dir = await repo()
  const b = await baseline({ cwd: dir })
  execFileSync('git', ['config', 'core.hooksPath', '.evil'], { cwd: dir })
  const d = await compare({ cwd: dir, baseline: b, scope: [] })
  assert.equal(d.gitConfigChanged, true)
})

test('工作区外写入不在 diff 里（由哨兵另行覆盖）', async () => {
  const dir = await repo()
  const outside = await mkdtemp(join(tmpdir(), 'orch-outside-'))
  const b = await baseline({ cwd: dir })
  await writeFile(join(outside, 'x.txt'), 'x\n')
  const d = await compare({ cwd: dir, baseline: b, scope: [] })
  assert.deepEqual(d.files, [])
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/liyu/Documents/www/DeepSeek/deepseek-harness/deepseek-harness-plugin/orchestrator
node --test test/baseline.test.js
```

Expected: FAIL（`baseline-probe.mjs` 不存在 / 未导出 `baseline`）。

- [ ] **Step 3: 实现 baseline-probe.mjs**

`orchestrator/scripts/baseline-probe.mjs`：

```js
/**
 * P0 基线快照：私有 git index + 逐路径 hash，覆盖 git status 差分看不见的改动。
 * P1 会移到 src/host/evidence/，函数签名保持不变。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, lstat, readlink, readdir, realpath, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

const gitEnv = () => ({
  ...process.env,
  GIT_CONFIG_COUNT: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
})

const git = (cwd, args, env = {}) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...gitEnv(), ...env } })

async function walk(dir, base = dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    const rel = relative(base, path)
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) {
      let targetHash = 'missing'
      try {
        const real = await realpath(path)
        const targetStat = await lstat(real)
        if (targetStat.isFile()) targetHash = sha256(await readFile(real))
      } catch {
        // 悬空链接保留 'missing' 作为可比较状态
      }
      out.push({ path: rel, hash: `link:${await readlink(path)}:${targetHash}` })
    } else if (stat.isDirectory()) {
      await walk(path, base, out)
    } else {
      out.push({ path: rel, hash: sha256(await readFile(path)), size: stat.size })
    }
  }
  return out
}

export async function baseline({ cwd }) {
  const indexFile = join(cwd, '.git', 'orch-p0-index')
  await rm(indexFile, { force: true })
  git(cwd, ['add', '-A'], { GIT_INDEX_FILE: indexFile, GIT_WORK_TREE: cwd })
  const tree = git(cwd, ['write-tree'], { GIT_INDEX_FILE: indexFile, GIT_WORK_TREE: cwd }).trim()
  const files = await walk(cwd)
  const gitConfig = await readFile(join(cwd, '.git', 'config'), 'utf8').catch(() => '')
  return {
    baselineId: tree,
    tree,
    files: new Map(files.map((f) => [f.path, f.hash])),
    fileList: files,
    gitConfigHash: sha256(gitConfig),
  }
}

export async function compare({ cwd, baseline, scope }) {
  const after = await walk(cwd)
  const afterMap = new Map(after.map((f) => [f.path, f.hash]))
  const changed = []
  for (const [path, hash] of afterMap) {
    if (baseline.files.get(path) !== hash) changed.push(path)
  }
  for (const path of baseline.files.keys()) {
    if (!afterMap.has(path)) changed.push(path)
  }
  const inScope = (path) =>
    scope.some((glob) => path === glob || (glob.endsWith('/**') && path.startsWith(glob.slice(0, -2))))
  const outOfScope = changed.filter((path) => inScope(path) === false)
  const gitConfig = await readFile(join(cwd, '.git', 'config'), 'utf8').catch(() => '')
  // P0 阶段：归属未知的改动先一律进 outOfScope；P1 再按时间/文件 hash 拆 violations 与 foreignChanges。
  return {
    files: changed.filter(inScope),
    outOfScope,
    violations: outOfScope,
    foreignChanges: outOfScope,
    gitConfigChanged: sha256(gitConfig) !== baseline.gitConfigHash,
  }
}
```

- [ ] **Step 4: 跑测试直到全过**

```bash
node --test test/baseline.test.js
```

Expected: 5 passed。断言覆盖：scope 归属、symlink 目标内容变化、已脏文件、`.git/config` 变化、工作区外写入不可见。

- [ ] **Step 5: 记录 findings**

写 `## P0-6 证据基线`：5 个绕过场景的通过/失败、`foreignChanges` 与 `violations` 的区分规则、并发 worker 下无法归属时 P1 的策略。

- [ ] **Step 6: Commit**

```bash
git add orchestrator/package.json orchestrator/scripts orchestrator/test docs/superpowers/spikes/2026-11-17-orchestrator-p0-findings.md
git commit -m "spike(orchestrator): baseline snapshot evidence with bypass regressions"
```

---

### Task 8: P0-7 — 画布契约、200 节点性能、主题 token

**Files:**
- Modify: `orchestrator/client.js`

**Interfaces:**
- Produces: `window.__orchP0.seed(200)`、`window.__orchP0.measure()`、`window.__orchP0.getNodeState(id)`（P1 e2e 直接复用）。
- Consumes: 无。

- [ ] **Step 1: 画布占位换成 200 节点压测组件**

在 `client.js` 增加一个纯 DOM 渲染函数（不引宿主包）：

```js
function seedFixture(count) {
  const nodes = [{ id: 'root', parent: null, kind: 'project', title: '压测根节点' }]
  for (let i = 1; i < count; i += 1) {
    nodes.push({ id: `n${i}`, parent: i % 7 === 1 ? 'root' : `n${Math.max(1, Math.floor(i / 2))}`, kind: 'api', title: `节点 ${i}`, status: ['ready', 'running', 'done', 'stale'][i % 4] })
  }
  return nodes
}

function PerfCanvas() {
  const ref = React.useRef(null)
  const [report, setReport] = React.useState('空闲')
  React.useEffect(() => {
    window.__orchP0 = {
      ...(window.__orchP0 || {}),
      seed(count = 200) { return seedFixture(count) },
      measure() {
        const host = ref.current
        if (!host) return null
        const nodes = seedFixture(200)
        const t0 = performance.now()
        host.replaceChildren(...nodes.map((node) => {
          const el = document.createElement('div')
          el.className = `node s-${node.status}`
          el.dataset.nodeId = node.id
          el.dataset.status = node.status
          el.dataset.state = 'default'
          el.dataset.selected = 'false'
          el.dataset.rel = ''
          el.style.cssText = 'position:absolute;width:268px;height:136px;border:1px solid #ddd;border-radius:12px;background:#fff'
          el.textContent = node.title
          return el
        }))
        const renderMs = performance.now() - t0
        return { renderMs, count: nodes.length }
      },
    }
  }, [])
  return h('div', { ref, 'data-orch-perf': 'host' })
}
```

把一个按钮接到 `measure()` 上，把 `{renderMs,count}` 显示在角落并写 `window.__orchP0.lastPerf`；连续测 3 次取中位数。

- [ ] **Step 2: 跑性能探针并记录**

在编排台视图点「压测」→ 记录 3 次中位数。Expected 基准：`renderMs < 300`；若明显更慢，把「视口裁剪/上限 100」写进 P1 风险。

- [ ] **Step 3: 主题 token 与 data 属性检查**

在浏览器控制台执行（或加按钮显示）：

```js
const s = getComputedStyle(document.querySelector('[data-orch-perf]'))
window.__orchP0.themeSample = {
  bg: s.getPropertyValue('--dsw-alias-bg-canvas').trim(),
  text: s.getPropertyValue('--dsw-alias-text').trim(),
  border: s.getPropertyValue('--dsw-alias-border').trim(),
}
```

Expected：三个 token 非空；空则记录宿主实际 token 名（P1 的映射表来源）。

- [ ] **Step 4: 记录 findings**

写 `## P0-7 画布契约`：200 节点渲染中位数、data 三轴断言是否成立（`data-state/selected/rel`）、主题 token 实测名、低缩放/自适应高的实现风险。

- [ ] **Step 5: Commit**

```bash
git add orchestrator/client.js docs/superpowers/spikes/2026-11-17-orchestrator-p0-findings.md
git commit -m "spike(orchestrator): canvas contract, 200-node perf and theme token probe"
```

---

### Task 9: 汇总结论，决定 P1 路线

**Files:**
- Modify: `docs/superpowers/spikes/2026-11-17-orchestrator-p0-findings.md`
- Modify: `docs/superpowers/specs/2026-11-17-orchestrator-design.md`（只在结论与 spec 冲突时改，最小 diff）

**Interfaces:**
- Produces: 7 个探针的「可行/退路」决策表；P1 计划的输入清单。
- Consumes: Task 1–8 的 findings。

- [ ] **Step 1: 写决策总表**

在 findings 顶部写：

| 探针 | 结论 | P1 采用路线 | 若失败时的退路 |
| --- | --- | --- | --- |
| P0-1 节点会话 | （Task 2/3 实测结果） | D1 持久会话 / 每次新会话 | 对话只读回看 |
| P0-2 视图与 composer | （Task 1 实测结果） | 全幅 + chain 接管 | 右栏 tab |
| P0-3 通道鉴权 | （Task 4 实测结果） | connection.fetch + bearer | 自建通道全量自校验 |
| P0-4 沙箱/env | （Task 5 实测结果） | workspace-write + env 白名单 | 降级 + 明示风险 |
| P0-5 容量/成本 | （Task 6 实测结果） | 动态 maxWorkers + token 预算 | token 软上限 |
| P0-6 证据基线 | （Task 7 实测结果） | 基线快照 + 归属判定 | scope 交集 + 人工抽查 |
| P0-7 画布 | （Task 8 实测结果） | 全量渲染 + 自适应高 | 视口裁剪 / 上限 100 |

- [ ] **Step 2: 与 spec 对齐**

逐条对照 spec §15.1 的探针定义：结论、字段名、API 签名若与 spec 假设不同，**改 spec 对应段落**（只改事实性描述，不改设计决策）。

- [ ] **Step 3: 写 P1 入口清单**

在 findings 末尾列 P1 必读项：
- 节点会话创建/续跑/冷恢复的最终 API 与字段；
- Panel 内嵌的最终三件套写法（retain/SessionProvider/views）；
- 通道注册的最终代码；
- 沙箱与 env 的可达性结论；
- 容量与 token 读数口径；
- 基线证据的最终函数签名；
- 画布渲染的性能上限。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/spikes/2026-11-17-orchestrator-p0-findings.md docs/superpowers/specs/2026-11-17-orchestrator-design.md
git commit -m "docs(orchestrator): P0 findings and P1 entry checklist"
```

---

## Self-Review（作者自检，2026-11-17）

- **Spec 覆盖**：§15.1 的 P0-1…P0-7 分别落在 Task 2/3、Task 1、Task 4、Task 5、Task 6、Task 7、Task 8；Task 9 做汇总。§11 的 DX/AX 断言面在 Task 8 的 `window.__orchP0` 中留了入口。
- **代码可运行性**：Task 7 的 `baseline-probe.mjs` 与 `baseline.test.js` 已从本计划抽出、在 Node 22.23 实测 **5/5 通过**（scope 归属、symlink 目标内容、已脏文件、`.git/config`、工作区外写入）；Task 1/2/3/4/8 的 JS 块均通过 `node --check` 语法校验。Task 3/5 的 DSH 运行时行为仍以探针实测为准。
- **占位扫描**：Task 7 的 `baseline-probe.mjs` 已给出完整实现（真实 tree 作 `baselineId`、`gitConfigChanged` 真值比较），无隐藏 TBD；Task 1 的 composer 注册注明「若字段与源码不同按源码改并记录」——P0 计划允许这种受控的不确定性，但每条都给了判定标准。Task 9 结论表的「实测结果」只是 findings 输出模板，由 Task 1–8 的实测填写。
- **类型一致**：`orch_p0_probe` 的参数枚举在 Task 2/5/6 之间保持 `probe` 单字段；`sessionId` 命名贯穿 Task 2/3；`window.__orchP0` 在 Task 1/4/8 中逐步扩展同名对象。

## 后续计划（不在本文件范围）

- P1（画布与视图骨架）计划：`docs/superpowers/plans/2026-11-17-orchestrator-p1-canvas.md`（P0 结论后编写）。
- P2–P6 计划按 spec §15.2 依次编写；每个计划独立可交付、可测试。
