# Bug 工作流插件 P3（分析子代理 + 方案审核）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 P1/P2 的「假引擎·开始分析/分析完成」换成真子代理：点击开始分析后，插件在宿主里用 `ctx.subagents.startActivation` 起一个只读分析子代理读工作区代码，产出结构化修复方案（summary/rootCause/approach/changedFiles/risks/testPlan），写回工单进入 `plan_review` 供人工审核；失败/超时进入 `blocked` 并可重试。方案审核 UI（通过/驳回）在 P1 已存在，P3 补齐真数据与状态反馈。

**Architecture:** 新增 `src/host/agent-access.js`（依赖注入、纯逻辑可单测的 runner：活 Agent 解析、子代理启动、输出解析/校验、超时/取消）与 `src/host/analysis-service.js`（工单状态编排 + 异步任务 + 错误落盘）；路由新增 `POST /api/analyze`，snapshot 增加 `analysis:{running, errors}`；client 把 `start_analysis` 改为调用真分析接口并展示分析中/失败/方案 UI。子代理契约来自 P0 Spike D（`startActivation` + `delivery:'caller'` + 必传 signal + exact live parent Agent；热重载经 remove_bundle→install_bundle）。

**Tech Stack:** DSH `ctx.subagents` / `ctx.agents` / `ctx.sessions`（经 `ctx.get` 可选获取，便于无该服务的 profile 降级）、现有 store/state-machine/routes/client。

## Global Constraints

- 子代理必须挂在 **exact live Agent** 上；解析顺序：`agents.list()` 中 sessionId 匹配 → `agents.roots()` 最后一个 → 不可用则返回 `no-live-agent`（503），不得伪造。
- 分析子代理**只读**：prompt 明确「不要修改任何文件、不要执行破坏性命令」；产物只接受 JSON（解析失败 → `analysis-bad-output`，不猜）。
- 超时默认 10 分钟（可配置 `analysisTimeoutMs`）；取消/卸载时 abort，且不留下持久 running 状态。
- `analysis_done` 写入前必须复查状态机（人工可能已驳回/取消），非法迁移则丢弃结果并记录 meta 错误；`block` 只用于真实失败。
- 错误 message 一律静态、无 token/无内部堆栈；分析错误同时存 meta（`analysis.error:<code>`）供 snapshot 展示，不新增 Ticket 字段（保持 domain v2 不变）。
- 单工单单分析（同 code 重复点击返回 running，不重复起子代理）；不同工单可并行。
- 测试 `node --test bug-workflow/test/*.test.js`；热重载用 `plugin_manager`；token/子代理等敏感信息不打印。
- 参考：[P0 findings](../spikes/2026-11-06-p0-findings.md)（Spike D 子代理契约）、[P2 findings](../spikes/2026-11-07-p2-findings.md)、[设计 spec](../specs/2026-11-06-dsh-bug-workflow-plugin-design.md) §9/§14。

## 接口与数据契约

```js
// agent-access.js（依赖注入，无 bare import）
createAgentRunner({ services })        // services.get(name) → cordis service | undefined
  .available() -> boolean              // subagents + agents 都在
  .resolveParent(sessionId) -> agent | null
  .runAnalysis({ sessionId, cwd, ticket, timeoutMs = 600000, signal? }) ->
      Promise<{ ok:true, plan: Plan, childId, elapsedMs } |
              { ok:false, code:'analysis-unavailable'|'analysis-timeout'|'analysis-failed'|'analysis-bad-output', message }>

// analysis-service.js（纯编排，注入 store/runner/clock）
createAnalysisService({ store, runner, clock })
  .start(cwd, code) -> Promise<{ ok:true, running:boolean, workflow:'analyzing' } |
                               { ok:false, code, message }>   // 同步启动，后台跑
  .status() -> { running: string[], errors: Record<code, string> }
  .dispose() -> void                   // abort 运行中任务

// Plan（复用 P1 形状）
{ summary, rootCause, approach, changedFiles: string[], risks: string[], testPlan }
```

