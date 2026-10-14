# @liyuera/dsh-chrome-browser

Chrome 浏览器控制插件(host + 浏览器半边):通过 Chrome 扩展桥(默认)或 Chrome DevTools Protocol (CDP) 控制你的 Chrome——列出标签页、读取网页内容、导航、新开标签页、截图、点击、输入文本、执行 JS;`@` 菜单里列出实时标签页(标题 + URL),选中即把该标签页插进当前这条消息,AI 就在那个标签页里工作。零浏览器自动化运行时依赖(Node 内建 fetch / WebSocket / child_process)。

## 功能

| 工具/入口 | 说明 |
| --- | --- |
| `chrome_tabs` | 列出你的 Chrome 所有标签页(id/title/url/active) |
| `chrome_read` | `mode: 'text'`(默认)读标题、URL 与可见文本(**窗口 + 续读游标**,可选 HTML);`mode: 'interactive'` 列出可交互元素及其状态(见下) |
| `chrome_navigate` | 标签页导航到 URL(默认等待 `readyState=complete`) |
| `chrome_open` | 新开前台标签页;**默认等加载完成**(`readyState=complete`,上限 `waitLoadMs`)后返回,返回的标题已是加载后的标题。**URL 只接受 http/https/file**,其它 scheme 在开标签页**之前**就报错 |
| `chrome_close` | 按 id 关闭一个标签页;**`tabId` 必填,不接受 `active`**——关掉用户正在看的那一页几乎总是错的 |
| `chrome_screenshot` | 截图落盘,返回路径/字节数/mime;模型用 `read_image` 查看。**`fullPage: true` 一次拍完整页**,`selector` 只拍某个元素(等同 DevTools 的「截取节点屏幕截图」) |
| `chrome_click` | CSS 选择器 `element.click()`(可选 `all` 批量)。返回**实际派发点击**的元素数(不是匹配到的数量),并报告「存在但不可点」的原因 |
| `chrome_hover` | 悬停到元素上,展开只在 hover 时出现的菜单/工具条 |
| `chrome_type` | 聚焦输入框并输入文本(默认先全选替换) |
| `chrome_select` | 按 **option value**(不是显示文本)选中 `<select>` 的一项;值不存在时**列出可用值** |
| `chrome_press` | 按一个键(可选先聚焦某元素):Enter 提交、Escape 关闭、Tab/方向键切换;**Enter 会显式提交所属表单并报告 `submitted`** |
| `chrome_eval` | 在页面上下文执行 JS 表达式,按值返回(≤200k 字符);**页面 CSP 禁止 `eval` 时自动改走调试通道并在结果里说明**(`world: "debugger"`) |
| `chrome_wait` | 等元素达到某个状态(`visible` / `hidden` / `attached` / `detached`);**`satisfied: false` 表示超时,不是成功** |
| `chrome_console` | 采集/读取某个标签页的控制台(`action: start / read / stop`);**必须在页面出问题之前 start**,含浏览器自身抛的错误(资源加载失败、CSP 拦截) |
| `chrome_request_help` | 停下来请用户做只有人能做的事(登录、验证码、二次验证),等用户答复;`completed: false` 表示用户跳过了,不要重试 |
| `@` 标签页分组 | 在输入框敲 `@` 时列出实时标签页(行内是「标题 + URL」),选中插入一个引用芯片;发送后消息里只有这个引用,标签页的 URL 与 tabId 由宿主注入一条上下文消息给模型 |
| **活动状态条**已经改成**会话标题栏末尾常驻的淡色状态胶囊**。之前放在输入框上方的做法是错的:它只在调用期间出现,而 `chrome_*` 调用多数是毫秒级——一条闪 50ms 的提示不是信息,是抖动,用户根本来不及看。

现在它常驻,并且有完整的生命周期:

| 状态 | 何时 | 显示 |
| --- | --- | --- |
| `Chrome 就绪` | 扩展已连接,空闲 | 淡绿点(最弱的存在感) |
| `点击 · 标签页 7` | 调用进行中 | 绿色脉冲点 + 当前动作 |
| `完成` | 调用成功结束后 2.5 秒 | 绿点 |
| `失败` | 调用失败后 7 秒,悬停显示原因 | 红点 |
| `Chrome 未连接` | 扩展没连上 | 灰点 |
| `扩展待更新` | 扩展在跑旧文件 | 黄点 |

