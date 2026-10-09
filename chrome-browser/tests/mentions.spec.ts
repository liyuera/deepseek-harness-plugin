/**
 * The tab-citation grammar and the context message it expands into.
 *
 * These specs cover the half the user never sees: what the host reads out of a
 * sent message, which live tab each citation resolves to, and the text the
 * model receives in place of the URL line the bubble no longer shows.
 */
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm/message'
import { createChromeTabSource } from '../src/client/tab-source.ts'
import {
  MAX_TABS_PER_MESSAGE, expandTabMentions, renderTabContext, resolveTabMentions, scanTabMentions,
} from '../src/mentions.ts'

/** Live tabs, including two that share a title and one that has none. */
const TABS = [
  { id: '7', title: '任务管理-列表', url: 'http://192.168.2.84/task/list' },
  { id: '4', title: '星瞰河山一体化平台', url: 'https://ecard.htwisdom.cn/TEAMS-364' },
  { id: '5', title: '星瞰河山一体化平台', url: 'https://ecard.htwisdom.cn/XKSZ-611' },
  { id: '9', title: '', url: 'https://example.com/untitled' },
]

/** One user message carrying the given text. */
function userMessage(text: string): UserMessage {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

/** The text of the context message a run injected, when it injected one. */
function injectedText(messages: readonly UserMessage[] | undefined): string | undefined {
  const injected = messages?.find(message => message.source.kind === 'chrome-browser')
  if (injected === undefined) return undefined
  return injected.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

describe('tab mention scan', () => {
  it('reads the quoted tokens the tab chips emit', () => {
    expect(scanTabMentions('@"任务管理-列表" 帮我看下这个页面')).toEqual(['任务管理-列表'])
    expect(scanTabMentions('看 @"a b" 和\n@"c"')).toEqual(['a b', 'c'])
  })

  it('leaves every other mention grammar alone', () => {
    // A bare name belongs to saved prompts; a path belongs to file references.
    expect(scanTabMentions('@任务管理-列表')).toEqual([])
    expect(scanTabMentions('@src/index.ts')).toEqual([])
    expect(scanTabMentions('@1234')).toEqual([])
    // The decorator's word boundary: glued to a letter is not a token.
    expect(scanTabMentions('看@"a"')).toEqual([])
  })

  it('lists each label once, within the per-message cap', () => {
    expect(scanTabMentions('@"a" @"a" @"b"')).toEqual(['a', 'b'])
    const many = Array.from({ length: MAX_TABS_PER_MESSAGE + 3 }, (_, index) => `@"t${String(index)}"`).join(' ')
    expect(scanTabMentions(many)).toHaveLength(MAX_TABS_PER_MESSAGE)
  })
})

describe('tab mention resolution', () => {
  it('matches a label to the tab carrying it, and an untitled tab by its URL', () => {
    expect(resolveTabMentions(['任务管理-列表'], TABS)).toEqual([{
      label: '任务管理-列表',
      tabs: [{ id: '7', title: '任务管理-列表', url: 'http://192.168.2.84/task/list' }],
    }])
    expect(resolveTabMentions(['https://example.com/untitled'], TABS)[0]?.tabs).toEqual([
      { id: '9', title: 'https://example.com/untitled', url: 'https://example.com/untitled' },
    ])
  })

  it('keeps every tab sharing a cited title, and drops a label no tab carries', () => {
    const cited = resolveTabMentions(['星瞰河山一体化平台', '已关闭的页面'], TABS)
    expect(cited).toHaveLength(1)
    expect(cited[0]?.tabs.map(tab => tab.id)).toEqual(['4', '5'])
  })
})

describe('tab context rendering', () => {
  it('names the tab id and URL of a singly cited tab', () => {
    const text = renderTabContext(resolveTabMentions(['任务管理-列表'], TABS))
    expect(text).toContain('## Referenced Chrome tabs')
    expect(text).toContain('### @"任务管理-列表"')
    expect(text).toContain('- tabId: 7 — http://192.168.2.84/task/list')
  })

  it('asks which tab a shared title means instead of guessing', () => {
    const text = renderTabContext(resolveTabMentions(['星瞰河山一体化平台'], TABS))
    expect(text).toContain('2 open tabs share this title')
    expect(text).toContain('- tabId: 4 — https://ecard.htwisdom.cn/TEAMS-364')
    expect(text).toContain('  - tabId: 5 — https://ecard.htwisdom.cn/XKSZ-611')
  })

  it('renders nothing when no citation resolved', () => {
    expect(renderTabContext([])).toBe('')
    expect(renderTabContext(resolveTabMentions(['已关闭的页面'], TABS))).toBe('')
  })
})

describe('tab mention expansion', () => {
  it('appends one context message after the message that cited a tab', async () => {
    const messages = [userMessage('@"任务管理-列表" 看下这个页面'), userMessage('今天天气不错')]
    const expanded = await expandTabMentions(messages, async () => TABS)
    expect(expanded).toHaveLength(3)
    expect(expanded?.[0]).toBe(messages[0])
    expect(expanded?.[1]?.source.kind).toBe('chrome-browser')
    expect(injectedText(expanded)).toContain('tabId: 7')
    // The message that cited nothing stays without a context message.
    expect(expanded?.[2]).toBe(messages[1])
  })

  it('never even lists tabs when no message cites one', async () => {
    const listTabs = vi.fn(async () => TABS)
    expect(await expandTabMentions([userMessage('@src/index.ts 读一下')], listTabs)).toBeUndefined()
    expect(listTabs).not.toHaveBeenCalled()
  })

  it('expands nothing when the cited title matches no open tab', async () => {
    // The same shape covers a file path with spaces: nothing resolves, nothing
    // is injected, and the token stays ordinary text.
    expect(await expandTabMentions([userMessage('@"我的 文档.docx" 改一下')], async () => TABS)).toBeUndefined()
  })

  it('expands nothing when the browser cannot be listed', async () => {
    const failure = new Error('Chrome 扩展未连接')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await expandTabMentions([userMessage('@"任务管理-列表"')], async () => { throw failure })).toBeUndefined()
    expect(logged).toHaveBeenCalledWith('[chrome-browser] tab mention expansion skipped:', failure)
    logged.mockRestore()
  })

  it('skips messages this plugin injected before', async () => {
    const injected = createUserMessage({
      source: {
        kind: 'chrome-browser' as never,
        form: 'reference',
        version: 1,
        labels: ['任务管理-列表'],
      },
      content: [{ type: 'text', text: '## Referenced Chrome tabs\n\n### @"任务管理-列表"\n- tabId: 7 — https://x' }],
    })
    expect(await expandTabMentions([injected], async () => TABS)).toBeUndefined()
  })

  it('reads back exactly the mention the browser half emits', async () => {
    // The two halves share one grammar and nothing else: what the chip puts in
    // the draft is what this host half must resolve. A drift between them is
    // silent — the user sees a reference and the model gets no tab.
    const source = createChromeTabSource({ listTabs: async () => TABS, iconFor: () => (): null => null })
    const rows = await source.candidates(
      { sessionId: 'session-1' } as never,
      { query: '', position: 'inline', drilled: false, signal: new AbortController().signal },
    )
    const outcome = source.onPick({
      candidate: rows[0] as never,
      session: { sessionId: 'session-1' } as never,
      position: 'inline',
      via: 'menu',
      action: 'pick',
      span: { start: 0, end: 2, draftRev: 1 },
    })
    const inserted = (outcome as { insert: { ref: string, clipboardText: string } }).insert
    const sent = await source.codec?.serialize(inserted.ref, new AbortController().signal)
    expect(sent).toBe(inserted.clipboardText)

    const expanded = await expandTabMentions([userMessage(`${sent ?? ''} 看下这个页面`)], async () => TABS)
    expect(injectedText(expanded)).toContain('- tabId: 7 — http://192.168.2.84/task/list')
  })
})
