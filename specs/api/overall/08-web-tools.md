# Web Tools API（v0.0.23 — web_search / web_fetch / browser 工具协议面 + 配置/连接器）

> version: 1.5 `[v0.0.330 modified]` · 引入版本 v0.0.23 · 2026-08-12
> 管什么：v0.0.23 引入的 3 个 agent tool（LLM 可调）的工具协议面契约（`ToolDefinition`：name / description / inputSchema + 输出 ToolResultBlock 形态 + isError 分支）+ app_config `web` group 配置（`[v0.0.89]` 随 dev_config 废弃迁自 `dev_config`，走 `/config/app?group=web`）+ 连接器端点组（browser attach 用户侧门禁）。
> 不管什么：工具内部实现（jina race / SSRF / chrome launch / MCP attach 细节 → `specs/tech/agent/tools/[P1]web_{search,fetch}_tool.md` + `[P1]browser_tool.md`）；连接器状态机内部（→ `specs/tech/config/[P1]connectors.md`）；UI（→ `specs/ui/overall/05-connectors.md` + `specs/ui/components/connector-page/`）；session/messages/SSE 通用契约（→ `04-agent-session.md`）。
> **本文件是 AT（API Test）web tools / config-web / connector 域的唯一依据**：api-verifier 黑盒 curl + SSE 观察，不读代码。

## 1. 概述

web tools 三件套让 agent 能上网：搜索（web_search）、抓单 URL 转 markdown（web_fetch）、chrome 自动化（browser）。三个工具均注册到 `defaultTools()`，LLM 经 `tool_call` 调用、产出 `tool_result`（详见 `04-agent-session.md` §3.2 + SSE `tool_call` / `tool_result` 事件）。**工具本身无独立 HTTP 端点**——契约是「input schema + 输出 ToolResultBlock 形态」。

**HTTP facade 面**（客户端直接调）：
- app_config `web` group（3 key）—— 复用现有 `/config/app` 端点（见 `03-config-center.md` §2）。`[v0.0.89]` web 组随 dev_config 废弃整组迁入 app_config，group/key 名与 redact 语义零变更。
- 连接器端点组（新增）—— `GET /config/connectors` + `PUT /config/connectors/:id`，browser attach 的用户侧门禁。

**EP inventory 面**：`web_search_provider`（**v0.0.72 改 `list`**，group=web）经 `/config/plugin` GET inventory 透传（见 `03-config-center.md` §3.1）。凭证归 `app_config.web_search` group（`GET/PUT /config/app?group=web_search`，见 `03-config-center.md §2.1`），**不再走 ext impl configSchema / `setImplConfig`**。

一句话：**v0.0.23 web tools = web_search/web_fetch/browser 三 tool 协议面 + app_config web group（jinaApiKey secret redact，`[v0.0.89]` 迁自 dev_config）+ /config/connectors 端点组（双状态机）+ web_search_provider EP inventory 透传**。

## 2. web_search 工具

按 query 检索 → 返回结构化结果列表（+可选 answer）。**协议先行 + list EP**（v0.0.72 由 exclusive 改 list，多 impl 共存、按 `app_config.web_search.type` 单点路由）——具体后端 provider 可插拔；内置 Zhipu provider，**[v0.0.123]** 拆 2 个独立 impl（`zhipu_coding_plan` MCP 订阅额度 / `zhipu_api` REST 按量计费）。

### 2.1 ToolDefinition

```typescript
{
  name: "web_search",
  description: "Search the web. Returns a list of results (title/url/snippet) and optional answer.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      maxResults: { type: "number", default: 10 },
      answer: { type: "boolean", default: false }
    }
  }
}
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `query` | string | ✅ | — | 搜索 query |
| `maxResults` | number | — | 10 | 结果数上限（上限由 provider 定） |
| `answer` | boolean | — | false | 是否请求带引用的答案（provider 不支持则忽略） |

### 2.2 输出 ToolResultBlock（content 为单个 text block）

| 分支 | isError | content[0].text |
|------|---------|-----------------|
| 正常 | false | markdown：`## Results\n1. **<title>** <url>\n   <snippet>\n   (<publishedDate>?)` × n + 可选 `## Answer\n<answer>`；整段 wrapExternalContent 标 untrusted；超 ~100k 截断 |
| type 未配置 | **true** | `web_search 未配置 provider type`（`app_config.web_search` 缺失或 `data.type` 缺失） |
| type 对应 impl 未激活 | **true** | `web_search type {type} 对应 impl 未激活` |
| provider 注册但不可用 | **true** | `provider <label> 不可用（凭证未配置?）`（isAvailable() 返 false；如 Zhipu apiKey 未配） |

