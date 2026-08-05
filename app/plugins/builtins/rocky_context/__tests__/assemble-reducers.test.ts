/**
 * rocky_context plugin assemble_reducer(7) 单测
 * 参考: specs/tech/agent/context_and_memory/[P0]context_assemble_detail.md §2/§5/§6
 *       specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §3.3/§4.4
 *
 * 覆盖：
 *   - base_builder：rebuild 路径（无 summary / 有 summary head-tail 算法 / config 边界 / ratio 动态化）
 *   - orphan_tool_call：移除无配对 tool_call/tool_result
 *   - think_remove：删 reasoning(think) content block
 *   - fill_empty_text：user/tool(success) 空 text content block 兜底为 "empty"（防 LLM 400）
 *   - empty_message：剔空 content
 *   - role_merge：相邻同 role 合并（system 不合）
 *   - snip_handler：message.snip 标记替换占位
 *
 * [v0.0.173] base_builder 永远 rebuild（删 append 分支 + appendNew）；旧 append 行为测试已删。
 */
import { describe, it, expect } from 'vitest';
import { ulid } from '../../../../server/src/config/ulid';
import type { ContentBlock, Message } from '../../../../server/src/message/types';
import BaseBuilderReducer from '../assemble/base_builder';
import OrphanToolCallReducer from '../assemble/orphan_tool_call';
import ThinkRemoveReducer from '../assemble/think_remove';
import EmptyMessageReducer from '../assemble/empty_message';
import FillEmptyTextReducer from '../assemble/fill_empty_text';
import RoleMergeReducer from '../assemble/role_merge';
import SnipHandlerReducer from '../assemble/snip_handler';

/** 造假 config */
function fakeConfig(contextWindow = 100000) {
  return {
    sessionId: 'sid',
    systemPrompt: 'SYS',
    client: { contextWindow },
    modelId: 'm',
  } as never;
}

/** 造业务 message */
function msg(
  role: Message['role'],
  content: ContentBlock[] | string,
  id?: string,
  metadata?: Record<string, unknown>,
): Message {
  return {
    id: id ?? ulid(),
    sessionId: 'sid',
    role,
    content:
      typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    metadata,
  };
}

/** tool_call block */
function callBlock(id: string, name = 'bash'): ContentBlock {
  return { type: 'tool_call', id, name, arguments: {} };
}

/** tool_result block */
function resultBlock(toolCallId: string): ContentBlock {
  return {
    type: 'tool_result',
    toolCallId,
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
  };
}

// [v0.0.66 §2.4] AssembleData.system 字段已删（system 不走 assemble 链，由 snapshot.system 独立承载）
// [v0.0.173] AssembleData.prevMessages 字段已删（snapshot 永远 rebuild，不再需要增量基础）
const emptyData = { transcript: [], summary: null } as never;

