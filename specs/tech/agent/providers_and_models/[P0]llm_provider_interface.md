---
type: interface
title: LLM Provider Interface
priority: P0
status: active
updated: 2026-07-02
since: v0.0.3
related: [[P0]llm_protocol_interface.md, [P0]llm_model_interface.md, [P0]llm_client_interface.md]
---

# LLM Provider Interface

> 管什么：凭证 + 接入点 + auth header 构造（provider 自带方法）。
> 不管什么：请求长什么样（→ `[P0]llm_protocol_interface.md`）、哪个模型（→ `[P0]llm_model_interface.md`）。
> 边界归属规则见 [docs_guide.md](../../docs_guide.md) §4。

## 1. 概述

Provider 解决"**以谁的身份、从哪个入口**"发起调用。它是 `llm_provider` 扩展点的一个 **ext impl（代码，per-type，无状态）**：

- **`LlmProviderConfig`（数据，per-instance）**：**不是独立持久化 record 概念，而是 app_config `providers` 组一条实例的内部形状**——承载 `id` / `name(ProviderName)` / `baseUrl` / `credentials` 等接入点信息，外加该实例的 `models[]`（每条 = 一个 modelConfig）。数据归 app_config（见 `config/[P0]app_config.md` §3.2）。
- **`LlmProvider`（行为契约，per-type，无状态）**：只暴露 `buildAuthHeaders(config)`，读 `config.credentials.key` 拼 auth header。provider impl **不存 config**——config 作参数传入。

凭证归 config（app_config 数据）不归行为；行为依赖 config 参数。调用方只调 `provider.buildAuthHeaders(providerConfig)`，不感知 header 细节。

**[v0.0.53] 1 provider : 1 protocol 锁定**——`LlmProviderConfig` 持有 `protocolId`（必填，指向 `llm_protocol` ext impl），一个 provider 实例只对接一种 protocol。理由：protocol impl 挂 path、provider 挂 baseUrl，二者必须同实体；同 provider 若挂多 protocol 则每个 protocol 对应不同 baseUrl，无法共享同一 provider 实例（见 §3.4 + `index.md §④` 原则 6）。

## 2. 接口定义

```typescript
/**
 * provider 数据（per-instance）= app_config providers 组一条实例的内部形状。
 * 不是独立持久化 record——其承载者/落盘机制见 config/[P0]app_config.md §3.2。
 */
interface LlmProviderConfig {
  id: string;                    // 实例 id（= app_config providers 组 record key）
  name: ProviderName;            // 标识哪家接入方（按鉴权协议族）= 指向哪个 llm_provider ext impl
  /** [v0.0.53] 指向哪个 llm_protocol ext impl（ProtocolName）。1 provider : 1 protocol 锁定，必填。
   *  归属迁移自 LlmModelConfig.protocolId（旧字段已物理删除，单一事实源）。
   *  factory 按 this 字段查 PluginManager.getExtensionImpls(llm_protocol) 命中 implId 动态实例化。 */
  protocolId: ProtocolName;
  baseUrl: string;               // e.g. "https://api.anthropic.com"
  /** 凭证。[v0.0.25] 单 key 或多 key union（向后兼容） */
  credentials: { key: string } | { keys: CredentialKey[] };   // CredentialKey 见 §3.3
  // 注：完整实例还含 pluginId / enabled / models[]（= 该实例的 modelConfig 列表），
  //     见 config/[P0]app_config.md §3.2；此处只列 provider impl 关心的最小字段。
}

/** provider 行为契约（per-type，无状态，不存 config） */
interface LlmProvider {
  /** 用 providerConfig.credentials 构造 auth header；config 作参数传入，impl 不持有。
   *  [v0.0.25] keyRef 可选：多 key 时选指定 keyRef（fallback chain 引用）；单 key 忽略。 */
  buildAuthHeaders(config: LlmProviderConfig, keyRef?: string): Record<string, string>;

  /** [v0.0.350] 额度/余额查询能力（可选方法）：null = 该 impl 无额度能力（anthropic_compatible
   *  不实现 = undefined 天然兼容）。仅 4 native coding plan impl 实现。
   *  无状态：config（含 baseUrl/credentials）作入参；查询域从 config.baseUrl 推导（§3.5）。
   *  统一输出 QuotaSnapshot（api spec 02-llm-chat §5.6 形状）；15s 超时；
   *  单渠道失败 throw（由聚合 handler 转 item.error，不炸整体）。 */
  queryQuota?(config: LlmProviderConfig): Promise<QuotaSnapshot | null>;
}

type ProviderName =
  | "anthropic_compatible"   // Anthropic 直连及兼容端点（通用，v0.0.3 既有缺省值）
  | "openai_compatible"      // OpenAI / OpenRouter / Together / Ollama 等 Bearer 系（占位，未实现）
  | "glm"                    // 智谱 GLM（占位，未实现）
  // [v0.0.350] 4 native coding plan 类型（已实现，见下方实现表；POST/PUT /provider 白名单校验）
  | "kimi_coding_plan"       // Kimi Coding Plan（协议 anthropic_messages + 额度查询）
  | "glm_coding_plan"        // 智谱 GLM Coding Plan（同上；额度查询鉴权裸 api_key）
  | "minimax_coding_plan"    // MiniMax Coding Plan（同上）
  | "deepseek_api";          // DeepSeek（按量付费，余额型查询）
```

