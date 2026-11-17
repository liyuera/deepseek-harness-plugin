# 编排台设计评审报告（v0.2）

> 评审对象：[2026-11-17-orchestrator-design.md](docs/superpowers/specs/2026-11-17-orchestrator-design.md)（1175 行）与冻结原型 `docs/superpowers/mocks/orchestrator-ui.html`
> 评审方式：4 路独立评审并行 —— ① DSH API 源码核验（解包 `app.asar` 精读 + 本机 Host 服务目录）；② 领域模型/状态机/执行引擎；③ UI/UX/AX/DX（Chrome 内实测原型 DOM/焦点/对比度）；④ 安全/成本（源码 + 本机实测 curl/配置）。共 105 条原始发现，去重合并为下文 45 条。关键结论我只采纳有源码或实测证据的条目。
> 结论：**产品与 UI 契约基本成立；执行模型、审批安全、越界证据这三块必须换设计**，否则 P0 之后必然返工。

## 回写状态（2026-11-17 晚）

评审结论已按用户决策 D1–D5 与"全部接受"回写到 [2026-11-17-orchestrator-design.md](docs/superpowers/specs/2026-11-17-orchestrator-design.md) v0.3：

| 评审项 | 决策 | 落点 |
| --- | --- | --- |
| A1 执行模型 | D1 持久会话：attempt = 会话上的 turn（followup/resume） | spec §10.1–10.3、§8.3、§15.1 P0-1 |
| A2 审批可伪造 | D3 全套：connection.fetch + bearer + CAS + 归属校验 + 禁 innerHTML | spec §13.3、§13.6、§10.6 |
| A3 沙箱缺失 | D3：`setSandboxMode('workspace-write')` + checks 同沙箱 | spec §8.3、§8.4、§8.6、§13.5 |
| A4 证据不可靠 | D3：基线快照 + 路径 hash + GIT 环境净化 + foreignChanges 分级 | spec §5.5、§8.3、§12.2 |
| A5 checks RCE 面 | D5：审批页全量展示并冻结、human-only | spec §5.7、§7.5、§11.10、§13.6 |
| A6 composer/面板 | D2 内嵌宿主 Chat（外层 chrome 自绘 + 影响卡自定义） | spec §10.4、§11.9、§11.15 |
| M1–M22 / S1–S12 | 全部修入模型/接口/存储 | spec §5、§7.4、§8、§9.5、§12、§13 |
| U1–U14 | 修入 §11 契约；其中 4 处需改视觉的已获批准 | spec §11.5–11.17、§11.15 |

同时：冻结原型已同步为 v0.3.0（`docs/superpowers/mocks/orchestrator-ui.html`），新增 7 张 v0.3 截图；胶囊与动作行两个 UI 缺陷已在原型修复（§11.0）。仍待用户在 spec 终审时拍板的事项收敛到 spec §16。

**回写后校验**：另起独立校对 agent 对 v0.3 做了两轮只读复核——第一轮抓出 15 条（4 blocker：写图入口与 V20 冲突、结构改动绕过 propose、批准后 draft 不派发、orchestrator 叶子无执行通道），逐条修复后又抓出 V16–V22（状态机口径、sys id 版本化、用户中止语义、树键盘、env 机制、retryPolicy 等）与 R1–R4 文字残留，均已在本轮修掉。最终校验结论：**可以进入 writing-plans**。

## 0. 总体判断

| 维度 | 判断 |
| --- | --- |
| 产品意图（画布取代会话区、一节点一会话、全自动+门禁） | 成立，且与冻结 UI 自洽 |
| UI 视觉/交互契约（§11） | 成立，但有 14 处自相矛盾或不可施工，另有 3 处需你允许才能改（对比度/线型/快捷键） |
| 领域模型 + 状态机 | 需要补 8 处硬缺口（attempts 表、human/system 迁移、审批版本、系统节点契约、提议生命周期、墓碑、会话键、预算字段） |
| 执行模型 | **不成立**：`startActivation` 每次调用都新建子会话，不能代表"在已有节点会话里跑一个 attempt" |
| 审批与隔离 | **不成立**：本地进程（含 worker 的 bash）可伪造审批；节点会话默认继承 `danger-full-access`；越界判定可被多种方式绕过 |
| 成本上界 | 不可信：只计尝试次数与墙钟，不计 token；复用会话会让成本随重试次数近似平方增长 |

