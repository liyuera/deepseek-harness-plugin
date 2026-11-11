# DSH 代码审查插件生态调研（2026-11-11）

目的：为 `@liyuera/dsh-code-review` v0.4 找可借鉴的设计。方法：npm registry 全量检索 + 社区插件目录
（`dsh-plugin-catalog` 10365 条，Git 类目 185 条、审查相关 58 条），下载/克隆 20 个代表插件做只读源码阅读，
其中 14 个做了深读。逐插件笔记（含 file:line 与 prompt 原文）在 `/tmp/cr-research/notes/*.md`：
`feng0531.md`、`michengai.md`、`gate-multiagent.md`、`evidence-threads.md`、`turn-ui-plugins.md`、
`auto-graph-guide.md`。

## 1. 生态地图

按"审查怎么触发、谁来审、审什么"分五类（同插件可能跨类）：

| 类型 | 代表插件 | 核心形态 | 对我们的相关性 |
| --- | --- | --- | --- |
| A. 手动范围审查 | `@michengai/dsh-code-review`、`@feng0531/dsh-code-review`、`dsh-codex-review`、`dsh-code-review` preset | `/review` 选范围（分支/未提交/提交/自定义），派独立子 Agent 审 | **高**：P0-1 的入口设计 |
| B. 证据/复核/门禁 | `@stardustlc/dsh-review`、`@feng0531/`、`dsh-review`(对抗式)、`dsh-review-format-guard` | finder → 逐条 verifier 证伪 → 确定性判定 → 门禁 | **最高**：P1-1/P1-3/P1-4 的直接答案 |
| C. turn 后自动/增量 | `dsh-review-gate`、`dsh-review-loop`、`@dsh-plugin/dsh-code-review`、`dsh-review-checkout` | turn-stopping/写文件后触发，或按 checkpoint 只审新增 | **最高**：与我们同形态，验证触发与增量语义 |
| D. 多智能体/多评审者 | `dsh-review`(0.1.1)、`dsh-review-squad`、`dsh-command-code-review`、`dsh-logistics`、`dsh-review`(多引擎) | 多 lens 并行 + 汇总/投票/置信度 | 高：P0-2 容量与 P1-1 的备选路线 |
| E. UI/持久化/撤销 | `@yangzhe1991/`、`dsh-review-threads`、`dsh-file-review-tab`、`dsh-review-checkout` | diff 页、行内评论、线程账本、undo | 中：持久化与锚点设计可借，UI 不抄 |
| F. 审批/安全审查 | `dsh-auto-review`、`dsh-review-format-guard`、`dsh-trust-check` | 工具审批前的第二模型审查、输出格式守卫 | 中：决策树、审计、格式校验模块可借 |

与我们同形态（turn 后自动审查）的实际上只有 `dsh-review-gate` / `dsh-review-loop` / `@dsh-plugin/dsh-code-review`（后者不做 LLM 判断，只做 per-turn 变更账本与 undo）。**没有第二个插件同时做"turn-stopping + 独立只读子 Agent + findings 回灌修复轮"**——这条产品线仍是我们的差异化。

## 2. 值得抄的八个设计共识

以下不是某一家的做法，而是多个独立实现在关键点上的趋同；括号内为证据来源。

### 2.1 证据三件套：锚点片段 + 引入行 + 独立复核

- `@feng0531`：finding 必须带 `anchor{kind:'line',side,start,end,snippet}`，宿主逐行比对 `source.slice(start-1,end).join('\n') === snippet`，不等即 `MODEL_ANCHOR_MISMATCH` 拒收；attribution 只能引用宿主生成的 `editIds`，且 `causality` 恒为 `unverified`（`src/review.mjs:63-91`、`src/attribution.mjs:6-15`）。
- `@stardustlc`：候选必须带 `introducedBy` 且该行必须落在本轮 `addedLines`/`removedLines` 内（`lib/gate.js:29-36`）；verifier 的 `witnesses[]` 必须逐字命中快照、至少一条在候选 ±3 行（`lib/gate.js:42-61`）。
- Codex rubric（`@michengai` 原文搬运）：判定一个缺陷值不值得报要满足"the bug was introduced in the commit（pre-existing 不报）"、"discrete and actionable"、"不依赖未声明假设"等 8 条（`assets/codex/review/rubric.md:12-19`）。
- 结论：**"证据不足就不报"必须由宿主机械校验，不能只写在 prompt 里**。我们当前 prompt 要求了逐字片段，但 schema/校验层没有落这个字段，等于没有约束。

### 2.2 证伪（refutation）先于报告，失败即视为未证实

