# Web Tools 子系统 — 产品需求文档 [v0.0.23]

> version: 1.4 · 引入版本 v0.0.23 · 最后更新：2026-07-12（v1.4 `[v0.0.123]` 由 doc-modifier 同步：**web_search 内置 Zhipu provider 1→2** —— §7.1 能力表 / §7.1.3 核心价值 / §7.2.1 内置 provider 段 / §7.5.2 设计决策：从单 implId `zhipu` 拆为 `zhipu_coding_plan`（MCP `web_search_prime`，订阅额度）+ `zhipu_api`（REST `/api/paas/v4/web_search`，按量计费）两独立 ext impl，各 key 隔离；旧 `zhipu` 配置一次性迁移到 `zhipu_coding_plan`。`WebSearchProvider` 协议 / list EP / `resolveProvider` 路由零改动。详 `specs/prd/version_logs/v0.0.123/change_log.md`。v1.3 `[v0.0.46.connector_opt]` 由 doc-modifier 同步：§7.2.3 attach action 增加 `disconnect`；§7.2.4.2 状态迁移表按 lazy connect 时机重构（toggle on 不再进 connecting、bootstrap 不 connect、LLM 首次调 attach 触发 connect、LLM disconnect action、其他 session 占用冲突返 ToolError）；§7.3 路径表 H/I/J/K 语义调整 + 新增 P4/P8（占用冲突 / lazy connect 失败）；§7.5.4 双状态说明升级为「switch/connection 完全解耦」。v1.2 `[v0.0.34]`：§7.2.3 mode③ attach 去 autoConnect 改 browserUrl loopback 默认（曾撤回，见 §7.2.3）+ list_pages 判据。v1.1 `[v0.0.23.1]`：mode①② node worker 绕 Bun bug。v1.0：骨架补全）
> 本文承载 Web Tools 子系统（含配置/连接器入口）的全量产品定义。
> 概念权威源：`specs/tech/agent/tools/[P1]web_tools.md`（总览 + 共性约定）+ `[P1]web_search_tool.md`（v1.1：协议+EP+Zhipu）+ `[P1]web_fetch_tool.md`（v1.2：并行 race）+ `[P1]browser_tool.md`（**v1.4** `[v0.0.46]`：三 mode + attach 门禁分层 + lazy connect + disconnect action）+ `specs/tech/config/[P0]app_config.md`（web group：jinaApiKey/jinaEnabled/jinaTimeoutMs，`[v0.0.89]` 迁自 dev_config）+ `specs/tech/config/[P1]connectors.md`（**v1.2** `[v0.0.46]`：双状态机 switch/connection 完全解耦 + connectForToolRun/disconnect 接口 + 全局单例 owner）+ `specs/ui/overall/05-connectors.md`（连接器页）。
> v0.0.23 增量变更见 `specs/prd/version_logs/v0.0.23/change_log.md`；v0.0.46 增量见 `specs/prd/version_logs/v0.0.46.connector_opt/change_log.md`。

## 目录

| 章节 | 说明 |
|------|------|
| §7.1 产品概述 | web tools 定位（让 agent 上网）、三工具 + 配置 + 连接器分工 |
| §7.2 功能需求 | web_search / web_fetch / browser / 配置 / 连接器 各自能力 |
| §7.3 关键用户路径（MANDATORY） | 测试最低覆盖（见 change_log §3） |
| §7.4 范围边界 | IN / OUT（见 change_log §1.1 / §4） |
| §7.5 设计决策 | 协议先行 / Zhipu 内置 / jina 优先 / 三 mode 统一抽象 / 双状态机（见 change_log §5） |
| §7.6 验收口径 | 见 change_log §6 |

---

## 7.1 产品概述 [v0.0.23]

### 7.1.1 定位

web tools 让 agent 能访问网络：**web_search**（检索）/ **web_fetch**（抓单 URL → 干净正文）/ **browser**（chrome 自动化三模式）+ **配置**（web tools 工具级参数）+ **连接器**（browser attach 的用户侧门禁）。三工具由 `tool_execution_engine` 串行调度，`Tool[]` 由 `SessionConfig.tools` 持有。

一句话：**agent 调 web 工具上网查、抓、操作浏览器；用户在配置页管 jina key、在连接器页管 browser attach。**

> **相关工具（同「多 vender」范式，非 web 工具）**：`[v0.0.141]` **see_image**（视觉理解——给一段文字 + 本地图片路径 → 文字理解）**完整复用 web_search 的多 vender 架构**（provider 协议 + `list` EP 单点路由 + `app_config` 凭证路由 + 未配置精确报错 + 4 角色 bound 非 studio-squad），仅把「search→结果列表」换成「understand→文字理解」，双 vender=`minimax_m3`（多图有序）/`zhipu_image`（单图）。**它读本地图片、非 web 出站，故独立于本文；产品增量权威 = `specs/prd/version_logs/v0.0.141.see_img/change_log.md`；契约 = `specs/tech/agent/tools/[P1]see_image_tool.md` + `specs/api/overall/08a-see-image-tool.md`。硬约束：base64 只在 vender impl 内部，绝不进 tool 入参/出参（上下文零污染）。**

### 7.1.2 交付项分工

