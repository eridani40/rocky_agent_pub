/**
 * SquadRuntime UT — v0.0.58 T2 改造后：engine.register/unregister + 多 squad 隔离 + trap。
 * 参考: specs/tech/scheduling/[P1]heartbeat_handler.md §5（squad-runtime 改造点）
 *       specs/tech/squad/[P1]scheduler.md §9（多 squad 隔离）/ §10（trap 清理）
 *       states/v0.0.58.cron/verify/test-plan.md §5（heartbeat handler 迁移）
 *
 * 覆盖（task.json T2 acceptanceCriteria）：
 *   - ensureScheduler 改为 engine.register（mock engine，verify register called with heartbeat job schema）
 *   - ensureScheduler 幂等（多次调用只 register 一次）
 *   - 多 squad 隔离（不同 squadId 不同 job id 前缀）
 *   - startAll boot 恒注册（每个存在的 squad 都 ensure，不静态拦 enableHeartBeat；killswitch 走 handler gate0）
 *   - stopAll 不调 engine.stop()，只 unregister 本 squad 注册的 job
 *   - stopAll 清理 Set（幂等）
 *   - reloadSquad：已 ensure → unregister+register；未 ensure → ensure（squad 存在即 ensure）
 *   - registerShutdownTrap 幂等（global flag 防重复挂载）
 *   - makeGetUsageTotalTokens baseline-delta：保留 v0.0.33.4 行为不动（本测试不在 T2 范围内重测，
 *     仅断言 SquadRuntime 不破坏其导出）
 *
 * 文件系统隔离：用 os.tmpdir + mkdtempSync + afterEach 清理（不污染真实 .rocky/state）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SquadRuntime,
  makeGetUsageTotalTokens,
  type SquadRuntimeDeps,
} from '../squad-runtime';
import { BudgetState } from '../budget-state';
import { atomicWriteSync } from '../../persistence/fs-io';
import type { SquadEntity, MemberEntity } from '../../stores/squad-store';
import type { SchedulerEngine } from '../../scheduling/engine';
import type { Job } from '../../scheduling/types';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'squad-runtime-'));
  // 重置 trap flag（避免跨测试污染）
  globalThis.__squadRuntimeShutdownTrapRegistered = undefined;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── fixture helpers ──────────────────────────────────────────────

function makeSquad(opts: {
  id?: string;
  enableHeartBeat?: boolean;
  budget?: { limit: number; window: 'daily'; scope: 'team' } | null;
}): SquadEntity {
  return {
    id: opts.id ?? 'SQ-1',
    name: 'alpha',
    description: '',
    modelDefault: 'm1',
    leaderId: 'M-LEADER',
    memberIds: ['M-LEADER'],
    squadChatSessionId: 'SID-SC',
    charter: { goals: '', workingStyle: '', collaboration: '', escalation: '' },
    budget: opts.budget ?? null,
    enableHeartBeat: opts.enableHeartBeat ?? false,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    version: 1,
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
    squadId: opts.squadId ?? 'SQ-1',
    sessionId: opts.sessionId ?? `SID-${opts.id}`,
    name: opts.id,
    role: opts.role ?? 'mate',
    tools: [],
    skills: [],
    model: 'm1',
    state: 'deployed',
    heartbeat: opts.heartbeat ?? null,
  } as unknown as MemberEntity;
}

/** mock SchedulerEngine：spy register/unregister/getJob/updateJobLastFiredAt/stop/snapshot */
function makeMockEngine(): {
  engine: SchedulerEngine;
  register: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
  getJob: ReturnType<typeof vi.fn>;
  updateJobLastFiredAt: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
  jobs: Map<string, Job>;
} {
  const jobs = new Map<string, Job>();
  const register = vi.fn((job: Job) => { jobs.set(job.id, job); });
  const unregister = vi.fn((jid: string) => { jobs.delete(jid); });
  const getJob = vi.fn((jid: string) => jobs.get(jid));
  const updateJobLastFiredAt = vi.fn((jid: string, iso: string) => {
    const ex = jobs.get(jid);
    if (ex) jobs.set(jid, { ...ex, lastFiredAt: iso });
  });
  const stop = vi.fn(() => {});
  const snapshot = vi.fn(() => jobs);
  const engine = {
    register, unregister, getJob, updateJobLastFiredAt, stop, snapshot,
    start: vi.fn(() => {}),
    has: vi.fn((jid: string) => jobs.has(jid)),
    getRunState: vi.fn(() => 'running'),
  } as unknown as SchedulerEngine;
  return { engine, register, unregister, getJob, updateJobLastFiredAt, stop, snapshot, jobs };
}

