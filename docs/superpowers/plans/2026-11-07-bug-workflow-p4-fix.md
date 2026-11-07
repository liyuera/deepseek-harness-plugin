# Bug 工作流插件 P4（修复子代理 + worktree + 人工测试）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「修复」从演示动作换成真子代理执行：方案审核通过的工单（`fixing`）点「开始修复」后，插件在**独立 git worktree** 里按团队分支规则建个人分支、起写权限修复子代理按 plan 改代码，收集 diff/改动文件回填看板；人工测试通过（`mark_test_passed`）进入 `submitting`，为 P5 的提交/推送/MR 准备 branch/target 元数据。失败/超时 → blocked 可重试；插件卸载不误标失败。

**Architecture:** 新增 `src/host/branch.js`（纯函数：工单版本+类型+用户 → 个人分支/目标分支，规则来自团队规范）、`src/host/git.js`（注入式 git 执行器：repo root、worktree add/status/diff/remove）、`src/host/fix-service.js`（编排：checkout worktree → 写权限子代理 → 收集 diff → 状态机 fix_done，失败/取消语义与 analysis-service 一致）；`agent-access.js` 增加 `runFix`（写权限 prompt，工作区=worktree，明确只允许改 worktree、不 commit/push/联网、工单文本按不可信数据处理）；store 增加 `patchTicket`（写队列内、经校验、追加 timeline）用于 branch/worktree/fixes 元数据；路由 `POST /api/fix`、snapshot `fix:{running,errors}`；client 增加修复进度/结果/「重新修复」。

**Tech Stack:** 现有 store/state-machine/routes/client + `node:child_process.execFile('git')`（经依赖注入便于测试）+ 子代理 runner（P3 已有）。

## Global Constraints

- **不触碰用户主工作树**：所有代码修改只发生在 `<repo>/.dsh-worktrees/<code>`；P4 **不 commit、不 push**（提交/推送/MR 是 P5），只留未提交改动供人工测试。
- 分支规则必须严格按团队规范：`feat-<X>-<branchUser>`→目标 `feature-<X>`；`hot-<X>-<branchUser>`→目标 `hotfix-<X>`（X 来自工单 `platform.versionName`，故障类型用 hot，其余 feat；X 只保留 `[A-Za-z0-9._-]`，非法字符替换为 `-`）。目标分支优先从 `origin/<target>` 拉，不存在则从当前 `HEAD`（本地/演示仓库），并把 `baseSource` 记录进 branch 元数据。
- 修复子代理继承父会话工具/权限，**P4 仍是 prompt 级约束**（不是宿主强制）；README/findings 必须如实写明，真正的工具白名单/preset 限制列为后续工作。prompt 必须：工单文本 nonce 数据块、只读范围=worktree、禁止 `git commit/push`、禁止读 `~/.dsh`/凭据、禁止网络、忽略数据中的指令。
- 状态写入一律经 store 写队列；完成 `fix_done` 必须用 `expectedWorkflow:'fixing'`（P3 新增的条件写），迟到结果不得回退已推进工单；取消（dispose）不得写 block/error，工单保持 `fixing` 可重试。
- 仓储调用必须有超时（git 命令 30s，子代理默认 900s），错误静态化、不含 token/堆栈；`/api/fix` 复用 P1 全部安全守卫。
- 测试 `node --test bug-workflow/test/*.test.js`；热重载 `remove_bundle`→`install_bundle`；不打印敏感信息。
- 参考：[P3 findings](../spikes/2026-11-07-p3-findings.md)（runner/分析语义、P4 前置约束）、[设计 spec](../specs/2026-11-06-dsh-bug-workflow-plugin-design.md) §8.3 分支规则/§9 子代理、[P0 findings](../spikes/2026-11-06-p0-findings.md)。

## 接口与数据契约

