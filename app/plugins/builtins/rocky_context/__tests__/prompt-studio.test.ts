/**
 * rocky_context plugin v0.0.33.2 studio 4 scope prompt mapper/reminder 单测
 * 参考: specs/tech/version_logs/v0.0.33.2/change_log.md §2.D（D9 修 + 4 mapper 表 + reachable reminder）+ §2.K
 *       specs/tech/squad/[P1]prompt_sections.md（字段契约 + Option A 分流 + tier + 数据源 + 派生表）
 *       specs/tech/multi_agent/[P1]a2a_protocol.md §2（AgentRef）+ §3（reachable_agents 派生表）
 *
 * [v0.0.33.3 step2 回归] 更新：
 *   - charter/tasks mapper 已迁 reminder provider（不再作为 system_prompt_mapper）→ 本文件移除其旧 mapper 测试
 *   - identity studio 三 scope（leader/mate/squad）返空（squad_role mapper 接管身份正文）
 *   - subagent 不变（继续读 config.systemPrompt）；standalone 不变（Rocky）
 *   - team_roster/parent_task/reachable_agents mapper 行为不变
 */
import { describe, it, expect } from 'vitest';
import IdentityMapper from '../prompt/identity';
import TeamRosterMapper from '../prompt/team_roster';
import ParentTaskMapper from '../prompt/parent_task';
import ReachableAgentsReminderProvider from '../prompt/reachable_agents';

/**
 * mock 自动从 sessionType 推导 config.kind（readSessionType → readSessionKind 已切到读 config.kind）。
 * sessionType='rocky' → kind={role:'rocky'}（playground kind 必传场景，区别于「省略 sessionType/无
 * kind」的旧 standalone 写法——两者均归一化为 standalone 语义，见 BUG-004）。
 */
function mkCtx(overrides: Record<string, unknown> = {}): { config: Record<string, unknown> } {
  const st = overrides.sessionType as string | undefined;
  let kind: { role?: string; isSubagent?: boolean; isStudio?: boolean } | undefined;
  if (st === 'subagent') {
    kind = { isSubagent: true };
  } else if (st === 'leader' || st === 'mate' || st === 'squad') {
    kind = { role: st, isStudio: true };
  } else if (st === 'rocky') {
    kind = { role: 'rocky' };
  }
  const base: Record<string, unknown> = { modelId: 'm', client: { contextWindow: 100000 } };
  if (kind) base.kind = kind;
  return { config: { ...base, ...overrides } };
}

/** 构造测试用 member entity（鸭子类型，匹配 MemberRecord 关键字段） */
function mkMember(o: {
  id: string;
  name: string;
  role: 'leader' | 'mate';
  sessionId: string;
  intro?: string;
  state?: string;
}): Record<string, unknown> {
  return {
    id: o.id, name: o.name, role: o.role, sessionId: o.sessionId,
    ...(o.intro !== undefined ? { intro: o.intro } : {}),
    ...(o.state !== undefined ? { state: o.state } : {}),
  };
}

const SQUAD_ID = '01SQ';
const SQUADCHAT_SID = '01SC';
const LEADER = mkMember({ id: 'mem-l', name: 'alice', role: 'leader', sessionId: '01SL' });
const MATE_A = mkMember({ id: 'mem-a', name: 'bob', role: 'mate', sessionId: '01SA' });
const MATE_B = mkMember({ id: 'mem-b', name: 'carol', role: 'mate', sessionId: '01SB' });
const ALL_MEMBERS = [LEADER, MATE_A, MATE_B];

/** 构造 studioContext（含 squad entity + members 批量） */
function mkStudioCtx(selfMemberId?: string) {
  return {
    squad: {
      id: SQUAD_ID,
      leaderId: LEADER.id,
      memberIds: ALL_MEMBERS.map((m) => m.id),
      squadChatSessionId: SQUADCHAT_SID,
      charter: {
        goals: 'Build great product',
        workingStyle: 'async-first',
        collaboration: ['daily sync', 'pr review'],
        escalation: 'ask user when blocked',
      },
    },
    members: ALL_MEMBERS,
    ...(selfMemberId ? { member: ALL_MEMBERS.find((m) => m.id === selfMemberId) } : {}),
  };
}

