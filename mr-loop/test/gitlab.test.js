import test from 'node:test'
import assert from 'node:assert/strict'
import { createGitlabClient, GitlabError, encodeProject, MAX_RESPONSE_BYTES } from '../src/host/gitlab.js'

function fakeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const mk = (fetchImpl, token = 't0ken') => createGitlabClient({ baseUrl: 'https://git.x.com', tokenProvider: () => token, fetchImpl, timeoutMs: 1000 })

test('路径编码 + PRIVATE-TOKEN 头 + 无 token 不发请求', async () => {
  const f = fakeFetch(() => json({ iid: 240, sha: 'abc', state: 'opened' }))
  const client = mk(f)
  const mr = await client.getMergeRequest({ project: 'g/sub/proj', iid: 240 })
  assert.equal(mr.iid, 240)
  assert.equal(f.calls.length, 1)
  assert.match(f.calls[0].url, /\/api\/v4\/projects\/g%2Fsub%2Fproj\/merge_requests\/240$/)
  assert.equal(f.calls[0].init.headers['PRIVATE-TOKEN'], 't0ken')
  assert.equal(f.calls[0].init.redirect, 'error')
  assert.ok(!f.calls[0].url.includes('t0ken'))

  const noTokenFetch = fakeFetch(() => json({}))
  const noToken = mk(noTokenFetch, '')
  await assert.rejects(noToken.getMergeRequest({ project: 'g/p', iid: 1 }), (e) => e instanceof GitlabError && e.code === 'no-token')
  assert.equal(noTokenFetch.calls.length, 0, '无 token 时不得发起任何 fetch')
})

test('notes 列表参数与形状校验', async () => {
  const f = fakeFetch(() => json([{ id: 1, body: 'x', system: false }]))
  const notes = await mk(f).listNotes({ project: 'g/p', iid: 7 })
  assert.equal(notes.length, 1)
  assert.match(f.calls[0].url, /notes\?sort=desc&order_by=created_at&per_page=50$/)

  const bad = mk(fakeFetch(() => json({ not: 'an array' })))
  await assert.rejects(bad.listNotes({ project: 'g/p', iid: 7 }), (e) => e.code === 'bad-response')
})

test('状态码映射', async () => {
  const cases = [[401, 'unauthorized'], [403, 'forbidden'], [404, 'not-found'], [409, 'conflict'], [429, 'rate-limited'], [500, 'network']]
  for (const [status, code] of cases) {
    const client = mk(fakeFetch(() => json({ message: 'x' }, status)))
    await assert.rejects(client.getMergeRequest({ project: 'g/p', iid: 1 }), (e) => e instanceof GitlabError && e.code === code)
  }

  const client500 = mk(fakeFetch(() => json({ message: 'x' }, 500)))
  await assert.rejects(
    client500.getMergeRequest({ project: 'g/p', iid: 1 }),
    (e) => e instanceof GitlabError && e.code === 'network' && e.status === 500,
  )
})

test('非 JSON 是 bad-response；合法 JSON 但超 1MiB 也只能因限长而 bad-response', async () => {
  const html = mk(fakeFetch(() => new Response('<html>', { status: 200 })))
  await assert.rejects(html.getMergeRequest({ project: 'g/p', iid: 1 }), (e) => e.code === 'bad-response')

  // 合法 JSON 且形状也合法（iid/sha），仅尺寸超限：若删除限长检查，请求会成功，测试即失败。
  const oversize = JSON.stringify({ iid: 1, sha: 'a'.repeat(MAX_RESPONSE_BYTES + 64) })
  assert.ok(Buffer.byteLength(oversize, 'utf8') > MAX_RESPONSE_BYTES)
  const huge = mk(fakeFetch(() => new Response(oversize, { status: 200 })))
  await assert.rejects(huge.getMergeRequest({ project: 'g/p', iid: 1 }), (e) => e.code === 'bad-response')

  const boom = mk(fakeFetch(() => { throw new TypeError('fetch failed') }))
  await assert.rejects(boom.getMergeRequest({ project: 'g/p', iid: 1 }), (e) => e.code === 'network')
})

test('响应体停滞时超时仍生效（body 读取可取消）', async () => {
  const stalled = createGitlabClient({
    baseUrl: 'https://git.x.com',
    tokenProvider: () => 't0ken',
    fetchImpl: fakeFetch(() => new Response(new ReadableStream({ start() {} }), { status: 200 })),
    timeoutMs: 25,
  })
  await assert.rejects(
    stalled.getMergeRequest({ project: 'g/p', iid: 1 }),
    (e) => e instanceof GitlabError && e.code === 'timeout',
  )
})

test('response.body 为 null 视为空体 → bad-response', async () => {
  const empty = mk(fakeFetch(() => new Response(null, { status: 200 })))
  await assert.rejects(empty.getMergeRequest({ project: 'g/p', iid: 1 }), (e) => e.code === 'bad-response')
})

