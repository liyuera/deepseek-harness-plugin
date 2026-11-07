# 轻量规格 · 平台内自动登录（替换 token 粘贴为主路径）

- **目标**：在「Bug 看板 → 设置 → 平台连接」内完成星瞰河山平台登录（账号/密码/图形验证码），成功后自动把 `access-token` 写入宿主凭据，同步/导入立即可用；密码只在宿主内存中用于这一次登录请求，不落库、不写日志、不回显。
- **接口（本轮 live 校准）**：
  1. `GET {baseUrl}/api/htwisdom-system/system/open-api/system-config?tenantId=000000` → 公开 `{code:200,data:{clientId,clientSecret,defaultTenant,…}}`；应用级 OAuth 客户端，用于登录请求的 `Authorization: Basic base64(clientId:clientSecret)`（前端同款；**不含用户密码**）。
  2. `GET {baseUrl}/api/htwisdom-auth/oauth/captcha` → flat `{key, image(base64)}`。
  3. `POST {baseUrl}/api/htwisdom-auth/oauth/token`：头 `Authorization: Basic …`、`Tenant-Id`、`Captcha-key`、`Captcha-code`、`Dept-Id:''`、`Role-Id:''`，以及浏览器同款 `Origin`/`Referer: {base}/user/login`/`User-Agent`/`X-Requested-With: XMLHttpRequest`/`Menu-Classify: 1`（缺这些会返回「登录请求缺少平台信息」，即使验证码正确）；体必须是 **form-urlencoded**：`type=account&scope=all&grant_type=captcha&deptId=&roleId=&tenantId=…&username=…&password=md5(raw)&code=…`；**成功响应是扁平 token 对象**（实测 DevTools）：`{access_token, token_type:"bearer", account, nick_name, refresh_token, expires_in, tenant_id, user_id, …}`（无 `code/success/data` 信封；兼容 `{code:200,data:…}` 形态）。失败返回 `{code:400,msg:'验证码不正确'|'Bad credentials'|…}`。表单字段需含 `source`（空字符串）。JSON 体/缺 Basic 都会被上游静默忽略（200 空体），必须按上述形态发送。
  4. token 按 `Htwisdom-Auth: <access_token>` 使用（与 P0 一致）。
- **范围**：新增 `src/host/platform-login.js`（注入 fetch + md5，纯服务）；`routes.js` 新增 `POST /api/platform-login/captcha`、`POST /api/platform-login`，复用全部安全守卫与 `tokenStore`；`index.js` 接线（非致命）；`client.js` 设置页新增登录表单（验证码图片点击刷新、记住用户名到 localStorage、密码不保存、可折叠的手动 token 降级入口）；`README`/计划同步。
- **边界/反例**：baseUrl 非法/未配置 → 400；账号/密码/验证码为空 → 400；平台返回 code≠200 → 400/401 静态文案（含平台 msg 截断，不回显账号密码）；网络/超时 → 502/504 静态文案；验证码过期/错误 → 可点刷新重试；token 写入失败 → 503 credentials-unavailable；所有路径不得打印或返回密码/token。
- **验收**：
  1. 单测（loopback mock 平台）：captcha 形状/大小上限、md5 密码、tenantId/header 精确、token 解析容错、错误分类、路由守卫/鉴权/成功写 token、密码/token 不外泄。
  2. 全量 `node --test bug-workflow/test/*.test.js` 全绿 + `node --check`。
  3. live：重装后 `POST /api/platform-login/captcha` 返回验证码图片；用户在 GUI 输入一次真实账号密码验证码 → 登录成功 → 同步「我的工单」可用（真实账号密码只经本地宿主→平台，不经过聊天）。
- **不做**：SSO/第三方登录、刷新 token 自动续期、记住密码、token 失效自动重登（401 仍走「登录已失效」提示重新登录，P6 再做自动续期）。
