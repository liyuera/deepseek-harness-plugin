/**
 * Domain v2 tests.
 *
 * Two halves, because the schemas cannot be imported under plain Node:
 *
 *   1. `normalizeTicketRecords()` is dependency-free and is exercised here with
 *      a fake domain: v1-shaped rows are rewritten with the v2 defaults,
 *      already-v2 rows are left untouched, and a second pass is a no-op.
 *   2. The real zod schema lives in the DSH runtime. `scripts/verify-domain-v2.mjs`
 *      rebuilds it with the installed app.asar's own zod/domain copies under
 *      Electron-as-node; this file spawns it and checks the PASS contract. On a
 *      machine without the DSH install the test skips instead of failing.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeTicketRecords } from '../src/host/domain-spec.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const VERIFIER = path.resolve(TEST_DIR, '..', 'scripts', 'verify-domain-v2.mjs');

const DEFAULT_APP_BINARY = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const DEFAULT_ASAR_PROBE = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
const DEFAULT_ASAR_DIR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Minimal in-memory `Domain` double that records every `put`, so a test can
 * assert both the persisted shape and that up-to-date rows are not rewritten.
 */
function createFakeDomain(seed = {}) {
  const tables = new Map();
  const writes = [];

  function table(name) {
    let records = tables.get(name);
    if (records === undefined) {
      records = new Map();
      tables.set(name, records);
    }
    return {
      get: (key) => cloneJson(records.get(key)),
      put: async (key, value) => {
        records.set(key, cloneJson(value));
        writes.push({ table: name, key, value: cloneJson(value) });
      },
      delete: async (key) => records.delete(key),
      entries: () => {
        const pairs = [];
        for (const [key, value] of records) pairs.push([key, cloneJson(value)]);
        return pairs[Symbol.iterator]();
      },
      keys: () => records.keys(),
      get size() {
        return records.size;
      },
    };
  }

  for (const [name, rows] of Object.entries(seed)) {
    for (const [key, value] of Object.entries(rows)) {
      const records = tables.get(name) ?? new Map();
      records.set(key, cloneJson(value));
      tables.set(name, records);
    }
  }

  return { tables, writes, table };
}

/** The exact v1 shape P1 persisted: no `source`, no `platform`. */
function v1Ticket(code, overrides = {}) {
  return {
    code,
    title: code,
    type: null,
    status: null,
    version: null,
    priority: null,
    assignee: null,
    url: null,
    workflow: 'inbox',
    blockedFrom: null,
    blockedReason: null,
    plan: null,
    branch: null,
    mr: null,
    fixes: [],
    timeline: [
      { at: '2026-11-07T00:00:00.000Z', kind: 'created', actor: 'system', message: '工单已创建' },
    ],
    createdAt: '2026-11-07T00:00:00.000Z',
    updatedAt: '2026-11-07T00:00:00.000Z',
    ...overrides,
  };
}

const PLATFORM = Object.freeze({
  taskId: 'task-1',
  taskCode: 'TASK-1',
  typeKey: 'bug',
  typeName: '缺陷',
  statusKey: 'todo',
  statusName: '待处理',
  priorityKey: 'high',
  priorityName: '高',
  versionKey: 'v1',
  versionName: 'V1.0.0',
  projectId: 'project-1',
  projectName: '项目一',
  assigneeId: 'user-1',
  assigneeName: '张三',
  description: '平台描述',
  url: 'https://platform.example.com/task/TASK-1',
  syncedAt: 1793994000000,
});

/** Validator double: keeps the record as-is and records what it saw. */
function recordingValidator(seen = []) {
  return (ticket) => {
    seen.push(cloneJson(ticket));
    return ticket;
  };
}

// ---------------------------------------------------------------------------
// normalizeTicketRecords()
// ---------------------------------------------------------------------------

test('normalizeTicketRecords() rewrites v1-shaped rows with the v2 defaults', async () => {
  const domain = createFakeDomain({
    tickets: {
      'BUG-1': v1Ticket('BUG-1'),
      'BUG-2': v1Ticket('BUG-2', { title: '第二张' }),
    },
  });
  const seen = [];

  const normalized = await normalizeTicketRecords(domain, recordingValidator(seen));

  assert.equal(normalized, 2);
  assert.equal(domain.writes.length, 2);
  for (const code of ['BUG-1', 'BUG-2']) {
    const stored = domain.tables.get('tickets').get(code);
    assert.equal(stored.source, 'manual', code);
    assert.equal(stored.platform, null, code);
    assert.equal(Object.hasOwn(stored, 'source'), true, code);
    assert.equal(Object.hasOwn(stored, 'platform'), true, code);
  }
  // The validator is the authority: it saw every record already defaulted.
  assert.equal(seen.length, 2);
  for (const ticket of seen) {
    assert.equal(ticket.source, 'manual');
    assert.equal(ticket.platform, null);
  }
  // Only ticket rows are touched.
  assert.deepEqual(new Set(domain.writes.map((write) => write.table)), new Set(['tickets']));
});

