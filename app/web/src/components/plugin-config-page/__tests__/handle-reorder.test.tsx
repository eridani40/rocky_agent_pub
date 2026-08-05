/**
 * @vitest-environment jsdom
 * page-plugin-config 的 handleReorder 单测（v0.0.67 配置只读化回归）
 * 参考: reqs/archive v0.0.67.plugin_config_refactor/design.md §2.2（前端只读化）
 *
 * 【v0.0.67 回归覆盖】
 *   - ordered 列表的 drag handle draggable=false（不可拖）
 *   - 强行 fireEvent.drop 也不触发 PUT（handler noop）
 *   - ext-point 节点位置稳定（既有 post-merge 回归约束保留）
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { PagePluginConfig } from '../page-plugin-config';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('PagePluginConfig · handleReorder（v0.0.67 配置只读化）', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function mockFetch(routes: Array<{ match: string; handler: (url: string, init?: RequestInit) => unknown }>) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      for (const r of routes) {
        if (url.includes(r.match)) {
          const body = await r.handler(url, init);
          return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
        }
      }
      return { ok: false, status: 404, text: async () => '{"error":"NF"}' } as unknown as Response;
    });
  }

  /**
   * 构造 ordered 扩展点 inventory：3 impl 按 1/2/3 初始顺序排列。
   * 嵌套形状：groups[].points[].impls[]。
   */
  const orderedInventory = () => ({
    tree: {
      plugins: [{ pluginId: 'p_test', label: 'P', description: '', enabled: true }],
      groups: [
        {
          groupId: 'test_group',
          points: [
            {
              pointId: 'test_retriever',
              activated: true,
              impls: [
                { pluginId: 'p_test', pointId: 'test_retriever', implId: 'a', type: 'ordered' as const, pluginEnabled: true, enabled: true, order: 1 },
                { pluginId: 'p_test', pointId: 'test_retriever', implId: 'b', type: 'ordered' as const, pluginEnabled: true, enabled: true, order: 2 },
                { pluginId: 'p_test', pointId: 'test_retriever', implId: 'c', type: 'ordered' as const, pluginEnabled: true, enabled: true, order: 3 },
              ],
            },
          ],
        },
      ],
    },
  });

  /** 按 implId 文本定位 ordered 行节点（带 draggable 属性的 div） */
  function getImplRow(implId: string) {
    return screen.getByText(implId).closest('[draggable]') as HTMLElement;
  }

  /** 切到扩展点 tab 并等待 ordered 列表渲染完成 */
  async function gotoExtTab() {
    await waitFor(() => expect(screen.getAllByText('P').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('tab', { name: '扩展点' }));
    await waitFor(() => expect(screen.getByText('a')).toBeTruthy());
  }

  it('v0.0.67：ordered 列表 disabled，每项 draggable=false（drag handle 禁用）', async () => {
    global.fetch = mockFetch([{ match: '/config/plugin', handler: () => orderedInventory() }]) as unknown as typeof fetch;
    render(<PagePluginConfig />);
    await gotoExtTab();

    const rowA = getImplRow('a');
    expect(rowA.getAttribute('draggable')).toBe('false');
  });

  it('v0.0.67：强行 drop 也不触发 PUT（handleReorder noop，PUT 端点已删）', async () => {
    const fetchSpy = mockFetch([{ match: '/config/plugin', handler: () => orderedInventory() }]);
    global.fetch = fetchSpy as unknown as typeof fetch;
    render(<PagePluginConfig />);
    await gotoExtTab();

    // jsdom 不会因 disabled 短路 fireEvent；但 page handler 是 noop，不会发 PUT
    fireEvent.dragStart(getImplRow('a'));
    fireEvent.dragOver(getImplRow('b'));
    fireEvent.drop(getImplRow('b'));

    // 等一会儿确认无 PUT（fetch mock 任何调用都能被检测）
    await new Promise((r) => setTimeout(r, 50));
    const putCalls = fetchSpy.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(putCalls).toHaveLength(0);
  });

  it('v0.0.67：ext-point 节点位置稳定（拖动不重排 ext-point，post-merge 回归约束保留）', async () => {
    global.fetch = mockFetch([{ match: '/config/plugin', handler: () => orderedInventory() }]) as unknown as typeof fetch;
    render(<PagePluginConfig />);
    await gotoExtTab();

    const before = screen.getAllByText('test_retriever').map((n) => n.textContent);
    fireEvent.dragStart(getImplRow('a'));
    fireEvent.dragOver(getImplRow('b'));
    fireEvent.drop(getImplRow('b'));
    const after = screen.getAllByText('test_retriever').map((n) => n.textContent);
    expect(after).toEqual(before);
  });
});
