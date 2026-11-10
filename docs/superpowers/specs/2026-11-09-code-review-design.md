# DSH 会话内代码审查插件 — 设计文档

- 日期：2026-11-09
- 状态：v1 待评审
- 目标运行环境：DSH 0.2.2-rc.1（desktop profile）
- 包名：`@liyuera/dsh-code-review`
- 目录：`deepseek-harness-plugin/code-review/`

## 1. 背景与目标

AI 在主会话里写完代码，人往往要到提 MR 之后才第一次被审查。这时改动的意图上下文已经冷了，返工成本最高。

本插件把「审查」提前到会话运行时内部：**每轮 AI 改完代码，立刻由一个独立的只读子代理按预制的 AI 代码生成规范审一遍，把带文件、行号、标签的结构化结果回注给主代理，让它自己修**。

目标：

1. 触发不需要人记得——轮次自然收尾时自动发生，用户不用敲命令。
2. 审查者独立——不能是写代码的那个上下文，避免自审偏差。
3. 结果可行动——每条 finding 有文件、行号、维度、严重度、规则 ID、问题描述、修复建议。
4. 修复留给人——主代理基于 findings 自己改，不用在代理之间再倒一手意图。
5. 规范可迭代——规范是磁盘上的数据，改完即生效，不必重新构建插件。

## 2. 非目标（v1 明确不做）

- 不做 Web 面板、卡片或任何 client 半边。产出只有文本（回注 + 可选落盘）。
- 不做规则 DSL、AST 匹配或静态分析器。规则层是给 LLM 读的检查项，不是 linter。
- 不做自动提交、推送、开 MR。插件不写仓库，只读。
- 不复用也不产出 GitLab AI 评审那套 note 模板（见 §5）。
- 不做跨轮增量缓存或历史基线比对，只审本轮的变更。
- 不做多语言特化插件。语言差异只体现在规则层的内容上。
- 不在子代理会话里触发审查。

## 3. 术语

| 术语 | 含义 |
|---|---|
| 主会话 | 用户正在对话、AI 正在写代码的那个 Session |
| 审查轮 | 一次「审查 → 回注 → 修复」的循环，同一 turn 内可有多次 |
| 原则层 | `principles.md`，散文式判断标准，决定召回 |
| 规则层 | `rules.yaml`，带 id/severity/正反例的可枚举检查项，决定标签稳定性 |
| 变更轮 | `workspace/changes` 事件宣告的、有文件改动的顶层轮次 |
| blocking | `severity` 命中 `blockingSeverities` 集合的 finding（默认 `[high, medium]`） |

## 4. 总体架构

```
┌───────────────────── Host 插件（无 client 半边）─────────────────────┐
│  trigger.js   门禁：origin / 开关 / 轮次 / 有无代码变更                 │
│  collect.js   取材：ctx.workspaceChanges 优先，git diff 回退            │
│  reviewer.js  审查：ctx.subagents.startActivation + outputSchema        │
│  render.js    渲染：findings[] → 原始输出文本                           │
│  rules.js     规范：加载并校验 principles.md / rules.yaml               │
│  loop.js      轮次状态机：计数、封顶、失败降级                           │
└───────┬──────────────────────┬───────────────────────┬────────────────┘
        │ 监听                  │ 起子代理               │ steer
        ▼                      ▼                       ▼
  agent/turn-stopping    spawn provider（只读）      主 Agent inbox
        │                      │
        ▼                      ▼
  ctx.workspaceChanges    ReviewResult（schema 校验）
```

关键环境事实（已按运行时 0.2.2-rc.1 的产物核对，非旧源码）：

