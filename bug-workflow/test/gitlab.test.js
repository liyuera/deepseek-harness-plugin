/**
 * Contract tests for the GitLab HTTP client (P5 Task 2).
 *
 * Every network-facing case runs against a loopback `node:http` mock on an
 * ephemeral 127.0.0.1 port (the same style as `platform.test.js`): the real
 * `fetch` path is exercised for auth headers, URL/project encoding, MR/note
 * payload mapping, status mapping, redirects, timeouts and the response-size
 * cap. A fetch double is used only where a real server cannot express the
 * case deterministically (no-token "fetch must not be called", a provider that
 * throws) or where the client's fetch options need direct inspection.
 *
 * Security assertions compare `JSON.stringify(error/requests).includes(TOKEN)`
 * as booleans, and the mock redacts the `PRIVATE-TOKEN` value it records, so a
 * failed assertion cannot print the token.
 *
 * The last case wires the two real P0 review fixtures through the client and
 * `parseReview`, proving the notes → parser pipeline that Task 4 will use.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  DEFAULT_TIMEOUT_MS,
  GitlabError,
  MAX_RESPONSE_BYTES,
  createGitlabClient,
  normalizeBaseUrl,
  normalizeProject,
} from '../src/host/gitlab.js';
import { parseReview } from '../src/host/review-parser.js';

const TOKEN = 'test-gitlab-token';
const WRONG_TOKEN = 'wrong-gitlab-token';
const REDACTED = '[redacted]';

const PROJECT = 'wisdom-financial-service-platform/wisdom-financial-credit-platform-web';
const ENCODED_PROJECT = 'wisdom-financial-service-platform%2Fwisdom-financial-credit-platform-web';
const API_PROJECTS = `/api/v4/projects/${ENCODED_PROJECT}`;

const SOURCE_BRANCH = 'feat-8.2.1-ly';
const TARGET_BRANCH = 'feature-8.2.1';

const NEEDS_FIX_BODY = readFileSync(
  new URL('../scripts/fixtures/review-needs-fix.md', import.meta.url),
  'utf8',
);
const PASS_BODY = readFileSync(
  new URL('../scripts/fixtures/review-pass.md', import.meta.url),
  'utf8',
);

function defaultMergeRequest(overrides = {}) {
  return {
    iid: 12,
    web_url: `https://git.example.com/${PROJECT}/-/merge_requests/12`,
    source_branch: SOURCE_BRANCH,
    target_branch: TARGET_BRANCH,
    state: 'opened',
    title: `${SOURCE_BRANCH} -> ${TARGET_BRANCH}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Loopback mock GitLab
// ---------------------------------------------------------------------------

/** Start a mock, run `fn(mock)`, and always close the server. */
async function withMock(fn, options = {}) {
  const mock = await createMockGitlab(options);
  try {
    return await fn(mock);
  } finally {
    await mock.close();
  }
}

/** Build a client against a mock with the standard test token. */
function clientFor(mock, overrides = {}) {
  return createGitlabClient({
    baseUrl: mock.url,
    tokenProvider: async () => TOKEN,
    ...overrides,
  });
}

