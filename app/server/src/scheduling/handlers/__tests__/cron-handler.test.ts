/**
 * CronHandler UT — gate 顺序 + orphan clean + squadId 派生 budget。
 * 参考: specs/tech/scheduling/[P1]cron_subsystem.md §2（权威契约）
 *       states/v0.0.58.cron/verify/test-plan.md §5（UT 范围：cron handler gate）
 *
 * 覆盖（task.json T3 acceptanceCriteria §2）：
 *   G1: gate0 sessionExists=false → orphan auto-clean（cronStore.removeJob + engine.unregister），不 deliverTo
 *   G2: job.enabled=false → 双保 skip（不查 busy / 不 deliverTo）
 *   G3: gate1 busy=true → skip（不查 budget / 不 deliverTo）
 *   G4: gate2 squad budget — playground（squadId=null）不查 budget
 *   G5: gate2 squad budget — squad session & remaining<=0 → skip
 *   G6: gate2 squad budget — squad session & remaining=null（无 budget 配置）→ 放行
 *   G7: gate2 squad budget — squad session & remaining>0 → 放行
 *   G8: gate 顺序：前 gate fail 不查后 gate（sessionExists fail → 不查 busy/budget）
 *   G9: fire 成功 → deliverTo + engine.updateJobLastFiredAt + cronStore.upsertJob（lastFiredAt=now）
 *   G10: fire 异常 try/catch 自吞（不抛 reject 阻塞 engine）
 *
 * 全 deps 注入 mock（sessionExists / isSessionBusy / squadBudgetRemaining / deliverTo / cronStore）；
 *   engine 用真实 SchedulerEngine（updateJobLastFiredAt 走真实路径）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CronHandler, type CronHandlerDeps } from '../cron-handler';
import { CronPersistenceAdapter } from '../../persistence/cron-adapter';
import { SchedulerEngine } from '../../engine';
import { JobHandlerRegistry } from '../../registry';
import type { Job } from '../../types';
import type { CronPayload } from '../../payloads';

let tmpRoot: string;
let engine: SchedulerEngine;
let registry: JobHandlerRegistry;
let cronStore: CronPersistenceAdapter;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cron-handler-'));
  registry = new JobHandlerRegistry();
  engine = new SchedulerEngine({ registry, now: () => new Date('2026-07-03T10:00:00.000Z') });
  cronStore = new CronPersistenceAdapter({
    fsRoot: tmpRoot,
    resolveSquadId: async () => null,
  });
});

afterEach(() => {
  engine.stop();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────

type Mocks = {
  sessionExists: ReturnType<typeof vi.fn>;
  isSessionBusy: ReturnType<typeof vi.fn>;
  squadBudgetRemaining: ReturnType<typeof vi.fn>;
  deliverTo: ReturnType<typeof vi.fn>;
  removeJob: ReturnType<typeof vi.fn>;
  upsertJob: ReturnType<typeof vi.fn>;
};

/** 构造 cron Job（squadId 默认 null=playground） */
function mkJob(opts: {
  sessionId?: string;
  name?: string;
  prompt?: string;
  squadId?: string | null;
  enabled?: boolean;
  lastFiredAt?: string | null;
  cron?: string;
  tz?: string;
}): Job {
  const sessionId = opts.sessionId ?? 'SID-1';
  const squadId = opts.squadId ?? null;
  const payload: CronPayload = {
    sessionId,
    name: opts.name ?? 'check todo',
    prompt: opts.prompt ?? '推进未完成任务',
    squadId,
  };
  return {
    id: `cron:${sessionId}:J-1`,
    type: 'cron',
    schedule: { kind: 'cron', expr: opts.cron ?? '*/30 * * * *', tz: opts.tz ?? 'UTC' },
    payload,
    lastFiredAt: opts.lastFiredAt ?? null,
    enabled: opts.enabled ?? true,
    createdAt: '2026-07-01T00:00:00.000Z',
    owner: sessionId,
  };
}

