import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  Chrome,
  chromeCandidates,
  copyUserProfileTo,
  defaultUserCopyProfileDir,
  defaultUserProfileDir,
  parseTabList,
  pickFaviconUrl,
  reclaimOwnedLeftover,
  resolveChromeConfig,
  resolveChromePath,
  resolveTab,
} from '../src/chrome.ts'

/** One target row, as `parseTabList` produces it — the type stays private to the module. */
type CdpTabTarget = ReturnType<typeof parseTabList>[number]

/**
 * A fake spawned Chrome: an emitter with the members `spawnChrome`/`dispose`
 * touch. `exitCode: null` is what makes `dispose` reach `kill`.
 */
function fakeProc(): { pid: number; exitCode: number | null; kill: (signal?: string) => void; stderr: EventEmitter } {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    pid: 42,
    exitCode: null as number | null,
    kill: vi.fn(),
    stderr: new EventEmitter(),
  }) as unknown as { pid: number; exitCode: number | null; kill: (signal?: string) => void; stderr: EventEmitter }
}

describe('parseTabList', () => {
  it('keeps page targets with a websocket url and maps fields', () => {
    const tabs = parseTabList([
      { id: 'p1', type: 'page', title: 'T', url: 'https://a.example', active: true, webSocketDebuggerUrl: 'ws://x' },
      { id: 'w1', type: 'background_page', title: 'Ext', url: 'chrome://x', active: false, webSocketDebuggerUrl: 'ws://y' },
      { id: 'p2', type: 'page', title: 'No ws', url: 'about:blank', active: false },
    ])
    expect(tabs.map(tab => tab.id)).toEqual(['p1'])
    expect(tabs[0]).toMatchObject({ title: 'T', url: 'https://a.example', active: true, wsUrl: 'ws://x' })
  })
})

describe('resolveTab', () => {
  const tabs: CdpTabTarget[] = [
    { id: 'a', title: 'A', url: 'x', active: false, wsUrl: 'ws://a' },
    { id: 'b', title: 'B', url: 'y', active: true, wsUrl: 'ws://b' },
  ]

  it('prefers an explicit id', () => {
    expect(resolveTab(tabs, 'a', undefined).id).toBe('a')
  })

  it('falls back to the session-bound tab', () => {
    expect(resolveTab(tabs, undefined, 'a').id).toBe('a')
    expect(resolveTab(tabs, 'active', 'a').id).toBe('a')
  })

  it('prefers the active tab when no id and no binding are given', () => {
    expect(resolveTab(tabs, undefined, undefined).id).toBe('b')
  })

  it('falls back to the first tab when none is active', () => {
    expect(resolveTab(tabs.map(tab => ({ ...tab, active: false })), undefined, undefined).id).toBe('a')
  })

  it('throws guidance for an unknown explicit id', () => {
    expect(() => resolveTab(tabs, 'zzz', undefined)).toThrow('chrome_tabs')
  })

  it('throws when there are no tabs', () => {
    expect(() => resolveTab([], undefined, undefined)).toThrow('chrome_open')
  })
})

