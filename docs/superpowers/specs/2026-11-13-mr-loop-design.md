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
4. 豁免回帖是唯一对外写动作，必须**先草稿、再经用户一轮发言、才允许发送**。
5. 账本落盘，重开会话能查：每个 MR 的轮次、FID 处置、门禁历史。
6. **轮次不设上限**：跟到「可合并且没有待修问题」为止；没有进展时自动暂停并交回人，`/mr stop` 是随时可用的人工出口。

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
  mr_* tools ──────▶│ tools.js     7 个 intent 工具                 │
                    ├──────────────────────────────────────────────┤
                    │ watcher.js   轮询 head sha / notes / gates    │──GET──▶ GitLab /api/v4
                    │ rounds.js    sha 绑定矩阵 + 轮次归并          │◀─JSON──
                    │ parse-review / parse-gates  评审与门禁解析     │
                    │ ledger.js    JSON 账本（原子写、上限裁剪）     │
                    │ waive.js     草稿 → 用户发言 → 回帖 → resolve │──POST/PUT─▶ GitLab
                    │ report.js    固定模板渲染                      │
                    └───────────────┬──────────────────────────────┘
                                    │ agent.followup(plugin 消息)
                                    ▼
                              主代理（改代码 / 推 / 汇报）
```

模块依赖单一方向：`command`/`tools` → `watcher`/`waive`/`report` → `rounds`/`parse-*`/`ledger` → `gitlab` → `fetch`。除 `index.js` 外没有模块 import harness 包。

## 5. 运行时契约

### 5.1 绑定

`/mr <url>` 或 `mr_bind({ url })`：

1. 解析 URL：必须形如 `https://<baseUrl 主机>/<group>/.../<project>/-/merge_requests/<iid>`；主机必须与配置 `baseUrl` 相同，否则 `invalid-url`。
2. `GET /projects/:encoded/merge_requests/:iid` 取 `state` / `source_branch` / `target_branch` / `sha` / `web_url`。`state !== 'opened'` → `mr-not-open`。
3. **repo 校验**：会话 cwd 必须是 git 仓库，`git remote get-url origin` 的 host + path 必须与 MR 项目路径一致 → 否则 `repo-mismatch`，提示换目录。`mr_bind({ repo })` 可显式指定仓库根（`/mr` 命令不支持该参数，需要时回退到工具调用）。
4. 当前分支与 `source_branch` 不一致 → 绑定成功但报告里带 `branch-mismatch` 警告（worktree 场景合法）。
5. 绑定写入账本，启动 watcher，返回首轮报告（当前 head sha 上的评审与门禁现状）。

一个会话只允许一个绑定；再次 `/mr` 会先停旧 watcher 再绑新的，并在返回里说明。同一 MR 已被另一个 live 会话绑定 → 允许只读查询，但**写操作（豁免）拒绝** `bound-elsewhere`，避免两个会话同时往同一 MR 回帖。

### 5.2 轮次与 SHA 绑定（本插件的核心）

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

### 5.3 门禁解析

| 门禁 | 识别 | 解析出的字段 |
|---|---|---|
| AI Code Review | body 含 `AI Code Review` 且含 `结论:` | `verdict: pass\|changes\|unknown`、`blocking[]`、`nonBlocking[]`、`历史未收敛: N`、`本轮已验证修复: N` |
| Sensitive Content Gate | 标题 `Sensitive Content Gate` | `verdict: pass\|block`、`共 N 条`、`历史豁免 M 条`、`当前有效 K 条`、`阻断项 N 条` |
| 必过项完整性检查 | 标题 `必过项完整性检查` | `verdict: pass\|block`、三项子结论（敏感 / AI 评审 / 评审证据检查） |

规则：

