/**
 * What the plugin is doing right now, for the in-page status strip.
 *
 * The host half is the only place that knows a call is in flight, so it records
 * every tool execution here and serves the snapshot over its own route; the
 * browser half polls that route and renders a strip only while something is
 * running. Nothing is persisted, and nothing crosses into the model's request.
 * @module @liyuera/dsh-chrome-browser/activity
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** What one in-flight (or most recent) call looks like to the UI. */
export interface ActivitySnapshot {
  /** Whether a call is running right now. */
  readonly active: boolean
  /** Name of the running call, when one is running. */
  readonly tool?: string
  /** Tab the running call named, when it named one. */
  readonly tabId?: string
  /** Epoch milliseconds the running call started. */
  readonly startedAt?: number
  /** Name of the most recently finished call, when one has finished. */
  readonly lastTool?: string
  /** Epoch milliseconds the most recent call finished. */
  readonly lastAt?: number
}

/** One in-flight call. */
interface Running {
  tool: string
  tabId?: string
  sessionId?: string
  startedAt: number
}

/** Route-facing view of one snapshot. */
export type ActivityAnswer = Record<string, string | number | boolean>

/**
 * In-flight and last-finished browser calls, keyed by session when the caller
 * has one. A session that has never called anything reports inactive, which is
 * what the strip needs: absence of a call, not absence of a plugin.
 */
export class ActivityTracker {
  private readonly running: Running[] = []
  private readonly finished = new Map<string, { tool: string; at: number }>()

  /** Session key for a caller with no session identity. */
  private static readonly ANONYMOUS = ''

  /**
   * Record one call as started.
   * @param tool - the tool name.
   * @param tabId - the tab the call named, when it named one.
   * @param sessionId - the calling session, when the execution carried one.
   * @returns the disposer that records the call as finished; idempotent.
   */
  begin(tool: string, tabId: string | undefined, sessionId: string | undefined): () => void {
    const entry: Running = {
      tool,
      startedAt: Date.now(),
      ...(tabId === undefined ? {} : { tabId }),
      ...(sessionId === undefined ? {} : { sessionId }),
    }
    this.running.push(entry)
    let ended = false
    return () => {
      if (ended) return
      ended = true
      const at = this.running.indexOf(entry)
      if (at >= 0) this.running.splice(at, 1)
      this.finished.set(sessionId ?? ActivityTracker.ANONYMOUS, { tool, at: Date.now() })
    }
  }

  /**
   * The current state for one session.
   * @param sessionId - the session to report on; omit for the most recent call in any session.
   * @returns the snapshot the strip renders from.
   */
  snapshot(sessionId?: string): ActivitySnapshot {
    const key = sessionId ?? ActivityTracker.ANONYMOUS
    // A call that named no session belongs to whoever is asking: the plugin has
    // one browser, so an unidentified call is still this caller's call.
    const running = [...this.running].reverse()
      .find(entry => entry.sessionId === undefined || sessionId === undefined || entry.sessionId === key)
    const last = this.finished.get(key)
    return {
      active: running !== undefined,
      ...(running === undefined
        ? {}
        : {
            tool: running.tool,
            startedAt: running.startedAt,
            ...(running.tabId === undefined ? {} : { tabId: running.tabId }),
          }),
      ...(last === undefined ? {} : { lastTool: last.tool, lastAt: last.at }),
    }
  }

  /** Drop every record; the plugin calls this on unload. */
  clear(): void {
    this.running.length = 0
    this.finished.clear()
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

/**
 * Wrap one tool definition so its execution is visible to the status strip.
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
        return await run(args, exec as never)
      } finally {
        end()
      }
    },
  }
}
