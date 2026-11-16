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

// ---------------------------------------------------------------------------
// T1：指令评论 + 其它评论进 round（只读采集，不影响轮次归属）
// ---------------------------------------------------------------------------

const gateBody = 'Sensitive Content Gate\n\n结论: 门禁通过\n\n扫描结果：共 15 条命中；历史豁免 15 条；当前有效 0 条。'

test('buildRound 输出 directives：有效指令 / invalid，且指令评论不被误判为评审或门禁', () => {
  const mr = { sha: SHA, head_pipeline: { created_at: '2026-11-13T09:59:00Z' } }
  const notes = [
    note({ id: 11, created_at: '2026-11-13T10:02:00Z' }),
    note({ id: 12, created_at: '2026-11-13T10:03:00Z', body: gateBody }),
    // 指令评论正文里顺带提到门禁 / 结论字样：它仍是普通评论，不是门禁或评审。
    note({
      id: 20,
      created_at: '2026-11-13T10:04:00Z',
      body: '#ai-waive a1b2c3d4 reason=Sensitive Content Gate 已人工确认\n\n结论: 需要修改（这条不是评审）',
    }),
    note({ id: 21, created_at: '2026-11-13T10:05:00Z', body: '#ai-waive abc reason=字段写错' }),
    note({ id: 22, created_at: '2026-11-13T10:06:00Z', body: '顺手补一个说明\n第二行' }),
  ]
  const round = buildRound({ mr, notes, cfg, observedAt: Date.parse('2026-11-13T10:10:00Z') })
  assert.equal(round.review.noteId, 11)
  assert.equal(round.sensitive.noteId, 12)
  assert.equal(round.mandatory, null)
  assert.deepEqual(round.dropped, [])
  assert.deepEqual(round.directives, {
    directives: [{
      kind: 'waive',
      fid: 'a1b2c3d4',
      reason: 'Sensitive Content Gate 已人工确认',
      noteId: 20,
      author: null,
      createdAt: '2026-11-13T10:04:00Z',
    }],
    invalid: { count: 1, samples: [{ noteId: 21, line: 1, why: 'invalid-fid' }] },
    truncated: { directives: 0, directiveNotes: 0, notes: 0, lines: 0 },
  })
  // 评论原文只存一份，不再每条指令复制整条 body（按 noteId 去重、有界）。
  assert.deepEqual(round.directiveNotes, [{
    noteId: 20,
    body: '#ai-waive a1b2c3d4 reason=Sensitive Content Gate 已人工确认 结论: 需要修改（这条不是评审）',
  }])
  assert.deepEqual(round.comments, [
    { noteId: 22, author: null, createdAt: '2026-11-13T10:06:00Z', excerpt: '顺手补一个说明 第二行' },
  ])
})

test('comments：最近 5 条（noteId 降序）、排除系统/评审/门禁/指令、excerpt 单行化 ≤120', () => {
  const mr = { sha: SHA, head_pipeline: { created_at: '2026-11-13T09:59:00Z' } }
  const human = (id) => note({ id, created_at: '2026-11-13T10:00:00Z', body: `c${id}` })
  const notes = [
    human(1), human(2), human(3), human(4), human(5), human(6), human(7),
    note({ id: 10, created_at: '2026-11-13T10:01:00Z' }), // 评审
    note({ id: 11, created_at: '2026-11-13T10:01:00Z', body: gateBody }), // 门禁
    note({ id: 12, created_at: '2026-11-13T10:01:00Z', body: '#ai-waive b2c3d4e5 reason=指令' }),
    note({ id: 13, created_at: '2026-11-13T10:01:00Z', system: true, body: '#ai-skip b2c3d4e5 reason=系统' }),
    note({ id: 14, created_at: '2026-11-13T10:01:00Z', body: '#ai-waive bad reason=无效指令也不当普通评论' }),
  ]
  const round = buildRound({ mr, notes, cfg, observedAt: Date.parse('2026-11-13T10:10:00Z') })
  assert.deepEqual(round.comments.map((item) => item.noteId), [7, 6, 5, 4, 3])

  const long = buildRound({
    mr,
    notes: [note({ id: 30, created_at: '2026-11-13T10:02:00Z', body: `${'x'.repeat(200)}\n第二行` })],
    cfg,
    observedAt: Date.parse('2026-11-13T10:10:00Z'),
  })
  assert.equal(long.comments.length, 1)
  assert.equal(long.comments[0].excerpt.length, 120)
  assert.equal(long.comments[0].excerpt.endsWith('…'), true)
  assert.doesNotMatch(long.comments[0].excerpt, /\n/)
})