**provider 解析**（v0.0.72 list 单点路由）：`resolveProvider` 读 `app_config.web_search.default` → 按 `type` 在 `web_search_provider` list EP 的全部 impl 中精确匹配 `impl.id` → `cfg = credentials[type] ?? {}` 传入。`isAvailable()` **禁止 I/O**（只查内存配置）。

**内置 Zhipu provider（[v0.0.123] 2 个独立 impl）**：`zhipu_coding_plan`（label「智谱 · Coding Plan（订阅额度）」，MCP `open.bigmodel.cn/api/mcp/web_search_prime/mcp`）/ `zhipu_api`（label「智谱 · API（按量计费）」，REST `/api/paas/v4/web_search`）。两 impl 凭证 apiKey 各走 `app_config.web_search.credentials.<implId>`（v0.0.72 从 ext impl configSchema 迁出）。响应映射（两 impl 一致）：`title←title` / `url←link` / `snippet←content`（截断）/ `publishedDate←publish_date`；无 score、无综合 answer。旧 implId `zhipu` 一次性迁移到 `zhipu_coding_plan`（技术权威 `specs/tech/config/[P0]app_config.md §3.6`）。

## 3. web_fetch 工具

抓单 URL → 系统代理 → SSRF 校验 → **2 个 ContentFetcher（jina / local）并行 race**（`Promise.any` 首个内容充足者胜，AbortController 构造注入 + 输方 detached 清理；local 含 headless 子分支：静态 readability 不足时 local 自起 chrome 渲染）→ markdown。

### 3.1 ToolDefinition

```typescript
{
  name: "web_fetch",
  description: "Fetch a URL, return main content as clean markdown. Races jina-reader (JS-rendered) ∥ local readability, first adequate wins; headless render as last resort. System-proxy aware, SSRF-guarded.",
  inputSchema: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string" },
      maxChars: { type: "number", default: 100000 }
    }
  }
}
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `url` | string | ✅ | — | 待抓取 URL |
| `maxChars` | number | — | 100000 | 输出正文截断长度 |

### 3.2 输出 ToolResultBlock

| 分支 | isError | content[0].text |
|------|---------|-----------------|
| 正常 | false | markdown 正文（title + 正文 + 最终 URL 元数据）；整段 wrapExternalContent untrusted；截断至 maxChars |
| SSRF 拒绝 | **true** | SSRF 失败原因（私网/保留段 / file:// / ftp:// / 跨重定向跳内网）—— **不抓取、不发往 jina** |
| 代理失败 | **true** | 代理失败错误（**不静默降级直连**） |
| 全部路线失败 | **true** | jina / local（含其 headless 子分支）均无充足内容 |

**管线**（对调用方透明）：SSRF 先行 → 2 个 ContentFetcher 并行 race（jina reader `r.jina.ai/<url>` ∥ local = undici + readability，`Promise.any` 取首个 trim 后正文 > ~200 chars 者，不 merge；AbortController 构造注入，胜出 abort 其他，输方 detached 清理）→ local 兜底子分支（静态不足时 local 自起 headless chrome 复用 PlaywrightDriver 渲染）→ markdown。

**配置依赖**：`web.jinaEnabled=false` → 跳过 jina fetcher；`web.jinaApiKey` 有则传（`Authorization: Bearer`）、无则不传（匿名仍可用）；超时 `web.jinaTimeoutMs`。

## 4. browser 工具

chrome 自动化三模式：① headless ② managed-profile（持久 profile）③ attach（已开 chrome）。统一 `BrowserDriver`/`BrowserSession` 协议抽象；驱动模型 = a11y tree + element ref。

### 4.1 ToolDefinition

```typescript
{
  name: "browser",
  description: "Automate Chrome: headless / persistent-profile / attach modes.",
  inputSchema: {
    type: "object",
    required: ["mode", "action"],
    properties: {
      mode: { enum: ["headless", "managed-profile", "attach"] },
      action: { enum: ["launch","navigate","snapshot","click","type","listPages",
                       "selectPage","evaluate","screenshot","close"] },
      // [v0.0.264] +launch/+close（headless/managed-profile 常驻实例生命周期；attach 语义）
      // [v0.0.266] -disconnect（统一 close：attach close = 断开 MCP 连接，不杀用户 chrome）
      // [v0.0.330] desc 三模式示例 + 参数传递铁律（launch 一次性传初始化参数，之后只需 mode+action）
      // [v0.0.334] -cdpUrl（attach 仅 autoConnect，无 URL 输入）+ desc 简化（自动连接 + 前置条件 + 同意流程 + 失败引导 + 共享浏览器安全警告 + 模式路由）
      profileName: { type: "string" },
      url: { type: "string" },
      ref: { type: "string" },
      text: { type: "string" }
    }
  }
}
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `mode` | enum `headless`/`managed-profile`/`attach` | ✅ | — | chrome 启动/连接模式 |
| `action` | enum | ✅ | — | `launch`/`navigate`/`snapshot`/`click`/`type`/`listPages`/`selectPage`/`evaluate`/`screenshot`/`close` + `[v0.0.264]` `launch`/`close`（headless/managed-profile 常驻实例生命周期）+ `[v0.0.266]` close 统一覆盖 attach（断开 MCP 连接，不再有独立 `disconnect` action） |
| `profileName` | string | mode=② launch 必填（`[v0.0.330]` 仅 launch 初始化参数） | — | profile 名；正则 `/^[a-z0-9][a-z0-9-]*$/` ≤64；创建后 navigate/close 无需再传（handle 承载） |
| `url` | string | action=navigate 必填 | — | 目标 URL |
| `ref` | string | action=click/type 必填 | — | element ref（来自 snapshot） |
| `text` | string | action=type 必填 | — | 待输入文本 |