/** Start a loopback test server on an ephemeral port and resolve the port. */
function listenServer(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

/** Close a test server and its sockets so no listener survives the test. */
function closeServer(server) {
  return new Promise((resolve) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
}

/**
 * Start a loopback GitLab mock.
 *
 * Routes mirror the five client calls. `faults` is keyed by route name
 * (`user`, `listMergeRequests`, `createMergeRequest`, `getMergeRequest`,
 * `listNotes`) and is applied after auth, so a fault can model GitLab's own
 * error responses. A string fault body is sent raw (for HTML/oversized
 * bodies), anything else is JSON-encoded.
 */
async function createMockGitlab(options = {}) {
  const token = options.token ?? TOKEN;
  const user = options.user ?? { id: 9001, username: 'bug-bot', name: 'Bug Bot' };
  const mergeRequests = options.mergeRequests ?? [];
  const mergeRequest = options.mergeRequest ?? defaultMergeRequest();
  const createdMergeRequest = options.createdMergeRequest ?? defaultMergeRequest({
    iid: 77,
    web_url: `https://git.example.com/${PROJECT}/-/merge_requests/77`,
  });
  const notes = options.notes ?? [];
  const faults = options.faults ?? {};
  const latencyMs = options.latencyMs ?? 0;

  /** @type {object[]} */
  const requests = [];

  const server = createServer((request, response) => {
    // The client may abort mid-response (timeout/size cap); a mock must never
    // crash its test process because the socket went away.
    response.on('error', () => {});
    void handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { message: 'mock 内部错误' });
      else {
        try {
          response.end();
        } catch {
          // already closed
        }
      }
    });
  });

  async function handle(request, response) {
    let requestUrl;
    try {
      requestUrl = new URL(request.url ?? '/', 'http://mock.local');
    } catch {
      sendJson(response, 400, { message: '请求路径不合法' });
      return;
    }

    let rawBody = '';
    try {
      rawBody = await readRequestBody(request);
    } catch {
      sendJson(response, 400, { message: '请求体读取失败' });
      return;
    }
    let body;
    if (rawBody.trim() !== '') {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = undefined;
      }
    }

    const method = request.method ?? 'GET';
    const route = matchRoute(method, requestUrl.pathname);
    const auth = isAuthorized(request, token);
    requests.push({
      method,
      path: requestUrl.pathname,
      query: queryObject(requestUrl.searchParams),
      headers: recordHeaders(request.headers),
      body,
      auth,
      route: route?.name,
      project: route?.project,
      iid: route?.iid,
    });

    if (latencyMs > 0) await delay(latencyMs);
    if (response.writableEnded || response.destroyed) return;

    if (!auth) {
      sendJson(response, 401, { message: '401 Unauthorized' });
      return;
    }

    const fault = route === undefined ? undefined : faults[route.name];
    if (fault !== undefined) {
      sendFault(response, fault);
      return;
    }

    if (route === undefined) {
      sendJson(response, 404, { message: '404 Not Found' });
      return;
    }

    if (route.name === 'user') {
      sendJson(response, 200, user);
    } else if (route.name === 'listMergeRequests') {
      sendJson(response, 200, mergeRequests);
    } else if (route.name === 'createMergeRequest') {
      sendJson(response, 201, createdMergeRequest);
    } else if (route.name === 'getMergeRequest') {
      sendJson(response, 200, mergeRequest);
    } else if (route.name === 'listNotes') {
      sendJson(response, 200, notes);
    } else {
      sendJson(response, 404, { message: '404 Not Found' });
    }
  }

  function sendJson(response, status, payload) {
    sendText(response, status, JSON.stringify(payload), 'application/json; charset=utf-8');
  }

  function sendFault(response, fault) {
    const headers = { ...(fault.headers ?? {}) };
    if (typeof fault.body === 'string') {
      sendText(
        response,
        fault.status,
        fault.body,
        fault.contentType ?? 'text/plain; charset=utf-8',
        headers,
      );
      return;
    }
    sendText(
      response,
      fault.status,
      JSON.stringify(fault.body ?? {}),
      fault.contentType ?? 'application/json; charset=utf-8',
      headers,
    );
  }

  function sendText(response, status, text, contentType, extraHeaders = {}) {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(status, { 'Content-Type': contentType, ...extraHeaders });
    response.end(text);
  }

  const port = await listenServer(server);

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () => closeServer(server),
  };
}

function matchRoute(method, path) {
  if (method === 'GET' && path === '/api/v4/user') return { name: 'user' };

  const prefix = '/api/v4/projects/';
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return undefined;

  let project;
  try {
    project = decodeURIComponent(rest.slice(0, slash));
  } catch {
    return undefined;
  }
  const tail = rest.slice(slash);

  if (tail === '/merge_requests') {
    if (method === 'GET') return { name: 'listMergeRequests', project };
    if (method === 'POST') return { name: 'createMergeRequest', project };
    return undefined;
  }

  let match = /^\/merge_requests\/(\d+)$/.exec(tail);
  if (match !== null) {
    return method === 'GET'
      ? { name: 'getMergeRequest', project, iid: Number(match[1]) }
      : undefined;
  }
  match = /^\/merge_requests\/(\d+)\/notes$/.exec(tail);
  if (match !== null) {
    return method === 'GET'
      ? { name: 'listNotes', project, iid: Number(match[1]) }
      : undefined;
  }
  return undefined;
}

function isAuthorized(request, token) {
  const received = request.headers['private-token'];
  if (Array.isArray(received)) return received.length === 1 && received[0] === token;
  return typeof received === 'string' && received === token;
}

