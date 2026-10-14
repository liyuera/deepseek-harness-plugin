/**
 * The activity record behind the status strip: what the host reports while a
 * tool runs, per session, and that wrapping a definition observes without
 * changing what the tool declares or returns.
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ActivityTracker, withActivity } from '../src/activity.ts'

describe('ActivityTracker', () => {
  it('reports nothing before any call', () => {
    expect(new ActivityTracker().snapshot('s1')).toEqual({ active: false })
  })

  it('reports the running call with its tool and tab', () => {
    const activity = new ActivityTracker()
    const end = activity.begin('chrome_click', '7', 's1')
    expect(activity.snapshot('s1')).toMatchObject({ active: true, tool: 'chrome_click', tabId: '7' })
    expect(Number(activity.snapshot('s1').startedAt)).toBeGreaterThan(0)
    end()
    expect(activity.snapshot('s1')).toMatchObject({ active: false, lastTool: 'chrome_click' })
  })

  it('omits the tab when the call named none', () => {
    const activity = new ActivityTracker()
    activity.begin('chrome_tabs', undefined, 's1')
    const snapshot = activity.snapshot('s1')
    expect(snapshot.active).toBe(true)
    expect('tabId' in snapshot).toBe(false)
  })

  it('scopes the running call to its own session', () => {
    const activity = new ActivityTracker()
    activity.begin('chrome_click', '7', 's1')
    expect(activity.snapshot('s1').active).toBe(true)
    expect(activity.snapshot('s2').active).toBe(false)
  })

  it('counts a call that named no session for whoever is asking', () => {
    // One browser per plugin instance: an unidentified call is still this
    // caller's call, so the strip does not stay silent through it.
    const activity = new ActivityTracker()
    const end = activity.begin('chrome_read', '3', undefined)
    expect(activity.snapshot('s1')).toMatchObject({ active: true, tool: 'chrome_read' })
    end()
    expect(activity.snapshot('s1').active).toBe(false)
  })

  it('reports the newest call when several run at once', () => {
    const activity = new ActivityTracker()
    activity.begin('chrome_read', '1', 's1')
    activity.begin('chrome_click', '2', 's1')
    expect(activity.snapshot('s1').tool).toBe('chrome_click')
  })

  it('tolerates a disposer called twice', () => {
    const activity = new ActivityTracker()
    const end = activity.begin('chrome_read', '1', 's1')
    end()
    expect(() => end()).not.toThrow()
    expect(activity.snapshot('s1')).toEqual({ active: false, lastTool: 'chrome_read', lastAt: expect.any(Number) })
  })

  it('clears everything on unload', () => {
    const activity = new ActivityTracker()
    activity.begin('chrome_read', '1', 's1')
    activity.clear()
    expect(activity.snapshot('s1')).toEqual({ active: false })
  })
})

describe('withActivity', () => {
  /** A minimal definition whose execution the test controls. */
  function definition(run: () => Promise<unknown>): ToolDefinition {
    return {
      name: 'chrome_click',
      description: 'click',
      parameters: {},
      output: { schema: { type: 'json' }, render: () => [] },
      presentCall: () => ({ card: 'generic', title: 'click' }),
      isConcurrencySafe: () => false,
      execute: run,
    } as unknown as ToolDefinition
  }

  it('carries every declared member over unchanged', () => {
    const activity = new ActivityTracker()
    const original = definition(async () => ({ ok: true }))
    const wrapped = withActivity(original, activity)
    expect(wrapped.name).toBe(original.name)
    expect(wrapped.description).toBe(original.description)
    expect(wrapped.output).toBe(original.output)
    expect(wrapped.presentCall).toBe(original.presentCall)
    expect(wrapped.isConcurrencySafe).toBe(original.isConcurrencySafe)
  })

  it('records the call while it runs and releases it after', async () => {
    const activity = new ActivityTracker()
    let seenDuring: unknown
    const wrapped = withActivity(definition(async () => {
      seenDuring = activity.snapshot('s1')
      return { ok: true }
    }), activity)

    const value = await wrapped.execute({ tabId: '7' }, { agent: { session: { id: 's1' } } } as never)
    expect(value).toEqual({ ok: true })
    expect(seenDuring).toMatchObject({ active: true, tool: 'chrome_click', tabId: '7' })
    expect(activity.snapshot('s1')).toMatchObject({ active: false, lastTool: 'chrome_click' })
  })

  it('releases the call when the tool throws', async () => {
    const activity = new ActivityTracker()
    const wrapped = withActivity(definition(async () => { throw new Error('boom') }), activity)
    await expect(wrapped.execute({}, { agent: { session: { id: 's1' } } } as never)).rejects.toThrow('boom')
    expect(activity.snapshot('s1').active).toBe(false)
  })

  it('reads the tab and session defensively', async () => {
    const activity = new ActivityTracker()
    let seenDuring: ReturnType<ActivityTracker['snapshot']> | undefined
    const wrapped = withActivity(definition(async () => {
      seenDuring = activity.snapshot('s1')
      return null
    }), activity)
    await wrapped.execute({ tabId: 42 }, { agent: { session: { id: '' } } } as never)
    expect(seenDuring?.active).toBe(true)
    expect(seenDuring?.tabId).toBeUndefined()
  })
})
