/**
 * What the plugin is doing right now, for the persistent header indicator.
 *
 * The host half is the only place that knows a call is in flight, so it records
 * every tool execution here and serves the snapshot over its own route; the
 * browser half polls that route and renders one chip in the Session header.
 * Nothing is persisted, and nothing crosses into the model's request.
 * @module @liyuera/dsh-chrome-browser/activity
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/**
 * How long a settled call stays on screen before the chip returns to idle.
 * Short enough not to linger, long enough that a call finishing between two
 * polls is still seen: the browser half polls at POLL_MS, so a hold shorter
 * than one poll interval can be missed entirely.
 */
export const DONE_HOLD_MS = 2_500

/** How long a failure stays on screen. Longer: it asks to be read. */
export const ERROR_HOLD_MS = 7_000

/** Longest failure text carried to the chip; the card holds the full one. */
const DETAIL_LIMIT = 120

/** Which of the four things the chip can be saying. */
export type ActivityPhase = 'running' | 'done' | 'error' | 'ready'

/** What the browser half renders from. */
export interface ActivitySnapshot {
  /** Current phase for the session being asked about. */
  readonly phase: ActivityPhase
  /** Tool the phase belongs to, when it belongs to a call. */
  readonly tool?: string
  /** Tab that call named, when it named one. */
  readonly tabId?: string
  /** Failure text, shortened, when the phase is `error`. */
  readonly detail?: string
  /** Epoch milliseconds this phase began, or the last call's start. */
  readonly since: number
}

/** One in-flight call. */
interface Running {
  tool: string
  tabId?: string
  sessionId?: string
  startedAt: number
}

/** How the most recent call in one session ended. */
interface Settled {
  tool: string
  ok: boolean
  tabId?: string
  detail?: string
  at: number
}

/** Route-facing view of one snapshot. */
export type ActivityAnswer = Record<string, string | number | boolean>

/**
 * In-flight and recently finished browser calls, keyed by session when the
 * caller has one.
 *
 * The tracker holds facts, not timers: `snapshot` decides whether a settled
 * call is still worth showing from the clock alone. That keeps a host tick out
 * of the loop and means a browser that polls late sees the same answer a
 * host-side timer would have produced.
 */
export class ActivityTracker {
  private readonly running: Running[] = []
  private readonly settled = new Map<string, Settled>()

  /** Session key for a caller with no session identity. */
  private static readonly ANONYMOUS = ''

  /**
   * Record one call as started.
   * @param tool - the tool name.
   * @param tabId - the tab the call named, when it named one.
   * @param sessionId - the calling session, when the execution carried one.
   * @returns the disposer that records how the call ended; idempotent.
   */
  begin(tool: string, tabId: string | undefined, sessionId: string | undefined): (ok: boolean, detail?: string) => void {
    const entry: Running = {
      tool,
      startedAt: Date.now(),
      ...(tabId === undefined ? {} : { tabId }),
      ...(sessionId === undefined ? {} : { sessionId }),
    }
    this.running.push(entry)
    let ended = false
    return (ok: boolean, detail?: string) => {
      if (ended) return
      ended = true
      const at = this.running.indexOf(entry)
      if (at >= 0) this.running.splice(at, 1)
      const shortened = detail === undefined ? undefined : detail.slice(0, DETAIL_LIMIT)
      this.settled.set(sessionId ?? ActivityTracker.ANONYMOUS, {
        tool,
        ok,
        at: Date.now(),
        ...(entry.tabId === undefined ? {} : { tabId: entry.tabId }),
        ...(ok || shortened === undefined ? {} : { detail: shortened }),
      })
    }
  }

  /**
   * The current state for one session.
   * @param sessionId - the session to report on; omit for the most recent call in any session.
   * @returns the snapshot the chip renders from.
   */
  snapshot(sessionId?: string): ActivitySnapshot {
    const key = sessionId ?? ActivityTracker.ANONYMOUS
    // A call that named no session belongs to whoever is asking: the plugin has
    // one browser, so an unidentified call is still this caller's call.
    const running = [...this.running].reverse()
      .find(entry => entry.sessionId === undefined || sessionId === undefined || entry.sessionId === key)
    if (running !== undefined) {
      return {
        phase: 'running',
        tool: running.tool,
        since: running.startedAt,
        ...(running.tabId === undefined ? {} : { tabId: running.tabId }),
      }
    }
    const settled = this.settled.get(key)
    if (settled !== undefined) {
      const hold = settled.ok ? DONE_HOLD_MS : ERROR_HOLD_MS
      if (Date.now() - settled.at < hold) {
        return {
          phase: settled.ok ? 'done' : 'error',
          tool: settled.tool,
          since: settled.at,
          ...(settled.tabId === undefined ? {} : { tabId: settled.tabId }),
          ...(settled.detail === undefined ? {} : { detail: settled.detail }),
        }
      }
    }
    return { phase: 'ready', since: settled?.at ?? 0 }
  }

  /** Drop every record; the plugin calls this on unload. */
  clear(): void {
    this.running.length = 0
    this.settled.clear()
  }
}

/** The tab a call named, as the tracker reads it from frozen arguments. */
function tabIdOf(args: unknown): string | undefined {
  const value = (args as { tabId?: unknown } | null | undefined)?.tabId
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The executing session id, as the tracker reads it from the execution. */
function sessionIdOf(exec: unknown): string | undefined {
  const session = (exec as { agent?: { session?: { id?: unknown } } } | null | undefined)?.agent?.session
  const id = session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/** A thrown value as one line of text for the chip. */
function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * Wrap one tool definition so its execution is visible to the header chip.
 *
 * Every other member is carried over untouched: this adds observation, it does
 * not change what the tool declares or returns.
 * @param definition - the registered definition.
 * @param activity - the tracker the browser half reads.
 * @returns an equivalent definition that reports the call.
 */
export function withActivity(definition: ToolDefinition, activity: ActivityTracker): ToolDefinition {
  const run = definition.execute
  return {
    ...definition,
    async execute(args: unknown, exec: unknown): Promise<unknown> {
      const end = activity.begin(definition.name, tabIdOf(args), sessionIdOf(exec))
      try {
        const value: unknown = await run(args, exec as never)
        end(true)
        return value
      } catch (error) {
        end(false, messageOf(error))
        throw error
      }
    },
  }
}
