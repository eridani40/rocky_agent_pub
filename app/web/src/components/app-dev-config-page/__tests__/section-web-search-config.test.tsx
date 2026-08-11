/**
 * @vitest-environment jsdom
 * section-web-search-config 单测（v0.0.72 新增；v0.0.90.ui apiKey 改 SecretInput；v0.0.316-fix 适配 forwardRef + onDirtyChange）
 * 参考: specs/ui/components/app-dev-config-page/section-web-search-config/_overview.md
 *
 * 校验点：
 *   - 挂载并发 GET `/config/app?group=web_search&key=default` + `/config/plugin`
 *   - 渲染 section + type 下拉 + apiKey SecretInput
 *   - apiKey 已有值 → mask 展示；commit 新值 → draft 更新 + onDirtyChange(true)
 *   - 选中 type=zhipu + commit apiKey → onDirtyChange(true)；ref.save() → PUT body 形状正确
 *   - type 未配置（record null）→ 初始 clean（onDirtyChange(false)）
 *   - 无候选 impl → 渲染空态
 *
 * mock fetch（按 url 子串路由），不调真实 API。
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { createRef, act } from 'react';
import { SectionWebSearchConfig } from '../section-web-search-config';
import type { SectionSaveHandle } from '../use-tab-dirty-aggregator';

beforeAll(async () => {
  await initI18n('zh-CN');
});

/** SecretInput commit helper */
function commitSecret(displayText: string, nextValue: string) {
  fireEvent.click(screen.getByText(displayText));
  const field = screen.getByRole('textbox') as HTMLInputElement;
  fireEvent.change(field, { target: { value: nextValue } });
  fireEvent.click(screen.getByRole('button', { name: '提交' }));
}

/** 获取 type 下拉 trigger */
function getTypeSelect(container: HTMLElement) {
  return container.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement;
}

/** 构造 fetch mock */
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

/** inventory 嵌套形状 */
const inventory = (impls: Array<{ implId: string; description?: string }>) => ({
  tree: {
    plugins: [],
    groups: [
      {
        groupId: 'provider',
        points: [
          {
            pointId: 'web_search_provider',
            activated: true,
            impls: impls.map((i) => ({
              pluginId: 'zhipu_web_search',
              pointId: 'web_search_provider',
              implId: i.implId,
              type: 'list' as const,
              pluginEnabled: true,
              enabled: true,
              description: i.description ?? '',
            })),
          },
        ],
      },
    ],
  },
});