- `dsh-review`（对抗式）：每条 finding 派 1–N 个 verifier，prompt 明令 "Your job is to REFUTE it, not to agree with it"；"Confirm ONLY if you tried to refute it and failed. Default to `confirmed: false` when the evidence is ambiguous"；verifier 失败/异常视为 refute，未证实的问题**永不报告**（`lib/review.js:59-78,126-146`、`lib/schema.js:69-78`）。
- `@feng0531`：反证用**独立会话**，构造时删除首轮 verification 字段，第二位验证者看不到第一位结论；两次结论不一致即降级 `uncertain`，不投票、不借用第二家的证据（`src/counter-verification.mjs:19-49`）。
- `@stardustlc`：1–3 票，票数不足即 `unverified` 并阻塞整轮（`lib/gate.js:62-70`）；`unverified>0` 时 gate 直接拦（`lib/verdict.js:13-14`）。
- 结论：我们当前的"单 reviewer 一次输出 + 校验层过滤"缺少**语义级复核**；medium/high 问题应加一个只读 verifier，专事证伪。

### 2.3 指纹不含行号 + 账本 + "fixed 只能由复核写"

- `@stardustlc`：`fingerprint = sha256(kind|file|normalize(anchor)|occurrence)`，不含行号，重排/rebase 不产生新 finding；`posted` 表记录 `disposition ∈ {fixed,wrong,intentional,wontfix}`、`repeats`、`verification[]`；人不能自报 fixed，`fixed` 只能由下一轮复核查到"原 anchor 已消失"时写入（`lib/fingerprint.js:11-14`、`lib/gate.js:91-143`、`lib/tools.js:174-182`）。
- `@feng0531`：`anchorHash + claimHash` 双指纹，文字漂移就宁可当新候选（"宁重不并"）；ledger 标 `historical-metadata-not-evidence`，本轮未见只记 `not-observed`，不自动关闭（`src/finding-ledger.mjs:46,99-102`、README:295）。
- `adversarial-review`：确定性 severity + **抑制规则 suppress** + 增量审查历史（docket）——与团队 `#ai-wontfix` 文化直接对应（详见其 `src/suppress.ts`、`test/suppress.test.ts`）。
- 结论：需要一张"finding 账本"，至少做到：跨轮重复只加 `repeats`、人工处置（wontfix/waive）可配置化、修复状态不靠模型自述。

### 2.4 覆盖声明必须可被机器验证；"跑了没发现"≠"没跑"

- `dsh-logistics`：handoff 契约强制每位专家报 `units{status:reviewed|sampled|skipped, files[]}`、`sections` 计数必须与 findings 条数一致、`tests` 逐条三态、实读文件数 ≥ `min(30, unit.files)` 且必须覆盖 core，缺一即 invalid；任一 skipped → 整体 `partial`（`lib/handoffs.js:38-121,140-182`）。
- `dsh-review`：报告明确区分 `cleanLenses`（跑了没发现）与 `failedLenses`（覆盖缺口，NOT clean）；预算砍掉的报 `dropped`（`lib/review.js:178-183`）。
- `@feng0531`：覆盖 8 态 + `unaccounted = total - Σ`，unknown 一律 null 不用 0；"依赖未完成"不得翻译成"预算失败"（`src/report-summary.mjs:1,81-98`、`src/report-readability.mjs:14-35`）。
- 结论：reviewer 应输出 coverage 块，宿主校验"声称审过 = 确实在输入文件内"，报告显式写"未覆盖/失败"，不能把失败当通过。

### 2.5 确定性判定优先，模型不投票定严重度

- 我们的规则表已经是 severity 权威；生态里 `@stardustlc` 的 gate 是 7 个必要条件全满足才 ok（完成/独立/有风险分类/unverified=0/无二进制/latest target 相同/无未处置），且硬声明"只覆盖 AI 层，CI 与人工另计"（`lib/verdict.js:7-24`）。
- `dsh-review`/`dsh-logistics` 的合并也是确定性规则（severity + confidence + owner 优先级），不再调一次 LLM。
- 结论：结论/门禁走确定性函数；我们已有 `render.partition`，v0.4 抽出统一的 `verdict(finding, run)` 供回灌与 `/review` 共用。

### 2.6 风险分级 + Fix Policy：不是所有问题都该自动修

- `@stardustlc`：模式 quick/standard/deep 由 `planForMode` 唯一定义，敏感路径强制 deep 且不能通过参数降级（`lib/modes.js:22-67`）；gate 只输出 AI 层结论（`lib/verdict.js`）。
- `@feng0531`：私有工件默认 0600、读取绑定 `{sessionId,cwd,provider,model,reasoningEffort}`，工具层要求 `confirmed:true`；预览 → 执行前重新捕获快照并要求 id 全等（`src/preview-validity.mjs`、`src/service.mjs:203-236`）。
- `dsh-review-gate`：分档 micro/full，敏感路径 `alwaysFullGlobs` 强制 full，`escalateOnPush` 在豁免判定之前（`lib/state.js:13-33`、`lib/index.js:276-281`）。
- 结论：团队规范里的 `auto_safe / manual_only / forbidden` 必须进入插件：生成代码、契约、权限、迁移类 finding **只报告不自动修**。

### 2.7 范围/预算/超时：分块、限流、三重期限

