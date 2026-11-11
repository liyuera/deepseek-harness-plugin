import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  collectPatch,
  collectRange,
  parseHunks,
  parsePatch,
  resolveRepoRoot,
  runGit,
  validateRange,
} from '../src/host/git.js'

const CONFIG = {
  codeExtensions: ['.js', '.ts'],
  maxFileDiffBytes: 50000,
  maxRangeBytes: 500000,
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const commit = (cwd, message) => git(cwd, [
  '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', message,
])

function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cr-git-'))
  git(dir, ['init', '-q'])
  writeFileSync(join(dir, 'a.js'), 'const a = 1\n')
  writeFileSync(join(dir, 'notes.md'), '# base\n')
  git(dir, ['add', '.'])
  commit(dir, 'base')
  writeFileSync(join(dir, 'a.js'), 'const a = 1\nconst b = 2\n')
  writeFileSync(join(dir, 'notes.md'), '# base\nmore notes\n')
  git(dir, ['add', '.'])
  commit(dir, 'head')
  return dir
}

test('validateRange 拒绝参数注入与非法表达式', () => {
  assert.equal(validateRange('HEAD~1..HEAD'), 'HEAD~1..HEAD')
  assert.equal(validateRange('main...feature/x'), 'main...feature/x')
  assert.throws(() => validateRange('--output=/tmp/x..HEAD'), /invalid-range/)
  assert.throws(() => validateRange('a..b c'), /invalid-range/)
  assert.throws(() => validateRange('nope'), /invalid-range/)
  assert.throws(() => validateRange(''), /invalid-range/)
})

test('resolveRepoRoot 对非 git 目录抛错而不是猜路径', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-nogit-'))
  try {
    await assert.rejects(() => resolveRepoRoot({ cwd: dir }), /git rev-parse failed/)
    await assert.rejects(() => resolveRepoRoot({ cwd: '' }), /no-cwd/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collectRange 取材 base..head：代码文件带 hunks，非代码进 skipped', async () => {
  const dir = createRepo()
  try {
    const collected = await collectRange({ cwd: dir, range: 'HEAD~1..HEAD', config: CONFIG })
    assert.equal(collected.root, realpathSync(dir))
    assert.equal(collected.files.length, 1)
    const [file] = collected.files
    assert.equal(file.path, 'a.js')
    assert.equal(file.added, 1)
    assert.equal(file.deleted, 0)
    assert.ok(file.hunks.length >= 1)
    assert.match(file.text, /@@ -1,1 \+1,2 @@/)
    assert.deepEqual(collected.skipped, [{ path: 'notes.md', reason: 'not-code' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collectRange 对非法范围/非 git 抛错，不返回空结果冒充完成', async () => {
  const dir = createRepo()
  try {
    await assert.rejects(() => collectRange({ cwd: dir, range: '--stat..HEAD', config: CONFIG }), /invalid-range/)
    await assert.rejects(() => collectRange({ cwd: dir, range: 'nope..HEAD', config: CONFIG }), /git .*failed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseHunks 只收 hunk 内行，删掉的 --- 内容不被当成文件头丢弃', () => {
  const text = [
    'diff --git a/x.js b/x.js',
    '--- a/x.js',
    '+++ b/x.js',
    '@@ -1,3 +1,3 @@',
    " const a = 1",
    "--- const b = 2",
    "+--- const b = 3",
    ' end',
  ].join('\n')
  const hunks = parseHunks(text)
  assert.equal(hunks.length, 1)
  assert.equal(hunks[0].oldStart, 1)
  assert.equal(hunks[0].oldLines, 3)
  assert.equal(hunks[0].newStart, 1)
  assert.equal(hunks[0].newLines, 3)
  assert.deepEqual(hunks[0].lines, [' const a = 1', '--- const b = 2', '+--- const b = 3', ' end'])
})

test('collectPatch 解析工作区补丁文件，且拒绝越界路径', async () => {
  const dir = createRepo()
  try {
    const patch = git(dir, ['diff', 'HEAD~1..HEAD'])
    writeFileSync(join(dir, 'changes.diff'), patch)
    const collected = await collectPatch({ cwd: dir, patchFile: 'changes.diff', config: CONFIG })
    assert.equal(collected.files.length, 1)
    assert.equal(collected.files[0].path, 'a.js')
    assert.deepEqual(collected.skipped, [{ path: 'notes.md', reason: 'not-code' }])

    await assert.rejects(
      () => collectPatch({ cwd: dir, patchFile: '../outside.diff', config: CONFIG }),
      /patch-outside-cwd/,
    )
    await assert.rejects(
      () => collectPatch({ cwd: dir, patchFile: '/tmp/outside.diff', config: CONFIG }),
      /patch-outside-cwd/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collectPatch 跳过二进制；单文件超 maxFileDiffBytes 记 budget-file', async () => {
  const dir = createRepo()
  try {
    writeFileSync(join(dir, 'blob.js'), Buffer.from([0, 1, 2, 3]))
    git(dir, ['add', '.'])
    commit(dir, 'binary')
    const patch = git(dir, ['diff', 'HEAD~1..HEAD'])
    writeFileSync(join(dir, 'changes.diff'), patch)
    const collected = await collectPatch({ cwd: dir, patchFile: 'changes.diff', config: CONFIG })
    assert.deepEqual(collected.files, [])
    assert.deepEqual(collected.skipped, [{ path: 'blob.js', reason: 'binary' }])

    // 代码文本补丁，但单文件上限设为 1 字节 → budget-file。
    const textPatch = git(dir, ['diff', 'HEAD~2..HEAD~1'])
    writeFileSync(join(dir, 'text.diff'), textPatch)
    const tiny = await collectPatch({
      cwd: dir,
      patchFile: 'text.diff',
      config: { ...CONFIG, maxFileDiffBytes: 1 },
    })
    assert.deepEqual(tiny.files, [])
    assert.ok(tiny.skipped.some((item) => item.reason === 'budget-file'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runGit 把失败 stderr 带进错误信息', async () => {
  const dir = createRepo()
  try {
    await assert.rejects(() => runGit({ args: ['diff', 'nope..HEAD'], cwd: dir }), /unknown revision|git diff failed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
