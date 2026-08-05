/**
 * @vitest-environment jsdom
 * section-see-image-config 单测（v0.0.141 新增）
 * 参考: specs/ui/components/app-dev-config-page/section-see-image-config/_overview.md
 *       specs/ui/components/framework/primitive-secret-input.md（SecretInput 四态机）
 *
 * 校验点：
 *   - 挂载并发 GET `/config/app?group=see_image&key=default` + `/config/plugin`
 *   - 渲染 section + type 下拉选择框（implId-agnostic，动态选项）
 *   - type 切换（minimax_m3 ↔ zhipu_image）：凭证区域始终单个 apiKey 字段，切换不跳动
 *   - apiKey 已有值 → mask 展示；commit 新值 → draft 更新 + dirty + save 启用
 *   - type 未配置（record null）→ save 禁用分支
 *   - 无候选 impl → 渲染空态 + save 禁用
 *   - 点 save → PUT body 形状正确（group='see_image'）
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

/** inventory 嵌套形状：groups[].points[].impls[]（see_image_provider point） */
const inventory = (impls: Array<{ implId: string; description?: string }>) => ({
  tree: {
    plugins: [],
    groups: [
      {
        groupId: 'vision',
        points: [
          {
            pointId: 'see_image_provider',
            activated: true,
            impls: impls.map((i) => ({
              pluginId: 'see_image',
              pointId: 'see_image_provider',
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

describe('SectionSeeImageConfig（v0.0.141 看图理解自渲染 section）', () => {
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
        match: '/config/app?group=see_image',
        handler: () => ({ value: { type: 'minimax_m3', credentials: { minimax_m3: { apiKey: 'k1' } } } }),
      },
      { match: '/config/plugin', handler: () => inventory([{ implId: 'minimax_m3' }, { implId: 'zhipu_image' }]) },
    ]) as unknown as typeof fetch;

    const { container } = render(<SectionSeeImageConfigLazy />);
    await waitFor(() => expect(screen.getByText('see_image · 看图理解后端配置')).toBeTruthy());
    const select = getTypeSelect(container);
    expect(select).toBeTruthy();
    fireEvent.click(select);
    await waitFor(() => expect(screen.getByRole('option', { name: 'minimax_m3' })).toBeTruthy());
    expect(screen.getByRole('option', { name: 'minimax_m3' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('option', { name: 'zhipu_image' })).toBeTruthy();
    // 收起下拉，避免 popover 遮挡后续 apiKey 断言
    fireEvent.click(getTypeSelect(container));
    const root = container.querySelector('[data-mode]')!;
    expect(root.getAttribute('data-mode')).toBe('display');
    expect(root.getAttribute('data-empty')).toBe('false');
    // mask 展示：'k1' (len=2) → '**'
    expect(screen.getByText('**').textContent).toBe('**');
  });

  it('type 切换（minimax_m3 → zhipu_image）：凭证区始终单个 apiKey 字段', async () => {
    global.fetch = mockFetch([
      {
        match: '/config/app?group=see_image',
        handler: () => ({ value: { type: 'minimax_m3', credentials: { minimax_m3: { apiKey: 'mmkey' } } } }),
      },
      { match: '/config/plugin', handler: () => inventory([{ implId: 'minimax_m3' }, { implId: 'zhipu_image' }]) },
    ]) as unknown as typeof fetch;

    const { container } = render(<SectionSeeImageConfigLazy />);
    // 等待 mmkey 的 mask 展示（'mmkey' len=5 → 'm***y'）
    await waitFor(() => expect(screen.getByText('m***y')).toBeTruthy());
    // 切到 zhipu_image：minimax_m3 凭证字段消失，zhipu_image 凭证字段（空）出现
    fireEvent.click(getTypeSelect(container));
    await waitFor(() => expect(screen.getByRole('option', { name: 'zhipu_image' })).toBeTruthy());
    fireEvent.click(screen.getByRole('option', { name: 'zhipu_image' }));
    expect(screen.queryByText('m***y')).toBeNull();
    expect(container.querySelector('[data-mode]')!.getAttribute('data-empty')).toBe('true');
  });

  it('type 未配置（record null）→ save 禁用分支；通过下拉选 type + commit apiKey → save 启用', async () => {
    global.fetch = mockFetch([
      { match: '/config/app?group=see_image', handler: () => ({ value: null }) },
      { match: '/config/plugin', handler: () => inventory([{ implId: 'zhipu_image' }]) },
    ]) as unknown as typeof fetch;

    const { container } = render(<SectionSeeImageConfigLazy />);
    await waitFor(() => expect(getTypeSelect(container)).toBeTruthy());
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(getTypeSelect(container));
    await waitFor(() => expect(screen.getByRole('option', { name: 'zhipu_image' })).toBeTruthy());
    fireEvent.click(screen.getByRole('option', { name: 'zhipu_image' }));
    expect(save.disabled).toBe(false);
    expect(container.querySelector('[data-mode]')!.getAttribute('data-empty')).toBe('true');
    commitSecret('sk-...', 'newkey');
    expect(container.querySelector('[data-mode]')!.getAttribute('data-empty')).toBe('false');
    expect(screen.getByText('n****y').textContent).toBe('n****y');
    expect(save.disabled).toBe(false);
  });

  it('点 save → PUT /config/app body 形状正确（group=see_image/items/key/data）', async () => {
    const fetchSpy = mockFetch([
      {
        match: '/config/app?group=see_image',
        handler: () => ({ value: { type: 'zhipu_image', credentials: { zhipu_image: { apiKey: 'old' } } } }),
      },
      { match: '/config/plugin', handler: () => inventory([{ implId: 'zhipu_image' }]) },
    ]);
    global.fetch = fetchSpy as unknown as typeof fetch;

    render(<SectionSeeImageConfigLazy />);
    // 'old' len=3 → '***'
    await waitFor(() => expect(screen.getByText('***')).toBeTruthy());
    commitSecret('***', 'newkey');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const putCalls = fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
      expect(putCalls).toHaveLength(1);
      const body = JSON.parse((putCalls[0]![1] as RequestInit).body as string);
      expect(body.group).toBe('see_image');
      expect(body.items).toHaveLength(1);
      expect(body.items[0].key).toBe('default');
      expect(body.items[0].data).toEqual({
        type: 'zhipu_image',
        credentials: { zhipu_image: { apiKey: 'newkey' } },
      });
    });
  });

  it('无候选 impl → 渲染空态 + save 禁用', async () => {
    global.fetch = mockFetch([
      { match: '/config/app?group=see_image', handler: () => ({ value: null }) },
      { match: '/config/plugin', handler: () => inventory([]) },
    ]) as unknown as typeof fetch;

    const { container } = render(<SectionSeeImageConfigLazy />);
    await waitFor(() => expect(screen.getByText('未安装任何 see_image provider 插件')).toBeTruthy());
    expect(container.querySelector('button[aria-haspopup="listbox"]')).toBeNull();
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reset 把 draft 回退到 baseline（apiKey mask 回到 orig 的 mask）', async () => {
    global.fetch = mockFetch([
      {
        match: '/config/app?group=see_image',
        handler: () => ({ value: { type: 'minimax_m3', credentials: { minimax_m3: { apiKey: 'orig' } } } }),
      },
      { match: '/config/plugin', handler: () => inventory([{ implId: 'minimax_m3' }]) },
    ]) as unknown as typeof fetch;

    render(<SectionSeeImageConfigLazy />);
    // 'orig' len=4 → '****'
    await waitFor(() => expect(screen.getByText('****')).toBeTruthy());
    expect(screen.getByText('****').textContent).toBe('****');
    commitSecret('****', 'changed');
    expect(screen.getByText('c*****d').textContent).toBe('c*****d');
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    expect(screen.getByText('****').textContent).toBe('****');
  });
});

/** lazy import 避免 vi.mock 失效；直接 import 真组件 */
import { SectionSeeImageConfig } from '../section-see-image-config';
function SectionSeeImageConfigLazy() {
  return <SectionSeeImageConfig />;
}
