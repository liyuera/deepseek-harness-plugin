/**
 * Unit tests for the Bug workflow host HTTP API.
 *
 * The handlers are pure over `{ store, workspace, clock }`, so every test drives
 * a scripted fake store and a real `resolveWorkspace()` over a fake
 * `ctx.sessions` — no Cordis fiber, zod schema or storage backend is involved.
 * Requests are real `Readable` streams with `IncomingMessage`-shaped fields;
 * responses record status, headers and body like a `ServerResponse`.
 *
 * Coverage maps to the P1 Task 3 acceptance list: health, snapshot shape and
 * session validation, action happy path, JSON/size/action/transition errors,
 * review-rounds-exhausted -> block, settings, Host/method guards, and the
 * "handler never throws" contract.
 */

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  API_PATHS,
  MAX_BODY_BYTES,
  createHandlers,
  registerRoutes,
  registerUnavailableRoutes,
} from '../src/host/routes.js';
import { PLATFORM_TOKEN_REF, createTokenStore } from '../src/host/credentials.js';
import { DEFAULT_SETTINGS, createStore } from '../src/host/store.js';
import { MAX_REVIEW_ROUNDS, initialTicket } from '../src/host/state-machine.js';
import { resolveWorkspace } from '../src/host/workspace.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-live-1';
const UNBOUND_SESSION_ID = 'session-unbound';
const WORKSPACE = '/tmp/bug-workflow-workspace';
const SERVER_TIME = '2026-11-07T01:30:00.000Z';
const OPENED_AT = 1793985309340;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function inboxTicket(code, title = code) {
  return initialTicket({ code, title }, SERVER_TIME);
}

function unboundWorkspaceResult() {
  return { path: null, configured: false };
}

/** Fake `ctx.sessions`; ids map to a session whose header carries a cwd. */
function createSessions(entries = { [SESSION_ID]: { header: { cwd: WORKSPACE } } }) {
  return {
    get(id) {
      return entries[id];
    },
  };
}

/**
 * Handlers are built with the production workspace resolver and a scripted
 * store, so the tests exercise `resolveWorkspace()`/`createHandlers()` together.
 */
function createWorkspace(sessions = createSessions()) {
  return {
    resolve: (sessionId) => resolveWorkspace({ sessions }, sessionId),
  };
}

// ---------------------------------------------------------------------------
// Fake TicketStore
// ---------------------------------------------------------------------------

/**
 * Small in-memory store double. It implements only the surface routes consume;
 * individual tests override `applyAction`/`putSettings`/`snapshot` to exercise
 * a specific store result or thrown `StoreError`.
 */
function createFakeStore(options = {}) {
  const tickets = new Map();
  const settingsByCwd = new Map();
  for (const ticket of options.tickets ?? []) tickets.set(ticket.code, clone(ticket));

  const calls = {
    list: 0,
    snapshot: 0,
    get: [],
    applyAction: [],
    getSettings: [],
    putSettings: [],
  };

  const store = {
    tickets,
    settingsByCwd,
    calls,

    list() {
      calls.list += 1;
      return [...tickets.values()].map(clone);
    },

    snapshot() {
      calls.snapshot += 1;
      const rows = [...tickets.values()].map(clone);
      return { tickets: rows, total: rows.length, invalid: 0 };
    },

    get(code) {
      calls.get.push(code);
      return clone(tickets.get(code));
    },

    async applyAction(code, action, payload, actionOptions) {
      calls.applyAction.push({
        code,
        action,
        payload: clone(payload),
        options: clone(actionOptions),
      });

      const overridden = options.applyAction;
      if (typeof overridden === 'function') {
        return overridden(code, action, payload, actionOptions);
      }

      if (action === 'create') {
        const ticket = initialTicket({ ...(payload ?? {}), code }, SERVER_TIME);
        tickets.set(code, clone(ticket));
        return { ok: true, ticket: clone(ticket) };
      }

      const current = tickets.get(code);
      if (current === undefined) {
        return { ok: false, code: 'not-found', message: `工单 ${code} 不存在` };
      }
      if (action === 'start_analysis' && current.workflow === 'inbox') {
        const next = {
          ...clone(current),
          workflow: 'analyzing',
          updatedAt: SERVER_TIME,
          timeline: [
            ...current.timeline,
            { at: SERVER_TIME, kind: action, actor: 'user', message: '开始分析工单' },
          ],
        };
        tickets.set(code, clone(next));
        return { ok: true, ticket: clone(next) };
      }
      return {
        ok: false,
        code: 'invalid-transition',
        message: `工单状态 ${current.workflow} 不能执行 ${action}`,
      };
    },

    getSettings(cwd) {
      calls.getSettings.push(cwd);
      if (options.getSettings !== undefined) return options.getSettings(cwd);
      if (typeof cwd !== 'string' || cwd.trim() === '') return { ...DEFAULT_SETTINGS };
      return { ...DEFAULT_SETTINGS, ...(settingsByCwd.get(cwd) ?? {}) };
    },

    async putSettings(cwd, input) {
      calls.putSettings.push({ cwd, input: clone(input) });
      if (options.putSettings !== undefined) return options.putSettings(cwd, input);

      if (typeof cwd !== 'string' || cwd.trim() === '') {
        throw storeError('unknown-workspace', '无法确定工作区路径，settings 未保存');
      }
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw storeError('invalid-settings', 'settings 必须是普通对象');
      }
      for (const field of Object.keys(DEFAULT_SETTINGS)) {
        if (input[field] === undefined) continue;
        // Domain v2 adds the boolean `writebackStatus`; every other declared
        // field is a string. Mirrors the store's declared-type derivation.
        const expected = DEFAULT_SETTINGS[field] === true || DEFAULT_SETTINGS[field] === false
          ? 'boolean'
          : 'string';
        if (typeof input[field] !== expected) {
          throw storeError(
            'invalid-settings',
            `settings.${field} 必须是${expected === 'boolean' ? '布尔值' : '字符串'}`,
          );
        }
      }
      const next = { ...DEFAULT_SETTINGS, ...(settingsByCwd.get(cwd) ?? {}), ...input };
      settingsByCwd.set(cwd, next);
      return clone(next);
    },
  };

  return store;
}

function storeError(code, message) {
  const error = new Error(message);
  error.name = 'StoreError';
  error.code = code;
  return error;
}

/**
 * Minimal in-memory storage-domain double for the one integration test that
 * drives the real `createStore()`/state machine instead of a scripted store.
 */
