# mr-loop UI 设计稿（2026-11-16）

> 状态：**设计已出稿，未实现**（用户要求先设计样式与入口）。
> 数据来源：MR（评论、门禁、评审 note）+ 本地账本 + findings JSONL；UI **只展示与操作入口，不产生判定**。
> 视觉稿：`docs/superpowers/mocks/mr-loop-ui.html`（可直接浏览器打开）
> 截图：亮色 `specs/assets/mr-loop-ui-light.jpg`、暗色 `specs/assets/mr-loop-ui-dark.jpg`

## 一、这个 UI 要回答的问题

1. 这个会话绑了哪些 MR？（会话内，不是全站）
2. 每个 MR 现在卡在哪一项？（评审 / 敏感 / 必过 / 流水线 / 冲突 / 讨论）
3. 出现了哪些问题？**哪些修了、哪些没修、没修的用了什么指令**（`#ai-waive` / `#ai-skip` / `#ai-wontfix` + reason + 评论链接）。
4. 每个 MR 走到了第几轮、下一步该谁动。

## 二、入口方案对比（基于真实插槽）

| # | 位置 | 插槽 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 1 | 会话头 chip | `conversation.session.header.actions`（list，session 域） | 常驻、和「当前会话」强相关、不打断操作；点开即看板 | 头部空间窄（溢出会裁切/淡化），只能放极简信息 | ✅ **v1 主入口** |
| 2 | 工具结果内联卡 | `tool.call.toolview`（keyed，注册 `mr_bind`/`mr_status`/`mr_review`） | 报告就地变卡、零导航；每轮一份，天然对齐「这一轮」 | 只在调用工具时出现，向上滚动后看不见 | ✅ **v1 配套（每轮快照）** |
| 3 | 输入框工具行 | `conversation.input.left` / `.right` | 常驻、实现最简单（`user-ds-balance` 的同款做法） | 和输入控件混在一起，语义不对、噪音大 | ❌ 不用 |
| 4 | 右侧页签 | `sidebar.right.pane.tab` | 可与对话并排、适合长时间看 | 页签类型注册成本高，和文件预览抢位；会话切换语义复杂 | ⏳ v2 备选 |
| 5 | 左侧全局面板 | `sidebar.panellist` + `sidebar.panel.icon` | 跨会话总览、真正的"页面" | root 域，不表达"绑定 MR 的那个会话" | ⏳ v2（全局视图） |
| 6 | 全屏浮层 | `shell.overlay`（list，root 域） | 空间大、易做焦点管理、可盖住整个会话 | 需要自己处理遮罩/焦点/ESC | ✅ **v1 抽屉载体** |

**推荐组合**：会话头 chip（常驻，显示「MR 数 + 待处理数」）→ 点击打开 `shell.overlay` 抽屉「MR 看板」；每轮报告在对话流里用工具卡渲染。全局面板与右侧页签留给 v2。

**为什么主入口不放输入框**：输入框工具行是「输入相关的控件」语义（模型选择、权限、计划），放一个 MR 跟踪器会长期占位且和上下文的关联弱；头部 chip 才能表达「这个会话的 MR」。

**为什么不用右页签做 v1**：页签需要注册 tab 类型与标题、处理多页签切换/持久化，成本高于收益；抽屉已经能覆盖看板场景。

## 三、信息架构

```
会话头 chip（!241 · 第1轮 | 1 待处理 | !238 · 可合 | [看板]）
└─ 抽屉：MR 看板
   ├─ 分段：本会话 / 全部会话 / 已合并     ← v1 只有「本会话」
   ├─ MR 卡（列表，一个 MR 一张）
   │   ├─ 头：!241 / 源→目标分支 / 第 N 轮 / 状态徽标（差 1 项 / 可合 / 已合并）
   │   ├─ 门禁条：评审 · 敏感 · 必过 · 流水线（圆点 = 状态）
   │   ├─ 合并条：⛔ 差 N 项：<原因> · [打开 MR ↗]
   │   ├─ 问题行 ×N：FID · 级别 · 类型 / 文件:行 / 问题一句话 / 状态徽标 / 指令行
   │   └─ 脚：sha · 相对时间 · [复制指令] [详情]
   └─ 空态：还没有绑定 MR → /mr <链接>
```

问题状态：`未处理(open)` / `已修(fixed)` / `已豁免(waived)` / `不适用(skip)` / `不修(wontfix)`；豁免类都要带指令原文 + 评论号（点开跳 MR）。

## 四、视觉规格（只用 14 个主题 token）

