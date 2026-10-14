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
import { consoleMessageFrom } from './console-events.ts'
import type { CapturedMessage } from './console-events.ts'
import {
  clickExpression,
  focusAndSelectExpression,
  focusExpression,
  hoverExpression,
  inventoryExpression,
  pressExpression,
  readPageExpression,
  readyStateExpression,
  selectExpression,
  waitExpression,
} from './expressions.ts'
import type { WaitState } from './expressions.ts'
import { Chrome } from './chrome.ts'
import type { ResolvedChromeConfig } from './chrome.ts'
import { WsConnection, wsHandshake } from './ws.ts'
import { pageSizeExpression, rectExpression } from './expressions.ts'
import { extensionStamp, extensionVersion } from './extension-package.ts'

/**
 * What a screenshot should cover.
 *
 * Absent fields mean "the visible viewport", which is what a caller who just
 * wants the page as the user sees it needs.
 */
export interface ScreenshotOptions {
  /** Capture the whole scrollable page rather than the viewport. */
  fullPage?: boolean
  /** Capture one element instead, matched by CSS selector. */
  selector?: string
}

/**
 * Longest edge a capture may produce, in device pixels.
 *
 * A page can be far taller than this, and a texture beyond the GPU's limit
 * makes the capture fail outright rather than downscale it. Width follows the
 * scale, so the aspect ratio stays the page's.
 */
const MAX_CAPTURE_PX = 16_000

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

/** One interactive element, as the page reports it. */
export interface InteractiveElement {
  /** Selector that addresses this element from the document root. */
  selector: string
  /** ARIA role, or the tag name when the element declares none. */
  role: string
  /** Label, text, value or placeholder — whichever the element offers first. */
  name: string
  /** Whether the element's centre lies inside the viewport. */
  inView: boolean
  /** Natively disabled, or marked `aria-disabled="true"`. */
  disabled: boolean
  /** Another element sits at the element's centre, so a real click would miss it. */
  covered: boolean
}

/** What one page's interactive elements are, and how many were left out. */
export interface BackendInventory {
  /** Page title when the listing was taken. */
  title: string
  /** Page URL when the listing was taken. */
  url: string
  /** Elements the inventory selector matched, before the cap. */
  matched: number
  /** The reported elements, in document order. */
  items: InteractiveElement[]
}

/**
 * What one click actually did. `clicked` counts elements that received a
 * dispatched click event — never merely elements the selector matched, which is
 * the distinction a caller needs to tell "the page ignored it" from "nothing
 * was there". The remaining counters explain clicks that were refused or that a
 * real pointer could not have delivered.
 */
export interface ClickOutcome {
  /** Elements the selector matched. */
  matched: number
  /** Elements that received a dispatched click event. */
  clicked: number
  /** Matched elements whose native `disabled` state suppresses the click event. */
  disabled: number
  /** Clicked elements with no layout box, or `display:none` / `visibility:hidden`. */
  invisible: number
  /** Clicked elements whose centre lies outside the viewport. */
  offscreen: number
  /** Clicked elements where a hit test at their centre lands on another element. */
  covered: number
  /** Clicked elements carrying `aria-disabled="true"`, which dispatches but asks consumers to ignore it. */
  ariaDisabled: number
}

/** Where captured console messages go: the host's bounded per-tab buffer. */
export type ConsoleSink = (tabId: string, message: CapturedMessage) => void

/** What one key press did. */
export interface PressOutcome {
  /** Whether a target existed: the selector's match, or whatever had focus. */
  found: boolean
  /** Whether the key events were dispatched. */
  pressed: boolean
  /**
   * Whether the owning form was submitted explicitly. Synthetic key events
   * trigger no browser default action, so Enter would otherwise do nothing.
   */
  submitted: boolean
}

/** What one `<select>` assignment did. */
export interface SelectOutcome {
  /** Elements the selector matched. */
  matched: number
  /** Whether the value actually changed; false means the control was left alone. */
  changed: boolean
  /** The value in effect after the attempt. */
  value: string
  /** Values the control offered, so a failed match can name them. */
  options: string[]
  /** Why the control could not be selected, when it is not a `<select>`. */
  reason?: string
}