| 交付项 | 一句话 | v0.0.23 范围 |
|------|--------|-------------|
| `web_search` | 按 query 检索 → 结构化结果（+可选 answer） | 协议 + **`list` EP（v0.0.72 改）** + Tool + **内置 Zhipu provider**（ext impl；**[v0.0.123] 2 个独立 impl** `zhipu_coding_plan` MCP 订阅额度 / `zhipu_api` REST 按量计费；v0.0.72 凭证迁 `app_config.web_search` group，删 ext impl configSchema） |
| `web_fetch` | 抓单 URL → 系统代理 → SSRF 校验 → **2 个 ContentFetcher（jina / local）并行 race**（首个内容充足者胜；local 含 headless 子分支：静态不足时 local 自起 chrome 渲染）→ markdown | 完整实现（ContentFetcher 契约 + 2 实现 jina/local 含 headless 子分支并行 race + AbortController 构造注入 + detached 清理 + SSRF） |
| `browser` | chrome 自动化（headless / 持久 profile / attach） | 三 mode 完整 + 统一 BrowserDriver/BrowserSession 抽象 + attach 门禁 |
| **配置（web group）** | web_fetch 内置管线工具级配置 | `app_config` `web` group（`[v0.0.89]` 迁自 dev_config）：`jinaApiKey`(secret)/`jinaEnabled`/`jinaTimeoutMs`；`[v0.0.121]` jinaApiKey 有 UI 入口（应用设置 → 工具 tab → 网络抓取 section） |
| **连接器** | browser attach 用户侧门禁 | nav 新增「连接器」页（仅「浏览器」tab）+ 双状态机（switch+connection）+ 持久化 intent + 重启重连 |

### 7.1.3 核心价值

1. **可插拔 + 开箱可用**（web_search）：协议 + EP（v0.0.23 exclusive → v0.0.72 `list`，多 provider 共存、按 `app_config.web_search.type` 单点路由），v0.0.23 内置 Zhipu（国内连通、实测调通），其他 provider 后续以插件贡献。
2. **可控**（web_fetch）：2 个 ContentFetcher（jina / local）并行 race（首个内容充足者胜，AbortController 构造注入 + 输方 detached 清理；local 含 headless 子分支）；系统代理感知（undici EnvHttpProxyAgent）；SSRF 防护；untrusted 包装。
3. **统一 + 真实复用**（browser）：三 mode 一套操作集，底层驱动分裂封装在 driver 内；profile 登录态复用；attach 用户真实 chrome（受连接器门禁）。
4. **配置分离**：内置工具能力（jina key）进 `app_config` web group（`[v0.0.89]` 迁自 dev_config）；插件 provider 凭证（Zhipu apiKey）进 `app_config.web_search` group（不混）。
5. **连接器双状态**：持久化用户意图 + 运行时连接实况分离，支持重启自动重连；attach 模式必须有用户主动连接才可用。

---

## 7.2 功能需求 [v0.0.23] [v0.0.72 modified：§7.2.1 web_search EP exclusive→list + 协议加 cfg + 凭证迁 app_config]

### 7.2.1 web_search（协议 + EP + Tool + 内置 Zhipu provider）

**契约**：`WebSearchProvider` 协议（id/label/isAvailable(cfg)/search(query,opts,cfg,signal?)）+ `web_search_provider` **`list` EP**（v0.0.72 由 `exclusive` 改 `list`，group=`web`，多 impl 共存）+ `web_search` Tool（注册到 `defaultTools()`）+ **内置 Zhipu provider**（**[v0.0.123]** 2 个独立 ext impl `zhipu_coding_plan` / `zhipu_api`，作为 EP 的 ext impl 贡献）。**v0.0.72 修订**：协议 `search`/`isAvailable` 加 `cfg` 入参（不透明 map，由 tool 从 `app_config.web_search` 构造传入）；凭证从 ext impl `configSchema` 迁出到 `app_config.web_search` group（删 `plugin.json` 的 `configSchema.apiKey`）。

**行为**：
- agent 调 `web_search({query, maxResults?, answer?})` → tool 读 `app_config.web_search.default` 取 `{type, credentials}` → 按 `type` 在 list EP 中精确匹配 impl（不取首个、不静默回退）→ `cfg = credentials[type] ?? {}` 传 `impl.isAvailable`/`impl.search`。
- **`app_config.web_search` 缺失 / `data.type` 缺失** → `{content:[text('web_search 未配置 provider type')], isError:true}`。
- **type 对应 impl 未激活** → `isError:true`「web_search type `{type}` 对应 impl 未激活」。
- **provider 注册但 `isAvailable(cfg)=false`**（Zhipu apiKey 未配）→ `{content:[text('provider X 不可用（凭证未配置?）')], isError:true}`。
- **provider 可用** → `provider.search(query, opts, cfg, signal)` → markdown（results 列表 + 可选 answer）→ `wrapExternalContent` 标 untrusted → 截断（~100k）→ ToolResultBlock。
- `isAvailable(cfg)` **禁止 I/O**（只查内存 `cfg.apiKey` 字段），否则每次 assemble 阻塞。

**内置 Zhipu provider（[v0.0.123] 2 个独立 impl，各 key 隔离、链路隔离，用户按计费方式选一条）**：

