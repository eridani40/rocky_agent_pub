/**
 * @vitest-environment jsdom
 * page-plugin-config 的 handleReorder 回归单测（v0.0.67 只读化回归）
 * 参考: reqs/archive v0.0.67.plugin_config_refactor/design.md §2.2（前端只读化）
 *
 * 【v0.0.18 post-merge 回归背景】
 *   旧 handleReorder 乐观更新把 extImpls 重建为 `[...others, ...reordered]`，
 *   导致被拖 point 的所有 impl 被挪到 flat 数组末尾 → ext point 整体跳到列表最底部。
 *   v0.0.18 修复后保持 ext point 节点相对顺序稳定。
 *
 * 【v0.0.67 只读化】
 *   handleReorder 改 noop（PUT 端点删），drag handle disabled。
 *   本文件覆盖：drag handle disabled 状态下 ext point 节点顺序仍稳定（post-merge 约束保留），
 *   且不会发任何 PUT（handler noop）。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { PagePluginConfig } from '../page-plugin-config';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('PagePluginConfig · handleReorder ext point 位置稳定回归（v0.0.67 只读）', () => {
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
   * 双 point inventory：point_alpha 在前（impl a1/a2），point_beta 在后（impl b1/b2）。
   * 嵌套形状：groups[].points[].impls[]。
   */
  const twoPointInventory = () => ({
    tree: {
      plugins: [{ pluginId: 'p_test', label: 'P', description: '', enabled: true }],
      groups: [
        {
          groupId: 'test_group',
          points: [
            {
              pointId: 'point_alpha',
              activated: true,
              impls: [
                { pluginId: 'p_test', pointId: 'point_alpha', implId: 'a1', type: 'ordered' as const, pluginEnabled: true, enabled: true, order: 1 },
                { pluginId: 'p_test', pointId: 'point_alpha', implId: 'a2', type: 'ordered' as const, pluginEnabled: true, enabled: true, order: 2 },
              ],
            },
            {
              pointId: 'point_beta',
              activated: true,
              impls: [
                { pluginId: 'p_test', pointId: 'point_beta', implId: 'b1', type: 'ordered' as const, pluginEnabled: true, enabled: true, order: 1 },
                { pluginId: 'p_test', pointId: 'point_beta', implId: 'b2', type: 'ordered' as const, pluginEnabled: true, enabled: true, order: 2 },
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

  async function gotoExtTab() {
    await waitFor(() => expect(screen.getAllByText('P').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('tab', { name: '扩展点' }));
    await waitFor(() => expect(screen.getByText('point_alpha')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('point_beta')).toBeTruthy());
  }

  /** 取页面上所有 ext point 标题的 pointId（按 DOM 出现序） */
  function extPointOrder(): string[] {
    return screen.getAllByText(/^point_/).map((n) => n.textContent ?? '');
  }

  it('v0.0.67：drag handle disabled，强行 drop 也不重排 ext-point 顺序', async () => {
    global.fetch = mockFetch([{ match: '/config/plugin', handler: () => twoPointInventory() }]) as unknown as typeof fetch;
    render(<PagePluginConfig />);
    await gotoExtTab();

    expect(extPointOrder()).toEqual(['point_alpha', 'point_beta']);

    // drag handle disabled 但 jsdom fireEvent 仍能冒泡到 onDrop；page handler 是 noop 不重排
    fireEvent.dragStart(getImplRow('a1'));
    fireEvent.dragOver(getImplRow('a2'));
    fireEvent.drop(getImplRow('a2'));

    // 回归核心：ext point 节点顺序保持 alpha→beta
    expect(extPointOrder()).toEqual(['point_alpha', 'point_beta']);
  });

  it('v0.0.67：handleReorder noop，不触发任何 PUT 调用', async () => {
    const fetchSpy = mockFetch([{ match: '/config/plugin', handler: () => twoPointInventory() }]);
    global.fetch = fetchSpy as unknown as typeof fetch;
    render(<PagePluginConfig />);
    await gotoExtTab();

    fireEvent.dragStart(getImplRow('a1'));
    fireEvent.dragOver(getImplRow('a2'));
    fireEvent.drop(getImplRow('a2'));

    await new Promise((r) => setTimeout(r, 50));
    const putCalls = fetchSpy.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(putCalls).toHaveLength(0);
  });
});
