# 编码长任务编排系统（Orchestrator）设计

> **状态**：v0.3 草案（已过四路独立评审 + 用户决策 D1–D5，待终审后进实施计划）
> **日期**：2026-11-17
> **评审依据**：[2026-11-17-orchestrator-review.md](docs/superpowers/specs/2026-11-17-orchestrator-review.md)（105 条原始发现 → 45 条去重结论）
> **冻结的 UI 契约**：`docs/superpowers/mocks/orchestrator-ui.html`（原型 v0.3.0，含 `window.orchestratorUI` 0.3.0 契约）+ 截图 `shot-orchestrator-v03-focus.jpg`（选中/关系/动作行）、`shot-orchestrator-v03-deselected.jpg`（空白取消）、`shot-orchestrator-v03-lowzoom.jpg`（低缩放降级）、`shot-orchestrator-v03-states.jpg`（六态/快捷键）、`shot-orchestrator-v03-light.jpg`（浅色对比度）、`shot-orchestrator-v03-downstream.jpg`（下游双线）、`shot-orchestrator-v03-container-actions.jpg`（容器动作行/胶囊）。§11 是原型的文字转写，冲突以原型为准并回写本节
> **目标运行环境**：DeepSeek Harness 0.2.2-rc.1（desktop profile）；事实依据为本机 `app.asar` 解包源码与运行实例实测
> **插件位置**：`deepseek-harness-plugin/orchestrator/`；npm 包名 `@liyuera/dsh-orchestrator`；界面名「编排台」
> **参考实现**：`bug-workflow/`（子代理 + storageDomain + 路由）、`code-review/`（preset 只读子代理 + tools.guard + 结构化输出）、`mr-loop/`（宿主只读聚合 + 轮询）、官方 `dsh-client-ui-subagent/`（子会话聊天参照）、`dsh-client-ui-trajectory/`（composer overlay 参照）
>
> **v0.3 相对 v0.2 的修订**（评审驱动，含用户决策）
> 1. **执行模型改持久会话（D1）**：`startActivation` 每次调用都会新建 continuable 子会话，不能代表"在已有节点会话里跑一个 turn"。节点会话只创建一次；attempt = 该会话上的一个 turn（热 `agent.followup`，冷 `agents.resume` + followup）；结构化结果改用常驻工具 `orch_submit_result`，不再依赖 `outputSchema`。
> 2. **面板改内嵌宿主 Chat（D2）**：404 外壳 / 头部 / tab / 作用域行 / composer 自绘并冻结；消息流、工具行、流式由宿主 Chat 渲染；影响卡通过 `uiConversation.events.register` 注册自定义事件节点；发送走宿主 action → `followup`。
> 3. **安全基线全套（D3/D5）**：人工动作走 `ctx.connection.fetch` + 启动期 bearer + `expectedVersion` CAS + 会话→工作区归属校验；节点会话创建即 `setSandboxMode('workspace-write')`；checks 全量进计划审批页并冻结（human-only）；越界证据改基线快照 + 路径 hash + GIT 环境净化；渲染层禁 innerHTML。
> 4. **领域模型补硬缺口**：新增 `attempts` / `notifications` 表；Project 加 `approvedPlanVersion/planApprovals/statusReason/budgetUsed/settings`；Node 加 `activeSessionId/chatSessionId/lastAttemptId/checks/targetNodeId/freezeState/frozenVersion/system/deletedAt`；Edge 加 `pinnedVersion`；proposals 补生命周期与 snooze。
> 5. **状态机补分支**：新增 `awaiting-human`；补 `stale→queued`、`done→blocked`；审批通过后**全部叶子置 `ready`**、派发由 §8.1 门控；driver 不 live 不进调度、不计 attempt/预算；`rhythm` 停机用 `awaiting-continue`。
> 6. **预算与容量**：token/费用三层预算（`TokenMeter`）；`maxActiveSubagents` 以运行实例为准（本机实测 **20**，不是 8）；修复链共享配额 + 失败签名去重；容量等待不计失败。
> 7. **UI 契约修补**：键盘选中、面板收起 inert、六态拆三轴可断言、搜索循环、折叠时选中上移、门禁直达、toast/未读、DX getter/fixture、树语义、窄窗口断点、空态补齐。原型已同步到 v0.3.0。
> 8. **经用户批准的冻结 UI 修正 6 处**（§11.15）：上游实线/下游双线；text-3 与 amber 提对比度；低缩放状态字形 + 徽章色点；FAB aria-label + 打开面板快捷键 `O`；折叠胶囊完整外挂；卡片高度按内容自适应（含动作行）。
> 9. 原型 v0.2 的 12 处已知缺陷在实现中必须修掉并转成 P1 回归用例（见 §11.15 与 §15.2）。

## 0. 已确认的产品选择

| 决策点 | 选择 | 决策来源 |
| --- | --- | --- |
| 项目归属 | **工作区级**：一个项目绑定工作区目录，任何会话都能打开同一棵树 | v0.1 |
| 推进自主度 | **全自动循环**：拆解 → 执行 → 验证 → 自动修复一路推进，只在异常、门禁、预算耗尽时停 | v0.1 |
| 节点对话 | **一节点一会话 + 持久会话**：节点会话只建一次，attempt 用 `followup`/`resume` 续跑；重试默认复用同一会话（可「新会话重试」） | D1 |
| 面板实现 | **内嵌宿主 Chat**：外壳自绘（404/头部/tab/作用域/composer），消息与工具行由宿主渲染，影响卡自定义事件节点；发送经宿主 action → followup | D2 |
| 安全基线 | **全套**：`connection.fetch` + 启动期 bearer + `expectedVersion` CAS + `setSandboxMode('workspace-write')` + checks 审批冻结 + 基线证据 + 禁 innerHTML | D3/D5 |
| 界面形态 | **画布取代会话区域**：`conversation.view` 全幅接管内容区，无限画布从左到右展示拆解树；侧栏会话历史与顶栏保持宿主原样 | v0.1 + 冻结 UI |
| UI 冻结 | 视觉与交互以原型 v0.3.0 为准（§11 为文字转写）；实现只补原型未画到的面（§11.15），并执行 6 处已批准的修正 | D4 + 评审 |
| 首版范围 | **完整内环**：拆解 + 画布 + 节点会话 + 波次执行（含基础影响传播） | v0.1 |
| 代码落地 | **主工作区 + 写范围冲突串行**（不做 worktree 隔离） | v0.1 |
| 类型粒度 | **完整 25 种**，v1 启用 17 种，其余 8 种实验性 | v0.1 |
| 预算口径 | attempts + 活跃时长 + **token/费用**三层；`maxActiveSubagents` 读运行实例（本机 20） | 评审 S5/M12 |
| 端到端验收 | 在本插件仓库里新增一个小插件作为真实需求 | v0.1 |

## 1. 背景与目标

### 1.1 问题

一套完整项目（数据库设计 + 后端接口 + 管理后台 + 移动端 + 联调）或一批长任务，直接塞进一个会话时：

- 上下文会被"做完的实现细节"淹没，主 agent 记不住全局计划；
- 拆解、排期、派发、验收全靠人盯，长任务一停就断；
- 前后端并行时必须先冻结接口契约，否则联调阶段返工；
- 改一个上游决定后，下游哪些节点要重做、兄弟节点是否失配，没有系统化记录；
- 用户想就"某一个任务"讨论时，没有清晰的上下文边界；
- 全自动写代码时，审批、验收命令和"改了什么"的证据不可信：worker 能伪造审批、能绕过写范围，人无法复核；
- 长任务的开销只有次数与墙钟，token 成本没有上界。

### 1.2 目标（v1）

1. **拆解**：用户给需求或任务清单，主 agent 按方法产出可审阅的任务树（类型、粒度、依赖、写范围、验收标准）。
2. **画布**：无限画布上的从左到右拆解树，取代传统会话区；卡片自带类型/执行者/状态/进度/指标/徽章等全部关键信息（不开详情也能掌握全局），选中即高亮上下游与兄弟，空白一键清理。
3. **全自动执行**：计划经人工审批后自动派发、验证、修复、推进；异常/门禁/预算处停下。
4. **节点独立对话**：每个节点一条持久会话；选中即进入该会话（右侧面板，消息由宿主 Chat 渲染、外壳自绘），发送/中止走宿主；讨论与变更提议自动关联到图上并计算影响面。
5. **基础影响传播**：契约/规格/结构变更 → 下游标过期、上游复查、兄弟一致性检查；跨泳道或破坏性变更升级为人工门禁。
6. **可观测、可控、可恢复**：attempts/预算（次数 + 活跃时长 + token）、并发、暂停/停止/恢复、插件重载后续跑、全过程证据留痕（基线快照 + 脱敏）。
7. **可信的安全边界**：人工审批不可被 worker/本机进程伪造；节点会话在 `workspace-write` 沙箱内；验收命令冻结且人工可见；越界判定有基线证据。

### 1.3 非目标（v1 明确不做）

- 每节点 git worktree 隔离与自动合并（主工作区 + 冲突串行代替）。
- 多仓库项目、跨工作区项目。
- 后台会话（无 GUI 会话也能跑）——执行要求驱动会话存活。
- 费用账单/计费展示（只做 token 预算与用量，不换算金额）。
- 自动 push / 建 MR / 部署（发布类是人工门禁节点）。
- 自定义节点类型、拖拽重排（v1 提供上/下移与改 order）。
- 真机/浏览器人工测试自动化（由人工门禁节点承担）。

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| 项目 Project | 一棵任务树 + 设置 + 证据，绑定一个工作区目录 |
| 驱动会话 Driver session | 当前负责拆解/判断/处理门禁的 DSH 会话；同一项目同一时刻只有一个驱动租约 |
| 节点 Node | 树上的一个任务/产物/检查/门禁；分容器节点与叶子节点 |
| 节点会话 Node session | 每个节点自己的 DSH 子会话（`activeSessionId`）；只创建一次、持久存在；承载该节点的执行、对话与证据 |
| Attempt | 节点会话上的**一个 turn**（一次执行尝试），记录触发方式、规格版本、session/turn 区间、结果与证据 |
| 基线快照 Baseline | 派发前用私有 git index 生成的树快照 + 路径 hash，用于判定越界与归属 |
| 画布 Canvas | 编排台的全幅无限画布：从左到右的拆解树 + 关系高亮 + 小地图/图例，取代传统会话区域 |
| 面板 Panel | 右侧 404px 悬浮对话面板（可收起为右下 FAB），内嵌节点会话；外层 chrome 自绘、消息流宿主渲染 |
| 计划审批节点 | 计划校验通过后自动生成在根下的 `gate` 节点（`system=true`），详情 tab 内批准/驳回 |
| 聚焦 Focus | 画布当前选中的节点（= 面板作用域）；决定关系高亮、详情内容与面板显示哪个会话 |
| 线程 Thread | 节点会话的对话摘要（session/turn → node 映射），供详情、时间线与通知引用 |
| 提议 Proposal | 节点会话或主 agent 提交、尚未被人工批准的图变更；以影响卡展示，批准后才传播 |
| 契约 Contract | 跨泳道接口产物（DB schema / API 规格 / 事件 / 组件接口 / 路由表），冻结后下游才能开工 |
| 波次 Wave | 依赖 DAG 的拓扑层；同波内可并行 |
| 证据 Evidence | 基线/快照 diff、文件清单、验收命令输出、评审发现、token 消耗（有界 + 脱敏） |
| 门禁 Gate | 必须由人批准/确认的节点或事件；只能走带令牌的客户端通道 |
| 影响面 Blast radius | 一次变更在图上波及的上游、下游、兄弟节点集合（有距离定义与终止规则） |
| Check | 宿主执行的验收命令（`settings.checks` 或节点 `checks[]`），属 human-only 冻结项 |
| 实验性类型 | 模型里有、v1 默认不开放创建的类型 |

## 3. 技术路线取舍

| 路线 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **A. 宿主调度器 + 会话视图（选中）** | 插件宿主拥有图/调度/执行/影响引擎；主 agent 通过工具规划与判断；客户端注册会话内视图 | 确定性调度、持久化、可恢复、可测试、能控并发与预算；agent 上下文保持小 | 实现量最大；agent 与调度器的协作要设计清楚 |
| B. 纯 agent 自驱动 | 插件只存图与画 UI，主 agent 每轮自己决定下一步、用自己的 subagent 工具执行 | 实现最轻 | 全自动不可靠；并发/重试/预算不可控；长任务必然上下文爆炸 |
| C. 编译成 workflow 脚本 | 把树编译成 DSH `workflow` 工具脚本，一次运行完成一批 | 复用内置并行编排 | 无交互树、无节点级对话、不可跨重启恢复、门禁难插入 |

**选择 A**。B 的提示词方法论被 A 完整复用：主 agent 负责"拆解、判断、设计产物、处理升级"，宿主负责"调度、派发、验收、重试、传播"这些确定性工作。这也是"主 agent 拆解后调用 subagent"的字面实现——只是调用发生在宿主侧，而非模型手动调。

## 4. 总体架构

```
                  ┌─────────────────────────────────────────────┐
                  │ 驱动会话的主 Agent                            │
                  │ · playbook（系统提示注入）                     │
                  │ · orch_* 工具（仅驱动会话全量）                │
                  │ · 拆解 / 判断 / 处理门禁，不做节点级对话        │
                  └──────────▲──────────────────┬───────────────┘
              followup/通知  │                  │ 工具调用
                  ┌──────────┴──────────────────▼───────────────┐
                  │ 编排服务（插件宿主）                          │
                  │ 图服务 │ 调度器 │ 执行器 │ 验收器             │
                  │ 影响引擎 │ 通知器 │ 存储 │ 会话映射           │
                  │ 审批通道 │ 预算(TokenMeter) │ 沙箱策略        │
                  └───┬──────────────▲──────────────┬────────────┘
        followup/resume│              │ orch_submit_result │ connection.fetch
                  ┌────▼──────────┐ ┌─┴───────────┐ ┌─▼────────────────────┐
                  │ 节点会话       │ │ 基线快照/证据 │ │ 客户端「编排台」       │
                  │ worker/verifier│ │ checks 执行   │ │ 画布 + 面板 + 审批     │
                  │ /planner       │ │ (沙箱内)      │ │ (bearer + CAS)        │
                  └───────────────┘ └──────────────┘ └───────────────────────┘
```

| 角色 | 职责 | 不该做的事 |
| --- | --- | --- |
| 主 agent（驱动会话） | 勘察、拆解、写规格/契约/决策、处理门禁与升级 | 不逐节点写实现代码；不自己算调度；不接管节点级对话 |
| 节点会话 agent | 执行/解释/修复该节点；容器与门禁节点做只读规划讨论，产出提议 | 不改图（只 `orch_propose`）、不越写范围、不批准、不调调度类工具 |
| 图服务 | 节点/边/状态/版本/校验/波次/系统节点生成 | 不直接派发 |
| 调度器 | 就绪判定、波次、并发与写范围冲突、预算、熔断、driver 租约 | 不改节点语义 |
| 执行器 | 组装 attempt、驱动节点会话（热/冷）、超时/取消、收集 `orch_submit_result` 与基线证据、按 attempt 计量 token | 不判断业务对错 |
| 验收器 | 在沙箱内跑 checks、启动 verifier attempt、产出证据 | 不决定是否拆新节点（交给修复策略） |
| 影响引擎 | 变更分类、影响面计算（有距离/终止规则）、传播动作提案 | 不擅自跨泳道执行破坏性变更 |
| 通知器 | 波次/门禁/阻塞/完成通知并唤醒主 agent；toast/未读 | 不刷屏（去重 + 限流） |
| 审批通道 | bearer 校验、会话→工作区归属、版本 CAS、actionId 幂等 | 不信任本机任意进程，不做"只看 HTTP 来源"的授权 |
| 客户端 | 画布、卡片六态、关系高亮、面板内嵌会话、详情与审批、小地图/图例 | 不直接改图；不在客户端算影响面；不 innerHTML 渲染外部文本 |

**安全边界（v0.3 确立）**