| implId | label | API 端点 / 协议 | 计费 | impl 文件 |
|---|---|---|---|---|
| `zhipu_coding_plan` | 智谱 · Coding Plan（订阅额度） | `POST /api/mcp/web_search_prime/mcp`（MCP Streamable HTTP + JSON-RPC 2.0，两步 initialize→tools/call） | Coding Plan 订阅额度 | `zhipu-coding-plan-provider.ts` |
| `zhipu_api` | 智谱 · API（按量计费） | `POST /api/paas/v4/web_search`（REST，Body `{search_query, search_engine:"search_std", search_intent:false, count}`） | 按 API 调用量计费 | `zhipu-api-provider.ts` |

- **凭证归属**（两 impl 共性，v0.0.72 修订）：唯一源 = `app_config.web_search.credentials.<implId>.apiKey`（app config `web_search` group，**不再走 ext impl configSchema / env 回退**）；impl 从运行时入参 `cfg.apiKey` 读，空 → `isAvailable=false` / `search` 抛 `Error('zhipu provider 未配置 apiKey')`，tool 层 catch 转 ToolError（label 各异 → 错误提示可区分两 impl）。
- **一次性迁移**（[v0.0.123]）：老用户旧 `type=zhipu` 配置启动时迁到 `zhipu_coding_plan`（现有 key 实为 coding plan key，marker=type 幂等非破坏，技术权威 `app_config.md §3.6`）。
- **响应映射**（两 impl 一致）：`title←title` / `url←link` / `snippet←content`（截断）/ `publishedDate←publish_date`；无 score、无综合 answer。

**其他 provider 插拔（roadmap）**：以 plugin ext impl（implId=provider.id）贡献，多 provider 共存（list）；用户在「应用设置 → 网络搜索」改 `app_config.web_search.type` 切换。协议不变、工具零改动。

### 7.2.2 web_fetch（ContentFetcher 契约 + 2 实现 jina/local 含 headless 子分支并行 race，含 JS 渲染）

管线：SSRF 校验 → **2 个 ContentFetcher（jina / local）并行 race**（`Promise.any` 取首个「内容充足」者，不 merge；AbortController 构造注入，胜出 abort 其他，输方 detached 清理）→ markdown。

- **SSRF（任何抓取之前必做）**：① IP 黑名单（私网/保留段）② DNS pinning（防 rebinding，createPinnedDispatcher）③ 重定向逐跳校验 + **跨 origin 剥 `Authorization`/`Cookie`**；禁 `file://`/`ftp://`。防内部 URL 泄漏给 jina。
- **代理**：undici `EnvHttpProxyAgent`（读 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`，含 CIDR）——**Bun 原生 fetch 不读代理**，故必须 undici。代理失败不静默降级直连。
- **ContentFetcher 契约**：统一接口（输入 URL + AbortSignal，输出 markdown），2 个实现并行 race；AbortController 构造注入（胜出 abort 其他），输方 detached 清理避免句柄泄漏。
- **jina fetcher**（默认 on）：`GET https://r.jina.ai/<url>`（`web.jinaApiKey` **有则传、无则不传——匿名也能用**，超时 `web.jinaTimeoutMs`，自带 JS 渲染）。`web.jinaEnabled=false` → 跳过此 fetcher。
- **local fetcher**：undici fetch → `@mozilla/readability`（+ linkedom）→ markdown（静态充足时快且不渲染 JS）；**headless 是 local 内部子分支**——静态 readability 不足时 local 自起 headless chrome 渲染（复用 `PlaywrightDriver`）→ readability → markdown。**常规 fetch 在 local 静态充足时不起 chrome**。
- **race**：`Promise.any` 取首个 trim 后正文 > MIN_CONTENT(~200) 者胜（静态页 local 静态充足→胜；JS 页 local 静态不足→jina 胜，或 local 切到 headless 子分支与 jina 继续竞速）；胜出后 abort 其他、输方 detached 清理。

**行为**：agent 调 `web_fetch({url, maxChars?})`（默认 100000）→ SSRF 命中返 `isError:true`（不抓取不发往 jina）→ 正常路径返回 `truncate(wrapExternalContent(md), maxChars)`。

### 7.2.3 browser（三 mode 完整 + 统一抽象 + attach 门禁）

统一 `BrowserDriver`（按 mode 产出会话或一次性结果）+ `BrowserSession`（listPages/selectPage/navigate/snapshot/click/type/evaluate/screenshot?/close）协议；底层驱动分裂封装在 driver 内。**驱动模型**：a11y tree + element ref（非截图坐标）。

