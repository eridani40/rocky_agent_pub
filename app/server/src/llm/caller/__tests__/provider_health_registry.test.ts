/**
 * ProviderHealthRegistry 单测(v2.0 — session-scoped 四元组 key)
 *
 * 参考:
 *   - specs/tech/agent/llm_caller/[P0]provider_health_registry.md v2.0(权威 spec)
 *   - specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md §2
 *
 * 覆盖点(rev2):
 *   1. 4 态 discriminated union(无 impossible state)
 *   2. 升级阈值: overload/rate_limit 总数达阈值升级;AUTH 连续即 dead
 *   3. cooldown 到期恢复(MVP 直接回 healthy;auth 计数保留)
 *   4. chain-switch 不累加(显式调才累计)
 *   5. isPreferred(仅 healthy)vs isAvailable(healthy||degraded 兜底)语义
 *   6. [rev2 新] 四元组隔离: A session 不影响 B;model X 不影响 model Y
 *   7. [rev2 新] cleanupSession 清理对应 session 分区
 *
 * 注意: account-wide quota 例外归 resolveTarget,registry 层不感知 quotaScope。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createProviderHealthRegistry,
  getProviderHealthRegistry,
  __resetProviderHealthRegistryForTest,
  DEFAULT_DEGRADATION_CONFIG,
  type ProviderHealthState,
} from '../provider_health_registry';

/** 紧凑 config(阈值 2,便于少次调用触达升级)。 */
const CFG = { consecutiveToDegrade: 2, cooldownS: 30 };
/** 测试用默认四元组参数(session/provider/key/model)。 */
const SID = 'sess-a';
const PID = 'p1';
const KEY = 'default';
const MODEL = 'm1';

/** 取 snapshot(sessionId)首条目(前置 escalate 触发懒创建,snapshot 必非空)。 */
const firstEntry = (
  r: ReturnType<typeof createProviderHealthRegistry>,
  sessionId = SID,
) => {
  const e = r.snapshot(sessionId)[0];
  if (!e) throw new Error('snapshot empty — 前置 escalate 未触发懒创建?');
  return e;
};

describe('ProviderHealthRegistry v2.0 — 4 态 union', () => {
  beforeEach(() => __resetProviderHealthRegistryForTest());

  it('初始未记录条目 isAvailable/isPreferred 返回 ok(懒创建 healthy)', () => {
    const r = createProviderHealthRegistry(CFG);
    expect(r.isAvailable(SID, PID, KEY, MODEL, 1000)).toEqual({ ok: true, tier: 'healthy' });
    expect(r.isPreferred(SID, PID, KEY, MODEL, 1000)).toEqual({ ok: true, tier: 'healthy' });
  });

  it('snapshot(sessionId) 返回 healthy 条目,consecutive 全零,含四元组字段', () => {
    const r = createProviderHealthRegistry(CFG);
    r.isAvailable(SID, PID, KEY, MODEL, 0); // 触发懒创建
    const snap = r.snapshot(SID);
    expect(snap).toHaveLength(1);
    const e0 = firstEntry(r);
    expect(e0.sessionId).toBe(SID);
    expect(e0.providerId).toBe(PID);
    expect(e0.keyRef).toBe(KEY);
    expect(e0.modelId).toBe(MODEL);
    expect(e0.state).toMatchObject({
      status: 'healthy',
      consecutive: { overload: 0, rate_limit: 0, auth: 0 },
    });
  });

  it('snapshot 返回深拷贝(外部 mutate 不污染内部)', () => {
    const r = createProviderHealthRegistry(CFG);
    r.isAvailable(SID, PID, KEY, MODEL, 0);
    const snap1 = r.snapshot(SID);
    // @ts-expect-error 故意 mutate 快照验证隔离
    snap1[0].state.status = 'dead';
    expect(firstEntry(r).state.status).toBe('healthy');
  });

  it('discriminated union: dead 态不带 consecutive / cooled_down 带 until', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, PID, KEY, MODEL, 'AUTH_INVALID', 1000);
    r.escalate(SID, PID, KEY, MODEL, 'AUTH_INVALID', 2000); // auth=2 → dead
    const dead = firstEntry(r).state as Extract<ProviderHealthState, { status: 'dead' }>;
    expect(dead.status).toBe('dead');
    expect(dead.reason).toContain('auth failed 2 times');
    expect(dead.at).toBe(2000);
    expect('consecutive' in dead).toBe(false);
    expect('until' in dead).toBe(false);

    // cooled_down 带 until
    const r2 = createProviderHealthRegistry(CFG);
    r2.escalate(SID, 'p2', 'k2', MODEL, 'PROVIDER_OVERLOADED', 1000);
    r2.escalate(SID, 'p2', 'k2', MODEL, 'PROVIDER_OVERLOADED', 2000); // total=2 → cooled_down
    const cd = firstEntry(r2, SID).state as Extract<ProviderHealthState, { status: 'cooled_down' }>;
    expect(cd.status).toBe('cooled_down');
    expect(cd.until).toBe(2000 + 30 * 1000);
    expect(cd.consecutive.overload).toBe(2);
  });
});

