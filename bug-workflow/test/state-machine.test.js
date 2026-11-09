import test from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS, STATES } from '../src/host/protocol.js';
import {
  apply,
  canApply,
  initialTicket,
  StateError,
} from '../src/host/state-machine.js';

const AT = '2026-11-07T00:00:00.000Z';

const EXPECTED_STATES = [
  'inbox', 'analyzing', 'plan_review', 'fixing', 'fix_done', 'submitting',
  'mr_open', 'fixing_review', 'mergeable', 'merged', 'done', 'blocked',
];

const EXPECTED_ACTIONS = [
  'create', 'start_analysis', 'analysis_done', 'approve_plan', 'reject_plan',
  'fix_done', 'mark_test_passed', 'reopen_fix', 'submit_mr', 'mr_created',
  'review_requests_changes', 'review_fix_done', 'review_pass', 'mr_merged',
  'dismiss', 'retry', 'block',
];

const PLAN = {
  summary: '修复登录页白屏',
  rootCause: '用户信息未判空',
  approach: '增加空值保护并补测试',
  changedFiles: ['src/login/UserCard.jsx'],
  risks: ['低：只影响空用户分支'],
  testPlan: '单元测试覆盖空用户',
};

function inbox(overrides = {}) {
  return {
    ...initialTicket({ code: 'BUG-001', title: '登录页白屏' }, AT),
    ...overrides,
  };
}

function ticketAt(workflow, overrides = {}) {
  return inbox({ workflow, ...overrides });
}

function mrOpen(rounds = 0) {
  return ticketAt('mr_open', {
    mr: {
      iid: 17,
      url: 'https://gitlab.example.com/group/app/-/merge_requests/17',
      sourceBranch: 'feat-BUG-001-ly',
      targetBranch: 'develop',
      state: 'open',
      verdict: null,
      blockingIssues: [],
      nonBlockingIssues: [],
      rounds,
    },
  });
}

test('STATES 与 ACTIONS 保持接口契约中的顺序和取值', () => {
  assert.deepEqual([...STATES], EXPECTED_STATES);
  assert.deepEqual([...ACTIONS], EXPECTED_ACTIONS);
});

test('initialTicket() 生成 inbox 工单，timeline 只有一条 created', () => {
  const ticket = initialTicket({
    code: 'BUG-001',
    title: '登录页白屏',
    type: '缺陷',
    status: '待办',
    version: 'V1.2.0',
    priority: '高',
    assignee: '张三',
    url: 'https://example.com/BUG-001',
  }, AT);

  assert.equal(ticket.workflow, 'inbox');
  assert.equal(ticket.code, 'BUG-001');
  assert.equal(ticket.title, '登录页白屏');
  assert.equal(ticket.type, '缺陷');
  assert.equal(ticket.status, '待办');
  assert.equal(ticket.version, 'V1.2.0');
  assert.equal(ticket.priority, '高');
  assert.equal(ticket.assignee, '张三');
  assert.equal(ticket.url, 'https://example.com/BUG-001');
  assert.equal(ticket.blockedFrom, null);
  assert.equal(ticket.blockedReason, null);
  assert.equal(ticket.plan, null);
  assert.equal(ticket.branch, null);
  assert.equal(ticket.mr, null);
  assert.deepEqual(ticket.fixes, []);
  assert.equal(ticket.createdAt, AT);
  assert.equal(ticket.updatedAt, AT);
  assert.equal(ticket.timeline.length, 1);
  assert.equal(ticket.timeline[0].at, AT);
  assert.equal(ticket.timeline[0].kind, 'created');
  assert.equal(typeof ticket.timeline[0].message, 'string');
  assert.ok(['user', 'agent', 'system'].includes(ticket.timeline[0].actor));
});

