# Config Center HTTP API（v0.0.5 配置中心 — config 端点域）

> version: 1.12.0 · 引入版本 v0.0.5 · 2026-07-26（1.11.0→1.12.0：**[v0.0.205.t2_cons]** §2.7 `GET /consolidation/status` 响应加 `status`/`startedAt`（非破坏性新增字段，源自 AppTaskLock 内存态，done 归 idle）——修前端整理 tab 切走切回按钮可点 UX bug；配套 AppTaskLock 1h 超时接管（非 API 面）。1.10.0→1.11.0：**[v0.0.179.plugin_config]** plugin scope 配置模型简化——YAML 配置层废 `selected`/`enabled`/`exclusivePicks`/delta merge，改 impl 列表模型（EP 节点不出现=继承 default 全量、出现=全量替换；membership=active，数组序=order）。**GET inventory 形状零变更**（破坏性=0），仅 `ExtImplNode.enabled`/`selected` 派生源切换：`enabled` 改从 membership 派生（在 impls 列表=true，不再 `?? true` 兜底）、`selected` 改从「exclusive EP active 中 order 最小者」派生（不再读 `exclusivePicks`）。PUT 仍 405。影响 §3/§3.1/§3.4.3；向后兼容分析 + YAML 模型详 `specs/api/version_logs/v0.0.179.md`。1.9.0→1.10.0：**[v0.0.164.memory_opt]** 新增 `POST /consolidation/run` 端点（手动触发 tier2 整理，fire-and-forget 语义，202/409 响应，`AppTaskLock` 跨触发源撞车互斥；详见 §2.8）——覆盖 v0.0.151.t2_consolidate 「PRD 排除手动触发」旧口径。影响 §2 顶部摘要 + 新增 §2.8。1.8.3→1.9.0：**[v0.0.151.t2_consolidate]** 新增 `consolidation` app_config group（`GET/PUT /config/app?group=consolidation`，走既有通用 `/config/app` 三栏化路径，无新增 GET/PUT 端点，详见 §2.6）+ 新增只读端点 `GET /consolidation/status`（天级二级整理任务的轻量可见性：上次执行时间 + 一句话摘要，详见 §2.7）。影响 §2 顶部摘要 + 新增 §2.6/§2.7。1.8.2→1.8.3：**[v0.0.135]** `web.jinaApiKey` GET 由 redact `"***"` 改**明文返回**——与 §3.5 observability secretKey 统一套路（mask 收敛前端 `SecretInput`）；PUT 占位 `"***"` merge 入参保留（向后兼容旧前端，幂等无害）。后端 `redactWebSecret` / `ChannelConfigService.redact()` / `redactChannelSecret` 已删（dead code）。影响 §2 顶部摘要 + §3.6。1.8.2：**[v0.0.123]** web_search group data schema 样例 implId 从 `zhipu` 更新为 `zhipu_coding_plan`/`zhipu_api` 两 impl（GET/PUT `/config/app?group=web_search` 端点/schema/redact **全不变**，仅样例值 + credentials 清单；旧 `zhipu` 一次性迁移到 `zhipu_coding_plan`，见 `app_config.md §3.6`）。1.8.1：dev_config spec 文件删除后的引用补账——§1/§2 `DevConfigService`/`/config/dev` 现行口吻改历史迁移参考口吻，指向已删 `[P0]dev_config.md` 的 schema 指针（§3.4/§3.4.1/§7）改指 `[P0]app_config.md §3.9/§3.14`；行为无变更，端点契约不动）
> 管什么：v0.0.5 配置中心重构涉及的 `/config` 域 HTTP 端点契约（路径 / 方法 / 请求 / 响应 / 错误）—— `/config/app` / `/config/dev`（app + dev KV 三栏化整组保存；**v0.0.89 `/config/dev` 全废弃**）+ `/config/plugin`（plugin tab + 扩展点 tab + ext impl type/schemaConfig，**v0.0.67 起只读**）。**v0.0.23 新增 `/config/connectors` 端点组**（连接器，详见 §3.6 + `08-web-tools.md`）。
> 不管什么：`/chat` SSE 流式（→ `02-llm-chat.md` §3）；`/provider` + `/provider/:id/model` CRUD（→ `02-llm-chat.md` §5，v0.0.5 完全不变）；渲染层 UI（→ `specs/ui/overall/03-config-center.md` + `specs/ui/components/`）；web tools 工具协议面 + web_search_provider EP（→ `08-web-tools.md`）。
> **本文件是 AT（API Test）config 域的唯一依据**：api-verifier 黑盒 curl，不读代码。
>
> **[v0.0.89 modified — dev_config 废弃 + app_config 扩组 + default_models 新增 + appearance 合并 locale]**：
> 1. **`/config/dev` 全部方法废弃（返 404）**：`GET/PUT/DELETE /config/dev` 整段路由删；所有原 dev group（agent/context/runtime/web/sub_agent_templates/logs/observability）整组迁入 `app_config`，改走 `/config/app?group=<group>`。**sub_agent_templates DELETE/PUT 专用路由** `/config/dev/sub_agent_templates` → `/config/app/sub_agent_templates`（详 `10-multi-agent.md §5`）。
> 2. **新增 `default_models` group**（playground 专属全局默认模型）：`GET/PUT /config/app?group=default_models`（key 固定 `"default"`，data = `{chat?, summary?}` ModelRef；详见 §2.5）。
> 3. **`appearance` group 合并 `locale`**：原 `?group=locale&key=language` → `?group=appearance&key=language`（与 theme 同组）；PUT 走 read-modify-write 含 theme+language 两 key。
> 4. **secret 处理**：group/key 名零变更（仅 entity 名 dev_config→app_config）。web.jinaApiKey `[v0.0.135]` 起 **GET 返回明文**（mask 收敛前端，与 observability 一致），PUT 占位 `"***"` merge 入参保留；observability.secretKey 自 `[v0.0.119.bugs2]` 起 **GET 返回明文**（mask 收敛前端），PUT 占位 `"***"` merge 入参保留（详 §3.5/§3.6）。
>
> **拆分说明**：v0.0.5 起从 `02-llm-chat.md` §4 拆出，避免单文件超 300 行。chat/provider/model 端点契约仍见 `02-llm-chat.md`；本文件承载 `/config/{app,dev,plugin,connectors}` 四域。
>
> **[v0.0.67 modified — plugin config 只读化]**：plugin config 全面重构——所有 enabled/order/exclusivePick/activatedPoints 配置迁代码声明 `app/plugins/scopes/*.json`（唯一源），落盘 `plugin_policy/` deprecated。**`PUT /config/plugin` 写端点删**（实测返 405 Method Not Allowed）；**scope 写端点（POST/DELETE scope + activate/deactivate）删**（实测返 405）；**GET inventory + GET scope list + GET activation list 保留**（数据源 = ScopeConfigProvider）。GET inventory 响应新增 `selected` 派生字段语义明确（exclusive EP 选中标记，来自代码声明 `exclusivePicks`）。详见 §3.1/§3.2/§3.4。权威 spec：`specs/tech/config/[P0]plugin_config_service.md §2/§4`（v0.0.67 起只读）+ `specs/tech/plugin_system/[P1]scopes_config_decl.md`（代码声明机制）+ `specs/tech/version_logs/v0.0.67/change_log.md`。
>
> **拆分说明**：v0.0.5 起从 `02-llm-chat.md` §4 拆出，避免单文件超 300 行。chat/provider/model 端点契约仍见 `02-llm-chat.md`；本文件承载 `/config/{app,dev,plugin,connectors}` 四域。
>
> **[v0.0.18 modified]**：`/config/plugin` 两项增量：(1) PUT 新增 `setPointOrders` op（整 ext point 组批量保存 order，根治拖拽 bug，替代单条 `setOrder`）；(2) GET 响应 ext impl 节点新增三级 description 透传字段（`description`/`pointDescription`/`pluginDescription`）。详见 §3.1/§3.2。
>
> **[v0.0.25 modified]**：新增 §2.4 `GET/PUT /config/app/llm_request`（llm_request config group 读写端点，调优参数 timeout/retry/degradation/length/fallback_chain，不配=默认，详见 §2.4）。
>
> **[v0.0.23 modified]**：`/config/dev` 新增 `web` group（jinaApiKey secret redact，§3.6）+ 新增 `/config/connectors` 端点组（GET 列表 + PUT toggle，双状态机，§3.6）。web tools 三件套工具协议面 + web_search_provider EP 见 `08-web-tools.md`。
>
> **[v0.0.26 modified]**：`/config/plugin` 引入 `scope` 维度（ext-impl 配置层正交维度，agent loop 风格）。新增 scope CRUD 端点组 + per-EP 激活端点组（§3.4.1/§3.4.2）；GET `/config/plugin` 加 `?scopeId` query + 响应增量字段 `scope`/`scopes`/`points[].activated`/`extImpls[].pointActivated`（§3.4.3）；PUT 现有 impl 级 op 加 `scopeId?` 字段（缺省 default 向后兼容）+ 写未激活 EP 自动激活（D4，§3.4.4）。权威 spec：`specs/tech/config/[P0]ext_impl_scope.md`（D1-D6 决策）。

