/**
 * The human-help channel: what the model can ask for, what the answer means,
 * and how the plugin behaves when the composition exposes no question service.
 */
import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { BackendTab, BrowserBackend, ClickOutcome } from '../src/backend.ts'
import { resolveChromeConfig } from '../src/chrome.ts'
import { ConsoleLog } from '../src/console-log.ts'
import {
  HELP_DONE_LABEL,
  HELP_SKIP_LABEL,
  HelpChannel,
  questionAsker,
  registerHelpChannel,
} from '../src/help.ts'
import type { UserQuestionsLike } from '../src/help.ts'
import { chromeToolDefinitions } from '../src/tools.ts'

/** One request the fake question service received. */
interface AskedRequest {
  questions: readonly { id: string; header?: string; question: string; detail?: string; options?: readonly { label: string }[] }[]
  agent?: unknown
}

/** A question service that records requests and answers with a fixed selection. */
function questions(answer: { selected?: string[]; custom?: string }): {
  readonly service: UserQuestionsLike
  readonly asked: AskedRequest[]
} {
  const asked: AskedRequest[] = []
  return {
    asked,
    service: {
      ask: async (request) => {
        asked.push(request as AskedRequest)
        return {
          answers: [{ id: 'chrome-request-help', selected: answer.selected ?? [], ...(answer.custom === undefined ? {} : { custom: answer.custom }) }],
        }
      },
    },
  }
}

describe('HelpChannel', () => {
  it('explains itself instead of hanging when no question service was wired', async () => {
    const channel = new HelpChannel()
    expect(channel.wired).toBe(false)
    await expect(channel.request('please sign in', undefined))
      .rejects.toThrow(/exposes no user-question service/)
  })

  it('forwards the reason and the agent to the wired asker', async () => {
    const channel = new HelpChannel()
    const seen: Array<[string, unknown]> = []
    channel.wire(async (reason, agent) => {
      seen.push([reason, agent])
      return { completed: true }
    })
    expect(channel.wired).toBe(true)
    const agent = { id: 'a1' }
    await expect(channel.request('please sign in', agent)).resolves.toEqual({ completed: true })
    expect(seen).toEqual([['please sign in', agent]])
  })
})

describe('questionAsker', () => {
  it('asks one question with exactly two answers', async () => {
    const fake = questions({ selected: [HELP_DONE_LABEL] })
    await questionAsker(fake.service)('请在 example.com 登录', undefined)

    expect(fake.asked).toHaveLength(1)
    const question = fake.asked[0]!.questions[0]!
    expect(question.id).toBe('chrome-request-help')
    expect(question.question).toBe('请在 example.com 登录')
    expect(question.options?.map(option => option.label)).toEqual([HELP_DONE_LABEL, HELP_SKIP_LABEL])
    expect(question.detail).toContain(HELP_DONE_LABEL)
  })

  it('reads the done label as completed', async () => {
    const fake = questions({ selected: [HELP_DONE_LABEL] })
    await expect(questionAsker(fake.service)('go', undefined)).resolves.toEqual({ completed: true })
  })

  it('reads the skip label as not completed', async () => {
    const fake = questions({ selected: [HELP_SKIP_LABEL] })
    await expect(questionAsker(fake.service)('go', undefined)).resolves.toEqual({ completed: false })
  })

  it('never reads an empty or unknown answer as permission', async () => {
    for (const selected of [[], ['something else']]) {
      const fake = questions({ selected })
      await expect(questionAsker(fake.service)('go', undefined)).resolves.toEqual({ completed: false })
    }
  })

  it('carries free text the human typed as a note', async () => {
    const fake = questions({ selected: [HELP_DONE_LABEL], custom: '用的是另一个账号' })
    await expect(questionAsker(fake.service)('go', undefined))
      .resolves.toEqual({ completed: true, note: '用的是另一个账号' })
  })

  it('omits the agent when the caller has none, so the waterfall is unscoped', async () => {
    const fake = questions({ selected: [HELP_DONE_LABEL] })
    await questionAsker(fake.service)('go', undefined)
    expect('agent' in fake.asked[0]!).toBe(false)

    const withAgent = questions({ selected: [HELP_DONE_LABEL] })
    const agent = { id: 'a1' }
    await questionAsker(withAgent.service)('go', agent)
    expect(withAgent.asked[0]!.agent).toBe(agent)
  })
})

