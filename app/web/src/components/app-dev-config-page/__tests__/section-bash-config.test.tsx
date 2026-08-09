/**
 * @vitest-environment jsdom
 * section-bash-config 单测（v0.0.296 新增）
 * 参考: specs/tech/version_logs/v0.0.296/change_plan.md
 *
 * 校验点：
 *   - 挂载 GET `/config/app?group=runtime&key=bash_seatbelt` 读 baseline（null → true）
 *   - toggle 翻转 → dirty → save/reset 启用
 *   - save → PUT body 形状正确（group=runtime, items=[{key:'bash_seatbelt', data:false}]）
 *   - reset → draft 回 baseline → dirty 清除
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';

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

    render(<SectionBashConfigLazy />);

    // 等待加载完成，toggle 显示开启态
    await waitFor(() => {
      const toggle = screen.getByRole('switch');
      expect(toggle.getAttribute('aria-checked')).toBe('true');
    });

    // 初始 clean → save/reset 禁用
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    const reset = screen.getByRole('button', { name: '重置' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(reset.disabled).toBe(true);
  });

  it('挂载 GET baseline=false → toggle 默认关', async () => {
    global.fetch = mockFetch([
      {
        match: '/config/app?group=runtime&key=bash_seatbelt',
        handler: () => ({ value: false }),
      },
    ]) as unknown as typeof fetch;

    render(<SectionBashConfigLazy />);

    await waitFor(() => {
      const toggle = screen.getByRole('switch');
      expect(toggle.getAttribute('aria-checked')).toBe('false');
    });
  });

  it('toggle 翻转 → dirty → save/reset 启用', async () => {
    global.fetch = mockFetch([
      {
        match: '/config/app?group=runtime&key=bash_seatbelt',
        handler: () => ({ value: true }),
      },
    ]) as unknown as typeof fetch;

    render(<SectionBashConfigLazy />);

    // 等待加载完成
    await waitFor(() => {
      expect(screen.getByRole('switch')).toBeTruthy();
    });

    // 点击 toggle 翻转 true → false
    const toggle = screen.getByRole('switch');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    // dirty → save/reset 启用
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    const reset = screen.getByRole('button', { name: '重置' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect(reset.disabled).toBe(false);
  });

  it('save → PUT body 形状正确（group=runtime, items bash_seatbelt）', async () => {
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

    render(<SectionBashConfigLazy />);

    await waitFor(() => {
      expect(screen.getByRole('switch')).toBeTruthy();
    });

    // toggle 翻转 true → false
    fireEvent.click(screen.getByRole('switch'));
    // save
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

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

  it('reset → draft 回 baseline → dirty 清除', async () => {
    global.fetch = mockFetch([
      {
        match: '/config/app?group=runtime&key=bash_seatbelt',
        handler: () => ({ value: true }),
      },
    ]) as unknown as typeof fetch;

    render(<SectionBashConfigLazy />);

    await waitFor(() => {
      expect(screen.getByRole('switch')).toBeTruthy();
    });

    // toggle 翻转 → dirty
    const toggle = screen.getByRole('switch');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    // reset → 回 baseline
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    // dirty 清除 → save/reset 禁用
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});

import { SectionBashConfig } from '../section-bash-config';
function SectionBashConfigLazy() {
  return <SectionBashConfig />;
}