## 1. 概述

config 各域端点，统一 `GET`（取）+ `PUT`（写）。底经 `AppConfigService` / `PluginConfigService`（见 `specs/tech/config/[P0]app_config.md` §5 / `[P0]plugin_config_service.md` §2）。**`/config/dev` 域自 v0.0.89 起整段废弃（返 404）**——原 dev group 全迁 app_config，走 `/config/app?group=<group>`；下文历史章节中的 `/config/dev` 描述仅作迁移参考。

**v0.0.5 三项增量**（仅 `/config` 域；`/chat` `/provider` `/provider/:id/model` 完全不变）：
1. `/config/app` `/config/dev` PUT 新增「整组提交」body 形态（`{group, items[]}`，原子提交该 group 全部 key），单 key PUT 向后兼容。
2. `/config/plugin` GET 响应：ext impl 节点 `cardinality` → **`type`**；新增顶层 `plugins[]`（plugin-centric 平面，给插件 tab UI 用）；ext impl 节点新增 `schemaConfig?`（per-key UI schema）。
3. `/config/plugin` PUT `setImplConfig` 语义澄清：参数仍 `{op, implId, values}`（implId 单参全局唯一），values 是**稀疏 delta**（用户改过的 key，未含 key 按默认）。op 集合 v0.0.5 与 v0.0.4 完全一致，无新 op。

一句话：**v0.0.5 config center = `/config/app` `/config/dev` PUT 整组提交 + `/config/plugin` GET（type + plugins[] + schemaConfig）+ PUT（稀疏 delta）**。

## 2. `/config/app` / `/config/dev`（app + dev KV，三栏化 + 整组保存）

底层经 `AppConfigService`（通用 KV `(group, key) → data`，按 group 分片落盘）。**注（v0.0.89）**：`/config/dev` 已废弃（返 404）；下方保留其历史端点形状描述作迁移参考——形状与 `/config/app` 完全一致（v0.0.89 前差异仅数据归属 entity `dev_config`），迁移后全部 group 走 `/config/app`。

### 2.1 `GET /config/app` / `GET /config/dev`

- 查询参数：`?group=<g>&key=<k>`（取单值）；`?group=<g>`（取整组，返回该组所有 record 的 data 列表）。
- 响应：`200` · `{ "value": <data> }`（单值，记录缺失则 `value: null`）；整组 `{ "items": [{ "key": "...", "data": <data> }, ...] }`。

> **[v0.0.72] `web_search` group 契约**：`GET /config/app?group=web_search&key=default` 取单值；`PUT /config/app { "group":"web_search", "items":[{"key":"default", "data": <WebSearchConfig>}] }` 整组提交（key 固定 `"default"`，单实例）。data schema：
> ```json
> { "type": "zhipu_coding_plan", "credentials": { "zhipu_coding_plan": { "apiKey": "<secret>" }, "zhipu_api": { "apiKey": "<secret>" } } }
> ```
> - `type`：选中 provider implId（snake_case，与 `web_search_provider` ext impl implId 对应）；缺失 = type 未配置 → web_search tool 返 ToolError。
> - `credentials`：`map<implId, {apiKey?: string}>`，按 type 选中动态展示。**[v0.0.123]** 内置 2 个 impl `zhipu_coding_plan`（MCP 订阅额度）/ `zhipu_api`（REST 按量计费），各一 `apiKey`（secret）；旧 implId `zhipu` 一次性迁移到 `zhipu_coding_plan`（见 `app_config.md §3.6`）。
> - 技术权威：`specs/tech/config/[P0]app_config.md §3.6`；UI：`specs/ui/components/app-dev-config-page/section-web-search-config/_overview.md`；tool 路由：`specs/tech/agent/tools/[P1]web_search_tool.md §4`。

### 2.2 `PUT /config/app` / `PUT /config/dev`

**单 key PUT**（v0.0.3 以来，向后兼容）：请求体 `{ "group": "<g>", "key": "<k>", "data": <data> }`。

**整组提交 PUT** `[v0.0.5]`：请求体 `{ "group": "<g>", "items": [{ "key": "<k>", "data": <data> }, ...] }`——原子提交该 group 全部 key（同 group 内全成功/全失败，**其他 group record 完全不读不写**）。供 UI「保存该 group」用（PRD §3.9.2 三栏 + group 独立保存；`specs/ui/components/app-dev-config-page/component-group-save-bar.md`）。

- 响应：`200` · `{ "ok": true }`。

v0.0.3 / v0.0.5 用法对比：
- `PUT /config/app` `{ "group": "appearance", "key": "theme", "data": "dark" }` → 切 theme（单 key）。
- `GET /config/app?group=providers` → 取所有 provider 实例（整组列表）。
- `PUT /config/app` `[v0.0.5]` `{ "group": "appearance", "items": [{ "key": "theme", "data": "dark" }, { "key": "density", "data": "compact" }] }` → 整组提交 appearance（原子）。
- `PUT /config/dev` `{ "group": "llm_request", "key": "stall_timeout_s", "data": 30 }`（单 key）。
- `PUT /config/dev` `[v0.0.5]` `{ "group": "llm_request", "items": [{ "key": "stall_timeout_s", "data": 45 }, { "key": "max_retry_times", "data": 3 }] }`（整组提交）。

> 迁入的调参组（agent/context/logs）record 缺失即未配置，消费方走 `?? CODE_DEFAULT`（见 `specs/tech/config/[P0]app_config.md §3.14`）。
> **provider/model 统一 A**：provider/model 实例数据归 app_config providers group（数据归属不变）；`/provider` `/provider/:id/model` 端点契约 v0.0.5 完全不变（见 `02-llm-chat.md` §5），与 `/config/app` 整组提交并行存在，互不影响。

### 2.3 错误响应（`/config/app` `/config/dev`）

| HTTP status | 触发条件 | 响应体 |
|---|---|---|
| `400` | PUT 缺字段；group/key 非法 | `{ "error": "<原因>" }` |
| `404` | GET 单值时 group 不存在；**[v0.0.89] `/config/dev` 全部方法返 404**（路由整段删，所有原 dev group 迁入 `/config/app`） | `{ "error": "Not Found" }` |

> **[v0.0.89] `/config/dev` 全废弃**：原 v0.0.5 引入的 `/config/dev` GET/PUT/DELETE 端点整段删（返 404）。所有原 dev group（agent/context/runtime/web/sub_agent_templates/logs/observability）整组迁入 `app_config`，改走 `/config/app?group=<group>`（group/key 名零变更）。**sub_agent_templates 专用 DELETE/PUT** 改路径 `/config/app/sub_agent_templates`（详 `10-multi-agent.md §5.2/§5.3`）。**前端旧 `?group=locale` 改 `?group=appearance&key=language`**（locale 合并入 appearance）。

## 2.4 `GET/PUT /config/app/llm_request`（llm_request group 读写，v0.0.25 新增）

按既有 `/config/app` group 模式（§2），新增 `llm_request` group 的读写端点。底经 `AppConfigService`（`specs/tech/config/[P0]app_config.md §3.4`）；schema 完整定义见 `specs/tech/agent/llm_caller/[P0]llm_request_config.md §1`。

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `GET` | `/config/app/llm_request` | 取 llm_request config 整组 | 无 | `200` + `LlmRequestConfig`（record 不存在返回 `DEFAULT_LLM_REQUEST_CONFIG`） |
| `PUT` | `/config/app/llm_request` | 整组替换 llm_request config | `LlmRequestConfig` | `200` + `{ "ok": true }` |

