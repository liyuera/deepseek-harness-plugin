import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  camelToKebab,
  cliCandidates,
  classifyFailure,
  describeFailure,
  flagsToArgv,
  parsePayload,
  pendingTaskOf,
  WechatideCli,
  WxmpCliError,
} from '../lib/cli.js'
import { resolveConfig } from '../lib/config.js'

test('camelToKebab maps CLI flag names exactly (unknown flags are silently ignored by the CLI)', () => {
  assert.equal(camelToKebab('waitForSelector'), 'wait-for-selector')
  assert.equal(camelToKebab('dataPath'), 'data-path')
  assert.equal(camelToKebab('fnSource'), 'fn-source')
  assert.equal(camelToKebab('taskId'), 'task-id')
  assert.equal(camelToKebab('uploadVersion'), 'upload-version')
  assert.equal(camelToKebab('windowMode'), 'window-mode')
  assert.equal(camelToKebab('qrFormat'), 'qr-format')
  assert.equal(camelToKebab('compileType'), 'compile-type')
  assert.equal(camelToKebab('scrollTop'), 'scroll-top')
  assert.equal(camelToKebab('optimize'), 'optimize')
})

test('flagsToArgv skips empty values, maps booleans and JSON values', () => {
  const argv = flagsToArgv({
    project: '/tmp/app',
    waitForSelector: '.card',
    wait: 2,
    optimize: false,
    optimizeTrue: true,
    detail: { kind: 'tap' },
    list: ['a', 'b'],
    missing: undefined,
    absent: null,
  })
  assert.deepEqual(argv, [
    '--project', '/tmp/app',
    '--wait-for-selector', '.card',
    '--wait', '2',
    '--optimize=false',
    '--optimize-true',
    '--detail', '{"kind":"tap"}',
    '--list', '["a","b"]',
  ])
})

test('parsePayload reads the JSON envelope and tolerates stray stdout lines', () => {
  assert.deepEqual(parsePayload('{"ok":true,"result":1}\n'), { ok: true, result: 1 })
  assert.deepEqual(parsePayload('log line\n{"ok":true}\n'), { ok: true })
  assert.deepEqual(parsePayload('{"ok":false,"message":"x"} trailing'), { ok: false, message: 'x' })
  assert.equal(parsePayload('not json at all'), undefined)
  assert.equal(parsePayload(''), undefined)
})

test('classifyFailure branches on reason/code before message', () => {
  assert.equal(classifyFailure({ errorType: 'INPUT_ERROR', reason: 'missing_required' }), 'input')
  assert.equal(classifyFailure({ errorType: 'CONNECT_ERROR', message: 'x' }), 'devtools-down')
  assert.equal(classifyFailure({ errorType: 'MCP_TOOL_ERROR', reason: 'PROJECT_CONFIG_JSON_ERROR' }), 'project')
  assert.equal(classifyFailure({ message: 'cant find runtimeid by projectpath /x' }), 'project')
  assert.equal(classifyFailure({ errorType: 'AUTH_ERROR', message: 'need auth' }), 'auth-required')
  assert.equal(classifyFailure({ errorType: 'MCP_TOOL_ERROR', reason: 'mcp_business_fail', message: 'no such element' }), 'tool')
})

test('describeFailure names the next action per class', () => {
  assert.match(describeFailure('simulator_screenshot', { errorType: 'INPUT_ERROR', message: 'missing required', missing: ['--project'] }), /missing=--project/u)
  assert.match(describeFailure('simulator_screenshot', { errorType: 'INPUT_ERROR', message: 'missing required' }), /静默忽略/u)
  assert.match(describeFailure('x', { errorType: 'MCP_TOOL_ERROR', reason: 'PROJECT_CONFIG_JSON_ERROR', message: 'bad' }), /产物目录/u)
  assert.match(describeFailure('x', { errorType: 'AUTH_ERROR', message: 'unauth' }), /wx_mp_authorize/u)
})

test('pendingTaskOf only reports a pending task, not every result carrying a taskId', () => {
  assert.deepEqual(pendingTaskOf({ taskId: 't1', status: 'pending' }), { pending: true, taskId: 't1', status: 'pending' })
  assert.deepEqual(pendingTaskOf({ taskId: 't1' }), { pending: true, taskId: 't1', status: 'pending' })
  assert.equal(pendingTaskOf({ taskId: 't1', status: 'success' }), undefined)
  assert.equal(pendingTaskOf({ status: 'pending' }), undefined)
  assert.equal(pendingTaskOf('pending'), undefined)
  assert.equal(pendingTaskOf(null), undefined)
})

test('cliCandidates covers the macOS bundle and Windows installer layouts', () => {
  const mac = cliCandidates('darwin', {}, '/Users/tester')
  assert.ok(mac.includes('/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide'))
  assert.ok(mac.some(candidate => candidate.startsWith('/Users/tester/')))
  const win = cliCandidates('win32', { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' }, 'C:\\Users\\t')
  assert.ok(win.some(candidate => candidate.endsWith('wechatide.cmd')))
  assert.deepEqual(cliCandidates('linux', {}, '/home/t'), [])
})

test('missing CLI raises an actionable cli-missing error', () => {
  const cli = new WechatideCli(resolveConfig({ cliPath: '/definitely/not/here/wechatide' }))
  // Force detection to a miss so the test does not depend on the host installation.
  cli.resolvedPath = null
  assert.throws(() => cli.resolveCliPath(), error => {
    assert.ok(error instanceof WxmpCliError)
    assert.equal(error.kind, 'cli-missing')
    assert.match(error.message, /WECHATIDE_CLI_PATH/u)
    return true
  })
})

test('call serializes invocations through the queue', async () => {
  const cli = new WechatideCli(resolveConfig({}))
  const order = []
  cli.resolvedPath = '/fake/wechatide'
  cli.spawnOnce = async (argv) => {
    order.push(`start:${argv[2]}`)
    await new Promise(resolve => setTimeout(resolve, 5))
    order.push(`end:${argv[2]}`)
    return { stdout: '{"ok":true,"result":1}', stderr: '', exitCode: 0 }
  }
  await Promise.all([cli.call('a'), cli.call('b')])
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b'])
})

test('call surfaces parse failures with stderr tail', async () => {
  const cli = new WechatideCli(resolveConfig({}))
  cli.run = async () => ({ stdout: 'help text', stderr: '[wechatide] skill-call: x\nboom\n', exitCode: 0 })
  await assert.rejects(cli.call('x'), /没有返回 JSON/u)
})

test('call throws the classified tool error on ok:false', async () => {
  const cli = new WechatideCli(resolveConfig({}))
  cli.run = async () => ({ stdout: '{"ok":false,"errorType":"MCP_TOOL_ERROR","message":"no such element","reason":"mcp_business_fail"}', stderr: '', exitCode: 1 })
  await assert.rejects(cli.call('automation_element_action'), error => {
    assert.ok(error instanceof WxmpCliError)
    assert.equal(error.kind, 'tool')
    assert.match(error.message, /no such element/u)
    return true
  })
})

test('call exposes CLI warnings about ignored flags', async () => {
  const cli = new WechatideCli(resolveConfig({}))
  cli.run = async () => ({ stdout: '{"ok":true,"warnings":["未知参数 --bogus 已忽略，继续执行"],"result":{"success":true}}', stderr: '', exitCode: 0 })
  const outcome = await cli.call('project_list')
  assert.deepEqual(outcome.warnings, ['未知参数 --bogus 已忽略，继续执行'])
})
