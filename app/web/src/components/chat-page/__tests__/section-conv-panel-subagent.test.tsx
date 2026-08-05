// @vitest-environment jsdom
/**
 * section-conv-panel subagent 行点击展开 + 挂载单测
 * 参考: specs/ui/components/chat-page/_overview.md §4.2（conv-item 行点击展开）/ §4.2a（subagent-tree）
 *       specs/ui/components/chat-page/component-subagent-tree.md（渲染条件 = parent expanded===true）
 *
 * 覆盖 acceptanceCriteria：
 *   - 行点击 → subagent-tree 渲染（running 子项存在）
 *   - 行点击幂等置 expanded=true（再次点击不 collapse，subagent-tree 仍在）
 *   - 行点击同时触发 onSelect（保留切 session 既有行为）
 *   - onSelectSub 透传到 component-subagent-tree
 *   - subagent session 不作顶层项
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SectionConvPanel } from '../section-conv-panel';
import type { ChildrenView, Session } from '../types';
import { initI18n } from '../../../i18n';

// 启动 i18next instance：conv-item 内 useTranslation 查 common.timeAgo.*
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'parent-1',
    title: '父会话',
    status: 'active',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
    ...overrides,
  };
}

function mkChildren(overrides: Partial<ChildrenView> = {}): ChildrenView {
  return {
    parentSessionId: 'parent-1',
    running: [{ sessionId: 'r1', name: 'explorer', state: 'running', subAgentTemplateType: 'explorer', updatedAt: '2026-06-28T00:00:00.000Z' }],
    terminated: [],
    ...overrides,
  };
}

interface PanelOpts {
  childrenByParent?: Record<string, ChildrenView>;
  activeId?: string | null;
  onSelect?: () => void;
  onSelectSub?: () => void;
  onCreate?: () => void;
  onDelete?: () => void;
}

function renderPanel(sessions: Session[], opts: PanelOpts = {}) {
  return render(
    <SectionConvPanel
      sessions={sessions}
      activeId={opts.activeId ?? null}
      childrenByParent={opts.childrenByParent ?? {}}
      onSelect={opts.onSelect ?? (() => {})}
      onSelectSub={opts.onSelectSub ?? (() => {})}
      onCreate={opts.onCreate ?? (() => {})}
      onDelete={opts.onDelete ?? (() => {})}
    />,
  );
}

/** 通过标题定位 conv-item 行容器 */
function getConvItem(title = '父会话'): HTMLElement {
  return screen.getByText(title, { selector: '[title]' }).closest('div.group') as HTMLElement;
}

describe('SectionConvPanel subagent 行点击展开', () => {
  it('行点击 → subagent-tree 渲染（running 子项存在）', () => {
    renderPanel([mkSession({ id: 'p1' })], {
      childrenByParent: { p1: mkChildren({ parentSessionId: 'p1' }) },
    });
    // 折叠态：subagent 子项不渲染
    expect(screen.queryByText('explorer')).toBeNull();
    // 点 conv-item 行展开
    fireEvent.click(getConvItem());
    expect(screen.getByText('explorer')).toBeTruthy();
  });

  it('行点击幂等：再次点击不 collapse（subagent-tree 仍在，无 collapse 入口）', () => {
    renderPanel([mkSession({ id: 'p1' })], {
      childrenByParent: { p1: mkChildren({ parentSessionId: 'p1' }) },
    });
    const row = getConvItem();
    fireEvent.click(row);
    expect(screen.getByText('explorer')).toBeTruthy();
    fireEvent.click(row);
    // 再次点击仍展开（不 toggle）
    expect(screen.getByText('explorer')).toBeTruthy();
  });

  it('行点击同时触发 onSelect（保留切 session 既有行为）', () => {
    const onSelect = vi.fn();
    renderPanel([mkSession({ id: 'p1' })], {
      childrenByParent: { p1: mkChildren({ parentSessionId: 'p1' }) },
      onSelect,
    });
    fireEvent.click(getConvItem());
    expect(onSelect).toHaveBeenCalledWith('p1');
  });

  it('点 subagent-item → onSelectSub 透传', () => {
    const onSelectSub = vi.fn();
    renderPanel([mkSession({ id: 'p1' })], {
      childrenByParent: { p1: mkChildren({ parentSessionId: 'p1' }) },
      onSelectSub,
    });
    fireEvent.click(getConvItem());
    // subagent 行 = name 文本的父元素
    fireEvent.click(screen.getByText('explorer').parentElement as HTMLElement);
    expect(onSelectSub).toHaveBeenCalledWith('r1');
  });

  it('无 subagent → 行点击不渲染 subagent-tree（hasSubagent=false）', () => {
    renderPanel([mkSession({ id: 'p1' })]);
    fireEvent.click(getConvItem());
    expect(screen.queryByText('explorer')).toBeNull();
  });

  it('subagent session 不作顶层项（page-chat 层过滤；panel 直接传入过滤后 sessions）', () => {
    const parent = mkSession({ id: 'p1' });
    renderPanel([parent], {
      childrenByParent: { p1: mkChildren({ parentSessionId: 'p1' }) },
    });
    // 仅父会话一个顶层 conv-item（r1 是 subagent，不作顶层项；未展开不渲染）
    expect(screen.getByText('父会话', { selector: '[title]' })).toBeTruthy();
    expect(screen.queryByText('explorer')).toBeNull();
  });
});
