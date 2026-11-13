import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRemote, readRepoState, RepoError } from '../src/host/repo.js'

test('parseRemote 支持 https / scp / ssh 三种写法', () => {
  assert.deepEqual(parseRemote('https://git.x.com/g/sub/p.git'), { host: 'git.x.com', path: 'g/sub/p' })
  assert.deepEqual(parseRemote('git@git.x.com:g/sub/p.git'), { host: 'git.x.com', path: 'g/sub/p' })
  assert.deepEqual(parseRemote('ssh://git@git.x.com:2222/g/sub/p'), { host: 'git.x.com', path: 'g/sub/p' })
  assert.equal(parseRemote(''), null)
})

test('readRepoState 调三条只读 git 命令', async () => {
  const calls = []
  const exec = async (args) => {
    calls.push(args)
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return '/repo'
    if (args[0] === 'remote') return 'git@git.x.com:g/sub/p.git'
    return 'feat-ly'
  }
  const state = await readRepoState({ cwd: '/repo/src', exec })
  assert.deepEqual(state, { root: '/repo', remoteUrl: 'git@git.x.com:g/sub/p.git', host: 'git.x.com', projectPath: 'g/sub/p', branch: 'feat-ly' })
  assert.deepEqual(calls.map((args) => args[0]), ['rev-parse', 'remote', 'rev-parse'])
})

test('不是仓库 / 没有 origin → RepoError', async () => {
  const notRepo = async () => { throw new Error('fatal: not a git repository') }
  await assert.rejects(readRepoState({ cwd: '/x', exec: notRepo }), (e) => e instanceof RepoError && e.code === 'not-a-repo')

  const noRemote = async (args) => (args[1] === '--show-toplevel' ? '/repo' : (() => { throw new Error('No such remote') })())
  await assert.rejects(readRepoState({ cwd: '/repo', exec: noRemote }), (e) => e.code === 'no-remote')
})
