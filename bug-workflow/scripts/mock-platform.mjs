#!/usr/bin/env node
/**
 * Local HT_TEAM platform mock for the Bug workflow plugin (P2 Task 3).
 *
 * Reproduces the slice of the platform REST API confirmed by the P0 spike
 * (`docs/superpowers/spikes/2026-11-06-p0-findings.md`, Spike B) so the client,
 * the sync engine and the live E2E can be exercised without a real token:
 *
 *   GET  /api/htwisdom-system/user-auth-info
 *   GET  /api/htwisdom-team/task?current&size&refHandlerPersonId&taskStatusList…
 *   GET  /api/htwisdom-team/task/detailByTaskCode/<code>
 *   GET  /api/htwisdom-system/dict/business/dictionary?codes=a,b,c
 *   GET  /api/htwisdom-team/remark/list?refTaskCode=<code>&remarkType=001_TASK
 *   POST /api/htwisdom-team/file/list           body {refBusinessIdList:[id]}
 *
 * Auth mirrors the real platform: every endpoint requires the
 * `Htwisdom-Auth: <token>` header; missing or wrong → HTTP 401
 * `{code:401,success:false,msg:'未授权'}`. Unknown paths → HTTP 404. Responses
 * use the production envelope `{code,success,data,msg}` and the list endpoint
 * returns MyBatis-style pagination with string-typed `total/size/current`
 * exactly as observed in P0.
 *
 * List records (`tasks.json`) and detail records (`detail.json`, keyed by
 * taskCode) are separate fixtures on purpose: P0 observed a 45-field detail
 * shape without the list-only `refProjectName`, so detailByTaskCode must not
 * echo the list record verbatim.
 *
 * Error-path test hook: `createMockPlatform` accepts a test-only `faults`
 * option, `{ '<request path>': { status, body, contentType? } }`. A string
 * `body` is sent raw (default `text/plain`); any other body is JSON-encoded.
 * Faults are applied after auth and before normal routing, so tests can drive
 * HTTP 500 and non-JSON responses through the real HTTP client/fetch path.
 *
 * CLI:
 *   node bug-workflow/scripts/mock-platform.mjs --port 0 --token test-token \
 *     --fixtures bug-workflow/scripts/fixtures/platform
 * prints `MOCK_PLATFORM_URL=http://127.0.0.1:<port>` and stays up until
 * SIGINT/SIGTERM.
 *
 * The token value is never logged and is redacted from `requests` entries so
 * test failure output can never reveal it. Import `createMockPlatform` from a
 * plain `node:test` file to run against an ephemeral port.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Bundled fixtures; override with `--fixtures <dir>` or `fixturesDir`. */
export const DEFAULT_FIXTURES_DIR = resolve(MODULE_DIR, 'fixtures', 'platform');

const REDACTED = '[redacted]';
const MAX_BODY_BYTES = 1024 * 1024;
const TASK_DETAIL_PREFIX = '/api/htwisdom-team/task/detailByTaskCode/';

const USAGE = [
  'usage: node bug-workflow/scripts/mock-platform.mjs [options]',
  '',
  '  --port <n>        listen port (default 0 = pick a free port)',
  '  --token <value>   accepted Htwisdom-Auth token (default test-token)',
  '  --fixtures <dir>  fixture directory (default bundled scripts/fixtures/platform)',
  '  --latency <ms>    add latency to every response (default 0)',
  '  --help            print this help',
].join('\n');

/**
 * Parse CLI arguments for the mock process. Exported so the argument handling
 * is unit-testable without spawning a child process.
 *
 * @param {string[]} argv arguments after `node script.mjs`
 * @returns {{port: number, token: string, fixturesDir: string, latencyMs: number, help: boolean}}
 */
export function parseMockArgs(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError('parseMockArgs(argv) requires an array');
  const options = {
    port: 0,
    token: 'test-token',
    fixturesDir: DEFAULT_FIXTURES_DIR,
    latencyMs: 0,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }
    if (flag !== '--port' && flag !== '--token' && flag !== '--fixtures' && flag !== '--latency') {
      throw new Error(`unknown argument: ${String(flag)}`);
    }

    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    index += 1;

    if (flag === '--port') {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('--port must be an integer between 0 and 65535');
      }
      options.port = port;
    } else if (flag === '--token') {
      if (value.trim() === '') throw new Error('--token must be a non-empty string');
      options.token = value;
    } else if (flag === '--fixtures') {
      options.fixturesDir = resolve(value);
    } else {
      const latencyMs = Number(value);
      if (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > 60_000) {
        throw new Error('--latency must be an integer between 0 and 60000');
      }
      options.latencyMs = latencyMs;
    }
  }

  return options;
}

