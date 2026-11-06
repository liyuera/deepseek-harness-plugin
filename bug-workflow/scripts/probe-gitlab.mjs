#!/usr/bin/env node
/**
 * Read-only GitLab probe for Spike C (Task 3).
 *
 * It loads a GitLab personal access token, calls the merge-request notes endpoint,
 * filters `AI Code Review` notes, runs `parseReview` on the newest one and prints the
 * verdict plus blocking/non-blocking counts. Only GET requests are issued; the script
 * never posts, merges, resolves or edits anything on GitLab.
 *
 * Token handling:
 *   - default file: `bug-workflow/.tmp/gitlab-token.json` (gitignored, mode 0600)
 *     shape: { "token": "<personal access token, scope=api>", "savedAt": "<ISO-8601>" }
 *   - or a one-off `GITLAB_TOKEN` environment variable.
 *   The token is only sent in the `PRIVATE-TOKEN` header and is never printed.
 *
 * Usage:
 *   node bug-workflow/scripts/probe-gitlab.mjs [--base <url>] [--project <path>]
 *                                             [--mr <iid>] [--token-file <path>]
 *
 * Exit codes: 0 = notes fetched and latest AI review parsed; 1 = request/no-token/
 * no-AI-note failure; 2 = notes fetched but the latest AI review is `unknown`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReview } from './review-parser.mjs';

const BUNDLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TOKEN_PATH = resolve(BUNDLE_ROOT, '.tmp', 'gitlab-token.json');
const DEFAULT_BASE = 'https://git.htwisdom.cn';
const DEFAULT_PROJECT = 'wisdom-financial-service-platform/wisdom-financial-credit-platform-web';
const DEFAULT_MR = '223';
const TIMEOUT_MS = 15_000;
const AI_MARKER = 'AI Code Review';

function parseArgs(argv) {
  const options = {
    base: process.env.GITLAB_BASE ?? DEFAULT_BASE,
    project: process.env.GITLAB_PROJECT ?? DEFAULT_PROJECT,
    mr: process.env.GITLAB_MR ?? DEFAULT_MR,
    tokenFile: process.env.GITLAB_TOKEN_FILE ? resolve(process.env.GITLAB_TOKEN_FILE) : DEFAULT_TOKEN_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      console.log(
        'usage: node bug-workflow/scripts/probe-gitlab.mjs [--base <url>] [--project <group/project>] [--mr <iid>] [--token-file <path>]',
      );
      return null;
    }
    if (flag === '--base' || flag === '--project' || flag === '--mr' || flag === '--token-file') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${flag} requires a value`);
      if (flag === '--base') options.base = value;
      if (flag === '--project') options.project = value;
      if (flag === '--mr') options.mr = value;
      if (flag === '--token-file') options.tokenFile = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${flag}`);
  }
  return options;
}

function loadToken(path) {
  const envToken = process.env.GITLAB_TOKEN?.trim();
  if (envToken) return { token: envToken, source: 'GITLAB_TOKEN (environment)', savedAt: 'n/a' };

  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `missing GitLab token file ${path}\n` +
        'create it with mode 0600 and this shape (never paste a token into chat):\n' +
        '  { "token": "<gitlab personal access token, scope=api>", "savedAt": "<ISO-8601>" }\n' +
        'or set GITLAB_TOKEN for a one-off run. The token is never printed by this script.',
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`token file ${path} is not valid JSON`);
  }
  const token = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
  if (!token) throw new Error(`token file ${path} has no usable "token" field`);
  if (/\s/.test(token)) throw new Error(`token file ${path} contains whitespace in the token value`);
  return { token, source: path, savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : 'unknown' };
}

function buildUrl(base, path, params = {}) {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

async function httpGet(ctx, path, params) {
  const url = buildUrl(ctx.base, path, params);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'PRIVATE-TOKEN': ctx.token,
        Accept: 'application/json',
        'User-Agent': 'dsh-bug-workflow-spike/0.0.1',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return {
      status: response.status,
      json,
      contentType: response.headers.get('content-type'),
      total: response.headers.get('x-total'),
      totalPages: response.headers.get('x-total-pages'),
    };
  } catch (error) {
    return { status: 0, json: null, error: error?.message ?? String(error) };
  }
}

function compareNotesDesc(left, right) {
  const leftTime = Date.parse(left.created_at ?? '');
  const rightTime = Date.parse(right.created_at ?? '');
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime;
  return Number(right.id ?? 0) - Number(left.id ?? 0);
}

function describeNote(note) {
  const kind = note.system ? 'system' : 'user';
  const manual = typeof note.body === 'string' && note.body.includes('人工复核结果') ? 'manual-reconciliation' : 'ai-review';
  return `#${note.id} ${note.created_at ?? 'unknown-time'} ${kind} ${manual}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;

  let tokenInfo;
  try {
    tokenInfo = loadToken(options.tokenFile);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const project = String(options.project ?? '').replace(/^\/+|\/+$/g, '');
  if (!project.includes('/')) throw new Error(`--project must look like group/project, got "${project}"`);

  console.log('GitLab AI Review probe (read-only)');
  console.log(`base: ${options.base}`);
  console.log(`project: ${project}`);
  console.log(`MR: !${options.mr}`);
  console.log(`token: ${tokenInfo.source} (savedAt ${tokenInfo.savedAt}) — value never printed`);
  console.log('auth: PRIVATE-TOKEN header; GET only');

  const notesPath = `/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${encodeURIComponent(options.mr)}/notes`;
  const notes = await httpGet({ base: options.base, token: tokenInfo.token }, notesPath, { sort: 'desc', per_page: 100 });

  if (notes.status !== 200 || !Array.isArray(notes.json)) {
    if (notes.error) console.error(`notes request failed: ${notes.error}`);
    else if (notes.status === 401 || notes.status === 403) console.error(`notes request rejected: HTTP ${notes.status} (token invalid/insufficient scope)`);
    else console.error(`notes request failed: HTTP ${notes.status}, content-type=${notes.contentType ?? 'n/a'}, body is not a note array`);
    process.exitCode = 1;
    return;
  }

  const allNotes = notes.json;
  const aiNotes = allNotes.filter((note) => typeof note.body === 'string' && note.body.includes(AI_MARKER)).sort(compareNotesDesc);
  console.log(
    `notes: HTTP 200, x-total=${notes.total ?? allNotes.length}, returned=${allNotes.length}, x-total-pages=${notes.totalPages ?? 'n/a'}, ai-review=${aiNotes.length}`,
  );

  if (!aiNotes.length) {
    console.error('no AI Code Review note found');
    process.exitCode = 1;
    return;
  }

  console.log('\nAI review notes (newest first):');
  const parsedById = new Map();
  for (const note of aiNotes) {
    const result = parseReview(note.body);
    parsedById.set(note.id, result);
    console.log(
      `  ${describeNote(note)} verdict=${result.verdict} blocking=${result.blocking.length} nonBlocking=${result.nonBlocking.length}`,
    );
  }

  const latest = aiNotes[0];
  const latestResult = parsedById.get(latest.id);
  console.log(`\nlatest: ${describeNote(latest)}`);
  console.log(`verdict: ${latestResult.verdict}`);
  console.log(`blocking: ${latestResult.blocking.length}`);
  console.log(`nonBlocking: ${latestResult.nonBlocking.length}`);

  const top = [...latestResult.blocking, ...latestResult.nonBlocking].slice(0, 3);
  if (top.length) {
    console.log('issues (top 3):');
    for (const issue of top) {
      console.log(`  - file=${issue.file} level=${issue.level} gateCategory=${issue.gateCategory} location=${issue.location}`);
    }
  }

  if (latestResult.verdict === 'unknown') {
    console.error('result: UNKNOWN — the latest AI review does not match the expected template; P1 must block instead of guessing');
    process.exitCode = 2;
    return;
  }
  console.log('result: PASS — notes fetched and the latest AI review parsed');
}

main().catch((error) => {
  console.error(`probe failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
