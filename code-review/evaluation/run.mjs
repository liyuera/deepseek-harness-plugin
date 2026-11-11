/**
 * 离线评测管道：用固定 reviewer 输出 fixture 跑「规则加载 → prompt 构建 →
 * schema/证据校验 → 复验归并 → 渲染」，断言「该报的报、该拒的拒」。
 *
 * 不调用模型、不读私有仓库，可进 CI；模型质量评测另见 evaluation/README.md。
 * @module @liyuera/dsh-code-review/evaluation/run
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeFindings } from '../src/host/finalize.js'
import { buildPrompt } from '../src/host/reviewer.js'
import { composeRules, loadRulesResilient } from '../src/host/rules.js'
import { renderFindings } from '../src/host/render.js'
import { validateStructured } from '../src/host/structured.js'
import { validateSuppressions } from '../src/host/suppress.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CASES_DIR = join(ROOT, 'evaluation/cases')

const RULES = {
  rulesPath: join(ROOT, 'rules/rules.json'),
  principlesPath: join(ROOT, 'rules/principles.md'),
  packs: [
    join(ROOT, 'rules/packs/frontend-smartui.json'),
    join(ROOT, 'rules/packs/general-issues.json'),
  ],
}

const QUIET_CONFIG = {
  verify: 'off',
  evidenceMode: 'warn',
  coverageMode: 'warn',
  blockingSeverities: ['high', 'medium'],
  maxVerifiedFindings: 3,
  respectFixPolicy: true,
  manualFixGlobs: [],
  forbiddenFixGlobs: [],
}

class EvalError extends Error {}

const fail = (caseName, message) => {
  throw new EvalError(`[${caseName}] ${message}`)
}

const assert = (caseName, condition, message) => {
  if (!condition) fail(caseName, message)
}

/** 把 fixture 的 hunks 摊平成 reviewer prompt 需要的 file.text / 增删行数。 */
function promptFile(file) {
  const lines = (file.hunks ?? []).flatMap((hunk) => hunk.lines ?? [])
  return {
    path: file.path,
    added: lines.filter((line) => String(line).startsWith('+')).length,
    deleted: lines.filter((line) => String(line).startsWith('-')).length,
    text: (file.hunks ?? []).map((hunk) => (hunk.lines ?? []).join('\n')).join('\n'),
  }
}

/**
 * 复验 stub：按 fixture 给出的 verdict 序列依次返回 activation 结果。
 * `timeout` 用 `stopReason: 'incomplete'` 模拟，对应 verify.js 的「未证实」。
 */
function stubSubagents(caseName, verdicts) {
  let index = 0
  return {
    startActivation() {
      const verdict = verdicts[index]
      index += 1
      if (verdict === undefined) fail(caseName, '复验调用次数超出 fixture 的 verifier 序列')
      const structured = verdict === 'confirmed'
        ? { confirmed: true, reason: 'fixture: 缺陷可由代码直接证实。' }
        : verdict === 'rejected'
          ? { confirmed: false, reason: 'fixture: 该行为在上下文中有意为之，不构成缺陷。' }
          : undefined
      return {
        result: Promise.resolve(
          structured === undefined
            ? { stopReason: 'incomplete' }
            : { stopReason: 'completed', structured },
        ),
        dispose() {},
      }
    },
  }
}

const pick = (finding) => ({
  ruleId: finding.ruleId,
  severity: finding.severity,
  ...(finding.verified === undefined ? {} : { verified: finding.verified }),
  ...(finding.fixMode === undefined ? {} : { fixMode: finding.fixMode }),
  ...(finding.evidenceStatus === undefined ? {} : { evidenceStatus: finding.evidenceStatus }),
})

function compareFindings(caseName, label, actual, expected) {
  assert(caseName, actual.length === expected.length, `${label} 数量不符：期望 ${expected.length}，实际 ${actual.length}`)
  expected.forEach((wanted, index) => {
    const got = actual[index]
    for (const key of Object.keys(wanted)) {
      assert(
        caseName,
        got[key] === wanted[key],
        `${label}[${index}].${key} 期望 ${JSON.stringify(wanted[key])}，实际 ${JSON.stringify(got[key])}`,
      )
    }
  })
}

/**
 * 跑一整个 case。失败抛 EvalError（带 case 名）。
 * @param {object} caseData
 * @param {{rules:object[], principles:string}} loadedRules
 */
