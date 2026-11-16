# mr-loop 下一阶段决策记录（2026-11-16）

> 状态：**T1 / T2 已实现（读路径 + 写路径）**；T3 / T4 / T5 与 UI 待开工。实现已回写主 spec。
> 本文件与 `2026-11-13-mr-loop-design.md` 冲突时，以本文件的决策为准（实现完成后回写进主 spec）。

## 一、用户已拍板的 6 条决策

1. **先评论、再提交代码**。有代码要提交时，顺序必须是：先发 `#ai-*` 指令评论（评论本身会再触发一次 code review），再 commit + push 代码。
   - 推论：一轮里可能产生两次评审（指令触发一次、push 触发一次），watcher 必须能在同一 sha 上因「新评审」再次唤醒。
2. **同一轮不重复推**（re-wake 口径）：FID 集合不变就不重复唤醒；**reason 变更也不重推**。
   - 实现要求：把「是否重推」做成**可切换策略**（配置项或单点函数），将来改成「推」时只动一处，不改数据流。
3. **轮询保持 30s**（可合后也不降频）。
4. **UI 只做计划、暂不实现**：目标是「绑定 MR 的那个会话」里看到：有哪些 MR、出现了哪些问题、哪些修了/没修、没修的用了什么指令。数据全部来自 MR，插件只做数据处理（MR 里有全部痕迹）。UI 形态后续再打磨。
5. **合并收尾不写评论**：`merged` 时只唤醒一次 + 落账本，不发 MR 评论。
6. **findings 按工作区单独沉淀**：把问题（FID 粒度）单独提取、按工作区存放，供以后做「AI 生成代码的规范与评审方向」；插件**只记录，不做分析**。

## 二、由此确定的实现口径

### 2.1 指令（豁免）格式与判定
- 指令来自 MR 评论，一行一条：
  - `#ai-waive <FID> reason=<原因>` —— 已评估风险，允许本次 MR 豁免
  - `#ai-skip <FID> reason=<原因>` —— 不适用于当前场景，无需处理
  - `#ai-wontfix <FID> reason=<原因>` —— 问题客观存在，但业务/设计决定不修
- 解析排除：`>` 引用行、``` 代码块内、`##` 标题行；`reason=` 必须非空，否则记 `invalid`。
- 同一 FID 多条取最新（`note.id` 最大）。
- **判定口径**：有有效指令的 FID 视为已处置，不拦合并（与账本 `decisions` 并存，报告注明来源）。
  - 即使 bot 下一轮仍报同一 FID，也按指令放行（否则豁免失效）。

### 2.2 唤醒
- 唤醒 = 三段指令 + 报告摘要 + **全量问题明细**（FID / 文件:行 / 级别 / 问题 / 建议 / 复验次数）。
- 指令段要点：全部问题由主 agent 决策；可**并行派 subagent**；不修的按 `#ai-*` 回帖；最后必须给结论（修了哪些 / 用了什么指令 / 引用对应 MR 评论）。
- 唤醒去重 key 扩展：`sha + 评审 note.id + findings 签名 + 三套门禁 verdict`。
  - 目的：同 sha 上「评论触发的新评审」能唤醒；同轮重复（含 reason 变更）不唤醒。

### 2.3 写回
- 工具 `mr_waive`：先出草稿（`#ai-waive <FID> reason=<原因>`），主 agent 用 **「可以 / 自定义」** 提问确认，确认后才 `POST /notes`。
- **草稿不落账本**：`waiverDraft` 只返回 body，不写 decisions、不改状态；只有 `post:true` 成功回帖后才写入 `decisions`（失败也不写）。所以「草稿」永远不会被当成已处置。
- **草稿绑定目标**：草稿把 `projectPath/iid/sha/fid/kind/reason/at` 记进会话内存（不入账本，按 `sessionId + FID` 分槽）；post 必须逐字段匹配，未出草稿 → `draft-required`，换绑 / 换 sha → `stale-round`，同一 FID 用新 kind/reason 重新确认后旧草稿作废 → `draft-superseded`，绝不把评论发到另一条 MR。草稿 data 与 message 都带 `MR !<iid> · <project>`。
- **结果未知不重发**：`timeout` / `network` / 5xx / `bad-response` 时评论可能已创建；按 body 全等 + `created_at >= 草稿 at - requestTimeoutMs`（留时钟偏移余量）从 notes 找回，找到返回 `{ posted:true, noteId, url, recovered:true }` 并补写 decisions。
- **跨会话防重**：同一 MR 有其它 live 绑定时拒绝写（`bound-elsewhere`），只读查询不受影响；会话销毁（`session/disposed`）时 `index.js` 调 `service.release` 释放绑定 / 草稿 / 会话锁（不 persist、不 forget），已关闭会话不会永久占住写路径。
- **reason round-trip**：生成 body 后用真实 `parseDirectives` 读回，必须恰好 1 条且 fid/kind/reason 全等，否则 `invalid-reason`（挡住 HTML 注释 / 隐藏块标记导致失真）。
- **落盘失败降级**：回帖成功但账本 persist 失败 → 返回 `{ posted:true, persisted:false, noteId, url, warning }`，不报 storage-failed。
- 回帖成功返回 `{ posted, noteId, url }`（恢复时多 `recovered:true`）；同一 FID 同 kind 已有指令 / 已回帖过 → 幂等返回 `{ posted:false, noteId, existing:true }`，不重复发。
- 发完评论后主 agent 再决定是否 commit/push 代码（顺序约束见决策 1）。
- 不实现 resolve discussion（FID 在评审 note 正文里，无法精确映射 discussion）。

