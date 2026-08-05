/**
 * ProviderHealthRegistry — session-scoped (sessionId, providerId, keyRef, modelId) 健康注册表实现
 * 参考: specs/tech/agent/llm_caller/[P0]provider_health_registry.md
 *
 * session-scoped 存储、key = (sessionId, providerId, keyRef, modelId) 四元组——
 *   per-session × per-model 双隔离(spec §1/§6.5):
 *     - A session 的 cooldown 不影响 B session(session 隔离)
 *     - 同 provider 不同 model 独立 cooldown(model 隔离,opus 不连累 sonnet)
 *
 * 核心约束(spec §2/§6.3): 4 态 discriminated union;consecutive 拆 overload/rate_limit/auth
 * 三计数(§6.4);升级 §3.1 / 恢复 §3.2 / chain-switch 不累加 §5。
 *
 * 进程级存储实例(globalThis.__providerHealthRegistry,Map<sessionId, Map<compositeKey, Entry>>),
 * 状态读写都按 session 分区,session 结束 cleanupSession 清理对应分区。
 *
 * 类型/接口在 provider_health_types.ts;本文件 re-export 以保持外部 import 路径不变。
 */
import type {
  ProviderHealthState,
  HealthCounters,
  HealthEntry,
  HealthProbe,
  HealthTier,
  HealthRelevantCategory,
  DegradationConfig,
  ProviderHealthRegistry,
} from './provider_health_types';

// re-export 类型/常量供外部 import './provider_health_registry' 路径稳定
export {
  DEFAULT_DEGRADATION_CONFIG,
} from './provider_health_types';
export type {
  HealthRelevantCategory,
  ProviderHealthState,
  HealthCounters,
  HealthEntry,
  HealthTier,
  HealthProbe,
  DegradationConfig,
  ProviderHealthRegistry,
} from './provider_health_types';

import { DEFAULT_DEGRADATION_CONFIG } from './provider_health_types';

/** 初始全零计数(auth 计数可保留传入)。 */
function zeroCounters(auth = 0): HealthCounters {
  return { overload: 0, rate_limit: 0, auth };
}

/**
 * 取状态联合的「全宽」status 字面量。用于 refresh() 后再判 dead:TS 会把
 * entry.state.status 沿用早前 narrow(已排除 dead),需经此 helper 重新展开。
 */
function widenStatus(state: ProviderHealthState): HealthTier {
  return state.status;
}

/**
 * composite key — session 内 (provider, key, model) 三元组拼接(spec §6.5 实现)。
 * sessionId 单独作 Map<sessionId, Map<compositeKey, Entry>> 的外层 key。
 */
function compositeKey(providerId: string, keyRef: string, modelId: string): string {
  return `${providerId}::${keyRef}::${modelId}`;
}

/** 内部实现类(不导出,只通过单例工厂暴露)。 */
class ProviderHealthRegistryImpl implements ProviderHealthRegistry {
  /** Map<sessionId, Map<compositeKey, HealthEntry>> —— session-scoped 存储(spec §6.5)。 */
  private sessions = new Map<string, Map<string, HealthEntry>>();
  constructor(private readonly config: DegradationConfig) {}

  private getOrCreate(
    sessionId: string,
    providerId: string,
    keyRef: string,
    modelId: string,
  ): HealthEntry {
    let table = this.sessions.get(sessionId);
    if (!table) {
      table = new Map();
      this.sessions.set(sessionId, table);
    }
    const k = compositeKey(providerId, keyRef, modelId);
    let e = table.get(k);
    if (!e) {
      e = { sessionId, providerId, keyRef, modelId, state: { status: 'healthy', consecutive: zeroCounters() } };
      table.set(k, e);
    }
    return e;
  }

