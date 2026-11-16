import test from 'node:test'
import assert from 'node:assert/strict'
import { createTools } from '../src/host/tools.js'

const exec = { agent: { session: { id: 's1', header: { cwd: '/repo' } } }, signal: undefined }

function fakeService(over = {}) {
  return {
    bind: async ({ sessionId, url, repoRoot }) => ({ report: `REPORT ${sessionId} ${url} ${repoRoot}`, warnings: [] }),
    status: async ({ sessionId }) => ({ report: `STATUS ${sessionId}`, state: { binding: { iid: 240 }, mr: { sha: 'abc' }, round: { n: 2 }, decisions: {}, mergeability: { mergeable: false, missing: [], degraded: false }, paused: null } }),
    review: ({ sessionId }) => ({ round: { sha: 'abc', n: 2 }, decisions: {} }),
    stop: async () => ({ stopped: true, forgotten: false }),
    resume: () => ({ sha: 'abc' }),
    waiverDraft: ({ fid, kind, reason }) => ({ body: `#ai-${kind ?? 'waive'} ${fid} reason=${reason}`, fid, kind: kind ?? 'waive', reason, mrLabel: 'MR !240 · g/p' }),
    postWaiver: async ({ fid, kind, reason }) => ({ posted: true, noteId: 901, url: 'https://git.x.com/g/p/-/merge_requests/240#note_901', body: `#ai-${kind ?? 'waive'} ${fid} reason=${reason}` }),
    ...over,
  }
}

const byName = (tools, name) => tools.find((tool) => tool.name === name)

test('mr_bind 传 sessionId / url / cwd，返回 ok', async () => {
  const tools = createTools({ service: fakeService() })
  const result = await byName(tools, 'mr_bind').execute({ url: 'https://git.x.com/g/p/-/merge_requests/1' }, exec)
  assert.equal(result.ok, true)
  assert.match(result.message, /REPORT s1 https:\/\/git\.x\.com\/g\/p\/-\/merge_requests\/1 \/repo/)
})

test('服务错误映射成 ok:false + code，不抛', async () => {
  const service = fakeService({
    bind: async () => { const error = new Error('不是仓库'); error.code = 'repo-mismatch'; throw error },
  })
  const tools = createTools({ service })
  const result = await byName(tools, 'mr_bind').execute({ url: 'https://git.x.com/g/p/-/merge_requests/1' }, exec)
  assert.deepEqual({ ok: result.ok, code: result.code, message: result.message }, { ok: false, code: 'repo-mismatch', message: '不是仓库' })
})

test('参数校验：url 必填、未知字段拒绝', async () => {
  const tools = createTools({ service: fakeService() })
  const def = byName(tools, 'mr_bind')
  assert.equal(def.parameters.required.includes('url'), true)
  assert.equal(def.parameters.additionalProperties, false)
  const bad = await def.execute({ url: '' }, exec)
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'invalid-arguments')
  // schema 声明不等于运行时拒绝：普通注册定义不走宿主预校验，这里断言真的拒绝。
  const extra = await def.execute({ url: 'https://git.x.com/g/p/-/merge_requests/1', bogus: true }, exec)
  assert.equal(extra.ok, false)
  assert.equal(extra.code, 'invalid-arguments')
  assert.match(extra.message, /bogus/)
})

test('mr_bind 的 repo 空白串回落会话 cwd，非空才用显式目录', async () => {
  const tools = createTools({ service: fakeService() })
  const blank = await byName(tools, 'mr_bind').execute({ url: 'https://git.x.com/g/p/-/merge_requests/1', repo: '   ' }, exec)
  assert.equal(blank.ok, true)
  assert.match(blank.message, /merge_requests\/1 \/repo$/)
  const custom = await byName(tools, 'mr_bind').execute({ url: 'https://git.x.com/g/p/-/merge_requests/1', repo: '/custom' }, exec)
  assert.equal(custom.ok, true)
  assert.match(custom.message, /merge_requests\/1 \/custom$/)
})

test('mr_status / mr_review 形状', async () => {
  const tools = createTools({ service: fakeService() })
  const status = await byName(tools, 'mr_status').execute({}, exec)
  assert.equal(status.ok, true)
  assert.match(status.message, /STATUS s1/)
  assert.equal(status.data.headSha, 'abc')
  assert.equal(status.data.gates.review, null)
  const reviewDef = byName(tools, 'mr_review')
  const review = await reviewDef.execute({}, exec)
  assert.equal(review.ok, true)
  assert.equal(review.data.round.n, 2)
  // 模型看到的只有 render 文本：data 必须真的进到文本里，不能只剩一句摘要。
  const rendered = reviewDef.output.render({}, review).map((part) => part.text).join('')
  assert.match(rendered, /"n": 2/)
  assert.match(rendered, /"decisions": \{\}/)
})

