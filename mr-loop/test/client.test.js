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
    { projectPath: 'group/credit-web', iid: 241, round: 1, pending: 2, state: 'opened', live: true, session: { id: 's1' }, review: null, gates: {}, merge: null, problems: [], sourceBranch: 'a', targetBranch: 'b', sha: 'a' },
    { projectPath: 'group/credit-web', iid: 242, round: 2, pending: 5, state: 'opened', live: true, session: { id: 's2' }, review: null, gates: {}, merge: null, problems: [], sourceBranch: 'a', targetBranch: 'b', sha: 'b' },
    { projectPath: 'group/credit-web', iid: 243, round: 3, pending: 0, state: 'merged', live: false, session: { id: 's2' }, review: null, gates: {}, merge: null, problems: [], sourceBranch: 'a', targetBranch: 'b', sha: 'c' },
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
  // 紧凑形态没有文字，tooltip 是唯一出口：带上是哪个工作区，才不会把两个仓库的 !241 混在一起。
  assert.match(chip.props.title, /credit-web !241 第 1 轮/)
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

test('chip：完整形态的 MR 标签把工作区名放进 tooltip（编号会跨仓库重号）', async () => {
  const loaded = loadBundle({ fetchData: chipData })
  // 不设 innerWidth → 首帧按窗口宽度兜底判定为「放得下」，走完整形态。
  loaded.sandbox.__moduleExports.apply(loaded.ctx)
  renderChip(loaded)
  await settle()

  const chip = renderChip(loaded)
  const tags = []
  walkTree(chip, (item) => {
    if (typeof item !== 'object' || item === null || item.props === undefined) return
    if (typeof item.props.className === 'string' && item.props.className.startsWith('mrl-chip-tag')) tags.push(item)
  })
  // 两张 MR 标签 + 「看板」按钮。
  assert.equal(tags.length, 3)
  assert.match(tags[0].props.title, /^credit-web：/, 'tooltip 前缀是工作区名')
  assert.match(tags[0].props.title, /a → b$/, '分支箭头串保持原样')
  assert.equal(textOfTree(tags[0]).join(''), '!241 · 第 1 轮', '可见文字不变，不挤占会话头')
});

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

/** 一条问题的唯一索引形状（0.3.0）：首见轮次 / 出现过的轮次 / 出现次数。 */
const problemOf = (over = {}) => ({
  fid: 'aea50825a5', level: '低', type: '非阻塞建议', file: 'src/report/Index.tsx', line: 81,
  problem: '首帧会闪一帧空表单', suggestion: '把加载态与数据就绪度绑定', status: 'open',
  firstRound: 6, lastRound: 6, rounds: [6], count: 1,
  ...over,
})

/**
 * 等待评审的 MR（0.3.0）：新提交 b30c43b3 没有流水线（head_pipeline 还停在 081bb374），
 * 所以它**不算一轮**——轮次停在 6，等待单独标出。
 */
