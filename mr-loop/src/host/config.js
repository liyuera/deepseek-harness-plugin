/**
 * 配置解析：纯函数，无 I/O。所有键都有默认值，未知键忽略（bundle patch 可能带别的字段）。
 * 数值键一律整数且不低于下限，非法值立刻抛 ConfigError，不做静默纠正。
 */
export class ConfigError extends Error {
  constructor(key, reason) {
    super(`配置项 ${key} ${reason}`)
    this.name = 'ConfigError'
    this.code = 'invalid-config'
  }
}

const DEFAULTS = Object.freeze({
  enabled: true,
  baseUrl: 'https://git.htwisdom.cn',
  tokenFile: '~/.dsh/mr-loop/gitlab-token',
  ledgerDir: '~/.dsh/mr-loop/ledger',
  pollWatchingMs: 60000,
  pollAwaitingMs: 10000,
  pollSettleMs: 15000,
  pollNoPipelineMs: 20000,
  roundTimeoutMs: 900000,
  gateSettleMs: 180000,
  maxRounds: 0,
  stallRounds: 3,
  reverifyStreak: 3,
  wallClockMs: 43200000,
  idleStopMs: 1800000,
  requestTimeoutMs: 15000,
  reviewMarker: 'AI Code Review',
  reviewTitlePrefix: 'AI Code Review (',
  sensitiveTitle: 'Sensitive Content Gate',
  mandatoryTitle: '必过项完整性检查',
  ledgerKeepRounds: 50,
})

/** 数值键 → 允许的最小值。`maxRounds` 例外：0 表示不限。 */
const MIN = Object.freeze({
  pollWatchingMs: 5000,
  pollAwaitingMs: 5000,
  pollSettleMs: 5000,
  pollNoPipelineMs: 5000,
  roundTimeoutMs: 60000,
  gateSettleMs: 30000,
  stallRounds: 1,
  reverifyStreak: 1,
  wallClockMs: 60000,
  idleStopMs: 60000,
  requestTimeoutMs: 1000,
  ledgerKeepRounds: 1,
})

const STRING_KEYS = Object.freeze([
  'tokenFile', 'ledgerDir', 'reviewMarker', 'reviewTitlePrefix', 'sensitiveTitle', 'mandatoryTitle',
])

function normalizeBaseUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError('baseUrl', '不是合法 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError('baseUrl', '只支持 http 或 https')
  if (url.username || url.password) throw new ConfigError('baseUrl', '不能包含用户名或密码')
  if (url.search) throw new ConfigError('baseUrl', '不能包含查询参数')
  if (url.hash) throw new ConfigError('baseUrl', '不能包含片段')
  const pathname = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${pathname}`
}

function positiveInt(value, key, min) {
  if (!Number.isSafeInteger(value) || value < min) throw new ConfigError(key, `必须是不小于 ${min} 的整数`)
  return value
}

/**
 * @param {Record<string, unknown>} [raw] bundle patch 里的 config 行
 * @returns {Readonly<typeof DEFAULTS>}
 */
export function resolveConfig(raw = {}) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const cfg = { ...DEFAULTS }

  if (input.enabled !== undefined) cfg.enabled = input.enabled !== false
  if (input.baseUrl !== undefined) {
    if (typeof input.baseUrl !== 'string' || input.baseUrl.trim() === '') throw new ConfigError('baseUrl', '不能为空')
    cfg.baseUrl = normalizeBaseUrl(input.baseUrl.trim())
  }
  for (const key of STRING_KEYS) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'string' || input[key].trim() === '') throw new ConfigError(key, '不能为空')
    cfg[key] = input[key].trim()
  }
  if (input.maxRounds !== undefined) cfg.maxRounds = positiveInt(input.maxRounds, 'maxRounds', 0)
  for (const [key, min] of Object.entries(MIN)) {
    if (input[key] !== undefined) cfg[key] = positiveInt(input[key], key, min)
  }
  return Object.freeze(cfg)
}
