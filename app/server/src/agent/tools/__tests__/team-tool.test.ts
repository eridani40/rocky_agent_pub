/**
 * team 工具 UT
 * 参考: specs/tech/squad/[P1]squad_tools.md §2（team 工具 6 action 全表）
 *
 * 覆盖：
 *   - action 枚举（完整 6 action：只读 2 + 写 4）
 *   - selfType 权限：squad/standalone reject；leader/mate 只读；写 action leader/user only
 *   - squad 上下文完整性（selfSquadId + squadStore + memberStore 缺一不可）
 *   - list / query 行为
 *
 * 写 action (hire/deploy/bench/edit) 的完整 dispatch + 各 action 行为
 * 由 team-write-actions.test.ts 覆盖（避免冗余），本文件只验 action 合法性 + 权限门。
 * 白盒：mock rtc（selfType + selfSquadId + squadStore/memberStore mock），验证 action 分派 + 权限。
 */
import { describe, it, expect } from 'vitest';
import { teamTool } from '../team-tool';
import type { ToolCtx, ToolInput } from '../../../tools/types';
import type { AgentToolRuntimeContext } from '../runtime-context';

/** 构造 mock rtc：selfType + squadStore/memberStore mock（list/query 用） */
function makeRtc(opts: {
  selfType?: AgentToolRuntimeContext['selfType'];
  selfSquadId?: string;
  squad?: Record<string, unknown> | undefined;
  members?: Array<Record<string, unknown>>;
}): AgentToolRuntimeContext {
  const squad = opts.squad ?? {
    id: 'SQUAD-A',
    name: 'alpha',
    squadChatSessionId: 'SQUADCHAT-1',
    leaderId: 'LEADER-MID',
  };
  const members = opts.members ?? [
    {
      id: 'LEADER-MID',
      squadId: 'SQUAD-A',
      sessionId: 'LEADER-SID',
      name: 'alice',
      role: 'leader',
      skills: ['planning'],
      tools: ['send_message', 'team'],
      model: 'claude-sonar',
      state: 'deployed',
    },
    {
      id: 'MATE-MID-1',
      squadId: 'SQUAD-A',
      sessionId: 'MATE-SID-1',
      name: 'bob',
      role: 'mate',
      skills: ['coding'],
      tools: ['read', 'write', 'send_message'],
      model: 'gpt-worker',
      state: 'deployed',
    },
  ];
  return {
    parentSessionId: 'PARENT-1',
    parentRunId: 'r',
    parentType: undefined,
    parentName: 'p',
    parentScope: undefined,
    selfSessionId: 'SELF-1',
    selfType: opts.selfType,
    selfName: 'self',
    ...(opts.selfSquadId !== undefined ? { selfSquadId: opts.selfSquadId } : {}),
    squadStore: {
      getSquad: async () => squad as never,
    } as never,
    memberStore: {
      listMembers: async () => members as never,
    } as never,
    agentManager: {} as never,
    store: {} as never,
    sessionDeps: {} as never,
  };
}

/** 调 teamTool.run 并返回 { text, isError, parsed? } */
async function runTeam(
  rtc: AgentToolRuntimeContext,
  inputFields: Record<string, unknown>,
): Promise<{ text: string; isError: boolean; parsed: unknown }> {
  const ctx: ToolCtx = { config: { agentToolContext: rtc } } as unknown as ToolCtx;
  const input: ToolInput = inputFields as unknown as ToolInput;
  const res = await teamTool.run(input, ctx);
  const blocks = (res.content ?? []) as Array<{ type?: string; text?: string }>;
  const text = blocks.map((b) => b?.text ?? '').join('');
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { text, isError: res.isError, parsed };
}

