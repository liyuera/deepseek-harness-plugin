window.__ModuleLoader__.load({
  id: "@liyuera/dsh-mr-loop",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var h = React.createElement;

    // ---------------------------------------------------------------- styles
    var CSS = [
      ".mrl-chip{display:inline-flex;align-items:center;gap:6px;margin:0 2px}",
      ".mrl-chip-tag{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);font-size:11.5px;line-height:1;white-space:nowrap;cursor:pointer}",
      ".mrl-chip-tag:hover{background:var(--dsw-alias-button-floating-hover)}",
      ".mrl-chip-tag:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}",
      ".mrl-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}",
      ".mrl-dot.ok{background:var(--dsw-alias-state-success-primary)}",
      ".mrl-dot.warn{background:var(--dsw-alias-state-warn-primary)}",
      ".mrl-dot.err{background:var(--dsw-alias-state-error-primary)}",
      ".mrl-mask{position:fixed;inset:0;background:rgba(0,0,0,.18);z-index:80;display:flex;justify-content:flex-end;pointer-events:auto}",
      ".mrl-panel{width:438px;max-width:100vw;height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay);border-left:1px solid var(--dsw-alias-border-l1);box-shadow:-16px 0 36px rgba(0,0,0,.10)}",
      ".mrl-hd{padding:13px 14px 0;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}",
      ".mrl-hd-row{display:flex;align-items:center;gap:8px}",
      ".mrl-title{font-size:14px;font-weight:650;margin:0;color:var(--dsw-alias-label-primary)}",
      ".mrl-count{font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:20px;padding:0 7px;line-height:18px}",
      ".mrl-sp{flex:1}",
      ".mrl-icon{width:24px;height:24px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:7px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer}",
      ".mrl-seg{display:inline-flex;background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:2px;margin:9px 0 11px}",
      ".mrl-seg>button{border:0;background:transparent;padding:3px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);border-radius:6px;cursor:pointer}",
      ".mrl-seg>button[data-on]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.07)}",
      ".mrl-body{padding:11px;display:flex;flex-direction:column;gap:10px;overflow:auto;flex:1}",
      ".mrl-mr{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;flex:none}",
      ".mrl-mr-h{padding:11px 12px 8px;display:flex;gap:8px;align-items:flex-start}",
      ".mrl-mr-id{font-size:13px;font-weight:650;letter-spacing:.02em;display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary)}",
      ".mrl-mr-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:290px}",
      ".mrl-tags{margin-left:auto;display:flex;gap:5px;flex-shrink:0}",
      ".mrl-tag{font-size:11px;padding:0 7px;line-height:18px;border-radius:20px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);white-space:nowrap}",
      ".mrl-tag.brand{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);background:transparent}",
      ".mrl-tag.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);background:transparent}",
      ".mrl-tag.err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:transparent}",
      ".mrl-gates{display:flex;gap:5px;flex-wrap:wrap;padding:0 12px 9px}",
      ".mrl-gate{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:7px;padding:2px 8px;white-space:nowrap}",
      ".mrl-merge{display:flex;align-items:center;gap:7px;margin:0 12px 10px;padding:7px 10px;border-radius:9px;font-size:12px;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}",
      ".mrl-merge[data-kind=bad]{border-color:var(--dsw-alias-state-error-primary);background:transparent}",
      ".mrl-merge[data-kind=ok]{border-color:var(--dsw-alias-state-success-primary);background:transparent}",
      ".mrl-merge .txt{flex:1;min-width:0}",
      ".mrl-link{color:var(--dsw-alias-brand-primary);font-size:11.5px;white-space:nowrap;cursor:pointer;background:none;border:0;padding:0}",
      ".mrl-issues{border-top:1px solid var(--dsw-alias-border-l1)}",
      ".mrl-issue{padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".mrl-issue:last-child{border-bottom:0}",
      ".mrl-issue[data-open]{background:var(--dsw-alias-bg-layer-2)}",
      ".mrl-i-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".mrl-fid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".mrl-lv{font-size:10.5px;line-height:16px;padding:0 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".mrl-lv[data-lv=高]{color:var(--dsw-alias-state-error-primary)}",
      ".mrl-lv[data-lv=中]{color:var(--dsw-alias-state-warn-primary)}",
      ".mrl-lv[data-lv=低]{color:var(--dsw-alias-brand-primary)}",
      ".mrl-st{font-size:10.5px;line-height:17px;padding:0 7px;border-radius:20px;white-space:nowrap}",
      ".mrl-st[data-st=open]{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2)}",
      ".mrl-st[data-st=fixed]{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-layer-2)}",
      ".mrl-st[data-st=waived]{color:var(--dsw-alias-state-idle-primary);background:var(--dsw-alias-bg-layer-2)}",
      ".mrl-chev{font-size:10.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:0;padding:0;margin-left:auto}",
      ".mrl-file{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".mrl-prob{font-size:12px;margin-top:3px;color:var(--dsw-alias-label-primary)}",
      ".mrl-instr{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:5px;align-items:baseline;flex-wrap:wrap}",
      ".mrl-code{font-size:10.5px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 5px;max-width:250px;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:bottom;white-space:nowrap}",
      ".mrl-detail{margin-top:8px;padding:9px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:8px}",
      ".mrl-d-row{display:grid;grid-template-columns:54px 1fr;gap:8px;font-size:11.5px;line-height:1.65}",
      ".mrl-d-k{color:var(--dsw-alias-label-secondary);font-size:10.5px;padding-top:1px}",
      ".mrl-d-v{color:var(--dsw-alias-label-secondary);min-width:0;white-space:pre-wrap;word-break:break-word}",
      ".mrl-snippet{display:block;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;line-height:1.7;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}",
      ".mrl-f{padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;gap:7px;color:var(--dsw-alias-label-secondary);font-size:11px;background:var(--dsw-alias-bg-layer-2)}",
      ".mrl-btn{font-size:11.5px;padding:3px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}",
      ".mrl-btn:disabled{opacity:.5;cursor:default}",
      ".mrl-empty{padding:26px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".mrl-err{margin:0 0 2px;padding:9px 11px;border-radius:9px;font-size:11.5px;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-state-warn-primary);display:flex;align-items:center;gap:8px}",
      ".mrl-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}",
    ].join("\n");

    function injectStyle() {
      if (typeof document === "undefined") return;
      var tagId = "@liyuera/dsh-mr-loop/panel.css";
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
      var tag = document.createElement("style");
      tag.dataset.plugin = "@liyuera/dsh-mr-loop";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ---------------------------------------------------------------- store
    var listeners = new Set();
    var store = {
      data: null,
      loading: false,
      error: null,
      open: false,
      scope: "session",
      sessionId: null,
      expanded: {},
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
      if (review === null || review === undefined) return "— 未出";
      if (review.verdict === "pass") return "✅ 可直接合并";
      if (review.verdict === "changes") return "⛔ 需要修改";
      return "⏳ 未解析";
    }

    function sensitiveLabel(value) {
      if (value === "pass") return "✅ 通过";
      if (value === "block") return "⛔ 阻止合并";
      if (value === "unknown") return "⏳ 未解析（不拦合并）";
      return "— 无本轮结论";
    }

    function mandatoryLabel(value) {
      if (value === "pass") return "✅ 通过";
      if (value === "block") return "⛔ 阻止合并";
      return "— 建议性";
    }

    function problemStatusLabel(problem) {
      if (problem.status === "fixed") return { text: "✓ 已修", tone: "fixed" };
      if (problem.status === "waived") {
        var kind = problem.instruction && problem.instruction.kind;
        if (kind === "skip") return { text: "◌ 不适用", tone: "waived" };
        if (kind === "wontfix") return { text: "◌ 不修", tone: "waived" };
        return { text: "◌ 已豁免", tone: "waived" };
      }
      return { text: "● 未处理", tone: "open" };
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

    // ---------------------------------------------------------------- chip
    function Chip(props) {
      var state = useStore();
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
      var pending = data.counts && typeof data.counts.pending === "number" ? data.counts.pending : 0;
      var shown = data.mrs.slice(0, 2);
      var tags = shown.map(function (mr) {
        var label = "!" + mr.iid;
        var tone = mr.merge && mr.merge.mergeable === true ? "ok" : (mr.pending > 0 ? "warn" : "");
        return h("button", {
          key: "mr-" + mr.iid,
          className: "mrl-chip-tag",
          type: "button",
          title: mr.sourceBranch + " → " + mr.targetBranch,
          onClick: function () { setStore({ open: true }); },
        },
        h("span", { className: "mrl-dot " + tone }),
        h("span", null, label + " · 第 " + (mr.round || 0) + " 轮"));
      });
      var more = data.mrs.length > shown.length
        ? h("span", { className: "mrl-tag" }, "+" + (data.mrs.length - shown.length))
        : null;
      var pendingTag = pending > 0
        ? h("span", { className: "mrl-tag err" }, pending + " 待处理")
        : null;
      return h("span", { className: "mrl-chip" }, tags, more, pendingTag,
        h("button", {
          className: "mrl-chip-tag",
          type: "button",
          onClick: function () { setStore({ open: true }); },
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
        if (instruction && instruction.reason) {
          rows.push(h("div", { className: "mrl-d-row", key: "instruction" },
            h("span", { className: "mrl-d-k" }, "指令"),
            h("span", { className: "mrl-d-v" }, "#" + instruction.kind + " · reason=" + instruction.reason)));
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
      var mergeKind = merge === null ? "none" : (merge.mergeable === true ? "ok" : "bad");
      var mergeText = merge === null
        ? "— 历史账本（未在跟踪）"
        : (merge.mergeable === true
            ? "✅ 可合"
            : "⛔ 差 " + (merge.missing ? merge.missing.length : 0) + " 项：" + (merge.missing || []).join("；"));
      var pipeline = merge && merge.pipeline
        ? "流水线 #" + merge.pipeline.id + " " + merge.pipeline.status
        : null;
      var gates = mr.gates || {};
      var review = mr.review;
      var openMr = function () { if (mr.webUrl) window.open(mr.webUrl, "_blank", "noopener,noreferrer"); };
      var removeEscaped = function () { /* hooks not used here */ };
      void removeEscaped;
      var copyDraft = function () {
        var fid = problems.filter(function (p) { return p.status === "open"; }).map(function (p) { return p.fid; })[0];
        if (fid === undefined) return;
        copyText("#ai-waive " + fid + " reason=");
      };

      var tags = [
        h("span", { className: "mrl-tag brand", key: "round" }, "第 " + (mr.round || 0) + " 轮"),
        mr.state === "merged"
          ? h("span", { className: "mrl-tag", key: "state" }, "已合并")
          : (pending > 0
              ? h("span", { className: "mrl-tag err", key: "state" }, pending + " 待处理")
              : (merge && merge.mergeable === true
                  ? h("span", { className: "mrl-tag ok", key: "state" }, "可合")
                  : null)),
      ];

      return h("div", { className: "mrl-mr" },
        h("div", { className: "mrl-mr-h" },
          h("div", { style: { minWidth: 0 } },
            h("div", { className: "mrl-mr-id" },
              "!" + mr.iid,
              mr.live === true ? h("span", { className: "mrl-tag" }, "跟踪中") : null,
              h("span", { className: "mrl-tag", style: { color: "var(--dsw-alias-label-secondary)" } }, MR_STATE_LABEL[mr.state] || mr.state)),
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
          h("span", { className: "txt" }, mergeText),
          h("button", { className: "mrl-link", type: "button", onClick: openMr }, "打开 MR ↗")),
        problems.length > 0
          ? h("div", { className: "mrl-issues" },
              problems.map(function (problem) {
                return h(ProblemRow, { key: String(problem.fid), problem: problem });
              }))
          : null,
        h("div", { className: "mrl-f" },
          h("span", { className: "mrl-mono" }, "sha " + String(mr.sha || "").slice(0, 8)),
          mr.updatedAt ? h("span", null, "· " + String(mr.updatedAt).replace("T", " ").slice(0, 16)) : null,
          h("span", { className: "mrl-sp" }),
          h("button", { className: "mrl-btn", type: "button", onClick: copyDraft }, "复制指令"),
          h("button", { className: "mrl-btn", type: "button", onClick: openMr }, "详情")));
    }

    // ---------------------------------------------------------------- drawer
    function Drawer() {
      var state = useStore();
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
            : "这个分类里还没有 MR");
      } else {
        body = visible.map(function (mr) { return h(MrCard, { key: mr.projectPath + "#" + mr.iid, mr: mr }); });
      }

      return h("div", {
        className: "mrl-mask",
        onClick: function () { setStore({ open: false }); },
      },
      h("div", {
        className: "mrl-panel",
        onClick: function (event) { event.stopPropagation(); },
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
        body)));
    }

    // ---------------------------------------------------------------- plugin
    exports.inject = ["slots"];

    exports.apply = function (ctx) {
      injectStyle();
      ctx.slots.inject("conversation.session.header.actions", function () {
        return ctx.slots.register({
          name: "conversation.session.header.actions",
          id: "mr-loop-chip",
          order: 50,
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
      // 抽屉打开时立刻刷新一次；chip 常驻时 30s 轮询一次。
      if (typeof window !== "undefined") {
        window.setInterval(function () { if (subscribers > 0) load(); }, 30000);
      }
    };

    return module.exports;
  },
});
