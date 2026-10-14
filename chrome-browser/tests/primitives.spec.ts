/**
 * The interaction primitives: `chrome_wait` and `chrome_hover`.
 *
 * Both exist twice — as expressions the CDP backend evaluates and as the
 * extension's own page functions — so these tests run BOTH against one stub
 * document and require the same answer.
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { BackendTab, BrowserBackend, ClickOutcome } from '../src/backend.ts'
import { mapHover, mapPress, mapSelect } from '../src/backend.ts'
import { resolveChromeConfig } from '../src/chrome.ts'
import { ConsoleLog } from '../src/console-log.ts'
import { HelpChannel } from '../src/help.ts'
import { hoverExpression, pressExpression, selectExpression, waitExpression } from '../src/expressions.ts'
import type { WaitState } from '../src/expressions.ts'
import { chromeToolDefinitions } from '../src/tools.ts'
import { loadExtensionFunction } from './support/extension-source.ts'

/** One dispatched event, as the stubs recorded it. */
interface StubEvent {
  readonly type: string
  readonly bubbles: boolean
  readonly clientX: number
  readonly key?: string
  readonly keyCode?: number
}

/** One stubbed element, with only the members these helpers read. */
interface StubElement {
  readonly rect: { width: number; height: number; left: number; top: number }
  readonly style: { visibility: string; display: string }
  readonly events: StubEvent[]
}

function element(overrides: Partial<Omit<StubElement, 'events'>> = {}): StubElement {
  const events: StubElement['events'] = []
  return {
    events,
    rect: { width: 100, height: 40, left: 10, top: 20 },
    style: { visibility: 'visible', display: 'block' },
    ...overrides,
  }
}

/** What `getComputedStyle` answers for an adapted element. */
const COMPUTED = new WeakMap<object, { visibility: string; display: string }>()

function adapt(target: StubElement): unknown {
  const proxy = {
    getBoundingClientRect: () => target.rect,
    focus: () => {},
    form: null,
    closest: () => null,
    dispatchEvent: (event: StubEvent) => {
      target.events.push({
        type: event.type,
        bubbles: event.bubbles === true,
        clientX: event.clientX ?? 0,
        ...(event.key === undefined ? {} : { key: event.key }),
        ...(event.keyCode === undefined ? {} : { keyCode: event.keyCode }),
      })
      return true
    },
  }
  COMPUTED.set(proxy, target.style)
  return proxy
}

/** Stand-in for KeyboardEvent: records the init the page passed it. */
class StubKeyboardEvent implements StubEvent {
  readonly type: string
  readonly bubbles: boolean
  readonly clientX = 0
  readonly key: string
  readonly keyCode: number

  constructor(type: string, init: { bubbles?: boolean; key?: string; keyCode?: number } = {}) {
    this.type = type
    this.bubbles = init.bubbles === true
    this.key = init.key ?? ''
    this.keyCode = init.keyCode ?? 0
  }
}

/** Stand-in for the page's PointerEvent/MouseEvent, recording what was dispatched. */
class StubPointerEvent {
  readonly type: string
  readonly bubbles: boolean
  readonly clientX: number

  constructor(type: string, init: { bubbles?: boolean; clientX?: number } = {}) {
    this.type = type
    this.bubbles = init.bubbles === true
    this.clientX = init.clientX ?? 0
  }
}

const WINDOW = { innerWidth: 1024, innerHeight: 768 }
const computedStyle = (el: unknown): { visibility: string; display: string } => (
  COMPUTED.get(el as object) ?? { visibility: 'visible', display: 'block' }
)

function documentWith(target: StubElement | undefined): unknown {
  return {
    querySelector: () => (target === undefined ? null : adapt(target)),
    title: 'T',
    querySelectorAll: () => (target === undefined ? [] : [adapt(target)]),
    elementFromPoint: () => null,
  }
}

/** Run the host's wait expression against a stub document. */
function runWait(state: WaitState, target: StubElement | undefined): boolean {
  const call = new Function(
    'document',
    'window',
    'getComputedStyle',
    `return ${waitExpression('#x', state)}`,
  )
  return call(documentWith(target), WINDOW, computedStyle) as boolean
}

