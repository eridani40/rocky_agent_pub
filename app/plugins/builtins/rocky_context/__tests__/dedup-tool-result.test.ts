/**
 * rocky_context plugin — clean_view_reducer: dedup_tool_result 单测
 * 参考: specs/tech/version_logs/v0.0.207/change_plan.md §T3
 *       specs/tech/agent/context/[P0]context_assemble_detail.md §5b
 *
 * 覆盖（test-plan T3）：
 *   - 双 result（一 interrupted isError=true + 一完整 isError=false）→ 保留完整
 *   - 全 isError=true → 保留首条（interrupted 占位）
 *   - 单 result → 不动（零命中）
 *   - 与 orphan_tool_call 串行（dedup 在前）：dedup 后 orphan 正确判配对
 *   - 不可变（input 不变，返新数组）
 *   - 多个 toolCallId 同时去重（多组）
 *   - tool message 内多个 block 部分去重（同 message 内多 toolCallId）
 */
import { describe, it, expect, vi } from 'vitest';
import { ulid } from '../../../../server/src/config/ulid';
import type { ContentBlock, Message } from '../../../../server/src/message/types';
import DedupToolResultReducer from '../assemble/dedup_tool_result';
import OrphanToolCallReducer from '../assemble/orphan_tool_call';

/** 造假 config（reducer 仅读 ctx.config.sessionId 写 error log，fail-silent） */
function fakeConfig() {
  return { sessionId: 'sid-dedup' } as never;
}

const emptyData = { transcript: [], summary: null } as never;

/** 造 tool message（role='tool'，content 为 tool_result blocks） */
function toolMsg(content: ContentBlock[], id?: string): Message {
  return {
    id: id ?? ulid(),
    sessionId: 'sid-dedup',
    role: 'tool',
    content,
  };
}

/** 造 assistant message 含 tool_call block */
function assistantWithCall(callId: string, id?: string): Message {
  return {
    id: id ?? ulid(),
    sessionId: 'sid-dedup',
    role: 'assistant',
    content: [
      { type: 'text', text: 'calling tool' },
      { type: 'tool_call', id: callId, name: 'bash', arguments: {} },
    ],
  };
}

/** interrupted tool_result block（isError=true，content="[_interrupted_]"） */
function interruptedResult(toolCallId: string): ContentBlock {
  return {
    type: 'tool_result',
    toolCallId,
    content: [{ type: 'text', text: '[_interrupted_]' }],
    isError: true,
  };
}

/** 完整 tool_result block（isError=false，content 为正常 tool 输出） */
function completeResult(toolCallId: string, text: string = 'tool output'): ContentBlock {
  return {
    type: 'tool_result',
    toolCallId,
    content: [{ type: 'text', text }],
    isError: false,
  };
}

