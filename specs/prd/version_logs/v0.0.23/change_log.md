# v0.0.23 PRD 变更日志 — Web Tools（web_search / web_fetch / browser）+ 配置/连接器

## 概述

本版本交付 **web tools 三件套**（让 agent 能上网）+ **配置域扩展**（web tools group + jina key）+ **连接器页**（browser attach 的用户侧门禁）。

| 交付项 | 一句话定位 | v0.0.23 范围 |
|------|-----------|-------------|
| `web_search` | 按 query 检索，返回结构化结果（+可选 answer） | 协议 + exclusive EP + Tool + **内置 Zhipu provider**（ext impl，凭证走 ext impl configSchema） |
| `web_fetch` | 抓单 URL → 系统代理 → SSRF 校验 → **2 个 ContentFetcher 实现 race**（`JinaContentFetcher` ∥ `LocalContentFetcher` 含 headless 子分支，首个合格者胜）→ markdown | **完整实现**（ContentFetcher 契约 + 2 实现 + 共享 AbortController 构造注入 + detached 清理 + SSRF） |
| `browser` | chrome 自动化三模式 | **三 mode 完整实现**（headless / 持久 profile / attach 已开 chrome）+ 统一 `BrowserDriver`/`BrowserSession` 协议抽象 |
| **配置（web group）** | web_fetch 内置管线的工具级配置 | dev_config 新增 `web` group：`jinaApiKey`(secret, 有则传无则不传) / `jinaEnabled` / `jinaTimeoutMs` |
| **连接器** | browser attach 模式的用户侧门禁 | nav 新增「连接器」页（v0.0.23 仅「浏览器」tab）+ **双状态机**（switch 开关意图/连接实况 + connection 运行时态）+ 持久化 intent + 重启自动重连 + attach 门禁 |

权威输入：`reqs/v0.0.23/reqs.md`（含「配置」「配置功能·连接器」追加）+ `states/v0.0.23/user_query.md`（用户已确认范围决策）。
调研：`specs/research/v0.0.23-web-{search,fetch}.md` + `v0.0.23-browser-use.md`。
**概念权威源（已对齐，见 §7）**：
- tech：`[P1]web_tools.md`（总览+共性）+ `[P1]web_search_tool.md`（v1.1：协议+EP+Zhipu）+ `[P1]web_fetch_tool.md`（v1.3：ContentFetcher 契约 + 2 实现 race）+ `[P1]browser_tool.md`（v1.1：attach 门禁）+ `config/[P0]dev_config.md`（v2.4：web group）+ `config/[P1]connectors.md`（连接器双状态机）
- ui：`overall/05-connectors.md` + `components/connector-page/` + `components/framework/nav-rail.md`（加「连接器」项）

---

## 1. 版本定位

### 1.1 范围（用户已确认）

**IN（v0.0.23 五交付项）**：
1. **web_search 协议层 + Zhipu provider**：`WebSearchProvider` 协议（id/label/isAvailable/search）+ `web_search_provider` exclusive EP（group=`web`）+ `web_search` Tool + **内置 Zhipu provider**（ext impl，POST open.bigmodel.cn/api/paas/v4/web_search，apiKey 走 ext impl configSchema，**不进 dev_config**）。无 provider / provider 不可用 → 精确错误（不静默降级）。
2. **web_fetch 完整（ContentFetcher 契约 + 2 实现 race）**：SSRF 校验 → **抽象 `ContentFetcher` 契约，2 个实现并行 race**：`JinaContentFetcher`（`r.jina.ai/<url>`，自带 JS 渲染，`web.jinaApiKey` 有则传无则不传） ∥ `LocalContentFetcher`（**含 headless 子分支**：本地静态 readability 不足时内部起 Playwright 渲染，**不是顶层第 3 个竞争者**）。race runner **共享 AbortController 构造注入**每个 fetcher；`Promise.any` 取首个「合格」者（ok 且 trim 正文 ≥ ~200 chars），不 merge → `controller.abort()` 取消另一个 → 主流程立即返回；输方 **detached 清理**（关 dispatcher / 关 page+context+kill chrome）。**SSRF 强制在任何抓取之前**；代理失败不静默降级直连；`web.jinaEnabled=false` 不构造 JinaContentFetcher，只跑 Local（默认 on）。
3. **browser 三 mode**：① headless（Playwright 无头 chrome）② managed-profile（持久 `~/.rocky_agent/browser/<name>/user-data`，登录态复用，SingletonLock）③ attach（`chrome-devtools-mcp --autoConnect`，chrome 144+ + remote debugging 开关，HITL 审批）**+ attach 受连接器门禁**（见 ④）。统一 `BrowserDriver`/`BrowserSession` 协议抽象。
4. **配置（dev_config 新增 `web` group）**：`jinaApiKey`（secret，web_fetch jina 阶段用，有则传无则不传，落盘 redact）/ `jinaEnabled`（默认 true）/ `jinaTimeoutMs`（默认 20000）。**provider 凭证不在此**（Zhipu apiKey 走 ext impl configSchema）。
5. **连接器**（nav 新增页，v0.0.23 仅「浏览器」tab）：**双状态机**（switch on/off = 用户意图[持久化] + 实时是否连上；connection disconnected/connecting/connected/error = 运行时态）+ 持久化 switch intent（独立 `connector_config` 域）+ 重启自动 reconnect + ConnectorManager 运行时维护 + **browser attach 模式前置门禁**（`isReady('browser')` 否则拒绝并引导）。toggle on → 唤起 chrome + 引导开 chrome://inspect remote debugging → connecting → 成功 switch on+connected / 失败 switch 保持 off+error。

