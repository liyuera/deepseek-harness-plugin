/**
 * 规则作用域：把规则的 `scope`（extensions/globs）匹配到本次变更文件。
 *
 * glob 语义（§18.5）：`*` 匹配段内任意字符（不跨 `/`），`**` 跨目录，`?` 匹配单个非 `/`
 * 字符；目标是 `/` 规范化后的相对路径。自带实现，不引依赖。
 * @module @liyuera/dsh-code-review/host/scope
 */

const REGEXP_SPECIALS = /[\\^$.*+?()[\]{}|]/g

/** 把路径/模式规范化为 posix 相对形式：反斜杠转 `/`，去掉前导 `./`。 */
function normalize(value) {
  return String(value ?? '')
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/, '')
}

/**
 * 把 glob 编译成锚定的正则。
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] !== '*') {
        source += '[^/]*'
        continue
      }
      index += 1
      // `***` 与 `**` 等价：吞掉多余星号。
      while (pattern[index + 1] === '*') index += 1
      if (pattern[index + 1] === '/') {
        index += 1
        // `**/` 匹配零层或多层目录。
        source += '(?:[^/]+/)*'
      } else {
        source += '.*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(REGEXP_SPECIALS, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/** 默认敏感路径：命中即强制链级全量复审（不可被 fullReview:false 降级）。 */
export const DEFAULT_SENSITIVE_GLOBS = Object.freeze([
  '**/auth/**',
  '**/migrations/**',
  '**/*.sql',
  '**/.github/workflows/**',
])

/**
 * 判断 posix 相对路径是否匹配 glob。
 * @param {string} pattern 不带前导 `./` 的 glob
 * @param {string} path 不带前导 `./` 的 `/` 分隔相对路径
 * @returns {boolean}
 */
export function matchGlob(pattern, path) {
  if (typeof pattern !== 'string' || pattern.length === 0) return false
  return globToRegExp(normalize(pattern)).test(normalize(path))
}

/**
 * 规则是否适用于某个文件：无 `scope` 恒适用；否则 extensions 或 globs 命中任一即可。
 * @param {object} rule
 * @param {string} filePath
 * @returns {boolean}
 */
export function ruleAppliesToFile(rule, filePath) {
  const scope = rule?.scope
  if (scope === undefined || scope === null) return true
  const path = normalize(filePath)
  const extensions = Array.isArray(scope.extensions) ? scope.extensions : []
  if (extensions.some((extension) => path.toLowerCase().endsWith(String(extension).toLowerCase()))) {
    return true
  }
  const globs = Array.isArray(scope.globs) ? scope.globs : []
  return globs.some((glob) => matchGlob(glob, path))
}

/**
 * 按本次变更文件过滤规则。无 `scope` 的规则永远保留；`filePaths` 为空时只保留它们。
 * 文件条目可以是路径字符串，也可以是 `{ path }` 对象（直接传 `collect().files`）。
 * @param {readonly object[]} rules
 * @param {readonly (string|{path?: string})[]} [filePaths]
 * @returns {object[]}
 */
export function filterRulesForFiles(rules, filePaths = []) {
  const paths = (Array.isArray(filePaths) ? filePaths : [])
    .map((file) => (typeof file === 'string' ? file : file?.path))
    .filter((path) => typeof path === 'string' && path.length > 0)
  return rules.filter((rule) => {
    if (rule?.scope === undefined || rule?.scope === null) return true
    return paths.some((path) => ruleAppliesToFile(rule, path))
  })
}
