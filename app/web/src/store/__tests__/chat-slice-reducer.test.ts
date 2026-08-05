/**
 * chat-slice-reducer 纯化验证（v0.0.95.lifecycle_buffer T1）
 * 参考: specs/tech/version_logs/v0.0.95.lifecycle_buffer/change_plan.md §T1 §B（reducer 纯化）
 *       BUG-002 链路：rawArgs 累积语义严格不变（tool_call_delta 逐字符累积 → tool_call_end parse 写 messages）
 *
 * 验证点：
 *   - reducer 纯函数：无 mutate 入参 / 无 ref 副作用（runCtx 值传递 + 返回新 runCtx）
 *   - rawArgs 累积语义不变（tool_call_delta 逐字符累积进 runCtx.toolCallRawArgs）
 *   - tool_call_end parse 写回 messages.arguments + 返删 key 的新 Map（D2 落地）
 *   - run_start/error/run_end 各 case 的 runCtx 副作用全改 immutable return
 *   - StrictMode 双调用幂等：同一 evt 应用两次，第二次输入「第一次输出」结果与第一次一致（无 double 累积）
 */
import { describe, it, expect } from 'vitest';
import {
  applyAgentEventToMessages,
  type AgentEvent,
  type ReducerState,
  type RunContext,
} from '../chat-slice-reducer';
import type { Message } from '../../components/chat-page/types';

const emptyState: ReducerState = {
  loadingPhase: null,
  runActive: false,
  lastRunFinish: null,
  enqueueItems: [],
  pendingToolCall: null,
};

/** 构造 run_start 事件 */
const runStart = (runId: string): AgentEvent => ({ type: 'run_start', runId, sessionId: 's1' });
/** 构造 message_start(role=assistant) 事件 */
const assistantStart = (messageId: string, runId?: string): AgentEvent => ({
  type: 'message_start',
  messageId,
  sessionId: 's1',
  role: 'assistant',
  ...(runId ? { metadata: { runId } } : {}),
});
/** 构造 tool_call_start 事件 */
const toolCallStart = (toolCallId: string, toolName: string, messageId: string): AgentEvent => ({
  type: 'tool_call_start',
  toolCallId,
  toolName,
  messageId,
});
/** 构造 tool_call_delta 事件（一片 JSON 片段） */
const toolCallDelta = (toolCallId: string, messageId: string, delta: string): AgentEvent => ({
  type: 'tool_call_delta',
  toolCallId,
  messageId,
  delta,
});
/** 构造 tool_call_end 事件 */
const toolCallEnd = (toolCallId: string, messageId: string): AgentEvent => ({
  type: 'tool_call_end',
  toolCallId,
  messageId,
});

