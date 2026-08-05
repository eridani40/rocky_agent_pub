/**
 * @vitest-environment jsdom
 * section-web-fetch-config 单测（v0.0.121 新增）
 * 参考: specs/ui/components/app-dev-config-page/section-web-fetch-config/_overview.md
 *       specs/api/overall/08-web-tools.md §5（jinaApiKey 明文 GET + PUT 占位 merge）
 *       specs/api/overall/03-config-center.md §2.2（单 key PUT 语义）
 *
 * 校验点：
 *   - 挂载 GET `/config/app?group=web` 整组，取 jinaApiKey baseline（GET 明文真值）
 *   - jinaApiKey 已有值 → SecretInput mask 展示（maskSecret(真值)，非 ***）
 *   - 从未配置（items[] 无 jinaApiKey 条目）→ SecretInput 空态
 *   - commit 新值 → dirty → save 启用；点 save → PUT 单 key 形状正确
 *   - reset 把 draft 回退到 baseline
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { maskSecret } from '../../framework/primitives/secret-input';

/** 测试用 GET 明文 jinaApiKey 真值（GET 不再 redact） */
const REAL_JINA_KEY = 'jina_real_key_abcdef123456';

beforeAll(async () => {
  await initI18n('zh-CN');
});

/**
 * SecretInput commit helper：click display（mask 文本或 placeholder）→ 填值 → click 提交按钮。
 */
function commitSecret(displayText: string, nextValue: string) {
  fireEvent.click(screen.getByText(displayText));
  const field = screen.getByRole('textbox') as HTMLInputElement;
  fireEvent.change(field, { target: { value: nextValue } });
  fireEvent.click(screen.getByRole('button', { name: '提交' }));
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

/** 生成 GET /config/app?group=web 整组响应（jinaApiKey 可选） */
function webGroupResponse(jinaApiKey?: string) {
  const items = jinaApiKey !== undefined
    ? [{ key: 'jinaApiKey', data: jinaApiKey }]
    : [];
  return { items };
}

describe('SectionWebFetchConfig（v0.0.121 网络抓取 section）', () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('挂载渲染 section + jinaApiKey SecretInput（GET 明文 → mask 展示）', async () => {
    global.fetch = mockFetch([
      {
        match: '/config/app?group=web',
        handler: () => webGroupResponse(REAL_JINA_KEY),  // GET 明文真值
      },
    ]) as unknown as typeof fetch;

    const { container } = render(<SectionWebFetchConfigLazy />);
    await waitFor(() => expect(screen.getByText('web_fetch · 网络抓取服务配置')).toBeTruthy());

    // SecretInput 根节点：data-mode='display'，data-empty='false'（真值非空）
    const root = container.querySelector('[data-mode]')!;
    expect(root.getAttribute('data-mode')).toBe('display');
    expect(root.getAttribute('data-empty')).toBe('false');

    // display = maskSecret(真值)（len>8 → 首4 + * + 末4），不是 ***
    expect(screen.getByText(maskSecret(REAL_JINA_KEY)).textContent).toBe(maskSecret(REAL_JINA_KEY));
  });

  it('从未配置（items[] 无 jinaApiKey）→ SecretInput 空态', async () => {
    global.fetch = mockFetch([
      { match: '/config/app?group=web', handler: () => webGroupResponse() },  // 无 jinaApiKey 条目
    ]) as unknown as typeof fetch;

    const { container } = render(<SectionWebFetchConfigLazy />);
    await waitFor(() => expect(screen.getByText('web_fetch · 网络抓取服务配置')).toBeTruthy());

    const root = container.querySelector('[data-mode]')!;
    expect(root.getAttribute('data-empty')).toBe('true');
  });

  it('初始 clean → save/reset 禁用', async () => {
    global.fetch = mockFetch([
      { match: '/config/app?group=web', handler: () => webGroupResponse(REAL_JINA_KEY) },
    ]) as unknown as typeof fetch;

    render(<SectionWebFetchConfigLazy />);
    await waitFor(() => expect(screen.getByText(maskSecret(REAL_JINA_KEY))).toBeTruthy());

    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    const reset = screen.getByRole('button', { name: '重置' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(reset.disabled).toBe(true);
  });

  it('commit 新值 → dirty → save/reset 启用', async () => {
    global.fetch = mockFetch([
      { match: '/config/app?group=web', handler: () => webGroupResponse(REAL_JINA_KEY) },
    ]) as unknown as typeof fetch;

    render(<SectionWebFetchConfigLazy />);
    await waitFor(() => expect(screen.getByText(maskSecret(REAL_JINA_KEY))).toBeTruthy());

    commitSecret(maskSecret(REAL_JINA_KEY), 'newkey123');

    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    const reset = screen.getByRole('button', { name: '重置' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect(reset.disabled).toBe(false);
  });

  it('点 save → PUT 单 key 形状正确（group=web, key=jinaApiKey）', async () => {
    const fetchSpy = mockFetch([
      { match: '/config/app?group=web', handler: () => webGroupResponse(REAL_JINA_KEY) },
    ]);
    global.fetch = fetchSpy as unknown as typeof fetch;

    render(<SectionWebFetchConfigLazy />);
    await waitFor(() => expect(screen.getByText(maskSecret(REAL_JINA_KEY))).toBeTruthy());

    // commit 新值触发 dirty
    commitSecret(maskSecret(REAL_JINA_KEY), 'real-key-abc');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const putCalls = fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
      expect(putCalls).toHaveLength(1);
      const body = JSON.parse((putCalls[0]![1] as RequestInit).body as string);
      // 单 key PUT（不是整组 items[]）
      expect(body.group).toBe('web');
      expect(body.key).toBe('jinaApiKey');
      expect(body.data).toBe('real-key-abc');
      // 无 items 字段
      expect(body.items).toBeUndefined();
    });
  });

  it('reset → draft 回 baseline（SecretInput 还原展示）', async () => {
    global.fetch = mockFetch([
      { match: '/config/app?group=web', handler: () => webGroupResponse(REAL_JINA_KEY) },
    ]) as unknown as typeof fetch;

    render(<SectionWebFetchConfigLazy />);
    await waitFor(() => expect(screen.getByText(maskSecret(REAL_JINA_KEY))).toBeTruthy());

    // commit 新值后 dirty
    commitSecret(maskSecret(REAL_JINA_KEY), 'newkey');
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false);

    // reset → draft 回 baseline（GET 明文真值）
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    // save/reset 回到禁用
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    // display 还原为 maskSecret(真值)
    expect(screen.getByText(maskSecret(REAL_JINA_KEY)).textContent).toBe(maskSecret(REAL_JINA_KEY));
  });
});

import { SectionWebFetchConfig } from '../section-web-fetch-config';
function SectionWebFetchConfigLazy() {
  return <SectionWebFetchConfig />;
}
