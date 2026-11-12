# code-review v0.4 设计提案：把生态共识落到我们的 turn 闭环

依据：`2026-11-11-code-review-gap-analysis.md`（MR238 实测暴露的不足）与
`2026-11-11-code-review-ecosystem-research.md`（DSH 生态 14+ 插件对标）。
本文回答三件事：**对比别人我们差在哪、抄什么、按什么顺序做**。

## 1. 目标与非目标

目标（按价值排序）：

1. **提精度**：误报不能变成主 agent 的修复指令。证据不足的 finding 不阻塞、不修。
2. **对齐团队口径**：规则严重度/例外/修复策略与团队 AI Code Review 一致，避免"我们比门禁更严"。
3. **可审计**：每轮审了什么、没审什么、复验结果、被抑制的问题都要留痕；`/review` 给结论边界。
4. **接住大改动**：支持 `base..head` 范围审查、分块、预算与超时自适应。
5. **可度量**：建立离线评测语料与质量口径，改 prompt/规则不再靠手感。

非目标（明确不做的）：不做客户端 diff 页/行内评论/undo UI（`@yangzhe1991`、`dsh-file-review-tab`）；
不做多引擎 CLI 调用（`yutingzhao1991/dsh-review`）；不做全项目代码图谱（`dsh-review-graph`）；
不做同 turn 自审 + steer（`dsh-review-gate`，与我们"独立审查者 + 后台）路线相反）；不接管 GitLab/GitHub API。

保持不变量：turn-stopping 异步触发 → 独立只读子代理 → findings 回灌修复轮；`maxRounds`/指纹去重/熔断；
规则 severity 权威；journal 内存降级；reviewer preset 只读工具面。

## 2. 差距 → 生态做法 → 我们的方案

| 不足 | 生态怎么做（证据） | v0.4 采纳 | 阶段 |
| --- | --- | --- | --- |
| P0-1 无 MR/任意 diff 入口 | `@michengai` 四范围 `/review`；`dsh-review-loop` checkpoint 增量；`@feng0531` preview+execute | `/review --range <base>..<head>`、`/review --patch <file>`（宿主侧只读 git 取证，子代理只审不取证） | R3 |
| P0-2 大 diff 容量不成立 | `@feng0531` 三层字节预算+分块+召回轮；`dsh-logistics` unit 切块；`dsh-review-format-guard` 三重期限 | 分块 + 块间限流(≤2) + 每块独立超时 + 总预算；预算不足显式报 `unaccounted` | R3 |
| P1-1 证据无机械化 | `@feng0531` anchor 逐字校验/attribution/receipt；`@stardustlc` introducedBy+witness 校验；`dsh-review` 证伪 verifier；Codex rubric"introduced in commit" | finding 增加 `evidence.snippet` + `introducedBy`，宿主校验；medium+ 加只读 verifier 证伪，失败/不确定降为"仅报告" | R1 |
| P1-2 规则口径不一致 | Codex rubric 8 条判定标准；团队 CR-006.05 例外；`@stardustlc` 规则从 base 读（防本轮放宽） | MNT-016 补单行例外；MNT-011 降为非阻塞；规则增加 `fixMode`/`blocking` 元数据；每链冻结 rulePack hash | R1 |
| P1-3 无修复策略 | 团队 `auto_safe/manual_only/forbidden`；`@stardustlc` 敏感路径强制 deep 且不可降级 | finding 带 `fixMode`；生成代码/契约/权限/迁移类只报告不自动修；只有 `auto` 命中才注入修复指令 | R1 |
| P1-4 无人工决策记忆 | `adversarial-review` suppress 规则；`@stardustlc` `posted/repeats/disposition`；`@feng0531` ledger 未再见不自动关闭 | config + 仓库内 `.dsh/code-review-suppressions.json` 抑制；fingerprint 跨轮 `repeats`；不自动关闭旧问题 | R1/R2 |
| P2-1 规则缺口 | 团队规范原文；bot 的批量参数/数据完整性判据 | 新增 BEH-009（替换语义下解析/读取失败不得静默丢弃）、BEH-010（批量参数随数据量增长需分批/限流），生成代码口径写入准则 | R1 |
| P2-2 无质量回归 | `@feng0531` evaluation 合同（预注册分母、null≠0、哈希绑定）；`dsh-auto-review` bench | `evaluation/cases/*` 合成样本 + 离线 pipeline 回归；模型质量按"预注册分母 + 人工裁决"文档化 | R2 |
| P2-3 输出不可审计 | `dsh-logistics` coverage 契约；`@feng0531` 7 分区+措辞降级 | `coverage` 块 + finding fingerprint/FID + journal 扩展 + `/review` 分区与边界声明 | R1/R2 |
| P2-4 预算/超时不自适应 | 见 P0-2；`@feng0531` 共享 reader 账本 | `timeoutFor(bytes)` 线性加时 + 上限；`maxFileDiffBytes` 单文件上限；`rangeMaxChunks` 总闸 | R3 |
| P2-5 生成代码噪声 | `dsh-review-gate` `alwaysFullGlobs` 反向思路 | `generatedGlobs` 跳过/降级（默认只报规则命中），敏感路径升 full | R3 |

## 3. R1（0.4.0）：证据、复验、口径、修复策略

### 3.1 REVIEW_SCHEMA v2

