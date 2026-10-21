/**
 * Bridge reconnection policy.
 *
 * A restarted dsh host takes seconds to bind its bridge, while Chrome suspends
 * an idle MV3 service worker after 30s. The worker therefore stays warm for a
 * bounded window after losing a live connection (snappy retries that reset
 * Chrome's idle clock) and falls back to the 30s alarm afterwards. These tests
 * pin that policy and the wake-up wiring, because the failure mode is silent:
 * the extension simply does not reconnect until the user reloads it.
 */
import { describe, expect, it } from 'vitest'
import { EXTENSION_SOURCE, loadExtensionFunction } from './support/extension-source.ts'

interface RetryPlan {
  delay: number
  warm: boolean
  nextAttemptMs: number
}

type RetryPlanFn = (disconnectedAt: number, attemptMs: number, now: number) => RetryPlan

const retryPlan = loadExtensionFunction<RetryPlanFn>(['retryPlan'], 'retryPlan')()

describe('retry plan', () => {
  it('is cold when no connection was ever lost (fresh worker, alarm-driven)', () => {
    expect(retryPlan(0, 1000, 10_000)).toEqual({ delay: 1000, warm: false, nextAttemptMs: 2000 })
    expect(retryPlan(0, 5000, 10_000).nextAttemptMs).toBe(10_000)
  })

  it('stays warm right after a live connection is lost', () => {
    const now = 1_000_000
    expect(retryPlan(now - 1, 1000, now)).toEqual({ delay: 1000, warm: true, nextAttemptMs: 2000 })
    expect(retryPlan(now - 1, 4000, now).nextAttemptMs).toBe(5000)
  })

  it('caps warm retries at 5s and cold retries at 15s', () => {
    const now = 1_000_000
    expect(retryPlan(now - 1, 5000, now).nextAttemptMs).toBe(5000)
    expect(retryPlan(now - 300_001, 5000, now).nextAttemptMs).toBe(10_000)
    expect(retryPlan(now - 300_001, 10_000, now).nextAttemptMs).toBe(15_000)
  })

  it('turns cold exactly five minutes after the disconnect', () => {
    const now = 1_000_000
    expect(retryPlan(now - 299_999, 1000, now).warm).toBe(true)
    expect(retryPlan(now - 300_000, 1000, now).warm).toBe(false)
  })
})

describe('warm-window stamping', () => {
  type NextDisconnectAt = (opened: boolean, previous: number, now: number) => number
  const nextDisconnectAt = loadExtensionFunction<NextDisconnectAt>(['nextDisconnectAt'], 'nextDisconnectAt')()

  it('starts the window on a live socket loss', () => {
    expect(nextDisconnectAt(true, 0, 1234)).toBe(1234)
    expect(nextDisconnectAt(true, 999, 1234)).toBe(1234)
  })

  it('does not re-stamp the window on a failed attempt', () => {
    // A reconnect attempt that never opened only proves the host is still down;
    // re-stamping here would keep the worker warm forever.
    expect(nextDisconnectAt(false, 999, 1234)).toBe(999)
    expect(nextDisconnectAt(false, 0, 1234)).toBe(0)
  })

  it('is wired into the socket close path', () => {
    expect(EXTENSION_SOURCE).toContain('nextDisconnectAt(opened, disconnectedAt, Date.now())')
  })
})

describe('retry scheduling while the host is down', () => {
  interface Scheduler {
    now: number
    touches: number
    timers: number[]
    scheduleRetry: () => void
  }

  /** Build scheduleRetry over stubbed chrome/setTimeout/clock/disconnectedAt. */
  function makeScheduler(disconnectedAt: number): Scheduler {
    const state = { now: 0, touches: 0, timers: [] as number[] }
    const chrome = { alarms: { get: () => { state.touches += 1; return Promise.resolve(undefined) } } }
    const setTimeoutFake = (_fn: () => void, ms: number): void => { state.timers.push(ms) }
    const DateFake = { now: () => state.now }
    const build = loadExtensionFunction<(...args: unknown[]) => () => void>(
      ['nextDisconnectAt', 'retryPlan', 'touchWorker', 'scheduleRetry'],
      'scheduleRetry',
      ['chrome', 'setTimeout', 'connect', 'disconnectedAt', 'retryMs', 'Date'],
    )
    const scheduleRetry = build(chrome, setTimeoutFake, () => {}, disconnectedAt, 1000, DateFake)
    return {
      get now() { return state.now },
      set now(value: number) { state.now = value },
      get touches() { return state.touches },
      get timers() { return state.timers },
      scheduleRetry,
    }
  }

  it('keeps resetting the idle clock only inside the five-minute window', () => {
    const scheduler = makeScheduler(1_000_000)
    for (const now of [1_001_000, 1_060_000, 1_120_000, 1_299_999, 1_300_000, 1_360_000]) {
      scheduler.now = now
      scheduler.scheduleRetry()
    }
    // Four attempts fall inside the window (touches), the last two do not.
    expect(scheduler.touches).toBe(4)
    expect(scheduler.timers.at(-1)).toBe(10_000)
  })

  it('never warms a worker that has not lost a live connection yet', () => {
    const scheduler = makeScheduler(0)
    for (const now of [1_000, 60_000, 600_000]) {
      scheduler.now = now
      scheduler.scheduleRetry()
    }
    expect(scheduler.touches).toBe(0)
    // Cold cadence grows 1s -> 2s -> 4s regardless of how long the host stays down.
    expect(scheduler.timers).toEqual([1000, 2000, 4000])
  })
})

describe('wake-up wiring', () => {
  /** Build `wakeBridge` over a stubbed socket; returns the connect-call count. */
  function wakeCalls(socket: unknown): number {
    let calls = 0
    const wake = loadExtensionFunction<() => void>(['wakeBridge'], 'wakeBridge', ['socket', 'connect'])(
      socket,
      () => { calls += 1 },
    )
    wake()
    return calls
  }

  it('connects when no socket is live', () => {
    expect(wakeCalls(null)).toBe(1)
  })

  it('does not stack sockets while connecting or connected', () => {
    expect(wakeCalls({ readyState: 0 })).toBe(0)
    expect(wakeCalls({ readyState: 1 })).toBe(0)
  })

  it('is wired to tab and window activity so a restarted host is found immediately', () => {
    expect(EXTENSION_SOURCE).toContain('chrome.tabs.onActivated.addListener(() => wakeBridge())')
    expect(EXTENSION_SOURCE).toContain('chrome.tabs.onUpdated.addListener')
    expect(EXTENSION_SOURCE).toContain('chrome.windows.onFocusChanged.addListener(() => wakeBridge())')
  })

  it('keeps the worker warm only through the bounded retry window', () => {
    // scheduleRetry consults retryPlan, and only a warm plan touches the worker.
    const schedule = EXTENSION_SOURCE.slice(EXTENSION_SOURCE.indexOf('function scheduleRetry()'))
    expect(schedule.slice(0, 400)).toContain('retryPlan(disconnectedAt, retryMs, Date.now())')
    expect(schedule.slice(0, 400)).toContain('if (plan.warm) touchWorker()')
    expect(EXTENSION_SOURCE).toContain("chrome.alarms.get('dsh-bridge')")
  })
})
