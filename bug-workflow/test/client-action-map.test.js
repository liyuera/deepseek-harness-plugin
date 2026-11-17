/**
 * Contract test between the board's declarative action map + availability rule
 * and the real host state machine.
 *
 * `bug-workflow/client.js` is a browser module wrapped in
 * `window.__ModuleLoader__`; it cannot be imported from Node. The action map
 * and the rounds-availability rule are therefore kept as pure literals between
 * marker comments, so this test can extract and evaluate them verbatim
 * (`vm.runInNewContext`) and cross-check every entry against `canApply()` /
 * `apply()` of the authoritative state machine.
 *
 * Guards added after the P1 whole-branch review:
 *   1. `analyzing.analysis_done` must ship a real demo `plan` payload, and the
 *      demo chain must apply each descriptor's payload (not `{}`), so
 *      `approve_plan` keeps a non-empty plan instead of an empty object.
 *   2. The exact action set per workflow state is hardcoded one-way AND
 *      backwards (host -> board is not asserted per state because the board
 *      intentionally omits `block`, documented P1 omission).
 *
 * The P5 GitLab delivery flow is retired: the board no longer renders a
 * delivery descriptor, GitLab settings/token card, MR/Review panels or the
 * demo write-back actions (`submit_mr`, `mr_created`, `review_*`, `mr_merged`,
 * `dismiss`). The host state machine still accepts those transitions for
 * legacy records (covered below); this test asserts the retired UI is gone and
 * that the remaining literal still passes the host guard for every mapped
 * action.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { ACTIONS, STATES, TERMINAL_STATE, MAX_REVIEW_ROUNDS } from '../src/host/protocol.js';
import { apply, canApply, initialTicket } from '../src/host/state-machine.js';

const AT = '2026-11-07T00:00:00.000Z';
const CLIENT_URL = new URL('../client.js', import.meta.url);
const MAP_BEGIN = '// <client-action-map>';
const MAP_END = '// </client-action-map>';
const AVAILABILITY_BEGIN = '// <client-action-availability>';
const AVAILABILITY_END = '// </client-action-availability>';

/**
 * Exact P1 board mapping per workflow state. `block` is intentionally absent:
 * the board has no `block` button (documented P1 omission), so this list is the
 * one-way board contract, not a mirror of every host-legal action.
 */
const EXPECTED_ACTIONS = Object.freeze({
  inbox: ['start_analysis'],
  analyzing: ['analysis_done'],
  plan_review: ['approve_plan', 'reject_plan'],
  fixing: ['fix_done'],
  // P7: the test step is service-owned (merge to the dev branch / revert /
  // pass + cleanup) and rendered by TestNotice, never a state-machine button.
  fix_done: [],
  // P5: the delivery/review flow is service-owned. The board renders the real
  // 「提交并创建 MR」 descriptor (board-only, routed to /api/deliver) and the
  // review/merge banners instead of demo write-back buttons.
  submitting: [],
  mr_open: [],
  fixing_review: [],
  mergeable: [],
  merged: [],
  done: [],
  blocked: ['retry'],
});

/** P5 demo write-back actions the board must never render again. */
const REMOVED_P5_ACTIONS = Object.freeze([
  'submit_mr',
  'mr_created',
  'review_requests_changes',
  'review_pass',
  'review_fix_done',
  'mr_merged',
  'dismiss',
]);

const DEMO_PATH = Object.freeze([
  'start_analysis',
  'analysis_done',
  'approve_plan',
  'fix_done',
]);

/** Fields of `planSchema` in `src/host/domain.js`, in declaration order. */
const DEMO_PLAN_FIELDS = [
  'summary',
  'rootCause',
  'approach',
  'changedFiles',
  'risks',
  'testPlan',
  'generatedAt',
  'approvedAt',
  'rejectedReason',
];

function readClientSource() {
  return readFileSync(CLIENT_URL, 'utf8');
}

