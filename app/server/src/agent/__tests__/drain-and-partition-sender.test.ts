/**
 * drainAndPartition 透传完整 sender UT
 * 参考: specs/tech/multi_agent/[P1]a2a_protocol.md §5（sender.source 分流表）
 *       specs/tech/agent/message/[P0]agent_message_interface.md §5（MessageSender 判别联合）
 *
 * v0.0.50 T1：本组用例自 agent/__tests__/message-prefix-renderer.test.ts 迁出（renderer
 * 测试已迁到 llm/__tests__/logical-view.test.ts）。本组测的是 drainAndPartition 的 sender
 * 透传行为（agent-loop-stage-pre 职责），与 renderer 解耦——保覆盖率不丢。
 *
 * 覆盖：
 *   - source=agent 消息 drain 后 newMessages 保留 sender.agent.ref/needReply/inReplyTo
 *   - source=agent 消息 drain 后重写新 messageId（透传 sender 不变）
 *   - source=user 消息 drain 后 sender={source:user}（无 agent 字段，判别联合）
 */
import { describe, it, expect } from 'vitest';
import type { ContentBlock, Message, MessageSender } from '../../message/types';
import { drainAndPartition } from '../agent-loop-stage-pre';
import { InboxStore } from '../inbox';

// ── 构造 helper（与原 renderer UT 同款，保持断言连续性） ─────

function makeMsg(opts: {
  id?: string;
  role?: Message['role'];
  sender?: MessageSender;
  content?: ContentBlock[];
}): Message {
  return {
    id: opts.id ?? '01TESTMSG0001',
    sessionId: '01TESTSID0001',
    role: opts.role ?? 'user',
    content: opts.content ?? [{ type: 'text', text: 'hello world' }],
    ...(opts.sender ? { sender: opts.sender } : {}),
  };
}

const agentSender = (overrides: Partial<{
  name: string;
  // [v0.0.33.1] member→mate（B 方案命名统一）
  type: 'leader' | 'mate' | 'subagent' | 'squad';
  sessionId: string;
  needReply: boolean;
  inReplyTo: string;
}> = {}): MessageSender => ({
  source: 'agent',
  agent: {
    ref: {
      type: overrides.type ?? 'subagent',
      sessionId: overrides.sessionId ?? '01PARENTSID01',
      name: overrides.name ?? 'explorer',
    },
    needReply: overrides.needReply ?? true,
    ...(overrides.inReplyTo ? { inReplyTo: overrides.inReplyTo } : {}),
  },
});

// ── drainAndPartition 透传完整 sender.agent ─────────────────

