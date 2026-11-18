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

## 十四、终态不再算「差几项」：合并后显示「已合并」（2026-11-17，v0.2.7）

### 症状（用户实拍）

MR !243 已经合并（卡片标签已经是「已合并」「第 9 轮」），合并条却是红的
**「差 1 项：MR 状态是 merged」**，右上角还挂着「差 1 项」——已完成的 MR 反而在报「没做完」。

### 根因

`evaluateMergeable` 是「现在能不能合」的判定，`mr.state !== 'opened'` 会进 missing
（`MR 状态是 ${state}`）。合并/关闭后仍用同一套判定渲染，就出现了这条自相矛盾的缺口；
`ui.js` 的 `merge` 与 `report.js` 的「合并」行都照抄了它。

### 改法

- `mergeable.js`：`merged / closed` 直接返回
  `{ mergeable:false, missing:[], degraded:false, terminal:'merged'|'closed' }`，
  不再走「差 N 项」；`terminal` 让调用方能区分「不可合」与「已结束」。
- `report.js`：终态时「合并」行写 `✅ 已合并（sha xxx） · 流水线 #…` /
  `— MR 已关闭（未合并）`。
- `ui.js`：`merge` 带 `terminal`；终态时 `pending` 归零（已合并的 MR 不该再报「N 待处理」）；
  live 快照缺失但有账本 `terminal` 时也给终态 merge（不再退回「历史账本（未在跟踪）」）。
- `client.js`：终态合并条用绿色「已合并（sha …）」/ 灰色「MR 已关闭（未合并）」；
  右上角标签只显示「已合并 / 已关闭」，不显示「差 N 项」；`复制指令` 禁用。
- `counts.mergeable` 仍只算 `mergeable === true` 的 MR，终态不会混进去。

### 验收

- 测试 **337/337**（新增：mergeable 终态 1 项、report 终态 1 项、UI 终态 2 项、客户端终态渲染 1 项）。
- 视觉台：`?demo=merged`（已合并卡片）、`?demo=merged&round=8`（合并后点开历史轮）；
  截图 `specs/assets/mr-loop-ui-merged-light.jpg`。
- 真实数据：!243 合并后 merge 为 `{terminal:'merged', missing:[], pipeline:{…}}`（pipeline 只在
  还有 live 快照时有），pending 0，合并条绿色「已合并（sha c0cfe45f）」，不再出现
  「差 1 项：MR 状态是 merged」。终态账本不会被 rehydrate 恢复成「监视中」：重载后卡片
  标「历史账本」+「已合并」，属于预期。

## 十五、历史轮的状态按「最新一次已落地评审」收敛（2026-11-17，v0.2.8）

### 症状（用户实拍）

同一个 FID `fd56004d1a`：点第 8 轮显示「● 未处理」，点第 9 轮显示「✓ 已修」——
第 8 轮提的问题在第 9 轮被验证修好了，但第 8 轮的视图还停在「当时没处理」。
用户原话：「第八轮和第九轮的 FID 是同一个，但是状态却不一样」。

### 根因

`collectFindings(record, { roundIndex })` 只比较**相邻两轮**：它给第 N 轮算「第 N 轮的问题 +
第 N 轮确认修好的第 N-1 轮问题」。所以第 8 轮那一条要等到看第 9 轮视图时才会变成「已修」，
历史轮自己的视图永远是当时的快照。

### 改法

- `findings.js` 新增 `resolveFindings(findings, record, roundIndex)`：把某轮视图里仍是 open 的
  finding 拿到后续「已落地评审」（verdict = pass / changes）里对账——
  - 最新一次已落地评审里还有它 → 仍然是 open（没修好）；
  - 消失了 → 改判 `fixed`，`fixedAtRound` = 第一次不再出现的那一轮。
  - 看的就是最新一轮（后面没有已落地评审）时原样返回，所以当前轮 / 回落视图的判定完全不变。