// ============================================================
// 1. selfType 权限校验（defense-in-depth 双重门）
// ============================================================
describe('team 工具 selfType 权限（架构 §2.H）', () => {
  it('squad (SquadChat) session → reject（schema 层裁剪 + 工具层双重门）', async () => {
    const rtc = makeRtc({ selfType: 'squad', selfSquadId: 'SQUAD-A' });
    const { isError, text } = await runTeam(rtc, { action: 'list' });
    expect(isError).toBe(true);
    expect(text).toMatch(/squad.*cannot use team tool/i);
  });

  it('standalone session (selfType=undefined) → reject', async () => {
    const rtc = makeRtc({ selfType: undefined, selfSquadId: undefined });
    const { isError, text } = await runTeam(rtc, { action: 'list' });
    expect(isError).toBe(true);
    expect(text).toMatch(/only leader\/mate/i);
  });

  it('subagent session → reject（subagent 不持有 team 工具）', async () => {
    const rtc = makeRtc({ selfType: 'subagent', selfSquadId: undefined });
    const { isError, text } = await runTeam(rtc, { action: 'query', query: { ref: 'alice' } });
    expect(isError).toBe(true);
    expect(text).toMatch(/only leader\/mate/i);
  });

  it('leader caller → 允许（leader 可读 team 信息）', async () => {
    const rtc = makeRtc({ selfType: 'leader', selfSquadId: 'SQUAD-A' });
    const { isError } = await runTeam(rtc, { action: 'list' });
    expect(isError).toBe(false);
  });

  it('mate caller → 允许（mate 也可只读 team，squad_tools §2 注）', async () => {
    const rtc = makeRtc({ selfType: 'mate', selfSquadId: 'SQUAD-A' });
    const { isError } = await runTeam(rtc, { action: 'list' });
    expect(isError).toBe(false);
  });
});

// ============================================================
// 2. action 枚举（6 action：只读 2 + 写 4）
// ============================================================
describe('team 工具 action 枚举（6 action）', () => {
  const rtc = makeRtc({ selfType: 'leader', selfSquadId: 'SQUAD-A' });

  it('action=list → 接受', async () => {
    const { isError } = await runTeam(rtc, { action: 'list' });
    expect(isError).toBe(false);
  });

  it('action=query → 接受', async () => {
    const { isError } = await runTeam(rtc, { action: 'query', query: { ref: 'alice' } });
    expect(isError).toBe(false);
  });

  it('写 action (hire/deploy/bench/edit) → 合法 action，leader 调不再返 invalid（dispatch 行为由 team-write-actions.test.ts 覆盖）', async () => {
    for (const action of ['hire', 'deploy', 'bench', 'edit'] as const) {
      const { text } = await runTeam(rtc, { action });
      expect(text).not.toMatch(/invalid action/i);
    }
  });

  it('写 action (hire/deploy/bench/edit) → mate 调 → forbidden（合法 action 但 leader/user only）', async () => {
    const mateRtc = makeRtc({ selfType: 'mate', selfSquadId: 'SQUAD-A' });
    for (const action of ['hire', 'deploy', 'bench', 'edit'] as const) {
      const { isError, text } = await runTeam(mateRtc, { action });
      expect(isError).toBe(true);
      expect(text).toMatch(/forbidden/i);
    }
  });

  it('action=get_charter/update_charter → invalid（已删 action）', async () => {
    for (const action of ['get_charter', 'update_charter'] as const) {
      const { isError, text } = await runTeam(rtc, { action });
      expect(isError).toBe(true);
      expect(text).toMatch(/invalid action/i);
    }
  });

  it('action 缺失 → reject', async () => {
    const { isError } = await runTeam(rtc, {});
    expect(isError).toBe(true);
  });

  it('action 空字串 → reject', async () => {
    const { isError } = await runTeam(rtc, { action: '' });
    expect(isError).toBe(true);
  });
});

