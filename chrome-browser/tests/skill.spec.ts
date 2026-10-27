/**
 * The `chrome-browser` agent skill: its identity, its registration through the
 * optional skill seam, and its degradation when the composition has no skill
 * registry.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { chromeSkill, registerChromeSkill, SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME } from '../src/skill.ts'
import type { SkillRegistrationLike, SkillsLike } from '../src/skill.ts'

/** Every tool the skill body must document. */
const TOOL_NAMES = [
  'chrome_tabs',
  'chrome_read',
  'chrome_navigate',
  'chrome_open',
  'chrome_screenshot',
  'chrome_click',
  'chrome_type',
  'chrome_eval',
] as const

interface FakeHost {
  readonly ctx: Context
  /** Dependencies the plugin asked for, in request order. */
  readonly requested: string[][]
  /** Skills the fake registry received. */
  readonly registered: SkillRegistrationLike[]
  /** Every disposer the registry handed back. */
  readonly disposers: Array<() => void>
}

/**
 * A host whose skill seam is present or absent, mirroring the two compositions
 * this plugin must survive.
 * @param withSkills - whether `ctx.inject(['skills'], …)` ever resolves.
 */
function fakeHost(withSkills: boolean): FakeHost {
  const requested: string[][] = []
  const registered: SkillRegistrationLike[] = []
  const disposers: Array<() => void> = []
  const skills: SkillsLike = {
    register(skill) {
      registered.push(skill)
      const disposer = (): void => {}
      disposers.push(disposer)
      return disposer
    },
  }
  const ctx = {
    inject: (deps: readonly string[], callback: (scoped: unknown) => void) => {
      requested.push([...deps])
      if (!withSkills) return
      callback({
        get: (key: string) => (key === 'skills' ? skills : undefined),
        effect: (contribute: () => () => void) => {
          const disposer = contribute()
          disposers.push(disposer)
          return disposer
        },
      })
    },
  } as unknown as Context
  return { ctx, requested, registered, disposers }
}

describe('chrome-browser skill identity', () => {
  it('is kebab-case, so the registry accepts it', () => {
    expect(SKILL_NAME).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    expect(SKILL_NAME).toBe('chrome-browser')
  })

  it('carries a non-empty routing description', () => {
    const skill = chromeSkill()
    expect(skill.description).toBe(SKILL_DESCRIPTION)
    expect(skill.description.trim().length).toBeGreaterThan(0)
  })

  it('documents every tool it routes to', () => {
    for (const name of TOOL_NAMES) expect(SKILL_CONTENT).toContain(name)
  })

  it('is offered to the model and to the user', () => {
    expect(chromeSkill().invocation).toEqual({ modelInvocable: true, userInvocable: true })
  })

  it('states the limits the tools actually have', () => {
    expect(SKILL_CONTENT).toContain('只覆盖主框架')
    expect(SKILL_CONTENT).toContain('shadow DOM')
  })

  it('documents the screenshot degradation ladder', () => {
    // The model has to know a fallback image is not the whole page, and that a
    // failed screenshot is a signal to collect other evidence rather than retry.
    expect(SKILL_CONTENT).toContain('截图与降级')
    expect(SKILL_CONTENT).toContain('fallback: "visible-tab"')
    expect(SKILL_CONTENT).toContain('不要反复硬试截图')
  })

  it('documents how console capture exits', () => {
    // A capture holds the debugger (and Chrome's debug bar): stop is mandatory,
    // and the automatic releases are what save a model that forgot.
    expect(SKILL_CONTENT).toContain('控制台采集会自己退出')
    expect(SKILL_CONTENT).toContain('detached: "idle"')
    expect(SKILL_CONTENT).toContain('console-sync')
  })
})

describe('registerChromeSkill', () => {
  it('registers the skill once the skill service exists', () => {
    const host = fakeHost(true)
    registerChromeSkill(host.ctx)

    expect(host.requested).toEqual([['skills']])
    expect(host.registered).toHaveLength(1)
    expect(host.registered[0]?.name).toBe(SKILL_NAME)
    expect(host.registered[0]?.content).toBe(SKILL_CONTENT)
  })

  it('hands the registry disposer to the effect, so unloading withdraws the skill', () => {
    const host = fakeHost(true)
    registerChromeSkill(host.ctx)
    // One disposer from the registry, one returned by the effect that owns it.
    expect(host.disposers).toHaveLength(2)
    expect(host.disposers[0]).toBe(host.disposers[1])
  })

  it('stays silent when the composition has no skill registry', () => {
    const host = fakeHost(false)
    expect(() => { registerChromeSkill(host.ctx) }).not.toThrow()
    expect(host.requested).toEqual([['skills']])
    expect(host.registered).toEqual([])
  })
})

