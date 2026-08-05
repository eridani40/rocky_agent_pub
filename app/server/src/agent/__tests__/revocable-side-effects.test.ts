/**
 * revocable-side-effects UT（v0.0.207 T2）
 * 参考: specs/tech/version_logs/v0.0.207/change_plan.md §T2
 *
 * 覆盖（test-plan T2）：
 *   - wrapRevocableEmitCtx：revoke 前/后 ctx.bus.emit/clearReplay 行为；其他属性透传
 *   - wrapRevocableContextEngine：revoke 前/后 ce.ingest 行为；其他方法透传
 *   - 原对象引用不变（abort api 直发 bus 不受影响）
 *   - 组合 revoke：两层同时吊销
 */
import { describe, it, expect, vi } from 'vitest';
import { wrapRevocableEmitCtx, wrapRevocableContextEngine } from '../revocable-side-effects';
import type { EmitContext } from '../agent-loop-emitters';
import type { ReplayableEventBus } from '../event-bus';
import type { ContextEngine } from '../context-engine';

/** 造假 bus：所有方法 spy，便于断言调用 */
function makeFakeBus(): ReplayableEventBus & {
  emitMock: ReturnType<typeof vi.fn>;
  clearReplayMock: ReturnType<typeof vi.fn>;
  subscribeMock: ReturnType<typeof vi.fn>;
  isReplayableMock: ReturnType<typeof vi.fn>;
} {
  const emitMock = vi.fn();
  const clearReplayMock = vi.fn();
  const subscribeMock = vi.fn(() => () => { /* unsubs */ });
  const isReplayableMock = vi.fn(() => true);
  return {
    emit: emitMock,
    clearReplay: clearReplayMock,
    subscribe: subscribeMock,
    isReplayable: isReplayableMock,
    emitMock, clearReplayMock, subscribeMock, isReplayableMock,
  } as unknown as ReplayableEventBus & {
    emitMock: ReturnType<typeof vi.fn>;
    clearReplayMock: ReturnType<typeof vi.fn>;
    subscribeMock: ReturnType<typeof vi.fn>;
    isReplayableMock: ReturnType<typeof vi.fn>;
  };
}

function makeFakeEmitCtx(bus: ReplayableEventBus): EmitContext {
  return {
    sessionId: 's1',
    runId: 'r1',
    runKind: 'main',
    bus,
    now: () => '2026-07-27T00:00:00.000Z',
  };
}

/** 造假 ContextEngine：所有方法 spy */
function makeFakeCe(): ContextEngine & {
  ingestMock: ReturnType<typeof vi.fn>;
  assembleMock: ReturnType<typeof vi.fn>;
  getCleanSnapshotMock: ReturnType<typeof vi.fn>;
  compactMock: ReturnType<typeof vi.fn>;
  clearScopeSessionMock: ReturnType<typeof vi.fn>;
  getSideRunnerMock: ReturnType<typeof vi.fn>;
} {
  const ingestMock = vi.fn(() => Promise.resolve());
  const assembleMock = vi.fn(async () => ({ messages: [], systemPrompt: '', usage: { totalTokens: 0 } }));
  const getCleanSnapshotMock = vi.fn(async () => ({ messages: [], systemPrompt: '', usage: { totalTokens: 0 } }));
  const compactMock = vi.fn(async () => true);
  const clearScopeSessionMock = vi.fn(async () => { /* noop */ });
  const getSideRunnerMock = vi.fn(() => null);
  return {
    ingest: ingestMock,
    assemble: assembleMock,
    getCleanSnapshot: getCleanSnapshotMock,
    compact: compactMock,
    clearScopeSession: clearScopeSessionMock,
    getSideRunner: getSideRunnerMock,
    ingestMock, assembleMock, getCleanSnapshotMock, compactMock, clearScopeSessionMock, getSideRunnerMock,
  } as unknown as ContextEngine & {
    ingestMock: ReturnType<typeof vi.fn>;
    assembleMock: ReturnType<typeof vi.fn>;
    getCleanSnapshotMock: ReturnType<typeof vi.fn>;
    compactMock: ReturnType<typeof vi.fn>;
    clearScopeSessionMock: ReturnType<typeof vi.fn>;
    getSideRunnerMock: ReturnType<typeof vi.fn>;
  };
}

