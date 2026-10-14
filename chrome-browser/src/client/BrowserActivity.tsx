/**
 * Chrome status chip: the one place the user can see, without reading the
 * transcript, whether the plugin can drive their browser and what it is doing
 * with it right now.
 *
 * It sits at the end of the Session header's utilities and is **always**
 * rendered — a pale idle state that is legible at a glance, and a louder one
 * only for the phases that ask for attention (a call in flight, a failure, an
 * extension that needs reloading). An indicator that appears only while a call
 * runs is not readable: those calls finish in milliseconds, so it reads as a
 * flicker rather than as information.
 * @module @liyuera/dsh-chrome-browser/client/activity-strip
 */

import React, { useEffect, useState } from 'react'
import { CHROME_ICON_SRC } from './chrome-icon.ts'
import { readChromeActivity } from './activity.ts'
import type { ActivityInfo, ActivityPhase } from './activity.ts'

/** Poll interval while the chip is mounted; the host caches for slightly less. */
const POLL_MS = 1000

/**
 * Human labels for the tool a phase belongs to. A tool with no label shows its
 * wire name, so adding a tool never leaves the chip blank.
 */
const TOOL_LABELS: Record<string, string> = {
  chrome_tabs: '列出标签页',
  chrome_read: '读取页面',
  chrome_navigate: '导航',
  chrome_open: '打开标签页',
  chrome_close: '关闭标签页',
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

/** What each phase says, and what a reader who wants more gets on hover. */
const PHASES: Record<ActivityPhase, { text: string; hint: string }> = {
  offline: { text: 'Chrome 未连接', hint: '扩展没有连上。检查 chrome://extensions 里 dsh Chrome Control 是否已加载。' },
  stale: { text: '扩展待更新', hint: '扩展在跑旧文件，插件正在请它重载；若一直如此，手动重新加载一次扩展。' },
  running: { text: '工作中', hint: '正在操作你的 Chrome。' },
  done: { text: '完成', hint: '上一次调用已完成。' },
  error: { text: '失败', hint: '上一次调用失败。' },
  ready: { text: 'Chrome 就绪', hint: '扩展已连接，空闲中。' },
}

/** Props every Session-header utility receives. */
export interface BrowserActivityProps {
  sessionId: string
}

/** Only the pulse needs a stylesheet; every size is inline on purpose. */
const STYLE_ID = 'dsh-chrome-browser-activity'
const PULSE_CSS = '@keyframes cb-pulse { 0%, 100% { opacity: .25 } 50% { opacity: 1 } }'

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = PULSE_CSS
  document.head.appendChild(style)
}

/** The colour each phase draws its dot and its text in. */
const PHASE_COLOR: Record<ActivityPhase, { dot: string; ink?: string }> = {
  ready: { dot: 'var(--dsw-alias-state-success-primary)', ink: 'var(--dsw-alias-label-secondary)' },
  offline: { dot: 'var(--dsw-alias-state-idle-primary)' },
  stale: { dot: 'var(--dsw-alias-state-warn-primary)', ink: 'var(--dsw-alias-state-warn-primary)' },
  running: { dot: 'var(--dsw-alias-state-success-primary)', ink: 'var(--dsw-alias-label-primary)' },
  done: { dot: 'var(--dsw-alias-state-success-primary)', ink: 'var(--dsw-alias-state-success-primary)' },
  error: { dot: 'var(--dsw-alias-state-error-primary)', ink: 'var(--dsw-alias-state-error-primary)' },
}

/**
 * Sizes that must hold whatever the surrounding header does.
 *
 * These are inline rather than a rule set: the chip carries this plugin's own
 * 512px artwork, and a stylesheet that fails to apply does not degrade it to a
 * plain label — it renders the raw icon at full size and takes the header with
 * it. Measured, not assumed.
 */
const CHIP_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '1px 8px 1px 6px',
  borderRadius: 999,
  fontSize: 12,
  lineHeight: '18px',
  height: 22,
  maxHeight: 22,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  flex: 'none',
  border: '1px solid transparent',
  color: 'var(--dsw-alias-label-secondary)',
}

const ICON_STYLE: React.CSSProperties = { width: 13, height: 13, flex: 'none', opacity: 0.75 }

/** The words one phase shows, given the call it belongs to. */
function wording(state: ActivityInfo): { text: string; hint: string } {
  const phase = PHASES[state.phase]
  const label = state.tool === undefined ? undefined : TOOL_LABELS[state.tool] ?? state.tool
  if (state.phase === 'running' && label !== undefined) {
    return { text: label, hint: `${phase.hint}${label}${state.tabId === undefined ? '' : ` · 标签页 ${state.tabId}`}` }
  }
  if (state.phase === 'error') {
    return { text: phase.text, hint: state.detail === undefined ? phase.hint : `上一次调用失败:${state.detail}` }
  }
  return { text: phase.text, hint: phase.hint }
}

/**
 * Render the persistent Chrome status chip.
 * @param props - the header utility's session identity.
 * @returns the chip.
 */
export function BrowserActivity({ sessionId }: BrowserActivityProps): React.ReactElement {
  const [state, setState] = useState<ActivityInfo>({ phase: 'ready' })

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

  const { text, hint } = wording(state)
  const color = PHASE_COLOR[state.phase]
  return (
    <span
      className="cb-status"
      data-phase={state.phase}
      role="status"
      aria-live="polite"
      title={hint}
      style={{ ...CHIP_STYLE, ...(color.ink === undefined ? {} : { color: color.ink }) }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          flex: 'none',
          background: color.dot,
          opacity: state.phase === 'ready' ? 0.55 : 1,
          ...(state.phase === 'running' ? { animation: 'cb-pulse 1.2s ease-in-out infinite' } : {}),
        }}
      />
      <img src={CHROME_ICON_SRC} alt="" aria-hidden="true" style={ICON_STYLE} />
      <span>{text}</span>
      {state.phase !== 'running' || state.tabId === undefined ? null : <span style={{ opacity: 0.7 }}>标签页 {state.tabId}</span>}
    </span>
  )
}
