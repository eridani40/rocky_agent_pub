---
type: spec
title: AppConfig Schema（用户配置 + 技术调参）
priority: P0
status: active
updated: 2026-08-13
since: v0.0.2
---

# AppConfig Schema（用户配置）

## 1. 概述

**管什么**：app_config 的 KV-sharded entity 定义 + 大 map 视图 + 各 group 的 data 形状示例 + AppConfigService（逻辑服务层）。
**不管什么**：读写/持久化机制（→ `../persistence/`）、group 清单（→ PRD/需求）、HTTP facade（→ `specs/api/`）。
总览见 `[index.md`](index.md)。

app_config 是**一个 KV 型 entity**，按 `group` 分片存储（engine: file）。每条 record 是一个配置项：

```typescript
const AppConfigSchema: SchemaDef = {
  entity: "app_config",
  engine: "file",
  fs: {
    sharding: { shardKeyField: "group", dirTemplate: "app_config/{shardKey}/" },
    format: "json",
  },
  fields: {
    id:    { type: "ulid", required: true },    // ULID 主键（persistence 保留名）
    group: { type: "string", required: true },  // 分片键 + tab，由需求/PRD 定义
    key:   { type: "string", required: true },  // 组内配置项名（组内唯一）
    data:  { type: "json", required: true },    // 值，恒为 json（可简单值，可多层嵌套）
  },
};
```

- **group** = 分片键 + 配置界面的 tab。**group 集合由需求/PRD 定义**（如 appearance / providers / locale），不动态扩展。
- **key** = 组内逻辑 key（同 group 内唯一）。
- **data** = 恒为 json。简单值存原子/字符串；复杂或"多级"存嵌套 json 树。
- 落盘：`app_config/{group}/<id>.json`，同 group 的项聚在一个 shard 目录（读一个 tab = 读一个 shard）。

## 2. 大 map 视图（无 typed 结构体）

app_config **没有 typed `AppConfig` 结构体**。逻辑上是一张大 map：

```
(group, key) → data (json)
```

代码经 config 服务按 (group, key) 取值：

```typescript
const theme = configService.get("appearance", "theme");        // → "dark"
const prov  = configService.get("providers", instanceId);      // → { ...provider + models[] }
```

需要具体形状时，由消费方按约定 cast/校验 data（data 对 persistence 是不透明 json）。

## 3. data 形状示例（按 group）

### 3.1 appearance 组（简单值 + 多级）

```json
{ "group": "appearance", "key": "theme", "data": "dark" }
{ "group": "appearance", "key": "density", "data": "compact" }
{ "group": "appearance", "key": "palette", "data": { "primary": "#fff", "modes": { "dark": {}, "light": {} } } }
{ "group": "appearance", "key": "language", "data": "zh-CN" }
```

> **[v0.0.89] `language` 迁自 locale group**：原 `locale` group 已废弃合并入 `appearance`（前端 read-modify-write 整组 PUT 含 theme + language 两 key）；`changeLanguage(lng)` 走切即生效（不走 page-tab dirty）+ PUT appearance 整组（含 theme 避免覆盖）。详见 `[P0]i18n_overview.md §5.4`。

### 3.2 providers 组（列表型：1 provider 实例 + 其 models = 1 条 data）

每个 provider 实例一条 KV 行：`key` = 实例 id，`data` 持有该实例配置 + 它的 models。

- **`data` 整体 = `LlmProviderConfig`（per-instance 数据）**：含 `pluginId`（→ `llm_provider` 扩展点的某 ext impl，即 provider 行为 impl）/ `label` / `credentials` / `enabled` / `baseUrl` / **`protocolId`（`[v0.0.53]` → `llm_protocol` 扩展点的某 ext impl，1 provider : 1 protocol 锁定，必填）** / `models[]`。字段细节见 `agent/providers_and_models/[P0]llm_provider_interface.md`。
- **`models[]` 每一条 = `LlmModelConfig`（完整 app_config 数据）**：`{ modelId, contextWindow, pricing, modalities, paramConstraints, default }`。一条 = 一个 modelConfig（不再是只含 `modelId/default` 的简表）；**`[v0.0.53]` `protocolId` 已从此处删除（迁到外层 `data.protocolId`，单一事实源）**；`providerId` 隐式 = 本 provider 实例 id。字段细节见 `agent/providers_and_models/[P0]llm_model_interface.md`。

```json
{
  "group": "providers",
  "key": "01KVC9A2T3KQ9E1P0M4N7X8Y2Z",
  "data": {
    "label": "我的 OpenAI",
    "pluginId": "openai",
    "baseUrl": "https://api.openai.com",
    "protocolId": "openai_chat_completions",
    "credentials": { "...": "形式见 isolation 模块" },
    "enabled": true,
    "models": [
      {
        "modelId": "gpt-4o",
        "contextWindow": 128000,
        "maxOutputTokens": 16384,
        "inputModalities": ["text", "image", "audio"],
        "outputModalities": ["text"],
        "paramConstraints": {
          "temperature": { "default": 1.0, "min": 0, "max": 2 }
        },
        "pricing": { "inputPerMillion": 2.5, "outputPerMillion": 10.0, "currency": "USD" },
        "default": true
      },
      {
        "modelId": "gpt-4o-mini",
        "contextWindow": 128000,
        "maxOutputTokens": 16384,
        "inputModalities": ["text", "image"],
        "outputModalities": ["text"],
        "paramConstraints": {},
        "pricing": { "inputPerMillion": 0.15, "outputPerMillion": 0.6, "currency": "USD" }
      }
    ]
  }
}
```

