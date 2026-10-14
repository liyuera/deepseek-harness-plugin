/**
 * The shipped browser artifact: `lib/client.js` is what the Web shell loads
 * through its module table, so this spec runs the bundle the way the loader
 * does and checks what it registers. It runs the committed artifact — rebuild
 * (`npm run build`) after changing anything under `src/client/`.
 *
 * `react` is required by the bundle hoisted above the factory body and the
 * primitive icons are required for side effects only, so the module table is
 * stubbed with the real React and an empty primitives module.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { describe, expect, it } from 'vitest'

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/** One module-table row the bundle registers while loading. */
interface BundleRow {
  id: string
  factory(require: (specifier: string) => unknown): { apply(ctx: unknown): void; inject: string[] }
}

/** Load the bundle and return its module-table row. */
function loadBundle(): BundleRow {
  const rows: BundleRow[] = []
  const fakeWindow = { __ModuleLoader__: { load: (row: BundleRow) => { rows.push(row) } } }
  new Function('window', readFileSync(BUNDLE, 'utf8'))(fakeWindow)
  expect(rows).toHaveLength(1)
  return rows[0] as BundleRow
}

/** Evaluate the bundle's factory over a stubbed module table. */
function loadPlugin(): { apply(ctx: unknown): void; inject: string[] } {
  const row = loadBundle()
  return row.factory(specifier => (specifier === 'react' ? React : {}))
}

describe('shipped client bundle', () => {
  it('registers under the package name the loader row expects', () => {
    expect(loadBundle().id).toBe('@liyuera/dsh-chrome-browser')
  })

  it('applies the activity strip and the @ tab source', async () => {
    const slots: string[] = []
    const sources: Array<{ name?: string; trigger?: string; order?: number }> = []
    const ctx = {
      effect: (callback: () => unknown) => callback(),
      slots: {
        inject: (key: string, callback: () => unknown) => {
          slots.push(key)
          callback()
        },
        register: (options: { name: string; id: string }) => {
          slots.push(options.id)
          return () => {}
        },
      },
      inputTriggers: {
        registerSource: (source: (typeof sources)[number]) => {
          sources.push(source)
          return () => {}
        },
      },
    }
    const plugin = loadPlugin()
    expect(plugin.inject).toEqual(['slots', 'inputTriggers'])
    plugin.apply(ctx)
    // The dock carries the activity strip and nothing else.
    expect(slots).toEqual(['conversation.input.dock', 'chrome-browser-activity'])
    expect(sources).toHaveLength(1)
    expect(sources[0]?.name).toBe('chrome-browser')
    expect(sources[0]?.trigger).toBe('@')
    expect(sources[0]?.order).toBeLessThan(-100)
  })
})
