/**
 * Canonical AI Code Review parser tests (P5 migration from the P0 script).
 *
 * The cases mirror `scripts/review-parser.mjs`'s self-test edge table, but run
 * under `node --test` against the canonical host module
 * `src/host/review-parser.js`. The P0 script stays as a thin re-exporting shim
 * with its self-test harness; both entry points must agree.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isReviewBody, parseReview } from '../src/host/review-parser.js';

const MARKER = '## AI Code Review';
const SCRIPT = fileURLToPath(new URL('../scripts/review-parser.mjs', import.meta.url));

function unknown() {
  return { verdict: 'unknown', blocking: [], nonBlocking: [] };
}

function review(lines) {
  return lines.join('\n');
}

/** One complete template item; every field is overridable to break the shape. */
function issue({
  prefix = '1.',
  file = 'src/a.ts',
  level = '高',
  gate = '逻辑错误',
  problem = '问题描述',
  suggestion = '修复建议',
  fid = 'aaaaaaaaaa',
  location,
} = {}) {
  return [
    `${prefix} **文件**: \`${file}\``,
    `   - FID: \`${fid}\``,
    `   - 级别: ${level}`,
    `   - 门禁分类: ${gate}`,
    `   - 位置: \`${location ?? `${file}:10-20`}\``,
    `   - 问题: ${problem}`,
    `   - 建议: ${suggestion}`,
  ].join('\n');
}

function changesBody(issueText, extraLines = []) {
  return review([
    MARKER,
    '',
    '结论: **需要修改**',
    '',
    '### 需要关注的问题',
    issueText,
    ...extraLines,
  ]);
}

function passBody({ zero = '历史未收敛: `0` 条', extraLines = [] } = {}) {
  return review([
    MARKER,
    '',
    '结论: **可直接合并**',
    '',
    ...(zero === null ? [] : [zero]),
    ...extraLines,
  ]);
}

// ---------------------------------------------------------------------------
// AI marker / 结论 gating
// ---------------------------------------------------------------------------

test('parseReview() returns unknown for empty, whitespace and non-string bodies', () => {
  for (const body of [undefined, null, 42, {}, [], '', '   ', '\n\t']) {
    assert.deepEqual(parseReview(body), unknown(), String(body));
  }
});

test('parseReview() ignores a note without the AI Code Review marker', () => {
  const body = review([
    '## Sensitive Content Gate',
    '',
    '结论: 需要修改',
    '',
    '### 需要关注的问题',
    issue({ file: 'src/leak.ts' }),
  ]);
  assert.deepEqual(parseReview(body), unknown());
});

test('parseReview() ignores an AI-marked note without a 结论 line', () => {
  const body = review([MARKER, '', '摘要: 没有结论行', '', '### 需要关注的问题', issue()]);
  assert.deepEqual(parseReview(body), unknown());
});

test('parseReview() ignores a 结论 line when the AI marker only appears in a quote', () => {
  const body = review([
    '> ## AI Code Review',
    '结论: **可直接合并**',
    '历史未收敛: `0` 条',
  ]);
  assert.deepEqual(parseReview(body), unknown());
});

test('parseReview() treats an unrecognized 结论 value as unknown', () => {
  const body = review([
    MARKER,
    '',
    '结论: **待定**',
    '',
    '历史未收敛: `0` 条',
  ]);
  assert.deepEqual(parseReview(body), unknown());
});

// ---------------------------------------------------------------------------
// Pass / changes verdicts
// ---------------------------------------------------------------------------

test('parseReview() accepts 可直接合并 with an explicit zero-issue declaration', () => {
  const result = parseReview(passBody());
  assert.deepEqual(result, { verdict: 'pass', blocking: [], nonBlocking: [] });
});

test('parseReview() accepts both explicit zero-issue declarations', () => {
  for (const zero of ['历史未收敛: `0` 条', '剩余问题: 0 条', '历史未收敛: **0**']) {
    const result = parseReview(passBody({ zero }));
    assert.deepEqual(result, { verdict: 'pass', blocking: [], nonBlocking: [] }, zero);
  }
});

