import test from 'node:test'
import assert from 'node:assert/strict'
import { baselineOf, classifyReviewNote, reviewShaOf, buildRound } from '../src/host/rounds.js'
import { resolveConfig } from '../src/host/config.js'

const cfg = resolveConfig({})
const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const reviewBody = (extra = '') => `## AI Code Review (feat-x -> feature-y)\n\n结论: **可直接合并**\n\n历史未收敛: \`0\` 条\n\n未发现必须修改的代码问题。\n${extra}`
const note = (over = {}) => ({ id: 1, system: false, body: reviewBody(), created_at: '2026-11-13T10:00:00Z', ...over })

test('baselineOf 取 head_pipeline.created_at，缺失为 0', () => {
  assert.equal(baselineOf({ head_pipeline: { created_at: '2026-11-13T10:00:00Z' } }), Date.parse('2026-11-13T10:00:00Z'))
  assert.equal(baselineOf({}), 0)
  assert.equal(baselineOf({ head_pipeline: { created_at: 'garbage' } }), 0)
})

test('reviewShaOf 只认隐藏注释', () => {
  assert.equal(reviewShaOf(`x\n<!-- AI_REVIEW_SHA ${SHA} -->\n`), SHA)
  assert.equal(reviewShaOf('AI_REVIEW_SHA abc'), null)
})

test('强绑定：标记等于当前 sha（支持短 sha 前缀）', () => {
  const withMarker = note({ body: reviewBody(`\n<!-- AI_REVIEW_SHA ${SHA} -->`) })
  assert.deepEqual(classifyReviewNote({ note: withMarker, sha: SHA, baselineAt: 0, cfg }), { binding: 'strong' })
  const short = note({ body: reviewBody(`\n<!-- AI_REVIEW_SHA ${SHA.slice(0, 8)} -->`) })
  assert.deepEqual(classifyReviewNote({ note: short, sha: SHA, baselineAt: 0, cfg }), { binding: 'strong' })
  // 空 / 缺失的当前 sha 不能靠 `marker.startsWith('')` 匹配上：那不是证据，是 fail-open。
  assert.equal(classifyReviewNote({ note: withMarker, sha: '', baselineAt: 0, cfg }).stale, true)
  assert.equal(classifyReviewNote({ note: withMarker, sha: undefined, baselineAt: 0, cfg }).stale, true)
})

test('标记指向别的 sha → stale', () => {
  const old = note({ body: reviewBody(`\n<!-- AI_REVIEW_SHA ${OTHER} -->`) })
  assert.equal(classifyReviewNote({ note: old, sha: SHA, baselineAt: 0, cfg }).stale, true)
})

test('无标记：晚于基线 → weak；早于基线 → stale', () => {
  const baseline = Date.parse('2026-11-13T09:59:00Z')
  assert.deepEqual(classifyReviewNote({ note: note(), sha: SHA, baselineAt: baseline, cfg }), { binding: 'weak' })
  const old = note({ created_at: '2026-11-13T09:00:00Z' })
  assert.equal(classifyReviewNote({ note: old, sha: SHA, baselineAt: baseline, cfg }).stale, true)
})

test('人话里提到评审标题不算评审', () => {
  const mr = { sha: SHA, head_pipeline: { created_at: '2026-11-13T09:59:00Z' } }
  const mention = note({
    id: 30,
    created_at: '2026-11-13T10:20:00Z',
    body: '注意到 AI Code Review (feat-x) 的结论\n\n结论: 这条不用改',
  })
  const real = note({ id: 11, created_at: '2026-11-13T10:02:00Z' })
  const round = buildRound({ mr, notes: [mention, real], cfg, observedAt: Date.parse('2026-11-13T10:10:00Z') })
  assert.equal(round.review.noteId, 11)
  assert.equal(round.dropped.some((item) => item.noteId === 30 && item.detail === 'title-mismatch'), true)
})

test('没有基线时不做弱绑定，旧门禁也不算本轮', () => {
  const mr = { sha: SHA }
  const oldGate = note({
    id: 5,
    created_at: '2020-01-01T00:00:00Z',
    body: 'Sensitive Content Gate\n\n结论: 门禁通过\n\n扫描结果：共 15 条命中；历史豁免 15 条；当前有效 0 条。',
  })
  const round = buildRound({ mr, notes: [note(), oldGate], cfg, observedAt: undefined })
  assert.equal(round.baselineAt, null)
  assert.equal(round.review, null)
  assert.equal(round.sensitive, null)
  assert.equal(round.dropped.some((item) => item.noteId === 5 && item.reason === 'stale'), true)
  assert.equal(round.dropped.some((item) => item.detail === 'no-baseline'), true)
})

