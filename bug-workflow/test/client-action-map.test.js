/**
 * Consistency test between the board's declarative action map and the real
 * host state machine.
 *
 * `bug-workflow/client.js` is a browser module wrapped in
 * `window.__ModuleLoader__`; it cannot be imported from Node. The action map is
 * therefore kept as a pure JSON-like literal between two marker comments, so
 * this test can extract and evaluate it verbatim (`vm.runInNewContext`) and
 * cross-check every entry against `canApply()` / `apply()` of the authoritative
 * state machine. Regression guarded here: `mr_created` used to be rendered for
 * `mr_open`, where the host rejects it (409), which made `mr_open`/`done`
 * unreachable from the UI.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { ACTIONS, STATES, TERMINAL_STATE, MAX_REVIEW_ROUNDS } from '../src/host/protocol.js';
import { apply, canApply, initialTicket } from '../src/host/state-machine.js';

const AT = '2026-11-07T00:00:00.000Z';
const CLIENT_URL = new URL('../client.js', import.meta.url);
const BEGIN_MARKER = '// <client-action-map>';
const END_MARKER = '// </client-action-map>';

const DEMO_PATH = Object.freeze([
  'start_analysis',
  'analysis_done',
  'approve_plan',
  'fix_done',
  'mark_test_passed',
  'submit_mr',
  'mr_created',
  'review_pass',
  'mr_merged',
  'dismiss',
]);

const DEMO_ISSUE_FIELDS = [
  'fid',
  'file',
  'level',
  'gateCategory',
  'location',
  'problem',
  'suggestion',
  'blocking',
];

function readClientSource() {
  return readFileSync(CLIENT_URL, 'utf8');
}

/**
 * Extract the literal between the marker comments and evaluate it in a fresh
 * context, proving it contains no references to runtime helpers or closures.
 */
function extractActionMap(source) {
  const begin = source.indexOf(BEGIN_MARKER);
  assert.notEqual(begin, -1, `client.js must contain the ${BEGIN_MARKER} marker`);
  const end = source.indexOf(END_MARKER, begin + BEGIN_MARKER.length);
  assert.notEqual(end, -1, `client.js must contain the ${END_MARKER} marker`);

  const block = source.slice(begin + BEGIN_MARKER.length, end);
  const match = /const ACTION_BY_STATE = ([\s\S]*?);\s*$/.exec(block);
  assert.ok(match, 'the marker block must declare `const ACTION_BY_STATE = <literal>;`');

  const value = runInNewContext(`(${match[1]})`);
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'ACTION_BY_STATE must be an object');
  return value;
}

function ticketAt(workflow, overrides = {}) {
  return {
    ...initialTicket({ code: 'BUG-001', title: '看板映射一致性' }, AT),
    workflow,
    ...overrides,
  };
}

function actionsOf(map, state) {
  return (map[state] ?? []).map((descriptor) => descriptor.action);
}

function assertPlainData(value, path) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return;
  assert.notEqual(type, 'function', `${path} must not contain a function/closure`);
  assert.equal(type, 'object', `${path} must be plain data (got ${type})`);
  assert.ok(Array.isArray(value) || Object.prototype.toString.call(value) === '[object Object]', `${path} must be an array or object literal`);
  for (const [key, child] of Object.entries(value)) {
    assertPlainData(child, `${path}.${key}`);
  }
}

const source = readClientSource();
const ACTION_BY_STATE = extractActionMap(source);

test('action map covers exactly the protocol states', () => {
  assert.deepEqual(Object.keys(ACTION_BY_STATE).sort(), [...STATES].sort());
  for (const state of STATES) {
    const descriptors = ACTION_BY_STATE[state];
    assert.ok(Array.isArray(descriptors), `${state} must map to an array`);
    for (const descriptor of descriptors) {
      assert.ok(descriptor !== null && typeof descriptor === 'object' && !Array.isArray(descriptor));
      assert.equal(typeof descriptor.action, 'string', `${state} descriptor action must be a string`);
      assert.ok(ACTIONS.includes(descriptor.action), `${state} maps unknown action ${descriptor.action}`);
      assert.equal(typeof descriptor.label, 'string', `${state}/${descriptor.action} label must be a string`);
      assert.notEqual(descriptor.label.trim(), '', `${state}/${descriptor.action} label must not be empty`);
      assert.equal(typeof descriptor.confirm, 'string', `${state}/${descriptor.action} confirm must be a string`);
      assert.ok(descriptor.input === undefined || typeof descriptor.input === 'string');
      assert.ok(descriptor.payload === undefined || (descriptor.payload !== null && typeof descriptor.payload === 'object'));
    }
  }
});

