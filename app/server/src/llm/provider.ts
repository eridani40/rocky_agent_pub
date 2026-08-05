/**
 * LlmProvider 接口契约（impl 已迁 builtin plugin llm_anthropic）
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_provider_interface.md §2/§3.1
 *
 * v0.0.191：AnthropicCompatibleProvider 类已物理迁入
 *   app/plugins/builtins/llm_anthropic/provider.ts（builtin plugin impl）。
 * 本文件只保留 LlmProvider 接口定义（plugin + 调用方 type-only import 用）。
 * 实现归属、default export 类形式见 plugin 目录。
 */
import type { LlmProviderConfig } from './provider-types';

/** provider 行为契约（per-type，无状态，不存 config） */
export interface LlmProvider {
  /**
   * 用 providerConfig.credentials 构造 auth header；config 作参数传入，impl 不持有。
   * keyRef 可选：多 key 时选指定 keyRef（fallback chain 引用）；单 key 忽略。
   */
  buildAuthHeaders(
    config: LlmProviderConfig,
    keyRef?: string,
  ): Record<string, string>;
}
