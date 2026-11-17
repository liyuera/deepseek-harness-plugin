window.__ModuleLoader__.load({
  id: "@liyuera/dsh-mr-loop",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var ReactDOM = null;
    try { ReactDOM = require("react-dom"); } catch (error) { ReactDOM = null; }
    var h = React.createElement;

    // ---------------------------------------------------------------- styles
    var CSS = [
      // 表面层次用主题 token 现算：DSH 真机上 bg-layer-1/2 都是纯白（浅色），
      // 直接拿 layer-2 当「嵌套底色」会白对白看不见，所以用前景色低透明度混出灰底。
      ".mrl-chip,.mrl-chip-btn,.mrl-panel{--mrl-surface:var(--dsw-alias-bg-layer-1);--mrl-fill:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,transparent);--mrl-fill-2:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);--mrl-line:var(--dsw-alias-border-l2);--mrl-line-soft:var(--dsw-alias-border-l1);--mrl-on-accent:var(--dsw-alias-bg-base);--mrl-accent:var(--dsw-alias-state-business-primary,var(--dsw-alias-label-primary))}",
      ".mrl-chip{position:relative;display:inline-flex;align-items:center;gap:6px;margin:0 2px;font-size:11.5px;line-height:1}",
      // 窄屏/被裁剪时的紧凑形态：只有一个 MR 图标按钮 + 状态点。
      ".mrl-chip-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid var(--mrl-line);background:transparent;border-radius:7px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".mrl-chip-btn:hover{background:var(--mrl-fill);color:var(--dsw-alias-label-primary)}",
      ".mrl-chip-btn:focus-visible{outline:2px solid var(--mrl-accent);outline-offset:-2px}",
      ".mrl-chip-badge{position:absolute;top:-3px;right:-3px;width:8px;height:8px;border-radius:50%;border:2px solid var(--dsw-alias-bg-base);background:var(--dsw-alias-state-warn-primary)}",
      ".mrl-chip-badge[data-tone=ok]{background:var(--dsw-alias-state-success-primary)}",
      ".mrl-chip-tag{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 5px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);font-size:11.5px;line-height:1;white-space:nowrap;cursor:pointer}",
      ".mrl-chip-tag:hover{background:var(--mrl-fill)}",
      ".mrl-chip-tag.warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent)}",
      ".mrl-chip-tag.err{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}",
      ".mrl-chip-tag.ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}",
      ".mrl-chip-tag.brand{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--mrl-on-accent);padding:0 9px;font-weight:550}",
      ".mrl-chip-tag:focus-visible{outline:2px solid var(--mrl-accent);outline-offset:-2px}",
      ".mrl-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}",
      ".mrl-dot.ok{background:var(--dsw-alias-state-success-primary)}",
      ".mrl-dot.warn{background:var(--dsw-alias-state-warn-primary)}",
      ".mrl-dot.err{background:var(--dsw-alias-state-error-primary)}",
      ".mrl-dialog{position:fixed;top:64px;right:24px;z-index:1000;display:flex;align-items:flex-start;justify-content:flex-end;pointer-events:auto}",
      ".mrl-panel{width:420px;max-width:calc(100vw - 48px);min-height:300px;max-height:calc(100vh - 88px);display:flex;flex-direction:column;background:var(--mrl-surface);border:1px solid var(--mrl-line);border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.06);overflow:hidden;pointer-events:auto;font-size:12.5px;line-height:1.55}",
      ".mrl-hd{padding:13px 14px 0;border-bottom:1px solid var(--mrl-line);flex:none}",
      ".mrl-hd-row{display:flex;align-items:center;gap:8px}",
      ".mrl-title{font-size:14px;font-weight:650;margin:0;color:var(--dsw-alias-label-primary)}",
      ".mrl-count{font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--mrl-fill);border-radius:20px;padding:0 7px;line-height:18px}",
      ".mrl-sp{flex:1}",
      ".mrl-icon{width:24px;height:24px;border:1px solid var(--mrl-line);background:transparent;border-radius:7px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer}",
      ".mrl-icon:hover{background:var(--mrl-fill)}",
      ".mrl-seg{display:inline-flex;background:var(--mrl-fill);border-radius:8px;padding:2px;margin:9px 0 11px}",
      ".mrl-seg>button{border:0;background:transparent;padding:3px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);border-radius:6px;cursor:pointer}",
      ".mrl-seg>button[data-on]{background:var(--mrl-surface);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}",
      ".mrl-body{padding:11px;display:flex;flex-direction:column;gap:10px;overflow:auto;flex:1}",
      ".mrl-mr{border:1px solid var(--mrl-line);border-radius:12px;background:var(--mrl-surface);overflow:hidden;flex:none}",
      ".mrl-mr-h{padding:11px 12px 8px;display:flex;gap:8px;align-items:flex-start}",
      ".mrl-mr-id{font-size:13px;font-weight:650;letter-spacing:.02em;display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary)}",
      ".mrl-mr-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:290px}",
      ".mrl-tags{margin-left:auto;display:flex;gap:5px;flex-shrink:0}",
      ".mrl-tag{font-size:11px;padding:0 7px;line-height:18px;border-radius:20px;border:1px solid transparent;color:var(--dsw-alias-label-secondary);background:var(--mrl-fill);white-space:nowrap}",
      ".mrl-tag.brand{color:var(--mrl-accent);background:color-mix(in srgb,var(--mrl-accent) 12%,transparent)}",
      ".mrl-tag.ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 13%,transparent)}",
      ".mrl-tag.err{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 13%,transparent)}",
      ".mrl-gates{display:flex;gap:5px;flex-wrap:wrap;padding:0 12px 9px}",
      ".mrl-gate{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary);background:var(--mrl-fill);border-radius:7px;padding:2px 8px;white-space:nowrap}",
      ".mrl-merge{display:flex;align-items:center;gap:7px;margin:0 12px 10px;padding:7px 10px;border-radius:9px;font-size:12px;color:var(--dsw-alias-label-primary);border:1px solid var(--mrl-line-soft);background:var(--mrl-fill)}",
      ".mrl-merge[data-kind=bad]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 28%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}",
      ".mrl-merge[data-kind=ok]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 28%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}",
      ".mrl-merge .txt{flex:1;min-width:0}",
      ".mrl-merge-icon{flex:none;font-size:12px;line-height:1}",
      ".mrl-link{color:var(--mrl-accent);font-size:11.5px;font-weight:550;white-space:nowrap;cursor:pointer;background:none;border:0;padding:0}",
      ".mrl-link:hover{text-decoration:underline;text-underline-offset:2px}",
      ".mrl-sec{display:flex;align-items:center;gap:6px;padding:8px 12px 6px;font-size:11px;color:var(--dsw-alias-label-secondary);border-top:1px solid var(--mrl-line-soft)}",
      ".mrl-sec b{font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".mrl-sec-warn{color:var(--dsw-alias-state-warn-primary)}",
      ".mrl-merge-sub{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:2px;line-height:1.5}",
      ".mrl-rounds{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:7px 12px;border-top:1px solid var(--mrl-line-soft);font-size:10.5px;color:var(--dsw-alias-label-secondary)}",
      ".mrl-rounds .lbl{color:var(--dsw-alias-label-tertiary);flex:none;padding-right:1px}",
      ".mrl-round{display:inline-flex;align-items:center;gap:4px;padding:0 7px;line-height:18px;border-radius:20px;border:0;background:var(--mrl-fill);color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:10.5px;white-space:nowrap;cursor:pointer}",
      ".mrl-round:hover{background:var(--mrl-fill-2)}",
      ".mrl-round[data-wait]{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 13%,transparent)}",
      ".mrl-round[data-sel]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent);color:var(--dsw-alias-label-primary)}",
      ".mrl-issue{padding:9px 12px;border-bottom:1px solid var(--mrl-line-soft)}",
      ".mrl-issue:last-child{border-bottom:0}",
      ".mrl-issue[data-open]{background:var(--mrl-fill)}",
      ".mrl-i-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".mrl-fid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".mrl-lv{font-size:10.5px;line-height:16px;padding:0 6px;border-radius:5px;background:var(--mrl-fill);color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".mrl-lv[data-lv=高]{color:var(--dsw-alias-state-error-primary)}",
      ".mrl-lv[data-lv=中]{color:var(--dsw-alias-state-warn-primary)}",
      ".mrl-lv[data-lv=低]{color:var(--mrl-accent)}",
      ".mrl-st{font-size:10.5px;line-height:17px;padding:0 7px;border-radius:20px;white-space:nowrap;margin-left:auto}",
      ".mrl-st[data-st=open]{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}",
      ".mrl-st[data-st=pending]{color:var(--mrl-accent);background:color-mix(in srgb,var(--mrl-accent) 12%,transparent)}",
      ".mrl-st[data-st=fixed]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}",
      ".mrl-st[data-st=waived]{color:var(--dsw-alias-label-tertiary);background:var(--mrl-fill)}",
      ".mrl-chev{font-size:10.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:0;padding:0;margin-left:6px}",
      ".mrl-file{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".mrl-prob{font-size:12px;margin-top:3px;color:var(--dsw-alias-label-primary)}",
      ".mrl-instr{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:5px;align-items:baseline;flex-wrap:wrap}",
      ".mrl-code{font-size:10.5px;background:var(--mrl-fill-2);border-radius:4px;padding:1px 5px;max-width:250px;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:bottom;white-space:nowrap}",
      ".mrl-detail{margin-top:8px;padding:9px 10px;border-radius:8px;background:var(--mrl-fill);display:flex;flex-direction:column;gap:8px}",
      ".mrl-d-row{display:grid;grid-template-columns:54px 1fr;gap:8px;font-size:11.5px;line-height:1.65}",
      ".mrl-d-k{color:var(--dsw-alias-label-secondary);font-size:10.5px;padding-top:1px}",
      ".mrl-d-v{color:var(--dsw-alias-label-secondary);min-width:0;white-space:pre-wrap;word-break:break-word}",
      ".mrl-quote{border-left:2px solid var(--mrl-line);padding-left:8px;white-space:pre-wrap;word-break:break-word}",
      ".mrl-meta2{display:block;color:var(--dsw-alias-label-tertiary);font-size:10.5px;margin-top:2px}",
      ".mrl-snippet{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;line-height:1.7;background:var(--mrl-surface);border:1px solid var(--mrl-line-soft);border-radius:6px;padding:6px 8px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}",
      ".mrl-f{padding:8px 12px;border-top:1px solid var(--mrl-line);display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:11px;background:var(--mrl-fill)}",
      ".mrl-btn{font-size:11.5px;padding:3px 9px;border-radius:7px;border:1px solid var(--mrl-line);background:var(--mrl-surface);color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}",
      ".mrl-btn:hover:enabled{background:var(--mrl-fill)}",
      ".mrl-btn:disabled{opacity:.45;cursor:default}",
      ".mrl-empty{padding:26px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".mrl-err{margin:0 0 2px;padding:9px 11px;border-radius:9px;font-size:11.5px;color:var(--dsw-alias-label-primary);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent);display:flex;align-items:center;gap:8px}",
      ".mrl-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
    ].join("\n");

    function injectStyle() {
      if (typeof document === "undefined") return function () {};
      var tagId = "@liyuera/dsh-mr-loop/panel.css";
      // 已有同插件样式（另一个实例 / 未 dispose 的旧 effect）：不重复插，也不归本次清理。
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return function () {};
      var tag = document.createElement("style");
      tag.dataset.plugin = "@liyuera/dsh-mr-loop";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return function () {
        if (tag.parentNode && typeof tag.parentNode.removeChild === "function") tag.parentNode.removeChild(tag);
        else if (typeof tag.remove === "function") tag.remove();
      };
    }

    // ---------------------------------------------------------------- store
    var listeners = new Set();
    var store = {
      data: null,
      loading: false,
      error: null,
      open: false,
      scope: "all",
      sessionId: null,
      expanded: {},
      // 轮次条点击：projectPath#iid → 看第几轮（缺省看「最近一次落地的评审」）。
      roundSel: {},
    };
    var subscribers = 0;

    function setStore(patch) {
      store = Object.assign({}, store, patch);
      listeners.forEach(function (listener) { listener(); });
    }

    function load() {
      setStore({ loading: true, error: null });
      fetch("/mr-loop/ui/state", { headers: { accept: "application/json" } })
        .then(function (response) {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.json();
        })
        .then(function (data) {
          setStore({ data: data, loading: false, error: null });
        })
        .catch(function (error) {
          setStore({ loading: false, error: error && error.message ? error.message : String(error) });
        });
    }

    function useStore() {
      var force = React.useState(0)[1];
      React.useEffect(function () {
        subscribers += 1;
        var listener = function () { force(function (n) { return n + 1; }); };
        listeners.add(listener);
        if (subscribers === 1) load();
        return function () {
          subscribers -= 1;
          listeners.delete(listener);
        };
      }, []);
      return store;
    }

    // ---------------------------------------------------------------- data helpers
    var MR_STATE_LABEL = { opened: "进行中", merged: "已合并", closed: "已关闭", locked: "锁定" };

    function toneOfGate(value) {
      if (value === "pass") return "ok";
      if (value === "block") return "err";
      if (value === "unknown") return "warn";
      return "";
    }

    function verdictLabel(review) {
      if (review === null || review === undefined) return "未出";
      if (review.verdict === "pass") return "可直接合并";
      if (review.verdict === "changes") return "需要修改";
      return "未解析";
    }

    function sensitiveLabel(value) {
      if (value === "pass") return "通过";
      if (value === "block") return "阻止合并";
      if (value === "unknown") return "未解析（不拦合并）";
      return "无本轮结论";
    }

    function mandatoryLabel(value) {
      if (value === "pass") return "通过";
      if (value === "block") return "阻止合并";
      return "建议性";
    }

    function problemStatusLabel(problem) {
      if (problem.status === "fixed") return { text: "✓ 已修", tone: "fixed" };
      if (problem.status === "waived") {
        var kind = problem.instruction && problem.instruction.kind;
        if (kind === "skip") return { text: "◌ 不适用", tone: "waived" };
        if (kind === "wontfix") return { text: "◌ 不修", tone: "waived" };
        return { text: "◌ 已豁免", tone: "waived" };
      }
      // 当前轮评审还没出时，上一轮的「未处理」不能断言现在还没修，只能算待复验。
      if (problem.unverified === true) return { text: "◔ 待复验", tone: "pending" };
      return { text: "● 未处理", tone: "open" };
    }

    /** 相对时间：<1h 显示「N 分钟前」，否则显示日期时间。 */
    function relativeTime(value) {
      var time = Date.parse(value === null || value === undefined ? "" : String(value));
      if (!Number.isFinite(time)) return "";
      var diff = Date.now() - time;
      if (diff >= 0 && diff < 60 * 60 * 1000) {
        var minutes = Math.max(1, Math.round(diff / 60000));
        return minutes + " 分钟前";
      }
      return String(value).replace("T", " ").slice(0, 16);
    }

    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).catch(function () {});
          return;
        }
      } catch (error) { /* fall through */ }
      try {
        var area = document.createElement("textarea");
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      } catch (error) { /* ignore */ }
    }

    // ---------------------------------------------------------------- 响应式 chip
    /** 量不到会话头容器时退回窗口宽度断点（宽 < 该值就收成图标）。 */
    var COMPACT_MAX_WIDTH = 1000;

    function viewportCompact(win) {
      var width = win !== null && win !== undefined && typeof win.innerWidth === "number" ? win.innerWidth : 0;
      return width > 0 && width < COMPACT_MAX_WIDTH;
    }

    function computedStyleOf(element) {
      var win = typeof window === "undefined" ? null : window;
      if (win === null || typeof win.getComputedStyle !== "function" || element === null || element === undefined) return null;
      try { return win.getComputedStyle(element); } catch (error) { return null; }
    }

    /**
     * 量宽度用的容器：优先「会裁剪子元素的祖先」（会话头动作区就是 overflow 裁剪 + 渐隐），
     * 退一步找最近的 flex 行（即便没设 overflow，也能从行宽判断够不够）。
     * 都找不到返回 null，交给窗口宽度兜底。
     */
    function findChipContainer(node) {
      if (node === null || node === undefined || node.parentElement === undefined || node.parentElement === null) return null;
      var flexFallback = null;
      var current = node.parentElement;
      while (current !== null && current !== undefined) {
        var style = computedStyleOf(current);
        if (style !== null && style.overflowX !== "visible") return current;
        if (flexFallback === null && style !== null && (style.display === "flex" || style.display === "inline-flex")) {
          flexFallback = current;
        }
        if (current === document.body || current === document.documentElement) break;
        current = current.parentElement;
      }
      return flexFallback;
    }

    /** 容器里已排版的子元素总宽（不含 gap 之外的额外空间）。 */
    function childrenWidthOf(box) {
      if (box === null || box === undefined || box.children === null || box.children === undefined) return 0;
      var total = 0;
      for (var index = 0; index < box.children.length; index += 1) {
        var child = box.children[index];
        if (child === null || child === undefined || typeof child.getBoundingClientRect !== "function") continue;
        var rect = child.getBoundingClientRect();
        if (rect !== null && rect !== undefined && typeof rect.width === "number") total += rect.width;
      }
      return total;
    }

    /**
     * 这一排「内容实际需要多宽」：溢出时用 scrollWidth（含 gap 与内边距，最准）；
     * 没溢出时只累加子元素宽度 + 左右内边距，绝不能把容器宽度本身当成内容宽度。
     */
    function contentWidthOf(box) {
      var style = computedStyleOf(box);
      var paddingX = 0;
      if (style !== null) {
        paddingX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      }
      var content = childrenWidthOf(box) + paddingX;
      if (typeof box.scrollWidth === "number" && typeof box.clientWidth === "number"
        && box.scrollWidth > box.clientWidth && box.scrollWidth > content) {
        content = box.scrollWidth;
      }
      return content;
    }

    /**
     * 纯函数：按会话头可用宽度决定 chip 形态（不碰 DOM，便于单测）。
     * needed = 「把 chip 换成完整形态后这一排需要的总宽度」，两种形态算出来相同，
     * 所以判定不会在 compact / full 之间来回抖。
     */
    function chipShrinkMode(metrics) {
      var m = metrics || {};
      var containerWidth = Number(m.containerWidth);
      var contentWidth = Number(m.contentWidth);
      var chipWidth = Number(m.chipWidth);
      var fullWidth = Number(m.fullWidth);
      var slack = Number(m.slack);
      if (!Number.isFinite(containerWidth) || containerWidth <= 0) return "full";
      if (!Number.isFinite(slack) || slack < 0) slack = 8;
      if (!Number.isFinite(contentWidth) || contentWidth <= 0) contentWidth = containerWidth;
      if (!Number.isFinite(chipWidth) || chipWidth < 0) chipWidth = 0;
      if (!Number.isFinite(fullWidth) || fullWidth <= 0) fullWidth = chipWidth;
      var needed = contentWidth - chipWidth + fullWidth;
      return needed + slack <= containerWidth ? "full" : "compact";
    }

    /**
     * chip 形态：优先按会话头真实可用宽度判断（末尾被裁剪就收成图标，保证一直在）；
     * 量不到容器时退回窗口宽度断点。返回 { compact, ref }。
     */
    function useChipCompact() {
      var state = React.useState(false);
      var compact = state[0] === true;
      var setCompact = state[1];
      var nodeRef = React.useRef(null);
      var fullRef = React.useRef(0);
      var modeRef = React.useRef("full");
      var observerRef = React.useRef(null);
      var observedRef = React.useRef(null);

      var measure = function () {
        var win = typeof window === "undefined" ? null : window;
        var current = nodeRef.current;
        var box = current === null ? null : findChipContainer(current);
        var mode = null;
        if (current !== null && box !== null && typeof box.clientWidth === "number" && box.clientWidth > 0
          && typeof current.getBoundingClientRect === "function" && typeof box.getBoundingClientRect === "function") {
          var width = (current.getBoundingClientRect() || {}).width || 0;
          if (modeRef.current === "full" && width > 0) fullRef.current = width;
          mode = chipShrinkMode({
            containerWidth: box.clientWidth,
            contentWidth: contentWidthOf(box),
            chipWidth: width,
            fullWidth: fullRef.current || width,
          });
        } else {
          mode = viewportCompact(win) ? "compact" : "full";
        }
        if (mode !== modeRef.current) {
          modeRef.current = mode;
          setCompact(mode === "compact");
        }
      };

      // 每次渲染后都测一次：chip 在数据到达前返回 null（没有 DOM），effect 只跑一次会漏挂观察器。
      React.useEffect(function () {
        var win = typeof window === "undefined" ? null : window;
        var current = nodeRef.current;
        var box = current === null ? null : findChipContainer(current);
        if (box !== observedRef.current) {
          if (observerRef.current !== null && typeof observerRef.current.disconnect === "function") observerRef.current.disconnect();
          observerRef.current = null;
          observedRef.current = box;
          if (box !== null && win !== null && typeof win.ResizeObserver === "function") {
            try {
              var observer = new win.ResizeObserver(function () { measure(); });
              observer.observe(box);
              observerRef.current = observer;
            } catch (error) { observerRef.current = null; }
          }
        }
        measure();
      });

      React.useEffect(function () {
        var win = typeof window === "undefined" ? null : window;
        var onResize = function () { measure(); };
        if (win !== null && typeof win.addEventListener === "function") win.addEventListener("resize", onResize);
        // 首次测量时行宽可能还没排完版（量到 0 会误判成 full），补两次重测。
        var retries = [];
        if (win !== null && typeof win.setTimeout === "function") {
          retries.push(win.setTimeout(function () { measure(); }, 0));
          retries.push(win.setTimeout(function () { measure(); }, 150));
        }
        return function () {
          if (win !== null && typeof win.removeEventListener === "function") win.removeEventListener("resize", onResize);
          if (win !== null && typeof win.clearTimeout === "function") {
            retries.forEach(function (id) { win.clearTimeout(id); });
          }
          if (observerRef.current !== null && typeof observerRef.current.disconnect === "function") observerRef.current.disconnect();
          observerRef.current = null;
          observedRef.current = null;
        };
      }, []);

      // 首帧（还没挂载节点）没有测量机会：直接按窗口宽度兜底，窄屏不先闪一版完整 chip。
      var pending = nodeRef.current === null && viewportCompact(typeof window === "undefined" ? null : window);
      return {
        compact: compact || pending,
        ref: function (node) { nodeRef.current = node; },
      };
    }

    function Chip(props) {
      var state = useStore();
      var layout = useChipCompact();
      var incomingSession = props && props.sessionId !== undefined && props.sessionId !== null
        ? String(props.sessionId)
        : null;
      React.useEffect(function () {
        if (incomingSession !== null && incomingSession !== store.sessionId) {
          setStore({ sessionId: incomingSession });
        }
      }, [incomingSession]);
      var data = state.data;
      if (data === null || !Array.isArray(data.mrs) || data.mrs.length === 0) return null;
      // 宿主给了本会话 id 就立刻按它过滤（不等 effect 回写 store，避免首帧闪一次「全会话」计数）。
      var currentSessionId = incomingSession !== null ? incomingSession : state.sessionId;
      var inSession = function (mr) {
        return currentSessionId !== null && mr.session !== undefined && mr.session !== null && String(mr.session.id) === currentSessionId;
      };
      // M4：chip 只统计当前会话（会话未知才退回全部），避免别的会话的问题冒充「本会话待处理」。
      var scoped = currentSessionId === null
        ? data.mrs
        : data.mrs.filter(inSession);
      var pending = currentSessionId === null
        ? (data.counts && typeof data.counts.pending === "number" ? data.counts.pending : 0)
        : scoped.reduce(function (sum, mr) { return sum + (typeof mr.pending === "number" ? mr.pending : 0); }, 0);
      var initialScope = currentSessionId !== null && scoped.length > 0 ? "session" : "all";
      var openPanel = function () { setStore({ open: true, expanded: {}, scope: initialScope }); };

      // 紧凑形态：会话头宽度不够时只留一个 MR 图标按钮（点击照旧打开看板）。
      if (layout.compact) {
        var hasMergeable = scoped.some(function (mr) {
          return mr.merge !== null && mr.merge !== undefined && mr.merge.mergeable === true;
        });
        var badgeTone = pending > 0 ? "warn" : (hasMergeable ? "ok" : "");
        var tips = ["MR 看板"];
        scoped.slice(0, 2).forEach(function (mr) { tips.push("!" + mr.iid + " 第 " + (mr.round || 0) + " 轮"); });
        if (scoped.length > 2) tips.push("+" + (scoped.length - 2));
        if (pending > 0) tips.push(pending + " 待处理");
        var tipsText = tips.join(" · ");
        return h("button", {
          className: "mrl-chip-btn",
          type: "button",
          ref: layout.ref,
          title: tipsText,
          "aria-label": tipsText,
          onClick: openPanel,
        },
        h("svg", {
          viewBox: "0 0 16 16",
          width: 14,
          height: 14,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
        },
        h("circle", { cx: 4.5, cy: 3.5, r: 1.6 }),
        h("circle", { cx: 4.5, cy: 12.5, r: 1.6 }),
        h("circle", { cx: 11.5, cy: 8, r: 1.6 }),
        h("path", { d: "M4.5 5.1v5.8" }),
        h("path", { d: "M4.5 7h3.4a2.7 2.7 0 0 1 2.7 1" })),
        badgeTone === "" ? null : h("span", { className: "mrl-chip-badge", "data-tone": badgeTone }));
      }

      var shown = scoped.slice(0, 2);
      var tags = shown.map(function (mr, index) {
        var label = "!" + mr.iid;
        var tone = index === 0 ? "brand" : (mr.merge && mr.merge.mergeable === true ? "ok" : (mr.pending > 0 ? "warn" : ""));
        return h("button", {
          key: "mr-" + mr.iid,
          className: "mrl-chip-tag " + tone,
          type: "button",
          title: mr.sourceBranch + " → " + mr.targetBranch,
          onClick: openPanel,
        },
        h("span", { className: "mrl-dot " + tone }),
        h("span", null, label + " · 第 " + (mr.round || 0) + " 轮"));
      });
      var more = scoped.length > shown.length
        ? h("span", { className: "mrl-tag" }, "+" + (scoped.length - shown.length))
        : null;
      var pendingTag = pending > 0
        ? h("span", { className: "mrl-tag err" }, pending + " 待处理")
        : null;
      return h("span", { className: "mrl-chip", ref: layout.ref }, tags, more, pendingTag,
        h("button", {
          className: "mrl-chip-tag brand",
          type: "button",
          onClick: openPanel,
        }, "看板"));
    }

    // ---------------------------------------------------------------- problem row
    function ProblemRow(props) {
      var problem = props.problem;
      var state = useStore();
      var key = String(problem.fid);
      var open = state.expanded[key] === true;
      var status = problemStatusLabel(problem);
      var level = problem.level || "—";
      var instruction = problem.instruction;
      var detail = null;
      if (open) {
        var rows = [];
        if (problem.suggestion) {
          rows.push(h("div", { className: "mrl-d-row", key: "suggestion" },
            h("span", { className: "mrl-d-k" }, "建议"),
            h("span", { className: "mrl-d-v" }, problem.suggestion)));
        }
        if (problem.snippet) {
          rows.push(h("div", { className: "mrl-d-row", key: "snippet" },
            h("span", { className: "mrl-d-k" }, "代码"),
            h("span", { className: "mrl-d-v" }, h("code", { className: "mrl-snippet" }, problem.snippet))));
        }
        if (problem.comment && problem.comment.body) {
          var metaParts = [];
          if (problem.comment.author) metaParts.push(problem.comment.author);
          if (problem.comment.createdAt) metaParts.push(String(problem.comment.createdAt).replace("T", " ").slice(0, 16));
          metaParts.push("评论 #" + problem.comment.noteId);
          if (problem.instruction) {
            var kindLabel = problem.instruction.kind === "skip" ? "不适用" : (problem.instruction.kind === "wontfix" ? "不修" : "已豁免");
            metaParts.push("★ " + kindLabel + "该问题");
          }
          rows.push(h("div", { className: "mrl-d-row", key: "comment" },
            h("span", { className: "mrl-d-k" }, "评论原文"),
            h("span", { className: "mrl-d-v mrl-quote" },
              problem.comment.body,
              h("span", { className: "mrl-meta2" }, metaParts.join(" · ")))));
        }
        if (rows.length > 0) detail = h("div", { className: "mrl-detail" }, rows);
      }
      return h("div", { className: "mrl-issue", "data-open": open ? "1" : undefined },
        h("div", { className: "mrl-i-top" },
          h("span", { className: "mrl-fid mono" }, key),
          h("span", { className: "mrl-lv", "data-lv": level }, level + (problem.type ? " · " + problem.type : "")),
          h("span", { className: "mrl-st", "data-st": status.tone }, status.text),
          h("button", {
            className: "mrl-chev",
            type: "button",
            onClick: function () {
              var next = Object.assign({}, store.expanded);
              if (next[key] === true) delete next[key]; else next[key] = true;
              setStore({ expanded: next });
            },
          }, open ? "收起 ▴" : "展开 ▾")),
        h("div", { className: "mrl-file", title: [problem.file, problem.line].filter(Boolean).join(":") },
          [problem.file, problem.line].filter(function (part) { return part !== undefined && part !== null; }).join(":")),
        h("div", { className: "mrl-prob" }, problem.problem || "（无描述）"),
        instruction && instruction.reason
          ? h("div", { className: "mrl-instr" },
              h("span", null, "#" + instruction.kind),
              h("span", null, "reason="),
              h("span", { className: "mrl-code", title: instruction.reason }, instruction.reason),
              instruction.noteId ? h("span", null, "· 评论 #" + instruction.noteId) : null)
          : null,
        detail);
    }

    // ---------------------------------------------------------------- MR card
    function MrCard(props) {
      var mr = props.mr;
      var state = useStore();
      var problems = Array.isArray(mr.problems) ? mr.problems : [];
      var pending = mr.pending || 0;
      var merge = mr.merge;
      // 已结束（merged / closed）的 MR 不再显示「差 N 项」：合并完成反而报「差 1 项：MR 状态是 merged」
      // 自相矛盾，也误导用户以为还要做什么。
      var mergeTerminal = merge !== null && typeof merge.terminal === "string" ? merge.terminal : null;
      var mergeKind = merge === null
        ? "none"
        : (mergeTerminal === "merged" || merge.mergeable === true ? "ok" : mergeTerminal === "closed" ? "none" : "bad");
      var mergeIcon = merge === null
        ? "—"
        : (mergeTerminal === "merged" || merge.mergeable === true ? "✅" : mergeTerminal === "closed" ? "—" : "⛔");
      var mergeText = merge === null
        // 插件重载后绑定会被自动恢复，但 MR 快照要等第一次 tick 才拉回来：这期间不能说「未在跟踪」。
        ? (mr.live === true ? "刚恢复监视，正在拉取 MR 状态…" : "历史账本（未在跟踪）")
        : mergeTerminal === "merged"
          ? "已合并（sha " + String(mr.sha || "").slice(0, 8) + "）"
          : mergeTerminal === "closed"
            ? "MR 已关闭（未合并）"
            : (merge.mergeable === true
                ? "可合"
                : "差 " + (merge.missing ? merge.missing.length : 0) + " 项：" + (merge.missing || []).join("；"));
      var pipeline = merge && merge.pipeline
        ? "流水线 #" + merge.pipeline.id + (merge.pipeline.status === "success" ? " ✓" : " " + merge.pipeline.status)
        : null;
      var gates = mr.gates || {};
      var review = mr.review;
      var rounds = Array.isArray(mr.rounds) ? mr.rounds : [];
      // 当前轮评审还没出时，problems 来自上一轮：面板要标清是哪一轮，别把旧结论当本轮。
      var shownRound = mr.problemsRound || null;
      var fallback = shownRound !== null && shownRound.current === false;
      // head_pipeline 还停在上一笔提交：这笔 push 没触发流水线，评审不会自己冒出来。
      var pipelineStale = merge !== null && merge.pipeline !== null && merge.pipeline !== undefined &&
        typeof merge.pipeline.sha === "string" && merge.pipeline.sha !== "" &&
        typeof mr.sha === "string" && mr.sha !== "" && merge.pipeline.sha !== mr.sha;
      var openMr = function () { if (mr.webUrl) window.open(mr.webUrl, "_blank", "noopener,noreferrer"); };
      var removeEscaped = function () { /* hooks not used here */ };
      void removeEscaped;
      var copyDraft = function () {
        if (openProblem === undefined) return;
        copyText("#ai-waive " + openProblem.fid + " reason=");
      };

      var statusTag = mr.state === "merged"
        ? h("span", { className: "mrl-tag", key: "state" }, "已合并")
        : mr.state === "closed"
          ? h("span", { className: "mrl-tag", key: "state" }, "已关闭")
          : merge === null
            ? null
            : (merge.mergeable === true
                ? h("span", { className: "mrl-tag ok", key: "state" }, "可合")
                : mergeTerminal !== null
                  ? null
                  : h("span", { className: "mrl-tag err", key: "state" }, "差 " + (merge.missing ? merge.missing.length : 0) + " 项"));
      var tags = [
        h("span", { className: "mrl-tag brand", key: "round" }, "第 " + (mr.round || 0) + " 轮"),
        statusTag,
      ];

      // 默认看「最近一次落地的评审」；用户点轮次条可以翻看任意一轮（历史轮的问题正文随 payload 下发）。
      var roundKey = String(mr.projectPath || "") + "#" + String(mr.iid || 0);
      var picked = state.roundSel !== null && state.roundSel !== undefined && Number.isSafeInteger(state.roundSel[roundKey])
        ? state.roundSel[roundKey]
        : null;
      var pickedRound = null;
      if (picked !== null) {
        pickedRound = rounds.filter(function (item) { return item.n === picked; })[0] || null;
      }
      // browsing = 正在看一轮「不是默认那一轮」的历史轮：段落头要说明并给回退入口。
      var browsing = pickedRound !== null && (shownRound === null || pickedRound.n !== shownRound.n);
      var shownN = browsing ? pickedRound.n : (shownRound === null ? null : shownRound.n);
      var shownProblems = browsing
        ? (Array.isArray(pickedRound.problems) ? pickedRound.problems : [])
        : problems;
      // 复制指令只对默认视图开放：翻历史轮时翻到的 FID 可能早就修好了，不能拿来发豁免；
      // MR 已结束（merged / closed）时也禁用：评审问题已成历史。
      var openProblem = browsing || mergeTerminal !== null
        ? undefined
        : problems.filter(function (p) { return p.status === "open"; })[0];
      var pickRound = function (n) {
        var next = Object.assign({}, state.roundSel);
        if (n === null) delete next[roundKey];
        else next[roundKey] = n;
        setStore({ roundSel: next });
      };

      // 问题段落头：写清「这是第几轮的问题」；回落时标注第 N 轮评审未出，翻历史轮时给「回到最新」。
      var issuesHead = shownN === null
        ? null
        : h("div", { className: "mrl-sec" },
            h("b", null, "第 " + shownN + " 轮问题"),
            h("span", null, browsing && (pickedRound.verdict === null || pickedRound.verdict === undefined)
              ? "· 等待评审"
              : "· " + shownProblems.length + " 条"),
            h("span", { className: "mrl-sp" }),
            browsing
              ? h("button", {
                  className: "mrl-link",
                  type: "button",
                  onClick: function () { pickRound(null); },
                }, shownRound === null ? "回到最新" : "回到第 " + shownRound.n + " 轮")
              : fallback
                ? h("span", { className: "mrl-sec-warn" }, "第 " + (mr.round || 0) + " 轮评审未出")
                : null);
      var issues = shownProblems.length > 0
        ? h("div", { className: "mrl-issues" },
            shownProblems.map(function (problem) {
              return h(ProblemRow, { key: String(problem.fid), problem: problem });
            }))
        : null;
      var historyHead = issuesHead !== null || issues !== null
        ? h("div", null, issuesHead, issues)
        : null;

      // 轮次条：一眼看到每轮的结论与条数；点一轮就看那一轮的问题（默认看最近一次落地的评审）。
      var roundStrip = null;
      if (rounds.length > 1) {
        var shown = rounds.slice(-8);
        var chips = [];
        if (rounds.length > shown.length) {
          chips.push(h("span", { className: "mrl-round", key: "more", title: "更早的 " + (rounds.length - shown.length) + " 轮已省略" },
            "+" + (rounds.length - shown.length)));
        }
        shown.forEach(function (item) {
          var waiting = item.verdict === null || item.verdict === undefined;
          var selected = shownN !== null && shownN === item.n;
          var label = waiting ? "等待评审" : (item.verdict === "pass" ? "通过" : item.verdict === "changes" ? "需修改" : "未解析");
          var tip = "第 " + item.n + " 轮 · " + label;
          if (!waiting) tip += " · " + (item.total || 0) + " 条";
          if (item.fixed > 0) tip += "，已修 " + item.fixed;
          if (item.at) tip += " · " + String(item.at).replace("T", " ").slice(0, 16);
          chips.push(h("button", {
            className: "mrl-round",
            key: "r" + item.n,
            type: "button",
            title: tip + " · 点击查看这一轮的问题",
            "data-sel": selected ? "1" : undefined,
            "data-wait": waiting ? "1" : undefined,
            onClick: function () { pickRound(item.n); },
          },
            "第" + item.n + "轮",
            waiting
              ? null
              : h("i", { className: "mrl-dot " + (item.verdict === "pass" ? "ok" : item.verdict === "changes" ? "err" : "warn") }),
            waiting ? null : String(item.total || 0)));
        });
        roundStrip = h("div", { className: "mrl-rounds" }, h("span", { className: "lbl" }, "轮次"), chips);
      }

      return h("div", { className: "mrl-mr" },
        h("div", { className: "mrl-mr-h" },
          h("div", { style: { minWidth: 0 } },
            h("div", { className: "mrl-mr-id" },
              "!" + mr.iid,
              h("span", {
                className: "mrl-tag",
                title: mr.session && mr.session.title ? mr.session.title : undefined,
              }, mr.live === true ? "本会话" : "历史账本")),
            h("div", { className: "mrl-mr-sub", title: mr.sourceBranch + " → " + mr.targetBranch },
              (mr.sourceBranch || "?") + " → " + (mr.targetBranch || "?"))),
          h("div", { className: "mrl-tags" }, tags)),
        h("div", { className: "mrl-gates" },
          h("span", { className: "mrl-gate" },
            h("i", { className: "mrl-dot " + (review && review.verdict === "pass" ? "ok" : review && review.verdict === "changes" ? "err" : "warn") }),
            "评审 · " + verdictLabel(review),
            review && typeof review.newThisRound === "number" && review.newThisRound > 0
              ? h("span", null, "（新增 " + review.newThisRound + "）")
              : null),
          h("span", { className: "mrl-gate" },
            h("i", { className: "mrl-dot " + toneOfGate(gates.sensitive) }),
            "敏感 · " + sensitiveLabel(gates.sensitive)),
          h("span", { className: "mrl-gate" },
            h("i", { className: "mrl-dot " + toneOfGate(gates.mandatory) }),
            "必过 · " + mandatoryLabel(gates.mandatory)),
          pipeline
            ? h("span", { className: "mrl-gate" },
                h("i", { className: "mrl-dot " + (merge.pipeline.status === "success" ? "ok" : "warn") }),
                pipeline)
            : null),
        h("div", { className: "mrl-merge", "data-kind": mergeKind === "none" ? undefined : mergeKind },
          h("span", { className: "mrl-merge-icon" }, mergeIcon),
          h("span", { className: "txt" },
            mergeText,
            // 只看 missing 文字会以为「评审解析失败」；其实是这笔提交根本没跑流水线。
            pipelineStale && review === null
              ? h("div", { className: "mrl-merge-sub" },
                  "流水线 #" + merge.pipeline.id + " 还停在 " + String(merge.pipeline.sha).slice(0, 8) +
                  "，这笔提交没有流水线")
              : null),
          h("button", { className: "mrl-link", type: "button", onClick: openMr }, "打开 MR ↗")),
        historyHead,
        roundStrip,
        h("div", { className: "mrl-f" },
          h("span", { className: "mrl-mono" }, "sha " + String(mr.sha || "").slice(0, 8)),
          mr.updatedAt ? h("span", null, "· " + relativeTime(mr.updatedAt)) : null,
          h("span", { className: "mrl-sp" }),
          h("button", {
            className: "mrl-btn",
            type: "button",
            disabled: openProblem === undefined,
            title: openProblem === undefined ? "没有待处理问题" : "复制 #ai-waive " + openProblem.fid + " reason=",
            onClick: copyDraft,
          }, "复制指令"),
          h("button", { className: "mrl-btn", type: "button", onClick: openMr }, "详情")));
    }

    // ---------------------------------------------------------------- drawer
    function Drawer() {
      var state = useStore();
      React.useEffect(function () {
        if (state.open !== true) return undefined;
        var onKey = function (event) {
          if (event.key === "Escape") setStore({ open: false });
        };
        window.addEventListener("keydown", onKey);
        return function () { window.removeEventListener("keydown", onKey); };
      }, [state.open]);
      if (state.open !== true) return null;
      var data = state.data;
      var mrs = data && Array.isArray(data.mrs) ? data.mrs : [];
      var pending = data && data.counts ? data.counts.pending : 0;

      var sessionId = state.sessionId;
      var inSession = function (mr) {
        return sessionId !== null && mr.session !== undefined && mr.session !== null && String(mr.session.id) === sessionId;
      };
      var filters = [
        { id: "session", label: "本会话 " + mrs.filter(inSession).length },
        { id: "all", label: "全部 " + mrs.length },
        { id: "merged", label: "已合并 " + mrs.filter(function (mr) { return mr.state === "merged"; }).length },
      ];
      var visible = mrs.filter(function (mr) {
        if (state.scope === "session") return inSession(mr);
        if (state.scope === "merged") return mr.state === "merged";
        return true;
      });

      var body;
      if (state.loading && mrs.length === 0) {
        body = h("div", { className: "mrl-empty" }, "加载中…");
      } else if (mrs.length === 0) {
        body = h("div", { className: "mrl-empty" },
          h("div", { style: { fontSize: 16, marginBottom: 6 } }, "◨"),
          "还没有跟踪的 MR",
          h("div", { className: "mrl-mono", style: { fontSize: 11, marginTop: 4 } }, "/mr <GitLab MR 链接>"));
      } else if (visible.length === 0) {
        body = h("div", { className: "mrl-empty" },
          state.scope === "session"
            ? "本会话还没有跟踪中的 MR（历史账本在「全部」里）"
            : "这个分类里还没有 MR",
          state.scope === "session" && mrs.length > 0
            ? h("div", { style: { marginTop: 10 } },
                h("button", {
                  className: "mrl-btn",
                  type: "button",
                  onClick: function () { setStore({ scope: "all" }); },
                }, "查看全部 " + mrs.length + " 个 MR"))
            : null);
      } else {
        body = visible.map(function (mr) { return h(MrCard, { key: mr.projectPath + "#" + mr.iid, mr: mr }); });
      }

      var panel = h("div", {
        className: "mrl-panel",
      },
      h("div", { className: "mrl-hd" },
        h("div", { className: "mrl-hd-row" },
          h("h2", { className: "mrl-title" }, "MR 看板"),
          h("span", { className: "mrl-count" }, String(mrs.length)),
          pending > 0 ? h("span", { className: "mrl-tag err" }, pending + " 待处理") : null,
          h("span", { className: "mrl-sp" }),
          h("button", {
            className: "mrl-icon",
            type: "button",
            title: "刷新",
            disabled: state.loading,
            onClick: function () { load(); },
          }, "↻"),
          h("button", {
            className: "mrl-icon",
            type: "button",
            title: "关闭",
            onClick: function () { setStore({ open: false }); },
          }, "✕")),
        h("div", { className: "mrl-seg" },
          filters.map(function (filter) {
            return h("button", {
              key: filter.id,
              type: "button",
              "data-on": state.scope === filter.id ? "1" : undefined,
              onClick: function () { setStore({ scope: filter.id }); },
            }, filter.label);
          }))),
      h("div", { className: "mrl-body" },
        state.error
          ? h("div", { className: "mrl-err" },
              h("span", null, "拉取失败：" + state.error),
              h("span", { className: "mrl-sp" }),
              h("button", { className: "mrl-btn", type: "button", onClick: function () { load(); } }, "重试"))
          : null,
        body));
      var dialog = h("div", { className: "mrl-dialog" }, panel);
      if (ReactDOM !== null && typeof ReactDOM.createPortal === "function") {
        return ReactDOM.createPortal(dialog, document.body);
      }
      return dialog;
    }

    // ---------------------------------------------------------------- plugin
    exports.inject = ["slots"];

    exports.apply = function (ctx) {
      // M4：样式与轮询都用 ctx.effect 注册并返回 cleanup，HMR 重载时先清旧副作用再装新的，
      // 避免重复 <style> 与叠加 setInterval。
      ctx.effect(function () { return injectStyle(); }, "mr-loop: client styles");
      ctx.slots.inject("conversation.session.header.actions", function () {
        return ctx.slots.register({
          name: "conversation.session.header.actions",
          id: "mr-loop-chip",
          // 用户要求：入口放在会话头最末尾（排在其它 chip 之后、工具按钮之前）。
          order: 200,
          label: "MR",
        }, Chip);
      });
      ctx.slots.inject("shell.overlay", function () {
        return ctx.slots.register({
          name: "shell.overlay",
          id: "mr-loop-drawer",
          order: 50,
          label: "MR 看板",
        }, Drawer);
      });
      // 抽屉打开时立刻刷新一次；chip 常驻时 30s 轮询一次（随插件卸载一起清理）。
      ctx.effect(function () {
        if (typeof window === "undefined") return function () {};
        var timer = window.setInterval(function () { if (subscribers > 0) load(); }, 30000);
        return function () { window.clearInterval(timer); };
      }, "mr-loop: ui poll");
    };

    // 仅供单测：宿主只读 apply / inject，未知导出会被忽略。
    exports.__internals = {
      chipShrinkMode: chipShrinkMode,
      viewportCompact: viewportCompact,
      COMPACT_MAX_WIDTH: COMPACT_MAX_WIDTH,
    };

    return module.exports;
  },
});
