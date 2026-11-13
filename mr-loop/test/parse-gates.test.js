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