/**
 * Start the mock platform on an ephemeral (or explicit) port.
 *
 * @param {object} [options]
 * @param {string} [options.token] accepted `Htwisdom-Auth` value
 * @param {string} [options.fixturesDir] directory with user/tasks/detail/dicts/remarks/files JSON
 * @param {number} [options.port] listen port, 0 picks a free one
 * @param {number} [options.latencyMs] artificial response latency
 * @param {Record<string, {status: number, body: unknown, contentType?: string}>} [options.faults]
 *   test-only overrides keyed by request path (applied after auth)
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>, requests: object[]}>}
 */
export async function createMockPlatform(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createMockPlatform(options) requires an options object');
  }

  const token = options.token ?? 'test-token';
  if (typeof token !== 'string' || token.trim() === '') {
    throw new TypeError('createMockPlatform() token must be a non-empty string');
  }

  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('createMockPlatform() port must be an integer between 0 and 65535');
  }

  const latencyMs = options.latencyMs ?? 0;
  if (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > 60_000) {
    throw new TypeError('createMockPlatform() latencyMs must be an integer between 0 and 60000');
  }

  // Test-only error injection: lets the client's HTTP/non-JSON paths be
  // exercised through the real server instead of a hand-rolled fetch double.
  const faults = normalizeFaults(options.faults);

  const fixtures = loadFixtures(options.fixturesDir ?? DEFAULT_FIXTURES_DIR);
  /** @type {{method: string, path: string, query: object, headers: object, body: unknown}[]} */
  const requests = [];

  const server = createServer((request, response) => {
    // A mock must never crash its test process: report handler bugs as a 500
    // envelope when possible.
    void handle(request, response).catch(() => {
      sendJson(response, 500, failureEnvelope(500, 'mock 内部错误'));
    });
  });

  async function handle(request, response) {
    let requestUrl;
    try {
      requestUrl = new URL(request.url ?? '/', 'http://mock.local');
    } catch {
      sendJson(response, 400, failureEnvelope(400, '请求路径不合法'));
      return;
    }

    let rawBody = '';
    try {
      rawBody = await readBody(request);
    } catch {
      sendJson(response, 400, failureEnvelope(400, '请求体读取失败'));
      return;
    }

    let body;
    let bodyInvalid = false;
    if (rawBody.trim() !== '') {
      try {
        body = JSON.parse(rawBody);
      } catch {
        bodyInvalid = true;
      }
    }

    // Record before auth so 401 cases are inspectable too. The auth header
    // value is redacted: tests assert its presence via the response/auth path,
    // never by printing or comparing the token itself.
    requests.push({
      method: request.method ?? 'GET',
      path: requestUrl.pathname,
      query: queryObject(requestUrl.searchParams),
      headers: recordHeaders(request.headers),
      body,
    });

    if (!isAuthorized(request, token)) {
      sendJson(response, 401, failureEnvelope(401, '未授权'));
      return;
    }

    const method = request.method ?? 'GET';
    const path = requestUrl.pathname;

    const fault = faults[path];
    if (fault !== undefined) {
      sendFault(response, fault);
      return;
    }

    if (method === 'GET' && path === '/api/htwisdom-system/user-auth-info') {
      sendJson(response, 200, successEnvelope({
        user: fixtures.user.user,
        roles: fixtures.user.roles ?? [],
        depts: fixtures.user.depts ?? [],
        appInfos: fixtures.user.appInfos ?? [],
        detail: fixtures.user.detail ?? {},
      }));
      return;
    }

    if (method === 'GET' && path === '/api/htwisdom-team/task') {
      sendJson(response, 200, successEnvelope(listTasks(fixtures.tasks, requestUrl.searchParams)));
      return;
    }

    if (method === 'GET' && path.startsWith(TASK_DETAIL_PREFIX)) {
      const encoded = path.slice(TASK_DETAIL_PREFIX.length);
      let taskCode;
      try {
        taskCode = decodeURIComponent(encoded);
      } catch {
        taskCode = encoded;
      }
      const task = fixtures.detail[taskCode];
      if (!isPlainObject(task)) {
        sendJson(response, 404, failureEnvelope(404, '工单不存在'));
        return;
      }
      sendJson(response, 200, successEnvelope(task));
      return;
    }

    if (method === 'GET' && path === '/api/htwisdom-system/dict/business/dictionary') {
      const codes = requestUrl.searchParams.get('codes');
      if (codes === null || codes.trim() === '') {
        // Exact platform behaviour observed in P0 (HTTP 400 with this msg).
        sendJson(response, 400, failureEnvelope(400, '字典编码不可为空'));
        return;
      }
      const data = {};
      for (const code of codes.split(',').map((item) => item.trim()).filter(Boolean)) {
        data[code] = fixtures.dicts[code] ?? [];
      }
      sendJson(response, 200, successEnvelope(data));
      return;
    }

    if (method === 'GET' && path === '/api/htwisdom-team/remark/list') {
      const refTaskCode = requestUrl.searchParams.get('refTaskCode');
      const remarkType = requestUrl.searchParams.get('remarkType');
      const data = fixtures.remarks.filter((remark) => (
        (refTaskCode === null || remark.refTaskCode === refTaskCode)
        && (remarkType === null || remark.remarkType === remarkType)
      ));
      sendJson(response, 200, successEnvelope(data));
      return;
    }

    if (method === 'POST' && path === '/api/htwisdom-team/file/list') {
      if (bodyInvalid || body === null || typeof body !== 'object' || Array.isArray(body)
        || !Array.isArray(body.refBusinessIdList)) {
        sendJson(response, 400, failureEnvelope(400, 'refBusinessIdList 不能为空'));
        return;
      }
      const ids = new Set(body.refBusinessIdList.map((id) => String(id)));
      const data = fixtures.files.filter((file) => ids.has(String(file.refBusinessId)));
      sendJson(response, 200, successEnvelope(data));
      return;
    }

    sendJson(response, 404, failureEnvelope(404, '接口不存在'));
  }

  /** Delay/write one JSON envelope; skip if the client already aborted. */
  function sendJson(response, status, payload) {
    sendText(response, status, JSON.stringify(payload), 'application/json; charset=utf-8');
  }

  /** Send a test-only fault: string bodies stay raw, everything else is JSON. */
  function sendFault(response, fault) {
    if (typeof fault.body === 'string') {
      sendText(response, fault.status, fault.body, fault.contentType ?? 'text/plain; charset=utf-8');
      return;
    }
    sendText(
      response,
      fault.status,
      JSON.stringify(fault.body),
      fault.contentType ?? 'application/json; charset=utf-8',
    );
  }

  /** Delay/write one raw body; skip if the client already aborted. */
  function sendText(response, status, text, contentType) {
    const write = () => {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(status, {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(text),
      });
      response.end(text);
    };

    if (latencyMs === 0) {
      write();
      return;
    }
    const timer = setTimeout(write, latencyMs);
    timer.unref();
    response.once('close', () => clearTimeout(timer));
  }

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address();
  const actualPort = address !== null && typeof address === 'object' ? address.port : port;

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
  }

  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    close,
    requests,
  };
}

