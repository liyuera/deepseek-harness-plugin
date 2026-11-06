#!/usr/bin/env node
/**
 * Parser for GitLab "AI Code Review" notes (Spike C, reused by P1).
 *
 * Contract: `parseReview(noteBody) -> { verdict, blocking, nonBlocking }` where
 * `verdict` is `'pass' | 'changes' | 'unknown'` and every issue has the shape
 * `{ file, fid, level, gateCategory, location, problem, suggestion }`.
 *
 * Rules (see docs/superpowers/spikes/2026-11-06-p0-findings.md, Spike C):
 *   1. A note is a review only when it contains both `AI Code Review` and `结论:`.
 *   2. Everything from `备注：以下隐藏数据仅用于统计` on is dropped before parsing;
 *      the JSON inside that hidden block never reaches the returned issues.
 *   3. `结论: 可直接合并` -> pass, `结论: 需要修改` -> changes.
 *   4. Items are read from `需要关注的问题` and `历史未收敛问题`: `文件`, `FID`,
 *      `级别`, `门禁分类`, `位置`, `问题`, `建议` (other fields are ignored).
 *   5. `门禁分类 = 非阻塞建议` or `级别 = 低` -> nonBlocking, everything else -> blocking.
 *   6. Never guess: a `需要修改` verdict with no parsable item, a malformed item, a
 *      recognized issue section with text but no parsable item (format drift), or a
 *      pass note with no item and no explicit zero-issue statement yields `unknown`.
 *      A pass note may legitimately have zero items when the template states so
 *      (`历史未收敛: 0 条` / `剩余问题: 0 条`), e.g. an `AI Code Review 人工复核结果`.
 *   7. Only the note's own unquoted lines count for the conclusion and the zero-issue
 *      declaration. A human reply that quotes a passing note stays `unknown`.
 *
 * The module also works as a self-test entry point:
 *   node bug-workflow/scripts/review-parser.mjs
 * It prints the parsed fixtures and exits non-zero on a regression.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AI_MARKER = 'AI Code Review';
const HIDDEN_MARKER_RE = /备注\s*[:：]\s*以下隐藏数据仅用于统计/;
const SECTION_RE = /^[ \t]*(?:#{2,4}[ \t]+)?(?:\*\*)?(需要关注的问题|历史未收敛问题)(?:\*\*)?[ \t]*(?:[（(].*[)）])?[ \t]*$/;
const HEADING_RE = /^[ \t]*#{1,6}[ \t]+\S/;
const ITEM_START_RE = /^[ \t]*(?:\d+[.、)]|[-*+])[ \t]+(?:\*\*)?文件(?:\*\*)?[ \t]*[:：][ \t]*(.*)$/;
const FIELD_RE = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?(FID|复验次数|级别|类型|门禁分类|提交人|位置|源码|状态|人工复核结果|问题|建议)(?:\*\*)?[ \t]*[:：][ \t]*(.*)$/;
const VERDICT_RE = /^[ \t]*(?:\*\*)?结论(?:\*\*)?[ \t]*[:：][ \t]*(.*)$/m;
const INLINE_VERDICT_RE = /结论[ \t]*[:：][ \t]*(?:\*\*)?[ \t]*(可直接合并|需要修改)/;
// A zero-issue declaration is a summary line of its own. Anchor it to the whole line so a
// passing note quoted inside a human reply can never be read as the latest conclusion.
const ZERO_ISSUE_RE =
  /^[ \t]*(?:\*\*)?(?:历史未收敛|剩余问题)(?:\*\*)?[ \t]*[:：][ \t]*(?:[`*]+[ \t]*)*0(?:[ \t]*[`*]+)*[ \t]*(?:条)?[ \t]*$/m;

/** Fields that map onto the ReviewIssue contract; the rest is deliberately dropped. */
const FIELD_KEY = {
  FID: 'fid',
  级别: 'level',
  门禁分类: 'gateCategory',
  位置: 'location',
  问题: 'problem',
  建议: 'suggestion',
};

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

/**
 * The note's own lines, i.e. everything a human did not quote from another note.
 * A human reply quoting a passing AI note must not be mistaken for a review.
 */
function topLevelText(visible) {
  return visible
    .split('\n')
    .filter((line) => !/^[ \t]*>/.test(line))
    .join('\n');
}

function extractVerdict(topLevel) {
  const lineMatch = topLevel.match(VERDICT_RE);
  if (lineMatch) {
    const value = lineMatch[1].replace(/\*\*/g, '').trim();
    if (value.startsWith('可直接合并')) return 'pass';
    if (value.startsWith('需要修改')) return 'changes';
    return 'unknown';
  }
  const inlineMatch = topLevel.match(INLINE_VERDICT_RE);
  if (inlineMatch) return inlineMatch[1] === '可直接合并' ? 'pass' : 'changes';
  return 'unknown';
}

