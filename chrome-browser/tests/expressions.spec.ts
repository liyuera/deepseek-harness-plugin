import { describe, expect, it } from 'vitest'
import {
  clickExpression,
  focusAndSelectExpression,
  focusExpression,
  readPageExpression,
  readyStateExpression,
  viewportExpression,
} from '../src/expressions.ts'

describe('clickExpression', () => {
  // Behaviour lives in tests/click-outcome.spec.ts, which runs this expression
  // against a stub document; here we only pin how the source is assembled.
  it('interpolates the selector and targets only the first match by default', () => {
    const expression = clickExpression('#submit', false)
    expect(expression).toContain('document.querySelectorAll("#submit")')
    expect(expression).toContain('matched.length > 0 ? [matched[0]] : []')
    expect(expression).toContain('el.click()')
  })

  it('targets every match when all is set', () => {
    expect(clickExpression('a.item', true)).toContain('Array.from(matched)')
  })

  it('escapes quotes in the selector', () => {
    const expression = clickExpression(`a[data-x="it's"]`, false)
    expect(expression).toContain('"a[data-x=\\"it\'s\\"]"')
  })
})

describe('focus expressions', () => {
  it('focus-only does not select', () => {
    const expression = focusExpression('#inp')
    expect(expression).toContain('el.focus()')
    expect(expression).not.toContain('selectNodeContents')
    expect(expression).not.toContain("typeof el.select")
  })

  it('focus-and-select prefers native select and falls back to a Range', () => {
    const expression = focusAndSelectExpression('#inp')
    expect(expression).toContain('el.focus()')
    expect(expression).toContain("typeof el.select === 'function'")
    expect(expression).toContain('selectNodeContents')
  })
})

describe('readPageExpression', () => {
  it('returns title, url, text and no html by default', () => {
    const expression = readPageExpression(false)
    expect(expression).toContain('document.body.innerText')
    expect(expression).toContain('document.title')
    expect(expression).toContain('location.href')
    expect(expression).toContain(`html: ''`)
  })

  it('includes real html when asked', () => {
    expect(readPageExpression(true)).toContain('document.documentElement.outerHTML')
  })
})

describe('misc expressions', () => {
  it('reports viewport size', () => {
    const expression = viewportExpression()
    expect(expression).toContain('window.innerWidth')
    expect(expression).toContain('window.innerHeight')
  })

  it('reports document readyState', () => {
    expect(readyStateExpression()).toBe('document.readyState')
  })
})
