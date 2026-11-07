/**
 * Unit tests for the platform evidence downloader (P6).
 *
 * The live platform keeps screenshot-only bug reports in the rich-text
 * description (public OSS `<img>` URLs) and sometimes in attachment files. The
 * service under test resolves those URLs, downloads the images into
 * `<workspace>/.dsh-attachments/<code>/`, and returns local paths the analysis
 * prompt hands to `read_image`.
 *
 * Everything runs against a fake fetch + fake platform client over a temp
 * directory; no network is touched.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ATTACHMENT_DIR_NAME,
  MAX_ATTACHMENT_IMAGES,
  createAttachmentService,
  extractDescriptionImageUrls,
} from '../src/host/attachments.js';

const TICKET_CODE = 'YGFNXDJRFWDJSYJJYY-632';
const BASE_URL = 'https://platform.test';

/** A 4-byte PNG-ish payload; the service only checks content-type/extension. */
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

function pngResponse(bytes = PNG_BYTES) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'image/png' : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

/** Fake platform client: a detail description with one image + one text file. */
function createFakePlatformClient({ description, files = [], detailThrows = false } = {}) {
  const calls = { detail: 0, files: [] };
  return {
    calls,
    client: {
      async getTask(code) {
        calls.detail += 1;
        if (detailThrows) throw new Error('detail exploded');
        return { ok: true, data: { taskCode: code, description } };
      },
      async listFiles(taskId) {
        calls.files.push(taskId);
        return { ok: true, data: files };
      },
    },
  };
}

function createHarness({ description, files, detailThrows, fetchImpl } = {}) {
  const fake = createFakePlatformClient({ description, files, detailThrows });
  const store = {
    get: (code) => ({
      code,
      platform: { taskId: '1044006408200166247', description: '[图片]' },
    }),
    getSettings: () => ({ platformBaseUrl: BASE_URL }),
  };
  const tokenStore = { get: async () => 'secret-token' };
  const fetched = [];
  const service = createAttachmentService({
    store,
    tokenStore,
    platformClientFor: () => fake.client,
    fetchImpl: async (url, init) => {
      fetched.push({ url, headers: init?.headers ?? {} });
      return typeof fetchImpl === 'function' ? fetchImpl(url, init) : pngResponse();
    },
  });
  return { service, fake, fetched };
}

async function withWorkspace(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-attachments-test-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('extractDescriptionImageUrls decodes encoded rich text and resolves sources', () => {
  const encoded = encodeURIComponent(
    '<p><img src="/oss/team/a.png" alt="a"><img src="https://cdn.test/b.png"><img src="/oss/team/a.png"></p>',
  );
  assert.deepEqual(extractDescriptionImageUrls(encoded, BASE_URL), [
    `${BASE_URL}/oss/team/a.png`,
    'https://cdn.test/b.png',
  ]);
  // Already-decoded HTML and plain text behave predictably.
  assert.deepEqual(extractDescriptionImageUrls('<img src="/x.png">', BASE_URL), [`${BASE_URL}/x.png`]);
  assert.deepEqual(extractDescriptionImageUrls('无图片描述', BASE_URL), []);
  assert.deepEqual(extractDescriptionImageUrls('', BASE_URL), []);
  assert.deepEqual(extractDescriptionImageUrls(null, BASE_URL), []);
  // Non-http schemes are rejected (no javascript:/data: downloads).
  assert.deepEqual(extractDescriptionImageUrls('<img src="javascript:alert(1)">', BASE_URL), []);
});

test('prepare() downloads description images into the workspace and lists attachments', async () => {
  await withWorkspace(async (root) => {
    const encoded = encodeURIComponent('<p><img src="/oss/team/shot.png"></p>');
    const { service, fake, fetched } = createHarness({
      description: encoded,
      files: [
        { fileName: '日志.txt', fileUrl: `${BASE_URL}/files/log.txt`, fileSize: 2048, fileType: 'txt' },
        { fileName: '截图.png', fileUrl: `${BASE_URL}/files/shot2.png`, fileSize: 1024, fileType: 'png' },
      ],
    });

    const result = await service.prepare(root, TICKET_CODE);

    assert.equal(result.ok, true);
    assert.equal(fake.calls.detail, 1);
    assert.deepEqual(fake.calls.files, ['1044006408200166247']);
    assert.equal(result.images.length, 2);
    for (const image of result.images) {
      const info = await stat(image.path);
      assert.equal(info.isFile(), true);
      assert.ok(image.path.startsWith(join(root, ATTACHMENT_DIR_NAME, TICKET_CODE)));
      assert.equal(image.bytes, PNG_BYTES.byteLength);
      const bytes = await readFile(image.path);
      assert.deepEqual(Uint8Array.from(bytes), PNG_BYTES);
    }
    // OSS images must be fetched WITHOUT the login token (live OSS answers 400
    // to authenticated public-object requests).
    for (const request of fetched) {
      assert.equal('Htwisdom-Auth' in request.headers, false);
    }
    assert.deepEqual(result.files.map((file) => file.name).sort(), ['截图.png', '日志.txt'].sort());

    await service.cleanup(result.dir);
    await assert.rejects(() => stat(join(root, ATTACHMENT_DIR_NAME, TICKET_CODE)));
  });
});

test('prepare() caps the number of downloaded images', async () => {
  await withWorkspace(async (root) => {
    const images = Array.from({ length: MAX_ATTACHMENT_IMAGES + 3 }, (_, index) => `<img src="/oss/${index}.png">`).join('');
    const { service } = createHarness({ description: encodeURIComponent(`<p>${images}</p>`) });

    const result = await service.prepare(root, TICKET_CODE);

    assert.equal(result.ok, true);
    assert.equal(result.images.length, MAX_ATTACHMENT_IMAGES);
    await service.cleanup(result.dir);
  });
});

test('prepare() degrades to a static error when nothing can be downloaded', async () => {
  await withWorkspace(async (root) => {
    const { service } = createHarness({
      description: encodeURIComponent('<p><img src="/oss/broken.png"></p>'),
      fetchImpl: () => ({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }),
    });

    const result = await service.prepare(root, TICKET_CODE);

    assert.equal(result.ok, false);
    assert.equal(result.error, 'attachment-download-failed');
    assert.equal(result.imagesFound, 1);
  });
});

test('prepare() tolerates a failing detail endpoint and still lists files', async () => {
  await withWorkspace(async (root) => {
    const { service } = createHarness({
      detailThrows: true,
      files: [{ fileName: '说明.txt', fileUrl: `${BASE_URL}/files/readme.txt`, fileSize: 10, fileType: 'txt' }],
    });

    const result = await service.prepare(root, TICKET_CODE);

    assert.equal(result.ok, true);
    assert.deepEqual(result.images, []);
    assert.equal(result.dir, undefined);
    assert.deepEqual(result.files.map((file) => file.name), ['说明.txt']);
  });
});

test('prepare() returns a static failure without a workspace', async () => {
  const { service } = createHarness({ description: '' });
  const result = await service.prepare('', TICKET_CODE);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'attachment-no-workspace');
});
