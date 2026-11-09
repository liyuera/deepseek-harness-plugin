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
 *     and edge `-` trimmed; a missing/blank version is `invalid-version` (no
 *     `V0.0.0` fallback);
 *   - an explicit `family` option or a `hot-`/`feat-` personal-branch override
 *     selects the family; an explicit family that contradicts the override
 *     prefix is `invalid-family`; otherwise the ticket type decides (the
 *     `FAILURE` typeKey check is a documented best-effort legacy hint);
 *   - `override.personalBranch`/`override.targetBranch` are honoured after
 *     safety validation; a personal-only override derives the target from the
 *     personal branch name and must end in `-<branchUser>`;
 *   - `BranchError` carries a static `code` and a static message (never the
 *     rejected input, which may contain control characters).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BRANCH_LENGTH_LIMIT,
  BRANCH_USER_LENGTH_LIMIT,
  VERSION_LENGTH_LIMIT,
  BranchError,
  deriveBranches,
  isSafeBranchName,
  sanitizeVersion,
  ticketBranchName,
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

test('a FAILURE-containing typeKey is a documented best-effort failure hint', () => {
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

test('an explicit family that contradicts the personal override is invalid-family', () => {
  expectBranchError(
    () => deriveBranches({
      versionName: 'V2.0.0',
      ticketType: '需求',
      branchUser: 'ly',
      family: 'feat',
      override: { personalBranch: 'hot-V2.0.0-ly' },
    }),
    'invalid-family',
  );
  expectBranchError(
    () => deriveBranches({
      versionName: 'V2.0.0',
      ticketType: '缺陷',
      branchUser: 'ly',
      family: 'hot',
      override: { personalBranch: 'feat-V2.0.0-ly' },
    }),
    'invalid-family',
  );
  // Explicit target does not make the contradictory personal branch valid.
  expectBranchError(
    () => deriveBranches({
      versionName: 'V2.0.0',
      ticketType: '需求',
      branchUser: 'ly',
      family: 'feat',
      override: { personalBranch: 'hot-V2.0.0-ly', targetBranch: 'hotfix-V2.0.0' },
    }),
    'invalid-family',
  );

  // A matching explicit family plus override is allowed and keeps the target
  // derivation rule.
  const consistent = deriveBranches({
    versionName: 'V2.0.0',
    ticketType: '需求',
    branchUser: 'ly',
    family: 'hot',
    override: { personalBranch: 'hot-custom-ly' },
  });
  assert.equal(consistent.family, 'hot');
  assert.equal(consistent.personalBranch, 'hot-custom-ly');
  assert.equal(consistent.targetBranch, 'hotfix-custom');
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

test('a missing or blank version is rejected as invalid-version (no fallback)', () => {
  for (const versionName of ['', '   ', '版本', null, undefined, 12]) {
    expectBranchError(
      () => deriveBranches({ versionName, ticketType: '缺陷', branchUser: 'ly' }),
      'invalid-version',
    );
  }

  // The sanitizer itself still returns ''; deriveBranches is what rejects it.
  assert.equal(sanitizeVersion(''), '');
  assert.equal(sanitizeVersion(undefined), '');
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

test('target derivation requires the personal branch to end with -<branchUser>', () => {
  // A different user's suffix must not leak into the target branch.
  for (const personalBranch of [
    'feat-V1.6.1-lisi',
    'hot-V1.6.1-lisi',
    'feat-custom',
    'release/x',
  ]) {
    expectBranchError(
      () => deriveBranches({
        versionName: 'V1.6.1',
        ticketType: '需求',
        branchUser: 'ly',
        override: { personalBranch },
      }),
      'invalid-branch',
    );
  }

  // Only the exact trailing `-<branchUser>` is stripped.
  const result = deriveBranches({
    versionName: 'V1.6.1',
    ticketType: '需求',
    branchUser: 'ly',
    override: { personalBranch: 'feat-V1.6.1-lisi-ly' },
  });
  assert.equal(result.personalBranch, 'feat-V1.6.1-lisi-ly');
  assert.equal(result.targetBranch, 'feature-V1.6.1-lisi');
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

test('ticketBranchName derives the deterministic ticket-scoped fallback', () => {
  assert.equal(
    ticketBranchName('feat-V1.6.1.20261109-ly', 'YGFNXDJRFWDJSYJJYY-648'),
    'feat-V1.6.1.20261109-ly-648',
  );
  assert.equal(ticketBranchName('hot-V1.0.0-zhangsan', 'BUG-1'), 'hot-V1.0.0-zhangsan-1');
  assert.equal(ticketBranchName('feat-x', '  BUG-007  '), 'feat-x-007');
});

test('ticketBranchName refuses input that cannot form a legal ref', () => {
  assert.equal(ticketBranchName('feat-x', ''), undefined);
  assert.equal(ticketBranchName('feat-x', '---'), undefined);
  assert.equal(ticketBranchName('', '648'), undefined);
  assert.equal(ticketBranchName(undefined, '648'), undefined);
  assert.equal(ticketBranchName('feat-..', '648'), undefined);
  // A branch over the git limit must not be produced by the fallback.
  assert.equal(ticketBranchName(`feat-${'a'.repeat(200)}`, '648'), undefined);
});
