/**
 * config-sync-export 单测（v0.0.318）。
 * 参考 specs/tech/version_logs/v0.0.318/change_plan.md D3
 *
 * 校验点：
 *   - collectExportData 剥离 provider.id、models 全量保留
 *   - collectExportData tools 仅选中 tab
 *   - collectExportData web_fetch 仅提取 jina 三 key
 *   - TOOL_TAB_MAP 精确映射 4 个工具 tab
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { collectExportData, TOOL_TAB_MAP, type SelectionState } from '../config-sync-export';

// vi.mock 用绝对路径（MEMORY: bun+jsdom 并发下相对路径 vi.mock 静默失效）
const apiClientPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../api-client'),
);

vi.mock(apiClientPath, () => ({
  loadProvidersAndProtocols: vi.fn(async () => ({
    items: [
      {
        id: 'provider-001',
        name: 'anthropic_compatible',
        protocolId: 'anthropic_messages',
        label: 'OpenAI Compatible',
        baseUrl: 'https://api.openai.com',
        credentials: { key: 'sk-real-key' },
        enabled: true,
        models: [
          { modelId: 'gpt-4o', contextWindow: 128000, maxOutputTokens: 16384, label: 'GPT-4o', enabled: true },
          { modelId: 'gpt-4o-mini', contextWindow: 128000, maxOutputTokens: 16384, label: 'GPT-4o Mini', enabled: false },
        ],
      },
      {
        id: 'provider-002',
        name: 'anthropic_compatible',
        protocolId: 'anthropic_messages',
        label: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        credentials: { key: 'sk-ant-key' },
        enabled: false,
        models: [],
      },
    ],
    protocols: [],
  })),
  getConfigGroup: vi.fn(async (_domain: string, group: string) => {
    if (group === 'web_search') return [{ key: 'default', data: { type: 'zhipu_api' } }];
    if (group === 'web') return [
      { key: 'jinaApiKey', data: 'jina-xxx' },
      { key: 'jinaEnabled', data: true },
      { key: 'jinaTimeoutMs', data: 20000 },
    ];
    if (group === 'see_image') return [{ key: 'default', data: { type: 'zhipu_api' } }];
    if (group === 'runtime') return [{ key: 'bash_seatbelt', data: true }];
    return [];
  }),
}));

import { loadProvidersAndProtocols, getConfigGroup } from '../api-client';

describe('config-sync-export — 导出采集（v0.0.318）', () => {
  beforeEach(() => {
    vi.mocked(loadProvidersAndProtocols).mockClear();
    vi.mocked(getConfigGroup).mockClear();
  });

  it('collectExportData 剥离 provider.id，models 全量保留', async () => {
    const selected: SelectionState = {
      providers: new Set(['OpenAI Compatible']),
      tools: new Set(),
    };
    const data = await collectExportData(selected);
    expect(data.providers).toHaveLength(1);
    expect(data.providers[0]).not.toHaveProperty('id');
    expect(data.providers[0]!.label).toBe('OpenAI Compatible');
    expect(data.providers[0]!.models).toHaveLength(2);
    expect(data.providers[0]!.models[0]!.modelId).toBe('gpt-4o');
  });

  it('collectExportData tools 仅含选中 tab', async () => {
    const selected: SelectionState = {
      providers: new Set(),
      tools: new Set(['web_search']),
    };
    const data = await collectExportData(selected);
    expect(data.providers).toEqual([]);
    expect(Object.keys(data.tools)).toEqual(['web_search']);
    expect(data.tools.web_search).toEqual({ default: { type: 'zhipu_api' } });
  });

  it('collectExportData web_fetch 仅提取 jina 三 key', async () => {
    const selected: SelectionState = {
      providers: new Set(),
      tools: new Set(['web_fetch']),
    };
    const data = await collectExportData(selected);
    expect(data.tools.web_fetch).toEqual({
      jinaApiKey: 'jina-xxx',
      jinaEnabled: true,
      jinaTimeoutMs: 20000,
    });
  });

  it('collectExportData 全选 → providers + tools 均有数据', async () => {
    const selected: SelectionState = {
      providers: new Set(['OpenAI Compatible', 'Anthropic']),
      tools: new Set(['web_search', 'web_fetch', 'see_image', 'bash']),
    };
    const data = await collectExportData(selected);
    expect(data.providers).toHaveLength(2);
    expect(Object.keys(data.tools)).toHaveLength(4);
    expect(data.v).toBe(1);
    expect(data.exportedAt).toBeTruthy();
  });

  it('TOOL_TAB_MAP 精确映射 4 个工具 tab', () => {
    expect(TOOL_TAB_MAP.web_search).toEqual({ group: 'web_search', keys: ['default'] });
    expect(TOOL_TAB_MAP.web_fetch).toEqual({ group: 'web', keys: ['jinaApiKey', 'jinaEnabled', 'jinaTimeoutMs'] });
    expect(TOOL_TAB_MAP.see_image).toEqual({ group: 'see_image', keys: ['default'] });
    expect(TOOL_TAB_MAP.bash).toEqual({ group: 'runtime', keys: ['bash_seatbelt'] });
  });
});
