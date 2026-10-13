import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExtensionZip, crc32, EXTENSION_ZIP_ROOT, extensionDir } from '../src/extension-package.ts'

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
    }
    expect(manifest.manifest_version).toBe(3)
    const worker = manifest.background?.service_worker
    expect(worker).toBeDefined()
    expect(readFileSync(join(directory, worker as string), 'utf8')).toContain('WebSocket')
    expect(readEntries(createExtensionZip(directory)).map(entry => entry.name)).toEqual([
      `${EXTENSION_ZIP_ROOT}/manifest.json`,
      `${EXTENSION_ZIP_ROOT}/service-worker.js`,
    ])
  })
})