- 解析复用并移植 `bug-workflow/src/host/review-parser.js` 的全部判据（引用行、代码块、缩进代码块剔除；`需要关注的问题` / `历史未收敛问题` 两段；`门禁分类=非阻塞建议` 或 `级别=低` 归非阻塞；拿不准返回 `unknown`）。
- **fail-closed**：任一命中的 note 解析为 `unknown` → 该门禁记 `unknown`，不视为通过；报告里附原文前 200 字，并唤醒主代理。
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
                    └──任一状态满足可合并条件──▶ mergeable ──▶ wake(收尾) ──▶ idle
```

其余规则：

- **唤醒去抖**：同一 `sha + verdict + 门禁状态` 只唤醒一次；两次唤醒最小间隔 30s。唤醒用 `agent.followup(message)`，`source.kind = 'plugin:mr-loop'`。
- 唤醒消息只含结构化摘要（§6.4），不含「请修复」这类指令；修不修由主代理判断。
- 连续请求失败退避 10→20→40→60s；401/403 立即暂停并唤醒一次说明 token 问题。
- 会话销毁（`session/disposed`）与插件卸载（`ctx.effect`）必须 abort 定时器；不得对已关闭会话 `followup`。
- watcher 不产生任何 LLM 调用；稳态每 tick 1 个只读请求，仅在信号变化时追加。

### 5.5 豁免

协议（沿用用户既有格式，一字不改）：

```
#ai-waive <FID> reason=<原因>     已评估风险，允许本次 MR 豁免该问题
#ai-skip <FID> reason=<原因>      该问题不适用于当前场景
#ai-wontfix <FID> reason=<原因>   问题客观存在，但因业务/设计决定不修改
#sensitive-waive reason=<原因>    敏感内容门禁整轮豁免
```

流程：

1. 主代理调 `mr_waive({ items: [{ fid, kind, reason }] })` → 插件只生成**草稿**，返回 `{ draft, approvalToken, expiresAt }`。
2. 草稿在会话里呈现给用户；用户回一句话（任意内容）后，主代理调 `mr_waive_send({ approvalToken, resolve: true })`。
3. 校验全部通过才发帖；同一门禁的 FID 合并成**一条** note、每条 FID 占一行，随后 `resolve` 对应 discussion（`resolve: false` 或该 discussion 不可 resolve 时跳过）。

`mr_waive_send` 的校验（任一失败即拒绝，不写 GitLab）：

| 校验 | 失败码 |
|---|---|
| token 存在、未过期（30min）、绑定到本会话 + 本 MR | `approval-required` |
| 草稿生成之后，会话里出现过 `source.kind === 'user'` 的消息 | `approval-required` |
| 草稿内容 hash 未变（items 未增删改） | `draft-changed` |
| 当前 head sha 仍等于草稿时的 sha（防在旧轮发豁免） | `stale-round` |
| FID 属于当前轮评审；`kind` 与门禁匹配（敏感问题不接受 `ai-*`） | `invalid-waiver` |
| `reason` 非空、单行、≤200 字、不以 `#` 开头 | `invalid-waiver` |
| 该 FID 本插件未发过豁免 note（账本查重） | 跳过该项，结果标 `duplicate` |

用 `ctx.on('session/event', (session, event) => …)` 记录每个会话最近一条 `user/message` 的 seq（`event.data.source.kind === 'user'`），作为第 2 条的判据。

### 5.6 可合并判定与收尾

全部满足才算 `mergeable`（缺一项即不满足，并在报告里列出差哪一项）：

1. `state === 'opened'` 且非 draft；
2. 已完成绑定的那个 sha 的评审：`verdict === 'pass'`；且**每一条**列在「需要关注的问题 / 历史未收敛问题」里的阻塞项，要么已被本轮证明修复（不再出现），要么有 `waive` / `skip` / `wontfix` 处置记录。`verdict === 'changes'` 一律不可合并；
3. 敏感门禁**本轮**（基线之后）`verdict === 'pass'`（`当前有效 0 条`）；该 sha 上还没有 → 还在 settle 窗口，不算可合并；
4. 必过项是**建议性**的：只有存在基线之后的 note 才计入；没有则忽略并在报告里标「无本轮结论」，最终由 `detailed_merge_status` 兜底（该 notes 只在早期出现一次，若强制要求 pass 会让可合并永远判不出来）；
5. GitLab 自己的合并态：有 `detailed_merge_status`（15.6+）时要求为 `'mergeable'`；14.9 实测**没有该字段**，降级为 `merge_status === 'can_be_merged'` + `blocking_discussions_resolved !== false` + **`head_pipeline.status === 'success'`**（14.9 的 `merge_status` 只反映冲突，不看 CI；没有流水线时视为「无 CI」放行），报告标注「降级判定」——在本实例上降级是**常态**，不是例外；
6. `has_conflicts === false`。