- `agent/turn-stopping` 的监听签名是 `ctx.on('agent/turn-stopping', ({ agent, turn }) => …)`，`agent.session` 可拿到会话；它是自然停止边界上一次 awaited 通知，监听器可调 `agent.steer(UserMessage)` 要求再走一步。
- 起子代理用 `ctx.subagents.startActivation({ provider, label, request, signal, delivery })`，返回 `{ childId, messageId?, result, dispose }`；`request` 是 `SubagentStartRequest`，支持 `parent`、`prompt`、`agentPreset`、`outputSchema`、`agentOptions`、`cwd`、`maxDepth`。
- **spawn 请求没有 `toolFilter` / `persona`**：`dsh-tool-subagent` 对这两个字段显式报错，指向 Agent Preset。只读与人格都必须在 preset 里组合。
- 本地子代理的只读由 preset 决定：`dsh-tool-fs` 的 `read` / `write` / `edit` / `applyPatch` 是独立开关，不挂 bash 就没有 shell。
- `ctx.workspaceChanges.summary(sessionId, seq)` / `.diff(sessionId, seq, index, signal)` 给出每轮的变更文件与逐文件 hunk（3 行上下文），覆盖未提交改动与非 git 文件。
- 子代理会话用 `session.header.origin === 'subagent'` 识别；主会话该字段是空，所以判据必须是「等于 subagent」而不是「等于 main」。

## 5. 与既有能力的关系

| | bug-workflow 的 GitLab 审查 | 第三方的 `dsh-code-review` preset | 本插件 |
|---|---|---|---|
| 时机 | webhook / MR 事件，远端 | 用户切到「代码审查模式」会话 | `agent/turn-stopping`，本地会话内 |
| 对象 | 提了 MR 的那批提交 | 用户指名的代码 | 本轮 AI 刚写的改动 |
| 触发 | 外部系统 | 人工选择会话 | 自动 + `/review` |
| 产出 | GitLab note | 会话里的报告 | 回注给主代理，驱动修复 |
| 角色 | 合入前的远端闸 | 一次性审查会话 | 第一道本地闸 |

三者不互相替代。本插件**刻意不复用** GitLab note 模板：那套模板服务于远端 note 的机器解析与审计，本插件的消费者是模型自身，格式取向是紧凑、可行动，两者混用会让任何一侧失去调整自由。

## 6. 运行时契约

### 6.1 触发

监听 `agent/turn-stopping`，按顺序短路求值：

1. `config.enabled` 且 `config.auto` 为真（`auto: false` 时自动路径整体关闭，只剩 `/review`）。
2. `agent.session.header.origin !== 'subagent'`——否则审查者自己的轮次会再触发审查。
3. 该会话不在审查中（`reviewing` 集合，按 sessionId）。
4. 本 turn 的审查轮数 < `maxRounds`。
5. 存在可用的变更来源：本会话最新的 `workspace/changes` 事件（优先），或 `ctx.subprocess` 可用的 git 回退（§6.2）；且变更文件里至少一个匹配 `codeExtensions`。
6. 未因连续失败被本会话熔断（§9.4）。

任一条不满足即跳过，不写任何会话事件。

### 6.2 取材

- 从 `session/event` 订阅里缓存每个 session 最新的 `workspace/changes` seq。
- `ctx.workspaceChanges.summary(sessionId, seq)` 取文件列表；`diff(...)` 逐文件取 hunk。
- 只取 `codeExtensions` 命中的文件；跳过 `binary` / `oversized`（在 prompt 里点名告知跳过，不静默）。
- 按文件顺序累积，超过 `maxDiffBytes` 后停止并声明「已截断，剩余 N 个文件未审」。
- `ctx.workspaceChanges` 不可用时回退 `ctx.subprocess` 跑 `git diff --unified=3`；两者都不可用则跳过本轮并记一次警告。
- **监听顺序依赖**：`workspace-changes` 自己也是在 `agent/turn-stopping` 里才把本轮的 `workspace/changes` 事件写进会话的，串行派发下后注册的监听器才能读到。因此本插件必须排在它之后加载（profile patch 的顺序天然满足）；拿不到本轮 seq 时按上一节回退 git diff，并记一次警告，不能假设「容器里一定有 workspace-changes」。

### 6.3 审查