- 人工动作只能通过 `connection.fetch` 客户端通道 + 启动期 bearer；worker/其它插件/curl 拿不到令牌。
- 节点会话在 `workspace-write` 沙箱内运行，工作区外与域数据目录不可写；验收命令同沙箱 + 净化 env。
- 审批/门禁字段（`gate` / `executor=human` / `scope` / `checks` / `budget` / `maxImpactAuto`）agent 只能提议，不能直接改。
- `tools.guard` 只做工具名与结构化参数（如 `run_in_background`）拒绝，不把命令文本匹配当安全边界。

**一个完整回合（宿主视角）**

1. 用户在画布空态「新建编排」，或 `/orch` 把当前会话加为驱动会话并获取租约。
2. 主 agent `orch_scan` 拿工作区画像 → `orch_plan` 写入任务树（可增量）。
3. 校验通过 → 项目 `awaiting-approval`，根下生成 `plan-approval` 节点；用户在详情 tab 看到 checks 全量、scope 并集/冲突、首波 5 个节点后批准 → `approvedPlanVersion` 写入。
4. 调度器挑就绪叶子 → 执行器在**节点会话**里跑 attempt（首次创建会话；热 followup / 冷 resume）→ `orch_submit_result` + 基线证据 → 沙箱内跑 checks → `done`。
5. 波次完成 / 节点阻塞 / 门禁 → 宿主写 `notifications` 去重后 `agent.followup` 唤醒主 agent；UI 出 toast，项目卡「待审批」可点直达。
6. 用户点击节点 → 面板内嵌该节点会话 → 讨论/`orch_propose` → 会话内影响卡 → 详情批准 → 宿主传播 → 重排/重跑。
7. 全部叶子（含验证与门禁）完成 → 项目 `done`，输出交付摘要与证据包。

## 5. 领域模型

### 5.1 项目 Project

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `prj_` + 短随机 |
| `workspacePath` | string | 绑定的工作区目录（realpath 后绝对路径） |
| `title` / `brief` | string | 项目名 / 需求摘要 |
| `status` | enum | `planning` `awaiting-approval` `running` `paused` `awaiting-continue` `blocked` `done` `canceled` |
| `statusReason` | object \| null | `{code, message, at, by}`；paused/blocked 必须有原因 |
| `driverSessionId` | string \| null | 当前驱动会话 |
| `driverLease` | object \| null | `{sessionId, heartbeatAt, expiresAt}`；30s 心跳、90s 过期，可被抢占并通知原会话 |
| `planVersion` | number | 计划版本，每次 plan/结构变更 +1 |
| `approvedPlanVersion` | number \| null | 已批准的计划版本（审批时写入） |
| `approvedAt` / `approvedBy` | number / string \| null | 审批记录 |
| `planApprovals` | array | `{planVersion, at, by, actionId}`，有界 50 条 |
| `settings` | object | 项目级设置覆盖（见 5.7），与 workspace 默认合并 |
| `stats` | object | 叶子总数/完成/阻塞/运行/待审批/波次/累计尝试 |
| `budgetUsed` | object | `{attemptsRecorded, attemptsRetryCounted, attemptsBudgetCounted, tokensIn, tokensOut, activeMs, reservedTokens, dayTokensUsed}` |
| `createdAt` / `updatedAt` | number | 毫秒时间戳 |