test('parseReview() rejects 可直接合并 without items or an explicit zero', () => {
  assert.deepEqual(parseReview(passBody({ zero: null })), unknown());
  assert.deepEqual(parseReview(passBody({ zero: '历史未收敛: `10` 条' })), unknown());
});

test('parseReview() parses 需要修改 items into blocking issues', () => {
  const result = parseReview(changesBody(issue()));
  assert.equal(result.verdict, 'changes');
  assert.equal(result.blocking.length, 1);
  assert.equal(result.nonBlocking.length, 0);
  assert.equal(result.blocking[0].file, 'src/a.ts');
  assert.equal(result.blocking[0].problem, '问题描述');
});

test('parseReview() rejects 需要修改 without any parsable item', () => {
  const body = review([
    MARKER,
    '',
    '结论: **需要修改**',
    '',
    '历史未收敛: `0` 条',
  ]);
  assert.deepEqual(parseReview(body), unknown());
});

// ---------------------------------------------------------------------------
// Level / gate classification
// ---------------------------------------------------------------------------

test('parseReview() classifies 门禁分类=非阻塞建议 as nonBlocking even at 级别=高', () => {
  const result = parseReview(changesBody(issue({ level: '高', gate: '非阻塞建议' })));
  assert.equal(result.verdict, 'changes');
  assert.equal(result.blocking.length, 0);
  assert.equal(result.nonBlocking.length, 1);
  assert.equal(result.nonBlocking[0].gateCategory, '非阻塞建议');
});

test('parseReview() classifies 级别=低 as nonBlocking even with a blocking gate', () => {
  const result = parseReview(changesBody(issue({ level: '低', gate: '逻辑错误' })));
  assert.equal(result.verdict, 'changes');
  assert.equal(result.blocking.length, 0);
  assert.equal(result.nonBlocking.length, 1);
});

test('parseReview() classifies ordinary medium/high items as blocking', () => {
  for (const level of ['中', '高']) {
    const result = parseReview(changesBody(issue({ level, gate: '逻辑错误' })));
    assert.equal(result.blocking.length, 1, level);
    assert.equal(result.nonBlocking.length, 0, level);
  }
});

test('parseReview() mixes blocking and nonBlocking items in one section', () => {
  const body = changesBody([
    issue({ file: 'src/a.ts', level: '高', gate: '逻辑错误' }),
    issue({ prefix: '2.', file: 'src/b.ts', level: '高', gate: '非阻塞建议' }),
    issue({ prefix: '3.', file: 'src/c.ts', level: '低', gate: '逻辑错误' }),
  ].join('\n'));
  const result = parseReview(body);
  assert.equal(result.verdict, 'changes');
  assert.equal(result.blocking.length, 1);
  assert.equal(result.nonBlocking.length, 2);
  assert.deepEqual(result.blocking.map((entry) => entry.file), ['src/a.ts']);
  assert.deepEqual(
    result.nonBlocking.map((entry) => entry.file),
    ['src/b.ts', 'src/c.ts'],
  );
});

// ---------------------------------------------------------------------------
// 历史未收敛问题 handling
// ---------------------------------------------------------------------------

test('parseReview() parses the 历史未收敛问题 section', () => {
  const body = review([
    MARKER,
    '',
    '结论: **需要修改**',
    '',
    '历史未收敛: `1` 条',
    '',
    '### 历史未收敛问题',
    issue({ file: 'src/history.ts', level: '中', gate: '逻辑错误' }),
  ]);
  const result = parseReview(body);
  assert.equal(result.verdict, 'changes');
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0].file, 'src/history.ts');
});

test('parseReview() merges 需要关注的问题 and 历史未收敛问题 items in order', () => {
  const body = review([
    MARKER,
    '',
    '结论: **需要修改**',
    '',
    '### 需要关注的问题',
    issue({ file: 'src/need.ts' }),
    '',
    '### 历史未收敛问题',
    issue({ prefix: '2.', file: 'src/history.ts' }),
  ]);
  const result = parseReview(body);
  assert.equal(result.verdict, 'changes');
  assert.equal(result.blocking.length, 2);
  assert.deepEqual(result.blocking.map((entry) => entry.file), [
    'src/need.ts',
    'src/history.ts',
  ]);
});

