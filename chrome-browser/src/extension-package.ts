/**
 * The unpacked Chrome extension shipped inside this package.
 *
 * An npm install places the extension beside the built host half, where a user
 * has no obvious way to find it, so the plugin serves the same files as a zip
 * over its own web server. Every entry name carries one root folder, so
 * unpacking the archive yields a directory Chrome accepts directly.
 * @module @liyuera/dsh-chrome-browser/extension-package
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Root folder every entry name inside the served zip starts with. */
export const EXTENSION_ZIP_ROOT = 'dsh-chrome-browser-extension'

/**
 * Fixed DOS timestamp (2026-01-01T00:00:00Z) so identical files serve
 * byte-identical archives and tests can compare whole buffers.
 */
const DOS_TIME = 0
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1

/** One file collected for the archive. */
interface ZipEntry {
  /** Entry name, `/`-separated and rooted at {@link EXTENSION_ZIP_ROOT}. */
  name: string
  /** Uncompressed bytes. */
  data: Buffer
}

/** CRC-32 lookup table, built once. */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/**
 * Standard CRC-32 of one buffer, as ZIP entries require.
 * @param data - bytes to checksum.
 * @returns the unsigned 32-bit checksum.
 */
export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Absolute path of the extension folder beside one built module.
 * @param moduleUrl - `import.meta.url` of the module resolving the folder.
 * @returns the absolute extension directory path.
 */
export function extensionDir(moduleUrl: string): string {
  return fileURLToPath(new URL('../extension/', moduleUrl))
}

/** Collect every regular file under one directory, sorted for a stable archive. */
function collectFiles(root: string, current: string): ZipEntry[] {
  const entries: ZipEntry[] = []
  for (const item of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, item.name)
    if (item.isDirectory()) {
      entries.push(...collectFiles(root, absolute))
      continue
    }
    if (!item.isFile()) continue
    entries.push({
      name: `${EXTENSION_ZIP_ROOT}/${relative(root, absolute).split(sep).join('/')}`,
      data: readFileSync(absolute),
    })
  }
  return entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/**
 * Build an uncompressed zip archive of one directory tree.
 *
 * Entries use the STORE method: the extension is a few kilobytes, and storing
 * keeps the writer free of a compression dependency.
 * @param directory - directory whose files become the archive contents.
 * @returns the complete zip archive.
 */
export function createExtensionZip(directory: string): Buffer {
  const files = collectFiles(directory, directory)
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const checksum = crc32(file.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(file.data.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(0, 10)
    entry.writeUInt16LE(DOS_TIME, 12)
    entry.writeUInt16LE(DOS_DATE, 14)
    entry.writeUInt32LE(checksum, 16)
    entry.writeUInt32LE(file.data.length, 20)
    entry.writeUInt32LE(file.data.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt16LE(0, 30)
    entry.writeUInt16LE(0, 32)
    entry.writeUInt16LE(0, 34)
    entry.writeUInt16LE(0, 36)
    entry.writeUInt32LE(0, 38)
    entry.writeUInt32LE(offset, 42)

    parts.push(local, name, file.data)
    central.push(entry, name)
    offset += local.length + name.length + file.data.length
  }

  const directoryBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directoryBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...parts, directoryBytes, end])
}
