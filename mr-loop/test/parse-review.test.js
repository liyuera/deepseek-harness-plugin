import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseReview, isReviewBody } from '../src/host/parse-review.js'

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

test('需要修改的 note → changes + 阻塞/非阻塞分组 + 复验次数', () => {
  const result = parseReview(fixture('review-needs-fix.md'))
  assert.equal(result.verdict, 'changes')
  assert.equal(result.blocking.length, 1)
  assert.equal(result.nonBlocking.length, 1)
  assert.equal(result.blocking[0].fid, 'aaaaaaaaaa')
  assert.equal(result.blocking[0].level, '中')
  assert.equal(result.blocking[0].reverifyCount, 1)
  assert.match(result.blocking[0].location, /useExampleForm\.ts:100-120/)
})

test('可直接合并的 note → pass，历史未收敛项归非阻塞', () => {
  const result = parseReview(fixture('review-pass.md'))
  assert.equal(result.verdict, 'pass')
  assert.equal(result.blocking.length, 0)
  assert.equal(result.nonBlocking.length, 1)
})

test('引用别人结论的回复不算评审', () => {
  const quoted = fixture('review-pass.md').split('\n').map((line) => `> ${line}`).join('\n')
  assert.equal(parseReview(quoted).verdict, 'unknown')
  assert.equal(isReviewBody(quoted), false)
})

test('复验次数：缺失 / 0 / 非数字三种边界', () => {
  const body = (field) => `## AI Code Review (a -> b)\n\n结论: **需要修改**\n\n### 需要关注的问题\n1. **文件**: \`x.ts\`\n   - FID: \`ff\`\n${field}   - 级别: 中\n   - 问题: boom\n`
  assert.equal(parseReview(body('')).blocking[0].reverifyCount, null)
  assert.equal(parseReview(body('   - 复验次数: \`0\`\n')).blocking[0].reverifyCount, 0)
  assert.equal(parseReview(body('   - 复验次数: \`abc\`\n')).blocking[0].reverifyCount, null)
})

test('坏输出一律 unknown，不猜', () => {
  assert.deepEqual(parseReview(''), { verdict: 'unknown', blocking: [], nonBlocking: [] })
  assert.equal(parseReview('AI Code Review\n结论: 需要修改').verdict, 'unknown')
  assert.equal(parseReview('AI Code Review\n结论: 新格式结论').verdict, 'unknown')
  assert.equal(isReviewBody('AI Code Review\n\n结论: 可直接合并'), true)
})

test('reviewMarker 可配置：标记改名后可解析，默认标记下仍是 unknown', () => {
  const body = 'AI Review\n\n结论: 可直接合并\n\n历史未收敛: 0 条'
  assert.equal(parseReview(body, { marker: 'AI Review' }).verdict, 'pass')
  assert.equal(isReviewBody(body, { marker: 'AI Review' }), true)
  assert.equal(parseReview(body).verdict, 'unknown')
  assert.equal(isReviewBody(body), false)
  // 空 marker 不能 fail-open 成「任意结论行都是评审」。
  assert.equal(isReviewBody('结论: 可直接合并', { marker: '' }), false)
})
