/**
 * Favicon renderer for the `@` tab rows.
 *
 * The candidate icon seat takes a component, not an image URL, so each
 * favicon needs one. Components are memoized by URL: a fresh component
 * identity per candidate would remount every row's image on each menu render
 * (every keystroke) and reload it.
 * @module @liyuera/dsh-chrome-browser/client/tab-icon
 */
import React from 'react';
import { CHROME_ICON_SRC } from "./chrome-icon.js";
/** One favicon at menu-icon size; a URL that cannot load hides its own image. */
function FaviconImage({ favicon, size }) {
    if (favicon === '') {
        return React.createElement('img', {
            src: CHROME_ICON_SRC,
            width: size,
            height: size,
            alt: '',
            'aria-hidden': true,
            style: { borderRadius: 3, objectFit: 'contain' },
        });
    }
    return React.createElement('img', {
        src: favicon,
        width: size,
        height: size,
        alt: '',
        referrerPolicy: 'no-referrer',
        // A dead favicon URL hides its own image; the row keeps its title and URL.
        onError: (event) => { event.currentTarget.style.display = 'none'; },
        style: { borderRadius: 3, objectFit: 'contain' },
    });
}
/** Memoized per favicon URL, so one URL keeps one component identity. */
const icons = new Map();
/**
 * Icon component for one favicon.
 * @param favicon - favicon URL, or '' when Chrome reported none.
 * @returns the component handed to `InputTriggerCandidate.icon`.
 */
export function tabIcon(favicon) {
    const cached = icons.get(favicon);
    if (cached !== undefined)
        return cached;
    const Icon = ({ size = 16 }) => React.createElement(FaviconImage, { favicon, size });
    icons.set(favicon, Icon);
    return Icon;
}
//# sourceMappingURL=tab-icon.js.map