describe('drainAndPartition — 透传完整 sender.agent（不丢 agent 子结构）', () => {
  it('source=agent 消息 drain 后 newMessages 保留 sender.agent.ref/needReply/inReplyTo', () => {
    const inbox = new InboxStore();
    const sid = '01TESTSID0002';
    const a2aMsg = makeMsg({
      id: '01INBOXMSG001',
      role: 'user',
      sender: agentSender({
        name: 'explorer',
        type: 'subagent',
        sessionId: '01EXPLORERSID',
        needReply: false,
        inReplyTo: '01ORIGMSG0001',
      }),
      content: [{ type: 'text', text: '任务完成' }],
    });
    inbox.enqueue(sid, [a2aMsg]);

    const result = drainAndPartition(inbox, sid);
    expect(result.newMessages).toHaveLength(1);
    const drained = result.newMessages[0]!;
    const sender = drained.sender;
    // 透传完整 sender（含 agent.ref type/name/sessionId + needReply + inReplyTo）
    expect(sender).toBeDefined();
    expect(sender!.source).toBe('agent');
    if (sender!.source === 'agent') {
      expect(sender!.agent.ref.name).toBe('explorer');
      expect(sender!.agent.ref.type).toBe('subagent');
      expect(sender!.agent.ref.sessionId).toBe('01EXPLORERSID');
      expect(sender!.agent.needReply).toBe(false);
      expect(sender!.agent.inReplyTo).toBe('01ORIGMSG0001');
    }
  });

  it('source=agent 消息 drain 后重写新 messageId（透传 sender 不变）', () => {
    const inbox = new InboxStore();
    const sid = '01TESTSID0003';
    const a2aMsg = makeMsg({
      id: '01OLDID00001',
      role: 'user',
      sender: agentSender({ name: 'p', needReply: true }),
    });
    inbox.enqueue(sid, [a2aMsg]);

    const result = drainAndPartition(inbox, sid);
    const drained = result.newMessages[0]!;
    expect(drained.id).not.toBe('01OLDID00001'); // agent → 重写新 id
    expect(drained.sender!.source).toBe('agent'); // sender 透传
  });

  it('source=user 消息 drain 后 sender={source:user}（无 agent 字段，判别联合）', () => {
    const inbox = new InboxStore();
    const sid = '01TESTSID0004';
    const userMsg = makeMsg({
      id: '01USERMSG0001',
      role: 'user',
      sender: { source: 'user' },
    });
    inbox.enqueue(sid, [userMsg]);

    const result = drainAndPartition(inbox, sid);
    const drained = result.newMessages[0]!;
    expect(drained.sender).toEqual({ source: 'user' });
    expect(drained.sender!.source).toBe('user');
  });

  /**
   * [v0.0.161] source=user 消息 drain 后 msgId 被 reissue（与 agent/system/approval 对称）
   *   enqueueId 保持原值不变（I1 双 ID 严格独立）
   *   userMessages / processed / newMessages 三处的 messageId 值一致（I3 事件契约）
   *
   * 修复背景：v0.0.161 之前 user 分支保留 entry.message.id（HTTP-in 时刻的 throwaway ulid），
   *   与 agent/system 分支「drain 时 reissue newId=ulid()」不对称。→ 排队 user msg 的 id 锚在
   *   HTTP-in 时钟；agent/tool msg 锚在 drain 时钟。当 HTTP-in 早于上一 run 末尾时（毫秒粒度），
   *   ULID 字典序排 transcript 时该 user msg 位置错乱到"过去"（v0.0.173 前 base_builder.appendNew
   *   集合 diff 加固此场景，v0.0.173 已删 appendNew 走永远 rebuild 后由 transcript 单调性根治）。
   *   修复：对称化 reissue，从源头保 msgId 顺序 = drain 处理顺序。
   */
  it('[v0.0.161] source=user drain 后 msgId 被 reissue + enqueueId 保持原值（I1 独立） + 三处 messageId 一致', () => {
    const inbox = new InboxStore();
    const sid = '01TESTSID_V0161';
    const originalId = '01USERMSG0001'; // HTTP-in 时刻的 throwaway id
    const userMsg = makeMsg({
      id: originalId,
      role: 'user',
      sender: { source: 'user' },
    });
    const [origEnqueueId] = inbox.enqueue(sid, [userMsg]);
    expect(origEnqueueId).toBeDefined();

    const result = drainAndPartition(inbox, sid);

    // 断言 1：user 分支 msgId 已被 reissue（不再是原 id）
    expect(result.userMessages).toHaveLength(1);
    const userEntry = result.userMessages[0]!;
    expect(userEntry.message.id).not.toBe(originalId);
    // ulid 长度 26
    expect(userEntry.message.id.length).toBe(26);

    // 断言 2：enqueueId 保留 inbox 分配的原值（I1 双 ID 独立）
    expect(userEntry.enqueueId).toBe(origEnqueueId);

    // 断言 3：三处 messageId 一致（userMessages / processed / newMessages 都是同一 newId）
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]!.enqueueId).toBe(origEnqueueId);
    expect(result.processed[0]!.messageId).toBe(userEntry.message.id);
    expect(result.processed[0]!.role).toBe('user');

    expect(result.newMessages).toHaveLength(1);
    expect(result.newMessages[0]!.id).toBe(userEntry.message.id);

    // 断言 4：sender 透传（source=user + 内容不变）
    expect(userEntry.message.sender).toEqual({ source: 'user' });
    expect(userEntry.message.content).toEqual([{ type: 'text', text: 'hello world' }]);
  });
});
