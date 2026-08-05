/**
 * bootScheduler 集成 UT — T6 装配 SchedulerEngine（heartbeat + cron handler 注册 + 双源 loadJobs + start + SIGTERM + onSessionDestroyed wire）。
 * 参考: specs/tech/scheduling/[P0]engine.md §6（重启续接 boot loader 伪码）
 *       specs/tech/scheduling/[P1]cron_subsystem.md §8（session 销毁 hook wiring）
 *       task.json T6 acceptanceCriteria §2/§3
 *
 * 覆盖（task.json T6 acceptanceCriteria）：
 *   B1: bootScheduler 后 engine.runState='running'
 *   B2: 两 type handler 注册（registry.has('heartbeat') && registry.has('cron')）
 *   B3: 双源 jobs 装载（heartbeat 源 via squadRuntime.startAll；cron 源 via sessionStore.listSessions）
 *   B4: SIGTERM trap 触发 engine.stop()
 *   B5: sessionStore.onSessionDestroyed 触发 cronStore.removeAllJobs + engine.unregister 该 session 全部 cron job
 *   B6: shutdown() 调 engine.stop + clearInterval budget refresh
 *   B7: cronToolDeps 形态完整（cronStore + engine + sessionStore + squadStore）
 *   B8: createEngine 独立产出 engine + registry + cronStore（two-phase init 入口）
 *
 * 文件系统隔离：用 os.tmpdir + mkdtempSync + afterEach 清理。
 *
 * 集成形态：squadRuntime + sessionStore + agentManager 用真实/部分 mock；engine/cronStore 真实实例；
 *   setInterval/clearInterval 注入 mock（避免真实 timer 干扰）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootScheduler,
  createEngine,
  type BootSchedulerDeps,
} from '../boot';
import { CronPersistenceAdapter } from '../persistence/cron-adapter';
import { SchedulerEngine } from '../engine';
import { JobHandlerRegistry } from '../registry';
import { SquadRuntime } from '../../squad/squad-runtime';
import { BudgetAggregator } from '../../squad/budget/budget-aggregator';
import { BudgetState } from '../../squad/budget-state';
import { SquadStore, MemberStore } from '../../stores/squad-store';
import { atomicWriteSync } from '../../persistence/fs-io';
import { makeGetUsageTotalTokens } from '../../squad/squad-budget-wiring';
import { ulid } from '../../config/ulid';
import type { SquadEntity, MemberEntity } from '../../stores/squad-store';
import type { SessionStore } from '../../agent/session-store';
import type { AgentManagerImpl } from '../../agent/agent-manager';

let tmpRoot: string;

/** 测试用 ULID（squad store schema 要求合法 ULID 格式；占位 'SQ-1' 会 fail validation） */
function newUlid(): string {
  return ulid();
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'boot-scheduler-'));
  // 重置 trap flag（避免跨测试污染）
  globalThis.__schedulerEngineShutdownTrapRegistered = undefined;
  globalThis.__squadRuntimeShutdownTrapRegistered = undefined;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── fixture helpers ──────────────────────────────────────────────────

function makeSquad(opts: {
  id?: string;
  leaderId?: string;
  enableHeartBeat?: boolean;
  budget?: { limit: number; window: 'daily'; scope: 'team' } | null;
  timezone?: string;
}): SquadEntity {
  const leaderId = opts.leaderId ?? newUlid();
  return {
    id: opts.id ?? newUlid(),
    name: 'alpha',
    description: '',
    modelDefault: 'm1',
    leaderId,
    memberIds: [leaderId],
    squadChatSessionId: newUlid(),
    charter: { goals: '', workingStyle: '', collaboration: '', escalation: '' },
    budget: opts.budget ?? null,
    enableHeartBeat: opts.enableHeartBeat ?? false,
    timezone: opts.timezone ?? 'UTC',
  } as unknown as SquadEntity;
}

