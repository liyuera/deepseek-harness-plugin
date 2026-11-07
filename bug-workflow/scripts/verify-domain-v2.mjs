#!/usr/bin/env node
/**
 * Domain v2 contract verifier for the DSH runtime.
 *
 * The plugin's `domain.js` imports `zod` and `@deepseek-ai/dsh-storage-domain`
 * as bare peer dependencies, which plain Node cannot resolve. This script is
 * meant to run on Electron's bundled Node, where the installed app's asar is
 * readable, so it can import the EXACT zod/domain instances the host uses and
 * rebuild the schema from `src/host/domain-spec.js`:
 *
 *   ELECTRON_RUN_AS_NODE=1 \
 *     "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     bug-workflow/scripts/verify-domain-v2.mjs
 *
 * Override the app payload with `DSH_ASAR_DIR` (defaults to the macOS install).
 * Prints one PASS line per contract check and exits non-zero on any failure.
 *
 * `test/domain-v2.test.js` spawns this script; keeping the checks here means the
 * assertion output is observable by hand as well as by the test.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_ASAR_DIR = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh';
const ASAR_DIR = process.env.DSH_ASAR_DIR || DEFAULT_ASAR_DIR;

/** The 17 platform snapshot fields from the P2 plan, in declaration order. */
const PLATFORM_FIELDS = [
  'taskId',
  'taskCode',
  'typeKey',
  'typeName',
  'statusKey',
  'statusName',
  'priorityKey',
  'priorityName',
  'versionKey',
  'versionName',
  'projectId',
  'projectName',
  'assigneeId',
  'assigneeName',
  'description',
  'url',
  'syncedAt',
];

