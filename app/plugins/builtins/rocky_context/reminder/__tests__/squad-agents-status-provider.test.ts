/**
 * squad_agents_status reminder provider UT（[v0.0.273] 统一全员状态块 [squad:agents]）
 * 参考: specs/tech/version_logs/v0.0.273/change_plan.md 裁决 R6-R8
 *       specs/tech/squad/[P1]squad_reminder_providers.md（统一块取代 reachable_agents + squad_team_status）
 *
 * 覆盖：
 *   1. 产出规则分派（leader/mate/squad/subagent/standalone 5 种 sessionType）
 *   2. 全员列出（running + idle 都保留，不 running 过滤——做完的 mate 不消失）
 *   3. presence（有 currentWork 文本 / 无 presence 兜底）
 *   4. benched 过滤（state==='benched' 不列）
 *   5. 270 enableGroupChat 门控（SquadChat 行随门控显隐）
 *   6. mate 视角：leader + peers 带状态（不含自己）
 *   7. subagent → [parent]；standalone → []
 *   8. 空 squad 降级「当前无成员」
 */
import { describe, it, expect } from 'vitest';
import SquadAgentsStatusReminderProvider from '../squad_agents_status';

import type { ReminderCtx, SquadContextService } from '../../types';

// ── helpers ─────────────────────────────────────────────────────────

interface FakeMember {
  id: string;
  sessionId?: string;
  name: string;
  role: string;
  state?: string;
  currentWork?: { text: string; updatedAt: string } | null;
}

interface FakeSquad {
  leaderId?: string;
  memberIds?: string[];
  squadChatSessionId?: string;
  enableGroupChat?: boolean;
}

/**
 * 构造 ReminderCtx：config.kind 决定 readSessionType；squadContext mock 可控。
 */
function mkCtx(over: {
  sessionType?: string;
  squadId?: string;
  memberId?: string;
  members?: FakeMember[];
  runningSessionIds?: string[];
  squad?: FakeSquad;
  noSquadContext?: boolean;
  agentToolContext?: Record<string, unknown>;
}): ReminderCtx {
  const st = over.sessionType ?? 'leader';
  const isSubagent = st === 'subagent';
  const isStudio = ['leader', 'mate', 'squad'].includes(st);
  const kind = { role: st, isSubagent, isStudio };

  const config: Record<string, unknown> = { modelId: 'm', kind };
  if (over.squadId !== undefined) config.squadId = over.squadId;
  if (over.memberId !== undefined) config.memberId = over.memberId;
  if (over.agentToolContext !== undefined) config.agentToolContext = over.agentToolContext;

  if (over.noSquadContext) {
    return { config } as unknown as ReminderCtx;
  }

  const members = over.members ?? [];
  const runningIds = new Set(over.runningSessionIds ?? []);
  const squad = over.squad ?? { squadChatSessionId: '01SC' };

  const squadContext: SquadContextService = {
    getSquad: async () => squad,
    listMembers: async () => members,
    listGoals: async () => [],
    listRequirements: async () => [],
    listTasks: async () => [],
    isSessionRunning: async (sessionId: string) => runningIds.has(sessionId),
  };

  return { config, squadContext } as unknown as ReminderCtx;
}

function mk(): SquadAgentsStatusReminderProvider {
  return new SquadAgentsStatusReminderProvider('squad_agents_status', {});
}

function mkMember(o: {
  id: string; name: string; role: string; sessionId?: string; state?: string;
  currentWork?: { text: string; updatedAt: string } | null;
}): FakeMember {
  return {
    id: o.id,
    name: o.name,
    role: o.role,
    ...(o.sessionId !== undefined ? { sessionId: o.sessionId } : {}),
    ...(o.state !== undefined ? { state: o.state } : {}),
    ...(o.currentWork !== undefined ? { currentWork: o.currentWork } : {}),
  };
}

const LEADER = mkMember({ id: 'mem-l', name: 'alice', role: 'leader', sessionId: '01SL' });
const MATE_A = mkMember({ id: 'mem-a', name: 'bob', role: 'mate', sessionId: '01SA' });
const MATE_B = mkMember({ id: 'mem-b', name: 'carol', role: 'mate', sessionId: '01SB' });
const ALL_MEMBERS = [LEADER, MATE_A, MATE_B];

// ── 产出规则分派 ─────────────────────────────────────────────────────

