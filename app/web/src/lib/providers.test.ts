// @vitest-environment node
/**
 * providers 单测 —— 模型选择器统一过滤停用 provider 的纯函数层覆盖。
 * 参考: specs/tech/agent/providers_and_models/[P0]model_resolve.md §3.3
 *
 * 覆盖点：
 *   - findProviderIdByModelId 判 enabled（disabled provider 的 model 不命中）
 *   - fetchProviders 透传 enabled 字段（桩注入带 enabled 数据 → 返回项 enabled 可达）
 *
 * mock 走 `__setProvidersCacheForTest` 测试 seam（providers.ts L110），禁硬编码绝对路径
 * （memory `test-vitest-mock-absolute-path`）；每用例后 `__resetProvidersCacheForTest()` 清污染。
 *
 * 注：useProviders 是 React hook，node 环境无法直接渲染组件，组件层 flatMap 过滤断言靠
 * 样板 KeyModelPicker 对齐 + code review（过滤范式同款，低风险）。本 UT 聚焦纯函数 + 数据透传。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  findProviderIdByModelId,
  fetchProviders,
  __setProvidersCacheForTest,
  __resetProvidersCacheForTest,
  type ProviderItem,
} from './providers';

describe('findProviderIdByModelId', () => {
  it('disabled provider 的 model 不命中（返 null）', () => {
    const providers: ProviderItem[] = [
      {
        id: 'p-enabled',
        label: 'EnabledProvider',
        enabled: true,
        models: [{ modelId: 'model-a', label: 'A', enabled: true }],
      },
      {
        id: 'p-disabled',
        label: 'DisabledProvider',
        enabled: false,
        models: [{ modelId: 'model-b', label: 'B', enabled: true }],
      },
    ];
    // model-b 唯一宿主是 disabled provider → 不应命中
    expect(findProviderIdByModelId(providers, 'model-b')).toBeNull();
  });

  it('enabled provider 的 model 正常命中', () => {
    const providers: ProviderItem[] = [
      {
        id: 'p-enabled',
        label: 'EnabledProvider',
        enabled: true,
        models: [{ modelId: 'model-a', label: 'A', enabled: true }],
      },
    ];
    expect(findProviderIdByModelId(providers, 'model-a')).toBe('p-enabled');
  });

  it('enabled === undefined 的 provider 视为 enabled（命中）', () => {
    const providers: ProviderItem[] = [
      {
        id: 'p-undef',
        label: 'UndefinedEnabledProvider',
        // enabled 字段缺失 —— 运行时视为 enabled（对齐后端 `enabled !== false`）
        models: [{ modelId: 'model-c', label: 'C' }],
      },
    ];
    expect(findProviderIdByModelId(providers, 'model-c')).toBe('p-undef');
  });

  it('model 不存在时返 null', () => {
    const providers: ProviderItem[] = [
      {
        id: 'p-enabled',
        label: 'EnabledProvider',
        enabled: true,
        models: [{ modelId: 'model-a', label: 'A', enabled: true }],
      },
    ];
    expect(findProviderIdByModelId(providers, 'nonexistent')).toBeNull();
  });

  it('空 provider 列表返 null', () => {
    expect(findProviderIdByModelId([], 'any')).toBeNull();
  });

  it('同名 model 跨 provider 时优先返 enabled provider', () => {
    // disabled provider 与 enabled provider 都有 same-model，应返 enabled 那个
    const providers: ProviderItem[] = [
      { id: 'p-disabled', label: 'D', enabled: false, models: [{ modelId: 'same-model' }] },
      { id: 'p-enabled', label: 'E', enabled: true, models: [{ modelId: 'same-model' }] },
    ];
    expect(findProviderIdByModelId(providers, 'same-model')).toBe('p-enabled');
  });
});

describe('fetchProviders 透传 enabled', () => {
  afterEach(() => {
    __resetProvidersCacheForTest();
  });

  it('桩注入带 enabled 的数据 → 返回项 enabled 字段可达', async () => {
    const stub: ProviderItem[] = [
      {
        id: 'p-enabled',
        label: 'EnabledProvider',
        enabled: true,
        models: [
          { modelId: 'model-a', label: 'A', enabled: true },
          { modelId: 'model-disabled', label: 'DisabledModel', enabled: false },
        ],
      },
      {
        id: 'p-disabled',
        label: 'DisabledProvider',
        enabled: false,
        models: [{ modelId: 'model-b', label: 'B', enabled: true }],
      },
      {
        id: 'p-undef',
        label: 'UndefinedEnabledProvider',
        models: [{ modelId: 'model-c', label: 'C' }],
      },
    ];
    __setProvidersCacheForTest(stub);
    const result = await fetchProviders();
    expect(result).toHaveLength(3);
    // 顶层 enabled 透传（不加默认化）
    expect(result.find((p) => p.id === 'p-enabled')?.enabled).toBe(true);
    expect(result.find((p) => p.id === 'p-disabled')?.enabled).toBe(false);
    expect(result.find((p) => p.id === 'p-undef')?.enabled).toBeUndefined();
    // model 层 enabled 透传
    const enabledProvider = result.find((p) => p.id === 'p-enabled');
    expect(enabledProvider?.models.find((m) => m.modelId === 'model-a')?.enabled).toBe(true);
    expect(enabledProvider?.models.find((m) => m.modelId === 'model-disabled')?.enabled).toBe(false);
  });

  it('空桩 → 返空数组（透传不构造默认 enabled）', async () => {
    __setProvidersCacheForTest([]);
    const result = await fetchProviders();
    expect(result).toEqual([]);
  });

  it('testProviders 注入后 fetchProviders 同源返回（hook 初始种入同源 testProviders）', async () => {
    // useProviders 内部走 fetchProviders，初始 useState 同源 testProviders
    // （providers.ts L130：useState(testProviders ?? [])）。此处验证桩可被消费链路读到 enabled
    const stub: ProviderItem[] = [
      {
        id: 'p-disabled',
        label: 'D',
        enabled: false,
        models: [{ modelId: 'm' }],
      },
    ];
    __setProvidersCacheForTest(stub);
    const fetched = await fetchProviders();
    expect(fetched).toBe(stub);
    expect(fetched.some((p) => p.enabled === false)).toBe(true);
  });
});
