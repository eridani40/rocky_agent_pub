/**
 * rocky_context plugin — clean_view_reducer: bubble_text_before_tool_call 单测
 * 参考: specs/tech/version_logs/v0.0.256/change_plan.md（拍板 1-3）
 *       specs/tech/agent/context/[P0]context_assemble_detail.md §5b
 *
 * 覆盖（change_plan UT 9 点）：
 *   ① text 冒泡到所有 tool_call 前
 *   ② 多 tool_call 相对顺序不变
 *   ③ 无 tool_call 不动（返原引用）
 *   ④ text 已在最前不动（返原引用）
 *   ⑤ 空/纯空白 text 丢弃（不删 message，交 empty_message 兜底）
 *   ⑥ reasoning 保持最前
 *   ⑦ 非 assistant message 不动（user/tool/system 原样透传）
 *   ⑧ 不可变（input 引用与内容不变）+ input===null → []
 *   ⑨ prod 实证形状 [text,tc(_raw),text,tc] 经 orphan+bubble 串行后 text 全部在 tc 前
 */
import { describe, it, expect } from 'vitest';
import { ulid } from '../../../../server/src/config/ulid';
import type { ContentBlock, Message } from '../../../../server/src/message/types';
import BubbleTextBeforeToolCallReducer from '../assemble/bubble_text_before_tool_call';
import OrphanToolCallReducer from '../assemble/orphan_tool_call';

/** 造假 config（本 reducer 不读 config，占位满足签名） */
function fakeConfig() {
  return { sessionId: 'sid-bubble' } as never;
}

const emptyData = { transcript: [], summary: null } as never;

function fakeCtx() {
  return { config: fakeConfig(), prevSnapshot: null, ratio: 1 };
}

/** 造 message（默认 assistant） */
function msg(role: Message['role'], content: ContentBlock[], id?: string): Message {
  return {
    id: id ?? ulid(),
    sessionId: 'sid-bubble',
    role,
    content,
  };
}

/** text block 简写 */
function text(t: string): ContentBlock {
  return { type: 'text', text: t };
}

/** tool_call block 简写（args 可传 {_raw} 模拟 stall 半截落库形状） */
function tc(id: string, args: Record<string, unknown> = {}): ContentBlock {
  return { type: 'tool_call', id, name: 'bash', arguments: args };
}

/** reasoning block 简写（ReasoningBlock 字段为 text） */
function reasoning(t: string): ContentBlock {
  return { type: 'reasoning', text: t };
}

/** 取 message content 的 block type 序列（断块序用） */
function typeSeq(m: Message): string[] {
  return m.content.map((b) => b.type);
}

