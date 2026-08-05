/**
 * v0.0.173 rebuild 路径 tool_call/tool_result 配对回归测试
 *
 * 背景：v0.0.173 重构后 snapshot.messages 永远 rebuild（删 appendNew + 3 workaround），
 *   tool 顺序由 transcript id 严格单调天然保证；清理 reducer 迁到 clean view EP
 *   （独立链，跑在 structuredClone 副本上，不污染 snapshot）。
 *
 * 本文件验证两条核心保证：
 *   - 场景 A：rebuild 路径多轮一次性 ingest 后 tool 配对完整（保 v0.0.66 既有保证不回归）
 *   - 场景 E：v0.0.173 prod 400 bug 根治回归保护——
 *     历史 root cause：role_merge 合并相邻同 role assistant 消息时吞掉后者 id →
 *     下轮 appendNew 把被吞消息当 newOnes 追加到末尾 → tool_use 落到 tool_result 后面 → 400。
 *     rebuild 后 transcript id 单调天然有序 + 清理跑深克隆副本（不污染 snapshot），
 *     再加上 orphan_tool_call 的 reorderToolAdjacency 拉 tool 紧跟 assistant → 彻底根治。
 *
 * 参考: specs/tech/version_logs/v0.0.173/change_plan.md §五
 *       reqs/[working] v0.0.173/req.md §五.13
 *       app/plugins/builtins/rocky_context/assemble/base_builder.ts（rebuild 唯一路径）
 */
import { describe, it, expect } from 'vitest';
import type { Message } from '../../../../server/src/message/types';
import BaseBuilderReducer from '../assemble/base_builder';
import OrphanToolCallReducer from '../assemble/orphan_tool_call';
import RoleMergeReducer from '../assemble/role_merge';
import type { AssembleData, AssembleCtx } from '../types';

/** minimal AssembleCtx（base_builder/orphan/role_merge 实际只用 config + ratio 字段） */
function mkCtx(): AssembleCtx {
  return {
    config: {
      sessionId: 'test-sid',
      client: { contextWindow: 100000 } as never,
    },
    prevSnapshot: null,
    ratio: 1.0,
  } as unknown as AssembleCtx;
}

/** 造 assistant（含 tool_call block）— tool_call.id 即配对 key */
function mkAssistantWithToolCall(id: string, toolCallId: string, text = 'calling tool'): Message {
  return {
    id, sessionId: 'test-sid', role: 'assistant',
    content: [
      { type: 'text', text },
      { type: 'tool_call', id: toolCallId, name: 'bash', input: { cmd: 'echo' } },
    ],
  };
}

/** 造 assistant（纯 text，无 tool_call） */
function mkAssistantText(id: string, text = 'plain assistant'): Message {
  return {
    id, sessionId: 'test-sid', role: 'assistant',
    content: [{ type: 'text', text }],
  };
}

/** 造 tool 消息（tool_result 配对 key = toolCallId） */
function mkToolResult(id: string, toolCallId: string): Message {
  return {
    id, sessionId: 'test-sid', role: 'tool',
    content: [{ type: 'tool_result', toolCallId, content: 'done' }],
  };
}

function mkUser(id: string, text = 'q'): Message {
  return { id, sessionId: 'test-sid', role: 'user', content: [{ type: 'text', text }] };
}

/** 找第一个含 tool_call 的 message index（无则 -1） */
function findToolCallIdx(msgs: Message[]): number {
  return msgs.findIndex((m) => m.content.some((b) => b.type === 'tool_call'));
}

/** 找第一个含 tool_result 的 message index（无则 -1） */
function findToolResultIdx(msgs: Message[]): number {
  return msgs.findIndex((m) => m.content.some((b) => b.type === 'tool_result'));
}

/** 拉所有 tool_call.id */
function collectToolCallIds(msgs: Message[]): string[] {
  const ids: string[] = [];
  for (const m of msgs) for (const b of m.content) if (b.type === 'tool_call') ids.push(b.id);
  return ids;
}