/** 构造 SquadRuntime with mock deps + 可选 mock engine；squads/members 默认填充 */
function makeRuntime(opts: {
  squads?: SquadEntity[];
  members?: MemberEntity[];
  engine?: SchedulerEngine;
} = {}): SquadRuntime {
  const squads = opts.squads ?? [];
  const members = opts.members ?? [];
  const squadStore = {
    listSquads: vi.fn(async () => squads),
    getSquad: vi.fn(async (id: string) => squads.find((s) => s.id === id)),
  };
  const memberStore = {
    listMembers: vi.fn(async (sid: string) => members.filter((m) => m.squadId === sid)),
    getMember: vi.fn(async (sid: string, mid: string) =>
      members.find((m) => m.squadId === sid && m.id === mid)),
  };
  const deps: SquadRuntimeDeps = {
    root: tmpRoot,
    squadStore: squadStore as unknown as SquadRuntimeDeps['squadStore'],
    memberStore: memberStore as unknown as SquadRuntimeDeps['memberStore'],
    sessionStore: {
      getUsageView: vi.fn(async () => ({ total: { total_tokens: 0 } })),
      getSession: vi.fn(async () => undefined),
    } as unknown as SquadRuntimeDeps['sessionStore'],
    agentManager: {
      isSessionBusy: vi.fn(async () => false),
      deliverTo: vi.fn(async () => ({})),
    } as unknown as SquadRuntimeDeps['agentManager'],
    engine: opts.engine,
  };
  return new SquadRuntime(deps);
}

// ── registry / lifecycle ─────────────────────────────────────────

