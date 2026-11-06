/**
 * Analysis orchestration service for the Bug workflow plugin (P3 Task 2).
 *
 * The service owns the long-running part of 「开始分析」: it moves one ticket
 * from `inbox` to `analyzing`, delegates the actual work to the injected agent
 * runner, and later applies `analysis_done` (plan review) or `block` (failure)
 * after re-reading the persisted ticket. It is pure orchestration over
 * `{store, runner, clock}`: no Cordis, no storage backend, no bare imports, so
 * the plain-Node test runner can drive a real store over a fake domain.
 *
 * Contracts (P3 plan):
 *
 *   - One analysis per ticket: `start()` returns `running:true` for a duplicate
 *     click instead of launching a second subagent; different tickets run in
 *     parallel.
 *   - Service-level restart: a failure blocks from `analyzing`, and the
 *     `start_analysis` action only accepts `inbox`. So `start()` also restarts
 *     (a) a ticket that is already `analyzing` but has no in-memory job (crash,
 *     unload, previous host) without another state write, and (b) a ticket
 *     blocked with `blockedFrom:'analyzing'` by applying `retry` back to
 *     `analyzing`. Both paths clear the persisted analysis error and launch a
 *     new job; the state machine is never bypassed or modified.
 *   - `start_analysis` is applied through the store (state machine + write
 *     queue) before the background job is launched, so an invalid state never
 *     starts a subagent and never writes a partial ticket.
 *   - The background job never rejects: runner failures are mapped to a static
 *     block reason + static message, stored in `meta['analysis.error:<code>']`.
 *     A failure after the ticket left `analyzing` only records the error; it
 *     never blocks a ticket that has already moved on (`block` is legal from
 *     many workflows, so the failure path additionally requires `analyzing`).
 *   - Before `analysis_done` the persisted ticket is re-read and checked with
 *     `canApply()`. A stale result (the ticket was blocked/approved/dismissed
 *     while the child was running) is discarded with a static meta error; the
 *     state machine remains the only writer of the workflow.
 *   - Error messages are static Chinese strings: runner messages, internal
 *     details and stacks never reach `meta` or the snapshot.
 *   - `dispose()` aborts every running job and drains them: it returns a
 *     promise that settles when the aborted jobs' terminal writes have been
 *     attempted (bounded, so a stuck runner cannot hang unload). Idempotent.
 *     The host must await it before closing the storage domain.
 *   - `start()` re-checks `disposed` after every await and never launches a job
 *     once teardown began.
 *
 * `meta` stays the same domain v2 table as the action ledger: the error keys
 * are `analysis.error:<code>` and `null` clears one. No Ticket/domain schema
 * change is introduced.
 */

import { DEFAULT_ANALYSIS_TIMEOUT_MS } from './agent-access.js';
import { canApply } from './state-machine.js';

/** `meta` key prefix of a persisted analysis error. */
export const ANALYSIS_ERROR_META_PREFIX = 'analysis.error:';

/**
 * Static client-visible text per block reason. These are the only strings ever
 * persisted for an analysis failure; runner diagnostics stay in the host.
 */
export const ANALYSIS_REASON_MESSAGES = Object.freeze({
  'analysis-timeout': '分析超时，请重试',
  'analysis-bad-output': '分析结果格式不正确，请重试',
  'no-live-agent': '当前没有可用的会话 Agent',
  'analysis-failed': '分析子代理执行失败，请重试',
});

/** A successful result that arrived after the ticket stopped being analyzable. */
export const STALE_ANALYSIS_MESSAGE = '分析结果已过期或状态已变化，已丢弃';

/** Runner failure code -> persisted block reason (P3 plan mapping). */
const RUNNER_CODE_TO_REASON = Object.freeze({
  'analysis-timeout': 'analysis-timeout',
  'analysis-bad-output': 'analysis-bad-output',
  'analysis-unavailable': 'no-live-agent',
  'analysis-failed': 'analysis-failed',
});

/** Fallback analysis budget when the caller does not inject one. */
const DEFAULT_TIMEOUT_MS = DEFAULT_ANALYSIS_TIMEOUT_MS;

/**
 * Upper bound on `dispose()` draining aborted jobs. The host awaits the drain
 * before closing the storage domain, so a runner that ignores its abort signal
 * must not be able to hang plugin unload. Normal aborts settle in microseconds;
 * the bound only matters for a stuck runner.
 */