### buildAuthHeaders 各 provider 实现

每个具体 provider 实现接收 `config`、读 `config.credentials.key`，逻辑互不相同：

| Provider type | buildAuthHeaders(config) 实现 | queryQuota [v0.0.350] |
|----------|------------------------|------------------|
| `anthropic_compatible` | `{ "x-api-key": config.credentials.key, "anthropic-version": "2023-06-01" }` | —（不实现） |
| `openai_compatible` | `{ "Authorization": "Bearer " + config.credentials.key }`（占位） | — |
| `glm` | 把 `config.credentials.key` 解析后签名为 JWT → `{ "Authorization": "Bearer " + jwt }`（占位） | — |
| `kimi_coding_plan` | 同 anthropic_compatible（extends 复用） | ✅ `GET {baseUrl}/v1/usages`（Bearer）；limits[0]→5h 桶 + usage→周桶；used 直读优先/limit−remaining 兜底；字符串数值兼容；membership.level 透出 |
| `glm_coding_plan` | 同 anthropic_compatible（extends 复用） | ✅ `GET {推导域}/api/monitor/usage/quota/limit`（**裸 api_key 无 Bearer**）；过滤 type∈{TOKENS_LIMIT,CREDIT_LIMIT}；分桶只锚 unit（3→5h、6→周）；percentage 直读已用%；TIME_LIMIT 忽略；data.level 透出 |
| `minimax_coding_plan` | 同 anthropic_compatible（extends 复用） | ✅ `GET {推导域}/v1/api/openplatform/coding_plan/remains`（Bearer）；只取 model_name=="general"；已用%=100−remaining%；周桶仅 current_weekly_status==1 |
| `deepseek_api` | 同 anthropic_compatible（extends 复用） | ✅ `GET {origin}/user/balance`（Bearer）；balance_infos[]（字符串金额）+ is_available；kind=balance 无 tiers |

> [v0.0.350] 4 native impl 物理归属：`app/plugins/builtins/llm_anthropic/`（provider-kimi/glm/minimax/deepseek.ts + quota-shared.ts helper）；plugin.json extImpls +4（point=llm_provider）。解析规则权威 = `specs/research/v0.0.350-live-verify.md`（四渠道真调实测）+ cc-switch 对照（coding_plan.rs）。**MUST NOT** 任何校验逻辑依赖响应 model 回显（glm 请求 5.2 回显 5.3 实测）。

> header 逻辑随 provider 实现走，调用方只调 `provider.buildAuthHeaders(providerConfig)`，不感知差异。后续若需 token 刷新等方法，在 `LlmProvider` 接口扩展。

## 3. 设计决策

### 3.1 config（数据，per-instance，挂 app_config）与 behavior（buildAuthHeaders，无状态代码）分离

