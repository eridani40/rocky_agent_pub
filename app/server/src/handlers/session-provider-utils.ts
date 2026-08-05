/**
 * session-provider-utils — resolveProviderModel（system_prompt 相关逻辑在 system-prompt-builder.ts）
 *
 * @internal：handler 不直接调本文件 resolveProviderModel；
 *   统一走 services/model-resolver.ts 的 resolveModel（按 PRD 03 §2.1 fallback 表 + ModelNotConfiguredError）。
 *   本文件保留作机械解析 helper（listEnabledProviders/findProvider/findFirstWithModels 单点出口），
 *   供内部 / 测试 / 兜底使用；export 保留（避免连锁改名）。
 *   handler 调用点（session-config/session-messages/session-run/session-compact）走 resolveModel。
 *
 * 参考: specs/api/version_logs/v0.0.8/change_log.md §3.2（历史 resolve 链）
 *       specs/prd/version_logs/v0.0.89/03-model-resolver.md §2.1（6 行 fallback 表）
 */
import {
  ProviderNotFoundError,
  ModelNotFoundError,
} from '../llm-client-factory';
import type { ProviderInstance, ModelInstance } from './provider';
import {
  type SessionHandlerDeps,
  listEnabledProviders,
  findProvider,
} from './session';

/**
 * 从 providers 列表中找第一个至少有一个 model 的 provider；
 * 全无则抛 ProviderNotFoundError。
 *
 * 背景：listEnabledProviders 过滤 enabled≠false + 非 _deleted，但不过滤零 model 的
 * 废弃/占位 provider。resolveProviderModel 的默认路径（无显式 providerId/modelId）若取
 * providers[0] 而该 provider models=[]，会抛 ModelNotFoundError（"provider X has no model"）
 * → HTTP 500（deliverTo 内部 resolveConfigBySid 未 catch → 异常透传）。
 *
 * 本 helper 确保默认路径始终选中一个可工作的 provider。
 */
function findFirstWithModels(providers: ProviderInstance[]): ProviderInstance {
  const found = providers.find((p) => p.models.length > 0);
  if (!found) {
    throw new ProviderNotFoundError(
      'no enabled provider with models in app_config (all enabled providers have zero models)',
    );
  }
  return found;
}

/**
 * 解析 (providerId, modelId)，解析顺序：
 *   请求体 > session 持久(providerId/modelId) > app_config 默认
 *   （首个 enabled provider + 其首个 model）
 * @throws ProviderNotFoundError 无 enabled provider / 显式 providerId 不命中
 * @throws ModelNotFoundError provider 真的一个 model 都没有（兜底后仅此情形抛）
 *
 * export 供 session-compact.ts 复用（手动 compact 也需构造 SessionConfig）。
 * model miss 不直接抛——兜底到首个 enabled model（救活存量非法 modelDefault）。
 * 默认路径用 findFirstWithModels 跳过零 model provider（防 E2E 占位 provider 阻塞全站）。
 *
 * **@internal** — handler 不直接调用本函数；统一走
 *   services/model-resolver.ts:resolveModel（按 PRD 03 §2.1 fallback 表 + ModelNotConfiguredError）。
 *   保留 export 仅供：(1) 历史测试 mock；(2) 未来内部 helper 复用；(3) 兜底未迁移路径。
 *   **新建 handler 调用 resolveModel，勿调本函数**。
 */
export function resolveProviderModel(
  svc: SessionHandlerDeps['appConfig'],
  bodyProviderId: string | undefined,
  bodyModelId: string | undefined,
  sessionPersist: { providerId?: string; modelId?: string },
): { providerId: string; modelId: string } {
  const providers = listEnabledProviders(svc);
  if (providers.length === 0) {
    throw new ProviderNotFoundError('no enabled provider in app_config');
  }

  // 有效 providerId/modelId = 请求体 > session 持久
  const effectiveProviderId = bodyProviderId ?? sessionPersist.providerId;
  const effectiveModelId = bodyModelId ?? sessionPersist.modelId;

  let provider: ProviderInstance;
  if (effectiveProviderId) {
    const found = findProvider(svc, effectiveProviderId);
    if (!found) {
      throw new ProviderNotFoundError(`provider ${effectiveProviderId} not found`);
    }
    // 显式 providerId：尊重 caller 选择（即便无 model 也让它抛明确的 ModelNotFoundError）
    provider = found;
  } else if (effectiveModelId) {
    // 无 providerId 但有 modelId：跨 enabled providers 搜首个托管该 model 的。
    //   背景：studio session（squad/leader/mate 由 squad-service 建）不持久化 providerId，model 取自
    //   member.model / squad.modelDefault（仅 model 名）。a2a deliverTo 激活时 bodyOverride 空 → 走此分支。
    //   命中则用该 provider（下方 model.find 必中）；全无命中则 fallback 到首个有 model 的 provider。
    provider = providers.find((p) => p.models.some((m) => m.modelId === effectiveModelId))
      ?? findFirstWithModels(providers);
  } else {
    // 缺省取首个 enabled 且至少有一个 model 的 provider（跳过零 model 的废弃/占位 provider）
    provider = findFirstWithModels(providers);
  }

  let model: ModelInstance | undefined;
  if (effectiveModelId) {
    model = provider.models.find((m) => m.modelId === effectiveModelId);
    if (!model) {
      // 运行时兜底（救活存量非法 modelDefault/member.model）：
      //   存量 squad 可能已落库非法 modelId（如 UI 自由填的 'claude-sonnet'），
      //   studio 激活 leader/mate/squadChat 时 effectiveModelId 精确匹配失败 → 兜底到
      //   首个 enabled model → 首个 model；仅当 provider 一个 model 都没有时才抛错。
      //   跨 provider 搜逻辑（上方 else-if 分支）与此兜底独立；兜底仅在最终 provider
      //   选定后 model 仍 miss 时生效。fail-fast 写入校验（model-validation.ts）挡新增，本处救存量。
      //   优先级：首个 enabled → 首个 model（含 disabled，last resort 不崩）。
      model = provider.models.find((m) => m.enabled !== false)
        ?? provider.models[0];
      if (!model) {
        throw new ModelNotFoundError(`provider ${provider.id} has no model`);
      }
    }
  } else {
    // 缺省取首个 model
    model = provider.models[0];
    if (!model) {
      throw new ModelNotFoundError(`provider ${provider.id} has no model`);
    }
  }

  return { providerId: provider.id, modelId: model.modelId };
}
