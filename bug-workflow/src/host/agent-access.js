/**
 * Dependency-injected analysis-agent runner for the bug workflow (P3 Task 1).
 *
 * The module is the only place that talks to the DSH delegation seam. It is
 * pure logic over injected services (`{ get(name) }`), so the plain-Node test
 * runner can exercise it without a live host. No bare package import and no
 * host state: everything below is deterministic except `Date.now()` and the
 * timeout timer.
 *
 * Live contract (DSH 0.2.2-rc.1; P0 findings Spike D + installed
 * `@deepseek-ai/dsh-subagent` / `dsh-agent` READMEs):
 *
 *   - The public `Agent` is `{ readonly id: SessionId }`: the shared
 *     Agent/Session id is `agent.id` (there is no public `agent.session`
 *     field). `ctx.agents.get/list/roots` return live agents only.
 *   - `ctx.subagents.startActivation(spec)` takes
 *     `{ provider, label, request, signal, delivery }`:
 *       - `signal` is REQUIRED and only cancels pre-publication work. Once the
 *         activation is published, `activation.dispose()` is the cancellation
 *         primitive;
 *       - `request.prompt` is a `ContentBlock[]` (not a string), so the prompt
 *         is sent as `[{ type: 'text', text }]`;
 *       - `request.parent` must be the exact live Agent;
 *       - `delivery: 'caller'` sends no parent completion notice.
 *   - The activation is `{ childId, messageId?, result, dispose }` and
 *     `result` resolves to `SubagentResult`
 *     `{ output: ContentBlock[], structured?, diagnostic?, stopReason }`.
 *
 * Design:
 *
 *   - `resolveParent()` prefers the listed agent whose `id` equals the requested
 *     session id, then falls back to the last live root. It returns `null` on
 *     any missing/broken service shape instead of throwing.
 *   - `runAnalysis()` composes the caller's `signal` with an internal timeout
 *     controller. Abort is raced against both `startActivation()` and
 *     `result`, so a hanging child settles the caller instead of leaking the
 *     promise; `dispose()` is always called (fire-and-forget, its failures are
 *     contained).
 *   - Every failure is `{ ok:false, code, message }` with a static Chinese
 *     message. Child errors, diagnostics, and stacks never reach the caller.
 *   - The result text is parsed strictly (the first parseable balanced JSON
 *     object, fenced or embedded) and validated field-by-field. Invalid output
 *     is never guessed into a plan: it becomes `analysis-bad-output`.
 *   - A child that does not finish cleanly (`stopReason` other than
 *     `'completed'`) is a failure even when its text looks parseable.
 */

/** Default analysis budget (matches the P3 plan: about ten minutes). */
export const DEFAULT_ANALYSIS_TIMEOUT_MS = 600_000;

/** Maximum number of characters of the ticket description in the prompt. */
export const DESCRIPTION_LIMIT = 4_000;

const ACTIVATION_PROVIDER = 'spawn';
const ACTIVATION_DELIVERY = 'caller';

const MESSAGE = Object.freeze({
  unavailable: '当前没有可用的会话 Agent',
  timeout: '分析超时，请重试',
  failed: '分析子代理执行失败，请重试',
  badOutput: '分析结果格式不正确，请重试',
});

/** ```json … ``` fence (preferred when present; fenced output is tolerated). */
const JSON_FENCED_BLOCK_RE = /```[ \t]*json[ \t]*\r?\n?([\s\S]*?)```/i;

/** Any other ``` fence, kept as a fallback for unlabelled/labelled output. */
const ANY_FENCED_BLOCK_RE = /```[ \t]*(?:javascript|js)?[ \t]*\r?\n?([\s\S]*?)```/i;

/** Plan fields that must be non-empty strings. */
const NONEMPTY_STRING_FIELDS = Object.freeze(['summary', 'rootCause', 'approach']);

/**
 * Plan fields that must be strings but may be empty. Domain v2 declares
 * `testPlan: z.string()`, so the model is allowed to return `''`.
 */
const ALLOW_EMPTY_STRING_FIELDS = Object.freeze(['testPlan']);

/** Plan fields the model must fill with an array of strings. */
const STRING_ARRAY_FIELDS = Object.freeze(['changedFiles', 'risks']);

/** Sentinel rejection used by `raceWithAbort`; the trigger lives in `abortCause`. */
const RUN_ABORTED = Symbol('analysis-run-aborted');

