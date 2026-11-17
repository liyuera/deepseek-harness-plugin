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

## 十二、评审未出时的空看板：回落上一轮结论 + 轮次条（2026-11-17，v0.2.5）

### 症状（用户实拍）

MR !243 看板显示「第 7 轮」「差 1 项：AI 评审结论未知（未出或解析失败）」，
但问题区整块是空的；而 MR 上第 1–6 轮每轮评审都提了问题（第 2 轮 2 条，第 3–6 轮各 1 条）。
用户原话：「MR243，每一轮都有问题，但是我在看板上都看不到」。

### 根因（两层）

1. `problems` 只取**当前轮**（`collectFindings(record)` 默认读最后一轮）。第 7 轮的 sha
   `b30c43b3` 刚 push、评审还没出（`review: null`），所以当前轮 finding 为 0；
   而固定规则「评审未出 ≠ 已修」被实现成了「什么都不显示」，于是整块空白。
2. 看板没有任何跨轮视图：`rounds[]` 只是设计稿 §六 里的草图，从未实现。
   所以用户既看不到当前轮已出的问题（窗口只有几十秒），也看不到「每轮都提过几条」。

另一个观察：那笔 push 没有触发流水线（`head_pipeline #7358` 的 sha 还是上一笔 `081bb374`），
所以第 7 轮评审其实不会自己来，看板却只说「解析失败」。这条事实现在也展示出来了。

### 改法（只改展示，不改判定）

- `findings.js`：新增 `settledRoundIndex` / `displayRoundIndex`（最近一个 verdict = pass/changes 的轮次）；
  `collectFindings(record, { roundIndex })` 可指定「看哪一轮」，缺省仍是最后一轮
  —— findings 落盘 / 报告 / 唤醒的口径完全不变。
- `ui.js`：
  - `problems` 用 `displayRoundIndex`（当前轮评审没落地 → 回落上一轮结论）；
  - 回落后仍为 `open` 的问题带 `unverified: true`（上一轮的「未处理」不能断言现在还没修）；
  - 新增 `problemsRound: { n, sha, current }`、`rounds: [{ n, sha, verdict, at, total, open, fixed, current }]`（最多 12 轮，只给计数不给正文，payload 保持小）；
  - `merge.pipeline.sha`：`head_pipeline` 停在上一笔提交时，面板据此说明「这笔提交没有流水线」。
  - `pending` / 可合结论仍只认当前轮：回落只影响展示，不影响「差 N 项」与待处理计数。
- `client.js`：
  - 问题段落头：`第 N 轮问题 · M 条`；回落时右侧标注「第 M+1 轮评审未出」；
  - 回落问题的状态显示为「◔ 待复验」（accent 色），而不是「● 未处理」；
  - 轮次条：`轮次 第1轮·0 第2轮·2 … 第6轮·1 第7轮(等待评审)`，最多 8 个 + `+N`；当前显示的那一轮有描边，等待中的一轮用 warn 底色；
  - 合并条内补一行：`流水线 #7358 还停在 081bb374，这笔提交没有流水线`（仅当 `review === null` 且 sha 不一致）。

### 验收

- 真实账本 !243（第 7 轮等待中）现在输出：`problemsRound = 第 6 轮`、问题 2 条（1 条待复验 + 1 条已修）、
  `rounds = 0/2/1/1/1/1/等待` 七轮。
- 测试 **316/316**（新增：`collectFindings` 指定轮次与回落不误判、UI 回落/`unverified`/轮次摘要、
  看板回落渲染与「当前轮已落地」渲染两种情况）。
- 视觉台：`scripts/ui-harness.html?demo=fallback`（回落态）、`?demo=settled`（当前轮已落地），
  `&theme=dark` 暗色；截图 `specs/assets/mr-loop-ui-fallback-light.jpg`、`mr-loop-ui-fallback-dark.jpg`。
- 已知边界：轮次条只给计数，历史轮的问题正文不随 payload 下发（保持 30s 整包轮询）。

### data 契约增量

```jsonc
{
  "problemsRound": { "n": 6, "sha": "081bb374…", "current": false },
  "rounds": [{ "n": 6, "sha": "…", "verdict": "pass", "at": "2026-11-17T07:02:14Z",
               "total": 1, "open": 1, "fixed": 1, "current": false }],
  "problems": [{ "fid": "c145950e29", "status": "open", "unverified": true }],
  "merge": { "pipeline": { "id": 7358, "status": "success", "sha": "081bb374…" } }
}
```

## 十三、三个补丁：没流水线要叫、重载要续盯、历史轮要能点开（2026-11-17，v0.2.6）

### ① 新提交长时间没有流水线 → 主动唤醒一次

