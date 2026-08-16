---
type: index
title: Providers & Models 子系统总起
priority: P0
updated: 2026-07-31
---

# Providers & Models 子系统总起

## ① 是什么

providers_and_models = **LLM 调用的「4 件套」声明层**——定义「以谁的身份、从哪个入口、按什么协议、调哪个模型」四份独立契约，再加一个**组合层（LlmClient）**把 4 件套绑成一次真实 HTTP 调用。每份契约**正交演化**：换凭证不动协议、换协议不动模型、换模型不动接入点。是 agent 调 LLM 的最底层机制（机制层）；上层 `llm_caller/` 是策略层（retry/降级/超时）。

| 核心概念 | 一句话 |
|---|---|
| **4 件套** | providerConfig（数据）+ provider（代码）+ protocol（代码）+ modelConfig（数据），LlmClient 构造期绑定不可变 |
| **provider** | 凭证 + 接入点 + auth header（`LlmProviderConfig` 数据 + `LlmProvider` 无状态行为，按鉴权协议族分 type） |
| **protocol** | endpoint path + 请求 body + 参数字段名 + 多模态编码 + 解析（`LlmProtocol`，标准值自承载为代码常量） |
| **model** | 模态 / 能力 / context window / max output / 参数取值 / 定价（`LlmModelConfig` 数据） |
| **client** | 组合层：4 件套 → `call()` / `stream()` 真实 HTTP（不可变共享，async 并发安全） |
| **ext impl** | provider / protocol 各是项目扩展点（`llm_provider` / `llm_protocol`）的一个 impl（per-type，无状态代码） |
| **anthropic_messages** | 当前唯一实现的 protocol impl（同时服务 Anthropic 原生 + minimax 兼容端点） |
| **credentials union** | 单 key `{key}` ↔ 多 key `{keys[]}`（v0.0.25 多 key 支持 fallback chain 换 key） |
| **cache_control** | protocol encode 层策略：三断点注入显式 breakpoint（bp#1 system 末 + bp#T tools 末 + bp#2 messages 末固定末位），历史 reminder 块 append-only 全保留，保稳定段 prompt cache 命中 |
| **model resolve** | v0.0.89 统一 resolve 入口：`resolveModel({sessionType,session,squad,classroom}) → {providerId,modelId}`；v0.0.155 ModelRef 复合（`{providerId?, modelId}`）+ resolve 链去 member.model + `resolveDefaultModel` 单点出口（INV-A1/A2/A5/B1）；**v0.0.158 删「独立 summary 模型」层——chat 单链 + 唯一入口 `agentManager.resolveConfigBySid(sid)`**（chat/手动 compact/自动 compact/T1 记忆整理都从此入口取 config；无 `task` 参数、无 body override）；**v0.0.230 academy 收窄两档链 `session → classroom.defaultModel → throw`**（去 app 默认兜底——app 默认是 playground 个体级概念，群体级无应用层默认；playground → `default_models.chat` / studio → `squad.modelDefault` / academy → `classroom.defaultModel`）；保留字 `default`/`""`/`undefined` 视为「继续 fallback」；fallback 链跑空抛 `ModelNotConfiguredError`（detail 只含 sessionType，无 task 字段） |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| 4 件套接口契约（provider/protocol/model/client）+ 字段 + 设计决策 | retry / 降级 / 超时 / 看门狗（→ `../llm_caller/`） |
| provider/protocol 扩展点 impl 约定（default export 类、implId、cfg overlay） | agent loop 驱动 / callLLM 接入（→ `../agent_interface_and_loop/`） |
| credentials union + CredentialKey（keyRef/quotaScope/weight）+ resolveKey | 错误归一化 / classify / LlmErrorCategory（→ `../llm_caller/[P0]error_normalization.md`） |
| LlmClient 不可变共享契约 + 4 件套组合缓存复用 | fallback_chain 结构 / resolveTarget 选 target（→ `../llm_caller/[P0]llm_request_config.md` / `[P0]llm_caller.md`） |
| anthropic_messages impl（encode/parse/parseStream + cache control + usage 映射） | app_config providers 组 schema / 持久化（→ `../../config/[P0]app_config.md §3.2`） |
| ModelCapability 能力位（supportsPrefill/Thinking + maxOutputTokens alias） | length 处理决策树（→ `../llm_caller/[P0]length_handling.md`） |

## ③ 与系统的关系

```
   app_config providers 组（per-instance 数据：id/name/baseUrl/credentials/models[]）
       │
       │ resolveProviderConfig 聚合（代码默认 ⊕ app_data）
       ▼
   PluginManager.getExtensionImpls(llm_provider / llm_protocol)
       │
       │ 按 providerConfig.name（→ llm_provider impl）/ providerConfig.protocolId（→ llm_protocol impl）动态取 impl `[v0.0.53]`
       ▼
   llm-client-factory.buildLlmClient(providerId, modelId)  ── 取命中 modelConfig
       │
       ▼
   LlmClient（4 件套绑定：providerConfig + provider + protocol + modelConfig）
       │  call() / stream()
       │  url = providerConfig.baseUrl + protocol.path
       │  headers = provider.buildAuthHeaders(config) + protocol.contentType
       │  body = protocol.encode(request, model)
       ▼
   HTTP → LLM（Anthropic / minimax / ...）
       │
       ▼
   protocol.parse / parseStream → CanonicalResponse / StreamEvent（usage 含 token，cost 归 client 算）
```