describe('registration against the real skill registry', () => {
  it('loads the body back through the service that the `skill` tool uses', async () => {
    // The stub service in this file accepted anything, and the structural
    // interface hid the one field `register()` does not default: `source`. The
    // registration passed and the load failed with "loaded skill ...
    // source must be a string" — a TypeError naming neither the plugin nor the
    // field that was missing. This drives the shipped registry instead.
    const { Context } = await import('@deepseek-ai/cordis')
    const { default: SkillRegistry } = await import('@deepseek-ai/dsh-skill')
    const ctx = new Context()
    const fiber = ctx.plugin(SkillRegistry)
    await fiber.await()
    try {
      const skills = ctx.get('skills') as unknown as {
        register(skill: Record<string, unknown>): () => void
        list(): Promise<Array<{ name: string }>>
        get(name: string): Promise<{ content: string; source: string } | undefined>
      }
      const summary = skills.register({
        name: chromeSkill().name,
        description: chromeSkill().description,
        content: chromeSkill().content,
        source: chromeSkill().source,
        invocation: { modelInvocable: true, userInvocable: true },
      })
      expect(typeof summary).toBe('function')

      const listed = await skills.list()
      expect(listed.some(entry => entry.name === chromeSkill().name), 'the skill is not listed').toBe(true)
      const loaded = await skills.get(chromeSkill().name)
      expect(loaded, 'the skill did not load').toBeDefined()
      expect(typeof (loaded as { content: string }).content).toBe('string')
      expect((loaded as { content: string }).content).toBe(chromeSkill().content)
      expect((loaded as { source: string }).source).toBe('runtime')
    } finally {
      await fiber.dispose()
    }
  })
})

describe('skill content against the tool registry', () => {
  /** Tool names the source registers, in registration order. */
  function registeredTools(): string[] {
    return [...readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
      .matchAll(/name: '([a-z_]+)',/gu)].map(match => match[1] as string)
  }

  it('describes every tool the plugin registers', () => {
    // Adding a tool without a row here leaves the model reading a table that
    // does not mention it; the tool is then never chosen.
    const missing = registeredTools().filter(name => !SKILL_CONTENT.includes(`\`${name}\``))
    expect(missing).toEqual([])
  })

  it('claims no capability is missing while the tool for it exists', () => {
    // The skill once listed chrome_press/chrome_select/chrome_hover in its table
    // and denied all three further down. A model reading both cannot act.
    for (const [tool, denial] of [
      ['chrome_press', '快捷键'],
      ['chrome_select', '下拉选择'],
      ['chrome_hover', '悬停'],
      ['chrome_wait', '没有元素等待'],
    ] as const) {
      const denied = new RegExp(`${denial}[^\\n]*尚不支持|没有元素等待`, 'u').test(SKILL_CONTENT)
      expect(denied, `${tool} exists but the skill still denies ${denial}`).toBe(false)
    }
  })

  it('states the screenshot format the bridge actually produces', () => {
    expect(SKILL_CONTENT).toContain('JPEG')
    expect(SKILL_CONTENT).not.toMatch(/截图存成 PNG/u)
  })
})

describe('tabId documentation', () => {
  it('never promises a session-selected tab that no flow can set', () => {
    // SessionBindings has one writer — the /chrome-browser/select route behind
    // the retired tab picker — so nothing sets a session binding. The claim was
    // in eleven tool schemas and in this skill, and the model read it on every
    // call: omitting tabId silently means "the active tab".
    const tools = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
    expect(tools).not.toMatch(/session-selected|session\.tabs/u)
    // The denial itself is wanted; only the instruction to rely on it is not.
    expect(SKILL_CONTENT).not.toMatch(/用本会话选中的标签页/u)
    expect(SKILL_CONTENT).toContain('用户当前正在看的那个标签页')
  })
})