describe('chromeCandidates', () => {
  it('lists the macOS Chrome path first', () => {
    expect(chromeCandidates('darwin')[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  })

  it('lists Windows chrome.exe candidates', () => {
    expect(chromeCandidates('win32').every(path => path.endsWith('chrome.exe'))).toBe(true)
  })
})

describe('defaultUserProfileDir', () => {
  it('points at the macOS Chrome profile', () => {
    expect(defaultUserProfileDir('darwin')).toContain('Library/Application Support/Google/Chrome')
  })
})

describe('resolveChromePath', () => {
  const exists = (path: string): boolean => path === '/opt/chrome'

  it('trusts a configured path that exists', () => {
    expect(resolveChromePath('/opt/chrome', [], exists)).toBe('/opt/chrome')
  })

  it('rejects a configured path that does not exist', () => {
    expect(() => resolveChromePath('/nope', [], exists)).toThrow('does not exist')
  })

  it('takes the first present candidate', () => {
    expect(resolveChromePath(undefined, ['/a', '/opt/chrome', '/b'], exists)).toBe('/opt/chrome')
  })

  it('throws when nothing is present', () => {
    expect(() => resolveChromePath(undefined, ['/a'], exists)).toThrow('Chrome executable not found')
  })
})

describe('resolveChromeConfig', () => {
  it('defaults to owned mode with a persistent dedicated profile and no auto relaunch', () => {
    const config = resolveChromeConfig({})
    expect(config.mode).toBe('owned')
    expect(config.backend).toBe('extension')
    expect(config.port).toBe(9222)
    expect(config.autoRelaunch).toBe(false)
    expect(config.attachOnly).toBe(false)
    expect(config.timeoutMs).toBe(15000)
    expect(config.readTextLimit).toBe(30000)
    expect(config.waitLoadMs).toBe(8000)
    expect(config.profileDir).toContain('chrome-browser')
    expect(config.profileDir).toContain('profile-9222')
  })

  it('explicit user mode defaults to a custom profile copy (Chrome 136+ ignores the standard dir for debug ports)', () => {
    const config = resolveChromeConfig({ mode: 'user' })
    expect(config.profileDir).toBe(defaultUserCopyProfileDir(9222))
    expect(config.profileDir).toContain('profile-copy-9222')
  })

  it('owned mode defaults to the dedicated profile', () => {
    const config = resolveChromeConfig({ mode: 'owned' })
    expect(config.profileDir).toContain('profile-9222')
  })

  it('lets callers override defaults', () => {
    const config = resolveChromeConfig({ port: 9333, mode: 'owned', readTextLimit: 1000 })
    expect(config.port).toBe(9333)
    expect(config.readTextLimit).toBe(1000)
    expect(config.profileDir).toContain('profile-9333')
  })
})

describe('Chrome attach mode', () => {
  it('throws a helpful error when no DevTools endpoint answers', async () => {
    const config = resolveChromeConfig({ port: 59321, attachOnly: true, timeoutMs: 200 })
    const chrome = new Chrome(config, {
      httpFetch: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    await expect(chrome.ensure()).rejects.toThrow('no Chrome DevTools endpoint')
  })
})

describe('Chrome user mode', () => {
  /** Spawned Chrome never answers; the flow always dies in waitForEndpoint. */
  const failingFetch = async (): Promise<never> => {
    throw new Error('ECONNREFUSED')
  }

  it('errors without autoRelaunch and never touches Chrome', async () => {
    const stop = vi.fn(async () => {})
    const config = resolveChromeConfig({ port: 59322, mode: 'user', autoRelaunch: false, timeoutMs: 200 })
    const chrome = new Chrome(config, { httpFetch: failingFetch, platformOps: { isRunning: async () => true, stop } })
    await expect(chrome.ensure()).rejects.toThrow('不会擅自重启 Chrome')
    expect(stop).not.toHaveBeenCalled()
  })

  it('relaunches a running Chrome with the debug port and the user profile', async () => {
    const stop = vi.fn(async () => {})
    const isRunning = vi.fn(async () => true)
    const spawnProcess = vi.fn(() => fakeProc() as never)
    const source = mkdtempSync(join(tmpdir(), 'dsh-profile-src-'))
    const config = resolveChromeConfig({ port: 59323, mode: 'user', autoRelaunch: true, timeoutMs: 120 })
    const chrome = new Chrome(config, {
      httpFetch: failingFetch,
      platformOps: { isRunning, stop },
      spawnProcess,
      userProfileSource: source,
      pollIntervalMs: 5,
    })
    await expect(chrome.ensure()).rejects.toThrow('did not become ready')
    expect(isRunning).toHaveBeenCalled()
    expect(stop).toHaveBeenCalled()
    const [path, args] = spawnProcess.mock.calls[0] as unknown as [string, string[]]
    expect(path.length).toBeGreaterThan(0)
    expect(args).toContain(`--remote-debugging-port=59323`)
    expect(args).toContain(`--user-data-dir=${config.profileDir}`)
    expect(args).toContain('--remote-allow-origins=*')
    expect(args).toContain('--restore-last-session')
  })

  it('spawns directly when Chrome is not running (no stop call)', async () => {
    const stop = vi.fn(async () => {})
    const spawnProcess = vi.fn(() => fakeProc() as never)
    const source = mkdtempSync(join(tmpdir(), 'dsh-profile-src-'))
    const config = resolveChromeConfig({ port: 59324, mode: 'user', autoRelaunch: true, timeoutMs: 120 })
    const chrome = new Chrome(config, {
      httpFetch: failingFetch,
      platformOps: { isRunning: async () => false, stop },
      spawnProcess,
      userProfileSource: source,
      pollIntervalMs: 5,
    })
    await expect(chrome.ensure()).rejects.toThrow('did not become ready')
    expect(stop).not.toHaveBeenCalled()
    expect(spawnProcess).toHaveBeenCalled()
  })

  it('never terminates the user browser on dispose', () => {
    const spawnProcess = vi.fn(() => fakeProc() as never)
    const config = resolveChromeConfig({ port: 59325, mode: 'user' })
    const chrome = new Chrome(config, { spawnProcess })
    chrome.dispose()
    expect(spawnProcess).not.toHaveBeenCalled()
  })
})

describe('Chrome owned mode', () => {
  it('keeps the dedicated profile and terminates the owned Chrome on dispose', async () => {
    const signals: string[] = []
    const proc = fakeProc()
    proc.kill = (signal?: string) => { signals.push(signal ?? '') }
    // The endpoint answers only once Chrome has been spawned, which is what
    // makes `ensure()` take the owned-mode path rather than the early return.
    let spawned = false
    const spawnProcess = vi.fn(() => {
      spawned = true
      return proc as never
    })
    const config = resolveChromeConfig({ port: 59326, mode: 'owned' })
    const chrome = new Chrome(config, {
      httpFetch: async () => {
        if (!spawned) throw new Error('ECONNREFUSED')
        return { ok: true, json: async () => ({ browser: 'Chrome' }) } as never
      },
      spawnProcess,
      pollIntervalMs: 5,
    })

    await chrome.ensure()
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    const [, args] = spawnProcess.mock.calls[0] as unknown as [string, string[]]
    expect(args).toContain(`--user-data-dir=${config.profileDir}`)
    expect(config.profileDir).toContain('profile-59326')

    chrome.dispose()
    expect(signals).toContain('SIGTERM')
  })
})

describe('pickFaviconUrl', () => {
  it('prefers the page-provided icon link', () => {
    expect(pickFaviconUrl('https://a.example/fav.svg', 'https://a.example/page')).toBe('https://a.example/fav.svg')
  })

  it('falls back to the origin favicon for http(s) pages', () => {
    expect(pickFaviconUrl('', 'https://a.example/path')).toBe('https://a.example/favicon.ico')
  })

  it('returns none for privileged pages', () => {
    expect(pickFaviconUrl('', 'chrome://settings')).toBe('')
    expect(pickFaviconUrl('', 'about:blank')).toBe('')
  })
})

describe('copyUserProfileTo', () => {
  it('copies the profile without cache dirs and keeps login-bearing files', () => {
    const source = mkdtempSync(join(tmpdir(), 'dsh-copy-src-'))
    const dest = join(tmpdir(), `dsh-copy-dest-${Date.now()}`)
    mkdirSync(join(source, 'Cache'), { recursive: true })
    mkdirSync(join(source, 'Network'), { recursive: true })
    writeFileSync(join(source, 'Network', 'Cookies'), 'cookie-jar')
    writeFileSync(join(source, 'Bookmarks'), '{}')
    writeFileSync(join(source, 'Cache', 'data'), 'huge-cache')

    const copied = copyUserProfileTo(source, dest, (from, to) => {
      const { cpSync } = require('node:fs') as typeof import('node:fs')
      cpSync(from, to, { recursive: true, filter: (path) => !/Cache$/.test(path) })
    })
    expect(copied).toBe(true)
    expect(require('node:fs').existsSync(join(dest, 'Bookmarks'))).toBe(true)
    expect(require('node:fs').existsSync(join(dest, 'Network', 'Cookies'))).toBe(true)
    expect(require('node:fs').existsSync(join(dest, 'Cache'))).toBe(false)
  })

  it('reports a missing source without creating anything', () => {
    const dest = join(tmpdir(), `dsh-copy-nosrc-${Date.now()}`)
    const copied = copyUserProfileTo(join(tmpdir(), 'dsh-no-such-profile'), dest, () => {})
    expect(copied).toBe(false)
    expect(require('node:fs').existsSync(dest)).toBe(false)
  })
})

describe('reclaimOwnedLeftover', () => {
  const marker = '/data/chrome-browser/profile-9222'
  const pidFile = `${marker}/.dsh-owner.pid`

  function deps(overrides: Partial<ReturnType<typeof baseDeps>> = {}): ReturnType<typeof baseDeps> {
    return {
      ...baseDeps(),
      ...overrides,
    }
  }

  function baseDeps() {
    return {
      readPidFile: (): number | undefined => 1234,
      processAlive: (): boolean => true,
      commandLineOf: (_pid: number): string | undefined => `Chrome --user-data-dir=${marker}`,
      kill: vi.fn((): boolean => true),
      unlink: vi.fn(),
    }
  }

  it('kills and unlinks a live leftover that carries our profile marker', () => {
    const kill = vi.fn(() => true)
    const unlink = vi.fn()
    const result = reclaimOwnedLeftover({
      pidFile,
      profileDir: marker,
      currentPid: 9999,
      deps: deps({ kill, unlink }),
    })
    expect(result).toBe(true)
    expect(kill).toHaveBeenCalledWith(1234, 'SIGTERM')
    expect(unlink).toHaveBeenCalledWith(pidFile)
  })

  it('never kills the current process', () => {
    const kill = vi.fn()
    const result = reclaimOwnedLeftover({ pidFile, profileDir: marker, currentPid: 1234, deps: deps({ kill }) })
    expect(result).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })

  it('does not kill a process whose command line lacks our marker', () => {
    const kill = vi.fn()
    const result = reclaimOwnedLeftover({
      pidFile,
      profileDir: marker,
      currentPid: 9999,
      deps: deps({ kill, commandLineOf: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/me/Library/Application Support/Google/Chrome' }),
    })
    expect(result).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })

  it('clears a stale pid file for a dead process without killing', () => {
    const kill = vi.fn()
    const unlink = vi.fn()
    const result = reclaimOwnedLeftover({
      pidFile,
      profileDir: marker,
      currentPid: 9999,
      deps: deps({ kill, unlink, processAlive: () => false }),
    })
    expect(result).toBe(false)
    expect(kill).not.toHaveBeenCalled()
    expect(unlink).toHaveBeenCalledWith(pidFile)
  })

  it('skips when the command line is unreadable (e.g. Windows)', () => {
    const kill = vi.fn()
    const result = reclaimOwnedLeftover({
      pidFile,
      profileDir: marker,
      currentPid: 9999,
      deps: deps({ kill, commandLineOf: () => undefined }),
    })
    expect(result).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })
})
