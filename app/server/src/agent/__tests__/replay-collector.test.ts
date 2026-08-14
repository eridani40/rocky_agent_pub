/**
 * ReplayCollector UT（v0.0.207 追加 — tool_call 重组）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_interrupt.md §3.2 §4
 *
 * 背景：中断 in-flight tool_call 后 transcript 的 assistant message 丢 tool_call
 * （v0.0.207 authority transfer 吊销 ce.ingest → ingestAssistant 没落盘；abort 收尾
 * 唯一救场 = ReplayCollector，但旧版只重组 text、忽略 tool_call）。
 * 本测试覆盖 tool_call 重组 + 原有 text/空占位行为不回归。
 *
 * 事件构造说明：tool_call_* 与 text_block_* 同走 agent-loop-stream.ts 的 evt() 构造，
 * messageId 必带，故 UT 事件均显式给 messageId。
 */
import { describe, it, expect } from 'vitest';
import { ReplayCollector } from '../replay-collector';
import type { AgentEvent } from '../agent-event-types';
import type { TextBlock, ToolCallBlock } from '../../message/types';

let seq = 0;

/** 构造一个 AgentEvent（自动填公共字段；extra 覆盖事件专属字段） */
function evt(type: AgentEvent['type'], extra: Record<string, unknown>): AgentEvent {
  return {
    id: `e${seq++}`,
    type,
    sessionId: 's1',
    createdAt: new Date().toISOString(),
    runKind: 'main',
    ...extra,
  } as unknown as AgentEvent;
}

/** message_start(assistant) 快捷构造 */
function msgStart(messageId: string, role: 'assistant' | 'user' = 'assistant'): AgentEvent {
  return evt('message_start', { messageId, role });
}