test('人引用门禁文本不算门禁 note', () => {
  const mr = { sha: SHA, head_pipeline: { created_at: '2026-11-13T09:59:00Z' } }
  const quoted = note({
    id: 20,
    created_at: '2026-11-13T10:20:00Z',
    body: '> Sensitive Content Gate\n>\n> 结论: 门禁通过\n>\n> 扫描结果：共 15 条命中；历史豁免 15 条；当前有效 0 条。',
  })
  const real = note({
    id: 12,
    created_at: '2026-11-13T10:05:00Z',
    body: 'Sensitive Content Gate\n\n结论: 门禁通过\n\n扫描结果：共 15 条命中；历史豁免 15 条；当前有效 0 条。',
  })
  const round = buildRound({ mr, notes: [quoted, real], cfg, observedAt: Date.parse('2026-11-13T10:10:00Z') })
  assert.equal(round.sensitive.noteId, 12)
  assert.equal(round.sensitive.verdict, 'pass')
})

test('4 空格缩进的门禁引用不算门禁 note；0–3 空格仍接受', () => {
  const mr = { sha: SHA, head_pipeline: { created_at: '2026-11-13T09:59:00Z' } }
  const gateBody = (firstLine) => [
    firstLine,
    '',
    '结论: 门禁通过',
    '',
    '扫描结果：共 15 条命中；历史豁免 15 条；当前有效 0 条。',
  ].join('\n')
  // 4 空格 = CommonMark 缩进代码块：看起来像门禁，但只是引用/粘贴，不能当结论。
  const indented4 = note({ id: 41, created_at: '2026-11-13T10:21:00Z', body: gateBody('    ## Sensitive Content Gate') })
  const accepted3 = note({ id: 40, created_at: '2026-11-13T10:20:00Z', body: gateBody('   ## Sensitive Content Gate') })
  const observedAt = Date.parse('2026-11-13T10:30:00Z')

  const onlyIndented = buildRound({ mr, notes: [indented4], cfg, observedAt })
  assert.equal(onlyIndented.sensitive, null)

  // id 更大的缩进 note 若被误收，会顶掉真正的那条：用它做判别性断言。
  const round = buildRound({ mr, notes: [indented4, accepted3], cfg, observedAt })
  assert.equal(round.sensitive.noteId, 40)
  assert.equal(round.sensitive.verdict, 'pass')
})

test('buildRound：最新一条评审 + 三套门禁 + stale 入 dropped', () => {
  const mr = { sha: SHA, head_pipeline: { created_at: '2026-11-13T09:59:00Z' } }
  const notes = [
    note({ id: 10, body: reviewBody(`\n<!-- AI_REVIEW_SHA ${OTHER} -->`), created_at: '2026-11-13T10:30:00Z' }),
    note({ id: 11, created_at: '2026-11-13T10:02:00Z' }),
    note({ id: 12, created_at: '2026-11-13T10:05:00Z', body: 'Sensitive Content Gate\n\n结论: 门禁通过\n\n扫描结果：共 15 条命中；历史豁免 15 条；当前有效 0 条。' }),
    note({ id: 13, created_at: '2026-11-13T10:01:00Z', body: '必过项完整性检查\n\n结论：阻止合并\n\n敏感信息门禁：未通过；AI 代码评审：未通过；AI 评审证据检查：未通过' }),
    note({ id: 14, system: true, body: 'added 1 commit' }),
  ]
  const round = buildRound({ mr, notes, cfg, observedAt: Date.parse('2026-11-13T10:10:00Z') })
  assert.equal(round.review.noteId, 11) // 11 是最新的 review note
  assert.equal(round.review.verdict, 'pass')
  assert.equal(round.review.binding, 'weak')
  assert.equal(round.sensitive.noteId, 12)
  assert.equal(round.sensitive.verdict, 'pass')
  assert.equal(round.mandatory.verdict, 'block')
  assert.equal(round.dropped.length, 1)
  assert.equal(round.dropped[0].noteId, 10)
  assert.equal(round.dropped[0].reason, 'stale')
  assert.equal(round.binding, 'weak')
})

test('reviewMarker 贯通 buildRound：自定义标记的 note 才解析出结论', () => {
  const mr = { sha: SHA, head_pipeline: { created_at: '2026-11-13T09:59:00Z' } }
  // 强绑定（带 sha 注释），把 reviewMarker 的影响与标题前缀解耦。
  const body = `## AI Review (feat-x -> feature-y)\n\n结论: **可直接合并**\n\n历史未收敛: \`0\` 条\n\n<!-- AI_REVIEW_SHA ${SHA} -->`
  const custom = note({ id: 51, body, created_at: '2026-11-13T10:02:00Z' })
  const observedAt = Date.parse('2026-11-13T10:10:00Z')

  const withMarker = buildRound({ mr, notes: [custom], cfg: resolveConfig({ reviewMarker: 'AI Review' }), observedAt })
  assert.equal(withMarker.binding, 'strong')
  assert.equal(withMarker.review.verdict, 'pass')

  // 默认标记下这条 note 根本不是评审，无法解析出结论。
  const withDefault = buildRound({ mr, notes: [custom], cfg, observedAt })
  assert.equal(withDefault.review, null)
})
