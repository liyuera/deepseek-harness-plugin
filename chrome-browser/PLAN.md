# Chrome Browser 插件实现计划

> 将「控制 Google Chrome + 读取标签页与网页内容」能力做成 dsh 插件（用户以 Codex 的浏览器控制插件为参照，
> 已确认按方案 A + 截图工具）。
> 独立仓库：`deepseek-harness-plugin/chrome-browser/`（与 dev-dock 同目录约定，位于 deepseek-harness 工作区根）。
> 完全符合 dsh 插件规范（工具契约、Config 配置面、invariant、README），不引入任何浏览器自动化依赖。

## 0. 功能规格（已与用户确认）

| 编号 | 功能 | 说明 |
|---|---|---|
| F1 | `chrome_tabs` | 列出所有标签页：`id/title/url/active/type`（只列 `page` 类型） |
| F2 | `chrome_read` | 读取指定标签页（缺省活动页）的 `title/url/innerText`；默认截断 30k 字符，可选含 HTML |
| F3 | `chrome_navigate` | 指定标签页导航到 URL，默认等待加载（最多 8s） |
| F4 | `chrome_open` | 新开标签页（可带 URL，前台打开） |
| F5 | `chrome_screenshot` | 指定标签页截图（可选整页），PNG 写入磁盘并返回路径/尺寸/字节数；模型可用 `read_image` 查看 |
| F6 | `chrome_click` | 按 CSS 选择器点击（可选 `all` 批量），返回命中数 |
| F7 | `chrome_type` | 聚焦输入框（选择器），可选先清空，再输入文本 |
| F8 | `chrome_eval` | 在页面上下文执行 JS 表达式（`returnByValue`，结果上限 ~200KB） |

全局规则：

- 插件默认启动**独立 Chrome 实例**（专用 `user-data-dir`，调试端口 9222），不碰用户日常 Chrome；可通过配置改为 **attach 模式**连接一个已用 `--remote-debugging-port` 启动的浏览器（attach 模式下插件不杀死该浏览器）。
- 插件为 **host-only**：不注册任何 Client UI / Slot，纯模型工具。
- 权限走现有模型工具管线（当前会话 full access 直接执行，无额外审批）。
- 平台：macOS 优先；内置 Windows/Linux 常见 Chrome 路径检测。

## 1. 技术决策（已通过架构调查验证）

| 决策点 | 结论 | 依据 |
|---|---|---|
| 插件位置与命名 | `deepseek-harness-plugin/chrome-browser/`，npm 包 `@liyuera/dsh-chrome-browser`，插件 id `chrome-browser` | 插件仓库 README「每个插件一个目录」；dev-dock 先例 |
| 实现机制 | 直接用 **Chrome DevTools Protocol (CDP)**，不用 Puppeteer/Playwright，零额外运行时依赖 | 浏览器控制的标准协议；本仓库插件是普通 Node 包（非动态插件 vm 沙箱），可直接用 Node 内建能力 | 
| 网络栈 | Node 全局 `fetch`（HTTP 端点 `/json/list`、`/json/version`、`/json/new`）+ 全局 `WebSocket`（Page/Runtime/Input/Target 域） | 引擎要求 `node ^22.19 \|\| >=24`，WebSocket 客户端自 Node 22.4 起内建（undici） |
| Chrome 启动 | `child_process.spawn` 带专用 `--user-data-dir`、`--remote-debugging-port=<port>`、`--remote-allow-origins=*`、`--no-first-run`、`--no-default-browser-check`；轮询 `/json/version` 就绪（≤15s） | `node:child_process` 直接使用有插件先例（dev-dock 用 node:fs/child_process）；`--remote-allow-origins` 避免 WebSocket 握手被拒 |
| Chrome 生命周期 | 首次工具调用惰性启动；profile 目录默认 `os.tmpdir()/dsh-chrome-<port>`（重启复用标签页）；插件 dispose 时 SIGTERM→SIGKILL；attach 模式只连不杀 | 简单可控；dev-dock 的「确定性 + 生命周期边界」同类取舍 |
| 配置面 | 插件 `Config`（schemastery）：`port=9222`、`chromePath?`、`profileDir?`、`attachOnly=false`、`readTextLimit=30000`、`screenshotDir=tmp/dsh-chrome-shots`、`waitLoadMs=8000`、`timeoutMs=15000` | dsh 规范「No hardcoded tunables in plugins」；`tool-bash` Config 先例 |
| 工具注册 | `ctx.tools.register(defineTool({ name, description, parameters, output: { schema, render }, execute }))`，`inject: ['tools']` | docs/cookbook/adding-a-tool.md；`tool-cordis`/`tool-bash` 先例 |
| 文本提取 | `Runtime.evaluate` 执行 `document.body.innerText`（可选 HTML 时 `document.documentElement.outerHTML`），服务端截断 | CDP 标准；避免第三方可读性提取库 |
| 截图 | `Page.captureScreenshot({ format: 'png', captureBeyondViewport })` → Buffer → `fs.writeFile`；返回 `{ path, bytes, width, height }` | 文件落盘后模型可 `read_image` 查看，避免大 base64 进模型上下文 |
| 输入 | `Runtime.evaluate` focus + `Input.insertText`；清空 = 全选后替换 | CDP Input 域标准；对 React 等受控组件兼容 |
| 点击 | `Runtime.evaluate` `element.click()` 返回命中数 | 简单可靠；需要真实鼠标事件的场景留 `chrome_eval` 或后续增强 |
| 错误处理 | 统一抛体现的 `Error`（工具管线呈现）；HTTP/WS 超时 15s；端口被占用且非自身实例 → 明确报错并给出 attach 提示 | 工具错误信号约定 |
| 测试 | 纯函数单测（帧解析、表达式构造、截断、参数校验）+ **transport 可注入**的 `CdpClient`（假 transport 单测命令帧/超时/错误）+ `DSH_CHROME_SMOKE=1` 时才跑的 **headless Chrome 全链路 smoke**（默认跳过） | 无内置 WS server；transport 注入让单测不碰真 WebSocket；smoke 用 `--headless=new` 本机真 Chrome 验证 |
| 构建 | 仅 `tsc -b`（host-only，无 client bundle，不需要 tsdown） | dev-dock 的 tsdown 只为 client 面；host 面 `lib/index.js` 直接由 tsc 产出并被 loader 加载 |
| 挂载 | `dsh plugin --profile web add link:<插件绝对路径>`，重启 `dsh web` | `apps/cli/src/plugin.ts`（pnpm 转发 + 自动 reconcile `dsh.profile.bundles`）；根 README 安装节 |
| invariant | 注册 manifest 名，空 installer（无跨插件事件流） | packages/AGENTS.md「Every package owns ./invariant」；dev-dock `invariant.ts` 注释模板 |
| 文档 | PLAN.md（本文）+ README.md（含 Model Experience、Known Limitations and Deferred Work） | dev-dock/ui-subagent-sidebar 先例；packages/AGENTS.md README 要求 |

