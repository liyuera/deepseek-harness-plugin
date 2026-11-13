#!/usr/bin/env node
/**
 * S0 只读探针：把一个真实 MR 的评审 / 门禁 / 合并态摊平成一份凭据，用来回填设计文档
 * §5.2（AI_REVIEW_SHA 是否存在）与 §5.6（详细合并态取值）。
 *
 * 用法：node mr-loop/scripts/spike.mjs <MR URL>
 * token 从 MR_LOOP_GITLAB_TOKEN 或 ~/.dsh/mr-loop/gitlab-token 读；绝不打印。
 * 只发 GET；额外的一次 /personal_access_tokens/self 用来报告 token scope（也只读）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig } from '../src/host/config.js'
import { readToken } from '../src/host/token.js'
import { createGitlabClient } from '../src/host/gitlab.js'

const HERE = dirname(fileURLToPath(import.meta.url))

function parseMrUrl(input, baseUrl) {
  const url = new URL(input)
  if (!url.href.startsWith(baseUrl)) throw new Error(`MR 地址不属于 baseUrl（${baseUrl}）`)
  const match = /^\/(.+?)\/-\/merge_requests\/(\d+)\/?$/.exec(url.pathname)
  if (!match) throw new Error('MR 地址格式应为 https://<host>/<group>/<project>/-/merge_requests/<iid>')
  return { project: match[1], iid: Number(match[2]) }
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

  // GitLab 14.9 没有 /personal_access_tokens/self（15.5+），改成只报告实例版本。
  const version = await fetch(`${cfg.baseUrl}/api/v4/version`, {
    headers: { 'PRIVATE-TOKEN': token, accept: 'application/json' },
    redirect: 'error',
  }).then((res) => (res.ok ? res.json() : { error: res.status })).catch(() => ({ error: 'network' }))

  const reviewNotes = notes.filter((note) => /AI Code Review/.test(String(note.body ?? '')))
  const evidence = {
    capturedAt: new Date().toISOString(),
    tokenSource: source,
    tokenWarning: warning ?? null,
    gitlabVersion: version.version ?? version,
    tokenScopeProbe: 'n/a before GitLab 15.5（self 端点不存在）',
    project,
    iid,
    mr: {
      sha: mr.sha,
      state: mr.state,
      draft: mr.draft,
      hasConflicts: mr.has_conflicts,
      detailedMergeStatus: mr.detailed_merge_status ?? null,
      mergeStatus: mr.merge_status ?? null,
      userNotesCount: mr.user_notes_count,
      sourceBranch: mr.source_branch,
      targetBranch: mr.target_branch,
      headPipeline: mr.head_pipeline ?? null,
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
      userNotesCountMatches: mr.user_notes_count === notes.filter((note) => note.system !== true).length,
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
