# @liyuera/dsh-code-review

DSH 会话运行时的「AI 生成代码自动审查」：主代理改完代码、准备收尾时，插件抓本 turn 的 workspace diff，派一个**只读**审查者子代理按预制规范审查，把带文件/行号/规则 id/严重度的 findings 回灌主代理修复，最多 N 轮。

> 当前为 `private` 包，尚未发布 npm；请从本地 checkout 安装。

## 与 bug-workflow 的 GitLab 审查是什么关系

两者是不同层、不同触发点的两套东西，互不复用输出格式：

| | 本插件 `code-review` | `bug-workflow` 的 Review |
| --- | --- | --- |
| 面向 | 会话运行时里 AI 刚生成的代码 | 平台工单修复后提交到 GitLab 的 MR |
| 触发 | 主代理 `turn-stopping` 时自动触发，或 `/review` 手动 | 宿主创建 MR 后轮询 GitLab 的 `AI Code Review` note |
| 动作 | 把 findings `steer` 回主代理，最多 `maxRounds` 轮 | 起 Review 修复子代理、commit/push，最多 3 轮 |
| 产物 | 会话内的审查报告/修复指令 | GitLab MR 上的评论与后续提交 |
| 外部依赖 | 无（不建分支、不 push、不访问 GitLab） | GitLab token、MR、项目分支规则 |

可以理解为两层保险：本插件尽量在代码离开会话前把问题消掉；即使漏过，进入 MR 后仍由 bug-workflow 的 GitLab 审查和人工合并兜底。本插件**不**解析、不生成 GitLab 审查模板。

## 工作机制

1. **触发**：宿主在 `agent/turn-stopping` 事件上调用门禁。
2. **门禁**（`src/host/trigger.js`，顺序短路）：`enabled` → `auto` → 来源不是 `subagent` → 当前没有同一会话的审查在跑 → 本 turn 轮数未达 `maxRounds` → 本轮有 workspace 变更 → 熔断未打开。全部通过后再确认摘要属于本 turn 且确实有文件，才占用一轮。
3. **取材**（`src/host/collect.js`）：只取后缀在 `codeExtensions` 里的源文件；把 hunk 渲染成 unified diff，按 UTF-8 字节数累计，超过 `maxDiffBytes` 后剩余文件标记 `budget` 跳过。二进制、超大、服务读不到的文件记入 `skipped`，不会猜内容。
4. **审查**（`src/host/reviewer.js`）：经 `ctx.subagents.startActivation` 在独立子代理里跑 `reviewerPreset`（默认 `code-review`），带结构化输出 schema，整体 deadline 为 `reviewerTimeoutMs`。审查者只读；工具门禁由 `ctx.tools.guard` 兜底。
5. **渲染与回灌**（`src/host/render.js`）：只有 `severity` 落在 `blockingSeverities` 的 findings 才生成 `结论: 需修改...` 并 `agent.steer` 回主代理；只有 low/nit 时不打断。上一轮被判阻塞、本轮通过时，会回注一行 `结论: 通过`。
6. **轮次**：按 `(sessionId, turn)` 计数。`steer` 不换 turn，所以同一 turn 内可以复审，但最多 `maxRounds` 次（默认 2：首审 + 修复后复审）。
7. **失败兜底**：超时、子代理失败、输出不合 schema、服务不可用都按 fail-open 处理——只写宿主日志，不注入、不阻塞主代理。同一会话连续 2 次失败进入 5 分钟冷却（熔断），冷却后半开放行一次；成功即清零。状态只在内存，会话释放或重启后清空。

`workspaceChanges` 是硬依赖：`index.js` 的 `inject` 包含它，缺失时插件不加载。v1 没有 `git diff` 回退。

## 安装

前置：dsh 0.2.x。桌面应用用 `desktop` profile；源码启动的 `pnpm dsh web` 用 `web`。

**方式一：命令行（本地 checkout）**

```sh
# 桌面应用
dsh plugin --profile desktop add link:/绝对路径/deepseek-harness-plugin/code-review

# 源码启动的 web profile
dsh plugin --profile web add link:/绝对路径/deepseek-harness-plugin/code-review
```

**方式二：应用内插件管理器**