- **mode ① headless**（NodeWorkerDriver，ephemeral profile）：`browser({mode:'headless', action:'navigate', url})` → `action:'snapshot'` → tool run 调 `driver.executeOnce`（**[v0.0.23.1] 改走 node worker 子进程**，绕开 Bun playwright connectOverCDP bug）→ worker 内启动无头 chrome（`--headless=new`）→ connectOverCDP → dispatch action → kill chrome → stdout 返 `{snapshot, refs}`；Linux 无 DISPLAY 强制 headless；run 结束 worker 退出自动清 chrome。
- **mode ② managed-profile**（NodeWorkerDriver，持久 `~/.rocky_agent/browser/<profileName>/user-data`）：同 ① 走 node worker；首次建 profile 目录 + 分配 CDP 端口（18800-18899，持久化进 config）+ SingletonLock；同名 profile 复用登录态；**占用冲突**报错「profile X in use」+ 提示（不抢锁不排队）；僵尸锁可清后重试；profile 命名 `/^[a-z0-9][a-z0-9-]*$/` ≤64；chrome 二进制发现：用户 `executablePath` → 系统默认 → 硬编码候选 + Playwright 缓存。
- **mode ③ attach**（ChromeMcpDriver，**前置门禁分层，见 §7.2.4**）：`[v0.0.46]` 起 **connect 时机 = tool.run 首次 lazy 触发**（不再由 bootstrap/toggle 触发）——LLM 首次调 `browser({mode:'attach', action:X})` 时 tool 层调用 `connectorManager.connectForToolRun` 触发 spawn `chrome-devtools-mcp@latest --autoConnect`（stdio MCP server；`[v0.0.34.1]` 曾试 `--browserUrl` loopback 因 chrome 144+ inspect 模式不暴露 `/json/version` 撤回，仍用 `--autoConnect` + list_pages round-trip 判据真实化）；`BrowserSession` = MCP tool 映射。**新增 action `disconnect`**（`[v0.0.46]`）：LLM 主动 `browser({mode:'attach', action:'disconnect'})` 释放 attach session（graceful close + kill MCP 进程，不杀 chrome），idempotent。**用户操作**：① 打开 `chrome://inspect/#remote-debugging` ② Enable remote debugging ③ chrome **144+** ④ 批准 attach prompt。**自定义 target**：profile 配 `cdpUrl` → 覆盖默认 autoConnect；远程 cdpUrl 非 loopback 私网 fail-closed（SSRF）；session 结束/agent DELETE 兜底自动 disconnect。`needsApproval=true`（HITL）。

**统一抽象产品意义**：用户/agent 视角只见 `browser` + `mode`，三 mode 操作集一致；底层 Playwright/MCP 分裂封装在 driver 内。

> **[v0.0.23.1 架构决策记录 — 核心设计原则]**：mode①② 的 playwright 操作走 **node worker 子进程**（`NodeWorkerDriver.executeOnce` → spawn `node browser-worker.cjs`），**bun 主进程绝不直接调 `playwright.connectOverCDP`**。原因：Bun 运行时下 `playwright.connectOverCDP()` 永久 hang/timeout（oven-sh/bun#9357，driver stdio pipe 兼容缺陷）—— chrome 起来、CDP HTTP 就绪，但 WS 连接 30s 超时；Node 下 608ms 成功。三组直接验证锁定（raw WS 直连正常 / A/B 排除 chrome 二进制 / Bun vs Node 决定性对比）。此为**架构级决策**（非临时绕行）：browser tool 凡涉及 playwright connectOverCDP 的场景都必须经 node 子进程。详见 tech `[P1]browser_tool.md` §3 + `states/v0.0.23.1/bugs/BUG-001-browser-connectovercdp-timeout-[fixed].md`。

### 7.2.4 配置 + 连接器

**7.2.4.1 `app_config` `web` group**（web_fetch 内置管线的工具级配置，非插件自带；`[v0.0.89]` 整组迁自 dev_config，端点走 `GET/PUT /config/app?group=web`）：

| key | 类型 | 默认 | secret | 说明 |
|---|---|---|---|---|
| `jinaApiKey` | string | —（无） | ✅ | jina reader API key。web_fetch jina 阶段用：**有则传**（`Authorization: Bearer`）、**无则不传**（匿名受限）。落盘原值，GET 出参 redact 为 `"***"`，PUT 占位 `"***"` merge 保留原值。**`[v0.0.121]` UI 入口**：应用设置 → 工具 tab → 网络抓取 section（`web-fetch-jina-api-key` SecretInput + 单 key PUT），详见 `specs/ui/overall/03-config-center.md §2.3b` |
| `jinaEnabled` | boolean | true | — | 是否启用 jina fetcher；false 跳过 jina，只跑 local fetcher（含其 headless 子分支，隐私敏感/airgapped） |
| `jinaTimeoutMs` | number | 20000 | — | jina 调用超时 |

> provider 凭证（Zhipu apiKey）**不在此**——v0.0.72 起归 `app_config.web_search` group（凭证从 ext impl configSchema 迁出，便于多 provider 切换 + 统一应用设置入口）。

**7.2.4.2 连接器页**（nav 新增「连接器」项 + 浏览器 tab，UI 详见 `specs/ui/overall/05-connectors.md`）：v0.0.23 仅「浏览器」连接器（browser attach 的用户侧门禁）。**双状态机**（需求原文「不可是一个 true、false 状态」）：

| 状态 | 取值 | 含义 | 持久化 |
|---|---|---|---|
| **switch（开关态）** | `on` / `off` | **`[v0.0.46]` 用户启用意图（feature flag，与 connection 完全解耦）** | **是**（intent，独立 `connector_config` 域） |
| **connection（连接态）** | `disconnected` / `connecting` / `connected` / `error` | 运行时连接实况 | 否（运行时派生/维护） |

**状态迁移（`[v0.0.46]` connect 时机重构：lazy on tool.run）**：

