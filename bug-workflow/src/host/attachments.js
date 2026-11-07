/**
 * Platform attachment downloader for the AI analysis prompt (P6).
 *
 * The platform keeps the real bug evidence in rich-text descriptions and
 * attachments: a screenshot-only report has no text at all (live example:
 * YGFNXDJRFWDJSYJJYY-632). The analysis subagent can read images through the
 * inherited `read_image` tool, so before spawning it the host downloads the
 * description images (and image attachments when the file listing has them) to
 * a throw-away directory inside the workspace and lists those local paths in
 * the prompt.
 *
 * Contract:
 *   - pure over injected `{store, tokenStore, platformClientFor, fetchImpl, clock}`;
 *   - never throws: any platform/network/filesystem failure resolves to
 *     `{ok:false, error:<static code>}` so analysis still runs on the text;
 *   - description images are public OSS URLs (live platform serves them without
 *     `Htwisdom-Auth`; sending the header makes OSS answer 400), so downloads
 *     are unauthenticated and only `http(s)` sources are accepted;
 *   - caps: 6 images / 8 MiB each / 24 MiB total / 15 s timeout, image
 *     content-types only, and the destination is always
 *     `<cwd>/.dsh-attachments/<code>/`;
 *   - `cleanup()` removes the directory best-effort; the analysis service owns
 *     that lifecycle.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Directory (inside the workspace) that holds downloaded evidence. */
export const ATTACHMENT_DIR_NAME = '.dsh-attachments';

/** Max number of images handed to the model. */
export const MAX_ATTACHMENT_IMAGES = 6;

/** Per-image byte cap. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Total bytes downloaded per ticket. */
export const MAX_ATTACHMENT_TOTAL_BYTES = 24 * 1024 * 1024;

/** Per-download timeout. */
export const ATTACHMENT_TIMEOUT_MS = 15_000;

/** Max non-image attachments listed in the prompt. */
export const MAX_ATTACHMENT_FILES = 20;

/** Static, token-free reason codes. */
export const ATTACHMENT_ERRORS = Object.freeze({
  'attachment-no-workspace': '工作区路径无效，无法下载平台附件',
  'attachment-download-failed': '平台附件下载失败，分析将只使用文字信息',
});

/** Image extensions accepted when a content-type is missing. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

/**
 * Extract `http(s)` image sources from a platform description. The stored
 * description is plain text (`normalizePlatformDescription` replaced images
 * with `[图片]`), so the raw rich text is re-read from the detail endpoint and
 * normalized here: percent-decode once, then scan `<img src="…">`.
 *
 * @param {unknown} rawDescription raw detail description (may be URI-encoded)
 * @param {string} baseUrl platform origin for relative sources
 * @returns {string[]} absolute http(s) image URLs (deduped, order preserved)
 */
export function extractDescriptionImageUrls(rawDescription, baseUrl) {
  if (typeof rawDescription !== 'string' || rawDescription === '') return [];
  let html = rawDescription;
  if (!html.includes('<') && /%[0-9A-Fa-f]{2}/.test(html)) {
    try {
      html = decodeURIComponent(html);
    } catch {
      // Malformed encoding: scan the raw value instead.
    }
  }
  const origin = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
  const urls = [];
  const seen = new Set();
  for (const match of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi)) {
    const src = match[2].trim();
    if (src === '') continue;
    let absolute;
    try {
      absolute = new URL(src, origin === '' ? undefined : `${origin}/`).toString();
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(absolute)) continue;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    urls.push(absolute);
  }
  return urls;
}

/** Last path segment of a URL, safely decoded, for a display/local file name. */
function fileNameFromUrl(url, fallback) {
  try {
    const pathname = new URL(url).pathname;
    const raw = pathname.split('/').filter(Boolean).pop() ?? '';
    const decoded = decodeURIComponent(raw);
    return decoded === '' ? fallback : decoded;
  } catch {
    return fallback;
  }
}

/** Reduce a platform file name to a safe basename (no separators, bounded). */
function safeBaseName(name, fallback) {
  const text = typeof name === 'string' ? name.trim() : '';
  if (text === '') return fallback;
  const base = text.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').slice(0, 80);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? fallback : cleaned;
}