/** Run the extension's own wait condition against the same stub document. */
function runExtensionWait(state: WaitState, target: StubElement | undefined): boolean {
  const wait = loadExtensionFunction<(selector: string, state: string) => boolean>(
    ['waitCondition'],
    'waitCondition',
    ['document', 'getComputedStyle'],
  )(documentWith(target), computedStyle)
  return wait('#x', state)
}

/** Run the host's press expression against a stub document. */
function runPress(key: string, target: StubElement | undefined, selector?: string): unknown {
  const call = new Function(
    'document',
    'window',
    'getComputedStyle',
    'KeyboardEvent',
    `return ${pressExpression(key, selector)}`,
  )
  return call(documentWith(target), WINDOW, computedStyle, StubKeyboardEvent)
}

/** Run the extension's own press function against the same stub document. */
function runExtensionPress(key: string, target: StubElement | undefined, selector?: string): unknown {
  const press = loadExtensionFunction<(key: string, selector?: string) => unknown>(
    ['KEY_CODES', 'pressKey'],
    'pressKey',
    ['document', 'KeyboardEvent'],
  )(documentWith(target), StubKeyboardEvent)
  return press(key, selector)
}

/** Stand-in for `HTMLSelectElement`: only a value setter and the option list. */
const SELECT_VALUE = new WeakMap<object, string>()

class StubSelect {
  /** Defined on the prototype below, so the native-setter trick finds it. */
  declare value: string
  readonly events: string[] = []
  readonly options: Array<{ value: string }>

  constructor(values: readonly string[]) {
    this.options = values.map(value => ({ value }))
  }

  dispatchEvent(event: { type: string }): boolean {
    this.events.push(event.type)
    return true
  }
}

Object.defineProperty(StubSelect.prototype, 'value', {
  configurable: true,
  get(this: object): string {
    return SELECT_VALUE.get(this) ?? ''
  },
  // A real <select> carries no value it has no option for: assigning one sets
  // selectedIndex to -1 and reads back as ''. Modelling that is what lets a
  // test see a rejected call wipe the selection it should have left alone.
  set(this: StubSelect, next: string): void {
    SELECT_VALUE.set(this, this.options.some(option => option.value === next) ? next : '')
  },
})

function selectDocument(values: readonly string[]): { document: unknown; select: StubSelect } {
  const select = new StubSelect(values)
  return { document: { querySelector: () => select }, select }
}

/** Run the host's select expression against a stub document. */
function runSelect(values: readonly string[], value: string): unknown {
  const { document, select } = selectDocument(values)
  const call = new Function(
    'document',
    'HTMLSelectElement',
    `return ${selectExpression('#x', value)}`,
  )
  return { outcome: call(document, StubSelect) as unknown, select }
}

/** Run the extension's own select function against the same stub document. */
function runExtensionSelect(values: readonly string[], value: string): unknown {
  const { document, select } = selectDocument(values)
  const selectOption = loadExtensionFunction<(selector: string, value: string) => unknown>(
    ['selectOption'],
    'selectOption',
    ['document', 'HTMLSelectElement', 'Event'],
  )(document, StubSelect, StubDomEvent)
  return { outcome: selectOption('#x', value), select }
}

/** Values live on the prototype so the native-setter trick finds a descriptor. */
const INPUT_VALUE = new WeakMap<object, string>()

/** Stand-in for a text input: a value, a caret range and its dispatched events. */
class StubInput {
  /** Defined on the prototype below, so the native-setter trick finds it. */
  declare value: string
  selectionStart = 0
  selectionEnd = 0
  readonly events: string[] = []

  constructor(value: string) {
    INPUT_VALUE.set(this, value)
    this.selectionEnd = value.length
  }

  focus(): void {}
  select(): void {
    this.selectionStart = 0
    this.selectionEnd = this.value.length
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start
    this.selectionEnd = end
  }