// ============================================================
// 1. mapper 分流（v0.0.33.3 step2 回归：charter/tasks mapper 已迁 reminder provider，本节仅测 team_roster/parent_task）
// ============================================================
describe('v0.0.33.2/3 mapper Option A 分流（v0.0.33.3 step2 回归子集）', () => {
  describe('team_roster (排 subagent)', () => {
    it('leader → 贡献花名册含全部成员 name+role+sessionId', () => {
      const out = new TeamRosterMapper('team_roster', {}).map(
        mkCtx({ sessionType: 'leader', studioContext: mkStudioCtx('mem-l') }),
      );
      expect(out).toHaveLength(1);
      expect(out[0]!.id).toBe('team_roster');
      expect(out[0]!.tier).toBe('stable');
      expect(out[0]!.content).toContain('alice');
      expect(out[0]!.content).toContain('bob');
      expect(out[0]!.content).toContain('carol');
      expect(out[0]!.content).toContain('01SL');
    });

    it('mate → 贡献花名册（peer 协作要见全队）', () => {
      const out = new TeamRosterMapper('team_roster', {}).map(
        mkCtx({ sessionType: 'mate', studioContext: mkStudioCtx('mem-a') }),
      );
      expect(out).toHaveLength(1);
      expect(out[0]!.content).toContain('alice');
    });

    it('squad → 贡献花名册（路由要对端）', () => {
      const out = new TeamRosterMapper('team_roster', {}).map(
        mkCtx({ sessionType: 'squad', studioContext: mkStudioCtx() }),
      );
      expect(out).toHaveLength(1);
    });

    it('subagent → []（subagent 拓扑硬约束只回 parent，见花名册无意义）', () => {
      const out = new TeamRosterMapper('team_roster', {}).map(
        mkCtx({ sessionType: 'subagent' }),
      );
      expect(out).toEqual([]);
    });

    it('standalone → []（无 sessionType）', () => {
      const out = new TeamRosterMapper('team_roster', {}).map(mkCtx());
      expect(out).toEqual([]);
    });

    // [BUG-004] playground kind.role='rocky'（非省略 kind）行为回归不变：仍 []（正向匹配调用方不受影响）
    it("playground（kind.role='rocky'）→ []（同 standalone，回归不变）", () => {
      const out = new TeamRosterMapper('team_roster', {}).map(mkCtx({ sessionType: 'rocky' }));
      expect(out).toEqual([]);
    });

    // [v0.0.114] intro 一句话介绍渲染进花名册行尾（有/无 intro 两种）
    it('intro 存在 → 行尾追加 "— intro"；缺省 → 优雅降级不显示分隔符', () => {
      const leaderWithIntro = mkMember({ id: 'mem-l', name: 'alice', role: 'leader', sessionId: '01SL', intro: '团队负责人，统筹协调' });
      const mateWithIntro = mkMember({ id: 'mem-a', name: 'bob', role: 'mate', sessionId: '01SA', intro: '负责前端' });
      const mateNoIntro = mkMember({ id: 'mem-b', name: 'carol', role: 'mate', sessionId: '01SB' }); // 旧 member 无 intro
      const out = new TeamRosterMapper('team_roster', {}).map(
        mkCtx({
          sessionType: 'leader',
          studioContext: { members: [leaderWithIntro, mateWithIntro, mateNoIntro] },
        }),
      );
      expect(out).toHaveLength(1);
      const content = out[0]!.content;
      // 有 intro：name(role) (sessionId: xxx) — intro
      expect(content).toContain('- alice(leader) (sessionId: 01SL) — 团队负责人，统筹协调');
      expect(content).toContain('- bob(mate) (sessionId: 01SA) — 负责前端');
      // 无 intro：优雅降级，行尾无 "— " 分隔符
      expect(content).toContain('- carol(mate) (sessionId: 01SB)');
      expect(content).not.toContain('carol(mate) (sessionId: 01SB) —');
    });

    it('intro 纯空白 → 视为无 intro（trim 后为空，不渲染分隔符）', () => {
      const mate = mkMember({ id: 'mem-a', name: 'bob', role: 'mate', sessionId: '01SA', intro: '   ' });
      const out = new TeamRosterMapper('team_roster', {}).map(
        mkCtx({ sessionType: 'mate', studioContext: { members: [mate] } }),
      );
      expect(out[0]!.content).toContain('- bob(mate) (sessionId: 01SA)');
      expect(out[0]!.content).not.toContain('—');
    });
  });

  describe('parent_task (subagent only)', () => {
    it('subagent → 贡献 parent_task 含 task 正文', () => {
      const out = new ParentTaskMapper('parent_task', {}).map(
        mkCtx({ sessionType: 'subagent', parentTask: 'Investigate the auth bug in login flow' }),
      );
      expect(out).toHaveLength(1);
      expect(out[0]!.id).toBe('parent_task');
      expect(out[0]!.tier).toBe('stable');
      expect(out[0]!.content).toContain('Investigate the auth bug in login flow');
    });

    it('subagent + {content} 形态 task（SpawnAgentInput.task）→ 贡献', () => {
      const out = new ParentTaskMapper('parent_task', {}).map(
        mkCtx({ sessionType: 'subagent', subAgentTask: { content: 'Read the README' } }),
      );
      expect(out).toHaveLength(1);
      expect(out[0]!.content).toContain('Read the README');
    });

    it('leader → []（subagent only）', () => {
      const out = new ParentTaskMapper('parent_task', {}).map(
        mkCtx({ sessionType: 'leader', parentTask: 'do something' }),
      );
      expect(out).toEqual([]);
    });

    it('mate → []（subagent only）', () => {
      const out = new ParentTaskMapper('parent_task', {}).map(
        mkCtx({ sessionType: 'mate', parentTask: 'do something' }),
      );
      expect(out).toEqual([]);
    });

    it('squad → []（subagent only）', () => {
      const out = new ParentTaskMapper('parent_task', {}).map(
        mkCtx({ sessionType: 'squad', parentTask: 'do something' }),
      );
      expect(out).toEqual([]);
    });

    it('subagent 但无 task 持久化 → []（T2 持久化未就位时不阻塞）', () => {
      const out = new ParentTaskMapper('parent_task', {}).map(
        mkCtx({ sessionType: 'subagent' }),
      );
      expect(out).toEqual([]);
    });
  });
});

