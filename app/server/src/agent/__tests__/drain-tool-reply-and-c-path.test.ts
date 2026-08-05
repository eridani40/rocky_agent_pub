/**
 * [v0.0.101 T4] drainAndPartition tool_reply 路由 + c 路径 + 回填后续 UT（白盒，模块 E）
 * 参考: specs/tech/version_logs/v0.0.101/change_plan.md 模块 E（drainAndPartition + run-react-loop ① 段）
 *       reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md §7 §8（四情况 a/b/c/d）
 *
 * 覆盖：
 *   - drainAndPartition：source='tool_reply' → toolReplyMessages（不进 userMessages/systemMessages）
 *   - c 路径：user query + 有 pendingToolCalls → hitlClearedPending=true + 占位不编辑
 *   - 回填后续：tool_reply 处理后仍有 pending → hitlAfterReplyPending=true（caller emit+break）
 *   - 回填后续：tool_reply 处理后无 pending → hitlAfterReplyPending=false（续 LLM）
 *
 * 注：prepareStage 集成测由 AT 验证；本 UT 只测 drainAndPartition 纯函数 + prepareStage 的
 *     HITL 信号产出（mock store + contextEngine）。
 */
import { describe, it, expect, vi } from 'vitest';
import { drainAndPartition } from '../agent-loop-stage-pre';
import { prepareStage } from '../loop-stage-context';
import { InboxStore } from '../inbox';
import type { Message, MessageSender, ToolReplyBlock } from '../../message/types';
import type { PendingToolCall } from '../../tools/types';
import type { RunSpec, LoopState } from '../loop-ports';
import type { SessionConfig, ContextSnapshot } from '../context-types';

/** 构造 tool_reply message */
function mkToolReplyMessage(toolCallId: string): Message {
  const block: ToolReplyBlock = {
    type: 'tool_reply',
    toolCallId,
    handleType: 'direct_result',
    payload: { selections: { q1: ['A'] } },
  };
  const sender: MessageSender = {
    source: 'tool_reply',
    tool_reply: { toolCallId, runId: 'r-1' },
  };
  return {
    id: '01REPLYMSG001',
    sessionId: '01TESTSID0001',
    role: 'user',
    content: [block],
    sender,
  };
}

describe('[v0.0.101 T4] drainAndPartition tool_reply 路由', () => {
  it('source=tool_reply → 进 toolReplyMessages（不进 userMessages/systemMessages/newMessages）', () => {
    const inbox = new InboxStore();
    const sid = '01TESTSID0001';
    inbox.enqueue(sid, [mkToolReplyMessage('tc-1')]);

    const result = drainAndPartition(inbox, sid);

    expect(result.toolReplyMessages).toHaveLength(1);
    expect(result.toolReplyMessages[0]!.sender).toMatchObject({
      source: 'tool_reply',
      tool_reply: { toolCallId: 'tc-1', runId: 'r-1' },
    });
    // 不进 userMessages（不 emit message_start/blocks/end）
    expect(result.userMessages).toHaveLength(0);
    // 不进 newMessages（不 ingest 进 transcript）
    expect(result.newMessages).toHaveLength(0);
    // 不进 systemMessages
    expect(result.systemMessages).toHaveLength(0);
    // 仍 emit processed（前端 enqueue-view 幂等移除 enqueued 项）
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]!.enqueueId).toBeTruthy();
  });

  it('tool_reply + user query 混合 drain：tool_reply 进 toolReplyMessages / user 进 userMessages', () => {
    const inbox = new InboxStore();
    const sid = '01TESTSID0001';
    const userMsg: Message = {
      id: '01USERMSG0001',
      sessionId: sid,
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      sender: { source: 'user' },
    };
    inbox.enqueue(sid, [mkToolReplyMessage('tc-1'), userMsg]);

    const result = drainAndPartition(inbox, sid);

    expect(result.toolReplyMessages).toHaveLength(1);
    expect(result.userMessages).toHaveLength(1);
    // [v0.0.161] user 分支 drain 时 reissue msgId（与 agent/system 对称）——
    //   原 throwaway id '01USERMSG0001' 被丢弃，替换为 26 位新 ulid
    expect(result.userMessages[0]!.message.id).not.toBe('01USERMSG0001');
    expect(result.userMessages[0]!.message.id.length).toBe(26);
    // newMessages 含 user（不含 tool_reply）
    expect(result.newMessages).toHaveLength(1);
    // newMessages 里的 id 与 userMessages 一致（三处一致 invariant）
    expect(result.newMessages[0]!.id).toBe(result.userMessages[0]!.message.id);
  });

  it('空 drain：toolReplyMessages 为空数组', () => {
    const inbox = new InboxStore();
    const result = drainAndPartition(inbox, 'sid-empty');
    expect(result.toolReplyMessages).toEqual([]);
  });
});

