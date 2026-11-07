/**
 * Unit tests for the host token credential stores.
 *
 * The store is pure over the `ctx.credentials` seam, so a scripted fake service
 * exercises the real contract: a token is written and resolved through the
 * reference half, `present()` asks `describe()` and never resolves the value,
 * and no failure path ever puts the token into an error message. P5 adds a
 * second reference (GitLab) behind the same implementation, so the shared
 * validation/containment rules are asserted for both refs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GITLAB_TOKEN_REF,
  MAX_TOKEN_LENGTH,
  PLATFORM_TOKEN_REF,
  TokenStoreError,
  createTokenStore,
} from '../src/host/credentials.js';

const TOKEN = 'p2-dummy-token';
const GITLAB_TOKEN = 'p5-dummy-gitlab-token';

/**
 * Fake `ctx.credentials` reference half. `failures` maps a method name to an
 * error it should throw, so the store's containment behaviour is testable.
 */
function createFakeCredentials({ refs = {}, failures = {} } = {}) {
  const values = new Map(Object.entries(refs));
  const calls = { set: [], resolve: [], describe: [], unset: [] };

  const fail = (method) => {
    const error = failures[method];
    if (error !== undefined) throw error;
  };

  return {
    values,
    calls,
    async set(ref, value) {
      calls.set.push({ ref, value });
      fail('set');
      values.set(ref, value);
    },
    async resolve(ref) {
      calls.resolve.push(ref);
      fail('resolve');
      if (!values.has(ref)) return undefined;
      return { value: values.get(ref), source: 'file' };
    },
    async describe(ref) {
      calls.describe.push(ref);
      fail('describe');
      return values.has(ref)
        ? { configured: true, source: 'file', writable: true }
        : { configured: false, writable: true };
    },
    async unset(ref) {
      calls.unset.push(ref);
      fail('unset');
      values.delete(ref);
    },
  };
}

test('token store saves, reads, and reports presence through the credential seam', async () => {
  const credentials = createFakeCredentials();
  const store = createTokenStore(credentials);

  assert.equal(await store.present(), false);
  assert.equal(await store.get(), null);

  await store.set(TOKEN);
  assert.deepEqual(credentials.calls.set, [{ ref: PLATFORM_TOKEN_REF, value: TOKEN }]);
  assert.equal(await store.get(), TOKEN);
  assert.equal(await store.present(), true);
  assert.equal(await store.get(), TOKEN);

  await store.clear();
  assert.deepEqual(credentials.calls.unset, [PLATFORM_TOKEN_REF]);
  assert.equal(await store.get(), null);
  assert.equal(await store.present(), false);
});

test('token store trims surrounding whitespace and replaces an existing token', async () => {
  const credentials = createFakeCredentials({ refs: { [PLATFORM_TOKEN_REF]: 'old-token' } });
  const store = createTokenStore(credentials);

  await store.set(`  ${TOKEN}\n`);
  assert.equal(credentials.values.get(PLATFORM_TOKEN_REF), TOKEN);
  assert.equal(await store.get(), TOKEN);
});

test('token store accepts exactly the 8192-character boundary and rejects longer values', async () => {
  const credentials = createFakeCredentials();
  const store = createTokenStore(credentials);

  const boundary = 'x'.repeat(MAX_TOKEN_LENGTH);
  await store.set(boundary);
  assert.equal(await store.get(), boundary);

  await assert.rejects(
    store.set('x'.repeat(MAX_TOKEN_LENGTH + 1)),
    (error) => error instanceof TokenStoreError && error.code === 'invalid-token',
  );
});

test('token store rejects non-string and blank tokens without writing', async () => {
  for (const token of [undefined, null, 42, {}, [], '', '   ', '\n\t']) {
    const credentials = createFakeCredentials();
    const store = createTokenStore(credentials);
    await assert.rejects(
      store.set(token),
      (error) => error instanceof TokenStoreError && error.code === 'invalid-token',
      String(token),
    );
    assert.equal(credentials.calls.set.length, 0, String(token));
  }
});

test('invalid-token messages never contain the rejected value', async () => {
  const secret = `secret-${'z'.repeat(MAX_TOKEN_LENGTH)}`;
  const store = createTokenStore(createFakeCredentials());

  await assert.rejects(store.set(secret), (error) => {
    assert.equal(error.code, 'invalid-token');
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes('z'.repeat(32)), false);
    return true;
  });
});