/** What one hover did. */
export interface HoverOutcome {
  /** Elements the selector matched. */
  matched: number
  /** Whether the first match received the hover events. */
  hovered: boolean
}

/** The face every chrome_* tool speaks to. */
export interface BrowserBackend {
  /** Bring the browser online; throws a user-actionable error when impossible. */
  ensure(): Promise<void>
  /** Local tab id for the "active" fallback. */
  activeTabId(): Promise<string>
  listTabs(): Promise<BackendTab[]>
  openTab(url: string): Promise<BackendTab>
  /** Close one tab. Closing the last tab of a window closes that window. */
  closeTab(tabId: string): Promise<void>
  read(tabId: string, includeHtml: boolean): Promise<BackendRead>
  /** List one tab's interactive elements with what a reader must know before acting on them. */
  inventory(tabId: string): Promise<BackendInventory>
  navigate(tabId: string, url: string, waitLoad: boolean, waitLoadMs: number): Promise<void>
  /** Wait for one tab to reach `readyState === "complete"`, or the bound to elapse. */
  waitForLoad(tabId: string, waitLoadMs: number): Promise<void>
  evaluate(tabId: string, expression: string): Promise<unknown>
  /**
   * How the most recent `evaluate` reached the page. `'main'` is the page's own
   * world, where its JavaScript globals live. `'debugger'` is the debugger
   * protocol, taken when the page's Content-Security-Policy forbids `eval` —
   * same semantics, different mechanism, and it shows the debugger infobar on
   * that tab. `chrome_eval` reports the non-default route. Undefined before the
   * first evaluation, and on backends that have only the one route.
   */
  readonly lastEvalWorld: 'main' | 'debugger' | undefined
  click(tabId: string, selector: string, all: boolean): Promise<ClickOutcome>
  /** Dispatch hover input on the first element matching the selector. */
  hover(tabId: string, selector: string): Promise<HoverOutcome>
  /** Press one key on the selector's match, or on whatever currently has focus. */
  press(tabId: string, key: string, selector?: string): Promise<PressOutcome>
  /** Set a `<select>`'s value. */
  select(tabId: string, selector: string, value: string): Promise<SelectOutcome>
  /**
   * Poll one element condition until it holds or the bound elapses.
   * @returns whether it held; false means the bound passed, not that the page failed.
   */
  waitFor(tabId: string, selector: string, state: WaitState, timeoutMs: number): Promise<boolean>
  type(tabId: string, selector: string, text: string, clear: boolean): Promise<void>
  screenshot(tabId: string, options?: ScreenshotOptions): Promise<{ data: string; path?: string; mime?: string }>
  /** Begin forwarding one tab's console output to the sink; idempotent. */
  startConsole(tabId: string): Promise<void>
  /** Stop forwarding one tab's console output; idempotent. */
  stopConsole(tabId: string): Promise<void>
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
 * Poll one tab's `document.readyState` until it reports `complete` or the bound
 * elapses. Reaching the bound is not an error: a page that never settles (a
 * long-polling app, a stalled asset) must still hand control back to the model,
 * which can read what is there and decide what to do.
 * @param evaluate - runs one expression in the tab.
 * @param waitLoadMs - the bound; zero or less returns immediately.
 */
async function awaitReady(evaluate: (expression: string) => Promise<unknown>, waitLoadMs: number): Promise<void> {
  if (waitLoadMs <= 0) return
  const deadline = Date.now() + waitLoadMs
  while (Date.now() < deadline) {
    if (await evaluate(readyStateExpression()) === 'complete') return
    await sleep(300)
  }
}

/** Poll interval for `waitFor`, milliseconds. */
const WAIT_POLL_MS = 100

/**
 * Poll one boolean expression until it answers true or the bound elapses. It is
 * always evaluated at least once, so a zero bound asks "does it hold now?".
 * @param evaluate - runs one expression in the tab.
 * @param expression - the condition to poll.
 * @param timeoutMs - the bound.
 * @returns whether the condition held before the bound passed.
 */
async function awaitTruthy(
  evaluate: (expression: string) => Promise<unknown>,
  expression: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await evaluate(expression) === true) return true
    if (Date.now() >= deadline) return false
    await sleep(WAIT_POLL_MS)
  }
}

