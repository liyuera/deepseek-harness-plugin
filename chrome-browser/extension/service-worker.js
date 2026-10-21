/**
 * dsh Chrome Control service worker: a long-lived WebSocket to the local dsh
 * host. The host pushes commands (list tabs / read / eval / click / type /
 * navigate / open / screenshot); this worker executes them against the real
 * browser and pushes results back. The open socket keeps the worker alive,
 * and the 15s ping keeps both sides honest.
 */

/**
 * dsh web origins, tried in order until one accepts the socket. 21987 is the
 * plugin's own fixed bridge port (it is not the dsh web server's port, which
 * the desktop client assigns at launch); 3080 is a source-launched
 * `pnpm dsh web` fallback. The upload origin follows the socket that connected.
 */
const WS_URLS = [
  'ws://127.0.0.1:21987/chrome-browser/ext/ws',
  'ws://127.0.0.1:3080/chrome-browser/ext/ws',
]

let candidate = 0
/** Origin of the socket that last opened; the HTTP upload posts here. */
let hostOrigin = 'http://127.0.0.1:21987'
let socket = null
let retryMs = 1000
let closed = false
/** Last time any frame arrived from the host; drives the liveness watchdog. */
let lastHostMessageAt = 0
/**
 * When the last live socket closed; 0 while connected. The worker only stays
 * warm for a bounded window after this: a restarted dsh host takes seconds to
 * bind its bridge, but a host that stays down for hours must not pin the
 * service worker awake.
 */
let disconnectedAt = 0

/**
 * Whether the current socket blocks a new attempt.
 *
 * CONNECTING and OPEN clearly do. CLOSING must too: its `onclose` is still
 * pending, and it would null the global `socket` after a replacement opened,
 * orphaning the healthy connection and delaying the real reconnect.
 * @param current - the tracked socket, or null when none is current.
 * @returns whether a new socket must wait.
 */
function bridgeBusy(current) {
  return current !== null && current.readyState !== 3
}

function connect() {
  if (closed) return
  // Guard against duplicate sockets: alarms/heartbeat/wake-ups may call connect
  // while a socket is live or closing.
  if (bridgeBusy(socket)) return
  const url = WS_URLS[candidate]
  let opened = false
  let ws
  try {
    ws = new WebSocket(url)
  } catch {
    scheduleRetry()
    return
  }
  socket = ws
  ws.onopen = () => {
    // An obsolete socket must not announce itself or schedule work.
    if (socket !== ws) {
      ws.close()
      return
    }
    opened = true
    retryMs = 1000
    disconnectedAt = 0
    lastHostMessageAt = Date.now()
    hostOrigin = url.replace(/^ws/u, 'http').replace(/\/chrome-browser\/ext\/ws$/u, '')
    trace('open ' + url)
    hello()
    // Chrome suspends this worker when idle, which detaches the debugger and
    // silently ends console capture. Re-arm whatever was capturing.
    void rearmConsole()
  }
  ws.onmessage = (event) => {
    lastHostMessageAt = Date.now()
    void handle(event.data)
  }
  ws.onerror = () => { /* onclose follows */ }
  ws.onclose = (event) => {
    // A stale socket's close must not touch the socket that replaced it.
    if (socket !== ws) return
    trace('close ' + (event && event.code !== undefined ? event.code : '?'))
    socket = null
    disconnectedAt = nextDisconnectAt(opened, disconnectedAt, Date.now())
    // Nothing answered at this origin: advance before retrying, so a machine
    // running only the other profile connects without an edit. A socket that
    // did open keeps its origin — that host is the right one to reconnect to.
    if (!opened) candidate = (candidate + 1) % WS_URLS.length
    scheduleRetry()
  }
}


/**
 * Record when the current warm-window started.
 *
 * Only a live socket loss starts the window: a failed attempt is evidence that
 * the host is still down, not a new loss, and re-stamping it every attempt would
 * keep the worker warm forever. Passing `previous` back also keeps a fresh
 * worker cold until it has actually lost a connection.
 * @param opened - whether the socket that closed had opened.
 * @param previous - the loss time already recorded; 0 when none.
 * @param now - close time, milliseconds.
 * @returns the loss time to record.
 */
function nextDisconnectAt(opened, previous, now) {
  return opened ? now : previous
}

/**
 * Plan one bridge retry.
 *
 * The worker stays warm (snappy retries, bounded interval) only shortly after
 * losing a live connection: that is when a restarted host is booting. Past that
 * window, retries fall back to the cold cadence and the 30s alarm drives
 * reconnection, so a host that stays down does not keep the worker awake.
 * @param disconnectedAt - when the last live socket closed; 0 while connected.
 * @param attemptMs - the delay queued for this attempt.
 * @param now - current time, milliseconds.
 * @returns the delay to use now, whether to reset Chrome's idle clock, and the
 *   delay for the next attempt.
 */
function retryPlan(disconnectedAt, attemptMs, now) {
  const warm = disconnectedAt !== 0 && now - disconnectedAt < 300000
  return { delay: attemptMs, warm, nextAttemptMs: Math.min(attemptMs * 2, warm ? 5000 : 15000) }
}

/**
 * Reset Chrome's 30s idle clock.
 *
 * A suspended service worker cannot run its own retry timer, so without an
 * extension API call the warm retries below die exactly when a slow host boot
 * would have supplied the bridge. Calling an API resets the idle clock; this is
 * deliberately limited to the warm window in {@link retryPlan}.
 */
function touchWorker() {
  try {
    const pending = chrome.alarms.get('dsh-bridge')
    if (pending !== undefined && typeof pending.catch === 'function') pending.catch(() => {})
  } catch {
    // No chrome.alarms in a plain test scope: the retry timer still runs.
  }
}

function scheduleRetry() {
  const plan = retryPlan(disconnectedAt, retryMs, Date.now())
  if (plan.warm) touchWorker()
  setTimeout(connect, plan.delay)
  retryMs = plan.nextAttemptMs
}

/**
 * Wake the bridge on ordinary Chrome activity.
 *
 * A restarted host can only be found by an attempt; any tab switch, navigation
 * or window focus wakes the suspended worker, so the bridge comes back as soon
 * as the user touches Chrome instead of waiting for the 30s alarm.
 */
