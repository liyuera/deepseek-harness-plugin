/**
 * `lib/` against `src/`: the committed build output must not carry a module the
 * source tree no longer has.
 *
 * `tsc -b` writes an output for every source it compiles and never removes the
 * output of a source that was deleted, and `lib/` is committed and published.
 * Removing `src/bindings.ts` and `src/client/TabPicker.tsx` therefore left eight
 * files — their `.js`, `.d.ts` and both source maps — which `npm pack` would
 * have shipped to every installer as dead code.
 */
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * Outputs that are not one-module-per-source artifacts.
 * `lib/client.js` is the tsdown browser bundle, built from `src/client/index.ts`
 * and named by the Web shell's module table.
 */
const BUNDLES = new Set(['client.js', 'index.js'])

/** Every `.js` under one directory, as paths relative to it. */
function jsFilesUnder(relative: string): string[] {
  const base = `${root}${relative}`
  if (!existsSync(base)) return []
  const found: string[] = []
  for (const entry of readdirSync(base, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    const parent = entry.parentPath ?? (entry as unknown as { path: string }).path ?? base
    found.push(`${parent.slice(base.length).replace(/^\//u, '')}${parent === base ? '' : '/'}${entry.name}`)
  }
  return found
}

/** Whether `src/` has a module this artifact could have been compiled from. */
function hasSource(artifact: string): boolean {
  const stem = artifact.replace(/\.js$/u, '')
  return [`${root}src/${stem}.ts`, `${root}src/${stem}.tsx`].some(candidate => existsSync(candidate))
}

describe('committed build output', () => {
  it('ships no module whose source was deleted', () => {
    const orphans = jsFilesUnder('lib/')
      .filter(file => !BUNDLES.has(file))
      .filter(file => !hasSource(file))
      .sort()
    expect(orphans, 'run `rm -rf lib && npm run build` to clear these').toEqual([])
  })

  it('has a source map beside every module it ships', () => {
    const missing = jsFilesUnder('lib/')
      .filter(file => !existsSync(`${root}lib/${file}.map`))
      .sort()
    expect(missing).toEqual([])
  })

  it('carries the entry points the package manifest and the Web shell name', () => {
    for (const required of ['lib/index.js', 'lib/index.d.ts', 'lib/client.js', 'extension/manifest.json', 'extension/service-worker.js']) {
      expect(existsSync(`${root}${required}`), `${required} is missing`).toBe(true)
    }
  })
})