| 触发 | switch | connection | 备注 |
|---|---|---|---|
| **初始**（首次，无持久化） | off | disconnected | — |
| **点 toggle on**（intent=on） `[v0.0.46]` | **on** | disconnected（不变） | 仅持久化 intent + UI switch=on；**不进 connecting、不唤起 chrome、不 spawn chrome-devtools-mcp** |
| **LLM 首次调 `browser({mode:'attach'})`（switch=on 未连接）** `[v0.0.46]` | on | disconnected → connecting → connected/error | ConnectorManager `connectForToolRun(sessionId)` 触发 lazy connect（默认 `--autoConnect`）；成功记 owner=sessionId；失败 → error（`[v0.0.34]` 失败即停不重试） |
| **LLM 调 `browser({mode:'attach', action:'disconnect'})`**（sessionId=owner）`[v0.0.46]` | on（保持） | connected → disconnected | ConnectorManager `disconnect(sessionId)` → driver.disconnect（graceful close + kill MCP，不杀 chrome）；owner=null；idempotent |
| **LLM 调 attach 但被其他 session 占用**（owner≠sender && connected）`[v0.0.46]` | on | connected（不变） | `connectForToolRun` 返 `{ok:false, kind:'in_use_by_other', ownerSessionId}` → tool 层转 ToolError（`isError:true`）；**不通过 UI 通知**、不排队 |
| **LLM 调 attach 但 switch=off** `[v0.0.46]` | off | disconnected | `connectForToolRun` 返 `{kind:'not_enabled'}` → tool 引导用户去连接器页开启开关；**不 lazy connect** |
| **点 toggle off**（intent=off） | off | disconnected | 停止 attach（若 connected 则 driver.disconnect）；**不杀用户 chrome** |
| **运行中 chrome 关闭/连接断**（switch=on） | on（保持）`[v0.0.46]` | error | errorDetail 记原因；owner 保留但下次 connectForToolRun 会因 connection≠connected 允许其他 session 抢占 |
| **session 结束（agent DELETE / idle）** `[v0.0.46]` | on（保持） | connected → disconnected | 兜底 `disconnect(id, endedSid)`：仅当 owner=endedSid 才真断（idempotent） |
| **app 重启**（持久化 intent=on） `[v0.0.46]` | **on** | disconnected | ConnectorManager `bootstrap()` **只读 intent 恢复 UI 态**，**不 connect、不 spawn chrome-devtools-mcp、不弹「有应用要调试」prompt**（对比 v0.0.34：立即 connecting） |

> **`[v0.0.46]` 核心差异**：v0.0.34 把 switch=on 当作「立即 connect 意图」；v0.0.46 后 switch 退化为**纯功能开关**——connect 时机全部由 tool.run 首次调 attach lazy 触发。attach 资源全局唯一（owner sessionId 粒度）；冲突返 ToolError 不排队。根治「app 启动弹『有应用要调试』」副作用。

**ConnectorManager**（运行时服务，`[v0.0.46]` 时机重构）：`getState/getAll/isReady/enable/disable/bootstrap` + `[v0.0.46]` 新增 `connectForToolRun(id, sessionId)`（含门禁分层三态 `not_enabled` / `in_use_by_other` / `connect_failed`）+ `disconnect(id, sessionId?)`（idempotent）。`enable('browser')` 只写 intent + UI 态**不 connect**；`bootstrap()` 只读 intent 恢复 UI 态**不 connect**。owner 生命周期见 tech `[P1]connectors.md` §5。

**attach 门禁**（browser tool mode③ run 内，`[v0.0.46]` 分层）：

```typescript
if (input.action === 'disconnect') {
  await connectorManager.disconnect('browser', ctx.config.sessionId);
  return textResult('browser attach 已断开（若无活跃连接则无副作用）');   // isError:false
}
const r = await connectorManager.connectForToolRun('browser', ctx.config.sessionId);
if (!r.ok) return errorResult(formatConnectorError(r.error));   // isError:true
return dispatch(r.session, input);
```

- 门禁三态由 tool result 传达 LLM（`kind='not_enabled'` 引导开开关 / `'in_use_by_other'` 引导 owner session 先 disconnect / `'connect_failed'` 详情），**不弹 UI toast/modal**。
- 同 owner sessionId 后续 attach 调用复用 attachSession，不重复 connect。
- mode①②（headless/managed-profile）**不查连接器**——它们自启 chrome，与连接器无关。

---

## 7.3 关键用户路径（MANDATORY） [v0.0.23]

