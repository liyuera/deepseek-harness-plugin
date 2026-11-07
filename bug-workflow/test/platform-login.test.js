/**
 * Unit tests for the platform login service (账号 + 密码 + 图形验证码).
 *
 * The real flow (verified against the live platform):
 *   1. `GET /api/htwisdom-system/system/open-api/system-config?tenantId=000000`
 *      → public `data.clientId` / `data.clientSecret` (the same OAuth client the
 *      frontend sends as `Authorization: Basic`), plus `defaultTenant`;
 *   2. `GET /api/htwisdom-auth/oauth/captcha` → flat `{key, image}`;
 *   3. `POST /api/htwisdom-auth/oauth/token` with `Basic <clientId:clientSecret>`
 *      and a **form-urlencoded** body (`grant_type=captcha`, `password=md5`).
 *
 * Everything runs against a loopback-only mock platform: no real account, no
 * network beyond 127.0.0.1, and the raw password only appears inside a
 * host-side assertion (never in a response/error assertion).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  DEFAULT_TENANT_ID,
  PlatformLoginError,
  createPlatformLogin,
  hashPassword,
} from '../src/host/platform-login.js';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SECRET_PASSWORD = 'Sup3r-Secret-Pass!';
const CLIENT_ID = 'sword';
const CLIENT_SECRET = 'sword_secret';
const EXPECTED_BASIC = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, 'utf8').toString('base64');

/**
 * Start a loopback mock platform. `handler(req, res, body)` receives the parsed
 * JSON body when present, else the raw text; requests are collected.
 */
async function startMock(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = raw === '' ? null : JSON.parse(raw);
      } catch {
        body = undefined;
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body, raw });
      try {
        handler(req, res, body);
      } catch (error) {
        res.statusCode = 500;
        res.end(String(error && error.message));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function configRoute(res, overrides = {}) {
  json(res, 200, {
    code: 200,
    success: true,
    data: {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      defaultTenant: DEFAULT_TENANT_ID,
      ...overrides,
    },
  });
}

function captchaRoute(res) {
  json(res, 200, { key: 'captcha-key-1', image: PNG_DATA_URL });
}

function tokenRoute(res, payload = { access_token: 'token-abc', token_type: 'bearer' }) {
  json(res, 200, { code: 200, success: true, data: payload });
}

function userInfoRoute(res) {
  json(res, 200, { code: 200, success: true, data: { username: 'liyu' } });
}

/** Default mock: public config + optional token/user-info behaviour. */
function defaultHandler({ token, tokenHandler } = {}) {
  return (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/htwisdom-system/system/open-api/system-config') return configRoute(res);
    if (url.pathname === '/api/htwisdom-auth/oauth/captcha') return captchaRoute(res);
    if (url.pathname === '/api/htwisdom-auth/oauth/token') {
      return tokenHandler === undefined ? tokenRoute(res, token) : tokenHandler(res);
    }
    if (url.pathname === '/api/htwisdom-system/user-auth-info') return userInfoRoute(res);
    return json(res, 404, {});
  };
}

test('hashPassword matches the platform js-md5 wire format', () => {
  assert.equal(hashPassword('123456'), 'e10adc3949ba59abbe56e057f20f883e');
});

test('captcha() returns the flat {key,image} payload', async (t) => {
  const mock = await startMock(defaultHandler());
  t.after(() => mock.close());
  const service = createPlatformLogin();
  const result = await service.captcha({ baseUrl: mock.baseUrl });
  assert.equal(result.key, 'captcha-key-1');
  assert.equal(result.image, PNG_DATA_URL);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0].method, 'GET');
});

test('captcha() rejects an invalid base URL before any request', async () => {
  const service = createPlatformLogin();
  await assert.rejects(
    () => service.captcha({ baseUrl: 'ftp://example.com' }),
    (error) => error instanceof PlatformLoginError && error.code === 'invalid-base-url',
  );
  await assert.rejects(
    () => service.login({ baseUrl: 'not a url', username: 'a', password: 'b', code: '1', captchaKey: 'k' }),
    (error) => error instanceof PlatformLoginError && error.code === 'invalid-base-url',
  );
});

test('captcha() maps malformed payloads to a static error', async (t) => {
  const cases = [
    { key: 'k', image: 'not-a-data-url' },
    { key: '', image: PNG_DATA_URL },
    { image: PNG_DATA_URL },
    { data: { key: 'k', image: PNG_DATA_URL } },
  ];
  for (const payload of cases) {
    const mock = await startMock((req, res) => json(res, 200, payload));
    t.after(() => mock.close());
    await assert.rejects(
      () => createPlatformLogin().captcha({ baseUrl: mock.baseUrl }),
      (error) => error instanceof PlatformLoginError && error.code === 'captcha-bad-response',
    );
  }
});

