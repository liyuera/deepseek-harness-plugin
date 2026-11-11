# 实施计划：code-review 规则作用域与规则包（v3）

规格：`docs/superpowers/specs/2026-11-09-code-review-design.md` §18。
基线：`main@cd3259c`，`code-review/` 148/148 测试绿。
目标：规则支持可选 `scope`（extensions/globs）与 `sourceId`；新增 `rulePacks` 配置与前端规则包 `rules/packs/frontend-smartui.json`（18 条新增 + 3 条收紧）；审查 prompt/allowedRuleIds/severity 权威表按本次变更文件过滤。

## 任务拆分（1、2 可并行，文件不相交；3 依赖 1）

### Task 1：schema + 作用域过滤 + 规则包加载

**允许改**：`code-review/src/host/rules.js`、`code-review/src/host/scope.js`（新建）、`code-review/src/host/config.js`、`code-review/test/rules.test.js`、`code-review/test/scope.test.js`（新建）、`code-review/test/config.test.js`

API 契约：
```js
// scope.js
export function matchGlob(pattern, path) -> boolean      // *不跨/，**跨目录，?单字符，posix 相对路径
export function ruleAppliesToFile(rule, filePath) -> boolean   // 无 scope→true；extensions 后缀(小写)或 glob 命中→true
export function filterRulesForFiles(rules, filePaths) -> object[]

// rules.js（新增/改造）
export function validateRules(rules)                    // 扩展：可选 sourceId/scope 校验
export async function loadRulesResilient({ rulesPath, principlesPath, packs = [], warn, readFile })
  -> { rules, principles }                               // packs 逐个加载合并；包失败 warn+跳过（isolated fail-open）
export function renderRulesPrompt({ rules, principles }) // 每条带 [sourceId] 标签；rules 为空→「本轮没有适用的硬规则，只按原则审」
export function composeRules({ rules, principles, filePaths })
  -> { prompt, allowedRuleIds, ruleSeverities }          // filter → render → Set/Map 三者一致
```
- `config.js`：`DEFAULTS.rulePacks = Object.freeze([])`；校验 `rulePacks` 必须是数组、元素为非空字符串；返回冻结副本。
- 校验细节（§18.2）：`sourceId` 非空字符串；`scope` 只允许 `extensions`/`globs` 键、都是字符串数组、elements 非空、extensions 以 `.` 开头、scope 至少一个非空数组。
- 包重复 id（与已加载规则撞）→ 该包非法：warn + 跳过，基础规则保留。包内重复 id 同理。
- `validateRules` 仍要求 7 个必填字段不变。

测试：scope（`*` 不跨目录、`**` 跨、`?`、多段、无匹配、大小写）、过滤（无 scope/扩展名命/未命/glob 命/未命/空 files）、composeRules 三者一致、empty rules prompt 文案、validateRules 可选字段各非法分支、config rulePacks 校验、loadRulesResilient 包加载/包缺失/坏 JSON/id 重复时降级且基础规则仍在。

**验证**：`node --test test/scope.test.js test/rules.test.js test/config.test.js` 绿；`node --test` 全绿（可能因 index/command 尚未接新 API 而失败——Task 1 需保持向后兼容或同步小改 index/command？**不允许改 index/command**：`loadRulesResilient` 返回值变化会让 index/command 拿到 undefined。因此 Task 1 必须**同时**在 index.js/command.js 里做最小适配：`getRules()` 仍返回 `{prompt, allowedRuleIds, ruleSeverities}`（用 composeRules 传 files=[] 或无过滤版？）——见下「兼容策略」。）
**兼容策略**：Task 1 里 `loadRulesResilient` 改为返回 `{ rules, principles }`，并新增 `legacyPromptForRules`？更简单：让 `getRules()`（index/command 内）暂用 `composeRules({...loaded, filePaths: []})`？filePaths:[] 时所有带 scope 规则会被过滤掉、无 scope 保留——行为合理（未接线前）。但 Task 1 不该改 index/command……**冲突**。
**折中**：Task 1 中 rules.js 保留一个兼容包装 `loadRules()`（旧签名返回 prompt/allowed/severity，内部等价于 composeRules(..., filePaths: undefined) 时不过滤）；index/command 继续用 `loadRulesResilient` 旧名但不接线。**明确实现**：`loadRulesResilient` 返回 `{ rules, principles }` 是新契约；同时导出 `composeRules`；index/command 由 Task 3 接线。为避免 Task 1 期间测试红，Task 1 允许**顺手**把 index.js/command.js 的 `getRules()` 改为调用 `loadRulesResilient` + `composeRules(..., filePaths: [])`（仅这两处、逐字最小 diff，不算完成任务 3 的接线）。Task 3 再把 `filePaths` 换成真实文件列表并补集成测试。

