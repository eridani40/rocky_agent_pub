/**
 * handleToolReply 三分发 UT（白盒，模块 E + 模块 D）
 * 参考: specs/tech/version_logs/v0.0.101/change_plan.md 模块 E（pre-process 回填处理）
 *       specs/tech/version_logs/v0.0.122/change_plan.md 模块 D（approval 回填实例化）
 *       specs/tech/version_logs/v0.0.124/change_plan.md（HITL SSE 补发修复）
 *       specs/tech/agent/tools/[P0]tool_permission.md §6（回填三分发表）
 *       reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md §6 §7
 *
 * 覆盖：
 *   - direct_result：payload 序列化为 text + status pending→success + 编辑 block content
 *   - approval allow：补跑 tool.run + 编辑 block status success
 *   - approval allow_always：补跑 + recordAlways(sessionId, approvalKey) + 不调 checkPermission
 *   - approval deny：isError block「用户拒绝执行：{reason}」status fail
 *   - callback：调 tool.onReply(payload, ctx) → 用 ToolRunResult 编辑 block
 *   - resolvePendingToolCall 被调一次（按 toolCallId 删一项）
 *   - stillHasPending 取决于 peek 后队列状态
 *   - [v0.0.124] emitCtx 存在时持久化后补发 tool_result SSE（bus.emit 3 次：start/delta/end）
 *   - [v0.0.124] 无 emitCtx 时 bus 不被调用（向后兼容）
 *
 * 注：API 层（POST /messages tool_reply / GET /pending-tool-call / /run await suspended）
 *     由 AT 验证；本 UT 只测核心 helper 逻辑（mock store + tools）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleToolReply } from '../tool-reply-handler';
import type { RunSpec } from '../loop-ports';
import type { Message, ToolResultBlock, ToolReplyBlock } from '../../message/types';
import type { PendingToolCall, Tool, ToolRunResult } from '../../tools/types';
import type { SessionConfig } from '../context-types';
import type { EmitContext } from '../agent-loop-emitters';

// vi.hoisted 声明在 hoisting 阶段执行，确保 vi.mock factory 内可引用
const { mockRecordAlways, mockIsApproved } = vi.hoisted(() => ({
  mockRecordAlways: vi.fn(),
  mockIsApproved: vi.fn(() => false),
}));

// vi.mock 路径用 __dirname 派生绝对路径（避免 bun+jsdom 全量并发下相对路径静默失效，
// 见 memory test-vitest-mock-absolute-path；
// require('path') 在 factory 内部 inline 调用，__dirname 是 node 全局，hoisting 时可用）
vi.mock(require('path').resolve(__dirname, '../../tools/approval-manager'), () => ({
  approvalManager: {
    recordAlways: mockRecordAlways,
    isApproved: mockIsApproved,
  },
}));

/** 构造 mock store：peek/set/resolve/getMessages/appendMessages 全 spy */
function mkMockStore(opts: {
  initialHead: PendingToolCall | null;
  afterResolveHead: PendingToolCall | null;
  toolMsgContent?: ToolResultBlock[];
}) {
  let currentHead = opts.initialHead;
  return {
    peekPendingToolCall: vi.fn(async () => {
      // resolve 后切到 afterResolveHead（模拟删一项后下个变队首）
      return currentHead ? { ...currentHead } : null;
    }),
    setPendingToolCalls: vi.fn(async (_sid: string, _items: unknown[]) => {}),
    resolvePendingToolCall: vi.fn(async () => {
      currentHead = opts.afterResolveHead;
      return true;
    }),
    getMessages: vi.fn(async () => ({
      items: [
        {
          id: opts.initialHead?.resultMessageId ?? 'm-tool',
          sessionId: 'sid-1',
          role: 'tool' as const,
          content: opts.toolMsgContent ?? [{ type: 'tool_result', toolCallId: 'tc-1', content: [{ type: 'text', text: '占位' }], isError: false, status: 'pending' }],
        },
      ],
      hasMore: false,
    })),
    appendMessages: vi.fn(async (_sid: string, _msgs: unknown[]) => {}),
  };
}

