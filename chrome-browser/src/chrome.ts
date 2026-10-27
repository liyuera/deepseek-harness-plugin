/**
 * Chrome browser lifecycle and target discovery: probe the DevTools HTTP
 * endpoint, attach to (or relaunch) the user's Chrome with a debug port in
 * `user` mode, spawn a dedicated instance in `owned` mode, list page
 * targets, and open a CDP endpoint on one tab. The plugin never terminates a
 * browser it did not spawn.
 * @module @liyuera/dsh-chrome-browser/chrome
 */

import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  cdpEndpoint,
  websocketSocket,
  type CdpEndpoint,
} from './cdp.ts'

/** How the plugin reaches a browser via CDP (extension backend config separately). */
export type ChromeMode = 'user' | 'owned'

/**
 * Loopback port the shipped Chrome extension dials (`ws://127.0.0.1:21987/...`).
 * The extension's service worker cannot discover a port, so the bridge keeps
 * this fixed number while the dsh web server's own port varies. It is the
 * plugin's own port: reusing a port dsh itself ever listens on (the desktop
 * client used to, at 19387) would make the two contend for the bind.
 */
export const DEFAULT_BRIDGE_PORT = 21987

/**
 * How long one console capture may go without a read before the host releases
 * its debugger, milliseconds (0 disables the auto-release).
 *
 * A capture holds Chrome's debugger, and Chrome shows a "debugging this
 * browser" bar the whole time. Five minutes without a single read means the
 * capture is no longer being used — the bar must not outlive the need for it.
 * The captured entries stay readable; only new ones stop arriving.
 */
export const DEFAULT_CONSOLE_IDLE_MS = 5 * 60_000

/** Fully-resolved plugin configuration (schema defaults already applied). */
export interface ResolvedChromeConfig {
  /** Backend: `extension` (real Chrome via the extension bridge, default) or `cdp`. */
  backend: 'extension' | 'cdp'
  /** DevTools HTTP port. */
  port: number
  /** Explicit Chrome executable path; detection is skipped when set. `undefined` = auto-detect. */
  chromePath: string | undefined
  /**
   * Chrome `--user-data-dir`. For `user` mode this defaults to the user's
   * real profile; override with a dedicated dir to keep the user browser
   * untouched. For `owned` mode it defaults to `<tmp>/dsh-chrome-<port>`.
   */
  profileDir: string
  /** `user` = the user's own browser (relaunch with debug port when needed); `owned` = dedicated instance. */
  mode: ChromeMode
  /** `user` mode only: relaunch Chrome with the debug port when it is running without one. */
  autoRelaunch: boolean
  /** Connect to an existing DevTools endpoint without spawning or killing any browser. */
  attachOnly: boolean
  /** Per-command and readiness bound, milliseconds. */
  timeoutMs: number
  /** chrome_read visible-text budget, code points. */
  readTextLimit: number
  /** chrome_navigate load-wait bound, milliseconds (0 = don't wait). */
  waitLoadMs: number
  /** Directory for screenshot files. */
  screenshotDir: string
  /** chrome_console idle bound, milliseconds (0 = capture never auto-releases). */
  consoleIdleMs: number
  /**
   * Loopback port of the plugin's own extension bridge. `0` lets the OS pick
   * one (tests and diagnostics only — the shipped extension cannot find it).
   */
  bridgePort: number
}

/** One page target as the model sees it (internal ws url kept private). */
export interface ChromeTab {
  id: string
  title: string
  url: string
  active: boolean
}

/** Picker view of one tab: public fields plus a resolvable favicon url. */
export interface FaviconTab extends ChromeTab {
  favicon: string
}

/** Internal page target view carrying the CDP websocket url. */
interface CdpTabTarget extends ChromeTab {
  wsUrl: string
}