describe('[v0.0.207 T3] dedup_tool_result reducer', () => {
  it('双 result（interrupted isError=true + 完整 isError=false）→ 保留完整（剔除 interrupted）', () => {
    const callId = 'call-7T0AG';
    // 模拟 v0.0.207 bug 场景：abort api 写 interrupted（先）+ loop 写完整（后）
    const input: Message[] = [
      assistantWithCall(callId),
      toolMsg([interruptedResult(callId)], 'msg-interrupted'),
      toolMsg([completeResult(callId, 'web_search 结果')], 'msg-complete'),
    ];
    const reducer = new DedupToolResultReducer('dedup_tool_result', {});
    const out = reducer.reduce(emptyData, input, { config: fakeConfig(), prevSnapshot: null, ratio: 1 });
    // 剔除 interrupted；保留完整
    const toolResults = out.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as { isError: boolean }).isError).toBe(false);
    expect((toolResults[0] as { content: { text: string }[] }).content[0].text).toBe('web_search 结果');
  });

  it('完整先 + interrupted 后：仍保留完整（不依赖顺序，看 isError）', () => {
    const callId = 'call-XYZ';
    const input: Message[] = [
      assistantWithCall(callId),
      toolMsg([completeResult(callId, 'first complete')], 'msg-complete'),
      toolMsg([interruptedResult(callId)], 'msg-interrupted'),
    ];
    const reducer = new DedupToolResultReducer('dedup_tool_result', {});
    const out = reducer.reduce(emptyData, input, { config: fakeConfig(), prevSnapshot: null, ratio: 1 });
    const toolResults = out.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as { isError: boolean }).isError).toBe(false);
  });

  it('全 isError=true → 保留首条（interrupted 占位），空 message 不删（交 empty_message 兜底）', () => {
    const callId = 'call-all-err';
    const input: Message[] = [
      assistantWithCall(callId),
      toolMsg([interruptedResult(callId)], 'msg-err-1'),
      toolMsg([interruptedResult(callId)], 'msg-err-2'),
    ];
    const reducer = new DedupToolResultReducer('dedup_tool_result', {});
    const out = reducer.reduce(emptyData, input, { config: fakeConfig(), prevSnapshot: null, ratio: 1 });
    // change_plan 约束：保留 message（即便 content 变空也交 empty_message 兜底）
    // 所以 msg-err-2 仍在数组里但 content=[]
    const toolMsgs = out.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    // 首条保留 keeper（msg-err-1 的 block）
    expect(toolMsgs[0].id).toBe('msg-err-1');
    expect(toolMsgs[0].content).toHaveLength(1);
    // 次条 content 被过滤空（reducer 不删 message，交下游 empty_message 处理）
    expect(toolMsgs[1].id).toBe('msg-err-2');
    expect(toolMsgs[1].content).toHaveLength(0);
    // 总 tool_result 数 = 1（首条 keeper）
    const allResults = out.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect(allResults).toHaveLength(1);
  });

  it('单 result → 不动（零命中，原样返回）', () => {
    const callId = 'call-single';
    const input: Message[] = [
      assistantWithCall(callId),
      toolMsg([completeResult(callId)], 'msg-only'),
    ];
    const reducer = new DedupToolResultReducer('dedup_tool_result', {});
    const out = reducer.reduce(emptyData, input, { config: fakeConfig(), prevSnapshot: null, ratio: 1 });
    expect(out).toBe(input); // 零命中返原数组引用
  });

  it('多个 toolCallId 同时去重（独立分组，各自挑 keeper）', () => {
    const callId1 = 'call-A';
    const callId2 = 'call-B';
    const input: Message[] = [
      assistantWithCall(callId1),
      assistantWithCall(callId2),
      toolMsg([interruptedResult(callId1), interruptedResult(callId2)], 'msg-interrupted-both'),
      toolMsg([completeResult(callId1, 'A-out'), completeResult(callId2, 'B-out')], 'msg-complete-both'),
    ];
    const reducer = new DedupToolResultReducer('dedup_tool_result', {});
    const out = reducer.reduce(emptyData, input, { config: fakeConfig(), prevSnapshot: null, ratio: 1 });
    const toolResults = out.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect(toolResults).toHaveLength(2);
    const aResult = toolResults.find((b) => (b as { toolCallId: string }).toolCallId === callId1);
    const bResult = toolResults.find((b) => (b as { toolCallId: string }).toolCallId === callId2);
    expect(aResult).toBeDefined();
    expect(bResult).toBeDefined();
    expect((aResult as { isError: boolean }).isError).toBe(false);
    expect((bResult as { isError: boolean }).isError).toBe(false);
  });

  it('同 message 内多 result 部分剔除（保留 keeper 在原 message）', () => {
    const callId = 'call-same-msg';
    // 同一 tool message 内：先 interrupted 后 完整（同 toolCallId 两 block）
    const input: Message[] = [
      assistantWithCall(callId),
      toolMsg([interruptedResult(callId), completeResult(callId, 'same-msg-out')], 'msg-mixed'),
    ];
    const reducer = new DedupToolResultReducer('dedup_tool_result', {});
    const out = reducer.reduce(emptyData, input, { config: fakeConfig(), prevSnapshot: null, ratio: 1 });
    const toolMsgs = out.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(1);
    const results = toolMsgs[0].content.filter((b) => b.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect((results[0] as { isError: boolean }).isError).toBe(false);
  });

  it('不可变：input 数组与原 message 引用不变（返新数组）', () => {
    const callId = 'call-immut';
    const input: Message[] = [
      assistantWithCall(callId),
      toolMsg([interruptedResult(callId)], 'msg-err'),
      toolMsg([completeResult(callId)], 'msg-ok'),
    ];
    const reducer = new DedupToolResultReducer('dedup_tool_result', {});
    const out = reducer.reduce(emptyData, input, { config: fakeConfig(), prevSnapshot: null, ratio: 1 });
    expect(out).not.toBe(input); // 返新数组
    // 原 input 未被 mutate（仍含 2 个 tool message）
    expect(input.filter((m) => m.role === 'tool')).toHaveLength(2);
    // assistant message 原样引用（只 tool message 被替换为新对象）
    const originalAssistant = input[0];
    const outAssistant = out[0];
    expect(outAssistant).toBe(originalAssistant);
  });

  it('命中时写 error log（鸭子类型 logWriter，fail-silent）', () => {
    const callId = 'call-log';
    const input: Message[] = [
      assistantWithCall(callId),
      toolMsg([interruptedResult(callId)]),
      toolMsg([completeResult(callId)]),
    ];
    const logWriter = { write: vi.fn() };
    const ctx = {
      config: { sessionId: 'sid-dedup', logWriter },
      prevSnapshot: null,
      ratio: 1,
    };
    const reducer = new DedupToolResultReducer('dedup_tool_result', {});
    reducer.reduce(emptyData, input, ctx as never);
    // error log 写入：reducer 名 / sessionId / duplicates 数 / toolCallIds
    expect(logWriter.write).toHaveBeenCalledTimes(1);
    const [type, record] = logWriter.write.mock.calls[0];
    expect(type).toBe('error');
    expect(record).toMatchObject({
      reducer: 'dedup_tool_result',
      sessionId: 'sid-dedup',
      duplicates: 1,
    });
    expect(record.toolCallIds).toEqual([callId]);
  });

  it('logWriter 缺失/异常 → fail-silent（不抛错，不影响主流程）', () => {
    const callId = 'call-no-log';
    const input: Message[] = [
      assistantWithCall(callId),
      toolMsg([interruptedResult(callId)]),
      toolMsg([completeResult(callId)]),
    ];
    const ctx = {
      config: { sessionId: 'sid-dedup' }, // 无 logWriter
      prevSnapshot: null,
      ratio: 1,
    };
    const reducer = new DedupToolResultReducer('dedup_tool_result', {});
    expect(() => reducer.reduce(emptyData, input, ctx as never)).not.toThrow();
    // 即便 logWriter.write 抛错也 fail-silent
    const throwingLogWriter = { write: () => { throw new Error('log write boom'); } };
    const ctx2 = { config: { sessionId: 'sid-dedup', logWriter: throwingLogWriter }, prevSnapshot: null, ratio: 1 };
    expect(() => reducer.reduce(emptyData, [...input], ctx2 as never)).not.toThrow();
  });
});

