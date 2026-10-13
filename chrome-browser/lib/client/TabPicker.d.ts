/**
 * Browser tab selector for the composer dock (the full-width row above the
 * input card). Multi-select; the platform select-style list (same surface /
 * text / hover tokens as the settings agent-preset picker) is rendered with
 * a fixed height and internal scroll, anchored to its trigger (opens
 * upward). The input box is never touched and no message content is
 * modified: the whole selection is bound host-side per session and reported
 * to the model through chrome_tabs (`session.tabs`); the tool default is the
 * first selected tab.
 * @module @liyuera/dsh-chrome-browser/client/tab-picker
 */
import React from 'react';
/** One live tab as the host describes it. */
export interface TabInfo {
    id: string;
    title: string;
    url: string;
    active: boolean;
    favicon: string;
}
/** Composer-dock props: session identity (selection rides the host binding). */
export interface TabPickerProps {
    sessionId: string;
}
/**
 * The dock tab selector: chips for the selected tabs (multi), a fixed-height
 * scrollable list anchored to the card. Selection is bound host-side only.
 * @param props - session identity.
 */
export declare function TabPicker(props: TabPickerProps): React.DetailedReactHTMLElement<{
    ref: React.MutableRefObject<HTMLDivElement | null>;
    style: {
        boxSizing: "border-box";
        flex: string;
        overflow: "hidden";
        margin: string;
        width: string;
        maxWidth: string;
        border: string;
        borderRadius: number;
        background: string;
        display: "flex";
        alignItems: "center";
        gap: number;
        flexWrap: "wrap";
        minWidth: number;
        fontSize: number;
        padding: string;
        cursor: "pointer";
    };
    onClick: () => void;
    title: string;
}, HTMLDivElement>;
//# sourceMappingURL=TabPicker.d.ts.map