# Bug 工作流插件 P2（平台接入）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 P1 骨架接上真实数据源（星瞰河山一体化平台）：用 token 从平台同步「我的工单」、按编号导入详情、字典驱动筛选，并让看板展示真实工单；状态写回做成开关（默认关闭）。

**Architecture:** 新增 `src/host/platform.js`（平台 HTTP 客户端，纯 fetch + 结构化错误）、`src/host/credentials.js`（token 存取，走 DSH `ctx.credentials`）、`src/host/sync.js`（同步引擎：拉取/映射/upsert 到现有 store），路由新增 `/api/sync`、`/api/platform-token`，snapshot 扩展 `dicts` 与 `platform` 状态；Ticket 域升到 v2（`source`/`platform` 字段，`compatibleVersions:[1]`）；client 增加 token 设置、同步按钮、字典筛选与平台信息展示。用户不可用，真实 token 不可得：所有平台交互用**本地 mock 平台服务**做 end-to-end 验证；真实平台联调留给用户最终验收。

**Tech Stack:** Node 22 `node:http`/`fetch`、DSH `ctx.credentials`/`ctx.interval`、现有 zod domain/store/routes/client 结构。

## Global Constraints

- 目标运行环境 DSH 0.2.2-rc.1 desktop profile；沿用 P1 的 `peerDependencies` + bare import 方案（`@deepseek-ai/dsh-storage-domain`、`zod` 用 `"*"`，**不要收紧**，否则 host engine 检查会拒绝 prerelease）。
- Token 只经 `ctx.credentials` 存取；**不得进入** `settings` 表、snapshot、日志、错误 message、git。settings 只保存 `platformBaseUrl`/`platformProjectCode` 等非敏感配置。
- 平台写操作（状态写回）默认关闭，由 settings `writebackStatus:false` 控制；P2 只用 mock 验证，不向真实平台写。
- 所有宿主动作仍走 P1 的安全守卫（JSON content-type、loopback Host/Origin/socket、64KB/10s）；新增路由复用 `createHandlers` 的 `wrap/guard`。
- 平台请求只允许 `http(s)`；`platformBaseUrl` 允许 localhost（mock 验证需要），默认 `https://ecard.htwisdom.cn`；拒绝带内嵌凭据的 URL。
- 测试命令 `node --test bug-workflow/test/*.test.js`；每个 task 至少一个 commit（`feat(bug-workflow): …` / `test(...)` / `fix(...)`）。
- 不重启 app：host 改动用 `plugin_manager remove_bundle('@liyuera/dsh-bug-workflow')` → `install_bundle(<abs bundle path>)`。
- 参考：[P0 findings](../spikes/2026-11-06-p0-findings.md)（平台接口/鉴权）、[P1 findings](../spikes/2026-11-07-p1-findings.md)、[设计 spec](../specs/2026-11-06-dsh-bug-workflow-plugin-design.md) §8.1/§8.4/§14。

## 接口与数据契约（所有 task 必读）

**平台接口**（P0 已实测/代码级确认）：

| 用途 | 方法/路径 | 关键参数 |
|---|---|---|
| 当前用户 | `GET /api/htwisdom-system/user-auth-info` | — → `data.user.{id,code,account,name}` |
| 我的工单 | `GET /api/htwisdom-team/task` | `current`、`size`、`refHandlerPersonId`、`taskStatusList`(重复)、`descs=createdTime` → `{records,total,...}` |
| 工单详情 | `GET /api/htwisdom-team/task/detailByTaskCode/{code}` | — → `data`（45 字段） |
| 字典 | `GET /api/htwisdom-system/dict/business/dictionary` | `codes=teamTaskStatus,teamTaskType,teamTaskPriority`（**必填**） |
| 评论 | `GET /api/htwisdom-team/remark/list` | `refTaskCode`、`remarkType=001_TASK` |
| 附件 | `POST /api/htwisdom-team/file/list` | body `{refBusinessIdList:[taskId]}` |
| 状态写回（默认关） | `POST /api/htwisdom-team/task/update` | body `{id,columnUpdateDTOList:[{fieldName,fieldValue}]}` |

鉴权头：`Htwisdom-Auth: <token>`（无需 Cookie/Basic）。所有响应信封 `{code,success,data,msg}`；HTTP 401 → token 失效。