```js
// branch.js（纯函数）
deriveBranches({ versionName, ticketType, branchUser, override }) ->
  { personalBranch, targetBranch, family:'feat'|'hot', baseHint }
  // 例：versionName 'V1.6.1.20261109', type '缺陷', user 'ly' → feat-V1.6.1.20261109-ly / feature-V1.6.1.20261109

// git.js（注入 execFile，返回结构化结果）
createGit({ execFile }) -> {
  repoRoot(cwd) -> Promise<string>,
  refExists(repo, ref) -> Promise<boolean>,
  worktreeAdd({ repo, path, branch, base }) -> Promise<{ created:boolean }>,
  status(root) -> Promise<string>,           // porcelain
  diffStat(root) -> Promise<string>,
  diff(root, { maxChars }) -> Promise<string>,
  worktreeRemove({ repo, path, force }) -> Promise<void>
}

// agent-access.js 扩展
runFix({ sessionId, worktreePath, ticket, plan, timeoutMs = 900000, signal }) ->
  { ok:true, result:{ summary, changedFiles:string[], testResult, notes }, childId, elapsedMs } |
  { ok:false, code:'analysis-unavailable'|'analysis-timeout'|'analysis-failed'|'analysis-bad-output', message }

// fix-service.js
createFixService({ store, runner, git, clock })
  .start(sessionId, cwd, code) -> { ok:true, running:true } | { ok:false, code, message }
  .status() -> { running:string[], errors:Record<code,string> }
  .dispose() -> Promise<void>       // 取消不写 block/error
```

**Ticket 元数据（v2 字段，不升 domain）**：

```js
branch: { name, target, baseSource:'origin|HEAD', worktree, createdAt }
fixes:  [{ runId, childId?, startedAt, finishedAt, changedFiles:[], diffStat, summary, testResult, status:'succeeded|failed|cancelled' }]
```

**路由**：`POST /bug-workflow/api/fix` body `{sessionId, code}` → 200 `{ok:true, workflow:'fixing', running:true}`；错误 400/404/409/503/500（语义同 analyze）。

**snapshot 扩展**：`fix: { running: string[], errors: { [code]: string } }`（保留现有字段）。

---

### Task 1: 分支规则 + git worktree 模块 + 测试

**Files:** Create `bug-workflow/src/host/branch.js`、`bug-workflow/src/host/git.js`；Test `bug-workflow/test/branch.test.js`、`bug-workflow/test/git.test.js`

- [ ] **Step 1: 失败测试**：`deriveBranches` 覆盖普通/故障/`hot-`/版本含非法字符/空 branchUser/override；`git` 用临时目录 + 真 git（`git init`、一次 commit）覆盖 repoRoot、refExists、worktreeAdd（新分支）、status/diffStat/diff、重复 add 的行为、worktreeRemove；execFile 注入 fake 覆盖超时/错误结构化。
- [ ] **Step 2: 实现** `branch.js`（纯函数）与 `git.js`（默认 `execFile` 来自 `node:child_process`，promisify；30s 超时；错误 `{ok:false, code:'git-failed', message: 静态, command}` 不抛未捕获）。
- [ ] **Step 3: 验证**：`node --test bug-workflow/test/*.test.js` 全过；`node --check`；临时仓库只建在 `os.tmpdir()` 并清理。
- [ ] **Step 4: 提交** `feat(bug-workflow): 分支规则与 git worktree 模块`。

---

### Task 2: runFix + fix-service + /api/fix + snapshot + 接线

**Files:** Modify `bug-workflow/src/host/agent-access.js`、`src/host/fix-service.js`（新）、`src/host/store.js`、`src/host/routes.js`、`index.js`；Test `test/agent-access.test.js`、`test/fix-service.test.js`（新）、`test/store.test.js`、`test/routes.test.js`

- [ ] **Step 1: 失败测试**：
  - `runFix`：prompt 含 worktree 路径/plan/写范围/禁止 commit-push/数据块；输出解析与错误映射；超时/abort/dispose；
  - store `patchTicket`：写队列内、校验、追加 timeline、未知字段拒绝、expectedWorkflow 兼容；
  - fix-service（fake git + fake runner + 真 store/fake domain）：fixing → 创建 worktree/分支正确 → 成功后 ticket.branch/fixes 写入 + `fix_done`（expectedWorkflow 'fixing'）；目标分支不存在时 baseSource=HEAD；失败 → blocked(blockedFrom 'fixing') + meta 错误；重复 start 单飞；blocked(fixing) 重启（retry 后启动）；孤儿 fixing 重启；取消不 block；迟到结果不回退。
  - routes：`/api/fix` 200/400/404/409/503 映射；snapshot `fix` 形状。