test('login() bootstraps the OAuth client, sends Basic auth + form body and returns the token', async (t) => {
  const mock = await startMock(defaultHandler());
  t.after(() => mock.close());
  const service = createPlatformLogin();
  const result = await service.login({
    baseUrl: mock.baseUrl,
    username: 'liyu',
    password: SECRET_PASSWORD,
    code: '8h3k',
    captchaKey: 'captcha-key-1',
  });

  assert.deepEqual(result, { token: 'token-abc', tokenType: 'bearer', username: 'liyu' });

  const configRequest = mock.requests.find((request) => request.url.includes('/system/open-api/system-config'));
  assert.ok(configRequest !== undefined, 'the public client config must be read first');
  assert.equal(configRequest.url.includes(`tenantId=${DEFAULT_TENANT_ID}`), true);

  const tokenRequest = mock.requests.find((request) => request.url === '/api/htwisdom-auth/oauth/token');
  assert.ok(tokenRequest !== undefined);
  assert.equal(tokenRequest.method, 'POST');
  assert.equal(tokenRequest.headers.authorization, `Basic ${EXPECTED_BASIC}`);
  assert.equal(tokenRequest.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(tokenRequest.headers['tenant-id'], DEFAULT_TENANT_ID);
  assert.equal(tokenRequest.headers['captcha-key'], 'captcha-key-1');
  assert.equal(tokenRequest.headers['captcha-code'], '8h3k');
  assert.equal(tokenRequest.headers['dept-id'], '');
  assert.equal(tokenRequest.headers['role-id'], '');
  // The gateway's "platform info" check requires a browser-like XHR.
  assert.equal(tokenRequest.headers['x-requested-with'], 'XMLHttpRequest');
  assert.equal(tokenRequest.headers['menu-classify'], '1');
  assert.equal(tokenRequest.headers.origin, 'http://127.0.0.1:' + new URL(mock.baseUrl).port);
  assert.equal(tokenRequest.headers.referer, `${mock.baseUrl}/user/login`);
  assert.match(tokenRequest.headers['user-agent'], /Mozilla\/5\.0/);

  // The token request is a querystring, not JSON (JSON is ignored upstream).
  const form = new URLSearchParams(tokenRequest.raw);
  assert.equal(form.get('type'), 'account');
  assert.equal(form.get('scope'), 'all');
  assert.equal(form.get('grant_type'), 'captcha');
  assert.equal(form.get('tenantId'), DEFAULT_TENANT_ID);
  assert.equal(form.get('username'), 'liyu');
  assert.equal(form.get('code'), '8h3k');
  assert.equal(form.get('password'), hashPassword(SECRET_PASSWORD));
  assert.equal(tokenRequest.raw.includes(SECRET_PASSWORD), false, 'raw password must never leave the host');

  const infoRequest = mock.requests.find((request) => request.url === '/api/htwisdom-system/user-auth-info');
  assert.equal(infoRequest.headers['htwisdom-auth'], 'token-abc');
});

test('login() prefers an explicit tenant id and falls back to the config default', async (t) => {
  // Explicit tenant wins.
  {
    const mock = await startMock(defaultHandler());
    t.after(() => mock.close());
    const result = await createPlatformLogin().login({
      baseUrl: mock.baseUrl,
      username: 'u',
      password: 'p',
      code: 'c',
      captchaKey: 'k',
      tenantId: 't-01',
    });
    assert.equal(result.token, 'token-abc');
    const tokenRequest = mock.requests.find((request) => request.url === '/api/htwisdom-auth/oauth/token');
    assert.equal(tokenRequest.headers['tenant-id'], 't-01');
    assert.equal(new URLSearchParams(tokenRequest.raw).get('tenantId'), 't-01');
  }
  // Config defaultTenant wins over the built-in `000000` fallback.
  {
    const mock = await startMock((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/htwisdom-system/system/open-api/system-config') {
        return configRoute(res, { defaultTenant: 'tenant-77' });
      }
      if (url.pathname === '/api/htwisdom-auth/oauth/token') return tokenRoute(res);
      return json(res, 404, {});
    });
    t.after(() => mock.close());
    await createPlatformLogin().login({ baseUrl: mock.baseUrl, username: 'u', password: 'p', code: 'c', captchaKey: 'k' });
    const tokenRequest = mock.requests.find((request) => request.url === '/api/htwisdom-auth/oauth/token');
    assert.equal(new URLSearchParams(tokenRequest.raw).get('tenantId'), 'tenant-77');
  }
});

test('login() fails statically when the public client config is missing', async (t) => {
  const mock = await startMock((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/htwisdom-system/system/open-api/system-config') {
      return json(res, 200, { code: 200, success: true, data: {} });
    }
    return json(res, 404, {});
  });
  t.after(() => mock.close());
  await assert.rejects(
    () => createPlatformLogin().login({ baseUrl: mock.baseUrl, username: 'u', password: 'p', code: 'c', captchaKey: 'k' }),
    (error) => error instanceof PlatformLoginError && error.code === 'login-bad-response',
  );
});