```jsonc
{
  "findings": [{
    "ruleId": "COR-003",
    "dimension": "correctness",
    "severity": "medium",
    "location": "src/x.ts:42",
    "problem": "……",
    "suggestion": "……",
    "evidence": {                        // 新增，必填（turn 模式）
      "snippet": "const stale = await fetch()",   // 逐字源码行（可多行，\n 连接）
      "side": "new"                               // new | old，默认 new
    }
  }],
  "coverage": {                          // 新增，强烈建议（R1 warn / R2 enforce）
    "files": [
      { "path": "src/x.ts", "status": "reviewed" },
      { "path": "src/y.ts", "status": "skipped", "reason": "binary" }
    ]
  }
}
```

- `evidence.snippet`：**必须来自本轮变更行**（turn/range 模式）或**当前文件内容**（full 模式）；
  prompt 明确"给不出逐字片段 = 证据不足，不要报"。
- `coverage.files`：路径必须 ⊆ 本次送审文件；status ∈ `reviewed|sampled|skipped`；skipped 必须给 reason；
  宿主计算 `unaccounted = 送审文件 - coverage 文件`，进 journal 与报告。
- 兼容策略：新增字段先 `warn`（缺失记 `evidenceMissing`，不丢 finding；`coverage` 缺失记 `coverageMissing`），
  统计 2 个版本后再切 `enforce`（默认配置 `evidenceMode: 'warn' | 'enforce'`，0.4 默认 warn；等真实数据确认模型遵守率）。

### 3.2 宿主校验（reviewer.js `validateStructured`）

1. **片段校验**（turn/range）：从 `collect()` 的 `hunks` 提取变更行集合（`+`/`-` 去标记），
   snippet 每行 `trim()` 后必须命中某个变更行；否则 `EVIDENCE_MISMATCH`，该 finding 丢弃。
2. **引入行校验**：`location` 的行号必须落在该文件 hunk 的 new 侧范围内（`newStart..newStart+newLines-1`，
   `newLines===0` 时取 `newStart`）；否则视为"旧代码冒充新问题"，丢弃。
3. **full/range 模式**：full 模式无 hunk，改用宿主读取文件当前内容（`cwd + path`，realpath 校验、
   64KB/文件上限，见 `src/host/readfile.js`）校验 snippet；range 模式有 hunk 走 1/2。
4. 全部 finding 被丢弃 → `invalid-result`（维持现状，绝不等于"通过"），journal 记录原因码。
5. 诊断码：`EVIDENCE_MISMATCH | LOCATION_OUTSIDE_HUNK | EVIDENCE_UNREADABLE`，只记数量，不回显原文。

> 取舍：片段比对 **去首尾空白、逐行匹配**（不是完整缩进逐字），接受少量"格式漂移"换模型可用性；
> 与 `@feng0531` 的逐字严格不同，但足以杀掉"凭记忆编代码/引用旧代码"。

### 3.3 复验（verifier）——直击 P1-1

新增 `src/host/verify.js`：

- 触发：存在 severity ∈ `blockingSeverities` 的 finding 时，最多验 `maxVerifiedFindings`（默认 3，按严重度排序）。
- 每个 finding 一个独立激活（同一只读 preset，`label: 'code-review-verify'`），prompt 只给：
  finding（rule/location/problem/evidence）+ 送审文件清单；**不给原 reviewer 的推理**。
- verifier prompt 关键句（借鉴 `dsh-review`，已按我们口径改写）：
  - "你的任务是**证伪**，不是附和。默认 `confirmed: false`，只有尝试证伪失败后才确认。"
  - "检查：引用的代码是否真实存在且可达？声称的输入/状态是否真的会发生？是否已有别的保护？"
  - "能复现就复现；不能复现时必须给出反驳理由。不得提出修复方案，不得修改文件。"
- `VERDICT_SCHEMA = { confirmed: boolean, reason: string, witnesses: string[] }`；
  `confirmed===true` 且 `reason.length>=12` 才算证实。
- 归并（确定性）：
  - confirmed → 保留，`verified: true`，正常参与阻塞/修复；
  - rejected 或 verifier 超时/失败 → `verified: 'unverified'`，**降为仅报告（notify-only）**，不触发修复轮；
  - 不计入 `MAX_FINDINGS` 的排序变化，只在渲染/回灌里加"未复验"标签。
- 预算：`verifyTimeoutMs`（默认 180s）与总预算共用；verifier 依次执行（并发 1），会话释放/插件卸载时 abort。
- 配置：`verify: 'off' | 'blocking'`（默认 `blocking`，因为只有出现阻塞 finding 才付钱）；`maxVerifiedFindings` 默认 3。

### 3.4 规则口径对齐

- `rules/rules.json` / packs 增加可选字段：`blocking: boolean`（默认 true）、`fixMode: 'auto'|'manual'|'forbidden'`（默认 auto）。
- **MNT-011**（500 行）：团队 CR-010.03 为**非阻塞建议** → 改 `severity: 'low'`（保留规则，仍可在 notifySeverities 里提示）。
- **MNT-016**（大括号）：团队 CR-006.05 允许"单行语句例外" → 改写 `check`，明确单行 return/break/continue 与
  单行 case 语句可例外，不再按多行标准要求大括号。
- 每条规则补 `sourceId` 已存在；新增规则：
  - `BEH-009`（behavior，medium）：解析/读取失败不得在替换语义的写回路径上静默丢弃；失败必须显式反馈/中止。
  - `BEH-010`（behavior，low）：批量接口参数随数据量线性增长时必须分批/限流/设上限。
- 生成代码口径写进 `REVIEW_GUIDE`：命中 `generatedGlobs` 的文件只报"由生成器配置/契约导致"的问题，
  不把生成代码风格当缺陷；能定位到源模板/配置的，引用源。
