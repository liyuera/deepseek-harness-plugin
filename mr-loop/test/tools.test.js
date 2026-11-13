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
})

test('mr_status / mr_review 形状', async () => {
  const tools = createTools({ service: fakeService() })
  const status = await byName(tools, 'mr_status').execute({}, exec)
  assert.equal(status.ok, true)
  assert.match(status.message, /STATUS s1/)
  assert.equal(status.data.headSha, 'abc')
  assert.equal(status.data.gates.review, null)
  const review = await byName(tools, 'mr_review').execute({}, exec)
  assert.equal(review.ok, true)
  assert.equal(review.data.round.n, 2)
})