/** Copy request headers, replacing the auth token so fixtures/logs stay clean. */
function recordHeaders(headers) {
  const copy = {};
  for (const [key, value] of Object.entries(headers)) {
    copy[key] = key.toLowerCase() === 'private-token' ? REDACTED : value;
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

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Helpers: fetch doubles / responses
// ---------------------------------------------------------------------------

function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// Configuration: base URL + project encoding
// ---------------------------------------------------------------------------

test('normalizeBaseUrl accepts http(s), keeps a base path and strips trailing slashes', () => {
  const accepted = [
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['http://localhost:3000/', 'http://localhost:3000'],
    ['https://git.example.com/', 'https://git.example.com'],
    ['https://git.example.com///', 'https://git.example.com'],
    ['https://git.example.com/gitlab/', 'https://git.example.com/gitlab'],
    ['https://git.example.com/gitlab///', 'https://git.example.com/gitlab'],
    ['https://git.example.com:8443/gitlab', 'https://git.example.com:8443/gitlab'],
    ['  https://git.example.com/  ', 'https://git.example.com'],
    ['HTTP://Git.Example.com/Path/', 'http://git.example.com/Path'],
  ];
  for (const [input, expected] of accepted) {
    assert.deepEqual(normalizeBaseUrl(input), { ok: true, baseUrl: expected }, input);
  }
});

test('normalizeBaseUrl rejects blank, non-http(s), credentials, query and fragment without crashing', () => {
  const rejected = [
    undefined,
    null,
    42,
    {},
    [],
    '',
    '   ',
    '\n\t',
    'not a url',
    'git@git.example.com:group/project.git',
    '//git.example.com/group/project',
    'https://',
    'http://[::1',
    'ftp://git.example.com',
    'file:///tmp/repo',
    'javascript:alert(1)',
    'https://user:secret@git.example.com',
    'https://user@git.example.com',
    'https://git.example.com/?x=1',
    'https://git.example.com/gitlab?x=1',
    'https://git.example.com/#fragment',
  ];
  for (const input of rejected) {
    const result = normalizeBaseUrl(input);
    assert.equal(result.ok, false, String(input));
    assert.equal(result.code, 'invalid-project', String(input));
    assert.equal(typeof result.message, 'string');
    if (typeof input === 'string' && input.includes('secret')) {
      assert.equal(result.message.includes('secret'), false);
    }
  }
});

test('normalizeProject encodes the whole group/project path as one segment', () => {
  assert.deepEqual(normalizeProject('group/project'), {
    ok: true,
    project: 'group/project',
    encoded: 'group%2Fproject',
  });
  assert.equal(normalizeProject('group/subgroup/project').encoded, 'group%2Fsubgroup%2Fproject');
  assert.equal(normalizeProject('group-name/project.name').encoded, 'group-name%2Fproject.name');
  assert.equal(normalizeProject('组/项目').encoded, encodeURIComponent('组/项目'));
  assert.equal(normalizeProject('group/project').encoded.includes('/'), false);
});

test('normalizeProject rejects traversal, blank, whitespace and URL-breaking input', () => {
  const rejected = [
    undefined,
    null,
    42,
    {},
    [],
    '',
    '   ',
    'project',
    '/group/project',
    'group/project/',
    'group//project',
    'group/../project',
    '../project',
    'group/./project',
    './group/project',
    ' group/project',
    'group/project ',
    'group/pr oject',
    'group/pro\u0000ject',
    'group%2Fproject',
    'group/project?x=1',
    'group/project#fragment',
    'group\\project',
    'group/..',
    'group/.',
    Array.from({ length: 21 }, (_, index) => `g${index}`).join('/'),
  ];
  for (const input of rejected) {
    const result = normalizeProject(input);
    assert.equal(result.ok, false, String(input));
    assert.equal(result.code, 'invalid-project', String(input));
    assert.equal(typeof result.message, 'string');
  }
});

test('createGitlabClient validates configuration eagerly', () => {
  assert.throws(
    () => createGitlabClient({ baseUrl: 'ftp://git.example.com', tokenProvider: async () => TOKEN }),
    (error) => error instanceof GitlabError && error.code === 'invalid-project',
  );
  assert.throws(
    () => createGitlabClient({ baseUrl: 'https://user:pass@git.example.com', tokenProvider: async () => TOKEN }),
    (error) => error instanceof GitlabError && error.code === 'invalid-project',
  );
  assert.throws(() => createGitlabClient(null), TypeError);
  assert.throws(() => createGitlabClient('options'), TypeError);
  assert.throws(
    () => createGitlabClient({ baseUrl: 'https://git.example.com', tokenProvider: async () => TOKEN, fetchImpl: 'nope' }),
    TypeError,
  );
  assert.throws(
    () => createGitlabClient({ baseUrl: 'https://git.example.com', tokenProvider: null }),
    TypeError,
  );

  // Defaults are pure configuration: constructing does not call the provider.
  let providerCalls = 0;
  const client = createGitlabClient({
    baseUrl: 'https://git.example.com',
    tokenProvider: async () => {
      providerCalls += 1;
      return TOKEN;
    },
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });
  assert.equal(typeof client.getCurrentUser, 'function');
  assert.equal(providerCalls, 0);
  assert.equal(DEFAULT_TIMEOUT_MS, 15_000);
});

// ---------------------------------------------------------------------------
// Happy path / request contract
// ---------------------------------------------------------------------------

test('getCurrentUser sends PRIVATE-TOKEN only and uses fail-closed fetch options', async () => {
  await withMock(async (mock) => {
    let captured;
    const client = createGitlabClient({
      baseUrl: `${mock.url}/`,
      tokenProvider: async () => TOKEN,
      fetchImpl: (url, init) => {
        captured = { url: String(url), init };
        return fetch(url, init);
      },
    });

    const user = await client.getCurrentUser();
    assert.deepEqual(user, { id: 9001, username: 'bug-bot' });

    assert.equal(captured.url, `${mock.url}/api/v4/user`);
    assert.equal(captured.init.method, 'GET');
    assert.equal(captured.init.redirect, 'error');
    assert.equal(captured.init.credentials, 'omit');
    assert.equal(captured.init.signal instanceof AbortSignal, true);
    assert.equal(captured.init.headers.Accept, 'application/json');
    assert.equal(captured.init.headers['PRIVATE-TOKEN'], TOKEN);

    const headerNames = Object.keys(captured.init.headers).map((key) => key.toLowerCase());
    assert.deepEqual(headerNames.sort(), ['accept', 'private-token']);

    // Request URL never carries the token; the mock recorded a redacted header.
    assert.equal(captured.url.includes(TOKEN), false);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].path, '/api/v4/user');
    assert.deepEqual(mock.requests[0].query, {});
    assert.equal(mock.requests[0].headers['private-token'], REDACTED);
    assert.equal(mock.requests[0].auth, true);
    assert.equal(JSON.stringify(mock.requests).includes(TOKEN), false);
  });
});