/** Read a hover result from the page or the bridge. */
export function mapHover(value: unknown): HoverOutcome {
  if (typeof value !== 'object' || value === null) return { matched: 0, hovered: false }
  const source = value as Record<string, unknown>
  return { matched: counter(source, 'matched'), hovered: source.hovered === true }
}

/** Read a press result from the page or the bridge. */
export function mapPress(value: unknown): PressOutcome {
  if (typeof value !== 'object' || value === null) return { found: false, pressed: false, submitted: false }
  const source = value as Record<string, unknown>
  return {
    found: flag(source, 'found'),
    pressed: flag(source, 'pressed'),
    submitted: flag(source, 'submitted'),
  }
}

/** Read a select result from the page or the bridge. */
export function mapSelect(value: unknown): SelectOutcome {
  if (typeof value !== 'object' || value === null) {
    return { matched: 0, changed: false, value: '', options: [] }
  }
  const source = value as Record<string, unknown>
  const reason = typeof source.reason === 'string' && source.reason !== '' ? source.reason : undefined
  return {
    matched: counter(source, 'matched'),
    changed: flag(source, 'changed'),
    value: typeof source.value === 'string' ? source.value : '',
    options: Array.isArray(source.options)
      ? source.options.filter((option): option is string => typeof option === 'string')
      : [],
    ...(reason === undefined ? {} : { reason }),
  }
}

/**
 * The error a side-effectful command produces when it was sent and no outcome
 * came back — a disconnect, a timeout, or a bridge that gave up mid-operation.
 *
 * The distinction matters to the model: a command that FAILED is safe to retry,
 * while a command whose outcome is UNKNOWN is not. A re-sent click is a second
 * click and a re-sent type is a second insertion, so the message says what to do
 * instead. Commands in `SAFE_RETRY_OPS` never reach this: they are side-effect
 * free and replay on reconnect.
 * @param op - the operation whose outcome is unknown, when it is known.
 * @param cause - what went wrong, for whoever reads the transcript.
 * @returns the error to reject the command with.
 */
function unknownOutcome(op: string | undefined, cause: string): Error {
  return new Error(
    `${op ?? '命令'} 结果未知(${cause}):命令已发出但没有收到执行结果,页面可能已经改变。`
    + '不要直接重试,先用 chrome_tabs / chrome_read 确认页面当前状态。',
  )
}

/** Read one click counter from an untrusted result, treating anything else as absent. */
function counter(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Map a click result onto {@link ClickOutcome}. A bare number is accepted as the
 * pre-0.4 bridge's "matched and clicked" count, so a Chrome extension still
 * loaded from an older package keeps working until it is reloaded.
 * @param value - the evaluated page value or the bridge's reply payload.
 * @returns the outcome, with every field defaulted.
 */
export function mapClickOutcome(value: unknown): ClickOutcome {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return { matched: value, clicked: value, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0 }
  }
  if (typeof value !== 'object' || value === null) {
    return { matched: 0, clicked: 0, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0 }
  }
  const source = value as Record<string, unknown>
  return {
    matched: counter(source, 'matched'),
    clicked: counter(source, 'clicked'),
    disabled: counter(source, 'disabled'),
    invisible: counter(source, 'invisible'),
    offscreen: counter(source, 'offscreen'),
    covered: counter(source, 'covered'),
    ariaDisabled: counter(source, 'ariaDisabled'),
  }
}

/** Read one boolean field, treating anything but `true` as false. */
function flag(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true
}

/**
 * Map an inventory result from the page or the bridge onto
 * {@link BackendInventory}. An unusable reply becomes an empty inventory rather
 * than an error: the caller asked what it can act on, and "nothing reported" is
 * a truthful answer for a page that would not answer.
 * @param value - the evaluated page value or the bridge's reply payload.
 * @returns the inventory, with unreadable entries dropped.
 */
export function mapInventory(value: unknown): BackendInventory {
  if (typeof value !== 'object' || value === null) return { title: '', url: '', matched: 0, items: [] }
  const source = value as Record<string, unknown>
  const raw = Array.isArray(source.items) ? source.items : []
  const items: InteractiveElement[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const item = entry as Record<string, unknown>
    const selector = typeof item.selector === 'string' ? item.selector : ''
    if (selector === '') continue
    items.push({
      selector,
      role: typeof item.role === 'string' ? item.role : '',
      name: typeof item.name === 'string' ? item.name : '',
      inView: flag(item, 'inView'),
      disabled: flag(item, 'disabled'),
      covered: flag(item, 'covered'),
    })
  }
  return {
    title: typeof source.title === 'string' ? source.title : '',
    url: typeof source.url === 'string' ? source.url : '',
    matched: counter(source, 'matched'),
    items,
  }
}