/** 构造 handler + mocks；default 全 gate 放行（sessionExists=true, not busy, budget=null=放行） */
function mkHandler(overrides: {
  deps?: Partial<Omit<CronHandlerDeps, 'cronStore' | 'engine'>>;
  cronStoreOverrides?: { removeJob?: Mocks['removeJob']; upsertJob?: Mocks['upsertJob'] };
} = {}): { handler: CronHandler; mocks: Mocks } {
  const defaultMocks: Mocks = {
    sessionExists: vi.fn(async () => true),
    isSessionBusy: vi.fn(async () => false),
    squadBudgetRemaining: vi.fn(async () => null),  // null=放行
    deliverTo: vi.fn(async () => undefined),
    removeJob: vi.fn(async () => undefined),
    upsertJob: vi.fn(async () => undefined),
  };
  const mocks: Mocks = {
    sessionExists: (overrides.deps?.sessionExists as Mocks['sessionExists']) ?? defaultMocks.sessionExists,
    isSessionBusy: (overrides.deps?.isSessionBusy as Mocks['isSessionBusy']) ?? defaultMocks.isSessionBusy,
    squadBudgetRemaining: (overrides.deps?.squadBudgetRemaining as Mocks['squadBudgetRemaining']) ?? defaultMocks.squadBudgetRemaining,
    deliverTo: (overrides.deps?.deliverTo as Mocks['deliverTo']) ?? defaultMocks.deliverTo,
    removeJob: overrides.cronStoreOverrides?.removeJob ?? defaultMocks.removeJob,
    upsertJob: overrides.cronStoreOverrides?.upsertJob ?? defaultMocks.upsertJob,
  };
  // 包装 cronStore：默认走 mock（不真写文件），保留真实 cronStore 用于 orphan 测试时覆盖
  const fakeCronStore = {
    removeJob: mocks.removeJob,
    upsertJob: mocks.upsertJob,
  } as unknown as CronPersistenceAdapter;
  const handler = new CronHandler({
    sessionExists: mocks.sessionExists,
    isSessionBusy: mocks.isSessionBusy,
    squadBudgetRemaining: mocks.squadBudgetRemaining,
    deliverTo: mocks.deliverTo,
    cronStore: fakeCronStore,
    engine,
  });
  return { handler, mocks };
}

// ── G1: orphan auto-clean ─────────────────────────────────────────────

describe('G1: gate0 sessionExists=false → orphan auto-clean', () => {
  it('session 不存在 → cronStore.removeJob + engine.unregister，不 deliverTo', async () => {
    const { handler, mocks } = mkHandler({
      deps: { sessionExists: vi.fn(async () => false) },
    });
    const job = mkJob({});
    engine.register(job);
    expect(engine.has(job.id)).toBe(true);

    await handler.fire(job, new Date('2026-07-03T10:00:00.000Z'));

    expect(mocks.removeJob).toHaveBeenCalledWith('SID-1', job.id);
    expect(engine.has(job.id)).toBe(false);  // engine.unregister 已调
    expect(mocks.deliverTo).not.toHaveBeenCalled();
    expect(mocks.isSessionBusy).not.toHaveBeenCalled();
    expect(mocks.squadBudgetRemaining).not.toHaveBeenCalled();
  });
});

// ── G2: enabled=false 双保 ─────────────────────────────────────────────

describe('G2: job.enabled=false → 双保 skip', () => {
  it('enabled=false → 不 deliverTo / 不查 busy', async () => {
    const { handler, mocks } = mkHandler();
    const job = mkJob({ enabled: false });
    await handler.fire(job, new Date('2026-07-03T10:00:00.000Z'));
    expect(mocks.deliverTo).not.toHaveBeenCalled();
    expect(mocks.isSessionBusy).not.toHaveBeenCalled();
  });
});

// ── G3: gate1 busy ─────────────────────────────────────────────────────