test('an absent, blank or failing tokenProvider yields no-token without any fetch', async () => {
  const { fetchImpl, calls } = stubFetch(() => new Response('{}', { status: 200 }));
  const values = [null, undefined, '', '   ', 42, {}];
  for (const value of values) {
    const client = createGitlabClient({
      baseUrl: 'https://git.example.com',
      tokenProvider: async () => value,
      fetchImpl,
    });
    for (const call of [
      () => client.getCurrentUser(),
      () => client.findOpenMergeRequest({ project: PROJECT, sourceBranch: SOURCE_BRANCH }),
      () => client.createMergeRequest({
        project: PROJECT,
        sourceBranch: SOURCE_BRANCH,
        targetBranch: TARGET_BRANCH,
        title: 'title',
      }),
      () => client.getMergeRequest({ project: PROJECT, iid: 1 }),
      () => client.listNotes({ project: PROJECT, iid: 1 }),
    ]) {
      await assert.rejects(call(), (error) => {
        assert.equal(error instanceof GitlabError, true);
        assert.equal(error.code, 'no-token');
        assert.equal(error.message.includes(TOKEN), false);
        return true;
      });
    }
  }

  const throwing = createGitlabClient({
    baseUrl: 'https://git.example.com',
    tokenProvider: async () => {
      throw new Error(`credentials-local: failed to resolve ${TOKEN}`);
    },
    fetchImpl,
  });
  await assert.rejects(throwing.getCurrentUser(), (error) => {
    assert.equal(error.code, 'no-token');
    assert.equal(JSON.stringify(error).includes(TOKEN), false);
    return true;
  });

  // Every no-token path rejected before the transport was touched.
  assert.equal(calls.length, 0);
});

test('invalid project/iid/branch/title arguments reject before any fetch', async () => {
  let providerCalls = 0;
  const { fetchImpl, calls } = stubFetch(() => new Response('{}', { status: 200 }));
  const client = createGitlabClient({
    baseUrl: 'https://git.example.com',
    tokenProvider: async () => {
      providerCalls += 1;
      return TOKEN;
    },
    fetchImpl,
  });

  const badProjects = [
    '', 'project', '/group/project', 'group/project/', 'group//project',
    'group/../project', 'group%2Fproject', 'group/project?x=1', 'group/project#x',
    ' group/project', 'group/project ', 'group\\project',
  ];
  for (const project of badProjects) {
    await assert.rejects(
      client.listNotes({ project, iid: 1 }),
      (error) => error.code === 'invalid-project',
      project,
    );
  }

  for (const iid of [0, -1, 1.5, 'abc', '1.5', null, undefined, {}, [], true]) {
    await assert.rejects(
      client.getMergeRequest({ project: PROJECT, iid }),
      (error) => error.code === 'invalid-merge-request',
      String(iid),
    );
    await assert.rejects(
      client.listNotes({ project: PROJECT, iid }),
      (error) => error.code === 'invalid-merge-request',
      String(iid),
    );
  }

  const badCreateInputs = [
    { sourceBranch: '', targetBranch: TARGET_BRANCH, title: 't' },
    { sourceBranch: 'bad branch', targetBranch: TARGET_BRANCH, title: 't' },
    { sourceBranch: SOURCE_BRANCH, targetBranch: '', title: 't' },
    { sourceBranch: SOURCE_BRANCH, targetBranch: '-danger', title: 't' },
    { sourceBranch: SOURCE_BRANCH, targetBranch: TARGET_BRANCH, title: '' },
    { sourceBranch: SOURCE_BRANCH, targetBranch: TARGET_BRANCH, title: '   ' },
    { sourceBranch: SOURCE_BRANCH, targetBranch: TARGET_BRANCH, title: 42 },
    { sourceBranch: SOURCE_BRANCH, targetBranch: TARGET_BRANCH, title: 't', description: 42 },
  ];
  for (const input of badCreateInputs) {
    await assert.rejects(
      client.createMergeRequest({ project: PROJECT, ...input }),
      (error) => error.code === 'invalid-merge-request',
      JSON.stringify(input),
    );
  }

  assert.equal(calls.length, 0);
  assert.equal(providerCalls, 0);
});

