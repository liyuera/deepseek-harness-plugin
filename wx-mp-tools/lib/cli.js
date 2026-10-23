/**
 * The `wechatide` subprocess bridge: locate the official WeChat DevTools agent
 * CLI, run one tool call at a time, parse its JSON envelope, and classify the
 * failures a caller can act on.
 *
 * Wire contract (verified against 微信开发者工具 36.6.0):
 * - argv is `wechatide -c <clientName> <toolName> [--flag value ...]`.
 * - stdout carries one JSON envelope; progress logs go to stderr.
 * - `{ ok: true, tool, clientName, result }` on success; `{ ok: false,
 *   errorType, code, reason, message, suggestions }` on failure, usually with
 *   exit code 1.
 * - `{ result: { requires, taskId, status: "pending" } }` is NOT a failure: the
 *   IDE is waiting for a human (authorization, scan-to-login, upload confirm).
 * @module @liyuera/dsh-wx-mp-tools/cli
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Hard ceiling for one invocation's captured stdout (bytes). */
const STDOUT_LIMIT = 8 * 1024 * 1024

/** Hard ceiling for one invocation's captured stderr (bytes). */
const STDERR_LIMIT = 1024 * 1024

/** Page shown when the developer tools are not installed. */
export const DEVTOOLS_DOWNLOAD_URL = 'https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html'

/** One failed or refused `wechatide` invocation. */
export class WxmpCliError extends Error {
  /**
   * @param {string} message - model-facing reason, already actionable.
   * @param {{ kind?: string, payload?: Record<string, unknown>, cause?: unknown }} [options]
   *   failure classification, raw envelope, and cause.
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WxmpCliError'
    /** @type {string} machine-routed class: cli-missing, bad-output, tool, auth-required, devtools-down, project, aborted, timeout. */
    this.kind = options.kind ?? 'tool'
    /** @type {Record<string, unknown> | undefined} raw envelope, when there was one. */
    this.payload = options.payload
  }
}

/**
 * Candidate CLI paths for a platform, in preference order.
 * @param {NodeJS.Platform} [platform] - target platform.
 * @param {NodeJS.ProcessEnv} [env] - environment source.
 * @param {string} [home] - home directory (tests inject one).
 * @returns {string[]} absolute candidate paths.
 */
export function cliCandidates(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'darwin') {
    return [
      '/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide',
      '/Applications/微信开发者工具.app/Contents/MacOS/wechatide',
      join(home, 'Applications/wechatwebdevtools.app/Contents/MacOS/wechatide'),
      join(home, 'Applications/微信开发者工具.app/Contents/MacOS/wechatide'),
    ]
  }
  if (platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA === undefined ? undefined : join(env.LOCALAPPDATA, 'Programs')]
      .filter(root => typeof root === 'string' && root !== '')
    const names = ['微信web开发者工具', '微信开发者工具']
    return roots.flatMap(root => names.map(name => join(root, name, 'wechatide.cmd')))
  }
  return []
}

/**
 * Convert a camelCase or snake_case key to the CLI's kebab-case flag name.
 * @param {string} key - JS key such as `waitForSelector`.
 * @returns {string} the same flag without its leading dashes.
 */
export function camelToKebab(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase()
}

/**
 * Convert one flag bag to CLI argv.
 *
 * Rules: `undefined`/`null` are skipped, `true` becomes `--flag`, `false`
 * becomes `--no-flag` (yargs convention), arrays and objects are passed as one
 * JSON string (the CLI's `<json>` parameters), everything else as a string.
 * @param {Record<string, unknown>} [flags] - named arguments.
 * @returns {string[]} argv fragment.
 */
export function flagsToArgv(flags = {}) {
  const argv = []
  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined || value === null) continue
    const name = camelToKebab(key)
    if (typeof value === 'boolean') {
      // The CLI's yargs parser treats an unknown `--no-flag` as an ignored
      // argument (silently keeping the default), while `--flag=false` is
      // honored — verified for `--optimize=false`. Emit the explicit form.
      argv.push(value ? `--${name}` : `--${name}=false`)
      continue
    }
    if (Array.isArray(value) || typeof value === 'object') {
      argv.push(`--${name}`, JSON.stringify(value))
      continue
    }
    argv.push(`--${name}`, String(value))
  }
  return argv
}

