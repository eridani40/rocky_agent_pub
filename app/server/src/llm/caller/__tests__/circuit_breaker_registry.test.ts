/**
 * CircuitBreakerRegistry — 方案级三态熔断注册表 UT
 * 参考: specs/tech/agent/providers_and_models/[P0]model_routing.md §6（D5/D6/D16 三态熔断）
 *       specs/prd/model-routing-PRD-2026-08-14.md §2.7（UC-18/19/20 状态机）
 *
 * 覆盖：
 *   1. 三维键隔离（planId|providerId|modelId）：方案 A 熔断 ≠ 方案 B 熔断；同方案同模型共享
 *   2. Closed → (连续失败 ≥ failureThreshold=4) → Open
 *   3. Closed → (total ≥ minRequests=10 且 errorRate ≥ 0.6) → Open
 *   4. AUTH directOpen → 直达 Open（无阈值）
 *   5. Open → (timeoutSeconds=60 到期) → HalfOpen（惰性 getState/tryAcquirePermit）
 *   6. HalfOpen 限流 1 并发（probing permit；未归还 → 第二个 tryAcquirePermit false）
 *   7. HalfOpen 探测成功 ×2 → Closed（successThreshold=2）
 *   8. HalfOpen 探测失败 → 立即回 Open（无需阈值）
 *   9. recordSuccess 清连续失败（Closed 态）
 *   10. snapshot：状态/计数/remainingSeconds（仅 open 有）
 *
 * 测试方式：createCircuitBreakerRegistry(now) 注入可控时钟（隔离 globalThis 单例）。
 * 单文件 ≤300 行。
 */
import { describe, it, expect } from 'vitest';
import { createCircuitBreakerRegistry } from '../circuit_breaker_registry';

const PLAN = 'plan-1';
const P1 = 'provider-a';
const M1 = 'model-x';
const P2 = 'provider-b';
const M2 = 'model-y';

