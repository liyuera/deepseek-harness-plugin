# 实施计划：code-review 异步审查（v2）

规格：`docs/superpowers/specs/2026-11-09-code-review-design.md` §17（异步审查 v2）。
现状基线：`main@26577dc`，`code-review/` 127/127 测试绿，插件已装进 desktop profile（v1 同步模式）。

## 目标

`agent/turn-stopping` 不再同步等待审查：只做门禁/预检/取材/去重/发起 `startActivation`，立刻返回；审查者在后台跑，结算后：
- 有 blocking findings → `agent.followup()` 注入（plugin 来源消息，开新 turn 让主代理修）；
- 无 blocking → 静默；
- 失败/超时 → 静默 + 熔断计数。

轮次从「每 turn」改为「每链」：`maxRounds` 是每条链上限；只有**人类消息**重置链；同链内容指纹去重；单会话同时在途审查至多一个。

## 任务拆分

- **Task A（config + loop）**：新增 `asyncReviewerTimeoutMs`；`loop.js` 轮次改为按 session 的链计数 + 锁。
- **Task B（reviewer）**：新增异步 `startReview`（`{childId, result, cancel}`）；保留 `runReview` 给 `/review` 同步路径。
- **Task C（index 接线）**：异步发起/结算/followup 注入/链重置/session 清理；重写 `test/index.test.js`。
- **Task D（文档 + E2E）**：README/spec 对齐；headless 真实会话验收「turn 不再被阻塞 + 结论在新 turn 回灌 + 复审静默 + 无第三次」。

A、B 文件不相交可并行；C 依赖 A+B；D 最后由控制器做（或交给一个 agent，但 E2E 由控制器复核）。

---

## Task A：配置与链式轮次

**文件（只改这些）**：`code-review/src/host/config.js`、`code-review/src/host/loop.js`、`code-review/test/config.test.js`、`code-review/test/loop.test.js`

### A1 配置

`DEFAULTS` 增加 `asyncReviewerTimeoutMs: 600000`；在 `resolveConfig` 里按 `assertPositiveInteger('asyncReviewerTimeoutMs', merged.asyncReviewerTimeoutMs)` 校验；返回值里带上该字段（保持冻结）。README 由 Task D 改。

测试：默认值 600000；传 `0`/`-1`/`1.5`/`'600000'` 均抛 `code-review: asyncReviewerTimeoutMs must be a positive integer`；传合法值被采用。

### A2 loop 新语义（破坏性）

```js
createTracker({ cooldownMs, now }) → {
  begin(sessionId) -> boolean      // 已在本会话审查中→false；否则加锁并把链轮次 +1
  end(sessionId)                   // 释放锁（无论成败）
  roundsOf(sessionId) -> number    // 当前链已自动审几次
  resetRounds(sessionId)           // 人类消息：只清轮次（锁/failures 不动）
  isReviewing(sessionId) -> boolean
  recordFailure(sessionId) -> boolean
  recordSuccess(sessionId)
  isBreakerOpen(sessionId) -> boolean
  forget(sessionId)                // 清轮次/锁/失败状态
}
```

- 删除 `(sessionId, turn)` 二元 key、`roundsOf(sessionId, turn)`、`abandonRound`。
- `begin` 在已锁时返回 false 且**不**增加轮次。
- `forget` 必须清 `rounds`、`reviewing`、`failures`。
- 熔断逻辑（阈值 2、冷却 5 分钟、半开、`now` 注入）保持不变。

测试（`loop.test.js` 重写轮次相关用例，保留熔断 6 例）：`begin` 计数 1→2；`resetRounds` 归零但锁仍在；`end` 后 `isReviewing=false`；重复 `begin` 不增轮；`forget` 清空全部；熔断用例保持。

**验证**：`cd code-review && node --test test/config.test.js test/loop.test.js` 绿；全量 `node --test` 中仅 `test/index.test.js`/`test/trigger.test.js` 可能因接口变化报错——**不要**改它们（Task C 负责），报告里注明即可。

**提交**：`fix(code-review): 配置增加异步审查超时，轮次改为按会话链计数`

## Task B：reviewer 异步接口

**文件（只改这些）**：`code-review/src/host/reviewer.js`、`code-review/test/reviewer.test.js`

### B1 抽出校验

