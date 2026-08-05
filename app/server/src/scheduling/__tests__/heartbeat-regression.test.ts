/**
 * heartbeat v0.0.33.4 回归验证 — T6 装配后行为不变。
 * 参考: specs/tech/scheduling/[P1]heartbeat_handler.md §4（6 项回归红线）
 *       specs/tech/squad/[P1]scheduler.md §4（gate chain 基线）
 *       task.json T6 acceptanceCriteria §4
 *
 * 覆盖（task.json T6 acceptanceCriteria §4）：
 *   R1: 端到端 — bootScheduler + heartbeat 配置 → engine tick 到点 → HeartbeatHandler fire → deliverTo 调用
 *   R2: gate1 activeWindow skip — 窗口外不 fire（保旧 lastFiredAt）
 *   R3: gate0 killswitch toggle ≤1s — disable enableHeartBeat → 下一 tick 立即 skip
 *   R4: gate3 busy skip — isSessionBusy=true → skip（不 deliverTo）
 *   R5: 多 squad 隔离 — 两 squad heartbeat job 各自独立（不互扰）
 *   R6: grep SquadScheduler — 仅历史 log（retired，无残留死代码）
 *
 * 文件系统隔离：用 os.tmpdir + mkdtempSync + afterEach 清理。
 *
 * 与 boot.test.ts 区别：boot.test.ts 验 wiring（handlers 注册 / jobs 装载 / hooks wire），
 *   本测试验**行为**（engine tick 真触发 HeartbeatHandler.fire → gate chain → deliverTo）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  bootScheduler,
  createEngine,
} from '../boot';
import { SchedulerEngine } from '../engine';
import { SquadRuntime } from '../../squad/squad-runtime';
import { BudgetAggregator } from '../../squad/budget/budget-aggregator';
import { BudgetState } from '../../squad/budget-state';
import { SquadStore, MemberStore } from '../../stores/squad-store';
import { makeGetUsageTotalTokens } from '../../squad/squad-budget-wiring';
import { ulid } from '../../config/ulid';
import type { SquadEntity, MemberEntity } from '../../stores/squad-store';
import type { SessionStore } from '../../agent/session-store';
import type { AgentManagerImpl } from '../../agent/agent-manager';
import type { Message } from '../../message/types';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'heartbeat-regression-'));
  globalThis.__schedulerEngineShutdownTrapRegistered = undefined;
  globalThis.__squadRuntimeShutdownTrapRegistered = undefined;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────

function newUlid(): string {
  return ulid();
}

function makeSquad(opts: {
  id: string;
  leaderId: string;
  enableHeartBeat: boolean;
  budget?: { limit: number; window: 'daily'; scope: 'team' } | null;
  timezone?: string;
  /** [v0.0.116] squad 级心跳配置（null=默认 interval15/全天/all） */
  heartbeatConfig?: { interval: number; activeWindows: { start: string; end: string }[]; scope: { mode: 'all' | 'whitelist'; memberIds: string[] } } | null;
}): SquadEntity {
  return {
    id: opts.id,
    name: opts.id,
    description: '',
    modelDefault: 'm1',
    leaderId: opts.leaderId,
    memberIds: [opts.leaderId],
    squadChatSessionId: newUlid(),
    charter: { goals: '', workingStyle: '', collaboration: '', escalation: '' },
    budget: opts.budget ?? null,
    enableHeartBeat: opts.enableHeartBeat,
    timezone: opts.timezone ?? 'UTC',
    heartbeatConfig: opts.heartbeatConfig !== undefined ? opts.heartbeatConfig : null,
  } as unknown as SquadEntity;
}

function makeMember(opts: {
  id: string;
  squadId: string;
  sessionId: string;
  heartbeat: { activeWindow: { start: string; end: string }; interval: number };
}): MemberEntity {
  return {
    id: opts.id,
    squadId: opts.squadId,
    sessionId: opts.sessionId,
    name: opts.id,
    role: 'mate' as const,
    tools: [],
    // [v0.0.113] skillConfig 取代旧 skills 白名单（overlay 快照；schema required）
    skillConfig: { mode: 'inherit', overrides: {} },
    model: 'm1',
    state: 'deployed',
    heartbeat: opts.heartbeat,
  } as unknown as MemberEntity;
}

/** mock SessionStore：getSession 返基本字段（用于 cronAdapter.resolveSquadId；heartbeat 不用） */
function mockSessionStore(): SessionStore {
  return {
    getSession: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
    getUsageView: vi.fn(async () => ({ total: { total_tokens: 0 } })),
  } as unknown as SessionStore;
}