**GET 响应 / PUT 请求体结构**（`LlmRequestConfig`）：

```json
{
  "timeout":     { "ttfb_s":45, "stall_answer_s":30, "stall_think_s":30, "stall_tool_s":120, "wall_max_s":600 },
  "retry":       { "max_attempts":3, "backoff_base_s":2, "backoff_cap_s":30, "jitter":true },
  "degradation": { "cooldown_s":300, "consecutive_to_degrade":3, "respect_retry_after":true },
  "length":      { "auto_compress":true, "precompress_threshold_ratio":0.8, "max_tokens_bump_strategy":"continue" },
  "fallback_chain": []
}
```

- 配了按配置走（如 PUT 改 `retry.max_attempts=5` → 后续 LLM 调用 retry 5 次）；不配走默认值（`llm_request` group 缺省回退默认，语义不同于 `providers` group 的权威值——调优参数不配应能用默认）。
- `fallback_chain[]` 每项形如 `{ providerId, keyRef, modelId }`（`keyRef` 对应 provider `credentials.keys[]` 的一项；空数组 = 不降级）。

## 2.5 `GET/PUT /config/app?group=default_models`（default_models group，v0.0.89 新增）

按既有 `/config/app` group 模式（§2），新增 `default_models` group 的读写端点。底经 `AppConfigService`（`specs/tech/config/[P0]app_config.md §3.7`）；**playground 专属全局默认模型**——`resolveModel` fallback 链第 1/2 行读此 group（详 `specs/tech/agent/providers_and_models/[P0]model_resolve.md §3`）。

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `GET` | `/config/app?group=default_models` | 取 default_models 整组 | 无 | `200` + `{ "items": [{ "key": "default", "data": { "chat"?, "summary"? } }] }` |
| `GET` | `/config/app?group=default_models&key=default` | 取单值 | 无 | `200` + `{ "value": { "chat"?, "summary"? } }`（不存在返 `value: null`） |
| `PUT` | `/config/app` body `{ "group": "default_models", "items": [{ "key": "default", "data": <DefaultModelsConfig> }] }` | 整组提交（key 固定 `"default"`，单实例） | `DefaultModelsConfig` | `200` + `{ "ok": true }` |

**`DefaultModelsConfig`**：

```json
{
  "chat": "gpt-4o",
  "summary": "gpt-4o-mini"
}
```

- **`data.chat`**：playground 默认会话模型 ModelRef（纯 modelId string，不含 providerId）。
- **`data.summary`**：playground 默认整理模型 ModelRef。
- **两 key 均 optional**：缺失（`undefined`）= 该任务未配默认模型 → `resolveModel` fallback 链跳过继续（不抛错；链跑空才抛 `MODEL_NOT_CONFIGURED`）。
- **playground 专属**：studio session（squad/leader/mate）**完全不读此 group**（resolveModel fallback 链第 3-6 行不读 default_models）。
- **PUT 整组提交**：原子写 `default_models/default` record（key 固定 `"default"`，单实例）。
- **UI**：「应用设置 → 模型 tab → playground 默认模型 group」走 `KeyModelPicker`（详 `specs/ui/components/app-dev-config-page/section-default-models-and-request.md`）；x 清除写 `undefined`（删字段不删 record）。

**错误响应**：同 §2.3（`400` body 非法 / 缺字段）。

> 与 §2 `/config/app` `/config/dev` 整组提交 PUT 的差异：llm_request 是单组读写（无 `items[]` 形态），直接整体替换 `LlmRequestConfig`。沿用 `/config/app?group=llm_request` 单 key GET 的等价语义，但给独立路径方便 UI 配置中心独立 tab 拉取。

## 2.6 `GET/PUT /config/app?group=consolidation`（consolidation group，v0.0.151.t2_consolidate 新增）

按既有 `/config/app` group 模式（§2，与 §2.5 default_models 同构），**复用现有通用端点，无新增路由**。底经 `AppConfigService`（`specs/tech/config/[P0]app_config.md §3.16`）；**二级整理（tier2）天级任务的用户配置**——是否启用 + 每天触发时刻 + 使用的模型（详见 `specs/tech/agent/memory/[P0]consolidation_tier2.md` + `specs/tech/scheduling/[P1]consolidation_job.md`）。

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `GET` | `/config/app?group=consolidation` | 取 consolidation 整组 | 无 | `200` + `{ "items": [{ "key": "default", "data": { "enabled", "dailyTime", "modelId"? } }] }` |
| `GET` | `/config/app?group=consolidation&key=default` | 取单值 | 无 | `200` + `{ "value": { "enabled", "dailyTime", "modelId"? } }`（不存在返 `value: null`） |
| `PUT` | `/config/app` body `{ "group": "consolidation", "items": [{ "key": "default", "data": <ConsolidationConfig> }] }` | 整组提交（key 固定 `"default"`，单实例） | `ConsolidationConfig` | `200` + `{ "ok": true }` |

**`ConsolidationConfig`**：

```json
{
  "enabled": false,
  "dailyTime": "04:00",
  "modelId": null
}
```

- **`data.enabled`**：是否启用天级整理任务，默认 `false`。
- **`data.dailyTime`**：每天触发时刻（`"HH:mm"`，服务器本地时区），默认 `"04:00"`。
- **`data.modelId`**：整理 agent 使用的模型 ModelRef（纯 modelId string），可选/未设置。未设置或反查不到可用 provider → 任务到点 fast finish（非错误，见 `consolidation_tier2.md §5.4`）。
- **record 缺失语义**：视为 `{enabled:false, dailyTime:'04:00', modelId:undefined}`（等价禁用，boot 不注册调度 job）。
- **改动不热重载**：本组 PUT 成功后，运行中进程的调度 job **不会**立即 register/unregister/reschedule——需重启应用后由 boot 装配读取最新值生效（对齐 §3.9 observability 既定"重启生效"语义，详见 `specs/tech/scheduling/[P1]consolidation_job.md §3`）。
- **与执行状态分离**：本组 PUT **不会**、也不应该携带 `lastFiredAt`/执行摘要——那部分只读，走 §2.7 独立端点（存储层面分离，详见 `[P1]consolidation_job.md §2.1`）。

**错误响应**：同 §2.3（`400` body 非法 / 缺字段）。

## 2.7 `GET /consolidation/status`（整理任务轻量可见性，只读，v0.0.151.t2_consolidate 新增；**[v0.0.205.t2_cons] 加 status/startedAt**）

**新增 HTTP 端点**（本版本唯一真正新增的路由；§2.6 复用既有通用路径）。返回二级整理任务"上次执行时间 + 一句话摘要"，供设置页整理 tab 展示（`section-consolidation-config.md` 只读区块）。底经 `ConsolidationPersistenceAdapter`（`specs/tech/scheduling/[P1]consolidation_job.md §2.1`），与 §2.6 的用户配置完全独立存储。**[v0.0.205.t2_cons]** 响应加 `status` + `startedAt` 两字段（源自 `AppTaskLock` 内存态，`specs/tech/agent/session/[P0]app_task_lock.md §3.1` 超时接管）——前端 onInit 据此初始化 running 态（修切走切回按钮可点 UX bug）。

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `GET` | `/consolidation/status` | 取上次整理执行状态 + 当前任务状态 | 无 | `200` + `{ "lastRunAt": string \| null, "summary": string \| null, "status": "running" \| "idle" \| "failed", "startedAt": string \| null }` |

```json
{
  "lastRunAt": "2026-07-15T04:00:03.211Z",
  "summary": "全局 skill 归档 2 条 / memory 无变化 / 3 个 session 已整理",
  "status": "idle",
  "startedAt": null
}
```

- **`status` 三态**（v0.0.205.t2_cons 新增）：`'running'` = 整理进行中（AppTaskLock 持锁）；`'failed'` = 上次执行失败（lock 处于 failed 态）；`'idle'` = 无在跑任务（lock 的 done 态归 idle——完成态由 `lastRunAt`/`summary` 承载）。
- **`startedAt`**（v0.0.205.t2_cons 新增）：当前 running 任务的启动时刻 ISO；非 running → `null`。
- **从未执行过**（job 未注册，或注册后从未到点触发过）→ `200` + `{ "lastRunAt": null, "summary": null, "status": "idle", "startedAt": null }`（不是 404——"没有历史"是合法状态，不是错误）。
- **不需要鉴权 body / query 参数**：单例 app 级状态，无 per-session/per-squad 维度。
- **只读**：无对应 PUT。手动触发走 §2.8 独立端点（v0.0.164 新增，覆盖 v0.0.151.t2_consolidate 「PRD 排除手动触发」的旧口径）。
- **错误响应**：仅 `500`（读状态文件本身异常，理论上应极少发生）。

