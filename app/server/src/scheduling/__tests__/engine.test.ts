/**
 * engine UT — SchedulerEngine 单例 + isDue 双分支 + fire-and-forget + 生命周期。
 * 参考: specs/tech/scheduling/[P0]engine.md §2-§5（权威契约）
 *       task.json T1 acceptanceCriteria §3
 *
 * 覆盖：isDue interval/cron 双分支 + engine start/stop/register/unregister +
 * tick fire-and-forget（多 due 并发 / enabled skip / type handler missing skip /
 * handler reject 不阻塞同 tick 其他 job / 单一时间源 now() 每 tick 一次）。
 * now + setInterval/clearInterval 全注入（确定性，无真实 timer）。
 */
import { describe, it, expect, vi } from 'vitest';
import { SchedulerEngine, isDue } from '../engine';
import { JobHandlerRegistry } from '../registry';
import type { Job, JobHandler } from '../types';

// ============================================================
// helpers
// ============================================================

/** 构造 interval Job（heartbeat-like；owner/payload 占位，engine 不解释）。 */
function makeIntervalJob(opts: {
  id?: string;
  ms: number;
  lastFiredAt?: string | null;
  activeWindow?: { start: string; end: string };
  tz?: string;
  enabled?: boolean;
  createdAt?: string;
}): Job {
  return {
    id: opts.id ?? 'test:job1',
    type: 'test-interval',
    schedule: {
      kind: 'interval',
      ms: opts.ms,
      activeWindow: opts.activeWindow,
      tz: opts.tz ?? 'UTC',
    },
    payload: {},
    lastFiredAt: opts.lastFiredAt ?? null,
    enabled: opts.enabled ?? true,
    createdAt: opts.createdAt ?? '2026-01-01T00:00:00.000Z',
    owner: 'test-owner',
  };
}

/** 构造 cron Job（cron-like；engine 不解释 payload）。 */
function makeCronJob(opts: {
  id?: string;
  expr: string;
  tz?: string;
  lastFiredAt?: string | null;
  enabled?: boolean;
  createdAt?: string;
}): Job {
  return {
    id: opts.id ?? 'test:cron1',
    type: 'test-cron',
    schedule: {
      kind: 'cron',
      expr: opts.expr,
      tz: opts.tz ?? 'UTC',
    },
    payload: {},
    lastFiredAt: opts.lastFiredAt ?? null,
    enabled: opts.enabled ?? true,
    createdAt: opts.createdAt ?? '2026-01-01T00:00:00.000Z',
    owner: 'test-owner',
  };
}

/** mock JobHandler：记录 fire 调用，可选 reject。 */
function makeMockHandler(opts: {
  reject?: boolean;
}): { handler: JobHandler; fireSpy: ReturnType<typeof vi.fn> } {
  const fireSpy = vi.fn();
  const handler: JobHandler = {
    fire: (job, now) => {
      fireSpy(job, now);
      if (opts.reject) return Promise.reject(new Error('mock handler reject'));
      return Promise.resolve();
    },
  };
  return { handler, fireSpy };
}

/** mock setInterval/clearInterval（不真起 timer；tick 通过返回 handle 控制）。 */
function mockTimers(): {
  setInterval: (fn: () => void, ms?: number) => NodeJS.Timeout;
  clearInterval: (h: NodeJS.Timeout) => void;
  tick: () => void;
} {
  let tickFn: (() => void) | null = null;
  const setInterval = vi.fn((fn: () => void) => {
    tickFn = fn;
    return 'mock-handle' as unknown as NodeJS.Timeout;
  });
  const clearInterval = vi.fn(() => {
    tickFn = null;
  });
  return {
    setInterval,
    clearInterval,
    tick: () => {
      if (tickFn) tickFn();
    },
  };
}

// ============================================================
// isDue — interval 分支
// ============================================================

