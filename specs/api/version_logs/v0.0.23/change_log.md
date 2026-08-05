# v0.0.23 API 变更日志 — Web Tools（web_search / web_fetch / browser）+ 配置 web group + 连接器

> 对应 spec：`specs/api/overall/08-web-tools.md`（新建）+ `03-config-center.md` v1.3（增 `web` group secret redact + 连接器端点组）。
> 权威输入：`specs/prd/version_logs/v0.0.23/change_log.md`（16 条用户路径=API 测试最低覆盖）+ `specs/tech/agent/tools/[P1]web_{search,fetch}_tool.md` + `[P1]browser_tool.md` + `specs/tech/config/[P0]dev_config.md` v2.4 + `[P1]connectors.md` v1.0。
> **本文件是 AT（API Test）web tools / config-web / connector 域的唯一依据**：api-verifier 黑盒 curl，不读代码。

## 概述

v0.0.23 交付 3 个 agent tool（`web_search` / `web_fetch` / `browser`，LLM 可调）+ dev_config `web` group（3 key，复用现有 `/config/dev` 端点）+ 连接器端点组（新增，browser attach 的用户侧门禁）。三个面向：

| 面向 | 内容 |
|------|------|
| **工具协议面**（LLM 调用） | 3 个 tool 的 `ToolDefinition`（name/description/inputSchema）+ 输出 ToolResultBlock 形态（工具调用通过 SSE `tool_*` 事件观察，无独立 HTTP 端点） |
| **HTTP facade 面**（客户端调） | dev_config `web` group（GET/PUT `/config/dev`）+ 连接器端点组（GET/PUT `/config/connectors`，新增） |
| **EP inventory 面** | `web_search_provider`（exclusive, group=web）加入 BUILTIN_EXTENSION_POINTS，经 `/config/plugin` GET inventory 透传 |

---

## 1. Agent 工具协议面（3 个 tool）

工具调用经 `POST /session/:id/messages` 触发 run → LLM 决策 → tool_call → tool_result（详见 `04-agent-session.md` §3.2 + SSE `tool_call` / `tool_result` 事件）。**工具本身无独立 HTTP 端点**——契约是「input schema + 输出 ToolResultBlock 形态」。tool 注册到 `defaultTools()`，按 `definition.name` 路由。

### 1.1 `web_search`

**inputSchema**：

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `query` | string | ✅ | — | 搜索 query |
| `maxResults` | number | — | 10 | 结果数上限（上限由 provider 定） |
| `answer` | boolean | — | false | 是否请求带引用的答案（provider 不支持则忽略） |

**输出 ToolResultBlock**（content 为单个 text block，isError 分支）：

| 分支 | isError | content[0].text 形态 |
|------|---------|---------------------|
| 正常 | false | markdown 序列化：`## Results\n1. **<title>** <url>\n   <snippet>\n   (<publishedDate>?)` × n + 可选 `## Answer\n<answer>`；整段 `wrapExternalContent` 标记 untrusted；超 `WEB_SEARCH_MAX_CHARS`(~100k) 截断 |
| 无 provider 注册 | **true** | `web_search 未配置任何 provider` |
| provider 注册但不可用 | **true** | `provider <label> 不可用（凭证未配置?）`（`isAvailable()` 返 false；如 Zhipu apiKey 未配） |

**provider 解析**：经 `getExclusiveExtension(WebSearchProviderPoint, ctx.config)` 取生效者（exclusive ≤1）。`isAvailable()` **禁止 I/O**（只查内存配置）。

**内置 Zhipu provider**（implId=`zhipu`，label「Zhipu 智谱」）：凭证 apiKey 走 **ext impl configSchema**（不进 dev_config）。响应映射：`title←title` / `url←link` / `snippet←content`（截断） / `publishedDate←publish_date`；无 score、无综合 answer。

### 1.2 `web_fetch`

**inputSchema**：

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `url` | string | ✅ | — | 待抓取 URL |
| `maxChars` | number | — | 100000 | 输出正文截断长度 |

**输出 ToolResultBlock**：

