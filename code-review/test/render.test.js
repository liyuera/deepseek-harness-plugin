import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyFindings, partition, renderFindings, renderPass } from '../src/host/render.js'

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

test('notify 模式只列非阻塞建议，结论为通过且不要求修复', () => {
  const text = renderFindings({
    findings: [finding({ severity: 'low', ruleId: 'MNT-004', dimension: 'maintainability', location: 'src/b.ts:9' })],
    skipped: [],
    blockingSeverities: ['high', 'medium'],
    notifySeverities: ['low', 'nit'],
    summary: { files: 1, added: 2, deleted: 1 },
    mode: 'notify',
  })
  assert.match(text, /结论: 通过（1 处建议）/)
  assert.doesNotMatch(text, /需修改/)
  assert.match(text, /\[MNT-004\] 可维护性\/low {2}src\/b\.ts:9/)
})

test('notify 模式的空清单/不匹配 severity 返回空串', () => {
  const low = finding({ severity: 'low', ruleId: 'MNT-004', dimension: 'maintainability' })
  const base = {
    skipped: [], blockingSeverities: ['high', 'medium'],
    summary: { files: 1, added: 1, deleted: 0 }, mode: 'notify',
  }
  assert.equal(renderFindings({ ...base, findings: [low], notifySeverities: [] }), '')
  assert.equal(renderFindings({ ...base, findings: [low], notifySeverities: ['nit'] }), '')
  assert.equal(renderFindings({ ...base, findings: [finding()], notifySeverities: ['low', 'nit'] }), '')
})

test('steer 模式在配置 notifySeverities 时附带非阻塞建议段', () => {
  const text = renderFindings({
    findings: [finding(), finding({ severity: 'low', ruleId: 'MNT-004', dimension: 'maintainability' })],
    skipped: [],
    blockingSeverities: ['high', 'medium'],
    notifySeverities: ['low'],
    summary: { files: 1, added: 3, deleted: 0 },
    mode: 'steer',
  })
  assert.match(text, /结论: 需修改（1 处阻塞，1 处建议）/)
  assert.match(text, /非阻塞建议:/)
  assert.match(text, /\[MNT-004\]/)
})

test('behavior 维度渲染为「行为」', () => {
  const text = renderFindings({
    findings: [finding({ ruleId: 'BEH-001', dimension: 'behavior', severity: 'low', location: 'a.ts:1' })],
    skipped: [],
    blockingSeverities: ['high', 'medium'],
    notifySeverities: ['low'],
    summary: { files: 1, added: 1, deleted: 0 },
    mode: 'notify',
  })
  assert.match(text, /\[BEH-001\] 行为\/low {2}a\.ts:1/)
})

test('steer 模式未配置 notifySeverities 时仍只回注阻塞项', () => {
  const text = renderFindings({
    findings: [finding(), finding({ severity: 'low', ruleId: 'MNT-004', dimension: 'maintainability' })],
    skipped: [],
    blockingSeverities: ['high', 'medium'],
    summary: { files: 1, added: 3, deleted: 0 },
    mode: 'steer',
  })
  assert.match(text, /结论: 需修改（1 处阻塞）/)
  assert.doesNotMatch(text, /非阻塞建议/)
  assert.doesNotMatch(text, /MNT-004/)
})

test('classifyFindings 按 blocking/fixMode/复验状态分桶', () => {
  const buckets = classifyFindings([
    finding({ fixMode: 'auto' }),
    finding({ severity: 'medium', fixMode: 'manual' }),
    finding({ severity: 'medium', verified: 'unverified' }),
    finding({ severity: 'medium', evidenceStatus: 'mismatch' }),
    finding({ severity: 'low' }),
    finding({ severity: 'high', blocking: false }),
  ], ['high', 'medium'])
  assert.equal(buckets.auto.length, 1)
  assert.equal(buckets.manual.length, 1)
  assert.equal(buckets.unverified.length, 2)
  assert.equal(buckets.passive.length, 2)
})

test('report 渲染人工确认/未复验/抑制/覆盖分区与结论', () => {
  const text = renderFindings({
    findings: [
      finding({ fixMode: 'manual', location: 'src/generated/api.ts:1' }),
      finding({ severity: 'medium', verified: 'unverified', location: 'src/a.ts:3' }),
    ],
    skipped: [],
    blockingSeverities: ['high', 'medium'],
    summary: { files: 1, added: 2, deleted: 0 },
    coverage: { valid: true, missing: false, reviewed: 1, skipped: 0, unaccounted: 0 },
    suppressed: [{ finding: finding({ severity: 'low', ruleId: 'BEH-001', location: 'src/a.ts:9' }), reason: '产品决策' }],
  })
  assert.match(text, /结论: 需人工确认（1 处人工确认，1 处未复验）/)
  assert.match(text, /需人工确认（不要自动修改）:/)
  assert.match(text, /\[人工\] \[SEC-001\]/)
  assert.match(text, /仅报告（未复验\/证据不足，不要据此修复）:/)
  assert.match(text, /\[未复验\] \[SEC-001\]/)
  assert.match(text, /覆盖: 已审 1\/1/)
  assert.match(text, /已抑制（人工裁决，不再报告）: \[BEH-001\] src\/a\.ts:9（产品决策）/)
  assert.doesNotMatch(text, /请按上面/)
})

test('respectFixPolicy=false 时 manual 项回到自动修复桶', () => {
  const text = renderFindings({
    findings: [finding({ fixMode: 'manual' })],
    skipped: [],
    blockingSeverities: ['high', 'medium'],
    summary: { files: 1, added: 1, deleted: 0 },
    respectFixPolicy: false,
  })
  assert.match(text, /结论: 需修改（1 处阻塞）/)
  assert.doesNotMatch(text, /人工确认/)
})
