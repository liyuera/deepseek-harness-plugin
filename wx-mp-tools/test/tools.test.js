import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import { resolveConfig } from '../lib/config.js'
import {
  boundValue,
  clipText,
  normalizeInspect,
  sniffImageFormat,
  stripUndefined,
  toolDefinitions,
  unwrapEvaluated,
  withImageExtension,
} from '../lib/tools.js'

/** Tool definition surface used by the tests. */
const CONFIG = resolveConfig({}, {})

/** Build tool definitions over stubs that record CLI calls. */
function harness({
  callResult = { result: { success: true } },
  authResult = { ok: true, authorized: true },
  priming = { presets: [], presetOf: () => undefined, primed: () => false },
} = {}) {
  const calls = []
  const cli = {
    resolveCliPath: () => '/fake/wechatide',
    async call(toolName, flags, options) {
      calls.push({ toolName, flags, options })
      return { tool: toolName, result: typeof callResult === 'function' ? callResult(toolName, flags) : callResult.result, payload: {}, warnings: [] }
    },
    async auth() {
      return authResult
    },
    dispose() {},
  }
  const resolver = {
    async resolve() {
      return { projectPath: '/project/dist/build/mp-weixin', source: 'ide' }
    },
    async listProjects() {
      return [{ projectPath: '/project/dist/build/mp-weixin', projectName: 'demo', appId: 'wx1' }]
    },
    invalidate() {},
  }
  const definitions = toolDefinitions({ cli, resolver, config: CONFIG, priming })
  const byName = name => definitions.find(definition => definition.name === name)
  return { calls, definitions, byName }
}

const EXPECTED_TOOLS = [
  'wx_mp_status',
  'wx_mp_authorize',
  'wx_mp_window',
  'wx_mp_compile',
  'wx_mp_screenshot',
  'wx_mp_logs',
  'wx_mp_inspect',
  'wx_mp_act',
  'wx_mp_eval',
  'wx_mp_publish',
  'wx_mp_task',
  'wx_mp_raw',
]

test('exactly the documented tools are registered', () => {
  const { definitions } = harness()
  assert.deepEqual(definitions.map(definition => definition.name).sort(), [...EXPECTED_TOOLS].sort())
})

test('every tool is a valid plain ToolDefinition', () => {
  const { definitions } = harness()
  for (const definition of definitions) {
    assert.equal(typeof definition.name, 'string')
    assert.ok(definition.name.startsWith('wx_mp_'), `${definition.name} keeps the plugin prefix`)
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 40, `${definition.name} has a real description`)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(typeof definition.parameters.properties, 'object')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
  }
})

test('parameter schemas use only the JSON Schema keywords the model layer supports', () => {
  const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description', 'default'])
  const walk = (node, path) => {
    for (const key of Object.keys(node)) assert.ok(allowed.has(key), `${path} uses unsupported keyword ${key}`)
    for (const [name, child] of Object.entries(node.properties ?? {})) walk(child, `${path}.${name}`)
    if (node.items !== undefined) walk(node.items, `${path}[]`)
  }
  const { definitions } = harness()
  for (const definition of definitions) walk(definition.parameters, definition.name)
})

test('output schemas are accepted by the installed runtime validator when available', async () => {
  const candidate = new URL('../../chrome-browser/node_modules/@deepseek-ai/dsh-tools/lib/json-schema.js', import.meta.url)
  if (!existsSync(candidate)) return
  const { assertSupportedJsonSchema } = await import(candidate.href)
  const { definitions } = harness()
  for (const definition of definitions) assert.doesNotThrow(() => assertSupportedJsonSchema(definition.output.schema), definition.name)
})

test('missing required arguments are rejected before any CLI call', async () => {
  const { byName, calls } = harness()
  await assert.rejects(byName('wx_mp_compile').execute({}, {}), /missing required argument/u)
  await assert.rejects(byName('wx_mp_act').execute({ action: 'tap' }, {}), /selector/u)
  await assert.rejects(byName('wx_mp_inspect').execute({ target: 'query_all' }, {}), /selector/u)
  await assert.rejects(byName('wx_mp_eval').execute({}, {}), /fnSource/u)
  await assert.rejects(byName('wx_mp_publish').execute({ action: 'upload' }, {}), /uploadVersion/u)
  await assert.rejects(byName('wx_mp_task').execute({}, {}), /taskId/u)
  assert.equal(calls.length, 0)
})

