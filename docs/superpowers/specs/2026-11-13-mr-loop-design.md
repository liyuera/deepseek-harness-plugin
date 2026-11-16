# DSH MR 评审闭环插件（mr-loop）— 设计文档

- 日期：2026-11-13
- 状态：v1 待评审
- 目标运行环境：DSH 0.2.2-rc.1（desktop profile）
- 包名：`@liyuera/dsh-mr-loop`
- 目录：`deepseek-harness-plugin/mr-loop/`
- 来源：会话 `session-ea145625-6b73-48b2-9cb9-ae614fe981ed` turn 3（MR !240，18:15–18:21）的一次真实手动闭环

## 1. 背景：这次会话到底怎么跑的

会话里的做法是「主代理 + Chrome + 固定提示词」：人贴 GitLab MR 标签页 → 主代理 `chrome_read` 拉整页文本 → 自己切出最新一轮 AI Code Review → 改代码 → 跑门禁 → commit/push → `sleep 75` → 重开页面再读 → 循环。

现场证据：

| 环节 | 现场事实 | 风险 |
|---|---|---|
| 读 | 一次 `chrome_read` 返回整页文本，历史评论与 newest 混在一起；判定只依赖 `AI Code Review` 与 `结论:` 两个串 | 无 sha / note-id 绑定，上一轮的「可直接合并」可能被当成本轮结论 |
| 等 | `sleep 75`、`sleep 70` 固定等待；而评审 Job 实测耗时 2m53s / 48s / 10s / 834ms | 读早了 = 假通过；读晚了 = 白等；只能靠运气 |
| 找 | turn 内 9 次 `chrome_eval`，大半在猜 DOM 选择器（`.timeline-entry`、`[data-testid="discussion"]`、`li.discussion` 均未命中正确结构） | 「1 个未解决的主题」「合并按钮是否可用」只能读网页态，无法证明 |
| 回 | waive 是两套协议（`#ai-waive <FID> reason=`、敏感门禁 `#sensitive-waive reason=`），还要手动「解决主题」；本 MR 那次是人在网页上手打的 | 格式 / FID / 漏 resolve 任一错，门禁仍判「未通过」 |
| 记 | 哪条 FID 已修、哪条已豁免、哪条复验仍失败，只存在于对话上下文 | 重开会话即丢；本次靠 `create_goal` 撑 12 轮 |

两个结构性事实：

1. **门禁是三套**，不是一套：AI Code Review、Sensitive Content Gate、必过项完整性检查。本 MR 真正卡住合并的是敏感门禁（15 条命中，人工豁免 + 后续改文档去掉内网 IP/URL 才收敛），只盯 AI review 会漏。
2. **最有价值的动作是判断而不是改**：评审建议「从弹窗 `shared.ts` 导入枚举」，主代理否定并改为提到页面级 `constants.ts` 做单一来源。插件不应接管这类判断。

结论：这段流程里真正该被自动化的只有四件事——**读得准、等得对、回得规范、有账本**；修代码由主代理做，合并由人点。

## 2. 目标与非目标

目标：

1. 一条 `/mr <url>` 绑定后，插件自己盯住这个 MR 的评审与门禁，主代理不再靠 `sleep` 或反复刷页面。
2. 每轮判定有**可证的归属**：一条评审属于哪个 sha、哪一轮，要么有证据，要么标 `stale`/`unknown`，绝不猜。
3. 三套门禁统一成一个状态面，`unknown` 不当 `pass`（fail-closed）。
4. 豁免回帖是唯一对外写动作，必须**先草稿、再经用户「可以 / 自定义」确认、才允许发送**（未确认绝不发）。
5. 账本落盘，重开会话能查：每个 MR 的轮次、FID 处置、门禁历史。
6. **轮次不设上限**：跟到 MR 合并（或关闭）为止——可合后**继续监视**，不停表；未可合时「没进展」才自动暂停并交回人，`/mr stop` 是随时可用的人工出口。

非目标（v1 明确不做）：

- 不改代码、不派修复子代理。修由主代理做（§7）。
- 不生成 commit message、不建 MR、不合并、不 approve、不 close。插件不执行任何写操作的 git 命令；只允许 `git remote get-url origin` 与 `git rev-parse --abbrev-ref HEAD` 两条只读命令用于绑定校验（§5.1）。
- 不做 client 半边：没有右栏 tab、没有状态行、没有设置页。
- 不支持多个 GitLab 实例并存，只认一个 `baseUrl`。
- 不做 Jira / Issues 集成，不做跨 MR 聚合看板。
- 不自动 resolve 与门禁无关的讨论（例如人之间的讨论）。

## 3. 术语

| 术语 | 含义 |
|---|---|
| 绑定 | 一个会话与一个 MR（`projectPath!iid`）的关联，带 repo 校验 |
| 轮次 | MR head sha 变化后的一次「评审 → 处置」周期 |
| head sha | `GET /merge_requests/:iid` 返回的 `sha`，MR 当前最新提交 |
| 评审 note | body 同时含 `AI Code Review` 与 `结论:` 的 note（判据来自 `review-parser`） |
| 门禁 | 三套必过项，各自有 note 与结论 |
| FID | 评审 note 里每条问题的稳定 id（`finding_id` 的可读形式） |
| 处置 | 对一条 FID 的处理。`waive` / `skip` / `wontfix` 由人点头后记账；`fix` 由跨轮比较**推断**（上一轮阻塞、本轮未再出现或计入「本轮已验证修复」）；其余为 `pending` |
| 可合并 | 插件判定「此刻满足合入条件」，不等于插件执行合并 |
| 强绑定 / 弱绑定 | 评审 note 与轮次的归属证据强度（§5.2） |

## 4. 总体架构

```
                    ┌──────────── Host 半边（无 client）────────────┐
  /mr <url> ───────▶│ command.js   绑定 + 首轮报告 + status/stop    │
  mr_* tools ──────▶│ tools.js     6 个工具（含 mr_waive 写路径）   │
                    ├──────────────────────────────────────────────┤
                    │ watcher.js   轮询 head sha / notes / gates    │──GET──▶ GitLab /api/v4
                    │ rounds.js    sha 绑定矩阵 + 轮次归并          │◀─JSON──
                    │ parse-review / parse-gates  评审与门禁解析     │
                    │ ledger.js    JSON 账本（原子写、上限裁剪）     │
                    │ service.js   绑定编排 + 草稿 / 确认 / 回帖     │──POST────▶ GitLab
                    │ report.js    固定模板渲染                      │
                    └───────────────┬──────────────────────────────┘
                                    │ agent.followup(plugin 消息)
                                    ▼
                              主代理（改代码 / 推 / 汇报）
```

模块依赖单一方向：`command`/`tools` → `service`/`watcher`/`report` → `rounds`/`mergeable`/`parse-*`/`ledger` → `gitlab` → `fetch`。除 `index.js` 外没有模块 import harness 包。

## 5. 运行时契约

### 5.1 绑定

`/mr <url>` 或 `mr_bind({ url })`：