// ============================================================
// 2. identity 分流（v0.0.33.3 step2：studio 三 scope 返空；subagent/standalone 不变）
// ============================================================
describe('v0.0.33.3 identity step2 迁移（squad_role mapper 接管身份正文）', () => {
  it('standalone（!sessionType）→ 落 Rocky identity（委托 IdentityHandler，不变）', () => {
    const out = new IdentityMapper('identity', {}).map(mkCtx());
    expect(out).toHaveLength(1);
    expect(out[0]!.tier).toBe('stable');
    expect(out[0]!.priority).toBe(1000);
    expect(out[0]!.content).toMatch(/Rocky/i);
  });

  // [BUG-004] playground kind 必传后 kind.role='rocky'（区别于上一条「省略 kind」的旧写法）
  // 也须归一化为 standalone，落 identity.md 正文；回归前该分支误落 studio「返空」分支
  it("playground（kind.role='rocky'，非省略 kind）→ 落 Rocky identity 正文（BUG-004 回归）", () => {
    const out = new IdentityMapper('identity', {}).map(mkCtx({ sessionType: 'rocky' }));
    expect(out).toHaveLength(1);
    expect(out[0]!.content.length).toBeGreaterThan(0);
    expect(out[0]!.content).toMatch(/Rocky/i);
  });

  it('subagent → 落 config.systemPrompt（explorer 模板人设，不变）', () => {
    const explorerPersona = 'You are Explorer, a focused research subagent.';
    const out = new IdentityMapper('identity', {}).map(
      mkCtx({ sessionType: 'subagent', systemPrompt: explorerPersona }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe(explorerPersona);
    expect(out[0]!.content).not.toMatch(/Rocky/i);
  });

  it('leader → 返空（v0.0.33.3 step2：squad_role mapper 接管身份正文）', () => {
    const out = new IdentityMapper('identity', {}).map(
      mkCtx({ sessionType: 'leader', systemPrompt: 'legacy-prompt' }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe('');
  });

  it('mate → 返空（v0.0.33.3 step2：squad_role mapper 接管身份正文）', () => {
    const out = new IdentityMapper('identity', {}).map(
      mkCtx({ sessionType: 'mate', systemPrompt: 'legacy-prompt' }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe('');
  });

  it('squad → 返空（v0.0.33.3 step2：squad_role mapper 接管路由器人设）', () => {
    const out = new IdentityMapper('identity', {}).map(
      mkCtx({ sessionType: 'squad', systemPrompt: 'legacy-router-prompt' }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe('');
  });
});

// ============================================================
// 3. subagent identity 接通（缺口兜底：subAgentConfig.systemPrompt → config.systemPrompt → identity → LLM）
// ============================================================
describe('v0.0.33.2 subagent identity 接通（D9 修路径）', () => {
  it('explorer 人设经 config.systemPrompt 抵达 identity mapper content', () => {
    // 模拟 spawn 链路：subAgentConfig.systemPrompt 已落 config.systemPrompt（session-config.ts）
    const explorerPersona =
      'You are an Explorer subagent. Investigate the codebase and report findings. Do not make changes.';
    const out = new IdentityMapper('identity', {}).map(
      mkCtx({ sessionType: 'subagent', systemPrompt: explorerPersona }),
    );
    // identity fragment 的 content = explorerPersona（修前会被 Rocky identity 覆盖从没到 LLM）
    expect(out[0]!.content).toBe(explorerPersona);
    expect(out[0]!.content).toContain('Explorer');
    expect(out[0]!.content).not.toMatch(/Rocky/i);
  });
});

// ============================================================
// 4. reachable_agents reminder（4 scope 拓扑 + user 永不在）
// ============================================================
describe('v0.0.33.2 reachable_agents reminder（a2a §3 派生表）', () => {
  it('standalone（!sessionType）→ []（无 a2a 对端）', () => {
    const out = new ReachableAgentsReminderProvider('reachable_agents', {}).provide(mkCtx());
    expect(out).toEqual([]);
  });

  // [BUG-004] playground kind.role='rocky'（非省略 kind）行为回归不变：仍 []（正向匹配调用方不受影响）
  it("playground（kind.role='rocky'）→ []（同 standalone，回归不变）", () => {
    const out = new ReachableAgentsReminderProvider('reachable_agents', {}).provide(
      mkCtx({ sessionType: 'rocky' }),
    );
    expect(out).toEqual([]);
  });

  it('squad → [leader, ...all mates]（群聊路由对端，不含 squadchat=self）', () => {
    const out = new ReachableAgentsReminderProvider('reachable_agents', {}).provide(
      mkCtx({ sessionType: 'squad', studioContext: mkStudioCtx() }),
    );
    expect(out).toHaveLength(1);
    const content = out[0]!.content;
    expect(content).toContain('alice'); // leader
    expect(content).toContain('bob'); // mate
    expect(content).toContain('carol'); // mate
    expect(content).toContain('01SL'); // leader sessionId
    // squad 自身即 squadchat，不在自己列表里
    expect(content).not.toContain(SQUADCHAT_SID);
  });

  it('leader → [squadchat, ...mates]（不含 leader 自己）', () => {
    const out = new ReachableAgentsReminderProvider('reachable_agents', {}).provide(
      mkCtx({ sessionType: 'leader', memberId: LEADER.id, studioContext: mkStudioCtx(LEADER.id) }),
    );
    expect(out).toHaveLength(1);
    const content = out[0]!.content;
    expect(content).toContain(SQUADCHAT_SID); // squadchat 可达
    expect(content).toContain('bob'); // mate 可达
    expect(content).toContain('carol'); // mate 可达
    // leader 不含自己
    expect(content).not.toContain('01SL');
  });

  it('mate → [squadchat, leader, ...peers]（不含 mate 自己）', () => {
    const out = new ReachableAgentsReminderProvider('reachable_agents', {}).provide(
      mkCtx({ sessionType: 'mate', memberId: MATE_A.id, studioContext: mkStudioCtx(MATE_A.id) }),
    );
    expect(out).toHaveLength(1);
    const content = out[0]!.content;
    expect(content).toContain(SQUADCHAT_SID); // squadchat
    expect(content).toContain('alice'); // leader
    expect(content).toContain('carol'); // peer mate (bob 自己排除)
    // bob（self）不在自己的 reachable 列表
    expect(content).not.toContain('01SA');
  });

  it('subagent → [parent]（拓扑硬约束仅 parent）', () => {
    const out = new ReachableAgentsReminderProvider('reachable_agents', {}).provide(
      mkCtx({
        sessionType: 'subagent',
        agentToolContext: {
          parentSessionId: '01PARENT',
          parent: { type: 'mate', sessionId: '01PARENT', name: 'bob' },
        },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('01PARENT');
  });

  it('subagent 仅 parentSessionId（无 canonical parent ref）→ [parent]', () => {
    const out = new ReachableAgentsReminderProvider('reachable_agents', {}).provide(
      mkCtx({
        sessionType: 'subagent',
        agentToolContext: { parentSessionId: '01P2' },
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain('01P2');
  });

  it('硬约束：user 永不在任何 reachable_agents 列表（4 scope 全验）', () => {
    const types: Array<{ type: string; memberId?: string; studio: boolean }> = [
      { type: 'squad', studio: true },
      { type: 'leader', memberId: LEADER.id, studio: true },
      { type: 'mate', memberId: MATE_A.id, studio: true },
    ];
    for (const t of types) {
      const ctx = mkCtx({
        sessionType: t.type,
        ...(t.memberId ? { memberId: t.memberId } : {}),
        ...(t.studio ? { studioContext: mkStudioCtx(t.memberId) } : {}),
      });
      const out = new ReachableAgentsReminderProvider('reachable_agents', {}).provide(ctx);
      if (out.length === 0) continue;
      // reminder 正文绝不出现 "user" 作为对端 type
      expect(out[0]!.content).not.toMatch(/\(user,/i);
      expect(out[0]!.content).not.toMatch(/send_message.*user/is);
    }
    // subagent 同理
    const subOut = new ReachableAgentsReminderProvider('reachable_agents', {}).provide(
      mkCtx({
        sessionType: 'subagent',
        agentToolContext: { parentSessionId: '01P' },
      }),
    );
    expect(subOut[0]!.content).not.toMatch(/\(user,/i);
  });

  it('squad sessionType 但无 studioContext（数据未注入）→ []（graceful）', () => {
    const out = new ReachableAgentsReminderProvider('reachable_agents', {}).provide(
      mkCtx({ sessionType: 'squad' }),
    );
    expect(out).toEqual([]);
  });
});

// ============================================================
// 5. bench 过滤（认知/协作层只看 deployed；判据 state !== 'benched'，state 缺失按 deployed 兼容）
// ============================================================
describe('bench 过滤（team_roster + reachable_agents 只看 deployed）', () => {
  const BENCHED = mkMember({ id: 'mem-d', name: 'dave', role: 'mate', sessionId: '01SD', state: 'benched' });
  const MEMBERS_WITH_BENCH = [...ALL_MEMBERS, BENCHED];

  it('team_roster：含 benched 成员的 roster 不渲染之（其余成员照常）', () => {
    const out = new TeamRosterMapper('team_roster', {}).map(
      mkCtx({ sessionType: 'leader', studioContext: { members: MEMBERS_WITH_BENCH } }),
    );
    expect(out).toHaveLength(1);
    const content = out[0]!.content;
    expect(content).toContain('alice');
    expect(content).toContain('bob');
    expect(content).toContain('carol');
    expect(content).not.toContain('dave');
    expect(content).not.toContain('01SD');
  });

  it('team_roster 兜底单条分支：当前 member 为 benched → []（同一判据）', () => {
    const out = new TeamRosterMapper('team_roster', {}).map(
      mkCtx({ sessionType: 'mate', studioContext: { member: BENCHED } }),
    );
    expect(out).toEqual([]);
  });

  it('reachable_agents：squad/leader/mate 三分支均不含 benched 对端', () => {
    const studio = { ...mkStudioCtx(), members: MEMBERS_WITH_BENCH };
    const cases: Array<Record<string, unknown>> = [
      { sessionType: 'squad', studioContext: studio },
      { sessionType: 'leader', memberId: LEADER.id, studioContext: { ...studio, member: LEADER } },
      { sessionType: 'mate', memberId: MATE_A.id, studioContext: { ...studio, member: MATE_A } },
    ];
    for (const c of cases) {
      const out = new ReachableAgentsReminderProvider('reachable_agents', {}).provide(mkCtx(c));
      expect(out).toHaveLength(1);
      const content = out[0]!.content;
      expect(content).not.toContain('dave');
      expect(content).not.toContain('01SD');
    }
  });

  it('state 缺失的成员按 deployed 对待仍可见（兼容旧数据）', () => {
    // ALL_MEMBERS 均无 state 字段 → roster 与 reachable 均照常渲染
    const roster = new TeamRosterMapper('team_roster', {}).map(
      mkCtx({ sessionType: 'leader', studioContext: mkStudioCtx(LEADER.id) }),
    );
    expect(roster[0]!.content).toContain('bob');
    const reachable = new ReachableAgentsReminderProvider('reachable_agents', {}).provide(
      mkCtx({ sessionType: 'squad', studioContext: mkStudioCtx() }),
    );
    expect(reachable[0]!.content).toContain('bob');
    expect(reachable[0]!.content).toContain('carol');
  });

  it('全 deployed（显式 state）输出与无 state 现状逐字节一致（回归）', () => {
    const deployedMembers = ALL_MEMBERS.map((m) => ({ ...m, state: 'deployed' }));
    const rosterNew = new TeamRosterMapper('team_roster', {}).map(
      mkCtx({ sessionType: 'leader', studioContext: { ...mkStudioCtx(LEADER.id), members: deployedMembers } }),
    );
    const rosterOld = new TeamRosterMapper('team_roster', {}).map(
      mkCtx({ sessionType: 'leader', studioContext: mkStudioCtx(LEADER.id) }),
    );
    expect(rosterNew[0]!.content).toBe(rosterOld[0]!.content);
    const reachNew = new ReachableAgentsReminderProvider('reachable_agents', {}).provide(
      mkCtx({ sessionType: 'mate', memberId: MATE_A.id, studioContext: { ...mkStudioCtx(MATE_A.id), members: deployedMembers } }),
    );
    const reachOld = new ReachableAgentsReminderProvider('reachable_agents', {}).provide(
      mkCtx({ sessionType: 'mate', memberId: MATE_A.id, studioContext: mkStudioCtx(MATE_A.id) }),
    );
    expect(reachNew[0]!.content).toBe(reachOld[0]!.content);
  });
});