// ---------------------------------------------------------------------------
// Fixtures / endpoint helpers
// ---------------------------------------------------------------------------

/**
 * Validate the test-only `faults` option. Faults are keyed by exact request
 * path and applied after auth; a string body is sent raw, anything else JSON.
 */
function normalizeFaults(input) {
  if (input === undefined) return {};
  if (!isPlainObject(input)) {
    throw new TypeError('createMockPlatform() faults must be an object keyed by request path');
  }

  const faults = {};
  for (const [path, fault] of Object.entries(input)) {
    if (typeof path !== 'string' || !path.startsWith('/')) {
      throw new TypeError('createMockPlatform() fault paths must start with "/"');
    }
    if (!isPlainObject(fault)) {
      throw new TypeError(`createMockPlatform() fault for ${path} must be an object`);
    }
    if (!Number.isInteger(fault.status) || fault.status < 200 || fault.status > 599) {
      throw new TypeError(`createMockPlatform() fault status for ${path} must be an integer between 200 and 599`);
    }
    if (!('body' in fault)) {
      throw new TypeError(`createMockPlatform() fault for ${path} must define body`);
    }
    if (fault.contentType !== undefined
      && (typeof fault.contentType !== 'string' || fault.contentType.trim() === '')) {
      throw new TypeError(`createMockPlatform() fault contentType for ${path} must be a non-empty string`);
    }
    faults[path] = { status: fault.status, body: fault.body, contentType: fault.contentType };
  }
  return faults;
}