const fallbackMr = {
  projectPath: 'g/p', iid: 243, round: 6, pending: 0, state: 'opened', live: true,
  session: { id: 's1' }, sourceBranch: 'feat-x', targetBranch: 'feature-y', sha: 'b30c43b3d962',
  review: { verdict: 'pass', historicalUnresolved: 0, verifiedFixed: 1, newThisRound: 1 },
  gates: { sensitive: null, mandatory: null },
  merge: {
    mergeable: false,
    missing: ['AI 评审结论未知（未出或解析失败）'],
    // head_pipeline 还停在上一笔提交：这笔 push 没触发流水线。
    pipeline: { id: 7358, status: 'success', sha: '081bb37414f8' },
  },
  problemsRound: { n: 6, sha: '081bb37414f8', current: true },
  waiting: { sha: 'b30c43b3d962', since: '2026-11-17T07:03:08.000Z' },
  summary: { total: 1, open: 1, fixed: 0, waived: 0 },
  rounds: [
    { n: 5, verdict: 'pass', newCount: 0, repeatCount: 0, total: 0, current: false, repeats: [], problems: [] },
    { n: 6, verdict: 'pass', newCount: 1, repeatCount: 0, total: 1, current: true, repeats: [], problems: [problemOf()] },
  ],
  problems: [problemOf()],
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

test('看板：唯一问题索引（共 N 条）+ 等待评审提示，没流水线的那一笔不计轮次', async () => {
  const { panel } = await renderPanel(fallbackMr)
  const texts = textOfTree(panel).join(' | ')

  // 默认视图 = 全部唯一问题，标题直接给总数与状态汇总。
  assert.match(texts, /问题/)
  assert.match(texts, /共 1 条/)
  assert.match(texts, /● 未处理/)
  // 等待提示：说清哪一笔在等 + 流水线停在上一笔（不是插件解析失败）。
  assert.match(texts, /已推送 b30c43b3，等待流水线 \/ 评审（流水线 #7358 还停在 081bb374）/)
  // 轮次条只有第 5、6 轮：没有流水线的 b30c43b3 不占轮次号（也就没有「第 7 轮」）。
  const chips = nodesByClass(panel, 'mrl-round')
  assert.deepEqual(chips.map((node) => textOfTree(node)[0]), ['第5轮', '第6轮'])
});

test('看板：卡头第一行是工作区名，同 iid 不同项目靠它区分；没有 projectPath 不留空行', async () => {
  // iid 是仓库内自增的：两个项目都有 !243，只靠编号认不出是哪条线在跟踪。
  const credit = { ...fallbackMr, projectPath: 'wisdom-financial-service-platform/wisdom-financial-credit-platform-web' }
  const { panel } = await renderPanel(credit)

  const [workspace] = nodesByClass(panel, 'mrl-mr-ws')
  assert.ok(workspace, '卡头应有工作区名一行')
  assert.equal(textOfTree(workspace).join(''), 'wisdom-financial-credit-platform-web', '只显示项目名，不带 group')
  assert.equal(workspace.props.title, credit.projectPath, '完整 projectPath 进 title，长名被省略时仍可查')

  // 位置：工作区名在编号上面（文档顺序 ws → id）。
  const order = []
  walkTree(panel, (item) => {
    if (typeof item !== 'object' || item === null || item.props === undefined) return
    if (item.props.className === 'mrl-mr-ws' || item.props.className === 'mrl-mr-id') order.push(item.props.className)
  })
  assert.deepEqual(order, ['mrl-mr-ws', 'mrl-mr-id'])

  // 同一个 iid 换一个项目：工作区名跟着变（这就是「不能光靠编号判断」的落点）。
  const other = await renderPanel({ ...fallbackMr, projectPath: 'other-group/financial-crm-web' })
  assert.equal(textOfTree(nodesByClass(other.panel, 'mrl-mr-ws')[0]).join(''), 'financial-crm-web')

  // 拿不到 projectPath 时整行不渲染（不占一行空白，编号仍然贴顶）。
  const bare = await renderPanel({ ...fallbackMr, projectPath: '' })
  assert.deepEqual(nodesByClass(bare.panel, 'mrl-mr-ws'), [])
});

test('看板：路径用 tag 完整展示、展开后显示源码；没有源码就不显示源码行', async () => {
  const longPath = 'src/pages/report-manage/components/ReportUploadModal/index.tsx'
  const withSnippet = problemOf({ file: longPath, snippet: 'if (isEdit && row.fileList) {' })
  const data = {
    ...fallbackMr,
    waiting: null,
    rounds: [{ n: 6, verdict: 'pass', newCount: 1, repeatCount: 0, total: 1, current: true, repeats: [], problems: [withSnippet] }],
    problems: [withSnippet],
  }
  const { loaded, panel } = await renderPanel(data)
  const issue = nodesByClass(panel, 'mrl-issue')[0]
  const path = nodesByClass(issue, 'mrl-path')[0]
  assert.equal(textOfTree(path).join(''), longPath + ':81', '路径 tag 必须完整，不省略')
  // 展开：源码行出现。
  nodesByClass(panel, 'mrl-chev')[0].props.onClick()
  const expanded = drawerOf(loaded)()
  assert.match(textOfTree(expanded).join(' | '), /源码/)
  assert.match(textOfTree(expanded).join(' | '), /if \(isEdit && row\.fileList\)/)

  // 没有源码的同一问题：展开后不出现「源码」行。
  const plain = problemOf({ file: longPath })
  const data2 = { ...data, rounds: [{ ...data.rounds[0], problems: [plain] }], problems: [plain] }
  const second = await renderPanel(data2)
  nodesByClass(second.panel, 'mrl-chev')[0].props.onClick()
  const expanded2 = drawerOf(second.loaded)()
  assert.doesNotMatch(textOfTree(expanded2).join(' | '), /源码/)
})

test('看板：点轮次只看该轮新出现的问题；没有新问题的轮次不显示「本轮已修」', async () => {
  const old = problemOf({ fid: 'old0000001', firstRound: 5, lastRound: 6, rounds: [5, 6], count: 2, problem: '第 5 轮提出的历史问题' })
  const data = {
    ...fallbackMr,
    waiting: null,
    summary: { total: 1, open: 1, fixed: 0, waived: 0 },
    problemsRound: { n: 5, sha: '081bb37414f8', current: true },
    rounds: [
      { n: 5, verdict: 'pass', newCount: 1, repeatCount: 0, total: 1, current: false, repeats: [], problems: [old] },
      { n: 6, verdict: 'pass', newCount: 0, repeatCount: 1, total: 1, current: true, repeats: [{ fid: 'old0000001', firstRound: 5, count: 2 }], problems: [] },
    ],
    problems: [old],
  }
  const { loaded, panel } = await renderPanel(data)
  // 默认视图：唯一问题只出现一次，并标出首见轮次与出现次数。
  const defaultTexts = textOfTree(panel).join(' | ')
  assert.match(defaultTexts, /首见 第 5 轮 · 出现 2 次（第5轮、第6轮）/)
  assert.equal(nodesByClass(panel, 'mrl-issue').length, 1)

  // 点第 6 轮：这轮没有新问题 → 不展示已修清单，只说明重复出现的条数与首见轮次。
  const round6 = nodesByClass(panel, 'mrl-round').find((node) => textOfTree(node)[0] === '第6轮')
  round6.props.onClick()
  const browsing = drawerOf(loaded)()
  const browsingTexts = textOfTree(browsing).join(' | ')
  assert.match(browsingTexts, /第 6 轮新问题/)
  assert.match(browsingTexts, /历史未收敛 1/)
  assert.match(browsingTexts, /本轮没有新问题；重复出现 1 条历史问题：old0000001（首见第5轮 · 共2次）/)
  assert.doesNotMatch(browsingTexts, /已修/)
  // 回到全部。
  const reset = nodesByClass(browsing, 'mrl-link').find((node) => textOfTree(node).join('').includes('回到全部'))
  assert.ok(reset !== undefined)
  reset.props.onClick()
  assert.equal(nodesByClass(drawerOf(loaded)(), 'mrl-issue').length, 1)
})

test('看板：轮次条展示完整轮次（不再截断成 8 条）', async () => {
  const rounds = []
  for (let n = 1; n <= 12; n += 1) {
    rounds.push({ n, verdict: 'pass', newCount: 0, repeatCount: 0, total: 0, current: n === 12, repeats: [], problems: [] })
  }
  const data = { ...fallbackMr, round: 12, waiting: null, rounds, problems: [], summary: { total: 0, open: 0, fixed: 0, waived: 0 } }
  const { panel } = await renderPanel(data)
  assert.equal(nodesByClass(panel, 'mrl-round').length, 12)
})

test('看板：已修问题只在首见轮次展示，状态写清第 N 轮验证（同一个 FID 不再两轮状态打架）', async () => {
  const fixed = problemOf({ fid: 'fd56004d1a', status: 'fixed', fixedAtRound: 9, firstRound: 8, lastRound: 8, rounds: [8], count: 1 })
  const data = {
    ...fallbackMr,
    state: 'merged',
    round: 9,
    sha: 'c0cfe45f12345678',
    review: { verdict: 'pass', historicalUnresolved: 0, verifiedFixed: 1, newThisRound: 0 },
    merge: { mergeable: false, missing: [], terminal: 'merged', pipeline: null },
    waiting: null,
    problemsRound: { n: 9, sha: 'c0cfe45f12345678', current: true },
    summary: { total: 1, open: 0, fixed: 1, waived: 0 },
    rounds: [
      { n: 8, verdict: 'pass', newCount: 1, repeatCount: 0, total: 1, current: false, repeats: [], problems: [fixed] },
      { n: 9, verdict: 'pass', newCount: 0, repeatCount: 0, total: 0, current: true, repeats: [], problems: [] },
    ],
    problems: [fixed],
  }
  const { loaded, panel } = await renderPanel(data)
  assert.match(textOfTree(panel).join(' | '), /✓ 第 9 轮已修/)
  // 点第 8 轮：同一个 FID 仍是「第 9 轮已修」，不会显示成未处理。
  nodesByClass(panel, 'mrl-round').find((node) => textOfTree(node)[0] === '第8轮').props.onClick()
  const round8Texts = textOfTree(drawerOf(loaded)()).join(' | ')
  assert.match(round8Texts, /✓ 第 9 轮已修/)
  assert.doesNotMatch(round8Texts, /未处理/)
  // 点第 9 轮：本轮没有新问题 → 不重复展示已修条目。
  nodesByClass(drawerOf(loaded)(), 'mrl-round').find((node) => textOfTree(node)[0] === '第9轮').props.onClick()
  const round9Texts = textOfTree(drawerOf(loaded)()).join(' | ')
  assert.match(round9Texts, /本轮没有新问题/)
  assert.doesNotMatch(round9Texts, /已修/)
})

test('看板：重载后刚恢复的活绑定（还没拉到 MR 快照）不能说成「历史账本」', async () => {
  const restored = {
    ...fallbackMr,
    merge: null,
    review: null,
    waiting: null,
    problemsRound: null,
    problems: [],
    summary: { total: 0, open: 0, fixed: 0, waived: 0 },
    rounds: [],
  }
  const { panel } = await renderPanel(restored)
  const texts = textOfTree(panel).join(' | ')
  assert.match(texts, /刚恢复监视，正在拉取 MR 状态/)
  assert.doesNotMatch(texts, /历史账本/)
})

test('看板：已合并 / 已关闭的 MR 不显示「差 N 项」，复制指令同时禁用（回归：合并后显示「差 1 项：MR 状态是 merged」）', async () => {
  const merged = {
    ...fallbackMr,
    state: 'merged',
    round: 9,
    sha: 'c0cfe45f12345678',
    review: { verdict: 'pass', historicalUnresolved: 0, verifiedFixed: 1, newThisRound: 0 },
    gates: { sensitive: null, mandatory: null },
    merge: { mergeable: false, missing: [], terminal: 'merged', pipeline: { id: 7364, status: 'success', sha: 'c0cfe45f12345678' } },
    pending: 0,
    waiting: null,
    problemsRound: { n: 9, sha: 'c0cfe45f12345678', current: true },
    summary: { total: 0, open: 0, fixed: 0, waived: 0 },
    rounds: [
      { n: 8, verdict: 'pass', newCount: 0, repeatCount: 0, total: 0, current: false, repeats: [], problems: [] },
      { n: 9, verdict: 'pass', newCount: 0, repeatCount: 0, total: 0, current: true, repeats: [], problems: [] },
    ],
    problems: [],
  }
  const { loaded, panel } = await renderPanel(merged)
  const texts = textOfTree(panel).join(' | ')
  assert.match(texts, /已合并（sha c0cfe45f）/)
  assert.doesNotMatch(texts, /差 [0-9]+ 项/)
  assert.doesNotMatch(texts, /MR 状态是 merged/)
  const copy = nodesByClass(panel, 'mrl-btn').find((node) => textOfTree(node)[0] === '复制指令')
  assert.equal(copy.props.disabled, true)

  const closed = {
    ...merged,
    state: 'closed',
    merge: { mergeable: false, missing: [], terminal: 'closed', pipeline: null },
    review: null,
    rounds: merged.rounds.map((round) => ({ ...round, verdict: round.n === 9 ? null : round.verdict })),
  }
  const second = await renderPanel(closed)
  const closedTexts = textOfTree(second.panel).join(' | ')
  assert.match(closedTexts, /MR 已关闭（未合并）/)
  assert.doesNotMatch(closedTexts, /差 [0-9]+ 项/)
})