**Ticket 平台扩展（domain v2）**：

```js
source: 'platform' | 'manual'            // 默认 'manual'
platform: null | {
  taskId: string, taskCode: string,
  typeKey: string, typeName: string,
  statusKey: string, statusName: string,   // 平台侧状态，与本地 workflow 分离
  priorityKey: string, priorityName: string,
  versionKey: string, versionName: string,
  projectId: string|null, projectName: string|null,
  assigneeId: string|null, assigneeName: string|null,
  description: string,
  url: string,
  syncedAt: number
}
```

**新增路由**：

- `POST /bug-workflow/api/platform-token` body `{sessionId, token}` → `{ok:true, tokenPresent:true}`；`DELETE` 或 `{token:null}` → 清除。token 只写不读。
- `POST /bug-workflow/api/sync` body `{sessionId}` → `{ok:true, synced, created, updated, total, lastSyncAt}`；无 token → 400 `{code:'no-platform-token'}`；上游 401 → 401 `{code:'platform-unauthorized'}`。
- `GET /api/snapshot` 扩展：`dicts:{status:[{key,value,color}],type:[...],priority:[...]}`, `platform:{tokenPresent,lastSyncAt,lastSyncError}`（不改变 P1 已有字段）。

**settings 扩展**（仍按 cwd 存）：

```js
platformBaseUrl: 'https://ecard.htwisdom.cn',
writebackStatus: false,
```

**client**：设置面板加「平台连接」区（token 密文输入 + 保存/清除 + 状态点 + 同步按钮 + 上次同步时间/错误）；列表筛选选项来自 snapshot.dicts；手动添加改为服务端按编号导入（payload 仍 `{code}`，宿主在有 token 时调详情接口补全）；详情/列表展示平台类型/状态/负责人 + 外链。

---

### Task 1: 凭据存储 + 平台 token 路由与设置 UI

**Files:**
- Create: `bug-workflow/src/host/credentials.js`
- Modify: `bug-workflow/index.js`、`bug-workflow/src/host/routes.js`
- Modify: `bug-workflow/client.js`
- Test: `bug-workflow/test/credentials.test.js`（fake credentials）、`bug-workflow/test/routes.test.js`（新增用例）

**Interfaces:**
- Produces: `createTokenStore(credentials) → {get, set, clear, present}`；路由 `POST /bug-workflow/api/platform-token`；snapshot `platform.tokenPresent`；client 设置面板「平台连接」区。

- [ ] **Step 1: 读 `ctx.credentials` 契约**：`cordis_inspect_query(platform:'host', provider:'Service', method:'listService', input:{service:'credentials'})` + 安装版 `@deepseek-ai/dsh-credentials-local/README.md`（file-read）。记录 `set/resolve/describe/unset` 与 `credentialRef` 用法，写进 report。
- [ ] **Step 2: 失败测试**：fake credentials 验证 token store 的 set/get/clear/present、空 token 拒绝、错误不泄漏 token；路由用例：合法 JSON + 同源 → 200 且 token 只进 credentials（fake 记录）、snapshot `tokenPresent` 翻转、`text/plain` → 415、无 session → 400。
- [ ] **Step 3: 实现** credentials.js（credential key `bug-workflow.platform-token`，只 set/resolve，不打印）+ routes（`platform-token` POST，复用 guard；snapshot 注入 tokenPresent）+ index.js 组装 + client 设置面板「平台连接」区（密文输入、保存/清除、状态点「已配置/未配置」；token 永不回显；未绑定工作区时禁用保存）。
- [ ] **Step 4: 验证**：`node --test` 全过；live remove→install 后 `POST /platform-token {token:'p2-dummy-token'}` → 200，snapshot `platform.tokenPresent:true`，curl 响应不含 token；再清除 → false。
- [ ] **Step 5: 提交** `feat(bug-workflow): 平台 token 凭据存储与设置入口`。

---

### Task 2: Domain v2 + 平台工单字段 + 迁移

**Files:**
- Modify: `bug-workflow/src/host/domain.js`、`bug-workflow/src/host/store.js`（如需 create 默认值）
- Test: `bug-workflow/test/domain-v2.test.js`

