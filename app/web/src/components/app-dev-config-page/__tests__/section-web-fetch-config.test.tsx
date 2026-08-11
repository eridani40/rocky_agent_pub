/**
 * @vitest-environment jsdom
 * section-web-fetch-config 单测（v0.0.121 新增；v0.0.316-fix 适配 forwardRef + onDirtyChange）
 * 参考: specs/ui/components/app-dev-config-page/section-web-fetch-config/_overview.md
 *
 * 校验点：
 *   - 挂载 GET `/config/app?group=web` 整组，取 jinaApiKey baseline（GET 明文真值）
 *   - jinaApiKey 已有值 → SecretInput mask 展示
 *   - 从未配置 → SecretInput 空态
 *   - commit 新值 → onDirtyChange(true)；ref.save() → PUT 单 key 形状正确
 *   - ref.reset() → draft 回 baseline → onDirtyChange(false)
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { maskSecret } from '../../framework/primitives/secret-input';
import { createRef, act } from 'react';
import { SectionWebFetchConfig } from '../section-web-fetch-config';
import type { SectionSaveHandle } from '../use-tab-dirty-aggregator';

/** 测试用 GET 明文 jinaApiKey 真值 */
const REAL_JINA_KEY = 'jina_real_key_abcdef123456';

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
        handler: () => webGroupResponse(REAL_JINA_KEY),
      },
    ]) as unknown as typeof fetch;

    const { container } = render(<SectionWebFetchConfig />);
    await waitFor(() => expect(screen.getByText('web_fetch · 网络抓取服务配置')).toBeTruthy());

    const root = container.querySelector('[data-mode]')!;
    expect(root.getAttribute('data-mode')).toBe('display');
    expect(root.getAttribute('data-empty')).toBe('false');
    expect(screen.getByText(maskSecret(REAL_JINA_KEY)).textContent).toBe(maskSecret(REAL_JINA_KEY));
  });

  it('从未配置（items[] 无 jinaApiKey）→ SecretInput 空态', async () => {
    global.fetch = mockFetch([
      { match: '/config/app?group=web', handler: () => webGroupResponse() },
    ]) as unknown as typeof fetch;

    const { container } = render(<SectionWebFetchConfig />);
    await waitFor(() => expect(screen.getByText('web_fetch · 网络抓取服务配置')).toBeTruthy());

    const root = container.querySelector('[data-mode]')!;
    expect(root.getAttribute('data-empty')).toBe('true');
  });

  it('初始 clean → onDirtyChange(false)', async () => {
    global.fetch = mockFetch([
      { match: '/config/app?group=web', handler: () => webGroupResponse(REAL_JINA_KEY) },
    ]) as unknown as typeof fetch;

    const dirtySpy = vi.fn();
    render(<SectionWebFetchConfig onDirtyChange={dirtySpy} />);
    await waitFor(() => expect(screen.getByText(maskSecret(REAL_JINA_KEY))).toBeTruthy());

    // 初始 clean → onDirtyChange(false)
    await waitFor(() => {
      expect(dirtySpy).toHaveBeenCalledWith(false);
    });
  });

  it('commit 新值 → onDirtyChange(true)', async () => {
    global.fetch = mockFetch([
      { match: '/config/app?group=web', handler: () => webGroupResponse(REAL_JINA_KEY) },
    ]) as unknown as typeof fetch;

    const dirtySpy = vi.fn();
    render(<SectionWebFetchConfig onDirtyChange={dirtySpy} />);
    await waitFor(() => expect(screen.getByText(maskSecret(REAL_JINA_KEY))).toBeTruthy());

    commitSecret(maskSecret(REAL_JINA_KEY), 'newkey123');

    // dirty → onDirtyChange(true)
    await waitFor(() => {
      const lastCall = dirtySpy.mock.calls[dirtySpy.mock.calls.length - 1];
      expect(lastCall?.[0]).toBe(true);
    });
  });

  it('ref.save() → PUT 单 key 形状正确（group=web, key=jinaApiKey）', async () => {
    const fetchSpy = mockFetch([
      { match: '/config/app?group=web', handler: () => webGroupResponse(REAL_JINA_KEY) },
    ]);
    global.fetch = fetchSpy as unknown as typeof fetch;

    const ref = createRef<SectionSaveHandle>();
    render(<SectionWebFetchConfig ref={ref} />);
    await waitFor(() => expect(screen.getByText(maskSecret(REAL_JINA_KEY))).toBeTruthy());

    // commit 新值触发 dirty
    commitSecret(maskSecret(REAL_JINA_KEY), 'real-key-abc');
    // ref.save()
    await ref.current!.save();

    await waitFor(() => {
      const putCalls = fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
      expect(putCalls).toHaveLength(1);
      const body = JSON.parse((putCalls[0]![1] as RequestInit).body as string);
      expect(body.group).toBe('web');
      expect(body.key).toBe('jinaApiKey');
      expect(body.data).toBe('real-key-abc');
      expect(body.items).toBeUndefined();
    });
  });

  it('ref.reset() → draft 回 baseline → onDirtyChange(false)', async () => {
    global.fetch = mockFetch([
      { match: '/config/app?group=web', handler: () => webGroupResponse(REAL_JINA_KEY) },
    ]) as unknown as typeof fetch;

    const dirtySpy = vi.fn();
    const ref = createRef<SectionSaveHandle>();
    render(<SectionWebFetchConfig ref={ref} onDirtyChange={dirtySpy} />);
    await waitFor(() => expect(screen.getByText(maskSecret(REAL_JINA_KEY))).toBeTruthy());

    // commit 新值后 dirty
    commitSecret(maskSecret(REAL_JINA_KEY), 'newkey');
    await waitFor(() => {
      const lastCall = dirtySpy.mock.calls[dirtySpy.mock.calls.length - 1];
      expect(lastCall?.[0]).toBe(true);
    });

    // reset → draft 回 baseline（act 包裹让 React flush re-render）
    await act(async () => {
      ref.current!.reset();
    });
    // display 还原为 maskSecret(真值)
    expect(screen.getByText(maskSecret(REAL_JINA_KEY)).textContent).toBe(maskSecret(REAL_JINA_KEY));
    // dirty 清除 → onDirtyChange(false)
    await waitFor(() => {
      const lastCall = dirtySpy.mock.calls[dirtySpy.mock.calls.length - 1];
      expect(lastCall?.[0]).toBe(false);
    });
  });
});
