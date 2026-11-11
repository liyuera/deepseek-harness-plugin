import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, DEFAULTS } from '../src/host/config.js'

test('无配置时返回默认值', () => {
  const config = resolveConfig()
  assert.equal(config.enabled, true)
  assert.equal(config.auto, true)
  assert.equal(config.maxRounds, 2)
  assert.deepEqual(config.blockingSeverities, ['high', 'medium'])
  assert.equal(config.reviewerPreset, 'code-review')
  assert.equal(config.asyncReviewerTimeoutMs, 600000)
  assert.deepEqual(config.rulePacks, [])
  assert.ok(Object.isFrozen(config))
})

test('rulePacks 默认空数组且冻结', () => {
  assert.deepEqual(DEFAULTS.rulePacks, [])
  assert.ok(Object.isFrozen(DEFAULTS.rulePacks))
})

test('rulePacks 必须是非空字符串数组', () => {
  for (const value of ['rules/packs/a.json', null, {}, 7]) {
    assert.throws(() => resolveConfig({ rulePacks: value }), /code-review: rulePacks must be an array/)
  }
  for (const value of [[1], [''], ['rules/packs/a.json', null], ['ok.json', '']]) {
    assert.throws(
      () => resolveConfig({ rulePacks: value }),
      /code-review: rulePacks entries must be non-empty strings/,
    )
  }
})

test('rulePacks 覆盖值生效且为冻结副本', () => {
  const packs = ['rules/packs/frontend-smartui.json']
  const config = resolveConfig({ rulePacks: packs })
  assert.deepEqual(config.rulePacks, ['rules/packs/frontend-smartui.json'])
  assert.ok(Object.isFrozen(config.rulePacks))
  assert.notEqual(config.rulePacks, packs, '不得直接复用调用方数组')

  packs.push('rules/packs/other.json')
  assert.deepEqual(config.rulePacks, ['rules/packs/frontend-smartui.json'])
  assert.deepEqual(DEFAULTS.rulePacks, [])
})

test('asyncReviewerTimeoutMs 必须为正整数', () => {
  for (const value of [0, -1, 1.5, '600000']) {
    assert.throws(
      () => resolveConfig({ asyncReviewerTimeoutMs: value }),
      /code-review: asyncReviewerTimeoutMs must be a positive integer/,
    )
  }
})

test('asyncReviewerTimeoutMs 覆盖值生效且保持冻结', () => {
  const config = resolveConfig({ asyncReviewerTimeoutMs: 1200000 })
  assert.equal(config.asyncReviewerTimeoutMs, 1200000)
  assert.ok(Object.isFrozen(config))
})

test('未知键拒绝启动', () => {
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown config key "nope"/)
})

test('非法严重度拒绝', () => {
  assert.throws(() => resolveConfig({ blockingSeverities: ['blocker'] }), /invalid severity "blocker"/)
})

test('maxRounds 必须为正整数', () => {
  assert.throws(() => resolveConfig({ maxRounds: 0 }), /maxRounds must be a positive integer/)
  assert.throws(() => resolveConfig({ maxRounds: 1.5 }), /maxRounds must be a positive integer/)
})

test('扩展名必须带点', () => {
  assert.throws(() => resolveConfig({ codeExtensions: ['ts'] }), /codeExtensions entries must start with "\."/)
})

test('modelOverride 必须成对出现', () => {
  assert.throws(() => resolveConfig({ modelOverride: { provider: 'deepseek' } }), /modelOverride needs both provider and model/)
  const config = resolveConfig({ modelOverride: { provider: 'p', model: 'm' } })
  assert.deepEqual(config.modelOverride, { provider: 'p', model: 'm' })
})

test('覆盖值生效且不污染 DEFAULTS', () => {
  const config = resolveConfig({ maxRounds: 3 })
  assert.equal(config.maxRounds, 3)
  assert.equal(DEFAULTS.maxRounds, 2)
})
