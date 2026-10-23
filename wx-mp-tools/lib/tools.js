/**
 * Model-facing tool definitions. Each tool is one intent-shaped wrapper over
 * the official `wechatide` CLI tools shipped inside 微信开发者工具; the CLI's
 * own 40+ atomic tools stay reachable through `wx_mp_raw`.
 *
 * Registered as plain objects rather than through `defineTool` so this bundle
 * needs no peer dependency on the harness packages: `ctx.tools.register` only
 * requires `{ name, description, parameters, output.render, execute }`.
 * Arguments are validated here because a plain definition skips the
 * `defineTool` pre-validation wrapper.
 * @module @liyuera/dsh-wx-mp-tools/tools
 */

import { readFile, rename, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { pendingTaskOf } from './cli.js'

/** Screenshot render guidance shared by the tool body and its card. */
const SCREENSHOT_HINT = 'Use read_image on the returned path to see the simulator.'

/**
 * Build one object-rooted JSON Schema for a tool's parameters.
 * @param {Record<string, Record<string, unknown>>} properties - parameter schemas.
 * @param {string[]} [required] - required parameter names.
 * @returns {Record<string, unknown>} JSON Schema object.
 */
function objectSchema(properties, required = []) {
  return { type: 'object', properties, ...(required.length === 0 ? {} : { required }), additionalProperties: false }
}

/** One `project` parameter, shared by every project-scoped tool. */
const PROJECT_PROPERTY = {
  type: 'string',
  description: 'Mini-program project: an absolute path, a path relative to the session workspace, or (recommended) a projectPath copied from wx_mp_status / the IDE project list. For uni-app the IDE entry is the compiled output (dist/build/mp-weixin), not the source root. Omit to auto-match the session workspace against the IDE project list.',
}

/** One `waitForSelector` parameter: wait for a selector before acting. */
const WAIT_FOR_SELECTOR_PROPERTY = {
  type: 'string',
  description: 'Optional: wait until this selector appears before running the command (preferred over fixed sleeps).',
}

/** One `waitSeconds` parameter. */
const WAIT_SECONDS_PROPERTY = {
  type: 'number',
  description: 'Optional fixed delay in seconds before the command (0-10). Prefer waitForSelector when possible.',
}

/**
 * Clip a string to a character budget with an explicit truncation marker.
 * @param {string} value - text to clip.
 * @param {number} maxChars - model-facing budget.
 * @returns {string} clipped text.
 */
export function clipText(value, maxChars) {
  if (value.length <= maxChars) return value
  const omitted = value.length - maxChars
  return `${value.slice(0, maxChars)}\n…[truncated ${omitted} more characters; narrow the query (grep pattern, selector, dataPath) to see the rest]`
}

/**
 * Keep one tool result JSON-serializable and within budget. Oversized values
 * degrade to `{ truncated, chars, preview }` instead of entering the session
 * log whole.
 * @param {unknown} value - candidate canonical value.
 * @param {number} maxChars - budget applied to the serialized form.
 * @returns {unknown} the bounded value.
 */
export function boundValue(value, maxChars) {
  const serialized = JSON.stringify(value)
  if (serialized === undefined || serialized.length <= maxChars * 2) return value
  return {
    truncated: true,
    note: 'result too large; fields omitted — re-run with a narrower selector/grep/dataPath',
    chars: serialized.length,
    preview: clipText(serialized, maxChars),
  }
}

/**
 * Recursively drop `undefined` object members (and turn undefined array items
 * into null). A tool result must be lossless JSON: `{ selector: undefined }`
 * makes the runtime reject the whole call as "value is not lossless JSON", and
 * every optional field would otherwise need its own guard.
 * @param {unknown} value - candidate canonical value.
 * @returns {unknown} the same shape with no undefined values.
 */
export function stripUndefined(value) {
  if (value === undefined) return null
  if (Array.isArray(value)) return value.map(item => stripUndefined(item))
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = stripUndefined(item)
  }
  return out
}

/**
 * Sniff the raster format from the first bytes (the CLI may ignore a requested
 * extension, and `read_image` refuses a file whose bytes contradict it).
 * @param {Buffer} data - file prefix.
 * @returns {'jpg' | 'png' | undefined} detected format.
 */
export function sniffImageFormat(data) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg'
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png'
  return undefined
}

/**
 * Force a path's extension to the expected screenshot format, replacing a
 * `.png`/`.jpg` suffix or appending one when there is none.
 * @param {string} path - caller-requested output path.
 * @param {'jpg' | 'png'} format - expected format.
 * @returns {string} path with the expected extension.
 */
export function withImageExtension(path, format) {
  const extension = extname(path).toLowerCase()
  const known = ['.jpg', '.jpeg', '.png']
  if (known.includes(extension)) return `${path.slice(0, -extension.length)}.${format}`
  return `${path}.${format}`
}

/**
 * Generic JSON render: pretty-print the canonical value under the text budget.
 * @param {number} maxChars - model-facing budget.
 * @returns {(args: unknown, value: unknown) => { type: 'text', text: string }[]} render function.
 */
function jsonRender(maxChars) {
  return (_args, value) => [{ type: 'text', text: clipText(JSON.stringify(value, null, 2), maxChars) }]
}

/**
 * Throw when a required argument is missing or empty.
 * @param {string} toolName - caller-facing tool name for the message.
 * @param {Record<string, unknown>} args - parsed arguments.
 * @param {string[]} names - required names.
 */
function requireArgs(toolName, args, names) {
  const missing = names.filter(name => args[name] === undefined || args[name] === null || args[name] === '')
  if (missing.length > 0) throw new Error(`${toolName}: missing required argument(s): ${missing.join(', ')}`)
}

