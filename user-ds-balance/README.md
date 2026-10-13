# @liyuera/dsh-user-ds-balance

DeepSeek 账户余额读数（静态双面插件）。

在输入框工具行（“Full access”下拉右侧，`conversation.input.left` 插槽）展示
DeepSeek 账户余额的静态插件：

- 每 5 分钟主动轮询一次余额；
- 点击红色金额主动查询一次，不与轮询互相占用；
- 查询期间显示加载动画，请求完成后移除；
- 失败时保留上次余额并在悬浮提示中显示错误。

数据来自官方[查询余额接口](https://api-docs.deepseek.com/api/get-user-balance/)
（`GET https://api.deepseek.com/user/balance`），API Key 每次查询都通过
`ctx.credentials.resolve('DEEPSEEK_API_KEY')` 现取现用（进程环境 / 托管存储 /
`.env` 逐层解析），不缓存、不落盘。

## 组成

| 文件 | 作用 |
| --- | --- |
| `src/index.ts` | Node 半边（宿主进程）：注册 `webServer` 精确路由 `GET /ds-balance` |
| `src/client/index.ts` | 浏览器半边：向 `conversation.input.left` 插槽注册余额单元格 |
| `src/client/BalanceFooter.tsx` | 单元格组件：轮询、点击刷新、loading、金额展示 |
| `src/client/BalanceFooter.module.css` | 样式（红色金额 pill / spinner） |
| `src/invariant.ts` | 包级 invariant 伙伴插件 |

与动态插件（`cordis_define` 会话级）不同，这是一个真正的静态双面长驻插件：
Node 半边是宿主组合中的一行，浏览器半边通过 `dsh.client` 清单进入
`window.__DSH_BOOT__` 模块表。

## 安装

```sh
dsh plugin --profile desktop add @liyuera/dsh-user-ds-balance   # 从 npm（GUI：设置 → 插件 → 添加插件）
dsh plugin --profile desktop add link:/绝对路径/deepseek-harness-plugin/user-ds-balance   # 从本地目录
```

`desktop` 是桌面应用独占的 profile（源码启动的 `pnpm dsh web` 用 `web`）。重启后生效（client-modules 的插件集变更需要重启才扫描到）。需要 dsh 0.2.x：`@deepseek-ai/cordis` 等依赖声明在 `peerDependencies`，版本不匹配时 `dsh plugin add` 会拒绝安装。

## 配置

无插件配置项。API Key 由宿主凭据服务解析（`ctx.credentials.resolve('DEEPSEEK_API_KEY')`），所以给 dsh 配好 `DEEPSEEK_API_KEY` 即可（进程环境、托管存储或 `.env` 任一层）。

## 构建

本目录内：

```sh
tsc -b && tsdown --config-loader tsx   # 重新构建（bin 解析自 harness 根 node_modules）
```

两个半边由本仓库的共享构建助手 [`build/client-bundle.ts`](../build/client-bundle.ts) 打包，构建产物 `lib/` 提交进本仓库，安装即用。此包位于插件仓库 `deepseek-harness-plugin/user-ds-balance/`（不在 harness 的 `packages/` glob 内），构建时从插件目录借用工作区根 `node_modules` 的 tsdown/tsc bin 与客户端构建设施。

## 移除

```sh
dsh plugin --profile desktop remove @liyuera/dsh-user-ds-balance
```

## 许可

专有软件，`UNLICENSED`：允许通过 npm 安装并运行本包（全文见包内 `LICENSE`），不授予修改、再分发、再许可或销售的权利。
