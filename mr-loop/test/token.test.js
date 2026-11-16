import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readToken, TokenError, expandHome, TOKEN_ENV } from '../src/host/token.js'

test('环境变量优先，且 trim', async () => {
  const r = await readToken({ tokenFile: '/nope', env: { [TOKEN_ENV]: '  abc  ' } })
  assert.deepEqual(r, { token: 'abc', source: 'env' })
})

test('文件读取 + 权限过宽给 warning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-token-'))
  const file = join(dir, 'gitlab-token')
  await writeFile(file, 'filetoken\n', 'utf8')
  await chmod(file, 0o644)
  const r = await readToken({ tokenFile: file, env: {} })
  assert.equal(r.token, 'filetoken')
  assert.equal(r.source, 'file')
  assert.match(r.warning, /chmod 600/)
  await chmod(file, 0o600)
  const r2 = await readToken({ tokenFile: file, env: {} })
  assert.equal(r2.warning, undefined)
  await rm(dir, { recursive: true, force: true })
})

test('文件不存在 / 空文件 → no-token', async () => {
  await assert.rejects(
    readToken({ tokenFile: '/definitely/missing', env: {} }),
    (err) => err instanceof TokenError && err.code === 'no-token',
  )
  const dir = await mkdtemp(join(tmpdir(), 'mrloop-token-'))
  const file = join(dir, 'empty')
  await writeFile(file, '   \n', 'utf8')
  await assert.rejects(readToken({ tokenFile: file, env: {} }), (err) => err.code === 'no-token')
  await rm(dir, { recursive: true, force: true })
})

test('expandHome 只展开 ~/ 前缀', () => {
  assert.ok(expandHome('~/x').endsWith('/x'))
  assert.equal(expandHome('/abs/x'), '/abs/x')
})

test('读取失败一律 TokenError，且不透传上游原文', async () => {
  const fakeStat = async () => ({ isFile: () => true, mode: 0o100600 })
  const eacces = Object.assign(new Error('EACCES: permission denied, open /x'), { code: 'EACCES' })
  await assert.rejects(
    readToken({ tokenFile: '/x', env: {}, statImpl: fakeStat, readFileImpl: async () => { throw eacces } }),
    (err) => err instanceof TokenError && err.code === 'no-token' && err.message.includes('EACCES') && !err.message.includes('permission denied'),
  )
  const notDir = Object.assign(new Error('ENOTDIR: not a directory'), { code: 'ENOTDIR' })
  await assert.rejects(
    readToken({ tokenFile: '/x', env: {}, statImpl: async () => { throw notDir } }),
    (err) => err instanceof TokenError && err.code === 'no-token' && /ENOTDIR/.test(err.message) && !/不存在/.test(err.message),
  )
})
