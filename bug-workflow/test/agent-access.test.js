/**
 * Unit tests for the P3 analysis agent runner (`src/host/agent-access.js`).
 *
 * The runner is dependency-injected over `{ get(name) }`, so every test drives
 * the real logic with plain fake services:
 *
 *   - `ctx.agents` is a fake registry exposing `list()`/`roots()`;
 *   - `ctx.subagents` is a fake service whose `startActivation(spec)` records
 *     the exact spec and resolves a fake activation
 *     `{childId, messageId, result, dispose}`.
 *
 * The live contract these fakes mirror comes from P0 Spike D and the installed
 * `@deepseek-ai/dsh-subagent` / `dsh-agent` packages:
 *
 *   - the public `Agent` is `{ readonly id: SessionId }`, so the session id is
 *     `agent.id` (there is no public `agent.session` property);
 *   - `request.prompt` is a `ContentBlock[]`, not a string;
 *   - `signal` is mandatory and only cancels pre-publication work, so the
 *     runner composes a timeout/caller signal and always calls `dispose()`;
 *   - `activation.result` is a `SubagentResult`
 *     `{output: ContentBlock[], structured?, diagnostic?, stopReason}`.
 *
 * No credentials or real subagents are involved; timing is exercised only with
 * short, deterministic timers (timeout/caller-abort cases).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAnalysisPrompt,
  createAgentRunner,
  extractJsonPlan,
} from '../src/host/agent-access.js';

const TICKET = Object.freeze({
  code: 'BUG-101',
  title: '登录按钮点击无响应',
  type: '缺陷',
  status: '进行中',
  version: 'V1.2.0',
  priority: '中',
  platform: Object.freeze({ description: '点击登录按钮后页面没有任何反应。' }),
});

const PLAN = Object.freeze({
  summary: '修复登录按钮的事件绑定',
  rootCause: '登录表单的事件监听在组件重渲染后丢失',
  approach: '在挂载时绑定监听，并在卸载时清理',
  changedFiles: ['src/features/login/LoginForm.tsx'],
  risks: ['可能影响注册表单的提交按钮'],
  testPlan: '运行登录表单单测并手工验证登录流程',
});

const PLAN_TEXT = JSON.stringify(PLAN, null, 2);

/** Build the injected `services` map used by `createAgentRunner`. */
function createServices(parts = {}) {
  const map = new Map(Object.entries(parts));
  return {
    get(name) {
      return map.get(name);
    },
  };
}

/**
 * Fake `ctx.agents`. `listError`/`rootsError` make the matching method throw so
 * the runner's tolerance of broken service shapes is testable.
 */
function createFakeAgents({ list = [], roots = [], listError, rootsError } = {}) {
  return {
    list() {
      if (listError !== undefined) throw listError;
      return list;
    },
    roots() {
      if (rootsError !== undefined) throw rootsError;
      return roots;
    },
  };
}

/** Fake `ctx.subagents`; records every activation spec. */
function createFakeSubagents({ activation, startError, rejectError } = {}) {
  const calls = [];
  return {
    calls,
    startActivation(spec) {
      calls.push(spec);
      if (startError !== undefined) throw startError;
      if (rejectError !== undefined) return Promise.reject(rejectError);
      return Promise.resolve(activation);
    },
  };
}

/**
 * Fake activation. `result` may be a `SubagentResult`, a string/array
 * (robustness shapes) or a pending promise (timeout/abort cases).
 */
function createFakeActivation({ childId = 'child-1', result, dispose } = {}) {
  const state = { disposeCalls: 0 };
  const settled = result === undefined
    ? { output: [{ type: 'text', text: PLAN_TEXT }], stopReason: 'completed' }
    : result;
  return {
    state,
    activation: {
      childId,
      messageId: 'message-1',
      result: Promise.resolve(settled),
      dispose() {
        state.disposeCalls += 1;
        if (typeof dispose === 'function') return dispose();
        return Promise.resolve();
      },
    },
  };
}

