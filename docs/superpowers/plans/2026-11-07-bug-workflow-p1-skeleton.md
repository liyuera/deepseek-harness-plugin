# Bug 工作流插件 P1（骨架）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 P0 的 spike bundle 演进成可安装的插件骨架：右栏看板 + 工单状态机 + storageDomain 持久化 + 宿主 HTTP 路由 + 工作区设置，用「假引擎」把一张工单从 `inbox` 一路走到 `done`，刷新/重启不丢。

**Architecture:** 纯 ESM JavaScript 的 DSH bundle（不引入构建链）：host 入口 `bug-workflow/index.js` 组装 `src/host/*`（协议常量、纯状态机、storageDomain 存储、webServer 路由）；client 入口 `bug-workflow/client.js` 是自包含 React（只 require `react`），通过同源 HTTP 读取快照并轮询，向宿主 POST 动作。P2+ 的平台/GitLab/子代理适配器将替换 P1 的「假引擎」动作实现，状态机与看板不动。

**Tech Stack:** DSH 0.2.2-rc.1（Cordis 插件 API：`ctx.slots` / `ctx.sidebarRightTabs` / `ctx.webServer` / `ctx.storageDomain` / `ctx.sessions` / `ctx.credentials`）、`@deepseek-ai/dsh-storage-domain` + `zod`（host 依赖，见 Task 2）、Node 22 `node:test`、React（来自 client module loader）。

## Global Constraints

- 目标运行环境 DSH 0.2.2-rc.1 desktop profile；安装只用 `plugin_manager`，不手写 `~/.dsh/profiles/**`。
- **host 半不得硬编码 `app.asar` 绝对路径**；storage-domain/zod 的获取方式必须在 Task 2 里验证并固定为可发布方案（优先 `peerDependencies`；失败才用受控的解析器并记录 P2 收敛项）。
- client 半只 `require('react')`；不得 require 任何 `@deepseek-ai/dsh-client-*` 包；不得 iframe；样式只用 `--dsw-alias-*` theme token；可见文案中文（P2 再接 `ctx.locale`）。
- 所有写操作必须经过状态机 guard；宿主路由不接受非法迁移。路由只绑定 loopback、校验 `Host` 为 `127.0.0.1`/`localhost`，请求体限制 64KB；不打印 token/密码。
- 数据持久化用正式 domain `bug_workflow`（`^[a-z][a-z0-9_]*$`），version 1，表：`tickets`、`settings`、`meta`。schema 用真 zod；存量数据损坏 fail-loud（记录错误并在看板提示），不做静默丢弃。
- 测试：纯模块用 `node --test test/`；live 冒烟用 curl（端口取当前 GUI 端口）。每个 task 至少一个 commit，风格 `feat(bug-workflow): …` / `fix(bug-workflow): …` / `docs(bug-workflow): …`。
- 参考：[设计 spec](../specs/2026-11-06-dsh-bug-workflow-plugin-design.md)、[P0 findings](../spikes/2026-11-06-p0-findings.md)（尤其 Spike D/E：子代理契约、storageDomain 契约、热重载方法）。

## File Structure

```
bug-workflow/
  package.json           修改：peerDependencies、files 含 src/test、description
  cordis.patch.yml       不改（id: bug-workflow）
  icon.svg               不改
  index.js               重写：host apply（inject webServer+storageDomain+sessions）
  client.js              重写：自包含 React 看板（列表/详情/设置）
  src/host/protocol.js   新增：状态/动作/事件常量与共享类型注释
  src/host/state-machine.js 新增：纯状态机（initialTicket/canApply/apply）
  src/host/domain.js     新增：zod schema + defineDomain spec + open（含 already-open 重试）
  src/host/store.js      新增：TicketStore（快照/动作/设置，持久化到 domain）
  src/host/workspace.js  新增：sessionId → cwd 工作区解析
  src/host/routes.js     新增：webServer 路由（snapshot/action/settings/health）
  test/state-machine.test.js 新增：node:test 覆盖全部合法/非法迁移
  test/store.test.js     新增：node:test，用 fake domain 覆盖 CRUD/幂等/持久化映射
  test/routes.test.js    新增：node:test，用 fake req/res 覆盖校验与响应
```

