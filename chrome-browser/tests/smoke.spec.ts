/**
 * Real-Chrome full-path smoke test. Skipped unless DSH_CHROME_SMOKE=1: it
 * launches a headless Chrome in `owned` mode, drives every tool definition
 * through its real execute path, and verifies results. Local machine only
 * (spawns Chrome + listens on a loopback port).
 */
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { CdpBackend } from '../src/backend.ts'
import { Chrome, resolveChromeConfig } from '../src/chrome.ts'
import { ConsoleLog } from '../src/console-log.ts'
import { HelpChannel } from '../src/help.ts'
import { chromeToolDefinitions } from '../src/tools.ts'
import { EXTENSION_SOURCE, extractDeclaration } from './support/extension-source.ts'

const isSmoke = process.env.DSH_CHROME_SMOKE === '1'

/** The tab ids in one `chrome_tabs` answer. */
function idsOf(answer: Record<string, unknown>): string[] {
  return (answer.tabs as Array<{ id: string }>).map(tab => tab.id)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

describe.skipIf(!isSmoke)('chrome-browser smoke (real headless Chrome)', () => {
  let config = resolveChromeConfig({ mode: 'owned', port: 59322 })
  let chrome: Chrome
  let definitions: ToolDefinition[] = []
  const consoleLog = new ConsoleLog()

  const run = async (name: string, args: Record<string, unknown>, exec: unknown = {}): Promise<Record<string, unknown>> => {
    const definition = definitions.find(candidate => candidate.name === name)
    if (definition === undefined) throw new Error(`tool ${name} not registered`)
    return await definition.execute(args as never, exec as never) as unknown as Record<string, unknown>
  }

  afterAll(() => {
    chrome?.dispose()
  })

  it('drives the full tool surface', async () => {
    config = resolveChromeConfig({
      mode: 'owned',
      port: await freePort(),
      profileDir: join(tmpdir(), `dsh-chrome-smoke-${Date.now()}`),
      screenshotDir: join(tmpdir(), 'dsh-chrome-smoke-shots'),
    })
    chrome = new Chrome(config, { extraArgs: ['--headless=new'], pollIntervalMs: 200 })
    await chrome.ensure()
    // The console buffer is host-side; the CDP backend feeds it from a
    // long-lived session, so this exercises the real capture path.
    definitions = chromeToolDefinitions(
      new CdpBackend(chrome, (tabId, message) => { consoleLog.append(tabId, message) }),
      config,
      consoleLog,
      new HelpChannel(),
    )
    expect(definitions.length).toBe(15)
    const page = '<html><head><title>Smoke</title></head><body>'
      + '<h1>hello smoke</h1>'
      + '<button id="go" onclick="document.getElementById(\'out\').textContent=\'clicked\'">go</button>'
      + '<input id="inp"/>'
      + '<div id="out"></div>'
      // Click-outcome fixtures: a natively disabled control, a control with no
      // layout box, and a control an overlay covers at the same coordinates.
      + '<button id="off" disabled>off</button>'
      + '<button id="hidden" style="display:none">hidden</button>'
      + '<div style="position:relative;height:40px">'
      + '<button id="under" style="position:absolute;top:0;left:0;width:120px;height:40px">under</button>'
      + '<div id="mask" style="position:absolute;top:0;left:0;width:120px;height:40px"></div>'
      + '</div>'
      // Hover fixture: a control that only appears once its trigger is hovered.
      + '<div id="hoverer" onmouseover="document.getElementById(\'revealed\').style.display=\'block\'">hover me</div>'
      + '<div id="revealed" role="button" style="display:none">revealed</div>'
      // Press and select fixtures: a form that records its own submit, and a
      // select with two known option values.
      + '<form id="f" onsubmit="event.preventDefault();document.getElementById(\'out\').textContent=\'submitted\'">'
      + '<input id="q"/></form>'
      + '<select id="country"><option value="US">United States</option><option value="CA">Canada</option></select>'
      + '</body></html>'
    // A real file, not a `data:` URL: chrome_open now refuses a scheme the
    // plugin cannot inject into, and the bridge's host permissions never
    // covered `data:` — the tab it used to create could not be read, evaluated,
    // clicked or even navigated away from.
    const file = join(mkdtempSync(join(tmpdir(), 'dsh-chrome-smoke-page-')), 'page.html')
    writeFileSync(file, page)
    const url = `file://${file}`

    // chrome_open then tabs
    const opened = await run('chrome_open', { url })
    const tabId = String(opened.tabId)
    expect(tabId.length).toBeGreaterThan(0)
    const tabs = await run('chrome_tabs', {})
    expect((tabs.tabs as Array<{ id: string }>).some(tab => tab.id === tabId)).toBe(true)
    expect(tabs).not.toHaveProperty('session')

    // chrome_open waited for the load, so it already reports the loaded title
    // and the very next read sees the committed document — no polling needed.
    // (Without the wait this read raced the load and sometimes saw an empty
    // document; that race is what this assertion pins down.)
    expect(String(opened.title)).toBe('Smoke')
    const read = await run('chrome_read', { tabId })
    expect(read.title).toBe('Smoke')
    expect(String(read.text)).toContain('hello smoke')

    // click
    const clicked = await run('chrome_click', { tabId, selector: '#go' })
    expect(clicked.clicked).toBe(1)
    expect(clicked.matched).toBe(1)
    expect(clicked.warnings).toBeUndefined()
    const afterClick = await run('chrome_eval', { tabId, expression: "document.getElementById('out').textContent" })
    expect(String(afterClick.value)).toContain('clicked')

    // A natively disabled control receives no click event: the call must fail
    // rather than report a click the page never saw.
    await expect(run('chrome_click', { tabId, selector: '#off' })).rejects.toThrow(/none was clicked/)

    // A control with no layout box still dispatches, so it clicks — and says so.
    const hidden = await run('chrome_click', { tabId, selector: '#hidden' })
    expect(hidden.clicked).toBe(1)
    expect(hidden.matched).toBe(1)
    expect(String((hidden.warnings as string[])[0])).toContain('no visible box')

    // A control under an overlay: element.click() fires anyway, but a real
    // pointer would have landed on the mask, and the result says that.
    const covered = await run('chrome_click', { tabId, selector: '#under' })
    expect(covered.clicked).toBe(1)
    expect(String((covered.warnings as string[])[0])).toContain('covered by another element')

    // The interactive inventory, and the two copies of it — the host
    // expression the CDP backend evaluates, and the shipped extension's own
    // function — must agree on a real page, not merely on paper.
    const inventory = await run('chrome_read', { tabId, mode: 'interactive' })
    expect(inventory.mode).toBe('interactive')
    const items = inventory.items as Array<{ selector: string; role: string; name: string; disabled: boolean; covered: boolean }>
    const listed = new Map(items.map(item => [item.selector, item]))
    expect(listed.get('#go')).toMatchObject({ role: 'button', name: 'go', disabled: false, covered: false })
    expect(listed.get('#off')).toMatchObject({ disabled: true })
    expect(listed.get('#under')).toMatchObject({ covered: true })
    // A display:none control has no box, so the listing leaves it out — though
    // the selector still matched it.
    expect(listed.has('#hidden')).toBe(false)
    // Eight matched (the hidden and not-yet-revealed controls included), six shown.
    expect(inventory.matched).toBe(8)
    expect(items).toHaveLength(6)

    const extensionInventory = [
      'MAX_NAME_CHARS', 'INVENTORY_LIMIT', 'INVENTORY_SELECTOR',
      'cssEscape', 'stableSelector', 'nameOf', 'describeTarget', 'interactiveInventory',
    ].map(name => extractDeclaration(EXTENSION_SOURCE, name)).join('\n')
    const mirrored = await run('chrome_eval', {
      tabId,
      expression: `(() => {\n${extensionInventory}\nreturn interactiveInventory()\n})()`,
    })
    // chrome_eval returns its value as JSON text, not as a live object.
    const fromExtension = JSON.parse(String(mirrored.value)) as {
      title: string
      url: string
      matched: number
      items: unknown[]
    }
    expect(fromExtension.matched).toBe(inventory.matched)
    expect(fromExtension.title).toBe(inventory.title)
    expect(fromExtension.url).toBe(inventory.url)
    expect(fromExtension.items).toEqual(items)

    // chrome_wait polls a real page: satisfied true means the condition held,
    // satisfied false means the bound passed.
    expect(await run('chrome_wait', { tabId, selector: '#go', timeoutMs: 2000 }))
      .toMatchObject({ selector: '#go', state: 'visible', satisfied: true })
    expect(await run('chrome_wait', { tabId, selector: '#nope', timeoutMs: 300 }))
      .toMatchObject({ satisfied: false })
    expect(await run('chrome_wait', { tabId, selector: '#nope', state: 'detached', timeoutMs: 300 }))
      .toMatchObject({ state: 'detached', satisfied: true })

    // chrome_hover reaches the page's listeners: the control the fixture only
    // reveals on hover must appear in the listing afterwards.
    const selectors = (listing: Record<string, unknown>): string[] => (
      (listing.items as Array<{ selector: string }>).map(item => item.selector)
    )
    expect(selectors(inventory)).not.toContain('#revealed')
    expect(await run('chrome_hover', { tabId, selector: '#hoverer' })).toMatchObject({ hovered: true })
    expect(selectors(await run('chrome_read', { tabId, mode: 'interactive' }))).toContain('#revealed')
    await expect(run('chrome_hover', { tabId, selector: '#ghost' })).rejects.toThrow(/no element matched/)

    // chrome_press: synthetic key events trigger no default action, so Enter
    // must submit the owning form explicitly — and say that it did.
    await run('chrome_type', { tabId, selector: '#q', text: 'hello' })
    expect(await run('chrome_press', { tabId, key: 'Enter', selector: '#q' }))
      .toMatchObject({ key: 'Enter', submitted: true })
    const submitted = await run('chrome_eval', { tabId, expression: "document.getElementById('out').textContent" })
    expect(JSON.parse(String(submitted.value))).toBe('submitted')
    await expect(run('chrome_press', { tabId, key: 'Escape', selector: '#ghost' }))
      .rejects.toThrow(/no element matched/)

    // chrome_select: the value takes effect, and an unknown value names the
    // values the control does offer.
    expect(await run('chrome_select', { tabId, selector: '#country', value: 'CA' }))
      .toMatchObject({ selector: '#country', value: 'CA' })
    const chosen = await run('chrome_eval', { tabId, expression: "document.getElementById('country').value" })
    expect(JSON.parse(String(chosen.value))).toBe('CA')
    await expect(run('chrome_select', { tabId, selector: '#country', value: 'XX' }))
      .rejects.toThrow(/available values: US, CA/)

    // console: capture must be running BEFORE the page logs, because nothing is
    // recorded retroactively.
    await expect(run('chrome_console', { tabId, action: 'read' })).rejects.toThrow(/not being captured/)
    const started = await run('chrome_console', { tabId, action: 'start' })
    expect(started.capturing).toBe(true)
    expect(started.capturingTabs).toEqual([tabId])

    await run('chrome_eval', {
      tabId,
      expression: "console.log('smoke-marker', 42); console.error('smoke-error')",
    })
    // Events arrive on the capture session between calls, not as the eval's
    // reply, and each one lands separately — wait for both, not just the first.
    const isConsoleEntry = (entry: { level: string; text: string }): boolean => (
      entry.text === 'smoke-marker 42' || (entry.level === 'error' && entry.text === 'smoke-error')
    )
    let captured = await run('chrome_console', { tabId, action: 'read' })
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const seen = captured.entries as Array<{ level: string; text: string }>
      if (seen.filter(isConsoleEntry).length >= 2) break
      await new Promise(resolve => setTimeout(resolve, 50))
      captured = await run('chrome_console', { tabId, action: 'read' })
    }
    const lines = captured.entries as Array<{ level: string; text: string }>
    expect(lines.map(entry => entry.text)).toContain('smoke-marker 42')
    expect(lines.some(entry => entry.level === 'error' && entry.text === 'smoke-error')).toBe(true)

    // Reading twice with the cursor does not repeat entries.
    const cursor = Number(captured.cursor)
    expect(cursor).toBeGreaterThan(0)
    const again = await run('chrome_console', { tabId, action: 'read', since: cursor })
    expect(again.entries).toEqual([])
    expect(again.cursor).toBe(cursor)

    // A browser-raised message is captured too; a console() wrapper would miss it.
    await run('chrome_eval', { tabId, expression: "fetch('http://127.0.0.1:1/nope').catch(() => {})" })
    let network = await run('chrome_console', { tabId, action: 'read', since: cursor })
    for (let attempt = 0; attempt < 40 && (network.entries as unknown[]).length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50))
      network = await run('chrome_console', { tabId, action: 'read', since: cursor })
    }
    expect((network.entries as Array<{ level: string; text: string }>)
      .some(entry => entry.level === 'error' && entry.text.toLowerCase().includes('failed to load'))).toBe(true)

    const stopped = await run('chrome_console', { tabId, action: 'stop' })
    expect(stopped.capturing).toBe(false)
    await expect(run('chrome_console', { tabId, action: 'read' })).rejects.toThrow(/not being captured/)

    // type (with clear semantics on an empty field)
    const typed = await run('chrome_type', { tabId, selector: '#inp', text: 'world' })
    expect(typed.cleared).toBe(true)
    const afterType = await run('chrome_eval', { tabId, expression: "document.getElementById('inp').value" })
    expect(String(afterType.value)).toContain('world')

    // eval arithmetic
    const evaluated = await run('chrome_eval', { tabId, expression: '1 + 1' })
    expect(String(evaluated.value)).toContain('2')

    // screenshot
    const shot = await run('chrome_screenshot', { tabId })
    const shotPath = String(shot.path)
    expect(existsSync(shotPath)).toBe(true)
    expect(statSync(shotPath).size).toBeGreaterThan(0)
    expect(shot.bytes).toBe(statSync(shotPath).size)

    // navigate to a second page and read it
    const secondFile = join(mkdtempSync(join(tmpdir(), 'dsh-chrome-smoke-two-')), 'two.html')
    writeFileSync(secondFile, '<html><title>Two</title><body>second page</body></html>')
    const secondUrl = `file://${secondFile}`
    const navigated = await run('chrome_navigate', { tabId, url: secondUrl })
    expect(navigated.url).toBe(secondUrl)
    const readSecond = await run('chrome_read', { tabId })
    expect(String(readSecond.text)).toContain('second page')

    // chrome_close: a scratch tab opened for the purpose goes away again.
    const scratchFile = join(mkdtempSync(join(tmpdir(), 'dsh-chrome-smoke-scratch-')), 'scratch.html')
    writeFileSync(scratchFile, '<html><title>Scratch</title><body>scratch</body></html>')
    const scratch = await run('chrome_open', { url: `file://${scratchFile}` })
    const scratchId = String(scratch.tabId)
    expect(idsOf(await run('chrome_tabs', {})), 'the scratch tab did not open').toContain(scratchId)
    const closed = await run('chrome_close', { tabId: scratchId })
    expect(closed).toMatchObject({ tabId: scratchId, closed: true })
    expect(idsOf(await run('chrome_tabs', {})), 'the scratch tab is still open').not.toContain(scratchId)

    // A scheme the plugin cannot inject into is refused BEFORE a tab exists, so
    // no dead tab is left behind. That tab used to be created and then fail
    // every read, evaluation and navigation.
    const tabsBefore = idsOf(await run('chrome_tabs', {}))
    await expect(run('chrome_open', { url: 'data:text/html,<h1>dead</h1>' }))
      .rejects.toThrow(/cannot drive a data: URL/)
    expect(idsOf(await run('chrome_tabs', {}))).toEqual(tabsBefore)
  }, 120_000)

  it('reaches the browser through the user-mode relaunch path', async () => {
    // isRunning=false → no stop; real headless Chrome spawn lands on the
    // profile COPY of a fixture source (never the user's real profile) in
    // user mode.
    const profileSource = join(tmpdir(), `dsh-chrome-smoke-src-${Date.now()}`)
    mkdirSync(profileSource, { recursive: true })
    writeFileSync(join(profileSource, 'Bookmarks'), '{}')
    const userConfig = resolveChromeConfig({
      mode: 'user',
      autoRelaunch: true,
      port: await freePort(),
      profileDir: join(tmpdir(), `dsh-chrome-smoke-user-${Date.now()}`),
      screenshotDir: join(tmpdir(), 'dsh-chrome-smoke-shots'),
    })
    const userChrome = new Chrome(userConfig, {
      extraArgs: ['--headless=new'],
      pollIntervalMs: 200,
      platformOps: { isRunning: async () => false, stop: async () => {} },
      userProfileSource: profileSource,
    })
    try {
      expect(userChrome.config.mode).toBe('user')
      await userChrome.ensure()
      const tabs = await userChrome.listTabs()
      expect(tabs.length).toBeGreaterThan(0)
      expect(existsSync(join(userConfig.profileDir, 'Bookmarks'))).toBe(true)
    } finally {
      userChrome.dispose()
    }
  }, 120_000)
})