describe('G3: gate1 busy=true → skip', () => {
  it('busy → 不 deliverTo / 不查 budget（squad session 时）', async () => {
    const { handler, mocks } = mkHandler({
      deps: {
        isSessionBusy: vi.fn(async () => true),
        squadBudgetRemaining: vi.fn(async () => 100),
      },
    });
    const job = mkJob({ squadId: 'SQ-1' });
    await handler.fire(job, new Date('2026-07-03T10:00:00.000Z'));
    expect(mocks.deliverTo).not.toHaveBeenCalled();
    expect(mocks.squadBudgetRemaining).not.toHaveBeenCalled();  // busy 在 budget 前
  });
});

// ── G4: playground skip budget ─────────────────────────────────────────

describe('G4: gate2 squad budget — playground (squadId=null) 不查 budget', () => {
  it('squadId=null → deliverTo 调用 / squadBudgetRemaining 不调', async () => {
    const { handler, mocks } = mkHandler({
      deps: { squadBudgetRemaining: vi.fn(async () => 0) },  // 即使 0 也不应被调
    });
    const job = mkJob({ squadId: null });
    await handler.fire(job, new Date('2026-07-03T10:00:00.000Z'));
    expect(mocks.deliverTo).toHaveBeenCalledTimes(1);
    expect(mocks.squadBudgetRemaining).not.toHaveBeenCalled();
  });
});

// ── G5/G6/G7: squad budget 三态 ────────────────────────────────────────

describe('G5: gate2 squad budget — squad & remaining<=0 → skip', () => {
  it('remaining=0 → skip（不 deliverTo）', async () => {
    const { handler, mocks } = mkHandler({
      deps: { squadBudgetRemaining: vi.fn(async () => 0) },
    });
    const job = mkJob({ squadId: 'SQ-1' });
    await handler.fire(job, new Date('2026-07-03T10:00:00.000Z'));
    expect(mocks.squadBudgetRemaining).toHaveBeenCalledWith('SQ-1');
    expect(mocks.deliverTo).not.toHaveBeenCalled();
  });

  it('remaining=-5（负数）→ skip', async () => {
    const { handler, mocks } = mkHandler({
      deps: { squadBudgetRemaining: vi.fn(async () => -5) },
    });
    const job = mkJob({ squadId: 'SQ-1' });
    await handler.fire(job, new Date('2026-07-03T10:00:00.000Z'));
    expect(mocks.deliverTo).not.toHaveBeenCalled();
  });
});

describe('G6: gate2 squad budget — squad & remaining=null → 放行（无 budget 配置）', () => {
  it('remaining=null → deliverTo（与 playground 同行为）', async () => {
    const { handler, mocks } = mkHandler({
      deps: { squadBudgetRemaining: vi.fn(async () => null) },
    });
    const job = mkJob({ squadId: 'SQ-1' });
    await handler.fire(job, new Date('2026-07-03T10:00:00.000Z'));
    expect(mocks.deliverTo).toHaveBeenCalledTimes(1);
  });
});

describe('G7: gate2 squad budget — squad & remaining>0 → 放行', () => {
  it('remaining=1000 → deliverTo', async () => {
    const { handler, mocks } = mkHandler({
      deps: { squadBudgetRemaining: vi.fn(async () => 1000) },
    });
    const job = mkJob({ squadId: 'SQ-1' });
    await handler.fire(job, new Date('2026-07-03T10:00:00.000Z'));
    expect(mocks.deliverTo).toHaveBeenCalledTimes(1);
  });
});

// ── G8: gate 顺序 ─────────────────────────────────────────────────────

describe('G8: gate 顺序 — 前 gate fail 不查后 gate', () => {
  it('busy=true → 不查 budget（即使 squad session）', async () => {
    const { handler, mocks } = mkHandler({
      deps: {
        isSessionBusy: vi.fn(async () => true),
        squadBudgetRemaining: vi.fn(async () => 0),
      },
    });
    const job = mkJob({ squadId: 'SQ-1' });
    await handler.fire(job, new Date('2026-07-03T10:00:00.000Z'));
    expect(mocks.squadBudgetRemaining).not.toHaveBeenCalled();
  });
});

