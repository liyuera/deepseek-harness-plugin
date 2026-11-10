import test from 'node:test'
import assert from 'node:assert/strict'
import { createReviewerGuard } from '../src/host/guard.js'

const guard = createReviewerGuard('code-review')

const reviewer = (name) => ({ name, agent: { session: { header: { agentPreset: 'code-review' } } } })

/** 断言该工具被拒绝，且原因包含预设 id 与工具名。 */
function assertDenied(name) {
  const reason = guard(reviewer(name))
  assert.equal(typeof reason, 'string', `${name} 应被拒绝`)
  assert.match(reason, /审查者（code-review）只读/, `${reason} 应使用配置的预设 id`)
  assert.match(reason, new RegExp(name), `${reason} 应包含 ${name}`)
}

test('审查者预设下，写类工具被拒绝', () => {
  assertDenied('write')
  assertDenied('edit')
  assertDenied('bash')
  assertDenied('apply_patch')
  assertDenied('applyPatch')
  assertDenied('str_replace_editor')
  assertDenied('pwsh')
})

test('审查者预设下，委派与工作树工具被拒绝', () => {
  assertDenied('subagent')
  assertDenied('subagent_fork')
  assertDenied('workflow')
  assertDenied('create_worktree')
  assertDenied('jobs')
})

test('拒绝消息使用配置的预设 id', () => {
  assert.equal(guard(reviewer('bash')), 'code-review: 审查者（code-review）只读，bash 被拒绝')
  const other = createReviewerGuard('reviewer-x')
  assert.equal(
    other({ name: 'write', agent: { session: { header: { agentPreset: 'reviewer-x' } } } }),
    'code-review: 审查者（reviewer-x）只读，write 被拒绝',
  )
})

test('审查者预设下，只读工具放行', () => {
  for (const name of ['read', 'grep', 'glob', 'structured_output']) {
    assert.equal(guard(reviewer(name)), undefined, `${name} 应放行`)
  }
})

test('其他预设的可变工具放行', () => {
  assert.equal(guard({ name: 'bash', agent: { session: { header: { agentPreset: 'default' } } } }), undefined)
})

test('缺少 session/header 的 agent 放行', () => {
  assert.equal(guard({ name: 'bash', agent: {} }), undefined)
  assert.equal(guard({ name: 'bash', agent: { session: {} } }), undefined)
  assert.equal(guard({ name: 'bash', agent: { session: { header: {} } } }), undefined)
})

test('没有 agent 的 exec 放行', () => {
  assert.equal(guard({ name: 'bash' }), undefined)
  assert.equal(guard({}), undefined)
})
