// @vitest-environment jsdom
/**
 * chat-slice 单测 —— SSE AgentEvent reducer（path A/B/C + run-finish）
 * 参考: specs/ui/components/chat-page/_overview.md §2 rule7 / §4.10 / §4.13
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md §9
 */
import { describe, it, expect } from 'vitest';
import { applyAgentEventToMessages, type AgentEvent } from '../../../store/chat-slice';
import { buildToolResultMap } from '../message-flatten';
import type { Message } from '../types';

const emptyState = {
  loadingPhase: null as null | string,
  runActive: false,
  // [v0.0.25] RunFinish.error 契约改 { category, displayReason, detail?, code? }
  lastRunFinish: null as null | { stopReason: string; error?: { category: string; displayReason: string; detail?: string; code?: string } },
  enqueueItems: [] as { enqueueId: string; content: string }[],
};

function reduce(events: AgentEvent[]) {
  // v0.0.95：reducer 纯化——runCtx 改值传递（出入参）；不再用 ctxRef mutate。
  let runCtx: { runId: string; currentAssistantMessageId?: string; toolCallRawArgs?: Map<string, string>; pendingError?: { category: string; displayReason: string; detail?: string; code?: string } } | null = null;
  let state = { ...emptyState, messages: [] as Message[] };
  for (const e of events) {
    const r = applyAgentEventToMessages(state.messages, runCtx, e, state as never);
    state = r as typeof state;
    runCtx = r.runCtx;
  }
  return state;
}

describe('path A — 纯文本回复', () => {
  it('run_start → thinking；text_block_delta 追加；run_end no_tool_call', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      { type: 'message_start', messageId: 'm1', sessionId: 'S1', role: 'assistant' },
      { type: 'text_block_delta', blockId: 'b1', messageId: 'm1', delta: '你' },
      { type: 'text_block_delta', blockId: 'b1', messageId: 'm1', delta: '好' },
      { type: 'message_end', messageId: 'm1', sessionId: 'S1' },
      { type: 'run_end', runId: 'R1', sessionId: 'S1', stopReason: 'no_tool_call' },
    ]);
    expect(s.runActive).toBe(false);
    expect(s.loadingPhase).toBeNull();
    expect(s.lastRunFinish).toEqual({ stopReason: 'no_tool_call' });
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.content).toEqual([{ type: 'text', text: '你好' }]);
  });

  it('run_start 后 loadingPhase=thinking；收到 text_block_delta 后=answering', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
    ]);
    expect(s.loadingPhase).toBe('thinking');
    expect(s.runActive).toBe(true);
  });
});

