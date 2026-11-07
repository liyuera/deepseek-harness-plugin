/**
 * Bug workflow board - client half.
 *
 * Self-contained React rendered into the right sidebar tab
 * (`sidebar.right.pane.tab`, keyed by the tab type id). The only module imported
 * from the client module table is `react`; every style references a
 * `--dsw-alias-*` theme token (with an `inherit`/`transparent` fallback) and no
 * DOM is touched outside React.
 *
 * Data flow:
 *   - `usePolling(snapshotUrl, POLL_INTERVAL_MS)` reads `GET /bug-workflow/api/snapshot`
 *     and ignores stale/aborted responses; unmount stops the timer.
 *   - every write goes through `POST /bug-workflow/api/action` with
 *     `Content-Type: application/json`, a fresh idempotency `actionId`, and a
 *     confirmation. `window.confirm` is used when available; when it is absent
 *     the board renders its own confirm panel instead of silently proceeding.
 *     `reject_plan` always uses the inline reason input (Electron disables the
 *     platform prompt API). Every mutation is gated on the snapshot's
 *     `workspace.configured === true`. A rejected action (409/415/403/500) shows
 *     a retryable banner with the server `code` and `message`; nothing throws out
 *     of the slot.
 *   - workspace settings open as an in-panel overlay (Esc closes, focus returns
 *     to the header button) and save with `POST /bug-workflow/api/settings`.
 *     The host binds settings to the session's workspace cwd, so when the
 *     snapshot reports `workspace.configured === false` the panel still opens
 *     read-only with the save button disabled and an explicit hint.
 *   - the same panel carries a 「平台连接」 section: the platform base URL, the
 *     project-code prefix and a write-only token field. The token is POSTed to
 *     `/bug-workflow/api/platform-token` (`{sessionId, token}`) and cleared with
 *     `{token:null}`; the status dot follows `snapshot.platform.tokenPresent`,
 *     and the value is never rendered back (the input is cleared on success).
 *     Saving the token also persists a dirty settings draft first (and aborts
 *     the token save if that validation/POST fails), so a user who edited the
 *     platform base URL cannot end up with a token bound to the old URL.
 *     `writebackStatus` is a boolean switch the panel only persists today (P5
 *     will use it).
 *   - the header 「同步」 button POSTs `/bug-workflow/api/sync` (`{sessionId}`),
 *     reports `已同步：新增 X / 更新 Y`, and is disabled with a reason when the
 *     session lacks a workspace or the platform token. `snapshot.platform` also
 *     carries the last sync time and the host's static last error.
 *   - P3 real analysis: `start_analysis` (and the board-only 「重新分析」 button)
 *     POSTs `/bug-workflow/api/analyze` (`{sessionId, code}`) instead of the
 *     legacy `/action` route. A 200 is treated only as "the request was
 *     accepted" — progress comes from the polled `snapshot.analysis.running`
 *     set, because an orphaned `analyzing` ticket with no live agent can still
 *     answer 200 and block moments later. A 503 on this route only means the
 *     analysis service is unavailable (unwired host / missing subagents or
 *     agents services), never "no live Agent". The detail view therefore shows the
 *     「AI 分析中…」 elapsed timer only while the code is in that set, and an
 *     interrupted notice plus 「重新分析」 when it is not (the host restarts
 *     orphaned and blocked-from-analyzing tickets through the same route).
 *     `snapshot.analysis.errors[code]` / `blockedReason` are rendered as static
 *     copy only for analysis-related blocks (never on tickets that already moved
 *     on, where a stale persisted error may survive).
 *   - P4 real fix: `start_fix` is a board-only descriptor (never in
 *     `ACTION_BY_STATE`) rendered by the detail view's `FixNotice`. It POSTs
 *     `/bug-workflow/api/fix` (`{sessionId, code}`) for the approved-plan
 *     start, the orphaned-`fixing` restart and the blocked-from-fixing retry
 *     (the host restarts/retries through the same route; no `/action retry`).
 *     A 200 only means "accepted": the `AI 修复中…` timer is shown only while
 *     `snapshot.fix.running` contains the code. Otherwise the panel offers
 *     「开始修复」/「重新修复」; a fix-related block renders the static
 *     `FIX_REASON_LABELS` copy and the host detail from
 *     `snapshot.fix.errors[code]` (preferred over an older `blockedReason`).
 *     The demo `fix_done` button is hidden for every `fixing` ticket because
 *     the host advances it itself after the real run. `FixCard` renders the
 *     host's run shape (`startedAt`/`finishedAt`/`status`/`changedFiles`/
 *     `diffStat`/`summary`/`error`/`elapsedMs`, legacy `at`/`evidence`
 *     tolerated) and `MrCard` shows the branch base (`baseSource`) and
 *     worktree when the host recorded them.
 *   - status/type filters prefer the platform dictionaries in `snapshot.dicts`
 *     (label = `value`, stable key = `key`, optional colour dot) and fall back
 *     to the values observed on tickets. Rows carry a 平台/手动 source badge.
 *   - the manual add box is 「从平台导入」: it sends the existing `create`
 *     action with `{code}`, requires the returned ticket to carry
 *     `source:'platform'` before claiming success (a local/manual ticket gets a
 *     warning banner instead), and selects the imported ticket after the
 *     refresh; if that refresh does not contain it the pending selection is
 *     dropped.
 *   - `PanelErrorBoundary` keeps a render failure from blanking the whole slot.
 *
 * The client never re-implements the state machine: action buttons are derived
 * from the declarative `ACTION_BY_STATE` map (extracted and cross-checked
 * against `src/host/state-machine.js` by `test/client-action-map.test.js`).
 * P5 removed the demo delivery/review write-back actions (`submit_mr`,
 * `mr_created`, `review_requests_changes`, `review_pass`, `review_fix_done`,
 * `mr_merged`, `dismiss`) from that literal; the host services own those
 * transitions, and the raw `analysis_done`/`fix_done` demo actions are refused
 * by the host while the matching real job is running.
 * `actionUnavailableHint` applies the map's declarative `maxRounds` cap so a
 * button the host would reject (409 + block) is disabled with a hint instead.
 * The host remains the authority on transitions (an illegal one comes back as a
 * 409 and is reported in the UI).
 */

