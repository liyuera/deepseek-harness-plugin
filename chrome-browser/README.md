# @liyuera/dsh-chrome-browser

Chrome 浏览器控制插件(host + 浏览器半边):通过 Chrome 扩展桥(默认)或 Chrome DevTools Protocol (CDP) 控制你的 Chrome——列出标签页、读取网页内容、导航、新开标签页、截图、点击、输入文本、执行 JS;`@` 菜单里列出实时标签页(标题 + URL),选中即把该标签页插进当前这条消息,AI 就在那个标签页里工作。零浏览器自动化运行时依赖(Node 内建 fetch / WebSocket / child_process)。

## 功能

| 工具/入口 | 说明 |
| --- | --- |
| `chrome_tabs` | 列出你的 Chrome 所有标签页(id/title/url/active),并带 `session` 字段(本会话选中的标签页) |
| `chrome_read` | 读取标签页标题、URL、可见文本(`innerText`,按 `readTextLimit` 截断,可选 HTML) |
| `chrome_navigate` | 标签页导航到 URL(默认等待 `readyState=complete`) |
| `chrome_open` | 新开前台标签页 |
| `chrome_screenshot` | PNG 截图落盘,返回路径/字节数/视口尺寸;模型用 `read_image` 查看 |
| `chrome_click` | CSS 选择器 `element.click()`(可选 `all` 批量) |
| `chrome_type` | 聚焦输入框并输入文本(默认先全选替换) |
| `chrome_eval` | 在页面上下文执行 JS 表达式,按值返回(≤200k 字符) |
| `@` 标签页分组 | 在输入框敲 `@` 时列出实时标签页(行内是「标题 + URL」),选中插入一个引用芯片;发送后消息里只有这个引用,标签页的 URL 与 tabId 由宿主注入一条上下文消息给模型 |

## 浏览器连接模式

