# Web Tools API（v0.0.23 — web_search / web_fetch / browser 工具协议面 + 配置/连接器）

> version: 1.2.2 `[v0.0.123 modified]` · 引入版本 v0.0.23 · 2026-07-15
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
      action: { enum: ["navigate","snapshot","click","type","listPages",
                       "selectPage","evaluate","screenshot","disconnect"] },
      // [v0.0.46] +disconnect（仅 mode=attach 有效；其他 mode 传 disconnect 报参数错误）
      profileName: { type: "string" },
      url: { type: "string" },
      ref: { type: "string" },
      text: { type: "string" },
      cdpUrl: { type: "string" }
    }
  }
}
```

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `mode` | enum `headless`/`managed-profile`/`attach` | ✅ | — | chrome 启动/连接模式 |
| `action` | enum | ✅ | — | `navigate`/`snapshot`/`click`/`type`/`listPages`/`selectPage`/`evaluate`/`screenshot`/`close` + `[v0.0.46]` `disconnect`（仅 mode=attach，主动释放 attach session） |
| `profileName` | string | mode=②③ 必填 | — | profile 名；正则 `/^[a-z0-9][a-z0-9-]*$/` ≤64 |
| `url` | string | action=navigate 必填 | — | 目标 URL |
| `ref` | string | action=click/type 必填 | — | element ref（来自 snapshot） |
| `text` | string | action=type 必填 | — | 待输入文本 |
| `cdpUrl` | string | — | — | mode=③ fallback；**本地 loopback（127.x/::1/localhost）豁免 SSRF**（CDP 控制面 ≠ 页面导航，attach 本机 chrome 正常用法），非 loopback 远程/私网/`file://` fail-closed `[v0.0.29 modified]` |

> 完整可选字段（pageId/format/script 等）以 BrowserSession 协议为准（见 tech `[P1]browser_tool.md` §2）。

### 4.2 输出 ToolResultBlock

| action | isError=false 时 content[0].text |
|--------|---------------------------------|
| `snapshot` | `{ snapshot: string, refs: Record<id,{role,name,nth}> }` 序列化（a11y tree + ref） |
| `listPages` | `PageInfo[]`（`{id, url, selected?}`）序列化 |
| `navigate`/`click`/`type`/`selectPage` | 简短结果描述（如 `navigated to <url>`） |
| `evaluate` | script 返值序列化（unknown） |
| `screenshot` | 辅助，`{ mime, data(base64) }`（可空，作 vision 校验/给 LLM 看长相） |
| `disconnect` `[v0.0.46]` | `browser attach 已断开（若无活跃连接则无副作用）`（idempotent，成功即 `isError:false`） |

### 4.3 isError 分支（`[v0.0.46]` attach 门禁分层）

| 分支 | isError | content[0].text |
|------|---------|-----------------|
| mode=attach 且 switch=off `[v0.0.46]` | **true** | `browser attach 未启用：请在「连接器 → 浏览器」中开启开关`（kind='not_enabled'，**不 lazy connect、不 spawn MCP**） |
| mode=attach 且被其他 session 占用 `[v0.0.46]` | **true** | `browser attach 已被其他会话占用（sessionId=<owner>），请先在该会话调用 disconnect`（kind='in_use_by_other'；**不通过 UI 通知**、不排队） |
| mode=attach lazy connect 失败 `[v0.0.46]` | **true** | `browser attach 连接失败：<原因>`（chrome 未开 remote debugging / 版本 <144 / 拒绝 prompt / list_pages round-trip 失败；kind='connect_failed'；沿用 `[v0.0.34]` 失败即停不重试） |
| mode=attach 且 HITL 审批被拒 | **true** | 审批拒绝说明 |
| mode=② profile 占用冲突 | **true** | `profile <name> in use` + 提示（不抢锁不排队） |
| mode=③ cdpUrl **非 loopback**（远程私网 / 169.254.169.254 / `file://`）fail-closed | **true** | SSRF 拒绝 |
| mode=③ cdpUrl loopback（127.x / ::1 / localhost） | — | **豁免** SSRF（CDP 控制面，attach 本机 chrome 正常用法）`[v0.0.29 modified]` |
| 其他（chrome 启动失败 / navigate 超时 / ref 不存在等） | **true** | 原因 |

**needsApproval**：`input.mode === 'attach'` → HITL 审批（操作用户真实浏览器）；mode ①② 不审批。

**生命周期语义（对调用方，`[v0.0.46]` lazy connect + disconnect action）**：mode ①② tool 内自启 chrome、自 close（杀进程）；mode ③ 由 ConnectorManager 管理 attach session——**首次调用 tool.run 时 lazy connect**（`connectForToolRun(sessionId)`：switch=on 且未被占用 → spawn chrome-devtools-mcp + list_pages 判据 → 记 owner=sessionId + 缓存 attachSession），**同 owner 后续复用**；LLM 显式 `action='disconnect'` 主动释放 owner + kill MCP 进程（不杀 chrome）；session 结束/agent DELETE 兜底自动 disconnect；**app 启动 bootstrap 只读 intent 不 connect**（不再自动重连、不再弹「有应用要调试」）。