describe('ProviderHealthRegistry v2.0 — 升级规则(spec §3.1)', () => {
  beforeEach(() => __resetProviderHealthRegistryForTest());

  it('overload 1 次 < 阈值,仍 healthy', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    expect(firstEntry(r).state.status).toBe('healthy');
    expect(r.isAvailable(SID, PID, KEY, MODEL, 1001).ok).toBe(true);
  });

  it('overload 达阈值(2) → cooled_down,isAvailable 返 false+until', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 2000);
    const res = r.isAvailable(SID, PID, KEY, MODEL, 2500);
    expect(res).toEqual({ ok: false, tier: 'cooled_down', reason: 'provider cooled_down', until: 2000 + 30000 });
  });

  it('cooled_down 再失败 → degraded(2 倍 cooldown)', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 2000);
    r.escalate(SID, PID, KEY, MODEL, 'RATE_LIMITED', 3000); // degraded
    const s = firstEntry(r).state as Extract<ProviderHealthState, { status: 'degraded' }>;
    expect(s.status).toBe('degraded');
    expect(s.until).toBe(3000 + 30 * 2000);
    expect(s.consecutive.overload).toBe(2);
    expect(s.consecutive.rate_limit).toBe(1);
  });

  it('degraded 再失败 → dead', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 2000); // cooled_down
    r.escalate(SID, PID, KEY, MODEL, 'RATE_LIMITED', 3000); // degraded
    r.escalate(SID, PID, KEY, MODEL, 'RATE_LIMITED', 4000); // dead
    expect(firstEntry(r).state.status).toBe('dead');
  });

  it('overload + rate_limit 混合计入 totalInstant', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    r.escalate(SID, PID, KEY, MODEL, 'RATE_LIMITED', 2000); // total=2 → cooled_down
    expect(firstEntry(r).state.status).toBe('cooled_down');
  });

  it('AUTH 连续达阈值 → 直接 dead(不进 cooled_down 中间态)', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, PID, KEY, MODEL, 'AUTH_INVALID', 1000);
    expect(firstEntry(r).state.status).toBe('healthy'); // auth=1 未达阈值
    r.escalate(SID, PID, KEY, MODEL, 'AUTH_FORBIDDEN', 2000); // auth=2 → dead
    expect(firstEntry(r).state.status).toBe('dead');
  });

  it('dead 后再 escalate 不变(终态)', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, PID, KEY, MODEL, 'AUTH_INVALID', 1000);
    r.escalate(SID, PID, KEY, MODEL, 'AUTH_INVALID', 2000); // dead
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 3000); // 无效
    const s = firstEntry(r).state as Extract<ProviderHealthState, { status: 'dead' }>;
    expect(s.reason).toContain('auth failed 2 times'); // 未被覆盖
  });

  it('markDead 显式标 dead', () => {
    const r = createProviderHealthRegistry(CFG);
    r.markDead(SID, PID, KEY, MODEL, 'rotated by decide', 5000);
    expect(firstEntry(r).state.status).toBe('dead');
    expect(r.isAvailable(SID, PID, KEY, MODEL, 6000).ok).toBe(false);
  });
});

