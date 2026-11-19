/**
 * `apply()` must install the extension bridge in sandbox mode: sandboxes are
 * the default backend there, but `backend: 'user'` (and the `@` tab menu) still
 * needs the user's real Chrome, which is the shared extension backend. The cdp
 * backend has no extension face and must not start the bridge.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

/** Effect label `installExtensionBridge` registers when it starts its server. */
const BRIDGE_EFFECT = 'chrome-browser: extension bridge server'

/** Fake host exposing only what `apply()` touches; effects run immediately. */
function fakeHost(): { ctx: Context; labels: string[]; disposers: Array<() => void> } {
  const labels: string[] = []
  const disposers: Array<() => void> = []
  const ctx = {
    tools: { register: () => {} },
    get: () => undefined,
    inject: () => {},
    on: () => {},
    effect: (contribute: () => () => void, label?: string) => {
      labels.push(label ?? '')
      disposers.push(contribute())
      return () => {}
    },
  } as unknown as Context
  return { ctx, labels, disposers }
}

let cleanup: Array<() => void> = []
/** Temp profile dirs this file created, removed after each test. */
let temporaryDirs: string[] = []

afterEach(async () => {
  for (const dispose of cleanup.reverse()) dispose()
  cleanup = []
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true })
  temporaryDirs = []
  // Let a bridge bind that was in flight when the disposer ran settle and close.
  await new Promise(resolve => setTimeout(resolve, 20))
})

describe('apply() extension bridge installation', () => {
  it('installs the bridge in sandbox mode, so backend: "user" stays reachable', () => {
    const host = fakeHost()
    apply(host.ctx, { backend: 'sandbox', bridgePort: 0 })
    cleanup = host.disposers
    expect(host.labels).toContain(BRIDGE_EFFECT)
  })

  it('installs the bridge in extension mode', () => {
    const host = fakeHost()
    apply(host.ctx, { backend: 'extension', bridgePort: 0 })
    cleanup = host.disposers
    expect(host.labels).toContain(BRIDGE_EFFECT)
  })

  it('does not install the bridge for the cdp backend', () => {
    // cdp apply() reads the owned profile's pid file and can terminate a Chrome
    // it recognises there: keep it off the developer's shared default profile
    // and off the usual debug port.
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-chrome-apply-cdp-'))
    temporaryDirs.push(profileDir)
    const host = fakeHost()
    apply(host.ctx, { backend: 'cdp', bridgePort: 0, port: 19222, profileDir })
    cleanup = host.disposers
    expect(host.labels).not.toContain(BRIDGE_EFFECT)
  })
})