/**
 * Extension bridge backend: commands are queued, sent over the bridge
 * WebSocket, and resolved when the extension replies. The socket is attached
 * by the `/chrome-browser/ext/ws` upgrade route.
 */
export class ExtensionBackend implements BrowserBackend {
  /** @inheritdoc BrowserBackend.lastEvalWorld */
  lastEvalWorld: 'main' | 'debugger' | undefined = undefined

  /**
   * Ops a disconnect may transparently retry on the next reconnect: they are
   * side-effect free or idempotent, so a lost result is safe to recompute.
   * Side-effectful ops (open/navigate/click/type) are NEVER auto-resent — the
   * caller gets the disconnect error and the model retries explicitly (no
   * duplicate tabs/clicks/typing from hidden replays). Console capture is
   * idempotent and the extension re-arms it on reconnect, so retrying it is
   * how a restarted service worker gets its capture back.
   */
  private static readonly SAFE_RETRY_OPS = new Set([
    'list-tabs', 'read', 'eval', 'screenshot', 'console-start', 'console-stop',
  ])
  /**
   * In-flight dedupe keys for side-effectful ops: a second identical command
   * while the first is still in flight JOIN it instead of firing twice
   * (model retries can otherwise double-click / double-open).
   */
  private readonly inFlight = new Map<string, Promise<unknown>>()

  private conn: WsConnection | null = null
  /** What the extension last said about itself; null before its first hello. */
  private extension: { version: string; ops: readonly string[]; build: string } | null = null
  /**
   * The stale build stamp an automatic reload was last asked for, or null.
   *
   * Keyed by stamp rather than by attempt: a reload that cannot move the
   * extension off one build must never be asked for twice — that would reload
   * it on every heartbeat — while a mismatch at a *different* build is a
   * different problem and deserves its own attempt, so two upgrades within one
   * host process both settle.
   */
  private reloadAskedFor: string | null = null
  /**
   * Set when a build the host already asked about came back unchanged.
   *
   * The reload usually works. When it does not, the extension is re-reading a
   * DIFFERENT copy of its files than the one this plugin ships — which happens
   * when the install method changes while the host is running, because the host
   * keeps resolving its old module path while Chrome keeps serving the copy it
   * loaded. No number of reloads can close that, so it is reported rather than
   * retried.
   */
  private reloadIneffective = false
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

  /** Where console messages from the bridge land. */
  constructor(
    private readonly config: ResolvedChromeConfig,
    private readonly onConsole: ConsoleSink = () => {},
  ) {}

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
      entry.reject(unknownOutcome(op, 'Chrome 扩展已断开连接'))
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

  async inventory(tabId: string): Promise<BackendInventory> {
    return mapInventory(await this.push('inventory', { tabId }))
  }

  async closeTab(tabId: string): Promise<void> {
    await this.push('close', { tabId })
  }

  async navigate(tabId: string, url: string, waitLoad: boolean, waitLoadMs: number): Promise<void> {
    await this.push('navigate', { tabId, url })
    if (waitLoad) await this.waitForLoad(tabId, waitLoadMs)
  }

  async waitForLoad(tabId: string, waitLoadMs: number): Promise<void> {
    await awaitReady(expression => this.evaluate(tabId, expression), waitLoadMs)
  }

  async evaluate(tabId: string, expression: string): Promise<unknown> {
    const answer = await this.push('eval', { tabId, expression })
    // An extension built before this envelope answers with the bare value; a
    // current one tags it. The tag is what keeps an expression that legitimately
    // returns `{ ok, value }` from being read as an envelope.
    if (typeof answer !== 'object' || answer === null || (answer as { __dshEval?: unknown }).__dshEval !== 1) {
      this.lastEvalWorld = undefined
      return answer
    }
    const envelope = answer as { ok?: unknown; value?: unknown; world?: unknown; error?: unknown }
    if (envelope.ok !== true) {
      this.lastEvalWorld = undefined
      throw new Error(typeof envelope.error === 'string' && envelope.error !== ''
        ? `chrome_eval: ${envelope.error}`
        : 'chrome_eval: 表达式执行失败')
    }
    this.lastEvalWorld = envelope.world === 'debugger' ? 'debugger' : 'main'
    return envelope.value
  }

