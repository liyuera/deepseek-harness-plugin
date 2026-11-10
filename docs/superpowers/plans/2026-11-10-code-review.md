# 会话内代码审查插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `code-review/` 下交付一个 host-only 的 dsh 插件：每轮 AI 改完代码，自动用只读子代理按预制规范审一遍，把带文件/行号/标签的结果回注给主代理修，并用 `/review` 提供人工入口。

**Architecture:** 一个 Cordis host 插件 + 一个随包发布的 Agent Preset。插件在 `agent/turn-stopping` 里从 `ctx.workspaceChanges` 取本轮逐文件 hunk，用 `ctx.subagents.startActivation` 起一个挂 `code-review` preset 的只读子代理（`outputSchema` 约束返回结构），把 findings 渲染成文本后 `agent.steer` 回注；主代理负责修。规范分两层：`principles.md`（散文，决定召回）与 `rules.json`（带 id 的硬规则，决定标签稳定性）。

**Tech Stack:** DSH 0.2.2-rc.1（Cordis 插件 API：`ctx.on('agent/turn-stopping')` / `ctx.workspaceChanges` / `ctx.subagents.startActivation` / `ctx.commands.register` / `ctx.logger`）、纯 ESM JavaScript（无构建步骤、零运行时依赖）、`node:test` + `node:assert`。

**依据：** [设计文档](../specs/2026-11-09-code-review-design.md)（§16 已记录 M0 运行时核签结论）。

## Global Constraints

- 目标运行环境 DSH 0.2.2-rc.1；包名 `@liyuera/dsh-code-review`，目录 `code-review/`。
- 插件只用纯 ESM JavaScript，**不引入构建步骤、不引入运行时依赖**。测试与源码同构，`node --test test/*.test.js` 可直接跑。
- 规范文件用 **JSON**（`rules/rules.json`）而不是 YAML：避免为解析多引一个依赖；JSON 是 YAML 子集，日后要换 YAML 只替换 loader。
- 验证阶段一律用一次性 patch 叠加：`dsh --profile headless --patch <file>`。**禁止**手写 `~/.dsh/profiles/*` 下的 `package.json` / `cordis.patch.yml`，**禁止**在 profile 目录跑 pnpm；正式安装只在用户明确要求时用 `plugin_manager(action:'install_bundle', target:<abs path>)`。
- headless 跑真实模型需要 `DEEPSEEK_API_KEY` 在启动环境里；从 `~/.dsh/.credentials.yaml` 取值时不得打印、不得写入仓库。
- 子代理 preset 必须结构上只读：`dsh-tool-fs` 的 `write`/`edit`/`applyPatch` 全 `false`，且不挂任何 bash/终端行。
- 提交风格：`feat(code-review): …` / `test(code-review): …` / `docs(code-review): …`；一个 task 至少一个 commit。
- 禁止在插件里记录 diff 正文、finding 全文、任何凭据到日志。

## 已确认的前置事实（M0 实测，直接用，不要重查）

- `agent/turn-stopping` 监听签名 `ctx.on('agent/turn-stopping', async ({ agent, turn }) => {})`；主会话 `agent.session.header.origin` 是**空值**，子代理是 `'subagent'`，所以门禁判据只能写「等于 `subagent`」。
- `ctx.workspaceChanges.summary(sessionId, seq)` 返回 `{ turn, cwd, files, total, added, deleted, snapshot? }`；`files[i]` 有 `path` / `display` / `added` / `deleted`。
- `ctx.workspaceChanges.diff(sessionId, seq, index, signal)` 返回 `{ kind:'text', path, display, before, after, hunks, coarse }` 或 `{ kind:'binary'|'oversized'|refusal, path, display }`；`hunks[i]` 是 `{ oldStart, oldLines, newStart, newLines, lines: string[] }`，行首是 ` ` / `+` / `-`。
- `ctx.subagents.startActivation({ provider, label, delivery:'caller', signal, request })` 返回 `{ childId, messageId?, result, dispose }`；`request` 支持 `{ parent, prompt, agentPreset, outputSchema, agentOptions }`。
- `agent.steer(message)` 的消息必须含 `source`，否则渲染时 `Cannot read properties of undefined (reading 'kind')`；最小可用形状 `{ id: crypto.randomUUID(), role:'user', source:{ kind:'user' }, content:[{ type:'text', text }] }`。
- `steer` 之后 turn 号不变，同一 turn 会再次触发 turn-stopping。轮数必须按 `(sessionId, turn)` 自己计数。
- preset 里 `@deepseek-ai/dsh-tool-fs-search` 的 `sampleOverCapGlobResults` 是必填字段。
- 结论：`agent/turn-stopping` → 取材 → 起子代理 → steer 整条链路已在 headless 上跑通。

## File Structure

```
code-review/
  package.json               # 无构建、无依赖；dsh.bundle.patch 指向 cordis.patch.yml
  cordis.patch.yml           # 两条 insert：code-review preset + 本插件
  patch-dev.yml              # 本机自测覆盖层（gitignored，不入库）
  index.js                   # 装配入口 apply(ctx, config)
  rules/
    principles.md            # 原则层（散文）
    rules.json               # 规则层（带 id 的硬规则）
  src/host/
    config.js                # 配置校验（纯函数）
    collect.js               # 取材：workspaceChanges → 逐文件 diff + 截断
    rules.js                 # 规范加载、校验、prompt 渲染
    render.js                # findings → 回注文本（纯函数）
    reviewer.js              # 起子代理、超时、二次校验
    trigger.js               # 门禁真值表（纯函数）
    loop.js                  # 轮次/熔断状态机（纯函数）
    command.js               # /review 处理器
  test/
    config.test.js
    collect.test.js
    rules.test.js
    render.test.js
    reviewer.test.js
    trigger.test.js
    loop.test.js
```

模块边界：`config` / `rules` / `render` / `trigger` / `loop` 是纯函数，不碰 ctx；`collect` / `reviewer` / `command` 只依赖注入进来的服务对象，用假实现测；`index.js` 只做装配与接线，不含业务判断。

---

### Task 1: 包骨架 + 配置校验 + 装配入口

**Files:**
- Create: `code-review/package.json`、`code-review/cordis.patch.yml`、`code-review/index.js`、`code-review/src/host/config.js`
- Test: `code-review/test/config.test.js`

**Interfaces:**
- Produces: `resolveConfig(raw) -> frozen config`，字段为 `{ enabled, auto, maxRounds, blockingSeverities, codeExtensions, maxDiffBytes, reviewerTimeoutMs, reviewerPreset, rulesFile, principlesFile, modelOverride? }`。后续所有 task 只读这个对象。
- Produces: 插件 id `code-review`，preset id `code-review`。

- [ ] **Step 1: 写失败的测试**

`code-review/test/config.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, DEFAULTS } from '../src/host/config.js'

test('无配置时返回默认值', () => {
  const config = resolveConfig()
  assert.equal(config.enabled, true)
  assert.equal(config.auto, true)
  assert.equal(config.maxRounds, 2)
  assert.deepEqual(config.blockingSeverities, ['high', 'medium'])
  assert.equal(config.reviewerPreset, 'code-review')
  assert.ok(Object.isFrozen(config))
})

test('未知键拒绝启动', () => {
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown config key "nope"/)
})

test('非法严重度拒绝', () => {
  assert.throws(() => resolveConfig({ blockingSeverities: ['blocker'] }), /invalid severity "blocker"/)
})

test('maxRounds 必须为正整数', () => {
  assert.throws(() => resolveConfig({ maxRounds: 0 }), /maxRounds must be a positive integer/)
  assert.throws(() => resolveConfig({ maxRounds: 1.5 }), /maxRounds must be a positive integer/)
})

test('扩展名必须带点', () => {
  assert.throws(() => resolveConfig({ codeExtensions: ['ts'] }), /codeExtensions entries must start with "\."/)
})

test('modelOverride 必须成对出现', () => {
  assert.throws(() => resolveConfig({ modelOverride: { provider: 'deepseek' } }), /modelOverride needs both provider and model/)
  const config = resolveConfig({ modelOverride: { provider: 'p', model: 'm' } })
  assert.deepEqual(config.modelOverride, { provider: 'p', model: 'm' })
})

test('覆盖值生效且不污染 DEFAULTS', () => {
  const config = resolveConfig({ maxRounds: 3 })
  assert.equal(config.maxRounds, 3)
  assert.equal(DEFAULTS.maxRounds, 2)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd code-review && node --test test/config.test.js`
Expected: FAIL，`Cannot find module '../src/host/config.js'`

- [ ] **Step 3: 写最小实现**

`code-review/src/host/config.js`：