test('unknown enum values are rejected with the allowed set', async () => {
  const { byName } = harness()
  await assert.rejects(byName('wx_mp_compile').execute({ action: 'rebuild' }, {}), /must be one of/u)
  await assert.rejects(byName('wx_mp_act').execute({ action: 'dance' }, {}), /must be one of/u)
})

test('compile maps actions to the official CLI tools and flags', async () => {
  const { byName, calls } = harness()
  const compile = byName('wx_mp_compile')
  await compile.execute({ action: 'refresh' }, {})
  assert.equal(calls[0].toolName, 'simulator_refresh')
  assert.deepEqual(calls[0].flags, { project: '/project/dist/build/mp-weixin' })

  await compile.execute({ action: 'open_page', page: 'pages/house/list', query: 'id=1' }, {})
  assert.equal(calls[1].toolName, 'simulator_open_page')
  assert.deepEqual(calls[1].flags, { project: '/project/dist/build/mp-weixin', page: 'pages/house/list', query: 'id=1' })
})

test('screenshot maps flags and renders a read_image hint', async () => {
  const { byName, calls } = harness({
    callResult: { result: { success: true, path: '/tmp/shot.jpg', imageWidth: 591, imageHeight: 1280 } },
  })
  const screenshot = byName('wx_mp_screenshot')
  const value = await screenshot.execute({ waitForSelector: '.card', quality: 60 }, {})
  assert.equal(calls[0].toolName, 'simulator_screenshot')
  assert.deepEqual(calls[0].flags, {
    project: '/project/dist/build/mp-weixin',
    waitForSelector: '.card',
    quality: 60,
  })
  assert.equal(value.path, '/tmp/shot.jpg')
  const [block] = screenshot.output.render({}, value)
  assert.match(block.text, /591x1280/u)
  assert.match(block.text, /read_image/u)
})

test('logs default to a narrow network pattern and report empty matches as such', async () => {
  const { byName, calls } = harness({ callResult: { result: '' } })
  const logs = byName('wx_mp_logs')
  const network = await logs.execute({ kind: 'network' }, {})
  assert.deepEqual(calls[0].flags, { project: '/project/dist/build/mp-weixin', command: 'grep -i error' })
  assert.equal(network.empty, true)
  assert.match(network.note, /not mean the buffer is empty/u)

  const consoleOut = await logs.execute({ kind: 'console' }, {})
  assert.equal(calls[1].flags.command, 'grep -n .')
  assert.equal(consoleOut.empty, true)
})

test('act maps interaction actions to the right official tools', async () => {
  const { byName, calls } = harness()
  const act = byName('wx_mp_act')
  await act.execute({ action: 'tap', selector: '.card' }, {})
  assert.equal(calls[0].toolName, 'automation_element_action')
  assert.deepEqual(calls[0].flags, { project: '/project/dist/build/mp-weixin', action: 'tap', selector: '.card' })

  await act.execute({ action: 'input', selector: 'input', value: 'hello' }, {})
  assert.deepEqual(calls[1].flags, { project: '/project/dist/build/mp-weixin', action: 'input', selector: 'input', value: 'hello' })

  await act.execute({ action: 'navigate', url: '/pages/house/list' }, {})
  assert.equal(calls[2].toolName, 'automation_navigate')
  assert.deepEqual(calls[2].flags, { project: '/project/dist/build/mp-weixin', action: 'navigateTo', url: '/pages/house/list' })

  await act.execute({ action: 'page_scroll_to', scrollTop: 400 }, {})
  assert.equal(calls[3].toolName, 'automation_viewport_action')
  assert.deepEqual(calls[3].flags, { project: '/project/dist/build/mp-weixin', action: 'pageScrollTo', scrollTop: 400 })
})

test('inspect requires name for element_style and normalizes the result shapes', async () => {
  const { byName, calls } = harness({ callResult: { result: { success: true, elements: [{ elementId: '5', tagName: 'view' }] } } })
  const inspect = byName('wx_mp_inspect')
  await assert.rejects(inspect.execute({ target: 'element_style', selector: '.x' }, {}), /name/u)
  const query = await inspect.execute({ target: 'query_all', selector: 'view' }, {})
  assert.equal(query.target, 'query_all')
  assert.deepEqual(query.elements, [{ elementId: '5', tagName: 'view' }])

  const { byName: inspectHarness, calls: inspectCalls } = harness({ callResult: { result: { success: true, width: 390, height: 375.5 } } })
  const size = await inspectHarness('wx_mp_inspect').execute({ target: 'element_size', selector: 'view' }, {})
  assert.deepEqual(size.size, { width: 390, height: 375.5 })
  assert.equal(inspectCalls[0].flags.action, 'size')
})

