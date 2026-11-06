# @liyuera/dsh-bug-workflow

DeepSeek Harness（DSH）的 Bug 工作流看板，**P1 骨架版本 0.0.1**。右栏打开「Bug 看板」tab，即可用「假引擎」把一张工单从 `inbox` 一路驱动到 `done`：状态机、storageDomain 持久化、工作区设置、同源 HTTP 路由与安全守卫都是真实实现；平台登录、分析/修复子代理、GitLab MR 与 review 循环留给 P2–P5。

> 当前为 `private` 包，尚未发布 npm；P1 用 `link:` 本地安装验收。验收记录见 [`docs/superpowers/spikes/2026-11-07-p1-findings.md`](../docs/superpowers/spikes/2026-11-07-p1-findings.md)。

## 安装

```sh
# 当前：从本地 checkout 安装（路径替换为仓库内 bug-workflow 目录）
dsh plugin --profile desktop add link:/path/to/deepseek-harness-plugin/bug-workflow

# P2 发布 npm 后
dsh plugin --profile desktop add @liyuera/dsh-bug-workflow
```

- `desktop` 是桌面应用独占的 profile；源码启动的 `pnpm dsh web` 使用 `web`。GUI 里也可在 **设置 → 插件 → 添加插件** 完成。
- 安装/重装后重载 profile：新装 client 半边通常需要重启桌面应用；开发期只改宿主半边时，可对 bundle 执行「移除 → 重装」热重载（P1 验收即用此法，数据不丢）。client 代码更新后还需刷新页面。
- P1 只在 **DSH 0.2.2-rc.1**（desktop profile）上验收；`@deepseek-ai/dsh-storage-domain` / `zod` 声明为 peerDependencies（由宿主提供），但当前版本范围是 `"*"`，尚未锁到验证过的版本——P2 发布前必须收窄（见「P2 打包与交接」）。
- 卸载：`dsh plugin --profile desktop remove @liyuera/dsh-bug-workflow`。卸载不删除工单数据。

## 入口

- 右栏 guide 卡片 **「Bug 看板」** → 打开 `sidebar.right.pane.tab` 中的看板 tab（`kind: bug-board`）。
- 看板按当前会话的工作区读取设置；会话没有工作区目录时显示「未绑定工作区」，列表/详情仍可读，写操作与演示建单禁用。
- P1 只做右栏 tab（P0 已证实第三方可占座），未实现会话标题栏抽屉兜底按钮。

## P1 已实现

| 能力 | 说明 |
| --- | --- |
| 看板列表 | 工作区名/绑定状态、状态与类型筛选、手动输入编号建单、演示建单、刷新、3 秒轮询；`done` 工单从进行中列表隐藏 |
| 工单详情 | 工单字段；方案卡（摘要/根因/方案/改动文件/风险/测试建议，通过/驳回）；修复与测试区；MR/Review 卡（轮次、阻塞项、结论）；最近 20 条时间线 |
| 动作按钮 | 由 client 内 `ACTION_BY_STATE` 字面量按 `workflow` 渲染（**不是**由宿主 `canApply` 派生）；全部二次确认（`window.confirm`，缺失时用内联确认）；POST 带唯一 `actionId`，宿主幂等重放 |
| 状态机 | 12 个状态、16 个动作（含 `block`/`retry`/`reject_plan`）；review 变更轮次上限 3 轮，第 4 次请求由宿主转为 `blocked` |
| 持久化 | storageDomain domain `bug_workflow` v1：`tickets` / `settings` / `meta` 三表；写前用真 zod schema 校验；`meta` 是 actionId 幂等账本（最多 500 条） |
| 设置面板 | 同页面 overlay，9 个字段，按工作区 cwd 保存；`Esc` 关闭、焦点返回、未保存修改丢弃 |
| 安全守卫 | 仅本机回环 socket + `Host` 白名单；POST 仅 `application/json`；`Origin` 必须同源；64 KiB / 10 s 限制；错误消息裁剪 |
| 测试 | `node --test bug-workflow/test/*.test.js`，101 个用例全绿 |

> **动作映射的维护约束（P2 必读）**：按钮只来自 `bug-workflow/client.js` 的 `ACTION_BY_STATE` 字面量（按 `workflow` 的静态列表）；宿主 `canApply` 是转移的权威，但两者是**两份独立数据**。`test/client-action-map.test.js` 只做单向校验（map → host：每个映射动作在该状态必须被 `canApply` 接受），**不校验 host → map**，所以新增宿主动作不会自动出现按钮。P2 每加/改一个动作，必须同步更新该映射并运行 `node --test bug-workflow/test/*.test.js`。已知两处偏差：① `mr_open` 且 `mr.rounds = 3` 时看板仍显示 `review_requests_changes`，点击后被宿主拒绝（409 `review-rounds-exhausted` → 工单进入 `blocked`）；② 宿主支持 `block`（任意非终态可执行），但 P1 看板没有「阻塞」按钮。

