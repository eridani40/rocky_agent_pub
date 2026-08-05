/**
 * @vitest-environment jsdom
 * section-web-search-config 单测（v0.0.72 新增；v0.0.90.ui apiKey 改 SecretInput）
 * 参考: specs/ui/components/app-dev-config-page/section-web-search-config/_overview.md
 *       specs/ui/components/framework/primitive-secret-input.md（SecretInput 四态机）
 *
 * 校验点：
 *   - 挂载并发 GET `/config/app?group=web_search&key=default` + `/config/plugin`
 *   - 渲染 section + type 下拉 + apiKey SecretInput
 *   - apiKey 已有值 → mask 展示；commit 新值 → draft 更新 + dirty + save 启用
 *   - 选中 type=zhipu + commit apiKey → save 启用；点 save → PUT body 形状正确
 *   - type 未配置（record null）→ save 禁用分支
 *   - 无候选 impl → 渲染空态 + save 禁用
 *
 * mock fetch（按 url 子串路由），不调真实 API。
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

/**
 * SecretInput commit 流转 helper：click display（mask 文本或 placeholder）→ 填值 → click 提交按钮。
 */
function commitSecret(displayText: string, nextValue: string) {
  fireEvent.click(screen.getByText(displayText));
  const field = screen.getByRole('textbox') as HTMLInputElement;
  fireEvent.change(field, { target: { value: nextValue } });
  fireEvent.click(screen.getByRole('button', { name: '提交' }));
}

/** 获取 type 下拉 trigger（aria-haspopup=listbox 的 button） */
function getTypeSelect(container: HTMLElement) {
  return container.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement;
}

/** 构造 fetch mock（按 url 子串路由） */
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

/** inventory 嵌套形状：groups[].points[].impls[]（v0.0.71 D3） */
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

    const { container } = render(<SectionWebSearchConfigLazy />);
    await waitFor(() => expect(screen.getByText('web_search · 网络搜索后端配置')).toBeTruthy());
    expect(getTypeSelect(container)).toBeTruthy();
    // 当前选中项由展开态 option 的 aria-selected 反映
    fireEvent.click(getTypeSelect(container));
    await waitFor(() => expect(screen.getByRole('option', { name: 'zhipu' })).toBeTruthy());
    expect(screen.getByRole('option', { name: 'zhipu' }).getAttribute('aria-selected')).toBe('true');
    // 收起下拉，避免 popover 遮挡后续 apiKey 断言
    fireEvent.click(getTypeSelect(container));
    // apiKey 是 SecretInput：根 data-mode='display' + data-empty='false'
    const root = container.querySelector('[data-mode]')!;
    expect(root.getAttribute('data-mode')).toBe('display');
    expect(root.getAttribute('data-empty')).toBe('false');
    // mask 展示：'k1' (len=2) → '**'
    expect(screen.getByText('**').textContent).toBe('**');
  });

  it('type 未配置（record null）→ save 禁用分支；通过下拉选 type + commit apiKey → save 启用', async () => {
    global.fetch = mockFetch([
      { match: '/config/app?group=web_search', handler: () => ({ value: null }) },
      { match: '/config/plugin', handler: () => inventory([{ implId: 'zhipu' }]) },
    ]) as unknown as typeof fetch;

    const { container } = render(<SectionWebSearchConfigLazy />);
    await waitFor(() => expect(getTypeSelect(container)).toBeTruthy());
    // type 空 → save 禁用
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // 通过下拉选 zhipu：先 click trigger 展开，再 click option
    fireEvent.click(getTypeSelect(container));
    await waitFor(() => expect(screen.getByRole('option', { name: 'zhipu' })).toBeTruthy());
    fireEvent.click(screen.getByRole('option', { name: 'zhipu' }));
    expect(save.disabled).toBe(false);
    // 此时 apiKey 仍空（SecretInput data-empty='true'）
    expect(container.querySelector('[data-mode]')!.getAttribute('data-empty')).toBe('true');
    // commit 一个新 apiKey：dirty 持续 + secret 落入 draft.credentials
    commitSecret('sk-...', 'newkey');
    expect(container.querySelector('[data-mode]')!.getAttribute('data-empty')).toBe('false');
    // mask('newkey') len=6 → 'n****y'
    expect(screen.getByText('n****y').textContent).toBe('n****y');
    expect(save.disabled).toBe(false);
  });

  it('点 save → PUT /config/app body 形状正确（group/items/key/data）', async () => {
    const fetchSpy = mockFetch([
      {
        match: '/config/app?group=web_search',
        handler: () => ({ value: { type: 'zhipu', credentials: { zhipu: { apiKey: 'old' } } } }),
      },
      { match: '/config/plugin', handler: () => inventory([{ implId: 'zhipu' }]) },
    ]);
    global.fetch = fetchSpy as unknown as typeof fetch;

    render(<SectionWebSearchConfigLazy />);
    // 'old' len=3 → '***'
    await waitFor(() => expect(screen.getByText('***')).toBeTruthy());
    // SecretInput commit 新值触发 dirty
    commitSecret('***', 'newkey');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

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

  it('无候选 impl → 渲染空态 + save 禁用', async () => {
    global.fetch = mockFetch([
      { match: '/config/app?group=web_search', handler: () => ({ value: null }) },
      { match: '/config/plugin', handler: () => inventory([]) },
    ]) as unknown as typeof fetch;

    const { container } = render(<SectionWebSearchConfigLazy />);
    await waitFor(() => expect(screen.getByText('未安装任何 web_search provider 插件')).toBeTruthy());
    // 无候选 impl → 空态分支：type 下拉不渲染
    expect(container.querySelector('button[aria-haspopup="listbox"]')).toBeNull();
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reset 把 draft 回退到 baseline（apiKey mask 回到 orig 的 mask）', async () => {
    global.fetch = mockFetch([
      {
        match: '/config/app?group=web_search',
        handler: () => ({ value: { type: 'zhipu', credentials: { zhipu: { apiKey: 'orig' } } } }),
      },
      { match: '/config/plugin', handler: () => inventory([{ implId: 'zhipu' }]) },
    ]) as unknown as typeof fetch;

    render(<SectionWebSearchConfigLazy />);
    // 'orig' (len=4) → mask '****'
    await waitFor(() => expect(screen.getByText('****')).toBeTruthy());
    expect(screen.getByText('****').textContent).toBe('****');
    // commit 新值 'changed' (len=7) → mask 'c*****d'
    commitSecret('****', 'changed');
    expect(screen.getByText('c*****d').textContent).toBe('c*****d');
    // reset 回 baseline → mask 回到 '****'
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    expect(screen.getByText('****').textContent).toBe('****');
  });
});

/** lazy import 避免 vi.mock 失效；直接 import 真组件 */
import { SectionWebSearchConfig } from '../section-web-search-config';
function SectionWebSearchConfigLazy() {
  return <SectionWebSearchConfig />;
}
