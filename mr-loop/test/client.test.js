/**
 * 客户端 bundle 契约测试：不启浏览器，用最小 DOM/React/loader 桩验证
 * `window.__ModuleLoader__.load({id, factory})` 的产物能被宿主正确接线。
 *
 * 目的不是渲染像素，而是钉死五件事：
 *   1. 模块 id 与包名一致、工厂返回 exports；
 *   2. 导出 inject=['slots'] 与 apply(ctx)；
 *   3. apply 只注册两个座位：会话头 chip 与 shell.overlay 抽屉；
 *   4. 样式与 30s 轮询走 `ctx.effect` 并返回 cleanup（重复 apply / HMR 重载不叠加）；
 *   5. chip 的 MR 标签与待处理计数只统计**当前会话**（会话未知时退回全部）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'lib', 'client.js')

function makeReactStub() {
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children })
  const hook = (value) => [value, () => {}]
  return {
    createElement,
    useState: (value) => hook(typeof value === 'function' ? value() : value),
    // 真 React 在挂载时跑 effect；桩里同步跑一次，这样组件测试能触发 load()。
    useEffect: (fn) => {
      const cleanup = fn()
      void cleanup
    },
    useRef: (value) => ({ current: value }),
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
}

/** 带生命周期记录的 DOM 桩：style 标签的插入 / 删除都可断言。 */
function makeDocumentStub() {
  const appended = []
  const removed = []
  const live = new Set()
  const head = {
    appendChild: (tag) => {
      tag.parentNode = head
      live.add(tag)
      appended.push(tag)
    },
    removeChild: (tag) => {
      live.delete(tag)
      removed.push(tag)
    },
  }
  const documentStub = {
    querySelector: () => (live.size > 0 ? [...live][0] : null),
    createElement: () => ({ dataset: {}, textContent: '', setAttribute() {}, parentNode: null }),
    head,
    body: { appendChild() {}, removeChild() {} },
  }
  return { documentStub, appended, removed, live }
}

function loadBundle({ fetchData = { mrs: [], counts: {} } } = {}) {
  const styles = makeDocumentStub()
  const registrations = []
  const effects = []
  const intervals = { set: [], cleared: [] }
  const ctx = {
    // 与真实 DSH client 一致：effect(factory) 立即执行 factory，返回 disposer。
    effect: (factory, label) => {
      const cleanup = factory()
      effects.push({ label, cleanup })
      return cleanup
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (definition, component) => {
        registrations.push({ definition, component })
        return () => {}
      },
    },
  }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ id, factory }) => {
          sandbox.__loadedId = id
          sandbox.__moduleExports = factory((specifier) => {
            if (specifier === 'react') return makeReactStub()
            throw new Error(`unexpected require: ${specifier}`)
          })
        },
      },
      setInterval: (fn, ms) => {
        intervals.set.push({ id: intervals.set.length + 1, fn, ms })
        return intervals.set.length
      },
      clearInterval: (id) => { intervals.cleared.push(id) },
    },
    document: styles.documentStub,
    fetch: async () => ({ ok: true, json: async () => fetchData }),
    navigator: { clipboard: { writeText: async () => {} } },
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(bundlePath, 'utf8'), sandbox, { filename: 'client.js' })
  return { sandbox, ctx, registrations, effects, intervals, styles }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

const chipOf = (loaded) => loaded.registrations.find((entry) => entry.definition.id === 'mr-loop-chip').component

/** 渲染 Chip 一次；props.sessionId 是宿主给的当前会话。 */
const renderChip = (loaded, sessionId) => chipOf(loaded)(sessionId === undefined ? {} : { sessionId })

/** 收集元素树里的文本（h() 桩返回的是普通对象）。 */
function textsOf(node) {
  if (node === null || node === undefined || node === false) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(textsOf)
  if (typeof node === 'object' && Array.isArray(node.children)) return node.children.flatMap(textsOf)
  return []
}

const chipData = {
  mrs: [
    { projectPath: 'g/p', iid: 241, round: 1, pending: 2, state: 'opened', live: true, session: { id: 's1' }, review: null, gates: {}, merge: null, problems: [], sourceBranch: 'a', targetBranch: 'b', sha: 'a' },
    { projectPath: 'g/p', iid: 242, round: 2, pending: 5, state: 'opened', live: true, session: { id: 's2' }, review: null, gates: {}, merge: null, problems: [], sourceBranch: 'a', targetBranch: 'b', sha: 'b' },
    { projectPath: 'g/p', iid: 243, round: 3, pending: 0, state: 'merged', live: false, session: { id: 's2' }, review: null, gates: {}, merge: null, problems: [], sourceBranch: 'a', targetBranch: 'b', sha: 'c' },
  ],
  counts: { total: 3, pending: 7, mergeable: 0, merged: 1 },
}