1. 解析 URL：必须形如 `https://<baseUrl 主机>/<group>/.../<project>/-/merge_requests/<iid>`；主机必须与配置 `baseUrl` 相同，否则 `invalid-url`。
2. `GET /projects/:encoded/merge_requests/:iid` 取 `state` / `source_branch` / `target_branch` / `sha` / `web_url`。`state !== 'opened'` → `mr-not-open`。
3. **repo 校验**：会话 cwd 必须是 git 仓库，`git remote get-url origin` 的 host + path 必须与 MR 项目路径一致 → 否则 `repo-mismatch`，提示换目录。`mr_bind({ repo })` 可显式指定仓库根（`/mr` 命令不支持该参数，需要时回退到工具调用）。
4. 当前分支与 `source_branch` 不一致 → 绑定成功但报告里带 `branch-mismatch` 警告（worktree 场景合法）。
5. 绑定写入账本，启动 watcher，返回首轮报告（当前 head sha 上的评审与门禁现状）。重复绑定同一 MR 时若 head sha 未变，**不新增轮次**：复用账本最后一轮的轮次号并覆盖其快照（保留该轮 `observedAt` 基线）；只有 head sha 变化才开新一轮（§5.2）。

一个会话只允许一个绑定；再次 `/mr` 会先停旧 watcher 再绑新的，并在返回里说明。同一 MR 已被另一个 live 会话绑定 → 允许只读查询，但**写操作（豁免）拒绝** `bound-elsewhere`，避免两个会话同时往同一 MR 回帖。

### 5.2 轮次与 SHA 绑定（本插件的核心）

**轮次以 head sha 为界**：同一 sha 上重复绑定 / 重复观测都复用当前轮次，不新增；只有 head sha 变化才开启新一轮（`n + 1`）。重绑（无论 head 是否已前进）都会先把账本尾部连续同 sha 的段收敛为 `n` 最小的一条；尾部条目的 `n` 缺失 / 非正整数不复用。

每轮记录 `{ n, sha, observedAt, baselineAt, notes: { review?, sensitive?, mandatory? } }`。`baselineAt` 是本轮的时间基线：优先取该 sha 的 `head_pipeline.created_at`（流水线只为当前 sha 跑，等价于 push 时间），取不到时退回 `observedAt`（本轮 sha 首次观测时间）。这样「绑定前评审就已存在」的 MR 也能被正确归属，而不是一律判 stale。

watcher 每 tick 拉 `notes?per_page=50&sort=desc`（过滤 `system: true`），按下列矩阵归属：

| 证据 | 判定 | 标记 |
|---|---|---|
| note 含 `<!-- AI_REVIEW_SHA <sha> -->` 且等于本轮 sha | 属于本轮 | 强绑定 |
| note 含该标记但不等于本轮 sha | 丢弃 | `stale` |
| 无标记，`created_at >= baselineAt`，且标题匹配 `AI Code Review (src -> target)` | 属于本轮 | 弱绑定 |
| 无标记，`created_at < observedAt` | 丢弃 | `stale` |
| 多条命中同一 sha | 取 `note.id` 最大的一条 | — |

弱绑定在报告里显式标注「弱绑定（无 SHA 证明）」，并在可合并判定里按 `unknown` 处理——**弱绑定的 `pass` 不能单独授权合并**（§5.3 的 fail-closed 规则）。sha 标记是否真实存在由 S0 spike 核实；缺失时全轮次都会走弱绑定，功能仍可用，但报告会一直提示。

> **T1（2026-11-16）补充：每轮快照还带两类只读数据。** `directives` = 评论里 `#ai-waive / #ai-skip / #ai-wontfix` 指令的解析结果，`comments` = 其余人类评论最近 5 条（`{ noteId, author, createdAt, excerpt }`，excerpt 单行化 ≤120 字）。两者只给主代理决策用，不改变 sha 绑定矩阵与 stale 判定。
>
> **有界结构（C1，防账本 / 工具返回膨胀）**：`round.directives = { directives, invalid, truncated }`，评论原文单独放 `round.directiveNotes`
> - `directives`：≤50 条（按 `note.id` 降序留最新），每条只留 `{ kind, fid, reason, noteId, author, createdAt }`，**不复制评论正文**；
> - `directiveNotes`：`round.directiveNotes`，≤20 条 `{ noteId, body（单行化 ≤500） }`，按 noteId 去重、最新优先，替代原来「每条指令复制整条 body」；
> - `invalid`：`{ count, samples（前 5 条） }`，不逐条落盘；
> - `truncated`：`{ directives, directiveNotes, notes, lines }`，记录被 cap 掉 / 未扫描的量；单条评论只扫前 5000 行 / 200KB。
>
> **来源可信（I2）**：只有「非系统 + 不是评审 note + 不是敏感/必过门禁 note」的评论才交给指令扫描；扫描前剔除 HTML 注释（`<!-- ... -->`，含 `AI_REVIEW_*` 标记）与 `备注：以下隐藏数据仅用于统计` 之后的隐藏块。评审 / 门禁正文或注释里写 `#ai-*` 不生效，避免机器人或引用文本自己放行自己。

### 5.3 门禁解析

| 门禁 | 识别 | 解析出的字段 |
|---|---|---|
| AI Code Review | body 含 `AI Code Review` 且含 `结论:` | `verdict: pass\|changes\|unknown`、`blocking[]`、`nonBlocking[]`、`历史未收敛: N`、`本轮已验证修复: N` |
| Sensitive Content Gate | 标题 `Sensitive Content Gate` | `verdict: pass\|block`、`共 N 条`、`历史豁免 M 条`、`当前有效 K 条`、`阻断项 N 条` |
| 必过项完整性检查 | 标题 `必过项完整性检查` | `verdict: pass\|block`、三项子结论（敏感 / AI 评审 / 评审证据检查） |

规则：

- 解析复用并移植 `bug-workflow/src/host/review-parser.js` 的全部判据（引用行、代码块、缩进代码块剔除；`需要关注的问题` / `历史未收敛问题` 两段；`门禁分类=非阻塞建议` 或 `级别=低` 归 `nonBlocking`；拿不准返回 `unknown`）。
- **分组只影响展示，不影响可合判定**：`blocking` / `nonBlocking` 里的每一条 finding 都算「需要关注的问题」；只有拿到 `waive` / `skip` / `wontfix` 处置记录才不再计入（§5.6 第 2 条）。旧口径「低级别 / 非阻塞建议不拦合并」已废弃。
- **fail-closed**：任一命中的 note 解析为 `unknown` → 该门禁记 `unknown`，不视为通过；报告里附原文前 200 字，并唤醒主代理。但可合判定对三套门禁的处置不同：评审 `unknown` 拦；敏感 `unknown` **不拦**（只有 `block` 才拦，§5.6 第 3 条）；必过项只在 `block` 时拦（建议性）。
- 必过项 note 可能只在早期出现一次、之后不再重发（本 MR 观察到），因此它的状态是「最近一次观测值 + observedAt」，报告里标注时间，不冒充实时。
- 同一 sha 上同一门禁出现多条 → 取最新 id。

### 5.4 等待与唤醒

不是 `sleep`，也不是「只能等」：GitLab 不提供可订阅的推送通道（没有 WebSocket / GraphQL subscription；webhook 要求 **GitLab 服务端能访问你的机器** 且你至少有项目 Maintainer 权限，见 ADR-9），所以唯一可靠通道是**查询**。本插件把查询做成「一个便宜 tick + 变化才拉详情」：

每次 tick 只发 **1 个请求**：`GET /merge_requests/:iid`，它同时带回 `sha`、`head_pipeline.status`、`detailed_merge_status`、`user_notes_count`。只有下列之一变化才追加拉 `notes`（必要时再拉 `discussions` / `pipelines`）：

