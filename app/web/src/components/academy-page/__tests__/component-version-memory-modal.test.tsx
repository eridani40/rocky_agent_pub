/**
 * @vitest-environment jsdom
 * component-version-memory-modal 单测 —— v0.0.219 版本 memory 只读弹层
 * 参考: specs/ui/components/chat-page/component-memory-modal.md（样式源）
 *
 * 覆盖：
 * - L3 modal 不变式：Portal 根 div pointer-events-auto（缺失 → 全弹层按钮不可点）。
 * - 只读渲染：entries → 显 name + preview；空 → 显「暂无记忆条目」。
 * - 关闭：遮罩 / ✕ 按钮 → onClose。
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentVersionMemoryModal } from '../component-version-memory-modal';
import type { MemoryEntrySummary } from '../../../lib/academy-api';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

/** Portal 根 div（挂在 overlay-root 下，不在 render container 内） */
function overlayRootDiv(): HTMLElement {
  const el = document.querySelector('#overlay-root > div') as HTMLElement;
  expect(el).toBeTruthy();
  return el;
}

describe('ComponentVersionMemoryModal — L3 modal 不变式', () => {
  it('Portal 根 div className 含 pointer-events-auto + fixed + z-modal', () => {
    render(
      <ComponentVersionMemoryModal
        entries={[{ name: 'a.md', size: 100, preview: 'p-a' }]}
        versionLabel="v1.0"
        onClose={vi.fn()}
      />,
    );
    const root = overlayRootDiv();
    expect(root.className).toContain('pointer-events-auto');
    expect(root.className).toContain('fixed');
    expect(root.className).toContain('z-[var(--z-modal)]');
  });
});

describe('ComponentVersionMemoryModal — 只读渲染', () => {
  it('entries 非空 → 渲染每条 name + preview（data-testid 标记）', () => {
    const entries: MemoryEntrySummary[] = [
      { name: 'memory-a.md', size: 120, preview: '记忆 A 预览' },
      { name: 'memory-b.md', size: 240, preview: '记忆 B 预览' },
    ];
    render(<ComponentVersionMemoryModal entries={entries} versionLabel="v1.0" onClose={vi.fn()} />);
    expect(screen.getByText('memory-a.md')).toBeTruthy();
    expect(screen.getByText('memory-b.md')).toBeTruthy();
    expect(screen.getByText('记忆 A 预览')).toBeTruthy();
    expect(screen.getByText('记忆 B 预览')).toBeTruthy();
    // 两条 entry 卡片
    expect(screen.getAllByTestId('academy-version-memory-entry').length).toBe(2);
  });

  it('entries 空 → 显「暂无记忆条目」', () => {
    render(<ComponentVersionMemoryModal entries={[]} versionLabel="v1.0" onClose={vi.fn()} />);
    expect(screen.getByText('暂无记忆条目')).toBeTruthy();
    expect(screen.queryByTestId('academy-version-memory-entry')).toBeNull();
  });
});

describe('ComponentVersionMemoryModal — 关闭交互', () => {
  it('✕ 按钮 → onClose', () => {
    const onClose = vi.fn();
    render(<ComponentVersionMemoryModal entries={[]} versionLabel="v1.0" onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('关闭'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('遮罩点击 → onClose', () => {
    const onClose = vi.fn();
    render(<ComponentVersionMemoryModal entries={[]} versionLabel="v1.0" onClose={onClose} />);
    fireEvent.click(overlayRootDiv());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
