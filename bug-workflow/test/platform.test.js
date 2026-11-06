/**
 * Contract tests for the platform HTTP client + local mock platform (P2 Task 3).
 *
 * The mock is imported directly (no child process) and listens on an ephemeral
 * loopback port, so the tests exercise the real `fetch` path end to end:
 * `Htwisdom-Auth` header, URL/query building, envelope unwrapping, pagination,
 * 401/404 mapping, remark decoding and POST bodies.
 *
 * The token only ever lives in this file's constants and in the
 * `Htwisdom-Auth` request header. The mock redacts it from `requests`, and the
 * assertions below compare token-bearing values as booleans so a failed test
 * can never print the token.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DICT_CODES,
  PlatformError,
  buildPath,
  createPlatformClient,
  normalizeBaseUrl,
} from '../src/host/platform.js';
import {
  DEFAULT_FIXTURES_DIR,
  createMockPlatform,
  parseMockArgs,
} from '../scripts/mock-platform.mjs';

const TOKEN = 'test-token';
const OTHER_TOKEN = 'wrong-token';
const FIXTURES_DIR = fileURLToPath(new URL('../scripts/fixtures/platform/', import.meta.url));

function readFixture(name) {
  return JSON.parse(readFileSync(new URL(`../scripts/fixtures/platform/${name}`, import.meta.url), 'utf8'));
}

const userFixture = readFixture('user.json');
const tasksFixture = readFixture('tasks.json');
const dictsFixture = readFixture('dicts.json');
const remarksFixture = readFixture('remarks.json');
const filesFixture = readFixture('files.json');

const TASK_CODE = 'YGFNXDJRFWDJSYJJYY-647';
const OTHER_TASK_CODE = 'HTSMART-12';

/** Start a mock, run `fn(mock)`, and always close the server. */
async function withMock(fn, options = {}) {
  const mock = await createMockPlatform({
    token: TOKEN,
    fixturesDir: FIXTURES_DIR,
    ...options,
  });
  try {
    return await fn(mock);
  } finally {
    await mock.close();
  }
}

/** fetch double that records calls and delegates to `handler`. */
function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Happy paths / request contract
// ---------------------------------------------------------------------------

test('all six endpoints return unwrapped data and send Htwisdom-Auth', async () => {
  await withMock(async (mock) => {
    const client = createPlatformClient({ baseUrl: mock.url, token: TOKEN });
    assert.equal(client.baseUrl, `${mock.url}/`);

    const user = await client.getUser();
    assert.equal(user.ok, true);
    assert.deepEqual(user.data, userFixture.user);

    const firstPage = await client.listMyTasks({
      assigneeId: user.data.id,
      page: 1,
      size: 2,
      descs: 'createdTime',
    });
    assert.equal(firstPage.ok, true);
    assert.equal(firstPage.data.records.length, 2);
    assert.equal(firstPage.data.total, String(tasksFixture.length));
    assert.equal(firstPage.data.current, '1');
    assert.equal(firstPage.data.size, '2');

    const detail = await client.getTask(TASK_CODE);
    assert.equal(detail.ok, true);
    assert.deepEqual(detail.data, tasksFixture.find((task) => task.taskCode === TASK_CODE));

    const dicts = await client.getDicts();
    assert.equal(dicts.ok, true);
    assert.deepEqual(dicts.data, dictsFixture);
    assert.ok(dicts.data.teamTaskStatus.length >= 3);

    const remarks = await client.getRemarks(TASK_CODE);
    assert.equal(remarks.ok, true);
    const expectedRemarks = remarksFixture
      .filter((remark) => remark.refTaskCode === TASK_CODE)
      .map((remark) => ({ ...remark, content: decodeURIComponent(remark.content) }));
    assert.deepEqual(remarks.data, expectedRemarks);

    const files = await client.listFiles(6470001);
    assert.equal(files.ok, true);
    assert.deepEqual(
      files.data,
      filesFixture.filter((file) => String(file.refBusinessId) === '6470001'),
    );

    // Request contract: seven calls, path + query + method + body recorded.
    assert.equal(mock.requests.length, 6);
    assert.equal(mock.requests.every((request) => 'htwisdom-auth' in request.headers), true);
    assert.equal(mock.requests.every((request) => typeof request.headers['htwisdom-auth'] === 'string'), true);

    const listRequest = mock.requests.find((request) => request.path === '/api/htwisdom-team/task');
    assert.equal(listRequest.query.current, '1');
    assert.equal(listRequest.query.size, '2');
    assert.equal(listRequest.query.refHandlerPersonId, String(userFixture.user.id));
    assert.equal(listRequest.query.descs, 'createdTime');

    const detailRequest = mock.requests.find((request) => request.path.startsWith('/api/htwisdom-team/task/detailByTaskCode/'));
    assert.equal(detailRequest.path, `/api/htwisdom-team/task/detailByTaskCode/${TASK_CODE}`);

    const dictRequest = mock.requests.find((request) => request.path === '/api/htwisdom-system/dict/business/dictionary');
    assert.equal(dictRequest.query.codes, DICT_CODES);

    const remarkRequest = mock.requests.find((request) => request.path === '/api/htwisdom-team/remark/list');
    assert.equal(remarkRequest.query.refTaskCode, TASK_CODE);
    assert.equal(remarkRequest.query.remarkType, '001_TASK');

    const fileRequest = mock.requests.find((request) => request.path === '/api/htwisdom-team/file/list');
    assert.equal(fileRequest.method, 'POST');
    assert.deepEqual(fileRequest.body, { refBusinessIdList: ['6470001'] });

    // The mock stores fixtures, not the token; recorded requests must not leak it.
    assert.equal(JSON.stringify(mock.requests).includes(TOKEN), false);
  });
});

