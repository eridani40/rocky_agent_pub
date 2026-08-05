/**
 * AnthropicMessagesProtocol.parse 单测（白盒）—— wire 响应 → canonical
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §2
 *       specs/research/v0.0.3-anthropic-protocol.md §2
 */
import { describe, it, expect } from 'vitest';
import AnthropicMessagesProtocol from '../protocol';

const p = new AnthropicMessagesProtocol('anthropic_messages', {});

describe('AnthropicMessagesProtocol.parse', () => {
  it('maps text content block + stop_reason end_turn → stop', () => {
    const resp = p.parse({
      status: 200,
      body: {
        id: 'msg_01',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: '最终回答' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 320, output_tokens: 12 },
      },
    });
    expect(resp.message.role).toBe('assistant');
    expect(resp.message.content).toEqual([{ type: 'text', text: '最终回答' }]);
    expect(resp.stopReason).toBe('stop');
    // anthropic wire usage 翻译为 spec Usage 字段（parseAnthropicUsage）
    expect(resp.usage).toMatchObject({
      input_no_cache: 320,
      output_response: 12,
      input_total_tokens: 320,
      output_total_tokens: 12,
      total_tokens: 332,
    });
  });

  it('maps stop_reason max_tokens → max_tokens', () => {
    const resp = p.parse({
      status: 200,
      body: {
        id: 'm',
        content: [{ type: 'text', text: '' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });
    expect(resp.stopReason).toBe('max_tokens');
  });

  it('maps stop_reason tool_use → tool_use', () => {
    const resp = p.parse({
      status: 200,
      body: {
        id: 'm',
        content: [{ type: 'tool_use', id: 't1', name: 'f', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });
    expect(resp.stopReason).toBe('tool_use');
    expect(resp.message.content[0]).toMatchObject({ type: 'tool_use', name: 'f' });
  });

  it('preserves thinking block in content[]', () => {
    const resp = p.parse({
      status: 200,
      body: {
        id: 'm',
        content: [
          { type: 'thinking', thinking: '思', signature: 'sig' },
          { type: 'text', text: '答' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });
    expect(resp.message.content.map((b) => b.type)).toEqual([
      'thinking',
      'text',
    ]);
  });
});
