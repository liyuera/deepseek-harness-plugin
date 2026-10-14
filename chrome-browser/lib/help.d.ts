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
import type { Context } from '@deepseek-ai/cordis';
/** Label the human picks to say the step is done; the answer is compared against it. */
export declare const HELP_DONE_LABEL = "\u5DF2\u5B8C\u6210,\u7EE7\u7EED";
/** Label the human picks to stop this line of work. */
export declare const HELP_SKIP_LABEL = "\u8DF3\u8FC7,\u505C\u6B62\u8FD9\u6761\u8DEF\u5F84";
/** One question as the question service takes it. */
export interface HelpQuestion {
    readonly id: string;
    readonly header?: string;
    readonly question: string;
    readonly detail?: string;
    readonly options?: readonly {
        readonly label: string;
        readonly description?: string;
    }[];
}
/** Structural view of the question service (`ctx.userQuestions`). */
export interface UserQuestionsLike {
    /** Ask the scoped answerer waterfall and wait for the human's answer. */
    ask(request: {
        questions: readonly HelpQuestion[];
        agent?: unknown;
        signal?: AbortSignal;
    }): Promise<{
        answers: readonly {
            id: string;
            selected: readonly string[];
            custom?: string;
        }[];
    }>;
}
/** What one help request produced. */
export interface HelpOutcome {
    /** Whether the human reported the step done. */
    completed: boolean;
    /** Free text the human added, when they added any. */
    note?: string;
}
/** Ask the human one thing and resolve with what they answered. */
export type HelpAsker = (reason: string, agent: unknown) => Promise<HelpOutcome>;
/**
 * Build the asker over a live question service.
 *
 * The question offers exactly two answers, so the model cannot read an
 * ambiguous reply as permission: anything that is not the done label — a skip,
 * or a dismissal that comes back empty — means the step did not happen.
 * @param questions - the resolved `ctx.userQuestions`.
 * @returns the asker {@link HelpChannel.wire} takes.
 */
export declare function questionAsker(questions: UserQuestionsLike): HelpAsker;
/**
 * The channel `chrome_request_help` speaks to. It starts unwired, because the
 * question service may be absent or may resolve after this plugin applies;
 * {@link registerHelpChannel} installs the asker once it exists.
 */
export declare class HelpChannel {
    private asker;
    /** Install the asker; the last wiring wins. */
    wire(asker: HelpAsker): void;
    /** Whether this composition can reach a human at all. */
    get wired(): boolean;
    /**
     * Ask the human to do a step and wait for their answer.
     * @param reason - what the human must do, in their own language.
     * @param agent - the asking agent, when the caller has one.
     * @returns what the human answered.
     * @throws when this composition exposes no question service.
     */
    request(reason: string, agent: unknown): Promise<HelpOutcome>;
}
/**
 * Wire the channel once a question service exists in this composition. A
 * composition without one never runs the callback, which is the intended
 * degradation: the tool stays registered and explains itself.
 * @param ctx - the plugin's Cordis context.
 * @param channel - the channel `chrome_request_help` reads.
 */
export declare function registerHelpChannel(ctx: Context, channel: HelpChannel): void;
//# sourceMappingURL=help.d.ts.map