function makeMember(opts: {
  id: string;
  squadId?: string;
  sessionId?: string;
  role?: 'leader' | 'mate';
  heartbeat?: { activeWindow: { start: string; end: string }; interval: number } | null;
}): MemberEntity {
  return {
    id: opts.id,
    squadId: opts.squadId ?? newUlid(),
    // sessionId 字段 schema 要求 ULID 格式（putMember validation）
    sessionId: opts.sessionId ?? newUlid(),
    name: opts.id,
    role: opts.role ?? 'mate',
    tools: [],
    // [v0.0.113] skillConfig 取代旧 skills 白名单（overlay 快照；schema required）
    skillConfig: { mode: 'inherit', overrides: {} },
    model: 'm1',
    state: 'deployed',
    heartbeat: opts.heartbeat ?? null,
  } as unknown as MemberEntity;
}

/** mock SessionStore：listSessions 返预置 session ids；其他方法 vi.fn 占位 */
function makeMockSessionStore(opts: {
  sessionIds?: string[];
  sessionSquadIds?: Record<string, string | null>;
  usageTokens?: number;
}): {
  sessionStore: SessionStore;
  onSessionDestroyedSetter: { value: ((sid: string) => Promise<void>) | undefined };
  getSession: ReturnType<typeof vi.fn>;
  listSessions: ReturnType<typeof vi.fn>;
  getUsageView: ReturnType<typeof vi.fn>;
} {
  const sessionIds = opts.sessionIds ?? [];
  const squadIdMap = opts.sessionSquadIds ?? {};
  const onSessionDestroyedHolder: { value: ((sid: string) => Promise<void>) | undefined } = { value: undefined };
  const getSession = vi.fn(async (sid: string) => {
    if (!sessionIds.includes(sid)) return null;
    return {
      id: sid,
      squadId: squadIdMap[sid] ?? null,
      state: 'idle',
      biz: 'playground',
      role: 'rocky',
      derivation: 'parent',
    };
  });
  const listSessions = vi.fn(async () =>
    sessionIds.map((id) => ({
      id,
      squadId: squadIdMap[id] ?? null,
      state: 'idle',
      biz: 'playground',
      role: 'rocky',
      derivation: 'parent',
      updatedAt: '2026-07-01T00:00:00.000Z',
    })),
  );
  const getUsageView = vi.fn(async () => ({
    total: { total_tokens: opts.usageTokens ?? 0 },
  }));
  const sessionStore = {
    getSession,
    listSessions,
    getUsageView,
    // onSessionDestroyed 是 setter 注入点（bootScheduler 写入）
    set onSessionDestroyed(fn: ((sid: string) => Promise<void>) | undefined) {
      onSessionDestroyedHolder.value = fn;
    },
    get onSessionDestroyed(): ((sid: string) => Promise<void>) | undefined {
      return onSessionDestroyedHolder.value;
    },
  } as unknown as SessionStore;
  return { sessionStore, onSessionDestroyedSetter: onSessionDestroyedHolder, getSession, listSessions, getUsageView };
}

/** mock AgentManager：isSessionBusy + deliverTo + getUsageTotalTokens 透传 */
function makeMockAgentManager(): {
  agentManager: AgentManagerImpl;
  isSessionBusy: ReturnType<typeof vi.fn>;
  deliverTo: ReturnType<typeof vi.fn>;
} {
  const isSessionBusy = vi.fn(async () => false);
  const deliverTo = vi.fn(async () => ({}));
  const agentManager = { isSessionBusy, deliverTo } as unknown as AgentManagerImpl;
  return { agentManager, isSessionBusy, deliverTo };
}

/** 预置 cron.json 到 {tmpRoot}/sessions/{sid}/cron.json */
function seedCronJson(sessionId: string, entries: Array<{
  id: string;
  cron: string;
  tz: string;
  name: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  lastFiredAt: string | null;
}>): void {
  const dir = join(tmpRoot, 'sessions', sessionId);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, 'cron.json');
  atomicWriteSync(filePath, JSON.stringify({ version: 1, sessionId, jobs: entries }, null, 2));
}

