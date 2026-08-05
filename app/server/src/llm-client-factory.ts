/**
 * llm-client-factory — 按 providerId/modelId 组装 LlmClient（chat 用）
 * 参考: specs/api/overall/02-llm-chat.md §3
 *       specs/tech/agent/providers_and_models/[P0]llm_client_interface.md §3.6
 *
 * 组装步骤：
 *   1. 从 app_config providers 组取 provider 实例数据（per-instance）
 *   2. 经 resolveProviderConfig 聚合（代码默认 ⊕ app_data；app_data 完整则等价于 app_data）
 *   3. 经 PluginManager.getExtensionImpls 取 anthropic_compatible provider impl + anthropic_messages protocol impl
 *   4. 取命中的 modelConfig（provider.models[] 中 modelId 命中）
 *   5. fetchImpl 选择：ROCKY_TEST_MOCK_LLM=1 时注入 mock fetch（不真调 Anthropic），其他走真 fetch
 *
 * chat 无 session，每次 /chat 请求新建 client（缓存留作后续优化）。
 */
import type { AppConfigService } from './config/app-config-service';
import type { PluginManager } from './plugin/plugin-manager';
import { LlmProviderPoint, LlmProtocolPoint } from './plugin/extension-point';
import type { LlmProvider } from './llm/provider';
import type { LlmProtocol } from './llm/protocol';
import { LlmClient } from './llm/client';
import type { LlmProviderConfig, LlmModelConfig } from './llm/provider-types';
import { resolveProviderConfig } from './llm/resolve-provider-config';
import { createMockFetch } from './mock-llm';
import type { ProviderInstance, ModelInstance } from './handlers/provider';

/** providers 组名（与 provider handler 一致） */
const GROUP = 'providers';

/** factory 错误类型（区分不命中） */
export class ProviderNotFoundError extends Error {}
export class ModelNotFoundError extends Error {}

/**
 * 按 providerId/modelId 组装 LlmClient。
 * @throws ProviderNotFoundError / ModelNotFoundError
 */
export function buildLlmClient(
  providerId: string,
  modelId: string,
  appConfig: AppConfigService,
  pluginManager: PluginManager,
): LlmClient {
  // 1. 取 app_config provider 实例数据
  const all = appConfig
    .listGroup(GROUP)
    .map((r) => r.data as ProviderInstance)
    .filter((p) => p && !(p as unknown as { _deleted?: boolean })._deleted);
  const instance = all.find((p) => p.id === providerId);
  if (!instance) throw new ProviderNotFoundError(`provider ${providerId} not found`);

  // 2. 聚合（app_data 完整 → 等价于 app_data；代码默认给空骨架）
  const appDelta: Partial<LlmProviderConfig> = {
    id: instance.id,
    name: instance.name,
    // [v0.0.53] protocolId 从 provider 顶层取（迁自 model），透传到 providerConfig
    protocolId: instance.protocolId,
    baseUrl: instance.baseUrl,
    credentials: instance.credentials,
    pluginId: 'builtin.anthropic',
    enabled: instance.enabled,
    models: instance.models.map(modelToLlmModelConfig),
  };
  const providerConfig = resolveProviderConfig({}, appDelta);

  // 3. 取 modelConfig（命中 modelId）
  const modelCfg = providerConfig.models.find((m) => m.modelId === modelId);
  if (!modelCfg) throw new ModelNotFoundError(`model ${modelId} not found in provider ${providerId}`);

  // 4. [v0.0.53] 动态取 provider/protocol impl：按 providerConfig.name / protocolId 命中 ext impl。
  //    替代旧硬编码 'anthropic_compatible' / 'anthropic_messages'（旧 bug：换 protocol 配置无效）。
  //    命中失败时回退首个注册 impl（specs/tech/version_logs/v0.0.53/change_log.md §2 伪代码指定）：
  //      - 让 mock/非 anthropic_compatible 名 provider（测试 fixture）仍能命中真实 impl
  //      - providers/protocols 全空（impl 真未注册）才抛，错误信息仍含原 name/protocolId 供诊断
  const providers = pluginManager.getExtensionImpls<LlmProvider>(LlmProviderPoint);
  const protocols = pluginManager.getExtensionImpls<LlmProtocol>(LlmProtocolPoint);
  const providerImpl = providers.find((p) => (p as { implId?: string }).implId === providerConfig.name) ?? providers[0];
  const protocolImpl = protocols.find((p) => (p as { implId?: string }).implId === providerConfig.protocolId) ?? protocols[0];
  if (!providerImpl || !protocolImpl) {
    throw new Error(
      `provider/protocol impl 未注册: name=${providerConfig.name}, protocolId=${providerConfig.protocolId}`,
    );
  }

  // 5. fetchImpl 选择：ROCKY_TEST_MOCK_LLM=1 时注入 mock fetch（computer_use 等 mock:* 剧本）；
  //    其他情况走真 fetch（undefined → LlmClient 内部默认 fetch）。
  const fetchImpl = process.env.ROCKY_TEST_MOCK_LLM === '1'
    ? createMockFetch({
        stepDelayMs: process.env.ROCKY_TEST_MOCK_STEP_DELAY
          ? Number(process.env.ROCKY_TEST_MOCK_STEP_DELAY)
          : 0,
      })
    : undefined;

  return new LlmClient({
    providerConfig,
    provider: providerImpl,
    protocol: protocolImpl,
    modelConfig: modelCfg,
    fetchImpl,
  });
}

/** ModelInstance（api 形状）→ LlmModelConfig（llm 内部完整形状）。
 *  [v0.0.13 S3] pricing 透传：m.pricing 存在用之（minimax 等），否则兜底全 0 + USD（cost=0 向后兼容）。
 *  [v0.0.53] model.protocolId 已迁出（→ provider.protocolId），此处不再读/赋值。
 *  [v0.0.143] per-model default 字段已删除，不再透传。 */
function modelToLlmModelConfig(m: ModelInstance): LlmModelConfig {
  return {
    modelId: m.modelId,
    inputModalities: ['text'],
    outputModalities: ['text'],
    contextWindow: m.contextWindow ?? 0,
    maxOutputTokens: m.maxOutputTokens ?? 0,
    paramConstraints: {},
    pricing: m.pricing ?? { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
    providerId: '',
  };
}
