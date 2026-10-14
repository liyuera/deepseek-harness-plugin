window.__ModuleLoader__.load({
	id: "@liyuera/dsh-chrome-browser",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		react = __toESM(react, 1);
		//#region lib/client/chrome-icon.js
		/** Embedded copy of the user-provided Chrome icon (Google Chrome.png at the plugin root, 512px). */
		const CHROME_ICON_SRC = "data:image/png;base64,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";
		//#endregion
		//#region lib/client/activity.js
		/**
		* Browser-side activity probe: `GET /chrome-browser/activity` behind a short
		* cache.
		*
		* The strip polls this while a session view is open, so a dropped request or an
		* unreachable host answers "not active" rather than throwing into React: an
		* indicator that flickers an error is worse than one that stays hidden.
		* @module @liyuera/dsh-chrome-browser/client/activity
		*/
		/** One snapshot per this window, however many callers ask. */
		const CACHE_MS$1 = 900;
		const IDLE = { active: false };
		let cachedAt$1 = 0;
		let cached$1 = IDLE;
		let inflight$1 = null;
		async function fetchActivity(sessionId) {
			try {
				const query = sessionId === "" ? "" : `?sessionId=${encodeURIComponent(sessionId)}`;
				const body = await (await fetch(`/chrome-browser/activity${query}`)).json();
				if (body.ok !== true) throw new Error(body.error ?? "activity probe failed");
				cached$1 = {
					active: body.active === true,
					...body.tool === void 0 ? {} : { tool: body.tool },
					...body.tabId === void 0 ? {} : { tabId: body.tabId },
					...body.startedAt === void 0 ? {} : { startedAt: body.startedAt },
					...body.lastTool === void 0 ? {} : { lastTool: body.lastTool },
					...body.lastAt === void 0 ? {} : { lastAt: body.lastAt }
				};
			} catch {
				cached$1 = IDLE;
			}
			cachedAt$1 = Date.now();
			return cached$1;
		}
		/**
		* Read the plugin's current activity for one session.
		* @param sessionId - the session the strip belongs to.
		* @returns the snapshot, or an inactive one while the host is unreachable.
		*/
		async function readChromeActivity(sessionId) {
			if (Date.now() - cachedAt$1 < CACHE_MS$1) return cached$1;
			inflight$1 ??= fetchActivity(sessionId).finally(() => {
				inflight$1 = null;
			});
			return inflight$1;
		}
		//#endregion
		//#region lib/client/BrowserActivity.js
		/**
		* Browser activity strip: the one place the user can see, without reading the
		* transcript, that the agent is driving their browser right now.
		*
		* It renders **nothing** while the plugin is idle — a permanent badge would be
		* noise, and the per-call cards already carry the detail. When a call is in
		* flight it names the tool and the tab, so a user who looks up mid-task can
		* tell what is happening and on which page.
		* @module @liyuera/dsh-chrome-browser/client/activity-strip
		*/
		/** Poll interval while the strip is mounted; the host caches for slightly less. */
		const POLL_MS = 1e3;
		/**
		* Human labels for the running call. A tool with no label shows its wire name,
		* so adding a tool never leaves the strip blank.
		*/
		const TOOL_LABELS = {
			chrome_tabs: "列出标签页",
			chrome_read: "读取页面",
			chrome_navigate: "导航",
			chrome_open: "打开标签页",
			chrome_screenshot: "截图",
			chrome_click: "点击",
			chrome_hover: "悬停",
			chrome_type: "输入",
			chrome_press: "按键",
			chrome_select: "选择",
			chrome_eval: "执行 JS",
			chrome_wait: "等待元素",
			chrome_console: "读取控制台",
			chrome_request_help: "等待你操作"
		};
		const STYLE_ID = "dsh-chrome-browser-activity";
		const STRIP_CSS = `
.cb-activity {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px;
  padding: 3px 8px;
  width: fit-content;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-specific-tip);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
}
.cb-activity img { width: 14px; height: 14px; }
.cb-activity .cb-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: cb-pulse 1.2s ease-in-out infinite;
}
@keyframes cb-pulse { 0%, 100% { opacity: .3 } 50% { opacity: 1 } }
@media (prefers-reduced-motion: reduce) { .cb-activity .cb-dot { animation: none } }
.cb-activity .cb-activity-tab { opacity: .7 }
`;
		function ensureStyles() {
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = STRIP_CSS;
			document.head.appendChild(style);
		}
		/**
		* Render the strip while one of this plugin's tools is running.
		* @param props - the dock entry's session identity.
		* @returns the strip, or null while nothing is running.
		*/
		function BrowserActivity({ sessionId }) {
			const [state, setState] = (0, react.useState)({ active: false });
			(0, react.useEffect)(() => {
				ensureStyles();
				let live = true;
				const tick = async () => {
					const next = await readChromeActivity(sessionId);
					if (live) setState(next);
				};
				tick();
				const timer = setInterval(() => {
					tick();
				}, POLL_MS);
				return () => {
					live = false;
					clearInterval(timer);
				};
			}, [sessionId]);
			if (!state.active) return null;
			const tool = state.tool ?? "";
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "cb-activity",
				role: "status",
				"aria-live": "polite",
				children: [
					(0, react_jsx_runtime.jsx)("span", {
						className: "cb-dot",
						"aria-hidden": "true"
					}),
					(0, react_jsx_runtime.jsx)("img", {
						src: CHROME_ICON_SRC,
						alt: "",
						"aria-hidden": "true"
					}),
					(0, react_jsx_runtime.jsx)("span", { children: TOOL_LABELS[tool] ?? tool }),
					state.tabId === void 0 ? null : (0, react_jsx_runtime.jsxs)("span", {
						className: "cb-activity-tab",
						children: ["标签页 ", state.tabId]
					})
				]
			});
		}
		//#endregion
		//#region lib/client/tab-catalog.js
		/**
		* Browser-side tab catalog: `POST /chrome-browser/tabs` behind a short cache.
		*
		* The `@` source asks for candidates on every keystroke, so the cache is what
		* keeps one typed word from becoming one host round-trip per character; a
		* failed listing is held for the same window, so an unreachable browser costs
		* one logged request instead of one per keystroke.
		* @module @liyuera/dsh-chrome-browser/client/tab-catalog
		*/
		/** How long one listing (successful or failed) stays fresh. */
		const CACHE_MS = 2e3;
		/** Timestamp of the stored listing. */
		let cachedAt = 0;
		/** Last listing; empty while the browser is unreachable. */
		let cached = [];
		/** One request at a time, shared by concurrent callers. */
		let inflight = null;
		/** Fetch one listing, store it, and answer the empty list on any failure. */
		async function fetchTabs() {
			try {
				const body = await (await fetch("/chrome-browser/tabs", { method: "POST" })).json();
				if (body.ok !== true) throw new Error(body.error ?? "listing tabs failed");
				cached = body.tabs ?? [];
			} catch (error) {
				cached = [];
				console.error("[chrome-browser] listing tabs failed:", error);
			}
			cachedAt = Date.now();
			return cached;
		}
		/**
		* List the live Chrome tabs.
		* @param signal - superseded when the query changes or the menu closes; a
		*   request already in flight still settles the shared cache.
		* @returns the tabs, or an empty list while the browser is unreachable.
		*/
		async function listChromeTabs(signal) {
			if (signal.aborted) return cached;
			if (Date.now() - cachedAt < CACHE_MS) return cached;
			inflight ??= fetchTabs().finally(() => {
				inflight = null;
			});
			return inflight;
		}
		//#endregion
		//#region lib/client/tab-source.js
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
		* @module @liyuera/dsh-chrome-browser/client/tab-source
		*/
		/** Source name: the `@` roster key and the reference owner a chip routes back through. */
		const CHROME_TAB_SOURCE_NAME = "chrome-browser";
		/**
		* Menu position among `@` sources. Lower sorts higher, the saved-prompt source
		* declares -100, and the file/session source declares none (0) — so -200 is
		* what puts live tabs above every other `@` group.
		*/
		const CHROME_TAB_SOURCE_ORDER = -200;
		/** Section heading every row carries, in place of a group title. */
		const TAB_SECTION = "浏览器标签页";
		/** Row title: the tab title, or its URL for an untitled page. */
		function rowLabel(tab) {
			const title = tab.title.trim();
			return title === "" ? tab.url : title;
		}
		/**
		* Mention token one chip carries. The transcript projects `@name` and
		* `@"name with spaces"` tokens in sent text into reference chips, so the token
		* — not a self-made line — is what keeps the sent message a reference; the
		* host expands it into the URLs and ids the model works from. Quotes and line
		* breaks are dropped: a `"` would end the quoted token early.
		*/
		function tabMention(tab) {
			const label = rowLabel(tab).replace(/["\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim();
			return `@"${label === "" ? tab.id : label}"`;
		}
		/**
		* Build the `@` source over the live tab list.
		* @param deps - tab listing and favicon rendering, injected for tests.
		* @returns the source registered on `ctx.inputTriggers`.
		*/
		function createChromeTabSource(deps) {
			const rows = /* @__PURE__ */ new Map();
			const picked = /* @__PURE__ */ new Map();
			const candidates = async (_session, req) => {
				const tabs = await deps.listTabs(req.signal);
				rows.clear();
				for (const tab of tabs) rows.set(tab.id, tab);
				const query = req.query.trim().toLowerCase();
				return (query === "" ? tabs : tabs.filter((tab) => `${tab.title}\n${tab.url}`.toLowerCase().includes(query))).slice(0, 50).map((tab) => {
					const label = rowLabel(tab);
					return {
						name: label,
						label,
						...tab.url === "" || tab.title.trim() === "" ? {} : { description: tab.url },
						section: TAB_SECTION,
						value: tab.id,
						icon: deps.iconFor(tab.favicon)
					};
				});
			};
			/**
			* The mention one chip carries: what its pick inserted, the live listing's
			* own form, or the bare id once neither is left.
			*/
			const mentionFor = (id) => {
				const inserted = picked.get(id);
				if (inserted !== void 0) return inserted;
				const tab = rows.get(id);
				return tab === void 0 ? `@"${id}"` : tabMention(tab);
			};
			return {
				trigger: "@",
				name: CHROME_TAB_SOURCE_NAME,
				order: CHROME_TAB_SOURCE_ORDER,
				showGroupTitle: false,
				candidates,
				onPick: (pick) => {
					const tab = pick.candidate.value === void 0 ? void 0 : rows.get(pick.candidate.value);
					if (tab === void 0) return void 0;
					const mention = tabMention(tab);
					picked.set(tab.id, mention);
					return { insert: {
						source: CHROME_TAB_SOURCE_NAME,
						ref: tab.id,
						label: rowLabel(tab),
						clipboardText: mention
					} };
				},
				codec: {
					clipboardText: mentionFor,
					serialize: (ref) => Promise.resolve(mentionFor(ref))
				}
			};
		}
		//#endregion
		//#region lib/client/tab-icon.js
		/**
		* Favicon renderer for the `@` tab rows.
		*
		* The candidate icon seat takes a component, not an image URL, so each
		* favicon needs one. Components are memoized by URL: a fresh component
		* identity per candidate would remount every row's image on each menu render
		* (every keystroke) and reload it.
		* @module @liyuera/dsh-chrome-browser/client/tab-icon
		*/
		/** One favicon at menu-icon size; a URL that cannot load hides its own image. */
		function FaviconImage({ favicon, size }) {
			if (favicon === "") return react.default.createElement("img", {
				src: CHROME_ICON_SRC,
				width: size,
				height: size,
				alt: "",
				"aria-hidden": true,
				style: {
					borderRadius: 3,
					objectFit: "contain"
				}
			});
			return react.default.createElement("img", {
				src: favicon,
				width: size,
				height: size,
				alt: "",
				referrerPolicy: "no-referrer",
				onError: (event) => {
					event.currentTarget.style.display = "none";
				},
				style: {
					borderRadius: 3,
					objectFit: "contain"
				}
			});
		}
		/** Memoized per favicon URL, so one URL keeps one component identity. */
		const icons = /* @__PURE__ */ new Map();
		/**
		* Icon component for one favicon.
		* @param favicon - favicon URL, or '' when Chrome reported none.
		* @returns the component handed to `InputTriggerCandidate.icon`.
		*/
		function tabIcon(favicon) {
			const cached = icons.get(favicon);
			if (cached !== void 0) return cached;
			const Icon = ({ size = 16 }) => react.default.createElement(FaviconImage, {
				favicon,
				size
			});
			icons.set(favicon, Icon);
			return Icon;
		}
		//#endregion
		//#region lib/client/index.js
		/**
		* chrome-browser plugin, browser half.
		*
		* The composer dock used to carry a full-width tab selector above the input
		* card. That row, its component and the session-binding routes behind it are
		* gone: the live tab list lives in the `@` menu, where a pick inserts a
		* reference chip and binds nothing. The dock carries the activity strip now.
		* @module @liyuera/dsh-chrome-browser/client
		*/
		/** Required services for the slot contribution and the `@` source. */
		const inject = ["slots", "inputTriggers"];
		/**
		* Client plugin body: register the activity strip and the `@` tab source.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "chrome-browser-activity",
				order: 4
			}, BrowserActivity));
			ctx.effect(() => ctx.inputTriggers.registerSource(createChromeTabSource({
				listTabs: listChromeTabs,
				iconFor: tabIcon
			})), "chrome-browser: @ tab source");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map