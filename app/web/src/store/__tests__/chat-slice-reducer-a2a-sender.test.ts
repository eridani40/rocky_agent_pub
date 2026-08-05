/**
 * chat-slice-reducer a2a sender 重建单测（BUG-001 修复验证）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md §4.2（MessageStartEvent sender）
 *       specs/ui/components/chat-page/section-chat-session.md（isA2aInbox 判定，chat-actor-strategy）
 *
 * 验证点：
 *   - message_start 携带 sender.source='agent' + agent.ref → 重建的 Message.sender 可通过 isA2aInbox
 *   - sender 优先级：evt.sender > evt.origin > undefined（向后兼容不回归）
 *   - origin 路径（user channel）不受影响（BUG-001 修复不破坏旧行为）
 *   - sender 字段为 undefined 时 Message 无 sender（web client user / LLM assistant 路径）
 */
import { describe, it, expect } from 'vitest';
import {
  applyAgentEventToMessages,
  type AgentEvent,
  type ReducerState,
} from '../chat-slice-reducer';
import { isA2aInbox } from '../../components/chat-page/chat-actor-strategy';

const emptyState: ReducerState = {
  loadingPhase: null,
  runActive: false,
  lastRunFinish: null,
  enqueueItems: [],
  pendingToolCall: null,
};

/** 构造带 sender 的 message_start 事件（a2a inbox） */
function a2aMessageStart(
  messageId: string,
  agentRef: { type: string; sessionId: string; name: string },
): AgentEvent {
  return {
    type: 'message_start',
    messageId,
    sessionId: 's1',
    role: 'user',
    sender: {
      source: 'agent',
      agent: { ref: agentRef },
    },
  };
}

/** 构造带 origin 的 message_start 事件（user channel，旧路径） */
function userWithOriginMessageStart(
  messageId: string,
  origin: { type: string; configId: string },
): AgentEvent {
  return {
    type: 'message_start',
    messageId,
    sessionId: 's1',
    role: 'user',
    origin,
  };
}

