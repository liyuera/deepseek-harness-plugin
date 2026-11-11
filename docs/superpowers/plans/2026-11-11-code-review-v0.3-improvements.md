# code-review v0.3 三项改进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `@liyuera/dsh-code-review` 加三个能力：behavior 维度通用问题规则包、审查留痕（storageDomain 持久化 + `/review` 脚注）、链级全量审查（最后一轮自动 + `/review --full`）。

**Architecture:** 沿用现有分层：`src/host/*` 纯函数/状态模块（可单测），`index.js` 只做装配与事件接线。A 改规则层；B 新增 journal 模块并接入 settle 与命令；C 新增 chain 累积器 + full prompt 构建 + 触发条件，复用现有 collect/fingerprint/tracker/settle。

**Tech Stack:** Node ≥ 22 ESM、`node:test`、Cordis 插件 API、可选 peer `@deepseek-ai/dsh-storage-domain` + `zod`（动态 import，缺失降级内存）。

## Global Constraints

- dsh ≥ 0.2.2-rc.1（`engines.dsh` 不变）；版本目标 **0.3.0**。
- 现有 **219** 个用例必须保持全绿；每任务独立 commit。
- 不引入新的运行时依赖（storage/zod 是**可选 peer**，动态 import + try/catch 降级）。
- 不新增自动注入消息类型；不引入 git 依赖；不重建 MR 级 diff。
- 中文文案风格与现有代码一致；错误信息前缀 `code-review:`；规则 id 前缀必须与维度匹配。
- `notifySeverities` 默认 `[]`、`blockingSeverities` 默认 `["high","medium"]` 不变。
- 所有新配置键严格校验（未知键/非法值抛错），与 `resolveConfig` 现有风格一致。

---

### Task 1: behavior 维度（schema + 渲染）

**Files:**
- Modify: `code-review/src/host/rules.js`
- Modify: `code-review/src/host/render.js`
- Test: `code-review/test/rules.test.js`, `code-review/test/render.test.js`

**Interfaces:**
- Consumes: 现有 `validateRules(rules)` / `renderFindings({...})`
- Produces: `dimension: 'behavior'` 合法，id 前缀 `BEH-`；`PRINCIPLE_IDS` 含 `'PRINCIPLE-behavior'`；渲染标签「行为」

- [ ] **Step 1: 写失败测试（rules）**

`code-review/test/rules.test.js` 追加：

```js
test('behavior 维度使用 BEH 前缀，PRINCIPLE_IDS 含 behavior', () => {
  const rule = {
    id: 'BEH-001', dimension: 'behavior', severity: 'low',
    title: '交互失败必须有反馈', check: '禁止静默 return',
    bad: 'if (!ok) return', good: 'if (!ok) message.info(...)',
  }
  assert.doesNotThrow(() => validateRules([rule]))
  assert.throws(
    () => validateRules([{ ...rule, id: 'MNT-999' }]),
    /prefix does not match dimension "behavior"/,
  )
  assert.ok(PRINCIPLE_IDS.includes('PRINCIPLE-behavior'))
})
```

（`PRINCIPLE_IDS` 需从 `../src/host/rules.js` 导入；该文件顶部已导入 `validateRules`，补上 `PRINCIPLE_IDS`。）

- [ ] **Step 2: 运行确认失败**

Run: `cd code-review && node --test test/rules.test.js`
Expected: FAIL（`prefix does not match dimension "behavior"` 未按预期抛出 / `PRINCIPLE-behavior` 缺失）

- [ ] **Step 3: 最小实现**

`src/host/rules.js`：

```js
const PREFIX_BY_DIMENSION = Object.freeze({
  correctness: 'COR',
  security: 'SEC',
  performance: 'PRF',
  maintainability: 'MNT',
  behavior: 'BEH',
})
```

`PRINCIPLE_IDS` 末尾追加 `'PRINCIPLE-behavior'`。

- [ ] **Step 4: 写失败测试（渲染）**

`code-review/test/render.test.js` 追加：

```js
test('behavior 维度渲染为「行为」', () => {
  const text = renderFindings({
    findings: [finding({ ruleId: 'BEH-001', dimension: 'behavior', severity: 'low', location: 'a.ts:1' })],
    skipped: [],
    blockingSeverities: ['high', 'medium'],
    notifySeverities: ['low'],
    summary: { files: 1, added: 1, deleted: 0 },
    mode: 'notify',
  })
  assert.match(text, /\[BEH-001\] 行为\/low {2}a\.ts:1/)
})
```

- [ ] **Step 5: 运行确认失败**

Run: `cd code-review && node --test test/render.test.js`
Expected: FAIL（输出为 `[BEH-001] behavior/low` 而不是「行为」）

- [ ] **Step 6: 最小实现**

`src/host/render.js` 的 `DIMENSION_LABEL` 追加 `behavior: '行为'`。

- [ ] **Step 7: 全量测试 + 提交**

Run: `cd code-review && node --test test/*.test.js`
Expected: 全部 PASS（219 + 2）

```bash
git add code-review/src/host/rules.js code-review/src/host/render.js code-review/test/rules.test.js code-review/test/render.test.js
git commit -m "feat(code-review): behavior 维度与 BEH 规则前缀"
```

---

### Task 2: general-issues 规则包 + 原则层

**Files:**
- Create: `code-review/rules/packs/general-issues.json`
- Modify: `code-review/rules/principles.md`
- Test: `code-review/test/packs.test.js`

**Interfaces:**
- Consumes: `validateRules`、`loadRulesResilient({ packs })`、`composeRules`
- Produces: 8 条 `BEH-001..BEH-008`、全部 `severity: low`、无 `scope`；启用后 reviewer prompt 含 `### BEH-00x`

- [ ] **Step 1: 写失败测试**

`code-review/test/packs.test.js` 追加（文件顶部已 import `readFile` 则复用，否则 `import { readFile } from 'node:fs/promises'`）：

```js
test('general-issues 包：8 条 behavior 规则全部通过校验且全为 low', async () => {
  const raw = await readFile(new URL('../rules/packs/general-issues.json', import.meta.url), 'utf8')
  const rules = JSON.parse(raw)
  validateRules(rules)
  assert.equal(rules.length, 8)
  assert.deepEqual([...new Set(rules.map((rule) => rule.dimension))], ['behavior'])
  assert.ok(rules.every((rule) => rule.severity === 'low'))
  assert.equal(new Set(rules.map((rule) => rule.id)).size, 8)
})

test('general-issues 启用后 prompt 含 BEH 规则', async () => {
  const loaded = await loadRulesResilient({
    rulesPath: join(PACKAGE_ROOT, 'rules/rules.json'),
    principlesPath: join(PACKAGE_ROOT, 'rules/principles.md'),
    packs: [join(PACKAGE_ROOT, 'rules/packs/general-issues.json')],
  })
  const composed = composeRules({ ...loaded, filePaths: ['src/a.ts'] })
  assert.match(composed.prompt, /### BEH-001/)
  assert.ok(composed.allowedRuleIds.has('BEH-001'))
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd code-review && node --test test/packs.test.js`
Expected: FAIL（ENOENT `general-issues.json`）

