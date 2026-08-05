/**
 * ConsolidationJobHandler UT —— 纯调度 glue（读配置 gate1 + 调 runner + 写 lastResult + 推进 lastFiredAt）。
 * 参考: specs/tech/scheduling/[P1]consolidation_job.md §4
 *       task.json v0.0.151.t2_consolidate Task2 acceptanceCriteria
 *
 * 覆盖：
 *   H1: job.type !== 'consolidation' → 立即 return，零副作用
 *   H2: gate1（appConfig.get 本身抛异常）→ 不推进 lastFiredAt、不调 runner
 *   H3: 正常路径 → 调 runConsolidationTier2 一次 → 写 lastResult → 推进 lastFiredAt + upsertJob
 *   H4: windowStart 转发 — job.lastFiredAt=null 时不传 windowStart（undefined，runner 内部回退 now-24h）；
 *       job.lastFiredAt 非 null 时原样转发
 *   H5: runner 内部抛异常（理论罕见）——仍推进 lastFiredAt（"到点必执行一次"，不写 lastResult）
 *
 * runConsolidationTier2 走 vi.mock（隔离 handler 自身逻辑，不依赖 Task1 runner 内部真实执行）；
 * engine/adapter 用 vi.fn 桩替身（只验证被正确调用，不依赖真实持久化/引擎 Map 行为）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock(require('path').resolve(__dirname, '../../../agent/consolidation-tier2/runner'), async (importActual) => {
  const actual = await importActual<typeof import('../../../agent/consolidation-tier2/runner')>();
  return { ...actual, runConsolidationTier2: vi.fn() };
});

import { ConsolidationJobHandler, type ConsolidationJobHandlerDeps } from '../consolidation-handler';
import { runConsolidationTier2 } from '../../../agent/consolidation-tier2/runner';
import type { Job } from '../../types';
import type { AppConfigService } from '../../../config/app-config-service';
import type { SchedulerEngine } from '../../engine';
import type { ConsolidationPersistenceAdapter } from '../../persistence/consolidation-adapter';
import { AppTaskLock } from '../../../agent/app-task-lock';

const CONSOLIDATION_TASK_TYPE = 'tier2_consolidation';

const mockRunner = runConsolidationTier2 as unknown as ReturnType<typeof vi.fn>;
const FIXED_NOW = new Date('2026-07-15T04:00:00.000Z');

function mkJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'consolidation:app',
    type: 'consolidation',
    schedule: { kind: 'cron', expr: '0 4 * * *', tz: 'UTC' },
    payload: {},
    lastFiredAt: null,
    enabled: true,
    createdAt: '2026-07-01T00:00:00.000Z',
    owner: 'app',
    ...overrides,
  };
}

function mkDeps(overrides: {
  appConfigGet?: ReturnType<typeof vi.fn>;
  writeLastResult?: ReturnType<typeof vi.fn>;
  upsertJob?: ReturnType<typeof vi.fn>;
  updateJobLastFiredAt?: ReturnType<typeof vi.fn>;
} = {}): {
  deps: ConsolidationJobHandlerDeps;
  writeLastResult: ReturnType<typeof vi.fn>;
  upsertJob: ReturnType<typeof vi.fn>;
  updateJobLastFiredAt: ReturnType<typeof vi.fn>;
  appConfigGet: ReturnType<typeof vi.fn>;
} {
  const appConfigGet = overrides.appConfigGet ?? vi.fn(() => ({ enabled: true, dailyTime: '04:00', modelId: 'm1' }));
  const writeLastResult = overrides.writeLastResult ?? vi.fn();
  const upsertJob = overrides.upsertJob ?? vi.fn(async () => undefined);
  const updateJobLastFiredAt = overrides.updateJobLastFiredAt ?? vi.fn();
  const appConfig = { get: appConfigGet } as unknown as AppConfigService;
  const adapter = { writeLastResult, upsertJob } as unknown as ConsolidationPersistenceAdapter;
  const engine = { updateJobLastFiredAt } as unknown as SchedulerEngine;
  const deps: ConsolidationJobHandlerDeps = {
    appConfig,
    pluginManager: {} as ConsolidationJobHandlerDeps['pluginManager'],
    agentManager: {} as ConsolidationJobHandlerDeps['agentManager'],
    sessionStore: {} as ConsolidationJobHandlerDeps['sessionStore'],
    dataDir: '/tmp/fake-data-dir',
    adapter,
    engine,
  };
  return { deps, writeLastResult, upsertJob, updateJobLastFiredAt, appConfigGet };
}

beforeEach(() => {
  mockRunner.mockReset();
});

describe('ConsolidationJobHandler.fire', () => {
  it('H1: job.type !== "consolidation" → 立即 return，零副作用', async () => {
    const { deps, writeLastResult, updateJobLastFiredAt } = mkDeps();
    const handler = new ConsolidationJobHandler(deps);
    await handler.fire(mkJob({ type: 'cron' }), FIXED_NOW);
    expect(mockRunner).not.toHaveBeenCalled();
    expect(writeLastResult).not.toHaveBeenCalled();
    expect(updateJobLastFiredAt).not.toHaveBeenCalled();
  });

  it('H2: gate1（appConfig.get 抛异常）→ 不推进 lastFiredAt、不调 runner', async () => {
    const appConfigGet = vi.fn(() => {
      throw new Error('kv store corrupted');
    });
    const { deps, writeLastResult, updateJobLastFiredAt, upsertJob } = mkDeps({ appConfigGet });
    const handler = new ConsolidationJobHandler(deps);
    await handler.fire(mkJob(), FIXED_NOW);
    expect(mockRunner).not.toHaveBeenCalled();
    expect(writeLastResult).not.toHaveBeenCalled();
    expect(updateJobLastFiredAt).not.toHaveBeenCalled();
    expect(upsertJob).not.toHaveBeenCalled();
  });

  it('H3: 正常路径 → 调 runner 一次 → 写 lastResult → 推进 lastFiredAt + upsertJob', async () => {
    mockRunner.mockResolvedValue({
      globalSkill: { action: 'merged', detail: 'x' },
      globalMemory: null,
      sessions: [],
      summary: '全局 skill 归档 1 条',
      skippedReason: null,
    });
    const { deps, writeLastResult, updateJobLastFiredAt, upsertJob } = mkDeps();
    const handler = new ConsolidationJobHandler(deps);
    const job = mkJob();
    await handler.fire(job, FIXED_NOW);

    expect(mockRunner).toHaveBeenCalledTimes(1);
    expect(writeLastResult).toHaveBeenCalledWith({
      lastRunAt: FIXED_NOW.toISOString(),
      summary: '全局 skill 归档 1 条',
    });
    expect(updateJobLastFiredAt).toHaveBeenCalledWith(job.id, FIXED_NOW.toISOString());
    expect(upsertJob).toHaveBeenCalledWith(job.owner, { ...job, lastFiredAt: FIXED_NOW.toISOString() });
  });

  it('H4a: job.lastFiredAt=null → runner 调用 args 不含 windowStart', async () => {
    mockRunner.mockResolvedValue({
      globalSkill: null, globalMemory: null, sessions: [], summary: 's', skippedReason: null,
    });
    const { deps } = mkDeps();
    const handler = new ConsolidationJobHandler(deps);
    await handler.fire(mkJob({ lastFiredAt: null }), FIXED_NOW);
    const callArgs = mockRunner.mock.calls[0]![0] as Record<string, unknown>;
    expect('windowStart' in callArgs).toBe(false);
  });

  it('H4b: job.lastFiredAt 非 null → 原样转发给 runner 的 windowStart', async () => {
    mockRunner.mockResolvedValue({
      globalSkill: null, globalMemory: null, sessions: [], summary: 's', skippedReason: null,
    });
    const { deps } = mkDeps();
    const handler = new ConsolidationJobHandler(deps);
    const lastFiredAt = '2026-07-14T04:00:00.000Z';
    await handler.fire(mkJob({ lastFiredAt }), FIXED_NOW);
    const callArgs = mockRunner.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArgs['windowStart']).toBe(lastFiredAt);
  });

  it('H5: runner 抛异常（理论罕见）——仍推进 lastFiredAt，不写 lastResult', async () => {
    mockRunner.mockRejectedValue(new Error('boom'));
    const { deps, writeLastResult, updateJobLastFiredAt, upsertJob } = mkDeps();
    const handler = new ConsolidationJobHandler(deps);
    const job = mkJob();
    await handler.fire(job, FIXED_NOW);
    expect(writeLastResult).not.toHaveBeenCalled();
    expect(updateJobLastFiredAt).toHaveBeenCalledWith(job.id, FIXED_NOW.toISOString());
    expect(upsertJob).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// [v0.0.164] AppTaskLock 接入 —— gate2 acquire 撞车保护 + markDone/markFailed 释放
// ============================================================

describe('ConsolidationJobHandler.fire — [v0.0.164] AppTaskLock gate2 接入', () => {
  it('L1: appTaskLock 缺省时走无 lock 路径（既有 UT 兼容 + 正常推进 lastFiredAt）', async () => {
    mockRunner.mockResolvedValue({
      globalSkill: null, globalMemory: null, sessions: [], summary: 's', skippedReason: null,
    });
    const { deps, writeLastResult, updateJobLastFiredAt } = mkDeps();
    // 不注入 appTaskLock（deps.appTaskLock undefined）
    const handler = new ConsolidationJobHandler(deps);
    await handler.fire(mkJob(), FIXED_NOW);

    expect(mockRunner).toHaveBeenCalledTimes(1);
    expect(writeLastResult).toHaveBeenCalledTimes(1);
    expect(updateJobLastFiredAt).toHaveBeenCalledTimes(1);
  });

  it('L2: appTaskLock 提供 + acquire 成功 → 正常 fire + markDone + 推进 lastFiredAt', async () => {
    mockRunner.mockResolvedValue({
      globalSkill: null, globalMemory: null, sessions: [], summary: 's', skippedReason: null,
    });
    const appTaskLock = new AppTaskLock();
    const { deps, updateJobLastFiredAt, upsertJob } = mkDeps();
    const handler = new ConsolidationJobHandler({ ...deps, appTaskLock });
    await handler.fire(mkJob(), FIXED_NOW);

    expect(mockRunner).toHaveBeenCalledTimes(1);
    expect(updateJobLastFiredAt).toHaveBeenCalledTimes(1);
    expect(upsertJob).toHaveBeenCalledTimes(1);
    // 成功路径应 markDone（running → done）
    expect(appTaskLock.getState(CONSOLIDATION_TASK_TYPE).status).toBe('done');
  });

  it('L3: appTaskLock 已 running（撞车）→ acquire 失败 → 静默跳过 + 不推进 lastFiredAt + 不 spawn runner', async () => {
    const appTaskLock = new AppTaskLock();
    // 模拟"手动 POST 正在跑"：预先 acquire 占住锁
    appTaskLock.acquire(CONSOLIDATION_TASK_TYPE, 'manual:xyz');

    const { deps, writeLastResult, updateJobLastFiredAt, upsertJob } = mkDeps();
    const handler = new ConsolidationJobHandler({ ...deps, appTaskLock });
    await handler.fire(mkJob(), FIXED_NOW);

    // 静默跳过：runner 不调、lastFiredAt 不推进、锁状态不变（仍是 manual:xyz 在跑）
    expect(mockRunner).not.toHaveBeenCalled();
    expect(writeLastResult).not.toHaveBeenCalled();
    expect(updateJobLastFiredAt).not.toHaveBeenCalled();
    expect(upsertJob).not.toHaveBeenCalled();
    expect(appTaskLock.getState(CONSOLIDATION_TASK_TYPE).runId).toBe('manual:xyz');
  });

  it('L4: appTaskLock 提供 + runner 抛错 → markFailed 释放锁 + 仍推进 lastFiredAt', async () => {
    mockRunner.mockRejectedValue(new Error('runner boom'));
    const appTaskLock = new AppTaskLock();
    const { deps, updateJobLastFiredAt } = mkDeps();
    const handler = new ConsolidationJobHandler({ ...deps, appTaskLock });
    await handler.fire(mkJob(), FIXED_NOW);

    // "到点必执行一次" 语义：lastFiredAt 推进（不算漏跑）
    expect(updateJobLastFiredAt).toHaveBeenCalledTimes(1);
    // 锁必须释放（否则永远撞车）
    expect(appTaskLock.getState(CONSOLIDATION_TASK_TYPE).status).toBe('failed');
    expect(appTaskLock.getState(CONSOLIDATION_TASK_TYPE).error).toBe('runner boom');
  });

  it('L5: cron runId 形态 = "cron:<iso>"（观测契约，区分手动 "manual:<ulid>"）', async () => {
    mockRunner.mockResolvedValue({
      globalSkill: null, globalMemory: null, sessions: [], summary: 's', skippedReason: null,
    });
    // 用 spy 观察 acquire 收到的 runId
    const appTaskLock = new AppTaskLock();
    const acquireSpy = vi.spyOn(appTaskLock, 'acquire');
    const { deps } = mkDeps();
    const handler = new ConsolidationJobHandler({ ...deps, appTaskLock });
    await handler.fire(mkJob(), FIXED_NOW);

    expect(acquireSpy).toHaveBeenCalledWith(CONSOLIDATION_TASK_TYPE, 'cron:' + FIXED_NOW.toISOString());
  });

  it('L6: gate1 fail（appConfig 抛错）时 lock 不被 acquire（gate 顺序 = gate1 → gate2）', async () => {
    const appConfigGet = vi.fn(() => {
      throw new Error('kv corrupted');
    });
    const appTaskLock = new AppTaskLock();
    const acquireSpy = vi.spyOn(appTaskLock, 'acquire');
    const { deps } = mkDeps({ appConfigGet });
    const handler = new ConsolidationJobHandler({ ...deps, appTaskLock });
    await handler.fire(mkJob(), FIXED_NOW);

    // gate1 fail → return，gate2 acquire 根本不调（避免锁被占但配置读失败留 running）
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(appTaskLock.getState(CONSOLIDATION_TASK_TYPE).status).toBe('idle');
  });
});