test('pagination, taskStatusList filtering and listMyTasks validation', async () => {
  await withMock(async (mock) => {
    const client = createPlatformClient({ baseUrl: mock.url, token: TOKEN });

    const firstPage = await client.listMyTasks({ assigneeId: 10086, page: 1, size: 2, descs: 'createdTime' });
    assert.equal(firstPage.ok, true);
    assert.deepEqual(firstPage.data.records.map((task) => task.taskCode), [
      'YGFNXDJRFWDJSYJJYY-648',
      TASK_CODE,
    ]);

    const secondPage = await client.listMyTasks({ assigneeId: 10086, page: 2, size: 2 });
    assert.equal(secondPage.ok, true);
    assert.deepEqual(secondPage.data.records.map((task) => task.taskCode), [OTHER_TASK_CODE]);
    assert.equal(secondPage.data.current, '2');
    assert.equal(secondPage.data.total, '3');

    const doingStatus = tasksFixture.find((task) => task.taskCode === TASK_CODE).taskStatus;
    const filtered = await client.listMyTasks({
      assigneeId: 10086,
      page: 1,
      size: 10,
      taskStatusList: [doingStatus],
    });
    assert.equal(filtered.ok, true);
    assert.equal(filtered.data.total, '1');
    assert.equal(filtered.data.records[0].taskStatus, doingStatus);
    const filteredRequest = mock.requests.at(-1);
    assert.equal(filteredRequest.query.taskStatusList, doingStatus);

    const createdStatus = tasksFixture.find((task) => task.taskCode === OTHER_TASK_CODE).taskStatus;
    const multiStatus = await client.listMyTasks({
      assigneeId: 10086,
      page: 1,
      size: 10,
      taskStatusList: [doingStatus, createdStatus],
    });
    assert.equal(multiStatus.ok, true);
    assert.equal(multiStatus.data.total, '2');
    assert.deepEqual(mock.requests.at(-1).query.taskStatusList, [doingStatus, createdStatus]);

    const unknownAssignee = await client.listMyTasks({ assigneeId: 99999, page: 1, size: 10 });
    assert.equal(unknownAssignee.ok, true);
    assert.equal(unknownAssignee.data.total, '0');
    assert.deepEqual(unknownAssignee.data.records, []);

    const missingAssignee = await client.listMyTasks({ page: 1, size: 10 });
    assert.equal(missingAssignee.ok, false);
    assert.equal(missingAssignee.code, 'invalid-request');

    const badPage = await client.listMyTasks({ assigneeId: 10086, page: 0, size: 10 });
    assert.equal(badPage.ok, false);
    assert.equal(badPage.code, 'invalid-request');

    // Invalid-request failures never reach the network.
    assert.equal(mock.requests.length, 5);
  });
});

