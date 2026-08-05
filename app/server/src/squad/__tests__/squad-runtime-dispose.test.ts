/**
 * SquadRuntime.disposeSquad 单测（白盒）—— v0.0.111 块② per-squad 运行时 teardown
 * 参考: specs/tech/version_logs/v0.0.111/change_plan.md 块②（disposeSquad 契约）
 *       states/v0.0.111.workitem_visibility/team-delete-research.md §①（teardown 停调度防潜伏）
 *
 * disposeSquad(squadId)：
 *   ① 枚举 squad 会话（squadChatSessionId + 各 member.sessionId）→ agentManager.abortSession 各会话
 *   ② unregisterHeartbeatJobs（engine.unregister 本 squad heartbeat jobs）
 *   ③ 清 ensuredSquads / schedulerFacades
 *   MUST NOT engine.stop（进程单例）；幂等（未 ensure/不存在也安全）。
 *
 * 测法：白盒——注入 mock deps（含 abortSession spy + mock engine）+ 直接写私有状态
 *   （ensuredSquads/registeredJobIds/schedulerFacades）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SquadRuntime, type SquadRuntimeDeps } from '../squad-runtime';
import type { SquadEntity, MemberEntity } from '../../stores/squad-store';
import type { SchedulerEngine } from '../../scheduling/engine';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'squad-dispose-'));
  globalThis.__squadRuntimeShutdownTrapRegistered = undefined;
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeSquad(id: string, chatSid: string): SquadEntity {
  return { id, squadChatSessionId: chatSid, memberIds: [] } as unknown as SquadEntity;
}
function makeMember(id: string, squadId: string, sessionId: string): MemberEntity {
  return { id, squadId, sessionId } as unknown as MemberEntity;
}

/** 造 runtime + spies；squad/members 通过 mock store 返回 */
function setup(opts: { squad: SquadEntity; members: MemberEntity[] }) {
  const abortSession = vi.fn(async () => {});
  const unregister = vi.fn((_jid: string) => {});
  const engineStop = vi.fn(() => {});
  const engine = {
    register: vi.fn(), unregister, stop: engineStop, getJob: vi.fn(),
    updateJobLastFiredAt: vi.fn(), snapshot: vi.fn(() => new Map()), start: vi.fn(),
    has: vi.fn(() => false), getRunState: vi.fn(() => 'running'),
  } as unknown as SchedulerEngine;
  const squadStore = {
    listSquads: vi.fn(async () => [opts.squad]),
    getSquad: vi.fn(async (id: string) => (id === opts.squad.id ? opts.squad : undefined)),
  };
  const memberStore = {
    listMembers: vi.fn(async (sid: string) => opts.members.filter((m) => m.squadId === sid)),
    getMember: vi.fn(async () => undefined),
  };
  const deps: SquadRuntimeDeps = {
    root: tmpRoot,
    squadStore: squadStore as unknown as SquadRuntimeDeps['squadStore'],
    memberStore: memberStore as unknown as SquadRuntimeDeps['memberStore'],
    sessionStore: { getSession: vi.fn(async () => undefined) } as unknown as SquadRuntimeDeps['sessionStore'],
    agentManager: { abortSession } as unknown as SquadRuntimeDeps['agentManager'],
    engine,
  };
  const rt = new SquadRuntime(deps);
  return { rt, abortSession, unregister, engineStop };
}

/** 注入私有 teardown 状态（模拟 ensureScheduler 后：已注册 job + ensured 标记） */
function seedRuntimeState(rt: SquadRuntime, squadId: string) {
  const anyRt = rt as unknown as {
    ensuredSquads: Set<string>;
    registeredJobIds: Map<string, Set<string>>;
    schedulerFacades: Map<string, unknown>;
  };
  anyRt.ensuredSquads.add(squadId);
  anyRt.registeredJobIds.set(squadId, new Set([`heartbeat:${squadId}:M-1`]));
  anyRt.schedulerFacades.set(squadId, {});
}

describe('SquadRuntime.disposeSquad — per-squad teardown', () => {
  it('teardown：各会话 abortSession + unregister heartbeat + 清 per-squad 状态；不 engine.stop', async () => {
    const squad = makeSquad('SQ-1', 'SID-CHAT');
    const members = [makeMember('M-1', 'SQ-1', 'SID-M1'), makeMember('M-2', 'SQ-1', 'SID-M2')];
    const { rt, abortSession, unregister, engineStop } = setup({ squad, members });
    seedRuntimeState(rt, 'SQ-1');

    await rt.disposeSquad('SQ-1');

    // ① 枚举会话 = squadChatSessionId + 各 member.sessionId，逐个 abortSession
    expect(abortSession).toHaveBeenCalledWith('SID-CHAT');
    expect(abortSession).toHaveBeenCalledWith('SID-M1');
    expect(abortSession).toHaveBeenCalledWith('SID-M2');
    expect(abortSession).toHaveBeenCalledTimes(3);
    // ② heartbeat job 被 engine.unregister
    expect(unregister).toHaveBeenCalledWith('heartbeat:SQ-1:M-1');
    // MUST NOT engine.stop（进程单例）
    expect(engineStop).not.toHaveBeenCalled();
    // ③ 清 per-squad 状态：getScheduler 返回 undefined（ensuredSquads 已删）
    expect(rt.getScheduler('SQ-1')).toBeUndefined();
    const anyRt = rt as unknown as { registeredJobIds: Map<string, unknown> };
    expect(anyRt.registeredJobIds.has('SQ-1')).toBe(false);
  });

  it('幂等：未 ensure 的 squad dispose 安全 no-op（不抛，不 engine.stop）', async () => {
    const squad = makeSquad('SQ-9', 'SID-9');
    const { rt, abortSession, engineStop } = setup({ squad, members: [] });
    // 未 seed 任何私有状态 → 直接 dispose
    await expect(rt.disposeSquad('SQ-9')).resolves.toBeUndefined();
    // 仍会枚举会话并 abort squadChatSessionId（best-effort，安全）
    expect(abortSession).toHaveBeenCalledWith('SID-9');
    expect(engineStop).not.toHaveBeenCalled();
  });
});
