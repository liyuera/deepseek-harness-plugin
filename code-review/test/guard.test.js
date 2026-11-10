import test from 'node:test'
import assert from 'node:assert/strict'
import { MUTATING_TOOLS, createReviewerGuard } from '../src/host/guard.js'

const guard = createReviewerGuard('code-review')

const reviewer = (name) => ({ name, agent: { session: { header: { agentPreset: 'code-review' } } } })

test('审查者预设下，所有可变工具都被拒绝且原因含工具名', () => {
  for (const name of MUTATING_TOOLS) {
    const reason = guard(reviewer(name))
    assert.equal(typeof reason, 'string', `${name} 应被拒绝`)
    assert.match(reason, new RegExp(name), `${reason} 应包含 ${name}`)
  }
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
