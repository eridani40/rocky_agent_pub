/**
 * 模型路由方案校验（纯函数 + app_config providers 读取）
 * 参考: specs/api/overall/21-model-routing.md §2.2（校验表 + message 契约）
 *       specs/tech/agent/providers_and_models/[P0]model_routing.md §2.1/§2.3（数据形状 + 同模型条目约束）
 *
 * 职责：validateModelRoutingPlan 全规则静态校验（PUT model_routing_plans 时服务端硬拒绝 400）。
 * 规则（api §2.2 + tech §2.3）：
 *   - name 非空 / items 非空数组
 *   - 每条目 providerId+modelId 必须指向 enabled provider 的 enabled model（复用 model-validation，精确匹配）
 *   - 同模型（providerId+modelId）按**启用**条目分组：≤2 条、禁 2 带时间、禁 2 不带时间、
 *     带时间必须排在不带时间上面
 *   - priority 正整数且全局唯一
 *   - enabled 缺省 true 兼容（旧 client 无字段视为启用，不 400）
 *   - timeCondition.hours 0-23 整数白名单（去重）；hours 空数组 = 全天等价无条件（tech §2.1 清空=全天）
 *
 * 纯函数无副作用；错误 message 对齐 api 表（英文，中文文案由前端 i18n）。
 */
import type { AppConfigService } from '../config/app-config-service';
import { isReservedModelId, validateModelId } from './model-validation';

/** [v0.0.353 T1] 调度时区缺省值：旧方案无 timezone 时按 Asia/Shanghai 生效（向后兼容，禁止默认 UTC） */
export const DEFAULT_ROUTING_TIMEZONE = 'Asia/Shanghai';

/**
 * 时间条件（hours 0-23 白名单；缺省/空数组 = 随时可用）。
 * [v0.0.353 T1] timezone 可选：时间过滤按此时区取小时（合法 IANA 字符串）；
 * 缺省 DEFAULT_ROUTING_TIMEZONE（Asia/Shanghai）——与既有用户/服务器配置一致，旧方案零突变。
 */
export interface TimeCondition {
  hours: number[];
  timezone?: string;
}

/** 方案条目（有序降级链成员；priority 1 = 最高优先） */
export interface RoutingItem {
  providerId: string;
  modelId: string;
  priority: number;
  timeCondition?: TimeCondition;
  /** 启用/停用开关；缺省 true（旧 client 兼容） */
  enabled: boolean;
}

/** 方案级熔断参数覆盖（缺省用默认值 4/2/60/0.6/10/20） */
export interface CircuitConfig {
  failureThreshold?: number;
  successThreshold?: number;
  timeoutSeconds?: number;
  errorRateThreshold?: number;
  minRequests?: number;
  /** [v0.0.347 T5] 错误率滑动窗口大小（最近 N 次请求；老板 20:51 拍板，决策⑳） */
  windowSize?: number;
}

/** 熔断默认参数（cc-switch 官方默认 + T5 窗口；tech §6.1 权威） */
export const DEFAULT_CIRCUIT_CONFIG: Required<CircuitConfig> = {
  failureThreshold: 4,
  successThreshold: 2,
  timeoutSeconds: 60,
  errorRateThreshold: 0.6,
  minRequests: 10,
  windowSize: 20,
};

/**
 * 方案级 circuit 覆盖 → 生效参数（默认值填充后）。
 * 纯函数：缺省/部分覆盖时补默认；供 session-config（填 SessionConfig.modelRoutingPlan.circuit）
 * 与 circuit_breaker_registry（条目阈值判定）共用同一默认源。
 */
export function fillCircuitDefaults(circuit?: CircuitConfig): Required<CircuitConfig> {
  return { ...DEFAULT_CIRCUIT_CONFIG, ...(circuit ?? {}) };
}