/**
 * Read one enum argument with a fallback, rejecting unknown values.
 * @param {string} toolName - caller-facing tool name.
 * @param {Record<string, unknown>} args - parsed arguments.
 * @param {string} key - argument name.
 * @param {readonly string[]} allowed - allowed values.
 * @param {string} fallback - value used when the argument is absent.
 * @returns {string} the selected value.
 */
function enumArg(toolName, args, key, allowed, fallback) {
  const value = args[key] === undefined ? fallback : String(args[key])
  if (!allowed.includes(value)) {
    throw new Error(`${toolName}: ${key} must be one of ${allowed.join(' | ')}; got ${JSON.stringify(args[key])}`)
  }
  return value
}

/** Runtime tool ids per `wx_mp_inspect` target. */
const INSPECT_RUNTIME = {
  current_page: 'currentPage',
  page_stack: 'pageStack',
  system_info: 'systemInfo',
}

/** Page-level action per `wx_mp_inspect` target. `automation_page_action`
 * declares `size` and `scrollTop` in its help but `size` fails at runtime
 * ("Unsupported ... action: size"), so only verified actions stay exposed. */
const INSPECT_PAGE_ACTION = {
  page_data: 'getData',
  query_all: 'querySelectorAll',
  query_one: 'querySelector',
}

/** Element-level action per `wx_mp_inspect` target. `style` and `attribute`
 * require a `name`; `wxml` returns the subtree plus siblings as one string. */
const INSPECT_ELEMENT_ACTION = {
  element_text: 'text',
  element_attr: 'attribute',
  element_style: 'style',
  element_wxml: 'wxml',
  element_value: 'value',
  element_size: 'size',
  element_offset: 'offset',
}

/** Element interaction actions for `wx_mp_act`. */
const ELEMENT_ACTIONS = new Set(['tap', 'longpress', 'input', 'trigger'])

/** Navigation actions for `wx_mp_act` and their CLI action names. */
const NAVIGATE_ACTIONS = {
  navigate: 'navigateTo',
  redirect: 'redirectTo',
  back: 'navigateBack',
  relaunch: 'reLaunch',
  switch_tab: 'switchTab',
}

/**
 * Unwrap the value an `automation_evaluate` call returned. The layer nests it
 * as `{ success, result: { result: value } }`; both wrappers are stripped and
 * depth is bounded so a function returning a `{ result }` object is not
 * unwrapped forever.
 * @param {unknown} result - CLI result.
 * @returns {unknown} the function's return value.
 */
export function unwrapEvaluated(result) {
  let value = result
  for (let depth = 0; depth < 2; depth += 1) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) break
    const record = /** @type {Record<string, unknown>} */ (value)
    if (record.success === true && 'result' in record) {
      value = record.result
      continue
    }
    if (Object.keys(record).length === 1 && 'result' in record) {
      value = record.result
      continue
    }
    break
  }
  return value
}

/**
 * Clip a string result and mark the truncation beside it.
 * @param {string} text - raw text.
 * @param {number} maxChars - budget.
 * @returns {{ value: string, truncated?: true, chars?: number }} clipped projection.
 */
function clipStringValue(text, maxChars) {
  if (text.length <= maxChars) return { value: text }
  return { value: clipText(text, maxChars), truncated: true, chars: text.length }
}

/**
 * Project one read-only automation result into stable fields. The CLI returns
 * different shapes per tool (object / string / array / scalar, with extra
 * `result` nesting for systemInfo and evaluate), so callers should not have to
 * know which one they hit.
 * @param {string} target - the `wx_mp_inspect` target.
 * @param {unknown} result - CLI result.
 * @param {string} project - resolved project path.
 * @param {number} maxChars - text budget for string payloads.
 * @returns {Record<string, unknown>} normalized value.
 */
export function normalizeInspect(target, result, project, maxChars) {
  const record = result !== null && typeof result === 'object' ? /** @type {Record<string, any>} */ (result) : {}
  if (target === 'current_page') return { target, project, page: record.currentPage ?? result ?? null }
  if (target === 'page_stack') return { target, project, stack: record.pageStack ?? result ?? null }
  if (target === 'system_info') return { target, project, systemInfo: record.systemInfo?.result ?? record.systemInfo ?? result ?? null }
  if (target === 'page_data') return { target, project, data: record.data ?? result ?? null }
  if (target === 'query_all') return { target, project, elements: record.elements ?? result ?? null }
  if (target === 'query_one') return { target, project, element: record.element ?? result ?? null }
  if (target === 'element_size') return { target, project, size: { width: record.width ?? null, height: record.height ?? null } }
  if (typeof result === 'string') return { target, project, ...clipStringValue(result, maxChars) }
  return { target, project, result: result ?? null }
}

/** Network buffers carry base64 bodies and auth headers, so an unfiltered
 * `grep -n .` can blow up the context. */
const NETWORK_DEFAULT_COMMAND = 'grep -i error'

/** Official tools offered through `wx_mp_raw`, i.e. the surface not wrapped above. */
const RAW_TOOLS = [
  'login',
  'quit',
  'project_list',
  'project_import',
  'project_remove',
  'share_minicode',
  'import_minicode',
  'get_user_appids',
  'compile_wxml',
  'compile_wxss',
  'debug_clear_cache',
  'automation_wx_api',
  'automation_game_action',
  'automation_testaccount',
  'automation_generate_script',
  'cloud_env_list',
  'cloud_fn_list',
  'cloud_fn_info',
  'cloud_fn_deploy',
  'cloud_fn_inc_deploy',
  'cloud_db_read_struct',
  'cloud_db_read_doc',
  'cloud_db_write_struct',
  'cloud_db_write_doc',
  'cloud_query_storage',
  'cloud_manage_storage',
]