  /** spec §3.2 refreshState: 到期回 healthy(half-open defer,auth 计数保留)。 */
  private refresh(entry: HealthEntry, now: number): void {
    const s = entry.state;
    if (s.status === 'cooled_down' && now >= s.until) {
      entry.state = { status: 'healthy', consecutive: zeroCounters(s.consecutive.auth) };
    } else if (s.status === 'degraded' && now >= s.until) {
      entry.state = { status: 'healthy', consecutive: zeroCounters(s.consecutive.auth) };
    }
    // dead 不自动恢复(spec §3.2/§6.1)
  }

  getState(
    sessionId: string,
    providerId: string,
    keyRef: string,
    modelId: string,
    now: number,
  ): ProviderHealthState {
    const entry = this.getOrCreate(sessionId, providerId, keyRef, modelId);
    this.refresh(entry, now);
    return entry.state;
  }

  /** 把 state 转为 HealthProbe(供 isPreferred/isAvailable 共用)。 */
  private toProbe(state: ProviderHealthState, allowDegraded: boolean): HealthProbe {
    if (state.status === 'healthy') return { ok: true, tier: 'healthy' };
    if (state.status === 'degraded' && allowDegraded) return { ok: true, tier: 'degraded' };
    if (state.status === 'dead') return { ok: false, tier: 'dead', reason: state.reason };
    if (state.status === 'cooled_down') {
      return { ok: false, tier: 'cooled_down', reason: 'provider cooled_down', until: state.until };
    }
    // degraded 但 allowDegraded=false(isPreferred 路径,留给第 2 遍兜底)
    return { ok: false, tier: 'degraded', reason: 'provider degraded', until: state.until };
  }

  isPreferred(
    sessionId: string,
    providerId: string,
    keyRef: string,
    modelId: string,
    now: number,
  ): HealthProbe {
    const entry = this.getOrCreate(sessionId, providerId, keyRef, modelId);
    this.refresh(entry, now);
    // 第 1 遍:仅 healthy 才 ok=true(degraded 不选,留给第 2 遍)
    return this.toProbe(entry.state, /* allowDegraded */ false);
  }

  isAvailable(
    sessionId: string,
    providerId: string,
    keyRef: string,
    modelId: string,
    now: number,
  ): HealthProbe {
    const entry = this.getOrCreate(sessionId, providerId, keyRef, modelId);
    this.refresh(entry, now);
    // 第 2 遍:healthy 或 degraded 兜底可用(spec §2 v2.0)
    return this.toProbe(entry.state, /* allowDegraded */ true);
  }

  /** spec §3.1 escalate 升级规则。 */
  escalate(
    sessionId: string,
    providerId: string,
    keyRef: string,
    modelId: string,
    category: HealthRelevantCategory,
    now: number,
  ): void {
    const entry = this.getOrCreate(sessionId, providerId, keyRef, modelId);
    // dead 是终态,不再累计(spec §3.1)
    if (entry.state.status === 'dead') return;
    this.refresh(entry, now);
    if (widenStatus(entry.state) === 'dead') return; // refresh 不产 dead,防御

    const c = entry.state.consecutive;
    // 1. 累加 consecutive(按 category)
    if (category === 'PROVIDER_OVERLOADED') {
      c.overload += 1;
    } else if (category === 'RATE_LIMITED') {
      c.rate_limit += 1;
    } else {
      // AUTH_INVALID / AUTH_FORBIDDEN
      c.auth += 1;
      if (c.auth >= this.config.consecutiveToDegrade) {
        entry.state = { status: 'dead', reason: `auth failed ${c.auth} times`, at: now };
        return;
      }
    }

    // 2. overload/rate_limit 总数达阈值 → 升级状态
    const totalInstant = c.overload + c.rate_limit;
    if (totalInstant >= this.config.consecutiveToDegrade) {
      const cur = entry.state.status;
      if (cur === 'healthy') {
        entry.state = { status: 'cooled_down', until: now + this.config.cooldownS * 1000, consecutive: c };
      } else if (cur === 'cooled_down') {
        // 已 cooled_down 又失败 → degraded(2 倍 cooldown)
        entry.state = { status: 'degraded', until: now + this.config.cooldownS * 2000, consecutive: c };
      } else if (cur === 'degraded') {
        entry.state = {
          status: 'dead', reason: `instant errors ${totalInstant} times (degraded escalate)`, at: now,
        };
      }
    }
  }