| 元素 | 规格 |
| --- | --- |
| 底色 | 抽屉 `--dsw-alias-bg-overlay`，卡 `--dsw-alias-bg-layer-1`，嵌套块 `--dsw-alias-bg-layer-2` |
| 边框 | 1px `--dsw-alias-border-l1`（卡、行分隔），强调态 `--dsw-alias-border-l2` |
| 文字 | 主 `--dsw-alias-label-primary`，次 `--dsw-alias-label-secondary` |
| 语义色 | 通过 `state-success-primary`，待处理 `state-warn-primary`，阻止 `state-error-primary`，完成/豁免 `state-idle-primary` |
| 强调 | `--dsw-alias-brand-primary`（品牌色只用于「第 N 轮」徽标、链接、主按钮） |
| 圆角 | 卡 12px、块 9px、chip 7px、徽标 20px |
| 字号 | 标题 14/650，正文 12，辅助 11，FID/路径 11 等宽 |
| 间距 | 卡内 12px，行内 6–8px，卡间 10px |
| 抽屉 | 宽 438px，右侧滑入 220ms `cubic-bezier(.2,.8,.2,1)`，遮罩 `rgba(0,0,0,.18)`，Esc 关闭，焦点陷阱 |
| 动效 | 仅两处：抽屉滑入；待处理计数变化时 chip 轻微高亮（≤300ms）。其余不做动画 |

颜色全部走 token，**不引入自定义十六进制**；暗色自动跟随（截图见 `assets/mr-loop-ui-dark.jpg`）。

## 五、组件与状态

- **chip**：高 28px；最多显示 2 个 MR（`!241 · 第 1 轮` + 状态徽标）+ `+N`；有待处理时徽标用 warn 色。
- **MR 卡**：`差 N 项` 用 error，`可合` 用 success，`已合并` 用 idle；合并条整条底色按状态 8% 透明。
- **问题行**（三行式）：① `FID` + 级别/类型 chip + 状态徽标；② 文件路径（等宽、单行省略，hover 显示全路径）；③ 问题一句话（≤2 行）；④ 若有指令：`#ai-waive reason=<…> · 评论 #75200`（可点）。
- **指令行**：kind 用等宽字，reason 截断 80 字，评论号链到 MR。
- **加载**：抽屉打开瞬间显示 3 行骨架；**错误**：卡内 inline 错误 + `重试`，保留上次数据并标「数据可能过期」。
- **空态**：图标 + `还没有绑定 MR` + `/mr <GitLab MR 链接>`。
- **窄屏（<720px）**：抽屉全宽，chip 只留图标 + 计数。

## 六、数据契约（只读）

`GET /mr-loop/ui/state?sessionId=<id>`（host 侧聚合，只读、无副作用；30s 缓存）：

```jsonc
{
  "sessionId": "session-…",
  "updatedAt": "2026-11-16T12:40:00Z",
  "mrs": [{
    "projectPath": "group/project",
    "iid": 241,
    "webUrl": "https://git…/-/merge_requests/241",
    "sourceBranch": "feat-…", "targetBranch": "feature-…",
    "state": "opened", "sha": "8a282d15…", "round": 1,
    "review": { "verdict": "pass", "historicalUnresolved": 0, "verifiedFixed": null, "newThisRound": 1 },
    "gates": { "sensitive": "pass", "mandatory": null },
    "merge": { "mergeable": false, "missing": ["评审有 1 处需要关注的问题…"],
               "pipeline": { "id": 7298, "status": "success" } },
    "problems": [{
      "fid": "aea50825a5", "level": "低", "type": "非阻塞建议",
      "file": "src/…/index.tsx", "line": 81,
      "problem": "…", "suggestion": "…",
      "status": "open",                       // open|fixed|waived|skip|wontfix
      "instruction": null,                     // { kind, reason, noteId, url }
      "rounds": [1, 2]
    }],
    "rounds": [{ "n": 1, "sha": "8a282d15", "verdict": "pass", "at": "…", "fixedCount": 0, "waivedCount": 1 }]
  }]
}
```

- 客户端 30s 轮询（与 watcher 同频）；打开抽屉时立即强刷。
- 数据字段缺失时按「未知」显示灰点，不猜。
- UI 不直接读 GitLab token，也不拼请求；一切经 host 聚合（token 不出宿主）。

## 七、分期

| 期 | 内容 |
| --- | --- |
| v1 | 会话头 chip + 抽屉看板 + 工具结果卡；纯只读 |
| v2 | 问题详情（建议/代码片段/评论原文/轮次时间线）；右侧页签或全局面板（跨会话） |
| v3 | 卡片内写操作：`[豁免]` → `mr_waive` 草稿 → 「可以 / 自定义」确认 → 回帖；`[重试评审]` 等 |

## 八、约束与风险

1. **会话头空间**：只放数量与状态，不放分支名/标题；溢出用 `+N`。
2. **数据延迟**：轮询 30s，最大延迟一个 tick；打开抽屉强刷。
3. **状态来源唯一**：问题状态由「评审 note + 指令评论 + 账本」推导，UI 不自行推断；与 CLI 报告口径一致（共用 `reviewTodo`）。
4. **不污染会话**：抽屉是浮层，不改变会话事件流；不写 MR（v1/v2）。
5. **性能**：单会话 MR 数一般 <5，问题 <50；一次性渲染，无需虚拟列表。
6. **可访问性**：抽屉焦点陷阱 + Esc 关闭；chip 可键盘聚焦；状态不只靠颜色（有文字）。
