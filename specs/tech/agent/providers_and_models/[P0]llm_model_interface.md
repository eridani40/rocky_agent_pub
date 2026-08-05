---
type: interface
title: LLM Model Interface
priority: P0
status: active
updated: 2026-07-14
since: v0.0.3
related: [[P0]llm_protocol_interface.md, [P0]llm_provider_interface.md, [P0]llm_client_interface.md]
---

# LLM Model Interface

> 管什么：模态支持、模型能力、context window、max output、参数取值约束（默认值/范围/上限）、定价。
> 不管什么：请求怎么编码、参数字段名（→ `[P0]llm_protocol_interface.md`）、凭证与入口（→ `[P0]llm_provider_interface.md`）。
> 边界归属规则见 [docs_guide.md](../../docs_guide.md) §4。

## 1. 概述

Model 解决"**这个模型能做什么、有什么约束、值多少钱**"。**`LlmModelConfig` 是 app_config 数据**（不是代码固有的属性声明）——它是 app_config `providers` 组某条实例 `models[]` 的一条 record，由 app_config 配置/持久化。字段名与编码方式不在本文件（归 protocol impl）。

**[v0.0.53]** 一个 modelConfig **引用**（不是绑定）一个 provider 实例：`providerId`（→ app_config provider 实例，即 `LlmProviderConfig.id`）；protocol 选择**不再归 model**——`LlmProviderConfig.protocolId` 是 protocol 选择的唯一事实源（1 provider : 1 protocol 锁定，见 `[P0]llm_provider_interface.md §3.4`）。模型 ID 在 wire 上由 protocol 带出（`request.modelId`），能力/约束/定价由 modelConfig 数据提供。

## 2. 接口定义

```typescript
/**
 * modelConfig = app_config 数据（providers 组某条实例 models[] 的一条 record）。
 * 不是代码固有属性——由 app_config 配置/持久化。见 config/[P0]app_config.md §3.2。
 */
interface LlmModelConfig {
  modelId: string;                  // wire 模型标识："claude-sonnet-4-6"
  inputModalities: Modality[];      // 支持的输入模态
  outputModalities: Modality[];     // 支持的输出模态
  contextWindow: number;            // 上下文窗口（token）
  maxOutputTokens: number;          // 单次最大输出（token）—— [v0.0.25] 同时是 capabilities.maxOutputTokens 的 alias（向后兼容）
  /** [v0.0.25] length 处理能力位（供 LlmCaller buildRequest 决策） */
  capabilities: ModelCapability;
  paramConstraints: ParamConstraints;
  pricing: Pricing;
  providerId: string;               // → app_config providers 组某条 provider 实例（LlmProviderConfig.id = **record.data.id**）
  // [v0.0.53] protocolId 已迁出 → LlmProviderConfig.protocolId（1 provider : 1 protocol 锁定，单一事实源）
  // [v0.0.143] per-model default 字段已删除（死字段无消费方；playground 默认模型改用 app_config/default_models）
}

/** [v0.0.25] 模型能力位（length 处理决策依据） */
interface ModelCapability {
  /** 单次最大输出（token）—— 与顶层 maxOutputTokens 同值（alias，迁移期双路径可读） */
  maxOutputTokens: number;
  /** 是否支持 prefill 续写（partial assistant turn 续接）—— Anthropic Messages API 支持，OpenAI 不支持 */
  supportsPrefill: boolean;
  /** 是否支持 extended thinking（reasoning）—— 影响是否产 thinking_delta */
  supportsThinking: boolean;
}

type Modality = "text" | "image" | "audio" | "video";

interface ParamConstraints {
  temperature?: { default: number; min: number; max: number };
  topP?: { default: number; min: number; max: number };
  // 上限用 maxOutputTokens 字段，此处不重复
}

interface Pricing {
  inputPerMillion: number;                // 原币种 / 1M tokens（币种见 currency）
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  currency: Currency;                     // "USD" | "CNY"，见 convention.md §5
}
```

### 模态矩阵

模态分输入/输出两侧独立声明：

| 模态 | 输入 | 输出 |
|------|------|------|
| text | 几乎全部模型 | 几乎全部模型 |
| image | vision 模型 | （生成模型，暂多数不支持） |
| audio | 语音模型 | TTS / 语音模型 |
| video | 少数多模态模型 | 极少 |

> "是否支持某模态"归 model；"该模态怎么编码进请求"归 protocol（见 `[P0]llm_protocol_interface.md` §2）。

## 3. 设计决策

### 3.1 参数只管"取值"，不管"字段名"

**结论**：`ParamConstraints` 只给 temperature/topP 的默认值/范围；字段名（`max_tokens` vs `max_completion_tokens`）归 protocol，输出上限用独立的 `maxOutputTokens` 字段。
**理由**：取值随模型变（model），字段名随接口变（protocol），拆开后两文件独立演化。
**反例**：把字段名写进 model，会让同 protocol 下换模型时连字段名都得改。

### 3.2 context window / max output / 定价归 model

**结论**：这三者是模型固有属性，唯一归属 model。
**理由**：它们直接决定上下文预算（→ `context`）、输出截断、`Usage.cost`（→ `[P0]agent_message_interface.md` §2），只能由 model 提供。
**反例**：若 context window 归 protocol，同 protocol 不同模型会被误判为同窗口。

### 3.3 prompt caching 支持由 pricing 字段隐含