打开 **设置 → 插件 → 添加插件**，填入同样的本地安装规格（`link:/绝对路径/.../code-review`，或直接填绝对路径），按提示安装；若界面提供「立即启用」，选中它。

本包是 **bundle**：`package.json` 声明 `dsh.bundle.patch` → `cordis.patch.yml`，该文件插入两条：

- `preset-code-review`：审查者 preset，只读文件工具 + 审查人格；
- `code-review`：插件本体。

安装会把它登记进 profile 的 `dsh.profile.bundles`。宿主半边只在应用启动时装配，装完要**重启应用**（源码启动则重启 `dsh web`）；只刷新页面不够。本包未发布 npm，不能按包名从 registry 安装。

卸载：

```sh
dsh plugin --profile desktop remove @liyuera/dsh-code-review
```

## 配置

默认值来自 `src/host/config.js` 的 `DEFAULTS`。配置在装配期严格校验：未知键、非法枚举、非法值直接抛错拒绝启动，不会静默兜底。

| 键 | 默认值 | 含义与建议 |
| --- | --- | --- |
| `enabled` | `true` | 自动审查总开关。`false` 时门禁直接短路；手动 `/review` 不受它限制。 |
| `auto` | `true` | `false` 时只保留 `/review` 手动入口，不在 turn-stopping 自动审查。 |
| `maxRounds` | `2` | 同一 `(sessionId, turn)` 的最多审查轮数。默认「首审 + 修复后复审」；调大能多给一轮修复机会，但会增加 token 与等待。必须为正整数。 |
| `blockingSeverities` | `["high","medium"]` | 自动回灌的阻塞阈值；不在其中的 findings 只会出现在 `/review` 报告里。可收窄为 `["high"]` 降低打断。 |
| `codeExtensions` | `[".js",".jsx",".ts",".tsx",".vue",".py",".go",".java",".rs",".css",".less",".scss"]` | 参与审查的源码后缀；其它文件记 `not-code` 跳过。 |
| `maxDiffBytes` | `200000` | 单次审查可收录 diff 的 UTF-8 字节上限；超出后的剩余文件记 `budget` 跳过。 |
| `reviewerTimeoutMs` | `120000` | 审查者整体 deadline（含启动等待）。超时按失败处理，由 fail-open/熔断接管。 |
| `reviewerPreset` | `"code-review"` | 审查者使用的 preset id。见下节「preset 冲突与降级」。 |
| `rulesFile` | `"rules/rules.json"` | 硬规则文件，相对包根目录。 |
| `principlesFile` | `"rules/principles.md"` | 原则文件，相对包根目录。 |
| `modelOverride` | 无默认 | 形如 `{ provider, model }`，覆盖审查者模型；省略则沿用主会话。只给其一视为配置非法。 |

在 profile 的 `cordis.patch.yml` 里按 id 覆盖，例如：

```yaml
- id: code-review
  config:
    maxRounds: 3
    blockingSeverities: [high]
    reviewerTimeoutMs: 180000
```

## `/review`

在会话里输入 `/review`：

- 只审查**最近一次** `workspace/changes` 的代码改动，把报告作为命令结果返回 UI；
- **不** `steer`、不向对话注入、不占用 `maxRounds` 轮次，也不会打断主代理；
- 输出含 `结论:`、按严重度排序的 findings，以及未审文件清单；没有 findings 时输出 `结论: 通过`；
- 与自动审查共用同一套规则、preset、超时和 `modelOverride`；
- 本轮没有可审查改动，或改动全是二进制/超预算文件时，返回错误文案而不是空报告。

自动审查失败是静默的，`/review` 是查看失败原因和临时补审的入口。

## preset 冲突与降级

`reviewerPreset` 默认 `code-review`，对应 bundle 里插入的 `preset-code-review`。审查者只读由两层保证：

1. preset 自身只启用只读文件工具（`read`/搜索），关闭 `write`/`edit`/`applyPatch`；
2. `ctx.tools.guard` 按 `reviewerPreset` 名字拒绝 `write`、`edit`、`apply_patch`、`bash`、`pwsh`、`subagent`、`workflow` 等会改工作区或派活的工具。