## 2.8 `POST /consolidation/run`（手动触发整理，fire-and-forget，v0.0.164 新增）

**新增 HTTP 端点**（本版本唯一新增路由）。设置页「立即整理」按钮点击时调用，绕过 cron 到点等待、立即触发一轮 tier2 整理。**fire-and-forget 语义**——立即返 202 + 后台 spawn runner，前端靠 §2.7 GET 端点 + SSE `app_task` topic 双通道感知完成态。

底层复用 §2.7 同一 `ConsolidationPersistenceAdapter`（写 `lastResult`）+ **`AppTaskLock`**（`specs/tech/agent/session/[P0]app_task_lock.md`，acquire/markDone/markFailed），确保与 cron `ConsolidationJobHandler.fire()` 之间**跨触发源撞车互斥**（同 taskType `'tier2_consolidation'` 同时只能一个在跑）。

| 方法 | 路径 | 语义 | 请求体 | 响应 |
|------|------|------|--------|------|
| `POST` | `/consolidation/run` | 手动触发一轮整理 | 无 | `202` + `{ "ok": true, "runId": "manual:<ulid>" }` <br/> **或** `409` + `{ "error": "consolidation_in_progress" }`（锁被占：另一次 cron 或手动正在跑） |

- **fire-and-forget**：response 立即返回（不 await runner），后台 `runConsolidationTier2(deps).then(markDone).catch(markFailed)` 跑到完成后写 `lastResult` + emit `consolidation_task_update` SSE 事件。
- **runId 契约**：手动触发固定前缀 `manual:<ulid>`（对应 cron 触发 = `cron:<iso>`），供 SSE 事件 `data.runId` 观测/区分来源。
- **无鉴权 body / query 参数**：app 级单实例任务，触发者无维度。
- **不受 `app_config.consolidation.enabled` 影响**：即便 `enabled=false`（cron job 未注册），手动路径仍可触发（用户明确点击=允许一次跑）。skip 判定（模型未配置 / 无新对话）仍在 `runConsolidationTier2` 内部生效，fast-finish 记录 skip 摘要即完成。
- **不动 cron `lastFiredAt`**：手动触发不通过 `SchedulerEngine.fire()`，不推进 job 的 `lastFiredAt`（保 cron at-most-once 续接锚点独立性）。
- **错误响应**：`405`（method != POST）/ `409`（`AppTaskLock.acquire` 失败=锁被占）/ `500`（内部启动失败，罕见）。
- **SSE 通知**：`app_task` topic 广播 group `_all`，事件 `consolidation_task_update`，见 `specs/tech/agent/session/[P0]session_event.md §3b`。

## 3. `/config/plugin`（plugin tab + 扩展点 tab，inventory + ops，v0.0.67 起只读）

底层经 `PluginConfigService`（见 `specs/tech/config/[P0]plugin_config_service.md` §2，**v0.0.67 起只读**）。inventory 全量树来自 registry 代码 + 代码声明 `scopes/*.yaml` JOIN（v0.0.67 D2 替代落盘稀疏 delta），缺声明处填代码默认。

> **[v0.0.67] 数据源切换**：v0.0.66 前来自落盘 `plugin_policy/{kind}/<id>.json` 稀疏 delta；v0.0.67 起来自代码声明 `app/plugins/scopes/<scopeId>.yaml`（每 scope 一文件）。落盘 record 仅 lazy migrate 兼容，运行时不读。
>
> **[v0.0.179] YAML 配置层 = impl 列表模型（全量列表，无 delta merge）**：`scopes/*.yaml` 每个 EP 节点的 impls 数组 = 该 scope 该 EP 的**完整 active 列表**——EP 节点不出现 = 继承 default 全量；出现 = 全量替换（零 delta）。在数组 = active（membership，无 `enabled` 字段、无 `?? true` 兜底）；数组序 = order；exclusive EP 数组恰好 1 项（validator 启动校验，无 `selected`/`exclusivePicks` 字段）。详见 `specs/tech/plugin_system/[P1]scopes_config_decl.md` + `specs/api/version_logs/v0.0.179.md`。

### 3.1 `GET /config/plugin`

- 响应：`200` · `{ "tree": PluginInventoryTree }`（形状见 `specs/tech/config/[P0]plugin_config_service.md` §2 `PluginInventoryTree`）。

> **`[v0.0.71 modified]`**：`tree.groups[]` 由扁平 `extImpls[]`（impl 跨 point 聚合）改嵌套 `points[].impls[]`（破坏性 schema 变更）；`ExtImplNode` 删 `schemaConfig?`（D7）+ 新增 `configSchema?` 透传 manifest（单一 schema 源）+ 删 `pointActivated`（信息上提到 `points[].activated`）+ `config` 始终 = JOIN(manifest default ⊕ scope configValues)（bug-A 修复）。group 顺序改按 `app/plugins/groups.json` 声明序（D1 删 `ExtensionPoint.group` 字段，7 group 各含 extPoints[]）。下方 `extImpls[]` 示例为 v0.0.67 前形状，v0.0.71 起改嵌套 `points[].impls[]`（详 `specs/api/version_logs/v0.0.71.md` AFTER 形状）。

**`[v0.0.4]` group-centric 结构** + **`[v0.0.5]` 三项增量**：

```json
{
  "tree": {
    "plugins": [
      { "pluginId": "anthropic_provider_plugin", "label": "Anthropic Provider", "description": "Anthropic LLM provider", "enabled": true },
      { "pluginId": "anthropic_protocol_plugin", "label": "Anthropic Protocol", "description": "Anthropic Messages protocol", "enabled": true }
    ],
    "groups": [
      {
        "groupId": "provider",
        "extImpls": [
          {
            "pluginId": "anthropic_provider_plugin",
            "pointId": "llm_provider",
            "implId": "anthropic_compatible",
            "type": "list",
            "pluginEnabled": true,
            "enabled": true,
            "description": "Anthropic 鉴权 header 构造（x-api-key + anthropic-version）",
            "pointDescription": "LLM 鉴权与连接行为（apiKey header 构造等）",
            "pluginDescription": "Anthropic Claude LLM provider + Messages wire protocol",
            "schemaConfig": {
              "apiKey": { "type": "string", "description": "API Key" },
              "model": { "type": "enum", "default": "claude-sonnet-4-6", "options": ["claude-sonnet-4-6", "claude-haiku-4-5"] }
            },
            "config": { "model": "claude-sonnet-4-6" }
          }
        ]
      }
    ]
  }
}
```