test('login() maps platform failure envelopes to static codes (captcha vs credentials)', async (t) => {
  const cases = [
    { payload: { code: 400, success: false, msg: '验证码不正确' }, expected: 'captcha-invalid', status: 400 },
    { payload: { code: 400, success: false, msg: '用户名或密码错误' }, expected: 'invalid-credentials', status: 400 },
    { payload: { code: 500, success: false, msg: 'system error' }, expected: 'login-failed', status: 400 },
  ];
  for (const item of cases) {
    const mock = await startMock(defaultHandler({
      tokenHandler: (res) => json(res, item.status, item.payload),
    }));
    t.after(() => mock.close());
    await assert.rejects(
      () => createPlatformLogin().login({ baseUrl: mock.baseUrl, username: 'u', password: SECRET_PASSWORD, code: 'c', captchaKey: 'k' }),
      (error) => {
        assert.ok(error instanceof PlatformLoginError);
        assert.equal(error.code, item.expected);
        assert.equal(error.message.includes(SECRET_PASSWORD), false);
        assert.equal(error.message.includes('token'), false);
        return true;
      },
    );
  }
});

test('login() rejects a success envelope without a token', async (t) => {
  const mock = await startMock(defaultHandler({ token: {} }));
  t.after(() => mock.close());
  await assert.rejects(
    () => createPlatformLogin().login({ baseUrl: mock.baseUrl, username: 'u', password: 'p', code: 'c', captchaKey: 'k' }),
    (error) => error instanceof PlatformLoginError && error.code === 'login-bad-response',
  );
});

test('login() validates the required fields without any request', async () => {
  const service = createPlatformLogin();
  const base = { baseUrl: 'http://127.0.0.1:1', username: 'u', password: 'p', code: 'c', captchaKey: 'k' };
  const cases = [
    { ...base, username: '   ' },
    { ...base, password: '' },
    { ...base, code: 42 },
    { ...base, captchaKey: '' },
    { ...base, tenantId: 'bad tenant' },
    { ...base, username: 'x'.repeat(101) },
  ];
  for (const input of cases) {
    await assert.rejects(
      () => service.login(input),
      (error) => error instanceof PlatformLoginError && error.code === 'invalid-input',
    );
  }
});

test('login()/captcha() map network failures and timeouts to static codes', async (t) => {
  const service = createPlatformLogin();
  await assert.rejects(
    () => service.login({ baseUrl: 'http://127.0.0.1:1', username: 'u', password: 'p', code: 'c', captchaKey: 'k' }),
    (error) => error instanceof PlatformLoginError && error.code === 'login-unavailable',
  );
  await assert.rejects(
    () => service.captcha({ baseUrl: 'http://127.0.0.1:1' }),
    (error) => error instanceof PlatformLoginError && error.code === 'captcha-unavailable',
  );

  // A slow platform makes the login attempt time out.
  const mock = await startMock((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/htwisdom-system/system/open-api/system-config') return configRoute(res);
    return setTimeout(() => tokenRoute(res), 500);
  });
  t.after(() => mock.close());
  await assert.rejects(
    () => createPlatformLogin({ timeoutMs: 60 }).login({ baseUrl: mock.baseUrl, username: 'u', password: 'p', code: 'c', captchaKey: 'k' }),
    (error) => error instanceof PlatformLoginError && error.code === 'login-timeout',
  );
});

test('login() never echoes the upstream body or credentials on failure', async (t) => {
  const mock = await startMock(defaultHandler({
    tokenHandler: (res) => json(res, 200, { code: 500, success: false, msg: `boom ${SECRET_PASSWORD} token-abc` }),
  }));
  t.after(() => mock.close());
  await assert.rejects(
    () => createPlatformLogin().login({ baseUrl: mock.baseUrl, username: 'u', password: SECRET_PASSWORD, code: 'c', captchaKey: 'k' }),
    (error) => {
      assert.equal(error.code, 'login-failed');
      assert.equal(error.message.includes(SECRET_PASSWORD), false);
      assert.equal(error.message.includes('token-abc'), false);
      assert.equal(error.message.includes('boom'), false);
      return true;
    },
  );
});

test('captcha() rejects an oversized image payload', async (t) => {
  const huge = `data:image/png;base64,${'A'.repeat(400_100)}`;
  const mock = await startMock((req, res) => json(res, 200, { key: 'k', image: huge }));
  t.after(() => mock.close());
  await assert.rejects(
    () => createPlatformLogin().captcha({ baseUrl: mock.baseUrl }),
    (error) => error instanceof PlatformLoginError
      && (error.code === 'captcha-bad-response' || error.message.includes('过大')),
  );
});
