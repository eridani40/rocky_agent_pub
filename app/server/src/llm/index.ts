/**
 * llm 模块入口 — 接口 + 类型 + client + 聚合（impl 已迁 builtin plugin）
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_provider_interface.md
 *       specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md
 *       specs/tech/agent/providers_and_models/[P0]llm_client_interface.md
 *       specs/tech/agent/providers_and_models/[P0]llm_model_interface.md
 *
 * v0.0.191：AnthropicCompatibleProvider + AnthropicMessagesProtocol impl 类已物理迁入
 *   app/plugins/builtins/llm_anthropic/（builtin plugin，经 EP 注册 + factory 按 implId 解析）。
 *   主干只留接口（LlmProvider / LlmProtocol）+ canonical/wire 类型 + client + 聚合 + credentials。
 *   调用方 100% 是 `import type`（零运行时依赖主干 impl）→ 迁移后零改动。
 *
 * 使用方：`import { LlmClient, resolveProviderConfig, ... } from '@app/server/llm'`
 *         `import type { LlmProvider, LlmProtocol, CanonicalRequest, ... } from '@app/server/llm'`
 *
 * 模块组成：
 *   - provider-types.ts：LlmProviderConfig / LlmModelConfig / ProviderName / ProtocolName 类型
 *   - provider.ts：LlmProvider 接口（impl 在 plugin）
 *   - protocol.ts：LlmProtocol 接口 + canonical/wire 类型（impl 在 plugin）
 *   - protocol-types.ts：canonical Message / ContentBlock 类型
 *   - client.ts：LlmClient（4 件套组合 + I/O 编排 + token 计数）
 *   - resolve-provider-config.ts：resolveProviderConfig / resolveModelConfig（deepMerge 聚合）
 *   - credentials.ts / logical-view.ts / http_error.ts：cross-impl 共用工具
 */
// 类型
export type {
  LlmProviderConfig,
  LlmModelConfig,
  ProviderName,
  ProtocolName,
  Modality,
  Currency,
  ParamConstraints,
  Pricing,
  Tokenizer,
} from './provider-types';

export type {
  ContentBlock,
  Message,
} from './protocol-types';

// provider 接口（impl 已迁 plugin：app/plugins/builtins/llm_anthropic/provider.ts）
export type { LlmProvider } from './provider';

// protocol 接口 + canonical/wire 类型（impl 已迁 plugin：app/plugins/builtins/llm_anthropic/protocol.ts）
export type {
  LlmProtocol,
  CanonicalRequest,
  CanonicalResponse,
  WireBody,
  WireResponse,
  RequestParams,
  StreamEvent,
} from './protocol';

// client
export { LlmClient } from './client';
export type { LlmClientOptions } from './client';

// config 聚合
export {
  resolveProviderConfig,
  resolveModelConfig,
  deepMerge,
} from './resolve-provider-config';
