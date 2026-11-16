import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDirectives, hasDirectiveLine } from '../src/host/parse-directives.js'

const CREATED = '2026-11-16T10:00:00Z'
/** GitLab note 的最小形状：id / system / body / author.username / created_at。 */
const note = (id, body, over = {}) => ({
  id,
  system: false,
  body,
  author: { username: 'alice', name: 'Alice' },
  created_at: CREATED,
  ...over,
})

const ZERO_TRUNCATED = { directives: 0, directiveNotes: 0, notes: 0, lines: 0 }
const emptyInvalid = { count: 0, samples: [] }
const fidOf = (result) => result.directives.map((item) => item.fid)
const noteIdsOf = (result) => result.directives.map((item) => item.noteId)

test('三种 kind 都能解析：directive 只留结构化字段，评论原文进 directiveNotes', () => {
  const body = [
    '#ai-waive a1b2c3d4 reason=风险已评估，本次允许豁免',
    '#ai-skip b2c3d4e5 reason=不适用于当前场景',
    '#ai-wontfix c3d4e5f6 reason=问题存在但业务决定不修',
  ].join('\n')
  const result = parseDirectives([note(7, body)])
  assert.deepEqual(result.invalid, emptyInvalid)
  assert.deepEqual(result.truncated, ZERO_TRUNCATED)
  assert.deepEqual(result.directives, [
    { kind: 'waive', fid: 'a1b2c3d4', reason: '风险已评估，本次允许豁免', noteId: 7, author: 'alice', createdAt: CREATED },
    { kind: 'skip', fid: 'b2c3d4e5', reason: '不适用于当前场景', noteId: 7, author: 'alice', createdAt: CREATED },
    { kind: 'wontfix', fid: 'c3d4e5f6', reason: '问题存在但业务决定不修', noteId: 7, author: 'alice', createdAt: CREATED },
  ])
  // body 不再逐条复制：整条评论的单行化截断只存一份，按 noteId 去重。
  assert.deepEqual(result.directiveNotes, [{ noteId: 7, body: body.replace(/\n/g, ' ') }])
})

test('行首允许 0–3 个空格；4 个空格或 tab 开头的行不算指令', () => {
  const body = [
    '   #ai-waive a1b2c3d4 reason=三空格',
    '    #ai-skip b2c3d4e5 reason=四空格是缩进代码',
    '\t#ai-wontfix c3d4e5f6 reason=tab 也不算',
  ].join('\n')
  const result = parseDirectives([note(1, body)])
  assert.deepEqual(fidOf(result), ['a1b2c3d4'])
  // 被缩进代码上下文排除的行既不是指令、也不进 invalid：它们只是引用内容。
  assert.deepEqual(result.invalid, emptyInvalid)
})

test('引用行（>）不算指令，且不产生 invalid', () => {
  const body = [
    '> #ai-waive a1b2c3d4 reason=引用别人的豁免',
    '  > #ai-waive b2c3d4e5 reason=引用行前有空格',
  ].join('\n')
  const result = parseDirectives([note(1, body)])
  assert.deepEqual(result.directives, [])
  assert.deepEqual(result.invalid, emptyInvalid)
})

test('``` / ~~~ 围栏代码块内的行不算指令（含块内空行与闭合）', () => {
  const body = [
    '示例：',
    '```md',
    '#ai-waive a1b2c3d4 reason=代码块里的示例',
    '',
    '```',
    '~~~',
    '#ai-skip b2c3d4e5 reason=波浪围栏里也是示例',
    '~~~',
    '#ai-wontfix c3d4e5f6 reason=围栏外的才算',
  ].join('\n')
  const result = parseDirectives([note(1, body)])
  assert.deepEqual(fidOf(result), ['c3d4e5f6'])
})

test('Markdown 标题行不算指令（## 标题里顺带写指令）', () => {
  const body = [
    '## 处理说明 #ai-waive a1b2c3d4 reason=标题里的不算',
    '### 二级行 #ai-skip b2c3d4e5 reason=x',
    '正文 #ai-wontfix c3d4e5f6 reason=句中不算',
    '#ai-waive d4e5f6a7 reason=独立行才算',
  ].join('\n')
  const result = parseDirectives([note(1, body)])
  assert.deepEqual(fidOf(result), ['d4e5f6a7'])
})