/**
 * Create the analysis runner.
 *
 * @param {{services?: {get: (name: string) => unknown}}} [options]
 *   `services.get` resolves a live Cordis service by name (`ctx.get(name)`).
 *   A missing or throwing registry simply makes every entry point degrade.
 * @returns {{
 *   available: () => boolean,
 *   resolveParent: (sessionId: string) => object | null,
 *   runAnalysis: (input: object) => Promise<object>,
 * }}
 */
export function createAgentRunner(options = {}) {
  const services = isPlainObject(options) ? options.services : undefined;

  /** Resolve one injected service; broken registries degrade to `undefined`. */
  function service(name) {
    if (!isPlainObject(services) || typeof services.get !== 'function') return undefined;
    try {
      return services.get(name);
    } catch {
      return undefined;
    }
  }

  /** True when both delegation services expose the methods this runner uses. */
  function available() {
    const subagents = service('subagents');
    const agents = service('agents');
    return isObjectLike(subagents)
      && typeof subagents.startActivation === 'function'
      && isObjectLike(agents)
      && typeof agents.list === 'function';
  }

  /**
   * Resolve the exact live parent Agent for a session id.
   *
   * Preference order: `agents.list()` entry with `agent.id === sessionId`, then
   * the last live root from `agents.roots()`. A malformed agent entry is never
   * returned, and a broken/absent service yields `null` rather than throwing.
   *
   * @param {string} sessionId shared Agent/Session id of the requesting session
   * @returns {object | null} live Agent (`{id}`) or null
   */
  function resolveParent(sessionId) {
    const agents = service('agents');
    if (!isObjectLike(agents)) return null;

    const wanted = normalizeText(sessionId);
    if (wanted !== undefined && typeof agents.list === 'function') {
      let listed;
      try {
        listed = agents.list();
      } catch {
        listed = undefined;
      }
      if (Array.isArray(listed)) {
        for (const agent of listed) {
          if (isLiveAgent(agent) && agent.id === wanted) return agent;
        }
      }
    }

    if (typeof agents.roots === 'function') {
      let roots;
      try {
        roots = agents.roots();
      } catch {
        roots = undefined;
      }
      if (Array.isArray(roots)) {
        for (let index = roots.length - 1; index >= 0; index -= 1) {
          if (isLiveAgent(roots[index])) return roots[index];
        }
      }
    }

    return null;
  }

  /**
   * Run one read-only analysis subagent and parse its plan.
   *
   * @param {object} input
   * @param {string} input.sessionId live parent session id
   * @param {string} [input.cwd] workspace path handed to the child
   * @param {object} input.ticket Ticket used to render the prompt (never mutated)
   * @param {number} [input.timeoutMs] analysis budget (default 10 minutes)
   * @param {AbortSignal} [input.signal] caller cancellation
   * @returns {Promise<
   *   {ok: true, plan: object, childId: string, elapsedMs: number}
   *   | {ok: false, code: string, message: string}
   * >}
   */
  async function runAnalysis(input = {}) {
    const options = isPlainObject(input) ? input : {};
    if (!available()) return failure('analysis-unavailable', MESSAGE.unavailable);

    const ticket = options.ticket;
    const cwd = normalizeText(options.cwd);
    const parent = resolveParent(options.sessionId);
    if (parent === null) return failure('analysis-unavailable', MESSAGE.unavailable);

    // Re-read the subagents service after resolution: availability can change
    // between the initial check and the actual start.
    const subagents = service('subagents');
    if (!isObjectLike(subagents) || typeof subagents.startActivation !== 'function') {
      return failure('analysis-unavailable', MESSAGE.unavailable);
    }

    const startedAt = Date.now();
    const timeoutMs = positiveNumber(options.timeoutMs) ?? DEFAULT_ANALYSIS_TIMEOUT_MS;
    const promptText = buildAnalysisPrompt(ticket, cwd);
    const label = `analysis:${ticketCode(ticket) || 'unknown'}`;

    const controller = new AbortController();
    let abortCause = null;
    const abortWith = (cause) => {
      if (abortCause !== null) return;
      abortCause = cause;
      controller.abort();
    };

    const timer = setTimeout(() => abortWith('timeout'), timeoutMs);

    const callerSignal = options.signal;
    let callerListenerAttached = false;
    const onCallerAbort = () => abortWith('caller');
    if (callerSignal !== undefined && callerSignal !== null) {
      if (callerSignal.aborted === true) {
        abortWith('caller');
      } else if (typeof callerSignal.addEventListener === 'function') {
        callerSignal.addEventListener('abort', onCallerAbort, { once: true });
        callerListenerAttached = true;
      }
    }

    const request = { prompt: [{ type: 'text', text: promptText }], parent };
    if (cwd !== undefined) request.cwd = cwd;

    let activation;
    let finished = false;
    try {
      if (abortCause !== null) {
        return abortCause === 'timeout'
          ? failure('analysis-timeout', MESSAGE.timeout)
          : failure('analysis-failed', MESSAGE.failed);
      }

      // `startActivation` may throw synchronously or reject; both are startup
      // failures. Racing it also covers a start call that never settles.
      const starting = Promise.resolve().then(() =>
        subagents.startActivation({
          provider: ACTIVATION_PROVIDER,
          label,
          request,
          signal: controller.signal,
          delivery: ACTIVATION_DELIVERY,
        }),
      );
      // An abort can win the race while the start call is still settling. Keep
      // the activation reference anyway so it is always disposed; if the run
      // already finished, dispose it from this late handler instead. Disposal
      // also observes `activation.result`, so a late result rejection cannot
      // become an unhandled rejection after the run returned.
      starting.then(
        (value) => {
          if (finished) disposeQuietly(value);
          else activation = value;
        },
        () => {},
      );
      activation = await raceWithAbort(starting, controller.signal);
      if (!isObjectLike(activation)
        || typeof activation.childId !== 'string'
        || activation.childId.trim() === '') {
        return failure('analysis-failed', MESSAGE.failed);
      }
      if (activation.result === undefined || activation.result === null) {
        return failure('analysis-failed', MESSAGE.failed);
      }

      const settled = await raceWithAbort(Promise.resolve(activation.result), controller.signal);
      // A child that aborted, errored, hit the token cap, or refused never
      // produced a trustworthy plan: never parse its (possibly partial) output
      // as a success. A missing stopReason is tolerated for robustness (bare
      // string fakes), but every present non-completed value is a failure.
      if (isObjectLike(settled)
        && typeof settled.stopReason === 'string'
        && settled.stopReason !== 'completed') {
        return failure('analysis-failed', MESSAGE.failed);
      }
      const plan = validatePlan(extractJsonPlan(extractResultText(settled)));
      if (plan === null) return failure('analysis-bad-output', MESSAGE.badOutput);

      return {
        ok: true,
        // Keep the model's extra keys and stamp the generation time as an ISO
        // string: domain v2 declares `generatedAt: z.string().nullable()` and
        // `analysis_done` copies this value straight into the stored plan.
        plan: { ...plan, generatedAt: new Date().toISOString() },
        childId: activation.childId,
        elapsedMs: Date.now() - startedAt,
      };
    } catch {
      if (abortCause === 'timeout') return failure('analysis-timeout', MESSAGE.timeout);
      return failure('analysis-failed', MESSAGE.failed);
    } finally {
      finished = true;
      clearTimeout(timer);
      if (callerListenerAttached) {
        try {
          callerSignal.removeEventListener('abort', onCallerAbort);
        } catch {
          // A hostile/frozen signal must not break cleanup.
        }
      }
      disposeQuietly(activation);
    }
  }

  return { available, resolveParent, runAnalysis };
}

