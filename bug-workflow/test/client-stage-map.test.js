/**
 * Contract test for the lane board's stage mapping.
 *
 * `bug-workflow/client.js` is a browser module wrapped in
 * `window.__ModuleLoader__`; it cannot be imported from Node. The lane
 * definition (`STAGE_LANES`) is therefore kept as a pure JSON-like literal
 * between marker comments so this test can extract and evaluate it verbatim
 * (`vm.runInNewContext`) and cross-check the presentation partition against the
 * authoritative host state list.
 *
 * The lane board is UI-only: it never fires transitions (cards are text-only,
 * the real buttons stay in the detail view / host action map). What must stay
 * true is that every non-terminal workflow state is visible in exactly one
 * lane, the terminal `done` state stays archived, and the lane order keeps the
 * human-decision lanes early and the blocking lane last (the responsive board
 * relies on that order).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { STATES, TERMINAL_STATE } from '../src/host/protocol.js';

const CLIENT_URL = new URL('../client.js', import.meta.url);
const LANES_BEGIN = '// <client-stage-map>';
const LANES_END = '// </client-stage-map>';

/** Lane tones the board's TONES palette defines. */
const TONES = Object.freeze(['neutral', 'info', 'warn', 'success', 'danger']);

/** Expected lane order (human decisions early, blocked last). */
const EXPECTED_ORDER = Object.freeze([
  'draft',
  'analyzing',
  'plan-review',
  'fixing',
  'fix-done',
  'delivery',
  'review',
  'mergeable',
  'blocked',
]);

function readLanes() {
  const source = readFileSync(CLIENT_URL, 'utf8');
  const begin = source.indexOf(LANES_BEGIN);
  const end = source.indexOf(LANES_END);
  assert.ok(begin >= 0, 'STAGE_LANES marker start is missing');
  assert.ok(end > begin, 'STAGE_LANES marker end is missing');
  const block = source.slice(begin + LANES_BEGIN.length, end);
  const declaration = block.indexOf('const STAGE_LANES');
  assert.ok(declaration >= 0, 'STAGE_LANES declaration is missing');
  const assignment = block.indexOf('=', declaration);
  assert.ok(assignment > declaration, 'STAGE_LANES assignment is missing');
  const literal = block.slice(assignment + 1).trim().replace(/;\s*$/, '');
  assert.ok(literal.startsWith('['), 'STAGE_LANES must be a pure array literal');
  const lanes = runInNewContext(`(${literal})`);
  assert.ok(Array.isArray(lanes), 'STAGE_LANES must evaluate to an array');
  return lanes;
}

test('STAGE_LANES is a well-formed literal with unique ids and known tones', () => {
  const lanes = readLanes();
  assert.ok(lanes.length >= 8, 'the flow needs the documented lanes');

  const ids = new Set();
  for (const lane of lanes) {
    assert.equal(typeof lane, 'object');
    assert.ok(lane !== null && !Array.isArray(lane));
    assert.match(lane.id, /^[a-z][a-z-]*$/, `invalid lane id: ${lane.id}`);
    assert.ok(!ids.has(lane.id), `duplicate lane id: ${lane.id}`);
    ids.add(lane.id);
    assert.equal(typeof lane.label, 'string');
    assert.ok(lane.label.trim() !== '', `lane ${lane.id} has no label`);
    assert.ok(TONES.includes(lane.tone), `lane ${lane.id} has unknown tone ${lane.tone}`);
    assert.equal(typeof lane.hint, 'string');
    assert.ok(lane.hint.trim() !== '', `lane ${lane.id} has no hint`);
    assert.ok(Array.isArray(lane.states), `lane ${lane.id} has no states array`);
    assert.ok(lane.states.length > 0, `lane ${lane.id} covers no state`);
    for (const state of lane.states) {
      assert.equal(typeof state, 'string');
    }
  }
});

test('STAGE_LANES covers every non-terminal host state exactly once', () => {
  const lanes = readLanes();
  const covered = new Map();
  for (const lane of lanes) {
    for (const state of lane.states) {
      assert.ok(!covered.has(state), `state ${state} appears in two lanes`);
      covered.set(state, lane.id);
    }
  }

  for (const state of STATES) {
    if (state === TERMINAL_STATE) {
      assert.ok(!covered.has(state), 'the terminal done state must stay archived off the board');
      continue;
    }
    assert.ok(covered.has(state), `host state ${state} is missing from the lane board`);
  }

  // The mapping is a partition, not a superset: no invented states.
  for (const state of covered.keys()) {
    assert.ok(STATES.includes(state), `lane covers unknown host state ${state}`);
  }
});

test('lane order keeps human decisions early and blocked last', () => {
  const lanes = readLanes();
  assert.deepEqual(Array.from(lanes, (lane) => lane.id), EXPECTED_ORDER);
  assert.equal(lanes[lanes.length - 1].id, 'blocked');
});

test('lane board keeps its responsive + step-bar source guards', () => {
  const source = readFileSync(CLIENT_URL, 'utf8');
  assert.ok(source.includes("'data-bug-board-lane': laneMode"), 'root must expose the lane mode for verification');
  assert.ok(source.includes('LANE_WIDE_MIN_WIDTH = 720'), 'wide/narrow breakpoint must stay declared');
  assert.ok(source.includes('function useElementWidth'), 'responsive width observer is required');
  assert.ok(source.includes('function LaneBoard'), 'lane board renderer is required');
  assert.ok(source.includes('function LaneCard'), 'lane card renderer is required');
  assert.ok(source.includes('function StageOverview'), 'lane overview chips are required');
  assert.ok(source.includes('function StageSteps'), 'detail flow progress is required');
  // The lane board is presentation only: cards and the detail step bar must not
  // introduce new write paths (all mutations still go through ActionBar /
  // executeAction with the host-guarded descriptors).
  const lanesSource = source.slice(
    source.indexOf('function StageOverview'),
    source.indexOf('function TicketRow'),
  );
  assert.ok(!/api\.(post|get)\(/.test(lanesSource), 'lane board must not issue requests');
  assert.ok(!/executeAction|requestAction/.test(lanesSource), 'lane board must not dispatch actions');
});

test('destructive actions use the in-board Popconfirm, never a native dialog', () => {
  const source = readFileSync(CLIENT_URL, 'utf8');
  assert.ok(source.includes('function ActionPopConfirm'), 'the anchored confirm bubble must exist');
  assert.ok(source.includes("'data-bug-popconfirm'"), 'the bubble must expose a verification marker');
  assert.ok(source.includes('anchorRectFromEvent'), 'the bubble must anchor to the clicked button');
  // Regression: the delivery button forgot to forward its click event, so the
  // bubble fell back to the viewport corner instead of the button.
  assert.ok(
    source.includes('onAction(DELIVER_DESCRIPTOR, event)'),
    'every confirm action must forward the click event to the anchor',
  );
  assert.ok(
    source.includes('function anchorRectFromRequest'),
    'the bubble must re-measure the stored anchor when it renders',
  );
  assert.ok(
    source.includes('const flipAbove ='),
    'the bubble must flip above a trigger that sits near the viewport bottom',
  );
  // Native platform dialogs look foreign in the embedded board: no call sites.
  assert.equal(/window\.confirm\s*\(/.test(source), false, 'window.confirm() must not be called');
  assert.equal(/function confirmDialog\s*\(/.test(source), false, 'the native confirm wrapper must be gone');
  // Confirm flows still run through the single host-guarded action path.
  assert.ok(source.includes('confirmPendingAction'));
  assert.ok(source.includes('executeAction(request.descriptor, request.ticket, reason)'));
});