test('remarks decode percent-encoding and keep malformed content raw', async () => {
  await withMock(async (mock) => {
    const client = createPlatformClient({ baseUrl: mock.url, token: TOKEN });

    const decoded = await client.getRemarks(TASK_CODE);
    assert.equal(decoded.ok, true);
    assert.ok(decoded.data.every((remark) => !remark.content.includes('%E5') && !remark.content.includes('%E4')));

    const raw = await client.getRemarks(OTHER_TASK_CODE);
    assert.equal(raw.ok, true);
    assert.equal(raw.data.length, 1);
    assert.equal(raw.data[0].content, remarksFixture.find((remark) => remark.refTaskCode === OTHER_TASK_CODE).content);
    assert.equal(raw.data[0].content.includes('%'), true);
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

test('401 maps to platform-unauthorized without leaking the token', async () => {
  await withMock(async (mock) => {
    const wrong = createPlatformClient({ baseUrl: mock.url, token: OTHER_TOKEN });
    const unauthorized = await wrong.getUser();
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.code, 'platform-unauthorized');
    assert.equal(unauthorized.status, 401);
    assert.equal(JSON.stringify(unauthorized).includes(OTHER_TOKEN), false);
    assert.equal(JSON.stringify(unauthorized).includes(TOKEN), false);

    const anonymous = createPlatformClient({ baseUrl: mock.url, token: '' });
    const missing = await anonymous.getUser();
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'platform-unauthorized');
    assert.equal(missing.status, 401);
    assert.equal('htwisdom-auth' in mock.requests.at(-1).headers, false);
  });
});

test('404 maps to platform-not-found and unknown paths stay 404 in the mock', async () => {
  await withMock(async (mock) => {
    const client = createPlatformClient({ baseUrl: mock.url, token: TOKEN });

    const missingTask = await client.getTask('YGFNXDJRFWDJSYJJYY-9999');
    assert.equal(missingTask.ok, false);
    assert.equal(missingTask.code, 'platform-not-found');
    assert.equal(missingTask.status, 404);
    assert.equal(JSON.stringify(missingTask).includes(TOKEN), false);

    const unknown = await fetch(`${mock.url}/api/htwisdom-team/does-not-exist`, {
      headers: { 'Htwisdom-Auth': TOKEN },
    });
    assert.equal(unknown.status, 404);
    const envelope = await unknown.json();
    assert.equal(envelope.code, 404);
    assert.equal(envelope.success, false);
  });
});

test('non-2xx status maps to platform-http with the status attached', async () => {
  const { fetchImpl, calls } = stubFetch(() => jsonResponse({ code: 500, success: false, msg: '服务器异常' }, 500));
  const client = createPlatformClient({
    baseUrl: 'https://platform.example.com',
    token: TOKEN,
    fetchImpl,
  });

  const result = await client.getUser();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'platform-http');
  assert.equal(result.status, 500);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['Htwisdom-Auth'] === TOKEN, true);
  assert.equal(calls[0].init.headers.Accept, 'application/json');
});