/** Read the source between two marker comments and fail loudly when missing. */
function readMarkedBlock(source, beginMarker, endMarker) {
  const begin = source.indexOf(beginMarker);
  assert.notEqual(begin, -1, `client.js must contain the ${beginMarker} marker`);
  const end = source.indexOf(endMarker, begin + beginMarker.length);
  assert.notEqual(end, -1, `client.js must contain the ${endMarker} marker`);
  return source.slice(begin + beginMarker.length, end);
}

/**
 * Extract `const <name> = <literal>;` from a marker block and evaluate it in a
 * fresh context, proving it contains no references to runtime helpers or
 * closures. Works for both the action-map object and the availability arrow
 * function (the non-greedy capture is anchored to the final trailing `;`).
 */
function extractDeclaration(source, beginMarker, endMarker, name) {
  const block = readMarkedBlock(source, beginMarker, endMarker);
  const match = new RegExp(`const ${name} = ([\\s\\S]*?);\\s*$`).exec(block);
  assert.ok(match, `the marker block must declare \`const ${name} = <literal>;\``);
  return runInNewContext(`(${match[1]})`);
}

function ticketAt(workflow, overrides = {}) {
  return {
    ...initialTicket({ code: 'BUG-001', title: '看板映射一致性' }, AT),
    workflow,
    ...overrides,
  };
}

/**
 * Actions offered for one state. `Array.from` copies the vm-realm array into
 * this realm: `assert.deepEqual` compares prototypes, and cross-realm arrays do
 * not share one.
 */
function actionsOf(map, state) {
  return Array.from((map[state] ?? []).map((descriptor) => descriptor.action));
}

function descriptorOf(map, state, action) {
  return (map[state] ?? []).find((descriptor) => descriptor.action === action) ?? null;
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
const ACTION_BY_STATE = extractDeclaration(source, MAP_BEGIN, MAP_END, 'ACTION_BY_STATE');
const actionUnavailableHint = extractDeclaration(
  source,
  AVAILABILITY_BEGIN,
  AVAILABILITY_END,
  'actionUnavailableHint',
);

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
      assert.ok(
        descriptor.maxRounds === undefined
          || (typeof descriptor.maxRounds === 'number' && Number.isInteger(descriptor.maxRounds) && descriptor.maxRounds > 0),
        `${state}/${descriptor.action} maxRounds must be a positive integer when present`,
      );
    }
  }
});

test('action map is plain literal data (no functions or closures)', () => {
  assertPlainData(ACTION_BY_STATE, 'ACTION_BY_STATE');
  assert.equal(typeof actionUnavailableHint, 'function', 'the availability rule must extract to a pure function');
});

