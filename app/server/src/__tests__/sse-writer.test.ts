/**
 * sse-writer 单测 — StreamEvent 序列化为 SSE 帧（specs/api/overall/02-llm-chat.md §3.3）
 *
 * 校验点：
 *   - thinking_delta → `event: thinking_delta\ndata: {...}\n\n`
 *   - text_delta → `event: text_delta\ndata: {...}\n\n`
 *   - usage → 同形
 *   - finish → 同形，reason 保留
 *   - data 是 JSON 紧凑序列化（无多余空格）
 */
import { describe, it, expect } from 'vitest';
import { serializeStreamEvent } from '../sse-writer';

describe('sse-writer.serializeStreamEvent', () => {
  it('thinking_delta 序列化为 SSE 帧', () => {
    const frame = serializeStreamEvent({ type: 'thinking_delta', thinking: '让我想想' });
    expect(frame).toBe('event: thinking_delta\ndata: {"type":"thinking_delta","thinking":"让我想想"}\n\n');
  });

  it('text_delta 序列化为 SSE 帧', () => {
    const frame = serializeStreamEvent({ type: 'text_delta', text: '你好' });
    expect(frame).toBe('event: text_delta\ndata: {"type":"text_delta","text":"你好"}\n\n');
  });

  it('usage 序列化为 SSE 帧', () => {
    const frame = serializeStreamEvent({ type: 'usage', usage: { input_no_cache: 10, output_total_tokens: 5 } });
    expect(frame).toBe('event: usage\ndata: {"type":"usage","usage":{"input_no_cache":10,"output_total_tokens":5}}\n\n');
  });

  it('finish 序列化为 SSE 帧（reason 保留）', () => {
    const frame = serializeStreamEvent({ type: 'finish', reason: 'stop' });
    expect(frame).toBe('event: finish\ndata: {"type":"finish","reason":"stop"}\n\n');
  });
});
