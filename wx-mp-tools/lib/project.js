/**
 * Project resolution: map "whatever the caller knows" (a session workspace, a
 * uni-app source root, a compiled output directory, an IDE project entry) onto
 * the exact path 微信开发者工具 registered for the project.
 *
 * Why this matters: every automation tool takes `--project <path>`, and the CLI
 * matches that path against the IDE's runtime table. For a uni-app project the
 * IDE entry is the compiled output (`dist/build/mp-weixin`), not the source
 * root — passing the source root fails with "cant find runtimeid by
 * projectpath", which is otherwise very hard to diagnose.
 * @module @liyuera/dsh-wx-mp-tools/project
 */

import { existsSync as fsExistsSync, readdirSync as fsReaddirSync, statSync as fsStatSync } from 'node:fs'
import { isAbsolute, join, resolve as resolvePath, sep } from 'node:path'
import { WxmpCliError } from './cli.js'

/** Directories never worth descending into while looking for a project. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'unpackage_cache'])

/** Build-output directories uni-app layouts use, relative to a project root. */
const UNIAPP_BUILD_OUTPUTS = [
  'dist/build/mp-weixin',
  'dist/dev/mp-weixin',
  'unpackage/dist/build/mp-weixin',
  'unpackage/dist/dev/mp-weixin',
]

/** How many project rows an error message lists. */
const LISTED_PROJECTS = 8

/** Filesystem seam so resolution is testable without a real tree. */
const realFs = {
  exists: path => fsExistsSync(path),
  isDirectory: path => {
    try {
      return fsStatSync(path).isDirectory()
    } catch {
      return false
    }
  },
  listDirs: path => {
    try {
      return fsReaddirSync(path, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !SKIP_DIRS.has(entry.name))
        .map(entry => join(path, entry.name))
    } catch {
      return []
    }
  },
}

/**
 * Read the session workspace directory a tool call belongs to.
 * The runtime agent carries the durable session header; tools that resolve
 * relative paths (bash, write) rely on the same field.
 * @param {unknown} exec - tool execution context.
 * @returns {string | undefined} absolute session cwd.
 */
export function sessionCwd(exec) {
  const agent = exec !== null && typeof exec === 'object' ? /** @type {Record<string, any>} */ (exec).agent : undefined
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' && isAbsolute(cwd) ? cwd : undefined
}

/**
 * Extract the project array from a `project_list` result.
 * @param {unknown} result - the CLI envelope's `result`.
 * @returns {unknown[]} raw project rows.
 */
export function extractProjects(result) {
  if (Array.isArray(result)) return result
  if (result === null || typeof result !== 'object') return []
  const record = /** @type {Record<string, unknown>} */ (result)
  for (const key of ['projects', 'list', 'items', 'data']) {
    if (Array.isArray(record[key])) return record[key]
  }
  return []
}

/**
 * Normalize one IDE project row.
 * @param {unknown} row - one raw row.
 * @returns {{ projectPath: string, projectName: string, appId: string } | undefined} normalized row.
 */
export function normalizeProject(row) {
  if (row === null || typeof row !== 'object') return undefined
  const record = /** @type {Record<string, unknown>} */ (row)
  const projectPath = record.projectPath ?? record.path ?? record.projectRoot
  if (typeof projectPath !== 'string' || projectPath === '') return undefined
  const projectName = typeof record.projectName === 'string' && record.projectName !== '' ? record.projectName : projectPath.split(sep).pop() ?? projectPath
  const appId = typeof record.appId === 'string' ? record.appId : ''
  return { projectPath, projectName, appId }
}

/**
 * Whether `child` is `parent` or sits below it.
 * @param {string} child - candidate descendant.
 * @param {string} parent - candidate ancestor.
 * @returns {boolean} containment result.
 */