**对外协作点**：4 件套是 LlmClient 不可变共享契约；`llm-client-factory.ts` 按 `(provider, keyRef, model)` 组合缓存复用（`LlmClientFactory` 契约见 `../llm_caller/[P0]llm_caller.md §6.4`）；LlmCaller 持多 client 句柄按 resolveTarget 选中取对应 client。anthropic_messages impl 同时服务 Anthropic 原生 + minimax（同 path/encode，仅 wire usage 字段语义差异，见 `anthropic_impl.md §5.1`）。

## ④ 核心设计原则（跨文件不变量）

1. **零件唯一归属**——请求的每个组成部分只归一个文件（base→provider / path→protocol / auth→provider / body+字段名→protocol / 能力+取值→model / 编排→client / **protocolId 选择→provider** `[v0.0.53]`）。判据见 `docs_guide.md §4`。
2. **数据（per-instance）vs 行为（per-type 无状态代码）分离**——providerConfig/modelConfig 是 app_config 数据（随部署/轮转变），provider/protocol impl 是代码（按 type 复用，impl 不存 config，config 作参数传入）。
3. **LlmClient 不可变共享**——4 件套构造期绑定只读，按组合缓存复用、跨 session 并发安全；retry/状态机不进 client（→ llm_caller），保不可变契约。
4. **标准值自承载为代码常量**——protocol.path / contentType / 默认参数归 protocol impl 代码（per-type），少数可配置项走 `ext_impl_config` overlay（deepMerge）。
5. **client 是唯一门面**——agent 调 LLM 只经 `LlmClient.call/stream`；protocol 只做纯翻译不做编排，I/O 与编排归 client。
6. **protocolId 选择归 provider（1 provider : 1 protocol 锁定）** `[v0.0.53]`——protocol impl 挂 path、provider 挂 baseUrl，二者必须同实体；同一 provider 若挂多 protocol 则每个 protocol 对应不同 baseUrl，无法共享同一 provider 实例。故 `protocolId` 是 `LlmProviderConfig` 必填字段（per-instance 数据），`LlmModelConfig` 不持有；`llm-client-factory` 按 `providerConfig.protocolId` 动态取 protocol impl（替代旧硬编码 `anthropic_messages`）。
7. **impl 归 plugin，主干只留接口 + 类型 + cross-impl 共用工具**（v0.0.191）——provider/protocol 的具体 impl 类（如 `AnthropicCompatibleProvider` / `AnthropicMessagesProtocol`）物理归 builtin plugin 目录（`app/plugins/builtins/llm_anthropic/`），经 EP 注册 + factory 按 implId 解析；主干 `app/server/src/llm/` 只留 `LlmProvider` / `LlmProtocol` 接口 + canonical/wire 类型 + cross-impl 共用工具（credentials / logical-view / client / http_error / resolve-provider-config）。**接口契约 vs impl 物理落点分离**：接口留主干（30+ 调用点 `import type` 零改动），impl 物理归 plugin（生命周期独立、packaged 经 `build-plugins.ts` bundle）。**该原则不动 EP 机制 / 不改 wire 行为**（纯物理迁移，wire 逐字节不变）。

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 链接 |
|---|---|---|
| **4 件套接口契约** | | |
| `[P0]llm_provider_interface.md` | provider 数据 + 行为契约（凭证 + baseUrl + buildAuthHeaders，按鉴权族分 type）+ credentials union | [link]([P0]llm_provider_interface.md) |
| `[P0]llm_protocol_interface.md` | protocol 契约（path/contentType/encode/parse/parseStream + 多模态编码 + role 转换 + 连续同 role 合并 + §3.5.1 入参已 logical 展平） | [link]([P0]llm_protocol_interface.md) |
| `[P0]llm_model_interface.md` | modelConfig（模态/能力/context window/max output/参数取值/定价）+ ModelCapability | [link]([P0]llm_model_interface.md) |
| `[P0]llm_client_interface.md` | LlmClient 组合层（4 件套绑定 + call/stream + validate + computeCost + onWire 钩子 + 非 2xx 抛 LlmHttpError） | [link]([P0]llm_client_interface.md) |
| **公共层（protocol 上游）** | | |
| `[P0]llm_logical_view.md` | 业务 Message[] → LLM 视图 Message[] 公共 encoder（sender 展平入首块 TextBlock 前缀；6 类 source 前缀表 + 注入策略 + 调用点） | [link]([P0]llm_logical_view.md) |
| **impl** | | |
| `anthropic_impl.md` | anthropic_messages impl（encode + cache control 3 breakpoint + parseStream + usage 映射 + minimax 校准点） | [link](anthropic_impl.md) |
| **protocol 层策略** | | |
| `[P0]cache_control.md` | prompt cache 三断点注入（bp#1 system 末 + bp#T tools 末 + bp#2 messages 末）+ 历史 reminder 块全保留；与 context 层 reminder 持久化两层独立 | [link]([P0]cache_control.md) |
| **model resolve** | | |
| `[P0]model_resolve.md` | v0.0.89 统一 resolve 入口（resolveModel + ModelNotConfiguredError）；v0.0.155 ModelRef 复合 + resolveDefaultModel 单点出口；**v0.0.158 chat 单链 + 唯一入口 `resolveConfigBySid`**（chat/compact/T1 记忆整理同链）；**v0.0.230 academy 两档链收窄（去 app 默认）** | [link]([P0]model_resolve.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