describe('ProviderHealthRegistry v2.0 — isPreferred vs isAvailable 语义(spec §2)', () => {
  beforeEach(() => __resetProviderHealthRegistryForTest());

  it('healthy: isPreferred.ok=true 且 isAvailable.ok=true(都可选)', () => {
    const r = createProviderHealthRegistry(CFG);
    r.isAvailable(SID, PID, KEY, MODEL, 0); // 懒创建
    expect(r.isPreferred(SID, PID, KEY, MODEL, 1000)).toEqual({ ok: true, tier: 'healthy' });
    expect(r.isAvailable(SID, PID, KEY, MODEL, 1000)).toEqual({ ok: true, tier: 'healthy' });
  });

  it('cooled_down: isPreferred.ok=false 且 isAvailable.ok=false(两遍都跳,尊重 until)', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 2000); // cooled_down until=32000
    const pref = r.isPreferred(SID, PID, KEY, MODEL, 30000);
    const avail = r.isAvailable(SID, PID, KEY, MODEL, 30000);
    expect(pref.ok).toBe(false);
    expect(pref.tier).toBe('cooled_down');
    expect(avail.ok).toBe(false);
    expect(avail.tier).toBe('cooled_down');
  });

  it('[rev2 关键] degraded: isPreferred.ok=false(第 1 遍跳), isAvailable.ok=true(第 2 遍兜底)', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 2000); // cooled_down
    r.escalate(SID, PID, KEY, MODEL, 'RATE_LIMITED', 3000); // degraded(until=63000)
    const pref = r.isPreferred(SID, PID, KEY, MODEL, 40000);
    const avail = r.isAvailable(SID, PID, KEY, MODEL, 40000);
    expect(pref.ok).toBe(false); // degraded 不优先
    expect(pref.tier).toBe('degraded');
    expect(avail.ok).toBe(true); // [rev2] degraded 兜底可用
    expect(avail.tier).toBe('degraded');
  });

  it('dead: isPreferred.ok=false 且 isAvailable.ok=false(两遍都排除)', () => {
    const r = createProviderHealthRegistry(CFG);
    r.markDead(SID, PID, KEY, MODEL, 'auth', 1000);
    expect(r.isPreferred(SID, PID, KEY, MODEL, 2000).ok).toBe(false);
    expect(r.isAvailable(SID, PID, KEY, MODEL, 2000).ok).toBe(false);
  });
});

describe('ProviderHealthRegistry v2.0 — 恢复规则(spec §3.2 MVP)', () => {
  beforeEach(() => __resetProviderHealthRegistryForTest());

  it('cooled_down 到期 → 直接回 healthy(overload/rate_limit 清零;auth 保留)', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, PID, KEY, MODEL, 'AUTH_INVALID', 1000); // auth=1
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 2000);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 3000); // total=2 → cooled_down, auth=1
    const until = (firstEntry(r).state as { until: number }).until;
    expect(r.isAvailable(SID, PID, KEY, MODEL, until).ok).toBe(true);
    const s = firstEntry(r).state as Extract<ProviderHealthState, { status: 'healthy' }>;
    expect(s.consecutive.overload).toBe(0);
    expect(s.consecutive.rate_limit).toBe(0);
    expect(s.consecutive.auth).toBe(1); // auth 保留(spec §3.2)
  });

  it('degraded 到期 → 回 healthy', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 2000); // cooled_down
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 3000); // degraded(until=3000+60000)
    const until = (firstEntry(r).state as { until: number }).until;
    expect(r.isAvailable(SID, PID, KEY, MODEL, until).ok).toBe(true);
  });

  it('cooled_down 未到期 → isAvailable false', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 2000); // cooled_down until=32000
    expect(r.isAvailable(SID, PID, KEY, MODEL, 30000).ok).toBe(false);
  });

  it('dead 不自动恢复(到期仍 dead)', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, PID, KEY, MODEL, 'AUTH_INVALID', 1000);
    r.escalate(SID, PID, KEY, MODEL, 'AUTH_INVALID', 2000); // dead
    expect(r.isAvailable(SID, PID, KEY, MODEL, 999999999).ok).toBe(false);
  });
});

describe('ProviderHealthRegistry v2.0 — recordSuccess(spec §3.3)', () => {
  beforeEach(() => __resetProviderHealthRegistryForTest());

  it('成功清 overload/rate_limit 计数;auth 不清', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    r.escalate(SID, PID, KEY, MODEL, 'AUTH_INVALID', 2000);
    r.recordSuccess(SID, PID, KEY, MODEL);
    const s = firstEntry(r).state as Extract<ProviderHealthState, { status: 'healthy' }>;
    expect(s.consecutive.overload).toBe(0);
    expect(s.consecutive.rate_limit).toBe(0);
    expect(s.consecutive.auth).toBe(1); // 不清
  });

  it('成功让 cooled_down/degraded 降级回 healthy', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 2000); // cooled_down
    expect(firstEntry(r).state.status).toBe('cooled_down');
    r.recordSuccess(SID, PID, KEY, MODEL);
    expect(firstEntry(r).state.status).toBe('healthy');
  });

  it('dead 不因成功恢复', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, PID, KEY, MODEL, 'AUTH_INVALID', 1000);
    r.escalate(SID, PID, KEY, MODEL, 'AUTH_INVALID', 2000); // dead
    r.recordSuccess(SID, PID, KEY, MODEL);
    expect(firstEntry(r).state.status).toBe('dead');
  });
});

