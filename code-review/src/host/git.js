/**
 * 范围取证：用宿主 `git` 读取 `<base>..<head>` 的 diff 或解析补丁文件，
 * 产出与 `collect.js` 同构的 `{files, skipped, bytes}`。
 *
 * 安全边界：
 * - 只读命令（`rev-parse` / `diff`），`GIT_TERMINAL_PROMPT=0` 防交互卡死；
 * - cwd 必须是会话工作目录，git 自行限制在仓库内；
 * - 补丁文件只允许 cwd 之下、大小有上限；
 * - 二进制/超大/空 diff 跳过并记原因，不猜测内容。
 * @module @liyuera/dsh-code-review/host/git
 */
import { execFile } from 'node:child_process'
import { readFile as readFileDefault } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { isCodeFile, renderHunks } from './collect.js'

const GIT_TIMEOUT_MS = 10000
const GIT_MAX_BUFFER = 8 * 1024 * 1024
const RANGE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_./~^@{}-]*\.\.[.]?[A-Za-z0-9_][A-Za-z0-9_./~^@{}-]*$/

/** 把 execFile 回调包成 promise；失败时把 stderr 带进 error.message。 */
function execFileAsync(file, args, options) {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error === null) {
        resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        return
      }
      const detail = String(stderr ?? '').trim() || error.message
      const wrapped = new Error(`git ${args[0]} failed: ${detail}`)
      wrapped.code = error.code
      wrapped.stdout = String(stdout ?? '')
      wrapped.stderr = String(stderr ?? '')
      reject(wrapped)
    })
  })
}

/**
 * 执行只读 git 命令。
 * @param {{args: readonly string[], cwd: string, timeoutMs?: number, exec?: Function}} input
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export function runGit({ args, cwd, timeoutMs = GIT_TIMEOUT_MS, exec = execFileAsync }) {
  return exec('git', args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  })
}

/**
 * 校验范围表达式：只接受 `<rev>..<rev>` / `<rev>...<rev>`，拒绝参数注入与空白。
 * @param {unknown} range
 * @returns {string}
 */
export function validateRange(range) {
  if (typeof range !== 'string' || range.length === 0 || range.length > 200) {
    throw new Error('invalid-range: 范围必须形如 <base>..<head>')
  }
  if (range.startsWith('-') || /\s/.test(range) || !RANGE_PATTERN.test(range)) {
    throw new Error(`invalid-range: 非法范围表达式 "${range}"`)
  }
  return range
}

/**
 * 解析仓库根目录；非 git 目录抛错，不做路径猜测。
 * @param {{cwd: string, exec?: Function}} input
 * @returns {Promise<string>}
 */
export async function resolveRepoRoot({ cwd, exec }) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('no-cwd: 会话没有工作目录')
  const { stdout } = await runGit({ args: ['rev-parse', '--show-toplevel'], cwd, exec })
  const root = stdout.trim()
  if (root.length === 0) throw new Error('not-a-repo: 当前目录不在 git 仓库内')
  return root
}

/**
 * 解析 unified diff 文本里的 hunk 列表（`@@ -a,b +c,d @@` 起）。
 * 只在 hunk 内收集行，避免把 `---`/`+++` 文件头当内容。
 * @param {string} text
 * @returns {Array<{oldStart:number, oldLines:number, newStart:number, newLines:number, lines:string[]}>}
 */
export function parseHunks(text) {
  const hunks = []
  let current
  for (const raw of String(text ?? '').split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
    if (header !== null) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      }
      hunks.push(current)
      continue
    }
    if (current === undefined) continue
    if (raw.startsWith('\\ No newline at end of file')) continue
    if (raw === '') continue
    current.lines.push(raw)
  }
  return hunks
}

const countLines = (hunks, prefix) => hunks.reduce(
  (total, hunk) => total + hunk.lines.filter((line) => line.startsWith(prefix)).length,
  0,
)

/**
 * 解析补丁文件文本为多文件 hunks。
 * @param {string} text
 * @returns {Array<{path:string, hunks:object[]}>}
 */
export function parsePatch(text) {
  const files = []
  for (const segment of String(text ?? '').split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(segment)
    if (header === null) continue
    const path = header[2]
    if (path === '/dev/null') continue
    const hunks = parseHunks(segment)
    if (hunks.length === 0) {
      // 二进制补丁没有 hunk，也要留一条记录供调用方跳过并披露。
      if (/(^|\n)GIT binary patch|^Binary files /m.test(segment)) {
        files.push({ path, hunks: [], binary: true })
      }
      continue
    }
    files.push({ path, hunks })
  }
  return files
}

/**
 * 把一个文件的 hunks 转成与 turn 模式一致的送审条目。
 * @param {string} path
 * @param {object[]} hunks
 * @param {number} maxFileDiffBytes
 * @returns {{file?: object, skipReason?: string}}
 */
