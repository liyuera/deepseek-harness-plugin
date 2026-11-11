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

test('fullReview 配置默认与校验', () => {
  const config = resolveConfig()
  assert.equal(config.fullReview, true)
  assert.equal(config.fullReviewMaxFiles, 20)
  assert.throws(() => resolveConfig({ fullReview: 'yes' }), /fullReview must be a boolean/)
  assert.throws(() => resolveConfig({ fullReviewMaxFiles: 0 }), /fullReviewMaxFiles must be a positive integer/)
  assert.throws(() => resolveConfig({ fullReviewMaxFiles: 1.5 }), /fullReviewMaxFiles must be a positive integer/)
  assert.equal(resolveConfig({ fullReview: false, fullReviewMaxFiles: 5 }).fullReview, false)
  assert.equal(resolveConfig({ fullReviewMaxFiles: 5 }).fullReviewMaxFiles, 5)
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

test('notifySeverities 默认空数组且冻结', () => {
  assert.deepEqual(DEFAULTS.notifySeverities, [])
  assert.ok(Object.isFrozen(DEFAULTS.notifySeverities))
  const config = resolveConfig()
  assert.deepEqual(config.notifySeverities, [])
  assert.ok(Object.isFrozen(config.notifySeverities))
})

test('notifySeverities 覆盖值生效且为冻结副本', () => {
  const severities = ['low', 'nit']
  const config = resolveConfig({ notifySeverities: severities })
  assert.deepEqual(config.notifySeverities, ['low', 'nit'])
  assert.ok(Object.isFrozen(config.notifySeverities))
  assert.notEqual(config.notifySeverities, severities, '不得直接复用调用方数组')

  severities.push('high')
  assert.deepEqual(config.notifySeverities, ['low', 'nit'])
  assert.deepEqual(DEFAULTS.notifySeverities, [])
})

test('notifySeverities 校验非数组/非法严重度', () => {
  for (const value of ['low', null, {}, 7]) {
    assert.throws(() => resolveConfig({ notifySeverities: value }), /code-review: notifySeverities must be an array/)
  }
  assert.throws(() => resolveConfig({ notifySeverities: ['bogus'] }), /code-review: invalid severity "bogus"/)
})

test('v0.4 新配置默认值：证据/覆盖/复验/修复策略/抑制', () => {
  const config = resolveConfig()
  assert.equal(config.evidenceMode, 'warn')
  assert.equal(config.coverageMode, 'warn')
  assert.equal(config.verify, 'blocking')
  assert.equal(config.maxVerifiedFindings, 3)
  assert.equal(config.verifyTimeoutMs, 180000)
  assert.equal(config.respectFixPolicy, true)
  assert.ok(config.manualFixGlobs.includes('**/generated/**'))
  assert.deepEqual(config.forbiddenFixGlobs, [])
  assert.equal(config.suppressionsFile, '.dsh/code-review-suppressions.json')
  assert.deepEqual(config.suppressions, [])
  assert.ok(Object.isFrozen(config.suppressions))
})

test('v0.4 枚举/数值/数组配置校验', () => {
  assert.throws(() => resolveConfig({ evidenceMode: 'strict' }), /evidenceMode must be one of/)
  assert.throws(() => resolveConfig({ coverageMode: 'strict' }), /coverageMode must be one of/)
  assert.throws(() => resolveConfig({ verify: 'always' }), /verify must be one of/)
  assert.throws(() => resolveConfig({ maxVerifiedFindings: 0 }), /maxVerifiedFindings must be a positive integer/)
  assert.throws(() => resolveConfig({ verifyTimeoutMs: -1 }), /verifyTimeoutMs must be a positive integer/)
  assert.throws(() => resolveConfig({ respectFixPolicy: 'yes' }), /respectFixPolicy must be a boolean/)
  assert.throws(() => resolveConfig({ manualFixGlobs: '**/x/**' }), /manualFixGlobs must be an array/)
  assert.throws(() => resolveConfig({ forbiddenFixGlobs: [''] }), /forbiddenFixGlobs entries must be non-empty strings/)
  assert.throws(() => resolveConfig({ suppressionsFile: '' }), /suppressionsFile must be a non-empty string/)
})

test('suppressions 配置校验并冻结副本', () => {
  const suppressions = [{ ruleId: 'BEH-001', reason: '产品决策', disposition: 'wontfix' }]
  const config = resolveConfig({ suppressions })
  assert.equal(config.suppressions.length, 1)
  assert.ok(Object.isFrozen(config.suppressions))
  assert.throws(() => resolveConfig({ suppressions: [{ reason: '缺 matcher' }] }), /at least one of/)
})

test('v0.6 范围审查/分块/敏感路径配置默认值与校验', () => {
  const config = resolveConfig({})
  assert.equal(config.maxFileDiffBytes, 61440)
  assert.equal(config.maxRangeBytes, 4000000)
  assert.equal(config.rangeTimeoutMs, 900000)
  assert.equal(config.rangeChunkTimeoutMs, 240000)
  assert.equal(config.rangeConcurrency, 1)
  assert.equal(config.reviewerTimeoutPerKbMs, 500)
  assert.equal(config.reviewerTimeoutMaxMs, 900000)
  assert.ok(config.sensitiveGlobs.includes('**/auth/**'))
  assert.ok(config.sensitiveGlobs.includes('**/.github/workflows/**'))
  assert.ok(Object.isFrozen(config.sensitiveGlobs))

  assert.throws(() => resolveConfig({ rangeConcurrency: 3 }), /rangeConcurrency must be 1 or 2/)
  assert.throws(() => resolveConfig({ rangeConcurrency: 0 }), /rangeConcurrency must be 1 or 2/)
  assert.throws(() => resolveConfig({ maxRangeBytes: 0 }), /maxRangeBytes must be a positive integer/)
  assert.throws(() => resolveConfig({ maxFileDiffBytes: -1 }), /maxFileDiffBytes must be a positive integer/)
  assert.throws(() => resolveConfig({ rangeTimeoutMs: 1.5 }), /rangeTimeoutMs must be a positive integer/)
  assert.throws(() => resolveConfig({ rangeChunkTimeoutMs: 0 }), /rangeChunkTimeoutMs must be a positive integer/)
  assert.throws(() => resolveConfig({ sensibleGlobs: [] }), /unknown config key/)
  assert.throws(() => resolveConfig({ sensitiveGlobs: [''] }), /sensitiveGlobs entries must be non-empty strings/)
})