export async function runCase(caseData, loadedRules) {
  const name = caseData.name
  assert(name, '缺少 name')
  const files = caseData.files ?? []
  const allowedPaths = new Set(files.map((file) => file.path))
  const composed = composeRules({ ...loadedRules, filePaths: [...allowedPaths] })
  const config = { ...QUIET_CONFIG, ...(caseData.config ?? {}) }
  const expected = caseData.expected ?? {}

  // prompt 层：规则/文件必须真的进 prompt，避免「校验通过但没把上下文给模型」。
  const prompt = buildPrompt({
    rulesPrompt: composed.prompt,
    files: files.map(promptFile),
    skipped: [],
  })
  for (const needle of expected.promptContains ?? []) {
    assert(name, prompt.includes(needle), `prompt 缺少 ${JSON.stringify(needle)}`)
  }

  const validated = validateStructured(caseData.reviewer, {
    allowedRuleIds: composed.allowedRuleIds,
    allowedPaths,
    ruleSeverities: composed.ruleSeverities,
    evidenceContext: { mode: caseData.mode ?? 'turn', files },
    evidenceMode: config.evidenceMode,
    coverageMode: config.coverageMode,
  })
  assert(name, validated.ok === expected.ok, `validateStructured.ok 期望 ${expected.ok}，实际 ${validated.ok}`)
  if (validated.ok !== true) {
    assert(
      name,
      validated.reason === expected.reason,
      `拒绝原因期望 ${expected.reason}，实际 ${validated.reason}`,
    )
    return { name, ok: true }
  }

  const final = await finalizeFindings({
    findings: validated.findings,
    evidence: validated.evidence,
    ruleFixModes: composed.ruleFixModes,
    ruleBlocking: composed.ruleBlocking,
    config,
    suppressions: validateSuppressions(caseData.suppressions ?? []),
    files,
    subagents: stubSubagents(name, caseData.verifier ?? []),
    agent: {},
    preset: 'code-review',
    logger: undefined,
  })

  if (expected.verification !== undefined) {
    for (const key of Object.keys(expected.verification)) {
      assert(
        name,
        final.verification[key] === expected.verification[key],
        `verification.${key} 期望 ${expected.verification[key]}，实际 ${final.verification[key]}`,
      )
    }
  }
  if (expected.kept !== undefined) compareFindings(name, 'kept', final.findings.map(pick), expected.kept)
  if (expected.keptLength !== undefined) {
    assert(name, final.findings.length === expected.keptLength, `kept 数量期望 ${expected.keptLength}，实际 ${final.findings.length}`)
  }
  for (const ruleId of expected.dropped ?? []) {
    assert(name, !final.findings.some((finding) => finding.ruleId === ruleId), `${ruleId} 应被丢弃但仍保留`)
  }
  if (expected.suppressed !== undefined) {
    compareFindings(
      name,
      'suppressed',
      final.suppressed.map((entry) => entry.finding),
      expected.suppressed,
    )
    for (const [index, entry] of final.suppressed.entries()) {
      const wantedReason = expected.suppressedReasons?.[index]
      if (wantedReason !== undefined) {
        assert(name, entry.reason === wantedReason, `suppressed[${index}].reason 不符`)
      }
    }
  }
  if (expected.coverage !== undefined) {
    for (const key of Object.keys(expected.coverage)) {
      assert(
        name,
        validated.coverage[key] === expected.coverage[key],
        `coverage.${key} 期望 ${JSON.stringify(expected.coverage[key])}，实际 ${JSON.stringify(validated.coverage[key])}`,
      )
    }
  }

  const rendered = renderFindings({
    findings: final.findings,
    skipped: [],
    blockingSeverities: config.blockingSeverities,
    notifySeverities: [],
    summary: { files: files.length, added: 1, deleted: 0 },
    mode: 'report',
    coverage: validated.coverage,
    suppressed: final.suppressed,
    respectFixPolicy: config.respectFixPolicy,
  })
  if (expected.renderEmpty === true) {
    assert(name, rendered === '', `报告期望为空，实际：\n${rendered}`)
  }
  for (const needle of expected.renderContains ?? []) {
    assert(name, rendered.includes(needle), `报告缺少 ${JSON.stringify(needle)}：\n${rendered}`)
  }
  for (const needle of expected.renderExcludes ?? []) {
    assert(name, !rendered.includes(needle), `报告不应包含 ${JSON.stringify(needle)}：\n${rendered}`)
  }
  return { name, ok: true, findings: final.findings.length, rendered }
}

/**
 * 跑整个语料目录。
 * @returns {Promise<{total:number, passed:number, failed:number, cases:object[], failures:Array<{name:string,error:string}>}>}
 */
export async function runCorpus({ casesDir = CASES_DIR } = {}) {
  const loadedRules = await loadRulesResilient({ ...RULES })
  const entries = (await readdir(casesDir)).filter((entry) => entry.endsWith('.json')).sort()
  const cases = []
  const failures = []
  for (const entry of entries) {
    const caseData = JSON.parse(await readFile(join(casesDir, entry), 'utf8'))
    try {
      cases.push(await runCase(caseData, loadedRules))
    } catch (error) {
      const message = error instanceof EvalError ? error.message : `${entry}: ${error.stack ?? error.message}`
      failures.push({ name: caseData.name ?? entry, error: message })
      cases.push({ name: caseData.name ?? entry, ok: false, error: message })
    }
  }
  return {
    total: cases.length,
    passed: cases.filter((item) => item.ok === true).length,
    failed: failures.length,
    cases,
    failures,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const json = process.argv.includes('--json')
  const report = await runCorpus()
  if (json) {
    process.stdout.write(`${JSON.stringify({ total: report.total, passed: report.passed, failed: report.failed, failures: report.failures }, null, 2)}\n`)
  } else {
    for (const item of report.cases) {
      process.stdout.write(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.ok ? '' : `\n      ${item.error}`}\n`)
    }
    process.stdout.write(`\n${report.passed}/${report.total} cases passed\n`)
  }
  if (report.failed > 0) process.exitCode = 1
}
