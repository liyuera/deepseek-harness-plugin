import assert from 'node:assert/strict'
import test from 'node:test'
import { runCorpus } from '../evaluation/run.mjs'

test('离线评测语料全部按预期：该报的报、该拒的拒', async () => {
  const report = await runCorpus()
  const failed = report.failures.map((item) => item.error).join('\n')
  assert.equal(report.failed, 0, `评测失败 ${report.failed}/${report.total}:\n${failed}`)
  assert.ok(report.total >= 10, `语料应至少覆盖 10 个场景，实际 ${report.total}`)
})