**建议节奏**：先做 1 个合并 P0 探针（节点会话 + 面板内嵌 + composer chain + 路由通道），通过后写 v0.3 spec，再进 `writing-plans`；不要现在直接实施。

## 1. 设计级阻断（必须改模型，不是改措辞）

| ID | 问题 | 证据（文件:行 / 实测） | 结论与新方案 | 涉及章节 |
| --- | --- | --- | --- | --- |
| **A1** | **执行模型错**：文档把 `startActivation` 当成"在已有节点会话里跑一个 turn" | `dsh-subagent/src/types.ts:29-46`（ActivationSpec 无目标会话参数）；`manager.ts:330-395`（每次 start 都 `mode:'continuable'` 新建 child）；续跑的真实入口是 `agent.followup`（`dsh-agent/src/runtime-types.ts:252`）或 `subagents.prompt`（`dsh-subagent/src/index.ts:451`，Remote）；冷恢复是 `agents.resume`（`dsh-agent/src/index.ts:410`） | 节点会话 = **持久 DSH session**，只创建一次（`startActivation` continuable 或 `agents.create` + `agentPresets.mount`）；每个 attempt = 该 session 上的一个 turn：热路径 `agent.followup`，冷路径 `agents.resume`→`followup`。结构化结果不再用 `outputSchema`，改为节点会话内常驻工具 **`orch_submit_result`**，宿主从 tool result 事件绑定当前 attempt。attempt 记录 `{sessionId, turnStart, turnEnd}` | §8.3 §8.5 §10.2 §10.3 §13.5 §15.1 |
| **A2** | **审批可被伪造**：把"HTTP=用户"当安全边界 | `bug-workflow/src/host/routes.js:45-46`（"a missing Origin stays allowed for local non-browser clients"）；评审实测本机 `curl` 无 Origin 访问插件路由得 200；每次 shell 注入 `DSH_HOME`/`DSH_SESSION_ID`（`dsh-shell-env`）；worker 有 bash | ① 人工动作走 **`ctx.connection.fetch.register`**（官方 host 通道，自带 Host/Origin 围栏、浏览器认证、JSON 限额；评审在运行实例 Host 服务目录确认存在），不用自建 `webServer.register`；② 路由要求**启动期随机 bearer**，只经 client bootstrap 注入（不进 env/shell）；③ 每个 action 带 `expectedVersion`，快照过期返回 `stale-view`；④ 渲染层禁用 innerHTML（XSS 是 token 泄露主路径）。**`ctx.approval.request` 不能用于画布外审批**——源码明确"必须 turn 内，否则 throw"（`dsh-user-approval/src/index.ts:242-262`） | §13.3 §13.6 §11.10 §15.1 |
| **A3** | **节点会话没有沙箱**：默认 profile 是全权 | `~/.dsh/profiles/desktop/cordis.patch.yml:38-56`（`danger-full-access` + `approval: never`，`maxActiveSubagents: 20`）；子会话只继承**显式** override（`dsh-subagent/lib/index.js:355-360`）；`setSandboxMode(session, mode)` 可用（`dsh-sandbox-policy/src/session-mode.ts:53`） | 节点会话创建后立刻 `setSandboxMode(session,'workspace-write')`，cwd=项目工作区；worker/verifier/planner 与验收命令全部受此约束；域数据目录（`~/.dsh/storages`）对 worker 天然不可写 | §8.6 §13.5 §15.1 |
| **A4** | **越界证据不可靠**：只靠前后 `git status` 差分 | 评审给出 5 种绕过：symlink 写入即删、原本就脏的文件、`.gitignore` 覆盖路径、改 `.git/config` 的 fsmonitor/hooksPath、工作区外文件。`dsh-workspace-changes` 的私有 index 快照法可借鉴，但文档写明"子代理 Session 不记录" | 证据升级：派发前建**基线快照**（私有 index `add -A` + `write-tree`）＋逐路径 hash（realpath 后）＋工作区外哨兵 hash＋`.git/config\|hooks` hash；after 用 `diff-tree` 比对；宿主 git 固定 `GIT_CONFIG_COUNT=0 / GIT_CONFIG_GLOBAL=/dev/null / core.fsmonitor=false / core.hooksPath=`；越界不止 `blocked`，还要**立即停派发**并升级门禁 | §8.3 §8.5 §13.6 |
| **A5** | **验收命令是宿主任意代码执行面**，且 agent 能改 | `settings.checks` 由宿主执行；`orch_project{action:'update',settings}` 可写；test 节点命令来源无字段（§5.2 无 `checks`） | checks 全量进**计划审批页并冻结**，human-only 修改（agent 只能 propose）；执行时同沙箱 + 净化 env（无 `DSH_HOME`/凭据）；执行顺序改为"先 checks，后 after 证据"；Node 增加 `checks[]`、`targetNodeId` | §5.2 §5.7 §7.5 §8.4 §13.1 §13.6 |
| **A6** | **composer 不能"隐藏"，面板复用 vs 像素契约二选一** | `data-conversation-composer-overlay` 只是让 composer 浮在视图上、**仍渲染**（`ConversationRoot.module.css:554,570,576`；唯一真实用例 `TrajectoryView.tsx:545`）；隐藏要用 chain 槽 `conversation.composer`（`slots.ts:290`）；面板内嵌宿主会话需 `sessions.retain` 拿 `SessionReference`、view 内声明 session 子槽、传 `{slots:{views:FixedChatConversationView}}`（`ui-subagent/sidebar-chat/index.tsx:142,160`；`slots.ts:367-387,682-686`）；宿主气泡/工具行是固定实现，插件不得 require 宿主 UI 包 | **需拍板（D2）**。推荐 B1：面板 = 内嵌宿主 Chat（外层 chrome 自绘：404 尺寸/头部/tab/composer 容器/作用域行），§11.9 的"气泡/工具行/影响卡"改成"宿主渲染 + 影响卡走 `uiConversation.events.register` 自定义事件节点"。B2 自绘面板可保像素，但要重做流式/工具/附件/中断，工作量 +3~5 天 | §10.4 §11.1 §11.9 §11.15 |

