#!/usr/bin/env node
/**
 * Self-test entry point for the AI Code Review parser.
 *
 * The parser itself moved to the dependency-free canonical host module
 * `../src/host/review-parser.js` in P5. This script is a thin shim: it
 * re-exports `parseReview` (so `scripts/probe-gitlab.mjs` and older callers
 * keep working) and keeps the P0 self-test harness, including the edge-case
 * table, runnable without the host:
 *
 *   node bug-workflow/scripts/review-parser.mjs
 *
 * It prints the parsed fixtures and exits non-zero on a regression.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseReview } from '../src/host/review-parser.js';

export { parseReview };

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
      label: 'fenced pass note -> unknown',
      body:
        '以下为上一轮 AI Review 原文引用：\n\n' +
        '```markdown\n## AI Code Review\n\n结论: **可直接合并**\n\n历史未收敛: `0` 条\n```\n',
      expected: { verdict: 'unknown' },
    },
    {
      label: 'fenced changes note -> unknown',
      body:
        '引用 AI Review 原文：\n\n' +
        '~~~markdown\n## AI Code Review\n\n结论: **需要修改**\n\n' +
        '### 需要关注的问题\n1. **文件**: `src/quoted.ts`\n   - 级别: 高\n   - 门禁分类: 逻辑错误\n   - 问题: quoted blocking problem\n~~~\n',
      expected: { verdict: 'unknown' },
    },
    {
      label: 'indented-code quoted note -> unknown',
      body:
        '收到，原 note 如下：\n\n' +
        '    ## AI Code Review\n\n    结论: **可直接合并**\n\n    历史未收敛: `0` 条\n',
      expected: { verdict: 'unknown' },
    },
    {
      label: 'inline "之前的结论" does not authorize pass -> unknown',
      body:
        '## AI Code Review\n\n补充说明：之前的结论: 可直接合并。\n\n' +
        '历史未收敛: 0 条\n',
      expected: { verdict: 'unknown' },
    },
    {
      label: 'fenced section is not parsed as own issues -> pass',
      body:
        '## AI Code Review\n\n结论: **可直接合并**\n\n历史未收敛: `0` 条\n\n' +
        '```markdown\n### 需要关注的问题\n1. **文件**: `src/quoted.ts`\n   - 级别: 高\n' +
        '   - 门禁分类: 逻辑错误\n   - 问题: quoted blocking problem\n```\n',
      expected: { verdict: 'pass', blocking: 0, nonBlocking: 0 },
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