## 接口与数据契约（所有 task 必读）

```js
// protocol.js
export const STATES = ['inbox','analyzing','plan_review','fixing','fix_done','submitting','mr_open','fixing_review','mergeable','merged','done','blocked']

// state-machine.js（纯函数，无 I/O）
initialTicket({ code, title, type, status, version, priority, assignee, url }) -> Ticket
canApply(ticket, action) -> { ok: true } | { ok: false, code, message }
apply(ticket, action, payload, at) -> Ticket   // 不合法迁移 throw StateError；返回新对象（不 mutate 入参）
// actions: 'create' | 'start_analysis' | 'analysis_done' | 'approve_plan' | 'reject_plan'
//        | 'fix_done' | 'mark_test_passed' | 'submit_mr' | 'mr_created'
//        | 'review_requests_changes' | 'review_fix_done' | 'review_pass' | 'mr_merged' | 'dismiss' | 'retry' | 'block'
// block 可从任意非终态进入 blocked，并记录 blockedFrom/blockedReason；retry 回到 blockedFrom。
// 「review 轮次耗尽」由宿主映射：canApply 返回 code 'review-rounds-exhausted' 时，宿主调用 block 动作（reason='review-rounds-exhausted'）。

// Ticket（持久化形状，字段可增不可改语义）
{ code, title, type, status, version, priority, assignee, url,
  workflow, blockedFrom: null, blockedReason: null,
  plan: null | { summary, rootCause, approach, changedFiles: [], risks: [], testPlan, generatedAt, approvedAt, rejectedReason },
  branch: null | { name, target },
  mr: null | { iid, url, sourceBranch, targetBranch, state, verdict, blockingIssues: [], nonBlockingIssues: [], rounds },
  fixes: [], timeline: [ { at, kind, actor, message } ],
  createdAt, updatedAt }
```

宿主路由契约（client 与测试都依赖）：

- `GET /bug-workflow/api/snapshot?sessionId=<id>` → `{ ok, workspace:{ path, configured }, settings, tickets:[Ticket], serverTime }`
- `POST /bug-workflow/api/action` body `{ sessionId, actionId, code, action, payload? }` → `{ ok, ticket }` | `{ ok:false, code, message }`；`actionId` 重复时返回首次结果（幂等）。
- `GET /bug-workflow/api/health` → `{ ok, domainOpenedAt, tickets }`（live 冒烟用）。
- `POST /bug-workflow/api/settings` body `{ sessionId, settings }` → `{ ok, settings }`。
- 所有响应 `content-type: application/json; charset=utf-8`；错误 HTTP 4xx/5xx 并带 `{ ok:false, code, message }`。

`settings`（按工作区 cwd 为 key）：

```js
{ platformProjectCode: '', gitlabProjectPath: '', branchUser: 'ly', gitlabReviewer: '',
  commitType: 'fix', lintCommand: '', testCommand: '', devCommand: '', previewUrl: '' }
```

---

### Task 1: 协议常量 + 纯状态机 + 单元测试

**Files:**
- Create: `bug-workflow/src/host/protocol.js`、`bug-workflow/src/host/state-machine.js`
- Test: `bug-workflow/test/state-machine.test.js`

**Interfaces:**
- Produces: `STATES`、`initialTicket()`、`canApply()`、`apply()`、`StateError`；后续 Task 2/3/4 全部依赖。

- [ ] **Step 1: 写失败测试**

