import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, ConfigError } from '../src/host/config.js'

test('默认值与冻结', () => {
  const cfg = resolveConfig({})
  assert.equal(cfg.baseUrl, 'https://git.htwisdom.cn')
  assert.equal(cfg.maxRounds, 0)
  assert.equal(cfg.pollAwaitingMs, 10000)
  assert.equal(cfg.ledgerKeepRounds, 50)
  assert.ok(Object.isFrozen(cfg))
})

test('baseUrl 去尾斜杠并接受子路径', () => {
  assert.equal(resolveConfig({ baseUrl: 'https://git.x.com/' }).baseUrl, 'https://git.x.com')
})

test('拒绝带凭据 / query / 非 http 的 baseUrl', () => {
  for (const bad of ['https://u:p@git.x.com', 'https://git.x.com/?a=1', 'ftp://git.x.com', 'not-a-url']) {
    assert.throws(() => resolveConfig({ baseUrl: bad }), (err) => err instanceof ConfigError && err.code === 'invalid-config')
  }
})

test('数值下限', () => {
  assert.throws(() => resolveConfig({ pollAwaitingMs: 100 }), /pollAwaitingMs/)
  assert.throws(() => resolveConfig({ maxRounds: -1 }), /maxRounds/)
  assert.equal(resolveConfig({ maxRounds: 0 }).maxRounds, 0)
})

test('未知键忽略、字符串不能为空', () => {
  assert.doesNotThrow(() => resolveConfig({ whatever: 1 }))
  assert.throws(() => resolveConfig({ tokenFile: '' }), /tokenFile/)
})
