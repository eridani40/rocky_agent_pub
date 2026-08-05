/**
 * chat-slice-reducer tool_execution_start/end 单测（v0.0.130.hang P6-frontend）
 * 参考: specs/tech/version_logs/v0.0.130.hang/change_plan.md P6-frontend（reducer 行为契约）
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md（ToolExecutionStartEvent/EndEvent）
 *
 * 验证点：
 *   - tool_execution_start → loadingPhase='tool_executing' + runningToolNames=evt.toolNames
 *   - tool_execution_end → 清 runningToolNames（loadingPhase 保持不变）
 *   - run_end → runningToolNames 归零（兜底，防悬挂）
 *   - tool_result_start 的 phase 兜底仍在（旧回放无 execution 事件时仍进 tool_executing）
 *   - 纯函数：不 mutate 入参 state / runCtx
 */
import { describe, it, expect } from 'vitest';
import {
  applyAgentEventToMessages,
  type AgentEvent,
  type ReducerState,
  type RunContext,
} from '../chat-slice-reducer';

const emptyState: ReducerState = {
  loadingPhase: null,
  runActive: false,
  lastRunFinish: null,
  enqueueItems: [],
  pendingToolCall: null,
};

const runStart = (runId: string): AgentEvent => ({ type: 'run_start', runId, sessionId: 's1' });
const toolExecStart = (toolNames: string[], toolCallIds: string[]): AgentEvent => ({
  type: 'tool_execution_start',
  toolNames,
  toolCallIds,
});
const toolExecEnd = (): AgentEvent => ({ type: 'tool_execution_end', resultCount: 1 });

describe('[v0.0.130.hang] tool_execution_start/end reducer', () => {
  it('tool_execution_start → loadingPhase=tool_executing + runningToolNames=evt.toolNames', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const r1 = applyAgentEventToMessages(
      r0.messages,
      r0.runCtx,
      toolExecStart(['bash'], ['tc1']),
      r0,
    );
    expect(r1.loadingPhase).toBe('tool_executing');
    expect(r1.runningToolNames).toEqual(['bash']);
    // runCtx 也同步写入（buffer 层跨帧累积）
    expect(r1.runCtx?.runningToolNames).toEqual(['bash']);
  });

  it('多 tool 并发：toolNames 数组按序保留（不去重不排序）', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const r1 = applyAgentEventToMessages(
      r0.messages,
      r0.runCtx,
      toolExecStart(['bash', 'web_fetch'], ['tc1', 'tc2']),
      r0,
    );
    expect(r1.runningToolNames).toEqual(['bash', 'web_fetch']);
  });

  it('tool_execution_end → 清 runningToolNames，loadingPhase 保持不变（待 tool_result_* 覆盖）', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, toolExecStart(['bash'], ['tc1']), r0);
    const r2 = applyAgentEventToMessages(r1.messages, r1.runCtx, toolExecEnd(), r1);
    expect(r2.runningToolNames).toBeUndefined();
    // loadingPhase 不因 tool_execution_end 改变（仍是上一步置的 tool_executing）
    expect(r2.loadingPhase).toBe('tool_executing');
    expect(r2.runCtx?.runningToolNames).toBeUndefined();
  });

  it('run_end → runningToolNames 归零（兜底，防悬挂未清）', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, toolExecStart(['bash'], ['tc1']), r0);
    // 未经 tool_execution_end 直接 run_end（模拟异常收尾场景）
    const r2 = applyAgentEventToMessages(
      r1.messages,
      r1.runCtx,
      { type: 'run_end', runId: 'r1', sessionId: 's1', stopReason: 'interrupted' },
      r1,
    );
    expect(r2.runningToolNames).toBeUndefined();
    expect(r2.loadingPhase).toBeNull();
    expect(r2.runCtx).toBeNull();
  });

  it('tool_result_start phase 兜底仍在：旧回放无 tool_execution_start 时仍进 tool_executing（无 tool 名）', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const r1 = applyAgentEventToMessages(
      r0.messages,
      r0.runCtx,
      { type: 'tool_result_start', toolCallId: 'tc1', messageId: 'm1' },
      r0,
    );
    expect(r1.loadingPhase).toBe('tool_executing');
    // 无 tool_execution_start 先行事件，runningToolNames 不被设置（沿用 state 初值 undefined）
    expect(r1.runningToolNames).toBeUndefined();
  });

  it('纯函数：不 mutate 入参 runCtx（tool_execution_start 返回新对象）', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const inputRunCtx = r0.runCtx as RunContext;
    const snapshot = { ...inputRunCtx };
    applyAgentEventToMessages(r0.messages, inputRunCtx, toolExecStart(['bash'], ['tc1']), r0);
    expect(inputRunCtx).toEqual(snapshot); // 入参未被 mutate
  });

  it('纯函数：不 mutate 入参 state（tool_execution_start 后原 state 对象字段不变）', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const stateSnapshot: ReducerState = { ...r0 };
    applyAgentEventToMessages(r0.messages, r0.runCtx, toolExecStart(['bash'], ['tc1']), r0);
    expect(r0.loadingPhase).toBe(stateSnapshot.loadingPhase);
    expect(r0.runningToolNames).toBe(stateSnapshot.runningToolNames);
  });

  it('run_start → tool_execution_start → tool_execution_end → run_end 全链路 runningToolNames 生命周期', () => {
    let r = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    expect(r.runningToolNames).toBeUndefined();
    r = applyAgentEventToMessages(r.messages, r.runCtx, toolExecStart(['bash'], ['tc1']), r);
    expect(r.runningToolNames).toEqual(['bash']);
    r = applyAgentEventToMessages(r.messages, r.runCtx, toolExecEnd(), r);
    expect(r.runningToolNames).toBeUndefined();
    r = applyAgentEventToMessages(
      r.messages,
      r.runCtx,
      { type: 'run_end', runId: 'r1', sessionId: 's1', stopReason: 'no_tool_call' },
      r,
    );
    expect(r.runningToolNames).toBeUndefined();
  });
});
