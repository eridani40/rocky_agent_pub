// @vitest-environment jsdom
/**
 * useMessages area-hook 单测（v0.0.94.component_refactor T2 · 流式特例）
 * 参考: specs/tech/app/frontend/[P0]chat_area_hooks.md §3（流式特例：多订阅 + 领域 reducer）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10 不变量①（ref-latest 不丢帧）
 *
 * 覆盖：
 *   - 初始 GET /messages(limit 50) 拉基线
 *   - agent_loop run_start/message_start/text_block_delta/run_end → applyAgentEventToMessages
 *   - [不变量①] 连续高频 text_block_delta 不丢字（onEvent 读 sliceRef.current 最新态累积）
 *   - session_panel messages_cleared → 清 messages/lastRunFinish/enqueueItems
 *   - [D7] session_panel 终态(idle/error/interrupted) → 强制 runActive=false, loadingPhase=null（清 sticky 孤儿）
 *   - session_panel running(interrupting) → 清 pendingToolCall（治 HITL 卡片悬挂）
 *   - session_panel 非终态(running/interrupting) 不清 runActive
 *   - setMessages（命令式，by-id merge）
 *   - [v0.0.97] GET /inbox seed enqueueItems（onInit GET /messages 后拉，contentBlocksToPreviewText 转 string）
 *   - 切 session：cleanup unsubscribe（不 destroy 单例）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Message, PendingToolCallView } from '../types';

const sse = vi.hoisted(() => ({
  // 每主题存 handler + group（useLifecycle handleFrame 读 frame.topic/group 分流，须完整 SseFrame）
  handlers: {} as Record<string, { handler: (f: { data: unknown; topic: string; group: string }) => void; group: string }>,
  instances: 0,
  destroyed: 0,
  unsub: [] as string[],
}));
const apiMocks = vi.hoisted(() => ({
  getMessages: vi.fn(),
  getInbox: vi.fn(),
  getPendingToolCall: vi.fn(),
  postMessage: vi.fn(),
}));
const singletonPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/sse-singleton'));
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'));

vi.mock(singletonPath, () => {
  let subIdCounter = 0;
  class FakeSseClient {
    constructor() {
      sse.instances++;
    }
    async connect() {
      /* no-op */
    }
    async subscribe(topic: string, group: string, handler: (f: { data: unknown; topic: string; group: string }) => void) {
      sse.handlers[topic] = { handler, group };
      const subId = `sub-${++subIdCounter}-${topic}`;
      return { subId, topic, group, unsubscribe: async () => { sse.unsub.push(topic); } };
    }
    async unsubscribe(handle: { subId?: string } | string) {
      const subId = typeof handle === 'string' ? handle : handle?.subId;
      if (subId) sse.unsub.push(subId);
    }
    destroy() {
      sse.destroyed++;
    }
  }
  let singleton: FakeSseClient | null = null;
  return {
    getSseClient: () => {
      if (!singleton) singleton = new FakeSseClient();
      return singleton;
    },
    _resetSseSingletonForTest: () => {
      if (singleton) singleton.destroy();
      singleton = null;
    },
  };
});
vi.mock(apiPath, () => apiMocks);

import { useMessages } from '../use-messages';
import type { AgentEvent } from '../../../store/chat-slice-reducer';
import type { SessionEvent } from '../../../store/session-slice-reducer';

