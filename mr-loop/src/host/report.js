/**
 * 报告渲染：纯函数、固定形状。每轮长得一样，才好扫。
 * 只陈述事实（含 unknown 与取证片段），不写「请修复」这类指令——修不修由主代理判断。
 */
const OK = '✅'
const BAD = '⛔'
const PENDING = '⏳'
const WARN = '⚠️'

const pad = (label) => `${label.padEnd(5, ' ')}`
const ago = (now, iso) => {
  const time = Date.parse(iso ?? '')
  if (!Number.isFinite(time)) return ''
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  return seconds < 60 ? `${seconds} 秒前` : `${Math.round(seconds / 60)} 分钟前`
}

const verdictLine = (review) => {
  if (review === null || review === undefined) return `${PENDING} 未出`
  if (review.verdict === 'pass') return `${OK} 可直接合并`
  if (review.verdict === 'changes') return `${BAD} 需要修改`
  return `${PENDING} 解析失败（unknown）`
}

/**
 * @param {{ binding: object, mr: object, round: object|null, decisions: object, mergeability: object, paused: object|null, now: number }} input
 * @returns {string}
 */
export function renderReport({ binding, mr, round, decisions = {}, mergeability, paused = null, now = Date.now() }) {
  const lines = []
  lines.push(`MR !${binding.iid} · ${binding.projectPath}`)
  const bindingLabel = round?.binding === 'strong' ? '强绑定' : round?.binding === 'weak' ? '弱绑定（无 SHA 证明）' : '无评审'
  lines.push(`${binding.sourceBranch} → ${binding.targetBranch} · 第 ${round?.n ?? 0} 轮 · sha ${String(mr.sha ?? '').slice(0, 8)}（${bindingLabel}）`)

  const review = round?.review ?? null
  const reviewTail = review === null
    ? ''
    : ` · 历史未收敛 ${review.historicalUnresolved ?? '?'} · 本轮已验证修复 ${review.verifiedFixed ?? '?'}${review.jobDuration ? ` · Job ${review.jobDuration}` : ''}`
  lines.push(`${pad('评审')}${verdictLine(review)}${reviewTail}`)

  const sensitive = round?.sensitive ?? null
  const sensitiveLine = sensitive === null
    ? `${PENDING} 未出`
    : sensitive.verdict === 'pass'
      ? `${OK} 门禁通过 · 共 ${sensitive.total ?? '?'} / 历史豁免 ${sensitive.waived ?? '?'} / 当前有效 ${sensitive.effective ?? '?'}`
      : sensitive.verdict === 'block'
        ? `${BAD} 阻止合并 · 有效 ${sensitive.effective ?? '?'} 条 / 阻断项 ${sensitive.blocking ?? '?'}`
        : `${PENDING} 解析失败（unknown）`
  lines.push(`${pad('敏感')}${sensitiveLine}`)

  const mandatory = round?.mandatory ?? null
  const mandatoryLine = mandatory === null
    ? `${PENDING} 无本轮结论`
    : mandatory.verdict === 'pass'
      ? `${OK} 通过`
      : mandatory.verdict === 'block'
        ? `${BAD} 阻止合并（敏感 ${mandatory.items?.sensitive ?? '?'} / 评审 ${mandatory.items?.review ?? '?'} / 证据 ${mandatory.items?.evidence ?? '?'}）`
        : `${PENDING} 解析失败（unknown）`
  lines.push(`${pad('必过')}${mandatoryLine}`)

  const blocking = Array.isArray(review?.blocking) ? review.blocking : []
  const openItems = blocking.filter((item) => decisions[item.fid] === undefined)
  lines.push(`${pad('阻塞')}${openItems.length === 0 ? '无' : openItems.map((item) => `#${item.fid} · ${item.level ?? '?'}`).join('；')}`)

  const pendingWaives = Object.values(decisions).filter((decision) => decision?.kind === 'waive' && decision?.noteId === undefined)
  lines.push(`${pad('待点头')}${pendingWaives.length === 0 ? '（无）' : `${pendingWaives.length} 条豁免草稿`}`)

  // 降级是「GitLab 合并态口径」的事实，与结论是否可合无关：可合、不可合都要标出来。
  const degradedSuffix = mergeability.degraded ? `（${WARN} 降级判定）` : ''
  const mergeLine = mergeability.mergeable
    ? `${OK} 可合${degradedSuffix}`
    : `${BAD} 差 ${mergeability.missing.length} 项：${mergeability.missing.join('；')}${degradedSuffix}`
  lines.push(`${pad('合并')}${mergeLine}`)

  if (paused !== null && paused !== undefined) {
    lines.push(`${pad('暂停')}${paused.reason}（${ago(now, paused.at)}）—— /mr resume 继续`)
  }

  return lines.join('\n')
}