/** Build a runner from optional fake services (omitted names are absent). */
function createRunner({ agents, subagents } = {}) {
  return createAgentRunner({ services: createServices({ agents, subagents }) });
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/** Let the runner's late start/abort handlers settle (microtasks only, no sleep). */
function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Manually settle a promise later (late activation / late result scenarios). */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/**
 * Collect `unhandledRejection` events for one scenario. Node reports the event
 * after the current microtask checkpoint, so `stop()` must be awaited before
 * `reasons` is inspected; it also removes the listener so a failing assertion
 * cannot leak it into later tests.
 */
function captureUnhandledRejections() {
  const reasons = [];
  const listener = (reason) => reasons.push(reason);
  process.on('unhandledRejection', listener);
  return {
    reasons,
    async stop() {
      await flushMicrotasks();
      await flushMicrotasks();
      process.removeListener('unhandledRejection', listener);
      return reasons;
    },
  };
}

/** Run the happy path with the given result payload and return the runner result. */
async function runWithResult(result) {
  const { activation, state } = createFakeActivation({ result });
  const subagents = createFakeSubagents({ activation });
  const runner = createRunner({
    agents: createFakeAgents({ roots: [{ id: 'session-root' }] }),
    subagents,
  });
  const outcome = await runner.runAnalysis({ sessionId: 'session-root', ticket: TICKET });
  return { outcome, subagents, state };
}

test('available() requires both live services and their needed methods', () => {
  const agents = createFakeAgents();
  const subagents = createFakeSubagents();

  assert.equal(createRunner({ agents, subagents }).available(), true);
  assert.equal(createRunner({ agents }).available(), false);
  assert.equal(createRunner({ subagents }).available(), false);
  assert.equal(createRunner({ agents, subagents: {} }).available(), false);
  assert.equal(createRunner({ agents: {}, subagents }).available(), false);
  assert.equal(createRunner({}).available(), false);
  assert.equal(createAgentRunner().available(), false);
  assert.equal(
    createAgentRunner({ services: { get() { throw new Error('broken registry'); } } }).available(),
    false,
  );
});

test('resolveParent() prefers the live agent whose id matches the session id', () => {
  const first = { id: 'session-a' };
  const second = { id: 'session-b' };
  const root = { id: 'root-1' };
  const agents = createFakeAgents({ list: [first, second], roots: [root] });
  const runner = createRunner({ agents, subagents: createFakeSubagents() });

  assert.equal(runner.resolveParent('session-b'), second);
  // No exact match: fall back to the last live root rather than guessing.
  assert.equal(runner.resolveParent('session-missing'), root);
  // A substring is not an identity match.
  assert.equal(runner.resolveParent('session'), root);
});

test('resolveParent() falls back to the last live root', () => {
  const roots = [{ id: 'root-1' }, { id: 'root-2' }];
  const runner = createRunner({
    agents: createFakeAgents({ list: [{ id: 'other' }], roots }),
    subagents: createFakeSubagents(),
  });

  assert.equal(runner.resolveParent('unknown-session'), roots[1]);

  const empty = createRunner({
    agents: createFakeAgents({ list: [], roots: [] }),
    subagents: createFakeSubagents(),
  });
  assert.equal(empty.resolveParent('unknown-session'), null);
});

test('resolveParent() returns null instead of throwing on missing or weird services', () => {
  assert.equal(createRunner({}).resolveParent('session-1'), null);
  assert.equal(createRunner({ agents: null }).resolveParent('session-1'), null);
  assert.equal(
    createRunner({ agents: createFakeAgents({ listError: new Error('list boom') }) })
      .resolveParent('session-1'),
    null,
  );
  assert.equal(
    createRunner({ agents: createFakeAgents({ rootsError: new Error('roots boom') }) })
      .resolveParent('session-1'),
    null,
  );

  // A throwing list() still allows the root fallback.
  const root = { id: 'root-1' };
  assert.equal(
    createRunner({
      agents: createFakeAgents({ listError: new Error('list boom'), roots: [root] }),
    }).resolveParent('session-1'),
    root,
  );

  // Non-array lists and malformed agent entries are ignored.
  const weird = {
    list() { return 'not-an-array'; },
    roots() { return [null, {}, { id: 42 }, { id: '' }]; },
  };
  assert.equal(createRunner({ agents: weird }).resolveParent('session-1'), null);

  assert.equal(
    createAgentRunner({ services: { get() { throw new Error('broken registry'); } } })
      .resolveParent('session-1'),
    null,
  );
});

test('runAnalysis() starts one caller-delivery spawn activation under the matching agent', async () => {
  const sessionAgent = { id: 'session-2' };
  const rootAgent = { id: 'root-1' };
  const agents = createFakeAgents({
    list: [{ id: 'session-1' }, sessionAgent],
    roots: [rootAgent],
  });
  const { activation, state } = createFakeActivation();
  const subagents = createFakeSubagents({ activation });
  const runner = createRunner({ agents, subagents });

  const result = await runner.runAnalysis({
    sessionId: 'session-2',
    cwd: '/tmp/bug-workflow-workspace',
    ticket: TICKET,
  });

  assert.equal(result.ok, true);
  for (const [field, value] of Object.entries(PLAN)) {
    assert.deepEqual(result.plan[field], value, `plan.${field} must survive the run`);
  }
  assert.equal(typeof result.plan.generatedAt, 'string', 'generatedAt must be an ISO string');
  assert.equal(
    Number.isNaN(Date.parse(result.plan.generatedAt)),
    false,
    'generatedAt must be a parseable date',
  );
  assert.equal(
    new Date(result.plan.generatedAt).toISOString(),
    result.plan.generatedAt,
    'generatedAt must be a canonical ISO timestamp',
  );
  assert.equal(result.childId, 'child-1');
  assert.equal(typeof result.elapsedMs, 'number');
  assert.ok(result.elapsedMs >= 0);

  assert.equal(subagents.calls.length, 1);
  const spec = subagents.calls[0];
  assert.equal(spec.provider, 'spawn');
  assert.equal(spec.label, 'analysis:BUG-101');
  assert.equal(spec.delivery, 'caller');
  assert.ok(spec.signal instanceof AbortSignal, 'signal must be a real AbortSignal');
  assert.equal(spec.signal.aborted, false);
  assert.equal(spec.request.parent, sessionAgent, 'the exact matching live Agent must be the parent');
  assert.equal(spec.request.cwd, '/tmp/bug-workflow-workspace');
  assert.ok(Array.isArray(spec.request.prompt), 'request.prompt must be ContentBlock[]');
  assert.equal(spec.request.prompt.length, 1);
  assert.equal(spec.request.prompt[0].type, 'text');

  const prompt = spec.request.prompt[0].text;
  for (const expected of [
    'BUG-101',
    TICKET.title,
    '只读',
    '不得修改',
    '不得执行破坏性命令',
    'JSON',
    'summary',
    'rootCause',
    'approach',
    'changedFiles',
    'risks',
    'testPlan',
    '/tmp/bug-workflow-workspace',
  ]) {
    assert.ok(prompt.includes(expected), `prompt must contain ${JSON.stringify(expected)}`);
  }

  assert.equal(state.disposeCalls, 1, 'the activation must always be disposed');
});

test('runAnalysis() parses a fenced JSON plan surrounded by extra text', async () => {
  const text = `分析完成，结果如下：\n\n\`\`\`json\n${PLAN_TEXT}\n\`\`\`\n\n以上方案请审核。`;
  const { outcome } = await runWithResult({
    output: [{ type: 'text', text }],
    stopReason: 'completed',
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.plan.summary, PLAN.summary);
  assert.deepEqual(outcome.plan.changedFiles, PLAN.changedFiles);
});

test('runAnalysis() accepts live content blocks plus string and string-array outputs', async () => {
  const shapes = [
    { output: [{ type: 'reasoning', text: '先看代码' }, { type: 'text', text: PLAN_TEXT }], stopReason: 'completed' },
    { output: PLAN_TEXT, stopReason: 'completed' },
    { output: [PLAN_TEXT], stopReason: 'completed' },
    PLAN_TEXT,
  ];

  for (const [index, shape] of shapes.entries()) {
    const { outcome } = await runWithResult(shape);
    assert.equal(outcome.ok, true, `shape #${index} should parse`);
    assert.equal(outcome.plan.summary, PLAN.summary, `shape #${index} summary`);
  }
});

test('runAnalysis() returns analysis-bad-output for unparseable or invalid plans', async () => {
  const invalid = [
    '这里没有任何 JSON。',
    JSON.stringify({ summary: 's', rootCause: 'r', changedFiles: [], risks: [], testPlan: 't' }),
    JSON.stringify({ ...PLAN, changedFiles: 'src/features/login/LoginForm.tsx' }),
    JSON.stringify({ ...PLAN, risks: [1, 2] }),
    JSON.stringify({ ...PLAN, approach: '' }),
    JSON.stringify({ ...PLAN, summary: 42 }),
    JSON.stringify({ ...PLAN, testPlan: 42 }),
  ];

  for (const [index, text] of invalid.entries()) {
    const { outcome, state } = await runWithResult({
      output: [{ type: 'text', text }],
      stopReason: 'completed',
    });
    assert.deepEqual(
      outcome,
      { ok: false, code: 'analysis-bad-output', message: '分析结果格式不正确，请重试' },
      `invalid case #${index}`,
    );
    assert.equal(state.disposeCalls, 1, `invalid case #${index} must dispose`);
  }
});

test('runAnalysis() accepts an empty testPlan while still requiring a string', async () => {
  for (const testPlan of ['', '   ']) {
    const { outcome, state } = await runWithResult({
      output: [{ type: 'text', text: JSON.stringify({ ...PLAN, testPlan }) }],
      stopReason: 'completed',
    });
    assert.equal(outcome.ok, true, `testPlan ${JSON.stringify(testPlan)} must be allowed`);
    assert.equal(outcome.plan.testPlan, testPlan);
    assert.equal(state.disposeCalls, 1);
  }
});

test('runAnalysis() fails on a non-completed stopReason even with parseable output', async () => {
  for (const stopReason of ['aborted', 'error', 'max-tokens', 'refusal']) {
    const { outcome, state } = await runWithResult({
      output: [{ type: 'text', text: PLAN_TEXT }],
      stopReason,
    });
    assert.deepEqual(
      outcome,
      { ok: false, code: 'analysis-failed', message: '分析子代理执行失败，请重试' },
      `stopReason ${stopReason} must fail`,
    );
    assert.equal(state.disposeCalls, 1, `stopReason ${stopReason} must dispose`);
  }

  const completed = await runWithResult({
    output: [{ type: 'text', text: PLAN_TEXT }],
    stopReason: 'completed',
  });
  assert.equal(completed.outcome.ok, true, 'a completed child must still parse');
});

test('runAnalysis() rejects an activation without a usable childId', async () => {
  const expected = {
    ok: false,
    code: 'analysis-failed',
    message: '分析子代理执行失败，请重试',
  };
  const missing = createFakeActivation();
  delete missing.activation.childId;
  const wrappers = [missing];
  for (const childId of [null, '', '   ', 42]) {
    wrappers.push(createFakeActivation({ childId }));
  }

  for (const [index, { activation, state }] of wrappers.entries()) {
    const runner = createRunner({
      agents: createFakeAgents({ roots: [{ id: 'session-root' }] }),
      subagents: createFakeSubagents({ activation }),
    });
    const outcome = await runner.runAnalysis({ sessionId: 'session-root', ticket: TICKET });
    assert.deepEqual(outcome, expected, `childId case #${index} must fail`);
    assert.equal(state.disposeCalls, 1, `childId case #${index} must dispose`);
  }
});

test('runAnalysis() observes a late activation result so abort leaves no unhandled rejection', async () => {
  const capture = captureUnhandledRejections();
  try {
    const start = deferred();
    const result = deferred();
    let disposeCalls = 0;
    const activation = {
      childId: 'child-late',
      messageId: 'message-late',
      result: result.promise,
      dispose() {
        disposeCalls += 1;
        return Promise.resolve();
      },
    };
    const subagents = {
      calls: [],
      startActivation(spec) {
        this.calls.push(spec);
        return start.promise;
      },
    };
    const live = new AbortController();
    const runner = createRunner({
      agents: createFakeAgents({ roots: [{ id: 'session-root' }] }),
      subagents,
    });

    const pending = runner.runAnalysis({
      sessionId: 'session-root',
      ticket: TICKET,
      signal: live.signal,
    });
    queueMicrotask(() => live.abort());
    const outcome = await pending;
    assert.deepEqual(outcome, {
      ok: false,
      code: 'analysis-failed',
      message: '分析子代理执行失败，请重试',
    });

    // The activation is published only after the run already ended. The late
    // handler must observe its result and dispose it exactly once.
    start.resolve(activation);
    await flushMicrotasks();
    assert.equal(disposeCalls, 1, 'the late activation must be disposed');

    result.reject(new Error('late result rejection'));
  } finally {
    await capture.stop();
  }
  assert.deepEqual(capture.reasons, [], 'a late result rejection must not be unhandled');
});

test('runAnalysis() observes the result promise when abort wins before the result race', async () => {
  const capture = captureUnhandledRejections();
  try {
    const result = deferred();
    let disposeCalls = 0;
    const live = new AbortController();
    const activation = {
      childId: 'child-aborted',
      // Reading `result` is the last synchronous hook between start resolution
      // and the result race, so this aborts exactly in that window.
      get result() {
        live.abort();
        return result.promise;
      },
      dispose() {
        disposeCalls += 1;
        return Promise.resolve();
      },
    };
    const subagents = createFakeSubagents({ activation });
    const runner = createRunner({
      agents: createFakeAgents({ roots: [{ id: 'session-root' }] }),
      subagents,
    });

    const outcome = await runner.runAnalysis({
      sessionId: 'session-root',
      ticket: TICKET,
      signal: live.signal,
    });
    assert.deepEqual(outcome, {
      ok: false,
      code: 'analysis-failed',
      message: '分析子代理执行失败，请重试',
    });
    assert.equal(live.signal.aborted, true, 'the caller abort must be observed');
    assert.equal(disposeCalls, 1, 'the aborted activation must be disposed');

    result.reject(new Error('result rejected after abort'));
  } finally {
    await capture.stop();
  }
  assert.deepEqual(capture.reasons, [], 'an aborted result rejection must not be unhandled');
});

test('runAnalysis() maps a timeout to analysis-timeout and aborts the signal', async () => {
  const { activation, state } = createFakeActivation({ result: new Promise(() => {}) });
  const subagents = createFakeSubagents({ activation });
  const runner = createRunner({
    agents: createFakeAgents({ roots: [{ id: 'session-root' }] }),
    subagents,
  });

  const result = await runner.runAnalysis({
    sessionId: 'session-root',
    ticket: TICKET,
    timeoutMs: 25,
  });

  assert.deepEqual(result, {
    ok: false,
    code: 'analysis-timeout',
    message: '分析超时，请重试',
  });
  assert.equal(subagents.calls.length, 1);
  assert.equal(subagents.calls[0].signal.aborted, true, 'the activation signal must abort');
  assert.equal(state.disposeCalls, 1, 'a timed-out activation must be disposed');
});

test('runAnalysis() maps caller cancellation to analysis-failed', async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  const preSubagents = createFakeSubagents({ activation: createFakeActivation().activation });
  const preRunner = createRunner({
    agents: createFakeAgents({ roots: [{ id: 'session-root' }] }),
    subagents: preSubagents,
  });
  const preResult = await preRunner.runAnalysis({
    sessionId: 'session-root',
    ticket: TICKET,
    signal: preAborted.signal,
  });
  assert.deepEqual(preResult, {
    ok: false,
    code: 'analysis-failed',
    message: '分析子代理执行失败，请重试',
  });
  assert.equal(preSubagents.calls.length, 0, 'an already-cancelled run must not start a child');

  const live = new AbortController();
  const { activation, state } = createFakeActivation({ result: new Promise(() => {}) });
  const subagents = createFakeSubagents({ activation });
  const runner = createRunner({
    agents: createFakeAgents({ roots: [{ id: 'session-root' }] }),
    subagents,
  });
  const pending = runner.runAnalysis({
    sessionId: 'session-root',
    ticket: TICKET,
    timeoutMs: 5_000,
    signal: live.signal,
  });
  queueMicrotask(() => live.abort());
  const result = await pending;

  assert.deepEqual(result, {
    ok: false,
    code: 'analysis-failed',
    message: '分析子代理执行失败，请重试',
  });
  assert.equal(subagents.calls[0].signal.aborted, true);
  // The abort can win while startActivation is still settling; the late handler
  // must still dispose the published activation.
  await flushMicrotasks();
  assert.equal(state.disposeCalls, 1);
});

test('runAnalysis() maps activation startup failures to a static analysis-failed', async () => {
  const secret = 'child-secret-payload';
  const failures = [
    createFakeSubagents({ startError: new Error(`start failed: ${secret}`) }),
    createFakeSubagents({ rejectError: new Error(`start rejected: ${secret}`) }),
  ];

  for (const subagents of failures) {
    const runner = createRunner({
      agents: createFakeAgents({ roots: [{ id: 'session-root' }] }),
      subagents,
    });
    const result = await runner.runAnalysis({ sessionId: 'session-root', ticket: TICKET });

    assert.deepEqual(result, {
      ok: false,
      code: 'analysis-failed',
      message: '分析子代理执行失败，请重试',
    });
    assert.equal(JSON.stringify(result).includes(secret), false, 'child errors must not leak');
  }
});

test('runAnalysis() returns analysis-unavailable when services or live parents are missing', async () => {
  const expected = {
    ok: false,
    code: 'analysis-unavailable',
    message: '当前没有可用的会话 Agent',
  };

  assert.deepEqual(
    await createRunner({}).runAnalysis({ sessionId: 'session-root', ticket: TICKET }),
    expected,
  );
  assert.deepEqual(
    await createRunner({ agents: createFakeAgents() })
      .runAnalysis({ sessionId: 'session-root', ticket: TICKET }),
    expected,
  );
  assert.deepEqual(
    await createRunner({ subagents: createFakeSubagents() })
      .runAnalysis({ sessionId: 'session-root', ticket: TICKET }),
    expected,
  );

  const subagents = createFakeSubagents();
  const noLiveAgent = createRunner({
    agents: createFakeAgents({ list: [], roots: [] }),
    subagents,
  });
  assert.deepEqual(
    await noLiveAgent.runAnalysis({ sessionId: 'session-root', ticket: TICKET }),
    expected,
  );
  assert.equal(subagents.calls.length, 0, 'no live parent means no child');
});

test('runAnalysis() and buildAnalysisPrompt() never mutate the ticket', async () => {
  const ticket = deepFreeze({
    ...TICKET,
    platform: { description: '点击登录按钮后页面没有任何反应。' },
  });
  const snapshot = structuredClone(ticket);
  const { activation } = createFakeActivation();
  const runner = createRunner({
    agents: createFakeAgents({ roots: [{ id: 'session-root' }] }),
    subagents: createFakeSubagents({ activation }),
  });

  buildAnalysisPrompt(ticket, '/tmp/ws');
  const result = await runner.runAnalysis({ sessionId: 'session-root', ticket });

  assert.equal(result.ok, true);
  assert.deepEqual(ticket, snapshot);
});

test('buildAnalysisPrompt() renders ticket fields, workspace, read-only rules and the JSON contract', () => {
  const prompt = buildAnalysisPrompt(TICKET, '/tmp/workspace');
  for (const value of [
    TICKET.code,
    TICKET.title,
    TICKET.type,
    TICKET.status,
    TICKET.version,
    TICKET.platform.description,
    '/tmp/workspace',
  ]) {
    assert.ok(prompt.includes(value), `prompt must contain ${JSON.stringify(value)}`);
  }
  for (const marker of [
    '只读',
    '不得修改',
    '不得执行破坏性命令',
    'JSON',
    'summary',
    'rootCause',
    'approach',
    'changedFiles',
    'risks',
    'testPlan',
  ]) {
    assert.ok(prompt.includes(marker), `prompt must contain ${JSON.stringify(marker)}`);
  }

  assert.ok(buildAnalysisPrompt(TICKET).includes('当前会话工作区'));
  assert.equal(typeof buildAnalysisPrompt(null), 'string');
});

test('buildAnalysisPrompt() truncates the description at 4000 characters', () => {
  const exact = '中'.repeat(4_000);
  const exactPrompt = buildAnalysisPrompt({ code: 'BUG-T', platform: { description: exact } }, '/tmp/ws');
  assert.ok(exactPrompt.includes(exact), 'a 4000-character description must be kept whole');
  assert.equal(exactPrompt.includes('已截断'), false);

  const head = '描述开头';
  const tail = '描述尾部标记';
  const longPrompt = buildAnalysisPrompt(
    { code: 'BUG-T', platform: { description: `${head}${'长'.repeat(4_000)}${tail}` } },
    '/tmp/ws',
  );
  assert.ok(longPrompt.includes(head));
  assert.equal(longPrompt.includes(tail), false, 'the tail must be truncated');
  assert.ok(longPrompt.includes('（描述超过 4000 字符，已截断）'));

  const body = longPrompt
    .split('- 描述：\n')[1]
    .split('\n（描述超过 4000 字符，已截断）')[0];
  assert.equal([...body].length, 4_000, 'the rendered description must be at most 4000 characters');
});

test('extractJsonPlan() returns the first parseable balanced JSON object', () => {
  assert.deepEqual(extractJsonPlan(`前言\n\`\`\`json\n${PLAN_TEXT}\n\`\`\`\n后记`), PLAN);
  assert.deepEqual(
    extractJsonPlan(`结果：${JSON.stringify({ ...PLAN, summary: '带 } 和 { 的摘要' })} 结束`),
    { ...PLAN, summary: '带 } 和 { 的摘要' },
  );
  assert.deepEqual(extractJsonPlan('{"a":1} {"b":2}'), { a: 1 });
  assert.deepEqual(extractJsonPlan('{"a":{"nested":1}} 后 {"b":2}'), { a: { nested: 1 } });
  assert.deepEqual(extractJsonPlan(`\`\`\`json\n{"ok":true}\n\`\`\``), { ok: true });
  assert.deepEqual(
    extractJsonPlan('```js\nconst config = {"not":"the plan"};\n```\n```json\n{"ok":true}\n```'),
    { ok: true },
    'a json-tagged fence must win over an earlier generic code fence',
  );
  assert.deepEqual(
    extractJsonPlan('示例 {不是 JSON}，真正的结果：{"ok":true}'),
    { ok: true },
    'a malformed balanced object must not hide a later valid one',
  );
  assert.deepEqual(
    extractJsonPlan('```json\n{不是 JSON}\n```\n真正的结果：{"ok":true}'),
    { ok: true },
    'a malformed fenced body must not hide a later valid object',
  );
});

test('extractJsonPlan() returns null for missing or malformed JSON', () => {
  assert.equal(extractJsonPlan('没有对象，只有文字'), null);
  assert.equal(extractJsonPlan('[1,2,3]'), null);
  assert.equal(extractJsonPlan('"just a string"'), null);
  assert.equal(extractJsonPlan('{broken'), null);
  assert.equal(extractJsonPlan('前缀 {still broken} 后缀'), null);
  assert.equal(extractJsonPlan(''), null);
  assert.equal(extractJsonPlan(undefined), null);
  assert.equal(extractJsonPlan(42), null);
});