function pushAgent(evt: AgentEvent): void {
  const h = sse.handlers['agent_loop'];
  act(() => h?.handler({ data: evt, topic: 'agent_loop', group: h.group }));
}
function pushPanel(evt: SessionEvent): void {
  const h = sse.handlers['session_panel'];
  act(() => h?.handler({ data: evt, topic: 'session_panel', group: h.group }));
}
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  sse.handlers = {};
  sse.instances = 0;
  sse.destroyed = 0;
  sse.unsub = [];
  apiMocks.getMessages.mockReset().mockResolvedValue({ items: [], hasMore: false });
  apiMocks.getInbox.mockReset().mockResolvedValue({ items: [] });
  apiMocks.getPendingToolCall.mockReset().mockResolvedValue({ pending: null });
  apiMocks.postMessage.mockReset().mockResolvedValue({ runId: 'r1', enqueueId: 'eq1' });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('useMessages — 初始 GET /messages', () => {
  it('mount 拉 messages(limit 50) + hasMore', async () => {
    apiMocks.getMessages.mockResolvedValue({
      items: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], sessionId: 's1', createdAt: 't' } as Message],
      hasMore: true,
    });
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    expect(apiMocks.getMessages).toHaveBeenCalledWith('s1', { limit: 50 });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.hasMore).toBe(true);
  });

  it('GET 失败 → 空基线（SSE 仍可推增量）', async () => {
    apiMocks.getMessages.mockRejectedValue(new Error('net'));
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    expect(result.current.messages).toEqual([]);
    expect(result.current.hasMore).toBe(false);
  });

  it('消息带 stopReason → seed lastRunFinish（冷读恢复，取最后一条带 stopReason 的）', async () => {
    apiMocks.getMessages.mockResolvedValue({
      items: [
        { id: 'm1', role: 'user', content: [{ type: 'text', text: 'q' }], sessionId: 's1', createdAt: 't' },
        { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'a1' }], sessionId: 's1', createdAt: 't', runId: 'r1', stopReason: 'max_iterations' },
        { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'a2' }], sessionId: 's1', createdAt: 't', runId: 'r2', stopReason: 'no_tool_call' },
      ] as Message[],
      hasMore: false,
    });
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    expect(result.current.lastRunFinish).toEqual({ stopReason: 'no_tool_call' });
  });

  it('stopReason=error + runError → seed lastRunFinish.error（映射对齐 SSE run_end 契约）', async () => {
    apiMocks.getMessages.mockResolvedValue({
      items: [
        {
          id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'a' }], sessionId: 's1', createdAt: 't',
          runId: 'r1', stopReason: 'error',
          runError: { errorCategory: 'PROVIDER_OVERLOADED', displayReason: '服务过载', errorDetail: 'raw 529' },
        },
      ] as Message[],
      hasMore: false,
    });
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    expect(result.current.lastRunFinish).toEqual({
      stopReason: 'error',
      error: { category: 'PROVIDER_OVERLOADED', displayReason: '服务过载', detail: 'raw 529' },
    });
  });

  it('消息均无 stopReason → lastRunFinish 保持 null', async () => {
    apiMocks.getMessages.mockResolvedValue({
      items: [
        { id: 'm1', role: 'user', content: [{ type: 'text', text: 'q' }], sessionId: 's1', createdAt: 't' },
        { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'a' }], sessionId: 's1', createdAt: 't', runId: 'r1' },
      ] as Message[],
      hasMore: false,
    });
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    expect(result.current.lastRunFinish).toBeNull();
  });
});

describe('useMessages — agent_loop 流式 reducer', () => {
  it('run_start→message_start→text_block_delta→run_end 驱动 messages + lastRunFinish', async () => {
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    pushAgent({ type: 'run_start', runId: 'r1', sessionId: 's1' });
    expect(result.current.runActive).toBe(true);
    expect(result.current.loadingPhase).toBe('thinking');
    pushAgent({ type: 'message_start', messageId: 'a1', sessionId: 's1', role: 'assistant' });
    pushAgent({ type: 'text_block_delta', blockId: 'b1', messageId: 'a1', delta: 'hi' });
    expect(result.current.messages[0]!.content).toEqual([{ type: 'text', text: 'hi' }]);
    pushAgent({ type: 'run_end', runId: 'r1', sessionId: 's1', stopReason: 'no_tool_call' });
    expect(result.current.runActive).toBe(false);
    expect(result.current.lastRunFinish?.stopReason).toBe('no_tool_call');
  });

  it('[不变量①] 连续高频 text_block_delta 累积不丢字（onEvent 读 sliceRef.current 最新态）', async () => {
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    pushAgent({ type: 'run_start', runId: 'r1', sessionId: 's1' });
    pushAgent({ type: 'message_start', messageId: 'a1', sessionId: 's1', role: 'assistant' });
    // 一帧接一帧推 5 段 delta（不 settle 中间帧——模拟 SSE 高频到达）
    pushAgent({ type: 'text_block_delta', blockId: 'b1', messageId: 'a1', delta: 'H' });
    pushAgent({ type: 'text_block_delta', blockId: 'b1', messageId: 'a1', delta: 'e' });
    pushAgent({ type: 'text_block_delta', blockId: 'b1', messageId: 'a1', delta: 'l' });
    pushAgent({ type: 'text_block_delta', blockId: 'b1', messageId: 'a1', delta: 'l' });
    pushAgent({ type: 'text_block_delta', blockId: 'b1', messageId: 'a1', delta: 'o' });
    // 关键：累积为 "Hello"，不丢字（ref-latest 保证一环扣一环）
    expect(result.current.messages[0]!.content).toEqual([{ type: 'text', text: 'Hello' }]);
  });
});