- [ ] **Step 3: 写规则包**

`code-review/rules/packs/general-issues.json`（完整内容）：

```json
[
  {
    "id": "BEH-001", "dimension": "behavior", "severity": "low",
    "title": "交互失败必须有用户可见反馈",
    "check": "用户触发的操作被判定为不可处理（非法输入、状态不匹配、前置条件缺失）时，必须有提示、回落为另一条真实路径，或明确禁用控件；禁止静默 return 让界面毫无反应。",
    "bad": "if (state.type !== 'keyword') return",
    "good": "if (state.type === 'incomplete') { message.info('请输入完整坐标'); return }"
  },
  {
    "id": "BEH-002", "dimension": "behavior", "severity": "low",
    "title": "挂载/解绑副作用必须成对",
    "check": "attach/mount 里注册的监听、订阅、视图约束、层级限制，detach/unmount 必须逐一撤销；只撤一半会在实例被复用时留下残留副作用。",
    "bad": "map.on('moveend', handler); return () => { map.un('moveend', handler) }  // applyMaxZoom 写入的 setMaxZoom 未撤销",
    "good": "const previous = view.getMaxZoom(); view.setMaxZoom(next); return () => { map.un('moveend', handler); view.setMaxZoom(previous) }"
  },
  {
    "id": "BEH-003", "dimension": "behavior", "severity": "low",
    "title": "写入前保存原值、卸载时还原",
    "check": "对共享对象（地图 view、全局配置、单例实例）写入前先记录原值，生命周期结束时恢复；否则后续使用方会继承被改过的状态。",
    "bad": "view.setMaxZoom(16)",
    "good": "const previous = view.getMaxZoom(); view.setMaxZoom(16); return () => view.setMaxZoom(previous)"
  },
  {
    "id": "BEH-004", "dimension": "behavior", "severity": "low",
    "title": "卸载/销毁必须清理副作用",
    "check": "组件或模块卸载时必须清理定时器、事件监听、订阅、在途请求；缺少清理会在切页/热更新后重复触发。",
    "bad": "useEffect(() => { const timer = setInterval(sync, 1000) })",
    "good": "useEffect(() => { const timer = setInterval(sync, 1000); return () => clearInterval(timer) })"
  },
  {
    "id": "BEH-005", "dimension": "behavior", "severity": "low",
    "title": "异步回写必须校验请求代次",
    "check": "请求返回后写状态前必须校验它仍是当前请求（seq/abort/代次），过期结果不得覆盖新状态；跳过一次校验就会出现旧数据回写到新界面。",
    "bad": "fetchPoi(keyword).then((list) => setPoiResults(list))",
    "good": "const seq = ++searchSeq.current; fetchPoi(keyword).then((list) => { if (seq === searchSeq.current) setPoiResults(list) })"
  },
  {
    "id": "BEH-006", "dimension": "behavior", "severity": "low",
    "title": "禁止空 catch/静默失败",
    "check": "catch 块不得为空，至少记录或向上抛出；吞掉异常等于把故障藏起来，后续无法定位。",
    "bad": "try { await save() } catch {}",
    "good": "try { await save() } catch (error) { logger.warn('save failed', error); throw error }"
  },
  {
    "id": "BEH-007", "dimension": "behavior", "severity": "low",
    "title": "loading/空结果/错误三态必须收敛",
    "check": "一次用户操作必须能以成功、无结果、失败三种可见终态之一结束；停在 loading 或什么都不发生都属于交互缺陷。",
    "bad": "setLoading(true); const data = await load(); if (!data) return",
    "good": "setLoading(true); try { const data = await load(); setState(data ? 'ok' : 'empty') } catch { setState('error') } finally { setLoading(false) }"
  },
  {
    "id": "BEH-008", "dimension": "behavior", "severity": "low",
    "title": "生命周期钩子不得留下与主流程矛盾的状态",
    "check": "挂载/卸载、激活/停用、进入/退出之间对同一状态的口径必须一致；一处注释或代码声明停用、另一处仍在读写同一状态，会导致后续维护者误判。",
    "bad": "// 已停用：detachZoomLimitRef 没有任何赋值点\nconst detachZoomLimitRef = useRef()\n...\ndetachZoomLimitRef.current = undefined",
    "good": "把停用说明收敛到一处，并删除或标注所有仍在读写该状态的代码"
  }
]
```

- [ ] **Step 4: 运行确认通过**

Run: `cd code-review && node --test test/packs.test.js`
Expected: PASS（两个新用例）

- [ ] **Step 5: 原则层追加**

`code-review/rules/principles.md` 末尾追加：

```markdown
## 行为与生命周期

- 用户触发的每个操作都必须有终态出口：成功、无结果、失败至少一种可见反馈；静默 return 视为缺陷。
- 有副作用的挂载必须成对撤销：监听、订阅、定时器、视图约束、层级限制；写入前保存原值，卸载时还原。
- 异步结果回写前校验请求代次，过期结果不得覆盖当前状态。
- 挂载/卸载、激活/停用之间对同一状态的口径必须一致，注释与代码不得互相矛盾。
```

- [ ] **Step 6: 全量测试 + 提交**

Run: `cd code-review && node --test test/*.test.js`
Expected: 全部 PASS（221 + 2 = 223）

```bash
git add code-review/rules/packs/general-issues.json code-review/rules/principles.md code-review/test/packs.test.js
git commit -m "feat(code-review): 通用问题规则包 general-issues（8 条 BEH 规则）"
```

---

### Task 3: journal 核心模块（留痕存储 + 格式化）

**Files:**
- Create: `code-review/src/host/journal.js`
- Test: `code-review/test/journal.test.js`

**Interfaces:**
- Produces:
  - `createJournalCore({ logger, now })` → `{ attach(table, domain), start({sessionId,turn,seq,mode,files})→key, settle(key, patch), cancel(key, reason), recent(sessionId, limit)→record[], dispose() }`
  - `createJournal({ ctx, logger, now })` → 同上，异步尝试挂 storageDomain，失败/缺失降级内存
  - `formatJournal(records, { now }) → string`（空数组返回 `''`）

