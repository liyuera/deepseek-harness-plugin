import { describe, expect, it } from 'vitest'
import { PortAllocator } from '../src/ports.ts'

describe('PortAllocator', () => {
  it('allocates incrementing ports from the base', () => {
    const ports = new PortAllocator(9222)
    expect(ports.allocate()).toBe(9222)
    expect(ports.allocate()).toBe(9223)
    expect(ports.allocate()).toBe(9224)
  })

  it('reuses released ports before incrementing', () => {
    const ports = new PortAllocator(9222)
    const first = ports.allocate() // 9222
    ports.allocate()               // 9223
    ports.release(first)
    expect(ports.allocate()).toBe(9222)
    expect(ports.allocate()).toBe(9224)
  })
})