- `sha` 变了（有新提交）；
- `user_notes_count` 变了（有新评论）；
- `head_pipeline.status` 变成终态；
- `detailed_merge_status` 变了。

节拍随状态变（可配，§6.5）：

| 状态 | 间隔 | 说明 |
|---|---|---|
| 等新 sha（watching） | 60s | 主代理在改代码，MR 不会变 |
| 等评审（awaiting） | 10s | 流水线在跑 |
| 门禁 settle / 回帖后复判 | 15s | 通常 30–90s 出结论 |
| 兜底超时 | 15min | 只在「流水线没跑 / 评审 job 挂了」时用得上 |

流水线信号优先于时间：

- `head_pipeline.status ∈ {failed, canceled}` → **立刻**唤醒，附 job 名与失败原因（评审可能根本没跑，不必等到超时）；
- `success` 且 60s 内没有本轮评审 note → 唤醒「流水线通过但评审未产出」；
- MR 没有挂 CI（无 `head_pipeline`）→ 直接按 notes 轮询，间隔 20s。

状态机：

```
idle ──bind──▶ watching(sha) ──head sha 变化──▶ awaiting(sha, since)
                    │                                   │
                    │                                   ├─ 评审 note 到位 ──▶ settled ──▶ wake ──▶ watching
                    │                                   ├─ 其余门禁未定 ──▶ gateSettle 窗口（≤3min）──▶ wake
                    │                                   └─ 流水线失败 / 超时 ──▶ wake ──▶ watching
                    └──任一状态满足可合并条件──▶ mergeable ──▶ wake(可合) ──▶ 继续轮询（不停表）
                                                                 │
                                                                 ├─ merged ──▶ wake(已合并收尾) ──▶ idle
                                                                 └─ closed ──▶ wake(未合并关闭) ──▶ idle
```

其余规则：

- **终止条件是 `merged` / `closed`，可合不是终点（决策 §2.4）**：`mergeable` 只唤醒一次（去重 key `mergeable:<sha>`，正文=报告 + `可合并，继续监视到合并。`）后**不停 watcher**，继续按 §5.4 / §6.5 的原节拍轮询，不因可合降频、也不新加 30s 轮询特例（30s 是唤醒最小间隔）。`merged` 时唤醒一次 `MR !<iid> 已合并（sha <sha>），监视结束；不需要发评论。` 并停表（**不写 MR 评论**）；`closed` 时唤醒一次 `MR 已关闭（未合并），监视结束。` 并停表。同一 `(state, sha)` 的终态只唤醒一次，会话被下一句话重新拉起也不会重复推。
- **唤醒去抖**：同一 `sha + 评审 note.id + findings 签名（FID + 级别 + 复验次数的稳定序列）+ 三套门禁 verdict` 只唤醒一次；两次唤醒最小间隔 30s。唤醒用 `agent.followup(message)`，`source.kind = 'plugin:mr-loop'`。同 sha 上「评论触发的新评审」（note.id 或 findings 签名变化）必须能再唤醒；同一轮内容不变（含豁免 reason 变更）不重复唤醒。
- 有未处置 finding（`reviewTodo.total > 0`）时，唤醒正文固定三段：**动作指令段 → 报告 → 全量问题明细段**。
  - 指令段：`有 N 处评审问题待处置（FID …）：全部问题见下方明细，修哪些由你决定；可以按问题分组并行派 subagent。`；已有有效指令时补一条 `已收到 M 条 MR 指令（#ai-waive/#ai-skip/#ai-wontfix），对应 FID 已计入豁免。`（**M 只算真正命中本轮的豁免数 `reviewTodo.waived.length`**，不是评论里的指令总数）；有格式不对的指令时再补 `另有 K 条 #ai-* 指令格式不对，未生效。`；最后 `不打算改的用 mr_waive 出草稿，经用户「可以 / 自定义」确认后 post:true 回帖（#ai-skip / #ai-wontfix 同理）；最后给出结论：修了哪些、用了什么指令、并引用对应 MR 评论。`
  - 明细段：每条 `问题 i/N · FID · 级别 · 门禁分类 · file:line` 换行 `  问题：…` `  建议：…` `  复验次数：…`；只列未处置 finding（已豁免的不进），每个字段单行化并截断 ≤200 字。
  - 没有待处置问题时不加指令段与明细段，唤醒正文只有报告，避免噪音。
- 摘要本身仍只陈述事实、不含「请修复」这类指令；指令只属于唤醒这一层，修不修由主代理判断。
- 连续请求失败退避 10→20→40→60s；401/403 立即暂停并唤醒一次说明 token 问题。
- 会话销毁（`session/disposed`）与插件卸载（`ctx.effect`）必须 abort 定时器；不得对已关闭会话 `followup`。会话销毁还要**释放该会话的内存绑定 / 草稿 / 会话锁**（`service.release`，不 persist、不 forget）：否则已关闭会话会永久留在 `listStates()`，挡住其它会话对同一 MR 的写（`bound-elsewhere`）。
- watcher 不产生任何 LLM 调用；稳态每 tick 1 个只读请求，仅在信号变化时追加。

### 5.5 豁免（写路径，T2）

协议（沿用用户既有格式，一字不改）：

```
#ai-waive <FID> reason=<原因>     已评估风险，允许本次 MR 豁免该问题
#ai-skip <FID> reason=<原因>      该问题不适用于当前场景
#ai-wontfix <FID> reason=<原因>   问题客观存在，但因业务/设计决定不修改
#sensitive-waive reason=<原因>    敏感内容门禁整轮豁免（本阶段不实现）
```

流程（用户 2026-11-16 拍板）：

1. 主代理决定某条 finding 不修 → `mr_waive({ fid, kind, reason })`（`post` 默认 false，`kind` 默认 `waive`）→ 插件只生成**草稿** `{ body, fid, kind, reason, mrLabel }`，**不写账本、不改 decisions、不发 MR 评论**；同时把确认目标（`projectPath / iid / sha / fid / kind / reason / at`）记进**会话内存**。
   - 会话销毁时由 `index.js` 调 `service.release({ sessionId })` 释放绑定 / 草稿 / 会话锁（不落账本、不删账本）。
2. 主代理把草稿（首行带 `MR !240 · group/project`）给用户看，用 **「可以 / 自定义」** 确认；用户确认后才 `mr_waive({ fid, kind, reason, post: true })` → `POST /projects/:id/merge_requests/:iid/notes` 发一条 `#ai-waive|skip|wontfix <FID> reason=<原因>`。
   - **草稿绑定目标（C1）**：post 前必须与最近一次草稿逐字段匹配（会话 / MR / sha / FID / kind / reason）；没出草稿 → `draft-required`，确认后换绑或 sha 变了 → `stale-round`，**绝不把评论发到另一条 MR**。
   - **多槽与取代（M-1）**：草稿按 `sessionId + FID` 分槽保存；同一 FID 重新出草稿会覆盖该 FID 的旧草稿，用旧 kind / reason post → `draft-superseded`（与 `stale-round` 区分）；post 只消费自己那条草稿，不碰其它 FID 的草稿。
   - **跨会话防重（I2）**：同一 MR 已被其它 live 会话绑定 → 写操作拒绝 `bound-elsewhere`（只读查询不受影响），避免两边 decisions / 账本互相覆盖。