test('reason 缺失 / 为空 → 只记 count，前 5 条进 samples', () => {
  const body = [
    '#ai-waive a1b2c3d4',
    '#ai-skip b2c3d4e5 reason=',
    '#ai-wontfix c3d4e5f6 reason=    ',
  ].join('\n')
  const result = parseDirectives([note(9, body)])
  assert.deepEqual(result.directives, [])
  assert.deepEqual(result.invalid, {
    count: 3,
    samples: [
      { noteId: 9, line: 1, why: 'missing-reason' },
      { noteId: 9, line: 2, why: 'empty-reason' },
      { noteId: 9, line: 3, why: 'empty-reason' },
    ],
  })
})

test('FID 非法 / 缺失 → invalid（先校验 FID，再校验 reason）', () => {
  const body = [
    '#ai-waive abc reason=太短',
    '#ai-waive !!bad reason=非法字符',
    '#ai-waive reason=没有 FID',
    '#ai-waive ' + 'a'.repeat(65) + ' reason=太长',
    '#ai-waive',
  ].join('\n')
  const result = parseDirectives([note(3, body)])
  assert.deepEqual(result.directives, [])
  assert.deepEqual(result.invalid, {
    count: 5,
    samples: [
      { noteId: 3, line: 1, why: 'invalid-fid' },
      { noteId: 3, line: 2, why: 'invalid-fid' },
      { noteId: 3, line: 3, why: 'invalid-fid' },
      { noteId: 3, line: 4, why: 'invalid-fid' },
      { noteId: 3, line: 5, why: 'invalid-fid' },
    ],
  })
})

test('invalid 只留前 5 条样本，count 是真实总数', () => {
  const body = Array.from({ length: 10 }, (_, index) => `#ai-waive x${index} reason=x`).join('\n')
  const result = parseDirectives([note(4, body)])
  assert.equal(result.invalid.count, 10)
  assert.equal(result.invalid.samples.length, 5)
  assert.deepEqual(result.invalid.samples[0], { noteId: 4, line: 1, why: 'invalid-fid' })
})

test('同一 FID 多条 → 取 note.id 最大的那条；跨 kind 也是最新说了算', () => {
  const notes = [
    note(12, '#ai-skip a1b2c3d4 reason=新说法'),
    note(10, '#ai-waive a1b2c3d4 reason=旧说法'),
    note(11, '#ai-wontfix b2c3d4e5 reason=另一条'),
  ]
  const result = parseDirectives(notes)
  assert.deepEqual(result.directives, [
    { kind: 'skip', fid: 'a1b2c3d4', reason: '新说法', noteId: 12, author: 'alice', createdAt: CREATED },
    { kind: 'wontfix', fid: 'b2c3d4e5', reason: '另一条', noteId: 11, author: 'alice', createdAt: CREATED },
  ])
  // 旧说法的评论原文不再保存：directiveNotes 只留最终生效的那条评论。
  assert.deepEqual(result.directiveNotes.map((item) => item.noteId), [12, 11])
})

test('同一条评论里同 FID 出现两次 → 后出现的行覆盖前一行', () => {
  const body = [
    '#ai-waive a1b2c3d4 reason=先写错了',
    '#ai-skip a1b2c3d4 reason=后来改成 skip',
  ].join('\n')
  const result = parseDirectives([note(4, body)])
  assert.equal(result.directives.length, 1)
  assert.equal(result.directives[0].kind, 'skip')
  assert.equal(result.directives[0].reason, '后来改成 skip')
  assert.equal(result.directiveNotes.length, 1) // 同一条评论只存一份 body
})

test('FID 大小写不敏感：大写 FID 接受，去重按大小写不敏感，输出保留原文', () => {
  const notes = [
    note(21, '#ai-waive ABCD1234 reason=旧'),
    note(22, '#ai-waive abcd1234 reason=新'),
  ]
  const result = parseDirectives(notes)
  assert.equal(result.directives.length, 1)
  assert.equal(result.directives[0].fid, 'abcd1234')
  assert.equal(result.directives[0].noteId, 22)
})

