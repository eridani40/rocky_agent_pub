/**
 * GET /model-routing/plans/:planId/status — 方案内模型熔断状态（红绿灯数据源）
 * 参考: specs/api/overall/21-model-routing.md §2.6（响应形状 + D16 presentation 映射）
 *       specs/tech/agent/providers_and_models/[P0]model_routing.md §6.2（三态呈现映射）
 *
 * 设计：
 *   - 只读内存态快照（不持久化）：读方案实体 + circuitRegistry.snapshot；
 *   - items = 方案内全部条目按 priority 去重（同模型多 item 只出一条，取当前熔断状态）；
 *   - presentation 映射为权威（D16）：closed→normal（无倒计时）/ open→abnormal+remainingSeconds /
 *     half_open→observing（无倒计时）；
 *   - planId 不存在 → 404；planId 缺失 → 400。
 *
 * [v0.0.347 T1/T2 边界]：CircuitBreakerRegistry 由 T2 实现（llm/caller/circuit_breaker_registry.ts）。
 * 本 handler 只依赖 CircuitRegistryPort 端口接口；T1 路由注册注入空实现（全 closed 基态），
 * T2 接线真实 registry（globalThis 单例）后快照即真实内存态。
 */
import type { AppConfigService } from '../config/app-config-service';
import { getPlan } from '../services/model-routing-store';

/** 熔断三态（D16 内部逻辑态；呈现映射见下） */
export type CircuitState = 'closed' | 'open' | 'half_open';

/** 用户呈现态（D16 权威；UI 直接消费，不给熔断器词） */
export type CircuitPresentation = 'normal' | 'abnormal' | 'observing';

/** 熔断注册表快照条目（T2 CircuitBreakerRegistry.snapshot 输出形状） */
export interface CircuitSnapshotEntry {
  planId: string;
  providerId: string;
  modelId: string;
  state: CircuitState;
  /** [v0.0.347 T5] 终身累计失败数（口径：终身；与 errorRate 窗口口径分界） */
  failureCount: number;
  /** [v0.0.347 T5] 终身累计请求数（口径：终身；与 errorRate 窗口口径分界） */
  totalRequests: number;
  /** [v0.0.347 T5] 错误率（口径：滑动窗口——最近生效 windowSize 次请求内失败占比；样本 0 → 0） */
  errorRate: number;
  /** Open 剩余秒（仅 state==='open' 有；closed/half_open 省略） */
  remainingSeconds?: number;
}

/** 熔断注册表端口（T1 只依赖快照读；T2 实现真实状态机） */
export interface CircuitRegistryPort {
  snapshot(): CircuitSnapshotEntry[];
}

/** T1 空实现：无任何熔断记录（全 closed 基态）。T2 接线真实 registry 后替换。 */
export class EmptyCircuitRegistry implements CircuitRegistryPort {
  snapshot(): CircuitSnapshotEntry[] {
    return [];
  }
}

/** 构造 JSON Response */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * D16 presentation 映射（权威表）：
 *   closed → normal（🟢 正常，无倒计时）
 *   open → abnormal（🔴 异常，带 remainingSeconds 倒计时）
 *   half_open → observing（🟡 观察中，无倒计时）
 */
export function mapCircuitPresentation(
  state: CircuitState,
  entry?: CircuitSnapshotEntry,
): { presentation: CircuitPresentation; remainingSeconds?: number } {
  if (state === 'open') {
    return { presentation: 'abnormal', remainingSeconds: entry?.remainingSeconds };
  }
  if (state === 'half_open') return { presentation: 'observing' };
  return { presentation: 'normal' };
}

/**
 * 处理 GET /model-routing/plans/:planId/status。
 * @param planId  URL 路径参数（缺失/空 → 400）
 * @param svc     app_config 服务（读方案实体）
 * @param registry 熔断注册表端口（T1 空实现 / T2 真实 registry）
 */
export function handleModelRoutingStatus(
  planId: string | undefined,
  svc: AppConfigService,
  registry: CircuitRegistryPort,
): Response {
  if (!planId || planId.length === 0) {
    return json(400, { error: 'planId required' });
  }
  const plan = getPlan(svc, planId);
  if (!plan) return json(404, { error: 'plan not found' });

  // 熔断快照索引：key = providerId|modelId → entry（同模型多 item 共享一个熔断态）
  const snapshotMap = new Map<string, CircuitSnapshotEntry>();
  for (const e of registry.snapshot()) {
    if (e.planId !== planId) continue;
    snapshotMap.set(`${e.providerId}|${e.modelId}`, e);
  }

  // items：方案内全部条目按 priority 升序，同模型多 item 只出一条（取当前熔断状态）
  const seen = new Set<string>();
  const items: Array<{
    providerId: string;
    modelId: string;
    circuitState: CircuitState;
    presentation: CircuitPresentation;
    remainingSeconds?: number;
    failureCount: number;
    totalRequests: number;
    errorRate: number;
  }> = [];
  const sorted = [...plan.items].sort((a, b) => a.priority - b.priority);
  for (const item of sorted) {
    const key = `${item.providerId}|${item.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = snapshotMap.get(key);
    const state: CircuitState = entry?.state ?? 'closed';
    const mapped = mapCircuitPresentation(state, entry);
    items.push({
      providerId: item.providerId,
      modelId: item.modelId,
      circuitState: state,
      presentation: mapped.presentation,
      ...(mapped.remainingSeconds !== undefined ? { remainingSeconds: mapped.remainingSeconds } : {}),
      failureCount: entry?.failureCount ?? 0,
      totalRequests: entry?.totalRequests ?? 0,
      errorRate: entry?.errorRate ?? 0,
    });
  }
  return json(200, { planId, items });
}