3. 发成功后插件把 `decisions[fid] = { kind, reason, noteId, at, source: 'comment' }` 写进状态并落账本；**只有回帖成功才写**，失败与草稿都不写；成功后清掉会话草稿。
   - **结果未知可恢复（I1）**：`timeout` / `network` / 5xx / `bad-response` 时评论可能已创建；改用 `GET notes` 按「body 全等 + `created_at >= 草稿 at - requestTimeoutMs`（留时钟偏移余量）」找回，找到则补写 decisions 并返回 `{ posted: true, noteId, url, recovered: true }`，找不到才抛错——不盲目重发。
   - **落盘失败降级（M2）**：回帖已成功但账本 persist 失败时返回 `{ posted: true, persisted: false, noteId, url, warning }`，不报 `storage-failed` 让模型误以为没发出去。
4. 幂等：当前轮已有同 FID 同 kind 的 MR 指令，或本会话已回帖过同 kind → 返回 `{ posted: false, noteId, existing: true }`，不再发；同 FID 已有其它 kind 的处置 → `already-disposed`（不重复回帖）。
5. **先评论、后提交代码**：评论本身会触发一次新评审；主代理发完评论再 commit + push，然后 `mr_status` 看新一轮。
6. 不实现 resolve discussion：FID 在评审 note 正文里，无法精确映射到 discussion。

`mr_waive({ post: true })` 的校验（任一失败即拒绝，不写 GitLab）：

| 校验 | 失败码 |
|---|---|
| `kind ∈ {waive, skip, wontfix}`（缺省 `waive`） | `invalid-kind` |
| FID 符合解析器格式 `[A-Za-z0-9_-]{4,64}`（回帖要能被读回）且属于**当前轮**评审的 finding（大小写不敏感，回帖用评审原文大小写） | `unknown-fid` |
| FID 尚未处置（账本 decisions 与 MR 指令都没有），幂等命中除外 | `already-disposed` |
| `reason` 单行化（控制符/零宽字符剔除）后含可见字符，≤200 字；且用真实解析器 round-trip 必须恰好读回 1 条同 fid / kind / reason（挡住 `<!-- -->`、隐藏统计块标记导致失真） | `invalid-reason` |
| 未先出草稿 / 草稿已被消费 | `draft-required` |
| 草稿之后换绑或 sha 变化 | `stale-round` |
| 同一 FID 已用新 kind / reason 重新确认过，旧草稿作废 | `draft-superseded` |
| 其它 live 会话已绑定同一 MR | `bound-elsewhere` |
| 同一会话的写操作串行（复用绑定锁）；并发两次 post 只发一条，第二次命中 `existing` | — |
| 401 / 403 写权限 / 404 / 429 / 409 / 网络 / 超时 / token | `unauthorized` / `permission-denied` / `not-found` / `rate-limited` / `conflict` / `network` / `timeout` / `no-token` |
| 响应结构异常 / 未知内部错误（非 GitlabError 用静态文案，不回显上游原文） | `bad-response` / `internal` |

**草稿不算处置（M4）**：只有 MR 里真实出现的 `#ai-*` 指令，或回帖成功写进 `decisions` 的处置，才参与合并判定；`waiverDraft` 不碰 `decisions`、不写账本、不改 `round` 状态。看板/报告沿用「账本 + round.directives」读路径，无需为草稿改口径。

### 5.6 可合并判定与收尾

全部满足才算 `mergeable`（缺一项即不满足，并在报告里列出差哪一项）：

1. `state === 'opened'` 且非 draft；
2. 已完成绑定的那个 sha 的评审：`verdict === 'pass'`，且**三个计数全部为 0**：
   - **需要关注的问题** = 「需要关注的问题」+「历史未收敛问题」两段里的**全部** finding，**不再区分 `blocking` / `nonBlocking`**（低级别、非阻塞建议同样计入）；排除已有 `waive` / `skip` / `wontfix` 处置记录的条目后必须为 0。`fix` / `pending` / 空壳对象都不算处置。
   - **历史未收敛问题** = note 的 `历史未收敛: N` 必须为 `0`。字段缺失（`null`）表示 note 没写这个字段，无法证明为 0，按 fail-closed 判不可合，报告写「历史未收敛问题未声明」。
   - **本轮新增** = 上述未处置 finding 中 `复验次数` 缺失或 `<= 1`（首次被本轮评审看到）的条数，必须为 0。它与「需要关注的问题」有重叠，但报告里单独显示，用户能一眼看到本轮新出现几处。
   `verdict === 'changes'` 或弱绑定一律不可合并；报告同时显示 `发现 N（本轮新增 M）` 与 `历史未收敛 X`，FID 最多列 3 个、级别随行。
3. 敏感门禁**只有**本轮（基线之后）`verdict === 'block'` 才拦合并：`pass` 放行；`unknown` 与「本轮无结论」**不拦合并**，但报告如实显示并明确标注「不拦合并」（14.9 上该 bot 并非每次重发；旧口径「非 pass 即拦」已废弃）。`block` 报告为 `⛔ 阻止合并 · 有效 N 条 / 阻断项 M`。
4. 必过项是**建议性**的：只有存在基线之后的 note 才计入；没有则忽略并在报告里标「— 无本轮结论（建议性）」，解析失败标「— 未解析（建议性）」；最终由 `detailed_merge_status` 兜底（该 notes 只在早期出现一次，若强制要求 pass 会让可合并永远判不出来）；
5. GitLab 自己的合并态：有 `detailed_merge_status`（15.6+）时要求为 `'mergeable'`；14.9 实测**没有该字段**，降级为 `merge_status === 'can_be_merged'` + `blocking_discussions_resolved !== false` + **`head_pipeline.status === 'success'`**（14.9 的 `merge_status` 只反映冲突，不看 CI；没有流水线时视为「无 CI」放行），报告标注「降级判定」——在本实例上降级是**常态**，不是例外；
6. `has_conflicts === false`。

> **口径修正（2026-11-16，真机验收后）**：可合 = 结论 pass + 需要关注 0 + 历史未收敛 0 + 本轮新增 0；任何未处置 finding（含低 / 非阻塞建议）都拦；敏感门禁只有 `block` 才拦。旧版本「低 / 非阻塞建议不拦合并」「敏感非 pass 即拦」的表述作废。

满足后：唤醒一次（正文=报告 + `可合并，继续监视到合并。`，去重 key `mergeable:<sha>`），**不停 watcher**，继续轮询到 `merged` / `closed`；账本写 `mergeableAt`。`merged` 时唤醒一次收尾（**只落账本、不写评论**，§2.4）；`closed` 时唤醒说明未合并关闭。**插件不合并**。

### 5.7 无限轮次、进度守卫与手动终结

**轮次不设上限**（`maxRounds: 0`，0 = 不限）：可合后**继续盯到 MR 合并 / 关闭**（§2.4），不是「可合即收工」。防死循环不靠轮数，靠「有没有进展」——真正该停的是「没在改善」，不是「轮数多」；而「等待合并」不属于「没改善」（见下）。

同 sha 重绑复用轮次号与 `observedAt` 基线，但守卫计时（`stallStreak` / `reverifyStreak` / `lastProgressAt` / `startedAt`）从重绑时刻重新开始——这些计数本来就不落账本。