  async click(tabId: string, selector: string, all: boolean): Promise<ClickOutcome> {
    return mapClickOutcome(await this.push('click', { tabId, selector, all }))
  }

  async hover(tabId: string, selector: string): Promise<HoverOutcome> {
    return mapHover(await this.push('hover', { tabId, selector }))
  }

  async press(tabId: string, key: string, selector?: string): Promise<PressOutcome> {
    return mapPress(await this.push('press', selector === undefined
      ? { tabId, key }
      : { tabId, key, selector }))
  }

  async select(tabId: string, selector: string, value: string): Promise<SelectOutcome> {
    return mapSelect(await this.push('select', { tabId, selector, value }))
  }

  async waitFor(tabId: string, selector: string, state: WaitState, timeoutMs: number): Promise<boolean> {
    return awaitTruthy(expression => this.evaluate(tabId, expression), waitExpression(selector, state), timeoutMs)
  }

  async type(tabId: string, selector: string, text: string, clear: boolean): Promise<void> {
    const done = await this.push('type', { tabId, selector, text, clear })
    if (done !== true) throw new Error(`chrome_type: no element matched selector "${selector}"`)
  }

  async screenshot(tabId: string, options?: ScreenshotOptions): Promise<{ data: string; path?: string; mime?: string }> {
    // The extension uploads the image bytes over plain HTTP back to the host
    // and returns only the file path: a large base64 frame inside a WS JSON
    // message closed the bridge right after a successful capture.
    const result = await this.push('screenshot', {
      tabId,
      fullPage: options?.fullPage === true,
      ...(options?.selector === undefined ? {} : { selector: options.selector }),
    }) as { path?: string; mime?: string } | null
    return result?.path !== undefined
      ? (result.mime !== undefined
          ? { data: '', path: result.path, mime: result.mime }
          : { data: '', path: result.path })
      : { data: '' }
  }

  async startConsole(tabId: string): Promise<void> {
    // The extension attaches its debugger and forwards events; it also persists
    // the capture set, so a service worker that Chrome suspends re-arms it.
    await this.push('console-start', { tabId })
  }

  async stopConsole(tabId: string): Promise<void> {
    await this.push('console-stop', { tabId })
  }

  dispose(): void {
    this.detach()
    this.conn?.close()
  }

  /**
   * What the connected extension reports about itself, for the status route.
   * `stale` means its files are older than the ones this package ships, which
   * only a reload of the extension can fix.
   */
  extensionStatus(): {
    version: string
    expectedVersion: string
    build: string
    expectedBuild: string
    stale: boolean
    autoReloadAsked: boolean
    reloadAskedFor: string
    reloadIneffective: boolean
    ops: string
  } {
    const expectedBuild = extensionStamp(import.meta.url)
    const build = this.extension?.build ?? ''
    return {
      version: this.extension?.version ?? '',
      expectedVersion: extensionVersion(import.meta.url),
      build,
      expectedBuild,
      // The stamp decides. It is baked into the worker, so it describes the
      // code Chrome loaded — a version number nobody bumped would not.
      stale: build !== '' && expectedBuild !== '' && build !== expectedBuild,
      autoReloadAsked: this.reloadAskedFor !== null,
      // The two facts that decide whether an automatic update can still happen:
      // which stamp was already asked about, and whether the extension even
      // advertises the op that performs it. Both are here because a stalled
      // update is otherwise indistinguishable from a reload that did not help.
      reloadAskedFor: this.reloadAskedFor ?? '',
      reloadIneffective: this.reloadIneffective,
      ops: (this.extension?.ops ?? []).join(','),
    }
  }