/** 构造 mock RunSpec（main eager 模式 + mock store + mock contextEngine） */
function mkRunSpec(opts: {
  initialHead: PendingToolCall | null;
  afterResolveHead?: PendingToolCall | null;
  afterSetHead?: PendingToolCall | null;
  assembleSnapshot?: ContextSnapshot | null;
}): { spec: RunSpec; storeMocks: Record<string, ReturnType<typeof vi.fn>> } {
  let currentHead = opts.initialHead;
  const storeMocks = {
    peekPendingToolCall: vi.fn(async () => currentHead ? { ...currentHead } : null),
    setPendingToolCalls: vi.fn(async (_sid: string, items: PendingToolCall[]) => {
      currentHead = items[0] ?? null;
    }),
    resolvePendingToolCall: vi.fn(async () => {
      currentHead = opts.afterResolveHead ?? null;
      return true;
    }),
    getMessages: vi.fn(async () => ({
      items: [{
        id: 'm-tool',
        sessionId: 'sid-1',
        role: 'tool' as const,
        content: [{ type: 'tool_result', toolCallId: 'tc-1', content: [{ type: 'text', text: '占位' }], isError: false, status: 'pending' }],
      }],
      hasMore: false,
    })),
    appendMessages: vi.fn(async () => {}),
  };
  const ceMock = {
    ingest: vi.fn(async () => {}),
    assemble: vi.fn(async () => opts.assembleSnapshot ?? null),
  };
  const spec = {
    config: { sessionId: 'sid-1' },
    scopeId: 'default',
    drainMode: 'eager',
    wireInbox: new InboxStore(),
    wireStore: storeMocks,
    wireContextEngine: ceMock,
    wireEmitCtx: {
      sessionId: 'sid-1',
      runId: 'r-1',
      runKind: 'main',
      bus: { clearReplay: vi.fn(), emit: vi.fn(), subscribe: vi.fn() },
      now: () => new Date().toISOString(),
    },
    observability: { setSystem: vi.fn() },
    runKind: 'main',
  } as unknown as RunSpec;
  return { spec, storeMocks };
}

function mkState(): LoopState {
  return {
    ingestUpTo: null,
    llmUpTo: null,
    snapshot: null,
    step: 0,
    done: false,
  } as LoopState;
}

function mkSnapshot(): ContextSnapshot {
  return {
    system: { id: 'sys', sessionId: 'sid-1', role: 'system', content: [{ type: 'text', text: 'sys' }] },
    messages: [],
    inputCharCount: 0,
    contextWindowUsage: {
      systemTokens: 0, messageTokens: 0, toolTokens: 0,
      totalTokens: 0, maxOutputTokens: 20000, tokenLimit: 100000, remainingTokens: 80000,
    },
    summary: null,
  } as unknown as ContextSnapshot;
}