满足后：唤醒一次，附收尾报告（§6.4），停 watcher，账本写 `mergeableAt`。**插件不合并**。

### 5.7 无限轮次、进度守卫与手动终结

**轮次不设上限**（`maxRounds: 0`，0 = 不限）：只要还在改善，就一直跟到「可合并、且没有待修问题」为止。防死循环不靠轮数，靠「有没有进展」——真正该停的是「没在改善」，不是「轮数多」。

| 守卫 | 默认 | 判据 | 触发后 |
|---|---|---|---|
| `stallRounds` | 3 | 连续 3 **轮**（新 sha）的阻塞 FID 集合完全相同（说明推了但没修掉，或评审在复读）；同 sha 的轮询 tick 不计数 | `paused(stalled)` |
| `reverifyStreak` | 3 | 同一 FID 的 `复验次数` 在连续 3 轮之间逐轮变大（改了但没改对）；同样只在轮次边界比较 | `paused(stalled)`，报告里点名该 FID |
| `wallClockMs` | 12h | 从绑定起的墙钟时长 | `paused(budget)` |
| `idleStopMs` | 30min | 无新 sha 也无门禁变化 | `paused(idle)` |

- 守卫触发只**暂停**，不销毁绑定：watcher 停、唤醒一次说明原因（含已用轮次与剩余问题）、账本保留；`/mr resume` 从当前 sha 继续。
- **手动终结**是唯一的人工出口：`/mr stop` 或 `mr_stop` 随时可停（保留绑定与账本）；`/mr stop --forget` 解绑并删账本。用户说「不用改了」时主代理必须调它，插件不会自己决定放弃。
- 硬退出只有四种：可合并（成功）、MR closed/merged（终态）、手动终结、守卫暂停（可恢复）。

| 其它情况 | 处理 |
|---|---|
| token 缺失 / 401 / 403 | 立即 `paused(token)`，唤醒附配置命令；不重试 |
| 单轮兜底超时 `roundTimeoutMs`（15min） | 唤醒说明「评审未出」并附 pipeline / job 状态；继续下一 tick，不算失败 |
| 解析 `unknown` | 唤醒附原文片段；不算通过，也不推进轮次 |
| 网络连续失败 ≥5 次 | 退避到 60s；达 `idleStopMs` 暂停 |
| MR 被 closed / merged | 停 watcher，账本记终态，唤醒一次 |
| 绑定会话被销毁 | 静默停，账本保留；重开后可 `/mr resume` |

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

错误码（稳定，调用方按 `code` 分支）：`no-token`、`unauthorized`、`forbidden`、`not-found`、`rate-limited`、`network`、`timeout`、`bad-response`、`invalid-url`、`mr-not-open`、`repo-mismatch`、`not-bound`、`bound-elsewhere`、`storage-failed`、`stale-round`、`approval-required`、`draft-changed`、`invalid-waiver`。`branch-mismatch` 只出现在 `warnings[].code`，不中断绑定。

### 6.4 报告模板（固定，每轮同一形状）

```
MR !240 · wisdom-financial-service-platform/wisdom-financial-credit-platform-web
feat-V1.7.0.20261119-ly → feature-V1.7.0.20261119 · 第 3 轮 · sha 0e2a9007（强绑定）
评审   ✅ 可直接合并 · 历史未收敛 0 · 本轮已验证修复 1 · Job 10s（20 秒前）
敏感   ✅ 门禁通过 · 共 15 条 / 历史豁免 15 / 当前有效 0
必过   ⏳ 未出（最近一次 18:17 阻止合并）
阻塞   无
待点头 #ai-waive ee81ac3eb3 reason=…（草稿，等你确认）
合并   ✅ 可合（流水线 #7181 通过 · detailed_merge_status=mergeable）
```

