/**
 * The extension's `eval` op, run from the shipped source.
 *
 * Two silent failures lived here and neither smoke test could see them: the
 * smoke suite drives the CDP backend, where `Runtime.evaluate` reports
 * exceptions and ignores the page's CSP. On the bridge, an escaping throw
 * becomes `result: undefined` — so a syntax error, a runtime throw and a
 * CSP-blocked `eval` all reached the model as a plain `null` with nothing to
 * correct from.
 *
 * The fallback route is the debugger protocol, not the extension's isolated
 * world: a real page proved the isolated world is under the extension's own
 * MV3 policy, which also omits `unsafe-eval`.
 */
import { describe, expect, it } from 'vitest'
import { loadExtensionFunction } from './support/extension-source.ts'

/** The envelope the extension tags its answers with. */
interface Envelope {
  __dshEval: number
  ok: boolean
  value?: unknown
  error?: string
}

/** `evalExpression` as the extension ships it. */
function evalExpression(): (expression: string) => Envelope {
  return loadExtensionFunction<(expression: string) => Envelope>(
    ['evalExpression'],
    'evalExpression',
    [],
  )()
}

/** One `executeScript` call the fake recorded. */
interface Injection {
  world: string
  func: (...args: unknown[]) => unknown
  args: unknown[]
}

/** A `chrome` stand-in answering per world, recording what was asked. */
function chromeStub(answer: (world: string, injection: Injection) => unknown): {
  chrome: { scripting: { executeScript: (request: Injection) => Promise<Array<{ result: unknown }>> } }
  injections: Injection[]
} {
  const injections: Injection[] = []
  return {
    injections,
    chrome: {
      scripting: {
        executeScript: async (request: Injection) => {
          injections.push(request)
          const result = answer(request.world, request)
          if (result instanceof Error) throw result
          return [{ result }]
        },
      },
    },
  }
}

/** One answer from `evalInPage`. */
interface EvalAnswer {
  __dshEval: number
  ok: boolean
  value?: unknown
  world?: string
  error?: string
}

/** `evalInPage` as the extension ships it, over a stub `chrome`. */
function evalInPage(chrome: unknown): (tabId: string, expression: string) => Promise<EvalAnswer> {
  return loadExtensionFunction<(tabId: string, expression: string) => Promise<EvalAnswer>>(
    ['evalExpression', 'isEvalBlocked', 'pageExec', 'evalViaDebugger', 'evalInPage'],
    'evalInPage',
    ['chrome'],
  )(chrome)
}

/** A `chrome` whose debugger answers one value. */
function debuggerStub(outcome: { value?: unknown; exception?: string; attachFails?: boolean; foreign?: boolean }): {
  chrome: Record<string, unknown>
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    chrome: {
      runtime: { id: 'our-extension' },
      debugger: {
        getTargets: async () => (outcome.foreign === true
          ? [{ tabId: 7, attached: true, extensionId: 'someone-else' }]
          : []),
        attach: async () => {
          calls.push('attach')
          if (outcome.attachFails === true) throw new Error('Cannot attach to this target')
        },
        detach: async () => { calls.push('detach') },
        sendCommand: async () => {
          calls.push('evaluate')
          if (outcome.exception !== undefined) {
            return { exceptionDetails: { text: 'Uncaught', exception: { description: outcome.exception } } }
          }
          return { result: { type: 'number', value: outcome.value } }
        },
      },
    },
  }
}

describe('evalExpression', () => {
  it('returns the value of an expression', () => {
    expect(evalExpression()('1 + 1')).toEqual({ __dshEval: 1, ok: true, value: 2 })
  })

  it('reports a runtime throw as data instead of letting it escape', () => {
    // An escaping throw is what `executeScript` turns into `result: undefined`.
    const outcome = evalExpression()('throw new Error("boom-xyz")')
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('boom-xyz')
  })

  it('reports a syntax error as data', () => {
    const outcome = evalExpression()('this is not valid javascript (((')
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBeTruthy()
  })

  it('maps an undefined result to null rather than dropping the envelope', () => {
    expect(evalExpression()('void 0')).toEqual({ __dshEval: 1, ok: true, value: null })
  })
})

