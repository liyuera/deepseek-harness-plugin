// mr-loop/test/parse-gates.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSensitiveGate, parseMandatoryGate } from '../src/host/parse-gates.js'

const BLOCKED = `Sensitive Content Gate

结论: 阻止合并

扫描结果：共 15 条命中；历史豁免 0 条；当前有效 15 条（高 3、中 1、低 11）。 阻断项：3 条（阻断级别：high）。
`
const PASSED = `Sensitive Content Gate

结论: 门禁通过

扫描结果：共 15 条命中；历史豁免 15 条；当前有效 0 条。
`
const SAME = `Sensitive Content Gate

本次扫描结果与最近一次完整结果一致，详情见 #note_74592。
`

// 真实模板（MR !241 note 75129）：标题写风险，正文写门禁通过，没有阻断项行。
const LOW_RISK_PASS = `## Sensitive Content Gate

结论: **发现敏感信息风险**

扫描结果：共 4 条命中；历史豁免 0 条；当前有效 4 条（高 0、中 0、低 4）。
本次没有达到阻断级别的命中，门禁通过。

命中位置与整改建议：
- [low] assets/foo.png：示例

安全说明：...
`

// 近似模板：同样的标题，正文没有门禁通过，且有阻断项 → 必须判 block。
const LOW_RISK_BLOCKED = `## Sensitive Content Gate

结论: **发现敏感信息风险**

扫描结果：共 4 条命中；历史豁免 0 条；当前有效 4 条（高 0、中 0、低 4）。
阻断项：2 条（阻断级别：medium）。
`

const MANDATORY = `必过项完整性检查

结论：阻止合并

敏感信息门禁：未通过；AI 代码评审：未通过；AI 评审证据检查：未通过
`

test('敏感门禁：阻止 / 通过 / 只有一致性说明', () => {
  const blocked = parseSensitiveGate(BLOCKED)
  assert.equal(blocked.verdict, 'block')
  assert.equal(blocked.total, 15)
  assert.equal(blocked.waived, 0)
  assert.equal(blocked.effective, 15)
  assert.equal(blocked.blocking, 3)

  const passed = parseSensitiveGate(PASSED)
  assert.equal(passed.verdict, 'pass')
  assert.equal(passed.effective, 0)

  const same = parseSensitiveGate(SAME)
  assert.equal(same.verdict, 'unknown')
  assert.equal(same.total, null)
})

test('敏感门禁：发现敏感信息风险 + 正文门禁通过 = 通过（真实模板）', () => {
  const result = parseSensitiveGate(LOW_RISK_PASS)
  assert.equal(result.verdict, 'pass')
  assert.equal(result.total, 4)
  assert.equal(result.waived, 0)
  assert.equal(result.effective, 4)
  assert.equal(result.blocking, null)
})

test('敏感门禁：发现敏感信息风险 + 阻断项 = 阻止', () => {
  const result = parseSensitiveGate(LOW_RISK_BLOCKED)
  assert.equal(result.verdict, 'block')
  assert.equal(result.blocking, 2)
  assert.equal(result.effective, 4)
})

test('敏感门禁：发现敏感信息风险按命中数兜底，数字全无仍不猜', () => {
  const effectiveOnly = parseSensitiveGate(`## Sensitive Content Gate

结论: **发现敏感信息风险**

扫描结果：共 4 条命中；历史豁免 0 条；当前有效 4 条。
`)
  assert.equal(effectiveOnly.verdict, 'block')
  assert.equal(effectiveOnly.blocking, null)

  const noNumbers = parseSensitiveGate(`## Sensitive Content Gate

结论: **发现敏感信息风险**

详情见 #note_1。
`)
  assert.equal(noNumbers.verdict, 'unknown')
})

test('必过项：三项子结论', () => {
  const result = parseMandatoryGate(MANDATORY)
  assert.equal(result.verdict, 'block')
  assert.deepEqual(result.items, { sensitive: '未通过', review: '未通过', evidence: '未通过' })
})

test('空 / 乱正文不猜', () => {
  assert.equal(parseSensitiveGate('').verdict, 'unknown')
  assert.equal(parseMandatoryGate('随便写点').verdict, 'unknown')
  assert.equal(parseMandatoryGate('结论：通过').items.sensitive, null)
})
