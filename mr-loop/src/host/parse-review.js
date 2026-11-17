/**
 * @module @liyuera/dsh-mr-loop/host/parse-review
 *
 * Canonical parser for GitLab "AI Code Review" notes (P0 Spike C, migrated to
 * the host in P5).
 *
 * Contract: `parseReview(noteBody) -> { verdict, blocking, nonBlocking }` where
 * `verdict` is `'pass' | 'changes' | 'unknown'` and every issue has the shape
 * `{ file, fid, level, gateCategory, location, problem, suggestion, reverifyCount }`.
 *
 * Rules (see docs/superpowers/spikes/2026-11-06-p0-findings.md, Spike C):
 *   1. A note is a review only when its own top-level lines contain both the
 *      review marker (default `AI Code Review`, overridable via `reviewMarker`)
 *      and `结论:` (see `isReviewBody()`).
 *   2. Everything from `备注：以下隐藏数据仅用于统计` on is dropped before parsing;
 *      the JSON inside that hidden block never reaches the returned issues.
 *   3. `结论: 可直接合并` -> pass, `结论: 需要修改` -> changes.
 *   4. Items are read from `需要关注的问题` and `历史未收敛问题`: `文件`, `FID`,
 *      `复验次数`, `级别`, `门禁分类`, `位置`, `源码`, `问题`, `建议` (other fields are
 *      ignored). `源码` 是可选的取证片段（单行或缩进续行），面板只在有它时显示源码行。
 *   5. `门禁分类 = 非阻塞建议` or `级别 = 低` -> nonBlocking, everything else -> blocking.
 *      This grouping is presentation-only: mergeability treats every undisposed
 *      finding in either group as blocking (see `mergeable.js`).
 *   6. Never guess: a `需要修改` verdict with no parsable item, a malformed item, a
 *      recognized issue section with text but no parsable item (format drift), or a
 *      pass note with no item and no explicit zero-issue statement yields `unknown`.
 *      A pass note may legitimately have zero items when the template states so
 *      (`历史未收敛: 0 条` / `剩余问题: 0 条`), e.g. an `AI Code Review 人工复核结果`.
 *   7. Only the note's own top-level lines count: blockquote lines, fenced code blocks
 *      (``` / ~~~) and indented code blocks (4 spaces / tab at line start) are removed
 *      before the verdict, the zero-issue declaration and the issue sections are read.
 *      A human reply that quotes or pastes a passing note stays `unknown`; there is no
 *      inline-verdict fallback.
 *
 * This module is dependency-free and has no CLI side effects, so the host
 * (P5 review service) imports it directly under plain Node. The P0 probe script
 * `scripts/review-parser.mjs` is a thin re-export that keeps its self-test
 * harness when executed.
 */
const AI_MARKER = 'AI Code Review';
/** 配置项 reviewMarker 可改标记；空值/缺失回落到默认标记，避免 `includes('')` 恒真。 */
const markerOf = (options) => {
  const marker = options?.marker;
  return typeof marker === 'string' && marker.trim() !== '' ? marker : AI_MARKER;
};
const HIDDEN_MARKER_RE = /备注\s*[:：]\s*以下隐藏数据仅用于统计/;
const SECTION_RE = /^[ \t]*(?:#{2,4}[ \t]+)?(?:\*\*)?(需要关注的问题|历史未收敛问题)(?:\*\*)?[ \t]*(?:[（(].*[)）])?[ \t]*$/;
const HEADING_RE = /^[ \t]*#{1,6}[ \t]+\S/;
const ITEM_START_RE = /^[ \t]*(?:\d+[.、)]|[-*+])[ \t]+(?:\*\*)?文件(?:\*\*)?[ \t]*[:：][ \t]*(.*)$/;
const FIELD_RE = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?(FID|复验次数|级别|类型|门禁分类|提交人|位置|源码|状态|人工复核结果|问题|建议)(?:\*\*)?[ \t]*[:：][ \t]*(.*)$/;
const VERDICT_RE = /^[ \t]*(?:\*\*)?结论(?:\*\*)?[ \t]*[:：][ \t]*(.*)$/m;
// A zero-issue declaration is a summary line of its own. Anchor it to the whole line so a
// passing note quoted inside a human reply can never be read as the latest conclusion.
const ZERO_ISSUE_RE =
  /^[ \t]*(?:\*\*)?(?:历史未收敛|剩余问题)(?:\*\*)?[ \t]*[:：][ \t]*(?:[`*]+[ \t]*)*0(?:[ \t]*[`*]+)*[ \t]*(?:条)?[ \t]*$/m;

