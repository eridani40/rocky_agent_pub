/**
 * HeartbeatHandler UT — squad 级 gate chain 验证（[v0.0.116] 全量重写）。
 * 参考: specs/tech/scheduling/[P1]heartbeat_handler.md §2（gate 链 + 逐成员展开 + 伪码）
 *
 * gate 顺序：gate0 killswitch → gate1 activeWindows 多段 → gate2 budget → 逐成员 filter + deliverTo
 * squad 级 job：一个 heartbeat job per squad（Job.id=heartbeat:{squadId}），到点整队一次。
 * 成员级 busy/benched/非白名单仅 continue（不影响 job lastResult，仍 fired）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HeartbeatHandler, type HeartbeatHandlerDeps } from '../heartbeat-handler';
import { SchedulerStateStore } from '../../../squad/scheduler/scheduler-state';
import { SchedulerHistory } from '../../../squad/scheduler/scheduler-history';
import { SchedulerEngine } from '../../engine';
import { JobHandlerRegistry } from '../../registry';
import type { Job } from '../../types';
import type { HeartbeatPayload } from '../../payloads';
import type { SquadSnapshot } from '../../../squad/scheduler/types';

let tmpRoot: string;
let stateStore: SchedulerStateStore;
let history: SchedulerHistory;
let engine: SchedulerEngine;
let registry: JobHandlerRegistry;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'heartbeat-handler-'));
  stateStore = new SchedulerStateStore(tmpRoot);
  history = new SchedulerHistory(tmpRoot);
  registry = new JobHandlerRegistry();
  engine = new SchedulerEngine({ registry, now: () => new Date('2026-01-15T10:30:00.000Z') });
});

afterEach(() => {
  engine.stop();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────

/** 心跳配置形态（spec autonomy §3，interval 单位 ms） */
function hb(start: string, end: string, interval: number) {
  return { activeWindow: { start, end }, interval };
}

/** squad record 投影（squad 级；heartbeatConfig null=全天/all） */
function squadSnapshot(overrides: Partial<SquadSnapshot> = {}): SquadSnapshot {
  return {
    enableHeartBeat: true,
    budget: null,
    timezone: 'UTC',
    heartbeatConfig: null, // null=全天放行 + all 成员
    ...overrides,
  };
}

/** mock fn 引用类型（断言时用） */
type Mocks = {
  getSquad: ReturnType<typeof vi.fn>;
  budgetRemaining: ReturnType<typeof vi.fn>;
  isSessionBusy: ReturnType<typeof vi.fn>;
  deliverTo: ReturnType<typeof vi.fn>;
};

/** 构造 interval Job（heartbeat） */
function mkJob(opts: {
  squadId?: string;
  memberId?: string;
  sessionId?: string;
  interval?: number;
  activeWindow?: { start: string; end: string };
  tz?: string;
  lastFiredAt?: string | null;
}): Job {
  const squadId = opts.squadId ?? 'SQ-1';
  const memberId = opts.memberId ?? 'M-1';
  return {
    id: `heartbeat:${squadId}:${memberId}`,
    type: 'heartbeat',
    schedule: {
      kind: 'interval',
      ms: opts.interval ?? 60_000,
      activeWindow: opts.activeWindow ?? { start: '09:00', end: '18:00' },
      tz: opts.tz ?? 'UTC',
    },
    payload: {
      squadId,
      memberId,
      sessionId: opts.sessionId ?? 'SID-1',
    } as HeartbeatPayload,
    lastFiredAt: opts.lastFiredAt ?? null,
    enabled: true,
    createdAt: '2026-01-15T00:00:00.000Z',
    owner: squadId,
  };
}