## 2. 领域模型与状态机（8 条）

| ID | 严重级 | 问题 | 证据/推理 | 修法 |
| --- | --- | --- | --- | --- |
| M1 | blocker | **无 attempts 表**：重试要注入"上次失败证据"、详情要列 attempts，但存储只有 node.evidence（仅最近一次通过） | §5.5 有结构、§12.1 无表；评审指出与 §8.5/§13.3 三处引用断链 | 新增 `attempts` 表（PK `${projectId}/${nodeId}/${attemptNo}`：trigger、nodeVersion、sessionId、turn 区间、stopReason、result、failure、evidence 指针）；Node 只留 `lastAttemptId` |
| M2 | blocker | **human/system 叶子没有可达 `done` 的迁移**：running 只属于 worker，调度器也不按 executor 过滤 | §5.4 vs §6.4/§8.2/§8.4 | 状态机补 `ready→awaiting-human→done`（human）与 `ready→executing-system→done`（system）；调度器显式跳过 human 叶子、system 叶子走宿主命令通道 |
| M3 | blocker | 状态迁移缺口与就绪规则互斥 | done 只能进 stale；但 §8.1 允许 stale 直接派发、§9.3 又要求 done 可回 blocked；`draft=false` 把状态当布尔；父级检查只一层 | 明写 `stale→queued`、`done→blocked`、`awaiting-approval→draft`；就绪条件改 `status∈{ready,stale}` 且**祖先链**无 draft/canceled、父容器 gate 未决则不就绪 |
| M4 | blocker | **写图入口被工具绕过**：`orch_node.patch` 可改 scope/artifacts，`orch_plan.merge` 批准后还能加节点；§9.4 的"破坏性变更门禁"可被绕过；`gate/executor/readOnly` 也可被 patch | §13.1 vs §10.6/§13.6/§7.4 | 工具按 changeClass 分流：contract/structure/scope/gate/executor/readOnly 一律只能 `orch_propose`；patch/plan 加 `expectedVersion`+`basePlanVersion`；工具层对 human-only 字段返回 `needs-human` |
| M5 | blocker | **没有"已批准计划版本"记录**：planVersion 继续 +1，merge 增量改图不需重批 | §7.5 批准只体现为 gate 节点 done | Project 增加 `approvedPlanVersion/approvedAt/approvedBy` 与 `planApprovals[]`；批准后再 merge → 项目回 `awaiting-approval` 并生成新门禁 |
| M6 | major | 系统生成节点（plan-approval / bugfix / 升级 gate）无生成契约 | 未定 parent/id/order/边/波次归属/是否计入统计；下轮 V1/V2/V7/V10 会判非法，id 可被计划抢占 | 保留 id 前缀（如 `sys:`）+ `system=true` + 生成规则（parent、自动 verifies/depends_on、order 末尾、不计入叶子统计）；V 规则对 system 节点单独校验 |
| M7 | major | 提议无生命周期：无 status/approver/baseVersion/TTL；「稍后」不落库会丢 | §9.5/§12.1/§11 影响卡 | proposals 改 PK `proposalId`，加 `status(pending/approved/rejected/expired/superseded/snoozed)`、`baseNodeVersion`、`basePlanVersion`、`expiresAt`、`decidedBy/decidedAt`、`snoozedUntil`；同一 `(nodeId, changeClass)` 的 pending 合并 |
| M8 | major | 契约版本双源、冻结状态表达不了"待审"；消费边无 pin | `node.version` 与 `artifacts[].version` 都可代表契约；`frozen` 只有 boolean | 契约版本唯一 = `artifact.version`；Node 加 `freezeState:none\|pending\|frozen` + `frozenVersion`；Edge 加 `pinnedVersion`，影响引擎按 pin 与当前版本比较生成 `staleBy.reason` |
| M9 | major | 删除/重建节点无墓碑，引用悬挂且 id 可复用 | edges/threads/events/nodeSessions 悬挂；同 id merge 会复用旧会话 | Node 加 `deletedAt` 软删 + 级联清理 edges；`reservedIds` 禁止复用；会话/线程保留并标 orphan |

