# DSH Bug 工作流插件 — P0 验证（Spike）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 6 个 spike 消除插件最不确定的技术点，产出一个可继续演进的 spike bundle 和一份带证据的 findings 文档，作为 P1 实现计划的输入。

**Architecture:** 先用一个纯 JS 的 DSH bundle（host `index.js` + client `client.js` + `cordis.patch.yml`）验证「第三方插件能否占用右栏 tab」；其余技术点用独立 Node 脚本验证（平台内部 REST、GitLab REST、子代理 + worktree、storageDomain 持久化）。所有探测产物放 `bug-workflow/.tmp/`（gitignored），结论写入 findings 文档。

**Tech Stack:** DSH 0.2.2-rc.1（Cordis 插件 API：`ctx.slots` / `ctx.sidebarRightTabs` / `ctx.subagents` / `ctx.storageDomain` / `ctx.webServer`）、Node 22 内置 `fetch`、GitLab REST v4、星瞰河山平台内部 REST、git CLI。

## Global Constraints

- 目标运行环境 DSH 0.2.2-rc.1 desktop profile；插件安装只用 `plugin_manager(action:'install_bundle', target:<abs path>)`，失败再用 `dsh plugin --profile desktop add link:<abs path>`。
- 不手写 `~/.dsh/profiles/desktop/` 下的 `package.json` / `cordis.patch.yml`；不 `cd` 到 profile 目录跑 pnpm。
- 敏感数据只允许出现在 `bug-workflow/.tmp/`（gitignored）与本机 `ctx.credentials`；**任何 token、密码不得打印到聊天/日志、不得提交**。
- git 操作只在临时仓库或本插件仓库内；不碰真实业务仓库、不 push 任何远端。
- 每个 spike 完成后更新 `docs/superpowers/spikes/2026-11-06-p0-findings.md`，写「结论 + 证据 + 后续动作」。
- 动 UI/host 代码前先读 skill `cordis-plugin-development` 的参考：`references/host-plugin.md`、`references/ui-plugin.md`、`references/practices.md`、`references/verification.md`、`references/user-actions.md`（base dir 见 skill 工具返回值；在 app.asar 里只能用文件读取工具读）。
- 提交风格：`feat(bug-workflow): …` / `docs(bug-workflow): …`；一个 task 至少一个 commit。
- 计划依据：[设计文档](../specs/2026-11-06-dsh-bug-workflow-plugin-design.md)。

## 已确认的前置事实（可直接用，不需要再查）

- 平台登录页：`https://ecard.htwisdom.cn/user/login`；输入框 `tenantId`（登录租户）、`username`、`password`、验证码。
- 验证码接口（无需鉴权）：`GET /api/htwisdom-auth/oauth/captcha` → `{ key, image }`，`image` 是 `data:image/png;base64,...`。
- 登录接口：`POST /api/htwisdom-auth/oauth/token`，payload 形如 `{ type:'account', scope:'all', grant_type:'captcha', deptId:'', roleId:'', ...form, password:<前端 RSA 加密> }`。
- token 存 `localStorage['access-token']`；业务请求头 `Htwisdom-Auth: <token>`；另有 `Authorization: Basic <clientId:clientSecret>`（来自 `/api/htwisdom-system/app`）。
- 平台接口：`/api/htwisdom-team/task/detailByTaskCode/{code}`、`/api/htwisdom-team/remark/list`、`/api/htwisdom-team/file/list`、`/api/htwisdom-team/task/{tree,parent,taskCount,update,updateBatch}`、`/api/htwisdom-team/{version_unit,milestone}`、`/api/htwisdom-system/dict/business/dictionary`、`/api/htwisdom-system/user-auth-info`。
- GitLab：`https://git.htwisdom.cn`，示例 MR `wisdom-financial-service-platform/wisdom-financial-credit-platform-web!223`；AI Review 是指定用户发出的 note，正文含 `AI Code Review`、`结论:`、`需要关注的问题`、`历史未收敛问题`，末尾有「隐藏数据」段需要裁掉。

## File Structure

