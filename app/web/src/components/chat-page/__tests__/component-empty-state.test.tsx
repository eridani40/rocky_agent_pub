// @vitest-environment jsdom
/**
 * ComponentEmptyState 单测 —— 严肃化 idle hero
 * 参考: specs/ui/components/chat-page/component-empty-state.md
 *       specs/ui/regulation/03-principles.md §3（严肃基调：无 mascot / 无动画 / 无 emoji）
 *
 * 覆盖：
 *   - hero-orb / hero-eyebrow / hero-sub / CTA / quick-row 结构齐全
 *   - CTA 点击 → onNewConversation 被调
 *   - quick-chip 点击 → onNewConversation 被调（点击等同 CTA，用户裁决）
 *   - i18n key：eyebrow / subtitle / chipFile / chipResearch / chipCode 全走 t()
 *   - INV-3（无 animate class）/ INV-4（无 font-serif）/ 无 hex 硬编码
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentEmptyState } from '../component-empty-state';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe('ComponentEmptyState idle hero', () => {
  it('渲染根容器（flex-col 居中）', () => {
    const { container } = render(<ComponentEmptyState onNewConversation={() => {}} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toBeTruthy();
    expect(root.className).toContain('flex-col');
    expect(root.className).toContain('items-center');
  });

  it('hero-orb：80×80 rounded-[22px] + 白色 ChatIcon 36px + --brand-grad 背景', () => {
    const { container } = render(<ComponentEmptyState onNewConversation={() => {}} />);
    const orb = container.querySelector('div.w-20') as HTMLDivElement;
    expect(orb).toBeTruthy();
    expect(orb.className).toContain('w-20');
    expect(orb.className).toContain('h-20');
    expect(orb.className).toContain('rounded-[22px]');
    expect(orb.style.background).toBe('var(--brand-grad)');
    // 内含 chat SVG，且为 36px（size=36 = width/height 属性）
    const svg = orb.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('width')).toBe('36');
    expect(svg?.getAttribute('height')).toBe('36');
    // 白色继承走 text-white class（currentColor）
    expect(svg?.getAttribute('class') ?? svg?.className.toString()).toContain('text-white');
  });

  it('hero-eyebrow：mono 11px uppercase muted-2 + tracking 0.24em + 文案 Playground', () => {
    render(<ComponentEmptyState onNewConversation={() => {}} />);
    const eyebrow = screen.getByText('Playground') as HTMLDivElement;
    expect(eyebrow.className).toContain('font-mono');
    expect(eyebrow.className).toContain('text-[11px]');
    expect(eyebrow.className).toContain('uppercase');
    expect(eyebrow.style.color).toBe('var(--muted-2)');
    expect(eyebrow.style.letterSpacing).toBe('0.24em');
    expect(eyebrow.textContent).toBe('Playground');
  });

  it('hero-sub：14px muted 居中 max-w-[400px] + 副文案渲染', () => {
    render(<ComponentEmptyState onNewConversation={() => {}} />);
    const sub = screen.getByText(/点击下方按钮/) as HTMLDivElement;
    expect(sub.className).toContain('text-[14px]');
    expect(sub.className).toContain('text-center');
    expect(sub.className).toContain('max-w-[400px]');
    expect(sub.style.color).toBe('var(--muted)');
    expect(sub.textContent).toContain('点击下方按钮');
  });

  it('CTA 存在并含 PlusIcon + i18n 文案', () => {
    render(<ComponentEmptyState onNewConversation={() => {}} />);
    const cta = screen.getByRole('button', { name: '新建对话' });
    expect(cta.tagName).toBe('BUTTON');
    expect(cta.textContent).toContain('新建对话');
    expect(cta.querySelector('svg')).toBeTruthy();
  });

  it('点击 CTA → onNewConversation 被调一次', () => {
    const onNew = vi.fn();
    render(<ComponentEmptyState onNewConversation={onNew} />);
    fireEvent.click(screen.getByRole('button', { name: '新建对话' }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('CTA aria-label 用 i18n 文案（无障碍）', () => {
    render(<ComponentEmptyState onNewConversation={() => {}} />);
    expect(screen.getByRole('button', { name: '新建对话' }).getAttribute('aria-label')).toContain('新建对话');
  });

  it('quick-row：3 个 chip 顺序 file/research/code + 文案与彩点颜色对齐设计稿', () => {
    render(<ComponentEmptyState onNewConversation={() => {}} />);
    const chipFile = screen.getByRole('button', { name: /分析一个文件/ }) as HTMLButtonElement;
    const chipResearch = screen.getByRole('button', { name: /查资料并总结/ }) as HTMLButtonElement;
    const chipCode = screen.getByRole('button', { name: /帮我写代码/ }) as HTMLButtonElement;

    // quick-row 容器含 3 个 chip
    const row = chipFile.parentElement!;
    expect(row.querySelectorAll('button').length).toBe(3);

    expect(chipFile.textContent).toContain('分析一个文件');
    expect(chipResearch.textContent).toContain('查资料并总结');
    expect(chipCode.textContent).toContain('帮我写代码');

    // 彩点颜色走 var(--hue-*)，dot span 的 inline style
    const dotFile = chipFile.querySelector('span[aria-hidden]') as HTMLSpanElement;
    const dotResearch = chipResearch.querySelector('span[aria-hidden]') as HTMLSpanElement;
    const dotCode = chipCode.querySelector('span[aria-hidden]') as HTMLSpanElement;
    expect(dotFile.style.background).toBe('var(--hue-blue)');
    expect(dotResearch.style.background).toBe('var(--hue-green)');
    expect(dotCode.style.background).toBe('var(--hue-violet)');
  });

  it('点击任一 quick-chip → onNewConversation 被调（点击等同 CTA）', () => {
    const onNew = vi.fn();
    render(<ComponentEmptyState onNewConversation={onNew} />);
    fireEvent.click(screen.getByRole('button', { name: /分析一个文件/ }));
    fireEvent.click(screen.getByRole('button', { name: /查资料并总结/ }));
    fireEvent.click(screen.getByRole('button', { name: /帮我写代码/ }));
    expect(onNew).toHaveBeenCalledTimes(3);
  });

  it('quick-chip：pill 胶囊 rounded-full + border/surface 走 token', () => {
    render(<ComponentEmptyState onNewConversation={() => {}} />);
    const chip = screen.getByRole('button', { name: /分析一个文件/ }) as HTMLButtonElement;
    expect(chip.className).toContain('rounded-full');
    expect(chip.style.background).toBe('var(--surface)');
    expect(chip.style.color).toBe('var(--fg-3)');
    // 边框声明在 inline style border shorthand
    expect(chip.style.border).toContain('var(--border)');
  });

  it('未渲染大标题（与 CTA 语义重复，用户裁决 2026-07-17）', () => {
    render(<ComponentEmptyState onNewConversation={() => {}} />);
    expect(screen.queryByText(/开始一段新对话/)).toBeNull();
    expect(screen.queryByText(/机器人旁边/)).toBeNull();
  });

  it('INV-3 / INV-4：整个 empty-state DOM 无 animate class / 无 font-serif', () => {
    const { container } = render(<ComponentEmptyState onNewConversation={() => {}} />);
    const html = container.innerHTML;
    expect(html).not.toMatch(/animate-\[/);
    expect(html).not.toMatch(/font-serif/);
  });

  it('CTA 走 --btn-primary token（无 hex 硬编码）', () => {
    render(<ComponentEmptyState onNewConversation={() => {}} />);
    const cta = screen.getByRole('button', { name: '新建对话' }) as HTMLButtonElement;
    expect(cta.style.background).toBe('var(--btn-primary-bg)');
    expect(cta.style.color).toBe('var(--btn-primary-fg)');
  });
});
