/**
 * Browser-side tab catalog: `POST /chrome-browser/tabs` behind a short cache.
 *
 * The `@` source asks for candidates on every keystroke, so the cache is what
 * keeps one typed word from becoming one host round-trip per character; a
 * failed listing is held for the same window, so an unreachable browser costs
 * one logged request instead of one per keystroke.
 * @module @liuyera/dsh-chrome-browser/client/tab-catalog
 */

import type { TabInfo } from './TabPicker.tsx'

/** How long one listing (successful or failed) stays fresh. */
const CACHE_MS = 2000

/** Host answer for the tabs route. */
interface TabsAnswer {
  ok: boolean
  error?: string
  tabs?: TabInfo[]
}

/** Timestamp of the stored listing. */
let cachedAt = 0
/** Last listing; empty while the browser is unreachable. */
let cached: readonly TabInfo[] = []
/** One request at a time, shared by concurrent callers. */
let inflight: Promise<readonly TabInfo[]> | null = null

/** Fetch one listing, store it, and answer the empty list on any failure. */
async function fetchTabs(): Promise<readonly TabInfo[]> {
  try {
    const response = await fetch('/chrome-browser/tabs', { method: 'POST' })
    const body = await response.json() as TabsAnswer
    if (body.ok !== true) throw new Error(body.error ?? 'listing tabs failed')
    cached = body.tabs ?? []
  } catch (error) {
    // The menu simply shows no tab group; the extension status route and the
    // plugin README own telling the user why the browser is unreachable.
    cached = []
    console.error('[chrome-browser] listing tabs failed:', error)
  }
  cachedAt = Date.now()
  return cached
}

/**
 * List the live Chrome tabs.
 * @param signal - superseded when the query changes or the menu closes; a
 *   request already in flight still settles the shared cache.
 * @returns the tabs, or an empty list while the browser is unreachable.
 */
export async function listChromeTabs(signal: AbortSignal): Promise<readonly TabInfo[]> {
  if (signal.aborted) return cached
  if (Date.now() - cachedAt < CACHE_MS) return cached
  inflight ??= fetchTabs().finally(() => { inflight = null })
  return inflight
}
