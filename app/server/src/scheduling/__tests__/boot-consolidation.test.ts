/**
 * bootScheduler —— consolidation job 装配 UT（v0.0.151.t2_consolidate 新增第 6 步）。
 * 参考: specs/tech/scheduling/[P1]consolidation_job.md §3（boot 装配语义）
 *       task.json v0.0.151.t2_consolidate Task2 acceptanceCriteria
 *
 * 覆盖：
 *   C1: enabled=true → registry.has('consolidation') + engine 内注册 job（id='consolidation:app'）
 *   C2: enabled!=true（含 record 缺失）→ 不注册 job（registry/engine 均无）
 *   C3: consolidationAdapter 无条件返回（即便 enabled=false，仍可用于 test-only 端点/状态端点）
 *   C4: 缺 appConfig/pluginManager/dataDir（可选字段未传）→ 优雅跳过，不影响 heartbeat/cron 正常装配
 *   C5: 重启续接——第二次 bootScheduler 复用同一 tmpRoot 时，job 的 lastFiredAt 沿用上次持久化值
 *
 * 只验证注册结果（不调 handler.fire，fire 语义由 consolidation-handler.test.ts 独立覆盖）。
 * 文件系统隔离：os.tmpdir + mkdtempSync + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootScheduler, createEngine, type BootSchedulerDeps } from '../boot';
import { AppConfigService } from '../../config/app-config-service';
import { SquadStore, MemberStore } from '../../stores/squad-store';
import { SquadRuntime, makeGetUsageTotalTokens } from '../../squad/squad-runtime';
import { BudgetAggregator } from '../../squad/budget/budget-aggregator';
import { BudgetState } from '../../squad/budget-state';
import type { SessionStore } from '../../agent/session-store';
import type { AgentManagerImpl } from '../../agent/agent-manager';
import type { PluginManager } from '../../plugin/plugin-manager';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'boot-consolidation-'));
  globalThis.__schedulerEngineShutdownTrapRegistered = undefined;
  globalThis.__squadRuntimeShutdownTrapRegistered = undefined;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 空 sessionStore（heartbeat/cron 双源均无内容，专注 consolidation 装配） */
function makeEmptySessionStore(): SessionStore {
  return {
    getSession: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
    set onSessionDestroyed(_fn: unknown) {},
    get onSessionDestroyed() { return undefined; },
  } as unknown as SessionStore;
}

/** 构造 bootScheduler 最小 deps（squadStore/memberStore 真实空实例；agentManager mock） */
async function makeDeps(opts: {
  appConfig?: AppConfigService;
  pluginManager?: PluginManager;
  dataDir?: string;
}): Promise<BootSchedulerDeps> {
  const squadStore = new SquadStore({ root: tmpRoot });
  const memberStore = new MemberStore({ root: tmpRoot });
  const sessionStore = makeEmptySessionStore();
  const agentManager = { isSessionBusy: vi.fn(async () => false), deliverTo: vi.fn(async () => ({})) } as unknown as AgentManagerImpl;
  const budgetState = new BudgetState(tmpRoot);
  const budgetAggregator = new BudgetAggregator({
    squadStore, memberStore,
    getUsageTotalTokens: makeGetUsageTotalTokens(sessionStore, budgetState),
  });
  const { engine, registry, cronStore } = createEngine(tmpRoot, sessionStore);
  const squadRuntime = new SquadRuntime({
    root: tmpRoot, squadStore, memberStore, sessionStore, agentManager, engine,
  });
  return {
    engine, registry, cronStore, squadRuntime, squadStore, sessionStore, agentManager, budgetAggregator,
    setInterval: vi.fn(() => 0 as unknown as ReturnType<typeof setInterval>),
    clearInterval: vi.fn(),
    ...(opts.appConfig ? { appConfig: opts.appConfig } : {}),
    ...(opts.pluginManager ? { pluginManager: opts.pluginManager } : {}),
    ...(opts.dataDir !== undefined ? { dataDir: opts.dataDir } : {}),
  };
}