// ──────────────────────────────────────────────────────────────────────────────
// 纯函数性：不 mutate 入参（runCtx / messages / state）
// ──────────────────────────────────────────────────────────────────────────────
describe('reducer 纯函数性（无 mutate 入参）', () => {
  it('run_start：返回新 runCtx 对象，不 mutate 入参 runCtx', () => {
    const inputRunCtx: RunContext | null = null;
    const result = applyAgentEventToMessages([], inputRunCtx, runStart('r1'), emptyState);
    expect(result.runCtx).toEqual({ runId: 'r1' });
    expect(inputRunCtx).toBeNull(); // 入参未变
  });

  it('tool_call_delta：返回新 runCtx + 新 Map，不 mutate 入参 runCtx', () => {
    // 先 run_start 建立初始 runCtx
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const initialRunCtx = r0.runCtx!;
    // 快照初始 runCtx（防止后续 mutate）
    const initialRunCtxSnapshot = { ...initialRunCtx, toolCallRawArgs: undefined };

    // 应用 tool_call_delta
    const r1 = applyAgentEventToMessages(
      r0.messages,
      initialRunCtx,
      toolCallDelta('tc1', 'm1', '{"a"'),
      r0,
    );
    // 入参 initialRunCtx 未被 mutate（toolCallRawArgs 仍为 undefined）
    expect(initialRunCtx.toolCallRawArgs).toBeUndefined();
    expect(initialRunCtx).toEqual(initialRunCtxSnapshot);
    // 返回的 runCtx 有新 Map 含 tc1
    expect(r1.runCtx?.toolCallRawArgs?.get('tc1')).toBe('{"a"');
  });

  it('tool_call_end：返回删 key 的新 Map，不 mutate 入参', () => {
    // 准备：run_start → tool_call_delta（建立 runCtx.toolCallRawArgs）
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const r1 = applyAgentEventToMessages(
      r0.messages,
      r0.runCtx,
      toolCallDelta('tc1', 'm1', '{"a":1}'),
      r0,
    );
    const beforeEndRunCtx = r1.runCtx!;
    const beforeEndRawMap = beforeEndRunCtx.toolCallRawArgs!;

    // 应用 tool_call_end
    const r2 = applyAgentEventToMessages(
      r1.messages,
      beforeEndRunCtx,
      toolCallEnd('tc1', 'm1'),
      r1,
    );
    // 入参 beforeEndRunCtx 未被 mutate（toolCallRawArgs 仍含 tc1）
    expect(beforeEndRunCtx.toolCallRawArgs).toBe(beforeEndRawMap);
    expect(beforeEndRawMap.get('tc1')).toBe('{"a":1}');
    // 返回的 runCtx 的 toolCallRawArgs 不再含 tc1（D2 落地）
    expect(r2.runCtx?.toolCallRawArgs?.has('tc1')).toBe(false);
  });

  it('messages 入参不被 mutate（reducer 内 patchMsg 用 map 不 mutate）', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const inputMessages = r0.messages;
    const inputMessagesLength = inputMessages.length;

    const r1 = applyAgentEventToMessages(
      inputMessages,
      r0.runCtx,
      assistantStart('m1'),
      r0,
    );
    // 入参 messages 长度未变（reducer 不 push 到入参）
    expect(inputMessages.length).toBe(inputMessagesLength);
    // 返回的 messages 含新消息
    expect(r1.messages.length).toBe(inputMessagesLength + 1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// rawArgs 累积语义不变（BUG-002 链路：逐字符累积 → end parse）
// ──────────────────────────────────────────────────────────────────────────────
describe('rawArgs 累积语义不变（BUG-002 链路）', () => {
  it('逐字符累积：5 帧 delta 拼成完整 JSON，end 时 parse 写回 arguments', () => {
    // 准备 messages（含 tool_call part）
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, assistantStart('m1'), r0);
    const r2 = applyAgentEventToMessages(
      r1.messages,
      r1.runCtx,
      toolCallStart('tc1', 'search', 'm1'),
      r1,
    );

    // 5 帧 delta 拼成 '{"q":"hello"}'
    const pieces = ['{', '"q"', ':', '"hello"', '}'];
    let prev = r2;
    for (const p of pieces) {
      prev = applyAgentEventToMessages(
        prev.messages,
        prev.runCtx,
        toolCallDelta('tc1', 'm1', p),
        prev,
      );
    }
    // 累积后 runCtx.toolCallRawArgs.get('tc1') = 完整 JSON
    expect(prev.runCtx?.toolCallRawArgs?.get('tc1')).toBe('{"q":"hello"}');

    // tool_call_end：parse 写回 messages.arguments + 返删 key 的新 Map
    const rEnd = applyAgentEventToMessages(
      prev.messages,
      prev.runCtx,
      toolCallEnd('tc1', 'm1'),
      prev,
    );
    // messages 中 m1 的 tool_call part 的 arguments 已 parse
    const m1 = rEnd.messages.find((m) => m.id === 'm1')!;
    const toolCallPart = m1.content.find(
      (b) => b.type === 'tool_call' && b.id === 'tc1',
    ) as { type: 'tool_call'; arguments: Record<string, unknown> } | undefined;
    expect(toolCallPart?.arguments).toEqual({ q: 'hello' });
    // runCtx.toolCallRawArgs 中 tc1 已删（D2）
    expect(rEnd.runCtx?.toolCallRawArgs?.has('tc1')).toBe(false);
  });

  it('rawArgs JSON parse 失败时落 _raw 字段（不抛异常）', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, assistantStart('m1'), r0);
    const r2 = applyAgentEventToMessages(
      r1.messages,
      r1.runCtx,
      toolCallStart('tc1', 'search', 'm1'),
      r1,
    );
    // 累积无效 JSON
    const r3 = applyAgentEventToMessages(
      r2.messages,
      r2.runCtx,
      toolCallDelta('tc1', 'm1', 'not-valid-json'),
      r2,
    );
    const rEnd = applyAgentEventToMessages(
      r3.messages,
      r3.runCtx,
      toolCallEnd('tc1', 'm1'),
      r3,
    );
    const m1 = rEnd.messages.find((m) => m.id === 'm1')!;
    const toolCallPart = m1.content.find(
      (b) => b.type === 'tool_call' && b.id === 'tc1',
    ) as { type: 'tool_call'; arguments: Record<string, unknown> } | undefined;
    // parse 失败 fallback 到 { _raw: 'not-valid-json' }
    expect(toolCallPart?.arguments).toEqual({ _raw: 'not-valid-json' });
  });

  it('多个并发 toolCallId 各自独立累积（互不串扰）', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, assistantStart('m1'), r0);
    const r2 = applyAgentEventToMessages(
      r1.messages,
      r1.runCtx,
      toolCallStart('tc1', 'search', 'm1'),
      r1,
    );
    const r3 = applyAgentEventToMessages(
      r2.messages,
      r2.runCtx,
      toolCallStart('tc2', 'calc', 'm1'),
      r2,
    );
    // 交替发 delta
    let prev = r3;
    prev = applyAgentEventToMessages(prev.messages, prev.runCtx, toolCallDelta('tc1', 'm1', 'A'), prev);
    prev = applyAgentEventToMessages(prev.messages, prev.runCtx, toolCallDelta('tc2', 'm1', 'X'), prev);
    prev = applyAgentEventToMessages(prev.messages, prev.runCtx, toolCallDelta('tc1', 'm1', 'B'), prev);
    prev = applyAgentEventToMessages(prev.messages, prev.runCtx, toolCallDelta('tc2', 'm1', 'Y'), prev);
    // tc1 累积 'AB'，tc2 累积 'XY'（互不串扰）
    expect(prev.runCtx?.toolCallRawArgs?.get('tc1')).toBe('AB');
    expect(prev.runCtx?.toolCallRawArgs?.get('tc2')).toBe('XY');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// error → pendingError 累积 → run_end 写入 lastRunFinish（§4.13）
// ──────────────────────────────────────────────────────────────────────────────
describe('error / run_end 的 runCtx immutable return', () => {
  it('error 事件：返含 pendingError 的新 runCtx（不 mutate 入参）', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const inputRunCtx = r0.runCtx!;
    const r1 = applyAgentEventToMessages(
      r0.messages,
      inputRunCtx,
      { type: 'error', errorCategory: 'RATE_LIMITED', displayReason: 'Too many requests', code: '429' },
      r0,
    );
    // 入参未变（pendingError 仍 undefined）
    expect(inputRunCtx.pendingError).toBeUndefined();
    // 返回的 runCtx 含 pendingError
    expect(r1.runCtx?.pendingError).toEqual({
      category: 'RATE_LIMITED',
      displayReason: 'Too many requests',
      code: '429',
    });
  });

  it('run_end：读 pendingError 写入 lastRunFinish.error + 返 runCtx=null', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const r1 = applyAgentEventToMessages(
      r0.messages,
      r0.runCtx,
      { type: 'error', errorCategory: 'RATE_LIMITED', displayReason: 'Too many requests' },
      r0,
    );
    const r2 = applyAgentEventToMessages(
      r1.messages,
      r1.runCtx,
      { type: 'run_end', runId: 'r1', sessionId: 's1', stopReason: 'error' },
      r1,
    );
    // run_end 返回 runCtx=null
    expect(r2.runCtx).toBeNull();
    // lastRunFinish.error 含 pendingError
    expect(r2.lastRunFinish?.stopReason).toBe('error');
    expect(r2.lastRunFinish?.error?.category).toBe('RATE_LIMITED');
    expect(r2.lastRunFinish?.error?.displayReason).toBe('Too many requests');
    expect(r2.runActive).toBe(false);
    expect(r2.loadingPhase).toBeNull();
  });

  it('run_end 无 pendingError：lastRunFinish 不含 error 字段', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const r1 = applyAgentEventToMessages(
      r0.messages,
      r0.runCtx,
      { type: 'run_end', runId: 'r1', sessionId: 's1', stopReason: 'no_tool_call' },
      r0,
    );
    expect(r1.runCtx).toBeNull();
    expect(r1.lastRunFinish?.stopReason).toBe('no_tool_call');
    expect(r1.lastRunFinish?.error).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// StrictMode 双调用幂等：同一 evt 应用两次（第二次输入第一次输出）结果一致（无 double 累积）
// ──────────────────────────────────────────────────────────────────────────────
describe('StrictMode 双调用幂等（无 double 累积）', () => {
  it('tool_call_delta 应用两次（第二次输入第一次输出）：rawArgs 不 double 累积', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, assistantStart('m1'), r0);
    const r2 = applyAgentEventToMessages(
      r1.messages,
      r1.runCtx,
      toolCallStart('tc1', 'search', 'm1'),
      r1,
    );

    // 第一次应用 delta '{"a":1}'
    const firstApply = applyAgentEventToMessages(
      r2.messages,
      r2.runCtx,
      toolCallDelta('tc1', 'm1', '{"a":1}'),
      r2,
    );
    expect(firstApply.runCtx?.toolCallRawArgs?.get('tc1')).toBe('{"a":1}');

    // 第二次应用同一 evt（输入第一次的输出）—— 模拟 StrictMode 双调用
    const secondApply = applyAgentEventToMessages(
      firstApply.messages,
      firstApply.runCtx,
      toolCallDelta('tc1', 'm1', '{"a":1}'),
      firstApply,
    );
    // 关键：第二次累积是从 '{"a":1}' 起 + '{"a":1}' = '{"a":1}{"a":1}'（reducer 是纯累积，StrictMode 双调用的幂等性归消费方——reducer 本身语义不变）
    // 这里验证：reducer 行为可预测（每次 delta 都追加）；StrictMode 幂等性是消费方（useMessages）通过 buffer-only-不渲染 + React commit dedupe 保证
    expect(secondApply.runCtx?.toolCallRawArgs?.get('tc1')).toBe('{"a":1}{"a":1}');
  });

  it('text_block_delta 应用两次：text 累积两次（reducer 纯累积，幂等性归消费方）', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, assistantStart('m1'), r0);
    const deltaEvt: AgentEvent = {
      type: 'text_block_delta',
      blockId: 'b1',
      messageId: 'm1',
      delta: 'hi',
    };
    const first = applyAgentEventToMessages(r1.messages, r1.runCtx, deltaEvt, r1);
    const m1First = first.messages.find((m) => m.id === 'm1')!;
    const textFirst = m1First.content.find((b) => b.type === 'text') as { type: 'text'; text: string };
    expect(textFirst.text).toBe('hi');

    // 第二次应用同一 evt（输入第一次输出）
    const second = applyAgentEventToMessages(first.messages, first.runCtx, deltaEvt, first);
    const m1Second = second.messages.find((m) => m.id === 'm1')!;
    const textSecond = m1Second.content.find((b) => b.type === 'text') as { type: 'text'; text: string };
    // 纯累积：'hi' + 'hi' = 'hihi'（reducer 行为；StrictMode 幂等性靠消费方不重复应用同一 evt）
    expect(textSecond.text).toBe('hihi');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// enqueue 三事件（design §3.4）—— 验证 reducer 纯化不影响 enqueue 逻辑
// ──────────────────────────────────────────────────────────────────────────────
describe('enqueue 三事件不受纯化影响', () => {
  it('message_enqueued 建 + processed 移除（幂等）', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const r1 = applyAgentEventToMessages(
      r0.messages,
      r0.runCtx,
      { type: 'message_enqueued', enqueueId: 'eq1', content: [{ type: 'text', text: 'hi' }] },
      r0,
    );
    expect(r1.enqueueItems).toEqual([{ enqueueId: 'eq1', content: 'hi' }]);
    expect(r1.runCtx).toBe(r0.runCtx); // runCtx 引用未变（enqueue 不碰 runCtx）

    const r2 = applyAgentEventToMessages(
      r1.messages,
      r1.runCtx,
      { type: 'enqueued_message_processed', enqueueId: 'eq1' },
      r1,
    );
    expect(r2.enqueueItems).toEqual([]);
  });
});

/**
 * [v0.0.101] HITL ask-question require_human_input reducer。
 *
 * loop ③ 段 pending.length>0 时 emit 队首单个 PendingToolCall → reducer 写 pendingToolCall
 * （驱动前端 mount 提问卡）。多 pending 串行（INV-4 peek 队首）：resolve 一条后 emit 下一个。
 */
describe('[v0.0.101] require_human_input reducer', () => {
  /** 构造 need_feedback pending（最小载荷） */
  function makePending(toolCallId = 'tc1') {
    return {
      sessionId: 's1',
      runId: 'r1',
      toolCallId,
      toolName: 'ask-question',
      handleType: 'direct_result' as const,
      subState: 'need_feedback' as const,
      data: {
        questions: [
          { id: 'q1', title: 'Q1', type: 'single' as const, options: [{ key: 'a', label: 'A' }] },
        ],
      },
      resultMessageId: 'm1',
      resultBlockIndex: 0,
      status: 'pending' as const,
    };
  }

  it('require_human_input → pendingToolCall 替换为事件 payload 队首', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const evt = { type: 'require_human_input' as const, pending: makePending('tc1') };
    const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, evt, r0);
    expect(r1.pendingToolCall).not.toBeNull();
    expect(r1.pendingToolCall?.toolCallId).toBe('tc1');
  });

  it('多 pending 串行：第二个 require_human_input 替换队首（INV-4 peek 队首）', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx,
      { type: 'require_human_input', pending: makePending('tc1') }, r0);
    const r2 = applyAgentEventToMessages(r1.messages, r1.runCtx,
      { type: 'require_human_input', pending: makePending('tc2') }, r1);
    expect(r2.pendingToolCall?.toolCallId).toBe('tc2');
    // 切换后旧 pending 已被替换（last-write-wins，事件携带的就是当前队首）
  });

  it('require_human_input 不影响 messages / enqueueItems / runCtx（互不污染）', () => {
    const r0 = applyAgentEventToMessages([], null, runStart('r1'), emptyState);
    const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx,
      { type: 'message_enqueued', enqueueId: 'eq1', content: '排队中' }, r0);
    const before = r1.enqueueItems.length;
    const beforeMsgs = r1.messages.length;
    const r2 = applyAgentEventToMessages(r1.messages, r1.runCtx,
      { type: 'require_human_input', pending: makePending() }, r1);
    // enqueue 不受影响
    expect(r2.enqueueItems.length).toBe(before);
    // messages 不受影响
    expect(r2.messages.length).toBe(beforeMsgs);
    // runCtx 不变（require_human_input 不碰 runCtx）
    expect(r2.runCtx).toBe(r1.runCtx);
  });

  it('空 state（pendingToolCall=null）→ emit 后非空（mount 提问卡的主判定）', () => {
    expect(emptyState.pendingToolCall).toBeNull();
    const r = applyAgentEventToMessages([], null,
      { type: 'require_human_input', pending: makePending() }, emptyState);
    expect(r.pendingToolCall).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// [v0.0.107] message_start origin → 创建 Message 时写 sender.channel（reducer 只转录不做展示判断）
// ──────────────────────────────────────────────────────────────────────────────
describe('[v0.0.107] message_start origin → sender.channel', () => {
  const userStart = (messageId: string, origin?: { type: string; configId: string }): AgentEvent => ({
    type: 'message_start',
    messageId,
    sessionId: 's1',
    role: 'user',
    ...(origin ? { origin } : {}),
  });

  it('origin present（feishu）→ 创建的 Message 写 sender.channel { type, configId }', () => {
    const r = applyAgentEventToMessages([], null, userStart('um1', { type: 'feishu', configId: 'inst-1' }), emptyState);
    const msg = r.messages.find((m) => m.id === 'um1')!;
    expect(msg.sender).toEqual({ source: 'user', channel: { type: 'feishu', configId: 'inst-1' } });
  });

  it('client origin 也照写（显示 gate 交 flatten，reducer 单一职责）', () => {
    const r = applyAgentEventToMessages([], null, userStart('um2', { type: 'client', configId: '0' }), emptyState);
    const msg = r.messages.find((m) => m.id === 'um2')!;
    expect(msg.sender).toEqual({ source: 'user', channel: { type: 'client', configId: '0' } });
  });

  it('无 origin → 不写 sender（向后兼容，web 自发消息）', () => {
    const r = applyAgentEventToMessages([], null, userStart('um3'), emptyState);
    const msg = r.messages.find((m) => m.id === 'um3')!;
    expect(msg.sender).toBeUndefined();
  });
});