test('envelope failures and malformed bodies map to platform-bad-response/platform-http', async () => {
  const cases = [
    {
      name: 'non-JSON body',
      response: () => new Response('<html>gateway error</html>', { status: 200 }),
      code: 'platform-bad-response',
    },
    {
      name: 'JSON array instead of envelope',
      response: () => jsonResponse([1, 2, 3]),
      code: 'platform-bad-response',
    },
    {
      name: 'envelope without data',
      response: () => jsonResponse({ code: 200, success: true }),
      code: 'platform-bad-response',
    },
    {
      name: 'envelope without user',
      response: () => jsonResponse({ code: 200, success: true, data: {} }),
      code: 'platform-bad-response',
    },
  ];

  for (const item of cases) {
    const { fetchImpl } = stubFetch(item.response);
    const client = createPlatformClient({
      baseUrl: 'https://platform.example.com',
      token: TOKEN,
      fetchImpl,
    });
    const result = await client.getUser();
    assert.equal(result.ok, false, item.name);
    assert.equal(result.code, item.code, item.name);
    assert.equal(result.message.includes(TOKEN), false, item.name);
    assert.equal(JSON.stringify(result).includes(TOKEN), false, item.name);
  }

  // A 2xx envelope that reports a business failure is an upstream HTTP error,
  // not a malformed body; keep the upstream code for diagnostics.
  const { fetchImpl } = stubFetch(() => jsonResponse({ code: 500, success: false, msg: '服务器异常' }, 200));
  const client = createPlatformClient({
    baseUrl: 'https://platform.example.com',
    token: TOKEN,
    fetchImpl,
  });
  const businessFailure = await client.getUser();
  assert.equal(businessFailure.ok, false);
  assert.equal(businessFailure.code, 'platform-http');
  assert.equal(businessFailure.status, 200);
  assert.equal(businessFailure.upstreamCode, 500);
});

