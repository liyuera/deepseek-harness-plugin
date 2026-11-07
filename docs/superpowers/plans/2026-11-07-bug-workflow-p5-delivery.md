# Bug 工作流插件 P5（提交/推送/MR + AI Review 轮询 + 合并归档）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把工单从「人工测试通过（`submitting`）」一路自动送到「MR 合并后出看板」：按设置先跑 lint/test，再在 worktree 里用团队提交信息模板 commit、推送个人分支，创建标题为 `<source> -> <target>` 的 GitLab MR；之后每 60s 拉取 MR 评论里最新一条 `AI Code Review` 结论——`需要修改` 则起 Review 修复子代理改代码、再次提交推送（最多 3 轮），`可直接合并` 进入 `mergeable`；检测到 MR `state=merged` 后 `merged` 并自动归档为 `done`（从看板窗口移除）。全过程**绝不** push/merge 受保护分支、不 force push、不 close MR、不 resolve discussion、不 approve、不 waive。

**Architecture:** settings 增加 `gitlabBaseUrl`，GitLab token 走 credentials ref `BUG_WORKFLOW_GITLAB_TOKEN`（沿用 P2 的 token 保存/清除端点模式，新增 `/api/gitlab-token`）。新增 `src/host/gitlab.js`（注入 fetch 的只读+创建 MR 客户端，`redirect:'error'`，错误静态化）、`src/host/review-parser.js`（把 P0 的 `scripts/review-parser.mjs` 迁为宿主可导入的 canonical 模块，脚本改为薄复导出）、`src/host/delivery-service.js`（lint/test → commit → push → MR 创建/复用 → 状态写入）、`src/host/review-service.js`（60s 轮询 → 解析 → `review_pass`/`review_requests_changes` + review 修复子代理 → `review_fix_done` → 合并检测 → 自动 `dismiss`）。`git.js` 增加 `commitAll`/`pushBranch`/`revParse`/受保护分支硬校验；store `PATCHABLE_TICKET_FIELDS` 扩到 `mr`、`reviewRounds`（P4 已有 `branch`、`fixes`）。路由 `POST /api/deliver`、`/api/gitlab-token`，snapshot 增加 `delivery:{running,errors}`、`gitlab:{tokenPresent}`；client 增加提交/Review/合并 UI。

**Tech Stack:** 现有 store/state-machine/routes/client/fix-service 模式 + `node:child_process.execFile('git')`（已有 git 模块扩展）+ 注入式 GitLab fetch 客户端 + P0 review-parser + P3/P4 子代理 runner。

## Global Constraints