**共性**（三工具共享，对齐 `web_tools.md` §2）：undici 系统代理 / `wrapExternalContent` 标记 untrusted / 过大截断（~100k chars） / `ctx.signal` 超时 / SSRF 防护（web_fetch 必做、browser 远程 cdp 做） / HITL 审批（attach 模式、web_fetch 敏感域名）。

**OUT（本版本明确排除）**：

| 排除项 | 理由 |
|--------|------|
| browser Computer-use 路线（截图+坐标） | 用户 explicit：「下一阶段」，本期主用 a11y tree + element ref |
| browser 反检测（camofox） | hermes 路线复杂易失效 |
| web_fetch LLM 二次摘要（Gemini Flash 分块摘要） | 独立 enhancement，延后 |
| web_fetch firecrawl（第三方云 reader） | 仅采用 jina reader（race 路线 A）；firecrawl 不引入 |
| web_search 其他 provider（Tavily/Google/Bing...） | 协议+EP 已可插拔，其他后端以插件 ext impl 后续贡献（协议不变） |
| attach 模式 token 鉴权 | 单机本地单用户场景不做，多用户/远程后续加 |
| profile 占用冲突自动抢锁/排队 | 报错 + 提示用户，不抢不排 |
| 连接器自动退避重连 | v0.0.23 默认手动重试（UI 再点 toggle），自动重连列为后续 enhancement |

### 1.2 关键决策记录（用户已确认）

| 决策 | 选择 | 出处 |
|------|------|------|
| 整体范围 | 三工具全做 + 配置 + 连接器（不分期） | 用户决策 1 + reqs 追加 |
| web_search | 协议 + EP + Tool + **内置 Zhipu provider**（开箱可用，实测连通） | 用户决策 2 + reqs 追加 |
| web_fetch | 完整实现（代理 + SSRF + ContentFetcher 契约 + 2 实现 race（jina ∥ local 含 headless 子分支）+ 构造注入 abort + detached 清理） | 用户决策 3 |
| browser | 三 mode 完整 + 统一 BrowserDriver/BrowserSession 抽象 | 用户决策 4 |
| attach 驱动分裂 | **接受**（MCP + Playwright 两栈）+ 协议层抽象统一 | 用户决策 4（AFK 已确认） |
| computer-use / 反检测 | 不做（下一阶段） | 用户决策 5 |
| jina key 归属 | 进 dev_config `web` group（web_fetch 内置工具能力一环） | reqs「配置」 |
| Zhipu apiKey 归属 | 走 ext impl configSchema（provider 插件凭证，不进 dev_config） | 概念先行：协议凭证归插件 config |
| 连接器状态模型 | **双状态机**（switch + connection），非 bool | reqs「配置功能·连接器」（用户明确） |

---

## 2. 功能需求

### 2.1 web_search（协议 + EP + Tool + 内置 Zhipu provider）

对齐 `[P1]web_search_tool.md`（v1.1）。

**是什么**：`WebSearchProvider` 契约 + `web_search_provider` 扩展点（exclusive，group=`web`）+ `web_search` Tool（注册到 `defaultTools()`）+ **内置 Zhipu provider**（implId=`zhipu`，作为 EP 的 ext impl 贡献）。

**期望行为**：
- agent 调 `web_search({query, maxResults?, answer?})`
- Tool 走 `getExclusiveExtension(WebSearchProviderPoint, config)` 取生效 provider
- **无 provider 注册** → 返回 `{ content: [text('web_search 未配置任何 provider')], isError: true }`
- **provider 注册但 `isAvailable()=false`**（如 Zhipu apiKey 未配）→ 返回 `{ content: [text('provider X 不可用（凭证未配置?）')], isError: true }`
- **provider 可用** → `provider.search(query, opts, signal)` → 序列化为 markdown（results 列表 + 可选 answer）→ `wrapExternalContent` 标记 untrusted → 截断 → ToolResultBlock
- `isAvailable()` **禁止 I/O**（只查内存配置），否则每次 assemble 阻塞