| 分支 | isError | content[0].text |
|------|---------|-----------------|
| 正常 | false | markdown 正文（title + 正文 + 最终 URL 元数据）；整段 `wrapExternalContent` untrusted 包装；截断至 `maxChars` |
| SSRF 拒绝 | **true** | SSRF 校验失败原因（私网/保留段 / file:// / ftp:// / 跨重定向跳内网）—— **不抓取、不发往 jina** |
| 代理失败 | **true** | 代理失败错误（**不静默降级直连**） |
| 全部路线失败 | **true** | jina ∥ 本地静态 ∥ headless 兜底均无充足内容 |

**管线**（对调用方透明）：SSRF 先行 → **并行 race**（路线 A jina reader `r.jina.ai/<url>` ∥ 路线 B 本地 undici + readability，`Promise.any` 取首个 trim 后正文 > ~200 chars 者，不 merge）→ 两路皆空才起 headless chrome 兜底（复用 PlaywrightDriver）→ markdown。

**配置依赖**：`web.jinaEnabled=false` → 跳过路线 A（仅本地静态 + headless 兜底）；`web.jinaApiKey` **有则传**（`Authorization: Bearer`）、**无则不传**（匿名仍可用）；超时 `web.jinaTimeoutMs`。

### 1.3 `browser`

**inputSchema**：

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `mode` | enum `headless` \| `managed-profile` \| `attach` | ✅ | — | chrome 启动/连接模式 |
| `action` | string | ✅ | — | `navigate` \| `snapshot` \| `click` \| `type` \| `listPages` \| `selectPage` \| `evaluate` \| `screenshot` \| `close` |
| `profileName` | string | mode=②③ 时必填 | — | profile 名（持久目录名 / attach 定位）；正则 `/^[a-z0-9][a-z0-9-]*$/` ≤64 |
| `url` | string | `action=navigate` 时必填 | — | 目标 URL |
| `ref` | string | `action=click`/`type` 时必填 | — | element ref（来自 snapshot 输出） |
| `text` | string | `action=type` 时必填 | — | 待输入文本 |
| `cdpUrl` | string | — | — | mode=③ fallback（用户已手动 `--remote-debugging-port`）；远程私网 SSRF fail-closed |

> 完整可选字段（pageId、format、script 等）以 `BrowserSession` 协议为准（见 tech `[P1]browser_tool.md` §2）。

**输出 ToolResultBlock**：

| action | isError=false 时 content[0].text 形态 |
|--------|-------------------------------------|
| `snapshot` | `{ snapshot: string, refs: Record<id,{role,name,nth}> }` 序列化（a11y tree + ref；统一驱动模型） |
| `listPages` | `PageInfo[]`（`{id, url, selected?}`）序列化 |
| `navigate`/`click`/`type`/`selectPage` | 简短结果描述（如 `navigated to <url>`） |
| `evaluate` | script 返值序列化（unknown） |
| `screenshot` | 辅助，{ mime, data(base64) }（可空，作 vision 校验/给 LLM 看长相） |

**isError 分支**：

| 分支 | isError | content[0].text |
|------|---------|-----------------|
| mode=attach 且连接器未 connected | **true** | `browser attach 未连接：请在「连接器 → 浏览器」中开启连接`（不进行 MCP connect） |
| mode=attach 且 HITL 审批被拒 | **true** | 审批拒绝说明 |
| mode=② profile 占用冲突 | **true** | `profile <name> in use` + 提示（不抢锁不排队） |
| mode=③ cdpUrl 私网/远程 fail-closed | **true** | SSRF 拒绝 |
| 其他（chrome 启动失败 / navigate 超时 / ref 不存在等） | **true** | 原因 |

**needsApproval**：`input.mode === 'attach'` → HITL 审批（操作用户真实浏览器）；mode ①② 不审批。

**生命周期语义（对调用方）**：mode ①②（headless/managed-profile）—— tool 内自启 chrome、自 `close`（杀进程）；mode ③（attach）—— **复用** ConnectorManager 已持有的 ChromeMcpDriver session（不重复 connect、不 close；session 跨 tool 调用长存，连接器 toggle off 才断）。

---

## 2. dev_config `web` group（复用 `/config/dev` 端点）

**无新增端点**——复用现有 `GET /config/dev?group=web` + `PUT /config/dev`（见 `03-config-center.md` §2）。新增 group=`web` 的 3 个 key：