- **误报负向清单**写进 `REVIEW_GUIDE`（借鉴 `dsh-command-code-review` 的 false-positive 清单）：
  不报 pre-existing 问题、不报未修改行上的问题、不报 linter/typechecker 能抓的问题、不报纯风格、
  不报 AGENTS.md/规则已显式豁免的问题、不报"资深工程师不会提"的 nit。
- **每链冻结规则**：链开始时记录 `rulesHash = sha256(规则文件+packs 内容)`，链内不再重读规则；
  防止"本轮放宽本轮标准"（借鉴 `@stardustlc` 从 base commit 读 policy）。

### 3.5 Fix Policy（自动修复边界）

- 分类函数 `classifyFixMode(finding, config)`：
  1. 规则显式 `fixMode` 优先；
  2. 路径命中 `manualFixGlobs`（默认：`**/generated/**`、`**/*.generated.*`、`**/*.d.ts`、`**/contracts/**`、
     `**/migrations/**`、`**/auth/**`、`**/payment/**`、`**/.github/workflows/**`）→ `manual`；
  3. 其余 `auto`。
- 回灌语义：
  - `auto` 阻塞项 → 现有"请修复"指令（维持）；
  - `manual` 阻塞项 → 单独一段"**需人工确认，请勿自动修改**"，只报位置/原因/建议方向，不写"请修复"；
  - 若阻塞项全部为 `manual` → 整条只作为通知消息（走 `notify` 渲染），不触发修复轮。
- `/review` 报告同样标注 `[manual]`；journal 记录 `fixMode`。
- 配置：`respectFixPolicy: true`（默认）、`manualFixGlobs`。

### 3.6 抑制（wontfix/waive）记忆

- 配置 `suppressions: [{ id?, ruleId?, pathGlob?, anchor?, fingerprint?, key?, reason, disposition?, expiresAt?, author? }]`
  （严格校验：`reason` 必填；`expiresAt` 为 ISO 日期；`disposition ∈ wontfix|false-positive|intentional|accepted-risk`）。
- 仓库文件 `.dsh/code-review-suppressions.json`（可用 `suppressionsFile` 改），每次审查读取（≤64KB，解析失败只 warn）。
  团队 bot 的 `#ai-wontfix` 目前无法自动同步；这个文件就是人工裁决的桥：把 wontfix/waive 决策写进仓库，
  插件每轮遵守，review 报告里显示"已抑制 N 条（原因）"。
- 匹配顺序（借鉴 `adversarial-review` 的 suppress 规则并补其洞）：
  1. `fingerprint` 精确匹配；
  2. `anchor`（ruleId + path + snippet）或 `ruleId + pathGlob`；
  3. `key`（问题标题关键词）+ `pathGlob` 兜底；
  4. 过期自动失效；命中计数/最后命中时间写入 journal（`hitCount`/`lastHitAt`）。
- 被抑制的 finding **不参与阻塞、不注入，但仍随报告输出**（"已抑制：ruleId path 原因"），绝不静默消失。
- 同一会话跨轮重复：journal 记录 fingerprint，`repeats` 递增并在报告里标"第 N 次报告（尚未修复）"；
  **不自动抑制**（重复通常意味着没修，要持续可见）。
- 与增量的关系：`fullReview`/链累积解决的是"**审查范围**收窄"；抑制/指纹解决的是"**finding 身份**记忆"，
  两者分开实现，不混成一个"增量审查"概念（六个插件在这一点上都含混，我们不能重蹈）。

### 3.7 报告与回灌渲染

- `render.partition` 增加 `blocking / manualBlocking / verifiedOnly / passive` 四个桶；
- `renderFindings` 的 `report` 模式输出分区：
  1. 阻塞问题（已复验）
  2. 待人工处理（manual/fixMode）
  3. 未复验问题（仅报告，不要求修复）
  4. 已抑制（N 条，附原因摘要）
  5. 覆盖：送审 X 文件，已审 Y，跳过 Z（原因）
  6. 结论边界：`本次为 AI 审查层结论，不替代 CI/人工审查`
- `steer` 只渲染 1 + 2/3 的"仅报告"提示；绝不把未复验项写成"请修复"。

## 4. R2（0.5.0）：账本、结论、评测

### 4.1 journal v2（存储域 + 内存降级）

现有 `code_review/reviews` 表增加字段（向后兼容，老记录读时补默认）：

```jsonc
{
  "runId": "uuid", "mode": "turn|full|range",
  "coverage": { "total": 12, "reviewed": 10, "skipped": 2, "unaccounted": 0 },
  "verification": { "checked": 3, "confirmed": 2, "unverified": 1, "rejected": 0 },
  "suppressed": 1,
  "findings": [/* 每条带 fingerprint, verified, fixMode, repeats */]
}
```

- `/review` 脚注：最近 N 轮的成功率/失败原因/覆盖/复验/抑制统计；
- 新增 `/review-status`（可选）：当前链轮次、最近一次审查状态。

### 4.2 finding 指纹与跨轮追踪

- `fingerprint = sha256(ruleId | path | normalize(problem))`（不含行号，防重排误判）；
- 从 journal 最近记录中查同 session 历史：`repeats`、`firstSeenAt`；
- `fixed` **不由模型/用户声明写入**：仅当同 fingerprint 在后续成功审查中"不再出现"时记 `not-observed`，
  再连续 2 次不出现才可标 `resolved`（借鉴 `@feng0531` 的保守语义）；不自动关闭，只在报告中显示状态。