/** 构造无 sender 无 origin 的 message_start 事件（web client user） */
function bareMessageStart(messageId: string, role: AgentEvent extends { type: 'message_start' } ? never : string = 'user'): AgentEvent {
  return {
    type: 'message_start',
    messageId,
    sessionId: 's1',
    role: role as 'user' | 'assistant' | 'tool' | 'system',
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// BUG-001 核心修复：a2a message_start sender → isA2aInbox 可判定
// ──────────────────────────────────────────────────────────────────────────────
describe('BUG-001 a2a sender 重建 → isA2aInbox 可判定', () => {
  it('evt.sender.source=agent → 重建的 Message.sender.source=agent', () => {
    const evt = a2aMessageStart('msg-1', { type: 'mate', sessionId: 'sid-1', name: 'Alice' });
    const r = applyAgentEventToMessages([], null, evt, emptyState);
    const msg = r.messages.find((m) => m.id === 'msg-1')!;
    expect(msg.sender?.source).toBe('agent');
  });

  it('重建后 isA2aInbox(msg) 返回 true（修复前为 false，误判 YOU）', () => {
    const evt = a2aMessageStart('msg-2', { type: 'mate', sessionId: 'sid-2', name: 'Bob' });
    const r = applyAgentEventToMessages([], null, evt, emptyState);
    const msg = r.messages.find((m) => m.id === 'msg-2')!;
    // 修复关键断言：SSE 推送后 isA2aInbox 必须为 true，才能在群聊显示成员名而非 YOU
    expect(isA2aInbox(msg)).toBe(true);
  });

  it('重建后 sender.agent.ref.name = 事件里的 name（成员名解析正确）', () => {
    const evt = a2aMessageStart('msg-3', { type: 'leader', sessionId: 'sid-3', name: 'Carol' });
    const r = applyAgentEventToMessages([], null, evt, emptyState);
    const msg = r.messages.find((m) => m.id === 'msg-3')!;
    if (msg.sender?.source === 'agent') {
      expect(msg.sender.agent.ref.name).toBe('Carol');
      expect(msg.sender.agent.ref.type).toBe('leader');
    } else {
      expect.fail('sender.source 不是 agent');
    }
  });

  it('重建后 sender.agent.ref.sessionId 正确（a2aRefOf 全字段）', () => {
    const evt = a2aMessageStart('msg-4', { type: 'mate', sessionId: 'sid-4', name: 'Dave' });
    const r = applyAgentEventToMessages([], null, evt, emptyState);
    const msg = r.messages.find((m) => m.id === 'msg-4')!;
    if (msg.sender?.source === 'agent') {
      expect(msg.sender.agent.ref.sessionId).toBe('sid-4');
    } else {
      expect.fail('sender.source 不是 agent');
    }
  });

  it('message 已存在（幂等）时 sender 不被重复写入', () => {
    // 先建立消息
    const evt = a2aMessageStart('msg-5', { type: 'mate', sessionId: 'sid-5', name: 'Eve' });
    const r1 = applyAgentEventToMessages([], null, evt, emptyState);
    // 再 apply 同一 message_start（幂等 guard）
    const r2 = applyAgentEventToMessages(r1.messages, null, evt, emptyState);
    // messages 数量不变（幂等）
    expect(r2.messages.filter((m) => m.id === 'msg-5').length).toBe(1);
    // sender 仍然正确
    const msg = r2.messages.find((m) => m.id === 'msg-5')!;
    expect(isA2aInbox(msg)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 向后兼容：origin 路径（user channel）不受影响
// ──────────────────────────────────────────────────────────────────────────────
describe('向后兼容：origin 路径不受影响', () => {
  it('仅有 origin（无 sender）→ 重建 sender.source=user + channel', () => {
    const evt = userWithOriginMessageStart('msg-6', { type: 'feishu', configId: 'inst-1' });
    const r = applyAgentEventToMessages([], null, evt, emptyState);
    const msg = r.messages.find((m) => m.id === 'msg-6')!;
    expect(msg.sender?.source).toBe('user');
    if (msg.sender?.source === 'user') {
      expect(msg.sender.channel?.type).toBe('feishu');
      expect(msg.sender.channel?.configId).toBe('inst-1');
    }
    // origin 路径的消息不是 a2a
    expect(isA2aInbox(msg)).toBe(false);
  });

  it('无 sender 无 origin（web client user）→ Message 无 sender 字段', () => {
    const evt: AgentEvent = { type: 'message_start', messageId: 'msg-7', sessionId: 's1', role: 'user' };
    const r = applyAgentEventToMessages([], null, evt, emptyState);
    const msg = r.messages.find((m) => m.id === 'msg-7')!;
    expect(msg.sender).toBeUndefined();
    expect(isA2aInbox(msg)).toBe(false);
  });

  it('assistant role message_start 无 sender → sender 缺省', () => {
    const evt: AgentEvent = { type: 'message_start', messageId: 'msg-8', sessionId: 's1', role: 'assistant' };
    const r = applyAgentEventToMessages([], null, evt, emptyState);
    const msg = r.messages.find((m) => m.id === 'msg-8')!;
    expect(msg.sender).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// sender 优先级：evt.sender > evt.origin
// ──────────────────────────────────────────────────────────────────────────────
describe('sender 优先级（evt.sender 优于 evt.origin）', () => {
  it('同时有 sender 和 origin → 使用 sender（sender 优先）', () => {
    // 理论上不会同时出现，但 reducer 应有明确优先级
    const evt: AgentEvent = {
      type: 'message_start',
      messageId: 'msg-9',
      sessionId: 's1',
      role: 'user',
      sender: { source: 'agent', agent: { ref: { type: 'mate', sessionId: 'sid-9', name: 'Frank' } } },
      origin: { type: 'feishu', configId: 'inst-9' },
    };
    const r = applyAgentEventToMessages([], null, evt, emptyState);
    const msg = r.messages.find((m) => m.id === 'msg-9')!;
    // sender 优先：应识别为 a2a 消息
    expect(msg.sender?.source).toBe('agent');
    expect(isA2aInbox(msg)).toBe(true);
  });
});