| 守卫 | 默认 | 判据 | 触发后 |
|---|---|---|---|
| `stallRounds` | 3 | 连续 3 **轮**（新 sha）的阻塞 FID 集合完全相同（说明推了但没修掉，或评审在复读）；同 sha 的轮询 tick 不计数 | `paused(stalled)` |
| `reverifyStreak` | 3 | 同一 FID 的 `复验次数` 在连续 3 轮之间逐轮变大（改了但没改对）；同样只在轮次边界比较 | `paused(stalled)`，报告里点名该 FID |
| `wallClockMs` | 12h | 从绑定起的墙钟时长 | `paused(budget)` |
| `idleStopMs` | 30min | 无新 sha 也无门禁变化 | `paused(idle)` |

- 守卫触发只**暂停**，不销毁绑定：watcher 停、唤醒一次说明原因（含已用轮次与剩余问题）、账本保留；`/mr resume` 从当前 sha 继续。
- **可合后不触发进度守卫（决策 §2.4）**：等待合并期间跳过 `stallRounds` / `reverifyStreak` / `idleStopMs`（等待合并不是「没进展」，否则永远等不到 `merged`）；`maxRounds` 同理不生效。`wallClockMs` 墙钟预算仍兜底（超时暂停可 `/mr resume`）；单轮兜底超时 `roundTimeoutMs` 保持「只唤醒一次、不停表」语义不变。
- **手动终结**是唯一的人工出口：`/mr stop` 或 `mr_stop` 随时可停（保留绑定与账本）；`/mr stop --forget` 解绑并删账本。用户说「不用改了」时主代理必须调它，插件不会自己决定放弃。
- 硬退出只有三种：MR `merged` / `closed`（终态）、手动终结、守卫暂停（可恢复）。**可合不是硬退出**：可合后继续监视，直到合并 / 关闭。

| 其它情况 | 处理 |
|---|---|
| token 缺失 / 401 / 403 | 立即 `paused(token)`，唤醒附配置命令；不重试 |
| 单轮兜底超时 `roundTimeoutMs`（15min） | 唤醒说明「评审未出」并附 pipeline / job 状态；继续下一 tick，不算失败 |
| 解析 `unknown` | 唤醒附原文片段；不算通过，也不推进轮次 |
| 网络连续失败 ≥5 次 | 退避到 60s；达 `idleStopMs` 暂停 |
| MR 被 closed / merged | 停 watcher，账本记终态，唤醒一次（merged：收尾不评论；closed：说明未合并关闭） |
| 绑定会话被销毁 | 静默停，账本保留；重开后可 `/mr resume` |

### 5.8 findings 沉淀（T4，只记录）

把每条 FID 的问题单独提取、按工作区沉淀，供以后做「AI 生成代码的规范与评审方向」；**只记录，不做分析 / 统计 / 上报，不参与任何判定，也不写进用户仓库**。

- 位置：`<findingsDir>/<workspace>/findings/<projectPath 的 / 换成 __>__<iid>.jsonl`（append-only，默认 `findingsDir = ~/.dsh/workspace`）。
  - `<workspace>` = 仓库根目录名（`basename(binding.repoRoot)`，取不到用 `unknown`）；
  - 粒度：一个工作区 + 一个 MR 一个 JSONL；目录 `0700`、文件 `0600`（与账本一致）；
  - 实例如：`~/.dsh/workspace/wisdom-financial-credit-platform-web/findings/wisdom-financial-service-platform__wisdom-financial-credit-platform-web__240.jsonl`；
  - 单文件超过 `findingsMaxBytes`（默认 5 MiB）滚动成 `<name>.1.jsonl`（只保留一代）。
- 每行一条（v1）：`{ v:1, at, workspace, projectPath, iid, sha, round, fid, file, line, level, type, gateCategory, problem, suggestion, reverifyCount, status, instruction: {kind, reason, noteId}|null }`；文本字段单行化并截断（problem / suggestion ≤ 500、file ≤ 300），控制字符压掉。
- `status ∈ open | fixed | waived | skip | wontfix`：复用 `mergeable.js` 的处置口径（MR 评论里的有效 `#ai-*` 指令 + 账本 `decisions` + 与上一轮 FID 对比），`src/host/findings.js` 的 `collectFindings(record)` 同时供 UI 与落盘使用，避免两处漂移。
- 只在状态变化时追加：同一 MR 内以 `(fid, status, instruction.kind, instruction.noteId)` 为键去重；进程启动后第一次写某文件前读回已有文件（含滚动的 `.1`）建立键集合，跨重启不重复；坏行 / 超大文件按「尽力而为」处理（坏行跳过）。
- 触发点：`bind` 成功后、`applySnapshot` 更新后（新轮或同 sha 刷新）、`mr_waive` 回帖写 `decisions` 后；统一走一个 fire-and-forget 的 `record(state)`，写失败只 `log warn`，**绝不打断绑定 / 监视 / 回帖**。
- 配置：`findingsDir`（默认 `~/.dsh/workspace`）、`findingsMaxBytes`（默认 `5242880`）。

## 6. 数据契约

### 6.1 评审 / 门禁 → 结构化

```js
ReviewRound = {
  sha, n, observedAt, binding: 'strong' | 'weak',
  review: { noteId, verdict, blocking: Finding[], nonBlocking: Finding[],
            historicalUnresolved: number, verifiedFixed: number, jobDuration: string } | null,
  sensitive: { noteId, verdict, total, waived, effective, blocking } | null,
  mandatory: { noteId, verdict, items: { sensitive, review, evidence } } | null,
  dropped: [{ noteId, reason: 'stale' | 'duplicate' }],
}
Finding = { fid, file, level, gateCategory, location, problem, suggestion, reverifyCount }
```

字段缺失一律 `null` 或 `unknown`，不猜默认值。`reverifyCount` 对应 note 里的 `复验次数`，移植时要在 `FIELD_KEY` 里补这一项（上游 parser 目前丢弃它）。

### 6.2 账本（JSON 文件，非 storageDomain）

路径：`~/.dsh/mr-loop/ledger/<project-slug>-<iid>.json`，`0600`，写用临时文件 + `rename` 原子替换。

```json
{
  "version": 1,
  "binding": { "projectPath": "...", "iid": 240, "repoRoot": "...",
               "sourceBranch": "...", "targetBranch": "...", "boundAt": "..." },
  "rounds": [ /* 每轮：sha / observedAt / binding / 三套门禁解析结果 / dropped[] */ ],
  "decisions": { "<fid>": { "kind": "waive", "reason": "...", "noteId": 123, "at": "..." } },
  "mergeableAt": null,
  "terminal": null,
  "paused": null,
  "updatedAt": "..."
}
```

`rounds[]` 只存每轮的解析结果；`decisions` 是**按 FID 平铺**的最新处置（同一 FID 跨轮只留一条，带 `at` 与 `noteId`）。上限：保留最近 20 轮、200 条处置，超出丢弃最旧（并在文件里记 `trimmed: n`）。**不用 storageDomain** 的理由见 ADR-5。

### 6.3 工具返回与错误码

统一返回 `{ ok: boolean, code?: string, message: string, data?: object }`；`message` 为静态中文，不含 token、URL、上游原文。