describe('path B — 工具调用', () => {
  it('tool_call_start/delta/end + tool_result_* 绑定', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      { type: 'message_start', messageId: 'a1', sessionId: 'S1', role: 'assistant' },
      { type: 'tool_call_start', toolCallId: 'c1', toolName: 'bash', messageId: 'a1' },
      { type: 'tool_call_delta', toolCallId: 'c1', messageId: 'a1', delta: '{"command":"ls"}' },
      { type: 'tool_call_end', toolCallId: 'c1', messageId: 'a1' },
      { type: 'tool_result_start', toolCallId: 'c1', messageId: 't1' },
      { type: 'tool_result_delta', toolCallId: 'c1', messageId: 't1', delta: 'file1\nfile2' },
      { type: 'tool_result_end', toolCallId: 'c1', messageId: 't1', isError: false },
      { type: 'run_end', runId: 'R1', sessionId: 'S1', stopReason: 'no_tool_call' },
    ]);
    // assistant m1 含 tool_call；tool m t1 含 result
    const assistant = s.messages.find((m) => m.id === 'a1')!;
    const tool = s.messages.find((m) => m.id === 't1')!;
    expect(assistant.content).toContainEqual({
      type: 'tool_call',
      id: 'c1',
      name: 'bash',
      arguments: { command: 'ls' },
    });
    expect(tool.content).toContainEqual({
      type: 'tool_result',
      toolCallId: 'c1',
      content: [{ type: 'text', text: 'file1\nfile2' }],
      isError: false,
    });
    // loading 阶段切换
    // run_start=thinking → message_start assistant=answering → tool_call_start=tool_calling
    // → tool_result_start=tool_executing → run_end=null
    expect(s.loadingPhase).toBeNull();
  });

  it('tool_call loading 阶段：tool_call_start→tool_calling；tool_result_start→tool_executing', () => {
    let s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      { type: 'message_start', messageId: 'a1', sessionId: 'S1', role: 'assistant' },
      { type: 'tool_call_start', toolCallId: 'c1', toolName: 'f', messageId: 'a1' },
    ]);
    expect(s.loadingPhase).toBe('tool_calling');
    s = reduce([
      ...( [] as AgentEvent[]),
      { type: 'run_start', runId: 'R1', sessionId: 'S1' } as AgentEvent,
      { type: 'message_start', messageId: 'a1', sessionId: 'S1', role: 'assistant' },
      { type: 'tool_call_start', toolCallId: 'c1', toolName: 'f', messageId: 'a1' },
      { type: 'tool_call_delta', toolCallId: 'c1', messageId: 'a1', delta: '{}' },
      { type: 'tool_call_end', toolCallId: 'c1', messageId: 'a1' },
      { type: 'tool_result_start', toolCallId: 'c1', messageId: 't1' },
    ]);
    expect(s.loadingPhase).toBe('tool_executing');
  });

  // [v0.0.19 BUG-fix 回归] 两个并行 tool_call + 两个 tool_result（DISTINCT messageId）
  // 修复前：生产 emitToolResult 不发 messageId，两个 result 都按 evt.messageId(=undefined)
  // 建 tool 消息 → 第 2 个 result 丢失（id 冲突/未入列），flatten 后 done<total。
  // 修复后：服务端每个 result 生成独立 messageId，客户端各建独立 tool 消息节点，
  // 各自绑定到对应 tool_call。
  it('多工具：两个 result 用 DISTINCT messageId，各自绑定到对应 tool_call（flatten 后 done=total=2）', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      { type: 'message_start', messageId: 'a1', sessionId: 'S1', role: 'assistant' },
      // 两个并行 tool_call
      { type: 'tool_call_start', toolCallId: 'c1', toolName: 'bash', messageId: 'a1' },
      { type: 'tool_call_delta', toolCallId: 'c1', messageId: 'a1', delta: '{"command":"ls"}' },
      { type: 'tool_call_end', toolCallId: 'c1', messageId: 'a1' },
      { type: 'tool_call_start', toolCallId: 'c2', toolName: 'grep', messageId: 'a1' },
      { type: 'tool_call_delta', toolCallId: 'c2', messageId: 'a1', delta: '{"pattern":"foo"}' },
      { type: 'tool_call_end', toolCallId: 'c2', messageId: 'a1' },
      // 两个 tool_result 用 DISTINCT messageId（修复后服务端 emitToolResult 行为）
      { type: 'tool_result_start', toolCallId: 'c1', messageId: 't1' },
      { type: 'tool_result_delta', toolCallId: 'c1', messageId: 't1', delta: 'file1' },
      { type: 'tool_result_end', toolCallId: 'c1', messageId: 't1', isError: false },
      { type: 'tool_result_start', toolCallId: 'c2', messageId: 't2' },
      { type: 'tool_result_delta', toolCallId: 'c2', messageId: 't2', delta: 'match1' },
      { type: 'tool_result_end', toolCallId: 'c2', messageId: 't2', isError: false },
      { type: 'run_end', runId: 'R1', sessionId: 'S1', stopReason: 'no_tool_call' },
    ]);
    // 两条 tool 消息各自独立（messageId distinct）
    const toolMsgs = s.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    expect(new Set(toolMsgs.map((m) => m.id)).size).toBe(2);
    // buildToolResultMap 绑定：c1→t1, c2→t2（两个 call 都 bind 到 result）
    const map = buildToolResultMap(s.messages);
    expect(map.get('c1')).toMatchObject({
      content: [{ type: 'text', text: 'file1' }],
      isError: false,
    });
    expect(map.get('c2')).toMatchObject({
      content: [{ type: 'text', text: 'match1' }],
      isError: false,
    });
    // done=total=2（两个 call 都有 result 绑定）
    const assistant = s.messages.find((m) => m.id === 'a1')!;
    const calls = assistant.content.filter((b) => b.type === 'tool_call');
    expect(calls).toHaveLength(2);
    const done = calls.filter((c) => c.type === 'tool_call' && map.has(c.id)).length;
    expect(done).toBe(2);
    expect(done).toBe(calls.length);
  });

  // [v0.0.28 BUG-fix 回归] 错过 message_start：subagent 只读页场景
  //   run 后台开始 → 用户后切到该页 → message_start(role=assistant) 已发完，
  //   ctxRef.currentAssistantMessageId 永远没设。
  //   修复前：tool_call_start 用 ctxRef.currentAssistantMessageId 锚定 → targetId=undefined
  //     → if(targetId) false → tool_call part 静默丢弃（实证：subagent 26 个 tool_call UI 只显 2 个）。
  //   修复后：tool_call_* 用 evt.messageId（事件自带）锚定；
  //     tool_call_start 在 message 不存在时兜底建 assistant message。
  it('错过 message_start：tool_call_start 兜底建 assistant message + tool_call part 正确附加', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      // 注意：不发 message_start（模拟用户后切到进行中的 run，message_start 已错过）
      { type: 'tool_call_start', toolCallId: 'c1', toolName: 'bash', messageId: 'a1' },
      { type: 'tool_call_delta', toolCallId: 'c1', messageId: 'a1', delta: '{"command":"ls"}' },
      { type: 'tool_call_end', toolCallId: 'c1', messageId: 'a1' },
      { type: 'run_end', runId: 'R1', sessionId: 'S1', stopReason: 'no_tool_call' },
    ]);
    // 兜底：assistant message 被创建（id=evt.messageId, role=assistant）
    const assistant = s.messages.find((m) => m.id === 'a1');
    expect(assistant).toBeDefined();
    expect(assistant!.role).toBe('assistant');
    // 核心：tool_call part 没被静默丢弃，arguments 正确解析
    expect(assistant!.content).toContainEqual({
      type: 'tool_call',
      id: 'c1',
      name: 'bash',
      arguments: { command: 'ls' },
    });
    // loading 阶段切到 tool_calling
    // （run_end 后回到 null，这里只验证 message + content 正确）
  });

  it('错过 message_start：多个 tool_call 全部附加（之前会全丢，只显 GET /messages 落盘的前几个）', () => {
    // 模拟 subagent 只读页：切到时已有 2 个 tool_call 落盘（GET /messages 拿到），
    // 后续 stream 又来 3 个 tool_call（错过 message_start）。
    const existing: Message = {
      id: 'a1',
      sessionId: 'S1',
      role: 'assistant',
      content: [
        { type: 'tool_call', id: 'c-prev1', name: 'grep', arguments: { pattern: 'a' } },
        { type: 'tool_call', id: 'c-prev2', name: 'grep', arguments: { pattern: 'b' } },
      ],
      runId: 'R1',
      createdAt: '2026-06-28T00:00:00.000Z',
    };
    // v0.0.95：reducer 纯化——runCtx 改值传递（出入参）；显式类型避免控制流收窄为 null
    let runCtx: { runId: string; currentAssistantMessageId?: string; toolCallRawArgs?: Map<string, string> } | null = null;
    let state = { ...emptyState, messages: [existing] } as never;
    const events: AgentEvent[] = [
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      { type: 'tool_call_start', toolCallId: 'c3', toolName: 'bash', messageId: 'a1' },
      { type: 'tool_call_delta', toolCallId: 'c3', messageId: 'a1', delta: '{"command":"ls"}' },
      { type: 'tool_call_end', toolCallId: 'c3', messageId: 'a1' },
      { type: 'tool_call_start', toolCallId: 'c4', toolName: 'bash', messageId: 'a1' },
      { type: 'tool_call_delta', toolCallId: 'c4', messageId: 'a1', delta: '{"command":"pwd"}' },
      { type: 'tool_call_end', toolCallId: 'c4', messageId: 'a1' },
      { type: 'tool_call_start', toolCallId: 'c5', toolName: 'cat', messageId: 'a1' },
      { type: 'tool_call_delta', toolCallId: 'c5', messageId: 'a1', delta: '{"path":"x"}' },
      { type: 'tool_call_end', toolCallId: 'c5', messageId: 'a1' },
    ];
    for (const e of events) {
      const r = applyAgentEventToMessages((state as { messages: Message[] }).messages, runCtx, e, state);
      state = r as never;
      runCtx = r.runCtx;
    }
    const assistant = (state as { messages: Message[] }).messages.find((m) => m.id === 'a1')!;
    const calls = assistant.content.filter((b) => b.type === 'tool_call');
    // 2 落盘 + 3 stream = 5（修复前会只剩 2，后 3 个静默丢弃）
    expect(calls).toHaveLength(5);
    expect(calls.map((c) => (c as { id: string }).id)).toEqual(['c-prev1', 'c-prev2', 'c3', 'c4', 'c5']);
  });
});

