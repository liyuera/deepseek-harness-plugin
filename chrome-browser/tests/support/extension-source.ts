/**
 * Loading the shipped extension's plain-JS functions into a test.
 *
 * The bridge cannot import host modules, so some logic exists twice: once in
 * `src/` for the CDP backend and once in `extension/service-worker.js` for the
 * bridge. Reading the extension's own source here lets a test run both copies
 * against the same input and require the same output, which is the only thing
 * keeping them in step.
 * @module tests/support/extension-source
 */
import { readFileSync } from 'node:fs'

/** The shipped extension service worker, as text. */
export const EXTENSION_SOURCE = readFileSync(new URL('../../extension/service-worker.js', import.meta.url), 'utf8')

/**
 * Extract one top-level declaration by name: a function, or a `const`
 * initializer, which may run over several lines.
 * @param source - the file text.
 * @param name - the declared name.
 * @returns the declaration source.
 */
export function extractDeclaration(source: string, name: string): string {
  const declared = source.indexOf(`function ${name}(`)
  if (declared !== -1) {
    // Keep an `async` modifier. The extractor builds a `new Function` body,
    // which does not make an extracted function async on its own, so dropping
    // the keyword turns every `await` inside it into a syntax error.
    const start = source.slice(Math.max(0, declared - ASYNC.length), declared) === ASYNC
      ? declared - ASYNC.length
      : declared
    let depth = 0
    for (let index = source.indexOf('{', start); index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') {
        depth -= 1
        if (depth === 0) return source.slice(start, index + 1)
      }
    }
    throw new Error(`unbalanced braces while extracting ${name}`)
  }
  const constant = source.indexOf(`const ${name} = `)
  if (constant !== -1) return source.slice(constant, constEnd(source, constant))
  throw new Error(`extension/service-worker.js is missing ${name}`)
}

/** The modifier that must stay attached to an extracted function. */
const ASYNC = 'async '

/** Characters that leave an initializer open at the end of a line. */
const CONTINUES = new Set(['+', ',', '(', '[', '{', '=', '.', '&', '|'])

/**
 * Find where a `const` initializer ends: the first line break outside any
 * bracket, quote or template literal that does not continue onto the next line.
 * @param source - the file text.
 * @param start - index of the `const` keyword.
 * @returns the index just past the initializer.
 */
function constEnd(source: string, start: number): number {
  let depth = 0
  let quote: string | null = null
  for (let index = start; index < source.length; index += 1) {
    const char = source[index] as string
    if (quote !== null) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === '\n' && depth === 0) {
      const soFar = source.slice(start, index).trimEnd()
      const last = soFar[soFar.length - 1]
      if (last !== undefined && CONTINUES.has(last)) continue
      // The operator may lead the next line instead of trailing this one.
      const next = /^\s*(\S)/u.exec(source.slice(index + 1))?.[1]
      if (next !== undefined && CONTINUES.has(next)) continue
      return index
    }
  }
  return source.length
}

/**
 * Build one callable out of a set of the extension's declarations.
 *
 * The result is a factory: call it with the globals the extension's code reads,
 * in `globals` order, and it returns the entry function. That is what lets a
 * page-side helper run against a stub document.
 * @param names - the declarations to include, in dependency order.
 * @param entry - the name the caller wants back.
 * @param globals - names to expose as parameters of the built scope.
 * @returns the factory for the entry function.
 */
export function loadExtensionFunction<T>(
  names: readonly string[],
  entry: string,
  globals: readonly string[] = [],
): (...args: unknown[]) => T {
  const body = names.map(name => extractDeclaration(EXTENSION_SOURCE, name)).join('\n')
  return new Function(...globals, `${body}\nreturn ${entry}`) as (...args: unknown[]) => T
}