test('every workflow state offers exactly the expected P1 action set', () => {
  assert.deepEqual(Object.keys(EXPECTED_ACTIONS).sort(), [...STATES].sort(), 'expected sets must cover every state');
  for (const state of STATES) {
    assert.deepEqual(
      actionsOf(ACTION_BY_STATE, state),
      EXPECTED_ACTIONS[state],
      `${state} action set changed; the P1 board contract is one-way and must stay exact`,
    );
  }

  assert.deepEqual(actionsOf(ACTION_BY_STATE, TERMINAL_STATE), [], `${TERMINAL_STATE} must offer no action`);
  assert.deepEqual(actionsOf(ACTION_BY_STATE, 'blocked'), ['retry'], 'blocked must only offer retry');
  const offeredActions = STATES.flatMap((state) => actionsOf(ACTION_BY_STATE, state));
  assert.ok(!offeredActions.includes('block'), 'the P1 board intentionally has no block button');
  assert.ok(ACTIONS.includes('block'), 'the host still supports block; the omission is board-only');
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

test('the P5 demo write-back actions are absent from the board map', () => {
  const offeredActions = STATES.flatMap((state) => actionsOf(ACTION_BY_STATE, state));
  for (const action of REMOVED_P5_ACTIONS) {
    assert.ok(!offeredActions.includes(action), `${action} must not be rendered by the board any more`);
    // The removal is board-only: the host state machine still owns these
    // transitions for its services and for legacy clients.
    assert.ok(ACTIONS.includes(action), `${action} must stay a host action`);
  }
});

test('analyzing.analysis_done ships a demo plan payload matching the host plan schema', () => {
  const descriptor = descriptorOf(ACTION_BY_STATE, 'analyzing', 'analysis_done');
  assert.ok(descriptor, 'analyzing must offer analysis_done');
  const plan = descriptor.payload?.plan;
  assert.ok(plan !== null && typeof plan === 'object' && !Array.isArray(plan), 'analysis_done payload.plan must be an object');
  assert.deepEqual(
    [...Object.keys(plan)].sort(),
    [...DEMO_PLAN_FIELDS].sort(),
    'the demo plan must carry exactly the host plan schema fields',
  );

  for (const field of ['summary', 'rootCause', 'approach', 'testPlan']) {
    assert.equal(typeof plan[field], 'string', `plan.${field} must be a string`);
    assert.notEqual(plan[field].trim(), '', `plan.${field} must not be empty`);
  }
  for (const field of ['changedFiles', 'risks']) {
    assert.ok(Array.isArray(plan[field]), `plan.${field} must be an array`);
    assert.ok(plan[field].length > 0, `plan.${field} must not be empty`);
    for (const item of plan[field]) assert.equal(typeof item, 'string', `plan.${field} entries must be strings`);
  }
  assert.equal(plan.generatedAt, '2026-11-07T00:00:00.000Z', 'the demo plan must use a static generatedAt');
  assert.equal(plan.approvedAt, null);
  assert.equal(plan.rejectedReason, null);
});

test('the remaining demo path applies each descriptor payload and reaches fix_done with the real plan', () => {
  const demoDescriptor = descriptorOf(ACTION_BY_STATE, 'analyzing', 'analysis_done');
  const demoPlan = demoDescriptor.payload.plan;

  let ticket = ticketAt('inbox');
  let planBeforeApprove = null;
  let planAfterApprove = null;

  for (const action of DEMO_PATH) {
    const descriptor = descriptorOf(ACTION_BY_STATE, ticket.workflow, action);
    assert.ok(descriptor, `workflow ${ticket.workflow} must offer ${action} to continue the demo path`);
    const check = canApply(ticket, action);
    assert.equal(check.ok, true, `${ticket.workflow} -> ${action} must be legal: ${check.code} ${check.message}`);

    // Apply the descriptor's real payload (never `{}`): the original one-way
    // test masked that `analysis_done` carried no plan.
    ticket = apply(ticket, action, descriptor.payload === undefined ? {} : descriptor.payload, AT);

    if (action === 'analysis_done') {
      assert.equal(ticket.workflow, 'plan_review');
      planBeforeApprove = ticket.plan;
    }
    if (action === 'approve_plan') planAfterApprove = ticket.plan;
  }

  // P7 moved the test step into the host: the demo chain stops at fix_done and
  // 「开始测试」/「测试通过」 are service routes, not demo write-back buttons.
  assert.equal(ticket.workflow, 'fix_done', 'the demo chain must stop at fix_done (test step is service-owned)');
  assert.deepEqual(actionsOf(ACTION_BY_STATE, 'submitting'), [], 'submitting renders no demo write-back button');

  assert.ok(planBeforeApprove !== null, 'analysis_done must create a plan on the ticket');
  assert.equal(planBeforeApprove.summary, demoPlan.summary, 'analysis_done must persist the demo plan summary');
  assert.deepEqual(
    [...planBeforeApprove.changedFiles],
    [...demoPlan.changedFiles],
    'analysis_done must persist the demo changedFiles',
  );

  assert.ok(planAfterApprove !== null, 'approve_plan must keep a plan, not an empty object');
  assert.deepEqual(
    [...Object.keys(planAfterApprove)].sort(),
    [...DEMO_PLAN_FIELDS].sort(),
    'the approved plan must keep the full host plan schema',
  );
  assert.equal(planAfterApprove.summary, demoPlan.summary, 'approve_plan must not replace the demo summary with an empty value');
  assert.equal(planAfterApprove.rootCause, demoPlan.rootCause);
  assert.equal(planAfterApprove.approach, demoPlan.approach);
  assert.equal(planAfterApprove.testPlan, demoPlan.testPlan);
  assert.deepEqual([...planAfterApprove.changedFiles], [...demoPlan.changedFiles]);
  assert.deepEqual([...planAfterApprove.risks], [...demoPlan.risks]);
  assert.equal(planAfterApprove.generatedAt, demoPlan.generatedAt);
  assert.equal(planAfterApprove.approvedAt, AT, 'approve_plan must stamp approvedAt');
  assert.equal(planAfterApprove.rejectedReason, null);
});

test('the host still owns the review loop the board no longer drives', () => {
  // Board-only removal, full host support: the review service writes these.
  const changes = apply(ticketAt('mr_open'), 'review_requests_changes', {}, AT);
  assert.equal(changes.workflow, 'fixing_review');
  const back = apply(changes, 'review_fix_done', {}, AT);
  assert.equal(back.workflow, 'mr_open');
  assert.equal(canApply(ticketAt('mr_open', { mr: { rounds: MAX_REVIEW_ROUNDS } }), 'review_requests_changes').ok, false);
  const passing = apply(ticketAt('mr_open'), 'review_pass', {}, AT);
  assert.equal(passing.workflow, 'mergeable');
  assert.equal(apply(passing, 'mr_merged', {}, AT).workflow, 'merged');
});

test('the availability rule still disables a declared rounds cap', () => {
  assert.equal(typeof actionUnavailableHint, 'function');

  // The P5 board map no longer carries a maxRounds descriptor (the demo
  // review_requests_changes button is gone), but the shared rule stays the
  // contract for any future capped descriptor and is still used by ActionBar.
  const descriptor = { action: 'review_requests_changes', maxRounds: MAX_REVIEW_ROUNDS };
  assert.equal(actionUnavailableHint(descriptor, ticketAt('mr_open')), null, 'a ticket without mr metadata stays available');

  const belowCap = ticketAt('mr_open', { mr: { rounds: MAX_REVIEW_ROUNDS - 1 } });
  assert.equal(actionUnavailableHint(descriptor, belowCap), null, 'below the cap the button stays available');

  const atCap = ticketAt('mr_open', { mr: { rounds: MAX_REVIEW_ROUNDS } });
  assert.equal(
    actionUnavailableHint(descriptor, atCap),
    'Review 修复轮次已耗尽（3/3），请人工处理',
    'at the cap the board must show the exhausted hint',
  );
  const hostCheck = canApply(atCap, 'review_requests_changes');
  assert.equal(hostCheck.ok, false, 'the host still rejects the capped action');
  assert.equal(hostCheck.code, 'review-rounds-exhausted');

  // Only descriptors that declare maxRounds are affected.
  assert.equal(actionUnavailableHint({ action: 'other' }, atCap), null);
});

test('ActionBar applies the availability rule and renders the exhausted hint', () => {
  const start = source.indexOf('function ActionBar(');
  const end = source.indexOf('function TicketRow(', start);
  assert.notEqual(start, -1, 'client.js must declare ActionBar');
  assert.ok(end > start, 'ActionBar must be declared before TicketRow');
  const body = source.slice(start, end);
  assert.ok(body.includes('actionUnavailableHint(descriptor, ticket)'), 'ActionBar must evaluate the rule per descriptor');
  assert.ok(body.includes('disabled: itemDisabled'), 'an unavailable action must render a disabled button');
  assert.ok(body.includes('hints.push'), 'an unavailable action must render a visible hint');
  assert.ok(body.includes("role: 'note'"), 'the hint must be exposed to assistive technology');
});

test('the board no longer exposes the retired P5 GitLab delivery flow', () => {
  // The delivery chain (GitLab settings/token, the submit button, MR/Review
  // panels and the 60 s poller) is retired. The modules and host state machine
  // stay (see the review-loop test above); only the board interface is gone.
  for (const retired of [
    "deliver: '/bug-workflow/api/deliver'",
    "gitlabToken: '/bug-workflow/api/gitlab-token'",
    'action: \'start_deliver\'',
    '提交并创建 MR',
    'function DeliveryNotice',
    'function ReviewNotice',
    'function GitlabConnectionSection',
    'h(GitlabConnectionSection',
    'GitLab 连接',
    "key: 'gitlabProjectPath'",
    "key: 'gitlabReviewer'",
    "key: 'lintCommand'",
    "key: 'testCommand'",
    "key: 'devCommand'",
    "key: 'previewUrl'",
    'DELIVER_DESCRIPTOR',
    'deliverErrorView',
    'GITLAB_TOKEN_UI',
  ]) {
    assert.equal(source.includes(retired), false, `client.js must no longer expose: ${retired}`);
  }

  // The retained host flow must still be reachable from the board: the manual
  // test pass and the always-available termination are the exit paths.
  assert.ok(source.includes('function TestNotice'), 'the manual test panel must stay');
  assert.ok(source.includes("action: 'test_pass'"), 'the test-pass route must stay');
  assert.ok(source.includes('function TerminateNotice'), 'manual termination must stay');
});

test('retired-flow legacy copy and the single platform token gate stay intact', () => {
  // A legacy ticket blocked by the retired delivery/Review flow keeps mapped
  // copy (never a raw reason code), and the delivery detail stays readable.
  const blockedStart = source.indexOf('function BlockedNotice(');
  const blockedEnd = source.indexOf('function AnalysisNotice(', blockedStart);
  assert.ok(blockedStart !== -1 && blockedEnd > blockedStart, 'client.js must declare BlockedNotice before AnalysisNotice');
  const blockedBody = source.slice(blockedStart, blockedEnd);
  assert.ok(blockedBody.includes('isDeliveryBlock(ticket)'), 'the delivery detail is only read for a delivery block');
  assert.ok(
    blockedBody.includes('deliveryErrorFor(snapshot, ticket.code)'),
    'the legacy delivery block must read snapshot.delivery.errors through the helper',
  );
  assert.ok(blockedBody.includes('`宿主记录：${clip(deliveryDetail, 300)}`'), 'the detail must be clipped and labelled 宿主记录');
  assert.equal(blockedBody.includes('fixErrorFor('), false, 'a delivery block must never read snapshot.fix.errors');
  assert.ok(source.includes('h(BlockedNotice, { ticket, snapshot })'), 'TicketDetail must pass the snapshot to BlockedNotice');
  assert.ok(source.includes('function deliveryReasonLabel('), 'delivery reason copy must stay total');
  assert.ok(source.includes('function reviewReasonLabel('), 'review reason copy must stay total');

  // Only the platform token card remains: the retired GitLab card cannot leave
  // a dangling cross-card gate behind.
  assert.equal(source.includes('otherTokenBusy'), false, 'the cross-card busy gate must be gone');
  assert.ok(source.includes("scope: 'platform'"), 'the platform token card must stay');
  assert.equal(source.includes("scope: 'gitlab'"), false, 'the GitLab token card must be gone');
  assert.ok(source.includes('const tokenMutationBusy = tokenBusy === true;'));
  assert.ok(source.includes('const settingsSaveDisabled = saving === true || tokenMutationBusy || !canSave;'));
  assert.ok(source.includes('title: settingsSaveTitle'), 'the settings save button must carry the busy hint');
  assert.ok(
    source.includes("const TOKEN_MUTATION_BUSY_HINT = '正在保存 token，请稍候';"),
    'the token mutation hint copy must stay stable',
  );
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
