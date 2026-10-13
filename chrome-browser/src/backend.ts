/**
 * Browser backends behind the chrome_* tools. Two implementations share one
 * interface:
 * - `ExtensionBackend` (default): commands travel over the extension bridge
 *   WebSocket (`/chrome-browser/ext/ws`) and run against the user's REAL
 *   Chrome — no restarts, no profile copies.
 * - `CdpBackend`: the Chrome DevTools Protocol path (owned/user/attach modes)
 *   used as a fallback when config selects `cdp`.
 * @module @liyuera/dsh-chrome-browser/backend
 */

import type { Duplex } from 'node:stream'
import type { CdpEndpoint } from './cdp.ts'
import {
  clickExpression,
  focusAndSelectExpression,
  focusExpression,
  readPageExpression,
  readyStateExpression,
} from './expressions.ts'
import { Chrome } from './chrome.ts'
import type { ResolvedChromeConfig } from './chrome.ts'
import { WsConnection, wsHandshake } from './ws.ts'

/** One tab as tools and the picker see it. */
export interface BackendTab {
  id: string
  title: string
  url: string
  active: boolean
  favicon: string
}

/** One page snapshot. */
export interface BackendRead {
  title: string
  url: string
  text: string
  html: string
}

/** The face every chrome_* tool speaks to. */
export interface BrowserBackend {
  /** Bring the browser online; throws a user-actionable error when impossible. */
  ensure(): Promise<void>
  /** Local tab id for the "active" fallback. */
  activeTabId(): Promise<string>
  listTabs(): Promise<BackendTab[]>
  openTab(url: string): Promise<BackendTab>
  read(tabId: string, includeHtml: boolean): Promise<BackendRead>
  navigate(tabId: string, url: string, waitLoad: boolean, waitLoadMs: number): Promise<void>
  evaluate(tabId: string, expression: string): Promise<unknown>
  click(tabId: string, selector: string, all: boolean): Promise<number>
  type(tabId: string, selector: string, text: string, clear: boolean): Promise<void>
  screenshot(tabId: string): Promise<{ data: string; path?: string; mime?: string }>
  dispose(): void
}

/** Shared sleep. */
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Map one extension tab row to the backend face. */
function mapExtTab(tab: {
  id?: number
  title?: string
  url?: string
  active?: boolean
  favicon?: string
}): BackendTab {
  return {
    id: String(tab.id ?? ''),
    title: tab.title ?? '',
    url: tab.url ?? '',
    active: tab.active === true,
    favicon: tab.favicon ?? '',
  }
}

interface ExtResult {
  ok: boolean
  data?: unknown
  error?: string
}

/**
 * Extension bridge backend: commands are queued, sent over the bridge
 * WebSocket, and resolved when the extension replies. The socket is attached
 * by the `/chrome-browser/ext/ws` upgrade route.
 */
export class ExtensionBackend implements BrowserBackend {
  /**
   * Ops a disconnect may transparently retry on the next reconnect: they are
   * side-effect free, so a lost result is safe to recompute. Side-effectful
   * ops (open/navigate/click/type) are NEVER auto-resent — the caller gets
   * the disconnect error and the model retries explicitly (no duplicate
   * tabs/clicks/typing from hidden replays).
   */
  private static readonly SAFE_RETRY_OPS = new Set(['list-tabs', 'read', 'eval', 'screenshot'])
  /**
   * In-flight dedupe keys for side-effectful ops: a second identical command
   * while the first is still in flight JOIN it instead of firing twice
   * (model retries can otherwise double-click / double-open).
   */
  private readonly inFlight = new Map<string, Promise<unknown>>()