- **group/enabled 正交**：group 决定展示分区，enabled（v0.0.67 起 plugin 级恒 true + impl 级来自代码声明）决定行为门。一个 ext impl 可在 `group="provider"` 分区可见但 `enabled=false`（不生效）。UI 按 group 分区渲染。
- **`[v0.0.5]` 顶层 `plugins[]`**：plugin-centric 平面列表（给插件 tab UI 用，每 plugin 一行一 toggle，**独立 state**——修 v0.0.4「两 plugin 开关联动」前端 bug）。字段 `{pluginId, label, description, enabled}`；label/description 来自 manifest（无则 fallback）。**v0.0.67 起 `enabled` 恒 true**（plugin 级 native 受信，代码声明不存 plugin 级开关；前端 toggle disabled）。
- **`[v0.0.5]` ext impl `type` 字段**：原 `cardinality` 改名 `type`（值不变 `exclusive`/`list`/`ordered`），对齐 UI type 路由术语（PRD §3.9.4 + `specs/ui/components/plugin-config-page/component-ext-impl-{radio,checkbox,ordered}.md`）。
- **`[v0.0.5]` ext impl `schemaConfig?`**：per-key UI 渲染 schema（来自 ExtImpl.schemaConfig 声明，无则缺省，UI 不出「配置」齿轮）。PRD §3.9.5 弹层按 type 渲染控件（`specs/ui/components/plugin-config-page/component-schema-config-modal.md`）。
- **`[v0.0.18]` 三级 description 透传**：ext impl 节点新增 `description`（impl 级，来自 ExtImpl.description）/ `pointDescription`（ext point 级，来自 ExtensionPoint.description，同 point 所有 impl 共享）/ `pluginDescription`（plugin 级，来自 PluginManifest.description，同 plugin 所有 impl 共享，与顶层 `plugins[].description` 同源）。均为代码硬编码（不进配置），缺省空串。UI 呈现见 `specs/ui/components/plugin-config-page/`（EP header + 3 impl 组件副文本）。**`[v0.0.62 i18n]`**：三路 description 字段（plugin/point/impl）+ `schemaConfig.<key>.description` + 顶层 `plugins[].label/description` 现在透传 `__MSG_<dotted.key>__` 占位符（非字面中文）；后端 inventory 透传 string 不变（`buildExtImplNode` 不解占位符），前端组件经 `resolveI18nField(value, t)` helper 识别 `__MSG_` → `t()` 查 plugin-config ns locale 表、否则直展原文（兼容第三方/老 plugin）。**字段类型 string 不变、向后兼容老 caller**（旧 caller 直接读字面值仍工作，只是看到 `__MSG_...__` 而非本地化文案）。详见 `specs/tech/i18n/[P1]manifest_i18n.md`。
- **`[v0.0.18]` order 语义**：ext impl 节点 `order` 改 **per-point 连续 1..n**（从 1 开始）；来自代码声明 `scopes/*.yaml` 的 impls 数组序（inventory 经 `computeEffectiveOrders` 末尾补位连续化）。详见 `specs/tech/config/[P0]plugin_config_service.md` §3.1。
- **`[v0.0.55]` ext impl `selected` 派生字段（[v0.0.179 modified] 派生源切换）**：exclusive EP 选中标记（仅 exclusive 类型 point 的 impl 有意义；list/ordered 永远 false）。
  - **`[v0.0.179]` 派生规则**：`selected = active（membership：impl 在该 scope impls 列表中）中 effective order 最小者`，与运行时统一 `getExtensionImpls` 同口径（前端 radio 直接读不再自算）。
  - **源 = 代码声明 `scopes/*.yaml` 该 EP 的 impls 数组**（validator 保证 exclusive EP 恰好 1 active → 正常情形 selected 即唯一 active 项）。
  - 非 default scope 未激活 EP：inventory 视图取 default 配置（per-EP 回退），`selected` 反映 default 的列表。
- **`[v0.0.179]` ext impl `enabled` 派生规则**：`enabled = (impl 在该 point 源 scope 的 impls 列表中)`（membership；不再 `?? true` 兜底——注册但未列进列表的 impl `enabled=false`）。字段形状/类型不变，仅派生源切换。

### 3.2 `PUT /config/plugin`（plugin/扩展点 ops，**v0.0.67 起删，返 405**）

> **[v0.0.67] 配置只读化（design §3 D4）**：plugin/ext impl 配置迁代码声明 `scopes/*.yaml`（[v0.0.179] 起 yaml impl 列表模型），PUT 写端点删——`handlers/config.ts:handlePluginConfig` 仅服务 GET，非 GET 返 `405 Method Not Allowed`（handler 层 method 检查）。前端编辑控件 disabled + 5 写 handler 改 noop（详 `specs/ui/components/plugin-config-page/page-plugin-config.md` [v0.0.67 modified]）。
>
> **历史 PUT ops 全部废弃**（v0.0.66 前的接口形状，v0.0.67 起返 405）：`setEnabled` / `setImplEnabled` / `setImplConfig` / `setExclusive` / `setConfig` / `setOrder`（v0.0.18 deprecated）/ `setPointOrders`（v0.0.18 新增）。配置改动需直接改代码声明 `app/plugins/scopes/*.yaml` 并重启（详 `specs/tech/plugin_system/[P1]scopes_config_decl.md §4` 强约定）。

**v0.0.67 起响应**：
- 非 GET 方法 → `405` · `{ "error": "Method Not Allowed" }`。

**历史响应（v0.0.66 前保留参考）**：`200` · `{ "ok": true }`（写入经 `persist()` 落盘 `plugin_policy` entity，next-get 反映）。

#### 3.2.1 `[v0.0.18]` setPointOrders 落盘语义（整 ext point 组批量，**v0.0.67 起删**）

请求体示例：

```json
{
  "op": "setPointOrders",
  "pointId": "system_prompt_mapper",
  "orders": [
    { "implId": "identity",      "order": 1 },
    { "implId": "rules",         "order": 2 },
    { "implId": "tool_guidance", "order": 3 },
    { "implId": "skills",        "order": 4 },
    { "implId": "context_files", "order": 5 },
    { "implId": "memory",        "order": 6 }
  ]
}
```

落盘（详见 `specs/tech/config/[P0]plugin_config_service.md` §4.6）：
1. `orders[]` 中每条 upsert `ExtImplPolicyData.order = n`（保留 enabled/configValues/exclusive 不动）。
2. **同 point 但不在 `orders[]` 的 impl → 清掉其 order record**（恢复默认 = 末尾补位）。根治「拖动后旧 record 残留导致冲突」。
3. **单 point 原子**（全成功/全失败）。
4. order 取值：per-point 连续 1..n（从 1 开始）。

> **UI 必须用 setPointOrders**（不再用 setOrder 单条）。前端 `handleReorder` 重写：乐观更新后取被拖项 + 全组 order 1..n 一起发。详见 `specs/ui/components/plugin-config-page/page-plugin-config.md`。

### 3.3 错误响应（`/config/plugin`）

| HTTP status | 触发条件 | 响应体 |
|---|---|---|
| `400` | PUT 缺字段；op 不识别；implId 不存在 | `{ "error": "<原因>" }` |

## 3.4 scope 维度（`/config/plugin` 扩展 + scope 端点） `[v0.0.26 modified]` `[v0.0.67 modified]`

> ext-impl 配置层加正交维度 `scope`（agent loop 风格，与 `ExtensionPoint.group` 功能分区正交）。权威 spec：`specs/tech/config/[P0]ext_impl_scope.md`（D1-D6 决策）+ `specs/tech/plugin_system/[P1]scopes_config_decl.md`（v0.0.67 代码声明机制）。本节是 §3.1/§3.2 的 scope 增量补充。
>
> **[v0.0.67 modified] 配置代码化**：scope 元信息 + activatedPoints + impl 配置全部移到代码声明 `app/plugins/scopes/*.yaml`（唯一源；[v0.0.179] 起 yaml impl 列表模型）。落盘 `plugin_scope` / `ext_impl_scope_activation` / `plugin_policy` 仅 lazy migrate 兼容，运行时不读。**scope 写端点（POST/DELETE scope + POST/DELETE activate）删，返 405**；保留 GET 读端点（数据源 = ScopeConfigProvider）。

### 3.4.1 scope 列表端点（**v0.0.67 起仅 GET**）

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/config/plugin/scopes` | 列所有 scope（default 首位） | `200` + `{ items: PluginScope[] }`，字段 `scopeId`/`name`/`description`/`createdAt`（代码声明 scope 用 epoch 占位 `1970-01-01T00:00:00.000Z` 表「非落盘声明」） |
| ~~`POST`~~ | ~~`/config/plugin/scopes`~~ | **v0.0.67 起删返 405**（scope 由代码声明，不接受动态创建） | `405` + `{ "error": "Method Not Allowed" }` |
| ~~`DELETE`~~ | ~~`/config/plugin/scopes/:id`~~ | **v0.0.67 起删返 405**（scope 由代码声明，不接受动态删除） | `405` + `{ "error": "Method Not Allowed" }` |

> **scope id 字段名约定**：HTTP 响应用 `scopeId`（与 `PluginScope` interface 一致，`specs/tech/config/[P0]ext_impl_scope.md` §2 同源）；历史 POST body 创建用 `id`（v0.0.67 起 POST 已删）。

### 3.4.2 per-EP 激活端点（**v0.0.67 起仅 GET**）

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/config/plugin/scopes/:id/activations` | 查该 scope 激活的 EP 列表（default 返全 EP，D6 短路） | `200` + `{ items: [{ pointId }] }` |
| ~~`POST`~~ | ~~`/config/plugin/scopes/:id/activate/:pointId`~~ | **v0.0.67 起删返 405**（激活态由代码声明 `activatedPoints`，不接受动态激活） | `405` + `{ "error": "Method Not Allowed" }` |
| ~~`DELETE`~~ | ~~`/config/plugin/scopes/:id/activate/:pointId`~~ | **v0.0.67 起删返 405**（同上） | `405` + `{ "error": "Method Not Allowed" }` |