失败停留得比成功久(7 秒 vs 2.5 秒),因为它要求被读;连接类状态**优先于**调用结果——在一个断开的桥上显示「完成」是误导。所有尺寸是**内联样式**,因为一个没生效的样式表曾经让内置的 512px 图标按原尺寸渲染,把标题栏撑满了。
| `/chrome-browser` skill | 注册一个 agent skill:讲清什么时候用、调用顺序、失败怎么办、有哪些边界。模型通过 `skill` 工具读它,你也可以直接敲 `/chrome-browser`。宿主没有 skill 服务时静默跳过,工具照常可用 |

### chrome_read:两个阅读模式

**`mode: 'text'`(默认)** —— 返回页面可见文本的**一个窗口**,不是一个死胡同:

| 字段 | 含义 |
| --- | --- |
| `text` | 从 `offset` 开始的 `readTextLimit` 个码点(默认 30000) |
| `textChars` | 整篇文档的码点数 |
| `offset` | 这个窗口的起点 |
| `nextOffset` | **还有内容时**给出,下次传 `offset: nextOffset` 接着读 |
| `textTruncated` | 是否还有没读到的内容 |

超出预算时 `text` 末尾会附一行说明(如 `…[window 0-30000 of 81000 code points; pass offset=30000 for the rest]`),所以模型能自己发现该继续读,而不是以为页面就这么长。

**`mode: 'interactive'`** —— 列出**可交互元素**,每个带:

| 字段 | 含义 |
| --- | --- |
| `selector` | **可直接喂给 `chrome_click` / `chrome_type`** 的选择器(优先用唯一 id,否则是带 `:nth-of-type` 的短路径,最多 4 层) |
| `role` / `name` | ARIA role(缺省用标签名)与可读名称(aria-label / 文本 / value / placeholder / title / name) |
| `inView` | 中心点是否在视口内 |
| `disabled` | 原生 `disabled` 或 `aria-disabled="true"` |
| `covered` | 中心点命中测试落在别的元素上——真实点击会打偏 |

- 命中判定与 `chrome_click` 的 `warnings` **用的是同一个探针**,所以两处的 `covered` 是同一个意思。
- 无尺寸、`display:none`、`visibility:hidden` 的元素**直接从清单里剔除**(`matched` 仍计入它们,所以 `shown < matched` 说明有元素被剔除)。
- 单次最多 150 条。
- **同一屏信息比 `innerText` 小一到两个数量级,而且读完就能直接操作**——所以在点击/输入之前优先用它。

> 只覆盖**主框架**:iframe 内的元素不在清单里,与 `chrome_read` 的文本限制一致。

### 工具卡片与并发

九个工具都声明了 UI 呈现与会话调度所需的元数据,模型侧收到的 JSON 不受影响:

