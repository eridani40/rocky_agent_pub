/**
 * modelDefault/model 写入校验（v0.0.36 fail-fast 双保险之写入侧）
 * 参考: specs/api/overall/02-llm-chat.md §5（provider/model enabled 语义）
 *       specs/tech/squad/[P1]data_model.md（modelDefault: ModelRef / member.model 缺省=squad.modelDefault）
 *
 * 背景：v0.0.36 前 squad.modelDefault / member.model 仅校验非空，UI 自由填名（默认值非法
 *   'claude-sonnet'）→ 存库后 studio 激活 resolveProviderModel 精确匹配 modelId 失败抛
 *   ModelNotFoundError，群聊/leader/mate 激活全崩。本模块为写入点提供单一可复用校验：
 *   modelDefault/model 必须是**某 enabled provider 的 enabled modelId**，非法即拒（400/抛错）。
 *
 * 运行时兜底（救活存量）在 session-messages.ts resolveProviderModel；本模块只管写入侧 fail-fast。
 *
 * 自包含：用结构子集类型读 app_config providers 组，不反向依赖 handlers 层类型（避免 service→handler
 *   架构反转）。校验逻辑唯一权威在此，写入点勿复制。
 */
import type { AppConfigService } from '../config/app-config-service';

/** providers 组名（与 handlers/provider.ts / handlers/session.ts 一致，固定） */
const PROVIDERS_GROUP = 'providers';

/** 校验用 model 结构子集（仅需 modelId + enabled 两字段） */
interface ValidationModel {
  modelId: string;
  enabled?: boolean;
}

/** 校验用 provider 结构子集（仅需 id + enabled + models + _deleted tombstone 标记） */
interface ValidationProvider {
  id: string;
  enabled?: boolean;
  models?: ValidationModel[];
  _deleted?: boolean;
}

/**
 * 取全部启用 provider（过滤 _deleted tombstone + enabled!=="false"，对齐
 * handlers/session.ts listEnabledProviders 的过滤口径，避免重复定义但又不反向依赖 handler）。
 */
function listEnabledProvidersForValidation(svc: AppConfigService): ValidationProvider[] {
  return svc
    .listGroup(PROVIDERS_GROUP)
    .map((r) => r.data as unknown as ValidationProvider)
    .filter(
      (p) =>
        p &&
        !(p as { _deleted?: boolean })._deleted &&
        p.enabled !== false,
    );
}

/**
 * 保留字 / 空串判定（PRD 03 §2.2）。
 *
 * `default` / `none` / `''` / undefined 均视为「未手动选 / 跟随默认」——
 * 写入点放行不查 provider 命中；resolve 链（model-resolver.ts）跳过继续 fallback。
 *
 * 单一权威：所有 handler 的保留字短路都走此 helper（避免 `=== 'default' || === 'none' || === ''`
 * 三处以上重复，v0.0.89 工作块 ③ 抽取）。
 *
 * [v0.0.155] 复合保留语义（INV-B3）：复合 ModelRef `{providerId?, modelId}` 的保留字判定
 *   仅看 modelId 维度——`{providerId: undefined, modelId: 'default'}` 即保留态。
 *   providerId 不参与保留字判定（任何 providerId 配 `'default'` modelId 都是保留）。
 *   实际调用方多数走 modelId 单参判定（保留 isReservedModelId(mid) 签名）。
 */
export function isReservedModelId(mid: string | undefined | null): boolean {
  return mid == null || mid === '' || mid === 'default' || mid === 'none';
}

/**
 * 保留字规范化：reserved（default/none/''）→ 'default'；具体 modelId 原样返回。
 *
 * 用于持久化前归一（POST/PUT /session、POST /messages、POST /run 落盘统一 'default'）。
 * undefined 入参 → undefined 出参（caller 决定是否落盘）。
 */
export function normalizeReservedModelId(mid: string | undefined): string | undefined {
  if (mid === undefined) return undefined;
  return isReservedModelId(mid) ? 'default' : mid;
}

/**
 * 校验 modelId 是否为某 enabled provider 的 enabled model（INV-C1 双路）。
 *
 * 判定口径（参考 02-llm-chat §5 + change_plan v0.0.155 §B2）：
 *   - providerIdHint 非空 → **精确匹配**该 provider：providerId 命中 + 该 provider models 含 modelId
 *     + model.enabled!==false（INV-B2 精确）
 *   - providerIdHint 空 → 跨 enabled providers 反查（back-compat：救存量无 providerId 的 session/squad）
 *   - provider.enabled !== false（默认启用，仅显式 false 才排除）
 *   - model.enabled !== false（同上；旧 record/测试夹具缺 enabled 字段视为启用）
 *
 * @returns ok=true 合法；ok=false + error（清晰中文，供前端 400 提示）
 *
 * [v0.0.155] 签名加 providerIdHint?（INV-C1）：渐进迁移——caller 传复合时精确，旧路径不传仍合法。
 */
export function validateModelId(
  svc: AppConfigService,
  modelId: string,
  providerIdHint?: string,
): { ok: true } | { ok: false; error: string } {
  // [v0.0.36] 空字符串 = inherit（已删 member.model，但 squad 派生 / 旧 client 仍可能走保留字）。
  // [v0.0.89] 保留字白名单：'default' / 'none' = 未手动选 / 跟随默认（PRD 03 §2.2）。
  //   写入点放行保留字；resolve 链（model-resolver.ts）将保留字视为「继续 fallback」而非命中。
  if (isReservedModelId(modelId)) return { ok: true };
  const providers = listEnabledProvidersForValidation(svc);
  if (providers.length === 0) {
    return { ok: false, error: `model ${modelId} 校验失败：当前无已启用的 provider` };
  }
  // hint 非空 → 精确匹配该 provider（INV-C1/B2）
  if (providerIdHint) {
    const hinted = providers.find((p) => p.id === providerIdHint);
    if (!hinted) {
      return { ok: false, error: `model ${modelId} 校验失败：providerId ${providerIdHint} 未启用或不存在` };
    }
    const models = Array.isArray(hinted.models) ? hinted.models : [];
    const hit = models.find((m) => m && m.modelId === modelId && m.enabled !== false);
    if (!hit) {
      return { ok: false, error: `model ${modelId} 不属于 provider ${providerIdHint}（未在此 provider 的 models 中命中）` };
    }
    return { ok: true };
  }
  // hint 空 → 跨 provider 反查（旧 back-compat 路径）
  for (const p of providers) {
    const models = Array.isArray(p.models) ? p.models : [];
    const hit = models.find((m) => m && m.modelId === modelId && m.enabled !== false);
    if (hit) return { ok: true };
  }
  return {
    ok: false,
    error: `model ${modelId} 不是任何已启用 provider 的合法 modelId`,
  };
}