describe('SquadRuntime registry/lifecycle（engine.register 模式）', () => {
  it('ensureScheduler：mock engine register 被调（heartbeat job schema 正确）', async () => {
    const { engine, register } = makeMockEngine();
    const hb = { activeWindow: { start: '09:00', end: '18:00' }, interval: 60_000 };
    const rt = makeRuntime({
      squads: [makeSquad({ id: 'SQ-1', enableHeartBeat: true })],
      members: [makeMember({ id: 'M-1', squadId: 'SQ-1', sessionId: 'S-1', heartbeat: hb })],
      engine,
    });
    await rt.ensureScheduler('SQ-1');
    expect(register).toHaveBeenCalledTimes(1);
    const job = register.mock.calls[0]![0] as Job;
    // squad 级 job id/payload（heartbeat:{squadId}，payload={squadId}）
    expect(job.id).toBe('heartbeat:SQ-1');
    expect(job.type).toBe('heartbeat');
    expect(job.owner).toBe('SQ-1');
    expect((job.payload as { squadId: string }).squadId).toBe('SQ-1');
    expect(job.schedule.kind).toBe('interval');
    rt.stopAll();
  });

  it('ensureScheduler 幂等（多次调用只 register 一次）', async () => {
    const { engine, register } = makeMockEngine();
    const hb = { activeWindow: { start: '09:00', end: '18:00' }, interval: 60_000 };
    const rt = makeRuntime({
      squads: [makeSquad({ id: 'SQ-1', enableHeartBeat: true })],
      members: [makeMember({ id: 'M-1', squadId: 'SQ-1', sessionId: 'S-1', heartbeat: hb })],
      engine,
    });
    await rt.ensureScheduler('SQ-1');
    await rt.ensureScheduler('SQ-1');
    await rt.ensureScheduler('SQ-1');
    expect(register).toHaveBeenCalledTimes(1);
    rt.stopAll();
  });

  it('多 squad 隔离：不同 squadId 不同 job（前缀 heartbeat:<squadId>:）', async () => {
    const { engine, register } = makeMockEngine();
    const hb = { activeWindow: { start: '09:00', end: '18:00' }, interval: 60_000 };
    const rt = makeRuntime({
      squads: [
        makeSquad({ id: 'SQ-A', enableHeartBeat: true }),
        makeSquad({ id: 'SQ-B', enableHeartBeat: true }),
      ],
      members: [
        makeMember({ id: 'M-A', squadId: 'SQ-A', sessionId: 'S-A', heartbeat: hb }),
        makeMember({ id: 'M-B', squadId: 'SQ-B', sessionId: 'S-B', heartbeat: hb }),
      ],
      engine,
    });
    await rt.ensureScheduler('SQ-A');
    await rt.ensureScheduler('SQ-B');
    expect(register).toHaveBeenCalledTimes(2);
    const ids = register.mock.calls.map(c => (c[0] as Job).id);
    expect(ids).toContain('heartbeat:SQ-A');
    expect(ids).toContain('heartbeat:SQ-B');
    rt.stopAll();
  });

  it('startAll 恒注册：所有 squad（含 enableHeartBeat=false）都注册 heartbeat job', async () => {
    // [v0.0.116 架构裁决] enableHeartBeat 不在 startAll 静态拦——killswitch 走 handler gate0 动态判
    // 恒注册确保开关关时也有 skipped_killswitch history 记录，AT case heartbeat_trigger_gates_tc1 可验证
    const { engine, register } = makeMockEngine();
    const rt = makeRuntime({
      squads: [
        makeSquad({ id: 'SQ-ON', enableHeartBeat: true }),
        makeSquad({ id: 'SQ-OFF', enableHeartBeat: false }),
      ],
      members: [
        makeMember({ id: 'M-ON', squadId: 'SQ-ON', heartbeat: null }),
        makeMember({ id: 'M-OFF', squadId: 'SQ-OFF', heartbeat: null }),
      ],
      engine,
    });
    await rt.startAll();
    // 两个 squad 都注册（恒注册），共 2 个 squad 级 job
    expect(register).toHaveBeenCalledTimes(2);
    const jobIds = register.mock.calls.map(c => (c[0] as Job).id);
    expect(jobIds).toContain('heartbeat:SQ-ON');
    expect(jobIds).toContain('heartbeat:SQ-OFF');
    rt.stopAll();
  });

  it('stopAll：unregister 本 squad job + 不调 engine.stop()', async () => {
    const { engine, register, unregister, stop } = makeMockEngine();
    const hb = { activeWindow: { start: '09:00', end: '18:00' }, interval: 60_000 };
    const rt = makeRuntime({
      squads: [makeSquad({ id: 'SQ-1', enableHeartBeat: true })],
      members: [makeMember({ id: 'M-1', squadId: 'SQ-1', sessionId: 'S-1', heartbeat: hb })],
      engine,
    });
    await rt.ensureScheduler('SQ-1');
    const registeredId = register.mock.calls[0]![0].id;
    rt.stopAll();
    expect(unregister).toHaveBeenCalledWith(registeredId);
    // engine.stop 不应被 squad-runtime 调用（engine 是进程单例）
    expect(stop).not.toHaveBeenCalled();
    expect(rt.getScheduler('SQ-1')).toBeUndefined();
  });

  it('stopAll 幂等（多次调用不抛错）', async () => {
    const { engine } = makeMockEngine();
    const rt = makeRuntime({
      squads: [makeSquad({ id: 'SQ-1', enableHeartBeat: true })],
      engine,
    });
    await rt.ensureScheduler('SQ-1');
    rt.stopAll();
    expect(() => rt.stopAll()).not.toThrow();
  });

  it('reloadSquad：已 ensure → unregister + register（heartbeat 配置变更生效）', async () => {
    const { engine, register, unregister } = makeMockEngine();
    const hb1 = { activeWindow: { start: '09:00', end: '18:00' }, interval: 60_000 };
    const members = [makeMember({ id: 'M-1', squadId: 'SQ-1', sessionId: 'S-1', heartbeat: hb1 })];
    const rt = makeRuntime({
      squads: [makeSquad({ id: 'SQ-1', enableHeartBeat: true })],
      members,
      engine,
    });
    await rt.ensureScheduler('SQ-1');
    expect(register).toHaveBeenCalledTimes(1);
    // reloadSquad：unregister 旧 + register 新
    await rt.reloadSquad('SQ-1');
    expect(unregister).toHaveBeenCalledWith('heartbeat:SQ-1');
    expect(register).toHaveBeenCalledTimes(2);
    rt.stopAll();
  });

  it('reloadSquad：未 ensure → ensure（squad 存在即 ensure，不判 enableHeartBeat）', async () => {
    // [v0.0.116 架构裁决] 恒注册——enableHeartBeat=false 也建 job，killswitch 走 handler gate0
    const { engine, register } = makeMockEngine();
    const rt = makeRuntime({
      squads: [
        makeSquad({ id: 'SQ-ON', enableHeartBeat: true }),
        makeSquad({ id: 'SQ-OFF', enableHeartBeat: false }),
      ],
      engine,
    });
    expect(rt.getScheduler('SQ-ON')).toBeUndefined();
    expect(rt.getScheduler('SQ-OFF')).toBeUndefined();
    await rt.reloadSquad('SQ-ON');
    expect(rt.getScheduler('SQ-ON')).toBeDefined();
    await rt.reloadSquad('SQ-OFF');
    // enableHeartBeat=false 的 squad 也应被 ensure（恒注册）
    expect(rt.getScheduler('SQ-OFF')).toBeDefined();
    // 两个 squad 都注册 job（各 1 个 squad 级 job）
    expect(register).toHaveBeenCalledTimes(2);
    rt.stopAll();
  });

  // reloadRole 在 v0.0.116 已从 SchedulerFacade 移除（per-member → squad 级改造）。
  // reloadSquad 替代 per-member 变更生效入口，已有对应 case 覆盖。

  it('getScheduler 未 ensure 的 squad → undefined', async () => {
    const { engine } = makeMockEngine();
    const rt = makeRuntime({
      squads: [makeSquad({ id: 'SQ-1', enableHeartBeat: false })],
      engine,
    });
    expect(rt.getScheduler('SQ-1')).toBeUndefined();
  });
});