// ============================================================
// wrapRevocableEmitCtx
// ============================================================

describe('[v0.0.207 T2] wrapRevocableEmitCtx', () => {
  it('revoke 前：ctx.bus.emit/clearReplay 正常转发到原 bus', () => {
    const bus = makeFakeBus();
    const ctx = makeFakeEmitCtx(bus);
    const { ctx: wrappedCtx } = wrapRevocableEmitCtx(ctx);

    wrappedCtx.bus.emit('grp', { data: { type: 'x' }, timestamp: 't' });
    wrappedCtx.bus.clearReplay('grp');

    expect(bus.emitMock).toHaveBeenCalledTimes(1);
    expect(bus.emitMock).toHaveBeenCalledWith('grp', { data: { type: 'x' }, timestamp: 't' });
    expect(bus.clearReplayMock).toHaveBeenCalledTimes(1);
    expect(bus.clearReplayMock).toHaveBeenCalledWith('grp');
  });

  it('revoke 后：ctx.bus.emit/clearReplay 变 no-op（不触原 bus）', () => {
    const bus = makeFakeBus();
    const ctx = makeFakeEmitCtx(bus);
    const { ctx: wrappedCtx, revoke } = wrapRevocableEmitCtx(ctx);

    revoke.revoke();
    wrappedCtx.bus.emit('grp', { data: { type: 'x' }, timestamp: 't' });
    wrappedCtx.bus.clearReplay('grp');

    expect(bus.emitMock).not.toHaveBeenCalled();
    expect(bus.clearReplayMock).not.toHaveBeenCalled();
  });

  it('revoke 后：subscribe/isReplayable 透传（read 方法豁免）', () => {
    const bus = makeFakeBus();
    const ctx = makeFakeEmitCtx(bus);
    const { ctx: wrappedCtx, revoke } = wrapRevocableEmitCtx(ctx);

    revoke.revoke();
    wrappedCtx.bus.subscribe('grp');
    const r = wrappedCtx.bus.isReplayable();

    expect(bus.subscribeMock).toHaveBeenCalledTimes(1);
    expect(bus.isReplayableMock).toHaveBeenCalledTimes(1);
    expect(r).toBe(true);
  });

  it('ctx 其他字段（sessionId/runId/runKind/now）透传不变', () => {
    const bus = makeFakeBus();
    const ctx = makeFakeEmitCtx(bus);
    const { ctx: wrappedCtx } = wrapRevocableEmitCtx(ctx);

    expect(wrappedCtx.sessionId).toBe('s1');
    expect(wrappedCtx.runId).toBe('r1');
    expect(wrappedCtx.runKind).toBe('main');
    expect(wrappedCtx.now()).toBe('2026-07-27T00:00:00.000Z');
  });

  it('原 bus 引用不变（abort api 直发 bus.emit 仍生效）', () => {
    const bus = makeFakeBus();
    const ctx = makeFakeEmitCtx(bus);
    const { revoke } = wrapRevocableEmitCtx(ctx);

    revoke.revoke();
    // abort api 直发原 bus（不经 wrappedCtx）
    bus.emit('grp', { data: { type: 'run_end' }, timestamp: 't' });
    expect(bus.emitMock).toHaveBeenCalledTimes(1);
  });

  it('revoke 幂等：多次调不抛错', () => {
    const bus = makeFakeBus();
    const ctx = makeFakeEmitCtx(bus);
    const { revoke } = wrapRevocableEmitCtx(ctx);

    expect(() => {
      revoke.revoke();
      revoke.revoke();
      revoke.revoke();
    }).not.toThrow();
  });
});

// ============================================================
// wrapRevocableContextEngine
// ============================================================