function createFakeDomain() {
  const tables = new Map();
  return {
    table(name) {
      let records = tables.get(name);
      if (records === undefined) {
        records = new Map();
        tables.set(name, records);
      }
      return {
        get: (key) => clone(records.get(key)),
        put: async (key, value) => {
          records.set(key, clone(value));
        },
        delete: async (key) => {
          records.delete(key);
        },
        entries: () => {
          const pairs = [];
          for (const [key, value] of records) pairs.push([key, clone(value)]);
          return pairs[Symbol.iterator]();
        },
        keys: () => records.keys(),
        get size() {
          return records.size;
        },
        update: async (key, fn) => {
          const next = fn(clone(records.get(key)));
          records.set(key, clone(next));
          return clone(next);
        },
      };
    },
    close: async () => {},
  };
}

/** A ticket at `mr_open` with the review counter already at the cap. */
function mrOpenTicket(code, rounds) {
  const base = initialTicket({ code, title: code }, SERVER_TIME);
  return {
    ...base,
    workflow: 'mr_open',
    mr: {
      iid: '17',
      url: null,
      sourceBranch: null,
      targetBranch: null,
      state: 'open',
      verdict: 'changes',
      blockingIssues: [],
      nonBlockingIssues: [],
      rounds,
    },
  };
}

// ---------------------------------------------------------------------------
// Fake HTTP request/response
// ---------------------------------------------------------------------------

function makeRequest({
  method = 'GET',
  url = API_PATHS.health,
  host = '127.0.0.1:49254',
  remoteAddress = '127.0.0.1',
  body,
  headers = {},
  contentLength = true,
  contentType,
  origin,
} = {}) {
  const payload = body === undefined
    ? undefined
    : Buffer.isBuffer(body)
      ? body
      : Buffer.from(body);
  const req = Readable.from(payload === undefined ? [] : [payload]);
  req.method = method;
  req.url = url;
  req.headers = { ...(host === null ? {} : { host }), ...headers };

  // POST routes now require a JSON media type. Tests that are not about the
  // media type get the realistic browser default; `contentType: null` omits
  // the header entirely (the 415 path).
  if (req.headers['content-type'] === undefined) {
    const inferred = contentType === undefined && method === 'POST'
      ? 'application/json'
      : contentType;
    if (inferred !== null && inferred !== undefined) {
      req.headers['content-type'] = inferred;
    }
  }
  if (origin !== undefined) req.headers.origin = origin;

  // `remoteAddress: null` simulates a request whose socket tells us nothing.
  if (remoteAddress !== null) req.socket = { remoteAddress };

  if (payload !== undefined && contentLength && req.headers['content-length'] === undefined) {
    req.headers['content-length'] = String(payload.length);
  }
  return req;
}

/** A request whose body never ends, to exercise the body-read deadline. */
function makeHangingRequest({
  method = 'POST',
  url = API_PATHS.action,
  host = '127.0.0.1:49254',
  remoteAddress = '127.0.0.1',
} = {}) {
  const req = new Readable({ read() {} });
  req.method = method;
  req.url = url;
  req.headers = { host, 'content-type': 'application/json' };
  req.socket = { remoteAddress };
  return req;
}

function makeResponse() {
  return {
    statusCode: undefined,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = { ...headers };
      this.headersSent = true;
      return this;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk);
      this.writableEnded = true;
      return this;
    },
    getHeader(name) {
      return this.headers[name];
    },
  };
}

async function call(handler, options) {
  const res = makeResponse();
  await handler(makeRequest(options), res);
  return { res, json: res.body === '' ? undefined : JSON.parse(res.body) };
}

function snapshotUrl(sessionId = SESSION_ID) {
  return `${API_PATHS.snapshot}?sessionId=${encodeURIComponent(sessionId)}`;
}

function actionBody(overrides = {}) {
  return JSON.stringify({
    sessionId: SESSION_ID,
    actionId: 'act-1',
    code: 'BUG-1',
    action: 'create',
    payload: { title: 'demo' },
    ...overrides,
  });
}

function settingsBody(overrides = {}) {
  return JSON.stringify({
    sessionId: SESSION_ID,
    settings: { branchUser: 'zz' },
    ...overrides,
  });
}

function platformTokenBody(overrides = {}) {
  return JSON.stringify({
    sessionId: SESSION_ID,
    token: 'p2-dummy-token',
    ...overrides,
  });
}

/** Fake credentials service used by the token-store integration. */
function createFakeCredentials(initial = {}) {
  const values = new Map(Object.entries(initial));
  const calls = { set: [], resolve: [], describe: [], unset: [] };
  return {
    values,
    calls,
    async set(ref, value) {
      calls.set.push({ ref, value });
      values.set(ref, value);
    },
    async resolve(ref) {
      calls.resolve.push(ref);
      if (!values.has(ref)) return undefined;
      return { value: values.get(ref), source: 'file' };
    },
    async describe(ref) {
      calls.describe.push(ref);
      return values.has(ref)
        ? { configured: true, source: 'file', writable: true }
        : { configured: false, writable: true };
    },
    async unset(ref) {
      calls.unset.push(ref);
      values.delete(ref);
    },
  };
}

function tokenFixture(initial = {}) {
  const credentials = createFakeCredentials(initial);
  return { credentials, tokenStore: createTokenStore(credentials) };
}

function handlersWith({
  store = createFakeStore(),
  workspace = createWorkspace(),
  tokenStore = createTokenStore(createFakeCredentials()),
  clock = () => SERVER_TIME,
  domainOpenedAt = OPENED_AT,
} = {}) {
  return {
    store,
    workspace,
    tokenStore,
    handlers: createHandlers({ store, workspace, tokenStore, clock, domainOpenedAt }),
  };
}

// ---------------------------------------------------------------------------
// Workspace resolution
// ---------------------------------------------------------------------------

test('resolveWorkspace() returns the live session cwd as a configured workspace', () => {
  const resolved = resolveWorkspace({ sessions: createSessions() }, SESSION_ID);
  assert.deepEqual(resolved, { path: WORKSPACE, configured: true });
});

test('resolveWorkspace() reports missing sessions and missing cwd as unbound', () => {
  const sessions = createSessions({
    [SESSION_ID]: { header: {} },
    'session-no-header': {},
  });
  for (const sessionId of [UNBOUND_SESSION_ID, SESSION_ID, 'session-no-header', '', '   ', undefined, null]) {
    assert.deepEqual(resolveWorkspace({ sessions }, sessionId), unboundWorkspaceResult());
  }
});

