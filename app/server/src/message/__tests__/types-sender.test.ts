/**
 * MessageSender 判别联合 + MessageSource enum 单测（v0.0.31 Task1）
 * 参考: specs/tech/agent/message/[P0]agent_message_interface.md §5
 *
 * 校验点：
 *   - MessageSender 为严格判别联合（4 变体 by source）
 *   - source='agent' 携带 agent.ref/needReply 必填、inReplyTo 可选
 *   - source='user' 无附加字段
 *   - source='system' 携带 system.kind/refId
 *   - source='approval' 携带 approval.toolCallId/decision
 *   - MessageSource enum 含 'system'，无 'scheduled'
 *   - TS 窄化：if (sender.source === 'agent') 后访问 agent.needReply 类型安全
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  MessageSender,
  MessageSource,
  MessageSenderAgent,
  AgentRef,
} from '../types';

/** 构造合法 AgentRef（测试 fixture） */
function ref(): AgentRef {
  return { type: 'leader', sessionId: '01SESSION', name: 'parent' };
}

describe('MessageSender 判别联合（v0.0.31 Task1）', () => {
  it('source="agent" 变体：携带 agent.ref/needReply 必填、inReplyTo 可选', () => {
    const sender: MessageSender = {
      source: 'agent',
      agent: { ref: ref(), needReply: true },
    };
    expect(sender.source).toBe('agent');
    expect(sender.agent.ref.type).toBe('leader');
    expect(sender.agent.needReply).toBe(true);
    // inReplyTo 可选——构造时不带也应合法
    const withoutInReplyTo: MessageSender = {
      source: 'agent',
      agent: { ref: ref(), needReply: false },
    };
    expect(withoutInReplyTo.agent.inReplyTo).toBeUndefined();
    // 带上 inReplyTo
    const withInReplyTo: MessageSender = {
      source: 'agent',
      agent: { ref: ref(), needReply: true, inReplyTo: '01PREVMSG' },
    };
    expect(withInReplyTo.agent.inReplyTo).toBe('01PREVMSG');
  });

  it('source="user" 变体：无附加字段（无 agent/agentName/agentId/system/approval）', () => {
    const sender: MessageSender = { source: 'user' };
    expect(sender.source).toBe('user');
    // 判别联合 user 变体结构层无 agent 字段
    expect('agent' in sender).toBe(false);
    expect('agentName' in sender).toBe(false);
    expect('agentId' in sender).toBe(false);
    expect('system' in sender).toBe(false);
    expect('approval' in sender).toBe(false);
  });

  it('source="system" 变体：携带 system.kind/refId?', () => {
    const heartbeat: MessageSender = { source: 'system', system: { kind: 'heartbeat' } };
    expect(heartbeat.system.kind).toBe('heartbeat');
    expect(heartbeat.system.refId).toBeUndefined();
    const cron: MessageSender = {
      source: 'system',
      system: { kind: 'cron', refId: '01SCHED' },
    };
    expect(cron.system.kind).toBe('cron');
    expect(cron.system.refId).toBe('01SCHED');
  });

  it('source="approval" 变体：携带 approval.toolCallId/decision', () => {
    const sender: MessageSender = {
      source: 'approval',
      approval: { toolCallId: '01CALL', decision: 'allow' },
    };
    expect(sender.approval.toolCallId).toBe('01CALL');
    expect(sender.approval.decision).toBe('allow');
    // decision 三态
    const decisions: Array<'allow' | 'allow_always' | 'deny'> = [
      'allow',
      'allow_always',
      'deny',
    ];
    for (const d of decisions) {
      const s: MessageSender = {
        source: 'approval',
        approval: { toolCallId: 'c', decision: d },
      };
      expect(s.approval.decision).toBe(d);
    }
  });

  it('判别联合 5 变体穷举：source 标签集为 {user|agent|system|approval|tool_reply}', () => {
    const senders: MessageSender[] = [
      { source: 'user' },
      { source: 'agent', agent: { ref: ref(), needReply: true } },
      { source: 'system', system: { kind: 'reminder' } },
      { source: 'approval', approval: { toolCallId: 'c', decision: 'deny' } },
      // [v0.0.101] tool_reply 变体（HITL 用户回填答案/审批）
      {
        source: 'tool_reply',
        tool_reply: { toolCallId: '01CALL', runId: '01RUN' },
      },
    ];
    expect(senders.map((s) => s.source).sort()).toEqual(
      ['agent', 'approval', 'system', 'tool_reply', 'user'],
    );
  });
});

describe('TS 类型窄化（compile-time）', () => {
  it('if sender.source==="agent" 后访问 agent.needReply 类型安全', () => {
    const sender: MessageSender = {
      source: 'agent',
      agent: { ref: ref(), needReply: true },
    };
    let needReply: boolean | undefined;
    if (sender.source === 'agent') {
      // 窄化后 sender.agent 类型为 MessageSenderAgent（无 undefined）
      needReply = sender.agent.needReply;
    }
    expect(needReply).toBe(true);
    // 类型层断言：窄化后 sender.agent 是非可选 MessageSenderAgent
    if (sender.source === 'agent') {
      expectTypeOf(sender.agent).toEqualTypeOf<MessageSenderAgent>();
      expectTypeOf(sender.agent.needReply).toEqualTypeOf<boolean>();
      expectTypeOf(sender.agent.ref).toEqualTypeOf<AgentRef>();
    }
  });

  it('user 变体类型层无 agent 子字段（expectTypeOf 编译时校验）', () => {
    const user: MessageSender = { source: 'user' };
    expectTypeOf(user).not.toHaveProperty('agent');
    expectTypeOf(user).not.toHaveProperty('agentName');
    expectTypeOf(user).not.toHaveProperty('agentId');
    expectTypeOf(user).not.toHaveProperty('system');
    expectTypeOf(user).not.toHaveProperty('approval');
  });
});

describe('MessageSource enum（v0.0.31：scheduled → system；v0.0.101：加 tool_reply）', () => {
  it('含 system + tool_reply，不含 scheduled（编译时 + 运行时）', () => {
    const sources: MessageSource[] = [
      'user',
      'agent',
      'approval',
      'system',
      'tool_reply',
    ];
    expect(sources).toContain('system');
    expect(sources).toContain('tool_reply');
    expect(sources).not.toContain('scheduled');
    // 编译时：'tool_reply' 可赋值，'scheduled' 不可（@ts-expect-error 验证）
    const ok: MessageSource = 'tool_reply';
    // @ts-expect-error scheduled 已并入 system，不再是合法 MessageSource
    const bad: MessageSource = 'scheduled';
    void ok;
    void bad;
  });

  it('enum 字面量联合等于 [user|agent|approval|system|tool_reply]（grep 0 命中验证）', () => {
    // 类型联合字面量集（v0.0.101 加 tool_reply）
    type Expected =
      | 'user'
      | 'agent'
      | 'approval'
      | 'system'
      | 'tool_reply';
    expectTypeOf<MessageSource>().toEqualTypeOf<Expected>();
  });
});