  dispatchEvent(event: { type: string }): boolean {
    this.events.push(event.type)
    return true
  }
}

Object.defineProperty(StubInput.prototype, 'value', {
  configurable: true,
  get(this: object): string {
    return INPUT_VALUE.get(this) ?? ''
  },
  set(this: object, next: string): void {
    INPUT_VALUE.set(this, next)
  },
})

/** Run the extension's own typeInto against one control. */
function typeOn(input: StubInput, text: string, clear: boolean): boolean {
  const type = loadExtensionFunction<(selector: string, text: string, clear: boolean) => boolean>(
    ['typeInto'],
    'typeInto',
    ['document', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'window'],
  )({ querySelector: () => input }, StubInput, StubInput, StubDomEvent, WINDOW)
  return type('#x', text, clear)
}

/** Run the host's select expression against one existing control. */
function selectOn(select: StubSelect, value: string): unknown {
  const call = new Function('document', 'HTMLSelectElement', `return ${selectExpression('#x', value)}`)
  return call({ querySelector: () => select }, StubSelect)
}

/** Run the extension's own select function against one existing control. */
function extensionSelectOn(select: StubSelect, value: string): unknown {
  const selectOption = loadExtensionFunction<(selector: string, value: string) => unknown>(
    ['selectOption'],
    'selectOption',
    ['document', 'HTMLSelectElement', 'Event'],
  )({ querySelector: () => select }, StubSelect, StubDomEvent)
  return selectOption('#x', value)
}

/** Minimal Event stand-in, carrying only what the page dispatches. */
class StubDomEvent {
  readonly type: string
  constructor(type: string) {
    this.type = type
  }
}

/** Run the host's hover expression against a stub document. */
function runHover(target: StubElement | undefined): unknown {
  const call = new Function(
    'document',
    'window',
    'getComputedStyle',
    'PointerEvent',
    'MouseEvent',
    `return ${hoverExpression('#x')}`,
  )
  return call(documentWith(target), WINDOW, computedStyle, StubPointerEvent, StubPointerEvent)
}

/** Run the extension's own hover function against the same stub document. */
function runExtensionHover(target: StubElement | undefined): unknown {
  const hover = loadExtensionFunction<(selector: string) => unknown>(
    ['hoverSelector'],
    'hoverSelector',
    ['document', 'window', 'PointerEvent', 'MouseEvent'],
  )(documentWith(target), WINDOW, StubPointerEvent, StubPointerEvent)
  return hover('#x')
}

/** Run one scenario through both wait implementations, requiring the same answer. */
function bothWait(state: WaitState, target: StubElement | undefined): { host: boolean; extension: boolean } {
  const host = runWait(state, target)
  expect(runExtensionWait(state, target)).toBe(host)
  return { host, extension: host }
}

describe('wait conditions', () => {
  it('reports a shown element as attached and visible', () => {
    expect(bothWait('attached', element()).host).toBe(true)
    expect(bothWait('visible', element()).host).toBe(true)
    expect(bothWait('detached', element()).host).toBe(false)
    expect(bothWait('hidden', element()).host).toBe(false)
  })

  it('treats a zero-size element as attached but not visible', () => {
    const collapsed = element({ rect: { width: 0, height: 0, left: 0, top: 0 } })
    expect(bothWait('attached', collapsed).host).toBe(true)
    expect(bothWait('visible', collapsed).host).toBe(false)
    expect(bothWait('hidden', collapsed).host).toBe(true)
  })

  it('treats a display:none element as attached but not visible', () => {
    const hidden = element({ style: { visibility: 'hidden', display: 'none' } })
    expect(bothWait('attached', hidden).host).toBe(true)
    expect(bothWait('visible', hidden).host).toBe(false)
    expect(bothWait('hidden', hidden).host).toBe(true)
  })

  it('reports an absent element as detached and hidden', () => {
    expect(bothWait('attached', undefined).host).toBe(false)
    expect(bothWait('detached', undefined).host).toBe(true)
    expect(bothWait('visible', undefined).host).toBe(false)
    expect(bothWait('hidden', undefined).host).toBe(true)
  })

  it('escapes a selector that would otherwise close the literal', () => {
    expect(waitExpression(`a[title="it's"]`, 'visible')).toContain(`"a[title=\\"it's\\"]"`)
  })
})