describe('ReplayCollector tool_call 重组', () => {
  it('text + 1 个完整 tool_call → 重组出 text block + tool_call block（id/name/arguments 正确）', () => {
    const c = new ReplayCollector();
    const mid = 'm1';
    c.consume(msgStart(mid));
    c.consume(evt('text_block_start', { messageId: mid, blockId: 'b1' }));
    c.consume(evt('text_block_delta', { messageId: mid, blockId: 'b1', delta: '我来查一下' }));
    c.consume(evt('text_block_end', { messageId: mid, blockId: 'b1' }));
    c.consume(evt('tool_call_start', { messageId: mid, blockId: 'b2', toolCallId: 'tc1', toolName: 'web_search' }));
    c.consume(evt('tool_call_delta', { messageId: mid, blockId: 'b2', toolCallId: 'tc1', delta: '{"que' }));
    c.consume(evt('tool_call_delta', { messageId: mid, blockId: 'b2', toolCallId: 'tc1', delta: 'ry":"天气"}' }));
    c.consume(evt('tool_call_end', { messageId: mid, blockId: 'b2', toolCallId: 'tc1' }));
    // 无 message_end（abort 打断）→ partial

    const partials = c.reconstitutePartials();
    expect(partials).toHaveLength(1);
    const p0 = partials[0]!;
    expect(p0.messageId).toBe(mid);
    expect(p0.blocks).toHaveLength(2);

    const text = p0.blocks[0] as TextBlock;
    expect(text.type).toBe('text');
    expect(text.text).toBe('我来查一下');

    const tc = p0.blocks[1] as ToolCallBlock;
    expect(tc.type).toBe('tool_call');
    expect(tc.id).toBe('tc1');
    expect(tc.name).toBe('web_search');
    expect(tc.arguments).toEqual({ query: '天气' });
    // 内部累积字段不得泄漏到产出 block
    expect('_order' in tc).toBe(false);
    expect('_argumentsBuf' in tc).toBe(false);
  });

  it('多个 tool_call（4 个 write）→ 全部重组出，顺序按事件到达序', () => {
    const c = new ReplayCollector();
    const mid = 'm1';
    c.consume(msgStart(mid));
    for (let i = 0; i < 4; i++) {
      const bid = `b${i}`;
      c.consume(evt('tool_call_start', { messageId: mid, blockId: bid, toolCallId: `tc${i}`, toolName: 'write' }));
      c.consume(evt('tool_call_delta', { messageId: mid, blockId: bid, toolCallId: `tc${i}`, delta: `{"path":"f${i}.txt"}` }));
      c.consume(evt('tool_call_end', { messageId: mid, blockId: bid, toolCallId: `tc${i}` }));
    }

    const partials = c.reconstitutePartials();
    expect(partials).toHaveLength(1);
    expect(partials[0]!.blocks).toHaveLength(4);
    partials[0]!.blocks.forEach((b, i) => {
      const tc = b as ToolCallBlock;
      expect(tc.type).toBe('tool_call');
      expect(tc.id).toBe(`tc${i}`);
      expect(tc.name).toBe('write');
      expect(tc.arguments).toEqual({ path: `f${i}.txt` });
    });
  });

  it('半截 tool_call（start+delta 无 end，buf 恰好是完整 JSON）→ 容错重组出', () => {
    const c = new ReplayCollector();
    const mid = 'm1';
    c.consume(msgStart(mid));
    c.consume(evt('tool_call_start', { messageId: mid, blockId: 'b1', toolCallId: 'tc1', toolName: 'read' }));
    c.consume(evt('tool_call_delta', { messageId: mid, blockId: 'b1', toolCallId: 'tc1', delta: '{"path":"a.ts"}' }));
    // abort 打断：无 tool_call_end、无 message_end

    const partials = c.reconstitutePartials();
    expect(partials).toHaveLength(1);
    const tc = partials[0]!.blocks[0] as ToolCallBlock;
    expect(tc.type).toBe('tool_call');
    expect(tc.id).toBe('tc1');
    expect(tc.name).toBe('read');
    expect(tc.arguments).toEqual({ path: 'a.ts' });
  });

  it('半截 tool_call（start+delta 无 end，buf 是不完整 JSON）→ arguments 兜底 {_raw, _rawTruncated:true}', () => {
    const c = new ReplayCollector();
    const mid = 'm1';
    c.consume(msgStart(mid));
    c.consume(evt('tool_call_start', { messageId: mid, blockId: 'b1', toolCallId: 'tc1', toolName: 'write' }));
    c.consume(evt('tool_call_delta', { messageId: mid, blockId: 'b1', toolCallId: 'tc1', delta: '{"path":"a.ts","cont' }));

    const partials = c.reconstitutePartials();
    expect(partials).toHaveLength(1);
    const tc = partials[0]!.blocks[0] as ToolCallBlock;
    expect(tc.type).toBe('tool_call');
    // [v0.0.331 P1'] _rawTruncated 标记（前端 D3 显示「发送失败（参数截断）」）
    expect(tc.arguments).toEqual({ _raw: '{"path":"a.ts","cont', _rawTruncated: true });
  });

  it('tool_call_start 后零 delta（无 buf）→ arguments 兜底 {}', () => {
    const c = new ReplayCollector();
    const mid = 'm1';
    c.consume(msgStart(mid));
    c.consume(evt('tool_call_start', { messageId: mid, blockId: 'b1', toolCallId: 'tc1', toolName: 'ls' }));

    const partials = c.reconstitutePartials();
    expect(partials).toHaveLength(1);
    const tc = partials[0]!.blocks[0] as ToolCallBlock;
    expect(tc.type).toBe('tool_call');
    expect(tc.name).toBe('ls');
    expect(tc.arguments).toEqual({});
  });

  it('[v0.0.331 P1] send_message 缺 type 的 arguments → 落库后 content 补 type:"text"（缺 type 不空白）', () => {
    const c = new ReplayCollector();
    const mid = 'm1';
    c.consume(msgStart(mid));
    c.consume(evt('tool_call_start', { messageId: mid, blockId: 'b1', toolCallId: 'tc1', toolName: 'send_message' }));
    c.consume(evt('tool_call_delta', { messageId: mid, blockId: 'b1', toolCallId: 'tc1', delta: '{"target":"leader","content":[{"text":"hi"}]}' }));
    c.consume(evt('tool_call_end', { messageId: mid, blockId: 'b1', toolCallId: 'tc1' }));

    const partials = c.reconstitutePartials();
    expect(partials).toHaveLength(1);
    const tc = partials[0]!.blocks[0] as ToolCallBlock;
    expect(tc.type).toBe('tool_call');
    expect(tc.name).toBe('send_message');
    // 缺 type 的 block 被 normalize 补 type:'text'（前端 envelope 提取不再空白）
    expect(tc.arguments).toEqual({
      target: 'leader',
      content: [{ type: 'text', text: 'hi' }],
    });
  });

  it('[v0.0.331 P1] send_message 半截 _raw（解析失败）→ 不 normalize（保留 _raw + _rawTruncated）', () => {
    const c = new ReplayCollector();
    const mid = 'm1';
    c.consume(msgStart(mid));
    c.consume(evt('tool_call_start', { messageId: mid, blockId: 'b1', toolCallId: 'tc1', toolName: 'send_message' }));
    c.consume(evt('tool_call_delta', { messageId: mid, blockId: 'b1', toolCallId: 'tc1', delta: '{"target":"leader","cont' }));

    const partials = c.reconstitutePartials();
    expect(partials).toHaveLength(1);
    const tc = partials[0]!.blocks[0] as ToolCallBlock;
    expect(tc.name).toBe('send_message');
    // _raw 半截路径：不补 content，保留标记
    expect(tc.arguments).toEqual({ _raw: '{"target":"leader","cont', _rawTruncated: true });
  });
});

