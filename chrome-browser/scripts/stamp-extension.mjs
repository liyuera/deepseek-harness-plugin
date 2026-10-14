/**
 * Write the extension's own fingerprint into its service worker.
 *
 * The worker carries the stamp as a constant because it cannot read the code
 * Chrome loaded: `fetch(chrome.runtime.getURL(...))` returns the file on disk,
 * so a runtime self-hash always looks current. The host compares the constant
 * against `extensionStamp()` of the files this package ships.
 *
 * Run after any change under `extension/` — tests/extension-package.spec.ts
 * fails while the stamp is out of date, so this is not a step to remember.
 *
 * Reads the built `lib/`, so `npm run build` must have run.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extensionDir, extensionStamp } from '../lib/extension-package.js'

const moduleUrl = import.meta.url
const worker = fileURLToPath(new URL('../extension/service-worker.js', moduleUrl))
const expected = extensionStamp(new URL('../lib/extension-package.js', moduleUrl).href)
if (expected === '') {
  console.error('stamp-extension: could not read the extension folder')
  process.exit(1)
}

const STAMP = /const BUILD_HASH = '([0-9a-f]{64})'/u
const before = readFileSync(worker, 'utf8')
if (!STAMP.test(before)) {
  console.error('stamp-extension: service-worker.js has no BUILD_HASH line to fill')
  process.exit(1)
}
// Rewriting an unchanged file would report the same bytes, so "already current"
// and "no line to fill" are separate outcomes rather than one comparison.
const already = STAMP.exec(before)?.[1] === expected
if (!already) writeFileSync(worker, before.replace(STAMP, `const BUILD_HASH = '${expected}'`))

// Read it back through the same resolver the host uses, so a stamp that was
// written but not picked up is reported here rather than at runtime.
const written = extensionStamp(new URL('../lib/extension-package.js', moduleUrl).href)
if (written !== expected) {
  console.error(`stamp-extension: wrote ${expected} but read back ${written}`)
  process.exit(1)
}
console.log(`stamp-extension: ${expected}${already ? ' (already current)' : ''}`)
console.log(`  (extensionDir: ${extensionDir(new URL('../lib/extension-package.js', moduleUrl).href)})`)