```js
/** 配置默认值。冻结，避免被调用方改写。 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  auto: true,
  maxRounds: 2,
  blockingSeverities: Object.freeze(['high', 'medium']),
  codeExtensions: Object.freeze([
    '.js', '.jsx', '.ts', '.tsx', '.vue', '.py', '.go', '.java', '.rs', '.css', '.less', '.scss',
  ]),
  maxDiffBytes: 200000,
  reviewerTimeoutMs: 120000,
  reviewerPreset: 'code-review',
  rulesFile: 'rules/rules.json',
  principlesFile: 'rules/principles.md',
})

const KEYS = new Set([...Object.keys(DEFAULTS), 'modelOverride'])
const SEVERITIES = new Set(['high', 'medium', 'low', 'nit'])

function assertPositiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`code-review: ${name} must be a positive integer`)
  }
}

/**
 * 校验并冻结一份配置。未知键、非法枚举、负值一律抛错，不静默兜底。
 * @param {object} [raw] 用户配置
 * @returns {Readonly<object>}
 */
export function resolveConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('code-review: config must be an object')
  }
  for (const key of Object.keys(raw)) {
    if (!KEYS.has(key)) throw new Error(`code-review: unknown config key "${key}"`)
  }
  const merged = { ...DEFAULTS, ...raw }

  for (const field of ['enabled', 'auto']) {
    if (typeof merged[field] !== 'boolean') throw new Error(`code-review: ${field} must be a boolean`)
  }
  assertPositiveInteger('maxRounds', merged.maxRounds)
  assertPositiveInteger('maxDiffBytes', merged.maxDiffBytes)
  assertPositiveInteger('reviewerTimeoutMs', merged.reviewerTimeoutMs)

  if (!Array.isArray(merged.blockingSeverities) || merged.blockingSeverities.length === 0) {
    throw new Error('code-review: blockingSeverities must be a non-empty array')
  }
  for (const severity of merged.blockingSeverities) {
    if (!SEVERITIES.has(severity)) throw new Error(`code-review: invalid severity "${severity}"`)
  }
  if (!Array.isArray(merged.codeExtensions)) {
    throw new Error('code-review: codeExtensions must be an array')
  }
  for (const extension of merged.codeExtensions) {
    if (typeof extension !== 'string' || !extension.startsWith('.')) {
      throw new Error('code-review: codeExtensions entries must start with "."')
    }
  }
  for (const field of ['reviewerPreset', 'rulesFile', 'principlesFile']) {
    if (typeof merged[field] !== 'string' || merged[field].length === 0) {
      throw new Error(`code-review: ${field} must be a non-empty string`)
    }
  }

  let modelOverride
  if (merged.modelOverride !== undefined) {
    const { provider, model } = merged.modelOverride ?? {}
    if (typeof provider !== 'string' || typeof model !== 'string' || !provider || !model) {
      throw new Error('code-review: modelOverride needs both provider and model')
    }
    modelOverride = Object.freeze({ provider, model })
  }

  return Object.freeze({
    enabled: merged.enabled,
    auto: merged.auto,
    maxRounds: merged.maxRounds,
    blockingSeverities: Object.freeze([...merged.blockingSeverities]),
    codeExtensions: Object.freeze([...merged.codeExtensions]),
    maxDiffBytes: merged.maxDiffBytes,
    reviewerTimeoutMs: merged.reviewerTimeoutMs,
    reviewerPreset: merged.reviewerPreset,
    rulesFile: merged.rulesFile,
    principlesFile: merged.principlesFile,
    ...(modelOverride === undefined ? {} : { modelOverride }),
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd code-review && node --test test/config.test.js`
Expected: PASS，7 个 test 全绿

- [ ] **Step 5: 写清单与装配入口**

`code-review/package.json`：

```json
{
  "name": "@liyuera/dsh-code-review",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "cordis.patch.yml", "src", "rules", "test"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`code-review/cordis.patch.yml`：

```yaml
# 两条 insert：审查者 preset（只读工具面 + 人格）与本插件。
- insert:
    - id: preset-code-review
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: code-review
        name: 通用代码审查
        description: 通用代码审查——只读子代理，只审不改
        order: 50
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |-
                你是代码审查者，只做审查，不改代码。你没有写文件、改文件或执行命令的能力。
                对给定的 diff 逐条核对规则，只报告确有把握的问题；拿不准就不报。
              complete: true
              includeRuntimeContext: false
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config:
              read: true
              readImage: false
              write: false
              edit: false
              applyPatch: false
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
            config:
              sampleOverCapGlobResults: false
    - id: code-review
      name: '@liyuera/dsh-code-review'
```

`code-review/index.js`：

```js
/**
 * Host half of `@liyuera/dsh-code-review`.
 * @module @liyuera/dsh-code-review
 */
import { resolveConfig } from './src/host/config.js'

export const name = 'code-review'
export const inject = ['commands']

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] 用户配置
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  ctx.logger.info(`[code-review] loaded preset=${resolved.reviewerPreset} maxRounds=${resolved.maxRounds}`)
}
```

- [ ] **Step 6: 新建自测覆盖层**

`code-review/patch-dev.yml`（仅测试用，不发布）。headless profile 默认没有 `workspace-changes` 与 preset 注册表，所以这个覆盖层必须把它们一起带上；preset 内容与 `cordis.patch.yml` 保持一致，改动时两处同步：

```yaml
- insert:
    - id: dev-agent-presets
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: code-review
    - id: dev-preset-code-review
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: code-review
        name: 通用代码审查
        order: 50
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |-
                你是代码审查者，只做审查，不改代码。你没有写文件、改文件或执行命令的能力。
                对给定的 diff 逐条核对规则，只报告确有把握的问题；拿不准就不报。
              complete: true
              includeRuntimeContext: false
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config:
              read: true
              readImage: false
              write: false
              edit: false
              applyPatch: false
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
            config:
              sampleOverCapGlobResults: false
    - id: dev-workspace-changes
      name: '@deepseek-ai/dsh-workspace-changes'
    - id: code-review
      name: file:///Users/liyu/Documents/www/DeepSeek/deepseek-harness/deepseek-harness-plugin/code-review/index.js
```

把 `code-review/patch-dev.yml` 追加进 `.gitignore`。

- [ ] **Step 7: 确认 patch 能解析**

Run:
```bash
cd /tmp && dsh --profile headless --patch /Users/liyu/Documents/www/DeepSeek/deepseek-harness/deepseek-harness-plugin/code-review/patch-dev.yml --dump-config | tail -5
```
Expected: 输出里出现 `- id: code-review` 与 `name: file:///…/code-review/index.js`

- [ ] **Step 8: 跑一次 headless 冒烟**

Run:
```bash
cd /tmp && DEEPSEEK_API_KEY=$(python3 -c "import re;s=open('$HOME/.dsh/.credentials.yaml').read();print(re.search(r'DEEPSEEK_API_KEY:\s*(\S+)',s).group(1))") \
  dsh --profile headless --patch /Users/liyu/Documents/www/DeepSeek/deepseek-harness/deepseek-harness-plugin/code-review/patch-dev.yml "回复 OK"
```
Expected: 进程正常结束、加载无报错。注意：headless 0.2.2-rc.1 没有为 `ctx.logger` 装 console exporter，这行日志不会出现在 stdout（Task 1 实测）。要确认加载，用临时 `console.error` 探针，或故意传非法配置看 `unknown config key` 报错。

- [ ] **Step 9: 提交**

```bash
cd /Users/liyu/Documents/www/DeepSeek/deepseek-harness/deepseek-harness-plugin
git add code-review .gitignore
git commit -m "feat(code-review): 包骨架、配置校验与装配入口"
```

---

### Task 2: 取材 —— 逐文件 diff、扩展名过滤、字节截断

**Files:**
- Create: `code-review/src/host/collect.js`
- Test: `code-review/test/collect.test.js`

**Interfaces:**
- Consumes: `config`（Task 1）。
- Produces: `isCodeFile(path, extensions) -> boolean`；`renderHunks(hunks) -> string`；`collect({ workspaceChanges, sessionId, seq, config, signal }) -> Promise<{ files: Array<{ path, display, hunks, text, added, deleted }>, skipped: Array<{ path, reason }>, bytes: number }>`。`reason` 取 `'not-code' | 'binary' | 'oversized' | 'unavailable' | 'budget'`。

- [ ] **Step 1: 写失败的测试**