/** 拉所有 tool_result.toolCallId */
function collectToolResultIds(msgs: Message[]): string[] {
  const ids: string[] = [];
  for (const m of msgs) for (const b of m.content) if (b.type === 'tool_result') ids.push(b.toolCallId);
  return ids;
}

describe('[v0.0.173 rebuild] tool_call/tool_result 配对回归', () => {
  it('场景 A：assemble 一次 ingest 全部 (user+assistant_call+tool_result) — tool 配对在 rebuild 后完整', () => {
    // 场景：第一次 ingest 把 user/assistant_call/tool_result 一起送进来
    // 期望：rebuild 路径产出全部，orphan_tool_call 看到完整配对 → tool_call + tool_result 都保留
    const base = new BaseBuilderReducer('base_builder', {});
    const orphan = new OrphanToolCallReducer('orphan_tool_call', {});

    const transcript: Message[] = [
      mkUser('u1'),
      mkAssistantWithToolCall('a1', 'tc1'),
      mkToolResult('t1', 'tc1'),
    ];

    const data: AssembleData = { transcript, summary: null } as unknown as AssembleData;

    // Round 1: input=null → rebuild 全量
    const rebuilt = base.reduce(data, null, mkCtx());
    const afterOrphan = orphan.reduce(data, rebuilt, mkCtx());

    // [全 transcript]：配对完整 → orphan 不剥
    expect(afterOrphan.map((m) => m.id)).toEqual(['u1', 'a1', 't1']);
    const a1 = afterOrphan.find((m) => m.id === 'a1')!;
    expect(a1.content.some((b) => b.type === 'tool_call')).toBe(true);
    // tool_use 在 tool_result 之前（idx 顺序）
    expect(findToolCallIdx(afterOrphan)).toBeLessThan(findToolResultIdx(afterOrphan));
  });

  /**
   * 场景 E：v0.0.173 prod 400 bug 根治回归保护
   *
   * 复现 root cause 链（rebuild + clean view 分层后应不再触发）：
   *   transcript 中 assistant(text) 与 assistant(text+tool_call) 相邻（id 单调递增），
   *   role_merge 合并后者进前者（后者 id 从 CLEAN VIEW 消失，但 transcript/snapshot 保留）。
   *   历史 bug：appendNew 把 id 消失的 assistant 当新消息追加到末尾 → tool_use 落 tool_result 后 → 400。
   *
   * v0.0.173 根治机制：
   *   1. snapshot.messages = [...transcript]（rebuild，transcript id 单调 → 天然有序）
   *   2. clean view 跑在 structuredClone 副本上，不污染 snapshot → 下轮 rebuild 仍基于干净 transcript
   *   3. orphan_tool_call.reorderToolAdjacency 把 tool 拉紧跟 assistant
   *
   * 断言两条：
   *   (1) clean view 输出中 tool_use 与 tool_result 相邻且 tool_use 在前
   *   (2) 多轮 rebuild 后（round N+1 transcript 加新消息）snapshot.messages 中 tool 顺序依然正确
   */
  it('场景 E：role_merge 合并 assistant 后 clean view 中 tool_use 仍在 tool_result 之前（400 bug 根治）', () => {
    const base = new BaseBuilderReducer('base_builder', {});
    const orphan = new OrphanToolCallReducer('orphan_tool_call', {});
    const roleMerge = new RoleMergeReducer('role_merge', {});

    // === Round N：transcript 含相邻 assistant(text) + assistant(text+tool_call) ===
    // ULID 字典序单调（drain 顺序）；tool_call.id 与 assistant message id 同源（同 ulid 时钟）
    const userMsg = mkUser('01AAUSER0000000000000000000', 'do something');
    const assistantText = mkAssistantText('01BBASS0000000000000000000', 'let me think');
    const assistantCall = mkAssistantWithToolCall(
      '01CCASS0000000000000000000',
      '01TOOLC000000000000000000', // tool_call id（同 ulid 时钟，drain 后于 assistant_call）
      'now call tool',
    );
    const toolResult = mkToolResult(
      '01DDTOOL000000000000000000',
      '01TOOLC000000000000000000',
    );

    const transcriptRound1: Message[] = [userMsg, assistantText, assistantCall, toolResult];
    const data1: AssembleData = {
      transcript: transcriptRound1,
      summary: null,
    } as unknown as AssembleData;

    // snapshot 构建（永远 rebuild）：[全 transcript]，id 单调天然有序
    const snapshotRound1 = base.reduce(data1, null, mkCtx());

    // snapshot 顺序检查（保 invariant：rebuild 后 tool_use 仍在前）
    expect(findToolCallIdx(snapshotRound1)).toBeLessThan(findToolResultIdx(snapshotRound1));

    // clean view 链（snapshot 不被 mutate；这里传 snapshotRound1 副本）
    // 模拟 getCleanSnapshot：先深克隆（structuredClone），再跑 orphan + role_merge
    const cleanInput = structuredClone(snapshotRound1);
    const afterOrphan = orphan.reduce(data1, cleanInput, mkCtx());
    const afterRoleMerge = roleMerge.reduce(data1, afterOrphan, mkCtx());

    // 关键断言 1：tool_use 仍在 tool_result 之前（400 bug 根治金标）
    const callIdx = findToolCallIdx(afterRoleMerge);
    const resultIdx = findToolResultIdx(afterRoleMerge);
    expect(callIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeLessThan(resultIdx);

    // role_merge 合并后 assistant 数应从 2 降到 1（assistantText 吞掉 assistantCall 的 content）
    const assistants = afterRoleMerge.filter((m) => m.role === 'assistant');
    expect(assistants.length).toBe(1);
    // 合并后的 assistant 同时含 text + tool_call（content blocks 合并）
    const mergedAssistant = assistants[0]!;
    expect(mergedAssistant.content.some((b) => b.type === 'text')).toBe(true);
    expect(mergedAssistant.content.some((b) => b.type === 'tool_call')).toBe(true);

    // 关键断言 2：tool_use 与 tool_result 相邻（或phan_tool_call 的 reorderToolAdjacency 保证）
    //   tool 消息紧跟在含 tool_call 的 assistant 之后
    const toolMsgIdx = afterRoleMerge.findIndex((m) => m.role === 'tool');
    expect(toolMsgIdx).toBe(callIdx + 1);

    // 配对 id 一致
    expect(collectToolCallIds(afterRoleMerge)).toEqual(['01TOOLC000000000000000000']);
    expect(collectToolResultIds(afterRoleMerge)).toEqual(['01TOOLC000000000000000000']);

    // === Round N+1：transcript 加新消息（user 追问 + assistant 回复） ===
    // 关键：rebuild 每轮从 transcript 全量重建，不依赖 prevSnapshot → snapshot 顺序始终正确
    const userFollowUp = mkUser('01EEUSER0000000000000000000', 'follow up q');
    const assistantFollowUp = mkAssistantText('01FFASS0000000000000000000', 'follow up answer');
    const transcriptRound2: Message[] = [
      ...transcriptRound1,
      userFollowUp,
      assistantFollowUp,
    ];
    const data2: AssembleData = {
      transcript: transcriptRound2,
      summary: null,
    } as unknown as AssembleData;

    const snapshotRound2 = base.reduce(data2, null, mkCtx());

    // 关键断言 3：多轮 rebuild 后 snapshot.messages 中 tool 顺序依然正确
    expect(findToolCallIdx(snapshotRound2)).toBeLessThan(findToolResultIdx(snapshotRound2));
    // id 单调顺序保留（保 rebuild 是确定性纯函数）
    expect(snapshotRound2.map((m) => m.id)).toEqual([
      '01AAUSER0000000000000000000',
      '01BBASS0000000000000000000',
      '01CCASS0000000000000000000',
      '01DDTOOL000000000000000000',
      '01EEUSER0000000000000000000',
      '01FFASS0000000000000000000',
    ]);
  });
});