test('parseReview() accepts a pass note that still carries non-blocking history items', () => {
  const body = passBody({
    zero: '历史未收敛: `1` 条',
    extraLines: [
      '',
      '### 历史未收敛问题',
      issue({ file: 'src/styles/a.less', level: '低', gate: '非阻塞建议' }),
    ],
  });
  const result = parseReview(body);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.blocking.length, 0);
  assert.equal(result.nonBlocking.length, 1);
});

// ---------------------------------------------------------------------------
// Item shape / prefixes / continuation prose
// ---------------------------------------------------------------------------

test('parseReview() returns the full issue contract fields', () => {
  const result = parseReview(changesBody(issue({
    file: 'src/full.ts',
    fid: 'bbbbbbbbbb',
    level: '中',
    gate: '通用问题',
    location: 'src/full.ts:7',
    problem: '完整问题',
    suggestion: '完整建议',
  })));
  assert.deepEqual(Object.keys(result.blocking[0]), [
    'file',
    'fid',
    'level',
    'gateCategory',
    'location',
    'problem',
    'suggestion',
  ]);
  assert.deepEqual(result.blocking[0], {
    file: 'src/full.ts',
    fid: 'bbbbbbbbbb',
    level: '中',
    gateCategory: '通用问题',
    location: 'src/full.ts:7',
    problem: '完整问题',
    suggestion: '完整建议',
  });
});

test('parseReview() accepts numbered, parenthesized, ideographic-comma and bullet prefixes', () => {
  for (const prefix of ['1.', '1)', '1、', '-', '*', '+']) {
    const result = parseReview(changesBody(issue({ prefix, file: 'src/prefix.ts' })));
    assert.equal(result.verdict, 'changes', prefix);
    assert.equal(result.blocking.length, 1, prefix);
    assert.equal(result.blocking[0].file, 'src/prefix.ts', prefix);
  }
});

test('parseReview() rejects a malformed numeric prefix without an item header', () => {
  for (const broken of ['1.**文件**: `src/broken.ts`', '(1) **文件**: `src/broken.ts`']) {
    const result = parseReview(changesBody(broken));
    assert.deepEqual(result, unknown(), broken);
  }
});

test('parseReview() joins continuation prose onto the current field', () => {
  const body = changesBody([
    '1. **文件**: `src/prose.ts`',
    '   - 级别: 中',
    '   - 门禁分类: 逻辑错误',
    '   - 问题: 第一行',
    '   第二行',
    '   - 建议: 改为统一口径',
    '   并补充测试',
  ].join('\n'));
  const result = parseReview(body);
  assert.equal(result.verdict, 'changes');
  assert.equal(result.blocking[0].problem, '第一行\n第二行');
  assert.equal(result.blocking[0].suggestion, '改为统一口径\n并补充测试');
});

test('parseReview() returns unknown for an item missing 问题', () => {
  const body = changesBody([
    '1. **文件**: `src/a.ts`',
    '   - 级别: 高',
    '   - 门禁分类: 逻辑错误',
  ].join('\n'));
  assert.deepEqual(parseReview(body), unknown());
});

test('parseReview() returns unknown for an item with an empty 文件', () => {
  const body = changesBody([
    '1. **文件**: ',
    '   - 级别: 高',
    '   - 问题: orphan problem',
  ].join('\n'));
  assert.deepEqual(parseReview(body), unknown());
});

test('parseReview() returns unknown for a field-shaped line outside an item', () => {
  const body = changesBody('   - 问题: no item header');
  assert.deepEqual(parseReview(body), unknown());
});

test('parseReview() returns unknown when a recognized section has text but no items', () => {
  const drift = passBody({
    extraLines: [
      '',
      '### 需要关注的问题',
      '本次未发现需要关注的问题，详情见上方摘要。',
    ],
  });
  assert.deepEqual(parseReview(drift), unknown());
});

test('parseReview() returns unknown when a changes note drifts to a text-only section', () => {
  const drift = review([
    MARKER,
    '',
    '结论: **需要修改**',
    '',
    '### 需要关注的问题',
    '模板变了，没有可解析的条目。',
  ]);
  assert.deepEqual(parseReview(drift), unknown());
});

// ---------------------------------------------------------------------------
// Hidden stats block / AI_REVIEW comments
// ---------------------------------------------------------------------------

