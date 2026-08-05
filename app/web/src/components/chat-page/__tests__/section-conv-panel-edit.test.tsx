// @vitest-environment jsdom
/**
 * section-conv-panel conv-item title 编辑态单测
 * 参考: specs/ui/components/chat-page/_overview.md §4.2（conv-item title 编辑态 + Props）
 *       / §5 交互8-9（编辑态 save/cancel/inactive 守卫 + 行点击展开）
 *
 * 覆盖 acceptanceCriteria：
 *   - active 点 title span → input 出现（编辑态）+ 预填当前 title
 *   - inactive 点 title → 无 input 出现（仍 span；走 onSelect 切 active）
 *   - 编辑态 Enter → 调 onRenameTitle(id, newValue) + 退回 span
 *   - 编辑态 Esc → 不调 onRenameTitle + 退回 span + 值恢复
 *   - 编辑态 blur → save（调 onRenameTitle）
 *   - 编辑态 trim 后空值 → 放弃（不调 onRenameTitle，退回 span）
 */
import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { ComponentConversationItem } from '../component-conversation-item';
import type { ChildrenView, Session } from '../types';
import { initI18n } from '../../../i18n';

// 启动 i18next instance：conv-item 内部用 useTranslation 查 common.timeAgo.*
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    title: '原始标题',
    status: 'active',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
    ...overrides,
  };
}

interface ItemOpts {
  active?: boolean;
  childrenView?: ChildrenView;
  onSelect?: () => void;
  onSelectSub?: () => void;
  onDelete?: () => void;
  onRefreshChildren?: () => void;
  onRenameTitle?: () => void;
}

function renderItem(session: Session, opts: ItemOpts = {}) {
  return render(
    <ComponentConversationItem
      session={session}
      active={opts.active ?? true}
      childrenView={opts.childrenView}
      onSelect={opts.onSelect ?? (() => {})}
      onSelectSub={opts.onSelectSub ?? (() => {})}
      onDelete={opts.onDelete ?? (() => {})}
      onContextMenu={() => {}}
      onRefreshChildren={opts.onRefreshChildren}
      onRenameTitle={opts.onRenameTitle ?? (() => {})}
    />,
  );
}

/** title span（带 title 属性的唯一 span） */
function titleSpan(container: HTMLElement): HTMLElement | null {
  return container.querySelector('span[title]');
}

/** title 编辑态 input */
function titleInput(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector('input[type="text"]');
}

describe('ComponentConversationItem title 编辑态', () => {
  it('title span 常驻（只读态）', () => {
    const { container } = renderItem(mkSession({ id: 's1', title: '我的会话' }));
    const span = titleSpan(container);
    expect(span).not.toBeNull();
    expect(span?.textContent).toBe('我的会话');
  });

  it('active 点 title span → 出现 input（编辑态）+ 预填当前 title', () => {
    const { container } = renderItem(mkSession({ id: 's1', title: '原标题' }), { active: true });
    fireEvent.click(titleSpan(container)!);
    const input = titleInput(container);
    expect(input).not.toBeNull();
    expect(input?.value).toBe('原标题');
    // span 已切换为 input（不在 DOM）
    expect(titleSpan(container)).toBeNull();
  });

  it('inactive 点 title → 无 input 出现（仍 span）+ 触发 onSelect 切 active', () => {
    const onSelect = vi.fn();
    const { container } = renderItem(mkSession({ id: 's1', title: '原标题' }), { active: false, onSelect });
    // 点 title span（冒泡到行 onClick）
    fireEvent.click(titleSpan(container)!);
    expect(titleInput(container)).toBeNull();
    expect(titleSpan(container)).not.toBeNull();
    expect(onSelect).toHaveBeenCalledWith('s1');
  });

  it('编辑态 Enter → 调 onRenameTitle(id, newValue) + 退回 span', () => {
    const onRenameTitle = vi.fn();
    const { container } = renderItem(mkSession({ id: 's1', title: '原标题' }), { active: true, onRenameTitle });
    fireEvent.click(titleSpan(container)!);
    const input = titleInput(container)!;
    fireEvent.change(input, { target: { value: '新名字' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRenameTitle).toHaveBeenCalledWith('s1', '新名字');
    // 退回 span
    expect(titleInput(container)).toBeNull();
    expect(titleSpan(container)).not.toBeNull();
  });

  it('编辑态 Esc → 不调 onRenameTitle + 退回 span（值恢复）', () => {
    const onRenameTitle = vi.fn();
    const { container } = renderItem(mkSession({ id: 's1', title: '原标题' }), { active: true, onRenameTitle });
    fireEvent.click(titleSpan(container)!);
    const input = titleInput(container)!;
    fireEvent.change(input, { target: { value: '半截输入' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRenameTitle).not.toHaveBeenCalled();
    // 退回 span，title 文本仍是原值
    expect(titleSpan(container)!.textContent).toBe('原标题');
    expect(titleInput(container)).toBeNull();
  });

  it('编辑态 blur → save（调 onRenameTitle）', () => {
    const onRenameTitle = vi.fn();
    const { container } = renderItem(mkSession({ id: 's1', title: '原标题' }), { active: true, onRenameTitle });
    fireEvent.click(titleSpan(container)!);
    const input = titleInput(container)!;
    fireEvent.change(input, { target: { value: '失焦保存' } });
    fireEvent.blur(input);
    expect(onRenameTitle).toHaveBeenCalledWith('s1', '失焦保存');
    expect(titleInput(container)).toBeNull();
  });

  it('编辑态 trim 后空值 → 放弃（不调 onRenameTitle，退回 span）', () => {
    const onRenameTitle = vi.fn();
    const { container } = renderItem(mkSession({ id: 's1', title: '原标题' }), { active: true, onRenameTitle });
    fireEvent.click(titleSpan(container)!);
    const input = titleInput(container)!;
    fireEvent.change(input, { target: { value: '   ' } }); // 全空白
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRenameTitle).not.toHaveBeenCalled();
    expect(titleInput(container)).toBeNull();
    expect(titleSpan(container)).not.toBeNull();
  });

  it('编辑态 input 点击 stopPropagation（不触发 conv-item 行 onSelect 二次切）', () => {
    const onSelect = vi.fn();
    const { container } = renderItem(mkSession({ id: 's1', title: '原标题' }), { active: true, onSelect });
    fireEvent.click(titleSpan(container)!);
    const input = titleInput(container)!;
    // 点击 input 不应触发 onSelect（input onClick stopPropagation）
    fireEvent.click(input);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