> `[v0.0.334]` -cdpUrl：attach 仅 autoConnect（自动连接本机 chrome://inspect 远调模式），**无任何 URL 输入**——SSRF 门禁段删除。

> 完整可选字段（pageId/format/script 等）以 BrowserSession 协议为准（见 tech `[P1]browser_tool.md` §2）。

### 4.2 输出 ToolResultBlock

| action | isError=false 时 content[0].text |
|--------|---------------------------------|
| `launch` `[v0.0.264]` | `launched <mode>` / `reuse <mode>`（幂等复用已 ready 实例） |
| `snapshot` | `{ snapshot: string, refs: Record<id,{role,name,nth}> }` 序列化（a11y tree + ref） |
| `listPages` | `PageInfo[]`（`{id, url, selected?}`）序列化 |
| `navigate`/`click`/`type`/`selectPage` | 简短结果描述（如 `navigated to <url>`） |
| `evaluate` | script 返值序列化（unknown） |
| `screenshot` | 辅助，`{ mime, data(base64) }`（可空，作 vision 校验/给 LLM 看长相） |
| `close` `[v0.0.264]` | `closed`（`[v0.0.330]` 无 instance → 报错 `no_browser_instance` 提示先 launch，不再静默 no-op）；attach 语义 = 断开 MCP 连接 + 检测调试态残留并返回引导提示（不杀用户 chrome）`[v0.0.266]` → `[v0.0.330]` 残留检测 → `[v0.0.336]` 清理失败返回 `close_incomplete` 错误（不删实例可重试） |

### 4.3 isError 分支（`[v0.0.46]` attach 门禁分层 + `[v0.0.264]` 前置校验）

| 分支 | isError | content[0].text |
|------|---------|-----------------|
| mode=attach launch 且 switch=off `[v0.0.46]` | **true** | `browser attach 未启用：请在「连接器 → 浏览器」中开启开关`（kind='not_enabled'，**不连接、不 spawn MCP**） |
| mode=attach launch 连接失败 `[v0.0.266]`→`[v0.0.334]` 版本引导→`[v0.0.337]` 失败清理升级 | **true** | `browser attach 连接失败：<原因>`（chrome 未开 remote debugging / 拒绝 prompt / list_pages round-trip 失败；kind='attach_failed'；沿用 `[v0.0.34]` 失败即停不重试）——`[v0.0.334]` 探测本机 Chrome 版本：<144 → 明确「检测到 Chrome v<v>（<144），attach 需 Chrome ≥144（chrome://inspect 远调模式），请升级 Chrome 后重试」；≥144 或探测失败 → 引导「开启/批准 remote debugging」；`[v0.0.337]` 失败时 driver 内部三层清理（graceful close → kill mcp 进程组 → watchdog `--parent-pid` pkill，best-effort）+ launch 超时 abort（signal 透传，abort → 立即清理）+ 失败入台账（insert 不 delete，留给启动自检回收） |
| mode=attach 且 HITL 审批被拒 | **true** | 审批拒绝说明 |
| mode=①② 无 instance 调 action `[v0.0.264]` | **true** | `当前会话没有 headless/managed-profile 浏览器实例，请先调用 browser(action="launch")`（kind='no_browser_instance'；前置校验铁律） |
| mode=③ 无 attach instance 调操作 action `[v0.0.266]` | **true** | `当前会话没有 attach 浏览器实例，请先调用 browser(action="launch", mode="attach")`（kind='no_browser_instance'；不再 lazy connect） |
| mode=①② 实例 idle 超时 `[v0.0.264]` | **true** | `浏览器实例已闲置关闭，请重新 launch`（kind='idle_timeout'；默认 15min lazy check） |
| mode=①② worker 崩溃 `[v0.0.264]` | **true** | `worker 崩溃: <原因>，请重新 launch`（kind='worker_crashed'） |
| mode=①② action 超时 `[v0.0.264]` | **true** | `cdp_timeout`（kill instance，提示重新 launch） |
| mode=③ 操作时连接失活 `[v0.0.266]` | **true** | `attach 浏览器连接已断开（Chrome 可能被关闭），请重新 launch`（检测 dispatchAction 返回文本匹配失活模式 → 自动清理失活实例，下次需重新 launch） |
| close 清理失败 `[v0.0.336]` | **true** | `close 清理不完整（实例保留可重试）: <原因>`（kind='close_incomplete'；impl.close 任一清理步骤失败 ok=false 或抛错 → manager 不删 instances，调用方可重试 close；execute/idle 收尾路径 catch 不逃逸，仍返回原预期文案） |
| mode=② profile 占用冲突 | **true** | `profile <name> in use` + 提示（不抢锁不排队） |
| 其他（chrome 启动失败 / navigate 超时 / ref 不存在等） | **true** | 原因 |