/** 构造 HeartbeatHandler + mocks（默认 squad enableHeartBeat=true, budget=null, in window, not busy） */
function mkHandler(overrides: {
  deps?: Partial<Omit<HeartbeatHandlerDeps, 'stateStore' | 'history' | 'engine'>>;
} = {}): { handler: HeartbeatHandler; mocks: Mocks } {
  const defaultMocks: Mocks = {
    getSquad: vi.fn(async () => squadSnapshot()),
    budgetRemaining: vi.fn(() => 1000),
    isSessionBusy: vi.fn(async () => false),
    deliverTo: vi.fn(async () => undefined),
  };
  const mocks: Mocks = {
    getSquad: (overrides.deps?.getSquad as Mocks['getSquad']) ?? defaultMocks.getSquad,
    budgetRemaining: (overrides.deps?.budgetRemaining as Mocks['budgetRemaining']) ?? defaultMocks.budgetRemaining,
    isSessionBusy: (overrides.deps?.isSessionBusy as Mocks['isSessionBusy']) ?? defaultMocks.isSessionBusy,
    deliverTo: (overrides.deps?.deliverTo as Mocks['deliverTo']) ?? defaultMocks.deliverTo,
  };
  // listMembers 默认返一个 deployed 成员（SID-1），测试只覆盖单成员场景时用默认即可
  const listMembersFn = overrides.deps?.listMembers
    ?? (async () => [{ id: 'M-1', sessionId: 'SID-1', state: 'deployed' as const, role: 'mate' }]);
  const handler = new HeartbeatHandler({
    getSquad: mocks.getSquad,
    listMembers: listMembersFn,
    budgetRemaining: mocks.budgetRemaining,
    isSessionBusy: mocks.isSessionBusy,
    deliverTo: mocks.deliverTo,
    stateStore,
    history,
    engine,
  });
  return { handler, mocks };
}

// ── R1: squad 级 job，成员由 listMembers 展开 ─────────────────────────

describe('R1: squad 级 job — 多成员展开（listMembers）', () => {
  it('listMembers 返 2 deployed 成员 → deliverTo 各调 1 次（共 2 次）', async () => {
    // squad 级：一个 job 覆盖整队，所有 deployed 成员各收一次 tick message
    const { handler, mocks } = mkHandler({
      deps: {
        listMembers: async () => [
          { id: 'M-1', sessionId: 'SID-1', state: 'deployed' as const, role: 'mate' },
          { id: 'M-2', sessionId: 'SID-2', state: 'deployed' as const, role: 'mate' },
        ],
      },
    });
    const job = mkJob({});
    await handler.fire(job, new Date('2026-01-15T10:30:00.000Z'));
    expect(mocks.deliverTo).toHaveBeenCalledTimes(2);
    const sids = mocks.deliverTo.mock.calls.map((c: unknown[]) => c[0]);
    expect(sids).toContain('SID-1');
    expect(sids).toContain('SID-2');
  });

  it('外窗口（localHHmm 不在 activeWindow 内）→ skipped_window，不 deliverTo', async () => {
    // activeWindows 来源 = squad.heartbeatConfig.activeWindows（不读 job.schedule）
    const { handler, mocks } = mkHandler({
      deps: {
        getSquad: vi.fn(async () => squadSnapshot({
          heartbeatConfig: { interval: 60, activeWindows: [{ start: '09:00', end: '18:00' }], scope: { mode: 'all', memberIds: [] } },
        })),
      },
    });
    // squad tz=UTC，activeWindow 09:00-18:00，now=20:00 → 外窗口
    const job = mkJob({ activeWindow: { start: '09:00', end: '18:00' } });
    await handler.fire(job, new Date('2026-01-15T20:30:00.000Z'));
    expect(mocks.deliverTo).not.toHaveBeenCalled();
    // history 记 skipped_window
    const items = history.getHistory('SQ-1', 10);
    expect(items[0]?.result).toBe('skipped_window');
  });
});

// ── R2: gate 顺序 window→budget→busy→deliverTo ───────────────────────

