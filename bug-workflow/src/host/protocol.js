/**
 * Bug workflow protocol constants (host half).
 *
 * This module is pure ESM with no runtime dependencies. P2+ adapters, the host
 * routes and the client board rely on these exact values; add new constants but
 * do not rename or reorder existing ones.
 */

/** Every workflow state, in lifecycle order. */
export const STATES = Object.freeze([
  'inbox',
  'analyzing',
  'plan_review',
  'fixing',
  'fix_done',
  'submitting',
  'mr_open',
  'fixing_review',
  'mergeable',
  'merged',
  'done',
  'blocked',
]);

/** State assigned to a freshly created ticket. */
export const INITIAL_STATE = 'inbox';

/** Terminal state: no action is valid from here. */
export const TERMINAL_STATE = 'done';

/** Maximum number of AI review "changes requested" rounds before human help. */
export const MAX_REVIEW_ROUNDS = 3;

/**
 * Actions understood by the host action route and the state machine.
 *
 * `create` is a route-level action handled by `initialTicket()`; it is kept in
 * this list so clients and validation share one source of truth.
 */
export const ACTIONS = Object.freeze([
  'create',
  'start_analysis',
  'analysis_done',
  'approve_plan',
  'reject_plan',
  'fix_done',
  'mark_test_passed',
  'submit_mr',
  'mr_created',
  'review_requests_changes',
  'review_fix_done',
  'review_pass',
  'mr_merged',
  'dismiss',
  'retry',
]);