/** 构造完整 bootScheduler deps（real squadRuntime + mock sessionStore/agentManager + 注入 setInterval/clearInterval mock） */
async function makeBootDeps(opts: {
  squads?: SquadEntity[];
  members?: MemberEntity[];
  sessionIds?: string[];
  sessionSquadIds?: Record<string, string | null>;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}): Promise<{
  engine: SchedulerEngine;
  registry: JobHandlerRegistry;
  cronStore: CronPersistenceAdapter;
  squadRuntime: SquadRuntime;
  sessionStore: SessionStore;
  agentManager: AgentManagerImpl;
  budgetAggregator: BudgetAggregator;
  squadStore: SquadStore;
  onSessionDestroyedSetter: { value: ((sid: string) => Promise<void>) | undefined };
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}> {
  // 真实 squad store（写到 tmpRoot/squads/）
  const squadStore = new SquadStore({ root: tmpRoot });
  const memberStore = new MemberStore({ root: tmpRoot });
  for (const s of opts.squads ?? []) {
    // 剥 store-managed 字段（createdAt/updatedAt/version 由 store 注入）
    const rec = s as unknown as Record<string, unknown>;
    const { createdAt, updatedAt, version, ...squadRec } = rec;
    await squadStore.putSquad(squadRec as unknown as SquadEntity);
  }
  for (const m of opts.members ?? []) {
    await memberStore.putMember(m);
  }

  // 真实 budget state + aggregator + getUsageTotalTokens wiring
  const budgetState = new BudgetState(tmpRoot);
  const { sessionStore, onSessionDestroyedSetter } = makeMockSessionStore({
    sessionIds: opts.sessionIds,
    sessionSquadIds: opts.sessionSquadIds,
  });
  const budgetAggregator = new BudgetAggregator({
    squadStore,
    memberStore,
    getUsageTotalTokens: makeGetUsageTotalTokens(
      sessionStore as unknown as Parameters<typeof makeGetUsageTotalTokens>[0],
      budgetState,
    ),
  });

  // mock agentManager + setInterval/clearInterval（先建，squadRuntime 复用同一实例）
  const { agentManager } = makeMockAgentManager();
  const setIntervalMock = opts.setInterval ?? vi.fn(() => 0 as unknown as ReturnType<typeof setInterval>);
  const clearIntervalMock = opts.clearInterval ?? vi.fn();

  // two-phase init：先 createEngine，再 squadRuntime 持 engine ref（agentManager 复用上面同一实例）
  const { engine, registry, cronStore } = createEngine(tmpRoot, sessionStore);
  const squadRuntime = new SquadRuntime({
    root: tmpRoot,
    squadStore,
    memberStore,
    sessionStore,
    agentManager,
    engine,
  });

  return {
    engine,
    registry,
    cronStore,
    squadRuntime,
    sessionStore,
    agentManager,
    budgetAggregator,
    squadStore,
    onSessionDestroyedSetter,
    setInterval: setIntervalMock,
    clearInterval: clearIntervalMock,
  };
}

// ============================================================
// B8: createEngine 独立产出（two-phase init 入口）
// ============================================================

describe('B8: createEngine —— two-phase init 入口', () => {
  it('返 engine + registry + cronStore 三组件', () => {
    const fakeStore = { getSession: vi.fn(async () => null) } as unknown as SessionStore;
    const r = createEngine(tmpRoot, fakeStore);
    expect(r.engine).toBeInstanceOf(SchedulerEngine);
    expect(r.registry).toBeInstanceOf(JobHandlerRegistry);
    expect(r.cronStore).toBeInstanceOf(CronPersistenceAdapter);
  });

  it('engine.runState="stopped"（不 start；bootScheduler 内 start）', () => {
    const fakeStore = { getSession: vi.fn(async () => null) } as unknown as SessionStore;
    const r = createEngine(tmpRoot, fakeStore);
    expect(r.engine.getRunState()).toBe('stopped');
  });
});

// ============================================================
// B1-B7: bootScheduler 主流程
// ============================================================

