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
      // Drawer 打开时挂 Esc 监听，chip 侧挂 resize 监听：桩里给个空实现（浏览器行为）。
      addEventListener: () => {},
      removeEventListener: () => {},
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

const drawerOf = (loaded) => loaded.registrations.find((entry) => entry.definition.id === 'mr-loop-drawer').component

/** 窄屏：把窗口宽度塞到断点以下，chip 应退化成只有一个 MR 图标。 */
test('chip：窄屏退化成一个 MR 图标按钮，点击仍能打开看板', async () => {
  const loaded = loadBundle({ fetchData: chipData })
  loaded.sandbox.window.innerWidth = 900
  loaded.sandbox.__moduleExports.apply(loaded.ctx)
  renderChip(loaded, 's1')
  await settle()

  const chip = renderChip(loaded, 's1')
  const texts = textsOf(chip).join(' | ')
  assert.equal(texts, '', '紧凑形态不渲染任何文字，只有图标')
  assert.equal(chip.props.className, 'mrl-chip-btn')
  assert.match(chip.props.title, /!241 第 1 轮/)
  assert.match(chip.props.title, /2 待处理/)
  assert.equal(chip.props['aria-label'], chip.props.title)

  // 图标里应有一枚告警状态点（本会话 2 条待处理）。
  const kinds = []
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object') return
    if (typeof node.type === 'function') return
    if (typeof node.type === 'string') kinds.push(node.type)
    if (Array.isArray(node.children)) node.children.forEach(walk)
  }
  walk(chip)
  assert.deepEqual(kinds.filter((kind) => kind === 'svg'), ['svg'])
  const badge = chip.children.find((node) => node !== null && typeof node === 'object' && node.props.className === 'mrl-chip-badge')
  assert.ok(badge, '有待处理时应渲染状态点')
  assert.equal(badge.props['data-tone'], 'warn')

  // 点击图标 → store.open=true → 抽屉渲染出面板。
  assert.equal(typeof chip.props.onClick, 'function')
  chip.props.onClick()
  const drawer = drawerOf(loaded)()
  assert.equal(drawer.props.className, 'mrl-dialog')
})

test('chipShrinkMode：放得下就用完整形态，放不下才收成图标，且判定与当前形态无关（不抖）', () => {
  const { sandbox } = loadBundle()
  const { chipShrinkMode } = sandbox.__moduleExports.__internals

  // 一排只占 300px、容器 400px → 完整形态还留 100px 余量。
  assert.equal(chipShrinkMode({ containerWidth: 400, contentWidth: 300, chipWidth: 120, fullWidth: 120 }), 'full')
  // 内容 396 + 8px 余量刚好顶到 404 > 400 → 收成图标。
  assert.equal(chipShrinkMode({ containerWidth: 400, contentWidth: 396, chipWidth: 120, fullWidth: 120 }), 'compact')
  // 边缘：正好卡在 container - 8 上仍算放得下。
  assert.equal(chipShrinkMode({ containerWidth: 400, contentWidth: 392, chipWidth: 120, fullWidth: 120 }), 'full')

  // 不变式：同一排内容，用紧凑态量（chipWidth=26）或完整态量（120），结论必须一致。
  const compactMode = chipShrinkMode({ containerWidth: 400, contentWidth: 302, chipWidth: 26, fullWidth: 120 })
  const fullMode = chipShrinkMode({ containerWidth: 400, contentWidth: 396, chipWidth: 120, fullWidth: 120 })
  assert.equal(compactMode, fullMode)
  assert.equal(compactMode, 'compact')

  // 量不到容器（0/NaN）→ 交给调用方按窗口兜底，别误判。
  assert.equal(chipShrinkMode({ containerWidth: 0, contentWidth: 10, chipWidth: 10, fullWidth: 10 }), 'full')
  assert.equal(chipShrinkMode({}), 'full')
  // 缺 contentWidth 时按容器宽度算 = 已经占满 → 收成图标。
  assert.equal(chipShrinkMode({ containerWidth: 360, chipWidth: 120, fullWidth: 120 }), 'compact')
})

/**
 * 展开 h() 桩的元素树并收集文本 / 指定 className 的节点。
 * 函数组件（MrCard / ProblemRow）在这里被手动调用一次——桩里没有 React 的渲染器。
 */
