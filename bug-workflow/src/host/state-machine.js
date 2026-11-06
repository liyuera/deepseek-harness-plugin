/**
 * Pure ticket state machine for the Bug workflow plugin.
 *
 * No I/O, no timers, no dependencies: callers pass a ticket, an action and an
 * optional payload/timestamp and receive a new ticket. Host routes and the
 * future platform/GitLab/subagent adapters rely on this module.
 *
 * Ticket shape (persisted; fields may be added but existing semantics must not
 * change), see the P1 plan "接口与数据契约":
 *   { code, title, type, status, version, priority, assignee, url,
 *     workflow, plan, branch, mr, fixes, timeline, createdAt, updatedAt }
 *
 * Payloads used by this module:
 *   analysis_done:            { plan?: Plan, message?, actor? }
 *   reject_plan:              { reason?, rejectedReason?, message?, actor? }
 *   mr_created:               { mr?: MRRecord, message?, actor? }
 *   review_requests_changes:  { blockingIssues?: ReviewIssue[], nonBlockingIssues?: ReviewIssue[], ... }
 *   every action:             { message?: string, actor?: 'user'|'agent'|'system' }
 */

import {
  ACTIONS,
  INITIAL_STATE,
  MAX_REVIEW_ROUNDS,
  STATES,
} from './protocol.js';

export { ACTIONS, MAX_REVIEW_ROUNDS, STATES };

const TIMELINE_ACTORS = Object.freeze(['user', 'agent', 'system']);

/**
 * Transition table. `to: null` means the target is computed by the reducer
 * (only `retry`: back to plan_review when a plan exists, otherwise inbox).
 */
const TRANSITIONS = Object.freeze({
  start_analysis: { from: ['inbox'], to: 'analyzing', actor: 'user' },
  analysis_done: { from: ['analyzing'], to: 'plan_review', actor: 'agent' },
  approve_plan: { from: ['plan_review'], to: 'fixing', actor: 'user' },
  reject_plan: { from: ['plan_review'], to: 'blocked', actor: 'user' },
  fix_done: { from: ['fixing'], to: 'fix_done', actor: 'agent' },
  mark_test_passed: { from: ['fix_done'], to: 'submitting', actor: 'user' },
  // submit_mr records the submit intent; mr_created confirms the MR exists and
  // is the only action that moves the ticket to mr_open.
  submit_mr: { from: ['submitting'], to: 'submitting', actor: 'user' },
  mr_created: { from: ['submitting'], to: 'mr_open', actor: 'system' },
  review_requests_changes: { from: ['mr_open'], to: 'fixing_review', actor: 'system' },
  review_fix_done: { from: ['fixing_review'], to: 'mr_open', actor: 'system' },
  review_pass: { from: ['mr_open'], to: 'mergeable', actor: 'system' },
  mr_merged: { from: ['mergeable'], to: 'merged', actor: 'system' },
  dismiss: { from: ['merged'], to: 'done', actor: 'user' },
  retry: { from: ['blocked'], to: null, actor: 'user' },
});

const ACTION_MESSAGES = Object.freeze({
  start_analysis: '开始分析工单',
  analysis_done: '分析完成，方案待审核',
  approve_plan: '方案已通过，开始修复',
  reject_plan: '方案已驳回',
  fix_done: '修复完成，等待人工测试',
  mark_test_passed: '人工测试通过，准备提交 MR',
  submit_mr: '已发起 MR 提交',
  mr_created: 'MR 已创建',
  review_fix_done: 'review 问题修复完成，已重新提交',
  review_pass: 'AI review 通过，可合并',
  mr_merged: 'MR 已合并',
  dismiss: '已归档，工单完成',
  retry: '解除阻塞，继续流程',
});

/**
 * Error thrown by apply() for a transition the state machine refuses.
 * `code` is one of 'invalid-action' | 'invalid-transition' |
 * 'review-rounds-exhausted' (callers should surface `message`).
 */
export class StateError extends Error {
  constructor(optionsOrCode, message) {
    const options = isPlainObject(optionsOrCode)
      ? optionsOrCode
      : { code: optionsOrCode, message };
    super(options.message ?? '工单状态机错误');
    this.name = 'StateError';
    this.code = options.code ?? 'state-error';
  }
}

/**
 * Build a fresh inbox ticket.
 *
 * @param {object} [input] platform issue fields
 * @param {string} [at] ISO timestamp (tests pass a fixed clock)
 * @returns {object} new Ticket
 */
