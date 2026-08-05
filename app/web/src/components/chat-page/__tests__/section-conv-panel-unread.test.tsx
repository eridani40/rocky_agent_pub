// @vitest-environment jsdom
/**
 * section-conv-panel 未读红点单测（v0.0.27）
 * 参考: specs/ui/components/chat-page/_overview.md §4.2（conv-item unread prop + 红点视觉）/ §5 交互7（active 隐藏）/ §8（视觉基线 var(--danger)）
 *
 * 覆盖 acceptanceCriteria：
 *   - 红点条件渲染 4 组合（unread × active）
 *   - 红点视觉 token（absolute / 7px / var(--danger) / relative 容器）
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SectionConvPanel } from '../section-conv-panel';
import type { Session } from '../types';
import { initI18n } from '../../../i18n';

// 启动 i18next instance：conv-item 内部用 useTranslation 查 common.timeAgo.*
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

/** 构造 Session（含 unread 字段） */
function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    title: '会话 1',
    status: 'active',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:00.000Z',
    ...overrides,
  };
}

/** 渲染 conv-panel（单 session + 注入 activeId/unread） */
function renderPanel(session: Session, activeId: string | null) {
  return render(
    <SectionConvPanel
      sessions={[session]}
      activeId={activeId}
      childrenByParent={{}}
      onSelect={() => {}}
      onSelectSub={() => {}}
      onCreate={() => {}}
      onDelete={() => {}}
    />,
  );
}

/** 通过会话标题定位 conv-item 行容器 */
function getConvItem(title = '会话 1'): HTMLElement {
  return screen.getByText(title, { selector: '[title]' }).closest('div.group') as HTMLElement;
}

/** 在 conv-item 行内查未读红点（absolute + bg-[var(--danger)] span） */
function queryUnreadDot(row: HTMLElement): HTMLElement | null {
  return row.querySelector('span.absolute');
}

describe('SectionConvPanel 未读红点（v0.0.27）', () => {
  it('unread=true && !active → 红点存在', () => {
    renderPanel(mkSession({ id: 's1', unread: true }), null);
    expect(queryUnreadDot(getConvItem())).not.toBeNull();
  });

  it('unread=false && !active → 红点不存在', () => {
    renderPanel(mkSession({ id: 's2', unread: false }), null);
    expect(queryUnreadDot(getConvItem())).toBeNull();
  });

  it('unread=true && active=true → 红点不存在（已在前台，§5 交互7）', () => {
    renderPanel(mkSession({ id: 's3', unread: true }), 's3');
    expect(queryUnreadDot(getConvItem())).toBeNull();
  });

  it('unread=false && active=true → 红点不存在', () => {
    renderPanel(mkSession({ id: 's4', unread: false }), 's4');
    expect(queryUnreadDot(getConvItem())).toBeNull();
  });

  it('unread 缺省（undefined）→ 红点不存在（兼容历史 session）', () => {
    renderPanel(mkSession({ id: 's5' }), null);
    expect(queryUnreadDot(getConvItem())).toBeNull();
  });

  it('红点视觉 token：absolute + 7px + rounded-full + var(--danger)', () => {
    renderPanel(mkSession({ id: 's6', unread: true }), null);
    const dot = queryUnreadDot(getConvItem())!;
    const cls = dot.className;
    expect(cls).toContain('absolute');
    expect(cls).toContain('top-2');
    expect(cls).toContain('right-[18px]');
    expect(cls).toContain('w-[7px]');
    expect(cls).toContain('h-[7px]');
    expect(cls).toContain('rounded-full');
    expect(cls).toContain('bg-[var(--danger)]');
  });

  it('conv-item 容器含 relative（承载 absolute 红点）', () => {
    renderPanel(mkSession({ id: 's7', unread: true }), null);
    expect(getConvItem().className).toContain('relative');
  });

  it('点击 conv-item 触发 onSelect(id)', () => {
    let clicked: string | null = null;
    cleanup();
    render(
      <SectionConvPanel
        sessions={[mkSession({ id: 's8', unread: true })]}
        activeId={null}
        childrenByParent={{}}
        onSelect={(id) => {
          clicked = id;
        }}
        onSelectSub={() => {}}
        onCreate={() => {}}
        onDelete={() => {}}
      />,
    );
    getConvItem().click();
    expect(clicked).toBe('s8');
  });
});
