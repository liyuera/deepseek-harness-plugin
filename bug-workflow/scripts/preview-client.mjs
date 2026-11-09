/**
 * Headless preview harness for the bug-workflow client (design iteration only).
 *
 * Loads the real `bug-workflow/client.js` bundle with a minimal fake React
 * (hooks + createElement + class Component), drives the real BoardTab once with
 * a fixture snapshot, and serializes the resulting element tree to static HTML.
 *
 * This is NOT a test: it exists so the redesign can be visually checked (and
 * screenshotted) without the DSH desktop host. It intentionally implements only
 * the React surface the client uses (useState/useEffect/useMemo/useRef/
 * useCallback/createElement/Component).
 *
 * Usage: node /tmp/preview-client.mjs <width> > /tmp/preview.html
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WIDTH = Number(process.argv[2] || 430);
const CLIENT = process.env.CLIENT_FILE || resolve(SCRIPT_DIR, '../client.js');

const SOURCE = readFileSync(CLIENT, 'utf8');

// ---------------------------------------------------------------------------
// Minimal React
// ---------------------------------------------------------------------------

let currentContext = null;
let renderDirty = false;
const instances = new Map();
const effectQueue = [];

function makeContext(path) {
  if (!instances.has(path)) instances.set(path, { slots: [], path });
  return instances.get(path);
}

function slotInit(init) {
  return typeof init === 'function' ? init() : init;
}

function useState(init) {
  const ctx = currentContext;
  const index = ctx.index;
  ctx.index += 1;
  if (ctx.slots[index] === undefined) {
    ctx.slots[index] = { kind: 'state', value: slotInit(init) };
  }
  const slot = ctx.slots[index];
  const set = (value) => {
    const next = typeof value === 'function' ? value(slot.value) : value;
    if (slot.value !== next) {
      slot.value = next;
      renderDirty = true;
    }
  };
  return [slot.value, set];
}

function useRef(init) {
  const ctx = currentContext;
  const index = ctx.index;
  ctx.index += 1;
  if (ctx.slots[index] === undefined) {
    ctx.slots[index] = { kind: 'ref', value: { current: init } };
  }
  return ctx.slots[index].value;
}

function useMemo(fn, deps) {
  const ctx = currentContext;
  const index = ctx.index;
  ctx.index += 1;
  const previous = ctx.slots[index];
  if (previous === undefined || previous.kind !== 'memo' || !sameDeps(previous.deps, deps)) {
    ctx.slots[index] = { kind: 'memo', deps, value: fn() };
  }
  return ctx.slots[index].value;
}

function useCallback(fn, deps) {
  const ctx = currentContext;
  const index = ctx.index;
  ctx.index += 1;
  // Mirror React: keep the previous identity while deps are shallow-equal.
  const previous = ctx.slots[index];
  if (previous === undefined || previous.kind !== 'callback' || !sameDeps(previous.deps, deps)) {
    ctx.slots[index] = { kind: 'callback', deps, value: fn };
  }
  return ctx.slots[index].value;
}

function useEffect(fn, deps) {
  const ctx = currentContext;
  const index = ctx.index;
  ctx.index += 1;
  const previous = ctx.slots[index];
  const same = previous !== undefined && previous.kind === 'effect' && sameDeps(previous.deps, deps);
  if (!same) effectQueue.push(fn);
  ctx.slots[index] = { kind: 'effect', deps };
}

function sameDeps(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

class Component {
  constructor(props) {
    this.props = props;
    this.state = {};
  }

  setState(patch) {
    const next = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...next };
    renderDirty = true;
  }
}

function renderComponent(type, props, path) {
  const ctx = makeContext(path);
  const previous = currentContext;
  currentContext = ctx;
  ctx.childSeq = 0;
  ctx.index = 0;
  try {
    if (type.prototype instanceof Component) {
      if (!ctx.instance) ctx.instance = new type(props);
      else ctx.instance.props = props;
      return ctx.instance.render();
    }
    return type(props);
  } finally {
    currentContext = previous;
  }
}

function createElement(type, props, ...children) {
  const flat = [];
  const push = (value) => {
    if (value === null || value === undefined || value === false || value === true) return;
    if (Array.isArray(value)) {
      for (const item of value) push(item);
      return;
    }
    flat.push(value);
  };
  for (const child of children) push(child);
  if (typeof type === 'function') {
    const resolvedProps = { ...(props || {}) };
    if (flat.length === 1) resolvedProps.children = flat[0];
    else if (flat.length > 1) resolvedProps.children = flat;
    const path = `${currentContext === null ? 'root' : currentContext.path}/${(currentContext.childSeq = (currentContext.childSeq || 0) + 1)}`;
    return renderComponent(type, resolvedProps, path);
  }
  const elementProps = props || {};
  const element = { kind: 'element', type, props: elementProps, children: flat };
  if (elementProps.ref !== null && typeof elementProps.ref === 'object') {
    elementProps.ref.current = { clientWidth: previewWidth, clientHeight: 900 };
  }
  return element;
}

const React = {
  createElement,
  useState,
  useRef,
  useMemo,
  useCallback,
  useEffect,
  Component,
  Fragment: 'fragment',
};

// ---------------------------------------------------------------------------
// Fixture snapshot
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-11-07T11:30:00.000Z');
const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60000).toISOString();
const PLAN = {
  summary: '为看板列表新增「导出 Excel」：复用列表字段生成表格，宿主零依赖写 xlsx',
  rootCause: '看板只有筛选与渲染，没有导出列模型和文件下载链路',
  approach: '客户端复用列表字段生成二维表 → POST 导出接口；宿主用 SpreadsheetML inlineStr 生成 xlsx',
  changedFiles: ['bug-workflow/client.js', 'bug-workflow/src/host/xlsx.js', 'bug-workflow/src/host/routes.js'],
  risks: ['桌面端下载策略可能拦截，需要失败提示'],
  testPlan: '全量单测 + openpyxl 打开生成文件校验',
  generatedAt: iso(200),
  approvedAt: iso(199),
  rejectedReason: null,
};

function baseTicket(code, title, type, workflow, minutesAgo, extra = {}) {
  return {
    code,
    title,
    type,
    status: '处理中',
    version: 'V1.2.0',
    priority: '中',
    assignee: '李昱',
    source: 'platform',
    url: 'https://ecard.htwisdom.cn/HT_TEAM/',
    workflow,
    // Realistic platform status labels so the default 待办/进行中 filter shows
    // the board instead of an empty result in the preview.
    status: workflow === 'inbox' ? '待办' : '进行中',
    createdAt: iso(600),
    updatedAt: iso(minutesAgo),
    plan: null,
    fixes: [],
    mr: null,
    reviewRounds: [],
    branch: null,
    timeline: [],
    platform: { typeName: type, statusName: '处理中', versionName: 'V1.2.0', projectName: '星瞰河山' },
    ...extra,
  };
}

const snapshot = {
  ok: true,
  serverTime: iso(0),
  workspace: { path: '/Users/liyu/Documents/www/DeepSeek/deepseek-harness/deepseek-harness-plugin', configured: true },
  settings: {
    platformBaseUrl: 'https://ecard.htwisdom.cn',
    platformProjectCode: '',
    gitlabBaseUrl: 'https://git.htwisdom.cn',
    gitlabProjectPath: 'wisdom-financial-service-platform/wisdom-financial-credit-platform-web',
    branchUser: 'ly',
    gitlabReviewer: '',
    commitType: 'fix',
    lintCommand: '',
    testCommand: '',
    devCommand: '',
    previewUrl: '',
    writebackStatus: false,
  },
  // The preview starts logged out so the in-board login form (and its captcha
  // fetch) is exercised; the manual token card stays collapsed.
  platform: { tokenPresent: false, lastSyncAt: iso(2), lastSyncError: null },
  gitlab: { tokenPresent: true },
  dicts: { status: [], type: [], priority: [] },
  analysis: { running: [], errors: {} },
  fix: { running: ['YGFNXDJRFWDJSYJJYY-647'], errors: {} },
  delivery: { running: [], errors: {} },
  review: { running: ['HTSMART-15'], errors: {} },
  tickets: [
    baseTicket('HTSMART-12', '权限中心批量授权后列表未刷新', '任务', 'plan_review', 125, { plan: PLAN, version: 'V2.0.0' }),
    baseTicket('YGFNXDJRFWDJSYJJYY-648', '新增工单导出 Excel 能力', '需求', 'fix_done', 26, {
      plan: PLAN,
      branch: { name: 'feat-V1.2.0-ly', target: 'feature-V1.2.0', baseSource: 'HEAD', worktree: '/tmp/wt-648' },
      fixes: [{
        runId: 'fix-1', startedAt: iso(32), finishedAt: iso(26), changedFiles: ['bug-workflow/client.js', 'bug-workflow/src/host/xlsx.js'],
        diffStat: '3 files changed, 718 insertions(+), 22 deletions(-)', summary: '完成导出能力', testResult: '372/372', status: 'succeeded',
      }],
    }),
    baseTicket('P1-E2E-2', '支付回调重复入账（幂等键缺失）', '缺陷', 'mr_open', 8, {
      mr: { iid: 102, url: 'https://git.htwisdom.cn/x/-/merge_requests/102', sourceBranch: 'feat-V1.2.0-ly', targetBranch: 'feature-V1.2.0', state: 'open', verdict: 'changes', blockingIssues: 1, nonBlockingIssues: 2, rounds: 1 },
    }),
    baseTicket('YGFNXDJRFWDJSYJJYY-647', '登录页验证码偶发失败', '故障', 'fixing', 2, {
      branch: { name: 'feat-hot-V1.2.0-ly', target: 'hotfix-V1.2.0', baseSource: 'origin', worktree: '/tmp/wt-647' },
    }),
    baseTicket('HTSMART-15', '结算单批量下载支持指定日期', '需求', 'submitting', 35, {
      fixes: [{ runId: 'fix-2', startedAt: iso(80), finishedAt: iso(70), changedFiles: ['src/settlement/ExportButton.vue'], diffStat: '1 file changed, 12 insertions(+)', summary: '完成下载', testResult: '通过', status: 'succeeded' }],
      branch: { name: 'feat-V1.2.0-ly', target: 'feature-V1.2.0', baseSource: 'origin', worktree: '/tmp/wt-15' },
    }),
    baseTicket('HTSMART-18', '工作台公告支持置顶', '需求', 'mergeable', 55, {
      mr: { iid: 105, url: 'https://git.htwisdom.cn/x/-/merge_requests/105', sourceBranch: 'feat-V1.2.0-ly', targetBranch: 'feature-V1.2.0', state: 'open', verdict: 'pass', blockingIssues: 0, nonBlockingIssues: 1, rounds: 2 },
    }),
    baseTicket('DEMO-1', '演示工单：导出按钮在窄栏下换行', '缺陷', 'inbox', 300),
    baseTicket('HTSMART-9', '安全巡检：登录设备指纹', '任务', 'blocked', 90, {
      blockedFrom: 'plan_review', blockedReason: 'reject_plan', plan: PLAN,
    }),
    baseTicket('HTSMART-21', '批量导入模板下载失败', '需求', 'analyzing', 57, { plan: null }),
    baseTicket('HTSMART-22', '工作台待办卡片排序错误', '缺陷', 'merged', 400, {
      mr: { iid: 99, url: 'https://git.htwisdom.cn/x/-/merge_requests/99', sourceBranch: 'feat-V1.2.0-ly', targetBranch: 'feature-V1.2.0', state: 'merged', verdict: 'pass', blockingIssues: 0, nonBlockingIssues: 0, rounds: 1 },
    }),
  ].filter((ticket) => ticket.workflow !== 'done'),
};

// ---------------------------------------------------------------------------
// Fake host/globals
// ---------------------------------------------------------------------------

let registeredComponent = null;
const fakeSlots = {
  inject(_name, factory) {
    factory();
  },
  register(_key, component) {
    registeredComponent = component;
    return component;
  },
};

let previewWidth = WIDTH;
const timers = [];
const fakeResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
  }

  observe() {
    timers.push(() => {});
    queueMicrotask(() => {
      this.callback([{ contentRect: { width: previewWidth } }]);
    });
  }

  disconnect() {}
};

function fakeFetch(path) {
  if (path.includes('/api/platform-login/captcha')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        key: 'preview-captcha-key',
        image: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI5NiIgaGVpZ2h0PSIzMiI+PHJlY3Qgd2lkdGg9Ijk2IiBoZWlnaHQ9IjMyIiBmaWxsPSIjZjJmM2Y1Ii8+PHRleHQgeD0iOCIgdT0iMCIgeT0iMjIiIGZvbnQtc2l6ZT0iMTYiIGZpbGw9IiM0ZTU5NjkiPkE3YjM8L3RleHQ+PC9zdmc+',
      }),
    });
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => (path.includes('/api/snapshot') ? snapshot : { ok: true }),
  });
}

const sandbox = {
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  },
  fetch: fakeFetch,
  AbortController,
  AbortSignal,
  ResizeObserver: fakeResizeObserver,
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: (fn) => { timers.push(fn); return 1; },
  clearTimeout: () => {},
  console,
  URL,
  encodeURIComponent,
  decodeURIComponent,
  Math,
  Date,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Set,
  Map,
  Promise,
  Error,
  TypeError,
  RegExp,
};

sandbox.window.__ModuleLoader__ = {
  load: (definition) => {
    sandbox.__plugin = definition.factory((name) => {
      if (name === 'react') return React;
      throw new Error(`unexpected require: ${name}`);
    });
    return sandbox.__plugin;
  },
};

sandbox.globalThis = sandbox;
runInNewContext(SOURCE, sandbox, { filename: 'client.js' });

const ctx = {
  effect(effect) {
    const disposer = effect();
    if (typeof disposer === 'function') sandbox.__cleanup = disposer;
    return disposer;
  },
  sidebarRightTabs: { register: () => () => {} },
  slots: fakeSlots,
};

const plugin = sandbox.__plugin;
if (plugin === null || typeof plugin !== 'object' || typeof plugin.apply !== 'function') {
  console.error('no plugin object exported for preview');
  process.exit(3);
}
plugin.apply(ctx);
if (registeredComponent === null) {
  console.error('client did not register the sidebar tab component');
  process.exit(4);
}

// ---------------------------------------------------------------------------
// Render loop + HTML serialization
// ---------------------------------------------------------------------------

const UNITLESS = new Set([
  'fontWeight', 'lineHeight', 'opacity', 'zIndex', 'flex', 'flexGrow', 'flexShrink', 'WebkitLineClamp',
  'WebkitBoxOrient', 'order', 'content',
]);

function cssName(key) {
  return key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function styleText(style) {
  const parts = [];
  for (const [key, value] of Object.entries(style)) {
    if (value === undefined || value === null || value === '') continue;
    const cssValue = typeof value === 'number' && !UNITLESS.has(key) ? `${value}px` : String(value);
    parts.push(`${cssName(key)}:${cssValue}`);
  }
  return parts.length === 0 ? '' : ` style="${parts.join(';').replace(/"/g, '&quot;')}"`;
}

function escapeText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function serialize(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return escapeText(node);
  if (Array.isArray(node)) return node.map(serialize).join('');
  if (node.kind !== 'element') return '';
  const tag = node.type === 'fragment' ? 'div' : node.type;
  const props = node.props || {};
  const attrs = [];
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'style' || key === 'children' || key === 'ref' || key === 'key') continue;
    if (typeof value === 'function') continue;
    if (key === 'dangerouslySetInnerHTML') continue;
    const name = key === 'className' ? 'class' : key;
    attrs.push(` ${name}="${String(value).replace(/"/g, '&quot;')}"`);
  }
  const selfClosing = tag === 'input' || tag === 'br' || tag === 'hr';
  const children = serialize(node.children);
  return `<${tag}${styleText(props.style || {})}${attrs.join('')}>${children}${selfClosing ? '' : `</${tag}>`}`;
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

async function render() {
  let tree = null;
  for (let pass = 0; pass < 8; pass += 1) {
    renderDirty = false;
    effectQueue.length = 0;
    tree = renderComponent(registeredComponent, { sessionId: 'session-preview' }, 'root');
    const queued = effectQueue.splice(0);
    for (const effect of queued) {
      try {
        effect();
      } catch (error) {
        console.error('effect failed:', error && error.message);
      }
    }
    await flush();
    if (!renderDirty) break;
  }
  return tree;
}

let tree = await render();

const MODE = process.argv[3] === 'detail' ? 'detail' : (process.argv[3] === 'settings' ? 'settings' : null);
const DETAIL = MODE === 'detail';
const DETAIL_TARGET = typeof process.argv[4] === 'string' ? process.argv[4] : null;

function findTicketButton(node) {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findTicketButton(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (node.kind === 'element') {
    const label = node.props && node.props['aria-label'];
    if (typeof label === 'string' && label.startsWith('工单 ')
      && (DETAIL_TARGET === null || label.includes(DETAIL_TARGET))
      && typeof node.props.onClick === 'function') {
      return node;
    }
    for (const child of node.children || []) {
      const found = findTicketButton(child);
      if (found !== null) return found;
    }
  }
  return null;
}

function findButtonByLabel(node, match) {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findButtonByLabel(item, match);
      if (found !== null) return found;
    }
    return null;
  }
  if (node.kind === 'element') {
    const props = node.props || {};
    const label = props['aria-label'];
    const title = props.title;
    if (typeof props.onClick === 'function'
      && ((typeof label === 'string' && label.includes(match))
        || (typeof title === 'string' && title.includes(match)))) {
      return node;
    }
    for (const child of node.children || []) {
      const found = findButtonByLabel(child, match);
      if (found !== null) return found;
    }
  }
  return null;
}

function findButtonByText(node, text) {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findButtonByText(item, text);
      if (found !== null) return found;
    }
    return null;
  }
  if (node.kind !== 'element') return null;
  const children = Array.isArray(node.children) ? node.children : [node.children];
  if (node.type === 'button' && children.some((child) => typeof child === 'string' && child.includes(text))) return node;
  return findButtonByText(node.children, text);
}

if (MODE === 'settings') {
  const button = findButtonByLabel(tree, '设置');
  if (button === null) {
    console.error('preview: no settings button found');
    process.exit(6);
  }
  button.props.onClick();
  await flush();
  tree = await render();
}

if (DETAIL) {
  const button = findTicketButton(tree);
  if (button === null) {
    console.error('preview: no ticket card found to open the detail view');
    process.exit(5);
  }
  button.props.onClick();
  await flush();
  tree = await render();
}
if (DETAIL && process.argv[5] === 'confirm') {
  // Render the inline action Popconfirm: click the first action button with a
  // fake anchor rect so the bubble positions itself like it does in the app.
  const target = findButtonByText(tree, '开始分析')
    ?? findButtonByText(tree, '通过方案')
    ?? findButtonByText(tree, '重新分析')
    ?? findButtonByText(tree, '提交并创建 MR');
  if (target !== null && typeof target.props.onClick === 'function') {
    // PREVIEW_ANCHOR lets a visual check move the fake trigger (e.g. to the
    // viewport bottom, where the bubble must flip above it).
    const anchorRect = (() => {
      try {
        return JSON.parse(process.env.PREVIEW_ANCHOR || '')
      } catch {
        return { left: 40, right: 140, top: 300, bottom: 324, width: 100, height: 24 }
      }
    })();
    target.props.onClick({
      clientX: anchorRect.left + 50,
      clientY: anchorRect.bottom - 12,
      currentTarget: { getBoundingClientRect: () => anchorRect },
    });
    await flush();
    tree = await render();
  } else {
    console.error('preview: no action button found for the confirm bubble');
    process.exit(7);
  }
}

const body = serialize(tree);
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Bug 看板 · 真实渲染预览</title>
<style>
  :root{
    --dsw-alias-label-primary:#1d2129; --dsw-alias-label-secondary:#4e5969; --dsw-alias-label-tertiary:#86909c;
    --dsw-alias-label-primary-inverted:#ffffff;
    --dsw-alias-border-l2:#e5e6eb; --dsw-alias-border-l3:#c9cdd4;
    --dsw-alias-bg-base:#ffffff; --dsw-alias-bg-layer-1:#ffffff; --dsw-alias-bg-layer-2:#f7f8fa;
    --dsw-alias-bg-module-platform:#f2f3f5; --dsw-alias-interactive-bg-active:#eef3ff;
    --dsw-alias-brand-primary:#3b6cf6; --dsw-alias-link:#245bdb; --dsw-alias-button-primary-fill:#3b6cf6;
    --dsw-alias-state-error-primary:#f53f3f; --dsw-alias-state-success-primary:#00b42a;
    --dsw-alias-state-warn-primary:#ff7d00; --dsw-alias-state-warn-label:#d25f00;
    --dsw-alias-state-business-primary:#3b6cf6;
  }
  html,body{margin:0;padding:0;background:#e9ecf2}
  body{display:flex;justify-content:center;align-items:flex-start;padding:24px;font-family:"PingFang SC","Helvetica Neue",Arial,sans-serif}
  .frame{width:${WIDTH}px;height:900px;overflow:hidden;border-radius:14px;border:1px solid #d5d9e2;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 20px 50px rgba(20,30,50,.18);display:flex}
  .frame > *{flex:1;min-width:0;display:flex}
</style></head><body>
<div class="frame">${body}</div>
</body></html>`;

process.stdout.write(html);
