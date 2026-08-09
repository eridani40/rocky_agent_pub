/**
 * runtime-context a2a 路由 UT（v0.0.28 BUG 回归锁）
 * 参考: specs/tech/multi_agent/[P1]a2a_protocol.md §2.2（target 别名解析）
 *       specs/tech/multi_agent/[P1]subagent_derivation.md §5（send_message 子→父）
 *       app/server/src/bootstrap.ts setBuildAgentToolContext（parentSessionId 取值）
 *
 * 锁定的 BUG：bootstrap.setBuildAgentToolContext 原把 parentSessionId 直接设为运行
 * session 的 sid（未取 session.parentSessionId ?? sessionId）。subagent 调
 * send_message(target='parent') 时 resolveAgentRef('parent', rtc.parentSessionId)
 * 解析成 subagent 自己 → deliverTo(self) → 消息投递回自身，parent transcript 永远
 * 收不到 a2a 回报（spawn_async_inherit_reply_tc1 暴露）。
 *
 * 修复：parentSessionId = session.parentSessionId ?? sessionId（顶层 fallback 自身；
 * subagent 取真 parent sid）。
 *
 * 本 UT 验证 resolveAgentRef 在「subagent rtc（parentSessionId=真 parent）」下把
 * 'parent' 别名解析到真 parent sid（而非 caller 自身 sid），锁住 a2a 路由正确性。
 */
import { describe, it, expect } from 'vitest';
import { resolveAgentRef, parentAgentRef, selfAgentRef, resolveAgentRefWithSquad } from '../runtime-context';
import type { AgentToolRuntimeContext } from '../runtime-context';

/**
 * 构造 subagent 的 rtc：parentSessionId = 真 parent sid（修复后语义）。
 * 修复前 buggy rtc 会把 parentSessionId 设为 subagent 自身 sid，本 UT 模拟修复后形态。
 */
function makeSubagentRtc(opts: { selfSid: string; parentSid: string }): AgentToolRuntimeContext {
  return {
    // 修复后：subagent 的 rtc.parentSessionId = session.parentSessionId（真 parent）
    parentSessionId: opts.parentSid,
    parentRunId: 'parent-run-001',
    parentType: 'subagent',
    parentName: 'subagent',
    parentScope: 'subagent',
    // [BUG-032] caller self 字段（send_message 发送方身份）：self=运行 session 自己
    selfSessionId: opts.selfSid,
    selfType: 'subagent',
    selfName: 'subagent',
    agentManager: {} as never,
    store: {} as never,
    sessionDeps: {} as never,
  };
}

describe('runtime-context: a2a target 别名解析（v0.0.28 BUG 回归锁）', () => {
  it('subagent rtc 下 resolveAgentRef("parent", ...) 解析到真 parent sid（非自身）', () => {
    // 场景：subagent（sid=CHILD-1）的 parent 是 PARENT-1
    const selfSid = 'CHILD-1';
    const parentSid = 'PARENT-1';
    const rtc = makeSubagentRtc({ selfSid, parentSid });

    // send_message(target='parent') 必须解析到 PARENT-1，不是 CHILD-1
    const resolved = resolveAgentRef('parent', rtc.parentSessionId);
    expect(resolved).toBe(parentSid);
    expect(resolved).not.toBe(selfSid);
  });

  it('subagent rtc 下 AgentRef struct {sessionId: parent} 仍走 sessionId 权威', () => {
    const rtc = makeSubagentRtc({ selfSid: 'CHILD-2', parentSid: 'PARENT-2' });
    // struct 形式：sessionId 权威（a2a_protocol §2.2）
    const resolved = resolveAgentRef({ type: 'subagent', sessionId: 'PARENT-2', name: 'p' }, rtc.parentSessionId);
    expect(resolved).toBe('PARENT-2');
  });

  it('subagent rtc 下字串 sessionId（ULID）直传不替换', () => {
    const rtc = makeSubagentRtc({ selfSid: 'CHILD-3', parentSid: 'PARENT-3' });
    // 显式 sid 字串：透传（a2a_protocol §2.2 字串分支）
    const resolved = resolveAgentRef('01KW5TEST00000000000000000X', rtc.parentSessionId);
    expect(resolved).toBe('01KW5TEST00000000000000000X');
  });

  it('parentAgentRef 从 subagent rtc 派生 AgentRef（spawn 首任务 sender.agent.ref 用）', () => {
    // parentAgentRef 仅给 spawn 首任务 sender.agent.ref 用（spawn 投递方=parent）。
    // BUG-032 教训：禁止用于 send_message 的 sender.agent.ref（应改用 selfAgentRef）。
    // subagent 的 rtc.parentType='subagent' → ref.type 默认 'subagent'；
    // sessionId = parentSessionId（caller 的父 = spawn 投递目标 child 的 sender = parent）
    const rtc = makeSubagentRtc({ selfSid: 'CHILD-4', parentSid: 'PARENT-4' });
    const ref = parentAgentRef(rtc);
    expect(ref.sessionId).toBe('PARENT-4');
    expect(ref.type).toBe('subagent');
  });

  it('[BUG-032] selfAgentRef 派生 caller self AgentRef（send_message sender.agent.ref 用）', () => {
    // selfAgentRef 给 send_message 的 sender.agent.ref 用（发送方=caller self）。
    // subagent caller：self=CHILD，parent=PARENT → selfAgentRef.sessionId 必须是 CHILD
    const rtc = makeSubagentRtc({ selfSid: 'CHILD-5', parentSid: 'PARENT-5' });
    const ref = selfAgentRef(rtc);
    expect(ref.sessionId).toBe('CHILD-5'); // caller self，非 parent
    expect(ref.sessionId).not.toBe('PARENT-5');
    expect(ref.type).toBe('subagent');
    expect(ref.name).toBe('subagent');
  });

  it('[BUG-032] selfAgentRef vs parentAgentRef 方向对比（subagent caller）', () => {
    // 同一 rtc 下，两个 helper 必须返回不同方向的 sessionId
    const rtc = makeSubagentRtc({ selfSid: 'CHILD-6', parentSid: 'PARENT-6' });
    const selfRef = selfAgentRef(rtc);
    const parentRef = parentAgentRef(rtc);
    expect(selfRef.sessionId).toBe('CHILD-6'); // 发送方
    expect(parentRef.sessionId).toBe('PARENT-6'); // 接收方（spawn 首任务的 sender=parent）
    expect(selfRef.sessionId).not.toBe(parentRef.sessionId);
  });

  it('回归锁：修复前 buggy 行为（parentSessionId=self）会让 send_message 路由回自身', () => {
    // 模拟修复前 buggy rtc：parentSessionId = subagent 自身 sid
    const selfSid = 'CHILD-BUG';
    const buggyRtc: AgentToolRuntimeContext = {
      ...makeSubagentRtc({ selfSid, parentSid: 'PARENT-REAL' }),
      parentSessionId: selfSid, // ★ BUG：父 sid 被错设为自身
    };
    // 修复前：resolveAgentRef('parent', self) → self（错）
    const buggyResolved = resolveAgentRef('parent', buggyRtc.parentSessionId);
    expect(buggyResolved).toBe(selfSid); // 证实 bug 表现：路由回自身
    expect(buggyResolved).not.toBe('PARENT-REAL');

    // 修复后：parentSessionId = 真 parent → 路由正确
    const fixedRtc = makeSubagentRtc({ selfSid, parentSid: 'PARENT-REAL' });
    const fixedResolved = resolveAgentRef('parent', fixedRtc.parentSessionId);
    expect(fixedResolved).toBe('PARENT-REAL');
  });
});

