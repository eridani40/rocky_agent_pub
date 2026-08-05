/**
 * [v0.0.148 链路 A] encodeAnthropicMessages effort 注入单测（白盒）
 * 参考: specs/tech/version_logs/v0.0.148/change_plan.md 链路 A
 *       specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §3.5
 *
 * 覆盖（canonical effort → anthropic wire output_config.effort）：
 *   - default 档不加 output_config 字段（= 厂商默认行为，非传字面 "default"）
 *   - undefined（缺省）不加 output_config 字段（向后兼容）
 *   - low → output_config.effort = 'low'
 *   - high → output_config.effort = 'high'
 *   - max → output_config.effort = 'max'
 *   - 与其它 params 字段（temperature/stop）共存不互相干扰
 */
import { describe, it, expect } from 'vitest';
import AnthropicMessagesProtocol from '../protocol';
import type { CanonicalRequest } from '../../../../server/src/llm/protocol';

function makeRequest(
  params: CanonicalRequest['params'],
): CanonicalRequest {
  return {
    modelId: 'claude-sonnet-4-6',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
    params,
  };
}

describe('encodeAnthropicMessages effort 注入 (v0.0.148 链路 A)', () => {
  it("default 档不加 output_config（= 厂商默认行为）", () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(makeRequest({ maxTokens: 100, effort: 'default' })) as Record<
      string,
      unknown
    >;
    expect(wire['output_config']).toBeUndefined();
  });

  it('undefined（缺省）不加 output_config（向后兼容）', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(makeRequest({ maxTokens: 100 })) as Record<string, unknown>;
    expect(wire['output_config']).toBeUndefined();
  });

  it("low → output_config.effort = 'low'", () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(makeRequest({ maxTokens: 100, effort: 'low' })) as Record<
      string,
      unknown
    >;
    expect(wire['output_config']).toEqual({ effort: 'low' });
  });

  it("high → output_config.effort = 'high'", () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(makeRequest({ maxTokens: 100, effort: 'high' })) as Record<
      string,
      unknown
    >;
    expect(wire['output_config']).toEqual({ effort: 'high' });
  });

  it("max → output_config.effort = 'max'", () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(makeRequest({ maxTokens: 100, effort: 'max' })) as Record<
      string,
      unknown
    >;
    expect(wire['output_config']).toEqual({ effort: 'max' });
  });

  it('effort 与 stop/temperature 共存不互相干扰', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({ maxTokens: 100, temperature: 0.7, stop: ['<EOS>'], effort: 'high' }),
    ) as Record<string, unknown>;
    expect(wire['output_config']).toEqual({ effort: 'high' });
    expect(wire['stop_sequences']).toEqual(['<EOS>']);
    expect(wire['temperature']).toBe(0.7);
    expect(wire['max_tokens']).toBe(100);
  });

  it('effort=default 与 stop 共存时仍不加 output_config', () => {
    const p = new AnthropicMessagesProtocol('anthropic_messages', {});
    const wire = p.encode(
      makeRequest({ maxTokens: 100, stop: ['<EOS>'], effort: 'default' }),
    ) as Record<string, unknown>;
    expect(wire['output_config']).toBeUndefined();
    expect(wire['stop_sequences']).toEqual(['<EOS>']);
  });
});
