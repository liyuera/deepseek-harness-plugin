import test from 'node:test'
import assert from 'node:assert/strict'
import { createReviewerGuard, READONLY_TOOLS } from '../src/host/guard.js'

const guard = createReviewerGuard('code-review')

const reviewer = (name) => ({ name, agent: { session: { header: { agentPreset: 'code-review' } } } })
const otherPreset = (name) => ({ name, agent: { session: { header: { agentPreset: 'default' } } } })

/** 断言该工具被拒绝，且文案使用配置的预设 id、包含工具名并说明不在白名单内。 */
function assertDenied(name) {
  assert.equal(
    guard(reviewer(name)),
    `code-review: 审查者（code-review）只读，${name} 不在只读白名单内，已拒绝`,
    `${name} 应被拒绝`,
  )
}

test('READONLY_TOOLS 恰为最小只读集合', () => {
  assert.ok(READONLY_TOOLS instanceof Set, 'READONLY_TOOLS 应为 Set')
  assert.deepEqual(
    [...READONLY_TOOLS].sort(),
    ['glob', 'grep', 'read', 'read_image', 'structured_output'],
  )
})

test('只读工具 read 放行', () => {
  assert.equal(guard(reviewer('read')), undefined)
})

test('只读工具 read_image 放行', () => {
  assert.equal(guard(reviewer('read_image')), undefined)
})

test('只读工具 glob 放行', () => {
  assert.equal(guard(reviewer('glob')), undefined)
})

test('只读工具 grep 放行', () => {
  assert.equal(guard(reviewer('grep')), undefined)
})

test('只读工具 structured_output 放行（审查者靠它回传结果）', () => {
  assert.equal(guard(reviewer('structured_output')), undefined)
})

test('审查者预设下，写类与命令执行工具被拒绝', () => {
  assertDenied('write')
  assertDenied('edit')
  assertDenied('apply_patch')
  assertDenied('bash')
  assertDenied('pwsh')
})

test('审查者预设下，终端类工具被拒绝', () => {
  assertDenied('terminal_open')
  assertDenied('terminal_send')
  assertDenied('terminal_signal')
})

test('审查者预设下，插件与持久任务类工具被拒绝', () => {
  assertDenied('plugin_manager')
  assertDenied('plugin_market')
  assertDenied('ralph')
  assertDenied('schedule_create')
  assertDenied('schedule_edit')
})

test('审查者预设下，代理编排类工具被拒绝', () => {
  assertDenied('send_message')
  assertDenied('interrupt_agent')
  assertDenied('subagent')
  assertDenied('subagent_fork')
  assertDenied('workflow')
  assertDenied('create_worktree')
  assertDenied('job_kill')
  assertDenied('todo_write')
  assertDenied('create_goal')
  assertDenied('update_goal')
  assertDenied('present')
})

test('审查者预设下，白名单外的其它工具与未知工具被拒绝（fail-closed）', () => {
  assertDenied('web_fetch')
  assertDenied('list_agents')
  assertDenied('skill')
  assertDenied('job_list')
  assertDenied('future_dangerous_tool')
})

test('审查者调用缺少工具名时也被拒绝（fail-closed）', () => {
  const reason = guard({ agent: { session: { header: { agentPreset: 'code-review' } } } })
  assert.equal(typeof reason, 'string')
  assert.match(reason, /undefined 不在只读白名单内/)
})

test('拒绝文案使用配置的 reviewerPreset id', () => {
  const other = createReviewerGuard('reviewer-x')
  assert.equal(
    other({ name: 'write', agent: { session: { header: { agentPreset: 'reviewer-x' } } } }),
    'code-review: 审查者（reviewer-x）只读，write 不在只读白名单内，已拒绝',
  )
  assert.equal(other(reviewer('write')), undefined, '非该 guard 的预设应放行')
})

test('非审查者预设下任意工具都放行', () => {
  assert.equal(guard(otherPreset('bash')), undefined)
  assert.equal(guard(otherPreset('write')), undefined)
  assert.equal(guard(otherPreset('future_dangerous_tool')), undefined)
})

test('缺少 agent/session/header 的 exec 一律放行', () => {
  assert.equal(guard({ name: 'bash', agent: {} }), undefined)
  assert.equal(guard({ name: 'bash', agent: { session: {} } }), undefined)
  assert.equal(guard({ name: 'bash', agent: { session: { header: {} } } }), undefined)
  assert.equal(guard({ name: 'bash' }), undefined)
})

test('exec 缺失或为空时放行且不抛错', () => {
  assert.equal(guard(), undefined)
  assert.equal(guard(undefined), undefined)
  assert.equal(guard(null), undefined)
  assert.equal(guard({}), undefined)
  assert.equal(guard({ agent: {} }), undefined)
})
