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
 * @module @liyuera/dsh-chrome-browser/mentions
 */
import { type UserMessage } from '@deepseek-ai/dsh-llm/message';
/** Most tab mentions expanded from one message. */
export declare const MAX_TABS_PER_MESSAGE = 5;
/** One live tab, as the context message lists it. */
export interface TabSummary {
    readonly id: string;
    readonly title: string;
    readonly url: string;
}
/** One cited tab label and the open tabs carrying it. */
export interface CitedTab {
    /** The label inside the mention, as the user's text carries it. */
    readonly label: string;
    /** Open tabs under that label, in listing order. */
    readonly tabs: readonly TabSummary[];
}
/**
 * Collect the tab labels one message text cites.
 * @param text - plain text of one user message.
 * @returns distinct labels in citation order, at most {@link MAX_TABS_PER_MESSAGE}.
 */
export declare function scanTabMentions(text: string): string[];
/**
 * Resolve cited labels against the live tab list.
 * @param labels - labels from {@link scanTabMentions}.
 * @param tabs - the browser's live tabs.
 * @returns one entry per label at least one live tab carries, in citation order.
 */
export declare function resolveTabMentions(labels: readonly string[], tabs: readonly TabSummary[]): CitedTab[];
/**
 * Render the context message that carries the cited tabs.
 * @param cited - resolved mentions, in citation order.
 * @returns the message text; empty when nothing resolved.
 */
export declare function renderTabContext(cited: readonly CitedTab[]): string;
/**
 * Append one tab-context message after every user message citing a live tab.
 * @param messages - the step's admitted messages.
 * @param listTabs - live tab listing; a failure expands nothing.
 * @returns the messages with the context messages spliced in, or undefined when
 *   no message cited a tab this listing can resolve.
 */
export declare function expandTabMentions(messages: readonly UserMessage[], listTabs: () => Promise<readonly TabSummary[]>): Promise<UserMessage[] | undefined>;
//# sourceMappingURL=mentions.d.ts.map