错误码（稳定，调用方按 `code` 分支）：`no-token`、`unauthorized`、`forbidden`、`permission-denied`、`not-found`、`rate-limited`、`network`、`timeout`、`bad-response`、`invalid-url`、`mr-not-open`、`repo-mismatch`、`not-bound`、`storage-failed`、`invalid-kind`、`unknown-fid`、`already-disposed`、`invalid-reason`、`draft-required`、`stale-round`、`draft-superseded`、`bound-elsewhere`、`conflict`、`internal`。`branch-mismatch` 只出现在 `warnings[].code`，不中断绑定。`permission-denied` 只出现在写路径：403 在读路径是 `forbidden`（可能只是仓库不可见），在发评论时是 token 缺 `api` 写权限。

### 6.4 报告模板（固定，每轮同一形状）

```
MR !240 · wisdom-financial-service-platform/wisdom-financial-credit-platform-web
feat-V1.7.0.20261119-ly → feature-V1.7.0.20261119 · 第 3 轮 · sha 0e2a9007（强绑定）
评审   ⛔ 需要修改 · 发现 2（本轮新增 2，已豁免 2） · 问题已全部豁免 · 历史未收敛 0 · 本轮已验证修复 1 · Job 10s（20 秒前）
敏感   ✅ 门禁通过 · 共 15 条 / 历史豁免 15 / 当前有效 0
必过   — 无本轮结论（建议性）
阻塞   无
豁免   ee81ac3eb3 · #ai-waive（评论 #75200） · 风险已评估；c3d4e5f6a7 · #ai-wontfix（评论 #75201） · 遗留文件本轮不动
指令   ⚠️ 无效指令 1 条（格式不对，未生效）
合并   ✅ 可合 · 流水线 #7181 success
```

状态符号固定：`✅` 通过、`⛔` 阻塞、`⏳` 未出/待定、`⚠️` 弱绑定或降级判定、`—` 无结论 / 字段缺失占位。

口径补充（T1 / 首轮评审反馈）：

- `评审` 行的「发现 N」= 本轮评审的**全部** finding（含已被 MR 指令豁免的）；`本轮新增 M` 统一为**全部 finding** 口径（与 `reviewTodo.fresh` 同源），有豁免时括号里补 `，已豁免 K`，所以全部豁免时仍能看出「发现 2（本轮新增 2，已豁免 2）」。`合并` / `阻塞` 行用未处置口径（扣掉账本处置与指令豁免），两者不矛盾：一个说「发现过多少」，一个说「还差多少」。
- **I3（verdict=changes + 问题全豁免）**：当 `verdict === 'changes'` 但 `reviewTodo.total === 0` 且 `historicalUnresolved === 0` 时，verdict 不再计入 `missing`；报告评审行仍如实写 `⛔ 需要修改`，并在后面补 ` · 问题已全部豁免`，合并行照常按剩余缺口判定（可能是 ✅ 可合）。
- `豁免` 行只在有有效指令时出现：`FID · #ai-waive|skip|wontfix（评论 #noteId） · reason 摘要`，多条用 `；` 连接，超过 3 条折叠 `等 N 条`；账本 decisions 的处置不重复展示（它没有可引用的评论）。
- `指令` 行只在有无效指令时出现：`⚠️ 无效指令 N 条（格式不对，未生效）`，只给条数，不展开原始行。
- 报告没有「待点头」行：草稿不落账本、不写 decisions，所以不存在可展示的草稿状态；「草稿不算处置」的唯一口径见 §5.5。
- 缺口文案里的「本轮新增」只强调**未处置**的子集（`其中 N 处本轮新增未处置`），与评审行的全部 finding 口径用标签区分。

报告永远是纯事实：有未处置 finding 时，动作指令只加在唤醒消息的正文前（§5.4），不改变报告的形状与「差 N 项」的口径。

门禁行的失败与非失败态：

- 敏感门禁：`block` → `⛔ 阻止合并 · 有效 N 条 / 阻断项 M`（拦合并）；`unknown` → `⏳ 未解析（不拦合并）`；本轮无结论 → `— 无本轮结论（不拦合并）`。
- 必过项：本轮无结论 → `— 无本轮结论（建议性）`；解析失败 → `— 未解析（建议性）`。
- 「阻塞」行列出**所有未处置 finding**（含 `nonBlocking`），格式 `FID · 级别 · 门禁分类`，多个用 `；` 连接；超过 3 条用 `等 N 条` 收口。

### 6.5 配置面

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `https://git.htwisdom.cn` | 只允许 http/https，不含凭据/query |
| `tokenFile` | `~/.dsh/mr-loop/gitlab-token` | 0600 文件；环境变量 `MR_LOOP_GITLAB_TOKEN` 优先 |
| `pollWatchingMs` | `30000` | 等新 sha / 等合并的轮询间隔（最小 5000；可合后保持 30s） |
| `pollAwaitingMs` | `10000` | 等评审的间隔 |
| `pollSettleMs` | `15000` | 门禁 settle / 回帖复判 |
| `pollNoPipelineMs` | `20000` | MR 没挂 CI 时的兜底间隔 |
| `roundTimeoutMs` | `900000` | 单轮兜底超时（15min），只在流水线无信号时生效 |
| `gateSettleMs` | `180000` | 评审出后等其余门禁的窗口 |
| `maxRounds` | `0` | 0 = 不限轮次（默认）；>0 才启用轮次上限 |
| `stallRounds` | `3` | 阻塞集合连续不变即暂停 |
| `reverifyStreak` | `3` | 同一 FID 复验次数连续递增即暂停 |
| `wallClockMs` | `43200000` | 总时长预算（12h） |
| `idleStopMs` | `1800000` | 无变化暂停（30min） |
| `requestTimeoutMs` | `15000` | 单请求 |
| `reviewMarker` | `AI Code Review` | note 正文标记 |
| `reviewTitlePrefix` | `AI Code Review (` | 弱绑定标题匹配 |
| `sensitiveTitle` | `Sensitive Content Gate` | 门禁 note 标题 |
| `mandatoryTitle` | `必过项完整性检查` | 门禁 note 标题 |
| `ledgerKeepRounds` | `50` | 账本裁剪 |
| `findingsDir` | `~/.dsh/workspace` | findings 沉淀根目录（按工作区分子目录；不写进用户仓库） |
| `findingsMaxBytes` | `5242880` | 单 MR JSONL 滚动阈值（5 MiB；滚动只保留一代 `.1`） |
| `enabled` | `true` | 关闭后只有工具与命令、无 watcher |

### 6.6 命令与工具面

命令（`ctx.commands.register`，`handler({ agent, rawInput, signal })`，返回 `{ kind: 'success'|'error', text }`）：

| 命令 | 行为 |
|---|---|
| `/mr <url>` | 绑定 + 首轮报告（同 `mr_bind`） |
| `/mr status` | 输出当前绑定与状态的完整报告 |
| `/mr resume` | 从 `paused` 恢复监视（守卫暂停、空闲暂停、token 修好后） |
| `/mr stop` | 停 watcher，保留绑定与账本 |
| `/mr stop --forget` | 解绑并删除账本 |

工具（`ctx.tools.register`，参数为 object-rooted JSON Schema，`additionalProperties: false`）：

