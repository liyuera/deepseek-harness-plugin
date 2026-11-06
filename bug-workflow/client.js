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
 *   - `usePolling(snapshotUrl, 3000)` reads `GET /bug-workflow/api/snapshot`
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
 *   - `PanelErrorBoundary` keeps a render failure from blanking the whole slot.
 *
 * The client never re-implements the state machine: action buttons are derived
 * from the declarative `ACTION_BY_STATE` map (extracted and cross-checked
 * against `src/host/state-machine.js` by `test/client-action-map.test.js`).
 * The host remains the authority on transitions (an illegal one comes back as a
 * 409 and is reported in the UI).
 */

window.__ModuleLoader__.load({
  id: '@liyuera/dsh-bug-workflow',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ID = '@liyuera/dsh-bug-workflow';

    /** Snapshot/action endpoints (same origin as the Harness Web page). */
    const API = Object.freeze({
      snapshot: '/bug-workflow/api/snapshot',
      action: '/bug-workflow/api/action',
    });

    /** Poll cadence in milliseconds (P1 contract: every 3 s). */
    const POLL_INTERVAL_MS = 3000;

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
    });

    const ACTOR_LABELS = Object.freeze({ user: '用户', agent: '代理', system: '系统' });
    const VERDICT_LABELS = Object.freeze({ pass: '通过', changes: '需修改' });
    const MR_STATE_LABELS = Object.freeze({ open: '进行中', merged: '已合并', closed: '已关闭' });

    /** Review round budget mirrored from the host state machine. */
    const MAX_REVIEW_ROUNDS = 3;

    /** Shown whenever the session has no workspace: every mutation is gated. */
    const UNBOUND_WORKSPACE_HINT = '当前会话未绑定工作区，暂不能写入；请在已绑定工作区的会话中使用（Task 5 将提供设置入口）';

    // <client-action-map>
    /**
     * Action buttons per workflow state (the exact P1 mapping).
     * `tone` drives styling, `confirm` is the confirmation text, `input`
     * declares an in-component text input, and `payload` is the fixed body.
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
      submitting: [
        {
          action: 'submit_mr',
          label: '提交 MR',
          confirm: '确认提交 MR？',
          tone: 'primary',
        },
        {
          action: 'mr_created',
          label: '模拟 MR 已创建',
          confirm: '确认模拟 MR 已创建？',
          tone: 'plain',
        },
      ],
      mr_open: [
        {
          action: 'review_requests_changes',
          label: '模拟 Review 需修改',
          confirm: '确认模拟 Review 要求修改？将生成一条演示阻塞问题。',
          tone: 'plain',
          payload: {
            blockingIssues: [
              {
                fid: 'demo-1',
                file: 'src/demo.ts',
                level: '中',
                gateCategory: '逻辑错误',
                location: 'src/demo.ts:1-2',
                problem: 'P1 演示问题',
                suggestion: '演示建议',
                blocking: true,
              },
            ],
          },
        },
        {
          action: 'review_pass',
          label: '模拟 Review 通过',
          confirm: '确认模拟 Review 通过？',
          tone: 'primary',
        },
      ],
      fixing_review: [
        {
          action: 'review_fix_done',
          label: 'Review 修复完成',
          confirm: '确认 Review 阻塞问题已修复并重新提交？',
          tone: 'primary',
        },
      ],
      mergeable: [
        {
          action: 'mr_merged',
          label: '模拟已合并',
          confirm: '确认模拟 MR 已合并？',
          tone: 'primary',
        },
      ],
      merged: [
        {
          action: 'dismiss',
          label: '完成并移除',
          confirm: '确认完成并移除该工单？终态后不可再操作。',
          tone: 'primary',
        },
      ],
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

    function dimensionText(value) {
      return value === '' ? '未设置' : value;
    }

    function uniqueDimensions(tickets, field) {
      const seen = new Set();
      for (const ticket of tickets) {
        if (!ticket || typeof ticket !== 'object') continue;
        seen.add(dimensionValue(ticket[field]));
      }
      return Array.from(seen);
    }

    /** Optional platform type dictionary; P1 normally has none and shows raw. */
    function typeLabel(value, snapshot) {
      const raw = dimensionValue(value);
      if (raw === '') return '未设置';
      const snapshotValue = snapshot && typeof snapshot === 'object' ? snapshot : {};
      const dictionaries = [
        snapshotValue.typeDict,
        snapshotValue.dictionaries && snapshotValue.dictionaries.type,
        snapshotValue.settings && snapshotValue.settings.typeDict,
      ];
      for (const dictionary of dictionaries) {
        if (!Array.isArray(dictionary)) continue;
        for (const entry of dictionary) {
          if (!entry || typeof entry !== 'object') continue;
          const candidate = entry.value ?? entry.code ?? entry.key;
          if (candidate !== raw) continue;
          return textOf(entry.label ?? entry.name, raw);
        }
      }
      return raw;
    }

    function safeHttpUrl(value) {
      if (typeof value !== 'string') return null;
      const trimmed = value.trim();
      if (!/^https?:\/\//i.test(trimmed)) return null;
      return trimmed;
    }

    function normalizeSnapshot(payload) {
      const value = payload && typeof payload === 'object' ? payload : {};
      const workspace = value.workspace && typeof value.workspace === 'object' ? value.workspace : {};
      return {
        workspace: {
          path: typeof workspace.path === 'string' ? workspace.path : null,
          configured: workspace.configured === true,
        },
        settings: value.settings && typeof value.settings === 'object' ? value.settings : {},
        tickets: Array.isArray(value.tickets)
          ? value.tickets.filter((ticket) => ticket && typeof ticket === 'object' && typeof ticket.code === 'string')
          : [],
        serverTime: typeof value.serverTime === 'string' ? value.serverTime : null,
      };
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
      };
    }

    function FilterChips({ label, options, selected, onToggle, formatOption }) {
      if (options.length === 0 && selected.length === 0) return null;
      const merged = Array.from(new Set([...options, ...selected]));
      const format = typeof formatOption === 'function' ? formatOption : dimensionText;
      return h('div', {
        style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, minWidth: 0 },
        role: 'group',
        'aria-label': `${textOf(label)}筛选`,
      },
        h('span', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary, marginRight: 2 } }, textOf(label)),
        merged.map((value) => h('button', {
          key: `chip-${value === '' ? 'none' : value}`,
          type: 'button',
          'aria-pressed': selected.includes(value),
          onClick: () => onToggle(value),
          style: chipStyle(selected.includes(value)),
        }, format(value))));
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

    function BoardHeader({
      snapshot,
      refreshing,
      busy,
      configured,
      sessionId,
      statusOptions,
      typeOptions,
      filters,
      manualCode,
      onManualCodeChange,
      onManualAdd,
      onToggleFilter,
      onClearFilters,
      onRefresh,
      onCreateDemo,
    }) {
      const workspace = snapshot === null ? null : snapshot.workspace;
      const path = workspace !== null && typeof workspace.path === 'string' ? workspace.path : null;
      const sessionMissing = sessionId === null;
      const writable = !sessionMissing && configured === true;
      const name = path !== null && path !== '' ? baseName(path) : (snapshot === null ? '加载工作区…' : '未绑定工作区');
      const subtitle = sessionMissing
        ? '缺少会话上下文，当前为只读展示'
        : (snapshot === null
          ? '正在读取本工作区看板…'
          : (path === null
            ? '该会话没有工作区目录，看板仍显示本机全部工单'
            : (refreshing ? '同步中…' : `Bug 工作流 · 每 ${POLL_INTERVAL_MS / 1000} 秒自动同步`)));
      const hasFilters = filters.status.length > 0 || filters.type.length > 0;
      const disabled = busy !== null;
      const code = typeof manualCode === 'string' ? manualCode : '';
      const manualDisabled = disabled || !writable || code.trim() === '';

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
          }, refreshing ? '同步中…' : '刷新'),
          h('button', {
            type: 'button',
            onClick: onCreateDemo,
            disabled: disabled || !writable,
            style: primaryButtonStyle(disabled || !writable),
          }, busy === 'create' ? '创建中…' : '添加演示工单')),
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
            if (!manualDisabled) onManualAdd();
          },
          'aria-label': '手动添加工单',
          style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0 },
        },
          h('input', {
            type: 'text',
            value: code,
            onChange: (event) => onManualCodeChange(event.target.value),
            placeholder: '输入工单编号',
            'aria-label': '工单编号',
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
            style: smallButtonStyle(manualDisabled),
          }, busy === 'manual-create' ? '添加中…' : '手动添加'),
          h('span', {
            style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary, minWidth: 0 },
          }, '编号不能为空；重复编号会提示已存在')),
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

    function ActionBar({ actions, busyAction, onAction, locked }) {
      const list = Array.isArray(actions) ? actions : [];
      if (list.length === 0) return null;
      const isLocked = locked === true;
      const disabled = busyAction !== null || isLocked;
      return h('div', {
        style: { display: 'flex', flexWrap: 'wrap', gap: 6, minWidth: 0 },
        role: 'group',
        'aria-label': '工单动作',
      }, list.map((descriptor) => {
        const busy = busyAction === descriptor.action;
        return h('button', {
          key: `action-${descriptor.action}`,
          type: 'button',
          disabled,
          'aria-busy': busy || undefined,
          'aria-disabled': isLocked || undefined,
          onClick: () => {
            if (typeof onAction === 'function') onAction(descriptor);
          },
          style: actionButtonStyle(descriptor.tone, disabled),
          title: isLocked ? UNBOUND_WORKSPACE_HINT : textOf(descriptor.confirm),
        }, busy ? '处理中…' : textOf(descriptor.label));
      }));
    }

    function TicketRow({ ticket, selected, onSelect, snapshot }) {
      const title = typeof ticket.title === 'string' && ticket.title.trim() !== '' ? ticket.title : '（无标题）';
      return h('button', {
        type: 'button',
        onClick: () => onSelect(ticket.code),
        'aria-current': selected ? 'true' : undefined,
        'aria-label': `工单 ${ticket.code} ${title}，${workflowLabel(ticket.workflow)}`,
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
          h(Badge, { label: workflowLabel(ticket.workflow), tone: workflowTone(ticket.workflow) })),
        h('div', {
          style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 8px', fontSize: 11, lineHeight: '16px', color: C.textTertiary },
        },
          h('span', null, `类型：${typeLabel(ticket.type, snapshot)}`),
          h('span', null, `平台状态：${ticket.status ? ticket.status : '未设置'}`),
          h('span', null, `优先级：${ticket.priority ? ticket.priority : '—'}`),
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
        ['类型', typeLabel(ticket.type, snapshot)],
        ['平台状态', typeof ticket.status === 'string' && ticket.status !== '' ? ticket.status : '未设置'],
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

    function PlanCard({ plan, workflow, footer }) {
      const value = plan !== null && typeof plan === 'object' ? plan : null;
      const body = [];
      if (value === null) {
        body.push(h('p', { key: 'plan-empty', style: emptyTextStyle },
          workflow === 'analyzing' ? '分析进行中，完成后会生成方案。' : '暂无方案。'));
      } else {
        body.push(h(TextField, { key: 'plan-summary', label: '摘要', value: value.summary }));
        body.push(h(TextField, { key: 'plan-root-cause', label: '根因', value: value.rootCause }));
        body.push(h(TextField, { key: 'plan-approach', label: '方案', value: value.approach }));
        body.push(h(ListField, { key: 'plan-files', label: '改动文件', values: value.changedFiles }));
        body.push(h(ListField, { key: 'plan-risks', label: '风险', values: value.risks }));
        body.push(h(TextField, { key: 'plan-test-plan', label: '测试建议', value: value.testPlan }));
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

    function FixCard({ fixes }) {
      const list = Array.isArray(fixes) ? fixes.filter((fix) => fix && typeof fix === 'object') : [];
      if (list.length === 0) {
        return h(Card, { title: '修复记录' }, h('p', { style: emptyTextStyle }, '暂无修复记录。'));
      }
      const ordered = list.slice().reverse();
      return h(Card, { title: '修复记录', aside: `${list.length} 次` }, ...ordered.map((fix, index) => {
        const files = Array.isArray(fix.changedFiles) ? fix.changedFiles : [];
        const evidence = Array.isArray(fix.evidence) ? fix.evidence : [];
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
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, lineHeight: '16px', color: C.textTertiary } },
            h('span', null, typeof fix.at === 'string' ? formatTime(fix.at) : `第 ${list.length - index} 次`),
            fix.diffStat === undefined ? null : h('span', null, `改动：${clip(fix.diffStat, 160)}`),
            fix.testResult === undefined ? null : h('span', { style: { color: C.textSecondary } }, `测试：${clip(fix.testResult, 160)}`)),
          files.length === 0
            ? null
            : h('div', { style: { ...fieldValueStyle, fontSize: 12 } }, `文件：${files.map((file) => clip(file, 160)).join('、')}`),
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
      const testResult = latest === null ? undefined : latest.testResult;
      const evidence = latest === null || !Array.isArray(latest.evidence) ? [] : latest.evidence;
      const statusText = workflow === 'fix_done'
        ? '待人工测试：完成测试后点击「标记测试通过」。'
        : (workflow === 'fixing'
          ? '修复进行中，暂无人工测试记录。'
          : (list.length === 0 ? '暂无测试记录。' : '最近一次修复的测试结果如下。'));
      return h(Card, { title: '测试与证据' },
        h('p', { style: emptyTextStyle }, statusText),
        testResult === undefined || testResult === null
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
      const url = mr === null ? null : safeHttpUrl(mr.url);
      const iid = mr === null ? null : textOf(mr.iid);
      return h(Card, { title: 'MR 与分支', aside: iid === null || iid === '' ? undefined : `!${iid}` },
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
          h('div', { style: fieldLabelStyle }, '分支'),
          h('div', { style: { ...fieldValueStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 11.5 } },
            `${source} → ${target}`)),
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

    function IssueList({ issues, title }) {
      if (!Array.isArray(issues) || issues.length === 0) return null;
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
        h('div', { style: fieldLabelStyle }, title),
        h('ul', {
          style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 5 },
        }, issues.map((issue, index) => {
          const value = issue && typeof issue === 'object' ? issue : { problem: issue };
          const heading = [textOf(value.file), textOf(value.level)].filter((part) => part !== '').join(' · ');
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
            h('div', { style: { ...fieldValueStyle, fontSize: 12 } }, textOf(value.problem, '—')),
            typeof value.suggestion === 'string' && value.suggestion !== ''
              ? h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } }, `建议：${clip(value.suggestion, 300)}`)
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

    function BlockedNotice({ ticket }) {
      if (ticket.workflow !== 'blocked') return null;
      const from = typeof ticket.blockedFrom === 'string' && ticket.blockedFrom !== ''
        ? workflowLabel(ticket.blockedFrom)
        : null;
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
          `原因：${typeof ticket.blockedReason === 'string' && ticket.blockedReason !== '' ? clip(ticket.blockedReason, 300) : '未记录'}`),
        from === null
          ? null
          : h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textSecondary } }, `阻塞前状态：${from}`),
        h('div', { style: { fontSize: 11, lineHeight: '16px', color: C.textTertiary } }, '处理完成后可点击「重试」回到阻塞前状态。'));
    }

    function TicketDetail({ ticket, snapshot, busyAction, locked, onAction, onBack }) {
      const actions = ACTION_BY_STATE[ticket.workflow] ?? [];
      const planReview = ticket.workflow === 'plan_review';
      const actionBar = h(ActionBar, {
        actions,
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
        h(BlockedNotice, { ticket }),
        planReview ? null : actionBar,
        h(FieldsBlock, { ticket, snapshot }),
        h(PlanCard, { plan: ticket.plan, workflow: ticket.workflow, footer: planReview ? actionBar : null }),
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
      const [busyAction, setBusyAction] = React.useState(null);
      const [actionError, setActionError] = React.useState(null);
      const [flash, setFlash] = React.useState(null);
      const [manualCode, setManualCode] = React.useState('');
      const [pendingRequest, setPendingRequest] = React.useState(null);
      const busyRef = React.useRef(false);
      const mutationControllerRef = React.useRef(null);

      const snapshot = polling.data;
      const tickets = snapshot === null ? [] : snapshot.tickets;
      const configured = snapshot !== null && snapshot.workspace.configured === true;
      const canWrite = sessionId !== null && configured;

      React.useEffect(() => {
        if (selectedCode === null || snapshot === null) return;
        if (!tickets.some((ticket) => ticket.code === selectedCode)) setSelectedCode(null);
      }, [selectedCode, snapshot, tickets]);

      React.useEffect(() => {
        if (flash === null) return undefined;
        const timer = setTimeout(() => setFlash(null), 4000);
        return () => clearTimeout(timer);
      }, [flash]);

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

      const postAction = React.useCallback(async (body) => {
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
          return await api.post(API.action, body, controller === null ? undefined : controller.signal);
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

      const executeAction = React.useCallback(async (descriptor, ticket, reason) => {
        if (!descriptor || !ticket || busyRef.current || typeof ticket.code !== 'string') return;
        if (sessionId === null || configured !== true) return;

        let payload = descriptor.payload === undefined || descriptor.payload === null ? {} : descriptor.payload;
        if (descriptor.input === 'reason') {
          const trimmed = typeof reason === 'string' ? reason.trim() : '';
          payload = { ...payload, reason: trimmed === '' ? '未填写驳回原因' : trimmed };
        }

        busyRef.current = true;
        setPendingRequest(null);
        setBusyAction(descriptor.action);
        setActionError(null);
        setFlash(null);

        try {
          const result = await postAction({
            sessionId,
            actionId: createActionId(),
            code: ticket.code,
            action: descriptor.action,
            payload,
          });
          if (result.aborted === true) return;

          if (result.ok) {
            const next = result.data && typeof result.data === 'object' ? result.data.ticket : null;
            const nextWorkflow = next && typeof next.workflow === 'string' ? next.workflow : null;
            setFlash(nextWorkflow === null
              ? `工单 ${ticket.code} 操作成功`
              : `工单 ${ticket.code} 已更新：${workflowLabel(nextWorkflow)}`);
          } else {
            setActionError(toErrorView(result));
          }

          // Refresh after success and after a rejected action: a 409 may have
          // changed the ticket server-side (e.g. review rounds -> blocked).
          try {
            await polling.refresh();
          } catch {
            // The polling banner (or the next poll) reports a failed refresh.
          }
        } finally {
          busyRef.current = false;
          setBusyAction(null);
        }
      }, [configured, polling, postAction, sessionId]);

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
          const result = await postAction({
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
      }, [configured, polling, postAction, sessionId]);

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

      const addManualTicket = React.useCallback(async () => {
        const code = manualCode.trim();
        if (busyRef.current || sessionId === null || configured !== true) return;
        if (code === '') {
          setActionError({ code: 'missing-code', message: '请输入工单编号', status: null, stage: null });
          return;
        }

        busyRef.current = true;
        setPendingRequest(null);
        setBusyAction('manual-create');
        setActionError(null);
        setFlash(null);

        try {
          const result = await postAction({
            sessionId,
            actionId: createActionId(),
            code,
            action: 'create',
            payload: { code, title: `（待同步）${code}`, type: '缺陷', version: 'V0.0.0' },
          });
          if (result.aborted === true) return;

          if (result.ok) {
            const created = result.data && typeof result.data === 'object' ? result.data.ticket : null;
            setManualCode('');
            setFlash(`工单 ${created && typeof created.code === 'string' ? created.code : code} 已添加`);
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
      }, [configured, manualCode, polling, postAction, sessionId]);

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
      }, []);

      // `dismiss` moves a ticket to the terminal `done` state; keep it in the
      // store (a just-dismissed detail still resolves) but hide it from the
      // list and from filter options. Task 6's README should document this P1
      // archive behaviour; the host state is never deleted here.
      const activeTickets = React.useMemo(
        () => tickets.filter((ticket) => ticket.workflow !== 'done'),
        [tickets],
      );

      const statusOptions = React.useMemo(() => uniqueDimensions(activeTickets, 'status'), [activeTickets]);
      const typeOptions = React.useMemo(() => uniqueDimensions(activeTickets, 'type'), [activeTickets]);

      const visibleTickets = React.useMemo(() => activeTickets.filter((ticket) => {
        if (filters.status.length > 0 && !filters.status.includes(dimensionValue(ticket.status))) return false;
        if (filters.type.length > 0 && !filters.type.includes(dimensionValue(ticket.type))) return false;
        return true;
      }), [activeTickets, filters]);

      const selectedTicket = selectedCode === null
        ? null
        : tickets.find((ticket) => ticket.code === selectedCode) ?? null;

      const bannerError = actionError ?? (polling.error === null ? null : polling.error);
      const bannerTitle = actionError === null ? '同步失败' : '操作失败';
      const showBanner = bannerError !== null && (snapshot !== null || actionError !== null);
      const filtersActive = filters.status.length > 0 || filters.type.length > 0;

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
        content = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
          h('div', {
            style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, lineHeight: '16px', color: C.textTertiary },
          },
            h('span', null, `共 ${activeTickets.length} 张 · 显示 ${visibleTickets.length} 张`),
            filtersActive
              ? h('button', {
                type: 'button',
                onClick: clearFilters,
                style: { ...smallButtonStyle(false), padding: '0 6px', fontSize: 11, lineHeight: '16px' },
              }, '清除筛选')
              : null),
          h(TicketList, {
            tickets: visibleTickets,
            selectedCode,
            onSelect: setSelectedCode,
            snapshot,
          }));
      }

      return h('div', {
        'data-bug-board': 'root',
        'data-bug-board-view': selectedTicket === null ? 'list' : 'detail',
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
          busy: busyAction,
          configured,
          sessionId,
          statusOptions,
          typeOptions,
          filters,
          manualCode,
          onManualCodeChange: setManualCode,
          onManualAdd: addManualTicket,
          onToggleFilter: toggleFilter,
          onClearFilters: clearFilters,
          onRefresh: polling.refresh,
          onCreateDemo: requestCreateDemo,
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
            flex: '1 1 auto',
            minHeight: 0,
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
          })));
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
