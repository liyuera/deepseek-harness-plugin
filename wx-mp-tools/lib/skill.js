/**
 * The `wx-mp` agent skill: when to use the WeChat Mini Program tools, the
 * order to call them in, and the failure modes worth knowing before trying.
 *
 * The skill registry is reached structurally, so a composition without
 * `dsh-skill` loses only the catalog entry while the tools keep working.
 * @module @liyuera/dsh-wx-mp-tools/skill
 */

/** Skill name the catalog, the `skill` tool, and `/wx-mp` address. */
export const SKILL_NAME = 'wx-mp'

/** Routing line the catalog shows while the body stays unloaded. */
export const SKILL_DESCRIPTION =
  '控制微信开发者工具里的小程序模拟器：编译刷新、截图、console/network 日志、页面数据与元素读取、点击输入导航、执行 JS、预览上传。'
  + '用户提到微信小程序、开发者工具、模拟器、看效果、报错日志、点一下某个按钮时使用。'

/** Body loaded only when the skill is invoked. */
export const SKILL_CONTENT = `# 微信小程序控制（微信开发者工具）

\`wx_mp_*\` 工具通过微信开发者工具**官方** agent CLI（\`wechatide\`）驱动模拟器：
它读的是用户本机真实打开的开发者工具，不新开进程、不复制项目。
调试闭环：改代码 → bash 构建 → 刷新模拟器 → 截图/日志/运行时取证 → 交互复现 → 再取证。

## 工具一览

| 工具 | 作用 |
| --- | --- |
| \`wx_mp_status\` | **先调它**。CLI 是否找到、登录是否过期、是否已授权、IDE 项目列表、当前会话解析到的项目、模拟器当前页。返回 \`bridge\` 字段说明卡在哪一步 |
| \`wx_mp_authorize\` | 首次使用/授权失效时调用，会在微信开发者工具里弹授权窗口，**请用户点「允许」** |
| \`wx_mp_window\` | 打开/关闭项目窗口（\`open\` 也会把未导入的项目导入 IDE） |
| \`wx_mp_compile\` | \`refresh\` 重新编译当前窗口；\`open_page\` 编译并打开指定页；\`build_npm\` 构建 npm |
| \`wx_mp_screenshot\` | 截模拟器，返回本地图片路径。**必须再调 \`read_image\` 才能看到画面** |
| \`wx_mp_logs\` | 对 console/network 缓冲区执行 grep；\`command\` 必须是 grep 形式 |
| \`wx_mp_inspect\` | 只读取证：当前页/页栈/系统信息、页面 data、querySelector(All)、元素 text/style/wxml/attribute/value |
| \`wx_mp_act\` | 交互：tap/longpress/input/trigger 元素、page_scroll_to、navigate/redirect/back/relaunch/switch_tab、remote 真机调试 |
| \`wx_mp_eval\` | 在小程序运行时执行一段 JS 函数 |
| \`wx_mp_publish\` | preview 推预览、qrcode 出预览二维码、upload 上传体验版（**仅在用户明确要求时**） |
| \`wx_mp_task\` | 查询 pending 任务（授权/扫码/上传确认）的结果 |
| \`wx_mp_raw\` | 逃生舱：登录、项目导入/移除、单文件 WXML/WXSS 编译、清缓存、mock wx API、云开发等未包装工具 |

## 标准流程

1. **\`wx_mp_status\`**——看 \`bridge\`：
   - \`cli-missing\`：让用户安装/更新微信开发者工具，或配置插件 \`cliPath\`。
   - \`devtools-down\`：让用户启动微信开发者工具并保持登录，再 \`wx_mp_authorize\`。
   - \`auth-required\`：\`wx_mp_authorize\`，请用户在弹窗点「允许」；有 \`taskId\` 就用 \`wx_mp_task\` 查，别重复发起。
   - \`ok\`：看 \`project.windowOpen\`；为 false 先 \`wx_mp_window(action=open)\`。
2. **项目路径**：工具自动把「会话工作区 / 源码根目录」映射到 IDE 里的项目路径。
   uni-app/CLI 项目在 IDE 里是**编译产物目录**（如 \`dist/build/mp-weixin\`），不是源码根；
   传源码根也能解析，但拿不准时直接传 \`wx_mp_status\` 里的 \`project.path\`。
3. **构建**：源码改动先用 bash 跑项目自己的构建（例如 \`npm run build:mp-weixin\`），
   再 \`wx_mp_compile(action=refresh)\`。刷新成功只代表「已触发」，**不等于编译通过**。
4. **看画面**：\`wx_mp_screenshot\`（需要等元素就传 \`waitForSelector\`）→ \`read_image\` 读返回的 path。
   截图返回的是文件路径，不读图片你等于没看。
5. **看日志**：\`wx_mp_logs({kind:'console', command:'grep -n .'})\`；查错误用 \`grep -i error\`。
   空结果 = 没有匹配行，**不代表** console 为空。
6. **交互复现**：先 \`wx_mp_inspect({target:'query_all', selector:'...'})\` 拿到真实 selector，
   再 \`wx_mp_act\`；操作后重新截图/查 page_data 确认，别假设成功。
7. **深挖**：页面状态用 \`wx_mp_inspect({target:'page_data', dataPath:'...'})\`；
   页面方法用 \`wx_mp_raw({tool:'automation_page_action', args:{action:'callMethod', ...}})\`；
   运行时表达式用 \`wx_mp_eval\`。

## 关键约束

- **只覆盖开发者工具里的模拟器**，不是真机；真机调试只有 \`wx_mp_act(action=remote)\` 这一个入口。
- **截图是文件路径**，视觉内容必须用 \`read_image\` 读；路径通常在系统临时目录。
- **一次只允许一个 IDE 自动化操作**；工具内部已串行，不要用 bash 并发调 \`wechatide\`。
- \`wx_mp_publish\` 可能返回 \`pending + taskId\`：这是等用户在 IDE 确认/扫码，**不要重发**，用 \`wx_mp_task\` 查。
- \`wx_mp_act(action=close_tool)\` 会关掉开发者工具的自动化视图，**不是** 用户要求的别调。
- 不要在用户没明确要求时 \`upload\`；不要连续无差别 \`refresh\`；不要 tap 破坏性按钮（删除/提交/支付）除非用户要求。
- 不要试图绕过授权、猜 CLI 令牌，也不要读开发者工具本地配置里的 token。

## 失败快表

| 现象 | 原因与做法 |
| --- | --- |
| \`cant find runtimeid by projectpath\` | 传的是源码根，IDE 里登记的是产物目录；用 \`wx_mp_status\` 的 \`project.path\`，或让其解析。也可能是项目窗口没开 → \`wx_mp_window(action=open)\`。 |
| \`PROJECT_CONFIG_JSON_ERROR\` | 路径里没有有效 \`project.config.json\`；确认传的是小程序项目目录。 |
| \`需要先在微信开发者工具授权\` | 调 \`wx_mp_authorize\`，请用户点「允许」。 |
| \`微信开发者工具未运行\` / \`CONNECT_ERROR\` | 让用户启动 IDE 并登录；\`wechatide\` 服务随 IDE 启动。 |
| \`tokenRequired\` / 令牌错误 | 让用户到 IDE「设置 → 安全」复制 CLI 访问令牌，填插件配置 \`token\` 或环境变量 \`WECHAT_DEVTOOLS_CLI_TOKEN\`。**不要猜**。 |
| grep 结果为空 | 没有匹配行；放宽 pattern 或 \`grep -n .\`。 |
| 截图为空/旧画面 | 先 \`wx_mp_compile(action=refresh)\`；需要等渲染就传 \`waitForSelector\`，别靠固定 sleep。 |
| 找不到元素 | 先 \`query_all\` 核对选择器；WXML 可在 \`element_wxml\` 里看真实结构。 |
| pending task 一直 pending | 用户在 IDE 里还没确认；提醒用户，然后 \`wx_mp_task\` 再查，不要重发写操作。 |

## 边界（先知道，少走弯路）

- 该 CLI 是微信开发者工具 36.6.0+ 才有的入口；低于此版本会报 cli-missing。
- macOS 路径 \`/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide\`；Windows 为安装目录下 \`wechatide.cmd\`。
- \`command\` 参数必须是 grep 命令字符串（不含文件名），不是枚举；传 \`all\` 会自动换成 \`grep -n .\`。
- 页面 automation 会真实触发事件；在用户正在操作的窗口里点东西前先确认目标。
- 上传/预览的确认框在开发者工具里，聊天里看不到，必须让用户看 IDE。
`

/**
 * Publish the skill once a skill registry exists in this composition.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's Cordis context.
 */
export function registerWxMpSkill(ctx) {
  ctx.inject(['skills'], (scoped) => {
    const skills = scoped.get('skills')
    if (skills === undefined) return
    scoped.effect(() => skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      content: SKILL_CONTENT,
      source: 'runtime',
      invocation: { modelInvocable: true, userInvocable: true },
    }), 'wx-mp-tools: skill')
  })
}
