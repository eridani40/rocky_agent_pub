/**
 * model-routing-api — 模型路由前端 API 调用层（v0.0.347）
 * 参考 specs/api/overall/21-model-routing.md §1/§2（端点契约）
 *
 * 职责：方案库 CRUD + 状态查询的薄封装（复用 req/getConfigGroup）。
 * 边界：纯 async 函数，不持 React state；错误直接 throw（req 已转 Error(message)）。
 */
import { req, getConfigGroup } from '../../lib/api-client';
import { getSquad, listSquads } from '../../lib/squad-api';
import type { ModelRoutingPlan, ModelRoutingPlanRecord, ModelRoutingStatus } from './model-routing-types';

/** GET /config/app?group=model_routing_plans → 方案库列表（按 createdAt 排序，api §2.1） */
export async function listModelRoutingPlans(base?: string): Promise<ModelRoutingPlan[]> {
  const items = await getConfigGroup('app', 'model_routing_plans', base);
  return (items as ModelRoutingPlanRecord[])
    .map((r) => r.data)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/** PUT /config/app {group:'model_routing_plans', key, data} → 新建/编辑方案（api §2.2，400 message 透传） */
export async function saveModelRoutingPlan(plan: ModelRoutingPlan, base?: string): Promise<void> {
  await req<{ ok: true }>(
    '/config/app',
    { method: 'PUT', body: JSON.stringify({ group: 'model_routing_plans', key: plan.id, data: plan }) },
    base,
  );
}

/** DELETE /config/app?group=model_routing_plans&key=<planId> → 删除方案（api §2.3，返 detached 清单） */
export async function deleteModelRoutingPlan(planId: string, base?: string): Promise<{ detached: string[] }> {
  return req<{ ok: true; detached: string[] }>(
    `/config/app?group=${encodeURIComponent('model_routing_plans')}&key=${encodeURIComponent(planId)}`,
    { method: 'DELETE' },
    base,
  );
}

/** GET /model-routing/plans/:planId/status → 方案内模型红绿灯状态（api §2.6） */
export async function getModelRoutingStatus(planId: string, base?: string): Promise<ModelRoutingStatus> {
  return req<ModelRoutingStatus>(
    `/model-routing/plans/${encodeURIComponent(planId)}/status`,
    undefined,
    base,
  );
}

/**
 * 聚合挂载徽章数据源（change_plan 决策⑯，UI v2）：
 * squads（GET /squad 列表 + 逐个 GET /squad/:id 读 modelRoutingPlanId）+ playground
 * （GET /config/app?group=model_routing&key=default → playgroundPlanId）→ Record<planId, 挂载名[]>。
 *
 * [偏离记录] 契约原文假设 SquadSummary 含 modelRoutingPlanId，实际该字段仅在
 * SquadDetail（toSummary 不透传）；后端零改动边界下改为 listSquads + 逐个 getSquad
 * 聚合（N+1 只在方案库列表拉一次，可接受）。任一请求失败 throw（section 侧 catch 降级空）。
 */
export async function listPlanMounts(base?: string): Promise<Record<string, string[]>> {
  const [squads, playgroundGroup] = await Promise.all([
    listSquads(base),
    getConfigGroup('app', 'model_routing', base),
  ]);
  const details = await Promise.all(squads.map((s) => getSquad(s.id, base).catch(() => null)));
  const mounts: Record<string, string[]> = {};
  for (const d of details) {
    const planId = d?.modelRoutingPlanId;
    if (!planId) continue;
    (mounts[planId] ??= []).push(d.name);
  }
  const playgroundPlanId = (playgroundGroup.find((r) => r.key === 'default')?.data as
    | { playgroundPlanId?: string }
    | undefined)?.playgroundPlanId;
  if (playgroundPlanId) (mounts[playgroundPlanId] ??= []).push('Playground');
  return mounts;
}

/** 新建方案默认名「方案 N」（N = 现有数量 + 1；change_plan ui-settings 行） */
export function defaultPlanName(existingCount: number): string {
  return `方案 ${existingCount + 1}`;
}

/** 复制方案名：「<原名> 副本」（change_plan ui-settings 行） */
export function copyPlanName(name: string): string {
  return `${name} 副本`;
}

/**
 * 读 playground 方案挂载（T6 决策㉙）：GET /config/app?group=model_routing&key=default
 * → playgroundPlanId（无 record/无字段 → null）。savePlaygroundMount 的对称读函数。
 */
export async function getPlaygroundMount(base?: string): Promise<string | null> {
  const items = await getConfigGroup('app', 'model_routing', base);
  const data = (items.find((r) => r.key === 'default')?.data as
    | { playgroundPlanId?: string }
    | undefined);
  return data?.playgroundPlanId ?? null;
}

/**
 * 写 playground 方案挂载（T6 决策㉙）：PUT /config/app {group:'model_routing',key:'default'}。
 * planId 非空 → data {playgroundPlanId}；null → data {}（清挂载）。
 * 端点为既有 KV 通用 PUT，无新后端契约（change_plan L206）。
 */
export async function savePlaygroundMount(planId: string | null, base?: string): Promise<void> {
  await req<{ ok: true }>(
    '/config/app',
    {
      method: 'PUT',
      body: JSON.stringify({
        group: 'model_routing',
        key: 'default',
        data: planId ? { playgroundPlanId: planId } : {},
      }),
    },
    base,
  );
}