**路由**：`POST /bug-workflow/api/analyze` body `{sessionId, code}`，复用所有 P1 guard；响应 200 `{ok:true, workflow:'analyzing', running:true|false}`；错误：400 `unknown-workspace`/`invalid-code`、404 `ticket-not-found`、409 `invalid-state`、503 `no-live-agent`/`analysis-unavailable`、500 内部。

**snapshot 扩展**：`analysis: { running: string[], errors: { [code]: string } }`（保留现有字段）。

**client**：
- `start_analysis` 按钮改为 POST `/api/analyze`（action-map literal 不变，测试仍通过）；
- `analyzing` 状态显示「AI 分析中…（最长约 10 分钟，可继续做其他事）」+ 已运行时长（基于 snapshot `analysis.startedAt`? 简化：本地计时）；
- 展示 `analysis.errors[code]`（含 `analysis-failed`/超时/无可用 Agent 的静态提示）与「重新分析」（blocked 时先 `retry` 再 analyze）；
- 方案卡：changedFiles/risks 列表、testPlan 段落，仍然「通过 / 驳回」。

---

### Task 1: Agent runner（活 Agent 解析 + 子代理启动 + 输出解析）

**Files:** Create `bug-workflow/src/host/agent-access.js`；Test `bug-workflow/test/agent-access.test.js`

**Interfaces:** 见上；后续 Task 2/3 依赖。