describe('bootScheduler 主流程（B1-B7）', () => {
  it('B1: bootScheduler 后 engine.runState="running"', async () => {
    const sqId = newUlid();
    const mId = newUlid();
    const sessId = newUlid();
    const d = await makeBootDeps({
      squads: [makeSquad({ id: sqId, leaderId: mId, enableHeartBeat: true })],
      members: [makeMember({ id: mId, squadId: sqId, sessionId: sessId, heartbeat: { activeWindow: { start: '00:00', end: '23:59' }, interval: 60_000 } })],
    });
    await bootScheduler({
      engine: d.engine, registry: d.registry, cronStore: d.cronStore,
      squadRuntime: d.squadRuntime, squadStore: d.squadStore, sessionStore: d.sessionStore,
      agentManager: d.agentManager, budgetAggregator: d.budgetAggregator,
      setInterval: d.setInterval, clearInterval: d.clearInterval,
    });
    expect(d.engine.getRunState()).toBe('running');
    d.engine.stop();
  });

  it('B2: 两 type handler 注册（registry.has("heartbeat") && registry.has("cron")）', async () => {
    const d = await makeBootDeps({});
    // registry 持有在 createEngine 里；bootScheduler 通过引用注册
    // registry 不直接暴露 has；通过 engine.tick 验证（type 缺 handler 静默跳过）
    // 改为白盒：cast registry 读 internal map
    await bootScheduler({
      engine: d.engine, registry: d.registry, cronStore: d.cronStore,
      squadRuntime: d.squadRuntime, squadStore: d.squadStore, sessionStore: d.sessionStore,
      agentManager: d.agentManager, budgetAggregator: d.budgetAggregator,
      setInterval: d.setInterval, clearInterval: d.clearInterval,
    });
    const registryInternal = d.registry as unknown as { handlers: Map<string, unknown> };
    expect(registryInternal.handlers.has('heartbeat')).toBe(true);
    expect(registryInternal.handlers.has('cron')).toBe(true);
    d.engine.stop();
  });

  it('B3a: heartbeat 双源 — squadRuntime.startAll 触发 engine.register heartbeat job', async () => {
    const sqId = newUlid();
    const mId = newUlid();
    const sessId = newUlid();
    const d = await makeBootDeps({
      squads: [makeSquad({ id: sqId, leaderId: mId, enableHeartBeat: true })],
      members: [makeMember({
        id: mId, squadId: sqId, sessionId: sessId,
        heartbeat: { activeWindow: { start: '00:00', end: '23:59' }, interval: 60_000 },
      })],
    });
    await bootScheduler({
      engine: d.engine, registry: d.registry, cronStore: d.cronStore,
      squadRuntime: d.squadRuntime, squadStore: d.squadStore, sessionStore: d.sessionStore,
      agentManager: d.agentManager, budgetAggregator: d.budgetAggregator,
      setInterval: d.setInterval, clearInterval: d.clearInterval,
    });
    // [v0.0.116 最小适配] job.id 改为 squad 级（去 memberId）；task5 重写
    expect(d.engine.has(`heartbeat:${sqId}`)).toBe(true);
    d.engine.stop();
  });

  it('B3b: cron 双源 — sessionStore.listSessions → cronStore.loadJobs per session → engine.register', async () => {
    // 预置 cron.json 给 SID-CRON1
    seedCronJson('SID-CRON1', [{
      id: 'cron-001', cron: '*/5 * * * *', tz: 'UTC',
      name: 'check', prompt: 'look', enabled: true,
      createdAt: '2026-07-01T00:00:00.000Z', lastFiredAt: null,
    }]);
    const d = await makeBootDeps({
      sessionIds: ['SID-CRON1', 'SID-EMPTY'],
    });
    await bootScheduler({
      engine: d.engine, registry: d.registry, cronStore: d.cronStore,
      squadRuntime: d.squadRuntime, squadStore: d.squadStore, sessionStore: d.sessionStore,
      agentManager: d.agentManager, budgetAggregator: d.budgetAggregator,
      setInterval: d.setInterval, clearInterval: d.clearInterval,
    });
    expect(d.engine.has('cron:SID-CRON1:cron-001')).toBe(true);
    d.engine.stop();
  });

  it('B4: SIGTERM trap 触发 engine.stop（shutdown() 调 engine.stop）', async () => {
    const d = await makeBootDeps({});
    const result = await bootScheduler({
      engine: d.engine, registry: d.registry, cronStore: d.cronStore,
      squadRuntime: d.squadRuntime, squadStore: d.squadStore, sessionStore: d.sessionStore,
      agentManager: d.agentManager, budgetAggregator: d.budgetAggregator,
      setInterval: d.setInterval, clearInterval: d.clearInterval,
    });
    expect(d.engine.getRunState()).toBe('running');
    // 显式调 shutdown 验证（不实际 emit SIGTERM 防污染其他测试）
    result.shutdown();
    expect(d.engine.getRunState()).toBe('stopped');
  });

  it('B5: onSessionDestroyed wire — 触发 cron jobs engine.unregister + removeAllJobs', async () => {
    // 预置 cron.json + 双 cron job（同 session）
    seedCronJson('SID-DESTROY', [
      { id: 'c1', cron: '*/5 * * * *', tz: 'UTC', name: 'n1', prompt: 'p', enabled: true, createdAt: '2026-07-01T00:00:00.000Z', lastFiredAt: null },
      { id: 'c2', cron: '0 * * * *', tz: 'UTC', name: 'n2', prompt: 'p', enabled: true, createdAt: '2026-07-01T00:00:00.000Z', lastFiredAt: null },
    ]);
    const d = await makeBootDeps({ sessionIds: ['SID-DESTROY'] });
    await bootScheduler({
      engine: d.engine, registry: d.registry, cronStore: d.cronStore,
      squadRuntime: d.squadRuntime, squadStore: d.squadStore, sessionStore: d.sessionStore,
      agentManager: d.agentManager, budgetAggregator: d.budgetAggregator,
      setInterval: d.setInterval, clearInterval: d.clearInterval,
    });
    // boot 后两 cron job 在 engine
    expect(d.engine.has('cron:SID-DESTROY:c1')).toBe(true);
    expect(d.engine.has('cron:SID-DESTROY:c2')).toBe(true);
    // 触发 onSessionDestroyed hook
    const hook = d.onSessionDestroyedSetter.value;
    expect(hook).toBeDefined();
    await hook!('SID-DESTROY');
    // engine 内 cron job 全部注销
    expect(d.engine.has('cron:SID-DESTROY:c1')).toBe(false);
    expect(d.engine.has('cron:SID-DESTROY:c2')).toBe(false);
    d.engine.stop();
  });

  it('B6: shutdown() 调 clearInterval（budget refresh handle 释放）', async () => {
    const d = await makeBootDeps({});
    const result = await bootScheduler({
      engine: d.engine, registry: d.registry, cronStore: d.cronStore,
      squadRuntime: d.squadRuntime, squadStore: d.squadStore, sessionStore: d.sessionStore,
      agentManager: d.agentManager, budgetAggregator: d.budgetAggregator,
      setInterval: d.setInterval, clearInterval: d.clearInterval,
    });
    result.shutdown();
    expect(d.clearInterval).toHaveBeenCalled();
  });

  it('B7: cronToolDeps 形态完整（cronStore + engine + sessionStore + squadStore 同实例）', async () => {
    const d = await makeBootDeps({});
    const result = await bootScheduler({
      engine: d.engine, registry: d.registry, cronStore: d.cronStore,
      squadRuntime: d.squadRuntime, squadStore: d.squadStore, sessionStore: d.sessionStore,
      agentManager: d.agentManager, budgetAggregator: d.budgetAggregator,
      setInterval: d.setInterval, clearInterval: d.clearInterval,
    });
    expect(result.cronToolDeps.cronStore).toBe(d.cronStore);
    expect(result.cronToolDeps.engine).toBe(d.engine);
    expect(result.cronToolDeps.sessionStore).toBe(d.sessionStore);
    expect(result.cronToolDeps.squadStore).toBe(d.squadStore);
    d.engine.stop();
  });
});