- 可选：storageDomain 扩展 `chains/findings/runs` 三表（跨重启），R2 先做 journal 内，跨重启表放 R2.5。

### 4.3 结论/门禁语义

- 抽出 `verdict(findings, coverage, run)`：`passed = run.completed && 无 verified 阻塞 && coverage.unaccounted===0`；
- 自动回灌不使用 `passed/failed` 字样（避免主 agent 误读成"审查通过"），只用"阻塞项/仅报告项"。
- `/review` 报告标题写 `## 代码审查 · 完成 · 有发现`；结论区固定一句边界声明。

### 4.4 质量回归语料

- `evaluation/cases/*.json`：合成样本（不引用私有仓库），每个 case 含
  `{ name, files: [{path, hunks}], expected: [{ruleId, severity, location, evidenceSnippet}], disallowed: [...] }`；
  覆盖：回显数据丢失、批量无上限、死代码、文件行数、证据伪造（应拒）、wontfix 抑制。
- `scripts/eval-pipeline.mjs`：离线验证**管道**（规则加载 → prompt 构建 → schema/证据校验 → 渲染），
  用固定模型输出 fixture 断言"该报的报、该拒的拒"；不调用模型，可进 CI。
- 模型质量评测单独文档：预注册 run 集合、人工裁决金标、precision/recall 分母保留、无金标记 null；
  改 prompt/规则/模型必须重跑同一组（借鉴 `@feng0531` evaluation 合同，不引入私有工件）。

## 5. R3（0.6.0）：范围与容量

### 5.1 `/review --range <base>..<head>` 与 `--patch <file>`

- 新增 `src/host/git.js`：`execFile('git', [...], {cwd})`，`GIT_TERMINAL_PROMPT=0`、`--no-optional-locks`、
  1MB buffer、10s 超时；cwd 取 `agent.session.header.cwd`（不可用则报错，不猜路径）。
- 流程：`git rev-parse --show-toplevel` → `git diff --name-only -z --diff-filter=ACMR <range>` →
  逐文件 `git diff --no-ext-diff --no-color -U3 <range> -- <path>` → 用现有 `renderHunks`/`collect` 同构结构
  构造 `files[]`；二进制/超大文件跳过并记 reason；`allowedPaths` = range 文件集。
- `--patch <file>`：宿主读取补丁文件（cwd 相对、路径越界拒绝、≤maxDiffBytes），按 `diff --git` 分段解析；
  allowedPaths 取 `+++ b/...` 头。
- 执行：命令同步或后台？先同步（与 `/review --full` 一致），设总超时 `rangeTimeoutMs`（默认 15min）；
  分块运行，合并后一次性报告；不注入修复轮（只报告）。

### 5.2 分块、限流、超时自适应

- `chunkFiles(files, maxDiffBytes)`：按顺序装块，单文件超 `maxFileDiffBytes`（默认 60KB）跳过并记 `budget-file`；
- 每块一次 reviewer 调用，块间 `Promise` 串行或并发 ≤ `rangeConcurrency`（默认 1，最大 2）；
- `timeoutFor(bytes) = min(reviewerTimeoutMaxMs, reviewerTimeoutMs + ceil(bytes/1024)*reviewerTimeoutPerKbMs)`，
  默认 `reviewerTimeoutMs=120s`、`perKb=500ms`、`max=900s`；异步总预算 `asyncReviewerTimeoutMs` 仍是硬顶；
- 每块结果保留 findings，合并后按 `(ruleId, path, 规范化 problem)` 去重（借 `dsh-review` 去重思路），
  按 severity 截断 MAX_FINDINGS；被截断的报 `dropped` 数。
- 全量/范围模式统一"先审块、再合并、再做证据校验/复验"，不让单块失败拖垮整场；
  失败块记 `failed`，报告显式写"覆盖缺口，NOT clean"。

### 5.3 敏感路径与微改

- `sensitiveGlobs`（默认 `**/auth/**`、`**/migrations/**`、`**/*.sql`、`**/.github/workflows/**`）：
  命中即本次强制 full（链内文件），与 `fullReview` 共用；不可通过配置降级（借鉴 `@stardustlc`）。
- 可选 `exemptBelowLines`（默认 0=关闭，借鉴 `dsh-review-gate`）：整轮只有单文件且改动 < N 行 → 跳过自动审查，
  journal 记 `waived`；默认关闭，避免漏报。

## 6. 明确不抄

1. `@feng0531` 的 177 模块拆分、SVN 全谱系、双重执行路径、微预算叠加——复杂度远超收益。
2. `@stardustlc` 的 GitHub CI 门禁整套（GraphQL threads/requiredChecks/appSlug）——我们无 PR 场景。
3. `dsh-logistics` 的主编模型二次成文 + 1200 字报告 contract + 文件/CLI 总线——turn 级纯开销。
4. `dsh-review-threads` 的整 tab/SSE/Typert 服务——为一个 finding 账本不值得。
5. `dsh-review-gate` 的自审 + steer 同 turn 语义——我们刻意改成后台独立审查者，不退回。
6. `@yangzhe1991`、`dsh-file-review-tab` 的客户端 UI——不是本插件职责。
7. `dsh-review` 的全量 fan-out（每次 73 agents）——只在 full/range 的阻塞项上花复验钱。

## 7. 模块改动清单