describe('useMessages — session_panel messages_cleared', () => {
  it('messages_cleared → 清 messages/lastRunFinish/enqueueItems', async () => {
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    pushAgent({ type: 'run_start', runId: 'r1', sessionId: 's1' });
    pushAgent({ type: 'message_start', messageId: 'a1', sessionId: 's1', role: 'assistant' });
    pushAgent({ type: 'message_enqueued', enqueueId: 'eq1', content: 'A' });
    pushAgent({ type: 'run_end', runId: 'r1', sessionId: 's1', stopReason: 'no_tool_call' });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.enqueueItems).toHaveLength(1);
    expect(result.current.lastRunFinish).not.toBeNull();

    pushPanel({ type: 'messages_cleared', sessionId: 's1', createdAt: 't1', data: { sessionId: 's1' } });
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.enqueueItems).toHaveLength(0);
    expect(result.current.lastRunFinish).toBeNull();
  });
});

describe('useMessages — [D7] session_panel 终态清 sticky run_start 孤儿', () => {
  it('run_start 设 runActive=true+loadingPhase=thinking；session_status_update idle 强制清', async () => {
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    pushAgent({ type: 'run_start', runId: 'r1', sessionId: 's1' });
    expect(result.current.runActive).toBe(true);
    expect(result.current.loadingPhase).toBe('thinking');

    pushPanel({ type: 'session_status_update', sessionId: 's1', createdAt: 't1', data: { state: 'idle', running: false, currentRunId: null } });
    // 关键：终态强制清 sticky 孤儿（治 D7，不依赖 run_end）
    expect(result.current.runActive).toBe(false);
    expect(result.current.loadingPhase).toBeNull();
  });

  it('终态 error / interrupted 同样清 sticky 孤儿', async () => {
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    pushAgent({ type: 'run_start', runId: 'r1', sessionId: 's1' });
    expect(result.current.runActive).toBe(true);

    pushPanel({ type: 'session_status_update', sessionId: 's1', createdAt: 't1', data: { state: 'error', running: false, currentRunId: null } });
    expect(result.current.runActive).toBe(false);
    expect(result.current.loadingPhase).toBeNull();

    pushAgent({ type: 'run_start', runId: 'r2', sessionId: 's1' });
    expect(result.current.runActive).toBe(true);
    pushPanel({ type: 'session_status_update', sessionId: 's1', createdAt: 't2', data: { state: 'interrupted', running: false, currentRunId: null } });
    expect(result.current.runActive).toBe(false);
    expect(result.current.loadingPhase).toBeNull();
  });

  it('非终态(running/interrupting) session_status_update 不清 runActive（只更新 sessionRunning 归 useRunState）', async () => {
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    pushAgent({ type: 'run_start', runId: 'r1', sessionId: 's1' });
    expect(result.current.runActive).toBe(true);
    expect(result.current.loadingPhase).toBe('thinking');

    // running/interrupting 不属终态集合，不清孤儿
    pushPanel({ type: 'session_status_update', sessionId: 's1', createdAt: 't1', data: { state: 'running', running: true, currentRunId: 'r1' } });
    expect(result.current.runActive).toBe(true);
    expect(result.current.loadingPhase).toBe('thinking');
    pushPanel({ type: 'session_status_update', sessionId: 's1', createdAt: 't2', data: { state: 'interrupting', running: true, currentRunId: 'r1' } });
    expect(result.current.runActive).toBe(true);
    expect(result.current.loadingPhase).toBe('thinking');
  });

  it('终态幂等：runActive 已 false + loadingPhase 已 null 时不再触发渲染（无变化返原引用）', async () => {
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    // 初始态 runActive=false, loadingPhase=null（无 run_start）
    const before = result.current.runActive;
    pushPanel({ type: 'session_status_update', sessionId: 's1', createdAt: 't1', data: { state: 'idle', running: false, currentRunId: null } });
    expect(result.current.runActive).toBe(before);
  });
});

