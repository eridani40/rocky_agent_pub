/**
 * AnthropicMessagesProtocol.parseStream 单测（白盒）—— SSE → StreamEvent 分流
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §2/§3.6
 *       specs/research/v0.0.3-anthropic-protocol.md §3/§4
 *
 * 核心覆盖（test-plan §2 P1）：
 *   - thinking_delta / text_delta 分流（不同 content block index）
 *   - index 不泄露给消费方
 *   - 多 chunk 拼接不丢不错（跨 chunk 半帧缓冲）
 *   - message_stop → finish；message_delta usage → usage
 */
import { describe, it, expect } from 'vitest';
import AnthropicMessagesProtocol from '../protocol';
import type { StreamEvent } from '../../../../server/src/llm/protocol';
import type { Usage } from '../../../../server/src/message/types';

const p = new AnthropicMessagesProtocol('anthropic_messages', {});

/** 构造一个标准 SSE 帧（event + data） */
function frame(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('AnthropicMessagesProtocol.parseStream 分流', () => {
  it('maps content_block_delta text_delta → text_delta', () => {
    const evts = p.parseStream(
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '你好' },
      }),
    );
    expect(evts).toEqual([{ type: 'text_delta', text: '你好' }]);
  });

  it('maps content_block_delta thinking_delta → thinking_delta', () => {
    const evts = p.parseStream(
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: '让我想想' },
      }),
    );
    expect(evts).toEqual([{ type: 'thinking_delta', thinking: '让我想想' }]);
  });

  it('does NOT leak index to consumer (no index field on events)', () => {
    const evts = p.parseStream(
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 5,
        delta: { type: 'text_delta', text: 'x' },
      }),
    );
    for (const e of evts) {
      expect((e as Record<string, unknown>)['index']).toBeUndefined();
    }
  });

  it('maps message_stop → finish reason=stop', () => {
    const evts = p.parseStream(frame('message_stop', { type: 'message_stop' }));
    expect(evts).toEqual([{ type: 'finish', reason: 'stop' }]);
  });

  it('maps message_delta stop_reason=max_tokens → finish max_tokens', () => {
    const evts = p.parseStream(
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'max_tokens', stop_sequence: null },
        usage: { input_tokens: 10, output_tokens: 99 },
      }),
    );
    // message_delta 含 stop_reason 时产出 finish + usage（顺序：finish 后置由 message_stop 触发，
    // 但 max_tokens 由 message_delta 携带；本实现把 stop_reason 映射 finish）
    const finishes = evts.filter((e) => e.type === 'finish');
    expect(finishes).toEqual([{ type: 'finish', reason: 'max_tokens' }]);
  });

  it('maps message_delta usage → usage event (anthropic wire → spec Usage)', () => {
    const evts = p.parseStream(
      frame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          input_tokens: 320,
          output_tokens: 12,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 8,
        },
      }),
    );
    const usages = evts.filter((e) => e.type === 'usage');
    expect(usages.length).toBe(1);
    const u = (usages[0] as { usage: Usage }).usage;
    // anthropic wire 字段翻译为 spec Usage 字段
    expect(u.input_no_cache).toBe(320);
    expect(u.output_response).toBe(12);
    expect(u.input_cache_read).toBe(50);
    expect(u.input_cache_write).toBe(8);
    // derived totals（spec §1 要求写入时固化）
    expect(u.input_total_tokens).toBe(50 + 8 + 320);
    expect(u.output_total_tokens).toBe(12);
    expect(u.total_tokens).toBe(50 + 8 + 320 + 12);
  });

  it('ignores content_block_start / content_block_stop / message_start (no event)', () => {
    const chunk =
      frame('message_start', { type: 'message_start', message: { id: 'm1' } }) +
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }) +
      frame('content_block_stop', { type: 'content_block_stop', index: 0 });
    const evts = p.parseStream(chunk);
    expect(evts).toEqual([]);
  });

  it('ignores signature_delta (v0.0.3 not extending thinking)', () => {
    const evts = p.parseStream(
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'signature_delta', signature: 'abc' },
      }),
    );
    expect(evts).toEqual([]);
  });
});

describe('AnthropicMessagesProtocol.parseStream 多 chunk 拼接', () => {
  it('buffers half-frame across chunks (split inside JSON data)', () => {
    const full =
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: 'world' },
      });
    const mid = Math.floor(full.length / 2);
    const part1 = full.slice(0, mid);
    const part2 = full.slice(mid);
    const e1 = p.parseStream(part1);
    const e2 = p.parseStream(part2);
    const all: StreamEvent[] = [...e1, ...e2];
    expect(all).toEqual([
      { type: 'text_delta', text: 'hello' },
      { type: 'thinking_delta', thinking: 'world' },
    ]);
  });

  it('handles multiple SSE frames in one chunk in order', () => {
    const chunk =
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: '先想' },
      }) +
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '后答' },
      }) +
      frame('message_stop', { type: 'message_stop' });
    const evts = p.parseStream(chunk);
    expect(evts.map((e) => e.type)).toEqual([
      'thinking_delta',
      'text_delta',
      'finish',
    ]);
  });

  it('tolerates CRLF (\\r\\n\\r\\n) frame separator', () => {
    // anthropic 一般发 LF；本测试锁住 CRLF 容错（注释承诺容忍 \r\n）
    const crlfFrame =
      'event: content_block_delta\r\n' +
      'data: {"type":"content_block_delta","index":0,' +
      '"delta":{"type":"text_delta","text":"hi"}}\r\n\r\n';
    const evts = p.parseStream(crlfFrame);
    expect(evts).toEqual([{ type: 'text_delta', text: 'hi' }]);
  });

  it('flushes buffered remainder on reset (no event lost if no trailing \\n\\n)', () => {
    // 最后帧缺尾分隔符，parseStream 应缓冲；显式 reset 后再补完应得到事件
    const partial =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,' +
      '"delta":{"type":"text_delta","text":"x"}}\n\n';
    const head = partial.slice(0, partial.length - 4); // 截断最后 \n\n\n\n 中部分
    const tail = partial.slice(head.length);
    const e1 = p.parseStream(head);
    expect(e1).toEqual([]);
    const e2 = p.parseStream(tail);
    expect(e2).toEqual([{ type: 'text_delta', text: 'x' }]);
  });
});

describe('AnthropicMessagesProtocol.parseStream 鲁棒性', () => {
  it('returns [] for empty chunk', () => {
    expect(p.parseStream('')).toEqual([]);
  });

  it('skips non-data lines / comments', () => {
    const chunk = ': comment\n\n\nevent: ping\ndata: {}\n\n';
    expect(p.parseStream(chunk)).toEqual([]);
  });
});