## 3. 执行引擎、预算与通知（7 条）

| ID | 严重级 | 问题 | 修法 |
| --- | --- | --- | --- |
| M10 | blocker | 节点↔会话键不支持 fork：nodeSessions 单行 `${projectId}/${nodeId}`，threads 主键含 turn 会因新会话重号覆盖；ensure-session 与首次派发两个懒创建入口无 CAS | nodeSessions 改 `${projectId}/${nodeId}/${sessionId}` + `isActive`；Node 加 `activeSessionId`；attempts 绑 `sessionId`；ensure-session 以 CAS(null→id) 为唯一创建路径；threads 主键 = sessionId+turn |
| M11 | major | 调度口径两套：tick 有 timer 与状态变更两个触发无租约；`maxWorkers` 是否含 queued 未定；V12 计划期冲突报错与运行期"跳过"理念相反 | tick 加 lease；名额计数含 queued 并有预留；`maxActiveSubagents` **读运行实例（本机实测 20，不是 8）**；容量等待与启动失败分开（不计 attempt/breaker） |
| M12 | major | 失败/重试矩阵不完整、修复链可指数放大；预算缺 token 口径 | 统一 `retryPolicy{kind:auto\|manual\|none, consumesAttempt, backoffMs}`；`repairBudget{maxNodes,maxAttempts}` 跨链共享 + 失败签名去重；引入 **token 预算**（`TokenMeter.measure`，`dsh-token-meter/src/index.ts:87,151`）三层硬上限，attempt 前 reserve；复用会话超 2 次或超 60% 上下文强制 compaction / 新会话 |
| M13 | major | 影响传播不可执行："影响面 ≤5"未定义首跳/级联、距离函数、终止规则；scope 变更未触发 conflicts 与波次重算 | 定义 `blastRadius` 的距离（边数）与计数时机、去重、"派生事件不二次传播"；scope 变更归 structure 子类并重算 conflicts/波次 |
| M14 | major | 运行中写范围冲突三处不一致（暂停兄弟 / 等完成 / 跳过候选） | 统一：已完成不打断；running 等其完成；queued 回 ready；删掉 9.3 的"暂停"与 9.4 的"中止需用户确认"（列入 v1 不做） |
| M15 | major | 通知无 outbox/去重；门禁待办无 UI 入口；`rhythm=wave/phase` 停机无状态 | `notifications` 表（dedupeKey/ackedAt）+ 项目级限流（≤2 次/分钟，合并摘要）；项目卡"待审批"可点循环跳转；加 `awaiting-continue` 状态 + `continue` action |
| M16 | major | Project 缺 `statusReason`/`budgetUsed`；paused/blocked 语义空洞；settings 按工作区存却承载项目级预算 | Project 加 `statusReason{code,message,at}`、`budgetUsed{attempts,tokens,activeMs}`；settings 拆 workspace 默认 + project 覆盖 |

