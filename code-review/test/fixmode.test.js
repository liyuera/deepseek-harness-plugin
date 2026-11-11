import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyFixMode,
  decorateFindings,
  DEFAULT_MANUAL_GLOBS,
} from '../src/host/fixmode.js'

const config = {
  respectFixPolicy: true,
  manualFixGlobs: DEFAULT_MANUAL_GLOBS,
  forbiddenFixGlobs: ['**/secrets/**'],
}

const finding = (over = {}) => ({
  ruleId: 'COR-001', dimension: 'correctness', severity: 'high',
  location: 'src/app/main.ts:10', problem: 'p', suggestion: 's', ...over,
})

test('普通路径默认 auto', () => {
  assert.equal(classifyFixMode(finding(), { config }), 'auto')
})

test('生成代码/契约/迁移路径 → manual', () => {
  for (const path of [
    'src/generated/api.ts',
    'src/apis/user.generated.ts',
    'src/kubb/models/user.ts',
    'src/types/api.d.ts',
    'src/contracts/order.ts',
    'db/migrations/001.sql',
  ]) {
    assert.equal(classifyFixMode(finding({ location: `${path}:1` }), { config }), 'manual', path)
  }
})

test('forbidden 路径优先于 manual', () => {
  assert.equal(classifyFixMode(finding({ location: 'src/secrets/token.ts:1' }), { config }), 'forbidden')
})

test('规则显式 fixMode 优先于路径推断', () => {
  const ruleFixModes = new Map([['COR-001', 'manual']])
  assert.equal(classifyFixMode(finding(), { ruleFixModes, config }), 'manual')
})

test('respectFixPolicy=false 时忽略路径策略', () => {
  assert.equal(
    classifyFixMode(finding({ location: 'src/generated/api.ts:1' }), {
      config: { ...config, respectFixPolicy: false },
    }),
    'auto',
  )
})

test('decorateFindings 补 fixMode/blocking/evidenceStatus', () => {
  const decorated = decorateFindings(
    [finding(), finding({ ruleId: 'MNT-011', severity: 'low' })],
    {
      ruleFixModes: new Map(),
      ruleBlocking: new Map([['MNT-011', false]]),
      config,
      evidence: ['ok', 'missing'],
    },
  )
  assert.equal(decorated[0].fixMode, 'auto')
  assert.equal(decorated[0].blocking, true)
  assert.equal(decorated[0].evidenceStatus, 'ok')
  assert.equal(decorated[1].blocking, false)
  assert.equal(decorated[1].evidenceStatus, 'missing')
})