/** 可控时钟 */
function makeClock(initial = 0): { now: () => number; advance: (ms: number) => void } {
  let t = initial;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('[circuit_breaker_registry] 三态状态机', () => {
  it('初始 Closed；无记录 getState 返 closed（不创建条目）', () => {
    const r = createCircuitBreakerRegistry();
    expect(r.getState(PLAN, P1, M1)).toBe('closed');
    expect(r.snapshot()).toEqual([]);
  });

  it('连续失败 ≥ failureThreshold(4) → Open', () => {
    const r = createCircuitBreakerRegistry();
    for (let i = 0; i < 3; i++) r.recordFailure(PLAN, P1, M1);
    expect(r.getState(PLAN, P1, M1)).toBe('closed');
    r.recordFailure(PLAN, P1, M1);
    expect(r.getState(PLAN, P1, M1)).toBe('open');
  });

  it('total ≥ minRequests(10) 且 errorRate ≥ 0.6 → Open（非连续失败路径）', () => {
    const r = createCircuitBreakerRegistry();
    // 10 次请求 6 次失败（0.6 errorRate）：连续失败 6 次也达 4 阈值——先测 4 次成功 6 次失败
    for (let i = 0; i < 4; i++) r.recordSuccess(PLAN, P1, M1);
    for (let i = 0; i < 6; i++) r.recordFailure(PLAN, P1, M1);
    // 6 次连续失败已 ≥4 → Open（errorRate 路径与连续失败路径在此等价，但 errorRate 分支仍需覆盖）
    expect(r.getState(PLAN, P1, M1)).toBe('open');
    // 纯 errorRate 路径：S F F S F F S F F F → total=10, failures=7, rate=0.7 ≥ 0.6，
    // 连续失败最多 3 次（< 4，不触发连续失败阈值）→ 仅 errorRate 分支触发 Open
    const r2 = createCircuitBreakerRegistry();
    const seq: Array<'S' | 'F'> = ['S', 'F', 'F', 'S', 'F', 'F', 'S', 'F', 'F', 'F'];
    for (const op of seq) {
      if (op === 'S') r2.recordSuccess(PLAN, P2, M2);
      else r2.recordFailure(PLAN, P2, M2);
    }
    expect(r2.getState(PLAN, P2, M2)).toBe('open');
  });

  it('AUTH directOpen → 直达 Open（无阈值）', () => {
    const r = createCircuitBreakerRegistry();
    r.recordFailure(PLAN, P1, M1, undefined, true);
    expect(r.getState(PLAN, P1, M1)).toBe('open');
  });

  it('recordSuccess 清连续失败（Closed 态不 Open）', () => {
    const r = createCircuitBreakerRegistry();
    r.recordFailure(PLAN, P1, M1);
    r.recordFailure(PLAN, P1, M1);
    r.recordFailure(PLAN, P1, M1);
    r.recordSuccess(PLAN, P1, M1); // 清连续失败
    r.recordFailure(PLAN, P1, M1);
    expect(r.getState(PLAN, P1, M1)).toBe('closed'); // 连续失败回到 1
  });

  it('Open → timeoutSeconds(60) 到期 → HalfOpen（getState 惰性转换）', () => {
    const clock = makeClock(1000);
    const r = createCircuitBreakerRegistry(clock.now);
    for (let i = 0; i < 4; i++) r.recordFailure(PLAN, P1, M1);
    expect(r.getState(PLAN, P1, M1)).toBe('open');
    // 未到期仍 open
    clock.advance(59_000);
    expect(r.getState(PLAN, P1, M1)).toBe('open');
    // 到期 → half_open
    clock.advance(1_000);
    expect(r.getState(PLAN, P1, M1)).toBe('half_open');
  });

  it('HalfOpen 限流 1 并发：tryAcquirePermit 成功 → probing；未归还第二个 false；归还后可再放行', () => {
    const clock = makeClock(0);
    const r = createCircuitBreakerRegistry(clock.now);
    for (let i = 0; i < 4; i++) r.recordFailure(PLAN, P1, M1);
    clock.advance(60_000); // 到期 → half_open
    expect(r.tryAcquirePermit(PLAN, P1, M1)).toBe(true); // 探测 1 放行
    expect(r.tryAcquirePermit(PLAN, P1, M1)).toBe(false); // 限流（探测在途）
    r.releasePermit(PLAN, P1, M1); // 归还
    expect(r.tryAcquirePermit(PLAN, P1, M1)).toBe(true); // 可再放行
  });

  it('HalfOpen 探测成功 ×2 → Closed（successThreshold=2）', () => {
    const clock = makeClock(0);
    const r = createCircuitBreakerRegistry(clock.now);
    for (let i = 0; i < 4; i++) r.recordFailure(PLAN, P1, M1);
    clock.advance(60_000);
    expect(r.tryAcquirePermit(PLAN, P1, M1)).toBe(true);
    r.recordSuccess(PLAN, P1, M1);
    r.releasePermit(PLAN, P1, M1);
    expect(r.getState(PLAN, P1, M1)).toBe('half_open'); // 1/2 成功仍 half_open
    expect(r.tryAcquirePermit(PLAN, P1, M1)).toBe(true);
    r.recordSuccess(PLAN, P1, M1);
    r.releasePermit(PLAN, P1, M1);
    expect(r.getState(PLAN, P1, M1)).toBe('closed'); // 2/2 → Closed
  });

  it('HalfOpen 探测失败 → 立即回 Open（无需阈值）', () => {
    const clock = makeClock(0);
    const r = createCircuitBreakerRegistry(clock.now);
    for (let i = 0; i < 4; i++) r.recordFailure(PLAN, P1, M1);
    clock.advance(60_000);
    expect(r.tryAcquirePermit(PLAN, P1, M1)).toBe(true);
    r.recordFailure(PLAN, P1, M1); // 探测失败
    r.releasePermit(PLAN, P1, M1);
    expect(r.getState(PLAN, P1, M1)).toBe('open');
  });

  it('三维键隔离：方案 A 熔断 ≠ 方案 B 熔断；同方案同模型共享', () => {
    const r = createCircuitBreakerRegistry();
    for (let i = 0; i < 4; i++) r.recordFailure('plan-A', P1, M1);
    expect(r.getState('plan-A', P1, M1)).toBe('open');
    expect(r.getState('plan-B', P1, M1)).toBe('closed'); // 同模型不同方案不熔断
    expect(r.getState('plan-A', P2, M1)).toBe('closed'); // 同方案不同 provider 不熔断
    // 同方案同模型（多 item 同模型）共享：同键计数继续
    for (let i = 0; i < 4; i++) r.recordFailure('plan-A', P1, M1);
    // 已 open 仍 open（recordFailure 不再改变）
    expect(r.getState('plan-A', P1, M1)).toBe('open');
  });

  it('方案级 circuit 覆盖：failureThreshold=2 时 2 次失败即 Open', () => {
    const r = createCircuitBreakerRegistry();
    const cfg = { failureThreshold: 2 };
    r.recordFailure(PLAN, P1, M1, cfg);
    expect(r.getState(PLAN, P1, M1, cfg)).toBe('closed');
    r.recordFailure(PLAN, P1, M1, cfg);
    expect(r.getState(PLAN, P1, M1, cfg)).toBe('open');
  });

  it('snapshot：状态/计数/errorRate；仅 open 带 remainingSeconds；到期转换后 half_open', () => {
    const clock = makeClock(0);
    const r = createCircuitBreakerRegistry(clock.now);
    for (let i = 0; i < 4; i++) r.recordFailure(PLAN, P1, M1);
    clock.advance(10_000); // 未到期
    let snap = r.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({
      planId: PLAN, providerId: P1, modelId: M1,
      state: 'open', failureCount: 4, totalRequests: 4, errorRate: 1,
    });
    expect(snap[0]!.remainingSeconds).toBe(50); // 60-10=50
    clock.advance(50_000); // 到期
    snap = r.snapshot();
    expect(snap[0]!.state).toBe('half_open');
    expect(snap[0]!.remainingSeconds).toBeUndefined();
  });
});

describe('[v0.0.347 T5] 错误率滑动窗口', () => {
  it('① 滑窗滚动：低连续失败序列（S FF 周期连续失败恒 <4）窗口率达标触发 Open；第 21 次后最旧滚出（errorRate 窗口口径 ≠ 终身口径）', () => {
    // cfg：minRequests=20 + windowSize=20（窗口满才判）；序列开头 F（最旧是失败，滚出可观察）
    // 前 20 样本 = F S F F S F F S F F S F F S F F S F F S → 13 失败 7 成功（连续失败 max 2 < 4）
    const r = createCircuitBreakerRegistry();
    const cfg = { minRequests: 20, windowSize: 20 };
    const seq20: Array<'S' | 'F'> = ['F','S','F','F','S','F','F','S','F','F','S','F','F','S','F','F','S','F','F','S'];
    for (const op of seq20) {
      if (op === 'S') r.recordSuccess(PLAN, P1, M1, cfg);
      else r.recordFailure(PLAN, P1, M1, cfg);
    }
    // 20 样本时最后一个是 S（recordSuccess 不判 Open）；windowCount=20 但无失败判点 → 仍 closed
    expect(r.getState(PLAN, P1, M1, cfg)).toBe('closed');
    // 第 21 个 = F：最旧 F 滚出（failures 13 不变）+ 推入 F → windowCount=20, rate=13/20=0.65 ≥ 0.6 → Open
    r.recordFailure(PLAN, P1, M1, cfg);
    expect(r.getState(PLAN, P1, M1, cfg)).toBe('open');
    // 窗口口径 errorRate = 13/20 = 0.65（终身口径 14/21 ≈ 0.667——两口径不同 = 最旧已滚出）
    const snap = r.snapshot().find((e) => e.planId === PLAN && e.providerId === P1 && e.modelId === M1)!;
    expect(snap.errorRate).toBeCloseTo(13 / 20, 10);
    expect(snap.failureCount).toBe(14); // 终身计数保留
    expect(snap.totalRequests).toBe(21);
    // 再推 2 个 S：滚出第 2 个 S（成功）+ 第 3 个 F（失败）→ failures 13-1=12 → errorRate 0.6（下降）
    r.recordSuccess(PLAN, P1, M1, cfg);
    r.recordSuccess(PLAN, P1, M1, cfg);
    const snap2 = r.snapshot().find((e) => e.planId === PLAN && e.providerId === P1 && e.modelId === M1)!;
    expect(snap2.errorRate).toBeCloseTo(12 / 20, 10);
  });

  it('② 窗口未满（样本 < minRequests）错误率轨道沉默 + 连续失败轨道兜底', () => {
    const r = createCircuitBreakerRegistry();
    // S FF 周期 ×3 = 9 样本：6 失败 rate 0.667 ≥ 0.6，但 windowCount=9 < minRequests=10 → 不 Open
    for (let i = 0; i < 3; i++) {
      r.recordSuccess(PLAN, P1, M1);
      r.recordFailure(PLAN, P1, M1);
      r.recordFailure(PLAN, P1, M1);
    }
    expect(r.getState(PLAN, P1, M1)).toBe('closed'); // 窗口未满沉默（连续失败 2 < 4）
    // 第 10 个样本 = F：windowCount=10 ≥ 10, rate=7/10=0.7 ≥ 0.6 → Open（第 minRequests 个样本到齐才触发）
    r.recordFailure(PLAN, P1, M1);
    expect(r.getState(PLAN, P1, M1)).toBe('open');
    // 兜底验证：窗口未满 + 高失败率下连续失败 4 连仍 Open（独立 key）
    const r2 = createCircuitBreakerRegistry();
    for (let i = 0; i < 4; i++) r2.recordFailure(PLAN, P2, M2);
    expect(r2.getState(PLAN, P2, M2)).toBe('open'); // 连续失败轨道兜底（窗口仅 4 样本 < 10）
  });

  it('③ 恢复不清窗：Open→60s→HalfOpen 探测成功 ×2 回 Closed 后窗口仍含旧失败，后续成功推入滚出旧失败 errorRate 下降', () => {
    const clock = makeClock(0);
    const r = createCircuitBreakerRegistry(clock.now);
    // 4 连 F → Open（连续失败轨道）
    for (let i = 0; i < 4; i++) r.recordFailure(PLAN, P1, M1);
    expect(r.getState(PLAN, P1, M1)).toBe('open');
    // 60s 到期 → HalfOpen 探测成功 ×2 → Closed
    clock.advance(60_000);
    expect(r.tryAcquirePermit(PLAN, P1, M1)).toBe(true);
    r.recordSuccess(PLAN, P1, M1);
    r.releasePermit(PLAN, P1, M1);
    expect(r.tryAcquirePermit(PLAN, P1, M1)).toBe(true);
    r.recordSuccess(PLAN, P1, M1);
    r.releasePermit(PLAN, P1, M1);
    expect(r.getState(PLAN, P1, M1)).toBe('closed');
    // 回 Closed 后窗口不清：4 旧失败 + 2 探测成功 = 6 样本，errorRate = 4/6（旧失败仍在窗口，决策㉒）
    let snap = r.snapshot().find((e) => e.planId === PLAN && e.providerId === P1 && e.modelId === M1)!;
    expect(snap.errorRate).toBeCloseTo(4 / 6, 10);
    expect(snap.failureCount).toBe(4); // 终身计数保留
    // 推 6 个 S：windowCount 6→12，failures 仍 4（旧失败未滚出前）→ errorRate 4/12 ≈ 0.333 下降
    for (let i = 0; i < 6; i++) r.recordSuccess(PLAN, P1, M1);
    snap = r.snapshot().find((e) => e.planId === PLAN && e.providerId === P1 && e.modelId === M1)!;
    expect(snap.errorRate).toBeCloseTo(4 / 12, 10);
    expect(snap.totalRequests).toBe(12); // 4 失败 + 2 探测成功 + 6 成功 = 12
    // 推 8 个 S：窗口刚好填满 20 样本（4F 16S），旧失败尚未滚出 → rate = 4/20 = 0.2
    for (let i = 0; i < 8; i++) r.recordSuccess(PLAN, P1, M1);
    snap = r.snapshot().find((e) => e.planId === PLAN && e.providerId === P1 && e.modelId === M1)!;
    expect(snap.errorRate).toBeCloseTo(4 / 20, 10);
    // 再推 4 个 S：覆盖最旧 4 个 F（滚出）→ failures 4→0 → errorRate = 0（旧失败随成功自然滚出）
    for (let i = 0; i < 4; i++) r.recordSuccess(PLAN, P1, M1);
    snap = r.snapshot().find((e) => e.planId === PLAN && e.providerId === P1 && e.modelId === M1)!;
    expect(snap.errorRate).toBe(0);
    expect(snap.failureCount).toBe(4); // 终身计数仍保留
    expect(snap.totalRequests).toBe(24);
  });

  it('窗口生命周期：方案编辑改生效 windowSize → 窗口重建（清空重积累，终身计数保留）', () => {
    const r = createCircuitBreakerRegistry();
    const cfgA = { windowSize: 5 };
    for (let i = 0; i < 3; i++) r.recordFailure(PLAN, P1, M1, cfgA); // 3 失败入 5 槽窗（未满 3/3 rate 1.0；连续失败 3 < 4 不触发）
    expect(r.getState(PLAN, P1, M1, cfgA)).toBe('closed'); // windowCount=3 < minRequests=10 → 窗口轨道沉默
    // 编辑：windowSize 5→20（同一 entry 传新 cfg）→ 窗口重建清空
    const cfgB = { windowSize: 20 };
    let snap = r.snapshot().find((e) => e.planId === PLAN && e.providerId === P1 && e.modelId === M1)!;
    expect(snap.errorRate).toBe(1.0); // 重建前窗口口径（3/3）
    r.recordSuccess(PLAN, P1, M1, cfgB); // 触发 entry() 同步 cfg → 重建；窗口 1 成功样本
    snap = r.snapshot().find((e) => e.planId === PLAN && e.providerId === P1 && e.modelId === M1)!;
    expect(snap.errorRate).toBe(0); // 重建后窗口只有 1 个成功样本（0/1）
    expect(snap.failureCount).toBe(3); // 终身计数保留
    expect(snap.totalRequests).toBe(4);
  });
});