describe('ProviderHealthRegistry v2.0 — chain-switch 不累加(spec §5)', () => {
  beforeEach(() => __resetProviderHealthRegistryForTest());

  it('前一项 (p1,k1) 仅失败 1 次(未达阈值),resolveTarget 切到 (p2,k2) 不应让 (p1,k1) 进 cooled_down', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, 'p1', 'k1', MODEL, 'PROVIDER_OVERLOADED', 1000);
    // chain 切换 —— 不对 (p1,k1) 调 escalate(spec §5)
    r.escalate(SID, 'p2', 'k2', MODEL, 'PROVIDER_OVERLOADED', 2000);

    const p1State = r.snapshot(SID).find((e) => e.providerId === 'p1')!.state;
    expect(p1State.status).toBe('healthy');
    expect(
      (p1State as Extract<ProviderHealthState, { status: 'healthy' }>).consecutive.overload,
    ).toBe(1);
    const p2State = r.snapshot(SID).find((e) => e.providerId === 'p2')!.state;
    expect(p2State.status).toBe('healthy');
  });

  it('查询(isAvailable/isPreferred)不累加计数', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate(SID, PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    for (let i = 0; i < 5; i++) {
      r.isAvailable(SID, PID, KEY, MODEL, 1000 + i * 100);
      r.isPreferred(SID, PID, KEY, MODEL, 1000 + i * 100);
    }
    const s = firstEntry(r).state as Extract<ProviderHealthState, { status: 'healthy' }>;
    expect(s.consecutive.overload).toBe(1);
  });
});