/** Injectable platform operations for `user`-mode attach (`autoRelaunch`). */
export interface PlatformOps {
  /** Whether a Chrome process is currently running. */
  isRunning(): Promise<boolean>
  /** Gracefully stop Chrome (macOS Quit / Windows taskkill / Linux pkill) and wait for it to be gone. */
  stop(): Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Page expression resolving the favicon url (first icon link wins). */
const FAVICON_EXPRESSION = `(() => {
  const el = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"]')
  return el ? el.href : ''
})()`

/**
 * Favicon url for one tab: the page's own icon link when found, otherwise
 * `<origin>/favicon.ico` for http(s) pages, otherwise none.
 */
export function pickFaviconUrl(found: string | undefined, pageUrl: string): string {
  if (found !== undefined && found !== '') return found
  try {
    const url = new URL(pageUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return new URL('/favicon.ico', url.origin).href
  } catch {
    return ''
  }
}

/** Run one command and resolve its exit code plus stdout (never rejects). */
function runCommand(command: string, args: readonly string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    execFile(command, [...args], (_error, stdout, _stderr) => {
      const error = _error as NodeJS.ErrnoException | null | undefined
      if (error !== null && error !== undefined) {
        if (error.code === 'ENOENT') resolve({ code: 127, stdout: '' })
        else if (typeof error.code === 'number') resolve({ code: error.code, stdout: '' })
        else resolve({ code: 1, stdout: '' })
        return
      }
      resolve({ code: 0, stdout })
    })
  })
}

/** macOS ops: pgrep detection, AppleScript graceful quit, then poll-gone. */
function darwinPlatformOps(): PlatformOps {
  const marker = 'Google Chrome.app/Contents/MacOS/Google Chrome'
  return {
    async isRunning() {
      return (await runCommand('/usr/bin/pgrep', ['-f', marker])).code === 0
    },
    async stop() {
      await runCommand('/usr/bin/osascript', ['-e', 'tell application "Google Chrome" to quit'])
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (!(await this.isRunning())) return
        await sleep(300)
      }
    },
  }
}

/** Windows ops: tasklist detection, forced taskkill. */
function windowsPlatformOps(): PlatformOps {
  return {
    async isRunning() {
      const result = await runCommand('tasklist', ['/FI', 'IMAGENAME eq chrome.exe'])
      return result.code === 0 && result.stdout.toLowerCase().includes('chrome.exe')
    },
    async stop() {
      await runCommand('taskkill', ['/IM', 'chrome.exe', '/F'])
    },
  }
}

/** Platform ops by process.platform (injectable override at construction). */
export function defaultPlatformOps(platform: NodeJS.Platform = process.platform): PlatformOps {
  if (platform === 'darwin') return darwinPlatformOps()
  if (platform === 'win32') return windowsPlatformOps()
  return {
    async isRunning() {
      return (await runCommand('/usr/bin/pgrep', ['-x', 'chrome'])).code === 0
    },
    async stop() {
      await runCommand('/usr/bin/pkill', ['-TERM', '-x', 'chrome'])
    },
  }
}

/** Browser-executable candidates per platform, most-preferred first. */
export function chromeCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  }
  if (platform === 'win32') {
    const programFiles = process.env.PROGRAMFILES ?? 'C:\\Program Files'
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
    return [
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']
}

/**
 * Resolve the Chrome executable: the configured path must exist, otherwise
 * the first present candidate wins; nothing found throws.
 */
export function resolveChromePath(
  configured: string | undefined,
  candidates: readonly string[] = chromeCandidates(),
  exists: (path: string) => boolean = existsSync,
): string {
  if (configured !== undefined) {
    if (exists(configured)) return configured
    throw new Error(`chromePath ${configured} does not exist`)
  }
  const found = candidates.find(exists)
  if (found === undefined) {
    throw new Error('Chrome executable not found; install Google Chrome or set config chromePath')
  }
  return found
}

/** Map one `/json/list` target to our internal view; non-page targets and targets without ws url are dropped. */
export function parseTabList(value: unknown): CdpTabTarget[] {
  if (!Array.isArray(value)) return []
  const tabs: CdpTabTarget[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (record.type !== 'page') continue
    const id = typeof record.id === 'string' ? record.id : ''
    const wsUrl = typeof record.webSocketDebuggerUrl === 'string' ? record.webSocketDebuggerUrl : ''
    if (id === '' || wsUrl === '') continue
    tabs.push({
      id,
      title: typeof record.title === 'string' ? record.title : '',
      url: typeof record.url === 'string' ? record.url : '',
      active: record.active === true,
      wsUrl,
    })
  }
  return tabs
}

/**
 * Resolve a tool's `tabId` argument: explicit id wins, then the
 * session-bound tab, then the active tab (first listed as last resort).
 */
export function resolveTab(
  tabs: readonly CdpTabTarget[],
  tabId: string | undefined,
  sessionTabId: string | undefined,
): CdpTabTarget {
  if (tabId !== undefined && tabId !== '' && tabId !== 'active') {
    const tab = tabs.find(candidate => candidate.id === tabId)
    if (tab !== undefined) return tab
    throw new Error(`tab ${tabId} not found; list tabs with chrome_tabs`)
  }
  if (sessionTabId !== undefined) {
    const tab = tabs.find(candidate => candidate.id === sessionTabId)
    if (tab !== undefined) return tab
  }
  const tab = tabs.find(candidate => candidate.active) ?? tabs[0]
  if (tab === undefined) throw new Error('no Chrome tab available; open one with chrome_open')
  return tab
}

/**
 * Owned-mode default profile: one per port, persisted under $DSH_HOME when
 * available so tabs survive OS reboots and dsh restarts.
 */
export function defaultProfileDir(port: number): string {
  const home = process.env.DSH_HOME
  const base = home !== undefined && home !== '' ? home : tmpdir()
  return join(base, 'chrome-browser', `profile-${port}`)
}

/** The user's real Chrome profile directory (source for the profile copy). */
export function defaultUserProfileDir(platform: NodeJS.Platform = process.platform): string {  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    return join(localAppData, 'Google', 'Chrome', 'User Data')
  }
  return join(homedir(), '.config', 'google-chrome')
}