- `bug-workflow/` — P0 spike bundle（P1 在其上演进为正式包）
  - `package.json` / `cordis.patch.yml` / `index.js` / `client.js` / `icon.svg`
  - `scripts/probe-platform.mjs` — 平台 token 取数与接口探测
  - `scripts/review-parser.mjs` — AI Review 解析器（P1 会移入正式 src）
  - `scripts/fixtures/review-needs-fix.md`、`scripts/fixtures/review-pass.md` — 去敏后的真实评论
  - `scripts/make-temp-repo.mjs` — 子代理/worktree spike 用的临时仓库
  - `.tmp/`（gitignored）
- `docs/superpowers/spikes/2026-11-06-p0-findings.md` — 全部 spike 结论
- `.gitignore` — 增加 `bug-workflow/.tmp/`

---

### Task 1: Spike A — 最小 bundle + 右栏 tab 占座

**Files:**
- Create: `bug-workflow/package.json`、`bug-workflow/cordis.patch.yml`、`bug-workflow/index.js`、`bug-workflow/client.js`、`bug-workflow/icon.svg`
- Create: `docs/superpowers/spikes/2026-11-06-p0-findings.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: bundle 包名 `@liyuera/dsh-bug-workflow`，右栏 tab kind `bug-board`。后续 Task 4/5 复用这个已安装的 bundle。

- [ ] **Step 1: 读参考与模板**

Read（文件读取工具，不要用 cat）：
- `<skill base>/references/ui-plugin.md`、`references/host-plugin.md`、`references/practices.md`
- `<skill base>/templates/decoration/package.json`、`cordis.patch.yml`、`index.js`、`client.js`、`icon.svg`

- [ ] **Step 2: 读取安装版官方消费者的注册写法（权威）**

Read `/Users/liyu/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js`，搜索 `sidebar.right.pane.tab` 与 `sidebarRightTabs`，把「tab 定义字段 + slot 注册字段」原文摘到 findings 文档（0.2.2 的实际契约以它为准）。

同时检查 `bug-workflow/icon.svg` 可用（从模板复制即可，P1 再换正式图标）。

- [ ] **Step 3: 创建 bundle 文件**

`bug-workflow/package.json`：

```json
{
  "name": "@liyuera/dsh-bug-workflow",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right"]
    }
  }
}
```

`bug-workflow/cordis.patch.yml`：

```yaml
- insert:
    - id: bug-workflow
      name: '@liyuera/dsh-bug-workflow'
```

`bug-workflow/index.js`：

```js
/** Host half. P0 spike: later tasks add probe routes here. */
export function apply() {}
```

`bug-workflow/client.js`（字段名以 Step 2 读到的 0.2.2 契约为准；下面是预期形状）：

```js
window.__ModuleLoader__.load({
  id: '@liyuera/dsh-bug-workflow',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ID = '@liyuera/dsh-bug-workflow';

    function BoardTab() {
      return h('div', {
        style: { padding: '16px', color: 'var(--dsw-alias-text-primary, inherit)', font: '13px/1.5 system-ui, sans-serif' },
      }, [
        h('div', { key: 'title', style: { fontWeight: 600 } }, 'Bug 工作流（P0 spike）'),
        h('div', { key: 'desc', style: { opacity: 0.7, marginTop: 8 } }, '右栏 tab 占座验证'),
      ]);
    }

    return {
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: 'bug-board',
          title: () => 'Bug 看板',
          multiple: false,
          guide: { order: 100, title: () => 'Bug 看板' },
        }));
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: ID,
        }, BoardTab));
      },
    };
  },
});
```

`.gitignore` 追加：

```
.tmp/
bug-workflow/.tmp/
```

新建 findings 文档骨架（每节固定四段，后续 task 往里填）：

```md
# P0 Spike Findings（2026-11-06）