| ID | 用户操作链路 | 预期结果 | 类型 |
|----|-------------|---------|------|
| **A** | Zhipu provider 注册 + apiKey 配好 → agent 调 `web_search({query})` | `isError:false`，Zhipu 结果（title/url/snippet，可能含 publishedDate），untrusted 包装；调真 `open.bigmodel.cn` | API（真服务） |
| **A0** | agent 调 `web_search` → 无任何 provider 注册 | `isError:true`「web_search 未配置任何 provider」 | API |
| **A2** | Zhipu provider 注册但 apiKey 未配 → `isAvailable()=false` → agent 调 `web_search` | `isError:true`「provider Zhipu 不可用（凭证未配置?）」 | API |
| **B** | agent 调 `web_fetch({url:<公网可读页>})` → SSRF 通过 → 并行 race（jina ∥ 本地静态）→ 首个内容充足者胜 | `isError:false`，正文 markdown + title + 最终 URL + untrusted 包装；走系统代理（设 HTTP_PROXY） | API（真服务） |
| **B0** | `web.jinaApiKey` 未配 → agent `web_fetch` | jina 阶段不传 key（匿名），仍作为 race 一路；返回正文 | API |
| **B2** | local 静态 + jina 都不充足（重度 JS）→ local 切到 headless 子分支渲染 → readability | 返回正文 markdown | API |
| **C** | agent 调 `web_fetch({url:<内网 IP 或 file://>})` | `isError:true`，SSRF 拒绝（不抓取、不发往 jina） | API |
| **C2** | agent 调 `web_fetch`，目标 3xx 跨 origin 重定向 | 剥 `Authorization`/`Cookie` 后再请求新 origin；首 URL 公网但跳转内网仍拒 | API |
| **D** | agent 调 `browser({mode:'headless', action:'navigate', url})` → `action:'snapshot'` | 启动无头 chrome → `{snapshot, refs}`（a11y tree）；可 `click(ref)`/`type(ref,text)` | API |
| **E** | 首次 `browser({mode:'managed-profile', profileName:'X', action:'navigate', <login url>})` 登录 → close → 同 profile 再 navigate 同站 | 第二次登录态保留（cookie/会话仍在） | API |
| **E2** | 两进程同时 `browser({mode:'managed-profile', profileName:'X'})` | 后者报错「profile X in use」+ 提示，不抢锁 | API |
| **F** | 连接器 connected（路径 H 成功后）+ 用户 chrome 开 remote debugging（144+）→ agent `browser({mode:'attach', action:'listPages'})` → HITL 审批 → navigate/snapshot | 列出用户真实 tab；操作生效；session 结束**不杀用户浏览器** | API（需 HITL） |
| **G** | agent `browser({mode:'attach', cdpUrl:'<内网/远程私网>'})` | SSRF fail-closed 拒绝 | API |
| **H** | 用户进连接器页 → 点浏览器 toggle on `[v0.0.46]` | intent=on 持久化；UI toggle 显 on；status 文本显「已启用（未连接）」；**不唤起 chrome、不进 connecting、不 spawn chrome-devtools-mcp**（对比 v0.0.34：立即 connecting） | E2E + API |
| **I** | switch=on 但 chrome 未开 remote debugging → LLM 调 `browser({mode:'attach', action:X})` lazy connect 失败 `[v0.0.46]` | connection=**error** + errorDetail 记原因；owner 未写入；返回 ToolError 引导用户；**不重试循环**（沿用 [v0.0.34] 失败即停） | API |
| **J** | 持久化 switch intent=on → 重启 app → ConnectorManager bootstrap `[v0.0.46]` | 启动 switch=**on** + connection=**disconnected**（不 connect、不 spawn chrome-devtools-mcp、不弹「有应用要调试」prompt）；LLM 首次用 attach 时才连 | API |
| **K** | switch=off → LLM 调 `browser({mode:'attach', action:X})` `[v0.0.46]` | `isError:true`「browser attach 未启用...请在连接器页开启开关」，**不 lazy connect** | API |
| **P4** | session A 已 attach（owner=A）→ session B 调 `browser({mode:'attach', action:'listPages'})` `[v0.0.46]` | session B 收到 ToolError「browser attach 已被其他会话占用，请先在该会话调用 disconnect」；不影响 A；**不产生 UI 通知** | API |
| **P8** | switch=on 已 connected → LLM 调 `browser({mode:'attach', action:'disconnect'})` `[v0.0.46]` | driver 断开（graceful close + kill MCP，**不杀 chrome**）→ connection=disconnected；owner 清空；switch=on 保持；返回 `isError:false` | API |

**路径数**：18 条（A/A0/A2/B/B0/B2/C/C2/D/E/E2/F/G + H/I/J/K + P4/P8），覆盖 web_search Zhipu 主路径+降级、web_fetch 并行 race（key 有/无）/local headless 子分支/SSRF/重定向剥凭证、browser 三 mode + 占用冲突、连接器 toggle 成功/失败/重启、`[v0.0.46]` lazy connect + disconnect action + occupancy conflict、attach 门禁分层。每条至少 1 个 API case；连接器 toggle/HITL 可补 E2E。

---

## 7.4 范围边界 [v0.0.23]

**OUT（v0.0.23 明确排除）**：

| 排除项 | 理由 |
|--------|------|
| browser Computer-use 路线（截图+坐标） | 用户 explicit「下一阶段」，本期主用 a11y tree + element ref |
| browser 反检测（camofox） | hermes 路线复杂易失效 |
| web_fetch LLM 二次摘要（Gemini Flash 分块摘要） | 独立 enhancement，延后 |
| web_fetch firecrawl（第三方云 reader） | 仅采用 jina fetcher（与 local 并行 race）；firecrawl 不引入 |
| web_search 其他 provider（Tavily/Google/Bing...） | 协议+EP 已可插拔，其他后端以插件 ext impl 后续贡献（协议不变） |
| attach 模式 token 鉴权 | 单机本地单用户场景不做，多用户/远程后续加 |
| profile 占用冲突自动抢锁/排队 | 报错 + 提示用户，不抢不排 |
| 连接器自动退避重连 | v0.0.23 默认手动重试（UI 再点 toggle） |

---

## 7.5 设计决策 [v0.0.23]

### 7.5.1 web_search 协议先行 + list EP 单点路由（不绑死后端）
搜索后端是可变商业依赖（凭证/计费/配额各异），焊死绑死；**[v0.0.72 修订] EP 由 `exclusive` 改 `list`（多 provider 共存）+ tool 按 `app_config.web_search.type` 单点路由（仍 ≤1 一次答，非多 provider 并发融合）**——一次搜索一个 provider 答，结果可解释 + 凭证/计费隔离 + 与单选 UI 心智一致；多 provider 共存让用户切换 type 时无需先卸载旧 impl。协议不变、工具零改动即可换后端。反例：claude-code 绑死 Anthropic 原生 server tool，不可换。