| 阶段 | 文件 | 改动 |
| --- | --- | --- |
| R1 | `src/host/reviewer.js` | REVIEW_SCHEMA v2、evidence/coverage 校验、诊断码、prompt 更新 |
| R1 | `src/host/collect.js` | 导出变更行集合/引入行工具（供校验） |
| R1 | `src/host/verify.js`（新） | 证伪 verifier：schema、prompt、执行、超时、归并 |
| R1 | `src/host/render.js` | partition 四桶、manual/未复验段、覆盖段、边界声明 |
| R1 | `src/host/rules.js` | `blocking`/`fixMode` 字段校验、规则 hash、生成代码口径 |
| R1 | `src/host/scope.js` / `src/host/fixmode.js`（新） | 路径分类（generated/contracts/sensitive） |
| R1 | `src/host/suppress.js`（新） | 配置 + 仓库文件读取/匹配/过期 |
| R1 | `src/host/config.js` | `evidenceMode`/`verify`/`maxVerifiedFindings`/`suppressions`/`manualFixGlobs` 等 |
| R1 | `index.js` | 复验接线、抑制过滤、fixMode 回灌分支、journal 字段 |
| R1 | `rules/` | MNT-011/016 调整、BEH-009/010、规则元数据 |
| R2 | `src/host/journal.js` | v2 字段、fingerprint/repeats、统计查询 |
| R2 | `src/host/render.js` | `/review` 分区报告、边界声明 |
| R2 | `evaluation/`（新） | 合成样本 + README + 离线 eval 脚本 |
| R3 | `src/host/git.js`（新） | range/patch 取证 |
| R3 | `src/host/command.js` | `--range`/`--patch` 解析与校验 |
| R3 | `src/host/chunk.js`（新） | 分块、限流、合并、超时公式 |
| R3 | `src/host/reviewer.js` | prompt 参数化（批量/范围模式） |

## 8. 测试与验收

R1：

- evidence：伪造片段/引用旧行 → finding 被拒；合法片段保留；全部被拒 → `invalid-result`。
- introducedBy：location 在 hunk 外 → 拒；在 hunk 内 context 行 → 保留。
- verifier：mock activation 返回 confirmed/rejected/timeout，分别映射为阻塞/仅报告/仅报告；验证不触发修复轮。
- rules：MNT-011 为 low 且不阻塞；MNT-016 单行例外不再命中；BEH-009/010 通过 schema。
- fix policy：manualGlob 命中 → 回灌文本含"请勿自动修改"且不带"请修复"；全部 manual → 不 followup。
- suppress：配置/仓库文件命中 → 不注入、报告可见、journal 记 suppressed；过期失效。
- coverage：缺失只 warn；出现非法路径/状态 → coverage 无效并记 unaccounted。
- 回归：现有 248 用例全绿；新用例预计 +30~40。

R2：

- journal v2 读写、老记录兼容、统计脚注；fingerprint 稳定（行号漂移不变）。
- `/review` 分区/边界/覆盖；eval cases 全部按预期（该报/该拒）。
- 评测文档含"预注册分母、null≠0"口径。

R3：

- range：本地临时 git 仓库构造 base..head，审查结果与 turn 模式对等效 diff 一致；非 git/无 cwd 报错。
- patch：单 patch 文件解析；二进制/超大文件跳过并披露。
- 分块：238 个文件/910KB 合成样本 → 块数 ≤ 配置、合并后无重复、总超时内完成。
- 超时：`timeoutFor` 单测；单块超时不拖垮其他块。

## 9. 排期与版本

| 阶段 | 版本 | 内容 | 估算 |
| --- | --- | --- | --- |
| R1 | 0.4.0 | 证据+复验+口径+fix policy+抑制+coverage | 中（~8 文件 + 40 测试） |
| R2 | 0.5.0 | journal v2+结论边界+评测语料 | 中（~4 文件 + 20 测试） |
| R3 | 0.6.0 | range/patch+分块+超时自适应+敏感路径 | 大（~5 文件 + 25 测试） |

依赖顺序：R1 先做（低风险、直接提精度）；R2 的 journal 字段依赖 R1 的 coverage/verify 结构；R3 可独立并行但最后做。

## 10. 风险与回滚

- **证据字段可能降低召回**：先 `warn` 模式上线，统计"因证据被拒的比例"再切 `enforce`；必要时按规则/severity 分档。
- **verifier 增加延迟**：只在出现阻塞 finding 时运行、最多 3 条、独立超时；超时/失败降为仅报告，不阻塞。
- **manual fix policy 可能让部分问题没人修**：报告显式列出并提示人工，不静默；可配置关闭（`respectFixPolicy:false`）。
- **range 模式绕过宿主 diff 服务**：只读 git 命令 + 路径白名单 + 超时；失败即报错，不降级猜测。
- 回滚：每个配置项可关（`verify:'off'`、`evidenceMode:'warn'`、`respectFixPolicy:false`、`fullReview:false`）；
  规则调整可在 profile 覆盖 pack；不引入数据迁移破坏 journal（v2 读时兼容）。

## 11. R1 实施记录（2026-11-11，0.4.0）

R1 已完成并合入 0.4.0；全部 319 个用例通过。实施时对方案做了以下收敛（以代码为准）：

1. **证据语义分三档**（`src/host/evidence.js` + `reviewer.js`）：
   - `location` 不在本轮 hunk 新侧范围 → **总是丢弃**（旧代码冒充新问题）；
   - `evidence.snippet` 对不上 → `warn` 下保留但降级为「仅报告」（`evidenceStatus: mismatch`），`enforce` 下丢弃；
   - 缺少证据 → `warn` 保留（schema 在真实宿主会先要求 evidence），`enforce` 丢弃；
   - 宿主读不到文件内容 → `unreadable`，保留 finding。
   这样默认不会因为模型偶发不带 evidence 而误吞真问题，但伪造/引用旧代码的片段不会阻塞、不会触发修复。