GET `/activations` 错误：`404`（scope 不存在，default 除外）。

### 3.4.3 GET `/config/plugin?scopeId=<id>` — inventory 按 scope 视图

- Query：`scopeId` 可选，缺省 `'default'`（向后兼容）。
- 响应增量字段：
  - `tree.scope`：当前查询 scope 元信息 `{ id, name, description }`（v0.0.67 起来自代码声明 ScopeConfig）。
  - `tree.scopes`：全部 scope 列表（v0.0.67 起来自 ScopeConfigProvider.listScopes，default 首位）。
  - `tree.groups[].points[]`：该 group 下每个 point 的激活状态 `{ pointId, activated }`（v0.0.67 起来自 ScopeConfig.activatedPoints，default 全 true D6 短路）。
  - `tree.groups[].extImpls[].pointActivated`：该 impl 所属 point 在当前 scope 的激活态（平铺便于 UI 渲染）。
  - `tree.groups[].extImpls[].selected`：[v0.0.55] exclusive EP 选中标记，[v0.0.179] 源 = 代码声明该 EP impls 数组唯一 active 项（详 §3.1）。
- **`pointActivated === false`**（非 default scope 未激活 EP）：该 point 下 extImpls 是**回退取 default 的视图**（运行时 per-EP 回退）；UI 灰显 + `ext-point-{pointId}-inactive-hint`（i18n `plugin-config:page.epInactiveHint`），不渲染 impl 列表（v0.0.67 UI 只读化，已删「激活此 EP」按钮）。
- **`scopeId='default'`**：全 `pointActivated=true`（基线，D6 短路）。

### 3.4.4 PUT `/config/plugin`（现有 op 加 `scopeId?` 字段，**v0.0.67 起删返 405**）

> **[v0.0.67] 配置只读化**：本节描述的 PUT impl 级 op（带 `scopeId?` 字段）全部废弃，PUT 端点返 405（详 §3.2）。配置改动需直接改代码声明 `app/plugins/scopes/*.yaml`。

历史接口形状（v0.0.66 前保留参考）——所有现有 impl 级 op 增加可选 `scopeId` 字段（缺省 `'default'`，向后兼容）：

```json
{ "op": "setImplEnabled", "implId": "...", "enabled": true, "scopeId": "custom" }
{ "op": "setExclusive",   "implId": "...", "scopeId": "custom" }
{ "op": "setPointOrders", "pointId": "...", "orders": [...], "scopeId": "custom" }
{ "op": "setImplConfig",  "implId": "...", "values": {...}, "scopeId": "custom" }
```

- **写未激活 EP 语义**（D4）：当 `scopeId !== 'default'` 且该 impl 所属 point 在该 scope **未激活** → **自动激活**（复制 default snapshot）+ **应用本次写入**（原子）。响应不变 `{ "ok": true }`。
- **`setEnabled` / `setConfig`（plugin 级）不加 scopeId**（plugin 级配置不分 scope，PRD OUT）。
- **`setOrder`（deprecated）不推荐**——单条 orders[] 受 `computeEffectiveOrders` 连续化算法影响（known record 重排后绝对 order 被重写为 1..n）；**推荐全组 orders[]**（UI `handleReorder` 已实现整组发，详见 `specs/ui/components/plugin-config-page/page-plugin-config.md` + `specs/tech/config/[P0]ext_impl_scope.md` §6.3）。

错误（§3.3 表增量）：`400` PUT scopeId 不存在；`404` scope 不存在（activate path）；`409` POST scope id 已存在。

## 3.5 `observability` secretKey 语义（GET 明文 / PUT 占位 merge） `[v0.0.11]` `[v0.0.119.bugs2 modified]`

`runtime.observability` 是 **list-of-objects**（`ObservabilityConfigItem[]`，schema 见 `specs/tech/config/[P0]app_config.md §3.9`；v0.0.89 起整组迁 `app_config`，走 `/config/app?group=runtime&key=observability`），其中 `secretKey` 是 **secret** 字段：

- **GET**：响应里每 item 的 `secretKey` **返回明文**（`[v0.0.119.bugs2]`：走通用 KV 透传，后端不脱敏；mask 收敛到前端 `SecretInput` 组件 display 态自动 mask，编辑态显原文）。与 `/config/app` providers group `apiKey` 同模式（BUG-002）。
- **PUT**（单 key 或整组提交，§2.2）：item 的 `secretKey` 字段值——
  - 等于占位哨兵 `"***"`（旧前端未改/兼容）→ 服务端按 item.id 回填**原落盘值**（`mergeObservabilityPlaceholderSecrets`），不写空、不覆盖。
  - 非占位真值（用户新输入明文）→ 服务端用新值落盘。

> 前端逻辑见 `specs/ui/components/app-dev-config-page/observability-config/section-observability-detail.md` + `specs/ui/components/framework/primitive-secret-input.md`。

**`logPhysical` 字段（v0.0.50 新增）**：每 item 加 boolean `logPhysical`（默认 false，非 secret，GET 明文 / PUT 接受真值）；开启后该 backend 启用 physical generation（与 logical 并列记，不带 usage），见 `specs/tech/config/[P0]app_config.md §3.9` + `specs/tech/agent/observability/[P0]observability_manager.md §5.3`。**改动不热更新**（重启或下 session 生效）。

**AT 影响**：observability GET 响应断言 `secretKey` 为明文（`[v0.0.119.bugs2]`：不再断言 `=== "***"`）；PUT 携带占位 `"***"` 后再 GET，断言原落盘 `secretKey` 不变（merge 生效）；PUT 携带真值再 GET，断言新值已落盘。

## 3.6 web group（`[v0.0.89]` 迁 `app_config`）+ 连接器端点组 `[v0.0.23]`

v0.0.23 在 dev_config 新增 `web` group（web_fetch 内置 jina 管线配置，详见 `08-web-tools.md` §5）——**`[v0.0.89]` 随 dev_config 废弃整组迁入 `app_config`，现走 `/config/app?group=web`**；并新增**连接器端点组**（`/config/connectors`，browser attach 用户侧门禁，详见 `08-web-tools.md` §6）。

**`web` group（复用 `/config/app`，无新增端点；`[v0.0.89]` 随 dev_config 废弃迁自 `/config/dev`，group/key/redact 语义零变更）**：

| key | 类型 | 默认 | secret | 说明 |
|-----|------|------|--------|------|
| `jinaApiKey` | string | —（无） | ✅ | jina reader API key；web_fetch 用，**有则传**、**无则不传**（匿名受限） |
| `jinaEnabled` | boolean | true | — | false → 跳过 jina fetcher（仅 local fetcher，含其 headless 子分支） |
| `jinaTimeoutMs` | number | 20000 | — | jina 调用超时（ms） |

`jinaApiKey` secret 处理：**GET 返回明文**（`[v0.0.135]`：与 §3.5 observability secretKey 同套路——mask 收敛到前端 `SecretInput` 展示层，编辑态显原文；旧前端 `redactWebSecret` 已删）/ PUT 占位 `"***"` merge 保留原值（向后兼容旧前端，幂等无害）/ PUT 真值落盘。记录缺失 → GET 整组不含该 key 条目；消费方走代码默认。

**AT 影响**：web group GET 响应断言 `jinaApiKey` 为明文真值（`[v0.0.135]`：不再断言 `=== "***"`）；PUT 携带占位 `"***"` 后再 GET，断言原落盘值不变（merge 生效）；PUT 携带真值再 GET，断言新值已落盘。

