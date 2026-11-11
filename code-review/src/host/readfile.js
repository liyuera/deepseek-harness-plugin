/**
 * 为全量/范围审查读取工作区文件当前内容，供宿主校验 finding 证据。
 * 只读取路径安全的普通文本文件；越界、非 UTF-8、超限一律返回 undefined，
 * 由调用方按「证据不可读」处理（保留 finding、不据此阻塞）。
 * @module @liyuera/dsh-code-review/host/readfile
 */
import { readFile as readFileDefault, realpath as realpathDefault } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const DEFAULT_MAX_FILE_BYTES = 262144

/**
 * 把工作区相对路径解析为安全绝对路径；越界返回 undefined。
 * @param {string} cwd
 * @param {string} path
 * @returns {string | undefined}
 */
function resolveWithin(cwd, path) {
  const normalized = String(path ?? '').replaceAll('\\', '/')
  if (normalized.length === 0 || isAbsolute(normalized)) return undefined
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '..')) return undefined
  const target = resolve(cwd, normalized)
  const rel = relative(cwd, target)
  if (rel.startsWith('..') || rel === '' || rel.startsWith(`..${sep}`)) return undefined
  return target
}

/**
 * 读取一组工作区文件的当前内容（相对 cwd）。
 * @param {object} input
 * @param {string | undefined} input.cwd 会话工作目录；缺失时全部返回空 Map
 * @param {readonly string[]} input.paths
 * @param {number} [input.maxFileBytes]
 * @param {Function} [input.readFile] 注入用于测试
 * @param {Function} [input.realpath] 注入用于测试
 * @returns {Promise<Map<string, string>>} path → 文本；无法安全读取的文件不在 Map 中
 */
export async function readWorkspaceTexts({
  cwd, paths, maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  readFile = readFileDefault, realpath = realpathDefault,
}) {
  const texts = new Map()
  if (typeof cwd !== 'string' || cwd.length === 0) return texts
  let root
  try {
    root = await realpath(cwd)
  } catch {
    return texts
  }
  for (const path of paths) {
    const target = resolveWithin(root, path)
    if (target === undefined) continue
    try {
      const actual = await realpath(target)
      const rel = relative(root, actual)
      if (rel.startsWith('..') || rel === '' || rel.startsWith(`..${sep}`)) continue
      const buffer = await readFile(actual)
      if (!Buffer.isBuffer(buffer)) continue
      if (buffer.byteLength > maxFileBytes) continue
      const text = buffer.toString('utf8')
      if (Buffer.byteLength(text, 'utf8') !== buffer.byteLength) continue
      texts.set(path, text)
    } catch {
      // 读不到就当作不可读，不影响审查本身。
    }
  }
  return texts
}