/** Split lines into the two issue sections; any other heading closes the current one. */
function extractIssueSections(visible) {
  const sections = { need: [], history: [] };
  let current = null;
  for (const line of visible.split('\n')) {
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
      problem: (current.problem ?? '').trim(),
      suggestion: (current.suggestion ?? '').trim(),
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
      const prose = key === 'problem' || key === 'suggestion';
      current[key] = appendValue(current[key], fieldMatch[2], prose);
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
    const prose = currentField === 'problem' || currentField === 'suggestion';
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
function hasExplicitZeroIssues(topLevel) {
  return ZERO_ISSUE_RE.test(topLevel);
}

/**
 * Parse one GitLab note body.
 * @param {string} body raw `body` field from the GitLab notes API (Markdown)
 * @returns {{ verdict: 'pass'|'changes'|'unknown', blocking: object[], nonBlocking: object[] }}
 */
export function parseReview(body) {
  if (typeof body !== 'string' || !body.length) return unknownResult();

  const visible = visibleBody(body);
  if (!visible.includes(AI_MARKER) || !/结论[ \t]*[:：]/.test(visible)) return unknownResult();

  // A human reply quoting a passing note is not a review: the conclusion and the
  // zero-issue declaration only count on the note's own (unquoted) lines.
  const topLevel = topLevelText(visible);
  const verdict = extractVerdict(topLevel);
  if (verdict === 'unknown') return unknownResult();

  const sections = extractIssueSections(visible);
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
  if (verdict === 'pass' && items.length === 0 && !hasExplicitZeroIssues(topLevel)) {
    return unknownResult();
  }

  return { verdict, blocking, nonBlocking };
}

function runSelfTest() {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixtureDir = resolve(here, 'fixtures');
  const fixtures = [
    { name: 'review-needs-fix.md', expected: { verdict: 'changes', minBlocking: 1 } },
    { name: 'review-pass.md', expected: { verdict: 'pass', blocking: 0 } },
  ];

  const failures = [];
  const check = (label, condition, detail) => {
    if (condition) {
      console.log(`  PASS ${label}`);
      return;
    }
    failures.push(`${label}${detail ? ` (${detail})` : ''}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  };

  console.log('AI Code Review parser self-test');
  console.log(`fixtures: ${fixtureDir}`);

  for (const fixture of fixtures) {
    let body;
    try {
      body = readFileSync(resolve(fixtureDir, fixture.name), 'utf8');
    } catch (error) {
      failures.push(`${fixture.name}: cannot read fixture (${error?.message ?? error})`);
      console.log(`\n[${fixture.name}] FAIL — cannot read fixture`);
      continue;
    }
    const result = parseReview(body);
    console.log(`\n[${fixture.name}]`);
    console.log(
      JSON.stringify(
        {
          verdict: result.verdict,
          blocking: result.blocking.length,
          nonBlocking: result.nonBlocking.length,
        },
        null,
        2,
      ),
    );
    for (const issue of [...result.blocking, ...result.nonBlocking].slice(0, 3)) {
      console.log(`  issue: file=${issue.file} level=${issue.level} gateCategory=${issue.gateCategory} location=${issue.location}`);
    }
    check(`verdict is ${fixture.expected.verdict}`, result.verdict === fixture.expected.verdict, `got ${result.verdict}`);
    if (fixture.expected.minBlocking !== undefined) {
      check(`blocking >= ${fixture.expected.minBlocking}`, result.blocking.length >= fixture.expected.minBlocking, `got ${result.blocking.length}`);
    }
    if (fixture.expected.blocking !== undefined) {
      check(`blocking is ${fixture.expected.blocking}`, result.blocking.length === fixture.expected.blocking, `got ${result.blocking.length}`);
    }
    check('issues expose the full contract', [...result.blocking, ...result.nonBlocking].every(
      (issue) =>
        typeof issue.file === 'string' &&
        typeof issue.fid === 'string' &&
        typeof issue.level === 'string' &&
        typeof issue.gateCategory === 'string' &&
        typeof issue.location === 'string' &&
        typeof issue.problem === 'string' &&
        typeof issue.suggestion === 'string',
    ));
  }

  console.log('\n[edge cases]');
  const edgeCases = [
    {
      label: 'non-review note (no AI marker) -> unknown',
      body: '## Sensitive Content Gate\n\n结论: 需要修改\n\n### 需要关注的问题\n1. **文件**: `src/leak.ts`\n   - 级别: 高\n   - 问题: x\n',
      expected: { verdict: 'unknown' },
    },
    {
      label: 'AI marker without verdict -> unknown',
      body: '## AI Code Review\n\n摘要: no verdict here\n',
      expected: { verdict: 'unknown' },
    },
    {
      label: 'changes without items -> unknown',
      body: '## AI Code Review\n\n结论: **需要修改**\n\n历史未收敛: `0` 条\n',
      expected: { verdict: 'unknown' },
    },
    {
      label: 'pass without items but explicit zero -> pass',
      body: '## AI Code Review 人工复核结果\n\n结论: **可直接合并**\n\n剩余问题: `0` 条\n',
      expected: { verdict: 'pass', blocking: 0 },
    },
    {
      label: 'pass without items and no zero statement -> unknown',
      body: '## AI Code Review\n\n结论: **可直接合并**\n',
      expected: { verdict: 'unknown' },
    },
    {
      label: 'quoted passing note -> unknown',
      body: '> ## AI Code Review\n> 结论: **可直接合并**\n> 历史未收敛: `0` 条\n',
      expected: { verdict: 'unknown' },
    },
    {
      label: 'quoted conclusion does not authorize pass -> unknown',
      body: '## AI Code Review\n\n> 结论: **可直接合并**\n\n历史未收敛: `0` 条\n',
      expected: { verdict: 'unknown' },
    },
    {
      label: 'quoted zero statement does not authorize pass -> unknown',
      body: '## AI Code Review\n\n结论: **可直接合并**\n\n> 历史未收敛: `0` 条\n',
      expected: { verdict: 'unknown' },
    },
    {
      label: 'human reply quoting a pass note -> unknown',
      body:
        '> ## AI Code Review\n> 结论: **可直接合并**\n> 历史未收敛: `0` 条\n\n' +
        '收到，已确认。\n',
      expected: { verdict: 'unknown' },
    },
    {
      label: 'pass with non-field-shaped section content -> unknown',
      body:
        '## AI Code Review\n\n结论: **可直接合并**\n\n历史未收敛: `0` 条\n\n' +
        '### 需要关注的问题\n本次未发现需要关注的问题，详情见上方摘要。\n',
      expected: { verdict: 'unknown' },
    },
    {
      label: 'manual reconciliation note with top-level zero statements -> pass',
      body:
        '## AI Code Review 人工复核结果\n\n结论: **可直接合并**\n\n' +
        '历史未收敛: `0` 条\n剩余问题: 0 条\n',
      expected: { verdict: 'pass', blocking: 0, nonBlocking: 0 },
    },
    {
      label: 'nonzero history does not authorize pass -> unknown',
      body: '## AI Code Review\n\n结论: **可直接合并**\n\n历史未收敛: `10` 条\n',
      expected: { verdict: 'unknown' },
    },
    {
      label: 'malformed item (missing problem) -> unknown',
      body: '## AI Code Review\n\n结论: **需要修改**\n\n### 需要关注的问题\n1. **文件**: `src/a.ts`\n   - 级别: 高\n   - 门禁分类: 逻辑错误\n',
      expected: { verdict: 'unknown' },
    },
    {
      label: 'hidden stats block is cut before parsing',
      body:
        '## AI Code Review\n\n结论: **可直接合并**\n\n历史未收敛: `0` 条\n\n' +
        '> 备注：以下隐藏数据仅用于统计，请勿阅读该数据进行 Code Review。\n' +
        '<!-- AI_REVIEW_FINDINGS {"findings":[]} -->\n' +
        '### 需要关注的问题\n1. **文件**: `src/hidden-leak.ts`\n   - 级别: 高\n   - 门禁分类: 逻辑错误\n   - 问题: must never be parsed\n',
      expected: { verdict: 'pass', blocking: 0 },
    },
    {
      label: 'hidden marker blockquote does not leak into the last field',
      body:
        '## AI Code Review\n\n结论: **需要修改**\n\n### 需要关注的问题\n' +
        '1. **文件**: `src/a.ts`\n   - 级别: 高\n   - 门禁分类: 逻辑错误\n   - 问题: foo\n   - 建议: bar\n\n' +
        '> 备注：以下隐藏数据仅用于统计，请勿阅读该数据进行 Code Review。\n' +
        '<!-- AI_REVIEW_FINDINGS {"findings":[]} -->\n',
      expected: { verdict: 'changes', blocking: 1, nonBlocking: 0, suggestion: 'bar' },
    },
    {
      label: 'classification: gate=非阻塞建议 wins over 级别=高',
      body:
        '## AI Code Review\n\n结论: **需要修改**\n\n### 需要关注的问题\n' +
        '1. **文件**: `src/a.ts`\n   - 级别: 高\n   - 门禁分类: 非阻塞建议\n   - 问题: a\n' +
        '2. **文件**: `src/b.ts`\n   - 级别: 低\n   - 门禁分类: 逻辑错误\n   - 问题: b\n' +
        '3. **文件**: `src/c.ts`\n   - 级别: 高\n   - 门禁分类: 逻辑错误\n   - 问题: c\n',
      expected: { verdict: 'changes', blocking: 1, nonBlocking: 2 },
    },
  ];

  for (const edgeCase of edgeCases) {
    const result = parseReview(edgeCase.body);
    const checks = [result.verdict === edgeCase.expected.verdict];
    if (edgeCase.expected.blocking !== undefined) checks.push(result.blocking.length === edgeCase.expected.blocking);
    if (edgeCase.expected.nonBlocking !== undefined) checks.push(result.nonBlocking.length === edgeCase.expected.nonBlocking);
    if (edgeCase.expected.suggestion !== undefined) checks.push(result.blocking[0]?.suggestion === edgeCase.expected.suggestion);
    check(
      edgeCase.label,
      checks.every(Boolean),
      `verdict=${result.verdict} blocking=${result.blocking.length} nonBlocking=${result.nonBlocking.length}`,
    );
  }

  if (failures.length) {
    console.error(`\nself-test FAILED (${failures.length}):\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nself-test PASSED');
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) runSelfTest();