// ============================================================
// 3. list / query 行为
// ============================================================
describe('team.list 列成员', () => {
  it('返 squad 内全部 member 摘要（id/name/role/state）', async () => {
    const rtc = makeRtc({ selfType: 'mate', selfSquadId: 'SQUAD-A' });
    const { isError, parsed } = await runTeam(rtc, { action: 'list' });
    expect(isError).toBe(false);
    const arr = parsed as Array<Record<string, unknown>>;
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBe(2);
    expect(arr[0]!.name).toBe('alice');
    expect(arr[0]!.role).toBe('leader');
    expect(arr[1]!.name).toBe('bob');
    expect(arr[1]!.role).toBe('mate');
  });
});

describe('team.query 单成员详情', () => {
  const rtc = makeRtc({ selfType: 'leader', selfSquadId: 'SQUAD-A' });

  it('ref=memberId → 命中（id 匹配）', async () => {
    const { isError, parsed } = await runTeam(rtc, {
      action: 'query',
      query: { ref: 'MATE-MID-1' },
    });
    expect(isError).toBe(false);
    expect((parsed as Record<string, unknown>).name).toBe('bob');
    expect((parsed as Record<string, unknown>).role).toBe('mate');
  });

  it('ref=member.name → 命中（name 匹配）', async () => {
    const { isError, parsed } = await runTeam(rtc, {
      action: 'query',
      query: { ref: 'alice' },
    });
    expect(isError).toBe(false);
    expect((parsed as Record<string, unknown>).id).toBe('LEADER-MID');
  });

  it('ref 0 匹配 → reject', async () => {
    const { isError, text } = await runTeam(rtc, {
      action: 'query',
      query: { ref: 'nobody' },
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/no member matches/i);
  });

  it('ref 缺失 → reject', async () => {
    const { isError, text } = await runTeam(rtc, { action: 'query', query: {} });
    expect(isError).toBe(true);
    expect(text).toMatch(/ref.*required/i);
  });
});

// ============================================================
// 4. squad 上下文完整性校验
// ============================================================
describe('team 工具 squad 上下文完整性', () => {
  it('缺 selfSquadId → reject', async () => {
    const rtc = makeRtc({ selfType: 'leader', selfSquadId: undefined });
    const { isError, text } = await runTeam(rtc, { action: 'list' });
    expect(isError).toBe(true);
    expect(text).toMatch(/missing squad context/i);
  });

  it('缺 squadStore → reject', async () => {
    const rtc = makeRtc({ selfType: 'leader', selfSquadId: 'SQUAD-A' });
    rtc.squadStore = undefined;
    const { isError, text } = await runTeam(rtc, { action: 'list' });
    expect(isError).toBe(true);
    expect(text).toMatch(/missing squad context/i);
  });

  it('缺 memberStore → reject', async () => {
    const rtc = makeRtc({ selfType: 'leader', selfSquadId: 'SQUAD-A' });
    rtc.memberStore = undefined;
    const { isError, text } = await runTeam(rtc, { action: 'list' });
    expect(isError).toBe(true);
    expect(text).toMatch(/missing squad context/i);
  });
});

// ============================================================
// 5. definition 自描述（schema 层契约）
// ============================================================
describe('team 工具 definition（schema 契约）', () => {
  it('name = "team"', () => {
    expect(teamTool.definition.name).toBe('team');
  });

  it('action enum = 7 action（只读 2 + 写 5；v0.0.282 加 reset）', () => {
    const actionSchema = teamTool.definition.inputSchema.properties
      ?.action as { enum?: string[] };
    expect(actionSchema?.enum).toEqual(['list', 'query', 'hire', 'deploy', 'bench', 'edit', 'reset']);
  });

  it('description 标注写 action（hire/deploy/bench/edit）', () => {
    expect(teamTool.definition.description).toMatch(/hire/i);
    expect(teamTool.definition.description).toMatch(/deploy/i);
    expect(teamTool.definition.description).toMatch(/bench/i);
    expect(teamTool.definition.description).toMatch(/edit/i);
  });
});