**结论**：`LlmProviderConfig` 是 **app_config `providers` 组一条实例的内部数据形状**（id / name / baseUrl / **credentials**），随 app_config 持久化/迁移/替换，per-instance；`LlmProvider` 是 **`llm_provider` 扩展点的 ext impl（代码，per-type，无状态）**，只持有 `buildAuthHeaders(config)`，按 type 复用同一份实现。行为通过**入参** `config` 读取凭证，**impl 自身不存 config**。少数行为可配置项（如 extra headers）→ `ext_impl_config` overlay（deepMerge 代码默认 ⊕ overlay），P0 基本只用代码默认。
**理由**：凭证/接入点会随部署环境、租户、轮转而变（per-instance 数据），而 header 构造逻辑只按鉴权协议族区分（per-type 代码）。把两者塞进同一对象会让"换凭证/换接入点"与"换实现"耦合，且凭证无处随 app_config 独立持久化/隔离。
**反例**：若凭证塞进 provider impl 的可变字段，则切换凭证必须重建实例，且 impl 不再无状态、无法按 type 缓存复用；若行为塞进 config 数据，则同 type 的多个实例要各存一份相同的 buildAuthHeaders 逻辑。

### 3.2 auth header 归 provider，按鉴权协议族分 type

**结论**：auth header 构造完全归 `LlmProvider.buildAuthHeaders(config)`，provider type 按鉴权**协议族**划分（`anthropic_compatible` / `openai_compatible` / `glm`），不按具体公司划分。
**理由**：鉴权方式只分几族（`x-api-key` 系 / `Bearer` 系 / GLM 的 JWT 系），同一族内 OpenAI 直连、OpenRouter、Ollama 等都是 `Bearer` + 不同 baseUrl，没必要各占一个 type；用方法封装让调用方与 header 细节解耦。
**反例**：若按公司分 type（anthropic/openai/openrouter/ollama…），`openai_compatible` 一族要重复定义相同 Bearer 实现；若 auth 归 protocol，则同 protocol 下换鉴权族无法表达。

### 3.3 凭证 union（单 key 向后兼容 + 多 key 扩展）

**结论**：`credentials` 是 union——单 key `{ key }` 或多 key `{ keys: CredentialKey[] }`。
**理由**：保持 config 状态最小、统一（凭证如何被使用是 provider 实现细节）；同时支持 fallback chain 的「换 key = 换 provider」统一元组——多 key 让一个 provider 实例挂多个独立凭证。
**反例**：若为每种 provider 定义不同的 credentials 结构，`LlmProviderConfig` 会变成 discriminated union，失去统一持久化形态。

```typescript
type CredentialConfig =
  | { key: string }                                    // 单 key（向后兼容）
  | { keys: CredentialKey[] };                         // 多 key

interface CredentialKey {
  keyRef: string;            // 引用名（"default" / "backup" / "pool-1"），fallback_chain 引用
  keyValue: string;          // 实际 key（或 env var 引用 "${ENV_VAR}"）
  quotaScope: "per_key" | "account_wide";   // quota 作用域：per-key（可轮换）vs account-wide（不轮换，hermes 教训）
  weight?: number;           // 选择权重（默认 1）
}
```

**向后兼容**：单 key `{ key: "sk-..." }` 等价于 `{ keys: [{ keyRef:"default", keyValue:"sk-...", quotaScope:"per_key" }] }`。`buildAuthHeaders` 读时统一化（接受可选 keyRef 参数）。

**为什么 union 而非强制多 key**：单 key 配置广泛存在，强制迁移会破坏现有配置；union 让单 key 继续工作，多 key 是 opt-in。

**完整 schema + keyRef 选择器 + account-wide quota 例外决策** 见 `../llm_caller/[P0]llm_request_config.md §3-§4`。

### 3.4 base URL + protocolId 选择归 provider（app_config 数据），path 归 protocol impl（代码）

**结论**：完整 URL = `providerConfig.baseUrl`（app_config 数据）+ `protocol.path`（protocol impl 自承载的代码常量）；**`protocolId`（选哪个 protocol impl）也归 `providerConfig`**（per-instance 数据，必填）——1 provider : 1 protocol 锁定。
**理由**：base 随接入点变（per-instance，直连 vs 自部署，归 app_config），path 随接口契约变（per-type，归 protocol impl 代码），两者独立演化；但「选哪个 protocol（即选哪个 path）」必须与 baseUrl 在同一实体——同一 provider 若挂多 protocol 则每个 protocol 对应不同 baseUrl（如 anthropic_messages 拼 `/v1/messages` vs openai_chat_completions 拼 `/v1/chat/completions` 通常 baseUrl 不同），无法共享同一 provider 实例。
**反例**：把 path 写进 provider 数据会导致换 protocol 时连 provider 一起改；把 baseUrl 塞进 protocol impl 则同 protocol 不同接入点无法表达；**把 `protocolId` 放到 modelConfig**（v0.0.53 前的旧设计）会让「请求去哪儿」的事实源跨实体分裂（path 来源 protocol impl + baseUrl 来源 provider config，但选哪个 protocol 由 model 决定 → 三实体协调），且强制 model 列表与 protocol 耦合（换 protocol 要改每个 model）。
**[v0.0.53] 迁移要点**：旧 record 顶层无 `protocolId` → 数据迁移函数从 `models[0].protocolId` 抄（本就同值 `anthropic_messages`）；旧 `models[].protocolId` 物理删除（避免 dead code）。详见 `specs/tech/version_logs/v0.0.53/change_log.md §3`。

