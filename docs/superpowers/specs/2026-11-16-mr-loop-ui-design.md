# mr-loop UI 设计稿 v2（2026-11-16）

> 状态：**设计已定稿，未实现**（用户确认：会话头 chip 主入口 / v1 带「全部会话」/ 问题行展开看建议·代码·评论原文，默认收起）。
> 视觉稿：`docs/superpowers/mocks/mr-loop-ui.html`（直接浏览器打开；`document.body.classList.add('dark')` 切暗色）
> 截图：`specs/assets/mr-loop-ui-light.jpg`、`specs/assets/mr-loop-ui-dark.jpg`

## 一、要回答的问题

1. 这个会话绑了哪些 MR？（本会话）
2. 全部会话里我跟踪过哪些 MR、现在都什么状态？（跨会话）
3. 每个 MR 卡在哪一项？出现了哪些问题？
4. **哪些修了、哪些没修、没修的用了什么指令**（`#ai-waive` / `#ai-skip` / `#ai-wontfix` + reason + 评论原文与链接）。
5. 每个问题能展开看全：建议、代码片段、评论原文（默认收起）。

## 二、入口（已定）

| 层级 | 位置 | 插槽 | 说明 |
| --- | --- | --- | --- |
| 主入口 | 会话头 chip | `conversation.session.header.actions` | 常驻；显示 `!241 · 第 1 轮 / 1 待处理 / !238 · 可合 / [看板]` |
| 看板 | **右上角 dialog（无遮罩）** | `shell.overlay` 挂载 + `react-dom` portal 到 `document.body` | 宽 420px、距顶 64px 距右 24px、min-height 300px / max-height `100vh-88px`、内部滚动；`本会话 / 全部 / 已合并` 三段；点 chip 打开；只能点右上角 ✕ 关闭（Esc 同效） |
| 每轮报告 | 工具结果内联卡 | `tool.call.toolview`（keyed `mr_bind`/`mr_status`/`mr_review`） | 报告就地变卡，不跳转 |
| 后续 | 右侧页签 / 左侧全局面板 | `sidebar.right.pane.tab` / `sidebar.panellist` | v2 再评估，不阻塞 v1 |

不用 `conversation.input.left`（输入控件语义不合）。

## 三、信息架构（v1 范围）

```
会话头 chip ─┬─ [看板] ──> 抽屉
             │              ├─ 分段：本会话 / 全部会话 / 已合并
             │              ├─ MR 卡 ×N
             │              │   ├─ 头：!241 + 归属（本会话 / 会话：xxx） + 第 N 轮 + 状态徽标
             │              │   ├─ 门禁条：评审 · 敏感 · 必过 · 流水线
             │              │   ├─ 合并条：⛔ 差 N 项：原因 · [打开 MR ↗]
             │              │   ├─ 问题行（默认收起）
             │              │   │   ├─ 收起：FID · 级别 · 类型 / 文件:行 / 问题一句话 / 状态 / [展开 ▾]
             │              │   │   └─ 展开：指令行 + 建议 + 代码片段 + 评论原文（作者/时间/评论号）
             │              │   └─ 脚：sha · 相对时间 · [复制指令] [详情]
             │              └─ 「显示 3 / 5 · 滚动加载更多」
             └─ 空态：/mr <链接>
```

问题状态（四态 + 两个指令态）：

| 状态 | 颜色 | 触发 |
| --- | --- | --- |
| `未处理 open` | warn | 评审 note 里有、无指令、未消失 |
| `已修 fixed` | success | 后续轮次评审里 FID 消失（带轮次标记） |
| `已豁免 waived` | idle | 有 `#ai-waive` 指令 |
| `不适用 skip` | idle | 有 `#ai-skip` 指令 |
| `不修 wontfix` | idle | 有 `#ai-wontfix` 指令 |
| `进行中 fixing` | brand | 主 agent 已派发修复（v3，可选） |

## 四、视觉规格（只用主题 token）

| 元素 | 规格 |
| --- | --- |
| Dialog | `bg-overlay`，宽 420px，top 64 / right 24，圆角 12，阴影 `0 18px 48px rgba(0,0,0,.18)`；**无遮罩、不点外部关闭**；✕ 关闭 + Esc；内容超过最大高度时列表内部滚动 |
| MR 卡 | `bg-layer-1` + 1px `border-l1`，圆角 12，卡间距 10，卡内边距 12 |
| 嵌套块（门禁 chip、详情块） | `bg-layer-2`，圆角 8–9 |
| 文字 | 主 `label-primary`，次 `label-secondary`；FID/路径/代码用等宽 10.5–11px |
| 语义色 | 通过 `state-success-primary`，待处理 `state-warn-primary`，阻止 `state-error-primary`，完成/豁免 `state-idle-primary`，强调 `brand-primary` |
| 徽标 | 20px 圆角胶囊，11px 字；状态徽标右对齐 |
| 展开态 | 行底色 `brand` 3% 透明；详情块内三段式 `建议 / 代码 / 评论原文`，标签列 54px |
| 代码片段 | 等宽 10.5，`bg-layer-1`，1px `border-l1`，圆角 6，`pre-wrap` |
| 评论原文 | 左侧 2px `border-l2` 竖线引用，正文 + 「作者 · 时间 · 评论 #id」小字 |
| 动效 | 只做抽屉滑入 + chip 计数变化高亮（≤300ms），问题展开不做动画（瞬间） |