  private conn: WsConnection | null = null
  private seq = 0
  private readonly unacked = new Map<number, { op: string; args: Record<string, unknown> }>()
  /**
   * `deadline` is an ABSOLUTE cap per command (push + 2x timeout): reconnect
   * grace may never extend a command's total lifetime, or a flapping bridge
   * (detach → resend → detach…) would keep it alive indefinitely.
   */
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
    deadline: number
  }>()
  private pingTimer: NodeJS.Timeout | null = null

  constructor(private readonly config: ResolvedChromeConfig) {}

  /** The WS upgrade route calls this after a successful handshake. */
  attach(socket: Duplex, head: Buffer): void {
    // A reconnecting client may attach while another (stale) socket is still
    // registered; replace it without leaking the previous connection.
    if (this.conn !== null) this.conn.close()
    const conn = new WsConnection(socket, head)
    this.conn = conn
    conn.onMessage(text => this.onFrame(text))
    this.flush()
    if (this.pingTimer === null) {
      // Two keep-alives: the protocol-level ping (network stack, no JS) and a
      // JSON ping the service worker's onmessage executes — JS activity every
      // 10s prevents Chrome from suspending the MV3 worker mid-bridge.
      this.pingTimer = setInterval(() => {
        // Read the LIVE connection each tick: the first attach's `conn` goes
        // stale after any reconnect, and keep-alives aimed at a dead socket
        // let Chrome suspend the worker mid-command (tabs/eval survive the
        // alarm-wake window, long ops like screenshot die).
        const current = this.conn
        if (current !== null) {
          current.ping()
          current.send(JSON.stringify({ kind: 'ping' }))
        }
      }, 10000)
      this.pingTimer.unref()
    }
  }

  detach(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    const error = new Error('Chrome 扩展已断开连接')
    const settled = new Set<number>()
    for (const [seq, entry] of this.pending) {
      const op = this.unacked.get(seq)?.op
      if (op !== undefined && ExtensionBackend.SAFE_RETRY_OPS.has(op)) {
        // Side-effect free: keep it queued and give the bridge the REMAINDER
        // of the command's absolute deadline before giving up; `attach`
        // re-sends. Repeated disconnects can never extend the deadline.
        const remaining = entry.deadline - Date.now()
        if (remaining <= 0) {
          clearTimeout(entry.timer)
          entry.reject(new Error('Chrome 扩展重连超时,请确认扩展已加载'))
          this.pending.delete(seq)
          this.unacked.delete(seq)
          continue
        }
        clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          if (!this.pending.delete(seq)) return
          this.unacked.delete(seq)
          entry.reject(new Error('Chrome 扩展重连超时,请确认扩展已加载'))
        }, remaining)
        entry.timer.unref()
        continue
      }
      // Unsafe (or unknown) op: dead on disconnect — never replayed, since a
      // re-sent `open` would open another tab and `type`/`click`/`navigate`
      // would repeat their side effects.
      clearTimeout(entry.timer)
      entry.reject(error)
      settled.add(seq)
      this.pending.delete(seq)
      this.unacked.delete(seq)
    }
    this.conn = null
  }

  /** Whether the extension bridge is currently attached. */
  isConnected(): boolean {
    return this.conn !== null
  }

  /** Read (or clear) the extension's persisted worker trace (diagnostics). */
  async trace(clear = false): Promise<unknown> {
    return this.push('trace', { clear })
  }

  async ensure(): Promise<void> {
    const deadline = Date.now() + this.config.timeoutMs
    while (this.conn === null) {
      if (Date.now() > deadline) {
        throw new Error(
          'Chrome 扩展未连接:请在 chrome://extensions 打开「开发者模式」→「加载已解压的扩展程序」,'
          + `选择插件目录下的 extension/ 文件夹,然后确认连接成功。当前配置 backend: extension(端口 ${this.config.port} 对应 dsh web 地址)。`,
        )
      }
      await sleep(100)
    }
  }

  async activeTabId(): Promise<string> {
    const tabs = await this.listTabs()
    const active = tabs.find(tab => tab.active) ?? tabs[0]
    if (active === undefined) throw new Error('no Chrome tab available; open one with chrome_open')
    return active.id
  }

  async listTabs(): Promise<BackendTab[]> {
    const result = await this.push('list-tabs', {}) as { tabs?: unknown[] } | null
    return ((result?.tabs ?? []) as Parameters<typeof mapExtTab>[0][]).map(mapExtTab)
  }

  async openTab(url: string): Promise<BackendTab> {
    // Idempotence guard: a retried `open` for a URL already on a tab must not
    // multiply tabs (models retry on timeout). Reuse the existing tab instead.
    if (url !== '' && url !== 'about:blank') {
      const tabs = await this.listTabs()
      const existing = tabs.find(tab => tab.url === url && tab.url !== '')
      if (existing !== undefined) return existing
    }
    const result = await this.push('open', { url: url ?? 'about:blank' }) as Parameters<typeof mapExtTab>[0]
    return mapExtTab(result)
  }

  async read(tabId: string, includeHtml: boolean): Promise<BackendRead> {
    const result = await this.push('read', { tabId, includeHtml }) as {
      title?: unknown
      url?: unknown
      text?: unknown
      html?: unknown
    } | null
    return {
      title: typeof result?.title === 'string' ? result.title : '',
      url: typeof result?.url === 'string' ? result.url : '',
      text: typeof result?.text === 'string' ? result.text : '',
      html: typeof result?.html === 'string' ? result.html : '',
    }
  }

  async navigate(tabId: string, url: string, waitLoad: boolean, waitLoadMs: number): Promise<void> {
    await this.push('navigate', { tabId, url })
    if (!waitLoad || waitLoadMs <= 0) return
    const deadline = Date.now() + waitLoadMs
    while (Date.now() < deadline) {
      const state = await this.evaluate(tabId, readyStateExpression())
      if (state === 'complete') return
      await sleep(300)
    }
  }

  async evaluate(tabId: string, expression: string): Promise<unknown> {
    return await this.push('eval', { tabId, expression })
  }

  async click(tabId: string, selector: string, all: boolean): Promise<number> {
    const count = await this.push('click', { tabId, selector, all })
    return typeof count === 'number' ? count : 0
  }

  async type(tabId: string, selector: string, text: string, clear: boolean): Promise<void> {
    const done = await this.push('type', { tabId, selector, text, clear })
    if (done !== true) throw new Error(`chrome_type: no element matched selector "${selector}"`)
  }

  async screenshot(tabId: string): Promise<{ data: string; path?: string; mime?: string }> {
    // The extension uploads the image bytes over plain HTTP back to the host
    // and returns only the file path: a large base64 frame inside a WS JSON
    // message closed the bridge right after a successful capture.
    const result = await this.push('screenshot', { tabId }) as { path?: string; mime?: string } | null
    return result?.path !== undefined
      ? (result.mime !== undefined
          ? { data: '', path: result.path, mime: result.mime }
          : { data: '', path: result.path })
      : { data: '' }
  }

  dispose(): void {
    this.detach()
    this.conn?.close()
  }

  private push(op: string, args: Record<string, unknown>): Promise<unknown> {
    // Concurrent duplicate of a side-effectful command joins the in-flight
    // one (model retries double-clicking / double-opening otherwise).
    const dedupeKey = ExtensionBackend.SAFE_RETRY_OPS.has(op) ? undefined
      : `${op}:${String(args.tabId ?? '')}:${String(args.url ?? args.selector ?? args.text ?? '')}`
    if (dedupeKey !== undefined) {
      const existing = this.inFlight.get(dedupeKey)
      if (existing !== undefined) return existing
    }
    const seq = ++this.seq
    this.unacked.set(seq, { op, args })
    const outcome = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        this.unacked.delete(seq)
        reject(new Error(`Chrome 扩展 ${op} 超时(${this.config.timeoutMs}ms)`))
      }, this.config.timeoutMs)
      const deadline = Date.now() + this.config.timeoutMs * 2
      this.pending.set(seq, { resolve, reject, timer, deadline })
    })
    if (dedupeKey !== undefined) {
      this.inFlight.set(dedupeKey, outcome)
      const cleanup = () => {
        if (this.inFlight.get(dedupeKey) === outcome) this.inFlight.delete(dedupeKey)
      }
      // then(onFulfilled, onRejected): finally() would re-propagate the
      // rejection onto a voided promise and register an unhandled rejection.
      void outcome.then(cleanup, cleanup)
    }
    this.flush()
    return outcome
  }

  private onFrame(text: string): void {
    let message: { kind?: unknown; results?: unknown }
    try {
      message = JSON.parse(text) as typeof message
    } catch {
      return
    }
    if (message.kind !== 'results' || !Array.isArray(message.results)) return
    for (const entry of message.results as ExtResult[]) {
      const seq = Number((entry as unknown as { seq?: unknown }).seq)
      if (!Number.isInteger(seq)) continue
      const pending = this.pending.get(seq)
      if (pending === undefined) continue
      this.pending.delete(seq)
      this.unacked.delete(seq)
      clearTimeout(pending.timer)
      if (entry.ok === true) pending.resolve(entry.data)
      else pending.reject(new Error(entry.error ?? 'Chrome 扩展执行失败'))
    }
  }

  private flush(): void {
    const conn = this.conn
    if (conn === null) return
    const commands = [...this.unacked.entries()].map(([seq, entry]) => ({ seq, ...entry }))
    if (commands.length > 0) conn.send(JSON.stringify({ kind: 'commands', commands }))
  }
}