- **硬边界（违反即 bug）**：永不 push/merge 到 `main`、`dev`、`feature-*`、`hotfix-*`、`release-*`；永不 force push；不 merge/close/resolve/approve/waive；不创建集成分支、不打 tag、不改版本号。`pushBranch` 与 `gitlab.createMergeRequest` 必须在代码层校验分支名/目标分支，非法即静态报错。
- **人工测试通过前不创建 MR**：delivery 只接受 `submitting` 工单（`mark_test_passed` 之后）；`fix_done` 及更早状态一律 409。
- **提交前必须跑配置的 lint/test**（`settings.lintCommand` / `testCommand`，为空则跳过并在 timeline 记录「未配置」）；失败则 `block`（静态原因 `delivery-lint-failed` / `delivery-test-failed`），输出尾部（截断）写入 `fix.error` meta 供看板展示，不进入 MR。
- **提交信息模板**：`<commitType>: 【jira单号】：<工单号>，【开发内容】：<一句话摘要>`（`commitType` 取 settings，默认 `fix`；摘要取 `plan.summary`，取不到用 `ticket.title`，截断到 120 字）。
- **轮询语义**：60s 一次；只处理 body 含 `AI Code Review` 且含 `结论:` 的最新 note（parser 已实现）；按 note id 去重（meta `review:last-note:<code>`）；解析失败 → `block`（`review-parse-failed`），不自动重试；`fixing_review` 最多 3 轮（复用 `MAX_REVIEW_ROUNDS`），超限 → `block`（`review-rounds-exhausted`）；review 修复后必须 commit+push 再 `review_fix_done`。
- **状态写入**：全部经 store 写队列 + `expectedWorkflow` 条件写；迟到结果不回退；dispose 不写 block/error；repo 单飞锁复用 P4 语义（同仓库同一时间一个 delivery 或 review-fix job）。
- **安全**：GitLab token 只存 credentials、只放 `PRIVATE-TOKEN` header、`redirect:'error'`、超时 15s、错误静态化不打印 token/堆栈；工单/评论/方案文本按不可信数据 nonce 数据块处理，parser 已裁剪「备注：以下隐藏数据…」之后内容，review 修复 prompt 不得包含被裁剪段。
- **测试**：`node --test bug-workflow/test/*.test.js`（P4 收尾基线 350）；热重载 `remove_bundle`→`install_bundle`；不打印敏感信息；mock GitLab 服务器只监听 loopback。
- 参考：[设计 spec](../specs/2026-11-06-dsh-bug-workflow-plugin-design.md) §7 状态机/§8.2 MR/§8.3 Git 规范/§9 子代理、[P0 findings](../spikes/2026-11-06-p0-findings.md)（AI Review 解析、GitLab 只读探查）、[P4 findings](../spikes/2026-11-07-p4-findings.md)。

## 接口与数据契约

```js
// git.js 扩展（注入 execFile，返回结构化结果；分支名先过 assertPushableBranch）
createGit({ execFile }) -> {
  // P4 已有：repoRoot/refExists/listWorktrees/probeWorktree/worktreeAdd/status/diffStat/diff/worktreeRemove
  assertPushableBranch(name) -> void        // 抛 GitError('protected-branch')；main/dev/feature-*/hotfix-*/release-* 拒绝
  revParse(repo, ref) -> Promise<string>,
  commitAll({ root, message }) -> Promise<{ sha }>,   // git add -A && git commit -m；无改动 → { sha:null }
  pushBranch({ root, remote, branch }) -> Promise<void>, // git push -u <remote> <branch>（禁止 --force）
}

// gitlab.js
createGitlabClient({ baseUrl, token, fetchImpl, timeoutMs = 15000 }) -> {
  getCurrentUser() -> Promise<{ id, username }>,
  findOpenMergeRequest({ project, sourceBranch }) -> Promise<MR | null>, // GET /projects/:id/merge_requests?state=opened&source_branch=
  createMergeRequest({ project, sourceBranch, targetBranch, title, description }) -> Promise<MR>,
  getMergeRequest({ project, iid }) -> Promise<MR>,
  listNotes({ project, iid }) -> Promise<Note[]>          // GET .../notes?sort=desc&order_by=created_at
}
// MR: { iid:number, webUrl, sourceBranch, targetBranch, state, title }
// Note: { id, body, createdAt, authorUsername }
// 错误：GitlabError code ∈ no-token|unauthorized|forbidden|not-found|rate-limited|network|timeout|bad-response|invalid-project|invalid-merge-request

// review-parser.js：canonical 迁移，scripts/review-parser.mjs 复导出
export function parseReview(body) -> { verdict:'pass'|'changes'|'unknown', blocking:[], nonBlocking:[], summary, noteMeta }

// delivery-service.js
createDeliveryService({ store, git, gitlab, settings, clock, lock, execCommand })
  .start(sessionId, cwd, code) -> { ok:true, running:true } | { ok:false, code, message }
  .status() -> { running:string[], errors:Record<code,string> }
  .dispose() -> Promise<void>
// 流程：校验 submitting + token/settings + branch 元数据 + worktree 存在 → lint/test →
//        commitAll → push → findOpenMR 复用或 createMergeRequest →
//        写队列内：submit_mr（intent）→ mr_created(expectedWorkflow:'submitting', mr:MRRecord) → patchTicket(mr)
// 失败码：not-submitting|missing-gitlab-token|invalid-gitlab-settings|worktree-missing|
//         delivery-lint-failed|delivery-test-failed|git-failed|push-failed|mr-failed|delivery-busy

// review-service.js
createReviewService({ store, gitlab, git, runner, clock, timer, settings })
  .start() / .dispose() / .status() / .tick() -> Promise<{ checked, transitioned }>
// tick：mr_open/fixing_review 工单 → listNotes → 最新 AI note（去重）→ parse →
//   pass: review_pass(expectedWorkflow:'mr_open')
//   changes: review_requests_changes(mr_open→fixing_review) → 起 review 修复子代理（worktree 内改代码，
//            最多 3 轮）→ commit+push → review_fix_done(expectedWorkflow:'fixing_review') + reviewRounds[]
//   unknown/解析失败: block('review-parse-failed')
//   MR state=merged（mergeable 状态）: mr_merged → merged；下一 tick 自动 dismiss(system) → done（出看板）
//          （若在 mr_open 阶段就被人工合并：block('review-merged-manually')，避免伪造 review pass）
// 错误码：no-gitlab-token|review-fix-failed|review-fix-timeout|review-parse-failed|review-rounds-exhausted

// agent-access.js 扩展
runReviewFix({ sessionId, worktreePath, ticket, plan, mr, findings, timeoutMs = 900000, signal })
  -> 与 runFix 同形状 { ok:true, result:{summary,changedFiles,testResult,notes}, childId, elapsedMs } | { ok:false, code, message }
```

