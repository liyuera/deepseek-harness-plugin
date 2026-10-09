/**
 * Browser-half wiring: which `@` source the plugin contributes, and that the
 * retired composer-dock selector contributes nothing.
 *
 * The slot registry and the trigger service live in the Web shell's browser
 * artifacts, so these specs boot the real plugin over recording stand-ins with
 * the same method surface the plugin uses. The behavioral claims are the ones
 * the change is about: no dock row registers while the picker is switched off,
 * one `@` tab source does, and disposing the fiber releases it.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { apply, inject } from '../src/client/index.ts'
import { CHROME_TAB_SOURCE_NAME, CHROME_TAB_SOURCE_ORDER } from '../src/client/tab-source.ts'

/** One recorded slot contribution. */
interface Contribution {
  key: string
  options: Record<string, unknown>
}

/** Boot the browser half over recording services. */
async function bench(): Promise<{
  fiber: { dispose(): Promise<void> }
  contributions: Contribution[]
  sources: Array<{ name?: string; trigger?: string; order?: number; showGroupTitle?: boolean }>
}> {
  const ctx = new Context()
  const contributions: Contribution[] = []
  const sources: Array<{ name?: string; trigger?: string; order?: number; showGroupTitle?: boolean }> = []
  ctx.provide('slots', {
    register: (options: Record<string, unknown>) => {
      contributions.push({ key: String(options.name), options })
      return () => {}
    },
    inject: (_key: string, callback: () => (() => void) | void) => {
      const dispose = callback()
      return () => { if (typeof dispose === 'function') dispose() }
    },
  } as never)
  ctx.provide('inputTriggers', {
    registerSource: (source: (typeof sources)[number]) => {
      sources.push(source)
      return () => { sources.splice(sources.indexOf(source), 1) }
    },
    sessionOf: () => { throw new Error('unused in this spec') },
  } as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { fiber, contributions, sources }
}

describe('chrome-browser browser half', () => {
  it('declares the services it reads', () => {
    expect(inject).toEqual(['slots', 'inputTriggers'])
  })

  it('registers no composer-dock row while the tab picker is switched off', async () => {
    const { contributions } = await bench()
    expect(contributions).toEqual([])
  })

  it('registers one @ source above the saved-prompt group', async () => {
    const { sources } = await bench()
    expect(sources).toHaveLength(1)
    expect(sources[0]?.name).toBe(CHROME_TAB_SOURCE_NAME)
    expect(sources[0]?.trigger).toBe('@')
    expect(sources[0]?.order).toBe(CHROME_TAB_SOURCE_ORDER)
    // Rows carry their own section heading, so no group-title row is rendered.
    expect(sources[0]?.showGroupTitle).toBe(false)
  })

  it('releases the @ source when the fiber is disposed (HMR safety)', async () => {
    const { fiber, sources } = await bench()
    await fiber.dispose()
    expect(sources).toEqual([])
  })
})