/** 取 mock store.appendMessages 的最近一次调用写入的 message（同 id upsert） */
function getLastAppended(store: ReturnType<typeof mkMockStore>): { content: ToolResultBlock[] } {
  const calls = (store.appendMessages as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  const last = calls[calls.length - 1] as unknown as [string, { content: ToolResultBlock[] }[]];
  return last[1][0]!;
}

/** 构造 RunSpec（含 mock store + tools） */
function mkSpec(store: ReturnType<typeof mkMockStore>, tools: Tool[] = []): RunSpec {
  return {
    config: { sessionId: 'sid-1', tools: tools as never } as unknown as SessionConfig,
    wireStore: store as never,
  } as unknown as RunSpec;
}

/** 构造 tool_reply message */
function mkToolReplyMessage(toolCallId: string, handleType: 'direct_result' | 'approval' | 'callback', payload: unknown): Message {
  const block: ToolReplyBlock = { type: 'tool_reply', toolCallId, handleType, payload };
  return {
    id: 'm-reply',
    sessionId: 'sid-1',
    role: 'user',
    content: [block],
    sender: { source: 'tool_reply', tool_reply: { toolCallId, runId: 'r-1' } },
  };
}

/** 构造 PendingToolCall（direct_result 默认；approval 分支可传 handleType + data 覆盖） */
function mkPending(overrides: Partial<PendingToolCall> = {}): PendingToolCall {
  return {
    sessionId: 'sid-1',
    runId: 'r-1',
    toolCallId: 'tc-1',
    toolName: 'ask-question',
    handleType: 'direct_result',
    subState: 'need_feedback',
    data: { questions: [] },
    resultMessageId: 'm-tool',
    resultBlockIndex: 0,
    status: 'pending',
    ...overrides,
  };
}

/** 构造 approval PendingToolCall（含 ApprovalData）*/
function mkApprovalPending(overrides: Partial<PendingToolCall> = {}): PendingToolCall {
  return mkPending({
    toolName: 'bash',
    handleType: 'approval',
    subState: 'need_approval',
    data: {
      toolName: 'bash',
      arguments: { command: 'rm -rf *', restart: false },
      reason: 'rm 通配删除，需用户批准',
      approvalKey: 'bash:rm-wildcard',
    },
    ...overrides,
  });
}

describe('handleToolReply 三分发', () => {
  beforeEach(() => {
    // 每个测试前重置 approvalManager mock
    mockRecordAlways.mockClear();
    mockIsApproved.mockClear();
  });

  it('direct_result：payload 序列化为 text + status pending→success + 编辑 block content', async () => {
    const pending = mkPending({ handleType: 'direct_result' });
    const store = mkMockStore({ initialHead: pending, afterResolveHead: null });
    const spec = mkSpec(store);

    const replyMsg = mkToolReplyMessage('tc-1', 'direct_result', {
      selections: { q1: ['A'], q2: ['B', '其他：foo'] },
    });

    const r = await handleToolReply(spec, replyMsg);

    expect(r.resolved).toBe(true);
    expect(r.stillHasPending).toBe(false);
    // appendMessages 被调一次（同 id upsert 写回 tool message）
    expect(store.appendMessages).toHaveBeenCalledOnce();
    const written = getLastAppended(store);
    const block = written.content[0] as ToolResultBlock;
    expect(block.status).toBe('success');
    expect(block.isError).toBe(false);
    // payload 被序列化为 text（JSON.stringify）
    const text = (block.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('q1');
    expect(text).toContain('A');
    expect(text).toContain('其他：foo');
    // resolve 被调一次
    expect(store.resolvePendingToolCall).toHaveBeenCalledWith('sid-1', 'tc-1');
  });

  it('direct_result：仍有 pending（队列非空）→ stillHasPending=true', async () => {
    const pending = mkPending({ handleType: 'direct_result' });
    const next = mkPending({ toolCallId: 'tc-2', resultMessageId: 'm-tool2' });
    const store = mkMockStore({ initialHead: pending, afterResolveHead: next });
    const spec = mkSpec(store);

    const replyMsg = mkToolReplyMessage('tc-1', 'direct_result', { selections: { q1: ['A'] } });
    const r = await handleToolReply(spec, replyMsg);

    expect(r.resolved).toBe(true);
    expect(r.stillHasPending).toBe(true);
  });

  // ── approval 分支（v0.0.122 实例化）──────────────────────────────────

  it('approval allow：补跑 tool.run + 编辑 block status=success（真实 result）', async () => {
    const bashRun = vi.fn(async (): Promise<ToolRunResult> => ({
      content: [{ type: 'text', text: '文件已删除' }],
      isError: false,
    }));
    const checkPermission = vi.fn();
    const bashTool: Tool = {
      definition: { name: 'bash', description: '', inputSchema: { type: 'object' } },
      checkPermission,
      run: bashRun,
    };
    const pending = mkApprovalPending();
    const store = mkMockStore({ initialHead: pending, afterResolveHead: null });
    const spec = mkSpec(store, [bashTool]);

    const replyMsg = mkToolReplyMessage('tc-1', 'approval', { decision: 'allow' });
    const r = await handleToolReply(spec, replyMsg);

    expect(r.resolved).toBe(true);
    expect(r.stillHasPending).toBe(false);

    // 补跑 tool.run 被调一次
    expect(bashRun).toHaveBeenCalledOnce();
    // tool.run 接收的 input 来自 ApprovalData.arguments
    expect((bashRun.mock.calls[0] as unknown[])[0]).toEqual({ command: 'rm -rf *', restart: false });

    // block 编辑为真实 result
    const written = getLastAppended(store);
    const block = written.content[0] as ToolResultBlock;
    expect(block.status).toBe('success');
    expect(block.isError).toBe(false);
    expect((block.content[0] as { text: string }).text).toBe('文件已删除');

    // 不调 checkPermission（INV-P7）
    expect(checkPermission).not.toHaveBeenCalled();

    // recordAlways 不调（allow 不是 allow_always）
    expect(mockRecordAlways).not.toHaveBeenCalled();

    // resolve 被调一次
    expect(store.resolvePendingToolCall).toHaveBeenCalledWith('sid-1', 'tc-1');
  });

  it('approval allow：tool.run 返 isError=true → block status=fail', async () => {
    const bashRun = vi.fn(async (): Promise<ToolRunResult> => ({
      content: [{ type: 'text', text: 'bash: command not found' }],
      isError: true,
    }));
    const bashTool: Tool = {
      definition: { name: 'bash', description: '', inputSchema: { type: 'object' } },
      run: bashRun,
    };
    const pending = mkApprovalPending();
    const store = mkMockStore({ initialHead: pending, afterResolveHead: null });
    const spec = mkSpec(store, [bashTool]);

    const replyMsg = mkToolReplyMessage('tc-1', 'approval', { decision: 'allow' });
    await handleToolReply(spec, replyMsg);

    const written = getLastAppended(store);
    const block = written.content[0] as ToolResultBlock;
    expect(block.status).toBe('fail');
    expect(block.isError).toBe(true);
  });

  it('approval deny：产 isError block 含「用户拒绝执行：{reason}」status=fail', async () => {
    const bashRun = vi.fn();
    const bashTool: Tool = {
      definition: { name: 'bash', description: '', inputSchema: { type: 'object' } },
      run: bashRun,
    };
    const pending = mkApprovalPending();
    const store = mkMockStore({ initialHead: pending, afterResolveHead: null });
    const spec = mkSpec(store, [bashTool]);

    const replyMsg = mkToolReplyMessage('tc-1', 'approval', { decision: 'deny' });
    const r = await handleToolReply(spec, replyMsg);

    expect(r.resolved).toBe(true);

    const written = getLastAppended(store);
    const block = written.content[0] as ToolResultBlock;
    expect(block.status).toBe('fail');
    expect(block.isError).toBe(true);

    // 文案含 reason
    const text = (block.content[0] as { text: string }).text;
    expect(text).toContain('用户拒绝执行');
    expect(text).toContain('rm 通配删除，需用户批准');

    // deny 不补跑 tool.run
    expect(bashRun).not.toHaveBeenCalled();

    // resolve 仍被调（删队列项）
    expect(store.resolvePendingToolCall).toHaveBeenCalledOnce();
  });

  it('approval allow_always：触发 recordAlways(sessionId, approvalKey) + 补跑 tool.run', async () => {
    const bashRun = vi.fn(async (): Promise<ToolRunResult> => ({
      content: [{ type: 'text', text: '执行完成' }],
      isError: false,
    }));
    const checkPermission = vi.fn();
    const bashTool: Tool = {
      definition: { name: 'bash', description: '', inputSchema: { type: 'object' } },
      checkPermission,
      run: bashRun,
    };
    const pending = mkApprovalPending({ sessionId: 'sid-A' });
    const store = mkMockStore({ initialHead: pending, afterResolveHead: null });
    const spec = mkSpec(store, [bashTool]);

    const replyMsg = mkToolReplyMessage('tc-1', 'approval', { decision: 'allow_always' });
    await handleToolReply(spec, replyMsg);

    // recordAlways 被调用，参数为 sessionId + approvalKey
    expect(mockRecordAlways).toHaveBeenCalledOnce();
    expect(mockRecordAlways).toHaveBeenCalledWith('sid-A', 'bash:rm-wildcard');

    // 同样补跑 tool.run
    expect(bashRun).toHaveBeenCalledOnce();

    // block status=success
    const written = getLastAppended(store);
    const block = written.content[0] as ToolResultBlock;
    expect(block.status).toBe('success');

    // 不调 checkPermission（INV-P7）
    expect(checkPermission).not.toHaveBeenCalled();
  });

  it('callback：调 tool.onReply(payload, ctx) → 用 ToolRunResult 编辑 block', async () => {
    const onReply = vi.fn(async (_payload: unknown): Promise<ToolRunResult> => ({
      content: [{ type: 'text', text: 'callback result: processed' }],
      isError: false,
    }));
    const callbackTool: Tool = {
      definition: { name: 'callback-tool', description: '', inputSchema: { type: 'object' } },
      interaction: () => ({
        subType: 'need_feedback',
        handleType: 'callback',
        data: { questions: [] },
      }),
      onReply,
      run: vi.fn(),
    };
    const pending = mkPending({
      handleType: 'callback',
      toolName: 'callback-tool',
    });
    const store = mkMockStore({ initialHead: pending, afterResolveHead: null });
    const spec = mkSpec(store, [callbackTool]);

    const replyMsg = mkToolReplyMessage('tc-1', 'callback', { foo: 'bar' });
    const r = await handleToolReply(spec, replyMsg);

    expect(r.resolved).toBe(true);
    expect(r.stillHasPending).toBe(false);
    expect(onReply).toHaveBeenCalledOnce();
    // payload 透传给 onReply
    expect(onReply.mock.calls[0]![0]).toEqual({ foo: 'bar' });
    // block 用 onReply 返回的 content + status=success
    const written = getLastAppended(store);
    const block = written.content[0] as ToolResultBlock;
    expect(block.status).toBe('success');
    expect((block.content[0] as { text: string }).text).toBe('callback result: processed');
  });

  it('callback：tool.onReply 返 isError=true → block status=fail', async () => {
    const onReply = vi.fn(async (): Promise<ToolRunResult> => ({
      content: [{ type: 'text', text: 'callback error' }],
      isError: true,
    }));
    const callbackTool: Tool = {
      definition: { name: 'cb-err', description: '', inputSchema: { type: 'object' } },
      interaction: () => ({ subType: 'need_feedback', handleType: 'callback', data: { questions: [] } }),
      onReply,
      run: vi.fn(),
    };
    const pending = mkPending({ handleType: 'callback', toolName: 'cb-err' });
    const store = mkMockStore({ initialHead: pending, afterResolveHead: null });
    const spec = mkSpec(store, [callbackTool]);

    const replyMsg = mkToolReplyMessage('tc-1', 'callback', {});
    const r = await handleToolReply(spec, replyMsg);

    expect(r.resolved).toBe(true);
    const written = getLastAppended(store);
    const block = written.content[0] as ToolResultBlock;
    expect(block.status).toBe('fail');
    expect(block.isError).toBe(true);
  });

  it('callback：tool 未注册 → 抛错（onReply 无从调）', async () => {
    const pending = mkPending({ handleType: 'callback', toolName: 'missing-tool' });
    const store = mkMockStore({ initialHead: pending, afterResolveHead: null });
    const spec = mkSpec(store, []); // 空 tools

    const replyMsg = mkToolReplyMessage('tc-1', 'callback', {});
    await expect(handleToolReply(spec, replyMsg)).rejects.toThrow(/missing-tool/);
  });

  it('队首 toolCallId 不匹配 → resolved=false（不编辑不删队列）', async () => {
    const pending = mkPending({ toolCallId: 'tc-OTHER' });
    const store = mkMockStore({ initialHead: pending, afterResolveHead: null });
    const spec = mkSpec(store);

    const replyMsg = mkToolReplyMessage('tc-1', 'direct_result', { selections: {} });
    const r = await handleToolReply(spec, replyMsg);

    expect(r.resolved).toBe(false);
    expect(r.stillHasPending).toBe(true); // 队列非空（tc-OTHER 仍 pending）
    expect(store.appendMessages).not.toHaveBeenCalled();
    expect(store.resolvePendingToolCall).not.toHaveBeenCalled();
  });

  it('队列为空 → resolved=false + stillHasPending=false（无 pending 可回填）', async () => {
    const store = mkMockStore({ initialHead: null, afterResolveHead: null });
    const spec = mkSpec(store);

    const replyMsg = mkToolReplyMessage('tc-1', 'direct_result', { selections: {} });
    const r = await handleToolReply(spec, replyMsg);

    expect(r.resolved).toBe(false);
    expect(r.stillHasPending).toBe(false);
  });

  it('message.sender.source !== "tool_reply" → resolved=false（非回填消息不处理）', async () => {
    const pending = mkPending();
    const store = mkMockStore({ initialHead: pending, afterResolveHead: null });
    const spec = mkSpec(store);

    const userMsg: Message = {
      id: 'm-u', sessionId: 'sid-1', role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      sender: { source: 'user' },
    };
    const r = await handleToolReply(spec, userMsg);
    expect(r.resolved).toBe(false);
    expect(store.appendMessages).not.toHaveBeenCalled();
  });

  it('pending 缺 resultMessageId → 抛错（caller 应先回填定位字段）', async () => {
    const pending = mkPending({ resultMessageId: undefined });
    const store = mkMockStore({ initialHead: pending, afterResolveHead: null });
    const spec = mkSpec(store);

    const replyMsg = mkToolReplyMessage('tc-1', 'direct_result', {});
    await expect(handleToolReply(spec, replyMsg)).rejects.toThrow(/resultMessageId/);
  });
});

/** 构造 mock EmitContext（spy bus.emit，验证 tool_result SSE 三帧） */
function mkMockEmitCtx() {
  const busEmit = vi.fn();
  const ctx: EmitContext = {
    sessionId: 'sid-1',
    runId: 'r-1',
    runKind: 'main',
    bus: { emit: busEmit, on: vi.fn(), off: vi.fn(), clearReplay: vi.fn(), getReplay: vi.fn(() => []) } as never,
    now: () => new Date().toISOString(),
  };
  return { ctx, busEmit };
}

describe('[v0.0.124] handleToolReply + emitCtx 补发 SSE', () => {
  it('emitCtx 存在：持久化后 bus.emit 3 次（start/delta/end），toolCallId 正确', async () => {
    const pending = mkPending({ handleType: 'direct_result' });
    const store = mkMockStore({ initialHead: pending, afterResolveHead: null });
    const { ctx, busEmit } = mkMockEmitCtx();
    const replyMsg = mkToolReplyMessage('tc-1', 'direct_result', { answer: 'yes' });

    await handleToolReply(mkSpec(store), replyMsg, ctx);

    // publish 调用 bus.emit(key, { data: event, timestamp })；event 在 call[1].data
    expect(busEmit).toHaveBeenCalledTimes(3);
    const types = busEmit.mock.calls.map((c) => (c[1] as { data: { type: string } }).data.type);
    expect(types).toEqual(['tool_result_start', 'tool_result_delta', 'tool_result_end']);
    const startData = (busEmit.mock.calls[0]![1] as { data: { toolCallId: string } }).data;
    expect(startData.toolCallId).toBe('tc-1');
  });

  it('approval deny + emitCtx：bus.emit 调用，end 事件 isError=true', async () => {
    const pending = mkApprovalPending();
    const store = mkMockStore({ initialHead: pending, afterResolveHead: null });
    const bashTool: Tool = { definition: { name: 'bash', description: '', inputSchema: { type: 'object' } }, run: vi.fn() };
    const { ctx, busEmit } = mkMockEmitCtx();

    await handleToolReply(mkSpec(store, [bashTool]), mkToolReplyMessage('tc-1', 'approval', { decision: 'deny' }), ctx);

    expect(busEmit).toHaveBeenCalledTimes(3);
    const endData = (busEmit.mock.calls[2]![1] as { data: { isError: boolean } }).data;
    expect(endData.isError).toBe(true);
  });

  it('无 emitCtx：主流程正常，bus 不被调用', async () => {
    const pending = mkPending({ handleType: 'direct_result' });
    const store = mkMockStore({ initialHead: pending, afterResolveHead: null });
    const r = await handleToolReply(mkSpec(store), mkToolReplyMessage('tc-1', 'direct_result', {}));
    expect(r.resolved).toBe(true);
    expect(store.appendMessages).toHaveBeenCalledOnce();
    // 无 bus 可验，主要断言 resolved 正常不受影响
  });
});