> `LlmProviderConfig`（per-instance，含 baseUrl/credentials/pluginId/enabled/models[]）= providers 组一条 record 的 `data`；`LlmModelConfig` = 该 record `models[]` 里的一条。两者都是 app_config 数据，不是独立持久化 record 概念。

> **`LlmProviderConfig.id`（= `data.id`）是 server 认的 providerId，不是文件名**：`LlmProviderConfig` 作为 record 的 `data` 时，其 `id` 字段（`data.id`）= `POST /messages` / `POST /session/:id/chat` 的 `providerId`。**文件名**（`record.id` = 文件名去 `.json`）和 `record.key` **不是** providerId（虽 `record.key` 常与 `data.id` 重合）。文件名与 data.id 可能不同（迁移/重命名场景），用文件名查 provider 会得「provider not found」。验证用例须用 `tests/api/lib/provider_resolve.py` 解析真实 `data.id`。详见 `agent/providers_and_models/[P0]llm_model_interface.md §3.4`。

> **运行时简化 + 字段扩展**：后端 runtime `ModelInstance`（`app/server/src/handlers/provider.ts`）是上文 `LlmModelConfig` 的简化子集——仅 `{ modelId, contextWindow, maxOutputTokens, default?, label, enabled }`（pricing/modalities/paramConstraints 暂未落库，YAGNI）。**`[v0.0.53]` `protocolId` 已从 ModelInstance 物理删除**（迁到外层 `ProviderInstance.protocolId`，单一事实源；见 `agent/providers_and_models/[P0]llm_provider_interface.md §3.4`）。必填字段：`label: string`（显示名，POST 缺省 = modelId）+ `enabled: boolean`（启停，POST 缺省 = true；关闭后在 chat 模型选择器隐藏）。`/provider/:id` 的 PUT 端点（handler `handleProviderItem`）可改 `label/baseUrl/enabled/credentials.key/protocolId`。前端 diff-save（`saveProviderWithModels`）= UI 算 draft/snapshot diff → 逐条调 `/provider` + `/provider/:id/model` CRUD（POST 新 / PUT 改 / DELETE 删）。

### 3.3 locale 组（**v0.0.89 DEPRECATED**——合并入 appearance 的 `language` key）

> **[v0.0.89] locale group 已废弃**：原 `{group:"locale", key:"language", data:"zh-CN"}` 合并入 `appearance` group 作为 `language` key（与 theme 同 group）。前端 `changeLanguage` + `initI18nFromConfig` 路径改走 `?group=appearance` + read-modify-write 含 theme（见 `i18n/[P0]i18n_overview.md §5.2/§5.4`）。下方历史形态保留作迁移参考：

```json
// 历史形态（v0.0.89 前落盘）：
{ "group": "locale", "key": "language", "data": "zh-CN" }
// v0.0.89 后落盘形态：
{ "group": "appearance", "key": "language", "data": "zh-CN" }
```

### 3.4 llm_request 组

LLM 调用调优参数（timeout / retry / degradation / length / fallback_chain）。单实例（`key` 固定为 `"default"`），全局共享。

```json
{
  "group": "llm_request",
  "key": "default",
  "data": {
    "timeout":     { "ttfb_s":45, "stall_answer_s":30, "stall_think_s":30, "stall_tool_s":120, "wall_max_s":600 },
    "retry":       { "max_attempts":3, "backoff_base_s":2, "backoff_cap_s":30, "jitter":true },
    "degradation": { "cooldown_s":300, "consecutive_to_degrade":3, "respect_retry_after":true },
    "length":      { "auto_compress":true, "precompress_threshold_ratio":0.8, "max_tokens_bump_strategy":"continue" },
    "fallback_chain": [
      { "providerId":"01KVC9A2...", "keyRef":"default", "modelId":"claude-sonnet-4-6" },
      { "providerId":"01KVC9B5...", "keyRef":"default", "modelId":"gpt-4o" }
    ]
  }
}
```