2. **复验只对「阻塞 + 证据 ok」的 finding 发起**（`src/host/verify.js` + `finalize.js`），避免为未证实证据付 verifier 费用；确认才保留、明确反驳丢弃、超时/失败标 `unverified`（仅报告）。
3. **manual-only 不再承诺「修完会再复审」**：不触发修复轮，文案只要求人工确认/勿自动修改。
4. **full 模式的证据校验需要宿主持有文件内容**：新增 `src/host/readfile.js`，从 `agent.session.header.cwd` 读取链内文件（每文件 256KB 上限、realpath 越界拒绝）；读不到按不可读处理。
5. **journal 只记复验统计**（checked/confirmed/rejected/unverified + coverage + suppressed 数）；逐条 verifier 的 witnesses 与 finding 级跨重启账本留给 R2。
6. **实现文件**：新增 `evidence.js`、`readfile.js`、`verify.js`、`fixmode.js`、`suppress.js`、`finalize.js`、`structured.js`；修改 `reviewer.js`/`config.js`/`rules.js`/`render.js`/`journal.js`/`command.js`/`index.js`；规则包调整 MNT-011/MNT-016 并新增 BEH-009/BEH-010。
7. **默认值**：`evidenceMode: warn`、`coverageMode: warn`、`verify: blocking`、`maxVerifiedFindings: 3`、`verifyTimeoutMs: 180000`、`respectFixPolicy: true`；真实使用一段时间、观察「因证据被降级/丢弃」的比例后再把前两项切到 `enforce`。

R2（journal 账本/`/review` 分区/评测语料）已完成并合入 0.5.0（见 11.4）；R3（`--range`/`--patch`/分块/超时自适应/敏感路径）已完成并合入 0.6.0（见 11.6）。

### 11.1 自审修复（2026-11-11）

0.4.0 提交后插件对本次 diff 的自动审查报出 3 条阻塞，均已修复并补回归用例：

1. **未复验项被静默丢弃**（`index.js`）：只有 `unverified` 时原来落到默认静默分支；现在进入「仅报告」通知，文案为「未通过复验/证据不足，仅作报告；请人工确认」，既不伪装通过也不要求修复。
2. **复验窗口内的旧链结果回灌**：复验把结算窗口拉长到分钟级，人类消息可能已重置链；现在结算后先校验 `meta.epoch === tracker.epochOf(sessionId)`，旧链结果只记留痕、不回灌、不污染新链指纹。
3. **diff 前缀导致证据误判**：模型照抄 `+const x = 1` 时片段对不上；`evidence.js` 现在同时接受带/不带 `+`/`-` 前缀的写法。

同时按自审建议：拆出 `structured.js` 让 `reviewer.js` 回到 500 行内；补齐 verifier 的 abortPromise（取消立即返回并 dispose）；拆分若干超长行。

### 11.2 第二轮自审修复（2026-11-11）

1. **abort 在 startActivation 返回前胜出时 activation 泄漏**（`verify.js`）：保存 `starting` 引用，abort/deadline 迟到返回时补 dispose，并观察 `result` 防未处理拒绝；补回归用例。
2. **旧链成功结果不再清零熔断计数**（`index.js`）：`tracker.recordSuccess` 移回跨链判断之前，只有指纹/全量状态/已报问题留在 sameChain 分支；补回归用例（旧链成功后一次失败不会提前打开熔断）。

### 11.3 第三轮自审修复（2026-11-11）

1. **behavior 维度被校验层漏掉**（阻塞）：`structured.js` 的维度白名单与 `REVIEW_SCHEMA.dimension` enum 都只有四维，BEH-* 与 PRINCIPLE-behavior 会被当非法 finding 丢弃；现在维度单一来源为 `rules.js` 的 `RULE_DIMENSIONS`，schema/校验共用，并补 behavior 维度回归用例。
2. **MAX_FINDINGS 第二份真相**：`index.js` 去掉 `slice(0, 20)`，`reviewer.js` 的 knownFindings 截断改用 `MAX_FINDINGS` 常量。
3. **location 语法第二份实现**：`structured.js` 改用 `evidence.js` 的 `locationLine`/`locationPath`，删除重复的 `LOCATION_SUFFIX`。

### 11.4 R2 实施记录（2026-11-11，0.5.0）

R2 已完成并合入 0.5.0；335 个用例 + 10 个离线评测 case 全绿。实施时对方案做了以下收敛（以代码为准）：