/**
 * Profile subdirectories excluded from the user-profile copy. Chrome 136+
 * ignores `--remote-debugging-port` for profiles at the standard location, so
 * user mode relaunches from a COPY at a custom location; caches are skipped
 * (Chrome rebuilds them) while Cookies, History and logins are kept.
 */
export const EXCLUDED_PROFILE_DIRS = /(^|\/)(Cache|Code Cache|GPUCache|GrShaderCache|ShaderCache|DawnCache|GraphiteDawnCache|Media Cache|Dictionaries|Crashpad|Crash Reports|Safe Browsing|Temporary)$/

/** Default copy destination for user mode: persistent, custom (non-standard) location. */
export function defaultUserCopyProfileDir(port: number): string {
  const home = process.env.DSH_HOME
  const base = home !== undefined && home !== '' ? home : tmpdir()
  return join(base, 'chrome-browser', `profile-copy-${port}`)
}

/**
 * Copy a Chrome profile to a custom location, excluding cache-style dirs.
 * When the source is absent (no Chrome profile yet) the destination is simply
 * left to Chrome to create; failures surface through `copy`.
 * @returns whether the source existed and a copy was attempted.
 */
export function copyUserProfileTo(
  source: string,
  dest: string,
  copy: (from: string, to: string) => void,
): boolean {
  if (!existsSync(source)) return false
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  copy(source, dest)
  return true
}

/** Default screenshot directory. */
export function defaultScreenshotDir(): string {
  return join(tmpdir(), 'dsh-chrome-shots')
}

/** Apply config defaults for fields whose schema left them optional. */
export function resolveChromeConfig(
  config: Partial<ResolvedChromeConfig>,
  _platform: NodeJS.Platform = process.platform,
): ResolvedChromeConfig {
  const port = config.port ?? 9222
  // owned is the safe default: the plugin only ever spawns/kills its own
  // dedicated Chrome, never the browser that hosts the dsh UI.
  const mode: ChromeMode = config.mode ?? 'owned'
  return {
    backend: config.backend ?? 'extension',
    port,
    chromePath: config.chromePath,
    profileDir: config.profileDir ?? (mode === 'user' ? defaultUserCopyProfileDir(port) : defaultProfileDir(port)),
    mode,
    autoRelaunch: config.autoRelaunch ?? false,
    attachOnly: config.attachOnly ?? false,
    timeoutMs: config.timeoutMs ?? 15000,
    readTextLimit: config.readTextLimit ?? 30000,
    waitLoadMs: config.waitLoadMs ?? 8000,
    screenshotDir: config.screenshotDir ?? defaultScreenshotDir(),
    consoleIdleMs: config.consoleIdleMs ?? DEFAULT_CONSOLE_IDLE_MS,
    bridgePort: config.bridgePort ?? DEFAULT_BRIDGE_PORT,
  }
}