- **group 集合**：`{ appearance(含 language), providers, llm_request, user_memory, web_search, default_models, logs, runtime(含 observability), web, sub_agent_templates, agent, context, session, consolidation, skill_market }`（PRD 定义，不动态扩展）。`user_memory` 为 v0.0.55 新增、**v0.0.205.t2_cons 退役**（global memory 迁出到 `<dataDir>/memory/` dir store，record 物理保留但任何路径不再读取，详见 §3.5）；`web_search` 为 v0.0.72 新增（网络搜索 provider 路由 + 凭证，详见 §3.6）；`default_models` 为 v0.0.89 新增（playground 专属全局默认模型，详见 §3.7）；`logs`/`runtime`/`web`/`sub_agent_templates`/`agent`/`context` 为 v0.0.89 从废弃的 `dev_config` 迁入（详见 §3.8-§3.13）；`session` 为 v0.0.149 新增（skill/memory 注入分层配额调参 + v0.0.247 起存储硬上限同 key 同源，详见 §3.15）；`consolidation` 为 v0.0.151.t2_consolidate 新增（二级整理天级任务配置，详见 §3.16）；`skill_market` 为 v0.0.166 新增（skill 市场源凭证，详见 §3.17）；原 `locale` group v0.0.89 合并入 `appearance.language`（见 §3.3）。
- **缺省回退**：与其他 group 不同，llm_request record 不存在时 `LlmRequestConfigService.get()` 返回 `DEFAULT_LLM_REQUEST_CONFIG`（调优参数不配应能用合理默认，语义不同于 providers 权威值）。完整 schema + 默认值 + LlmRequestConfigService 见 `../agent/llm_caller/[P0]llm_request_config.md §1`。
- **装配接线（config 生效链路，v0.0.144）**：`get()` 的返回值经 `buildSessionConfigFromDeps`（`handlers/session-config.ts`）落 `SessionConfig.llmRequestConfig` + `allProviders`，再由两个 stage-llm 透传到 `llmCaller.invoke`——不接线则 config 形同虚设（v0.0.25 起曾断链恒回退 DEFAULT）。链路详情见 `../agent/llm_caller/[P0]llm_caller.md §4.1`。

### 3.5 user_memory 组（**已退役**）

**现状：本组退役**。global memory 介质已迁出到 `<dataDir>/memory/<name>.md`（per-entry md dir store，与 session/group 同构，见 `../agent/memory/[P0]memory_definition.md §2`）。**未做数据迁移**——旧 record 物理保留在落盘文件中（回滚旧版本可手动恢复），但当前版本**任何路径不再读取本组**（= 旧 global memory 全删重来）；`UserMemoryService` 已删除。UI「全局长期记忆」tab 与 `memory_manage` global scope 均改走 dir store。

旧 record schema（仅作回滚参考）：

```json
{
  "group": "user_memory",
  "key": "default",
  "data": {
    "entries": [
      {
        "name": "prefer-real-llm-tests",
        "intro": "api/e2e 测试不接受 mock",
        "type": "feedback",
        "body": "api/e2e 测试必须用真 LLM + 真服务...",
        "why": "mock-LLM 掩盖真实 bug",
        "howToApply": "禁止 mock-LLM 全绿即发布",
        "archived": false
      }
    ]
  }
}
```

### 3.6 web_search 组（v0.0.72 新增 — 网络搜索 provider 配置）

**web_search 工具的 provider 路由 + 凭证唯一介质**（PRD v0.0.72 §2.3 / D2）：存储 type 选择 + 各 provider 的 credentials map。单实例（`key` 固定 `"default"`），全局一份。

```json
{
  "group": "web_search",
  "key": "default",
  "data": {
    "type": "zhipu_coding_plan",
    "credentials": {
      "zhipu_coding_plan": { "apiKey": "<secret>" },
      "zhipu_api": { "apiKey": "<secret>" }
    }
  }
}
```

- **`data.type`**：选中的 provider implId（snake_case，与 `web_search_provider` ext impl implId 对应，**[v0.0.123]** 智谱拆 `zhipu_coding_plan`（MCP 订阅额度）/ `zhipu_api`（REST 按量计费）两 impl）。来自 `web_search_provider` ext impl 列表（`PluginManager.inventory`）。tool 按 `type` 在 list EP 中精确路由对应 impl。
- **`data.credentials`**：`map<implId, {apiKey?: string}>`，按 `type` 选中动态展示对应字段；两 implId 各自 apiKey 独立 entry，切换 type 不清空另一个（保存整组 PUT 两条都带）。未来扩展（Tavily 等）= `credentials.tavily.{...}`。
- **[v0.0.123] 一次性迁移**（旧 `zhipu` → `zhipu_coding_plan`）：历史上启动迁移 `migrateWebSearchProviderId(appConfig)`（bootstrap 调用）把旧 record `{type:"zhipu", credentials:{zhipu:{apiKey}}}` 迁为 `{type:"zhipu_coding_plan", credentials:{zhipu_coding_plan:{apiKey}}}`（apiKey 值原样保留）。v0.0.150 起该 ad-hoc 迁移文件已删（A 决策：无真实用户，旧格式按现状读不再迁）；新装/新数据只写 `zhipu_coding_plan` 形态。
- **单实例**：`key` 固定 `"default"`，全局一份。
- **缺失语义**：record 缺失 / `data.type` 缺失 = type 未配置 → web_search tool 返 ToolError「未配置 provider type」（不回退默认 provider、不静默选首个）。
- **消费方**：`web_search` tool（`app/server/src/tools/web-search/tool.ts` `resolveProvider`）经 `AppConfigService.get("web_search", "default")` 读 `data` → 按 `type` 路由 → `cfg = credentials[type] ?? {}` 传入 impl 的 `search`/`isAvailable`。
- **UI**：「应用设置 → 网络搜索」自渲染 section（type choice-cards + 选中 impl 时动态展示对应 credentials 字段；详见 `specs/ui/components/app-dev-config-page/section-web-search-config/`）。
- **不在本组**：web_fetch 的 jinaApiKey 在 `app_config` `web` group（v0.0.89 从废弃的 dev_config 迁入，见 §3.10）；web_search 的 baseUrl 等非凭证默认值如需引入再扩展（本版本不引入）。