## 4. 接口、存储与并发（6 条）

| ID | 严重级 | 问题 | 修法 |
| --- | --- | --- | --- |
| M17 | blocker | 人工动作与工具能力冲突：`orch_run` 含 stop、`orch_project.update` 可改 settings、`/orch stop`，但 §13.6 声明这些 human-only | 工具与命令删除人工动作（或返回 `needs-human`）；settings 中 budget/maxWorkers/maxImpactAuto/checks 显式 human-only |
| M18 | major | 路由跨工作区越权读 + actionId 账本 500 条会淘汰（重试→重复传播） | 每个 handler 用 sessionId→`header.cwd` 校验 = project.workspacePath；GET 也要客户端令牌；幂等键进 events（≥5000）且"效果幂等"不对 FIFO 淘汰 |
| M19 | major | `orch_run start` 与 driver 存活两套逻辑；attempt 计数口径覆盖不全（startup 重试/中断/修复/手动） | driver 不 live 时**不进调度、不计 attempt、不计活跃时长**；"父 agent 不在"从失败表移除 |
| M20 | major | `tools.guard` 用法不当：guard 只能 deny、且对未知 preset 返回 deny 会误伤 code-review 等插件；白名单应该用 `restrict`；注册不随卸载清理 | guard 只对已知 preset + 具体危险参数 deny；白名单用 `agent.ctx.tools.restrict({allow})`；注册挂 `agent/created`（含 resume），卸载/`agent/disposed` 双路径清理 |
| M21 | major | 会话级注册时机假设错误：`agents.get` 只返回 live agent，冷会话必须先 `sessions.retain`/resume | 面板打开先 retain 促发 resume；注册在 `agent/created` 回调里做；不要依赖 `agents.get` 同步返回 |
| M22 | minor | `artifacts.path` 可写但无 realpath 校验；artifacts 长度上限无数值；events/threads 有界策略不对称 | 落盘路径宿主生成，只接受相对名且前缀 `.orchestrator/`；artifacts ≤32KiB、action ≤48KiB；threads 每节点保留 50 条、pending 提议不淘汰 |

## 5. UI / UX / AX / DX（14 条，其中 3 条需你允许改视觉）