describe('[v0.0.256] bubble_text_before_tool_call reducer', () => {
  it('① text 冒泡到所有 tool_call 前（[tc,text] → [text,tc]）', () => {
    const input: Message[] = [
      msg('assistant', [tc('c1'), text('hello')]),
    ];
    const reducer = new BubbleTextBeforeToolCallReducer('bubble_text_before_tool_call', {});
    const out = reducer.reduce(emptyData, input, fakeCtx());
    expect(typeSeq(out[0])).toEqual(['text', 'tool_call']);
    expect((out[0].content[0] as { text: string }).text).toBe('hello');
  });

  it('② 多 tool_call 相对顺序不变（[tc1,text,tc2,text2] → [text,text2,tc1,tc2]）', () => {
    const input: Message[] = [
      msg('assistant', [tc('c1'), text('t1'), tc('c2'), text('t2')]),
    ];
    const reducer = new BubbleTextBeforeToolCallReducer('bubble_text_before_tool_call', {});
    const out = reducer.reduce(emptyData, input, fakeCtx());
    expect(typeSeq(out[0])).toEqual(['text', 'text', 'tool_call', 'tool_call']);
    // 桶内保原相对顺序：tc1 在 tc2 前；t1 在 t2 前；不合并 text
    expect((out[0].content[2] as { id: string }).id).toBe('c1');
    expect((out[0].content[3] as { id: string }).id).toBe('c2');
    expect((out[0].content[0] as { text: string }).text).toBe('t1');
    expect((out[0].content[1] as { text: string }).text).toBe('t2');
  });

  it('③ 无 tool_call 不动（[text,text] 原样，返原 message 引用）', () => {
    const input: Message[] = [
      msg('assistant', [text('t1'), text('t2')]),
    ];
    const reducer = new BubbleTextBeforeToolCallReducer('bubble_text_before_tool_call', {});
    const out = reducer.reduce(emptyData, input, fakeCtx());
    expect(out).toBe(input); // 全链无变化返原数组引用
    expect(out[0]).toBe(input[0]);
  });

  it('④ text 已在最前不动（[text,tc] 已合法，返原引用）', () => {
    const input: Message[] = [
      msg('assistant', [text('t1'), tc('c1')]),
    ];
    const reducer = new BubbleTextBeforeToolCallReducer('bubble_text_before_tool_call', {});
    const out = reducer.reduce(emptyData, input, fakeCtx());
    expect(out).toBe(input);
    expect(out[0].content).toBe(input[0].content); // content 数组引用也不变
  });

  it('⑤ 空/纯空白 text 丢弃（不删 message，空 content 交 empty_message 兜底）', () => {
    const input: Message[] = [
      msg('assistant', [text(''), tc('c1'), text('   '), text('real')], 'm1'),
      msg('assistant', [text('')], 'm2'), // 全丢空 → content=[]，message 保留
    ];
    const reducer = new BubbleTextBeforeToolCallReducer('bubble_text_before_tool_call', {});
    const out = reducer.reduce(emptyData, input, fakeCtx());
    // m1：两个空 text 丢弃，real 冒泡到 tc 前
    expect(typeSeq(out[0])).toEqual(['text', 'tool_call']);
    expect((out[0].content[0] as { text: string }).text).toBe('real');
    // m2：空 text 丢弃后 content 空，message 不删（reducer 不删 message）
    expect(out).toHaveLength(2);
    expect(out[1].id).toBe('m2');
    expect(out[1].content).toHaveLength(0);
  });

  it('⑥ reasoning 保持最前（[text,reasoning,tc] → [reasoning,text,tc]）', () => {
    const input: Message[] = [
      msg('assistant', [text('t1'), reasoning('r1'), tc('c1')]),
    ];
    const reducer = new BubbleTextBeforeToolCallReducer('bubble_text_before_tool_call', {});
    const out = reducer.reduce(emptyData, input, fakeCtx());
    expect(typeSeq(out[0])).toEqual(['reasoning', 'text', 'tool_call']);
  });

  it('⑦ 非 assistant message 不动（user/tool/system 原样透传，即便块序乱）', () => {
    // tool message content 里即便有怪异顺序也绝不触碰（message 级邻接归 orphan）
    const toolMsg = msg('tool', [
      { type: 'tool_result', toolCallId: 'c1', content: [text('out')], isError: false },
    ]);
    const userMsg = msg('user', [text('u1')]);
    const systemMsg = msg('system', [text('s1')]);
    const input: Message[] = [userMsg, toolMsg, systemMsg];
    const reducer = new BubbleTextBeforeToolCallReducer('bubble_text_before_tool_call', {});
    const out = reducer.reduce(emptyData, input, fakeCtx());
    expect(out).toBe(input); // 无 assistant → 全链返原数组引用
    expect(out[0]).toBe(userMsg);
    expect(out[1]).toBe(toolMsg);
    expect(out[2]).toBe(systemMsg);
  });

  it('⑧ 不可变（input 引用与内容不变）+ input===null → []', () => {
    const originalContent: ContentBlock[] = [tc('c1'), text('t1')];
    const input: Message[] = [msg('assistant', originalContent)];
    const reducer = new BubbleTextBeforeToolCallReducer('bubble_text_before_tool_call', {});
    const out = reducer.reduce(emptyData, input, fakeCtx());
    // 变更路径：返新数组 + 新 message 对象 + 新 content 数组
    expect(out).not.toBe(input);
    expect(out[0]).not.toBe(input[0]);
    expect(out[0].content).not.toBe(originalContent);
    // 原 input 未被 mutate（仍 [tc,text] 序）
    expect(input[0].content).toBe(originalContent);
    expect(typeSeq(input[0])).toEqual(['tool_call', 'text']);
    // block 对象本身复用（不克隆 block）
    expect(out[0].content[0]).toBe(originalContent[1]);
    expect(out[0].content[1]).toBe(originalContent[0]);
    // null → []
    expect(reducer.reduce(emptyData, null, fakeCtx())).toEqual([]);
  });

  it('⑨ prod 实证形状 [text,tc(_raw),text,tc] 经 orphan+bubble 串行后 text 全部在 tc 前', () => {
    // 复刻 256.log message 01KZ6AK4K9GZWB88QGBPCK5JXH：stall 半截 tc(KlF,{_raw}) + prefill 续写 text+tc(feNX)
    // 两条 tc 均配对（下条 tool message 双 result）→ orphan 全保留、bubble 冒泡 text
    const halfCall = tc('KlF', { _raw: '{"command":"ls' }); // 半截 tool_call（arguments 为 {_raw}）
    const fullCall = tc('feNX', { command: 'ls -la' });
    const assistant = msg('assistant', [text('先查一下'), halfCall, text('继续执行'), fullCall]);
    const toolMsg = msg('tool', [
      { type: 'tool_result', toolCallId: 'KlF', content: [text('invalid_input')], isError: true },
      { type: 'tool_result', toolCallId: 'feNX', content: [text('file1 file2')], isError: false },
    ]);
    const input: Message[] = [assistant, toolMsg];
    const ctx = fakeCtx();
    const orphan = new OrphanToolCallReducer('orphan_tool_call', {});
    const bubble = new BubbleTextBeforeToolCallReducer('bubble_text_before_tool_call', {});
    const afterOrphan = orphan.reduce(emptyData, input, ctx);
    // orphan：双 tc 均配对 → 全保留（块序不动）
    expect(afterOrphan.flatMap((m) => m.content).filter((b) => b.type === 'tool_call')).toHaveLength(2);
    const afterBubble = bubble.reduce(emptyData, afterOrphan, ctx);
    // bubble 后：assistant content = [text, text, tc, tc]（text 全部在 tc 前，不再有 text 夹 tc 中间）
    const outAssistant = afterBubble.find((m) => m.role === 'assistant')!;
    expect(typeSeq(outAssistant)).toEqual(['text', 'text', 'tool_call', 'tool_call']);
    // 块序合法性口径：最后一个 text 的 index < 第一个 tool_call 的 index
    const types = typeSeq(outAssistant);
    expect(types.lastIndexOf('text')).toBeLessThan(types.indexOf('tool_call'));
    // tool message 不受影响
    const outTool = afterBubble.find((m) => m.role === 'tool')!;
    expect(outTool.content).toHaveLength(2);
  });
});