/** True when the path/extension/content-type looks like an image. */
function looksLikeImage(contentType, fileName) {
  if (typeof contentType === 'string' && /^image\//i.test(contentType.trim())) return true;
  const extension = (fileName.split('.').pop() ?? '').toLowerCase();
  return IMAGE_EXTENSIONS.has(extension);
}

/**
 * Create the attachment downloader.
 *
 * @param {object} deps
 * @param {object} deps.store ticket store (`get`, `getSettings`)
 * @param {object} deps.tokenStore platform token store (`get`)
 * @param {Function} deps.platformClientFor `(settings, token) => client`
 * @param {typeof fetch} [deps.fetchImpl] injectable fetch
 * @param {() => string} [deps.clock] unused clock hook kept for symmetry
 * @returns {{prepare: (cwd: string, code: string) => Promise<object>, cleanup: (dir: string|undefined) => Promise<void>}}
 */
export function createAttachmentService({ store, tokenStore, platformClientFor, fetchImpl = fetch, clock } = {}) {
  if (store === null || typeof store !== 'object' || typeof store.get !== 'function') {
    throw new TypeError('createAttachmentService() requires a ticket store');
  }
  if (tokenStore === null || typeof tokenStore !== 'object' || typeof tokenStore.get !== 'function') {
    throw new TypeError('createAttachmentService() requires a token store');
  }
  if (typeof platformClientFor !== 'function') {
    throw new TypeError('createAttachmentService() requires platformClientFor');
  }
  const now = typeof clock === 'function' ? clock : () => new Date().toISOString();

  /** Download one URL with a timeout; returns bytes + content-type or null. */
  async function download(url, acceptAuth) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ATTACHMENT_TIMEOUT_MS);
    try {
      const headers = { Accept: 'image/*,*/*;q=0.5' };
      const tokenValue = acceptAuth ? await tokenStore.get().catch(() => null) : null;
      if (typeof tokenValue === 'string' && tokenValue.trim() !== '') headers['Htwisdom-Auth'] = tokenValue.trim();
      const response = await fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response || typeof response.ok !== 'boolean' || !response.ok) {
        return { ok: false, status: typeof response?.status === 'number' ? response.status : null };
      }
      const arrayBuffer = await response.arrayBuffer();
      const bytes = Buffer.from(arrayBuffer);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        return { ok: false, status: response.status, oversized: bytes.byteLength > MAX_ATTACHMENT_BYTES };
      }
      return {
        ok: true,
        bytes,
        contentType: typeof response.headers?.get === 'function' ? response.headers.get('content-type') : null,
      };
    } catch {
      return { ok: false, status: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Prepare local evidence files for one analysis run.
   *
   * @param {string} cwd analysis workspace
   * @param {string} code ticket code
   * @returns {Promise<{
   *   ok: boolean, dir?: string, images?: object[], files?: object[],
   *   imagesFound?: number, error?: string, downloadedAt?: string,
   * }>}
   */
  async function prepare(cwd, code) {
    const workspace = typeof cwd === 'string' && cwd.trim() !== '' ? resolve(cwd) : '';
    if (workspace === '') return { ok: false, error: 'attachment-no-workspace' };
    const ticket = typeof code === 'string' ? store.get(code) : undefined;
    if (ticket === undefined || ticket === null) return { ok: false, error: 'attachment-download-failed' };

    let settings;
    try {
      settings = store.getSettings(workspace);
    } catch {
      return { ok: false, error: 'attachment-download-failed' };
    }
    const baseUrl = typeof settings?.platformBaseUrl === 'string' ? settings.platformBaseUrl : '';
    let token = null;
    try {
      token = await tokenStore.get();
    } catch {
      token = null;
    }
    let client;
    try {
      client = platformClientFor(settings, typeof token === 'string' ? token : '');
    } catch {
      return { ok: false, error: 'attachment-download-failed' };
    }
    if (client === null || typeof client !== 'object') {
      return { ok: false, error: 'attachment-download-failed' };
    }

    // Raw rich-text description (the stored one is already flattened to text).
    let imageUrls = [];
    let detailDescription = '';
    try {
      const detail = await client.getTask(code);
      if (detail?.ok === true && detail.data !== null && typeof detail.data === 'object') {
        detailDescription = typeof detail.data.description === 'string' ? detail.data.description : '';
        imageUrls = extractDescriptionImageUrls(detailDescription, baseUrl);
      }
    } catch {
      // No detail: fall back to attachment files only.
    }

    // Attachment files (image ones are downloaded too; others are listed).
    const files = [];
    let attachmentFiles = [];
    const taskId = ticket?.platform && typeof ticket.platform.taskId === 'string' ? ticket.platform.taskId : '';
    if (taskId !== '') {
      try {
        const listing = await client.listFiles(taskId);
        if (listing?.ok === true && Array.isArray(listing.data)) attachmentFiles = listing.data.slice(0, MAX_ATTACHMENT_FILES);
      } catch {
        // The live task may have no attachments; listing is best-effort.
      }
    }
    for (const file of attachmentFiles) {
      const url = typeof file?.fileUrl === 'string' && /^https?:\/\//i.test(file.fileUrl)
        ? file.fileUrl
        : '';
      const name = safeBaseName(file?.fileName, '附件');
      // Only file types whose extension is a known image count as images.
      const fileType = typeof file?.fileType === 'string' ? file.fileType.trim().toLowerCase() : '';
      const contentType = IMAGE_EXTENSIONS.has(fileType) ? `image/${fileType}` : '';
      if (url !== '' && looksLikeImage(contentType, name)) imageUrls.push(url);
      files.push({
        name,
        bytes: Number.isFinite(Number(file?.fileSize)) ? Number(file.fileSize) : null,
        type: typeof file?.fileType === 'string' ? file.fileType : '',
      });
    }

    const dir = join(workspace, ATTACHMENT_DIR_NAME, safeBaseName(code, 'ticket'));
    const images = [];
    let totalBytes = 0;
    let index = 0;
    let downloadFailed = false;
    if (imageUrls.length > 0) {
      try {
        await mkdir(dir, { recursive: true });
      } catch {
        return { ok: false, error: 'attachment-download-failed' };
      }
      for (const url of imageUrls) {
        if (images.length >= MAX_ATTACHMENT_IMAGES) break;
        if (totalBytes >= MAX_ATTACHMENT_TOTAL_BYTES) break;
        index += 1;
        let downloaded = await download(url, false);
        // Attachment URLs are not OSS paths; retry once with the login token.
        if (downloaded.ok !== true && /\/api\//.test(url)) downloaded = await download(url, true);
        if (downloaded.ok !== true) {
          downloadFailed = downloadFailed || downloaded.oversized !== true;
          continue;
        }
        const name = safeBaseName(fileNameFromUrl(url, `image-${index}.png`), `image-${index}.png`);
        if (!looksLikeImage(downloaded.contentType, name)) continue;
        if (totalBytes + downloaded.bytes.byteLength > MAX_ATTACHMENT_TOTAL_BYTES) break;
        const path = join(dir, `${String(index).padStart(2, '0')}-${name}`);
        try {
          await writeFile(path, downloaded.bytes);
        } catch {
          downloadFailed = true;
          continue;
        }
        totalBytes += downloaded.bytes.byteLength;
        images.push({ name, path, bytes: downloaded.bytes.byteLength });
      }
      if (images.length === 0) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }

    if (images.length === 0 && files.length === 0) {
      return {
        ok: false,
        error: downloadFailed ? 'attachment-download-failed' : null,
        imagesFound: imageUrls.length,
      };
    }
    return {
      ok: true,
      dir: images.length > 0 ? dir : undefined,
      images,
      files,
      imagesFound: imageUrls.length,
      downloadedAt: now(),
    };
  }

  /** Remove the per-ticket evidence directory (best-effort). */
  async function cleanup(dir) {
    if (typeof dir !== 'string' || dir === '') return;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  return { prepare, cleanup };
}