describe('R2: gate 顺序 window→budget→busy→deliverTo', () => {
  it('外窗口 + budget=0：不查 budget（前 gate fail 不查后 gate）', async () => {
    const { handler, mocks } = mkHandler({
      deps: {
        getSquad: vi.fn(async () => squadSnapshot({
          budget: { limit: 1000, window: 'daily', scope: 'team' },
          heartbeatConfig: { interval: 60, activeWindows: [{ start: '09:00', end: '18:00' }], scope: { mode: 'all', memberIds: [] } },
        })),
        budgetRemaining: vi.fn(() => 0),  // budget=0
      },
    });
    const job = mkJob({ activeWindow: { start: '09:00', end: '18:00' } });
    // now=20:30 外窗口
    await handler.fire(job, new Date('2026-01-15T20:30:00.000Z'));
    // window gate 先 fail，不查 budgetRemaining
    expect(mocks.budgetRemaining).not.toHaveBeenCalled();
    expect(mocks.deliverTo).not.toHaveBeenCalled();
  });

  it('窗口内 + budget=0：skipped_budget，不查 busy / 不 deliverTo', async () => {
    const { handler, mocks } = mkHandler({
      deps: {
        getSquad: vi.fn(async () => squadSnapshot({ budget: { limit: 1000, window: 'daily', scope: 'team' } })),
        budgetRemaining: vi.fn(() => 0),
        isSessionBusy: vi.fn(async () => false),
      },
    });
    const job = mkJob({ activeWindow: { start: '09:00', end: '18:00' } });
    // now=10:30 窗口内
    await handler.fire(job, new Date('2026-01-15T10:30:00.000Z'));
    expect(mocks.budgetRemaining).toHaveBeenCalledWith('SQ-1');
    // budget gate fail，不查 busy
    expect(mocks.isSessionBusy).not.toHaveBeenCalled();
    expect(mocks.deliverTo).not.toHaveBeenCalled();
    const items = history.getHistory('SQ-1', 10);
    expect(items[0]?.result).toBe('skipped_budget');
  });

  it('busy 成员跳过但整队 fired（squad 级 result 仍 fired，仅成员级 continue）', async () => {
    // v0.0.116: busy 是成员级 continue，不影响队级 lastResult
    const { handler, mocks } = mkHandler({
      deps: {
        // 2 成员：SID-1 busy（跳过）、SID-2 not busy（投递）
        listMembers: async () => [
          { id: 'M-1', sessionId: 'SID-1', state: 'deployed' as const, role: 'mate' },
          { id: 'M-2', sessionId: 'SID-2', state: 'deployed' as const, role: 'mate' },
        ],
        isSessionBusy: vi.fn(async (sid: string) => sid === 'SID-1'),
      },
    });
    const job = mkJob({});
    const registeredJob = { ...job };
    engine.register(registeredJob);
    await handler.fire(registeredJob, new Date('2026-01-15T10:30:00.000Z'));
    // SID-1 busy → 跳过；SID-2 投递
    expect(mocks.deliverTo).toHaveBeenCalledTimes(1);
    expect(mocks.deliverTo).toHaveBeenCalledWith('SID-2', expect.anything());
    // 队级 result = fired（有至少一个成员投递 or 整队 gate 通过即 fired）
    expect(stateStore.readSquad('SQ-1')?.lastResult).toBe('fired');
  });

  it('全 gate 通过 → deliverTo tick Message（role=user + sender.source=system + metadata.tickMessage）', async () => {
    const { handler, mocks } = mkHandler();
    const now = new Date('2026-01-15T10:30:00.000Z');
    const job = mkJob({});
    await handler.fire(job, now);
    expect(mocks.deliverTo).toHaveBeenCalledWith('SID-1', expect.objectContaining({
      sessionId: 'SID-1',
      role: 'user',
      sender: { source: 'system', system: { kind: 'heartbeat' } },
      metadata: {
        tickMessage: {
          kind: 'proactive_tick',
          reason: 'heartbeat',
          at: now.toISOString(),
        },
      },
    }));
  });
});

// ── R3: killswitch 每 tick 现取 ───────────────────────────────────────