**Interfaces:**
- Produces: domain `bug_workflow` version **2**，`compatibleVersions:[1]`，Ticket schema 含 `source`/`platform`；`store.create()` 默认 `source:'manual', platform:null`；`store.applySync(records)` 供 Task 4 使用（见 Task 4）。

- [ ] **Step 1: 失败测试**：v1 形状 ticket（无 source/platform）经 v2 ticketSchema.parse 通过并补默认；非法 platform 字段被拒；v1 文件 `unit.version:1` 在 v2 spec + `compatibleVersions:[1]` 下可 open（用 fake domain/直接测试 spec 定义）；create 后 `source:'manual'`。
- [ ] **Step 2: 实现**：`domain.js` 升 version:2、加 `compatibleVersions:[1]`、platformSchema；store 的 `initialTicket` 调用点补默认（state-machine 的 `initialTicket` 不改语义，可在 store 包装时补字段）。
- [ ] **Step 3: 验证**：`node --test` 全过；live remove→install 后 health 200 且既有 5 张工单仍可读（v1→v2 兼容），`~/.dsh/storages/bug_workflow.json` 的 `unit.version` 变为 2（记录 md5 前后）。
- [ ] **Step 4: 提交** `feat(bug-workflow): domain v2 平台工单字段与 v1 兼容`。

---

### Task 3: 平台 HTTP 客户端 + mock 平台服务

**Files:**
- Create: `bug-workflow/src/host/platform.js`、`bug-workflow/scripts/mock-platform.mjs`、`bug-workflow/scripts/fixtures/platform/*.json`
- Test: `bug-workflow/test/platform.test.js`

**Interfaces:**
- Produces: `createPlatformClient({ baseUrl, token, fetchImpl? })` → `{getUser, listMyTasks({page,size}), getTask(code), getDicts(), getRemarks(code), listFiles(taskId)}`；错误对象 `{ok:false, code:'platform-unauthorized'|'platform-http'|'platform-network'|'platform-bad-response', status?, message}`；`mock-platform.mjs` 可作为独立进程启动（`node scripts/mock-platform.mjs --port 0 --token test-token --fixtures scripts/fixtures/platform`，打印实际端口）。

- [ ] **Step 1: 失败测试**：用 `node:http` 起的测试内 mock（fixtures）验证 5 个接口的 URL/参数/头（`Htwisdom-Auth`）、分页、401/404/500 映射、非 JSON 响应、超时；`baseUrl` 校验（非 http(s)/带凭据 → code `invalid-base-url`）。
- [ ] **Step 2: 实现 platform.js**（fetch + AbortSignal 超时 15s；`code,success,data` 信封解包；错误绝不包含 token）。
- [ ] **Step 3: 实现 mock-platform.mjs + fixtures**：按 P0 实测字段造 3 张工单（2 张属于 `YGFNXDJRFWDJSYJJYY-*`，1 张其它项目）、字典 3 组、详情/评论/附件；token 校验（错误 token → 401）；支持 `--port`。
- [ ] **Step 4: 验证**：`node --test` 全过；手动起 mock：`node bug-workflow/scripts/mock-platform.mjs --port 0 --token test-token`，curl 两个接口确认；记录输出。
- [ ] **Step 5: 提交** `feat(bug-workflow): 平台 HTTP 客户端与本地 mock 服务`。

---

### Task 4: 同步引擎 + /api/sync + interval + snapshot 扩展

**Files:**
- Create: `bug-workflow/src/host/sync.js`
- Modify: `bug-workflow/src/host/routes.js`、`bug-workflow/index.js`、`bug-workflow/src/host/store.js`
- Test: `bug-workflow/test/sync.test.js`、`bug-workflow/test/routes.test.js`

**Interfaces:**
- Produces: `createSyncService({store, tokenStore, settingsFor, platformClientFor, clock})` → `{run(sessionId), status()}`；store 新增 `upsertPlatformRecords(records)`（保留既有 workflow/plan/mr/fixes/timeline，只更新平台字段与标题/类型/状态名等）；`POST /api/sync`；snapshot 加 `dicts` 与 `platform`；`ctx.interval(600_000)` 自动同步（token 存在时；错误记录不抛出）。