> `[v0.0.334]` -cdpUrl：删「mode=③ cdpUrl 非 loopback fail-closed / loopback 豁免」两行（attach 无 URL 输入，SSRF 面消失）。

**needsApproval**：`input.mode === 'attach'` → HITL 审批（操作用户真实浏览器）；mode ①② 不审批。

**生命周期语义（对调用方，`[v0.0.46]` lazy connect + disconnect action + `[v0.0.264]` 常驻实例 launch/close + `[v0.0.266]` attach 并入 InstanceManager + `[v0.0.330]` instanceKey 收敛 + close 残留检测 + `[v0.0.334]` 删 cdpUrl + sqlite 台账 + `[v0.0.336]` close 三层一致）**：三模式统一由 BrowserInstanceManager 管理——**首次调用 `action='launch'` 建立实例**（幂等：已 ready 复用；同 session 同 mode 重复 launch 复用不换 profile；attach 的 launch = ChromeMcpDriver.connect（仅 autoConnect），key=`sessionId:attach`），此后 navigate/snapshot/click/type 等 action 在同一实例上执行（页面/登录态/lastRefs 跨 tool_call 保持），`action='close'` 显式关闭：mode ①② 三要素清理（killProcessGroup + headless rmSync + usedPorts.delete + 台账硬删），mode ③ attach 断开 MCP 连接 + **显式回收 mcp 主进程组 + 兜底杀 detached watchdog** + 台账硬删（`[v0.0.334]` attach MCP 子进程入台账；`[v0.0.336]` G4/G5 进程回收，`--parent-pid` 精确锚定不误杀）+ 检测调试态残留并返回引导提示（**不杀用户 chrome** / 不删目录 / 不释放端口；`[v0.0.330]` 无实例 close → `no_browser_instance` 报错；`[v0.0.336]` 任一清理步骤失败 → `close_incomplete` 错误 + **不删 instances 可重试**）；**非 launch/close action 前置校验**：无 instance → `no_browser_instance` 报错提示先 launch（三模式统一，attach 不再隐式 lazy connect）；attach 操作时 CDP 断线（chrome 被关闭）→ 检测失活 → 自动清理 → 下次需重新 launch（异常自愈）；session 结束/agent DELETE 兜底 releaseSession；服务关闭 shutdown hook releaseAll + **开机自检按 sqlite 台账清残留**（`[v0.0.334]` 替换 browser-instances.json；孤儿 MCP 代理/playwright worker/临时目录/锁/端口；不恢复不认领，agent 需要时重新 launch）。ConnectorManager 瘦身为「switch 门禁 + UI 状态」（enable/disable/bootstrap/getState/getAll/isReady），不再持有 attach session / owner。

