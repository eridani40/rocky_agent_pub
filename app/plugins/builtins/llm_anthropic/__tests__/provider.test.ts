/**
 * AnthropicCompatibleProvider 单测（白盒）—— buildAuthHeaders 无状态翻译
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_provider_interface.md §2/§3.1
 *       specs/research/v0.0.3-anthropic-protocol.md §1（headers）
 *
 * v0.0.191：随 impl 迁入 plugin（原 app/server/src/llm/__tests__/provider.test.ts）。
 * 设计（provider §3.1）：impl 无状态，config 作参数传入；header 读 config.credentials.key。
 */
import { describe, it, expect } from 'vitest';
import AnthropicCompatibleProvider from '../provider';
import type { LlmProviderConfig } from '../../../../server/src/llm/provider-types';

function makeConfig(overrides: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    id: 'p1',
    name: 'anthropic_compatible',
    protocolId: 'anthropic_messages',
    baseUrl: 'https://api.anthropic.com',
    credentials: { key: 'sk-ant-test' },
    pluginId: 'builtin.anthropic',
    enabled: true,
    models: [],
    ...overrides,
  };
}

describe('AnthropicCompatibleProvider.buildAuthHeaders', () => {
  it('returns x-api-key + anthropic-version from config.credentials.key', () => {
    const p = new AnthropicCompatibleProvider('anthropic_compatible', {});
    const h = p.buildAuthHeaders(makeConfig());
    expect(h).toEqual({
      'x-api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
    });
  });

  it('is stateless: same config returns same headers across instances', () => {
    const cfg = makeConfig({ credentials: { key: 'k-A' } });
    const p1 = new AnthropicCompatibleProvider('anthropic_compatible', {});
    const p2 = new AnthropicCompatibleProvider('anthropic_compatible', {});
    expect(p1.buildAuthHeaders(cfg)).toEqual(p2.buildAuthHeaders(cfg));
  });

  it('reflects different credentials without rebuilding impl', () => {
    const p = new AnthropicCompatibleProvider('anthropic_compatible', {});
    const a = p.buildAuthHeaders(makeConfig({ credentials: { key: 'k-A' } }));
    const b = p.buildAuthHeaders(makeConfig({ credentials: { key: 'k-B' } }));
    expect(a['x-api-key']).toBe('k-A');
    expect(b['x-api-key']).toBe('k-B');
  });
});