describe('runtime-context: resolveSquadAlias squadchat 门控（v0.0.270 群聊开关）', () => {
  /** 构造 squad 内 mate rtc：squadStore mock 返回含 enableGroupChat 的 squad */
  function makeSquadRtc(opts: { enableGroupChat?: boolean; squadChatSessionId: string; leaderId?: string }): AgentToolRuntimeContext {
    const squad = {
      id: 'SQ-1',
      leaderId: opts.leaderId ?? 'LEADER-1',
      squadChatSessionId: opts.squadChatSessionId,
      ...(opts.enableGroupChat !== undefined ? { enableGroupChat: opts.enableGroupChat } : {}),
    };
    const squadStore = { getSquad: async () => squad } as never;
    return {
      selfSquadId: 'SQ-1',
      selfType: 'mate',
      selfSessionId: 'MATE-SELF',
      selfName: 'mate-self',
      squadStore,
      agentManager: {} as never,
      store: {} as never,
      sessionDeps: {} as never,
    } as unknown as AgentToolRuntimeContext;
  }

  it('[v0.0.270] enableGroupChat=false → resolveSquadAlias("squadchat") null（send_message 报 cannot resolve target，不静默投递）', async () => {
    const rtc = makeSquadRtc({ enableGroupChat: false, squadChatSessionId: 'SQUADCHAT-1' });
    const resolved = await resolveAgentRefWithSquad('squadchat', rtc);
    expect(resolved).toBeNull();
  });

  it('[v0.0.270] enableGroupChat=true → resolveSquadAlias("squadchat") squadChatSessionId', async () => {
    const rtc = makeSquadRtc({ enableGroupChat: true, squadChatSessionId: 'SQUADCHAT-1' });
    const resolved = await resolveAgentRefWithSquad('squadchat', rtc);
    expect(resolved).toBe('SQUADCHAT-1');
  });

  it('[v0.0.270] enableGroupChat=undefined（老 record）→ 仍解析（缺省=开）', async () => {
    const rtc = makeSquadRtc({ squadChatSessionId: 'SQUADCHAT-1' }); // 无 enableGroupChat 字段
    const resolved = await resolveAgentRefWithSquad('squadchat', rtc);
    expect(resolved).toBe('SQUADCHAT-1');
  });

  it('[v0.0.270] enableGroupChat=false 不影响 leader 私聊解析（关=全私聊语义）', async () => {
    const rtc = makeSquadRtc({ enableGroupChat: false, squadChatSessionId: 'SQUADCHAT-1', leaderId: 'LEADER-1' });
    (rtc as unknown as { memberStore?: unknown }).memberStore = {
      getMember: async () => ({ id: 'LEADER-1', sessionId: 'LEADER-SID' }),
    };
    const resolved = await resolveAgentRefWithSquad('leader', rtc);
    expect(resolved).toBe('LEADER-SID');
  });
});
