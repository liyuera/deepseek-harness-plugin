/**
 * Memory bounds of console capture. The point of these tests is quantitative:
 * whatever a page logs and for however long, the retained text stays under a
 * constant the plugin chose, not one the page chose.
 */
import { describe, expect, it } from 'vitest'
import {
  capMessage,
  ConsoleLog,
  MAX_CHARS,
  MAX_ENTRIES,
  MAX_ENTRY_CHARS,
  MAX_TABS,
} from '../src/console-log.ts'

/** One plain message. */
function line(text: string): { level: string; text: string } {
  return { level: 'log', text }
}

describe('capMessage', () => {
  it('leaves a short message alone', () => {
    expect(capMessage('hello')).toBe('hello')
  })

  it('keeps the head of a long message and marks it', () => {
    const capped = capMessage('x'.repeat(MAX_ENTRY_CHARS + 100))
    expect(capped.startsWith('x'.repeat(MAX_ENTRY_CHARS))).toBe(true)
    expect(capped).toContain('[truncated]')
    expect(capped.length).toBe(MAX_ENTRY_CHARS + '…[truncated]'.length)
  })
})

describe('capture scope', () => {
  it('ignores a tab that is not captured', () => {
    const log = new ConsoleLog()
    expect(log.append('1', line('before track'))).toBe(false)
    expect(log.read('1')).toBeUndefined()
  })

  it('stops retaining once a tab is released', () => {
    const log = new ConsoleLog()
    log.track('1')
    log.append('1', line('kept'))
    log.release('1')
    expect(log.append('1', line('after release'))).toBe(false)
    expect(log.read('1')).toBeUndefined()
  })

  it('keeps an already-captured tab\u2019s window when capture is re-armed', () => {
    const log = new ConsoleLog()
    log.track('1')
    log.append('1', line('first'))
    expect(log.track('1')).toBeUndefined()
    expect(log.read('1')?.retained).toBe(1)
  })

  it(`captures at most ${MAX_TABS} tabs, releasing the least recently used`, () => {
    const log = new ConsoleLog()
    for (let index = 0; index < MAX_TABS; index += 1) log.track(String(index))
    // Touch tab 0 so tab 1 becomes the least recently used.
    log.track('0')
    expect(log.track('new')).toBe('1')
    expect(log.tracked()).toEqual(['new', '0', '4', '3', '2'])
    expect(log.tracks('1')).toBe(false)
  })
})

describe('memory bounds', () => {
  it('drops the oldest entries past the count cap', () => {
    const log = new ConsoleLog()
    log.track('1')
    for (let index = 0; index < MAX_ENTRIES + 50; index += 1) log.append('1', line(`line ${index}`))
    const page = log.read('1')!
    expect(page.retained).toBe(MAX_ENTRIES)
    expect(page.dropped).toBe(50)
    expect(page.entries[0]?.text).toBe('line 50')
  })

  it('drops the oldest entries past the text budget even when the count cap allows them', () => {
    const log = new ConsoleLog()
    log.track('1')
    // Each message is at the per-entry cap, so the count cap of MAX_ENTRIES
    // would allow far more text than MAX_CHARS: the byte budget must bind.
    for (let index = 0; index < MAX_ENTRIES; index += 1) {
      log.append('1', line(String(index).padStart(4, '0') + 'x'.repeat(MAX_ENTRY_CHARS - 4)))
    }
    const page = log.read('1')!
    expect(log.retainedChars).toBeLessThanOrEqual(MAX_CHARS)
    expect(page.retained).toBeLessThan(MAX_ENTRIES)
    expect(page.retained).toBe(Math.floor(MAX_CHARS / MAX_ENTRY_CHARS))
    expect(page.dropped).toBe(MAX_ENTRIES - page.retained)
  })

  it('keeps the head of one oversized message instead of clearing the buffer', () => {
    const log = new ConsoleLog()
    log.track('1')
    log.append('1', line('kept'))
    log.append('1', line('y'.repeat(10 * 1024 * 1024)))
    const page = log.read('1')!
    expect(page.retained).toBe(2)
    expect(page.dropped).toBe(0)
    expect(page.entries[0]?.text).toBe('kept')
    expect(page.entries[1]?.text.length).toBe(MAX_ENTRY_CHARS + '…[truncated]'.length)
    expect(log.retainedChars).toBeLessThanOrEqual(MAX_CHARS)
  })

  it('holds the ceiling against a loop that never stops logging', () => {
    const log = new ConsoleLog()
    log.track('1')
    for (let index = 0; index < 100_000; index += 1) log.append('1', line('x'.repeat(1024)))
    // 100k messages of 1 KB is ~200 MB of input; the buffer holds its budget.
    expect(log.retainedChars).toBeLessThanOrEqual(MAX_CHARS)
    expect(log.read('1')?.retained).toBeLessThanOrEqual(MAX_ENTRIES)
  })

  it('releases the buffer of a tab that fell out of the tab cap', () => {
    const log = new ConsoleLog()
    log.track('1')
    log.append('1', line('x'.repeat(MAX_ENTRY_CHARS)))
    for (let index = 2; index <= MAX_TABS + 1; index += 1) log.track(String(index))
    expect(log.tracks('1')).toBe(false)
    expect(log.retainedChars).toBe(0)
  })
})