- [ ] **Step 1: 读契约**：`cordis_inspect_query(platform:'host', provider:'Service', input:{service:'subagents'})`、`{service:'agents'}`、`{service:'sessions'}`；安装版 `@deepseek-ai/dsh-subagent/README.md`、`dsh-agent/README.md`（file-read）；确认 `startActivation` 参数（provider/label/request.prompt/parent/cwd）、`delivery:'caller'` 结果形状、signal 必传、`agents.list()/roots()` 返回与 Agent.session 字段。写入 report。
- [ ] **Step 2: 失败测试**（fake services）：
  - resolveParent：sessionId 匹配优先、roots 回退、无服务/无 agent → null；
  - runAnalysis happy path：断言 `startActivation` 参数（provider/label/parent/cwd/delivery/signal）、prompt 含工单信息且含「只读」、childId 返回、plan 解析（含 ```json 围栏、前后空白、多余文字中首个 JSON）；
  - 输出字段缺失/类型错/非 JSON → `analysis-bad-output`；
  - 超时（fake activation 挂起 + 可注入短 timeout）→ `analysis-timeout` 且 signal aborted；调用方 signal abort → `analysis-failed`；
  - activation throw → `analysis-failed`；无服务 → `analysis-unavailable`；错误 message 不含 token（无 token 输入）。
- [ ] **Step 3: 实现** `createAgentRunner`；prompt 构造函数单独导出便于断言；`extractJsonPlan(text)` 纯函数导出。
- [ ] **Step 4: 验证**：`node --test bug-workflow/test/*.test.js` 全过；`node --check`。
- [ ] **Step 5: 提交** `feat(bug-workflow): 分析子代理 runner 与输出契约`。

---

### Task 2: 分析服务 + `/api/analyze` + snapshot 扩展 + 接线

**Files:** Create `bug-workflow/src/host/analysis-service.js`；Modify `bug-workflow/src/host/routes.js`、`index.js`；Test `bug-workflow/test/analysis.test.js`、`test/routes.test.js`

- [ ] **Step 1: 失败测试**（真 store/fake domain + fake runner）：
  - start：工单 inbox → 调 `start_analysis` 后 200/running，后台完成 → `plan_review`、plan 字段写入、timeline 含 analysis_done；同 code 二次 start → 不重复起 runner；
  - runner 失败 → `blocked`、`blockedReason:'analysis-failed'`、meta `analysis.error:<code>` 静态、status().errors 可见；
  - 人工在跑期间 approve/驳回/retry 导致 `analysis_done` 非法 → 结果丢弃且不破坏状态；
  - 超时 → blocked（reason `analysis-timeout`）；
  - runner unavailable → 503 映射；未知工单 404；非法状态 409；
  - dispose 时 abort 运行中任务且 running 清空。
- [ ] **Step 2: 实现** analysis-service（running Map、后台 promise、错误落 meta、dispose）；
- [ ] **Step 3: 路由与接线**：`POST /api/analyze`（复用 guards，错误映射），snapshot 加 `analysis`；index 用 `ctx.get('subagents'/'agents'/'sessions')` 构造 runner（缺失则 runner.available()=false，navigate 503），store 就绪后创建 analysis service，disposer 调 dispose。
- [ ] **Step 4: 验证**：tests 全过；live remove→install 后 health 200、snapshot 含 `analysis`、`POST /api/analyze` 对不存在工单 → 404、对 manual 工单（无子代理服务时？desktop 有服务）→ 200 开始真分析（Task 4 再验）。
- [ ] **Step 5: 提交** `feat(bug-workflow): 分析服务与 /api/analyze 接线`。

---

### Task 3: Client 真分析交互

**Files:** Modify `bug-workflow/client.js`

- [ ] **Step 1: `start_analysis` 走真接口**：`executeAction` 中当 action==='start_analysis' 时 POST `/api/analyze`（JSON、sessionId/code），成功后刷新；错误映射：409（状态不对提示刷新）、503（子代理不可用：提示需在打开的会话中操作/稍后重试）、404。
- [ ] **Step 2: analyzing 反馈**：详情页显示「AI 分析中…」+ 计时（本地 setInterval 只在 analyzing 时开）+ 提示可继续其他操作；button 禁用 busy。
- [ ] **Step 3: 失败与重试**：显示 `snapshot.analysis.errors[code]` 或 `blockedReason`（静态文案映射 `analysis-failed`→「分析失败，可重试」、`analysis-timeout`→「分析超时」、`no-live-agent`→「当前没有可用的会话 Agent」）；blocked 状态提供「重新分析」= retry 后自动 analyze（同一确认）。
- [ ] **Step 4: 方案卡增强**：changedFiles/risks 列表、testPlan 段落；保留通过/驳回。
- [ ] **Step 5: 回归**：action-map literal/测试不变；`node --check`；`node --test` 全过（197）；GUI 视觉未验证记录。
- [ ] **Step 6: 提交** `feat(bug-workflow): 看板真分析交互与方案展示`。

---

### Task 4: Live E2E + README/findings + 收尾

**Files:** Modify `bug-workflow/README.md`、新增 `docs/superpowers/spikes/2026-11-07-p3-findings.md`

- [ ] **Step 1: Live E2E（真子代理）**：选一张可分析工单（如 `YGFNXDJRFWDJSYJJYY-648`，inbox、平台来源、描述来自 mock）；`POST /api/analyze`（live session id）→ 200；轮询 snapshot 直到 `plan_review`（超时 10 分钟）；断言 plan 五字段、changedFiles 非空；`approve_plan` → fixing；记录耗时/子代理 childId/模型（不记录敏感内容）。
- [ ] **Step 2: 失败路径（不依赖线上故障）**：用单元测试证据 + 记录「live 失败路径通过注入不可用 runner 的单元测试覆盖」；如可行，对不存在的工单走 404、对非法状态工单走 409 live。
- [ ] **Step 3: 清理/收尾**：E2E 工单保留为 demo 并注明；无残留子代理会话/DISPOSE 记录；token/mock 状态复核（P2 已复位）；host 热重载后数据保留。
- [ ] **Step 4: 文档**：README 增加 P3 能力与限制（真分析需要 live 会话 Agent、只读、超时 10 分钟、成本提示；假引擎动作仅剩 fix/review/merge 为 P4/P5 演示）；findings 记录 E2E、未验证项（GUI 视觉、failure live、多工单并行）。
- [ ] **Step 5: 提交** `docs(bug-workflow): P3 真分析验收记录与 README`。

---

## P3 退出标准

- `node --test bug-workflow/test/*.test.js` 全绿（新增 runner/analysis/routes 用例）。
- live：一张工单经 `/api/analyze` 由真子代理产出合法 plan 并进入 `plan_review`；人工通过进入 `fixing`；错误/超时/不可用路径有单元测试证据。
- 无 Critical/Important 审查问题；GUI 视觉与真实成本/时长列为用户验收项。
- Ticket/domain 仍为 v2（不改 schema）；store 写串行化不被破坏。
