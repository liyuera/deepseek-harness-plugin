# deepseek-harness-plugin

DeepSeek Harness (dsh) 插件集。每个插件一个目录，目录名即插件名，npm 包名见下表；每个插件都能独立安装，互相不依赖。

本仓库设计为放在 deepseek-harness 工作区根目录下（`deepseek-harness-plugin/`），
构建时借用 harness 的客户端构建设施；插件代码与 fork 的版本库完全分离。

## 插件列表

| 目录 | npm 包名 | 0.2.0 | 说明 |
| --- | --- | --- | --- |
| [`dev-dock/`](dev-dock/) | `@liyuera/dsh-dev-dock` | ✅ 已移植 | devDock v1.0.0：项目 = dsh 工作区；开始上班弹窗、会话头部 IDE/终端/启动（确定性桌面动作）、每工作区 IDE 偏好与编辑器检测（真实应用图标） |
| [`chrome-browser/`](chrome-browser/) | `@liyuera/dsh-chrome-browser` | ✅ 已移植 | Chrome 浏览器控制:扩展桥(默认)或 CDP 驱动你已打开的 Chrome——列标签页/读网页内容/导航/新开/截图/点击/输入/执行 JS、调用页面声明的 WebMCP 工具;`@` 菜单列出实时标签页(标题 + URL),选中插入引用芯片,AI 在该页面工作 |
| [`ui-favorite-prompts/`](ui-favorite-prompts/) | `@liyuera/dsh-favorite-prompts` | ✅ 已移植 | 消息下方一键收藏、`@` 拉出收藏并整段插入、设置页增删改 |
| [`user-ds-balance/`](user-ds-balance/) | `@liyuera/dsh-user-ds-balance` | ✅ 无需改 | DeepSeek 账户余额读数:composer 工具行单元格,每 5 分钟轮询、点击刷新、loading 态(host 半边 `/ds-balance` 路由,API Key 现取现用) |

## 安装

两种装法，产物都已经在仓库/包里（`lib/`），目标机器不需要 `npm install`、不需要构建。

**从 npm 装**（GUI：设置 → 插件 → 添加插件，输入包名；命令行等价）：

```sh
dsh plugin --profile desktop add @liyuera/dsh-chrome-browser
```

**从本地目录装**（`link:`，改代码即时生效，适合开发）：

```sh
dsh plugin --profile desktop add link:/绝对路径/deepseek-harness-plugin/chrome-browser
```

`desktop` 是桌面应用独占的 profile；源码启动的 `pnpm dsh web` 用 `web`。装完**退出重开**——宿主半边只在启动时加载，浏览器硬刷新只换得到 `lib/client.js`。

四个包的 npm 名：`@liyuera/dsh-dev-dock`、`@liyuera/dsh-chrome-browser`、`@liyuera/dsh-favorite-prompts`、`@liyuera/dsh-user-ds-balance`。