test('无指令 / 无其它评论时 directives 与 comments 仍是稳定空结构', () => {
  const mr = { sha: SHA, head_pipeline: { created_at: '2026-11-13T09:59:00Z' } }
  const round = buildRound({ mr, notes: [note({ id: 11, created_at: '2026-11-13T10:02:00Z' })], cfg, observedAt: Date.parse('2026-11-13T10:10:00Z') })
  assert.deepEqual(round.directives, {
    directives: [],
    invalid: { count: 0, samples: [] },
    truncated: { directives: 0, directiveNotes: 0, notes: 0, lines: 0 },
  })
  assert.deepEqual(round.directiveNotes, [])
  assert.deepEqual(round.comments, [])
})

// ---------------------------------------------------------------------------
// I2：指令来源必须可信（评审 / 门禁正文、HTML 注释里的指令都不生效）
// 用真实评审 / 门禁正文包住指令行，确保它们没被误判成人类评论。
// ---------------------------------------------------------------------------

test('I2：评审 note 正文里的 #ai-* 指令不生效（不能自己豁免自己）', () => {
  const mr = { sha: SHA, head_pipeline: { created_at: '2026-11-13T09:59:00Z' } }
  const reviewWithDirective = [
    reviewBody(),
    '',
    '#ai-waive a1b2c3d4 reason=评审机器人自己写的豁免',
  ].join('\n')
  const round = buildRound({
    mr,
    notes: [note({ id: 11, created_at: '2026-11-13T10:02:00Z', body: reviewWithDirective })],
    cfg,
    observedAt: Date.parse('2026-11-13T10:10:00Z'),
  })
  assert.equal(round.review.noteId, 11)
  assert.deepEqual(round.directives.directives, [])
  assert.deepEqual(round.directives.invalid, { count: 0, samples: [] })
})

test('I2：敏感 / 必过门禁 note 正文里的 #ai-* 指令不生效', () => {
  const mr = { sha: SHA, head_pipeline: { created_at: '2026-11-13T09:59:00Z' } }
  const sensitive = `${gateBody}\n#ai-skip a1b2c3d4 reason=门禁自己写的`
  const mandatory = '必过项完整性检查\n\n结论：阻止合并\n\n敏感信息门禁：未通过；AI 代码评审：未通过；AI 评审证据检查：未通过\n#ai-waive b2c3d4e5 reason=门禁自己写的'
  const round = buildRound({
    mr,
    notes: [
      note({ id: 12, created_at: '2026-11-13T10:03:00Z', body: sensitive }),
      note({ id: 13, created_at: '2026-11-13T10:03:00Z', body: mandatory }),
    ],
    cfg,
    observedAt: Date.parse('2026-11-13T10:10:00Z'),
  })
  assert.equal(round.sensitive.noteId, 12)
  assert.equal(round.mandatory.noteId, 13)
  assert.deepEqual(round.directives.directives, [])
})

test('M1：HTML 注释里的指令不生效，评论按普通评论展示（只给可见正文）', () => {
  const mr = { sha: SHA, head_pipeline: { created_at: '2026-11-13T09:59:00Z' } }
  const hidden = ['<!--', '#ai-waive a1b2c3d4 reason=HTML 注释里', '-->', '正常说明'].join('\n')
  const round = buildRound({
    mr,
    notes: [note({ id: 30, created_at: '2026-11-13T10:02:00Z', body: hidden })],
    cfg,
    observedAt: Date.parse('2026-11-13T10:10:00Z'),
  })
  assert.deepEqual(round.directives.directives, [])
  assert.deepEqual(round.directives.invalid, { count: 0, samples: [] })
  // M1：HTML 注释里展示的指令不是指令，评论本身仍是普通评论；excerpt 只取可见正文。
  assert.deepEqual(round.comments, [{
    noteId: 30,
    author: null,
    createdAt: '2026-11-13T10:02:00Z',
    excerpt: '正常说明',
  }])
})