实拍 MR !243 第 7 轮：push 了 `b30c43b3`，但 `head_pipeline` 还停在 `081bb374`（GitLab 的
head_pipeline 是「这个 MR 最新的流水线」，新提交没触发流水线时它指向上一个 commit）。
原来的行为是静默等到 `roundTimeoutMs`（15 分钟）才说一句「评审超时」，然后继续等。

- 配置：`noPipelineWakeMs`（默认 180000 = 3 分钟，最小 30000）。
- 判据：`head_pipeline.sha !== mr.sha`（或整个 MR 没有流水线）且本轮评审还没出；
  实例没给 `head_pipeline.sha` / 当前 sha 缺失时按「未知」处理，**绝不误报**。
- 同一个 sha 只提醒一次（`noPipeline:<sha>` 去重）；文案直接说清怎么解：
  `评审不会自己来：sha b30c43b3 已经 3 分钟没有流水线，最新流水线 #7358（081bb374）还停在上一笔提交。重新 push 或手动跑一次流水线。`
- 评审已到场时不提醒（流水线 sha 落后可能只是 GitLab 延迟），轮询间隔也不受影响；
  等待中的轮次改用 `pollNoPipelineMs`。
- `roundTimeoutMs` 的「评审超时」文案也带上这条事实（区分「没有流水线」与「流水线状态」）。

### ② 插件重载 / 应用重启后自动恢复监视

原来绑定只在内存里：每次重载插件（开发期每改一次都会重载）用户的 MR 监视就断了，
必须回到那个会话重新 `/mr <链接>`。

- 账本 `binding` 增加 `sessionId`（`bind` 时写入）。`mr_stop` 不 forget 时把账本里的
  `sessionId` 置空——显式停止的 MR 不该被自动恢复；重绑会重新写入。
- `ledger.list()`：读出账本目录全部记录（坏文件跳过）。
- `service.restore({ record })`：从账本恢复内存状态（不写账本、不碰网络；MR 快照不落账本，
  下一个 tick / `/mr status` 会补齐）。拒绝：老账本没有 `sessionId`、已终态、空轮次、同会话已绑定。
- `index.js` 导出 `rehydrateBindings`：只恢复「会话还有活 agent」的绑定（`ctx.get('agents').get`），
  恢复后 `watcher.start` 续盯。插件卸载后不再恢复（`isActive`），避免留下无人清理的定时器。
- 触发点三个：`apply` 时扫一遍、`agent/created`（应用重启后会话被打开）、用户首次发言（`session/event`）。
- 守卫计时从「恢复」起算，不会被误判成「停了 12 小时」直接暂停。
- 已知边界：应用重启后，会话没有被打开之前不会恢复（DSH 不给未加载会话建 agent，插进去的消息也无人接收）；
  会话一被打开就自动接上。0.2.6 之前写下的账本没有 `sessionId`，需要重绑一次才会被自动恢复。

### ③ 面板里点轮次条看历史轮的问题正文

上一版（0.2.5）轮次条只给计数。现在 `rounds[]` 每轮都带 `problems`（与当前轮同一套
`collectFindings` 口径：本轮评审的问题 + 本轮确认已修的上一轮问题），面板：

- 轮次条变成按钮：点第 N 轮 → 段落头切到 `第 N 轮问题 · X 条`，右侧出现 `回到第 6 轮`；
  等待中的一轮点开显示 `· 等待评审`。
- 历史轮是「第 N 轮时的清单」：那一轮还没修的问题就是 `● 未处理`（后来修好的会在后面几轮显示 `✓ 已修`）。
- 翻历史轮时「复制指令」禁用：翻出来的 FID 可能早就修好了，不能拿来发豁免。
- payload：最多 12 轮 × 每轮问题正文（`问题` 500 / `建议` 500 / 代码 400 上限已有），面板 30s 整包轮询仍然成立。

### 验收

- 测试 **331/331**（新增：noPipeline 唤醒 4 项、ledger.list 2 项、service.restore/stop 3 项、
  rehydrateBindings 4 项、每轮问题正文 2 项、客户端历史轮翻看 1 项）。
- 视觉台：`?demo=fallback`（默认回落视图）、`?demo=fallback&round=2`（点开第 2 轮），
  `?theme=dark` 暗色；截图 `specs/assets/mr-loop-ui-round-history-light.jpg`、
  `mr-loop-ui-round-history-dark.jpg`。
- 真机验证：绑定 → 重载插件 → 账本 `binding.sessionId` 恢复 → `/mr-loop/ui/state` 里该 MR 仍是 `live: true`
  且合并判定仍在算 → `mr_stop` 后回到「历史账本」。