describe('SectionWebSearchConfig（v0.0.72 网络搜索自渲染 section）', () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('挂载渲染 section + type 下拉选择框 + apiKey SecretInput（mask 展示）', async () => {
    global.fetch = mockFetch([
      {
        match: '/config/app?group=web_search',
        handler: () => ({ value: { type: 'zhipu', credentials: { zhipu: { apiKey: 'k1' } } } }),
      },
      { match: '/config/plugin', handler: () => inventory([{ implId: 'zhipu' }]) },
    ]) as unknown as typeof fetch;

    const { container } = render(<SectionWebSearchConfig />);
    await waitFor(() => expect(screen.getByText('web_search · 网络搜索后端配置')).toBeTruthy());
    expect(getTypeSelect(container)).toBeTruthy();
    fireEvent.click(getTypeSelect(container));
    await waitFor(() => expect(screen.getByRole('option', { name: 'zhipu' })).toBeTruthy());
    expect(screen.getByRole('option', { name: 'zhipu' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(getTypeSelect(container));
    const root = container.querySelector('[data-mode]')!;
    expect(root.getAttribute('data-mode')).toBe('display');
    expect(root.getAttribute('data-empty')).toBe('false');
    expect(screen.getByText('**').textContent).toBe('**');
  });

  it('type 未配置（record null）→ 初始 clean；通过下拉选 type + commit apiKey → onDirtyChange(true)', async () => {
    global.fetch = mockFetch([
      { match: '/config/app?group=web_search', handler: () => ({ value: null }) },
      { match: '/config/plugin', handler: () => inventory([{ implId: 'zhipu' }]) },
    ]) as unknown as typeof fetch;

    const dirtySpy = vi.fn();
    const { container } = render(<SectionWebSearchConfig onDirtyChange={dirtySpy} />);
    await waitFor(() => expect(getTypeSelect(container)).toBeTruthy());
    // type 空 → 初始 clean
    await waitFor(() => {
      expect(dirtySpy).toHaveBeenCalledWith(false);
    });
    // 通过下拉选 zhipu
    fireEvent.click(getTypeSelect(container));
    await waitFor(() => expect(screen.getByRole('option', { name: 'zhipu' })).toBeTruthy());
    fireEvent.click(screen.getByRole('option', { name: 'zhipu' }));
    // 选 type 触发 dirty
    await waitFor(() => {
      const lastCall = dirtySpy.mock.calls[dirtySpy.mock.calls.length - 1];
      expect(lastCall?.[0]).toBe(true);
    });
    // apiKey 仍空
    expect(container.querySelector('[data-mode]')!.getAttribute('data-empty')).toBe('true');
    // commit 新 apiKey
    commitSecret('sk-...', 'newkey');
    expect(container.querySelector('[data-mode]')!.getAttribute('data-empty')).toBe('false');
    expect(screen.getByText('n****y').textContent).toBe('n****y');
  });

  it('ref.save() → PUT /config/app body 形状正确（group/items/key/data）', async () => {
    const fetchSpy = mockFetch([
      {
        match: '/config/app?group=web_search',
        handler: () => ({ value: { type: 'zhipu', credentials: { zhipu: { apiKey: 'old' } } } }),
      },
      { match: '/config/plugin', handler: () => inventory([{ implId: 'zhipu' }]) },
    ]);
    global.fetch = fetchSpy as unknown as typeof fetch;

    const ref = createRef<SectionSaveHandle>();
    render(<SectionWebSearchConfig ref={ref} />);
    await waitFor(() => expect(screen.getByText('***')).toBeTruthy());
    // SecretInput commit 新值触发 dirty
    commitSecret('***', 'newkey');
    // ref.save()
    await ref.current!.save();

    await waitFor(() => {
      const putCalls = fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
      expect(putCalls).toHaveLength(1);
      const body = JSON.parse((putCalls[0]![1] as RequestInit).body as string);
      expect(body.group).toBe('web_search');
      expect(body.items).toHaveLength(1);
      expect(body.items[0].key).toBe('default');
      expect(body.items[0].data).toEqual({
        type: 'zhipu',
        credentials: { zhipu: { apiKey: 'newkey' } },
      });
    });
  });

  it('无候选 impl → 渲染空态', async () => {
    global.fetch = mockFetch([
      { match: '/config/app?group=web_search', handler: () => ({ value: null }) },
      { match: '/config/plugin', handler: () => inventory([]) },
    ]) as unknown as typeof fetch;

    const { container } = render(<SectionWebSearchConfig />);
    await waitFor(() => expect(screen.getByText('未安装任何 web_search provider 插件')).toBeTruthy());
    expect(container.querySelector('button[aria-haspopup="listbox"]')).toBeNull();
  });

  it('ref.reset() → draft 回 baseline（apiKey mask 回到 orig 的 mask）', async () => {
    global.fetch = mockFetch([
      {
        match: '/config/app?group=web_search',
        handler: () => ({ value: { type: 'zhipu', credentials: { zhipu: { apiKey: 'orig' } } } }),
      },
      { match: '/config/plugin', handler: () => inventory([{ implId: 'zhipu' }]) },
    ]) as unknown as typeof fetch;

    const ref = createRef<SectionSaveHandle>();
    render(<SectionWebSearchConfig ref={ref} />);
    await waitFor(() => expect(screen.getByText('****')).toBeTruthy());
    expect(screen.getByText('****').textContent).toBe('****');
    // commit 新值 'changed' (len=7) → mask 'c*****d'
    commitSecret('****', 'changed');
    expect(screen.getByText('c*****d').textContent).toBe('c*****d');
    // reset → mask 回到 '****'（act 包裹让 React flush re-render）
    await act(async () => {
      ref.current!.reset();
    });
    expect(screen.getByText('****').textContent).toBe('****');
  });
});
