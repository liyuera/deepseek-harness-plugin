/**
 * UI-facing presentation for the `chrome_*` tools: the pending-call title,
 * the completed card, and the concurrency classification the scheduler reads.
 *
 * This module is UI-only — the model still receives exactly the JSON `render`
 * output, so a card may reformat freely without touching the model contract.
 * Each presenter reads back the JSON this plugin's own `render` produced rather
 * than declaring `output.presentationMeta`: that projection is persisted verbatim
 * on the session log, and re-projecting values we already render losslessly would
 * duplicate page text and evaluated values into every log.
 * @module @liyuera/dsh-chrome-browser/presentation
 */
/** Tab rows one card lists; a long listing stays complete in the model-facing result. */
export const CARD_TAB_LIMIT = 20;
/** One pending call with a semantic title. */
export function call(title, kind) {
    return { card: 'generic', title, kind };
}
/** One completed call with a semantic title and a reformatted body. */
export function result(title, text) {
    return text === undefined
        ? { card: 'generic', title }
        : { card: 'generic', title, content: [{ type: 'text', text }] };
}
/**
 * Parse the JSON object this plugin's `render` serialized.
 * @param outcome - the settled tool result.
 * @returns the parsed object, or undefined for an error, a multi-block result, or non-JSON text.
 */