describe('[v0.0.101 T4] prepareStage HITL 信号', () => {
  it('c 路径：user query + 有 pending → setPendingToolCalls([]) + hitlClearedPending=true', async () => {
    const pending: PendingToolCall = {
      sessionId: 'sid-1', runId: 'r-1', toolCallId: 'tc-1', toolName: 'ask-question',
      handleType: 'direct_result', subState: 'need_feedback', data: { questions: [] },
      resultMessageId: 'm-tool', resultBlockIndex: 0, status: 'pending',
    };
    const { spec, storeMocks } = mkRunSpec({
      initialHead: pending,
      assembleSnapshot: mkSnapshot(),
    });
    // inbox 放 user query（c 路径触发条件）
    spec.wireInbox!.enqueue('sid-1', [{
      id: 'm-user', sessionId: 'sid-1', role: 'user',
      content: [{ type: 'text', text: '换个话题' }],
      sender: { source: 'user' },
    }]);
    const state = mkState();

    const r = await prepareStage(spec, state);

    expect(r).toBe('ok');
    expect(state.hitlClearedPending).toBe(true);
    expect(state.hitlAfterReplyPending).toBeUndefined();
    // setPendingToolCalls 被调（清空）
    expect(storeMocks.setPendingToolCalls).toHaveBeenCalledWith('sid-1', []);
  });

  it('c 路径：无 pendingToolCalls → 不清空（hitlClearedPending 不置）', async () => {
    const { spec, storeMocks } = mkRunSpec({
      initialHead: null,
      assembleSnapshot: mkSnapshot(),
    });
    spec.wireInbox!.enqueue('sid-1', [{
      id: 'm-user', sessionId: 'sid-1', role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      sender: { source: 'user' },
    }]);
    const state = mkState();

    await prepareStage(spec, state);

    expect(state.hitlClearedPending).toBeUndefined();
    expect(storeMocks.setPendingToolCalls).not.toHaveBeenCalled();
  });

  it('回填后续：tool_reply 处理后仍有 pending → hitlAfterReplyPending=true', async () => {
    const head1: PendingToolCall = {
      sessionId: 'sid-1', runId: 'r-1', toolCallId: 'tc-1', toolName: 'ask-question',
      handleType: 'direct_result', subState: 'need_feedback', data: { questions: [] },
      resultMessageId: 'm-tool', resultBlockIndex: 0, status: 'pending',
    };
    const head2: PendingToolCall = {
      sessionId: 'sid-1', runId: 'r-1', toolCallId: 'tc-2', toolName: 'ask-question',
      handleType: 'direct_result', subState: 'need_feedback', data: { questions: [] },
      resultMessageId: 'm-tool2', resultBlockIndex: 0, status: 'pending',
    };
    const { spec, storeMocks } = mkRunSpec({
      initialHead: head1,
      afterResolveHead: head2,
      assembleSnapshot: mkSnapshot(),
    });
    spec.wireInbox!.enqueue('sid-1', [mkToolReplyMessage('tc-1')]);
    const state = mkState();

    await prepareStage(spec, state);

    expect(state.hitlAfterReplyPending).toBe(true);
    expect(storeMocks.resolvePendingToolCall).toHaveBeenCalledWith('sid-1', 'tc-1');
  });

  // [v0.0.101 fix] 回归：multi-pending re-suspend。resolve 队首（剩 b 仍 pending）→ prepareStage 必返 'ok'
  //   （非 'no_new'），让 run-react-loop ① 段的 hitlAfterReplyPending 分支 break tool_pending→suspended。
  //   旧 bug：refreshSnapshotOnly 条件漏此分支（仍 pending 不刷 snapshot）→ state.snapshot=null →
  //   !state.snapshot 门禁误返 'no_new' → run-react-loop break no_new_messages → onRunEnd markIdle
  //   （应 suspended），b 被遗弃（pendingToolCalls len=1，无第 2 次 LLM）。
  //   关键：re-suspend 路径不需 snapshot（不调 LLM），门禁须在 !state.snapshot 之前按 hitlAfterReplyPending 放行。
  it('re-suspend 回归：resolve 队首 of 2 pending → 返 ok（非 no_new），snapshot 可为 null 也不阻断', async () => {
    const head1: PendingToolCall = {
      sessionId: 'sid-1', runId: 'r-1', toolCallId: 'tc-1', toolName: 'ask-question',
      handleType: 'direct_result', subState: 'need_feedback', data: { questions: [] },
      resultMessageId: 'm-tool', resultBlockIndex: 0, status: 'pending',
    };
    const head2: PendingToolCall = {
      sessionId: 'sid-1', runId: 'r-1', toolCallId: 'tc-2', toolName: 'ask-question',
      handleType: 'direct_result', subState: 'need_feedback', data: { questions: [] },
      resultMessageId: 'm-tool2', resultBlockIndex: 0, status: 'pending',
    };
    // assembleSnapshot=null 模拟 re-suspend 真实场景：refreshSnapshotOnly 不触发（仍 pending）→
    //   snapshot 保持 null；即便如此门禁也须放行（修复后 hitlAfterReplyPending 优先于 !snapshot）
    const { spec, storeMocks } = mkRunSpec({
      initialHead: head1,
      afterResolveHead: head2,
      assembleSnapshot: null,
    });
    spec.wireInbox!.enqueue('sid-1', [mkToolReplyMessage('tc-1')]);
    // 模拟真实二 run 启动：initState 两 cursor 都设为 newest msg id（tool 占位 msg）
    // → cursor 相同；旧 bug 两道门禁（cursor 同 + !snapshot）双杀返 'no_new'
    const state = mkState();
    state.ingestUpTo = 'm-tool';
    state.llmUpTo = 'm-tool';

    const r = await prepareStage(spec, state);

    // 修复后必 'ok'（旧 bug 返 'no_new' → loop break no_new_messages → markIdle，b 遗弃）
    expect(r).toBe('ok');
    expect(state.hitlAfterReplyPending).toBe(true);
    // snapshot 未建（re-suspend 不需 snapshot，refreshSnapshotOnly 漏此分支）
    expect(state.snapshot).toBeNull();
    // resolve 队首被调
    expect(storeMocks.resolvePendingToolCall).toHaveBeenCalledWith('sid-1', 'tc-1');
  });

  it('回填后续：tool_reply 处理后无 pending → hitlAfterReplyPending=false（续 LLM）', async () => {
    const head1: PendingToolCall = {
      sessionId: 'sid-1', runId: 'r-1', toolCallId: 'tc-1', toolName: 'ask-question',
      handleType: 'direct_result', subState: 'need_feedback', data: { questions: [] },
      resultMessageId: 'm-tool', resultBlockIndex: 0, status: 'pending',
    };
    const { spec, storeMocks } = mkRunSpec({
      initialHead: head1,
      afterResolveHead: null,
      assembleSnapshot: mkSnapshot(),
    });
    spec.wireInbox!.enqueue('sid-1', [mkToolReplyMessage('tc-1')]);
    const state = mkState();

    await prepareStage(spec, state);

    expect(state.hitlAfterReplyPending).toBe(false);
  });

  // [v0.0.101 fix] 回归：b 路径（仅 tool_reply drain，无 user query）→ 必返 'ok' + refresh snapshot。
  //   旧 bug：cursor 未推进（无新 msg id）→ gate `ingestUpTo === llmUpTo` 误判 'no_new' → loop 提前退出，
  //   不调 LLM（langfuse 二次 run trace 仅 1 个 step span、无 generation）。
  //   修复：replyResolvedAny 标记 + refreshSnapshotOnly（重 assemble 让 LLM 看编辑后的 tool_result）。
  it('b 路径回归：仅 tool_reply drain → 返 ok + snapshot refresh + 续 LLM（修 no_new 误判）', async () => {
    const head1: PendingToolCall = {
      sessionId: 'sid-1', runId: 'r-1', toolCallId: 'tc-1', toolName: 'ask-question',
      handleType: 'direct_result', subState: 'need_feedback', data: { questions: [] },
      resultMessageId: 'm-tool', resultBlockIndex: 0, status: 'pending',
    };
    const snapshot = mkSnapshot();
    const { spec, storeMocks } = mkRunSpec({
      initialHead: head1,
      afterResolveHead: null,
      assembleSnapshot: snapshot,
    });
    spec.wireInbox!.enqueue('sid-1', [mkToolReplyMessage('tc-1')]);
    // 模拟真实二 run 启动：initState 把两 cursor 都设为 newest msg id（tool 占位 msg）
    // → cursor 相同 → 旧 gate 必误判 'no_new'
    const state = mkState();
    state.ingestUpTo = 'm-tool';
    state.llmUpTo = 'm-tool';

    const r = await prepareStage(spec, state);

    // 修复后必 'ok'（旧 bug 返 'no_new' → loop 不调 LLM）
    expect(r).toBe('ok');
    expect(state.hitlAfterReplyPending).toBe(false);
    // snapshot 被 refresh（refreshSnapshotOnly 调 assemble）
    expect(state.snapshot).toBe(snapshot);
    // store upsert（编辑占位 block）被调
    expect(storeMocks.appendMessages).toHaveBeenCalled();
    expect(storeMocks.resolvePendingToolCall).toHaveBeenCalledWith('sid-1', 'tc-1');
  });
});