P1 的「假引擎」含义：分析完成、修复完成、建 MR、review 结论、合并等都由看板按钮手工 POST 假 payload 驱动，不会调用平台、GitLab 或子代理。

## P2–P5 待办

| 期 | 内容 |
| --- | --- |
| P2 | 平台接入：登录/验证码、字典、我的工单同步、详情、手动添加、状态写回（不可用时降级） |
| P3 | 分析子代理 + 真实方案审核/驳回重跑 |
| P4 | 修复子代理 + worktree、lint/test、人工测试与视觉留证 |
| P5 | GitLab 交付：分支、MR 创建、review 轮询、回修、合并检测、完成归档、状态写回 |

> **P2 打包与交接（P1 遗留语义，勿当成已实现契约）**：
> - **打包**：`package.json` 的 peerDependencies（`@deepseek-ai/dsh-storage-domain`、`zod`）都是 `"*"`，且**没有 `license` 字段**（`private: true`）。P2 发布前必须把 peer 收窄到实际验证过的范围、补 `license`，并按 `files` 清单做一次 `npm pack --dry-run` 检查（`locale/*.json` 目录尚未创建，导出仍写在那里）。
> - **`review_fix_done` 的 `verdict`**：只把 `workflow` 推回 `mr_open`，`mr.verdict` 保持 `changes`，直到 `review_pass` 才变 `pass`；P2/P5 若用 `verdict` 判定「已修复 / 可合并」，必须先定义重置语义（或改用逐轮记录）。
> - **`fixes` payload**：见「已知限制」——宿主只校验 `z.array(z.unknown())`，元素形状是 P1 客户端约定，不是 host-enforced contract。
> - **设置「必填」**：`branchUser` / `commitType` 的必填校验只在 `client.js`（`validateSettings`）；宿主 `settingsSchema` 为 `z.string().default(...)`，`POST /api/settings` 会接受空串。P2 若要求服务端保证，需在 host 补校验与测试。

## 设置字段

看板内「设置」保存，按会话工作区 cwd 存储。

| 字段 | 界面标签 | 默认 | 用途 |
| --- | --- | --- | --- |
| `platformProjectCode` | 平台项目编码 | 空 | P2 平台项目标识，如 `YGFNXDJRFWDJSYJJYY` |
| `gitlabProjectPath` | GitLab 项目路径 | 空 | `group/project`，P5 建分支/MR 用；留空表示未配置 |
| `branchUser` | 个人分支后缀 | `ly` | 必填；个人分支名后缀 |
| `gitlabReviewer` | GitLab Reviewer | 空 | P5 MR reviewer 用户名，可留空 |
| `commitType` | 提交信息前缀 | `fix` | 必填；提交信息 `<commitType>: 【jira单号】…` |
| `lintCommand` | Lint 命令 | 空 | P4 提交前检查 |
| `testCommand` | 测试命令 | 空 | P4 提交前检查 |
| `devCommand` | 启动命令 | 空 | P4 预览/视觉留证 |
| `previewUrl` | 预览地址 | 空 | P4 视觉留证 |

> P1 live 验收时把本仓库工作区的 `gitlabProjectPath` 填成了 `wisdom-financial-service-platform/wisdom-financial-credit-platform-web`，只是**演示配置**，不代表真实项目绑定；`branchUser=ly`、`commitType=fix` 为默认值。

## HTTP 接口

