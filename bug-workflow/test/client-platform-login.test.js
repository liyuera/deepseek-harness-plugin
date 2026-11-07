/**
 * Source-level contract guards for the P6 in-board platform login.
 *
 * `client.js` is a browser bundle that cannot be imported from Node and the
 * repo has no React test renderer; these assertions keep the security-relevant
 * parts of the login UI from regressing: the password must be a one-shot field,
 * only the account name may be remembered, the captcha goes through the host
 * route, and the manual token paste stays available as a fallback.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CLIENT_URL = new URL('../client.js', import.meta.url);
const SOURCE = readFileSync(CLIENT_URL, 'utf8');

test('the client calls the P6 platform-login routes', () => {
  assert.ok(SOURCE.includes("platformCaptcha: '/bug-workflow/api/platform-login/captcha'"));
  assert.ok(SOURCE.includes("platformLogin: '/bug-workflow/api/platform-login'"));
  assert.ok(SOURCE.includes('postMutation(API.platformCaptcha'));
  assert.ok(SOURCE.includes('postMutation(API.platformLogin'));
});

test('the password is a one-shot field and is never persisted', () => {
  // Rendered as a password input with the browser password manager hints.
  assert.ok(SOURCE.includes("type: 'password'"));
  assert.ok(SOURCE.includes("autoComplete: 'current-password'"));
  // Cleared on success and on panel close.
  assert.ok(SOURCE.includes('setLoginPassword(\'\')'));
  // Remembering is restricted to the account name; no localStorage write may
  // mention the password.
  assert.ok(SOURCE.includes('localStorage.setItem(PLATFORM_LOGIN_USERNAME_KEY'));
  assert.equal(/localStorage\.setItem\([^)]*password/i.test(SOURCE), false);
  assert.equal(/localStorage\.setItem\([^)]*loginPassword/i.test(SOURCE), false);
  // The raw password is never rendered back as text.
  assert.equal(/h\('[^']*',[^)]*\{[^}]*\}\s*,\s*loginPassword\)/.test(SOURCE), false);
});

test('the manual token paste stays available as a collapsed fallback', () => {
  assert.ok(SOURCE.includes('PLATFORM_LOGIN_UI.manualToggle'));
  assert.ok(SOURCE.includes('PLATFORM_LOGIN_UI.manualToggleOpen'));
  assert.ok(SOURCE.includes('setManualOpen'));
  // TokenCard (the paste fallback) is still rendered for the platform scope.
  assert.ok(SOURCE.includes("scope: 'platform'"));
});

test('the platform login UI is wired into the settings panel', () => {
  assert.ok(SOURCE.includes('function PlatformLoginBlock'));
  assert.ok(SOURCE.includes('function platformLoginErrorView'));
  assert.ok(SOURCE.includes('onLoginSubmit'));
  assert.ok(SOURCE.includes('onRefreshCaptcha'));
  // Login never bypasses the host: only a POST to the login route triggers it.
  assert.equal(/h\(PlatformLoginBlock/.test(SOURCE), true);
});
