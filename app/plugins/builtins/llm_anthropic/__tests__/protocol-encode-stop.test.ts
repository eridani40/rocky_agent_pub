/**
 * [v0.0.33.2 T4] AnthropicMessagesProtocol.encode stop_sequences 单测（白盒）
 * 参考: specs/tech/version_logs/v0.0.33.2/change_log.md §2.E（EOS 双保险）
 *       specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §3.5
 *
 * 覆盖（架构 §7 风险1：provider stop seq 兼容）：
 *   - params.stop → wire stop_sequences（Anthropic）
 *   - params.stop 缺省 / 空数组 → 不加 stop_sequences 字段（对齐既有行为）
 *
 * 注：本仓库仅一个 LLM protocol impl（encodeAnthropicMessages，所有 provider 包括
 *   anthropic_compatible 的 DeepSeek/GPT/Gemini-兼容 API 都走它）。故此处覆盖 = 全 provider 覆盖。
 */
import { describe, it, expect } from 'vitest';
import AnthropicMessagesProtocol from '../protocol';
import type { CanonicalRequest } from '../../../../server/src/llm/protocol';

function makeRequest(params: CanonicalRequest['params']): CanonicalRequest {
  return {
    modelId: 'claude-sonnet-4-6',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
    params,
  };
}

describe('AnthropicMessagesProtocol.encode stop_sequences (v0.0.33.2 T4)', () => {
  it('maps params.stop → wire stop_sequences', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(makeRequest({ maxTokens: 100, stop: ['<EOS>'] })) as Record<
      string,
      unknown
    >;
    expect(wire['stop_sequences']).toEqual(['<EOS>']);
  });

  it('maps multi-element stop array preserving order', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({ maxTokens: 100, stop: ['<EOS>', '\\n\\nDONE'] }),
    ) as Record<string, unknown>;
    expect(wire['stop_sequences']).toEqual(['<EOS>', '\\n\\nDONE']);
  });

  it('omits stop_sequences when params.stop is undefined', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(makeRequest({ maxTokens: 100 })) as Record<string, unknown>;
    expect(wire['stop_sequences']).toBeUndefined();
  });

  it('omits stop_sequences when params.stop is empty array', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(makeRequest({ maxTokens: 100, stop: [] })) as Record<
      string,
      unknown
    >;
    expect(wire['stop_sequences']).toBeUndefined();
  });

  it('coexists with temperature/topP (其它 params 字段不受影响)', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({ maxTokens: 100, temperature: 0.7, topP: 0.9, stop: ['<EOS>'] }),
    ) as Record<string, unknown>;
    expect(wire['stop_sequences']).toEqual(['<EOS>']);
    expect(wire['temperature']).toBe(0.7);
    expect(wire['top_p']).toBe(0.9);
    expect(wire['max_tokens']).toBe(100);
    expect(wire['stream']).toBe(false);
  });

  it('RequestParams.stop 透传到 wire（端到端契约）', () => {
    // 验证 CanonicalRequest.params.stop 字段是 RequestParams 的合法成员（TS 类型层已保证，
    // 这里运行时再验一次：encode 不丢字段、不改值）
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const stopSeq = ['<EOS>'];
    const wire = p.encode(makeRequest({ maxTokens: 50, stop: stopSeq })) as Record<
      string,
      unknown
    >;
    // wire.stop_sequences 与传入数组内容一致（非同引用也可，内容相等即透传成功）
    expect(wire['stop_sequences']).toEqual(stopSeq);
  });
});
