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

test('passive-only 时结论为通过并列出建议', () => {
  const text = renderFindings({
    findings: [finding({ severity: 'nit', ruleId: 'MNT-002', dimension: 'maintainability' })],
    skipped: [],
    blockingSeverities: ['high', 'medium'],
    summary: { files: 1, added: 1, deleted: 0 },
  })
  assert.match(text, /结论: 通过（1 处建议）/)
  assert.doesNotMatch(text, /需修改/)
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

test('渲染前按 severity 排名排序：阻塞 high→medium，建议 low→nit', () => {
  const text = renderFindings({
    findings: [
      finding({ severity: 'nit', ruleId: 'MNT-002', dimension: 'maintainability', location: 'src/a.ts:4' }),
      finding({ severity: 'medium', ruleId: 'COR-001', dimension: 'correctness', location: 'src/a.ts:2' }),
      finding({ severity: 'low', ruleId: 'MNT-001', dimension: 'maintainability', location: 'src/a.ts:3' }),
      finding({ severity: 'high', ruleId: 'SEC-001', location: 'src/a.ts:1' }),
    ],
    skipped: [],
    blockingSeverities: ['high', 'medium'],
    summary: { files: 1, added: 4, deleted: 0 },
  })
  const order = ['[SEC-001]', '[COR-001]', '[MNT-001]', '[MNT-002]'].map((id) => text.indexOf(id))
  assert.ok(order.every((index) => index >= 0), text)
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
})

test('同 severity 的 finding 保持输入顺序', () => {
  const text = renderFindings({
    findings: [
      finding({ severity: 'medium', ruleId: 'MNT-001', dimension: 'maintainability', location: 'src/a.ts:3' }),
      finding({ severity: 'high', ruleId: 'COR-001', dimension: 'correctness', location: 'src/a.ts:2' }),
      finding({ severity: 'high', ruleId: 'SEC-001', location: 'src/a.ts:1' }),
    ],
    skipped: [],
    blockingSeverities: ['high', 'medium'],
    summary: { files: 1, added: 3, deleted: 0 },
  })
  const cor = text.indexOf('[COR-001]')
  const sec = text.indexOf('[SEC-001]')
  const mnt = text.indexOf('[MNT-001]')
  assert.ok(cor >= 0 && sec >= 0 && mnt >= 0, text)
  assert.ok(cor < sec, '同为 high 时保持输入顺序 COR-001 在 SEC-001 前')
  assert.ok(sec < mnt, 'high 应排在 medium 前')
})

test('renderPass 带未审清单与原因', () => {
  const text = renderPass({
    summary: { files: 2, added: 3, deleted: 1 },
    skipped: [{ path: 'a.md', reason: 'not-code' }, { path: 'b.png', reason: 'binary' }],
  })
  assert.match(text, /结论: 通过（本次 2 文件 \/ 4 行变更）/)
  assert.match(text, /未审: a\.md（not-code）、b\.png（binary）/)
  assert.equal(renderPass({ summary: { files: 1, added: 0, deleted: 0 } }).includes('未审'), false)
})
