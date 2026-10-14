/**
 * chrome-browser plugin test configuration: standalone vitest project that
 * resolves workspace imports through explicit aliases (the plugin repo has no
 * node_modules links to workspace packages; tsconfig-paths proved unreliable
 * for direct cordis imports under vitest 4).
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('../../', import.meta.url))

/** Alias the workspace packages this plugin's code and tests import. */
const ALIASES: Array<[string, string]> = [
  ['@deepseek-ai/cordis$', 'vendor/cordis/src/index.ts'],
  ['@deepseek-ai/cordis/', 'vendor/cordis/src/'],
  ['@deepseek-ai/schemastery$', 'vendor/schemastery/src/index.ts'],
  ['@deepseek-ai/dsh-invariants$', 'packages/runtime-diagnostics/invariants/src/index.ts'],
  ['@deepseek-ai/dsh-tools$', 'packages/core/tools/src/index.ts'],
  ['@deepseek-ai/dsh-tools/', 'packages/core/tools/src/'],
  // The real skill registry, so a test can exercise registration AND loading
  // rather than a stub that accepts whatever it is handed.
  ['@deepseek-ai/dsh-skill$', 'packages/skill/skill/src/index.ts'],
  // Browser-only package whose Node entry cannot load; see the stub's own note.
  ['@deepseek-ai/dsh-client-ui-primitives$', 'deepseek-harness-plugin/chrome-browser/tests/support/ui-primitives.ts'],
]

export default defineConfig({
  resolve: {
    alias: ALIASES.map(([find, replacement]) => ({
      find: new RegExp(`^${find}`),
      replacement: `${root}${replacement}`,
    })),
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