`test/state-machine.test.js` 用 `node:test` + `node:assert/strict`，至少覆盖：
1. `initialTicket()` 得到 `workflow:'inbox'` 且 timeline 一条 `created`。
2. 合法链：`start_analysis → analysis_done → approve_plan → fix_done → mark_test_passed → submit_mr → mr_created → review_requests_changes → review_fix_done → review_pass → mr_merged → dismiss`，最终 `workflow:'done'`。
3. 非法迁移：`inbox` 直接 `mr_merged`、`plan_review` 上 `fix_done`、`done` 上任何动作都返回 `ok:false`。
4. `reject_plan` 进 `blocked`（`blockedFrom:'plan_review'`），`retry` 回 `plan_review` 且保留 rejectedReason；`review_requests_changes` 轮次 `mr.rounds` 自增，第 4 次请求返回 `ok:false, code:'review-rounds-exhausted'`（上限 3 轮）。
5. `apply()` 不修改入参（deepEqual 原对象）且返回新 timeline 追加一条事件。
6. `block` 动作：从 `fixing` / `mr_open` 进 `blocked` 并记录 `blockedFrom`/`blockedReason`；`retry` 回到 `blockedFrom`（`mr_open` 场景保留 `mr` 上下文）；`done` 上 `block` 被拒绝。

Run: `node --test bug-workflow/test/*.test.js` → 预期 FAIL（模块不存在）。

- [ ] **Step 2: 实现 protocol.js 与 state-machine.js**

按「接口与数据契约」实现；`apply()` 用 switch/表驱动，非法迁移抛 `StateError({ code:'invalid-transition', message })`；`canApply()` 不抛。轮次计算：`review_requests_changes` 时 `mr.rounds = (mr.rounds ?? 0) + 1`，>3 返回 `{ ok:false, code:'review-rounds-exhausted' }`。`block` 动作从任意非终态进入 `blocked` 并记录 `blockedFrom`/`blockedReason`（`reject_plan` 等价于 `blockedFrom:'plan_review'`）；`retry` 优先回到 `blockedFrom` 并清除这两个字段；`blockedFrom` 为空时按旧规则（plan ? plan_review : inbox）。

- [ ] **Step 3: 跑测试**

