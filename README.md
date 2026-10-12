# deepseek-harness-plugin

李煜（liyuera）的 DeepSeek Harness (dsh) 插件集。每个插件一个目录，目录名即插件名。

本仓库设计为放在 deepseek-harness 工作区根目录下（`deepseek-harness-plugin/`），
构建时借用 harness 的客户端构建设施；插件代码与 fork 的版本库完全分离。

## 插件列表

| 目录 | npm 包名 | 0.2.0 | 说明 |
| --- | --- | --- | --- |
| [`ui-subagent-sidebar/`](ui-subagent-sidebar/) | `@liuyera/dsh-client-ui-subagent-sidebar` | ⏳ 未验 | 右下角 subagent 运行计数胶囊 + 右侧根分组概览面板 |
| [`dev-dock/`](dev-dock/) | `@liyuera/dsh-dev-dock` | ✅ 已移植 | devDock v1.0.0：项目 = dsh 工作区；开始上班弹窗、会话头部 IDE/终端/启动（确定性桌面动作）、每工作区 IDE 偏好与编辑器检测（真实应用图标） |
| [`chrome-browser/`](chrome-browser/) | `@liuyera/dsh-chrome-browser` | ✅ 已移植 | Chrome 浏览器控制:扩展桥(默认)或 CDP 驱动你已打开的 Chrome——列标签页/读网页内容/导航/新开/截图/点击/输入/执行 JS;`@` 菜单列出实时标签页(标题 + URL),选中插入引用芯片,AI 在该页面工作 |
| [`ui-favorite-prompts/`](ui-favorite-prompts/) | `@liyuera/dsh-favorite-prompts` | ✅ 已移植 | 消息下方一键收藏、`@` 拉出收藏并整段插入、设置页增删改 |
| [`user-ds-balance/`](user-ds-balance/) | `@liyuera/dsh-user-ds-balance` | ✅ 无需改 | DeepSeek 账户余额读数:composer 工具行单元格,每 5 分钟轮询、点击刷新、loading 态(host 半边 `/ds-balance` 路由,API Key 现取现用) |

## 安装

```sh
dsh plugin --profile web add link:/绝对路径/deepseek-harness/deepseek-harness-plugin/ui-subagent-sidebar
```

重启 dsh 后生效(桌面应用退出重开;源码启动的则是重启 `pnpm dsh web`)。

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

`link:` 安装的插件由 Node 按**真实路径**（`deepseek-harness-plugin/<插件>/`）解析自己的依赖，
走不到 profile 的 `node_modules` 回退。0.2.0 的宿主路由能解析 `@deepseek-ai/dsh-*`
（chrome-browser 的 `dsh-tools` 就是这么拿到的），但其余外部化的依赖仍须在插件仓库内可解析。

放进 `devDependencies` 的依赖由 tsdown 内联，不需要链接；这类插件构建后即为自包含产物
（dev-dock 的产物只剩 `node:*` 外部引用）。留在 `dependencies` 的才是外部引用。

## 开发

每个插件目录内：

```sh
tsc -b && tsdown --config-loader tsx   # 重新构建（bin 解析自 harness 根 node_modules）
```

构建产物 `lib/`（含浏览器 bundle `lib/client.js`）提交进本仓库，安装即用，无需在目标机器构建。

## 许可

专有软件，保留所有权利。未经版权持有人书面许可，不得使用、复制、修改、分发或再许可本仓库的任何内容，详见 [LICENSE](LICENSE)。各插件 `package.json` 声明为 `UNLICENSED` 且 `private`，不从 npm 发布。