**内置 Zhipu provider**（implId=`zhipu`，label「Zhipu 智谱」，开箱可用，国内连通）：
- **API**：`POST https://open.bigmodel.cn/api/paas/v4/web_search`，Header `Authorization: Bearer <apiKey>` + `Content-Type: application/json`，Body `{ search_query, search_engine:"search_std", search_intent:false, count }`
- **凭证**：走 **ext impl configSchema**（`{ apiKey: { type:"string", secret:true } }`，required），**不进 dev_config**（凭证归插件，与协议「凭证不进协议」一致；UI 在 provider 配置处填 apiKey，落盘 redact）
- **响应映射**（`search_result[]` → `WebSearchResult`）：`title←title` / `url←link` / `snippet←content`（截 snippet 长度）/ `publishedDate←publish_date`；Zhipu 无 score、无综合 answer（`search_intent` 是意图分析不映射）
- **共性**：走 undici 代理（共性 §6）；超时/重试同共性

**其他 provider 插拔（roadmap）**：以 plugin ext impl（implId=provider.id，configSchema 自带凭证）形式贡献，`setExclusive(implId)` 选中生效。协议不变、工具零改动。

### 2.2 web_fetch（ContentFetcher 契约 + 2 实现 race，含 JS 渲染）

对齐 `[P1]web_fetch_tool.md`（v1.3）。管线：SSRF 校验 → **抽象 `ContentFetcher` 契约，2 个实现并行 race**（`JinaContentFetcher` ∥ `LocalContentFetcher`，`Promise.any` 取首个「合格」者，不 merge）→ markdown。
- **SSRF（任何抓取之前必做）**：① IP 黑名单（私网/保留段）② DNS pinning（防 rebinding）③ 重定向逐跳校验 + **跨 origin 剥 `Authorization`/`Cookie`**；禁 `file://`/`ftp://`。防内部 URL 泄漏给 jina。
- **代理**：undici `EnvHttpProxyAgent`（读 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`，含 CIDR），jina + 本地抓取同走此代理。代理失败不静默降级直连。
- **`JinaContentFetcher`**（默认 on，见 §2.4）：`GET https://r.jina.ai/<url>`（`web.jinaApiKey` **有则传、无则不传——匿名也能用**，超时 `web.jinaTimeoutMs`，自带 JS 渲染）。`web.jinaEnabled=false` → 不构造此 fetcher。
- **`LocalContentFetcher`**（**含 headless 子分支**）：① 静态子分支：undici fetch → `@mozilla/readability`（+ linkedom）→ markdown（快，不渲染 JS）；② **静态内容不足时（trim ≤ MIN_CONTENT~200）内部起 headless 子分支**：Playwright 渲染（复用 `PlaywrightDriver`）→ readability → htmlToMarkdown。**headless 是 Local 内部子分支，不是顶层第 3 个竞争者**；常规静态页 Local 静态分支即充足，不起 chrome。
- **race + abort**：race runner 创建**共享 AbortController**，**构造注入**每个 fetcher（signal 从出生持有，所有子操作一开始就接好 abort）；`Promise.any` 首个「合格」（ok 且 trim 正文 ≥ MIN_CONTENT）者胜 → `controller.abort()` 取消另一个 → **主流程立即返回**（不等输方清理）。输方：正在飞的子操作抛 AbortError，**finally 块 detached 清理**（关 undici dispatcher / 若 headless 已起关 page+context+kill chrome 进程，best-effort 不抛但必执行）。
- **期望行为**：agent 调 `web_fetch({url, maxChars?})`（默认 100000）→ SSRF 命中返回错误（不抓取不发往 jina）→ 正常路径返回 `truncate(wrapExternalContent(md), maxChars)`；两路皆无合格结果 → `isError:true`；跨域敏感站点可 HITL。

### 2.3 browser（三 mode 完整 + 统一抽象 + attach 门禁）

对齐 `[P1]browser_tool.md`（v1.1）。统一 `BrowserDriver`（按 mode 产出会话）+ `BrowserSession`（listPages/selectPage/navigate/snapshot/click/type/evaluate/screenshot?/close）协议；底层驱动分裂封装在 driver 内。**驱动模型**：a11y tree + element ref。

- **mode ① headless**（PlaywrightDriver，ephemeral profile）：`browser({mode:'headless', action:'navigate', url})` → `action:'snapshot'` → 启动无头 chrome（`--headless=new`）→ connectOverCdp → `{snapshot, refs}`；Linux 无 DISPLAY 强制 headless；session 结束杀 chrome。
- **mode ② managed-profile**（PlaywrightDriver，持久 `~/.rocky_agent/browser/<profileName>/user-data`）：首次建 profile 目录 + 分配 CDP 端口（18800-18899，持久化进 config）+ SingletonLock；同名 profile 复用登录态；**占用冲突**报错「profile X in use」+ 提示（不抢锁不排队）；僵尸锁（持锁进程已死）可清后重试；profile 命名 `/^[a-z0-9][a-z0-9-]*$/` ≤64；chrome 二进制发现：用户 `executablePath` → 系统默认 → 硬编码候选 + Playwright 缓存。
- **mode ③ attach**（ChromeMcpDriver，**前置门禁：连接器必须 connected，见 §2.4**）：spawn `chrome-devtools-mcp@latest --autoConnect`（stdio MCP server，内部发现+连接 chrome，不扫端口）；`BrowserSession` = MCP tool 映射。**用户操作**：① 打开 `chrome://inspect/#remote-debugging` ② Enable remote debugging ③ chrome **144+** ④ 批准 attach prompt。**fallback**：profile 配 `cdpUrl` → 走 `--browserUrl`；远程 cdpUrl loopback 私网 fail-closed（SSRF）；`close` 只清 emulation 不杀用户浏览器。`needsApproval=true`（HITL）。

