// @vitest-environment jsdom
/**
 * component-memory-entry-card 单测
 * 参考: specs/ui/components/chat-page/component-memory-entry-card.md
 *
 * 覆盖：
 *   - 渲染 name + type badge + intro（折叠态，body/why/how 不渲染）
 *   - 点 expand → 渲染 body + why + how；再点折叠
 *   - 点 edit-btn → onEdit(entry) 调用
 *   - 点 archive-btn → onArchive(name) 调用
 *   - archived=true → 卡根 opacity-60 + 「已归档」badge
 *   - evolvable=false → 「手动」标记
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentMemoryEntryCard } from '../component-memory-entry-card';
import type { MemoryEntry } from '../../../lib/memory-api';
import { initI18n } from '../../../i18n';

// 启动 i18next instance：memory-entry-card 内部用 useTranslation 查 chat.memory.entryCard.* + common.action.edit
beforeAll(async () => {
  await initI18n('zh-CN');
});

const entry: MemoryEntry = {
  name: 'prefer-vitest',
  intro: '本 session 强调用 vitest',
  type: 'feedback',
  body: '用 vitest 跑测试',
  why: 'mock 会掩盖 bug',
  howToApply: '禁 bun test',
  evolvable: true,
  archived: false,
};

afterEach(() => cleanup());

/** 卡片根容器（div.memory-entry） */
function getRoot(): HTMLElement {
  return screen.getByText('prefer-vitest').closest('.memory-entry') as HTMLElement;
}

describe('ComponentMemoryEntryCard', () => {
  it('折叠态渲染 name + type + desc，不渲染 body/why/how', () => {
    render(
      <ComponentMemoryEntryCard
        entry={entry}
        onEdit={() => {}}
        onArchive={() => {}}
      />,
    );
    expect(getRoot()).toBeTruthy();
    expect(screen.getByText('prefer-vitest').textContent).toBe('prefer-vitest');
    expect(screen.getByText('feedback').textContent).toBe('feedback');
    expect(screen.getByText('本 session 强调用 vitest').textContent).toContain('vitest');
    expect(screen.queryByText('用 vitest 跑测试')).toBeNull();
    expect(screen.queryByText('mock 会掩盖 bug')).toBeNull();
    expect(screen.queryByText('禁 bun test')).toBeNull();
  });

  it('点 expand → 渲染 body + why + how；再点 → 折叠', () => {
    render(
      <ComponentMemoryEntryCard
        entry={entry}
        onEdit={() => {}}
        onArchive={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '展开详情' }));
    expect(screen.getByText('用 vitest 跑测试').textContent).toContain('vitest');
    expect(screen.getByText('mock 会掩盖 bug').textContent).toContain('mock');
    expect(screen.getByText('禁 bun test').textContent).toContain('bun test');
    // 再次点击 → 折叠（aria-label 变为 折叠详情）
    fireEvent.click(screen.getByRole('button', { name: '折叠详情' }));
    expect(screen.queryByText('用 vitest 跑测试')).toBeNull();
  });

  it('点 edit-btn → onEdit 调用（带 entry）', () => {
    const onEdit = vi.fn();
    render(
      <ComponentMemoryEntryCard
        entry={entry}
        onEdit={onEdit}
        onArchive={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith(entry);
  });

  it('点 archive-btn → onArchive 调用（带 name）', () => {
    const onArchive = vi.fn();
    render(
      <ComponentMemoryEntryCard
        entry={entry}
        onEdit={() => {}}
        onArchive={onArchive}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '归档' }));
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(onArchive).toHaveBeenCalledWith('prefer-vitest');
  });

  it('archived=true → opacity class + 「已归档」badge', () => {
    render(
      <ComponentMemoryEntryCard
        entry={{ ...entry, archived: true }}
        onEdit={() => {}}
        onArchive={() => {}}
      />,
    );
    const root = getRoot();
    expect(root.className).toContain('opacity-60');
    expect(root.textContent).toContain('已归档');
  });

  it('evolvable=false → 渲染「手动」标记；evolvable=true 不渲染', () => {
    const { rerender } = render(
      <ComponentMemoryEntryCard
        entry={{ ...entry, evolvable: false }}
        onEdit={() => {}}
        onArchive={() => {}}
      />,
    );
    expect(screen.getByText('手动')).toBeTruthy();
    rerender(
      <ComponentMemoryEntryCard
        entry={{ ...entry, evolvable: true }}
        onEdit={() => {}}
        onArchive={() => {}}
      />,
    );
    expect(screen.queryByText('手动')).toBeNull();
  });

  it('body 缺失时 expand 按钮禁用（不渲染 body）', () => {
    const noBody: MemoryEntry = { ...entry, body: '', why: undefined, howToApply: undefined };
    render(
      <ComponentMemoryEntryCard
        entry={noBody}
        onEdit={() => {}}
        onArchive={() => {}}
      />,
    );
    const expandBtn = screen.getByRole('button', { name: '展开详情' }) as HTMLButtonElement;
    expect(expandBtn.disabled).toBe(true);
  });
});