describe('useMessages — 命令式 setMessages', () => {
  it('setMessages(by-id merge) 不破 SSE 累积态', async () => {
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    pushAgent({ type: 'run_start', runId: 'r1', sessionId: 's1' });
    pushAgent({ type: 'message_start', messageId: 'a1', sessionId: 's1', role: 'assistant' });
    pushAgent({ type: 'text_block_delta', blockId: 'b1', messageId: 'a1', delta: 'streaming' });
    const before = result.current.messages[0];
    // loadMore prepend 旧消息（与 streaming message by-id 去重）
    act(() =>
      result.current.setMessages(
        [{ id: 'old1', role: 'user', content: [{ type: 'text', text: 'old' }], sessionId: 's1', createdAt: 't' } as Message],
        { hasMore: false, prepend: true },
      ),
    );
    // 旧消息前插 + streaming message 保留（by-id merge）
    expect(result.current.messages.map((m) => m.id)).toEqual(['old1', 'a1']);
    // streaming message 引用不变（mergeMessagesById 保留 SSE 累积的同 id 对象）
    expect(result.current.messages[1]).toBe(before);
    expect(result.current.hasMore).toBe(false);
  });
});

/**
 * [v0.0.97] GET /inbox seed enqueueItems。
 *
 * onInit 在 GET /messages 成功块之后追加 GET /inbox（subscribe-first 不变 D8）。
 * content 经 contentBlocksToPreviewText 转 string（EnqueueItem.content 为 string）。
 * reducer message_enqueued 内置 some(enqueueId) 幂等，防 GET seed 与 SSE 双计。
 */
describe('useMessages — [v0.0.97] GET /inbox seed enqueueItems', () => {
  it('onInit GET /inbox 返 ContentBlock[] → enqueueItems 经 contentBlocksToPreviewText 正确 seed', async () => {
    apiMocks.getInbox.mockResolvedValue({
      items: [
        { enqueueId: 'eq1', content: [{ type: 'text', text: '排队中A' }], enqueuedAt: 't1' },
        { enqueueId: 'eq2', content: [{ type: 'text', text: '排队中B' }], enqueuedAt: 't2' },
      ],
    });
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    // 两项 seed 进 enqueueItems，content 已拍平为 string
    expect(result.current.enqueueItems).toEqual([
      { enqueueId: 'eq1', content: '排队中A' },
      { enqueueId: 'eq2', content: '排队中B' },
    ]);
  });

  it('GET /inbox 失败 → enqueueItems 降级空（不阻塞 SSE）', async () => {
    apiMocks.getInbox.mockRejectedValue(new Error('HTTP 500'));
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    // inbox 拉取失败：enqueueItems 空（不抛，SSE 仍可推增量）
    expect(result.current.enqueueItems).toEqual([]);
  });

  it('切 session 重 seed 各自 inbox（GET /inbox 按 sessionId 拉）', async () => {
    apiMocks.getInbox
      .mockResolvedValueOnce({ items: [{ enqueueId: 'a1', content: [{ type: 'text', text: 'A 排队' }], enqueuedAt: 't' }] })
      .mockResolvedValueOnce({ items: [{ enqueueId: 'b1', content: [{ type: 'text', text: 'B 排队' }], enqueuedAt: 't' }] });
    const { result, rerender } = renderHook(({ id }) => useMessages(id), { initialProps: { id: 's1' } });
    await settle();
    expect(result.current.enqueueItems).toEqual([{ enqueueId: 'a1', content: 'A 排队' }]);
    // 切到 s2：useLifecycle deps 变 → re-init（重订阅 + 重拉 GET /messages + GET /inbox）
    rerender({ id: 's2' });
    await settle();
    expect(result.current.enqueueItems).toEqual([{ enqueueId: 'b1', content: 'B 排队' }]);
  });

  it('GET seed 与 SSE message_enqueued 同 enqueueId 幂等（不双计）', async () => {
    apiMocks.getInbox.mockResolvedValue({
      items: [{ enqueueId: 'eq1', content: [{ type: 'text', text: '已排队' }], enqueuedAt: 't1' }],
    });
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    // seed 1 项
    expect(result.current.enqueueItems).toHaveLength(1);
    // SSE 推同 enqueueId（GET 返回到 subscribe 间 fire 的兜底）→ reducer some 幂等跳过不双计
    pushAgent({ type: 'message_enqueued', enqueueId: 'eq1', content: [{ type: 'text', text: '已排队' }] });
    expect(result.current.enqueueItems).toHaveLength(1);
  });
});