test('resolveWorkspace() does not throw when the sessions service fails', () => {
  const sessions = {
    get() {
      throw new Error('session store unavailable');
    },
  };
  assert.deepEqual(resolveWorkspace({ sessions }, SESSION_ID), unboundWorkspaceResult());
  assert.deepEqual(resolveWorkspace({}, SESSION_ID), unboundWorkspaceResult());
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

test('GET /health returns ok, domainOpenedAt and the live ticket count', async () => {
  const store = createFakeStore({ tickets: [inboxTicket('BUG-1')] });
  const { handlers } = handlersWith({ store });
  const { res, json } = await call(handlers.health, { url: API_PATHS.health });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(json, { ok: true, domainOpenedAt: OPENED_AT, tickets: 1 });
});

test('health rejects every non-GET method with 405', async () => {
  const { handlers } = handlersWith();
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    const { res, json } = await call(handlers.health, { method });
    assert.equal(res.statusCode, 405, method);
    assert.equal(json.code, 'method-not-allowed', method);
  }
});

test('health reports a failing ticket list as a 500 without throwing', async () => {
  const store = createFakeStore();
  store.list = () => {
    throw new Error('table unavailable');
  };
  const { handlers } = handlersWith({ store });
  const { res, json } = await call(handlers.health, { url: API_PATHS.health });

  assert.equal(res.statusCode, 500);
  assert.equal(json.ok, false);
  assert.equal(json.stage, 'list-tickets');
  assert.match(json.error, /table unavailable/);
});

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

test('GET /snapshot requires a non-empty sessionId', async () => {
  const { handlers } = handlersWith();
  for (const url of [
    API_PATHS.snapshot,
    `${API_PATHS.snapshot}?sessionId=`,
    `${API_PATHS.snapshot}?sessionId=%20%20`,
  ]) {
    const { res, json } = await call(handlers.snapshot, { url });
    assert.equal(res.statusCode, 400, url);
    assert.equal(json.code, 'missing-session', url);
    assert.equal(json.ok, false, url);
  }
});

test('GET /snapshot composes workspace, settings, tickets and serverTime', async () => {
  const ticket = inboxTicket('BUG-1');
  const { store, handlers } = handlersWith({ store: createFakeStore({ tickets: [ticket] }) });
  const { res, json } = await call(handlers.snapshot, { url: snapshotUrl() });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(json, {
    ok: true,
    workspace: { path: WORKSPACE, configured: true },
    settings: DEFAULT_SETTINGS,
    platform: { tokenPresent: false, lastSyncAt: null, lastSyncError: null },
    tickets: [ticket],
    serverTime: SERVER_TIME,
  });
  assert.deepEqual(store.calls.getSettings, [WORKSPACE]);
});

test('GET /snapshot reports tokenPresent from credentials without exposing the token', async () => {
  const { credentials, tokenStore } = tokenFixture({ [PLATFORM_TOKEN_REF]: 'p2-dummy-token' });
  const { handlers } = handlersWith({ tokenStore });
  const { res, json } = await call(handlers.snapshot, { url: snapshotUrl() });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(json.platform, {
    tokenPresent: true,
    lastSyncAt: null,
    lastSyncError: null,
  });
  assert.equal(JSON.stringify(json).includes('p2-dummy-token'), false);
  // Presence is a status read: the snapshot never resolves the value.
  assert.deepEqual(credentials.calls.resolve, []);
});

test('GET /snapshot keeps tokenPresent false when credentials is unavailable', async () => {
  const { handlers } = handlersWith({ tokenStore: createTokenStore(undefined) });
  const { res, json } = await call(handlers.snapshot, { url: snapshotUrl() });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(json.platform, {
    tokenPresent: false,
    lastSyncAt: null,
    lastSyncError: null,
  });
});

test('GET /snapshot returns an unbound workspace for an unknown live session', async () => {
  const ticket = inboxTicket('BUG-1');
  const { store, handlers } = handlersWith({ store: createFakeStore({ tickets: [ticket] }) });
  const { res, json } = await call(handlers.snapshot, { url: snapshotUrl(UNBOUND_SESSION_ID) });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(json.workspace, unboundWorkspaceResult());
  assert.deepEqual(json.settings, DEFAULT_SETTINGS);
  assert.deepEqual(json.tickets, [ticket]);
  assert.deepEqual(store.calls.getSettings, [null]);
});

test('GET /snapshot maps an unexpected store failure to 500 internal', async () => {
  const store = createFakeStore();
  store.snapshot = () => {
    throw new Error('snapshot failed');
  };
  const { handlers } = handlersWith({ store });
  const { res, json } = await call(handlers.snapshot, { url: snapshotUrl() });

  assert.equal(res.statusCode, 500);
  assert.equal(json.code, 'internal');
  assert.match(json.message, /snapshot failed/);
});

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

test('POST /action creates a ticket and returns it', async () => {
  const { store, handlers } = handlersWith();
  const { res, json } = await call(handlers.action, {
    method: 'POST',
    url: API_PATHS.action,
    body: actionBody(),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(json.ok, true);
  assert.equal(json.ticket.code, 'BUG-1');
  assert.equal(json.ticket.title, 'demo');
  assert.equal(json.ticket.workflow, 'inbox');
  assert.equal(store.calls.applyAction.length, 1);
  assert.deepEqual(store.calls.applyAction[0].options, { actionId: 'act-1' });
});

test('POST /action advances a ticket (start_analysis)', async () => {
  const store = createFakeStore({ tickets: [inboxTicket('BUG-1')] });
  const { handlers } = handlersWith({ store });
  const { res, json } = await call(handlers.action, {
    method: 'POST',
    url: API_PATHS.action,
    body: actionBody({ action: 'start_analysis', actionId: 'act-2' }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(json.ticket.workflow, 'analyzing');
  assert.equal(json.ticket.timeline.at(-1).kind, 'start_analysis');
});

test('POST /action rejects malformed JSON with 400', async () => {
  const { handlers } = handlersWith();
  const { res, json } = await call(handlers.action, {
    method: 'POST',
    url: API_PATHS.action,
    body: '{"sessionId":',
  });

  assert.equal(res.statusCode, 400);
  assert.equal(json.code, 'invalid-json');
});

test('POST /action rejects a non-object JSON body with 400', async () => {
  const { handlers } = handlersWith();
  for (const body of ['null', '[]', '"text"', '42']) {
    const { res, json } = await call(handlers.action, {
      method: 'POST',
      url: API_PATHS.action,
      body,
    });
    assert.equal(res.statusCode, 400, body);
    assert.equal(json.code, 'invalid-body', body);
  }
});

test('POST /action rejects an empty body with 400', async () => {
  const { handlers } = handlersWith();
  const { res, json } = await call(handlers.action, {
    method: 'POST',
    url: API_PATHS.action,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(json.code, 'invalid-json');
});

test('POST /action rejects a body over 64 KiB with 413', async () => {
  const { handlers } = handlersWith();
  const oversized = `{"padding":"${'x'.repeat(MAX_BODY_BYTES)}"}`;
  assert.ok(Buffer.byteLength(oversized) > MAX_BODY_BYTES);

  const declared = await call(handlers.action, {
    method: 'POST',
    url: API_PATHS.action,
    body: oversized,
  });
  assert.equal(declared.res.statusCode, 413);
  assert.equal(declared.json.code, 'payload-too-large');

  // Chunked requests carry no content-length: the cap must still apply.
  const chunked = await call(handlers.action, {
    method: 'POST',
    url: API_PATHS.action,
    body: oversized,
    contentLength: false,
  });
  assert.equal(chunked.res.statusCode, 413);
  assert.equal(chunked.json.code, 'payload-too-large');
});

test('POST /action rejects unknown actions with 400', async () => {
  const { handlers } = handlersWith();
  const { res, json } = await call(handlers.action, {
    method: 'POST',
    url: API_PATHS.action,
    body: actionBody({ action: 'explode' }),
  });

  assert.equal(res.statusCode, 400);
  assert.equal(json.code, 'unknown-action');
});

test('POST /action maps an illegal transition to 409', async () => {
  const store = createFakeStore({ tickets: [inboxTicket('BUG-1')] });
  const { handlers } = handlersWith({ store });
  const { res, json } = await call(handlers.action, {
    method: 'POST',
    url: API_PATHS.action,
    body: actionBody({ action: 'mr_merged', actionId: 'act-3' }),
  });

  assert.equal(res.statusCode, 409);
  assert.equal(json.code, 'invalid-transition');
  assert.equal(json.ok, false);
});

test('POST /action requires sessionId, actionId and code', async () => {
  const { handlers } = handlersWith();
  const cases = [
    [{ sessionId: undefined }, 'missing-session'],
    [{ sessionId: '   ' }, 'missing-session'],
    [{ actionId: undefined }, 'missing-action-id'],
    [{ actionId: '   ' }, 'missing-action-id'],
    [{ code: undefined }, 'missing-code'],
    [{ code: '   ' }, 'missing-code'],
  ];
  for (const [override, expected] of cases) {
    const { res, json } = await call(handlers.action, {
      method: 'POST',
      url: API_PATHS.action,
      body: actionBody(override),
    });
    assert.equal(res.statusCode, 400, expected);
    assert.equal(json.code, expected);
  }
});

test('POST /action rejects a non-object payload with 400', async () => {
  const { handlers } = handlersWith();
  const { res, json } = await call(handlers.action, {
    method: 'POST',
    url: API_PATHS.action,
    body: actionBody({ payload: 'not-an-object' }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(json.code, 'invalid-payload');
});

test('store failure codes map to their HTTP statuses', async () => {
  const cases = [
    ['invalid-payload', 400],
    ['unknown-workspace', 400],
    ['invalid-settings', 400],
    ['invalid-input', 400],
    ['action-id-reused', 409],
    ['invalid-transition', 409],
    ['duplicate-code', 409],
    ['not-found', 404],
    ['invalid-record', 500],
  ];

  for (const [code, status] of cases) {
    const store = createFakeStore({
      applyAction: async () => ({ ok: false, code, message: `store said ${code}` }),
    });
    const { handlers } = handlersWith({ store });
    const { res, json } = await call(handlers.action, {
      method: 'POST',
      url: API_PATHS.action,
      body: actionBody(),
    });
    assert.equal(res.statusCode, status, code);
    assert.equal(json.ok, false, code);
    assert.equal(json.code, code, code);
    assert.equal(json.message, `store said ${code}`, code);
  }
});

test('review-rounds-exhausted triggers a system block before the 409', async () => {
  const blockedTicket = {
    ...inboxTicket('BUG-9'),
    workflow: 'blocked',
    blockedFrom: 'mr_open',
    blockedReason: 'review-rounds-exhausted',
  };
  const calls = [];
  const store = createFakeStore({
    applyAction: async (code, action, payload, options) => {
      calls.push({ code, action, payload, options });
      if (action === 'review_requests_changes') {
        return {
          ok: false,
          code: 'review-rounds-exhausted',
          message: 'Review 已进行 3 轮，达到上限 3 轮，需人工介入',
        };
      }
      if (action === 'block') return { ok: true, ticket: clone(blockedTicket) };
      return { ok: false, code: 'invalid-transition', message: 'unexpected action' };
    },
    get: () => blockedTicket,
  });
  const { handlers } = handlersWith({ store });
  const { res, json } = await call(handlers.action, {
    method: 'POST',
    url: API_PATHS.action,
    body: actionBody({
      action: 'review_requests_changes',
      actionId: 'act-review',
      code: 'BUG-9',
    }),
  });

  assert.equal(res.statusCode, 409);
  assert.equal(json.ok, false);
  assert.equal(json.code, 'review-rounds-exhausted');
  assert.equal(json.ticket.workflow, 'blocked');
  assert.equal(json.ticket.blockedReason, 'review-rounds-exhausted');
  assert.deepEqual(calls.map((entry) => entry.action), ['review_requests_changes', 'block']);
  assert.equal(calls[1].payload.reason, 'review-rounds-exhausted');
  assert.equal(calls[1].payload.actor, 'system');
  assert.equal(calls[1].options.actionId, 'act-review:review-rounds-exhausted');
});

test('review-rounds-exhausted still answers 409 with the current ticket when block fails', async () => {
  const blockedTicket = {
    ...inboxTicket('BUG-9'),
    workflow: 'blocked',
    blockedReason: 'review-rounds-exhausted',
  };
  const store = createFakeStore({
    tickets: [blockedTicket],
    applyAction: async (code, action) => {
      if (action === 'review_requests_changes') {
        return { ok: false, code: 'review-rounds-exhausted', message: '轮次耗尽' };
      }
      return { ok: false, code: 'invalid-transition', message: 'block 被拒' };
    },
  });
  const { handlers } = handlersWith({ store });
  const { res, json } = await call(handlers.action, {
    method: 'POST',
    url: API_PATHS.action,
    body: actionBody({ action: 'review_requests_changes', actionId: 'act-review-2', code: 'BUG-9' }),
  });

  assert.equal(res.statusCode, 409);
  assert.equal(json.code, 'review-rounds-exhausted');
  assert.equal(json.ticket.code, 'BUG-9');
  assert.equal(json.blockError, 'invalid-transition');
});

test('real store: review-rounds-exhausted blocks the ticket and a retry stays review-rounds-exhausted', async () => {
  const domain = createFakeDomain();
  await domain.table('tickets').put('BUG-RR', mrOpenTicket('BUG-RR', MAX_REVIEW_ROUNDS));
  const store = createStore(domain);
  const { handlers } = handlersWith({ store });
  const body = actionBody({
    code: 'BUG-RR',
    action: 'review_requests_changes',
    actionId: 'real-rr',
    payload: {},
  });

  const first = await call(handlers.action, { method: 'POST', url: API_PATHS.action, body });
  assert.equal(first.res.statusCode, 409);
  assert.equal(first.json.code, 'review-rounds-exhausted');
  assert.equal(first.json.ticket.workflow, 'blocked');
  assert.equal(first.json.ticket.blockedFrom, 'mr_open');
  assert.equal(first.json.ticket.blockedReason, 'review-rounds-exhausted');
  assert.equal(first.json.ticket.timeline.at(-1).kind, 'blocked');
  assert.equal(first.json.ticket.timeline.at(-1).actor, 'system');

  const persisted = domain.table('tickets').get('BUG-RR');
  assert.equal(persisted.workflow, 'blocked');
  assert.equal(persisted.blockedReason, 'review-rounds-exhausted');

  // A lost-response retry must replay the same deterministic 409, not degrade
  // to invalid-transition now that the ticket is blocked.
  const retry = await call(handlers.action, { method: 'POST', url: API_PATHS.action, body });
  assert.equal(retry.res.statusCode, 409);
  assert.equal(retry.json.code, 'review-rounds-exhausted');
  assert.equal(retry.json.ticket.workflow, 'blocked');
  assert.equal(retry.json.ticket.blockedReason, 'review-rounds-exhausted');
});

test('POST /action never throws when the store throws', async () => {
  const store = createFakeStore({
    applyAction: async () => {
      throw new Error('disk on fire');
    },
  });
  const { handlers } = handlersWith({ store });
  const { res, json } = await call(handlers.action, {
    method: 'POST',
    url: API_PATHS.action,
    body: actionBody(),
  });

  assert.equal(res.statusCode, 500);
  assert.equal(json.code, 'internal');
  assert.match(json.message, /disk on fire/);
});

test('error responses clip unknown-action, internal and invalid-payload detail', async () => {
  const longName = 'x'.repeat(200);
  const { handlers } = handlersWith();
  const unknown = await call(handlers.action, {
    method: 'POST',
    url: API_PATHS.action,
    body: actionBody({ action: longName }),
  });
  assert.equal(unknown.res.statusCode, 400);
  assert.equal(unknown.json.code, 'unknown-action');
  assert.ok(unknown.json.message.length <= 300);
  assert.ok(unknown.json.message.includes('x'.repeat(63)));
  assert.equal(unknown.json.message.includes('x'.repeat(64)), false);

  const longError = 'E'.repeat(4000);
  const internal = await call(
    handlersWith({
      store: createFakeStore({
        applyAction: async () => {
          throw new Error(longError);
        },
      }),
    }).handlers.action,
    { method: 'POST', url: API_PATHS.action, body: actionBody() },
  );
  assert.equal(internal.res.statusCode, 500);
  assert.equal(internal.json.code, 'internal');
  assert.ok(internal.json.message.length <= 300);

  const invalidPayload = await call(
    handlersWith({
      store: createFakeStore({
        applyAction: async () => ({ ok: false, code: 'invalid-payload', message: longError }),
      }),
    }).handlers.action,
    { method: 'POST', url: API_PATHS.action, body: actionBody() },
  );
  assert.equal(invalidPayload.res.statusCode, 400);
  assert.equal(invalidPayload.json.code, 'invalid-payload');
  assert.ok(invalidPayload.json.message.length <= 300);
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

test('POST /settings saves and returns the workspace settings', async () => {
  const { store, handlers } = handlersWith();
  const { res, json } = await call(handlers.settings, {
    method: 'POST',
    url: API_PATHS.settings,
    body: settingsBody(),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(json.ok, true);
  assert.equal(json.settings.branchUser, 'zz');
  assert.equal(json.settings.commitType, DEFAULT_SETTINGS.commitType);
  assert.deepEqual(store.calls.putSettings, [
    { cwd: WORKSPACE, input: { branchUser: 'zz' } },
  ]);
});

test('POST /settings requires sessionId', async () => {
  const { handlers } = handlersWith();
  const { res, json } = await call(handlers.settings, {
    method: 'POST',
    url: API_PATHS.settings,
    body: settingsBody({ sessionId: undefined }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(json.code, 'missing-session');
});

test('POST /settings rejects a non-object settings field with 400', async () => {
  const { handlers } = handlersWith();
  const { res, json } = await call(handlers.settings, {
    method: 'POST',
    url: API_PATHS.settings,
    body: settingsBody({ settings: 'nope' }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(json.code, 'invalid-settings');
});

test('POST /settings rejects a body over 64 KiB with 413', async () => {
  const { handlers } = handlersWith();
  const oversized = JSON.stringify({
    sessionId: SESSION_ID,
    settings: { padding: 'x'.repeat(MAX_BODY_BYTES) },
  });
  assert.ok(Buffer.byteLength(oversized) > MAX_BODY_BYTES);

  const declared = await call(handlers.settings, {
    method: 'POST',
    url: API_PATHS.settings,
    body: oversized,
  });
  assert.equal(declared.res.statusCode, 413);
  assert.equal(declared.json.code, 'payload-too-large');

  // Chunked requests carry no content-length: the cap must still apply.
  const chunked = await call(handlers.settings, {
    method: 'POST',
    url: API_PATHS.settings,
    body: oversized,
    contentLength: false,
  });
  assert.equal(chunked.res.statusCode, 413);
  assert.equal(chunked.json.code, 'payload-too-large');
});

test('POST /settings maps store invalid-settings to 400', async () => {
  const { handlers } = handlersWith();
  const { res, json } = await call(handlers.settings, {
    method: 'POST',
    url: API_PATHS.settings,
    body: settingsBody({ settings: { branchUser: 42 } }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(json.code, 'invalid-settings');
});

test('POST /settings maps unknown-workspace to 400', async () => {
  const { handlers } = handlersWith();
  const { res, json } = await call(handlers.settings, {
    method: 'POST',
    url: API_PATHS.settings,
    body: settingsBody({ sessionId: UNBOUND_SESSION_ID }),
  });
  assert.equal(res.statusCode, 400);
  assert.equal(json.code, 'unknown-workspace');
});

test('POST /settings never throws when the store throws an unexpected error', async () => {
  const store = createFakeStore({
    putSettings: async () => {
      throw new Error('settings table unavailable');
    },
  });
  const { handlers } = handlersWith({ store });
  const { res, json } = await call(handlers.settings, {
    method: 'POST',
    url: API_PATHS.settings,
    body: settingsBody(),
  });
  assert.equal(res.statusCode, 500);
  assert.equal(json.code, 'internal');
});

// ---------------------------------------------------------------------------
// Platform token
// ---------------------------------------------------------------------------

test('POST /platform-token writes the string into credentials and answers only tokenPresent', async () => {
  const { credentials, tokenStore } = tokenFixture();
  const store = createFakeStore();
  const { handlers } = handlersWith({ store, tokenStore });
  const { res, json } = await call(handlers.platformToken, {
    method: 'POST',
    url: API_PATHS.platformToken,
    body: platformTokenBody(),
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(json, { ok: true, tokenPresent: true });
  assert.deepEqual(credentials.calls.set, [
    { ref: PLATFORM_TOKEN_REF, value: 'p2-dummy-token' },
  ]);
  assert.equal(credentials.values.get(PLATFORM_TOKEN_REF), 'p2-dummy-token');
  // The ticket store is not involved, and the response never echoes the token.
  assert.equal(store.calls.applyAction.length, 0);
  assert.equal(store.calls.putSettings.length, 0);
  assert.equal(JSON.stringify(json).includes('p2-dummy-token'), false);
});

test('POST /platform-token with token:null clears the credential', async () => {
  const { credentials, tokenStore } = tokenFixture({ [PLATFORM_TOKEN_REF]: 'p2-dummy-token' });
  const { handlers } = handlersWith({ tokenStore });
  const { res, json } = await call(handlers.platformToken, {
    method: 'POST',
    url: API_PATHS.platformToken,
    body: platformTokenBody({ token: null }),
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(json, { ok: true, tokenPresent: false });
  assert.deepEqual(credentials.calls.unset, [PLATFORM_TOKEN_REF]);
  assert.equal(credentials.values.has(PLATFORM_TOKEN_REF), false);
  assert.equal(JSON.stringify(json).includes('p2-dummy-token'), false);
});

test('POST /platform-token rejects a missing, non-string or empty token with 400', async () => {
  for (const [label, token] of [
    ['missing', undefined],
    ['number', 42],
    ['object', { token: 'x' }],
    ['array', ['x']],
    ['empty', ''],
    ['blank', '   '],
  ]) {
    const { credentials, tokenStore } = tokenFixture();
    const { handlers } = handlersWith({ tokenStore });
    const body = platformTokenBody();
    const parsed = JSON.parse(body);
    if (token === undefined) delete parsed.token;
    else parsed.token = token;
    const { res, json } = await call(handlers.platformToken, {
      method: 'POST',
      url: API_PATHS.platformToken,
      body: JSON.stringify(parsed),
    });

    assert.equal(res.statusCode, 400, label);
    assert.equal(json.ok, false, label);
    assert.equal(json.code, 'invalid-token', label);
    assert.equal(credentials.calls.set.length, 0, label);
  }
});

test('POST /platform-token requires a sessionId', async () => {
  const { credentials, tokenStore } = tokenFixture();
  const { handlers } = handlersWith({ tokenStore });
  const { res, json } = await call(handlers.platformToken, {
    method: 'POST',
    url: API_PATHS.platformToken,
    body: platformTokenBody({ sessionId: undefined }),
  });

  assert.equal(res.statusCode, 400);
  assert.equal(json.code, 'missing-session');
  assert.equal(credentials.calls.set.length, 0);
});

test('POST /platform-token accepts an unbound session (the token is profile-global)', async () => {
  const { credentials, tokenStore } = tokenFixture();
  const { handlers } = handlersWith({ tokenStore });
  const { res, json } = await call(handlers.platformToken, {
    method: 'POST',
    url: API_PATHS.platformToken,
    body: platformTokenBody({ sessionId: UNBOUND_SESSION_ID }),
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(json, { ok: true, tokenPresent: true });
  assert.equal(credentials.values.get(PLATFORM_TOKEN_REF), 'p2-dummy-token');
});

test('POST /platform-token answers 503 credentials-unavailable when credentials is absent', async () => {
  const { handlers } = handlersWith({ tokenStore: createTokenStore(undefined) });

  for (const token of ['p2-dummy-token', null]) {
    const { res, json } = await call(handlers.platformToken, {
      method: 'POST',
      url: API_PATHS.platformToken,
      body: platformTokenBody({ token }),
    });
    assert.equal(res.statusCode, 503, String(token));
    assert.equal(json.code, 'credentials-unavailable', String(token));
    assert.equal(JSON.stringify(json).includes('p2-dummy-token'), false);
  }
});

test('POST /platform-token maps an unexpected token-store failure to 500 internal', async () => {
  const tokenStore = {
    async get() { return null; },
    async set() { throw new Error('disk full'); },
    async clear() {},
    async present() { return false; },
  };
  const { handlers } = handlersWith({ tokenStore });
  const { res, json } = await call(handlers.platformToken, {
    method: 'POST',
    url: API_PATHS.platformToken,
    body: platformTokenBody(),
  });

  assert.equal(res.statusCode, 500);
  assert.equal(json.code, 'internal');
});

// ---------------------------------------------------------------------------
// Host / method guards
// ---------------------------------------------------------------------------

test('every route rejects a non-loopback Host with 403', async () => {
  const { handlers } = handlersWith();
  const cases = [
    ['health', 'GET', API_PATHS.health, undefined],
    ['snapshot', 'GET', snapshotUrl(), undefined],
    ['action', 'POST', API_PATHS.action, actionBody()],
    ['settings', 'POST', API_PATHS.settings, settingsBody()],
    ['platformToken', 'POST', API_PATHS.platformToken, platformTokenBody()],
  ];
  for (const [name, method, url, body] of cases) {
    const { res, json } = await call(handlers[name], {
      method,
      url,
      body,
      host: 'evil.example.com',
    });
    assert.equal(res.statusCode, 403, name);
    assert.equal(json.code, 'forbidden-host', name);
  }
});

test('loopback Host variants are accepted and lookalikes are rejected', async () => {
  const { handlers } = handlersWith();
  for (const host of ['127.0.0.1:49254', '127.0.0.1', 'localhost:49254', 'LOCALHOST:49254', '[::1]:49254', '[::1]']) {
    const { res } = await call(handlers.health, { host });
    assert.equal(res.statusCode, 200, host);
  }
  for (const host of [
    'evil.example.com',
    '127.0.0.1.evil.example.com',
    'localhost.evil.example.com',
    'evil.example.com@127.0.0.1',
    '[::2]:49254',
    '127.0.0.1:not-a-port',
    '',
  ]) {
    const { res, json } = await call(handlers.health, { host });
    assert.equal(res.statusCode, 403, host);
    assert.equal(json.code, 'forbidden-host', host);
  }
});

test('a missing Host header is rejected with 403', async () => {
  const { handlers } = handlersWith();
  const { res, json } = await call(handlers.health, { host: null });
  assert.equal(res.statusCode, 403);
  assert.equal(json.code, 'forbidden-host');
});

test('every route rejects the wrong HTTP method with 405 and an Allow header', async () => {
  const { handlers } = handlersWith();
  const cases = [
    ['health', 'POST', API_PATHS.health, 'GET'],
    ['snapshot', 'POST', API_PATHS.snapshot, 'GET'],
    ['action', 'GET', API_PATHS.action, 'POST'],
    ['settings', 'GET', API_PATHS.settings, 'POST'],
    ['platformToken', 'GET', API_PATHS.platformToken, 'POST'],
  ];
  for (const [name, method, url, allow] of cases) {
    const { res, json } = await call(handlers[name], { method, url });
    assert.equal(res.statusCode, 405, name);
    assert.equal(json.code, 'method-not-allowed', name);
    assert.equal(res.headers.allow, allow, name);
  }
});

// ---------------------------------------------------------------------------
// Origin / media-type / remote-address guards (Task 3 review findings)
// ---------------------------------------------------------------------------

const POST_ROUTES = [
  ['action', API_PATHS.action, () => actionBody()],
  ['settings', API_PATHS.settings, () => settingsBody()],
  ['platformToken', API_PATHS.platformToken, () => platformTokenBody()],
];

test('POST routes reject non-JSON media types with 415 before reading the body', async () => {
  for (const [name, url, body] of POST_ROUTES) {
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', null]) {
      const { store, handlers } = handlersWith();
      const { res, json } = await call(handlers[name], {
        method: 'POST',
        url,
        body: body(),
        contentType,
        // The media-type gate must win over the Origin gate: this is the exact
        // cross-site `no-cors` shape (text/plain + a foreign Origin).
        origin: 'https://evil.example',
      });
      const label = `${name} ${contentType}`;
      assert.equal(res.statusCode, 415, label);
      assert.equal(json.ok, false, label);
      assert.equal(json.code, 'unsupported-media-type', label);
      assert.match(json.message, /application\/json/, label);
      assert.equal(store.calls.applyAction.length, 0, label);
      assert.equal(store.calls.putSettings.length, 0, label);
    }
  }
});

test('POST routes accept application/json with media-type parameters', async () => {
  const { handlers } = handlersWith();
  const { res, json } = await call(handlers.action, {
    method: 'POST',
    url: API_PATHS.action,
    body: actionBody(),
    contentType: 'application/json; charset=utf-8',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(json.ok, true);
});

test('POST routes reject a foreign Origin with 403', async () => {
  for (const [name, url, body] of POST_ROUTES) {
    for (const origin of [
      'https://evil.example',
      'http://127.0.0.1:9999',
      'http://localhost:49254',
      'null',
      'not a url',
    ]) {
      const { store, handlers } = handlersWith();
      const { res, json } = await call(handlers[name], {
        method: 'POST',
        url,
        body: body(),
        origin,
      });
      const label = `${name} ${origin}`;
      assert.equal(res.statusCode, 403, label);
      assert.equal(json.code, 'forbidden-origin', label);
      assert.equal(store.calls.applyAction.length, 0, label);
      assert.equal(store.calls.putSettings.length, 0, label);
    }
  }
});

test('POST routes accept a same-origin Origin from a loopback socket', async () => {
  for (const [name, url, body] of POST_ROUTES) {
    const { handlers } = handlersWith();
    const { res } = await call(handlers[name], {
      method: 'POST',
      url,
      body: body(),
      origin: 'http://127.0.0.1:49254',
      remoteAddress: '::ffff:127.0.0.1',
    });
    assert.equal(res.statusCode, 200, name);
  }

  // Only the host:port has to match the Host header; both schemes are local.
  const { handlers } = handlersWith();
  const https = await call(handlers.action, {
    method: 'POST',
    url: API_PATHS.action,
    body: actionBody(),
    origin: 'https://127.0.0.1:49254',
  });
  assert.equal(https.res.statusCode, 200);

  const ipv6 = await call(handlers.health, {
    host: '[::1]:49254',
    origin: 'http://[::1]:49254',
    remoteAddress: '::1',
  });
  assert.equal(ipv6.res.statusCode, 200);
});

test('a missing Origin (non-browser local client) is allowed', async () => {
  const { handlers } = handlersWith();
  const health = await call(handlers.health, {});
  assert.equal(health.res.statusCode, 200);

  const action = await call(handlers.action, {
    method: 'POST',
    url: API_PATHS.action,
    body: actionBody(),
  });
  assert.equal(action.res.statusCode, 200);
});

test('every route rejects a non-loopback remote address with 403', async () => {
  const cases = [
    ['health', 'GET', API_PATHS.health, undefined],
    ['snapshot', 'GET', snapshotUrl(), undefined],
    ['action', 'POST', API_PATHS.action, () => actionBody()],
    ['settings', 'POST', API_PATHS.settings, () => settingsBody()],
    ['platformToken', 'POST', API_PATHS.platformToken, () => platformTokenBody()],
  ];
  for (const [name, method, url, body] of cases) {
    for (const remoteAddress of ['10.0.0.7', '::2', '::ffff:10.0.0.7', '127.0.0.2', null]) {
      const { handlers } = handlersWith();
      const { res, json } = await call(handlers[name], {
        method,
        url,
        body: body?.(),
        remoteAddress,
      });
      const label = `${name} ${remoteAddress}`;
      assert.equal(res.statusCode, 403, label);
      assert.equal(json.code, 'forbidden-remote', label);
    }
  }
});

test('loopback remote address variants are accepted', async () => {
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const { handlers } = handlersWith();
    const { res } = await call(handlers.health, { remoteAddress });
    assert.equal(res.statusCode, 200, remoteAddress);
  }
});

test('POST routes answer 408 and destroy a body that misses the read deadline', async () => {
  const { store, workspace } = handlersWith();
  const handlers = createHandlers({
    store,
    workspace,
    clock: () => SERVER_TIME,
    domainOpenedAt: OPENED_AT,
    bodyTimeoutMs: 25,
  });

  for (const [name, url] of POST_ROUTES) {
    const req = makeHangingRequest({ url });
    const res = makeResponse();
    await handlers[name](req, res);
    assert.equal(res.statusCode, 408, name);
    assert.equal(JSON.parse(res.body).code, 'body-timeout', name);
    assert.equal(req.destroyed, true, name);
  }
  assert.equal(store.calls.applyAction.length, 0);
  assert.equal(store.calls.putSettings.length, 0);
});

// ---------------------------------------------------------------------------
// Route registration / storage-unavailable fallback
// ---------------------------------------------------------------------------

function createFakeWebServer() {
  const routes = new Map();
  return {
    routes,
    register({ kind, path, handler }) {
      assert.equal(kind, 'exact');
      assert.equal(routes.has(path), false, `duplicate route ${path}`);
      routes.set(path, handler);
      return () => routes.delete(path);
    },
  };
}

async function callRegistered(webServer, path, options) {
  const handler = webServer.routes.get(path);
  assert.equal(typeof handler, 'function', `route ${path} not registered`);
  return call(handler, options);
}

test('registerRoutes() mounts all five exact routes and returns a disposer', async () => {
  const webServer = createFakeWebServer();
  const { store, workspace } = handlersWith();
  const dispose = registerRoutes(
    { webServer },
    { store, workspace, clock: () => SERVER_TIME, domainOpenedAt: OPENED_AT },
  );

  assert.deepEqual([...webServer.routes.keys()], Object.values(API_PATHS));
  const { res, json } = await callRegistered(webServer, API_PATHS.health);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(json, { ok: true, domainOpenedAt: OPENED_AT, tickets: 0 });

  dispose();
  assert.equal(webServer.routes.size, 0);
});

test('registerUnavailableRoutes() keeps health 500/503 and other routes 503 until disposed', async () => {
  const webServer = createFakeWebServer();
  const health = {
    status: 'waiting-for-service',
    stage: 'storage-service',
    error: 'ctx.storageDomain / ctx.sessions service unavailable',
  };
  const dispose = registerUnavailableRoutes({ webServer }, health);

  assert.deepEqual([...webServer.routes.keys()], Object.values(API_PATHS));

  const waiting = await callRegistered(webServer, API_PATHS.health);
  assert.equal(waiting.res.statusCode, 500);
  assert.equal(waiting.json.stage, 'storage-service');

  health.status = 'opening';
  health.stage = 'open-domain';
  const opening = await callRegistered(webServer, API_PATHS.health);
  assert.equal(opening.res.statusCode, 503);

  health.status = 'failed';
  health.stage = 'open-domain';
  health.error = 'boom';
  const failed = await callRegistered(webServer, API_PATHS.health);
  assert.equal(failed.res.statusCode, 500);
  assert.equal(failed.json.stage, 'open-domain');
  assert.equal(failed.json.error, 'boom');

  const action = await callRegistered(webServer, API_PATHS.action, {
    method: 'POST',
    body: actionBody(),
  });
  assert.equal(action.res.statusCode, 503);
  assert.equal(action.json.code, 'storage-unavailable');

  const platformToken = await callRegistered(webServer, API_PATHS.platformToken, {
    method: 'POST',
    body: platformTokenBody(),
  });
  assert.equal(platformToken.res.statusCode, 503);
  assert.equal(platformToken.json.code, 'storage-unavailable');

  dispose();
  assert.equal(webServer.routes.size, 0);
});

test('fallback snapshot GET without a Content-Type answers 503 while POST keeps the JSON guard', async () => {
  const webServer = createFakeWebServer();
  const health = { status: 'opening', stage: 'open-domain' };
  const dispose = registerUnavailableRoutes({ webServer }, health);

  // A normal browser GET has no Content-Type: it must get the documented
  // retryable fallback, not the POST-only media-type 415.
  const snapshot = await callRegistered(webServer, API_PATHS.snapshot, {
    method: 'GET',
    url: snapshotUrl(),
    contentType: null,
  });
  assert.equal(snapshot.res.statusCode, 503);
  assert.equal(snapshot.res.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(snapshot.json, {
    ok: false,
    code: 'storage-unavailable',
    message: '存储服务尚未就绪，请稍后重试',
    stage: 'open-domain',
  });

  // The media-type guard still protects the POST fallbacks (text/plain is the
  // no-preflight cross-site bypass), and these routes stay 503 for JSON.
  const textPlain = await callRegistered(webServer, API_PATHS.action, {
    method: 'POST',
    url: API_PATHS.action,
    contentType: 'text/plain',
    body: actionBody(),
  });
  assert.equal(textPlain.res.statusCode, 415);
  assert.equal(textPlain.json.code, 'unsupported-media-type');

  const json = await callRegistered(webServer, API_PATHS.action, {
    method: 'POST',
    url: API_PATHS.action,
    body: actionBody(),
  });
  assert.equal(json.res.statusCode, 503);
  assert.equal(json.json.code, 'storage-unavailable');

  dispose();
  assert.equal(webServer.routes.size, 0);
});
