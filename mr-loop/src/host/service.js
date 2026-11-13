/**
 * 绑定服务：唯一有状态的地方。纯判定（rounds / mergeable / report）都在别处，
 * 这里只做「取数 → 归并 → 落账本 → 出报告」的编排，错误一律 ServiceError(code)。
 */
import { parseMrUrl } from './url.js'
import { readRepoState } from './repo.js'
import { buildRound } from './rounds.js'
import { evaluateMergeable } from './mergeable.js'
import { renderReport } from './report.js'

export class ServiceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
  }
}

const sameProject = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()

const blockingKey = (round) => (round?.review?.blocking ?? []).map((item) => item.fid).sort().join(',')

/**
 * @param {{ config: object, ledger: object, gitlab: object, repoState?: Function, now?: () => number }} deps
 */
export function createService({ config, ledger, gitlab, repoState = readRepoState, now = Date.now, onBound = undefined }) {
  /** @type {Map<string, object>} sessionId → state */
  const bindings = new Map()

  function requireState(sessionId) {
    const state = bindings.get(sessionId)
    if (state === undefined) throw new ServiceError('not-bound', '当前会话还没有绑定 MR，先 /mr <链接>')
    return state
  }

  function report(state) {
    return renderReport({
      binding: state.binding,
      mr: state.mr,
      round: state.round,
      decisions: state.decisions,
      mergeability: state.mergeability,
      paused: state.paused,
      now: now(),
    })
  }

  async function persist(state, extra = {}) {
    await ledger.save({
      version: 1,
      binding: state.binding,
      rounds: state.rounds,
      decisions: state.decisions,
      mergeableAt: state.mergeableAt ?? null,
      terminal: state.terminal ?? null,
      paused: state.paused,
      updatedAt: new Date(now()).toISOString(),
      ...extra,
    })
  }

  async function bind({ sessionId, url, repoRoot }) {
    const parsed = parseMrUrl(url, config.baseUrl)
    if (parsed === null) throw new ServiceError('invalid-url', `MR 地址不属于 ${config.baseUrl} 或格式不对`)

    const mr = await gitlab.getMergeRequest({ project: parsed.project, iid: parsed.iid })
    if (mr.state !== 'opened') throw new ServiceError('mr-not-open', `MR 状态是 ${mr.state}`)

    let repo
    try {
      repo = await repoState({ cwd: repoRoot })
    } catch {
      throw new ServiceError('repo-mismatch', '当前目录不是可用的 git 仓库（需要可读的 origin）')
    }
    const expectedHost = new URL(config.baseUrl).hostname.toLowerCase()
    if (repo.host !== expectedHost || !sameProject(repo.projectPath, parsed.project)) {
      throw new ServiceError('repo-mismatch', `当前仓库是 ${repo.host}/${repo.projectPath}，MR 属于 ${expectedHost}/${parsed.project}`)
    }

    const notes = await gitlab.listNotes({ project: parsed.project, iid: parsed.iid })
    const observedAt = now()
    const previous = await ledger.load({ projectPath: parsed.project, iid: parsed.iid })
    const n = (Array.isArray(previous?.rounds) ? previous.rounds.length : 0) + 1
    const round = { ...buildRound({ mr, notes, cfg: config, observedAt }), n }

    const state = {
      sessionId,
      binding: {
        projectPath: parsed.project,
        iid: parsed.iid,
        repoRoot: repo.root,
        sourceBranch: mr.source_branch,
        targetBranch: mr.target_branch,
        boundAt: new Date(observedAt).toISOString(),
      },
      mr,
      round,
      rounds: [...(Array.isArray(previous?.rounds) ? previous.rounds : []), round].slice(-config.ledgerKeepRounds),
      decisions: previous?.decisions !== null && typeof previous?.decisions === 'object' ? previous.decisions : {},
      mergeability: null,
      paused: null,
      notesCount: mr.user_notes_count ?? null,
      pipelineStatus: mr.head_pipeline?.status ?? null,
      startedAt: observedAt,
      lastProgressAt: observedAt,
      stallStreak: 0,
      reverifyStreak: 0,
      stallKey: blockingKey(round),
    }
    state.mergeability = evaluateMergeable({ mr, round, decisions: state.decisions })
    bindings.set(sessionId, state)
    await persist(state)

    const warnings = repo.branch !== mr.source_branch
      ? [{ code: 'branch-mismatch', message: `当前分支是 ${repo.branch}，MR 源分支是 ${mr.source_branch}` }]
      : []
    try {
      onBound?.({ sessionId, binding: state.binding })
    } catch {
      /* 启动 watcher 失败不影响绑定本身 */
    }
    return { report: report(state), warnings }
  }

  async function status({ sessionId }) {
    const state = requireState(sessionId)
    const mr = await gitlab.getMergeRequest({ project: state.binding.projectPath, iid: state.binding.iid })
    const notes = await gitlab.listNotes({ project: state.binding.projectPath, iid: state.binding.iid })
    const result = applySnapshot({ sessionId, mr, notes })
    return { report: report(result.state), state: result.state }
  }

  function review({ sessionId }) {
    const state = requireState(sessionId)
    return { round: state.round, decisions: state.decisions }
  }

  /**
   * 把一次外部快照并入状态；S2 的 watcher 每 tick 调它，S1 的 status 也走它。
   * 新 sha = 新一轮：轮次 +1、重置 await / 停顿计数；同 sha 只刷新解析结果。
   */
  function applySnapshot({ sessionId, mr, notes }) {
    const state = requireState(sessionId)
    const beforeMergeable = state.mergeability?.mergeable === true
    const beforeVerdict = state.round?.review?.verdict ?? null
    let newRound = false

    if (mr.sha !== state.round?.sha) {
      newRound = true
      const observedAt = now()
      const round = { ...buildRound({ mr, notes, cfg: config, observedAt }), n: state.rounds.length + 1 }
      state.round = round
      state.rounds = [...state.rounds, round].slice(-config.ledgerKeepRounds)
      state.stallStreak = 0
      state.reverifyStreak = 0
      state.stallKey = blockingKey(round)
      state.lastProgressAt = observedAt
    } else if (Array.isArray(notes)) {
      state.round = { ...buildRound({ mr, notes, cfg: config, observedAt: state.round.observedAt }), n: state.round.n }
      state.rounds = [...state.rounds.slice(0, -1), state.round]
    }

    state.mr = mr
    state.notesCount = mr.user_notes_count ?? state.notesCount
    state.pipelineStatus = mr.head_pipeline?.status ?? null
    state.mergeability = evaluateMergeable({ mr, round: state.round, decisions: state.decisions })

    const key = blockingKey(state.round)
    if (key === state.stallKey && key !== '') {
      state.stallStreak += 1
    } else {
      state.stallStreak = 0
      state.stallKey = key
    }
    const maxReverify = Math.max(0, ...(state.round?.review?.blocking ?? []).map((item) => item.reverifyCount ?? 0))
    state.reverifyStreak = maxReverify >= 2 ? state.reverifyStreak + 1 : 0

    if (state.mergeability.mergeable && state.mergeableAt === undefined) state.mergeableAt = new Date(now()).toISOString()

    void persist(state).catch(() => {})
    return {
      state,
      newRound,
      reviewArrived: newRound === false && beforeVerdict !== (state.round?.review?.verdict ?? null),
      becameMergeable: beforeMergeable === false && state.mergeability.mergeable === true,
    }
  }

  async function stop({ sessionId, forget = false }) {
    const state = bindings.get(sessionId)
    if (state !== undefined) bindings.delete(sessionId)
    if (forget) {
      if (state !== undefined) await ledger.forget({ projectPath: state.binding.projectPath, iid: state.binding.iid })
      return { stopped: state !== undefined, forgotten: true }
    }
    if (state !== undefined) await persist(state).catch(() => {})
    return { stopped: state !== undefined, forgotten: false }
  }

  function pause({ sessionId, reason }) {
    const state = requireState(sessionId)
    state.paused = { reason, at: new Date(now()).toISOString() }
    void persist(state).catch(() => {})
    return state
  }

  function resume({ sessionId }) {
    const state = requireState(sessionId)
    state.paused = null
    state.lastProgressAt = now()
    return state
  }

  function getState(sessionId) {
    return bindings.get(sessionId) ?? null
  }

  function dispose() {
    bindings.clear()
  }

  return { bind, status, review, applySnapshot, stop, resume, pause, getState, dispose, report, ledger }
}