## 2. 仓库结构

```
deepseek-harness-plugin/chrome-browser/     # @liyuera/dsh-chrome-browser
├── package.json                 # dsh.bundle.patch + peerDeps + exports + main lib/index.js
├── cordis.patch.yml             # insert: { id: chrome-browser, name: '@liyuera/dsh-chrome-browser' }
├── tsconfig.json                # extends ../../tsconfig.base.json + paths（host 面）
├── vitest.config.ts             # alias 解析（复制 dev-dock 模式，删 React/client 面）
├── PLAN.md                      # 本文
├── README.md                    # 功能 / 安装 / 配置 / 工具表 / Model Experience / 已知限制
├── src/
│   ├── index.ts                 # name/inject/Config/apply：注册工具 + Chrome 生命周期挂钩
│   ├── cdp.ts                   # CdpClient：transport 注入（WebSocket 或假实现），send()/帧匹配/超时
│   ├── chrome.ts                # 浏览器发现/启动/attach/就绪轮询/杀死（进程引用追踪）
│   ├── expressions.ts           # 文本/点击/输入/清空的 Runtime.evaluate 表达式构造
│   ├── text.ts                  # innerText 归一化 + 截断（含字符/字节保护）
│   └── invariant.ts             # 注册包名，空 installer
└── tests/
    ├── expressions.spec.ts      # 表达式构造单测
    ├── text.spec.ts             # 截断/归一化单测
    ├── cdp.spec.ts              # 假 transport：帧匹配、超时、错误传播
    ├── chrome.spec.ts           # 假 HTTP fetch：/json/list 解析、就绪轮询、attach/自启分支
    └── smoke.spec.ts            # DSH_CHROME_SMOKE=1：headless Chrome 全链路（tabs/read/navigate/click/type/eval/screenshot）
```

## 3. 实现步骤

1. **M1 骨架**：package.json / cordis.patch.yml / tsconfig / vitest 配置 / invariant / index.ts（空 apply）+ Config。
2. **M2 Chrome 生命周期**：`chrome.ts`（发现→自启或 attach→就绪→进程引用），`index.ts` 挂 ctx.effect 清理。
3. **M3 CDP 客户端**：`cdp.ts`（transport 接口、逐命令 id 匹配、超时）、`expressions.ts`、`text.ts` + 对应单测。
4. **M4 工具**：`chrome_tabs` / `chrome_read` / `chrome_navigate` / `chrome_open` / `chrome_screenshot` / `chrome_click` / `chrome_type` / `chrome_eval`。
5. **M5 验证**：单测全绿 + `DSH_CHROME_SMOKE=1` smoke（本机 headless Chrome 全链路）。
6. **M6 文档 + 挂载**：README.md 定稿；`dsh plugin --profile web add link:<绝对路径>`；重启 `dsh web` 后真实会话验证（用户操作重启，期间不杀当前 GUI 进程）。