- `ui.js`：`rounds[].problems` 与顶层 `problems` 都过一遍 `resolveFindings`；
  `unverified`（待复验）改成全局口径「当前轮评审还没落地」，所有视图一致。
  轮次摘要的 `total` 改为「这一轮自己提了几条」（与后续修没修无关），`open/fixed/waived` 用收敛后的状态。
- `client.js`：`fixed` 状态带轮次：在别的轮视图里显示 **「✓ 第 9 轮已修」**，本轮视图里仍是「✓ 已修」。

### 验收

- 测试 **339/339**（新增 `resolveFindings` 1 项、UI 历史轮收敛断言、客户端「第 N 轮已修」渲染 1 项）。
- 视觉台：`?demo=merged&round=8`（同一个 FID 在两个轮视图里都是已修，且标明是第 9 轮验证的）；
  截图 `specs/assets/mr-loop-ui-round-status-light.jpg`。
- 真实数据：!243 第 8 轮视图里 `fd56004d1a` 从 `open` 变成 `fixed / fixedAtRound 9`。

## 十六、问题按 FID 去重 + 轮次只算真实评审（2026-11-17，v0.3.0）

### 症状（用户实拍）

!243 一共只发现 6 个问题，但面板上「视觉接收到的远远不止 6 个」：同一个 FID 在它出现的每一轮
都重复铺开一遍，哪条是这一轮新出的、哪条是历史未收敛（后来还在提）完全看不出来；
轮次条还出现了「第 7 轮」——那一笔 push 根本没有流水线，评审不会自己来，却照样涨了轮次号。

用户给的 7 条口径：

1. 按 FID 建唯一索引：重复出现只记轮次与次数，**只在第一次出现的轮次里展示**；下一轮及后续
   不再出现同一 FID 就算已修复。
2. 轮次 tag 可以展示该轮有几个问题；点进某一轮时，问题的展示要带「首次出现的轮次 + 出现次数」。
3. 代码提交了但流水线没工作的情况，轮次不要增加。
4. 没有（新）问题的轮次不要再展示「本轮修复的问题」。
5. 轮次区域展示完整轮次（不截断）。
6. FID 下面的代码路径用 tag 展示，完整展示、不显示省略号。
7. 展开问题区域显示问题源码；没有源码就不显示源码行。

### 根因

- 面板按「轮」取数：`collectFindings(record, { roundIndex })` 每轮各算一份清单，同一个 FID 在
  第 2、3 轮各出现一次就会在两轮里各渲染一遍；轮次条 `total` 也是「该轮评审报了几条」，
  于是重复出现被反复计数。
- 轮次的产生只看 sha 变化：`applySnapshot` 遇到新 sha 就 `n + 1`，不看这笔提交到底有没有流水线。
  GitLab 的 `head_pipeline` 是「这个 MR 最新的流水线」，新 push 之后它可能还停在上一个 commit 上；
  这种轮次永远等不到评审，却占了一个轮次号，还留下一条「评审 · 未知」的空壳。
- 路径行 `.mrl-file` 是 `white-space:nowrap; text-overflow:ellipsis`，长路径被省略号截断。
- 评审 note 的 `源码:` 字段根本没解析（`parse-review.js` 的 `FIELD_KEY` 漏了它），所以「源码」永远是空的。

### 改法

**数据层（唯一索引）**

- `findings.js` 新增 `collectFindingsIndex(record)`：
  - 按 FID（大小写不敏感）建唯一索引，Map 插入顺序 = 首次出现顺序；
  - 每条记 `firstRound` / `firstSha` / `rounds[]` / `count` / `lastRound`，描述取首次出现那一轮的原文；
  - 状态：仍出现在最近一次评审里 → `open`；最后一次出现之后、第一个**已落地评审**（pass / changes）
    里没有它 → `fixed`，`fixedAtRound` = 那一轮；unknown / 评审未出都不算修好（fail-closed）；
  - 处置沿用账本 `decisions`（优先）与**最近一轮** MR 指令；已处置的不判 fixed（它没有「修好」的含义）。
- `ui.js` 的 `problems` 直接来自唯一索引（每个 FID 只出现一次）；`summary` 给
  `{ total, open, fixed, waived }` 供标题汇总。