// ---------------------------------------------------------------------------
// HTTP status / transport error taxonomy
// ---------------------------------------------------------------------------

test('HTTP statuses map to the stable GitlabError taxonomy and never echo the token', async () => {
  const cases = [
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [409, 'conflict'],
    [429, 'rate-limited'],
    [422, 'bad-response'],
    [500, 'network'],
    [502, 'network'],
    [503, 'network'],
  ];

  for (const [status, code] of cases) {
    await withMock(async (mock) => {
      const client = clientFor(mock);
      await assert.rejects(client.getCurrentUser(), (error) => {
        assert.equal(error instanceof GitlabError, true, `status ${status}`);
        assert.equal(error.code, code, `status ${status}`);
        assert.equal(error.status, status, `status ${status}`);
        assert.equal(typeof error.message, 'string');
        // The upstream fault body deliberately quotes the token; the static
        // message (and the serialized error) must not.
        assert.equal(error.message.includes(TOKEN), false, `status ${status}`);
        assert.equal(JSON.stringify(error).includes(TOKEN), false, `status ${status}`);
        return true;
      });
    }, {
      faults: { user: { status, body: { message: `upstream failure for ${TOKEN}` } } },
    });
  }
});

test('a rejected token maps to unauthorized (mock auth check)', async () => {
  await withMock(async (mock) => {
    const client = clientFor(mock, { tokenProvider: async () => WRONG_TOKEN });
    await assert.rejects(client.getCurrentUser(), (error) => {
      assert.equal(error.code, 'unauthorized');
      assert.equal(error.status, 401);
      assert.equal(JSON.stringify(error).includes(WRONG_TOKEN), false);
      return true;
    });
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].auth, false);
    assert.equal(JSON.stringify(mock.requests).includes(WRONG_TOKEN), false);
  });
});

test('a reset connection maps to network without leaking the token', async () => {
  const server = createServer();
  server.on('connection', (socket) => socket.destroy());
  const port = await listenServer(server);
  try {
    const client = createGitlabClient({
      baseUrl: `http://127.0.0.1:${port}`,
      tokenProvider: async () => TOKEN,
    });
    await assert.rejects(client.getCurrentUser(), (error) => {
      assert.equal(error.code, 'network');
      assert.equal('status' in error, false);
      assert.equal(JSON.stringify(error).includes(TOKEN), false);
      return true;
    });
  } finally {
    await closeServer(server);
  }
});

test('a transport rejection that quotes the token still returns the static network message', async () => {
  const client = createGitlabClient({
    baseUrl: 'https://git.example.com',
    tokenProvider: async () => TOKEN,
    fetchImpl: async () => {
      throw new Error(`connect failed with token ${TOKEN}`);
    },
  });
  await assert.rejects(client.getCurrentUser(), (error) => {
    assert.equal(error.code, 'network');
    assert.equal(JSON.stringify(error).includes(TOKEN), false);
    return true;
  });
});

test('the AbortController timeout maps to timeout', async () => {
  await withMock(async (mock) => {
    const client = clientFor(mock, { timeoutMs: 25 });
    const startedAt = Date.now();
    await assert.rejects(client.getCurrentUser(), (error) => {
      assert.equal(error instanceof GitlabError, true);
      assert.equal(error.code, 'timeout');
      assert.equal(JSON.stringify(error).includes(TOKEN), false);
      return true;
    });
    assert.ok(Date.now() - startedAt < 1000, 'timeout should fire quickly');
    // The request did reach the mock before the abort.
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].auth, true);
  }, { latencyMs: 250 });
});