/**
 * Render the analysis prompt. Exported so tests can assert the contract
 * directly (ticket fields, workspace, read-only rules, JSON output schema).
 *
 * The description is truncated to `DESCRIPTION_LIMIT` characters (counted as
 * Unicode code points, so astral characters count once). The ticket is only
 * read; it is never mutated.
 *
 * @param {object} ticket Ticket-like record (`code/title/type/status/version/platform`)
 * @param {string} [cwd] workspace path handed to the child; `cwd` is optional
 *   and defaults to a neutral "current session workspace" label
 * @returns {string} Chinese prompt
 */
export function buildAnalysisPrompt(ticket, cwd) {
  const source = isPlainObject(ticket) ? ticket : {};
  const description = ticketDescription(source).trim();
  const truncated = truncateText(description, DESCRIPTION_LIMIT);
  const workspace = normalizeText(cwd) ?? '当前会话工作区';

  const lines = [
    '你是本工作区的只读分析子代理。请阅读工单与相关代码，定位问题根因并给出可执行的修复方案。',
    '',
    '## 工单',
    `- 编号：${displayValue(source.code)}`,
    `- 标题：${displayValue(source.title)}`,
    `- 类型：${displayValue(source.type)}`,
    `- 状态：${displayValue(source.status)}`,
    `- 版本：${displayValue(source.version)}`,
    '- 描述：',
    truncated.text === '' ? '（无描述）' : truncated.text,
  ];
  if (truncated.truncated) lines.push(`（描述超过 ${DESCRIPTION_LIMIT} 字符，已截断）`);

  lines.push(
    '',
    '## 工作区',
    `- 路径：${workspace}`,
    '- 请在该工作区中读取代码、配置与测试；引用文件时使用相对路径。',
    '',
    '## 只读约束（必须遵守）',
    '- 不得修改、创建或删除任何文件，不得向工作区写入内容。',
    '- 不得执行破坏性命令，例如 git commit/push/reset、rm、格式化或安装依赖。',
    '- 只允许读取、搜索以及必要的只读命令。',
    '',
    '## 输出要求',
    '只输出一个 JSON 对象，不要输出 Markdown 代码围栏、解释或其它任何文字。JSON 字段：',
    '{',
    '  "summary": "修复方案摘要",',
    '  "rootCause": "问题根因",',
    '  "approach": "修复方案与步骤",',
    '  "changedFiles": ["需要修改的文件相对路径"],',
    '  "risks": ["风险与注意事项"],',
    '  "testPlan": "测试与验证建议"',
    '}',
  );

  return lines.join('\n');
}

