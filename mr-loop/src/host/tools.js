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
        const data = { round, decisions }
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

  const stop = {
    name: 'mr_stop',
    description: '停止跟踪当前 MR（保留账本）；forget=true 同时解绑并删除账本。',
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
        return ok(result.stopped ? '已停止跟踪。' : '当前会话没有绑定 MR。', result)
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
        service.resume({ sessionId })
        watcher?.start(sessionId)
        return ok('已恢复监视。', service.getState(sessionId))
      } catch (error) {
        return fail(errorOf(error), String(error?.message ?? error))
      }
    },
  }

  return [bind, status, review, stop, resume]
}