describe('hover', () => {
  it('dispatches the bubbling and non-bubbling events a menu listens for', () => {
    const target = element()
    const host = runHover(target) as { matched: number; hovered: boolean }
    expect(host).toEqual({ matched: 1, hovered: true })
    expect(target.events.map(event => event.type)).toEqual([
      'pointerover', 'mouseover', 'pointermove', 'mousemove', 'pointerenter', 'mouseenter',
    ])
    expect(target.events.filter(event => !event.bubbles).map(event => event.type))
      .toEqual(['pointerenter', 'mouseenter'])
    // The pointer is aimed at the element's centre.
    expect(target.events[0]?.clientX).toBe(60)
  })

  it('reports no match without dispatching anything', () => {
    const host = runHover(undefined) as { matched: number; hovered: boolean }
    expect(host).toEqual({ matched: 0, hovered: false })
    expect(runExtensionHover(undefined)).toEqual(host)
  })

  it('agrees with the extension on the outcome and the event sequence', () => {
    const forHost = element()
    const forExtension = element()
    expect(runHover(forHost)).toEqual(runExtensionHover(forExtension))
    expect(forExtension.events).toEqual(forHost.events)
  })
})

describe('press', () => {
  it('dispatches the key sequence with the legacy keyCode libraries still read', () => {
    const target = element()
    const host = runPress('Enter', target, '#x') as { found: boolean; pressed: boolean; submitted: boolean }
    expect(host).toEqual({ found: true, pressed: true, submitted: false })
    expect(target.events.map(event => event.type)).toEqual(['keydown', 'keypress', 'keyup'])
    expect(target.events[0]?.key).toBe('Enter')
    expect(target.events[0]?.keyCode).toBe(13)
  })

  it('reports no target when the selector matches nothing', () => {
    const host = runPress('Enter', undefined, '#x') as { found: boolean }
    expect(host.found).toBe(false)
    expect(runExtensionPress('Enter', undefined, '#x')).toMatchObject({ found: false })
  })

  it('agrees with the extension on the outcome and the event sequence', () => {
    for (const key of ['Enter', 'Escape', 'Tab', 'ArrowDown', 'F5']) {
      const forHost = element()
      const forExtension = element()
      expect(runPress(key, forHost, '#x'), key).toEqual(runExtensionPress(key, forExtension, '#x'))
      expect(forExtension.events, key).toEqual(forHost.events)
    }
  })
})

describe('select', () => {
  it('sets the value and fires input then change', () => {
    const { outcome, select } = runSelect(['US', 'CA'], 'CA') as {
      outcome: { matched: number; changed: boolean; value: string; options: string[] }
      select: StubSelect
    }
    expect(outcome).toEqual({ matched: 1, changed: true, value: 'CA', options: ['US', 'CA'] })
    expect(select.events).toEqual(['input', 'change'])
  })

  it('leaves the control alone and reports the options when the value names none', () => {
    const { outcome, select } = runSelect(['US', 'CA'], 'XX') as {
      outcome: { changed: boolean; value: string; options: string[] }
      select: StubSelect
    }
    expect(outcome.changed).toBe(false)
    expect(outcome.options).toEqual(['US', 'CA'])
    expect(select.value).toBe('')
    expect(select.events).toEqual([])
  })

  it('does not disturb a control that already had a selection', () => {
    // The old code assigned first and judged afterwards, so a call that was
    // about to be rejected cleared the <select> anyway — and the error still
    // listed the available values, as if nothing had happened.
    for (const [who, apply] of [
      ['host', selectOn],
      ['extension', extensionSelectOn],
    ] as const) {
      const select = new StubSelect(['US', 'CA'])
      expect((apply(select, 'CA') as { changed: boolean }).changed).toBe(true)
      expect(select.value, who).toBe('CA')
      select.events.length = 0

      expect((apply(select, 'XX') as { changed: boolean }).changed).toBe(false)
      expect(select.value, `${who}: the rejected call wiped the selection`).toBe('CA')
      expect(select.events, who).toEqual([])
    }
  })

  it('reports no match without touching anything', () => {
    const { document } = selectDocument(['US'])
    const call = new Function('document', 'HTMLSelectElement', `return ${selectExpression('#x', 'US')}`)
    expect(call({ querySelector: () => null }, StubSelect)).toEqual({
      matched: 0, changed: false, value: '', options: [],
    })
    expect(document).toBeDefined()
  })

  it('agrees with the extension on both outcomes', () => {
    for (const value of ['CA', 'XX']) {
      const host = runSelect(['US', 'CA'], value) as { outcome: unknown; select: StubSelect }
      const extension = runExtensionSelect(['US', 'CA'], value) as { outcome: unknown; select: StubSelect }
      expect(extension.outcome, value).toEqual(host.outcome)
      expect(extension.select.events, value).toEqual(host.select.events)
    }
  })
})