export function initialTicket(input = {}, at = nowIso()) {
  const source = isPlainObject(input) ? input : {};
  return {
    code: source.code ?? null,
    title: source.title ?? null,
    type: source.type ?? null,
    status: source.status ?? null,
    version: source.version ?? null,
    priority: source.priority ?? null,
    assignee: source.assignee ?? null,
    url: source.url ?? null,
    workflow: INITIAL_STATE,
    plan: null,
    branch: null,
    mr: null,
    fixes: [],
    timeline: [
      {
        at,
        kind: 'created',
        actor: 'system',
        message: '工单已创建',
      },
    ],
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Check whether `action` is allowed for `ticket` without throwing.
 *
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 */
export function canApply(ticket, action) {
  if (!ACTIONS.includes(action)) {
    return {
      ok: false,
      code: 'invalid-action',
      message: `未知动作：${String(action)}`,
    };
  }

  const transition = TRANSITIONS[action];
  if (!transition) {
    return {
      ok: false,
      code: 'invalid-transition',
      message: `动作 ${action} 不适用于已有工单（新建工单请使用 initialTicket）`,
    };
  }

  const workflow = ticket?.workflow;
  if (!transition.from.includes(workflow)) {
    return {
      ok: false,
      code: 'invalid-transition',
      message: `工单状态 ${String(workflow)} 不能执行 ${action}`,
    };
  }

  if (action === 'review_requests_changes') {
    const rounds = ticket?.mr?.rounds ?? 0;
    if (rounds >= MAX_REVIEW_ROUNDS) {
      return {
        ok: false,
        code: 'review-rounds-exhausted',
        message: `Review 已进行 ${rounds} 轮，达到上限 ${MAX_REVIEW_ROUNDS} 轮，需人工介入`,
      };
    }
  }

  return { ok: true };
}

/**
 * Apply one action and return the next ticket.
 *
 * Input is never mutated. Each successful call appends exactly one timeline
 * event. Illegal transitions throw StateError.
 *
 * @param {object} ticket current Ticket
 * @param {string} action one of ACTIONS
 * @param {object} [payload] action-specific data (see module comment)
 * @param {string} [at] ISO timestamp
 * @returns {object} new Ticket
 */
export function apply(ticket, action, payload = {}, at = nowIso()) {
  const check = canApply(ticket, action);
  if (!check.ok) throw new StateError(check);

  const transition = TRANSITIONS[action];
  const data = isPlainObject(payload) ? payload : {};
  const next = structuredClone(ticket);

  next.workflow = action === 'retry'
    ? (next.plan ? 'plan_review' : 'inbox')
    : transition.to;

  applyEffects(next, action, data, at);

  next.updatedAt = at;
  next.timeline = [
    ...(Array.isArray(next.timeline) ? next.timeline : []),
    {
      at,
      kind: action,
      actor: resolveActor(data.actor, transition.actor),
      message: resolveMessage(action, next, data),
    },
  ];

  return next;
}

function applyEffects(ticket, action, payload, at) {
  switch (action) {
    case 'analysis_done': {
      if (isPlainObject(payload.plan)) {
        const plan = structuredClone(payload.plan);
        ticket.plan = {
          ...createEmptyPlan(),
          ...plan,
          generatedAt: plan.generatedAt ?? at,
          approvedAt: null,
          rejectedReason: null,
        };
      }
      return;
    }

    case 'approve_plan': {
      ticket.plan = {
        ...currentPlan(ticket),
        approvedAt: at,
        rejectedReason: null,
      };
      return;
    }

    case 'reject_plan': {
      ticket.plan = {
        ...currentPlan(ticket),
        rejectedReason: resolveRejectionReason(payload),
      };
      return;
    }

    case 'mr_created': {
      const previous = currentMr(ticket);
      const incoming = isPlainObject(payload.mr) ? structuredClone(payload.mr) : {};
      ticket.mr = {
        ...previous,
        ...incoming,
        state: incoming.state ?? previous.state ?? 'open',
        rounds: incoming.rounds ?? previous.rounds ?? 0,
      };
      return;
    }

    case 'review_requests_changes': {
      const mr = currentMr(ticket);
      ticket.mr = {
        ...mr,
        rounds: (mr.rounds ?? 0) + 1,
        verdict: 'changes',
        state: mr.state ?? 'open',
        blockingIssues: Array.isArray(payload.blockingIssues)
          ? structuredClone(payload.blockingIssues)
          : mr.blockingIssues,
        nonBlockingIssues: Array.isArray(payload.nonBlockingIssues)
          ? structuredClone(payload.nonBlockingIssues)
          : mr.nonBlockingIssues,
      };
      return;
    }

    case 'review_pass': {
      ticket.mr = {
        ...currentMr(ticket),
        verdict: 'pass',
        blockingIssues: [],
      };
      return;
    }

    case 'mr_merged': {
      ticket.mr = {
        ...currentMr(ticket),
        state: 'merged',
      };
      return;
    }

    default:
      return;
  }
}

function createEmptyPlan() {
  return {
    summary: '',
    rootCause: '',
    approach: '',
    changedFiles: [],
    risks: [],
    testPlan: '',
    generatedAt: null,
    approvedAt: null,
    rejectedReason: null,
  };
}

function createEmptyMr() {
  return {
    iid: null,
    url: null,
    sourceBranch: null,
    targetBranch: null,
    state: null,
    verdict: null,
    blockingIssues: [],
    nonBlockingIssues: [],
    rounds: 0,
  };
}

function currentPlan(ticket) {
  return {
    ...createEmptyPlan(),
    ...(isPlainObject(ticket.plan) ? structuredClone(ticket.plan) : {}),
  };
}

function currentMr(ticket) {
  return {
    ...createEmptyMr(),
    ...(isPlainObject(ticket.mr) ? structuredClone(ticket.mr) : {}),
  };
}

function resolveRejectionReason(payload) {
  const raw = payload.reason ?? payload.rejectedReason ?? payload.message;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function resolveActor(actor, fallback) {
  return TIMELINE_ACTORS.includes(actor) ? actor : fallback;
}

function resolveMessage(action, ticket, payload) {
  const custom = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (custom) return custom;

  if (action === 'review_requests_changes') {
    return `AI review 要求修改（第 ${ticket.mr?.rounds ?? 0} 轮）`;
  }
  if (action === 'reject_plan') {
    const reason = ticket.plan?.rejectedReason;
    return reason ? `方案已驳回：${reason}` : ACTION_MESSAGES.reject_plan;
  }

  return ACTION_MESSAGES[action] ?? action;
}

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
