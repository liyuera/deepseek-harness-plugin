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
 * Build an uncompressed zip archive of one directory tree.
 *
 * Entries use the STORE method: the extension is a few kilobytes, and storing
 * keeps the writer free of a compression dependency.
 * @param directory - directory whose files become the archive contents.
 * @returns the complete zip archive.
 */
export declare function createExtensionZip(directory: string): Buffer;
//# sourceMappingURL=extension-package.d.ts.map