**Ticket 元数据（v2 字段，不升 domain）**：

```js
mr: { iid, url, sourceBranch, targetBranch, state:'opened|merged|closed',
      verdict:'pass|changes|unknown', blockingIssues:[], nonBlockingIssues:[], rounds:number }
reviewRounds: [{ round, noteId, verdict, startedAt, finishedAt, childId?, changedFiles:[], status }]
branch: { name, target, baseSource, worktree, createdAt }   // P4 已有
fixes:  [ fixRunSchema … ]                                   // review 修复复用，追加 status/notes
```

**路由**：
- `POST /bug-workflow/api/deliver` body `{sessionId, code}` → 200 `{ok:true, running:true, workflow:'submitting'}`；400/404/409/503/500（409：`not-submitting`、`delivery-busy`、`protected-branch`；503：`missing-gitlab-token`、`delivery-unavailable`）。
- `PUT /bug-workflow/api/gitlab-token` body `{sessionId, token}` → 200 `{ok:true}`（保存进 credentials）；`DELETE` → 清除；语义复用平台 token 端点（415/413/400 守卫一致）。
- **snapshot 扩展**：`delivery: { running:string[], errors:Record<code,string> }`、`gitlab: { tokenPresent:boolean }`（保留既有字段）。

---

### Task 1: GitLab 设置/凭证 + review-parser 迁移

**Files:** Modify `bug-workflow/src/host/store.js`（`DEFAULT_SETTINGS.gitlabBaseUrl`）、`src/host/credentials.js`（`GITLAB_TOKEN_REF = 'BUG_WORKFLOW_GITLAB_TOKEN'`，导出名字与校验复用平台 token 逻辑）、`src/host/routes.js`（`/api/gitlab-token` PUT/DELETE、snapshot `gitlab.tokenPresent`、JSDoc/错误映射）、`src/host/index.js` 无改动（token 存储走既有 deps）；new `src/host/review-parser.js`（迁移 `scripts/review-parser.mjs` 主体，导出 `parseReview` 及现有辅助），`scripts/review-parser.mjs` 改为薄复导出；Test `test/credentials.test.js`、`test/routes.test.js`、`test/domain-v2.test.js`（settings 默认值）、新增 `test/review-parser.test.js`（把现在脚本测试改为导入 canonical；脚本级 smoke 保留）。