/** mock AgentManager：isSessionBusy=false / deliverTo 返 spy */
function mockAgentManager(opts: { busy?: boolean } = {}): {
  agentManager: AgentManagerImpl;
  deliverToSpy: ReturnType<typeof vi.fn>;
  isSessionBusySpy: ReturnType<typeof vi.fn>;
} {
  const deliverToSpy = vi.fn(async () => ({}));
  const isSessionBusySpy = vi.fn(async () => opts.busy === true);
  return {
    agentManager: {
      isSessionBusy: isSessionBusySpy,
      deliverTo: deliverToSpy,
    } as unknown as AgentManagerImpl,
    deliverToSpy,
    isSessionBusySpy,
  };
}

/** 真实 bootScheduler 装配（含 squadStore/memberStore seeding） */
async function bootReal(opts: {
  squads: SquadEntity[];
  members: MemberEntity[];
  agentManager: AgentManagerImpl;
  now?: () => Date;
}): Promise<{
  engine: SchedulerEngine;
  shutdown: () => void;
}> {
  const squadStore = new SquadStore({ root: tmpRoot });
  const memberStore = new MemberStore({ root: tmpRoot });
  for (const s of opts.squads) {
    const rec = s as unknown as Record<string, unknown>;
    const { createdAt, updatedAt, version, ...squadRec } = rec;
    await squadStore.putSquad(squadRec as unknown as SquadEntity);
  }
  for (const m of opts.members) {
    await memberStore.putMember(m);
  }
  const sessionStore = mockSessionStore();
  const budgetState = new BudgetState(tmpRoot);
  const budgetAggregator = new BudgetAggregator({
    squadStore,
    memberStore,
    getUsageTotalTokens: makeGetUsageTotalTokens(
      sessionStore as unknown as Parameters<typeof makeGetUsageTotalTokens>[0],
      budgetState,
    ),
  });
  // 透传 opts.now 给 createEngine（v0.0.64 P3 BUG-002 修复）：
  // 否则 createEngine 不传 now → engine fallback 真实墙上时间 → R2 在真实窗口内时间跑时 gate1 误过（flaky）
  const { engine, registry, cronStore } = createEngine(tmpRoot, sessionStore, opts.now);
  const squadRuntime = new SquadRuntime({
    root: tmpRoot,
    squadStore,
    memberStore,
    sessionStore,
    agentManager: opts.agentManager,
    engine,
  });
  const bootDeps: Parameters<typeof bootScheduler>[0] = {
    engine, registry, cronStore,
    squadRuntime, squadStore, sessionStore,
    agentManager: opts.agentManager, budgetAggregator,
    // 注入 fake setInterval/clearInterval（boot 不真启 budget refresh；engine 用真实 timer tick）
    setInterval: () => 0 as unknown as ReturnType<typeof setInterval>,
    clearInterval: () => {},
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };
  const result = await bootScheduler(bootDeps);
  return { engine, shutdown: result.shutdown };
}

// ============================================================
// R6: grep SquadScheduler retired（先验，确保迁移完成）
// ============================================================

describe('R6: SquadScheduler retired（无残留死代码）', () => {
  it('grep "class SquadScheduler" 不出现在 app/server/src/ 生产源码（仅历史 log）', () => {
    // 用绝对路径定位源码目录（__dirname 在 vitest 运行时是源码位置，回溯到 app/server/src）
    const srcDir = join(__dirname, '..', '..');
    // 排除 __tests__/ 目录（避免测试文件自身匹配）；找不到 → grep exit 1 → pass
    let found = '';
    try {
      found = execSync(
        `grep -rn 'class SquadScheduler' ${srcDir} --include='*.ts' | grep -v '__tests__/' 2>/dev/null || true`,
        { encoding: 'utf8' },
      );
    } catch {
      // grep 异常（极少见）→ 视为通过
      return;
    }
    if (found.trim().length === 0) return; // 无匹配
    throw new Error(`SquadScheduler class still present in app/server/src production code:\n${found}`);
  });

  it('原 squad/scheduler/scheduler.ts 已 retire（不存在于源码 tree）', () => {
    const oldSchedulerPath = join(__dirname, '..', '..', 'squad', 'scheduler', 'scheduler.ts');
    expect(existsSync(oldSchedulerPath)).toBe(false);
  });

  it('gate-chain.ts 已 retire（withinActiveWindow 迁至 scheduling/active-window.ts）', () => {
    const oldGateChainPath = join(__dirname, '..', '..', 'squad', 'scheduler', 'gate-chain.ts');
    expect(existsSync(oldGateChainPath)).toBe(false);
  });
});

