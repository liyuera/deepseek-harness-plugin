/**
 * The state machine behind the header chip.
 *
 * What matters here is not that a call is recorded but how it *decays*: the
 * chip is always on screen, so every phase has to end, and the two phases that
 * ask for attention have to last long enough to be read. The browser half polls
 * once a second, so a hold shorter than that can be missed entirely.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ActivityTracker, DONE_HOLD_MS, ERROR_HOLD_MS, withActivity } from '../src/activity.ts'

/** A tool whose execution the test supplies; only the wrapper is under test. */
function tool(execute: () => Promise<unknown>): ToolDefinition {
  return { name: 'chrome_click', execute } as unknown as ToolDefinition
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ActivityTracker', () => {
  it('is ready with nothing running', () => {
    expect(new ActivityTracker().snapshot()).toEqual({ phase: 'ready', since: 0 })
  })

  it('is running for the life of a call', () => {
    const activity = new ActivityTracker()
    const end = activity.begin('chrome_click', '7', 'session-a')
    expect(activity.snapshot('session-a')).toMatchObject({ phase: 'running', tool: 'chrome_click', tabId: '7' })
    expect(Number(activity.snapshot('session-a').since)).toBeGreaterThan(0)
    end(true)
    expect(activity.snapshot('session-a').phase).toBe('done')
  })

  it('holds a success long enough for one poll to see it', () => {
    vi.useFakeTimers()
    const activity = new ActivityTracker()
    activity.begin('chrome_read', undefined, 's')(true)
    expect(activity.snapshot('s').phase).toBe('done')
    vi.advanceTimersByTime(DONE_HOLD_MS - 1)
    expect(activity.snapshot('s').phase).toBe('done')
    vi.advanceTimersByTime(2)
    expect(activity.snapshot('s').phase).toBe('ready')
  })

  it('holds a failure longer, and carries why', () => {
    vi.useFakeTimers()
    const activity = new ActivityTracker()
    activity.begin('chrome_navigate', undefined, 's')(false, 'chrome_navigate: no element matched "#x"')
    expect(activity.snapshot('s')).toMatchObject({
      phase: 'error',
      tool: 'chrome_navigate',
      detail: 'chrome_navigate: no element matched "#x"',
    })
    vi.advanceTimersByTime(DONE_HOLD_MS + 1)
    expect(activity.snapshot('s').phase, 'a failure must outlast a success').toBe('error')
    vi.advanceTimersByTime(ERROR_HOLD_MS)
    expect(activity.snapshot('s').phase).toBe('ready')
  })

  it('shortens a failure so the chip cannot be stretched by it', () => {
    const activity = new ActivityTracker()
    activity.begin('chrome_eval', undefined, 's')(false, 'x'.repeat(500))
    expect(activity.snapshot('s').detail).toHaveLength(120)
  })

  it('drops the detail of a success', () => {
    const activity = new ActivityTracker()
    activity.begin('chrome_read', undefined, 's')(true, 'irrelevant')
    expect(activity.snapshot('s').detail).toBeUndefined()
  })

  it('scopes a call to the session that made it', () => {
    const activity = new ActivityTracker()
    activity.begin('chrome_click', undefined, 'session-a')
    expect(activity.snapshot('session-b').phase).toBe('ready')
  })

  it('counts a call that named no session for whoever is asking', () => {
    // The plugin has one browser: an unidentified call is still this caller's.
    const activity = new ActivityTracker()
    activity.begin('chrome_click', undefined, undefined)
    expect(activity.snapshot('session-b').phase).toBe('running')
  })

  it('tolerates a disposer called twice', () => {
    const activity = new ActivityTracker()
    const end = activity.begin('chrome_click', undefined, 's')
    end(true)
    end(false, 'second call')
    expect(activity.snapshot('s').phase).toBe('done')
  })

  it('clears everything on unload', () => {
    const activity = new ActivityTracker()
    activity.begin('chrome_click', undefined, 's')
    activity.clear()
    expect(activity.snapshot('s')).toEqual({ phase: 'ready', since: 0 })
  })
})

describe('withActivity', () => {
  it('reports the call while it runs and the success after', async () => {
    const activity = new ActivityTracker()
    let during: string | undefined
    const wrapped = withActivity(tool(async () => {
      during = activity.snapshot().phase
      return 'ok'
    }), activity)
    await expect(wrapped.execute({ tabId: '7' }, {} as never)).resolves.toBe('ok')
    expect(during).toBe('running')
    expect(activity.snapshot()).toMatchObject({ phase: 'done', tool: 'chrome_click', tabId: '7' })
  })

  it('reports the failure and still rethrows it', async () => {
    const activity = new ActivityTracker()
    const wrapped = withActivity(tool(async () => {
      throw new Error('chrome_click: no element matched selector "#x"')
    }), activity)
    await expect(wrapped.execute({}, {} as never)).rejects.toThrow(/no element matched/u)
    expect(activity.snapshot()).toMatchObject({
      phase: 'error',
      detail: 'chrome_click: no element matched selector "#x"',
    })
  })

  it('reads the tab and the session defensively', async () => {
    // Tool arguments and executions arrive as unknown; a value that is not what
    // this expects must not take the tool down with it.
    const activity = new ActivityTracker()
    const wrapped = withActivity(tool(async () => 'ok'), activity)
    await wrapped.execute({ tabId: 7 }, { agent: { session: { id: 42 } } } as never)
    expect(activity.snapshot()).toMatchObject({ phase: 'done', tool: 'chrome_click' })
  })
})