- [ ] **Step 1: 失败测试**：settings 默认 `gitlabBaseUrl='https://git.htwisdom.cn'` 且旧行缺键读为默认；GitLab token 保存/清除/缺失三种 snapshot 状态；PUT 非字符串/超长/空 → 400，未绑定工作区 → 409，415/413 守卫复用；`parseReview` 经 canonical 导入的全部分支与迁移前一致（pass/changes/unknown、门禁分类、隐藏段裁剪、AI 标记过滤）。
- [ ] **Step 2: 实现**：`DEFAULT_SETTINGS` 加键（domain settingsSchema 由 DEFAULT_SETTINGS 生成，looseObject 兼容旧行，无需升 domain）；`credentials.js` 增加 GitLab ref（保存/读取/清除，token 仅内存 + credentials，不落 store）；routes 增加端点与 snapshot 字段（复用 `guard/guardJsonContentType/guardOrigin/readJsonBody` 与静态错误文案）；迁移 parser：canonical 新文件 + script 复导出 + 所有 import 改 canonical。
- [ ] **Step 3: 验证**：全量 tests 全过；`node --check`；live 只读：reinstall 后 health 200、snapshot 含 `gitlab.tokenPresent:false`、PUT/DELETE 走 415/400/200 路径（不真存 token，或存占位后清）。
- [ ] **Step 4: 提交** `feat(bug-workflow): GitLab 设置与凭证`.

### Task 2: GitLab 客户端 + loopback mock

**Files:** new `bug-workflow/src/host/gitlab.js`、`bug-workflow/test/gitlab.test.js`（+ 复用 `scripts/mock-platform.mjs` 风格写 loopback mock server；fixtures `bug-workflow/fixtures/gitlab/*` 按 P0 真实 note/fixture 结构）。

- [ ] **Step 1: 失败测试**：base URL 规范化（https/http、拒绝带凭据/非 http(s)/带 query）；project path 编码（含 `/` 与 `%2F`）；`PRIVATE-TOKEN` header 必填、token 缺失 → `no-token` 不发请求；401/403/404/429/5xx/网络断连/超时/非 JSON → 对应静态 code，错误 message 不含 token；`findOpenMergeRequest` 无 open → null；`createMergeRequest` 请求体字段（source_branch/target_branch/title/description/remove_source_branch=false，无 reviewer_ids）；`listNotes` 排序参数与响应形状；`redirect:'error'` 不跟随重定向（301 → bad-response，不泄漏 header）；响应体大小上限。
- [ ] **Step 2: 实现** `createGitlabClient`（注入 fetchImpl；`AbortController` 超时；JSON 解析防御；`webUrl` 字段归一为 `url`；不打印任何 header/token）。
- [ ] **Step 3: 验证**：tests 全过；`node --check`。
- [ ] **Step 4: 提交** `feat(bug-workflow): GitLab 客户端`.

### Task 3: git commit/push + delivery-service + `/api/deliver`

**Files:** Modify `bug-workflow/src/host/git.js`（`assertPushableBranch`/`revParse`/`commitAll`/`pushBranch`）、`src/host/store.js`（`PATCHABLE_TICKET_FIELDS` 加 `mr`、`reviewRounds` + 校验）、`src/host/routes.js`（`/api/deliver` + snapshot `delivery`）、`src/host/index.js`（构造 gitlab/delivery、dispose 顺序）；new `src/host/delivery-service.js`；Test `test/git.test.js`、`test/store.test.js`、`test/routes.test.js`、新增 `test/delivery-service.test.js`（临时 git 仓库 + 本地 bare origin + loopback mock GitLab）。

