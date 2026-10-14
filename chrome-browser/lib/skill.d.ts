/**
 * The `chrome-browser` agent skill: when to reach for the `chrome_*` tools, the
 * order to call them in, and the limits worth knowing before trying.
 *
 * The skill registry is reached structurally and through `ctx.inject`, so a
 * composition without `dsh-skill` (or with it mounted later) leaves the tools
 * fully functional and only loses the catalog entry.
 * @module @liyuera/dsh-chrome-browser/skill
 */
import type { Context } from '@deepseek-ai/cordis';
/** Skill name the catalog, the `skill` tool, and `/chrome-browser` address. */
export declare const SKILL_NAME = "chrome-browser";
/** Routing line the catalog shows while the body stays unloaded. */
export declare const SKILL_DESCRIPTION: string;
/** Body loaded only when the skill is invoked. Annotated `string` so the emitted
 * declarations carry the type and not a 6 KB literal. */
export declare const SKILL_CONTENT: string;
/** The structural skill-registration face this plugin consumes. */
export interface SkillRegistrationLike {
    readonly name: string;
    readonly description: string;
    readonly content: string;
    /**
     * Discovery source the registry merges on. `ctx.skills.register()` defaults
     * `invocation` and `provider` but takes this straight from the caller, and a
     * missing value passes registration and fails only when the skill is loaded —
     * so it is required here.
     */
    readonly source: string;
    readonly invocation?: {
        readonly modelInvocable: boolean;
        readonly userInvocable: boolean;
    };
}
/** Structural view of the skill registry (`ctx.skills`). */
export interface SkillsLike {
    /** Register one runtime skill; the returned disposer withdraws it. */
    register(skill: SkillRegistrationLike): () => void;
}
/** The skill this plugin contributes. */
export declare function chromeSkill(): SkillRegistrationLike;
/**
 * Publish the skill once a skill registry exists in this composition. A
 * composition without `dsh-skill` never runs the callback, which is the
 * intended degradation: the tools keep working and only the catalog entry is
 * absent.
 * @param ctx - the plugin's Cordis context.
 */
export declare function registerChromeSkill(ctx: Context): void;
//# sourceMappingURL=skill.d.ts.map