### 3.5 [v0.0.350] native coding plan 类型：preset + 额度查询归 per-type impl

- **类型划分补充**：4 native coding plan 类型按「preset + 额度查询能力」维度划分（鉴权协议族同 anthropic_compatible——buildAuthHeaders extends 复用，不违背 §3.2 协议族原则）；差异只在 per-type preset（默认 baseUrl/默认模型，**前端持有**，后端不感知）与 queryQuota 能力（impl 实现）。
- **查询域推导**（保持用户改 baseUrl 的灵活性，R5 采纳）：纯函数 `deriveQuotaBaseUrl(implId, baseUrl)` 子串匹配——kimi=baseUrl 原样；glm 含 `bigmodel.cn`→`https://open.bigmodel.cn` 否则 `https://api.z.ai`；minimax 含 `minimax.io`→国际域否则 `api.minimaxi.com`；deepseek 取 origin。
- **impl 注册顺序约束**：default scope llm_provider impls 中 anthropic_compatible **必须首位**（llm-client-factory 未命中回退 providers[0]，mock fixtures 依赖）。
- **额度查询消费方**：`GET /provider/quota` 聚合端点（handlers/provider-quota.ts，Promise.all 并发 + 单渠道错误隔离）；前端 5min 轮询 + LastGoodSnapshot 失败保留（server 不缓存不落盘）。

## 4. 示例

以下 JSON 是 **app_config `providers` 组一条 record 的 `data`**（不含 record 外层 `group`/`key`，仅展示 provider impl 关心的字段；完整实例含 `pluginId`/`enabled`/`models[]`，见 `config/[P0]app_config.md` §3.2）：

```json
{
  "id": "01KVC9A2T3KQ9E1P0M4N7X8Y2Z",
  "name": "anthropic_compatible",
  "protocolId": "anthropic_messages",
  "baseUrl": "https://api.anthropic.com",
  "credentials": { "key": "sk-ant-***" }
}
```

OpenAI 兼容端点示例（同一 type，不同 baseUrl 即可覆盖 OpenAI 直连 / OpenRouter / Ollama）：

```json
{
  "id": "01KVC9B5P0M4N7X8Y2Z3KQ9E1",
  "name": "openai_compatible",
  "protocolId": "openai_chat_completions",
  "baseUrl": "https://openrouter.ai/api",
  "credentials": { "key": "sk-or-***" }
}
```

GLM 示例：

```json
{
  "id": "01KVC9C1P0M4N7X8Y2Z3KQ9E",
  "name": "glm",
  "protocolId": "glm_generateContent",
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "credentials": { "key": "xxx.yyy" }
}
```

## 5. 边界

| 零件 | 归属 |
|------|------|
| base URL、`credentials.key`、**`protocolId`（数据）**（app_config 数据） | `LlmProviderConfig`（app_config providers 组一条实例）✅ `[v0.0.53]` |
| auth header 构造（`buildAuthHeaders`） | `LlmProvider` impl（本文件，无状态代码）✅ |
| 少数行为可配置项（extra headers）→ overlay | `ext_impl_config`（plugin_system） |
| URL path、`label`（protocol 展示名）（protocol impl 自承载代码常量） | `[P0]llm_protocol_interface.md` |
| request body / 参数字段名 / 多模态编码 | `[P0]llm_protocol_interface.md` |
| 模型 id / context window / 定价 | `[P0]llm_model_interface.md` |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../../version_logs/)（跨版本发布说明）。