**统一抽象产品意义**：用户/agent 视角只见 `browser` + `mode`，三 mode 操作集一致；底层 Playwright/MCP 分裂封装在 driver 内。**attach 模式受连接器门禁**（见 §2.4）：未 connected → 返回引导错误，不进行 MCP connect。

### 2.4 配置（web tools group + 连接器）

对齐 `[P0]dev_config.md`（v2.4 §3.5）+ `[P1]connectors.md`（v1.0）。

**2.4.1 dev_config `web` group**（web_fetch 内置管线的工具级配置，非插件自带）：

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `jinaApiKey` | string (secret) | —（无） | jina reader API key。web_fetch jina 阶段用：**有则传**（`Authorization: Bearer`）、**无则不传**（匿名受限）。落盘原值，API 出参 redact（同 observability secretKey 套路） |
| `jinaEnabled` | boolean | true | 是否启用路线 A(jina)；false 跳过 A，只跑本地静态 + headless 兜底（隐私敏感/airgapped） |
| `jinaTimeoutMs` | number | 20000 | jina 调用超时 |

> provider 凭证（Zhipu apiKey）**不在此**——走 ext impl configSchema（provider 是插件，凭证归插件 config，见 §2.1）。

**2.4.2 连接器页（nav 新增「连接器」项 + 浏览器 tab，UI 详见 `ui/overall/05-connectors.md`）**：v0.0.23 仅「浏览器」连接器（browser attach 的用户侧门禁）。**双状态机**（需求原文「不可是一个 true、false 状态」）：

| 状态 | 取值 | 含义 | 持久化 |
|---|---|---|---|
| **switch（开关态）** | `on` / `off` | 用户启用意图 + 实时反映是否连上 | **是**（intent，独立 `connector_config` 域） |
| **connection（连接态）** | `disconnected` / `connecting` / `connected` / `error` | 运行时连接实况 | 否（运行时派生/维护） |

**状态迁移**（对齐 `connectors.md` §3.2）：
- **初始**：switch=off, connection=disconnected（无持久化）
- **点 toggle on**（intent=on）：switch 实时仍 off → connection=**connecting**（唤起 chrome + 引导开 chrome://inspect remote debugging + ChromeMcpDriver autoConnect 尝试 attach）
- **attach 成功**：switch=**on** + connection=**connected**（连接器就绪，browser mode③ 可用）
- **attach 失败**：switch **保持 off** + connection=**error**（errorDetail 记原因：chrome 未开 / 未开 remote debugging / 版本<144 / 拒绝 prompt；UI 可重试）
- **点 toggle off**（intent=off）：switch=off + connection=disconnected（停止 attach，**不杀用户 chrome**）
- **运行中 chrome 关闭/连接断**（switch=on）：switch on→off + connection=error（intent 仍 on，可手动重试；自动退避重连列为后续）
- **app 重启**（持久化 intent=on）：启动 switch=**off** + connection=**connecting**（ConnectorManager 自动 reconnect，不等用户再点）

**关键语义**：switch 的 `on` 实时表示「已连上」，但其持久化值是「用户意图」。重启时 intent=on 不等于「已连上」→ 从 connecting 重新建立。

**ConnectorManager**（运行时服务）：`getState/isReady/enable/disable/bootstrap`——`enable('browser')` 内部调 ChromeMcpDriver.connect({mode:'attach'})；app 启动 bootstrap 读 intent，intent=on 自动 reconnect；attach session 由 Manager 统一持有、跨 tool 调用复用。

**attach 门禁**（browser tool mode③ run 内）：
```
if (!connectorManager.isReady('browser'))
  return { content:[text('browser attach 未连接：请在「连接器 → 浏览器」中开启连接')], isError:true };
```
mode①②（headless/managed-profile）**不查连接器**——它们自启 chrome，与连接器无关。

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