// ── engine 未注入（T2 阶段兼容；T6 接力前） ─────────────────────────

describe('engine 未注入（T2 阶段兼容）', () => {
  it('ensureScheduler 不抛错（engine 缺省时跳过 register）', async () => {
    // 不传 engine
    const rt = makeRuntime({
      squads: [makeSquad({ id: 'SQ-1', enableHeartBeat: true })],
    });
    await expect(rt.ensureScheduler('SQ-1')).resolves.toBeUndefined();
    expect(rt.getScheduler('SQ-1')).toBeDefined();
    rt.stopAll();
  });
});

// ── shutdown trap ────────────────────────────────────────────────

describe('SquadRuntime shutdown trap', () => {
  it('registerShutdownTrap 幂等（global flag 防重复挂载）', () => {
    const rt = makeRuntime();
    expect(globalThis.__squadRuntimeShutdownTrapRegistered).toBeFalsy();
    rt.registerShutdownTrap();
    expect(globalThis.__squadRuntimeShutdownTrapRegistered).toBe(true);
    const before = process.listenerCount('SIGTERM');
    rt.registerShutdownTrap();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('stopAll 由 trap handler 调用后清空 Set（trap 与 stopAll 集成）', async () => {
    const { engine } = makeMockEngine();
    const rt = makeRuntime({
      squads: [makeSquad({ id: 'SQ-1', enableHeartBeat: true })],
      engine,
    });
    await rt.ensureScheduler('SQ-1');
    rt.registerShutdownTrap();
    rt.stopAll();
    expect(rt.getScheduler('SQ-1')).toBeUndefined();
  });
});

// ── makeGetUsageTotalTokens baseline-delta（v0.0.33.4 不动，回归保留） ───

describe('makeGetUsageTotalTokens baseline-delta（v0.0.33.4 保留，T2 不动）', () => {
  function makeFn(opts: {
    totalsBySession?: Record<string, number>;
    squadIdBySession?: Record<string, string | undefined>;
  }): {
    fn: ReturnType<typeof makeGetUsageTotalTokens>;
    budgetState: BudgetState;
  } {
    const totals = opts.totalsBySession ?? {};
    const squadIds = opts.squadIdBySession ?? {};
    const sessionStore = {
      getUsageView: vi.fn(async (sid: string) => ({
        total: { total_tokens: totals[sid] ?? 0 },
      })),
      getSession: vi.fn(async (sid: string) => {
        if (sid in squadIds) {
          const squadId = squadIds[sid];
          return squadId ? { id: sid, squadId } : { id: sid };
        }
        return { id: sid };
      }),
    };
    const budgetState = new BudgetState(tmpRoot);
    const fn = makeGetUsageTotalTokens(
      sessionStore as unknown as Parameters<typeof makeGetUsageTotalTokens>[0],
      budgetState,
    );
    return { fn, budgetState };
  }

  it('cold-start（无文件）：consumed=0，baseline 写入当前 total', async () => {
    const { fn, budgetState } = makeFn({
      totalsBySession: { 'S-1': 5000 },
      squadIdBySession: { 'S-1': 'SQ-1' },
    });
    const ws = new Date('2026-06-30T00:00:00.000Z');
    const consumed = await fn('S-1', ws);
    expect(consumed).toBe(0);
    const state = budgetState.readAll('SQ-1');
    expect(state?.baselines['S-1']).toBe(5000);
    expect(state?.windowStart).toBe(ws.toISOString());
  });

  it('同窗口 total 增长：consumed = currentTotal − baseline', async () => {
    const { fn, budgetState } = makeFn({
      totalsBySession: { 'S-1': 8000 },
      squadIdBySession: { 'S-1': 'SQ-1' },
    });
    const ws = new Date('2026-06-30T00:00:00.000Z');
    atomicWriteSync(
      budgetState.filePath('SQ-1'),
      JSON.stringify({ windowStart: ws.toISOString(), baselines: { 'S-1': 5000 } }),
    );
    const consumed = await fn('S-1', ws);
    expect(consumed).toBe(3000);
  });

  it('窗口翻转：consumed=0，baseline 重置为当前 total', async () => {
    const { fn, budgetState } = makeFn({
      totalsBySession: { 'S-1': 12000 },
      squadIdBySession: { 'S-1': 'SQ-1' },
    });
    const oldWs = new Date('2026-06-29T00:00:00.000Z');
    const newWs = new Date('2026-06-30T00:00:00.000Z');
    atomicWriteSync(
      budgetState.filePath('SQ-1'),
      JSON.stringify({ windowStart: oldWs.toISOString(), baselines: { 'S-1': 3000 } }),
    );
    const consumed = await fn('S-1', newWs);
    expect(consumed).toBe(0);
    const state = budgetState.readAll('SQ-1');
    expect(state?.windowStart).toBe(newWs.toISOString());
    expect(state?.baselines['S-1']).toBe(12000);
  });

  it('窗口内新增 session：consumed=0，baseline 补当前 total', async () => {
    const { fn, budgetState } = makeFn({
      totalsBySession: { 'S-1': 5000, 'S-2': 7000 },
      squadIdBySession: { 'S-1': 'SQ-1', 'S-2': 'SQ-1' },
    });
    const ws = new Date('2026-06-30T00:00:00.000Z');
    atomicWriteSync(
      budgetState.filePath('SQ-1'),
      JSON.stringify({ windowStart: ws.toISOString(), baselines: { 'S-1': 4000 } }),
    );
    const c2 = await fn('S-2', ws);
    expect(c2).toBe(0);
    const c1 = await fn('S-1', ws);
    expect(c1).toBe(1000);
    expect(budgetState.readAll('SQ-1')?.baselines['S-2']).toBe(7000);
  });

  it('standalone session（无 squadId）：返 raw total，不写 budget-state', async () => {
    const { fn, budgetState } = makeFn({
      totalsBySession: { 'S-LONE': 9999 },
      squadIdBySession: { 'S-LONE': undefined },
    });
    const ws = new Date('2026-06-30T00:00:00.000Z');
    const consumed = await fn('S-LONE', ws);
    expect(consumed).toBe(9999);
    expect(budgetState.readAll('any-squad')).toBeUndefined();
  });
});