describe('isDue — interval 分支', () => {
  it('lastFiredAt=null + 无 activeWindow → true（首 tick 即触发，预留场景）', () => {
    const job = makeIntervalJob({ ms: 60_000 });
    expect(isDue(job, new Date('2026-03-15T12:00:00Z'))).toBe(true);
  });

  it('lastFiredAt=null + activeWindow 内 → true', () => {
    const job = makeIntervalJob({
      ms: 60_000,
      activeWindow: { start: '09:00', end: '17:00' },
    });
    expect(isDue(job, new Date('2026-03-15T12:00:00Z'))).toBe(true);
  });

  it('lastFiredAt=null + activeWindow 外 → false（不污染 history）', () => {
    const job = makeIntervalJob({
      ms: 60_000,
      activeWindow: { start: '09:00', end: '17:00' },
    });
    expect(isDue(job, new Date('2026-03-15T08:00:00Z'))).toBe(false);
  });

  it('lastFiredAt=null + activeWindow 跨午夜（22:00-06:00）夜班窗口内 → true', () => {
    const job = makeIntervalJob({
      ms: 60_000,
      activeWindow: { start: '22:00', end: '06:00' },
    });
    // 23:00 UTC 在 22:00-06:00 内
    expect(isDue(job, new Date('2026-03-15T23:00:00Z'))).toBe(true);
  });

  it('lastFiredAt=null + activeWindow 跨午夜（22:00-06:00）日间 → false', () => {
    const job = makeIntervalJob({
      ms: 60_000,
      activeWindow: { start: '22:00', end: '06:00' },
    });
    expect(isDue(job, new Date('2026-03-15T12:00:00Z'))).toBe(false);
  });

  it('lastFiredAt!=null + now >= last + ms → true', () => {
    const job = makeIntervalJob({
      ms: 60_000,
      lastFiredAt: '2026-03-15T12:00:00.000Z',
    });
    expect(isDue(job, new Date('2026-03-15T12:01:00.000Z'))).toBe(true);
  });

  it('lastFiredAt!=null + now < last + ms → false', () => {
    const job = makeIntervalJob({
      ms: 60_000,
      lastFiredAt: '2026-03-15T12:00:00.000Z',
    });
    expect(isDue(job, new Date('2026-03-15T12:00:30.000Z'))).toBe(false);
  });

  it('lastFiredAt 非法 ISO → false（防 parse NaN）', () => {
    const job = makeIntervalJob({
      ms: 60_000,
      lastFiredAt: 'not-an-iso',
    });
    expect(isDue(job, new Date('2026-03-15T12:00:00Z'))).toBe(false);
  });
});

// ============================================================
// isDue — cron 分支
// ============================================================

describe('isDue — cron 分支', () => {
  it('lastFiredAt=null → 锚 createdAt；next <= now → true', () => {
    // cron "0 9 * * *"：每天 09:00 UTC
    // createdAt = 2026-03-15T00:00 → next = 2026-03-15T09:00；now=10:00 → due
    const job = makeCronJob({
      expr: '0 9 * * *',
      createdAt: '2026-03-15T00:00:00.000Z',
      lastFiredAt: null,
    });
    expect(isDue(job, new Date('2026-03-15T10:00:00.000Z'))).toBe(true);
  });

  it('lastFiredAt=null → 锚 createdAt；next > now → false', () => {
    const job = makeCronJob({
      expr: '0 9 * * *',
      createdAt: '2026-03-15T00:00:00.000Z',
      lastFiredAt: null,
    });
    // next 09:00 > now 08:00 → false
    expect(isDue(job, new Date('2026-03-15T08:00:00.000Z'))).toBe(false);
  });

  it('lastFiredAt!=null → 锚 lastFiredAt（不锚 createdAt）；next <= now → true', () => {
    // lastFiredAt 推进到 09:00 后，next 是次日 09:00；now = 次日 10:00 → due
    const job = makeCronJob({
      expr: '0 9 * * *',
      createdAt: '2026-03-15T00:00:00.000Z',
      lastFiredAt: '2026-03-15T09:00:00.000Z',
    });
    expect(isDue(job, new Date('2026-03-16T10:00:00.000Z'))).toBe(true);
  });

  it('lastFiredAt!=null → 锚 lastFiredAt；next > now → false', () => {
    const job = makeCronJob({
      expr: '0 9 * * *',
      createdAt: '2026-03-15T00:00:00.000Z',
      lastFiredAt: '2026-03-15T09:00:00.000Z',
    });
    // next 是次日 09:00；now = 当日 23:00 → false
    expect(isDue(job, new Date('2026-03-15T23:00:00.000Z'))).toBe(false);
  });

  it('per-job tz：同 expr 不同 tz 改变 due 判定（Asia/Shanghai 09:00 = UTC 01:00）', () => {
    // tz=Asia/Shanghai，cron "0 9 * * *"：上海 09:00 = UTC 01:00
    // createdAt = 00:00 UTC → 上海 08:00 → next 上海 09:00 = UTC 01:00
    // now = UTC 01:30 → due
    const job = makeCronJob({
      expr: '0 9 * * *',
      tz: 'Asia/Shanghai',
      createdAt: '2026-03-15T00:00:00.000Z',
      lastFiredAt: null,
    });
    expect(isDue(job, new Date('2026-03-15T01:30:00.000Z'))).toBe(true);
  });

  it('非法 cron expr → false（computeNextCronRunMs 返 null）', () => {
    const job = makeCronJob({
      expr: 'not a cron',
      createdAt: '2026-03-15T00:00:00.000Z',
    });
    expect(isDue(job, new Date('2026-03-15T10:00:00.000Z'))).toBe(false);
  });
});