export function isInside(child, parent) {
  if (child === parent) return true
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

/**
 * One project list rendered for an error message.
 * @param {{ projectPath: string, projectName?: string, appId?: string }[]} projects - known projects.
 * @returns {string} newline-indented bullet list.
 */
function describeProjects(projects) {
  const rows = projects.slice(0, LISTED_PROJECTS).map(project => {
    const name = project.projectName === undefined || project.projectName === '' ? '' : ` (${project.projectName})`
    const appId = project.appId === undefined || project.appId === '' ? '' : ` appid=${project.appId}`
    return `  - ${project.projectPath}${name}${appId}`
  })
  const more = projects.length > LISTED_PROJECTS ? `\n  …还有 ${projects.length - LISTED_PROJECTS} 个` : ''
  return rows.join('\n') + more
}

/**
 * Build the actionable "cannot decide which project" error.
 * @param {string} reason - what failed.
 * @param {{ projectPath: string, projectName?: string, appId?: string }[]} projects - candidates.
 * @returns {WxmpCliError} the error to throw.
 */
function projectError(reason, projects) {
  const candidates = projects.length === 0 ? '（IDE 项目列表为空或读取失败）' : `\nIDE 已导入项目：\n${describeProjects(projects)}`
  return new WxmpCliError(
    `${reason}${candidates}\n请把 project 设成上面某个 projectPath（uni-app 项目是编译产物目录，如 dist/build/mp-weixin）。`,
    { kind: 'project' },
  )
}

/**
 * Resolves the IDE-registered project path for one tool call.
 */
export class ProjectResolver {
  /**
   * @param {import('./cli.js').WechatideCli} cli - bridge used for `project_list`.
   * @param {{ project?: string }} config - plugin config carrying an optional default.
   * @param {{ listTtlMs?: number, fs?: typeof realFs }} [options] - cache bound and filesystem seam.
   */
  constructor(cli, config, options = {}) {
    this.cli = cli
    this.config = config
    this.fs = options.fs ?? realFs
    this.listTtlMs = options.listTtlMs ?? 15_000
    /** @type {{ at: number, projects: { projectPath: string, projectName: string, appId: string }[] }} */
    this.cache = { at: 0, projects: [] }
  }

  /**
   * Read the IDE project list, cached briefly (each read is a full CLI call).
   * @param {{ force?: boolean, signal?: AbortSignal }} [options] - cache control.
   * @returns {Promise<{ projectPath: string, projectName: string, appId: string }[]>} normalized projects.
   */
  async listProjects(options = {}) {
    if (!options.force && Date.now() - this.cache.at < this.listTtlMs) return this.cache.projects
    const { result } = await this.cli.call('project_list', {}, { signal: options.signal })
    const projects = extractProjects(result).map(normalizeProject).filter(project => project !== undefined)
    this.cache = { at: Date.now(), projects }
    return projects
  }

  /** Drop the cached project list (after import/open). */
  invalidate() {
    this.cache.at = 0
  }

  /**
   * Resolve one call's project path.
   * @param {string | undefined} explicit - the call's `project` argument.
   * @param {unknown} exec - tool execution context (for the session cwd).
   * @param {{ signal?: AbortSignal }} [options] - cancellation forwarded to project listing.
   * @returns {Promise<{ projectPath: string, source: string }>} the resolved path and how it was found.
   */
  async resolve(explicit, exec, options = {}) {
    let projects = []
    try {
      projects = await this.listProjects({ signal: options.signal })
    } catch {
      // A project listing failure must not mask the explicit-path case below.
      projects = []
    }
    const cwd = sessionCwd(exec)
    const candidate = explicit ?? this.config.project
    if (candidate !== undefined && candidate !== '') {
      const abs = isAbsolute(candidate) ? resolvePath(candidate) : resolvePath(cwd ?? process.cwd(), candidate)
      return this.resolveAbsolute(abs, projects)
    }
    if (cwd === undefined) {
      if (projects.length === 1) return { projectPath: projects[0].projectPath, source: 'only-project' }
      throw projectError('无法自动确定项目：当前会话没有工作区信息，且 IDE 里不止一个项目。', projects)
    }
    const workspaceMatches = projects.filter(project => isInside(cwd, project.projectPath) || isInside(project.projectPath, cwd))
    if (workspaceMatches.length === 1) return { projectPath: workspaceMatches[0].projectPath, source: 'workspace' }
    if (workspaceMatches.length > 1) {
      throw projectError(`会话工作区 ${cwd} 匹配到多个 IDE 项目，无法自动选择：`, workspaceMatches)
    }
    const scanned = this.findProjectRoots(cwd)
    if (scanned.length === 1) return this.resolveAbsolute(scanned[0], projects)
    if (scanned.length > 1) throw projectError(`会话工作区 ${cwd} 下找到多个小程序项目，无法自动选择：`, scanned.map(projectPath => ({ projectPath })))
    if (projects.length === 1) return { projectPath: projects[0].projectPath, source: 'only-project' }
    throw projectError(`无法从会话工作区 ${cwd} 匹配到微信开发者工具里的项目。`, projects)
  }

  /**
   * Resolve an absolute candidate against the IDE list, known build outputs,
   * and the `project.config.json` marker.
   * @param {string} abs - absolute candidate path.
   * @param {{ projectPath: string, projectName?: string, appId?: string }[]} projects - IDE projects.
   * @returns {{ projectPath: string, source: string }} the resolved path.
   */
  resolveAbsolute(abs, projects) {
    const exact = projects.find(project => project.projectPath === abs)
    if (exact !== undefined) return { projectPath: exact.projectPath, source: 'ide' }
    const descendants = projects.filter(project => isInside(project.projectPath, abs))
    if (descendants.length === 1) return { projectPath: descendants[0].projectPath, source: 'ide-descendant' }
    if (descendants.length > 1) throw projectError(`${abs} 下匹配到多个 IDE 项目，无法自动选择：`, descendants)
    const ancestors = projects
      .filter(project => isInside(abs, project.projectPath))
      .sort((left, right) => right.projectPath.length - left.projectPath.length)
    if (ancestors.length > 0) return { projectPath: ancestors[0].projectPath, source: 'ide-ancestor' }
    if (this.isProjectRoot(abs)) return { projectPath: abs, source: 'project-config' }
    if (!this.fs.exists(abs)) {
      throw projectError(`项目路径 ${abs} 不存在。`, projects)
    }
    const builds = this.buildOutputs(abs)
    if (builds.length === 1) return { projectPath: builds[0], source: 'build-output' }
    if (builds.length > 1) throw projectError(`${abs} 下匹配到多个编译产物项目，无法自动选择：`, builds.map(projectPath => ({ projectPath })))
    throw projectError(`路径 ${abs} 不在微信开发者工具的项目列表里，也不包含 project.config.json。`, projects)
  }

  /**
   * Whether a directory is a mini-program root (has `project.config.json`).
   * @param {string} directory - candidate directory.
   * @returns {boolean} true when the config file exists.
   */
  isProjectRoot(directory) {
    return this.fs.exists(join(directory, 'project.config.json'))
  }

  /**
   * Known uni-app build-output roots under one directory.
   * @param {string} directory - project root candidate.
   * @returns {string[]} existing build-output directories.
   */
  buildOutputs(directory) {
    return UNIAPP_BUILD_OUTPUTS.map(relative => join(directory, relative)).filter(candidate => this.isProjectRoot(candidate))
  }

  /**
   * Search a workspace for mini-program roots, shallow first.
   * @param {string} root - session workspace directory.
   * @returns {string[]} directories containing `project.config.json`.
   */
  findProjectRoots(root) {
    const found = []
    if (this.isProjectRoot(root)) found.push(root)
    const queue = [{ directory: root, depth: 0 }]
    while (queue.length > 0) {
      const current = queue.shift()
      if (current.depth >= 2) continue
      for (const directory of this.fs.listDirs(current.directory)) {
        if (this.isProjectRoot(directory)) found.push(directory)
        else queue.push({ directory, depth: current.depth + 1 })
        if (found.length > 4) return found
      }
    }
    return found
  }
}