### 3.7 default_models 组（v0.0.89 新增 — playground 专属全局默认模型）

**playground 域 session 的全局默认模型**（reqs/v0.0.89 §3）——chat/summary 两任务各自一个默认 ModelRef。单实例（`key` 固定 `"default"`），全局一份。

```json
{
  "group": "default_models",
  "key": "default",
  "data": {
    "chat": "gpt-4o",
    "summary": "gpt-4o-mini"
  }
}
```

- **`data.chat`**：playground session 的默认会话模型 ModelRef（纯 modelId string，不含 providerId）。当 `session.modelId === "default"` 时由 `resolveModel` 反查此值（详见 `agent/providers_and_models/[P0]model_resolve.md §3` fallback 链第 1/2 行）。
- **`data.summary`**：playground session 的默认整理模型 ModelRef。compact 任务（`task='summary'`）时优先读此值（fallback 链第 2 行第 1 步）。
- **两 key 均 optional**：缺失（`undefined`）= 未配该任务默认模型 → resolve fallback 链继续（不抛错，由链跑空才抛 ModelNotConfigured）。
- **单实例**：`key` 固定 `"default"`，全局一份。
- **playground 专属**：studio session（squad/leader/mate）**完全不读此 group**（resolve fallback 链第 3-6 行不读 default_models）——团队级模型决策走 `squad.modelDefault` + `squad.summaryModelDefault` + `member.model`（详见 `model_resolve.md §4` 原则 2 + `squad/[P1]data_model.md §1.1`）。
- **缺失语义**：record 缺失 / `data.chat` 缺失 = chat 任务未配默认模型 → resolveModel fallback 链第 1 步跳过继续（不回退首个 enabled provider，不静默选默认）。
- **UI**：「应用设置 → 模型 tab → playground 默认模型 group」走 KeyModelPicker（详 `specs/ui/components/app-dev-config-page/section-default-models-and-request.md` + `specs/ui/components/common/component-key-model-picker.md`）；x 清除写 `undefined`（删字段不删 record）。
- **不在本组**：squad 级默认模型（`squad.modelDefault` / `squad.summaryModelDefault`）属 squad entity 字段（详见 `squad/[P1]data_model.md §1.1`），不进 app_config。

### 3.8 logs 组（v0.0.89 迁自 dev_config — dev 日志开关 6 boolean）

**dev 调试日志开关**——6 个 boolean，**各自独立控制**一类调试流量是否追加写入 `<DATA_DIR>/logs/<type>.log`（opt-in 调试，默认全 false）。普通 KV group（同 llm_request 形状）。v0.0.89 从 `dev_config` 整组迁入 `app_config`（group/key 名零变更，消费方 `LogWriter` 改读 `appConfig.get('logs', <key>)`）。

```json
{ "group": "logs", "key": "enableLlmRequestLog", "data": false }
{ "group": "logs", "key": "enableToolResultLog",  "data": false }
{ "group": "logs", "key": "enableAppApiLog",      "data": false }
{ "group": "logs", "key": "enableEventLog",       "data": false }
{ "group": "logs", "key": "enableErrorLog",       "data": false }
{ "group": "logs", "key": "enableAgentLog",       "data": false }
```

字段细节 + LogWriter hook 点契约详见 `../dev-logs/[P0]overall.md`。

### 3.9 runtime 组（observability 列表）

**observability backend 列表**——单 record（`group=runtime`, `key=observability`, `data = ObservabilityConfigItem[]`）。bootstrap 读此构造 `ObservabilityManager`（composite adapter），注入 `SessionConfig.observability`（见 `../agent/observability/[P0]observability_manager.md §6/§7`）。v0.0.89 从废弃的 `dev_config` 迁入 app_config（group/key 名零变更；ObservabilityManager 凭证源唯一 = app_config，UI 经特化路由 `section-observability` 自管读写）。

```json
{
  "group": "runtime",
  "key": "observability",
  "data": [
    {
      "id": "01J...",
      "name": "self-host langfuse",
      "type": "langfuse",
      "baseUrl": "https://langfuse.internal.corp",
      "publicKey": "pk-lf-...",
      "secretKey": "sk-lf-...",
      "enabled": true,
      "desc": "internal self-host",
      "logPhysical": false
    }
  ]
}
```

**`ObservabilityConfigItem` schema**（`data` = 该类型的列表）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string (ulid) | 是 | 项唯一 id（前端增删改用） |
| `name` | string | 是 | 人类可读名（UI 展示） |
| `type` | `'langfuse'` | 是 | backend 类型；当前仅 langfuse，预留 vendor 扩展 |
| `baseUrl` | string (url) | 是 | langfuse host（cloud 或 self-host） |
| `publicKey` | string | 是 | langfuse public key |
| `secretKey` | string | 是 | **secret**（见下 secretKey 处理） |
| `enabled` | boolean | 是 | 是否启用（manager 只 fan-out 到 enabled 项） |
| `desc` | string | 否 | 描述 |
| `logPhysical` | boolean | 否 | physical generation 开关（默认 false）。开启后每次 LLM 调用并列记两条 generation——logical（业务视图）+ physical（发给 LLM 的物理请求体/wire body）；physical 不带 usage，不污染 token/cost 统计。改动不热更新（重启或下 session 生效，与 observability 列表本身的热更新语义一致）。 |

