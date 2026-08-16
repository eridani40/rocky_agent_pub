/**
 * @vitest-environment jsdom
 * [v0.0.352 T1] section-providers 单测 — Provider 列表折叠 + 停用分组
 * 参考: specs/tech/version_logs/v0.0.352/quota-overview-v2/change_plan.md D1/D2
 *
 * 校验点：
 *   - 默认只渲染 enabled provider 卡
 *   - disabled 组非空时渲染「已停用 (N)」入口；为空不渲染
 *   - 点击入口切换展开态，展开后渲染 disabled provider 卡
 *   - 停用卡视觉保持灰色调（由 component-provider-list-card 内部负责）
 *   - 添加 provider 卡始终在启用组之后
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { SectionProviders } from '../section-providers';
import type { ProviderInstance } from '../../../lib/api-client';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/api-client'));
const detailPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../component-provider-detail'));

vi.mock(apiPath, async () => {
  const actual = await vi.importActual<typeof import('../../../lib/api-client')>(apiPath);
  return {
    ...actual,
    loadProvidersAndProtocols: vi.fn(),
    fetchProviderQuota: vi.fn(async () => ({ items: [] })),
    saveProviderWithModels: vi.fn(),
    deleteProvider: vi.fn(),
  };
});

vi.mock(detailPath, () => ({
  ComponentProviderDetail: () => <div data-testid="provider-detail" />,
}));

import { loadProvidersAndProtocols } from '../../../lib/api-client';

function mkProvider(id: string, label: string, enabled: boolean, name = 'anthropic_compatible'): ProviderInstance {
  return {
    id,
    name: name as ProviderInstance['name'],
    protocolId: 'anthropic_messages',
    label,
    baseUrl: 'https://api.example.com',
    credentials: { key: '***' },
    enabled,
    models: [{ modelId: 'm1', label: 'M1', contextWindow: 128000, maxOutputTokens: 4096, enabled: true }],
  };
}

async function renderList(items: ProviderInstance[]) {
  vi.mocked(loadProvidersAndProtocols).mockResolvedValue({ items, protocols: [] });
  render(<SectionProviders />);
  await act(async () => {});
}

describe('[v0.0.352 T1] Provider 列表折叠与分组', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('默认只渲染 enabled provider 卡，无停用时没有折叠入口', async () => {
    await renderList([
      mkProvider('p-1', '启用 A', true),
      mkProvider('p-2', '启用 B', true),
    ]);
    expect(screen.getByTestId('provider-card-p-1')).toBeTruthy();
    expect(screen.getByTestId('provider-card-p-2')).toBeTruthy();
    expect(screen.queryByTestId('providers-disabled-fold')).toBeNull();
    expect(screen.queryByTestId('providers-disabled-list')).toBeNull();
  });

  it('disabled 组非空时渲染「已停用 (N)」入口，默认不展开', async () => {
    await renderList([
      mkProvider('p-on', '启用', true),
      mkProvider('p-off-1', '停用 1', false),
      mkProvider('p-off-2', '停用 2', false),
    ]);
    expect(screen.getByTestId('provider-card-p-on')).toBeTruthy();
    expect(screen.queryByTestId('provider-card-p-off-1')).toBeNull();
    expect(screen.queryByTestId('provider-card-p-off-2')).toBeNull();
    const fold = screen.getByTestId('providers-disabled-fold');
    expect(fold.textContent).toContain('已停用 (2)');
  });

  it('点击折叠入口展开/收起 disabled 组', async () => {
    await renderList([
      mkProvider('p-on', '启用', true),
      mkProvider('p-off-1', '停用 1', false),
    ]);
    const fold = screen.getByTestId('providers-disabled-fold');
    fireEvent.click(fold);
    await act(async () => {});
    expect(screen.getByTestId('provider-card-p-off-1')).toBeTruthy();
    expect(screen.getByTestId('providers-disabled-list')).toBeTruthy();

    fireEvent.click(fold);
    await act(async () => {});
    expect(screen.queryByTestId('provider-card-p-off-1')).toBeNull();
    expect(screen.queryByTestId('providers-disabled-list')).toBeNull();
  });

  it('展开态下点击 disabled provider 卡进入 detail', async () => {
    await renderList([
      mkProvider('p-on', '启用', true),
      mkProvider('p-off-1', '停用 1', false),
    ]);
    fireEvent.click(screen.getByTestId('providers-disabled-fold'));
    await act(async () => {});
    fireEvent.click(screen.getByTestId('provider-card-p-off-1'));
    await act(async () => {});
    expect(screen.getByTestId('provider-detail')).toBeTruthy();
  });

  it('添加 provider 按钮始终位于启用组之后、折叠入口之前', async () => {
    await renderList([
      mkProvider('p-on', '启用', true),
      mkProvider('p-off-1', '停用 1', false),
    ]);
    const addBtn = screen.getByText('+ 添加提供商').closest('button');
    expect(addBtn).toBeTruthy();
    const fold = screen.queryByTestId('providers-disabled-fold');
    expect(fold).toBeTruthy();
  });
});