## 4. 已知限制（进 README）

- 默认只控制插件自启的独立 Chrome；用户日常 Chrome（未带调试端口启动）无法附加——macOS 上需要在启动参数中带 `--remote-debugging-port` 才能被 CDP 控制（与 Codex 侧浏览器插件的取舍一致）。
- 点击/输入走 DOM 事件 + CDP Input：对依赖真实 pointer 事件或 iframe / shadow DOM 深层结构的页面不完全可靠，可用 `chrome_eval` 绕过或后续增强。
- 不暴露网络拦截、性能、存储等 CDP 更宽能力；不管理多窗口（统一按标签页视图）。
- 截图默认落盘到临时目录，重启操作系统后自动清理。

## 5. v2:在你的 Chrome 里工作 + 会话内选择标签页(已实现 v0.2.0)

### 功能规格(已与用户确认)

| 编号 | 功能 | 说明 |
|---|---|---|
| V1 | **user 模式(默认)** | 连接用户的 Chrome:探测调试端口 → 未开且 Chrome 在跑 → 优雅退出并带 `--remote-debugging-port` + **真实 profile** 重启(窗口/标签/登录态恢复)→ 轮询就绪;`autoRelaunch: false` 时只报错不动浏览器;插件卸载**绝不杀** user 模式浏览器 |
| V2 | 会话内选择标签页 | composer 工具行新增「🌐 标签页」按钮(`conversation.input.left` 槽)→ `shell.overlay` 面板列出真实标签页(标题/URL/过滤)→ 点击绑定本会话 + 注入用户消息「我选择了…请在这个标签页里工作」 |
| V3 | 工具默认页 | `chrome_*` 的 `tabId` 省略时:本会话绑定标签页 → 活动页;`chrome_tabs` 结果里带 `session` 字段(当前绑定) |

### 技术决策(v2)

| 决策点 | 结论 | 依据 |
|---|---|---|
| 连接方式 | 自动重启用户 Chrome 附加调试端口(chrome-devtools-mcp 同款),用户确认为方案 A;`mode: user`(默认)/`owned`(保留 v1 独立实例) | 用户拍板;重启后 session restore 恢复窗口与标签 |
| 平台操作 | `PlatformOps` 接口(探测/优雅停止)注入:`darwin` osascript quit + pgrep、`win32` taskkill、`linux` pkill -TERM | 可单测;dev-dock platform/ 平台注入先例 |
| 真实 profile | `--user-data-dir` 默认 `~/Library/Application Support/Google/Chrome`(darwin)/ LOCALAPPDATA / `~/.config/google-chrome`;`--restore-last-session` 兜底恢复 | chrome-devtools-mcp 惯例 |
| 客户端通信 | 同源 HTTP 路由 `POST /chrome-browser/tabs`、`POST /chrome-browser/select`、`GET /chrome-browser/state`(webServer 服务) | 静态 bundle 无 package-private RPC;dev-dock `/dev-dock/action` 先例 |
| 会话绑定 | `SessionBindings`:内存 Map + 单调序号 LRU(500 上限),工具执行时经 `exec.agent.session.id` 解析 | 瞬态工作提示,不做持久化 |
| 发送给 AI | 客户端选中后 `inputActions.setDraft(消息)+ submit()`(composer 标准动作),消息含标题/URL 与「不传 tabId 默认就是它」提示 | `InputActions` 标准 props(ui-conversation contract) |
| 客户端构建 | 独立 tsdown config 复刻动态通道:`window.__ModuleLoader__.load({id, factory})` 闭包工厂 + CJS + 模块表 externals(`lib/client.js`) | harness `clientBundle` 预设绑定 workspace manifest(`packages/*/*`),出树插件不可直接用;见 tsdown.config.ts 注释 |
| 配置 | 新增 `mode`(user/owned,默认 user)、`autoRelaunch`(默认 true) | schemastery `z.union([z.const(...)])` |

### v2 验证

- 单测 54 + smoke 2(56 全绿):user 模式分支(不重启报错/重启参数/未运行直启/dispose 不杀)、绑定 LRU、路由(列表/绑定/校验/状态)、owned 全链路、user 模式路径(注入 platformOps)。
- 真机验收:重启 `dsh web` → 点「🌐 标签页」→ 首次自动重启 Chrome → 选标签页 → AI 收到消息并工作。