// ============================================================
// R1-R5: 端到端行为
// ============================================================

describe('heartbeat v0.0.33.4 回归（R1-R5）', () => {
  it('R1: bootScheduler + heartbeat 配置 → engine tick 到点 → HeartbeatHandler.fire → deliverTo 调用', async () => {
    // 固定 now → nextFireAt 锚 createdAt；选 interval=1ms（确保到点）
    // activeWindow 设全天 00:00-23:59（不卡 window gate）
    const startNow = new Date('2026-07-03T10:00:00.000Z');
    const sqId = newUlid();
    const mId = newUlid();
    const sessId = newUlid();
    // 让 lastFiredAt 在过去 + interval 短 → engine 首次 tick 即 isDue
    // 通过 stateStore 预置 lastFiredAt
    const stateStorePath = join(tmpRoot, '.rocky', 'state', 'scheduler.json');
    mkdirSync(join(tmpRoot, '.rocky', 'state'), { recursive: true });
    const oldIso = new Date(startNow.getTime() - 60_000).toISOString();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(stateStorePath, JSON.stringify({
      version: 1,
      roles: { [mId]: { lastFiredAt: oldIso, lastResult: 'fired' } },
    }));
    const { agentManager, deliverToSpy } = mockAgentManager();
    const { engine, shutdown } = await bootReal({
      squads: [makeSquad({ id: sqId, leaderId: mId, enableHeartBeat: true })],
      members: [makeMember({
        id: mId, squadId: sqId, sessionId: sessId,
        heartbeat: { activeWindow: { start: '00:00', end: '23:59' }, interval: 1000 },
      })],
      agentManager,
      now: () => startNow,
    });
    // 触发一次 tick（手动调 private tick via cast）
    // engine.tick 是 private；用 cast 调
    const engineInternal = engine as unknown as { tick: () => void };
    engineInternal.tick();
    // 等 microtask flush（fire 是 async）
    await new Promise((r) => setTimeout(r, 50));
    expect(deliverToSpy).toHaveBeenCalledTimes(1);
    const [deliveredSid, deliveredMsg] = deliverToSpy.mock.calls[0]!;
    expect(deliveredSid).toBe(sessId);
    expect((deliveredMsg as Message).role).toBe('user');
    shutdown();
  });

  it('R2: gate1 activeWindows skip — 窗口外不 fire（来源 squad.heartbeatConfig.activeWindows）', async () => {
    // now=10:00 UTC，窗口 14:00-18:00 → 窗口外 → gate1 skip，deliverTo 不调
    const now = new Date('2026-07-03T10:00:00.000Z');
    const sqId = newUlid();
    const mId = newUlid();
    const sessId = newUlid();
    const { agentManager, deliverToSpy } = mockAgentManager();
    const { engine, shutdown } = await bootReal({
      squads: [makeSquad({
        id: sqId,
        leaderId: mId,
        enableHeartBeat: true,
        timezone: 'UTC',
        // 活跃窗口仅 14:00-18:00 UTC；now=10:00 → 窗口外
        heartbeatConfig: {
          interval: 15,
          activeWindows: [{ start: '14:00', end: '18:00' }],
          scope: { mode: 'all', memberIds: [] },
        },
      })],
      members: [makeMember({
        id: mId, squadId: sqId, sessionId: sessId,
        heartbeat: { activeWindow: { start: '00:00', end: '23:59' }, interval: 1000 },
      })],
      agentManager,
      now: () => now,
    });
    // 确认 job 已注册（enableHeartBeat=true）
    expect(engine.has(`heartbeat:${sqId}`)).toBe(true);
    const engineInternal = engine as unknown as { tick: () => void };
    engineInternal.tick();
    await new Promise((r) => setTimeout(r, 50));
    // gate1 activeWindows 窗口外 → skip → deliverTo 不调
    expect(deliverToSpy).not.toHaveBeenCalled();
    shutdown();
  });

  it('R3: gate0 killswitch toggle — enableHeartBeat=false → 下一 tick skip', async () => {
    const now = new Date('2026-07-03T10:00:00.000Z');
    const sqId = newUlid();
    const mId = newUlid();
    const sessId = newUlid();
    const stateStorePath = join(tmpRoot, '.rocky', 'state', 'scheduler.json');
    mkdirSync(join(tmpRoot, '.rocky', 'state'), { recursive: true });
    const oldIso = new Date(now.getTime() - 60_000).toISOString();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(stateStorePath, JSON.stringify({
      version: 1,
      roles: { [mId]: { lastFiredAt: oldIso, lastResult: 'fired' } },
    }));
    const { agentManager, deliverToSpy } = mockAgentManager();
    // enableHeartBeat=false（killswitch 关）
    const { engine, shutdown } = await bootReal({
      squads: [makeSquad({ id: sqId, leaderId: mId, enableHeartBeat: false })],
      members: [makeMember({
        id: mId, squadId: sqId, sessionId: sessId,
        heartbeat: { activeWindow: { start: '00:00', end: '23:59' }, interval: 1000 },
      })],
      agentManager,
      now: () => now,
    });
    const engineInternal = engine as unknown as { tick: () => void };
    engineInternal.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(deliverToSpy).not.toHaveBeenCalled();
    shutdown();
  });

  it('R4: gate3 busy skip — isSessionBusy=true → 不 deliverTo', async () => {
    const now = new Date('2026-07-03T10:00:00.000Z');
    const sqId = newUlid();
    const mId = newUlid();
    const sessId = newUlid();
    const stateStorePath = join(tmpRoot, '.rocky', 'state', 'scheduler.json');
    mkdirSync(join(tmpRoot, '.rocky', 'state'), { recursive: true });
    const oldIso = new Date(now.getTime() - 60_000).toISOString();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(stateStorePath, JSON.stringify({
      version: 1,
      roles: { [mId]: { lastFiredAt: oldIso, lastResult: 'fired' } },
    }));
    const { agentManager, deliverToSpy } = mockAgentManager({ busy: true });
    const { engine, shutdown } = await bootReal({
      squads: [makeSquad({ id: sqId, leaderId: mId, enableHeartBeat: true })],
      members: [makeMember({
        id: mId, squadId: sqId, sessionId: sessId,
        heartbeat: { activeWindow: { start: '00:00', end: '23:59' }, interval: 1000 },
      })],
      agentManager,
      now: () => now,
    });
    const engineInternal = engine as unknown as { tick: () => void };
    engineInternal.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(deliverToSpy).not.toHaveBeenCalled();
    shutdown();
  });

  it('R5: 多 squad 隔离 — 两 squad 各自 heartbeat job 独立', async () => {
    const now = new Date('2026-07-03T10:00:00.000Z');
    const sq1Id = newUlid();
    const sq2Id = newUlid();
    const m1Id = newUlid();
    const m2Id = newUlid();
    const sess1Id = newUlid();
    const sess2Id = newUlid();
    // stateStore 单一文件按 memberId 分角色（v0.0.33.4 schema）
    const stateStorePath = join(tmpRoot, '.rocky', 'state', 'scheduler.json');
    mkdirSync(join(tmpRoot, '.rocky', 'state'), { recursive: true });
    const oldIso = new Date(now.getTime() - 60_000).toISOString();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(stateStorePath, JSON.stringify({
      version: 1,
      roles: {
        [m1Id]: { lastFiredAt: oldIso, lastResult: 'fired' },
        [m2Id]: { lastFiredAt: oldIso, lastResult: 'fired' },
      },
    }));
    const { agentManager, deliverToSpy } = mockAgentManager();
    const { engine, shutdown } = await bootReal({
      squads: [
        makeSquad({ id: sq1Id, leaderId: m1Id, enableHeartBeat: true }),
        makeSquad({ id: sq2Id, leaderId: m2Id, enableHeartBeat: true }),
      ],
      members: [
        makeMember({
          id: m1Id, squadId: sq1Id, sessionId: sess1Id,
          heartbeat: { activeWindow: { start: '00:00', end: '23:59' }, interval: 1000 },
        }),
        makeMember({
          id: m2Id, squadId: sq2Id, sessionId: sess2Id,
          heartbeat: { activeWindow: { start: '00:00', end: '23:59' }, interval: 1000 },
        }),
      ],
      agentManager,
      now: () => now,
    });
    // [v0.0.116 最小适配] job.id 改为 squad 级（去 memberId）；task5 重写
    expect(engine.has(`heartbeat:${sq1Id}`)).toBe(true);
    expect(engine.has(`heartbeat:${sq2Id}`)).toBe(true);
    const engineInternal = engine as unknown as { tick: () => void };
    engineInternal.tick();
    await new Promise((r) => setTimeout(r, 50));
    // 两 job 都 fire（独立 sessionId）
    expect(deliverToSpy).toHaveBeenCalledTimes(2);
    const sids = deliverToSpy.mock.calls.map((c) => c[0]);
    expect(sids).toContain(sess1Id);
    expect(sids).toContain(sess2Id);
    shutdown();
  });
});