test('bundle 以包名注册到模块表，并导出 inject/apply', () => {
  const { sandbox } = loadBundle()
  assert.equal(sandbox.__loadedId, '@liyuera/dsh-mr-loop')
  const exported = sandbox.__moduleExports
  assert.ok(exported !== null && typeof exported === 'object')
  assert.deepEqual([...exported.inject], ['slots'])
  assert.equal(typeof exported.apply, 'function')
})

test('apply 只占用两个座位：会话头 chip 与 shell.overlay 抽屉', () => {
  const { sandbox, ctx, registrations } = loadBundle()
  sandbox.__moduleExports.apply(ctx)

  assert.deepEqual(
    registrations.map((entry) => entry.definition.name),
    ['conversation.session.header.actions', 'shell.overlay'],
  )
  assert.deepEqual(
    registrations.map((entry) => entry.definition.id),
    ['mr-loop-chip', 'mr-loop-drawer'],
  )
  for (const entry of registrations) {
    assert.equal(typeof entry.component, 'function')
  }
})

test('重复 apply 不会重复注入样式（style 标签按 data-plugin-css 去重）', () => {
  const { sandbox, ctx, styles } = loadBundle()
  sandbox.__moduleExports.apply(ctx)
  sandbox.__moduleExports.apply(ctx)

  assert.equal(styles.appended.length, 1)
  const injected = styles.appended[0]
  assert.equal(injected.dataset.plugin, '@liyuera/dsh-mr-loop')
  assert.equal(injected.dataset.pluginCss, '@liyuera/dsh-mr-loop/panel.css')
  assert.match(injected.textContent, /\.mrl-panel/)
})

test('apply 用 ctx.effect 注册样式与 30s 轮询：disposer 清理 style / timer（HMR 不叠加）', () => {
  const { sandbox, ctx, effects, intervals, styles } = loadBundle()
  sandbox.__moduleExports.apply(ctx)

  assert.equal(effects.length, 2)
  assert.deepEqual(effects.map((effect) => effect.label), ['mr-loop: client styles', 'mr-loop: ui poll'])
  assert.equal(styles.appended.length, 1)
  assert.equal(styles.live.size, 1)
  assert.equal(intervals.set.length, 1)
  assert.equal(intervals.set[0].ms, 30000)

  // 模拟 HMR 重载：旧 apply 的 disposer 全部执行 → 旧 style 移除、旧 timer 清掉。
  for (const effect of effects) effect.cleanup()
  assert.equal(styles.removed.length, 1)
  assert.equal(styles.live.size, 0)
  assert.deepEqual(intervals.cleared, [1])

  // 重新 apply 只留一份新 style / 新 timer。
  sandbox.__moduleExports.apply(ctx)
  assert.equal(styles.appended.length, 2)
  assert.equal(styles.live.size, 1)
  assert.equal(intervals.set.length, 2)
})

test('chip：会话未知时退回全部 MR 与全局待处理计数', async () => {
  const loaded = loadBundle({ fetchData: chipData })
  loaded.sandbox.__moduleExports.apply(loaded.ctx)
  renderChip(loaded)
  await settle()
  const texts = textsOf(renderChip(loaded)).join(' | ')
  assert.match(texts, /!241/)
  assert.match(texts, /!242/)
  assert.match(texts, /\+1/)
  assert.match(texts, /7 待处理/)
})

test('chip：sessionId 已知时只统计当前会话的 MR 与待处理', async () => {
  const loaded = loadBundle({ fetchData: chipData })
  loaded.sandbox.__moduleExports.apply(loaded.ctx)
  renderChip(loaded, 's1')
  await settle()
  const texts = textsOf(renderChip(loaded, 's1')).join(' | ')
  assert.match(texts, /!241/)
  assert.doesNotMatch(texts, /!242/)
  assert.doesNotMatch(texts, /!243/)
  assert.match(texts, /2 待处理/)
  assert.doesNotMatch(texts, /7 待处理/)
})
