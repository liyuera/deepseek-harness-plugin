import test from 'node:test'
import assert from 'node:assert/strict'
import { createGitlabClient, GitlabError, encodeProject } from '../src/host/gitlab.js'

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

  const noToken = mk(fakeFetch(() => json({})), '')
  await assert.rejects(noToken.getMergeRequest({ project: 'g/p', iid: 1 }), (e) => e instanceof GitlabError && e.code === 'no-token')
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
})

test('非 JSON 与超大响应都是 bad-response；fetch 抛错是 network', async () => {
  const html = mk(fakeFetch(() => new Response('<html>', { status: 200 })))
  await assert.rejects(html.getMergeRequest({ project: 'g/p', iid: 1 }), (e) => e.code === 'bad-response')

  const huge = mk(fakeFetch(() => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 })))
  await assert.rejects(huge.getMergeRequest({ project: 'g/p', iid: 1 }), (e) => e.code === 'bad-response')

  const boom = mk(fakeFetch(() => { throw new TypeError('fetch failed') }))
  await assert.rejects(boom.getMergeRequest({ project: 'g/p', iid: 1 }), (e) => e.code === 'network')
})

test('encodeProject 拒绝路径穿越', () => {
  assert.equal(encodeProject('a/b'), 'a%2Fb')
  for (const bad of ['../x', 'a/../b', '/leading', 'a//b', 'a/b/', '']) {
    assert.throws(() => encodeProject(bad), (e) => e instanceof GitlabError && e.code === 'invalid-project')
  }
})
