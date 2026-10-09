/**
 * The `@` tab source: what one row shows, and what picking it does.
 *
 * The source is driven directly — it is a pure function of its injected tab
 * list — so these specs assert the two claims the composer menu depends on:
 * every row carries the tab's URL beside its title, and a pick inserts a
 * reference chip without touching the host.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CandidateRequest, ClientSessionContext, InputTriggerCandidate, InputTriggerPick } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {
  CANDIDATE_LIMIT, CHROME_TAB_SOURCE_NAME, CHROME_TAB_SOURCE_ORDER, TAB_SECTION,
  createChromeTabSource,
} from '../src/client/tab-source.ts'

/** Tabs as the bridge reports them: titled, untitled, and one without a favicon. */
const TABS = [
  { id: '7', title: '任务管理-列表', url: 'http://192.168.2.84/task/list', active: true, favicon: 'https://a/fav.ico' },
  { id: '8', title: ' 金融保险-蓝湖 ', url: 'https://lanhuapp.com/x', active: false, favicon: '' },
  { id: '9', title: '', url: 'https://example.com/untitled', active: false, favicon: 'https://a/fav.ico' },
]

/** The session projection a candidate request carries (unused by this source). */
const SESSION = { sessionId: 'session-1' } as ClientSessionContext

/** One candidate request for a query. */
function request(query: string): CandidateRequest {
  return { query, position: 'inline', drilled: false, signal: new AbortController().signal }
}

/** One settling pick over a rendered row. */
function pick(candidate: InputTriggerCandidate): InputTriggerPick {
  return {
    candidate,
    session: SESSION,
    position: 'inline',
    via: 'menu',
    action: 'pick',
    span: { start: 0, end: 2, draftRev: 1 },
  }
}

/** Source over a fake tab listing. */
function bench(tabs = TABS) {
  const icon = (): null => null
  const listTabs = vi.fn(async () => tabs)
  return { source: createChromeTabSource({ listTabs, iconFor: () => icon }), listTabs }
}