describe('[v0.0.207 T2] wrapRevocableContextEngine', () => {
  it('revoke 前：ce.ingest 正常转发到原 ce', async () => {
    const ce = makeFakeCe();
    const { ce: wrappedCe } = wrapRevocableContextEngine(ce);

    await wrappedCe.ingest({ sessionId: 's1' } as never, [], 'default', false, { runId: 'r1' });

    expect(ce.ingestMock).toHaveBeenCalledTimes(1);
  });

  it('revoke 后：ce.ingest 返 Promise.resolve()（async no-op，不触原 ce）', async () => {
    const ce = makeFakeCe();
    const { ce: wrappedCe, revoke } = wrapRevocableContextEngine(ce);

    revoke.revoke();
    const ret = await wrappedCe.ingest({ sessionId: 's1' } as never, [], 'default', false, { runId: 'r1' });

    expect(ret).toBeUndefined();
    expect(ce.ingestMock).not.toHaveBeenCalled();
  });

  it('revoke 后：assemble/getCleanSnapshot/compact/clearScopeSession/getSideRunner 透传（不拦截）', async () => {
    const ce = makeFakeCe();
    const { ce: wrappedCe, revoke } = wrapRevocableContextEngine(ce);

    revoke.revoke();
    await wrappedCe.assemble({ sessionId: 's1' } as never);
    await wrappedCe.getCleanSnapshot({ sessionId: 's1' } as never);
    await wrappedCe.compact({ sessionId: 's1' } as never);
    await wrappedCe.clearScopeSession('forked', 's1', { runId: 'r1' });
    wrappedCe.getSideRunner();

    expect(ce.assembleMock).toHaveBeenCalledTimes(1);
    expect(ce.getCleanSnapshotMock).toHaveBeenCalledTimes(1);
    expect(ce.compactMock).toHaveBeenCalledTimes(1);
    expect(ce.clearScopeSessionMock).toHaveBeenCalledTimes(1);
    expect(ce.getSideRunnerMock).toHaveBeenCalledTimes(1);
  });

  it('原 ce 引用不变（abort api 直 store.appendMessages 不经 ce.ingest）', async () => {
    const ce = makeFakeCe();
    const { revoke } = wrapRevocableContextEngine(ce);

    revoke.revoke();
    // 原 ce.ingest 仍能调（abort api 不经 ce.ingest 走 store.appendMessages，但本测试验原 ce 未被 mutate）
    await ce.ingest({ sessionId: 's1' } as never, [], 'default', false, { runId: 'r1' });
    expect(ce.ingestMock).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// 组合 revoke：buildRunDeps 装配场景（两层同时吊销）
// ============================================================

describe('[v0.0.207 T2] 组合 revoke（buildRunDeps 场景）', () => {
  it('组合 revoke：emit + ce 两层同时吊销', async () => {
    const bus = makeFakeBus();
    const ce = makeFakeCe();
    const ctx = makeFakeEmitCtx(bus);
    const emitWrap = wrapRevocableEmitCtx(ctx);
    const ceWrap = wrapRevocableContextEngine(ce);

    // revoke 前：两层都通
    emitWrap.ctx.bus.emit('g', { data: {}, timestamp: 't' });
    await ceWrap.ce.ingest({ sessionId: 's1' } as never, [], 'default', false, {});
    expect(bus.emitMock).toHaveBeenCalledTimes(1);
    expect(ce.ingestMock).toHaveBeenCalledTimes(1);

    // 组合 revoke
    const combinedRevoke = (): void => {
      emitWrap.revoke.revoke();
      ceWrap.revoke.revoke();
    };
    combinedRevoke();

    // revoke 后：两层都 no-op
    emitWrap.ctx.bus.emit('g', { data: {}, timestamp: 't' });
    await ceWrap.ce.ingest({ sessionId: 's1' } as never, [], 'default', false, {});
    expect(bus.emitMock).toHaveBeenCalledTimes(1); // 仍是 1（未新增）
    expect(ce.ingestMock).toHaveBeenCalledTimes(1); // 仍是 1（未新增）
  });
});