| key | 类型 | 默认 | secret | 说明 |
|-----|------|------|--------|------|
| `jinaApiKey` | string | —（无） | ✅ | jina reader API key；web_fetch jina 阶段用，**有则传**（`Authorization: Bearer`）、**无则不传**（匿名受限） |
| `jinaEnabled` | boolean | true | — | false → 跳过路线 A（仅本地静态 + headless 兜底，隐私/airgapped） |
| `jinaTimeoutMs` | number | 20000 | — | jina 调用超时（ms） |

### 2.1 secret redact 语义（`jinaApiKey`，沿用 §3.5 observability secretKey 套路）

- **GET `/config/dev?group=web`**：响应中 `jinaApiKey` 的 `data` **redact 为占位 `"***"`**（其余明文：`jinaEnabled` / `jinaTimeoutMs`）。
- **PUT `/config/dev`**（单 key 或整组提交）：`jinaApiKey` 字段值
  - 等于占位 `"***"`（前端未改）→ 服务端**保留原落盘值**（merge），不写空、不覆盖。
  - 非占位真值（用户重新输入）→ 服务端用新值落盘。

### 2.2 请求/响应示例

```bash
# GET 整组
curl http://127.0.0.1:3710/config/dev?group=web
# → 200 {"items":[
#   {"key":"jinaApiKey","data":"***"},            # redact
#   {"key":"jinaEnabled","data":true},
#   {"key":"jinaTimeoutMs","data":20000}
# ]}

# PUT 整组提交（apiKey 占位 → 保留原值；其余真值）
curl -X PUT http://127.0.0.1:3710/config/dev -H "Content-Type: application/json" -d '{
  "group":"web",
  "items":[
    {"key":"jinaApiKey","data":"***"},
    {"key":"jinaEnabled","data":false},
    {"key":"jinaTimeoutMs","data":30000}
  ]}'
# → 200 {"ok":true}
```

> 记录缺失（如从未配过 jinaApiKey）→ GET 整组响应不含该 key 条目；消费方走代码默认（jinaApiKey 缺省=不传 / jinaEnabled 缺省=true / jinaTimeoutMs 缺省=20000）。

---

## 3. 连接器端点组（新增 — `/config/connectors`）

底层经 `ConnectorManager`（见 tech `[P1]connectors.md` §5）。v0.0.23 仅 `browser` 连接器。**双状态机**（switch 持久化 intent + connection 运行时态）由后端维护，客户端只读 state + 派发 enable/disable。

### 3.1 `GET /config/connectors` — 连接器状态列表

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/config/connectors` | 所有连接器当前实时状态（v0.0.23 仅 browser） | `200` + `{ items: ConnectorState[] }` |

```typescript
interface ConnectorState {
  id: "browser";                                // v0.0.23 仅 browser
  switch: "on" | "off";                         // 实时开关态（on=已连上）；持久化值是 intent
  connection: "disconnected" | "connecting" | "connected" | "error";
  errorDetail?: string;                         // connection=error 时的原因（chrome 未开 / 未开 remote debugging / 版本<144 / 拒绝 prompt）
  lastConnectedAt?: number;                     // 上次 connected 时间戳（iso 或 epoch ms）
}
```

**响应示例**：

```json
{
  "items": [
    { "id": "browser", "switch": "off", "connection": "disconnected" }
  ]
}
```

### 3.2 `PUT /config/connectors/:id` — enable / disable（toggle）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `PUT` | `/config/connectors/:id` | 派发连接器 enable/disable（fire-and-forget，状态迁移异步）；`:id` ∈ {`browser`} | `ToggleConnectorBody` | `202` + `{ ok: true }` |

```typescript
interface ToggleConnectorBody {
  enable: boolean;   // true=toggle on（set intent=on + 持久化 + 触发 connect）；false=toggle off（set intent=off + 持久化 + disconnect）
}
```

**行为**（详见 tech `[P1]connectors.md` §3.2/§5；端点只暴露 HTTP 契约）：

| 触发 | switch 迁移 | connection 迁移 |
|------|------------|-----------------|
| `enable=true`（intent=on） | off（实时）→ on（成功后） | `disconnected/error` → **connecting** → 成功 `connected` / 失败 `error` |
| `enable=true` 成功 | → **on** | → **connected** |
| `enable=true` 失败 | **保持 off** | → **error**（errorDetail 记原因） |
| `enable=false`（intent=off） | → **off** | → **disconnected**（停止 attach，**不杀用户 chrome**） |

**返回语义**：`202 Accepted` = 服务端已接收 toggle 请求、状态异步迁移中。**不 await connect 完成**——调用方通过轮询 `GET /config/connectors`（或 SSE 推送，若有）感知终态。

**幂等**：重复 `enable=true` 在 connecting/connected 时无害；重复 `enable=false` 在 disconnected 时无害。

**错误**：

| HTTP | 触发 |
|------|------|
| `400` | body 非 `{enable:boolean}`；`:id` 非法（非 browser） |
| `404` | `:id` 不存在 |

### 3.3 请求示例

```bash
# 取状态
curl http://127.0.0.1:3710/config/connectors
# → 200 {"items":[{"id":"browser","switch":"off","connection":"disconnected"}]}