  /** spec §3.3 recordSuccess: 清 overload/rate_limit(auth 不清)+ 降级恢复 healthy。 */
  recordSuccess(sessionId: string, providerId: string, keyRef: string, modelId: string): void {
    const entry = this.getOrCreate(sessionId, providerId, keyRef, modelId);
    if (entry.state.status === 'dead') return; // dead 不因成功恢复
    const c = entry.state.consecutive;
    c.overload = 0;
    c.rate_limit = 0;
    // auth 不清(硬错累计,见 spec §3.3)
    if (entry.state.status === 'cooled_down' || entry.state.status === 'degraded') {
      entry.state = { status: 'healthy', consecutive: c };
    }
  }

  markDead(
    sessionId: string,
    providerId: string,
    keyRef: string,
    modelId: string,
    reason: string,
    now: number,
  ): void {
    const entry = this.getOrCreate(sessionId, providerId, keyRef, modelId);
    entry.state = { status: 'dead', reason, at: now };
  }

  cleanupSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  snapshot(sessionId: string): HealthEntry[] {
    const table = this.sessions.get(sessionId);
    if (!table) return [];
    // 深拷贝避免外部 mutate 内部状态
    return Array.from(table.values()).map((e) => ({
      sessionId: e.sessionId,
      providerId: e.providerId,
      keyRef: e.keyRef,
      modelId: e.modelId,
      state:
        e.state.status === 'dead'
          ? { status: 'dead', reason: e.state.reason, at: e.state.at }
          : ({
              status: e.state.status,
              until: e.state.status === 'healthy' ? undefined : e.state.until,
              consecutive: { ...e.state.consecutive },
            } as ProviderHealthState),
    }));
  }
}

/** globalThis 单例 key(spec §6.5:进程级存储实例,但状态按 session 分区)。 */
const REGISTRY_GLOBAL_KEY = '__providerHealthRegistry';

interface GlobalWithRegistry {
  [REGISTRY_GLOBAL_KEY]?: ProviderHealthRegistryImpl;
}

/**
 * 获取/创建进程级存储单例(spec §6.5 v2.0)。
 *
 * 实例本身进程级共享(单 Map<sessionId, ...>),但状态读写按 sessionId 分区,
 * A session 不影响 B session。session 结束调 cleanupSession 清理对应分区。
 * config 仅在首次创建时生效(后续忽略,保持单例稳定)。
 */
export function getProviderHealthRegistry(
  config: DegradationConfig = DEFAULT_DEGRADATION_CONFIG,
): ProviderHealthRegistry {
  const g = globalThis as unknown as GlobalWithRegistry;
  if (!g[REGISTRY_GLOBAL_KEY]) {
    g[REGISTRY_GLOBAL_KEY] = new ProviderHealthRegistryImpl(config);
  }
  return g[REGISTRY_GLOBAL_KEY]!;
}

/**
 * 重置单例(仅 UT 用,生产代码勿调)。
 * 清 globalThis 引用,下次 getProviderHealthRegistry 会新建。
 */
export function __resetProviderHealthRegistryForTest(): void {
  const g = globalThis as unknown as GlobalWithRegistry;
  delete g[REGISTRY_GLOBAL_KEY];
}

/**
 * 创建独立 registry 实例(不挂 globalThis)。
 *
 * UT 用:验证单条目逻辑时隔离 globalThis 污染。
 * 生产代码应用 getProviderHealthRegistry(单例)。
 */
export function createProviderHealthRegistry(
  config: DegradationConfig = DEFAULT_DEGRADATION_CONFIG,
): ProviderHealthRegistry {
  return new ProviderHealthRegistryImpl(config);
}