describe('evalInPage', () => {
  /** The value a page's own world answers with when it allows `eval`. */
  const MAIN_OK = { __dshEval: 1, ok: true, value: 'main-answer' }
  /** What a CSP-blocked page's world answers with. */
  const CSP_BLOCK = {
    __dshEval: 1,
    ok: false,
    error: 'EvalError: Refused to evaluate a string as JavaScript because \'unsafe-eval\' is not an allowed source',
  }

  it('answers from the page\'s own world when it can', async () => {
    const stub = chromeStub(() => MAIN_OK)
    const outcome = await evalInPage(stub.chrome)('7', 'document.title')
    // The tag is the contract with the host: without it the host passes the
    // whole envelope through as the expression's value.
    expect(outcome).toEqual({ __dshEval: 1, ok: true, value: 'main-answer', world: 'main' })
    expect(stub.injections.map(entry => entry.world)).toEqual(['MAIN'])
  })

  it('falls back to the debugger protocol when the page forbids eval', async () => {
    const stub = chromeStub(() => CSP_BLOCK)
    const debug = debuggerStub({ value: 'debugger-answer' })
    const outcome = await evalInPage({ ...stub.chrome, debugger: (debug.chrome as never as { debugger: unknown }).debugger, runtime: (debug.chrome as never as { runtime: unknown }).runtime })('7', 'document.title')
    expect(outcome).toEqual({ __dshEval: 1, ok: true, value: 'debugger-answer', world: 'debugger' })
    expect(stub.injections.map(entry => entry.world)).toEqual(['MAIN'])
    expect(debug.calls).toEqual(['attach', 'evaluate', 'detach'])
  })

  it('reuses a debugger session console capture already holds', async () => {
    const stub = chromeStub(() => CSP_BLOCK)
    const debug = debuggerStub({ value: 1 })
    const chrome = {
      ...(debug.chrome as object),
      debugger: {
        ...(debug.chrome as never as { debugger: object }).debugger,
        getTargets: async () => [{ tabId: 7, attached: true, extensionId: 'our-extension' }],
      },
    }
    await evalInPage({ ...stub.chrome, ...chrome })('7', 'document.title')
    expect(debug.calls).toEqual(['evaluate'])
  })

  it('refuses when another debugger owns the tab', async () => {
    const stub = chromeStub(() => CSP_BLOCK)
    const debug = debuggerStub({ value: 1, foreign: true })
    const outcome = await evalInPage({ ...stub.chrome, ...(debug.chrome as object) })('7', 'document.title')
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('另一个调试器')
    expect(debug.calls).toEqual([])
  })

  it('reports an exception thrown through the debugger', async () => {
    const stub = chromeStub(() => CSP_BLOCK)
    const debug = debuggerStub({ exception: 'Error: bang' })
    const outcome = await evalInPage({ ...stub.chrome, ...(debug.chrome as object) })('7', 'boom()')
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('bang')
  })

  it('does not fall back for an ordinary failure, and reports it as it stands', async () => {
    const stub = chromeStub(() => ({ __dshEval: 1, ok: false, error: 'not-defined-xyz is not defined' }))
    const outcome = await evalInPage(stub.chrome)('7', 'notDefinedXyz')
    expect(outcome).toEqual({ __dshEval: 1, ok: false, error: 'not-defined-xyz is not defined' })
    expect(stub.injections.map(entry => entry.world)).toEqual(['MAIN'])
  })

  it('names both routes when neither can run the expression', async () => {
    const stub = chromeStub(() => CSP_BLOCK)
    const debug = debuggerStub({ value: 1, attachFails: true })
    const outcome = await evalInPage({ ...stub.chrome, ...(debug.chrome as object) })('7', 'document.title')
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('调试通道')
    expect(outcome.error).toContain('Cannot attach')
  })
})

describe('pageExec', () => {
  /** `pageExec` as the extension ships it, over a stub `chrome`. */
  function pageExec(chrome: unknown): (tabId: string, func: unknown, args: unknown[]) => Promise<unknown> {
    return loadExtensionFunction<(tabId: string, func: unknown, args: unknown[]) => Promise<unknown>>(
      ['pageExec'],
      'pageExec',
      ['chrome'],
    )(chrome)
  }

  /** A `chrome` whose injection answers with one outcome. */
  function injectionStub(outcome: unknown): unknown {
    return { scripting: { executeScript: async () => outcome } }
  }

  it('returns the result of a helper that answered', async () => {
    await expect(pageExec(injectionStub([{ result: 7 }]))('7', () => 7, [])).resolves.toBe(7)
  })

  it('reports a throw instead of folding it into null', async () => {
    // The failure that made a malformed selector read as "no element matched".
    const chrome = injectionStub([{ error: { description: "SyntaxError: '#a[' is not a valid selector" } }])
    await expect(pageExec(chrome)('7', () => {}, [])).rejects.toThrow(/not a valid selector/)
  })

  it('reports a missing injection', async () => {
    await expect(pageExec(injectionStub([]))('7', () => {}, [])).rejects.toThrow(/无法注入/)
  })

  it('still answers null for a helper that genuinely returned nothing', async () => {
    await expect(pageExec(injectionStub([{ result: undefined }]))('7', () => {}, [])).resolves.toBeNull()
  })
})