// ── G9: fire 成功 ─────────────────────────────────────────────────────

describe('G9: fire 成功 → deliverTo + engine.updateJobLastFiredAt + cronStore.upsertJob', () => {
  it('全 gate 通过 → deliverTo 调（含 cron Message）+ engine 内存 lastFiredAt=now + cronStore.upsertJob', async () => {
    const { handler, mocks } = mkHandler();
    const job = mkJob({ name: 'daily check', prompt: 'do work' });
    engine.register(job);

    await handler.fire(job, new Date('2026-07-03T10:00:00.000Z'));

    // deliverTo 收到 cron Message
    expect(mocks.deliverTo).toHaveBeenCalledWith(
      'SID-1',
      expect.objectContaining({
        role: 'user',
        sessionId: 'SID-1',
        sender: expect.objectContaining({ source: 'system' }),
        metadata: { cron: { at: '2026-07-03T10:00:00.000Z', name: 'daily check', prompt: 'do work' } },
      }),
    );
    // engine 内存 lastFiredAt 更新为 now
    expect(engine.getJob(job.id)?.lastFiredAt).toBe('2026-07-03T10:00:00.000Z');
    // cronStore.upsertJob 收到 lastFiredAt=now 的 job
    expect(mocks.upsertJob).toHaveBeenCalledTimes(1);
    const upsertArg = mocks.upsertJob.mock.calls[0];
    expect(upsertArg?.[0]).toBe('SID-1');
    expect((upsertArg?.[1] as Job).lastFiredAt).toBe('2026-07-03T10:00:00.000Z');
  });

  it('gate skip（busy）→ engine.lastFiredAt 不变 + cronStore.upsertJob 不调', async () => {
    const { handler, mocks } = mkHandler({
      deps: { isSessionBusy: vi.fn(async () => true) },
    });
    const job = mkJob({ lastFiredAt: '2026-07-02T00:00:00.000Z' });
    engine.register(job);
    await handler.fire(job, new Date('2026-07-03T10:00:00.000Z'));
    expect(engine.getJob(job.id)?.lastFiredAt).toBe('2026-07-02T00:00:00.000Z');  // 旧值保留
    expect(mocks.upsertJob).not.toHaveBeenCalled();
  });
});

// ── G10: 异常自吞 ─────────────────────────────────────────────────────

describe('G10: deliverTo 抛 → 异常自吞，不 reject', () => {
  it('deliverTo reject → handler.fire 不抛（catch 兜底）', async () => {
    const { handler, mocks } = mkHandler({
      deps: { deliverTo: vi.fn(async () => { throw new Error('boom'); }) },
    });
    const job = mkJob({});
    // 不应 reject
    await expect(handler.fire(job, new Date('2026-07-03T10:00:00.000Z'))).resolves.toBeUndefined();
    // 抛前 deliverTo 已被调（gate 全通过）
    expect(mocks.deliverTo).toHaveBeenCalled();
  });
});

// ── gate 顺序：enabled=false 时 sessionExists 仍调（gate0 先于 enabled 双保） ──

describe('gate 顺序：sessionExists (gate0) 先于 enabled 双保', () => {
  it('sessionExists=true & enabled=false → sessionExists 调，但 orphan clean 不触发', async () => {
    const { handler, mocks } = mkHandler({
      deps: { sessionExists: vi.fn(async () => true) },
    });
    const job = mkJob({ enabled: false });
    engine.register(job);
    await handler.fire(job, new Date('2026-07-03T10:00:00.000Z'));
    expect(mocks.sessionExists).toHaveBeenCalledWith('SID-1');
    expect(mocks.removeJob).not.toHaveBeenCalled();  // session 存在 → 不 orphan clean
    expect(engine.has(job.id)).toBe(true);  // 不 unregister
  });
});
