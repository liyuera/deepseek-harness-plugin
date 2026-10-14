/**
 * Browser activity strip: the one place the user can see, without reading the
 * transcript, that the agent is driving their browser right now.
 *
 * It renders **nothing** while the plugin is idle — a permanent badge would be
 * noise, and the per-call cards already carry the detail. When a call is in
 * flight it names the tool and the tab, so a user who looks up mid-task can
 * tell what is happening and on which page.
 * @module @liyuera/dsh-chrome-browser/client/activity-strip
 */

import React, { useEffect, useState } from 'react'
import { CHROME_ICON_SRC } from './chrome-icon.ts'
import { readChromeActivity } from './activity.ts'
import type { ActivityInfo } from './activity.ts'

/** Poll interval while the strip is mounted; the host caches for slightly less. */
const POLL_MS = 1000

/**
 * Human labels for the running call. A tool with no label shows its wire name,
 * so adding a tool never leaves the strip blank.
 */
const TOOL_LABELS: Record<string, string> = {
  chrome_tabs: '列出标签页',
  chrome_read: '读取页面',
  chrome_navigate: '导航',
  chrome_open: '打开标签页',
  chrome_screenshot: '截图',
  chrome_click: '点击',
  chrome_hover: '悬停',
  chrome_type: '输入',
  chrome_press: '按键',
  chrome_select: '选择',
  chrome_eval: '执行 JS',
  chrome_wait: '等待元素',
  chrome_console: '读取控制台',
  chrome_request_help: '等待你操作',
}

/** Props every composer-dock entry receives. */
export interface BrowserActivityProps {
  sessionId: string
}

const STYLE_ID = 'dsh-chrome-browser-activity'
const STRIP_CSS = `
.cb-activity {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px;
  padding: 3px 8px;
  width: fit-content;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-specific-tip);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
}
.cb-activity img { width: 14px; height: 14px; }
.cb-activity .cb-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: cb-pulse 1.2s ease-in-out infinite;
}
@keyframes cb-pulse { 0%, 100% { opacity: .3 } 50% { opacity: 1 } }
@media (prefers-reduced-motion: reduce) { .cb-activity .cb-dot { animation: none } }
.cb-activity .cb-activity-tab { opacity: .7 }
`

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STRIP_CSS
  document.head.appendChild(style)
}

/**
 * Render the strip while one of this plugin's tools is running.
 * @param props - the dock entry's session identity.
 * @returns the strip, or null while nothing is running.
 */
export function BrowserActivity({ sessionId }: BrowserActivityProps): React.ReactElement | null {
  const [state, setState] = useState<ActivityInfo>({ active: false })

  useEffect(() => {
    ensureStyles()
    let live = true
    const tick = async (): Promise<void> => {
      const next = await readChromeActivity(sessionId)
      if (live) setState(next)
    }
    void tick()
    const timer = setInterval(() => { void tick() }, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [sessionId])

  if (!state.active) return null
  const tool = state.tool ?? ''
  return (
    <div className="cb-activity" role="status" aria-live="polite">
      <span className="cb-dot" aria-hidden="true" />
      <img src={CHROME_ICON_SRC} alt="" aria-hidden="true" />
      <span>{TOOL_LABELS[tool] ?? tool}</span>
      {state.tabId === undefined ? null : <span className="cb-activity-tab">标签页 {state.tabId}</span>}
    </div>
  )
}