describe('assemble_reducer — base_builder', () => {
  it('input=null 无 summary → 全 transcript（无 system msg，[v0.0.66 §2.5]）', () => {
    const transcript = [msg('user', 'a'), msg('assistant', 'b')];
    const out = new BaseBuilderReducer('base_builder', {}).reduce(
      { ...emptyData, transcript },
      null,
      { config: fakeConfig(), prevSnapshot: null },
    );
    // [v0.0.66 §2.5] rebuild 无 summary → [全 transcript]（system 不在 messages，由 snapshot.system 承载）
    expect(out).toHaveLength(2);
    expect(out[0]!.id).toBe(transcript[0]!.id);
    expect(out[1]!.id).toBe(transcript[1]!.id);
    // 无 id=system 的 message
    expect(out.find((m) => m.id === 'system')).toBeUndefined();
  });

  it('rebuild：summary version 变了 → [summary msg] + recent（无 system msg）', () => {
    const m1 = msg('user', 'h1', 'm1');
    const m2 = msg('assistant', 'h2', 'm2');
    const m3 = msg('user', 'recent1', 'm3');
    const m4 = msg('assistant', 'recent2', 'm4');
    const prev = {
      messages: [m1, m2],
      summary: { version: 1 },
    } as never;
    // summaryUpTo=m2 → headCandidates=[m1,m2]，recent=[m3,m4]
    const out = new BaseBuilderReducer('base_builder', {}).reduce(
      {
        ...emptyData,
        transcript: [m1, m2, m3, m4],
        summary: { version: 2, summaryUpTo: 'm2', content: 'SUMMARY' } as never,
      },
      null,
      { config: fakeConfig(), prevSnapshot: prev },
    );
    // [v0.0.66 §2.5] [summary msg, m3, m4]（无 system msg）
    expect(out).toHaveLength(3);
    expect(out[0]!.id).toBe('summary:2');
    // [v0.0.81] summary 是 1 个 text content block，preamble+head+tail 3 段拼成 1 个 text
    expect(out[0]!.content).toHaveLength(1);
    expect(out[0]!.content[0]!.type).toBe('text');
    expect((out[0]!.content[0] as { text: string }).text).toContain('SUMMARY');
    // [v0.0.81.compaction_bug] summary role = user（不是 system）
    expect(out[0]!.role).toBe('user');
    expect(out[1]!.id).toBe('m3');
    expect(out[2]!.id).toBe('m4');
  });

  it('[v0.0.185] head/tail 算法：tokenCap 累加停止（无 max 概念）', () => {
    // 6 条各 100 char，tokenCap=250（ratio=1.0）→ head=[m0,m1]（+m2=300>250 停）；tail=[m4,m5]
    const ms = Array.from({ length: 6 }, (_, i) => msg('user', 'x'.repeat(100), `m${i}`));
    const out = new BaseBuilderReducer('base_builder', { tokenCap: 250 }).reduce(
      {
        ...emptyData,
        transcript: ms,
        summary: { version: 1, summaryUpTo: 'm5', content: 'S' } as never,
      },
      null,
      { config: fakeConfig(1000000), prevSnapshot: null, ratio: 1.0 },
    );
    // [v0.0.81] summary 单 text block：head/tail 段拼在里面，按 [msgid|role] 行计
    const summaryMsg = out[0]!;
    expect(summaryMsg.content).toHaveLength(1);
    const text = (summaryMsg.content[0] as { text: string }).text;
    expect(countSectionItems(text, 'head')).toBe(2);
    expect(countSectionItems(text, 'tail')).toBe(2);
  });

  it('[v0.0.185] config 边界：tokenCap=2 只留保底 1 条/段（首条 3 char 即超 cap）', () => {
    // 每条 3 char，cap=2：首条 3>2 但保底 1 条 → head=1；tail=1
    const ms = Array.from({ length: 6 }, (_, i) => msg('user', `h${i}xx`, `m${i}`));
    const out = new BaseBuilderReducer('base_builder', { tokenCap: 2 }).reduce(
      {
        ...emptyData,
        transcript: ms,
        summary: { version: 1, summaryUpTo: 'm5', content: 'S' } as never,
      },
      null,
      { config: fakeConfig(1000000), prevSnapshot: null, ratio: 1.0 },
    );
    const summaryMsg = out[0]!;
    const text = (summaryMsg.content[0] as { text: string }).text;
    expect(countSectionItems(text, 'head')).toBe(1);
    expect(countSectionItems(text, 'tail')).toBe(1);
  });

  // —— v0.0.52 P0-1：rebuild 引用不等（summary msg 新建对象）——
  it('P0-1 rebuild 引用不等：version 变了 → summary msg 新建（非 prev 引用）', () => {
    const prevM = msg('user', 'OLD', 'm1');
    const prev = { messages: [prevM], summary: { version: 1 } } as never;
    const out = new BaseBuilderReducer('base_builder', {}).reduce(
      { ...emptyData, transcript: [], summary: { version: 2, summaryUpTo: null, content: 'NEW' } as never },
      null,
      { config: fakeConfig(), prevSnapshot: prev, ratio: 1.0 },
    );
    // [v0.0.66 §2.5] rebuild：[summary:2]（无 system msg）；summary msg 是新建对象
    expect(out[0]!.id).toBe('summary:2');
    expect(out[0]).not.toBe(prevM); // rebuild 新建 → 引用不等
  });

  // —— v0.0.52 P2-3：ratio 动态化（同 tokenCap，ratio 小 → head 取得更多）——
  it('P2-3 ratio 动态：ratio=0.5 比 ratio=1.0 取得更多 head（char×ratio 累加）', () => {
    // 10 条 head 候选（每条 200 字符），summaryUpTo=末尾 → 全部成 head 候选
    const ms = Array.from({ length: 10 }, () => msg('user', 'x'.repeat(200)));
    const summaryUpToId = ms[ms.length - 1]!.id;
    const data = {
      ...emptyData,
      transcript: ms,
      summary: { version: 1, summaryUpTo: summaryUpToId, content: 'S' } as never,
    };
    // [v0.0.185] tokenCap=500：ratio=1.0 → 200×1.0=200/msg → 累积 200→400→600(>500 停) → head=2
    const outR1 = new BaseBuilderReducer('base_builder', { tokenCap: 500 }).reduce(data, null, {
      config: fakeConfig(10000), prevSnapshot: null, ratio: 1.0,
    });
    // ratio=0.5：200×0.5=100/msg → 累积 100→…→500（≤500）→ +100=600(>500 停) → head=5
    const outR05 = new BaseBuilderReducer('base_builder', { tokenCap: 500 }).reduce(data, null, {
      config: fakeConfig(10000), prevSnapshot: null, ratio: 0.5,
    });
    const headR1 = countHeadItems(outR1);
    const headR05 = countHeadItems(outR05);
    expect(headR05).toBeGreaterThan(headR1); // 核心断言：ratio 小 → head 更多
    expect(headR1).toBe(2); // cap 累加停止
    expect(headR05).toBe(5);
  });

  /** [v0.0.81] 数 summary msg 单 text block 中 head 段的 [msgid|role] 行数 */
  function countHeadItems(out: Message[]): number {
    const sumMsg = out.find((m) => m.id.startsWith('summary:'));
    if (!sumMsg) return 0;
    const textBlock = sumMsg.content[0] as { text: string } | undefined;
    if (!textBlock || typeof textBlock.text !== 'string') return 0;
    return countSectionItems(textBlock.text, 'head');
  }
});

