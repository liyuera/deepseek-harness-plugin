/**
 * 模型工具面。每个工具：参数校验 → 调 service → 把结果包成 { ok, code, message, data }。
 * 一律不抛异常（模型看到的是结果，不是崩溃），错误码沿用 service 的稳定 code。
 */
const objectSchema = (properties, required = []) => ({
  type: 'object',
  properties,
  ...(required.length === 0 ? {} : { required }),
  additionalProperties: false,
})

const MR_URL = {
  type: 'string',
  description: 'GitLab MR 链接，例如 https://git.htwisdom.cn/group/project/-/merge_requests/240',
}

const ok = (message, data) => ({ ok: true, message, ...(data === undefined ? {} : { data }) })
const fail = (code, message) => ({ ok: false, code, message })
const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value?.message ?? '') }]

const errorOf = (error) => (typeof error?.code === 'string' ? error.code : 'internal')

/**
 * 普通注册定义不走宿主的参数预校验（见 wx-mp-tools 的相同说明），
 * 所以 `additionalProperties: false` 要在这里落成真实拒绝，而不是只写在 schema 上。
 */
const unknownArgument = (parameters, args) => {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
  const allowed = new Set(Object.keys(parameters?.properties ?? {}))
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) return key
  }
  return null
}

/**
 * @param {{ service: object, watcher?: { start: Function, stop: Function } }} deps
 */
