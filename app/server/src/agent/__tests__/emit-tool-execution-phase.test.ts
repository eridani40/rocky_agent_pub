/**
 * emitToolExecutionStart / emitToolExecutionEnd — SSE 阶段事件 UT（v0.0.130.hang P6-backend）
 * 参考: specs/tech/version_logs/v0.0.130.hang/change_plan.md 模块 P6-backend
 *
 * 覆盖：两函数 publish 出的载荷形状——type/toolNames/toolCallIds/resultCount/pendingCount
 * 字段正确，且复用现有 base(ctx) 公共字段（id/sessionId/createdAt/runId/runKind）。
 */
import { describe, it, expect, vi } from 'vitest';
import { emitToolExecutionStart, emitToolExecutionEnd } from '../agent-loop-emitters';
import type { EmitContext } from '../agent-loop-emitters';
import type { AgentEvent, ToolExecutionStartEvent, ToolExecutionEndEvent } from '../agent-event-types';
import type { ReplayableEventBus } from '../event-bus';

/** mock bus：捕获所有 emit 事件（与 emit-user-message-origin.test.ts 同一 mock 模式） */
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
    now: () => '2026-07-13T00:00:00.000Z',
  };
}

describe('emitToolExecutionStart/End — P6-backend SSE 阶段事件', () => {
  it('emitToolExecutionStart 发出 tool_execution_start，携 toolNames/toolCallIds + base 公共字段', () => {
    const { bus, events } = mockBus();
    emitToolExecutionStart(makeCtx(bus), ['bash', 'file_read'], ['tc1', 'tc2']);
    expect(events).toHaveLength(1);
    const e = events[0] as ToolExecutionStartEvent;
    expect(e.type).toBe('tool_execution_start');
    expect(e.toolNames).toEqual(['bash', 'file_read']);
    expect(e.toolCallIds).toEqual(['tc1', 'tc2']);
    // base(ctx) 公共字段就位
    expect(e.sessionId).toBe('01TESTSID');
    expect(e.runId).toBe('01TESTRUN');
    expect(e.runKind).toBe('main');
    expect(e.createdAt).toBe('2026-07-13T00:00:00.000Z');
    expect(typeof e.id).toBe('string');
    expect(e.id.length).toBeGreaterThan(0);
  });

  it('emitToolExecutionEnd 发出 tool_execution_end，携 resultCount/pendingCount', () => {
    const { bus, events } = mockBus();
    emitToolExecutionEnd(makeCtx(bus), 1, 0);
    expect(events).toHaveLength(1);
    const e = events[0] as ToolExecutionEndEvent;
    expect(e.type).toBe('tool_execution_end');
    expect(e.resultCount).toBe(1);
    expect(e.pendingCount).toBe(0);
  });

  it('emitToolExecutionEnd 支持省略 resultCount/pendingCount（可选字段）', () => {
    const { bus, events } = mockBus();
    emitToolExecutionEnd(makeCtx(bus));
    expect(events).toHaveLength(1);
    const e = events[0] as ToolExecutionEndEvent;
    expect(e.type).toBe('tool_execution_end');
    expect(e.resultCount).toBeUndefined();
    expect(e.pendingCount).toBeUndefined();
  });

  it('两函数各只 publish 一次（不产生多余事件）', () => {
    const { bus, events } = mockBus();
    const ctx = makeCtx(bus);
    emitToolExecutionStart(ctx, ['bash'], ['tc1']);
    emitToolExecutionEnd(ctx, 1, 0);
    expect(events.map((e) => e.type)).toEqual(['tool_execution_start', 'tool_execution_end']);
  });
});
