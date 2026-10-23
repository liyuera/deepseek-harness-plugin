import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveConfig } from '../lib/config.js'

test('resolveConfig applies defaults', () => {
  const config = resolveConfig({}, {})
  assert.equal(config.clientName, 'dsh')
  assert.equal(config.timeoutMs, 180_000)
  assert.equal(config.maxTextChars, 60_000)
  assert.equal(config.token, undefined)
  assert.equal(config.cliPath, undefined)
  assert.equal(config.project, undefined)
  assert.equal(config.skillVersion, undefined)
})

test('resolveConfig falls back to environment variables for secrets and path', () => {
  const config = resolveConfig({}, {
    WECHAT_DEVTOOLS_CLI_TOKEN: 'tok-123',
    WECHATIDE_CLI_PATH: '/opt/wx/wechatide',
  })
  assert.equal(config.token, 'tok-123')
  assert.equal(config.cliPath, '/opt/wx/wechatide')
})

test('explicit config wins over environment', () => {
  const config = resolveConfig({ token: 'explicit', cliPath: '/given/wechatide' }, {
    WECHAT_DEVTOOLS_CLI_TOKEN: 'env-token',
    WECHATIDE_CLI_PATH: '/env/wechatide',
  })
  assert.equal(config.token, 'explicit')
  assert.equal(config.cliPath, '/given/wechatide')
})

test('an unsafe clientName falls back to the default', () => {
  assert.equal(resolveConfig({ clientName: 'has space' }, {}).clientName, 'dsh')
  assert.equal(resolveConfig({ clientName: '' }, {}).clientName, 'dsh')
  assert.equal(resolveConfig({ clientName: 'cursor' }, {}).clientName, 'cursor')
})

test('invalid numeric bounds fall back instead of propagating NaN', () => {
  const config = resolveConfig({ timeoutMs: -1, maxTextChars: 'lots' }, {})
  assert.equal(config.timeoutMs, 180_000)
  assert.equal(config.maxTextChars, 60_000)
  assert.equal(resolveConfig({ timeoutMs: 15_000, maxTextChars: 1_000 }, {}).timeoutMs, 15_000)
  assert.equal(resolveConfig({ timeoutMs: 1.4 }, {}).timeoutMs, 1)
})