Run: `node --test bug-workflow/test/*.test.js` → 全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add bug-workflow/src/host bug-workflow/test
git commit -m "feat(bug-workflow): 工单状态机与协议常量"
```

---

### Task 2: storageDomain 依赖验证 + 持久化 store + 测试

**Files:**
- Modify: `bug-workflow/package.json`（peerDependencies + files）
- Modify: `bug-workflow/index.js`（Task 2 只加最小 `/bug-workflow/api/health` 探针用于 live 验证依赖与 domain；Task 3 会扩展成完整接线）
- Create: `bug-workflow/src/host/domain.js`、`bug-workflow/src/host/store.js`
- Test: `bug-workflow/test/store.test.js`

**Interfaces:**
- Consumes: `initialTicket`/`apply`（Task 1）。
- Produces: `openDomain(ctx) -> Promise<{ domain, openedAt }>`；`createStore(domain, clock?) -> TicketStore`；`TicketStore.list()/get(code)/snapshot()/create(input)/applyAction(code, action, payload)/getSettings(cwd)/putSettings(cwd, settings)`；后续 Task 3 用。

- [ ] **Step 1: 验证依赖获取方式（spike 步骤，写进 report）**

按以下顺序实测，选定一条并写死（每条都要在 live 安装环境验证，不能只看静态推断）：
1. **首选：peerDependencies + bare import**。`package.json` 增加 `"peerDependencies": { "@deepseek-ai/dsh-storage-domain": "*", "zod": "*" }`（zod 的包名/版本以 app.asar 里实际为准；先确认），`domain.js` 里 `import { defineDomain } from '@deepseek-ai/dsh-storage-domain'` + `import { z } from 'zod'`；通过 Task 2 的临时 `/bug-workflow/api/health` 探针实测 host 能否 import、domain 能否 open。
2. **备选：零依赖手写 spec**。若 peer/bare import 在 link 安装下不可用：不 import `defineDomain`，在 `domain.js` 里手工构造符合 `DomainSpec` 形状的对象（`name/version/tables`，每个表 `{ valueSchema: { parse(v) {…校验并返回 v…} } }`）直接交给 `ctx.storageDomain.open(spec)`；live 验证 open 成功且写入能落盘。此方案无运行时依赖，优先于任何 app.asar 路径解析。
3. **最后手段：受控解析器**。仅当 (1)(2) 都失败：`src/host/domain-source.js` 的 `resolveDomainLib()` 依次尝试 bare import、Electron `process.resourcesPath` 下 `app.asar/dsh/node_modules/@deepseek-ai/dsh-storage-domain/lib/index.js`，失败抛可诊断错误 `{ stage:'resolve-domain-lib', tried:[] }`；**禁止静默内联 spec**，并在 report 标注 P2 必须收敛。

在 report 里记录最终方案、失败原文与 live 证据（health 响应）。

- [ ] **Step 2: 写失败测试（store 用 fake domain）**

`test/store.test.js` 用 `node:test` 构造内存 fake domain（`table.get/put/entries/delete` 即可），覆盖：
1. `create()` 落表并出现在 `snapshot()`，语义化 `updatedAt`。
2. `applyAction()` 调状态机后持久化；同 `actionId` 二次调用返回首次结果（幂等）。
3. `getSettings` 无记录返回默认设置；`putSettings` 后读回一致。
4. `list()` 顺序稳定（按 `createdAt`）。
Run: `node --test bug-workflow/test/*.test.js` → FAIL。

- [ ] **Step 3: 实现 domain.js + store.js**

`domain.js`：`defineDomain({ name:'bug_workflow', version:1, tables:{ tickets:{valueSchema:z.object(...)}, settings:{...}, meta:{...} } })`；`openDomain` 带 `already-open` 重试（10×100ms）与 `openedAt`；失败缓存错误。zod schema 与 `Ticket` 形状一致（允许 `plan/mr` nullable、数组默认值）。
`store.js`：纯逻辑 + domain 适配；`actionId` 去重表持久化在 `meta` 表（key `action:<actionId>` 存结果 JSON），或内存 LRU + 持久化最近 500 条。

- [ ] **Step 4: 跑测试 + 语法检查**

`node --test bug-workflow/test/*.test.js` 全过；`node --check` 新文件。

- [ ] **Step 5: 提交**

```bash
git add bug-workflow/package.json bug-workflow/src/host/domain.js bug-workflow/src/host/store.js bug-workflow/test
git commit -m "feat(bug-workflow): storageDomain 持久化与工单仓库"
```

---

### Task 3: 宿主路由 + 工作区解析 + 接线 + live 冒烟

**Files:**
- Create: `bug-workflow/src/host/workspace.js`、`bug-workflow/src/host/routes.js`
- Modify: `bug-workflow/index.js`
- Test: `bug-workflow/test/routes.test.js`

**Interfaces:**
- Consumes: store（Task 2）、`ctx.webServer`、`ctx.sessions`、`ctx.storageDomain`。
- Produces: HTTP 契约（见上）；`index.js` 的 `apply` 完成 `inject(['webServer','storageDomain','sessions'])` 组装。后续 Task 4/5 的 client 依赖。

- [ ] **Step 1: 写失败测试（fake req/res）**

`test/routes.test.js`：把 handler 抽成纯函数 `createHandlers({ store, workspace })`，用 fake `req/res`（记录 status/headers/body）覆盖：
1. `GET snapshot` 返回 `{ ok:true, tickets }`，缺 `sessionId` 返回 400。
2. `POST action` 非法 JSON/超 64KB/未知动作/非法迁移分别返回 400/413/400/409，合法返回 200 且含 ticket。
3. `POST settings` 校验字段类型，返回保存后的 settings。
4. `GET health` 返回 `{ ok:true, domainOpenedAt }`。
5. `Host` 非 loopback 时返回 403。
Run: `node --test bug-workflow/test/*.test.js` → FAIL。

- [ ] **Step 2: 实现 workspace.js + routes.js**

`workspace.resolve(sessionId)`：`ctx.sessions.get(sessionId)?.header.cwd`（取不到时返回 `{ path: null, configured:false }`）；bindings 以 cwd 为 key 存 `settings` 表。
`routes.js`：按契约实现 `createHandlers` + `registerRoutes(ctx, { store })`；JSON 读写带大小上限与 try/catch；动作成功后返回新 ticket。动作被状态机拒绝时返回 409 + `{code,message}`；当 `canApply` 返回 `review-rounds-exhausted` 时，handler 先执行 `block` 动作（`reason:'review-rounds-exhausted'`）再返回 409，保证 spec §12 的「超轮次 → blocked」由宿主兑现。

- [ ] **Step 3: 接线 index.js**

```js
export const inject = ['webServer']
export async function apply(ctx) {
  // ctx.inject(['storageDomain','sessions'], ...) 内 openDomain → createStore → registerRoutes
}
```

打开失败时 `/bug-workflow/api/health` 返回 500 与 `{ stage, error }`；其余路由返回 503（不能把插件加载拖垮）。

- [ ] **Step 4: live 冒烟**

`plugin_manager` remove→install 生效后：
```bash
curl -s "http://127.0.0.1:<port>/bug-workflow/api/health"
# {"ok":true,"domainOpenedAt":...,"tickets":0}
```
用 fake action 造单并连走两步（`create` → `start_analysis`），再 `GET snapshot` 验证；`node --test` 全过。

- [ ] **Step 5: 提交**

```bash
git add bug-workflow/index.js bug-workflow/src/host/workspace.js bug-workflow/src/host/routes.js bug-workflow/test/routes.test.js
git commit -m "feat(bug-workflow): 宿主路由与会话工作区解析"
```

---

### Task 4: 右栏看板 UI（列表 + 详情 + 动作）

**Files:**
- Modify: `bug-workflow/client.js`

**Interfaces:**
- Consumes: HTTP 契约（Task 3）；`sidebarRightTabs.register({ id, kind:'bug-board', title, multiple:false, guide:[{ id:'bug-board', order:100, title }] })` 与 `sidebar.right.pane.tab` slot（key = id）；slot props 的 `sessionId`。
- Produces: 可交互看板，Task 5 在其上加设置视图，Task 6 用它做验收。

- [ ] **Step 1: 实现数据层与轮询**

`client.js` 内：`api.get(snapshot?sessionId)`、`api.post(path, body)`；`usePolling(url, 3000)`；错误态/加载态；请求失败显示可重试横幅（不 crash slot）。

- [ ] **Step 2: 实现列表视图**

顶部：项目/工作区名（未绑定显示「未绑定工作区」+ 设置入口）、筛选（状态多选、类型多选，选项来自快照里出现的值）、手动添加（编号输入 → `create` 动作 payload 带 title 占位）、刷新按钮。
列表行：编号、标题、类型/状态标签、优先级、工作流状态徽标、更新时间；点击选中。
空态：说明 + 演示建单按钮（P1 假数据：`create` 动作，payload `{ title, type:'缺陷', version:'V0.0.0' }`）。

- [ ] **Step 3: 实现详情视图**

字段区（编号/标题/类型/状态/负责人/版本/优先级/链接）、方案卡（summary/rootCause/approach/changedFiles/risks/testPlan + 通过/驳回）、修复/测试区、MR/Review 卡（verdict/blockingIssues/rounds）、时间线（最近 20 条）。
动作按钮按当前 `workflow` 与 `canApply` 映射渲染，均二次确认（`window.confirm` 可，P1 够用），确认后 POST action，成功后刷新快照；失败显示后端 message。

- [ ] **Step 4: 样式与主题**

只用 `--dsw-alias-*` token（`--dsw-alias-bg-layer-1/2/3`、`--dsw-alias-border-l1/l2`、`--dsw-alias-text-primary/secondary`、`--dsw-alias-brand-primary` 等，取实际存在的）；布局在 300–600px 宽可用，窄宽堆叠；不用 iframe；不 require 宿主包。

- [ ] **Step 5: 提交**

```bash
git add bug-workflow/client.js
git commit -m "feat(bug-workflow): 右栏看板列表与详情视图"
```

---

### Task 5: 设置视图 + 工作区绑定

**Files:**
- Modify: `bug-workflow/client.js`、`bug-workflow/package.json`（`dsh.client.inject` 若需）

**Interfaces:**
- Consumes: `POST /bug-workflow/api/settings`（Task 3）。
- Produces: 看板内设置面板，P2 直接使用其中的 `platformProjectCode` / `gitlabProjectPath` / `branchUser`。

- [ ] **Step 1: 实现设置面板**

列表/详情顶部「设置」按钮打开同页面板（非新 tab）：字段与默认值按 `settings` 契约；保存 → POST，成功后 toast；未绑定工作区时提示「先在会话工作区打开」。
校验：`gitlabProjectPath` 形如 `group/project`；`branchUser` 非空；命令字段可空。

- [ ] **Step 2: 演示流程冒烟（手动驱动 fake 引擎）**

客户端层面走通 `inbox → plan_review → fixing → fix_done → submitting → mr_open → mergeable → merged → done`（P1 用假动作串：`start_analysis` + `analysis_done`… 由 UI 按钮触发），确认徽标与按钮随状态变化；刷新后仍在。

- [ ] **Step 3: 提交**

```bash
git add bug-workflow/client.js bug-workflow/package.json
git commit -m "feat(bug-workflow): 看板设置视图与工作区绑定"
```

---

### Task 6: live 端到端验收 + README + 收尾

**Files:**
- Create: `bug-workflow/README.md`
- Modify: `docs/superpowers/spikes/2026-11-06-p0-findings.md`（若 P1 结论需要更新）或新增 `docs/superpowers/spikes/2026-11-07-p1-findings.md`
- Modify: `.gitignore`（如需要）

**Interfaces:**
- Consumes: Task 1–5 全部产物。
- Produces: 可交付的 P1 骨架 + 安装/使用文档 + 验收记录。

- [ ] **Step 1: live 验收脚本**

按 spec P1 验收标准，在 live DSH 上：
1. `plugin_manager` remove→install；`GET /health` ok。
2. 造单 → `start_analysis` → `analysis_done` → `approve_plan`（假引擎）→ `fix_done` → `mark_test_passed` → `submit_mr` → `mr_created` → `review_requests_changes`/`review_fix_done` → `review_pass` → `mr_merged` → `dismiss`；每步 `GET snapshot` 校验 workflow。
3. 热重载 host 半（remove→install）后 `GET snapshot` 数据仍在（P1 的持久化验收，替代 app 重启）。
4. client：右栏 tab 打开、列表/详情/设置渲染（能驱动就截图/记录；不能驱动则记录 live slot occupant 为证据 + 请用户在最终验收时目视）。
记录结果到 `docs/superpowers/spikes/2026-11-07-p1-findings.md`。

- [ ] **Step 2: 写 README**

`bug-workflow/README.md`：插件定位、安装（`dsh plugin --profile desktop add …` / 本地 `link:`）、右栏入口、P1 已实现/未实现（P2 平台接入、P3 分析子代理、P4 修复、P5 MR）清单、设置项说明、数据位置（`~/.dsh/storages/bug_workflow.json`）、已知限制（假引擎动作、无鉴权路由仅 loopback、未接 locale）。

- [ ] **Step 3: 清理与提交**

确认 `.tmp` 不提交、无 spike 路由残留；`node --test bug-workflow/test/*.test.js` 全过。

```bash
git add bug-workflow/README.md docs/superpowers/spikes/2026-11-07-p1-findings.md
git commit -m "docs(bug-workflow): P1 骨架 README 与验收记录"
```

---

## P1 退出标准

- `node --test bug-workflow/test/*.test.js` 全绿。
- live：`/bug-workflow/api/health` 200；一张工单能从 `inbox` 走到 `done`，host 半热重载后数据保留。
- 右栏 tab 打开显示看板；列表/详情/设置可用（视觉项记录证据，用户最终验收时目视）。
- 无 Critical/Important 审查问题；未完成项显式记录。