describe('R3: killswitch（squad.enableHeartBeat）每 tick 现取', () => {
  it('enableHeartBeat=false → skipped_killswitch，不 deliverTo', async () => {
    const { handler, mocks } = mkHandler({
      deps: { getSquad: vi.fn(async () => squadSnapshot({ enableHeartBeat: false })) },
    });
    const job = mkJob({});
    await handler.fire(job, new Date('2026-01-15T10:30:00.000Z'));
    expect(mocks.deliverTo).not.toHaveBeenCalled();
    expect(history.getHistory('SQ-1', 10)[0]?.result).toBe('skipped_killswitch');
  });

  it('squad 不存在（getSquad=undefined）→ skipped_killswitch（当 killswitch 处理）', async () => {
    const { handler, mocks } = mkHandler({
      deps: { getSquad: vi.fn(async () => undefined) },
    });
    const job = mkJob({});
    await handler.fire(job, new Date('2026-01-15T10:30:00.000Z'));
    expect(mocks.deliverTo).not.toHaveBeenCalled();
    expect(history.getHistory('SQ-1', 10)[0]?.result).toBe('skipped_killswitch');
  });

  it('toggle 真→假→真：每次 fire 现取（同 engine + handler 实例，行为随 squad 变）', async () => {
    let enabled = true;
    const { handler, mocks } = mkHandler({
      deps: { getSquad: vi.fn(async () => squadSnapshot({ enableHeartBeat: enabled })) },
    });
    const job = mkJob({});
    // 真 → fire
    await handler.fire(job, new Date('2026-01-15T10:30:00.000Z'));
    expect(mocks.deliverTo).toHaveBeenCalledTimes(1);
    // 假 → skip
    enabled = false;
    await handler.fire(job, new Date('2026-01-15T10:31:00.000Z'));
    expect(mocks.deliverTo).toHaveBeenCalledTimes(1);  // 仍 1，未增
    // 真 → fire
    enabled = true;
    await handler.fire(job, new Date('2026-01-15T10:32:00.000Z'));
    expect(mocks.deliverTo).toHaveBeenCalledTimes(2);
  });
});

// ── R4: lastFiredAt 续接（重启不丢） ──────────────────────────────────

describe('R4: lastFiredAt 续接（重启不丢）', () => {
  it('fire 成功 → engine.updateJobLastFiredAt(now) + stateStore 落盘', async () => {
    const { handler } = mkHandler();
    const now = new Date('2026-01-15T10:30:00.000Z');
    const job = mkJob({ lastFiredAt: null });
    engine.register(job);
    await handler.fire(job, now);
    // engine 内 job.lastFiredAt 更新
    expect(engine.getJob(job.id)?.lastFiredAt).toBe(now.toISOString());
    // stateStore 落盘（squad 级 writeSquad）
    expect(stateStore.readSquad('SQ-1')?.lastFiredAt).toBe(now.toISOString());
    expect(stateStore.readSquad('SQ-1')?.lastResult).toBe('fired');
  });

  it('gate skip → 不调 updateJobLastFiredAt（保旧 lastFiredAt）+ stateStore 落旧值', async () => {
    const { handler } = mkHandler({
      deps: { getSquad: vi.fn(async () => squadSnapshot({ enableHeartBeat: false })) },
    });
    const oldIso = '2026-01-15T09:00:00.000Z';
    const job = mkJob({ lastFiredAt: oldIso });
    engine.register(job);
    await handler.fire(job, new Date('2026-01-15T10:30:00.000Z'));
    // engine 内 lastFiredAt 不变
    expect(engine.getJob(job.id)?.lastFiredAt).toBe(oldIso);
    // stateStore 落旧 lastFiredAt + skipped_killswitch
    expect(stateStore.readSquad('SQ-1')?.lastFiredAt).toBe(oldIso);
    expect(stateStore.readSquad('SQ-1')?.lastResult).toBe('skipped_killswitch');
  });

  it('重启续接：新 engine 实例从 stateStore 回填的 lastFiredAt（adapter.loadJobs）', async () => {
    // 第一次：fire 一次落盘 lastFiredAt
    const { handler: h1 } = mkHandler();
    const t1 = new Date('2026-01-15T10:30:00.000Z');
    const job1 = mkJob({});
    engine.register(job1);
    await h1.fire(job1, t1);
    const persistedIso = stateStore.readSquad('SQ-1')?.lastFiredAt;
    expect(persistedIso).toBe(t1.toISOString());
    // 模拟重启：换 engine（停旧 / 新建），从 stateStore 回填新 job.lastFiredAt
    engine.stop();
    const registry2 = new JobHandlerRegistry();
    const engine2 = new SchedulerEngine({ registry: registry2 });
    try {
      const restartedJob: Job = { ...job1, lastFiredAt: persistedIso ?? null };
      engine2.register(restartedJob);
      expect(engine2.getJob(job1.id)?.lastFiredAt).toBe(persistedIso);
    } finally {
      engine2.stop();
    }
  });
});