test('fetch rejection and timeout map to platform-network', async () => {
  const rejected = createPlatformClient({
    baseUrl: 'https://platform.example.com',
    token: TOKEN,
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  const network = await rejected.getUser();
  assert.equal(network.ok, false);
  assert.equal(network.code, 'platform-network');
  assert.equal('status' in network, false);
  assert.equal(JSON.stringify(network).includes(TOKEN), false);

  const { fetchImpl } = stubFetch((_url, init) => new Promise((resolve, reject) => {
    // A ref'd timer keeps the event loop alive while we wait for the client's
    // AbortSignal; without it Node may exit before an unref'd timeout fires.
    // If the client never aborts, resolve a valid response so the assertion
    // fails with a clear result instead of hanging the test runner.
    const hold = setTimeout(() => {
      resolve(jsonResponse({ code: 200, success: true, data: { user: { id: 1 } } }));
    }, 500);
    init.signal.addEventListener('abort', () => {
      clearTimeout(hold);
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  }));
  const timeoutClient = createPlatformClient({
    baseUrl: 'https://platform.example.com',
    token: TOKEN,
    fetchImpl,
    timeoutMs: 25,
  });
  const startedAt = Date.now();
  const timeout = await timeoutClient.getUser();
  const elapsed = Date.now() - startedAt;
  assert.equal(timeout.ok, false);
  assert.equal(timeout.code, 'platform-network');
  assert.equal(JSON.stringify(timeout).includes(TOKEN), false);
  assert.ok(elapsed < 1000, `timeout should fire quickly, took ${elapsed}ms`);
});

test('mock rejects the dictionary endpoint without codes and the file endpoint with a bad body', async () => {
  await withMock(async (mock) => {
    const headers = { 'Htwisdom-Auth': TOKEN };

    const dict = await fetch(`${mock.url}/api/htwisdom-system/dict/business/dictionary`, { headers });
    assert.equal(dict.status, 400);
    const dictEnvelope = await dict.json();
    assert.equal(dictEnvelope.code, 400);
    assert.equal(dictEnvelope.success, false);
    assert.equal(dictEnvelope.msg, '字典编码不可为空');

    const file = await fetch(`${mock.url}/api/htwisdom-team/file/list`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refBusinessIdList: 'not-an-array' }),
    });
    assert.equal(file.status, 400);
    const fileEnvelope = await file.json();
    assert.equal(fileEnvelope.code, 400);
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('normalizeBaseUrl accepts http(s) + localhost and normalizes trailing slashes', () => {
  const valid = [
    ['https://ecard.htwisdom.cn', 'https://ecard.htwisdom.cn/'],
    ['  https://ecard.htwisdom.cn/  ', 'https://ecard.htwisdom.cn/'],
    ['http://127.0.0.1:1234', 'http://127.0.0.1:1234/'],
    ['http://localhost:8080///', 'http://localhost:8080/'],
    ['HTTP://LOCALHOST:8080', 'http://localhost:8080/'],
    ['https://example.com/proxy/team/', 'https://example.com/proxy/team/'],
  ];
  for (const [input, expected] of valid) {
    assert.deepEqual(normalizeBaseUrl(input), { ok: true, baseUrl: expected });
  }

  const invalid = [
    undefined,
    null,
    42,
    '',
    '   ',
    'not a url',
    'ftp://platform.example.com',
    'file:///tmp/platform',
    'javascript:alert(1)',
    '//platform.example.com',
    'https://user:secret@platform.example.com',
    'https://platform.example.com?tenant=1',
    'https://platform.example.com/#fragment',
  ];
  for (const input of invalid) {
    const result = normalizeBaseUrl(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid-base-url');
    assert.equal(typeof result.message, 'string');
    assert.equal(result.message.includes('secret'), false);
  }
});

test('createPlatformClient throws invalid-base-url before any fetch', () => {
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return jsonResponse({ code: 200, success: true, data: {} });
  };

  assert.throws(
    () => createPlatformClient({ baseUrl: 'ftp://platform.example.com', token: TOKEN, fetchImpl }),
    (error) => {
      assert.ok(error instanceof PlatformError);
      assert.equal(error.name, 'PlatformError');
      assert.equal(error.ok, false);
      assert.equal(error.code, 'invalid-base-url');
      assert.equal(error.message.includes(TOKEN), false);
      assert.deepEqual(error.toResult(), {
        ok: false,
        code: 'invalid-base-url',
        message: error.message,
      });
      return true;
    },
  );

  assert.throws(
    () => createPlatformClient({ baseUrl: 'https://user:secret@platform.example.com', token: TOKEN, fetchImpl }),
    (error) => {
      assert.equal(error.code, 'invalid-base-url');
      assert.equal(error.message.includes('secret'), false);
      return true;
    },
  );

  assert.equal(fetches, 0);
});

test('buildPath repeats array parameters, skips blanks and encodes values', () => {
  const built = new URL(
    buildPath('/api/htwisdom-team/task', {
      current: 1,
      size: 2,
      refHandlerPersonId: 10086,
      descs: undefined,
      taskStatusList: ['001_CREATE', '002_DOING'],
      empty: '',
      nullish: null,
    }),
    'http://mock.local',
  );
  assert.deepEqual(built.searchParams.getAll('taskStatusList'), ['001_CREATE', '002_DOING']);
  assert.equal(built.searchParams.get('current'), '1');
  assert.equal(built.searchParams.get('size'), '2');
  assert.equal(built.searchParams.get('refHandlerPersonId'), '10086');
  assert.equal(built.searchParams.has('descs'), false);
  assert.equal(built.searchParams.has('empty'), false);
  assert.equal(built.searchParams.has('nullish'), false);

  const dict = new URL(buildPath('/api/dict', { codes: DICT_CODES }), 'http://mock.local');
  assert.equal(dict.searchParams.get('codes'), DICT_CODES);

  assert.throws(() => buildPath('api/relative'), TypeError);
  assert.throws(() => buildPath('/api/x', null), TypeError);
});

test('parseMockArgs handles CLI options without spawning a process', () => {
  const defaults = parseMockArgs([]);
  assert.equal(defaults.port, 0);
  assert.equal(defaults.token, 'test-token');
  assert.equal(defaults.latencyMs, 0);
  assert.equal(defaults.help, false);
  assert.equal(defaults.fixturesDir, DEFAULT_FIXTURES_DIR);

  const parsed = parseMockArgs([
    '--port', '3210',
    '--token', 'cli-token',
    '--fixtures', '/tmp/platform-fixtures',
    '--latency', '15',
  ]);
  assert.equal(parsed.port, 3210);
  assert.equal(parsed.token, 'cli-token');
  assert.equal(parsed.fixturesDir, '/tmp/platform-fixtures');
  assert.equal(parsed.latencyMs, 15);

  assert.equal(parseMockArgs(['--help']).help, true);
  assert.throws(() => parseMockArgs(['--unknown']), /unknown argument/);
  assert.throws(() => parseMockArgs(['--port']), /requires a value/);
  assert.throws(() => parseMockArgs(['--port', '70000']), /between 0 and 65535/);
});