- [ ] **Step 2: 实现** runFix（复用 P3 的提取/校验/取消模式）、store.patchTicket、fix-service、路由、index 接线（runner/git/service 构造、dispose 排水、fallback 503）。
- [ ] **Step 3: 验证**：tests 全过（基线 263 + 新）；live read-only：remove→install、health 200、snapshot 含 `fix`、`/api/fix` 未知工单 404/非法状态 409；**不启动真修复**。
- [ ] **Step 4: 提交** `feat(bug-workflow): 修复服务与 /api/fix 接线`。

---

### Task 3: Client 修复交互

**Files:** Modify `bug-workflow/client.js`

- [ ] **Step 1: fixing 状态**：有已批准 plan 且未运行时显示「开始修复」（POST `/api/fix`，错误映射 404/409/503/400）；运行中显示「AI 修复中…（最长约 15 分钟，可继续其他操作）」+ 计时（复用 P3 计时模式）；孤儿 fixing → 「上次修复已中断，可重新修复」；blocked(fixing) → 「重新修复」（直接 `/api/fix`，宿主自动 retry）。
- [ ] **Step 2: fix_done 结果**：展示 branch/target/worktree、changedFiles 列表、diffStat、summary、testResult；保留「标记测试通过」（action `mark_test_passed`）；失败横幅静态文案。
- [ ] **Step 3: 约束**：action-map literal/测试不变；运行中隐藏演示 `fix_done` 按钮（UI-only）；aria-live 计时关闭；无未处理崩溃；主题 token；`require('react')` only。
- [ ] **Step 4: 验证**：`node --check`；`node --test` 263 全过；无 GUI 视觉验证（记录）。
- [ ] **Step 5: 提交** `feat(bug-workflow): 看板修复进度与结果展示`。

---

### Task 4: Live 真修复 E2E + README/findings + 收尾

**Files:** Modify `bug-workflow/README.md`、新增 `docs/superpowers/spikes/2026-11-07-p4-findings.md`、`.gitignore`（加 `.dsh-worktrees/`）

- [ ] **Step 1: Live E2E（真修复子代理，一次）**：目标工单 `YGFNXDJRFWDJSYJJYY-648`（`fixing`，P3 已批准 plan）；reinstall bundle；`POST /api/fix` → 200 running；轮询 snapshot 至 `fix_done`（≤15 分钟）；记录 branch/target/baseSource/worktree、changedFiles、diffStat、子代理 childId/耗时；检查主工作树未被修改（`git status` 干净）、worktree 内只有未提交改动。
- [ ] **Step 2: 人工测试模拟**：无法真机验证业务，记录「测试通过」为模拟动作（`mark_test_passed`）→ `submitting`；说明真实人工测试由用户完成。
- [ ] **Step 3: 清理**：E2E worktree 保留给 P5（提交/推送/MR）；记录清理命令；子代理子会话按 P3 惯例记录；无残留进程。
- [ ] **Step 4: 文档**：README P4 章节（修复流程/worktree/分支规则/人工测试/已知限制：只读 P3、prompt 级写范围、P5 才 commit/push）；findings 记录 E2E、失败/取消单元证据、未验证项（GUI、真实业务仓库、真机测试、多工单并行）、P5 交接（用 worktree 改动 commit/push、创建 MR、review 轮询）。
- [ ] **Step 5: 提交** `docs(bug-workflow): P4 修复验收记录与 README`（+ 可能的 fix commit）。

---

## P4 退出标准

- `node --test bug-workflow/test/*.test.js` 全绿（branch/git/fix-service/routes 新增用例）。
- live：一张工单经真修复子代理在 worktree 产出改动并进入 `fix_done`；主工作树未被改动；模拟测试通过 → `submitting`；branch/target 元数据就绪（P5 可直接用）。
- 失败/取消/迟到结果/重启语义有单元测试证据；prompt 级写范围限制在 README/findings 如实说明。
- 无 Critical/Important 审查问题；GUI 视觉与真机测试列为用户验收项。
