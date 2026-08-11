/**
 * config-sync-import 单测（v0.0.318）。
 * 参考 specs/tech/version_logs/v0.0.318/change_plan.md D4
 *
 * 校验点：
 *   - checkDuplicateLabels 按 label 精确匹配返回 Set
 *   - executeImport 逐条 createProvider + createModel（不传 id）
 *   - executeImport 工具 putConfigGroup 整 tab 覆盖
 *   - executeImport 混合导入计数
 *   - parseImportFile 失败 throw 可读 message
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConfigExportData, ProviderExportItem } from '../config-crypto';
import type { ProviderInstance } from '../api-client';
import type { SelectionState } from '../config-sync-export';

// vi.mock 用绝对路径（MEMORY: bun+jsdom 并发下相对路径 vi.mock 静默失效）
const apiClientPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../api-client'),
);

const mockCreateProvider = vi.fn();
const mockCreateModel = vi.fn();
const mockPutConfigGroup = vi.fn();
const mockLoadProvidersAndProtocols = vi.fn();

vi.mock(apiClientPath, () => ({
  createProvider: (...args: unknown[]) => mockCreateProvider(...args),
  createModel: (...args: unknown[]) => mockCreateModel(...args),
  putConfigGroup: (...args: unknown[]) => mockPutConfigGroup(...args),
  loadProvidersAndProtocols: (...args: unknown[]) => mockLoadProvidersAndProtocols(...args),
}));

// config-crypto 的 unwrapExport 是真函数（不加解密层面 mock，测试加解密在 config-crypto.test.ts 覆盖）
import { checkDuplicateLabels, executeImport, parseImportFile } from '../config-sync-import';

function makeProviderItem(label: string): ProviderExportItem {
  return {
    label,
    name: 'anthropic_compatible',
    protocolId: 'anthropic_messages',
    baseUrl: 'https://api.example.com',
    credentials: { key: 'sk-key' },
    enabled: true,
    models: [
      { modelId: 'gpt-4o', contextWindow: 128000, maxOutputTokens: 16384, label: 'GPT-4o', enabled: true },
    ],
  };
}

function makeLocalProvider(label: string, id: string): ProviderInstance {
  return {
    id,
    name: 'anthropic_compatible',
    protocolId: 'anthropic_messages',
    label,
    baseUrl: 'https://api.example.com',
    credentials: { key: 'sk-local' },
    enabled: true,
    models: [],
  };
}

describe('config-sync-import — 导入执行（v0.0.318）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateProvider.mockResolvedValue({
      id: 'new-id', label: 'test', name: 'anthropic_compatible',
      protocolId: 'anthropic_messages', baseUrl: '', credentials: { key: '' },
      enabled: true, models: [],
    });
    mockCreateModel.mockResolvedValue({});
    mockPutConfigGroup.mockResolvedValue(undefined);
    mockLoadProvidersAndProtocols.mockResolvedValue({ items: [], protocols: [] });
  });

  // — checkDuplicateLabels（纯函数，不需 mock）—
  it('checkDuplicateLabels 按 label 精确匹配', () => {
    const importProviders = [makeProviderItem('OpenAI'), makeProviderItem('Claude')];
    const localProviders = [makeLocalProvider('OpenAI', 'local-1'), makeLocalProvider('Other', 'local-2')];
    const dup = checkDuplicateLabels(importProviders, localProviders);
    expect(dup.has('OpenAI')).toBe(true);
    expect(dup.has('Claude')).toBe(false);
    expect(dup.size).toBe(1);
  });

  it('checkDuplicateLabels 无重名 → 空 Set', () => {
    const importProviders = [makeProviderItem('Claude')];
    const localProviders = [makeLocalProvider('OpenAI', 'local-1')];
    const dup = checkDuplicateLabels(importProviders, localProviders);
    expect(dup.size).toBe(0);
  });

  // — executeImport 模型注入 —
  it('executeImport 逐条 createProvider + createModel（不传 id）', async () => {
    const data: ConfigExportData = {
      v: 1,
      exportedAt: '2026-08-10T12:00:00Z',
      providers: [makeProviderItem('Test Provider')],
      tools: {},
    };
    const selected: SelectionState = {
      providers: new Set(['Test Provider']),
      tools: new Set(),
    };
    const result = await executeImport(data, selected);
    expect(mockCreateProvider).toHaveBeenCalledTimes(1);
    // 验证不传 id
    const callArg = mockCreateProvider.mock.calls[0]![0];
    expect(callArg).not.toHaveProperty('id');
    expect(callArg.label).toBe('Test Provider');
    // 1 个 model → createModel 1 次
    expect(mockCreateModel).toHaveBeenCalledTimes(1);
    expect(result.providersImported).toBe(1);
    expect(result.toolsImported).toBe(0);
  });

  it('executeImport 跳过未选中 provider', async () => {
    const data: ConfigExportData = {
      v: 1, exportedAt: '',
      providers: [makeProviderItem('A'), makeProviderItem('B')],
      tools: {},
    };
    const selected: SelectionState = {
      providers: new Set(['A']),
      tools: new Set(),
    };
    const result = await executeImport(data, selected);
    expect(mockCreateProvider).toHaveBeenCalledTimes(1);
    expect(result.providersImported).toBe(1);
  });

  // — executeImport 工具覆盖 —
  it('executeImport 工具 putConfigGroup 整 tab 覆盖', async () => {
    const data: ConfigExportData = {
      v: 1, exportedAt: '',
      providers: [],
      tools: { web_search: { default: { type: 'zhipu_api' } } },
    };
    const selected: SelectionState = {
      providers: new Set(),
      tools: new Set(['web_search']),
    };
    const result = await executeImport(data, selected);
    expect(mockPutConfigGroup).toHaveBeenCalledTimes(1);
    const [domain, group, items] = mockPutConfigGroup.mock.calls[0]!;
    expect(domain).toBe('app');
    expect(group).toBe('web_search');
    expect(items).toEqual([{ key: 'default', data: { type: 'zhipu_api' } }]);
    expect(result.toolsImported).toBe(1);
  });

  // — 混合导入计数 —
  it('executeImport 混合导入：2 provider + 2 tool', async () => {
    const data: ConfigExportData = {
      v: 1, exportedAt: '',
      providers: [makeProviderItem('P1'), makeProviderItem('P2')],
      tools: {
        web_search: { default: { type: 'a' } },
        bash: { bash_seatbelt: true },
      },
    };
    const selected: SelectionState = {
      providers: new Set(['P1', 'P2']),
      tools: new Set(['web_search', 'bash']),
    };
    const result = await executeImport(data, selected);
    expect(result.providersImported).toBe(2);
    expect(result.toolsImported).toBe(2);
    expect(mockCreateProvider).toHaveBeenCalledTimes(2);
    expect(mockPutConfigGroup).toHaveBeenCalledTimes(2);
  });

  // — parseImportFile 失败 —
  it('parseImportFile 非 JSON → throw 可读 message', async () => {
    const file = new File(['not json'], 'test.json', { type: 'application/json' });
    await expect(parseImportFile(file)).rejects.toThrow('文件格式不正确');
  });

  it('parseImportFile 非 config 文件结构 → throw 可读 message', async () => {
    const file = new File([JSON.stringify({ foo: 'bar' })], 'test.json', { type: 'application/json' });
    await expect(parseImportFile(file)).rejects.toThrow('文件格式不正确');
  });
});