| ID | 严重级 | 问题 | 修法 |
| --- | --- | --- | --- |
| U1 | blocker | **键盘无法选中任何节点**（原型只处理 Esc/0/f/+/-///e），与 §11.6/§11.7 承诺矛盾，`role=button` 无键盘激活也违反 ARIA | 卡片 `keydown(Enter/Space)→select`；禁用卡选中只读；补 P1 回归 |
| U2 | blocker | 面板收起后仍在 Tab 序与无障碍树（`.hidden` 只改 opacity），焦点停在不可见按钮 | 收起 `display:none`+`inert`+`aria-hidden`，焦点移 FAB；恢复焦点进面板；写入 §11.9/§11.17 |
| U3 | blocker | **六态不可断言**：`data-state` 只有 4 值且与选中/加载互斥；`states` 声称 6 个；P1 却要求"六态可用 data-* 断言" | 拆三轴：`data-state`(4) + `data-selected` + `data-hover`/`data-active`；`states` 改为 `[{name,hook}]` |
| U4 | blocker | `test`/system 节点四处互斥（对话禁用 / 禁用态 / 专属空态 / composer 仍显示） | 统一：system 节点 `data-state=disabled`、对话 tab 专属文案、composer 隐藏/禁用 |
| U5 | major | 面板内跳转（上游 pill）会把焦点抢回画布卡片 | `select(id,{focus:false})`；焦点留在 pill 链 |
| U6 | major | 折叠会隐藏当前选中节点且无规则；搜索只能到第一个命中（200 节点时其余不可达） | 折叠含选中项的容器 → 选中上移该容器并播报；`⏎` 循环命中 + `n/m` 计数 + `Shift+⏎` 回退 |
| U7 | major | 门禁/待审批无法直达；无 toast/未读；FAB amber 点写死；影响卡「稍后」无状态 | 项目卡"待审批"可点循环跳转；toast 规范（右下 z=50、`role=status`、≤3 条、点击定位）+ FAB `data-unread`；proposals 加 snooze/dismissed |
| U8 | major | "详情 tab 是审批唯一入口"与"影响卡按钮就在对话 tab"矛盾 | 影响卡按钮改为深链到详情待确认区（推荐），或改写 §11.10 表述为两类入口 |
| U9 | major | 画布无树语义；卡片 aria-label 不含进度/徽章；折叠胶囊无 `aria-expanded`；边无替代文本 | 画布 `role=tree`、卡片 `role=treeitem`（含 aria-level/expanded）或 application+roving tabindex；`aria-describedby` 指向指标徽章；边加 `aria-label` |
| U10 | major | 仅靠颜色区分上下游（同为实线）；dim 后文字对比 <1:1；实测 token 对比度：text-3 2.64、amber 文字 3.84、白字 on amber-solid 3.57 | **需你允许**：上游实线 / 下游双线（或虚线）；dim 只压底与边框、文字保持 ≥3:1；text-3/amber 提级；§11.17 写对比度门槛 |
| U11 | major | 右键菜单键盘不可达（无 Shift+F10）；快捷键守卫不判 contenteditable / IME 组字 | 菜单 `role=menu` + Shift+F10/M；守卫 `closest('input,textarea,[contenteditable],select')` + `isComposing`；「重置位置」进详情动作区 |
| U12 | major | DX 不足：`orchDebug` 原型不存在；`getDemoNodes()` 语义写错；无 `getView/getPanel/getNodeState/whenIdle`；关键动作（审批/驳回/暂停/发送）无稳定 `data-action`；边无 `data-rel` | 补齐 API 与选择器；`loadFixture()/reset()` 支撑 200 节点与审批 e2e；`select()` 返回 `{ok,code}` |
| U13 | major | 小地图 `aria-hidden=true` 却要求缩略块可点；`data-node-id` 实测不存在 | 小地图改 `role=group`+可交互缩略块，或只做平移、aria-hidden 只给纯视觉副本 |
| U14 | major | 多项不可施工/自相矛盾：Tab 序写成"中序"（实际前序 DFS）；窄窗口无断点；"按内容长高/顶部细条/视图可见/CSS 断点"无默认值；空态缺"驱动会话离线/暂停/预算/加载"；面板持久化三处矛盾；提示条两种定义；scope 标注未落位；Esc 三处；200 节点缺父子/兄弟导航 | 逐条给默认值：`padR<1024→30`、提示条与 notice 拆两个元素、`data-zoom-tier`(k<0.5)、细条高 28 高 z=50、`data-empty="driver-offline\|paused\|budget\|loading"`、面板状态 localStorage、Esc early-return、详情顶部面包屑 |

