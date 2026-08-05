/**
 * resolveProviderConfig / resolveModelConfig — config 聚合（deepMerge 代码默认 ⊕ app_config）
 * 参考: states/v0.0.3/verify/test-plan.md §1（P2 路径：config 聚合 overlay）
 *       specs/tech/config/[P0]app_config.md（providers 组稀疏 delta）
 *
 * 设计（configAggregation keyDecision）：
 *   - 代码默认 = builtin provider ExtImpl configSchema default（随 impl 代码走，per-type）
 *   - app_config = 用户存入的稀疏 delta（per-instance，只存与默认的差异）
 *   - 聚合在 LlmClient 组装层：deepMerge(代码默认, app_config)，**app 最高级覆盖**
 *   - 嵌套对象深合并（credentials / pricing / paramConstraints）；
 *     数组（models[]）按 app 是否提供决定：app 提供则整体替换，否则用默认
 *   - config service 只存稀疏 delta，不存全量
 */
import type { LlmModelConfig, LlmProviderConfig } from './provider-types';

/**
 * 聚合 provider config：deepMerge(代码默认, app_delta)，app 最高级。
 * @param codeDefault builtin ExtImpl 的 configSchema default（per-type）
 * @param appDelta   app_config providers 组一条 record 的 data（per-instance 稀疏 delta）；undefined 视为未配置
 * @returns 完整 LlmProviderConfig（id 必填，由 app 提供）
 */
export function resolveProviderConfig(
  codeDefault: Partial<LlmProviderConfig>,
  appDelta: Partial<LlmProviderConfig> | undefined,
): LlmProviderConfig {
  const merged = deepMerge(
    codeDefault as Record<string, unknown>,
    (appDelta ?? {}) as Record<string, unknown>,
  ) as Partial<LlmProviderConfig>;
  // models[] 特殊：app 提供则整体替换，否则用默认（deepMerge 已处理，此处显式校验）
  if (!appDelta || appDelta.models === undefined) {
    merged.models = (codeDefault.models ?? []) as LlmModelConfig[];
  }
  // 必填字段兜底
  return {
    id: merged.id ?? '',
    name: merged.name ?? 'anthropic_compatible',
    // protocolId 必填：app 未显式提供时兜底 'anthropic_messages'（与当前唯一 impl 对齐）
    protocolId: merged.protocolId ?? 'anthropic_messages',
    baseUrl: merged.baseUrl ?? '',
    credentials: merged.credentials ?? { key: '' },
    pluginId: merged.pluginId ?? '',
    enabled: merged.enabled ?? true,
    models: merged.models ?? [],
  };
}

/**
 * 聚合 model config：deepMerge(代码默认, app_delta)，app 最高级。
 * 嵌套 pricing / paramConstraints 深合并。
 */
export function resolveModelConfig(
  codeDefault: Partial<LlmModelConfig>,
  appDelta: Partial<LlmModelConfig> | undefined,
): LlmModelConfig {
  const merged = deepMerge(
    codeDefault as Record<string, unknown>,
    (appDelta ?? {}) as Record<string, unknown>,
  ) as Partial<LlmModelConfig>;
  return {
    modelId: merged.modelId ?? '',
    inputModalities: merged.inputModalities ?? ['text'],
    outputModalities: merged.outputModalities ?? ['text'],
    contextWindow: merged.contextWindow ?? 0,
    maxOutputTokens: merged.maxOutputTokens ?? 0,
    paramConstraints: merged.paramConstraints ?? {},
    pricing: merged.pricing ?? {
      inputPerMillion: 0,
      outputPerMillion: 0,
      currency: 'USD',
    },
    providerId: merged.providerId ?? '',
    // protocolId 属 provider 级（LlmProviderConfig.protocolId），model config 不含此字段
    // per-model default 字段已于 v0.0.143 删除
  };
}

/**
 * 深合并两个对象：base ⊕ override，override 优先。
 * - 嵌套纯对象（非数组）递归合并
 * - 数组：override 提供 → 整体替换；否则保留 base
 * - 原始值：override 提供 → 覆盖（含 undefined 不覆盖，仅 app 显式提供字段才覆盖）
 * @param base   代码默认（低优先级）
 * @param override app delta（高优先级）
 */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const ov = override[key];
    if (ov === undefined) continue; // app 未显式提供（undefined）→ 不覆盖
    const bv = out[key];
    if (isPlainObject(bv) && isPlainObject(ov)) {
      // 两边都是纯对象 → 递归深合并
      out[key] = deepMerge(bv as Record<string, unknown>, ov as Record<string, unknown>);
    } else {
      // 数组 / 原始值 / 类型不一致 → override 整体覆盖
      out[key] = ov;
    }
  }
  return out;
}

/** 判断是否为「纯对象」（非数组、非 null、原型为 Object.prototype 或 null） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