describe('registerHelpChannel', () => {
  /** A host whose question service is present or absent. */
  function host(withQuestions: boolean): { ctx: unknown; channel: HelpChannel; requested: string[][] } {
    const requested: string[][] = []
    const channel = new HelpChannel()
    const service: UserQuestionsLike = {
      ask: async () => ({ answers: [{ id: 'chrome-request-help', selected: [HELP_DONE_LABEL] }] }),
    }
    const ctx = {
      inject: (deps: readonly string[], callback: (scoped: unknown) => void) => {
        requested.push([...deps])
        if (!withQuestions) return
        callback({ get: (key: string) => (key === 'userQuestions' ? service : undefined) })
      },
    }
    return { ctx, channel, requested }
  }

  it('wires the channel once the question service exists', async () => {
    const fixture = host(true)
    registerHelpChannel(fixture.ctx as never, fixture.channel)
    expect(fixture.requested).toEqual([['userQuestions']])
    expect(fixture.channel.wired).toBe(true)
    await expect(fixture.channel.request('go', undefined)).resolves.toEqual({ completed: true })
  })

  it('leaves every other tool working when the composition has none', async () => {
    const fixture = host(false)
    expect(() => { registerHelpChannel(fixture.ctx as never, fixture.channel) }).not.toThrow()
    expect(fixture.channel.wired).toBe(false)
    await expect(fixture.channel.request('go', undefined)).rejects.toThrow(/exposes no user-question service/)
  })
})

const EMPTY_CLICK: ClickOutcome = {
  matched: 0, clicked: 0, disabled: 0, invisible: 0, offscreen: 0, covered: 0, ariaDisabled: 0,
}

/** A backend that answers nothing; only `chrome_request_help` is exercised here. */
function backend(): BrowserBackend {
  const tab: BackendTab = { id: '7', title: 'T', url: 'https://e.test/', active: true, favicon: '' }
  return {
    lastEvalWorld: undefined,
    ensure: async () => {},
    activeTabId: async () => tab.id,
    listTabs: async () => [tab],
    openTab: async () => tab,
    closeTab: async () => {},
    read: async () => ({ title: '', url: '', text: '', html: '' }),
    inventory: async () => ({ title: '', url: '', matched: 0, items: [] }),
    navigate: async () => {},
    waitForLoad: async () => {},
    evaluate: async () => undefined,
    click: async () => EMPTY_CLICK,
    hover: async () => ({ matched: 0, hovered: false }),
    press: async () => ({ found: false, pressed: false, submitted: false }),
    select: async () => ({ matched: 0, changed: false, value: '', options: [] }),
    waitFor: async () => false,
    type: async () => {},
    screenshot: async () => ({ data: '' }),
    startConsole: async () => {},
    stopConsole: async () => {},
    dispose: () => {},
  }
}

function tool(channel: HelpChannel): ToolDefinition {
  const definitions = chromeToolDefinitions(
    backend(), resolveChromeConfig({}), new ConsoleLog(), channel,
  )
  const found = definitions.find(definition => definition.name === 'chrome_request_help')
  if (found === undefined) throw new Error('chrome_request_help is not registered')
  return found
}

describe('chrome_request_help', () => {
  it('is registered even when the composition cannot ask', () => {
    expect(tool(new HelpChannel()).name).toBe('chrome_request_help')
  })

  it('passes the asking agent through and reports completion', async () => {
    const channel = new HelpChannel()
    const seen: unknown[] = []
    channel.wire(async (_reason, agent) => {
      seen.push(agent)
      return { completed: true, note: '已登录' }
    })
    const agent = { id: 'a1' }
    const value = await tool(channel).execute({ reason: '请登录' }, { agent } as never)
    expect(seen).toEqual([agent])
    expect(value).toEqual({ completed: true, note: '已登录' })
  })

  it('surfaces the unwired error to the model rather than answering for the user', async () => {
    await expect(tool(new HelpChannel()).execute({ reason: '请登录' }, {} as never))
      .rejects.toThrow(/exposes no user-question service/)
  })

  it('requires a reason', async () => {
    await expect(tool(new HelpChannel()).execute({} as never, {} as never))
      .rejects.toThrow(/reason/u)
  })
})