同源、仅 loopback，客户端轮询 `snapshot`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/bug-workflow/api/health` | `{ ok, domainOpenedAt, tickets }`；存储不可用时 500/503 带 `stage` |
| GET | `/bug-workflow/api/snapshot?sessionId=` | `{ ok, workspace, settings, tickets, serverTime }` |
| POST | `/bug-workflow/api/action` | `{ sessionId, actionId, code, action, payload? }` → `{ ok, ticket }` 或 `{ ok:false, code, message }` |
| POST | `/bug-workflow/api/settings` | `{ sessionId, settings }` → `{ ok, settings }` |

错误映射：参数/设置校验 400，`action-id-reused` / `invalid-transition` / `duplicate-code` / review 轮次耗尽 409，工单不存在 404，内部错误 500。`review_requests_changes` 第 4 次返回 409 `review-rounds-exhausted`，同时工单进入 `blocked`，`retry` 回到 `mr_open`。

## 数据位置

- `~/.dsh/storages/bug_workflow.json`（storageDomain 的 JSON 后端，domain `bug_workflow` v1）。
- `tickets`：**profile 全局**工单（P1 未按工作区隔离）；`settings`：按工作区 cwd 为 key；`meta`：domain 标记 + actionId 幂等账本。
- 删除该文件会清空工单/设置/幂等账本；P1 没有 UI 归档或清理入口，卸载插件不会删数据。

## 安全边界

- 路由只接受**本机回环**连接（`socket.remoteAddress` 校验 + `Host` 文本白名单，DNS rebinding 不可绕过）。
- POST 必须 `Content-Type: application/json`（跨站表单 `text/plain` 先 415）；带浏览器 `Origin` 时必须与请求 Host 同源，否则 403。
- 请求体上限 64 KiB、读取超时 10 s；错误响应只带裁剪后的 message，完整错误进宿主日志。
- **P1 没有鉴权，也不使用任何平台/GitLab 凭据**；信任边界是「同机同用户」。任何本机进程都能调这些接口，这是设计取舍，不是遗漏。
- P2+ 的密码/token 必须走 `ctx.credentials`，不落插件配置、不落 session log；工单/review 文本按不可信数据处理。

## 已知限制

- **假引擎**：动作是手工假 payload，不触发平台、GitLab、子代理或 worktree；P1 没有真实写回。
- **工单是 profile 全局的**：设置按工作区隔离，但工单不按工作区隔离；P2 平台同步时要决定 workspace 归属与合并策略。
- **`done` 工单不在列表显示**：仍保存在 `tickets` 表，没有归档视图，计数只算进行中工单。
- **未接 locale**：文案硬编码中文，`locale/*.json` 尚未提供（P2 再接 `ctx.locale`）。
- **视觉/交互验收未完成**：右栏 tab 的 guide/渲染、300–600px 窄宽布局、Electron 下 `window.confirm`/焦点行为未在本轮目视验证；client Slots inspect 在验收时 10 s 超时。详见 findings。
- **app 重启未验证**：只验证了宿主半边「移除 → 重装」热重载后数据保留。
- **`workspace.configured` 只表示会话解析到了目录**，不表示已保存设置；P2 若要区分「已绑定」需另加状态。
- **无 GitLab/平台调用**：`plan` / `mr` 有宿主 zod schema，`fixes` 只校验为数组（`z.array(z.unknown())`）——元素形状只是 P1 看板客户端的约定，不是宿主强制契约；P2–P5 adapter 负责映射真实 API，并在接修复子代理前补 `fixes` 的 host schema。

## 开发

无构建步骤：host 是纯 ESM JavaScript，client 是自包含 React bundle（只 `require('react')`，由宿主 module table 提供）。

```sh
# 全部单元测试（在仓库根目录执行）
node --test bug-workflow/test/*.test.js

# 语法/静态检查
node --check bug-workflow/index.js
node --check bug-workflow/client.js
node --check bug-workflow/src/host/routes.js

# live 冒烟（端口取当前 DSH Web GUI，示例 49254）
curl -s http://127.0.0.1:49254/bug-workflow/api/health
curl -s 'http://127.0.0.1:49254/bug-workflow/api/snapshot?sessionId=<session-id>'
```

| 文件 | 作用 |
| --- | --- |
| `index.js` | 宿主入口：fallback 路由 → 打开 domain/store → 挂真实路由，fiber 释放时关 domain |
| `src/host/protocol.js` | 状态、动作、上限常量 |
| `src/host/state-machine.js` | 纯状态机 `initialTicket/canApply/apply`，无 I/O |
| `src/host/domain.js` | zod schema、`bug_workflow` domain 声明与打开/关闭 |
| `src/host/store.js` | TicketStore：工单 CRUD、动作、设置、actionId 幂等账本 |
| `src/host/routes.js` | 四个路由、安全守卫、错误映射 |
| `src/host/workspace.js` | sessionId → 工作区 cwd |
| `client.js` | 右栏 tab/guide 注册与看板 UI（列表/详情/动作/设置） |
| `test/` | `node:test` 单元测试 |

## 许可

内部私有包（`private: true`），仅用于本人 DSH profile；未发布 npm、未授予再分发许可。注意：`package.json` **当前没有 `license` 字段**（不是 `UNLICENSED` 声明），P2 发布前应补上（见「P2 打包与交接」）。