```js
const activation = await ctx.subagents.startActivation({
  provider: 'spawn',
  label: `review:t${turn}`,
  delivery: 'caller',                   // 结果由插件自己等，不向父级投递完成通知
  signal,                               // 只取消尚未发布的工作
  request: {
    parent: agent,
    agentPreset: 'code-review',  // 只读工具面与人格都在 preset 里
    outputSchema: ReviewResultSchema,
    agentOptions: config.modelOverride, // 缺省沿用主会话模型
    prompt: [{ type: 'text', text: 组装好的审查提示 }],
  },
})
const result = await activation.result   // 超时就 activation.dispose()
```

- 只读靠 preset，不靠提示词：`code-review` 这个 preset 里只挂 `read` / `grep` / `glob` 对应的工具，`dsh-tool-fs` 的 `write`、`edit`、`applyPatch` 全关，且不挂任何 bash/终端行。0.2.2 的 spawn 请求没有 `toolFilter`，preset 是唯一的结构性只读手段。
- `delivery: 'caller'` 很关键：默认的 `parent` 投递会向父代理发一条「子代理完成」通知，白白多一轮模型调用；插件自己等 `result` 就够了。
- 超时用 `dispose()` 而不是请求信号：请求 `signal` 只能取消尚未发布的工作，发布后的取消通道是 `dispose()`。
- prompt 里明确：只读、不许改代码、拿不到完整文件时才用 read/grep 补上下文。
- `stopReason !== 'completed'` 或 `structured` 缺失 → 视为审查失败（§9.4）。
- 审查者**不返回 verdict**：verdict 由插件按 `blockingSeverities` 从 findings 推导，消除模型自相矛盾的可能。

### 6.4 回注

- 存在 blocking findings：`agent.steer({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 渲染结果 + 修复要求 }] })`。修复要求里注明「修完会再复审一次」。`source` 是必填，漏了会在渲染时炸（`Cannot read properties of undefined (reading 'kind')`）。
- 无 blocking：本轮不注入。例外——若上一轮审查有 blocking 且本轮已清零，注入一行「复审通过」，让主代理知道可以收尾。这一行同样走 `steer`，代价是多走一个步骤；换来的是模型不会在「改完了吗」的不确定里反复试探。
- 达到 `maxRounds` 仍有 blocking：注入最终报告并声明「不再自动复审，请人工确认」，本 turn 停止自动审查。

### 6.5 手动触发

`/review` 是人在场时的入口，语义刻意与自动路径不同：

- 忽略 `auto`、`maxRounds`、diff 去重，但仍然过 `origin !== 'subagent'` 和熔断检查。
- **只把报告作为命令结果输出到 UI，不回注、不 steer**。人在看着，由人决定是否让主代理动手。
- v1 只支持无参数形式，审查范围固定为本轮变更；`/review <ref>` 这类范围参数留到 v2。

命令行与自动路径共用 `collect` / `reviewer` / `render`，区别只在触发源和回注策略。

## 7. 数据契约

### 7.1 审查者返回（schema 校验）

```ts
interface ReviewResult {
  findings: Finding[]
}

interface Finding {
  ruleId: string        // SEC-002 / COR-011 / PRF-003 / MNT-004 / PRINCIPLE-correctness
  dimension: 'correctness' | 'security' | 'performance' | 'maintainability'
  severity: 'high' | 'medium' | 'low' | 'nit'
  location: string      // src/auth/session.ts:42 或 :88-96
  problem: string       // 一句话：是什么 + 为什么是问题
  suggestion: string    // 具体怎么改，可执行
}
```

「未审文件」不在这个契约里：截断和跳过是 `collect` 的已知事实，由插件在渲染时并进报告，不让审查者去猜自己没看到什么。

约束：`ruleId` 必须出现在本次注入的规则层里，或用 `PRINCIPLE-<dimension>` 兜底；`location` 必须落在本次 diff 涉及的文件内。插件侧二次校验，不合法即拒绝该条并记日志。

### 7.2 渲染输出（回注给主代理的那份）

```
结论: 需修改（2 处阻塞）
[SEC-002] 安全/high      src/auth/session.ts:42
  问题: 令牌以明文写入日志，且未标注有效期
  建议: 记录 tokenId 或脱敏占位符，日志字段显式声明 TTL
[COR-011] 正确性/medium  src/auth/session.ts:88-96
  问题: refresh 失败分支未处理，Promise rejection 会静默丢失
  建议: 补 catch 并走登出路径，或显式 void 并在日志里记为已知失败
未审: src/vendor.min.js（二进制/超限）
```

