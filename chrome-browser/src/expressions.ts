/**
 * Runtime.evaluate expressions the tools run inside the page main frame.
 * Expressions are deliberately self-contained IIFEs so results survive
 * serialization and cannot leak page globals into the harness.
 * @module @liyuera/dsh-chrome-browser/expressions
 */

/** Escape one selector as a JS string literal (JSON is a valid JS string). */
function literal(value: string): string {
  return JSON.stringify(value)
}

/**
 * Legacy `keyCode` values the common keys need: libraries still read them, and
 * a synthesized `KeyboardEvent` carries none by default.
 */
const KEY_CODES: Readonly<Record<string, number>> = {
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

/**
 * Press expression: dispatch one key on a matched element, or on whatever
 * currently has focus.
 *
 * Synthetic key events do not trigger the browser's own default actions, so
 * `Enter` in a form would type nothing and submit nothing. The expression
 * therefore submits the owning form explicitly and reports that it did, rather
 * than leaving the caller to guess why nothing happened.
 * @param key - the `KeyboardEvent.key` value, e.g. `Enter` or `ArrowDown`.
 * @param selector - element to focus first; omit to press on the focused element.
 * @returns a self-contained expression evaluating to `{ found, pressed, submitted }`.
 */
export function pressExpression(key: string, selector?: string): string {
  const target = selector === undefined
    ? 'document.activeElement'
    : `document.querySelector(${literal(selector)})`
  return `(() => {
    const el = ${target}
    if (el === null) return { found: false, pressed: false, submitted: false }
    const node = el ?? document.body
    if (typeof node.focus === 'function') node.focus()
    const init = { key: ${literal(key)}, bubbles: true, cancelable: true, keyCode: ${KEY_CODES[key] ?? 0} }
    node.dispatchEvent(new KeyboardEvent('keydown', init))
    node.dispatchEvent(new KeyboardEvent('keypress', init))
    node.dispatchEvent(new KeyboardEvent('keyup', init))
    let submitted = false
    if (init.key === 'Enter') {
      const form = node.form ?? (typeof node.closest === 'function' ? node.closest('form') : null)
      if (form !== null && form !== undefined && typeof form.requestSubmit === 'function') {
        form.requestSubmit()
        submitted = true
      }
    }
    return { found: true, pressed: true, submitted }
  })()`
}

/**
 * Select expression: set a `<select>`'s value and fire the events a controlled
 * component listens for, through the prototype setter so frameworks that patch
 * the instance still see the change.
 *
 * A value with no matching option leaves the select unchanged; the result says
 * so and lists what was available instead of reporting a success the page never
 * saw.
 * @param selector - CSS selector for the `<select>`.
 * @param value - the option value to select.
 * @returns a self-contained expression evaluating to the selection outcome.
 */
export function selectExpression(selector: string, value: string): string {
  return `(() => {
    const el = document.querySelector(${literal(selector)})
    if (el === null) return { matched: 0, changed: false, value: '', options: [] }
    if (!(el instanceof HTMLSelectElement)) {
      return { matched: 1, changed: false, value: '', options: [], reason: 'not a <select>' }
    }
    const all = Array.from(el.options).map((option) => option.value)
    const options = all.slice(0, 30)
    // Checked BEFORE assigning: assigning a value no option carries sets
    // selectedIndex to -1 and clears the control, so a call that is about to be
    // rejected would still wipe the selection the user had.
    if (all.indexOf(${literal(value)}) === -1) {
      return { matched: 1, changed: false, value: el.value, options }
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(el, ${literal(value)})
    const changed = el.value === ${literal(value)}
    if (changed) {
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return { matched: 1, changed, value: el.value, options }
  })()`
}

/** Element conditions `chrome_wait` can wait for. */
export type WaitState = 'attached' | 'detached' | 'visible' | 'hidden'

/**
 * Poll expression for one wait condition: does the selector currently satisfy
 * `state`? Resolved fresh on every poll, because the page changes between them.
 * @param selector - CSS selector to test.
 * @param state - the condition to test for.
 * @returns a self-contained expression evaluating to a boolean.
 */
export function waitExpression(selector: string, state: WaitState): string {
  const condition = {
    attached: 'attached',
    detached: '!attached',
    visible: 'attached && shown',
    hidden: '!attached || !shown',
  }[state]
  return `(() => {
    const el = document.querySelector(${literal(selector)})
    const attached = el !== null
    let shown = false
    if (attached) {
      const rect = el.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        const style = getComputedStyle(el)
        shown = style.visibility !== 'hidden' && style.display !== 'none'
      }
    }
    return ${condition}
  })()`
}

/**
 * Hover expression: dispatch the pointer events a hover-driven menu listens for
 * on the first match.
 *
 * These are synthetic: they reach listeners the page attached, but they do not
 * set the browser's own hover state, so a control revealed purely by a CSS
 * `:hover` rule will not appear. The alternative — real pointer input — is not
 * available on the extension bridge, so both backends behave the same.
 * @param selector - CSS selector to hover.
 * @returns a self-contained expression evaluating to `{ matched, hovered }`.
 */
export function hoverExpression(selector: string): string {
  return `(() => {
    const el = document.querySelector(${literal(selector)})
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
  })()`
}

/** Live page-facts expression: title, url, visible text, optional HTML. */
export function readPageExpression(includeHtml: boolean): string {
  const htmlPart = includeHtml
    ? "document.documentElement ? document.documentElement.outerHTML : ''"
    : "''"
  return `(() => {
    const text = document.body ? document.body.innerText : ''
    return { title: document.title, url: location.href, text, html: ${htmlPart} }
  })()`
}

/** Viewport dimensions expression (screenshot metadata). */
export function viewportExpression(): string {
  return '({ width: window.innerWidth, height: window.innerHeight })'
}

/** Document readiness poll expression (navigation wait). */
export function readyStateExpression(): string {
  return 'document.readyState'
}

/**
 * Page-side clickability probe, shared with the extension bridge: the same
 * function body exists in `extension/service-worker.js` (`describeTarget`), and
 * the two must stay in step — the bridge cannot import this module.
 *
 * `disabled` is the only state that suppresses the click event outright, so it
 * is the only one the caller refuses to click. The others are reported because
 * a click can be dispatched while a real pointer could never have reached the
 * element, which is exactly the case a caller must not mistake for success.
 */
const CLICK_PROBE = `const probe = (el) => {
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
  }`

/**
 * Click expression. Returns one outcome per call: how many elements the
 * selector matched, how many received a dispatched click, and why the rest did
 * not or may not have taken effect. `all` clicks every match, otherwise only
 * the first.
 * @param selector - CSS selector to resolve.
 * @param all - whether to click every match instead of the first.
 * @returns a self-contained expression evaluating to the click outcome.
 */
export function clickExpression(selector: string, all: boolean): string {
  const sel = literal(selector)
  const targets = all ? 'Array.from(matched)' : 'matched.length > 0 ? [matched[0]] : []'
  return `(() => {
    ${CLICK_PROBE}
    const matched = document.querySelectorAll(${sel})
    const targets = ${targets}
    const outcome = { matched: matched.length, clicked: 0, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0 }
    for (const el of targets) {
      const state = probe(el)
      if (state === 'disabled') { outcome.disabled++; continue }
      if (state !== 'ok') outcome[state]++
      if (el.getAttribute('aria-disabled') === 'true') outcome.ariaDisabled++
      el.click()
      outcome.clicked++
    }
    return outcome
  })()`
}

/** Elements the interactive inventory considers actionable. */
export const INTERACTIVE_SELECTOR = 'a[href],button,input,select,textarea,[role=button],[role=link],'
  + '[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[contenteditable=""],[contenteditable=true]'

/** Elements one inventory returns; a longer page is reported as capped. */
export const INVENTORY_LIMIT = 150

/** Characters one inventory entry's name keeps. */
const MAX_NAME_CHARS = 80

/**
 * Interactive-element inventory expression: what a reader can act on, with the
 * selector to act on it, instead of the page's prose. Shares the click probe
 * with {@link clickExpression}, so `covered` here means the same thing it means
 * in a click result.
 *
 * The extension bridge runs the same inventory in
 * `extension/service-worker.js` (`interactiveInventory`), because it cannot
 * import host modules; tests/inventory.spec.ts requires the two to agree.
 * @returns a self-contained expression evaluating to `{ matched, items }`.
 */
export function inventoryExpression(): string {
  return `(() => {
    ${CLICK_PROBE}
    const SELECTOR = ${JSON.stringify(INTERACTIVE_SELECTOR)}
    const LIMIT = ${INVENTORY_LIMIT}
    const MAX_NAME = ${MAX_NAME_CHARS}
    const escape = (value) => (typeof CSS !== 'undefined' && CSS.escape
      ? CSS.escape(value)
      : String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\\\' + ch))
    const stableSelector = (el) => {
      if (el.id) {
        const byId = '#' + escape(el.id)
        try { if (document.querySelectorAll(byId).length === 1) return byId } catch (error) { /* unusable id */ }
      }
      const parts = []
      let node = el
      for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth++) {
        const tag = node.tagName.toLowerCase()
        const parent = node.parentElement
        if (parent === null) { parts.unshift(tag); break }
        const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName)
        parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')' : tag)
        node = parent
      }
      return parts.join(' > ')
    }
    const nameOf = (el) => {
      const raw = el.getAttribute('aria-label')
        || (el.innerText && el.innerText.trim())
        || el.value
        || el.getAttribute('placeholder')
        || el.getAttribute('title')
        || el.getAttribute('name')
        || ''
      return String(raw).replace(/\\s+/g, ' ').trim().slice(0, MAX_NAME)
    }
    const matched = document.querySelectorAll(SELECTOR)
    const items = []
    for (const el of matched) {
      if (items.length >= LIMIT) break
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      const state = probe(el)
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
  })()`
}

/**
 * Focus-only expression for typing without replacing existing content: focuses
 * the matched element and leaves its selection untouched. Returns whether a
 * match was found.
 */
/**
 * Box of one element in PAGE coordinates, for a clipped screenshot.
 *
 * `getBoundingClientRect` is viewport-relative while `Page.captureScreenshot`'s
 * clip is page-relative, so the scroll offset is added back. The caller also
 * asks for `captureBeyondViewport`, without which an element below the fold
 * would be captured as blank.
 * @param selector - CSS selector of the element to measure.
 * @returns an expression answering `{ matched, x, y, width, height }`.
 */
export function rectExpression(selector: string): string {
  const sel = literal(selector)
  return `(() => {
    const el = document.querySelector(${sel})
    if (el === null) return { matched: 0 }
    const rect = el.getBoundingClientRect()
    return {
      matched: 1,
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
    }
  })()`
}

export function focusExpression(selector: string): string {
  const sel = literal(selector)
  return `(() => {
    const el = document.querySelector(${sel})
    if (!el) return false
    el.focus()
    return true
  })()`
}

/**
 * Focus and select expression for typing: focuses the matched element and
 * selects its existing content (input/textarea via `select()`, other editable
 * elements via a Range over its contents). Returns whether a match was found.
 */
export function focusAndSelectExpression(selector: string): string {
  const sel = literal(selector)
  return `(() => {
    const el = document.querySelector(${sel})
    if (!el) return false
    el.focus()
    if (typeof el.select === 'function') el.select()
    else {
      const range = document.createRange()
      range.selectNodeContents(el)
      const selection = window.getSelection()
      if (selection) { selection.removeAllRanges(); selection.addRange(range) }
    }
    return true
  })()`
}
