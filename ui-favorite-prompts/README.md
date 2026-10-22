# @liyuera/dsh-favorite-prompts

给 dsh Web GUI 的"收藏提示词"插件：在消息下方一键收藏自己发过的提示词，在输入框用 `@` 拉出收藏并整段插入，在设置里增删改。

纯插件实现——不修改 `deepseek-harness` 任何代码，只用它公开的扩展点。

设计见 [DESIGN.md](DESIGN.md)，实现计划与偏差记录见 [PLAN.md](PLAN.md)。

## 安装

```sh
dsh plugin --profile desktop add @liyuera/dsh-favorite-prompts    # 从 npm（GUI：设置 → 插件 → 添加插件）
dsh plugin --profile desktop add link:/绝对路径/deepseek-harness-plugin/ui-favorite-prompts   # 从本地目录
```

`desktop` 是桌面应用独占的 profile（源码启动的 `pnpm dsh web` 用 `web`）。重启 dsh 生效（profile 的 insert 行在启动时读取）。两种装法的产物都已构建好，目标机器不需要 `npm install` 或联网。

宿主半边 import `@deepseek-ai/dsh-storage-domain`，它声明在 `peerDependencies`：宿主提供自己那份实例，`already-open` 重试里的 `error instanceof DomainError` 依赖这一点。`dependencies` 里的包在 `link:` 安装下解析不到（详见仓库根 README）。

需要 dsh 0.2.x：`@deepseek-ai/dsh-*` 依赖声明在 `peerDependencies`（`^0.2.0-rc.2`），版本不匹配时 `dsh plugin add` 会拒绝安装。

插件在 dsh 插件管理页里的**图标、标题和一栏简介**来自插件包自己的 `package.json`：顶层 `icon` 是包内相对路径（DSH 0.2.x 起支持，SVG/PNG/JPEG/WebP，≤ 256 KiB，宿主转成 data URL 渲染），`locale/{en,zh}.json` 的 `meta.title` / `meta.description` 按界面语言显示。本包用 `icon.svg`（深色磁贴 + 渐变书签：DeepSeek Harness 的鲸鱼蜷成 @ 的外圈，@ 的内层 a 落在鲸鱼蜷起的空腔里）和中英文卡片文案；旧版 dsh 会忽略这些字段。

## 三个入口

| 入口 | 扩展点 | 说明 |
|---|---|---|
| 消息下方书签 | 自建 Chat 节点 `favorite-strip` | 悬停气泡浮现，空心/实心表示是否已收藏；取消后 5 秒内可撤销 |
| `@` 收藏组 | `ctx.inputTriggers.registerSource` | 排在 `@` 菜单最前；选中后插入提及 chip `@名字`，宿主在 `agent/pre-step` 把该收藏的提示词全文追加成上下文消息 |
| 设置 → 收藏提示词 | `settings.section` | 列表、行内编辑、二次确认删除、手动新增 |

## 数据

存放在 dsh 存储域的 per-record JSON 里，每条收藏一个文件：

```
$DSH_HOME/storages/favorite_prompts/prompts/<id>.json
{ "version": 1, "record": { "id": "…", "text": "…", "createdAt": 1730000000000 } }
```

可读、可手改、可 git。单条 JSON 损坏时，domain 层会把该条挪走并记日志，其余条目照常加载。

浏览器半边不直接读盘：Host 半边暴露一条同源路由 `/favorite-prompts`（GET 列表 / POST 新增 / PATCH 改文 / PUT 撤销写回 / DELETE 删除），浏览器侧只做镜像。

## 开发

```sh
npm install                                    # 依赖全部来自 npm 的 0.2.0 包
npx tsc -b && npx tsdown --config-loader tsx   # 构建（bin 解析自 harness 根 node_modules）
node ../../node_modules/vitest/vitest.mjs run  # 测试
```

构建产物 `lib/`（含浏览器 bundle `lib/client.js`）提交进本仓库，安装即用。

### 两个容易踩的坑

1. **类型源是 npm 上的 0.2.0 包，不是本地 harness 检出**：`tsconfig.json` 用空 `paths: {}` 覆盖掉从 `tsconfig.base.client.json` 继承的映射（那些映射指向本地 0.1.6 的 `packages/*/src`，会盖住 node_modules 里的 0.2.0 类型）。`node_modules/zod` 仍软链到 harness 根的那一份，与存储域共用同一实例。
2. **`LocaleNamespaceMap` 模块增强必须写在已 import 该模块的文件里**（本插件的 `src/client/index.ts`）。只有 `declare module` 而没有对应 `import type {}`，`tsc -b` 会报 `TS6305`（项目引用图里建立不了"源 → 输出"映射）。详见 [PLAN.md](PLAN.md) 的实施偏差 D1。

### 收藏条的排序契约

收藏条是自建 Chat 节点，靠节点 key 的字典序落在用户消息正下方：`key = ${kind.length}:${kind}${id}`，内置用户节点是 `13:input-message…`，本插件 `favorite-strip` 是 `14:favorite-strip…`。**改 kind 名长度或把 `anchorSeq` 从 `event.seq` 挪开，都会让收藏条跑到气泡上面或被折进"思考过程"折叠组。** 契约写在 `src/client/strip/definition.ts` 顶部，并有单测守着。

## 卸载

```sh
dsh plugin --profile desktop remove @liyuera/dsh-favorite-prompts
```

已存的收藏留在 `$DSH_HOME/storages/favorite_prompts/`，重装后照常读回。

## 许可

专有软件，`UNLICENSED`：允许通过 npm 安装并运行本包（全文见包内 `LICENSE`），不授予修改、再分发、再许可或销售的权利。
