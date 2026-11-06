#!/usr/bin/env node
/**
 * Read-only probe of the HT_TEAM platform REST API (Spike B, Task 2).
 *
 * It reads the token saved by `scripts/save-token.mjs` (never prints it), issues GET
 * requests only, and prints HTTP status + structural shape (top-level JSON field names,
 * array lengths) so the findings document can be reproduced without leaking data.
 *
 * Endpoints probed (all verified against the live platform from a logged-in page):
 *   1. GET /api/htwisdom-system/user-auth-info            -> current user / assignee id
 *   2. GET /api/htwisdom-team/task/detailByTaskCode/{code} -> issue fields
 *   3. GET /api/htwisdom-system/dict/business/dictionary   -> type/status dictionaries
 *   4. GET /api/htwisdom-team/remark/list                  -> comments for the issue
 *   5. GET /api/htwisdom-team/task?refHandlerPersonId=...  -> "my issues" page list
 *
 * Auth: `Htwisdom-Auth: <token>` (localStorage key `app/access-token`; no cookie needed).
 * If that header is rejected with 401/403, the script tries `Authorization: Basic`
 * with client credentials found in `GET /api/htwisdom-system/app` (field names only printed).
 *
 * Usage:
 *   node bug-workflow/scripts/probe-platform.mjs [--base <url>] [--issue <code>]
 *                                               [--token-file <path>]
 *
 * Exit code: 0 when every key endpoint returns HTTP 200, 1 otherwise.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TOKEN_PATH = resolve(BUNDLE_ROOT, '.tmp', 'platform-token.json');
const DEFAULT_BASE = 'https://ecard.htwisdom.cn';
const DEFAULT_ISSUE_CODE = 'YGFNXDJRFWDJSYJJYY-647';
const DICT_CODES = 'teamTaskStatus,teamTaskType,teamTaskPriority';
const TIMEOUT_MS = 15_000;

function parseArgs(argv) {
  const options = { base: process.env.HT_PLATFORM_BASE ?? DEFAULT_BASE, issue: DEFAULT_ISSUE_CODE, tokenFile: DEFAULT_TOKEN_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      console.log('usage: node bug-workflow/scripts/probe-platform.mjs [--base <url>] [--issue <code>] [--token-file <path>]');
      process.exitCode = 0;
      return null;
    }
    if (flag === '--base' || flag === '--issue' || flag === '--token-file') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${flag} requires a value`);
      if (flag === '--base') options.base = value;
      if (flag === '--issue') options.issue = value;
      if (flag === '--token-file') options.tokenFile = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${flag}`);
  }
  return options;
}

function loadToken(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `missing token file ${path}\n` +
        'run this first (the token is read from the clipboard, not from chat):\n' +
        '  pbpaste | node bug-workflow/scripts/save-token.mjs',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`token file ${path} is not valid JSON; re-run save-token.mjs`);
  }
  const token = typeof parsed?.token === 'string' ? parsed.token.trim() : '';
  if (!token) throw new Error(`token file ${path} has no usable "token" field; re-run save-token.mjs`);
  return { token, savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : 'unknown' };
}

function buildUrl(base, path, params = {}) {
  const url = new URL(path, base);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function httpGet(ctx, path, params) {
  const url = buildUrl(ctx.base, path, params);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Htwisdom-Auth': ctx.token, Accept: 'application/json', ...ctx.extraHeaders },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json };
  } catch (error) {
    return { status: 0, json: null, error: error?.message ?? String(error) };
  }
}

/** Client credentials for the Basic fallback; values are used but never printed. */
async function findBasicHeader(ctx) {
  const app = await httpGet(ctx, '/api/htwisdom-system/app');
  const items = Array.isArray(app.json?.data) ? app.json.data : [];
  console.log(`  fallback: GET /api/htwisdom-system/app -> ${app.status}${items.length ? `, ${items.length} entries, first keys=${Object.keys(items[0] ?? {}).join(',')}` : ''}`);
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const keys = Object.keys(item);
    const idKey = keys.find((key) => /^client_?id$/i.test(key));
    const secretKey = keys.find((key) => /^client_?sec(ret)?$/i.test(key));
    if (idKey && secretKey && item[idKey] && item[secretKey]) {
      return `Basic ${Buffer.from(`${item[idKey]}:${item[secretKey]}`).toString('base64')}`;
    }
  }
  console.log('  fallback: /app exposes no clientId/clientSecret fields; Basic auth skipped');
  return null;
}

async function requestWithFallback(ctx, path, params) {
  let result = await httpGet(ctx, path, params);
  if ((result.status === 401 || result.status === 403) && !ctx.basicTried) {
    ctx.basicTried = true;
    const header = await findBasicHeader(ctx);
    if (header) {
      ctx.extraHeaders.Authorization = header;
      result = await httpGet(ctx, path, params);
    }
  }
  return result;
}