describe('useMessages — 切 session cleanup', () => {
  it('unmount → unsubscribe agent_loop + session_panel（不 destroy 单例）', async () => {
    const { unmount } = renderHook(() => useMessages('s1'));
    await settle();
    expect(sse.handlers['agent_loop']).toBeTruthy();
    expect(sse.handlers['session_panel']).toBeTruthy();
    unmount();
    expect(sse.unsub).toContain('agent_loop');
    expect(sse.unsub).toContain('session_panel');
    expect(sse.destroyed).toBe(0);
  });
});

/**
 * [v0.0.95 D2] buffer 清理验证（reducer 内清理，不依赖消费方）。
 *
 * 验证：tool_call_end 后 reducer 返回删了对应 toolCallId 的新 rawArgs Map，
 *   buffer.runCtx 累积态保持清理后状态（无残留）。
 *   场景：一个 tool_call_end 之后再发同 toolCallId 的 tool_call_delta，
 *   应从空开始累积（不会复用已被清理的旧 rawArgs）——证明 D2 落地。
 */
describe('useMessages — [D2] buffer 清理（reducer 内 toolCallRawArgs 释放）', () => {
  it('tool_call_end 后同 toolCallId 再 delta → 从空累积（旧 rawArgs 已被清理）', async () => {
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    // 跑一轮完整 tool_call（start→delta→end）
    pushAgent({ type: 'run_start', runId: 'r1', sessionId: 's1' });
    pushAgent({ type: 'message_start', messageId: 'a1', sessionId: 's1', role: 'assistant' });
    pushAgent({ type: 'tool_call_start', toolCallId: 'c1', toolName: 'bash', messageId: 'a1' });
    pushAgent({ type: 'tool_call_delta', toolCallId: 'c1', messageId: 'a1', delta: '{"command":"ls"}' });
    pushAgent({ type: 'tool_call_end', toolCallId: 'c1', messageId: 'a1' });
    const callBefore = (result.current.messages.find((m) => m.id === 'a1')!.content.find(
      (b) => b.type === 'tool_call' && (b as { id?: string }).id === 'c1',
    ) as { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> });
    expect(callBefore.arguments).toEqual({ command: 'ls' });

    // D2 验证：tool_call_end 后若 buffer 未清，再用同 toolCallId 发 delta 会污染（旧 rawArgs 残留）。
    // 期望：从空开始累积——新一轮 delta 只含新片段，若再 tool_call_end 则 parse 出的 arguments 只含新字段。
    pushAgent({ type: 'tool_call_delta', toolCallId: 'c1', messageId: 'a1', delta: '{"cwd":"/tmp"}' });
    pushAgent({ type: 'tool_call_end', toolCallId: 'c1', messageId: 'a1' });
    const callAfter = (result.current.messages.find((m) => m.id === 'a1')!.content.find(
      (b) => b.type === 'tool_call' && (b as { id?: string }).id === 'c1',
    ) as { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> });
    // 关键：arguments 只有新片段解析出的字段（cwd），不含残留的 command——证明 D2 清理生效
    expect(callAfter.arguments).toEqual({ cwd: '/tmp' });
  });
});