把 `normalizeFinding` 之后的「stopReason/structured/findings 校验、丢弃计数、全丢→invalid-result」抽成内部函数 `validateStructured(structured, { allowedRuleIds, allowedPaths, ruleSeverities, logger })`，返回 `{ok:true,findings}` / `{ok:false,reason}`。`runReview` 改为复用它（行为与错误码必须保持不变，现有测试全绿）。

### B2 新增 `startReview`

```js
/**
 * 异步发起一次审查，不等待结果。
 * @returns {{childId: string, result: Promise<{ok:true,findings:object[]}|{ok:false,reason:string}>, cancel(reason?: string): void}}
 */
export async function startReview({
  subagents, agent, preset, prompt, signal, modelOverride,
  allowedRuleIds, allowedPaths, ruleSeverities, logger,
})
```

- 内部 `AbortController`；`startActivation({ delivery:'caller', signal: controller.signal, ... })`（`provider:'spawn'`、`label:'code-review'`、`request.outputSchema = REVIEW_SCHEMA`、`agentOptions = modelOverride`、`request.parent = agent`）。
- `result` promise：等 `activation.result` → `validateStructured`；`activation.result` 拒绝或抛错 → `{ok:false, reason:'provider-error'}`。`cancel(reason)` 一旦被调用，`result` 以 `{ok:false, reason}` resolve（默认 `'cancelled'`），并 best-effort `controller.abort()` + `dispose()`；`cancel` 幂等。
- `signal`（可选，父级取消）aborted 时等价于 `cancel('aborted')`。
- `startActivation` 本身抛错时直接 reject（由调用方 catch 记失败）——**不要**吞。
- 若在 `startActivation` 返回前已 `cancel`，拿到 activation 后立刻 dispose 并以 reason resolve。

测试（新增，别删旧用例）：cancel 后 result 为 `{ok:false,reason}` 且 dispose 被调用一次；父 signal abort 同理；正常完成返回 findings 且 severity 覆盖逻辑仍生效；`activation.result` reject → provider-error；`startActivation` 抛错 → startReview reject。

**验证**：`cd code-review && node --test test/reviewer.test.js` 绿；全量 `node --test` 仅允许 `index.test.js` 报接口错误。

**提交**：`feat(code-review): reviewer 支持异步发起与取消（startReview）`

## Task C：index 异步接线

**文件**：`code-review/index.js`、`code-review/test/index.test.js`（重写）。可调整 `test/command.test.js` 仅当接口变化导致失败。

### C1 行为

```js
export const inject = [..., 'agents']   // 增加 agents（校验 agent 仍存活）

const lifetime = new AbortController()
const inflight = new Map()        // sessionId -> { cancel }
const lastFingerprint = new Map() // sessionId -> hash（同链去重）
```

- `apply` 里 `ctx.effect(() => () => { lifetime.abort(); for (const h of inflight.values()) h.cancel('plugin-disposed'); inflight.clear() })`。
- 注入消息 source：`{ kind: 'plugin', plugin: 'code-review' }`。
- `session/event`：
  - `workspace/changes` → `latestSeq`（不变）；
  - `user/message` 且 `event.data?.source?.kind === 'user'` → `tracker.resetRounds(sessionId)` + `lastFingerprint.delete(sessionId)`（人类消息开新链）。
- `session/disposed`：取消该会话在途审查、清 `latestSeq/lastFingerprint`、`tracker.forget`（不变的部分保留）。
- `turn-stopping`：
  1. 门禁（`rounds = tracker.roundsOf(sessionId)`，其余同 v1）。
  2. 摘要预检（保留 `summary.turn === turn`）。
  3. `collect(..., signal)`；空 → debug + return（**不占轮**）。
  4. 指纹去重：`fingerprint(files) === lastFingerprint.get(sessionId)` → debug `duplicate-diff` + return（不占轮）。
  5. `if (!tracker.begin(sessionId)) return`；`rounds = tracker.roundsOf(sessionId)`；`lastRound = rounds >= resolved.maxRounds`。
  6. `rules = await getRules()`；`const handle = await startReview({ ..., signal: lifetime.signal, allowed*: rules.* })`；失败 catch → debug + `recordFailure` + `tracker.end`。
  7. `inflight.set(sessionId, handle)`；`const timer = setTimeout(() => handle.cancel('timeout'), resolved.asyncReviewerTimeoutMs)`。
  8. `handle.result.then(outcome => settle(...))`，**不等**它。