/**
 * Parse the JSON envelope from one invocation's stdout.
 *
 * Full-string parse first (the normal case). Two tolerant fallbacks cover a
 * stray informational line printed on stdout: JSON from the first `{`, then
 * the first-to-last brace slice.
 * @param {string} stdout - captured stdout.
 * @returns {Record<string, unknown> | undefined} the parsed envelope.
 */
export function parsePayload(stdout) {
  const text = String(stdout ?? '').trim()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    // fall through to the tolerant paths
  }
  const start = text.indexOf('{')
  if (start < 0) return undefined
  try {
    return JSON.parse(text.slice(start))
  } catch {
    // fall through to the brace slice
  }
  const end = text.lastIndexOf('}')
  if (end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Classify a failed envelope so the message can name the next action.
 * Branch on `reason`/`code` first: `message` is localized and mutable, and the
 * CLI's own parameter errors arrive as INPUT_ERROR with a stable reason.
 * @param {Record<string, unknown>} payload - `{ ok: false, ... }` envelope.
 * @returns {'auth-required' | 'devtools-down' | 'project' | 'input' | 'tool'} the class.
 */
export function classifyFailure(payload) {
  const errorType = String(payload.errorType ?? '')
  const code = String(payload.code ?? payload.reason ?? '')
  const message = String(payload.message ?? '')
  if (errorType === 'INPUT_ERROR' || code === 'missing_required' || code === 'unknown_tool' || code === 'missing_tool') return 'input'
  if (errorType === 'CONNECT_ERROR' || /CONNECT/i.test(errorType) || /CONNECT/i.test(code)) return 'devtools-down'
  if (/AUTH/i.test(errorType) || /AUTH|UNAUTH|TOKEN/i.test(code) || /authoriz|授权|令牌/i.test(message)) return 'auth-required'
  if (
    code === 'PROJECT_CONFIG_JSON_ERROR'
    || code === 'PROJECT_PATH_NOT_FOUND'
    || code === 'APPID_ERROR'
    || /runtimeid|project\.config|项目路径/i.test(message)
  ) return 'project'
  return 'tool'
}

/**
 * Render a failed envelope as one actionable line.
 * @param {string} toolName - the CLI tool being called (or `auth`).
 * @param {Record<string, unknown>} payload - `{ ok: false, ... }` envelope.
 * @returns {string} model-facing message.
 */
export function describeFailure(toolName, payload) {
  const parts = []
  if (typeof payload.message === 'string' && payload.message !== '') parts.push(payload.message)
  if (Array.isArray(payload.missing) && payload.missing.length > 0) parts.push(`missing=${payload.missing.join(',')}`)
  if (typeof payload.code === 'string' && payload.code !== '') parts.push(`code=${payload.code}`)
  if (typeof payload.errorType === 'string' && payload.errorType !== '') parts.push(`errorType=${payload.errorType}`)
  if (typeof payload.reason === 'string' && payload.reason !== '' && payload.reason !== payload.code) parts.push(`reason=${payload.reason}`)
  const body = parts.length > 0 ? parts.join(' · ') : JSON.stringify(payload)
  const kind = classifyFailure(payload)
  let next = ''
  if (kind === 'auth-required') {
    next = ' · 需要先在微信开发者工具授权：调用 wx_mp_authorize 让用户在弹窗里点「允许」，再重试。'
  } else if (kind === 'devtools-down') {
    next = ' · 微信开发者工具未运行或未开启 CLI 服务：请用户启动开发者工具并保持登录，然后调用 wx_mp_authorize。'
  } else if (kind === 'project') {
    next = ' · 项目路径不对：uni-app 项目在 IDE 里是编译产物目录（如 dist/build/mp-weixin），调用时传 IDE 项目列表里的 projectPath，或先 wx_mp_status 查候选。'
  } else if (kind === 'input') {
    next = ' · 参数名或参数值不对：CLI 会静默忽略不认识的 flag（只在 warnings 里提示），flag 名必须与 `wechatide <tool> -h` 完全一致。'
  }
  return `wechatide ${toolName} 失败：${body}${next}`
}

/**
 * Detect whether a successful-looking result is actually waiting for a human.
 * @param {unknown} result - the envelope's `result`.
 * @returns {{ pending: true, taskId: string, status: string } | undefined} pending facts.
 */
export function pendingTaskOf(result) {
  if (result === null || typeof result !== 'object') return undefined
  const taskId = /** @type {Record<string, unknown>} */ (result).taskId
  if (typeof taskId !== 'string' || taskId === '') return undefined
  const status = /** @type {Record<string, unknown>} */ (result).status
  if (status === 'pending' || status === undefined) return { pending: true, taskId, status: String(status ?? 'pending') }
  return undefined
}

/**
 * One serialized `wechatide` bridge. Calls queue so the IDE never sees two
 * concurrent automation commands; abort and timeout kill the child.
 */
export class WechatideCli {
  /**
   * @param {ReturnType<import('./config.js').resolveConfig>} config - resolved config.
   */
  constructor(config) {
    this.config = config
    /** @type {string | null | undefined} cached detection; undefined = not yet probed. */
    this.resolvedPath = undefined
    /** @type {Promise<unknown>} tail of the serialized call queue. */
    this.queue = Promise.resolve()
    /** @type {Set<import('node:child_process').ChildProcess>} live children, for disposal. */
    this.children = new Set()
  }

  /**
   * Resolve the CLI path once, throwing an actionable error when absent.
   * @returns {string} absolute CLI path.
   */
  resolveCliPath() {
    if (this.resolvedPath !== undefined) {
      if (this.resolvedPath === null) throw this.missingCliError()
      return this.resolvedPath
    }
    const configured = this.config.cliPath
    if (configured !== undefined && existsSync(configured)) {
      this.resolvedPath = configured
      return configured
    }
    for (const candidate of cliCandidates()) {
      if (existsSync(candidate)) {
        this.resolvedPath = candidate
        return candidate
      }
    }
    this.resolvedPath = null
    throw this.missingCliError()
  }

  /** Build the not-installed error; repeated so detection stays cheap. */
  missingCliError() {
    return new WxmpCliError(
      '找不到微信开发者工具的官方 agent CLI（wechatide）。请确认已安装 微信开发者工具（含 36.6.0+ 的 wechatide 入口），'
      + `或把绝对路径写进插件配置 cliPath / 环境变量 WECHATIDE_CLI_PATH。下载：${DEVTOOLS_DOWNLOAD_URL}`,
      { kind: 'cli-missing' },
    )
  }

  /**
   * Run one argv through the CLI, serialized with every other call.
   * @param {string[]} argv - arguments after the CLI path.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - bound and cancellation.
   * @returns {Promise<{ stdout: string, stderr: string, exitCode: number | null }>} captured output.
   */
  run(argv, options = {}) {
    const execute = () => this.spawnOnce(argv, options)
    const chained = this.queue.then(execute, execute)
    // Keep the queue alive after a failure; the next caller still gets its turn.
    this.queue = chained.then(() => undefined, () => undefined)
    return chained
  }

  /**
   * Spawn one child and capture its output under a timeout and cancellation.
   * @param {string[]} argv - CLI arguments.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} options - bound and cancellation.
   * @returns {Promise<{ stdout: string, stderr: string, exitCode: number | null }>} captured output.
   */
  spawnOnce(argv, options = {}) {
    const cliPath = this.resolveCliPath()
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs
    const env = { ...process.env }
    if (this.config.token !== undefined) env.WECHAT_DEVTOOLS_CLI_TOKEN = this.config.token
    return new Promise((resolve, reject) => {
      let settled = false
      let timedOut = false
      let aborted = false
      let stdout = ''
      let stderr = ''
      let timer
      /** @type {import('node:child_process').ChildProcess | undefined} */
      let child
      const finish = (fn) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
        if (child !== undefined) this.children.delete(child)
        fn()
      }
      const killChild = () => {
        if (child === undefined || child.killed) return
        child.kill('SIGTERM')
        const escalate = setTimeout(() => {
          if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
        }, 2000)
        escalate.unref?.()
      }
      const onAbort = () => {
        aborted = true
        killChild()
      }
      try {
        child = spawn(cliPath, argv, {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        reject(new WxmpCliError(`启动 wechatide 失败：${error instanceof Error ? error.message : String(error)}`, { kind: 'cli-missing', cause: error }))
        return
      }
      this.children.add(child)
      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          aborted = true
          killChild()
        } else {
          options.signal.addEventListener('abort', onAbort, { once: true })
        }
      }
      timer = setTimeout(() => {
        timedOut = true
        killChild()
      }, timeoutMs)
      timer.unref?.()
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', chunk => {
        stdout += chunk
        if (stdout.length > STDOUT_LIMIT) {
          killChild()
          finish(() => reject(new WxmpCliError(`wechatide ${argv.join(' ')} 输出超过 ${STDOUT_LIMIT} 字节，已终止。收窄查询范围（例如 grep 过滤）后重试。`, { kind: 'bad-output' })))
        }
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', chunk => {
        stderr += chunk
        if (stderr.length > STDERR_LIMIT) {
          killChild()
          finish(() => reject(new WxmpCliError(`wechatide ${argv.join(' ')} 的 stderr 超过 ${STDERR_LIMIT} 字节，已终止。`, { kind: 'bad-output' })))
        }
      })
      child.on('error', error => {
        finish(() => reject(new WxmpCliError(`启动 wechatide 失败：${error.message}`, { kind: 'cli-missing', cause: error })))
      })
      child.on('close', code => {
        finish(() => {
          if (aborted) {
            reject(new WxmpCliError(`wechatide ${argv.join(' ')} 已取消（调用被中断）。`, { kind: 'aborted' }))
            return
          }
          if (timedOut) {
            reject(new WxmpCliError(`wechatide ${argv.join(' ')} 超时（>${timeoutMs}ms）已被终止。如果开发者工具正忙，先让用户确认 IDE 状态再重试；不要连续重发。`, { kind: 'timeout' }))
            return
          }
          resolve({ stdout, stderr, exitCode: code })
        })
      })
    })
  }

  /**
   * Run one registered CLI tool and unwrap its `result`.
   * @param {string} toolName - CLI tool id, e.g. `simulator_screenshot`.
   * @param {Record<string, unknown>} [flags] - tool flags.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - bound and cancellation.
   * @returns {Promise<{ tool: string, result: unknown, payload: Record<string, unknown> }>} unwrapped outcome.
   */
  async call(toolName, flags = {}, options = {}) {
    const argv = ['-c', this.config.clientName, toolName, ...flagsToArgv(flags)]
    if (this.config.token !== undefined) argv.push('--token', this.config.token)
    const { stdout, stderr, exitCode } = await this.run(argv, options)
    const payload = parsePayload(stdout)
    if (payload === undefined) {
      const tail = stderr.trim().split('\n').slice(-3).join('\n')
      throw new WxmpCliError(
        `wechatide ${toolName} 没有返回 JSON（exit=${exitCode}）${tail === '' ? '' : `：${tail}`}`,
        { kind: 'bad-output' },
      )
    }
    if (payload.ok === false) throw new WxmpCliError(describeFailure(toolName, payload), { kind: classifyFailure(payload), payload })
    return {
      tool: typeof payload.tool === 'string' ? payload.tool : toolName,
      result: payload.result === undefined ? payload : payload.result,
      payload,
      // The CLI silently ignores unknown flags and reports them here; a typo in
      // a flag name otherwise looks like a successful call with default values.
      warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    }
  }

  /**
   * Run the one-time client authorization flow. The IDE raises its consent
   * dialog; the call resolves when the user reacts or returns a pending task.
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options] - bound and cancellation.
   * @returns {Promise<Record<string, unknown>>} the auth envelope.
   */
  async auth(options = {}) {
    const argv = ['-c', this.config.clientName, 'auth']
    if (this.config.token !== undefined) argv.push('--token', this.config.token)
    const { stdout, stderr } = await this.run(argv, { timeoutMs: options.timeoutMs ?? Math.max(this.config.timeoutMs, 120_000), signal: options.signal })
    const payload = parsePayload(stdout)
    if (payload === undefined) {
      const tail = stderr.trim().split('\n').slice(-3).join('\n')
      throw new WxmpCliError(`wechatide auth 没有返回 JSON${tail === '' ? '' : `：${tail}`}`, { kind: 'bad-output' })
    }
    if (payload.ok === false) throw new WxmpCliError(describeFailure('auth', payload), { kind: classifyFailure(payload), payload })
    return payload
  }

  /** Terminate every live child (plugin unmount). */
  dispose() {
    for (const child of this.children) {
      if (!child.killed) child.kill('SIGTERM')
    }
    this.children.clear()
  }
}