**结论**：不再单设能力标志；模型是否支持 prompt caching 由 `Pricing.cacheReadPerMillion` / `cacheWritePerMillion` 是否存在隐含表达；启用缓存的**开关字段**归 protocol。
**理由**：缓存是计费属性——有缓存定价就说明支持，无须重复声明能力标志。
**反例**：若同时维护 capability flag 与 pricing 字段，二者可能不一致。

### 3.4 modelConfig（数据）引用 provider 实例

**结论**：modelConfig 是 **app_config 数据**，通过 `providerId` 引用一个 app_config provider 实例（`LlmProviderConfig`）。这是「数据引用代码身份」的关系，不是 model 代码绑定 provider 代码。**[v0.0.53]** protocol 选择不再归 model（迁到 `LlmProviderConfig.protocolId`，1 provider : 1 protocol 锁定）；modelConfig 只引用 provider 实例，间接继承其 protocol。
**理由**：同一模型（如 Llama）在不同 provider 下能力/定价/限流不同，必须挂到具体 provider 实例；provider 本身是代码身份（string），modelConfig 只持有引用，不需要 ULID 关联到独立持久化的 model record。protocol 与 provider 锁定（path+baseUrl 必须同实体），故 model 不需要单独持有 protocolId。
**反例**：脱离 provider 谈"通用 Llama 模型"会丢失定价与可用性信息；若把 modelConfig 当代码固有属性声明，则换接入点/换定价都要改代码而非改 app_config。**[v0.0.53 反例]** 若 model 仍持有 protocolId（旧设计），「请求去哪儿」事实源跨实体（path→protocol impl、baseUrl→provider config、选哪个 protocol→model），且换 protocol 要改每个 model。

> **providerId = `record.data.id`，不是 provider 配置文件名**：`POST /messages` / `POST /session/:id/chat` 等 API 的 `providerId` 参数，server 在 provider 查找链里用的是 `LlmProviderConfig.id`，即 providers 组 record 的 **`data.id` 字段**——**不是** provider 配置文件名（文件名 = `record.id`，去 `.json`）、**不是** record.key 字段（虽然 record.key 常与 data.id 重合）。陷阱实例：MiniMax 配置文件名 `01KVJMPG2FA9ZSWDND60HV56N2.json`，但 server 认的 `data.id` 是 `01KVJMPG2EZ1078MCT9JH4J5HG`——用文件名当 providerId 会得「provider not found」。验证用例解析真实 providerId 须调 `tests/api/lib/provider_resolve.py::resolve_real_provider`（返回 data.id），勿硬编码文件名。

### 3.5 ModelCapability 能力位

**结论**：`LlmModelConfig.capabilities: { maxOutputTokens, supportsPrefill, supportsThinking }`，per-model 事实（app_config 数据）。
**理由**：length 处理（LlmCaller buildRequest）需知道模型是否支持 prefill 续写（决定 MAX_TOKENS_EXCEEDED 走 prefill 还是 bump）和 supportsThinking（影响 stall 阶段判定）；这些是模型固有特性，归 modelConfig（与 pricing / contextWindow 同级），不归 protocol（protocol 只管编码不管能力）。
**反例**：若 supportsPrefill 写进 protocol impl，同 protocol 下不同模型能力差异无法表达（如 anthropic_messages 下 claude-* 支持 prefill，但 minimax 同 protocol 可能不支持）；若写进 config（llm_request），per-model 事实被全局化，错配。
**向后兼容**：顶层 `maxOutputTokens` 保留（= `capabilities.maxOutputTokens` alias，迁移期双路径可读，避免破坏现有 modelConfig JSON）。
**初始值**（待实测调整）：Anthropic claude-* = `{supportsPrefill:true, supportsThinking:true}`；OpenAI gpt-* = `{supportsPrefill:false, supportsThinking:false}`；GLM = `{supportsPrefill:false, supportsThinking:false}`（待实测）。

## 4. 示例

以下 JSON 是 **app_config `providers` 组某条实例 `models[]` 中的一条**（即一个 modelConfig；不含外层 provider 实例壳，仅展示 modelConfig 字段）：

```json
{
  "modelId": "claude-sonnet-4-6",
  "inputModalities": ["text", "image", "audio", "video"],
  "outputModalities": ["text"],
  "contextWindow": 200000,
  "maxOutputTokens": 16000,
  "paramConstraints": {
    "temperature": { "default": 1.0, "min": 0, "max": 1 },
    "topP": { "default": 0.999, "min": 0, "max": 1 }
  },
  "pricing": {
    "inputPerMillion": 3.0,
    "outputPerMillion": 15.0,
    "cacheReadPerMillion": 0.3,
    "cacheWritePerMillion": 3.75,
    "currency": "USD"
  },
  "providerId": "01KVC9A2T3KQ9E1P0M4N7X8Y2Z"
}
```

> **[v0.0.53]** `protocolId` 已从此 JSON 删除（迁到外层 provider 实例的 `data.protocolId`，见 `[P0]llm_provider_interface.md §4` 示例）。

## 5. 边界

| 零件 | 归属 |
|------|------|
| modelConfig 数据（modelId/modalities/contextWindow/maxOutput/paramConstraints/pricing） | 本文件（= app_config providers.models[] 一条）✅ |
| 模态是否支持 | 本文件 ✅ |
| 参数默认值/范围/上限 | 本文件 ✅ |
| 定价 | 本文件 ✅ |
| 参数字段名映射、多模态编码、system 落点（protocol impl 代码常量） | `[P0]llm_protocol_interface.md` |
| base URL、credentials、auth header（app_config provider 实例 + provider impl 代码） | `[P0]llm_provider_interface.md` |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../../version_logs/)（跨版本发布说明）。