describe('reading', () => {
  it('returns every retained entry for a fresh cursor, oldest first', () => {
    const log = new ConsoleLog()
    log.track('1')
    log.append('1', line('a'))
    log.append('1', line('b'))
    const page = log.read('1')!
    expect(page.entries.map(entry => entry.text)).toEqual(['a', 'b'])
    expect(page.cursor).toBe(2)
  })

  it('continues from the cursor without repeating entries', () => {
    const log = new ConsoleLog()
    log.track('1')
    log.append('1', line('a'))
    const first = log.read('1')!
    log.append('1', line('b'))
    const second = log.read('1', { since: first.cursor })!
    expect(second.entries.map(entry => entry.text)).toEqual(['b'])
    expect(second.retained).toBe(2)
  })

  it('keeps the most recent entries when a limit truncates the window', () => {
    const log = new ConsoleLog()
    log.track('1')
    for (let index = 0; index < 10; index += 1) log.append('1', line(String(index)))
    const page = log.read('1', { limit: 3 })!
    expect(page.entries.map(entry => entry.text)).toEqual(['7', '8', '9'])
    expect(page.cursor).toBe(10)
  })

  it('returns an empty page rather than undefined when nothing is new', () => {
    const log = new ConsoleLog()
    log.track('1')
    log.append('1', line('a'))
    const page = log.read('1', { since: 1 })!
    expect(page.entries).toEqual([])
    expect(page.cursor).toBe(1)
  })

  it('carries the level, timestamp and call site through', () => {
    const log = new ConsoleLog()
    log.track('1')
    log.append('1', { level: 'error', text: 'boom', source: 'https://e.test/app.js:7', at: 1234 })
    expect(log.read('1')?.entries[0]).toEqual({
      seq: 1, at: 1234, level: 'error', text: 'boom', source: 'https://e.test/app.js:7',
    })
  })
})

describe('clear', () => {
  it('empties the window but keeps capturing, with the cursor still advancing', () => {
    const log = new ConsoleLog()
    log.track('1')
    log.append('1', line('a'))
    log.append('1', line('b'))
    expect(log.clear('1')).toBe(true)
    expect(log.read('1')?.entries).toEqual([])
    log.append('1', line('c'))
    const page = log.read('1', { since: 2 })!
    expect(page.entries.map(entry => entry.text)).toEqual(['c'])
    expect(page.dropped).toBe(0)
  })

  it('reports an uncaptured tab', () => {
    expect(new ConsoleLog().clear('1')).toBe(false)
  })
})

describe('releaseAll', () => {
  it('frees every buffer', () => {
    const log = new ConsoleLog()
    log.track('1')
    log.track('2')
    log.append('1', line('x'))
    log.releaseAll()
    expect(log.tracked()).toEqual([])
    expect(log.retainedChars).toBe(0)
  })
})
