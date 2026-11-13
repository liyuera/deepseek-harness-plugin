/**
 * 只为绑定校验存在的只读 git 读取：三条命令，绝不写仓库。
 * 依次取：仓库根 → origin → 当前分支。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export class RepoError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RepoError'
    this.code = code
  }
}

const stripGit = (value) => value.replace(/\/+$/, '').replace(/\.git$/, '')

/** https / ssh:// / scp 三种 remote 写法 → { host, path }。 */
export function parseRemote(remoteUrl) {
  const raw = String(remoteUrl ?? '').trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      const path = stripGit(url.pathname).replace(/^\/+/, '')
      return path.includes('/') ? { host: url.hostname.toLowerCase(), path } : null
    } catch {
      return null
    }
  }
  const scp = /^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/](.+)$/.exec(raw)
  if (!scp) return null
  const path = stripGit(scp[2]).replace(/^\/+/, '')
  return path.includes('/') ? { host: scp[1].toLowerCase(), path } : null
}

async function defaultExec(args, cwd) {
  const { stdout } = await run('git', ['-C', cwd, ...args], { timeout: 5000, maxBuffer: 1024 * 1024 })
  return String(stdout).trim()
}

/**
 * @param {{ cwd?: string, exec?: (args: string[], cwd: string) => Promise<string> }} options
 */
export async function readRepoState({ cwd, exec = defaultExec }) {
  const workdir = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
  let root
  try {
    root = await exec(['rev-parse', '--show-toplevel'], workdir)
  } catch {
    throw new RepoError('not-a-repo', `当前目录不是 git 仓库：${workdir}`)
  }
  let remoteUrl
  try {
    remoteUrl = await exec(['remote', 'get-url', 'origin'], root)
  } catch {
    throw new RepoError('no-remote', `仓库没有 origin 远程：${root}`)
  }
  const parsed = parseRemote(remoteUrl)
  if (parsed === null) throw new RepoError('no-remote', `无法解析 origin 地址：${root}`)
  const branch = await exec(['rev-parse', '--abbrev-ref', 'HEAD'], root).catch(() => {
    throw new RepoError('no-branch', `无法读取当前分支：${root}`)
  })
  return { root, remoteUrl, host: parsed.host, projectPath: parsed.path, branch }
}
