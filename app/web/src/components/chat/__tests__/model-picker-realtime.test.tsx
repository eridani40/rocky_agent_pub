// @vitest-environment jsdom
/**
 * ModelPicker 实时化单测（v0.0.36 T1 —— 去 lib/providers 永久缓存的组件级影响）
 * 参考: specs/ui/overall/02-llm-chat.md §3.3（ModelPicker）
 *       specs/api/overall/02-llm-chat.md §5（GET /provider）
 *
 * 覆盖：去缓存后 ModelPicker 每次挂载实时拉最新 provider/model 列表，
 *       重新挂载后下拉项跟随配置中心最新数据刷新（不串上次挂载的旧列表）。
 * 机制：不用测试桩（__set...），而是 mock 真实 fetch，走 useProviders → fetchProviders 真实路径。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ModelPicker } from '../ModelPicker';
import {
  __resetProvidersCacheForTest,
  type ProviderItem,
} from '../../../lib/providers';

const providersV1: ProviderItem[] = [
  { id: 'p1', label: 'Provider 旧', models: [{ modelId: 'm-old', label: 'Model 旧' }] },
];
const providersV2: ProviderItem[] = [
  { id: 'p2', label: 'Provider 新', models: [{ modelId: 'm-new', label: 'Model 新' }] },
];

function providerRes(items: ProviderItem[]): Response {
  return { ok: true, status: 200, json: async () => ({ items }) } as unknown as Response;
}

beforeEach(() => {
  __resetProvidersCacheForTest(); // 清测试桩 + inFlight，走真实 fetch 路径
});
afterEach(() => {
  cleanup();
  __resetProvidersCacheForTest();
  vi.restoreAllMocks();
});

describe('ModelPicker — 每次挂载实时拉最新模型列表（无永久缓存）', () => {
  it('重新挂载后下拉项跟随最新 provider 数据刷新（旧列表不残留）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(providerRes(providersV1))
      .mockResolvedValueOnce(providerRes(providersV2));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // 第一次挂载：拉到 V1，下拉显示「Model 旧」（trigger 未配置时显 placeholder「选择 model」）
    const { unmount } = render(<ModelPicker value={null} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '选择 model' }));
    await waitFor(() =>
      expect(screen.getByRole('listbox').textContent).toContain('Model 旧'),
    );
    unmount();

    // 第二次挂载：实时拉到 V2，下拉显示「Model 新」且不含旧「Model 旧」
    render(<ModelPicker value={null} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '选择 model' }));
    await waitFor(() => {
      const list = screen.getByRole('listbox');
      expect(list.textContent).toContain('Model 新');
      expect(list.textContent).not.toContain('Model 旧'); // 旧列表未被缓存残留
    });
    expect(fetchMock).toHaveBeenCalledTimes(2); // 每次挂载各发一次真实请求
  });
});