describe('ReplayCollector 现状回归', () => {
  it('纯 text（无 tool_call）→ 现状不回归', () => {
    const c = new ReplayCollector();
    const mid = 'm1';
    c.consume(msgStart(mid));
    c.consume(evt('text_block_start', { messageId: mid, blockId: 'b1' }));
    c.consume(evt('text_block_delta', { messageId: mid, blockId: 'b1', delta: '你好' }));
    c.consume(evt('text_block_delta', { messageId: mid, blockId: 'b1', delta: '世界' }));
    c.consume(evt('text_block_end', { messageId: mid, blockId: 'b1' }));

    const partials = c.reconstitutePartials();
    expect(partials).toHaveLength(1);
    expect(partials[0]!.blocks).toHaveLength(1);
    const text = partials[0]!.blocks[0] as TextBlock;
    expect(text.type).toBe('text');
    expect(text.text).toBe('你好世界');
  });

  it('空 partial（message_start 后无 block）→ 占位保留', () => {
    const c = new ReplayCollector();
    c.consume(msgStart('m1'));

    const partials = c.reconstitutePartials();
    expect(partials).toHaveLength(1);
    expect(partials[0]!.messageId).toBe('m1');
    expect(partials[0]!.blocks).toEqual([]);
  });

  it('message_end 正常关闭 → 不产生 partial', () => {
    const c = new ReplayCollector();
    const mid = 'm1';
    c.consume(msgStart(mid));
    c.consume(evt('text_block_start', { messageId: mid, blockId: 'b1' }));
    c.consume(evt('text_block_delta', { messageId: mid, blockId: 'b1', delta: '完整消息' }));
    c.consume(evt('text_block_end', { messageId: mid, blockId: 'b1' }));
    c.consume(evt('tool_call_start', { messageId: mid, blockId: 'b2', toolCallId: 'tc1', toolName: 'read' }));
    c.consume(evt('tool_call_end', { messageId: mid, blockId: 'b2', toolCallId: 'tc1' }));
    c.consume(evt('message_end', { messageId: mid }));

    expect(c.reconstitutePartials()).toHaveLength(0);
  });

  it('user role 的 partial 被过滤（user 消息已由 loop 落库）', () => {
    const c = new ReplayCollector();
    c.consume(msgStart('m-user', 'user'));
    c.consume(evt('text_block_start', { messageId: 'm-user', blockId: 'b1' }));
    c.consume(evt('text_block_delta', { messageId: 'm-user', blockId: 'b1', delta: '用户输入' }));

    expect(c.reconstitutePartials()).toHaveLength(0);
  });
});