describe('ProviderHealthRegistry v2.0 — [rev2 新] 四元组隔离(spec §1/§6.5)', () => {
  beforeEach(() => __resetProviderHealthRegistryForTest());

  it('session 隔离: A session 的 cooldown 不影响 B session', () => {
    const r = createProviderHealthRegistry(CFG);
    // sessionA 触发 (p1, default, m1) cooled_down
    r.escalate('sess-a', PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    r.escalate('sess-a', PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 2000);
    expect(r.isAvailable('sess-a', PID, KEY, MODEL, 2500).ok).toBe(false); // A 不可用
    // sessionB 同四元组仍 healthy(隔离)
    expect(r.isAvailable('sess-b', PID, KEY, MODEL, 2500).ok).toBe(true);
    expect(r.isPreferred('sess-b', PID, KEY, MODEL, 2500).ok).toBe(true);
  });

  it('model 隔离: model m1 的 cooldown 不影响 model m2(同 provider 同 key 同 session)', () => {
    const r = createProviderHealthRegistry(CFG);
    // m1 触发 cooled_down
    r.escalate(SID, PID, KEY, 'm1', 'PROVIDER_OVERLOADED', 1000);
    r.escalate(SID, PID, KEY, 'm1', 'PROVIDER_OVERLOADED', 2000);
    expect(r.isAvailable(SID, PID, KEY, 'm1', 2500).ok).toBe(false);
    // m2 同 provider 同 key 仍 healthy(model 隔离)
    expect(r.isAvailable(SID, PID, KEY, 'm2', 2500).ok).toBe(true);
    expect(r.isPreferred(SID, PID, KEY, 'm2', 2500).ok).toBe(true);
  });

  it('snapshot(sessionId) 只列该 session 的条目,不含别的 session', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate('sess-a', PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    r.escalate('sess-b', 'p2', KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    const snapA = r.snapshot('sess-a');
    const snapB = r.snapshot('sess-b');
    expect(snapA).toHaveLength(1);
    expect(snapA[0]!.sessionId).toBe('sess-a');
    expect(snapB).toHaveLength(1);
    expect(snapB[0]!.sessionId).toBe('sess-b');
    expect(snapB[0]!.providerId).toBe('p2');
  });
});

describe('ProviderHealthRegistry v2.0 — [rev2 新] cleanupSession(spec §6.5)', () => {
  beforeEach(() => __resetProviderHealthRegistryForTest());

  it('cleanupSession 清理对应 session 的所有 entry', () => {
    const r = createProviderHealthRegistry(CFG);
    r.escalate('sess-a', 'p1', KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    r.escalate('sess-a', 'p2', KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    r.escalate('sess-b', 'p1', KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    expect(r.snapshot('sess-a')).toHaveLength(2);
    expect(r.snapshot('sess-b')).toHaveLength(1);

    r.cleanupSession('sess-a');
    expect(r.snapshot('sess-a')).toHaveLength(0); // 已清
    expect(r.snapshot('sess-b')).toHaveLength(1); // B 不受影响
  });

  it('cleanupSession 后,同 session 同四元组重新懒创建为 healthy', () => {
    const r = createProviderHealthRegistry(CFG);
    r.markDead('sess-a', PID, KEY, MODEL, 'auth', 1000);
    expect(r.isAvailable('sess-a', PID, KEY, MODEL, 2000).ok).toBe(false);
    r.cleanupSession('sess-a');
    // 重新查询 → 懒创建 healthy(dead 状态被清)
    expect(r.isAvailable('sess-a', PID, KEY, MODEL, 2000)).toEqual({ ok: true, tier: 'healthy' });
  });

  it('cleanupSession 对未知 sessionId 不抛错(no-op)', () => {
    const r = createProviderHealthRegistry(CFG);
    expect(() => r.cleanupSession('never-existed')).not.toThrow();
  });
});

describe('ProviderHealthRegistry v2.0 — 进程级存储单例(spec §6.5)', () => {
  beforeEach(() => __resetProviderHealthRegistryForTest());

  it('getProviderHealthRegistry 多次调用返回同一实例', () => {
    const a = getProviderHealthRegistry();
    const b = getProviderHealthRegistry();
    expect(a).toBe(b);
  });

  it('跨 caller 共享同一 registry 实例,但状态按 session 分区', () => {
    // 实例共享,但 A session 写入不污染 B session
    const registry = getProviderHealthRegistry(); // 默认 consecutiveToDegrade=3
    // 4 次 escalate 让 sess-a 进 degraded(3 次进 cooled_down,第 4 次升级 degraded)
    registry.escalate('sess-a', PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 1000);
    registry.escalate('sess-a', PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 2000);
    registry.escalate('sess-a', PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 3000); // cooled_down
    registry.escalate('sess-a', PID, KEY, MODEL, 'PROVIDER_OVERLOADED', 4000); // degraded(until=4000+60000)
    // A session 看到 degraded(兜底可用,未到期)
    expect(registry.isAvailable('sess-a', PID, KEY, MODEL, 5000).ok).toBe(true);
    expect(registry.isAvailable('sess-a', PID, KEY, MODEL, 5000).tier).toBe('degraded');
    // B session 同四元组仍 healthy
    expect(registry.isAvailable('sess-b', PID, KEY, MODEL, 5000).tier).toBe('healthy');
  });

  it('__reset 后单例重建(新实例,所有 session 状态清空)', () => {
    const a = getProviderHealthRegistry();
    a.escalate(SID, PID, KEY, MODEL, 'AUTH_INVALID', 1000);
    __resetProviderHealthRegistryForTest();
    const b = getProviderHealthRegistry();
    expect(b).not.toBe(a);
    expect(b.isAvailable(SID, PID, KEY, MODEL, 1000).ok).toBe(true);
  });

  it('默认 config 生效(未传 config 用 DEFAULT_DEGRADATION_CONFIG)', () => {
    const r = getProviderHealthRegistry(); // 默认 consecutiveToDegrade=3
    r.escalate(SID, PID, KEY, MODEL, 'AUTH_INVALID', 1000);
    r.escalate(SID, PID, KEY, MODEL, 'AUTH_INVALID', 2000); // auth=2 < 3
    expect(firstEntry(r).state.status).toBe('healthy');
    r.escalate(SID, PID, KEY, MODEL, 'AUTH_INVALID', 3000); // auth=3 → dead
    expect(firstEntry(r).state.status).toBe('dead');
  });
});

describe('DEFAULT_DEGRADATION_CONFIG', () => {
  it('默认 consecutiveToDegrade=3 / cooldownS=30(spec §1.3 DEFAULT)', () => {
    expect(DEFAULT_DEGRADATION_CONFIG.consecutiveToDegrade).toBe(3);
    expect(DEFAULT_DEGRADATION_CONFIG.cooldownS).toBe(30);
  });
});