// ── R5: null-budget Gate 放行 ─────────────────────────────────────────

describe('R5: null-budget Gate 放行', () => {
  it('squad.budget=null → 不查 budgetRemaining，gate 放行（fire 成功）', async () => {
    const { handler, mocks } = mkHandler({
      deps: {
        getSquad: vi.fn(async () => squadSnapshot({ budget: null })),
        budgetRemaining: vi.fn(() => 0),  // 即使返 0，也不应被调
      },
    });
    const job = mkJob({});
    await handler.fire(job, new Date('2026-01-15T10:30:00.000Z'));
    expect(mocks.budgetRemaining).not.toHaveBeenCalled();
    expect(mocks.deliverTo).toHaveBeenCalledTimes(1);
  });

  it('squad.budget 非 null + remaining>0 → 查 budgetRemaining，gate 放行', async () => {
    const { handler, mocks } = mkHandler({
      deps: {
        getSquad: vi.fn(async () => squadSnapshot({ budget: { limit: 1000, window: 'daily', scope: 'team' } })),
        budgetRemaining: vi.fn(() => 500),
      },
    });
    const job = mkJob({});
    await handler.fire(job, new Date('2026-01-15T10:30:00.000Z'));
    expect(mocks.budgetRemaining).toHaveBeenCalledWith('SQ-1');
    expect(mocks.deliverTo).toHaveBeenCalledTimes(1);
  });
});

// ── R6: 多 squad 隔离 + cross-midnight activeWindow 不变量 ─────────────

