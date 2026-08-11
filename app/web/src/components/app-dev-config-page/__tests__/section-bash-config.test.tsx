/**
 * @vitest-environment jsdom
 * section-bash-config 单测（v0.0.296 新增；v0.0.316-fix 适配 forwardRef + onDirtyChange）
 * 参考: specs/tech/version_logs/v0.0.296/change_plan.md
 *
 * 校验点：
 *   - 挂载 GET `/config/app?group=runtime&key=bash_seatbelt` 读 baseline（null → true）
 *   - toggle 翻转 → onDirtyChange(true)
 *   - ref.save() → PUT body 形状正确（group=runtime, items=[{key:'bash_seatbelt', data:false}]）
 *   - ref.reset() → draft 回 baseline → onDirtyChange(false)
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { createRef, act } from 'react';
import { SectionBashConfig } from '../section-bash-config';
import type { SectionSaveHandle } from '../use-tab-dirty-aggregator';

beforeAll(async () => {
  await initI18n('zh-CN');
});

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

describe('SectionBashConfig（v0.0.296 Bash 工具沙箱开关）', () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('挂载 GET baseline null → toggle 默认开（true）', async () => {
    global.fetch = mockFetch([
      {
        match: '/config/app?group=runtime&key=bash_seatbelt',
        handler: () => ({ value: null }),
      },
    ]) as unknown as typeof fetch;

    render(<SectionBashConfig />);

    // 等待加载完成，toggle 显示开启态
    await waitFor(() => {
      const toggle = screen.getByRole('switch');
      expect(toggle.getAttribute('aria-checked')).toBe('true');
    });
  });

  it('挂载 GET baseline=false → toggle 默认关', async () => {
    global.fetch = mockFetch([
      {
        match: '/config/app?group=runtime&key=bash_seatbelt',
        handler: () => ({ value: false }),
      },
    ]) as unknown as typeof fetch;

    render(<SectionBashConfig />);

    await waitFor(() => {
      const toggle = screen.getByRole('switch');
      expect(toggle.getAttribute('aria-checked')).toBe('false');
    });
  });

  it('toggle 翻转 → onDirtyChange(true)', async () => {
    global.fetch = mockFetch([
      {
        match: '/config/app?group=runtime&key=bash_seatbelt',
        handler: () => ({ value: true }),
      },
    ]) as unknown as typeof fetch;

    const dirtySpy = vi.fn();
    render(<SectionBashConfig onDirtyChange={dirtySpy} />);

    // 等待加载完成
    await waitFor(() => {
      expect(screen.getByRole('switch')).toBeTruthy();
    });

    // 点击 toggle 翻转 true → false
    const toggle = screen.getByRole('switch');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    // dirty 上报（onDirtyChange 被调，最后一次参数为 true）
    await waitFor(() => {
      const lastCall = dirtySpy.mock.calls[dirtySpy.mock.calls.length - 1];
      expect(lastCall?.[0]).toBe(true);
    });
  });

  it('ref.save() → PUT body 形状正确（group=runtime, items bash_seatbelt）', async () => {
    const fetchSpy = mockFetch([
      {
        match: '/config/app?group=runtime&key=bash_seatbelt',
        handler: () => ({ value: true }),
      },
      {
        match: '/config/app',
        handler: () => ({ ok: true }),
      },
    ]);
    global.fetch = fetchSpy as unknown as typeof fetch;

    const ref = createRef<SectionSaveHandle>();
    render(<SectionBashConfig ref={ref} />);

    await waitFor(() => {
      expect(screen.getByRole('switch')).toBeTruthy();
    });

    // toggle 翻转 true → false
    fireEvent.click(screen.getByRole('switch'));
    // ref.save()
    await ref.current!.save();

    await waitFor(() => {
      const putCalls = fetchSpy.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCalls).toHaveLength(1);
      const body = JSON.parse((putCalls[0]![1] as RequestInit).body as string);
      expect(body.group).toBe('runtime');
      expect(body.items).toEqual([{ key: 'bash_seatbelt', data: false }]);
    });
  });

  it('ref.reset() → draft 回 baseline → onDirtyChange(false)', async () => {
    global.fetch = mockFetch([
      {
        match: '/config/app?group=runtime&key=bash_seatbelt',
        handler: () => ({ value: true }),
      },
    ]) as unknown as typeof fetch;

    const dirtySpy = vi.fn();
    const ref = createRef<SectionSaveHandle>();
    render(<SectionBashConfig ref={ref} onDirtyChange={dirtySpy} />);

    await waitFor(() => {
      expect(screen.getByRole('switch')).toBeTruthy();
    });

    // toggle 翻转 → dirty
    const toggle = screen.getByRole('switch');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    // reset → 回 baseline（act 包裹让 React flush re-render）
    await act(async () => {
      ref.current!.reset();
    });
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    // dirty 清除 → onDirtyChange(false)
    await waitFor(() => {
      const lastCall = dirtySpy.mock.calls[dirtySpy.mock.calls.length - 1];
      expect(lastCall?.[0]).toBe(false);
    });
  });
});