### Task 2：前端规则包内容 + 基础规则收紧

**允许改**：`code-review/rules/rules.json`（3 条收紧）、`code-review/rules/packs/frontend-smartui.json`（新建）、`code-review/test/packs.test.js`（新建）
- 来源文件（只读参考）：`/Users/liyu/Downloads/frontend-code-review-guidelines(2).md`。
- 新增 18 条按规格 §18.6 表：`MNT-008`~`MNT-025`，`dimension: maintainability`，`sourceId` 填对应 `CR-xxx.yy`，`scope` 按表；行为类 medium（MNT-008~012）、风格 low（MNT-013~025）；每条 check 可判定、bad/good 是真实代码片段（尽量 TS/React 语境）。
- 收紧 `MNT-002`（debugger + console.log/debug/info 禁，console.error/warn 允许）、`MNT-003`（≥3 处且每处 ≥5 行或涉及核心/异常/权限分支才算）、`MNT-007`（>200 行强制，>100 建议）。
- `test/packs.test.js`：读 pack → `validateRules` 通过、18 条、id 唯一、5 medium/13 low、每条有 scope 与 sourceId、scope 与 §18.6 表一致（可抽查 key 规则）；`renderRulesPrompt` 含 `[CR-011.01]`；`composeRules` 传 `filePaths: ['src/a.tsx']` 含 MNT-008 不含 MNT-010；传 `['src/a.less']` 反之；传 `['README.md']` → 无规则且 prompt 为「本轮没有适用的硬规则，只按原则审」。
- 注意：`composeRules`/`renderRulesPrompt` 由 Task 1 提供；若并行期间未就绪，先写测试（RED）等 Task 1 落地再 GREEN，或只写纯数据校验测试。

### Task 3：index / `/review` 按文件过滤接线

**允许改**：`code-review/index.js`、`code-review/src/host/command.js`、`code-review/test/index.test.js`、`code-review/test/command.test.js`
- `getRules()` 保持返回 `{ rules, principles }`；审查前：
  `const { prompt, allowedRuleIds, ruleSeverities } = composeRules({ ...loaded, filePaths: collected.files.map(f => f.path) })`，用于 `buildPrompt` 与 `startReview`/`runReview` 参数。
- 集成测试：fake workspaceChanges 给出 `.tsx` 文件 + `rulePacks: ['rules/packs/frontend-smartui.json']` 的 config → 审查者 prompt（捕获 startActivation 的 request.prompt）含 MNT-008、不含 MNT-010；给 `.less` 文件反之；给 `.md` 文件（不在 codeExtensions，collect 空）不会发起。`/review` 同理断言 prompt。
- 注意 index.test 的 fake ctx 需要支持 `rulePacks`（config 透传给 apply）。

### Task 4（控制器）：文档 + E2E + 合并

- README 配置表加 `rulePacks`；「规则与原则」节说明作用域/pack/`sourceId`，给前端仓库启用示例。
- spec §18 已有，回写实际实现差异（若有）。
- E2E（headless + patch + 真模型，临时 `.tsx` 仓库）：变更 `src/pages/A.tsx`，审查者 child 会话 prompt 里应出现 `[CR-011.01]` 等前端规则、不出现 CSS 规则；再改一个 `.less` 文件验证 CSS 规则出现。产物：reviewer child session log 解压后 grep。
- 全量 `node --test`、合并 main。

## 全局约束

- 1、2 并行时互不触碰对方文件；1 允许改 index/command 的 `getRules` 最小适配，但不要做 Task 3 的过滤接线。
- TDD：先 RED 再实现；只提交各自文件；中文一行提交信息；报告 `.superpowers/sdd/task-*.md`（gitignored）。
- 不引新依赖；`package.json` 不动（除非需要 engines 调整，本例不需要）。
