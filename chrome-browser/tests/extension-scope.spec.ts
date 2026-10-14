/**
 * What Chrome's injection model actually gives an injected helper.
 *
 * `chrome.scripting.executeScript({ func })` serializes the function's SOURCE
 * and runs it in the page: the closure does not come along. A helper that calls
 * another top-level helper, or reads a top-level const, works perfectly in a
 * test that concatenates the declarations into one `new Function` scope and
 * fails in the browser with a ReferenceError — which is exactly what happened to
 * `clickSelector` (describeTarget), `interactiveInventory` (five declarations)
 * and `pressKey` (KEY_CODES). Every other spec in this suite loads extension
 * declarations that way, so none of them could see it.
 *
 * Two checks that do model it:
 *
 * 1. statically, against every function the dispatch hands to `pageExec`: it
 *    must reference no declaration left at the file's top level;
 * 2. behaviorally, against the real dispatch: the arguments it builds must be
 *    serializable, because `undefined` in an injection argument is rejected by
 *    Chrome before the helper ever runs.
 */
import { describe, expect, it } from 'vitest'
import { EXTENSION_SOURCE } from './support/extension-source.ts'
import { extractDeclaration, loadExtensionFunction } from './support/extension-source.ts'

/** Names declared at the file's top level (functions and consts). */
function topLevelNames(source: string): Set<string> {
  const names = new Set<string>()
  for (const match of source.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)/gmu)) names.add(match[1] as string)
  for (const match of source.matchAll(/^const ([A-Za-z0-9_]+) =/gmu)) names.add(match[1] as string)
  return names
}

/** The source of one top-level declaration, by brace matching. */
function topLevelBody(source: string, name: string): string | undefined {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'mu'))
  if (start < 0) return undefined
  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return undefined
}