/**
 * [v0.0.81] 数 summary text block 中某段（head/tail）的 [msgid|role] 行数。
 * 段由 `--- <section>（...）---` 行界定，段内每条 `[msgid|role] ...` 算 1 条。
 */
function countSectionItems(text: string, section: 'head' | 'tail'): number {
  const startMarker = `--- ${section}`;
  const lines = text.split('\n');
  let inSection = false;
  let count = 0;
  for (const line of lines) {
    if (line.startsWith(startMarker)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      // 下一个段开始 / 空行后非 [ 开头 → 退出
      if (line.startsWith('--- ')) break;
      if (/^\[[^\]]+\|\w+\]/.test(line)) count++;
    }
  }
  return count;
}

describe('assemble_reducer — orphan_tool_call', () => {
  it('移除无对应 tool_result 的 tool_call block', () => {
    const input = [
      msg('assistant', [callBlock('c1'), callBlock('c2')]),
      msg('tool', [resultBlock('c1')]), // 只 result c1，c2 无配对
    ];
    const out = new OrphanToolCallReducer('orphan_tool_call', {}).reduce(
      emptyData,
      input,
      { config: fakeConfig(), prevSnapshot: null },
    );
    // assistant message 只剩 c1 call block（c2 被移除）
    const assistant = out.find((m) => m.role === 'assistant')!;
    const calls = assistant.content.filter((b) => b.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect((calls[0] as { id: string }).id).toBe('c1');
  });

  it('移除无对应 tool_call 的 tool_result block', () => {
    const input = [
      msg('assistant', [callBlock('c1')]),
      msg('tool', [resultBlock('c1'), resultBlock('orphan')]),
    ];
    const out = new OrphanToolCallReducer('orphan_tool_call', {}).reduce(
      emptyData,
      input,
      { config: fakeConfig(), prevSnapshot: null },
    );
    const tool = out.find((m) => m.role === 'tool')!;
    const results = tool.content.filter((b) => b.type === 'tool_result');
    expect(results).toHaveLength(1);
  });

  it('input=null → 空数组', () => {
    const out = new OrphanToolCallReducer('orphan_tool_call', {}).reduce(
      emptyData,
      null,
      { config: fakeConfig(), prevSnapshot: null },
    );
    expect(out).toEqual([]);
  });

  it('邻接重排：user 消息插在 TC/TR 之间 → tool 前移', () => {
    const input = [
      msg('assistant', [callBlock('c1')], 'a1'),
      msg('user', 'hi', 'u1'),
      msg('tool', [resultBlock('c1')], 't1'),
    ];
    const out = new OrphanToolCallReducer('orphan_tool_call', {}).reduce(
      emptyData,
      input,
      { config: fakeConfig(), prevSnapshot: null },
    );
    expect(out.map((m) => m.id)).toEqual(['a1', 't1', 'u1']);
  });

  it('邻接重排：多个 tool_call + 多个插入消息 → 所有 TR 紧跟 assistant', () => {
    const input = [
      msg('assistant', [callBlock('c1'), callBlock('c2')], 'a1'),
      msg('user', 'x', 'u1'),
      msg('tool', [resultBlock('c1')], 't1'),
      msg('user', 'y', 'u2'),
      msg('tool', [resultBlock('c2')], 't2'),
    ];
    const out = new OrphanToolCallReducer('orphan_tool_call', {}).reduce(
      emptyData,
      input,
      { config: fakeConfig(), prevSnapshot: null },
    );
    expect(out.map((m) => m.id)).toEqual(['a1', 't1', 't2', 'u1', 'u2']);
  });

  it('邻接重排：已邻接 → 不变（幂等）', () => {
    const input = [
      msg('assistant', [callBlock('c1')], 'a1'),
      msg('tool', [resultBlock('c1')], 't1'),
      msg('user', 'next', 'u1'),
    ];
    const out = new OrphanToolCallReducer('orphan_tool_call', {}).reduce(
      emptyData,
      input,
      { config: fakeConfig(), prevSnapshot: null },
    );
    expect(out.map((m) => m.id)).toEqual(['a1', 't1', 'u1']);
  });

  it('邻接重排：多轮 assistant→tool 交替 + 后一轮中间有插入', () => {
    const input = [
      msg('assistant', [callBlock('c1')], 'a1'),
      msg('tool', [resultBlock('c1')], 't1'),
      msg('assistant', [callBlock('c2')], 'a2'),
      msg('user', 'msg', 'u1'),
      msg('tool', [resultBlock('c2')], 't2'),
    ];
    const out = new OrphanToolCallReducer('orphan_tool_call', {}).reduce(
      emptyData,
      input,
      { config: fakeConfig(), prevSnapshot: null },
    );
    expect(out.map((m) => m.id)).toEqual(['a1', 't1', 'a2', 't2', 'u1']);
  });
});

describe('assemble_reducer — think_remove', () => {
  it('assistant 含 reasoning + text → 删 reasoning、保留 text', () => {
    const input = [
      msg('assistant', [{ type: 'reasoning', text: '思考内容' }, { type: 'text', text: 'hello' }]),
    ];
    const out = new ThinkRemoveReducer('think_remove', {}).reduce(
      emptyData,
      input,
      { config: fakeConfig(), prevSnapshot: null },
    );
    expect(out).toHaveLength(1);
    const types = out[0]!.content.map((b) => b.type);
    expect(types).not.toContain('reasoning');
    expect(types).toEqual(['text']);
    expect((out[0]!.content[0] as { text: string }).text).toBe('hello');
  });

  it('assistant 含 reasoning + tool_call → 删 reasoning、保留 tool_call', () => {
    const input = [
      msg('assistant', [{ type: 'reasoning', text: '想用工具' }, callBlock('c1')]),
    ];
    const out = new ThinkRemoveReducer('think_remove', {}).reduce(
      emptyData,
      input,
      { config: fakeConfig(), prevSnapshot: null },
    );
    expect(out).toHaveLength(1);
    const types = out[0]!.content.map((b) => b.type);
    expect(types).not.toContain('reasoning');
    expect(types).toEqual(['tool_call']);
    expect((out[0]!.content[0] as { id: string }).id).toBe('c1');
  });

  it('无 reasoning 的消息 → 原样保留（content 不变）', () => {
    const input = [
      msg('user', [callBlock('c1')]),
      msg('assistant', 'plain text'),
      msg('tool', [resultBlock('c1')]),
    ];
    const out = new ThinkRemoveReducer('think_remove', {}).reduce(
      emptyData,
      input,
      { config: fakeConfig(), prevSnapshot: null },
    );
    expect(out).toHaveLength(3);
    // 每条 message 的 content 块数 / 首块类型保持不变
    expect(out[0]!.content).toHaveLength(1);
    expect(out[0]!.content[0]!.type).toBe('tool_call');
    expect(out[1]!.content).toHaveLength(1);
    expect(out[1]!.content[0]!.type).toBe('text');
    expect(out[2]!.content).toHaveLength(1);
    expect(out[2]!.content[0]!.type).toBe('tool_result');
  });

  it('input=null → 空', () => {
    const out = new ThinkRemoveReducer('think_remove', {}).reduce(
      emptyData,
      null,
      { config: fakeConfig(), prevSnapshot: null },
    );
    expect(out).toEqual([]);
  });
});

describe('assemble_reducer — empty_message', () => {
  it('剔空 content 的 message（system 保留）', () => {
    const input = [
      msg('system', 'SYS'),
      msg('user', []),
      msg('assistant', 'hi'),
    ];
    const out = new EmptyMessageReducer('empty_message', {}).reduce(
      emptyData,
      input,
      { config: fakeConfig(), prevSnapshot: null },
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.role).toBe('system');
    expect(out[1]!.role).toBe('assistant');
  });

  it('input=null → 空', () => {
    const out = new EmptyMessageReducer('empty_message', {}).reduce(
      emptyData,
      null,
      { config: fakeConfig(), prevSnapshot: null },
    );
    expect(out).toEqual([]);
  });
});

// fill_empty_text：兜底空 text content block 为 "empty"，防 Anthropic 400
describe('assemble_reducer — fill_empty_text', () => {
  it('user message 空 text → "empty"', () => {
    const input = [
      msg('user', [{ type: 'text', text: '' }]),
    ];
    const out = new FillEmptyTextReducer('fill_empty_text', {}).reduce(
      emptyData,
      input,
      { config: fakeConfig(), prevSnapshot: null },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.content[0]!.type).toBe('text');
    expect((out[0]!.content[0] as { text: string }).text).toBe('empty');
  });

  it('tool success 嵌套 tool_result.content 空 text → "empty"', () => {
    const input = [
      msg('tool', [
        {
          type: 'tool_result',
          toolCallId: 'c1',
          content: [{ type: 'text', text: '' }],
          isError: false,
        },
      ]),
    ];
    const out = new FillEmptyTextReducer('fill_empty_text', {}).reduce(
      emptyData,
      input,
      { config: fakeConfig(), prevSnapshot: null },
    );
    const tb = out[0]!.content[0] as { type: string; content: { type: string; text: string }[] };
    expect(tb.type).toBe('tool_result');
    expect(tb.content[0]!.text).toBe('empty');
  });

  it('tool error 嵌套 tool_result.content 空 text → 不动', () => {
    const input = [
      msg('tool', [
        {
          type: 'tool_result',
          toolCallId: 'c1',
          content: [{ type: 'text', text: '' }],
          isError: true,
        },
      ]),
    ];
    const out = new FillEmptyTextReducer('fill_empty_text', {}).reduce(
      emptyData,
      input,
      { config: fakeConfig(), prevSnapshot: null },
    );
    const tb = out[0]!.content[0] as { type: string; content: { type: string; text: string }[] };
    expect(tb.content[0]!.text).toBe(''); // 原样不动
  });

  it('非空 text / assistant / system → 不动', () => {
    const input = [
      msg('system', 'SYS'),
      msg('user', [{ type: 'text', text: 'hi' }]),
      msg('assistant', [{ type: 'text', text: '' }]), // assistant 空 text 也不动（设计限定）
    ];
    const out = new FillEmptyTextReducer('fill_empty_text', {}).reduce(
      emptyData,
      input,
      { config: fakeConfig(), prevSnapshot: null },
    );
    expect(out).toHaveLength(3);
    // user 非空 text 不动
    expect((out[1]!.content[0] as { text: string }).text).toBe('hi');
    // assistant 空 text 不动
    expect((out[2]!.content[0] as { text: string }).text).toBe('');
  });

  it('input=null → 空', () => {
    const out = new FillEmptyTextReducer('fill_empty_text', {}).reduce(
      emptyData,
      null,
      { config: fakeConfig(), prevSnapshot: null },
    );
    expect(out).toEqual([]);
  });

  it('命中时经 ctx.config.logWriter 写 error log（鸭子类型能力探测）', () => {
    const writes: { type: string; rec: Record<string, unknown> }[] = [];
    const config = {
      ...fakeConfig(),
      logWriter: {
        write: (type: string, rec: Record<string, unknown>) => writes.push({ type, rec }),
      },
    } as never;
    const input = [msg('user', [{ type: 'text', text: '' }])];
    new FillEmptyTextReducer('fill_empty_text', {}).reduce(
      emptyData,
      input,
      { config, prevSnapshot: null },
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]!.type).toBe('error');
    expect(writes[0]!.rec).toMatchObject({ reducer: 'fill_empty_text', hits: 1 });
  });

  it('无命中时不写日志', () => {
    const writes: { type: string; rec: Record<string, unknown> }[] = [];
    const config = {
      ...fakeConfig(),
      logWriter: {
        write: (type: string, rec: Record<string, unknown>) => writes.push({ type, rec }),
      },
    } as never;
    const input = [msg('user', [{ type: 'text', text: '非空' }])];
    new FillEmptyTextReducer('fill_empty_text', {}).reduce(
      emptyData,
      input,
      { config, prevSnapshot: null },
    );
    expect(writes).toHaveLength(0);
  });
});