describe('R6: 多 squad 隔离 + cross-midnight activeWindow 不变量', () => {
  it('Job.id 全局唯一：不同 squad 互不干扰，history.roleId 记 squadId', async () => {
    const { handler, mocks } = mkHandler();
    const jobA = mkJob({ squadId: 'SQ-A' });
    const jobB = mkJob({ squadId: 'SQ-B' });
    // squad 级 job.id = heartbeat:{squadId}（mkJob helper 产生旧格式但 squadId 不同仍全局唯一）
    expect(jobA.id).not.toBe(jobB.id);

    await handler.fire(jobA, new Date('2026-01-15T10:30:00.000Z'));
    await handler.fire(jobB, new Date('2026-01-15T10:30:00.000Z'));

    // 各 squad history 独立（squadId 分片）；roleId 记 squadId
    expect(history.getHistory('SQ-A', 10)[0]?.roleId).toBe('SQ-A');
    expect(history.getHistory('SQ-B', 10)[0]?.roleId).toBe('SQ-B');
    // deliverTo 各调一次（default listMembers: 1 deployed member per squad）
    expect(mocks.deliverTo).toHaveBeenCalledTimes(2);
  });

  it('不同 squad 独立 killswitch（SQ-A 关 / SQ-B 开，A skip B fire）', async () => {
    const { handler, mocks } = mkHandler({
      deps: {
        getSquad: vi.fn(async (squadId: string) =>
          squadSnapshot({ enableHeartBeat: squadId === 'SQ-B' }),
        ),
      },
    });
    const jobA = mkJob({ squadId: 'SQ-A' });
    const jobB = mkJob({ squadId: 'SQ-B' });
    await handler.fire(jobA, new Date('2026-01-15T10:30:00.000Z'));
    await handler.fire(jobB, new Date('2026-01-15T10:30:00.000Z'));
    // SQ-A killswitch 关 → skip，SQ-B 开 → fire（listMembers 默认返 SID-1）
    expect(mocks.deliverTo).toHaveBeenCalledTimes(1);
    expect(mocks.deliverTo).toHaveBeenCalledWith('SID-1', expect.anything());
  });

  it('cross-midnight activeWindow（22:00-06:00）：23:00 在窗口内 → fire', async () => {
    const { handler, mocks } = mkHandler({
      deps: {
        getSquad: vi.fn(async () => squadSnapshot({
          heartbeatConfig: { interval: 60, activeWindows: [{ start: '22:00', end: '06:00' }], scope: { mode: 'all', memberIds: [] } },
        })),
      },
    });
    const job = mkJob({});
    await handler.fire(job, new Date('2026-01-15T23:30:00.000Z'));
    expect(mocks.deliverTo).toHaveBeenCalledTimes(1);
  });

  it('cross-midnight activeWindow（22:00-06:00）：12:00 外窗口 → skipped_window', async () => {
    const { handler, mocks } = mkHandler({
      deps: {
        getSquad: vi.fn(async () => squadSnapshot({
          heartbeatConfig: { interval: 60, activeWindows: [{ start: '22:00', end: '06:00' }], scope: { mode: 'all', memberIds: [] } },
        })),
      },
    });
    const job = mkJob({});
    await handler.fire(job, new Date('2026-01-15T12:00:00.000Z'));
    expect(mocks.deliverTo).not.toHaveBeenCalled();
    expect(history.getHistory('SQ-1', 10)[0]?.result).toBe('skipped_window');
  });

  it('cross-midnight activeWindow（22:00-06:00）：05:00 在窗口内 → fire', async () => {
    const { handler, mocks } = mkHandler({
      deps: {
        getSquad: vi.fn(async () => squadSnapshot({
          heartbeatConfig: { interval: 60, activeWindows: [{ start: '22:00', end: '06:00' }], scope: { mode: 'all', memberIds: [] } },
        })),
      },
    });
    const job = mkJob({});
    await handler.fire(job, new Date('2026-01-15T05:30:00.000Z'));
    expect(mocks.deliverTo).toHaveBeenCalledTimes(1);
  });
});

// ── 异常自吞 ──────────────────────────────────────────────────────────

describe('异常自吞（不阻塞 engine 下 tick）', () => {
  it('deliverTo 抛错 → handler 自吞（fire 不抛）', async () => {
    const { handler, mocks } = mkHandler({
      deps: { deliverTo: vi.fn(async () => { throw new Error('boom'); }) },
    });
    const job = mkJob({});
    await expect(handler.fire(job, new Date('2026-01-15T10:30:00.000Z'))).resolves.toBeUndefined();
    expect(mocks.deliverTo).toHaveBeenCalledTimes(1);
  });

  it('getSquad 抛错 → handler 自吞', async () => {
    const { handler } = mkHandler({
      deps: { getSquad: vi.fn(async () => { throw new Error('boom'); }) },
    });
    const job = mkJob({});
    await expect(handler.fire(job, new Date('2026-01-15T10:30:00.000Z'))).resolves.toBeUndefined();
  });
});

// ── 非 heartbeat type 守护 ────────────────────────────────────────────

describe('job.type !== heartbeat', () => {
  it('非 heartbeat type → 立即 return（不查 squad 不 deliverTo）', async () => {
    const { handler, mocks } = mkHandler();
    const job: Job = {
      ...mkJob({}),
      type: 'cron',  // 非 heartbeat
    };
    await handler.fire(job, new Date('2026-01-15T10:30:00.000Z'));
    expect(mocks.getSquad).not.toHaveBeenCalled();
    expect(mocks.deliverTo).not.toHaveBeenCalled();
  });
});

// 避免未用变量 lint 警告
void hb;