describe('chrome tab @ source', () => {
  it('lists every tab with its URL beside the title', async () => {
    const { source } = await bench()
    const rows = await source.candidates(SESSION, request(''))
    expect(rows).toHaveLength(3)
    expect(rows[0]?.label).toBe('任务管理-列表')
    expect(rows[0]?.name).toBe('任务管理-列表')
    expect(rows[0]?.description).toBe('http://192.168.2.84/task/list')
    expect(rows[0]?.section).toBe(TAB_SECTION)
    expect(rows[0]?.value).toBe('7')
    expect(rows[0]?.icon).toBeTypeOf('function')
    // A title padded by the page still renders trimmed.
    expect(rows[1]?.label).toBe('金融保险-蓝湖')
    expect(rows[1]?.description).toBe('https://lanhuapp.com/x')
  })

  it('shows an untitled tab by its URL, once', async () => {
    const { source } = await bench()
    const rows = await source.candidates(SESSION, request(''))
    expect(rows[2]?.label).toBe('https://example.com/untitled')
    expect(rows[2]?.description).toBeUndefined()
  })

  it('filters by title and by URL, on the signal the menu supersedes', async () => {
    const { source, listTabs } = await bench()
    const req = request('蓝湖')
    expect((await source.candidates(SESSION, req)).map(row => row.value)).toEqual(['8'])
    expect((await source.candidates(SESSION, request('192.168'))).map(row => row.value)).toEqual(['7'])
    expect(await source.candidates(SESSION, request('nothing-matches'))).toEqual([])
    expect(listTabs).toHaveBeenCalledWith(req.signal)
  })

  it('caps the rows one query renders', async () => {
    const many = Array.from({ length: CANDIDATE_LIMIT + 10 }, (_, index) => ({
      id: String(index), title: `tab ${String(index)}`, url: `https://example.com/${String(index)}`, active: false, favicon: '',
    }))
    const { source } = await bench(many)
    expect(await source.candidates(SESSION, request(''))).toHaveLength(CANDIDATE_LIMIT)
  })

  it('inserts a chip carrying the mention the transcript projects as a reference', async () => {
    const { source, listTabs } = await bench()
    const rows = await source.candidates(SESSION, request(''))
    const callsAfterListing = listTabs.mock.calls.length
    const outcome = source.onPick(pick(rows[0] as InputTriggerCandidate))
    expect(outcome).toEqual({
      insert: {
        source: CHROME_TAB_SOURCE_NAME,
        // The identity is the tab id: two open tabs may share a title.
        ref: '7',
        label: '任务管理-列表',
        // The quoted form is what keeps a titled token with spaces one token.
        clipboardText: '@"任务管理-列表"',
      },
    })
    // No session binding: the pick is local to the draft it lands in.
    expect(listTabs.mock.calls).toHaveLength(callsAfterListing)
  })

  it('inserts nothing for a row whose tab is gone', async () => {
    const { source } = await bench()
    const rows = await source.candidates(SESSION, request(''))
    const stale: InputTriggerCandidate = { ...rows[0] as InputTriggerCandidate, value: 'closed-tab' }
    expect(source.onPick(pick(stale))).toBeUndefined()
  })

  it('serializes a picked chip into the mention alone', async () => {
    const { source } = await bench()
    const rows = await source.candidates(SESSION, request(''))
    source.onPick(pick(rows[0] as InputTriggerCandidate))
    // The URL and id ride the host's context message; the user's own message
    // keeps the reference the bubble renders.
    await expect(source.codec?.serialize('7', new AbortController().signal))
      .resolves.toBe('@"任务管理-列表"')
    expect(source.codec?.clipboardText('7')).toBe('@"任务管理-列表"')
  })

  it('gives each of two same-titled tabs its own identity', async () => {
    // The user's own tab set repeats titles; a chip must cite the tab that was
    // picked, not whichever tab the listing happened to key last.
    const { source } = await bench([
      { id: '4', title: '星瞰河山一体化平台', url: 'https://ecard.htwisdom.cn/TEAMS-364', active: false, favicon: '' },
      { id: '5', title: '星瞰河山一体化平台', url: 'https://ecard.htwisdom.cn/XKSZ-611', active: false, favicon: '' },
    ])
    const rows = await source.candidates(SESSION, request(''))
    const outcome = source.onPick(pick(rows[0] as InputTriggerCandidate))
    expect((outcome as { insert: { ref: string } }).insert.ref).toBe('4')
    // The mention is the shared title; the host lists both open tabs under it.
    await expect(source.codec?.serialize('4', new AbortController().signal))
      .resolves.toBe('@"星瞰河山一体化平台"')
    await expect(source.codec?.serialize('5', new AbortController().signal))
      .resolves.toBe('@"星瞰河山一体化平台"')
  })

  it('quotes a title with spaces and drops characters that would end the token', async () => {
    const { source } = await bench([
      { id: '3', title: ' 他说 "你好" \n 世界 ', url: 'https://example.com/a', active: false, favicon: '' },
    ])
    const rows = await source.candidates(SESSION, request(''))
    const outcome = source.onPick(pick(rows[0] as InputTriggerCandidate))
    const inserted = (outcome as { insert: { clipboardText: string, label: string } }).insert
    expect(inserted.clipboardText).toBe('@"他说 你好 世界"')
    // The chip's display label stays the tab's own title.
    expect(inserted.label).toBe('他说 "你好" \n 世界')
    await expect(source.codec?.serialize('3', new AbortController().signal))
      .resolves.toBe('@"他说 你好 世界"')
  })

  it('mentions an untitled tab by its URL', async () => {
    const { source } = await bench()
    const rows = await source.candidates(SESSION, request(''))
    source.onPick(pick(rows[2] as InputTriggerCandidate))
    expect(source.codec?.clipboardText('9')).toBe('@"https://example.com/untitled"')
    await expect(source.codec?.serialize('9', new AbortController().signal))
      .resolves.toBe('@"https://example.com/untitled"')
  })

  it('keeps a picked chip a reference after its tab leaves the listing', async () => {
    const { source } = await bench()
    const rows = await source.candidates(SESSION, request(''))
    source.onPick(pick(rows[0] as InputTriggerCandidate))
    // A later listing no longer carries the tab: the chip keeps the mention the
    // user saw, and only a chip this page never picked falls back to its id.
    await source.candidates(SESSION, request(''))
    await expect(source.codec?.serialize('7', new AbortController().signal))
      .resolves.toBe('@"任务管理-列表"')
    await expect(source.codec?.serialize('closed-tab', new AbortController().signal))
      .resolves.toBe('@"closed-tab"')
  })

  it('keeps a chip whose tab left the listing a usable reference', async () => {
    // A chip this page never picked (a draft restored from elsewhere) still
    // renders as a reference and still names an id.
    const { source } = await bench()
    await source.candidates(SESSION, request(''))
    await expect(source.codec?.serialize('closed-tab', new AbortController().signal))
      .resolves.toBe('@"closed-tab"')
    expect(source.codec?.clipboardText('closed-tab')).toBe('@"closed-tab"')
  })

  it('always emits a mention the transcript reads as one token', async () => {
    // The bubble projects `@"..."` tokens (ui-primitives' `projectUserText`),
    // so nothing inside the quotes may end the token early — and the whole
    // mention must stay one whitespace-free token.
    const titles = ['任务管理 - 列表', '他说 "你好" 世界', 'a\nb', '  ', '导航/任务管理', '🎉 面板']
    for (const title of titles) {
      const { source } = await bench([
        { id: '1', title, url: 'https://example.com/x', active: false, favicon: '' },
      ])
      const rows = await source.candidates(SESSION, request(''))
      const inserted = source.onPick(pick(rows[0] as InputTriggerCandidate)) as { insert: { clipboardText: string } }
      expect(inserted.insert.clipboardText).toMatch(/^@"[^"\n]+"$/u)
    }
  })

  it('sits above the saved-prompt group in the @ menu', async () => {
    const { source } = await bench()
    expect(source.name).toBe(CHROME_TAB_SOURCE_NAME)
    expect(source.trigger).toBe('@')
    expect(source.order).toBe(CHROME_TAB_SOURCE_ORDER)
    // The saved-prompt source declares -100; a lower order renders above it.
    expect(CHROME_TAB_SOURCE_ORDER).toBeLessThan(-100)
  })
})