/** 模型路由方案（方案库实体；id = app_config model_routing_plans 组 record key） */
export interface ModelRoutingPlan {
  id: string;
  name: string;
  items: RoutingItem[];
  circuit?: CircuitConfig;
  createdAt: number;
}

/** 校验结果：ok=true 合法；ok=false + error（api §2.2 表 message） */
export type ModelRoutingPlanValidation = { ok: true } | { ok: false; error: string };

/** 条目是否启用（enabled 缺省 true 兼容；显式 false 才停用） */
export function isItemEnabled(item: { enabled?: boolean }): boolean {
  return item.enabled !== false;
}

/** 条目是否带时间条件（timeCondition 存在且 hours 非空 = 带时间；hours 空数组 = 全天等价无条件） */
export function isItemTimeConditioned(item: RoutingItem): boolean {
  return !!item.timeCondition && Array.isArray(item.timeCondition.hours) && item.timeCondition.hours.length > 0;
}

/** [v0.0.353 T1] timezone 是否合法 IANA 字符串（Intl 原生探测，不引入依赖；非法时构造抛 RangeError） */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * 方案静态校验（纯函数）。
 * @param plan 待校验方案（unknown，handler 透传 PUT data）
 * @param svc  app_config 服务（providers 组读取）
 * @returns ok=true 合法；ok=false + error（api §2.2 表 message）
 */