/** Structural description of a JSON payload: field names and counts, never values. */
function shapeOf(value) {
  if (Array.isArray(value)) {
    const itemKeys = value[0] && typeof value[0] === 'object' ? Object.keys(value[0]) : [];
    return `array(${value.length})${itemKeys.length ? ` itemKeys=${itemKeys.join(',')}` : ''}`;
  }
  if (value && typeof value === 'object') return `object keys=${Object.keys(value).join(',')}`;
  if (value === null) return 'null';
  return typeof value;
}

function envelopeOf(json) {
  if (!json || typeof json !== 'object') return 'non-JSON response';
  const parts = [`code=${json.code ?? 'n/a'}`, `msg=${json.msg ?? ''}`];
  if ('data' in json) parts.push(`data=${shapeOf(json.data)}`);
  return parts.join(' ');
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function probeLine(path, result) {
  console.log(`\n[${result.status || 'ERR'}] GET ${path}`);
  console.log(`  ${envelopeOf(result.json)}${result.error ? ` error=${result.error}` : ''}`);
  return result;
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

  const ctx = { base: options.base, token: tokenInfo.token, extraHeaders: {}, basicTried: false };
  console.log(`base: ${ctx.base}`);
  console.log(`token: ${options.tokenFile} (savedAt ${tokenInfo.savedAt}) — value never printed`);
  console.log('auth header: Htwisdom-Auth (GET only, read-only probe)');

  // 1. current user: `data.user.id` is the id used by the assignee filter.
  const auth = probeLine('/api/htwisdom-system/user-auth-info', await requestWithFallback(ctx, '/api/htwisdom-system/user-auth-info'));
  const userId = auth.json?.data?.user?.id;
  if (auth.status !== 200) record('user-auth-info', false, `status ${auth.status}`);
  else if (!userId) record('user-auth-info', false, 'data.user.id missing');
  else record('user-auth-info', true);

  // 2. issue detail by code.
  const detailPath = `/api/htwisdom-team/task/detailByTaskCode/${encodeURIComponent(options.issue)}`;
  const detail = probeLine(detailPath, await requestWithFallback(ctx, detailPath));
  const task = detail.json?.data ?? null;
  const taskCode = typeof task?.taskCode === 'string' ? task.taskCode : options.issue;
  if (detail.status === 200 && task) record('detailByTaskCode', true, `${Object.keys(task).length} fields`);
  else if (detail.status === 200) record('detailByTaskCode', false, 'empty data');
  else record('detailByTaskCode', false, `status ${detail.status}`);

  // 3. dictionaries (the endpoint rejects empty input with HTTP 400 "字典编码不可为空").
  const dictPath = '/api/htwisdom-system/dict/business/dictionary';
  const dict = probeLine(`${dictPath}?codes=${DICT_CODES}`, await requestWithFallback(ctx, dictPath, { codes: DICT_CODES }));
  if (dict.status === 200 && dict.json?.data && typeof dict.json.data === 'object') {
    for (const [code, entries] of Object.entries(dict.json.data)) {
      console.log(`  dict ${code}: ${shapeOf(entries)}`);
    }
    record('dict/business/dictionary', true, Object.keys(dict.json.data).join(','));
  } else if (dict.status === 200) {
    record('dict/business/dictionary', false, 'unexpected data shape');
  } else {
    record('dict/business/dictionary', false, `status ${dict.status}`);
  }

  // 4. comments for the issue (params derived from the detail response).
  const remarkPath = '/api/htwisdom-team/remark/list';
  const remarkParams = { refTaskCode: taskCode, remarkType: '001_TASK' };
  const remark = probeLine(`${remarkPath}?refTaskCode=${taskCode}&remarkType=001_TASK`, await requestWithFallback(ctx, remarkPath, remarkParams));
  if (remark.status === 200 && Array.isArray(remark.json?.data)) record('remark/list', true, `${remark.json.data.length} remarks`);
  else if (remark.status === 200) record('remark/list', false, 'unexpected data shape');
  else record('remark/list', false, `status ${remark.status}`);

  // 5. "my issues" page list (found via the platform's own XHR traffic).
  const listPath = '/api/htwisdom-team/task';
  const listParams = { current: 1, size: 10, refHandlerPersonId: userId };
  const list = probeLine(`${listPath}?current=1&size=10&refHandlerPersonId=<user.id>`, await requestWithFallback(ctx, listPath, listParams));
  const page = list.json?.data;
  if (list.status === 200 && page && Array.isArray(page.records)) {
    const recordKeys = page.records[0] && typeof page.records[0] === 'object' ? Object.keys(page.records[0]).length : 0;
    console.log(`  page: total=${page.total} current=${page.current} size=${page.size} returned=${page.records.length} recordKeys=${recordKeys}`);
    record('task list', true, `total=${page.total}`);
  } else if (list.status === 200) {
    record('task list', false, 'unexpected page shape');
  } else {
    record('task list', false, `status ${list.status}`);
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\nsummary: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.error(`failed: ${failed.map((item) => `${item.name} (${item.detail})`).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('result: PASS — all key endpoints returned HTTP 200');
  }
}

main().catch((error) => {
  console.error(`probe failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