- **data 恒为列表**（`ObservabilityConfigItem[]`）；bootstrap 按列表解析，每 enabled 项一个独立 `LangfuseAdapter`。列表空/全 disabled → manager 持 0 child（等价 Noop，loop 无感知）。
- **无 ENV 兜底**：凭证只来自本列表——server 不读 `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`/`LANGFUSE_BASE_URL` env。测试用例经 seed app_config 列表（`tests/api/env_start.sh` / `tests/e2e/env.sh` 不注入 `LANGFUSE_*`）。

**secretKey 处理**（v0.0.119.bugs2）：`secretKey` 是 secret 字段——
- **落盘**：以原值存（文件级隔离；与 provider `apiKey` 同等级别的 secret 处理）。
- **GET 出参**：**返回明文**（走通用 KV 透传，后端不脱敏）；mask 收敛到前端展示层——`SecretInput` 组件 display 态自动 mask（头 4 + `*` + 尾 4，长度对齐），编辑态显原文。与 provider `apiKey` 一致（同 BUG-002 模式）。旧 `redactObservabilityList`（GET 脱敏）函数已删。
- **PUT 入参**：`kv-config-handlers.mergePut() → observability-redact.mergeObservabilityPlaceholderSecrets()` 识别哨兵——item.secretKey `=== "***"`（旧前端占位/未改）→ 按 item.id 回填落盘原值（不写空、不覆盖）；非哨兵真值 → 直接落盘明文。

> **observability 配置改动不热更新**：用户改列表（增/删/改/启停/改 logPhysical）→ 写 app_config → **当前进程的 manager 不变**，重启进程或下个 session 生效（见 `../agent/observability/[P0]observability_manager.md §7`）。UI 提示「重启生效」。**注意与 §3.10 jina secret 处理不同**——jina 仍走后端 GET redact，observability 自 v0.0.119.bugs2 起 GET 返回明文、mask 收敛前端。

### 3.10 web 组（web_fetch jina 内置管线）

**web_fetch 工具内置 jina 管线配置**（非插件自带，故归 app_config 而非 PluginConfig）。v0.0.89 从废弃的 `dev_config` 迁入（jinaApiKey secret redact 路径不变；jinaEnabled=true / jinaTimeoutMs=20000 默认值不变）。

```json
{ "group": "web", "key": "jinaApiKey", "data": "<jina api key>" }
{ "group": "web", "key": "jinaEnabled", "data": true }
{ "group": "web", "key": "jinaTimeoutMs", "data": 20000 }
```

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `jinaApiKey` | string (secret) | —（无） | jina reader API key。web_fetch jina 阶段用：**有则传**（`Authorization: Bearer` 或 `x-api-key`，按 jina 约定），**无则不传**（匿名调用，仍可用但受限）。secret 字段：落盘原值、**GET 出参 redact 为 `"***"`**（`web-config-redact.ts`，后端脱敏）、PUT 占位 `"***"` merge 保留原值 / 真值落盘。**与 §3.9 observability secretKey 不同**——observability GET 返回明文（mask 收敛前端），jina 仍后端 GET redact。 |
| `jinaEnabled` | boolean | true | web_fetch 是否走 jina 主力路径；false → 直走自托管兜底（隐私敏感/airgapped） |
| `jinaTimeoutMs` | number | 20000 | jina 调用超时 |

- 这些是 web_fetch **内置管线**的配置（jina 是工具内置能力一环），故归 app_config `web` group；**web_search 的 provider 凭证不在此**（走 `app_config.web_search` group，见 §3.6）。
- **消费方**：web_fetch 工具内置 jina 管线（`../agent/tools/[P1]web_fetch_tool.md §5.1`）。`jinaApiKey` 缺省（记录不存在）→ web_fetch jina 阶段不传 key（匿名）；`jinaEnabled` 缺省→ true。

> **代码层保留名偏离（已 verified reasonable）**：`JinaDevConfig` 类型名 + `JinaContentFetcherCtor.devConfig` 字段名保留（race-runner.ts:84 桥接 `devConfig: options.appConfig`）——避免 JinaContentFetcher 内部 API 连锁改名，仅注释级文档语义切换。语义已切 app_config.web group。

### 3.11 sub_agent_templates 组（v0.0.89 迁自 dev_config — SubAgent 模板列表）

**SubAgent 模板列表**（用户可配置的派生蓝图，详见 `../multi_agent/[P1]subagent_templates.md`）。v0.0.89 从 `dev_config` 迁入；handlers/dev-config-template-handlers 改名 `app-config-template-handlers`（svc 切 AppConfigService）；路由 `/config/dev` 删 + `/config/app/sub_agent_templates` 新增（在 `/config/app` 之前注册防前缀覆盖）；builtin explorer 保护逻辑保留（`builtin:true` 拒 403 + `group!==sub_agent_templates` 拒 403 `group_not_deletable`）。

```json
{
  "group": "sub_agent_templates",
  "key": "explorer",
  "data": {
    "name": "explorer",
    "description": "探索型子 agent——只读探查",
    "systemPrompt": "你是 explorer 子 agent...",
    "tools": ["read", "web_search", "web_fetch", "send_message"],
    "skills": [],
    "modelId": null,
    "builtin": true
  }
}
```