test('eval unwraps the nested evaluate result', async () => {
  const { byName } = harness({ callResult: { result: { success: true, result: { result: { brand: 'devtools' } } } } })
  const value = await byName('wx_mp_eval').execute({ fnSource: 'function () { return {} }' }, {})
  assert.deepEqual(value.value, { brand: 'devtools' })
})

test('publish surfaces pending tasks instead of treating them as success', async () => {
  const { byName } = harness({ callResult: { result: { success: true, taskId: 'task-9', status: 'pending' } } })
  const value = await byName('wx_mp_publish').execute({ action: 'preview' }, {})
  assert.equal(value.pending, true)
  assert.equal(value.taskId, 'task-9')
  assert.match(value.note, /wx_mp_task/u)
})

test('raw injects the resolved project and surfaces CLI warnings', async () => {
  const calls = []
  const cli = {
    resolveCliPath: () => '/fake/wechatide',
    async call(toolName, flags) {
      calls.push({ toolName, flags })
      return { tool: toolName, result: { success: true }, payload: {}, warnings: ['未知参数 --bogus 已忽略，继续执行'] }
    },
    async auth() {
      return {}
    },
    dispose() {},
  }
  const resolver = {
    async resolve() {
      return { projectPath: '/project/dist/build/mp-weixin', source: 'ide' }
    },
    async listProjects() {
      return []
    },
    invalidate() {},
  }
  const [definition] = toolDefinitions({ cli, resolver, config: CONFIG }).filter(item => item.name === 'wx_mp_raw')
  const value = await definition.execute({ tool: 'compile_wxml', args: { page: 'pages/index/index' } }, {})
  assert.equal(calls[0].toolName, 'compile_wxml')
  assert.deepEqual(calls[0].flags, { page: 'pages/index/index', project: '/project/dist/build/mp-weixin' })
  assert.deepEqual(value.warnings, ['未知参数 --bogus 已忽略，继续执行'])
})

test('status reports preset priming state for the calling agent', async () => {
  const { byName } = harness({
    priming: { presets: ['liyu'], presetOf: agent => (agent === undefined ? undefined : 'liyu'), primed: () => true },
  })
  const value = await byName('wx_mp_status').execute({}, { agent: { id: 'a1' } })
  assert.equal(value.bridge, 'ok')
  assert.deepEqual(value.prime, { presets: ['liyu'], preset: 'liyu', applied: true })
})

test('status reports priming as not applied when the preset is a different one', async () => {
  const { byName } = harness({
    priming: { presets: ['liyu'], presetOf: () => 'standard', primed: () => false },
  })
  const value = await byName('wx_mp_status').execute({}, { agent: { id: 'a2' } })
  assert.deepEqual(value.prime, { presets: ['liyu'], preset: 'standard', applied: false })
})

test('status reports a missing bridge instead of throwing', async () => {
  const { byName } = harness()
  const cliMissing = {
    resolveCliPath: () => {
      const error = new Error('missing')
      error.kind = 'cli-missing'
      throw error
    },
    async call() {
      throw new Error('unreachable')
    },
    async auth() {
      return {}
    },
    dispose() {},
  }
  const resolver = {
    async resolve() {
      return { projectPath: '/p', source: 'ide' }
    },
    async listProjects() {
      return []
    },
    invalidate() {},
  }
  const [status] = toolDefinitions({ cli: cliMissing, resolver, config: CONFIG }).filter(item => item.name === 'wx_mp_status')
  const value = await status.execute({}, {})
  assert.equal(value.bridge, 'cli-missing')
  assert.match(value.next, /cliPath/u)
})

test('page_data no longer emits an undefined selector (regression: lossless JSON rejection)', async () => {
  const { byName, calls } = harness({ callResult: { result: { success: true, data: { d: '北京市' } } } })
  const value = await byName('wx_mp_inspect').execute({ target: 'page_data' }, {})
  assert.deepEqual(value.data, { d: '北京市' })
  assert.equal('selector' in value, false)
  assert.equal(calls[0].flags.dataPath, undefined)
  assert.equal('dataPath' in calls[0].flags, false)

  const withPath = await byName('wx_mp_inspect').execute({ target: 'page_data', dataPath: 'd' }, {})
  assert.deepEqual(withPath.data, { d: '北京市' })
  assert.equal(calls[1].flags.dataPath, 'd')
})

