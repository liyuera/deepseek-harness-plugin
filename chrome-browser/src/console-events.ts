/**
 * Turning captured DevTools events into console messages.
 *
 * The extension bridge runs the same mapping in `extension/service-worker.js`
 * (`consoleMessageFrom`), because the bridge cannot import host modules: the
 * two copies must stay in step, and tests/console-capture.spec.ts requires them
 * to agree on the same recorded events.
 *
 * The browser reports two families worth keeping: `Runtime.consoleAPICalled`
 * for `console.*` calls the page made, and `Log.entryAdded` for messages the
 * browser itself raises (failed requests, CSP refusals, deprecations) — the
 * second family is invisible to any wrapper around `console`, which is why
 * capture goes through the debugger.
 * @module @liyuera/dsh-chrome-browser/console-events
 */

/** One console message as a capture source reported it. */
export interface CapturedMessage {
  /** Level the source reported (`log`, `info`, `warning`, `error`, `debug`, …). */
  readonly level: string
  /** Rendered message text. */
  readonly text: string
  /** `url:line` of the call site, when the source reported one. */
  readonly source?: string
}

/** Cap one rendered argument list; the buffer caps again per message. */
const MAX_ARG_CHARS = 2048

/** One value in a `console.*` argument list, rendered as the console shows it. */
function renderRemote(value: unknown): string {
  if (typeof value !== 'object' || value === null) return String(value)
  const remote = value as Record<string, unknown>
  const type = typeof remote.type === 'string' ? remote.type : 'object'
  if (type === 'undefined') return 'undefined'
  // A primitive carries its value directly; a string renders unquoted, the way
  // the console shows it.
  if (remote.value !== undefined && remote.value !== null) return String(remote.value)
  if (remote.value === null) return 'null'
  const preview = typeof remote.preview === 'object' && remote.preview !== null
    ? remote.preview as Record<string, unknown>
    : undefined
  if (preview !== undefined) {
    const properties = Array.isArray(preview.properties) ? preview.properties : []
    const rendered = properties.map((property) => {
      if (typeof property !== 'object' || property === null) return '?'
      const entry = property as Record<string, unknown>
      const name = typeof entry.name === 'string' ? entry.name : '?'
      const shown = entry.value !== undefined ? String(entry.value) : String(entry.type ?? '?')
      return `${name}: ${shown}`
    })
    const head = typeof preview.description === 'string' && preview.description !== '' ? preview.description : ''
    const more = preview.overflow === true ? ', …' : ''
    return `${head}{${rendered.join(', ')}${more}}`
  }
  if (typeof remote.description === 'string' && remote.description !== '') return remote.description
  return type
}

/** `url:line` from a CDP stack trace, when it carries a usable frame. */
function sourceFromStack(stackTrace: unknown): string | undefined {
  if (typeof stackTrace !== 'object' || stackTrace === null) return undefined
  const frames = (stackTrace as Record<string, unknown>).callFrames
  if (!Array.isArray(frames)) return undefined
  const first = frames[0]
  if (typeof first !== 'object' || first === null) return undefined
  const frame = first as Record<string, unknown>
  const url = typeof frame.url === 'string' ? frame.url : ''
  const line = typeof frame.lineNumber === 'number' ? frame.lineNumber + 1 : undefined
  if (url === '') return undefined
  return line === undefined ? url : `${url}:${line}`
}

/** `url:line` from a `Log` entry, when it carries one. */
function sourceFromEntry(entry: Record<string, unknown>): string | undefined {
  const url = typeof entry.url === 'string' ? entry.url : ''
  if (url === '') return undefined
  const line = typeof entry.lineNumber === 'number' ? entry.lineNumber : undefined
  return line === undefined ? url : `${url}:${line}`
}

/**
 * Map one captured DevTools event onto a console message.
 * @param method - the CDP event name.
 * @param params - the event payload.
 * @returns the message, or undefined for an event this plugin does not keep.
 */
export function consoleMessageFrom(method: string, params: Record<string, unknown>): CapturedMessage | undefined {
  if (method === 'Runtime.consoleAPICalled') {
    const args = Array.isArray(params.args) ? params.args : []
    const text = args.map(renderRemote).join(' ').slice(0, MAX_ARG_CHARS)
    const level = typeof params.type === 'string' ? params.type : 'log'
    const source = sourceFromStack(params.stackTrace)
    return source === undefined ? { level, text } : { level, text, source }
  }
  if (method === 'Log.entryAdded') {
    const raw = params.entry
    if (typeof raw !== 'object' || raw === null) return undefined
    const entry = raw as Record<string, unknown>
    const text = typeof entry.text === 'string' ? entry.text : ''
    if (text === '') return undefined
    const level = typeof entry.level === 'string' ? entry.level : 'info'
    const source = sourceFromEntry(entry)
    return source === undefined ? { level, text } : { level, text, source }
  }
  return undefined
}