1. **账本只读 journal，不新增存储表**（`src/host/ledger.js`）：`annotateRepeats` 按同 session 最近 20 条 completed 记录统计 fingerprint 次数（repeats=1 首次、≥2 标「第 N 次报告，尚未修复」）；`notObservedFindings` 只记每个 fingerprint 最近一次出现，其后连续缺席 ≥2 轮才进「未再见」观察列表；`summarizeRecords` 供 journal 脚注显示近期合计。跨重启的 `chains/findings/runs` 三表与逐条 verifier witnesses 仍留给 R2.5（避免 storageDomain schema 迁移）。
2. **「已修复」不写回**：账本不产生 `resolved` 状态，只在 `/review` 报告列出「连续 2 轮未再出现，可人工确认后移出跟踪；不自动关闭」；本轮被抑制的问题计入「仍跟踪」，不会误入未再见。
3. **重复标注同时覆盖自动回灌与 `/review`**：自动审查在 `finalize` 后用 journal 历史标注 repeats（在途 running 记录不计入），回灌 finding 行尾直接可见；`/review` 从同一窗口标注并额外输出未再见账本。`/review` 自身不写 journal，历史只来自自动审查——这是保留的既有口径（命令是留痕唯一观察点，不新增记录类型）。
4. **journal v2 增量兼容**：`reviews` 表仅新增可选字段 `findings[].repeats/firstSeenAt` 与脚注「近期合计」行，老记录读取时按缺省处理，无 schema 版本迁移。
5. **`/review` 结论边界**：报告末尾固定输出 `BOUNDARY_LINE`（只覆盖本次改动与可读取文件、覆盖缺口见覆盖行、不构成合入批准）；自动回灌文案仍不使用 passed/failed 字样。
6. **离线评测语料**（`evaluation/`）：10 个 case 覆盖行为维度不被漏、证据伪造 warn/enforce、旧行号丢弃、复验反驳/超时、wontfix 抑制、非法 coverage、full 模式证据、超量截断；`evaluation/run.mjs` 不调模型、可 `npm run eval`，并被 `test/eval-corpus.test.js` 纳入 `npm test`。模型质量评测按 `evaluation/README.md` 的预注册分母、null≠0 口径单独文档化，不混入管道 eval。
7. **未做**：`/review-status`（可选，暂无消费者）；storageDomain 三表；把 `evidenceMode/coverageMode` 切到 enforce（等 live 统计，见 11 的默认值说明）。

### 11.5 0.5.0 自审修复（2026-11-11）

0.5.0 提交后插件对 R2 diff 的自动审查报出 1 条阻塞、1 条建议，均已修复：

1. **「未再见」无视审查覆盖范围**（阻塞，`ledger.js` + `journal.js` + `command.js`）：turn 轮只审当轮 diff，旧实现只看「本轮 findings 里有没有该指纹」，相邻 turn 改不同文件时会把仍存在的问题判成连续缺席。现在 journal 记录每轮实际送审 `paths`，`notObservedFindings` 要求当前轮与最近各轮都覆盖该 finding 的文件才累计 `missedRuns`；中间任一轮未覆盖、或老记录缺 `paths` 时保守不推断；`/review` 的报告措辞改为「连续 N 轮审过该文件且未再出现」。
2. **manual 模式外溢报告边界声明**（`render.js`）：`BOUNDARY_LINE` 原先落在 `report || manual` 分支，而 manual 用于自动回灌「不触发修复轮」的通知，会把「覆盖缺口见覆盖行」带进主会话且该行未必存在；现收窄为只加在 `report` 模式，并补 manual 断言。

### 11.6 R3 实施记录（2026-11-11，0.6.0）

R3 已完成并合入 0.6.0；360 个用例 + 10 个离线评测 case 全绿。实施收敛：

1. **范围取证只读 git**（`src/host/git.js`）：`rev-parse --show-toplevel` + `diff --name-only -z --diff-filter=ACMR <range>` + 逐文件 `diff --no-ext-diff --no-color -U3`；`GIT_TERMINAL_PROMPT=0`、`--no-optional-locks`、8MB buffer、10s 单命令超时。范围表达式只接受 `<rev>..<rev>`/`<rev>...<rev>`（拒绝 `-` 开头/空白/参数注入）；非 git 目录或 cwd 缺失直接抛错，不猜路径。二进制/空 diff/超 `maxFileDiffBytes` 的单文件进 `skipped`（`binary`/`empty`/`budget-file`）。
2. **补丁模式复用同一取材结构**：`--patch <file>` 只允许仓库根目录之下的相对路径（绝对路径/`..` 越界拒绝），大小受 `maxRangeBytes`；解析 `diff --git` 分段与 hunk，二进制段也留记录并披露。
3. **分块与合并**（`src/host/chunk.js`）：`chunkFiles` 按 `maxDiffBytes` 顺序装块；`timeoutFor(bytes)` = `min(reviewerTimeoutMaxMs, reviewerTimeoutMs + ceil(KB)*reviewerTimeoutPerKbMs)`，每块还受 `rangeTimeoutMs` 剩余预算约束；`mapWithLimit` 实现 `rangeConcurrency`（默认 1，最大 2）；`mergeReviews` 按 `(ruleId, path, 规范化 problem)` 跨块去重、按严重度截断 `MAX_FINDINGS`，`mergeCoverage` 累加计数且任一块未申报即 `missing`。
4. **`/review` 三个范围入口统一收口**（`command.js`）：`--range`/`--patch` 与 `--full` 共用证据校验/抑制/复验/账本/边界声明；只报告、不回灌、不占自动轮次；有块失败时报告显式写「覆盖缺口，本次 NOT clean」。非法参数/缺 cwd/取材失败都返回中文错误文案。
5. **敏感路径强制全量**（`index.js` + `config.js`）：`sensitiveGlobs` 默认 `**/auth/**`、`**/migrations/**`、`**/*.sql`、`**/.github/workflows/**`；命中即本次强制链级全量（不受 `fullReview:false` 影响），与末轮全量共用 `chain.isFull` 的「每条链一次」约束，避免反复付费。
6. **prompt 参数化**（`reviewer.js`）：`buildPrompt` 增加可选 `header`，范围块 prompt 明确「第 i/n 块、只审本块 diff、不要跨块重复报告」。
7. **测试**：新增 `test/git.test.js`（真实临时 git 仓库：范围取材/非法范围/补丁解析/越界拒绝/二进制/超大）、`test/chunk.test.js`（分块/超时公式/去重截断/coverage 合并/并发上限）、命令侧 range/patch/错误文案/分块合并用例、index 侧敏感路径强制全量与不误触发用例；`/review` 既有全量路径回归全绿。
8. **未做**：`exemptBelowLines`（可选，默认关闭）；范围模式的跨块二次因果推断；`--range` 的后台异步执行（仍同步，受 `rangeTimeoutMs` 约束）。