- **CRUD**：用户可 list / create / copy / edit / delete（builtin 除外）。复制 explorer → 改名改字段 → 存为新模板。
- **DELETE/PUT**：经 `/config/app/sub_agent_templates` 专用 handler（非通用 `/config/app` PUT），保留 builtin 保护 + group_not_deletable 校验。

### 3.12 agent 组（agent 调参）

```json
{ "group": "agent", "key": "maxIterations", "data": 25 }
{ "group": "agent", "key": "doomLoopThreshold", "data": 3 }
```

| key | 默认 | 说明 |
|---|---|---|
| `maxIterations` | 25 | `SessionConfig.maxIterations` 的默认来源（见 `../agent/session/[P0]session_store.md`） |
| `doomLoopThreshold` | 3 | 死循环检测阈值（连续相同 tool call 次数） |

v0.0.89 从废弃的 `dev_config` 迁入（group/key 名零变更，消费方 `buildSessionConfigFromDeps` 改读 `appConfig.get('agent', ...)`）。**这两 key 是可选覆盖调参**（见 §4「可选覆盖调参组」）：record 缺失时消费方走 `?? CODE_DEFAULT`（上表默认值即代码默认）。

### 3.13 context 组（context 调参）

```json
{ "group": "context", "key": "autoCompactThreshold", "data": 2000 }
{ "group": "context", "key": "maxOutputTokens", "data": 20000 }
```

| key | 默认 | 说明 |
|---|---|---|
| `autoCompactThreshold` | 2000 | ContextEngine compact 决策读取（见 `../agent/context/[P0]context_compact_detail.md`） |
| `maxOutputTokens` | 20000 | ContextWindowUsage 输出预算默认（`DEFAULT_MAX_OUTPUT_TOKENS`；见 `../agent/context/[P0]context_usage_detail.md §4` / `context_assemble_detail.md §7`） |

> head/tail 参数不在此组——它们是 `base_builder` reducer 的行为参数（换 reducer impl 即不同），归 base_builder 的 `ExtImpl.configSchema`（见 `../agent/context/[P0]context_assemble_detail.md §6`）。context 组只留全局调参。

v0.0.89 从废弃的 `dev_config` 迁入（group/key 名零变更，消费方 `ContextEngineOpts` 字段名保留 `appConfig`，形参改名 devConfig→appConfig）。**这两 key 是可选覆盖调参**（见 §3.14）：record 缺失时消费方走 `?? CODE_DEFAULT`。

### 3.14 权威值 vs 可选覆盖调参（两类语义并存）

app_config 的 group 分两类读取语义，同一 entity 内并存：

- **权威值组（大多数）**：`providers` / `web_search` / `default_models` / `appearance` / `consolidation` 等——值是**用户必填/唯一权威**，record 缺失 = 未配置，`AppConfigService.get()` 返回 `undefined`，**消费方不回退代码默认**（如 provider not found → 报错，不静默选默认；`consolidation` record 缺失 → boot 视为 `enabled=false`，不注册调度 job，见 §3.16）。
- **可选覆盖调参组（迁自废弃 dev_config 的技术参数）**：`agent` / `context` / `logs`（+ `llm_request` 走专服务默认，见 §3.4；+ `session` 为 v0.0.149 新增注入配额调参，见 §3.15）——技术调参、有合理代码默认、部署期定运行期少改，record 可稀疏。**record 缺失时消费方回退代码内默认值**（§3.8/§3.12/§3.13/§3.15 表中默认值即代码默认）：

```typescript
const maxIters = appConfig.get("agent", "maxIterations")     ?? CODE_DEFAULT_MAX_ITERATIONS;  // 25
const thr      = appConfig.get("context", "autoCompactThreshold") ?? CODE_DEFAULT_THRESHOLD;  // 2000
const logOn    = appConfig.get("logs", "enableLlmRequestLog") ?? false;                       // 关闭
```

差异只在**消费方用法**（调参组 `?? CODE_DEFAULT`，权威组视缺失为未配置）；`AppConfigService` 本身对两类一视同仁做裸 KV 读，不做域特化的默认回退。这些是全局默认；若未来需 per-session/per-run 覆盖，由各 consumer 自行 merge。

### 3.15 session 组（v0.0.149 新增 — skill/memory 注入配额 + v0.0.247 存储硬上限同 key 同源）

**system prompt 注入分层配额 + 磁盘存储硬上限**——同一组 key 同时驱动两条独立机制：注入侧（mapper 截 prompt 条数，v0.0.238 分层）+ 存储侧（service write 拒超限写入，v0.0.247 硬限）。两层**值同源**（共享 config + 默认值）但**概念解耦**（注入侧 `selectMemoriesByQuota`/`selectSkillsByQuota` 截 prompt；存储侧 `resolveMemoryStoreQuotas`/`resolveSkillStoreQuotas` 挡写入，独立 type `MemoryStoreQuotas`/`SkillStoreQuotas`）。单实例（`key` 固定 `"default"`），全局一份。