| ID | 用户操作链路 | 预期结果 | 类型 |
|----|-------------|---------|------|
| **路径 A** | Zhipu provider 注册 + apiKey 配好 → agent 调 `web_search({query})` | `isError:false`，返回 Zhipu 结果（title/url/snippet，可能含 publishedDate），untrusted 包装；调真 `open.bigmodel.cn` API | API（真服务） |
| **路径 A0** | agent 调 `web_search` → 无任何 provider 注册 | `isError:true`「web_search 未配置任何 provider」（不 crash、不静默） | API |
| **路径 A2** | Zhipu provider 注册但 apiKey 未配 → `isAvailable()=false` → agent 调 `web_search` | `isError:true`「provider Zhipu 不可用（凭证未配置?）」（验证 isAvailable 无 I/O、不静默换 provider） | API |
| **路径 B** | agent 调 `web_fetch({url:<公网可读页>})` → SSRF 通过 → 2 ContentFetcher race（jina ∥ local）→ 首个合格者胜（静态页 local 静态分支胜 / JS 页 jina 胜；`web.jinaApiKey` 配了则 jina 带 Bearer） | `isError:false`，正文 markdown + title + 最终 URL，含 untrusted 包装；走系统代理（设 HTTP_PROXY） | API（真服务） |
| **路径 B0** | `web.jinaApiKey` 未配 → agent `web_fetch`（JinaContentFetcher 匿名仍可调） | jina 不传 key（匿名），仍作为 race 一路参与；返回正文（受限但可用） | API |
| **路径 B2** | jina 不合格 + local 静态分支不充足（重度 JS）→ Local 内部起 headless 子分支渲染（复用 PlaywrightDriver）→ readability | 返回正文 markdown；Local 静态不足时 headless 子分支仍拿 JS 渲染内容 | API |
| **路径 C** | agent 调 `web_fetch({url:<内网 IP 或 file://>})` | `isError:true`，SSRF 拒绝（不抓取、不发往 jina）；重定向到内网也逐跳拒 | API |
| **路径 C2** | agent 调 `web_fetch`，目标 3xx 跨 origin 重定向 | 剥 `Authorization`/`Cookie` 后再请求新 origin；首 URL 公网但跳转内网仍拒 | API |
| **路径 D** | agent 调 `browser({mode:'headless', action:'navigate', url})` → `action:'snapshot'` | 启动无头 chrome → `{snapshot, refs}`（a11y tree）；可 `click(ref)`/`type(ref,text)` | API |
| **路径 E** | 首次 `browser({mode:'managed-profile', profileName:'X', action:'navigate', <login url>})` 登录 → close → 再次同 profile navigate 同站 | 第二次登录态保留（cookie/会话仍在，不需重登） | API |
| **路径 E2** | 两进程同时 `browser({mode:'managed-profile', profileName:'X'})` | 后者报错「profile X in use」+ 提示，不抢锁；前者 close 后后者可重试 | API |
| **路径 F** | 连接器 connected（路径 H 成功后）+ 用户 chrome 开 remote debugging（144+） → agent `browser({mode:'attach', action:'listPages'})` → HITL 审批 → `navigate`/`snapshot` | 列出用户真实 tab；操作生效；session 结束**不杀用户浏览器** | API（需 HITL，真实 chrome） |
| **路径 G** | agent `browser({mode:'attach', cdpUrl:'<内网/远程私网>'})` | SSRF fail-closed 拒绝（远程 cdpUrl 私网 fail-closed） | API |
| **路径 H** | 用户进连接器页 → 点浏览器 toggle on → 唤起 chrome + 引导开 chrome://inspect remote debugging → connection=connecting → attach 成功 | switch=on + connection=connected；browser mode③ 可用；持久化 switch intent=on | E2E + API |
| **路径 I** | 用户点 toggle on 但 chrome 未开 remote debugging → attach 失败 | switch **保持 off** + connection=**error** + 显原因；UI 可重试；未持久化 intent=on（或持久化但实时 off） | E2E + API |
| **路径 J** | 持久化 switch intent=on → 重启 app → ConnectorManager bootstrap | 启动 switch=off + connection=connecting 自动 reconnect；成功则 on+connected，失败 off+error | API |
| **路径 K** | 连接器未 connected（disconnected/error/connecting） → agent 调 `browser({mode:'attach'})` | `isError:true`「browser attach 未连接：请在「连接器 → 浏览器」中开启连接」，不进行 MCP connect | API |

**路径数**：16 条（A/A0/A2/B/B0/B2/C/C2/D/E/E2/F/G + 新增 H/I/J/K），覆盖 web_search Zhipu 主路径 + 降级、web_fetch ContentFetcher race（含 key 有无差异）/ Local 内 headless 子分支 / SSRF / 重定向剥凭证、browser 三 mode + 占用冲突、连接器 toggle 成功/失败/重启重连、attach 门禁。每条至少 1 个 API case；连接器 toggle/HITL 可补 E2E（Playwright 驱动 web UI）。

---

## 4. 非目标（NON-GOALS）

- web_search **其他 provider** 实现（Tavily/Google/Bing/Serper...）—— Zhipu 已内置；其他以插件 ext impl 后续贡献（协议不变）
- browser computer-use（截图+坐标）—— 下一阶段（用户 explicit）
- browser 反检测（camofox 路线）
- web_fetch LLM 二次摘要（Gemini Flash / Haiku 分块提取）
- web_fetch firecrawl（第三方云 reader）——仅采用 jina reader（race 路线 A），firecrawl 不引入
- browser 多 provider 并发融合搜索（exclusive ≤1）
- attach 模式 token 鉴权（单机本地不做）
- profile 占用冲突自动抢锁/排队
- 连接器断线自动退避重连（v0.0.23 默认手动重试，UI 再点 toggle）
- 连接器多 tab（v0.0.23 仅「浏览器」tab，UI 预埋多 tab）
- chrome-devtools-mcp 版本钉死（用 `@latest` 跟官方）
- web_fetch 内置浏览器渲染 SPA（与 browser 工具职责正交，仅返回提示）

