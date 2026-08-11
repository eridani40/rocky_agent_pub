/**
 * @vitest-environment jsdom
 * section-logs-config 单测（v0.0.317 新增）
 * 参考: section-bash-config.test.tsx（同构 forwardRef + onDirtyChange 范式）
 *
 * 校验点：
 *   - 挂载 GET `/config/app?group=logs` 读 baseline（缺省 toggle 默认 false）
 *   - toggle 翻转 → onDirtyChange(true)
 *   - ref.save() → PUT body 形状正确（group=logs, items=[{key, data}, ...]）
 *   - ref.reset() → draft 回 baseline → onDirtyChange(false)
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { createRef, act } from 'react';
import { SectionLogsConfig } from '../section-logs-config';
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

/** logs group GET 返回的 items（模拟后端 record 列表） */
function logsItems(values: Record<string, unknown>) {
  return { items: Object.entries(values).map(([key, data]) => ({ key, data })) };
}

describe('SectionLogsConfig（v0.0.317 logs toggle 进 dirty）', () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('挂载 GET baseline → toggle 显示对应开关态', async () => {
    global.fetch = mockFetch([
      {
        match: '/config/app?group=logs',
        handler: () => logsItems({ enableLlmRequestLog: true, enableErrorLog: false }),
      },
    ]) as unknown as typeof fetch;

    render(<SectionLogsConfig />);

    // 等待加载完成，至少有 switch 元素
    await waitFor(() => {
      expect(screen.getAllByRole('switch').length).toBeGreaterThan(0);
    });
    // 第一个 toggle（enableLlmRequestLog）= true
    const switches = screen.getAllByRole('switch');
    expect(switches[0]!.getAttribute('aria-checked')).toBe('true');
  });

  it('toggle 翻转 → onDirtyChange(true)', async () => {
    global.fetch = mockFetch([
      {
        match: '/config/app?group=logs',
        handler: () => logsItems({ enableLlmRequestLog: false }),
      },
    ]) as unknown as typeof fetch;

    const dirtySpy = vi.fn();
    render(<SectionLogsConfig onDirtyChange={dirtySpy} />);

    await waitFor(() => {
      expect(screen.getAllByRole('switch').length).toBeGreaterThan(0);
    });

    // 点击第一个 toggle 翻转 false → true
    const toggle = screen.getAllByRole('switch')[0]!;
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    // dirty 上报
    await waitFor(() => {
      const lastCall = dirtySpy.mock.calls[dirtySpy.mock.calls.length - 1];
      expect(lastCall?.[0]).toBe(true);
    });
  });

  it('ref.save() → PUT body 形状正确（group=logs, items 含全部 key）', async () => {
    const fetchSpy = mockFetch([
      {
        match: '/config/app?group=logs',
        handler: () => logsItems({ enableLlmRequestLog: false }),
      },
      {
        match: '/config/app',
        handler: () => ({ ok: true }),
      },
    ]);
    global.fetch = fetchSpy as unknown as typeof fetch;

    const ref = createRef<SectionSaveHandle>();
    render(<SectionLogsConfig ref={ref} />);

    await waitFor(() => {
      expect(screen.getAllByRole('switch').length).toBeGreaterThan(0);
    });

    // toggle 翻转 false → true
    fireEvent.click(screen.getAllByRole('switch')[0]!);
    // ref.save()
    await ref.current!.save();

    await waitFor(() => {
      const putCalls = fetchSpy.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCalls).toHaveLength(1);
      const body = JSON.parse((putCalls[0]![1] as RequestInit).body as string);
      expect(body.group).toBe('logs');
      // items 至少含 enableLlmRequestLog
      const llmItem = body.items.find((i: { key: string }) => i.key === 'enableLlmRequestLog');
      expect(llmItem).toBeDefined();
      expect(llmItem.data).toBe(true);
    });
  });

  it('ref.reset() → draft 回 baseline → onDirtyChange(false)', async () => {
    global.fetch = mockFetch([
      {
        match: '/config/app?group=logs',
        handler: () => logsItems({ enableLlmRequestLog: true }),
      },
    ]) as unknown as typeof fetch;

    const dirtySpy = vi.fn();
    const ref = createRef<SectionSaveHandle>();
    render(<SectionLogsConfig ref={ref} onDirtyChange={dirtySpy} />);

    await waitFor(() => {
      expect(screen.getAllByRole('switch').length).toBeGreaterThan(0);
    });

    // toggle 翻转 true → false
    const toggle = screen.getAllByRole('switch')[0]!;
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    // reset → 回 baseline（true）
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
