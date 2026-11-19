/**
 * chrome-browser plugin test configuration: standalone vitest project.
 *
 * The plugin was originally developed inside the DSH monorepo, whose
 * `packages/*` / `vendor/*` source paths this config aliased. In this
 * standalone repo those packages are installed under node_modules and resolve
 * normally, so only two workspace packages need test doubles: the
 * browser-only UI primitives and the not-installed skill registry.
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      // Browser-only package whose Node entry cannot load; see the stub's note.
      { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: here('./tests/support/ui-primitives.ts') },
      // Not installed in this standalone repo; minimal registry stand-in.
      { find: /^@deepseek-ai\/dsh-skill$/, replacement: here('./tests/support/dsh-skill.ts') },
    ],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