通过时（仅复审场景）：`结论: 通过（本次 3 文件 / 47 行变更）`。

## 8. 规范两层

### 8.1 原则层 `rules/principles.md`

散文，四个维度各一节，每节回答三件事：判断标准是什么、什么算阻塞、什么可以放过。核心内容是 **AI 生成代码特有的失效模式**，因为它和人类代码的出错分布不同：

- 幻觉 API：调用不存在的参数/方法/配置项，或凭印象编造库行为。
- 兜底式类型：`as any`、`as unknown as X`、`@ts-ignore` 掩盖真实类型错误。
- 吞异常：空 `catch`、`catch` 里只 `console.log`、Promise 未处理 rejection。
- 过度防御：对不可能为空的值加判空并在空分支里返回误导性默认值。
- 复制粘贴：近似重复的代码块，改一处漏一处。
- 注释与代码不符：注释描述了意图，代码做了另一件事。
- 死代码与残留：未使用的导入/变量、调试日志、TODO 占位实现。
- 边界缺失：空数组/空串/0/并发/超时路径未考虑。

### 8.2 规则层 `rules/rules.yaml`

```yaml
- id: SEC-002
  dimension: security
  severity: high
  title: 敏感信息不得进入日志
  check: logger/console 的参数里不得出现 token|password|secret|cookie 变量或字面量
  bad: logger.info(`token=${token}`)
  good: logger.info('token refreshed')
```

- `id` 前缀按维度：`COR` / `SEC` / `PRF` / `MNT`，全局唯一，加载时校验，重复即启动失败（不静默）。
- `severity` 取值固定四档；`check` 是一句话判断条件，`bad`/`good` 是判定锚点。
- 首版交付 20~25 条，覆盖四个维度；后续按真实误报迭代。

### 8.3 生命周期

两个文件都在运行时从包目录读盘，改完下一轮审查即生效，不需要重新构建或重启。读取失败（文件缺失/Schema 非法）→ 插件降级为「只用原则层」并记一次警告，不阻塞会话。

## 9. 策略

### 9.1 轮次

`rounds` 按 `(sessionId, turn)` 计数。注意 `steer` 走的是 `next-step`，turn 号不变，所以不能拿 turn 当轮数。`maxRounds` 默认 2：首审 + 一次修复后复审。

### 9.2 幂等

同一 turn 的同一份 diff 只审一次（按 `workspace/changes` 的 seq 记），复审必须是因为 diff 变了。`reviewing` 集合防止并发重入。

### 9.3 超时

审查者整体 deadline 默认 120s，由插件侧 AbortSignal 控制；超时按失败处理。

### 9.4 失败与熔断

- 单次失败（超时、stopReason 非 completed、schema 不合法、服务不可用）→ **fail-open 且静默**：放行本轮，不注入、不 steer、不阻塞。理由见下。
- 失败不占用 diff 去重位，下一轮 turn-stopping 会自然重试一次。
- 同一会话连续 2 次失败 → 本会话熔断，关闭自动审查（不进会话，只记日志）；`/review` 仍可手动重试并看到失败原因。
- 熔断状态只在内存，会话重开即恢复。

为什么静默而不是往会话里报一句：失败注入要走 `steer`，而 `steer` 会让轮次继续——审查失败 → steer → 下一轮再失败，正是最不需要的循环。审查是质量辅助，不该用自身的失败去打断用户的工作；代价是用户不会被告知，这一点由 `/review` 的手动可见性补偿。

### 9.5 用户输入的优先级

`steer` 只在轮次自然停止时发生。若用户在此期间发了新消息，用户输入先于审查结果进入队列；此时本轮审查结果仍会注入，但修复要求改为「如与用户新指令冲突，以用户指令为准」。

## 10. 配置面

