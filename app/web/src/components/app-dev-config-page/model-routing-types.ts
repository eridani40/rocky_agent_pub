/**
 * model-routing-types — 模型路由前端类型（v0.0.347）
 * 参考 specs/api/overall/21-model-routing.md §3（data schema 与 api 契约一致）
 *
 * 只放类型，不放逻辑（逻辑在各 component 内）。
 */
import type { CircuitPresentation } from './component-circuit-status';

/** 方案条目（api §3 RoutingItem） */
export interface RoutingItem {
  providerId: string;
  modelId: string;
  /** 1 最高（尝试顺序 = priority 升序） */
  priority: number;
  /** 白名单小时（0-23；缺省 = 随时可用） */
  timeCondition?: { hours: number[] };
  /** 默认 true（停用 = 保留配置但路由直接跳过） */
  enabled: boolean;
}

/** 熔断参数（api §3 CircuitConfig，全 optional 缺省默认 4/2/60/0.6/10） */
export interface CircuitConfig {
  failureThreshold?: number;
  successThreshold?: number;
  timeoutSeconds?: number;
  errorRateThreshold?: number;
  minRequests?: number;
}

/** 模型组合方案（api §3 ModelRoutingPlan） */
export interface ModelRoutingPlan {
  id: string;
  name: string;
  items: RoutingItem[];
  circuit?: CircuitConfig;
  createdAt: number;
}

/** GET /config/app?group=model_routing_plans 响应 item（api §2.1） */
export interface ModelRoutingPlanRecord {
  key: string;
  data: ModelRoutingPlan;
}

/** GET /model-routing/plans/:planId/status 响应 item（api §2.6） */
export interface ModelRoutingStatusItem {
  providerId: string;
  modelId: string;
  circuitState: 'closed' | 'open' | 'half_open';
  presentation: CircuitPresentation;
  /** 仅 open 有（倒计时秒） */
  remainingSeconds?: number;
  failureCount?: number;
  totalRequests?: number;
  errorRate?: number;
}

/** GET /model-routing/plans/:planId/status 响应（api §2.6） */
export interface ModelRoutingStatus {
  planId: string;
  items: ModelRoutingStatusItem[];
}
