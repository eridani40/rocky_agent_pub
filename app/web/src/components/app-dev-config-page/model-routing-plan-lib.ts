/**
 * model-routing-plan-lib — 方案纯函数库（v0.0.347 模型路由 UI v2）
 * 参考 specs/api/overall/21-model-routing.md §2.2/§3（数据形状 + 同模型约束）
 *       specs/tech/version_logs/v0.0.347/change_plan.md「UI v2 改版」ui-v2 行
 *
 * 职责：方案校验/排序/熔断默认值等纯函数（v1 从 plan-editor 迁出，语义零变化；
 * editor 与 section 共用；迁移原因 = UI v2 重写后 editor 单文件 300 行硬门禁）。
 * [change_log 记录] moveItem 已删除（拖拽排序替代按钮排序，死代码原则）。
 */
import type { ProviderItem } from '../../lib/providers';
import type { ModelRoutingPlan, RoutingItem, CircuitConfig } from './model-routing-types';

/** 熔断参数默认值（对齐 PRD §2.7 + tech §6） */
export const DEFAULT_CIRCUIT: Required<CircuitConfig> = {
  failureThreshold: 4,
  successThreshold: 2,
  timeoutSeconds: 60,
  errorRateThreshold: 0.6,
  minRequests: 10,
};

/** 预检错误 i18n key 列表（空数组 = 合法） */
export type PlanValidationError =
  | 'modelRouting.validate.nameRequired'
  | 'modelRouting.validate.itemsRequired'
  | 'modelRouting.validate.sameModelMax2'
  | 'modelRouting.validate.sameModel2Time'
  | 'modelRouting.validate.sameModel2NoTime'
  | 'modelRouting.validate.timeAboveUnconditional'
  | 'modelRouting.validate.itemModelRequired'
  | 'modelRouting.validate.itemModelInvalid';

/**
 * [v0.0.349] 条目模型存在性判定（dangling 预检，对齐服务端 PUT 校验语义）：
 * (providerId, modelId) 未命中 enabled provider 的 enabled model → dangling。
 * enabled 缺字段视为启用（对齐后端 enabled !== false 语义）。
 * 停用条目同样检查（服务端逐条目校验无停用豁免）。
 */
export function isItemModelInvalid(
  item: Pick<RoutingItem, 'providerId' | 'modelId'>,
  providers: ProviderItem[],
): boolean {
  const p = providers.find((it) => it.id === item.providerId);
  if (!p || p.enabled === false) return true;
  const m = p.models.find((it) => it.modelId === item.modelId);
  return !m || m.enabled === false;
}

/**
 * 同模型约束本地预检（对齐 PRD §2.8 UC-21/22/23 + api §2.2 校验表）：
 * - name/items 非空
 * - 每条目 providerId+modelId 非空
 * - 同模型（providerId+modelId）按启用条目分组：≤2 条、禁 2 带时间、禁 2 不带时间
 * - 带时间条目必须排在不带时间条目上面
 * 注意：按「启用条目」统计（停用不占额度，change_plan ui-settings 行）。
 * [v0.0.349] providers 传入时：每条目存在性预检（dangling → itemModelInvalid，
 * 与后端 PUT 400「model not found or disabled」同语义双保险）；缺省不做存在性检查（向后兼容）。
 */
export function validatePlanLocal(plan: ModelRoutingPlan, providers?: ProviderItem[]): PlanValidationError[] {
  const errors: PlanValidationError[] = [];
  if (!plan.name?.trim()) errors.push('modelRouting.validate.nameRequired');
  if (!plan.items || plan.items.length === 0) {
    errors.push('modelRouting.validate.itemsRequired');
    return errors;
  }
  let hasInvalidModel = false;
  for (const it of plan.items) {
    if (!it.providerId || !it.modelId) {
      errors.push('modelRouting.validate.itemModelRequired');
      break;
    }
    // [v0.0.349] dangling 存在性预检（providers 缺省跳过；错误只记一次）
    if (providers && isItemModelInvalid(it, providers)) hasInvalidModel = true;
  }
  if (hasInvalidModel) errors.push('modelRouting.validate.itemModelInvalid');
  // 启用条目分组（停用不占额度）
  const groups = new Map<string, { withTime: number; noTime: number; minTimeIndex: number; maxNoTimeIndex: number }>();
  plan.items.forEach((it, idx) => {
    if (!it.enabled) return;
    const key = `${it.providerId}|${it.modelId}`;
    const g = groups.get(key) ?? { withTime: 0, noTime: 0, minTimeIndex: Infinity, maxNoTimeIndex: -1 };
    const hasTime = !!it.timeCondition && it.timeCondition.hours.length > 0;
    if (hasTime) {
      g.withTime += 1;
      g.minTimeIndex = Math.min(g.minTimeIndex, idx);
    } else {
      g.noTime += 1;
      g.maxNoTimeIndex = Math.max(g.maxNoTimeIndex, idx);
    }
    groups.set(key, g);
  });
  for (const g of groups.values()) {
    const total = g.withTime + g.noTime;
    if (total > 2) errors.push('modelRouting.validate.sameModelMax2');
    if (g.withTime > 1) errors.push('modelRouting.validate.sameModel2Time');
    if (g.noTime > 1) errors.push('modelRouting.validate.sameModel2NoTime');
    // 带时间必须排在不带时间上面：带时间最早 index > 不带时间最晚 index 即违规
    if (g.withTime > 0 && g.noTime > 0 && g.minTimeIndex > g.maxNoTimeIndex) {
      errors.push('modelRouting.validate.timeAboveUnconditional');
    }
  }
  return errors;
}

/** 依据数组顺序重算 priority（1 起升序） */
export function reindexPriorities(items: RoutingItem[]): RoutingItem[] {
  return items.map((it, i) => ({ ...it, priority: i + 1 }));
}

/** dirty 判定：draft 与快照内容不同（语义对齐 provider detail isDirty；纯数据 JSON 比对） */
export function isPlanDirty(snapshot: ModelRoutingPlan, draft: ModelRoutingPlan): boolean {
  return JSON.stringify(snapshot) !== JSON.stringify(draft);
}