## 6. 安全与成本（残余 7 条，已并入 A2/A3/A4/A5/M12/M15 的不再重复）

| ID | 严重级 | 问题 | 修法 |
| --- | --- | --- | --- |
| S1 | major | 凭据/网络隔离纯提示词：每次 shell 注入 `DSH_HOME`，`~/.dsh` 凭据同用户可读 | worker 最小 env（不注入 DSH_HOME、清除 provider/key 变量）；`run_in_background` 由 guard 按结构化参数拒绝；出站白名单列入 v1.5，v1 至少 env 净化 + 证据脱敏 |
| S2 | major | guard 不是安全边界（bash 参数可 `sh -c`/base64/别名/`git -C` 绕过） | 不把命令文本匹配当边界；沙箱+独立身份为主，guard 只做工具名与结构化参数（如 `run_in_background`） |
| S3 | major | 计划审批页不含 checks/scope 并集/首波节点，用户"盲批"即放行全权 worker | 审批页强制展示 checks 全量、scope 并集与冲突、首波前 5 节点 intent/命令/预计文件；删除类 glob 与 `**` 逐条勾选；首波只放 ≤3 文件节点 |
| S4 | major | 证据（checks 输出/线程摘要）无脱敏，可能把密钥落库并展示 | 入库前脱敏（token/私钥/连接串/长 hex）；evidence 原文默认不随 snapshot 返回；域数据 0600 |
| S5 | major | 预算只计次数/墙钟，token 消耗无上限（面板对话、followup 唤醒、code-review 都算钱） | 并入 M12：token/费用三层预算，驱动唤醒与面板消息同账本；按项目限流 followup（≤2 次/分钟） |
| S6 | major | code-review 可能对节点会话每 turn 触发（成本翻倍），且 guard 误伤其它插件 | P0 验证触发条件；按 preset 排除；guard 未知 preset 返回 undefined 不 deny（并入 M20） |
| S7 | major | 插件在驱动会话注册全局 listener/guard，与既有 4 个插件共存无隔离说明 | 注册以 sessionId 精确匹配 + 启动回填角色；提供 `orchDebug` 自检视图列出本插件注册项 |

## 7. 需要你拍板（5 项）

| # | 决策 | 选项 | 我的建议 |
| --- | --- | --- | --- |
| D1 | 节点会话执行模型 | a) 持久会话：首次 `startActivation(continuable)`/`agents.create` 建，之后 `followup`/`resume` 驱动，`orch_submit_result` 收结构化结果（**推荐**，真正"一节点一会话"）<br>b) 每个 attempt 新建会话，节点对话只看最近一次（实现简单，但"重试复用"作废、每 attempt 成本线性） | a |
| D2 | 面板 UI 路线 | a) 内嵌宿主 Chat（§11.9 退化为外层 chrome + 影响卡自定义，工作量小、体验与 DSH 一致）<br>b) 自绘面板（保像素级 §11.9，流式/工具/附件/中断重做，+3~5 天） | a |
| D3 | 审批通道 | a) `connection.fetch` + 启动期 bearer + `expectedVersion` CAS + 沙箱（务实防线）<br>b) 再加"driver 会话内 `ctx.approval.request`"二次确认（改造大，且只能 turn 内） | a（b 留 v1.5） |
| D4 | 为安全/AX 动冻结 UI | 需要你逐项允许：①上游实线/下游双线（不只靠颜色）；②text-3/amber 提对比度；③低缩放改用字形+保留徽章色点；④FAB 加 aria-label（无视觉变化）；⑤新增"打开面板"快捷键 | ①②③⑤ 建议允许，④ 属无障碍修补默认做 |
| D5 | 计划审批页展示 checks 全量并冻结 | 会显著加长审批页，但能防止"盲批即放行全权 worker" | 建议接受 |

