/**
 * Browser-side activity probe: `GET /chrome-browser/activity` behind a short
 * cache.
 *
 * The strip polls this while a session view is open, so a dropped request or an
 * unreachable host answers "not active" rather than throwing into React: an
 * indicator that flickers an error is worse than one that stays hidden.
 * @module @liyuera/dsh-chrome-browser/client/activity
 */

/** One snapshot as the host route answers it. */
export interface ActivityInfo {
  active: boolean
  tool?: string
  tabId?: string
  startedAt?: number
  lastTool?: string
  lastAt?: number
}

/** One snapshot per this window, however many callers ask. */
const CACHE_MS = 900

/** Host answer for the activity route. */
interface ActivityAnswer extends Partial<ActivityInfo> {
  ok: boolean
  error?: string
}

const IDLE: ActivityInfo = { active: false }

let cachedAt = 0
let cached: ActivityInfo = IDLE
let inflight: Promise<ActivityInfo> | null = null

async function fetchActivity(sessionId: string): Promise<ActivityInfo> {
  try {
    const query = sessionId === '' ? '' : `?sessionId=${encodeURIComponent(sessionId)}`
    const response = await fetch(`/chrome-browser/activity${query}`)
    const body = await response.json() as ActivityAnswer
    if (body.ok !== true) throw new Error(body.error ?? 'activity probe failed')
    cached = {
      active: body.active === true,
      ...(body.tool === undefined ? {} : { tool: body.tool }),
      ...(body.tabId === undefined ? {} : { tabId: body.tabId }),
      ...(body.startedAt === undefined ? {} : { startedAt: body.startedAt }),
      ...(body.lastTool === undefined ? {} : { lastTool: body.lastTool }),
      ...(body.lastAt === undefined ? {} : { lastAt: body.lastAt }),
    }
  } catch {
    // The strip stays hidden; the plugin README and the extension status route
    // own telling the user why the host is unreachable.
    cached = IDLE
  }
  cachedAt = Date.now()
  return cached
}

/**
 * Read the plugin's current activity for one session.
 * @param sessionId - the session the strip belongs to.
 * @returns the snapshot, or an inactive one while the host is unreachable.
 */
export async function readChromeActivity(sessionId: string): Promise<ActivityInfo> {
  if (Date.now() - cachedAt < CACHE_MS) return cached
  inflight ??= fetchActivity(sessionId).finally(() => { inflight = null })
  return inflight
}

/** Drop the cache; exposed so a test can start from a clean probe. */
export function resetChromeActivityCache(): void {
  cachedAt = 0
  cached = IDLE
  inflight = null
}