test('合法链从 inbox 一路走到 done，每一步只追加一条 timeline 事件', () => {
  const steps = [
    ['start_analysis', {}, 'analyzing'],
    ['analysis_done', { plan: PLAN }, 'plan_review'],
    ['approve_plan', {}, 'fixing'],
    ['fix_done', {}, 'fix_done'],
    ['mark_test_passed', {}, 'submitting'],
    ['submit_mr', {}, 'submitting'],
    ['mr_created', {
      mr: {
        iid: 17,
        url: 'https://gitlab.example.com/group/app/-/merge_requests/17',
        sourceBranch: 'feat-BUG-001-ly',
        targetBranch: 'develop',
      },
    }, 'mr_open'],
    ['review_requests_changes', {}, 'fixing_review'],
    ['review_fix_done', {}, 'mr_open'],
    ['review_pass', {}, 'mergeable'],
    ['mr_merged', {}, 'merged'],
    ['dismiss', {}, 'done'],
  ];

  let ticket = inbox();
  let expectedTimelineLength = 1;
  for (const [action, payload, expectedWorkflow] of steps) {
    assert.deepEqual(
      canApply(ticket, action),
      { ok: true },
      `canApply(${ticket.workflow}, ${action}) 应为 true`,
    );
    ticket = apply(ticket, action, payload, AT);
    assert.equal(ticket.workflow, expectedWorkflow, `${action} 后的状态`);
    expectedTimelineLength += 1;
    assert.equal(
      ticket.timeline.length,
      expectedTimelineLength,
      `${action} 必须恰好追加一条 timeline 事件`,
    );
  }

  assert.equal(ticket.workflow, 'done');
  assert.equal(ticket.plan.approvedAt, AT);
  assert.equal(ticket.plan.rejectedReason, null);
  assert.equal(ticket.mr.verdict, 'pass');
  assert.equal(ticket.mr.state, 'merged');
  assert.equal(ticket.mr.rounds, 1);
});

test('analysis_done 记录方案，approve_plan 记录通过时间', () => {
  let ticket = apply(inbox(), 'start_analysis', {}, AT);
  ticket = apply(ticket, 'analysis_done', { plan: PLAN }, AT);

  assert.equal(ticket.workflow, 'plan_review');
  assert.equal(ticket.plan.summary, PLAN.summary);
  assert.equal(ticket.plan.rootCause, PLAN.rootCause);
  assert.equal(ticket.plan.approach, PLAN.approach);
  assert.deepEqual(ticket.plan.changedFiles, PLAN.changedFiles);
  assert.deepEqual(ticket.plan.risks, PLAN.risks);
  assert.equal(ticket.plan.testPlan, PLAN.testPlan);
  assert.equal(ticket.plan.generatedAt, AT);
  assert.equal(ticket.plan.approvedAt, null);
  assert.equal(ticket.plan.rejectedReason, null);

  const approved = apply(ticket, 'approve_plan', {}, AT);
  assert.equal(approved.workflow, 'fixing');
  assert.equal(approved.plan.approvedAt, AT);
  assert.equal(approved.plan.rejectedReason, null);
});

test('非法迁移：canApply 返回 ok:false，apply 抛 invalid-transition', () => {
  const cases = [
    ['inbox', 'mr_merged'],
    ['plan_review', 'fix_done'],
    ['analyzing', 'approve_plan'],
    ['fixing', 'review_pass'],
    ['submitting', 'review_requests_changes'],
    ['mr_open', 'fix_done'],
    ['fixing_review', 'review_pass'],
    ['mergeable', 'dismiss'],
    ['merged', 'review_pass'],
    ['blocked', 'start_analysis'],
  ];

  for (const [workflow, action] of cases) {
    const ticket = ticketAt(workflow);
    const result = canApply(ticket, action);
    assert.equal(result.ok, false, `${workflow} + ${action} 应被拒绝`);
    assert.equal(result.code, 'invalid-transition', `${workflow} + ${action} 的错误码`);
    assert.equal(typeof result.message, 'string');

    assert.throws(
      () => apply(ticket, action, {}, AT),
      (error) => {
        assert.ok(error instanceof StateError);
        assert.equal(error.code, 'invalid-transition');
        assert.equal(typeof error.message, 'string');
        return true;
      },
      `${workflow} + ${action} 应抛 StateError`,
    );
  }
});