test('normalizeTicketRecords() leaves already-v2 rows untouched', async () => {
  const manual = { ...v1Ticket('BUG-M'), source: 'manual', platform: null };
  const synced = {
    ...v1Ticket('BUG-P'),
    source: 'platform',
    platform: { ...PLATFORM, taskCode: 'BUG-P' },
  };
  const domain = createFakeDomain({ tickets: { 'BUG-M': manual, 'BUG-P': synced } });

  const normalized = await normalizeTicketRecords(domain, recordingValidator());

  assert.equal(normalized, 0);
  assert.equal(domain.writes.length, 0);
  assert.deepEqual(domain.tables.get('tickets').get('BUG-M'), manual);
  assert.deepEqual(domain.tables.get('tickets').get('BUG-P'), synced);
});

test('normalizeTicketRecords() is idempotent', async () => {
  const domain = createFakeDomain({ tickets: { 'BUG-3': v1Ticket('BUG-3') } });

  const first = await normalizeTicketRecords(domain, recordingValidator());
  const afterFirst = cloneJson([...domain.tables.get('tickets').entries()]);
  const writesAfterFirst = domain.writes.length;

  const second = await normalizeTicketRecords(domain, recordingValidator());

  assert.equal(first, 1);
  assert.equal(second, 0);
  assert.equal(domain.writes.length, writesAfterFirst);
  assert.deepEqual([...domain.tables.get('tickets').entries()], afterFirst);
});

test('normalizeTicketRecords() force rewrites already-v2 rows for the one-time migration', async () => {
  // The live one-time migration cannot see the raw v1 shape: the storage
  // facility already parsed the row with the v2 schema (defaults included).
  // The host forces the first physical rewrite and records a meta marker.
  const v2 = { ...v1Ticket('BUG-F'), source: 'manual', platform: null };
  const domain = createFakeDomain({ tickets: { 'BUG-F': v2 } });
  const seen = [];

  const forced = await normalizeTicketRecords(domain, recordingValidator(seen), { force: true });

  assert.equal(forced, 1);
  assert.equal(domain.writes.length, 1);
  assert.equal(domain.writes[0].value.source, 'manual');
  assert.equal(domain.writes[0].value.platform, null);
  assert.equal(seen.length, 1);
});

test('normalizeTicketRecords() rejects a record the schema refuses instead of skipping it', async () => {
  const domain = createFakeDomain({ tickets: { 'BUG-BAD': v1Ticket('BUG-BAD') } });
  const validateTicket = () => {
    throw new Error('platform.taskId 必须是字符串');
  };

  await assert.rejects(
    normalizeTicketRecords(domain, validateTicket),
    /platform\.taskId/,
  );
  assert.equal(domain.writes.length, 0, 'a rejected row must not be written');
  assert.equal(domain.tables.get('tickets').get('BUG-BAD').source, undefined);
});

test('normalizeTicketRecords() fails loud on a non-object row', async () => {
  const domain = createFakeDomain({ tickets: { 'BUG-NULL': null } });

  await assert.rejects(
    normalizeTicketRecords(domain, recordingValidator()),
    /BUG-NULL/,
  );
  assert.equal(domain.writes.length, 0);
});

// ---------------------------------------------------------------------------
// Real-schema verification (Electron-as-node)
// ---------------------------------------------------------------------------

test('domain v2 verifier passes with the installed DSH runtime', (t) => {
  const candidates = [process.env.DSH_APP_BIN, DEFAULT_APP_BINARY].filter(Boolean);
  const appBinary = candidates.find((candidate) => existsSync(candidate));
  const asarDir = process.env.DSH_ASAR_DIR || DEFAULT_ASAR_DIR;
  const asarProbe = process.env.DSH_ASAR_DIR || DEFAULT_ASAR_PROBE;

  if (appBinary === undefined || !existsSync(asarProbe)) {
    t.skip(
      'DSH Electron runtime not found '
        + `(binary: ${process.env.DSH_APP_BIN ?? DEFAULT_APP_BINARY}, `
        + `asar: ${asarProbe}); skipping the real-schema verifier`,
    );
    return;
  }

  const result = spawnSync(appBinary, [VERIFIER], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_ASAR_DIR: asarDir,
    },
    encoding: 'utf8',
    timeout: 120_000,
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(
    result.status,
    0,
    `verify-domain-v2.mjs exited ${String(result.status)}${result.error ? ` (${result.error.message})` : ''}\n${output}`,
  );
  assert.equal(output.includes('FAIL '), false, output);
  for (const expected of [
    'PASS buildDomainSpec: version 2 with compatibleVersions [1]',
    'PASS defineDomain accepts the spec',
    'PASS v1 ticket parses with source=manual platform=null',
    'PASS platform schema declares the 17 plan fields',
    'PASS invalid platform.taskId rejected',
    'PASS invalid platform.syncedAt rejected',
    'PASS invalid source rejected',
    'PASS fix run entry accepted',
    'PASS malformed fix run entry rejected',
    'PASS branch worktree metadata accepted and bounded',
    'PASS review round metadata accepted and bounded',
    'PASS settings defaults platformBaseUrl/gitlabBaseUrl/writebackStatus',
    'PASS settings legacy row without gitlabBaseUrl defaults it',
    'PASS domain v2 contract (15 checks)',
  ]) {
    assert.equal(output.includes(expected), true, `missing verifier output: ${expected}\n${output}`);
  }
});
