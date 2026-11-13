/**
 * GitLab token 读取：环境变量优先，其次 0600 文件。
 * token 只在返回值的 `token` 字段里出现一次，不进日志、不进错误消息。
 * 文件权限比 0600 宽只给 warning（不阻断）——macOS 上 iCloud/共享目录常见。
 */
import { readFile as nodeReadFile, stat as nodeStat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'

export const TOKEN_ENV = 'MR_LOOP_GITLAB_TOKEN'
const MAX_TOKEN_LENGTH = 8192

export class TokenError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TokenError'
    this.code = code
  }
}

/** `~/x` → `<home>/x`；绝对路径原样返回。 */
export function expandHome(input) {
  if (typeof input !== 'string' || input === '') return input
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return resolvePath(homedir(), input.slice(2))
  return input
}

/**
 * @param {{ tokenFile: string, env?: Record<string, string|undefined>, readFileImpl?: typeof readFileImpl, statImpl?: typeof statImpl }} options
 * @returns {Promise<{ token: string, source: 'env'|'file', warning?: string }>}
 */
export async function readToken({ tokenFile, env = process.env, readFileImpl = nodeReadFile, statImpl = nodeStat }) {
  const fromEnv = String(env?.[TOKEN_ENV] ?? '').trim()
  if (fromEnv) return { token: fromEnv, source: 'env' }

  const file = expandHome(tokenFile)
  let info
  try {
    info = await statImpl(file)
  } catch {
    throw new TokenError('no-token', `未配置 GitLab token：${file} 不存在`)
  }
  if (!info.isFile()) throw new TokenError('no-token', `GitLab token 路径不是文件：${file}`)

  const warning = (info.mode & 0o077) !== 0 ? `token 文件权限过宽（建议 chmod 600）：${file}` : undefined
  const text = await readFileImpl(file, 'utf8')
  const token = String(text).trim()
  if (!token) throw new TokenError('no-token', `GitLab token 文件为空：${file}`)
  if (token.length > MAX_TOKEN_LENGTH) throw new TokenError('no-token', `GitLab token 过长：${file}`)
  return warning === undefined ? { token, source: 'file' } : { token, source: 'file', warning }
}
