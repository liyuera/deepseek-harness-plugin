/**
 * The console capture's idle exit.
 *
 * A capture holds Chrome's debugger — and Chrome's "debugging this browser"
 * bar — until `action: stop`. A model that forgets stop would leave the bar for
 * the rest of the session, so the host releases a capture that has not been
 * read for `consoleIdleMs`. The buffer survives: the timeout ends new arrivals,
 * it does not throw away the evidence already collected.
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { BrowserBackend } from '../src/backend.ts'
import { resolveChromeConfig } from '../src/chrome.ts'
import { ConsoleLog } from '../src/console-log.ts'
import { HelpChannel } from '../src/help.ts'
import { chromeToolDefinitions } from '../src/tools.ts'

/** One `chrome_console` tool over a backend that records start/stop. */
function setup(consoleIdleMs: number): {
  tool: ToolDefinition
  consoleLog: ConsoleLog
  started: string[]
  stopped: string[]
} {
  const started: string[] = []
  const stopped: string[] = []
  const backend = {
    startConsole: async (tabId: string) => { started.push(tabId) },
    stopConsole: async (tabId: string) => { stopped.push(tabId) },
  } as unknown as BrowserBackend
  const consoleLog = new ConsoleLog()
  const found = chromeToolDefinitions(
    backend,
    resolveChromeConfig({ consoleIdleMs }),
    consoleLog,
    new HelpChannel(),
  ).find(definition => definition.name === 'chrome_console')
  if (found === undefined) throw new Error('chrome_console is not registered')
  return { tool: found, consoleLog, started, stopped }
}

/** Run one `chrome_console` action and return its JSON result. */
async function run(tool: ToolDefinition, action: string, tabId = '7'): Promise<Record<string, unknown>> {
  return await tool.execute({ action, tabId }, {} as never) as Record<string, unknown>
}

/** Wall-clock wait for the real idle timers. */
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('chrome_console idle release', () => {
  it('releases the debugger when nobody reads the capture', async () => {
    const { tool, consoleLog, stopped } = setup(60)
    await run(tool, 'start')
    consoleLog.append('7', { level: 'error', text: 'boom' })
    await sleep(120)
    expect(stopped).toEqual(['7'])

    // The entries survive: only new arrivals stop.
    const page = await run(tool, 'read')
    expect(page).toMatchObject({ capturing: false, detached: 'idle' })
    expect((page.entries as Array<{ text: string }>).map(entry => entry.text)).toEqual(['boom'])
    expect(String(page.note)).toContain('自动结束')
  })

  it('a read resets the idle bound', async () => {
    const { tool, stopped } = setup(250)
    await run(tool, 'start')
    await sleep(120)
    await run(tool, 'read')
    await sleep(120)
    expect(stopped).toEqual([])
    await sleep(200)
    expect(stopped).toEqual(['7'])
  })

  it('an explicit stop beats the idle timer to it', async () => {
    const { tool, stopped } = setup(60)
    await run(tool, 'start')
    await run(tool, 'stop')
    await sleep(120)
    // One stop from the action itself, none from the timer it disarmed.
    expect(stopped).toEqual(['7'])
  })

  it('a new start resumes a capture the idle timer released', async () => {
    const { tool, started, stopped } = setup(50)
    await run(tool, 'start')
    await sleep(100)
    expect(stopped).toEqual(['7'])
    await run(tool, 'start')
    const page = await run(tool, 'read')
    expect(page.detached).toBeUndefined()
    expect(started).toEqual(['7', '7'])
  })

  it('a non-positive bound disables the auto-release', async () => {
    const { tool, stopped } = setup(0)
    await run(tool, 'start')
    await sleep(80)
    expect(stopped).toEqual([])
  })
})