function walkTree(node, visit) {
  if (node === null || node === undefined || node === false) return
  if (typeof node === 'string' || typeof node === 'number') { visit(node); return }
  if (Array.isArray(node)) { node.forEach((child) => walkTree(child, visit)); return }
  if (typeof node !== 'object') return
  if (typeof node.type === 'function') { walkTree(node.type(node.props ?? {}), visit); return }
  visit(node)
  if (Array.isArray(node.children)) node.children.forEach((child) => walkTree(child, visit))
}

const textOfTree = (node) => {
  const out = []
  walkTree(node, (item) => { if (typeof item === 'string' || typeof item === 'number') out.push(String(item)) })
  return out
}

function nodesByClass(node, className) {
  const out = []
  walkTree(node, (item) => {
    if (typeof item === 'object' && item.props !== undefined && item.props.className === className) out.push(item)
  })
  return out
}

/** 回落态 MR：当前轮（第 7 轮）评审还没出，problems 来自第 6 轮。 */
const fallbackMr = {
  projectPath: 'g/p', iid: 243, round: 7, pending: 0, state: 'opened', live: true,
  session: { id: 's1' }, sourceBranch: 'feat-x', targetBranch: 'feature-y', sha: 'b30c43b3d962',
  review: null,
  gates: { sensitive: null, mandatory: null },
  merge: {
    mergeable: false,
    missing: ['AI 评审结论未知（未出或解析失败）'],
    // head_pipeline 还停在上一笔提交：这笔 push 没触发流水线。
    pipeline: { id: 7358, status: 'success', sha: '081bb37414f8' },
  },
  problemsRound: { n: 6, sha: '081bb37414f8', current: false },
  rounds: [
    { n: 1, verdict: 'pass', total: 0, open: 0, fixed: 0, current: false },
    { n: 6, verdict: 'pass', total: 1, open: 1, fixed: 1, current: false },
    { n: 7, verdict: null, total: 0, open: 0, fixed: 0, current: true },
  ],
  problems: [{
    fid: 'aea50825a5', level: '低', type: '非阻塞建议', file: 'src/report/Index.tsx', line: 81,
    problem: '首帧会闪一帧空表单', suggestion: '把加载态与数据就绪度绑定', status: 'open', unverified: true,
  }],
}

/** 打开看板并渲染一次（chip 紧凑态点一下即可）。 */
const renderPanel = async (data) => {
  const loaded = loadBundle({ fetchData: { mrs: [data], counts: { total: 1, pending: 0, mergeable: 0, merged: 0 } } })
  loaded.sandbox.window.innerWidth = 900
  loaded.sandbox.__moduleExports.apply(loaded.ctx)
  renderChip(loaded, 's1')
  await settle()
  renderChip(loaded, 's1').props.onClick()
  return { loaded, panel: drawerOf(loaded)() }
}