---

## 5. 设计决策（对齐 tech spec）

### 5.1 web_search 为何「协议先行 + exclusive EP」而非绑死后端
搜索后端是可变商业依赖（凭证/计费/配额各异），焊死绑死；exclusive ≤1（非 list 并发融合）—— 一次搜索一个 provider 答，结果可解释 + 凭证/计费隔离 + 与单选 UI 心智一致。协议不变、工具零改动即可换后端。反例：claude-code 绑死 Anthropic 原生 server tool，不可换。

### 5.2 web_search 为何选 Zhipu 作为首个内置 provider（v0.0.23 新增）
**开箱可用**（国内可直连，无需翻墙）+ **实测连通**（2026-06-25 调通 `open.bigmodel.cn/api/paas/v4/web_search`，reqs `web_search_zhipu.md`）+ **响应结构清晰**（`search_result[]` 映射 `WebSearchResult` 字段对齐好）。协议仍 exclusive 可换——后续 Tavily/Google/Bing 以 ext impl 贡献，工具层零改动。v0.0.23 不再让 web_search 处于「只有协议没 provider」的空转态。

### 5.3 配置归属：jina key 进 dev_config，Zhipu apiKey 进 ext impl config
**结论**：`jinaApiKey` → `dev_config` `web` group；Zhipu `apiKey` → Zhipu provider 的 ext impl configSchema。
**理由**：jina 是 web_fetch **内置工具能力一环**（非插件，所有用户共享的管线），配置归宿主 dev_config；Zhipu 是 **provider 插件**（与协议解耦、可换、凭证独立计费），凭证归 ext impl config（与协议「凭证不进协议，归 plugin config」一致）。混了则 dev_config 被插件凭证污染、插件凭证又无法随插件卸载清理。

### 5.4 连接器为何双状态（switch + connection）而非 bool
**结论**：switch（开关态，持久化 intent + 实时是否连上）+ connection（运行时连接态）两个独立状态。
**理由**：需求明确「不可是一个 true、false 状态」。单一 bool 无法表达「用户意图=开但运行时未连上」（如重启后 chrome 还没开、运行中 chrome 被关）——这两种情况 bool 都得是 false，但 UI/重连逻辑需区分。分离后：switch 持久化意图驱动重启自动重连，connection 实况驱动 UI 呈现 + attach 门禁判定（`connection=connected` 才放行 mode③）。

### 5.5 web_fetch 为何 ContentFetcher 契约 + 2 实现 race + 构造注入 abort（用户决策 v1.3）
抽象 `ContentFetcher` 契约（接口），2 实现——`JinaContentFetcher`（r.jina.ai，自带 JS 渲染）与 `LocalContentFetcher`（**含 headless 子分支**：静态 readability 不足时内部起 Playwright）——**并行**跑、`Promise.any` race 取首个「合格」者。**契约统一** = 新增实现（firecrawl/proxy pool）只需实现接口并注册，runner 零改动；**headless 归 Local 内部**（撤回 v1.2「两路皆空串行 headless 兜底」）= 「Local 自己决定何时起 chrome」语义内聚，消除 v1.2 headless 与 Local 概念割裂。**AbortController 构造注入**（撤回 v1.2 ctrlA/ctrlB 互指）= fetcher 从出生持有 abort，所有子操作（jina fetch / 本地静态 / local 起 chromium）一开始就接好，无后传时序窗口；首合格胜出 → `controller.abort()` 取消另一个 → 主流程立即返回，输方 **detached 清理**（关 dispatcher / 关 page+context+kill chrome，best-effort 不抛但必执行）。**SSRF 强制在任何抓取之前**防内部 URL 泄漏；jina 可配置开关（`web.jinaEnabled=false` 不构造 JinaContentFetcher）。Bun 兼容防回归：BUG-003（`typeof close==='function'` 守卫）+ BUG-005（`AbortSignal.timeout` 替代 dispatcher 超时）。反例：(a) v1.2 ctrlA/ctrlB 互指——耦合、扩展第三者接线爆炸；(b) signal 后传——fetcher 构造到 fetch 调用之间子操作漏接 abort；(c) 串行 jina→兜底——jina 失败要等满 `jinaTimeoutMs` 才降级，慢。

### 5.6 web_fetch 为何用 undici 而非 Bun.fetch
Bun 原生 `Bun.fetch` **不读** `HTTP_PROXY`/`HTTPS_PROXY`；用户「享受系统代理」需求驱动选 undici `EnvHttpProxyAgent`。**代理失败不静默降级直连**——否则用户靠代理挡内网，降级即绕过 SSRF。