test('provider failures are contained and never echo the token', async () => {
  const secret = 'p2-provider-secret';
  const credentials = createFakeCredentials({
    failures: {
      set: new Error(`credentials-local: failed to write ${secret}`),
      resolve: new Error(`credentials-local: failed to read ${secret}`),
      describe: new Error(`credentials-local: failed to describe ${secret}`),
      unset: new Error(`credentials-local: failed to remove ${secret}`),
    },
  });
  const store = createTokenStore(credentials);

  for (const operation of [
    () => store.set(secret),
    () => store.get(),
    () => store.clear(),
  ]) {
    await assert.rejects(operation, (error) => {
      assert.equal(error.code, 'credentials-unavailable');
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }

  // Presence is a status flag: a failing describe reads as "not configured"
  // instead of breaking the board snapshot.
  assert.equal(await store.present(), false);
});

test('an unavailable credentials service yields tokenPresent false and structured errors', async () => {
  const cases = [undefined, null, {}, { set() {} }, {
    set() {},
    resolve() {},
    describe() {},
    // deliberately no unset
  }];

  for (const credentials of cases) {
    const store = createTokenStore(credentials);
    assert.equal(await store.present(), false);
    await assert.rejects(store.get(), (error) => {
      assert.equal(error.code, 'credentials-unavailable');
      assert.equal(error.name, 'TokenStoreError');
      return true;
    });
    await assert.rejects(store.set(TOKEN), { code: 'credentials-unavailable' });
    await assert.rejects(store.clear(), { code: 'credentials-unavailable' });
  }
});

test('get() reports a missing or empty resolved value as null', async () => {
  const credentials = createFakeCredentials();
  const store = createTokenStore(credentials);
  assert.equal(await store.get(), null);

  // The seam's empty-value rule normally makes this unreachable, but a
  // defensive check keeps an empty string from looking like a configured token.
  credentials.values.set(PLATFORM_TOKEN_REF, '');
  assert.equal(await store.get(), null);
  credentials.values.set(PLATFORM_TOKEN_REF, 42);
  assert.equal(await store.get(), null);
});

// ---------------------------------------------------------------------------
// GitLab token reference (P5)
// ---------------------------------------------------------------------------

test('GITLAB_TOKEN_REF is the environment-shaped GitLab credential key', () => {
  assert.equal(GITLAB_TOKEN_REF, 'BUG_WORKFLOW_GITLAB_TOKEN');
  assert.match(GITLAB_TOKEN_REF, /^[A-Za-z_][A-Za-z0-9_]*$/);
  assert.notEqual(GITLAB_TOKEN_REF, PLATFORM_TOKEN_REF);
});

test('a ref-scoped store saves, reads, reports and clears only the GitLab ref', async () => {
  const credentials = createFakeCredentials({ refs: { [PLATFORM_TOKEN_REF]: 'platform-keep' } });
  const store = createTokenStore(credentials, { ref: GITLAB_TOKEN_REF });

  assert.equal(await store.present(), false);
  assert.equal(await store.get(), null);

  await store.set(GITLAB_TOKEN);
  assert.deepEqual(credentials.calls.set, [
    { ref: GITLAB_TOKEN_REF, value: GITLAB_TOKEN },
  ]);
  assert.equal(await store.get(), GITLAB_TOKEN);
  assert.equal(await store.present(), true);
  // The platform credential is untouched by the GitLab store.
  assert.equal(credentials.values.get(PLATFORM_TOKEN_REF), 'platform-keep');

  await store.clear();
  assert.deepEqual(credentials.calls.unset, [GITLAB_TOKEN_REF]);
  assert.equal(await store.get(), null);
  assert.equal(await store.present(), false);
  assert.equal(credentials.values.get(PLATFORM_TOKEN_REF), 'platform-keep');
});

test('two ref-scoped stores over one credentials service are independent', async () => {
  const credentials = createFakeCredentials();
  const platform = createTokenStore(credentials);
  const gitlab = createTokenStore(credentials, { ref: GITLAB_TOKEN_REF });

  await platform.set(TOKEN);
  await gitlab.set(GITLAB_TOKEN);

  assert.equal(await platform.get(), TOKEN);
  assert.equal(await gitlab.get(), GITLAB_TOKEN);
  assert.equal(await platform.present(), true);
  assert.equal(await gitlab.present(), true);

  await gitlab.clear();
  assert.equal(await gitlab.get(), null);
  assert.equal(await gitlab.present(), false);
  assert.equal(await platform.get(), TOKEN);
  assert.equal(await platform.present(), true);
});

test('omitting options (and passing an empty object) keeps the platform ref', async () => {
  for (const options of [undefined, {}, null]) {
    const credentials = createFakeCredentials();
    const store = options === null
      ? createTokenStore(credentials, null)
      : createTokenStore(credentials, options);
    await store.set(TOKEN);
    assert.deepEqual(credentials.calls.set, [{ ref: PLATFORM_TOKEN_REF, value: TOKEN }]);
  }
});

test('the GitLab store shares the token validation rules', async () => {
  const credentials = createFakeCredentials();
  const store = createTokenStore(credentials, { ref: GITLAB_TOKEN_REF });

  for (const token of [undefined, null, 42, {}, [], '', '   ', '\n\t']) {
    await assert.rejects(
      store.set(token),
      (error) => error instanceof TokenStoreError && error.code === 'invalid-token',
      String(token),
    );
  }
  assert.equal(credentials.calls.set.length, 0);

  const boundary = 'x'.repeat(MAX_TOKEN_LENGTH);
  await store.set(boundary);
  assert.equal(await store.get(), boundary);
  await assert.rejects(
    store.set('x'.repeat(MAX_TOKEN_LENGTH + 1)),
    (error) => error instanceof TokenStoreError && error.code === 'invalid-token',
  );

  await store.set(`  ${GITLAB_TOKEN}\n`);
  assert.equal(credentials.values.get(GITLAB_TOKEN_REF), GITLAB_TOKEN);
});

test('GitLab token failures are contained and never echo the token', async () => {
  const secret = 'p5-provider-secret';
  const credentials = createFakeCredentials({
    failures: {
      set: new Error(`credentials-local: failed to write ${secret}`),
      resolve: new Error(`credentials-local: failed to read ${secret}`),
      describe: new Error(`credentials-local: failed to describe ${secret}`),
      unset: new Error(`credentials-local: failed to remove ${secret}`),
    },
  });
  const store = createTokenStore(credentials, { ref: GITLAB_TOKEN_REF });

  for (const operation of [
    () => store.set(secret),
    () => store.get(),
    () => store.clear(),
  ]) {
    await assert.rejects(operation, (error) => {
      assert.equal(error.code, 'credentials-unavailable');
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
  assert.equal(await store.present(), false);
});

test('the GitLab store reports unavailable credentials instead of throwing', async () => {
  for (const credentials of [undefined, null, {}, { set() {} }]) {
    const store = createTokenStore(credentials, { ref: GITLAB_TOKEN_REF });
    assert.equal(await store.present(), false);
    await assert.rejects(store.get(), { code: 'credentials-unavailable' });
    await assert.rejects(store.set(GITLAB_TOKEN), { code: 'credentials-unavailable' });
    await assert.rejects(store.clear(), { code: 'credentials-unavailable' });
  }
});

// ---------------------------------------------------------------------------
// ref validation (P5 Task 2 folded review minor)
// ---------------------------------------------------------------------------

test('createTokenStore rejects malformed refs instead of falling back to the platform ref', async () => {
  const invalidRefs = [
    '',
    ' ',
    '  BUG_WORKFLOW_GITLAB_TOKEN',
    'bug-workflow.gitlab-token',
    'BUG-WORKFLOW-GITLAB-TOKEN',
    '1BUG_WORKFLOW',
    'BUG WORKFLOW',
    'BUG/WORKFLOW',
    42,
    {},
    [],
    true,
    null,
  ];

  for (const ref of invalidRefs) {
    const credentials = createFakeCredentials();
    assert.throws(
      () => createTokenStore(credentials, { ref }),
      (error) => error instanceof TypeError && /ref/.test(error.message),
      String(ref),
    );
    // Nothing was read or written: an invalid ref never degrades to the
    // platform credential.
    assert.equal(credentials.calls.resolve.length, 0, String(ref));
    assert.equal(credentials.calls.set.length, 0, String(ref));
  }

  for (const options of ['ref', 42, true]) {
    assert.throws(() => createTokenStore(createFakeCredentials(), options), TypeError, String(options));
  }

  // Valid environment-shaped refs pass and write only their own reference.
  const custom = createFakeCredentials();
  const customStore = createTokenStore(custom, { ref: 'BUG_WORKFLOW_CUSTOM_TOKEN' });
  await customStore.set(TOKEN);
  assert.deepEqual(custom.calls.set, [{ ref: 'BUG_WORKFLOW_CUSTOM_TOKEN', value: TOKEN }]);
  assert.equal(custom.calls.set.some((call) => call.ref === PLATFORM_TOKEN_REF), false);
  assert.equal(custom.values.has(PLATFORM_TOKEN_REF), false);

  const lower = createFakeCredentials();
  const lowerStore = createTokenStore(lower, { ref: 'bug_workflow_lower_token' });
  await lowerStore.set(TOKEN);
  assert.deepEqual(lower.calls.set, [{ ref: 'bug_workflow_lower_token', value: TOKEN }]);
});