test('done 状态拒绝所有动作且不抛 canApply 异常', () => {
  const ticket = ticketAt('done');
  for (const action of ACTIONS) {
    const result = canApply(ticket, action);
    assert.equal(result.ok, false, `done + ${action} 应被拒绝`);
    assert.equal(result.code, 'invalid-transition');
    assert.throws(() => apply(ticket, action, {}, AT), StateError);
  }
});

test('canApply 不抛异常：未知动作返回 invalid-action', () => {
  const ticket = inbox();
  assert.doesNotThrow(() => canApply(ticket, 'no_such_action'));
  assert.doesNotThrow(() => canApply(ticket, undefined));
  const result = canApply(ticket, 'no_such_action');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-action');
  assert.equal(typeof result.message, 'string');
});

test('reject_plan 进入 blocked 并保留驳回原因，retry 回到 plan_review', () => {
  let ticket = apply(inbox(), 'start_analysis', {}, AT);
  ticket = apply(ticket, 'analysis_done', { plan: PLAN }, AT);

  const blocked = apply(ticket, 'reject_plan', { reason: '根因不成立，需要重新分析' }, AT);
  assert.equal(blocked.workflow, 'blocked');
  assert.equal(blocked.blockedFrom, 'plan_review');
  assert.equal(blocked.blockedReason, '根因不成立，需要重新分析');
  assert.equal(blocked.plan.rejectedReason, '根因不成立，需要重新分析');
  assert.equal(blocked.timeline.at(-1).kind, 'reject_plan');
  assert.match(blocked.timeline.at(-1).message, /根因不成立/);

  const retried = apply(blocked, 'retry', {}, AT);
  assert.equal(retried.workflow, 'plan_review');
  assert.equal(retried.blockedFrom, null);
  assert.equal(retried.blockedReason, null);
  assert.equal(retried.plan.rejectedReason, '根因不成立，需要重新分析');
  assert.equal(retried.timeline.at(-1).kind, 'retry');
  assert.equal(canApply(blocked, 'retry').ok, true);
});

test('reject_plan 未给原因时 blockedReason 为 plan-rejected，plan.rejectedReason 仍为 null', () => {
  let ticket = apply(inbox(), 'start_analysis', {}, AT);
  ticket = apply(ticket, 'analysis_done', { plan: PLAN }, AT);

  const blocked = apply(ticket, 'reject_plan', {}, AT);
  assert.equal(blocked.workflow, 'blocked');
  assert.equal(blocked.blockedFrom, 'plan_review');
  assert.equal(blocked.blockedReason, 'plan-rejected');
  assert.equal(blocked.plan.rejectedReason, null);
});

test('block 可从任意非终态进入 blocked，retry 回到原状态并清除阻塞字段', () => {
  const blockableStates = EXPECTED_STATES.filter(
    (state) => state !== 'done' && state !== 'blocked',
  );

  for (const state of blockableStates) {
    const blocked = apply(ticketAt(state), 'block', {}, AT);
    assert.equal(blocked.workflow, 'blocked', `${state} + block 应进入 blocked`);
    assert.equal(blocked.blockedFrom, state, `${state} 的 blockedFrom`);
    assert.equal(blocked.blockedReason, 'unknown', `${state} 的默认阻塞原因`);
    assert.equal(blocked.updatedAt, AT);
    assert.equal(blocked.timeline.length, 2, `${state} + block 只追加一条事件`);
    assert.equal(blocked.timeline.at(-1).kind, 'blocked');
    assert.equal(blocked.timeline.at(-1).actor, 'system');
    assert.equal(blocked.timeline.at(-1).at, AT);

    const retried = apply(blocked, 'retry', {}, AT);
    assert.equal(retried.workflow, state, `${state} 的 retry 应回到原状态`);
    assert.equal(retried.blockedFrom, null);
    assert.equal(retried.blockedReason, null);
    assert.equal(retried.timeline.at(-1).kind, 'retry');
  }
});