/**
 * Extract the first parseable balanced `{...}` JSON object from model output.
 *
 * Handles ```json fenced blocks (the fence is preferred when present), leading
 * or trailing prose, and braces inside JSON strings. Malformed balanced objects
 * are skipped and the search continues, so an invalid example before the real
 * plan does not hide it. The first object that parses as a plain JSON object is
 * returned; output without one yields `null` (never throws).
 *
 * @param {string} text raw child text
 * @returns {object | null}
 */
export function extractJsonPlan(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const fenced = JSON_FENCED_BLOCK_RE.exec(trimmed) ?? ANY_FENCED_BLOCK_RE.exec(trimmed);
  const candidates = fenced === null ? [trimmed] : [fenced[1], trimmed];
  for (const candidate of candidates) {
    for (const json of balancedObjects(candidate)) {
      try {
        const parsed = JSON.parse(json);
        if (isPlainObject(parsed)) return parsed;
      } catch {
        // A malformed object must not hide a valid one later in the text.
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Race `promise` against an AbortSignal. The abort path rejects with a private
 * sentinel; the caller maps it from `abortCause` (timeout vs caller abort).
 *
 * When the signal is already aborted, the race is lost before it starts, but
 * the raced promise still gets an inert rejection observer: its result may
 * reject later (abort between start resolution and the result race) and must
 * never surface as an unhandled rejection.
 */
function raceWithAbort(promise, signal) {
  if (signal.aborted) {
    observeQuietly(promise);
    return Promise.reject(RUN_ABORTED);
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(RUN_ABORTED);
    };
    function cleanup() {
      signal.removeEventListener('abort', onAbort);
    }

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** Extract text from `SubagentResult.output` (blocks/string) or a bare value. */
function extractResultText(result) {
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return joinBlockText(result);
  if (!isObjectLike(result)) return '';

  if (typeof result.output === 'string') return result.output;
  if (Array.isArray(result.output)) {
    const text = joinBlockText(result.output);
    if (text.trim() !== '') return text;
  }
  if (typeof result.text === 'string') return result.text;
  // Defensive: the runner does not request `outputSchema`, but a child that
  // reports structured output should still be parseable rather than dropped.
  if (isPlainObject(result.structured)) return JSON.stringify(result.structured);
  return '';
}

/** Join the text blocks of a `ContentBlock[]`; non-text blocks are skipped. */
function joinBlockText(blocks) {
  const texts = [];
  for (const block of blocks) {
    if (typeof block === 'string') {
      texts.push(block);
      continue;
    }
    if (!isPlainObject(block) || typeof block.text !== 'string') continue;
    if (block.type !== undefined && block.type !== 'text') continue;
    texts.push(block.text);
  }
  return texts.join('\n');
}

/**
 * Validate the plan contract. Extra keys are preserved (the caller spreads the
 * object), but the six required fields must be present and well typed.
 * `testPlan` may be an empty string (domain v2 allows it).
 */
function validatePlan(candidate) {
  if (!isPlainObject(candidate)) return null;

  for (const field of NONEMPTY_STRING_FIELDS) {
    if (typeof candidate[field] !== 'string' || candidate[field].trim() === '') return null;
  }
  for (const field of ALLOW_EMPTY_STRING_FIELDS) {
    if (typeof candidate[field] !== 'string') return null;
  }
  for (const field of STRING_ARRAY_FIELDS) {
    const values = candidate[field];
    if (!Array.isArray(values)) return null;
    if (!values.every((value) => typeof value === 'string')) return null;
  }
  return candidate;
}

/** Yield every balanced `{...}` substring of `source`, in order. */
function* balancedObjects(source) {
  if (typeof source !== 'string') return;
  let from = 0;
  while (from < source.length) {
    const found = firstBalancedObject(source, from);
    if (found === null) return;
    yield found.text;
    from = found.end;
  }
}

/**
 * Find the first balanced object substring at or after `fromIndex`, returning
 * `{ text, end }` so the caller can continue with the next object.
 */
function firstBalancedObject(source, fromIndex = 0) {
  if (typeof source !== 'string') return null;
  const start = source.indexOf('{', fromIndex);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      depth += 1;
      continue;
    }
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return { text: source.slice(start, index + 1), end: index + 1 };
    }
  }
  return null;
}

/** Ticket description: the local field first, then the platform snapshot. */
function ticketDescription(ticket) {
  if (typeof ticket.description === 'string' && ticket.description.trim() !== '') {
    return ticket.description;
  }
  if (isPlainObject(ticket.platform) && typeof ticket.platform.description === 'string') {
    return ticket.platform.description;
  }
  return '';
}

function ticketCode(ticket) {
  if (!isPlainObject(ticket)) return '';
  return normalizeText(ticket.code) ?? '';
}

/** Truncate to `limit` Unicode code points. */
function truncateText(value, limit) {
  const characters = Array.from(value);
  if (characters.length <= limit) return { text: value, truncated: false };
  return { text: characters.slice(0, limit).join(''), truncated: true };
}

/** Render one required ticket field, keeping the prompt readable when absent. */
function displayValue(value) {
  return normalizeText(value) ?? '（未提供）';
}

/** Non-blank string (trimmed) or finite number, as a trimmed string. */
function normalizeText(value) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function positiveNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return undefined;
}

function failure(code, message) {
  return { ok: false, code, message };
}

/**
 * Call the activation disposer without letting cleanup alter the outcome.
 *
 * Cleanup means the runner will not consume `result` on this path, so the
 * result promise is observed first: a late rejection (a child that settles
 * after an abort) must not become an unhandled rejection.
 */
function disposeQuietly(activation) {
  if (!isObjectLike(activation)) return;
  observeResultQuietly(activation);
  if (typeof activation.dispose !== 'function') return;
  try {
    const pending = activation.dispose();
    if (pending !== null && typeof pending === 'object' && typeof pending.catch === 'function') {
      pending.catch(() => {});
    }
  } catch {
    // Cleanup failures are deliberately contained: the analysis result stands.
  }
}

/** Attach an inert rejection handler to `activation.result` when present. */
function observeResultQuietly(activation) {
  try {
    observeQuietly(activation.result);
  } catch {
    // A throwing result getter must not break cleanup.
  }
}

/** Attach an inert rejection handler to a promise-like value (never throws). */
function observeQuietly(value) {
  if (value === null || typeof value !== 'object') return;
  try {
    if (typeof value.catch === 'function') value.catch(() => {});
  } catch {
    // A hostile thenable must not break cancellation.
  }
}

/** A live Agent must at least expose its non-empty shared Agent/Session id. */
function isLiveAgent(agent) {
  return isObjectLike(agent) && typeof agent.id === 'string' && agent.id !== '';
}

function isObjectLike(value) {
  return value !== null && typeof value === 'object';
}

function isPlainObject(value) {
  return isObjectLike(value) && !Array.isArray(value);
}
