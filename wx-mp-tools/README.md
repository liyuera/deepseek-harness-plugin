# @liyuera/dsh-wx-mp-tools · 微信小程序控制（dsh-control-wxMpTools）

让 dsh 直接控制**微信开发者工具**里的小程序模拟器：编译刷新、截图（模型能直接看）、
console/network 日志、页面数据与元素读取、点击/输入/导航、执行 JS、预览/上传。

它解决的是小程序开发里最耗人的那一环：每次改动都要人肉切到开发者工具点编译、看模拟器、
复制报错 —— 现在这些都能由 agent 自己完成并据此继续修。

## 为什么是官方 CLI，而不是自己接 automator

`miniprogram-automator` 协议能用，但要额外依赖、要进自动化模式、能力也覆盖不了 console/network/预览上传。
**微信开发者工具 36.6.0 起自带了官方的 agent 入口** `wechatide`（在 `.app` 包内，官方 skill 也随包发布），
提供 40+ 个原子工具：截图、console/network、元素操作、页面 data、导航、evaluate、编译、预览上传、云开发。

本插件就是这套官方能力的 dsh 适配层：

- **零额外依赖**：只 spawn `wechatide`，不需要 `ws`/`jimp`/`miniprogram-automator`，不需要构建链。
- **不自己实现协议**：官方升级工具集时，插件只需跟进映射。
- **权限模型不变**：首次使用由用户在开发者工具里点一次「允许」，之后复用。

## 安装

```bash
# 本地目录（开发期，改代码即时生效）
dsh plugin --profile desktop add link:/绝对路径/deepseek-harness-plugin/wx-mp-tools

# 或从 npm（发布后）
dsh plugin --profile desktop add @liyuera/dsh-wx-mp-tools
```

也可以在 GUI：设置 → 插件 → 添加插件。装完**重启 dsh**（宿主半边只在启动时加载）。

### 前置条件

1. **微信开发者工具 36.6.0+**（`wechatide` 入口随安装包提供；低于此版本插件会报 `cli-missing`）。
2. 开发者工具已启动且已登录（模拟器要能跑）。
3. 项目已导入 IDE（或用 `wx_mp_window(action=open)` 让插件导入）。

### 首次授权

第一次调用时开发者工具会弹出授权窗口，请点「允许」。流程：

1. 模型调 `wx_mp_status` → 返回 `bridge: "auth-required"`；
2. 模型调 `wx_mp_authorize` → IDE 弹窗；
3. 用户点「允许」；
4. 再调 `wx_mp_status` → `bridge: "ok"`。

授权按 `clientName` 记（默认 `dsh`），换名字会重新弹一次。

## 配置

全部可选，写在 bundle patch 的 `config` 里（见 [cordis.patch.yml](./cordis.patch.yml)）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `clientName` | `dsh` | 开发者工具授权弹窗里显示的名字；改了要重新授权 |
| `cliPath` | 自动探测 | `wechatide` 绝对路径；macOS 默认 `.app/Contents/MacOS/wechatide`，Windows 默认安装目录 `wechatide.cmd` |
| `project` | 自动解析 | 默认小程序项目；留空时按会话工作区 + IDE 项目列表匹配 |
| `token` | 无 | 开发者工具开启「CLI 访问令牌」时才需要；建议用环境变量 `WECHAT_DEVTOOLS_CLI_TOKEN`，不要提交进仓库 |
| `timeoutMs` | `180000` | 单次 CLI 调用上限 |
| `maxTextChars` | `60000` | 单条结果给模型看的文本上限 |
| `skillVersion` | 无 | 仅用于 `check_wechatide_status --skill-version`，一般不用填 |

环境变量：`WECHATIDE_CLI_PATH`、`WECHAT_DEVTOOLS_CLI_TOKEN`。

## 工具

| 工具 | 覆盖的官方工具 | 说明 |
| --- | --- | --- |
| `wx_mp_status` | `check_wechatide_status`、`project_list`、`automation_runtime_info` | 先调它：CLI/登录/授权/项目/当前页一屏诊断 |
| `wx_mp_authorize` | `wechatide auth` | 触发 IDE 授权弹窗；已授权立即返回 |
| `wx_mp_window` | `open_project_window` / `close_project_window` | 打开/关闭项目窗口（打开会顺带导入） |
| `wx_mp_compile` | `simulator_refresh` / `simulator_open_page` / `build_npm` | 刷新、编译并打开指定页、构建 npm |
| `wx_mp_screenshot` | `simulator_screenshot` | 截模拟器 → 返回图片路径，**再用 `read_image` 看** |
| `wx_mp_logs` | `get_simulator_console` / `get_simulator_network` | grep 过滤日志 |
| `wx_mp_inspect` | `automation_runtime_info` / `automation_page_action` / `automation_element_action`（只读） | 页栈、页面 data、querySelector(All)、元素 text/style/wxml/attribute/value |
| `wx_mp_act` | `automation_element_action` / `automation_navigate` / `automation_viewport_action` | 点击、长按、输入、触发事件、滚动、导航、真机调试 |
| `wx_mp_eval` | `automation_evaluate` | 在小程序运行时执行 JS 函数 |
| `wx_mp_publish` | `auto_preview` / `create_preview_qrcode` / `upload` | 预览、二维码、上传体验版（上传需用户明确要求） |
| `wx_mp_task` | `polling_task_result` | 查 pending 任务（授权/扫码/上传确认） |
| `wx_mp_raw` | 其余官方工具 | 逃生舱：登录、项目导入/移除、单文件编译、清缓存、mock wx API、云开发等 |