describe('squad_agents_status provider — 产出规则分派（readSessionType）', () => {
  it('standalone（无 kind）→ []', async () => {
    const ctx: ReminderCtx = {
      config: { modelId: 'm' },
      squadContext: {
        getSquad: async () => null,
        listMembers: async () => [],
        listGoals: async () => [],
        listRequirements: async () => [],
        listTasks: async () => [],
        isSessionRunning: async () => false,
      },
    } as unknown as ReminderCtx;
    const out = await mk().provide(ctx);
    expect(out).toEqual([]);
  });

  it("playground（kind.role='rocky'）→ []（同 standalone）", async () => {
    const ctx: ReminderCtx = {
      config: { modelId: 'm', kind: { role: 'rocky' } },
    } as unknown as ReminderCtx;
    const out = await mk().provide(ctx);
    expect(out).toEqual([]);
  });

  it('leader → SquadChat + 全部 mate（不含 leader 自己）；id= squad_agents_status tier=info', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'leader',
      squadId: 'SQ-1',
      memberId: LEADER.id,
      members: ALL_MEMBERS,
      runningSessionIds: ['01SA'],
      squad: { squadChatSessionId: '01SC', enableGroupChat: true },
    }));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('squad_agents_status');
    expect(out[0]!.tier).toBe('info');
    const content = out[0]!.content;
    expect(content).toContain('[squad:agents]');
    expect(content).toContain('SquadChat (squad, sessionId: 01SC) · 群聊');
    expect(content).toContain('bob');
    expect(content).toContain('carol');
    // leader 不含自己
    expect(content).not.toContain('01SL');
  });

  it('mate → SquadChat + leader + peers（不含 mate 自己）', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'mate',
      squadId: 'SQ-1',
      memberId: MATE_A.id,
      members: ALL_MEMBERS,
      squad: { squadChatSessionId: '01SC', enableGroupChat: true },
    }));
    expect(out).toHaveLength(1);
    const content = out[0]!.content;
    expect(content).toContain('SquadChat (squad, sessionId: 01SC) · 群聊');
    expect(content).toContain('alice'); // leader
    expect(content).toContain('carol'); // peer
    // bob（self）不在自己列表
    expect(content).not.toContain('01SA');
  });

  it('squad → leader + 全部 mate（不含 SquadChat 自身=群聊）', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'squad',
      squadId: 'SQ-1',
      members: ALL_MEMBERS,
      squad: { squadChatSessionId: '01SC', enableGroupChat: true },
    }));
    expect(out).toHaveLength(1);
    const content = out[0]!.content;
    expect(content).toContain('alice'); // leader
    expect(content).toContain('bob'); // mate
    expect(content).toContain('carol'); // mate
    // squad 自身即 squadchat，不在自己列表里
    expect(content).not.toContain('01SC');
  });

  it('subagent → [parent]（reachable 语义保持，拓扑硬约束）', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'subagent',
      agentToolContext: {
        parentSessionId: '01PARENT',
        parent: { type: 'mate', sessionId: '01PARENT', name: 'bob' },
      },
    }));
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('01PARENT');
    expect(out[0]!.content).toContain('bob');
  });

  it('subagent 仅 parentSessionId（无 canonical parent ref）→ [parent]', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'subagent',
      agentToolContext: { parentSessionId: '01P2' },
    }));
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('01P2');
  });
});

// ── 全员列出 + 状态 + presence ───────────────────────────────────────

describe('squad_agents_status provider — 全员列出（running/idle + presence）', () => {
  it('running + idle 成员都列出（不 running 过滤——做完的 mate 不消失）', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'leader',
      squadId: 'SQ-1',
      memberId: LEADER.id,
      members: [
        LEADER,
        mkMember({ id: 'mem-a', name: 'bob', role: 'mate', sessionId: '01SA' }),
        mkMember({ id: 'mem-b', name: 'carol', role: 'mate', sessionId: '01SB' }),
      ],
      runningSessionIds: ['01SA'], // 只有 bob running，carol idle
    }));
    const content = out[0]!.content;
    expect(content).toContain('bob (mate, sessionId: 01SA) · running');
    expect(content).toContain('carol (mate, sessionId: 01SB) · idle');
  });

  it('成员行格式：{name} ({role}, sessionId: {sid}) · {running|idle} · presence: {text|(无 presence)}', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'leader',
      squadId: 'SQ-1',
      memberId: LEADER.id,
      members: [
        LEADER,
        mkMember({
          id: 'mem-a', name: 'bob', role: 'mate', sessionId: '01SA',
          currentWork: { text: '正在写 UT', updatedAt: '2026-01-01T00:00:00.000Z' },
        }),
        mkMember({ id: 'mem-b', name: 'carol', role: 'mate', sessionId: '01SB', currentWork: null }),
      ],
      runningSessionIds: ['01SA'],
    }));
    const content = out[0]!.content;
    // 有 presence → 显示文本
    expect(content).toContain('bob (mate, sessionId: 01SA) · running · presence: 正在写 UT');
    // 无 presence → 兜底 (无 presence)
    expect(content).toContain('carol (mate, sessionId: 01SB) · idle · presence: (无 presence)');
  });

  it('有 presence 没 running = 疑似卡住可见（idle + presence 同时出现）', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'leader',
      squadId: 'SQ-1',
      memberId: LEADER.id,
      members: [
        LEADER,
        mkMember({
          id: 'mem-a', name: 'bob', role: 'mate', sessionId: '01SA',
          currentWork: { text: '疑似卡住的工作', updatedAt: '2026-01-01T00:00:00.000Z' },
        }),
      ],
      runningSessionIds: [], // 不 running
    }));
    const content = out[0]!.content;
    expect(content).toContain('bob (mate, sessionId: 01SA) · idle · presence: 疑似卡住的工作');
  });

  it('mate 视角能看到队友状态（peer 带 running/idle）', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'mate',
      squadId: 'SQ-1',
      memberId: MATE_A.id,
      members: [
        LEADER,
        MATE_A,
        mkMember({ id: 'mem-b', name: 'carol', role: 'mate', sessionId: '01SB' }),
      ],
      runningSessionIds: ['01SB'], // carol running
    }));
    const content = out[0]!.content;
    expect(content).toContain('alice (leader, sessionId: 01SL) · idle');
    expect(content).toContain('carol (mate, sessionId: 01SB) · running');
  });
});