- `settle(outcome)`（async，自己捕错）：
  - `clearTimeout(timer)`、`inflight.delete`、`tracker.end(sessionId)`；
  - `outcome.ok === false`：debug `review failed: ${reason}`；`if (tracker.recordFailure(sessionId)) warn('连续失败…')`；return；
  - `outcome.ok`：`tracker.recordSuccess`、`lastFingerprint.set(sessionId, hash)`、debug 指标（rounds/files/findings/skipped/elapsed）；
  - 渲染 `renderFindings({..., mode:'steer'})`；`text === ''` → 静默 return（v2 不注入通过）；
  - 注入前 `const live = ctx.get('agents')?.get(sessionId)`；`live !== agent` → debug `drop` return；
  - 修复要求文案按 `lastRound` 分支（末轮：「本轮已达到自动复审上限，修完不会再自动复审，请人工确认。如与用户新指令冲突，以用户指令为准。」）。
  - `try { live.followup(message(`${text}\n\n${repair}`)) } catch (e) { warn }`。
- 保留 `/review` 注册与 `isReviewing` 依赖（command 仍用 `runReview` 同步）。`reviewerTimeoutMs` 只传给 command 路径。

### C2 index 测试（重写 `test/index.test.js`，假 ctx 扩展）

假 ctx 需要：`tools.guard`、`commands.register`、`logger`、`on`、`workspaceChanges`、`subagents.startActivation`（返回可控 `{childId, result: Promise, dispose(){}}`）、`get('agents')` 返回 `{ get(id) }`（默认返回本次 agent）。假 agent 加 `followup(message)` 记录。

必须覆盖：
1. **不阻塞**：turn-stopping 的 promise 在审查结果 resolve **之前**就已返回（用未 resolve 的 activation.result，await handler 后断言行已结束且 `state.follows` 为空）。
2. **回灌**：result 为 1 条 `COR-001/high` → `followup` 收到 1 条，文本含 `结论: 需修改`、含 `修完会再复审一次`；`message.source.kind === 'plugin'`。
3. **通过静默**：findings 为空 → 无 followup、无 steer。
4. **链预算**：maxRounds=2，连续三轮 stopping（每轮 diff 文本不同）：第 1、2 轮各发起 1 次；第 3 轮不发起；第 2 次注入含 `不会再自动复审`。
5. **人类消息重置**：第 4 轮前灌入 `user/message`（source.kind='user'）→ 再 stopping 能重新发起。
6. **去重**：同 diff 两次 stopping → 只发起 1 次，第二次 debug `duplicate-diff`。
7. **失败熔断**：两次 `{ok:false,reason:'timeout'}` → 第三次门禁 `breaker-open` 不发起。
8. **agent 已关闭**：`get('agents')` 返回 undefined → 不 followup 不抛。
9. **session disposed**：在途审查被 `cancel`（dispose 调用一次）。
10. **异步超时**：`asyncReviewerTimeoutMs: 20`，activation.result 永不 resolve → 等待 50ms 后 `cancel('timeout')` 被调用（dispose 一次），且不注入。
11. **末轮文案**（maxRounds=1）→ 注入含 `不会再自动复审`。
12. 指标 debug 含 `reviewed`（rounds/files/findings/skipped/elapsed）。

**验证**：`cd code-review && node --test` **全绿**（127 → 约 135+；数字以实际为准）；`git diff --check` 干净。

**提交**：`feat(code-review): 自动审查改为异步发起与结果回灌`

## Task D：文档与 E2E（控制器执行）

- README：机制改异步、配置表加 `asyncReviewerTimeoutMs`、`maxRounds` 语义改「每条链」、已知限制（结论晚一个 turn、通过静默、plugin 来源消息）。
- E2E（headless + patch + 真模型，临时仓库）：
  1. turn 结束耗时明显下降（不再包含审查）；
  2. 审查结论在**新 turn** 出现（`结论: 需修改`），agent 自动修复；
  3. 复审通过时**无**注入（静默）；
  4. 无第三次自动审查（链预算生效）；
  5. `git status` 仅主代理改动。
- 全量复查后合并 `feat/code-review-async` → `main`。

## 全局约束

- 只改上表登记的文件；A、B 并行时**不要**碰 `index.js` 与 `test/index.test.js`。
- TDD：先写/改测试，确认 RED，再实现，GREEN 后跑全量。
- 不引新依赖；`package.json` 不动。
- 提交信息用中文、一行；报告写 `.superpowers/sdd/task-*-report.md`（gitignored）。