`code-review/test/collect.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { isCodeFile, renderHunks, collect } from '../src/host/collect.js'

const config = { codeExtensions: ['.js', '.ts'], maxDiffBytes: 100 }

test('isCodeFile 按扩展名匹配', () => {
  assert.equal(isCodeFile('src/a.js', ['.js']), true)
  assert.equal(isCodeFile('src/a.tsx', ['.ts']), false)
  assert.equal(isCodeFile('README.md', ['.js']), false)
})

test('renderHunks 输出 unified diff 片段', () => {
  const text = renderHunks([
    { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-const a = 1', '+const a = 2'] },
  ])
  assert.equal(text, '@@ -3,1 +3,1 @@\n-const a = 1\n+const a = 2')
})

test('未匹配扩展名的文件记为 not-code，不取 diff', async () => {
  const workspaceChanges = {
    summary: () => ({ files: [{ path: 'README.md', display: 'README.md' }], total: 1, added: 0, deleted: 0 }),
    diff: async () => { throw new Error('should not be called') },
  }
  const result = await collect({ workspaceChanges, sessionId: 's', seq: 7, config, signal: undefined })
  assert.deepEqual(result.files, [])
  assert.deepEqual(result.skipped, [{ path: 'README.md', reason: 'not-code' }])
})

test('二进制与超限文件进入 skipped，不中断其它文件', async () => {
  const workspaceChanges = {
    summary: () => ({ files: [{ path: 'a.js' }, { path: 'b.js' }, { path: 'c.js' }], total: 3, added: 0, deleted: 0 }),
    diff: async (_s, _q, index) => {
      if (index === 0) return { kind: 'binary', path: 'a.js', display: 'a.js' }
      if (index === 1) return { kind: 'oversized', path: 'b.js', display: 'b.js' }
      return { kind: 'text', path: 'c.js', display: 'c.js', hunks: [], added: 1, deleted: 1 }
    },
  }
  const result = await collect({ workspaceChanges, sessionId: 's', seq: 7, config, signal: undefined })
  assert.deepEqual(result.skipped, [{ path: 'a.js', reason: 'binary' }, { path: 'b.js', reason: 'oversized' }])
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].path, 'c.js')
})

test('超过 maxDiffBytes 后停止累积并标记剩余文件', async () => {
  const big = 'x'.repeat(60)
  const workspaceChanges = {
    summary: () => ({ files: [{ path: 'a.js' }, { path: 'b.js' }, { path: 'c.js' }], total: 3, added: 0, deleted: 0 }),
    diff: async (_s, _q, index) => ({
      kind: 'text',
      path: ['a.js', 'b.js', 'c.js'][index],
      display: ['a.js', 'b.js', 'c.js'][index],
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`+${big}`] }],
      added: 1,
      deleted: 0,
    }),
  }
  const result = await collect({ workspaceChanges, sessionId: 's', seq: 7, config, signal: undefined })
  assert.deepEqual(result.files.map((file) => file.path), ['a.js'])
  assert.deepEqual(result.skipped, [
    { path: 'b.js', reason: 'budget' },
    { path: 'c.js', reason: 'budget' },
  ])
})

test('summary 缺失时返回空结果而不是抛错', async () => {
  const result = await collect({
    workspaceChanges: { summary: () => undefined, diff: async () => undefined },
    sessionId: 's', seq: 7, config, signal: undefined,
  })
  assert.deepEqual(result, { files: [], skipped: [], bytes: 0 })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd code-review && node --test test/collect.test.js`
Expected: FAIL，`Cannot find module '../src/host/collect.js'`

- [ ] **Step 3: 写实现**

`code-review/src/host/collect.js`：

```js
/**
 * 取材：把 `ctx.workspaceChanges` 的本轮摘要转成「可注入审查者的 diff 清单」。
 * @module @liyuera/dsh-code-review/host/collect
 */

/**
 * 判断路径是否属于待审代码。
 * @param {string} path
 * @param {readonly string[]} extensions 形如 `.js`
 * @returns {boolean}
 */
export function isCodeFile(path, extensions) {
  const lowered = String(path ?? '').toLowerCase()
  return extensions.some((extension) => lowered.endsWith(extension))
}

/**
 * 把一个文件的 hunks 渲染成 unified diff 文本。
 * @param {readonly object[]} hunks
 * @returns {string}
 */
export function renderHunks(hunks) {
  return hunks
    .map((hunk) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join('\n')}`)
    .join('\n')
}

/**
 * 收集本轮可审的 diff。
 * @param {object} input
 * @param {{summary:Function,diff:Function}} input.workspaceChanges 服务（可为假实现）
 * @param {string} input.sessionId
 * @param {number} input.seq `workspace/changes` 事件序号
 * @param {object} input.config 已解析配置
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<{files: Array<object>, skipped: Array<{path:string,reason:string}>, bytes: number}>}
 */
export async function collect({ workspaceChanges, sessionId, seq, config, signal }) {
  const summary = workspaceChanges?.summary(sessionId, seq)
  if (summary === undefined) return { files: [], skipped: [], bytes: 0 }

  const files = []
  const skipped = []
  let bytes = 0
  let exhausted = false

  for (let index = 0; index < summary.files.length; index += 1) {
    const file = summary.files[index]
    if (!isCodeFile(file.path, config.codeExtensions)) {
      skipped.push({ path: file.path, reason: 'not-code' })
      continue
    }
    if (exhausted) {
      skipped.push({ path: file.path, reason: 'budget' })
      continue
    }
    const diff = await workspaceChanges.diff(sessionId, seq, index, signal)
    if (diff === undefined) {
      skipped.push({ path: file.path, reason: 'unavailable' })
      continue
    }
    if (diff.kind !== 'text') {
      skipped.push({ path: file.path, reason: diff.kind })
      continue
    }
    const text = renderHunks(diff.hunks)
    if (bytes + text.length > config.maxDiffBytes) {
      exhausted = true
      skipped.push({ path: file.path, reason: 'budget' })
      continue
    }
    bytes += text.length
    files.push({
      path: file.path,
      display: file.display ?? file.path,
      hunks: diff.hunks,
      text,
      added: diff.added,
      deleted: diff.deleted,
    })
  }

  return { files, skipped, bytes }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd code-review && node --test test/collect.test.js`
Expected: PASS，6 个 test 全绿

- [ ] **Step 5: 提交**

```bash
git add code-review/src/host/collect.js code-review/test/collect.test.js
git commit -m "feat(code-review): 取材模块 collect（扩展名过滤、diff 渲染、预算截断）"
```

---

### Task 3: 规范层 —— 加载、校验、prompt 渲染

**Files:**
- Create: `code-review/src/host/rules.js`、`code-review/rules/principles.md`、`code-review/rules/rules.json`
- Test: `code-review/test/rules.test.js`

**Interfaces:**
- Produces: `validateRules(rules) -> void`（不合法即抛）；`loadRules({ rulesPath, principlesPath, readFile }) -> Promise<{ rules, principles }>`；`renderRulesPrompt({ rules, principles }) -> string`。

- [ ] **Step 1: 写失败的测试**

`code-review/test/rules.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateRules, loadRules, renderRulesPrompt } from '../src/host/rules.js'

const valid = [{
  id: 'SEC-002', dimension: 'security', severity: 'high', title: '敏感信息不得入日志',
  check: '日志参数不得出现 token', bad: 'logger.info(token)', good: 'logger.info("ok")',
}]

test('合法规则通过', () => { assert.doesNotThrow(() => validateRules(valid)) })

test('重复 id 拒绝', () => {
  assert.throws(() => validateRules([...valid, { ...valid[0] }]), /duplicate rule id "SEC-002"/)
})

test('id 前缀必须匹配维度', () => {
  assert.throws(
    () => validateRules([{ ...valid[0], id: 'SEC-003', dimension: 'performance' }]),
    /rule "SEC-003" prefix does not match dimension "performance"/,
  )
})

test('缺字段拒绝', () => {
  const { check, ...rest } = valid[0]
  assert.throws(() => validateRules([rest]), /rule "SEC-002" is missing "check"/)
})

test('非法严重度拒绝', () => {
  assert.throws(() => validateRules([{ ...valid[0], severity: 'blocker' }]), /rule "SEC-002" has invalid severity "blocker"/)
})

test('loadRules 读两个文件并校验', async () => {
  const readFile = async (path) => {
    if (path.endsWith('rules.json')) return JSON.stringify(valid)
    return '# 原则\n不要吞异常。'
  }
  const result = await loadRules({ rulesPath: 'rules/rules.json', principlesPath: 'rules/principles.md', readFile })
  assert.equal(result.rules.length, 1)
  assert.match(result.principles, /吞异常/)
})

test('loadRules 在规则文件非法时抛错', async () => {
  const readFile = async () => 'not json'
  await assert.rejects(
    () => loadRules({ rulesPath: 'r.json', principlesPath: 'p.md', readFile }),
    /rules file is not valid JSON/,
  )
})

