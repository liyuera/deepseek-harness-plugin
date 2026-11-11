import assert from 'node:assert/strict'
import test from 'node:test'
import { BOUNDARY_LINE, renderFindings, renderLedger } from '../src/host/render.js'

const finding = (over = {}) => ({
  ruleId: 'COR-001',
  dimension: 'correctness',
  severity: 'high',
  location: 'src/a.ts:2',
  problem: '问题',
  suggestion: '建议',
  ...over,
})

const base = { skipped: [], blockingSeverities: ['high', 'medium'], summary: { files: 1, added: 3, deleted: 1 } }

test('首个报告不标重复，历史上报过才标「第 N 次报告（尚未修复）」', () => {
  const first = renderFindings({ ...base, findings: [finding({ repeats: 1 })], mode: 'report' })
  assert.doesNotMatch(first, /第 1 次报告/)
  const second = renderFindings({ ...base, findings: [finding({ repeats: 2 })], mode: 'report' })
  assert.match(second, /（第 2 次报告，尚未修复）/)
})

test('steer 模式也标注重复次数（复用同一行渲染）', () => {
  const text = renderFindings({ ...base, findings: [finding({ repeats: 3 })], mode: 'steer' })
  assert.match(text, /（第 3 次报告，尚未修复）/)
})

test('report 报告末尾带固定边界声明，steer/notify 不带', () => {
  const report = renderFindings({ ...base, findings: [finding()], mode: 'report' })
  assert.ok(report.includes(BOUNDARY_LINE))
  const steer = renderFindings({ ...base, findings: [finding()], mode: 'steer' })
  assert.equal(steer.includes(BOUNDARY_LINE), false)
  const notify = renderFindings({
    ...base,
    findings: [finding({ severity: 'low', dimension: 'maintainability', ruleId: 'MNT-001' })],
    mode: 'notify',
    notifySeverities: ['low'],
  })
  assert.equal(notify.includes(BOUNDARY_LINE), false)
})

test('renderLedger 空输入返回空串，缺失项按严重度排序并说明不自动关闭', () => {
  assert.equal(renderLedger([]), '')
  assert.equal(renderLedger(undefined), '')
  const text = renderLedger([
    finding({ ruleId: 'MNT-001', severity: 'low', dimension: 'maintainability', location: 'src/b.ts:9', missedRuns: 2 }),
    finding({ ruleId: 'COR-001', severity: 'high', missedRuns: 3 }),
  ])
  assert.match(text, /账本（人工裁决，不自动关闭）:/)
  assert.match(text, /\[COR-001\] src\/a\.ts:2（连续 3 轮未再出现/)
  assert.match(text, /不自动关闭/)
  assert.ok(text.indexOf('[COR-001]') < text.indexOf('[MNT-001]'), '严重度高的排在前面')
})