> **[v0.0.23.1] mode①② 内部实现路径（对外契约变化见 `[v0.0.264]`）**：v0.0.263 及以前 mode①② tool run 内调 `driver.executeOnce`（而非 `connect`）——`NodeWorkerDriver.executeOnce` spawn `node browser-worker.cjs` 子进程，worker 内 spawn chrome + connectOverCDP + dispatch 单个 action + cleanup chrome，stdout 返 `{ok,text?} \| {ok:false,error}`（**绕开 Bun 不支持 playwright connectOverCDP 的 bug**，oven-sh/bun#9357）。**[v0.0.264] mode①② 改走 BrowserInstanceManager 常驻实例**：`launch` 建立 → 其他 action 经 `InstanceManager.execute`（前置校验 + idle check + abort）→ `close` 关闭；`NodeWorkerDriver.executeOnce` 保留仅服务 web_fetch headless render（单次执行器，不引入常驻）；worker 协议升级为循环服务（`loop:true` 判常驻，跨 action 保持 lastRefs）。**[v0.0.266] mode③ attach 并入 InstanceManager**：`launch(mode='attach', cdpUrl?)` = ChromeMcpDriver.connect（经 InstanceManager 注入共享 attachDriver 单例，key=`sessionId:attach` 幂等复用）；操作类 action 经 `getReadyInstance` 前置校验后 tool.ts 主进程 `dispatchAction`（attach 的 screenshot 落盘需 ToolCtx，execute 保持 worker 语义不混入）；CDP 断线失活 → 文本检测 `isAttachConnectionLost` → `handleAttachLost`（state=dead + disconnect 清理）→ 下次 `no_browser_instance` 引导重新 launch；`close(mode='attach')` = attachDriver.disconnect（不杀用户 chrome）。对外 schema 变化：`[v0.0.46]` action 枚举加 `disconnect`、`[v0.0.264]` action 枚举加 `launch`/`close`、`[v0.0.266]` action 枚举去 `disconnect` 统一 close（见 §4.1）。**`[v0.0.334]` cdpUrl 已删**：`launch(mode='attach')` 不再接受连接端点，恒走 autoConnect；attach MCP 子进程入 sqlite 台账（`browser_instances` 表），app 启动按台账清孤儿 MCP 代理。详见 tech `[P1]browser_tool.md` §3/§4/§7 + `[P1]browser_instance_manager.md`。

## 5. app_config `web` group（复用 `/config/app`）

> **`[v0.0.89]` 端点迁移**：web 组随 `dev_config` 整体废弃整组迁入 `app_config`，改走 `/config/app?group=web`（group/key 名与 redact 语义零变更；v0.0.23 首建时在 dev_config，见文末版本尾注）。

**无新增端点**——复用现有 `GET /config/app?group=web` + `PUT /config/app`（见 `03-config-center.md` §2）。group=`web` 的 3 个 key：

| key | 类型 | 默认 | secret | 说明 |
|-----|------|------|--------|------|
| `jinaApiKey` | string | —（无） | ✅ | jina reader API key；web_fetch jina 阶段用，**有则传**、**无则不传**（匿名受限） |
| `jinaEnabled` | boolean | true | — | false → 跳过 jina fetcher（仅 local fetcher，含其 headless 子分支，隐私/airgapped） |
| `jinaTimeoutMs` | number | 20000 | — | jina 调用超时（ms） |

### 5.1 secret 语义（jinaApiKey — GET 明文 + PUT 占位 merge，详 `03-config-center.md` §3.6）

> **`[v0.0.135]` 统一套路**：jina GET 返回**明文**，与 observability secretKey（`03-config-center.md` §3.5）一致——secret mask 收敛到前端 `SecretInput` 展示层。旧「后端 GET redact」已废弃。

- **GET `/config/app?group=web`**：响应中 `jinaApiKey` 的 `data` **明文返回**（secret mask 收敛前端展示层）。
- **PUT `/config/app`**（单 key 或整组提交）：`jinaApiKey` 字段值等于占位 `"***"`（旧前端未改）→ 服务端**保留原落盘值**（merge，向后兼容）；非占位真值 → 服务端用新值落盘。

记录缺失（从未配过 jinaApiKey）→ GET 整组响应不含该 key 条目；消费方走代码默认（jinaApiKey 缺省=不传 / jinaEnabled 缺省=true / jinaTimeoutMs 缺省=20000）。

## 6. 连接器端点组（新增 — `/config/connectors`）

底层经 `ConnectorManager`（见 tech `[P1]connectors.md` §5）。v0.0.23 仅 `browser` 连接器。**双状态机**（switch 持久化 intent + connection 运行时态）由后端维护，客户端只读 state + 派发 enable/disable。