暗色自动跟随（见截图）。

## 五、交互细节

- **chip**：最多显示 2 个 MR + `+N`；`待处理` 徽标用 warn 色并显示数量；点击任意处打开抽屉；键盘可聚焦（Enter 打开）。
- **Dialog**：默认「全部」；「本会话」在无活绑定时为空，自动回退到「全部」并给跳转按钮。
- **问题行**：默认收起；点「展开 ▾」就地展开，同一 MR 内可多行同时展开；「收起 ▴」折叠。
- **复制指令**：把该 MR 的待处理 FID 生成为 `#ai-waive <FID> reason=` 草稿并复制（主 agent 用 `mr_waive` 走确认流程）。
- **打开 MR**：新浏览器标签打开 GitLab。
- **刷新**：抽屉右上角 ↻ 立即强刷；列表 30s 轮询。
- **错误**：保留上次数据 + 顶部 warn 条「拉取失败：token 无权限（403）· 数据可能已过期 [重试]」。
- **空态**：图标 + `还没有绑定 MR` + `/mr <链接>`。

## 六、数据契约（只读）

`GET /mr-loop/ui/state?scope=session|all[&sessionId=…]`（host 聚合；30s 缓存；token 不出宿主）：

```jsonc
{
  "scope": "all",
  "updatedAt": "2026-11-16T12:40:00Z",
  "mrs": [{
    "projectPath": "group/project",
    "iid": 241,
    "webUrl": "https://git…/-/merge_requests/241",
    "sourceBranch": "feat-…", "targetBranch": "feature-…",
    "state": "opened", "sha": "8a282d15…", "round": 1,
    "session": { "id": "session-…", "title": "财务服务平台 · 报告管理", "isCurrent": true },
    "workspace": "wisdom-financial-credit-platform-web",
    "review": { "verdict": "pass", "historicalUnresolved": 0, "verifiedFixed": null, "newThisRound": 1 },
    "gates": { "sensitive": "pass", "mandatory": null },
    "merge": { "mergeable": false, "missing": ["评审有 1 处需要关注的问题…"],
               "pipeline": { "id": 7298, "status": "success" } },
    "problems": [{
      "fid": "b71c9d02", "level": "低", "type": "非阻塞建议",
      "file": "src/types/BaoGaoGuanLi.ts", "line": 12,
      "problem": "…", "suggestion": "…", "snippet": "export interface …",
      "status": "waived",
      "instruction": { "kind": "waive", "reason": "后端 DTO 已确认，本单不改",
                       "noteId": 75200, "url": "…/notes/75200", "author": "李昱",
                       "createdAt": "2026-11-16T15:02:00+05:30", "body": "#ai-waive b71c9d02 reason=…" },
      "rounds": [1, 2]
    }],
    "rounds": [{ "n": 1, "sha": "8a282d15", "verdict": "pass", "at": "…", "fixedCount": 0, "waivedCount": 1 }]
  }]
}
```

字段缺失 → 显示灰点（未知），不猜。

## 七、为支持这个 UI，数据层要补的东西

| 缺口 | 补法 |
| --- | --- |
| 跨会话需要「这个 MR 属于哪个会话」 | 账本 `binding` 增加 `sessionId`、`sessionTitle`、`workspace`（绑定/刷新时写入）；跨会话列表 = 所有账本 ∪ 内存绑定，按 `updatedAt` 排序 |
| 「评论原文」展示需要指令 note 正文 | `directives[]` 增加 `body`（整条评论原文，截断 500 字）与 `noteUrl` |
| 展开需要「代码片段」 | 评审 note 的 findings JSON 已含 `source_snippet`，解析进 finding（缺省不显示该段） |
| 「已修」判定 | 用轮次对比：上一轮有该 FID、本轮没有 → `fixed`，记 `fixedAtRound` |
| 会话标题 | host 从 session 服务取标题；取不到显示会话 id 前 8 位 |

## 八、分期

| 期 | 内容 |
| --- | --- |
| v1 | 会话头 chip + 抽屉（本会话/全部会话/已合并）+ 工具卡 + 问题行展开（建议/代码/评论原文） |
| v2 | 问题详情页（轮次时间线、代码 diff 定位）、右侧页签、跨工作区筛选 |
| v3 | 写操作：`[豁免]` → `mr_waive` 草稿 → 「可以 / 自定义」→ 回帖；`[复制指令]` 升级为直接发评论 |

## 九、风险与约束

1. 会话头空间窄：chip 只放数量与状态，溢出 `+N`。
2. Dialog 挂到 `document.body`，避免 `shell.overlay` 的点击穿透层拦截交互。
2. 跨会话列表可能很长：默认收起已合并，滚动加载。
3. 数据延迟 ≤30s；打开抽屉强刷。
4. 状态口径与 CLI 报告一致（共用 `reviewTodo`），UI 不自行推断。
5. 不写 MR、不改会话事件流。
