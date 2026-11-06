/**
 * Unit tests for the platform-token credential store.
 *
 * The store is pure over the `ctx.credentials` seam, so a scripted fake service
 * exercises the real contract: a token is written and resolved through the
 * reference half, `present()` asks `describe()` and never resolves the value,
 * and no failure path ever puts the token into an error message.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_TOKEN_LENGTH,
  PLATFORM_TOKEN_REF,
  TokenStoreError,
  createTokenStore,
} from '../src/host/credentials.js';

const TOKEN = 'p2-dummy-token';

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