- [ ] **Step 1: 写失败测试**

`code-review/test/journal.test.js`（新文件）：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createJournalCore, formatJournal } from '../src/host/journal.js'

function fakeTable() {
  const rows = new Map()
  return {
    rows,
    get: (key) => rows.get(key),
    put: async (key, value) => { rows.set(key, value) },
    delete: async (key) => { rows.delete(key) },
    deleteMany: async (keys) => { for (const key of keys) rows.delete(key) },
    entries: () => rows.entries(),
    keys: () => rows.keys(),
  }
}

const META = { sessionId: 's1', turn: 2, seq: 7, mode: 'turn', files: 3 }

test('start 记录 running，settle 更新完成态与 findings', async () => {
  const table = fakeTable()
  const journal = createJournalCore({ now: () => 1000 })
  journal.attach(table, { close: async () => {} })
  const key = journal.start(META)
  assert.equal(journal.recent('s1')[0].status, 'running')

  journal.settle(key, {
    findings: [{ ruleId: 'MNT-004', dimension: 'maintainability', severity: 'low', location: 'a.ts:1', problem: 'x', suggestion: 'y' }],
    injected: true,
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const record = journal.recent('s1')[0]
  assert.equal(record.status, 'completed')
  assert.equal(record.findingsTotal, 1)
  assert.equal(record.injected, true)
  assert.equal(record.finishedAt, 1000)
})

test('cancel 记录取消原因，recent 按时间倒序', () => {
  const journal = createJournalCore({ now: () => 1 })
  journal.start({ ...META, startedAt: 100 })
  journal.cancel(journal.start({ ...META, seq: 8 }), 'dispose')
  const list = journal.recent('s1')
  assert.equal(list[0].status, 'cancelled')
  assert.equal(list[0].reason, 'dispose')
  assert.equal(list[1].status, 'running')
})

test('每个会话最多保留 50 条', () => {
  const journal = createJournalCore({ now: () => 0 })
  for (let i = 0; i < 60; i += 1) journal.start({ ...META, seq: i })
  assert.equal(journal.recent('s1', 100).length, 50)
})

test('存储写失败只 warn，内存仍然可用', async () => {
  const warns = []
  const table = fakeTable()
  table.put = async () => { throw new Error('disk-full') }
  const journal = createJournalCore({ logger: { warn: (text) => warns.push(text) }, now: () => 0 })
  journal.attach(table, { close: async () => {} })
  journal.start(META)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(journal.recent('s1').length, 1)
  assert.ok(warns.some((text) => text.includes('留痕写入失败')))
})

test('formatJournal 渲染完成/取消/超时与未结论提示', () => {
  const records = [
    { sessionId: 's1', turn: 3, mode: 'full', startedAt: 0, finishedAt: 1, status: 'completed', reason: null, findingsTotal: 2, injected: true },
    { sessionId: 's1', turn: 2, mode: 'turn', startedAt: 0, finishedAt: 1, status: 'cancelled', reason: 'dispose', findingsTotal: 0, injected: false },
  ]
  const text = formatJournal(records, { now: () => 0 })
  assert.match(text, /自动审查记录/)
  assert.match(text, /turn 3 · 全量 · 完成 · 2 条建议（已回灌）/)
  assert.match(text, /已取消（dispose）/)
  assert.match(text, /⚠/)
  assert.equal(formatJournal([]), '')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd code-review && node --test test/journal.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 journal.js**

```js
/**
 * 审查留痕：优先持久化到 storageDomain（可选 peer），不可用时降级内存；
 * `/review` 用 formatJournal 把最近记录渲染成脚注。
 * @module @liyuera/dsh-code-review/host/journal
 */
const DOMAIN_NAME = 'code_review'
const TABLE_NAME = 'reviews'
const MAX_PER_SESSION = 50
const MAX_FINDINGS = 10

const pickFinding = (finding) => ({
  ruleId: String(finding.ruleId ?? ''),
  dimension: String(finding.dimension ?? ''),
  severity: String(finding.severity ?? ''),
  location: String(finding.location ?? ''),
  problem: String(finding.problem ?? ''),
})

const keyOf = (record) => `${record.sessionId}:${record.seq}:${record.startedAt}`

export function createJournalCore({ logger, now = Date.now } = {}) {
  const memory = new Map()
  let table
  let domain

  const remember = (record) => {
    const list = memory.get(record.sessionId) ?? []
    const index = list.findIndex((item) => keyOf(item) === keyOf(record))
    if (index >= 0) list[index] = record
    else list.push(record)
    list.sort((left, right) => left.startedAt - right.startedAt)
    if (list.length > MAX_PER_SESSION) list.splice(0, list.length - MAX_PER_SESSION)
    memory.set(record.sessionId, list)
  }

  const pruneTable = async (sessionId) => {
    if (!table) return
    try {
      const rows = [...table.entries()]
        .filter(([, value]) => value?.sessionId === sessionId)
        .map(([key, value]) => ({ key, startedAt: value.startedAt }))
        .sort((left, right) => left.startedAt - right.startedAt)
      const extra = rows.slice(0, Math.max(0, rows.length - MAX_PER_SESSION))
      if (extra.length > 0) await table.deleteMany(extra.map((row) => row.key))
    } catch (error) {
      logger?.warn?.(`[code-review] 留痕裁剪失败：${error.message}`)
    }
  }

  const write = (record) => {
    remember(record)
    if (!table) return
    void table.put(keyOf(record), record)
      .then(() => pruneTable(record.sessionId))
      .catch((error) => logger?.warn?.(`[code-review] 留痕写入失败：${error.message}`))
  }

  const find = (key) => {
    if (table) {
      try {
        const found = table.get(key)
        if (found !== undefined) return found
      } catch (error) {
        logger?.warn?.(`[code-review] 留痕读取失败：${error.message}`)
      }
    }
    for (const list of memory.values()) {
      const hit = list.find((item) => keyOf(item) === key)
      if (hit !== undefined) return hit
    }
    return undefined
  }

  return {
    attach(nextTable, nextDomain) {
      table = nextTable
      domain = nextDomain
    },
    start({ sessionId, turn, seq, mode, files }) {
      const record = {
        sessionId, turn, seq, mode,
        startedAt: now(), finishedAt: null,
        status: 'running', reason: null,
        files, findingsTotal: 0, findings: [], injected: false,
      }
      write(record)
      return keyOf(record)
    },
    settle(key, patch = {}) {
      const current = find(key)
      if (current === undefined) return
      write({
        ...current,
        finishedAt: now(),
        status: patch.status ?? 'completed',
        reason: patch.reason ?? null,
        findingsTotal: Array.isArray(patch.findings) ? patch.findings.length : current.findingsTotal,
        findings: Array.isArray(patch.findings) ? patch.findings.slice(0, MAX_FINDINGS).map(pickFinding) : current.findings,
        injected: patch.injected === true,
      })
    },
    cancel(key, reason) {
      const current = find(key)
      if (current === undefined) return
      write({ ...current, finishedAt: now(), status: 'cancelled', reason })
    },
    recent(sessionId, limit = 5) {
      let rows
      if (table) {
        try {
          rows = [...table.entries()]
            .map(([, value]) => value)
            .filter((value) => value?.sessionId === sessionId)
        } catch (error) {
          logger?.warn?.(`[code-review] 留痕读取失败：${error.message}`)
        }
      }
      if (rows === undefined) rows = memory.get(sessionId) ?? []
      return [...rows].sort((left, right) => right.startedAt - left.startedAt).slice(0, limit)
    },
    async dispose() {
      const handle = domain
      table = undefined
      domain = undefined
      if (handle === undefined) return
      try {
        await handle.close()
      } catch (error) {
        logger?.warn?.(`[code-review] 留痕关闭失败：${error.message}`)
      }
    },
  }
}

const RECORD_SCHEMA = (z) => z.object({
  sessionId: z.string(),
  turn: z.number(),
  seq: z.number(),
  mode: z.enum(['turn', 'full']),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  status: z.enum(['running', 'completed', 'cancelled', 'timeout', 'failed']),
  reason: z.string().nullable(),
  files: z.number(),
  findingsTotal: z.number(),
  findings: z.array(z.object({
    ruleId: z.string(), dimension: z.string(), severity: z.string(),
    location: z.string(), problem: z.string(),
  })).max(MAX_FINDINGS),
  injected: z.boolean(),
})

async function attachStorage(journal, storageDomain, logger) {
  try {
    const [{ defineDomain, domainTable }, { z }] = await Promise.all([
      import('@deepseek-ai/dsh-storage-domain'),
      import('zod'),
    ])
    const spec = defineDomain({
      name: DOMAIN_NAME,
      version: 1,
      tables: { [TABLE_NAME]: domainTable(RECORD_SCHEMA(z)) },
    })
    const domain = await storageDomain.open(spec)
    journal.attach(domain.table(TABLE_NAME), domain)
  } catch (error) {
    logger?.warn?.(`[code-review] 留痕存储不可用，降级为内存：${error.message}`)
  }
}

export function createJournal({ ctx, logger, now = Date.now } = {}) {
  const journal = createJournalCore({ logger, now })
  const storageDomain = ctx?.get?.('storageDomain')
  if (storageDomain === undefined) {
    logger?.debug?.('[code-review] storageDomain 不可用，留痕仅存内存')
    return journal
  }
  void attachStorage(journal, storageDomain, logger)
  return journal
}

export function formatJournal(records, { now = Date.now } = {}) {
  if (!Array.isArray(records) || records.length === 0) return ''
  const timeOf = (value) => new Date(value).toTimeString().slice(0, 5)
  const lines = ['自动审查记录（最近 5 条）:']
  for (const record of records) {
    const mode = record.mode === 'full' ? '全量' : '单轮'
    let result
    if (record.status === 'running') result = '进行中'
    else if (record.status === 'completed') result = `完成 · ${record.findingsTotal} 条建议（${record.injected ? '已回灌' : '未回灌'}）`
    else if (record.status === 'cancelled') result = `已取消（${record.reason ?? '未知原因'}）· 未出结论`
    else if (record.status === 'timeout') result = '超时 · 未出结论'
    else result = `失败（${record.reason ?? '未知原因'}）· 未出结论`
    lines.push(`- ${timeOf(record.startedAt)} turn ${record.turn} · ${mode} · ${result}`)
  }
  const interrupted = records.find((record) => record.status === 'cancelled' || record.status === 'running')
  if (interrupted !== undefined) {
    lines.push(`⚠ ${timeOf(interrupted.startedAt)} 那次自动审查没有结论（${interrupted.reason ?? interrupted.status}），该 diff 未被审查。`)
  }
  return lines.join('\n')
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd code-review && node --test test/journal.test.js`
Expected: PASS（5 个用例）

- [ ] **Step 5: 提交**

```bash
git add code-review/src/host/journal.js code-review/test/journal.test.js
git commit -m "feat(code-review): journal 留痕模块（storageDomain 持久化 + 内存降级）"
```

---

### Task 4: journal 接线（index）与 `/review` 脚注

**Files:**
- Modify: `code-review/index.js`
- Modify: `code-review/src/host/command.js`
- Test: `code-review/test/index.test.js`, `code-review/test/command.test.js`

**Interfaces:**
- Consumes: `createJournal({ ctx, logger })`、`formatJournal(records)`
- Produces: 每次审查尝试都留一条 journal 记录（turn/mode/status/findings/injected）；`/review` 成功/失败输出追加脚注

- [ ] **Step 1: 写失败测试（index 留痕）**

`code-review/test/index.test.js` 的 `createHarness` 里给 `ctx.get` 增加（保持现有 `agents` 分支）：

```js
    get(service) {
      if (service === 'agents') return { get: (sessionId) => state.agents.get(sessionId) }
      if (service === 'storageDomain') return state.storageDomain
      return undefined
    },
```

state 初始化加 `storageDomain: undefined`。追加测试：

```js
test('审查完成写留痕；/review 脚注显示自动审查记录', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)
  await harness.stop(agent, { seq: 7, turn: 1 })
  harness.resolveNext(completed([FINDING]))
  await tick()

  // 触发一次 /review：命令会跑一次同步审查并追加 journal 脚注
  const command = harness.state.commands[0]
  const result = await command.handler({ agent, rawInput: '', signal: signal() })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /自动审查记录/)
  assert.match(result.text, /完成 · 1 条建议/)
})
```

其中 `command` 定义需要能拿到 journal（见 Step 3/4）；`/review` 是否成功取决于 harness 的 subagents fake（现有 harness `startActivation` 返回手动 resolve 的 Promise，`runReview` 会 await —— 命令测试里需要让 activation 自动 resolve：`harness.resolveNext(completed([FINDING]))` 在调用 handler 之后、await 之前无法插入，因此这里改用 `state.onStart` 里立即 resolve 的写法：

```js
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)
  await harness.stop(agent, { seq: 7, turn: 1 })
  harness.resolveNext(completed([FINDING]))
  await tick()
  harness.state.onStart = () => {
    const entry = harness.state.pending.find((item) => item.settled !== true)
    queueMicrotask(() => { entry.settled = true; entry.resolve(completed([FINDING])) })
  }
```

- [ ] **Step 2: 运行确认失败**

Run: `cd code-review && node --test test/index.test.js`
Expected: FAIL（结果无「自动审查记录」）

- [ ] **Step 3: index.js 接线**

顶部 import：`import { createJournal } from './src/host/journal.js'`。

`apply()` 内、`const tracker = ...` 之后：

```js
  const journal = createJournal({ ctx, logger: ctx.logger })
  /** 在途审查的 journal key：sessionId → key，结算/取消后删除。 */
  const journalKeys = new Map()
```

在 `tracker.begin(sessionId)` 成功、`epoch` 计算后（Task 6 会同时改这里）：

```js
    const mode = 'turn' // Task 6 改为 fullRound ? 'full' : 'turn'
    const journalKey = journal.start({
      sessionId, turn: summary.turn, seq, mode, files: collected.files.length,
    })
    journalKeys.set(sessionId, journalKey)
```

`settle()`：
- 开头 `if (!active || lifetime.signal.aborted)` 分支返回前：

```js
      journalKeys.delete(sessionId)
      journal.cancel(meta.journalKey, 'dispose')
```

- `outcome.ok !== true` 分支：

```js
        journalKeys.delete(sessionId)
        journal.settle(meta.journalKey, { status: 'failed', reason: outcome.reason })
```

- 成功且 `payload === ''` 返回前：

```js
      journalKeys.delete(sessionId)
      journal.settle(meta.journalKey, { status: 'completed', findings: outcome.findings, injected: false })
```

- `live.followup(...)` 成功后：

```js
      journal.settle(meta.journalKey, { status: 'completed', findings: outcome.findings, injected: true })
```

`meta` 增加 `journalKey`（在 `const meta = { ... }` 里加上）。

启动失败/超时分支（`tracker.releaseRound` 前）：

```js
      journalKeys.delete(sessionId)
      journal.settle(journalKey, { status: 'timeout', reason: 'timeout' })
```
（`journalKey` 在该作用域可用；start-failed 分支用 `{ status: 'failed', reason: 'start-failed' }`。）

`session/disposed` 监听里，`inflight` 取消前后：

```js
    const key = journalKeys.get(session.id)
    if (key !== undefined) {
      journalKeys.delete(session.id)
      journal.cancel(key, 'session-disposed')
    }
```

`ctx.effect` 卸载（现有 disposer 已清 inflight/starting/generations，只在其最前面加 journal 两段，其余保持原样）：

```js
  ctx.effect(() => () => {
    // 新增：在途留痕标为 cancelled，并关闭存储 domain
    for (const key of journalKeys.values()) journal.cancel(key, 'plugin-disposed')
    journalKeys.clear()
    void journal.dispose()
    // 以下为现有代码，保持不动
    lifetime.abort()
    for (const handle of inflight.values()) handle.cancel('plugin-disposed')
    inflight.clear()
    for (const control of starting.values()) control.abort()
    starting.clear()
    generations.clear()
  }, 'code-review: dispose in-flight reviews')
```

- [ ] **Step 4: 命令脚注**

`src/host/command.js`：import `formatJournal`；`createReviewCommand({ ..., journal })` 解构加 `journal`。

在 `!reviewed.ok` 分支与成功返回处，统一收口成一个 `withJournal(text)`：

```js
    const withJournal = (text) => {
      const footer = journal === undefined ? '' : formatJournal(journal.recent(sessionId, 5))
      return footer === '' ? text : `${text}\n\n${footer}`
    }
```

`return { kind: 'success', text: withJournal(...) }`；失败分支 `return { kind: 'error', text: withJournal(`审查未完成（${reviewed.reason}）。`) }`。

- [ ] **Step 5: 运行确认通过**

Run: `cd code-review && node --test test/index.test.js test/command.test.js`
Expected: PASS

- [ ] **Step 6: 全量测试 + 提交**

Run: `cd code-review && node --test test/*.test.js`
Expected: 全部 PASS

```bash
git add code-review/index.js code-review/src/host/command.js code-review/test/index.test.js code-review/test/command.test.js
git commit -m "feat(code-review): 审查留痕接线与 /review 记录脚注"
```

---

### Task 5: chain 累积器

**Files:**
- Create: `code-review/src/host/chain.js`
- Test: `code-review/test/chain.test.js`

**Interfaces:**
- Produces: `createChainStore({ maxFiles })` → `{ observe(sessionId, epoch, seq, turn, files, isCode), filesOf(sessionId, epoch), isFull(sessionId, epoch), markFull(sessionId, epoch), forget(sessionId) }`
  - `files` 为 `summary.files`（`{path, display, added, deleted, binary?}`）
  - `filesOf` 返回 `[{ path, display, lastSeq, turns: number[], added, deleted }]`，按 `lastSeq` 升序

- [ ] **Step 1: 写失败测试**

`code-review/test/chain.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createChainStore } from '../src/host/chain.js'

const isCode = (path) => /\.(ts|tsx|js|jsx|vue)$/.test(path)
const file = (path, added = 1, deleted = 0) => ({ path, display: path, added, deleted })

test('跨轮累积同一文件：合并轮次与增删，按 lastSeq 排序', () => {
  const chain = createChainStore({ maxFiles: 20 })
  chain.observe('s1', 1, 10, 1, [file('a.tsx', 3, 1)], isCode)
  chain.observe('s1', 1, 12, 2, [file('b.ts', 2, 0), file('a.tsx', 1, 0)], isCode)
  const files = chain.filesOf('s1', 1)
  assert.deepEqual(files.map((item) => item.path), ['a.tsx', 'b.ts'])
  assert.deepEqual(files[0].turns, [1, 2])
  assert.equal(files[0].added, 4)
  assert.equal(files[0].deleted, 1)
})

test('非代码文件被忽略；超过 maxFiles 保留最近变更', () => {
  const chain = createChainStore({ maxFiles: 2 })
  chain.observe('s1', 1, 1, 1, [file('README.md')], isCode)
  chain.observe('s1', 1, 2, 1, [file('a.ts'), file('b.ts')], isCode)
  chain.observe('s1', 1, 3, 2, [file('c.ts')], isCode)
  assert.deepEqual(chain.filesOf('s1', 1).map((item) => item.path).sort(), ['b.ts', 'c.ts'])
})

test('epoch 变化即新链；markFull 按 epoch 隔离', () => {
  const chain = createChainStore({ maxFiles: 20 })
  chain.observe('s1', 1, 1, 1, [file('a.ts')], isCode)
  chain.markFull('s1', 1)
  assert.equal(chain.isFull('s1', 1), true)
  assert.deepEqual(chain.filesOf('s1', 2), [])
  chain.observe('s1', 2, 2, 1, [file('b.ts')], isCode)
  assert.equal(chain.isFull('s1', 2), false)
  assert.deepEqual(chain.filesOf('s1', 1), [])
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd code-review && node --test test/chain.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 chain.js**

```js
/**
 * 链级累积器：把一条链内所有 turn 的 workspace/changes 文件合并，
 * 供“最后一轮全量审查”和 `/review --full` 使用。
 * @module @liyuera/dsh-code-review/host/chain
 */
export function createChainStore({ maxFiles = 20 } = {}) {
  const chains = new Map()

  const stateOf = (sessionId, epoch) => {
    const current = chains.get(sessionId)
    if (current !== undefined && current.epoch === epoch) return current
    const fresh = { epoch, files: new Map(), full: false }
    chains.set(sessionId, fresh)
    return fresh
  }

  return {
    observe(sessionId, epoch, seq, turn, files, isCode) {
      const state = stateOf(sessionId, epoch)
      for (const file of files ?? []) {
        const path = file.path
        if (typeof path !== 'string' || path.length === 0) continue
        if (typeof isCode === 'function' && isCode(path) !== true) continue
        const item = state.files.get(path) ?? {
          path, display: file.display ?? path, lastSeq: seq, turns: [], added: 0, deleted: 0,
        }
        if (!item.turns.includes(turn)) item.turns.push(turn)
        item.turns.sort((left, right) => left - right)
        item.lastSeq = Math.max(item.lastSeq, seq)
        item.added += file.added ?? 0
        item.deleted += file.deleted ?? 0
        state.files.set(path, item)
      }
      if (state.files.size > maxFiles) {
        const kept = [...state.files.values()]
          .sort((left, right) => right.lastSeq - left.lastSeq)
          .slice(0, maxFiles)
        state.files = new Map(kept.map((item) => [item.path, item]))
      }
    },
    filesOf(sessionId, epoch) {
      const state = chains.get(sessionId)
      if (state === undefined || state.epoch !== epoch) return []
      return [...state.files.values()].sort((left, right) => left.lastSeq - right.lastSeq)
    },
    isFull(sessionId, epoch) {
      const state = chains.get(sessionId)
      return state !== undefined && state.epoch === epoch && state.full === true
    },
    markFull(sessionId, epoch) {
      stateOf(sessionId, epoch).full = true
    },
    forget(sessionId) {
      chains.delete(sessionId)
    },
  }
}
```

- [ ] **Step 4: 运行确认通过 + 提交**

Run: `cd code-review && node --test test/chain.test.js`
Expected: PASS（3 个用例）

```bash
git add code-review/src/host/chain.js code-review/test/chain.test.js
git commit -m "feat(code-review): 链级文件累积器"
```

---

### Task 6: 全量审查（prompt + 末轮触发 + /review --full）

**Files:**
- Modify: `code-review/src/host/reviewer.js`（`buildFullPrompt`）
- Modify: `code-review/src/host/config.js`（`fullReview`、`fullReviewMaxFiles`）
- Modify: `code-review/src/host/command.js`（`--full`）
- Modify: `code-review/index.js`（pending seq flush、full 触发、markFull）
- Test: `code-review/test/reviewer.test.js`, `code-review/test/config.test.js`, `code-review/test/index.test.js`, `code-review/test/command.test.js`

**Interfaces:**
- Consumes: `chain.filesOf/markFull/isFull`、`buildPrompt`、`runReview/startReview`
- Produces: `buildFullPrompt({ rulesPrompt, files, knownFindings }) → string`；`/review --full` 同步全量报告；最后一轮自动 full

- [ ] **Step 1: 写失败测试（reviewer/config）**

`test/reviewer.test.js` 追加：

```js
test('buildFullPrompt 列出链内文件与已报问题，并要求读当前内容', () => {
  const prompt = buildFullPrompt({
    rulesPrompt: '### MNT-004 · maintainability · low · 注释一致',
    files: [
      { path: 'src/a.ts', display: 'src/a.ts', turns: [1, 2], added: 3, deleted: 1 },
      { path: 'src/b.ts', display: 'src/b.ts', turns: [3], added: 1, deleted: 0 },
    ],
    knownFindings: [{ ruleId: 'MNT-004', location: 'src/a.ts:3', problem: '注释与代码不一致' }],
  })
  assert.match(prompt, /链级全量复审/)
  assert.match(prompt, /src\/a\.ts（第 1、2 轮，\+3 \/ -1）/)
  assert.match(prompt, /已报告过的问题/)
  assert.match(prompt, /MNT-004/)
  assert.match(prompt, /structured_output/)
})
```

`test/config.test.js` 追加：

```js
test('fullReview 配置默认与校验', () => {
  const config = resolveConfig()
  assert.equal(config.fullReview, true)
  assert.equal(config.fullReviewMaxFiles, 20)
  assert.throws(() => resolveConfig({ fullReview: 'yes' }), /fullReview must be a boolean/)
  assert.throws(() => resolveConfig({ fullReviewMaxFiles: 0 }), /fullReviewMaxFiles must be a positive integer/)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd code-review && node --test test/reviewer.test.js test/config.test.js`
Expected: FAIL（无 buildFullPrompt / 未知配置键）

- [ ] **Step 3: 实现 buildFullPrompt（reviewer.js）**

```js
/**
 * 链级全量审查 prompt：不塞逐轮 diff，要求审查者读文件当前内容。
 * @param {{rulesPrompt: string, files: readonly {path:string, turns:number[], added:number, deleted:number}[], knownFindings?: readonly object[]}} input
 * @returns {string}
 */
export function buildFullPrompt({ rulesPrompt, files, knownFindings = [] }) {
  const lines = [
    '## 本轮任务：链级全量复审',
    `本条链共改动 ${files.length} 个文件。请用只读工具（read / glob / grep）读取这些文件的**当前内容**，以整体视角审查跨文件、跨轮次的问题：交互失败是否有反馈、挂载/解绑副作用是否成对、写入的状态是否还原、跨文件契约是否一致。不要只看局部 diff。`,
    '',
    '## 审查规则',
    rulesPrompt,
    '',
    '## 链内触达文件',
    ...files.map((file) => `- ${file.path}（第 ${file.turns.join('、')} 轮，+${file.added} / -${file.deleted}）`),
  ]
  if (knownFindings.length > 0) {
    lines.push('', '## 本链已报告过的问题（不要重复报告）')
    lines.push(...knownFindings.slice(0, 20).map((finding) => `- [${finding.ruleId}] ${finding.location} ${finding.problem}`))
  }
  lines.push(
    '',
    '## 输出',
    '用 structured_output 工具输出 findings；只报告确有把握的问题，证据不足不报。',
  )
  return lines.join('\n')
}
```

（现有 `buildPrompt` 结尾的 structured_output 指令文案保持原样，复制同一句式即可。）

- [ ] **Step 4: config 实现**

`config.js`：`DEFAULTS` 加 `fullReview: true`、`fullReviewMaxFiles: 20`；校验：

```js
  if (typeof merged.fullReview !== 'boolean') throw new Error('code-review: fullReview must be a boolean')
  assertPositiveInteger('fullReviewMaxFiles', merged.fullReviewMaxFiles)
```

返回对象补 `fullReview: merged.fullReview, fullReviewMaxFiles: merged.fullReviewMaxFiles`。

- [ ] **Step 5: 运行确认通过**

Run: `cd code-review && node --test test/reviewer.test.js test/config.test.js`
Expected: PASS

- [ ] **Step 6: index 触发 + pending flush**

`index.js`：

1. import：`import { isCodeFile, collect, fingerprint } from './src/host/collect.js'`（现有 collect import 行加 `isCodeFile`）、`import { createChainStore } from './src/host/chain.js'`、`import { buildFullPrompt } from './src/host/reviewer.js'`。
2. apply 内：`const chain = createChainStore({ maxFiles: resolved.fullReviewMaxFiles })`、`const pendingChanges = new Map()`、`const lastFindings = new Map()`。
3. `session/event` 里 `workspace/changes` 分支：

```js
    if (event?.type === 'workspace/changes') {
      latestSeq.set(session.id, event.seq)
      const queue = pendingChanges.get(session.id) ?? []
      queue.push({ seq: event.seq, epoch: tracker.epochOf(session.id), turn: event.data?.turn })
      pendingChanges.set(session.id, queue)
      return
    }
```

4. `user/message` 人类消息分支增加：

```js
      lastFindings.delete(session.id)
```

5. `turn-stopping` handler 开头（`const sessionId = ...` 之后）：

```js
    const flushChain = () => {
      const queue = pendingChanges.get(sessionId) ?? []
      pendingChanges.delete(sessionId)
      for (const item of queue) {
        let queued
        try {
          queued = ctx.workspaceChanges.summary(sessionId, item.seq)
        } catch {
          continue
        }
        if (queued === undefined || !Array.isArray(queued.files)) continue
        chain.observe(sessionId, item.epoch, item.seq, queued.turn, queued.files, (path) => isCodeFile(path, resolved.codeExtensions))
      }
    }
    flushChain()
```

6. `tracker.begin` 成功、`epoch` 计算后：

```js
    const rounds = tracker.roundsOf(sessionId)
    const epoch = tracker.epochOf(sessionId)
    const chainFiles = chain.filesOf(sessionId, epoch)
    const fullRound = resolved.fullReview
      && rounds >= resolved.maxRounds
      && chainFiles.length > collected.files.length
      && !chain.isFull(sessionId, epoch)
    const filesForReview = fullRound ? chainFiles : collected.files
```

7. 规则/prompt/白名单改为按 `filesForReview`：

```js
      const composed = composeRules({ ...loaded, filePaths: filesForReview.map((file) => file.path) })
      const prompt = fullRound
        ? buildFullPrompt({ rulesPrompt: composed.prompt, files: filesForReview, knownFindings: lastFindings.get(sessionId) ?? [] })
        : buildPrompt({ rulesPrompt: composed.prompt, files: collected.files, skipped: collected.skipped })
      const started = await Promise.race([startup, deadline]) // 原样
```
`startReview` 的 `prompt` 换成上面的 `prompt`，`allowedPaths` 换成 `new Set(filesForReview.map((file) => file.path))`。

8. journal start：`mode: fullRound ? 'full' : 'turn'`，`files: filesForReview.length`。

9. settle 成功分支：

```js
      if (fullRound) chain.markFull(sessionId, meta.epoch)
      lastFindings.set(sessionId, outcome.findings.slice(0, 20))
```

10. `session/disposed` 里 `chain.forget(session.id)`、`pendingChanges.delete(session.id)`、`lastFindings.delete(session.id)`。

- [ ] **Step 7: 写 index 集成失败测试（full 触发）**

`test/index.test.js` 追加：

`test/index.test.js` 追加（`stop` 的 `files` 决定该轮 summary 文件，`diff` 决定 fingerprint 是否变化）：

```js
test('maxRounds=2：最后一轮自动切链级全量审查，prompt 含链内文件', async () => {
  const harness = createHarness({ maxRounds: 2 })
  const agent = makeAgent(harness)

  // 第 1 轮：改 a.js
  await harness.stop(agent, { seq: 7, turn: 1, diff: '+const a = 1', files: [{ path: 'a.js', display: 'a.js' }] })
  harness.resolveNext(completed([FINDING]))
  await tick()

  // 第 2 轮：只改 b.js；链内已有 a.js（2 个文件 > 本轮 1 个），rounds=2 为最后一轮 → full
  await harness.stop(agent, { seq: 8, turn: 2, diff: '+const b = 2', files: [{ path: 'b.js', display: 'b.js' }] })

  const request = harness.state.starts[1]
  assert.match(request.prompt, /链级全量复审/)
  assert.match(request.prompt, /a\.js（第 1 轮，\+1 \/ -0）/)
  assert.match(request.prompt, /b\.js（第 2 轮，\+1 \/ -0）/)

  harness.resolveNext(completed([]))
  await tick()
})
```

说明：`chain.observe` 的 flush 发生在 turn-stopping handler 开头；第 1 轮结束后链内已有 `a.js`，第 2 轮 `stop` 前 flush 会把当轮 `b.js` 也加入，因此 full 判定 `2 > 1` 成立。若断言失败，先检查 `stop` 是否把 `files` 传进了 `addSummary`。

- [ ] **Step 8: 命令 `--full`（command.js）**

`createReviewCommand` 依赖加 `chain`、`tracker`、`journal`；`handler({ agent, rawInput, signal })`：

```js
    const wantFull = String(rawInput ?? '').trim() === '--full'
    if (wantFull) {
      const sessionId2 = agent.session.id
      const epoch = tracker.epochOf(sessionId2)
      const chainFiles = chain.filesOf(sessionId2, epoch)
      if (chainFiles.length === 0) return { kind: 'error', text: '本条链没有可审查的改动。' }
      const loaded = await getRules()
      const composed = composeRules({ ...loaded, filePaths: chainFiles.map((file) => file.path) })
      const reviewed = await runReview({
        subagents, agent, preset: config.reviewerPreset,
        prompt: buildFullPrompt({ rulesPrompt: composed.prompt, files: chainFiles }),
        timeoutMs: config.reviewerTimeoutMs,
        modelOverride: config.modelOverride,
        signal,
        allowedRuleIds: composed.allowedRuleIds,
        allowedPaths: new Set(chainFiles.map((file) => file.path)),
        ruleSeverities: composed.ruleSeverities,
        logger,
      })
      if (!reviewed.ok) return { kind: 'error', text: withJournal(`全量审查未完成（${reviewed.reason}）。`) }
      const files = chainFiles.length
      const text = renderFindings({
        findings: reviewed.findings, skipped: [], blockingSeverities: config.blockingSeverities,
        notifySeverities: config.notifySeverities,
        summary: { files, added: 0, deleted: 0 },
        mode: 'report',
      })
      return { kind: 'success', text: withJournal(text === '' ? renderPass({ summary: { files, added: 0, deleted: 0 }, skipped: [] }) : text) }
    }
```

命令定义加 `input: { hint: '可留空；输入 --full 复审整条链的改动' }`；index 创建命令处传入 `chain`、`tracker`、`journal`。

- [ ] **Step 9: 命令测试**

`test/command.test.js` 的 `createCommand` 增加 deps：`tracker: { epochOf: () => 1 }`、`chain: { filesOf: () => [{ path: 'a.js', turns: [1], added: 1, deleted: 0 }] }`、`journal: undefined`。追加：

```js
test('/review --full 用链内文件集合发起全量审查并输出报告', async () => {
  const { handler, state } = createCommand()
  const result = await handler({ agent: fakeAgent(), rawInput: '--full', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.match(state.requests[0].prompt, /链级全量复审/)
  assert.match(result.text, /结论/)
})
```

（`fakeAgent()` 与现有测试的 agent 构造保持一致，直接复用该文件已有 helper。）

- [ ] **Step 10: 全量测试 + 提交**

Run: `cd code-review && node --test test/*.test.js`
Expected: 全部 PASS（219 + Task1/2/3/5 的 8 + 本任务约 10 ≈ 237+）

```bash
git add code-review/src/host/reviewer.js code-review/src/host/config.js code-review/src/host/command.js code-review/index.js code-review/test/reviewer.test.js code-review/test/config.test.js code-review/test/index.test.js code-review/test/command.test.js
git commit -m "feat(code-review): 链级全量审查（末轮自动 + /review --full）"
```

---

### Task 7: 版本、文档、profile 启用与回归

**Files:**
- Modify: `code-review/package.json`
- Modify: `code-review/README.md`
- Modify: `/Users/liyu/.dsh/profiles/desktop/cordis.patch.yml`（运行时配置，不在仓库）
- Test: 全量回归 + `npm pack --dry-run`

- [ ] **Step 1: package.json**：`version` → `0.3.0`；加

```json
  "peerDependencies": {
    "@deepseek-ai/dsh-storage-domain": "*",
    "zod": "*"
  },
  "peerDependenciesMeta": {
    "@deepseek-ai/dsh-storage-domain": { "optional": true },
    "zod": { "optional": true }
  },
```

**Files 清单不变**（`rules` 目录已覆盖新规则包）。

- [ ] **Step 2: README**：
  - 机制第 3/4 步补「链级累积 + 末轮全量」；第 5 步补「journal 留痕」。
  - 配置表加 `fullReview`（默认 `true`）、`fullReviewMaxFiles`（默认 `20`）。
  - 「规则作用域与规则包」节加 `general-issues`（8 条 BEH，全部 low，默认不启用）。
  - 规则维度表加 behavior 行；`/review` 节补 `--full` 与「自动审查记录」脚注。
  - 已知限制补：`storageDomain` 缺失时留痕仅内存；全量审查只覆盖链内触达文件，不重建 MR diff；末轮全量要求本轮仍有改动。
  - 最小验证补：重启后 `/review` 能看到历史记录；把 `rulePacks` 加上 `general-issues` 后 reviewer prompt 含 `### BEH-001`。
  - 测试数改为最终实际值。

- [ ] **Step 3: profile 启用**（用户已同意启用规则包）

```yaml
- id: code-review
  config:
    notifySeverities: [low, nit]
    rulePacks: ["rules/packs/frontend-smartui.json", "rules/packs/general-issues.json"]
```

- [ ] **Step 4: 回归**

Run: `cd code-review && node --test test/*.test.js`
Expected: 全绿（记录实际数字，更新 README）

Run: `cd code-review && npm pack --dry-run --json`
Expected: `rules/packs/general-issues.json` 出现在文件清单；版本 0.3.0

Run: `cd /Users/liyu/Documents/www/DeepSeek/deepseek-harness/deepseek-harness-plugin && git status --short`
Expected: 只有预期文件改动

- [ ] **Step 5: 提交**

```bash
git add code-review/package.json code-review/README.md
git commit -m "chore(code-review): 0.3.0 版本与文档（留痕/全量审查/behavior 规则包）"
```

---

## Self-Review Checklist

- [ ] spec §20 的每个要求都能指到任务：behavior 维度（T1/T2）、general-issues（T2）、journal（T3/T4）、chain（T5）、full review（T6）、配置（T6）、文档/版本（T7）。
- [ ] 无占位符：所有新增模块与测试都有完整代码；改接线处给的是可粘贴片段。
- [ ] 类型/命名一致：`filesOf(sessionId, epoch)`、`markFull/isFull(sessionId, epoch)`、`createJournalCore/createJournal/formatJournal`、`buildFullPrompt({rulesPrompt, files, knownFindings})`、journal 记录字段在全计划中一致。
- [ ] 默认值一致：`fullReview: true`、`fullReviewMaxFiles: 20`、`notifySeverities` 不变、`blockingSeverities` 不变。
- [ ] 每个任务以「全量测试 + commit」收尾；回归任务记录最终测试数。