// ============================================================
// SchedulerEngine 生命周期
// ============================================================

describe('SchedulerEngine — 生命周期', () => {
  it('start → running；start 幂等（不重复建 interval）', () => {
    const timers = mockTimers();
    const engine = new SchedulerEngine({
      registry: new JobHandlerRegistry(),
      setInterval: timers.setInterval as unknown as typeof setInterval,
      clearInterval: timers.clearInterval as unknown as typeof clearInterval,
    });
    expect(engine.getRunState()).toBe('stopped');
    engine.start();
    expect(engine.getRunState()).toBe('running');
    expect(timers.setInterval).toHaveBeenCalledTimes(1);
    engine.start(); // 幂等
    expect(timers.setInterval).toHaveBeenCalledTimes(1);
    engine.stop();
  });

  it('stop → stopped；stop 幂等', () => {
    const timers = mockTimers();
    const engine = new SchedulerEngine({
      registry: new JobHandlerRegistry(),
      setInterval: timers.setInterval as unknown as typeof setInterval,
      clearInterval: timers.clearInterval as unknown as typeof clearInterval,
    });
    engine.stop(); // 已 stopped，幂等 no-op
    expect(engine.getRunState()).toBe('stopped');
    expect(timers.clearInterval).not.toHaveBeenCalled();
    engine.start();
    engine.stop();
    expect(engine.getRunState()).toBe('stopped');
    expect(timers.clearInterval).toHaveBeenCalledTimes(1);
    engine.stop(); // 幂等
    expect(timers.clearInterval).toHaveBeenCalledTimes(1);
  });

  it('register/unregister/has/getJob/snapshot', () => {
    const engine = new SchedulerEngine({ registry: new JobHandlerRegistry() });
    const job = makeIntervalJob({ id: 'j1', ms: 60_000 });
    engine.register(job);
    expect(engine.has('j1')).toBe(true);
    expect(engine.has('nonexistent')).toBe(false);
    expect(engine.getJob('j1')).toBe(job);
    // snapshot 是只读 Map
    expect(engine.snapshot().size).toBe(1);
    expect(engine.snapshot().get('j1')).toBe(job);
    engine.unregister('j1');
    expect(engine.has('j1')).toBe(false);
    expect(engine.getJob('j1')).toBeUndefined();
    // unregister 不存在静默 no-op
    engine.unregister('nonexistent');
  });

  it('register 同 id 替换（reload 场景）', () => {
    const engine = new SchedulerEngine({ registry: new JobHandlerRegistry() });
    const job1 = makeIntervalJob({ id: 'j1', ms: 60_000 });
    const job2 = makeIntervalJob({ id: 'j1', ms: 120_000 });
    engine.register(job1);
    engine.register(job2);
    expect(engine.getJob('j1')).toBe(job2);
    expect(engine.snapshot().size).toBe(1);
  });

  it('updateJobLastFiredAt：handler fire 成功后调，更新内存（reschedule from now）', () => {
    const engine = new SchedulerEngine({ registry: new JobHandlerRegistry() });
    const job = makeIntervalJob({ id: 'j1', ms: 60_000, lastFiredAt: null });
    engine.register(job);
    engine.updateJobLastFiredAt('j1', '2026-03-15T12:00:00.000Z');
    expect(engine.getJob('j1')?.lastFiredAt).toBe('2026-03-15T12:00:00.000Z');
    // 不存在 jobId 静默 no-op
    engine.updateJobLastFiredAt('nonexistent', '2026-03-15T12:00:00.000Z');
  });
});