| 工具 | 参数 | 返回 `data` |
|---|---|---|
| `mr_bind` | `url`（必填）、`repo`（可选，覆盖 cwd） | `{ binding, round, report, warnings }` |
| `mr_status` | 无 | `{ binding, headSha, round, gates, decisions, mergeable, nextWakeAt, paused: null \| { reason: 'stalled'\|'budget'\|'idle'\|'token', at } }` |
| `mr_review` | `history?: boolean`（默认 false） | `{ round, review, sensitive, mandatory }`；`history: true` 时附账本内最近 `ledgerKeepRounds` 轮的摘要 |
| `mr_waive` | `fid`（必填）、`kind?: 'waive'\|'skip'\|'wontfix'`（默认 `waive`）、`reason`（必填）、`post?: boolean`（默认 false） | 草稿：`{ body, fid, kind, reason, mrLabel, posted: false }`，message 带 MR 标识与「可以 / 自定义」确认要求；回帖：`{ posted, noteId, url }`，恢复未知结果时带 `recovered: true`，落盘失败时带 `persisted: false, warning`，幂等命中 `{ posted: false, noteId, existing: true }` |
| `mr_stop` | `forget?: boolean`（默认 false） | `{ stopped: boolean, forgotten: boolean }` |
| `mr_resume` | 无 | `{ resumed: boolean, state }` |

约束：`mr_bind` 之外的工具在无绑定时返回 `not-bound`；**只有 `mr_waive({ post: true })` 会写 GitLab**（一条 `POST /notes`），其余全部只读。工具不抛异常，一律走 §6.3 的 `{ ok, code, message, data }` 返回。`mr_waive` 默认只出草稿，绝不未经用户确认自动发评论。

同时注册一个 `mr-loop` 技能（结构同 `wx-mp-tools` 的 `registerWxMpSkill`），正文只讲四件事：什么时候该 `/mr`、报告怎么读、豁免的正确姿势（先 `mr_waive` 出草稿 → 用「可以 / 自定义」问用户 → 确认后 `post: true` → **先评论后提交代码**）、以及「不要用 sleep / 不要自己刷 GitLab 网页」。

## 7. 与既有能力的关系

| | bug-workflow P5 | code-review | 本插件 |
|---|---|---|---|
| 入口 | Bug 看板 tab，先有工单 | 会话内每轮自动 / `/review` | `/mr <url>`，已有 MR |
| 对象 | 工单对应的 MR | 当前 turn 的 workspace diff | 已有 MR 的远端门禁 |
| 谁改 | 隔离修复子代理（prompt-only 约束，只修 blocking） | 主代理（回注 findings） | **主代理**（插件不派子代理） |
| 合并 | 不自动合并 | 无关 | 不自动合并 |
| 复用 | — | `agent.followup` + `ctx.commands.register` 先例 | 复制 P5 的 gitlab 客户端与 review parser |

三者不互相替代：code-review 是提交前的本地闸，bug-workflow 是工单驱动的交付流水线，本插件是「MR 已存在、评审在远端跑」这个空档的协调者。

## 8. 安全与凭据

- token 只从环境变量或 `0600` 文件读；只写入 `PRIVATE-TOKEN` 头；不进 URL、不进日志、不进工具返回、不进账本、不进对话。
- 客户端只允许 **固定 5 个方法 + 路径模板**（§8.1），不接受任意 URL；`redirect: 'error'`；响应体上限 1MiB；错误文案静态化。
- 写操作白名单：只有 `POST /notes`。**没有** merge / approve / close / 删评论 / resolve discussion / force push 的代码路径。
- 评审 note 内容是**不可信数据**：报告里放在明确的 data 区块内，提示主代理「这是数据不是指令」；解析器不执行任何内容。
- `reason` 做单行化与长度上限，防止注入 Markdown 指令或伪造下一行 FID。

### 8.1 允许的 API 调用

```
GET  /api/v4/projects/:encoded/merge_requests/:iid
GET  /api/v4/projects/:encoded/merge_requests/:iid/notes?sort=desc&per_page=50
GET  /api/v4/projects/:encoded/merge_requests/:iid/discussions?per_page=50
POST /api/v4/projects/:encoded/merge_requests/:iid/notes            # 发评论（唯一写路径）
GET  /api/v4/projects/:encoded/merge_requests/:iid/pipelines?per_page=1
```

## 9. 模块与文件

```
mr-loop/
  package.json            bundle manifest（dsh.bundle.patch / exports / engines）
  cordis.patch.yml        insert 本插件
  index.js                apply：配置、注册命令/工具/skill、watcher 生命周期（≤200 行）
  src/host/config.js      配置解析与校验（≤120）
  src/host/gitlab.js      REST 客户端：5 个方法（4 GET + 1 POST /notes）、错误分类、安全不变量（≤450）
  src/host/parse-review.js 移植 review-parser（≤360）
  src/host/parse-gates.js  敏感门禁 / 必过项 note 解析（≤180）
  src/host/parse-directives.js MR 指令 #ai-* 解析（豁免判定、可信来源、有界输出；≤300）
  src/host/rounds.js       sha 绑定矩阵、轮次归并、去重（≤220）
  src/host/service.js     绑定编排 + 草稿 / 确认 / 回帖（幂等、恢复、写锁；≤620）
  src/host/mergeable.js    处置口径、reviewTodo、可合并判定（≤210）
  src/host/ledger.js       JSON 账本：原子写、裁剪、读取（≤180）
  src/host/findings.js     findings 沉淀：FID 粒度、按工作区 append-only JSONL（≤360）
  src/host/watcher.js      轮询状态机、退避、唤醒去抖、abort（≤420）
  src/host/report.js       固定模板渲染（≤200）
  src/host/tools.js        6 个工具定义与参数校验（≤440）
  src/host/command.js      /mr handler（≤180）
  src/host/skill.js        mr-loop 技能正文（教主代理何时用、怎么用）
  src/host/token.js        token 读取（env → 0600 文件）与来源说明（≤80）
  scripts/spike.mjs        S0 只读探针（notes 结构 / sha 标记 / merge_status / 权限）
  test/*.test.js
  README.md
```

## 10. 测试策略

单测（`node --test test/*.test.js`，全部无网络、无 hosts 依赖）：

- `parse-review`：移植 bug-workflow 的边界表（引用行、代码块、缩进代码、坏输出、pass 无条目、`历史未收敛: 0 条`）。
- `parse-gates`：敏感门禁通过/阻止两种正文；必过项三子项；缺字段降级。
- `rounds`：sha 绑定矩阵全枚举（强 / 弱 / 丢弃（stale）/ 多命中），至少 12 个用例，含「push 后立刻读到上一轮 note」这一现场 failure 模式。
- `watcher`：假定时器 + 假 fetch，覆盖 head 变化、评审先到、门禁后到、流水线失败、兜底超时、401、连续失败退避、唤醒去抖、会话销毁、四类守卫暂停（stall / reverify / wallClock / idle）与 `/mr resume`；另断言稳态 tick 只发 1 个请求、`user_notes_count` 不变时不拉 notes。
- `waive`（service + tools + 真实接缝）：草稿不落账本；非法 kind / FID / reason；`post` 必须先出草稿（`draft-required`）；草稿后换绑或 sha 变化（`stale-round`）；同 FID 新草稿取代旧草稿（`draft-superseded`）；多 FID 草稿互不覆盖；跨会话重复写（`bound-elsewhere`）与会话销毁 `service.release` 释放后恢复可写；重复 post 幂等；结果未知（timeout / network / bad-response）按 body + 超时余量找回已创建评论（`recovered`）；persist 失败降级（`persisted:false`）；并发 post 只发一条。
- `ledger`：原子写（写一半崩溃不留坏文件）、裁剪、并发写串行化。
- `findings`：路径（工作区 / projectPath 转义 / MR 分文件）、append-only 且只在状态变化时追加、跨重启去重、文本单行化 / 截断、坏行容错、目录 0700 / 文件 0600、超阈值滚动；service 三个触发点与「失败只 warn 不打断」；`collectFindings` 与 UI 同口径。
- `report`：强/弱绑定、unknown 门禁、降级判定各一份快照。
- `config`：默认与非法值。
- `tools`：参数校验与错误码。

