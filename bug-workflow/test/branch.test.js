/**
 * Contract tests for the pure branch derivation rules (P4 Task 1).
 *
 * Inputs come from a synced ticket (`versionName`/`type`/`typeKey`) plus the
 * workspace setting `branchUser`; nothing here touches the filesystem or git.
 * The tests pin the rules from design spec §8.3:
 *
 *   - feature tickets:   feat-<X>-<user>  -> feature-<X>
 *   - failure tickets:   hot-<X>-<user>   -> hotfix-<X>
 *   - X is `versionName` filtered to `[A-Za-z0-9._-]`, repeated `-` collapsed
 *     and edge `-` trimmed; an empty result falls back to `V0.0.0`;
 *   - an explicit `family` option or a `hot-`/`feat-` personal-branch override
 *     selects the family; otherwise the ticket type decides;
 *   - `override.personalBranch`/`override.targetBranch` are honoured after
 *     safety validation; a personal-only override keeps the spec rule that the
 *     target is derived from the personal branch name;
 *   - `BranchError` carries a static `code` and a static message (never the
 *     rejected input, which may contain control characters).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRANCH_LENGTH_LIMIT,
  BRANCH_USER_LENGTH_LIMIT,
  DEFAULT_VERSION,
  VERSION_LENGTH_LIMIT,
  BranchError,
  deriveBranches,
  isSafeBranchName,
  sanitizeVersion,
} from '../src/host/branch.js';

/** Assert that `fn` throws a `BranchError` with the expected static code. */
function expectBranchError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof BranchError, `expected BranchError, got ${error?.name}`);
    assert.equal(error.name, 'BranchError');
    assert.equal(error.code, code);
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0);
    // Static messages must never echo the rejected value (which can contain
    // secrets-shaped or control characters in a platform field).
    assert.ok(!error.message.includes('\n'));
    assert.ok(!error.message.includes('\u0000'));
    return true;
  });
}

test('normal ticket derives feat-<X>-<user> / feature-<X>', () => {
  const result = deriveBranches({
    versionName: 'V1.6.1.20261109',
    ticketType: '缺陷',
    branchUser: 'ly',
  });

  assert.deepEqual(result, {
    personalBranch: 'feat-V1.6.1.20261109-ly',
    targetBranch: 'feature-V1.6.1.20261109',
    family: 'feat',
    baseHint: 'feature-V1.6.1.20261109',
  });
});

test('failure ticket uses the hot prefix and hotfix target', () => {
  const result = deriveBranches({
    versionName: 'V1.6.1.20261109',
    ticketType: '故障',
    branchUser: 'zhangsan',
  });

  assert.equal(result.family, 'hot');
  assert.equal(result.personalBranch, 'hot-V1.6.1.20261109-zhangsan');
  assert.equal(result.targetBranch, 'hotfix-V1.6.1.20261109');
  assert.equal(result.baseHint, result.targetBranch);
});

test('a FAILURE typeKey is treated as a failure ticket too', () => {
  const result = deriveBranches({
    versionName: 'V1.0.0',
    ticketType: '缺陷',
    typeKey: '001_FAILURE',
    branchUser: 'ly',
  });
  assert.equal(result.family, 'hot');
  assert.equal(result.personalBranch, 'hot-V1.0.0-ly');
  assert.equal(result.targetBranch, 'hotfix-V1.0.0');
});

test('explicit family option overrides ticket-type detection', () => {
  const hot = deriveBranches({
    versionName: 'V2.0.0',
    ticketType: '需求',
    branchUser: 'ly',
    family: 'hot',
  });
  assert.equal(hot.family, 'hot');
  assert.equal(hot.personalBranch, 'hot-V2.0.0-ly');
  assert.equal(hot.targetBranch, 'hotfix-V2.0.0');

  const feat = deriveBranches({
    versionName: 'V2.0.0',
    ticketType: '故障',
    branchUser: 'ly',
    family: 'feat',
  });
  assert.equal(feat.family, 'feat');
  assert.equal(feat.personalBranch, 'feat-V2.0.0-ly');
  assert.equal(feat.targetBranch, 'feature-V2.0.0');

  expectBranchError(
    () => deriveBranches({ versionName: 'V2.0.0', ticketType: '需求', branchUser: 'ly', family: 'release' }),
    'invalid-family',
  );
});

