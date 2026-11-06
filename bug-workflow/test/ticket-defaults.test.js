/**
 * Unit tests for the dependency-free Ticket platform defaults.
 *
 * `withPlatformDefaults()` is the pure half of domain v2: the store applies it
 * to every freshly created ticket so persisted rows always carry the
 * `source`/`platform` fields the v2 zod schema declares. These tests run under
 * plain Node (`node --test`), where `domain.js`'s bare `zod` import cannot be
 * resolved, so the schema itself is verified live through the installed plugin
 * instead.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { withPlatformDefaults } from '../src/host/ticket-defaults.js';

/** The exact shape P1 persisted: no `source`, no `platform`. */
function v1Ticket(overrides = {}) {
  return {
    code: 'BUG-1',
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

test('withPlatformDefaults() fills source=manual and platform=null for a v1 ticket', () => {
  const ticket = withPlatformDefaults(v1Ticket());

  assert.equal(ticket.source, 'manual');
  assert.equal(ticket.platform, null);
});

test('withPlatformDefaults() preserves an existing source and platform record', () => {
  const platform = {
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
  };
  const ticket = withPlatformDefaults(v1Ticket({ source: 'platform', platform }));

  assert.equal(ticket.source, 'platform');
  assert.deepEqual(ticket.platform, platform);
});

test('withPlatformDefaults() is idempotent', () => {
  const once = withPlatformDefaults(v1Ticket());
  const twice = withPlatformDefaults(once);

  assert.deepEqual(twice, once);
});

test('withPlatformDefaults() never mutates its input and returns a new ticket', () => {
  const original = v1Ticket();
  const snapshot = structuredClone(original);
  const ticket = withPlatformDefaults(original);

  assert.notEqual(ticket, original);
  assert.deepEqual(original, snapshot, 'the input ticket must stay untouched');
  assert.equal(Object.hasOwn(original, 'source'), false);
  assert.equal(Object.hasOwn(original, 'platform'), false);
});

test('withPlatformDefaults() leaves every other field byte-for-byte intact', () => {
  const original = v1Ticket();
  const ticket = withPlatformDefaults(original);

  for (const field of Object.keys(original)) {
    assert.deepEqual(ticket[field], original[field], `field ${field} must be preserved`);
  }
});

test('withPlatformDefaults() returns non-object input unchanged for the schema to reject', () => {
  assert.equal(withPlatformDefaults(null), null);
  assert.equal(withPlatformDefaults(undefined), undefined);
  assert.equal(withPlatformDefaults('BUG-1'), 'BUG-1');
});