/** A v1-shaped persisted ticket: no `source`, no `platform`. */
function v1Ticket(overrides = {}) {
  return {
    code: 'BUG-V1',
    title: '登录失败',
    type: '缺陷',
    status: '待处理',
    version: 'V1.0.0',
    priority: '高',
    assignee: 'ly',
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

/** A complete platform snapshot with exactly the 17 plan fields. */
function validPlatform(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function unwrapSchema(schema) {
  let current = schema;
  for (let depth = 0; depth < 5 && typeof current?.unwrap === 'function'; depth += 1) {
    current = current.unwrap();
  }
  return current;
}

let checks = 0;
let failures = 0;

function check(label, fn) {
  checks += 1;
  try {
    fn();
    console.log(`PASS ${label}`);
  } catch (error) {
    failures += 1;
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.error(`FAIL ${label}${detail === '' ? '' : `: ${detail}`}`);
  }
}

// ---------------------------------------------------------------------------
// Runtime imports (host copies, via the installed asar)
// ---------------------------------------------------------------------------

const zodPath = path.join(ASAR_DIR, 'node_modules/zod/index.js');
const domainPackagePath = path.join(
  ASAR_DIR,
  'node_modules/@deepseek-ai/dsh-storage-domain/lib/index.js',
);

let z;
let defineDomain;
let buildDomainSpec;

try {
  if (!existsSync(zodPath)) {
    throw new Error(`zod entry not found: ${zodPath} (set DSH_ASAR_DIR)`);
  }
  if (!existsSync(domainPackagePath)) {
    throw new Error(
      `@deepseek-ai/dsh-storage-domain entry not found: ${domainPackagePath} (set DSH_ASAR_DIR)`,
    );
  }
  ({ z } = await import(pathToFileURL(zodPath).href));
  ({ defineDomain } = await import(pathToFileURL(domainPackagePath).href));
  ({ buildDomainSpec } = await import(new URL('../src/host/domain-spec.js', import.meta.url).href));
} catch (error) {
  console.error(
    `FAIL runtime: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

if (z === undefined || typeof z.looseObject !== 'function') {
  console.error('FAIL runtime: imported zod namespace is unusable');
  process.exit(1);
}
if (typeof defineDomain !== 'function') {
  console.error('FAIL runtime: imported defineDomain is not a function');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Contract checks
// ---------------------------------------------------------------------------

const spec = buildDomainSpec({ z, defineDomain });
const ticketSchema = spec.tables.tickets.valueSchema;
const settingsSchema = spec.tables.settings.valueSchema;

check('buildDomainSpec: version 2 with compatibleVersions [1]', () => {
  assert.equal(spec.name, 'bug_workflow');
  assert.equal(spec.version, 2);
  assert.deepEqual(spec.compatibleVersions, [1]);
  assert.deepEqual(
    Object.keys(spec.tables).sort(),
    ['meta', 'settings', 'tickets'],
  );
});

check('defineDomain accepts the spec', () => {
  assert.equal(defineDomain(spec), spec);
});

check('v1 ticket parses with source=manual platform=null', () => {
  const input = v1Ticket();
  const parsed = ticketSchema.parse(input);
  assert.equal(parsed.source, 'manual');
  assert.equal(parsed.platform, null);
  // The parse result is a new record; the stored v1 shape is not mutated.
  assert.equal(Object.hasOwn(input, 'source'), false);
  assert.equal(Object.hasOwn(input, 'platform'), false);
  assert.equal(parsed.code, 'BUG-V1');
  assert.equal(parsed.workflow, 'inbox');
});

check('platform schema declares the 17 plan fields', () => {
  const platformSchema = unwrapSchema(ticketSchema.shape.platform);
  assert.equal(typeof platformSchema.shape, 'object');
  assert.deepEqual(Object.keys(platformSchema.shape), PLATFORM_FIELDS);
});

check('every platform field is required', () => {
  for (const field of PLATFORM_FIELDS) {
    const platform = validPlatform();
    delete platform[field];
    const result = ticketSchema.safeParse(v1Ticket({ source: 'platform', platform }));
    assert.equal(result.success, false, `missing platform.${field} must be rejected`);
  }
});

check('full platform snapshot parses', () => {
  const platform = validPlatform();
  const parsed = ticketSchema.parse(v1Ticket({ source: 'platform', platform }));
  assert.equal(parsed.source, 'platform');
  assert.deepEqual(parsed.platform, platform);
});

check('invalid platform.taskId rejected', () => {
  const bad = ticketSchema.safeParse(
    v1Ticket({ source: 'platform', platform: validPlatform({ taskId: 42 }) }),
  );
  assert.equal(bad.success, false);
});

check('invalid platform.syncedAt rejected', () => {
  for (const syncedAt of ['now', -1, 1.5]) {
    const bad = ticketSchema.safeParse(
      v1Ticket({ source: 'platform', platform: validPlatform({ syncedAt }) }),
    );
    assert.equal(bad.success, false, `syncedAt=${String(syncedAt)} must be rejected`);
  }
});

check('invalid source rejected', () => {
  for (const source of ['imported', 'PLATFORM', null]) {
    const bad = ticketSchema.safeParse(v1Ticket({ source }));
    assert.equal(bad.success, false, `source=${String(source)} must be rejected`);
  }
});

check('fix run entry accepted', () => {
  const entry = {
    runId: 'fix-patch-BUG-V1-2026-11-07T00:00:00.000Z',
    childId: 'child-1',
    startedAt: '2026-11-07T00:00:00.000Z',
    finishedAt: '2026-11-07T00:01:00.000Z',
    changedFiles: ['src/a.js', 'src/new file.js'],
    diffStat: ' 2 files changed, 3 insertions(+)',
    diff: 'diff --git a/src/a.js b/src/a.js\n+fixed',
    summary: '已修复事件绑定',
    testResult: 'node --test：通过',
    notes: '',
    status: 'succeeded',
    elapsedMs: 60000,
  };
  const parsed = ticketSchema.parse(v1Ticket({ workflow: 'fix_done', fixes: [entry] }));
  assert.deepEqual(parsed.fixes, [entry]);
});

check('malformed fix run entry rejected', () => {
  const entry = {
    runId: 'run-1',
    startedAt: '2026-11-07T00:00:00.000Z',
    finishedAt: '2026-11-07T00:01:00.000Z',
    changedFiles: ['src/a.js'],
    diffStat: ' 1 file changed',
    summary: '已修复',
    testResult: '',
    status: 'succeeded',
  };
  const malformed = [
    { ...entry, runId: 42 },
    { ...entry, runId: '' },
    { ...entry, changedFiles: 'src/a.js' },
    { ...entry, changedFiles: [42] },
    { ...entry, status: 'ok' },
    { ...entry, finishedAt: null },
    { ...entry, elapsedMs: -1 },
    { ...entry, diff: 42 },
  ];
  for (const candidate of malformed) {
    const result = ticketSchema.safeParse(v1Ticket({ fixes: [candidate] }));
    assert.equal(result.success, false, `malformed entry accepted: ${JSON.stringify(candidate)}`);
  }
});

check('branch worktree metadata accepted and bounded', () => {
  const branch = {
    name: 'feat-V1.0.0-ly',
    target: 'feature-V1.0.0',
    baseSource: 'origin',
    worktree: '/repo/.dsh-worktrees/BUG-V1',
    createdAt: '2026-11-07T00:00:00.000Z',
  };
  const parsed = ticketSchema.parse(v1Ticket({ branch }));
  assert.deepEqual(parsed.branch, branch);

  const malformed = [
    { ...branch, worktree: 42 },
    { ...branch, worktree: 'x'.repeat(4097) },
    { ...branch, createdAt: 42 },
    { ...branch, createdAt: 'x'.repeat(65) },
  ];
  for (const candidate of malformed) {
    const result = ticketSchema.safeParse(v1Ticket({ branch: candidate }));
    assert.equal(
      result.success,
      false,
      `malformed branch metadata accepted: ${JSON.stringify(candidate).slice(0, 120)}`,
    );
  }
});

check('settings defaults platformBaseUrl/gitlabBaseUrl/writebackStatus', () => {
  const parsed = settingsSchema.parse({});
  assert.equal(parsed.platformBaseUrl, 'https://ecard.htwisdom.cn');
  assert.equal(parsed.gitlabBaseUrl, 'https://git.htwisdom.cn');
  assert.equal(parsed.writebackStatus, false);

  const enabled = settingsSchema.parse({ writebackStatus: true });
  assert.equal(enabled.writebackStatus, true);
  assert.equal(enabled.platformBaseUrl, 'https://ecard.htwisdom.cn');
  assert.equal(enabled.gitlabBaseUrl, 'https://git.htwisdom.cn');
});

check('settings legacy row without gitlabBaseUrl defaults it', () => {
  // A record written by P1-P4 has no gitlabBaseUrl key. `looseObject` plus the
  // schema default must fill it instead of failing the domain open.
  const legacy = {
    platformBaseUrl: 'https://ecard.htwisdom.cn',
    platformProjectCode: '',
    gitlabProjectPath: 'group/project',
    branchUser: 'ly',
    gitlabReviewer: '',
    commitType: 'fix',
    lintCommand: '',
    testCommand: '',
    devCommand: '',
    previewUrl: '',
    writebackStatus: false,
  };
  assert.equal(Object.hasOwn(legacy, 'gitlabBaseUrl'), false);
  const parsed = settingsSchema.parse(legacy);
  assert.equal(parsed.gitlabBaseUrl, 'https://git.htwisdom.cn');
  assert.equal(parsed.gitlabProjectPath, 'group/project');
  assert.equal(parsed.branchUser, 'ly');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`FAIL domain v2 contract: ${failures}/${checks} checks failed`);
  process.exit(1);
}

console.log(`PASS domain v2 contract (${checks} checks)`);