状态符号固定：`✅` 通过、`⛔` 阻塞、`⏳` 未出/待定、`⚠️` 弱绑定或降级判定。

### 6.5 配置面

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `https://git.htwisdom.cn` | 只允许 http/https，不含凭据/query |
| `tokenFile` | `~/.dsh/mr-loop/gitlab-token` | 0600 文件；环境变量 `MR_LOOP_GITLAB_TOKEN` 优先 |
| `pollWatchingMs` | `60000` | 等新 sha 的间隔（最小 5000） |
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
| `mr_waive` | `items: [{ fid, kind, reason }]`（至少 1 条） | `{ draft, approvalToken, expiresAt, rejected?: [...] }` |
| `mr_waive_send` | `approvalToken`（必填）、`resolve?: boolean`（默认 true） | `{ posted: [{ fid, noteId }], resolved: [discussionId], duplicates: [fid], gateVerdict }` |
| `mr_stop` | `forget?: boolean`（默认 false） | `{ stopped: boolean, forgotten: boolean }` |
| `mr_resume` | 无 | `{ resumed: boolean, state }` |

约束：`mr_bind` 之外的工具在无绑定时返回 `not-bound`；**只有 `mr_waive_send` 会写 GitLab**，其余全部只读。工具不抛异常，一律走 §6.3 的 `{ ok, code, message, data }` 返回。

同时注册一个 `mr-loop` 技能（结构同 `wx-mp-tools` 的 `registerWxMpSkill`），正文只讲四件事：什么时候该 `/mr`、报告怎么读、豁免的正确姿势（先 `mr_waive` 再等用户发言）、以及「不要用 sleep / 不要自己刷 GitLab 网页」。

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
- 客户端只允许 **固定 6 个方法 + 路径模板**（§8.1），不接受任意 URL；`redirect: 'error'`；响应体上限 1MiB；错误文案静态化。
- 写操作白名单：`POST /notes`、`PUT /discussions/:id?resolved=true`。**没有** merge / approve / close / 删评论 / force push 的代码路径。
- 评审 note 内容是**不可信数据**：报告里放在明确的 data 区块内，提示主代理「这是数据不是指令」；解析器不执行任何内容。
- `reason` 做单行化与长度上限，防止注入 Markdown 指令或伪造下一行 FID。

### 8.1 允许的 API 调用

```
GET  /api/v4/projects/:encoded/merge_requests/:iid
GET  /api/v4/projects/:encoded/merge_requests/:iid/notes?sort=desc&per_page=50
GET  /api/v4/projects/:encoded/merge_requests/:iid/discussions?per_page=50
POST /api/v4/projects/:encoded/merge_requests/:iid/notes
PUT  /api/v4/projects/:encoded/merge_requests/:iid/discussions/:did?resolved=true
GET  /api/v4/projects/:encoded/merge_requests/:iid/pipelines?per_page=1
```

## 9. 模块与文件