### Spike A — 右栏 tab 占座
### Spike B — 平台取数
### Spike C — GitLab + AI Review 解析
### Spike D — 子代理 + worktree
### Spike E — storageDomain 持久化
### Spike F — 兜底抽屉（条件任务）
```

- [ ] **Step 4: 语法检查**

Run: `node --check bug-workflow/client.js && node --check bug-workflow/index.js`
Expected: 无输出（退出码 0）。

- [ ] **Step 5: 提交**

```bash
git add .gitignore bug-workflow
git commit -m "feat(bug-workflow): P0 spike bundle 与右栏 tab 占座"
```

- [ ] **Step 6: 安装**

1. `plugin_manager(action:'list_plugins', limit:100)` 确认 `@liyuera/dsh-bug-workflow` 尚未存在。
2. `plugin_manager(action:'install_bundle', target:'/Users/liyu/Documents/www/DeepSeek/deepseek-harness/deepseek-harness-plugin/bug-workflow')`。
3. 期望：`application: applied` 且无 slot crash 警告；若失败按 Global Constraints 回退 `dsh plugin --profile desktop add link:<abs>`。

- [ ] **Step 7: 验证占座**

- 刷新 DSH Web GUI（或重启应用），右侧栏 guide 应出现「Bug 看板」入口；点击打开 tab，显示 spike 文案；刷新页面后 tab 仍在。
- 若 client inspect 可用：`cordis_inspect_query(platform:'client', provider:'Slots', method:'listSubTree', ...)` 查 `sidebar.right.pane.tab` 是否含本包注册。
- 若页面不可驱动：把「需要用户目视确认」写进 findings 的「未验证项」，不要伪造结论。

- [ ] **Step 8: 记录 findings 并提交**

把「是否成功占座 / 实际字段 / 失败原因 / 降级判断（是否走 Task 6）」写进 `docs/superpowers/spikes/2026-11-06-p0-findings.md`。

```bash
git add docs/superpowers/spikes/2026-11-06-p0-findings.md
git commit -m "docs(bug-workflow): Spike A 结论（右栏 tab 占座）"
```

---

### Task 2: Spike B — 平台取数（token 模式）与接口测绘

**Files:**
- Create: `bug-workflow/scripts/save-token.mjs`、`bug-workflow/scripts/probe-platform.mjs`
- Modify: `docs/superpowers/spikes/2026-11-06-p0-findings.md`

**Interfaces:**
- Produces: `bug-workflow/.tmp/platform-token.json`（`{ token, savedAt }`，gitignored）；findings 中的「可用接口清单 + 列表接口结论」。

- [ ] **Step 1: 让用户提供 token（不经过聊天）**

写 `bug-workflow/scripts/save-token.mjs`：从 stdin 读取全部输入（不做终端回显提示），写入 `bug-workflow/.tmp/platform-token.json`（`fs.mkdirSync(..., {recursive:true})`；文件权限 `0o600`）。

请用户在本机执行（macOS，从剪贴板取 token，不经过对话）：

```bash
mkdir -p bug-workflow/.tmp
pbpaste | node bug-workflow/scripts/save-token.mjs
```

Expected: `saved to bug-workflow/.tmp/platform-token.json`，且 `git status` 不出现该文件。

- [ ] **Step 2: 写 probe 脚本**

`bug-workflow/scripts/probe-platform.mjs` 必须：

1. 读 `.tmp/platform-token.json`（缺失则报错退出，提示先跑 `save-token.mjs`）。
2. 探测并打印（只打印状态码/top-level 字段名，不打印 token）：
   - `GET /api/htwisdom-system/user-auth-info`
   - `GET /api/htwisdom-team/task/detailByTaskCode/YGFNXDJRFWDJSYJJYY-647`
   - `GET /api/htwisdom-system/dict/business/dictionary`（记录字典返回结构）
   - `GET /api/htwisdom-team/remark/list`（按详情返回的参数试探）
3. 请求头至少尝试 `Htwisdom-Auth: <token>`；若 401/403，再补 `Authorization: Basic <clientId:clientSecret>`（client 凭证从 `GET /api/htwisdom-system/app` 返回里取，只打印字段名不打印值）。
4. 退出码：全部关键接口 200 → 0；任一失败 → 1，并打印失败原因。

- [ ] **Step 3: 跑通并记录**

Run: `node bug-workflow/scripts/probe-platform.mjs`
Expected: `detailByTaskCode` 返回工单 647 的 title/type/status/version 字段；把「鉴权头、必要 query 参数、返回字段映射」写进 findings。

- [ ] **Step 4: 补找列表接口（我的工单查询）**

用 chrome_eval 在平台 tab（`https://ecard.htwisdom.cn/HT_TEAM/...`）上扫描已加载 chunk 里的候选路径（表达式对本任务可复用；结果只保留路径字符串）：