- `@feng0531`：三层字节预算（快照 4MiB、单次 wire 512KiB、子会话 envelope）+ 共享 reader 账本（calls+bytes 不逐文件重置）+ 多轮召回（主审 3 轮/复核 6 轮）+ 有界 Myers diff（超限返回 null，绝不返回半对齐）（`src/review-reader-policy.mjs`、`src/line-diff.mjs:5-6`、`src/retrieval-loop.mjs`）。
- `dsh-logistics`：按模块 + `maxFilesPerUnit=120` 切块，超过 `maxUnits=12` 反复合并最小单元，每专家一个 child（`ARCHITECTURE.md:94-150`）。
- `dsh-review-format-guard`：三重期限——总期限不可续期 + 首内容期限 + 空闲期限（只被"有意义的进展"重置）；固定失败码；校验通过前不向调用方释放任何内容（`lib/wait.js:26-85`、`lib/failures.js:75-102`）。
- 结论：大 diff 必须分块 + 每块独立超时 + 全局上限；不能只靠一个固定 `maxDiffBytes` 和单一定时器。

### 2.8 规范/评测即数据，分母预注册，null≠0

- `@michengai`：Codex rubric 原文 + `source.json{repo,commit,blob,sha256,license}` 版本化固定（`assets/codex/review/rubric.md`、`source.json`）；规范升级必须换 commit 重算哈希。
- `@feng0531`：评测合同要求预注册全部 runIds、失败/partial 保留分母、无金标时 precision/recall 为 `null` 不冒充 0、报告与裁决绑定 JSON SHA256、任何 prompt/工具/模型变化重跑同一组案例（`evaluation/README.md`、`src/incident-eval.mjs`）。
- `dsh-auto-review`：单一硬指标（高危漏报即 exit 1）、固定用例、扫描阈值而非证明（`bench/phocinae-bench.mjs`）。
- 结论：我们缺少"审得准不准"的回归语料；v0.4 至少要建立可复跑的离线评测与质量口径。

## 3. 各插件一句话定位（选读）

- `@michengai/dsh-code-review`：范围选择 + 原生 spawn 子 Agent + Codex 四条短任务 + journal 双态；**不强制只读**（工具面全开），靠 prompt 纪律。
- `@feng0531/dsh-code-review`：生态里最完整的企业级实现（177 模块/12.7k 行）：preview→confirm→execute、证据 receipt/reference 双轨、反证独立会话、7 分区报告、覆盖 8 态、评测合同；代价是复杂度与 DSH 内部 API 硬绑定。
- `dsh-review-gate`：同 turn 自审 + `steer` 拉回 + 回执 tool + 分档 micro/full；**审查者不独立**，与我们的后台只读子代理路线相反。
- `dsh-review`(0.1.1)：多 lens finder + 逐 finding 证伪 verifier + Jaccard 去重先于复验；最值得抄的是证伪 prompt 与"一个 refute 即丢"。
- `@stardustlc/dsh-review`：快照绑定多智能体 + 独立复核/多数投票 + 处置追踪 + AI 层门禁；最值得抄的是指纹/状态机与 gate 七条件。
- `dsh-review-squad`：四角色并行（安全/正确性/测试/风格）+ 每人模型/思考强度 + 确定性聚合；工程细节（limiter、失败 lens 人话、appendix 兜底）成熟。
- `dsh-command-code-review`：五视角并行 + 逐 finding 置信度打分。
- `dsh-review-loop`：checkpoint 之后只审增量，面板 + `/review` 把意见注入回 agent；验证了"增量审查"的产品形态。
- `adversarial-review`：确定性严重度 + 抑制规则 + 增量历史；抑制规则是 wontfix 记忆的现成答案。
- `dsh-codex-review`：每个对话复用**一个持续评审会话**（上下文延续），减少重复取证。
- `dsh-auto-review`：审批前第二模型审查，决策树/单一出口/闭集 verdict/审计可重建/bench；适合抄"决策与审计"而不是"代码审查"。
- `dsh-review-format-guard`：严格 JSON 校验、有界重试、固定失败码、三重期限；我们可把其"格式守卫"做成校验模块。
- `dsh-logistics`：五专家 + 可验证覆盖契约 + stable ID + 确定性合并；重流程，只抄覆盖契约。
- `dsh-review-threads`：storageDomain 六表 + 行锚四级降级 + published 双平面 + 不可变 submission；可借持久化/重定位模型。
- `@dsh-plugin/dsh-code-review`：per-turn 变更账本 + 安全 undo；不做 LLM 判断，但"callId+path 合并、快照升级、ownerTurn 归属"的设计值得借鉴。
- `@yangzhe1991/dsh-code-review`：diff 双列页 + 行内评论 + 干净上下文 sub agent；UI 不抄，但"大 diff 落临时文件只给路径"值得借鉴。
- `dsh-code-review` preset：纯 preset 只读 agent；隔离弱（工具面全开），不采用。
- `dsh-plugin-guide`：ENTRY/FLOW/BOOST 质量检查；作为 v0.4 交付 checklist。