window.__ModuleLoader__.load({
  id: '@liyuera/dsh-bug-workflow',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ID = '@liyuera/dsh-bug-workflow';
    /** Visible build tag so the running UI can be verified after a reload. */
    const CLIENT_BUILD = 'p6-login.2026-11-08.5';

    /** Snapshot/action endpoints (same origin as the Harness Web page). */
    const API = Object.freeze({
      snapshot: '/bug-workflow/api/snapshot',
      action: '/bug-workflow/api/action',
      analyze: '/bug-workflow/api/analyze',
      fix: '/bug-workflow/api/fix',
      deliver: '/bug-workflow/api/deliver',
      settings: '/bug-workflow/api/settings',
      platformToken: '/bug-workflow/api/platform-token',
      platformCaptcha: '/bug-workflow/api/platform-login/captcha',
      platformLogin: '/bug-workflow/api/platform-login',
      gitlabToken: '/bug-workflow/api/gitlab-token',
      sync: '/bug-workflow/api/sync',
    });

    /** Poll cadence in milliseconds (P1 contract: every 3 s). */
    /** Board auto-refresh cadence (manual 刷新 stays immediate). */
    const POLL_INTERVAL_MS = 180000;
    const POLL_INTERVAL_LABEL = POLL_INTERVAL_MS >= 60000 && POLL_INTERVAL_MS % 60000 === 0
      ? `${POLL_INTERVAL_MS / 60000} 分钟`
      : `${POLL_INTERVAL_MS / 1000} 秒`;

    /** Workflow state -> Chinese label. */
    const WORKFLOW_LABELS = Object.freeze({
      inbox: '待入列',
      analyzing: '分析中',
      plan_review: '方案待审',
      fixing: '修复中',
      fix_done: '待人工测试',
      submitting: '待提交',
      mr_open: 'Review 中',
      fixing_review: 'Review 修复中',
      mergeable: '可合并',
      merged: '已合并',
      done: '已完成',
      blocked: '需人工',
    });

    /** Workflow state -> badge tone. */
    const WORKFLOW_TONES = Object.freeze({
      inbox: 'neutral',
      analyzing: 'info',
      plan_review: 'warn',
      fixing: 'info',
      fix_done: 'warn',
      submitting: 'warn',
      mr_open: 'info',
      fixing_review: 'info',
      mergeable: 'success',
      merged: 'success',
      done: 'success',
      blocked: 'danger',
    });

    /** Timeline event kind -> Chinese label. */
    const EVENT_LABELS = Object.freeze({
      created: '创建',
      start_analysis: '开始分析',
      analysis_done: '分析完成',
      approve_plan: '方案通过',
      reject_plan: '方案驳回',
      fix_done: '修复完成',
      mark_test_passed: '测试通过',
      submit_mr: '提交 MR',
      mr_created: 'MR 创建',
      review_requests_changes: 'Review 需修改',
      review_fix_done: 'Review 修复完成',
      review_pass: 'Review 通过',
      mr_merged: 'MR 合并',
      dismiss: '完成移除',
      retry: '解除阻塞',
      blocked: '阻塞',
      // P4 Task 2 store.patchTicket writes these two for a real fix
      // (branch/worktree metadata and the finished run).
      worktree: '创建分支/工作树',
      'fix-run': 'AI 修复执行',
      // P5 Task 3 generalizes patchTicket: mr/reviewRounds-only patches append
      // a `patch` event (delivery/MR metadata updates).
      patch: '交付信息已更新',
    });

    const ACTOR_LABELS = Object.freeze({ user: '用户', agent: '代理', system: '系统' });
    const VERDICT_LABELS = Object.freeze({ pass: '通过', changes: '需修改' });
    const MR_STATE_LABELS = Object.freeze({ open: '进行中', merged: '已合并', closed: '已关闭' });

    /** Review round budget mirrored from the host state machine. */
    const MAX_REVIEW_ROUNDS = 3;

    /** Shown whenever the session has no workspace: every mutation is gated. */
    const UNBOUND_WORKSPACE_HINT = '当前会话未绑定工作区，暂不能写入；请先在会话工作区打开「Bug 看板」（设置同样需要已绑定的工作区）';

    // <client-action-map>
    /**
     * Action buttons per workflow state (the exact P1 mapping).
     * `tone` drives styling, `confirm` is the confirmation text, `input`
     * declares an in-component text input, `payload` is the fixed body, and
     * `maxRounds` disables the button once `ticket.mr.rounds` reaches that cap
     * (see `actionUnavailableHint` below).
     * Kept as a pure JSON-like literal (strings/arrays/objects only, no
     * functions) so `test/client-action-map.test.js` can extract and evaluate
     * it verbatim and cross-check it against the host state machine.
     */
    const ACTION_BY_STATE = {
      inbox: [
        {
          action: 'start_analysis',
          label: '开始分析',
          confirm: '确认开始分析这张工单？',
          tone: 'primary',
        },
      ],
      analyzing: [
        {
          action: 'analysis_done',
          label: '分析完成',
          confirm: '确认分析已完成并提交方案待审？',
          tone: 'primary',
          // Demo plan payload, fields per the host plan schema
          // (`src/host/domain.js`). Without it the state machine leaves
          // `ticket.plan` null and `approve_plan` would approve an empty plan,
          // so the demo chain would never show a real plan on the board.
          payload: {
            plan: {
              summary: '演示方案：修复演示文件中的空值分支',
              rootCause: '演示根因：演示文件缺少空值兜底',
              approach: '补充空值兜底并添加回归用例',
              changedFiles: ['src/demo.ts'],
              risks: ['演示风险：影响范围仅限演示文件'],
              testPlan: '运行 node --test 并人工点检演示页面',
              generatedAt: '2026-11-07T00:00:00.000Z',
              approvedAt: null,
              rejectedReason: null,
            },
          },
        },
      ],
      plan_review: [
        {
          action: 'approve_plan',
          label: '通过方案',
          confirm: '确认通过该方案并进入修复？',
          tone: 'primary',
        },
        {
          action: 'reject_plan',
          label: '驳回方案',
          confirm: '驳回该方案并进入人工处理？',
          input: 'reason',
          tone: 'danger',
        },
      ],
      fixing: [
        {
          action: 'fix_done',
          label: '修复完成',
          confirm: '确认修复已完成并进入人工测试？',
          tone: 'primary',
        },
      ],
      fix_done: [
        {
          action: 'mark_test_passed',
          label: '标记测试通过',
          confirm: '确认人工测试通过，准备提交 MR？',
          tone: 'primary',
        },
      ],
      // P5 delivery/review are service-owned: the board renders the real
      // board-only 「提交并创建 MR」 descriptor (POST /api/deliver) and the
      // review/merge status banners instead of demo write-back buttons. The
      // host state machine still accepts submit_mr/mr_created/review_*/dismiss
      // for its services; they are deliberately absent from this literal.
      submitting: [],
      mr_open: [],
      fixing_review: [],
      mergeable: [],
      merged: [],
      blocked: [
        {
          action: 'retry',
          label: '重试',
          confirm: '确认解除阻塞并继续流程？',
          tone: 'primary',
        },
      ],
      done: [],
    };
    // </client-action-map>

    // <client-stage-map>
    /**
     * Workflow state -> lane mapping for the lane board (UI only).
     *
     * The lane board is a pure presentation layer: the host state machine stays
     * the authority for every transition. `states` is an exhaustive partition
     * of the host workflow states except the terminal `done` (archived tickets
     * are hidden exactly like before); `test/client-stage-map.test.js` extracts
     * this literal and cross-checks it against the host state list, so a new
     * state can never silently disappear from the board.
     *
     * Order is the left-to-right (wide) / top-to-bottom (narrow) lane order:
     * human-decision lanes are kept early so they are always visible, and the
     * blocking lane is last so it cannot push the flow off screen.
     */
    const STAGE_LANES = [
      {
        id: 'draft',
        label: '草稿',
        tone: 'neutral',
        hint: '还没开始的工单，点开「开始分析」进入流程',
        states: ['inbox'],
      },
      {
        id: 'analyzing',
        label: '分析中',
        tone: 'info',
        hint: 'AI 正在读代码并生成方案，你可以继续做别的',
        states: ['analyzing'],
      },
      {
        id: 'plan-review',
        label: '方案待审',
        tone: 'warn',
        hint: 'AI 方案已就绪，等你审核',
        states: ['plan_review'],
      },
      {
        id: 'fixing',
        label: '修复中',
        tone: 'info',
        hint: 'AI 在独立 worktree 里改代码（最长约 15 分钟）',
        states: ['fixing'],
      },
      {
        id: 'fix-done',
        label: '待人工测试',
        tone: 'warn',
        hint: '修复完成，等你验证改动',
        states: ['fix_done'],
      },
      {
        id: 'delivery',
        label: '交付中',
        tone: 'info',
        hint: '正在按团队模板提交并创建 MR，可继续其他操作',
        states: ['submitting'],
      },
      {
        id: 'review',
        label: 'Review 中',
        tone: 'info',
        hint: '每 60 秒检查 AI Review 结论，需要修改会自动回修',
        states: ['mr_open', 'fixing_review'],
      },
      {
        id: 'mergeable',
        label: '等你合并',
        tone: 'success',
        hint: 'AI Review 已通过；请在 GitLab 人工合并（插件不会自动合并）',
        states: ['mergeable', 'merged'],
      },
      {
        id: 'blocked',
        label: '需要处理',
        tone: 'danger',
        hint: '流程被阻塞，点开查看原因并重试',
        states: ['blocked'],
      },
    ];
    // </client-stage-map>

    // <client-action-availability>
    /**
     * Availability rule for one `ACTION_BY_STATE` descriptor.
     *
     * A descriptor may declare `maxRounds`; once `ticket.mr.rounds` reaches it
     * the button must be disabled, because the host rejects the action with
     * 409 `review-rounds-exhausted` and blocks the ticket as a side effect.
     * Returns the disabled hint, or `null` when the button stays available.
     *
     * Kept as a pure function literal between markers so
     * `test/client-action-map.test.js` can extract it with `vm` and exercise
     * the rounds rule without a DOM.
     */
    const actionUnavailableHint = (descriptor, ticket) => {
      const maxRounds = descriptor === null || descriptor === undefined ? null : descriptor.maxRounds;
      if (typeof maxRounds !== 'number' || !Number.isFinite(maxRounds)) return null;
      const rounds = typeof ticket?.mr?.rounds === 'number' ? ticket.mr.rounds : 0;
      if (rounds < maxRounds) return null;
      return `Review 修复轮次已耗尽（${Math.min(rounds, maxRounds)}/${maxRounds}），请人工处理`;
    };
    // </client-action-availability>

    // ---------------------------------------------------------------------
    // P3 real analysis (POST /api/analyze + snapshot.analysis feedback)
    // ---------------------------------------------------------------------

    /**
     * Static copy for the analysis failure reasons persisted by the host
     * (`blockedReason` on a blocked ticket, e.g. `analysis-failed`). Never
     * render the raw code: the host keeps messages static on purpose, and the
     * board is the only place a Chinese hint can be attached to the reason.
     */
    const ANALYSIS_REASON_LABELS = Object.freeze(Object.assign(Object.create(null), {
      'analysis-failed': '分析失败，可重新分析',
      'analysis-timeout': '分析超时，可重新分析',
      'no-live-agent': '当前没有可用的会话 Agent',
      'analysis-bad-output': 'AI 输出格式不正确，可重新分析',
    }));

    /** Live progress copy (elapsed time is appended from the local timer). */
    const ANALYSIS_RUNNING_HINT = 'AI 分析中…（最长约 10 分钟，可继续做其他操作）';

    /** Shown when the ticket is `analyzing` but the host reports no running job. */
    const ANALYSIS_INTERRUPTED_HINT = '上次分析已中断，可重新分析';

    /**
     * Board-only action descriptor for restarting an analysis. It is NOT part
     * of `ACTION_BY_STATE` (that literal is the state-machine contract and is
     * cross-checked by `test/client-action-map.test.js`); the board adds it
     * contextually for an interrupted `analyzing` ticket and for a ticket
     * blocked by an analysis failure. `executeAction` routes it to
     * `POST /api/analyze`, which the host uses to restart orphans and to
     * retry blocked-from-analyzing tickets (no separate `/action retry`).
     */
    const ANALYSIS_RETRY_DESCRIPTOR = Object.freeze({
      action: 'start_analysis',
      label: '重新分析',
      confirm: '确认重新开始 AI 分析？（分析最长约 10 分钟，可继续做其他操作）',
      tone: 'primary',
    });

    /**
     * `POST /api/analyze` failure code -> actionable Chinese hint. The host
     * messages are already static; the hint tells the user what to do next.
     * Statuses are the fallback for a host that returns a code we do not know.
     */
    const ANALYSIS_ERROR_HINTS = Object.freeze(Object.assign(Object.create(null), {
      'ticket-not-found': '工单不存在',
      'not-found': '工单不存在',
      'invalid-state': '当前状态不能分析，请刷新',
      'invalid-transition': '当前状态不能分析，请刷新',
      // 503 / analysis-unavailable only means the analysis service itself is
      // unavailable (unwired host or missing subagents/agents services). A
      // missing live Agent is NOT a 503: the host accepts the request (200) and
      // later blocks the ticket with `blockedReason:'no-live-agent'`, which the
      // detail view renders from the ticket, not from this route error.
      'analysis-unavailable': '分析服务不可用，请稍后重试',
      'unknown-workspace': '工单编号/工作区无效',
      'invalid-code': '工单编号/工作区无效',
      'invalid-input': '工单编号/工作区无效',
      'invalid-payload': '工单编号/工作区无效',
      'missing-session': '缺少会话上下文，无法分析',
    }));

    /** Product-status fallback for `POST /api/analyze` (400/404/409/503). */
    const ANALYSIS_STATUS_HINTS = Object.freeze(Object.assign(Object.create(null), {
      400: '工单编号/工作区无效',
      404: '工单不存在',
      409: '当前状态不能分析，请刷新',
      503: '分析服务不可用，请稍后重试',
    }));

    /**
     * Own-property lookup shared by every static copy map (`analysis`, `fix`,
     * `delivery`, `review`). `blockedReason` and the host error code are
     * untrusted strings: with a plain object index,
     * `'__proto__'`/`'constructor'`/`'toString'` would return
     * Object.prototype/a function instead of copy, which crashes the render.
     * The maps are null-prototype objects, and every read goes through
     * `Object.hasOwn` as a second guard.
     */
    function ownServiceValue(map, key) {
      if (typeof key !== 'string' && typeof key !== 'number') return undefined;
      return Object.hasOwn(map, key) ? map[key] : undefined;
    }

    function ownAnalysisValue(map, key) {
      return ownServiceValue(map, key);
    }

    /** Persisted block reason -> static client copy (never a prototype value). */
    function analysisReasonLabel(reason) {
      return ownAnalysisValue(ANALYSIS_REASON_LABELS, reason);
    }

    // ---------------------------------------------------------------------
    // P4 real fix (POST /api/fix + snapshot.fix feedback)
    // ---------------------------------------------------------------------

    /**
     * Static copy for the fix failure reasons persisted by the host
     * (`FIX_REASON_MESSAGES` in `src/host/fix-service.js`). A blocked ticket
     * only keeps the reason code, so the board attaches the Chinese hint.
     */
    const FIX_REASON_LABELS = Object.freeze(Object.assign(Object.create(null), {
      'fix-timeout': '修复超时，请重试',
      'fix-bad-output': '修复结果格式不正确，请重试',
      'fix-failed': '修复子代理执行失败，请重试',
      'fix-no-changes': '修复未产生任何代码改动，请重试',
      'fix-branch-busy': '个人分支已被其它工单的工作树占用，请先清理后再试',
      'no-live-agent': '当前没有可用的会话 Agent',
    }));

    /** Live progress copy (elapsed time is appended from the local timer). */
    const FIX_RUNNING_HINT = 'AI 修复中…（最长约 15 分钟，可继续其他操作）';

    /** Shown when a `fixing` ticket has no running host job. */
    const FIX_INTERRUPTED_HINT = '上次修复已中断，可重新修复';

    /** The normal approved-but-not-started state of a `fixing` ticket. */
    const FIX_READY_HINT = '方案已通过，可开始 AI 修复';

    /**
     * Board-only descriptors for starting a fix. Neither is part of
     * `ACTION_BY_STATE` (that literal is the state-machine contract checked by
     * `test/client-action-map.test.js`); the detail view adds one contextually.
     * Both go to `POST /api/fix` — the host uses the same route for an approved
     * plan, an orphaned `fixing` restart and a blocked-from-fixing retry, so
     * the client never sends a separate `/action retry` first.
     */
    const FIX_START_DESCRIPTOR = Object.freeze({
      action: 'start_fix',
      label: '开始修复',
      confirm: '确认开始 AI 修复？（修复最长约 15 分钟，可继续做其他操作）',
      tone: 'primary',
    });

    const FIX_RETRY_DESCRIPTOR = Object.freeze({
      action: 'start_fix',
      label: '重新修复',
      confirm: '确认重新开始 AI 修复？（修复最长约 15 分钟，可继续做其他操作）',
      tone: 'primary',
    });

    /** Newest `fixes` entries rendered by the history card (host appends one per run). */
    const MAX_RENDERED_FIXES = 10;

    /**
     * `POST /api/fix` failure code -> actionable Chinese hint. Mirrors the
     * route's `FIX_ERROR_STATUS` map; the status fallback covers a host that
     * returns a code this board does not know yet.
     */
    const FIX_ERROR_HINTS = Object.freeze(Object.assign(Object.create(null), {
      'ticket-not-found': '工单不存在',
      'not-found': '工单不存在',
      'invalid-state': '当前状态不能修复，请刷新',
      'invalid-transition': '当前状态不能修复，请刷新',
      'plan-not-approved': '方案尚未通过审核，无法开始修复',
      'fix-busy': '当前工作区已有修复任务在执行，请稍后重试',
      'fix-branch-busy': '个人分支已被其它工单的工作树占用，请先清理后再试',
      'worktree-conflict': '工作树已存在，请先清理后再试',
      'fix-unavailable': '修复服务不可用，请稍后重试',
      'analysis-unavailable': '修复服务不可用，请稍后重试',
      'git-timeout': '修复准备超时，请稍后重试',
      'git-failed': '修复准备失败，请检查分支与工作树',
      'unknown-workspace': '工单编号/工作区无效',
      'invalid-code': '工单编号/工作区无效',
      'invalid-input': '工单编号/工作区无效',
      'invalid-payload': '工单编号/工作区无效',
      'invalid-branch': '分支配置无效，请检查版本与个人分支后缀',
      'invalid-branch-user': '个人分支后缀无效，请检查设置',
      'invalid-family': '分支类型无效，请检查工单类型',
      'invalid-version': '工单版本无效，无法推导分支',
      'invalid-worktree-path': '工作树路径无效',
      'no-live-agent': '当前没有可用的会话 Agent',
      'missing-session': '缺少会话上下文，无法修复',
    }));

    /** Product-status fallback for `POST /api/fix` (400/404/409/500/503). */
    const FIX_STATUS_HINTS = Object.freeze(Object.assign(Object.create(null), {
      400: '工单编号/工作区或分支配置无效',
      404: '工单不存在',
      409: '当前状态不能修复，请刷新',
      500: '修复启动失败，请稍后重试',
      503: '修复服务不可用，请稍后重试',
    }));

    /** `branch.baseSource` -> short Chinese description (host writes 3 values). */
    const BASE_SOURCE_LABELS = Object.freeze(Object.assign(Object.create(null), {
      origin: '远端目标分支',
      target: '本地目标分支',
      HEAD: '当前 HEAD',
    }));

    /**
     * Own-property lookup for the fix copy maps, same guard as
     * `ownAnalysisValue`: reason codes are untrusted strings and a plain object
     * index would resolve `__proto__`/`constructor` to a non-copy value.
     */
    function ownFixValue(map, key) {
      return ownServiceValue(map, key);
    }

    /** Persisted fix block reason -> static client copy (never a raw code). */
    function fixReasonLabel(reason) {
      return ownFixValue(FIX_REASON_LABELS, reason);
    }

    /** `branch.baseSource` display copy; unknown values are shown clipped. */
    function branchBaseSourceLabel(value) {
      if (typeof value !== 'string' || value === '') return '';
      const mapped = ownFixValue(BASE_SOURCE_LABELS, value);
      return mapped === undefined ? clip(value, 80) : mapped;
    }

    // ---------------------------------------------------------------------
    // P5 delivery (POST /api/deliver + snapshot.delivery feedback)
    // ---------------------------------------------------------------------

    /**
     * Static copy for the delivery failure reasons persisted by the host
     * (`DELIVERY_REASON_MESSAGES` in `src/host/delivery-service.js`). A blocked
     * ticket only keeps the reason code, so the board attaches the Chinese hint
     * and never renders a raw code. The start-validation codes are included
     * too: a 503/409 route error may also be persisted as a block reason by a
     * future flow, and `blockedReasonText` must stay total.
     */
    const DELIVERY_REASON_LABELS = Object.freeze(Object.assign(Object.create(null), {
      'missing-gitlab-token': '未配置 GitLab token，请先在设置中保存 GitLab token',
      'invalid-gitlab-settings': 'GitLab 配置无效，请检查 GitLab 地址与项目路径',
      'protected-branch': '个人分支受保护，禁止推送',
      'delivery-lint-failed': '提交前 lint 未通过，请修复后重试',
      'delivery-test-failed': '提交前测试未通过，请修复后重试',
      'delivery-no-changes': '没有可提交的改动，请确认修复已保存',
      'delivery-busy': '当前工作区已有交付任务在执行，请稍后重试',
      'push-failed': '推送个人分支失败，请检查远程仓库后重试',
      'mr-failed': '创建 GitLab MR 失败，请稍后重试',
      'worktree-missing': '未找到可提交的工作树，请先执行修复',
      'worktree-mismatch': '提交未落在个人分支上，已停止推送，请重新执行修复',
      'worktree-conflict': '工作树当前分支与个人分支不一致，请重新执行修复',
      'invalid-branch': '个人分支或目标分支不合法，无法提交 MR',
      'git-failed': '提交失败，请检查工作树后重试',
      'not-submitting': '工单尚未通过人工测试，不能提交 MR',
    }));

    /** Live progress copy for a running delivery job (elapsed appended locally). */
    const DELIVERY_RUNNING_HINT = '正在提交并创建 MR…（先运行 lint/test，再提交、推送并创建 MR）';

    /** Normal `submitting` copy when no delivery job is running. */
    const DELIVERY_READY_HINT = '人工测试已通过，可以提交并创建 MR';

    /**
     * Board-only delivery descriptor. It is NOT part of `ACTION_BY_STATE` (that
     * literal is the state-machine contract checked by
     * `test/client-action-map.test.js`); `executeAction` routes it to
     * `POST /api/deliver` instead of `/action`, because the host owns the
     * submit_mr/mr_created transitions after the real job succeeds.
     */
    const DELIVER_DESCRIPTOR = Object.freeze({
      action: 'start_deliver',
      label: '提交并创建 MR',
      confirm: '确认提交并创建 MR？（先运行配置的 lint/test，再提交、推送个人分支并创建 GitLab MR）',
      tone: 'primary',
    });

    /**
     * `POST /api/deliver` failure code -> actionable Chinese hint. Covers every
     * code the route's `DELIVERY_ERROR_STATUS` map can return (the status
     * fallback still covers a future/host-side code this board does not know
     * yet). `invalid-input`/`internal` are the route-level 400/500 buckets and
     * intentionally share the same copy as the status fallback.
     */
    const DELIVERY_ERROR_HINTS = Object.freeze(Object.assign(Object.create(null), {
      'ticket-not-found': '工单不存在',
      'not-found': '工单不存在',
      'not-submitting': '工单尚未通过人工测试，不能提交 MR',
      'missing-gitlab-token': '未配置 GitLab token，请先在设置中保存 GitLab token',
      'invalid-gitlab-settings': 'GitLab 配置无效，请检查 GitLab 地址与项目路径',
      'protected-branch': '个人分支受保护，禁止推送',
      'delivery-busy': '当前工作区已有交付任务在执行，请稍后重试',
      'delivery-no-changes': '没有可提交的改动，请确认修复已保存',
      'worktree-missing': '未找到可提交的工作树，请先执行修复',
      'worktree-conflict': '工作树当前分支与个人分支不一致，请重新执行修复',
      'invalid-branch': '个人分支或目标分支不合法，无法提交 MR',
      'invalid-code': '工单编号/工作区无效',
      'invalid-input': '工单/工作树或 GitLab 配置无效',
      'unknown-workspace': '工单编号/工作区无效',
      'delivery-unavailable': '交付服务不可用，请稍后重试',
      'git-failed': '无法解析工作区仓库，无法提交 MR',
      'push-failed': '推送个人分支失败，请检查远程仓库后重试',
      'mr-failed': '创建 GitLab MR 失败，请稍后重试',
      'internal': '交付启动失败，请稍后重试',
      'missing-session': '缺少会话上下文，无法提交 MR',
    }));

    /** Product-status fallback for `POST /api/deliver` (400/404/409/500/503). */
    const DELIVERY_STATUS_HINTS = Object.freeze(Object.assign(Object.create(null), {
      400: '工单/工作树或 GitLab 配置无效',
      404: '工单不存在',
      409: '当前状态不能提交（可能尚未通过人工测试，或已有交付在执行）',
      500: '提交并创建 MR 失败，请稍后重试',
      503: '交付服务不可用，请稍后重试',
    }));

    /** Persisted delivery block reason -> static client copy (never a raw code). */
    function deliveryReasonLabel(reason) {
      return ownServiceValue(DELIVERY_REASON_LABELS, reason);
    }

    /**
     * `POST /api/deliver` failure copy: 404 missing ticket, 409 stale state /
     * not test-passed / busy, 503 missing GitLab token or unwired service, 400
     * invalid worktree/branch/GitLab configuration, 500 unexpected git/push/MR
     * failure. The hint replaces the host message so the banner always tells the
     * user what to do; the server code/status stay for diagnosis.
     */
    function deliverErrorView(result) {
      const view = toErrorView(result);
      const hint = ownServiceValue(DELIVERY_ERROR_HINTS, view.code)
        ?? (view.status === null ? undefined : ownServiceValue(DELIVERY_STATUS_HINTS, view.status))
        ?? null;
      return {
        ...view,
        title: '提交并创建 MR 失败',
        message: hint === null ? view.message : hint,
      };
    }

    // ---------------------------------------------------------------------
    // P5 AI Review polling / merge detection (snapshot.review only, no route)
    // ---------------------------------------------------------------------

    /**
     * Static copy for the review failure reasons persisted by the host
     * (`REVIEW_REASON_MESSAGES` in `src/host/review-service.js` plus the
     * runner-failure reasons the review fix maps). A blocked ticket only keeps
     * the code, so the board attaches the Chinese hint; raw codes are never
     * rendered.
     */
    const REVIEW_REASON_LABELS = Object.freeze(Object.assign(Object.create(null), {
      'review-parse-failed': 'AI Review 结论解析失败，请人工检查 MR 评论',
      'review-rounds-exhausted': `AI Review 修复已满 ${MAX_REVIEW_ROUNDS} 轮，需人工介入`,
      'review-merged-manually': 'MR 在 AI Review 通过前被合并，请人工确认',
      'review-fix-failed': 'AI Review 修复失败，请检查工作区后重试',
      'review-fix-timeout': 'AI Review 修复超时，请稍后重试',
      'review-fix-unavailable': '无法启动 AI Review 修复子代理，请检查会话与工作区后重试',
      'review-fix-no-changes': 'AI Review 修复未产生改动，请人工检查',
      'review-recovery-unavailable': 'Review 修复恢复条件不足，请人工检查',
      'review-fix-write-failed': 'Review 修复结果写入失败，请重试',
      'review-save-failed': 'Review 记录保存失败，请重试',
      'review-fix-branch-busy': '个人分支已被其它工单占用，请先清理后再试',
    }));

    /** Polling hint rendered for every Review-owned state. */
    const REVIEW_POLL_HINT = '每 60 秒自动检查 AI Code Review 结论';

    /**
     * The review timer no-ops without a GitLab token, but the board keeps
     * promising the next poll; this warning makes the paused poller visible.
     */
    const REVIEW_TOKEN_MISSING_HINT = '未配置 GitLab token，Review 轮询已暂停';

    /** Live progress copy while the review-fix job runs (elapsed appended). */
    const REVIEW_RUNNING_HINT = 'AI 正在修复 Review 问题…（最长约 15 分钟，可继续其他操作）';

    /** `fixing_review` with no live job: the host recovers on its next poll. */
    const REVIEW_NOT_RUNNING_HINT = 'Review 修复未在运行，宿主会在下次轮询自动恢复';

    /** `mergeable`: the plugin never merges; a human must do it in GitLab. */
    const REVIEW_MERGEABLE_HINT = 'AI Review 已通过，等待人工在 GitLab 合并（插件不会自动合并）';

    /** `merged`: the next host poll archives the ticket out of the board. */
    const REVIEW_MERGED_HINT = '已合并，工单即将自动从看板移除';

    /** Blocking issues rendered inline by the MR/Review status panel. */
    const MAX_RENDERED_REVIEW_ISSUES = 5;

    /** `reviewRounds[].status` -> short Chinese label. */
    const REVIEW_ROUND_STATUS_LABELS = Object.freeze(Object.assign(Object.create(null), {
      succeeded: '已完成',
      failed: '失败',
      cancelled: '已取消',
      running: '进行中',
    }));

    /** Persisted review block reason -> static client copy (never a raw code). */
    function reviewReasonLabel(reason) {
      return ownServiceValue(REVIEW_REASON_LABELS, reason);
    }

    /** Newest `reviewRounds` entry, or null (defensive against partial data). */
    function latestReviewRound(ticket) {
      if (ticket === null || typeof ticket !== 'object' || !Array.isArray(ticket.reviewRounds)) return null;
      for (let index = ticket.reviewRounds.length - 1; index >= 0; index -= 1) {
        const entry = ticket.reviewRounds[index];
        if (entry !== null && typeof entry === 'object') return entry;
      }
      return null;
    }

    /** `reviewRounds[].status` display copy; unknown values stay clipped. */
    function reviewRoundStatusLabel(status) {
      if (typeof status !== 'string' || status === '') return '';
      return ownServiceValue(REVIEW_ROUND_STATUS_LABELS, status) ?? clip(status, 40);
    }

    // ---------------------------------------------------------------------
    // Workspace settings (the host stores them per workspace cwd)
    // ---------------------------------------------------------------------

    /**
     * Settings contract defaults. The host store owns these fields;
     * `platformBaseUrl`/`platformProjectCode` configure the platform client and
     * `writebackStatus` is the P5 write-back switch (P2 only persists it).
     */
    const SETTINGS_DEFAULTS = Object.freeze({
      platformBaseUrl: 'https://ecard.htwisdom.cn',
      platformProjectCode: '',
      // P5 GitLab API root (host default; the token is write-only below).
      gitlabBaseUrl: 'https://git.htwisdom.cn',
      gitlabProjectPath: '',
      branchUser: 'ly',
      gitlabReviewer: '',
      commitType: 'fix',
      lintCommand: '',
      testCommand: '',
      devCommand: '',
      previewUrl: '',
      writebackStatus: false,
    });

    /** Settings keys in contract order (payload and dirty comparison order). */
    const SETTINGS_KEYS = Object.freeze(Object.keys(SETTINGS_DEFAULTS));

    /**
     * The GitLab/tooling settings fields, Chinese label + one-line help.
     * `required` marks
     * the fields the board refuses to submit empty (the host would still accept
     * them, but P2 uses them for branch/commit generation). The platform base
     * URL, project code and write-back switch live in the 「平台连接」 section.
     */
    const SETTINGS_FIELDS = Object.freeze([
      {
        key: 'gitlabProjectPath',
        label: 'GitLab 项目路径',
        hint: 'GitLab 项目路径 group/project；留空表示未配置',
        placeholder: 'group/project',
      },
      {
        key: 'branchUser',
        label: '个人分支后缀',
        hint: '个人分支后缀，如 ly',
        placeholder: 'ly',
        required: true,
      },
      {
        key: 'gitlabReviewer',
        label: 'GitLab Reviewer',
        hint: 'Reviewer 用户名，如 zhangsan，可留空',
        placeholder: 'zhangsan',
      },
      {
        key: 'commitType',
        label: '提交信息前缀',
        hint: '提交信息前缀，默认 fix',
        placeholder: 'fix',
        required: true,
      },
      {
        key: 'lintCommand',
        label: 'Lint 命令',
        hint: 'Lint 命令，可留空',
        placeholder: 'pnpm lint',
      },
      {
        key: 'testCommand',
        label: '测试命令',
        hint: '测试命令，可留空',
        placeholder: 'pnpm test',
      },
      {
        key: 'devCommand',
        label: '启动命令',
        hint: '启动命令，可留空',
        placeholder: 'pnpm dev',
      },
      {
        key: 'previewUrl',
        label: '预览地址',
        hint: '预览地址，可留空',
        placeholder: 'http://127.0.0.1:5173',
      },
    ]);

    /**
     * The platform base URL row. Rendered inside the 「平台连接」 section rather
     * than among the GitLab rows, but still part of the settings payload.
     */
    const PLATFORM_BASE_URL_FIELD = Object.freeze({
      key: 'platformBaseUrl',
      label: '平台地址',
      hint: '平台根地址，必须是 http(s) URL，且不能内嵌账号密码',
      placeholder: 'https://ecard.htwisdom.cn',
      required: true,
    });

    /**
     * `platformProjectCode` row: the sync only keeps platform tickets whose
     * `taskCode` starts with `<code>-`; empty means no server-side filter.
     */
    const PLATFORM_PROJECT_CODE_FIELD = Object.freeze({
      key: 'platformProjectCode',
      label: '平台项目编码',
      hint: '只同步该编码前缀的工单，留空=全部',
      placeholder: 'YGFNXDJRFWDJSYJJYY',
    });

    /**
     * The GitLab API root row. Same validation as `platformBaseUrl`: an
     * absolute http(s) URL without embedded credentials. Rendered inside the
     * 「GitLab 连接」 section together with the write-only token card.
     */
    const GITLAB_BASE_URL_FIELD = Object.freeze({
      key: 'gitlabBaseUrl',
      label: 'GitLab 地址',
      hint: 'GitLab 根地址，必须是 http(s) URL，且不能内嵌账号密码',
      placeholder: 'https://git.htwisdom.cn',
      required: true,
    });

    /** `group/project`, two non-empty segments without whitespace. */
    const GITLAB_PROJECT_PATH_RE = /^[^/\s]+\/[^/\s]+$/;

    const SETTINGS_SAVE_HINT = '设置按工作区保存，未保存的修改会在关闭面板后丢弃';
    const SETTINGS_UNBOUND_HINT = '当前会话未绑定工作区，设置无法保存：请先在会话工作区打开「Bug 看板」后再保存。';
    const SETTINGS_LOADING_HINT = '正在读取工作区信息，读取完成前无法保存设置。';
    const SETTINGS_NO_SESSION_HINT = '缺少会话上下文，无法保存设置。';

    const PLATFORM_SECTION_HINT = '用于从平台同步「我的工单」。token 只写入宿主凭据服务，看板与接口都不会回显。';
    const PLATFORM_TOKEN_HINT = '从浏览器 localStorage 的 `access-token` 复制';
    const PLATFORM_TOKEN_PRESENT = 'token 已配置';
    const PLATFORM_TOKEN_ABSENT = 'token 未配置';

    const GITLAB_SECTION_HINT = '用于提交个人分支并创建 GitLab MR。token 只写入宿主凭据服务，看板与接口都不会回显。';
    const GITLAB_TOKEN_HINT = 'GitLab Personal Access Token（需要 api 权限）';
    const GITLAB_TOKEN_PRESENT = 'GitLab token 已配置';
    const GITLAB_TOKEN_ABSENT = 'GitLab token 未配置';

    /** Flash/validation copy for the two shared token-card flows. */
    const PLATFORM_TOKEN_UI = Object.freeze({
      empty: '请输入平台 token',
      saved: 'token 已保存',
      combined: '设置与 token 已保存',
      cleared: 'token 已清除',
    });
    const GITLAB_TOKEN_UI = Object.freeze({
      empty: '请输入 GitLab token',
      saved: 'GitLab token 已保存',
      combined: '设置与 GitLab token 已保存',
      cleared: 'GitLab token 已清除',
    });
    /** P6 in-board login copy (captcha + account, token is write-only). */
    const PLATFORM_LOGIN_HINT = '用平台账号登录后自动保存 token；密码只用于这一次登录请求，不保存、不回显。';
    const PLATFORM_LOGIN_USERNAME_KEY = 'bug-workflow:platform-username';
    const PLATFORM_LOGIN_UI = Object.freeze({
      loggedIn: '平台已登录',
      loggedOut: '平台未登录',
      fetchCaptcha: '获取验证码',
      refreshCaptcha: '看不清？换一张',
      submit: '登录平台',
      submitting: '登录中…',
      passwordHint: '密码只在本次登录使用，不会被保存',
      missingFields: '请输入账号、密码和验证码',
      manualToggle: '手动填写 token（降级方式）',
      manualToggleOpen: '收起手动 token',
    });

    function readRememberedUsername() {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return '';
        const value = localStorage.getItem(PLATFORM_LOGIN_USERNAME_KEY);
        return typeof value === 'string' ? value.slice(0, 100) : '';
      } catch {
        return '';
      }
    }

    function rememberUsername(name) {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return;
        const value = typeof name === 'string' ? name.trim().slice(0, 100) : '';
        if (value === '') localStorage.removeItem(PLATFORM_LOGIN_USERNAME_KEY);
        else localStorage.setItem(PLATFORM_LOGIN_USERNAME_KEY, value);
      } catch {
        // Remembering the account name is best-effort only.
      }
    }

    const PLATFORM_WRITEBACK_LABEL = '写回平台状态（P5 使用）';
    const PLATFORM_WRITEBACK_HINT = 'P2 只保存该开关，不会向平台写回状态；P5 接入写回后生效。';
    const PLATFORM_IMPORT_HINT = '将从平台导入该编号的工单；重复编号会提示已存在';

    // ---------------------------------------------------------------------
    // Theme tokens (all colors come from --dsw-alias-*; fallbacks are neutral)
    // ---------------------------------------------------------------------

    const C = Object.freeze({
      text: 'var(--dsw-alias-label-primary, inherit)',
      textSecondary: 'var(--dsw-alias-label-secondary, inherit)',
      textTertiary: 'var(--dsw-alias-label-tertiary, inherit)',
      border: 'var(--dsw-alias-border-l2, transparent)',
      borderStrong: 'var(--dsw-alias-border-l3, transparent)',
      surface: 'var(--dsw-alias-bg-layer-1, transparent)',
      surfaceAlt: 'var(--dsw-alias-bg-layer-2, transparent)',
      module: 'var(--dsw-alias-bg-module-platform, transparent)',
      selected: 'var(--dsw-alias-interactive-bg-active, transparent)',
      brand: 'var(--dsw-alias-brand-primary, inherit)',
      link: 'var(--dsw-alias-link, inherit)',
      primaryFill: 'var(--dsw-alias-button-primary-fill, transparent)',
      primaryLabel: 'var(--dsw-alias-label-primary-inverted, inherit)',
      error: 'var(--dsw-alias-state-error-primary, inherit)',
      success: 'var(--dsw-alias-state-success-primary, inherit)',
    });

    const TONES = Object.freeze({
      neutral: {
        color: C.textSecondary,
        background: C.module,
        border: C.border,
      },
      info: {
        color: 'var(--dsw-alias-state-business-primary, inherit)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent)',
        border: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 30%, transparent)',
      },
      warn: {
        color: 'var(--dsw-alias-state-warn-label, inherit)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent)',
        border: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 32%, transparent)',
      },
      success: {
        color: C.success,
        background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)',
        border: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 30%, transparent)',
      },
      danger: {
        color: C.error,
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)',
        border: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent)',
      },
    });

    const baseButtonStyle = Object.freeze({
      font: 'inherit',
      fontSize: 12,
      lineHeight: '18px',
      padding: '4px 10px',
      borderRadius: 6,
      border: `0.5px solid ${C.borderStrong}`,
      background: 'transparent',
      color: C.text,
      cursor: 'pointer',
      flex: '0 0 auto',
      whiteSpace: 'nowrap',
      boxSizing: 'border-box',
    });

    const fieldLabelStyle = Object.freeze({
      fontSize: 11,
      lineHeight: '16px',
      color: C.textTertiary,
    });

    const fieldValueStyle = Object.freeze({
      fontSize: 12.5,
      lineHeight: '19px',
      color: C.text,
      wordBreak: 'break-word',
      overflowWrap: 'anywhere',
    });

    const emptyTextStyle = Object.freeze({
      margin: 0,
      fontSize: 12,
      lineHeight: '18px',
      color: C.textTertiary,
    });

    const cardStyle = Object.freeze({
      border: `0.5px solid ${C.border}`,
      borderRadius: 10,
      background: C.surface,
      padding: '10px 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      boxSizing: 'border-box',
      minWidth: 0,
    });

    const cardHeaderStyle = Object.freeze({
      display: 'flex',
      alignItems: 'baseline',
      gap: 8,
      minWidth: 0,
    });

    const cardTitleStyle = Object.freeze({
      margin: 0,
      fontSize: 12.5,
      fontWeight: 600,
      lineHeight: '18px',
      color: C.text,
    });

    const cardAsideStyle = Object.freeze({
      marginLeft: 'auto',
      fontSize: 11,
      lineHeight: '16px',
      color: C.textTertiary,
      whiteSpace: 'nowrap',
    });

    const detailGap = 10;

    // ---------------------------------------------------------------------
    // Small pure helpers
    // ---------------------------------------------------------------------

    function textOf(value, fallback) {
      if (value === null || value === undefined) return fallback === undefined ? '' : fallback;
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }

    function clip(value, max) {
      const text = textOf(value);
      return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
    }

    function formatTime(value) {
      if (typeof value !== 'string' && typeof value !== 'number') return '—';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '—';
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function fullTime(value) {
      if (typeof value !== 'string' && typeof value !== 'number') return undefined;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return undefined;
      try {
        return date.toISOString();
      } catch {
        return undefined;
      }
    }

    /**
     * Local analysis elapsed time. The host does not persist a start timestamp
     * for a running job (snapshot only carries the running codes), so the board
     * counts from the first poll that reports the code as running. Rendered as
     * `0 分 07 秒` style text; clamped so a clock jump cannot show negatives.
     */
    function formatElapsed(seconds) {
      const total = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
        ? Math.floor(seconds)
        : 0;
      const minutes = Math.floor(total / 60);
      const rest = total % 60;
      if (minutes < 60) return `${minutes} 分 ${String(rest).padStart(2, '0')} 秒`;
      return `${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, '0')} 分`;
    }

    function baseName(path) {
      if (typeof path !== 'string' || path.trim() === '') return '';
      const parts = path.split(/[\\/]+/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : path;
    }

    function workflowLabel(workflow) {
      return WORKFLOW_LABELS[workflow] ?? (typeof workflow === 'string' && workflow !== '' ? workflow : '未知');
    }

    function workflowTone(workflow) {
      return WORKFLOW_TONES[workflow] ?? 'neutral';
    }

    /** Lane for one workflow state; `null` for the archived `done` state. */
    function laneForWorkflow(workflow) {
      for (const lane of STAGE_LANES) {
        if (Array.isArray(lane.states) && lane.states.includes(workflow)) return lane;
      }
      return null;
    }

    /** Position of one workflow state in the lane order (`-1` when unknown). */
    function laneIndexForWorkflow(workflow) {
      for (let index = 0; index < STAGE_LANES.length; index += 1) {
        const lane = STAGE_LANES[index];
        if (Array.isArray(lane.states) && lane.states.includes(workflow)) return index;
      }
      return -1;
    }

    /**
     * Human-readable wait/elapsed span. The host persists `updatedAt` (not a
     * job start time), so running durations are an approximation that resets
     * whenever the ticket changes — the same trade-off as the analysis timer.
     */
    function formatWait(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
      const minutes = Math.floor(ms / 60000);
      if (minutes < 1) return '刚刚';
      if (minutes < 60) return `${minutes} 分钟`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours} 小时`;
      return `${Math.floor(hours / 24)} 天`;
    }

    /** Milliseconds since the ticket last changed (`0` when unparseable). */
    function sinceUpdateMs(ticket) {
      const raw = ticket !== null && typeof ticket === 'object' ? ticket.updatedAt : null;
      const time = typeof raw === 'number' ? raw : (typeof raw === 'string' ? Date.parse(raw) : NaN);
      if (!Number.isFinite(time)) return 0;
      return Math.max(0, Date.now() - time);
    }

    /** True when the state is explicitly waiting for a human decision. */
    function laneWaitsForHuman(workflow) {
      return workflow === 'plan_review' || workflow === 'fix_done' || workflow === 'mergeable';
    }

    /** True when a background host job should be running for this workflow. */
    function ticketRunningFor(ticket, snapshot) {
      if (ticket === null || typeof ticket !== 'object') return false;
      const workflow = ticket.workflow;
      if (workflow === 'analyzing') return analysisRunningFor(snapshot, ticket.code);
      if (workflow === 'fixing') return fixRunningFor(snapshot, ticket.code);
      if (workflow === 'submitting') return deliveryRunningFor(snapshot, ticket.code);
      if (workflow === 'fixing_review') return reviewRunningFor(snapshot, ticket.code);
      return false;
    }

    /**
     * Card-level next-step copy: what is happening right now, or who must act.
     * Deliberately text-only — the actual transition buttons stay in the detail
     * view (and on the host's action map), so the lane card can never fire an
     * action the host would refuse.
     */
    function nextStepText(ticket, snapshot) {
      if (ticket === null || typeof ticket !== 'object') return '';
      const workflow = ticket.workflow;
      const running = ticketRunningFor(ticket, snapshot);
      switch (workflow) {
        case 'inbox': return '待开始分析';
        case 'analyzing': return running ? 'AI 分析中' : '分析已中断 · 可重新分析';
        case 'plan_review': return '等你审核方案';
        case 'fixing': return running ? 'AI 修复中' : '修复未运行 · 可重新修复';
        case 'fix_done': return '等你人工测试';
        case 'submitting': return running ? '正在提交 MR' : '待提交 MR';
        case 'mr_open': return '等 AI Review 结论';
        case 'fixing_review': return running ? 'AI 回修中' : '等待恢复回修';
        case 'mergeable': return '等你到 GitLab 合并';
        case 'merged': return '即将自动移除';
        case 'blocked': return `原因：${clip(blockedReasonText(ticket), 26)}`;
        case 'done': return '已完成';
        default: return workflowLabel(workflow);
      }
    }

    /** Card meta line: waiting/elapsed span, or the last update time. */
    function laneCardMeta(ticket, snapshot) {
      if (ticket === null || typeof ticket !== 'object') return '';
      const workflow = ticket.workflow;
      const span = formatWait(sinceUpdateMs(ticket));
      if (ticketRunningFor(ticket, snapshot)) {
        return span === '' ? '运行中' : `已运行 ${span}`;
      }
      if (laneWaitsForHuman(workflow)) {
        return span === '' ? '等待你处理' : `等了 ${span}`;
      }
      if (workflow === 'merged') return '已合并';
      if (laneForWorkflow(workflow) === null) return formatTime(ticket.updatedAt);
      return `更新 ${formatTime(ticket.updatedAt)}`;
    }

    function eventLabel(kind) {
      return EVENT_LABELS[kind] ?? (typeof kind === 'string' && kind !== '' ? kind : '事件');
    }

    function actorLabel(actor) {
      return ACTOR_LABELS[actor] ?? (typeof actor === 'string' && actor !== '' ? actor : '系统');
    }

    function verdictLabel(verdict) {
      return VERDICT_LABELS[verdict] ?? (typeof verdict === 'string' && verdict !== '' ? verdict : '未评审');
    }

    function mrStateLabel(state) {
      return MR_STATE_LABELS[state] ?? (typeof state === 'string' && state !== '' ? state : '未知');
    }

    function dimensionValue(value) {
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
    }

    function uniqueDimensions(tickets, field) {
      const seen = new Set();
      for (const ticket of tickets) {
        if (!ticket || typeof ticket !== 'object') continue;
        seen.add(dimensionValue(ticket[field]));
      }
      return Array.from(seen);
    }

    /**
     * Platform type dictionary lookup. P2 reads `snapshot.dicts.type`; the P1
     * optional dictionaries are still accepted for older hosts. Returns the
     * display name (`value`) whether the ticket stores a key or a name.
     */
    function typeLabel(value, snapshot) {
      const raw = dimensionValue(value);
      if (raw === '') return '未设置';
      const snapshotValue = snapshot && typeof snapshot === 'object' ? snapshot : {};
      const dictionaries = [
        snapshotValue.dicts && snapshotValue.dicts.type,
        snapshotValue.typeDict,
        snapshotValue.dictionaries && snapshotValue.dictionaries.type,
        snapshotValue.settings && snapshotValue.settings.typeDict,
      ];
      for (const dictionary of dictionaries) {
        if (!Array.isArray(dictionary)) continue;
        for (const entry of dictionary) {
          if (!entry || typeof entry !== 'object') continue;
          const candidates = [entry.value, entry.code, entry.key];
          if (!candidates.includes(raw)) continue;
          return textOf(entry.label ?? entry.name ?? entry.value, raw);
        }
      }
      return raw;
    }

    /**
     * Display value of one platform field, preferring the v2 platform snapshot
     * (`platform.statusName`/`typeName`/...) over the top-level synced value.
     */
    function platformField(ticket, key) {
      const platform = ticket !== null && typeof ticket === 'object' && ticket.platform !== null && typeof ticket.platform === 'object'
        ? ticket.platform
        : null;
      if (platform === null) return '';
      const value = platform[key];
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
    }

    function ticketSource(ticket) {
      return ticket !== null && typeof ticket === 'object' && ticket.source === 'platform' ? 'platform' : 'manual';
    }

    function sourceLabel(ticket) {
      return ticketSource(ticket) === 'platform' ? '平台' : '手动';
    }

    function ticketTypeText(ticket, snapshot) {
      const platformName = platformField(ticket, 'typeName');
      return platformName !== '' ? platformName : typeLabel(ticket === null ? '' : ticket.type, snapshot);
    }

    function ticketStatusText(ticket) {
      const platformName = platformField(ticket, 'statusName');
      if (platformName !== '') return platformName;
      return dimensionValue(ticket === null || typeof ticket !== 'object' ? '' : ticket.status) || '未设置';
    }

    function sourceTone(ticket) {
      return ticketSource(ticket) === 'platform' ? 'info' : 'neutral';
    }

    /** Snapshot `analysis.running` lookup; a missing block means "not running". */
    function analysisRunningFor(snapshot, code) {
      if (typeof code !== 'string' || code === '') return false;
      if (snapshot === null || typeof snapshot !== 'object') return false;
      const analysis = snapshot.analysis;
      if (analysis === null || typeof analysis !== 'object' || !Array.isArray(analysis.running)) return false;
      return analysis.running.includes(code);
    }

    /**
     * The persisted static analysis error for one code, or `null`.
     *
     * Staleness rule (Task 2 handoff): `analysis.error:<code>` is only cleared
     * by a later successful analysis start, so a ticket that already moved on
     * (plan_review/fixing/...) may still carry an old error. Callers must only
     * render it for the two live conditions in `AnalysisNotice` — an
     * analysis-related blocked ticket, or `analyzing` with no running job.
     */
    function analysisErrorFor(snapshot, code) {
      if (typeof code !== 'string' || code === '') return null;
      if (snapshot === null || typeof snapshot !== 'object') return null;
      const analysis = snapshot.analysis;
      if (analysis === null || typeof analysis !== 'object') return null;
      const errors = analysis.errors;
      if (errors === null || typeof errors !== 'object' || Array.isArray(errors)) return null;
      const message = errors[code];
      return typeof message === 'string' && message !== '' ? message : null;
    }

    /** Snapshot `fix.running` lookup; a missing block means "not running". */
    function fixRunningFor(snapshot, code) {
      if (typeof code !== 'string' || code === '') return false;
      if (snapshot === null || typeof snapshot !== 'object') return false;
      const fix = snapshot.fix;
      if (fix === null || typeof fix !== 'object' || !Array.isArray(fix.running)) return false;
      return fix.running.includes(code);
    }

    /**
     * The persisted static fix error for one code, or `null`.
     *
     * Staleness rule (same as `analysisErrorFor`): `fix.error:<code>` is only
     * cleared by a later successful fix start, so a ticket that already moved
     * on may still carry an old error. Callers must only render it for the two
     * live conditions in `FixNotice` — a fix-related blocked ticket, or
     * `fixing` with no running job.
     */
    function fixErrorFor(snapshot, code) {
      if (typeof code !== 'string' || code === '') return null;
      if (snapshot === null || typeof snapshot !== 'object') return null;
      const fix = snapshot.fix;
      if (fix === null || typeof fix !== 'object') return null;
      const errors = fix.errors;
      if (errors === null || typeof errors !== 'object' || Array.isArray(errors)) return null;
      const message = errors[code];
      return typeof message === 'string' && message !== '' ? message : null;
    }

    /** Snapshot `delivery.running` lookup; a missing block means "not running". */
    function deliveryRunningFor(snapshot, code) {
      return serviceRunningFor(snapshot, 'delivery', code);
    }

    /** Snapshot `review.running` lookup; a missing block means "not running". */
    function reviewRunningFor(snapshot, code) {
      return serviceRunningFor(snapshot, 'review', code);
    }

    /** Shared `snapshot.<service>.running` lookup (analysis/fix/delivery/review). */
    function serviceRunningFor(snapshot, block, code) {
      if (typeof code !== 'string' || code === '') return false;
      if (snapshot === null || typeof snapshot !== 'object') return false;
      const value = snapshot[block];
      if (value === null || typeof value !== 'object' || !Array.isArray(value.running)) return false;
      return value.running.includes(code);
    }

    /**
     * The persisted static delivery error for one code, or `null`.
     *
     * `delivery.error:<code>` is the delivery-specific meta namespace (never
     * `fix.error:<code>`); a later successful delivery clears it. Callers only
     * render it for the `submitting` panel, where it is the live record of the
     * last failed attempt.
     */
    function deliveryErrorFor(snapshot, code) {
      return serviceErrorFor(snapshot, 'delivery', code);
    }

    /**
     * The persisted static review error for one code, or `null`.
     *
     * Same staleness rule as `analysisErrorFor`: `review.error:<code>` can
     * survive on a ticket that moved on, so the review panel only renders it
     * for the states that consume review writes — `mr_open`, `fixing_review`,
     * and `mergeable`/`merged` (where a failed merge/archival write leaves the
     * host-recorded cause visible instead of only the success copy).
     */
    function reviewErrorFor(snapshot, code) {
      return serviceErrorFor(snapshot, 'review', code);
    }

    /** Shared `snapshot.<service>.errors[code]` lookup. */
    function serviceErrorFor(snapshot, block, code) {
      if (typeof code !== 'string' || code === '') return null;
      if (snapshot === null || typeof snapshot !== 'object') return null;
      const value = snapshot[block];
      if (value === null || typeof value !== 'object') return null;
      const errors = value.errors;
      if (errors === null || typeof errors !== 'object' || Array.isArray(errors)) return null;
      const message = errors[code];
      return typeof message === 'string' && message !== '' ? message : null;
    }

    /**
     * True when a `blocked` ticket was blocked by the analysis flow. The host
     * only blocks an analysis failure from `analyzing` (the cleanup write is
     * guarded by `expectedWorkflow:'analyzing'`), so `blockedFrom` is the
     * contract. The reason alone is NOT enough: an `analysis-*` code can be
     * present on a legacy/corrupted record blocked from another workflow, and
     * the 「重新分析」 button would then offer a dead end (the client-side
     * defense in depth required by the P3 whole-branch review).
     */
    function isAnalysisBlock(ticket) {
      if (ticket === null || typeof ticket !== 'object' || ticket.workflow !== 'blocked') return false;
      return ticket.blockedFrom === 'analyzing';
    }

    /** Static failure copy for a blocked analysis (never the raw reason code). */
    function analysisFailureText(ticket, serverError) {
      const reason = ticket !== null && typeof ticket === 'object' && typeof ticket.blockedReason === 'string'
        ? ticket.blockedReason
        : '';
      const mapped = analysisReasonLabel(reason);
      if (mapped !== undefined) return mapped;
      if (typeof serverError === 'string' && serverError !== '') return clip(serverError, 300);
      return '分析失败，可重新分析';
    }

    /**
     * True when a `blocked` ticket was blocked by the fix flow.
     *
     * `blockedFrom:'fixing'` is the host contract (every fix failure blocks
     * with `expectedWorkflow:'fixing'`), and — exactly like `isAnalysisBlock` —
     * it is the ONLY signal. `blockedReason` must never decide this: a
     * `reject_plan` block persists the user's free-text rejection reason
     * verbatim (`state-machine.js`), so a plan-review ticket rejected with
     * e.g. `fix-一下再提交` would otherwise look like a fix block, hide the
     * generic 「重试」 (the only exit from a plan-review block) and offer
     * 「重新修复」 that the host refuses with 409 invalid-state. The host stays
     * the authority for the actual restart. `snapshot.fix.errors` never decides
     * this on its own (only rendered once the ticket qualifies), so a ticket
     * that moved on cannot show stale fix error copy.
     */
    function isFixBlock(ticket) {
      if (ticket === null || typeof ticket !== 'object' || ticket.workflow !== 'blocked') return false;
      return ticket.blockedFrom === 'fixing';
    }

    /**
     * True when a `blocked` ticket was blocked by the delivery flow
     * (`blockedFrom:'submitting'`). Only the host contract decides; the reason
     * code is never used for flow detection (same rule as `isFixBlock`).
     */
    function isDeliveryBlock(ticket) {
      if (ticket === null || typeof ticket !== 'object' || ticket.workflow !== 'blocked') return false;
      return ticket.blockedFrom === 'submitting';
    }

    /**
     * True when a `blocked` ticket was blocked by the AI Review polling or
     * merge-detection flow. The host blocks from `mr_open` (parse failure,
     * rounds exhausted, manual merge before pass), `fixing_review` (fix
     * failure) and possibly `mergeable`; `blockedFrom` is the contract.
     */
    const REVIEW_BLOCK_SOURCES = Object.freeze(['mr_open', 'fixing_review', 'mergeable']);
    function isReviewBlock(ticket) {
      if (ticket === null || typeof ticket !== 'object' || ticket.workflow !== 'blocked') return false;
      return REVIEW_BLOCK_SOURCES.includes(ticket.blockedFrom);
    }

    /**
     * True when the branch/worktree metadata the host persists at the start of
     * a run (`persistBranch` in `fix-service.js`) is present. A cancelled or
     * host-unloaded job writes neither a `fixes` entry nor `fix.error`, so this
     * is the only persisted marker that "a run was started" — used to pick the
     * interrupted copy instead of the normal ready copy.
     */
    function fixRunStarted(ticket) {
      if (ticket === null || typeof ticket !== 'object') return false;
      const branch = ticket.branch;
      return branch !== null && typeof branch === 'object'
        && typeof branch.worktree === 'string' && branch.worktree.trim() !== '';
    }

    /**
     * Static failure copy for a blocked fix. The host writes the newest start
     * failure to `snapshot.fix.errors[code]`; a blocked-restart preparation
     * failure deliberately keeps the old `blockedReason`, so the snapshot
     * detail wins over the persisted reason. Neither is a raw code.
     */
    function fixFailureText(ticket, serverError) {
      if (typeof serverError === 'string' && serverError !== '') return clip(serverError, 300);
      const reason = ticket !== null && typeof ticket === 'object' && typeof ticket.blockedReason === 'string'
        ? ticket.blockedReason
        : '';
      const mapped = fixReasonLabel(reason);
      if (mapped !== undefined) return mapped;
      return '修复失败，可重新修复';
    }

    /**
     * Blocked-reason display text: mapped analysis/fix/delivery/review copy,
     * clipped raw reason otherwise. Every P5 reason code has static Chinese
     * copy, so a regular ticket never shows a raw code.
     */
    function blockedReasonText(ticket) {
      const reason = ticket !== null && typeof ticket === 'object' && typeof ticket.blockedReason === 'string'
        ? ticket.blockedReason
        : '';
      if (reason === '') return '未记录';
      return analysisReasonLabel(reason)
        ?? fixReasonLabel(reason)
        ?? deliveryReasonLabel(reason)
        ?? reviewReasonLabel(reason)
        ?? clip(reason, 300);
    }

    function safeHttpUrl(value) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!/^https?:\/\//i.test(trimmed)) return null;
      return trimmed;
    }

    /**
     * Safe CSS colour for a dictionary swatch. Only literal hex/rgb(a)/hsl(a)
     * values are rendered (the colour is platform data, never a theme token);
     * anything else falls back to the neutral dot.
     */
    function safeSwatch(value) {
      if (typeof value !== 'string') return null;
      const text = value.trim();
      if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text)) return text;
      if (/^(?:rgb|hsl)a?\([0-9.,%\s/+-]+\)$/i.test(text)) return text;
      return null;
    }

    /** One `FilterChips` entry; accepts a plain value or a dictionary option. */
    function filterOptionEntry(option) {
      if (typeof option === 'string') {
        return {
          key: option === '' ? 'none' : option,
          value: option,
          label: option === '' ? '未设置' : option,
          color: null,
        };
      }
      if (option === null || typeof option !== 'object') return null;
      const key = typeof option.key === 'string' && option.key !== '' ? option.key : '';
      const rawValue = typeof option.value === 'string' ? option.value : '';
      const value = rawValue !== '' ? rawValue : key;
      if (value === '') return null;
      return {
        key: key === '' ? value : key,
        value,
        label: value,
        color: safeSwatch(option.color),
      };
    }

    /** The non-empty dictionary group, mapped to filter options. */
    function dictFilterOptions(dicts, group) {
      const entries = dicts !== null && typeof dicts === 'object' && Array.isArray(dicts[group]) ? dicts[group] : [];
      const options = [];
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue;
        const key = typeof entry.key === 'string' ? entry.key.trim() : '';
        const rawValue = typeof entry.value === 'string' ? entry.value.trim() : '';
        const value = rawValue !== '' ? rawValue : key;
        if (value === '') continue;
        options.push({
          key: key === '' ? value : key,
          value,
          color: typeof entry.color === 'string' ? entry.color : '',
        });
      }
      return options;
    }

    /**
     * Filter options: platform dictionaries first (non-empty groups only),
     * plus any ticket value the dictionary does not cover (so a legacy/outlier
     * ticket stays filterable). Falls back to ticket-derived values entirely
     * when the host has no dictionary for the group.
     */
    function buildFilterOptions(dicts, group, tickets, field) {
      const dictionary = dictFilterOptions(dicts, group);
      const ticketValues = uniqueDimensions(tickets, field);
      if (dictionary.length === 0) return ticketValues;
      const seen = new Set(dictionary.map((option) => option.value));
      const options = dictionary.slice();
      for (const value of ticketValues) {
        if (seen.has(value)) continue;
        seen.add(value);
        options.push(value);
      }
      return options;
    }

    /** One `{key,value,color}` dictionary entry list -> normalized entries. */
    function normalizeDictEntries(raw) {
      if (!Array.isArray(raw)) return [];
      const entries = [];
      for (const item of raw) {
        if (item === null || typeof item !== 'object') continue;
        const key = typeof item.key === 'string' ? item.key : '';
        const value = typeof item.value === 'string' ? item.value : '';
        if (key === '' && value === '') continue;
        entries.push({
          key,
          value,
          color: typeof item.color === 'string' ? item.color : '',
        });
      }
      return entries;
    }

    /**
     * Snapshot service block: `{running: string[], errors: {[code]: string}}`.
     * Shared by `analysis`/`fix`/`delivery`/`review`. The host always sends
     * each block (empty when the service is not wired), but normalize
     * defensively so a partial/older response cannot crash the board or leak
     * non-string entries into rendered output.
     */
    function normalizeServiceStatus(raw) {
      const value = raw !== null && typeof raw === 'object' ? raw : {};
      const running = Array.isArray(value.running)
        ? value.running.filter((code) => typeof code === 'string' && code !== '')
        : [];
      const errors = {};
      if (value.errors !== null && typeof value.errors === 'object' && !Array.isArray(value.errors)) {
        for (const [code, message] of Object.entries(value.errors)) {
          if (typeof message === 'string' && message !== '') errors[code] = message;
        }
      }
      return { running, errors };
    }

    function normalizeAnalysis(raw) {
      return normalizeServiceStatus(raw);
    }

    function normalizeFix(raw) {
      return normalizeServiceStatus(raw);
    }

    function normalizeDelivery(raw) {
      return normalizeServiceStatus(raw);
    }

    function normalizeReview(raw) {
      return normalizeServiceStatus(raw);
    }

    function normalizeSnapshot(payload) {
      const value = payload && typeof payload === 'object' ? payload : {};
      const workspace = value.workspace && typeof value.workspace === 'object' ? value.workspace : {};
      const platform = value.platform && typeof value.platform === 'object' ? value.platform : {};
      const gitlab = value.gitlab && typeof value.gitlab === 'object' ? value.gitlab : {};
      const dicts = value.dicts && typeof value.dicts === 'object' ? value.dicts : {};
      return {
        workspace: {
          path: typeof workspace.path === 'string' ? workspace.path : null,
          configured: workspace.configured === true,
        },
        settings: value.settings && typeof value.settings === 'object' ? value.settings : {},
        platform: {
          tokenPresent: platform.tokenPresent === true,
          lastSyncAt: typeof platform.lastSyncAt === 'string' ? platform.lastSyncAt : null,
          lastSyncError: typeof platform.lastSyncError === 'string' ? platform.lastSyncError : null,
        },
        // P5: GitLab token presence only; the value never reaches the client.
        gitlab: {
          tokenPresent: gitlab.tokenPresent === true,
        },
        // P3 analysis progress/errors (empty shape when the host has no
        // analysis service, e.g. a profile without subagent services).
        analysis: normalizeAnalysis(value.analysis),
        // P4 fix progress/errors, normalized exactly like `analysis` so a
        // partial host response cannot crash the board.
        fix: normalizeFix(value.fix),
        // P5 delivery progress/errors (`delivery.error:<code>` namespace).
        delivery: normalizeDelivery(value.delivery),
        // P5 review polling/merge-detection progress/errors (`review.error:<code>`).
        review: normalizeReview(value.review),
        // Task 4 guarantees all three groups; normalize anyway so a partial
        // host response can never make the filter crash.
        dicts: {
          status: normalizeDictEntries(dicts.status),
          type: normalizeDictEntries(dicts.type),
          priority: normalizeDictEntries(dicts.priority),
        },
        tickets: Array.isArray(value.tickets)
          ? value.tickets.filter((ticket) => ticket && typeof ticket === 'object' && typeof ticket.code === 'string')
          : [],
        serverTime: typeof value.serverTime === 'string' ? value.serverTime : null,
      };
    }

    /**
     * Normalize a settings record to the contract fields. Values are kept
     * verbatim (trimming happens only on save); a missing field takes its
     * documented default, an empty string stays empty so required-field
     * validation can report it. `writebackStatus` is the one boolean field.
     */
    function normalizeSettings(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {};
      const next = {};
      for (const key of SETTINGS_KEYS) {
        const value = source[key];
        next[key] = typeof SETTINGS_DEFAULTS[key] === 'boolean'
          ? value === true
          : (typeof value === 'string' ? value : SETTINGS_DEFAULTS[key]);
      }
      return next;
    }

    /** Snapshot (`{settings}`) or null -> a complete settings draft. */
    function settingsFromSnapshot(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object') return normalizeSettings(null);
      return normalizeSettings(snapshot.settings);
    }

    /** The exact POST body: every field present, trimmed, contract-typed. */
    function settingsPayload(draft) {
      const source = draft !== null && typeof draft === 'object' ? draft : {};
      const payload = {};
      for (const key of SETTINGS_KEYS) {
        const value = source[key];
        payload[key] = typeof SETTINGS_DEFAULTS[key] === 'boolean'
          ? value === true
          : (typeof value === 'string' ? value.trim() : '');
      }
      return payload;
    }

    function settingsEqual(a, b) {
      if (a === b) return true;
      if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
      for (const key of SETTINGS_KEYS) {
        if (a[key] !== b[key]) return false;
      }
      return true;
    }

    /**
     * Field errors for a settings draft. Empty `gitlabProjectPath` means "not
     * configured" and is valid; `branchUser` and `commitType` must not be empty;
     * command/preview fields may be empty. Both base URLs
     * (`platformBaseUrl`/`gitlabBaseUrl`, P5) must be absolute http(s) URLs
     * without embedded credentials.
     */
    function validateSettings(draft) {
      const value = draft !== null && typeof draft === 'object' ? draft : {};
      const errors = {};
      const platformBaseUrlError = validatePlatformBaseUrl(value.platformBaseUrl);
      if (platformBaseUrlError !== null) errors.platformBaseUrl = platformBaseUrlError;
      const gitlabBaseUrlError = validateGitlabBaseUrl(value.gitlabBaseUrl);
      if (gitlabBaseUrlError !== null) errors.gitlabBaseUrl = gitlabBaseUrlError;
      const projectPath = typeof value.gitlabProjectPath === 'string'
        ? value.gitlabProjectPath.trim()
        : '';
      if (projectPath !== '' && !GITLAB_PROJECT_PATH_RE.test(projectPath)) {
        errors.gitlabProjectPath = '格式应为 group/project（两段、不含空格）；留空表示未配置';
      }
      if (typeof value.branchUser !== 'string' || value.branchUser.trim() === '') {
        errors.branchUser = '个人分支后缀不能为空';
      }
      if (typeof value.commitType !== 'string' || value.commitType.trim() === '') {
        errors.commitType = '提交信息前缀不能为空';
      }
      return errors;
    }

    /**
     * Base-URL rule shared by the panel and the save path. Returns the error
     * text, or `null` when valid. Localhost http URLs are allowed (the P2/P5
     * mock servers run there); embedded credentials are never allowed. The
     * label keeps the platform copy byte-for-byte identical to P2.
     */
    function validateBaseUrl(value, label) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text === '') return `${label}不能为空`;
      let url;
      try {
        url = new URL(text);
      } catch {
        return `${label}必须是合法的 http(s) URL`;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return `${label}只支持 http(s)`;
      }
      if (url.username !== '' || url.password !== '') {
        return `${label}不能内嵌账号密码`;
      }
      return null;
    }

    function validatePlatformBaseUrl(value) {
      return validateBaseUrl(value, '平台地址');
    }

    /** P5 `gitlabBaseUrl` rule (same shape as the platform base URL). */
    function validateGitlabBaseUrl(value) {
      return validateBaseUrl(value, 'GitLab 地址');
    }

    function errorCodeText(error) {
      const parts = [
        error && error.status !== null && error.status !== undefined ? `HTTP ${error.status}` : null,
        error && typeof error.code === 'string' && error.code !== '' ? error.code : null,
      ].filter((part) => typeof part === 'string' && part !== '');
      return parts.join(' · ');
    }

    function toErrorView(result) {
      return {
        code: typeof result?.code === 'string' ? result.code : 'error',
        message: typeof result?.message === 'string' && result.message !== '' ? result.message : '请求失败',
        status: typeof result?.status === 'number' ? result.status : null,
        stage: typeof result?.stage === 'string' ? result.stage : null,
      };
    }

    /**
     * Actionable sync failure copy. The host only ever sends static codes and
     * short messages (never the token/upstream body); the banner keeps the
     * code and shows the hint that tells the user what to change.
     */
    const SYNC_ERROR_HINTS = Object.freeze({
      'no-platform-token': '请先在设置里配置平台 token',
      'platform-unauthorized': '平台 token 已失效，请更新',
      'invalid-platform-config': '平台地址无效，请检查设置',
      'unknown-workspace': '当前会话未绑定工作区，无法同步',
      'platform-network': '平台暂不可用',
      'platform-http': '平台暂不可用',
      'platform-bad-response': '平台暂不可用',
      'platform-not-found': '平台暂不可用',
    });

    function syncErrorView(result) {
      const view = toErrorView(result);
      const hint = SYNC_ERROR_HINTS[view.code] ?? (view.status === 502 ? '平台暂不可用' : null);
      return {
        ...view,
        title: '同步失败',
        message: hint === null ? view.message : hint,
      };
    }

    /**
     * Import failure copy: a missing token is a settings problem and an unknown
     * code means the platform has no such ticket (the host maps upstream 404 to
     * `platform-not-found`); everything else keeps the server message.
     */
    function importErrorView(result) {
      const view = toErrorView(result);
      if (view.code === 'no-platform-token') {
        return { ...view, title: '导入失败', message: '请先在设置里配置平台 token' };
      }
      if (view.code === 'platform-not-found' || view.status === 404) {
        return { ...view, title: '导入失败', message: '平台没有该工单' };
      }
      return { ...view, title: '导入失败' };
    }

    /**
     * `POST /api/analyze` failure copy: 404 missing ticket, 409 stale state
     * (refresh), 503 no live session agent / service not wired, 400 invalid
     * code or unbound workspace. The hint replaces the host message so the
     * banner always tells the user what to do; the server code/status stay in
     * the banner for diagnosis.
     */
    function analyzeErrorView(result) {
      const view = toErrorView(result);
      const hint = ownAnalysisValue(ANALYSIS_ERROR_HINTS, view.code)
        ?? (view.status === null ? undefined : ownAnalysisValue(ANALYSIS_STATUS_HINTS, view.status))
        ?? null;
      return {
        ...view,
        title: '分析启动失败',
        message: hint === null ? view.message : hint,
      };
    }

    /**
     * `POST /api/fix` failure copy: 404 missing ticket, 409 stale state /
     * unapproved plan / repository or branch busy, 503 service unavailable,
     * 400 invalid code or branch configuration, 500 unexpected git/host
     * failure. The hint replaces the host message so the banner always tells
     * the user what to do; the server code/status stay for diagnosis.
     *
     * One exception: the host also returns code `fix-unavailable` with a
     * cause-specific static message (`FIX_REASON_MESSAGES['no-live-agent']`
     * when the session has no live agent) while the route's generic
     * `fix-unavailable` copy means "service not wired". Keep that refined
     * message instead of masking it with the cause-neutral hint the host would
     * otherwise repeat; the generic copy still covers the plain 503.
     */
    function fixErrorView(result) {
      const view = toErrorView(result);
      const hint = ownFixValue(FIX_ERROR_HINTS, view.code)
        ?? (view.status === null ? undefined : ownFixValue(FIX_STATUS_HINTS, view.status))
        ?? null;
      const generic503 = ownFixValue(FIX_STATUS_HINTS, 503);
      const refined = view.code === 'fix-unavailable'
        && view.message !== ''
        && view.message !== generic503;
      return {
        ...view,
        title: '修复启动失败',
        message: refined ? view.message : (hint === null ? view.message : hint),
      };
    }

    /** Human-readable reason the header sync button is disabled, or null. */
    function syncBlockedHint(sessionId, configured, tokenPresent) {
      if (sessionId === null) return '缺少会话上下文，无法同步';
      if (configured !== true) return '当前会话未绑定工作区，无法同步';
      if (tokenPresent !== true) return '请先在设置里配置平台 token';
      return null;
    }

    /** Non-negative integer sync stat (the host already sanitizes). */
    function statNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
    }

    function createActionId() {
      try {
        if (typeof crypto !== 'undefined' && crypto !== null && typeof crypto.randomUUID === 'function') {
          return crypto.randomUUID();
        }
      } catch {
        // Fall through to the time+random form.
      }
      return String(Date.now()) + Math.random();
    }

    function createDemoCode() {
      const stamp = Date.now().toString(36).toUpperCase();
      const salt = Math.random().toString(36).slice(2, 5).toUpperCase();
      return `P1-${stamp}-${salt}`;
    }

    /**
     * Three-state confirmation: `true`/`false` from the platform dialog, or
     * `null` when no usable `window.confirm` exists (Electron/embedded webview).
     * Callers must treat `null` as "render the in-component confirm" — never as
     * an automatic yes.
     */
    function confirmDialog(message) {
      try {
        if (typeof window === 'undefined' || window === null) return null;
        if (typeof window.confirm !== 'function') return null;
        return window.confirm(message) === true;
      } catch {
        return null;
      }
    }

    function snapshotUrlFor(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return null;
      return `${API.snapshot}?sessionId=${encodeURIComponent(sessionId)}`;
    }

    // ---------------------------------------------------------------------
    // HTTP layer
    // ---------------------------------------------------------------------

    /**
     * One JSON request. Never throws: transport failures, 415/403/409/500 and
     * malformed bodies all resolve to `{ ok:false, code, message, status }` so
     * callers can render a banner instead of crashing the slot.
     */
    async function requestJson(path, options = {}) {
      const method = options.method === 'POST' ? 'POST' : 'GET';
      const headers = { Accept: 'application/json' };
      let body;
      if (method === 'POST') {
        headers['Content-Type'] = 'application/json';
        try {
          body = JSON.stringify(options.body ?? {});
        } catch {
          return { ok: false, code: 'client-serialize-error', message: '请求数据无法序列化', status: null };
        }
      }

      let response;
      try {
        response = await fetch(path, {
          method,
          headers,
          body,
          signal: options.signal,
          credentials: 'same-origin',
        });
      } catch (error) {
        if (error && error.name === 'AbortError') {
          return { ok: false, aborted: true, code: 'aborted', message: '请求已取消', status: null };
        }
        return {
          ok: false,
          code: 'network-error',
          message: '无法连接本地服务，请确认插件宿主已加载',
          status: null,
        };
      }

      const status = typeof response.status === 'number' ? response.status : null;
      let payload = null;
      let parsed = true;
      try {
        payload = await response.json();
      } catch {
        parsed = false;
      }

      const payloadOk = payload !== null && typeof payload === 'object' && payload.ok === true;
      if (!response.ok || !payloadOk) {
        const fallback = parsed
          ? `请求失败（HTTP ${status ?? '未知'}）`
          : `服务返回了非 JSON 响应（HTTP ${status ?? '未知'}）`;
        return {
          ok: false,
          code: typeof payload?.code === 'string' && payload.code !== ''
            ? payload.code
            : (response.ok ? 'invalid-response' : `http-${status ?? 'error'}`),
          message: typeof payload?.message === 'string' && payload.message !== ''
            ? payload.message
            : fallback,
          status,
          stage: typeof payload?.stage === 'string' ? payload.stage : null,
        };
      }

      return { ok: true, data: payload };
    }

    /** Same-origin JSON API used by the board (`api.get` / `api.post`). */
    const api = Object.freeze({
      get(path, signal) {
        return requestJson(path, { method: 'GET', signal });
      },
      post(path, body, signal) {
        return requestJson(path, { method: 'POST', body, signal });
      },
    });

    // ---------------------------------------------------------------------
    // Data hook: snapshot polling with stale-response protection
    // ---------------------------------------------------------------------

    function useInitialState(url) {
      return React.useState(() => ({
        data: null,
        error: null,
        loading: url !== null,
        refreshing: false,
      }));
    }

    /**
     * Poll `url` every `intervalMs`; manual `refresh()` shares the same request
     * sequence, so a slow stale response can never overwrite a newer one.
     */
    function usePolling(url, intervalMs) {
      const [state, setState] = useInitialState(url);
      const seqRef = React.useRef(0);
      const aliveRef = React.useRef(false);
      const controllerRef = React.useRef(null);

      const load = React.useCallback(async () => {
        if (url === null) return;
        const seq = seqRef.current + 1;
        seqRef.current = seq;

        if (controllerRef.current !== null) {
          try {
            controllerRef.current.abort();
          } catch {
            // Already settled.
          }
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        controllerRef.current = controller;

        setState((current) => ({
          ...current,
          loading: current.data === null,
          refreshing: current.data !== null,
        }));

        const result = await api.get(url, controller === null ? undefined : controller.signal);
        if (!aliveRef.current || seq !== seqRef.current) return;
        if (result.aborted === true) return;

        if (result.ok) {
          setState({ data: normalizeSnapshot(result.data), error: null, loading: false, refreshing: false });
          return;
        }
        setState((current) => ({
          ...current,
          loading: false,
          refreshing: false,
          error: toErrorView(result),
        }));
      }, [url]);

      React.useEffect(() => {
        aliveRef.current = true;
        seqRef.current += 1;
        if (url === null) {
          setState({ data: null, error: null, loading: false, refreshing: false });
          return () => {
            aliveRef.current = false;
          };
        }

        setState({ data: null, error: null, loading: true, refreshing: false });
        load();
        const timer = setInterval(load, intervalMs);

        return () => {
          aliveRef.current = false;
          seqRef.current += 1;
          clearInterval(timer);
          try {
            if (controllerRef.current !== null) controllerRef.current.abort();
          } catch {
            // Already settled.
          }
          controllerRef.current = null;
        };
      }, [url, intervalMs, load]);

      const refresh = React.useCallback(() => load(), [load]);
      const dismissError = React.useCallback(() => {
        setState((current) => ({ ...current, error: null }));
      }, []);

      return { ...state, refresh, dismissError };
    }

    /**
     * Local elapsed-seconds counter for a running analysis. Starts at 0 when
     * `active` first becomes true (or when `resetKey` changes, e.g. a different
     * ticket/analysis), ticks once a second, and resets/stops when `active`
     * turns false or the component unmounts. The host snapshot has no
     * per-ticket start timestamp, so this is deliberately an approximation
     * ("since the board first saw it running"), never persisted.
     */
    function useElapsedSeconds(active, resetKey) {
      const [seconds, setSeconds] = React.useState(0);
      React.useEffect(() => {
        if (active !== true) {
          setSeconds(0);
          return undefined;
        }
        const startedAt = Date.now();
        setSeconds(0);
        const timer = setInterval(() => {
          setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
        }, 1000);
        return () => clearInterval(timer);
      }, [active, resetKey]);
      return seconds;
    }

    // ---------------------------------------------------------------------
    // Presentational components
    // ---------------------------------------------------------------------

    function Badge({ label, tone }) {
      const palette = TONES[tone] ?? TONES.neutral;
      return h('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          flex: '0 0 auto',
          padding: '0 6px',
          height: 18,
          border: `0.5px solid ${palette.border}`,
          borderRadius: 999,
          background: palette.background,
          color: palette.color,
          fontSize: 11,
          lineHeight: '16px',
          whiteSpace: 'nowrap',
          boxSizing: 'border-box',
        },
      }, textOf(label, '—'));
    }

    function Card({ title, aside, children }) {
      const body = Array.isArray(children)
        ? children
        : (children === undefined ? [] : [children]);
      const header = title === undefined
        ? null
        : h('div', { style: cardHeaderStyle },
          h('h3', { style: cardTitleStyle }, textOf(title)),
          aside === undefined || aside === null
            ? null
            : h('span', { style: cardAsideStyle }, textOf(aside)));
      return h('section', { style: cardStyle }, header, ...body);
    }

    function TextField({ label, value }) {
      const text = textOf(value);
      if (text === '') return null;
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
        h('div', { style: fieldLabelStyle }, textOf(label)),
        h('div', { style: { ...fieldValueStyle, whiteSpace: 'pre-wrap' } }, text));
    }

    function ListField({ label, values }) {
      const list = Array.isArray(values)
        ? values.filter((value) => value !== null && value !== undefined && textOf(value) !== '')
        : [];
      if (list.length === 0) return null;
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
        h('div', { style: fieldLabelStyle }, textOf(label)),
        h('ul', {
          style: {
            margin: 0,
            paddingLeft: 18,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            color: C.text,
          },
        }, list.map((value, index) => h('li', {
          key: `list-${index}`,
          style: { fontSize: 12.5, lineHeight: '19px', wordBreak: 'break-word', overflowWrap: 'anywhere' },
        }, clip(value, 500)))));
    }

    function ErrorBanner({ title, error, busy, onRetry, onDismiss }) {
      const code = errorCodeText(error);
      return h('div', {
        role: 'alert',
        style: {
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          padding: '8px 12px',
          borderBottom: `0.5px solid ${C.border}`,
          background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)',
          flex: '0 0 auto',
        },
      },
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: C.error, lineHeight: '18px' } },
            textOf(title), code === '' ? '' : `（${code}）`),
          h('div', {
            style: {
              fontSize: 12,
              lineHeight: '18px',
              color: C.textSecondary,
              wordBreak: 'break-word',
              overflowWrap: 'anywhere',
            },
          }, textOf(error.message, '未知错误')),
          error.stage === null || error.stage === undefined
            ? null
            : h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } }, `阶段：${textOf(error.stage)}`)),
        h('button', {
          type: 'button',
          onClick: onRetry,
          disabled: busy === true,
          style: smallButtonStyle(busy === true),
        }, '重试'),
        h('button', {
          type: 'button',
          onClick: onDismiss,
          'aria-label': '关闭错误提示',
          style: smallButtonStyle(false),
        }, '关闭'));
    }

    function smallButtonStyle(disabled) {
      return {
        ...baseButtonStyle,
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? 'default' : 'pointer',
      };
    }

    function primaryButtonStyle(disabled) {
      return {
        ...baseButtonStyle,
        background: C.primaryFill,
        color: C.primaryLabel,
        border: `0.5px solid ${C.primaryFill}`,
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? 'default' : 'pointer',
      };
    }

    function actionButtonStyle(tone, disabled) {
      if (tone === 'primary') return primaryButtonStyle(disabled);
      if (tone === 'danger') {
        return {
          ...baseButtonStyle,
          color: C.error,
          border: `0.5px solid ${C.borderStrong}`,
          opacity: disabled ? 0.55 : 1,
          cursor: disabled ? 'default' : 'pointer',
        };
      }
      return smallButtonStyle(disabled);
    }

    function chipStyle(selected) {
      return {
        font: 'inherit',
        fontSize: 11,
        lineHeight: '16px',
        padding: '1px 8px',
        borderRadius: 999,
        border: `0.5px solid ${selected ? C.brand : C.border}`,
        background: selected ? C.selected : 'transparent',
        color: selected ? C.text : C.textSecondary,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        boxSizing: 'border-box',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      };
    }

    /**
     * Multi-select chips. `options` may mix plain ticket-derived values and
     * `snapshot.dicts` entries (`{key,value,color}`); the dictionary key is the
     * React key, the display label is the dictionary `value`, and a valid
     * colour becomes a small swatch. Selected values that dropped out of the
     * option list stay visible as plain chips so they can be deselected.
     */
    function FilterChips({ label, options, selected, onToggle, formatOption }) {
      if (options.length === 0 && selected.length === 0) return null;
      const entries = [];
      const index = new Map();
      for (const option of options) {
        const entry = filterOptionEntry(option);
        if (entry === null || index.has(entry.value)) continue;
        index.set(entry.value, entry);
        entries.push(entry);
      }
      for (const value of selected) {
        if (index.has(value)) continue;
        const entry = filterOptionEntry(value);
        if (entry === null) continue;
        index.set(value, entry);
        entries.push(entry);
      }
      const format = typeof formatOption === 'function' ? formatOption : null;
      return h('div', {
        style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, minWidth: 0 },
        role: 'group',
        'aria-label': `${textOf(label)}筛选`,
      },
        h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary, marginRight: 2 } }, textOf(label)),
        entries.map((entry) => h('button', {
          key: `chip-${entry.key}`,
          type: 'button',
          'aria-pressed': selected.includes(entry.value),
          onClick: () => onToggle(entry.value),
          style: chipStyle(selected.includes(entry.value)),
        },
          entry.color === null
            ? null
            : h('span', {
              'aria-hidden': 'true',
              style: {
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: entry.color,
                flex: '0 0 auto',
              },
            }),
          h('span', null, format === null ? entry.label : format(entry.value)))));
    }

    /**
     * In-component fallback for the platform prompt dialog and for a missing
     * `window.confirm`.
     * `mode:'reason'` renders a reason input (Enter submits, Esc cancels); empty
     * input is normalized to the documented default by the caller.
     */
    function ActionDialog({ request, busy, onCancel, onConfirm }) {
      const isReason = request !== null && request.mode === 'reason';
      const [reason, setReason] = React.useState('');
      const inputRef = React.useRef(null);

      React.useEffect(() => {
        if (!isReason) return;
        try {
          if (inputRef.current !== null && typeof inputRef.current.focus === 'function') inputRef.current.focus();
        } catch {
          // Focus is best-effort; the dialog still works.
        }
      }, [isReason]);

      const submit = () => {
        if (busy === true) return;
        onConfirm(isReason ? reason : undefined);
      };

      return h('form', {
        'data-bug-board-dialog': isReason ? 'reason' : 'confirm',
        onSubmit: (event) => {
          event.preventDefault();
          submit();
        },
        onKeyDown: (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          onCancel();
        },
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 7,
          padding: '9px 12px',
          borderBottom: `0.5px solid ${C.border}`,
          background: C.surfaceAlt,
          flex: '0 0 auto',
          minWidth: 0,
        },
      },
        h('div', {
          style: { fontSize: 12, lineHeight: '18px', color: C.text, fontWeight: 600, wordBreak: 'break-word' },
        }, textOf(request === null ? undefined : request.descriptor.confirm, '确认执行该动作？')),
        isReason
          ? h('input', {
            ref: inputRef,
            type: 'text',
            value: reason,
            onChange: (event) => setReason(event.target.value),
            placeholder: '驳回原因（可留空，默认「未填写驳回原因」）',
            'aria-label': '驳回原因',
            disabled: busy === true,
            style: {
              font: 'inherit',
              fontSize: 12,
              lineHeight: '18px',
              padding: '3px 8px',
              borderRadius: 6,
              border: `0.5px solid ${C.borderStrong}`,
              background: 'transparent',
              color: C.text,
              minWidth: 0,
              boxSizing: 'border-box',
            },
          })
          : null,
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 6 } },
          h('button', {
            type: 'button',
            onClick: onCancel,
            disabled: busy === true,
            style: smallButtonStyle(busy === true),
          }, '取消'),
          h('button', {
            type: 'submit',
            disabled: busy === true,
            style: primaryButtonStyle(busy === true),
          }, busy === true ? '处理中…' : (isReason ? '确认驳回' : '确认'))));
    }

    /** One workspace-settings row: label, one-line help, input, inline error. */
    function SettingsField({ field, value, error, disabled, inputRef, onChange }) {
      const invalid = typeof error === 'string' && error !== '';
      return h('label', {
        style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
      },
        h('span', {
          style: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', minWidth: 0 },
        },
          h('span', {
            style: { fontSize: 12, fontWeight: 600, lineHeight: '18px', color: C.text },
          }, textOf(field.label)),
          field.required === true
            ? h('span', {
              style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary },
            }, '必填')
            : null),
        h('span', {
          style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary, wordBreak: 'break-word' },
        }, textOf(field.hint)),
        h('input', {
          ref: inputRef,
          type: 'text',
          value: typeof value === 'string' ? value : '',
          onChange: (event) => onChange(field.key, event.target.value),
          placeholder: textOf(field.placeholder),
          disabled: disabled === true,
          'aria-label': textOf(field.label),
          'aria-invalid': invalid ? 'true' : undefined,
          spellCheck: false,
          style: {
            font: 'inherit',
            fontSize: 12,
            lineHeight: '18px',
            padding: '4px 8px',
            borderRadius: 6,
            border: `0.5px solid ${invalid ? C.error : C.borderStrong}`,
            background: 'transparent',
            color: C.text,
            width: '100%',
            minWidth: 0,
            boxSizing: 'border-box',
            opacity: disabled === true ? 0.55 : 1,
          },
        }),
        invalid
          ? h('span', {
            role: 'alert',
            style: { fontSize: 11, lineHeight: '16px', color: C.error, wordBreak: 'break-word' },
          }, textOf(error))
          : null);
    }

    /**
     * One boolean settings row. Rendered as a `role=switch` button so the track
     * and knob use theme tokens (no native checkbox colour leaks through).
     */
    function SettingsToggle({ label, hint, checked, disabled, onChange }) {
      const on = checked === true;
      const locked = disabled === true;
      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
      },
        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
        },
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': on ? 'true' : 'false',
            'aria-label': textOf(label),
            onClick: () => onChange(!on),
            disabled: locked,
            style: {
              position: 'relative',
              flex: '0 0 auto',
              width: 30,
              height: 18,
              padding: 0,
              borderRadius: 999,
              border: `0.5px solid ${on ? C.brand : C.borderStrong}`,
              background: on ? C.primaryFill : 'transparent',
              cursor: locked ? 'default' : 'pointer',
              boxSizing: 'border-box',
              opacity: locked ? 0.55 : 1,
            },
          },
            h('span', {
              'aria-hidden': 'true',
              style: {
                position: 'absolute',
                top: 2,
                left: on ? 16 : 2,
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: on ? C.primaryLabel : C.textTertiary,
                transition: 'left 120ms ease',
              },
            })),
          h('span', {
            style: { fontSize: 12, fontWeight: 600, lineHeight: '18px', color: C.text, minWidth: 0 },
          }, textOf(label))),
        h('span', {
          style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary, wordBreak: 'break-word' },
        }, textOf(hint)));
    }

    /**
     * Title hint for the surfaces that share the token mutation gate: while one
     * token card saves/clears, the other card and the settings save button are
     * disabled but must still explain why.
     */
    const TOKEN_MUTATION_BUSY_HINT = '正在保存 token，请稍候';

    /**
     * Write-only token card shared by the platform and GitLab connection
     * sections (P5 extracts it so both flow exactly the same way).
     *
     * The input is `type=password`, starts empty on every open, and is cleared
     * by the board after a successful save; the status dot follows the polled
     * `snapshot.<service>.tokenPresent`, never a client copy of the value.
     * Save/clear are disabled while the session has no bound workspace (the
     * host token routes are profile-global, but the panel keeps the same gate
     * as every other write) and while another request is in flight. The shared
     * board mutation gate means a save/clear on the OTHER card (or a settings
     * save) would silently no-op here, so `otherTokenBusy` disables this card's
     * buttons too and names the reason in their title.
     */
    /** Map a platform-login failure to actionable static copy (never raw codes). */
    function platformLoginErrorView(result) {
      const view = toErrorView(result);
      const hints = {
        'invalid-credentials': '账号或密码错误，请检查后重试',
        'captcha-invalid': '验证码错误或已过期，请点击图片换一张',
        'invalid-input': '请输入正确的账号、密码和验证码',
        'invalid-base-url': '平台地址无效，请先检查「平台地址」设置',
        'invalid-settings': '平台地址无效，请先检查「平台地址」设置',
        'login-timeout': '登录请求超时，请稍后重试',
        'login-unavailable': '无法连接平台登录服务，请检查网络后重试',
        'login-bad-response': '平台登录响应异常，请稍后重试',
        'login-failed': '平台登录失败，请稍后重试',
        'login-unavailable-service': '平台登录服务不可用，请稍后重试',
        'credentials-unavailable': '凭据服务不可用，暂时无法保存 token',
        'captcha-unavailable': '获取验证码失败，请稍后重试',
        'captcha-bad-response': '平台验证码响应异常，请稍后重试',
      };
      const hint = ownServiceValue(hints, view.code)
        ?? (view.status === 401 ? hints['invalid-credentials'] : null)
        ?? (view.status === 503 ? hints['login-unavailable-service'] : null)
        ?? (view.status === 504 ? hints['login-timeout'] : null);
      // `login-failed` carries the platform's sanitized reason in view.message;
      // keep it instead of hiding it behind the generic static hint.
      if (view.code === 'login-failed' && typeof view.message === 'string' && view.message.trim() !== '') {
        return { ...view, title: '平台登录', message: view.message };
      }
      return { ...view, title: '平台登录', message: hint === null ? view.message : hint };
    }

    /**
     * In-board platform login form (P6): account + password + image captcha.
     * The password is a one-shot field: it is cleared after success and never
     * stored; only the account name is remembered (localStorage).
     */
    function PlatformLoginBlock({
      username,
      password,
      code,
      captcha,
      busy,
      error,
      tokenPresent,
      disabled,
      canSave,
      tokenBusy,
      otherTokenBusy,
      onUsernameChange,
      onPasswordChange,
      onCodeChange,
      onRefreshCaptcha,
      onSubmit,
    }) {
      const locked = disabled === true || busy === true || canSave !== true
        || tokenBusy === true || otherTokenBusy === true;
      const image = captcha !== null && typeof captcha === 'object' && typeof captcha.image === 'string'
        ? captcha.image
        : null;
      const ready = typeof username === 'string' && username.trim() !== ''
        && typeof password === 'string' && password !== ''
        && typeof code === 'string' && code.trim() !== ''
        && captcha !== null && typeof captcha === 'object' && typeof captcha.key === 'string' && captcha.key !== '';
      // Only lock while a request is in flight: clicking with missing fields
      // shows an explicit message instead of a dead button.
      const submitDisabled = locked;
      const inputStyle = {
        font: 'inherit',
        fontSize: 12,
        lineHeight: '18px',
        padding: '4px 8px',
        borderRadius: 6,
        border: `0.5px solid ${C.borderStrong}`,
        background: 'transparent',
        color: C.text,
        flex: '1 1 120px',
        minWidth: 0,
        boxSizing: 'border-box',
        opacity: locked ? 0.55 : 1,
      };
      return h('div', {
        'data-bug-platform-login': 'form',
        style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
      },
        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 },
        },
          h('span', {
            'aria-hidden': 'true',
            style: {
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: tokenPresent === true ? C.success : C.textTertiary,
              flex: '0 0 auto',
            },
          }),
          h('span', {
            role: 'status',
            style: {
              fontSize: 11,
              lineHeight: '16px',
              color: tokenPresent === true ? C.success : C.textTertiary,
            },
          }, tokenPresent === true ? PLATFORM_LOGIN_UI.loggedIn : PLATFORM_LOGIN_UI.loggedOut),
          busy === true
            ? h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } }, '处理中…')
            : null),
        h('div', {
          style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary, wordBreak: 'break-word' },
        }, PLATFORM_LOGIN_HINT),
        error === null || error === undefined
          ? null
          : h('div', {
            role: 'alert',
            style: {
              padding: '5px 8px',
              border: `0.5px solid ${TONES.danger.border}`,
              borderRadius: 6,
              background: TONES.danger.background,
              color: C.error,
              fontSize: 11.5,
              lineHeight: '17px',
              minWidth: 0,
              wordBreak: 'break-word',
            },
          }, typeof error.message === 'string' && error.message !== '' ? error.message : '平台登录失败'),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', minWidth: 0 } },
          h('input', {
            type: 'text',
            value: username,
            onChange: (event) => onUsernameChange(event.target.value),
            placeholder: '平台账号',
            'aria-label': '平台账号',
            autoComplete: 'username',
            disabled: locked,
            style: inputStyle,
          }),
          h('input', {
            type: 'password',
            value: password,
            onChange: (event) => onPasswordChange(event.target.value),
            placeholder: '平台密码',
            'aria-label': '平台密码',
            autoComplete: 'current-password',
            spellCheck: false,
            disabled: locked,
            style: inputStyle,
          })),
        h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 } },
          h('input', {
            type: 'text',
            value: code,
            onChange: (event) => onCodeChange(event.target.value),
            placeholder: '图形验证码',
            'aria-label': '图形验证码',
            autoComplete: 'off',
            spellCheck: false,
            maxLength: 16,
            disabled: locked,
            style: { ...inputStyle, flex: '1 1 80px' },
          }),
          image === null
            ? h('button', {
              type: 'button',
              onClick: onRefreshCaptcha,
              disabled: locked,
              style: smallButtonStyle(locked),
            }, PLATFORM_LOGIN_UI.fetchCaptcha)
            : h('button', {
              type: 'button',
              onClick: onRefreshCaptcha,
              disabled: locked,
              title: PLATFORM_LOGIN_UI.refreshCaptcha,
              'aria-label': PLATFORM_LOGIN_UI.refreshCaptcha,
              style: {
                padding: 0,
                border: `0.5px solid ${C.border}`,
                borderRadius: 6,
                background: C.surfaceAlt,
                cursor: locked ? 'default' : 'pointer',
                flex: '0 0 auto',
                lineHeight: 0,
                overflow: 'hidden',
                opacity: locked ? 0.55 : 1,
              },
            }, h('img', {
              src: image,
              alt: '图形验证码',
              width: 96,
              height: 32,
              style: { display: 'block', width: 96, height: 32, objectFit: 'cover' },
            }))),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 } },
          h('button', {
            type: 'button',
            onClick: onSubmit,
            disabled: submitDisabled,
            'aria-busy': busy === true || undefined,
            title: canSave === true ? undefined : SETTINGS_UNBOUND_HINT,
            style: primaryButtonStyle(submitDisabled),
          }, busy === true ? PLATFORM_LOGIN_UI.submitting : PLATFORM_LOGIN_UI.submit),
          h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary, minWidth: 0 } },
            PLATFORM_LOGIN_UI.passwordHint)));
    }

    function TokenCard({
      scope,
      statusText,
      readyHint,
      placeholder,
      ariaLabel,
      tokenDraft,
      tokenBusy,
      otherTokenBusy,
      tokenPresent,
      disabled,
      canSave,
      onTokenChange,
      onSaveToken,
      onClearToken,
    }) {
      const tokenLocked = disabled === true || tokenBusy === true || canSave !== true;
      const otherBusy = otherTokenBusy === true;
      const actionLocked = tokenLocked || otherBusy;
      const saveTokenDisabled = actionLocked || tokenDraft.trim() === '';
      const clearTokenDisabled = actionLocked || tokenPresent !== true;
      const gateHint = canSave === true ? readyHint : SETTINGS_UNBOUND_HINT;
      const dotColor = tokenPresent === true ? C.success : C.textTertiary;

      return h('div', {
        'data-bug-token-card': scope,
        style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      },
        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 },
        },
          h('span', {
            'aria-hidden': 'true',
            style: {
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: dotColor,
              flex: '0 0 auto',
            },
          }),
          h('span', {
            role: 'status',
            style: {
              fontSize: 11,
              lineHeight: '16px',
              color: tokenPresent === true ? C.success : C.textTertiary,
            },
          }, statusText),
          tokenBusy === true
            ? h('span', {
              style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary },
            }, '处理中…')
            : null),
        h('input', {
          type: 'password',
          value: tokenDraft,
          onChange: (event) => onTokenChange(event.target.value),
          placeholder,
          disabled: tokenLocked,
          'aria-label': ariaLabel,
          autoComplete: 'new-password',
          spellCheck: false,
          style: {
            font: 'inherit',
            fontSize: 12,
            lineHeight: '18px',
            padding: '4px 8px',
            borderRadius: 6,
            border: `0.5px solid ${C.borderStrong}`,
            background: 'transparent',
            color: C.text,
            width: '100%',
            minWidth: 0,
            boxSizing: 'border-box',
            opacity: tokenLocked ? 0.55 : 1,
          },
        }),
        h('div', {
          style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary, wordBreak: 'break-word' },
        }, gateHint),
        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 },
        },
          h('button', {
            type: 'button',
            onClick: onSaveToken,
            disabled: saveTokenDisabled,
            'aria-busy': tokenBusy === true || undefined,
            title: otherBusy
              ? TOKEN_MUTATION_BUSY_HINT
              : (canSave !== true
                ? SETTINGS_UNBOUND_HINT
                : (tokenDraft.trim() === '' ? '请先粘贴 token' : '保存 token')),
            style: primaryButtonStyle(saveTokenDisabled),
          }, tokenBusy === true ? '保存中…' : '保存 token'),
          h('button', {
            type: 'button',
            onClick: onClearToken,
            disabled: clearTokenDisabled,
            title: otherBusy
              ? TOKEN_MUTATION_BUSY_HINT
              : (tokenPresent === true ? '清除已保存的 token' : '当前没有已保存的 token'),
            style: smallButtonStyle(clearTokenDisabled),
          }, '清除'),
          h('span', {
            style: { marginLeft: 'auto', fontSize: 11, lineHeight: '16px', color: C.textTertiary },
          }, '不会回显 token')));
    }

    /**
     * 「平台连接」 section: platform base URL, project-code prefix, the
     * write-only platform token card and the P5 write-back switch.
     */
    function PlatformConnectionSection({
      draft,
      errors,
      disabled,
      canSave,
      tokenDraft,
      tokenBusy,
      otherTokenBusy,
      tokenPresent,
      loginUsername,
      loginPassword,
      loginCode,
      loginCaptcha,
      loginBusy,
      loginError,
      baseUrlInputRef,
      onFieldChange,
      onTokenChange,
      onSaveToken,
      onClearToken,
      onLoginUsernameChange,
      onLoginPasswordChange,
      onLoginCodeChange,
      onRefreshCaptcha,
      onLoginSubmit,
    }) {
      // The manual token paste is a documented fallback; keep it collapsed so
      // the normal path (account + captcha login) stays the obvious one.
      const [manualOpen, setManualOpen] = React.useState(false);
      return h('section', {
        'data-bug-platform-connection': 'section',
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          paddingBottom: 10,
          borderBottom: `0.5px solid ${C.border}`,
          minWidth: 0,
        },
      },
        h('div', {
          style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0 },
        },
          h('h3', {
            style: {
              margin: 0,
              fontSize: 12.5,
              fontWeight: 600,
              lineHeight: '18px',
              color: C.text,
            },
          }, '平台连接'),
          h('span', {
            style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary, minWidth: 0 },
          }, '登录后 token 仅保存在宿主凭据服务')),
        h('div', {
          style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary, wordBreak: 'break-word' },
        }, PLATFORM_SECTION_HINT),
        h(SettingsField, {
          field: PLATFORM_BASE_URL_FIELD,
          value: draft.platformBaseUrl,
          error: errors.platformBaseUrl,
          disabled: disabled === true,
          inputRef: baseUrlInputRef,
          onChange: onFieldChange,
        }),
        h(SettingsField, {
          field: PLATFORM_PROJECT_CODE_FIELD,
          value: draft.platformProjectCode,
          error: errors.platformProjectCode,
          disabled: disabled === true,
          onChange: onFieldChange,
        }),
        h(PlatformLoginBlock, {
          username: loginUsername,
          password: loginPassword,
          code: loginCode,
          captcha: loginCaptcha,
          busy: loginBusy === true,
          error: loginError,
          tokenPresent,
          disabled: disabled === true,
          canSave,
          tokenBusy,
          otherTokenBusy,
          onUsernameChange: onLoginUsernameChange,
          onPasswordChange: onLoginPasswordChange,
          onCodeChange: onLoginCodeChange,
          onRefreshCaptcha,
          onSubmit: onLoginSubmit,
        }),
        h('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
        },
          h('button', {
            type: 'button',
            onClick: () => setManualOpen((current) => current !== true),
            'aria-expanded': manualOpen === true ? 'true' : 'false',
            disabled: disabled === true,
            style: {
              ...smallButtonStyle(disabled === true),
              alignSelf: 'flex-start',
              padding: '1px 8px',
              fontSize: 11,
              lineHeight: '16px',
            },
          }, manualOpen === true ? PLATFORM_LOGIN_UI.manualToggleOpen : PLATFORM_LOGIN_UI.manualToggle),
          manualOpen === true
            ? h(TokenCard, {
              scope: 'platform',
              statusText: tokenPresent === true ? PLATFORM_TOKEN_PRESENT : PLATFORM_TOKEN_ABSENT,
              readyHint: PLATFORM_TOKEN_HINT,
              placeholder: '粘贴平台 access-token',
              ariaLabel: '平台 token',
              tokenDraft,
              tokenBusy,
              otherTokenBusy,
              tokenPresent,
              disabled,
              canSave,
              onTokenChange,
              onSaveToken,
              onClearToken,
            })
            : null),
        h(SettingsToggle, {
          label: PLATFORM_WRITEBACK_LABEL,
          hint: PLATFORM_WRITEBACK_HINT,
          checked: draft.writebackStatus === true,
          disabled: disabled === true,
          onChange: (next) => onFieldChange('writebackStatus', next),
        }));
    }

    /**
     * 「GitLab 连接」 section: GitLab API root and the write-only GitLab token
     * card (P5). The token is saved through `POST /api/gitlab-token` with the
     * same contract as the platform token: string saves, `null` clears, and the
     * value is never echoed back.
     */
    function GitlabConnectionSection({
      draft,
      errors,
      disabled,
      canSave,
      tokenDraft,
      tokenBusy,
      otherTokenBusy,
      tokenPresent,
      onFieldChange,
      onTokenChange,
      onSaveToken,
      onClearToken,
    }) {
      return h('section', {
        'data-bug-gitlab-connection': 'section',
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          paddingBottom: 10,
          borderBottom: `0.5px solid ${C.border}`,
          minWidth: 0,
        },
      },
        h('div', {
          style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0 },
        },
          h('h3', {
            style: {
              margin: 0,
              fontSize: 12.5,
              fontWeight: 600,
              lineHeight: '18px',
              color: C.text,
            },
          }, 'GitLab 连接'),
          h('span', {
            style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary, minWidth: 0 },
          }, '登录后 token 仅保存在宿主凭据服务')),
        h('div', {
          style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary, wordBreak: 'break-word' },
        }, GITLAB_SECTION_HINT),
        h(SettingsField, {
          field: GITLAB_BASE_URL_FIELD,
          value: draft.gitlabBaseUrl,
          error: errors.gitlabBaseUrl,
          disabled: disabled === true,
          onChange: onFieldChange,
        }),
        h(TokenCard, {
          scope: 'gitlab',
          statusText: tokenPresent === true ? GITLAB_TOKEN_PRESENT : GITLAB_TOKEN_ABSENT,
          readyHint: GITLAB_TOKEN_HINT,
          placeholder: '粘贴 GitLab Personal Access Token',
          ariaLabel: 'GitLab token',
          tokenDraft,
          tokenBusy,
          otherTokenBusy,
          tokenPresent,
          disabled,
          canSave,
          onTokenChange,
          onSaveToken,
          onClearToken,
        }));
    }

    /**
     * In-panel settings overlay (same board view, not a new tab).
     *
     * Opens read-only when the session has no bound workspace: the hint names
     * the reason and the save button stays disabled. Esc closes (unless a save
     * is in flight), Tab is trapped inside the panel, and the first field is
     * focused on open; the board returns focus to the header button on close.
     */
    function SettingsPanel({
      draft,
      errors,
      dirty,
      saving,
      configured,
      sessionMissing,
      workspaceKnown,
      workspacePath,
      tokenDraft,
      tokenBusy,
      tokenPresent,
      gitlabTokenDraft,
      gitlabTokenBusy,
      gitlabTokenPresent,
      loginUsername,
      loginPassword,
      loginCode,
      loginCaptcha,
      loginBusy,
      loginError,
      onChange,
      onTokenChange,
      onSaveToken,
      onClearToken,
      onGitlabTokenChange,
      onSaveGitlabToken,
      onClearGitlabToken,
      onLoginUsernameChange,
      onLoginPasswordChange,
      onLoginCodeChange,
      onRefreshCaptcha,
      onLoginSubmit,
      onSave,
      onCancel,
    }) {
      const panelRef = React.useRef(null);
      const firstInputRef = React.useRef(null);
      const canSave = sessionMissing !== true && configured === true;
      // One shared mutation gate: while either token card saves/clears, the
      // panel's own 「保存」 button would silently no-op too. Keep it disabled
      // and name the reason instead of dropping the click.
      const tokenMutationBusy = tokenBusy === true || gitlabTokenBusy === true;
      const settingsSaveDisabled = saving === true || tokenMutationBusy || !canSave;

      React.useEffect(() => {
        const node = firstInputRef.current;
        if (node === null || node === undefined || typeof node.focus !== 'function') return;
        try {
          node.focus();
        } catch {
          // Focus is best-effort; the panel still works.
        }
      }, []);

      React.useEffect(() => {
        if (typeof window === 'undefined' || window === null) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          if (saving === true) return;
          onCancel();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [onCancel, saving]);

      const trapTab = (event) => {
        if (event.key !== 'Tab') return;
        const node = panelRef.current;
        if (node === null || node === undefined || typeof node.querySelectorAll !== 'function') return;
        let focusable;
        try {
          focusable = Array.from(node.querySelectorAll('input, button, a[href], select, textarea'));
        } catch {
          return;
        }
        const enabled = focusable.filter((item) => item.disabled !== true);
        if (enabled.length === 0) return;
        const first = enabled[0];
        const last = enabled[enabled.length - 1];
        if (event.shiftKey === true && event.target === first) {
          event.preventDefault();
          try { last.focus(); } catch { /* best-effort */ }
        } else if (event.shiftKey !== true && event.target === last) {
          event.preventDefault();
          try { first.focus(); } catch { /* best-effort */ }
        }
      };

      const hint = sessionMissing === true
        ? SETTINGS_NO_SESSION_HINT
        : (workspaceKnown !== true
          ? SETTINGS_LOADING_HINT
          : (configured !== true ? SETTINGS_UNBOUND_HINT : SETTINGS_SAVE_HINT));
      const hintTone = sessionMissing === true || workspaceKnown !== true || configured !== true
        ? TONES.warn
        : TONES.neutral;
      const settingsSaveTitle = tokenMutationBusy
        ? TOKEN_MUTATION_BUSY_HINT
        : (canSave ? '保存设置' : hint);
      const workspaceLine = sessionMissing === true
        ? '缺少会话上下文'
        : (workspaceKnown !== true
          ? '正在读取工作区…'
          : (workspacePath === null ? '未绑定工作区' : `工作区：${baseName(workspacePath)}`));

      return h('div', {
        ref: panelRef,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '工作区设置',
        'data-bug-board-settings': 'panel',
        onKeyDown: trapTab,
        style: {
          position: 'absolute',
          inset: 0,
          zIndex: 10,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          minHeight: 0,
          background: 'var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1, transparent))',
          color: C.text,
          boxSizing: 'border-box',
        },
      },
        h('div', {
          style: {
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '10px 12px',
            borderBottom: `0.5px solid ${C.border}`,
            flex: '0 0 auto',
            minWidth: 0,
          },
        },
          h('div', {
            style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
          },
            h('div', {
              style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 },
            },
              h('div', {
                style: { fontSize: 13, fontWeight: 600, lineHeight: '19px', color: C.text },
              }, '设置'),
              dirty === true ? h(Badge, { label: '未保存', tone: 'warn' }) : null),
            h('div', {
              title: workspacePath === null || workspacePath === undefined ? undefined : workspacePath,
              style: {
                fontSize: 11,
                lineHeight: '16px',
                color: C.textTertiary,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            }, workspaceLine)),
          h('button', {
            type: 'button',
            onClick: onCancel,
            disabled: saving === true,
            style: smallButtonStyle(saving === true),
          }, '关闭')),
        h('div', {
          role: 'note',
          style: {
            margin: '8px 12px 0',
            padding: '6px 8px',
            border: `0.5px solid ${hintTone.border}`,
            borderRadius: 6,
            background: hintTone.background,
            color: hintTone.color,
            fontSize: 11,
            lineHeight: '16px',
            flex: '0 0 auto',
            minWidth: 0,
            wordBreak: 'break-word',
            boxSizing: 'border-box',
          },
        }, hint),
        h('div', {
          style: {
            flex: '1 1 auto',
            minHeight: 0,
            minWidth: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            boxSizing: 'border-box',
          },
        },
          h(PlatformConnectionSection, {
            draft,
            errors,
            disabled: saving === true,
            canSave,
            tokenDraft,
            tokenBusy,
            // The shared board mutation gate also blocks this card while the
            // GitLab card is saving/clearing.
            otherTokenBusy: gitlabTokenBusy === true,
            tokenPresent,
            loginUsername,
            loginPassword,
            loginCode,
            loginCaptcha,
            loginBusy,
            loginError,
            baseUrlInputRef: firstInputRef,
            onFieldChange: onChange,
            onTokenChange,
            onSaveToken,
            onClearToken,
            onLoginUsernameChange,
            onLoginPasswordChange,
            onLoginCodeChange,
            onRefreshCaptcha,
            onLoginSubmit,
          }),
          h(GitlabConnectionSection, {
            draft,
            errors,
            disabled: saving === true,
            canSave,
            tokenDraft: gitlabTokenDraft,
            tokenBusy: gitlabTokenBusy,
            otherTokenBusy: tokenBusy === true,
            tokenPresent: gitlabTokenPresent,
            onFieldChange: onChange,
            onTokenChange: onGitlabTokenChange,
            onSaveToken: onSaveGitlabToken,
            onClearToken: onClearGitlabToken,
          }),
          SETTINGS_FIELDS.map((field) => h(SettingsField, {
            key: field.key,
            field,
            value: draft[field.key],
            error: errors[field.key],
            disabled: saving === true,
            onChange,
          }))),
        h('div', {
          style: {
            flex: '0 0 auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '10px 12px',
            borderTop: `0.5px solid ${C.border}`,
            background: C.surface,
            minWidth: 0,
            boxSizing: 'border-box',
          },
        },
          h('div', {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
              fontSize: 11,
              lineHeight: '16px',
              color: C.textTertiary,
              minWidth: 0,
            },
          },
            dirty === true
              ? h('span', {
                role: 'status',
                style: { color: TONES.warn.color },
              }, '有未保存的修改')
              : h('span', null, '无未保存修改'),
            h('span', { style: { marginLeft: 'auto' } }, `Esc 关闭 · 界面 ${CLIENT_BUILD}`)),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 6 } },
            h('button', {
              type: 'button',
              onClick: onCancel,
              disabled: saving === true,
              style: smallButtonStyle(saving === true),
            }, '取消'),
            h('button', {
              type: 'button',
              onClick: onSave,
              disabled: settingsSaveDisabled,
              'aria-busy': saving === true || undefined,
              title: settingsSaveTitle,
              style: primaryButtonStyle(settingsSaveDisabled),
            }, saving === true ? '保存中…' : '保存'))));
    }

    function BoardHeader({
      snapshot,
      refreshing,
      syncing,
      busy,
      configured,
      sessionId,
      statusOptions,
      typeOptions,
      filters,
      manualCode,
      settingsOpen,
      settingsBusy,
      settingsButtonRef,
      onManualCodeChange,
      onManualImport,
      onToggleFilter,
      onClearFilters,
      onRefresh,
      onSync,
      onCreateDemo,
      onToggleSettings,
    }) {
      const workspace = snapshot === null ? null : snapshot.workspace;
      const path = workspace !== null && typeof workspace.path === 'string' ? workspace.path : null;
      const sessionMissing = sessionId === null;
      const writable = !sessionMissing && configured === true;
      const platform = snapshot === null ? null : snapshot.platform;
      const tokenPresent = platform !== null && platform.tokenPresent === true;
      const lastSyncAt = platform === null ? null : platform.lastSyncAt;
      const lastSyncError = platform === null ? null : platform.lastSyncError;
      const syncBlocked = syncBlockedHint(sessionId, configured, tokenPresent);
      const name = path !== null && path !== '' ? baseName(path) : (snapshot === null ? '加载工作区…' : '未绑定工作区');
      const subtitle = sessionMissing
        ? '缺少会话上下文，当前为只读展示'
        : (snapshot === null
          ? '正在读取本工作区看板…'
          : (path === null
            ? '该会话没有工作区目录，看板仍显示本机全部工单'
            : (refreshing ? '刷新中…' : `Bug 工作流 · 每 ${POLL_INTERVAL_LABEL}自动刷新`)));
      const hasFilters = filters.status.length > 0 || filters.type.length > 0;
      const disabled = busy !== null;
      const syncingNow = syncing === true;
      const syncDisabled = syncingNow || disabled || syncBlocked !== null;
      const code = typeof manualCode === 'string' ? manualCode : '';
      const manualDisabled = disabled || syncingNow || !writable || code.trim() === '';

      return h('header', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 7,
          padding: '10px 12px',
          borderBottom: `0.5px solid ${C.border}`,
          background: C.surface,
          flex: '0 0 auto',
          minWidth: 0,
        },
      },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 8, minWidth: 0 } },
          h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', {
              title: path === null ? undefined : path,
              style: {
                fontSize: 13,
                fontWeight: 600,
                lineHeight: '19px',
                color: C.text,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            }, name),
            h('div', {
              style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
            }, subtitle)),
          h('button', {
            type: 'button',
            onClick: onRefresh,
            disabled: refreshing || disabled || sessionMissing,
            style: smallButtonStyle(refreshing || disabled || sessionMissing),
          }, refreshing ? '刷新中…' : '刷新'),
          h('button', {
            type: 'button',
            onClick: onSync,
            disabled: syncDisabled,
            'aria-busy': syncingNow || undefined,
            title: syncBlocked !== null
              ? syncBlocked
              : (syncingNow ? '正在从平台同步…' : '从平台同步「我的工单」'),
            style: smallButtonStyle(syncDisabled),
          }, syncingNow ? '同步中…' : '同步'),
          h('button', {
            ref: settingsButtonRef,
            type: 'button',
            onClick: onToggleSettings,
            disabled: disabled || sessionMissing || settingsBusy === true,
            'aria-expanded': settingsOpen === true ? 'true' : 'false',
            'aria-label': '设置',
            title: sessionMissing ? '缺少会话上下文，无法打开设置' : '工作区设置',
            style: smallButtonStyle(disabled || sessionMissing || settingsBusy === true),
          }, '设置'),
          h('button', {
            type: 'button',
            onClick: onCreateDemo,
            disabled: disabled || !writable,
            title: '创建一张演示工单（验收/联调用）',
            style: smallButtonStyle(disabled || !writable),
          }, busy === 'create' ? '创建中…' : '演示工单')),
        snapshot !== null
          ? h('div', {
            role: 'status',
            style: {
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'baseline',
              gap: '2px 10px',
              fontSize: 11,
              lineHeight: '16px',
              color: C.textTertiary,
              minWidth: 0,
            },
          },
            h('span', null, tokenPresent ? '平台 token 已配置' : '平台 token 未配置'),
            h('span', { title: fullTime(lastSyncAt) }, `上次同步：${lastSyncAt === null ? '从未同步' : formatTime(lastSyncAt)}`),
            lastSyncError === null
              ? null
              : h('span', {
                title: lastSyncError,
                style: { color: C.error, wordBreak: 'break-word', overflowWrap: 'anywhere' },
              }, `上次同步失败：${clip(lastSyncError, 300)}`),
            syncBlocked === null
              ? null
              : h('span', { style: { color: TONES.warn.color } }, `同步不可用：${syncBlocked}`))
          : null,
        snapshot !== null && !sessionMissing && configured !== true
          ? h('div', {
            role: 'note',
            style: {
              padding: '6px 8px',
              border: `0.5px solid ${TONES.warn.border}`,
              borderRadius: 6,
              background: TONES.warn.background,
              color: TONES.warn.color,
              fontSize: 11,
              lineHeight: '16px',
              minWidth: 0,
            },
          }, UNBOUND_WORKSPACE_HINT)
          : null,
        h('form', {
          onSubmit: (event) => {
            event.preventDefault();
            if (!manualDisabled) onManualImport();
          },
          'aria-label': '从平台导入工单',
          style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0 },
        },
          h('input', {
            type: 'text',
            value: code,
            onChange: (event) => onManualCodeChange(event.target.value),
            placeholder: '输入平台工单编号',
            'aria-label': '平台工单编号',
            disabled: disabled || !writable,
            style: {
              font: 'inherit',
              fontSize: 12,
              lineHeight: '18px',
              padding: '3px 8px',
              borderRadius: 6,
              border: `0.5px solid ${C.borderStrong}`,
              background: 'transparent',
              color: C.text,
              flex: '1 1 120px',
              minWidth: 0,
              boxSizing: 'border-box',
              opacity: disabled || !writable ? 0.55 : 1,
            },
          }),
          h('button', {
            type: 'submit',
            disabled: manualDisabled,
            title: tokenPresent ? '从平台导入该编号的工单' : '平台 token 未配置，请先在设置里配置',
            style: smallButtonStyle(manualDisabled),
          }, busy === 'manual-create' ? '导入中…' : '从平台导入'),
          h('span', {
            style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary, minWidth: 0 },
          }, tokenPresent ? PLATFORM_IMPORT_HINT : `${PLATFORM_IMPORT_HINT}（平台 token 未配置，请先在设置里配置）`)),
        h(FilterChips, {
          label: '状态',
          options: statusOptions,
          selected: filters.status,
          onToggle: (value) => onToggleFilter('status', value),
        }),
        h(FilterChips, {
          label: '类型',
          options: typeOptions,
          selected: filters.type,
          onToggle: (value) => onToggleFilter('type', value),
          formatOption: (value) => typeLabel(value, snapshot),
        }),
        hasFilters
          ? h('button', {
            type: 'button',
            onClick: onClearFilters,
            style: {
              ...smallButtonStyle(false),
              alignSelf: 'flex-start',
              padding: '1px 8px',
              fontSize: 11,
              lineHeight: '16px',
            },
          }, '清除筛选')
          : null);
    }

    function ActionBar({ actions, ticket, busyAction, onAction, locked }) {
      const list = Array.isArray(actions) ? actions : [];
      if (list.length === 0) return null;
      const isLocked = locked === true;
      const disabled = busyAction !== null || isLocked;
      const buttons = [];
      const hints = [];
      for (const descriptor of list) {
        const busy = busyAction === descriptor.action;
        const unavailable = actionUnavailableHint(descriptor, ticket);
        const itemDisabled = disabled || unavailable !== null;
        if (unavailable !== null) {
          hints.push(h('div', {
            key: `hint-${descriptor.action}`,
            role: 'note',
            style: { fontSize: 11, lineHeight: '16px', color: C.error },
          }, unavailable));
        }
        buttons.push(h('button', {
          key: `action-${descriptor.action}`,
          type: 'button',
          disabled: itemDisabled,
          'aria-busy': busy || undefined,
          'aria-disabled': isLocked || unavailable !== null ? true : undefined,
          onClick: () => {
            if (typeof onAction === 'function') onAction(descriptor);
          },
          style: actionButtonStyle(descriptor.tone, itemDisabled),
          title: isLocked
            ? UNBOUND_WORKSPACE_HINT
            : (unavailable === null ? textOf(descriptor.confirm) : unavailable),
        }, busy ? '处理中…' : textOf(descriptor.label)));
      }
      return h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      },
        h('div', {
          style: { display: 'flex', flexWrap: 'wrap', gap: 6, minWidth: 0 },
          role: 'group',
          'aria-label': '工单动作',
        }, buttons),
        hints);
    }

    /**
     * Observe one element's content width. The lane board degrades from
     * horizontal lanes to stacked groups below {@link LANE_WIDE_MIN_WIDTH}, so
     * the same tab works in the narrow right sidebar and when it is widened.
     * ResizeObserver is used when available; otherwise the initial clientWidth
     * is a one-shot fallback (no responsive updates, still correct at mount).
     */
    const LANE_WIDE_MIN_WIDTH = 720;

    function useElementWidth(targetRef) {
      const [width, setWidth] = React.useState(0);
      React.useEffect(() => {
        const node = targetRef === null || targetRef === undefined ? null : targetRef.current;
        if (node === null || node === undefined) return undefined;
        const apply = (next) => {
          const value = typeof next === 'number' && Number.isFinite(next) && next > 0 ? Math.round(next) : 0;
          setWidth((current) => (current === value ? current : value));
        };
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver((entries) => {
            const first = Array.isArray(entries) && entries.length > 0 ? entries[0] : null;
            if (first !== null && first.contentRect && typeof first.contentRect.width === 'number') {
              apply(first.contentRect.width);
            }
          });
          try {
            observer.observe(node);
          } catch {
            apply(node.clientWidth);
          }
          return () => {
            try {
              observer.disconnect();
            } catch {
              // Already disconnected.
            }
          };
        }
        apply(node.clientWidth);
        return undefined;
      }, [targetRef]);
      return width;
    }

    /** Palette for one lane tone (theme tokens only). */
    function lanePalette(tone) {
      return TONES[tone] ?? TONES.neutral;
    }

    /**
     * Lane overview chips: one count per lane plus an "all" chip. Clicking a
     * chip filters the board to that lane (single source of truth: `activeLane`
     * lives in Board and also drives the status/type filters combined view).
     */
    function StageOverview({ lanes, activeLane, onSelectLane }) {
      const list = Array.isArray(lanes) ? lanes : [];
      if (list.length === 0) return null;
      const chipStyle = (active) => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        flex: '0 0 auto',
        padding: '2px 8px',
        borderRadius: 999,
        border: `0.5px solid ${active ? C.brand : C.border}`,
        background: active ? C.selected : 'transparent',
        color: active ? C.text : C.textSecondary,
        fontSize: 11,
        lineHeight: '16px',
        font: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      });
      return h('div', {
        role: 'group',
        'aria-label': '按流程阶段筛选',
        style: { display: 'flex', gap: 5, flexWrap: 'wrap', minWidth: 0, paddingBottom: 1 },
      },
        h('button', {
          type: 'button',
          onClick: () => onSelectLane(null),
          'aria-pressed': activeLane === null ? 'true' : 'false',
          style: chipStyle(activeLane === null),
        }, '全部'),
        list.map((item) => {
          const lane = item.lane;
          const count = Array.isArray(item.tickets)
            ? item.tickets.length
            : (typeof item.count === 'number' ? item.count : 0);
          const palette = lanePalette(lane.tone);
          const active = activeLane === lane.id;
          return h('button', {
            key: `stage-${lane.id}`,
            type: 'button',
            onClick: () => onSelectLane(active ? null : lane.id),
            'aria-pressed': active ? 'true' : 'false',
            title: lane.hint,
            style: chipStyle(active),
          },
            h('span', {
              style: { width: 6, height: 6, borderRadius: 999, background: palette.color, flex: '0 0 auto' },
            }),
            textOf(lane.label),
            h('b', { style: { fontWeight: 600, color: active ? C.text : C.textTertiary } }, String(count)));
        }));
    }

    /** One lane card: state, title, next step and wait time. */
    function LaneCard({ lane, ticket, snapshot, selected, onSelect }) {
      const palette = lanePalette(lane.tone);
      const title = typeof ticket.title === 'string' && ticket.title.trim() !== '' ? ticket.title : '（无标题）';
      const running = ticketRunningFor(ticket, snapshot);
      const next = nextStepText(ticket, snapshot);
      const meta = laneCardMeta(ticket, snapshot);
      const waiting = laneWaitsForHuman(ticket.workflow);
      return h('button', {
        type: 'button',
        onClick: () => onSelect(ticket.code),
        'aria-current': selected ? 'true' : undefined,
        'aria-label': `工单 ${ticket.code} ${title}，${textOf(lane.label)}，${next}`,
        style: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: 5,
          width: '100%',
          minWidth: 0,
          textAlign: 'left',
          font: 'inherit',
          padding: '9px 10px',
          borderRadius: 10,
          border: `0.5px solid ${selected ? C.brand : C.border}`,
          borderLeft: `3px solid ${palette.color}`,
          background: selected ? C.selected : C.surface,
          color: C.text,
          cursor: 'pointer',
          boxSizing: 'border-box',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h('span', {
            title: textOf(ticket.code),
            style: {
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 10.5,
              lineHeight: '15px',
              color: C.textTertiary,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
              flex: '1 1 auto',
            },
          }, textOf(ticket.code)),
          h('span', { style: { marginLeft: 'auto', flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 4 } },
            running
              ? h('span', {
                title: '后台任务运行中',
                style: { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: palette.color },
              },
                h('span', { style: { width: 5, height: 5, borderRadius: 999, background: palette.color } }),
                '运行中')
              : null,
            )),
        h('div', {
          style: {
            fontSize: 12.5,
            fontWeight: 600,
            lineHeight: '18px',
            color: C.text,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            wordBreak: 'break-word',
          },
        }, title),
        meta === ''
          ? null
          : h('div', {
            style: {
              fontSize: 10.5,
              lineHeight: '15px',
              color: waiting ? palette.color : C.textTertiary,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
          }, `${clip(ticketTypeText(ticket, snapshot), 8)} · ${meta}`),
        h('div', {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            alignSelf: 'flex-start',
            gap: 4,
            maxWidth: '100%',
            marginTop: 1,
            padding: '0 6px',
            borderRadius: 999,
            border: `0.5px solid ${palette.border}`,
            background: palette.background,
            color: palette.color,
            fontSize: 10.5,
            lineHeight: '16px',
            minWidth: 0,
          },
        },
          h('span', {
            style: {
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
          }, next)));
    }

    /** Lane header shared by the narrow sections and the wide columns. */
    function LaneHeader({ lane, count, needsYou }) {
      const palette = lanePalette(lane.tone);
      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, padding: '0 2px' },
      },
        h('span', { style: { width: 4, height: 13, borderRadius: 3, background: palette.color, flex: '0 0 auto' } }),
        h('span', { style: { fontSize: 12, fontWeight: 700, lineHeight: '18px', color: C.text, whiteSpace: 'nowrap' } },
          textOf(lane.label)),
        h('span', {
          style: {
            flex: '0 0 auto',
            fontSize: 10,
            lineHeight: '15px',
            color: C.textTertiary,
            border: `0.5px solid ${C.border}`,
            borderRadius: 999,
            padding: '0 6px',
            background: C.surface,
          },
        }, String(count)),
        needsYou === true
          ? h('span', {
            style: { marginLeft: 'auto', flex: '0 0 auto', fontSize: 10, lineHeight: '15px', color: palette.color },
          }, '等你')
          : null);
    }

    /** One wide lane column (vertical stack of cards). */
    function LaneColumnWide({ item, selectedCode, onSelect, snapshot }) {
      const lane = item.lane;
      const tickets = item.tickets;
      return h('div', {
        style: {
          flex: '1 1 176px',
          minWidth: 176,
          maxWidth: 260,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          minHeight: 0,
        },
      },
        h(LaneHeader, { lane, count: tickets.length, needsYou: laneWaitsForHuman(lane.states[0]) }),
        tickets.length === 0
          ? h('div', {
            style: {
              fontSize: 10.5,
              lineHeight: '16px',
              color: C.textTertiary,
              padding: '10px 8px',
              border: `0.5px dashed ${C.border}`,
              borderRadius: 10,
              background: C.surfaceAlt,
            },
          }, lane.hint)
          : tickets.map((ticket) => h(LaneCard, {
            key: ticket.code,
            lane,
            ticket,
            snapshot,
            selected: ticket.code === selectedCode,
            onSelect,
          })));
    }

    /** One narrow lane section (header + card stack). */
    function LaneSectionNarrow({ item, selectedCode, onSelect, snapshot }) {
      const lane = item.lane;
      const tickets = item.tickets;
      return h('section', {
        'aria-label': `${lane.label}（${tickets.length} 张）`,
        style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
      },
        h(LaneHeader, { lane, count: tickets.length, needsYou: laneWaitsForHuman(lane.states[0]) }),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
          tickets.map((ticket) => h(LaneCard, {
            key: ticket.code,
            lane,
            ticket,
            snapshot,
            selected: ticket.code === selectedCode,
            onSelect,
          }))));
    }

    /**
     * The lane board itself. Two layouts over one data set:
     *   - narrow (<720px): stacked lane sections, only non-empty lanes (plus the
     *     filtered lane), so the right sidebar stays scannable;
     *   - wide (>=720px): horizontal lane columns with overflow scroll, an
     *     empty-lane hint and the same cards.
     */
    function LaneBoard({ lanes, mode, selectedCode, onSelect, snapshot }) {
      const list = Array.isArray(lanes) ? lanes : [];
      if (list.length === 0) return null;
      const wide = mode === 'wide';
      const children = list.map((item) => (wide
        ? h(LaneColumnWide, {
          key: `lane-col-${item.lane.id}`,
          item,
          selectedCode,
          onSelect,
          snapshot,
        })
        : h(LaneSectionNarrow, {
          key: `lane-sec-${item.lane.id}`,
          item,
          selectedCode,
          onSelect,
          snapshot,
        })));
      return wide
        ? h('div', {
          style: {
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            overflowX: 'auto',
            minHeight: 0,
            paddingBottom: 6,
          },
        }, ...children)
        : h('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 },
        }, ...children);
    }

    /**
     * Compact flow progress for the detail view: the lane order is the roadmap,
     * the current lane is highlighted and a blocked ticket shows a red mark on
     * the lane it was blocked from (`blockedFrom`), not on the blocked chip.
     */
    function StageSteps({ ticket }) {
      const workflow = ticket !== null && typeof ticket === 'object' ? ticket.workflow : '';
      const blockedFrom = ticket !== null && typeof ticket === 'object' && typeof ticket.blockedFrom === 'string'
        ? ticket.blockedFrom
        : null;
      const currentIndex = workflow === 'blocked'
        ? laneIndexForWorkflow(blockedFrom)
        : laneIndexForWorkflow(workflow);
      const isBlocked = workflow === 'blocked';
      const doneLane = workflow === 'merged';
      return h('div', {
        role: 'list',
        'aria-label': '流程进度',
        style: { display: 'flex', flexWrap: 'wrap', gap: 4, minWidth: 0 },
      }, STAGE_LANES.filter((lane) => lane.id !== 'blocked').map((lane, index) => {
        const isCurrent = index === currentIndex && !doneLane;
        const isDone = doneLane ? index <= currentIndex : index < currentIndex;
        const palette = isCurrent && isBlocked ? TONES.danger : lanePalette(lane.tone);
        return h('span', {
          key: `step-${lane.id}`,
          role: 'listitem',
          'aria-current': isCurrent ? 'step' : undefined,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '1px 7px',
            borderRadius: 999,
            border: `0.5px solid ${isCurrent ? palette.border : (isDone ? palette.border : C.border)}`,
            background: isCurrent ? palette.background : (isDone ? palette.background : 'transparent'),
            color: isCurrent ? palette.color : (isDone ? C.textSecondary : C.textTertiary),
            fontSize: 10.5,
            lineHeight: '16px',
            whiteSpace: 'nowrap',
          },
        },
          isCurrent && isBlocked ? '● ' : (isDone && !isCurrent ? '✓ ' : ''),
          textOf(lane.label));
      }));
    }

    function TicketRow({ ticket, selected, onSelect, snapshot }) {
      const title = typeof ticket.title === 'string' && ticket.title.trim() !== '' ? ticket.title : '（无标题）';
      return h('button', {
        type: 'button',
        onClick: () => onSelect(ticket.code),
        'aria-current': selected ? 'true' : undefined,
        'aria-label': `工单 ${ticket.code} ${title}，来源${sourceLabel(ticket)}，${workflowLabel(ticket.workflow)}`,
        style: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: 5,
          width: '100%',
          textAlign: 'left',
          font: 'inherit',
          padding: '8px 10px',
          borderRadius: 8,
          border: `0.5px solid ${selected ? C.brand : C.border}`,
          background: selected ? C.selected : C.surface,
          color: C.text,
          cursor: 'pointer',
          boxSizing: 'border-box',
          minWidth: 0,
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h('span', {
            style: {
              flex: '0 0 auto',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 11,
              lineHeight: '16px',
              color: C.textSecondary,
            },
          }, textOf(ticket.code)),
          h('span', {
            style: {
              flex: '1 1 auto',
              minWidth: 0,
              fontSize: 12.5,
              fontWeight: 600,
              lineHeight: '18px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            },
          }, title),
          h(Badge, { label: sourceLabel(ticket), tone: sourceTone(ticket) }),
          h(Badge, { label: workflowLabel(ticket.workflow), tone: workflowTone(ticket.workflow) })),
        h('div', {
          style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 8px', fontSize: 11, lineHeight: '16px', color: C.textTertiary },
        },
          h('span', null, `类型：${ticketTypeText(ticket, snapshot)}`),
          h('span', null, `平台状态：${ticketStatusText(ticket)}`),
          h('span', null, `优先级：${platformField(ticket, 'priorityName') || (ticket.priority ? ticket.priority : '—')}`),
          h('span', {
            title: fullTime(ticket.updatedAt),
            style: { marginLeft: 'auto', flex: '0 0 auto' },
          }, `更新 ${formatTime(ticket.updatedAt)}`)));
    }

    function TicketList({ tickets, selectedCode, onSelect, snapshot }) {
      return h('ul', {
        style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
        'aria-label': '工单列表',
      }, tickets.map((ticket) => h('li', { key: ticket.code, style: { minWidth: 0 } },
        h(TicketRow, {
          ticket,
          snapshot,
          selected: ticket.code === selectedCode,
          onSelect,
        }))));
    }

    function FieldsBlock({ ticket, snapshot }) {
      const title = typeof ticket.title === 'string' && ticket.title.trim() !== '' ? ticket.title : '（无标题）';
      const items = [
        ['编号', textOf(ticket.code, '—')],
        ['标题', title],
        ['类型', ticketTypeText(ticket, snapshot)],
        ['平台状态', ticketStatusText(ticket)],
        ['负责人', typeof ticket.assignee === 'string' && ticket.assignee !== '' ? ticket.assignee : '未指派'],
        ['版本', typeof ticket.version === 'string' && ticket.version !== '' ? ticket.version : '—'],
        ['优先级', typeof ticket.priority === 'string' && ticket.priority !== '' ? ticket.priority : '—'],
        ['流程状态', workflowLabel(ticket.workflow)],
        ['更新时间', formatTime(ticket.updatedAt)],
      ];
      const url = safeHttpUrl(ticket.url);
      return h(Card, { title: '工单信息' },
        h('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: '7px 10px',
            minWidth: 0,
          },
        }, items.map(([label, value]) => h('div', { key: `field-${label}`, style: { minWidth: 0 } },
          h('div', { style: fieldLabelStyle }, label),
          h('div', { style: fieldValueStyle }, value)))),
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', minWidth: 0 } },
          h('span', { style: fieldLabelStyle }, '链接'),
          url === null
            ? (typeof ticket.url === 'string' && ticket.url !== ''
              ? h('span', { style: { ...fieldValueStyle, fontSize: 11.5 } }, clip(ticket.url, 160))
              : h('span', { style: { ...fieldValueStyle, fontSize: 11.5, color: C.textTertiary } }, '—'))
            : h('a', {
              href: url,
              target: '_blank',
              rel: 'noreferrer noopener',
              style: { fontSize: 12, color: C.link, wordBreak: 'break-all' },
            }, '打开工单链接')),
        h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } }, `创建于 ${formatTime(ticket.createdAt)}`));
    }

    /**
     * Platform-only detail block (domain v2). Renders nothing for a manual
     * ticket. The description is a bounded summary; the full text stays in the
     * `title` attribute. The outbound link is limited to http(s) and opens with
     * `noopener noreferrer`.
     */
    function PlatformCard({ ticket }) {
      const platform = ticket !== null && typeof ticket === 'object' && ticket.platform !== null && typeof ticket.platform === 'object'
        ? ticket.platform
        : null;
      if (platform === null) return null;

      const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback);
      const items = [
        ['类型', text(platform.typeName, text(ticket.type, '—'))],
        ['状态', text(platform.statusName, text(ticket.status, '—'))],
        ['负责人', text(platform.assigneeName, text(ticket.assignee, '—'))],
        ['版本', text(platform.versionName, text(ticket.version, '—'))],
        ['项目', text(platform.projectName, '—')],
      ];
      const description = typeof platform.description === 'string' ? platform.description.trim() : '';
      const url = safeHttpUrl(platform.url) ?? safeHttpUrl(ticket.url);
      const syncedAt = typeof platform.syncedAt === 'number' || typeof platform.syncedAt === 'string'
        ? platform.syncedAt
        : null;

      return h(Card, {
        title: '平台信息',
        aside: syncedAt === null ? undefined : `同步于 ${formatTime(syncedAt)}`,
      },
        h('div', {
          style: {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: '7px 10px',
            minWidth: 0,
          },
        }, items.map(([label, value]) => h('div', { key: `platform-field-${label}`, style: { minWidth: 0 } },
          h('div', { style: fieldLabelStyle }, label),
          h('div', { style: fieldValueStyle }, value)))),
        description === ''
          ? h('p', { style: emptyTextStyle }, '平台没有填写描述。')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
            h('div', { style: fieldLabelStyle }, '描述摘要'),
            h('div', {
              title: description,
              style: { ...fieldValueStyle, whiteSpace: 'pre-wrap' },
            }, clip(description, 300))),
        url === null
          ? null
          : h('a', {
            href: url,
            target: '_blank',
            rel: 'noopener noreferrer',
            style: { fontSize: 12, color: C.link, wordBreak: 'break-all' },
          }, '在平台打开'));
    }

    /**
     * Plan card (P3 real analysis output). Renders the six contract fields
     * (`summary`, `rootCause`, `approach`, `changedFiles`, `risks`,
     * `testPlan`) — files/risks as lists, test plan as a paragraph — and keeps
     * the plan-review action bar (通过/驳回) in the footer. An empty card
     * explains why there is no plan yet: running analysis, interrupted
     * analysis, or any other state.
     */
    function PlanCard({ plan, workflow, analysisRunning, footer }) {
      const value = plan !== null && typeof plan === 'object' ? plan : null;
      const body = [];
      if (value === null) {
        body.push(h('p', { key: 'plan-empty', style: emptyTextStyle },
          workflow === 'analyzing'
            ? (analysisRunning === true
              ? 'AI 分析中，完成后会生成方案。'
              : '分析未在运行，可点击「重新分析」生成方案。')
            : '暂无方案。'));
      } else {
        if (workflow === 'plan_review') {
          body.push(h('p', {
            key: 'plan-review-hint',
            style: { ...emptyTextStyle, color: C.textSecondary },
          }, '请审核以下方案：通过后进入修复，驳回则转人工处理。'));
        }
        body.push(h(TextField, { key: 'plan-summary', label: '摘要', value: value.summary }));
        body.push(h(TextField, { key: 'plan-root-cause', label: '根因', value: value.rootCause }));
        body.push(h(TextField, { key: 'plan-approach', label: '修复方案', value: value.approach }));
        const files = Array.isArray(value.changedFiles)
          ? value.changedFiles.filter((file) => file !== null && file !== undefined && textOf(file) !== '')
          : [];
        body.push(h(ListField, {
          key: 'plan-files',
          label: files.length === 0 ? '改动文件' : `改动文件（${files.length}）`,
          values: files,
        }));
        const risks = Array.isArray(value.risks)
          ? value.risks.filter((risk) => risk !== null && risk !== undefined && textOf(risk) !== '')
          : [];
        body.push(h(ListField, {
          key: 'plan-risks',
          label: risks.length === 0 ? '风险' : `风险（${risks.length}）`,
          values: risks,
        }));
        const testPlan = typeof value.testPlan === 'string' && value.testPlan.trim() !== ''
          ? value.testPlan
          : '—';
        body.push(h('div', {
          key: 'plan-test-plan',
          style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
        },
          h('div', { style: fieldLabelStyle }, '测试建议'),
          h('p', {
            style: { margin: 0, ...fieldValueStyle, whiteSpace: 'pre-wrap' },
          }, testPlan)));
        if (typeof value.approvedAt === 'string') {
          body.push(h('div', { key: 'plan-approved', style: { fontSize: 11, lineHeight: '16px', color: C.success } },
            `已通过 ${formatTime(value.approvedAt)}`));
        }
        if (typeof value.rejectedReason === 'string' && value.rejectedReason !== '') {
          body.push(h('div', { key: 'plan-rejected', style: { fontSize: 11, lineHeight: '16px', color: C.error } },
            `已驳回：${clip(value.rejectedReason, 300)}`));
        }
      }
      if (footer !== null && footer !== undefined) {
        body.push(h('div', { key: 'plan-actions', style: { paddingTop: 2 } }, footer));
      }
      return h(Card, { title: '方案', aside: value && typeof value.generatedAt === 'string' ? `生成于 ${formatTime(value.generatedAt)}` : undefined }, ...body);
    }

    /** `fixes[].status` -> display label + badge tone (the host writes 3 values). */
    function fixStatusLabel(status) {
      if (status === 'succeeded') return { label: '成功', tone: 'success' };
      if (status === 'failed') return { label: '失败', tone: 'danger' };
      if (status === 'cancelled') return { label: '已取消', tone: 'neutral' };
      return null;
    }

    /** Non-negative `elapsedMs` -> elapsed copy, or null when absent/invalid. */
    function formatRunElapsed(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
      return formatElapsed(Math.round(value / 1000));
    }

    /**
     * Fix history card. The host writes one entry per real run:
     * `{runId, startedAt, finishedAt, status, changedFiles, diffStat, summary,
     * testResult, error?, elapsedMs?, diff?, notes?}`. Legacy P1 demo entries
     * only carry `at`/`evidence`; those fields are read only when the new one
     * is absent, so old records still render without fabricating new data.
     * `testResult` is surfaced by `TestCard`; this card renders what changed.
     */
    function FixCard({ fixes }) {
      const list = Array.isArray(fixes) ? fixes.filter((fix) => fix && typeof fix === 'object') : [];
      if (list.length === 0) {
        return h(Card, { title: '修复记录' }, h('p', { style: emptyTextStyle }, '暂无修复记录。'));
      }
      // The host appends one entry per finished run (each may carry up to
      // 2 000 changed files), so render only the newest runs; the aside still
      // reports the full count.
      const visible = list.slice(-MAX_RENDERED_FIXES);
      const ordered = visible.slice().reverse();
      return h(Card, {
        title: '修复记录',
        aside: list.length > visible.length
          ? `${list.length} 次（显示最近 ${MAX_RENDERED_FIXES} 次）`
          : `${list.length} 次`,
      }, ...ordered.map((fix, index) => {
        const files = Array.isArray(fix.changedFiles)
          ? fix.changedFiles.filter((file) => textOf(file) !== '')
          : [];
        // Legacy P1 demo entries only; the host no longer writes `evidence`.
        const evidence = Array.isArray(fix.evidence) ? fix.evidence : [];
        const status = fixStatusLabel(fix.status);
        const startedAt = typeof fix.startedAt === 'string' ? fix.startedAt : null;
        const finishedAt = typeof fix.finishedAt === 'string' ? fix.finishedAt : null;
        const legacyAt = typeof fix.at === 'string' ? fix.at : null;
        const timeText = startedAt !== null
          ? `开始 ${formatTime(startedAt)}`
          : (legacyAt !== null ? `修复于 ${formatTime(legacyAt)}` : `第 ${list.length - index} 次`);
        const elapsed = formatRunElapsed(fix.elapsedMs);
        const diffStat = typeof fix.diffStat === 'string' && fix.diffStat.trim() !== '' ? fix.diffStat : null;
        // The host persists a reason CODE in `error` (e.g. `fix-no-changes`),
        // never a message: map it through the same copy table as the blocked
        // banner and only clip an unknown string.
        const rawError = typeof fix.error === 'string' && fix.error.trim() !== '' ? fix.error : null;
        const errorText = rawError === null ? null : (fixReasonLabel(rawError) ?? clip(rawError, 300));
        return h('div', {
          key: `fix-${index}`,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            paddingTop: index === 0 ? 0 : 8,
            borderTop: index === 0 ? 'none' : `0.5px solid ${C.border}`,
            minWidth: 0,
          },
        },
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 11, lineHeight: '16px', color: C.textTertiary } },
            status === null ? null : h(Badge, { label: status.label, tone: status.tone }),
            h('span', { title: fullTime(startedAt) ?? fullTime(legacyAt) }, timeText),
            finishedAt === null ? null : h('span', { title: fullTime(finishedAt) }, `完成 ${formatTime(finishedAt)}`),
            elapsed === null ? null : h('span', null, `耗时 ${elapsed}`),
            diffStat === null ? null : h('span', null, `改动：${clip(diffStat, 160)}`)),
          h(TextField, { label: '摘要', value: fix.summary }),
          errorText === null
            ? null
            : h('div', {
              style: {
                fontSize: 12,
                lineHeight: '18px',
                color: C.error,
                wordBreak: 'break-word',
                overflowWrap: 'anywhere',
              },
            }, `错误：${errorText}`),
          h(ListField, {
            label: files.length === 0 ? '改动文件' : `改动文件（${files.length}）`,
            values: files,
          }),
          evidence.length === 0
            ? null
            : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 11, lineHeight: '16px' } },
              h('span', { style: { color: C.textTertiary } }, '证据：'),
              evidence.map((item, evidenceIndex) => {
                const link = safeHttpUrl(item);
                if (link !== null) {
                  return h('a', {
                    key: `evidence-${evidenceIndex}`,
                    href: link,
                    target: '_blank',
                    rel: 'noreferrer noopener',
                    style: { color: C.link, wordBreak: 'break-all' },
                  }, clip(item, 100));
                }
                return h('span', { key: `evidence-${evidenceIndex}`, style: { color: C.textSecondary, wordBreak: 'break-all' } }, clip(item, 160));
              })));
      }));
    }

    function TestCard({ fixes, workflow }) {
      const list = Array.isArray(fixes) ? fixes.filter((fix) => fix && typeof fix === 'object') : [];
      const latest = list.length === 0 ? null : list[list.length - 1];
      // The host writes `testResult` on every run entry; only a non-empty
      // string is rendered (legacy entries may omit it).
      const testResult = latest !== null && typeof latest.testResult === 'string' && latest.testResult.trim() !== ''
        ? latest.testResult
        : undefined;
      // `evidence` is no longer written by the host: render it only when a
      // legacy P1 demo entry still carries it.
      const evidence = latest === null || !Array.isArray(latest.evidence) ? [] : latest.evidence;
      const latestStatus = latest === null ? null : fixStatusLabel(latest.status);
      const statusText = workflow === 'fix_done'
        ? '待人工测试：完成测试后点击「标记测试通过」。'
        : (workflow === 'fixing'
          ? '修复进行中，暂无人工测试记录。'
          : (list.length === 0 ? '暂无测试记录。' : '最近一次修复的测试结果如下。'));
      return h(Card, { title: '测试与证据', aside: latestStatus === null ? undefined : latestStatus.label },
        h('p', { style: emptyTextStyle }, statusText),
        testResult === undefined
          ? null
          : h(TextField, { label: '测试结果', value: testResult }),
        evidence.length === 0
          ? null
          : h(ListField, { label: '视觉/运行证据', values: evidence }));
    }

    function MrCard({ ticket }) {
      const mr = ticket.mr !== null && typeof ticket.mr === 'object' ? ticket.mr : null;
      const branch = ticket.branch !== null && typeof ticket.branch === 'object' ? ticket.branch : null;
      if (mr === null && branch === null) {
        return h(Card, { title: 'MR 与分支' }, h('p', { style: emptyTextStyle }, '暂无分支或 MR，流程进入「待提交」后创建。'));
      }
      const source = mr !== null && typeof mr.sourceBranch === 'string'
        ? mr.sourceBranch
        : (branch !== null && typeof branch.name === 'string' ? branch.name : '—');
      const target = mr !== null && typeof mr.targetBranch === 'string'
        ? mr.targetBranch
        : (branch !== null && typeof branch.target === 'string' ? branch.target : '—');
      const baseSource = branch === null || typeof branch.baseSource !== 'string'
        ? ''
        : branchBaseSourceLabel(branch.baseSource);
      const worktree = branch === null || typeof branch.worktree !== 'string' || branch.worktree.trim() === ''
        ? null
        : branch.worktree;
      const url = mr === null ? null : safeHttpUrl(mr.url);
      const iid = mr === null ? null : textOf(mr.iid);
      return h(Card, { title: 'MR 与分支', aside: iid === null || iid === '' ? undefined : `!${iid}` },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
          h('div', { style: fieldLabelStyle }, '分支'),
          h('div', { style: { ...fieldValueStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11.5 } },
            `${source} → ${target}`)),
        baseSource === ''
          ? null
          : h('div', { style: { fontSize: 11.5, lineHeight: '18px', color: C.textSecondary } },
            `基线：${baseSource}`),
        worktree === null
          ? null
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
            h('div', { style: fieldLabelStyle }, '工作树'),
            h('div', {
              style: {
                ...fieldValueStyle,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: 11.5,
                wordBreak: 'break-all',
              },
            }, worktree)),
        mr === null
          ? null
          : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 11.5, lineHeight: '18px', color: C.textSecondary } },
            h('span', null, `状态：${mrStateLabel(mr.state)}`),
            h('span', null, `结论：${verdictLabel(mr.verdict)}`),
            h('span', null, `Review 轮次：${mr.rounds === undefined || mr.rounds === null ? 0 : mr.rounds} / ${MAX_REVIEW_ROUNDS}`)),
        url === null
          ? null
          : h('a', {
            href: url,
            target: '_blank',
            rel: 'noreferrer noopener',
            style: { fontSize: 12, color: C.link, wordBreak: 'break-all' },
          }, '打开 MR'));
    }

    /**
     * Bounded issue list used by the Review card and the inline `mr_open`
     * panel.
     *
     * `bounded` is opt-in and only the P5 inline panel sets it: the P4
     * `ReviewCard` keeps its pre-P5 rendering verbatim (full file/level/problem
     * text), so the P5 clipping never changes an existing card. When
     * `bounded:true`, every field is clipped because issue text is AI-generated
     * (and passed through an untrusted note), so an oversized value must not
     * blow up the sidebar layout. `limit` caps the number of rendered issues
     * without touching the stored array.
     */
    function IssueList({ issues, title, limit, bounded }) {
      const isBounded = bounded === true;
      if (!Array.isArray(issues) || issues.length === 0) return null;
      const list = typeof limit === 'number' && Number.isFinite(limit) && limit > 0
        ? issues.slice(0, limit)
        : issues;
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
        h('div', { style: fieldLabelStyle }, title),
        h('ul', {
          style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 5 },
        }, list.map((issue, index) => {
          const value = issue && typeof issue === 'object' ? issue : { problem: issue };
          const heading = isBounded
            ? [clip(textOf(value.file), 120), clip(textOf(value.level), 40)]
              .filter((part) => part !== '').join(' · ')
            : [textOf(value.file), textOf(value.level)].filter((part) => part !== '').join(' · ');
          return h('li', {
            key: `issue-${index}`,
            style: {
              border: `0.5px solid ${C.border}`,
              borderRadius: 6,
              background: C.surfaceAlt,
              padding: '5px 8px',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              minWidth: 0,
            },
          },
            heading === '' ? null : h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textSecondary, wordBreak: 'break-all' } }, heading),
            isBounded && typeof value.location === 'string' && value.location !== ''
              ? h('div', { style: { fontSize: 10.5, lineHeight: '15px', color: C.textTertiary, wordBreak: 'break-all' } }, clip(value.location, 160))
              : null,
            h('div', {
              style: isBounded
                ? { ...fieldValueStyle, fontSize: 12, wordBreak: 'break-word' }
                : { ...fieldValueStyle, fontSize: 12 },
            }, isBounded ? clip(textOf(value.problem, '—'), 400) : textOf(value.problem, '—')),
            typeof value.suggestion === 'string' && value.suggestion !== ''
              ? h('div', {
                style: isBounded
                  ? { fontSize: 11, lineHeight: '16px', color: C.textTertiary, wordBreak: 'break-word' }
                  : { fontSize: 11, lineHeight: '16px', color: C.textTertiary },
              }, `建议：${clip(value.suggestion, 300)}`)
              : null);
        })));
    }

    function ReviewCard({ mr }) {
      const value = mr !== null && typeof mr === 'object' ? mr : null;
      if (value === null) {
        return h(Card, { title: 'Review' }, h('p', { style: emptyTextStyle }, '暂无 Review 记录。'));
      }
      const rounds = value.rounds === undefined || value.rounds === null ? 0 : value.rounds;
      return h(Card, { title: 'Review', aside: `轮次 ${rounds} / ${MAX_REVIEW_ROUNDS}` },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 12, lineHeight: '18px' } },
          h('span', null, `结论：${verdictLabel(value.verdict)}`),
          h('span', { style: { color: C.textTertiary } }, `状态：${mrStateLabel(value.state)}`)),
        h(IssueList, { issues: value.blockingIssues, title: '阻塞问题' }),
        h(IssueList, { issues: value.nonBlockingIssues, title: '非阻塞问题' }),        !Array.isArray(value.blockingIssues) || value.blockingIssues.length === 0
          ? h('p', { style: emptyTextStyle }, '当前没有阻塞问题。')
          : null);
    }

    /**
     * P5 delivery status panel for a `submitting` ticket.
     *
     * The delivery flow is service-owned: 200 from `POST /api/deliver` only
     * means the job was accepted, and the host advances `submit_mr`/
     * `mr_created` itself after lint/test, commit, push and MR creation. The
     * board therefore never renders demo submit_mr/mr_created buttons:
     *   - `snapshot.delivery.running` contains the code: live progress copy plus
     *     a local elapsed timer (kept out of the polite live region);
     *   - otherwise: the real 「提交并创建 MR」 button plus the last static
     *     delivery error (`snapshot.delivery.errors[code]`, the delivery-only
     *     meta namespace) and a token-config hint.
     */
    function DeliveryNotice({ ticket, snapshot, busyAction, locked, onAction }) {
      const isSubmitting = ticket.workflow === 'submitting';
      const running = isSubmitting && deliveryRunningFor(snapshot, ticket.code);
      const elapsed = useElapsedSeconds(running, ticket.code);
      if (!isSubmitting) return null;

      const busy = busyAction === DELIVER_DESCRIPTOR.action;
      const disabled = busy || locked === true;
      const serverError = deliveryErrorFor(snapshot, ticket.code);
      const gitlabReady = snapshot !== null
        && snapshot.gitlab !== null
        && typeof snapshot.gitlab === 'object'
        && snapshot.gitlab.tokenPresent === true;
      const start = h('button', {
        key: 'deliver-start',
        type: 'button',
        disabled,
        'aria-busy': busy || undefined,
        title: locked === true ? UNBOUND_WORKSPACE_HINT : DELIVER_DESCRIPTOR.confirm,
        onClick: () => {
          if (disabled) return;
          if (typeof onAction === 'function') onAction(DELIVER_DESCRIPTOR);
        },
        style: primaryButtonStyle(disabled),
      }, busy ? '处理中…' : DELIVER_DESCRIPTOR.label);

      if (running) {
        return h('div', {
          role: 'status',
          'aria-live': 'polite',
          'data-bug-delivery': 'running',
          style: {
            border: `0.5px solid ${TONES.info.border}`,
            background: TONES.info.background,
            borderRadius: 8,
            padding: '8px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            minWidth: 0,
          },
        },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: TONES.info.color, lineHeight: '18px' } },
            DELIVERY_RUNNING_HINT),
          // The elapsed counter updates every second; keep it out of the polite
          // live region so screen readers announce acceptance/completion, not
          // one message per tick.
          h('div', {
            'aria-live': 'off',
            style: { fontSize: 11, lineHeight: '16px', color: C.textSecondary },
          }, `已运行 ${formatElapsed(elapsed)}`),
          h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } },
            '交付在后台进行，可继续其他操作；完成后工单会进入「Review 中」。'));
      }

      return h('div', {
        role: 'status',
        'data-bug-delivery': 'ready',
        style: {
          border: `0.5px solid ${TONES.warn.border}`,
          background: TONES.warn.background,
          borderRadius: 8,
          padding: '8px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          minWidth: 0,
        },
      },
        h('div', { style: { fontSize: 12, fontWeight: 600, color: TONES.warn.color, lineHeight: '18px' } },
          DELIVERY_READY_HINT),
        gitlabReady
          ? null
          : h('div', { style: { fontSize: 11, lineHeight: '16px', color: TONES.warn.color, wordBreak: 'break-word' } },
            '未配置 GitLab token，提交会失败；请先在「设置 → GitLab 连接」保存 token。'),
        serverError === null
          ? null
          : h('div', {
            style: { fontSize: 11, lineHeight: '16px', color: C.textSecondary, wordBreak: 'break-word' },
          }, `上次交付记录：${clip(serverError, 300)}`),
        h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } },
          '提交前会先运行配置的 lint/test，再提交、推送个人分支并创建 GitLab MR；最长约 15 分钟。'),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } }, start));
    }

    /**
     * P5 AI Review / merge status panel for the states the timer-driven review
     * service owns. It renders static, never-interactive copy except the
     * existing MR card:
     *   - `mr_open`: polling hint + the newest blocking issues (max 5, clipped)
     *     + the live review error meta (`snapshot.review.errors[code]`; this is
     *     the review namespace, never fix/delivery);
     *   - `fixing_review`: a running banner with elapsed timer only while
     *     `snapshot.review.running` contains the code; otherwise the static
     *     "host recovers on the next poll" hint (the host owns the restart) and
     *     the latest review round;
     *   - `mergeable`: the human must merge in GitLab (the plugin never merges);
     *   - `merged`: the next poll archives the ticket out of the board.
     *
     * The demo review_requests_changes/review_pass/review_fix_done/mr_merged/
     * dismiss buttons are absent from `ACTION_BY_STATE`, so these states show
     * no board actions at all.
     */
    function ReviewNotice({ ticket, snapshot }) {
      const workflow = ticket.workflow;
      const reviewState = workflow === 'mr_open'
        || workflow === 'fixing_review'
        || workflow === 'mergeable'
        || workflow === 'merged';
      const running = workflow === 'fixing_review' && reviewRunningFor(snapshot, ticket.code);
      const elapsed = useElapsedSeconds(running, ticket.code);
      if (!reviewState) return null;

      const mr = ticket.mr !== null && typeof ticket.mr === 'object' ? ticket.mr : null;
      const rounds = mr !== null && typeof mr.rounds === 'number' && Number.isFinite(mr.rounds)
        ? Math.max(0, Math.trunc(mr.rounds))
        : 0;
      const round = latestReviewRound(ticket);
      const reviewError = reviewErrorFor(snapshot, ticket.code);
      // Strict `=== false`: a partial snapshot without the gitlab block must not
      // claim the token is missing.
      const gitlabTokenMissing = snapshot !== null
        && typeof snapshot === 'object'
        && snapshot.gitlab !== null
        && typeof snapshot.gitlab === 'object'
        && snapshot.gitlab.tokenPresent === false;
      const tokenWarning = gitlabTokenMissing
        ? h('div', {
          style: { fontSize: 11, lineHeight: '16px', color: TONES.warn.color, wordBreak: 'break-word' },
        }, `${REVIEW_TOKEN_MISSING_HINT}；请在「设置 → GitLab 连接」保存 token。`)
        : null;
      const styleFor = (tone) => ({
        border: `0.5px solid ${tone.border}`,
        background: tone.background,
        borderRadius: 8,
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        minWidth: 0,
      });
      const roundParts = [];
      if (rounds > 0) roundParts.push(`Review 轮次：${Math.min(rounds, MAX_REVIEW_ROUNDS)} / ${MAX_REVIEW_ROUNDS}`);
      if (round !== null) {
        const status = reviewRoundStatusLabel(round.status);
        if (status !== '') roundParts.push(`最近一轮：${status}`);
        if (Array.isArray(round.changedFiles)) roundParts.push(`改动 ${round.changedFiles.length} 个文件`);
        if (typeof round.finishedAt === 'string' && round.finishedAt !== '') {
          roundParts.push(`完成于 ${formatTime(round.finishedAt)}`);
        }
      }
      const roundInfo = roundParts.length === 0
        ? null
        : h('div', {
          style: { fontSize: 11, lineHeight: '16px', color: C.textSecondary, wordBreak: 'break-word' },
        }, roundParts.join(' · '));
      const errorLine = reviewError === null
        ? null
        : h('div', {
          style: { fontSize: 11, lineHeight: '16px', color: C.textSecondary, wordBreak: 'break-word' },
        }, `宿主记录：${clip(reviewError, 300)}`);

      if (workflow === 'merged') {
        return h('div', { role: 'status', 'data-bug-review': 'merged', style: styleFor(TONES.success) },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: TONES.success.color, lineHeight: '18px' } },
            REVIEW_MERGED_HINT),
          h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } },
            '宿主会在下一次 60 秒轮询自动归档，看板无需手动操作。'),
          errorLine);
      }

      if (workflow === 'mergeable') {
        return h('div', { role: 'status', 'data-bug-review': 'mergeable', style: styleFor(TONES.success) },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: TONES.success.color, lineHeight: '18px' } },
            REVIEW_MERGEABLE_HINT),
          h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } },
            REVIEW_POLL_HINT),
          errorLine,
          roundInfo);
      }

      if (workflow === 'fixing_review' && running) {
        return h('div', {
          role: 'status',
          'aria-live': 'polite',
          'data-bug-review': 'running',
          style: styleFor(TONES.info),
        },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: TONES.info.color, lineHeight: '18px' } },
            REVIEW_RUNNING_HINT),
          // The counter ticks every second; keep it out of the polite region.
          h('div', {
            'aria-live': 'off',
            style: { fontSize: 11, lineHeight: '16px', color: C.textSecondary },
          }, `已运行 ${formatElapsed(elapsed)}`),
          h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } },
            '修复完成后宿主会自动提交并推送，然后重新请求 AI Review。'),
          tokenWarning,
          roundInfo);
      }

      if (workflow === 'fixing_review') {
        return h('div', { role: 'status', 'data-bug-review': 'not-running', style: styleFor(TONES.warn) },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: TONES.warn.color, lineHeight: '18px' } },
            REVIEW_NOT_RUNNING_HINT),
          h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } },
            '无需手动操作；若长时间未恢复，请人工检查宿主日志与 GitLab MR。'),
          tokenWarning,
          roundInfo,
          errorLine);
      }

      // `mr_open`: waiting for the next AI Review note.
      const blocking = mr !== null && Array.isArray(mr.blockingIssues) ? mr.blockingIssues : [];
      return h('div', { role: 'status', 'data-bug-review': 'waiting', style: styleFor(TONES.info) },
        h('div', { style: { fontSize: 12, fontWeight: 600, color: TONES.info.color, lineHeight: '18px' } },
          '等待 AI Code Review 结论'),
        h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textSecondary } },
          REVIEW_POLL_HINT),
        tokenWarning,
        h(IssueList, {
          issues: blocking,
          title: blocking.length > MAX_RENDERED_REVIEW_ISSUES
            ? `最近阻塞问题（共 ${blocking.length} 条，仅显示 ${MAX_RENDERED_REVIEW_ISSUES} 条）`
            : '最近阻塞问题',
          limit: MAX_RENDERED_REVIEW_ISSUES,
          bounded: true,
        }),
        errorLine);
    }

    function Timeline({ events }) {
      const list = Array.isArray(events) ? events.slice(-20).reverse() : [];
      if (list.length === 0) {
        return h(Card, { title: '时间线' }, h('p', { style: emptyTextStyle }, '暂无时间线记录。'));
      }
      return h(Card, { title: '时间线', aside: '最近 20 条' },
        h('ol', {
          style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 },
        }, list.map((event, index) => {
          const value = event && typeof event === 'object' ? event : {};
          return h('li', {
            key: `event-${textOf(value.at)}-${index}`,
            style: { display: 'flex', gap: 8, alignItems: 'flex-start', minWidth: 0 },
          },
            h('span', {
              title: fullTime(value.at),
              style: { flex: '0 0 auto', fontSize: 11, lineHeight: '17px', color: C.textTertiary, fontVariantNumeric: 'tabular-nums' },
            }, formatTime(value.at)),
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
              h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline' } },
                h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.textSecondary } }, eventLabel(value.kind)),
                h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } }, actorLabel(value.actor))),
              h('div', { style: { ...fieldValueStyle, fontSize: 12 } }, textOf(value.message, '—'))));
        })));
    }

    function BlockedNotice({ ticket, snapshot }) {
      if (ticket.workflow !== 'blocked') return null;
      const from = typeof ticket.blockedFrom === 'string' && ticket.blockedFrom !== ''
        ? workflowLabel(ticket.blockedFrom)
        : null;
      // Only a delivery block reads the delivery namespace: the persisted
      // `delivery.error:<code>` carries the lint/test/push/MR output tail
      // (`buildFailureMessage` in delivery-service.js). A blocked ticket keeps
      // only the mapped reason code, so without this line the host-recorded
      // detail would never be visible. Never fall back to `snapshot.fix.errors`.
      const deliveryDetail = isDeliveryBlock(ticket) ? deliveryErrorFor(snapshot, ticket.code) : null;
      return h('div', {
        role: 'status',
        style: {
          border: `0.5px solid ${TONES.danger.border}`,
          background: TONES.danger.background,
          borderRadius: 8,
          padding: '8px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          minWidth: 0,
        },
      },
        h('div', { style: { fontSize: 12, fontWeight: 600, color: C.error, lineHeight: '18px' } }, '工单已阻塞，需要人工处理'),
        h('div', { style: { ...fieldValueStyle, fontSize: 12 } },
          `原因：${blockedReasonText(ticket)}`),
        deliveryDetail === null
          ? null
          : h('div', {
            style: { fontSize: 11, lineHeight: '16px', color: C.textSecondary, wordBreak: 'break-word' },
          }, `宿主记录：${clip(deliveryDetail, 300)}`),
        from === null
          ? null
          : h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textSecondary } }, `阻塞前状态：${from}`),
        h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } },
          isAnalysisBlock(ticket)
            ? '这是 AI 分析失败导致的阻塞：点击「重新分析」会解除阻塞并重新开始分析。'
            : (isFixBlock(ticket)
              ? '这是 AI 修复失败导致的阻塞：点击「重新修复」会自动解除阻塞并重新开始修复。'
              : (isDeliveryBlock(ticket)
                ? '这是提交/交付失败导致的阻塞：处理后点击「重试」回到「待提交」，再重新提交并创建 MR。'
                : (isReviewBlock(ticket)
                  ? '这是 AI Review/合并流程导致的阻塞：处理后点击「重试」回到阻塞前状态；若仍无法恢复，请人工检查 GitLab MR。'
                  : '处理完成后可点击「重试」回到阻塞前状态。')))));
    }

    /**
     * P3 analysis status/failure panel for the detail view.
     *
     * Three mutually exclusive renderings, all driven by the polled snapshot:
     *   - `analyzing` + `analysis.running` has the code: live progress copy plus
     *     a local elapsed timer (the caller hides the demo `analysis_done`
     *     button for every `analyzing` ticket, running or interrupted);
     *   - `analyzing` without a running job: an interrupted analysis (crash,
     *     host reload, or a start whose background job already settled) with a
     *     「重新分析」 button that re-POSTs `/api/analyze` (the host restarts the
     *     orphan; no `/action retry` first);
     *   - an analysis-related `blocked` ticket: the static failure reason from
     *     `blockedReason`/`snapshot.analysis.errors[code]` plus the same
     *     「重新分析」 button (the host retries blocked-from-analyzing tickets).
     *
     * The persisted error is deliberately NOT rendered for any other workflow:
     * a stale `analysis.error:<code>` may survive on a ticket that already moved
     * to plan_review/fixing. The host remains the authority for both actions.
     */
    function AnalysisNotice({ ticket, snapshot, busyAction, locked, onAction }) {
      const isAnalyzing = ticket.workflow === 'analyzing';
      const running = isAnalyzing && analysisRunningFor(snapshot, ticket.code);
      const elapsed = useElapsedSeconds(running, ticket.code);
      const block = isAnalysisBlock(ticket);
      if (!isAnalyzing && !block) return null;

      const busy = busyAction === ANALYSIS_RETRY_DESCRIPTOR.action;
      const retryDisabled = busy || locked === true;
      const retry = h('button', {
        key: 'analysis-retry',
        type: 'button',
        disabled: retryDisabled,
        'aria-busy': busy || undefined,
        title: locked === true ? UNBOUND_WORKSPACE_HINT : ANALYSIS_RETRY_DESCRIPTOR.confirm,
        onClick: () => {
          if (retryDisabled) return;
          if (typeof onAction === 'function') onAction(ANALYSIS_RETRY_DESCRIPTOR);
        },
        style: primaryButtonStyle(retryDisabled),
      }, busy ? '处理中…' : ANALYSIS_RETRY_DESCRIPTOR.label);

      if (isAnalyzing && running) {
        return h('div', {
          role: 'status',
          'aria-live': 'polite',
          'data-bug-analysis': 'running',
          style: {
            border: `0.5px solid ${TONES.info.border}`,
            background: TONES.info.background,
            borderRadius: 8,
            padding: '8px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            minWidth: 0,
          },
        },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: TONES.info.color, lineHeight: '18px' } },
            ANALYSIS_RUNNING_HINT),
          // The elapsed counter updates every second; keep it out of the
          // polite live region so screen readers announce the analysis start
          // and completion, not one message per tick.
          h('div', {
            'aria-live': 'off',
            style: { fontSize: 11, lineHeight: '16px', color: C.textSecondary },
          }, `已运行 ${formatElapsed(elapsed)}`),
          h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } },
            '分析在后台进行，可继续做其他操作；完成后工单会进入「方案待审」。'));
      }

      if (isAnalyzing) {
        const serverError = analysisErrorFor(snapshot, ticket.code);
        return h('div', {
          role: 'status',
          'data-bug-analysis': 'interrupted',
          style: {
            border: `0.5px solid ${TONES.warn.border}`,
            background: TONES.warn.background,
            borderRadius: 8,
            padding: '8px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            minWidth: 0,
          },
        },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: TONES.warn.color, lineHeight: '18px' } },
            ANALYSIS_INTERRUPTED_HINT),
          serverError === null
            ? null
            : h('div', {
              style: { fontSize: 11, lineHeight: '16px', color: C.textSecondary, wordBreak: 'break-word' },
            }, `宿主记录：${clip(serverError, 300)}`),
          h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } },
            '重新分析会从当前状态继续（不会先回到待入列）。'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } }, retry));
      }

      const serverError = analysisErrorFor(snapshot, ticket.code);
      return h('div', {
        role: 'alert',
        'data-bug-analysis': 'blocked',
        style: {
          border: `0.5px solid ${TONES.danger.border}`,
          background: TONES.danger.background,
          borderRadius: 8,
          padding: '8px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          minWidth: 0,
        },
      },
        h('div', { style: { fontSize: 12, fontWeight: 600, color: C.error, lineHeight: '18px' } }, 'AI 分析未完成'),
        h('div', { style: { ...fieldValueStyle, fontSize: 12 } }, analysisFailureText(ticket, serverError)),
        serverError === null
          ? null
          : h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textSecondary, wordBreak: 'break-word' } },
            `宿主记录：${clip(serverError, 300)}`),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', paddingTop: 2 } },
          retry,
          h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } },
            '重新分析会自动解除该阻塞并重新开始，最长约 10 分钟。')));
    }

    /**
     * P4 fix status/failure panel for the detail view.
     *
     * Three mutually exclusive renderings, all driven by the polled snapshot:
     *   - `fixing` + `fix.running` has the code: live progress copy plus a
     *     local elapsed timer (the caller hides the demo `fix_done` button for
     *     every `fixing` ticket; the host advances the ticket itself once the
     *     real run succeeds);
     *   - `fixing` without a running job: the normal approved-but-not-started
     *     state (「开始修复」 when the host has not persisted branch/worktree
     *     metadata yet) or an interrupted run (「重新修复」 once it has); both
     *     re-POST `/api/fix`, which the host uses to restart orphans;
     *   - a fix-related `blocked` ticket: the newest static failure copy from
     *     `snapshot.fix.errors[code]` (falling back to `blockedReason`) plus
     *     the same 「重新修复」 button (the host retries blocked-from-fixing and
     *     clears the block itself).
     *
     * The persisted `fix.error:<code>` is deliberately NOT rendered for any
     * other workflow: it may survive on a ticket that already moved on.
     */
    function FixNotice({ ticket, snapshot, busyAction, locked, onAction }) {
      const isFixing = ticket.workflow === 'fixing';
      const running = isFixing && fixRunningFor(snapshot, ticket.code);
      const elapsed = useElapsedSeconds(running, ticket.code);
      const block = isFixBlock(ticket);
      if (!isFixing && !block) return null;

      const fixes = Array.isArray(ticket.fixes) ? ticket.fixes.filter((fix) => fix && typeof fix === 'object') : [];
      const approved = ticket.plan !== null && typeof ticket.plan === 'object'
        && typeof ticket.plan.approvedAt === 'string' && ticket.plan.approvedAt !== '';
      const serverError = fixErrorFor(snapshot, ticket.code);

      const busy = busyAction === FIX_START_DESCRIPTOR.action;
      const disabled = busy || locked === true;
      // A normal first start is an approved plan whose run has never written
      // its branch metadata (and has no run/error); everything else
      // (interrupted, blocked) is a restart/retry. The branch marker is the
      // only persisted trace of a cancelled/disposed run, which writes neither
      // `fixes` nor `fix.error` — without it an orphan looked "ready".
      const started = isFixing && fixRunStarted(ticket);
      const ready = isFixing && fixes.length === 0 && serverError === null && approved && !started;
      const descriptor = ready ? FIX_START_DESCRIPTOR : FIX_RETRY_DESCRIPTOR;
      const start = h('button', {
        key: 'fix-start',
        type: 'button',
        disabled,
        'aria-busy': busy || undefined,
        title: locked === true ? UNBOUND_WORKSPACE_HINT : descriptor.confirm,
        onClick: () => {
          if (disabled) return;
          if (typeof onAction === 'function') onAction(descriptor);
        },
        style: primaryButtonStyle(disabled),
      }, busy ? '处理中…' : descriptor.label);

      if (isFixing && running) {
        return h('div', {
          role: 'status',
          'aria-live': 'polite',
          'data-bug-fix': 'running',
          style: {
            border: `0.5px solid ${TONES.info.border}`,
            background: TONES.info.background,
            borderRadius: 8,
            padding: '8px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            minWidth: 0,
          },
        },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: TONES.info.color, lineHeight: '18px' } },
            FIX_RUNNING_HINT),
          // The elapsed counter updates every second; keep it out of the
          // polite live region so screen readers announce the fix start and
          // completion, not one message per tick.
          h('div', {
            'aria-live': 'off',
            style: { fontSize: 11, lineHeight: '16px', color: C.textSecondary },
          }, `已运行 ${formatElapsed(elapsed)}`),
          h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } },
            '修复在后台进行，可继续做其他操作；完成后工单会进入「待人工测试」。'));
      }

      if (isFixing) {
        if (!approved) {
          // Every host path into `fixing` (approve_plan) sets plan.approvedAt;
          // without it /api/fix refuses with 409 plan-not-approved, so the
          // board does not offer a button that is guaranteed to be rejected.
          return h('div', {
            role: 'status',
            'data-bug-fix': 'not-approved',
            style: {
              border: `0.5px solid ${TONES.warn.border}`,
              background: TONES.warn.background,
              borderRadius: 8,
              padding: '8px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              minWidth: 0,
            },
          },
            h('div', { style: { fontSize: 12, fontWeight: 600, color: TONES.warn.color, lineHeight: '18px' } },
              '方案尚未通过审核，无法开始 AI 修复'),
            h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } },
              '请先回到「方案待审」通过方案（或刷新看板确认最新状态）后再开始修复。'));
        }
        return h('div', {
          role: 'status',
          'data-bug-fix': ready ? 'ready' : 'interrupted',
          style: {
            border: `0.5px solid ${TONES.warn.border}`,
            background: TONES.warn.background,
            borderRadius: 8,
            padding: '8px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            minWidth: 0,
          },
        },
          h('div', { style: { fontSize: 12, fontWeight: 600, color: TONES.warn.color, lineHeight: '18px' } },
            ready ? FIX_READY_HINT : FIX_INTERRUPTED_HINT),
          serverError === null
            ? null
            : h('div', {
              style: { fontSize: 11, lineHeight: '16px', color: C.textSecondary, wordBreak: 'break-word' },
            }, `宿主记录：${clip(serverError, 300)}`),
          h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } },
            ready
              ? '修复会在工作区创建独立的工作树，最长约 15 分钟；期间可继续其他操作。'
              : '重新修复会从当前状态继续（宿主会重启中断的修复任务）。'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } }, start));
      }

      // `block` is true: static failure copy plus the restart button.
      const reason = typeof ticket.blockedReason === 'string' ? ticket.blockedReason : '';
      const persisted = fixReasonLabel(reason);
      return h('div', {
        role: 'alert',
        'data-bug-fix': 'blocked',
        style: {
          border: `0.5px solid ${TONES.danger.border}`,
          background: TONES.danger.background,
          borderRadius: 8,
          padding: '8px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          minWidth: 0,
        },
      },
        h('div', { style: { fontSize: 12, fontWeight: 600, color: C.error, lineHeight: '18px' } }, 'AI 修复未完成'),
        h('div', { style: { ...fieldValueStyle, fontSize: 12 } }, fixFailureText(ticket, serverError)),
        persisted === undefined || serverError === null || persisted === serverError
          ? null
          : h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textSecondary, wordBreak: 'break-word' } },
            `工单记录：${persisted}`),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', paddingTop: 2 } },
          start,
          h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } },
            '重新修复会自动解除该阻塞并重新开始，最长约 15 分钟。')));
    }

    function TicketDetail({ ticket, snapshot, busyAction, locked, onAction, onBack }) {
      // UI-only filters (the action-map literal and its contract test stay
      // untouched): the demo 「分析完成」 button is hidden for EVERY `analyzing`
      // ticket — running or interrupted — because that transition belongs to
      // the real analysis job. P4 hides the demo 「修复完成」 button for EVERY
      // `fixing` ticket for the same reason: the host advances the ticket
      // itself after a real fix. The generic 「重试」 is replaced by the
      // analysis/fix restart button for a ticket blocked by that flow.
      const analysisRunning = ticket.workflow === 'analyzing' && analysisRunningFor(snapshot, ticket.code);
      const analysisBlock = isAnalysisBlock(ticket);
      const fixBlock = isFixBlock(ticket);
      const actions = (ACTION_BY_STATE[ticket.workflow] ?? []).filter((descriptor) => {
        if (ticket.workflow === 'analyzing' && descriptor.action === 'analysis_done') return false;
        if (ticket.workflow === 'fixing' && descriptor.action === 'fix_done') return false;
        if (analysisBlock && descriptor.action === 'retry') return false;
        if (fixBlock && descriptor.action === 'retry') return false;
        return true;
      });
      const planReview = ticket.workflow === 'plan_review';
      const actionBar = h(ActionBar, {
        actions,
        ticket,
        busyAction,
        locked,
        onAction,
      });

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: detailGap, minWidth: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 } },
          h('button', {
            type: 'button',
            onClick: onBack,
            style: { ...smallButtonStyle(false), marginTop: 1 },
          }, '← 返回列表'),
          h('div', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
            h('div', {
              style: {
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: 11,
                lineHeight: '16px',
                color: C.textSecondary,
              },
            }, textOf(ticket.code, '—')),
            h('div', {
              style: { fontSize: 14, fontWeight: 600, lineHeight: '20px', color: C.text, wordBreak: 'break-word' },
            }, typeof ticket.title === 'string' && ticket.title.trim() !== '' ? ticket.title : '（无标题）')),
          h(Badge, { label: workflowLabel(ticket.workflow), tone: workflowTone(ticket.workflow) })),
        h(StageSteps, { ticket }),
        h(AnalysisNotice, { ticket, snapshot, busyAction, locked, onAction }),
        h(FixNotice, { ticket, snapshot, busyAction, locked, onAction }),
        // P5: submission progress (board-only 「提交并创建 MR」) and the
        // service-owned Review/merge status banners. Both are static after 200;
        // no demo submit_mr/mr_created/review_*/dismiss button exists any more.
        h(DeliveryNotice, { ticket, snapshot, busyAction, locked, onAction }),
        h(ReviewNotice, { ticket, snapshot }),
        // FixNotice already reports the blocked-fix cause and the restart
        // action (role="alert"); the generic blocked banner would repeat the
        // same reason. Keep it for every other block (analysis, plan review…).
        fixBlock ? null : h(BlockedNotice, { ticket, snapshot }),
        planReview ? null : actionBar,
        h(FieldsBlock, { ticket, snapshot }),
        h(PlatformCard, { ticket }),
        h(PlanCard, {
          plan: ticket.plan,
          workflow: ticket.workflow,
          analysisRunning,
          footer: planReview ? actionBar : null,
        }),
        h(FixCard, { fixes: ticket.fixes }),
        h(TestCard, { fixes: ticket.fixes, workflow: ticket.workflow }),
        h(MrCard, { ticket }),
        h(ReviewCard, { mr: ticket.mr }),
        h(Timeline, { events: ticket.timeline }));
    }

    function StateNotice({ title, message, actionLabel, onAction, busy, tone }) {
      const palette = TONES[tone] ?? null;
      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          textAlign: 'center',
          padding: '36px 18px',
          minHeight: 180,
          color: C.text,
        },
      },
        h('div', {
          style: {
            fontSize: 13,
            fontWeight: 600,
            lineHeight: '20px',
            color: palette === null || tone !== 'danger' ? C.text : C.error,
          },
        }, textOf(title)),
        message === undefined || message === null || textOf(message) === ''
          ? null
          : h('div', {
            style: { fontSize: 12, lineHeight: '18px', color: C.textSecondary, maxWidth: 360, wordBreak: 'break-word' },
          }, textOf(message)),
        actionLabel
          ? h('button', {
            type: 'button',
            onClick: onAction,
            disabled: busy === true,
            style: primaryButtonStyle(busy === true),
          }, textOf(actionLabel))
          : null);
    }

    // ---------------------------------------------------------------------
    // Root board
    // ---------------------------------------------------------------------

    function Board({ sessionId }) {
      const url = snapshotUrlFor(sessionId);
      const polling = usePolling(url, POLL_INTERVAL_MS);
      const [selectedCode, setSelectedCode] = React.useState(null);
      const [filters, setFilters] = React.useState({ status: [], type: [] });
      const [stageFilter, setStageFilter] = React.useState(null);
      const [busyAction, setBusyAction] = React.useState(null);
      const [actionError, setActionError] = React.useState(null);
      const [flash, setFlash] = React.useState(null);
      const [manualCode, setManualCode] = React.useState('');
      const [pendingRequest, setPendingRequest] = React.useState(null);
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const [settingsDraft, setSettingsDraft] = React.useState(() => normalizeSettings(null));
      const [settingsErrors, setSettingsErrors] = React.useState({});
      const [settingsSaving, setSettingsSaving] = React.useState(false);
      const [tokenDraft, setTokenDraft] = React.useState('');
      const [tokenBusy, setTokenBusy] = React.useState(false);
      const [gitlabTokenDraft, setGitlabTokenDraft] = React.useState('');
      const [gitlabTokenBusy, setGitlabTokenBusy] = React.useState(false);
      // P6 in-board platform login (account + password + image captcha).
      const [loginUsername, setLoginUsername] = React.useState(() => readRememberedUsername());
      const [loginPassword, setLoginPassword] = React.useState('');
      const [loginCode, setLoginCode] = React.useState('');
      const [loginCaptcha, setLoginCaptcha] = React.useState(null);
      const [loginBusy, setLoginBusy] = React.useState(false);
      const [loginError, setLoginError] = React.useState(null);
      const [syncing, setSyncing] = React.useState(false);
      const busyRef = React.useRef(false);
      const laneBodyRef = React.useRef(null);
      const mutationControllerRef = React.useRef(null);
      const settingsButtonRef = React.useRef(null);
      const settingsSavingRef = React.useRef(false);
      const tokenBusyRef = React.useRef(false);
      const gitlabTokenBusyRef = React.useRef(false);
      const loginBusyRef = React.useRef(false);
      const syncingRef = React.useRef(false);
      const pendingSelectRef = React.useRef(null);
      const settingsTouchedRef = React.useRef(false);
      const settingsDraftRef = React.useRef(settingsDraft);
      settingsDraftRef.current = settingsDraft;

      const snapshot = polling.data;
      const tickets = snapshot === null ? [] : snapshot.tickets;
      const laneWidth = useElementWidth(laneBodyRef);
      const laneMode = laneWidth >= LANE_WIDE_MIN_WIDTH ? 'wide' : 'narrow';
      const configured = snapshot !== null && snapshot.workspace.configured === true;
      const tokenPresent = snapshot !== null && snapshot.platform.tokenPresent === true;
      const gitlabTokenPresent = snapshot !== null && snapshot.gitlab.tokenPresent === true;
      const canWrite = sessionId !== null && configured;
      const settingsBaseline = React.useMemo(() => settingsFromSnapshot(snapshot), [snapshot]);
      const settingsDirty = settingsOpen === true && !settingsEqual(settingsDraft, settingsBaseline);

      React.useEffect(() => {
        // A just-imported ticket is selected as soon as the refreshed snapshot
        // contains it (selecting before the refresh would be cleared by this
        // same effect, because the old ticket list does not have the code yet).
        // The first snapshot that arrives after the import is authoritative: if
        // it does not contain the code, drop the pending selection so a later
        // unrelated snapshot can never auto-open a stale code by surprise.
        const pending = pendingSelectRef.current;
        if (pending !== null) {
          if (tickets.some((ticket) => ticket.code === pending)) {
            pendingSelectRef.current = null;
            setSelectedCode(pending);
            return;
          }
          pendingSelectRef.current = null;
        }
        if (selectedCode === null || snapshot === null) return;
        if (!tickets.some((ticket) => ticket.code === selectedCode)) setSelectedCode(null);
      }, [selectedCode, snapshot, tickets]);

      React.useEffect(() => {
        if (flash === null) return undefined;
        const timer = setTimeout(() => setFlash(null), 4000);
        return () => clearTimeout(timer);
      }, [flash]);

      // While the panel is open and untouched, follow the polled settings
      // (including the first snapshot if the panel was opened during loading).
      // Any edit stops the sync so a poll can never overwrite the user's draft.
      React.useEffect(() => {
        if (settingsOpen !== true || snapshot === null) return;
        if (settingsTouchedRef.current) return;
        const next = settingsFromSnapshot(snapshot);
        settingsDraftRef.current = next;
        setSettingsDraft((current) => (settingsEqual(current, next) ? current : next));
      }, [settingsOpen, snapshot]);

      // Abort an in-flight mutation when the tab unmounts: no write may land
      // after the board is gone, and no state update should follow the abort.
      React.useEffect(() => () => {
        const controller = mutationControllerRef.current;
        mutationControllerRef.current = null;
        if (controller !== null) {
          try {
            controller.abort();
          } catch {
            // Already settled.
          }
        }
      }, []);

      const postMutation = React.useCallback(async (path, body) => {
        if (mutationControllerRef.current !== null) {
          try {
            mutationControllerRef.current.abort();
          } catch {
            // Already settled.
          }
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        mutationControllerRef.current = controller;
        try {
          return await api.post(path, body, controller === null ? undefined : controller.signal);
        } catch (error) {
          return {
            ok: false,
            code: 'client-error',
            message: error instanceof Error ? error.message : String(error),
            status: null,
          };
        } finally {
          if (mutationControllerRef.current === controller) mutationControllerRef.current = null;
        }
      }, []);

      const focusSettingsButton = React.useCallback(() => {
        try {
          const node = settingsButtonRef.current;
          if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus();
        } catch {
          // Focus restore is best-effort.
        }
      }, []);

      const closeSettings = React.useCallback(() => {
        if (settingsSavingRef.current || tokenBusyRef.current || gitlabTokenBusyRef.current) return;
        settingsTouchedRef.current = false;
        setSettingsOpen(false);
        setSettingsErrors({});
        // Tokens typed but not saved must not outlive the panel.
        setTokenDraft('');
        setGitlabTokenDraft('');
        // The platform password/captcha are one-shot values: never keep them.
        setLoginPassword('');
        setLoginCode('');
        setLoginCaptcha(null);
        setLoginError(null);
        focusSettingsButton();
      }, [focusSettingsButton]);

      const openSettings = React.useCallback(() => {
        if (busyRef.current || settingsSavingRef.current || tokenBusyRef.current || gitlabTokenBusyRef.current) {
          return;
        }
        const initial = settingsFromSnapshot(snapshot);
        settingsDraftRef.current = initial;
        settingsTouchedRef.current = false;
        setPendingRequest(null);
        setSettingsDraft(initial);
        setSettingsErrors({});
        setTokenDraft('');
        setGitlabTokenDraft('');
        setLoginUsername(readRememberedUsername());
        setLoginPassword('');
        setLoginCode('');
        setLoginCaptcha(null);
        setLoginError(null);
        setSettingsOpen(true);
      }, [snapshot]);

      const toggleSettings = React.useCallback(() => {
        if (settingsOpen === true) closeSettings();
        else openSettings();
      }, [closeSettings, openSettings, settingsOpen]);

      const updateSettingsField = React.useCallback((key, value) => {
        if (typeof key !== 'string') return;
        settingsTouchedRef.current = true;
        const nextValue = typeof value === 'string'
          ? value
          : (typeof value === 'boolean' ? value : '');
        const next = { ...settingsDraftRef.current, [key]: nextValue };
        settingsDraftRef.current = next;
        setSettingsDraft(next);
        setSettingsErrors((current) => {
          if (Object.keys(current).length === 0) return current;
          return validateSettings(next);
        });
      }, []);

      const saveSettings = React.useCallback(async () => {
        if (settingsSavingRef.current || busyRef.current) return;
        if (sessionId === null || configured !== true) return;

        const payload = settingsPayload(settingsDraftRef.current);
        const errors = validateSettings(payload);
        if (Object.keys(errors).length > 0) {
          setSettingsErrors(errors);
          return;
        }

        setSettingsErrors({});
        setActionError(null);
        setFlash(null);
        settingsSavingRef.current = true;
        busyRef.current = true;
        setSettingsSaving(true);

        try {
          const result = await postMutation(API.settings, { sessionId, settings: payload });
          if (result.aborted === true) return;

          if (!result.ok) {
            setActionError(toErrorView(result));
            return;
          }

          const saved = normalizeSettings(
            result.data !== null && typeof result.data === 'object' ? result.data.settings : payload,
          );
          settingsDraftRef.current = saved;
          setSettingsDraft(saved);
          settingsTouchedRef.current = false;
          setSettingsErrors({});
          setSettingsOpen(false);
          setFlash('设置已保存');
          focusSettingsButton();

          try {
            await polling.refresh();
          } catch {
            // The polling banner (or the next poll) reports a failed refresh.
          }
        } finally {
          settingsSavingRef.current = false;
          busyRef.current = false;
          setSettingsSaving(false);
        }
      }, [configured, focusSettingsButton, polling, postMutation, sessionId]);

      /**
       * Shared write-only token save, used by the platform and GitLab token
       * cards. The value never enters this component's rendered output: the
       * input is cleared on success and the status dot follows the refreshed
       * snapshot. The request is a plain JSON POST with
       * `Content-Type: application/json` (the host rejects anything else).
       *
       * A dirty settings draft is persisted FIRST. Closing the panel discards
       * an unsaved draft, while sync/delivery keep using the old settings
       * pairing — so saving a token must not silently drop a base-URL edit
       * (platform or GitLab). Validation failure keeps the panel open and saves
       * no token; a settings POST failure does the same. A clean draft skips
       * the settings request entirely (token-only save keeps its old behaviour).
       */
      const saveToken = React.useCallback(async ({
        path,
        token,
        tokenBusyRef: busyRefForToken,
        setTokenBusy: setBusy,
        setTokenDraft: setDraft,
        labels,
      }) => {
        if (busyRefForToken.current || settingsSavingRef.current || busyRef.current) return;
        if (sessionId === null || configured !== true) return;

        const value = token.trim();
        if (value === '') {
          setActionError({
            code: 'invalid-token',
            message: labels.empty,
            status: null,
            stage: null,
          });
          return;
        }

        const draftDirty = settingsOpen === true
          && !settingsEqual(settingsDraftRef.current, settingsBaseline);
        let settingsToSave = null;
        if (draftDirty) {
          settingsToSave = settingsPayload(settingsDraftRef.current);
          const errors = validateSettings(settingsToSave);
          if (Object.keys(errors).length > 0) {
            // Inline field errors are the panel's validation surface; the token
            // stays unsaved so the user fixes the settings first.
            setSettingsErrors(errors);
            return;
          }
        }

        setSettingsErrors({});
        setActionError(null);
        setFlash(null);
        settingsSavingRef.current = true;
        busyRefForToken.current = true;
        busyRef.current = true;
        setSettingsSaving(draftDirty);
        setBusy(true);

        try {
          if (settingsToSave !== null) {
            const savedResult = await postMutation(API.settings, {
              sessionId,
              settings: settingsToSave,
            });
            if (savedResult.aborted === true) return;

            if (!savedResult.ok) {
              // The token must never be bound to a base URL the user only
              // thought was saved: keep the panel open, save nothing.
              setActionError(toErrorView(savedResult));
              return;
            }

            const saved = normalizeSettings(
              savedResult.data !== null && typeof savedResult.data === 'object'
                ? savedResult.data.settings
                : settingsToSave,
            );
            settingsDraftRef.current = saved;
            setSettingsDraft(saved);
            settingsTouchedRef.current = false;
            setSettingsErrors({});
          }

          const result = await postMutation(path, { sessionId, token: value });
          if (result.aborted === true) return;

          if (!result.ok) {
            setActionError(toErrorView(result));
            if (settingsToSave !== null) {
              // The settings half already landed; refresh so the panel's dirty
              // baseline matches what is actually stored.
              try {
                await polling.refresh();
              } catch {
                // The next poll re-syncs the baseline.
              }
            }
            return;
          }

          setDraft('');
          if (settingsToSave !== null) {
            // Mirror a normal settings save: close the overlay so the combined
            // success flash (rendered behind it) is actually visible.
            setSettingsOpen(false);
            focusSettingsButton();
          }
          setFlash(settingsToSave === null ? labels.saved : labels.combined);
          try {
            await polling.refresh();
          } catch {
            // The polling banner (or the next poll) reports a failed refresh.
          }
        } finally {
          settingsSavingRef.current = false;
          busyRefForToken.current = false;
          busyRef.current = false;
          setSettingsSaving(false);
          setBusy(false);
        }
      }, [
        configured,
        focusSettingsButton,
        polling,
        postMutation,
        sessionId,
        settingsBaseline,
        settingsOpen,
      ]);

      /** Shared token clear (`{token:null}`, never an empty string). */
      const clearToken = React.useCallback(async ({
        path,
        tokenBusyRef: busyRefForToken,
        setTokenBusy: setBusy,
        setTokenDraft: setDraft,
        cleared,
      }) => {
        if (busyRefForToken.current || settingsSavingRef.current || busyRef.current) return;
        if (sessionId === null || configured !== true) return;

        setActionError(null);
        setFlash(null);
        busyRefForToken.current = true;
        busyRef.current = true;
        setBusy(true);

        try {
          const result = await postMutation(path, { sessionId, token: null });
          if (result.aborted === true) return;

          if (!result.ok) {
            setActionError(toErrorView(result));
            return;
          }

          setDraft('');
          setFlash(cleared);
          try {
            await polling.refresh();
          } catch {
            // The polling banner (or the next poll) reports a failed refresh.
          }
        } finally {
          busyRefForToken.current = false;
          busyRef.current = false;
          setBusy(false);
        }
      }, [configured, polling, postMutation, sessionId]);

      /** Save the platform token through the shared card flow. */
      const savePlatformToken = React.useCallback(() => saveToken({
        path: API.platformToken,
        token: tokenDraft,
        tokenBusyRef,
        setTokenBusy,
        setTokenDraft,
        labels: PLATFORM_TOKEN_UI,
      }), [saveToken, tokenDraft]);

      /** Clear the platform token (`{token:null}`). */
      const clearPlatformToken = React.useCallback(() => clearToken({
        path: API.platformToken,
        tokenBusyRef,
        setTokenBusy,
        setTokenDraft,
        cleared: PLATFORM_TOKEN_UI.cleared,
      }), [clearToken]);

      /** Save the GitLab token through the shared card flow. */
      const saveGitlabToken = React.useCallback(() => saveToken({
        path: API.gitlabToken,
        token: gitlabTokenDraft,
        tokenBusyRef: gitlabTokenBusyRef,
        setTokenBusy: setGitlabTokenBusy,
        setTokenDraft: setGitlabTokenDraft,
        labels: GITLAB_TOKEN_UI,
      }), [gitlabTokenDraft, saveToken]);

      /** Clear the GitLab token (`{token:null}`). */
      const clearGitlabToken = React.useCallback(() => clearToken({
        path: API.gitlabToken,
        tokenBusyRef: gitlabTokenBusyRef,
        setTokenBusy: setGitlabTokenBusy,
        setTokenDraft: setGitlabTokenDraft,
        cleared: GITLAB_TOKEN_UI.cleared,
      }), [clearToken]);

      // -------------------------------------------------------------------
      // P6 in-board platform login (account + password + image captcha)
      // -------------------------------------------------------------------

      /** Fetch one fresh image captcha from the host (which proxies the platform). */
      const fetchLoginCaptcha = React.useCallback(async () => {
        if (loginBusyRef.current || sessionId === null || configured !== true) return;
        loginBusyRef.current = true;
        setLoginBusy(true);
        setLoginError(null);
        try {
          const result = await postMutation(API.platformCaptcha, { sessionId });
          if (result.aborted === true) return;
          if (result.ok) {
            const data = result.data !== null && typeof result.data === 'object' ? result.data : {};
            const key = typeof data.key === 'string' ? data.key : '';
            const image = typeof data.image === 'string' ? data.image : '';
            if (key !== '' && image !== '') {
              setLoginCaptcha({ key, image });
            } else {
              setLoginError({
                code: 'captcha-bad-response',
                title: '平台登录',
                message: '平台验证码响应异常，请稍后重试',
                status: null,
              });
            }
          } else {
            setLoginError(platformLoginErrorView(result));
          }
        } finally {
          loginBusyRef.current = false;
          setLoginBusy(false);
        }
      }, [configured, postMutation, sessionId]);

      /**
       * Submit the platform login. The raw password lives only in component
       * state for this request; on success it is cleared and the refreshed
       * snapshot's `platform.tokenPresent` becomes true.
       */
      const submitPlatformLogin = React.useCallback(async () => {
        if (loginBusyRef.current || sessionId === null || configured !== true) return;
        const username = loginUsername.trim();
        const code = loginCode.trim();
        if (username === '' || loginPassword === '' || code === ''
          || loginCaptcha === null || typeof loginCaptcha.key !== 'string') {
          setLoginError({
            code: 'invalid-input',
            title: '平台登录',
            message: PLATFORM_LOGIN_UI.missingFields,
            status: null,
          });
          return;
        }
        loginBusyRef.current = true;
        setLoginBusy(true);
        setLoginError(null);
        let refreshCaptchaAfter = false;
        let failureView = null;
        try {
          const result = await postMutation(API.platformLogin, {
            sessionId,
            username,
            password: loginPassword,
            code,
            captchaKey: loginCaptcha.key,
          });
          if (result.aborted === true) return;
          if (result.ok) {
            const data = result.data !== null && typeof result.data === 'object' ? result.data : {};
            const resolvedName = typeof data.username === 'string' && data.username !== '' ? data.username : username;
            rememberUsername(resolvedName);
            setLoginUsername(resolvedName);
            setLoginPassword('');
            setLoginCode('');
            setLoginCaptcha(null);
            setLoginError(null);
            setFlash(`平台登录成功：${resolvedName}`);
            try {
              await polling.refresh();
            } catch {
              // The polling banner (or the next poll) reports a failed refresh.
            }
          } else {
            // The platform captcha is single-use: a failed attempt consumed it.
            // Refresh it AFTER the busy gate is released (fetchLoginCaptcha
            // itself refuses to run while a mutation is in flight).
            setLoginCaptcha(null);
            setLoginCode('');
            // fetchLoginCaptcha() clears the error while it refreshes, so keep
            // the platform's reason and re-apply it after the call starts.
            failureView = platformLoginErrorView(result);
            refreshCaptchaAfter = true;
          }
        } finally {
          loginBusyRef.current = false;
          setLoginBusy(false);
          if (refreshCaptchaAfter) {
            void fetchLoginCaptcha();
          }
          if (failureView !== null) {
            setLoginError(failureView);
          }
        }
      }, [configured, fetchLoginCaptcha, loginCaptcha, loginCode, loginPassword, loginUsername, polling, postMutation, sessionId]);

      // When the settings panel opens for a not-yet-logged-in workspace, fetch
      // the first captcha automatically (one request, retryable via the image).
      React.useEffect(() => {
        if (settingsOpen !== true) return;
        if (tokenPresent === true) return;
        if (loginCaptcha !== null || loginError !== null) return;
        if (loginBusyRef.current || configured !== true || sessionId === null) return;
        fetchLoginCaptcha();
      }, [settingsOpen, tokenPresent, loginCaptcha, loginError, configured, sessionId, fetchLoginCaptcha]);

      /**
       * Run one platform sync. Requires a session workspace and a stored token
       * (the header disables the button otherwise and names the blocked
       * condition). The response stats are flashed; the refreshed snapshot
       * carries the new `lastSyncAt`/`lastSyncError` for the header status line.
       */
      const syncFromPlatform = React.useCallback(async () => {
        if (syncingRef.current || busyRef.current) return;
        if (sessionId === null || configured !== true || tokenPresent !== true) return;

        syncingRef.current = true;
        busyRef.current = true;
        setSyncing(true);
        setBusyAction('sync');
        setPendingRequest(null);
        setActionError(null);
        setFlash(null);

        try {
          const result = await postMutation(API.sync, { sessionId });
          if (result.aborted === true) return;

          if (result.ok) {
            const data = result.data !== null && typeof result.data === 'object' ? result.data : {};
            setFlash(`已同步：新增 ${statNumber(data.created)} / 更新 ${statNumber(data.updated)}`);
          } else {
            setActionError(syncErrorView(result));
          }

          // Refresh on success and on failure: a failed sync still records
          // `lastSyncError`, which the header renders as static text.
          try {
            await polling.refresh();
          } catch {
            // The polling banner (or the next poll) reports a failed refresh.
          }
        } finally {
          syncingRef.current = false;
          busyRef.current = false;
          setSyncing(false);
          setBusyAction(null);
        }
      }, [configured, polling, postMutation, sessionId, tokenPresent]);

      const executeAction = React.useCallback(async (descriptor, ticket, reason) => {
        if (!descriptor || !ticket || busyRef.current || typeof ticket.code !== 'string') return;
        if (sessionId === null || configured !== true) return;

        // P3/P4/P5: `start_analysis`, the board-only `start_fix` and the
        // board-only `start_deliver` descriptors bypass `/action` and go to
        // their real routes. The host handles the approved start, the
        // orphaned-`analyzing`/`fixing` restart, the blocked-from-analysis/fix
        // retry and the whole delivery job through those routes, so the client
        // never sends a separate submit_mr/mr_created demo action.
        const isAnalyze = descriptor.action === 'start_analysis';
        const isFix = descriptor.action === 'start_fix';
        const isDeliver = descriptor.action === 'start_deliver';
        let payload = {};
        if (!isAnalyze && !isFix && !isDeliver) {
          payload = descriptor.payload === undefined || descriptor.payload === null ? {} : descriptor.payload;
          if (descriptor.input === 'reason') {
            const trimmed = typeof reason === 'string' ? reason.trim() : '';
            payload = { ...payload, reason: trimmed === '' ? '未填写驳回原因' : trimmed };
          }
        }

        busyRef.current = true;
        setPendingRequest(null);
        setBusyAction(descriptor.action);
        setActionError(null);
        setFlash(null);

        try {
          let result;
          if (isAnalyze) {
            result = await postMutation(API.analyze, { sessionId, code: ticket.code });
          } else if (isFix) {
            result = await postMutation(API.fix, { sessionId, code: ticket.code });
          } else if (isDeliver) {
            result = await postMutation(API.deliver, { sessionId, code: ticket.code });
          } else {
            result = await postMutation(API.action, {
              sessionId,
              actionId: createActionId(),
              code: ticket.code,
              action: descriptor.action,
              payload,
            });
          }
          if (result.aborted === true) return;

          if (result.ok) {
            if (isAnalyze) {
              // A 200 only means the host accepted the start. An orphaned
              // `analyzing` ticket without a live agent also answers 200 and
              // blocks moments later, so progress is never claimed here: the
              // refreshed snapshot's `analysis.running` is the only signal.
              setFlash(`工单 ${ticket.code} 分析请求已受理，正在刷新…`);
            } else if (isFix) {
              // Same contract for a fix: 200 means the host accepted the
              // start, not that the work is done. Progress comes only from
              // `snapshot.fix.running` / the ticket's workflow.
              setFlash(`工单 ${ticket.code} 修复请求已受理，正在刷新…`);
            } else if (isDeliver) {
              // 200 only means the delivery job was accepted; lint/test,
              // commit, push and MR creation run in the background and surface
              // through `snapshot.delivery.running` / `snapshot.delivery.errors`.
              setFlash(`工单 ${ticket.code} 提交请求已受理，正在创建 MR…`);
            } else {
              const next = result.data && typeof result.data === 'object' ? result.data.ticket : null;
              const nextWorkflow = next && typeof next.workflow === 'string' ? next.workflow : null;
              setFlash(nextWorkflow === null
                ? `工单 ${ticket.code} 操作成功`
                : `工单 ${ticket.code} 已更新：${workflowLabel(nextWorkflow)}`);
            }
          } else if (isAnalyze) {
            setActionError(analyzeErrorView(result));
          } else if (isFix) {
            setActionError(fixErrorView(result));
          } else if (isDeliver) {
            setActionError(deliverErrorView(result));
          } else {
            setActionError(toErrorView(result));
          }

          // Refresh after success and after a rejected action: a 409 may have
          // changed the ticket server-side (e.g. review rounds -> blocked), and
          // the analysis/fix progress and errors only exist in the snapshot.
          try {
            await polling.refresh();
          } catch {
            // The polling banner (or the next poll) reports a failed refresh.
          }
        } finally {
          busyRef.current = false;
          setBusyAction(null);
        }
      }, [configured, polling, postMutation, sessionId]);

      const requestAction = React.useCallback((descriptor, ticket) => {
        if (!descriptor || !ticket || busyRef.current) return;
        if (sessionId === null || configured !== true) return;

        if (descriptor.input === 'reason') {
          setPendingRequest({ kind: 'action', mode: 'reason', descriptor, ticket });
          return;
        }
        const answer = confirmDialog(textOf(descriptor.confirm, '确认执行该动作？'));
        if (answer === null) {
          setPendingRequest({ kind: 'action', mode: 'confirm', descriptor, ticket });
          return;
        }
        if (answer === false) return;
        executeAction(descriptor, ticket);
      }, [configured, executeAction, sessionId]);

      const createDemoTicket = React.useCallback(async () => {
        if (busyRef.current || sessionId === null || configured !== true) return;

        busyRef.current = true;
        setPendingRequest(null);
        setBusyAction('create');
        setActionError(null);
        setFlash(null);

        const code = createDemoCode();
        try {
          const result = await postMutation(API.action, {
            sessionId,
            actionId: createActionId(),
            code,
            action: 'create',
            payload: { title: 'P1 演示工单', type: '缺陷', version: 'V0.0.0' },
          });
          if (result.aborted === true) return;

          if (result.ok) {
            const created = result.data && typeof result.data === 'object' ? result.data.ticket : null;
            const createdCode = created && typeof created.code === 'string' ? created.code : code;
            setFlash(`演示工单 ${createdCode} 已创建`);
          } else {
            setActionError(toErrorView(result));
          }

          try {
            await polling.refresh();
          } catch {
            // The polling banner (or the next poll) reports a failed refresh.
          }
        } finally {
          busyRef.current = false;
          setBusyAction(null);
        }
      }, [configured, polling, postMutation, sessionId]);

      const requestCreateDemo = React.useCallback(() => {
        if (busyRef.current || sessionId === null || configured !== true) return;
        const message = '创建一张 P1 演示工单？';
        const answer = confirmDialog(message);
        if (answer === null) {
          setPendingRequest({
            kind: 'create-demo',
            mode: 'confirm',
            descriptor: { action: 'create', label: '添加演示工单', confirm: message },
          });
          return;
        }
        if (answer === false) return;
        createDemoTicket();
      }, [configured, createDemoTicket, sessionId]);

      /**
       * Import one platform ticket by code through the existing `create`
       * action (`payload:{code}` — the host resolves the platform detail when a
       * token exists). A successful import refreshes and selects the ticket.
       */
      const importTicketFromPlatform = React.useCallback(async () => {
        const code = manualCode.trim();
        if (busyRef.current || sessionId === null || configured !== true) return;
        if (code === '') {
          setActionError({
            code: 'missing-code',
            title: '导入失败',
            message: '请输入平台工单编号',
            status: null,
            stage: null,
          });
          return;
        }

        busyRef.current = true;
        setPendingRequest(null);
        setBusyAction('manual-create');
        setActionError(null);
        setFlash(null);

        try {
          const result = await postMutation(API.action, {
            sessionId,
            actionId: createActionId(),
            code,
            action: 'create',
            payload: { code },
          });
          if (result.aborted === true) return;

          if (result.ok) {
            const imported = result.data && typeof result.data === 'object' ? result.data.ticket : null;
            const importedCode = imported && typeof imported.code === 'string' ? imported.code : code;
            if (imported !== null && imported.source === 'platform') {
              setManualCode('');
              pendingSelectRef.current = importedCode;
              setFlash(`工单 ${importedCode} 已从平台导入`);
            } else {
              // A successful host response that is not a platform ticket means
              // the host did not run the by-code import path (older host or a
              // misconfigured build). Never claim 「已从平台导入」 for it and do
              // not auto-select a manual ticket: warn and keep the input so the
              // user can retry after fixing the setup.
              pendingSelectRef.current = null;
              setActionError({
                code: 'import-not-platform',
                title: '导入警告',
                message: `宿主返回的工单不是平台工单（来源：${imported === null ? '未知' : sourceLabel(imported)}），未完成平台导入；请检查平台 token 与宿主版本。`,
                status: null,
                stage: null,
              });
            }
          } else {
            setActionError(importErrorView(result));
          }

          try {
            await polling.refresh();
          } catch {
            // The polling banner (or the next poll) reports a failed refresh.
          }
        } finally {
          busyRef.current = false;
          setBusyAction(null);
        }
      }, [configured, manualCode, polling, postMutation, sessionId]);

      const confirmPendingAction = React.useCallback((reason) => {
        const request = pendingRequest;
        if (request === null) return;
        if (request.kind === 'create-demo') {
          createDemoTicket();
          return;
        }
        executeAction(request.descriptor, request.ticket, reason);
      }, [createDemoTicket, executeAction, pendingRequest]);

      const toggleFilter = React.useCallback((kind, value) => {
        setFilters((current) => {
          const values = current[kind];
          return {
            ...current,
            [kind]: values.includes(value) ? values.filter((item) => item !== value) : [...values, value],
          };
        });
      }, []);

      const clearFilters = React.useCallback(() => {
        setFilters({ status: [], type: [] });
        setStageFilter(null);
      }, []);

      // `dismiss` moves a ticket to the terminal `done` state; keep it in the
      // store (a just-dismissed detail still resolves) but hide it from the
      // list and from filter options. Task 6's README should document this P1
      // archive behaviour; the host state is never deleted here.
      const activeTickets = React.useMemo(
        () => tickets.filter((ticket) => ticket.workflow !== 'done'),
        [tickets],
      );

      // Platform dictionaries drive the filter options (labels are the dict
      // `value`s, keys/colours are preserved); any legacy ticket value the
      // dictionary does not cover is appended, and a host without dictionaries
      // falls back to the ticket-derived values exactly like P1.
      const dicts = snapshot === null ? null : snapshot.dicts;
      const statusOptions = React.useMemo(
        () => buildFilterOptions(dicts, 'status', activeTickets, 'status'),
        [activeTickets, dicts],
      );
      const typeOptions = React.useMemo(
        () => buildFilterOptions(dicts, 'type', activeTickets, 'type'),
        [activeTickets, dicts],
      );

      // Status/type filters first, then the lane (stage) filter. The lane
      // overview counts are computed from the status/type-filtered set so a
      // selected lane never makes the other counts collapse to zero.
      const dimensionTickets = React.useMemo(() => activeTickets.filter((ticket) => {
        if (filters.status.length > 0 && !filters.status.includes(dimensionValue(ticket.status))) return false;
        if (filters.type.length > 0 && !filters.type.includes(dimensionValue(ticket.type))) return false;
        return true;
      }), [activeTickets, filters]);

      const laneData = React.useMemo(() => STAGE_LANES.map((lane) => ({
        lane,
        tickets: dimensionTickets.filter((ticket) => Array.isArray(lane.states) && lane.states.includes(ticket.workflow)),
      })).filter((item) => item.tickets.length > 0), [dimensionTickets]);

      const visibleTickets = React.useMemo(() => {
        if (stageFilter === null) return dimensionTickets;
        return dimensionTickets.filter((ticket) => {
          const lane = laneForWorkflow(ticket.workflow);
          return lane !== null && lane.id === stageFilter;
        });
      }, [dimensionTickets, stageFilter]);

      const lanesForBoard = React.useMemo(() => {
        if (stageFilter === null) return laneData;
        return laneData.filter((item) => item.lane.id === stageFilter);
      }, [laneData, stageFilter]);

      const selectedTicket = selectedCode === null
        ? null
        : tickets.find((ticket) => ticket.code === selectedCode) ?? null;

      const bannerError = actionError ?? (polling.error === null ? null : polling.error);
      const bannerTitle = actionError === null
        ? '刷新失败'
        : (typeof actionError.title === 'string' && actionError.title !== '' ? actionError.title : '操作失败');
      const showBanner = bannerError !== null && (snapshot !== null || actionError !== null);
      const filtersActive = filters.status.length > 0 || filters.type.length > 0 || stageFilter !== null;

      let content;
      if (sessionId === null) {
        content = h(StateNotice, {
          title: '缺少会话上下文',
          message: '该右栏 tab 没有拿到 sessionId，无法读取看板。请关闭后从会话右栏重新打开「Bug 看板」。',
          tone: 'danger',
        });
      } else if (snapshot === null && polling.loading) {
        content = h(StateNotice, { title: '加载中…', message: '正在读取工单快照。' });
      } else if (snapshot === null) {
        const code = polling.error === null ? '' : errorCodeText(polling.error);
        const stage = polling.error !== null && typeof polling.error.stage === 'string' && polling.error.stage !== ''
          ? `（阶段：${polling.error.stage}）`
          : '';
        content = h(StateNotice, {
          title: '看板暂时不可用',
          message: polling.error === null
            ? '未获取到快照，请重试。'
            : `${code === '' ? '' : `[${code}] `}${polling.error.message}${stage}`,
          actionLabel: '重试',
          onAction: polling.refresh,
          busy: polling.refreshing,
          tone: 'danger',
        });
      } else if (activeTickets.length === 0) {
        const archived = tickets.length > 0;
        content = h(StateNotice, {
          title: archived ? '没有进行中的工单' : '还没有工单',
          message: canWrite
            ? (archived
              ? '已完成（done）的工单会从列表中隐藏（宿主仍保留数据）；可以创建一张新的演示工单继续验收。'
              : 'P1 使用假引擎：点击下方按钮创建一张演示工单，然后在详情里按流程推进。')
            : `${archived ? '已完成（done）的工单会从列表中隐藏。' : '当前工作区还没有工单。'}${UNBOUND_WORKSPACE_HINT}`,
          actionLabel: busyAction === 'create' ? '创建中…' : '添加演示工单',
          onAction: requestCreateDemo,
          busy: busyAction !== null || !canWrite,
        });
      } else if (visibleTickets.length === 0) {
        content = h(StateNotice, {
          title: '没有符合筛选条件的工单',
          message: `共 ${activeTickets.length} 张进行中的工单，当前筛选条件下没有匹配项。`,
          actionLabel: '清除筛选',
          onAction: clearFilters,
        });
      } else {
        content = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 } },
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, lineHeight: '16px', color: C.textTertiary, minWidth: 0 },
          },
            h('span', null, `共 ${activeTickets.length} 张 · 显示 ${visibleTickets.length} 张`),
            filtersActive
              ? h('button', {
                type: 'button',
                onClick: clearFilters,
                style: { ...smallButtonStyle(false), padding: '0 6px', fontSize: 11, lineHeight: '16px' },
              }, '清除筛选')
              : null),
          h(StageOverview, {
            lanes: laneData,
            activeLane: stageFilter,
            onSelectLane: setStageFilter,
          }),
          h(LaneBoard, {
            lanes: lanesForBoard,
            mode: laneMode,
            selectedCode,
            onSelect: setSelectedCode,
            snapshot,
          }));
      }

      return h('div', {
        'data-bug-board': 'root',
        'data-bug-board-view': selectedTicket === null ? 'list' : 'detail',
        'data-bug-board-lane': laneMode,
        'data-bug-board-settings-open': settingsOpen === true ? 'true' : 'false',
        style: {
          display: 'flex',
          flexDirection: 'column',
          flex: '1 1 auto',
          height: '100%',
          minHeight: 0,
          minWidth: 0,
          overflow: 'hidden',
          background: 'var(--dsw-alias-bg-base, transparent)',
          color: C.text,
          font: '13px/1.5 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
          boxSizing: 'border-box',
        },
      },
        h(BoardHeader, {
          snapshot,
          refreshing: polling.refreshing,
          syncing,
          busy: busyAction,
          configured,
          sessionId,
          statusOptions,
          typeOptions,
          filters,
          manualCode,
          settingsOpen,
          settingsBusy: settingsSaving,
          settingsButtonRef,
          onManualCodeChange: setManualCode,
          onManualImport: importTicketFromPlatform,
          onToggleFilter: toggleFilter,
          onClearFilters: clearFilters,
          onRefresh: polling.refresh,
          onSync: syncFromPlatform,
          onCreateDemo: requestCreateDemo,
          onToggleSettings: toggleSettings,
        }),
        showBanner
          ? h(ErrorBanner, {
            title: bannerTitle,
            error: bannerError,
            busy: polling.refreshing,
            onRetry: () => {
              setActionError(null);
              polling.refresh();
            },
            onDismiss: () => {
              setActionError(null);
              polling.dismissError();
            },
          })
          : null,
        flash === null
          ? null
          : h('div', {
            role: 'status',
            style: {
              padding: '6px 12px',
              borderBottom: `0.5px solid ${C.border}`,
              background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)',
              color: C.success,
              fontSize: 12,
              lineHeight: '18px',
              flex: '0 0 auto',
            },
          }, flash),
        pendingRequest === null
          ? null
          : h(ActionDialog, {
            key: `${pendingRequest.kind}:${pendingRequest.ticket === undefined ? 'new' : pendingRequest.ticket.code}:${pendingRequest.descriptor.action}`,
            request: pendingRequest,
            busy: busyAction !== null,
            onCancel: () => setPendingRequest(null),
            onConfirm: confirmPendingAction,
          }),
        h('div', {
          style: {
            position: 'relative',
            flex: '1 1 auto',
            minHeight: 0,
            minWidth: 0,
            display: 'flex',
            boxSizing: 'border-box',
          },
        },
          h('div', {
            ref: laneBodyRef,
            style: {
              flex: '1 1 auto',
              minHeight: 0,
              minWidth: 0,
              overflowY: 'auto',
              overflowX: 'hidden',
              padding: '10px 12px 18px',
              boxSizing: 'border-box',
            },
          }, selectedTicket === null
            ? content
            : h(TicketDetail, {
              ticket: selectedTicket,
              snapshot,
              busyAction,
              locked: !canWrite,
              onAction: (descriptor) => requestAction(descriptor, selectedTicket),
              onBack: () => setSelectedCode(null),
            })),
          settingsOpen === true
            ? h(SettingsPanel, {
              draft: settingsDraft,
              errors: settingsErrors,
              dirty: settingsDirty,
              saving: settingsSaving,
              configured,
              sessionMissing: sessionId === null,
              workspaceKnown: snapshot !== null,
              workspacePath: snapshot === null ? null : snapshot.workspace.path,
              tokenDraft,
              tokenBusy,
              tokenPresent,
              gitlabTokenDraft,
              gitlabTokenBusy,
              gitlabTokenPresent,
              loginUsername,
              loginPassword,
              loginCode,
              loginCaptcha,
              loginBusy,
              loginError,
              onChange: updateSettingsField,
              onTokenChange: setTokenDraft,
              onSaveToken: savePlatformToken,
              onClearToken: clearPlatformToken,
              onGitlabTokenChange: setGitlabTokenDraft,
              onSaveGitlabToken: saveGitlabToken,
              onClearGitlabToken: clearGitlabToken,
              onLoginUsernameChange: setLoginUsername,
              onLoginPasswordChange: setLoginPassword,
              onLoginCodeChange: setLoginCode,
              onRefreshCaptcha: fetchLoginCaptcha,
              onLoginSubmit: submitPlatformLogin,
              onSave: saveSettings,
              onCancel: closeSettings,
            })
            : null));
    }

    /**
     * Render-failure containment: a thrown render shows a compact fallback with
     * a retry button instead of blanking the right sidebar slot.
     */
    class PanelErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
        this.reset = this.reset.bind(this);
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error) {
        try {
          console.error('[bug-workflow] board render failed:', error);
        } catch {
          // Console unavailable; the fallback still renders.
        }
      }

      reset() {
        this.setState({ error: null });
      }

      render() {
        if (this.state.error !== null) {
          return h('div', {
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: 16,
              color: C.text,
              font: '13px/1.5 system-ui, sans-serif',
            },
          },
            h('div', { style: { fontSize: 13, fontWeight: 600, color: C.error } }, '看板渲染出错'),
            h('div', {
              style: { fontSize: 12, lineHeight: '18px', color: C.textSecondary, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
            }, clip(this.state.error instanceof Error ? this.state.error.message : this.state.error, 500)),
            h('button', { type: 'button', onClick: this.reset, style: primaryButtonStyle(false) }, '重新渲染'));
        }
        return this.props.children;
      }
    }

    function BoardTab(props) {
      const raw = props && typeof props === 'object' ? props.sessionId : undefined;
      const sessionId = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
      return h(PanelErrorBoundary, null, h(Board, { sessionId }));
    }

    return {
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: 'bug-board',
          title: () => 'Bug 看板',
          multiple: false,
          guide: [{ id: 'bug-board', order: 100, title: () => 'Bug 看板' }],
        }), 'bug-workflow: tab type');
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: ID,
        }, BoardTab)), 'bug-workflow: tab body');
      },
    };
  },
});
