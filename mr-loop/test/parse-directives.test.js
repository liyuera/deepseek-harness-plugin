import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDirectives } from '../src/host/parse-directives.js'

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

const fidOf = (result) => result.directives.map((item) => item.fid)

test('三种 kind 都能解析：字段形状固定（kind/fid/reason/noteId/author/createdAt/body）', () => {
  const body = [
    '#ai-waive a1b2c3d4 reason=风险已评估，本次允许豁免',
    '#ai-skip b2c3d4e5 reason=不适用于当前场景',
    '#ai-wontfix c3d4e5f6 reason=问题存在但业务决定不修',
  ].join('\n')
  const result = parseDirectives([note(7, body)])
  assert.deepEqual(result.invalid, [])
  // body = 整条评论正文的单行化截断（UI 展示评论原文用）。
  const oneLine = body.replace(/\n/g, ' ')
  assert.deepEqual(result.directives, [
    {
      kind: 'waive',
      fid: 'a1b2c3d4',
      reason: '风险已评估，本次允许豁免',
      noteId: 7,
      author: 'alice',
      createdAt: CREATED,
      body: oneLine,
    },
    { kind: 'skip', fid: 'b2c3d4e5', reason: '不适用于当前场景', noteId: 7, author: 'alice', createdAt: CREATED, body: oneLine },
    { kind: 'wontfix', fid: 'c3d4e5f6', reason: '问题存在但业务决定不修', noteId: 7, author: 'alice', createdAt: CREATED, body: oneLine },
  ])
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
  assert.deepEqual(result.invalid, [])
})

