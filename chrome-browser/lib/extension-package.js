/**
 * The unpacked Chrome extension shipped inside this package.
 *
 * An npm install places the extension beside the built host half, where a user
 * has no obvious way to find it, so the plugin serves the same files as a zip
 * over its own web server. Every entry name carries one root folder, so
 * unpacking the archive yields a directory Chrome accepts directly.
 * @module @liyuera/dsh-chrome-browser/extension-package
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Root folder every entry name inside the served zip starts with. */
export const EXTENSION_ZIP_ROOT = 'dsh-chrome-browser-extension';
/**
 * Fixed DOS timestamp (2026-01-01T00:00:00Z) so identical files serve
 * byte-identical archives and tests can compare whole buffers.
 */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
/** CRC-32 lookup table, built once. */
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[index] = value >>> 0;
    }
    return table;
})();
/**
 * Standard CRC-32 of one buffer, as ZIP entries require.
 * @param data - bytes to checksum.
 * @returns the unsigned 32-bit checksum.
 */
export function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
/**
 * Absolute path of the extension folder beside one built module.
 * @param moduleUrl - `import.meta.url` of the module resolving the folder.
 * @returns the absolute extension directory path.
 */
export function extensionDir(moduleUrl) {
    return fileURLToPath(new URL('../extension/', moduleUrl));
}
/**
 * Version the loaded extension must report to be current.
 *
 * Read from the packaged manifest rather than duplicated as a constant, so the
 * manifest stays the single source of truth. Compared against what the
 * extension reports about itself on connect, which is the only way to tell a
 * stale unpacked extension apart from a current one — Chrome never re-reads
 * those files on its own.
 * @param moduleUrl - `import.meta.url` of the module resolving the folder.
 * @returns the manifest's version, or '' when it cannot be read.
 */
export function extensionVersion(moduleUrl) {
    try {
        const manifest = JSON.parse(readFileSync(join(extensionDir(moduleUrl), 'manifest.json'), 'utf8'));
        const version = manifest.version;
        return typeof version === 'string' ? version : '';
    }
    catch (error) {
        // A missing or malformed manifest is reported by the zip route; here it
        // only means "no expectation to compare against".
        if (!/ENOENT|JSON/u.test(String(error.message)))
            throw error;
        return '';
    }
}
/**
 * Every file the extension is made of, as sorted relative paths.
 *
 * Sorted so both sides of the version handshake hash the same byte order, and
 * the whole tree rather than a list so a file added to the folder is covered
 * without an edit here. extension/service-worker.js carries the same set; a
 * test keeps the two equal.
 * @param directory - the extension folder.
 * @returns relative paths, `/`-separated and sorted.
 */
export function extensionFiles(directory) {
    const found = [];
    const walk = (current) => {
        for (const item of readdirSync(current, { withFileTypes: true })) {
            const absolute = join(current, item.name);
            if (item.isDirectory()) {
                walk(absolute);
                continue;
            }
            if (item.isFile())
                found.push(relative(directory, absolute).split(sep).join('/'));
        }
    };
    walk(directory);
    return found.sort();
}
/** The value `scripts/stamp-extension.mjs` writes into the worker. */
const STAMP_LINE = /const BUILD_HASH = '[0-9a-f]{64}'/u;
/**
 * One file's bytes with the stamp blanked, so the stamp is not self-referential.
 * @param bytes - the file's contents.
 * @returns the same bytes with any stamp value removed.
 */
function unstamped(bytes) {
    return Buffer.from(bytes.toString('utf8').replace(STAMP_LINE, "const BUILD_HASH = ''"), 'utf8');
}
/**
 * Fingerprint of one extension folder, as lowercase hex SHA-256.
 *
 * A stamp rather than a version number someone has to remember to bump, and a
 * stamp rather than a hash the extension computes at runtime: measured on a
 * real browser, `fetch(chrome.runtime.getURL(...))` inside the worker returns
 * the files on DISK, not the copy Chrome loaded, so a runtime self-hash reports
 * the new bytes while the old code is still running and nothing ever looks
 * stale. The worker therefore carries this value as a constant and reports it;
 * the host compares that constant against this function's answer.
 * @param directory - the extension folder.
 * @returns the digest of every file, name and bytes, in sorted order.
 */