/**
 * [v0.0.101] HITL ask-question 悬挂提问卡。
 *
 * onInit 在 GET /messages 后追加 GET /pending-tool-call（recover d 路径，类比 GET /inbox seed）；
 * 订阅 require_human_input event（agent_loop topic）→ reducer 收 pending → mount 提问卡（pendingToolCall 非空）；
 * submitReply POST /messages toolReply + 乐观清 pendingToolCall；
 * clearPendingToolCall 用于 c 路径（发普通 query 时清本地）。
 */
describe('useMessages — [v0.0.101] HITL ask-question（require_human_input + GET /pending-tool-call）', () => {
  /** 构造一个 need_feedback pending（最小载荷） */
  function makePending(toolCallId = 'tc1'): PendingToolCallView {
    return {
      sessionId: 's1',
      runId: 'r1',
      toolCallId,
      toolName: 'ask-question',
      handleType: 'direct_result',
      subState: 'need_feedback',
      data: {
        prompt: '请回答',
        questions: [
          {
            id: 'q1',
            title: '首选',
            type: 'single',
            options: [{ key: 'a', label: 'A' }],
          },
        ],
      },
      resultMessageId: 'm1',
      resultBlockIndex: 0,
      status: 'pending',
    };
  }

  it('onInit GET /pending-tool-call seed pendingToolCall（recover d 路径）', async () => {
    apiMocks.getPendingToolCall.mockResolvedValue({ pending: makePending() });
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    expect(apiMocks.getPendingToolCall).toHaveBeenCalledWith('s1');
    expect(result.current.pendingToolCall).not.toBeNull();
    expect(result.current.pendingToolCall?.toolCallId).toBe('tc1');
  });

  it('GET /pending-tool-call 返 null（无 pending）→ pendingToolCall 仍为 null', async () => {
    apiMocks.getPendingToolCall.mockResolvedValue({ pending: null });
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    expect(result.current.pendingToolCall).toBeNull();
  });

  it('GET /pending-tool-call 失败 → pendingToolCall 降级 null（不阻塞 SSE require_human_input）', async () => {
    apiMocks.getPendingToolCall.mockRejectedValue(new Error('HTTP 500'));
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    expect(result.current.pendingToolCall).toBeNull();
  });

  it('SSE require_human_input → pendingToolCall 替换为队首（INV-4 peek 队首单条）', async () => {
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    expect(result.current.pendingToolCall).toBeNull();
    pushAgent({ type: 'require_human_input', pending: makePending('tc1') });
    expect(result.current.pendingToolCall?.toolCallId).toBe('tc1');
    // 多 pending 串行：emit 下一个时 reducer 切换为队首
    pushAgent({ type: 'require_human_input', pending: makePending('tc2') });
    expect(result.current.pendingToolCall?.toolCallId).toBe('tc2');
  });

  it('submitReply → 乐观清 pendingToolCall + POST /messages body 含 toolReply（b 路径）', async () => {
    apiMocks.getPendingToolCall.mockResolvedValue({ pending: makePending() });
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    expect(result.current.pendingToolCall).not.toBeNull();
    act(() => {
      result.current.submitReply('tc1', 'direct_result', { selections: { q1: ['a'] } });
    });
    // 乐观清：pendingToolCall 立即为 null（卡片 unmount）
    expect(result.current.pendingToolCall).toBeNull();
    // POST /messages 含 toolReply body
    expect(apiMocks.postMessage).toHaveBeenCalledWith('s1', expect.objectContaining({
      toolReply: { toolCallId: 'tc1', handleType: 'direct_result', payload: { selections: { q1: ['a'] } } },
    }));
  });

  it('clearPendingToolCall → 清空 pendingToolCall（c 路径用，page-chat.handleSend 调）', async () => {
    apiMocks.getPendingToolCall.mockResolvedValue({ pending: makePending() });
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    expect(result.current.pendingToolCall).not.toBeNull();
    act(() => result.current.clearPendingToolCall());
    expect(result.current.pendingToolCall).toBeNull();
    // clearPendingToolCall 不调 POST /messages（与 submitReply 区分；POST 由 page-chat.handleSend 走 user query 路径）
    expect(apiMocks.postMessage).not.toHaveBeenCalled();
  });

  it('messages_cleared → pendingToolCall 同步清空（clear session 后无悬挂 tool）', async () => {
    apiMocks.getPendingToolCall.mockResolvedValue({ pending: makePending() });
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    expect(result.current.pendingToolCall).not.toBeNull();
    pushPanel({ type: 'messages_cleared', sessionId: 's1', createdAt: 't1', data: { sessionId: 's1' } });
    expect(result.current.pendingToolCall).toBeNull();
  });
});