### 7.5.2 Zhipu 作为首个内置 provider（[v0.0.123] 拆 2 条链路）
**开箱可用**（国内可直连，无需翻墙）+ **响应结构清晰**（`search_result[]` / MCP items 映射 `WebSearchResult` 字段对齐好）。**[v0.0.123] 拆为 2 个独立 impl**：`zhipu_coding_plan`（MCP `web_search_prime`，Coding Plan 订阅额度）+ `zhipu_api`（REST `/api/paas/v4/web_search`，按量计费）——两条本质不同的访问/计费链路（v0.0.121 曾把 REST 换成 MCP 混叫一个 `zhipu`），拆开后用户按计费方式选一条、各配一个 apiKey。EP list 可换——后续 Tavily/Google/Bing 以 ext impl 贡献，工具层零改动。

### 7.5.3 配置归属：jina key 进 app_config web group，Zhipu apiKey 进 app_config web_search group（v0.0.72 分离 · v0.0.89 jina 迁入 app_config）
jina 是 web_fetch **内置工具能力一环**（非插件，所有用户共享的管线），配置归 `app_config` `web` group（`[v0.0.89]` 迁自 dev_config，随 dev_config 废弃；group/key 名 + jinaApiKey redact/占位 merge 语义零变更）；Zhipu 是 **provider 插件**（与协议解耦、可换、凭证独立计费），凭证归 `app_config.web_search` group（v0.0.72 从 ext impl configSchema 迁出，便于多 provider 共存 + 统一应用设置入口 + 凭证不进代码声明对齐 v0.0.67 D1 secret 政策）。混了则内置凭证被插件凭证污染、插件凭证又无法随插件卸载清理。

### 7.5.4 连接器双状态（switch + connection）而非 bool；`[v0.0.46]` 完全解耦
需求明确「不可是一个 true、false 状态」。单一 bool 无法表达「用户意图=开但运行时未连上」（重启后 chrome 还没开、运行中 chrome 被关）。**`[v0.0.46]` 起 switch/connection 完全解耦**——switch 退化为**纯功能开关**（用户是否启用此功能），connection 全权表达运行时连接实况。**connect 时机 = tool.run 首次 lazy 触发**（不再由 bootstrap/toggle 触发），根治「app 启动弹『有应用要调试』」副作用（chrome-devtools-mcp `--autoConnect` 在 chrome 未开时会自启空 chrome）。attach 资源全局唯一（owner sessionId 粒度，冲突返 ToolError 不排队），LLM 可显式 `action:'disconnect'` 释放。反例（v0.0.34）：把 switch=on 当「立即 connect」，导致每次 app 启动都弹系统 prompt——设计偏差。

### 7.5.5 web_fetch ContentFetcher 契约 + 2 实现（jina / local 含 headless 子分支）并行 race
**统一 ContentFetcher 契约**（输入 URL + AbortSignal，输出 markdown），2 个实现（jina reader 自带 JS 渲染 / local = undici + readability）**并行**跑、`Promise.any` race 取首个「内容充足」者——干掉串行「jina 失败等满超时才降级」的延迟；**AbortController 构造注入**（胜出 abort 其他），输方 **detached 清理**避免句柄泄漏。jina 挂了 local 静态若充足零等待顶上；静态页 local 静态快且充足直接胜；JS 页 local 静态不足 → jina 胜，或 local 切到 headless 子分支与 jina 继续竞速。**headless 是 local 内部子分支**（静态 readability 不足时 local 自起 headless chrome 渲染，复用 PlaywrightDriver）——不是顶层兜底，避免「每次 fetch 都起 chrome」的资源浪费。**SSRF 强制在任何抓取之前**防内部 URL 泄漏；jina 可配置开关（`web.jinaEnabled=false` 隐私敏感/airgapped 可关，跳过 jina fetcher）。反例：(a) 串行 jina→兜底——jina 失败要等满 `jinaTimeoutMs` 才降级，慢；(b) 把 headless 提到顶层与 jina/local 三路全并行——每次 fetch 都起 chrome，资源浪费（v1.2「两路皆空 headless 兜底」措辞已撤回，headless 现归 local 子分支）。

### 7.5.6 web_fetch 用 undici 而非 Bun.fetch
Bun 原生 `Bun.fetch` **不读** `HTTP_PROXY`/`HTTPS_PROXY`；用户「享受系统代理」需求驱动选 undici `EnvHttpProxyAgent`。**代理失败不静默降级直连**——否则用户靠代理挡内网，降级即绕过 SSRF。

### 7.5.7 browser 接受 attach 驱动分裂 + 抽象统一协议
attach 用 `chrome-devtools-mcp`（chrome 144+ inspect 开关，**无需用户手动指定端口**），底层是 MCP tool 协议；`[v0.0.34]` 改为 `--browserUrl loopback` 默认（不再 `--autoConnect` 自启 chrome，纯 attach 失败即报错）；mode ①② 用 Playwright/CDP。两栈分裂不可避免，但**抽象 `BrowserDriver`/`BrowserSession` 统一协议**——调用方只见 `browser` 工具 + mode，操作集一致；底层分裂封装在 driver 内。`snapshot` 统一返回 `{snapshot, refs}`（a11y + ref）是「驱动模型统一」的落点。