describe('bootScheduler — consolidation job 装配', () => {
  it('C1: enabled=true → registry + engine 均注册 consolidation job', async () => {
    const appConfig = new AppConfigService({ root: tmpRoot });
    appConfig.set('consolidation', 'default', { enabled: true, dailyTime: '04:00', modelId: 'm1' });
    const deps = await makeDeps({ appConfig, pluginManager: {} as PluginManager, dataDir: tmpRoot });
    const result = await bootScheduler(deps);
    const registryInternal = deps.registry as unknown as { handlers: Map<string, unknown> };
    expect(registryInternal.handlers.has('consolidation')).toBe(true);
    expect(deps.engine.has('consolidation:app')).toBe(true);
    const job = deps.engine.getJob('consolidation:app');
    expect(job?.schedule).toEqual({ kind: 'cron', expr: '0 4 * * *', tz: expect.any(String) });
    expect(result.consolidationAdapter).toBeDefined();
    deps.engine.stop();
  });

  it('C2: enabled!=true（record 缺失）→ 不注册 job', async () => {
    const appConfig = new AppConfigService({ root: tmpRoot });
    // 不 set consolidation group（record 缺失，视为 enabled=false）
    const deps = await makeDeps({ appConfig, pluginManager: {} as PluginManager, dataDir: tmpRoot });
    await bootScheduler(deps);
    const registryInternal = deps.registry as unknown as { handlers: Map<string, unknown> };
    expect(registryInternal.handlers.has('consolidation')).toBe(false);
    expect(deps.engine.has('consolidation:app')).toBe(false);
    deps.engine.stop();
  });

  it('C2b: enabled=false 显式 → 不注册 job', async () => {
    const appConfig = new AppConfigService({ root: tmpRoot });
    appConfig.set('consolidation', 'default', { enabled: false, dailyTime: '04:00' });
    const deps = await makeDeps({ appConfig, pluginManager: {} as PluginManager, dataDir: tmpRoot });
    await bootScheduler(deps);
    expect(deps.engine.has('consolidation:app')).toBe(false);
    deps.engine.stop();
  });

  it('C3: consolidationAdapter 无条件返回（即便 enabled=false）', async () => {
    const appConfig = new AppConfigService({ root: tmpRoot });
    appConfig.set('consolidation', 'default', { enabled: false, dailyTime: '04:00' });
    const deps = await makeDeps({ appConfig, pluginManager: {} as PluginManager, dataDir: tmpRoot });
    const result = await bootScheduler(deps);
    expect(result.consolidationAdapter).toBeDefined();
    deps.engine.stop();
  });

  it('C4: 缺 appConfig/pluginManager/dataDir（可选字段未传）→ 优雅跳过，不影响 boot 主流程', async () => {
    const deps = await makeDeps({});
    const result = await bootScheduler(deps);
    expect(deps.engine.getRunState()).toBe('running');
    expect(deps.engine.has('consolidation:app')).toBe(false);
    expect(result.consolidationAdapter).toBeUndefined();
    deps.engine.stop();
  });

  it('C5: 重启续接——第二次 bootScheduler 复用 lastFiredAt', async () => {
    const appConfig = new AppConfigService({ root: tmpRoot });
    appConfig.set('consolidation', 'default', { enabled: true, dailyTime: '04:00', modelId: 'm1' });
    const deps1 = await makeDeps({ appConfig, pluginManager: {} as PluginManager, dataDir: tmpRoot });
    const result1 = await bootScheduler(deps1);
    // 模拟一次真实 fire 后持久化 lastFiredAt（不经 handler.fire，直接调 adapter 落盘模拟）
    const firedAt = '2026-07-15T04:00:03.000Z';
    await result1.consolidationAdapter!.upsertJob('app', {
      ...deps1.engine.getJob('consolidation:app')!,
      lastFiredAt: firedAt,
    });
    deps1.engine.stop();

    // 第二次 boot（新 engine/registry，同 tmpRoot）
    const deps2 = await makeDeps({ appConfig, pluginManager: {} as PluginManager, dataDir: tmpRoot });
    await bootScheduler(deps2);
    const job2 = deps2.engine.getJob('consolidation:app');
    expect(job2?.lastFiredAt).toBe(firedAt);
    deps2.engine.stop();
  });
});