function wakeBridge() {
  // The same duplicate-socket guard `connect` applies: an in-flight, live or
  // closing socket must not be replaced by a second one.
  if (bridgeBusy(socket)) return
  connect()
}

/**
 * Whether the open bridge has gone silent long enough to abandon it.
 *
 * The host sends an application-level ping every 10s. A host process that is
 * stuck half-shut down can keep the TCP connection ESTABLISHED while serving
 * nothing; closing the socket is the only way to notice and reconnect.
 * @param lastMessageAt - when the host last sent any frame; 0 before the first.
 * @param now - current time, milliseconds.
 * @returns whether to drop the connection.
 */
function hostIsStale(lastMessageAt, now) {
  return lastMessageAt !== 0 && now - lastMessageAt > 45000
}

// MV3 service workers are suspended by Chrome after idle. The browser
// auto-pongs WS protocol pings without running JS, so the host ping alone
// does not keep this worker alive: a JS heartbeat interval keeps it warm,
// and the alarm below wakes a suspended worker so the bridge reconnects.
setInterval(() => {
  if (socket === null || socket.readyState !== 1) return
  if (hostIsStale(lastHostMessageAt, Date.now())) {
    // onclose schedules the retry; nothing else listens for a silent host.
    trace('close stale-host')
    socket.close()
    return
  }
  send({ kind: 'heartbeat' })
  // Re-introducing here is what lets the host notice that its own files were
  // updated underneath a running extension, without waiting for a reconnect.
  hello()
}, 20_000)

chrome.alarms.create('dsh-bridge', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'dsh-bridge' && (socket === null || socket.readyState !== 1)) connect()
})
chrome.runtime.onStartup.addListener(() => connect())
chrome.runtime.onInstalled.addListener(() => connect())
chrome.tabs.onActivated.addListener(() => wakeBridge())
chrome.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.status === 'complete' || typeof change.url === 'string') wakeBridge()
})
chrome.windows.onFocusChanged.addListener(() => wakeBridge())

/**
 * Ops this worker answers, sent to the host on connect and on every heartbeat.
 *
 * Chrome never re-reads an unpacked extension's files, so a host that shipped a
 * new op would otherwise only find out when the extension answered `unknown op`
 * — an internal error with no hint that a reload is what is missing. Comparing
 * this roster, and the version beside it, is what lets the host say so.
 * tests/extension-scope.spec.ts keeps the list equal to the cases in run().
 */
const SUPPORTED_OPS = [
  'list-tabs', 'read', 'inventory', 'wait', 'hover', 'press', 'select', 'eval',
  'click', 'type', 'console-start', 'console-stop', 'close', 'navigate', 'open',
  'screenshot', 'trace', 'reload', 'webmcp-list', 'webmcp-call',
]

/**
 * Fingerprint of this extension's own files, written by `npm run extension:stamp`
 * and checked by tests/extension-package.spec.ts.
 *
 * It is a constant rather than a hash computed here on purpose. Measured in a
 * real browser: `fetch(chrome.runtime.getURL('service-worker.js'))` returns the
 * file on DISK, not the copy Chrome loaded, so a runtime self-hash reported the
 * new bytes while the old code was still running — the host saw a match and the
 * user stayed on a stale extension with nothing to show for it. Only a value
 * carried by the loaded code can tell the host which code is loaded.
 */
const BUILD_HASH = '5705d1300af6088a998545e83bf2bc3ce58c5ae69de7d4983ad32fc10b1cc6bb'

/** Introduce this worker: what it runs, what it can answer, and which code it is. */
async function hello() {
  send({
    kind: 'hello',
    version: chrome.runtime.getManifest().version,
    ops: SUPPORTED_OPS,
    build: BUILD_HASH,
  })
}

function send(payload) {
  if (socket !== null && socket.readyState === 1) socket.send(JSON.stringify(payload))
}

function safe(value) {
  try {
    JSON.stringify(value)
    return value
  } catch {
    return String(value)
  }
}

// Persisted trace: survives service-worker kills (storage.local). Read it via
// the `trace` diagnostic op.
function trace(msg) {
  chrome.storage.local.get({ trace: [] }, data => {
    const lines = Array.isArray(data.trace) ? data.trace : []
    lines.push(`${Date.now()} ${msg}`)
    chrome.storage.local.set({ trace: lines.slice(-300) })
  })
}
trace('boot')

async function handle(data) {
  let message
  try {
    message = JSON.parse(data)
  } catch {
    return
  }
  if (message.kind === 'ping') {
    send({ kind: 'pong' })
    return
  }
  if (message.kind !== 'commands' || !Array.isArray(message.commands)) return
  const results = []
  for (const command of message.commands) {
    trace('op ' + command.op + ' ' + command.seq)
    try {
      // One stuck op (page hang, capture on a hidden window) must never block
      // the sequential loop; each op gets its own absolute deadline. The op was
      // already dispatched, so its outcome is unknown rather than failed — the
      // host must not have the model retry a click or a type blindly.
      const outcome = await Promise.race([
        run(command),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error(
          `${command.op} 超时(12s):结果未知,不要直接重试,先确认页面当前状态`,
        )), 12000)),
      ])
      results.push({ seq: command.seq, ok: true, data: safe(outcome) })
      trace('op-ok ' + command.seq)
    } catch (error) {
      trace('op-err ' + command.seq + ' ' + String((error && error.message) || error).slice(0, 80))
      results.push({ seq: command.seq, ok: false, error: String((error && error.message) || error) })
    }
  }
  if (results.length > 0) send({ kind: 'results', results })
}

// ---------------------------------------------------------------- console
//
// Console capture attaches Chrome's debugger to one tab and forwards what the
// page (and the browser) logs. It cannot be a wrapper around `console`: the
// most useful messages — failed requests, CSP refusals, deprecations — are
// raised by the browser, never by a page call. Attaching shows Chrome's
// "started debugging this browser" bar on that tab until capture stops.
//
// The host holds the entries in a bounded per-tab buffer; this worker only
// forwards. It keeps the capture set in storage.session so that a suspended
// worker can re-attach instead of losing capture silently.