### 5.7 browser 为何接受 attach 驱动分裂 + 抽象统一协议
attach 复刻 openclaw `chrome-devtools-mcp --autoConnect`（chrome 144+ inspect 开关，**无需用户手动指定端口**，满足用户需求 3），其底层是 MCP tool 协议；mode ①② 用 Playwright/CDP。两栈分裂不可避免，但**抽象 `BrowserDriver`/`BrowserSession` 统一协议**——调用方只见 `browser` 工具 + mode，操作集一致；底层分裂封装在 driver 内。`snapshot` 统一返回 `{snapshot, refs}`（a11y + ref）是「驱动模型统一」的落点。

### 5.8 browser 为何主用 a11y tree + element ref（非截图坐标）
ref 定位精度高、token 省、不需 vision 二次定位；截图仅作辅助。computer-use 路线复杂、需专门模型，本期不做。

### 5.9 共性：wrapExternalContent 标记 untrusted
web 抓回的正文 / search snippet / answer 一律 untrusted 包装，防 prompt injection（网页内嵌「忽略以上指令」类攻击）。

---

## 6. 验收口径

| 维度 | 口径 |
|------|------|
| web_search Zhipu | 路径 A PASS（真服务）：配 apiKey 后调真 `open.bigmodel.cn` 返回结果（title/url/snippet）+ untrusted 包装 |
| web_search 降级 | 路径 A0/A2 PASS：无 provider / provider 不可用均返回精确错误，不 crash、不静默 |
| web_fetch | 路径 B/B0/B2/C/C2 PASS（真服务）：ContentFetcher race（key 有/无差异，静态页 local 静态分支胜 / JS 页 jina 胜）+ Local 静态不足 headless 子分支渲染（JS 页）+ SSRF 拒绝 + 重定向剥凭证；代理感知（设 `HTTP_PROXY`）；abort 构造注入 + detached 清理（无 dispatcher/chromium 泄漏） |
| browser headless | 路径 D PASS：navigate + snapshot 返回 a11y + refs，click/type 生效 |
| browser profile | 路径 E PASS：登录态跨 session 保留；路径 E2 PASS：占用冲突报错 |
| browser attach | 路径 F PASS（真实 chrome 144+ + HITL + 连接器 connected）：列 tab / 操作生效 / 不杀浏览器；路径 G PASS：远程私网 cdpUrl SSRF 拒绝 |
| 连接器 toggle 成功 | 路径 H PASS：toggle on → connecting → connected（switch on）+ intent 持久化 |
| 连接器 toggle 失败 | 路径 I PASS：attach 失败 → switch 保持 off + connection=error + 显原因 |
| 连接器重启重连 | 路径 J PASS：持久化 intent=on → 重启自动 off+connecting reconnect |
| attach 门禁 | 路径 K PASS：连接器未 connected → browser mode③ 返回引导错误，不进行 MCP connect |
| 配置 secret | `web.jinaApiKey` 落盘原值，API `GET dev_config/web` 出参 redact（占位）；PUT 接受明文 |
| 不可信内容 | web_fetch 正文 / search snippet 含 untrusted 包装标记 |
| 代理不降级 | web_fetch 代理失败 → 错误（非静默直连） |
| 视觉保真 | 本版本无设计稿，此项跳过 |

---

## 7. PRD ↔ tech/ui spec 对齐核对（MANDATORY — 概念先行）