```json
{
  "group": "session",
  "key": "default",
  "data": {
    "maxMemoryInject": 50,
    "maxMemoryInjectGroup": 30,
    "maxMemoryInjectSession": 20,
    "maxSkillInject": 50,
    "maxSkillInjectGroup": 30,
    "maxSkillInjectSession": 20
  }
}
```

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `maxMemoryInject` | number | 50 | memory **global** 层配额（注入侧 mapper 取前 N；存储侧 writeLocked create 路径硬限） |
| `maxMemoryInjectGroup` | number | 30 | memory **group**（squad）层配额（同上，v0.0.238 注入 / v0.0.247 存储复用） |
| `maxMemoryInjectSession` | number | 20 | memory **session** 层配额（同上） |
| `maxSkillInject` | number | 50 | skill **global** 层（物理 app scope）配额（注入侧 selectSkillsByQuota；存储侧 executeCreate 硬限） |
| `maxSkillInjectGroup` | number | 30 | skill **group** 层配额（同上） |
| `maxSkillInjectSession` | number | 20 | skill **session** 层（物理 workspace scope）配额（同上） |

- **六 key 均 optional**：record 缺失 / 字段缺失时**消费方各层独立回退代码默认**（global 50 / group 30 / session 20），属「可选覆盖调参组」（§3.14 范式，对齐 `agent.maxIterations ?? CODE_DEFAULT` 语义——三层各做 `?? CODE_DEFAULT`，非整体回退）。AppConfigService 本身仍做裸 KV 读，不在此做域特化回退。
- **单实例**：`key` 固定 `"default"`，全局一份（跨 session 共享同一配额）。
- **注入侧消费方**（v0.0.238）：memory 三 mapper（`MemoryUserMapper`/`MemoryGroupMapper`/`MemorySessionMapper`）调纯函数 `selectMemoriesByQuota`（`memory/inject-quota.ts`）按 scope 分层独立截断；skills mapper（`SkillsMapper.map`）调 `selectSkillsByQuota`（`prompt/skills.ts`）按物理层归组（workspace→session / group→group / app→global / builtin 不计）。截断在 mapper/纯函数内闭环，不新增 PromptCtx 字段、不新增 reducer。
- **存储侧消费方**（v0.0.247）：memory `writeLocked` create 分支调 `resolveMemoryStoreQuotas` + `checkMemoryStoreQuota`（`memory/store-quota.ts`），超 `quotas[scope]` 抛 `MemoryQuotaExceededError`；skill `executeCreate` 调 `resolveSkillStoreQuotas` + `checkSkillStoreQuota`（`skills/store-quota.ts`），超限抛 `SkillQuotaExceededError`。仅 create 触发（update/archive/disable 不触发——否则 archive 自锁）；archived/disabled/builtin 不计；evolvable=false 计入配额（防绕过，错误文案如实告知）。详见 `../agent/memory/[P0]memory_definition.md §5.2` + `../agent/skills/[P0]skill_definition.md §6.4`。
- **key 名契约**：六个 key 是 mapper / store / UI KV_GROUPS 跨层对齐的 key 名权威源，不得改名。`maxXxxInject` = global 层（旧 key 语义从「三源总量」转为「global 层」，v0.0.238）；`maxXxxInjectGroup` / `maxXxxInjectSession` 为 v0.0.238 新增分层 key。
- **UI**：「应用设置 → 会话 tab → 注入配额 group」六 number input（按 memory/skill × 三层分组；详 `specs/ui/components/app-dev-config-page/section-session-config.md`）；缺失 record → draft 默认 `{maxMemoryInject:50, maxMemoryInjectGroup:30, maxMemoryInjectSession:20, maxSkillInject:50, maxSkillInjectGroup:30, maxSkillInjectSession:20}`。

### 3.16 consolidation 组（v0.0.151.t2_consolidate 新增 — 二级整理天级任务配置）

**二级整理（tier2）天级调度任务的用户配置**（详见 `../agent/memory/[P0]consolidation_tier2.md` + `../scheduling/[P1]consolidation_job.md`）。单实例（`key` 固定 `"default"`），全局一份。

```json
{
  "group": "consolidation",
  "key": "default",
  "data": {
    "enabled": false,
    "dailyTime": "04:00",
    "modelId": null
  }
}
```

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 是否启用天级整理任务；`false` → boot 时根本不注册调度 job |
| `dailyTime` | string (HH:mm) | `"04:00"` | 每天触发时刻（服务器本地时区）；→ cron expr `M H * * *` |
| `modelId` | string \| undefined | 未设置 | 整理 agent 使用的模型（纯 modelId ModelRef，反查 providerId 见 `consolidation_tier2.md §5.4`）；未设置 → 任务到点 fast finish 并记录跳过原因（非错误） |

- **仅记录用户可编辑配置**：本 group **不存放**执行状态（`lastFiredAt`/上次整理摘要）——那部分走独立的 `ConsolidationPersistenceAdapter`（`{dataDir}/consolidation/state.json`），与本组分离，理由见 `../scheduling/[P1]consolidation_job.md §2.1`（防 UI 保存配置时的 read-modify-write 覆盖系统执行状态）。
- **`enabled`/`dailyTime`/`modelId` 改动不热重载**：运行期修改本组只在下次进程重启后由 boot 装配生效（对齐 §3.9 observability 的既定"重启生效"语义），理由见 `../scheduling/[P1]consolidation_job.md §3`。
- **单实例**：`key` 固定 `"default"`，全局一份。
- **UI**：「应用设置 → 系统设置收起区 → 整理 tab」自渲染 group（enabled toggle + dailyTime 输入 + modelId 走 `KeyModelPicker`），详见 `specs/ui/components/app-dev-config-page/section-consolidation-config.md`。

