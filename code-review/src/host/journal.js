/**
 * 审查留痕：优先持久化到 storageDomain（可选 peer），不可用时降级内存；
 * `/review` 用 formatJournal 把最近记录渲染成脚注。
 * @module @liyuera/dsh-code-review/host/journal
 */
const DOMAIN_NAME = 'code_review'
const TABLE_NAME = 'reviews'
const MAX_PER_SESSION = 50
const MAX_FINDINGS = 10

const pickFinding = (finding) => ({
  ruleId: String(finding.ruleId ?? ''),
  dimension: String(finding.dimension ?? ''),
  severity: String(finding.severity ?? ''),
  location: String(finding.location ?? ''),
  problem: String(finding.problem ?? ''),
  ...(finding.fingerprint === undefined ? {} : { fingerprint: String(finding.fingerprint) }),
  ...(finding.fixMode === undefined ? {} : { fixMode: String(finding.fixMode) }),
  ...(finding.verified === undefined ? {} : { verified: String(finding.verified) }),
  ...(finding.evidenceStatus === undefined ? {} : { evidenceStatus: String(finding.evidenceStatus) }),
})

const keyOf = (record) => `${record.sessionId}:${record.seq}:${record.startedAt}`

export function createJournalCore({ logger, now = Date.now } = {}) {
  const memory = new Map()
  let table
  let domain

  const remember = (record) => {
    const list = memory.get(record.sessionId) ?? []
    const index = list.findIndex((item) => keyOf(item) === keyOf(record))
    if (index >= 0) list[index] = record
    else list.push(record)
    list.sort((left, right) => left.startedAt - right.startedAt)
    if (list.length > MAX_PER_SESSION) list.splice(0, list.length - MAX_PER_SESSION)
    memory.set(record.sessionId, list)
  }

  const pruneTable = async (sessionId) => {
    if (!table) return
    try {
      const rows = [...table.entries()]
        .filter(([, value]) => value?.sessionId === sessionId)
        .map(([key, value]) => ({ key, startedAt: value.startedAt }))
        .sort((left, right) => left.startedAt - right.startedAt)
      const extra = rows.slice(0, Math.max(0, rows.length - MAX_PER_SESSION))
      if (extra.length > 0) await table.deleteMany(extra.map((row) => row.key))
    } catch (error) {
      logger?.warn?.(`[code-review] 留痕裁剪失败：${error.message}`)
    }
  }

  const write = (record) => {
    remember(record)
    if (!table) return
    void table.put(keyOf(record), record)
      .then(() => pruneTable(record.sessionId))
      .catch((error) => logger?.warn?.(`[code-review] 留痕写入失败：${error.message}`))
  }

  const find = (key) => {
    if (table) {
      try {
        const found = table.get(key)
        if (found !== undefined) return found
      } catch (error) {
        logger?.warn?.(`[code-review] 留痕读取失败：${error.message}`)
      }
    }
    for (const list of memory.values()) {
      const hit = list.find((item) => keyOf(item) === key)
      if (hit !== undefined) return hit
    }
    return undefined
  }

  return {
    attach(nextTable, nextDomain) {
      table = nextTable
      domain = nextDomain
    },
    start({ sessionId, turn, seq, mode, files, startedAt }) {
      const record = {
        sessionId, turn, seq, mode,
        startedAt: startedAt ?? now(), finishedAt: null,
        status: 'running', reason: null,
        files, findingsTotal: 0, findings: [], injected: false,
      }
      write(record)
      return keyOf(record)
    },
    settle(key, patch = {}) {
      const current = find(key)
      if (current === undefined) return
      write({
        ...current,
        finishedAt: now(),
        status: patch.status ?? 'completed',
        reason: patch.reason ?? null,
        findingsTotal: Array.isArray(patch.findings) ? patch.findings.length : current.findingsTotal,
        findings: Array.isArray(patch.findings) ? patch.findings.slice(0, MAX_FINDINGS).map(pickFinding) : current.findings,
        injected: patch.injected === true,
        ...(patch.coverage === undefined ? {} : { coverage: patch.coverage }),
        ...(patch.verification === undefined ? {} : { verification: patch.verification }),
        ...(patch.suppressed === undefined ? {} : { suppressed: patch.suppressed }),
      })
    },
    cancel(key, reason) {
      const current = find(key)
      if (current === undefined) return
      write({ ...current, finishedAt: now(), status: 'cancelled', reason })
    },
    recent(sessionId, limit = 5) {
      // 内存始终是最新写入方；存储可能缺失或写失败，因此合并两侧并按 key 去重，
      // 保证降级/半降级状态下历史不丢。
      const merged = new Map()
      if (table) {
        try {
          for (const [, value] of table.entries()) {
            if (value?.sessionId === sessionId) {
              merged.set(keyOf(value), value)
            }
          }
        } catch (error) {
          logger?.warn?.(`[code-review] 留痕读取失败：${error.message}`)
        }
      }
      for (const value of memory.get(sessionId) ?? []) {
        merged.set(keyOf(value), value)
      }
      // 按“最近活动时间”倒序：已结算记录（有 finishedAt）排在前面并按 finishedAt 倒序，
      // 刚取消的因此排最前；在途记录按 startedAt 倒序补在后面。
      const settled = (record) => record.finishedAt !== null && record.finishedAt !== undefined
      return [...merged.values()]
        .sort((left, right) => {
          if (settled(left) !== settled(right)) return settled(left) ? -1 : 1
          return settled(left)
            ? right.finishedAt - left.finishedAt
            : (right.startedAt ?? 0) - (left.startedAt ?? 0)
        })
        .slice(0, limit)
    },
    async dispose() {
      const handle = domain
      table = undefined
      domain = undefined
      if (handle === undefined) return
      try {
        await handle.close()
      } catch (error) {
        logger?.warn?.(`[code-review] 留痕关闭失败：${error.message}`)
      }
    },
  }
}

