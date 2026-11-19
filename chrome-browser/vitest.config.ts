/**
 * chrome-browser plugin test configuration: standalone vitest project.
 *
 * The plugin was originally developed inside the DSH monorepo, whose
 * `packages/*` / `vendor/*` source paths this config aliased. In this
 * standalone repo those packages are installed under node_modules and resolve
 * normally, so only one workspace package needs a test double: the browser-only
 * UI primitives. `@deepseek-ai/dsh-skill` is installed and loads under Node, so
 * `skill.spec.ts` drives the real registry instead of a stand-in.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      // Browser-only package whose Node entry cannot load; see the stub's note.
      { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: here('./tests/support/ui-primitives.ts') },
    ],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