describe('typeInto', () => {
  // `clear: false` means "insert at the caret" on the CDP backend, which uses
  // Input.insertText. The extension replaced the whole value instead, so the
  // same call did two different things depending on the connection.
  it('inserts at the caret when clear is false', () => {
    const input = new StubInput('ABC')
    input.setSelectionRange(3, 3)
    expect(typeOn(input, 'DEF', false)).toBe(true)
    expect(input.value).toBe('ABCDEF')
    expect(input.selectionStart).toBe(6)
  })

  it('replaces the caret selection, as insertText does', () => {
    const input = new StubInput('ABC')
    input.setSelectionRange(1, 2)
    typeOn(input, 'X', false)
    expect(input.value).toBe('AXC')
  })

  it('replaces the whole value when clear is true', () => {
    const input = new StubInput('ABC')
    typeOn(input, 'X', true)
    expect(input.value).toBe('X')
  })

  it('reports the failure when the selector matches nothing', () => {
    const type = loadExtensionFunction<(selector: string, text: string, clear: boolean) => boolean>(
      ['typeInto'],
      'typeInto',
      ['document', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'window'],
    )({ querySelector: () => null }, StubInput, StubInput, StubDomEvent, WINDOW)
    expect(type('#nope', 'x', true)).toBe(false)
  })
})

describe('mapPress and mapSelect', () => {
  it('reads a well-formed press result', () => {
    expect(mapPress({ found: true, pressed: true, submitted: true }))
      .toEqual({ found: true, pressed: true, submitted: true })
  })

  it('defaults an unusable press result', () => {
    expect(mapPress(undefined)).toEqual({ found: false, pressed: false, submitted: false })
    expect(mapPress({ found: 'yes', pressed: 1 })).toEqual({ found: false, pressed: false, submitted: false })
  })

  it('reads a well-formed select result', () => {
    expect(mapSelect({ matched: 1, changed: true, value: 'CA', options: ['US', 'CA'] }))
      .toEqual({ matched: 1, changed: true, value: 'CA', options: ['US', 'CA'] })
  })

  it('defaults an unusable select result and drops non-string options', () => {
    expect(mapSelect(undefined)).toEqual({ matched: 0, changed: false, value: '', options: [] })
    expect(mapSelect({ matched: 1, options: ['a', 2, null] })).toMatchObject({ options: ['a'] })
    expect(mapSelect({ reason: 'not a <select>' })).toMatchObject({ reason: 'not a <select>' })
  })
})

describe('mapHover', () => {
  it('passes a well-formed result through', () => {
    expect(mapHover({ matched: 2, hovered: true })).toEqual({ matched: 2, hovered: true })
  })

  it('defaults an unusable result', () => {
    expect(mapHover(undefined)).toEqual({ matched: 0, hovered: false })
    expect(mapHover('nope')).toEqual({ matched: 0, hovered: false })
    expect(mapHover({ matched: 1, hovered: 'yes' })).toEqual({ matched: 1, hovered: false })
  })
})