export function validateModelRoutingPlan(
  plan: unknown,
  svc: AppConfigService,
): ModelRoutingPlanValidation {
  // ① 基础结构：name 非空 / items 非空数组
  if (!plan || typeof plan !== 'object') {
    return { ok: false, error: 'invalid model routing plan: name/items required' };
  }
  const p = plan as Partial<ModelRoutingPlan>;
  if (typeof p.name !== 'string' || p.name.length === 0) {
    return { ok: false, error: 'invalid model routing plan: name/items required' };
  }
  if (!Array.isArray(p.items) || p.items.length === 0) {
    return { ok: false, error: 'invalid model routing plan: name/items required' };
  }
  if (typeof p.id !== 'string' || p.id.length === 0) {
    return { ok: false, error: 'invalid model routing plan: id required' };
  }

  // ② 逐条目：结构 + 模型校验（enabled provider 的 enabled model，providerId 精确匹配）
  for (const raw of p.items) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'invalid model routing plan: items must be objects' };
    }
    const item = raw as Partial<RoutingItem>;
    if (typeof item.providerId !== 'string' || item.providerId.length === 0) {
      return { ok: false, error: 'invalid item: providerId required' };
    }
    if (typeof item.modelId !== 'string' || item.modelId.length === 0) {
      return { ok: false, error: 'invalid item: modelId required' };
    }
    // [v0.0.347 review Major-1] 保留字 modelId（'default'/'none'）在方案条目中无意义
    // （方案条目必须是真实模型；保留字是 session/squad 的「跟随默认」语义，方案链不适用）。
    // validateModelId 对保留字返回 ok（其保留字白名单），这里必须前置拦截。
    if (isReservedModelId(item.modelId)) {
      return {
        ok: false,
        error: `model routing plan item: model not found or disabled: ${item.providerId}/${item.modelId}`,
      };
    }
    // 复用 model-validation：providerId hint 精确匹配该 provider 的 enabled model
    const mv = validateModelId(svc, item.modelId, item.providerId);
    if (!mv.ok) {
      return {
        ok: false,
        error: `model routing plan item: model not found or disabled: ${item.providerId}/${item.modelId}`,
      };
    }
    // timeCondition.hours 白名单（0-23 整数 + 去重）
    if (item.timeCondition !== undefined) {
      if (!item.timeCondition || typeof item.timeCondition !== 'object') {
        return { ok: false, error: `invalid timeCondition: ${item.providerId}/${item.modelId}` };
      }
      const hours = item.timeCondition.hours;
      if (!Array.isArray(hours) || hours.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) {
        return { ok: false, error: `invalid timeCondition hours: must be integers in 0-23: ${item.providerId}/${item.modelId}` };
      }
      if (new Set(hours).size !== hours.length) {
        return { ok: false, error: `invalid timeCondition hours: duplicates not allowed: ${item.providerId}/${item.modelId}` };
      }
      // [v0.0.353 T1 D1] timezone 合法性：必须是合法 IANA 字符串（如 "Asia/Shanghai"、"UTC"）。
      //   非法硬拒 400（避免静默回退到缺省时区造成调度语义漂移）。
      if (item.timeCondition.timezone !== undefined) {
        if (typeof item.timeCondition.timezone !== 'string' || !isValidTimezone(item.timeCondition.timezone)) {
          return { ok: false, error: `invalid timeCondition timezone: must be a valid IANA timezone string: ${item.providerId}/${item.modelId}` };
        }
      }
    }
  }

  // ③ priority：正整数 + 全局唯一
  const seenPriority = new Set<number>();
  for (const item of p.items as RoutingItem[]) {
    if (!Number.isInteger(item.priority) || item.priority <= 0) {
      return { ok: false, error: 'invalid priority: must be positive unique integers' };
    }
    if (seenPriority.has(item.priority)) {
      return { ok: false, error: 'invalid priority: must be positive unique integers' };
    }
    seenPriority.add(item.priority);
  }

  // ③.5 [v0.0.347 T5] circuit 参数校验（决策㉔）：windowSize 整数 [1,1000] + 生效值 minRequests ≤ windowSize
  //    （minRequests > windowSize → 窗口永不满 → 错误率轨道永久沉默，病态配置硬拒 400）
  if (p.circuit !== undefined && p.circuit !== null) {
    const c = p.circuit as CircuitConfig;
    if (typeof c !== 'object') {
      return { ok: false, error: 'invalid circuit: must be an object' };
    }
    if (c.windowSize !== undefined && (!Number.isInteger(c.windowSize) || c.windowSize < 1 || c.windowSize > 1000)) {
      return { ok: false, error: 'invalid circuit: windowSize must be an integer in 1-1000' };
    }
    // 生效值比较：windowSize 缺省 20 / minRequests 缺省 10（与 fillCircuitDefaults 同源默认）
    const effWindow = c.windowSize ?? DEFAULT_CIRCUIT_CONFIG.windowSize;
    const effMin = c.minRequests ?? DEFAULT_CIRCUIT_CONFIG.minRequests;
    if (effMin > effWindow) {
      return { ok: false, error: `invalid circuit: minRequests(${effMin}) must be <= windowSize(${effWindow})` };
    }
  }

  // ④ 同模型约束（按启用条目分组统计；停用不占额度）
  const groups = new Map<string, { time: RoutingItem[]; uncond: RoutingItem[] }>();
  for (const item of p.items as RoutingItem[]) {
    if (!isItemEnabled(item)) continue;
    const key = `${item.providerId}|${item.modelId}`;
    const g = groups.get(key) ?? { time: [], uncond: [] };
    (isItemTimeConditioned(item) ? g.time : g.uncond).push(item);
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    const sep = key.indexOf('|');
    const pid = key.slice(0, sep);
    const mid = key.slice(sep + 1);
    // ≤2 条：任何 >2 组合必含 2 同类，由下面两条命中（无需单独 message）
    if (g.time.length > 1) {
      return { ok: false, error: `same model cannot have 2 time-condition items: ${pid}/${mid}` };
    }
    if (g.uncond.length > 1) {
      return { ok: false, error: `same model cannot have 2 unconditional items: ${pid}/${mid}` };
    }
    // 带时间必须排在不带时间上面（组内带时间条目 priority < 无条件条目 priority）
    if (g.time.length === 1 && g.uncond.length === 1 && g.time[0]!.priority > g.uncond[0]!.priority) {
      return { ok: false, error: `time-condition item must be above unconditional item: ${pid}/${mid}` };
    }
  }

  return { ok: true };
}