test('引用行（>）不算指令，且不产生 invalid', () => {
  const body = [
    '> #ai-waive a1b2c3d4 reason=引用别人的豁免',
    '  > #ai-waive b2c3d4e5 reason=引用行前有空格',
  ].join('\n')
  assert.deepEqual(parseDirectives([note(1, body)]), { directives: [], invalid: [] })
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

test('reason 缺失 / 为空 → invalid，且注明行号与原因', () => {
  const body = [
    '#ai-waive a1b2c3d4',
    '#ai-skip b2c3d4e5 reason=',
    '#ai-wontfix c3d4e5f6 reason=    ',
  ].join('\n')
  const result = parseDirectives([note(9, body)])
  assert.deepEqual(result.directives, [])
  assert.deepEqual(result.invalid, [
    { noteId: 9, line: 1, why: 'missing-reason' },
    { noteId: 9, line: 2, why: 'empty-reason' },
    { noteId: 9, line: 3, why: 'empty-reason' },
  ])
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
  assert.deepEqual(result.invalid, [
    { noteId: 3, line: 1, why: 'invalid-fid' },
    { noteId: 3, line: 2, why: 'invalid-fid' },
    { noteId: 3, line: 3, why: 'invalid-fid' },
    { noteId: 3, line: 4, why: 'invalid-fid' },
    { noteId: 3, line: 5, why: 'invalid-fid' },
  ])
})

test('同一 FID 多条 → 取 note.id 最大的那条；跨 kind 也是最新说了算', () => {
  const notes = [
    note(12, '#ai-skip a1b2c3d4 reason=新说法'),
    note(10, '#ai-waive a1b2c3d4 reason=旧说法'),
    note(11, '#ai-wontfix b2c3d4e5 reason=另一条'),
  ]
  const result = parseDirectives(notes)
  assert.deepEqual(result.directives, [
    { kind: 'skip', fid: 'a1b2c3d4', reason: '新说法', noteId: 12, author: 'alice', createdAt: CREATED, body: '#ai-skip a1b2c3d4 reason=新说法' },
    { kind: 'wontfix', fid: 'b2c3d4e5', reason: '另一条', noteId: 11, author: 'alice', createdAt: CREATED, body: '#ai-wontfix b2c3d4e5 reason=另一条' },
  ])
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

test('system note 完全不扫：不进 directives，也不进 invalid', () => {
  const notes = [
    note(1, '#ai-waive a1b2c3d4 reason=系统消息', { system: true }),
    note(2, '#ai-waive bad reason=x', { system: true }),
    note(3, '#ai-waive b2c3d4e5 reason=真人'),
  ]
  const result = parseDirectives(notes)
  assert.deepEqual(fidOf(result), ['b2c3d4e5'])
  assert.deepEqual(result.invalid, [])
})

test('kinds 只认指定类型：其余 #ai-* 行忽略，既不进 directives 也不进 invalid', () => {
  const body = [
    '#ai-waive a1b2c3d4 reason=不认',
    '#ai-skip b2c3d4e5 reason=认',
    '#ai-wontfix c3d4e5f6 reason=不认',
  ].join('\n')
  const result = parseDirectives([note(1, body)], { kinds: ['skip'] })
  assert.deepEqual(fidOf(result), ['b2c3d4e5'])
  assert.deepEqual(result.invalid, [])
})

test('reason 单行化（换行/控制符压空格）并截断到 200 字符', () => {
  const longReason = '风'.repeat(250)
  const result = parseDirectives([note(1, `#ai-waive a1b2c3d4 reason=${longReason}`)])
  const reason = result.directives[0].reason
  assert.equal(reason.length, 200)
  assert.equal(reason.endsWith('…'), true)
  assert.equal(reason.startsWith('风'.repeat(199)), true)

  const spaced = parseDirectives([note(1, '#ai-waive a1b2c3d4 reason=风险   可接受\t（已确认）')])
  assert.equal(spaced.directives[0].reason, '风险 可接受 （已确认）')
})

test('reason 里出现等号 / 中英文标点都原样保留', () => {
  const result = parseDirectives([note(1, '#ai-waive a1b2c3d4 reason=条件 a=b 时忽略，见 #123')])
  assert.equal(result.directives[0].reason, '条件 a=b 时忽略，见 #123')
})

test('body = 整条评论正文的单行化截断（≤500 字符），不是命中行', () => {
  const body = ['第一行说明', '', '#ai-waive a1b2c3d4 reason=x', '', '结尾'].join('\n')
  const result = parseDirectives([note(8, body)])
  assert.equal(result.directives[0].body, '第一行说明 #ai-waive a1b2c3d4 reason=x 结尾')

  const long = 'x'.repeat(600)
  const clipped = parseDirectives([note(8, `${long}\n#ai-waive a1b2c3d4 reason=x`)])
  assert.equal(clipped.directives[0].body.length, 500)
  assert.equal(clipped.directives[0].body.endsWith('…'), true)
})

test('directives 顺序稳定：按 FID 升序（大小写不敏感），与输入顺序无关', () => {
  const notes = [
    note(1, ['#ai-waive zzzz1111 reason=z', '#ai-skip aaaa2222 reason=a'].join('\n')),
    note(2, ['#ai-wontfix mmmm3333 reason=m', '#ai-waive BBBB4444 reason=b'].join('\n')),
  ]
  const result = parseDirectives(notes)
  assert.deepEqual(result.directives.map((item) => item.fid), ['aaaa2222', 'BBBB4444', 'mmmm3333', 'zzzz1111'])
})

test('invalid 顺序 = 扫描顺序（notes 输入顺序 + 行号升序），行号 1 起', () => {
  const notes = [
    note(5, ['#ai-waive bad reason=x', '', '#ai-waive a1b2c3d4'].join('\n')),
    note(6, '#ai-skip b2c3d4e5 reason='),
  ]
  const result = parseDirectives(notes)
  assert.deepEqual(result.invalid, [
    { noteId: 5, line: 1, why: 'invalid-fid' },
    { noteId: 5, line: 3, why: 'missing-reason' },
    { noteId: 6, line: 1, why: 'empty-reason' },
  ])
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

test('空输入 / null / 非对象 note：返回空结果，不抛', () => {
  assert.deepEqual(parseDirectives([]), { directives: [], invalid: [] })
  assert.deepEqual(parseDirectives(null), { directives: [], invalid: [] })
  assert.deepEqual(parseDirectives(undefined), { directives: [], invalid: [] })
  assert.deepEqual(parseDirectives([null, 42, 'x']), { directives: [], invalid: [] })
})