### 7.5.8 共性：wrapExternalContent 标记 untrusted
web 抓回的正文 / search snippet / answer 一律 untrusted 包装，防 prompt injection（网页内嵌「忽略以上指令」类攻击）。

---

## 7.6 验收口径 [v0.0.23]

| 维度 | 口径 |
|------|------|
| web_search Zhipu | 路径 A PASS（真服务）：配 apiKey 后调真 `open.bigmodel.cn` 返回结果 + untrusted 包装 |
| web_search 降级 | 路径 A0/A2 PASS：无 provider / provider 不可用均返回精确错误 |
| web_fetch | 路径 B/B0/B2/C/C2 PASS（真服务）：ContentFetcher 并行 race + local headless 子分支 + SSRF 拒绝 + 重定向剥凭证；代理感知 |
| browser headless | 路径 D PASS：navigate + snapshot 返回 a11y + refs |
| browser profile | 路径 E PASS：登录态跨 session 保留；路径 E2 PASS：占用冲突报错 |
| browser attach | 路径 F PASS（真实 chrome 144+ + HITL + 连接器 connected）；路径 G PASS：远程私网 cdpUrl SSRF 拒绝 |
| 连接器 toggle on `[v0.0.46]` | 路径 H PASS：toggle on → intent 持久化 + switch UI=on + connection=disconnected；**不 spawn chrome-devtools-mcp** |
| 连接器 lazy connect 失败 `[v0.0.46]` | 路径 I PASS：LLM 调 attach → connection=error + errorDetail + owner 未写入；不重试 |
| 连接器重启不 connect `[v0.0.46]` | 路径 J PASS：持久化 intent=on → 重启 switch=on/connection=disconnected；**不弹「有应用要调试」prompt** |
| attach 门禁分层 `[v0.0.46]` | 路径 K PASS：switch=off → ToolError kind='not_enabled'，不 lazy connect |
| attach 占用冲突 `[v0.0.46]` | 路径 P4 PASS：owner=A + sessionB 调 attach → ToolError kind='in_use_by_other'，不通过 UI 通知 |
| LLM 主动 disconnect `[v0.0.46]` | 路径 P8 PASS：`action:'disconnect'` → driver 断开、owner 清空、switch=on 保持、isError:false（idempotent） |
| 配置 secret | `web.jinaApiKey` 落盘原值，API 出参 redact |
| 不可信内容 | web_fetch 正文 / search snippet 含 untrusted 包装 |
| 视觉保真 | 本版本无设计稿，此项跳过 |

> **`[v0.0.46]` 测试范围**：用户明确豁免 API/E2E test，仅跑 UT（覆盖 P1-P8 + I/J/K）。上表 API 列作为回归锚点保留，后续版本可补 API case。

---

version: 1.5 `[v0.0.121 modified]`（v1.4 → v1.5：**jina key 配置事实补账** —— §5 概念权威源 / §7.1.2 能力表配置行 / §7.1.3 核心价值 4 / §7.2.4.1 web group / §7.5.3 配置归属：jina web group 从「dev_config」更正为「`app_config` web group」（`[v0.0.89]` 已迁，此前 PRD 未跟上）+ 补 `[v0.0.121]` jinaApiKey UI 入口事实（应用设置 → 工具 tab → 网络抓取 section）。行为无变更，仅 spec 补账对齐代码。详见 `specs/ui/overall/03-config-center.md §2.3b` + `specs/tech/config/[P0]app_config.md §280`）。
version: 1.4 `[v0.0.72 modified]`（v1.3 → v1.4：**web_search 协议重构** —— §7.2.1 EP cardinality 由 `exclusive` 改 `list`（多 provider 共存）+ tool 按 `app_config.web_search.type` 单点路由；协议 `search`/`isAvailable` 加 `cfg` 入参；凭证从 ext impl `configSchema` 迁到 `app_config.web_search` group（删 `plugin.json` configSchema.apiKey + 删 env 回退）；§7.5.1/§7.5.3 设计决策对齐。详见 `specs/prd/version_logs/v0.0.72.md` §2 + `specs/tech/agent/tools/[P1]web_search_tool.md` v0.0.72 修订）。
version: 1.3 `[v0.0.46.connector_opt]`（v1.2 → v1.3：**连接器 lazy connect 时机重构** —— §7.2.3 attach action 增加 `disconnect`；§7.2.4.2 状态迁移表全表更新（lazy trigger + disconnect action + occupancy conflict + bootstrap 不 connect + switch/connection 完全解耦）；§7.3 路径表 H/I/J/K 语义调整 + 新增 P4/P8；§7.5.4 双状态设计决策升级为「完全解耦 + lazy on tool.run」；§7.6 验收表按 v0.0.46 语义重排，声明测试范围仅 UT。详见 `specs/prd/version_logs/v0.0.46.connector_opt/change_log.md`）。
version: 1.0 `[v0.0.23]`（v0.2 骨架补全为 1.0：§7.2 功能需求、§7.3 16 条用户路径、§7.5 8 项设计决策、§7.6 验收口径 全量回填；首版交付 web tools 三件套 + 配置 web group + 连接器）。