const DEFAULT_DRAIN_TIMEOUT_MS = 3_000;

/**
 * Create the analysis service.
 *
 * @param {object} deps
 * @param {object} deps.store opened ticket store (`get/applyAction/list/getMeta/setMeta`)
 * @param {object} deps.runner `createAgentRunner()` result (`available/runAnalysis`)
 * @param {(() => string) | {now: () => string}} [deps.clock] action-id clock
 * @param {number} [deps.timeoutMs] analysis budget forwarded to the runner
 * @param {number} [deps.drainTimeoutMs] bound on `dispose()` draining jobs
 * @returns {{
 *   start: (sessionId: string, cwd: string, code: string) => Promise<object>,
 *   status: () => {running: string[], errors: Record<string, string>},
 *   dispose: () => Promise<void>,
 * }}
 */
export function createAnalysisService({
  store,
  runner,
  clock = defaultClock,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
} = {}) {
  assertStore(store);
  assertRunner(runner);
  const readNow = normalizeClock(clock);
  const analysisTimeoutMs = positiveNumber(timeoutMs) ?? DEFAULT_TIMEOUT_MS;
  const disposeTimeoutMs = positiveNumber(drainTimeoutMs) ?? DEFAULT_DRAIN_TIMEOUT_MS;

  /** code -> { controller, startedAt } for analyses currently running. */
  const running = new Map();
  /** Promises of background jobs that have not settled yet (dispose drain). */
  const jobs = new Set();
  /** Codes known to carry an analysis error (meta is still the source of truth). */
  const errorCodes = new Set();
  /** Action ids already used by this service instance (clock can be coarse). */
  const usedActionIds = new Set();
  let duplicateActionIdSuffix = 0;
  let disposed = false;
  let disposePromise;

  /**
   * Start one analysis. Returns after `start_analysis` is persisted; the
   * subagent runs in the background and settles the ticket later.
   *
   * @param {string} sessionId live parent session id (subagent resolution)
   * @param {string} cwd resolved workspace path handed to the child
   * @param {string} code ticket code
   * @returns {Promise<{ok:true, running:boolean, workflow:'analyzing'}
   *   | {ok:false, code:string, message:string}>}
   */
  async function start(sessionId, cwd, code) {
    if (disposed) {
      return failure('analysis-unavailable', '分析服务不可用，请稍后重试');
    }

    const key = normalizeCode(code);
    if (key === undefined) {
      return failure('invalid-code', '缺少有效的工单编号 code');
    }

    const ticket = readTicket(key);
    if (ticket === undefined) {
      return failure('ticket-not-found', `工单 ${key} 不存在`);
    }

    // Duplicate click / concurrent request for the same ticket: never launch a
    // second subagent. Every branch below reserves the entry BEFORE its first
    // await, so two same-tick requests cannot both pass this check.
    if (running.has(key)) {
      return { ok: true, running: true, workflow: 'analyzing' };
    }

    // Service-level restart (P3 Task 2 review findings). A failure blocks the
    // ticket from `analyzing`, and `start_analysis` only accepts `inbox`, so
    // without these branches a failed (or crash-orphaned) analysis could never
    // be started again — the plan's "retry → re-analyze" flow would 409
    // forever. The state machine itself is untouched.
    if (ticket.workflow === 'analyzing') {
      return restartAnalyzing({ key, sessionId, cwd, ticket });
    }
    if (ticket.workflow === 'blocked' && ticket.blockedFrom === 'analyzing') {
      return restartBlocked({ key, sessionId, cwd });
    }

    const check = canApply(ticket, 'start_analysis');
    if (!check.ok) {
      return failure('invalid-state', `工单状态 ${String(ticket.workflow)} 不能开始分析`);
    }

    // Availability is checked before any state write: with no live agent there
    // is nothing to analyze, and the ticket must stay in `inbox` (route 503).
    if (!runnerAvailable()) {
      return failure('analysis-unavailable', ANALYSIS_REASON_MESSAGES['no-live-agent']);
    }

    // Surface (and later clear) an error persisted by a previous host load.
    readPersistedError(key);
    const entry = reserve(key);

    let applied;
    try {
      applied = await store.applyAction(
        key,
        'start_analysis',
        { actor: 'user' },
        { actionId: nextActionId('analyze', key) },
      );
    } catch {
      clearRunning(key, entry);
      return failure('internal', '分析启动失败，请重试');
    }

    if (applied?.ok !== true) {
      clearRunning(key, entry);
      return failure(
        typeof applied?.code === 'string' ? applied.code : 'internal',
        typeof applied?.message === 'string' ? applied.message : '分析启动失败，请重试',
      );
    }

    // A replayed/racing action could return a ticket that is no longer
    // analyzing; never launch a job for a transition that did not happen.
    if (applied.ticket?.workflow !== 'analyzing') {
      clearRunning(key, entry);
      return failure('invalid-state', '工单状态已变化，请刷新后重试');
    }

    if (disposed) return disposedStart(key, entry);

    await clearError(key);
    // Re-check AFTER every await: dispose() may have aborted the reserved
    // entry while the write above was in flight. No job may launch then.
    if (disposed) return disposedStart(key, entry);

    launchJob({ entry, key, sessionId, cwd, ticket: applied.ticket });
    return { ok: true, running: true, workflow: 'analyzing' };
  }

  /**
   * Restart a ticket persisted as `analyzing` that has no in-memory job (host
   * crash/unload, or a job that vanished with a previous fiber). No state
   * write happens: the workflow is already where analysis expects it. Only the
   * stale error is cleared and a new background job is launched.
   */
  async function restartAnalyzing({ key, sessionId, cwd, ticket }) {
    const entry = reserve(key);
    await clearError(key);
    if (disposed) return disposedStart(key, entry);

    launchJob({ entry, key, sessionId, cwd, ticket });
    return { ok: true, running: true, workflow: 'analyzing' };
  }

  /**
   * Restart a ticket blocked by a failed analysis: `retry` returns it to the
   * recorded `blockedFrom` (`analyzing`), then a new job is launched. The live
   * agent is checked before any write so a 503 never leaves a half-restarted
   * ticket; a retry that does not end in `analyzing` is treated as lost race.
   */
  async function restartBlocked({ key, sessionId, cwd }) {
    if (!runnerAvailable()) {
      return failure('analysis-unavailable', ANALYSIS_REASON_MESSAGES['no-live-agent']);
    }

    const entry = reserve(key);

    let applied;
    try {
      applied = await store.applyAction(
        key,
        'retry',
        { actor: 'user' },
        { actionId: nextActionId('analyze-retry', key) },
      );
    } catch {
      clearRunning(key, entry);
      return failure('internal', '分析启动失败，请重试');
    }

    if (applied?.ok !== true || applied.ticket?.workflow !== 'analyzing') {
      clearRunning(key, entry);
      return failure('invalid-state', '工单状态已变化，请刷新后重试');
    }

    if (disposed) return disposedStart(key, entry);

    await clearError(key);
    if (disposed) return disposedStart(key, entry);

    launchJob({ entry, key, sessionId, cwd, ticket: applied.ticket });
    return { ok: true, running: true, workflow: 'analyzing' };
  }

  /** Reserve the running entry before the first await of a start branch. */
  function reserve(key) {
    const entry = { controller: new AbortController(), startedAt: readNow() };
    running.set(key, entry);
    return entry;
  }

  /** A start that raced teardown: drop the reservation, never launch, 503. */
  function disposedStart(key, entry) {
    clearRunning(key, entry);
    return failure('analysis-unavailable', '分析服务不可用，请稍后重试');
  }

  /**
   * Snapshot view: currently running codes plus persisted static errors.
   * Errors are read from `meta['analysis.error:<code>']` for the codes this
   * service has seen (and for every stored ticket, so a persisted error stays
   * visible after a host reload). Any store read failure degrades to empty.
   *
   * @returns {{running: string[], errors: Record<string, string>}}
   */
  function status() {
    const codes = new Set(errorCodes);
    try {
      const tickets = store.list();
      if (Array.isArray(tickets)) {
        for (const ticket of tickets) {
          const code = normalizeCode(ticket?.code);
          if (code !== undefined) codes.add(code);
        }
      }
    } catch {
      // A failing ticket scan only hides errors; it must not break a snapshot.
    }

    const errors = {};
    for (const code of codes) {
      const message = readPersistedError(code);
      if (message !== undefined) errors[code] = message;
      else errorCodes.delete(code);
    }
    return { running: [...running.keys()], errors };
  }

  /**
   * Abort every running job and drain it: the returned promise settles once
   * the aborted jobs have attempted their terminal writes (block + meta), or
   * after `drainTimeoutMs` when a runner ignores its abort signal. The host
   * awaits this before closing the storage domain, so a terminal write cannot
   * silently land on a closed domain. Idempotent: repeated calls return the
   * same in-flight drain promise.
   *
   * @returns {Promise<void>}
   */
  function dispose() {
    if (disposePromise !== undefined) return disposePromise;
    disposed = true;
    const entries = [...running.values()];
    running.clear();
    for (const entry of entries) {
      try {
        entry.controller.abort();
      } catch {
        // A hostile signal implementation must not break teardown.
      }
    }
    // Snapshot the jobs AFTER aborting: abort only schedules the runner's
    // settlement on the microtask queue, so no new job can be added.
    disposePromise = drainJobs([...jobs], disposeTimeoutMs);
    return disposePromise;
  }

  /**
   * Fire-and-forget background job. `run()` never throws (catch-all), its
   * completion always releases the running entry, and the promise stays in
   * `jobs` until the terminal write settles so `dispose()` can drain it.
   */
  function launchJob({ entry, key, sessionId, cwd, ticket }) {
    const job = run({ entry, key, sessionId, cwd, ticket });
    jobs.add(job);
    void job
      .finally(() => {
        jobs.delete(job);
        clearRunning(key, entry);
      })
      .catch(() => {
        // `run()` contains every failure; this catch is belt-and-braces so a
        // misbehaving `finally` cannot become an unhandled rejection.
      });
  }

  async function run({ entry, key, sessionId, cwd, ticket }) {
    let result;
    try {
      result = await runner.runAnalysis({
        sessionId,
        cwd,
        ticket,
        signal: entry.controller.signal,
        timeoutMs: analysisTimeoutMs,
      });
    } catch {
      result = { ok: false, code: 'analysis-failed' };
    }

    try {
      if (result?.ok === true) {
        await applyAnalysisResult(key, result.plan);
      } else {
        await applyAnalysisFailure(key, result?.code);
      }
    } catch {
      // The store/domain may already be closing (host unload). The analysis
      // outcome must never escape the background job; the ticket simply keeps
      // its current state and the next load can reconcile it.
    }
  }

  /** Apply a successful plan, or discard it when the ticket moved on. */
  async function applyAnalysisResult(key, plan) {
    const current = readTicket(key);
    if (current !== undefined && canApply(current, 'analysis_done').ok) {
      const applied = await store.applyAction(key, 'analysis_done', {
        plan,
        actor: 'agent',
      });
      if (applied?.ok === true) {
        await clearError(key);
        return;
      }
    }
    await rememberError(key, STALE_ANALYSIS_MESSAGE);
  }

  /**
   * Block the ticket and persist the static reason. `block` is legal from many
   * workflows (plan_review, fixing, ...), so a late failure is gated on the
   * ticket still being in `analyzing`: a ticket that already advanced must not
   * regress. In that case only the static error meta is recorded.
   */
  async function applyAnalysisFailure(key, runnerCode) {
    const reason = RUNNER_CODE_TO_REASON[runnerCode] ?? 'analysis-failed';
    const message = ANALYSIS_REASON_MESSAGES[reason] ?? ANALYSIS_REASON_MESSAGES['analysis-failed'];

    const current = readTicket(key);
    if (
      current !== undefined
      && current.workflow === 'analyzing'
      && canApply(current, 'block').ok
    ) {
      try {
        await store.applyAction(key, 'block', { reason, actor: 'system' });
      } catch {
        // A block that lost a race is not an error: the meta error below still
        // tells the user what happened, and the workflow stays untouched.
      }
    }
    await rememberError(key, message);
  }

  /** Persist one static error; the in-memory index is a status convenience. */
  async function rememberError(key, message) {
    errorCodes.add(key);
    try {
      await store.setMeta(ANALYSIS_ERROR_META_PREFIX + key, message);
    } catch {
      // Keep the in-memory entry: the running host can still show it.
    }
  }

  /** Clear a persisted error (meta `null`) after a successful transition. */
  async function clearError(key) {
    if (!errorCodes.has(key) && readPersistedError(key) === undefined) return;
    errorCodes.delete(key);
    try {
      await store.setMeta(ANALYSIS_ERROR_META_PREFIX + key, null);
    } catch {
      // The old error may still be persisted; re-index it for the snapshot.
      errorCodes.add(key);
    }
  }

  /** Read `meta['analysis.error:<code>']` as a non-empty string (or undefined). */
  function readPersistedError(key) {
    let value;
    try {
      value = store.getMeta(ANALYSIS_ERROR_META_PREFIX + key);
    } catch {
      return undefined;
    }
    if (typeof value !== 'string' || value === '') return undefined;
    errorCodes.add(key);
    return value;
  }

  function clearRunning(key, entry) {
    if (running.get(key) === entry) running.delete(key);
  }

  function readTicket(key) {
    let ticket;
    try {
      ticket = store.get(key);
    } catch {
      return undefined;
    }
    return isPlainObject(ticket) && typeof ticket.workflow === 'string' ? ticket : undefined;
  }

  function runnerAvailable() {
    if (typeof runner.available !== 'function') return true;
    try {
      return runner.available() === true;
    } catch {
      return false;
    }
  }

  /**
   * Action ids stay `analyze-<code>-<clock>` (and
   * `analyze-retry-<code>-<clock>` for a restart) as specified. A coarse
   * injected clock (same millisecond) would otherwise replay the store's
   * cached result of a previous action instead of running the state machine
   * again, so a collision within this instance gets a numeric suffix.
   */
  function nextActionId(prefix, key) {
    const base = `${prefix}-${key}-${readNow()}`;
    let actionId = base;
    while (usedActionIds.has(actionId)) {
      duplicateActionIdSuffix += 1;
      actionId = `${base}-${duplicateActionIdSuffix}`;
    }
    usedActionIds.add(actionId);
    return actionId;
  }

  return { start, status, dispose };
}