/** Injectable seams for tests. */
export interface ChromeOptions {
  /** fetch implementation (defaults to the Node global). */
  httpFetch?: typeof fetch
  /** Extra Chrome argv appended before the initial URL. */
  extraArgs?: string[]
  /** Poll interval while waiting for DevTools readiness. */
  pollIntervalMs?: number
  /** User-mode platform operations (defaults per process.platform). */
  platformOps?: PlatformOps
  /** Source of the user profile for `user` mode relaunch (defaults to the standard location). */
  userProfileSource?: string
  /** Process spawn override (defaults to child_process.spawn). */
  spawnProcess?: (path: string, args: readonly string[]) => ChildProcess
  /** Diagnostics sink (defaults to console.warn). */
  onLog?: (message: string) => void
}

/** Injected filesystem/process facilities for the owned-leftover reclaimer. */
export interface ReclaimDeps {
  /** Read and parse the pid file; undefined when absent or unparsable. */
  readPidFile(path: string): number | undefined
  /** Whether the pid belongs to a live process. */
  processAlive(pid: number): boolean
  /** The command line of the pid, or undefined when unreadable (e.g. Windows). */
  commandLineOf(pid: number): string | undefined
  /** Send a signal to the pid. */
  kill(pid: number, signal: string): boolean
  /** Remove the pid file (best-effort). */
  unlink(path: string): void
}

/**
 * Claim one leftover plugin-owned Chrome from a previous run: the pid file
 * under the owned profile marks the process; it is killed only when its
 * command line still carries our `--user-data-dir` marker, so a reused pid
 * or a foreign Chrome is never touched. Best-effort, never throws.
 * @param opts - the pid file, marker profile dir, current pid and deps.
 * @returns true when a leftover process was killed.
 */
export function reclaimOwnedLeftover(opts: {
  pidFile: string
  profileDir: string
  currentPid: number
  deps: ReclaimDeps
}): boolean {
  const { pidFile, profileDir, currentPid, deps } = opts
  const pid = deps.readPidFile(pidFile)
  if (pid === undefined || pid === currentPid) return false
  if (!deps.processAlive(pid)) {
    deps.unlink(pidFile)
    return false
  }
  const commandLine = deps.commandLineOf(pid)
  if (commandLine === undefined || !commandLine.includes(`--user-data-dir=${profileDir}`)) return false
  const killed = deps.kill(pid, 'SIGTERM')
  deps.unlink(pidFile)
  return killed
}

/**
 * Live Chrome session: one user (attached) or owned browser plus tab-level
 * CDP endpoints. Safe to use concurrently; `ensure()` is idempotent and
 * `dispose` terminates only an owned process.
 */
export class Chrome {
  private readonly httpFetch: typeof fetch
  private readonly extraArgs: readonly string[]
  private readonly pollIntervalMs: number
  private readonly onLog: (message: string) => void
  private readonly platformOps: PlatformOps
  private readonly faviconCache = new Map<string, string>()
  private readonly userProfileSource: string | undefined
  private readonly spawnProcess: (path: string, args: readonly string[]) => ChildProcess
  private proc: ChildProcess | undefined
  private stderrTail: string[] = []

  constructor(readonly config: ResolvedChromeConfig, options: ChromeOptions = {}) {
    this.httpFetch = options.httpFetch ?? fetch
    this.extraArgs = options.extraArgs ?? []
    this.pollIntervalMs = options.pollIntervalMs ?? 250
    this.onLog = options.onLog ?? ((message) => console.warn(`[chrome-browser] ${message}`))
    this.platformOps = options.platformOps ?? defaultPlatformOps()
    this.userProfileSource = options.userProfileSource
    this.spawnProcess = options.spawnProcess ?? ((path, args) => spawn(path, [...args], { stdio: ['ignore', 'ignore', 'pipe'] }))
  }

