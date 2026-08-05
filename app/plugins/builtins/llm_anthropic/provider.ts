/**
 * builtin llm_anthropic plugin — provider impl（AnthropicCompatibleProvider 真实 impl）
 * 参考: specs/tech/plugin_system/[P0]builtin_plugins_directory.md §2.2（impl 模块路径相对 plugin 目录）
 *       specs/tech/plugin_system/[P0]plugin_manager_interface.md §3.4（impl 模块 default export 类）
 *       specs/tech/agent/providers_and_models/[P0]llm_provider_interface.md §2/§3.1/§3.3
 *       specs/research/v0.0.3-anthropic-protocol.md §1（headers）
 *
 * v0.0.191：impl 物理迁入 plugin（原主干 app/server/src/llm/provider.ts 的类）。
 * 主干只留 LlmProvider 接口 + 类型（plugin type-only import）。
 * wire 行为逐字节不变（buildAuthHeaders 逻辑原样迁入）。
 *
 * 设计（provider §3.1）：
 *   - impl 无状态，**不存 providerConfig**——config 作 buildAuthHeaders 入参传入
 *   - 构造器签名 (implId, cfg) 遵循 plugin builtin-loader 的 default export 类约定
 *     （cfg = ext_impl_config overlay，少数行为可配置项；P0 基本空）
 *   - header 构造经 resolveKey 取 keyValue（支持多 key + keyRef 选择器）
 */
import type { LlmProvider } from '../../../server/src/llm/provider';
import type { LlmProviderConfig } from '../../../server/src/llm/provider-types';
import { pickKeyValue } from '../../../server/src/llm/credentials';

/**
 * Anthropic 直连及兼容端点的鉴权实现。
 * 构造签名约定：(implId, cfg)；cfg 为 ext_impl_config overlay（P0 空）。
 */
export default class AnthropicCompatibleProvider implements LlmProvider {
  /** ext impl 身份（便于实例自识别，对应 manifest.implId） */
  readonly implId: string;
  /** ext_impl_config overlay 合并值（少数行为可配置项；P0 基本空） */
  protected readonly cfg: Record<string, unknown>;

  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    this.implId = implId;
    this.cfg = cfg;
  }

  /**
   * 构造 auth header：x-api-key + 固定 anthropic-version。
   * 经 pickKeyValue 按 keyRef 取 keyValue（单 key 向后兼容，多 key 选指定）。
   * 无状态——同 config 跨实例返回同结果；config 变化即时反映（provider §3.1）。
   */
  buildAuthHeaders(
    config: LlmProviderConfig,
    keyRef?: string,
  ): Record<string, string> {
    const keyValue = pickKeyValue(config.credentials, keyRef);
    if (keyValue === undefined) {
      throw new Error(
        `anthropic_compatible: no key found for keyRef=${keyRef ?? '<default>'}`,
      );
    }
    return {
      'x-api-key': keyValue,
      'anthropic-version': '2023-06-01',
    };
  }
}
