import test from 'node:test'
import assert from 'node:assert/strict'
import { partition, renderFindings, renderPass } from '../src/host/render.js'

const finding = (over) => ({
  ruleId: 'SEC-001', dimension: 'security', severity: 'high',
  location: 'src/a.ts:42', problem: '令牌进了日志', suggestion: '改记 tokenId', ...over,
})

test('partition 按阈值切分', () => {
  const { blocking, passive } = partition(
    [finding(), finding({ severity: 'low', ruleId: 'MNT-002', dimension: 'maintainability' })],
    ['high', 'medium'],
  )
  assert.equal(blocking.length, 1)
  assert.equal(passive.length, 1)
})

test('renderFindings 带结论、规则、维度、位置、建议', () => {
  const text = renderFindings({
    findings: [finding()],
    skipped: [],
    blockingSeverities: ['high', 'medium'],
    summary: { files: 3, added: 40, deleted: 7 },
  })
  assert.match(text, /结论: 需修改（1 处阻塞）/)
  assert.match(text, /\[SEC-001\] 安全\/high {2}src\/a\.ts:42/)
  assert.match(text, /问题: 令牌进了日志/)
  assert.match(text, /建议: 改记 tokenId/)
})

test('report 模式下非阻塞项单独列出且不增加阻塞计数', () => {
  const text = renderFindings({
    findings: [finding({ severity: 'nit', ruleId: 'MNT-002', dimension: 'maintainability' })],
    skipped: [],
    blockingSeverities: ['high', 'medium'],
    summary: { files: 1, added: 1, deleted: 0 },
  })
  assert.match(text, /结论: 需修改（0 处阻塞，1 处建议）/)
  assert.match(text, /\[MNT-002\] 可维护性\/nit/)
})

test('steer 模式只回注阻塞项；只有建议时返回空串', () => {
  const nit = finding({ severity: 'nit', ruleId: 'MNT-002', dimension: 'maintainability' })
  assert.equal(renderFindings({
    findings: [nit], skipped: [], blockingSeverities: ['high', 'medium'],
    summary: { files: 1, added: 1, deleted: 0 }, mode: 'steer',
  }), '')
  const blocked = renderFindings({
    findings: [finding(), nit], skipped: [], blockingSeverities: ['high', 'medium'],
    summary: { files: 1, added: 1, deleted: 0 }, mode: 'steer',
  })
  assert.match(blocked, /结论: 需修改（1 处阻塞）/)
  assert.doesNotMatch(blocked, /MNT-002/)
})

test('无 finding 时返回空串，让调用方决定不注入', () => {
  assert.equal(renderFindings({
    findings: [], skipped: [], blockingSeverities: ['high'], summary: { files: 1, added: 1, deleted: 0 },
  }), '')
})

test('未审文件带原因', () => {
  const text = renderFindings({
    findings: [finding()], skipped: [{ path: 'a.png', reason: 'binary' }, { path: 'b.js', reason: 'budget' }],
    blockingSeverities: ['high'], summary: { files: 2, added: 1, deleted: 1 },
  })
  assert.match(text, /未审: a\.png（binary）、b\.js（budget）/)
})

test('renderPass 给出规模', () => {
  assert.match(renderPass({ summary: { files: 3, added: 47, deleted: 2 } }), /结论: 通过（本次 3 文件 \/ 49 行变更）/)
})