test('看板：当前轮评审没出时显示上一轮结论、标「待复验」，并提示流水线还停在上一笔提交', async () => {
  const { panel } = await renderPanel(fallbackMr)
  const texts = textOfTree(panel).join(' | ')

  // 段落头说清是哪一轮 + 为什么不是本轮。
  assert.match(texts, /第 6 轮问题/)
  assert.match(texts, /第 7 轮评审未出/)
  // 上一轮的「未处理」不能写成现在还没修。
  assert.match(texts, /待复验/)
  assert.doesNotMatch(texts, /未处理/)
  // 评审未知的真因：这笔提交没有流水线（不是插件解析失败）。
  assert.match(texts, /流水线 #7358 还停在 081bb374/)
  assert.match(texts, /这笔提交没有流水线/)

  // 轮次条：第 6 轮被选中（正在显示），第 7 轮是等待评审。
  const chips = nodesByClass(panel, 'mrl-round')
  const selected = chips.filter((node) => node.props['data-sel'] === '1')
  assert.equal(selected.length, 1)
  assert.equal(textOfTree(selected[0])[0], '第6轮')
  const waiting = chips.filter((node) => node.props['data-wait'] === '1')
  assert.equal(waiting.length, 1)
  assert.equal(textOfTree(waiting[0])[0], '第7轮')
  assert.match(waiting[0].props.title, /等待评审/)
})

test('看板：当前轮评审已落地时标「第 N 轮问题」，问题仍是未处理、不出现回落提示', async () => {
  const currentMr = {
    ...fallbackMr,
    round: 6,
    sha: '081bb37414f8',
    review: { verdict: 'pass', historicalUnresolved: 0, verifiedFixed: 1, newThisRound: 1 },
    merge: { mergeable: false, missing: ['评审有 1 处需要关注的问题：FID aea50825a5（低）'], pipeline: { id: 7358, status: 'success', sha: '081bb37414f8' } },
    problemsRound: { n: 6, sha: '081bb37414f8', current: true },
    rounds: [
      { n: 5, verdict: 'pass', total: 1, open: 1, fixed: 0, current: false },
      { n: 6, verdict: 'pass', total: 1, open: 1, fixed: 1, current: true },
    ],
    problems: [{ ...fallbackMr.problems[0], unverified: undefined }],
  }
  const { panel } = await renderPanel(currentMr)
  const texts = textOfTree(panel).join(' | ')
  assert.match(texts, /第 6 轮问题/)
  assert.match(texts, /未处理/)
  assert.doesNotMatch(texts, /待复验/)
  assert.doesNotMatch(texts, /评审未出/)
  assert.doesNotMatch(texts, /没有流水线/)
})

test('看板：点轮次条翻看历史轮的问题正文，并能回到默认轮（复制指令同时禁用）', async () => {
  // 第 1 轮给一条历史问题：点开第 1 轮应显示它，而不是默认第 6 轮的问题。
  const data = JSON.parse(JSON.stringify(fallbackMr))
  data.rounds[0] = {
    ...data.rounds[0], total: 1,
    problems: [{
      fid: 'oldold0001', level: '低', type: '非阻塞建议', file: 'src/old.ts', line: 3,
      problem: '第 1 轮提出的历史问题', status: 'open',
    }],
  }
  const { loaded, panel } = await renderPanel(data)

  // 默认视图 = 第 6 轮（最近一次落地的评审）。
  const chips = nodesByClass(panel, 'mrl-round')
  const selected = chips.filter((node) => node.props['data-sel'] === '1')
  assert.equal(selected.length, 1)
  assert.equal(textOfTree(selected[0])[0], '第6轮')
  assert.match(textOfTree(panel).join(' | '), /第 6 轮问题/)

  // 点第 1 轮：段落头切过去，正文换成那一轮的问题。
  const round1 = chips.find((node) => textOfTree(node)[0] === '第1轮')
  assert.equal(typeof round1.props.onClick, 'function')
  round1.props.onClick()
  const browsing = drawerOf(loaded)()
  const browsingTexts = textOfTree(browsing).join(' | ')
  assert.match(browsingTexts, /第 1 轮问题/)
  assert.match(browsingTexts, /第 1 轮提出的历史问题/)
  assert.doesNotMatch(browsingTexts, /第 6 轮问题/)
  // 翻历史轮时「复制指令」必须禁用：那可能是早就修好的 FID。
  const footerButtons = nodesByClass(browsing, 'mrl-btn').filter((node) => textOfTree(node)[0] === '复制指令')
  assert.equal(footerButtons.length, 1)
  assert.equal(footerButtons[0].props.disabled, true)

  // 「回到第 6 轮」回到默认视图。
  const reset = nodesByClass(browsing, 'mrl-link').find((node) => textOfTree(node).join('').includes('回到第 6 轮'))
  assert.ok(reset !== undefined)
  reset.props.onClick()
  const back = drawerOf(loaded)()
  const backTexts = textOfTree(back).join(' | ')
  assert.match(backTexts, /第 6 轮问题/)
  assert.doesNotMatch(backTexts, /第 1 轮问题/)
})

test('看板：重载后刚恢复的活绑定（还没拉到 MR 快照）不能说成「历史账本」', async () => {
  const restored = { ...fallbackMr, merge: null, review: null, problemsRound: null, problems: [] }
  const { panel } = await renderPanel(restored)
  const texts = textOfTree(panel).join(' | ')
  assert.match(texts, /刚恢复监视，正在拉取 MR 状态/)
  assert.doesNotMatch(texts, /历史账本/)
})
