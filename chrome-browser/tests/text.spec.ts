import { describe, expect, it } from 'vitest'
import { clipJson, clipText, normalizePageText, windowText } from '../src/text.ts'

describe('clipText', () => {
  it('keeps short text untouched', () => {
    expect(clipText('hello', 10)).toBe('hello')
  })

  it('clips by code points and adds a marker', () => {
    expect(clipText('abcdef', 3)).toBe('abc\n…[truncated: 6 chars total]')
  })

  it('never splits surrogate pairs', () => {
    const emoji = '😀'.repeat(20)
    const clipped = clipText(emoji, 5)
    expect(clipped.startsWith('😀'.repeat(5))).toBe(true)
    expect(clipped).toContain('[truncated')
  })
})

describe('normalizePageText', () => {
  it('collapses narrow spaces, trailing line whitespace and blank runs', () => {
    const input = '\u00a0a \n\n\n\nb\n\n'
    expect(normalizePageText(input)).toBe('a\n\nb')
  })
})

describe('windowText', () => {
  it('returns the whole text with no continuation when it fits', () => {
    expect(windowText('abcdef', 0, 10)).toEqual({ text: 'abcdef', offset: 0, total: 6 })
  })

  it('returns a window and where to continue', () => {
    expect(windowText('abcdef', 0, 4)).toEqual({ text: 'abcd', offset: 0, total: 6, nextOffset: 4 })
  })

  it('continues from an offset to the end', () => {
    expect(windowText('abcdef', 4, 4)).toEqual({ text: 'ef', offset: 4, total: 6 })
  })

  it('walks a long text window by window without losing or repeating a code point', () => {
    const text = '中'.repeat(25)
    const seen: string[] = []
    let offset = 0
    for (let guard = 0; guard < 20; guard += 1) {
      const window = windowText(text, offset, 10)
      seen.push(window.text)
      if (window.nextOffset === undefined) break
      offset = window.nextOffset
    }
    expect(seen.join('')).toBe(text)
  })

  it('clamps an offset past the end and a negative offset', () => {
    expect(windowText('abc', 99, 10)).toEqual({ text: '', offset: 3, total: 3 })
    expect(windowText('abc', -5, 2)).toEqual({ text: 'ab', offset: 0, total: 3, nextOffset: 2 })
  })

  it('never splits a surrogate pair', () => {
    const window = windowText('😀😀😀', 0, 2)
    expect(window.text).toBe('😀😀')
    expect(window.nextOffset).toBe(2)
  })
})

describe('clipJson', () => {
  it('pretty-prints and bounds the serialized value', () => {
    expect(clipJson({ a: 1 }, 1000)).toBe(JSON.stringify({ a: 1 }, null, 2))
  })

  it('truncates long output with a marker', () => {
    const out = clipJson({ value: 'x'.repeat(100) }, 50)
    expect(out.startsWith('{\n  "value": "xxx')).toBe(true)
    expect(out).toContain('…[truncated]')
  })

  it('falls back to String for non-serializable values', () => {
    const bigInt: unknown = 123n
    expect(clipJson(bigInt, 100)).toBe('123')
  })
})