test('action map is plain literal data (no functions or closures)', () => {
  assertPlainData(ACTION_BY_STATE, 'ACTION_BY_STATE');
});

test('every mapped action passes the real state machine guard', () => {
  for (const state of STATES) {
    const ticket = ticketAt(state);
    for (const descriptor of ACTION_BY_STATE[state]) {
      const check = canApply(ticket, descriptor.action);
      assert.equal(
        check.ok,
        true,
        `${state} -> ${descriptor.action} is offered by the board but rejected by the host: ${check.code} ${check.message}`,
      );
    }
  }
});

test('mr_created is offered from submitting and not from mr_open', () => {
  const submitting = actionsOf(ACTION_BY_STATE, 'submitting');
  assert.ok(submitting.includes('submit_mr'), 'submitting must still offer submit_mr');
  assert.ok(submitting.includes('mr_created'), 'submitting must offer mr_created');
  assert.ok(!actionsOf(ACTION_BY_STATE, 'mr_open').includes('mr_created'), 'mr_open must not offer mr_created');
});

test('apply() from submitting with mr_created reaches mr_open', () => {
  const check = canApply(ticketAt('submitting'), 'mr_created');
  assert.equal(check.ok, true, `mr_created must be legal from submitting: ${check.code} ${check.message}`);
  const next = apply(ticketAt('submitting'), 'mr_created', {}, AT);
  assert.equal(next.workflow, 'mr_open');
});

test('the P1 demo path can reach done using only mapped actions', () => {
  let ticket = ticketAt('inbox');
  for (const action of DEMO_PATH) {
    assert.ok(
      actionsOf(ACTION_BY_STATE, ticket.workflow).includes(action),
      `workflow ${ticket.workflow} must offer ${action} to continue the demo path`,
    );
    ticket = apply(ticket, action, {}, AT);
  }
  assert.equal(ticket.workflow, TERMINAL_STATE);
});

test('review loop actions stay legal from their mapped states', () => {
  assert.ok(actionsOf(ACTION_BY_STATE, 'mr_open').includes('review_requests_changes'));
  const changes = apply(ticketAt('mr_open'), 'review_requests_changes', {}, AT);
  assert.equal(changes.workflow, 'fixing_review');
  assert.ok(actionsOf(ACTION_BY_STATE, 'fixing_review').includes('review_fix_done'));
  const back = apply(changes, 'review_fix_done', {}, AT);
  assert.equal(back.workflow, 'mr_open');
  assert.equal(canApply(ticketAt('mr_open', { mr: { rounds: MAX_REVIEW_ROUNDS } }), 'review_requests_changes').ok, false);
});

test('review_requests_changes demo payload carries the spec issue fields', () => {
  const descriptor = ACTION_BY_STATE.mr_open.find((entry) => entry.action === 'review_requests_changes');
  assert.ok(descriptor, 'mr_open must offer review_requests_changes');
  const issues = descriptor.payload?.blockingIssues;
  assert.ok(Array.isArray(issues), 'payload.blockingIssues must be an array');
  assert.equal(issues.length, 1, 'the P1 demo payload ships exactly one blocking issue');
  const issue = issues[0];
  assert.deepEqual(Object.keys(issue).sort(), [...DEMO_ISSUE_FIELDS].sort());
  assert.equal(issue.fid, 'demo-1');
  assert.equal(issue.file, 'src/demo.ts');
  assert.equal(issue.level, '中');
  assert.equal(issue.gateCategory, '逻辑错误');
  assert.equal(issue.location, 'src/demo.ts:1-2');
  assert.equal(issue.problem, 'P1 演示问题');
  assert.equal(issue.suggestion, '演示建议');
  assert.equal(issue.blocking, true);

  const applied = apply(ticketAt('mr_open'), 'review_requests_changes', descriptor.payload, AT);
  // JSON round-trip: values extracted from the vm context have foreign prototypes.
  assert.equal(JSON.stringify(applied.mr.blockingIssues), JSON.stringify(issues));
});

test('terminal state maps no actions and accepts none', () => {
  assert.equal(Array.isArray(ACTION_BY_STATE[TERMINAL_STATE]), true);
  assert.equal(ACTION_BY_STATE[TERMINAL_STATE].length, 0);
  for (const action of ACTIONS) {
    const check = canApply(ticketAt(TERMINAL_STATE), action);
    assert.equal(check.ok, false, `${action} must be rejected from ${TERMINAL_STATE}`);
  }
});

test('client source no longer uses window.prompt', () => {
  assert.ok(!source.includes('window.prompt'), 'reject_plan must use the inline reason input, not window.prompt');
});
