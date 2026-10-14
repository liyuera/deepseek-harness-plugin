import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createExtensionZip, crc32, EXTENSION_ZIP_ROOT, extensionDir, extensionFiles, extensionStamp, extensionStampOf,
  extensionStampedValue, extensionVersion,
} from '../src/extension-package.ts'

/** One entry recovered from an archive built by the module under test. */
interface ReadEntry {
  name: string
  method: number
  checksum: number
  declared: number
  data: Buffer
}

/** Parse the local file headers of a stored-only archive built by the module. */
function readEntries(archive: Buffer): ReadEntry[] {
  const entries: ReadEntry[] = []
  let offset = 0
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset + 8)
    const checksum = archive.readUInt32LE(offset + 14)
    const declared = archive.readUInt32LE(offset + 22)
    const nameLength = archive.readUInt16LE(offset + 26)
    const extraLength = archive.readUInt16LE(offset + 28)
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const start = offset + 30 + nameLength + extraLength
    entries.push({ name, method, checksum, declared, data: archive.subarray(start, start + declared) })
    offset = start + declared
  }
  return entries
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('extension package', () => {
  it('round-trips every file under one root folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-ext-'))
    roots.push(root)
    mkdirSync(join(root, 'icons'))
    writeFileSync(join(root, 'manifest.json'), '{"manifest_version":3}')
    writeFileSync(join(root, 'icons', 'icon.png'), Buffer.from([1, 2, 3, 4]))
    writeFileSync(join(root, 'service-worker.js'), 'console.log(1)')

    const entries = readEntries(createExtensionZip(root))
    expect(entries.map(entry => entry.name)).toEqual([
      `${EXTENSION_ZIP_ROOT}/icons/icon.png`,
      `${EXTENSION_ZIP_ROOT}/manifest.json`,
      `${EXTENSION_ZIP_ROOT}/service-worker.js`,
    ])
    for (const entry of entries) {
      expect(entry.method).toBe(0)
      expect(entry.checksum).toBe(crc32(entry.data))
    }
    const manifest = entries.find(entry => entry.name.endsWith('manifest.json'))
    expect(manifest?.data.toString('utf8')).toBe('{"manifest_version":3}')
    expect(entries.find(entry => entry.name.endsWith('icon.png'))?.data).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it('ends with an end-of-central-directory record naming every entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-ext-'))
    roots.push(root)
    writeFileSync(join(root, 'manifest.json'), '{}')

    const archive = createExtensionZip(root)
    const end = archive.subarray(archive.length - 22)
    expect(end.readUInt32LE(0)).toBe(0x06054b50)
    expect(end.readUInt16LE(10)).toBe(1)
    // the central directory it points at is inside the same buffer
    expect(archive.readUInt32LE(end.readUInt32LE(16))).toBe(0x02014b50)
  })

  it('serves identical bytes for identical inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-ext-'))
    roots.push(root)
    writeFileSync(join(root, 'manifest.json'), '{}')

    expect(createExtensionZip(root).equals(createExtensionZip(root))).toBe(true)
  })

  it('ships a loadable extension beside the built module', () => {
    const directory = extensionDir(import.meta.url)
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
      manifest_version: number
      background?: { service_worker?: string }
      icons?: Record<string, string>
    }
    expect(manifest.manifest_version).toBe(3)
    const worker = manifest.background?.service_worker
    expect(worker).toBeDefined()
    expect(readFileSync(join(directory, worker as string), 'utf8')).toContain('WebSocket')

    // The archive carries the whole folder, and every icon the manifest names
    // is in it — a path that misses the archive leaves Chrome showing the
    // generic puzzle piece with nothing to explain why.
    const entries = readEntries(createExtensionZip(directory)).map(entry => entry.name)
    expect(entries).toEqual(extensionFiles(directory).map(name => `${EXTENSION_ZIP_ROOT}/${name}`))
    expect(Object.keys(manifest.icons ?? {}).length).toBeGreaterThan(0)
    for (const path of Object.values(manifest.icons ?? {})) {
      expect(entries).toContain(`${EXTENSION_ZIP_ROOT}/${path}`)
    }
  })
})

describe('extensionVersion', () => {
  it('reports the version the packaged manifest declares', () => {
    // The host compares this against what a running extension reports about
    // itself. Reading it from the manifest keeps one source of truth, so the
    // two cannot drift the way `package.json` (0.4.0) and `manifest.json`
    // (0.2.0) already had.
    const manifest = JSON.parse(
      readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'),
    ) as { version: string }
    expect(extensionVersion(import.meta.url)).toBe(manifest.version)
    expect(extensionVersion(import.meta.url)).not.toBe('')
  })

  it('answers empty rather than throwing when the manifest cannot be read', () => {
    // '' means "no expectation to compare against"; a throw here would take the
    // whole status route down.
    expect(extensionVersion('file:///nowhere/lib/mod.js')).toBe('')
  })
})

describe('the build stamp', () => {
  it('is current in the worker that ships', () => {
    // THE guard. The worker reports a constant because it cannot read its own
    // loaded code; that constant has to be regenerated whenever anything under
    // extension/ changes, and `npm run extension:stamp` is the only way to do
    // it. Without this check the host would compare a stale constant against
    // itself and call a changed extension current.
    expect(extensionStampedValue(import.meta.url)).not.toBe('')
    expect(extensionStampedValue(import.meta.url)).toBe(extensionStamp(import.meta.url))
  })

  it('is a full digest, not a placeholder', () => {
    expect(extensionStamp(import.meta.url)).toMatch(/^[0-9a-f]{64}$/u)
    expect(extensionStamp(import.meta.url)).not.toBe('0'.repeat(64))
  })

  it('changes when a byte of the extension changes', () => {
    const copy = mkdtempSync(join(tmpdir(), 'dsh-ext-stamp-'))
    try {
      for (const name of extensionFiles(extensionDir(import.meta.url))) {
        mkdirSync(join(copy, dirname(name)), { recursive: true })
        writeFileSync(join(copy, name), readFileSync(join(extensionDir(import.meta.url), name)))
      }
      const before = extensionStampOf(copy)
      writeFileSync(join(copy, 'service-worker.js'), `${readFileSync(join(copy, 'service-worker.js'), 'utf8')}\n// one more byte\n`)
      expect(extensionStampOf(copy)).not.toBe(before)
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })

  it('ignores its own value, so stamping does not change the stamp', () => {
    // The stamp lives in a file it covers. If it were hashed as written, every
    // stamp would invalidate itself and the guard could never pass.
    const copy = mkdtempSync(join(tmpdir(), 'dsh-ext-stamp2-'))
    try {
      for (const name of extensionFiles(extensionDir(import.meta.url))) {
        mkdirSync(join(copy, dirname(name)), { recursive: true })
        writeFileSync(join(copy, name), readFileSync(join(extensionDir(import.meta.url), name)))
      }
      const before = extensionStampOf(copy)
      const worker = join(copy, 'service-worker.js')
      writeFileSync(worker, readFileSync(worker, 'utf8').replace(
        /const BUILD_HASH = '[0-9a-f]{64}'/u, `const BUILD_HASH = '${'a'.repeat(64)}'`,
      ))
      expect(extensionStampOf(copy)).toBe(before)
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })
})