  /** DevTools HTTP base url. */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.config.port}`
  }

  /** Whether a DevTools endpoint answers on the configured port. */
  private async hasEndpoint(): Promise<boolean> {
    try {
      await this.httpJson('/json/version', { method: 'GET' })
      return true
    } catch {
      return false
    }
  }

  /**
   * Make the browser reachable for the configured mode: attach when
   * `attachOnly`, reuse an existing endpoint, relaunch the user's Chrome
   * with a debug port in `user` mode, or spawn a dedicated instance in
   * `owned` mode.
   */
  async ensure(): Promise<void> {
    if (await this.hasEndpoint()) return
    if (this.config.attachOnly) {
      throw new Error(
        `no Chrome DevTools endpoint at ${this.baseUrl}; start Chrome with --remote-debugging-port=${this.config.port} `
        + '(e.g. "--remote-debugging-port=9222 --user-data-dir=<dir>"), or set attachOnly false',
      )
    }
    if (this.config.mode === 'owned') {
      this.spawnOwnedChrome()
      await this.waitForEndpoint()
      return
    }
    if (!this.config.autoRelaunch) {
      throw new Error(
        `no Chrome DevTools endpoint at ${this.baseUrl}; 插件未接管 Chrome。为避免自动关闭你正在使用的浏览器窗口 `
        + `(dsh 界面很可能就在里面,会造成循环),插件不会擅自重启 Chrome。请手动启动: Chrome --remote-debugging-port=`
        + `${this.config.port} --user-data-dir=<自定义目录>(注意 Chrome 136+ 会忽略标准位置 profile 的调试端口,`
        + `目录必须是非标准位置),或设置 autoRelaunch true 让插件用你的 profile 副本接管。`,
      )
    }
    if (await this.platformOps.isRunning()) {
      this.onLog(`restarting Chrome with remote debugging port ${this.config.port} …`)
      await this.platformOps.stop()
    }
    this.copyUserProfile()
    this.spawnUserChrome()
    await this.waitForEndpoint()
  }

  /**
   * Copy the user's real profile to the custom location Chrome will run from:
   * its standard-location profile cannot carry a debug port in Chrome 136+.
   * Failures degrade to a fresh profile there (still fully functional, just
   * without the user's tabs).
   */
  private copyUserProfile(): void {
    const source = this.userProfileSource ?? defaultUserProfileDir(process.platform)
    try {
      copyUserProfileTo(source, this.config.profileDir, (from, to) => {
        cpSync(from, to, {
          recursive: true,
          filter: (path) => !EXCLUDED_PROFILE_DIRS.test(path),
        })
      })
    } catch (error) {
      this.onLog(`user profile copy failed (${error instanceof Error ? error.message : String(error)}); starting with a fresh profile`)
    }
  }

  /** List page tabs (type `page` only) with their CDP websocket urls. */
  private async listTargets(): Promise<CdpTabTarget[]> {
    await this.ensure()
    const value = await this.httpJson('/json/list', { method: 'GET' })
    return parseTabList(value).sort((a, b) => Number(b.active) - Number(a.active))
  }

  /** List page tabs (type `page` only), active first. */
  async listTabs(): Promise<ChromeTab[]> {
    const tabs = await this.listTargets()
    return tabs.map(({ id, title, url, active }) => ({ id, title, url, active }))
  }

  /**
   * List page tabs enriched with a per-tab favicon url (picker surface).
   * Favicons come from the page's own `<link rel~="icon">` over its CDP
   * session, cached per origin; a missing one falls back to
   * `<origin>/favicon.ico`. Unreachable tabs degrade silently.
   */
  async listTabsWithFavicons(): Promise<FaviconTab[]> {
    const targets = await this.listTargets()
    const result: FaviconTab[] = []
    const pending: Array<{ index: number; target: CdpTabTarget }> = []
    targets.forEach((target, index) => {
      const cached = this.cachedFavicon(target.url)
      result.push({
        id: target.id,
        title: target.title,
        url: target.url,
        active: target.active,
        favicon: cached ?? '',
      })
      if (cached === undefined) pending.push({ index, target })
    })
    let cursor = 0
    const workers = Array.from({ length: Math.min(4, pending.length) }, async () => {
      for (;;) {
        const next = pending[cursor++]
        if (next === undefined) return
        const favicon = await this.pageFavicon(next.target)
        result[next.index]!.favicon = favicon
        this.cacheFavicon(next.target.url, favicon)
      }
    })
    await Promise.all(workers)
    return result.map(entry => ({ ...entry, favicon: entry.favicon }))
  }

  private cachedFavicon(url: string): string | undefined {
    try {
      return this.faviconCache.get(new URL(url).origin)
    } catch {
      return undefined
    }
  }

  private cacheFavicon(url: string, favicon: string): void {
    try {
      const origin = new URL(url).origin
      this.faviconCache.set(origin, favicon)
      if (this.faviconCache.size > 500) {
        const first = this.faviconCache.keys().next()
        if (!first.done) this.faviconCache.delete(first.value)
      }
    } catch {
      // non-parseable urls have no origin to cache under
    }
  }

  /** One page's favicon url: `<link rel~="icon">` first, origin fallback second. */
  private async pageFavicon(target: CdpTabTarget): Promise<string> {
    try {
      const socket = websocketSocket(target.wsUrl, Math.min(this.config.timeoutMs, 5000))
      const endpoint = cdpEndpoint(socket, { timeoutMs: Math.min(this.config.timeoutMs, 5000) })
      try {
        const response = await endpoint.call('Runtime.evaluate', {
          expression: FAVICON_EXPRESSION,
          returnByValue: true,
        })
        const remote = response.result as { value?: unknown } | undefined
        const found = typeof remote?.value === 'string' ? remote.value : ''
        return pickFaviconUrl(found, target.url)
      } finally {
        endpoint.close()
      }
    } catch {
      return pickFaviconUrl(undefined, target.url)
    }
  }

  /** Open a new tab (foreground) and return its public view. */
  async openTab(url: string): Promise<ChromeTab> {
    await this.ensure()
    const target = await this.httpJson(`/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    const tabs = parseTabList([target])
    const tab = tabs[0]
    if (tab === undefined) throw new Error('chrome_open: Chrome did not return a usable tab target')
    return { id: tab.id, title: tab.title, url: tab.url, active: tab.active }
  }

  /**
   * Close one tab by target id.
   *
   * Chrome answers `/json/close` with the plain text "Target is closing", so
   * this does not go through `httpJson`, which parses a JSON body.
   * @param targetId - the tab's target id, as `listTabs` reports it.
   */
  async closeTab(targetId: string): Promise<void> {
    await this.ensure()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    try {
      const response = await this.httpFetch(
        `${this.baseUrl}/json/close/${encodeURIComponent(targetId)}`,
        { method: 'GET', signal: controller.signal },
      )
      if (!response.ok) throw new Error(`Chrome refused to close tab ${targetId} (HTTP ${response.status})`)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Open a CDP endpoint on one tab. The caller owns the endpoint and must
   * `close()` it (close also detaches the session).
   * @param tabId - explicit tab id from the tool args.
   * @param sessionTabId - the session-bound tab id (undefined when none).
   * @returns the tab and its endpoint.
   */
  async tabEndpoint(
    tabId: string | undefined,
    sessionTabId: string | undefined,
  ): Promise<{ tab: CdpTabTarget; endpoint: CdpEndpoint }> {
    await this.ensure()
    const tabs = await this.listTargets()
    const tab = resolveTab(tabs, tabId, sessionTabId)
    const socket = websocketSocket(tab.wsUrl, this.config.timeoutMs)
    const endpoint = cdpEndpoint(socket, { timeoutMs: this.config.timeoutMs })
    return { tab, endpoint }
  }

  /** Terminate an owned Chrome process (SIGTERM, then SIGKILL after 2s). Never touches a user-mode browser. */
  dispose(): void {
    if (this.config.mode === 'user') return
    const proc = this.proc
    if (proc === undefined) return
    this.proc = undefined
    this.removeOwnerPidFile()
    const kill = (signal: NodeJS.Signals): void => {
      try {
        proc.kill(signal)
      } catch {
        // already gone
      }
    }
    if (proc.exitCode !== null) return
    kill('SIGTERM')
    const timer = setTimeout(() => kill('SIGKILL'), 2000)
    timer.unref()
    proc.once('exit', () => clearTimeout(timer))
  }

  /** The profile dir that marks a plugin-owned Chrome (never the real user profile). */
  private ownedProfileDir(): string {
    return this.config.mode === 'owned' ? this.config.profileDir : defaultProfileDir(this.config.port)
  }

  /**
   * Reclaim a plugin-owned Chrome left over from a previous run (e.g. after
   * switching the profile from `owned` to `user`): kill it when its command
   * line still carries our profile marker. Best-effort; safe to call at
   * plugin start in any mode.
   */
  reclaimOwnedLeftover(): void {
    const profileDir = this.ownedProfileDir()
    const pidFile = join(profileDir, '.dsh-owner.pid')
    const cmdLine = (pid: number): string | undefined => {
      if (process.platform === 'win32') return undefined
      try {
        return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' }).trim()
      } catch {
        return undefined
      }
    }
    try {
      reclaimOwnedLeftover({
        pidFile,
        profileDir,
        currentPid: process.pid,
        deps: {
          readPidFile: (path) => {
            try {
              const parsed = Number(readFileSync(path, 'utf8').trim())
              return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
            } catch {
              return undefined
            }
          },
          processAlive: (pid) => {
            try {
              process.kill(pid, 0)
              return true
            } catch {
              return false
            }
          },
          commandLineOf: cmdLine,
          kill: (pid, signal) => {
            try {
              process.kill(pid, signal)
              return true
            } catch {
              return false
            }
          },
          unlink: (path) => {
            try {
              rmSync(path, { force: true })
            } catch {
              // best effort
            }
          },
        },
      })
    } catch {
      // reclaim is never allowed to fail plugin startup
    }
  }

  private removeOwnerPidFile(): void {
    try {
      rmSync(join(this.ownedProfileDir(), '.dsh-owner.pid'), { force: true })
    } catch {
      // best effort
    }
  }

  /** Shared argv: debug port, profile, origin allowlist, extras, optional startup URL. */
  private chromeArgs(profileDir: string, extra: readonly string[], startupUrl?: string): string[] {
    const args = [
      `--remote-debugging-port=${this.config.port}`,
      `--user-data-dir=${profileDir}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      ...extra,
      ...this.extraArgs,
    ]
    if (startupUrl !== undefined) args.push(startupUrl)
    return args
  }

  private spawnOwnedChrome(): void {
    this.spawnChrome(this.config.profileDir, [], 'about:blank')
    try {
      writeFileSync(join(this.config.profileDir, '.dsh-owner.pid'), String(process.pid), 'utf8')
    } catch {
      // marker file is best-effort
    }
  }

  private spawnUserChrome(): void {
    // Session restore brings the user's windows/tabs back after the graceful
    // quit; no startup URL so the restored window stays the only one.
    this.spawnChrome(this.config.profileDir, ['--restore-last-session'])
  }

  private spawnChrome(profileDir: string, extra: readonly string[], startupUrl?: string): void {
    const chromePath = resolveChromePath(this.config.chromePath)
    mkdirSync(profileDir, { recursive: true })
    this.stderrTail = []
    const proc = this.spawnProcess(chromePath, this.chromeArgs(profileDir, extra, startupUrl))
    this.proc = proc
    proc.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail.push(chunk.toString('utf8').trimEnd())
      if (this.stderrTail.length > 10) this.stderrTail.shift()
    })
    proc.on('error', (error) => {
      this.onLog(`chrome spawn failed: ${error.message}`)
    })
    proc.on('exit', (code, signal) => {
      if (this.proc === proc) this.proc = undefined
      this.onLog(`chrome exited (code ${code ?? ''} signal ${signal ?? ''})`)
      this.stderrTail = []
    })
  }

  private async waitForEndpoint(): Promise<void> {
    const deadline = Date.now() + this.config.timeoutMs
    while (Date.now() < deadline) {
      if (await this.hasEndpoint()) return
      if (this.proc !== undefined && this.proc.exitCode !== null) {
        const tail = this.stderrTail.join('\n')
        throw new Error(`chrome exited early (exit code ${this.proc.exitCode})${tail === '' ? '' : `:\n${tail}`}`)
      }
      await sleep(this.pollIntervalMs)
    }
    throw new Error(`Chrome DevTools endpoint at ${this.baseUrl} did not become ready within ${this.config.timeoutMs}ms`)
  }

  private async httpJson(path: string, init: { method: string }): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    try {
      const response = await this.httpFetch(`${this.baseUrl}${path}`, { method: init.method, signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${this.baseUrl}${path}`)
      return await response.json()
    } finally {
      clearTimeout(timer)
    }
  }
}