**连接器端点组（新增端点）**：

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/config/connectors` | 所有连接器实时状态（v0.0.23 仅 browser） | `200` + `{ items: ConnectorState[] }`（switch on/off + connection disconnected/connecting/connected/error + errorDetail? + lastConnectedAt?） |
| `PUT` | `/config/connectors/:id` | 派发 enable/disable（`[v0.0.46]` 只写 intent + UI 态，不再触发 connect —— connect 由 tool.run 首次调 attach lazy 触发） | `202` + `{ ok: true }`（body `{enable:boolean}`） |

双状态机（switch=用户启用意图 feature flag，`[v0.0.46]` 与 connection 完全解耦；connection=运行时态）由后端 ConnectorManager 维护（详见 `specs/tech/config/[P1]connectors.md`）。错误：`400` body 非 `{enable:boolean}` / `:id` 非法；`404` `:id` 不存在。

> 完整契约见 `08-web-tools.md`（v0.0.23 新建，承载 web tools 三件套工具协议面 + web group + 连接器端点组的权威定义）。

## 4. AT 影响

- **v0.0.4 → v0.0.5 AT 断言迁移**（历史）：
  - ext impl 节点 `cardinality` → `type`
  - 新增 `tree.plugins[]` 顶层断言（plugins tab 独立 toggle 用）
  - 新增 ext impl `schemaConfig` 可选断言（有 schemaConfig 的 impl 才断言）
  - 新增 `/config/app|dev` 整组提交 AT case（body 携带 `items[]`，断言同 group 原子性 + 其他 group 不受影响）
  - 新增 `setImplConfig` 稀疏 delta AT case（values 只含部分 key，next-get 落盘的 config 是 deepMerge 后结果）
- v0.0.4 inventory AT 断言 `tree.groups[].extImpls[]` 路径**不变**（group-centric 结构延续）。
- **`[v0.0.18]` 新增 AT 断言/case**：
  - ext impl 节点断言 `description`/`pointDescription`/`pluginDescription` 三字段（有 desc 的断言非空字符串、无 desc 断言为空串）
  - 新增 `setPointOrders` AT case：PUT 整组 orders[] → GET 断言该 point 所有 impl 的 effective order = 期望 1..n；同 point 不在 orders[] 的 impl order record 被清（GET 后回退末尾补位）
  - 新增「新 impl 默认末尾」AT case：registry 加一条无 order record 的 impl → GET 断言其 effective order = max+1（排末尾）
  - 新增「拖动后顺序持久化」AT case：setPointOrders 后重启 env → GET 断言顺序不变
  - ext impl `order` 断言改 1..n（原 priority 大数值不再出现）
- **`[v0.0.26]` 新增 AT 断言/case**（对应 PRD `specs/prd/version_logs/v0.0.26/change_log.md` §3 路径 P1-P8）：
  - `GET /config/plugin?scopeId=default`（缺省）→ 与 v0.0.18 响应结构一致 + 新增 `scope`/`scopes`/`points[].activated`/`extImpls[].pointActivated` 字段（default 全 `pointActivated=true`）
  - `POST /config/plugin/scopes` → `GET ?scopeId=custom` → 全 `pointActivated=false` + extImpls 取 default 视图（继承回退）
  - `POST /config/plugin/scopes/:id/activate/:pointId` → `GET ?scopeId=custom` 该 point `activated=true` + impl 反映独立配置（snapshot 隔离：之后改 default 该 EP impl，custom 不变）
  - `PUT /config/plugin` `{op:'setImplEnabled', scopeId:'custom'（未激活 EP）}` → `GET` 该 point 自动转 `activated=true` + impl 反映改动（验证 D4 自动激活）
  - `DELETE /config/plugin/scopes/:id/activate/:pointId` → `GET ?scopeId=custom` 该 point `activated=false` + impl 回退 default 视图
  - `DELETE /config/plugin/scopes/:id`（非 default）→ `GET /config/plugin/scopes` 不含该 scope；`GET ?scopeId=custom` → `404`；default 配置不受影响；`DELETE default` → `400`
  - migrate：有现存 ExtImplConfigRecord → 启动后 GET → 全部归属 default（行为与升级前一致）

## 5. 文件变更清单（planner/coder 依据）

v0.0.5 API 层**无新增端点**（3 项增量见 §1）。`[v0.0.18]` 仍无新增端点，2 项增量（§3.1/§3.2）。`[v0.0.26]` 新增 scope CRUD + per-EP 激活端点组（§3.4）。`[v0.0.151.t2_consolidate]` 新增 `GET /consolidation/status` 只读端点（§2.7）；`consolidation` group 复用既有 `/config/app` 通用路径（§2.6，无新增路由）。

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/router.ts` | 修改 | `[v0.0.151.t2_consolidate]`：新增路由 `GET /consolidation/status` → `handleConsolidationStatus`（无需 body 解析，直接调 `ConsolidationPersistenceAdapter` 读 `lastResult`） |
| `app/server/src/handlers/consolidation-status.ts`（新增） | 新增 | `[v0.0.151.t2_consolidate]`：`handleConsolidationStatus(adapter): {lastRunAt, summary}`（从未执行过返回 `{lastRunAt:null, summary:null}`，见 §2.7）。**[v0.0.205.t2_cons modified]**：签名加 `appTaskLock` 参数——`handleConsolidationStatus(adapter, appTaskLock): {lastRunAt, summary, status, startedAt}`（status/startedAt 源自 lock 内存态，done 归 idle，见 §2.7） |
| `app/server/src/handlers/config.ts` | 修改 | v0.0.5：`AppConfigHandler.put` / `DevConfigHandler.put` 识别 `items[]` 整组提交；`PluginConfigHandler.getInventory` 序列化 cardinality→type + 顶层 plugins[] + schemaConfig?。[v0.0.18]：`PluginConfigHandler.put` 新增 `setPointOrders` op 分支 → 调 `PluginConfigService.setPointOrders`；getInventory 序列化 ext impl 节点加 description/pointDescription/pluginDescription。[v0.0.26]：新增 `handlePluginScopes`（GET/POST/DELETE scope CRUD）+ `handleScopeActivation`（POST/DELETE/GET activate）；`handlePluginConfig` GET 加 `scopeId` query 解析；PUT 现有 impl 级 op body 加 `scopeId?` 字段透传 service（scopeId 不存在 → 400） |
| `app/server/src/config/app-config-service.ts` / `dev-config-service.ts` | 修改 | v0.0.5：同构新增 `setGroup(group, items[])` |
| `app/server/src/plugin/plugin-config-service.ts` | 修改 | v0.0.5：PluginInventoryTree 加 plugins[] + ext impl 节点 type/schemaConfig。[v0.0.18]：新增 `setPointOrders(pointId, orders[])` 方法（§4.6 落盘语义：全量替换 + 清旧 + 原子）；`buildExtImplNode` 加三级 description 透传；order 默认值改末尾补位算法（§3.1）；setOrder 标 deprecated。[v0.0.26]：现有写 op 加 `scopeId?` 参数（缺省 default）；新增 `listScopes`/`createScope`/`deleteScope`（cascade）/`activateEp`（snapshot 复制 + activation 写）/`deactivateEp`（清 activation + impl record）/`listActivatedPoints`；inventory 加 `scopeId?` 参数 + scope/scopes/pointActivated 字段；写未激活 EP 自动激活逻辑（D4）。详见 `specs/tech/config/[P0]ext_impl_scope.md` §6/§7 |
| `app/server/src/plugin/manifest.ts` / `extension-point.ts` | 修改 | v0.0.5：ExtImpl 加 `schemaConfig?`。[v0.0.18]：manifest ExtImpl 删 `priority?`/加 `description?`；extension-point 加 `description?` + 8 内置 EP 加 description + 注释「按 priority」改「按 order」 |
| `app/server/src/plugin/plugin-manager.ts` | 修改 | [v0.0.18]：ordered sort 改读 effective order 升序；exclusivePick 改 enabled 门 + effective order fallback。[v0.0.26]：`getExtensionImpls` 加 `scopeId` 重载（per-EP 回退）；isActive/resolveByCardinality/instantiate 按 scopeId 取源（激活取 scope，未激活取 default）；抽 `resolveScopeSource` helper；default 短路（D6） |
| `app/server/src/plugin/order-utils.ts`（新增） | 新增 | [v0.0.18]：`computeEffectiveOrder` 公共函数，被 plugin-manager + plugin-config-service 共用。[v0.0.26 modified]：算法不变，仅 getImplPolicy 回调签名加 scopeId 透传（取 order 源由调用方 plugin-manager 构造） |
| `app/server/src/plugin/plugin-policy-store.ts` | 修改 | [v0.0.26]：impl 级 API 加 scopeId 维度（getImpl/setImpl/deleteImpl/listImpls/listImplsByPoint 通过 TS 重载扩展签名）；key 编码 `${scopeId}::${implId}`；新增 `migrateLegacyImplKeys()`（启动时 lazy，D3） |
| `app/server/src/plugin/{plugin-scope-store,scope-activation-store,schema_defs/plugin_scope,schema_defs/scope_activation}.ts` | 新增 | [v0.0.26]：scope entity + activation entity SchemaDef + 对应 store（详见 `specs/tech/config/[P0]ext_impl_scope.md` §2/§3/§9） |
| `app/server/src/plugin/index.ts` | 修改 | [v0.0.26]：导出 PluginScopeStore/ScopeActivationStore/PluginScope 类型；bootstrap 调 `migrateLegacyImplKeys` + ensure default scope |
| `app/web/src/lib/api-client.ts` | 修改 | [v0.0.18]：PluginOp 联合加 `{op:'setPointOrders'; pointId; orders[]}`。[v0.0.26]：新增 `listScopes`/`createScope`/`deleteScope`/`activateEp`/`deactivateEp`/`listActivations` 函数；`getPluginInventory` 加 `scopeId` 参数；`PluginPutOp` 联合体各 op 加 `scopeId?` 字段；`PluginInventoryTree` 类型加 `scope`/`scopes`/`pointActivated` 字段 |
| `app/web/src/components/plugin-config-page/page-plugin-config.tsx` | 修改 | [v0.0.18]：handleReorder 重写（用乐观更新后 state / 取被拖项 / 全组 setPointOrders）。[v0.0.26]：scope 维度状态（currentScopeId/切换/激活/创建/删除 handlers）；扩展点 tab 顶层挂 `component-scope-switcher`；impl 写 op 携带 scopeId |
| `app/web/src/components/plugin-config-page/{component-scope-switcher,section-ext-point-area,component-ext-impl-{radio,checkbox,ordered},component-ep-deactivate-modal}.{tsx,md}` | 新增/修改 | [v0.0.26]：scope 切换器新组件 + section-ext-point-area 加 scope Props/激活按钮/灰显；impl 组件加 disabled prop；EP 取消激活确认 modal。详见 `specs/ui/components/plugin-config-page/` |