test('non-JSON, HTML and malformed JSON bodies map to bad-response', async () => {
  const bodies = [
    '<!doctype html><html><body>login</body></html>',
    '{"id":',
    '\u0000binary',
  ];
  for (const body of bodies) {
    await withMock(async (mock) => {
      await assert.rejects(clientFor(mock).getCurrentUser(), (error) => {
        assert.equal(error.code, 'bad-response');
        assert.equal(error.status, 200);
        return true;
      });
    }, {
      faults: { user: { status: 200, body, contentType: 'text/html; charset=utf-8' } },
    });
  }
});

test('an oversized response body is rejected before JSON parsing', async () => {
  await withMock(async (mock) => {
    await assert.rejects(clientFor(mock).getCurrentUser(), (error) => {
      assert.equal(error.code, 'bad-response');
      assert.equal(error.status, 200);
      return true;
    });
  }, {
    // A string fault body is written raw; Node uses chunked encoding here, so
    // this exercises the streaming cap rather than only Content-Length.
    faults: { user: { status: 200, body: 'x'.repeat(MAX_RESPONSE_BYTES + 1) } },
  });
});

test('a 301 redirect is never followed and never forwards PRIVATE-TOKEN', async () => {
  const stolenRequests = [];
  const stealServer = createServer((request, response) => {
    stolenRequests.push({ url: request.url, headers: { ...request.headers } });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 666, username: 'foreign' }));
  });
  const stealPort = await listenServer(stealServer);
  try {
    await withMock(async (mock) => {
      await assert.rejects(clientFor(mock).getCurrentUser(), (error) => {
        assert.equal(error instanceof GitlabError, true);
        assert.equal(error.code, 'bad-response');
        assert.equal(JSON.stringify(error).includes(TOKEN), false);
        return true;
      });
      assert.equal(mock.requests.length, 1);
      assert.equal(mock.requests[0].headers['private-token'], REDACTED);
      assert.equal(JSON.stringify(mock.requests).includes(TOKEN), false);
      assert.equal(stolenRequests.length, 0, 'redirect target must not receive a request');
      assert.equal(
        stolenRequests.some((request) => 'private-token' in request.headers),
        false,
      );
    }, {
      faults: {
        user: {
          status: 301,
          headers: { Location: `http://127.0.0.1:${stealPort}/steal` },
          body: '',
        },
      },
    });
  } finally {
    await closeServer(stealServer);
  }
});

test('a custom fetch returning a 3xx Response is rejected instead of followed', async () => {
  const client = createGitlabClient({
    baseUrl: 'https://git.example.com',
    tokenProvider: async () => TOKEN,
    fetchImpl: async () => new Response('', { status: 302, headers: { Location: 'https://evil.example' } }),
  });
  await assert.rejects(client.getCurrentUser(), (error) => {
    assert.equal(error.code, 'bad-response');
    assert.equal(error.status, 302);
    return true;
  });
});

test('a 2xx response object without a readable body maps to bad-response', async () => {
  const client = createGitlabClient({
    baseUrl: 'https://git.example.com',
    tokenProvider: async () => TOKEN,
    fetchImpl: async () => ({ status: 200 }),
  });
  await assert.rejects(client.getCurrentUser(), (error) => {
    assert.equal(error.code, 'bad-response');
    assert.equal(error.status, 200);
    return true;
  });
});

// ---------------------------------------------------------------------------
// MR endpoints
// ---------------------------------------------------------------------------

test('findOpenMergeRequest returns null when no open MR matches', async () => {
  await withMock(async (mock) => {
    const found = await clientFor(mock).findOpenMergeRequest({
      project: PROJECT,
      sourceBranch: SOURCE_BRANCH,
    });
    assert.equal(found, null);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].path, `${API_PROJECTS}/merge_requests`);
    assert.deepEqual(mock.requests[0].query, {
      state: 'opened',
      source_branch: SOURCE_BRANCH,
      per_page: '100',
    });
  }, {
    mergeRequests: [
      { iid: 4, source_branch: 'other', state: 'opened' },
      { iid: 5, source_branch: SOURCE_BRANCH, state: 'merged' },
    ],
  });
});