const EMPTY_CLICK: ClickOutcome = {
  matched: 0, clicked: 0, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0,
}

interface Host {
  backend: BrowserBackend
  /** Every `waitFor` the tool issued. */
  readonly waits: Array<{ selector: string; state: WaitState; timeoutMs: number }>
  readonly hovers: string[]
  /** Every `press` the tool issued. */
  readonly presses: string[]
  /** Every `select` the tool issued. */
  readonly selects: string[]
  satisfied: boolean
  hoverMatched: number
  pressFound: boolean
  selectOutcome: { matched: number; changed: boolean; value: string; options: string[]; reason?: string }
}

function host(): Host {
  const tab: BackendTab = { id: '7', title: 'T', url: 'https://e.test/', active: true, favicon: '' }
  const state: Host = {
    waits: [],
    hovers: [],
    presses: [],
    selects: [],
    satisfied: false,
    hoverMatched: 1,
    pressFound: true,
    selectOutcome: { matched: 1, changed: true, value: 'CA', options: ['US', 'CA'] },
    backend: undefined as unknown as BrowserBackend,
  }
  state.backend = {
    lastEvalWorld: undefined,
    ensure: async () => {},
    activeTabId: async () => tab.id,
    listTabs: async () => [tab],
    openTab: async () => tab,
    closeTab: async () => {},
    read: async () => ({ title: '', url: '', text: '', html: '' }),
    inventory: async () => ({ title: '', url: '', matched: 0, items: [] }),
    navigate: async () => {},
    waitForLoad: async () => {},
    evaluate: async () => undefined,
    click: async () => EMPTY_CLICK,
    hover: async (tabId: string, selector: string) => {
      state.hovers.push(`${tabId}:${selector}`)
      return { matched: state.hoverMatched, hovered: state.hoverMatched > 0 }
    },
    press: async (tabId: string, key: string, selector?: string) => {
      state.presses.push(`${tabId}:${key}:${selector ?? ''}`)
      return { found: state.pressFound, pressed: state.pressFound, submitted: key === 'Enter' && state.pressFound }
    },
    select: async (tabId: string, selector: string, value: string) => {
      state.selects.push(`${tabId}:${selector}:${value}`)
      return state.selectOutcome
    },
    waitFor: async (tabId: string, selector: string, waitState: WaitState, timeoutMs: number) => {
      state.waits.push({ selector: `${tabId}:${selector}`, state: waitState, timeoutMs })
      return state.satisfied
    },
    type: async () => {},
    screenshot: async () => ({ data: '' }),
    startConsole: async () => {},
    stopConsole: async () => {},
    dispose: () => {},
  }
  return state
}

function tools(backend: BrowserBackend): Map<string, ToolDefinition> {
  return new Map(
    chromeToolDefinitions(backend, resolveChromeConfig({}), new ConsoleLog(), new HelpChannel())
      .map(definition => [definition.name, definition]),
  )
}

async function run(
  state: Host,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = tools(state.backend).get(name)
  if (tool === undefined) throw new Error(`${name} is not registered`)
  return await tool.execute(args as never, {} as never) as unknown as Record<string, unknown>
}

