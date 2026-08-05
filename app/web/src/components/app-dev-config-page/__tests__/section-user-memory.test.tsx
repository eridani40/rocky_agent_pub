// @vitest-environment jsdom
/**
 * section-user-memory 单测（v0.0.55 T5 · v0.0.112 scope 对外统一 global）
 * 参考: specs/ui/components/app-dev-config-page/section-user-memory.md
 *
 * 覆盖（与 section-memory-panel 区别：scope=global 无 sessionId）：
 *   - 挂载 → GET /memory/global（**无 sessionId query**，[v0.0.112] scope 对外 global）
 *   - 列 entry：渲染 entry name
 *   - 点新建按钮 → editor modal 打开
 *   - 点 entry 编辑按钮 → modal 打开 + name 锁定
 *   - 空 entries → 空态
 *   - [v0.0.112] scope 词汇标签含 global 不含 user
 */
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { SectionUserMemory } from '../section-user-memory';
import { initI18n } from '../../../i18n';

// 启动 i18next instance：memory-editor-modal 用 useTranslation('common')
beforeAll(async () => {
  await initI18n('zh-CN');
});

function resJson(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const entries = [
  {
    name: 'prefer-real-llm-tests',
    intro: '真 LLM 真服务',
    type: 'feedback' as const,
    body: '禁 mock LLM 全绿',
    why: '掩盖 bug',
    howToApply: '禁 mock',
    evolvable: false,
  },
];

describe('SectionUserMemory', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    cleanup();
  });

  it('挂载 → GET /memory/global（无 sessionId query）', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(resJson({ entries }));
    render(<SectionUserMemory />);
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toMatch(/\/memory\/global(\?|$)/);
    expect(String(url)).not.toContain('sessionId');
  });

  it('[v0.0.112] scope 词汇标签含 global 不含 user', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(resJson({ entries: [] }));
    render(<SectionUserMemory />);
    const label = await waitFor(() => screen.getByText('scope: global'));
    const text = (label.textContent ?? '').toLowerCase();
    expect(text).toContain('global');
    expect(text).not.toContain('user');
  });

  it('[v0.0.112] 编辑 evolvable=false 内置项：正文/开关无置灰，开关 aria-checked=false 可切', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(resJson({ entries }));
    render(<SectionUserMemory />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const toggle = await waitFor(() => screen.getByRole('switch'));
    // 无置灰：开关未禁用 + 正文可编辑（UI 全字段可编辑 UC-M4）
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    expect(toggle.getAttribute('aria-disabled')).not.toBe('true');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    const bodyEl = screen.getByPlaceholderText('正文') as HTMLTextAreaElement;
    expect(bodyEl.disabled).toBe(false);
    // 可切 false→true
    fireEvent.click(toggle);
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('列 entry：渲染 entry name', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(resJson({ entries }));
    render(<SectionUserMemory />);
    await waitFor(() => {
      expect(screen.getByText('prefer-real-llm-tests')).toBeTruthy();
    });
  });

  it('点新建按钮 → modal 打开', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(resJson({ entries }));
    render(<SectionUserMemory />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '+ 新建长期记忆' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: '+ 新建长期记忆' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    // 新建模式：name 输入可编辑（非 disabled）
    const nameInput = screen.getByPlaceholderText('prefer-vitest') as HTMLInputElement;
    expect(nameInput.disabled).toBe(false);
  });

  it('点 entry 编辑按钮 → modal 打开 + name 锁定（编辑模式）', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(resJson({ entries }));
    render(<SectionUserMemory />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const nameInput = (await waitFor(() =>
      screen.getByPlaceholderText('prefer-vitest'),
    )) as HTMLInputElement;
    expect(nameInput.disabled).toBe(true);
    expect(nameInput.value).toBe('prefer-real-llm-tests');
  });

  it('空 entries → 空态', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(resJson({ entries: [] }));
    render(<SectionUserMemory />);
    await waitFor(() => {
      expect(screen.getByText(/还没有全局长期记忆/)).toBeTruthy();
    });
  });
});