| 核对点 | PRD | tech/ui spec | 一致 |
|--------|-----|-----------|------|
| 工具名 | `web_search` / `web_fetch` / `browser` | `web_tools.md` §1 三工具命名 | ✅ |
| web_search 协议 | `WebSearchProvider`（id/label/isAvailable/search）+ `WebSearchResult`/`SearchResultItem` | `web_search_tool.md` §2 | ✅ |
| web_search EP | `web_search_provider`，cardinality=`exclusive`，group=`web` | `web_search_tool.md` §3 | ✅ |
| web_search 无 provider 错误 | `isError:true`「未配置任何 provider」 | `web_search_tool.md` §4 Tool run 分支 | ✅ |
| **web_search Zhipu provider** | implId=`zhipu`，POST open.bigmodel.cn/api/paas/v4/web_search，Bearer apiKey，search_engine=search_std；映射 title←title/url←link/snippet←content/publishedDate←publish_date | `web_search_tool.md` §7（v1.1） | ✅ |
| **Zhipu apiKey 凭证归属** | ext impl configSchema（不进 dev_config），secret 落盘 redact | `web_search_tool.md` §7（v1.1）+ `ext_impl_and_manifest_interface.md` §3.5 | ✅ |
| web_fetch 管线 | ContentFetcher 契约 + 2 实现 race（jina ∥ local 含 headless 子分支）+ SSRF（任何抓取前）+ undici 代理 | `web_fetch_tool.md` §1/§3/§6.1（v1.3） | ✅ |
| web_fetch SSRF 三件套 | IP 黑名单 + DNS pinning + 重定向逐跳 + 跨 origin 剥凭证；**任何抓取之前** | `web_fetch_tool.md` §4 | ✅ |
| web_fetch ContentFetcher race | `JinaContentFetcher` ∥ `LocalContentFetcher`(含 headless 子分支) race 取首个合格者 + 共享 AbortController 构造注入 + 首合格 abort 其他 + detached 清理 + `web.jinaEnabled`（默认 on） | `web_fetch_tool.md` §3/§6.1/§6.2/§6.3（v1.3） | ✅ |
| web_fetch JS 渲染 | jina 自带（一路）+ Local 内静态不足起 headless 子分支（复用 PlaywrightDriver） | `web_fetch_tool.md` §3.3/§6.5（v1.3） | ✅ |
| browser 三 mode 名 | `headless` / `managed-profile` / `attach` | `browser_tool.md` §1 表格 | ✅ |
| browser 统一抽象 | `BrowserDriver` / `BrowserSession` 协议 | `browser_tool.md` §2 | ✅ |
| browser driver 实现 | PlaywrightDriver（①②）/ ChromeMcpDriver（③） | `browser_tool.md` §3/§4 | ✅ |
| browser 驱动模型 | a11y tree + element ref（非截图坐标） | `browser_tool.md` §6 | ✅ |
| attach 用户操作 | chrome 144+ + remote debugging 开关 + 批准 prompt | `browser_tool.md` §4 | ✅ |
| attach HITL | `needsApproval(input) = (mode==='attach')` | `browser_tool.md` §7 | ✅ |
| profile 持久路径 | `~/.rocky_agent/browser/<name>/user-data` | `browser_tool.md` §3 | ✅ |
| profile 占用冲突 | 报错 + 提示，不抢锁 | `browser_tool.md` §3 / §8 | ✅ |
| **dev_config `web` group** | `jinaApiKey`(secret)/`jinaEnabled`/`jinaTimeoutMs`；jinaApiKey 有则传无则不传 | `dev_config.md` §3.5（v2.4）+ `web_fetch_tool.md` §5.1 | ✅ |
| **连接器双状态机** | switch(on/off, 持久化 intent) + connection(disconnected/connecting/connected/error, 运行时) | `connectors.md` §2/§3（v1.0） | ✅ |
| **连接器状态迁移** | toggle on→connecting→成功 on+connected / 失败 off+error；重启 intent=on→off+connecting reconnect | `connectors.md` §3.2/§3.3 | ✅ |
| **连接器持久化** | `connector_config` 域，只持久化 `enabled`（intent），不持久化 connection 实时态 | `connectors.md` §4 | ✅ |
| **ConnectorManager** | getState/isReady/enable/disable/bootstrap；enable 内部调 ChromeMcpDriver.connect | `connectors.md` §5 | ✅ |
| **attach 门禁** | mode③ run 内 `if (!connectorManager.isReady('browser')) return 引导错误`；mode①② 不查 | `connectors.md` §6 + `browser_tool.md` | ✅ |
| **nav「连接器」项** | nav-rail 新增第 6 项，view id `connector`，testid `nav-connector`，路由到 `page-connector` | `nav-rail.md`（[v0.0.23]）+ `ui/overall/05-connectors.md` §1 | ✅ |
| **连接器页结构** | page-connector + connector-tabs（仅「浏览器」tab）+ browser-connector-card（toggle+status+error+guide） | `ui/overall/05-connectors.md` §2 + `connector-page/` 组件 spec | ✅ |
| 共性约定 | 代理/wrapExternalContent/截断/超时/审批 | `web_tools.md` §2 | ✅ |
| 不做项 | 其他 provider / computer-use / 反检测 / LLM 摘要 / firecrawl / 连接器自动退避重连 / attach token | 各子文档 §决策 + §4 NON-GOALS | ✅ |

**结论**：PRD 引用的工具名 / 协议（WebSearchProvider）/ EP（web_search_provider exclusive, group=web）/ **Zhipu provider（implId/API/凭证归属/响应映射）** / **dev_config web group（jinaApiKey secret/jinaEnabled/jinaTimeoutMs）** / **web_fetch ContentFetcher 契约 + 2 实现 race + 构造注入 abort + detached 清理 + headless 归 Local 内部子分支** / **连接器双状态机（switch+connection）/ 持久化 intent / ConnectorManager / attach 门禁** / **nav「连接器」项 + 连接器页结构** / mode 名（headless/managed-profile/attach）/ 抽象（BrowserDriver/BrowserSession）/ 驱动模型（a11y+ref） 与 tech/ui spec **完全一致**，无概念发明、无矛盾。

---

version: v0.0.23（web tools 三件套 + 配置 web group + 连接器：web_search 协议+EP+Zhipu provider、web_fetch 完整（ContentFetcher 契约 + 2 实现 race：jina ∥ local 含 headless 子分支，首个合格者胜，构造注入 abort + detached 清理）、browser 三 mode + 统一抽象 + attach 门禁、dev_config web group、连接器页 + 双状态机 + 持久化 + 重启重连）