test('parseReview() cuts the hidden-data block and never leaks its JSON', () => {
  const body = passBody({
    extraLines: [
      '',
      '> 备注：以下隐藏数据仅用于统计，请勿阅读该数据进行 Code Review。',
      '<!-- AI_REVIEW_FINDINGS {"findings":[{"finding_id":"hidden-leak","severity":"high","file":"src/hidden-leak.ts","issue":"must never be parsed","suggestion":"none"}]} -->',
      '### 需要关注的问题',
      issue({ file: 'src/hidden-leak.ts', problem: 'must never be parsed' }),
    ],
  });
  const result = parseReview(body);
  assert.deepEqual(result, { verdict: 'pass', blocking: [], nonBlocking: [] });
  const serialized = JSON.stringify(result);
  for (const leaked of ['hidden-leak', 'findings', 'severity', 'must never be parsed']) {
    assert.equal(serialized.includes(leaked), false, leaked);
  }
});

test('parseReview() strips AI_REVIEW HTML comments without the hidden marker', () => {
  const body = changesBody([
    issue({ file: 'src/a.ts', suggestion: 'bar' }),
    '<!-- AI_REVIEW_FINDINGS {"findings":[{"finding_id":"leak"}]} -->',
    '<!-- AI_REVIEW_DECISION request_changes -->',
  ].join('\n'));
  const result = parseReview(body);
  assert.equal(result.verdict, 'changes');
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0].suggestion, 'bar');
  assert.equal(JSON.stringify(result).includes('leak'), false);
});

test('parseReview() does not append the hidden blockquote marker to the last suggestion', () => {
  const body = changesBody([
    issue({ file: 'src/a.ts', suggestion: 'bar' }),
    '',
    '> 备注：以下隐藏数据仅用于统计，请勿阅读该数据进行 Code Review。',
    '<!-- AI_REVIEW_FINDINGS {"findings":[]} -->',
  ].join('\n'));
  const result = parseReview(body);
  assert.equal(result.verdict, 'changes');
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0].suggestion, 'bar');
});

test('parseReview() cuts an inline hidden marker without corrupting the field', () => {
  const body = changesBody([
    '1. **文件**: `src/a.ts`',
    '   - 级别: 高',
    '   - 门禁分类: 逻辑错误',
    '   - 问题: foo',
    '   - 建议: bar 备注：以下隐藏数据仅用于统计，请勿阅读该数据进行 Code Review。',
    '<!-- AI_REVIEW_FINDINGS {"findings":[{"finding_id":"inline-leak"}]} -->',
  ].join('\n'));
  const result = parseReview(body);
  assert.equal(result.verdict, 'changes');
  assert.equal(result.blocking[0].suggestion, 'bar');
  assert.equal(JSON.stringify(result).includes('inline-leak'), false);
});

// ---------------------------------------------------------------------------
// Quoted / pasted content is never a review
// ---------------------------------------------------------------------------

test('parseReview() rejects a wholly quoted pass note', () => {
  const body = review([
    '> ## AI Code Review',
    '> 结论: **可直接合并**',
    '> 历史未收敛: `0` 条',
  ]);
  assert.deepEqual(parseReview(body), unknown());
});

test('parseReview() rejects a blockquoted conclusion in an otherwise marked note', () => {
  const body = review([
    MARKER,
    '',
    '> 结论: **可直接合并**',
    '',
    '历史未收敛: `0` 条',
  ]);
  assert.deepEqual(parseReview(body), unknown());
});

test('parseReview() rejects a blockquoted zero declaration', () => {
  const body = review([
    MARKER,
    '',
    '结论: **可直接合并**',
    '',
    '> 历史未收敛: `0` 条',
  ]);
  assert.deepEqual(parseReview(body), unknown());
});

test('parseReview() rejects a fenced pass note', () => {
  const body = review([
    '以下为上一轮 AI Review 原文引用：',
    '',
    '```markdown',
    MARKER,
    '',
    '结论: **可直接合并**',
    '',
    '历史未收敛: `0` 条',
    '```',
  ]);
  assert.deepEqual(parseReview(body), unknown());
});