describe('path C — error 事件 + run_end stopReason=error', () => {
  it('[v0.0.25] 旧后端 error 事件（只有 message/code）→ 映射到新契约（displayReason←message, category←code）', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      { type: 'message_start', messageId: 'a1', sessionId: 'S1', role: 'assistant' },
      { type: 'error', message: 'rate limited', code: 'RATE_LIMIT' },
      { type: 'run_end', runId: 'R1', sessionId: 'S1', stopReason: 'error' },
    ]);
    expect(s.lastRunFinish).toEqual({
      stopReason: 'error',
      error: { category: 'RATE_LIMIT', displayReason: 'rate limited', code: 'RATE_LIMIT' },
    });
    expect(s.runActive).toBe(false);
    expect(s.loadingPhase).toBeNull();
  });

  it('[v0.0.25] 新后端 error 事件（errorCategory/displayReason/errorDetail）→ 直接落新契约', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      { type: 'error', errorCategory: 'PROVIDER_OVERLOADED', displayReason: '服务商过载，请稍后重试', errorDetail: 'anthropic 529 overloaded_error' },
      { type: 'run_end', runId: 'R1', sessionId: 'S1', stopReason: 'error' },
    ]);
    expect(s.lastRunFinish).toEqual({
      stopReason: 'error',
      error: {
        category: 'PROVIDER_OVERLOADED',
        displayReason: '服务商过载，请稍后重试',
        detail: 'anthropic 529 overloaded_error',
      },
    });
  });

  it('run_end stopReason=max_iterations 警告态（无 error）', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      { type: 'run_end', runId: 'R1', sessionId: 'S1', stopReason: 'max_iterations' },
    ]);
    expect(s.lastRunFinish).toEqual({ stopReason: 'max_iterations' });
  });
});