export function extensionStampOf(directory) {
    const hash = createHash('sha256');
    for (const name of extensionFiles(directory)) {
        hash.update(Buffer.from(name, 'utf8'));
        hash.update(Buffer.from([0]));
        hash.update(unstamped(readFileSync(join(directory, name))));
    }
    return hash.digest('hex');
}
/**
 * The stamp this package's extension files should carry.
 * @param moduleUrl - `import.meta.url` of the module resolving the folder.
 * @returns the digest, or '' when the folder cannot be read.
 */
export function extensionStamp(moduleUrl) {
    try {
        return extensionStampOf(extensionDir(moduleUrl));
    }
    catch (error) {
        if (!/ENOENT/u.test(String(error.message)))
            throw error;
        return '';
    }
}
/**
 * The stamp actually written into the worker beside this module.
 * @param moduleUrl - `import.meta.url` of the module resolving the folder.
 * @returns the constant's value, or '' when it cannot be read.
 */
export function extensionStampedValue(moduleUrl) {
    try {
        const text = readFileSync(join(extensionDir(moduleUrl), 'service-worker.js'), 'utf8');
        return /const BUILD_HASH = '([0-9a-f]{64})'/u.exec(text)?.[1] ?? '';
    }
    catch (error) {
        if (!/ENOENT/u.test(String(error.message)))
            throw error;
        return '';
    }
}
/** Collect every regular file under one directory, sorted for a stable archive. */
function collectFiles(root, current) {
    const entries = [];
    for (const item of readdirSync(current, { withFileTypes: true })) {
        const absolute = join(current, item.name);
        if (item.isDirectory()) {
            entries.push(...collectFiles(root, absolute));
            continue;
        }
        if (!item.isFile())
            continue;
        entries.push({
            name: `${EXTENSION_ZIP_ROOT}/${relative(root, absolute).split(sep).join('/')}`,
            data: readFileSync(absolute),
        });
    }
    return entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}
/**
 * Build an uncompressed zip archive of one directory tree.
 *
 * Entries use the STORE method: the extension is a few kilobytes, and storing
 * keeps the writer free of a compression dependency.
 * @param directory - directory whose files become the archive contents.
 * @returns the complete zip archive.
 */
export function createExtensionZip(directory) {
    const files = collectFiles(directory, directory);
    const parts = [];
    const central = [];
    let offset = 0;
    for (const file of files) {
        const name = Buffer.from(file.name, 'utf8');
        const checksum = crc32(file.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(file.data.length, 18);
        local.writeUInt32LE(file.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        entry.writeUInt16LE(20, 6);
        entry.writeUInt16LE(0x0800, 8);
        entry.writeUInt16LE(0, 10);
        entry.writeUInt16LE(DOS_TIME, 12);
        entry.writeUInt16LE(DOS_DATE, 14);
        entry.writeUInt32LE(checksum, 16);
        entry.writeUInt32LE(file.data.length, 20);
        entry.writeUInt32LE(file.data.length, 24);
        entry.writeUInt16LE(name.length, 28);
        entry.writeUInt16LE(0, 30);
        entry.writeUInt16LE(0, 32);
        entry.writeUInt16LE(0, 34);
        entry.writeUInt16LE(0, 36);
        entry.writeUInt32LE(0, 38);
        entry.writeUInt32LE(offset, 42);
        parts.push(local, name, file.data);
        central.push(entry, name);
        offset += local.length + name.length + file.data.length;
    }
    const directoryBytes = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(directoryBytes.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...parts, directoryBytes, end]);
}
//# sourceMappingURL=extension-package.js.map