test('FID 容错：用户照抄评审里的 `FID` / **FID** / __FID__ 也能解析', () => {
  const body = [
    '#ai-waive `aaaaaaaaaa` reason=反引号',
    '#ai-skip **bbbbbbbbbb** reason=粗体',
    '#ai-wontfix __cccccccccc__ reason=下划线',
  ].join('\n')
  const result = parseDirectives([note(1, body)])
  assert.deepEqual(fidOf(result), ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'])
  assert.deepEqual(result.invalid, emptyInvalid)
})

test('reason 零宽字符不算内容；去掉零宽字符后可见文本保留', () => {
  const body = [
    '#ai-waive a1b2c3d4 reason=\u200b',
    '#ai-wontfix b2c3d4e5 reason=\u200b风险\u200b可控\u200b',
  ].join('\n')
  const result = parseDirectives([note(1, body)])
  assert.deepEqual(result.invalid, { count: 1, samples: [{ noteId: 1, line: 1, why: 'empty-reason' }] })
  assert.deepEqual(fidOf(result), ['b2c3d4e5'])
  assert.equal(result.directives[0].reason, '风险可控')
})

test('system note 完全不扫：不进 directives，也不进 invalid', () => {
  const notes = [
    note(1, '#ai-waive a1b2c3d4 reason=系统消息', { system: true }),
    note(2, '#ai-waive bad reason=x', { system: true }),
    note(3, '#ai-waive b2c3d4e5 reason=真人'),
  ]
  const result = parseDirectives(notes)
  assert.deepEqual(fidOf(result), ['b2c3d4e5'])
  assert.deepEqual(result.invalid, emptyInvalid)
})

test('kinds 只认指定类型：其余 #ai-* 行忽略，既不进 directives 也不进 invalid', () => {
  const body = [
    '#ai-waive a1b2c3d4 reason=不认',
    '#ai-skip b2c3d4e5 reason=认',
    '#ai-wontfix c3d4e5f6 reason=不认',
  ].join('\n')
  const result = parseDirectives([note(1, body)], { kinds: ['skip'] })
  assert.deepEqual(fidOf(result), ['b2c3d4e5'])
  assert.deepEqual(result.invalid, emptyInvalid)
})

test('reason 单行化（换行/控制符压空格）并截断到 200 字符', () => {
  const longReason = '风'.repeat(250)
  const result = parseDirectives([note(1, `#ai-waive a1b2c3d4 reason=${longReason}`)])
  const reason = result.directives[0].reason
  assert.equal(reason.length, 200)
  assert.equal(reason.endsWith('…'), true)

  const spaced = parseDirectives([note(1, '#ai-waive a1b2c3d4 reason=风险   可接受\t（已确认）')])
  assert.equal(spaced.directives[0].reason, '风险 可接受 （已确认）')
})

test('reason 里出现等号 / 中英文标点都原样保留', () => {
  const result = parseDirectives([note(1, '#ai-waive a1b2c3d4 reason=条件 a=b 时忽略，见 #123')])
  assert.equal(result.directives[0].reason, '条件 a=b 时忽略，见 #123')
})

test('HTML 注释（含多行注释 / AI_REVIEW_* 标记）里的指令不生效；注释外的照常生效', () => {
  const body = [
    '<!--',
    '#ai-waive a1b2c3d4 reason=注释里',
    '-->',
    '#ai-waive b2c3d4e5 reason=注释外',
    '<!-- AI_REVIEW_SHA ' + 'a'.repeat(40) + ' -->',
    '#ai-wontfix c3d4e5f6 reason=标记后面 <!-- 行内注释 --> 仍算',
  ].join('\n')
  const result = parseDirectives([note(1, body)])
  assert.deepEqual(fidOf(result), ['b2c3d4e5', 'c3d4e5f6'])
  assert.equal(result.directives[1].reason, '标记后面 仍算')
})

test('隐藏统计块（备注：以下隐藏数据仅用于统计）之后的内容不再扫描', () => {
  const body = [
    '#ai-waive a1b2c3d4 reason=块外',
    '> 备注：以下隐藏数据仅用于统计，请勿阅读该数据进行 Code Review。',
    '#ai-waive b2c3d4e5 reason=块内',
  ].join('\n')
  const result = parseDirectives([note(1, body)])
  assert.deepEqual(fidOf(result), ['a1b2c3d4'])
  assert.equal(result.directiveNotes[0].body, '#ai-waive a1b2c3d4 reason=块外')
})

test('directiveNotes body = 整条评论可见正文单行化截断（≤500 字符）', () => {
  const body = ['第一行说明', '', '#ai-waive a1b2c3d4 reason=x', '', '结尾'].join('\n')
  const result = parseDirectives([note(8, body)])
  assert.equal(result.directiveNotes.length, 1)
  assert.equal(result.directiveNotes[0].body, '第一行说明 #ai-waive a1b2c3d4 reason=x 结尾')

  const long = 'x'.repeat(600)
  const clipped = parseDirectives([note(8, `${long}\n#ai-waive a1b2c3d4 reason=x`)])
  assert.equal(clipped.directiveNotes[0].body.length, 500)
  assert.equal(clipped.directiveNotes[0].body.endsWith('…'), true)
})

test('单条评论行数上限：6000 行只扫前 5000 行，记 truncated', () => {
  const lines = [
    '#ai-waive a1b2c3d4 reason=第一行',
    '#ai-wontfix a1b2c3d4 reason=第二行覆盖',
    ...Array.from({ length: 5998 }, () => '正文'),
  ]
  const result = parseDirectives([note(1, lines.join('\n'))])
  assert.equal(result.directives.length, 1)
  assert.equal(result.directives[0].kind, 'wontfix')
  assert.deepEqual(result.truncated, { directives: 0, directiveNotes: 0, notes: 1, lines: 1000 })
})

test('单条评论字节上限：超过 200KB 只扫前缀，记 truncated', () => {
  const filler = Array.from({ length: 2000 }, () => 'x'.repeat(150))
  const body = ['#ai-waive a1b2c3d4 reason=前缀命令', ...filler].join('\n')
  assert.ok(Buffer.byteLength(body, 'utf8') > 200 * 1024)
  const result = parseDirectives([note(1, body)])
  assert.equal(result.directives.length, 1)
  assert.equal(result.truncated.notes, 1)
  assert.ok(result.truncated.lines > 0)
})

test('directives 上限 50 条：按 note.id 降序保留最新，超出的进 truncated', () => {
  const notes = Array.from({ length: 60 }, (_, index) => note(
    index + 1,
    `#ai-waive fid${String(index + 1).padStart(2, '0')}aaa reason=第 ${index + 1} 条`,
  ))
  const result = parseDirectives(notes)
  assert.equal(result.directives.length, 50)
  const keptIds = noteIdsOf(result).sort((left, right) => left - right)
  assert.deepEqual(keptIds, Array.from({ length: 50 }, (_, index) => index + 11)) // 11..60
  assert.equal(result.truncated.directives, 10)
})

test('directiveNotes 上限 20 条（按 noteId 去重、最新优先），超出的进 truncated', () => {
  const notes = Array.from({ length: 30 }, (_, index) => note(
    100 + index,
    `#ai-waive fid${String(index + 1).padStart(2, '0')}bbb reason=第 ${index + 1} 条`,
  ))
  const result = parseDirectives(notes)
  assert.equal(result.directives.length, 30)
  assert.equal(result.directiveNotes.length, 20)
  assert.deepEqual(result.directiveNotes.map((item) => item.noteId), Array.from({ length: 20 }, (_, index) => 129 - index))
  assert.equal(result.truncated.directiveNotes, 10)
  // 同一条评论多条指令只存一份 body。
  const sameNote = parseDirectives([note(1, ['#ai-waive a1b2c3d4 reason=a', '#ai-skip b2c3d4e5 reason=b'].join('\n'))])
  assert.equal(sameNote.directiveNotes.length, 1)
})

test('directives 顺序稳定：按 FID 升序（大小写不敏感）；directiveNotes 按 noteId 降序', () => {
  const notes = [
    note(1, ['#ai-waive zzzz1111 reason=z', '#ai-skip aaaa2222 reason=a'].join('\n')),
    note(2, ['#ai-wontfix mmmm3333 reason=m', '#ai-waive BBBB4444 reason=b'].join('\n')),
  ]
  const result = parseDirectives(notes)
  assert.deepEqual(result.directives.map((item) => item.fid), ['aaaa2222', 'BBBB4444', 'mmmm3333', 'zzzz1111'])
  assert.deepEqual(result.directiveNotes.map((item) => item.noteId), [2, 1])
})

test('author 回落顺序：username → name → null；createdAt 缺失为 null', () => {
  const notes = [
    note(1, '#ai-waive a1b2c3d4 reason=x', { author: { name: 'Bob' }, created_at: undefined }),
    note(2, '#ai-skip b2c3d4e5 reason=x', { author: undefined }),
  ]
  const result = parseDirectives(notes)
  assert.equal(result.directives[0].author, 'Bob')
  assert.equal(result.directives[0].createdAt, null)
  assert.equal(result.directives[1].author, null)
})

test('空输入 / null / 非对象 note：返回稳定空结构，不抛', () => {
  const empty = { directives: [], directiveNotes: [], invalid: emptyInvalid, truncated: ZERO_TRUNCATED }
  assert.deepEqual(parseDirectives([]), empty)
  assert.deepEqual(parseDirectives(null), empty)
  assert.deepEqual(parseDirectives(undefined), empty)
  assert.deepEqual(parseDirectives([null, 42, 'x']), empty)
})

test('C1：1 万行垃圾评论只留 count + 5 样本，解析结果 JSON 有界', () => {
  const body = Array.from({ length: 10000 }, () => '#ai-waive x reason=垃圾').join('\n')
  const result = parseDirectives([note(1, body)])
  // 1 万行 > 5000 行上限：只扫前 5000 行，每行都 invalid，但不逐条保存。
  assert.equal(result.invalid.count, 5000)
  assert.equal(result.invalid.samples.length, 5)
  assert.equal(result.directives.length, 0)
  assert.deepEqual(result.truncated, { directives: 0, directiveNotes: 0, notes: 1, lines: 5000 })
  assert.ok(JSON.stringify(result).length < 100 * 1024)
})

test('C1：5 千条合法指令被 cap 到 50 条 / 20 条评论，解析结果 JSON 有界', () => {
  const notes = Array.from({ length: 5000 }, (_, index) => note(
    index + 1,
    `#ai-waive fid${String(index + 1).padStart(4, '0')} reason=x`,
  ))
  const result = parseDirectives(notes)
  assert.equal(result.directives.length, 50)
  assert.equal(result.directiveNotes.length, 20)
  assert.equal(result.truncated.directives, 4950)
  assert.ok(JSON.stringify(result).length < 100 * 1024)
})

// ---------------------------------------------------------------------------
// M1：hasDirectiveLine 与 parseDirectives 共用「真正会被扫描的行」口径，
// 围栏 / 引用 / HTML 注释 / 隐藏统计块里展示的指令示例不算指令评论。
// ---------------------------------------------------------------------------
test('M1 hasDirectiveLine：围栏 / 引用 / HTML 注释 / 隐藏统计块里的指令示例不算指令评论', () => {
  const examples = [
    '```md\n#ai-waive a1b2c3d4 reason=代码块示例\n```',
    '~~~\n#ai-skip b2c3d4e5 reason=波浪围栏示例\n~~~',
    '> #ai-waive a1b2c3d4 reason=引用别人的豁免',
    '  > #ai-waive a1b2c3d4 reason=引用行前有空格',
    '<!--\n#ai-waive a1b2c3d4 reason=HTML 注释里\n-->',
    '正常说明\n\n> 备注：以下隐藏数据仅用于统计\n#ai-waive a1b2c3d4 reason=隐藏块里',
    '示例：\n```\n#ai-wontfix c3d4e5f6 reason=缩进无关\n```\n正常收尾',
  ]
  for (const body of examples) assert.equal(hasDirectiveLine(body), false, body)

  // 围栏外真实出现的指令行（哪怕格式不合法）仍是指令评论：无效指令不能混进普通评论。
  assert.equal(hasDirectiveLine('#ai-waive a1b2c3d4 reason=x'), true)
  assert.equal(hasDirectiveLine('正常说明\n#ai-waive bad reason='), true)
  assert.equal(hasDirectiveLine('正文里提一嘴 #ai-waive a1b2c3d4 reason=x'), false)
  assert.equal(hasDirectiveLine(undefined), false)
  assert.equal(hasDirectiveLine(null), false)
})