## 8. 重排后的 P0 探针（先验后写）

| 顺序 | 探针 | 一次验完 | 失败退路 |
| --- | --- | --- | --- |
| P0-1 | **节点会话全链路**：创建（startActivation continuable 或 agents.create+preset mount）→ 面板内嵌（SessionReference/子槽/固定 views）→ 发消息 → 中止 → 第二轮 followup → 冷 resume → 会话列表可见 | A1、A6、M10、M21、API F4/F6/F8 | 退化为"每 attempt 新建会话 + 对话只读回看"，D1 选 b |
| P0-2 | **composer chain 接管**：编排台激活时 composer 返回 null，切回对话即恢复 | A6 前半 | 保留宿主 composer 但禁用（仍占空间，布局另算） |
| P0-3 | **connection.fetch 路由**：注册 `/api/orchestrator/*`、bearer 校验、非 HTML origin 拒绝、JSON 限额 | A2 | 退回自建 webServer + 全量自校验（安全项自己实现） |
| P0-4 | **沙箱继承**：节点会话 setSandboxMode 后写 `~/.dsh`、`.git/config`、工作区外文件均被拒 | A3、M20 | 独立 OS 用户/容器（v1 可能来不及，则降级"受限功能 + 明示风险"） |
| P0-5 | **容量与成本**：实测 maxActiveSubagents、tokenMeter 读数、code-review 是否对节点会话触发 | M11、M12、S5、S6 | token 预算降级为"提示 + 软上限" |
| P0-6 | **证据基线**：私有 index 快照 + 5 种绕过回归 | A4 | 退化为"scope 交集 + 人工抽查"，并在 UI 明示证据可信度 |
| P0-7 | **200 卡片性能 + 主题 token 映射 + data-* 断言面** | M22、U3、U12、§15.1 | 视口裁剪、节点上限 100 |

## 9. 评审证据索引（可复核）

- 执行模型：`/tmp/dsh-src/@deepseek-ai/dsh-subagent/src/{types.ts:29-46,index.ts:267-290,451-470}`、`manager.ts:330-395`；`dsh-agent/src/{index.ts:410-470,runtime-types.ts:252}`；`dsh-agent-preset-registry/src/session.ts:40`
- 安全：`~/.dsh/profiles/desktop/cordis.patch.yml:38-56`；`bug-workflow/src/host/routes.js:45-46,1456-1470`；`dsh-sandbox-policy/src/session-mode.ts:53`；`dsh-tools/src/contracts.ts:186,396-410`；`dsh-user-approval/src/index.ts:242-262`（turn 内限制）；`dsh-jobs` README:40；`dsh-workspace-changes` README
- 通道：`dsh-client-connection/src/rpc.ts:169-210`、`rpc-host.ts:114-120`；`dsh-host-webserver/src/index.ts:445`；`dsh-storage-domain/src/{spec.ts:35-70,domain.ts:167,283}`
- UI：`dsh-client-ui-conversation/src/client/{skeleton/ConversationRoot.module.css:554-576,contract/slots.ts:285-387,682-686}`；`dsh-client-ui-subagent/src/client/sidebar-chat/index.tsx:142,160`；`dsh-client-ui-conversation/src/client/conversation/event-registry.ts:30`；`dsh-client-ui-session/src/client/index.ts:77-95,353`
- 原型实测：Chrome file:// 加载 `orchestrator-ui.html`（1800×1008、DPR2）测 DOM/焦点/Tab 序/对比度/行为；已知 12 处缺陷见 spec 文首修订 7，本报告未重复。
