/**
 * resolveConsolidationModel — tier2 专用模型反查（不复用 resolveModel()）
 * 参考: specs/tech/agent/memory/[P0]consolidation_tier2.md §5.4
 *
 * resolveModel() 是 session/squad/member 语境下的 6 行 fallback 链，对"天级 app 级任务"
 * 无适用语境（无 session 可 fallback）。tier2 改用最小反查：读 app_config.consolidation.modelId
 * → 反查 listEnabledProviders 找到承载该 modelId 的 provider。未配置 / 反查失败 → null
 * （caller 视为 fast finish，不抛异常——"模型未配置"是合法业务结果，非错误）。
 */
import type { AppConfigService } from '../../config/app-config-service';
import { listEnabledProviders } from '../../handlers/session-deps';

/** app_config `consolidation` group 的用户配置形状（app_config.md §3.16） */
export interface ConsolidationAppConfigData {
  enabled: boolean;
  dailyTime: string;
  modelId?: string;
}

/** 反查命中结果：providerId + modelId（供 buildLlmClient 组装用） */
export interface ResolvedConsolidationModel {
  providerId: string;
  modelId: string;
}

/**
 * 读 `consolidation` group 配置 → 反查承载 modelId 的启用 provider。
 * @returns 命中则 {providerId, modelId}；modelId 未设置或找不到承载它的启用 provider → null
 */
export function resolveConsolidationModel(
  appConfig: AppConfigService,
): ResolvedConsolidationModel | null {
  const cfg = appConfig.get('consolidation', 'default') as ConsolidationAppConfigData | undefined;
  const modelId = cfg?.modelId;
  if (!modelId) return null;
  const enabledProviders = listEnabledProviders(appConfig);
  const provider = enabledProviders.find((p) => p.models.some((m) => m.modelId === modelId));
  if (!provider) {
    // 区分「未配置」vs「配置了但反查不到 provider」——后者通常意味着 provider 被禁用/删除，
    // 或（AT 场景）读取 providers 分片目录时命中空态（如底层符号链接指向的共享池瞬时不可用，
    // FsCrudStore.query 对 ENOENT 静默返回 []，不会抛错）。留痕方便下次排查，不改变返回值语义
    // （调用方仍视为 fast finish，'model_not_configured' 是唯一对外 skippedReason）。
    console.warn(
      `[consolidation-tier2] resolveConsolidationModel: modelId=${modelId} 已配置但反查不到承载它的 ` +
      `enabled provider（enabledProviders.length=${enabledProviders.length}）；可能 provider 已禁用/删除，` +
      `或读取 providers 配置时命中空态`,
    );
    return null;
  }
  return { providerId: provider.id, modelId };
}
