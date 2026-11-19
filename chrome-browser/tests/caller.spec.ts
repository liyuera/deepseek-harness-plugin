import { describe, expect, it } from 'vitest'
import { agentIdOf, sessionIdOf } from '../src/caller.ts'

describe('caller helpers', () => {
  it('reads agent id from the execution context', () => {
    expect(agentIdOf({ agent: { id: 'a-1' } })).toBe('a-1')
    expect(agentIdOf({})).toBeUndefined()
    expect(agentIdOf(null)).toBeUndefined()
    expect(agentIdOf({ agent: {} })).toBeUndefined()
    expect(agentIdOf({ agent: { id: '' } })).toBeUndefined()
    expect(agentIdOf({ agent: { id: 42 } })).toBeUndefined()
  })

  it('reads session id from the execution context', () => {
    expect(sessionIdOf({ agent: { session: { id: 's-1' } } })).toBe('s-1')
    expect(sessionIdOf({})).toBeUndefined()
    expect(sessionIdOf({ agent: { session: { id: '' } } })).toBeUndefined()
  })
})