function loadFixtures(fixturesDir) {
  if (typeof fixturesDir !== 'string' || fixturesDir.trim() === '') {
    throw new TypeError('createMockPlatform() fixturesDir must be a non-empty string');
  }
  const directory = resolve(fixturesDir);
  const read = (name) => JSON.parse(readFileSync(resolve(directory, name), 'utf8'));

  const user = read('user.json');
  const tasks = read('tasks.json');
  const detail = read('detail.json');
  const dicts = read('dicts.json');
  const remarks = read('remarks.json');
  const files = read('files.json');

  if (!isPlainObject(user) || !isPlainObject(user.user)) {
    throw new TypeError(`${directory}/user.json must contain a user object`);
  }
  for (const [name, value] of [['tasks.json', tasks], ['remarks.json', remarks], ['files.json', files]]) {
    if (!Array.isArray(value)) throw new TypeError(`${directory}/${name} must contain an array`);
  }
  if (!isPlainObject(detail)) {
    throw new TypeError(`${directory}/detail.json must contain an object keyed by taskCode`);
  }
  for (const [taskCode, record] of Object.entries(detail)) {
    if (!isPlainObject(record)) {
      throw new TypeError(`${directory}/detail.json entry ${taskCode} must be a detail object`);
    }
  }
  if (!isPlainObject(dicts)) {
    throw new TypeError(`${directory}/dicts.json must contain an object keyed by dict code`);
  }

  return { user, tasks, detail, dicts, remarks, files };
}

/**
 * MyBatis-style page over the fixture tasks. Pagination fields are strings
 * (`total:"3"`, `size:"2"`, `current:"1"`) because that is what the live
 * platform returned in P0.
 */
function listTasks(tasks, searchParams) {
  const current = positiveInt(searchParams.get('current')) ?? 1;
  const size = positiveInt(searchParams.get('size')) ?? 10;
  const handlerId = searchParams.get('refHandlerPersonId');
  const statuses = searchParams.getAll('taskStatusList').filter((item) => item !== '');
  const projectId = searchParams.get('refProjectId');
  const keyword = searchParams.get('keyword');
  const keywordType = searchParams.get('keywordType');

  let filtered = tasks.filter((task) => {
    if (handlerId !== null && String(task.refHandlePersonId) !== handlerId) return false;
    if (statuses.length > 0 && !statuses.includes(task.taskStatus)) return false;
    if (projectId !== null && String(task.refProjectId) !== projectId) return false;
    if (keyword !== null && keyword !== '') {
      if (keywordType === 'taskCode') {
        if (task.taskCode !== keyword) return false;
      } else if (!String(task.taskName ?? '').includes(keyword)
        && !String(task.taskCode ?? '').includes(keyword)) {
        return false;
      }
    }
    return true;
  });

  if (searchParams.get('descs') === 'createdTime') {
    filtered = [...filtered].sort((a, b) => String(b.createdTime).localeCompare(String(a.createdTime)));
  }

  const total = filtered.length;
  const start = (current - 1) * size;
  return {
    records: filtered.slice(start, start + size),
    total: String(total),
    size: String(size),
    current: String(current),
    pages: String(Math.ceil(total / size)),
    orders: [],
    optimizeCountSql: true,
    searchCount: true,
    countId: null,
    maxLimit: null,
  };
}

function successEnvelope(data) {
  return { code: 200, success: true, data, msg: '操作成功' };
}

function failureEnvelope(code, msg) {
  return { code, success: false, msg };
}

function isAuthorized(request, token) {
  const received = request.headers['htwisdom-auth'];
  if (Array.isArray(received)) return received.length === 1 && received[0] === token;
  return typeof received === 'string' && received === token;
}

/** Copy request headers, replacing the auth token so fixtures/logs stay clean. */
function recordHeaders(headers) {
  const copy = {};
  for (const [key, value] of Object.entries(headers)) {
    copy[key] = key.toLowerCase() === 'htwisdom-auth' ? REDACTED : value;
  }
  return copy;
}

function queryObject(searchParams) {
  const query = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    query[key] = values.length === 1 ? values[0] : values;
  }
  return query;
}

function readBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error('body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    request.on('error', rejectPromise);
  });
}

function positiveInt(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  const options = parseMockArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const mock = await createMockPlatform(options);
  // The token is deliberately not printed; the URL is the only machine-readable
  // line the E2E scripts need.
  console.log(`MOCK_PLATFORM_URL=${mock.url}`);

  const shutdown = async () => {
    try {
      await mock.close();
    } finally {
      // Always leave on SIGINT/SIGTERM, even if closing a socket failed:
      // a verification run must not leave a mock listener behind.
      process.exit(0);
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  return pathToFileURL(resolve(entry)).href === import.meta.url;
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(`mock platform failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