## 6. 版本

version: 1.12 `[v0.0.205.t2_cons modified]`（§2.7 `GET /consolidation/status` 响应加 `status: 'running'|'idle'|'failed'` + `startedAt: string|null`——源自 AppTaskLock 内存态（done 归 idle，完成态仍由 lastRunAt/summary 承载），非破坏性新增字段；前端整理 tab onInit 据此初始化 running 态，修切走切回按钮可点 UX bug。配套后端行为（非 API 面）：AppTaskLock.acquire 加 1h 超时接管。技术权威 `specs/tech/agent/session/[P0]app_task_lock.md §3.1` + `specs/api/version_logs/v0.0.205.t2_cons/change_log.md`）。1.11 `[v0.0.179.plugin_config modified]`（plugin scope 配置模型简化——YAML 配置层废 `selected`/`enabled`/`exclusivePicks`/delta merge，改 impl 列表模型（EP 节点不出现=继承 default 全量、出现=全量替换；membership=active，数组序=order）；**GET `/config/plugin` inventory 响应形状零变更**，仅 `ExtImplNode.enabled` 派生源改 membership（不再 `?? true` 兜底）+ `selected` 派生源改「exclusive EP active 中 order 最小者」（不再读 `exclusivePicks`）；PUT 仍 405；§3 加「YAML 配置层 = 全量列表无 delta merge」段 + §3.1 enabled/selected 派生规则更新 + §3.4.3 selected 源更新。技术权威 `specs/tech/plugin_system/[P1]scopes_config_decl.md` + `specs/tech/config/[P0]ext_impl_scope.md §5` + `specs/api/version_logs/v0.0.179.md`）。1.10 `[v0.0.164.memory_opt modified]`（新增 §2.8 `POST /consolidation/run`——手动触发 tier2 整理，fire-and-forget 202/409，`AppTaskLock` 跨触发源互斥）。1.9 `[v0.0.151.t2_consolidate modified]`（新增 §2.6 `GET/PUT /config/app?group=consolidation`——复用既有通用路径，无新增路由，consolidation group schema 详见 `specs/tech/config/[P0]app_config.md §3.16`；新增 §2.7 `GET /consolidation/status`——本版本唯一真正新增的 HTTP 路由，只读返回天级二级整理任务的上次执行时间 + 一句话摘要，权威 spec `specs/tech/scheduling/[P1]consolidation_job.md §2.1`；§5 文件清单补 router.ts + 新 handler 行）。1.8 `[v0.0.71 modified]`（GET `/config/plugin` inventory 响应形状重构——`groups[]` 由扁平 `extImpls[]` 改嵌套 `points[].impls[]`（D3 破坏性 schema 变更，对齐 scope→group→point→impl 用户心智）；`ExtImplNode` 删 `schemaConfig?`（D7）+ 新增 `configSchema?` 透传 manifest（单一 schema 源）+ 删 `pointActivated`（信息上提到 `points[].activated`）+ `config` 始终 = JOIN(manifest default ⊕ scope configValues)（bug-A 修复）；group 顺序改按 `app/plugins/groups.json` 声明序（D1 删 `ExtensionPoint.group` 字段，group meta 唯一源）；PUT 仍 405 不变。技术权威 `specs/tech/config/[P0]plugin_config_service.md §2.1`（嵌套 PluginInventoryTree）+ `specs/tech/plugin_system/[P1]groups_meta_decl.md`（groups.json 唯一源）+ `specs/api/version_logs/v0.0.71.md`（形状变更对照）+ `specs/tech/version_logs/v0.0.71/change_log.md`）。1.7 `[v0.0.67 modified]`（plugin config 全面重构——配置迁代码声明 `app/plugins/scopes/*.json`，落盘 `plugin_policy` deprecated 仅 lazy migrate 兼容；PUT `/config/plugin` 写端点删返 405；scope 写端点（POST/DELETE scope + activate/deactivate）删返 405；GET inventory + GET scope list + GET activation list 保留（数据源 = ScopeConfigProvider）；GET inventory `selected` 派生字段 v0.0.67 语义明确（源 = 代码声明 `exclusivePicks`）；§3.1/§3.2/§3.4 加 v0.0.67 修改说明。技术权威 `specs/tech/config/[P0]plugin_config_service.md §2/§4`（v0.0.67 起只读）+ `specs/tech/plugin_system/[P1]scopes_config_decl.md`（代码声明机制）+ `specs/tech/version_logs/v0.0.67/change_log.md`）。1.6 `[v0.0.62 i18n modified]`（§3.1 三级 description 透传段补 v0.0.62 i18n 说明：plugin/point/impl description + schemaConfig description 现透传 `__MSG_<key>__` 占位符非字面中文；后端 inventory 透传 string 不变，前端 resolveI18nField helper 翻译；字段类型 string 不变向后兼容。技术权威 `specs/tech/i18n/[P1]manifest_i18n.md`）。1.5 `[v0.0.26 modified]`（§3.4 新增 scope 维度：scope CRUD 端点组（§3.4.1）+ per-EP 激活端点组（§3.4.2）+ GET `/config/plugin?scopeId` 响应增量字段 scope/scopes/points[].activated/extImpls[].pointActivated（§3.4.3）+ PUT 现有 impl 级 op 加 `scopeId?` 字段（缺省 default 向后兼容）+ 写未激活 EP 自动激活（D4，§3.4.4）；§4 加 v0.0.26 AT case；§5 文件清单补 v0.0.26 行）。1.4 `[v0.0.25 modified]`（§2.4 新增 `GET/PUT /config/app/llm_request` 端点——llm_request config group 读写，调优参数 timeout/retry/degradation/length/fallback_chain，不配=默认）。1.3 `[v0.0.23 modified]`（§3.6 新增 dev_config web group（jinaApiKey secret redact，复用 §3.5 套路）+ 连接器端点组（GET /config/connectors + PUT /config/connectors/:id，双状态机，详见 `08-web-tools.md`）；web tools 工具协议面 + web_search_provider EP inventory 透传见 `08-web-tools.md`）。1.2 `[v0.0.18 modified]`（§3.1 GET ext impl 节点加三级 description 透传 + order 语义改 1..n；§3.2 PUT 新增 `setPointOrders` op（整 ext point 组批量）+ setOrder deprecated；§3.2.1 落盘语义；§4 新增 AT case；§5 文件清单补 v0.0.18 行）。1.1 `[v0.0.11 modified]`（§3.5 dev_config secret redact）。1.0 `[v0.0.5]`（从 `02-llm-chat.md` §4 拆出）
