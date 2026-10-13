/**
 * Browser tab selector for the composer dock (the full-width row above the
 * input card). Multi-select; the platform select-style list (same surface /
 * text / hover tokens as the settings agent-preset picker) is rendered with
 * a fixed height and internal scroll, anchored to its trigger (opens
 * upward). The input box is never touched and no message content is
 * modified: the whole selection is bound host-side per session and reported
 * to the model through chrome_tabs (`session.tabs`); the tool default is the
 * first selected tab.
 * @module @liyuera/dsh-chrome-browser/client/tab-picker
 */

import React from 'react'
import { IconCheckOutlineRegular, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { CHROME_ICON_SRC } from './chrome-icon.ts'

/** One live tab as the host describes it. */
export interface TabInfo {
  id: string
  title: string
  url: string
  active: boolean
  favicon: string
}

/** Composer-dock props: session identity (selection rides the host binding). */
export interface TabPickerProps {
  sessionId: string
}

/** Host route answer (ok/error shaped). */
interface HostAnswer {
  ok: boolean
  error?: string
  tabs?: TabInfo[]
  tab?: TabInfo
  selected?: { tabId: string; tabIds: string[]; title: string; url: string; favicon: string } | null
}

/** Fixed list height with internal scroll; width follows the dock card. */
const LIST_HEIGHT = 340

/** Plugin-owned list stylesheet (component-scoped, inserted once). */
const STYLE_ID = 'dsh-chrome-browser-tab-list'
const LIST_CSS = `
.cb-tab-list {
  box-sizing: border-box;
  background: var(--dsw-specific-tip);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  box-shadow: 0 8px 30px #0005;
  padding: 4px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.cb-tab-list .cb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 5px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
  text-align: left;
}
.cb-tab-list .cb-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.cb-tab-list .cb-row.cb-selected { background: var(--dsw-alias-interactive-bg-hover); }
.cb-tab-list .cb-row.cb-disabled { opacity: 0.4; cursor: not-allowed; }
.cb-tab-list .cb-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cb-tab-list .cb-check { flex: none; }
.cb-tab-list { scrollbar-width: none; }
.cb-tab-list::-webkit-scrollbar { display: none; }
`

/** Hide a broken favicon image (onError handler). */
function hideBrokenIcon(event: React.SyntheticEvent<HTMLImageElement>): void {
  event.currentTarget.style.display = 'none'
}

/** First letter of a title/url as the favicon fallback glyph. */
function fallbackGlyph(tab: { title: string; url: string }): string {
  const source = (tab.title || tab.url).trim()
  return source === '' ? '🌐' : Array.from(source)[0] ?? '🌐'
}

/** One 16px favicon with a text fallback when the image cannot load. */
function Favicon({ url, fallback }: { url: string | undefined; fallback: string }) {
  if (url === undefined || url === '') {
    return React.createElement('span', { style: { width: 16, textAlign: 'center', fontSize: 11 } }, fallback)
  }
  return React.createElement('img', {
    src: url,
    width: 16,
    height: 16,
    style: { borderRadius: 3, objectFit: 'contain' },
    onError: hideBrokenIcon,
    referrerPolicy: 'no-referrer',
  })
}

/** Google Chrome app icon (the user-provided PNG, embedded as a data URI). */
function ChromeIcon({ size }: { size: number }) {
  return React.createElement('img', {
    src: CHROME_ICON_SRC,
    width: size,
    height: size,
    'aria-hidden': true,
    style: { borderRadius: 3, objectFit: 'contain' },
  })
}

/** Fixed-position the list above the card, exactly as wide as the card, clamped 12px. */
function listPosition(card: HTMLElement | null): { left: number; top: number; width: number } {
  const margin = 12
  const vw = window.innerWidth
  const vh = window.innerHeight
  const rect = card?.getBoundingClientRect() ?? { left: vw / 2, top: vh / 2, right: vw / 2, width: 400 }
  const width = Math.min(rect.width, vw - margin * 2)
  const height = Math.min(LIST_HEIGHT, vh - margin * 2)
  const left = Math.min(Math.max(rect.left, margin), vw - width - margin)
  const top = Math.min(Math.max(rect.top - height - 14, margin), vh - height - margin)
  return { left, top, width }
}

/**
 * The dock tab selector: chips for the selected tabs (multi), a fixed-height
 * scrollable list anchored to the card. Selection is bound host-side only.
 * @param props - session identity.
 */
export function TabPicker(props: TabPickerProps) {
  const [tabs, setTabs] = React.useState<TabInfo[] | null>(null)
  const [selectedIds, setSelectedIds] = React.useState<string[]>([])
  const [error, setError] = React.useState<string | undefined>(undefined)
  const [open, setOpen] = React.useState(false)
  const [position, setPosition] = React.useState<{ left: number; top: number; width: number } | null>(null)
  const cardRef = React.useRef<HTMLDivElement | null>(null)
  const listRef = React.useRef<HTMLDivElement | null>(null)

  const selectedTabs = (tabs ?? []).filter(tab => selectedIds.includes(tab.id))

  // Plugin-owned stylesheet (once, per page); removed on unmount.
  React.useEffect(() => {
    if (document.getElementById(STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = LIST_CSS
    document.head.appendChild(style)
    return () => {
      document.getElementById(STYLE_ID)?.remove()
    }
  }, [])

  const refresh = React.useCallback(async () => {
    setError(undefined)
    setTabs(null)
    try {
      const response = await fetch('/chrome-browser/tabs', { method: 'POST' })
      const body = await response.json() as HostAnswer
      if (body.ok !== true) {
        setError(body.error ?? '无法列出标签页')
        return
      }
      setTabs(body.tabs ?? [])
    } catch (caught) {
      setError(String(caught))
    }
  }, [])

  const loadState = React.useCallback(async () => {
    try {
      const response = await fetch(`/chrome-browser/state?sessionId=${encodeURIComponent(props.sessionId)}`)
      const body = await response.json() as HostAnswer
      if (body.ok === true && body.selected !== null && body.selected !== undefined) {
        setSelectedIds(Array.isArray(body.selected.tabIds) && body.selected.tabIds.length > 0
          ? body.selected.tabIds
          : [body.selected.tabId])
      }
    } catch {
      // The browser may not be connected; the selector simply stays empty.
    }
  }, [props.sessionId])

  React.useEffect(() => {
    // The shell may reuse one component instance across session views: clear
    // the previous session's selection synchronously, then restore this
    // session's own binding (each session keeps an independent selection).
    setSelectedIds([])
    // Restore the selection AND fetch the tab list, so the chips (title +
    // favicon) render right after a page refresh, not only after opening the
    // menu for the first time.
    void loadState()
    void refresh()
  }, [loadState, refresh])

  // Position the list when opening; re-measure on resize/scroll while open.
  React.useEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const place = () => setPosition(listPosition(cardRef.current))
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // Outside click and Escape close the list (the list may be portaled into
  // the body, so check both the trigger and the list element).
  React.useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (cardRef.current?.contains(target) === true) return
      if (listRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  /** Bind the whole selection host-side (first tab is the tool default). */
  const syncHost = (next: readonly TabInfo[]): void => {
    if (next.length === 0) return
    void fetch('/chrome-browser/select', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: props.sessionId, tabIds: next.map(tab => tab.id) }),
    }).catch(() => { /* binding is best-effort */ })
  }

  const applySelection = (next: readonly TabInfo[]): void => {
    setSelectedIds(next.map(tab => tab.id))
    syncHost(next)
  }

  const toggle = (id: string): void => {
    const current = (tabs ?? []).filter(tab => selectedIds.includes(tab.id))
    const target = (tabs ?? []).find(tab => tab.id === id)
    if (target === undefined) return
    const next = current.some(tab => tab.id === id)
      ? current.filter(tab => tab.id !== id)
      : [...current, target]
    applySelection(next)
  }

  const remove = (id: string): void => {
    applySelection((tabs ?? []).filter(tab => selectedIds.includes(tab.id)).filter(tab => tab.id !== id))
  }

  const summary = selectedIds.length === 0
    ? '选择浏览器标签页'
    : `${selectedIds.length} 个标签页`

  interface ListRow {
    id: string
    label: string
    disabled?: boolean
    icon?: string
  }
  const rows: ListRow[] = error !== undefined
    ? [{ id: '__error', label: error, disabled: true }]
    : tabs === null
      ? [{ id: '__loading', label: '正在列出你的 Chrome 标签页…', disabled: true }]
      : tabs.length === 0
        ? [{ id: '__empty', label: '没有可用标签页', disabled: true }]
        : tabs.map(tab => ({ id: tab.id, label: tab.title === '' ? tab.url : tab.title, icon: tab.favicon, disabled: false }))

  return React.createElement(
    'div',
    {
      ref: cardRef,
      style: {
        // Dock-card convention (shared with the todo/goal dock entries):
        // the visible card aligns with the composer card via the same
        // clearance/inset variables and margin auto.
        boxSizing: 'border-box',
        flex: 'none',
        overflow: 'hidden',
        margin: '0 auto',
        width: 'calc(100% - var(--dsh-composer-side-clearance) * 2 - var(--dsh-composer-dock-inset) * 4)',
        maxWidth: 'calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) * 4)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
        background: 'var(--dsw-specific-tip)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        minWidth: 0,
        fontSize: 12,
        padding: '6px 12px',
        cursor: 'pointer',
      },
      onClick: () => {
        setOpen(!open)
        if (!open) void refresh()
      },
      title: '选择浏览器标签页(发送给 AI)',
    },
    React.createElement(ChromeIcon, { size: 16 }),
    selectedTabs.map(tab => React.createElement(
      'span',
      {
        key: tab.id,
        onClick: (event: React.MouseEvent<HTMLSpanElement>) => event.stopPropagation(),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          border: '1px solid #8884',
          borderRadius: 999,
          padding: '2px 6px',
          maxWidth: 260,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
        },
      },
      React.createElement(Favicon, { url: tab.favicon, fallback: fallbackGlyph(tab) }),
      React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, tab.title === '' ? tab.url : tab.title),
      React.createElement('button', {
        type: 'button',
        style: { border: 'none', background: 'none', cursor: 'pointer', padding: 0, fontSize: 11, opacity: 0.7 },
        title: '移除',
        onClick: (event: React.MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); remove(tab.id) },
      }, '×'),
    )),
    React.createElement(
      'span',
      {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: 0,
          marginLeft: 'auto',
          fontSize: 12,
          color: 'inherit',
          userSelect: 'none',
        },
      },
      summary,
      React.createElement(IconChevronDownOutlineRegular, { size: 14 }),
    ),
    open && position !== null
      ? React.createElement(
        'div',
        {
          ref: listRef,
          className: 'cb-tab-list',
          role: 'menu',
          style: { position: 'fixed', left: position.left, top: position.top, width: position.width, height: LIST_HEIGHT, zIndex: 1100 },
        },
        rows.map(row => React.createElement(
          'button',
          {
            key: row.id,
            type: 'button',
            role: 'menuitem',
            className: `cb-row${selectedIds.includes(row.id) ? ' cb-selected' : ''}${row.disabled === true ? ' cb-disabled' : ''}`,
            disabled: row.disabled,
            onMouseDown: (event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault(),
            // stopPropagation: the row lives INSIDE the card, whose own
            // onClick toggles the menu — a row click must not re-toggle it.
            onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
              event.stopPropagation()
              if (!row.disabled && !row.id.startsWith('__')) toggle(row.id)
            },
          },
          React.createElement(Favicon, { url: row.icon, fallback: '🌐' }),
          React.createElement('span', { className: 'cb-title' }, row.label),
          selectedIds.includes(row.id)
            ? React.createElement('span', { className: 'cb-check' }, React.createElement(IconCheckOutlineRegular, { size: 16 }))
            : null,
        )),
      )
      : null,
  )
}