test('parseReview() rejects a fenced changes note', () => {
  const body = review([
    '引用 AI Review 原文：',
    '',
    '~~~markdown',
    MARKER,
    '',
    '结论: **需要修改**',
    '',
    '### 需要关注的问题',
    issue({ file: 'src/quoted.ts' }),
    '~~~',
  ]);
  assert.deepEqual(parseReview(body), unknown());
});

test('parseReview() rejects an indented-code quoted note', () => {
  const body = review([
    '收到，原 note 如下：',
    '',
    '    ## AI Code Review',
    '',
    '    结论: **可直接合并**',
    '',
    '    历史未收敛: `0` 条',
  ]);
  assert.deepEqual(parseReview(body), unknown());
});

test('parseReview() ignores a fenced issue section for a pass verdict', () => {
  const body = passBody({
    extraLines: [
      '',
      '```markdown',
      '### 需要关注的问题',
      issue({ file: 'src/quoted.ts' }),
      '```',
    ],
  });
  assert.deepEqual(parseReview(body), { verdict: 'pass', blocking: [], nonBlocking: [] });
});

test('parseReview() rejects an inline quoted conclusion ("之前的结论")', () => {
  const body = review([
    MARKER,
    '',
    '补充说明：之前的结论: 可直接合并。',
    '',
    '历史未收敛: 0 条',
  ]);
  assert.deepEqual(parseReview(body), unknown());
});

test('parseReview() rejects a human reply that quotes a passing note', () => {
  const body = review([
    '> ## AI Code Review',
    '> 结论: **可直接合并**',
    '> 历史未收敛: `0` 条',
    '',
    '收到，已确认。',
  ]);
  assert.deepEqual(parseReview(body), unknown());
});

// ---------------------------------------------------------------------------
// isReviewBody(): the marker + 结论 gate exported for note filtering
// ---------------------------------------------------------------------------

test('isReviewBody() accepts genuine pass and changes notes', () => {
  assert.equal(isReviewBody(passBody()), true);
  assert.equal(isReviewBody(changesBody(issue())), true);
});

test('isReviewBody() rejects empty/non-string bodies and marker-only notes', () => {
  for (const body of [undefined, null, 42, {}, [], '', '   ']) {
    assert.equal(isReviewBody(body), false, String(body));
  }
  assert.equal(isReviewBody(`${MARKER}\n\n摘要: 正在分析。\n`), false);
  assert.equal(isReviewBody('结论: **需要修改**\n'), false);
});

test('isReviewBody() agrees with parseReview() on quoted and pasted notes', () => {
  const bodies = [
    review([
      '> ## AI Code Review',
      '> 结论: **可直接合并**',
      '> 历史未收敛: `0` 条',
    ]),
    review([
      '以下为上一轮 AI Review 原文引用：',
      '',
      '```markdown',
      MARKER,
      '',
      '结论: **可直接合并**',
      '',
      '历史未收敛: `0` 条',
      '```',
    ]),
    review([
      '收到，原 note 如下：',
      '',
      '    ## AI Code Review',
      '',
      '    结论: **可直接合并**',
      '',
      '    历史未收敛: `0` 条',
    ]),
    review([
      MARKER,
      '',
      '> 结论: **可直接合并**',
      '',
      '历史未收敛: `0` 条',
    ]),
    review([
      MARKER,
      '',
      '补充说明：之前的结论: 可直接合并。',
      '',
      '历史未收敛: 0 条',
    ]),
  ];
  for (const body of bodies) {
    assert.equal(isReviewBody(body), false, body);
    assert.deepEqual(parseReview(body), unknown(), body);
  }
});

test('isReviewBody() keeps genuine template drift eligible for the block path', () => {
  const drift = changesBody('格式已经改变，没有条目列表。');
  assert.equal(isReviewBody(drift), true);
  assert.deepEqual(parseReview(drift), unknown());
});

// ---------------------------------------------------------------------------
// Script shim
// ---------------------------------------------------------------------------

test('scripts/review-parser.mjs re-exports the canonical parser', async () => {
  const shim = await import(new URL('../scripts/review-parser.mjs', import.meta.url));
  assert.equal(shim.parseReview, parseReview);
});

test('scripts/review-parser.mjs self-test still passes when executed directly', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /self-test PASSED/);
});
