/**
 * The human-help channel behind `chrome_request_help`: the model asks the user
 * to do a step only they can do — sign in, solve a CAPTCHA, approve a prompt —
 * and waits for the answer instead of guessing at a login wall.
 *
 * The question service is reached structurally and through `ctx.inject`, so a
 * composition without one keeps every other tool working and answers this one
 * with a clear error rather than hanging or silently doing nothing.
 * @module @liyuera/dsh-chrome-browser/help
 */

import type { Context } from '@deepseek-ai/cordis'

/** Label the human picks to say the step is done; the answer is compared against it. */
export const HELP_DONE_LABEL = '已完成,继续'

/** Label the human picks to stop this line of work. */
export const HELP_SKIP_LABEL = '跳过,停止这条路径'

/** One question as the question service takes it. */
export interface HelpQuestion {
  readonly id: string
  readonly header?: string
  readonly question: string
  readonly detail?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
}

/** Structural view of the question service (`ctx.userQuestions`). */
export interface UserQuestionsLike {
  /** Ask the scoped answerer waterfall and wait for the human's answer. */
  ask(request: {
    questions: readonly HelpQuestion[]
    agent?: unknown
    signal?: AbortSignal
  }): Promise<{ answers: readonly { id: string; selected: readonly string[]; custom?: string }[] }>
}

/** What one help request produced. */
export interface HelpOutcome {
  /** Whether the human reported the step done. */
  completed: boolean
  /** Free text the human added, when they added any. */
  note?: string
}

/** Ask the human one thing and resolve with what they answered. */
export type HelpAsker = (reason: string, agent: unknown) => Promise<HelpOutcome>

/**
 * Build the asker over a live question service.
 *
 * The question offers exactly two answers, so the model cannot read an
 * ambiguous reply as permission: anything that is not the done label — a skip,
 * or a dismissal that comes back empty — means the step did not happen.
 * @param questions - the resolved `ctx.userQuestions`.
 * @returns the asker {@link HelpChannel.wire} takes.
 */
export function questionAsker(questions: UserQuestionsLike): HelpAsker {
  return async (reason, agent) => {
    const answer = await questions.ask({
      questions: [{
        id: 'chrome-request-help',
        header: '需要你在浏览器里操作一下',
        question: reason,
        detail: '做完后选「' + HELP_DONE_LABEL + '」,模型会接着往下走;'
          + '选「' + HELP_SKIP_LABEL + '」它会停下这条路径,不会反复重试。',
        options: [
          { label: HELP_DONE_LABEL, description: '我已经做完了,继续' },
          { label: HELP_SKIP_LABEL, description: '不做了,让模型停止' },
        ],
      }],
      ...(agent === undefined ? {} : { agent }),
    })
    const first = answer.answers[0]
    const note = first?.custom
    return {
      completed: first?.selected?.[0] === HELP_DONE_LABEL,
      ...(note === undefined || note === '' ? {} : { note }),
    }
  }
}

/**
 * The channel `chrome_request_help` speaks to. It starts unwired, because the
 * question service may be absent or may resolve after this plugin applies;
 * {@link registerHelpChannel} installs the asker once it exists.
 */
export class HelpChannel {
  private asker: HelpAsker | undefined

  /** Install the asker; the last wiring wins. */
  wire(asker: HelpAsker): void {
    this.asker = asker
  }

  /** Whether this composition can reach a human at all. */
  get wired(): boolean {
    return this.asker !== undefined
  }

  /**
   * Ask the human to do a step and wait for their answer.
   * @param reason - what the human must do, in their own language.
   * @param agent - the asking agent, when the caller has one.
   * @returns what the human answered.
   * @throws when this composition exposes no question service.
   */
  async request(reason: string, agent: unknown): Promise<HelpOutcome> {
    const asker = this.asker
    if (asker === undefined) {
      throw new Error(
        'chrome_request_help: this dsh composition exposes no user-question service, so the plugin cannot reach'
        + ' you. Continue without the step — and say in your reply what you needed the user to do.',
      )
    }
    return await asker(reason, agent)
  }
}

/**
 * Wire the channel once a question service exists in this composition. A
 * composition without one never runs the callback, which is the intended
 * degradation: the tool stays registered and explains itself.
 * @param ctx - the plugin's Cordis context.
 * @param channel - the channel `chrome_request_help` reads.
 */
export function registerHelpChannel(ctx: Context, channel: HelpChannel): void {
  ctx.inject(['userQuestions'], (scoped) => {
    const questions = scoped.get('userQuestions') as UserQuestionsLike | undefined
    if (questions === undefined) return
    channel.wire(questionAsker(questions))
  })
}
