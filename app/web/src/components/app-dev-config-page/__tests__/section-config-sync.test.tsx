/**
 * @vitest-environment jsdom
 * section-config-sync 单测（v0.0.318）。
 * 参考 specs/tech/version_logs/v0.0.318/change_plan.md D6
 *
 * 校验点：
 *   - 三态切换 landing → export → import
 *   - 导出按钮 disabled 当无选中项
 *   - 导入确认 modal 文案含覆盖警告
 *   - i18n 文案存在
 *
 * 注意：config-sync-import 和 config-sync-export 用绝对路径 vi.mock，
 *   避开 Node/jsdom 下 crypto.subtle 差异导致的加解密不一致。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { act } from 'react';

beforeAll(async () => {
  await initI18n('zh-CN');
});

// vi.mock 用绝对路径（MEMORY: bun+jsdom 并发下相对路径 vi.mock 静默失效）
const apiClientPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../../lib/api-client'),
);
const exportPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../../lib/config-sync-export'),
);
const importPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../../lib/config-sync-import'),
);

// mock api-client
vi.mock(apiClientPath, () => ({
  loadProvidersAndProtocols: vi.fn(async () => ({
    items: [
      {
        id: 'p1', name: 'anthropic_compatible', protocolId: 'anthropic_messages',
        label: 'TestProvider', baseUrl: 'https://api.test.com',
        credentials: { key: 'sk-test' }, enabled: true,
        models: [],
      },
    ],
    protocols: [],
  })),
  getConfigGroup: vi.fn(async () => []),
  createProvider: vi.fn(async () => ({
    id: 'new-id', name: 'anthropic_compatible', protocolId: 'anthropic_messages',
    label: 'TestProvider', baseUrl: '', credentials: { key: '' }, enabled: true, models: [],
  })),
  createModel: vi.fn(async () => ({})),
  putConfigGroup: vi.fn(async () => undefined),
}));

// mock config-sync-export（跳过真实 API 采集，直接返回测试数据）
const mockCollectExportData = vi.fn();
const mockTriggerDownload = vi.fn();
vi.mock(exportPath, () => ({
  collectExportData: (...args: unknown[]) => mockCollectExportData(...args),
  triggerDownload: (...args: unknown[]) => mockTriggerDownload(...args),
  TOOL_TAB_IDS: ['web_search', 'web_fetch', 'see_image', 'bash'],
  TOOL_TAB_LABEL_KEYS: {
    web_search: 'tab.tools.web_search',
    web_fetch: 'tab.tools.web_fetch',
    see_image: 'tab.tools.see_image',
    bash: 'tab.tools.bash',
  },
}));

// mock config-sync-import（跳过真实加解密，直接返回测试数据）
const mockParseImportFile = vi.fn();
const mockExecuteImport = vi.fn();
vi.mock(importPath, () => ({
  parseImportFile: (...args: unknown[]) => mockParseImportFile(...args),
  executeImport: (...args: unknown[]) => mockExecuteImport(...args),
  checkDuplicateLabels: () => new Set<string>(),
  getLocalProviders: vi.fn(async () => []),
}));

import { SectionConfigSync } from '../section-config-sync';

// 测试用 ConfigExportData
function makeExportData(overrides?: Partial<{ providerLabel: string; toolKeys: string[] }>) {
  const label = overrides?.providerLabel ?? 'ImportTest';
  const tools: Record<string, unknown> = {};
  for (const k of overrides?.toolKeys ?? ['web_search']) {
    tools[k] = { default: { type: 'zhipu_api' } };
  }
  return {
    v: 1 as const,
    exportedAt: '2026-08-10T12:00:00Z',
    providers: [{
      label, name: 'anthropic_compatible' as const,
      protocolId: 'anthropic_messages' as const,
      baseUrl: 'https://api.test.com', credentials: { key: 'sk-key' },
      enabled: true, models: [],
    }],
    tools,
  };
}

describe('section-config-sync — 配置同步页三态（v0.0.318）', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockCollectExportData.mockResolvedValue({
      v: 1, exportedAt: '', providers: [], tools: {},
    });
    mockTriggerDownload.mockResolvedValue(undefined);
    mockParseImportFile.mockResolvedValue(makeExportData());
    mockExecuteImport.mockResolvedValue({ providersImported: 1, toolsImported: 0 });
  });
  afterEach(() => cleanup());

  it('landing 态：渲染导出/导入入口按钮', () => {
    render(<SectionConfigSync />);
    expect(screen.getByTestId('config-sync-export-btn')).toBeTruthy();
    expect(screen.getByTestId('config-sync-import-btn')).toBeTruthy();
  });

  it('点击导出 → 切到 export 态', async () => {
    render(<SectionConfigSync />);
    fireEvent.click(screen.getByTestId('config-sync-export-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('config-tree')).toBeTruthy();
    });
    expect(screen.getByTestId('config-sync-do-export')).toBeTruthy();
  });

  it('点击导入 → 切到 import 态（含 file input）', () => {
    render(<SectionConfigSync />);
    fireEvent.click(screen.getByTestId('config-sync-import-btn'));
    expect(screen.getByTestId('config-sync-file-input')).toBeTruthy();
  });

  it('export 态：取消所有选中 → 导出按钮 disabled', async () => {
    render(<SectionConfigSync />);
    fireEvent.click(screen.getByTestId('config-sync-export-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('config-tree')).toBeTruthy();
    });
    // 取消两个 folder（模型 + 工具）→ 联动子节点取消
    act(() => {
      fireEvent.click(screen.getByTestId('config-tree-folder-模型配置'));
    });
    act(() => {
      fireEvent.click(screen.getByTestId('config-tree-folder-工具配置'));
    });
    const exportBtn = screen.getByTestId('config-sync-do-export') as HTMLButtonElement;
    expect(exportBtn.disabled).toBe(true);
  });

  it('import 态：选择非 JSON 文件 → 显示错误不进树形页', async () => {
    // 让 parseImportFile 抛错
    mockParseImportFile.mockRejectedValueOnce(new Error('文件格式不正确，无法解析为配置同步文件'));
    render(<SectionConfigSync />);
    fireEvent.click(screen.getByTestId('config-sync-import-btn'));
    const input = screen.getByTestId('config-sync-file-input') as HTMLInputElement;
    const badFile = new File(['not json'], 'bad.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [badFile] } });
    await waitFor(() => {
      expect(screen.getByTestId('config-sync-parse-error')).toBeTruthy();
    });
    expect(screen.queryByTestId('config-tree')).toBeNull();
  });

  it('import 态：选择正确的加密文件 → 进入树形页 + 显示导入按钮', async () => {
    render(<SectionConfigSync />);
    fireEvent.click(screen.getByTestId('config-sync-import-btn'));
    const input = screen.getByTestId('config-sync-file-input') as HTMLInputElement;
    const goodFile = new File(['encrypted-content'], 'export.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [goodFile] } });

    await waitFor(() => {
      expect(screen.getByTestId('config-tree')).toBeTruthy();
    });
    expect(screen.getByTestId('config-sync-do-import')).toBeTruthy();
  });

  it('import 态：点导入 → 显示确认 modal 含覆盖警告', async () => {
    render(<SectionConfigSync />);
    fireEvent.click(screen.getByTestId('config-sync-import-btn'));
    const input = screen.getByTestId('config-sync-file-input') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'e.json', { type: 'application/json' })] } });

    await waitFor(() => {
      expect(screen.getByTestId('config-tree')).toBeTruthy();
    });

    // 点导入按钮
    fireEvent.click(screen.getByTestId('config-sync-do-import'));
    // 确认 modal 出现，含覆盖警告
    await waitFor(() => {
      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeTruthy();
      expect(dialog.textContent).toContain('覆盖');
    });
  });
});