test('block 从 fixing 进入 blocked 并记录 reason/actor，retry 回到 fixing', () => {
  const fixing = ticketAt('fixing');
  const blocked = apply(fixing, 'block', {
    reason: 'worktree 脏状态，需要人工处理',
    actor: 'user',
  }, AT);

  assert.equal(blocked.workflow, 'blocked');
  assert.equal(blocked.blockedFrom, 'fixing');
  assert.equal(blocked.blockedReason, 'worktree 脏状态，需要人工处理');
  assert.equal(blocked.timeline.at(-1).kind, 'blocked');
  assert.equal(blocked.timeline.at(-1).actor, 'user');

  const retried = apply(blocked, 'retry', {}, AT);
  assert.equal(retried.workflow, 'fixing');
  assert.equal(retried.blockedFrom, null);
  assert.equal(retried.blockedReason, null);
});

test('block 从 mr_open 进入 blocked，retry 回到 mr_open 并保留 mr 上下文', () => {
  const before = mrOpen(2);
  const blocked = apply(before, 'block', { reason: 'GitLab 登录失效' }, AT);

  assert.equal(blocked.workflow, 'blocked');
  assert.equal(blocked.blockedFrom, 'mr_open');
  assert.equal(blocked.blockedReason, 'GitLab 登录失效');
  assert.deepEqual(blocked.mr, before.mr);

  const retried = apply(blocked, 'retry', {}, AT);
  assert.equal(retried.workflow, 'mr_open');
  assert.equal(retried.blockedFrom, null);
  assert.equal(retried.blockedReason, null);
  assert.deepEqual(retried.mr, before.mr);
  assert.deepEqual(canApply(retried, 'review_pass'), { ok: true });
});

test('block 在 done 与 blocked 上被拒绝（invalid-transition）', () => {
  for (const state of ['done', 'blocked']) {
    const ticket = ticketAt(state);
    const result = canApply(ticket, 'block');
    assert.equal(result.ok, false, `${state} + block 应被拒绝`);
    assert.equal(result.code, 'invalid-transition');

    assert.throws(
      () => apply(ticket, 'block', { reason: '不应发生' }, AT),
      (error) => {
        assert.ok(error instanceof StateError);
        assert.equal(error.code, 'invalid-transition');
        return true;
      },
      `${state} + block 应抛 StateError`,
    );
  }
});

test('blocked 且没有方案时 retry 回到 inbox', () => {
  const blocked = ticketAt('blocked');
  assert.equal(blocked.plan, null);
  assert.deepEqual(canApply(blocked, 'retry'), { ok: true });

  const retried = apply(blocked, 'retry', {}, AT);
  assert.equal(retried.workflow, 'inbox');
  assert.equal(retried.timeline.at(-1).kind, 'retry');
});

test('review_requests_changes 每轮 mr.rounds 自增，第 4 次返回 review-rounds-exhausted', () => {
  let ticket = mrOpen(0);

  for (let round = 1; round <= 3; round += 1) {
    assert.deepEqual(canApply(ticket, 'review_requests_changes'), { ok: true });
    ticket = apply(ticket, 'review_requests_changes', {}, AT);
    assert.equal(ticket.workflow, 'fixing_review');
    assert.equal(ticket.mr.rounds, round);
    assert.equal(ticket.mr.verdict, 'changes');

    ticket = apply(ticket, 'review_fix_done', {}, AT);
    assert.equal(ticket.workflow, 'mr_open');
    assert.equal(ticket.mr.rounds, round, 'review_fix_done 不改轮次');
  }

  const rejected = canApply(ticket, 'review_requests_changes');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'review-rounds-exhausted');
  assert.equal(typeof rejected.message, 'string');

  assert.throws(
    () => apply(ticket, 'review_requests_changes', {}, AT),
    (error) => {
      assert.ok(error instanceof StateError);
      assert.equal(error.code, 'review-rounds-exhausted');
      return true;
    },
  );
  assert.equal(ticket.mr.rounds, 3, '被拒绝的第 4 次请求不能改写轮次');
});