### 5.2 节点 Node

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 项目内唯一 slug（`[a-z][a-z0-9-]{1,40}`）；系统节点用 `sys:` 前缀保留 |
| `parentId` | string \| null | 根为 null |
| `kind` / `subtype` | enum / string | 25 种类型，见第 6 节；`contract` 有子类型 |
| `system` | boolean | 系统生成节点（`plan-approval`、自动 `bugfix`、升级 `gate`）；V 校验单独处理 |
| `title` / `intent` | string | 标题 / 这个节点要达成什么（1–5 句） |
| `acceptance` | string[] | 可验收条目（≥1，叶子必填） |
| `scope` | string[] | 写范围 glob（相对工作区）；只读类为空；**human-only** |
| `readOnly` | boolean | 只读节点（设计/验证类） |
| `executor` | enum | `orchestrator` `worker` `verifier` `system` `human`，默认由 kind 决定 |
| `gate` | enum | `none` `human`；`human` 表示完成前必须人工确认；**human-only** |
| `freezeState` | enum | `none` `pending` `frozen`（仅 contract：冻结后消费方可开工；修改进入 pending） |
| `frozenVersion` | number \| null | 当前冻结的产物版本 |
| `status` | enum | 见 5.4 |
| `blockedReason` | object \| null | `{code, message}`，静态文案 |
| `staleBy` | array | `{nodeId, version, reason, at}[]` |
| `artifacts` | array | `{name, path?, content?, version, at}`；正文 ≤32KiB、有版本 |
| `evidence` | object \| null | **指针 + 摘要**（`lastAttemptId` + diffStat/checks 摘要），完整证据只在 `attempts`，不双写 |
| `lastAttemptId` | string \| null | 最近一次 attempt |
| `activeSessionId` | string \| null | 当前节点会话（fork 后指向新会话）；懒创建 |
| `chatSessionId` | string \| null | 面板打开的会话；human/根节点/**设计类叶子**为 `driverSessionId`（落回主 agent），test 为 null |
| `pendingProposals` | array | 待批准提议摘要 `{id, class, summary, at}` |
| `checks` | array | 节点级验收命令 `{name, command, timeoutMs, kind}`；**human-only** |
| `targetNodeId` | string \| null | test/review 的验证目标（也可用 `verifies` 边表达） |
| `version` | number | 规格版本；intent/acceptance/scope/checks/契约内容变更 +1 |
| `order` | number | 同父下排序 |
| `estimate` | object | `{files?, minutes?, tokens?}`，粒度告警与预算预演 |
| `labels` | string[] | 自定义标签（筛选） |
| `deletedAt` | number \| null | 软删；删除后 edges 级联清理、id 进 `reservedIds` |
| `createdAt` / `updatedAt` | number | |

字段归属规则：`gate/executor/scope/readOnly/checks` 在**建树**时随 `orch_plan` 提交（审批页冻结）；对**既有节点**的变更是 human-only，只能由人工 UI 或 `orch_propose` 执行，agent 工具直接改返回 `needs-human`（见 13.1、V20）。

### 5.3 边 Edge

| 类型 | 方向 | 语义 | 是否进 DAG |
| --- | --- | --- | --- |
| `depends_on` | from → to | from 开始前，to 必须 `done` | 是 |
| `consumes` | from → to | from 使用 to 的产物；to 变更使 from 过期 | 是（to 必须先完成） |
| `verifies` | from → to | from 验证 to；from 失败会把 to 退回 | 是（to 必须先完成） |
| `conflicts` | a ↔ b | 写范围重叠；调度串行，不建 DAG | 否（派生） |
| `convention` | a ↔ b | 同规范/同共享组件组；影响传播触发一致性审计 | 否 |
| `supersedes` | a → b | a 替代 b（历史版本） | 否 |

边字段：`{type, from, to, pinnedVersion?, pinnedArtifactId?, createdAt}`。`consumes` 必须带 `pinnedVersion`（= 消费时契约产物的版本）；影响引擎按 pin 与当前 `frozenVersion` 比较生成 `staleBy.reason`。`conflicts` 由写范围自动派生。

### 5.4 状态机

| 状态 | 含义 | 进入者 | 出口 |
| --- | --- | --- | --- |
| `draft` | 计划中，规格未定 | 计划工具 | → `ready`（批准后）、`canceled` |
| `ready` | 依赖满足、规格完整、可派发 | 系统 | → `queued`、`awaiting-human`（human 类）、`stale`、`canceled` |
| `awaiting-human` | 需要人工确认（gate/acceptance/release） | 系统 | → `done`（批准）；普通门禁驳回/超时 → `blocked`；**计划门禁驳回 → `canceled`** |
| `queued` | 已被调度器选中 | 调度器 | → `running`、`ready`（冲突/容量退回） |
| `running` | worker/system 执行中 | 调度器 | → `verifying`、`done`（system 直接完成）、`blocked` |
| `verifying` | 跑 checks/评审 | 系统 | → `done`、`blocked`、`running`（重试） |
| `done` | 完成（含证据） | 系统 / 人工（human 类） | → `stale`（上游变更）、`blocked`（verifier 推翻） |
| `blocked` | 受阻（失败/依赖/预算/中止/越界） | 系统 | → `ready`（解除/重试）、`canceled` |
| `stale` | 被上游变更标过期 | 影响引擎 | → `queued`（重排）、`canceled` |
| `canceled` | 取消（带原因） | 人工（非 running）/ agent（仅 draft 叶子） | 终态 |

- 显式补充迁移：`stale→queued`、`done→blocked`（verifier 否决）、`awaiting-human→blocked`（除计划门禁外的门禁驳回，`blockedReason=gate-rejected`；计划门禁走 `canceled`）、`ready→done`（orchestrator 叶子：主 agent 提交产物并通过宿主校验）。
- **`draft` 的唯一来源是「计划未批准」**；批准时全部叶子置 `ready`（§7.5），后续派发由 §8.1 的依赖/契约/预算门控。
- **项目状态与节点状态分开**：`awaiting-approval` 是 Project 状态；计划驳回 = 项目回 `planning` + 当前 `sys:plan-approval-v*` 节点 `canceled`（不是节点 `draft`）。
- 容器状态由子节点聚合：任一 `blocked` > 任一 `stale` > 任一 `running/verifying` > 任一 `awaiting-human` > 全部 `done` → `done`；全部 `draft` → `draft`。进度 = 已完成叶子 / 全部叶子。
- **写规则**：所有迁移在 store 写队列内做三键 CAS：`expectedStatus` + `expectedVersion` + `attemptId`；失败返回 `stale-transition`/`stale-view`。晚到结果只写 `attempts`/`events` 并标 `superseded`，不回写节点。
- 就绪条件见 8.1；human/system/orchestrator 叶子分别走 `awaiting-human`、宿主命令通道、驱动会话待办，调度器不把它们排进 worker 队列。

### 5.5 尝试与证据

```
Attempt = {
  attemptId, nodeId, attemptNo,
  trigger: 'initial'|'retry'|'retry-new-session'|'resume'|'repair'|'manual',
  nodeVersion, sessionId, turnStart, turnEnd,
  startedAt, endedAt, stopReason,          // completed|aborted|error|max-tokens|timeout|user-abort|interrupted
  result?,                                 // 校验后的结构化结果（summary/changedFiles/contractsTouched/deviations/risks/followups）
  failure?,                                // { code, message } 静态文案
  cost: { tokensIn, tokensOut, ms },
  evidence: {
    baselineId,                            // 私有 index 快照 id
    files: string[], diffStat,
    deleted: string[], renamed: [{from,to}],
    outOfScope: string[],                  // scope 之外的改动（foreign change 也可能属于并发 worker）
    foreignChanges: string[],              // 无法归属给本 attempt 的改动 → 事件 + 门禁，不直接判违规
    checks: [{ name, command, exitCode, outputTail }],
    violations: string[],                  // 明确归属本节点且越界的路径
    gitConfigHash,                         // .git/config|hooks 基线 hash
    redacted: number                       // 脱敏命中数
  }
}
```

- **三个计数口径**（全系统统一）：
  - `attemptsRecorded`：每个真实开过的 turn 都记一条（含 user-abort/interrupted）；
  - `attemptsRetryCounted`：消耗 `maxAttempts` 的失败重试（timeout/bad-output/checks 失败/fix-failed；用户中止、容量等待、驱动离线不计）；
  - `attemptsBudgetCounted`：消耗预算的执行（录制且占用 worker/checks 资源；容量等待与驱动离线不计）。
  - 卡片「尝试 x/y」= `attemptsRetryCounted / maxAttempts`；`budgetUsed` 用 budgetCounted。
- 证据只保留有界内容（diffStat、文件清单、命令末 200 行、结果摘要 ≤4000 字、token 计数）；完整 diff 不落库。
- 基线快照：派发前 `git add -A`（私有 `GIT_INDEX_FILE`）+ `write-tree`，结束后 `diff-tree`；路径逐个 hash（realpath 后）；工作区外哨兵 hash；`.git/config|hooks` hash。宿主 git 固定 `GIT_CONFIG_COUNT=0 / GIT_CONFIG_GLOBAL=/dev/null / GIT_TERMINAL_PROMPT=0 / core.fsmonitor=false / core.hooksPath=`。
- 每个节点保留最近 5 次 attempt 的完整证据；更早的只保留摘要；入库前按密钥模式脱敏。

### 5.6 节点会话、焦点与线程

- **nodeSessions**：`${projectId}/${sessionId}` → `{projectId, nodeId, role: 'worker'|'verifier'|'planner', isActive, createdAt}`；反向索引 `sessionIndex`（主键 sessionId，`nodeId` 可为 null）用于把专属节点会话的 turn 绑回节点。**驱动会话不写 sessionIndex**：root / human 门禁的对话落驱动会话但不绑线程。
- **fork**：同节点可有多个会话；`Node.activeSessionId` 指向当前执行会话，旧会话 `isActive=false` 保留回看。
- **focus**：画布当前选中节点，按用户会话存 `meta`；打开会话时恢复选中与面板开合。
- **threads**：`${projectId}/${sessionId}/${turn}` → `{nodeId, userText(≤1000), assistantText(≤2000), at}`；每会话保留最近 50 turn，项目总量上限 5000。
- **面板开合、折叠、手动偏移、视口**：纯客户端状态，按用户会话存 localStorage，不入库（重载恢复）。
- 线程摘要只服务详情/时间线/通知；完整对话在面板（= 会话本身）。
- 事件与 attempt 的绑定：`turnStart..turnEnd` 区间内的消息属于该 attempt；用户中途插话记入同一 turn 但 attempt 记 `user-message` 事件。

### 5.7 设置（workspace 默认 + project 覆盖，🔒 = human-only）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `rhythm` | `auto` | `auto` 只在异常/门禁/预算停；`wave` 每波停（`awaiting-continue`）；`phase` 每阶段停 |
| `maxWorkers` | 3 | 同时运行的 attempt 数；上限 = `min(3, 运行实例容量-2)` |
| `maxAttempts` | 2 | 单节点自动重试上限（用户手动重试不计） |
| `retryPolicy` | 见 8.5 | `{kind: auto\|manual\|none, consumesAttempt, backoffMs}` 的失败分类表（8.5 定义） |
| `maxRepairDepth` | 2 | 自动修复链最大深度 |
| `maxStructuralDeletes` | 5 | 影响传播里结构删减的人工门禁阈值 |
| `patchLimit` | 40 | 单次 plan patch 节点上限（V11） |
| `autoRetryOnLoad` | `false` | 重载后是否自动重试 interrupted attempt |
| `phaseGate` 🔒 | `true` | 是否为每个 phase 生成人工门禁 |
| `repairBudget` | `{maxNodes: 20%叶子, maxAttempts: 60}` | 修复链共享配额 + 失败签名去重 |
| `nodeTimeoutMs` | 1_200_000 | 单 attempt 超时 |
| `maxPlanNodes` / `maxPlanDepth` | 200 / 6 | 计划上限（V11 读取） |
| `maxImpactAuto` | 5 | 影响面 ≤ 该值且同泳道且不触契约时可自动传播 |
| `budget` | `{attempts: 200, tokens: 5_000_000, activeHours: 24, dayTokens: 8_000_000}` | 三层预算；attempt 前 reserve；日用量记 `budgetUsed.dayTokensUsed` |
| `breaker` | `{consecutiveFailures: 3}` | 连续失败熔断 |
| `checks` 🔒 | `[]` | 项目验收命令 `{name, command, timeoutMs, kind}`；审批页全量展示并冻结 |
| `worker` | `{model?: null, preset: 'orchestrator-worker'}` | worker 模型覆盖 |
| `verifierPreset` | `orchestrator-verifier` | 验证会话 preset |
| `plannerPreset` | `orchestrator-planner` | 容器规划讨论 preset |
| `sandbox` | `{mode: 'workspace-write'}` | 节点会话与 checks 的沙箱模式（不可关闭，只能收紧） |
| `sessionReuse` | `{maxAttemptsBeforeReset: 2, compactionThreshold: 0.6}` | 复用会话超过阈值强制 compaction 或建议新会话 |
| `notify` | `{gate: true, blocked: true, wave: true, done: true, ratePerMinute: 2}` | 通知开关与限流 |
| `approval` | `{tokenTtlMs: 86_400_000}` | 客户端通道 bearer 生命周期 |
| `experimentalKinds` 🔒 | `false` | 是否允许创建实验性类型 |

## 6. 节点类型体系

### 6.1 结构类（容器，必须继续拆）

| kind | 中文 | 做什么 | 执行者 | 粒度 | v1 |
| --- | --- | --- | --- | --- | --- |
| `project` | 项目 | 根：目标、约束、交付定义 | — | L0 | ✅ |
| `phase` | 阶段/里程碑 | 交付阶段；阶段末天然门禁 | — | L1 | ✅ |
| `stream` | 泳道 | 纵向工作流：数据库/后端/管理端/移动端/测试/交付 | — | L1/L2 | ✅ |
| `module` | 模块 | 业务域边界（用户/订单/支付） | — | L2 | ✅ |
| `feature` | 功能 | 一个可验收的用户能力 | — | L2/L3 | ✅ |

### 6.2 设计类（叶子，只读产物）

| kind | 中文 | 做什么 | 执行者 | 粒度 | v1 |
| --- | --- | --- | --- | --- | --- |
| `spec` | 规格 | 需求/验收标准/边界/非目标 | orchestrator | L2/L3 | ✅ |
| `decision` | 决策 | ADR：选项、结论、理由；open 时阻塞下游 | orchestrator | L2 | ✅ |
| `contract` | 契约 | 跨泳道接口：`db_schema` / `api_spec` / `event_schema` / `component_api` / `route_map` | orchestrator | L2/L3 | ✅ |
| `research` | 调研 | 限时技术验证/代码勘察，产出报告 | worker（只读） | L3 | 实验 |

### 6.3 实现类（叶子，写代码）

| kind | 中文 | 做什么 | 执行者 | 粒度 | v1 |
| --- | --- | --- | --- | --- | --- |
| `api` | 接口 | 一个后端接口：路由、DTO、校验、权限、错误码、文档 | worker | L3 | ✅ |
| `service` | 服务 | 多接口共享的领域逻辑/数据访问 | worker | L3 | 实验 |
| `migration` | 迁移 | 表/索引/迁移脚本（可回滚） | worker | L3 | ✅ |
| `page` | 页面 | 一个路由页面（默认不拆） | worker | L3 | ✅ |
| `section` | 区块 | 大页面拆出的区块/复杂表单/表格区 | worker | L4 | 实验 |
| `component` | 组件 | 跨页面复用 ≥2 处的通用组件 | worker | L3/L4 | ✅ |
| `logic` | 逻辑复用 | hook/composable/store/api-client/utils | worker | L3 | 实验 |
| `integration` | 联调 | 前端接真实接口、mock→real、端到端打通 | worker | L3 | ✅ |

### 6.4 验证类（叶子，独立上下文）

| kind | 中文 | 做什么 | 执行者 | 粒度 | v1 |
| --- | --- | --- | --- | --- | --- |
| `test` | 测试 | 宿主按配置执行目标节点的测试命令 | system | L3 | ✅ |
| `review` | 评审 | 代码/设计评审，独立上下文，只报可证实问题 | verifier | L3 | ✅ |
| `acceptance` | 验收 | 人工按验收标准逐条核对 | human | L3 | 实验 |
| `audit` | 审计 | 跨节点一致性（契约符合、命名/规范、组件复用） | verifier | L3 | 实验 |

`test` 由宿主执行命令（不消耗子代理）；`review`/`audit` 用只读 verifier 子代理；`acceptance` 是人工核对。

### 6.5 人工类（叶子，只有人能推进）

| kind | 中文 | 做什么 | 执行者 | 粒度 | v1 |
| --- | --- | --- | --- | --- | --- |
| `gate` | 门禁 | 计划批准、契约冻结、发布前确认、破坏性变更审批 | human | 任意 | ✅ |
| `release` | 发布 | 提交/部署/交付（v1 只做记录与提醒） | human | L3 | 实验 |

### 6.6 其它

| kind | 中文 | 做什么 | 执行者 | 粒度 | v1 |
| --- | --- | --- | --- | --- | --- |
| `bugfix` | 修复 | 由失败/评审问题自动派生，带 target，写范围与目标一致 | worker | L4 | ✅ |
| `doc` | 文档 | README/交接/API 文档 | worker | L3 | 实验 |

### 6.7 正交属性

- **容器/叶子**：结构类 5 种是容器；其余 20 种是叶子。容器必须有子节点且不能有写范围；叶子不能有子节点。
- **执行者**：`orchestrator`（主 agent 自己产出，用 `orch_node` 存证）、`worker`（子代理执行）、`verifier`（只读子代理）、`system`（宿主直接执行，如跑测试命令）、`human`。
- **门禁**：`gate: human` 的节点必须经 UI 人工批准；agent 工具不能批准。
- **只读**：设计/验证类 `readOnly: true`，`scope` 为空；其产物存 `artifacts`，不碰代码。
- **写范围**：实现类必须有 `scope`（glob），且越界写会被宿主在验收时判定违规。
- **粒度**：L0 项目 → L1 阶段/泳道 → L2 模块/功能/契约 → L3 任务（接口/页面/组件）→ L4 子任务（区块/修复）。

### 6.8 类型默认值（新节点未显式声明时）

| kind | executor | gate | readOnly | freezeState | 必须字段 |
| --- | --- | --- | --- | --- | --- |
| project/phase/stream/module/feature | — | phase 默认 human（阶段末自动生成 `sys:phase-gate-*`） | — | none | 标题 |
| spec/decision/contract/research | orchestrator（research 为 worker） | contract 冻结默认 human | 是 | contract = `pending` | 标题、验收、产物要求 |
| api/service/migration/page/section/component/logic/integration/doc | worker | 无（bugfix 由策略生成） | 否 | none | 标题、验收、写范围 |
| test | system | 无 | 是 | none | 标题、验收、`checks[]`、`targetNodeId` 或 `verifies` 边 |
| review/audit | verifier | 无 | 是 | none | 标题、验收、`targetNodeId` 或 `verifies` 边 |
| acceptance | human | 无 | 是 | none | 标题、验收（人工核对项） |
| gate/release | human | human | 是 | none | 标题、验收（人工确认项） |
| bugfix | worker | 无 | 否 | none | 标题、验收、写范围（默认继承 target 的 scope） |

- 显式字段优先于本表默认值；agent 只能通过 `orch_propose` 修改本表中的 human-only 字段。
- `checks[]` 与项目 `settings.checks` 都属于 human-only：计划审批时全量冻结，运行期不可被 worker 或主 agent 修改。

### 6.9 系统节点（`system=true`）

| 生成时机 | id | kind | parent | 其他 |
| --- | --- | --- | --- | --- |
| 计划校验通过 | `sys:plan-approval-v<planVersion>` | gate | root | 每次新 planVersion 生成一个新节点；批准后 `done` 并写 `approvedPlanVersion`；旧的置 `canceled(reason=superseded)` |
| phase 进入执行 | `sys:phase-gate-<phaseId>` | gate | 该 phase | 阶段末人工确认；`settings.phaseGate=false` 时不生成 |
| 影响传播需门禁 | `sys:gate-<proposalId>` | gate | 变更节点所在容器 | 携带提议摘要与被影响节点列表 |
| 自动修复 | `sys:bugfix-<nodeId>-<n>` | bugfix | 失败节点的父 | `targetNodeId` = 失败节点，depth 记录在 labels |

- 系统 id 带版本/序号（`sys:...-v<n>` / `-<n>`），与用户 id 的 `reservedIds` 隔离，不会因删除复用而撞墓碑。
- 系统节点由宿主生成、不可被工具删除或 patch；V 规则对 `sys:` 前缀单独处理（V18）。
- 系统节点计入「待审批」统计与画布展示，不参与叶子进度分母；order 一律排在同父末尾；与父节点之间不建 `depends_on`（由宿主直接管理状态）；不参与计划的 V1/V3/V7/V10 校验。

## 7. 拆解方法（主 agent playbook）

主 agent 的 playbook 通过 `systemPrompt.section` 只注入驱动会话；配套工具见 13.1。方法论固定为六阶段，每阶段有明确产物与门禁。

| 阶段 | 动作 | 产物 | 工具 | 门禁 |
| --- | --- | --- | --- | --- |
| 0 勘察 | 读工作区：技术栈、目录、包管理、已有代码、文档/AGENTS、git 状态、测试 | 工作区画像 | `orch_scan` | — |
| 1 需求 | 从需求/任务清单提炼能力、非功能约束、假设、未决问题 | `spec` 节点 + open `decision` | `orch_plan` | — |
| 2 架构与契约 | 模块边界、数据模型、接口规格、页面地图、共享组件清单、关键决策 | `decision`/`contract` 节点 | `orch_plan` | 契约冻结 = 人工门禁 |
| 3 任务树 | 按粒度判据生成容器与叶子，标写范围与验收 | 完整树 | `orch_plan` | — |
| 4 依赖与波次 | 依赖/消费/验证边，算波次、关键路径、冲突组 | 波次与风险摘要 | `orch_plan` | **计划审批 = 人工门禁** |
| 5 执行与验收 | 宿主自动推进；主 agent 处理阻塞、补规格、升级门禁 | 证据与完成树 | `orch_status`/`orch_node` | 节点 `gate` |
| 6 变更传播 | 对话/实现/评审触发的变更 → 影响面 → 传播 | 影响卡与重排 | `orch_node`/`orch_impact` | 破坏性变更 = 人工门禁 |

### 7.1 粒度判据

一个叶子节点必须同时满足：

1. **一个子代理一次上下文能做完**（默认估计 ≤ 12 个文件、≤ 1 次验收循环）。
2. **有独立、可验证的验收标准**（能写成命令或逐条核对项）。
3. **有明确写范围**（实现类），或完全只读（设计/验证类）。
4. **写范围冲突可解**：与同波其他节点重叠时，必须能靠 `depends_on` 串行。

按层拆法：

| 层 | 后端 | 前端 | 验收 |
| --- | --- | --- | --- |
| 模块/功能 | 接口清单、数据模型、权限规则、非功能约束 | 页面地图、共享组件清单、路由与状态方案 | 验收标准写成条目 |
| 任务 | **一个接口一个 `api` 节点**（含 DTO/校验/权限/错误码/单测） | **一个路由一个 `page` 节点**，默认不拆 | 每功能一个 `test` 节点 |
| 子任务 | 共享逻辑 → `service` 节点；schema → `migration` 节点 | >3 个区块 / 复杂表单 / 多数据域 → 拆 `section`；复用 ≥2 处 → `component`；数据层 → `logic` | 每波一个 `review`；每阶段一个 `acceptance`/`audit` |
| 联调 | 每页面/每模块一个 `integration` 节点，消费已冻结的 `contract` | 同左 | 每阶段结束人工门禁 |

**禁止**：小于一个函数/一个文件的"假任务"；没有验收标准的任务；写范围与同波节点重叠又无法串行的任务；把"整个后台"当一个叶子。

### 7.2 契约与并行

- 跨泳道接口必须先有 `contract` 节点并经人工冻结（`gate`），消费者用 `consumes` 指向它。
- 契约冻结后版本化：修改契约 = 影响面计算 + 人工门禁（若有节点在跑或已 done）。
- 典型并行骨架：`contract` → 同时 `migration` + `api`（后端）与 `page` + `component`（前端，基于 mock）→ `integration` → `test`/`review` → `acceptance`。

### 7.3 计划结构（`orch_plan` 输入）

```json
{
  "mode": "merge",
  "project": { "title": "…", "brief": "…" },
  "nodes": [
    {
      "id": "login-api", "parent": "auth-module", "kind": "api",
      "title": "登录接口", "intent": "POST /auth/login，返回 token…",
      "acceptance": ["错误密码返回 401 且不泄露用户是否存在", "…"],
      "scope": ["src/server/auth/**", "test/auth/**"],
      "estimate": { "files": 6 }
    },
    { "id": "login-contract", "parent": "auth-module", "kind": "contract", "subtype": "api_spec", "title": "登录接口契约", "acceptance": ["…"], "readOnly": true }
  ],
  "edges": [
    { "from": "login-api", "to": "login-contract", "type": "consumes" }
  ]
}
```

`mode: replace-subtree` 只允许在整棵子树都非 `running` 时使用；v1 主要用 `merge`（按 id upsert）。

### 7.4 计划校验规则（工具返回结构化错误，整批原子）

| 编号 | 规则 | 级别 |
| --- | --- | --- |
| V1 | 项目有且只有一个 `project` 根 | error |
| V2 | 非根节点必须有已存在的父节点 | error |
| V3 | 容器节点必须有子节点（审批时校验；plan 阶段允许暂缺） | error（审批）/warn（plan） |
| V4 | 叶子节点不得有子节点 | error |
| V5 | 边两端存在；`depends_on`/`consumes`/`verifies` 无环 | error |
| V6 | `consumes` 目标 kind 必须 ∈ {contract, component, api}；启动前必须有 `pinnedVersion` | error |
| V7 | 叶子必须有 ≥1 条验收 | error |
| V8 | 实现类叶子必须有写范围；只读类不得有写范围；显式字段优先于 6.8 默认 | error |
| V9 | 写范围不得越出工作区，不得命中 `.git/**`、`.dsh/**`、`node_modules/**`、域数据目录 | error |
| V10 | id 合法且唯一；计划节点不得使用保留前缀 `sys:`；软删 id 不可复用（`reservedIds`） | error |
| V11 | 节点数/深度/单次 patch 上限读 `settings.maxPlanNodes/maxPlanDepth/patchLimit` | error |
| V12 | 同波写范围重叠必须有可串行的 `depends_on` 顺序（计划期 warn，运行期由 `conflicts` 串行兜底） | warn |
| V13 | `estimate.files > 12` 建议拆分；`< 1` 建议合并 | warn |
| V14 | `gate: human` 的 executor 必须是 human | error |
| V15 | 实验性类型未开放时拒绝创建 | error |
| V16 | 容器节点不得有写范围 | error |
| V17 | `consumes` 的 pin：目标契约在消费方开工前必须 `frozen` 且 `frozenVersion == pinnedVersion` | error |
| V18 | `system=true` 节点只能由宿主生成；计划不得提交/删除/patch `sys:` 节点；V1/V3/V7/V10 对其豁免 | error |
| V19 | `test`/`review` 必须有 `targetNodeId` 或 `verifies` 边；`test` 必须有 `checks[]` 或继承项目 checks；命令长度 ≤1KiB | error |
| V20 | 对**既有节点**的 `checks/gate/executor/scope/readOnly` 变更只能由人工 UI 或 `orch_propose`；建树时由 `orch_plan` 携带并在审批页冻结（工具直接改既有节点返回 `needs-human`） | error |
| V21 | 已批准计划（`approvedPlanVersion` 存在）后任何 `orch_plan merge` 都使项目回到 `awaiting-approval`，不得绕过 | error |

### 7.5 计划审批（冻结 UI 下的形态）

- 校验通过后项目进入 `awaiting-approval`；宿主生成 `sys:plan-approval-v<planVersion>` 门禁节点（§6.9）。
- 审批界面 = 选中该节点后的**详情 tab**，必须展示：
  1. 树摘要与波次预览、关键路径；
  2. **checks 全量**（名称、命令、超时、kind）与来源（项目/节点）；
  3. 写范围并集与冲突组；
  4. **首波前 5 个节点**的标题/intent/预计文件数/将执行的命令；首波只允许 ≤3 文件的节点（canary），更大改动排到后续波次；
  5. 预计 attempts 与 token 预算占用；
  6. 风险项与破坏性操作（删除类 glob、`**` 范围需逐条勾选确认）。
- 批准（带 `expectedVersion`）→ 写 `approvedPlanVersion/planApprovals`，该门禁 `done`；**全部叶子置 `ready`**（是否派发由 §8.1 的依赖/契约/预算/租约门控，不再用 `draft` 等依赖），项目 `running`。
- 驳回（可填理由）→ 门禁节点 `canceled(reason=plan-rejected)`，项目回 `planning`；理由写 `events` 并通知主 agent；不自动重试审批。
- 批准后任何计划变更（含增量 merge）都回 `awaiting-approval` 并生成新的 `sys:plan-approval-v<planVersion+1>`（V21）。
- 审批是人工动作，只能走带 bearer 的客户端通道；agent 工具不能批准。

## 8. 全自动执行引擎

### 8.1 就绪与波次

叶子就绪条件（全部满足）：

1. `status ∈ {ready, stale}`；
2. 所有 `depends_on`/`consumes`/`verifies` 目标 `done`；
3. **祖先链**上没有 `draft`/`canceled`；祖先 `gate` 未决时子节点不进就绪（`gate-pending`）；
4. 规格完整：验收、执行者；实现类有 `scope`；`test/review` 有 target 与 checks；
5. 所消费契约 `freezeState=frozen` 且 `frozenVersion === pinnedVersion`；
6. 项目 `approvedPlanVersion` 已存在且项目 `running`；
7. 驱动租约有效（见 8.9），预算可预留。

**orchestrator 叶子**（spec/decision/contract/research）不走 attempt：就绪后进入驱动会话待办（通知主 agent），主 agent 用 `orch_node {action:'complete', nodeId, artifact, notes}` 提交产物，宿主校验 acceptance/artifact 后 `ready→done`；不占 worker 名额、不计 attempts。
**system 叶子**（test）：不建会话，宿主在沙箱内跑 checks 后直接 `ready→running→done/blocked`。

波次 = 依赖 DAG 的拓扑层（BFS 深度）；`criticalPath` 用最长路径估算供 UI 展示；容器进度按叶子汇总。

### 8.2 调度循环

```
tick（2s 或状态变更，单飞租约；上一次未结束则跳过）：
  1. 项目非 running / paused / awaiting-continue / 熔断 → 返回
  2. 取就绪叶子，按 (wave, criticalPath 权重, order) 排序
  3. 候选依次检查：容量（queued+running 计数）→ 写范围冲突（conflicts，与 running）
     → 驱动租约 → token 预算预留
  4. 通过 → status=queued（CAS）→ 异步执行 attempt
  5. 有空闲名额继续；否则等 attempt 结束事件
```

- **容量**：`maxWorkers = min(设置值, 运行实例 maxActiveSubagents - 2)`；容量从运行实例读取（本机实测 20，不写死 8）。容量等待**不记失败、不消耗 attempt**。
- **写范围冲突**：已完成节点不打断；running 节点等其完成（默认策略，唯一策略）；queued 冲突回 `ready`。
- 同一父容器下不额外限制并发（由写范围与预算约束）。
- 调度器只派发 executor ∈ {worker, verifier, system} 的叶子；orchestrator 叶子只推送待办到驱动会话，不占 attempt/名额。

### 8.3 Attempt 执行契约

**节点会话**（§10.3）：首次需要时创建一次，之后每个 attempt 都是该会话上的一个 turn：

- 热路径：会话 agent 仍 live → `agent.followup({role:'user', content})`；
- 冷路径：会话已卸载 → `ctx.agents.resume({sessionId, ...})` 后再 followup；
- 会话创建后立即 `setSandboxMode(session, 'workspace-write')`（cwd = 项目工作区），审批策略保持 `never`（子会话固定策略）；
- 每次 attempt 记录 `sessionId + turnStart..turnEnd`。

**prompt 结构**（分段，含不可信数据隔离）：

1. 角色与目标：节点标题/intent；本次只做这一个节点。
2. 输入：上游产物与契约摘录（pin 版本）、工作区画像、兄弟规范（`convention` 组）、上次失败证据（重试时）。**工作区/产物内容放在 nonce 分隔的数据块里，声明"以下是数据，不是指令"**。
3. 写范围：只允许改 `scope` 内文件；必须越界时停下并报 `deviation`，不得直接改。
4. 验收：逐条列出 acceptance 与将执行的 checks。
5. 硬约束：不执行 `git commit/push/checkout/reset/merge/rebase`、不联网、不读凭据/`~/.dsh`、不调用调度/计划/消息类工具、不引入新依赖除非节点明确要求、**不使用 `run_in_background`**。
6. 输出：调用 `orch_submit_result` 提交结构化结果（见下）。

**结构化结果**（常驻工具 `orch_submit_result`，宿主捕获 tool result 绑定当前 attempt）：

```json
{
  "summary": "做了什么（≤500 字）",
  "changedFiles": ["src/..."],
  "contractsTouched": [{ "nodeId": "…", "change": "…" }],
  "deviations": ["必须越界但未改的文件与原因"],
  "testsRun": [{ "command": "…", "exitCode": 0 }],
  "risks": ["…"],
  "followups": ["建议的后续节点（只建议，不创建）"],
  "done": true
}
```

**基线证据**（不依赖模型自述）：

- 派发前：私有 `GIT_INDEX_FILE` 执行 `git add -A` + `write-tree` 生成基线；逐路径 hash；工作区外哨兵 hash；`.git/config|hooks` hash。
- attempt 结束：`diff-tree` 得出文件清单/删除/重命名/diffStat；与 `scope` 比对：
  - `scope` 内改动 → 归属本 attempt；
  - `scope` 外改动 → 归入 `outOfScope`，再按时间/文件 hash 判断能否归属：能 → `violations`（`blocked(scope-violation)` + 人工门禁，不自动修复）；不能（并发 worker 或 checks 写入）→ `foreignChanges`（事件 + 门禁提示，不直接判违规）。
- 宿主只读 git，不执行任何写操作；GIT 环境变量固定净化（见 5.5）。

### 8.4 验收

执行顺序固定：**基线 → attempt → checks（沙箱内）→ after 证据 → 归属判定**。

- checks 来源：节点 `checks[]` 优先，否则项目 `settings.checks`；在 `workspace-write` 沙箱内执行，cwd = 工作区，净化 env（不注入 `DSH_HOME`/凭据；清 provider/key 变量），硬超时，输出剥 ANSI 后取末 200 行。
- 任一非 0 → 验收失败（进入 8.5）。
- `test` 节点：宿主执行 checks，不消耗子会话；失败 → 目标节点回退并进入修复链。
- `review`/`audit` 节点：在节点 verifier 会话里跑 attempt，输出 findings（文件/行/问题/建议/证据）；有 blocking → 派生 `sys:bugfix-*`（受 `repairBudget` 与失败签名去重）或阻塞。
- 通过后写 `evidence`（摘要）+ `lastAttemptId`、`done`，释放下游。

### 8.5 失败、重试与自动修复

`retryPolicy` 结构（§5.7 引用）：`{kind: auto|manual|none, consumesAttempt: boolean, backoffMs: number}`；按失败码归类——`timeout`/`bad-output` = auto + 计重试；`checks-failed` = auto + 计重试（首轮）；`scope-violation`/`foreign-change`/`user-abort` = none/manual + 不计重试；`interrupted` = manual + 不计重试；容量与驱动离线不进入失败表。

| 情形 | 策略 | 录制 | 计重试 | 计预算 |
| --- | --- | --- | --- | --- |
| 启动失败（容量/服务） | 容量等待或退避；容量等待不算失败 | 否 | 否 | 否 |
| 驱动会话不在线 | 不派发，保持 `ready`，提示打开驱动会话 | 否 | 否 | 否 |
| worker 超时 | 中止 turn（不销毁会话）；`blocked(timeout)`；自动重试至 `maxAttempts` | 是 | 是 | 是 |
| 结构化结果非法 | `blocked(bad-output)`；重试时把解析错误作为反馈 | 是 | 是 | 是 |
| checks 失败 | 保留证据 → 自动重试；用尽 → 派生 bugfix（`maxRepairDepth`） | 是 | 是 | 是 |
| 越界写（明确归属） | `blocked(scope-violation)`；不自动修复，**立即停止该节点后续派发**并升级人工门禁 | 是 | 否 | 是 |
| foreign change | 事件 + 门禁提示；不判违规，不自动重试 | 是 | 否 | 是 |
| 用户中止（面板停止 / 暂停） | `blocked(user-abort)`；不消耗 maxAttempts；不发修复链 | 是 | 否 | 是 |
| 插件重载/应用重启 | `blocked(interrupted)`；默认**不自动重试**（`autoRetryOnLoad=false`），等人工恢复；人工重试不计 maxAttempts | 是 | 否 | 是 |
| orchestrator 产物缺失/验收不符 | 通知主 agent 补产物；不耗 attempt | 否 | 否 | 否 |
| bugfix 后仍失败 | `blocked(fix-failed)` + 通知；该分支下游保持阻塞 | 是 | 是 | 是 |
| 熔断 | 连续失败 ≥ `breaker.consecutiveFailures` → 项目 `paused` + 通知 | — | — | — |

- 修复链共享配额：`repairBudget{maxNodes, maxAttempts}`，失败签名（节点+失败码+首个 failing check）去重，同签名最多 N 次修复（默认 2）。
- 重试默认复用同一会话（保留上下文）；`sessionReuse.maxAttemptsBeforeReset` 次后或上下文超阈值时强制 compaction 或建议「新会话重试」。
- `retry-new-session`：开新会话（旧会话保留回看），`activeSessionId` 切换，attempt 记 `trigger`。

### 8.6 预算、并发与安全

- **三层预算**：attempts、token（in/out）、活跃时长；另加日级 token 上限。attempt 前按 estimate 预留，attempt 结束后按 `TokenMeter` 实测结算；超限 → `paused(budget-exhausted)` + 通知。
- token 计量覆盖所有消耗路径：worker/verifier/planner attempt、面板对话、`agent.followup` 唤醒、compaction。code-review 由 preset 排除（P0 验证）。
- 并发上限见 8.2；写范围冲突串行。
- **宿主强制约束**（不是只写提示词）：
  - 节点会话专用 preset：`orchestrator-worker`（读写+bash）、`orchestrator-verifier`（只读）、`orchestrator-planner`（只读）。
  - 沙箱：`workspace-write`，cwd = 工作区；域数据目录对节点会话不可写；checks 同沙箱 + 净化 env。
  - 工具面：`agent.ctx.tools.restrict({allow})` 做白名单；`tools.guard` 只拒绝已知危险工具与结构化参数（如 `run_in_background=true`），**不把 bash 文本匹配当安全边界**。
  - `gate/executor/scope/readOnly/checks/budget/maxImpactAuto` 等 human-only 设置由工具层拒绝（返回 `needs-human`）。
- **越界即停**：明确归属的 `scope-violation` 发生后，宿主立即停止该节点的后续派发（不再重试），挂人工门禁；`foreignChanges` 只提示不阻断。
- **env 白名单**：节点会话与 checks 子进程只注入最小环境（PATH/HOME/项目相关变量），**不注入 `DSH_HOME`、`DSH_SESSION_ID` 与 provider/key 变量**；机制：创建会话时经 `agentOptions.env` 覆盖 + checks 子进程显式 env；P0-4 增加 `env | grep DSH_` 探针，机制不可行时 v1 降级为「仅 checks 净化」并在 UI 明示残余风险（§16）。工作区外读权限不在 v1 承诺内。
- 唯一允许写 git 的角色是人（release 门禁）。

### 8.7 暂停、停止、恢复

- `pause`：不再派发；运行中的 attempt 继续到 turn 结束，然后停在原地；项目 `paused`。
- `stop`：中止所有运行中 turn（abort，不销毁会话）；节点 `blocked(stopped)`，attempt 记 `aborted`；项目 `paused(reason=stopped)`，可恢复。
- `awaiting-continue`：`rhythm=wave|phase` 时的停机点；通知并唤醒主 agent，`continue` 动作恢复。
- 插件重载/重启：运行中的 attempt 标 `interrupted`；会话与会话映射持久化，恢复后**默认等人工确认重试**；驱动租约重新获取（旧租约过期后可抢占并通知）。
- 恢复前置：驱动会话 live 或可 resume；否则项目卡显示「等待驱动会话打开」，画布中央给出「打开驱动会话继续」。

### 8.8 通知与唤醒

| 事件 | 通知 | 唤醒 agent | 去重键 |
| --- | --- | --- | --- |
| 节点 `blocked` | ✅ | ✅ | `blocked:<nodeId>:<reason>` |
| 门禁待处理（计划/契约/影响/破坏性变更） | ✅ | ✅ | `gate:<nodeId>:<version>` |
| 波次完成（`rhythm=auto` 只进摘要） | ✅ | 仅 `rhythm=wave` | `wave:<projectId>:<wave>` |
| 熔断 / 预算耗尽 / 项目完成 | ✅ | ✅ | `state:<projectId>:<status>:<reason>` |
| 自动修复链结束 | ✅ | ✅ | `repair:<nodeId>:<signature>` |
| 提议批准/驳回 | ✅ | ✅ | `proposal:<proposalId>:<status>` |

- 落库 `notifications`（dedupeKey、eventSeq、target、deliveredAt、ackedAt）；同一项目每分钟最多 2 次 followup，其余合并摘要。
- UI：右下 toast（≤3 条、`role=status`、8s 自动消失、点击定位节点）+ FAB 未读点 + 项目卡「待审批」可点循环跳转。

### 8.9 会话存活边界与驱动租约

- 驱动租约：驱动会话在宿主注册时心跳（30s），90s 过期；人工动作要求 `sessionId === lease.sessionId`，否则返回 `not-driver`。
- 派发前 `agents.get(driverSessionId)` 校验；离线 → 不派发、不耗预算、提示打开驱动会话。
- 节点会话是独立 agent：驱动会话关闭后仍可查看历史；冷会话通过 `agents.resume` 唤醒（P0 验证 preset 重挂）；不能唤醒时面板显示「会话已休眠，重新唤醒」。
- v1 不做后台 agent（v1.5 研究无人值守方案）。

## 9. 影响传播

### 9.1 变更分类

| 类别 | 触发 | 举例 | 写图入口 |
| --- | --- | --- | --- |
| `spec` | 节点 intent/acceptance 变更 | 「登录要支持短信验证码」 | 主 agent 可改；节点会话只能提议 |
| `contract` | 契约产物/版本/冻结状态变更（`freezeState`、`frozenVersion`） | 接口加字段、DB 改类型 | **只能提议 + 人工批准** |
| `structure` | 增删/移动节点、改父级、改依赖 | 拆分功能、删接口 | **只能提议 + 人工批准** |
| `scope` | `scope` 变更（会重算 `conflicts` 与波次） | 扩大写范围、拆分文件归属 | **只能提议 + 人工批准** |
| `impl` | 运行中或完成后的代码改动 | worker 结果、用户手改 | 由 attempt 证据产生 |
| `evidence` | 验收/评审结果变化 | 测试失败、评审发现问题 | 由验收产生 |

### 9.2 影响面计算

- 距离 `d(v)` = 在依赖/消费/验证/父子边组成的图上到变更节点的最短边数。
- **下游**：`depends_on`/`consumes`/`verifies` 的传递消费者（反向边）+ 全部子孙容器，`d` 从小到大。
- **上游**：祖先链 + 直接提供方（正向 `depends_on`/`consumes` 的 to 端）。
- **兄弟**：同父节点 + `convention` 连通分量 + 消费同一契约的节点。
- 结果按 `d` 去重排序，并给每个节点标注"经由哪条边/为什么被影响"。
- **计数时机**：以首跳计算 `impactCount` 用于 `maxImpactAuto` 判断；级联集合完整计算用于展示与重跑计划。
- **终止规则**：一次传播只执行一跳全量；由传播产生的变化标 `origin='propagation'`，不再二次传播（避免自激）。同一 `(proposalId, nodeId)` 只落一次。

### 9.3 传播矩阵

| 变更 | 上游动作 | 下游动作 | 兄弟动作 |
| --- | --- | --- | --- |
| `spec` | 父容器重算进度；提供方契约复核覆盖 | 标记 `stale(reason=spec)`；重排后重做/重验；已 done 的验证节点重跑 | 同 feature 其它节点标"表述待复核"；追加 review |
| `contract` | `freezeState:pending`、`frozenVersion+1`；上游 spec/decision 一致性检查 | 全部消费者 `stale(reason=contract)`；`integration`/`test` 重跑 | 共享契约的消费者触发一致性 `audit`；跨泳道 → 人工门禁 |
| `structure` | 父容器重算；被删节点上游解除 | 被删节点下游 `blocked`；新增节点排入下一波 | 波次重算并提示；`reservedIds` 禁止 id 复用 |
| `scope` | 父容器重算 | `conflicts` 重算、波次重算；受影响节点等写冲突解除 | 同波节点串行顺序重排 |
| `impl` | 若违反契约 → 契约节点标"实现偏离" | 依赖其代码的 `integration`/`acceptance` 重跑 | `convention` 组审计 |
| `evidence` | — | 目标节点 `done→blocked`；相关修复节点重排 | 同波其它节点不受影响 |

### 9.4 自动与人工

- 写图入口唯一性（V2 补）：对既有节点的结构/契约/人类门禁字段改动（含 `add-edge`/`remove-edge`、改父级、改 `gate/executor/scope/readOnly/checks`）一律只能先落 `proposals`，人工批准后由宿主执行；`orch_plan merge` 若触碰既有节点结构，按 V21 回 `awaiting-approval`。
- **自动传播**：`impactCount ≤ maxImpactAuto` 且全部受影响节点在同一 `stream`、不涉及契约版本变更、无 running 受影响节点、`origin !== 'propagation'` → 直接标 `stale`/重排并记事件。
- **人工门禁**：跨泳道契约变更、`impactCount` 超阈值、结构删减超过 `maxStructuralDeletes`（默认 5）、会中断 running 节点、预算不足 → 生成 `sys:gate-*`，受影响分支 `blocked(gate-pending)`，其它分支继续。
- running 节点唯一策略：**不打断已完成节点；running 等其完成；queued 回 ready**。不做"中止 running 需用户确认"（列入 v1 不做）。
- 提议被拒：理由写 events，通知提交方会话与主 agent；`pendingProposals` 保留 24h 后 `expired`。

### 9.5 影响卡与提议

- **提议**：`{proposalId, projectId, nodeId, changeClass, patch, rationale, baseNodeVersion, basePlanVersion, status(pending/approved/rejected/expired/snoozed/superseded), snoozedUntil?, decidedBy, decidedAt, createdAt, expiresAt}`；同 `(nodeId, changeClass)` 的 pending 合并。
- **影响卡**：节点会话里的 amber 卡（宿主 Chat 里通过 `uiConversation.events.register` 注册的自定义事件节点）——标题「影响面 · N 个节点待确认」、受影响节点 pill、主按钮「走影响审批」、次按钮「稍后」。
- 「走影响审批」= 深链到详情 tab 的待确认区（唯一审批面，§11.10）；「稍后」= `snooze(2h)` 并进项目卡待办计数 + 节点卡 amber 点，不丢。
- 批准需带 `expectedVersion`（快照版本），过期返回 `stale-view`；批准后宿主执行传播（effect 幂等：已生效目标返回上次结果）。
- 详情 tab 的「依赖与影响」区块常驻显示上下游/兄弟、原因与 pin 版本。

## 10. 节点会话（一节点一会话）

### 10.1 模型：持久会话，而不是"每次 activation"

`startActivation` 的真实语义是**新建一个 continuable 子会话并跑它的首个 turn**（`dsh-subagent/src/types.ts:29-46`、`manager.ts:330-395`），不能用来"在已有节点会话里跑一个 turn"。因此 v0.3 改为：

- **节点会话只创建一次**，统一经 `ensure-session`（§10.2）：默认 `startActivation` continuable；P0 若失败改 `agents.create` + `agentPresets.mount`；preset 与沙箱在创建时一次完成；
- **每个 attempt = 该会话上的一个 turn**：热路径 `agent.followup`，冷路径 `agents.resume` → followup；
- 结构化结果用常驻工具 `orch_submit_result`，宿主从 tool result 事件绑定当前 attempt（不再依赖 `outputSchema`）；
- 会话是持久的：关面板、切节点、插件重载都不销毁；重试默认复用同一会话。

### 10.2 会话归属与创建时机

| 节点类别 | 会话类型 | preset | 创建时机 | 对话按钮 |
| --- | --- | --- | --- | --- |
| 根 `project` | **驱动会话本身** | 会话默认 preset | 已存在 | 可用（= 与主 agent 对话） |
| 叶子·设计类（spec/decision/contract/research） | 无子会话：对话落回驱动会话 | — | — | 可用（面板标注「主 Agent」） |
| 容器 `phase/stream/module/feature` | 规划讨论会话 | `orchestrator-planner` | 首次打开对话时懒创建 | 可用 |
| 叶子·实现类（api/migration/page/component/integration/doc…） | 执行会话 | `orchestrator-worker` | 首次执行或首次打开对话时懒创建 | 可用 |
| 叶子·验证类（review/audit） | 验证会话 | `orchestrator-verifier` | 首次执行或首次打开对话时懒创建 | 可用 |
| 叶子·`test` | 无会话（宿主执行命令） | — | — | **禁用**（详情可见） |
| 叶子·`gate/release/acceptance` | 无子会话：对话落回驱动会话 | — | — | 可用（面板标注「主 Agent」） |

- 创建路径**唯一**：`ensure-session` 以 `Node.activeSessionId` 的 CAS(null→id) 为准；执行器与 UI 都走它，冲突返回既有 id；**preset mount 与 `setSandboxMode('workspace-write')` 都在该调用内完成**。
- 会话与节点 1:1（fork 后可 1:N，`activeSessionId` 指向当前）；懒创建避免 200 节点把会话列表撑爆。
- 会话在会话列表的展示：标题前缀 `[节点] <节点标题>`；P0 确认能否分组。
- 节点删除不删会话（标 orphan 可回看）；插件卸载不删会话。
- 空闲节点会话不是活跃子代理，不计入 `maxActiveSubagents`；同时被唤醒的会话计入容量（见 8.2）。

### 10.3 Attempt 生命周期

1. 调度器选中节点 → `ensure-session`（唯一创建路径：默认 continuable 子会话 `origin:'subagent'`、cwd=工作区；同一调用内 `agentPresets.mount` + `setSandboxMode('workspace-write')`，P0 失败改 `agents.create` 路线）。
2. 生成基线快照 → 组装 prompt → 开 turn：
   - 热：`agent.followup`；
   - 冷：`agents.resume({sessionId, setup})` 后 followup；
   - 记录 `turnStart`。
3. 模型调用 `orch_submit_result` → 宿主捕获结构化结果；turn 结束记录 `turnEnd`。
4. 跑 checks（沙箱）→ after 证据 → 归属判定 → 状态迁移（CAS）。
5. 写 `attempts`（含 token 成本）；失败走 8.5。

- **重试默认同会话**：把上次失败证据作为新 user 消息注入；`retry-new-session` 则新建会话并切换 `activeSessionId`。
- **用户中止**：面板停止 → abort 当前 turn，`stopReason='user-abort'`，节点置 `blocked(user-abort)`（可重新派发，不消耗 `maxAttempts`）。
- 节点 intent/acceptance/scope 变更以系统消息写入会话，避免模型用旧规格干活。
- 会话超阈值（`sessionReuse.compactionThreshold`）时强制 compaction 或建议新会话；每 attempt 记录 token 增量。

### 10.4 面板内嵌宿主 Chat

- **外层 chrome 自绘并冻结**（404/头部/tab/作用域行/composer）——见 §11.9。
- **消息流宿主渲染**：`sessions.retain(sessionId)` 拿 `SessionReference` → 视图内声明 session 作用域子槽 → `SessionProvider session={reference}` → `renderFactorySlot('conversation.content', {variant:'embedded'}, {slots:{views: FixedChatConversationView}})`。**插件不得 require 宿主 UI 包**（只经 slot + props 使用）。
  - 三个隐藏前提缺一不可：retain 保活、session 子槽才发 SessionProvider、固定 `views` 防串台；缺一项的表现是空白或串台而不是报错（P0 必验）。
- **发送**：面板 composer 自绘，提交 `POST /node-chat {sessionId,nodeId,text,expectedVersion}` → 宿主 `agents.get(sessionId)?.followup`（冷则先 resume）；中断 → `POST /node-abort` → abort 当前 turn。
- **影响卡**：用 `ctx.uiConversation.events.register` 注册自定义事件节点（只在编排台会话视图内渲染），不侵入宿主聊天气泡。
- 面板顶部作用域标注三类：`节点子代理` / `规划讨论` / `主 Agent`（`data-scope-kind`）。
- 退化：内嵌不可行时面板退回"只读回看 + 在对话视图打开"；发送仍可走 `node-chat`（宿主 followup）。

### 10.5 线程、事件与通知

- `turn/start`/`user/message`/`assistant/message` 按 `sessionIndex` 反查绑定 nodeId，续写 thread 摘要（用户 ≤1000、助手 ≤2000）。
- 会话完成/阻塞/产生提议 → 宿主写 `notifications`（去重）→ 唤醒主 agent；节点会话本身不改图。
- 用户在节点会话里说的需求变更 → `orch_propose` → 影响卡 → 详情批准 → 宿主传播。
- 详情 tab「最近对话」读线程摘要；完整对话只在面板。

### 10.6 权限边界

| 角色 | 可改图 | 可写代码 | 可批准 | 可改 human-only 设置 |
| --- | --- | --- | --- | --- |
| 驱动会话主 agent | 是（spec 类直接改；contract/structure/scope 只能提议） | 否 | 否 | 否 |
| 节点执行会话 | 否（只能 `orch_propose`） | 仅在 `scope` 内（沙箱） | 否 | 否 |
| 节点规划会话 | 否（只能 `orch_propose`） | 否（只读） | 否 | 否 |
| 用户（UI，带 bearer） | 是（详情动作） | — | 是 | 是 |
| 本机其它进程 / worker bash | 否 | 仅在各自沙箱内 | 否 | 否 |

- 令牌只经客户端 bootstrap 注入，不进 shell env；XSS 防护（禁 innerHTML）是保护令牌的第一道门。

### 10.7 与驱动会话的分工

- 驱动会话：勘察、拆解、写规格/契约、处理门禁与升级、回答"整体"问题；持有驱动租约。
- 节点会话：只关心该节点——实现、修、解释、就本节点提变更提议。
- 桥：宿主通知 + `pendingProposals` + 事件日志 + 租约。
- 用户从节点会话切到「对话」视图看到的是驱动会话，不串台。

## 11. UI（已冻结）

### 11.0 冻结声明与证据

- 冻结物：`docs/superpowers/mocks/orchestrator-ui.html`（原型 **v0.3.0**，含 `window.orchestratorUI` 0.3.0 契约）与 7 张截图：
  `shot-orchestrator-v03-focus.jpg`（选中/关系/动作行）、`shot-orchestrator-v03-deselected.jpg`（空白取消）、`shot-orchestrator-v03-lowzoom.jpg`（低缩放降级）、`shot-orchestrator-v03-states.jpg`（六态/快捷键）、`shot-orchestrator-v03-light.jpg`（浅色对比度）、`shot-orchestrator-v03-downstream.jpg`（下游双线）、`shot-orchestrator-v03-container-actions.jpg`（容器动作行/胶囊）。
- 本节是原型的文字转写；冲突时以原型为准，修本节不改原型。
- 用户已批准的 6 处冻结修正（实现必须照做，原型已同步）：
  1. 上游实线 amber / **下游双线** accent（不只靠颜色区分）；
  2. 提高对比度：`--text-3` 与 amber 系列加深（实测比例见 11.13）；
  3. 低缩放（k<0.5）用**状态字形 + 徽章色点**替代纯色点；
  4. FAB 增加 `aria-label` 并新增「打开/收起面板」快捷键 `O`；
  5. 折叠胶囊**完整外挂**（内容裁剪下移到 `.body`，卡片 `overflow:visible`）；
  6. 卡片高度**按内容自适应**（含动作行），`对话/详情` 永不被裁。
- 原型 v0.2 的 12 处缺陷（dim 失效、父子边染色错、tab 不可点、清空不复位 aria、搜索选中折叠内节点、容器高度裁切、折叠胶囊被裁、全部折叠只剩 root、无选中 initialView NaN、禁用可拖、计时写死、下游文案写死）在 v0.3 原型已修 **8** 处（dim、边染色、tab、aria、搜索展开、容器高度、胶囊、禁用拖拽）。剩余 **4** 处（全部折叠仍只剩 root、无选中 initialView 未保护、计时仍写死、详情"下游"文案写死）在实现中修，并另加 4 个新增面（搜索命中 n/m 计数、toast/未读、审批动作区、空态）——见 §11.15。

### 11.1 注册与占位

- `conversation.view` 列表槽，id `orchestrator`，label「编排台」，order 20（对话 0 / 轨迹 10 / 编排台 20）。
- 全幅接管：视图根使用 composer overlay 约定（`data-conversation-composer-overlay`）铺满内容区；编排台**不使用**宿主 composer，通过注册 **`conversation.composer` chain** 在 active view === `orchestrator` 时返回 `null` 接管（**不要挂载时改宿主 DOM**）。
- 侧栏会话历史与顶栏 view tabs 保持宿主原样。
- 退化路径：`conversation.view` 不可用 → 右栏 tab；composer chain 不可用 → 保留宿主 composer 但禁用并下移画布（布局另算）。

### 11.2 画布结构与像素契约（冻结点）

```
┌ 会话侧栏(宿主) ┬ 顶栏：会话标题 / 对话·轨迹·编排台·统计 ────────────────────────────┐
│                │ ┌─────────────────────────────────────────────────────────────┐ │
│                │ │ 项目卡(16,14)                      搜索/筛选/工具组(右上16,14) │ │
│                │ │        [项目]──[阶段]──[泳道]──[任务卡片…]  ← 无限画布          │ │
│                │ │                                    ┌───────────────────────┐ │ │
│                │ │                                    │ 悬浮对话面板 404       │ │ │
│                │ │ 小地图(16,bottom56)                │ 对话 | 详情            │ │ │
│                │ │ 图例(16,bottom16)  提示条(居中)     │ 作用域 ▸ 输入框        │ │ │
│                │ │                          缩放条(右下)└───────────────────────┘ │ │
│                │ └─────────────────────────────────────────────────────────────┘ │
└────────────────┴───────────────────────────────────────────────────────────────┘
```

| 元素 | 位置/尺寸（px） | 说明 |
| --- | --- | --- |
| 画布 stage | 内容区剩余全部，`overflow:hidden` | 上下渐隐遮罩（顶 108 / 底 156） |
| world | 24000 × 18000，树原点 (9000, 7000) | 圆点网格 22px，可关；只改 transform |
| 节点卡片 | 宽 268；叶子**最小**高 136、容器**最小**高 124；实测高度参与布局 | 水平 84、垂直 26；高度 = max(最小高, 内容实测高)，见 11.3 |
| 项目卡 | left 16 / top 14，min-width 274 | 项目名 + 模式 chip + 统计 + 4 按钮 |
| 右上工具条 | right 16 / top 14，max-width `calc(100% - 340px)` | 搜索 + 筛选 + 工具组，可折行 |
| 小地图 | left 16 / bottom 56，184 × 118 | 内缩 10，见 11.8 |
| 图例 | left 16 / bottom 16，gap 10，可折行，max-width 400 | 与小地图间距 14 |
| 提示条 | 水平居中 / bottom 18 | 静态操作提示（不可点） |
| 通知/notice | right 16 / bottom 124（FAB 上方，右下堆叠） | `role=status`，与提示条分开两个元素 |
| 缩放条 | right 16 / bottom 16 | 缩小 / 百分比 / 放大 / 居中 / 适应；面板打开时被面板盖住（已知取舍，缩放走快捷键） |
| FAB | right 16 / bottom 70，46 × 46 | 面板收起时出现，amber 未读点 |
| 对话面板 | right 16 / top 70 / bottom 16，宽 **404**（冻结） | 圆角 14；不可拖拽改宽 |
| 层级参考线 | 4 列：项目/阶段/泳道/任务 | 虚线 + 顶部小标签 |
| z 轴 | 画布 0 / 遮罩 20 / 浮层 30 / 面板 40 / FAB 45 / 菜单 90 / 快捷键浮层 95 | toast 50 |
| 窄窗口 | <1024：面板覆盖式、fit `padR=30`、隐藏提示条；<760：项目卡收成一行 | 见 11.15 |

### 11.3 节点卡片（冻结点）

字段自上而下（常显，不必开详情即可掌握基本盘）：

| 行 | 内容 | 显示条件 |
| --- | --- | --- |
| ① 类型图标 + 标题 + 意图 + 状态点 | 图标 22（svg 13，色调底）；标题 13.5/18 两行截断；意图 11/15 两行截断；状态点 8×8 | 常显 |
| ② meta | `类型 · 执行者 · 状态[· 真实 elapsed]` | 常显；running 叶子显示 `02:41`，每秒刷新 |
| ③ 进度 | 5px 进度条 + `done/total` | 仅容器 |
| ④ metrics | 叶子：`验收 n` `文件 n` `上游 n` `尝试 x/y`（非 `0/n` 时 amber）<br>容器：`子节点 n` `完成 d/t` `运行 n` `下游 n` | 常显，按数据有无出现（0 值省略） |
| ⑤ 徽章 | `契约冻结`（violet）/`门禁`（amber）/`人工`（slate）/`依赖未就绪`（muted），带 `title` 说明 | 有徽章时 |
| ⑥ 动作 | `对话` / `详情`（10.5px，图标 11） | **悬停或选中时显示**；禁用/加载态不显示 |
| ⑦ 折叠胶囊 | 卡片右侧外挂（`right:-12px`，height 22，`+N` / `−`），完整可见 | 仅容器 |

- **高度自适应（v0.3 新增）**：136 / 124 只是最小值；渲染后按 `.body` 内容实测高（含动作行）撑高，布局用实测高；量高时强制动作行参与，保证「对话/详情」不被裁。低缩放（k<0.5）回到最小值。
- **折叠胶囊完整可见（v0.3 新增）**：内容裁剪在 `.body`（`overflow:hidden`），卡片 `overflow:visible`；胶囊外挂 12px 不得被裁。
- **指标口径**：叶子「上游 n」= 直接依赖/消费数；容器「下游 n」= 直接消费者数；与选中关系高亮（祖先链 + 全部子孙）不是同一套口径，需 `title` 提示。
- **容器统计口径**：`完成 d/t`、`子节点 n`、`运行 n` 全部按叶子口径，项目卡统计同口径。
- 按钮只有两个；其它能力进详情动作区或右键菜单。容器与叶子外观一致，只靠高度、进度条、折叠胶囊区分；虚线边框只属于 `draft`。
- 父节点垂直居中于首/末可见子节点中心；卡片之间不重叠。

### 11.4 类型视觉映射（17 启用 + 8 实验）

| kind | 中文 | 图标 | 色调 | v1 | kind | 中文 | 图标 | 色调 | v1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| project | 项目 | folder | slate | ✅ | spec | 规格 | file | violet | ✅ |
| phase | 阶段 | flag | slate | ✅ | decision | 决策 | scale | violet | ✅ |
| stream | 泳道 | layers | slate | ✅ | contract | 契约 | lock | violet | ✅ |
| module | 模块 | grid | slate | ✅ | api | 接口 | plug | blue | ✅ |
| feature | 功能 | spark | slate | ✅ | migration | 迁移 | db | blue | ✅ |
| page | 页面 | layout | blue | ✅ | component | 组件 | box | blue | ✅ |
| integration | 联调 | link | blue | ✅ | test | 测试 | check | green | ✅ |
| review | 评审 | eye | green | ✅ | gate | 门禁 | shield | amber | ✅ |
| bugfix | 修复 | bug | red | ✅ | research | 调研 | file | violet | 实验 |
| service | 服务 | layers | blue | 实验 | section | 区块 | layout | blue | 实验 |
| logic | 逻辑复用 | box | blue | 实验 | acceptance | 验收 | check | green | 实验 |
| audit | 审计 | eye | green | 实验 | release | 发布 | flag | amber | 实验 |
| doc | 文档 | file | slate | 实验 | | | | | |

- 6 种色调（slate/violet/blue/green/amber/red），每种一对 soft/fg；图标 16 viewBox/描边 1.4，卡片渲染 13px、面板头部 14px。
- 语义：结构=slate、设计=violet、实现=blue、验证=green、人工=amber、修复=red；实验类型沿用所属族，不新增颜色。

### 11.5 节点六态（冻结点）

六态是**交互态**，与领域状态正交；自动化断言分三轴：`data-state`（4 值）+ `data-selected` + `data-rel`，hover/active 用伪类表达。

| 态 | 触发 | 视觉 | DOM |
| --- | --- | --- | --- |
| 默认 | 常态 | 卡片 + 1px 边框 + card 阴影 | `data-state="default"` |
| 悬停 | 指针悬停在可交互节点 | 边框加深、上浮 1px、float 阴影、动作行出现 | `:hover` |
| 按下 | pointerdown～pointerup | `translateY(0)` + `scale(.994)` + 阴影压平 | `:active` |
| 禁用 | 不能操作/对话：`system` 类（test）、`canceled`、尚未启用（`依赖未就绪` 占位、实验类型未开放）。`blocked` 但可对话的节点**不是**禁用 | opacity .5 + grayscale .35 + `cursor:not-allowed` + 无动作 + 不可拖；**仍可选中看详情**（只读） | `data-state="disabled"`、`aria-disabled="true"`、`tabindex="0"` |
| 加载 | 拉快照/派发中/排队中 | 状态点 spinner（accent 28% 环 + 顶弧，0.8s）、metrics 透明度 .55、仍可看详情 | `data-state="loading"` |
| 聚焦 | 被选中或键盘聚焦 | 选中：2.5px accent outline offset 2；键盘：2px accent outline offset 3 | `data-state="focused"`、`aria-selected="true"`（treeitem 合法；原型暂用 aria-pressed 占位，实现按本节） |

- 领域状态 → 外观：`running` accent 点 + 1.8s pulse、边框 accent 36%；`verifying` 同 running 但文案「验收中」；`done` 绿点；`ready` 空心环；`blocked` 红点；`stale` 琥珀点；`draft` 虚线边框 + 透明底；`queued` 用加载态；`canceled` 用禁用态；`awaiting-human` 用琥珀色实心点 + 文案「待确认」。
- 色彩不是唯一信息：状态点带形状（11.8 低缩放时形状差异更明显）、徽章必须带文字、关系用线型区分（11.6）。

### 11.6 选中与关系高亮（冻结点）

- 选中方式：单击卡片、`Enter`/`Space`（卡片聚焦）、右键菜单「对话/详情」、搜索命中、双击卡片（= 打开对话 tab）。
- **单击只选中**：面板收起时不自动展开（双击/「对话」才进对话）；面板打开时切到该节点。
- 关系着色（互斥，优先级 **自身 > 上游 > 下游 > 兄弟 > 无关**）：
  - 自身：accent 实线 outline 2.5px；
  - **上游**（祖先链 + 直接依赖/消费的提供方）：**amber 实线** outline 2px；
  - **下游**（直接消费者 + 全部子孙）：**accent 双线** （`outline: 3px double`）；
  - **兄弟**（同父其它节点）：violet **虚线** outline 2px；
  - 无关：`rel-dim`（底/边框压暗，文字保持可读，不整体 opacity）。
- 连线：父子边默认 `--border-strong` 1.7；**按路径方向**判定——在"选中→祖先"路径上 amber 2.2 实线；在"选中→后代"路径上 accent 双线（同路径平移 3.2px 的 echo 副本）；其余 dim .1；依赖边虚线 5/5、1.2，命中时 6/4 加粗 2.2。
- 空白单击（位移 ≤3px）清除选中、关系、`aria-selected`、面板回「未选择节点」；悬停不改变关系高亮。
- 关系高亮是"看关系"的可视化，不触发调度、不写库，也不等于 §9 的影响面计算。
- 原型 v0.2 的两个 bug 已修：`applyFilter` 不再清掉关系 dim（拆成 `rel-dim` / `dim` 两类）；父子边染色按路径而不是按父节点归属。

### 11.7 画布操作与快捷键（冻结点）

| 操作 | 输入 | 行为与数值 |
| --- | --- | --- |
| 平移 | 拖空白（>3px 才算拖）/ 滚轮 / 触控板 | 只改 world transform |
| 缩放 | `⌘/Ctrl+滚轮`（`exp(-deltaY*0.0022)`，指针锚定）；`+`/`-`；按钮 ×1.15 | 范围 0.2–1.8；k<0.5 进低缩放降级 |
| 适应画面 | `0` / `⌘Ctrl+0` / 按钮 / 右键菜单 | 留白 左30 上100 下150 右430（面板开）或30；k 夹 0.2–1.05 |
| 首次进入 | 自动 | k 夹 0.45–0.85，树左对齐，选中节点垂直居中；无选中以根居中 |
| 居中选中 | `F` / 按钮 | k = max(当前, 0.85)，在面板左侧可用宽度内居中 |
| 拖动节点 | 按住卡片拖（阈值 3px） | 仅可交互节点可拖；只移动该卡片（不带动子树）；位移按 1/k；记 offsets；整理布局清空；右键「重置位置」清单个 |
| 折叠/展开 | 胶囊 / `E`（选中容器）/ 全部折叠·展开 | 折叠含选中节点的容器 → 选中上移到该容器；「全部折叠」折叠深度 ≥1 容器但**根保持展开**；展开后选中若被隐藏则展开祖先 |
| 搜索 | `/` 聚焦；输入即 dim；`⏎` **循环下一个命中**并显示 `n/m`；`Shift+⏎` 回退 | 命中在折叠容器内 → 先展开祖先链再选中居中 |
| 筛选 | 全部 / 运行 / 就绪 / 异常（blocked+stale+awaiting-human 分列）/ 完成 | dim 不命中，不隐藏不重排；与关系 dim 叠加 |
| 右键菜单·节点 | 对话 / 详情 / 居中 / 折叠·展开子树 / 重置位置 | 键盘 `Shift+F10` 或 `M` 打开，`role=menu`，方向键 + Esc |
| 右键菜单·空白 | 适应 / 居中 / 整理布局 / 显示·隐藏关联线 / 显示·隐藏网格 | 同上 |
| 双击节点 | — | 打开该节点对话 |
| 快捷键浮层 | `?` 或项目卡 `?` 按钮 | 360 宽卡片，含新增的 `O` / `?` / Esc 行 |

- 键盘全集：`0`、`⌘Ctrl+0`、`F`、`E`、`+`/`-`、`/`、`?`、`O`（开/收面板）、`Enter`/`Space`（选中聚焦卡片）、`Esc`（级联：关浮层 → 关菜单 → 清选中 → 收面板）；树导航用 `↑↓`（兄弟/上下）、`←→`（父级/首个孩子，roving tabindex）、`Home/End`（首/末可见节点），`Tab` 只进出整棵树。
- 快捷键守卫：`closest('input,textarea,select,[contenteditable]')` 或 `e.isComposing` 时全部放行。
- 已知缺口：拖动无键盘等价（用「重置位置/整理布局」替代）；画布平移无方向键（滚轮/触控板覆盖）；面板内跳转不抢焦点（见 11.17）。

### 11.8 小地图与图例（冻结点）

- 小地图 184×118，left16/bottom56，内缩 **10**；缩略块按状态配色，最小 2px，带 `data-node-id`，点击缩略块居中该节点；视口矩形 accent 1.5px 边框 + accent 10% 填充、最小 8px、clamp 在 pad 内（修过：不内缩会被圆角裁切）。
- 点击/拖动小地图 → 视口中心对齐；`role="group"` + `aria-label`；纯视觉缩略副本可 `aria-hidden`，但可点的缩略块保留语义。
- 图例在 left16/bottom16（**小地图下方**，间距 14），顺序：`运行中 · 就绪 · 完成 · 过期 · 受阻 ‖ 上游（单线 amber） · 下游（双线 accent） · 兄弟（虚线 violet）`。
- 低缩放时图例不变；状态点形状差异（圆/环/菱形/三角）在小比例下比颜色更可靠。

### 11.9 对话面板（冻结点 + v0.3 内嵌）

- 尺寸：宽 **404**、right16/top70/bottom16，圆角 14，不可拖拽改宽；收起 = 淡出下沉（`opacity 0 + translateY(8px) + scale(.98)`，160ms）+ 右下 FAB；收起时 `inert` + `aria-hidden`，焦点移到 FAB。
- 头部：类型图标 24 + 标题 13 + 副行 `类型 · 执行者` + 状态 chip（accent/green/amber/red）+ 最小化/关闭（两者行为相同，都收到 FAB）。
- tab：`对话` / `详情`（**可点**），`role=tablist/tab`；未选中时半透明不可点。
- 消息区（**宿主渲染**，§10.4）：作用域 chip、用户气泡、助手正文、工具行、流式、附件均走 DSH 原生 Chat；宽度在 404 容器内自适应。
- **影响卡（唯一自定义消息）**：amber 底/边框、盾牌标题、受影响节点 pill、主按钮「走影响审批」+ 次按钮「稍后」；通过 `uiConversation.events.register` 注册，只在编排台会话视图渲染。
- composer（自绘，固定底部）：
  - 作用域行：`对话作用域` + pill `● <节点>` + 右侧「清除」（= 取消选中）；
  - 输入框：`就「<节点>」继续对话…`，focus 边框 accent；`⏎` 发送、`⇧⏎` 换行；
  - 底部：`节点子代理会话`（或 `规划讨论` / `主 Agent`，`data-scope-kind`）+ 发送按钮 26×26；
  - **发送中**：发送按钮原位变停止 → `node-abort`；
  - 未选中时整个 composer 隐藏。
- 空态：`这个节点还没有对话。在下面输入框里问点什么，或切到「详情」看看规格与证据。`；无会话节点（test）显示专属文案「该节点由宿主执行命令，没有会话」+ 去详情看证据，**composer 禁用并带说明**（不是隐藏后什么都不给）。
- 未读：FAB amber 点由未读计数驱动（0 时隐藏），`data-unread`。
- 面板与画布：面板打开时 fit/居中的可用宽度自动扣 430。

### 11.10 详情 tab 与唯一审批面

详情 tab 是**所有人工动作的唯一入口**（右键菜单只做视图操作）。区块顺序：

| 区块 | 内容 |
| --- | --- |
| 概览 | 执行者 / 门禁 / 只读 / 状态（第 n 次尝试 · 真实计时） |
| 验收 | 逐条 ✓（node.acceptance） |
| **验收命令** | checks 全量：名称、命令（等宽、可复制）、超时、来源；`human-only` 标记 |
| 写范围 | scope 等宽列表 |
| 依赖与影响 | 上游 pill（点击跳转不抢焦点）、`consumes · vN · 已冻结`、下游列表、pin 版本 |
| 证据 | 基线 diffStat、文件、`checks ✓/✗`、脱敏计数、违规/foreign 计数 |
| 面包屑 | 祖先链可点（不抢焦点），用于 200 节点时快速回退 |
| 最近对话 | 线程摘要（折叠） |
| **动作区** | 按状态/权限渲染：`批准计划/驳回`、`批准门禁/驳回`、`走影响审批/稍后`、`重新派发`、`新会话重试`、`取消节点`、`重置位置`、`打开对话`；项目级暂停/恢复只在项目卡 |

- 每个动作带 `data-action`，取值与 §13.3 的 action 名对齐：`approve-plan|reject-plan|approve-gate|reject-gate|approve-proposal|reject-proposal|apply-impact|snooze-proposal|retry|retry-new-session|cancel`；纯客户端动作 `open-chat|reset-position` 不走通道。每个写动作带 `data-action-id`（幂等）并二次确认 + `expectedVersion`。
- 动作按钮样式：primary=accent 实心白字；warn=amber 实心白字；danger=red 实心白字；次级=描边；禁用态用 aria-disabled，不靠灰色小字。
- 计划审批节点额外展示：checks 全量、scope 并集/冲突、首波 5 节点、预计 attempts/tokens（§7.5）。
- 影响卡「走影响审批」在此深链到待确认区；「稍后」写 snooze，不丢待办。

### 11.11 项目卡、工具条与顶栏

- 项目卡：项目名 13 + 模式 chip + 统计行（冻结示例 `5/17 完成 · 3 运行中 · 2 待审批 · 预算 12/200`，真实数据按叶子口径 + budgetUsed）+ 按钮组 `暂停`(warn)/`停止`(danger)/`适应画面`/`整理布局` + `?`。
    模式 chip 值域映射：`planning→规划中`、`awaiting-approval→待审批`、`running→全自动`、`paused→已暂停`、`awaiting-continue→等待继续`、`blocked→受阻`、`done→已完成`、`canceled→已取消`；live 脉冲点只在 running 时出现。
  - 「待审批」数字可点 → 依次跳转待确认门禁节点（不新增按钮）；「异常」计数区分 gate-pending 与真失败。
  - 暂停/停止必须二次确认。
- 右上工具条：搜索框（146，`⏎` 循环 + `n/m`）、筛选 chips（全部/运行/就绪/异常/完成，异常里分出待确认）、工具组（网格/关联线/全部折叠/全部展开/主题）。
- 顶栏右侧 chip（可选）：`画布：拖动平移 · ⌘/Ctrl+滚轮缩放 · 右键菜单`；注入失败则省略。
- 通知 toast：right 16 / bottom 124 起向上堆叠，≤3 条、`role=status`、8s 自动消失、点击定位节点；未读进 FAB 点。
- 顶栏 view tabs（对话/轨迹/编排台/统计）由宿主维护，插件不重绘。

### 11.12 空态、加载与错误态

| 场景 | 表现 | `data-empty` |
| --- | --- | --- |
| 无项目 | 画布中央卡片：「描述需求，开始一次长任务」+ 新建编排 + 接管当前会话 + 说明（先勘察再出计划） | `no-project` |
| 有项目未规划 | 「还没有任务树」+「继续拆解」 | `unplanned` |
| 拆解中 | 中央细进度 + 「主 agent 正在勘察与拆解…」，项目卡 chip=规划中 | `planning` |
| 驱动会话离线 | 中央卡片 + 「打开驱动会话继续」按钮；节点保持 ready | `driver-offline` |
| 暂停/等待继续/预算耗尽/熔断 | 中央卡片显示原因（statusReason）+ 恢复按钮 | `paused` / `continue` / `budget` |
| 首屏加载 | 画布骨架 + 面板骨架，不空白 | `loading` |
| 快照失败/轮询断 | 顶部细条「连接已断开，正在重试…」（高 28、`role=status`、z 50），保留旧数据 | `disconnected` |
| 节点会话创建中/失败 | 面板内骨架 / 错误态 + 重试 + 原因 | — |
| 搜索/筛选无命中 | notice 条：`没有匹配节点` + 清除筛选 | — |

- 空态隐藏小地图/图例/缩放条/提示条；`notice`（可带按钮）与 `hint`（静态说明）是两个元素。

### 11.13 主题、字号、对比度、圆角与动效

- 颜色只用 DSH 主题 token；原型里的变量是语义替身（P0 对齐 `--dsw-alias-*` 实际名）。
- **对比度门槛（v0.3 新增）**：正文 ≥4.5:1、大字 ≥3:1、非文本 ≥3:1。实测调整：

| token | 浅色 | 对比度 | 深色 | 对比度 |
| --- | --- | --- | --- | --- |
| `text-3`（meta/图例/小字） | `#6b7178`（原 `#9aa0a6` 2.64） | 4.93:1 | `#9aa1a8`（原 3.41） | 6.17:1 |
| `amber`（文字） | `#8a4f08`（原 3.84） | 6.56:1 | `#f0b873` | 9.07:1 |
| `amber-solid`（白字底） | `#a3630a` | 4.83:1（白字） | `#8f5a12` | 5.77:1（白字） |

- 字号阶 9.5/10/10.5/11/11.5/12/12.5/13/13.5；数字 `tabular-nums`；等宽用于命令/scope/工具行。
- 圆角：卡片 12、面板 14、浮层 9–12、图标底 6–7、徽章 4–5、pill 20。
- 动效：卡片 160ms、面板 160ms、pulse 1.8s、spinner 0.8s、进度 300ms；`prefers-reduced-motion` 全关。
- 主题三态 `dark/light/auto`（auto 跟随系统并记忆）。
- 低缩放（k<0.5）：`data-zoom-tier="small"`，隐藏意图/meta/指标/进度，保留标题+图标+状态字形+徽章色点。

### 11.14 性能与体量预算

- 200 节点：全量 DOM 约 200×18 元素；首屏 <300ms，平移缩放 60fps，布局 O(n) <2ms。
- 自适应量高只跑有界的 2–3 轮（内容高度与宽度无关，收敛快）；`ResizeObserver` 监听容器宽度变化重算。
- 超出 200 或用视口裁剪：只渲染可见 + 一层邻居；不引虚拟滚动库。
- 变换只改 world transform；拖节点只改该卡片 `left/top`（不整树重渲染）；面板消息增量 append。
- 轮询：可见且 running 2s，不可见 10s；快照 ≤200KB；失败退避 2/4/8/16/30s。

### 11.15 冻结红线、已批准修正与"必须有但原型未画"的面

**红线**：卡片按钮只有「对话/详情」；面板宽 404 且不可拖宽；面板只有两个 tab；六态语义；小地图在上图例在下；空白点击取消选中；不新增左侧树、右侧详情栏、顶部审批条。

**已批准修正（6 处，原型已同步）**：下游双线、对比度、低缩放字形、FAB aria + `O`、折叠胶囊完整、卡片高度自适应。**这 6 处不算破坏冻结，后续评审不得回退。**

**新增面（原型未画，允许按此实现，不改既有布局）**：

| 增补 | 为什么必须 | 最小实现 |
| --- | --- | --- |
| 审批动作区 | 计划/门禁/影响必须人工批准 | 详情 tab 动作区（11.10），不新增按钮位置 |
| toast/未读 | 阻塞与门禁不能丢 | 右下 toast + FAB 未读点（11.11） |
| 空态/错误态 | 驱动离线/暂停/断连会真实发生 | 中央卡片 + 顶部细条（11.12） |
| 计划审批内容 | 防止盲批 | 详情内 checks/scope/首波（7.5） |
| 发送中停止 | 长回答可中断 | 发送按钮原位变停止 |
| 面板加载/失败 | 会话懒创建会失败 | 面板骨架 + 重试 |
| 窄窗口断点 | 404+274+430 在 <1024 放不下 | 面板覆盖式、padR=30、隐藏提示条 |

**不做**：画布内嵌输入框、节点内编辑规格、力导向图、框选多选、拖拽改父级、工作流式动画。

### 11.16 DX 契约

**调试 API `window.orchestratorUI`（0.3.0）**：

| 成员 | 语义 |
| --- | --- |
| `version` / `states` / `axes` | 契约版本、六态名、三轴枚举（state/selected/rel） |
| `select(id, tab?, opts?)` → `{ok, nodeId, tab}` | `tab` 为 `'chat'`/`'detail'` 时展开面板；`opts.focus=false` 用于面板内跳转不抢焦点；未知 id 返回 `{ok:false,code:'not-found'}` |
| `clearSelection()` / `fit()` / `focus()` / `initialView()` | 视图与选择 |
| `getSelected()` / `getView()` / `getPanel()` / `getNodeState(id)` | 读状态：视图变换、面板开合与 tab、节点的 state/rel/selected |
| `getNodes()` / `getDemoNodes()` | 树快照；demo 三节点状态 |
| `setTheme('dark'/'light'/'auto')` | 主题三态（auto 跟随系统） |
| `openPanel()` / `minimizePanel()` | 面板开合 |
| **待补（P1）** | `whenIdle():Promise`、`loadFixture({nodes,edges,threads,proposals})`、`reset()`（仅调试开关下） |

**稳定选择器**：`.node[data-node-id]`、`.node [data-act]`、`.node [data-collapse]`、`.chatpanel`、`.cptab[data-t]`、`.chatfab`、`.minimap`、`.mm-node[data-node-id]`、`.legend`、`.menu`、`.sc-card`、`.impactcard`、`.toolrow`、`.ctxchip`、`.search input`、`.fchip[data-f]`、`[data-action]`。

**稳定数据属性**：卡片 `data-node-id/kind/status/state/selected/rel`；边 `data-edge/data-child/data-parent/data-from/data-to/data-rel`；动作 `data-act/data-action`；折叠 `data-collapse`；tab `data-t`；筛选 `data-f`；空态 `data-empty`。

**事件**：`orchestrator:selection`、`orchestrator:panel`、`orchestrator:theme`（`CustomEvent`，只读，不提供写状态事件）。

**约定**：`render()` 幂等；状态单一来源（store 快照）；不允许文本断言布局；主题走 token；`?orchDebug=1` 在卡片上叠加 id/坐标/层级角标（`orchDebug` 对象与 `.orch-debug-badge` 选择器），并列出本插件在宿主注册的工具/preset/监听器自检视图。

### 11.17 AX 契约

| 元素 | 语义与属性 |
| --- | --- |
| 画布 | `role="tree"` + `aria-label="编排任务树"`；卡片 `role="treeitem"` + `aria-level/aria-setsize/aria-posinset`；**整个树只用 roving tabindex**（只有选中/焦点节点 tabindex=0），不采用 application 方案 |
| 节点卡片（treeitem） | `aria-label` = 标题 · 类型 · 状态 · 进度摘要；`aria-describedby` 指向指标/徽章摘要；`aria-selected`（选中，treeitem 合法）；容器加 `aria-expanded`；`aria-disabled`；**roving tabindex**（仅选中/焦点节点 `0`，其余 `-1`；禁用节点经方向键仍可聚焦读详情） |
| 折叠胶囊 | `aria-expanded` + `aria-label="展开/折叠 <标题> 子树（N 个节点）"` |
| 关系 | 视觉 outline/线型 + `data-rel="self\|up\|down\|sib\|dim"`；边同样带 `data-rel` |
| 面板 | `role=region` + `aria-label="<节点> 对话"`；tabs `role=tablist/tab/aria-selected/aria-controls`；收起时 `inert` + `aria-hidden`，焦点移 FAB；恢复焦点回面板 |
| 消息区 | `role=log` + `aria-live=polite`；工具行 `role=status` |
| composer | 输入 `aria-label="与 <节点> 对话"`；发送/停止有可读文案；`⏎`/`⇧⏎` 有提示 |
| 菜单/浮层 | `role=menu/menuitem`、`role=dialog` + `aria-modal`；`Shift+F10`/`M` 打开，Esc 关闭并还原焦点 |
| 小地图 | 纯视觉副本 `aria-hidden`；可点缩略块 `role=button` + `aria-label`；图例用文字+线型，不只颜色 |
| 焦点管理 | 选中后焦点移到卡片（`preventScroll`）；清选中后 blur；roving tabindex（方向键在树内移动，`Tab` 进出整棵树，折叠子树跳过）；面板内跳转不抢焦点（`select(id, tab, {focus:false})`） |
| 对比度 | 见 11.13 门槛；禁用文本可豁免但控制在可辨认范围 |
| 已知缺口 | 拖动无键盘等价；画布平移无方向键；200+ 节点用方向键与搜索定位（`Tab` 只进出整棵树） |

## 12. 数据存储

### 12.1 storageDomain

- 域：`orchestrator`，**version 2**（v1 = v0.2 结构；升级做兼容读取）；单布局；zod 校验；schema 放可被 plain Node 测试的 `domain-spec.js`（避免两套 zod 实例）。
- 表：

| 表 | 主键 | 内容 | 保留 |
| --- | --- | --- | --- |
| `projects` | projectId | 5.1 | 永久 |
| `nodes` | `${projectId}/${nodeId}` | 5.2（含软删墓碑） | 永久 |
| `edges` | `${projectId}/${type}/${from}/${to}` | 5.3（含 pinnedVersion） | 永久 |
| `attempts` | `${projectId}/${nodeId}/${attemptNo}` | 5.5；大字段（evidence）独立键 | 每节点最近 5 次完整，更早摘要 |
| `events` | `${projectId}/${seq}` | 时间线 | 2000/项目 |
| `notifications` | `${projectId}/${dedupeKey}` | 8.8 outbox（deliveredAt/ackedAt） | 2000/项目 |
| `nodeSessions` | `${projectId}/${sessionId}` | 10.2 映射 | 永久 |
| `sessionIndex` | sessionId | `{projectId, nodeId:\|null, role}` 反查（驱动会话不入表） | 永久 |
| `threads` | `${projectId}/${sessionId}/${turn}` | 5.6 摘要 | 50/会话、5000/项目 |
| `proposals` | proposalId | 9.5 生命周期（pending 不淘汰） | 终态保留 500/项目 |
| `reservedIds` | `${projectId}/${nodeId}` | **仅**软删的用户节点 id（`sys:` id 由宿主版本化生成，不入此表） | 永久 |
| `settings` | workspacePath | 5.7 workspace 默认 | 永久 |
| `meta` | projectId/userSessionId | focus、actionId 账本、last run 摘要 | 永久 |

### 12.2 写入、一致性与安全

- 所有写走 `storageDomain` 的单写链（domain 自带串行化，不自建写队列）；`Node.activeSessionId` 等关键字段用 CAS（null→id）。
- 状态迁移三键 CAS：`expectedStatus + expectedVersion + attemptId`；失败返回 `stale-transition`；人工动作另带 `expectedVersion` → `stale-view`。
- **幂等**：`actionId` 账本进 `meta`（≥5000 条不 FIFO 淘汰）；更高优先用"效果幂等"：approve/apply 对已生效目标返回上次结果，不重复执行。
- 证据脱敏：命令输出/线程/结果摘要入库前按密钥模式（token/私钥/连接串/长 hex）脱敏并记 `redacted` 计数；snapshot 默认不含证据原文。
- 域数据文件与证据文件权限 `0600`，目录 `0700`；备份同权限。
- 域数据目录（`~/.dsh/storages`）对节点会话只读（沙箱 + 权限）；插件不把域数据写进工作区（除 `.orchestrator/plan.md` 可选快照，v1.5 再定）。
- 会话日志仍是会话的唯一真相；编排数据是插件领域数据，不塞 session 事件。

## 13. 接口

### 13.1 agent 工具

| 工具 | 参数 | 返回 | 备注 |
| --- | --- | --- | --- |
| `orch_scan` | `{ include?, depth? }` | 工作区画像 | 只读、有界 |
| `orch_project` | `{ action:'open'\|'create'\|'attach'\|'status'\|'update', title?, brief?, settings? }` | 项目摘要 | `update` 只能改非 human-only 字段；human-only 返回 `needs-human` |
| `orch_plan` | `{ mode, basePlanVersion, nodes[], edges[] }` | `{ok, added, updated, errors[], warnings[], summary, next}` | 原子；≤`patchLimit` 节点/次；建树时可携带 `scope/readOnly/gate/checks`；批准后 merge 自动回审批（V21） |
| `orch_node` | `{ action:'get'\|'patch'\|'add-edge'\|'remove-edge'\|'artifact'\|'complete', nodeId, expectedVersion?（写操作必填）, artifact?, notes? }` | 节点+邻接+产物 | patch 限 intent/acceptance/order/artifacts；**既有节点**的 add-edge/remove-edge 与 scope/executor/gate/readOnly/checks 只能 `orch_propose`；`complete` 仅 orchestrator 叶子（必须带 `artifact`） |
| `orch_run` | `{ action:'start'\|'pause'\|'resume'\|'stop'\|'step'\|'continue' }` | 调度快照 | `stop` 等破坏性动作在工具层返回 `needs-human`（UI 才可执行） |
| `orch_status` | `{ nodeId?, depth? }` | 紧凑树/波次/就绪/阻塞/门禁/预算 | ≤1500 字 |
| `orch_impact` | `{ nodeId, change:{class, fields?} }` | 受影响节点 + 建议动作（只预演） | 不落库 |
| `orch_propose` | `{ nodeId, change:{class, patch, rationale} }` | `{proposalId, blastRadius}` | 只写 proposals/影响卡；节点会话与主 agent 都可用 |
| `orch_submit_result` | 结构化结果 schema（§8.3） | `{accepted:true}` | **仅节点会话**；宿主捕获绑定当前 attempt |

**工具面分层（宿主按 agent 注册）**：

| 会话 | 编排工具 |
| --- | --- |
| 驱动会话 | 上表除 `orch_submit_result` 外全部 |
| 节点执行/验证会话 | 只读 `orch_status`（本节点子树）/`orch_node(get)`/`orch_impact` + `orch_propose` + `orch_submit_result` |
| 节点规划会话 | 只读三件 + `orch_propose`（无 submit，因为不执行） |

工具规范：不抛异常、返回 `{ok, code, message, data}`；真实校验 `additionalProperties:false`；human-only 字段/动作一律 `needs-human`。

### 13.2 命令

- `/orch`：`status`（默认）| `plan` | `start` | `pause` | `resume` | `stop` | `continue`。
- 命令是用户输入，等价于人工动作，但仍走宿主 action 与 `expectedVersion`；agent 不能"代打"命令。
- 输出进聊天，不替代画布。

### 13.3 客户端通道（`connection.fetch`，v0.3 起不再自建 webServer 路由）

| 方法/路径（实际挂 `/api/orchestrator/...`） | 说明 |
| --- | --- |
| `GET /snapshot?sessionId=` | 项目、树、状态、运行、门禁、影响、focus、设置摘要（不含证据原文） |
| `GET /node?sessionId=&nodeId=` | 节点详情 + 邻接 + 线程 + 事件 + attempts |
| `GET /session?sessionId=&nodeId=` | 节点会话状态（存在/活跃/最后活动） |
| `POST /ensure-session` | `{sessionId,nodeId}` 懒创建（CAS），幂等 |
| `GET /scan?sessionId=` | 空态工作区画像 |
| `POST /project` | create/open/attach/detach |
| `POST /focus` | 记录会话选中节点（面板开合是客户端状态） |
| `POST /node-chat` | `{sessionId,nodeId,text,expectedVersion}` → 宿主 followup（冷则 resume） |
| `POST /node-abort` | 中止当前 turn |
| `POST /action` | `{sessionId, action, payload, actionId, expectedVersion}`：start/pause/resume/stop/continue/retry/retry-new-session/cancel/approve-plan/reject-plan/approve-gate/reject-gate/approve-proposal/reject-proposal/snooze-proposal/apply-impact/reject-impact/patch-node/reorder |
| `GET /health` | 版本与时间 |

- **鉴权**：通道自带 Host/Origin 围栏与客户端认证；额外要求启动期随机 bearer（经客户端 bootstrap 注入，不进 shell env）；每个 handler 校验 `sessionId` 所属会话 `header.cwd` realpath === `project.workspacePath`，否则 404。
- 写动作必须带 `expectedVersion`（快照版本）与 `actionId`；`actionId` 账本 ≥5000 且效果幂等。
- 错误静态化；body 上限 48KiB（快照响应 ≤200KB）。

### 13.4 事件与注入点

| 机制 | 用途 |
| --- | --- |
| `agent/created` / `agents.get()` + `agent.ctx` | 驱动会话注册工具+playbook；节点会话按 13.1 分层注册只读工具+节点上下文 section；resume 后同样触发 |
| `session/event`（`{global:true}`） | `turn/start`/`user/message`/`assistant/message` → 按 `sessionIndex` 绑定 nodeId、写线程摘要、绑 attempt |
| `agent/disposed` / 插件卸载 | 清理会话级注册；running attempt 标 `interrupted`；`ctx.effect` 里注册的监听器双路径清理 |
| `systemPrompt.section` / `.context` | 驱动会话：playbook + 项目摘要/待办提议（≤1500 字）；节点会话：节点 intent/验收/scope/上游产物摘录（随版本刷新） |
| `agent.followup` | 通知并唤醒主 agent / 节点会话 |
| `agent.ctx.tools.restrict({allow})` | preset 白名单（宿主强制） |
| `tools.guard` | 仅拒绝已知危险工具与结构化参数（`run_in_background`）；不当安全边界 |
| `sandbox` / `setSandboxMode` | 节点会话 `workspace-write`；checks 同沙箱 |
| `tokenMeter.measure` | attempt 结束结算 token，写入 Project.budgetUsed |
| `agentOptions.env` / checks 子进程 env | 节点会话与 checks 的环境白名单（不注入 `DSH_HOME`/`DSH_SESSION_ID`/provider key），P0-4 验证 |
| `ctx.interval` | 调度 tick、租约心跳、通知聚合（effect 内，卸载清理） |
| `uiConversation.events.register` | 影响卡自定义消息节点（客户端） |
| `connection.fetch.register` | 客户端通道（§13.3） |

### 13.5 preset 与工具守卫（宿主强制）

| preset | 用途 | 工具面 |
| --- | --- | --- |
| `orchestrator-worker` | 实现类执行会话 | fs 读写/edit/applyPatch + fs-search + bash + 只读编排工具 + `orch_propose` + `orch_submit_result`；禁委托/调度/消息/呈现/`run_in_background` |
| `orchestrator-verifier` | 验证会话 | 只读 fs + fs-search + 只读编排工具 + `orch_propose` + `orch_submit_result`（findings 走同一工具）；禁写/命令 |
| `orchestrator-planner` | 容器规划讨论 | 只读 fs + fs-search + 只读编排工具 + `orch_propose`；禁写/命令/委托 |

- 白名单用 `agent.ctx.tools.restrict({allow})`；`tools.guard` 只对显式已知 preset 生效、未知返回不拦截（避免误伤其它插件）。
- 节点会话创建后立即 `setSandboxMode('workspace-write')`；preset 组合由 `setup` 里 `agentPresets.mount` 完成（不能只写 `meta.agentPreset`）。
- `run_in_background` 由 guard 按结构化参数拒绝；重载时按 owner 枚举 kill 残留 job。

### 13.6 权限与安全基线

- **人工专属动作**：计划审批、门禁批准、影响传播批准、停止/取消项目、修改 human-only 设置、checks 修改——只能走带 bearer 的客户端通道；工具/命令/agent 一律 `needs-human`。
- **威胁模型**：worker 可被 prompt injection 驱动，且能用 bash 访问本机；因此"HTTP=用户"不成立。防线 = bearer（不在 env）+ 沙箱 + human-only 字段 + 渲染禁 innerHTML + 基线证据。
- **工作区边界**：所有路径在会话工作区内；域数据/备份/凭据目录对节点会话不可写（域数据文件 0600、目录 0700）；artifact 落盘只接受相对名且前缀 `.orchestrator/`。
- **env 白名单**：节点会话与 checks 只拿最小环境，不注入 `DSH_HOME`/`DSH_SESSION_ID`/provider key。
- **证据可信度**：超出 scope 的改动不自动判违规（并发 worker 可能造成），先记 `foreignChanges` 并提示门禁；明确归属的越界才 `blocked(scope-violation)`。

## 14. 与其他插件/能力的边界

- **code-review**：在 turn 结束时派只读审查子代理。P0 必须确认它对宿主 `startActivation`/子会话是否触发；若会，按 preset 把节点会话（worker/verifier/planner）排除，否则每个 attempt 成本翻倍。
- **bug-workflow / mr-loop / dev-dock**：互不依赖；本插件路由统一挂 `/api/orchestrator/*`，与 bug-workflow 的 `/bug-workflow/*` 不冲突。
- **agentTeams**：v1 不用；节点 id 与团队任务不映射。
- **workflow / goals / ralph**：v1 不用；v1.5 研究用 goals 做无人值守续跑（后台会话）。
- **子代理容量**：本机运行实例 `maxActiveSubagents=20`（不是 8）；`maxWorkers=min(3, 容量-2)`。空闲节点会话不计入容量，被唤醒的会话计入；与 code-review 共用容量时先保编排台的执行。
- **storage-json**：域数据是单文件全量重写，`attempts/threads` 必须有界（12.1），否则 200 节点项目会写放大；P5 做一次 200 节点存储压测。
- **插件卸载**：不删会话与域数据；重载后按 `sessionIndex` 对账恢复；监听器/定时器在 `ctx.effect` 内清理，避免重复注册。
- **多窗口/多会话**：同一项目允许被多个会话打开，但只有持有驱动租约的会话能执行写动作；其它会话只读并显示「另一会话正在驱动」。

## 15. 分期与验收

### 15.1 P0 探针（先验证，再开工；全过才进 P1）

| 顺序 | 探针 | 验什么 | 失败退路 |
| --- | --- | --- | --- |
| P0-1 | **节点会话全链路** | 创建一次（`startActivation` continuable 或 `agents.create`+preset mount）→ 面板内嵌 → 发消息 → 中止 → 二次 followup（热）→ 冷 `resume` 后 followup → 会话列表可见 | 退化为"每 attempt 新建会话 + 对话只读回看"，D1 改 b |
| P0-2 | **composer chain** | active view=orchestrator 时接管 composer 返回 null；切回对话恢复 | 保留宿主 composer 但禁用+画布下移 |
| P0-3 | **connection.fetch 鉴权边界** | 本机 `curl` 无 bearer/无客户端认证必须被拒；`/api/orchestrator/*` 可达；body 限额生效 | 自建 webServer + 全量自校验（安全项自实现） |
| P0-4 | **沙箱、env 与守卫** | 节点会话 `setSandboxMode('workspace-write')` 后写 `~/.dsh`、`.git/config`、工作区外文件被拒；`env \| grep DSH_` 为空；`run_in_background` 被 guard 拒绝 | env 机制不可行则降级「仅 checks 净化」+ UI 明示；沙箱不可行则独立 OS 用户/容器（或降级并明示风险） |
| P0-5 | **容量与成本** | 读运行实例 `maxActiveSubagents`（20）；`TokenMeter` 能按 attempt 读数；code-review 是否对子会话触发 | token 预算降级为软上限 + 提示 |
| P0-6 | **基线证据** | 私有 index 快照 + 5 种绕过（symlink/已脏/ignore/.git config/工作区外）各有回归；并发 worker 下 foreignChange 可识别 | 退化为 scope 交集 + 人工抽查，UI 明示证据可信度 |
| P0-7 | **画布性能与契约** | 200 卡片全量渲染 + 自适应量高收敛；平移缩放 60fps；`data-*` 三轴可断言；theme token 映射 | 视口裁剪；节点上限 100 |

> 探针合并执行（P0-1 与 P0-2/P0-3 同一会话内串起来），产出 `docs/superpowers/spikes/…` 报告；任一失败必须在实施计划里改路线。

### 15.2 阶段计划

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 | 上述 7 个探针 | 报告落地；路线确认 |
| P1 画布与视图 | domain/store/graph、画布骨架（布局/自适应高/胶囊/六态/关系/小地图/图例/菜单/快捷键）、面板壳（宿主 Chat 占位）、DX/AX 钩子、i18n | **除 §11.15 白名单与 6 处已批准修正外**与原型 v0.3 逐像素一致；`data-*` 三轴断言；动作行与胶囊不被裁；12 处旧缺陷回归全绿 |
| P2 拆解闭环 | `orch_scan`/`orch_project`/`orch_plan`/`orch_status`、playbook、V1–V21、`sys:plan-approval-v*` 与详情审批（checks/scope/首波）、`/orch` | 一句话需求产出通过校验的计划；审批页内容齐全；批准后全部叶子 `ready`、由 §8.1 门控派发 |
| P3 自动执行 | 调度器（租约/容量/冲突）、节点会话创建与复用、attempt/turn 绑定、`orch_submit_result`、基线证据、沙箱 checks、重试/修复矩阵、预算与 token、暂停/停止/恢复、通知 outbox | 演示项目 3 波跑完；同会话重试生效；越界被拦；预算（含 token）超限停下 |
| P4 对话与影响 | 面板内嵌节点会话（发送/中止/历史）、`orch_propose`、提议生命周期、影响卡、审批动作、传播执行、门禁 | 节点会话改验收 → 影响卡 → 批准后重排；拒绝理由回话；snooze 不丢 |
| P5 韧性 | 重载恢复、冷会话 resume、驱动租约、多项目、200 节点存储压测、端到端验收项目 | 杀进程/重载后继续；仓库内新插件端到端交付 |
| P6 打磨 | 图标、README、DETAIL、locale、AX 审计（11.17）、对比度/深色验收、性能、发布 | 安装可见；无障碍与自动化断言全绿 |

### 15.3 v1 端到端验收场景

在本仓库新增一个小插件（示例：`@liyuera/dsh-quick-notes`）作为真实需求：

1. 一句话需求 → 计划含 project/phase/stream/module/feature/spec/contract/api/page/test/review/gate，画布完整展开。
2. 选中 `sys:plan-approval-v*` → 详情看到 checks 全量、scope 冲突、首波节点 → 批准 → 全自动执行 → 全部叶子 `done`。
3. 卡片信息完整可读；容器悬停/选中时「对话/详情」可见；折叠胶囊完整；选中关系正确（上游实线/下游双线/兄弟虚线），空白点击清干净。
4. 双击运行中节点 → 面板打开该节点会话（宿主 Chat 渲染）→ 发消息有回复 → 停止按钮可中断 → 重试复用同会话。
5. 节点会话里改一条验收 → 影响卡 → 走影响审批 → 批准后下游 stale 重排；「稍后」后待办仍在。
6. 安全回归：worker 用 bash `curl` 调 action 路由必须失败；worker 写 `~/.dsh`/`.git/config` 必须被沙箱拒；checks 修改只能人工。
7. 产物 `link:` 安装并在新会话显示；全部叶子写范围无越界（`violations` 为空；`foreignChanges` 为空或每条都有事件解释）。
8. 执行中重载插件 → 自动恢复为 interrupted 等人工确认；重启应用 → 打开驱动会话后项目继续、画布状态恢复。
9. 暂停/停止/等待继续/预算耗尽/熔断 五种停机都按设计通知并可在 UI 恢复。
10. 全程 `orch_status` ≤1500 字；token 用量与 attempts 在项目卡可见。
11. 200 节点压测：首屏 <300ms、平移缩放无明显掉帧、`window.orchestratorUI.select()` 可脚本驱动。

## 16. 风险与未决

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 节点会话无法二次 followup / 冷 resume 失败 | D1 退化 | P0-1 先验；退路每 attempt 新会话 + 对话只读回看 |
| 面板内嵌宿主 Chat 三前提缺一 | 空白/串台 | P0-1 按 retain + session 子槽 + 固定 views 完整形态验；退路只读回看 + 跳转 |
| connection.fetch 鉴权被绕过 | worker 自批 | P0-3 用 curl 实测；再加 bearer/归属校验；最坏降级自建通道并全量自校验 |
| 沙箱继承失败 | 越权写盘 | P0-4；失败则独立 OS 用户/容器，或降级功能并明示 |
| 基线证据误判/漏判 | 错误 blocked 或漏报 | scope 交集 + hash + foreignChange 分级；P0-6 五类绕过回归；UI 展示证据可信度 |
| token 预算估不准 | 过早/过晚停机 | attempt 前 reserve + 结束结算；先宽松校准两周再收紧 |
| 节点会话/attempt 数量膨胀 | 存储与列表噪音 | 懒创建 + `[节点]` 前缀 + attempts 有界 + 会话不删只 orphan |
| 200 节点 DOM/量高卡顿 | 画布不可用 | 有界量高轮次 + 视口裁剪 + 节点上限 |
| 并发 worker 证据归属 | 越界误判 | 明确归属才 violations，其余 foreignChanges + 门禁；后续可加 per-worker 写前快照 |
| code-review 叠加 | 成本翻倍 | P0-5 确认；preset 排除 |
| 驱动会话关闭无法继续 | 长任务中断 | 明示约束；v1.5 后台 agent |
| 冻结 UI 与新增面冲突 | 体验割裂 | 新增面只准在既有位置（详情动作区/toast/中央卡片），§11.15 白名单 |
| 计划审批页过长 | 用户盲批 | 折叠 + 首波摘要 + 危险操作逐条勾选；不追求一屏看完 |

**未决问题（评审时定）**

1. `release` 节点 v1 纯人工记录，还是接 dev-dock/终端？（建议纯人工）
2. 容器规划会话 v1 是否只读？（建议只读：能读图/产物/给建议，v1.5 再给子树 `orch_plan`）
3. 计划审批粒度：整树 vs 分阶段？（建议 v1 整树 + `phase` 门禁）
4. 工作区是否落 `.orchestrator/plan.md` 人类可读快照？（建议 v1.5）
5. 节点会话在会话列表的呈现：`[节点]` 前缀够不够，是否需要真实分组？（P0 看宿主能力）
6. 手动节点位置与视口是否入库跨会话共享？（v0.3 按会话 localStorage，v1.5 评估）
7. 窄窗口（<1024/<760）断点与面板覆盖式是否可接受？（§11.2 给了默认值）
8. `test`（无会话）对话禁用、`human` 门禁落回主 agent——不对称是否可接受？
9. 低缩放（k<0.5）信息降级阈值与"缩放条被面板遮挡"的取舍？（v1 接受，v1.5 再动）
10. checks 在审批页全量展示会让计划很长——是否默认折叠到「危险命令/首波」？（建议折叠其余）
11. 每 attempt 的 token 预估校准周期与超限策略（硬停 vs 只告警）？