test('encodeProject 拒绝路径穿越', () => {
  assert.equal(encodeProject('a/b'), 'a%2Fb')
  for (const bad of ['../x', 'a/../b', '/leading', 'a//b', 'a/b/', '']) {
    assert.throws(() => encodeProject(bad), (e) => e instanceof GitlabError && e.code === 'invalid-project')
  }
})

// ---------------------------------------------------------------------------
// T2 写路径：postNote（POST /notes）
// ---------------------------------------------------------------------------
const NOTE_BODY = '#ai-waive a1b2c3d4 reason=风险已评估'

test('postNote：POST /notes，JSON body + PRIVATE-TOKEN，响应只保留需要的字段', async () => {
  const f = fakeFetch(() => json({
    id: 901,
    body: NOTE_BODY,
    created_at: '2026-11-16T10:00:00Z',
    author: { id: 7, username: 'me', name: 'Me', avatar_url: 'https://x/a.png' },
    // 上游多给的字段不应原样透传（截取实际需要的字段）。
    resolvable: true,
  }))
  const note = await mk(f).postNote({ project: 'g/sub/proj', iid: 7, body: NOTE_BODY })
  assert.deepEqual(note, {
    id: 901,
    body: NOTE_BODY,
    created_at: '2026-11-16T10:00:00Z',
    author: { id: 7, username: 'me', name: 'Me' },
  })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, 'https://git.x.com/api/v4/projects/g%2Fsub%2Fproj/merge_requests/7/notes')
  assert.equal(f.calls[0].init.method, 'POST')
  assert.equal(f.calls[0].init.headers['PRIVATE-TOKEN'], 't0ken')
  assert.equal(f.calls[0].init.headers['content-type'], 'application/json')
  assert.equal(f.calls[0].init.redirect, 'error')
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { body: NOTE_BODY })
  assert.ok(!f.calls[0].url.includes('t0ken'))
})

test('postNote 错误映射：403 → permission-denied（写权限），404 → not-found', async () => {
  const forbidden = mk(fakeFetch(() => json({ message: '403 Forbidden' }, 403)))
  await assert.rejects(
    forbidden.postNote({ project: 'g/p', iid: 1, body: NOTE_BODY }),
    (e) => e instanceof GitlabError && e.code === 'permission-denied' && e.status === 403 && /权限/.test(e.message),
  )

  const missing = mk(fakeFetch(() => json({ message: '404 Not Found' }, 404)))
  await assert.rejects(
    missing.postNote({ project: 'g/p', iid: 1, body: NOTE_BODY }),
    (e) => e instanceof GitlabError && e.code === 'not-found' && e.status === 404,
  )
})

test('postNote 网络 / 超时 / 无 token 复用既有映射', async () => {
  const boom = mk(fakeFetch(() => { throw new TypeError('fetch failed') }))
  await assert.rejects(boom.postNote({ project: 'g/p', iid: 1, body: NOTE_BODY }), (e) => e.code === 'network')

  const stalled = createGitlabClient({
    baseUrl: 'https://git.x.com',
    tokenProvider: () => 't0ken',
    fetchImpl: fakeFetch(() => new Response(new ReadableStream({ start() {} }), { status: 201 })),
    timeoutMs: 25,
  })
  await assert.rejects(stalled.postNote({ project: 'g/p', iid: 1, body: NOTE_BODY }), (e) => e.code === 'timeout')

  const noTokenFetch = fakeFetch(() => json({ id: 1, body: NOTE_BODY }))
  const noToken = mk(noTokenFetch, '')
  await assert.rejects(noToken.postNote({ project: 'g/p', iid: 1, body: NOTE_BODY }), (e) => e.code === 'no-token')
  assert.equal(noTokenFetch.calls.length, 0, '无 token 时不得发起任何 fetch')
})

test('postNote：响应体积超 1MiB / 结构异常 → bad-response', async () => {
  const oversize = JSON.stringify({ id: 901, body: 'x'.repeat(MAX_RESPONSE_BYTES + 64) })
  assert.ok(Buffer.byteLength(oversize, 'utf8') > MAX_RESPONSE_BYTES)
  const huge = mk(fakeFetch(() => new Response(oversize, { status: 201 })))
  await assert.rejects(huge.postNote({ project: 'g/p', iid: 1, body: NOTE_BODY }), (e) => e.code === 'bad-response')

  const weird = mk(fakeFetch(() => json({ not: 'a note' })))
  await assert.rejects(weird.postNote({ project: 'g/p', iid: 1, body: NOTE_BODY }), (e) => e.code === 'bad-response')

  const html = mk(fakeFetch(() => new Response('<html>', { status: 201 })))
  await assert.rejects(html.postNote({ project: 'g/p', iid: 1, body: NOTE_BODY }), (e) => e.code === 'bad-response')
})
