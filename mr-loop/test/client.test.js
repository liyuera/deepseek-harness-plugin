/**
 * 客户端 bundle 契约测试：不启浏览器，用最小 DOM/React/loader 桩验证
 * `window.__ModuleLoader__.load({id, factory})` 的产物能被宿主正确接线。
 *
 * 目的不是渲染像素，而是钉死四件事：
 *   1. 模块 id 与包名一致、工厂返回 exports；
 *   2. 导出 inject=['slots'] 与 apply(ctx)；
 *   3. apply 只注册两个座位：会话头 chip 与 shell.overlay 抽屉；
 *   4. 样式只注入一次（重复 apply 不重复插 style）。
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
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
}

function loadBundle() {
  const injectedStyles = []
  const documentStub = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', setAttribute() {} }),
    head: { appendChild: (tag) => injectedStyles.push(tag) },
    body: { appendChild() {}, removeChild() {} },
  }
  const registrations = []
  const ctx = {
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
      setInterval: () => 0,
    },
    document: documentStub,
    fetch: async () => ({ ok: true, json: async () => ({ mrs: [], counts: {} }) }),
    navigator: { clipboard: { writeText: async () => {} } },
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(bundlePath, 'utf8'), sandbox, { filename: 'client.js' })
  return { sandbox, ctx, registrations, injectedStyles }
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
  const { sandbox, ctx, injectedStyles } = loadBundle()
  let injected = null
  // 第一次 apply 之后让 querySelector 能查到已插入的标签，模拟真实 DOM 去重。
  sandbox.document.querySelector = () => (injected === null ? null : {})
  sandbox.document.head.appendChild = (tag) => {
    injected = tag
    injectedStyles.push(tag)
  }

  sandbox.__moduleExports.apply(ctx)
  sandbox.__moduleExports.apply(ctx)

  assert.equal(injectedStyles.length, 1)
  assert.equal(injected.dataset.plugin, '@liyuera/dsh-mr-loop')
  assert.equal(injected.dataset.pluginCss, '@liyuera/dsh-mr-loop/panel.css')
  assert.match(injected.textContent, /\.mrl-panel/)
})