test('mr_review 返回 directives / comments 结构化数据，并渲染进模型可见文本', async () => {
  const directives = {
    directives: [{
      kind: 'waive', fid: 'a1b2c3d4', reason: '风险已评估', noteId: 75200,
      author: 'alice', createdAt: '2026-11-16T10:00:00Z',
    }],
    directiveNotes: [{ noteId: 75200, body: '#ai-waive a1b2c3d4 reason=风险已评估' }],
    invalid: { count: 1, samples: [{ noteId: 9, line: 1, why: 'invalid-fid' }] },
    truncated: { directives: 0, directiveNotes: 0, notes: 0, lines: 0 },
  }
  const directiveNotes = [{ noteId: 75200, body: '#ai-waive a1b2c3d4 reason=风险已评估' }]
  const comments = [{ noteId: 31, author: 'bob', createdAt: '2026-11-16T10:01:00Z', excerpt: '顺手改个命名' }]
  const service = fakeService({
    review: () => ({ round: { sha: 'abc', n: 2, directives, directiveNotes, comments }, decisions: {} }),
  })
  const reviewDef = byName(createTools({ service }), 'mr_review')
  const review = await reviewDef.execute({}, exec)
  assert.equal(review.ok, true)
  assert.deepEqual(review.data.directives, directives)
  assert.deepEqual(review.data.directiveNotes, directiveNotes)
  assert.deepEqual(review.data.comments, comments)
  // #10：directives / comments 不在 round 里重复回一遍（只保留顶层一份，避免返回体翻倍）。
  assert.equal('directives' in review.data.round, false)
  assert.equal('directiveNotes' in review.data.round, false)
  assert.equal('comments' in review.data.round, false)
  assert.equal(JSON.stringify(review.data.round).includes('"directives"'), false)
  assert.equal(JSON.stringify(review.data.round).includes('"comments"'), false)
  // 工具描述承诺的结构必须真的进到模型可见文本，不能只剩摘要。
  const rendered = reviewDef.output.render({}, review).map((part) => part.text).join('')
  assert.match(rendered, /"directives"/)
  assert.match(rendered, /#ai-waive a1b2c3d4 reason=风险已评估/)
  assert.match(rendered, /"invalid-fid"/)
  assert.match(rendered, /"comments"/)
  assert.match(rendered, /顺手改个命名/)
})

test('mr_review：旧 round 没有 directives / comments 时回落到 null / []，不抛', async () => {
  const tools = createTools({ service: fakeService() })
  const review = await byName(tools, 'mr_review').execute({}, exec)
  assert.equal(review.ok, true)
  assert.equal(review.data.directives, null)
  assert.deepEqual(review.data.directiveNotes, [])
  assert.deepEqual(review.data.comments, [])
})

// ---------------------------------------------------------------------------
// T2 写路径工具：mr_waive（草稿 → 用户确认「可以 / 自定义」→ post:true 回帖）
// ---------------------------------------------------------------------------

test('mr_waive 默认只出草稿：不透传 post，返回 body 并要求用「可以 / 自定义」问用户', async () => {
  let draftArgs
  const service = fakeService({
    waiverDraft: (args) => {
      draftArgs = args
      return { body: `#ai-${args.kind} ${args.fid} reason=${args.reason}`, fid: args.fid, kind: args.kind, reason: args.reason, mrLabel: 'MR !240 · g/p' }
    },
    postWaiver: async () => { throw new Error('草稿阶段绝不能回帖') },
  })
  const def = byName(createTools({ service }), 'mr_waive')
  const result = await def.execute({ fid: 'a1b2c3d4', reason: '风险已评估' }, exec)
  assert.equal(result.ok, true)
  assert.deepEqual(draftArgs, { sessionId: 's1', fid: 'a1b2c3d4', kind: 'waive', reason: '风险已评估' })
  assert.deepEqual(result.data, {
    body: '#ai-waive a1b2c3d4 reason=风险已评估',
    fid: 'a1b2c3d4',
    kind: 'waive',
    reason: '风险已评估',
    mrLabel: 'MR !240 · g/p',
    posted: false,
  })
  // 模型实际看到的是 render 的文本：草稿与「可以 / 自定义」的下一步都必须出现在里面。
  const rendered = def.output.render({}, result).map((part) => part.text).join('')
  assert.match(rendered, /#ai-waive a1b2c3d4 reason=风险已评估/)
  assert.match(rendered, /MR !240 · g\/p/)
  assert.match(rendered, /可以 \/ 自定义/)
  assert.match(rendered, /post: true/)
  assert.match(def.description, /草稿/)
  assert.match(def.description, /可以 \/ 自定义/)
})

test('mr_waive post:true 才回帖：kind 透传，返回 posted/noteId/url 并提示先评论后提交', async () => {
  let postArgs
  const service = fakeService({
    postWaiver: async (args) => {
      postArgs = args
      return { posted: true, noteId: 901, url: 'https://git.x.com/g/p/-/merge_requests/240#note_901', body: '#ai-wontfix a1b2c3d4 reason=遗留问题' }
    },
  })
  const def = byName(createTools({ service }), 'mr_waive')
  const result = await def.execute({ fid: 'a1b2c3d4', kind: 'wontfix', reason: '遗留问题', post: true }, exec)
  assert.equal(result.ok, true)
  assert.deepEqual(postArgs, { sessionId: 's1', fid: 'a1b2c3d4', kind: 'wontfix', reason: '遗留问题' })
  assert.deepEqual(result.data, { posted: true, noteId: 901, url: 'https://git.x.com/g/p/-/merge_requests/240#note_901' })
  assert.match(result.message, /901/)
  assert.match(result.message, /https:\/\/git\.x\.com/)
  // 决策 1：先评论、后提交代码。
  assert.match(result.message, /先评论/)
  assert.match(result.message, /commit/)
})

test('mr_waive post:true 幂等命中：posted:false + 提示已有同 kind 指令', async () => {
  const service = fakeService({
    postWaiver: async () => ({ posted: false, noteId: 900, existing: true }),
  })
  const def = byName(createTools({ service }), 'mr_waive')
  const result = await def.execute({ fid: 'a1b2c3d4', reason: '风险已评估', post: true }, exec)
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, { posted: false, noteId: 900, existing: true })
  assert.match(result.message, /已有同 kind 指令/)
  assert.match(result.message, /900/)
})

test('mr_waive 参数校验：fid / reason 必填，kind 枚举，post 必须是布尔，未知参数拒绝', async () => {
  const def = byName(createTools({ service: fakeService() }), 'mr_waive')
  assert.equal(def.parameters.required.includes('fid'), true)
  assert.equal(def.parameters.required.includes('reason'), true)
  assert.deepEqual(def.parameters.properties.kind.enum, ['waive', 'skip', 'wontfix'])
  assert.equal(def.parameters.additionalProperties, false)
  const badCases = [
    { reason: 'x' }, // 缺 fid
    { fid: '', reason: 'x' }, // fid 空
    { fid: 'a1b2c3d4' }, // 缺 reason
    { fid: 'a1b2c3d4', reason: 'x', kind: 'fix' },
    { fid: 'a1b2c3d4', reason: 'x', post: 'yes' },
    { fid: 'a1b2c3d4', reason: 'x', bogus: true },
  ]
  for (const args of badCases) {
    const result = await def.execute(args, exec)
    assert.equal(result.ok, false, JSON.stringify(args))
    assert.equal(result.code, 'invalid-arguments', JSON.stringify(args))
  }
})

test('mr_waive 错误映射：草稿与回帖都走 ServiceError → ok:false + code', async () => {
  const draftFail = byName(createTools({
    service: fakeService({
      waiverDraft: () => { const error = new Error('该 FID 已有处置'); error.code = 'already-disposed'; throw error },
    }),
  }), 'mr_waive')
  const draft = await draftFail.execute({ fid: 'a1b2c3d4', reason: 'x' }, exec)
  assert.deepEqual({ ok: draft.ok, code: draft.code, message: draft.message }, { ok: false, code: 'already-disposed', message: '该 FID 已有处置' })

  const postFail = byName(createTools({
    service: fakeService({
      postWaiver: async () => { const error = new Error('GitLab 拒绝发评论：token 缺少 api 写权限'); error.code = 'permission-denied'; throw error },
    }),
  }), 'mr_waive')
  const post = await postFail.execute({ fid: 'a1b2c3d4', reason: 'x', post: true }, exec)
  assert.equal(post.ok, false)
  assert.equal(post.code, 'permission-denied')
  assert.match(post.message, /权限/)
})

test('M8 幂等命中但 noteId 缺失：消息改为「已有该 FID 的处置」，不再报评论号', async () => {
  const service = fakeService({
    postWaiver: async () => ({ posted: false, noteId: null, existing: true }),
  })
  const def = byName(createTools({ service }), 'mr_waive')
  const result = await def.execute({ fid: 'a1b2c3d4', reason: '风险已评估', post: true }, exec)
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, { posted: false, noteId: null, existing: true })
  assert.match(result.message, /已有该 FID 的处置/)
  assert.doesNotMatch(result.message, /评论 #/)
})

test('M2 回帖成功但账本落盘失败：透传 persisted:false / warning，消息里提示警告', async () => {
  const service = fakeService({
    postWaiver: async () => ({
      posted: true,
      persisted: false,
      warning: '账本写入失败，检查 ~/.dsh/mr-loop 的磁盘权限',
      noteId: 901,
      url: 'https://git.x.com/g/p/-/merge_requests/240#note_901',
      body: '#ai-waive a1b2c3d4 reason=风险已评估',
    }),
  })
  const def = byName(createTools({ service }), 'mr_waive')
  const result = await def.execute({ fid: 'a1b2c3d4', reason: '风险已评估', post: true }, exec)
  assert.equal(result.ok, true)
  assert.equal(result.data.posted, true)
  assert.equal(result.data.persisted, false)
  assert.match(result.data.warning, /账本/)
  assert.match(result.message, /账本写入失败/)
  // 评论确实发出去了，不能提示失败让人重发。
  assert.match(result.message, /已发豁免评论/)
})
