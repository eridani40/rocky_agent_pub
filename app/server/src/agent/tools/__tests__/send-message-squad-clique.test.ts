/**
 * send_message squad clique 校验 UT（v0.0.33.2 T5）
 * 参考: specs/tech/version_logs/v0.0.33.2/change_log.md §2.F 改动1（squad clique 拓扑校验）
 *       specs/tech/multi_agent/[P1]a2a_protocol.md §2.2（别名解析优先级）+ §6（工具层校验）
 *
 * 锁定的 T5 改动：
 *   - checkReachable 三层分流：subagent→parent 既有硬约束 + squad clique + 顶层 standalone
 *   - checkSquadClique：同 squad 4 type 互相可达；跨 squad 拒绝；target 非 clique type 拒绝
 *   - resolveAgentRefWithSquad：a2a §2.2 优先级 3/4/5 别名（'squadchat'/'leader'/member name）
 *
 * 白盒：mock rtc（selfType∈{squad,leader,mate,subagent,undefined}）+ mock store.getSession
 *      返回 target session（控制 squadId/type），验证 checkReachable 的拒绝/允许。
 */
import { describe, it, expect } from 'vitest';
import { sendMessageTool } from '../send-message-tool';
import {
  resolveAgentRefWithSquad,
  type AgentToolRuntimeContext,
} from '../runtime-context';
import type { ToolCtx, ToolInput } from '../../../tools/types';
import type { Message } from '../../../message/types';
import type { Session } from '../../session-store-types';

/** 构造 mock Session（target lookup 返回值） */
function makeSession(opts: {
  sid: string;
  squadId?: string;
  role?: Session['role'];
  derivation?: Session['derivation'];
}): Session {
  return {
    id: opts.sid,
    status: 'active',
    state: 'idle',
    running: false,
    currentRunId: null,
    unread: false,
    workspaceDir: '',
    createdAt: '',
    updatedAt: '',
    version: 1,
    ...(opts.squadId !== undefined ? { squadId: opts.squadId } : {}),
    ...(opts.role !== undefined ? { role: opts.role } : {}),
    ...(opts.derivation !== undefined ? { derivation: opts.derivation } : {}),
  };
}

/**
 * 构造 mock rtc。store.getSession 接受一个 map（sid → Session），deliverTo 捕获投递消息。
 * 默认 caller=selfSid（self 身份由调用方设）。
 */
function makeRtc(
  opts: {
    selfType?: AgentToolRuntimeContext['selfType'];
    parentScope?: AgentToolRuntimeContext['parentScope'];
    selfSquadId?: string;
    parentSessionId?: string;
    selfSessionId?: string;
    targetSessions?: Record<string, Session>;
  },
  captured?: { delivered: Message | null },
): AgentToolRuntimeContext {
  const sessions = opts.targetSessions ?? {};
  return {
    parentSessionId: opts.parentSessionId ?? 'PARENT-DEFAULT',
    parentRunId: 'r',
    parentType: undefined,
    parentName: 'p',
    parentScope: opts.parentScope,
    selfSessionId: opts.selfSessionId ?? 'SELF-001',
    selfType: opts.selfType,
    selfName: 'self',
    ...(opts.selfSquadId !== undefined ? { selfSquadId: opts.selfSquadId } : {}),
    agentManager: {
      deliverTo: async (_sid: string, msg: Message) => {
        if (captured) captured.delivered = msg;
        return { sessionId: _sid, runId: 'r', state: 'running', promise: Promise.resolve({} as never) } as never;
      },
    } as never,
    store: {
      getSession: async (sid: string) => sessions[sid] as Session | undefined,
    } as never,
    sessionDeps: {} as never,
  };
}

/** 调 sendMessageTool.run 并返回结果（isError + text） */
async function runSend(
  rtc: AgentToolRuntimeContext,
  inputFields: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const ctx: ToolCtx = { config: { agentToolContext: rtc } } as unknown as ToolCtx;
  const input: ToolInput = inputFields as unknown as ToolInput;
  const res = await sendMessageTool.run(input, ctx);
  const blocks = (res.content ?? []) as Array<{ type?: string; text?: string }>;
  return { text: blocks.map((b) => b?.text ?? '').join(''), isError: res.isError };
}