  /**
   * Record the extension's self-report, and ask it to reload when it is running
   * older files than this package ships.
   *
   * Chrome never re-reads an unpacked extension's files, so an upgraded plugin
   * would otherwise keep driving a stale bridge until the user reloaded it by
   * hand. `chrome.runtime.reload()` is the only thing that re-reads them.
   */
  private noteExtensionHello(message: Record<string, unknown>): void {
    const version = typeof message.version === 'string' ? message.version : ''
    const build = typeof message.build === 'string' ? message.build : ''
    const ops = Array.isArray(message.ops)
      ? message.ops.filter((op): op is string => typeof op === 'string')
      : []
    this.extension = { version, ops, build }
    const expected = extensionStamp(import.meta.url)
    if (build === '' || expected === '' || build === expected) {
      this.reloadIneffective = false
      return
    }
    if (!ops.includes('reload')) return
    if (this.reloadAskedFor === build) {
      // Asked about this exact build and it is still what the extension runs.
      this.reloadIneffective = true
      return
    }
    this.reloadIneffective = false
    // The attempt is spent only once the request is on the wire. Marking it
    // first made a request that never went out — refused by the capability
    // check, or lost with the socket — indistinguishable from a reload that
    // ran and did not help, and the extension was then never asked again.
    // Carries the stamp it is asked about, which is what makes two requests
    // distinct to the in-flight dedupe rather than one request twice.
    void this.push('reload', { build }).then(
      () => { this.reloadAskedFor = build },
      () => undefined,
    )
  }

  /**
   * Refuse an op the connected extension does not advertise.
   *
   * Sending it anyway earns `unknown op` back — an internal error that says
   * nothing about the real cause, which is an extension whose files are older
   * than the plugin driving it.
   */
  private assertExtensionSupports(op: string): void {
    const known = this.extension?.ops
    if (known === undefined || known.length === 0) return
    if (known.includes(op)) return
    throw new Error(
      `扩展不支持 ${op}(它自报的版本是 ${this.extension?.version ?? '未知'},插件期望 `
      + `${extensionVersion(import.meta.url)})——扩展文件比插件旧,请在 chrome://extensions 重新加载该扩展。`,
    )
  }

