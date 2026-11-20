/**
 * Self-contained tsdown helper for this plugin's browser bundle.
 *
 * The plugin repo is standalone: it must not reach into the harness monorepo's
 * `build/`, `scripts/`, or `packages/` sources. This helper therefore hardcodes
 * the module-table externals the shell provides for a dynamic client bundle
 * (the React family) and inlines the build-environment defines locally. The
 * runtime artifact is the same `window.__ModuleLoader__.load({ id, factory })`
 * closure the harness workspace preset produces.
 *
 * The client code in this plugin imports only React at runtime (its
 * `@deepseek-ai/dsh-client-ui-*` imports are type-only and erased), uses no CSS
 * Modules and no `process.env`/`import.meta.env`, so no CSS pipeline or
 * platform-seed table is needed.
 *
 * @module build/client-bundle
 */

import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath, sep } from 'node:path'
import type { UserConfig } from 'tsdown'

/** Path segment separating a package's tsc output from the sources it was emitted from. */
const TYPES_MARKER = `${sep}lib${sep}types${sep}`

/** Trailing sourcemap reference tsc appends to every emitted module. */
const SOURCEMAP_COMMENT = /\n\/\/# sourceMappingURL=.*\s*$/

/**
 * Module-table specifiers the shell provides at runtime. The React family is
 * shared with the shell (a second inlined copy would break hook identity), so
 * these must stay external; every other import inlines privately.
 */
const MODULE_TABLE_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
]

/** Whether a specifier is answered by the shell's module table. */
function isRequested(specifier: string): boolean {
  return MODULE_TABLE_EXTERNALS.includes(specifier)
}

/** Build-environment defines for this plugin's client bundle. */
function clientBuildEnvironmentDefines(env: NodeJS.ProcessEnv): Record<string, string> {
  const mode = env.NODE_ENV ?? 'production'
  return {
    'process.env.NODE_ENV': JSON.stringify(mode),
    'import.meta.env.MODE': JSON.stringify(mode),
    'import.meta.env': JSON.stringify({ MODE: mode }),
  }
}

/**
 * Build one dynamic client bundle config: `lib/client/index.js` (or a custom
 * entry) into the factory-form `lib/client.js`.
 * @param id - plugin package name; the module-table graph row it registers.
 * @param entry - client entry relative to the package root.
 * @returns the tsdown config for the browser bundle.
 */
export function clientBundleConfig(id: string, entry = 'lib/client/index.js'): UserConfig {
  return {
    name: `${id}/client`,
    entry: { client: entry },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    inputOptions: {
      // React must be answered by the shell's module table (a second inlined
      // copy breaks hooks); everything else inlines into the bundle.
      external: isRequested,
      resolve: {
        conditionNames: [
          (process.env.NODE_ENV ?? 'production') === 'development' ? 'development' : 'production',
          'browser', 'import', 'module', 'default',
        ],
      },
    },
    define: clientBuildEnvironmentDefines(process.env),
    plugins: [{
      // Chain tsc's emitted maps into the bundle when the entry consumes
      // lib/, so browser stacks reach the TypeScript/TSX sources.
      name: 'dsh-tsc-sourcemap',
      async load(id: string) {
        if (!id.includes(TYPES_MARKER) && !id.includes(`${sep}lib${sep}client${sep}`)) return null
        if (!id.endsWith('.js') || !existsSync(`${id}.map`)) return null
        const code = readFileSync(id, 'utf8')
        const map = JSON.parse(readFileSync(`${id}.map`, 'utf8')) as {
          sources?: string[]
          sourcesContent?: unknown[]
        }
        const sources = map.sources ?? []
        if (!Array.isArray(sources) || sources.some(source => typeof source !== 'string')) {
          throw new Error(`client sourcemap: ${id}.map has invalid sources`)
        }
        if (
          !Array.isArray(map.sourcesContent)
          || map.sourcesContent.length !== sources.length
        ) {
          map.sourcesContent = await Promise.all(sources.map(async source =>
            readFile(resolvePath(dirname(id), source), 'utf8').catch(() => '')))
        }
        return { code: code.replace(SOURCEMAP_COMMENT, ''), map }
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}