/** Fields that map onto the ReviewIssue contract; the rest is deliberately dropped. */
const FIELD_KEY = {
  FID: 'fid',
  复验次数: 'reverifyCount',
  级别: 'level',
  门禁分类: 'gateCategory',
  位置: 'location',
  源码: 'snippet',
  问题: 'problem',
  建议: 'suggestion',
};

/** 允许跨行累积的字段：问题 / 建议是散文，源码可能是多行片段。 */
const MULTILINE_KEYS = new Set(['problem', 'suggestion', 'snippet']);

function unknownResult() {
  return { verdict: 'unknown', blocking: [], nonBlocking: [] };
}

function stripEmphasis(value) {
  let text = String(value ?? '').trim();
  for (let index = 0; index < 3; index += 1) {
    const next = text.replace(/^\*\*(.+)\*\*$/s, '$1').replace(/^__(.+)__$/s, '$1').trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

function stripOuterBackticks(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2 && text.startsWith('`') && text.endsWith('`') && !text.startsWith('```')) {
    return text.slice(1, -1).trim();
  }
  return text;
}

/** File / FID / level / category / location are single-line tokens, often in backticks. */
function cleanScalar(value) {
  return stripOuterBackticks(stripEmphasis(value));
}

/** Problem / suggestion are prose; keep inline markdown intact. */
function cleanProse(value) {
  return stripEmphasis(value);
}

function appendValue(current, addition, prose) {
  const next = prose ? cleanProse(addition) : cleanScalar(addition);
  if (!next) return current;
  if (!current) return next;
  return `${current}${prose ? '\n' : ' '}${next}`;
}

/** Strip the machine-only stats block and any AI_REVIEW HTML comments. */
function visibleBody(body) {
  const markerIndex = body.search(HIDDEN_MARKER_RE);
  if (markerIndex < 0) return body.replace(/<!--\s*AI_REVIEW_[\s\S]*?-->/g, '');

  // The marker normally sits on its own blockquote line (`> 备注：...`). Cut the whole
  // line, otherwise the leftover `> ` is appended to the last issue's suggestion.
  const lineStart = body.lastIndexOf('\n', markerIndex) + 1;
  const linePrefix = body.slice(lineStart, markerIndex);
  const cut = /^[ \t]*>[ \t]*$/.test(linePrefix) ? lineStart : markerIndex;
  return body.slice(0, cut).replace(/<!--\s*AI_REVIEW_[\s\S]*?-->/g, '');
}

const BLOCKQUOTE_RE = /^[ \t]*>/;
const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;
// 4 columns of leading whitespace: four spaces, or any earlier tab (a tab reaches the
// next 4-column stop, so ` \t` / `  \t` / `   \t` are indented code too).
const INDENTED_CODE_RE = /^(?: {4}|[ \t]*\t)/;

/**
 * The note's own top-level lines, i.e. everything a human did not quote from another
 * note. Quoted or pasted content is removed before any rule runs:
 *   - blockquote lines (`>` chains), including their content;
 *   - fenced code blocks (` ``` ` / `~~~`), including their content;
 *   - indented code blocks (4 spaces / tab at line start).
 * Verdict detection, zero-issue detection and section parsing all read this text only, so
 * a human reply quoting or pasting a previous AI note can never authorize a verdict.
 */
function ownLines(visible) {
  const own = [];
  let fence = null;
  for (const line of visible.split('\n')) {
    if (fence) {
      const close = line.match(FENCE_CLOSE_RE);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    // Drop the whole quoted line, not just the marker: the quoted content is someone
    // else's conclusion.
    if (BLOCKQUOTE_RE.test(line)) continue;
    // Check fences before indented code: an indented fence is still an attempt to quote,
    // and leaving it open would make the sanitizer fail open.
    const open = line.match(FENCE_OPEN_RE);
    if (open) {
      fence = open[1];
      continue;
    }
    if (INDENTED_CODE_RE.test(line)) continue;
    own.push(line);
  }
  return own.join('\n');
}

function extractVerdict(own) {
  const lineMatch = own.match(VERDICT_RE);
  if (!lineMatch) return 'unknown';
  const value = lineMatch[1].replace(/\*\*/g, '').trim();
  if (value.startsWith('可直接合并')) return 'pass';
  if (value.startsWith('需要修改')) return 'changes';
  return 'unknown';
}

/** Split own lines into the two issue sections; any other heading closes the current one. */
function extractIssueSections(own) {
  const sections = { need: [], history: [] };
  let current = null;
  for (const line of own.split('\n')) {
    const sectionMatch = line.match(SECTION_RE);
    if (sectionMatch) {
      current = sectionMatch[1] === '需要关注的问题' ? sections.need : sections.history;
      continue;
    }
    if (HEADING_RE.test(line)) {
      current = null;
      continue;
    }
    if (current) current.push(line);
  }
  return sections;
}

/**
 * Parse one section. Returns `malformed: true` when the section starts an item that
 * does not expose both `文件` and `问题` - that means the template changed and P1 must
 * not guess which bullet was blocking.
 */
function parseSection(lines) {
  const items = [];
  let current = null;
  let currentField = null;
  let malformed = false;
  let hasContent = false;

  const finish = () => {
    if (!current) return;
    const issue = {
      file: (current.file ?? '').trim(),
      fid: (current.fid ?? '').trim(),
      level: (current.level ?? '').trim(),
      gateCategory: (current.gateCategory ?? '').trim(),
      location: (current.location ?? '').trim(),
      // 源码是可选的取证片段（模板里常写作 `源码: \`<表达式>\``）：没有就不给这个字段，
      // 面板据此决定「不显示源码行」，不拿空串冒充源码。
      snippet: (current.snippet ?? '').trim(),
      problem: (current.problem ?? '').trim(),
      suggestion: (current.suggestion ?? '').trim(),
      // 0 是合法值（'还没复验过'），不能与缺失混为一谈；|| null 会把 0 吃掉。
      reverifyCount: (() => {
        const parsed = Number.parseInt(String(current.reverifyCount ?? '').trim(), 10)
        return Number.isNaN(parsed) ? null : parsed
      })(),
    };
    if (!issue.file || !issue.problem) malformed = true;
    items.push(issue);
    current = null;
    currentField = null;
  };

  for (const line of lines) {
    if (line.trim()) hasContent = true;

    const itemMatch = line.match(ITEM_START_RE);
    if (itemMatch) {
      finish();
      current = { file: cleanScalar(itemMatch[1]) };
      currentField = 'file';
      continue;
    }

    if (!current) {
      // A field-shaped line with no item header means the list skeleton was broken.
      if (FIELD_RE.test(line)) malformed = true;
      continue;
    }

    const fieldMatch = line.match(FIELD_RE);
    if (fieldMatch) {
      const key = FIELD_KEY[fieldMatch[1]];
      if (!key) {
        currentField = null;
        continue;
      }
      const prose = MULTILINE_KEYS.has(key);
      // 源码是代码片段：去掉包裹反引号，但不折行/压空格——续行原样保留。
      current[key] = key === 'snippet'
        ? appendValue(current[key], stripOuterBackticks(fieldMatch[2].trim()), true)
        : appendValue(current[key], fieldMatch[2], prose);
      currentField = key;
      continue;
    }

    if (!currentField) continue;
    const trimmed = line.trim();
    if (!trimmed) {
      if (current[currentField] && !current[currentField].endsWith('\n')) {
        current[currentField] += '\n';
      }
      continue;
    }
    const prose = MULTILINE_KEYS.has(currentField);
    current[currentField] = appendValue(current[currentField], trimmed, prose);
  }

  finish();
  return { items, malformed, hasContent };
}

function isNonBlocking(issue) {
  return issue.gateCategory === '非阻塞建议' || issue.level === '低';
}

/**
 * A clean review template says how many issues remain even when it has no item list.
 * Only trust an explicit `0`; an empty/broken body stays `unknown`.
 */
function hasExplicitZeroIssues(own) {
  return ZERO_ISSUE_RE.test(own);
}

/**
 * The marker + `结论:` gate, evaluated on the note's own top-level lines only.
 * `VERDICT_RE` is start-of-line anchored, so an inline "之前的结论: ..." in a
 * human reply is not a review (there is no inline-verdict fallback).
 */
function hasReviewGate(own, marker) {
  return own.includes(marker) && VERDICT_RE.test(own);
}

/**
 * True when `body` is (structurally) an AI review note: a non-empty body whose
 * OWN top-level lines carry both the review marker (default `AI Code Review`,
 * configurable via `reviewMarker`) and a `结论:` line.
 * This is the exact same gate `parseReview()` applies before it looks at the
 * verdict, exported so consumers (the review service's note filter) never
 * re-implement it with a raw substring search: a human reply that quotes or
 * pastes a review inside a blockquote/fence/indented block is not a review.
 *
 * @param {unknown} body raw GitLab note body
 * @param {{ marker?: string }} [options] `marker` 来自配置 reviewMarker
 * @returns {boolean}
 */
export function isReviewBody(body, options = {}) {
  if (typeof body !== 'string' || !body.length) return false;
  return hasReviewGate(ownLines(visibleBody(body)), markerOf(options));
}

/**
 * Parse one GitLab note body.
 * @param {string} body raw `body` field from the GitLab notes API (Markdown)
 * @param {{ marker?: string }} [options] `marker` 来自配置 reviewMarker
 * @returns {{ verdict: 'pass'|'changes'|'unknown', blocking: object[], nonBlocking: object[] }}
 */
export function parseReview(body, options = {}) {
  if (typeof body !== 'string' || !body.length) return unknownResult();

  const visible = visibleBody(body);

  // A human reply quoting or pasting a note is not a review: marker, conclusion,
  // zero-issue declaration and issue sections only count on the note's own top-level
  // lines (see ownLines and isReviewBody).
  const own = ownLines(visible);
  if (!hasReviewGate(own, markerOf(options))) return unknownResult();

  const verdict = extractVerdict(own);
  if (verdict === 'unknown') return unknownResult();

  const sections = extractIssueSections(own);
  const need = parseSection(sections.need);
  const history = parseSection(sections.history);
  if (need.malformed || history.malformed) return unknownResult();

  const items = [...need.items, ...history.items];
  // Rule 6: a recognized issue section that has text but yielded no item is template
  // drift, not a clean review - never let it fall through to `pass`.
  if ((need.hasContent && need.items.length === 0) || (history.hasContent && history.items.length === 0)) {
    return unknownResult();
  }

  const blocking = [];
  const nonBlocking = [];
  for (const issue of items) {
    if (isNonBlocking(issue)) nonBlocking.push(issue);
    else blocking.push(issue);
  }

  // A `需要修改` verdict without items cannot tell P1 what to fix: never guess.
  if (verdict === 'changes' && items.length === 0) return unknownResult();
  // A pass with no items is only valid when the template explicitly reports zero.
  if (verdict === 'pass' && items.length === 0 && !hasExplicitZeroIssues(own)) {
    return unknownResult();
  }

  return { verdict, blocking, nonBlocking };
}
