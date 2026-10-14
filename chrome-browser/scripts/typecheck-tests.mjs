/**
 * Type-check this package's sources AND tests, failing only on diagnostics that
 * belong to this package.
 *
 * `tsconfig.tests.json` resolves the DSH workspace through `paths` aliases, so
 * the program also contains files owned by other projects — the harness's
 * client packages, vendored cordis — compiled under this package's flags. Their
 * diagnostics belong to those projects' own builds, and must not decide this
 * package's exit status. Diagnostics in `src/` or `tests/` are ours.
 *
 * The compiler is invoked as `node <tsc.js>` rather than through the
 * `node_modules/.bin` shim: a spawn of that shim fails silently on this
 * platform, which would turn the check into one that always passes.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')

const run = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.tests.json', '--pretty', 'false'], {
  cwd: root,
  encoding: 'utf8',
})

if (run.error !== undefined && run.error !== null) {
  console.error(`typecheck:tests — could not run the compiler: ${run.error.message}`)
  process.exit(1)
}

const lines = `${run.stdout ?? ''}${run.stderr ?? ''}`.split('\n')
const errors = lines.filter(line => /error TS\d+/u.test(line))
const mine = errors.filter(line => /^(src|tests)\//u.test(line))
const foreign = errors.filter(line => /^\.\.\/\.\.\//u.test(line))

if (mine.length > 0) {
  console.error(mine.join('\n'))
  console.error(`\ntypecheck:tests — ${mine.length} error(s) in this package (${foreign.length} in other projects, ignored)`)
  process.exit(1)
}

// No error line at all plus a non-zero exit means the compiler never ran over
// the program; that is a misinvocation, not a clean tree.
if (errors.length === 0 && run.status !== 0) {
  console.error(lines.filter(line => line !== '').slice(0, 20).join('\n'))
  console.error(`\ntypecheck:tests — the compiler exited ${String(run.status)} without reporting a diagnostic`)
  process.exit(1)
}

console.log(foreign.length === 0
  ? 'typecheck:tests — clean'
  : `typecheck:tests — clean here (${foreign.length} error(s) in other projects, not this package's)`)
process.exit(0)
