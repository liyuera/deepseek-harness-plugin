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

test('findings 配置：默认 ~/.dsh/workspace + 5MiB，非法值抛 ConfigError', () => {
  const cfg = resolveConfig({})
  assert.equal(cfg.findingsDir, '~/.dsh/workspace')
  assert.equal(cfg.findingsMaxBytes, 5 * 1024 * 1024)
  assert.equal(resolveConfig({ findingsDir: '~/custom', findingsMaxBytes: 1 }).findingsDir, '~/custom')
  for (const bad of ['', 1, null]) {
    assert.throws(
      () => resolveConfig({ findingsDir: bad }),
      (err) => err instanceof ConfigError && err.code === 'invalid-config',
      `findingsDir=${String(bad)} 应被拒绝`,
    )
  }
  for (const bad of [-1, 0, '5242880', 1.5, null]) {
    assert.throws(
      () => resolveConfig({ findingsMaxBytes: bad }),
      (err) => err instanceof ConfigError && err.code === 'invalid-config',
      `findingsMaxBytes=${String(bad)} 应被拒绝`,
    )
  }
})