/** `wx_mp_raw` tools that take no `--project` flag. */
const RAW_PROJECTLESS = new Set(['login', 'quit', 'project_list', 'share_minicode', 'import_minicode', 'get_user_appids'])

/**
 * Build every tool definition.
 * @param {{
 *   cli: import('./cli.js').WechatideCli,
 *   resolver: import('./project.js').ProjectResolver,
 *   config: ReturnType<import('./config.js').resolveConfig>,
 * }} deps - bridge, project resolver, and resolved config.
 * @returns {Record<string, unknown>[]} plain tool definitions for `ctx.tools.register`.
 */
export function toolDefinitions({ cli, resolver, config, priming }) {
  const render = jsonRender(config.maxTextChars)

  /**
   * Resolve the project path for one call, forwarding cancellation.
   * @param {Record<string, unknown>} args - parsed arguments.
   * @param {import('./cli.js').WechatideCli} _ - unused.
   * @param {Record<string, any>} exec - tool execution context.
   * @returns {Promise<string>} IDE-registered project path.
   */
  const projectOf = async (args, exec) => (await resolver.resolve(typeof args.project === 'string' ? args.project : undefined, exec, { signal: exec.signal })).projectPath

  /**
   * Wrap an execute body so every canonical value stays within the text budget.
   * @param {(args: Record<string, any>, exec: Record<string, any>) => Promise<unknown>} body - execute body.
   * @returns {(args: Record<string, any>, exec: Record<string, any>) => Promise<unknown>} wrapped body.
   */
  const bounded = body => async (args, exec) => boundValue(stripUndefined(await body(args, exec)), config.maxTextChars)

  /** Screenshot card render: point at the image file; the model reads it next. */
  const screenshotRender = (_args, value) => {
    const rows = [{
      type: 'text',
      text: `Simulator screenshot saved: ${value.path}\n${value.imageWidth}x${value.imageHeight}px${value.bytes === undefined ? '' : ` · ${Math.round(value.bytes / 1024)}KB`}\n${SCREENSHOT_HINT}`,
    }]
    return rows
  }

  const definitions = [
    {
      name: 'wx_mp_status',
      description:
        'Start here. Reports the WeChat DevTools bridge (CLI found, login state, client authorization, CLI-token requirement), '
        + 'the IDE project list, the resolved project for this session, and the simulator\'s current page. '
        + 'It never throws for a missing bridge: the result says which step is missing and what to call next.',
      parameters: objectSchema({
        project: PROJECT_PROPERTY,
        includeProjects: { type: 'boolean', description: 'Include the full IDE project list (default: only when no project could be resolved).' },
      }),
      output: { schema: {}, render },
      execute: async (args, exec) => {
        const agent = exec?.agent
        // Diagnostics for the preset priming: which preset this agent runs and
        // whether the wx-mp body is already in its system prompt.
        const prime = {
          presets: priming?.presets ?? [],
          preset: priming?.presetOf?.(agent) ?? null,
          applied: priming?.primed?.(agent) === true,
        }
        const info = {
          clientName: config.clientName,
          prime,
          /** @type {string | null} */
          cliPath: null,
          cliFound: false,
        }
        try {
          info.cliPath = cli.resolveCliPath()
          info.cliFound = true
        } catch (error) {
          return {
            ...info,
            bridge: 'cli-missing',
            error: error instanceof Error ? error.message : String(error),
            next: '安装/更新微信开发者工具，或在插件配置 cliPath（或环境变量 WECHATIDE_CLI_PATH）指向 wechatide 的可执行文件。',
          }
        }

        /** @type {Record<string, any>} */
        let status = {}
        try {
          const { result } = await cli.call('check_wechatide_status', config.skillVersion === undefined ? {} : { skillVersion: config.skillVersion }, { signal: exec.signal })
          status = result !== null && typeof result === 'object' ? /** @type {Record<string, any>} */ (result) : {}
        } catch (error) {
          const payload = error instanceof Object && 'payload' in error ? /** @type {any} */ (error).payload : undefined
          const kind = error instanceof Object && 'kind' in error ? String(/** @type {any} */ (error).kind) : 'tool'
          if (kind === 'auth-required') {
            return {
              ...info,
              bridge: 'auth-required',
              error: error instanceof Error ? error.message : String(error),
              next: '调用 wx_mp_authorize：微信开发者工具会弹出授权窗口，请用户点「允许」，然后重新调用 wx_mp_status。',
            }
          }
          if (kind === 'devtools-down') {
            return {
              ...info,
              bridge: 'devtools-down',
              error: error instanceof Error ? error.message : String(error),
              next: '让用户启动微信开发者工具并保持登录，然后调用 wx_mp_authorize 或重新 wx_mp_status。',
              payload,
            }
          }
          return { ...info, bridge: 'error', error: error instanceof Error ? error.message : String(error), payload }
        }

        let projects = []
        let projectListError
        try {
          projects = await resolver.listProjects({ signal: exec.signal })
        } catch (error) {
          projectListError = error instanceof Error ? error.message : String(error)
        }

        /** @type {{ projectPath: string, source: string } | undefined} */
        let project
        /** @type {string | undefined} */
        let projectError
        try {
          project = await resolver.resolve(typeof args.project === 'string' ? args.project : undefined, exec, { signal: exec.signal })
        } catch (error) {
          projectError = error instanceof Error ? error.message : String(error)
        }

        /** @type {unknown} */
        let currentPage
        /** @type {string | undefined} */
        let windowError
        if (project !== undefined) {
          try {
            const { result } = await cli.call('automation_runtime_info', { project: project.projectPath, action: 'currentPage' }, { signal: exec.signal })
            currentPage = result !== null && typeof result === 'object' && 'currentPage' in /** @type {any} */ (result) ? /** @type {any} */ (result).currentPage : result
          } catch (error) {
            windowError = error instanceof Error ? error.message : String(error)
          }
        }

        const hints = []
        if (status.loginExpired === true) hints.push('微信开发者工具登录已过期：让用户扫码登录（或调用 wx_mp_raw tool=login），再重试。')
        if (status.tokenRequired === true) hints.push('开发者工具开启了 CLI 访问令牌：让用户从「设置 → 安全」复制令牌，填进插件配置 token 或环境变量 WECHAT_DEVTOOLS_CLI_TOKEN。')
        if (project === undefined && projectError !== undefined) hints.push(projectError)
        if (project !== undefined && windowError !== undefined) hints.push('项目已解析但模拟器没在运行：可用 wx_mp_window(action=open) 打开项目窗口，或检查 IDE 里是否已打开该项目。')
        if (currentPage !== undefined) hints.push('可以继续：wx_mp_compile / wx_mp_screenshot / wx_mp_logs / wx_mp_inspect。')

        const showProjects = args.includeProjects === true || project === undefined
        return {
          ...info,
          bridge: 'ok',
          prime,
          login: {
            loginExpired: status.loginExpired === true,
            loginUser: status.loginUser ?? null,
            tokenRequired: status.tokenRequired === true,
            versionRelation: status.versionRelation ?? 'skip_check',
          },
          project: project === undefined
            ? null
            : { path: project.projectPath, source: project.source, windowOpen: currentPage !== undefined, currentPage },
          ...(showProjects ? { projects: projects.map(row => ({ projectPath: row.projectPath, projectName: row.projectName, appId: row.appId })) } : {}),
          ...(projectListError === undefined ? {} : { projectListError }),
          ...(windowError === undefined ? {} : { windowError }),
          ...(hints.length === 0 ? {} : { hints }),
        }
      },
    },

    {
      name: 'wx_mp_authorize',
      description:
        'Authorize this agent as a WeChat DevTools CLI client. Raises the IDE consent dialog; ask the user to click 允许 there. '
        + 'Call it only when wx_mp_status says auth-required (or a tool failed asking for authorization). '
        + 'Already-authorized calls return immediately. If the result carries a taskId, the dialog is still open: do not loop on this tool, use wx_mp_task.',
      parameters: objectSchema({}),
      output: { schema: {}, render },
      timeoutMs: 150_000,
      execute: async (_args, exec) => {
        try {
          const payload = await cli.auth({ timeoutMs: 120_000, signal: exec.signal })
          const pending = pendingTaskOf(payload)
          return {
            authorized: payload.authorized === true,
            alreadyTrusted: payload.alreadyTrusted === true,
            status: payload.status,
            port: payload.port,
            tokenRequired: payload.tokenRequired === true,
            ...(pending === undefined ? {} : { pending: true, taskId: pending.taskId }),
            message: payload.authorized === true
              ? '授权完成，可以继续调用其它 wx_mp_* 工具。'
              : '微信开发者工具里应已弹出授权窗口：请用户在弹窗中点击「允许」。若弹窗已关闭，再次调用 wx_mp_authorize；已有 taskId 时用 wx_mp_task 查询结果，不要重复发起。',
          }
        } catch (error) {
          return {
            authorized: false,
            error: error instanceof Error ? error.message : String(error),
            message: '拉起授权流程失败。若开发者工具未启动，请先让用户启动；若从未登录过，请先让用户扫码登录。',
          }
        }
      },
    },

    {
      name: 'wx_mp_window',
      description:
        'Open or close the WeChat DevTools project window that hosts the simulator. Most simulator tools need the window open; '
        + 'open_project_window also imports the project when the IDE has not seen it yet. '
        + 'Opening an already-open project returns the existing window instead of creating a second one.',
      parameters: objectSchema({
        action: { type: 'string', enum: ['open', 'close'], description: 'open = show the project window (imports when needed); close = close that window (does not quit the IDE).' },
        project: PROJECT_PROPERTY,
        windowMode: { type: 'string', enum: ['liteMode', 'fullMode'], description: 'open only: liteMode (default) shows just the simulator; fullMode adds the code editor and debugger.' },
      }, ['action']),
      output: { schema: {}, render },
      execute: async (args, exec) => {
        requireArgs('wx_mp_window', args, ['action'])
        const action = enumArg('wx_mp_window', args, 'action', ['open', 'close'], 'open')
        const project = await projectOf(args, exec)
        if (action === 'open') {
          const windowMode = args.windowMode === undefined ? undefined : enumArg('wx_mp_window', args, 'windowMode', ['liteMode', 'fullMode'], 'liteMode')
          const { result } = await cli.call('open_project_window', { project, ...(windowMode === undefined ? {} : { windowMode }) }, { signal: exec.signal })
          resolver.invalidate()
          return { action, project, result, hint: 'Window open. Use wx_mp_compile(action=refresh) if the simulator shows a stale build, then wx_mp_screenshot.' }
        }
        const { result } = await cli.call('close_project_window', { project }, { signal: exec.signal })
        resolver.invalidate()
        return { action, project, result }
      },
    },

    {
      name: 'wx_mp_compile',
      description:
        'Rebuild the simulator. refresh = trigger the IDE compile / hot reload of the window (success only means it was triggered — '
        + 'check console and take a screenshot for the outcome); open_page = compile and open one page (path + optional query/scene); '
        + 'build_npm = build npm dependencies into the project. For a uni-app / CLI project, build the source first with bash '
        + '(e.g. npm run build:mp-weixin) — this tool only drives the IDE side.',
      parameters: objectSchema({
        action: { type: 'string', enum: ['refresh', 'open_page', 'build_npm'], description: 'refresh = recompile current window; open_page = compile and open a page; build_npm = build npm deps.' },
        project: PROJECT_PROPERTY,
        page: { type: 'string', description: 'open_page only: page route without leading slash, e.g. pages/house/list.' },
        query: { type: 'string', description: 'open_page only: URL query string, e.g. id=1&type=test.' },
        scene: { type: 'number', description: 'open_page only: scene value (default 1001).' },
        compileType: { type: 'string', description: 'build_npm only: compile type, e.g. miniprogram.' },
      }, ['action']),
      output: { schema: {}, render },
      execute: async (args, exec) => {
        requireArgs('wx_mp_compile', args, ['action'])
        const action = enumArg('wx_mp_compile', args, 'action', ['refresh', 'open_page', 'build_npm'], 'refresh')
        const project = await projectOf(args, exec)
        if (action === 'open_page') {
          requireArgs('wx_mp_compile', args, ['page'])
          const { result } = await cli.call('simulator_open_page', {
            project,
            page: args.page,
            ...(args.query === undefined ? {} : { query: args.query }),
            ...(args.scene === undefined ? {} : { scene: args.scene }),
          }, { signal: exec.signal })
          return { action, project, page: args.page, result, hint: 'Take wx_mp_screenshot to verify the page rendered.' }
        }
        if (action === 'build_npm') {
          const { result } = await cli.call('build_npm', { project, ...(args.compileType === undefined ? {} : { compileType: args.compileType }) }, { signal: exec.signal })
          return { action, project, result }
        }
        const { result } = await cli.call('simulator_refresh', { project }, { signal: exec.signal })
        return { action, project, result, hint: 'Refresh was triggered, not verified: read wx_mp_logs and take wx_mp_screenshot.' }
      },
    },

    {
      name: 'wx_mp_screenshot',
      description:
        'Capture the mini-program simulator to a local image file and return its path, pixel size, and bytes. '
        + 'The screenshot is not attached to the result: call read_image on the returned path to actually see it. '
        + 'Use waitForSelector to wait for a rendered state instead of a fixed sleep; optimize=false writes a full-resolution PNG.',
      parameters: objectSchema({
        project: PROJECT_PROPERTY,
        waitForSelector: WAIT_FOR_SELECTOR_PROPERTY,
        waitSeconds: WAIT_SECONDS_PROPERTY,
        optimize: { type: 'boolean', description: 'Downscale to a long side of 1280 as JPEG (default true). Set false for a full-resolution PNG.' },
        quality: { type: 'number', description: 'JPEG quality 1-100 (default 80, optimize=true only).' },
        path: { type: 'string', description: 'Optional absolute output path; defaults to a temp file chosen by the IDE.' },
      }),
      output: { schema: {}, render: screenshotRender },
      execute: async (args, exec) => {
        const project = await projectOf(args, exec)
        // optimize=false must reach the CLI as `--optimize=false`; `--no-optimize`
        // is an unknown flag there and would silently keep the default JPEG.
        const optimize = args.optimize !== false
        const expectedFormat = optimize ? 'jpg' : 'png'
        const requested = typeof args.path === 'string' && args.path !== '' ? args.path : undefined
        const flags = { project }
        if (typeof args.waitForSelector === 'string' && args.waitForSelector !== '') flags.waitForSelector = args.waitForSelector
        if (typeof args.waitSeconds === 'number') flags.wait = args.waitSeconds
        if (!optimize) flags.optimize = false
        if (typeof args.quality === 'number') flags.quality = args.quality
        if (requested !== undefined) flags.path = withImageExtension(requested, expectedFormat)
        const { result } = await cli.call('simulator_screenshot', flags, { signal: exec.signal })
        const shot = result !== null && typeof result === 'object' ? /** @type {Record<string, any>} */ (result) : {}
        if (typeof shot.path !== 'string' || shot.path === '') throw new Error('wx_mp_screenshot: the CLI did not return a screenshot path')
        let path = shot.path
        /** @type {number | undefined} */
        let bytes
        /** @type {'jpg' | 'png' | undefined} */
        let detected
        /** @type {string | undefined} */
        let warning
        try {
          const data = await readFile(path)
          bytes = data.length
          detected = sniffImageFormat(data)
          // The CLI may ignore the requested suffix (or write JPEG bytes into a
          // caller-named .png); read_image rejects bytes that contradict the
          // extension, so correct the suffix to the real format.
          const currentExtension = extname(path).toLowerCase()
          const matches = detected === 'jpg' ? (currentExtension === '.jpg' || currentExtension === '.jpeg') : currentExtension === '.png'
          if (detected !== undefined && !matches) {
            const corrected = withImageExtension(path, detected)
            try {
              await rename(path, corrected)
              path = corrected
            } catch {
              warning = `screenshot bytes are ${detected} but the file is at ${path}; rename the file to .${detected} before read_image`
            }
          }
        } catch (error) {
          warning = `screenshot file unreadable: ${error instanceof Error ? error.message : String(error)}`
        }
        return {
          project,
          path,
          ...(requested === undefined ? {} : { requestedPath: requested }),
          imageWidth: shot.imageWidth ?? null,
          imageHeight: shot.imageHeight ?? null,
          ...(bytes === undefined ? {} : { bytes }),
          format: detected ?? expectedFormat,
          ...(warning === undefined ? {} : { warning }),
        }
      },
    },

    {
      name: 'wx_mp_logs',
      description:
        'Grep the mini-program console or network buffer recorded by the simulator and return matching lines. '
        + '`command` must be a grep command string (no filename): \'grep -n .\' returns everything, \'grep -i error\' filters. '
        + 'An empty result means "no matching lines", not "the console is empty". '
        + 'Output can contain credentials (logins, authorization headers) and network bodies can be large base64: pass a narrow pattern, and never echo sensitive lines to the user.',
      parameters: objectSchema({
        kind: { type: 'string', enum: ['console', 'network'], description: 'Which buffer to grep (default console).' },
        command: { type: 'string', description: "Grep command without filename, e.g. 'grep -n .' or 'grep -i error'. Default 'grep -n .'." },
        project: PROJECT_PROPERTY,
      }),
      output: { schema: {}, render },
      execute: async (args, exec) => {
        const kind = enumArg('wx_mp_logs', args, 'kind', ['console', 'network'], 'console')
        let command = typeof args.command === 'string' && args.command.trim() !== '' ? args.command.trim() : undefined
        if (command === 'all' || command === '*') command = undefined
        // Network buffers carry full request/response bodies (often base64), so
        // an unfiltered read is both huge and sensitive; default to failures.
        command ??= kind === 'network' ? NETWORK_DEFAULT_COMMAND : 'grep -n .'
        const project = await projectOf(args, exec)
        const tool = kind === 'network' ? 'get_simulator_network' : 'get_simulator_console'
        const { result } = await cli.call(tool, { project, command }, { signal: exec.signal })
        const output = typeof result === 'string' ? result : result === undefined ? '' : JSON.stringify(result) ?? ''
        return {
          kind,
          command,
          project,
          empty: output.trim() === '',
          chars: output.length,
          output: clipText(output, config.maxTextChars),
          ...(output.trim() === '' ? { note: 'No lines matched. This does not mean the buffer is empty — widen the pattern, e.g. \'grep -n .\'.' } : {}),
        }
      },
    },

    {
      name: 'wx_mp_inspect',
      description:
        'Read simulator state without mutating it: current page / page stack / system info, page data, element queries, and read-only element properties '
        + '(text / style / attribute / wxml / value / size / offset). Call it before acting so selectors come from the real tree. '
        + 'Results are normalized into stable fields; element_wxml returns the node plus sibling subtrees as one string, so do not parse it as a single node.',
      parameters: objectSchema({
        target: {
          type: 'string',
          enum: [
            'current_page', 'page_stack', 'system_info',
            'page_data', 'query_all', 'query_one',
            'element_text', 'element_attr', 'element_style', 'element_wxml', 'element_value', 'element_size', 'element_offset',
          ],
          description: 'What to read. page_data takes dataPath; query_one/query_all and element_* take selector; element_attr and element_style also take name.',
        },
        project: PROJECT_PROPERTY,
        selector: { type: 'string', description: 'Required for query_one/query_all and every element_* target.' },
        dataPath: { type: 'string', description: 'page_data only: page data path such as list or userInfo.nickName (not a page route).' },
        name: { type: 'string', description: 'element_attr / element_style: attribute or style property name (e.g. class, color). Required for those targets.' },
        waitForSelector: WAIT_FOR_SELECTOR_PROPERTY,
        waitSeconds: WAIT_SECONDS_PROPERTY,
      }, ['target']),
      output: { schema: {}, render },
      execute: async (args, exec) => {
        requireArgs('wx_mp_inspect', args, ['target'])
        const target = enumArg('wx_mp_inspect', args, 'target', [...Object.keys(INSPECT_RUNTIME), ...Object.keys(INSPECT_PAGE_ACTION), ...Object.keys(INSPECT_ELEMENT_ACTION)], 'current_page')
        const project = await projectOf(args, exec)
        const waits = {
          ...(typeof args.waitForSelector === 'string' && args.waitForSelector !== '' ? { waitForSelector: args.waitForSelector } : {}),
          ...(typeof args.waitSeconds === 'number' ? { wait: args.waitSeconds } : {}),
        }
        if (target in INSPECT_RUNTIME) {
          const { result } = await cli.call('automation_runtime_info', { project, action: INSPECT_RUNTIME[target] }, { signal: exec.signal })
          return normalizeInspect(target, result, project, config.maxTextChars)
        }
        if (target in INSPECT_PAGE_ACTION) {
          const action = INSPECT_PAGE_ACTION[target]
          const needsSelector = action === 'querySelectorAll' || action === 'querySelector'
          if (needsSelector) requireArgs('wx_mp_inspect', args, ['selector'])
          const { result } = await cli.call('automation_page_action', {
            project,
            action,
            ...(needsSelector ? { selector: args.selector } : {}),
            ...(target === 'page_data' && args.dataPath !== undefined ? { dataPath: args.dataPath } : {}),
            ...waits,
          }, { signal: exec.signal })
          const normalized = normalizeInspect(target, result, project, config.maxTextChars)
          return needsSelector ? { selector: args.selector, ...normalized } : normalized
        }
        const action = INSPECT_ELEMENT_ACTION[target]
        requireArgs('wx_mp_inspect', args, ['selector'])
        const needsName = target === 'element_attr' || target === 'element_style'
        if (needsName) requireArgs('wx_mp_inspect', args, ['name'])
        const { result } = await cli.call('automation_element_action', {
          project,
          action,
          selector: args.selector,
          ...(needsName ? { name: args.name } : {}),
          ...waits,
        }, { signal: exec.signal })
        return { selector: args.selector, ...normalizeInspect(target, result, project, config.maxTextChars) }
      },
    },

    {
      name: 'wx_mp_act',
      description:
        'Interact with the running mini program: tap / longpress / input / trigger an element (real events), scroll the page, or navigate. '
        + 'Element actions need a selector — get one from wx_mp_inspect first. After acting, take a screenshot or read wx_mp_logs to confirm the effect instead of assuming it worked.',
      parameters: objectSchema({
        action: {
          type: 'string',
          enum: ['tap', 'longpress', 'input', 'trigger', 'page_scroll_to', 'navigate', 'redirect', 'back', 'relaunch', 'switch_tab', 'remote', 'close_tool'],
          description: 'tap/longpress/input/trigger need selector; navigate/redirect/relaunch/switch_tab need url; back uses delta; page_scroll_to needs scrollTop; remote starts real-device debugging; close_tool closes the devtools window.',
        },
        project: PROJECT_PROPERTY,
        selector: { type: 'string', description: 'Element selector for tap/longpress/input/trigger.' },
        value: { type: 'string', description: 'input only: text to type.' },
        type: { type: 'string', description: 'trigger only: event type (e.g. change, submit).' },
        detail: { type: 'object', description: 'trigger only: event detail object passed to the handler.' },
        url: { type: 'string', description: 'navigate/redirect/relaunch/switch_tab: target page path with optional query.' },
        delta: { type: 'number', description: 'back: how many pages to pop (default 1).' },
        scrollTop: { type: 'number', description: 'page_scroll_to: scroll offset in px.' },
        auto: { type: 'boolean', description: 'remote: start real-device debugging automatically (default false).' },
        waitForSelector: WAIT_FOR_SELECTOR_PROPERTY,
        waitSeconds: WAIT_SECONDS_PROPERTY,
      }, ['action']),
      output: { schema: {}, render },
      execute: async (args, exec) => {
        requireArgs('wx_mp_act', args, ['action'])
        const action = enumArg('wx_mp_act', args, 'action', [...ELEMENT_ACTIONS, 'page_scroll_to', ...Object.keys(NAVIGATE_ACTIONS), 'remote', 'close_tool'], 'tap')
        const project = await projectOf(args, exec)
        const waits = {
          ...(typeof args.waitForSelector === 'string' && args.waitForSelector !== '' ? { waitForSelector: args.waitForSelector } : {}),
          ...(typeof args.waitSeconds === 'number' ? { wait: args.waitSeconds } : {}),
        }
        if (ELEMENT_ACTIONS.has(action)) {
          requireArgs('wx_mp_act', args, ['selector'])
          if (action === 'input') requireArgs('wx_mp_act', args, ['value'])
          const { result } = await cli.call('automation_element_action', {
            project,
            action,
            selector: args.selector,
            ...(action === 'input' ? { value: args.value } : {}),
            ...(action === 'trigger' && args.type !== undefined ? { type: args.type } : {}),
            ...(action === 'trigger' && args.detail !== undefined ? { detail: args.detail } : {}),
            ...waits,
          }, { signal: exec.signal })
          return { action, project, selector: args.selector, result, hint: 'Verify with wx_mp_screenshot or wx_mp_inspect (page_data / element_text).' }
        }
        if (action === 'page_scroll_to') {
          requireArgs('wx_mp_act', args, ['scrollTop'])
          const { result } = await cli.call('automation_viewport_action', { project, action: 'pageScrollTo', scrollTop: args.scrollTop }, { signal: exec.signal })
          return { action, project, result }
        }
        if (action === 'remote') {
          const { result } = await cli.call('automation_viewport_action', { project, action: 'remote', ...(args.auto === true ? { auto: true } : {}) }, { signal: exec.signal })
          return { action, project, result }
        }
        if (action === 'close_tool') {
          const { result } = await cli.call('automation_viewport_action', { project, action: 'close' }, { signal: exec.signal })
          return { action, project, result, hint: 'This closes the devtools automation view, not the whole IDE.' }
        }
        const cliAction = NAVIGATE_ACTIONS[action]
        if (cliAction === 'navigateBack') {
          const { result } = await cli.call('automation_navigate', { project, action: cliAction, ...(args.delta === undefined ? {} : { delta: args.delta }) }, { signal: exec.signal })
          return { action, project, result }
        }
        requireArgs('wx_mp_act', args, ['url'])
        const { result } = await cli.call('automation_navigate', { project, action: cliAction, url: args.url }, { signal: exec.signal })
        return { action, project, url: args.url, result, hint: 'Take wx_mp_screenshot to confirm the destination rendered.' }
      },
    },

    {
      name: 'wx_mp_eval',
      description:
        'Execute a JS function inside the running mini-program context and return its result. The function source must be a function body string such as '
        + '"function () { return wx.getSystemInfoSync() }". Use it for runtime checks that have no dedicated tool; prefer wx_mp_inspect for page data and element reads.',
      parameters: objectSchema({
        fnSource: { type: 'string', description: 'Function source string, e.g. "function () { return getApp().globalData.user }".' },
        args: { description: 'Optional JSON value passed as the function argument.' },
        project: PROJECT_PROPERTY,
      }, ['fnSource']),
      output: { schema: {}, render },
      execute: async (args, exec) => {
        requireArgs('wx_mp_eval', args, ['fnSource'])
        const project = await projectOf(args, exec)
        const { result } = await cli.call('automation_evaluate', {
          project,
          fnSource: args.fnSource,
          ...(args.args === undefined ? {} : { args: args.args }),
        }, { signal: exec.signal })
        const value = unwrapEvaluated(result)
        return typeof value === 'string'
          ? { project, ...clipStringValue(value, config.maxTextChars) }
          : { project, value: value === undefined ? null : value }
      },
    },

    {
      name: 'wx_mp_publish',
      description:
        'Preview or upload the mini program. preview pushes a preview to the user\'s WeChat; qrcode generates a scannable preview QR code; upload publishes a trial build. '
        + 'upload is a real release action: only call it when the user explicitly asks to upload. '
        + 'Any of these can return status=pending + taskId: that means the IDE is waiting for the user to confirm/scan — do not re-send the action; check wx_mp_task later.',
      parameters: objectSchema({
        action: { type: 'string', enum: ['preview', 'qrcode', 'upload'], description: 'preview = push preview; qrcode = show a preview QR code; upload = publish trial build (explicit user request only).' },
        project: PROJECT_PROPERTY,
        pagePath: { type: 'string', description: 'preview only: page to open, e.g. pages/house/list.' },
        query: { type: 'string', description: 'preview only: URL query string.' },
        scene: { type: 'number', description: 'preview only: scene value.' },
        qrFormat: { type: 'string', enum: ['window', 'image'], description: 'qrcode only: window (default) shows the QR in an IDE window; image returns a QR image path.' },
        uploadVersion: { type: 'string', description: 'upload only: version number, e.g. 1.0.0.' },
        desc: { type: 'string', description: 'upload only: version description.' },
      }, ['action']),
      output: { schema: {}, render },
      execute: async (args, exec) => {
        requireArgs('wx_mp_publish', args, ['action'])
        const action = enumArg('wx_mp_publish', args, 'action', ['preview', 'qrcode', 'upload'], 'preview')
        const project = await projectOf(args, exec)
        if (action === 'preview') {
          const { result } = await cli.call('auto_preview', {
            project,
            ...(args.pagePath === undefined ? {} : { pagePath: args.pagePath }),
            ...(args.query === undefined ? {} : { query: args.query }),
            ...(args.scene === undefined ? {} : { scene: args.scene }),
          }, { signal: exec.signal })
          return { action, project, result, ...pendingFields(result) }
        }
        if (action === 'qrcode') {
          const { result } = await cli.call('create_preview_qrcode', {
            project,
            ...(args.qrFormat === undefined ? {} : { qrFormat: args.qrFormat }),
          }, { signal: exec.signal })
          return { action, project, result, ...pendingFields(result) }
        }
        requireArgs('wx_mp_publish', args, ['uploadVersion', 'desc'])
        const { result } = await cli.call('upload', { project, uploadVersion: args.uploadVersion, desc: args.desc }, { signal: exec.signal })
        return { action, project, result, ...pendingFields(result) }
      },
    },

    {
      name: 'wx_mp_task',
      description:
        'Check the outcome of a pending WeChat DevTools task (authorization, scan login, preview/upload confirmation). '
        + 'Use it with the taskId another wx_mp_* tool returned; polling is cheap and read-only. Do not re-send the original action while the task is pending.',
      parameters: objectSchema({
        taskId: { type: 'string', description: 'taskId returned by a previous pending result.' },
      }, ['taskId']),
      output: { schema: {}, render },
      execute: async (args, exec) => {
        requireArgs('wx_mp_task', args, ['taskId'])
        const { result } = await cli.call('polling_task_result', { taskId: args.taskId }, { signal: exec.signal })
        const status = result !== null && typeof result === 'object' && 'status' in /** @type {any} */ (result) ? /** @type {any} */ (result).status : undefined
        return { taskId: args.taskId, status, result }
      },
    },

    {
      name: 'wx_mp_raw',
      description:
        'Escape hatch for official wechatide tools this plugin does not wrap (login, quit, project import/remove, single-file WXML/WXSS compile, debug cache, wx API call/mock, cloud database/functions/storage, mini-game actions). '
        + 'The dedicated wx_mp_* tools are preferred for the normal dev loop; use this only when the needed capability is not wrapped. '
        + 'Arguments are passed as CLI flags: camelCase keys become --kebab-case, booleans become --flag/--no-flag, objects/arrays become one JSON string. '
        + 'The CLI SILENTLY IGNORES unknown flags (it only reports them in a warnings array), so only pass flags documented by that tool.',
      parameters: objectSchema({
        tool: { type: 'string', enum: RAW_TOOLS, description: 'Official CLI tool name.' },
        args: { type: 'object', description: 'Tool arguments as a JSON object, e.g. {"project":"...","name":"x"}. The project is injected when omitted for project-scoped tools.' },
        project: PROJECT_PROPERTY,
      }, ['tool']),
      output: { schema: {}, render },
      execute: async (args, exec) => {
        requireArgs('wx_mp_raw', args, ['tool'])
        const tool = enumArg('wx_mp_raw', args, 'tool', RAW_TOOLS, 'project_list')
        const rawArgs = args.args !== null && typeof args.args === 'object' && !Array.isArray(args.args) ? /** @type {Record<string, unknown>} */ (args.args) : {}
        const flags = { ...rawArgs }
        if (!RAW_PROJECTLESS.has(tool) && flags.project === undefined) flags.project = await projectOf(args, exec)
        const { result, warnings } = await cli.call(tool, flags, { signal: exec.signal })
        return {
          tool,
          ...(typeof flags.project === 'string' ? { project: flags.project } : {}),
          result,
          ...(warnings.length === 0 ? {} : { warnings }),
          ...pendingFields(result),
        }
      },
    },
  ]

  return definitions.map(definition => ({ ...definition, execute: bounded(definition.execute) }))
}

/**
 * Surface a pending-task marker when the CLI result is waiting for a human.
 * @param {unknown} result - CLI result.
 * @returns {{ pending: true, taskId: string, note: string } | Record<string, never>} extra fields.
 */
function pendingFields(result) {
  const pending = pendingTaskOf(result)
  if (pending === undefined) return {}
  return {
    pending: true,
    taskId: pending.taskId,
    note: 'WeChat DevTools is waiting for the user to confirm or scan in the IDE. Do not re-send the action; call wx_mp_task with this taskId later.',
  }
}
