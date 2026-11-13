/**
 * GitLab REST 只读客户端。只允许 4 个 GET，没有任何写路径：
 *   GET /projects/:p/merge_requests/:iid
 *   GET /projects/:p/merge_requests/:iid/notes?sort=desc&order_by=created_at&per_page=50
 *   GET /projects/:p/merge_requests/:iid/discussions?per_page=50
 *   GET /projects/:p/merge_requests/:iid/pipelines?per_page=1
 *
 * 安全不变量：token 只进 PRIVATE-TOKEN 头；redirect:'error' 防转发到别的主机；
 * 响应体上限 1MiB（流式累计，超限立即中断，不会先整体缓冲）；超时覆盖整个请求
 * （含响应体读取）；错误消息是静态模板，不含 token / URL / 上游原文。
 * 纯依赖注入（fetchImpl / tokenProvider），可直接单测。
 */
const API_PREFIX = '/api/v4'
const AUTH_HEADER = 'PRIVATE-TOKEN'
export const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_PROJECT_SEGMENTS = 20
const MAX_PROJECT_LENGTH = 1024
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/

const MESSAGE = Object.freeze({
  'no-token': '未配置 GitLab token',
  unauthorized: 'GitLab 鉴权失败，请检查 token',
  forbidden: 'GitLab 拒绝访问，token 权限不足',
  'not-found': 'GitLab 项目或 MR 不存在',
  conflict: 'GitLab 请求冲突，资源状态已变化',
  'rate-limited': 'GitLab 请求过于频繁，请稍后重试',
  network: '无法连接 GitLab 或服务暂时不可用',
  timeout: 'GitLab 请求超时',
  'bad-response': 'GitLab 响应结构异常',
  'invalid-project': 'GitLab 项目路径不合法（应形如 group/project）',
  'invalid-merge-request': 'GitLab MR 参数不合法',
})

export class GitlabError extends Error {
  constructor(code, status) {
    super(MESSAGE[code] ?? MESSAGE['bad-response'])
    this.name = 'GitlabError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

/** `group/sub/proj` → 单段编码；拒绝空段、`.`、`..` 与超长路径。 */
export function encodeProject(project) {
  if (typeof project !== 'string' || project.length === 0 || project.length > MAX_PROJECT_LENGTH) {
    throw new GitlabError('invalid-project')
  }
  const segments = project.split('/')
  if (segments.length < 2 || segments.length > MAX_PROJECT_SEGMENTS) throw new GitlabError('invalid-project')
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment) || segment === '.' || segment === '..') throw new GitlabError('invalid-project')
  }
  return encodeURIComponent(project)
}

function assertIid(iid) {
  if (!Number.isSafeInteger(iid) || iid <= 0) throw new GitlabError('invalid-merge-request')
}

function statusToCode(status) {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not-found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'network'
  return 'bad-response'
}

/** 内部 signal 中止（超时或调用方取消）时立即拒绝，供 body 读取 race 使用。 */
function abortRejection(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(new GitlabError('timeout'))
    signal.addEventListener('abort', () => reject(new GitlabError('timeout')), { once: true })
  })
}

/**
 * 流式读取响应体：累计字节一旦超过上限立即取消底层流并抛 bad-response，
 * 不会先把超大响应整体缓冲进内存。signal 中止时取消读取，由调用方 race 判超时。
 * `response.body` 为 null 时视为空体（后续 JSON.parse 失败 → bad-response）。
 */
async function readBody(response, signal) {
  if (response.body === null || response.body === undefined) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const onAbort = () => {
    reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', onAbort, { once: true })
  let total = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new GitlabError('bad-response')
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    signal.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      // 读取已结束，忽略 release 失败
    }
  }
}

/**
 * @param {{ baseUrl: string, tokenProvider: () => (string|Promise<string>), fetchImpl?: typeof fetch, timeoutMs?: number }} options
 */
export function createGitlabClient({ baseUrl, tokenProvider, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  if (typeof tokenProvider !== 'function') throw new TypeError('tokenProvider must be a function')
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  const base = baseUrl.replace(/\/+$/, '')

  async function request({ path, query, signal }) {
    let token = ''
    try {
      token = String((await tokenProvider()) ?? '').trim()
    } catch {
      token = ''
    }
    if (!token) throw new GitlabError('no-token')

    const url = new URL(`${base}${API_PREFIX}${path}`)
    if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))

    const controller = new AbortController()
    const forward = () => controller.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) forward()
      else signal.addEventListener('abort', forward, { once: true })
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    // 定时器与调用方 abort 监听器保持到响应体读完，整请求共用同一超时预算。
    try {
      let response
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { [AUTH_HEADER]: token, accept: 'application/json' },
          redirect: 'error',
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') throw new GitlabError('timeout')
        throw new GitlabError('network')
      }

      if (!response.ok) throw new GitlabError(statusToCode(response.status), response.status)

      let text
      try {
        text = await Promise.race([readBody(response, controller.signal), abortRejection(controller.signal)])
      } catch (error) {
        if (error instanceof GitlabError) throw error
        throw new GitlabError('network')
      }
      try {
        return JSON.parse(text)
      } catch {
        throw new GitlabError('bad-response')
      }
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener?.('abort', forward)
    }
  }

  const mrPath = (project, iid) => {
    assertIid(iid)
    return `/projects/${encodeProject(project)}/merge_requests/${iid}`
  }

  return {
    async getMergeRequest({ project, iid, signal }) {
      const data = await request({ path: mrPath(project, iid), signal })
      if (data === null || typeof data !== 'object' || Number.isSafeInteger(data.iid) === false || typeof data.sha !== 'string') {
        throw new GitlabError('bad-response')
      }
      return data
    },
    async listNotes({ project, iid, signal }) {
      const data = await request({
        path: `${mrPath(project, iid)}/notes`,
        query: { sort: 'desc', order_by: 'created_at', per_page: 50 },
        signal,
      })
      if (!Array.isArray(data)) throw new GitlabError('bad-response')
      return data.filter((note) => note !== null && typeof note === 'object')
    },
    async listDiscussions({ project, iid, signal }) {
      const data = await request({ path: `${mrPath(project, iid)}/discussions`, query: { per_page: 50 }, signal })
      if (!Array.isArray(data)) throw new GitlabError('bad-response')
      return data.filter((item) => item !== null && typeof item === 'object')
    },
    async listPipelines({ project, iid, signal }) {
      const data = await request({ path: `${mrPath(project, iid)}/pipelines`, query: { per_page: 1 }, signal })
      if (!Array.isArray(data)) throw new GitlabError('bad-response')
      return data.filter((item) => item !== null && typeof item === 'object')
    },
  }
}
