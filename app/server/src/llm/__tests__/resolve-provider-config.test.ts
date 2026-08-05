/**
 * resolveProviderConfig 单测（白盒）—— deepMerge 代码默认 ⊕ app_config（app 高）
 * 参考: states/v0.0.3/verify/test-plan.md §1（P2 路径：config 聚合 overlay）
 *       specs/tech/config/[P0]app_config.md（providers 组稀疏 delta）
 *
 * 设计（test-plan §1 / configAggregation）：
 *   - 代码默认 = builtin provider ExtImpl configSchema default（无状态）
 *   - app_config = 用户存入的稀疏 delta
 *   - app 最高级：用户 apiKey / baseUrl 覆盖代码默认空值
 *   - modelConfig 同理聚合
 */
import { describe, it, expect } from 'vitest';
import { resolveProviderConfig, resolveModelConfig } from '../resolve-provider-config';
import { resolveKey } from '../credentials';
import type { LlmProviderConfig, LlmModelConfig } from '../provider-types';

/**
 * 读取单 key 形态 credentials 的 keyValue（v0.0.25 CredentialConfig union 后统一用 resolveKey）。
 * 测试原语义：验证聚合后的 credentials 持有期望 key 字符串。
 */
const keyValueOf = (c: LlmProviderConfig['credentials']): string =>
  resolveKey(c, undefined)?.keyValue ?? '';

describe('resolveProviderConfig', () => {
  it('returns code default when app delta is empty', () => {
    const codeDefault: Partial<LlmProviderConfig> = {
      name: 'anthropic_compatible',
      baseUrl: 'https://api.anthropic.com',
      credentials: { key: '' },
      pluginId: 'builtin.anthropic',
      enabled: true,
      models: [],
    };
    const resolved = resolveProviderConfig(codeDefault, undefined);
    expect(resolved.name).toBe('anthropic_compatible');
    expect(resolved.baseUrl).toBe('https://api.anthropic.com');
    expect(keyValueOf(resolved.credentials)).toBe('');
  });

  it('app delta overrides code default (apiKey)', () => {
    const codeDefault: Partial<LlmProviderConfig> = {
      name: 'anthropic_compatible',
      baseUrl: 'https://api.anthropic.com',
      credentials: { key: '' },
    };
    const appDelta: Partial<LlmProviderConfig> = {
      id: 'p1',
      credentials: { key: 'sk-user-key' },
    };
    const resolved = resolveProviderConfig(codeDefault, appDelta);
    expect(resolved.id).toBe('p1');
    expect(keyValueOf(resolved.credentials)).toBe('sk-user-key');
    expect(resolved.baseUrl).toBe('https://api.anthropic.com'); // 保留默认
  });

  it('app baseUrl overrides default baseUrl (custom endpoint)', () => {
    const codeDefault: Partial<LlmProviderConfig> = {
      baseUrl: 'https://api.anthropic.com',
      credentials: { key: '' },
    };
    const appDelta: Partial<LlmProviderConfig> = {
      baseUrl: 'https://my-proxy.test',
      credentials: { key: 'k' },
    };
    expect(resolveProviderConfig(codeDefault, appDelta).baseUrl).toBe(
      'https://my-proxy.test',
    );
  });

  it('deep merges nested credentials object (not replace)', () => {
    const codeDefault: Partial<LlmProviderConfig> = {
      credentials: { key: 'default-key' },
    };
    // app 只提供 key，保留 credentials 形状
    const resolved = resolveProviderConfig(codeDefault, {
      credentials: { key: 'user-key' },
    });
    expect(keyValueOf(resolved.credentials)).toBe('user-key');
  });

  it('merges models[] arrays: app replaces when provided, else default', () => {
    const defaultModel: Partial<LlmModelConfig> = { modelId: 'default-m' };
    const codeDefault: Partial<LlmProviderConfig> = {
      models: [defaultModel as LlmModelConfig],
    };
    // app 未提供 models → 用默认
    expect(resolveProviderConfig(codeDefault, { id: 'x' }).models.length).toBe(1);
    // app 提供 models → 覆盖
    const appModels = [{ modelId: 'app-m' } as Partial<LlmModelConfig>];
    const resolved2 = resolveProviderConfig(codeDefault, {
      models: appModels as LlmModelConfig[],
    });
    expect(resolved2.models[0]!.modelId).toBe('app-m');
  });
});

describe('resolveModelConfig', () => {
  it('app delta overrides code default for pricing / paramConstraints', () => {
    const codeDefault: Partial<LlmModelConfig> = {
      modelId: 'claude-sonnet-4-6',
      contextWindow: 200000,
      maxOutputTokens: 8000,
      pricing: {
        inputPerMillion: 3,
        outputPerMillion: 15,
        currency: 'USD',
      },
      paramConstraints: {
        temperature: { default: 1, min: 0, max: 1 },
      },
    };
    const appDelta: Partial<LlmModelConfig> = {
      maxOutputTokens: 16000,
      pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: 'USD' },
    };
    const resolved = resolveModelConfig(codeDefault, appDelta);
    expect(resolved.maxOutputTokens).toBe(16000); // app 覆盖
    expect(resolved.contextWindow).toBe(200000); // 保留默认
    expect(resolved.paramConstraints.temperature?.default).toBe(1); // 保留默认嵌套
  });
});