另外注册一个 `wx-mp` skill：模型在执行小程序调试任务时会先读到工作流、项目路径规则和失败快表。

## 典型闭环

```
1. bash: npm run build:mp-weixin          # 源码构建（uni-app 项目）
2. wx_mp_compile action=refresh           # 让模拟器重编译
3. wx_mp_screenshot                       # 拿截图路径
4. read_image <path>                      # 模型真正看到画面
5. wx_mp_logs command="grep -i error"     # 看报错
6. wx_mp_inspect target=page_data         # 看页面状态
7. wx_mp_act action=tap selector=...      # 复现交互
8. 回到 3 或 6 确认结果
```

## 项目路径怎么解析

`wechatide` 的 `--project` 要求是**微信开发者工具项目列表里的路径**。uni-app/CLI 项目
在 IDE 里登记的通常是**编译产物目录**（如 `dist/build/mp-weixin`），不是源码根目录 ——
传源码根会报 `cant find runtimeid by projectpath`，这个坑很容易误判成"后端没通"。

本插件的解析顺序：

1. 显式 `project` 参数（绝对路径 / 相对会话工作区）；
2. 配置里的 `project`；
3. 会话工作区 cwd 与 IDE 项目列表的交集（cwd 在项目内，或项目在 cwd 内）；
4. cwd 下扫描 `project.config.json`（浅层）；
5. uni-app 常见产物目录（`dist/build/mp-weixin` 等）。

解析不到时错误信息会列出 IDE 里已导入的项目路径，模型据此重试。

## 设计取舍

- **串行调用**：所有 `wechatide` 调用排队执行，IDE 不会同时收到两个自动化命令；超时/中断会杀掉子进程。
- **pending 不是失败**：返回 `pending + taskId` 表示 IDE 在等用户确认，工具会原样返回并提示不要重发，用 `wx_mp_task` 查。
- **截图不内联**：与 chrome-browser 一致，返回文件路径，由模型调 `read_image` 读图；避免大图直接进会话日志。
- **host-only**：第一版不做客户端 UI；状态胶囊/面板可在后续版本加，不影响工具协议。

## 已知限制

- 只覆盖**模拟器**：真机调试只有 `wx_mp_act(action=remote)` 入口，日志/截图仍来自 IDE。
- 官方 CLI 版本强绑定：开发者工具低于 36.6.0 无 `wechatide`，插件报 `cli-missing` 并给下载地址。
- Windows 路径探测覆盖注册表常见位置与 `Program Files` 两种布局，但只在 macOS 实机验证过。
- 上传/预览的确认发生在开发者工具窗口里，聊天里看不到，必须让用户看 IDE。
- 截图路径在系统临时目录；系统清理临时文件后需要重新截图。

## 目录结构

```
wx-mp-tools/
├── package.json          # dsh bundle 清单（无构建、无依赖）
├── cordis.patch.yml      # 挂载行 + 配置示例
├── icon.svg
├── locale/{en,zh}.json   # 插件卡片文案
├── lib/
│   ├── index.js          # plugin 入口：注册工具 + skill + 清理
│   ├── config.js         # 配置默认值与校验
│   ├── cli.js            # wechatide 定位、子进程、JSON 解析、错误分类、串行队列
│   ├── project.js        # 会话 cwd / IDE 项目列表 / 源码根 → 产物目录 解析
│   ├── tools.js          # 12 个 wx_mp_* 工具定义
│   └── skill.js          # wx-mp agent skill
└── test/                 # node --test 单元测试（纯函数 + 工具契约）
```

## 测试

```sh
cd wx-mp-tools && node --test test/
```

测试不依赖微信开发者工具：只覆盖纯函数（flag 映射、JSON 解析、错误分类、项目解析）
与工具定义契约（名称、schema、必填参数校验）。

## 许可

专有软件，保留所有权利。见 [LICENSE](./LICENSE)。