```js
[...new Set(performance.getEntriesByType('resource')
  .map(e => { try { const u = new URL(e.name); return u.origin === location.origin && /\.js$/.test(u.pathname) ? u.pathname : null } catch { return null } })
  .filter(Boolean))]
```

逐个 `fetch` 后 `match(/["'`](\/htwisdom-team\/task\/[A-Za-z0-9_\-\/]+)["'`]/g)`，候选去重。对候选用 probe 脚本的 token 逐个 GET/POST 试探（先 GET `?pageNum=1&pageSize=10` 一类，记录 404/405 与成功响应字段）。

Expected: 找到「按负责人/项目查工单列表」的接口，或明确记录「未找到，降级为手动按编号添加」（写进 findings，作为 P2 输入）。

- [ ] **Step 5: 状态写回接口识别（可选，失败不阻塞）**

对 `/api/htwisdom-team/task/update`（POST）只做**文档级确认**（读 JS 调用处的 payload 字段名），不在真实工单上试写。把 payload 形状写进 findings。

- [ ] **Step 6: 记录登录自动化路径（只记录，不实现）**

已知：验证码 `GET /api/htwisdom-auth/oauth/captcha` 返回 `{key, image}`；登录 `POST /api/htwisdom-auth/oauth/token` 的 `password` 由前端 RSA 加密（JSEncrypt），公钥来源未确认。把三条候选路径写进 findings，供 P1 选型：

1. **原生 HTTP 登录**：需要找公钥来源（页面配置/接口）并复刻 RSA 加密；成本中，体验最好。
2. **页面驱动登录**：插件用 CDP 起独立 Chrome，填表 + 截图验证码给用户输入 + 从页面 localStorage 读 token；可复用 chrome-browser 的 CDP 代码；成本高但稳。
3. **token 粘贴（P0 已验证可用）**：用户从浏览器 localStorage 粘贴 `access-token`；成本最低，作为降级路径。

不要求在本任务实现登录，只要求把候选与证据写清楚。

- [ ] **Step 7: 提交**

```bash
git add bug-workflow/scripts docs/superpowers/spikes/2026-11-06-p0-findings.md
git commit -m "feat(bug-workflow): 平台 token 取数探测脚本与接口结论"
```

---

### Task 3: Spike C — GitLab API + AI Review 解析器

**Files:**
- Create: `bug-workflow/scripts/fixtures/review-needs-fix.md`、`bug-workflow/scripts/fixtures/review-pass.md`
- Create: `bug-workflow/scripts/review-parser.mjs`、`bug-workflow/scripts/probe-gitlab.mjs`
- Modify: `docs/superpowers/spikes/2026-11-06-p0-findings.md`

**Interfaces:**
- Produces: `parseReview(noteBody) -> { verdict: 'pass'|'changes'|'unknown', blocking: ReviewIssue[], nonBlocking: ReviewIssue[] }`；`ReviewIssue = { file, fid, level, gateCategory, location, problem, suggestion }`。P1 直接复用该实现。

- [ ] **Step 1: 写 fixtures（去敏）**

从设计文档 §8.2 与真实 MR 示例（会话里已有全文）各摘一段：
- `review-needs-fix.md`：`结论: 需要修改` + 2 个阻塞/非阻塞问题 + 隐藏统计段。
- `review-pass.md`：`结论: 可直接合并` + 「历史未收敛问题」+ 隐藏统计段。

去敏规则：仓库路径改成 `src/...`，人名/hash 改占位；**保留格式骨架**（结论行、字段名、隐藏段标记）。

- [ ] **Step 2: 写解析器**

`review-parser.mjs` 导出 `parseReview(body)`：

1. 未同时出现 `AI Code Review` 与 `结论:` → `{ verdict:'unknown' }`。
2. 截断 `备注：以下隐藏数据仅用于统计` 之后内容。
3. `结论:\s*可直接合并` → pass；`结论:\s*需要修改` → changes。
4. 抽取「需要关注的问题」「历史未收敛问题」块里的条目：`文件:`、`FID:`、`级别:`、`门禁分类:`、`位置:`、`问题:`、`建议:`。
5. 分类：`门禁分类=非阻塞建议` 或 `级别=低` → nonBlocking；其余 → blocking。
6. 解析失败（有结论但没有条目 / 格式异常）→ `unknown`（P1 会转 blocked，不猜）。

- [ ] **Step 3: 用 fixtures 跑通**

在文件底部加自测入口：`node bug-workflow/scripts/review-parser.mjs` 打印两份 fixture 的解析结果。
Expected：needs-fix → `verdict:'changes'`、blocking ≥1；pass → `verdict:'pass'`、blocking 0。把实际结果贴进 findings。

- [ ] **Step 4: 真实 API 验证（需要用户 token）**

参考 `save-token.mjs` 的模式，让用户保存 GitLab token 到 `bug-workflow/.tmp/gitlab-token.json`（scope=`api`，不回显）。

`probe-gitlab.mjs`：
1. `GET https://git.htwisdom.cn/api/v4/projects/wisdom-financial-service-platform%2Fwisdom-financial-credit-platform-web/merge_requests/223/notes?sort=desc&per_page=100`
2. 过滤 `body` 含 `AI Code Review` 的 notes；对最新一条跑 `parseReview`。
3. 打印：note 数、最新 note 的 verdict、阻塞项数量、issues 前 3 条的文件/级别。
Expected：能拉到真实 notes，解析结果与 GitLab 页面一致。

- [ ] **Step 5: 提交**

```bash
git add bug-workflow/scripts docs/superpowers/spikes/2026-11-06-p0-findings.md
git commit -m "feat(bug-workflow): GitLab AI Review 解析器与真实接口验证"
```

---

### Task 4: Spike D — 子代理 + worktree

**Files:**
- Modify: `bug-workflow/index.js`（加 host 路由与 agent 捕获）
- Create: `bug-workflow/scripts/make-temp-repo.mjs`
- Modify: `docs/superpowers/spikes/2026-11-06-p0-findings.md`

**Interfaces:**
- Produces: host 路由 `GET /bug-workflow/spike/subagent`（返回 JSON：`{ ok, childId, files, result }`）；findings 中的「子代理调用契约 + 父 Agent 获取方式」。

- [ ] **Step 1: 读服务契约**

Read 安装版 `@deepseek-ai/dsh-subagent/README.md`、`@deepseek-ai/dsh-agent/README.md`（base dir：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/`；用 read 工具，bash 读不到 app.asar）。
用 `cordis_inspect_query(platform:'host', provider:'Service', method:'listService')` 确认 `subagents.startActivation` / `agents` 的 live 方法签名与参数。

- [ ] **Step 2: 写临时仓库脚本**

`make-temp-repo.mjs`：在 `bug-workflow/.tmp/spike-repo/` 初始化 git 仓库，提交 `hello.txt`（内容 `hello`），并执行：
`git worktree add ../worktree -b spike-branch`
Expected：worktree 目录存在且 `git status` 干净。

- [ ] **Step 3: 在 host 插件里加捕获 + 路由**

`index.js`：
1. `ctx.on('agent/created', ({ agent }) => { lastAgent = agent })`（若事件形状不同，按 README 修正并在 findings 记录）。
2. `ctx.webServer.register({ kind:'exact', path:'/bug-workflow/spike/subagent', handler })`：
   - 无 live agent → 500 `{ error: 'no live agent' }`；
   - 有 → `await ctx.subagents.startActivation({ provider:'spawn', label:'p0-spike', delivery:'caller', request: { prompt: '在 worktree ../worktree 里把 hello.txt 改成 hello p0，并返回改了哪些文件', parent: lastAgent, cwd: <spike repo 路径> } })`；
   - 返回 `{ ok, childId, result, files: <git status --porcelain 结果> }`。
3. 重新安装 bundle（`plugin_manager install_bundle`，目标同一路径；若 install 不覆盖已装版本，改用 `dsh plugin --profile desktop update` 或先 remove 再 add）。

- [ ] **Step 4: 触发并验证**

端口取当前会话 runtime context 里的 Web GUI URL（`http://127.0.0.1:<port>`），或 `dsh --profile desktop --dump-config` 里的监听端口：

```bash
curl -s "http://127.0.0.1:<port>/bug-workflow/spike/subagent"
```

Expected：`ok:true`，`hello.txt` 在 worktree 中被修改，`files` 含该文件。
若 startActivation 需要 exact live parent 且捕获失败，记录错误信息与替代方案（例如通过 `ctx.agents.create` 建专用 worker 会话）到 findings。

- [ ] **Step 5: 提交**

```bash
git add bug-workflow docs/superpowers/spikes/2026-11-06-p0-findings.md
git commit -m "feat(bug-workflow): 子代理与 worktree spike"
```

---

### Task 5: Spike E — storageDomain 跨重载持久化

**Files:**
- Modify: `bug-workflow/index.js`（加 `/bug-workflow/spike/state` 路由）
- Modify: `docs/superpowers/spikes/2026-11-06-p0-findings.md`

**Interfaces:**
- Produces: `GET /bug-workflow/spike/state?action=write|read`，findings 中的「storageDomain 打开/读写/关闭契约」。

- [ ] **Step 1: 读契约**

Read `@deepseek-ai/dsh-storage-domain*/README.md`（按 `cordis_inspect_query` 的 `Service` 找到实际包与 `storageDomain.open` 签名）；记录 `defineDomain` 字段与 `close()` 责任。

- [ ] **Step 2: 实现路由**

在插件 apply 里打开 domain（插件卸载时 close），路由：
- `write`：写入 `{ id:'spike', at: Date.now() }`，返回写入值；
- `read`：读取并返回当前值。

- [ ] **Step 3: 验证跨重载/重启**

1. `curl .../state?action=write` → 记录 `at`。
2. 重启 DSH 应用（或卸载再安装 bundle；以重启为准）。
3. `curl .../state?action=read` → 值仍在，且 `at` 与写入一致。
Expected：持久化成立。若失败，记录存储位置与错误，作为 P1 设计输入。

- [ ] **Step 4: 提交**

```bash
git add bug-workflow docs/superpowers/spikes/2026-11-06-p0-findings.md
git commit -m "feat(bug-workflow): storageDomain 持久化 spike"
```

---

### Task 6: Spike F — 兜底抽屉（仅当 Task 1 占座失败才执行）

**Files:**
- Modify: `bug-workflow/client.js`
- Modify: `docs/superpowers/spikes/2026-11-06-p0-findings.md`

**Interfaces:**
- Produces: 会话标题栏最右侧按钮 + 右侧抽屉（`shell.overlay`），若 Task 1 成功则本任务跳过并在 findings 标注 skipped。

- [ ] **Step 1: 读现成实现**

Read `dev-dock/src/client/index.ts`（`shell.overlay` 注册、StartWorkModal 浮层）与 `chrome-browser/src/client/index.ts`（header utilities）；确认 `conversation.session.header.utilities` 与 `shell.overlay` 的 0.2.2 契约（必要时读安装版对应 `lib/client.js`）。

- [ ] **Step 2: 实现**

在 client.js 注册：
1. `conversation.session.header.utilities` 一个按钮（文案「Bug」）；
2. 点击后 `ctx.slots` 里已注册的 `shell.overlay` 抽屉开合（本地 state + 遮蔽层 + Esc 关闭 + `pointer-events:auto`）。

- [ ] **Step 3: 验证**

刷新 GUI：会话标题栏最右出现按钮，点击打开抽屉，Esc/遮罩关闭；刷新后状态复位（可接受）。

- [ ] **Step 4: 提交**

```bash
git add bug-workflow docs/superpowers/spikes/2026-11-06-p0-findings.md
git commit -m "feat(bug-workflow): 兜底抽屉 spike"
```

---

## Findings 文档要求

`docs/superpowers/spikes/2026-11-06-p0-findings.md` 每节固定四段：

```md
### Spike X — <名称>
- 结论：成功 / 失败 / 部分成功
- 证据：命令、状态码、关键字段、文件路径（不含 token/密码）
- 影响：对 P1 计划的具体改动
- 未验证项：需要用户目视或线下确认的点
```

## P0 退出标准

- Task 1 有明确结论（成功 → P1 用右栏 tab；失败 → 执行 Task 6 并用抽屉）。
- Task 2/3 至少在真实系统上跑通一次（平台详情接口、GitLab notes 解析）。
- Task 4/5 在 live DSH 里跑通或有明确失败原因与替代方案。
- findings 文档完整，可据此写 P1 实现计划。