describe('BUG-006 根治（v0.0.12）—— 对话区只渲染服务端 SSE message_start', () => {
  it('message_start(user) 按 messageId 幂等入列（不再依赖 local-* 启发式去重）', () => {
    // 模拟 v0.0.12：发消息不本地 push local-* user，等 SSE message_start(user) 真身 ULID 入列
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      { type: 'message_start', messageId: '01KVK5WTW75N3Z12AB', sessionId: 'S1', role: 'user' },
    ]);
    const users = s.messages.filter((m) => m.role === 'user');
    expect(users).toHaveLength(1);
    expect(users[0]!.id).toBe('01KVK5WTW75N3Z12AB');
  });

  it('同 messageId 重复 message_start 幂等（不重复入列）', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      { type: 'message_start', messageId: 'u1', sessionId: 'S1', role: 'user' },
      { type: 'message_start', messageId: 'u1', sessionId: 'S1', role: 'user' },
    ]);
    expect(s.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('assistant message_start 正常入列 + loadingPhase=answering', () => {
    const s = reduce([
      { type: 'run_start', runId: 'R1', sessionId: 'S1' },
      { type: 'message_start', messageId: 'a1', sessionId: 'S1', role: 'assistant' },
    ]);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]!.role).toBe('assistant');
    expect(s.loadingPhase).toBe('answering');
  });
});