E2E（`test/e2e.test.js`，loopback mock GitLab + 临时 git 仓库）：回放三段真实 note（需要修改 → 推 → 可直接合并），断言插件在第 1 轮唤醒、第 2 轮判定可合并；mock 记录所有写请求，断言没有 `merge`/`approve` 调用。

Live 验收（用户执行）：真 MR 上跑一轮完整闭环，确认报告与 GitLab 网页逐条一致、豁免需用户发言才发送。

## 11. 里程碑与验收

| 期 | 内容 | 验收标准 |
|---|---|---|
| **S0** | spike：真 MR 上核实 ① notes 是否带 `AI_REVIEW_SHA` ② `detailed_merge_status` 在门禁红/绿两态的取值 ③ discussions 的 `resolvable/resolved` 结构 ④ POST note 权限（确认没有 approve / merge / resolve 代码路径） ⑤ 门禁 bot 能否解析「一条 note 内多行 `#ai-waive`」 ⑥ `user_notes_count` 是否随 bot 评论变化、`head_pipeline` 是否存在（决定「1 个请求 tick」是否成立） | 一份 JSON 证据贴给用户；结论回填本文档 §5.2 / §5.6；⑤ 若 bot 只认单行，则改为逐条一条 note |
| **S1** | 只读：`mr_bind` / `mr_status` / `mr_review` + 报告 | 与 GitLab 网页对同一 MR 的结论、FID、门禁逐条一致；stale 矩阵单测全绿 |
| **S2** | watcher + followup | 真 MR 上完成一次「需要修改 → 修 → 推 → 可合并」，全程无 `sleep` |
| **S3** | 豁免：草稿 / 确认 / 回帖 / 幂等 + 账本 | 草稿不算处置；未出草稿或用户未确认时 post 被拒（`draft-required`）；重复 post 幂等；结果未知时按 body 找回而不是重发；在一个测试 MR 上完成一次真实回帖（不 resolve discussion） |
| **S4** | 护栏与收尾：进度守卫、暂停/恢复、失败矩阵、README、skill | 断 token、评审超时、解析 unknown、无进展暂停四条路径都能说清「卡在哪、你该做什么」；`/mr stop` 与 `/mr resume` 真实可用 |

S0 不写产品代码；S1 起每期结束跑一次全量单测。

## 12. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| `AI_REVIEW_SHA` 可能不存在 | 全轮次弱绑定，仍有 stale 误判可能 | **已实测（MR !240）：存在**，每条评审 note 都带 `AI_REVIEW_SHA <40 位 sha>`；弱绑定只作为解析失败时的兜底 |
| 实例是 GitLab 14.9，没有 `detailed_merge_status` | 可合并判定长期走降级路径 | 已实测：改用 `merge_status` + `blocking_discussions_resolved` + `head_pipeline.status` 组合，并在报告固定标注「⚠️ 降级判定」 |
| 必过项检查只在早期出现一次 | 状态过期 | 报告标注 observedAt，不作为实时状态；最终以 `detailed_merge_status` 为准 |
| 评审 bot 换代（模型/模板变化） | 解析 unknown | fail-closed + 唤醒带原文；标题与标记可配置 |
| token 权限过大 | 误操作面 | 客户端只有 5 个固定方法和 1 个写端点（POST /notes），无 merge/approve/resolve 代码路径 |
| watcher 空转 | 无谓请求 | 稳态每 tick 1 个请求；空闲 30min 暂停 + `/mr stop` |
| 轮次不限、反复推送 | 反复占用 CI 与远端审查 bot | 用「无改善」守卫暂停（§5.7）+ 12h 预算 + 人工终结；不设轮次硬上限 |
| 同一 MR 两会话同时绑 | 重复回帖 | 进程内绑定 registry + 账本；写操作要求绑定会话，非绑定会话拒绝 |
| 两个 DSH 进程同时写同一账本文件 | 后写覆盖先写 | v1 已知限制（单机单实例）；`updatedAt` 只用于诊断，不做合并 |
| 主代理未推就等 | 空等一轮 | watcher 只认 head sha 变化，不认 agent 自述 |
| 内网 GitLab 限流 | 轮询失败 | 退避 + 401/403 立即停 |

豁免 note 的粒度已定：**同一门禁一次发送合并成一条 note，每条 FID 占一行**（少打扰门禁 bot 的解析，也便于人读）；若 S0 发现 bot 只认单行，则退化为逐条一条 note，接口不变。

## 13. 已定决策（ADR）

| # | 决策 | 理由 | 放弃了什么 |
|---|---|---|---|
| 1 | 数据面走 GitLab REST API，不走浏览器 | 网页路线无法证明归属与合并态，选择器脆；API 有 note id、sha、`detailed_merge_status` | 无需 token 的便利；每次都要配一次凭据 |
| 2 | 复制 `gitlab.js` / `review-parser.js` 进新包 | 仓库约定「每个插件独立安装、互不依赖」；两文件本来零依赖且有单测 | 与 bug-workflow 共享一份代码 |
| 3 | 修由主代理做，插件不派修复子代理 | 本次会话证明主代理会否定不最优的评审建议（页面级常量 vs 弹窗内部导入）；隔离子代理按建议改，缺少「这条建议本身不对」的动机 | 无人值守时不能自动完成修复 |
| 4 | 豁免需「草稿 → 用户发言 → 发送」 | 豁免是对外的书面承诺，写多了会盖住真问题 | 全自动闭环的便利 |
| 5 | 账本用 JSON 文件而非 storageDomain | 免 peer 依赖、可人肉查看；bug-workflow 的 v2 domain 迁移踩过版本兼容坑 | 多进程并发写需要文件锁（v1 只在单进程内串行化，见 §12） |
| 6 | v1 无 client 半边 | 价值在正确性与唤醒，不在可视化；先跑顺再谈状态行/看板 | 一眼可见的常驻状态 |
| 7 | token 放 0600 文件（env 优先） | 无设置页时最省事的方案，且不进对话/日志 | 与 DSH credentials 服务统一管理（v2 迁移） |
| 8 | 轮次不限，用「无进展」守卫代替轮次上限 | 需求是「跟到可合为止」；轮数多不等于有问题，同一问题反复不清才是 | 极端情况下 CI 被长时间占用（12h 预算 + 暂停兜底） |
| 9 | 等待只用轮询，webhook 不列入任何一期 | 用户已明确只做轮询；GitLab 也没有 WebSocket / GraphQL 订阅，webhook 还要求服务端能访问本机且至少 Maintainer 权限 | 事件驱动的实时性：评审出结论到唤醒最慢约一个 tick（10s） |
