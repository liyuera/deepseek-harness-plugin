/**
 * Browser-side activity probe: `GET /chrome-browser/activity` behind a short
 * cache.
 *
 * The header chip polls this while a session view is open. An unreachable host
 * answers "offline" rather than throwing into React: a chip that flickers an
 * error is worse than one that says the bridge is not there, which is also the
 * truth.
 * @module @liyuera/dsh-chrome-browser/client/activity
 */

/** Which of the states the chip can show. */
export type ActivityPhase = 'offline' | 'stale' | 'running' | 'done' | 'error' | 'ready'

/** One snapshot as the host route answers it. */
export interface ActivityInfo {
  /** State to render. */
  phase: ActivityPhase
  /** Tool the phase belongs to, when it belongs to a call. */
  tool?: string
  /** Tab that call named, when it named one. */
  tabId?: string
  /** Failure text, shortened, when the phase is `error`. */
  detail?: string
  /** Epoch milliseconds this phase began. */
  since?: number
}

/** One snapshot per this window, however many callers ask. */
const CACHE_MS = 400

/** Host answer for the activity route. */
interface ActivityAnswer extends Partial<ActivityInfo> {
  ok: boolean
  connected?: boolean
  stale?: boolean
  error?: string
}

/** What the chip shows when the host cannot be reached at all. */
const OFFLINE: ActivityInfo = { phase: 'offline' }

let cachedAt = 0
let cached: ActivityInfo = OFFLINE
let inflight: Promise<ActivityInfo> | null = null

/**
 * Turn one host answer into the phase the chip renders.
 *
 * The link decides first: an extension that is not attached, or is running
 * older files than the plugin ships, is a condition the user has to fix, and it
 * outranks whatever the last call happened to do — a `done` flash drawn on top
 * of a disconnected bridge would be actively misleading.
 * @param body - the parsed route answer.
 * @returns the phase and the fields that belong to it.
 */
function phaseOf(body: ActivityAnswer): ActivityInfo {
  const rest = {
    ...(body.tool === undefined ? {} : { tool: body.tool }),
    ...(body.tabId === undefined ? {} : { tabId: body.tabId }),
    ...(body.detail === undefined ? {} : { detail: body.detail }),
    ...(body.since === undefined ? {} : { since: body.since }),
  }
  if (body.connected === false) return { phase: 'offline', ...rest }
  if (body.stale === true) return { phase: 'stale', ...rest }
  const phase = body.phase
  if (phase === 'running' || phase === 'done' || phase === 'error') return { phase, ...rest }
  return { phase: 'ready', ...rest }
}

async function fetchActivity(sessionId: string): Promise<ActivityInfo> {
  try {
    const query = sessionId === '' ? '' : `?sessionId=${encodeURIComponent(sessionId)}`
    const response = await fetch(`/chrome-browser/activity${query}`)
    const body = await response.json() as ActivityAnswer
    if (body.ok !== true) throw new Error(body.error ?? 'activity probe failed')
    cached = phaseOf(body)
  } catch {
    // The chip says the bridge is not there; the README and the extension
    // status route own explaining why.
    cached = OFFLINE
  }
  cachedAt = Date.now()
  return cached
}

/**
 * Read the plugin's current activity for one session.
 * @param sessionId - the session the chip belongs to.
 * @returns the snapshot, or an offline one while the host is unreachable.
 */
export async function readChromeActivity(sessionId: string): Promise<ActivityInfo> {
  if (Date.now() - cachedAt < CACHE_MS) return cached
  inflight ??= fetchActivity(sessionId).finally(() => { inflight = null })
  return inflight
}

/** Drop the cache; exposed so a test can start from a clean probe. */
export function resetChromeActivityCache(): void {
  cachedAt = 0
  cached = OFFLINE
  inflight = null
}