```yaml
- insert:
    - id: code-review
      name: '@liyuera/dsh-code-review'
      config:
        enabled: true
        auto: true                       # false 时只保留 /review
        maxRounds: 2
        blockingSeverities: [high, medium]
        codeExtensions: [.ts, .tsx, .js, .jsx, .vue, .py, .go, .java, .rs, .css, .less, .scss]
        maxDiffBytes: 200000
        reviewerTimeoutMs: 120000
        reviewerPreset: code-review # 只读工具面的载体，见 §11
        # 省略 modelOverride 即沿用主会话模型；只覆盖其一视为配置非法
        # modelOverride: { provider: deepseek, model: deepseek-chat }
        rulesFile: rules/rules.yaml
        principlesFile: rules/principles.md
```

配置校验在装配期完成：未知键、非法枚举、负值一律拒绝启动（沿用仓库里其他插件的做法，不静默兜底）。

## 11. 模块与文件

```
code-review/
  package.json            # 无 client 半边；dsh.bundle.patch 指向 cordis.patch.yml
  cordis.patch.yml        # 两条 insert：reviewer preset + 本插件行
  index.js                # 装配入口：读配置、加载规范、挂监听与命令
  src/host/
    trigger.js            # §6.1 门禁真值表
    collect.js            # §6.2 取材与截断
    reviewer.js           # §6.3 子代理调用与结果校验
    render.js             # §7.2 渲染
    rules.js              # §8 加载、校验、合并
    loop.js               # §9 轮次/熔断状态机
    command.js            # /review 处理器（复用 collect/reviewer/render）
  rules/
    principles.md
    rules.yaml
  test/
```

`cordis.patch.yml` 里的 preset 行（只读工具面 + 人格）大致是：

```yaml
- insert:
    - id: preset-code-review
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: code-review
        name: 通用代码审查
        description: 通用代码审查——只读子代理，只审不改
        order: 50
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |-
                你是代码审查者，只做审查，不改代码。你没有写文件、改文件或执行命令的能力。
                对给定的 diff 逐条核对规则，只报告确有把握的问题；拿不准就不报。
              complete: true
              includeRuntimeContext: false
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config: { read: true, readImage: false, write: false, edit: false, applyPatch: false }
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
            config:
              sampleOverCapGlobResults: false   # 字段必填，漏了 preset 挂不上去
          - id: compaction
            name: cordis:group
            group: true
            isolate: { compaction: true }
            config:
              - { id: compaction-basic, name: '@deepseek-ai/dsh-compaction-basic' }
    - id: code-review
      name: '@liyuera/dsh-code-review'
```

模块边界约束：`trigger` / `render` / `rules` 是纯函数，不碰 ctx，可直接单测；`collect` / `reviewer` 只依赖注入进来的服务接口，用假实现测。

## 12. 可观测性

- 每次跳过记录原因（`disabled` / `subagent` / `no-changes` / `rounds-exhausted` / `breaker-open`），仅在 debug 级，不写会话事件。
- 每次审查记录：轮次、文件数、diff 字节、耗时、findings 数、是否被截断。
- 失败记录：原因分类（timeout / provider-error / schema-invalid / service-missing）。
- 不记录 diff 正文与 finding 全文到日志（仓库代码可能含敏感串）。

## 13. 测试策略

| 层 | 内容 |
|---|---|
| 单测 | §6.1 门禁真值表（6 个条件逐条 false）；`rules.js` 重复 id / 非法 severity / 缺字段的拒绝；`render.js` 快照（含截断、跳过、通过三种）；`collect.js` 的字节截断与扩展名过滤；schema 校验拒绝非法 finding |
| 集成 | 假 subagent provider + 假 workspaceChanges，验证「turn-stopping → 取材 → 起子代理 → steer」全链路、轮次封顶、连续失败熔断 |
| 手动 | 在本仓库改一个 `.js` 文件，确认触发、输出可读、修完复审通过；再故意写一处 `catch {}` 确认能报出来 |

## 14. 风险与未决