// ---------------------------------------------------------------------------
// Validation / helpers
// ---------------------------------------------------------------------------

function assertStore(store) {
  if (store === null || typeof store !== 'object') {
    throw new TypeError('createAnalysisService() requires an opened store');
  }
  for (const method of ['get', 'list', 'applyAction', 'getMeta', 'setMeta']) {
    if (typeof store[method] !== 'function') {
      throw new TypeError(`createAnalysisService() store.${method} must be a function`);
    }
  }
}

function assertRunner(runner) {
  if (runner === null || typeof runner !== 'object' || typeof runner.runAnalysis !== 'function') {
    throw new TypeError('createAnalysisService() requires a runner with runAnalysis()');
  }
}

/** Accept the host clock convention (function) and an object `{now()}`. */
function normalizeClock(clock) {
  if (typeof clock === 'function') {
    return () => {
      const value = clock();
      if (typeof value !== 'string' || value === '') {
        throw new TypeError('clock() 必须返回非空字符串');
      }
      return value;
    };
  }
  if (isPlainObject(clock) && typeof clock.now === 'function') {
    return () => {
      const value = clock.now();
      if (typeof value !== 'string' || value === '') {
        throw new TypeError('clock.now() 必须返回非空字符串');
      }
      return value;
    };
  }
  throw new TypeError('createAnalysisService() requires a clock function or {now()}');
}

function defaultClock() {
  return new Date().toISOString();
}

function positiveNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return undefined;
}

function normalizeCode(code) {
  if (typeof code !== 'string') return undefined;
  const trimmed = code.trim();
  return trimmed === '' ? undefined : trimmed;
}

function failure(code, message) {
  return { ok: false, code, message };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Wait for every job to settle, but never longer than `timeoutMs`. Used by
 * `dispose()` so a stuck runner cannot hang plugin unload: the timer is kept
 * referenced so the bounded promise always settles (an unref'd timer could let
 * an idle process drain the loop before it fires).
 *
 * @param {Promise<unknown>[]} pending job promises (already started)
 * @param {number} timeoutMs drain bound
 * @returns {Promise<void>}
 */
function drainJobs(pending, timeoutMs) {
  if (pending.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    Promise.allSettled(pending).then(finish, finish);
  });
}