### 3.17 skill_market 组（v0.0.166 新增 — skill 市场源凭证）

**skill 市场源（`skill_market_provider` exclusive EP）的可选凭证唯一介质**（详见 `../agent/skills/[P1]skill_market.md §10`）。单实例（`key` 固定 `"default"`），全局一份。**只放凭证，不存 type**——市场源是 exclusive EP，生效 impl 由 scope 配置 `selected` 决定（`app/plugins/scopes/default.yaml`），无需 app_config 侧 type 路由（对照 §3.6 web_search 组：那是 list EP 靠 `data.type` 路由，本组无 type）。

```json
{
  "group": "skill_market",
  "key": "default",
  "data": {
    "credentials": {
      "skills_sh": { "token": "<optional secret>" }
    }
  }
}
```

- **`data.credentials`**：`map<implId, { token?: string }>`，按 `skill_market_provider` ext impl 的 implId 索引（首个 impl = `skills_sh`）。**全部可选**——skills.sh 全端点匿名 200 可用，`token` 仅未来提额度用，当前不依赖（`isAvailable` 恒 true，无 token 也能搜/装）。
- **无 `type` 字段**：exclusive EP 靠 scope `selected` 选源，`resolveSkillMarketProvider` 取 `getExtensionImpls(SkillMarketProviderPoint)[0]`（≤1 active），凭证按 `provider.id` 索引 `credentials[id] ?? {}`——不做 type 路由（详见 `[P1]skill_market.md §5`）。
- **单实例**：`key` 固定 `"default"`，全局一份。
- **缺失语义**：record 缺失 / `credentials` 缺失 = 无凭证 → cfg 传空 `{}`（匿名可用，不报错、不回退）。属「凭证型」组——缺失不阻断（对照 web_search 的 type 缺失即报错，本组 token 缺失不报错）。
- **消费方**：`skill-manage` tool 的 `resolveSkillMarketProvider`（`app/server/src/tools/skill-market/resolve.ts`）+ `/skills/market/*` handler 经 `AppConfigService.get("skill_market", "default")` 读 `data.credentials?.[provider.id] ?? {}` 传入 provider 的 `search`/`getDetail`/`fetchSkillFiles`/`isAvailable`。
- **不在本组**：市场源的 exclusive 选择（`selected: skills_sh`）走 `app/plugins/scopes/default.yaml` 的 `skill-market` group block（非 app_config）；UI 元数据走 `app/plugins/groups.json` 的 `skill-market` group。

## 4. 持久化

经 persistence CrudStore 落盘（engine: file，按 group 分片，format json）。CRUD 不在本文。读取按 (group, key)；group 既是分片键也是 tab。

## 5. 服务层：AppConfigService

AppConfig 域的逻辑服务是 `AppConfigService`——一个**通用 KV** get/set，按 `(group, key) → data`：

```typescript
interface AppConfigService {
  /** 取某 (group, key) 的 data；记录不存在返回 undefined（视为未配置） */
  get(group: string, key: string): unknown | undefined;
  /** 写某 (group, key) 的 data（创建/更新 KV record） */
  set(group: string, key: string, data: unknown): void;
  /** 整组提交：原子写该 group 全部 key（其他 group 不受影响） */
  setGroup(group: string, items: { key: string; data: unknown }[]): void;
}
```

- **底经 CrudStore**（entity = `app_config`），无业务特化。
- **权威组** record 缺失即未配置——service 不做「缺省→默认」回退；**可选覆盖调参组**（agent/context/logs，迁自废弃 dev_config）由消费方侧 `?? CODE_DEFAULT` 处理，service 仍只做裸 KV 读（见 §3.14）。
- **`setGroup`**：按 group shard 批量 upsert（原子：该 group 内 items 全成功或全失败）；**其他 group record 完全不读不写**。供 UI「保存该 group」用（PRD §3.9.2）。底经 CrudStore 按 group shard 目录批量写。
- HTTP facade 由 specs/api 统一对外（按域分路由），本文不定义端点。

### 5.1 内存读缓存（KvConfigService 基类内置）

`KvConfigService`（`app/server/src/config/kv-config-service.ts`）持有二级读缓存 `cache: Map<group, Map<key, data>>`：

- **lazy fill**：`get()` / `listGroup()` 先经 `ensureGroupCache(group)`——首次访问某 group 时 query 整 group shard 一次，构建 `key→data` Map 填入；已缓存（`cache.has(group)`）则零 fs 直接取 Map。group 无 record 时填**空 Map**，区分「未缓存」与「已缓存但空」。
- **write-through invalidate**：`set()` / `setGroup()` / `delete()` 写后调用 `invalidateGroup(group)` 删整组缓存条目，下次 get lazy 重填，保证缓存与磁盘一致。
- **范围**：缓存只服务读路径（get/listGroup）；`findRecord()`（set/delete 内部需 record id）不走缓存，仍直接 query 该 group shard。
- **不持久化**：纯进程内存，重启即空。

> 变更历史见 [`log.md`](log.md)；跨版本发布说明见 [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)。