test('a personal-branch override with a hot prefix selects the hot family and target', () => {
  const result = deriveBranches({
    versionName: 'V1.6.1',
    ticketType: '缺陷',
    branchUser: 'ly',
    override: { personalBranch: 'hot-V1.6.1-ly' },
  });

  assert.equal(result.family, 'hot');
  assert.equal(result.personalBranch, 'hot-V1.6.1-ly');
  assert.equal(result.targetBranch, 'hotfix-V1.6.1');
  assert.equal(result.baseHint, 'hotfix-V1.6.1');
});

test('illegal version characters become single dashes and edge dashes are trimmed', () => {
  assert.equal(sanitizeVersion('V1.6.1 / 20261109'), 'V1.6.1-20261109');
  assert.equal(sanitizeVersion('版本 V1.2.0'), 'V1.2.0');
  assert.equal(sanitizeVersion('--V1..2--'), 'V1..2');
  assert.equal(sanitizeVersion('V1__2'), 'V1__2');
  assert.equal(sanitizeVersion(''), '');
  assert.equal(sanitizeVersion(undefined), '');
  assert.equal(sanitizeVersion(42), '');

  const result = deriveBranches({
    versionName: 'V1.6.1 / 20261109',
    ticketType: '优化',
    branchUser: 'ly',
  });
  assert.equal(result.personalBranch, 'feat-V1.6.1-20261109-ly');
  assert.equal(result.targetBranch, 'feature-V1.6.1-20261109');
});

test('an empty or non-string version falls back to V0.0.0', () => {
  assert.equal(DEFAULT_VERSION, 'V0.0.0');
  for (const versionName of ['', '   ', '版本', null, undefined, 12]) {
    const result = deriveBranches({ versionName, ticketType: '缺陷', branchUser: 'ly' });
    assert.equal(result.personalBranch, 'feat-V0.0.0-ly');
    assert.equal(result.targetBranch, 'feature-V0.0.0');
  }
});

test('a version that cannot form a legal branch is rejected as invalid-version', () => {
  expectBranchError(
    () => deriveBranches({ versionName: 'V1..2', ticketType: '缺陷', branchUser: 'ly' }),
    'invalid-version',
  );
  expectBranchError(
    () => deriveBranches({ versionName: '.hidden', ticketType: '缺陷', branchUser: 'ly' }),
    'invalid-version',
  );
  expectBranchError(
    () => deriveBranches({ versionName: 'V1.', ticketType: '缺陷', branchUser: 'ly' }),
    'invalid-version',
  );
  expectBranchError(
    () => deriveBranches({ versionName: 'V1.lock', ticketType: '缺陷', branchUser: 'ly' }),
    'invalid-version',
  );
  expectBranchError(
    () => deriveBranches({
      versionName: 'V' + '1'.repeat(VERSION_LENGTH_LIMIT),
      ticketType: '缺陷',
      branchUser: 'ly',
    }),
    'invalid-version',
  );
});

test('branchUser must be non-empty and a safe single ref component', () => {
  for (const branchUser of [undefined, null, '', '   ', 42, 'ly zhang', 'ly/zhang', 'ly\tzhang']) {
    expectBranchError(
      () => deriveBranches({ versionName: 'V1.0.0', ticketType: '缺陷', branchUser }),
      'invalid-branch-user',
    );
  }

  expectBranchError(
    () => deriveBranches({ versionName: 'V1.0.0', ticketType: '缺陷', branchUser: '-ly' }),
    'invalid-branch-user',
  );
  expectBranchError(
    () => deriveBranches({ versionName: 'V1.0.0', ticketType: '缺陷', branchUser: 'ly..zhang' }),
    'invalid-branch-user',
  );
  expectBranchError(
    () => deriveBranches({ versionName: 'V1.0.0', ticketType: '缺陷', branchUser: 'ly.' }),
    'invalid-branch-user',
  );
  expectBranchError(
    () => deriveBranches({ versionName: 'V1.0.0', ticketType: '缺陷', branchUser: '张三' }),
    'invalid-branch-user',
  );
  expectBranchError(
    () => deriveBranches({
      versionName: 'V1.0.0',
      ticketType: '缺陷',
      branchUser: 'a'.repeat(BRANCH_USER_LENGTH_LIMIT + 1),
    }),
    'invalid-branch-user',
  );

  // Surrounding whitespace is normalized rather than echoed into the branch.
  const result = deriveBranches({ versionName: 'V1.0.0', ticketType: '缺陷', branchUser: '  ly  ' });
  assert.equal(result.personalBranch, 'feat-V1.0.0-ly');

  // Technical account-style names are still legal ref components.
  const dotted = deriveBranches({
    versionName: 'V1.0.0',
    ticketType: '缺陷',
    branchUser: 'zhang.san_01',
  });
  assert.equal(dotted.personalBranch, 'feat-V1.0.0-zhang.san_01');
});

