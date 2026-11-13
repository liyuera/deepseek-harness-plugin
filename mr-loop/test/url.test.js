import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMrUrl } from '../src/host/url.js'

const BASE = 'https://git.htwisdom.cn'

test('标准 MR 地址', () => {
  assert.deepEqual(
    parseMrUrl(`${BASE}/wisdom/g/proj/-/merge_requests/240`, BASE),
    { project: 'wisdom/g/proj', iid: 240 },
  )
})

test('别的 host / 非 MR 路径 / 非数字 iid 一律 null', () => {
  assert.equal(parseMrUrl('https://gitlab.com/a/b/-/merge_requests/1', BASE), null)
  assert.equal(parseMrUrl(`${BASE}/a/b`, BASE), null)
  assert.equal(parseMrUrl(`${BASE}/a/b/-/merge_requests/abc`, BASE), null)
  assert.equal(parseMrUrl('not a url', BASE), null)
})

test('baseUrl 带子路径时按前缀剥离', () => {
  assert.deepEqual(parseMrUrl('https://h.com/gitlab/a/b/-/merge_requests/9', 'https://h.com/gitlab'), { project: 'a/b', iid: 9 })
  assert.equal(parseMrUrl('https://h.com/other/a/b/-/merge_requests/9', 'https://h.com/gitlab'), null)
})
