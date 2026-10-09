/**
 * `@` trigger source listing the user's live Chrome tabs.
 *
 * A row shows the tab title with its URL right after it: the title is the
 * candidate label, the URL rides the menu's right-aligned description seat.
 * A pick inserts a reference chip and binds nothing: the chip carries the
 * mention token the transcript projects as a reference, and the host expands
 * that mention into a context message naming the tab's URL and id, so the
 * user's message stays a reference while the model still gets the exact tab.
 * One pick covers the one message it lands in; the next message starts from a
 * clean draft.
 *
 * The menu's own group title is owned by ui-input-trigger's dictionary, so
 * this source declares no group title and carries a section heading on every
 * row instead (the saved-prompt source does the same).
 * @module @liuyera/dsh-chrome-browser/client/tab-source
 */
/** Source name: the `@` roster key and the reference owner a chip routes back through. */
export const CHROME_TAB_SOURCE_NAME = 'chrome-browser';
/**
 * Menu position among `@` sources. Lower sorts higher, the saved-prompt source
 * declares -100, and the file/session source declares none (0) — so -200 is
 * what puts live tabs above every other `@` group.
 */
export const CHROME_TAB_SOURCE_ORDER = -200;
/** Rows rendered for one query, at most. */
export const CANDIDATE_LIMIT = 50;
/** Section heading every row carries, in place of a group title. */
export const TAB_SECTION = '浏览器标签页';
/** Row title: the tab title, or its URL for an untitled page. */
function rowLabel(tab) {
    const title = tab.title.trim();
    return title === '' ? tab.url : title;
}
/**
 * Mention token one chip carries. The transcript projects `@name` and
 * `@"name with spaces"` tokens in sent text into reference chips, so the token
 * — not a self-made line — is what keeps the sent message a reference; the
 * host expands it into the URLs and ids the model works from. Quotes and line
 * breaks are dropped: a `"` would end the quoted token early.
 */
function tabMention(tab) {
    const label = rowLabel(tab).replace(/["\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim();
    return `@"${label === '' ? tab.id : label}"`;
}
/**
 * Build the `@` source over the live tab list.
 * @param deps - tab listing and favicon rendering, injected for tests.
 * @returns the source registered on `ctx.inputTriggers`.
 */
export function createChromeTabSource(deps) {
    // The tabs the user is looking at, by id: a pick resolves the tab it saw
    // rather than re-listing and risking a different page, and the chip's id
    // resolves back to that exact tab at submit time — titles repeat across
    // tabs, ids do not.
    const rows = new Map();
    // The mention each picked tab inserted, kept past the listing so a tab closed
    // before the send still serializes to the reference the user saw.
    const picked = new Map();
    // Session identity plays no part: a pick binds nothing to the conversation.
    const candidates = async (_session, req) => {
        const tabs = await deps.listTabs(req.signal);
        rows.clear();
        for (const tab of tabs)
            rows.set(tab.id, tab);
        const query = req.query.trim().toLowerCase();
        const matched = query === ''
            ? tabs
            : tabs.filter(tab => `${tab.title}\n${tab.url}`.toLowerCase().includes(query));
        return matched.slice(0, CANDIDATE_LIMIT).map((tab) => {
            const label = rowLabel(tab);
            return {
                name: label,
                label,
                // An untitled page already shows its URL as the row title; repeating it
                // in the description seat would print the same string twice.
                ...tab.url === '' || tab.title.trim() === '' ? {} : { description: tab.url },
                section: TAB_SECTION,
                value: tab.id,
                icon: deps.iconFor(tab.favicon),
            };
        });
    };
    /**
     * The mention one chip carries: what its pick inserted, the live listing's
     * own form, or the bare id once neither is left.
     */
    const mentionFor = (id) => {
        const inserted = picked.get(id);
        if (inserted !== undefined)
            return inserted;
        const tab = rows.get(id);
        return tab === undefined ? `@"${id}"` : tabMention(tab);
    };
    const codec = {
        clipboardText: mentionFor,
        // The user's message carries the reference alone; the host turns the
        // mention into a context message with the URL and the tab id.
        serialize: ref => Promise.resolve(mentionFor(ref)),
    };
    return {
        trigger: '@',
        name: CHROME_TAB_SOURCE_NAME,
        order: CHROME_TAB_SOURCE_ORDER,
        showGroupTitle: false,
        candidates,
        onPick: (pick) => {
            const tab = pick.candidate.value === undefined ? undefined : rows.get(pick.candidate.value);
            // A row that is gone (menu left open across a browser restart) inserts
            // nothing rather than a reference to a tab nobody can resolve.
            if (tab === undefined)
                return undefined;
            const mention = tabMention(tab);
            picked.set(tab.id, mention);
            return {
                insert: {
                    source: CHROME_TAB_SOURCE_NAME,
                    // The pick payload IS the identity: the mention below is display, and
                    // two tabs may carry the same title.
                    ref: tab.id,
                    label: rowLabel(tab),
                    clipboardText: mention,
                },
            };
        },
        codec,
    };
}
//# sourceMappingURL=tab-source.js.map