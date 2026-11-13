#!/usr/bin/env node
/**
 * S0 只读探针：把一个真实 MR 的评审 / 门禁 / 合并态摊平成一份凭据，用来回填设计文档
 * §5.2（AI_REVIEW_SHA 是否存在）与 §5.6（详细合并态取值）。
 *
 * 用法：node mr-loop/scripts/spike.mjs <MR URL>
 * token 从 MR_LOOP_GITLAB_TOKEN 或 ~/.dsh/mr-loop/gitlab-token 读；绝不打印。
 * 只发 GET：4 次 MR 子资源 + 1 次 /api/v4/version（用来报告实例版本）。
 * token scope 不探测——GitLab <15.5 没有 /personal_access_tokens/self，脚本也不做写入；
 * 版本探测自身按客户端不变量收口（超时、禁重定向、1MiB 上限，失败只记 error 不抛）。
 * 分页语义：notes 只取首页（per_page=50，客户端不分页），pageComplete=false 时
 * userNotesCountMatches 记为 null，避免把「本页条数」误当「MR 全量条数」。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/host/config.js'
import { readToken } from '../src/host/token.js'
import { createGitlabClient, MAX_RESPONSE_BYTES } from '../src/host/gitlab.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const NOTES_PER_PAGE = 50

function parseMrUrl(input, baseUrl) {
  const url = new URL(input)
  const base = new URL(baseUrl)
  if (url.origin !== base.origin) throw new Error(`MR 地址不属于 baseUrl（${baseUrl}）`)
  const basePath = base.pathname.replace(/\/+$/, '')
  if (basePath && !url.pathname.startsWith(`${basePath}/`)) throw new Error(`MR 地址不属于 baseUrl（${baseUrl}）`)
  const rest = basePath ? url.pathname.slice(basePath.length) : url.pathname
  const match = /^\/(.+?)\/-\/merge_requests\/(\d+)\/?$/.exec(rest)
  if (!match) throw new Error('MR 地址格式应为 https://<host>/<group>/<project>/-/merge_requests/<iid>')
  return { project: match[1], iid: Number(match[2]) }
}

/** 版本探测：复刻客户端的超时/禁重定向/1MiB 上限，失败不抛，交给 evidence 记录。 */
async function probeGitlabVersion({ baseUrl, token, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response
    try {
      response = await fetch(`${baseUrl}/api/v4/version`, {
        method: 'GET',
        headers: { 'PRIVATE-TOKEN': token, accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      })
    } catch (error) {
      const timedOut = controller.signal.aborted || error?.name === 'AbortError'
      return { error: timedOut ? 'timeout' : 'network' }
    }
    if (!response.ok) return { error: 'bad-response' }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return { error: 'bad-response' }
    let body
    try {
      body = await response.text()
    } catch {
      return { error: controller.signal.aborted ? 'timeout' : 'network' }
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) return { error: 'bad-response' }
    try {
      const data = JSON.parse(body)
      return typeof data?.version === 'string' ? { version: data.version } : { error: 'bad-response' }
    } catch {
      return { error: 'bad-response' }
    }
  } finally {
    clearTimeout(timer)
  }
}

/** token scope 不探测：老版本没有 self 端点，新版本也因只读定位而不查。 */
function tokenScopeProbeOf(version) {
  const match = typeof version === 'string' ? /^(\d+)\.(\d+)/.exec(version) : null
  if (match && (Number(match[1]) < 15 || (Number(match[1]) === 15 && Number(match[2]) < 5))) {
    return 'n/a before GitLab 15.5'
  }
  return 'not probed (script is read-only)'
}

function markersOf(body) {
  return [...String(body ?? '').matchAll(/<!--\s*(AI_REVIEW_[A-Z_]+)\s*([^>]*)-->/g)].map((m) => ({
    name: m[1],
    value: m[2].trim().slice(0, 80),
  }))
}

function summarizeNote(note) {
  return {
    id: note.id,
    author: note.author?.username ?? null,
    createdAt: note.created_at,
    system: note.system === true,
    firstLine: String(note.body ?? '').split('\n').find((line) => line.trim() !== '') ?? '',
    markers: markersOf(note.body),
    bodyLength: String(note.body ?? '').length,
  }
}

async function main() {
  const cfg = resolveConfig({})
  const target = process.argv[2]
  if (!target) {
    console.error('用法：node mr-loop/scripts/spike.mjs <MR URL>')
    process.exit(2)
  }
  const { project, iid } = parseMrUrl(target, cfg.baseUrl)
  const { token, source, warning } = await readToken({ tokenFile: cfg.tokenFile })
  const client = createGitlabClient({ baseUrl: cfg.baseUrl, tokenProvider: () => token, timeoutMs: cfg.requestTimeoutMs })

  const [mr, notes, discussions, pipelines] = await Promise.all([
    client.getMergeRequest({ project, iid }),
    client.listNotes({ project, iid }),
    client.listDiscussions({ project, iid }),
    client.listPipelines({ project, iid }),
  ])

  // 只报告实例版本；token scope 不探测（见文件头与 tokenScopeProbe）。
  const versionProbe = await probeGitlabVersion({
    baseUrl: cfg.baseUrl,
    token,
    timeoutMs: cfg.requestTimeoutMs,
  })
  const gitlabVersion = versionProbe.version ?? { error: versionProbe.error }

  const reviewNotes = notes.filter((note) => String(note.body ?? '').includes(cfg.reviewMarker))
  const notesFetched = notes.length
  const pageComplete = notesFetched < NOTES_PER_PAGE
  const evidence = {
    capturedAt: new Date().toISOString(),
    tokenSource: source,
    tokenWarning: warning ?? null,
    gitlabVersion,
    tokenScopeProbe: tokenScopeProbeOf(versionProbe.version),
    project,
    iid,
    mr: {
      sha: mr.sha,
      state: mr.state,
      draft: mr.draft,
      hasConflicts: mr.has_conflicts,
      blockingDiscussionsResolved: mr.blocking_discussions_resolved ?? null,
      detailedMergeStatus: mr.detailed_merge_status ?? null,
      mergeStatus: mr.merge_status ?? null,
      userNotesCount: mr.user_notes_count,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      headPipeline: mr.head_pipeline ?? null,
    },
    notesPage: {
      perPage: NOTES_PER_PAGE,
      fetched: notesFetched,
      pageComplete,
      note: '客户端只取首页、不分页；userNotesCountMatches 仅在 pageComplete 时有意义，否则为 null。',
    },
    pipelines,
    notes: notes.map(summarizeNote),
    reviewNotes: reviewNotes.map(summarizeNote),
    discussions: discussions.map((discussion) => ({
      id: discussion.id,
      resolvable: discussion.notes?.some((note) => note.resolvable === true) ?? false,
      resolved: discussion.notes?.every((note) => note.resolvable === false || note.resolved === true) ?? null,
      notes: (discussion.notes ?? []).map((note) => ({ id: note.id, resolvable: note.resolvable, resolved: note.resolved, system: note.system })),
    })),
    checks: {
      hasAiReviewShaMarker: notes.some((note) => markersOf(note.body).some((m) => m.name === 'AI_REVIEW_SHA')),
      hasHeadPipeline: mr.head_pipeline !== null && mr.head_pipeline !== undefined,
      hasDetailedMergeStatus: typeof mr.detailed_merge_status === 'string',
      hasBlockingDiscussionsResolved: typeof mr.blocking_discussions_resolved === 'boolean',
      // 仅首页完整时才能拿本页非系统 note 数与 MR 全量计数比较；否则 null（未知，而非 false）。
      userNotesCountMatches: pageComplete
        ? mr.user_notes_count === notes.filter((note) => note.system !== true).length
        : null,
    },
  }

  const outDir = resolve(HERE, '..', '.tmp')
  await mkdir(outDir, { recursive: true })
  const outFile = resolve(outDir, `spike-${iid}.json`)
  await writeFile(outFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  console.log(`证据已写入 ${outFile}`)
  console.log(JSON.stringify(evidence.checks, null, 2))
}

main().catch((error) => {
  console.error(`探针失败：${error.message}`)
  process.exitCode = 1
})