- [ ] **Step 1: 失败测试**（真 git，临时仓库）：
  - `assertPushableBranch` 拒绝 main/dev/feature-x/hotfix-x/release-x（含大小写/前缀变体），允许 feat-X-user/hot-X-user/自定义非保护分支；
  - `commitAll`：有改动 → sha 且工作树干净；无改动 → sha null 不写空提交；提交信息含工单号（防注入：消息作为单个 `-m` 参数，不做 shell 拼接）；
  - `pushBranch`：推到本地 bare origin 成功、创建上游；保护分支被拒绝；不传 `--force`；
  - delivery：`submitting` + 完整配置 → lint/test 执行（注入 execCommand：成功；lint 失败 → block `delivery-lint-failed` 且不 commit/push；test 失败同理）→ commit → push → MR 创建（title=`<source> -> <target>`、description 含工单链接/方案摘要/测试说明）→ 写队列内 `submit_mr`+`mr_created(expectedWorkflow:'submitting')`+`patchTicket(mr)`；已有 open MR → 复用不重复创建；缺 token/settings/worktree/分支 → 静态 409/503/400，零写入；重入单飞（`delivery-busy`）；迟到/取消不回退已提交的 `mr_open`。
- [ ] **Step 2: 实现** git 扩展（execFile 参数数组，超时 30s；push 前硬校验）、store 字段扩展（mr/reviewRounds 形状校验，写队列内）、delivery-service（步骤化、每步失败静态映射、状态写入带 expectedWorkflow）、路由与 index 接线（`deliveryDeps` 未接线 → `/api/deliver` 503 `delivery-unavailable`、snapshot 空形状）。
- [ ] **Step 3: 验证**：全量 tests 全过；live 只读：snapshot 含 `delivery:{running:[],errors:{}}`、`/api/deliver` 未接线/未知工单/非 submitting 的 503/404/409；不执行真 push。
- [ ] **Step 4: 提交** `feat(bug-workflow): 提交推送与 MR 创建`.

### Task 4: Review 轮询 + review 修复轮 + 合并检测/自动归档

**Files:** new `bug-workflow/src/host/review-service.js`；Modify `src/host/agent-access.js`（`runReviewFix`，prompt 含：review findings 数据块、只改 worktree、禁 commit/push/联网、禁止 resolve/approve）、`src/host/index.js`（timer 接线、dispose 排水）、`src/host/store.js`（reviewRounds 校验如 Task 3 未覆盖）；Test 新增 `test/review-service.test.js`（loopback mock GitLab + 临时 git 仓库 + fake runner + fake timer/clock）。

- [ ] **Step 1: 失败测试**：
  - `tick()`：无 token → 不请求、不写状态；`mr_open` + 新 `可直接合并` note → `review_pass`（expectedWorkflow 'mr_open'）→ `mergeable`；`需要修改` → `review_requests_changes` → `fixing_review` → runner（worktree 内）成功 → commit+push → `review_fix_done`（expectedWorkflow 'fixing_review'）+ `mr.rounds+1`/`reviewRounds[]`；runner 失败/超时 → `block('review-fix-failed')` 可重试；第 4 轮 → `block('review-rounds-exhausted')`；
  - 解析失败/未知格式 → `block('review-parse-failed')`，不自动重试（重复 tick 幂等）；非 AI note/其它机器人 note/隐藏段不进入上下文；
  - note 去重：同一 note id 不重复触发；`fixing`（修复中）工单不参与轮询；
  - 合并检测：`mergeable` + MR `state=merged` → `mr_merged` → `merged`；下一 tick 自动 `dismiss`(system) → `done`（看板移除）；`mr_open` 阶段被人工合并 → `block('review-merged-manually')`；
  - timer：`start()` 后 interval 触发 `tick`，`dispose()` 清 timer 且进行中 job 不写状态；迟到结果不回退。
- [ ] **Step 2: 实现** review-service（tick 串行、去重 meta、错误静态化、状态条件写）、agent-access.runReviewFix（复用 runChild/提取/校验/取消模式）、index timer 接入 `ctx.get('timer')` 与 dispose 排水。
- [ ] **Step 3: 验证**：全量 tests 全过；live 只读：reinstall 后 snapshot 含 delivery、无 token 时 tick 不产生请求（日志）；不操作真实 GitLab。
- [ ] **Step 4: 提交** `feat(bug-workflow): AI Review 轮询与修复轮`.