> **[v0.0.23.1] mode①② 内部实现路径（对外契约不变）**：mode①② tool run 内调 `driver.executeOnce`（而非 `connect`）——`NodeWorkerDriver.executeOnce` spawn `node browser-worker.cjs` 子进程，worker 内 spawn chrome + connectOverCDP + dispatch 单个 action + cleanup chrome，stdout 返 `{ok,text?} \| {ok:false,error}`。**绕开 Bun 不支持 playwright connectOverCDP 的 bug**（oven-sh/bun#9357）。**[v0.0.46] mode③ attach 路径**：由 ConnectorManager `connectForToolRun(sessionId)` lazy 触发 ChromeMcpDriver 连接（不再由 bootstrap/toggle 触发），门禁分层三态；`action='disconnect'` 走 `disconnect(sessionId)` 释放。仍是 ChromeMcpDriver 长会话，但触发时机与释放接口重构。对外 schema 变化仅 `action` 枚举加 `disconnect`（见 §4.1）；result 形态全不变。详见 tech `[P1]browser_tool.md` §3/§4/§7。

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

version: 1.2.2 `[v0.0.123 modified]`（1.2.1 → 1.2.2：**web_search Zhipu provider 1→2 + list 语义补账，无 HTTP 契约变更**——§2 内置 Zhipu 从单 implId `zhipu` 拆为 `zhipu_coding_plan`（MCP 订阅额度）/ `zhipu_api`（REST 按量计费）两独立 impl；§2.2 错误分支/`resolveProvider` 从过时的 exclusive `getExclusiveExtension` 改为 v0.0.72 list 单点路由（type 未配置 / impl 未激活 / 不可用三态）；§5 inventory 透传 impls 从单 provider 改两 impl + choice-cards 改下拉（v0.0.121）。GET/PUT `/config/app?group=web_search` 端点/schema/redact 全不变，仅样例 implId 值 + provider 清单。旧 `zhipu` 一次性迁移到 `zhipu_coding_plan` 见 `app_config.md §3.6`。详见 `specs/tech/version_logs/v0.0.123/change_log.md`）。
version: 1.2.1 `[v0.0.89 modified]`（1.2 → 1.2.1：**端点迁移 spec 补账，非行为变更**——web `group` 随 `dev_config` 整体废弃（`/config/dev` 全部方法返 404）整组迁入 `app_config`，本文将 §1 facade 面 / §5 标题+正文 / §5.1 redact-merge 描述 / §9 错误表中所有以现行契约口吻出现的 `/config/dev` 更正为 `/config/app`，「dev_config web group」→「app_config web group」；group/key 名与 jinaApiKey redact/占位 merge 语义**零变更**，仅 entity 从 `dev_config` 改 `app_config`、端点从 `/config/dev` 改 `/config/app`。权威迁移描述见 `03-config-center.md` 头部 v0.0.89 注 + §3.6。此前 08-web-tools 未跟上 v0.0.89 迁移，仍以现行口吻写 `/config/dev`，本次为 spec 补账。）
version: 1.2 `[v0.0.46 modified]`（1.1 → 1.2：**连接器 lazy connect 时机重构** —— HTTP 端点契约本身**零变化**（GET/PUT `/config/connectors` 端点/请求体/响应码全不变），语义调整：§4.1 browser tool `inputSchema.action` 枚举增加 `disconnect`（仅 mode=attach 有效）；§4.2 添加 disconnect result 行；§4.3 attach isError 分支重写为门禁分层三态（`not_enabled` / `in_use_by_other` / `connect_failed`），删除旧「未连接」错误；§4.3 生命周期语义按 lazy connect + disconnect action + owner sessionId 更新；§6.1 `ConnectorState.switch` 语义注释改为 feature flag（与 connection 完全解耦）；§6.2 `PUT enable=true` 只写 intent + UI 态**不再触发 connect**（connect 由 tool.run 首次调 attach lazy 触发）；状态迁移表按 v0.0.46 语义重写；§6.2 保留 202 返回码兼容。详见 `specs/prd/version_logs/v0.0.46.connector_opt/change_log.md` + tech `[P1]connectors.md` v1.2 + `[P1]browser_tool.md` v1.4。）
version: 1.1 `[v0.0.23.1 modified]`（1.0 → 1.1：**纯内部 bugfix，对外 API 契约零变化**——mode①② browser tool 改走 `NodeWorkerDriver.executeOnce`（node worker 子进程）绕开 Bun playwright connectOverCDP bug；mode/schema/result/isError 分支全不变，仅 §4.3 补「mode①② 内部实现路径」说明。增量变更见 `specs/api/version_logs/v0.0.23.1/change_log.md`）。
version: 1.0 `[v0.0.23]`：新建 web_search / web_fetch / browser 三 tool 协议面 + dev_config web group（jinaApiKey secret redact；**v0.0.89 该 group 迁 app_config，端点改 `/config/app`，见 1.2.1**）+ /config/connectors 端点组（双状态机）+ web_search_provider EP inventory 透传。