- 每轮的 `problems` 只放「首次出现在这一轮」的问题；同一 FID 在后续轮再出现只记
  `repeatCount` + `repeats:[{fid, firstRound, count}]`，不再铺问题卡片。
  轮次摘要的 `total` = `newCount + repeatCount`（该轮评审报了几条），其中 `newCount` 才是轮次条徽标。

**轮次（只算真实评审）**

- `rounds.js` 新增 `pipelineForHead(mr)`（head_pipeline 的 sha 是否就是当前 sha；拿不到 sha 时按未知=有处理）、
  `isPhantomRound(round)`（没有评审结论、且没有本提交流水线）、`normalizeRounds(rounds)`
  （过滤伪轮次并重编号；没有伪轮次时原样返回，保留账本裁剪后的起始轮次）。
  服务层每次快照把 `pipelineForHead` 写进当轮，作为「这一笔到底算不算一轮」的证据。
- `service.js`：新 sha 到来时如果上一轮是伪轮次，直接替换它、复用轮次号；`bind` / `restore` 读账本时
  先 `normalizeRounds`（老账本里没有证据字段的「非末轮 + 无评审」条目按伪轮次处理）。
  等待评审的当前轮仍保留在内部状态里（watcher 需要它来等评审 / 提醒没流水线），只是不发进 UI 的轮次条。
- `ui.js` 额外下发 `waiting: { sha, since }`：面板显示「已推送 <sha8>，等待流水线 / 评审」，
  并在轮次条末尾放一个不带轮次号的 `⏳ 等待评审` 摘要——等待不是一个轮次。

**展示层**

- `client.js`：
  - 问题：`首见 第 N 轮 · 出现 X 次（第a轮、第b轮）` 元信息；fixed 状态一律写「✓ 第 N 轮已修」；
  - 路径改为 `.mrl-path` tag，`white-space:normal; word-break:break-all`，完整展示、不省略；
  - 展开区在 `problem.snippet` 存在时渲染「源码」行（label 改为「源码」），没有就不渲染；
  - 默认视图标题「问题 · 共 N 条 · 已修 X …」；进入某轮标题「第 N 轮新问题 · X 条 · 历史未收敛 Y」，
    该轮没有新问题时只写一行摘要（不再有任何「本轮修复」清单）；
  - 轮次条渲染完整 `rounds`（不再 `slice(-8)`），徽标 = `newCount`，`↻N` = 该轮重复出现的历史未收敛条数。

### 验收

- 测试 **353/353**（新增：唯一索引 5 项、伪轮次 / 流水线归属 3 项、service 轮次复用 2 项、
  UI 伪轮次 / 完整轮次 2 项、源码解析 1 项；改写 UI / 客户端 6 项旧契约断言）。
- 真实账本 !243：唯一索引 6 条（`da97a49527` 首见第 2 轮、出现 2 次，第 2、3 轮），
  伪轮次被过滤后共 8 轮（原第 8、9 轮重编号为 7、8），轮次条 `第3轮 ● 0 ↻1`，
  6 条全部 `fixed`（验证轮 3/4/5/6/7/8）。
- 视觉台（`scripts/ui-harness.html`，真实 client bundle + 新契约假数据）：
  - `?demo=merged`：见 `specs/assets/mr-loop-ui-findings-index-light.jpg`（6 条唯一问题 + 完整 8 轮）；
  - `?demo=merged&round=3`：`mr-loop-ui-round-repeat-light.jpg`（第 3 轮 0 条新问题 + 历史未收敛 1）；
  - `?demo=settled&expand=1`：`mr-loop-ui-source-code-light.jpg`（路径 tag 完整 + 展开显示源码）；
  - `?demo=fallback`：`mr-loop-ui-waiting-light.jpg`（没流水线的那一笔不计轮次，单独「等待评审」）。

## 十七、卡头补工作区名：编号跨仓库会重号（2026-11-17，v0.3.1）

### 症状（用户实拍）