// ============================================================
// 1. squad clique 校验（checkReachable 分流 2）
// ============================================================
describe('send_message squad clique 校验（架构 §2.F 改动1）', () => {
  it('leader caller → 同 squad leader/mate/squad target 允许（同 clique 互相可达）', async () => {
    const rtc = makeRtc({
      selfType: 'leader',
      selfSquadId: 'SQUAD-A',
      targetSessions: {
        'MATE-1': makeSession({ sid: 'MATE-1', squadId: 'SQUAD-A', role: 'mate' }),
        'LEADER-2': makeSession({ sid: 'LEADER-2', squadId: 'SQUAD-A', role: 'leader' }),
        'SQUADCHAT-1': makeSession({ sid: 'SQUADCHAT-1', squadId: 'SQUAD-A', role: 'squad' }),
      },
    });
    for (const target of ['MATE-1', 'LEADER-2', 'SQUADCHAT-1']) {
      const { isError } = await runSend(rtc, {
        target,
        content: [{ type: 'text', text: 'hi' }],
        needReply: false,
      });
      expect(isError, `target=${target} 应允许`).toBe(false);
    }
  });

  it('mate caller → 同 squad peer mate + leader + squadchat 允许', async () => {
    const rtc = makeRtc({
      selfType: 'mate',
      selfSquadId: 'SQUAD-A',
      targetSessions: {
        'PEER-MATE': makeSession({ sid: 'PEER-MATE', squadId: 'SQUAD-A', role: 'mate' }),
      },
    });
    const { isError } = await runSend(rtc, {
      target: 'PEER-MATE',
      content: [{ type: 'text', text: 'peer hi' }],
      needReply: true,
    });
    expect(isError).toBe(false);
  });

  it('squad (SquadChat) caller → 同 squad leader 允许（路由出口）', async () => {
    const rtc = makeRtc({
      selfType: 'squad',
      selfSquadId: 'SQUAD-A',
      targetSessions: {
        'LEADER-1': makeSession({ sid: 'LEADER-1', squadId: 'SQUAD-A', role: 'leader' }),
      },
    });
    const { isError } = await runSend(rtc, {
      target: 'LEADER-1',
      content: [{ type: 'text', text: 'route to leader' }],
      needReply: true,
    });
    expect(isError).toBe(false);
  });

  it('跨 squad 拒绝：caller selfSquadId=SQUAD-A, target.squadId=SQUAD-B', async () => {
    const rtc = makeRtc({
      selfType: 'leader',
      selfSquadId: 'SQUAD-A',
      targetSessions: {
        'OTHER-SQUAD-MATE': makeSession({ sid: 'OTHER-SQUAD-MATE', squadId: 'SQUAD-B', role: 'mate' }),
      },
    });
    const { isError, text } = await runSend(rtc, {
      target: 'OTHER-SQUAD-MATE',
      content: [{ type: 'text', text: 'cross squad?' }],
      needReply: false,
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/cross-squad a2a not allowed/i);
  });

  it('target.role=subagent → 拒绝（subagent 不在 squad clique）', async () => {
    const rtc = makeRtc({
      selfType: 'leader',
      selfSquadId: 'SQUAD-A',
      targetSessions: {
        'CHILD-SUB': makeSession({ sid: 'CHILD-SUB', squadId: 'SQUAD-A', role: 'rocky', derivation: 'subagent' }),
      },
    });
    const { isError, text } = await runSend(rtc, {
      target: 'CHILD-SUB',
      content: [{ type: 'text', text: 'to subagent?' }],
      needReply: false,
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/target not in squad clique/i);
  });

  it('target.role=undefined（standalone session）→ 拒绝（非 clique type）', async () => {
    const rtc = makeRtc({
      selfType: 'mate',
      selfSquadId: 'SQUAD-A',
      targetSessions: {
        'STANDALONE-1': makeSession({ sid: 'STANDALONE-1', squadId: 'SQUAD-A' }),
      },
    });
    const { isError, text } = await runSend(rtc, {
      target: 'STANDALONE-1',
      content: [{ type: 'text', text: 'hi' }],
      needReply: false,
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/target not in squad clique/i);
  });

  it('target session 不存在 → 拒绝（defense-in-depth，防 deliverTo 幽灵 session）', async () => {
    const rtc = makeRtc({
      selfType: 'leader',
      selfSquadId: 'SQUAD-A',
      targetSessions: {}, // 目标不在 map
    });
    const { isError, text } = await runSend(rtc, {
      target: 'GHOST-SESSION',
      content: [{ type: 'text', text: 'hi' }],
      needReply: false,
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/target session not found/i);
  });
});

// ============================================================
// 2. 既有 subagent→parent 拦截 + 顶层 standalone 不变（回归保护）
// ============================================================
describe('send_message 既有不变量（v0.0.28 拓扑 + standalone 回归保护）', () => {
  it('subagent caller (parentScope=subagent) 仍仅可达 parent（既有硬约束不破坏）', async () => {
    const rtc = makeRtc({
      selfType: 'subagent',
      parentScope: 'subagent',
      parentSessionId: 'PARENT-REAL',
      targetSessions: {},
    });
    // 向非 parent → 拒绝
    const r1 = await runSend(rtc, {
      target: 'OTHER-SESSION',
      content: [{ type: 'text', text: 'hi' }],
      needReply: false,
    });
    expect(r1.isError).toBe(true);
    expect(r1.text).toMatch(/subagent can only send to parent/i);
    // 向 parent → 允许
    const r2 = await runSend(rtc, {
      target: 'parent',
      content: [{ type: 'text', text: 'hi parent' }],
      needReply: false,
    });
    expect(r2.isError).toBe(false);
  });

  it('顶层 standalone（selfType=undefined, parentScope=undefined）不进 squad 分支（不拦）', async () => {
    const rtc = makeRtc({
      selfType: undefined,
      parentScope: undefined,
      selfSquadId: undefined,
      targetSessions: {},
    });
    const { isError } = await runSend(rtc, {
      target: 'ANYWHERE-001',
      content: [{ type: 'text', text: 'hi' }],
      needReply: false,
    });
    expect(isError).toBe(false); // 顶层不拦（无 a2a 拓扑校验）
  });

  it('squad clique caller 缺 selfSquadId → 拒绝（配置异常 defense-in-depth）', async () => {
    const rtc = makeRtc({
      selfType: 'leader',
      selfSquadId: undefined, // 异常：leader 应有 selfSquadId
      targetSessions: {
        'MATE-X': makeSession({ sid: 'MATE-X', squadId: 'SQUAD-A', role: 'mate' }),
      },
    });
    const { isError, text } = await runSend(rtc, {
      target: 'MATE-X',
      content: [{ type: 'text', text: 'hi' }],
      needReply: false,
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/selfSquadId/i);
  });
});

// ============================================================
// 3. resolveAgentRefWithSquad 别名解析（a2a §2.2 优先级 1-5）
// ============================================================
describe('resolveAgentRefWithSquad 别名解析（架构 §2.F 改动3）', () => {
  /** 构造带 squadStore/memberStore mock 的 rtc（resolveAgentRefWithSquad 用） */
  function makeSquadRtc(opts: {
    selfSquadId?: string;
    squad?: Record<string, unknown>;
    leaderMember?: Record<string, unknown>;
    members?: Array<Record<string, unknown>>;
    parentSessionId?: string;
  }): AgentToolRuntimeContext {
    const squad = {
      id: opts.selfSquadId ?? 'SQUAD-A',
      squadChatSessionId: 'SQUADCHAT-1',
      leaderId: 'LEADER-MID',
      ...(opts.squad ?? {}),
    };
    const leaderMember = {
      id: 'LEADER-MID',
      sessionId: 'LEADER-SID',
      name: 'alice',
      ...(opts.leaderMember ?? {}),
    };
    const members = opts.members ?? [
      { id: 'LEADER-MID', sessionId: 'LEADER-SID', name: 'alice' },
      { id: 'MATE-MID-1', sessionId: 'MATE-SID-1', name: 'bob' },
    ];
    return {
      parentSessionId: opts.parentSessionId ?? 'PARENT-1',
      parentRunId: 'r',
      parentType: undefined,
      parentName: 'p',
      parentScope: undefined,
      selfSessionId: 'SELF-1',
      selfType: 'leader',
      selfName: 'self',
      ...(opts.selfSquadId !== undefined ? { selfSquadId: opts.selfSquadId } : {}),
      squadStore: {
        getSquad: async () => squad,
      } as never,
      memberStore: {
        getMember: async (_sid: string, mid: string) =>
          mid === squad.leaderId ? leaderMember : undefined,
        listMembers: async () => members,
      } as never,
      agentManager: {} as never,
      store: {} as never,
      sessionDeps: {} as never,
    };
  }

  it('优先级 1：sessionId 字串直传（同步部分命中）', async () => {
    const rtc = makeSquadRtc({ selfSquadId: 'SQUAD-A' });
    const sid = await resolveAgentRefWithSquad('01KW5TEST0000000000000000AB', rtc);
    expect(sid).toBe('01KW5TEST0000000000000000AB');
  });

  it('优先级 2："parent" 别名 → callerParentSessionId（同步部分命中）', async () => {
    // [round-3 BUG-3] 'parent' 仅 subagent selfType 有效（a2a 拓扑 subagent→parent）；
    //   顶层 session（selfType≠subagent）无 a2a parent → 返 null（防 parentSessionId self-fallback 自环）
    const rtcSub = makeRtc({ selfType: 'subagent', parentSessionId: 'PARENT-XX' });
    const sidSub = await resolveAgentRefWithSquad('parent', rtcSub);
    expect(sidSub).toBe('PARENT-XX');
    // 顶层 mate（selfType=mate）→ 'parent' 解析为 null（不再 fallback self）
    const rtcMate = makeRtc({ selfType: 'mate', selfSquadId: 'SQUAD-A', parentSessionId: 'PARENT-XX' });
    const sidMate = await resolveAgentRefWithSquad('parent', rtcMate);
    expect(sidMate).toBeNull();
  });

  it('AgentRef struct → sessionId 权威（同步部分命中）', async () => {
    const rtc = makeSquadRtc({ selfSquadId: 'SQUAD-A' });
    const sid = await resolveAgentRefWithSquad(
      { role: 'mate', sessionId: 'STRUCT-SID', name: 'x' },
      rtc,
    );
    expect(sid).toBe('STRUCT-SID');
  });

  it('优先级 3："squadchat" → squad.squadChatSessionId', async () => {
    const rtc = makeSquadRtc({ selfSquadId: 'SQUAD-A' });
    const sid = await resolveAgentRefWithSquad('squadchat', rtc);
    expect(sid).toBe('SQUADCHAT-1');
  });

  it('优先级 4："leader" → leader member.sessionId', async () => {
    const rtc = makeSquadRtc({ selfSquadId: 'SQUAD-A' });
    const sid = await resolveAgentRefWithSquad('leader', rtc);
    expect(sid).toBe('LEADER-SID');
  });

  it('优先级 5：member name 字串 → squad 内 name 唯一查找', async () => {
    const rtc = makeSquadRtc({ selfSquadId: 'SQUAD-A' });
    const sid = await resolveAgentRefWithSquad('bob', rtc);
    expect(sid).toBe('MATE-SID-1');
  });

  it('name 多匹配（歧义）→ resolveSquadAlias null，fallback 字串直传（由 checkSquadClique 后续拒）', async () => {
    const rtc = makeSquadRtc({
      selfSquadId: 'SQUAD-A',
      members: [
        { id: 'M1', sessionId: 'S1', name: 'dup' },
        { id: 'M2', sessionId: 'S2', name: 'dup' },
      ],
    });
    // 多匹配歧义：resolveSquadAlias 返 null（不歧义寻址，a2a §9 待定 #1）；fallback 当 sessionId 直传
    // 后续 send_message checkSquadClique 会拒（target session 'dup' 不存在）。
    const sid = await resolveAgentRefWithSquad('dup', rtc);
    expect(sid).toBe('dup');
  });

  it('name 0 匹配 → resolveSquadAlias null，fallback 字串直传', async () => {
    const rtc = makeSquadRtc({ selfSquadId: 'SQUAD-A' });
    const sid = await resolveAgentRefWithSquad('nobody', rtc);
    expect(sid).toBe('nobody');
  });

  it('caller 缺 selfSquadId → 不进 squad 别名分支，字串当 sessionId 直传（向后兼容 playground）', async () => {
    const rtc = makeSquadRtc({ selfSquadId: undefined });
    // 'squadchat' 在无 squad 上下文下走 fallback 字串直传（playground session 字串 target）
    const sid = await resolveAgentRefWithSquad('squadchat', rtc);
    expect(sid).toBe('squadchat');
  });

  it('squadStore.getSquad 返 undefined（squad 不存在）→ 别名解析失败，字串 fallback 直传', async () => {
    const rtc = makeSquadRtc({ selfSquadId: 'SQUAD-A' });
    rtc.squadStore = { getSquad: async () => undefined } as never;
    // squad 不存在时 resolveSquadAlias 返 null；字串 fallback 当 sessionId 直传
    const sid = await resolveAgentRefWithSquad('bob', rtc);
    expect(sid).toBe('bob');
  });

  it('"leader" 别名但 memberStore 未注入 → resolveSquadAlias 返 null，字串 fallback 直传', async () => {
    const rtc = makeSquadRtc({ selfSquadId: 'SQUAD-A' });
    rtc.memberStore = undefined; // 强制移除 memberStore
    // memberStore 缺失：resolveSquadAlias 'leader' 分支返 null；fallback 当 sessionId 直传
    const sid = await resolveAgentRefWithSquad('leader', rtc);
    expect(sid).toBe('leader');
  });
});