- [ ] **Step 1: 失败测试**：fake platform + 真 store（fake domain）：首次同步创建 tickets（`source:'platform'`，url 正确）；二次同步不重复、保留 workflow 与 timeline；分页合并；`refHandlerPersonId` 来自 `getUser`；项目过滤（`platformProjectCode` 前缀 `-`，空则用全部）；401 → `platform-unauthorized` 且不改数据；字典写入 meta 并出现在 snapshot；interval 单飞（并发调用不重入）。
- [ ] **Step 2: 实现** sync.js + store.upsert + routes `/api/sync`（守卫复用；错误映射：无 token 400、401→401、网络/上游 5xx→502）+ index.js（interval + 组装）。
- [ ] **Step 3: 验证**：`node --test` 全过；live：起 mock、设置 token+baseUrl（用 curl settings）、`POST /api/sync` → 200 `{synced:N}`，snapshot 出现 2 张 mock 工单、`platform.tokenPresent:true`、`dicts` 非空；第二次 sync `updated` 生效且 workflow 保留。
- [ ] **Step 4: 提交** `feat(bug-workflow): 平台工单同步与字典快照`。

---

### Task 5: Client 平台化（token 面板、同步、字典筛选、平台信息、手动导入）

**Files:**
- Modify: `bug-workflow/client.js`

**Interfaces:**
- Consumes: 新增路由/snapshot 字段（Task 1/4）。
- Produces: 可用的平台工作流 UI；`ACTION_BY_STATE`/action-map 测试保持通过。

- [ ] **Step 1: 设置面板「平台连接」**：baseUrl 输入（默认官方域名）、token 密文输入 + 保存/清除 + 状态点；`平台项目编码` 并入平台区；`写回平台状态` 开关（默认关，P2 仅展示）。
- [ ] **Step 2: 列表/筛选**：状态/类型筛选项优先用 `snapshot.dicts`（key/value/color）；每行显示平台状态/类型名与来源标记（平台/手动）；顶部「同步」按钮 + 上次同步时间/错误横幅（401 时提示重新配置 token）。
- [ ] **Step 3: 详情**：展示平台字段（类型/状态/负责人/版本/项目/描述摘要 + 「在平台打开」外链，`http(s)` only）；手动导入：按编号添加改为提示「将从平台导入」，成功后刷新。
- [ ] **Step 4: 回归**：`ACTION_BY_STATE` literal 保持纯字面量、`node --test` 全过；`require('react')` only；主题 token。
- [ ] **Step 5: 提交** `feat(bug-workflow): 看板平台同步与字典筛选`。

---

### Task 6: live E2E（mock 平台）+ README/findings + 收尾

**Files:**
- Modify: `bug-workflow/README.md`、新增 `docs/superpowers/spikes/2026-11-07-p2-findings.md`
- 可能 Modify: `.gitignore`（mock 临时文件）

**Interfaces:**
- Produces: P2 验收记录；README 更新「平台接入」安装/配置步骤与真实联调说明。

- [ ] **Step 1: live E2E**：起 mock 平台（随机端口）；通过 API 设置 `platformBaseUrl=http://127.0.0.1:<port>` + token；`POST /api/sync` → 看板快照出现 2 张 mock 工单（另一项目工单被项目编码过滤）；重复 sync 幂等；token 清空 → sync 400；错误 token → 401；host 半热重载后 tickets/字典/设置仍在。
- [ ] **Step 2: 真实平台说明**：README 写清「如何从浏览器 localStorage 复制 `access-token` 并粘贴到设置」以及真实平台联调为手动验收步骤（用户最终验收）；mock 仅开发验证。
- [ ] **Step 3: findings 文档**：记录 E2E、未验证项（真实平台 token 联调、写回、登录自动化）、遗留 mock 数据清理方法（保留 1-2 张 demo 工单供验收可选）。
- [ ] **Step 4: 提交** `docs(bug-workflow): P2 平台接入验收记录与 README`。

---

## P2 退出标准

- `node --test bug-workflow/test/*.test.js` 全绿（新增 credentials/platform/sync/domain-v2 用例）。
- live（mock 平台）：设置 token+baseUrl 后 sync 成功、看板可见真实结构工单、字典筛选可用、重复 sync 幂等、401/400 错误路径正确、热重载持久化。
- 真实平台联调与写回明确标注为「用户最终验收项」，不在 P2 声称已验证。
- 无 Critical/Important 审查问题；token 不出现在 snapshot/日志/错误/git。