### 2.4 监视
- 终止条件：`merged` / `closed`。`mergeable` **不再停表**（与旧设计不同）。
- `merged`：唤醒一次收尾（只落账本，不评论）。`closed`：唤醒一次说明未合并关闭。
- 轮询 30s 不变；每 tick 仍只 1 次 MR 请求（必要时再拉 notes）。

### 2.5 findings 沉淀（只记录）
- 位置：`~/.dsh/workspace/<workspace>/findings/<project>__<iid>.jsonl`（append-only，不写进用户仓库）。
  - 粒度：**一个工作区 + 一个 MR 一个 JSONL**；`<workspace>` 取 DSH 工作区名，`<project>` 为 GitLab 全路径（`/` 换成 `__`）+ `__<iid>`。
- 每条记录（FID 粒度）：
  `sha / round / noteId / fid / file / lineRange / level / type / gateCategory / problem / suggestion / reverifyCount / firstSeenAt / lastSeenAt / disposition(open|fixed|waived|skip|wontfix) / dispositionSource(noteId 或 ledger)`
- 只在状态变化时追加新行，不重写历史；供后续挖掘，不做任何分析、不参与判定。

## 三、任务拆分（T1/T2 已完成，T3-T5 待开工）

| 任务 | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| T1 读路径 | `parse-directives.js`；`buildRound` 输出 directives/comments；mergeable 接入指令处置；报告加「豁免」行；唤醒带全量问题 + 三段指令；唤醒 key 扩展；`mr_review` 返回 directives/comments | — | 新增 parse-directives 测试 + 既有模块用例；全量 155 → ≥165 全绿 |
| T2 写路径 | `mr_waive` 草稿/回帖/幂等/错误映射；账本 decisions 落盘；`mr_review` 显示来源；「先评论后提交」写进技能规程 | T1 | 工具 + service 用例；全量绿 |
| T3 盯到合并 | 取消 mergeable 停表；merged/closed 收尾唤醒；30s 不变 | — | watcher 用例：可合后继续 tick、merged、closed、去重 |
| T4 findings 沉淀 | 按工作区 append-only JSONL；状态变化才追加 | T1 | 断言文件路径/结构/去重追加 |
| T5 文档与技能 | skill 规程（决策权、并行 subagent、结论格式、先评论后提交、豁免流程）；spec/plan 回写 | T1-T4 | 文档 diff + 全量绿 |
| UI（仅计划） | 客户端插件页：会话内 MR 列表 / 问题 / 修复状态 / 指令；数据来自 MR + 账本 + findings | T1-T4 | **本阶段不实现**，仅保留设计 |

## 四、已确认

1. findings 位置：`~/.dsh/workspace/<workspace>/findings/`（用户确认）。
2. 粒度：一个工作区 + 一个 MR 一个 JSONL（用户确认）。
3. 第三节的 T1-T5 是**开发顺序**，不是运行时写入顺序。

## 五、两种「顺序」不要混淆

**开发顺序（做插件的顺序）**：T1 读路径 → T2 写路径 / T3 盯到合并 → T4 findings 沉淀 → T5 文档技能 →（后续）UI。

**运行时顺序（插件跑起来后的数据流）**：

```
轮询(30s) → 拉 MR/notes → 解析本轮(评审/门禁/指令)
   → ① findings 增量落盘（新 FID=open；FID 消失且有新一轮评审=fixed）
   → ② 有未处置问题/状态变化 → 唤醒主 agent（全量问题 + 已有指令）
   → ③ 主 agent 决策：修哪些 / 放弃哪些
        - 放弃的：#ai-waive 评论（经「可以/自定义」确认）→ POST /notes → 记 waived/skip/wontfix
        - 要修的：改代码 → commit → push（顺序：先评论、后提交）
   → ④ 新一轮评审（指令触发一次 / push 再触发一次）→ 回到 ①
   → ⑤ merged：唤醒一次收尾 + 落账本（不评论）；closed：唤醒说明未合并关闭
```

要点：findings 的**写入时机**是每轮快照后立即增量追加（不等主 agent 决定），主 agent 的决策只改变「同一 FID 的 disposition 字段」并再追加一行，历史行不重写。