export function renderedJson(outcome) {
    if (outcome.isError)
        return undefined;
    const only = outcome.content.length === 1 ? outcome.content[0] : undefined;
    if (only === undefined || only.type !== 'text')
        return undefined;
    try {
        const value = JSON.parse(only.text);
        return typeof value === 'object' && value !== null ? value : undefined;
    }
    catch {
        return undefined;
    }
}
/** Read one string field, treating a missing or non-string value as absent. */
function str(source, key) {
    const value = source[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
}
/** Read one finite number field. */
function num(source, key) {
    const value = source[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** One tab id argument as a card names it. */
export function tabLabel(tabId) {
    if (tabId === undefined || tabId === null || tabId === '')
        return '当前标签页';
    if (tabId === 'active')
        return '活动标签页';
    return String(tabId);
}
/** The file name of a path, for a card title. */
function baseName(path) {
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    return cut === -1 ? path : path.slice(cut + 1);
}
/** Shorten one URL for a card title without hiding which site it is. */
function briefUrl(url, maxChars = 60) {
    if (url.length <= maxChars)
        return url;
    return `${url.slice(0, maxChars - 1)}…`;
}
/** A count of things, in the form the card titles use. */
function count(counted, noun) {
    return `${counted} ${noun}`;
}
/** `chrome_tabs` pending call. */
export function tabsCall() {
    return call('列出 Chrome 标签页', 'search');
}
/** `chrome_tabs` completed card: the listing, capped at {@link CARD_TAB_LIMIT} rows. */
export function tabsResult(outcome) {
    const value = renderedJson(outcome);
    if (value === undefined)
        return undefined;
    const rows = Array.isArray(value.tabs) ? value.tabs : [];
    const shown = rows.slice(0, CARD_TAB_LIMIT);
    const lines = shown.map((row) => {
        if (typeof row !== 'object' || row === null)
            return '· (未知标签页)';
        const tab = row;
        const title = str(tab, 'title') ?? '(无标题)';
        const url = str(tab, 'url') ?? '';
        return `${tab.active === true ? '▶' : '·'} ${title}${url === '' ? '' : `\n   ${briefUrl(url, 100)}`}`;
    });
    if (rows.length > shown.length)
        lines.push(`…另有 ${rows.length - shown.length} 个标签页(模型侧结果中包含)`);
    return result(count(rows.length, '个标签页'), lines.join('\n'));
}
/** `chrome_read` pending call. */
export function readCall(args) {
    return call(`读取标签页 ${tabLabel(args.tabId)}`, 'read');
}
/** One listed element, as a card line. */
function elementLine(entry) {
    if (typeof entry !== 'object' || entry === null)
        return '· ?';
    const item = entry;
    const name = str(item, 'name');
    const selector = str(item, 'selector') ?? '?';
    const role = str(item, 'role');
    const flags = [];
    if (item.disabled === true)
        flags.push('禁用');
    if (item.covered === true)
        flags.push('被遮挡');
    if (item.inView === false)
        flags.push('视口外');
    const head = `${name === undefined ? '' : `${name} — `}${selector}`;
    const tail = [role, ...flags].filter(part => part !== undefined && part !== '').join(' · ');
    return `· ${head}${tail === '' ? '' : `  (${tail})`}`;
}
/** `chrome_read` completed card: the page identity plus what the model received. */
export function readResult(outcome) {
    const value = renderedJson(outcome);
    if (value === undefined)
        return undefined;
    const title = str(value, 'title');
    const url = str(value, 'url');
    const heading = title ?? url ?? '已读取页面';
    const facts = [];
    if (url !== undefined)
        facts.push(url);
    if (value.mode === 'interactive') {
        const items = Array.isArray(value.items) ? value.items : [];
        const matched = num(value, 'matched');
        facts.push(matched === undefined ? `${items.length} 个可交互元素` : `${items.length}/${matched} 个可交互元素`);
        return result(heading, [facts.join('\n'), '', ...items.map(elementLine)].join('\n'));
    }
    const chars = num(value, 'textChars');
    if (chars !== undefined) {
        const offset = num(value, 'offset') ?? 0;
        const window = offset === 0 ? '' : `(从 ${offset} 起)`;
        facts.push(value.textTruncated === true ? `${chars} 字符${window},已截断` : `${chars} 字符`);
    }
    const text = str(value, 'text');
    const body = text === undefined ? facts.join('\n') : [facts.join('\n'), '', text].filter(part => part !== '').join('\n');
    return result(heading, body);
}
/** `chrome_navigate` pending call. */
export function navigateCall(args) {
    return call(`导航到 ${briefUrl(args.url)}`, 'fetch');
}
/** `chrome_navigate` completed card. */
export function navigateResult(outcome) {
    const value = renderedJson(outcome);
    if (value === undefined)
        return undefined;
    const url = str(value, 'url') ?? '目标地址';
    return result(`已导航到 ${briefUrl(url)}`, `标签页 ${str(value, 'tabId') ?? '?'}\n${url}`);
}
/** `chrome_open` pending call. */
export function openCall(args) {
    return call(args.url === undefined ? '打开新标签页' : `打开新标签页 ${briefUrl(args.url)}`, 'other');
}
/** `chrome_open` completed card. */
export function openResult(outcome) {
    const value = renderedJson(outcome);
    if (value === undefined)
        return undefined;
    const tabId = str(value, 'tabId') ?? '?';
    const title = str(value, 'title');
    const url = str(value, 'url');
    const lines = [title, url].filter((line) => line !== undefined && line !== '');
    return result(`已打开标签页 ${tabId}`, lines.join('\n'));
}
/** `chrome_screenshot` pending call. */
export function screenshotCall(args) {
    return call(`截图 ${tabLabel(args.tabId)}`, 'read');
}
/** `chrome_screenshot` completed card: the file the model was told to read. */
export function screenshotResult(outcome) {
    const value = renderedJson(outcome);
    if (value === undefined)
        return undefined;
    const path = str(value, 'path');
    if (path === undefined)
        return undefined;
    const bytes = num(value, 'bytes');
    const size = bytes === undefined ? '' : ` · ${Math.max(1, Math.round(bytes / 1024))} KB`;
    // DevTools occupied the debugger, so this is the viewport-only fallback: say
    // so on the card rather than letting the image read as the requested capture.
    const fallback = str(value, 'fallback') === 'visible-tab' ? ' · 可视区域(DevTools 占用)' : '';
    return result(`截图 ${baseName(path)}${size}${fallback}`, path);
}
/** `chrome_click` pending call. */
export function clickCall(args) {
    const scope = args.all === true ? '全部匹配元素' : briefUrl(args.selector, 50);
    return call(`点击 ${scope}`, 'execute');
}
/** `chrome_hover` pending call. */
export function hoverCall(args) {
    return call(`悬停 ${briefUrl(args.selector, 50)}`, 'execute');
}
/** `chrome_hover` completed card. */
export function hoverResult(outcome) {
    const value = renderedJson(outcome);
    if (value === undefined)
        return undefined;
    const hovered = num(value, 'matched') ?? 0;
    const selector = str(value, 'selector') ?? '';
    return result(hovered > 0 ? '已悬停' : '没有可悬停的元素', selector);
}
/** `chrome_wait` pending call. */
export function waitCall(args) {
    const state = args.state === undefined ? '可见' : args.state;
    return call(`等待 ${briefUrl(args.selector, 40)} ${state}`, 'search');
}
/** `chrome_wait` completed card: whether the condition held, never "how it went". */
export function waitResult(outcome) {
    const value = renderedJson(outcome);
    if (value === undefined)
        return undefined;
    const satisfied = value.satisfied === true;
    const selector = str(value, 'selector') ?? '';
    const state = str(value, 'state') ?? '';
    const elapsed = num(value, 'elapsedMs');
    const facts = [`${selector} ${state}`, elapsed === undefined ? '' : `${elapsed} ms`].filter(part => part !== '');
    return result(satisfied ? '条件已满足' : '超时,条件未满足', facts.join('\n'));
}
/** `chrome_press` pending call. */
export function pressCall(args) {
    const target = args.selector === undefined ? '当前焦点' : briefUrl(args.selector, 40);
    return call(`按键 ${args.key} → ${target}`, 'execute');
}
/** `chrome_press` completed card, naming the submit that synthetic keys make necessary. */
export function pressResult(outcome) {
    const value = renderedJson(outcome);
    if (value === undefined)
        return undefined;
    const key = str(value, 'key') ?? '?';
    const selector = str(value, 'selector');
    const title = value.submitted === true ? `已按下 ${key} 并提交表单` : `已按下 ${key}`;
    return result(title, selector ?? '(当前焦点)');
}
/** `chrome_request_help` pending call. */
export function helpCall(args) {
    return call(`请求你帮忙:${briefUrl(args.reason, 50)}`, 'other');
}
/** `chrome_request_help` completed card. */
export function helpResult(outcome) {
    const value = renderedJson(outcome);
    if (value === undefined)
        return undefined;
    const note = str(value, 'note');
    return result(value.completed === true ? '用户已完成,可以继续' : '用户跳过了这一步', note ?? (value.completed === true ? '先重新读一次页面,再决定下一步' : '停止这条路径,不要重试'));
}
/** `chrome_close` pending call. */
export function closeCall(args) {
    return call(`关闭标签页 ${tabLabel(args.tabId)}`, 'execute');
}
/** `chrome_close` completed card. */
export function closeResult(outcome) {
    const value = renderedJson(outcome);
    if (value === undefined)
        return undefined;
    const tabId = str(value, 'tabId') ?? '';
    return result('标签页已关闭', tabLabel(tabId));
}
/** `chrome_select` pending call. */
export function selectCall(args) {
    return call(`选择 ${briefUrl(args.value, 30)} ← ${briefUrl(args.selector, 40)}`, 'execute');
}
/** `chrome_select` completed card. */
export function selectResult(outcome) {
    const value = renderedJson(outcome);
    if (value === undefined)
        return undefined;
    const selected = str(value, 'value') ?? '';
    const selector = str(value, 'selector') ?? '';
    return result(`已选择 ${selected}`, selector);
}
/** `chrome_click` completed card. Surfaces the warnings that explain a click the page may have ignored. */
export function clickResult(outcome) {
    const value = renderedJson(outcome);
    if (value === undefined)
        return undefined;
    const clicked = num(value, 'clicked') ?? 0;
    const matched = num(value, 'matched');
    const selector = str(value, 'selector') ?? '';
    const warnings = Array.isArray(value.warnings)
        ? value.warnings.filter((entry) => typeof entry === 'string' && entry !== '')
        : [];
    const title = matched !== undefined && matched > clicked
        ? `已点击 ${clicked}/${matched} 个元素`
        : `已点击 ${clicked} 个元素`;
    const body = [selector, ...warnings.map(warning => `⚠ ${warning}`)].filter(line => line !== '').join('\n');
    return result(title, body);
}
/** `chrome_type` pending call. Never carries the typed text: it may be a credential. */
export function typeCall(args) {
    return call(`输入 ${args.text.length} 字符到 ${briefUrl(args.selector, 50)}`, 'execute');
}
/** `chrome_type` completed card. The typed text stays out of the card, as in the call view. */
export function typeResult(outcome) {
    const value = renderedJson(outcome);
    if (value === undefined)
        return undefined;
    const selector = str(value, 'selector') ?? '';
    const cleared = value.cleared === true ? '已先清空原内容' : '追加输入';
    return result(`已输入到 ${briefUrl(selector, 50)}`, `${selector}\n${cleared}`);
}
/** `chrome_eval` pending call. */
export function evalCall(args) {
    return { card: 'generic', title: `执行 JS ${tabLabel(args.tabId)}`, kind: 'execute', rawInput: args.expression };
}
/** `chrome_eval` completed card: the serialized value the model received. */
export function evalResult(outcome) {
    const value = renderedJson(outcome);
    if (value === undefined)
        return undefined;
    const rendered = str(value, 'value');
    // A result that came through the debugger protocol says so: it means the
    // page's CSP blocked eval, and that the debugger infobar is on that tab.
    if (value.world === 'debugger') {
        return result('求值结果(调试通道)', `${rendered}\n\n页面 CSP 禁止主世界 eval,表达式经调试通道执行:语义与 CDP 后端一致,但该标签页会出现调试提示条`);
    }
    return result('求值结果', rendered);
}
/** `chrome_webmcp_list` pending call. */
export function webmcpListCall(args) {
    return call(`列出 WebMCP 工具 ${tabLabel(args.tabId)}`, 'search');
}
/** `chrome_webmcp_list` completed card: what the page exposes, or why nothing does. */
export function webmcpListResult(outcome) {
    const value = renderedJson(outcome);
    if (value === undefined)
        return undefined;
    if (value.available !== true)
        return result('该页没有 WebMCP', str(value, 'reason') ?? '');
    const tools = Array.isArray(value.tools) ? value.tools : [];
    if (tools.length === 0)
        return result('该页有 WebMCP,但没有注册工具');
    const lines = tools.map((tool) => {
        const name = str(tool, 'name') ?? '';
        const description = str(tool, 'description') ?? '';
        const annotations = typeof tool.annotations === 'object' && tool.annotations !== null
            ? tool.annotations
            : {};
        const hints = [
            annotations.readOnlyHint === true ? '只读' : '',
            annotations.consequentialHint === true ? '高风险,先确认' : '',
            annotations.untrustedContentHint === true ? '输出不可信' : '',
        ].filter(part => part !== '');
        return `${name}${hints.length === 0 ? '' : ` [${hints.join(' · ')}]`}${description === '' ? '' : ` — ${description}`}`;
    });
    return result(`${tools.length} 个 WebMCP 工具`, lines.join('\n'));
}
/** `chrome_webmcp_call` pending call: the tool name only; arguments may hold user data. */
export function webmcpCallCall(args) {
    return call(`调用 WebMCP 工具 ${args.name}`, 'execute');
}
/** `chrome_webmcp_call` completed card: the tool result, or what the user still has to do. */
export function webmcpCallResult(outcome) {
    const value = renderedJson(outcome);
    if (value === undefined)
        return undefined;
    if (value.pending === true)
        return result('WebMCP 工具等待用户完成', str(value, 'note') ?? '');
    if (value.navigated === true)
        return result('WebMCP 工具触发了页面导航');
    // The tool layer already clipped the result to JSON TEXT; re-stringifying it
    // would render escaped quotes instead of the JSON itself.
    const rendered = str(value, 'result') ?? (value.result === undefined ? '' : JSON.stringify(value.result, null, 2));
    return result('WebMCP 工具执行完成', rendered.length > 4000 ? `${rendered.slice(0, 4000)}…` : rendered);
}
/** `chrome_console` pending call, titled by the lifecycle step it performs. */
export function consoleCall(args) {
    const label = args.action === 'start' ? '开始采集控制台' : args.action === 'stop' ? '停止采集控制台' : '读取控制台';
    return call(`${label} ${tabLabel(args.tabId)}`, 'read');
}
/** `chrome_console` completed card: the lifecycle result, or the entries read. */
export function consoleResult(outcome) {
    const value = renderedJson(outcome);
    if (value === undefined)
        return undefined;
    if (value.capturing === true) {
        const tabs = Array.isArray(value.capturingTabs)
            ? value.capturingTabs.filter((entry) => typeof entry === 'string')
            : [];
        return result(`采集中(标签页 ${str(value, 'tabId') ?? '?'})`, tabs.length <= 1 ? '页面接下来的控制台输出会进入缓冲' : `同时采集 ${tabs.length} 个标签页:${tabs.join('、')}`);
    }
    if (value.capturing === false)
        return result(`已停止采集(标签页 ${str(value, 'tabId') ?? '?'})`, '缓冲已释放');
    const entries = Array.isArray(value.entries) ? value.entries : [];
    const retained = num(value, 'retained');
    const dropped = num(value, 'dropped') ?? 0;
    const title = dropped > 0 ? `${entries.length} 条控制台消息(更早的 ${dropped} 条已淘汰)` : `${entries.length} 条控制台消息`;
    const lines = entries.map((entry) => {
        if (typeof entry !== 'object' || entry === null)
            return '· ?';
        const record = entry;
        const level = str(record, 'level') ?? 'log';
        const text = str(record, 'text') ?? '';
        const source = str(record, 'source');
        return `${level === 'error' ? '✖' : level === 'warning' ? '⚠' : '·'} [${level}] ${text}${source === undefined ? '' : ` (${source})`}`;
    });
    const summary = retained === undefined ? [] : [`缓冲中保留 ${retained} 条`];
    return result(title, [...summary, ...lines].join('\n'));
}
//# sourceMappingURL=presentation.js.map