// ── benched 过滤 + 门控 + 降级 ───────────────────────────────────────

describe('squad_agents_status provider — benched 过滤 / 门控 / 降级', () => {
  it('benched 成员过滤（state==="benched" 不列；其余照常）', async () => {
    const benched = mkMember({ id: 'mem-d', name: 'dave', role: 'mate', sessionId: '01SD', state: 'benched' });
    const out = await mk().provide(mkCtx({
      sessionType: 'leader',
      squadId: 'SQ-1',
      memberId: LEADER.id,
      members: [...ALL_MEMBERS, benched],
    }));
    const content = out[0]!.content;
    expect(content).toContain('bob');
    expect(content).toContain('carol');
    expect(content).not.toContain('dave');
    expect(content).not.toContain('01SD');
  });

  it('[v0.0.270] enableGroupChat=false → leader 无 SquadChat 行（门控关；mate 私聊仍列）', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'leader',
      squadId: 'SQ-1',
      memberId: LEADER.id,
      members: ALL_MEMBERS,
      squad: { squadChatSessionId: '01SC', enableGroupChat: false },
    }));
    const content = out[0]!.content;
    expect(content).not.toContain('SquadChat');
    expect(content).not.toContain('01SC');
    expect(content).toContain('bob'); // mate 私聊仍可达
    expect(content).toContain('carol');
  });

  it('[v0.0.270] enableGroupChat=false → mate 无 SquadChat 行（门控关；leader/peers 私聊仍列）', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'mate',
      squadId: 'SQ-1',
      memberId: MATE_A.id,
      members: ALL_MEMBERS,
      squad: { squadChatSessionId: '01SC', enableGroupChat: false },
    }));
    const content = out[0]!.content;
    expect(content).not.toContain('SquadChat');
    expect(content).toContain('alice'); // leader 私聊仍可达
    expect(content).toContain('carol'); // peer 私聊仍可达
  });

  it('[v0.0.270] enableGroupChat=true → leader 含 SquadChat 行（门控开）', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'leader',
      squadId: 'SQ-1',
      memberId: LEADER.id,
      members: ALL_MEMBERS,
      squad: { squadChatSessionId: '01SC', enableGroupChat: true },
    }));
    expect(out[0]!.content).toContain('SquadChat (squad, sessionId: 01SC) · 群聊');
  });

  it('空 squad（无成员）→ 降级「当前无成员」', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'leader',
      squadId: 'SQ-1',
      memberId: LEADER.id,
      members: [],
    }));
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('当前无成员');
  });

  it('无 squadContext → []（graceful）', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'leader',
      squadId: 'SQ-1',
      noSquadContext: true,
    }));
    expect(out).toEqual([]);
  });

  it('无 squadId → []（graceful）', async () => {
    const out = await mk().provide(mkCtx({
      sessionType: 'leader',
      members: ALL_MEMBERS,
    }));
    expect(out).toEqual([]);
  });

  it('成员无 sessionId → 状态按 idle 渲染（不 crash）', async () => {
    const noSid = mkMember({ id: 'mem-x', name: 'xavier', role: 'mate' });
    const out = await mk().provide(mkCtx({
      sessionType: 'leader',
      squadId: 'SQ-1',
      memberId: LEADER.id,
      members: [LEADER, noSid],
    }));
    const content = out[0]!.content;
    expect(content).toContain('xavier (mate, sessionId: ) · idle'); // 无 sessionId → idle
  });
});