export function createTools({ service, watcher = undefined }) {
  const bind = {
    name: 'mr_bind',
    description: '绑定一个 GitLab MR，立即返回首轮门禁报告。之后用 mr_status 取最新结论；不要用 sleep 轮询。',
    parameters: objectSchema({
      url: MR_URL,
      repo: { type: 'string', description: '可选：仓库根目录（默认用当前会话工作目录）' },
    }, ['url']),
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const unknown = unknownArgument(bind.parameters, args)
      if (unknown !== null) return fail('invalid-arguments', `未知参数：${unknown}`)
      const url = typeof args?.url === 'string' ? args.url.trim() : ''
      if (url === '') return fail('invalid-arguments', 'url 必填')
      try {
        const result = await service.bind({
          sessionId: exec?.agent?.session?.id,
          url,
          repoRoot: typeof args?.repo === 'string' && args.repo.trim() !== '' ? args.repo : exec?.agent?.session?.header?.cwd,
        })
        const warningText = (result.warnings ?? []).map((item) => `⚠️ ${item.message}`).join('\n')
        return ok(warningText === '' ? result.report : `${result.report}\n\n${warningText}`, { report: result.report, warnings: result.warnings ?? [] })
      } catch (error) {
        return fail(errorOf(error), String(error?.message ?? error))
      }
    },
  }

  const status = {
    name: 'mr_status',
    description: '重新拉取绑定 MR 的当前状态并渲染报告（门禁、轮次、逐条处置、还差什么才能合）。',
    parameters: objectSchema({}),
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(_args, exec) {
      const unknown = unknownArgument(status.parameters, _args)
      if (unknown !== null) return fail('invalid-arguments', `未知参数：${unknown}`)
      try {
        const result = await service.status({ sessionId: exec?.agent?.session?.id })
        const state = result.state
        const data = {
          binding: state.binding,
          headSha: state.mr?.sha ?? null,
          round: state.round,
          gates: {
            review: state.round?.review?.verdict ?? null,
            sensitive: state.round?.sensitive?.verdict ?? null,
            mandatory: state.round?.mandatory?.verdict ?? null,
          },
          decisions: state.decisions,
          mergeable: state.mergeability,
          paused: state.paused ?? null,
        }
        return ok(result.report, data)
      } catch (error) {
        return fail(errorOf(error), String(error?.message ?? error))
      }
    },
  }

  const review = {
    name: 'mr_review',
    description: '取当前轮解析好的评审与门禁结构（含每条 FID 的文件、级别、位置、问题、建议、复验次数）。',
    parameters: objectSchema({
      history: { type: 'boolean', description: '可选：附带账本里的历史轮次摘要（默认 false）' },
    }),
    // 工具描述承诺「每条 FID 的文件/级别/位置/问题/建议」，模型看到的就是 render 的文本，
    // 所以这里必须把 data 渲染出来，而不是只回一句摘要。
    output: { schema: {}, render: (_args, value) => text(JSON.stringify(value?.data ?? value, null, 2)) },
    async execute(args, exec) {
      const unknown = unknownArgument(review.parameters, args)
      if (unknown !== null) return fail('invalid-arguments', `未知参数：${unknown}`)
      try {
        const sessionId = exec?.agent?.session?.id
        const { round, decisions } = service.review({ sessionId })
        // T1 读路径：指令与其它评论直接给模型看，主代理据此决定修哪些 / 豁免哪些；
        // 旧账本里的轮次可能没有这两个字段，回落到 null / [] 而不是 undefined。
        const directives = round?.directives ?? null
        const directiveNotes = Array.isArray(round?.directiveNotes) ? round.directiveNotes : []
        const comments = Array.isArray(round?.comments) ? round.comments : []
        // #10：directives / directiveNotes / comments 只回顶层一份——留在 round 里会让返回体翻倍。
        let roundView = round
        if (round !== null && typeof round === 'object') {
          const { directives: _directives, directiveNotes: _directiveNotes, comments: _comments, ...rest } = round
          roundView = rest
        }
        const data = { round: roundView, decisions, directives, directiveNotes, comments }
        if (args?.history === true) {
          const state = service.getState(sessionId)
          data.history = (state?.rounds ?? []).map((item) => ({
            n: item.n,
            sha: String(item.sha ?? '').slice(0, 8),
            verdict: item.review?.verdict ?? null,
            sensitive: item.sensitive?.verdict ?? null,
          }))
        }
        return ok(`当前轮 sha ${String(round?.sha ?? '').slice(0, 8)}，阻塞 ${round?.review?.blocking?.length ?? 0} 条`, data)
      } catch (error) {
        return fail(errorOf(error), String(error?.message ?? error))
      }
    },
  }

  /** 与 service / 解析器一致的三种处置；枚举校验在工具层先挡一次，服务层再兜底。 */
  const WAIVER_KINDS = ['waive', 'skip', 'wontfix']
  const waive = {
    name: 'mr_waive',
    description: '对当前轮的一条评审问题生成豁免草稿，或经用户确认后发 MR 评论（#ai-waive/#ai-skip/#ai-wontfix <FID> reason=<原因>）。必须先用 post:false 出草稿给用户看，用「可以 / 自定义」询问；用户确认后才 post:true 真正回帖（post 会校验目标 MR / sha 与最近一次草稿一致，换绑或换 sha 后需重新出草稿）。先发评论、后提交代码（评论会触发一次新评审）。',
    parameters: objectSchema({
      fid: { type: 'string', description: '评审里的 FID（大小写不敏感；回帖用评审原文大小写）' },
      kind: { type: 'string', enum: WAIVER_KINDS, description: '默认 waive；skip=不适用当前场景，wontfix=业务决定不修' },
      reason: { type: 'string', description: '豁免原因（单行，非空）' },
      post: { type: 'boolean', description: '默认 false=只出草稿；用户确认后再传 true 发评论' },
    }, ['fid', 'reason']),
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const unknown = unknownArgument(waive.parameters, args)
      if (unknown !== null) return fail('invalid-arguments', `未知参数：${unknown}`)
      const fid = typeof args?.fid === 'string' ? args.fid.trim() : ''
      if (fid === '') return fail('invalid-arguments', 'fid 必填')
      // reason 的空白 / 零宽字符由服务层判 invalid-reason；这里只挡缺失与非字符串。
      if (typeof args?.reason !== 'string') return fail('invalid-arguments', 'reason 必填')
      const kind = args?.kind === undefined ? 'waive' : args.kind
      if (typeof kind !== 'string' || WAIVER_KINDS.includes(kind) === false) {
        return fail('invalid-arguments', 'kind 只能是 waive / skip / wontfix')
      }
      if (args?.post !== undefined && typeof args.post !== 'boolean') return fail('invalid-arguments', 'post 必须是布尔值')
      const sessionId = exec?.agent?.session?.id
      try {
        // 默认只出草稿：绝不因为「模型觉得可以」就自动发评论。
        if (args?.post !== true) {
          const draft = service.waiverDraft({ sessionId, fid, kind, reason: args.reason })
          // C1：把确认目标（MR 标识）放在草稿首行，用户一眼看出确认的是哪条 MR。
          const label = typeof draft.mrLabel === 'string' && draft.mrLabel !== '' ? `${draft.mrLabel} ` : ''
          const message = [
            `${label}豁免草稿（尚未发送）：`,
            draft.body,
            '',
            '下一步：把草稿给用户看，用「可以 / 自定义」问用户是否按此发送（说「可以」就原样、说「自定义」就按用户给的原因改写）；用户确认后再调用 mr_waive({ fid, kind, reason, post: true })。未确认前不要发。',
          ].join('\n')
          return ok(message, { ...draft, posted: false })
        }
        const result = await service.postWaiver({ sessionId, fid, kind, reason: args.reason })
        if (result.posted === true) {
          const lines = [
            `已发豁免评论 #${result.noteId}：${result.body}`,
            result.url,
            '评论已先发；需要提交代码时现在再 commit + push（先评论后提交，评论会触发一次新评审）。',
          ]
          const data = { posted: true, noteId: result.noteId, url: result.url }
          // M-2：结果未知时评论可能已发出，服务已按 notes 找回——提示「不要重发」。
          if (result.recovered === true) {
            lines.push('上一次尝试可能已发出，已按 notes 找回，不要重发。')
            data.recovered = true
          }
          // M2：评论已发出但账本没落盘——如实提示，不要让模型以为发送失败而重发。
          if (result.persisted === false) {
            lines.push(`⚠️ ${result.warning ?? '账本写入失败'}（评论已发出，不要重发）`)
            data.persisted = false
            data.warning = result.warning
          }
          return ok(lines.join('\n'), data)
        }
        // 幂等命中：不重复发，也不报错。M8：没有 noteId 可引用时换一句不带评论号的提示。
        if (typeof result.noteId === 'number') {
          return ok(`已有同 kind 指令（评论 #${result.noteId}），未重复发送。`, {
            posted: false,
            noteId: result.noteId,
            existing: true,
          })
        }
        return ok('已有该 FID 的处置，未重复发送。', { posted: false, noteId: null, existing: true })
      } catch (error) {
        return fail(errorOf(error), String(error?.message ?? error))
      }
    },
  }

  const stop = {
    name: 'mr_stop',
    description: '停止跟踪当前 MR（账本保留给看板）。已合并 / 已关闭的 MR 会自动结束，不需要调用本工具；forget=true 只删尚未结束的 MR 的账本——终态账本是看板历史，永远不会被删。',
    parameters: objectSchema({ forget: { type: 'boolean', description: '默认 false' } }),
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const unknown = unknownArgument(stop.parameters, args)
      if (unknown !== null) return fail('invalid-arguments', `未知参数：${unknown}`)
      const sessionId = exec?.agent?.session?.id
      try {
        // 先停定时器再解绑：避免解绑后还有一 tick 在途。
        watcher?.stop(sessionId)
        const result = await service.stop({ sessionId, forget: args?.forget === true })
        if (!result.stopped) return ok('当前会话没有绑定 MR。', result)
        if (result.kept === true) {
          const what = result.terminal === 'merged' ? '已合并' : '已关闭'
          return ok(`已停止跟踪。MR ${what}，账本是看板历史，已保留（未删除）。`, result)
        }
        return ok(result.forgotten ? '已停止跟踪并删除账本。' : '已停止跟踪该 MR（账本保留）。', result)
      } catch (error) {
        return fail(errorOf(error), String(error?.message ?? error))
      }
    },
  }

  const resume = {
    name: 'mr_resume',
    description: '从暂停状态恢复监视（守卫暂停、空闲暂停、token 修好后）。',
    parameters: objectSchema({}),
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const unknown = unknownArgument(resume.parameters, args)
      if (unknown !== null) return fail('invalid-arguments', `未知参数：${unknown}`)
      const sessionId = exec?.agent?.session?.id
      try {
        await service.resume({ sessionId })
        watcher?.start(sessionId)
        return ok('已恢复监视。', service.getState(sessionId))
      } catch (error) {
        return fail(errorOf(error), String(error?.message ?? error))
      }
    },
  }

  const recover = {
    name: 'mr_recover',
    description: '把已合并 / 已关闭、但 MR 看板里没有的 MR 补录回看板：按 GitLab 评审 note 的 AI_REVIEW_SHA 重建轮次，不启动监视。已有账本时原样不动。',
    parameters: objectSchema({ url: MR_URL }, ['url']),
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const unknown = unknownArgument(recover.parameters, args)
      if (unknown !== null) return fail('invalid-arguments', `未知参数：${unknown}`)
      const url = typeof args?.url === 'string' ? args.url.trim() : ''
      if (url === '') return fail('invalid-arguments', 'url 必填')
      try {
        const result = await service.recover({ url })
        if (result.recovered === false) {
          return ok(`MR !${result.iid} 已经在看板里（${result.rounds} 轮、${result.problems} 个问题），不需要补录。`, result)
        }
        const what = result.state === 'merged' ? '已合并' : '已关闭'
        return ok(`已补录 MR !${result.iid}（${what}）：${result.rounds} 轮评审、${result.problems} 个问题；看板里现在能看到它。`, result)
      } catch (error) {
        return fail(errorOf(error), String(error?.message ?? error))
      }
    },
  }

  return [bind, status, review, waive, stop, resume, recover]
}
