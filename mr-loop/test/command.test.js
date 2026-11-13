import test from 'node:test'
import assert from 'node:assert/strict'
import { createCommand } from '../src/host/command.js'

const agent = { session: { id: 's1', header: { cwd: '/repo' } } }

test('/mr resume 先恢复再取最新报告', async () => {
  const calls = []
  const service = {
    resume: ({ sessionId }) => { calls.push(['resume', sessionId]) },
    status: async ({ sessionId }) => { calls.push(['status', sessionId]); return { report: `STATUS ${sessionId}` } },
  }
  const result = await createCommand({ service }).handler({ agent, rawInput: 'resume' })
  assert.deepEqual(result, { kind: 'success', text: 'STATUS s1' })
  assert.deepEqual(calls, [['resume', 's1'], ['status', 's1']])
})