  private push(op: string, args: Record<string, unknown>): Promise<unknown> {
    this.assertExtensionSupports(op)
    // Concurrent duplicate of a side-effectful command joins the in-flight
    // one (model retries double-clicking / double-opening otherwise).
    //
    // Keyed on every argument, not just the target: two waits on one selector
    // differ by state and deadline, and two reloads differ by the version they
    // are stale at. Merging those would answer the second call with the first
    // call's result. Ops absent from SAFE_RETRY_OPS are never replayed across a
    // reconnect, so replaying a reload through that set would loop forever.
    const dedupeKey = ExtensionBackend.SAFE_RETRY_OPS.has(op) ? undefined
      : `${op}:${JSON.stringify(args)}`
    if (dedupeKey !== undefined) {
      const existing = this.inFlight.get(dedupeKey)
      if (existing !== undefined) return existing
    }
    const seq = ++this.seq
    this.unacked.set(seq, { op, args })
    // A timeout means the extension never answered. For a side-effectful op the
    // command may still have run, so the caller gets the unknown-outcome error
    // rather than a plain failure it would retry.
    const sideEffectful = dedupeKey !== undefined
    const outcome = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        this.unacked.delete(seq)
        reject(sideEffectful
          ? unknownOutcome(op, `Chrome 扩展 ${this.config.timeoutMs}ms 内未应答`)
          : new Error(`Chrome 扩展 ${op} 超时(${this.config.timeoutMs}ms)`))
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
    let message: { kind?: unknown; results?: unknown; event?: unknown; tabId?: unknown; entries?: unknown }
    try {
      message = JSON.parse(text) as typeof message
    } catch {
      return
    }
    if (message.kind === 'event') {
      this.onEventFrame(message)
      return
    }
    if (message.kind === 'hello') {
      this.noteExtensionHello(message as unknown as Record<string, unknown>)
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

  /**
   * One pushed console batch. Anything unrecognized is dropped rather than
   * throwing: this is a wire boundary, and a malformed event must not kill the
   * connection that carries the commands.
   */
  private onEventFrame(message: { event?: unknown; tabId?: unknown; entries?: unknown }): void {
    if (message.event !== 'console') return
    const tabId = message.tabId === undefined || message.tabId === null ? '' : String(message.tabId)
    if (tabId === '' || !Array.isArray(message.entries)) return
    for (const raw of message.entries) {
      if (typeof raw !== 'object' || raw === null) continue
      const entry = raw as Record<string, unknown>
      const text = typeof entry.text === 'string' ? entry.text : ''
      if (text === '') continue
      const level = typeof entry.level === 'string' && entry.level !== '' ? entry.level : 'log'
      const source = typeof entry.source === 'string' && entry.source !== '' ? entry.source : undefined
      this.onConsole(tabId, source === undefined ? { level, text } : { level, text, source })
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
  /** @inheritdoc BrowserBackend.lastEvalWorld */
  lastEvalWorld: 'main' | 'debugger' | undefined = undefined

  private readonly chrome: Chrome
  /**
   * Long-lived sessions held open for console capture, one per capturing tab.
   * Every other operation opens and closes its own session; capture cannot,
   * because the events arrive between calls.
   */
  private readonly captures = new Map<string, CdpEndpoint>()

  constructor(chrome: Chrome, private readonly onConsole: ConsoleSink = () => {}) {
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

  async inventory(tabId: string): Promise<BackendInventory> {
    return this.withTab(tabId, async endpoint => (
      mapInventory(await this.evaluatePage(endpoint, inventoryExpression()))
    ))
  }

  async closeTab(tabId: string): Promise<void> {
    await this.chrome.closeTab(tabId)
  }

  async navigate(tabId: string, url: string, waitLoad: boolean, waitLoadMs: number): Promise<void> {
    await this.withTab(tabId, async endpoint => {
      const result = await endpoint.call('Page.navigate', { url })
      const errorText = typeof result.errorText === 'string' ? result.errorText : undefined
      if (errorText !== undefined) throw new Error(`chrome_navigate failed: ${errorText}`)
      if (waitLoad) await awaitReady(expression => this.evaluatePage(endpoint, expression), waitLoadMs)
    })
  }

  async waitForLoad(tabId: string, waitLoadMs: number): Promise<void> {
    // One CDP session for the whole wait, rather than one per poll.
    await this.withTab(tabId, endpoint => awaitReady(expression => this.evaluatePage(endpoint, expression), waitLoadMs))
  }

  async evaluate(tabId: string, expression: string): Promise<unknown> {
    // Runtime.evaluate is not subject to the page's CSP, so there is no second
    // world to fall back to.
    this.lastEvalWorld = 'main'
    return this.withTab(tabId, endpoint => this.evaluatePage(endpoint, expression))
  }

  async click(tabId: string, selector: string, all: boolean): Promise<ClickOutcome> {
    return this.withTab(tabId, async endpoint => (
      mapClickOutcome(await this.evaluatePage(endpoint, clickExpression(selector, all)))
    ))
  }

  async hover(tabId: string, selector: string): Promise<HoverOutcome> {
    return this.withTab(tabId, async endpoint => (
      mapHover(await this.evaluatePage(endpoint, hoverExpression(selector)))
    ))
  }

  async press(tabId: string, key: string, selector?: string): Promise<PressOutcome> {
    return this.withTab(tabId, async endpoint => (
      mapPress(await this.evaluatePage(endpoint, pressExpression(key, selector)))
    ))
  }

  async select(tabId: string, selector: string, value: string): Promise<SelectOutcome> {
    return this.withTab(tabId, async endpoint => (
      mapSelect(await this.evaluatePage(endpoint, selectExpression(selector, value)))
    ))
  }

  async waitFor(tabId: string, selector: string, state: WaitState, timeoutMs: number): Promise<boolean> {
    // One CDP session for the whole wait, rather than one per poll.
    return this.withTab(tabId, endpoint => (
      awaitTruthy(expression => this.evaluatePage(endpoint, expression), waitExpression(selector, state), timeoutMs)
    ))
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

  async screenshot(tabId: string, options?: ScreenshotOptions): Promise<{ data: string; path?: string; mime?: string }> {
    return this.withTab(tabId, async endpoint => {
      const beyond = options?.fullPage === true || options?.selector !== undefined
      const clip = options?.selector !== undefined
        ? await this.clipOf(endpoint, options.selector)
        : options?.fullPage === true ? await this.pageClipOf(endpoint) : undefined
      const result = await endpoint.call('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: beyond,
        ...(clip === undefined ? {} : { clip }),
      })
      return { data: typeof result.data === 'string' ? result.data : '', mime: 'image/png' }
    })
  }

  /**
   * Clip rectangle covering the whole page, scaled down when it would not fit.
   *
   * Without a clip, `captureBeyondViewport` returns exactly one viewport — the
   * flag permits reaching past the fold, it does not ask for it.
   * @param endpoint - the tab's CDP endpoint.
   * @returns the clip rectangle, with the scale that keeps it capturable.
   */
  private async pageClipOf(endpoint: CdpEndpoint): Promise<{ x: number; y: number; width: number; height: number; scale: number }> {
    const size = await this.evaluatePage(endpoint, pageSizeExpression()) as
      | { width?: unknown; height?: unknown; dpr?: unknown }
      | undefined
    const width = Number(size?.width)
    const height = Number(size?.height)
    if (!(width > 0) || !(height > 0)) throw new Error('截图失败:读不到页面尺寸')
    const device = height * (Number(size?.dpr) || 1)
    return { x: 0, y: 0, width, height, scale: device > MAX_CAPTURE_PX ? MAX_CAPTURE_PX / device : 1 }
  }

  /**
   * One element's clip rectangle, or a failure naming the selector.
   * @param endpoint - the tab's CDP endpoint.
   * @param selector - CSS selector of the element to capture.
   * @returns the clip rectangle in page coordinates.
   */
  private async clipOf(endpoint: CdpEndpoint, selector: string): Promise<{ x: number; y: number; width: number; height: number; scale: number }> {
    const box = await this.evaluatePage(endpoint, rectExpression(selector)) as
      | { matched?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown }
      | undefined
    if (box?.matched !== 1) throw new Error(`截图失败:没有匹配 ${selector} 的元素`)
    const { x, y, width, height } = box as { x: number; y: number; width: number; height: number }
    if (!(width > 0) || !(height > 0)) throw new Error(`截图失败:${selector} 没有可见尺寸(宽 ${width} 高 ${height})`)
    return { x, y, width, height, scale: 1 }
  }

  async startConsole(tabId: string): Promise<void> {
    if (this.captures.has(tabId)) return
    const { endpoint } = await this.chrome.tabEndpoint(tabId, undefined)
    try {
      endpoint.onEvent((method, params) => {
        const message = consoleMessageFrom(method, params)
        if (message !== undefined) this.onConsole(tabId, message)
      })
      // `Log.enable` also replays entries the browser buffered before it was
      // enabled, which is the closest thing to capturing from page load.
      await endpoint.call('Runtime.enable')
      await endpoint.call('Log.enable')
    } catch (error) {
      endpoint.close()
      throw error
    }
    this.captures.set(tabId, endpoint)
  }

  async stopConsole(tabId: string): Promise<void> {
    const endpoint = this.captures.get(tabId)
    if (endpoint === undefined) return
    this.captures.delete(tabId)
    endpoint.close()
  }

  dispose(): void {
    for (const endpoint of this.captures.values()) endpoint.close()
    this.captures.clear()
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

/**
 * Build the configured backend.
 * @param config - the resolved plugin configuration.
 * @param onConsole - where captured console messages land.
 * @returns the backend, plus the `Chrome` instance the CDP path owns.
 */
export function buildBackend(
  config: ResolvedChromeConfig,
  onConsole: ConsoleSink = () => {},
): { backend: BrowserBackend; chrome?: Chrome } {
  if (config.backend === 'cdp') {
    const chrome = new Chrome(config)
    return { backend: new CdpBackend(chrome, onConsole), chrome }
  }
  return { backend: new ExtensionBackend(config, onConsole) }
}

/** The WS upgrade handler the routes register: handshake then attach. */
export function extensionUpgradeHandler(backend: BrowserBackend): (req: { headers: Record<string, string | string[] | undefined> }, socket: Duplex, head: Buffer) => void {
  return (req, socket, head) => {
    if (!(backend instanceof ExtensionBackend) || !wsHandshake(req as never, socket)) return
    backend.attach(socket, head)
    socket.on('close', () => backend.detach())
  }
}
