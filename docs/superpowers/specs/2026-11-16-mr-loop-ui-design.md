# mr-loop UI 设计稿 v2（2026-11-16）

> 状态：**已实现**（`lib/client.js` + `test/client.test.js`；用户确认：会话头 chip 主入口 / v1 带「全部会话」/ 问题行展开看建议·代码·评论原文，默认收起）。
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

## 十、主题 token 校正（2026-11-17，v0.2.2）

**问题**：真机（DSH 0.2.2 桌面端，light 主题）上面板看起来「又旧又平」，和验收截图（`scripts/ui-harness.html` + Chromium 截图）差很多。

**根因**：验收台的 `:root` token 是拍脑袋写的，和真实主题不一致。从应用包（`app.asar`）里解析出的真实映射：

| token | 浅色（真机） | 深色（真机） |
| --- | --- | --- |
| `--dsw-alias-bg-base` | `#fff` | `#151517` |
| `--dsw-alias-bg-layer-1` | `#fff` | `#232324` |
| `--dsw-alias-bg-layer-2` | **`#fff`** | `#2c2c2e` |
| `--dsw-alias-bg-overlay` | `#e9ecf2` | `#61666b` |
| `--dsw-alias-border-l1` | `rgba(0,0,0,.04)` | `rgba(255,255,255,.06)` |
| `--dsw-alias-border-l2` | `rgba(0,0,0,.1)` | `rgba(255,255,255,.12)` |
| `--dsw-alias-brand-primary` | `#0f1115`（= label-primary，**不是蓝**） | `#f9fafb` |
| `--dsw-alias-label-primary` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-label-secondary` | `#61666b` | `#cfd3d6` |
| `--dsw-alias-label-tertiary` | `#81858c` | `#adb2b8` |
| `--dsw-alias-state-success-primary` | `#22c55e` | `#22c55e` |
| `--dsw-alias-state-warn-primary` | `#f59e0b` | `#f59e0b` |
| `--dsw-alias-state-error-primary` | `#f25a5a` | `#ec1313` |
| `--dsw-alias-state-idle-primary` | `#d4d4d4` | `#545557` |
| `--dsw-alias-state-business-primary` | `#4176e6` | `#7aaaff` |

四个直接后果：

1. `bg-layer-2` 在浅色下就是**纯白**，所以「门禁胶囊 / 等级标签 / 详情块 / 页脚 / code 片段」的底色全白对白、看不见 → 面板变平。
2. `bg-overlay` 是**灰蓝 `#e9ecf2`**，所以弹层是一块灰板（不是设计稿的白卡）。
3. `brand-primary` 在浅色下是**近黑**，所以「第 N 轮」胶囊、FID 等级、`打开 MR` 链接全变黑 → 设计稿的蓝色强调消失。
4. `border-l1` 只有 4% 黑，用它画卡片/按钮边框几乎等于没有。

**改法（v0.2.2）**：

- 面板表面改用 `bg-layer-1`（白/深灰），边框用 `border-l2`；
- 在 `.mrl-chip,.mrl-panel` 上派生局部 token：`--mrl-fill` = `color-mix(in srgb, label-primary 5%, transparent)`、`--mrl-fill-2` = 8%、`--mrl-line`/`--mrl-line-soft` 映射 `border-l2/l1`、`--mrl-accent` = `state-business-primary`（fallback `label-primary`）；
- 所有嵌套块（门禁胶囊、等级/状态胶囊、合并条、tab 轨道、详情块、页脚、code）统一用 `--mrl-fill`，语义色只用于「通过/待处理/阻止」；
- 蓝色强调（第 N 轮、低等级、`打开 MR`）走 `--mrl-accent`（最接近设计稿的蓝，且随主题切换）；
- 会话头 chip 改成「扁平标签 + 实心主按钮（brand）」；`order` 几经调整，v0.2.3 按用户要求固定为 **200**（排在其它 chip 之后、工具按钮之前，即会话头最末尾）；
- 验收台 `:root` 换成上表真实值并支持 `?theme=dark`，同时把 `createPortal` 目标改到 `#stage`（否则弹层 portal 到 body、截不到）。

验收截图：`specs/assets/mr-loop-ui-implemented-light.jpg`、`mr-loop-ui-implemented-dark.jpg`（真实 bundle 渲染）。

## 十一、响应式 chip：窄屏收成一个 MR 图标（2026-11-17，v0.2.4）

需求：入口放在会话头最末尾（`order: 200`），但这一排 chip 是「放不下就从末尾裁剪、收进 ⋯」的行为，
放在最后的入口反而最先被裁掉。所以 chip 自己量宽度，放不下就收成 26×26 的图标按钮，保证**一直在**。

### 判定

```
container = 从 chip 往上找：第一个 overflow-x ≠ visible 的祖先（会话头动作区就是裁剪 + 渐隐），
            找不到再退一步用最近的 flex 行；都没有 → 用窗口宽度兜底
content   = 溢出时取 container.scrollWidth（含 gap/内边距，最准）
            没溢出时只累加子元素宽度 + 左右内边距（绝不能把容器宽度当内容宽度）
needed    = content - 当前chip宽 + 完整chip宽      // 换成完整形态后这一排需要的总宽度
mode      = needed + 8px 余量 ≤ container.clientWidth ? full : compact
```

关键点：`needed` 在两种形态下算出来相同（紧凑态量 `content` 少了一个 chip 宽度，但公式把它加回来了），
所以「宽了就展开、窄了就收起」不会来回抖。8px 余量是刻意留的保守量。

兜底：量不到容器（或首帧还没挂载 DOM）时按 `window.innerWidth < 1000` 判紧凑。

### 触发时机

- 每次渲染后测一次（chip 在数据到达前返回 `null`，只跑一次的 effect 会漏挂观察器）；
- 容器尺寸变化（`ResizeObserver`）+ 窗口 `resize`；
- 挂载后补两次重测（下一拍 + 150ms），避免首帧没排完版量到 0 误判。

### 形态

| 形态 | 内容 | 尺寸 |
| --- | --- | --- |
| 完整 | `!241 · 第 N 轮` ＋ `+N` ＋ `N 待处理` ＋ `看板` | 约 210–260px |
| 紧凑 | 一个 MR 合并图标按钮（三个圆点 + 连线），待处理/可合时右上角一枚状态点 | 26×26 |

紧凑态：`title`/`aria-label` 带 `MR 看板 · !241 第 1 轮 · 2 待处理`，点击照旧打开看板。

### 验收与测试

- 单测：`chipShrinkMode` 的边界（放得下 / 差 8px 内 / 缺字段）+ 形态不变式 + 兜底；窄屏渲染出一个图标按钮且点击能开抽屉（`test/client.test.js`，共 311 项）
- 视觉台：`scripts/ui-harness.html?chip=cramped` 把 chip 塞进 200px 裁剪行（真实测量路径），`?chip=compact` 模拟窄窗口
- 截图：`specs/assets/mr-loop-ui-chip-compact.jpg`
