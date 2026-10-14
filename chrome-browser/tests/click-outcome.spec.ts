/**
 * Click semantics, exercised for real.
 *
 * The clickability probe exists twice — as the CDP expression string the host
 * ships (`src/expressions.ts`) and as the extension's own functions
 * (`extension/service-worker.js`) — because the bridge cannot import host
 * modules. These tests run BOTH against the same stub document and require the
 * same outcome, which is the only thing keeping the copies in step.
 *
 * The stub document implements just the surface the probe touches, so the
 * decision logic runs unmodified instead of being asserted by string shape.
 */
import { describe, expect, it } from 'vitest'
import { clickExpression } from '../src/expressions.ts'
import { mapClickOutcome } from '../src/backend.ts'
import type { ClickOutcome } from '../src/backend.ts'
import { clickWarnings } from '../src/tools.ts'
import { loadExtensionFunction } from './support/extension-source.ts'

/** One stubbed element, with only the members the probe reads. */
interface StubElement {
  disabled: boolean
  ariaDisabled: boolean
  rect: { left: number; top: number; width: number; height: number }
  style: { visibility: string; display: string }
  /** Elements this one contains, for the hit-test containment check. */
  contains_: StubElement[]
  /** What `getRootNode()` returns; a shadow root here exposes `elementFromPoint`. */
  root: unknown
  clicks: number
}

function element(overrides: Partial<StubElement> = {}): StubElement {
  return {
    disabled: false,
    ariaDisabled: false,
    rect: { left: 10, top: 10, width: 100, height: 40 },
    style: { visibility: 'visible', display: 'block' },
    contains_: [],
    root: undefined,
    clicks: 0,
    ...overrides,
  }
}

/**
 * The `HTMLElement` face the probe uses, over one {@link StubElement}. Memoized:
 * the probe compares elements by identity (`hit === el`, `el.contains(hit)`), so
 * every lookup for one element must return the same object.
 */
const ADAPTED = new WeakMap<StubElement, unknown>()

function adapt(target: StubElement): unknown {
  const cached = ADAPTED.get(target)
  if (cached !== undefined) return cached
  const proxy = {
    get disabled(): boolean { return target.disabled },
    getBoundingClientRect: () => target.rect,
    getAttribute: (name: string) => (
      name === 'aria-disabled' && target.ariaDisabled ? 'true' : null
    ),
    getRootNode: () => target.root ?? { nodeType: 9 },
    contains: (other: unknown) => target.contains_.some(candidate => adapt(candidate) === other),
    click: () => { target.clicks += 1 },
  }
  ADAPTED.set(target, proxy)
  COMPUTED.set(proxy, target.style)
  return proxy
}

interface StubDocument {
  querySelectorAll(): unknown
  elementFromPoint(x: number, y: number): unknown
}

function documentStub(elements: StubElement[], hitTest: (x: number, y: number) => unknown): StubDocument {
  return {
    querySelectorAll: () => elements.map(adapt),
    elementFromPoint: hitTest,
  }
}

const WINDOW = { innerWidth: 1024, innerHeight: 768 }

/**
 * Stand-in for the browser's `getComputedStyle`, which answers from the style
 * record registered with each adapted element.
 */
const COMPUTED = new WeakMap<object, { visibility: string; display: string }>()
const DEFAULT_STYLE = { visibility: 'visible', display: 'block' }
const style = (el: unknown): { visibility: string; display: string } => (
  COMPUTED.get(el as object) ?? DEFAULT_STYLE
)

/** Evaluate the host's CDP click expression against a stub document. */
function runExpression(selector: string, all: boolean, doc: StubDocument): ClickOutcome {
  const call = new Function('document', 'window', 'getComputedStyle', `return ${clickExpression(selector, all)}`)
  return call(doc, WINDOW, style) as ClickOutcome
}

