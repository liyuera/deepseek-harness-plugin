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
 * Click expression. Returns the number of elements matched and clicked:
 * `all` clicks every match, otherwise only the first.
 */
export function clickExpression(selector: string, all: boolean): string {
  const sel = literal(selector)
  return all
    ? `(() => {
      const els = document.querySelectorAll(${sel});
      let n = 0;
      for (const el of els) { el.click(); n++ }
      return n
    })()`
    : `(() => {
      const el = document.querySelector(${sel});
      if (!el) return 0
      el.click()
      return 1
    })()`
}

/**
 * Focus-only expression for typing without replacing existing content: focuses
 * the matched element and leaves its selection untouched. Returns whether a
 * match was found.
 */
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