/** Every function name the command dispatch hands to `pageExec`. */
function injectedNames(source: string): string[] {
  const names = new Set<string>()
  // Anchored on the dispatch form, so the `pageExec` declaration itself — whose
  // second parameter is also a bare identifier — is not read as a call site.
  for (const match of source.matchAll(/pageExec\(command\.args\.tabId,\s*([A-Za-z0-9_]+)\s*,/gu)) {
    names.add(match[1] as string)
  }
  return [...names].sort()
}

describe('injected helpers', () => {
  it('hands at least one helper to pageExec (the check is looking at something)', () => {
    expect(injectedNames(EXTENSION_SOURCE).length).toBeGreaterThan(0)
  })

  it('reference nothing left at the top level', () => {
    const top = topLevelNames(EXTENSION_SOURCE)
    const offenders: string[] = []
    for (const name of injectedNames(EXTENSION_SOURCE)) {
      const body = topLevelBody(EXTENSION_SOURCE, name)
      expect(body, `${name} is injected but not declared at the top level`).toBeDefined()
      // Nested declarations are indented, so they are not in `top`: a name that
      // matches here really is one the page cannot see.
      const free = [...top].filter(candidate => (
        candidate !== name && new RegExp(`\\b${candidate}\\b`, 'u').test(body as string)
      ))
      if (free.length > 0) offenders.push(`${name} → ${free.join(', ')}`)
    }
    expect(offenders).toEqual([])
  })

  it('keeps every helper pageAgent needs inside pageAgent', () => {
    // The nesting is the fix; a helper moved back out would silently return.
    const body = topLevelBody(EXTENSION_SOURCE, 'pageAgent') as string
    for (const name of ['describeTarget', 'clickSelector', 'interactiveInventory', 'pressKey', 'stableSelector', 'nameOf', 'cssEscape']) {
      expect(new RegExp(`\\bfunction ${name}\\(`, 'u').test(body), `${name} must be nested`).toBe(true)
    }
  })
})

describe('injection arguments', () => {
  /**
   * The dispatch, loaded with the helpers it can reach for these ops.
   * `loadExtensionFunction` returns a factory taking the injected globals.
   */
  function dispatch(): (chrome: unknown) => (command: unknown) => Promise<unknown> {
    return loadExtensionFunction<(command: unknown) => Promise<unknown>>(
      ['pageAgent', 'pageExec', 'run'],
      'run',
      ['chrome'],
    )
  }

  /** Run one command and return what the fake chrome received. */
  async function argsFor(command: Record<string, unknown>): Promise<{ args: unknown[] }> {
    const seen: { args: unknown[] } = { args: [] }
    const chrome = {
      scripting: {
        executeScript: async (request: { args?: unknown[] }) => {
          seen.args = request.args ?? []
          return [{ result: { ok: true } }]
        },
      },
    }
    await dispatch()(chrome)(command)
    return seen
  }

  it('sends no undefined for a press without a selector', async () => {
    // `undefined` is not a serializable injection argument: Chrome rejected the
    // whole call before pressKey ran, so an omitted selector failed outright.
    const { args } = await argsFor({ op: 'press', args: { tabId: '7', key: 'Tab' } })
    expect(args).toHaveLength(1)
    const [payload] = args as [{ selector?: unknown }]
    expect(payload.selector).toBeNull()
    expect(JSON.parse(JSON.stringify(args))).toEqual([{ op: 'press', key: 'Tab', selector: null }])
  })

  it('sends no undefined for a click without the all flag', async () => {
    const { args } = await argsFor({ op: 'click', args: { tabId: '7', selector: '#x' } })
    expect(JSON.parse(JSON.stringify(args))).toEqual([{ op: 'click', selector: '#x', all: false }])
  })

  it('sends no undefined for an inventory', async () => {
    const { args } = await argsFor({ op: 'inventory', args: { tabId: '7' } })
    expect(JSON.parse(JSON.stringify(args))).toEqual([{ op: 'inventory' }])
  })

  it('never puts an unserializable value in an injection argument', async () => {
    const commands = [
      { op: 'click', args: { tabId: '7', selector: '#x' } },
      { op: 'click', args: { tabId: '7', selector: '#x', all: true } },
      { op: 'inventory', args: { tabId: '7' } },
      { op: 'press', args: { tabId: '7', key: 'Enter' } },
      { op: 'press', args: { tabId: '7', key: 'Enter', selector: '#q' } },
    ]
    for (const command of commands) {
      const { args } = await argsFor(command)
      for (const value of args) {
        expect(value, `${String(command.op)} sent an undefined argument`).not.toBeUndefined()
        expect(JSON.parse(JSON.stringify(value))).toEqual(value)
      }
    }
  })
})

describe('a broken helper', () => {
  /** `pageAgent` as the extension ships it, over a stub document. */
  function agent(): (request: { op: string; selector?: string; all?: boolean }) => unknown {
    return loadExtensionFunction<(request: { op: string; selector?: string }) => unknown>(
      ['pageAgent'],
      'pageAgent',
      ['document', 'window', 'getComputedStyle'],
    )({ querySelectorAll: () => { throw new SyntaxError("'#a[' is not a valid selector") } })
  }

  it('reports the failure in its own envelope instead of throwing out', () => {
    // An escaping throw is what `executeScript` turns into `result: undefined`,
    // which reaches the model as "no element matched".
    const outcome = agent()({ op: 'click', selector: '#a[' }) as { __dshPageError?: string }
    expect(outcome.__dshPageError).toContain('not a valid selector')
  })

  it('is turned into a thrown error by pageExec', async () => {
    const pageExec = loadExtensionFunction<(tabId: string, func: unknown, args: unknown[]) => Promise<unknown>>(
      ['pageExec'],
      'pageExec',
      ['chrome'],
    )({ scripting: { executeScript: async () => [{ result: { __dshPageError: 'boom-xyz' } }] } })
    await expect(pageExec('7', () => {}, [])).rejects.toThrow(/boom-xyz/)
  })

  it('reports an unknown op the same way', () => {
    const outcome = agent()({ op: 'nope' }) as { __dshPageError?: string }
    expect(outcome.__dshPageError).toContain('未知的页面操作')
  })
})

describe('the injected dispatcher', () => {
  /**
   * Every helper `pageAgent` calls must be declared inside it.
   *
   * `chrome.scripting.executeScript` serializes that one function's source, so
   * a call to a top-level helper compiles fine here and throws a
   * ReferenceError in the page — which the model then reads as "nothing
   * matched". Two helpers were added at the top level and nothing noticed,
   * because the call sites existed and the tests looked at those.
   */
  it('calls only helpers it declares itself', () => {
    const source = extractDeclaration(EXTENSION_SOURCE, 'pageAgent')
    const declared = new Set([...source.matchAll(/function ([A-Za-z_$][\w$]*)\s*\(/gu)].map(match => match[1]))
    const dispatched = [...source.matchAll(/case '[a-z-]+':\s*return ([A-Za-z_$][\w$]*)\s*\(/gu)].map(match => match[1])
    expect(dispatched.length, 'the dispatcher should have several ops').toBeGreaterThan(4)
    expect(dispatched.filter(name => !declared.has(name))).toEqual([])
  })
})

describe('the handshake', () => {
  /** The op roster the extension advertises. */
  function advertised(): string[] {
    return loadExtensionFunction<string[]>(['SUPPORTED_OPS'], 'SUPPORTED_OPS', [])() as unknown as string[]
  }

  /** Every op `run()` actually answers. */
  function implemented(): string[] {
    const body = EXTENSION_SOURCE.slice(EXTENSION_SOURCE.indexOf('async function run(command)'))
    const end = body.indexOf('\nasync function ', 1)
    const scoped = end === -1 ? body : body.slice(0, end)
    return [...scoped.matchAll(/case '([a-z-]+)':/gu)].map(match => match[1] as string)
  }

  it('advertises exactly the ops run() answers', () => {
    // The roster is what the host uses to tell "your extension is old" apart
    // from "your plugin is broken"; a roster that drifts makes it lie.
    expect([...advertised()].sort()).toEqual([...implemented()].sort())
  })

  it('advertises the reload op the host uses to update it', () => {
    expect(advertised()).toContain('reload')
  })

  it('answers reload before tearing the worker down', async () => {
    // `chrome.runtime.reload()` kills the worker, so a result sent after it
    // would never leave and the host would report a failed update.
    const reloaded: number[] = []
    const chrome = {
      runtime: { reload: () => { reloaded.push(Date.now()) } },
      tabs: { remove: async () => {} },
      scripting: { executeScript: async () => [{ result: null }] },
    }
    const run = loadExtensionFunction<(command: unknown) => Promise<unknown>>(
      ['SUPPORTED_OPS', 'pageAgent', 'pageExec', 'run'],
      'run',
      ['chrome', 'setTimeout'],
    )(chrome, setTimeout)
    await expect(run({ op: 'reload', args: {} })).resolves.toEqual({ reloaded: true })
    expect(reloaded).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(reloaded).toHaveLength(1)
  })
})

describe('the close op', () => {
  /** `run` over a stub `chrome`; returns what the browser was asked to close. */
  function closeDispatch(): {
    run: (command: unknown) => Promise<unknown>
    removed: unknown[]
  } {
    const removed: unknown[] = []
    const chrome = {
      tabs: {
        remove: async (tabId: unknown) => { removed.push(tabId) },
      },
      scripting: { executeScript: async () => [{ result: null }] },
    }
    return {
      removed,
      run: loadExtensionFunction<(command: unknown) => Promise<unknown>>(
        ['pageAgent', 'pageExec', 'run'],
        'run',
        ['chrome'],
      )(chrome),
    }
  }

  it('removes the numeric tab the host named', async () => {
    // The bridge protocol carries ids as strings; `chrome.tabs.remove` wants a
    // number, and a string would be rejected by Chrome at runtime.
    const { run, removed } = closeDispatch()
    await expect(run({ op: 'close', args: { tabId: '1178519964' } })).resolves
      .toEqual({ tabId: '1178519964' })
    expect(removed).toEqual([1178519964])
  })

  it('refuses an id that is not a number instead of closing something else', async () => {
    const { run, removed } = closeDispatch()
    await expect(run({ op: 'close', args: { tabId: 'not-a-tab' } }))
      .rejects.toThrow(/无效的标签页 id/)
    expect(removed).toEqual([])
  })
})