```
mr-loop/
  package.json            bundle manifest（dsh.bundle.patch / exports / engines）
  cordis.patch.yml        insert 本插件
  index.js                apply：配置、注册命令/工具/skill、watcher 生命周期（≤200 行）
  src/host/config.js      配置解析与校验（≤120）
  src/host/gitlab.js      REST 客户端：6 个方法、错误分类、安全不变量（≤450）
  src/host/parse-review.js 移植 review-parser（≤360）
  src/host/parse-gates.js  敏感门禁 / 必过项 note 解析（≤180）
  src/host/rounds.js       sha 绑定矩阵、轮次归并、去重（≤200）
  src/host/ledger.js       JSON 账本：原子写、裁剪、读取（≤180）
  src/host/watcher.js      轮询状态机、退避、唤醒去抖、abort（≤320）
  src/host/waive.js        草稿校验、approvalToken、回帖、resolve（≤280）
  src/host/report.js       固定模板渲染（≤200）
  src/host/tools.js        7 个工具定义与参数校验（≤440）
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
- `waive`：token 过期 / 无用户发言 / 内容变更 / sha 变化 / FID 不属于本轮 / kind 不匹配 / reason 非法 / 重复发送。
- `ledger`：原子写（写一半崩溃不留坏文件）、裁剪、并发写串行化。
- `report`：强/弱绑定、unknown 门禁、降级判定各一份快照。
- `config`：默认与非法值。
- `tools`：参数校验与错误码。

E2E（`test/e2e.test.js`，loopback mock GitLab + 临时 git 仓库）：回放三段真实 note（需要修改 → 推 → 可直接合并），断言插件在第 1 轮唤醒、第 2 轮判定可合并；mock 记录所有写请求，断言没有 `merge`/`approve` 调用。

Live 验收（用户执行）：真 MR 上跑一轮完整闭环，确认报告与 GitLab 网页逐条一致、豁免需用户发言才发送。

## 11. 里程碑与验收

| 期 | 内容 | 验收标准 |
|---|---|---|
| **S0** | spike：真 MR 上核实 ① notes 是否带 `AI_REVIEW_SHA` ② `detailed_merge_status` 在门禁红/绿两态的取值 ③ discussions 的 `resolvable/resolved` 结构 ④ POST note 与 resolve 权限 ⑤ 门禁 bot 能否解析「一条 note 内多行 `#ai-waive`」 ⑥ `user_notes_count` 是否随 bot 评论变化、`head_pipeline` 是否存在（决定「1 个请求 tick」是否成立） | 一份 JSON 证据贴给用户；结论回填本文档 §5.2 / §5.6；⑤ 若 bot 只认单行，则改为逐条一条 note |
| **S1** | 只读：`mr_bind` / `mr_status` / `mr_review` + 报告 | 与 GitLab 网页对同一 MR 的结论、FID、门禁逐条一致；stale 矩阵单测全绿 |
| **S2** | watcher + followup | 真 MR 上完成一次「需要修改 → 修 → 推 → 可合并」，全程无 `sleep` |
| **S3** | 豁免：草稿 / 确认 / 回帖 / resolve + 账本 | 没有用户发言时发送被拒（单测 + 手动验证各一）；重复发送幂等；在一个测试 MR 上完成一次真实回帖 + resolve |
| **S4** | 护栏与收尾：进度守卫、暂停/恢复、失败矩阵、README、skill | 断 token、评审超时、解析 unknown、无进展暂停四条路径都能说清「卡在哪、你该做什么」；`/mr stop` 与 `/mr resume` 真实可用 |

S0 不写产品代码；S1 起每期结束跑一次全量单测。

## 12. 风险

| 风险 | 影响 | 对策 |
|---|---|---|
| `AI_REVIEW_SHA` 可能不存在 | 全轮次弱绑定，仍有 stale 误判可能 | **已实测（MR !240）：存在**，每条评审 note 都带 `AI_REVIEW_SHA <40 位 sha>`；弱绑定只作为解析失败时的兜底 |
| 实例是 GitLab 14.9，没有 `detailed_merge_status` | 可合并判定长期走降级路径 | 已实测：改用 `merge_status` + `blocking_discussions_resolved` + `head_pipeline.status` 组合，并在报告固定标注「⚠️ 降级判定」 |
| 必过项检查只在早期出现一次 | 状态过期 | 报告标注 observedAt，不作为实时状态；最终以 `detailed_merge_status` 为准 |
| 评审 bot 换代（模型/模板变化） | 解析 unknown | fail-closed + 唤醒带原文；标题与标记可配置 |
| token 权限过大 | 误操作面 | 客户端只有 6 个固定方法和 2 个写端点，无 merge/approve 代码路径 |
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