如果 profile 里已有别的插件占用 `code-review` 这个 preset id，或该 preset 没有被注册（例如只装了插件本体、bundle patch 没生效），任选一种降级：

- **改 preset id**：把本插件 `cordis.patch.yml` 里 preset 条目的 `config.id` 改成不冲突的名字（必要时连 patch 条目 id `preset-code-review` 一起改），同时把插件 `config.reviewerPreset` 改成同一个名字；
- **指向现有只读 preset**：把 `reviewerPreset` 改成 profile 里已注册的只读 preset id。`ctx.tools.guard` 会跟着盯住这个新名字，继续拒绝写工具。注意这会对**所有**使用该 preset 的子代理生效，建议选一个专用于审查的只读 preset。

不要指向不存在的 preset：审查者会启动失败，自动审查随后按 fail-open 静默跳过。

## 规则与原则

`rules/principles.md` 讲判断方式（只看 diff、拿不准不报、按严重度排序、同根因只报一次），`rules/rules.json` 是 24 条可核对硬规则：

| 维度 | 前缀 | 条数 | 关注 |
| --- | --- | --- | --- |
| correctness | `COR` | 7 | 异常与异步、边界、竞态、相等/时区/浮点 |
| security | `SEC` | 6 | 日志泄密、注入、路径穿越、动态执行、CORS、TLS |
| performance | `PRF` | 4 | 循环内 I/O、N+1、无上限遍历、同步读大文件 |
| maintainability | `MNT` | 7 | 类型断言、调试残留、复制粘贴、注释漂移、死代码、魔法数字、巨型函数 |

规则文件首次审查时读盘并缓存在内存，修改后需重载插件/重启应用才生效。规则文件加载失败时，插件降级为只用原则层并记一条警告，不阻塞会话；原则文件本身读不到则本次审查失败（仍按 fail-open 处理）。

## 已知限制

- **fail-open 是静默的**：审查失败、超时、坏输出只写宿主日志，不会告诉用户，也不阻塞主代理；需要可见结果时用 `/review`。
- **只审本 turn 的 workspace 变更**：不含历史提交、未变更文件或其它分支；`workspaceChanges` 缺失时插件根本不加载，v1 没有 `git diff` 回退。
- **取材有上限**：二进制/超大文件跳过；超过 `maxDiffBytes` 后的剩余文件不再审。报告里的 `未审:` 行会列出原因。
- **不碰 GitLab**：不复用 GitLab 审查模板，不建 MR、不 push、不评论；与 bug-workflow 的 MR 审查是两套独立机制。
- **审查者是独立子代理**：绝不自我审查；`origin: subagent` 的会话不会再触发自动审查，避免递归。
- **只有阻塞级会自动回灌**：low/nit 不 `steer`，只在 `/review` 报告里可见。
- **只读不是 OS 级沙箱**：依赖 preset 工具面 + 按工具名的 `ctx.tools.guard`；preset 配错或未注册时保护会失效或审查直接失败。
- **规则与轮次是进程内状态**：规则缓存、每 turn 轮数、熔断计数都在内存，重启即重置；熔断只影响自动审查，`/review` 仍可手动跑。
- **成本**：审查者是一次真实模型调用，会消耗 token 与时间；`maxRounds` 调大意味着同一 turn 可能多次调用。

## 最小验证

1. 重启应用，在一个真实仓库会话里让主代理改一个源文件。若改动触发 high/medium，turn 结束时应看到形如 `结论: 需修改（1 处阻塞） · 本次 1 文件 / 3 行变更` 的注入；按提示修复后会再复审，通过时看到 `结论: 通过`。
2. 审查前后跑 `git status`：只应有主代理的改动，审查者不应写任何文件。
3. 在会话里执行 `/review`：报告只出现在 UI，对话不被打断、不产生 steer 消息。
4. 规则加载自检：

   ```sh
   cd code-review
   node -e "import('./src/host/rules.js').then(async m => { const r = await m.loadRules({rulesPath:'rules/rules.json',principlesPath:'rules/principles.md'}); console.log(r.rules.length) })"
   node --test
   ```

   第一条应打印 `24`；第二条应全绿（当前 68 个用例）。