### 6.1 `GET /config/connectors`

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/config/connectors` | 所有连接器当前实时状态（v0.0.23 仅 browser） | `200` + `{ items: ConnectorState[] }` |

```typescript
interface ConnectorState {
  id: "browser";
  switch: "on" | "off";                         // [v0.0.46] 用户启用意图（feature flag，与 connection 完全解耦）；持久化值 = 此字段
  connection: "disconnected" | "connecting" | "connected" | "error";
  errorDetail?: string;                         // connection=error 时原因（chrome 未开 / 未开 remote debugging / 版本<144 / 拒绝 prompt / list_pages 失败）
  lastConnectedAt?: number;                     // 上次 connected 时间戳
}
```

### 6.2 `PUT /config/connectors/:id` — enable / disable

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `PUT` | `/config/connectors/:id` | 派发 enable/disable（写 intent，`[v0.0.46]` 不再触发 connect）；`:id` ∈ {`browser`} | `ToggleConnectorBody` | `202` + `{ ok: true }` |

```typescript
interface ToggleConnectorBody {
  enable: boolean;
  // [v0.0.46] true = intent=on 持久化 + switch UI=on（不再触发 connect，connect 由 LLM 首次调 attach lazy 触发）
  // false = intent=off + 若已连接则 disconnect（不杀用户 chrome）
}
```

**状态迁移（`[v0.0.46]` PUT 端点契约本身不变，语义调整）**（详见 tech `[P1]connectors.md` §3.2）：

| 触发 | switch | connection | 备注 |
|------|--------|-----------|------|
| `enable=true` `[v0.0.46]` | off → **on**（同步） | disconnected（不变） | 只写 intent + UI 态；**不进 connecting、不 spawn chrome-devtools-mcp** |
| `enable=false` | → **off** | 若原 connected 则 → **disconnected**（disconnect + owner=null） | 停止 attach，**不杀用户 chrome** |
| app 重启（持久化 intent=on） `[v0.0.46]` | 启动直接 **on** | disconnected（不变） | ConnectorManager `bootstrap()` 只读 intent 恢复 UI 态；**不 connect、不弹「有应用要调试」** |

> **`[v0.0.46]`** connection=connecting/connected/error 的迁移**不再由 PUT 触发**——由 LLM 调 `browser({mode:'attach'})` 时 tool 层调 `connectForToolRun` 触发 lazy connect（不经 HTTP）。GET /config/connectors 仍反映实时 connection 态。

**返回语义**：`202 Accepted` = 已接收；`[v0.0.46]` 状态实际上是同步迁移（enable=true 只写 intent + UI 态，不再 async connect），保留 202 兼容。**幂等**：重复 enable=true / enable=false 在同态下无害。

**错误**：`400` body 非 `{enable:boolean}` 或 `:id` 非法；`404` `:id` 不存在。

## 7. EP inventory 透传（`/config/plugin` GET）

`web_search_provider`（**v0.0.72 cardinality=`list`**（原 `exclusive`）, group=`web`）加入 BUILTIN_EXTENSION_POINTS。**无新增端点**——经现有 `GET /config/plugin` inventory 自动透传（见 `03-config-center.md` §3.1）：`tree.groups[].points[].impls[]` 中 `point='web_search_provider'` 节点含内置 Zhipu 两 impl（**[v0.0.123]** `zhipu_coding_plan` / `zhipu_api`）。**[v0.0.72] 多 provider 共存**（list）→ UI 渲染 type 下拉选择框（v0.0.121 改自 choice-cards，应用设置 → 网络搜索 section）；tool 按 `app_config.web_search.type` 单点路由，**不调 `setExclusive`**（PUT `/config/plugin` v0.0.67 起只读返 405）。**[v0.0.72] Zhipu apiKey 凭证经 `PUT /config/app { group:"web_search", items:[{key:"default", data:{type, credentials}}] }`** 写入（`/config/app` 端点，非 `/config/plugin`；不再走 `setImplConfig`）；secret redact 同 §5.1 套路。

## 8. AT 覆盖（PRD 16 条用户路径）

工具调用（web_search/web_fetch/browser）通过 `POST /session/:id/messages` 触发 run，经 SSE 观察 `tool_call`/`tool_result` 事件断言；config/connector 经 HTTP 端点直接 curl。逐路径映射见 `specs/api/version_logs/v0.0.23/change_log.md` §5。

## 9. 错误码汇总

| HTTP | 端点 | 触发 |
|------|------|------|
| `400` | `PUT /config/connectors/:id` | body 非 `{enable:boolean}`；`:id` 非法 |
| `404` | `PUT /config/connectors/:id` | `:id` 不存在 |
| `400/404` | `/config/app`、`/config/plugin` | 沿用 `03-config-center.md` §2.3/§3.3（`[v0.0.89]` web 组已迁 `/config/app`） |

> 工具调用的「错误」走 ToolResultBlock 的 `isError:true` 分支（非 HTTP 错误码），经 SSE `tool_result` 事件观察。

## 10. 版本

version: 1.8 `[v0.0.337 modified]`（1.7 → 1.8：**attach launch 失败/超时清理升级，HTTP 端点契约零变化**——§4.3 attach 连接失败行补「driver 内部三层清理（graceful close → kill mcp 进程组 → watchdog `--parent-pid` pkill，best-effort）+ launch 超时 abort（signal 透传，abort → 立即清理）+ 失败入台账（insert 不 delete，留给启动自检回收）」。技术架构详见 `specs/tech/agent/tools/[P1]browser_tool.md` + `[P1]browser_instance_manager.md` + `specs/tech/version_logs/v0.0.337.attach_launch_failure_leak/change_plan.md`）。
version: 1.7 `[v0.0.336 modified]`（1.6 → 1.7：**attach close 三层一致 + cache key 对称，HTTP 端点契约零变化**——§4.2 close 行补「清理失败返回 `close_incomplete` 错误（不删实例可重试）」；§4.3 isError 分支新增「close 清理失败 `[v0.0.336]`」行（kind='close_incomplete'，impl.close 任一清理步骤失败 ok=false 或抛错 → manager 不删 instances，execute/idle 收尾路径 catch 不逃逸）；生命周期语义补「attach close 显式回收 mcp 主进程组 + 兜底杀 detached watchdog（`--parent-pid` 精确锚定）+ connect/disconnect cache key 对称（同一 `resolveDefaultChromeUserDataDir` 解析，根除 launch 复用死连接）」。技术架构详见 `specs/tech/agent/tools/[P1]browser_tool.md` v1.9 + `[P1]browser_instance_manager.md` + `specs/tech/version_logs/v0.0.336.attach_close_process_leak/change_plan.md`）。
version: 1.6 `[v0.0.334 modified]`（1.5 → 1.6：**browser 工具删 cdpUrl + attach 仅 autoConnect + 失败版本引导，HTTP 端点契约零变化**——§4.1 ToolDefinition 删 `cdpUrl` property（剩 mode/action/profileName/url/ref/text）+ desc 简化（attach 自动连接用户已开 Chrome，无需指定地址 + 前置条件 Chrome ≥144 + 同意流程 + 失败引导 + 共享浏览器安全警告 + 模式路由「我的 chrome→attach / 登录态→managed-profile / 默认→headless」）；§4.1 字段表删 cdpUrl 行；§4.3 删 SSRF 两行（无 URL 输入，SSRF 面消失）+ attach 连接失败行补「版本 <144 → 明确提示升级 Chrome / ≥144 → 引导开启批准 remote debugging」；生命周期语义补「attach MCP 子进程入 sqlite 台账 + 开机自检按台账清残留」。技术架构详见 `specs/tech/agent/tools/[P1]browser_tool.md` v1.8 + `[P1]browser_instance_manager.md`）。
version: 1.5 `[v0.0.330 modified]`（1.4 → 1.5：**browser attach 缺省 autoConnect + close 残留检测 + instanceKey 收敛，HTTP 端点契约零变化**——§4.1 注释补 desc 三模式示例 + 参数传递铁律；`profileName` 改「仅 launch 初始化参数」（`[v0.0.330]` instanceKey 三模式统一 `sid:mode`，创建后 navigate/close 无需再传）；`cdpUrl` 补「缺省 autoConnect 自动连 chrome://inspect 远调模式，不再塞 127.0.0.1:9222；显式 cdpUrl = 连接用户自开调试 Chrome，close 只断连、调试态由用户管理」；§4.2 close 行改「无 instance → `no_browser_instance` 报错提示先 launch（不再静默 no-op）；attach = 断开 MCP 连接 + 检测调试态残留并返回引导提示」；§4.3 生命周期语义补「同 session 同 mode 重复 launch 复用不换 profile + attach close 残留检测提示」。技术架构详见 `specs/tech/agent/tools/[P1]browser_tool.md` v1.7 + `[P1]browser_instance_manager.md`）。
version: 1.4 `[v0.0.266 modified]`（1.3 → 1.4：**browser attach 生命周期并入 InstanceManager + action 枚举去 disconnect，HTTP 端点契约零变化**——§4.1 browser tool `inputSchema.action` 枚举移除 `disconnect`（统一 `close`：attach close = 断开 MCP 连接，不杀用户 chrome）；§4.2 移除 disconnect result 行、close 行补 attach 语义；§4.3 isError 分支按 attach 新语义重写（`not_enabled` 门禁保留；`in_use_by_other` 删除——attach 变 session 级 key=`sessionId:attach` 无全局占用；lazy connect 失败改 launch 连接失败 `attach_failed`；新增 mode=③ 无 instance 前置校验 + 操作失活自愈分支）；§4.3 生命周期语义按三模式统一 BrowserInstanceManager 管理更新（launch=connect / 操作经 getReadyInstance+dispatchAction / close=disconnect；失活自动清理引导重新 launch；ConnectorManager 瘦身为 switch 门禁 + UI 状态）。技术架构详见 `specs/tech/agent/tools/[P1]browser_instance_manager.md` + tech `[P1]browser_tool.md` v1.6）。
version: 1.3 `[v0.0.264 modified]`（1.2.2 → 1.3：**browser 工具 action 枚举扩展 launch/close + 常驻实例前置校验，HTTP 端点契约零变化**——§4.1 browser tool `inputSchema.action` 枚举增加 `launch`/`close`（headless/managed-profile 常驻实例生命周期）；§4.2 添加 launch/close result 行；§4.3 isError 分支新增 mode①② 前置校验四态（`no_browser_instance` / `idle_timeout` / `worker_crashed` / `cdp_timeout`）；§4.3 生命周期语义按 BrowserInstanceManager 常驻实例更新（launch 建立 → action 前置校验 → close 关闭；session 结束 releaseSession + shutdown hook + 开机自检）；§4.3 内部实现路径更新（mode①② 从 executeOnce 一次性改走 InstanceManager 常驻，executeOnce 保留仅 web_fetch）。技术架构详见 `specs/tech/agent/tools/[P1]browser_instance_manager.md` + tech `[P1]browser_tool.md` v1.5）。
version: 1.2.2 `[v0.0.123 modified]`（1.2.1 → 1.2.2：**web_search Zhipu provider 1→2 + list 语义补账，无 HTTP 契约变更**——§2 内置 Zhipu 从单 implId `zhipu` 拆为 `zhipu_coding_plan`（MCP 订阅额度）/ `zhipu_api`（REST 按量计费）两独立 impl；§2.2 错误分支/`resolveProvider` 从过时的 exclusive `getExclusiveExtension` 改为 v0.0.72 list 单点路由（type 未配置 / impl 未激活 / 不可用三态）；§5 inventory 透传 impls 从单 provider 改两 impl + choice-cards 改下拉（v0.0.121）。GET/PUT `/config/app?group=web_search` 端点/schema/redact 全不变，仅样例 implId 值 + provider 清单。旧 `zhipu` 一次性迁移到 `zhipu_coding_plan` 见 `app_config.md §3.6`。详见 `specs/tech/version_logs/v0.0.123/change_log.md`）。
version: 1.2.1 `[v0.0.89 modified]`（1.2 → 1.2.1：**端点迁移 spec 补账，非行为变更**——web `group` 随 `dev_config` 整体废弃（`/config/dev` 全部方法返 404）整组迁入 `app_config`，本文将 §1 facade 面 / §5 标题+正文 / §5.1 redact-merge 描述 / §9 错误表中所有以现行契约口吻出现的 `/config/dev` 更正为 `/config/app`，「dev_config web group」→「app_config web group」；group/key 名与 jinaApiKey redact/占位 merge 语义**零变更**，仅 entity 从 `dev_config` 改 `app_config`、端点从 `/config/dev` 改 `/config/app`。权威迁移描述见 `03-config-center.md` 头部 v0.0.89 注 + §3.6。此前 08-web-tools 未跟上 v0.0.89 迁移，仍以现行口吻写 `/config/dev`，本次为 spec 补账。）
version: 1.2 `[v0.0.46 modified]`（1.1 → 1.2：**连接器 lazy connect 时机重构** —— HTTP 端点契约本身**零变化**（GET/PUT `/config/connectors` 端点/请求体/响应码全不变），语义调整：§4.1 browser tool `inputSchema.action` 枚举增加 `disconnect`（仅 mode=attach 有效）；§4.2 添加 disconnect result 行；§4.3 attach isError 分支重写为门禁分层三态（`not_enabled` / `in_use_by_other` / `connect_failed`），删除旧「未连接」错误；§4.3 生命周期语义按 lazy connect + disconnect action + owner sessionId 更新；§6.1 `ConnectorState.switch` 语义注释改为 feature flag（与 connection 完全解耦）；§6.2 `PUT enable=true` 只写 intent + UI 态**不再触发 connect**（connect 由 tool.run 首次调 attach lazy 触发）；状态迁移表按 v0.0.46 语义重写；§6.2 保留 202 返回码兼容。详见 `specs/prd/version_logs/v0.0.46.connector_opt/change_log.md` + tech `[P1]connectors.md` v1.2 + `[P1]browser_tool.md` v1.4。）
version: 1.1 `[v0.0.23.1 modified]`（1.0 → 1.1：**纯内部 bugfix，对外 API 契约零变化**——mode①② browser tool 改走 `NodeWorkerDriver.executeOnce`（node worker 子进程）绕开 Bun playwright connectOverCDP bug；mode/schema/result/isError 分支全不变，仅 §4.3 补「mode①② 内部实现路径」说明。增量变更见 `specs/api/version_logs/v0.0.23.1/change_log.md`）。
version: 1.0 `[v0.0.23]`：新建 web_search / web_fetch / browser 三 tool 协议面 + dev_config web group（jinaApiKey secret redact；**v0.0.89 该 group 迁 app_config，端点改 `/config/app`，见 1.2.1**）+ /config/connectors 端点组（双状态机）+ web_search_provider EP inventory 透传。