`dsh-chrome-browser` 还要在 Chrome 里加载一次配套扩展（扩展随包发布，从 `<dsh 地址>/chrome-browser/extension.zip` 下载解压后「加载已解压的扩展程序」），步骤见[该插件 README](chrome-browser/README.md#2-装配套-chrome-扩展)。

Windows：

- 没有 git 就直接下载 zip 解压（构建产物已在仓库里）。
- `dsh` 不在 PATH 时用安装目录的启动器：
  `& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add link:C:/路径/chrome-browser`
- profile 目录（`%USERPROFILE%\.dsh\profiles\desktop`）在会话工作区之外，沙箱下需要提权，或退出沙箱后再装。

插件没出来时先看应用日志 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\`：`failed to import` 表示宿主半边有裸包解析不到，对照下一节补齐 `peerDependencies`。

## 构建期依赖

`node_modules/` 不入库，新机器上重建时要满足两件事：harness 工作区的
`packages/*` 能被解析，以及**改过 API 的包必须用运行时的版本**。

```sh
cd <插件目录>
npm i                                    # 安装 package.json 里的依赖
ln -sfn ../../vendor/cordis       node_modules/@deepseek-ai/cordis
ln -sfn ../../vendor/schemastery  node_modules/@deepseek-ai/schemastery
```

`@deepseek-ai/dsh-*` 的解析分两种，按各插件 `tsconfig.json` 的 `paths` 走：

- **指向工作区源码**：本地 checkout 是 0.1.6，只有该 API 在两版之间没变时才能这么用。
- **指向 node_modules**：0.2.0 改过 API 的包从 npm 装（如
  `@deepseek-ai/dsh-client-ui-primitives@0.2.0-rc.2`），并把对应的 `paths`
  与 `references` 条目删掉，让 TS 走 node_modules。**旧版本的类型里没有新名字**，
  留着工作区映射会编译不过。

用 `zod` 的插件（存储域 schema）必须让 `node_modules/zod` 软链到 harness 根的那一份：

```sh
ln -sfn ../../node_modules/.pnpm/zod@4.4.3/node_modules/zod node_modules/zod
```

两份 zod 会让 `ZodType<A>` 与 `ZodType<B>` 变成不兼容的两个类型。改完依赖记得删掉
`lib/tsconfig.tsbuildinfo`，否则 tsc 会复用旧的解析结果。

## 运行时依赖解析

插件分两半边，解析方式完全不同：

- **浏览器半边**（`lib/client.js`）：裸包由宿主的模块表 `window.__ModuleLoader__` 解析（`react`、`@deepseek-ai/dsh-client-*` 等），与安装方式无关。
- **宿主半边**（`lib/index.js`）：Node 按插件**真实路径**解析裸包 import。`link:` 安装时 pnpm 不装被链接包的依赖，插件目录里也没有 `node_modules`，所以只有两种声明能解析：

| 声明 | 结果 |
| --- | --- |
| `node:*` | 内建，始终可用 |
| `peerDependencies` | 宿主从**自己的安装目录**提供（`app.asar/dsh/node_modules/<包>`），与宿主共用同一份实例 |
| `dependencies` / 未声明 | 解析不到 → `failed to import` → 插件不激活 |

运行时用到的每个包都要写进 `peerDependencies`。共用宿主实例是有意的：`error instanceof DomainError` 这类跨边界判断（ui-favorite-prompts 的 `already-open` 重试）依赖它，内联第二份副本反而会破坏。

`@deepseek-ai/dsh-*` 的 peer 范围必须被运行中的 dsh 版本满足，否则 `dsh plugin add` 直接拒绝安装：

```
dsh: installation rejected: … is incompatible with dsh 0.2.0-rc.2: peerDependencies {"@deepseek-ai/dsh-tools":"^0.1.2-alpha.4"}
```

换 dsh 版本时同步抬高这些范围；`dsh plugin allow-version` 可临时豁免。

放进 `devDependencies` 的包由 tsdown 内联进产物，不需要宿主提供（dev-dock 的产物只剩 `node:*` 与 `@deepseek-ai/cordis` 两个外部引用）；只被浏览器半边 import 的包也只能放这里。

## 开发

每个插件目录内：

```sh
tsc -b && tsdown --config-loader tsx   # 重新构建（bin 解析自 harness 根 node_modules）
```

构建产物 `lib/`（含浏览器 bundle `lib/client.js`）提交进本仓库，安装即用，无需在目标机器构建。

## 许可

专有软件，保留所有权利。未经版权持有人书面许可，不得使用、复制、修改、分发或再许可本仓库的任何内容，详见 [LICENSE](LICENSE)。各插件 `package.json` 声明为 `UNLICENSED`；已发布到 npm 的包允许通过 npm 安装并运行，但不授予修改、再分发、再许可或销售的权利（全文见各包 `LICENSE`）。发布流程见 [`chrome-browser/README.md`](chrome-browser/README.md#发布) 与 [`ui-favorite-prompts/README.md`](ui-favorite-prompts/README.md#发布)。