describe('chrome_wait', () => {
  it('defaults to visible and reports the outcome with the elapsed time', async () => {
    const state = host()
    state.satisfied = true
    const value = await run(state, 'chrome_wait', { tabId: '7', selector: '#ready' })
    expect(state.waits).toEqual([{ selector: '7:#ready', state: 'visible', timeoutMs: 10_000 }])
    expect(value).toMatchObject({ tabId: '7', selector: '#ready', state: 'visible', satisfied: true })
    expect(Number(value.elapsedMs)).toBeGreaterThanOrEqual(0)
  })

  it('passes an explicit state through', async () => {
    const state = host()
    await run(state, 'chrome_wait', { tabId: '7', selector: '#spinner', state: 'detached' })
    expect(state.waits[0]?.state).toBe('detached')
  })

  it('rejects a state outside the declared set before reaching the backend', async () => {
    const state = host()
    await expect(run(state, 'chrome_wait', { tabId: '7', selector: '#ready', state: 'gone' }))
      .rejects.toThrow(/must be one of/u)
    expect(state.waits).toEqual([])
  })

  it('clamps the bound at both ends', async () => {
    const state = host()
    await run(state, 'chrome_wait', { tabId: '7', selector: '#a', timeoutMs: 10 * 60_000 })
    await run(state, 'chrome_wait', { tabId: '7', selector: '#b', timeoutMs: -5 })
    expect(state.waits.map(wait => wait.timeoutMs)).toEqual([300_000, 0])
  })

  it('reports an unsatisfied wait as satisfied: false rather than as success', async () => {
    const state = host()
    state.satisfied = false
    const value = await run(state, 'chrome_wait', { tabId: '7', selector: '#never' })
    expect(value.satisfied).toBe(false)
  })
})

describe('chrome_hover', () => {
  it('hovers the selector it was given', async () => {
    const state = host()
    const value = await run(state, 'chrome_hover', { tabId: '7', selector: '#menu' })
    expect(state.hovers).toEqual(['7:#menu'])
    expect(value).toEqual({ tabId: '7', selector: '#menu', hovered: true })
  })

  it('reports no match instead of pretending it hovered something', async () => {
    const state = host()
    state.hoverMatched = 0
    await expect(run(state, 'chrome_hover', { tabId: '7', selector: '#ghost' }))
      .rejects.toThrow(/no element matched selector "#ghost"/)
  })
})

describe('chrome_press', () => {
  it('presses on the focused element when no selector is given', async () => {
    const state = host()
    const value = await run(state, 'chrome_press', { tabId: '7', key: 'Escape' })
    expect(state.presses).toEqual(['7:Escape:'])
    expect(value).toMatchObject({ key: 'Escape', selector: null, pressed: true })
  })

  it('focuses a selector first and reports the submit it performed', async () => {
    const state = host()
    const value = await run(state, 'chrome_press', { tabId: '7', key: 'Enter', selector: '#search' })
    expect(state.presses).toEqual(['7:Enter:#search'])
    expect(value).toMatchObject({ key: 'Enter', selector: '#search', submitted: true })
  })

  it('reports no target instead of pressing into nothing', async () => {
    const state = host()
    state.pressFound = false
    await expect(run(state, 'chrome_press', { tabId: '7', key: 'Enter', selector: '#ghost' }))
      .rejects.toThrow(/no element matched selector "#ghost"/)
  })
})

describe('chrome_select', () => {
  it('selects the value and reports what took effect', async () => {
    const state = host()
    const value = await run(state, 'chrome_select', { tabId: '7', selector: '#country', value: 'CA' })
    expect(state.selects).toEqual(['7:#country:CA'])
    expect(value).toEqual({ tabId: '7', selector: '#country', value: 'CA' })
  })

  it('lists the available values when the value names no option', async () => {
    const state = host()
    state.selectOutcome = { matched: 1, changed: false, value: '', options: ['US', 'CA'] }
    await expect(run(state, 'chrome_select', { tabId: '7', selector: '#country', value: 'XX' }))
      .rejects.toThrow(/no option with value "XX"; available values: US, CA/)
  })

  it('says so when the target is not a select at all', async () => {
    const state = host()
    state.selectOutcome = { matched: 1, changed: false, value: '', options: [], reason: 'not a <select>' }
    await expect(run(state, 'chrome_select', { tabId: '7', selector: '#text', value: 'x' }))
      .rejects.toThrow(/is not a <select>; use chrome_type/)
  })

  it('reports no match', async () => {
    const state = host()
    state.selectOutcome = { matched: 0, changed: false, value: '', options: [] }
    await expect(run(state, 'chrome_select', { tabId: '7', selector: '#ghost', value: 'x' }))
      .rejects.toThrow(/no element matched selector "#ghost"/)
  })
})