看板卡片只写 `!243`、`!241`，光看编号认不出是哪个工作区的 MR：iid 是**仓库内自增**的，
不同项目各自从 1 开始累积，同一个面板里出现 `!243` 时无法判断是哪条线在跟踪。
用户口径：**在 MR 编号上面添加工作区名称**。

### 根因

`mrl-mr-id` 直接渲染 `"!" + mr.iid`；`projectPath` 虽然一直在 payload 里（还当 Map key 用），
但从来没上过屏幕。面板隐含的假设是「一次只看一个仓库」——跨仓库同时跟踪时假设就不成立了。

### 改法

- `client.js` 新增 `workspaceNameOf(mr)`：取 `projectPath` 末段（项目名）；空值返回 `""`，
  整行不渲染（不留一条空白，编号仍然贴顶）。
  - **为什么是末段而不是完整路径**：面板里同一个 group 的项目居多，而整串 `group/project`
    超过卡头可用宽度（≈290px）会被 `text-overflow:ellipsis` 吃掉**尾部**——尾部才是项目名，
    截断后所有项目长得一模一样，正好吃掉最需要区分的信息。完整路径进 `title`。
- 卡头顺序变成「工作区名（`.mrl-mr-ws`，11px 三级色）→ 编号 → 分支」，工作区名在编号**上面**。
- chip 是同一份数据的第二个出口，可见文字刻意不变（会话头宽度紧张），只在 tooltip 补一层：
  完整形态的 MR 标签 `title` 前缀工作区名（`credit-web：feat-x → feature-y`）；
  紧凑态图标的 `title` 每条写成 `credit-web !241 第 2 轮`。
  （紧凑态一格里可能列两条 MR，用项目名而不是完整路径，避免同一串路径在 tooltip 里重复两遍。）

### 验收

- 测试 **355/355**（新增 2 项：卡头工作区名的文本 / `title` / 文档顺序，以及没有 `projectPath`
  时不渲染空行；改写 chip 的 2 处旧断言，补完整形态标签的 tooltip 断言）。
- 视觉台（`scripts/ui-harness.html`，真实 client bundle + 假数据）：
  - `?demo=all` 点「全部 4」：`specs/assets/mr-loop-ui-workspace-light.jpg` ——
    `other`(!238) 与 `wisdom-financial-credit-platform-web`(!243) 同屏，工作区名在编号上一行；
  - `?demo=all&theme=dark`：`specs/assets/mr-loop-ui-workspace-dark.jpg` —— 暗色下三级色仍可读。
- DOM 级核对：4 张卡的 `.mrl-mr-ws` 依次为 `wisdom-financial-credit-platform-web ×3` + `other`，
  每个节点的 `title` 是对应的完整 `projectPath`。

## 十八、合并后 MR 从看板消失：终态账本被 forget 删了（2026-11-18，v0.3.2）

### 症状（用户实拍）

!246 今天合并，loop 阶段在「MR 看板」里看得到；合并之后卡片**从看板消失**，
`全部 3` 只剩 `!243`、`!241` 两条，`已合并` 从 2 掉回 1。

### 取证

- 账本目录 `~/.dsh/mr-loop/ledger/` **没有任何 !246 的 JSON**；目录 mtime = `18:04:53`，
  正好是 merge commit `865ce5b3` 落到 `feature-V1.7.0.20261119` 的时刻。
- !246 跟踪会话的 transcript（`session-232435b6…`，seq 2012）在「已合并」唤醒后调了
  `mr_stop({ forget: true })`，reasoning 原文：「I'd use forget=true to unbind and delete ledger
  since the MR is done.」→ 账本被 `ledger.forget()` 删除，而看板**唯一数据源就是账本**
  （`/mr-loop/ui/state` = 内存绑定 + 账本文件；绑定随会话/重载消失，账本才是历史）。
- `findings` 侧车文件（`~/.dsh/workspace/…/…__246.jsonl`）还在，证明第 3/4 轮的评审确实被跟过：
  这不是「没绑定」，是**历史被自己删了**。

### 根因

1. **缺守卫**：`service.stop({forget:true})` 不区分 MR 是否终态，一律 `ledger.forget()` 删文件；
   「合并后收尾」这种最自然的时刻，反而最容易把历史删掉。
