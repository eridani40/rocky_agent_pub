/**
 * emitUserMessageBlocks —— message_start origin 派生 UT（v0.0.107）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md §4.2（MessageStartEvent.origin）
 *       specs/tech/version_logs/v0.0.107/change_plan.md 模块 C
 *
 * 覆盖 origin 派生 3 分支（gate 按 sender.source==='user' 非 role）：
 *   - user + channel（IM 入站）→ { type: channel.type, configId: channel.configId }
 *   - user 无 channel（web client）→ { type: 'client', configId: '0' }
 *   - 非 user source（system/agent）→ undefined（不误标来源）
 *
 * origin 只挂 message_start 事件体（不进 text_block/message_end，不进 LLM content）。
 */
import { describe, it, expect, vi } from 'vitest';
import type { ContentBlock, Message, MessageSender } from '../../message/types';
import { emitUserMessageBlocks } from '../agent-loop-emitters';
import type { EmitContext } from '../agent-loop-emitters';
import type { AgentEvent, MessageStartEvent } from '../agent-event-types';
import type { ReplayableEventBus } from '../event-bus';

/** mock bus：捕获所有 emit 事件 */
function mockBus(): { bus: ReplayableEventBus; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const bus = {
    emit(_group: string, e: { data: AgentEvent; timestamp: string }) {
      events.push(e.data);
    },
    subscribe: vi.fn(),
    clearReplay: vi.fn(),
    isReplayable: () => false,
  };
  return { bus: bus as unknown as ReplayableEventBus, events };
}

function makeCtx(bus: ReplayableEventBus): EmitContext {
  return {
    sessionId: '01TESTSID',
    runId: '01TESTRUN',
    runKind: 'main',
    bus,
    now: () => '2026-07-10T00:00:00.000Z',
  };
}

function makeMsg(sender: MessageSender | undefined, content: ContentBlock[] = [{ type: 'text', text: 'hi' }]): Message {
  return {
    id: '01MSG',
    sessionId: '01TESTSID',
    role: 'user',
    content,
    ...(sender ? { sender } : {}),
  };
}

/** 取唯一 message_start 事件 */
function messageStart(events: AgentEvent[]): MessageStartEvent {
  const starts = events.filter((e) => e.type === 'message_start');
  expect(starts).toHaveLength(1);
  return starts[0] as MessageStartEvent;
}

describe('emitUserMessageBlocks — origin 派生（v0.0.107）', () => {
  it('user + channel（feishu）→ origin = { type, configId }', () => {
    const { bus, events } = mockBus();
    emitUserMessageBlocks(
      makeCtx(bus),
      makeMsg({
        source: 'user',
        channel: {
          type: 'feishu',
          configId: 'inst-1',
          conversationId: 'oc_x',
          imUserId: 'ou_y',
          imUserName: '张三',
        },
      }),
    );
    expect(messageStart(events).origin).toEqual({ type: 'feishu', configId: 'inst-1' });
  });

  it('user 无 channel（web client）→ origin = { type: client, configId: 0 }', () => {
    const { bus, events } = mockBus();
    emitUserMessageBlocks(makeCtx(bus), makeMsg({ source: 'user' }));
    expect(messageStart(events).origin).toEqual({ type: 'client', configId: '0' });
  });

  it('source=system（cron）→ origin undefined（不误标来源）', () => {
    const { bus, events } = mockBus();
    emitUserMessageBlocks(makeCtx(bus), makeMsg({ source: 'system', system: { kind: 'cron' } }));
    expect(messageStart(events).origin).toBeUndefined();
  });

  it('source=agent（a2a）→ origin undefined', () => {
    const { bus, events } = mockBus();
    emitUserMessageBlocks(
      makeCtx(bus),
      makeMsg({
        source: 'agent',
        agent: { ref: { type: 'mate', sessionId: '01P', name: 'm' }, needReply: false },
      }),
    );
    expect(messageStart(events).origin).toBeUndefined();
  });

  it('origin 只挂 message_start（不污染 text_block / message_end）', () => {
    const { bus, events } = mockBus();
    emitUserMessageBlocks(
      makeCtx(bus),
      makeMsg({ source: 'user', channel: { type: 'feishu', configId: 'inst-1', conversationId: 'c', imUserId: 'u', imUserName: 'n' } }),
    );
    // 除 message_start 外，其它事件体不含 origin 字段
    for (const e of events) {
      if (e.type !== 'message_start') {
        expect((e as unknown as Record<string, unknown>).origin).toBeUndefined();
      }
    }
  });
});