/** storage.session key holding the tab ids currently captured. */
const CONSOLE_TABS_KEY = 'consoleTabs'

/** Entries buffered before a flush is forced, so a logging loop cannot grow it. */
const CONSOLE_QUEUE_MAX = 50

/** Delay that batches a burst into one frame. */
const CONSOLE_FLUSH_MS = 100

let consoleQueue = []
let consoleTimer = null

/** Tab ids this worker is capturing, from session storage (survives suspension). */
async function consoleTabs() {
  try {
    const data = await chrome.storage.session.get(CONSOLE_TABS_KEY)
    const tabs = data[CONSOLE_TABS_KEY]
    return Array.isArray(tabs) ? tabs.filter(id => typeof id === 'number') : []
  } catch {
    return []
  }
}

async function setConsoleTabs(tabs) {
  await chrome.storage.session.set({ [CONSOLE_TABS_KEY]: tabs })
}

/**
 * Mirrors `consoleMessageFrom` in the host's src/console-events.ts, which maps
 * the same events for the CDP backend. The bridge cannot import host modules,
 * so the two copies must stay in step; tests/console-capture.spec.ts requires
 * them to agree on the same recorded events.
 */
function renderRemote(value) {
  if (typeof value !== 'object' || value === null) return String(value)
  const type = typeof value.type === 'string' ? value.type : 'object'
  if (type === 'undefined') return 'undefined'
  if (value.value !== undefined && value.value !== null) return String(value.value)
  if (value.value === null) return 'null'
  const preview = typeof value.preview === 'object' && value.preview !== null ? value.preview : undefined
  if (preview !== undefined) {
    const properties = Array.isArray(preview.properties) ? preview.properties : []
    const rendered = properties.map((property) => {
      if (typeof property !== 'object' || property === null) return '?'
      const name = typeof property.name === 'string' ? property.name : '?'
      const shown = property.value !== undefined ? String(property.value) : String(property.type ?? '?')
      return `${name}: ${shown}`
    })
    const head = typeof preview.description === 'string' && preview.description !== '' ? preview.description : ''
    const more = preview.overflow === true ? ', …' : ''
    return `${head}{${rendered.join(', ')}${more}}`
  }
  if (typeof value.description === 'string' && value.description !== '') return value.description
  return type
}

function sourceFromStack(stackTrace) {
  if (typeof stackTrace !== 'object' || stackTrace === null) return undefined
  const frames = stackTrace.callFrames
  if (!Array.isArray(frames)) return undefined
  const first = frames[0]
  if (typeof first !== 'object' || first === null) return undefined
  const url = typeof first.url === 'string' ? first.url : ''
  const line = typeof first.lineNumber === 'number' ? first.lineNumber + 1 : undefined
  if (url === '') return undefined
  return line === undefined ? url : `${url}:${line}`
}

function sourceFromEntry(entry) {
  const url = typeof entry.url === 'string' ? entry.url : ''
  if (url === '') return undefined
  const line = typeof entry.lineNumber === 'number' ? entry.lineNumber : undefined
  return line === undefined ? url : `${url}:${line}`
}

const MAX_ARG_CHARS = 2048

function consoleMessageFrom(method, params) {
  if (method === 'Runtime.consoleAPICalled') {
    const args = Array.isArray(params.args) ? params.args : []
    const text = args.map(renderRemote).join(' ').slice(0, MAX_ARG_CHARS)
    const level = typeof params.type === 'string' ? params.type : 'log'
    const source = sourceFromStack(params.stackTrace)
    return source === undefined ? { level, text } : { level, text, source }
  }
  if (method === 'Log.entryAdded') {
    const entry = params.entry
    if (typeof entry !== 'object' || entry === null) return undefined
    const text = typeof entry.text === 'string' ? entry.text : ''
    if (text === '') return undefined
    const level = typeof entry.level === 'string' ? entry.level : 'info'
    const source = sourceFromEntry(entry)
    return source === undefined ? { level, text } : { level, text, source }
  }
  return undefined
}

/** Group a batch by tab and push one frame per tab. */
function flushConsole() {
  if (consoleTimer !== null) {
    clearTimeout(consoleTimer)
    consoleTimer = null
  }
  if (consoleQueue.length === 0) return
  const batch = consoleQueue
  consoleQueue = []
  const byTab = new Map()
  for (const item of batch) {
    const list = byTab.get(item.tabId)
    const entry = item.source === undefined
      ? { level: item.level, text: item.text }
      : { level: item.level, text: item.text, source: item.source }
    if (list === undefined) byTab.set(item.tabId, [entry])
    else list.push(entry)
  }
  for (const [tabId, entries] of byTab) send({ kind: 'event', event: 'console', tabId, entries })
}

/**
 * Buffer one message. The queue drains on a short timer or at
 * CONSOLE_QUEUE_MAX, so it stays bounded even while the socket is down; a
 * closed socket drops the batch rather than growing without limit.
 */
function queueConsole(tabId, entry) {
  consoleQueue.push({ tabId, ...entry })
  if (consoleQueue.length >= CONSOLE_QUEUE_MAX) {
    flushConsole()
    return
  }
  if (consoleTimer === null) consoleTimer = setTimeout(flushConsole, CONSOLE_FLUSH_MS)
}

/** Attach the debugger to one tab, or report why it cannot be captured. */
async function startConsole(tabId) {
  const id = Number(tabId)
  if (!Number.isInteger(id)) throw new Error(`无效的标签页 id:${String(tabId)}`)
  const targets = await chrome.debugger.getTargets()
  const existing = targets.find(target => target.tabId === id && target.attached === true)
  if (existing !== undefined && existing.extensionId !== chrome.runtime.id) {
    throw new Error('该标签页已被另一个调试器占用(例如已打开 DevTools);请关闭后重试')
  }
  if (existing === undefined) await chrome.debugger.attach({ tabId: id }, '1.3')
  // Log.enable also replays entries the browser buffered before enabling it.
  await chrome.debugger.sendCommand({ tabId: id }, 'Runtime.enable')
  await chrome.debugger.sendCommand({ tabId: id }, 'Log.enable')
  const tabs = await consoleTabs()
  if (!tabs.includes(id)) await setConsoleTabs([...tabs, id])
  trace('console-start ' + id)
  return { tabId: String(id) }
}