- **卡片**:调用中显示语义标题(如「读取标签页 42」「导航到 https://…」),完成后换成结果卡片——标签页列表带 ▶ 标记活动页、读取卡片显示页面标题与字符数(可交互模式显示元素清单与禁用/遮挡标记)、截图卡片显示文件名与大小。`chrome_type` 的调用与结果卡片都**不显示输入内容**(可能是密码)。
- **并发**:`chrome_tabs` 与 `chrome_read` 声明为并发安全,可与其他调用并行;其余七个要么改页面要么独占扩展桥,保持串行。DSH 的调度器对「未声明」一律按独占处理,所以这里是显式声明「哪些能并行」,而不是显式禁止。

### chrome_click 的返回值:派发 ≠ 生效

`element.click()` 会**绕过命中测试**——它能在真实指针永远到不了的元素上触发。所以 `chrome_click` 区分两件事:

| 字段 | 含义 |
| --- | --- |
| `matched` | 选择器匹配到几个元素 |
| `clicked` | 其中几个**实际派发了点击事件** |
| `warnings[]` | 派发了、但真实用户点不到的原因 |

- **原生 `disabled` 的元素不派发事件**,因此不计入 `clicked`;全都禁用时调用直接抛错,而不是返回一个假的成功。
- 不可见(无尺寸 / `display:none` / `visibility:hidden`)、视口外、被其他元素遮挡(中心点命中测试落在别处)、`aria-disabled="true"` 的元素**仍会派发**,但会在 `warnings` 里逐条说明。
- 结果卡片同样显示这些警告(带 ⚠),`已点击 1/5 个元素` 这种标题表示选择器比预期宽。

**看到 `clicked` 不等于页面有反应。** 页面没变化时先看 `warnings`,再用 `chrome_read` 确认状态。

### chrome_console:采集必须在出问题之前开始

```
chrome_console { action: 'start', tabId }        ← 先开
chrome_navigate / chrome_click / 让用户复现        ← 再做
chrome_console { action: 'read', tabId }         ← 再看
chrome_console { action: 'stop', tabId }         ← 收尾
```

- **不回溯**:没 start 之前发生的事不会补记,`read` 会直接报错提示你先 start。
- **含浏览器自己抛的消息**:资源加载失败、CSP 拦截、弃用警告——这些不是页面的 `console.*` 调用,任何「包装 `console`」的方案都拿不到。这也是这里用调试器而不是注入脚本的原因。
- **续读用游标**:`read` 返回 `cursor`,下次传 `since: cursor` 就只拿新增的,不会重复。
- **内存有硬上限,且与运行时长无关**:见下。

#### 采集占多少内存

| 界 | 值 |
| --- | --- |
| 单条文本 | 4096 字符(超出截断并标记) |
| 单标签页条数 | 200(环形,丢最旧) |
| 单标签页文本 | 256 KB 字符 |
| 同时采集的标签页 | 5(起第 6 个时释放最久未用的) |

**进程内上限 = 5 × 256 KB ≈ 1.25 MB(ASCII)~ 2.5 MB(中文)**,跑多久都是这个数——界是条数 + 字节数,**不是时间**。时间上界约束不了内存:一个 `while(true) console.log()` 两秒就能写出几十万条。

- 单条超大日志**不会冲掉整个缓冲**:只保留它的头部加截断标记。
- `read` 返回的 `dropped` 告诉你读之前淘汰了多少条,避免把「最近 200 条」误当成全部。
- **不落盘**:缓冲只在宿主进程内存里,不写会话日志。只有模型显式 `read` 回来的内容才会进入对话记录——和 `chrome_read` 的暴露面一样。
- `stop`、插件卸载、标签页关闭都会释放缓冲。

#### 采集的代价

扩展后端用 `chrome.debugger` 附着到被采集的那个标签页,所以**只有那一个标签页顶部会出现 Chrome 的「已开始调试此浏览器」提示条**,`stop` 后消失。模型不会对你没让它采集的标签页这么做。

CDP 后端不涉及扩展,直接在一次长驻 CDP 会话上订阅事件。

> ⚠️ **升级到本版本后必须重新加载扩展**(`chrome://extensions` → 重新加载)。扩展新增了 `debugger` 权限,Chrome 不会自动授予。


### 交互原语:wait / hover / press / select

**`chrome_wait`** —— 现代页面是异步渲染的,「读完再点」会读到还没出现的元素。之前只能自己用 `chrome_eval` 轮询,现在:

```
chrome_wait { selector: '#result', state: 'visible', timeoutMs: 10000 }
```

| `state` | 含义 |
| --- | --- |
| `visible`(默认) | 存在、有布局盒、且不是 `display:none` / `visibility:hidden` |
| `hidden` | 不存在,或不可见 |
| `attached` / `detached` | 只看存在性,不看可见性 |

- **`satisfied: false` 表示「超时了」,不是「成功了」** —— 用它之前先看这个字段。
- 每 100ms 轮询一次;上界默认 10000ms、最大 300000ms。
- 后端无关:CDP 用一条会话轮询,扩展桥走既有的 `eval` 通道。

**`chrome_hover`** —— 展开只在悬停时出现的菜单、工具条、操作行:

```
chrome_hover { selector: '#row-menu' }
```

- 事件是**合成的**:会送达页面挂的监听器,但**不会设置浏览器自身的 hover 状态**——纯靠 CSS `:hover` 规则显示的元素可能仍然不出现。两个后端行为一致(扩展桥拿不到真实指针输入)。
- 典型用法:`chrome_hover` → `chrome_read { mode: 'interactive' }` 看展开了什么。
- 选择器没有匹配时直接抛错,不返回假的成功。

**`chrome_press`** —— 按键:

```
chrome_press { key: 'Enter', selector: '#search' }   // 先聚焦再按
chrome_press { key: 'Escape' }                       // 按在当前焦点上
```

- 合成键盘事件**不触发浏览器的默认行为**:输入框里按 Enter 既不会插入换行也不会提交表单。所以表达式在按下后**显式调用所属表单的 `requestSubmit()`**,并把这件事报成 `submitted: true`。
- 同时带上 `keyCode`(13/27/9/方向键…),因为仍有库在读这个废弃字段。
- 三个事件 `keydown` / `keypress` / `keyup` 都会派发。
- 聚焦 `Tab`、关闭浮层的 `Escape` 会让页面自己处理,`submitted` 保持 `false`。

**`chrome_select`** —— 下拉选择,按 **option 的 `value`** 而不是显示文本:

```
chrome_select { selector: '#country', value: 'CA' }
```

- 通过**原型 setter** 设值并派发 `input` + `change`,所以受控组件会更新。
- **值不存在时不报成功**:直接抛错并列出可用值 —— `has no option with value "XX"; available values: US, CA`。
- 目标不是 `<select>` 时明确说明,并指向 `chrome_type` / `chrome_click`。

### chrome_request_help:撞到登录墙时停下来问人

```
chrome_request_help { reason: '请在打开的 example.com 页面里登录,然后选「已完成,继续」' }
```

模型撞到登录页/验证码/二次验证时,**之前只能干瞪眼或者乱试**。现在它会停下来问你,并在你答复后继续。

| 返回 | 含义 |
| --- | --- |
| `completed: true` | 你已经做完了 → 模型应**重新读一次页面**再决定下一步 |
| `completed: false` | 你选了「跳过」,或直接关掉了提问 → 模型**停止这条路径**,不要反复重试 |
| `note` | 你补充的说明(如果有) |

- 问题只给**两个**选项,所以**空答复或未知答复一律算「没完成」**——不会把「用户没回答」读成「用户同意了」。
- 走 DSH 的 `ctx.userQuestions` 服务。**宿主没有这个服务时**(精简组合、或被委派的子 agent 调用),工具会明确报错说明无法联系用户,而不是假装成功或挂住。
- 委派的子 agent 提问会被告知「子 agent 没有人工应答者」,这是宿主的策略,插件不绕过。

### 活动状态条:让用户看见 Agent 在干什么

插件在你的浏览器里操作时,**DSH 界面里原本没有任何指示**——用户只能盯着自己的页面看它自己变化。

现在输入框上方会出现一条状态条,**只在真的有工具在跑时**出现:

```
● 🟢 点击   标签页 7
```

- **空闲时完全不渲染**——常驻徽章是噪音,而每次调用的细节已经在对话里的工具卡片上。
- 数据来自插件自己的 `GET /chrome-browser/activity?sessionId=…`:`ctx.tools.register` 的每个定义都被包了一层,执行期间登记、结束即释放。
- 客户端每秒探一次(走 900ms 缓存),因此**每个打开的会话视图**都有一条本地回环 GET。宿主不可达时状态条保持隐藏,不闪错误。
- `chrome_request_help` 在跑时显示「等待你操作」——这正是需要用户抬头的时刻。
- 状态**不落盘、不进模型请求**:它只影响界面。

## 浏览器连接模式

**默认 = 扩展后端(推荐)**:控制的就是你**日常运行的 Chrome 本身**——不重启、不复制 profile、无额外窗口。扩展的获取与加载步骤见[安装 → 2. 装配套 Chrome 扩展](#2-装配套-chrome-扩展)。

改了 `extension/` 里的文件后,**从 0.5.0 起插件会自己让扩展重载**——见下。

### 扩展的自动更新

Chrome 不会重读「加载已解压」扩展的文件,所以插件自己补了一条握手:

1. 扩展连上时(以及每 20 秒一次心跳)自报三样东西:「**自己这份代码的指纹**」(`BUILD_HASH`,一个烤进 service worker 的常量)、`manifest.version`、以及它能处理的 op 列表;
2. 宿主对**包内 `extension/` 的文件**算出同样的指纹(文件名 + `0x00` + 内容,按名排序);
3. 不一致且扩展支持 `reload` → 宿主请它 `chrome.runtime.reload()`,Chrome 从磁盘重读,新代码生效。

**为什么指纹必须是常量,不能在扩展里现算**:实测过——`fetch(chrome.runtime.getURL(...))` 在 service worker 里读到的是**磁盘上的文件**,不是 Chrome 已加载的那份。运行时自算指纹会**每次都报新值**:宿主以为扩展是最新的,而用户实际跑着旧代码,毫无迹象。只有随着已加载代码一起被读出来的常量才能说明「现在跑的是哪份」。

指纹由 `npm run extension:stamp` 写入;忘了盖章时 `tests/extension-package.spec.ts` 会直接失败,所以这不是一件需要记的事。**实测过 `chrome.runtime.reload()` 确实从磁盘重读**(不只是 manifest,service worker 也是),而 worker 被 Chrome 唤醒**不会**重读。

于是 **npm 升级插件后不用再碰 `chrome://extensions`**。

- **同一个指纹只问一次**:如果某次 `reload` 没能读到新文件(比如目录被换掉),宿主不会反复重载——它会停下并在 `/chrome-browser/ext/status` 里报 `stale: true`、`autoReloadAsked: true`,此时需要手动重载一次。换了一个指纹(又一次升级)则会重新尝试,所以同一进程内的多次升级都能落地。
- **能力检查**:宿主只会发扩展自报支持的 op。扩展文件比插件旧时直接报「扩展不支持 X,请在 chrome://extensions 重新加载该扩展」,而不是让扩展回一个 `unknown op` 这种看不出原因的内部错误。
- **首次安装仍需手动**:Chrome 没有以编程方式安装解压扩展的接口,新用户在 `chrome://extensions` 加载一次是绕不过去的(除非上架 Chrome 应用商店)。

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

工具卡片与并发分类是**宿主 + 客户端**的呈现信息,不进入模型请求:模型拿到的是与以前逐字节相同的八个工具 JSON 结果与同一组 tool schema。skill 正文只在被调用时加载,目录里常驻的只有一行 description。

## 开发

```sh
npm install --no-save --legacy-peer-deps  # 首次:本地 react/@types 供客户端构建
npm run build                             # tsc -b --force + tsdown(客户端 bundle 到 lib/client.js)
npx vitest run                            # 单测
npm run typecheck:tests                   # 类型检查 src + tests
DSH_CHROME_SMOKE=1 npx vitest run tests/smoke.spec.ts   # headless Chrome 全链路 + user 模式路径
```

构建产物 `lib/`(含 `lib/client.js` 浏览器 bundle)提交进本仓库,安装即用,无需在目标机器构建。

**为什么需要 `typecheck:tests`**:`tsc -b` 只编译 `src`,而 vitest 只转译不做类型检查——所以测试里的假实现和真实接口漂移**不会报错**,只在某个用例恰好走到那条路径时才炸。这个检查已经抓到过:假后端漏了新增的接口方法、路由改了参数个数但调用点没跟上、`fakeProc` 定义在别的 `describe` 里(闭包捕获了名字却从未被调用,于是用例一直「通过」)。它只看本包的诊断——`paths` 别名会把 harness 其他项目的源码拉进同一个程序,那些错误属于它们自己的构建。

## Known Limitations and Deferred Work

- **`@` 菜单插入的是引用,不是绑定**:选中一个标签页只插入引用芯片,**不绑定会话**,
  所以没有「本会话选中的标签页」这回事。`chrome_*` 省略 `tabId`(或写 `active`)时用的是
  **用户当前正在看的那个标签页**——用户明确指定页面时不要省略,模型应当用注入上下文里的 `tabId`。
  (原先的 `TabPicker` 组件、`SessionBindings` 与 `/chrome-browser/select`、`/chrome-browser/state`
  两个路由只服务于这条已废弃的绑定,已一并删除。)
- **引用靠标题匹配**:注入的上下文按 `@"标题"` 去实时标签页里找同名标签页,同名多个时列出全部候选让模型确认;发送前被关掉的标签页不注入上下文(引用仍在,但模型需要自己调 `chrome_tabs`)。
- **消息里的引用芯片由宿主按文本形状投影**:`@"名字"` 在宿主的消息投影(`projectUserText`)里是"文件型"引用——带文件图标,且在传了 `openFile` 的页面上可点击,点击会走宿主「打开文件」流程(找不到同名文件会报错)。这是宿主对任何 `@名字` 文本的通用规则,插件层没有别的形状可选。
- **带空格的文件引用与本插件的引用同形**:两者都是 `@"…"`;匹配不到任何在开的标签页时本插件不注入任何东西,所以不会污染文件引用的消息。
- **`@` 分组最多渲染 50 行标签页**,更靠后的标签页要靠输入关键词(标题或 URL 都能匹配)过滤出来。
- **Chrome 未连接时 `@` 分组不出现**:扩展未安装/未打开时列表抓取失败,只在控制台留一条记录,不占菜单空间;原因查询走 `/chrome-browser/ext/status`。
- **owned 模式重启 dsh 后需首次调用恢复窗口**:专用 Chrome 的窗口在 dsh 重启后不会自动弹出,第一次使用工具/选择器时拉起(profile 持久化,标签页都在)。
- **user 模式只支持手动带调试端口启动的 Chrome**:插件不自动接管、不重启;`autoRelaunch` 打开时仍建议先把 dsh 界面移到别的浏览器再使用。
- **点击/输入是 DOM 事件 + CDP Input**:不模拟真实指针/MIME 手势,对依赖真实 pointer 事件或 iframe/shadow DOM 深层结构的页面不完全可靠;这些场景可用 `chrome_eval` 绕过。`chrome_click` 已把「派发了但真实用户点不到」的情形报进 `warnings`,但**警告是启发式**:命中测试在 shadow DOM 内按元素自己的 root 进行,闭合 shadow root 与 iframe 内部无法判定。
- **等加载有上限,超时不报错**:`chrome_open` / `chrome_navigate` 默认等 `readyState=complete`,但最多等 `waitLoadMs`(默认 8000)。长轮询页面、挂住的资源不会等到底——到点就返回当前状态,由模型读一次再决定。要等**某个元素**出现就用 `chrome_wait`(同样超时不报错,靠 `satisfied` 判断)。
- **`chrome_hover` 是合成事件**:送达页面监听器,但不设置浏览器自身的 hover 状态,纯 CSS `:hover` 显示的元素可能仍不出现。
- **键盘、指针与下拉的保真度有上限**:`chrome_press` 的按键、`chrome_hover` 的指针、`chrome_select` 的赋值都是**合成事件**——送达页面监听器,但不产生浏览器默认行为。Enter 提交靠显式 `requestSubmit()` 兜底;依赖真实按键序列(组合键、输入法)或真实指针的组件仍可能不响应,这些场景退回 `chrome_eval`。
- **页面 CSP 会改变 `chrome_eval` 的执行通道**:`script-src` 里没有 `'unsafe-eval'` 的站点(GitHub 就是)主世界不能 `eval`,插件会自动改走 **`chrome.debugger` 的 `Runtime.evaluate`**(和 CDP 后端同一条路)并在结果里报 `world: "debugger"`。**代价是该标签页会出现调试提示条**,且已打开 DevTools 时无法附着——所以它只是回退,默认仍走无感的普通注入。
- **`chrome_eval` 的失败是错误,不是 `null`**:语法错误、运行时异常、CSP 拦截以前都会静默变成 `null`,现在会带着原始信息报错。
- **`chrome_open` 拒绝它驱动不了的 scheme**:`data:`、`chrome:`、`devtools:` 这类页面扩展注不进去,以前会**先把标签页建出来再失败**——那个标签页读不了、跑不了 JS、连导航走都不行。现在在创建前就报错,不留僵尸标签页。`file:` 可以开,但**它依赖一个浏览器设置**:扩展默认没有文件访问权限,要在 `chrome://extensions` 里为该扩展打开「允许访问文件网址」;没开的话 `file://` 页面会和 `data:` 一样读不到(本机已开启,实测 `chrome_open file://` + `chrome_read` 正常)。CDP 模式没有这个限制。
- **`about:blank` 只能开、不能导航过去**:扩展注不进空白页,所以空白标签页读不了、点不了、跑不了 JS。`chrome_open` 允许开一个(当**临时中转页**用,随后 `chrome_navigate` 走),并且**不会等它加载**(没东西可等);但 `chrome_navigate` 拒绝导航到 `about:blank`——那会丢弃页面上原有的内容,只剩一个谁也读不了的标签页。
- **`chrome_close` 不猜目标**:`tabId` 是必填的精确 id。省略或写 `active` 都会报错——关掉「用户当前正在看的标签页」几乎总是错的。关闭窗口的最后一个标签页会连带关闭该窗口。
- **扩展自动更新依赖 `chrome.runtime.reload()` 能读到磁盘上的新文件**:这是该 API 的预期行为,但已加载的解压扩展由 Chrome 缓存,所以插件**只尝试一次**并在失败时明确报告,而不是无限重载。状态见 `/chrome-browser/ext/status`。
- **`chrome_screenshot` 默认只拍视口**:整页要显式传 `fullPage: true`(一次调用完成,不要靠滚动拼接——拼接会重复固定元素、接缝错位,而且很难对齐)。`selector` 拍单个元素,元素在首屏之下也照样能拍对。
- **`chrome_screenshot` 会在该标签页显示调试提示条**:它走 `chrome.debugger` 的 `Page.captureScreenshot`(与 CDP 后端同一条路),因此在标签页处于后台时照样可用,也**不会返回陈旧帧**。代价是 Chrome 在该标签页顶部显示「正在调试」提示条,且已打开 DevTools 时无法附着(会明确报错)。如果该标签页已被 `chrome_console` 采集,则复用同一会话,不产生第二次附着。
- ~~截图要求窗口可见~~:旧实现走 `chrome.tabs.captureVisibleTab`,窗口被遮挡时报 `image readback failed`,窗口停止重绘时**返回上一帧**(实测两张相隔数秒的截图逐字节相同,而返回的路径与字节数不会告诉你它是陈旧的)。已改为调试通道。
- **活动状态条是轮询的**:客户端每秒发一次本地回环 GET。将来若接入会话事件流可以去掉轮询,目前用的是插件已有的路由机制。
- **人工求助依赖宿主的提问服务**:`chrome_request_help` 在 `ctx.userQuestions` 缺席的组合、以及被委派的子 agent 里不可用(会明确报错)。
- **文本读取只覆盖主框架**的 `innerText`(iframe 内容不在其中)。
- **控制台采集会丢两类内容**:桥断开期间产生的消息直接丢弃(缓冲在宿主,收不到就没有);扩展 service worker 被 Chrome 挂起时采集会中断,重连后自动重新附着,但中断窗口内的消息不补。用 `dropped` 和「有没有 start 过」来判断你看到的窗口是否完整。
- 不暴露网络拦截(只有控制台里那部分错误文本)、性能追踪、多窗口管理等更宽的 CDP 能力。
- 截图默认写入系统临时目录,随系统清理。
- 每次工具调用为每个标签页新建一次 CDP 会话(约数十毫秒开销),未做连接复用;需要高频操作时可后续加常驻会话层。控制台采集是例外:它持有一条长驻会话。
- 会话标签页绑定是内存态(重启后清空),不做持久化。

## 卸载

```sh
dsh plugin --profile desktop remove @liyuera/dsh-chrome-browser
```

再到 `chrome://extensions` 移除 `dsh Chrome Control` 扩展。卸载插件不会关闭你的 Chrome(CDP 的 owned 专用实例除外)。

## 许可

专有软件,`UNLICENSED`:允许通过 npm 安装并运行本包(全文见包内 `LICENSE`),不授予修改、再分发、再许可或销售的权利。