| 风险 | 说明与对策 |
|---|---|
| API 版本 | 已按运行时 0.2.2-rc.1 的产物核签（见 §4 / §6.3），但只核了声明与调用形态，没跑过。M0 剩下的正是运行时行为验证 |
| 预设可见性 | reviewer preset 是全局注册的，会出现在用户新建会话的预设选择器里。取舍：接受它（它本身也能当手动审查用），显示名定为「通用代码审查」并配「只审不改」的人格，避免被误当成通用编码模式。另一面：preset id `code-review` 与第三方 `dsh-code-review` 可能撞车——重复 id 会让声明加载失败，真撞了就把 id 改成 `general-code-review`，显示名不用动 |
| 监听顺序 | 本插件必须在 `workspace-changes` 之后加载才能读到本轮 `workspace/changes`。profile patch 顺序天然满足；隔离组合里要显式保证，否则退化为 git diff |
| 误报 | 一次误报让主代理去「修」正确代码，比不审更糟。对策：severity 定得保守、规则必须带 bad/good、原则层写清「什么可以放过」 |
| 成本 | 每轮一次子代理。对策：纯文档轮次不触发、maxDiffBytes 截断、失败熔断、`auto: false` 可退化为手动 |
| diff 过大 | 大重构一轮几千行。对策：按文件累积截断并显式声明未审部分，而不是把 prompt 撑爆 |
| 递归 | 审查者子代理自身的轮次会触发 turn-stopping。对策：`origin === 'subagent'` 硬门禁 + 单测覆盖 |
| 与用户输入竞争 | 见 §9.5；v1 接受这一近似，不做到队列级仲裁 |

## 15. 里程碑

- **M0 运行时核签（2026-11-10 已通过）**：用一次性探针插件 + `dsh --profile headless --patch` 在临时仓库跑了一轮真实会话，四项都成立——见 §16 记录。
- **M1 骨架**：插件目录、装配、配置校验、`/review` 命令（先只渲染 diff 不审），证明能装上并触发。
- **M2 审查链**：reviewer + schema + render + steer 闭环，用一份最小规则表（5 条）跑通。
- **M3 规范**：补全四维度规则与原则层，用真实 diff 校准误报。
- **M4 打磨**：熔断、截断、可观测性、测试补齐。


## 16. M0 核签记录（2026-11-10）

做法：不装任何 profile，用 `dsh --profile headless --patch /tmp/m0probe/patch.yml` 叠加一次性探针插件，在临时 git 仓库跑一轮真实任务（「把 a.js 里的 a 改成 2」），探针在 `agent/turn-stopping` 里依次做四件事并把结果写到文件。

| 待验证 | 结果 | 证据 |
|---|---|---|
| turn-stopping 在主会话自然停止时触发 | ✅ | `STOPPING turn 1 origin <空> sid session-…` |
| 同一时刻能读到本轮 `workspaceChanges.summary` | ✅ | `SUMMARY seq 46 shape [turn,cwd,files,total,added,deleted,snapshot] files 1 total 1` |
| `startActivation` + `agentPreset` + `outputSchema` | ✅ | `RESULT stopReason completed structured {"ok":true,"note":"m0"}` |
| 子代理不会被误审（递归门禁） | ✅ | `STOPPING turn 1 origin subagent` → `SKIP subagent` |
| `steer` 能把轮次续上 | ✅ | steer 后模型回复 `PROBE_STEERED`，同一 turn 内再次触发 stopping（`turn 1`，新 seq 55） |

顺带钉实了三件会踩坑的事：

1. `dsh-tool-fs-search` 的 `sampleOverCapGlobResults` 是必填字段，漏了 preset 直接挂载失败（`invalid config: $.sampleOverCapGlobResults missing required value`）。
2. `steer` 的消息必须带 `source`，否则渲染时 `Cannot read properties of undefined (reading 'kind')`。
3. `steer` 之后 turn 号不变，同一 turn 会再次触发 turn-stopping——这正是 §9.1 要用 `(sessionId, turn)` 计数而不能拿 turn 当轮数的原因。

未验证的部分：`/review` 命令路径、真实 diff 的审查质量、熔断与截断。它们属于 M1–M3。