**默认 = 扩展后端(推荐)**:控制的就是你**日常运行的 Chrome 本身**——不重启、不复制 profile、无额外窗口。扩展的获取与加载步骤见[安装 → 2. 装配套 Chrome 扩展](#2-装配套-chrome-扩展)。

改了 `extension/` 里的文件后,必须在 `chrome://extensions` 点该扩展的「重新加载」才会生效——Chrome 不会自动重读已加载的解压扩展。

之后扩展通过本地 WebSocket(`/chrome-browser/ext/ws`)与插件通信:列真实标签页(自带站点图标)、读取/点击/输入/求值/导航/新开/截图。扩展没连上时 `@` 菜单不出现标签页分组,`/chrome-browser/ext/status` 会报 `connected:false`。

**CDP 后端(可选,`backend: 'cdp'`)**——原有能力保留:

- **owned 模式**:插件第一次使用工具时启动**独立 Chrome**(专用 profile 持久化在 `$DSH_HOME/chrome-browser/profile-<port>`,窗口/标签在重启后保留)。你在里面打开什么,AI 就能看什么。插件启动/关闭只作用于这个专用实例,永不触碰你日常浏览器的窗口。
- **user 模式(接管,`autoRelaunch: true` 时)**:由于 **Chrome 136+ 会忽略「标准位置」profile 的 `--remote-debugging-port`**,插件采用 **profile 副本**方案:优雅退出你的 Chrome → 把 profile(排除缓存目录;保留 Cookies/History/登录态)复制到自定义目录 `$DSH_HOME/chrome-browser/profile-copy-<port>` → 以副本 + 调试端口启动,窗口/标签恢复。
  - `autoRelaunch` 默认 **false**:插件绝不自动退出/重启你的 Chrome——dsh 界面可能就运行在同一浏览器里(会循环);你的 profile 已显式打开此开关。第一次连接(约 10-60 秒,取决于 profile 大小)会关闭并复制重启一次;之后的连接是即时的(副本实例常驻,插件不关闭它)。副本实例关闭后,下次连接会重新复制最新 profile。
- 插件卸载时只关闭 owned 专用实例,绝不触碰 user 模式的浏览器(副本不杀,方便你继续浏览)。

> 历史事故说明:早期版本默认 `mode: user` + 直接重启你的 Chrome(不复制、不换目录)——Chrome 136+ 对标准目录忽略调试端口导致连接失败,且当 dsh 界面在 Chrome 里时会形成死循环。现改为 profile 副本方案,`autoRelaunch` 默认关死。

## 安装

分两步:装宿主插件,再装一次配套的 Chrome 扩展。两步都做完重启 dsh 才会工作。

### 1. 装插件

```sh
dsh plugin --profile desktop add @liyuera/dsh-chrome-browser      # 从 npm(GUI:设置 → 插件 → 添加插件)
dsh plugin --profile desktop add link:/绝对路径/deepseek-harness-plugin/chrome-browser   # 从本地目录
```

`desktop` 是桌面应用独占的 profile(源码启动的 `pnpm dsh web` 用 `web`)。两种装法的产物都已构建好,目标机器不需要 `npm install` 或联网。

宿主半边 import `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm/message`,三者都声明在 `peerDependencies`:宿主从自己的安装目录提供,与装好的 dsh 版本一致。`dependencies` 里的包在 `link:` 安装下解析不到——运行时依赖一律写 `peerDependencies`(详见仓库根 README)。

### 2. 装配套 Chrome 扩展

宿主插件靠一条本地 WebSocket 桥(`/chrome-browser/ext/ws`)与 Chrome 通信,**扩展必须手动装一次**(它不在 Chrome 应用商店)。扩展文件随插件包一起发布,两种取法:

**方式 A:从插件自己的下载路由(推荐)** —— 把当前 dsh 地址拼上下载路径,浏览器打开即下载(桌面应用默认 `http://127.0.0.1:19387`,源码启动默认 `http://127.0.0.1:3080`):

```
http://127.0.0.1:19387/chrome-browser/extension.zip
```

命令行等价:

```sh
curl -L -o dsh-chrome-browser-extension.zip http://127.0.0.1:19387/chrome-browser/extension.zip
unzip dsh-chrome-browser-extension.zip     # 得到 dsh-chrome-browser-extension/ 目录
```

**方式 B:从插件安装目录直接取**

```
$DSH_HOME/profiles/<profile>/node_modules/@liyuera/dsh-chrome-browser/extension/
```

(`$DSH_HOME` 默认 `~/.dsh`;Windows 是 `%USERPROFILE%\.dsh`。)

**然后在 Chrome 里加载**:

1. 打开 `chrome://extensions`,右上角开启「开发者模式」;
2. 点「加载已解压的扩展程序」,选择方式 A 解压出的 `dsh-chrome-browser-extension/` 目录(方式 B 就是那个 `extension/` 目录);
3. 打开 dsh 页面。扩展会依次尝试 `ws://127.0.0.1:19387`(桌面应用)与 `ws://127.0.0.1:3080`(源码启动),哪个在跑连哪个,不用改代码;
4. 核对连接:`http://127.0.0.1:19387/chrome-browser/ext/status` 返回 `{"ok":true,"backend":"extension","connected":true}` 即已连上。

两个端口都不是默认值时,改扩展 `service-worker.js` 顶部的 `WS_URLS`,再到 `chrome://extensions` 点该扩展的「重新加载」——Chrome 不会自动重读已加载的解压扩展。

### 3. 重启 dsh

宿主半边(工具、路由、`agent/pre-step` 展开)只在启动时加载——桌面应用退出重开,源码启动则重启 `pnpm dsh web`;浏览器里硬刷新只换得到 `lib/client.js`。

## 配置

通过 profile 的 `cordis.patch.yml`(bundle 行 `config`)覆盖,例如:

```yaml
- insert:
    - id: chrome-browser
      name: '@liyuera/dsh-chrome-browser'
      config:
        backend: extension    # extension(默认,真实 Chrome 通过扩展桥);cdp = DevTools 协议
        port: 9222            # DevTools 端口(cdp 后端)
        mode: owned           # 仅 cdp:owned = 插件专用 Chrome;user = profile 副本接管
        autoRelaunch: false   # user 模式:默认 false,绝不自动重启你的浏览器
        attachOnly: false     # true = 只连已有调试端口,不启动/不关闭
        chromePath: null      # 显式 Chrome 路径;缺省自动检测(macOS/Windows/Linux)
        profileDir: null      # owned 默认 $DSH_HOME/chrome-browser/profile-<port>;user 默认真实 profile
        readTextLimit: 30000  # chrome_read 文本字符预算
        waitLoadMs: 8000      # chrome_navigate 加载等待
        timeoutMs: 15000      # 单命令/就绪超时
        screenshotDir: null   # 默认 <tmp>/dsh-chrome-shots
```

## Model Experience

模型可见的输入/输出只有八个工具 JSON 结果,加上被引用标签页的上下文:每次 `chrome_read` 最多携带约 `readTextLimit` 字符的页面文本;`chrome_screenshot` 只返回文件路径与元数据,页面视觉内容需通过 `read_image` 再读取;`chrome_eval` 结果上限 200k 字符。从 `@` 菜单选中标签页时,客户端在草稿里插入一个引用芯片,它序列化成 `@"标题"`——用户消息里只有这个引用(宿主按文本形状投影成引用芯片),宿主随后在用户消息后注入一条本插件的上下文消息(`## Referenced Chrome tabs`),逐个列出被引用标签页的 `tabId` 与 URL,模型照着 id 调 `chrome_*` 即可。同名标签页会列出全部候选并提示向用户确认;引用没有匹配到任何在开的标签页(已关闭,或那其实是带空格的文件路径)时不注入任何东西。插件不做会话级标签页绑定,一次选择只影响它所在的那条消息。本插件不发任何 provider 请求,无 LLM/KV-cache 影响。

## 开发

```sh
npm install --no-save --legacy-peer-deps  # 首次:本地 react/@types 供客户端构建
npm run build                             # tsc -b --force + tsdown(客户端 bundle 到 lib/client.js)
npx vitest run                            # 单测
DSH_CHROME_SMOKE=1 npx vitest run tests/smoke.spec.ts   # headless Chrome 全链路 + user 模式路径
```

构建产物 `lib/`(含 `lib/client.js` 浏览器 bundle)提交进本仓库,安装即用,无需在目标机器构建。

## Known Limitations and Deferred Work

- **composer 上方的标签页选择框已停用**:`@` 分组取代了它。组件与注册代码都留在原处(`src/client/TabPicker.tsx` 与 `src/client/index.ts` 的 `TAB_PICKER_VISIBLE`),把常量改成 `true` 即恢复那一行。
- **选中标签页只插入一个引用,不做会话绑定**:`chrome_*` 省略 `tabId` 时不会自动落到这个标签页(原来的 `/chrome-browser/select` 绑定路由仍在,但已无调用方);模型用的是注入上下文里的 `tabId`。
- **引用靠标题匹配**:注入的上下文按 `@"标题"` 去实时标签页里找同名标签页,同名多个时列出全部候选让模型确认;发送前被关掉的标签页不注入上下文(引用仍在,但模型需要自己调 `chrome_tabs`)。
- **消息里的引用芯片由宿主按文本形状投影**:`@"名字"` 在宿主的消息投影(`projectUserText`)里是"文件型"引用——带文件图标,且在传了 `openFile` 的页面上可点击,点击会走宿主「打开文件」流程(找不到同名文件会报错)。这是宿主对任何 `@名字` 文本的通用规则,插件层没有别的形状可选。
- **带空格的文件引用与本插件的引用同形**:两者都是 `@"…"`;匹配不到任何在开的标签页时本插件不注入任何东西,所以不会污染文件引用的消息。
- **`@` 分组最多渲染 50 行标签页**,更靠后的标签页要靠输入关键词(标题或 URL 都能匹配)过滤出来。
- **Chrome 未连接时 `@` 分组不出现**:扩展未安装/未打开时列表抓取失败,只在控制台留一条记录,不占菜单空间;原因查询走 `/chrome-browser/ext/status`。
- **owned 模式重启 dsh 后需首次调用恢复窗口**:专用 Chrome 的窗口在 dsh 重启后不会自动弹出,第一次使用工具/选择器时拉起(profile 持久化,标签页都在)。
- **user 模式只支持手动带调试端口启动的 Chrome**:插件不自动接管、不重启;`autoRelaunch` 打开时仍建议先把 dsh 界面移到别的浏览器再使用。
- **点击/输入是 DOM 事件 + CDP Input**:不模拟真实指针/MIME 手势,对依赖真实 pointer 事件或 iframe/shadow DOM 深层结构的页面不完全可靠;这些场景可用 `chrome_eval` 绕过。
- **文本读取只覆盖主框架**的 `innerText`(iframe 内容不在其中)。
- 不暴露网络拦截、性能追踪、多窗口管理等更宽的 CDP 能力。
- 截图默认写入系统临时目录,随系统清理。
- 每次工具调用为每个标签页新建一次 CDP 会话(约数十毫秒开销),未做连接复用;需要高频操作时可后续加常驻会话层。
- 会话标签页绑定是内存态(重启后清空),不做持久化。

## 卸载

```sh
dsh plugin --profile desktop remove @liyuera/dsh-chrome-browser
```

再到 `chrome://extensions` 移除 `dsh Chrome Bridge` 扩展。卸载插件不会关闭你的 Chrome(CDP 的 owned 专用实例除外)。

## 许可

专有软件,`UNLICENSED`:允许通过 npm 安装并运行本包(全文见包内 `LICENSE`),不授予修改、再分发、再许可或销售的权利。