# toggle on（fire-and-forget，异步迁移 connecting → connected/error）
curl -X PUT http://127.0.0.1:3710/config/connectors/browser \
  -H "Content-Type: application/json" -d '{"enable":true}'
# → 202 {"ok":true}

# 轮询终态
curl http://127.0.0.1:3710/config/connectors
# → 200 {"items":[{"id":"browser","switch":"on","connection":"connected","lastConnectedAt":"2026-06-25T..."}]}
```

---

## 4. EP inventory 透传（`/config/plugin` GET）

`web_search_provider`（cardinality=`exclusive`, group=`web`）加入 BUILTIN_EXTENSION_POINTS。**无新增端点**——经现有 `GET /config/plugin` inventory 自动透传（见 `03-config-center.md` §3.1）：`tree.groups[]` 出现 group=`web` 分区；ext impl 节点含内置 Zhipu provider（`{pointId:"web_search_provider", implId:"zhipu", type:"exclusive", schemaConfig:{apiKey:{type:"string",secret:true}}, ...}`）。exclusive → UI 渲染单选控件，同 point 内只能选一个 provider（PUT `setExclusive` 选中生效，见 `03-config-center.md` §3.2）。**Zhipu apiKey 凭证经 `/config/plugin` PUT `setImplConfig`** 写入（非 dev_config）；secret redact 同 §2.1 套路。

---

## 5. AT 覆盖映射（PRD 16 条用户路径 → 端点/case）

工具调用（web_search/web_fetch/browser）通过 `POST /session/:id/messages` 触发 run，经 SSE 观察 `tool_call`/`tool_result` 事件断言（无独立端点）；config/connector 经 HTTP 端点直接 curl。

| PRD 路径 | AT 触发与断言 |
|---------|--------------|
| A：Zhipu 真服务 | 配 ext impl apiKey → 触发 web_search → SSE 断言 tool_result 含 title/url/snippet + untrusted 包装 + isError=false |
| A0：无 provider | setExclusive 取消选中 → 触发 → 断言 isError=true「未配置任何 provider」 |
| A2：provider 不可用 | ext impl apiKey 清空 → 触发 → 断言 isError=true「不可用（凭证未配置?）」 |
| B：并行 race | 设 HTTP_PROXY → 触发 web_fetch 公网 URL → 断言 isError=false + 正文 markdown + untrusted 包装 |
| B0：jina 无 key | web.jinaApiKey 未配 → 触发 → 断言仍返正文（jina 匿名参与 race） |
| B2：headless 兜底 | 重度 JS URL（A/B 皆空）→ 断言 headless 兜底返正文 |
| C：SSRF 拒绝 | web_fetch 内网 IP / file:// → 断言 isError=true（不抓取不发往 jina） |
| C2：重定向剥凭证 | 公网 URL 3xx 跳跨 origin → 断言后续请求无 Authorization/Cookie；跳内网拒 |
| D：headless | browser mode=headless navigate → snapshot → 断言含 snapshot + refs |
| E：profile 登录态 | managed-profile 登录 → close → 同 profile 再 navigate → 断言登录态保留 |
| E2：占用冲突 | 两并发同 profileName → 断言后者 isError=true「profile X in use」 |
| F：attach（connected） | PUT connectors/browser enable=true → connected → 触发 attach listPages → HITL 批准 → 断言列 tab + 不杀浏览器 |
| G：cdpUrl SSRF | attach cdpUrl=私网/远程 → 断言 isError=true SSRF fail-closed |
| H：toggle 成功 | PUT enable=true → 轮询 GET → 断言 connecting → connected + switch=on |
| I：toggle 失败 | chrome 未开 remote debugging → 断言 switch off + connection=error + errorDetail |
| J：重启重连 | 持久化 intent=on → 重启 server → GET 断言启动 off + connecting 自动 reconnect |
| K：attach 门禁 | 连接器未 connected → 触发 attach → 断言 isError=true「未连接...请开启连接」 |

> 实际 case 文件由 `states/v0.0.23/verify/test-plan.md` + `tests/api/web_*/` + `tests/api/connector_*/` 确定。

---

## 6. 错误码汇总（本版本新增/涉及）

| HTTP | 端点 | 触发 |
|------|------|------|
| `400` | `PUT /config/connectors/:id` | body 非 `{enable:boolean}`；`:id` 非法 |
| `404` | `PUT /config/connectors/:id` | `:id` 不存在 |
| `400/404` | `/config/dev`、`/config/plugin` | 沿用 `03-config-center.md` §2.3/§3.3 |

## 7. 文件变更清单（planner/coder 依据）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/router.ts` | 修改 | 新增 `/config/connectors`（GET）+ `/config/connectors/:id`（PUT）路由 |
| `app/server/src/handlers/config.ts` | 修改 | DevConfigHandler 增 `web` group 序列化（jinaApiKey secret redact 出参 / 占位 merge 入参，复用 §3.5）；新增 ConnectorHandler（get 列表 / put toggle 调 ConnectorManager） |
| `app/server/src/config/dev-config-service.ts` | 修改 | `web` group 三 key 注册（jinaApiKey 标 secret）；setGroup 复用现有 |
| `app/server/src/connector/connector-manager.ts` | 新增 | ConnectorManager（getState/getAll/isReady/enable/disable/bootstrap）+ 双状态机 + 持久化 intent |
| `app/server/src/connector/connector-config.ts` | 新增 | `connector_config` entity（KV by id，field `enabled`=intent）持久化读写 |
| `app/server/src/plugin/extension-point.ts` | 修改 | BUILTIN_EXTENSION_POINTS 加 WebSearchProviderPoint（id=`web_search_provider`, exclusive, group=`web`） |
| `app/server/src/plugin/tools/web-search-tool.ts` | 新增 | web_search Tool（definition + run：getExclusiveExtension → provider.search → markdown + isError 分支） |
| `app/server/src/plugin/tools/web-fetch-tool.ts` | 新增 | web_fetch Tool（definition + run：SSRF → 并行 race jina∥本地静态 → headless 兜底 → wrapExternalContent + 截断） |
| `app/server/src/plugin/tools/browser-tool.ts` | 新增 | browser Tool（definition + run：按 mode 选 driver + attach 门禁 + needsApproval=attach） |
| `app/server/src/plugin/providers/zhipu-web-search-provider.ts` | 新增 | Zhipu provider（WebSearchProvider impl，POST open.bigmodel.cn/api/paas/v4/web_search，apiKey 走 ext impl config，响应映射） |
| `app/server/src/plugin/drivers/playwright-driver.ts` | 新增 | PlaywrightDriver（mode ①②：chrome 发现 + launch + connectOverCdp + SingletonLock） |
| `app/server/src/plugin/drivers/chrome-mcp-driver.ts` | 新增 | ChromeMcpDriver（mode ③：spawn chrome-devtools-mcp --autoConnect + MCP tool 映射） |
| `app/server/src/plugin/drivers/browser-session.ts` | 新增 | BrowserSession 协议抽象 + 各 driver 实现 |
| `app/server/src/registry.ts` | 修改 | defaultTools() 注册 web_search / web_fetch / browser |
| `app/web/src/lib/api-client.ts` | 修改 | 加 getConnectors() / toggleConnector(id, enable)；getConfigDev(group) 类型补 web group |
| `app/web/src/slices/connector-slice.ts` | 新增 | 连接器页 state（轮询 GET + toggle dispatch） |

---

## 8. 版本

version: v0.0.23（web tools 三件套工具协议面（web_search/web_fetch/browser）+ dev_config web group（jinaApiKey secret redact）+ 连接器端点组（GET/PUT /config/connectors）+ web_search_provider EP inventory 透传）。