function buildFile(path, hunks, maxFileDiffBytes) {
  const text = renderHunks(hunks)
  const size = Buffer.byteLength(text, 'utf8')
  if (size > maxFileDiffBytes) return { skipReason: 'budget-file' }
  return {
    file: {
      path,
      display: path,
      hunks,
      text,
      added: countLines(hunks, '+'),
      deleted: countLines(hunks, '-'),
    },
  }
}

/**
 * 读取 `git diff <range>` 的文件清单并逐文件取材。
 * @param {{cwd: string, range: string, config: object, exec?: Function}} input
 * @returns {Promise<{root: string, files: object[], skipped: Array<{path:string,reason:string}>, bytes: number}>}
 */
export async function collectRange({ cwd, range, config, exec }) {
  const validated = validateRange(range)
  const root = await resolveRepoRoot({ cwd, exec })
  const names = await runGit({
    args: ['--no-optional-locks', 'diff', '--name-only', '-z', '--diff-filter=ACMR', validated],
    cwd: root,
    exec,
  })
  const paths = names.stdout.split('\0').filter((path) => path.length > 0)
  const files = []
  const skipped = []
  let bytes = 0
  for (const path of paths) {
    if (!isCodeFile(path, config.codeExtensions)) {
      skipped.push({ path, reason: 'not-code' })
      continue
    }
    if (bytes >= config.maxRangeBytes) {
      skipped.push({ path, reason: 'budget' })
      continue
    }
    let text
    try {
      const diff = await runGit({
        args: [
          '--no-optional-locks', 'diff', '--no-ext-diff', '--no-color', '-U3',
          validated, '--', path,
        ],
        cwd: root,
        exec,
      })
      text = diff.stdout
    } catch {
      skipped.push({ path, reason: 'unavailable' })
      continue
    }
    if (text.startsWith('Binary files') || text.includes('GIT binary patch')) {
      skipped.push({ path, reason: 'binary' })
      continue
    }
    const hunks = parseHunks(text)
    if (hunks.length === 0) {
      skipped.push({ path, reason: 'empty' })
      continue
    }
    const built = buildFile(path, hunks, config.maxFileDiffBytes)
    if (built.skipReason !== undefined) {
      skipped.push({ path, reason: built.skipReason })
      continue
    }
    const size = Buffer.byteLength(built.file.text, 'utf8')
    if (bytes + size > config.maxRangeBytes) {
      skipped.push({ path, reason: 'budget' })
      continue
    }
    bytes += size
    files.push(built.file)
  }
  return { root, files, skipped, bytes }
}

/**
 * 读取宿主补丁文件（只允许仓库根目录之下）并解析。
 * @param {{cwd: string, patchFile: string, config: object, readFile?: Function, exec?: Function}} input
 * @returns {Promise<{root: string, files: object[], skipped: Array<{path:string,reason:string}>, bytes: number}>}
 */
export async function collectPatch({ cwd, patchFile, config, readFile = readFileDefault, exec }) {
  if (typeof patchFile !== 'string' || patchFile.trim().length === 0) {
    throw new Error('invalid-patch: 缺少补丁文件路径')
  }
  if (isAbsolute(patchFile)) throw new Error('patch-outside-cwd: 补丁文件必须相对会话工作目录')
  const root = await resolveRepoRoot({ cwd, exec })
  const target = resolve(root, patchFile)
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error('patch-outside-cwd: 补丁文件必须位于仓库根目录之下')
  }
  const text = await readFile(target, 'utf8')
  if (Buffer.byteLength(text, 'utf8') > config.maxRangeBytes) {
    throw new Error('patch-too-large: 补丁文件超过 maxRangeBytes')
  }
  const files = []
  const skipped = []
  let bytes = 0
  for (const parsed of parsePatch(text)) {
    if (parsed.binary === true) {
      skipped.push({ path: parsed.path, reason: 'binary' })
      continue
    }
    if (!isCodeFile(parsed.path, config.codeExtensions)) {
      skipped.push({ path: parsed.path, reason: 'not-code' })
      continue
    }
    if (bytes >= config.maxRangeBytes) {
      skipped.push({ path: parsed.path, reason: 'budget' })
      continue
    }
    const built = buildFile(parsed.path, parsed.hunks, config.maxFileDiffBytes)
    if (built.skipReason !== undefined) {
      skipped.push({ path: parsed.path, reason: built.skipReason })
      continue
    }
    const size = Buffer.byteLength(built.file.text, 'utf8')
    if (bytes + size > config.maxRangeBytes) {
      skipped.push({ path: parsed.path, reason: 'budget' })
      continue
    }
    bytes += size
    files.push(built.file)
  }
  return { root, files, skipped, bytes }
}