// ---------------------------------------------------------------------------
// C1：单轮 / 账本大小有界（1 万行垃圾评论、5 千条合法指令）
// ---------------------------------------------------------------------------

const recordOf = (round) => ({
  version: 1,
  binding: { projectPath: 'g/p', iid: 240 },
  rounds: [round],
  decisions: {},
  mergeableAt: null,
  terminal: null,
  paused: null,
  updatedAt: '2026-11-16T12:00:00Z',
})

test('C1：1 万行垃圾评论 → invalid 只有 count+5 样本，账本 JSON < 200KB', () => {
  const mr = { sha: SHA, head_pipeline: { created_at: '2026-11-13T09:59:00Z' } }
  const garbage = Array.from({ length: 10000 }, () => '#ai-waive x reason=垃圾').join('\n')
  const round = buildRound({
    mr,
    notes: [note({ id: 1, created_at: '2026-11-13T10:02:00Z', body: garbage })],
    cfg,
    observedAt: Date.parse('2026-11-13T10:10:00Z'),
  })
  assert.equal(round.directives.directives.length, 0)
  assert.equal(round.directives.invalid.samples.length, 5)
  assert.ok(round.directives.invalid.count > 0)
  assert.ok(JSON.stringify(recordOf(round)).length < 200 * 1024)
})

test('C1：5 千条合法指令 → directives ≤50、directiveNotes ≤20，单轮 JSON < 100KB', () => {
  const mr = { sha: SHA, head_pipeline: { created_at: '2026-11-13T09:59:00Z' } }
  const notes = Array.from({ length: 5000 }, (_, index) => note({
    id: index + 1,
    created_at: '2026-11-13T10:02:00Z',
    body: `#ai-waive fid${String(index + 1).padStart(4, '0')} reason=x`,
  }))
  const round = buildRound({ mr, notes, cfg, observedAt: Date.parse('2026-11-13T10:10:00Z') })
  assert.equal(round.directives.directives.length, 50)
  assert.equal(round.directiveNotes.length, 20)
  assert.equal(round.directives.truncated.directives, 4950)
  assert.ok(JSON.stringify(round).length < 100 * 1024)
})

// ---------------------------------------------------------------------------
// M1：围栏 / 引用里展示指令示例的正常评论不能被从 comments 里剔掉（且不留痕）
// ---------------------------------------------------------------------------
test('M1：围栏 / 引用 / 标题里展示指令示例的评论仍出现在 comments', () => {
  const mr = { sha: SHA, head_pipeline: { created_at: '2026-11-13T09:59:00Z' } }
  const notes = [
    note({
      id: 30,
      created_at: '2026-11-13T10:02:00Z',
      body: ['示例：', '```md', '#ai-waive a1b2c3d4 reason=代码块里的示例', '```', '正常说明'].join('\n'),
    }),
    note({
      id: 31,
      created_at: '2026-11-13T10:02:00Z',
      body: ['> #ai-waive b2c3d4e5 reason=引用别人的豁免', '我的回复'].join('\n'),
    }),
    note({
      id: 32,
      created_at: '2026-11-13T10:02:00Z',
      body: ['## 标题 #ai-skip c3d4e5f6 reason=标题里', '正文'].join('\n'),
    }),
  ]
  const round = buildRound({ mr, notes, cfg, observedAt: Date.parse('2026-11-13T10:10:00Z') })
  // 示例不是指令：既不生效，也不产生 invalid。
  assert.deepEqual(round.directives.directives, [])
  assert.deepEqual(round.directives.invalid, { count: 0, samples: [] })
  // 但它们是有内容的正常评论，必须能被主代理看到（noteId 降序）。
  assert.deepEqual(round.comments.map((item) => item.noteId), [32, 31, 30])
  const excerptOf = new Map(round.comments.map((item) => [item.noteId, item.excerpt]))
  assert.match(excerptOf.get(30), /#ai-waive a1b2c3d4 reason=代码块里的示例/)
  assert.match(excerptOf.get(31), /引用别人的豁免/)
  assert.match(excerptOf.get(32), /标题/)
})
