#!/usr/bin/env node
/**
 * Save a platform access token from stdin into `bug-workflow/.tmp/platform-token.json`.
 *
 * The token is read from stdin only (no terminal prompt, no echo, never printed back),
 * because the token grants read access to the company platform and must not travel
 * through chat history or shell history.
 *
 * Usage (macOS, token copied from the platform's localStorage `app/access-token`):
 *
 *   mkdir -p bug-workflow/.tmp
 *   pbpaste | node bug-workflow/scripts/save-token.mjs
 *
 * Output file shape: { "token": "<opaque>", "savedAt": "<ISO-8601>" }, mode 0600.
 * The file lives under a gitignored directory (`.gitignore`: `bug-workflow/.tmp/`).
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_PATH = resolve(BUNDLE_ROOT, '.tmp', 'platform-token.json');
const DISPLAY_PATH = 'bug-workflow/.tmp/platform-token.json';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Accept a raw token, a JSON string, or a JSON object carrying the token. */
function normalize(raw) {
  let text = raw.replace(/^\uFEFF/, '').trim();
  if (!text) return '';
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      text = JSON.parse(text);
    } catch {
      /* keep the raw text */
    }
  } else if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const candidate = parsed?.token ?? parsed?.access_token ?? parsed?.data?.access_token;
      if (typeof candidate === 'string') text = candidate;
    } catch {
      /* keep the raw text */
    }
  }
  return String(text ?? '').trim();
}

async function main() {
  if (process.stdin.isTTY) {
    console.error(
      'no token on stdin: pipe it instead of typing it, e.g.\n' +
        '  mkdir -p bug-workflow/.tmp\n' +
        '  pbpaste | node bug-workflow/scripts/save-token.mjs',
    );
    process.exitCode = 1;
    return;
  }

  const token = normalize(await readStdin());
  if (!token) {
    console.error('empty token on stdin; nothing saved');
    process.exitCode = 1;
    return;
  }
  if (/\s/.test(token)) {
    // A platform token never contains whitespace; this catches a half-copied paste
    // without ever echoing the value.
    console.error('token contains whitespace; copy only the token value and retry');
    process.exitCode = 1;
    return;
  }

  mkdirSync(dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_PATH, `${JSON.stringify({ token, savedAt: new Date().toISOString() }, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(TOKEN_PATH, 0o600);
  console.log(`saved to ${DISPLAY_PATH}`);
}

main().catch((error) => {
  console.error(`save-token failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