/** CDP backend: the Chrome class plus per-tab endpoint operations. */
export class CdpBackend implements BrowserBackend {
  private readonly chrome: Chrome

  constructor(chrome: Chrome) {
    this.chrome = chrome
  }

  async ensure(): Promise<void> {
    await this.chrome.ensure()
  }

  async activeTabId(): Promise<string> {
    const tabs = await this.listTabs()
    const tab = tabs.find(candidate => candidate.active) ?? tabs[0]
    if (tab === undefined) throw new Error('no Chrome tab available; open one with chrome_open')
    return tab.id
  }

  async listTabs(): Promise<BackendTab[]> {
    const tabs = await this.chrome.listTabsWithFavicons()
    return tabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url, active: tab.active, favicon: tab.favicon }))
  }

  async openTab(url: string): Promise<BackendTab> {
    // Same idempotence guard as the extension backend: reuse an existing tab
    // for the URL so retried opens do not multiply windows.
    if (url !== '' && url !== 'about:blank') {
      const tabs = await this.listTabs()
      const existing = tabs.find(tab => tab.url === url && tab.url !== '')
      if (existing !== undefined) return existing
    }
    const tab = await this.chrome.openTab(url)
    return { ...tab, favicon: '' }
  }

  async read(tabId: string, includeHtml: boolean): Promise<BackendRead> {
    return this.withTab(tabId, async endpoint => {
      const value = await this.evaluatePage(endpoint, readPageExpression(includeHtml)) as Record<string, unknown> | undefined
      return {
        title: typeof value?.title === 'string' ? value.title : '',
        url: typeof value?.url === 'string' ? value.url : '',
        text: typeof value?.text === 'string' ? value.text : '',
        html: typeof value?.html === 'string' ? value.html : '',
      }
    })
  }

  async navigate(tabId: string, url: string, waitLoad: boolean, waitLoadMs: number): Promise<void> {
    await this.withTab(tabId, async endpoint => {
      const result = await endpoint.call('Page.navigate', { url })
      const errorText = typeof result.errorText === 'string' ? result.errorText : undefined
      if (errorText !== undefined) throw new Error(`chrome_navigate failed: ${errorText}`)
      if (waitLoad && waitLoadMs > 0) {
        const deadline = Date.now() + waitLoadMs
        while (Date.now() < deadline) {
          if (await this.evaluatePage(endpoint, readyStateExpression()) === 'complete') return
          await sleep(300)
        }
      }
    })
  }

  async evaluate(tabId: string, expression: string): Promise<unknown> {
    return this.withTab(tabId, endpoint => this.evaluatePage(endpoint, expression))
  }

  async click(tabId: string, selector: string, all: boolean): Promise<number> {
    return this.withTab(tabId, async endpoint => {
      const count = await this.evaluatePage(endpoint, clickExpression(selector, all))
      return typeof count === 'number' ? count : 0
    })
  }

  async type(tabId: string, selector: string, text: string, clear: boolean): Promise<void> {
    await this.withTab(tabId, async endpoint => {
      const focused = await this.evaluatePage(
        endpoint,
        clear ? focusAndSelectExpression(selector) : focusExpression(selector),
      )
      if (focused !== true) throw new Error(`chrome_type: no element matched selector "${selector}"`)
      await endpoint.call('Input.insertText', { text })
    })
  }

  async screenshot(tabId: string): Promise<{ data: string; path?: string; mime?: string }> {
    return this.withTab(tabId, async endpoint => {
      const result = await endpoint.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      return { data: typeof result.data === 'string' ? result.data : '', mime: 'image/png' }
    })
  }

  dispose(): void {
    this.chrome.dispose()
  }

  private async withTab<T>(tabId: string, fn: (endpoint: CdpEndpoint) => Promise<T>): Promise<T> {
    const { endpoint } = await this.chrome.tabEndpoint(tabId, undefined)
    try {
      return await fn(endpoint)
    } finally {
      endpoint.close()
    }
  }

  private async evaluatePage(endpoint: CdpEndpoint, expression: string): Promise<unknown> {
    const response = await endpoint.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    const details = response.exceptionDetails
    if (typeof details === 'object' && details !== null) {
      const record = details as Record<string, unknown>
      const text = typeof record.text === 'string' ? record.text : 'exception'
      const exception = record.exception
      const description = typeof exception === 'object' && exception !== null
        && typeof (exception as Record<string, unknown>).description === 'string'
        ? `: ${(exception as Record<string, unknown>).description as string}`
        : ''
      throw new Error(`page evaluation failed${description} (${text})`)
    }
    const remote = response.result
    return typeof remote === 'object' && remote !== null ? (remote as Record<string, unknown>).value : undefined
  }
}

/** Build the configured backend. */
export function buildBackend(config: ResolvedChromeConfig): { backend: BrowserBackend; chrome?: Chrome } {
  if (config.backend === 'cdp') {
    const chrome = new Chrome(config)
    return { backend: new CdpBackend(chrome), chrome }
  }
  return { backend: new ExtensionBackend(config) }
}

/** The WS upgrade handler the routes register: handshake then attach. */
export function extensionUpgradeHandler(backend: BrowserBackend): (req: { headers: Record<string, string | string[] | undefined> }, socket: Duplex, head: Buffer) => void {
  return (req, socket, head) => {
    if (!(backend instanceof ExtensionBackend) || !wsHandshake(req as never, socket)) return
    backend.attach(socket, head)
    socket.on('close', () => backend.detach())
  }
}
