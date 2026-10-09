/**
 * The tab-mention grammar and the context it expands into.
 *
 * The browser half emits one quoted `@"<tab label>"` token per picked tab, and
 * that token is all the user's own message carries — the bubble renders it as a
 * reference. This host half is its only reader: it resolves the tokens it can
 * against the live tab list and appends one context message naming each cited
 * tab's URL and id, so the model still gets the exact tab to work in without
 * the user's message growing a line of machine text. A quoted token that
 * matches no open tab — a file path with spaces, or a tab closed since the
 * pick — expands to nothing.
 * @module @liuyera/dsh-chrome-browser/mentions
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm/message';
import { tabReferenceSource } from "./message-source.js";
/** Most tab mentions expanded from one message. */
export const MAX_TABS_PER_MESSAGE = 5;
/** Quoted mention, at the word boundary the transcript's reference decorator uses. */
const MENTION_RE = /(^|\s)@"([^"\n]+)"/gu;
/** Heading of the injected context message. */
const HEADER = '## Referenced Chrome tabs';
/** Why the model is reading this, and what to do with what it carries. */
const NOTE = "The user's message references tabs open in their Chrome. Pass a tabId straight to the "
    + 'chrome_* tools; a tab title is not an id.';
/** The label one tab is cited by: its title, or its URL for an untitled page. */
function tabLabel(tab) {
    const title = tab.title.trim();
    return title === '' ? tab.url : title;
}
/** Concatenate the text blocks of one message, the way the mention scan sees it. */
function messageText(message) {
    return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
}
/**
 * Collect the tab labels one message text cites.
 * @param text - plain text of one user message.
 * @returns distinct labels in citation order, at most {@link MAX_TABS_PER_MESSAGE}.
 */
export function scanTabMentions(text) {
    const labels = [];
    MENTION_RE.lastIndex = 0;
    let match;
    while ((match = MENTION_RE.exec(text)) !== null) {
        const label = match[2];
        if (label === '' || labels.includes(label))
            continue;
        labels.push(label);
        if (labels.length >= MAX_TABS_PER_MESSAGE)
            break;
    }
    return labels;
}
/**
 * Resolve cited labels against the live tab list.
 * @param labels - labels from {@link scanTabMentions}.
 * @param tabs - the browser's live tabs.
 * @returns one entry per label at least one live tab carries, in citation order.
 */
export function resolveTabMentions(labels, tabs) {
    const cited = [];
    for (const label of labels) {
        const matched = tabs.filter(tab => tabLabel(tab) === label);
        if (matched.length === 0)
            continue;
        cited.push({
            label,
            tabs: matched.map(tab => ({ id: tab.id, title: tabLabel(tab), url: tab.url })),
        });
    }
    return cited;
}
/**
 * Render the context message that carries the cited tabs.
 * @param cited - resolved mentions, in citation order.
 * @returns the message text; empty when nothing resolved.
 */
export function renderTabContext(cited) {
    if (cited.length === 0)
        return '';
    const parts = [HEADER, '', NOTE];
    for (const entry of cited) {
        parts.push('', `### @"${entry.label}"`);
        const first = entry.tabs[0];
        if (entry.tabs.length === 1 && first !== undefined) {
            parts.push(`- tabId: ${first.id} — ${first.url}`);
            continue;
        }
        parts.push(`- ${entry.tabs.length} open tabs share this title: ask the user which one they meant, or list them with chrome_tabs.`);
        for (const tab of entry.tabs)
            parts.push(`  - tabId: ${tab.id} — ${tab.url}`);
    }
    return parts.join('\n');
}
/**
 * Append one tab-context message after every user message citing a live tab.
 * @param messages - the step's admitted messages.
 * @param listTabs - live tab listing; a failure expands nothing.
 * @returns the messages with the context messages spliced in, or undefined when
 *   no message cited a tab this listing can resolve.
 */
export async function expandTabMentions(messages, listTabs) {
    const cited = messages.map(message => (message.source.kind === 'user' ? scanTabMentions(messageText(message)) : []));
    if (!cited.some(labels => labels.length > 0))
        return undefined;
    let tabs;
    try {
        tabs = await listTabs();
    }
    catch (error) {
        // The browser is unreachable: the mentions stay ordinary text and a later
        // message expands against whatever listing answers then.
        console.error('[chrome-browser] tab mention expansion skipped:', error);
        return undefined;
    }
    const expanded = [];
    let injected = false;
    for (const [index, message] of messages.entries()) {
        expanded.push(message);
        const resolved = resolveTabMentions(cited[index] ?? [], tabs);
        const text = renderTabContext(resolved);
        if (text === '')
            continue;
        expanded.push(createUserMessage({
            source: tabReferenceSource(resolved.map(entry => entry.label)),
            content: [{ type: 'text', text }],
        }));
        injected = true;
    }
    return injected ? expanded : undefined;
}
//# sourceMappingURL=mentions.js.map