test('review_requests_changes 记录本次阻塞项，review_pass 清空阻塞项', () => {
  let ticket = apply(mrOpen(0), 'review_requests_changes', {
    blockingIssues: [{ fid: 'F1', file: 'src/a.js', level: '高', blocking: true }],
    nonBlockingIssues: [{ fid: 'F2', file: 'src/b.js', level: '低', blocking: false }],
  }, AT);

  assert.deepEqual(ticket.mr.blockingIssues, [
    { fid: 'F1', file: 'src/a.js', level: '高', blocking: true },
  ]);
  assert.deepEqual(ticket.mr.nonBlockingIssues, [
    { fid: 'F2', file: 'src/b.js', level: '低', blocking: false },
  ]);

  ticket = apply(ticket, 'review_fix_done', {}, AT);
  ticket = apply(ticket, 'review_pass', {}, AT);
  assert.equal(ticket.workflow, 'mergeable');
  assert.equal(ticket.mr.verdict, 'pass');
  assert.deepEqual(ticket.mr.blockingIssues, []);
});

test('mr_created 记录 MR 并补全默认字段', () => {
  const ticket = apply(ticketAt('submitting'), 'mr_created', {
    mr: {
      iid: 17,
      url: 'https://gitlab.example.com/group/app/-/merge_requests/17',
      sourceBranch: 'feat-BUG-001-ly',
      targetBranch: 'develop',
    },
  }, AT);

  assert.equal(ticket.workflow, 'mr_open');
  assert.equal(ticket.mr.iid, 17);
  assert.equal(ticket.mr.url, 'https://gitlab.example.com/group/app/-/merge_requests/17');
  assert.equal(ticket.mr.sourceBranch, 'feat-BUG-001-ly');
  assert.equal(ticket.mr.targetBranch, 'develop');
  assert.equal(ticket.mr.state, 'open');
  assert.equal(ticket.mr.verdict, null);
  assert.equal(ticket.mr.rounds, 0);
  assert.deepEqual(ticket.mr.blockingIssues, []);
  assert.deepEqual(ticket.mr.nonBlockingIssues, []);
});

test('submit_mr 停在 submitting 等 mr_created 确认，apply 返回新对象', () => {
  const before = ticketAt('submitting');
  const after = apply(before, 'submit_mr', {}, AT);

  assert.equal(after.workflow, 'submitting');
  assert.equal(after.timeline.length, before.timeline.length + 1);
  assert.equal(after.timeline.at(-1).kind, 'submit_mr');
  assert.equal(canApply(after, 'mr_created').ok, true);
  assert.notEqual(after, before);
});

test('apply 不修改入参（含嵌套 plan），并返回新的 timeline 数组', () => {
  let ticket = apply(inbox(), 'start_analysis', {}, AT);
  ticket = apply(ticket, 'analysis_done', { plan: PLAN }, AT);
  const snapshot = structuredClone(ticket);

  const next = apply(ticket, 'approve_plan', {}, AT);

  assert.deepEqual(ticket, snapshot);
  assert.notEqual(next, ticket);
  assert.notEqual(next.timeline, ticket.timeline);
  assert.notEqual(next.plan, ticket.plan);
  assert.equal(next.timeline.length, snapshot.timeline.length + 1);
  assert.equal(next.timeline.at(-1).kind, 'approve_plan');
  assert.equal(next.timeline.at(-1).at, AT);
  assert.equal(next.updatedAt, AT);
  assert.equal(next.plan.approvedAt, AT);
});

test('apply 支持 payload.message 自定义时间线文案与 actor 覆盖', () => {
  const ticket = apply(inbox(), 'start_analysis', {
    message: '用户点击了分析按钮',
    actor: 'system',
  }, AT);

  assert.equal(ticket.timeline.at(-1).message, '用户点击了分析按钮');
  assert.equal(ticket.timeline.at(-1).actor, 'system');
});

test('StateError 支持对象构造并暴露 code/name', () => {
  const error = new StateError({ code: 'demo', message: '演示错误' });
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'StateError');
  assert.equal(error.code, 'demo');
  assert.equal(error.message, '演示错误');
});
