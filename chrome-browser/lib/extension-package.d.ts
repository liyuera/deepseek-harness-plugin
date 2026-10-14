/**
 * The unpacked Chrome extension shipped inside this package.
 *
 * An npm install places the extension beside the built host half, where a user
 * has no obvious way to find it, so the plugin serves the same files as a zip
 * over its own web server. Every entry name carries one root folder, so
 * unpacking the archive yields a directory Chrome accepts directly.
 * @module @liyuera/dsh-chrome-browser/extension-package
 */
/** Root folder every entry name inside the served zip starts with. */
export declare const EXTENSION_ZIP_ROOT = "dsh-chrome-browser-extension";
/**
 * Standard CRC-32 of one buffer, as ZIP entries require.
 * @param data - bytes to checksum.
 * @returns the unsigned 32-bit checksum.
 */
export declare function crc32(data: Buffer): number;
/**
 * Absolute path of the extension folder beside one built module.
 * @param moduleUrl - `import.meta.url` of the module resolving the folder.
 * @returns the absolute extension directory path.
 */
export declare function extensionDir(moduleUrl: string): string;
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
export declare function extensionVersion(moduleUrl: string): string;
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
export declare function extensionFiles(directory: string): string[];
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
export declare function extensionStampOf(directory: string): string;
/**
 * The stamp this package's extension files should carry.
 * @param moduleUrl - `import.meta.url` of the module resolving the folder.
 * @returns the digest, or '' when the folder cannot be read.
 */
export declare function extensionStamp(moduleUrl: string): string;
/**
 * The stamp actually written into the worker beside this module.
 * @param moduleUrl - `import.meta.url` of the module resolving the folder.
 * @returns the constant's value, or '' when it cannot be read.
 */
export declare function extensionStampedValue(moduleUrl: string): string;
/**
 * Build an uncompressed zip archive of one directory tree.
 *
 * Entries use the STORE method: the extension is a few kilobytes, and storing
 * keeps the writer free of a compression dependency.
 * @param directory - directory whose files become the archive contents.
 * @returns the complete zip archive.
 */
export declare function createExtensionZip(directory: string): Buffer;
//# sourceMappingURL=extension-package.d.ts.map