describe('assemble_reducer — role_merge', () => {
  it('相邻同 role 合并 content blocks', () => {
    const input = [
      msg('user', 'a'),
      msg('user', 'b'),
      msg('assistant', 'c'),
    ];
    const out = new RoleMergeReducer('role_merge', {}).reduce(
      emptyData,
      input,
      { config: fakeConfig(), prevSnapshot: null },
    );
    // 合并后：1 user（a+b）+ 1 assistant
    expect(out).toHaveLength(2);
    expect(out[0]!.role).toBe('user');
    expect(out[0]!.content).toHaveLength(2);
    expect(out[1]!.role).toBe('assistant');
  });

  it('system 不合（恒独立）', () => {
    const input = [
      msg('system', 's1'),
      msg('system', 's2'),
    ];
    const out = new RoleMergeReducer('role_merge', {}).reduce(
      emptyData,
      input,
      { config: fakeConfig(), prevSnapshot: null },
    );
    expect(out).toHaveLength(2);
  });
});

describe('assemble_reducer — snip_handler', () => {
  it('message.metadata.snip=true → content 替换占位', () => {
    const input = [msg('user', [callBlock('c1')], undefined, { snip: true })];
    const out = new SnipHandlerReducer('snip_handler', {}).reduce(
      emptyData,
      input,
      { config: fakeConfig(), prevSnapshot: null },
    );
    expect(out[0]!.content).toHaveLength(1);
    expect((out[0]!.content[0] as { text: string }).text).toBe('[content snipped]');
  });

  it('无 snip 标记 → 原样保留', () => {
    const input = [msg('user', 'plain')];
    const out = new SnipHandlerReducer('snip_handler', {}).reduce(
      emptyData,
      input,
      { config: fakeConfig(), prevSnapshot: null },
    );
    expect(out[0]!.content).toHaveLength(1);
    expect((out[0]!.content[0] as { text: string }).text).toBe('plain');
  });
});

// [v0.0.66 §2.4] append_passthrough impl 已删（design §2.4）；UT 已删（forked 改走 base_builder
//   append 分支复用 prevSnapshot + in_memory store 增量，由 context-engine-forked-scope.test.ts 覆盖）。