/** Run the extension's own `clickSelector` against the same stub document. */
function runExtension(selector: string, all: boolean, doc: StubDocument): ClickOutcome {
  const factory = loadExtensionFunction<(selector: string, all: boolean) => ClickOutcome>(
    ['describeTarget', 'clickSelector'],
    'clickSelector',
    ['document', 'window', 'getComputedStyle'],
  )
  const click = factory(doc, WINDOW, style)
  return click(selector, all)
}

/** One scenario, run through both implementations. */
interface Scenario {
  readonly target: StubElement
  readonly hit: (element: StubElement) => unknown
  readonly expected: { clicked: number; disabled: number; invisible: number; offscreen: number; covered: number; ariaDisabled: number }
}

function runBoth(scenario: Scenario, all = false): void {
  const doc = documentStub([scenario.target], () => scenario.hit(scenario.target))
  for (const [label, run] of [['cdp expression', runExpression], ['extension', runExtension]] as const) {
    // Reset per implementation so a caller can read `clicks` afterwards and see
    // what the LAST run dispatched.
    scenario.target.clicks = 0
    const outcome = run('#x', all, doc)
    expect(outcome, label).toMatchObject({ matched: 1, ...scenario.expected })
  }
}

describe('click probe: the CDP expression and the extension agree', () => {
  it('reports a plain visible element as clicked', () => {
    const target = element()
    runBoth({ target, hit: () => adapt(target), expected: { clicked: 1, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0 } })
  })

  it('refuses a natively disabled element instead of counting a click', () => {
    const target = element({ disabled: true })
    runBoth({ target, hit: () => adapt(target), expected: { clicked: 0, disabled: 1, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0 } })
    expect(target.clicks).toBe(0)
  })

  it('clicks a zero-size element but reports it as invisible', () => {
    const target = element({ rect: { left: 0, top: 0, width: 0, height: 0 } })
    runBoth({ target, hit: () => adapt(target), expected: { clicked: 1, disabled: 0, invisible: 1, offscreen: 0, covered: 0, ariaDisabled: 0 } })
    expect(target.clicks).toBe(1)
  })

  it('clicks a hidden element but reports it as invisible', () => {
    const target = element({ style: { visibility: 'hidden', display: 'block' } })
    runBoth({ target, hit: () => adapt(target), expected: { clicked: 1, disabled: 0, invisible: 1, offscreen: 0, covered: 0, ariaDisabled: 0 } })
  })

  it('clicks an off-viewport element but reports it as offscreen', () => {
    const target = element({ rect: { left: -500, top: -500, width: 100, height: 40 } })
    runBoth({ target, hit: () => adapt(target), expected: { clicked: 1, disabled: 0, invisible: 0, offscreen: 1, covered: 0, ariaDisabled: 0 } })
  })

  it('clicks a covered element but reports it as covered', () => {
    const target = element()
    const overlay = element()
    runBoth({ target, hit: () => adapt(overlay), expected: { clicked: 1, disabled: 0, invisible: 0, offscreen: 0, covered: 1, ariaDisabled: 0 } })
  })

  it('treats a hit test inside the target as uncovered', () => {
    const target = element()
    const child = element()
    target.contains_ = [child]
    runBoth({ target, hit: () => adapt(child), expected: { clicked: 1, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0 } })
  })

  it('hit-tests within a shadow root rather than through the document', () => {
    const target = element()
    // document.elementFromPoint would return the shadow host; the probe must
    // consult the element's own root instead of reporting every shadow-DOM
    // target as covered.
    target.root = { elementFromPoint: () => adapt(target) }
    const doc = documentStub([target], () => adapt(element()))
    for (const run of [runExpression, runExtension]) {
      expect(run('#x', false, doc)).toMatchObject({ clicked: 1, covered: 0 })
    }
  })

  it('counts an aria-disabled element as clicked and flagged', () => {
    const target = element({ ariaDisabled: true })
    runBoth({ target, hit: () => adapt(target), expected: { clicked: 1, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 1 } })
    expect(target.clicks).toBe(1)
  })

  it('reports no match without clicking anything', () => {
    const doc = documentStub([], () => null)
    for (const run of [runExpression, runExtension]) {
      expect(run('#x', false, doc)).toEqual({
        matched: 0, clicked: 0, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0,
      })
    }
  })
})