// ============================================================
// dedup_tool_result × orphan_tool_call 串行（dedup 在前）
// ============================================================

describe('[v0.0.207 T3] dedup_tool_result + orphan_tool_call 串行（链顺序敏感性）', () => {
  it('dedup 先去重 → orphan 正确判配对（仅一条 tool_result 配 tool_call）', () => {
    const callId = 'call-chain';
    const input: Message[] = [
      assistantWithCall(callId),
      toolMsg([interruptedResult(callId)], 'msg-interrupted'),
      toolMsg([completeResult(callId)], 'msg-complete'),
    ];
    // 模拟 clean_view_reducer EP 链顺序：dedup_tool_result 在 orphan_tool_call 前
    const dedup = new DedupToolResultReducer('dedup_tool_result', {});
    const orphan = new OrphanToolCallReducer('orphan_tool_call', {});
    const ctx = { config: fakeConfig(), prevSnapshot: null, ratio: 1 };
    const afterDedup = dedup.reduce(emptyData, input, ctx);
    const afterOrphan = orphan.reduce(emptyData, afterDedup, ctx);
    // 最终：assistant(tool_call) + 单 tool message(tool_result) 完整配对
    const toolResults = afterOrphan.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as { isError: boolean }).isError).toBe(false);
    // orphan 不应剥掉任何 tool_call（配对完整）
    const toolCalls = afterOrphan.flatMap((m) => m.content).filter((b) => b.type === 'tool_call');
    expect(toolCalls).toHaveLength(1);
  });

  it('不跑 dedup 直接跑 orphan → orphan 见双 result 都当 paired 全留（T3 失效场景复现）', () => {
    const callId = 'call-no-dedup';
    const input: Message[] = [
      assistantWithCall(callId),
      toolMsg([interruptedResult(callId)], 'msg-interrupted'),
      toolMsg([completeResult(callId)], 'msg-complete'),
    ];
    const orphan = new OrphanToolCallReducer('orphan_tool_call', {});
    const ctx = { config: fakeConfig(), prevSnapshot: null, ratio: 1 };
    const afterOrphan = orphan.reduce(emptyData, input, ctx);
    // 不跑 dedup → 双 result 都被 orphan 当 paired 保留 → T3 兜底失效（这就是 dedup 必须在前的理由）
    const toolResults = afterOrphan.flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect(toolResults).toHaveLength(2);
  });
});