async function stopConsole(tabId) {
  const id = Number(tabId)
  const tabs = await consoleTabs()
  await setConsoleTabs(tabs.filter(candidate => candidate !== id))
  try {
    await chrome.debugger.detach({ tabId: id })
  } catch {
    // Already detached, or the tab is gone: that is the state we wanted.
  }
  trace('console-stop ' + id)
  return { tabId: String(id) }
}

/** Re-attach every captured tab, dropping the ones that can no longer be captured. */
async function rearmConsole() {
  for (const id of await consoleTabs()) {
    try {
      await startConsole(id)
    } catch (error) {
      trace('console-rearm-failed ' + id + ' ' + String((error && error.message) || error).slice(0, 60))
      await stopConsole(id)
    }
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== 'number') return
  const entry = consoleMessageFrom(method, params || {})
  if (entry === undefined) return
  queueConsole(String(source.tabId), entry)
})

// A user opening DevTools force-detaches us; stop claiming to capture that tab
// rather than re-attaching behind them.
chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId !== 'number') return
  void consoleTabs().then(async (tabs) => {
    if (!tabs.includes(source.tabId)) return
    await setConsoleTabs(tabs.filter(id => id !== source.tabId))
    trace('console-detached ' + source.tabId)
  })
})

async function run(command) {
  switch (command.op) {
    case 'list-tabs': {
      const tabs = await chrome.tabs.query({})
      return { tabs: tabs.map(tab => ({
        id: tab.id,
        title: tab.title || '',
        url: tab.url || '',
        active: tab.active === true,
        favicon: tab.favIconUrl || '',
      })) }
    }
    case 'read':
      return pageExec(command.args.tabId, readPage, [command.args.includeHtml === true])
    case 'inventory':
      return pageExec(command.args.tabId, pageAgent, [{ op: 'inventory' }])
    case 'wait':
      return pageExec(command.args.tabId, waitCondition, [command.args.selector, command.args.state])
    case 'hover':
      return pageExec(command.args.tabId, hoverSelector, [command.args.selector])
    case 'press':
      // `undefined` is not a serializable injection argument, so an omitted
      // selector travels as null and pressKey treats null as "current focus".
      return pageExec(command.args.tabId, pageAgent, [{
        op: 'press',
        key: command.args.key,
        selector: command.args.selector === undefined ? null : command.args.selector,
      }])
    case 'select':
      return pageExec(command.args.tabId, selectOption, [command.args.selector, command.args.value])
    case 'eval':
      return evalInPage(command.args.tabId, command.args.expression)
    case 'webmcp-list':
      // WebMCP lives on `document.modelContext` in the page's MAIN world: it is
      // page JavaScript, so the extension's isolated world cannot see it.
      return webmcpRequest(command.args.tabId, { mode: 'list' })
    case 'webmcp-call':
      return webmcpRequest(command.args.tabId, {
        mode: 'call',
        name: command.args.name,
        input: command.args.input || {},
      })
    case 'click':
      return pageExec(command.args.tabId, pageAgent, [
        { op: 'click', selector: command.args.selector, all: command.args.all === true },
      ])
    case 'type':
      return pageExec(command.args.tabId, typeInto, [command.args.selector, command.args.text || '', command.args.clear !== false])
    case 'console-start':
      return startConsole(command.args.tabId)
    case 'console-stop':
      return stopConsole(command.args.tabId)
    case 'reload': {
      // Answer first: `chrome.runtime.reload()` tears this worker down, so a
      // result sent after it would never leave. The delay lets the frame flush.
      setTimeout(() => chrome.runtime.reload(), 50)
      return { reloaded: true }
    }
    case 'close': {
      const id = Number(command.args.tabId)
      if (!Number.isInteger(id)) throw new Error(`无效的标签页 id:${String(command.args.tabId)}`)
      await chrome.tabs.remove(id)
      return { tabId: String(id) }
    }
    case 'navigate': {
      const tab = await chrome.tabs.update(Number(command.args.tabId), { url: command.args.url })
      return { id: tab.id, title: tab.title || '', url: tab.url || '', active: tab.active === true }
    }
    case 'open': {
      const tab = await chrome.tabs.create({ url: command.args.url || 'about:blank', active: true })
      return { id: tab.id, title: tab.title || '', url: tab.url || '', active: true }
    }
    case 'screenshot': {
      // Through the debugger, not `chrome.tabs.captureVisibleTab`: that one
      // needs the window visible and painting, so it fails with "image readback
      // failed" while the user is looking at something else — and when the
      // window merely stops repainting it returns the PREVIOUS frame with no
      // sign that it did. Page.captureScreenshot has neither problem.
      const base64 = await captureViaDebugger(Number(command.args.tabId), {
        fullPage: command.args.fullPage === true,
        selector: typeof command.args.selector === 'string' ? command.args.selector : undefined,
      })
      // Image bytes travel back as a plain HTTP POST, never as a WS JSON frame:
      // an oversized frame closed the bridge right after a successful capture.
      const blob = await (await fetch('data:image/jpeg;base64,' + base64)).blob()
      const upload = await fetch(`${hostOrigin}/chrome-browser/ext/upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: blob,
      })
      const body = await upload.json()
      if (body.ok !== true) throw new Error(body.error || '截图上传失败')
      return { path: body.path, mime: 'image/jpeg' }
    }
    case 'trace': {
      const data = await chrome.storage.local.get({ trace: [] })
      if (command.args.clear === true) await chrome.storage.local.set({ trace: [] })
      return data.trace
    }
    default:
      throw new Error(`unknown op ${command.op}`)
  }
}

/**
 * Longest edge a capture may produce, in device pixels.
 *
 * A tab can be far taller than this (a package page runs past 12000 CSS px),
 * and a texture beyond the GPU's limit makes the capture fail outright rather
 * than downscale it. Width is left to follow the scale, so the aspect ratio is
 * the page's.
 */
const MAX_CAPTURE_PX = 16_000

/**
 * Clip rectangle covering the whole page, scaled down when it would not fit.
 * @param tabId - the tab to measure.
 * @returns the clip rectangle, with the scale that keeps it capturable.
 */
async function pageClip(tabId) {
  const size = await pageExec(tabId, pageAgent, [{ op: 'size' }])
  if (size === null || typeof size !== 'object' || !(size.width > 0) || !(size.height > 0)) {
    throw new Error('截图失败:读不到页面尺寸')
  }
  const device = size.height * (size.dpr || 1)
  return {
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
    scale: device > MAX_CAPTURE_PX ? MAX_CAPTURE_PX / device : 1,
  }
}

/**
 * One element's clip rectangle, or a failure naming the selector.
 * @param tabId - the tab to measure in.
 * @param selector - CSS selector of the element to capture.
 * @returns the clip rectangle in page coordinates.
 */
async function rectOf(tabId, selector) {
  const box = await pageExec(tabId, pageAgent, [{ op: 'rect', selector }])
  if (box === null || typeof box !== 'object' || box.matched !== 1) {
    throw new Error(`截图失败:没有匹配 ${selector} 的元素`)
  }
  const { x, y, width, height } = box
  if (!(width > 0) || !(height > 0)) throw new Error(`截图失败:${selector} 没有可见尺寸(宽 ${width} 高 ${height})`)
  return { x, y, width, height, scale: 1 }
}

/** JPEG quality the screenshot is encoded at before upload. */
const SCREENSHOT_QUALITY = 75

/**
 * Capture one tab as base64 JPEG through the debugger protocol.
 *
 * `Page.captureScreenshot` renders the tab rather than reading back the window's
 * painted surface, so it works while the tab is in the background and cannot
 * answer with a stale frame. It costs the debugger infobar on that tab, which is
 * why a tab `chrome_console` already attached needs no second attach.
 */
async function captureViaDebugger(tabId, options) {
  const id = Number(tabId)
  if (!Number.isInteger(id)) throw new Error(`无效的标签页 id:${String(tabId)}`)
  const selector = options !== undefined && typeof options.selector === 'string' && options.selector !== ''
    ? options.selector
    : undefined
  // `captureBeyondViewport` is what turns a viewport grab into a whole-page
  // one; a clip needs it too, for any element below the fold.
  const beyond = options !== undefined && (options.fullPage === true || selector !== undefined)
  const targets = await chrome.debugger.getTargets()
  const existing = targets.find(target => target.tabId === id && target.attached === true)
  if (existing !== undefined && existing.extensionId !== chrome.runtime.id) {
    throw new Error('该标签页已被另一个调试器占用(例如已打开 DevTools),无法截图;请关闭 DevTools 后重试')
  }
  const ours = existing !== undefined
  if (!ours) await chrome.debugger.attach({ tabId: id }, '1.3')
  try {
    const clip = selector !== undefined
      ? await rectOf(id, selector)
      : options !== undefined && options.fullPage === true ? await pageClip(id) : undefined
    const response = await chrome.debugger.sendCommand({ tabId: id }, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: SCREENSHOT_QUALITY,
      captureBeyondViewport: beyond,
      ...(clip === undefined ? {} : { clip }),
    })
    if (response === undefined || typeof response.data !== 'string' || response.data === '') {
      throw new Error('截图失败:调试通道没有返回图像数据')
    }
    return response.data
  } finally {
    if (!ours) {
      try {
        await chrome.debugger.detach({ tabId: id })
      } catch (error) {
        // Already detached or the tab is gone: that is the state we wanted.
        if (!/not attached|No tab/i.test(String(error && error.message))) throw error
      }
    }
  }
}

/**
 * Every page-side helper, nested inside the one function Chrome injects.
 *
 * `chrome.scripting.executeScript` serializes a function's SOURCE and runs it in
 * the page: the closure does not come along. A helper that calls another
 * top-level helper, or reads a top-level const, therefore fails in the page with
 * a ReferenceError while working perfectly in a test that concatenates the
 * declarations into one scope. Nesting them here gives them one real scope.
 * tests/extension-scope.spec.ts fails if a declaration referenced from here is
 * left outside.
 */
function pageAgent(request) {
  const KEY_CODES = {
    Enter: 13,
    Escape: 27,
    Tab: 9,
    Backspace: 8,
    Delete: 46,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    ' ': 32,
  }

  // Must stay identical to INTERACTIVE_SELECTOR in the host's src/expressions.ts;
  // a truncated value silently narrows what the inventory can see.
  const INVENTORY_SELECTOR = 'a[href],button,input,select,textarea,[role=button],[role=link],'
    + '[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[contenteditable=""],[contenteditable=true]'

  const INVENTORY_LIMIT = 150

  const MAX_NAME_CHARS = 80

  function describeTarget(el) {
    if (el.disabled === true) return 'disabled'
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return 'invisible'
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') return 'invisible'
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return 'offscreen'
    const root = el.getRootNode()
    const from = root && typeof root.elementFromPoint === 'function' ? root : document
    const hit = from.elementFromPoint(x, y)
    if (hit === null) return 'offscreen'
    return hit === el || el.contains(hit) ? 'ok' : 'covered'
  }

  function cssEscape(value) {
    return (typeof CSS !== 'undefined' && CSS.escape)
      ? CSS.escape(value)
      : String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch)
  }

  function stableSelector(el) {
    if (el.id) {
      const byId = '#' + cssEscape(el.id)
      try {
        if (document.querySelectorAll(byId).length === 1) return byId
      } catch (error) {
        // An id that is not a usable selector: fall through to the path.
      }
    }
    const parts = []
    let node = el
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth++) {
      const tag = node.tagName.toLowerCase()
      const parent = node.parentElement
      if (parent === null) {
        parts.unshift(tag)
        break
      }
      const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName)
      parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag)
      node = parent
    }
    return parts.join(' > ')
  }

  function nameOf(el) {
    const raw = el.getAttribute('aria-label')
      || (el.innerText && el.innerText.trim())
      || el.value
      || el.getAttribute('placeholder')
      || el.getAttribute('title')
      || el.getAttribute('name')
      || ''
    return String(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_CHARS)
  }

  function clickSelector(selector, all) {
    const matched = document.querySelectorAll(selector)
    const targets = all ? Array.from(matched) : matched.length > 0 ? [matched[0]] : []
    const outcome = {
      matched: matched.length, clicked: 0, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0,
    }
    for (const el of targets) {
      const state = describeTarget(el)
      if (state === 'disabled') { outcome.disabled++; continue }
      if (state !== 'ok') outcome[state]++
      if (el.getAttribute('aria-disabled') === 'true') outcome.ariaDisabled++
      el.click()
      outcome.clicked++
    }
    return outcome
  }

  function interactiveInventory() {
    const matched = document.querySelectorAll(INVENTORY_SELECTOR)
    const items = []
    for (const el of matched) {
      if (items.length >= INVENTORY_LIMIT) break
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      const state = describeTarget(el)
      items.push({
        selector: stableSelector(el),
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        name: nameOf(el),
        inView: state !== 'offscreen',
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
        covered: state === 'covered',
      })
    }
    return { title: document.title, url: location.href, matched: matched.length, items }
  }

  function pressKey(key, selector) {
    const el = selector === undefined || selector === null || selector === ''
      ? document.activeElement
      : document.querySelector(selector)
    if (el === null) return { found: false, pressed: false, submitted: false }
    const node = el === null ? document.body : el
    if (typeof node.focus === 'function') node.focus()
    const init = { key, bubbles: true, cancelable: true, keyCode: KEY_CODES[key] || 0 }
    node.dispatchEvent(new KeyboardEvent('keydown', init))
    node.dispatchEvent(new KeyboardEvent('keypress', init))
    node.dispatchEvent(new KeyboardEvent('keyup', init))
    let submitted = false
    if (key === 'Enter') {
      const form = node.form || (typeof node.closest === 'function' ? node.closest('form') : null)
      if (form && typeof form.requestSubmit === 'function') {
        form.requestSubmit()
        submitted = true
      }
    }
    return { found: true, pressed: true, submitted }
  }

  /**
   * One element's box in PAGE coordinates, for a clipped screenshot.
   *
   * `getBoundingClientRect` is viewport-relative; `Page.captureScreenshot`'s
   * clip is page-relative, so the scroll offset is added back. Page coordinates
   * are also why the caller asks for `captureBeyondViewport`: the element may
   * sit below the fold.
   */
  function elementRect(selector) {
    const el = document.querySelector(selector)
    if (el === null) return { matched: 0 }
    const rect = el.getBoundingClientRect()
    return {
      matched: 1,
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
    }
  }

  /**
   * The whole page's box and pixel ratio, for a full-page screenshot.
   *
   * `captureBeyondViewport` on its own does NOT widen the capture; it only
   * permits a clip that reaches past the fold. The ratio is here because the
   * caller's size cap is in device pixels.
   */
  function pageSize() {
    const el = document.documentElement
    const body = document.body
    return {
      width: Math.max(el.scrollWidth, el.clientWidth, body === null ? 0 : body.scrollWidth),
      height: Math.max(el.scrollHeight, el.clientHeight, body === null ? 0 : body.scrollHeight),
      dpr: window.devicePixelRatio || 1,
    }
  }

  // A throw must not escape: `chrome.scripting.executeScript` answers it with
  // `result: undefined` and no `error`, so a malformed selector would reach the
  // model as "no element matched" — the page never saw the query at all.
  try {
    switch (request.op) {
      case 'click': return clickSelector(request.selector, request.all === true)
      case 'inventory': return interactiveInventory()
      case 'rect': return elementRect(request.selector)
      case 'size': return pageSize()
      case 'press': return pressKey(request.key, request.selector)
      default: return { __dshPageError: '未知的页面操作:' + request.op }
    }
  } catch (error) {
    return { __dshPageError: String((error && error.message) || error) }
  }
}

/**
 * Run one injected helper and report a throw as a failure.
 *
 * `chrome.scripting.executeScript` answers an exception inside the injected
 * function with `result: undefined`, so a broken helper would reach the host as
 * `null` — where it reads as "nothing matched". That is how a malformed CSS
 * selector turned into "no element matched selector", and how an undefined
 * helper turned into an empty inventory.
 */
async function pageExec(tabId, func, args, world) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: Number(tabId) },
    world: world || 'MAIN',
    func,
    args,
  })
  if (injection === undefined) throw new Error('无法注入该标签页(可能已关闭或不允许脚本注入)')
  if (injection.error !== undefined && injection.error !== null) {
    const thrown = injection.error
    const message = thrown.description || thrown.value || '注入的脚本抛出了异常'
    throw new Error(String(message))
  }
  const result = injection.result === undefined ? null : injection.result
  // The MAIN world reports a throw as `result: undefined` alone, so a helper
  // that fails says so in its own envelope instead.
  if (typeof result === 'object' && result !== null && typeof result.__dshPageError === 'string') {
    throw new Error(result.__dshPageError)
  }
  return result
}

/** MAIN-world helpers (functions are serialized; no outer scope). */

function readPage(includeHtml) {
  return {
    title: document.title,
    url: location.href,
    text: document.body ? document.body.innerText : '',
    html: includeHtml && document.documentElement ? document.documentElement.outerHTML : '',
  }
}

/**
 * Begin one WebMCP request in the page's MAIN world.
 *
 * `document.modelContext` is page JavaScript: the extension's isolated world has
 * a separate `document` and cannot see it. The async APIs cannot be awaited by
 * `chrome.scripting.executeScript` here (the returned promise is serialized, not
 * awaited), so the request stores its state on the page and the service worker
 * polls it with {@link webmcpPoll}.
 *
 * A missing modelContext is an ANSWER, not an error: the browser flag or origin
 * trial is off, or the page implements no WebMCP, and the model needs to know
 * which before falling back to DOM automation.
 */
function webmcpBegin(request) {
  const state = { done: false }
  window.__dshWebmcp = state
  const reason = 'document.modelContext 不存在:Chrome 未启用 WebMCP(需 --enable-features=WebMCP 或站点在 origin trial 中),或该页面未实现 WebMCP。'
  const fail = (error) => {
    const message = String((error && error.message) || error)
    if (request.mode === 'call') Object.assign(state, { done: true, __dshWebmcp: 1, ok: false, error: message })
    else Object.assign(state, { done: true, __dshWebmcp: 1, available: false, reason: message })
  }
  try {
    const mc = typeof document === 'object' && document !== null ? document.modelContext : undefined
    if (request.mode === 'call') {
      if (mc === undefined || mc === null || typeof mc.executeTool !== 'function' || typeof mc.getTools !== 'function') {
        Object.assign(state, { done: true, __dshWebmcp: 1, ok: false, error: reason })
        return true
      }
      Promise.resolve(mc.getTools())
        .then((tools) => {
          const tool = tools.find(candidate => candidate.name === request.name)
          if (tool === undefined) {
            const available = tools.map(candidate => candidate.name)
            throw new Error(available.length === 0
              ? '当前页面没有注册任何 WebMCP 工具'
              : '当前页面没有名为 "' + request.name + '" 的 WebMCP 工具;可用: ' + available.join(', '))
          }
          return mc.executeTool(tool, request.input || {})
        })
        .then((result) => {
          if (result === null || result === undefined) {
            Object.assign(state, { done: true, __dshWebmcp: 1, ok: true, tool: request.name, navigated: true })
            return
          }
          Object.assign(state, { done: true, __dshWebmcp: 1, ok: true, tool: request.name, result })
        })
        .catch(fail)
      return true
    }
    if (mc === undefined || mc === null || typeof mc.getTools !== 'function') {
      Object.assign(state, { done: true, __dshWebmcp: 1, available: false, reason })
      return true
    }
    Promise.resolve(mc.getTools())
      .then((tools) => {
        Object.assign(state, {
          done: true,
          __dshWebmcp: 1,
          available: true,
          tools: tools.map(tool => ({
            name: tool.name,
            title: tool.title || '',
            description: tool.description || '',
            origin: tool.origin || location.origin,
            inputSchema: tool.inputSchema === undefined ? null : tool.inputSchema,
            annotations: tool.annotations || {},
          })),
        })
      })
      .catch(fail)
    return true
  } catch (error) {
    fail(error)
    return true
  }
}

/** Read the WebMCP request state the page stored; null before/after a navigation. */
function webmcpPoll() {
  return window.__dshWebmcp || null
}

/**
 * Drive one WebMCP request: start it in the page, then poll the state it stored.
 *
 * A declarative form tool without `toolautosubmit` never settles until the user
 * clicks Submit, so an unfinished request is reported as `pending` rather than
 * as success or as a timeout.
 */
async function webmcpRequest(tabId, request) {
  const before = await chrome.tabs.get(Number(tabId)).catch(() => null)
  await pageExec(tabId, webmcpBegin, [request])
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const state = await pageExec(tabId, webmcpPoll)
    if (state !== null && state !== undefined && state.done === true) {
      const value = Object.assign({}, state)
      delete value.done
      return value
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const after = await chrome.tabs.get(Number(tabId)).catch(() => null)
  const navigated = before !== null && after !== null && before.url !== after.url
  if (request.mode === 'list') {
    return {
      __dshWebmcp: 1,
      available: false,
      reason: navigated ? '读取 WebMCP 工具期间页面发生了导航' : '读取 WebMCP 工具超时(8s)',
    }
  }
  // A tool that navigated the tab may have destroyed the state before a poll
  // could read it; the URL change is the only remaining evidence.
  if (navigated) {
    return { __dshWebmcp: 1, ok: true, tool: request.name || '', navigated: true }
  }
  return {
    __dshWebmcp: 1,
    ok: true,
    tool: request.name,
    pending: true,
    note: '工具已激活,但 8 秒内没有返回结果:声明式表单通常需要用户在页面上点提交。不要重复调用,先请用户确认。',
  }
}

/**
 * Evaluate one expression and report the outcome as data.
 *
 * The throw must not escape this function: `chrome.scripting.executeScript`
 * turns an escaping exception into `result: undefined`, which reaches the model
 * as a silent `null` — a syntax error, a runtime throw and a blocked `eval`
 * would all read as "the value is null". The `__dshEval` tag is what tells the
 * host this envelope apart from an expression that legitimately returns an
 * object with `ok`/`value` keys.
 */
function evalExpression(expression) {
  try {
    const value = (0, eval)(expression)
    return { __dshEval: 1, ok: true, value: value === undefined ? null : value }
  } catch (error) {
    return { __dshEval: 1, ok: false, error: String((error && error.message) || error) }
  }
}

/** Whether a failed main-world evaluation failed because the page forbids `eval`. */
function isEvalBlocked(message) {
  return /unsafe-eval|Content Security Policy|EvalError|call to eval\(\)/i.test(message)
}

/**
 * Run one expression through the debugger protocol.
 *
 * `Runtime.evaluate` is not subject to the page's Content-Security-Policy, which
 * is the whole reason this path exists: on a page whose `script-src` omits
 * `unsafe-eval` — GitHub is one — neither the page's own world nor the
 * extension's isolated world may call `eval`. This is also the path the CDP
 * backend has always used, so an expression means the same thing on both.
 *
 * A per-call attach shows the debugger infobar on that tab and is refused while
 * DevTools is open, so it is a fallback rather than the default.
 */
async function evalViaDebugger(tabId, expression) {
  const id = Number(tabId)
  if (!Number.isInteger(id)) throw new Error(`无效的标签页 id:${String(tabId)}`)
  const targets = await chrome.debugger.getTargets()
  const existing = targets.find(target => target.tabId === id && target.attached === true)
  if (existing !== undefined && existing.extensionId !== chrome.runtime.id) {
    throw new Error('该标签页已被另一个调试器占用(例如已打开 DevTools),无法执行表达式;请关闭 DevTools 后重试')
  }
  // Console capture may already hold this tab: reuse its session and leave it attached.
  const ours = existing !== undefined
  if (!ours) await chrome.debugger.attach({ tabId: id }, '1.3')
  try {
    const response = await chrome.debugger.sendCommand({ tabId: id }, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (response !== undefined && response.exceptionDetails !== undefined) {
      const details = response.exceptionDetails
      const thrown = details.exception
      const message = (thrown !== undefined && (thrown.description || thrown.value)) || details.text || '表达式执行出错'
      throw new Error(String(message))
    }
    const result = response === undefined ? undefined : response.result
    if (result === undefined) return null
    // A result the protocol could not serialize by value arrives as a description.
    return Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : null
  } finally {
    if (!ours) {
      try {
        await chrome.debugger.detach({ tabId: id })
      } catch (error) {
        // Already detached or the tab is gone: that is the state we wanted.
        if (!/not attached|No tab/i.test(String(error && error.message))) throw error
      }
    }
  }
}

/**
 * Run one expression and report the outcome as data.
 *
 * Prefers the page's own world, because that is where the page's JavaScript
 * globals live. When the page's Content-Security-Policy forbids `eval` there,
 * the debugger protocol runs the same expression under no such policy and the
 * answer says which route it took.
 */
async function evalInPage(tabId, expression) {
  const main = await pageExec(tabId, evalExpression, [expression], 'MAIN')
  if (main !== null && main.ok === true) {
    return { __dshEval: 1, ok: true, value: main.value, world: 'main' }
  }
  const mainError = main !== null && typeof main.error === 'string' ? main.error : 'evaluation failed'
  if (!isEvalBlocked(mainError)) return { __dshEval: 1, ok: false, error: mainError }

  try {
    const value = await evalViaDebugger(tabId, expression)
    return { __dshEval: 1, ok: true, value, world: 'debugger' }
  } catch (error) {
    const debuggerError = String((error && error.message) || error)
    return {
      __dshEval: 1,
      ok: false,
      error: '页面的 CSP 禁止主世界 eval,调试通道也无法执行。主世界: '
        + mainError + ';调试通道: ' + debuggerError,
    }
  }
}

/**
 * Why one element may not receive a working click, as a single verdict. Mirrors
 * the `probe` inside CLICK_PROBE in the host's src/expressions.ts; tests/click-outcome.spec.ts
 * runs both against the same stub DOM and requires identical output.
 */




/**
 * Wait condition. Mirrors `waitExpression` in the host's src/expressions.ts,
 * which the CDP backend evaluates for the same polls; tests/primitives.spec.ts
 * requires the two to agree on every state.
 */
function waitCondition(selector, state) {
  const el = document.querySelector(selector)
  const attached = el !== null
  let shown = false
  if (attached) {
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      const style = getComputedStyle(el)
      shown = style.visibility !== 'hidden' && style.display !== 'none'
    }
  }
  if (state === 'attached') return attached
  if (state === 'detached') return !attached
  if (state === 'visible') return attached && shown
  if (state === 'hidden') return !attached || !shown
  return false
}

/**
 * Key press. Mirrors `pressExpression` in the host's src/expressions.ts, which
 * the CDP backend evaluates for the same call; tests/primitives.spec.ts requires
 * the two to agree. Synthetic key events trigger no default action, so Enter
 * submits the owning form explicitly.
 */



/**
 * Select an option. Mirrors `selectExpression` in the host's src/expressions.ts.
 * A value with no matching option leaves the select unchanged and the result
 * says so, rather than reporting a success the page never saw.
 */
function selectOption(selector, value) {
  const el = document.querySelector(selector)
  if (el === null) return { matched: 0, changed: false, value: '', options: [] }
  if (!(el instanceof HTMLSelectElement)) {
    return { matched: 1, changed: false, value: '', options: [], reason: 'not a <select>' }
  }
  const all = Array.from(el.options).map((option) => option.value)
  const options = all.slice(0, 30)
  // Checked BEFORE assigning: assigning a value no option carries sets
  // selectedIndex to -1 and clears the control, so a call that is about to be
  // rejected would still wipe the selection the user had.
  if (all.indexOf(value) === -1) return { matched: 1, changed: false, value: el.value, options }
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(el, value)
  const changed = el.value === value
  if (changed) {
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  return { matched: 1, changed, value: el.value, options }
}

/**
 * Hover. Mirrors `hoverExpression` in the host's src/expressions.ts. The events
 * are synthetic: they reach the page's listeners but do not set the browser's
 * own hover state, so a control revealed purely by a CSS `:hover` rule stays
 * hidden. Real pointer input is not available on the bridge, so both backends
 * behave the same.
 */
function hoverSelector(selector) {
  const el = document.querySelector(selector)
  if (el === null) return { matched: 0, hovered: false }
  const rect = el.getBoundingClientRect()
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  }
  const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent
  for (const type of ['pointerover', 'mouseover', 'pointermove', 'mousemove']) {
    el.dispatchEvent(new Pointer(type, init))
  }
  // Enter does not bubble; it is delivered on the target only.
  for (const type of ['pointerenter', 'mouseenter']) {
    el.dispatchEvent(new Pointer(type, { ...init, bubbles: false }))
  }
  return { matched: 1, hovered: true }
}

/**
 * Interactive-element inventory. Mirrors `inventoryExpression` in the host's
 * src/expressions.ts, which the CDP backend evaluates against the same page;
 * tests/inventory.spec.ts requires the two to agree. Shares `describeTarget`
 * with the click probe, so `covered` means the same thing in both results.
 */
  + '[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[contenteditable=""],[contenteditable=true]'











/**
 * Set one control's value. `clear` false inserts at the caret the way the CDP
 * backend's `Input.insertText` does, rather than replacing the whole value —
 * the two backends must mean the same thing by the same argument.
 */
function typeInto(selector, text, clear) {
  const el = document.querySelector(selector)
  if (!el) return false
  el.focus()
  if (clear) {
    if (typeof el.select === 'function') el.select()
    else {
      const range = document.createRange()
      range.selectNodeContents(el)
      const selection = window.getSelection()
      if (selection) { selection.removeAllRanges(); selection.addRange(range) }
    }
  }
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value',
    ).set
    let next = text
    let caret = text.length
    if (clear === false) {
      const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length
      const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start
      next = el.value.slice(0, start) + text + el.value.slice(end)
      caret = start + text.length
    }
    setter.call(el, next)
    try {
      el.setSelectionRange(caret, caret)
    } catch (error) {
      // Number and email inputs refuse setSelectionRange; the value still stands.
      if (!/setSelectionRange|selection/i.test(String(error && error.message))) throw error
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } else {
    el.textContent = ''
    el.appendChild(document.createTextNode(text))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  return true
}

connect()