describe('click targeting', () => {
  it('clicks only the first match but reports the whole match count', () => {
    const first = element()
    const second = element()
    const doc = documentStub([first, second], () => adapt(first))
    for (const run of [runExpression, runExtension]) {
      first.clicks = 0
      second.clicks = 0
      expect(run('#x', false, doc)).toMatchObject({ matched: 2, clicked: 1 })
      expect(first.clicks).toBe(1)
      expect(second.clicks).toBe(0)
    }
  })

  it('clicks every match when all is set', () => {
    const first = element()
    const second = element()
    const doc = documentStub([first, second], () => adapt(first))
    for (const run of [runExpression, runExtension]) {
      first.clicks = 0
      second.clicks = 0
      expect(run('#x', true, doc)).toMatchObject({ matched: 2, clicked: 2 })
      expect(first.clicks).toBe(1)
      expect(second.clicks).toBe(1)
    }
  })

  it('counts a disabled match among the matches it did not click', () => {
    const enabled = element()
    const disabled = element({ disabled: true })
    const doc = documentStub([enabled, disabled], () => adapt(enabled))
    for (const run of [runExpression, runExtension]) {
      expect(run('#x', true, doc)).toMatchObject({ matched: 2, clicked: 1, disabled: 1 })
    }
  })
})

describe('mapClickOutcome', () => {
  it('passes a well-formed page result through', () => {
    expect(mapClickOutcome({ matched: 3, clicked: 2, disabled: 1, invisible: 1, offscreen: 0, covered: 0, ariaDisabled: 0 }))
      .toEqual({ matched: 3, clicked: 2, disabled: 1, invisible: 1, offscreen: 0, covered: 0, ariaDisabled: 0 })
  })

  it('reads a bare number as the pre-0.4 bridge count', () => {
    // A Chrome extension still loaded from an older package returns a number;
    // it must keep working until the user reloads it.
    expect(mapClickOutcome(2)).toEqual({ matched: 2, clicked: 2, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0 })
  })

  it('defaults every field for an unusable reply', () => {
    const empty = { matched: 0, clicked: 0, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0 }
    expect(mapClickOutcome(undefined)).toEqual(empty)
    expect(mapClickOutcome(null)).toEqual(empty)
    expect(mapClickOutcome('1')).toEqual(empty)
    expect(mapClickOutcome(-1)).toEqual(empty)
    expect(mapClickOutcome({ matched: 2 })).toMatchObject({ matched: 2, clicked: 0 })
    expect(mapClickOutcome({ matched: Number.NaN, clicked: -5 })).toMatchObject({ matched: 0, clicked: 0 })
  })
})

describe('clickWarnings', () => {
  const base: ClickOutcome = { matched: 1, clicked: 1, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0 }

  it('says nothing about a click that landed on a plain visible element', () => {
    expect(clickWarnings(base)).toEqual([])
  })

  it('names each condition that makes a dispatched click doubtful', () => {
    expect(clickWarnings({ ...base, invisible: 1 })[0]).toContain('no visible box')
    expect(clickWarnings({ ...base, offscreen: 1 })[0]).toContain('outside the viewport')
    expect(clickWarnings({ ...base, covered: 1 })[0]).toContain('covered by another element')
    expect(clickWarnings({ ...base, ariaDisabled: 1 })[0]).toContain('aria-disabled')
  })

  it('reports every condition at once', () => {
    expect(clickWarnings({ ...base, invisible: 2, covered: 1 })).toHaveLength(2)
  })
})