test('renderRulesPrompt 带 id 与正反例', () => {
  const text = renderRulesPrompt({ rules: valid, principles: '# 原则' })
  assert.match(text, /SEC-002/)
  assert.match(text, /logger\.info\(token\)/)
  assert.match(text, /# 原则/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd code-review && node --test test/rules.test.js`
Expected: FAIL，模块不存在

- [ ] **Step 3: 写实现**

`code-review/src/host/rules.js`：

```js
/**
 * 规范层：加载并校验两层规范（原则 + 硬规则），渲染成审查者 prompt 片段。
 * @module @liyuera/dsh-code-review/host/rules
 */
import { readFile as readFileDefault } from 'node:fs/promises'

const PREFIX_BY_DIMENSION = Object.freeze({
  correctness: 'COR',
  security: 'SEC',
  performance: 'PRF',
  maintainability: 'MNT',
})
const SEVERITIES = new Set(['high', 'medium', 'low', 'nit'])
const FIELDS = ['id', 'dimension', 'severity', 'title', 'check', 'bad', 'good']

/**
 * 校验规则表。任何不合法都抛错——规范是产品的一部分，不静默降级。
 * @param {readonly object[]} rules
 */
export function validateRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('code-review: rules must be a non-empty array')
  }
  const seen = new Set()
  for (const rule of rules) {
    for (const field of FIELDS) {
      if (typeof rule?.[field] !== 'string' || rule[field].length === 0) {
        throw new Error(`code-review: rule "${rule?.id ?? '?'}" is missing "${field}"`)
      }
    }
    if (seen.has(rule.id)) throw new Error(`code-review: duplicate rule id "${rule.id}"`)
    seen.add(rule.id)
    const prefix = PREFIX_BY_DIMENSION[rule.dimension]
    if (prefix === undefined) {
      throw new Error(`code-review: rule "${rule.id}" has invalid dimension "${rule.dimension}"`)
    }
    if (!rule.id.startsWith(`${prefix}-`)) {
      throw new Error(`code-review: rule "${rule.id}" prefix does not match dimension "${rule.dimension}"`)
    }
    if (!SEVERITIES.has(rule.severity)) {
      throw new Error(`code-review: rule "${rule.id}" has invalid severity "${rule.severity}"`)
    }
  }
}

/**
 * 从磁盘加载两层规范。
 * @param {{rulesPath:string, principlesPath:string, readFile?:Function}} input
 * @returns {Promise<{rules: object[], principles: string}>}
 */
export async function loadRules({ rulesPath, principlesPath, readFile = readFileDefault }) {
  let rawRules
  try {
    rawRules = await readFile(rulesPath, 'utf8')
  } catch (error) {
    throw new Error(`code-review: cannot read rules file ${rulesPath}: ${error.message}`)
  }
  let rules
  try {
    rules = JSON.parse(rawRules)
  } catch (error) {
    throw new Error(`code-review: rules file is not valid JSON: ${error.message}`)
  }
  validateRules(rules)
  const principles = await readFile(principlesPath, 'utf8')
  return { rules, principles }
}

/**
 * 渲染成审查者 prompt 的一段文本。
 * @param {{rules: readonly object[], principles: string}} input
 * @returns {string}
 */
export function renderRulesPrompt({ rules, principles }) {
  const table = rules
    .map((rule) => [
      `### ${rule.id} · ${rule.dimension} · ${rule.severity} · ${rule.title}`,
      `检查条件：${rule.check}`,
      `反例：${rule.bad}`,
      `正例：${rule.good}`,
    ].join('\n'))
    .join('\n\n')
  return [
    '## 原则（先读，用于判断长尾问题）',
    principles.trim(),
    '',
    '## 硬规则（逐条核对，finding 必须引用下列 id 之一）',
    table,
  ].join('\n')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd code-review && node --test test/rules.test.js`
Expected: PASS，8 个 test 全绿

- [ ] **Step 5: 写首版规范内容**

`code-review/rules/principles.md`：

```markdown
# AI 生成代码的审查原则

## 正确性
判断标准：改动是否在真实输入下做对该做的事。
阻塞：会导致错误结果、数据损坏、崩溃或静默失败的问题。
放过：纯风格差异、等价写法、可读性偏好。

## 安全性
判断标准：是否引入新的信任边界或信息暴露。
阻塞：凭据/令牌/个人数据进入日志或响应、越权访问、命令注入、路径穿越。
放过：仅在内网且无敏感字段的调试输出（仍建议清理）。

## 性能
判断标准：是否引入随数据量放大的成本。
阻塞：循环内查询数据库、无上限的全表扫描、同步阻塞主线程的大计算。
放过：常数级的小开销、已被上层缓存的重复计算。

## 可维护性
判断标准：下一个改这段代码的人是否会被误导。
阻塞：注释与代码矛盾、复制粘贴导致的双份真相、无法测试的巨型函数。
放过：命名偏好、目录位置、注释多少。
```

`code-review/rules/rules.json`（首版 5 条，Task 7 补到 20~25 条）：

```json
[
  {
    "id": "SEC-001",
    "dimension": "security",
    "severity": "high",
    "title": "敏感信息不得进入日志",
    "check": "日志调用的参数里不得出现 token、password、secret、cookie 等变量或字面量",
    "bad": "logger.info(`token=${token}`)",
    "good": "logger.info('token refreshed')"
  },
  {
    "id": "COR-001",
    "dimension": "correctness",
    "severity": "high",
    "title": "不得吞掉异常",
    "check": "catch 块不得为空，也不得只打日志后继续返回看似成功的结果",
    "bad": "try { await save() } catch {}",
    "good": "try { await save() } catch (e) { throw new SaveError('save failed', { cause: e }) }"
  },
  {
    "id": "COR-002",
    "dimension": "correctness",
    "severity": "medium",
    "title": "Promise 必须有处置",
    "check": "每个返回 Promise 的调用要么 await、要么 return、要么显式 void 并带失败处理",
    "bad": "fetchData()",
    "good": "void fetchData().catch(onError)"
  },
  {
    "id": "MNT-001",
    "dimension": "maintainability",
    "severity": "medium",
    "title": "不得用类型断言掩盖错误",
    "check": "不得新增 as any、@ts-ignore、as unknown as",
    "bad": "const user = data as any",
    "good": "const parsed = userSchema.safeParse(data)"
  },
  {
    "id": "MNT-002",
    "dimension": "maintainability",
    "severity": "low",
    "title": "不得留下调试残留",
    "check": "不得提交 console.log、debugger、TODO 占位实现",
    "bad": "console.log('here')",
    "good": "（删除）"
  }
]
```

- [ ] **Step 6: 用真实文件跑一次加载**

Run:
```bash
cd code-review && node -e "
import('./src/host/rules.js').then(async (m) => {
  const r = await m.loadRules({ rulesPath: 'rules/rules.json', principlesPath: 'rules/principles.md' })
  console.log('rules', r.rules.length, 'principles', r.principles.length)
})"
```
Expected: `rules 5 principles <数字>`

- [ ] **Step 7: 提交**

```bash
git add code-review/src/host/rules.js code-review/rules code-review/test/rules.test.js
git commit -m "feat(code-review): 规范两层加载、校验与 prompt 渲染"
```

---

### Task 4: 渲染 —— findings 到回注文本

**Files:**
- Create: `code-review/src/host/render.js`
- Test: `code-review/test/render.test.js`

**Interfaces:**
- Consumes: `collect()` 的 `skipped`。
- Produces: `partition(findings, blockingSeverities) -> { blocking, passive }`；`renderFindings({ findings, skipped, blockingSeverities, summary, mode }) -> string`，`mode` 取 `'report'`（默认，全部 finding）或 `'steer'`（只回注阻塞项，无阻塞返回空串）；`renderPass({ summary }) -> string`。
- Finding 形状（reviewer 必须产出）：`{ ruleId, dimension, severity, location, problem, suggestion }`。

- [ ] **Step 1: 写失败的测试**

`code-review/test/render.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { partition, renderFindings, renderPass } from '../src/host/render.js'

const finding = (over) => ({
  ruleId: 'SEC-001', dimension: 'security', severity: 'high',
  location: 'src/a.ts:42', problem: '令牌进了日志', suggestion: '改记 tokenId', ...over,
})

test('partition 按阈值切分', () => {
  const { blocking, passive } = partition(
    [finding(), finding({ severity: 'low', ruleId: 'MNT-002', dimension: 'maintainability' })],
    ['high', 'medium'],
  )
  assert.equal(blocking.length, 1)
  assert.equal(passive.length, 1)
})

test('renderFindings 带结论、规则、维度、位置、建议', () => {
  const text = renderFindings({
    findings: [finding()],
    skipped: [],
    blockingSeverities: ['high', 'medium'],
    summary: { files: 3, added: 40, deleted: 7 },
  })
  assert.match(text, /结论: 需修改（1 处阻塞）/)
  assert.match(text, /\[SEC-001\] 安全\/high {2}src\/a\.ts:42/)
  assert.match(text, /问题: 令牌进了日志/)
  assert.match(text, /建议: 改记 tokenId/)
})

test('report 模式下非阻塞项单独列出且不增加阻塞计数', () => {
  const text = renderFindings({
    findings: [finding({ severity: 'nit', ruleId: 'MNT-002', dimension: 'maintainability' })],
    skipped: [],
    blockingSeverities: ['high', 'medium'],
    summary: { files: 1, added: 1, deleted: 0 },
  })
  assert.match(text, /结论: 需修改（0 处阻塞，1 处建议）/)
  assert.match(text, /\[MNT-002\] 可维护性\/nit/)
})

test('steer 模式只回注阻塞项；只有建议时返回空串', () => {
  const nit = finding({ severity: 'nit', ruleId: 'MNT-002', dimension: 'maintainability' })
  assert.equal(renderFindings({
    findings: [nit], skipped: [], blockingSeverities: ['high', 'medium'],
    summary: { files: 1, added: 1, deleted: 0 }, mode: 'steer',
  }), '')
  const blocked = renderFindings({
    findings: [finding(), nit], skipped: [], blockingSeverities: ['high', 'medium'],
    summary: { files: 1, added: 1, deleted: 0 }, mode: 'steer',
  })
  assert.match(blocked, /结论: 需修改（1 处阻塞）/)
  assert.doesNotMatch(blocked, /MNT-002/)
})

test('无 finding 时返回空串，让调用方决定不注入', () => {
  assert.equal(renderFindings({
    findings: [], skipped: [], blockingSeverities: ['high'], summary: { files: 1, added: 1, deleted: 0 },
  }), '')
})

test('未审文件带原因', () => {
  const text = renderFindings({
    findings: [finding()], skipped: [{ path: 'a.png', reason: 'binary' }, { path: 'b.js', reason: 'budget' }],
    blockingSeverities: ['high'], summary: { files: 2, added: 1, deleted: 1 },
  })
  assert.match(text, /未审: a\.png（binary）、b\.js（budget）/)
})

test('renderPass 给出规模', () => {
  assert.match(renderPass({ summary: { files: 3, added: 47, deleted: 2 } }), /结论: 通过（本次 3 文件 \/ 49 行变更）/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd code-review && node --test test/render.test.js`
Expected: FAIL，模块不存在

- [ ] **Step 3: 写实现**

`code-review/src/host/render.js`：

```js
/**
 * 把结构化 findings 渲染成回注给主代理的紧凑文本。
 * @module @liyuera/dsh-code-review/host/render
 */
const DIMENSION_LABEL = Object.freeze({
  correctness: '正确性',
  security: '安全',
  performance: '性能',
  maintainability: '可维护性',
})

/**
 * 按阻塞阈值切分 findings。
 * @param {readonly object[]} findings
 * @param {readonly string[]} blockingSeverities
 * @returns {{blocking: object[], passive: object[]}}
 */
export function partition(findings, blockingSeverities) {
  const blockingSet = new Set(blockingSeverities)
  const blocking = []
  const passive = []
  for (const finding of findings) (blockingSet.has(finding.severity) ? blocking : passive).push(finding)
  return { blocking, passive }
}

function findingLines(finding) {
  const label = DIMENSION_LABEL[finding.dimension] ?? finding.dimension
  return [
    `[${finding.ruleId}] ${label}/${finding.severity}  ${finding.location}`,
    `  问题: ${finding.problem}`,
    `  建议: ${finding.suggestion}`,
  ].join('\n')
}

/**
 * 渲染审查结果。
 * @param {{findings: readonly object[], skipped: readonly {path:string,reason:string}[], blockingSeverities: readonly string[], summary: {files:number,added:number,deleted:number}, mode?: 'report'|'steer'}} input
 * @returns {string} 无可回注内容时返回空串
 */
export function renderFindings({ findings, skipped, blockingSeverities, summary, mode = 'report' }) {
  if (findings.length === 0) return ''
  const { blocking, passive } = partition(findings, blockingSeverities)
  if (mode === 'steer' && blocking.length === 0) return ''
  const scope = `本次 ${summary.files} 文件 / ${summary.added + summary.deleted} 行变更`
  const advise = mode === 'report' && passive.length > 0
  const head = blocking.length > 0
    ? `结论: 需修改（${blocking.length} 处阻塞${advise ? `，${passive.length} 处建议` : ''}）`
    : `结论: 需修改（0 处阻塞，${passive.length} 处建议）`
  const sections = []
  if (blocking.length > 0) sections.push(blocking.map(findingLines).join('\n'))
  if (advise) sections.push(`非阻塞建议:\n${passive.map(findingLines).join('\n')}`)
  if (skipped.length > 0) sections.push(`未审: ${skipped.map((item) => `${item.path}（${item.reason}）`).join('、')}`)
  return [`${head} · ${scope}`, ...sections].join('\n')
}

/**
 * 复审通过时的一行结果。
 * @param {{summary: {files:number,added:number,deleted:number}}} input
 * @returns {string}
 */
export function renderPass({ summary }) {
  return `结论: 通过（本次 ${summary.files} 文件 / ${summary.added + summary.deleted} 行变更）`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd code-review && node --test test/render.test.js`
Expected: PASS，7 个 test 全绿

- [ ] **Step 5: 提交**

```bash
git add code-review/src/host/render.js code-review/test/render.test.js
git commit -m "feat(code-review): findings 渲染与阻塞分级"
```

---

### Task 5: 审查者 —— 起只读子代理、超时、二次校验

**Files:**
- Create: `code-review/src/host/reviewer.js`
- Test: `code-review/test/reviewer.test.js`

**Interfaces:**
- Produces: `REVIEW_SCHEMA`；`buildPrompt({ rulesPrompt, files, skipped }) -> string`；`runReview({ subagents, agent, preset, prompt, timeoutMs, modelOverride, signal, allowedRuleIds, allowedPaths }) -> Promise<{ ok:true, findings } | { ok:false, reason }>`。`reason` 取 `'timeout' | 'provider-error' | 'incomplete' | 'invalid-result'`。

- [ ] **Step 1: 写失败的测试**

`code-review/test/reviewer.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt, runReview, REVIEW_SCHEMA } from '../src/host/reviewer.js'

const files = [{ path: 'src/a.ts', display: 'src/a.ts', text: '@@ -1,1 +1,1 @@\n-a\n+b', added: 1, deleted: 1 }]

test('buildPrompt 带变更清单与 diff', () => {
  const prompt = buildPrompt({ rulesPrompt: 'RULES', files, skipped: [{ path: 'x.png', reason: 'binary' }] })
  assert.match(prompt, /RULES/)
  assert.match(prompt, /src\/a\.ts/)
  assert.match(prompt, /@@ -1,1 \+1,1 @@/)
  assert.match(prompt, /x\.png（binary）/)
  assert.match(prompt, /只返回 JSON/)
})

test('schema 要求 findings 数组', () => {
  assert.equal(REVIEW_SCHEMA.type, 'object')
  assert.deepEqual(REVIEW_SCHEMA.required, ['findings'])
})

function fakeSubagents(result) {
  return {
    calls: [],
    async startActivation(spec) {
      this.calls.push(spec)
      return { childId: 'child-1', result: Promise.resolve(result), dispose: async () => {} }
    },
  }
}

const validFinding = {
  ruleId: 'SEC-001', dimension: 'security', severity: 'high',
  location: 'src/a.ts:42', problem: 'p', suggestion: 's',
}

test('成功路径返回校验后的 findings', async () => {
  const subagents = fakeSubagents({ stopReason: 'completed', structured: { findings: [validFinding] } })
  const result = await runReview({
    subagents, agent: { id: 'a' }, preset: 'code-review', prompt: 'P', timeoutMs: 1000,
    signal: new AbortController().signal, allowedRuleIds: new Set(['SEC-001']), allowedPaths: new Set(['src/a.ts']),
  })
  assert.equal(result.ok, true)
  assert.equal(result.findings.length, 1)
  assert.equal(subagents.calls[0].provider, 'spawn')
  assert.equal(subagents.calls[0].delivery, 'caller')
  assert.equal(subagents.calls[0].request.agentPreset, 'code-review')
})

test('stopReason 非 completed 视为失败', async () => {
  const subagents = fakeSubagents({ stopReason: 'error', structured: undefined })
  const result = await runReview({
    subagents, agent: {}, preset: 'code-review', prompt: 'P', timeoutMs: 1000,
    signal: new AbortController().signal, allowedRuleIds: new Set(), allowedPaths: new Set(),
  })
  assert.deepEqual(result, { ok: false, reason: 'incomplete' })
})

test('超出规则或路径范围的 finding 被丢弃', async () => {
  const subagents = fakeSubagents({
    stopReason: 'completed',
    structured: {
      findings: [
        validFinding,
        { ...validFinding, ruleId: 'SEC-999' },
        { ...validFinding, location: 'src/zzz.ts:1' },
      ],
    },
  })
  const result = await runReview({
    subagents, agent: {}, preset: 'code-review', prompt: 'P', timeoutMs: 1000,
    signal: new AbortController().signal, allowedRuleIds: new Set(['SEC-001']), allowedPaths: new Set(['src/a.ts']),
  })
  assert.equal(result.ok, true)
  assert.equal(result.findings.length, 1)
})

test('structured 形状不对视为失败', async () => {
  const subagents = fakeSubagents({ stopReason: 'completed', structured: { nope: true } })
  const result = await runReview({
    subagents, agent: {}, preset: 'code-review', prompt: 'P', timeoutMs: 1000,
    signal: new AbortController().signal, allowedRuleIds: new Set(), allowedPaths: new Set(),
  })
  assert.deepEqual(result, { ok: false, reason: 'invalid-result' })
})

test('超时返回 timeout 并 dispose', async () => {
  let disposed = false
  const subagents = {
    async startActivation() {
      return { childId: 'c', result: new Promise(() => {}), dispose: async () => { disposed = true } }
    },
  }
  const result = await runReview({
    subagents, agent: {}, preset: 'code-review', prompt: 'P', timeoutMs: 20,
    signal: new AbortController().signal, allowedRuleIds: new Set(), allowedPaths: new Set(),
  })
  assert.deepEqual(result, { ok: false, reason: 'timeout' })
  assert.equal(disposed, true)
})

test('服务抛错返回 provider-error', async () => {
  const subagents = { async startActivation() { throw new Error('boom') } }
  const result = await runReview({
    subagents, agent: {}, preset: 'code-review', prompt: 'P', timeoutMs: 1000,
    signal: new AbortController().signal, allowedRuleIds: new Set(), allowedPaths: new Set(),
  })
  assert.deepEqual(result, { ok: false, reason: 'provider-error' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd code-review && node --test test/reviewer.test.js`
Expected: FAIL，模块不存在

- [ ] **Step 3: 写实现**

`code-review/src/host/reviewer.js`：

```js
/**
 * 审查者：把一个只读子代理跑成一次「diff 进、findings 出」的调用。
 * @module @liyuera/dsh-code-review/host/reviewer
 */

/** 审查者必须返回的结构。verdict 由插件推导，不由模型给。 */
export const REVIEW_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ruleId: { type: 'string' },
          dimension: { type: 'string', enum: ['correctness', 'security', 'performance', 'maintainability'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low', 'nit'] },
          location: { type: 'string' },
          problem: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['ruleId', 'dimension', 'severity', 'location', 'problem', 'suggestion'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
})

const DIMENSIONS = new Set(['correctness', 'security', 'performance', 'maintainability'])
const SEVERITIES = new Set(['high', 'medium', 'low', 'nit'])

/**
 * 组装审查者 prompt。
 * @param {{rulesPrompt: string, files: readonly object[], skipped: readonly {path:string,reason:string}[]}} input
 * @returns {string}
 */
export function buildPrompt({ rulesPrompt, files, skipped }) {
  const listing = files.map((file) => `- ${file.display}（+${file.added} / -${file.deleted}）`).join('\n')
  const diffs = files.map((file) => `### ${file.display}\n\`\`\`diff\n${file.text}\n\`\`\``).join('\n\n')
  const unread = skipped.length > 0
    ? `未审文件（不要猜测其内容）：${skipped.map((item) => `${item.path}（${item.reason}）`).join('、')}`
    : ''
  return [
    rulesPrompt,
    '',
    '## 待审变更',
    listing,
    unread,
    '',
    '## Diff',
    diffs,
    '',
    '## 输出要求',
    '只返回 JSON，形状为 {"findings":[{"ruleId","dimension","severity","location","problem","suggestion"}]}。',
    'ruleId 必须是上文硬规则里的 id，长尾问题用 PRINCIPLE-<dimension>；location 必须是 `路径:行号` 且落在本次 diff 的文件内。',
    '只报确有把握的问题；没有问题时返回 {"findings":[]}。不要调用任何工具。',
  ].filter((line) => line !== '').join('\n')
}

function normalizeFinding(finding, allowedRuleIds, allowedPaths) {
  if (typeof finding !== 'object' || finding === null) return undefined
  const { ruleId, dimension, severity, location, problem, suggestion } = finding
  const strings = [ruleId, dimension, severity, location, problem, suggestion]
  if (!strings.every((value) => typeof value === 'string' && value.length > 0)) return undefined
  if (!DIMENSIONS.has(dimension) || !SEVERITIES.has(severity)) return undefined
  const principled = ruleId.startsWith('PRINCIPLE-') && allowedRuleIds.has(`PRINCIPLE-${dimension}`)
  if (!allowedRuleIds.has(ruleId) && !principled) return undefined
  const path = location.split(':')[0]
  if (!allowedPaths.has(path)) return undefined
  return { ruleId, dimension, severity, location, problem, suggestion }
}

/**
 * 跑一次审查。
 * @param {object} input
 * @returns {Promise<{ok:true, findings: object[]} | {ok:false, reason: string}>}
 */
export async function runReview({
  subagents, agent, preset, prompt, timeoutMs, modelOverride, signal, allowedRuleIds, allowedPaths,
}) {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  let activation
  try {
    activation = await subagents.startActivation({
      provider: 'spawn',
      label: 'code-review',
      delivery: 'caller',
      signal: controller.signal,
      request: {
        parent: agent,
        agentPreset: preset,
        outputSchema: REVIEW_SCHEMA,
        ...(modelOverride === undefined ? {} : { agentOptions: modelOverride }),
        prompt: [{ type: 'text', text: prompt }],
      },
    })
  } catch {
    signal?.removeEventListener('abort', onAbort)
    return { ok: false, reason: 'provider-error' }
  }

  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
  })
  let outcome
  try {
    outcome = await Promise.race([activation.result.then((value) => ({ value })), timeout])
  } catch {
    return { ok: false, reason: 'provider-error' }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }

  if (outcome.timedOut === true) {
    controller.abort()
    await activation.dispose?.().catch(() => {})
    return { ok: false, reason: 'timeout' }
  }
  const result = outcome.value
  if (result?.stopReason !== 'completed' || result.structured === undefined) {
    return { ok: false, reason: 'incomplete' }
  }
  const raw = result.structured
  if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.findings)) {
    return { ok: false, reason: 'invalid-result' }
  }
  const findings = raw.findings
    .map((finding) => normalizeFinding(finding, allowedRuleIds, allowedPaths))
    .filter((finding) => finding !== undefined)
  return { ok: true, findings }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd code-review && node --test test/reviewer.test.js`
Expected: PASS，7 个 test 全绿

- [ ] **Step 5: 提交**

```bash
git add code-review/src/host/reviewer.js code-review/test/reviewer.test.js
git commit -m "feat(code-review): 审查者调用、超时与结果二次校验"
```

---

### Task 6: 门禁、轮次与闭环接线

**Files:**
- Create: `code-review/src/host/trigger.js`、`code-review/src/host/loop.js`、`code-review/src/host/command.js`
- Modify: `code-review/index.js`
- Test: `code-review/test/trigger.test.js`、`code-review/test/loop.test.js`

**Interfaces:**
- Produces: `shouldReview({ config, origin, reviewing, rounds, hasChanges, breakerOpen }) -> { review: boolean, reason: string }`。
- Produces: `createTracker() -> { begin(sessionId, turn): boolean, end(sessionId): void, roundsOf(sessionId, turn): number, isReviewing(sessionId): boolean, recordFailure(sessionId): boolean, recordSuccess(sessionId): void, isBreakerOpen(sessionId): boolean, forget(sessionId): void }`。
- Produces: `createReviewCommand({ config, workspaceChanges, subagents, getRules, logger, latestSeq }) -> CommandDefinition`。

- [ ] **Step 1: 写失败的测试**

`code-review/test/trigger.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldReview } from '../src/host/trigger.js'

const base = {
  config: { enabled: true, auto: true, maxRounds: 2 },
  origin: undefined, reviewing: false, rounds: 0, hasChanges: true, breakerOpen: false,
}

test('正常情况放行', () => {
  assert.deepEqual(shouldReview(base), { review: true, reason: 'ok' })
})

test('逐条拒绝并给出原因', () => {
  const cases = [
    [{ config: { enabled: false } }, 'disabled'],
    [{ config: { auto: false } }, 'manual-only'],
    [{ origin: 'subagent' }, 'subagent'],
    [{ reviewing: true }, 'reviewing'],
    [{ rounds: 2 }, 'rounds-exhausted'],
    [{ hasChanges: false }, 'no-changes'],
    [{ breakerOpen: true }, 'breaker-open'],
  ]
  for (const [patch, reason] of cases) {
    const input = {
      ...base,
      ...patch,
      ...(patch.config === undefined ? {} : { config: { ...base.config, ...patch.config } }),
    }
    assert.deepEqual(shouldReview(input), { review: false, reason }, reason)
  }
})
```

`code-review/test/loop.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTracker } from '../src/host/loop.js'

test('begin 加锁并计轮，end 解锁后同一 turn 可再计一轮', () => {
  const tracker = createTracker()
  assert.equal(tracker.begin('s1', 1), true)
  assert.equal(tracker.begin('s1', 1), false)
  assert.equal(tracker.isReviewing('s1'), true)
  tracker.end('s1')
  assert.equal(tracker.begin('s1', 1), true)
  assert.equal(tracker.roundsOf('s1', 1), 2)
  assert.equal(tracker.roundsOf('s1', 9), 0)
})

test('连续两次失败打开熔断，成功清零', () => {
  const tracker = createTracker()
  assert.equal(tracker.recordFailure('s1'), false)
  assert.equal(tracker.recordFailure('s1'), true)
  assert.equal(tracker.isBreakerOpen('s1'), true)
  tracker.recordSuccess('s1')
  assert.equal(tracker.isBreakerOpen('s1'), false)
})

test('不同会话互不影响', () => {
  const tracker = createTracker()
  tracker.recordFailure('s1')
  tracker.recordFailure('s1')
  assert.equal(tracker.isBreakerOpen('s2'), false)
})

test('会话释放后状态清空', () => {
  const tracker = createTracker()
  tracker.begin('s1', 1)
  tracker.forget('s1')
  assert.equal(tracker.isReviewing('s1'), false)
  assert.equal(tracker.roundsOf('s1', 1), 0)
  assert.equal(tracker.begin('s1', 1), true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd code-review && node --test test/trigger.test.js test/loop.test.js`
Expected: FAIL，模块不存在

- [ ] **Step 3: 写门禁与状态机**

`code-review/src/host/trigger.js`：

```js
/**
 * 门禁真值表：按固定顺序短路求值，返回放行与否及原因。
 * @module @liyuera/dsh-code-review/host/trigger
 */

/**
 * @param {{config: object, origin: string|undefined, reviewing: boolean, rounds: number, hasChanges: boolean, breakerOpen: boolean}} input
 * @returns {{review: boolean, reason: string}}
 */
export function shouldReview({ config, origin, reviewing, rounds, hasChanges, breakerOpen }) {
  if (!config.enabled) return { review: false, reason: 'disabled' }
  if (!config.auto) return { review: false, reason: 'manual-only' }
  if (origin === 'subagent') return { review: false, reason: 'subagent' }
  if (reviewing) return { review: false, reason: 'reviewing' }
  if (rounds >= config.maxRounds) return { review: false, reason: 'rounds-exhausted' }
  if (!hasChanges) return { review: false, reason: 'no-changes' }
  if (breakerOpen) return { review: false, reason: 'breaker-open' }
  return { review: true, reason: 'ok' }
}
```

`code-review/src/host/loop.js`：

```js
/**
 * 轮次与熔断状态机。全部在内存，会话释放即清空。
 * @module @liyuera/dsh-code-review/host/loop
 */

/** 连续失败多少次后熔断。 */
const BREAKER_THRESHOLD = 2

/**
 * @returns {object} tracker
 */
export function createTracker() {
  const rounds = new Map()
  const failures = new Map()
  const reviewing = new Set()
  const key = (sessionId, turn) => `${sessionId}:${turn}`

  return {
    /** 加锁并记一轮；同一会话已在审查中返回 false。 */
    begin(sessionId, turn) {
      if (reviewing.has(sessionId)) return false
      const slot = key(sessionId, turn)
      rounds.set(slot, (rounds.get(slot) ?? 0) + 1)
      reviewing.add(sessionId)
      return true
    },
    /** 标记本轮审查结束（无论成败）。 */
    end(sessionId) {
      reviewing.delete(sessionId)
    },
    roundsOf(sessionId, turn) {
      return rounds.get(key(sessionId, turn)) ?? 0
    },
    isReviewing(sessionId) {
      return reviewing.has(sessionId)
    },
    /** 记一次失败；达到阈值返回 true 表示刚打开熔断。 */
    recordFailure(sessionId) {
      const count = (failures.get(sessionId) ?? 0) + 1
      failures.set(sessionId, count)
      return count === BREAKER_THRESHOLD
    },
    recordSuccess(sessionId) {
      failures.delete(sessionId)
    },
    isBreakerOpen(sessionId) {
      return (failures.get(sessionId) ?? 0) >= BREAKER_THRESHOLD
    },
    forget(sessionId) {
      failures.delete(sessionId)
      reviewing.delete(sessionId)
      for (const slot of [...rounds.keys()]) if (slot.startsWith(`${sessionId}:`)) rounds.delete(slot)
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd code-review && node --test test/trigger.test.js test/loop.test.js`
Expected: PASS，6 个 test 全绿

- [ ] **Step 5: 写 `/review` 命令**

`code-review/src/host/command.js`：

```js
/**
 * `/review` 手动入口：只把报告返回给 UI，不回注、不 steer。
 * @module @liyuera/dsh-code-review/host/command
 */
import { collect } from './collect.js'
import { renderFindings, renderPass } from './render.js'
import { buildPrompt, runReview } from './reviewer.js'

/**
 * 组装命令定义。
 * @param {object} deps
 * @returns {object} CommandDefinition
 */
export function createReviewCommand({ config, workspaceChanges, subagents, getRules, logger, latestSeq }) {
  return {
    name: 'review',
    description: '通用代码审查：审查本轮改动并输出报告',
    async handler({ agent, signal }) {
      const rules = await getRules()
      const sessionId = agent.session.id
      const seq = latestSeq(sessionId)
      if (seq === undefined) return { kind: 'error', text: '本轮没有可审查的改动。' }

      const collected = await collect({ workspaceChanges, sessionId, seq, config, signal })
      if (collected.files.length === 0) {
        return { kind: 'error', text: '本轮没有可审查的代码文件（可能是二进制或已超预算）。' }
      }

      const summary = workspaceChanges.summary(sessionId, seq)
      const scope = { files: summary.files.length, added: summary.added, deleted: summary.deleted }
      const reviewed = await runReview({
        subagents,
        agent,
        preset: config.reviewerPreset,
        prompt: buildPrompt({ rulesPrompt: rules.prompt, files: collected.files, skipped: collected.skipped }),
        timeoutMs: config.reviewerTimeoutMs,
        modelOverride: config.modelOverride,
        signal,
        allowedRuleIds: rules.allowedRuleIds,
        allowedPaths: new Set(collected.files.map((file) => file.path)),
      })

      if (!reviewed.ok) {
        logger.warn(`[code-review] /review failed: ${reviewed.reason}`)
        return { kind: 'error', text: `审查未完成（${reviewed.reason}）。` }
      }

      const text = renderFindings({
        findings: reviewed.findings,
        skipped: collected.skipped,
        blockingSeverities: config.blockingSeverities,
        summary: scope,
      })
      return { kind: 'success', text: text === '' ? renderPass({ summary: scope }) : text }
    },
  }
}
```

- [ ] **Step 6: 重写装配入口**

`code-review/index.js`：

```js
/**
 * Host half of `@liyuera/dsh-code-review`.
 * @module @liyuera/dsh-code-review
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from './src/host/config.js'
import { collect } from './src/host/collect.js'
import { loadRules, renderRulesPrompt } from './src/host/rules.js'
import { renderFindings, renderPass } from './src/host/render.js'
import { buildPrompt, runReview } from './src/host/reviewer.js'
import { shouldReview } from './src/host/trigger.js'
import { createTracker } from './src/host/loop.js'
import { createReviewCommand } from './src/host/command.js'

export const name = 'code-review'
export const inject = ['commands', 'subagents', 'workspaceChanges']

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
const PRINCIPLE_IDS = [
  'PRINCIPLE-correctness',
  'PRINCIPLE-security',
  'PRINCIPLE-performance',
  'PRINCIPLE-maintainability',
]

/** 构造一条可被 steer 注入的用户消息。source 必填，漏了渲染时会崩。 */
function message(text) {
  return { id: crypto.randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

/** 加载规范；失败时降级为只用原则层，不阻塞会话。 */
async function loadRulesOrFallback(logger, config) {
  const rulesPath = join(PACKAGE_ROOT, config.rulesFile)
  const principlesPath = join(PACKAGE_ROOT, config.principlesFile)
  try {
    const loaded = await loadRules({ rulesPath, principlesPath })
    return {
      prompt: renderRulesPrompt(loaded),
      allowedRuleIds: new Set([...loaded.rules.map((rule) => rule.id), ...PRINCIPLE_IDS]),
    }
  } catch (error) {
    logger.warn(`[code-review] 规则文件不可用，降级为只用原则层：${error.message}`)
    return { prompt: await readFile(principlesPath, 'utf8'), allowedRuleIds: new Set(PRINCIPLE_IDS) }
  }
}

/**
 * 挂载插件。规范按需加载并记忆，避免在 apply 里做异步初始化。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const tracker = createTracker()
  const latestSeq = new Map()
  const previousBlocking = new Map()
  let rulesPromise

  const getRules = () => (rulesPromise ??= loadRulesOrFallback(ctx.logger, resolved))

  ctx.commands.register(createReviewCommand({
    config: resolved,
    workspaceChanges: ctx.workspaceChanges,
    subagents: ctx.subagents,
    getRules,
    logger: ctx.logger,
    latestSeq: (sessionId) => latestSeq.get(sessionId),
  }))

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'workspace/changes') latestSeq.set(session.id, event.seq)
  })

  ctx.on('session/disposed', (session) => {
    latestSeq.delete(session.id)
    previousBlocking.delete(session.id)
    tracker.forget(session.id)
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    const sessionId = agent.session.id
    const seq = latestSeq.get(sessionId)
    const decision = shouldReview({
      config: resolved,
      origin: agent.session.header?.origin,
      reviewing: tracker.isReviewing(sessionId),
      rounds: tracker.roundsOf(sessionId, turn),
      hasChanges: seq !== undefined,
      breakerOpen: tracker.isBreakerOpen(sessionId),
    })
    if (!decision.review) {
      ctx.logger.debug?.(`[code-review] skip: ${decision.reason}`)
      return
    }
    if (!tracker.begin(sessionId, turn)) return

    try {
      const rules = await getRules()
      const summary = ctx.workspaceChanges.summary(sessionId, seq)
      const collected = await collect({
        workspaceChanges: ctx.workspaceChanges,
        sessionId,
        seq,
        config: resolved,
      })
      if (collected.files.length === 0) return

      const reviewed = await runReview({
        subagents: ctx.subagents,
        agent,
        preset: resolved.reviewerPreset,
        prompt: buildPrompt({ rulesPrompt: rules.prompt, files: collected.files, skipped: collected.skipped }),
        timeoutMs: resolved.reviewerTimeoutMs,
        modelOverride: resolved.modelOverride,
        signal: undefined,
        allowedRuleIds: rules.allowedRuleIds,
        allowedPaths: new Set(collected.files.map((file) => file.path)),
      })

      if (!reviewed.ok) {
        if (tracker.recordFailure(sessionId)) {
          ctx.logger.warn('[code-review] 连续失败，已暂停本会话的自动审查')
        }
        return
      }
      tracker.recordSuccess(sessionId)

      const scope = { files: summary.files.length, added: summary.added, deleted: summary.deleted }
      const text = renderFindings({
        findings: reviewed.findings,
        skipped: collected.skipped,
        blockingSeverities: resolved.blockingSeverities,
        summary: scope,
        mode: 'steer',
      })
      const hadBlocking = previousBlocking.get(sessionId) === true
      previousBlocking.set(sessionId, text !== '')

      if (text !== '') {
        agent.steer(message(`${text}\n\n请按上面每条 finding 修复；修完会再复审一次。如与用户新指令冲突，以用户指令为准。`))
      } else if (hadBlocking) {
        agent.steer(message(`${renderPass({ summary: scope })}\n\n可以收尾了。`))
      }
    } catch (error) {
      ctx.logger.warn(`[code-review] review failed: ${error.message}`)
      tracker.recordFailure(sessionId)
    } finally {
      tracker.end(sessionId)
    }
  })

  ctx.logger.info(`[code-review] loaded preset=${resolved.reviewerPreset} maxRounds=${resolved.maxRounds}`)
}
```

- [ ] **Step 7: 跑全部单测**

Run: `cd code-review && node --test test/`
Expected: PASS，全部 test 绿

- [ ] **Step 8: headless 联调**

Run:
```bash
mkdir -p /tmp/cr-repo && cd /tmp/cr-repo && git init -q 2>/dev/null; printf 'export function add(a,b){return a+b}\n' > m.js
DEEPSEEK_API_KEY=$(python3 -c "import re;s=open('$HOME/.dsh/.credentials.yaml').read();print(re.search(r'DEEPSEEK_API_KEY:\s*(\S+)',s).group(1))") \
  dsh --profile headless --patch /Users/liyu/Documents/www/DeepSeek/deepseek-harness/deepseek-harness-plugin/code-review/patch-dev.yml \
  "把 m.js 里的 add 改成用 try/catch 包住，catch 留空。"
```
Expected: headless 不打印注入的用户消息、也不打印 `ctx.logger`（Task 1 实测），所以要临时加一行 `console.error` 探针：在 `agent.steer` 前打印注入文本前 80 字，跑完后确认探针输出以 `结论:` 开头、且主代理随后按 findings 修改；确认完删掉探针再提交，`git diff` 里不得残留。审查者不得修改任何文件。

- [ ] **Step 9: 提交**

```bash
git add code-review/src/host code-review/index.js code-review/test
git commit -m "feat(code-review): 门禁、轮次熔断与 turn-stopping 闭环"
```

---

### Task 7: 规则补全、README 与端到端验收

**Files:**
- Modify: `code-review/rules/rules.json`、`code-review/rules/principles.md`
- Create: `code-review/README.md`

**Interfaces:**
- 无新增接口；本 task 只补内容与文档。

- [ ] **Step 1: 把规则补到 20~24 条**

按四个维度补齐，每条必须带 `bad` / `good`，且 `severity` 保守（拿不准一律 `low`）。必须覆盖的 AI 生成代码失效模式：

- 正确性：错误分支未处理、边界条件缺失（空数组/空串/0）、并发竞态、`==` 与 `===`、日期时区、浮点比较、`NaN` 比较。
- 安全：日志泄密、SQL/命令拼接、路径穿越、`eval`、宽松 CORS、禁用证书校验。
- 性能：循环内 I/O、N+1 查询、无上限 `map`/`filter` 大数组、同步读大文件。
- 可维护性：复制粘贴重复块、注释与代码不符、死代码与未使用导入、类型断言掩盖、魔法数字、巨型函数。

Run: `cd code-review && node -e "import('./src/host/rules.js').then(async m => { const r = await m.loadRules({rulesPath:'rules/rules.json',principlesPath:'rules/principles.md'}); console.log(r.rules.length) })"`
Expected: 打印 20~24 之间的数字

- [ ] **Step 2: 写 README**

`code-review/README.md` 必须包含：一句话定位、与 bug-workflow GitLab 审查的边界、安装命令（`plugin_manager` 与 `dsh plugin` 两种）、配置表、`/review` 用法、preset id 与其他插件冲突时的降级办法、已知限制（fail-open 静默、只审本轮变更、不复用 GitLab 模板）。

- [ ] **Step 3: 端到端验收（人工）**

在任意真实前端仓库开一轮会话，让 AI 改一个文件，确认：

1. 改完自动出现 `结论:` 注入，不需要敲命令；
2. 审查者没有修改任何文件（`git status` 只有主代理的改动）；
3. 修完后再触发一次，出现 `结论: 通过`；
4. 用 `/review` 手动跑一次，结果只在 UI 出现、不打断对话。

任一条不满足就回到对应 task 修，不要放过。

- [ ] **Step 4: 提交**

```bash
git add code-review/README.md code-review/rules
git commit -m "docs(code-review): 规则补全至 20+ 条并补 README"
```

---

## 自审记录

- **Spec 覆盖**：§6.1 门禁 → Task 6；§6.2 取材 → Task 2；§6.3 审查 → Task 5；§6.4 回注 → Task 6；§6.5 `/review` → Task 6 Step 5；§7 契约 → Task 4/5；§8 规范 → Task 3 + Task 7；§9 策略 → Task 6；§10 配置 → Task 1；§11 结构 → File Structure；§12 可观测性 → Task 6 的 logger 调用；§13 测试 → 每个 task 的 TDD 步骤；§14 风险 → Global Constraints 与 README。
- **与 spec 的两处偏离**（都是实施决策，完成后回写 spec）：① 规则文件用 `rules.json` 而不是 `rules.yaml`，避免为一个解析器引依赖；② v1 把 `workspaceChanges` 作为**硬依赖**（`inject` 里声明），缺它的组合直接不加载插件，而不是回退去跑 `git diff`——web/desktop 默认都有它，回退路径留到 v2。
- **占位符**：无 TBD；每个代码步骤都是可直接粘贴的实现。
- **类型一致性**：`summary` 在 collect/render/command/index 四处都按 `{files, added, deleted}` 使用；`runReview` 的联合返回 `{ok:true,findings}` / `{ok:false,reason}` 在 command 与 index 里用同一方式分支；`getRules()` 统一返回 `{prompt, allowedRuleIds}`。