### 11.7 0.6.1 范围审查稳定性修复（2026-11-12）

wisdom 仓库的 live `/review --range HEAD~3..HEAD` 失败（`1/1 块失败/超时`）。用 reviewer 子会话日志定位到两种失败模式（同一 prompt：19.5KB、2 文件、1 块）：

1. **provider 输出畸形**：子会话 `turn/end` 为 `{"kind":"error","code":"MALFORMED_RESPONSE"}`（`tool input is invalid JSON`）——模型提交 `structured_output` 时 JSON 流畸形；
2. **超时**：另两次子会话 `turn/end` 为 `aborted/parent`，即 130s 的 range 单块超时；审查者用了 18-20 次 read/grep 核对上下文，turn 模式的超时基准不够。

修复（0.6.1）：

1. **单块超时下限**：新增 `rangeChunkTimeoutMs`（默认 240s）；范围块超时 = `max(rangeChunkTimeoutMs, timeoutFor(bytes))`，仍受总预算 `rangeTimeoutMs` 约束。
2. **块级重试/拆分**：块失败先拆半重试一次（多文件块各半并发重试；单文件块原样重试一次），仍失败才计入覆盖缺口；错误文案与缺口行写明失败原因（`timeout`/`provider-error`/`invalid-result` 等），不再只写「块失败/超时」。
3. **收紧探索与输出预算**：范围块 prompt 明确「diff 已完整提供，不要用 grep/read 探索无关文件」「finding ≤8 条、evidence 每行一条、尽快提交 structured_output」，降低慢查询与畸形输出的概率。
4. **测试**：命令侧新增「单块失败拆半后成功、不记缺口」「重试仍失败时错误文案带原因、且单文件块只重试一次」用例；config 覆盖新键。362 用例 + 10 eval 全绿。

### 11.8 0.6.2 自动审查失败重试（2026-11-12）

用户反馈「每轮结束似乎不跑自动审查」。journal 取证：09:57/10:04 两次 completed（0 findings，按 v2 设计静默）、10:24 一次 `failed/incomplete`（fail-open 静默）；对应 reviewer 子会话 `turn/end = error, MALFORMED_RESPONSE: tool input is invalid JSON`。同类失败在 00:34（turn 77）也出现过，均为 deepseek 流式输出 tool input 畸形，属于模型侧偶发、非业务拒绝。

修复（0.6.2）：新增 `retryInvalidReview`（默认 `true`）。自动审查结算时若失败原因是 `incomplete` / `provider-error` / `invalid-result` / `missing-coverage` / `invalid-coverage`，且仍在同一链/同一会话代次、剩余预算 >20s，则用同一份 prompt 静默重试一次：

- 重试在「在途」槽位内进行，`/review` 不会看到空档；不额外占链轮次；
- 重试期间 session/disposed/插件卸载通过新增的 `retrying` 表叫停，结果不回灌已关闭会话；
- 重试成功仍是一次 completed 留痕；重试仍失败才计 failed 与熔断（只记一次）；
- 超时类失败不重试，避免双倍等待；prompt 在 meta 中保留供重试复用。

测试 +3（重试成功回灌、重试仍失败只发起两次、人类重置链后不重试）+ config 断言；365 用例 + 10 eval 全绿。`/review --range` 在 0.6.1 下已验证成功（wisdom 仓库 HEAD~3..HEAD，2 文件，1 阻塞 + 2 建议，覆盖 2/2）。

### 11.9 0.6.3 审查输出改文本 JSON（MALFORMED_RESPONSE 根因修复）（2026-11-12）

用户多次遇到 reviewer 子会话「本轮运行失败：DeepSeek Messages stream: tool input is invalid JSON」。定位：DSH 的 `structured_output` 是普通工具，**provider 会对流式 tool-call 参数强制 JSON 解析**；审查 prompt 要求逐字引用代码片段（含换行/引号/反引号），模型一旦转义出错，整个 activation 以 `MALFORMED_RESPONSE` 失败——重试只是缓解，不是根因修复。

修复（0.6.3）：审查者默认改为**文本 JSON 模式**：

1. `startReview`/`runReview` 默认 `outputMode: 'text'`，不向 subagent 传 `outputSchema`（该工具不再挂载）；prompt 要求「把结果放在一个 ```json 代码块里作为最终回答，提交结果不需要调用工具」，并明确「JSON 字符串禁止未转义换行、evidence 必须单行」。
2. `structured.js` 新增 `extractJsonFromText`（```json 围栏优先、可省语言、容忍围栏外说明，退化为首个 `{` 到末个 `}`）与 `structuredFromResult`（structured 优先、文本 output 回退）；`validateResult` 在文本坏 JSON 时返回 `invalid-result`，不再有 provider 级整轮失败。
3. 保留 `outputMode: 'tool'` 回退路径与 `structured_output` guard 白名单；`REVIEW_SCHEMA` 与 OUTPUT_SHAPE 仍作为形状单一来源。
4. 测试：新增 `test/structured-text.test.js`（围栏/无围栏/围栏外说明、structured 优先、坏 JSON → invalid-result、未完成 → incomplete）；更新 reviewer prompt/startReview 断言；372 用例 + 10 eval 全绿。

