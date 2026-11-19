/**
 * Test double for `@deepseek-ai/dsh-skill`.
 *
 * That package is not installed in this standalone plugin repo (it was aliased
 * to the DSH monorepo source before the repo was split out). `skill.spec.ts`
 * only needs the structural `skills` service — register / list / get — so this
 * stand-in provides that minimal surface as a real Cordis plugin function.
 */

interface SkillRecord {
  name: string
  description: string
  content: string
  source: string
  invocation?: unknown
}

interface SkillsService {
  register(skill: SkillRecord): () => void
  list(): Promise<Array<{ name: string }>>
  get(name: string): Promise<{ content: string; source: string } | undefined>
}

/** Cordis plugin: provides the `skills` service the skill tests drive. */
export default function SkillRegistry(ctx: { provide(key: string, value: unknown): void }): void {
  const skills = new Map<string, SkillRecord>()
  ctx.provide('skills', {
    register(skill: SkillRecord): () => void {
      skills.set(skill.name, skill)
      return () => { skills.delete(skill.name) }
    },
    async list(): Promise<Array<{ name: string }>> {
      return [...skills.values()].map(({ name }) => ({ name }))
    },
    async get(name: string): Promise<{ content: string; source: string } | undefined> {
      const skill = skills.get(name)
      return skill === undefined ? undefined : { content: skill.content, source: skill.source }
    },
  } satisfies SkillsService)
}