// ============================================================
// SchedulerEngine tick — fire-and-forget 核心
// ============================================================

describe('SchedulerEngine — tick fire-and-forget', () => {
  it('due job → handler.fire 被调；不 due 不调', () => {
    const registry = new JobHandlerRegistry();
    const { handler, fireSpy } = makeMockHandler({});
    registry.register('test-interval', handler);
    const timers = mockTimers();
    const now = new Date('2026-03-15T12:00:00Z');
    const engine = new SchedulerEngine({
      registry,
      now: () => now,
      setInterval: timers.setInterval as unknown as typeof setInterval,
      clearInterval: timers.clearInterval as unknown as typeof clearInterval,
    });
    // due job（lastFiredAt=null + 无 activeWindow → 首触发）
    const dueJob = makeIntervalJob({ id: 'due', ms: 60_000 });
    // 不 due job（lastFiredAt 30s 前，间隔 60s）
    const notDueJob = makeIntervalJob({
      id: 'not-due',
      ms: 60_000,
      lastFiredAt: '2026-03-15T11:59:45.000Z',
    });
    engine.register(dueJob);
    engine.register(notDueJob);
    engine.start();
    timers.tick();
    expect(fireSpy).toHaveBeenCalledTimes(1);
    expect(fireSpy).toHaveBeenCalledWith(dueJob, now);
    engine.stop();
  });

  it('enabled=false 的 due job 被跳过', () => {
    const registry = new JobHandlerRegistry();
    const { handler, fireSpy } = makeMockHandler({});
    registry.register('test-interval', handler);
    const timers = mockTimers();
    const engine = new SchedulerEngine({
      registry,
      now: () => new Date('2026-03-15T12:00:00Z'),
      setInterval: timers.setInterval as unknown as typeof setInterval,
      clearInterval: timers.clearInterval as unknown as typeof clearInterval,
    });
    engine.register(
      makeIntervalJob({ id: 'disabled', ms: 60_000, enabled: false }),
    );
    engine.start();
    timers.tick();
    expect(fireSpy).not.toHaveBeenCalled();
    engine.stop();
  });

  it('未注册 type handler 的 due job → 跳过（best-effort 不抛）', () => {
    const registry = new JobHandlerRegistry();
    // 不注册 'test-interval' handler
    const timers = mockTimers();
    const engine = new SchedulerEngine({
      registry,
      now: () => new Date('2026-03-15T12:00:00Z'),
      setInterval: timers.setInterval as unknown as typeof setInterval,
      clearInterval: timers.clearInterval as unknown as typeof clearInterval,
    });
    engine.register(makeIntervalJob({ id: 'orphan', ms: 60_000 }));
    engine.start();
    expect(() => timers.tick()).not.toThrow();
    engine.stop();
  });

  it('多 due job：都 fire（fire-and-forget 并发语义，互不阻塞）', async () => {
    const registry = new JobHandlerRegistry();
    const { handler: h1, fireSpy: spy1 } = makeMockHandler({});
    const { handler: h2, fireSpy: spy2 } = makeMockHandler({});
    registry.register('type-a', h1);
    registry.register('type-b', h2);
    const timers = mockTimers();
    const now = new Date('2026-03-15T12:00:00Z');
    const engine = new SchedulerEngine({
      registry,
      now: () => now,
      setInterval: timers.setInterval as unknown as typeof setInterval,
      clearInterval: timers.clearInterval as unknown as typeof clearInterval,
    });
    engine.register({ ...makeIntervalJob({ id: 'a1', ms: 60_000 }), type: 'type-a' });
    engine.register({ ...makeIntervalJob({ id: 'b1', ms: 60_000 }), type: 'type-b' });
    engine.start();
    timers.tick();
    expect(spy1).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), now);
    expect(spy2).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' }), now);
    engine.stop();
  });

  it('handler reject 不阻塞同 tick 内其他 due job', async () => {
    const registry = new JobHandlerRegistry();
    const { handler: badHandler } = makeMockHandler({ reject: true });
    const { handler: goodHandler, fireSpy: goodSpy } = makeMockHandler({});
    registry.register('bad', badHandler);
    registry.register('good', goodHandler);
    const timers = mockTimers();
    const engine = new SchedulerEngine({
      registry,
      now: () => new Date('2026-03-15T12:00:00Z'),
      setInterval: timers.setInterval as unknown as typeof setInterval,
      clearInterval: timers.clearInterval as unknown as typeof clearInterval,
    });
    engine.register({ ...makeIntervalJob({ id: 'bad1', ms: 60_000 }), type: 'bad' });
    engine.register({ ...makeIntervalJob({ id: 'good1', ms: 60_000 }), type: 'good' });
    engine.start();
    expect(() => timers.tick()).not.toThrow();
    // good handler 仍被调（fire-and-forget：reject 已被 .catch 兜底）
    expect(goodSpy).toHaveBeenCalled();
    // 等一下让 rejected promise 的 .catch 跑完（防 unhandledRejection 污染下游测试）
    await new Promise(r => setImmediate(r));
    engine.stop();
  });

  it('单一时间源：每 tick now() 只调一次，传给所有 due job 同一 Date 实例', () => {
    const registry = new JobHandlerRegistry();
    const { handler: h1, fireSpy: spy1 } = makeMockHandler({});
    const { handler: h2, fireSpy: spy2 } = makeMockHandler({});
    registry.register('type-a', h1);
    registry.register('type-b', h2);
    const timers = mockTimers();
    const nowSpy = vi.fn(() => new Date('2026-03-15T12:00:00Z'));
    const engine = new SchedulerEngine({
      registry,
      now: nowSpy,
      setInterval: timers.setInterval as unknown as typeof setInterval,
      clearInterval: timers.clearInterval as unknown as typeof clearInterval,
    });
    engine.register({ ...makeIntervalJob({ id: 'a1', ms: 60_000 }), type: 'type-a' });
    engine.register({ ...makeIntervalJob({ id: 'b1', ms: 60_000 }), type: 'type-b' });
    engine.start();
    timers.tick();
    expect(nowSpy).toHaveBeenCalledTimes(1);
    const nowArg1 = spy1.mock.calls[0]![1];
    const nowArg2 = spy2.mock.calls[0]![1];
    expect(nowArg1).toBe(nowArg2); // 同一 Date 实例
    engine.stop();
  });

  it('未 start 时 setInterval 未被建（runState guard）', () => {
    const registry = new JobHandlerRegistry();
    const timers = mockTimers();
    const engine = new SchedulerEngine({
      registry,
      now: () => new Date('2026-03-15T12:00:00Z'),
      setInterval: timers.setInterval as unknown as typeof setInterval,
      clearInterval: timers.clearInterval as unknown as typeof clearInterval,
    });
    engine.register(makeIntervalJob({ id: 'j1', ms: 60_000 }));
    expect(timers.setInterval).not.toHaveBeenCalled();
  });
});

// ============================================================
// JobHandlerRegistry
// ============================================================

describe('JobHandlerRegistry', () => {
  it('register/get/has + 同 type 覆盖（reload 场景）', () => {
    const registry = new JobHandlerRegistry();
    const { handler: h1 } = makeMockHandler({});
    const { handler: h2 } = makeMockHandler({});
    expect(registry.has('heartbeat')).toBe(false);
    expect(registry.get('heartbeat')).toBeUndefined();
    registry.register('heartbeat', h1);
    expect(registry.has('heartbeat')).toBe(true);
    expect(registry.get('heartbeat')).toBe(h1);
    // 同 type 覆盖
    registry.register('heartbeat', h2);
    expect(registry.get('heartbeat')).toBe(h2);
  });
});