### Task 5: Client P5 UX + E2E 脚本 + README/findings + 收尾

**Files:** Modify `bug-workflow/client.js`（settings GitLab 字段/token 卡、submitting 提交按钮、mr_open/fixing_review/mergeable/merged 面板、delivery/gitlab snapshot 归一、错误文案）、`bug-workflow/README.md`（P5 章节）、新增 `docs/superpowers/spikes/2026-11-07-p5-findings.md`、新增 `bug-workflow/scripts/e2e-delivery.mjs`（隔离 E2E：临时仓库 + 本地 bare origin + loopback mock GitLab + 真 store/domain/delivery/review 服务 + fake review-fix runner，跑完整链路 fix_done→submitting→MR→changes→修复→pass→merged→done 并断言看板消失）；Test 现有全绿 + client-action-map 不变。

- [ ] **Step 1: client 实现**：
  - 设置页：`gitlabBaseUrl` 输入、GitLab token 保存/清除卡（与平台 token 卡同交互，snapshot `gitlab.tokenPresent`）；校验/提示复用平台 token 文案模式。
  - `submitting`：显示「提交并创建 MR」按钮（先 mark_test_passed 之后），POST `/api/deliver`，运行中显示进度横幅（`snapshot.delivery.running`）+ 静态错误映射（`missing-gitlab-token`/`protected-branch`/`delivery-lint-failed`/`delivery-test-failed`/`delivery-busy`/`mr-failed`）；演示 `submit_mr`/`mr_created` 按钮隐藏（host 接管），action-map literal 不变。
  - `mr_open`/`fixing_review`：MR 卡（!iid、URL、source→target、Review 轮次 n/3、最近结论、轮询提示）；`fixing_review` 显示「AI 正在修复 Review 问题…」计时（轮询/running 状态）；`mergeable` 显示「AI Review 通过，等待人工合并（插件不会自动合并）」；`merged` 显示「已合并，即将从看板移除」；`done` 不出现在看板（既有过滤）。
  - 错误/空态防御、主题 token、`require('react')` only、aria-live 计时关闭。
- [ ] **Step 2: E2E 脚本**：`node bug-workflow/scripts/e2e-delivery.mjs` 在临时目录跑完整链路（含 lint/test 命令、commit 信息断言、MR 创建/复用、review 需要修改→修复→pass、merge→自动归档），退出码 0/1，输出关键断言；不联网、不触碰真实仓库/真实 GitLab。
- [ ] **Step 3: 验证**：`node --test bug-workflow/test/*.test.js` 全绿；`node --check`；E2E 脚本通过；live 只读：reinstall 后看板 snapshot/health 正常、settings 新字段可见（GUI 视觉与真实 GitLab 由用户验收）。
- [ ] **Step 4: 文档**：README P5 章节（提交流程/GitLab 配置/轮询与轮次/合并归档/硬边界/已知限制）；findings 记录 E2E、未验证项（真实 GitLab token/业务仓库、GUI 视觉、Windows）；写清用户验收清单。
- [ ] **Step 5: 提交** `docs(bug-workflow): P5 交付验收记录`（+ 可能的 fix commit）。

## P5 退出标准

- `node --test bug-workflow/test/*.test.js` 全绿（git/gitlab/delivery/review/routes/store/parser 新用例）。
- E2E 脚本在隔离环境跑通完整链路：submitting → MR 创建 → review changes → 修复提交推送 → review pass → mergeable → merged → done 出看板；硬边界用例（保护分支/force/merge/close/approve/waive）全部拒绝。
- live：插件卸载重装后 snapshot 含 `delivery`/`gitlab`，`/api/deliver` 未配置时 503 且看板提示正确；真实 GitLab 推送/MR 不执行（无 token/真实业务仓库），列为用户验收项。
- 无 Critical/Important 审查问题；GUI 视觉、真实 GitLab、真机人工测试列为用户验收项。
- 全部合并回 `main`（`--no-ff`，测试全绿后删分支）。