2. **指导反了**：`mr_stop` 工具描述、`/mr stop --forget` 用法、`mr-loop` 技能表格都把
   「forget=true 解绑并删账本」并列成常规收尾手段，没有一句说「合并后不要 stop」。
   主代理在合并唤醒后按「收尾」语义选了 forget，插件自己把人引到了坑里。
3. 合并唤醒文案只写「监视结束」，没提「账本留给看板」，收尾动作全靠代理自由发挥。

### 改法

**判定层**

- `service.js` 新增 `terminalOf(state)`：账本 `terminal` 优先，其次实时 `mr.state`。
- `stop({forget:true})` 命中终态时**只解绑**：`bindings.delete` + 落盘
  `binding.sessionId = null`（重载后不会被当成「还要继续盯」恢复），账本原样保留；
  返回值 `{ stopped:true, forgotten:false, kept:true, terminal }`。
  未结束的 MR 仍然是旧语义（人工放弃跟踪 → 删账本），行为不变。
- `mr_stop` 工具 / `/mr stop` 按返回值出对应文案：
  「MR 已合并，账本是看板历史，已保留（未删除）」。
- watcher 的终态唤醒文案补一句「账本已保留在看板，不要调 mr_stop」。

**指导层**

- `skill.js` 工具表：`mr_stop` 描述改成「账本默认保留；forget 只删未结束的 MR，终态账本永不删」；
  新增 `mr_recover` 一行。
- 技能正文「插件盯到合并才停」段落补：合并 / 关闭后自动收尾，**不要 mr_stop、更不要 forget**；
  误删用 `mr_recover({url})` 补录回来。

**补录（新工具 `mr_recover`）**

- `rounds.rebuildRounds({ mr, notes, cfg })`（纯函数）：只认评审 note 里的 `AI_REVIEW_SHA`，
  一个 sha 一轮、同 sha 取 note.id 最大的一条；无标记的评审 note 丢弃（`dropped: no-sha`），
  补录宁可少一轮也不张冠李戴。门禁 note 没有 sha 证据不重建（`sensitive`/`mandatory = null`）；
  指令与普通评论在整条 MR 上扫一次、挂最后一轮。
- `service.recover({ url })`：`mr_bind` 只接受 opened，补录专门处理 merged/closed；
  已有非空账本原样不动（`existing: true`）；写 `binding.sessionId = null`、
  `terminal = mr.state`、`recoveredAt`；不启动监视、不碰会话。
- 工具面注册第 7 个工具 `mr_recover({ url })`。
- 轮次 / FID 唯一索引 / 首见轮次 / 修复轮次全部复用 0.3.0 的同一套聚合，不做补录专用视图。

### 验收

- 测试 **362/362**（新增 7 项：终态 forget 守卫 2、recover 成功 / 错误 / 幂等 2、
  `rebuildRounds` 分组 / no-sha / 空结果 3；改写 index 工具数 7、watcher / integration 唤醒文案 3 处）。
- 真实补录 !246：GitLab 4 条评审 note（`23ea91af` / `8434e965` / `26e43a83` / `a7d09c89`）→ 4 轮；
  1 个 FID `0d40d9d2bf`（第 3 轮首见，第 4 轮已验证修复），
  `/mr-loop/ui/state`：`!246 merged round 4`、`summary {total:1, fixed:1}`，看板 `全部 3 / 已合并 2`。
- 真实 payload + 真实 client bundle 渲染（`mr-loop-ui-recovered-246-light.jpg`）：
  !246 回到列表顶部，「第 4 轮 / 已合并 / 历史账本」，问题 `0d40d9d2bf` 标 `✓ 第 4 轮已修`、
  `首见 第 3 轮`，轮次条 `第1轮 ●0 / 第2轮 ●0 / 第3轮 ●1 / 第4轮 ●0`，
  路径 tag 完整换行、源码行来自补录解析（卡片图 `mr-loop-ui-recovered-246-card-light.jpg`）。