const RECORD_SCHEMA = (z) => z.object({
  sessionId: z.string(),
  turn: z.number(),
  seq: z.number(),
  mode: z.enum(['turn', 'full']),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  status: z.enum(['running', 'completed', 'cancelled', 'timeout', 'failed']),
  reason: z.string().nullable(),
  files: z.number(),
  findingsTotal: z.number(),
  findings: z.array(z.object({
    ruleId: z.string(), dimension: z.string(), severity: z.string(),
    location: z.string(), problem: z.string(),
    fingerprint: z.string().optional(),
    fixMode: z.string().optional(),
    verified: z.string().optional(),
    evidenceStatus: z.string().optional(),
  })).max(MAX_FINDINGS),
  injected: z.boolean(),
  coverage: z.object({
    reviewed: z.number(), skipped: z.number(), unaccounted: z.number(),
    valid: z.boolean(), missing: z.boolean().optional(),
  }).optional(),
  verification: z.object({
    checked: z.number(), confirmed: z.number(), rejected: z.number(), unverified: z.number(),
  }).optional(),
  suppressed: z.number().optional(),
})

async function attachStorage(journal, storageDomain, logger) {
  try {
    const [{ defineDomain, domainTable }, { z }] = await Promise.all([
      import('@deepseek-ai/dsh-storage-domain'),
      import('zod'),
    ])
    const spec = defineDomain({
      name: DOMAIN_NAME,
      version: 1,
      tables: { [TABLE_NAME]: domainTable(RECORD_SCHEMA(z)) },
    })
    const domain = await storageDomain.open(spec)
    journal.attach(domain.table(TABLE_NAME), domain)
  } catch (error) {
    logger?.warn?.(`[code-review] 留痕存储不可用，降级为内存：${error.message}`)
  }
}

export function createJournal({ ctx, logger, now = Date.now } = {}) {
  const journal = createJournalCore({ logger, now })
  const storageDomain = ctx?.get?.('storageDomain')
  if (storageDomain === undefined) {
    logger?.debug?.('[code-review] storageDomain 不可用，留痕仅存内存')
    return journal
  }
  void attachStorage(journal, storageDomain, logger)
  return journal
}

export function formatJournal(records, { now = Date.now } = {}) {
  if (!Array.isArray(records) || records.length === 0) return ''
  const timeOf = (value) => new Date(value).toTimeString().slice(0, 5)
  const lines = ['自动审查记录（最近 5 条）:']
  for (const record of records) {
    const mode = record.mode === 'full' ? '全量' : '单轮'
    let result
    if (record.status === 'running') result = '进行中'
    else if (record.status === 'completed') {
      const extra = []
      if (record.coverage !== undefined && record.coverage.valid === true) {
        extra.push(`覆盖 ${record.coverage.reviewed}/${record.coverage.reviewed + record.coverage.skipped}`)
      }
      if (record.verification !== undefined && record.verification.checked > 0) {
        extra.push(`复验 ${record.verification.confirmed}/${record.verification.checked}`)
      }
      if (record.suppressed !== undefined && record.suppressed > 0) extra.push(`抑制 ${record.suppressed}`)
      result = `完成 · ${record.findingsTotal} 条建议（${record.injected ? '已回灌' : '未回灌'}）${extra.length > 0 ? ` · ${extra.join(' · ')}` : ''}`
    } else if (record.status === 'cancelled') result = `已取消（${record.reason ?? '未知原因'}）· 未出结论`
    else if (record.status === 'timeout') result = '超时 · 未出结论'
    else result = `失败（${record.reason ?? '未知原因'}）· 未出结论`
    lines.push(`- ${timeOf(record.startedAt)} turn ${record.turn} · ${mode} · ${result}`)
  }
  const interrupted = records.find((record) => record.status === 'cancelled' || record.status === 'running')
  if (interrupted !== undefined) {
    lines.push(`⚠ ${timeOf(interrupted.startedAt)} 那次自动审查没有结论（${interrupted.reason ?? interrupted.status}），该 diff 未被审查。`)
  }
  return lines.join('\n')
}
