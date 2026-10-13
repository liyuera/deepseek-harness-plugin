/**
 * Package-owned invariant companion for `@liyuera/dsh-chrome-browser`.
 * @module @liyuera/dsh-chrome-browser/invariant
 */
const PACKAGE_NAME = '@liyuera/dsh-chrome-browser';
/** Cordis companion plugin name. */
export const name = 'chrome-browser-invariant';
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants'];
/**
 * No runtime invariant: the plugin registers model tools only and owns no
 * cross-plugin event stream or shared data registry. Tool registration
 * disposal is proved by the HMR-safety register/dispose contract of
 * `ctx.tools.register` exercised in the tool specs.
 */
const install = () => { };
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
/* jscpd:ignore-end */
//# sourceMappingURL=invariant.js.map