test('explicit personal and target overrides are validated and kept', () => {
  const result = deriveBranches({
    versionName: 'V9.9.9',
    ticketType: '需求',
    branchUser: 'ly',
    override: {
      personalBranch: 'feat-custom-ly',
      targetBranch: 'feature-custom',
    },
  });

  assert.deepEqual(result, {
    personalBranch: 'feat-custom-ly',
    targetBranch: 'feature-custom',
    family: 'feat',
    baseHint: 'feature-custom',
  });

  // A personal-only override keeps the spec rule: target follows branch name.
  const personalOnly = deriveBranches({
    versionName: 'V9.9.9',
    ticketType: '需求',
    branchUser: 'ly',
    override: { personalBranch: 'feat-custom-ly' },
  });
  assert.equal(personalOnly.personalBranch, 'feat-custom-ly');
  assert.equal(personalOnly.targetBranch, 'feature-custom');

  // A target-only override keeps the derived personal branch.
  const targetOnly = deriveBranches({
    versionName: 'V9.9.9',
    ticketType: '缺陷',
    branchUser: 'ly',
    override: { targetBranch: 'feature-hotfix-branch' },
  });
  assert.equal(targetOnly.personalBranch, 'feat-V9.9.9-ly');
  assert.equal(targetOnly.targetBranch, 'feature-hotfix-branch');
  assert.equal(targetOnly.baseHint, 'feature-hotfix-branch');

  // Overrides are trimmed and slash-nested target branches stay legal.
  const trimmed = deriveBranches({
    versionName: 'V9.9.9',
    ticketType: '需求',
    branchUser: 'ly',
    override: { personalBranch: '  feat-custom-ly  ', targetBranch: ' release/feature-custom ' },
  });
  assert.equal(trimmed.personalBranch, 'feat-custom-ly');
  assert.equal(trimmed.targetBranch, 'release/feature-custom');
});

test('unsafe branch overrides are rejected', () => {
  const invalid = [
    '',
    '   ',
    '-feat-x',
    'feat..x',
    'feat x',
    'feat/x/',
    'feat//x',
    '/feat-x',
    'feat-x/',
    'feat/.x',
    'feat/x.',
    'feat/x.lock',
    'feat@{x',
    'feat\u0000x',
    'feat\nx',
    'a'.repeat(BRANCH_LENGTH_LIMIT + 1),
  ];

  for (const name of invalid) {
    assert.equal(isSafeBranchName(name), false, `expected unsafe: ${JSON.stringify(name)}`);
    expectBranchError(
      () => deriveBranches({
        versionName: 'V1.0.0',
        ticketType: '需求',
        branchUser: 'ly',
        override: { personalBranch: name },
      }),
      'invalid-branch',
    );
    expectBranchError(
      () => deriveBranches({
        versionName: 'V1.0.0',
        ticketType: '需求',
        branchUser: 'ly',
        override: { targetBranch: name },
      }),
      'invalid-branch',
    );
  }

  assert.equal(isSafeBranchName('feat-' + 'a'.repeat(BRANCH_LENGTH_LIMIT - 5)), true);

  for (const override of ['feat-x', 42, [], { personalBranch: 42 }, { targetBranch: null }]) {
    if (override && typeof override === 'object' && !Array.isArray(override) && override.targetBranch === null) {
      // null means "not provided" and is accepted by design.
      continue;
    }
    expectBranchError(
      () => deriveBranches({ versionName: 'V1.0.0', ticketType: '需求', branchUser: 'ly', override }),
      'invalid-branch',
    );
  }
});

test('deriveBranches does not mutate its input', () => {
  const input = {
    versionName: 'V1.0.0',
    ticketType: '故障',
    branchUser: 'ly',
    override: { personalBranch: 'hot-V1.0.0-ly' },
  };
  const snapshot = structuredClone(input);

  deriveBranches(input);

  assert.deepEqual(input, snapshot);
});