/**
 * HITL 悬挂随 session running 状态清除（方案 B：看 session 状态不看消息）。
 * 修复：session_panel 分支新增 RUNNING_STATES={running,interrupting} 分支，清 pendingToolCall。
 * 反例：suspended 不动（HITL 合法等待态，由本客户端显式动作清）。
 */
describe('useMessages — [v0.0.176] HITL 悬挂随 session running 清除', () => {
  /** 构造一个 need_feedback pending（最小载荷） */
  function makePending(toolCallId = 'tc1'): PendingToolCallView {
    return {
      sessionId: 's1',
      runId: 'r1',
      toolCallId,
      toolName: 'ask-question',
      handleType: 'direct_result',
      subState: 'need_feedback',
      data: {
        prompt: '请回答',
        questions: [
          { id: 'q1', title: '首选', type: 'single', options: [{ key: 'a', label: 'A' }] },
        ],
      },
      resultMessageId: 'm1',
      resultBlockIndex: 0,
      status: 'pending',
    };
  }

  it('pendingToolCall 已设 + session_status_update(state=running) → 清空 pendingToolCall', async () => {
    apiMocks.getPendingToolCall.mockResolvedValue({ pending: makePending() });
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    expect(result.current.pendingToolCall).not.toBeNull();
    pushPanel({
      type: 'session_status_update',
      sessionId: 's1',
      createdAt: 't1',
      data: { state: 'running', running: true, currentRunId: 'r1' },
    });
    // 关键：session 进 running → pendingToolCall 清空（治悬挂）
    expect(result.current.pendingToolCall).toBeNull();
  });

  it('pendingToolCall 已设 + session_status_update(state=interrupting) → 同样清空（abort 收尾中也算 running）', async () => {
    apiMocks.getPendingToolCall.mockResolvedValue({ pending: makePending() });
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    expect(result.current.pendingToolCall).not.toBeNull();
    pushPanel({
      type: 'session_status_update',
      sessionId: 's1',
      createdAt: 't1',
      data: { state: 'interrupting', running: true, currentRunId: 'r1' },
    });
    // interrupting 属 RUNNING_STATES（running bool ⟺ state∈{running,interrupting}）
    expect(result.current.pendingToolCall).toBeNull();
  });

  it('反向：pendingToolCall 已设 + session_status_update(state=suspended) → 不清（保 INV-2 HITL 合法等待态）', async () => {
    apiMocks.getPendingToolCall.mockResolvedValue({ pending: makePending() });
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    const before = result.current.pendingToolCall;
    expect(before).not.toBeNull();
    pushPanel({
      type: 'session_status_update',
      sessionId: 's1',
      createdAt: 't1',
      data: { state: 'suspended', running: false, currentRunId: null },
    });
    // suspended 是 HITL 合法等待态——pendingToolCall 必须保留（卡片继续可见供用户作答）
    expect(result.current.pendingToolCall).toBe(before);
  });

  it('幂等：pendingToolCall 为 null + session_status_update(state=running) → 不触发渲染（引用不变）', async () => {
    const { result } = renderHook(() => useMessages('s1'));
    await settle();
    expect(result.current.pendingToolCall).toBeNull();
    const beforePending = result.current.pendingToolCall;
    pushPanel({
      type: 'session_status_update',
      sessionId: 's1',
      createdAt: 't1',
      data: { state: 'running', running: true, currentRunId: 'r1' },
    });
    // 无 pending 时返原 ctx（避免无谓 re-render，同终态分支写法）
    expect(result.current.pendingToolCall).toBe(beforePending);
  });
});