test('stripUndefined removes undefined members so results stay lossless JSON', () => {
  assert.deepEqual(stripUndefined({ a: undefined, b: { c: undefined, d: 1 }, e: [undefined, 1] }), { b: { d: 1 }, e: [null, 1] })
  assert.equal(stripUndefined(undefined), null)
  assert.deepEqual(stripUndefined({ keep: 0, drop: undefined }), { keep: 0 })
})

test('eval normalizes an undefined return value to null', async () => {
  const { byName } = harness({ callResult: { result: { success: true, result: { result: undefined } } } })
  const value = await byName('wx_mp_eval').execute({ fnSource: 'function () {}' }, {})
  assert.equal(value.value, null)
})

test('image helpers correct a contradictory screenshot extension', () => {
  assert.equal(withImageExtension('/tmp/a.png', 'jpg'), '/tmp/a.jpg')
  assert.equal(withImageExtension('/tmp/a.jpeg', 'png'), '/tmp/a.png')
  assert.equal(withImageExtension('/tmp/a', 'png'), '/tmp/a.png')
  assert.equal(withImageExtension('/tmp/a.JPG', 'jpg'), '/tmp/a.jpg')
  assert.equal(sniffImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpg')
  assert.equal(sniffImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png')
  assert.equal(sniffImageFormat(Buffer.from('nope')), undefined)
})

test('screenshot defaults to jpg and emits --optimize=false (not --no-optimize) when asked for a PNG', async () => {
  const { byName, calls } = harness({
    callResult: { result: { success: true, path: '/tmp/shot.jpg', imageWidth: 591, imageHeight: 1280 } },
  })
  const screenshot = byName('wx_mp_screenshot')
  const pngValue = await screenshot.execute({ optimize: false, path: '/tmp/want.png' }, {})
  assert.equal(calls[0].flags.optimize, false)
  assert.equal(calls[0].flags.path, '/tmp/want.png')
  assert.equal(pngValue.requestedPath, '/tmp/want.png')
  assert.equal(pngValue.format, 'png')

  const defaultValue = await screenshot.execute({}, {})
  assert.equal('optimize' in calls[1].flags, false)
  assert.equal(defaultValue.format, 'jpg')

  const jpgPath = await screenshot.execute({ path: '/tmp/want.png' }, {})
  assert.equal(calls[2].flags.path, '/tmp/want.jpg')
  assert.equal(jpgPath.requestedPath, '/tmp/want.png')
})

test('clipText and boundValue keep oversized results out of context', () => {
  assert.equal(clipText('abc', 10), 'abc')
  const clipped = clipText('abcdefghij', 4)
  assert.match(clipped, /^abcd\n…\[truncated 6 more characters/u)
  const small = { a: 1 }
  assert.equal(boundValue(small, 100), small)
  const big = { text: 'x'.repeat(500) }
  const bounded = boundValue(big, 100)
  assert.equal(bounded.truncated, true)
  assert.ok(bounded.preview.length > 0)
})

test('unwrapEvaluated is bounded and preserves ordinary objects', () => {
  assert.equal(unwrapEvaluated({ success: true, result: 42 }), 42)
  assert.deepEqual(unwrapEvaluated({ success: true, result: { result: { a: 1 } } }), { a: 1 })
  assert.deepEqual(unwrapEvaluated({ a: 1 }), { a: 1 })
  assert.deepEqual(unwrapEvaluated({ result: { a: 1 }, other: true }), { result: { a: 1 }, other: true })
})

test('normalizeInspect projects system info and element strings', () => {
  const system = normalizeInspect('system_info', { success: true, systemInfo: { result: { brand: 'devtools' } } }, '/p', 1000)
  assert.deepEqual(system.systemInfo, { brand: 'devtools' })
  const text = normalizeInspect('element_text', '北京市', '/p', 1000)
  assert.equal(text.value, '北京市')
  const long = normalizeInspect('element_wxml', 'x'.repeat(50), '/p', 10)
  assert.equal(long.truncated, true)
})