test('findOpenMergeRequest matches the source branch defensively and tolerates malformed entries', async () => {
  const expected = defaultMergeRequest({ iid: 3, source_branch: SOURCE_BRANCH });
  await withMock(async (mock) => {
    const found = await clientFor(mock).findOpenMergeRequest({
      project: PROJECT,
      sourceBranch: SOURCE_BRANCH,
    });
    assert.deepEqual(found, {
      iid: 3,
      url: expected.web_url,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
      state: 'opened',
      title: expected.title,
    });
    // The project path crossed the wire as one encoded segment.
    assert.equal(mock.requests[0].path.includes(ENCODED_PROJECT), true);
    assert.equal(mock.requests[0].path.includes('/wisdom-financial-service-platform/'), false);
    assert.equal(mock.requests[0].project, PROJECT);
  }, {
    mergeRequests: [
      null,
      'not-a-mr',
      42,
      { iid: 1, source_branch: 'other', state: 'opened' },
      { iid: 2, source_branch: SOURCE_BRANCH, state: 'merged' },
      { source_branch: SOURCE_BRANCH, state: 'opened', web_url: 'no iid' },
      { iid: '3', source_branch: SOURCE_BRANCH, state: 'opened', web_url: expected.web_url, target_branch: TARGET_BRANCH, title: expected.title },
      { iid: 99, source_branch: SOURCE_BRANCH, state: 'opened' },
    ],
  });
});

test('findOpenMergeRequest encodes a source branch containing a slash in the query', async () => {
  await withMock(async (mock) => {
    const found = await clientFor(mock).findOpenMergeRequest({
      project: PROJECT,
      sourceBranch: 'feat/nested-branch',
    });
    assert.equal(found, null);
    assert.equal(mock.requests[0].query.source_branch, 'feat/nested-branch');
    assert.equal(mock.requests[0].path, `${API_PROJECTS}/merge_requests`);
  });
});

test('createMergeRequest posts exactly the contract fields (no reviewer_ids) and maps the response', async () => {
  await withMock(async (mock) => {
    const created = await clientFor(mock).createMergeRequest({
      project: PROJECT,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
      title: `${SOURCE_BRANCH} -> ${TARGET_BRANCH}`,
      description: '工单：YGFNXDJRFWDJSYJJYY-647\n\n方案：修复附件回显',
    });

    assert.deepEqual(created, {
      iid: 77,
      url: `https://git.example.com/${PROJECT}/-/merge_requests/77`,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
      state: 'opened',
      title: `${SOURCE_BRANCH} -> ${TARGET_BRANCH}`,
    });

    const request = mock.requests.find((entry) => entry.method === 'POST');
    assert.equal(request.path, `${API_PROJECTS}/merge_requests`);
    assert.equal(request.auth, true);
    assert.equal(request.headers['content-type'], 'application/json');
    assert.deepEqual(request.body, {
      source_branch: SOURCE_BRANCH,
      target_branch: TARGET_BRANCH,
      title: `${SOURCE_BRANCH} -> ${TARGET_BRANCH}`,
      description: '工单：YGFNXDJRFWDJSYJJYY-647\n\n方案：修复附件回显',
      remove_source_branch: false,
    });
    assert.equal('reviewer_ids' in request.body, false);
    assert.equal(Object.keys(request.body).length, 5);
  });
});

test('createMergeRequest falls back from web_url to url and rejects an unusable response', async () => {
  await withMock(async (mock) => {
    const created = await clientFor(mock).createMergeRequest({
      project: PROJECT,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
      title: 'title',
    });
    assert.equal(created.url, 'https://git.example.com/fallback/78');
    assert.equal(created.iid, 78);
  }, {
    createdMergeRequest: {
      iid: 78,
      url: 'https://git.example.com/fallback/78',
      source_branch: SOURCE_BRANCH,
      target_branch: TARGET_BRANCH,
      state: 'opened',
      title: 'title',
    },
  });

  for (const body of [{}, { iid: 0 }, { iid: 'x' }, { iid: 79 }, { iid: 79, state: '' }, null]) {
    await withMock(async (mock) => {
      await assert.rejects(
        clientFor(mock).createMergeRequest({
          project: PROJECT,
          sourceBranch: SOURCE_BRANCH,
          targetBranch: TARGET_BRANCH,
          title: 'title',
        }),
        (error) => {
          assert.equal(error.code, 'bad-response');
          assert.equal(JSON.stringify(error).includes(TOKEN), false);
          return true;
        },
        JSON.stringify(body),
      );
    }, { faults: { createMergeRequest: { status: 201, body } } });
  }
});

test('getMergeRequest uses the iid path and maps the response', async () => {
  const mr = defaultMergeRequest({ iid: 223, state: 'merged' });
  await withMock(async (mock) => {
    const fetched = await clientFor(mock).getMergeRequest({ project: PROJECT, iid: '223' });
    assert.deepEqual(fetched, {
      iid: 223,
      url: mr.web_url,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
      state: 'merged',
      title: mr.title,
    });
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].path, `${API_PROJECTS}/merge_requests/223`);
    assert.equal(mock.requests[0].iid, 223);
    assert.deepEqual(mock.requests[0].query, {});
  }, { mergeRequest: mr });
});

// ---------------------------------------------------------------------------
// Notes endpoint
// ---------------------------------------------------------------------------

