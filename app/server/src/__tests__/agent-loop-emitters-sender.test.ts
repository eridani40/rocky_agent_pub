/**
 * agent-loop-emitters sender 字段单测（BUG-001 修复验证）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md §4.2（MessageStartEvent）
 *
 * 验证点：
 *   - emitUserMessageBlocks 对 source='agent' 的 a2a 消息，message_start 事件携带 sender.agent.ref
 *   - emitUserMessageBlocks 对 source='user' 的消息，sender 字段缺省（origin 字段保持不变）
 *   - emitMessageStart 直接传入 sender 时，事件体携带该 sender
 *   - sender 字段结构：{ source: 'agent', agent: { ref: { type, sessionId, name } } }
 */
import { describe, it, expect } from 'vitest';
import { emitUserMessageBlocks, emitMessageStart, type EmitContext } from '../agent/agent-loop-emitters';
import type { AgentEvent } from '../agent/agent-event-types';
import type { Message } from '../message/types';

/** 构造最小 ReplayableEventBus mock（收集 emit 的事件） */
function makeTestBus() {
  const events: AgentEvent[] = [];
  return {
    emit(_group: string, entry: { data: AgentEvent }) {
      events.push(entry.data);
    },
    events,
  };
}

/** 构造测试用 EmitContext */
function makeCtx(bus: ReturnType<typeof makeTestBus>): EmitContext {
  return {
    sessionId: 's1',
    runId: 'r1',
    runKind: 'main',
    bus: bus as unknown as EmitContext['bus'],
    now: () => '2026-01-01T00:00:00.000Z',
  };
}

/** 构造 a2a 消息（source='agent' + agent.ref 完整）*/
function makeA2aMessage(overrides?: Partial<Message>): Message {
  return {
    id: 'msg-a2a-1',
    sessionId: 's1',
    role: 'user',
    content: [{ type: 'text', text: 'hello from mate' }],
    sender: {
      source: 'agent',
      agent: {
        ref: { type: 'mate', sessionId: 'session-mate-1', name: 'Alice' },
        needReply: false,
      },
    },
    ...overrides,
  };
}

/** 构造 user 消息（source='user'，无 channel） */
function makeUserMessage(overrides?: Partial<Message>): Message {
  return {
    id: 'msg-user-1',
    sessionId: 's1',
    role: 'user',
    content: [{ type: 'text', text: 'hello from user' }],
    sender: { source: 'user' },
    ...overrides,
  };
}

/** 从 events 中找到第一个 message_start 事件 */
function findMessageStart(events: AgentEvent[]) {
  return events.find((e) => e.type === 'message_start') as Extract<AgentEvent, { type: 'message_start' }> | undefined;
}

// ──────────────────────────────────────────────────────────────────────────────
// a2a 消息 message_start 事件携带 sender 字段（BUG-001 核心修复）
// ──────────────────────────────────────────────────────────────────────────────
describe('emitUserMessageBlocks a2a 消息 sender 携带', () => {
  it('a2a 消息 message_start 事件携带 sender.source=agent + agent.ref', () => {
    const bus = makeTestBus();
    const ctx = makeCtx(bus);
    const msg = makeA2aMessage();

    emitUserMessageBlocks(ctx, msg);

    const start = findMessageStart(bus.events);
    expect(start).toBeDefined();
    expect(start?.sender).toBeDefined();
    expect(start?.sender?.source).toBe('agent');
    if (start?.sender?.source === 'agent') {
      expect(start.sender.agent.ref.type).toBe('mate');
      expect(start.sender.agent.ref.name).toBe('Alice');
      expect(start.sender.agent.ref.sessionId).toBe('session-mate-1');
    }
  });

  it('a2a 消息（leader 类型）sender.agent.ref.type 正确透传', () => {
    const bus = makeTestBus();
    const ctx = makeCtx(bus);
    const msg = makeA2aMessage({
      sender: {
        source: 'agent',
        agent: {
          ref: { type: 'leader', sessionId: 'session-leader-1', name: 'Bob' },
          needReply: true,
          inReplyTo: 'msg-parent',
        },
      },
    });

    emitUserMessageBlocks(ctx, msg);

    const start = findMessageStart(bus.events);
    expect(start?.sender?.source).toBe('agent');
    if (start?.sender?.source === 'agent') {
      expect(start.sender.agent.ref.type).toBe('leader');
      expect(start.sender.agent.ref.name).toBe('Bob');
    }
  });

  it('a2a 消息不携带 origin 字段（origin 仅属于 user channel）', () => {
    const bus = makeTestBus();
    const ctx = makeCtx(bus);
    const msg = makeA2aMessage();

    emitUserMessageBlocks(ctx, msg);

    const start = findMessageStart(bus.events);
    // a2a 消息 origin 应为 undefined（只有 source='user' 才有 origin）
    expect(start?.origin).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// user 消息保持向后兼容（origin 字段不变，无 sender）
// ──────────────────────────────────────────────────────────────────────────────
describe('emitUserMessageBlocks user 消息向后兼容', () => {
  it('user 消息（web client）message_start 无 sender 字段，有 origin={client,0}', () => {
    const bus = makeTestBus();
    const ctx = makeCtx(bus);
    const msg = makeUserMessage();

    emitUserMessageBlocks(ctx, msg);

    const start = findMessageStart(bus.events);
    // user 消息无 sender 字段（走 origin 路径）
    expect(start?.sender).toBeUndefined();
    // origin 仍正确携带
    expect(start?.origin).toEqual({ type: 'client', configId: '0' });
  });

  it('user 消息（飞书入站，有 channel）origin 正确，无 sender', () => {
    const bus = makeTestBus();
    const ctx = makeCtx(bus);
    const msg = makeUserMessage({
      sender: {
        source: 'user',
        channel: { type: 'feishu', configId: 'inst-001', conversationId: 'conv-1', imUserId: 'uid-1', imUserName: 'user1' },
      },
    });

    emitUserMessageBlocks(ctx, msg);

    const start = findMessageStart(bus.events);
    expect(start?.sender).toBeUndefined();
    expect(start?.origin).toEqual({ type: 'feishu', configId: 'inst-001' });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// emitMessageStart 直接传 sender 参数
// ──────────────────────────────────────────────────────────────────────────────
describe('emitMessageStart 直接传入 sender', () => {
  it('sender 参数写入事件体', () => {
    const bus = makeTestBus();
    const ctx = makeCtx(bus);
    const sender = {
      source: 'agent' as const,
      agent: { ref: { type: 'mate', sessionId: 'sid-2', name: 'Carol' } },
    };

    emitMessageStart(ctx, 'msg-1', 'user', undefined, undefined, sender);

    const start = findMessageStart(bus.events);
    expect(start?.sender).toEqual(sender);
  });

  it('不传 sender 时事件体无 sender 字段（向后兼容）', () => {
    const bus = makeTestBus();
    const ctx = makeCtx(bus);

    emitMessageStart(ctx, 'msg-2', 'user');

    const start = findMessageStart(bus.events);
    expect(start?.sender).toBeUndefined();
  });
});
