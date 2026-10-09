/**
 * Message-source identity of the tab-context message this plugin injects.
 *
 * `MessageSourceMap` is the harness's merge point for message producers, so the
 * injected context never claims to be a user or model message — the pre-step
 * scan skips it, and a turn cannot expand the same mention twice. The type-only
 * import is required: a merge declared without importing its target does not
 * resolve against the package graph.
 * @module @liuyera/dsh-chrome-browser/message-source
 */
/**
 * Build the source of one injected context message.
 * @param labels - mention labels the message expanded, in citation order.
 * @returns the source field of the message.
 */
export function tabReferenceSource(labels) {
    return { kind: 'chrome-browser', form: 'reference', version: 1, labels };
}
//# sourceMappingURL=message-source.js.map