test('listNotes requests newest-first and maps note fields defensively', async () => {
  const notesFixture = [
    {
      id: 3,
      body: '## AI Code Review (a -> b)\n\n结论: **可直接合并**',
      created_at: '2026-11-05T09:06:04.558+05:30',
      author: { username: 'reviewer' },
      system: false,
    },
    {
      id: '4',
      body: 'system note',
      created_at: '2026-11-05T09:05:23.621+05:30',
      author: { username: 'gitlab-bot' },
      system: true,
    },
    { id: 'not-a-number', body: 'dropped: no usable id' },
    { id: 0, body: 'dropped: zero is not an id' },
    null,
    'not-a-note',
    { id: 5, created_at: 42, author: null, system: 'yes' },
  ];

  await withMock(async (mock) => {
    const notes = await clientFor(mock).listNotes({ project: PROJECT, iid: 223 });
    assert.deepEqual(notes, [
      {
        id: 3,
        body: '## AI Code Review (a -> b)\n\n结论: **可直接合并**',
        createdAt: '2026-11-05T09:06:04.558+05:30',
        authorUsername: 'reviewer',
        system: false,
      },
      {
        id: 4,
        body: 'system note',
        createdAt: '2026-11-05T09:05:23.621+05:30',
        authorUsername: 'gitlab-bot',
        system: true,
      },
      {
        id: 5,
        body: '',
        createdAt: '',
        authorUsername: '',
        system: false,
      },
    ]);

    const request = mock.requests[0];
    assert.equal(request.path, `${API_PROJECTS}/merge_requests/223/notes`);
    assert.deepEqual(request.query, {
      sort: 'desc',
      order_by: 'created_at',
      per_page: '100',
    });
  }, { notes: notesFixture });
});

test('listNotes rejects a non-array payload with bad-response', async () => {
  for (const body of [{}, 'notes', 42, null]) {
    await withMock(async (mock) => {
      await assert.rejects(
        clientFor(mock).listNotes({ project: PROJECT, iid: 1 }),
        (error) => error.code === 'bad-response',
      );
    }, { faults: { listNotes: { status: 200, body } } });
  }
});

// ---------------------------------------------------------------------------
// notes → parseReview pipeline (the Task 4 wiring)
// ---------------------------------------------------------------------------

test('real review fixtures flow through listNotes into parseReview', async () => {
  // Exactly the P0 pair, newest first (the mock returns the order the notes
  // query asks for). Task 4 will filter by the AI marker and take the first.
  const notes = [
    {
      id: 72351,
      body: PASS_BODY,
      created_at: '2026-11-05T09:05:23.621+05:30',
      author: { username: 'ai-review-bot' },
      system: false,
    },
    {
      id: 72348,
      body: NEEDS_FIX_BODY,
      created_at: '2026-11-05T09:01:22.209+05:30',
      author: { username: 'ai-review-bot' },
      system: false,
    },
  ];

  await withMock(async (mock) => {
    const fetched = await clientFor(mock).listNotes({ project: PROJECT, iid: 223 });
    assert.equal(fetched.length, 2);
    assert.deepEqual(fetched.map((note) => note.id), [72351, 72348]);
    assert.equal(fetched.every((note) => note.system === false), true);

    // The two real fixtures keep their verdicts after crossing HTTP and the
    // defensive note mapping: needs-fix → changes (1 blocking), pass → pass.
    const newest = fetched.find((note) => note.body.includes('AI Code Review'));
    assert.equal(newest.id, 72351);
    const newestReview = parseReview(newest.body);
    assert.equal(newestReview.verdict, 'pass');
    assert.deepEqual(newestReview.blocking, []);
    assert.equal(newestReview.nonBlocking.length, 1);

    const older = fetched.find((note) => note.id === 72348);
    const olderReview = parseReview(older.body);
    assert.equal(olderReview.verdict, 'changes');
    assert.equal(olderReview.blocking.length, 1);
    assert.ok(olderReview.nonBlocking.length >= 1);
    assert.equal(olderReview.blocking[0].file, 'src/features/example-form/useExampleForm.ts');
    assert.equal(olderReview.blocking[0].gateCategory, '逻辑错误');

    // The hidden statistics block must be stripped before it can reach a
    // review-fix prompt or the board.
    for (const parsed of [newestReview, olderReview]) {
      const serialized = JSON.stringify(parsed);
      assert.equal(serialized.includes('AI_REVIEW_FINDINGS'), false);
      assert.equal(serialized.includes('AI_REVIEW_DECISION'), false);
      assert.equal(serialized.includes('备注：以下隐藏数据'), false);
      assert.equal(serialized.includes('finding_id'), false);
    }
  }, { notes });
});
