/**
 * 模型路由方案存储层（app_config model_routing_plans / model_routing 组读写 + 删除引用解除）
 * 参考: specs/api/overall/21-model-routing.md §2.1-§2.5
 *       specs/tech/agent/providers_and_models/[P0]model_routing.md §8（app_config 存储层）
 *
 * 设计：
 *   - 方案库 = app_config `model_routing_plans` 组（key=planId，权威值组多实例）；
 *   - playground 挂载 = app_config `model_routing` 组 key=default → { playgroundPlanId?: string }；
 *   - savePlan 先跑 validateModelRoutingPlan（违规 throw ModelRoutingValidationError，handler 转 400）；
 *   - deletePlan 先解除引用（squad.modelRoutingPlanId === planId 清空 + playgroundPlanId 清空）再删 record，
 *     返回 detached 清单 ["squad:<id>", "playground"]。
 */
import type { AppConfigService } from '../config/app-config-service';
import type { SquadStore } from '../stores/squad-store';
import { validateModelRoutingPlan, type ModelRoutingPlan } from './model-routing-validation';

/** 方案库 group 名（与 api spec 一致，固定） */
export const MODEL_ROUTING_PLANS_GROUP = 'model_routing_plans';
/** playground 挂载 group 名（key 固定 default） */
export const MODEL_ROUTING_GROUP = 'model_routing';
/** playground 挂载单实例 key */
export const MODEL_ROUTING_DEFAULT_KEY = 'default';

/** 校验失败（handler 转 400 + message） */
export class ModelRoutingValidationError extends Error {}

/** 方案不存在（handler 转 404/400） */
export class ModelRoutingPlanNotFoundError extends Error {}

/** deletePlan 依赖（squad 引用解除扫描） */
export interface DeletePlanDeps {
  squadStore: SquadStore;
}

/**
 * 方案库列表（按 createdAt 升序 = 创建先后）。
 * @returns ModelRoutingPlan[]；组缺失/无 record = []
 */
export function listPlans(svc: AppConfigService): ModelRoutingPlan[] {
  const records = svc.listGroup(MODEL_ROUTING_PLANS_GROUP);
  const plans = records
    .map((r) => r.data as ModelRoutingPlan)
    .filter((p): p is ModelRoutingPlan => !!p && typeof p === 'object' && typeof p.id === 'string');
  plans.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return plans;
}

/**
 * 读单方案。
 * @returns ModelRoutingPlan | undefined（undefined = 未配置，不抛）
 */
export function getPlan(svc: AppConfigService, planId: string): ModelRoutingPlan | undefined {
  const data = svc.get(MODEL_ROUTING_PLANS_GROUP, planId);
  if (!data || typeof data !== 'object') return undefined;
  return data as ModelRoutingPlan;
}

/**
 * 保存方案（全量覆盖语义）。
 * 先跑 validateModelRoutingPlan 静态校验；违规 throw ModelRoutingValidationError（handler 转 400）。
 */
export function savePlan(svc: AppConfigService, plan: unknown): void {
  const v = validateModelRoutingPlan(plan, svc);
  if (!v.ok) throw new ModelRoutingValidationError(v.error);
  svc.set(MODEL_ROUTING_PLANS_GROUP, (plan as ModelRoutingPlan).id, plan);
}

/**
 * 删除方案（api §2.3 + tech §8.3）：
 *   ① 扫全部 squad，清 modelRoutingPlanId === planId（清空字段，不删 squad）；
 *   ② 清 model_routing.default.playgroundPlanId（data={} = 解除挂载）；
 *   ③ 删 record（不存在返 undefined）。
 * @returns detached 清单（["squad:<id>", "playground"]）；planId 不存在返 undefined
 */
export async function deletePlan(
  svc: AppConfigService,
  planId: string,
  deps: DeletePlanDeps,
): Promise<string[] | undefined> {
  const detached: string[] = [];
  // ① 扫全部 squad 解除引用（读-改-写；剥信封字段，put 不允许 record 自带 createdAt/updatedAt/version）
  const squads = await deps.squadStore.listSquads();
  for (const squad of squads) {
    const sid = squad.id as string;
    if ((squad as unknown as { modelRoutingPlanId?: string }).modelRoutingPlanId !== planId) continue;
    const { createdAt: _ca, updatedAt: _ua, version: _v, modelRoutingPlanId: _m, ...rest } =
      squad as unknown as Record<string, unknown>;
    void _ca; void _ua; void _v; void _m;
    await deps.squadStore.putSquad(rest as Parameters<typeof deps.squadStore.putSquad>[0]);
    detached.push(`squad:${sid}`);
  }
  // ② 清 playground 挂载引用（读 model_routing.default 的 playgroundPlanId）
  const pg = svc.get(MODEL_ROUTING_GROUP, MODEL_ROUTING_DEFAULT_KEY) as
    | { playgroundPlanId?: string }
    | undefined;
  if (pg && typeof pg === 'object' && pg.playgroundPlanId === planId) {
    svc.set(MODEL_ROUTING_GROUP, MODEL_ROUTING_DEFAULT_KEY, {});
    detached.push('playground');
  }
  // ③ 删 record（不存在 = 幂等 404）
  const existed = svc.delete(MODEL_ROUTING_PLANS_GROUP, planId);
  if (!existed) return undefined;
  return detached;
}

/**
 * 读 playground 挂载方案 id。
 * @returns string | undefined（未挂载 = undefined）
 */
export function getPlaygroundPlanId(svc: AppConfigService): string | undefined {
  const data = svc.get(MODEL_ROUTING_GROUP, MODEL_ROUTING_DEFAULT_KEY) as
    | { playgroundPlanId?: string }
    | undefined;
  if (!data || typeof data !== 'object') return undefined;
  return data.playgroundPlanId;
}

/**
 * 写 playground 挂载/解除。
 * @param planId 非空时须指向存在的方案，否则 throw ModelRoutingPlanNotFoundError（handler 转 400）
 * @param planId undefined = 解除（data={}）
 */
export function setPlaygroundPlanId(svc: AppConfigService, planId: string | undefined): void {
  if (planId !== undefined && planId !== '') {
    const plan = getPlan(svc, planId);
    if (!plan) throw new ModelRoutingPlanNotFoundError(`plan not found: ${planId}`);
    svc.set(MODEL_ROUTING_GROUP, MODEL_ROUTING_DEFAULT_KEY, { playgroundPlanId: planId });
    return;
  }
  svc.set(MODEL_ROUTING_GROUP, MODEL_ROUTING_DEFAULT_KEY, {});
}
