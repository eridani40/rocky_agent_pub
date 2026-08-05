/**
 * @vitest-environment jsdom
 * section-studio-sidebar 单测 —— v0.0.168 侧栏手风琴展开树彻底删除
 * 参考: specs/ui/components/studio-page/studio-sidebar.md v1.6
 *       specs/ui/overall/06-studio.md §2 v0.0.168 修订
 *
 * 覆盖：
 * - 容器（aside）+ 新建按钮 + squad 单行渲染
 * - 点 squad 行触发 onSelectSquad（不再有 expand / 展开树）
 * - **无树节点**：侧栏内除 squad 行外无任何可点按钮（展开树已删，grep 归零契约）
 * - **无右键浮层**：侧栏内右键不弹浮层菜单（迁到坐席卡）
 * - 键盘可达：Enter/Space 触发 onSelectSquad
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { StudioSidebar } from '../section-studio-sidebar';
import { mkSummary } from './_fixtures';

beforeAll(async () => {
  await initI18n('zh-CN');
});
afterEach(() => cleanup());

/** 侧栏根容器（<aside>） */
function sidebarOf(container: HTMLElement): HTMLElement {
  return container.querySelector('aside') as HTMLElement;
}

/** 新建 squad 按钮（aria-label「新建 squad」） */
function newSquadBtn(): HTMLElement {
  return screen.getByRole('button', { name: '新建 squad' });
}

/** 按 squad 名称定位行（role=button，accessible name 含名称 + 成员数） */
function squadRow(name: string | RegExp): HTMLElement {
  return screen.getByRole('button', { name });
}

describe('StudioSidebar — v0.0.168 简化（无展开树）', () => {
  it('渲染 container + 新建按钮 + squad 行', () => {
    const { container } = render(
      <StudioSidebar
        squads={[mkSummary({ id: 's1', name: 'Alpha 小队' })]}
        selectedSquadId="s1"
        onSelectSquad={() => {}}
        onNewSquad={() => {}}
      />,
    );
    expect(sidebarOf(container)).toBeTruthy();
    expect(newSquadBtn()).toBeTruthy();
    expect(squadRow(/Alpha 小队/)).toBeTruthy();
  });

  it('empty squads → 提示文案，无 squad 行', () => {
    const { container } = render(
      <StudioSidebar
        squads={[]}
        selectedSquadId={null}
        onSelectSquad={() => {}}
        onNewSquad={() => {}}
      />,
    );
    // 空态文案在，且无任何 squad 行（仅新建按钮一个 button）
    expect(screen.getByText('暂无 squad，点右上「+」新建。')).toBeTruthy();
    expect(within(sidebarOf(container)).getAllByRole('button')).toHaveLength(1);
  });

  it('点 squad 行 → onSelectSquad(id) 触发一次', () => {
    const onSelectSquad = vi.fn();
    render(
      <StudioSidebar
        squads={[mkSummary({ id: 's1' })]}
        selectedSquadId={null}
        onSelectSquad={onSelectSquad}
        onNewSquad={() => {}}
      />,
    );
    fireEvent.click(squadRow(/Alpha 小队/));
    expect(onSelectSquad).toHaveBeenCalledTimes(1);
    expect(onSelectSquad).toHaveBeenCalledWith('s1');
  });

  it('点新建按钮 → onNewSquad 触发', () => {
    const onNewSquad = vi.fn();
    render(
      <StudioSidebar
        squads={[]}
        selectedSquadId={null}
        onSelectSquad={() => {}}
        onNewSquad={onNewSquad}
      />,
    );
    fireEvent.click(newSquadBtn());
    expect(onNewSquad).toHaveBeenCalledTimes(1);
  });

  it('v0.0.168：无手风琴展开树 —— 侧栏内除 squad 行外无任何可点按钮（grep 归零契约）', () => {
    const { container } = render(
      <StudioSidebar
        squads={[mkSummary({ id: 's1' })]}
        selectedSquadId="s1"
        onSelectSquad={() => {}}
        onNewSquad={() => {}}
      />,
    );
    // 侧栏全部 button = 新建按钮 + 1 个 squad 行；团队看板/群聊/leader/mate/subagent 子节点全废
    const buttons = within(sidebarOf(container)).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    // 无展开态派生节点（未读红点 / spinner / suspended 文案均无）
    expect(screen.queryByText(/未读/)).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('v0.0.168：侧栏内不再触发右键浮层菜单（迁到坐席卡）', () => {
    render(
      <StudioSidebar
        squads={[mkSummary({ id: 's1' })]}
        selectedSquadId="s1"
        onSelectSquad={() => {}}
        onNewSquad={() => {}}
      />,
    );
    // squad 行右键：不出浮层菜单（sidebar 不再持 contextMenu state）
    fireEvent.contextMenu(squadRow(/Alpha 小队/), { clientX: 100, clientY: 100 });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('squad 行选中态：selected → bg-accent-surface；非 selected → hover:bg-bg-warm', () => {
    render(
      <StudioSidebar
        squads={[mkSummary({ id: 's1' }), mkSummary({ id: 's2', name: 'Beta 小队', memberCount: 3 })]}
        selectedSquadId="s1"
        onSelectSquad={() => {}}
        onNewSquad={() => {}}
      />,
    );
    const s1Row = squadRow(/Alpha 小队/);
    const s2Row = squadRow(/Beta 小队/);
    expect(s1Row.className).toContain('bg-accent-surface');
    expect(s2Row.className).not.toContain('bg-accent-surface');
    expect(s2Row.className).toContain('hover:bg-bg-warm');
  });

  it('v0.0.168：squad 行 role="button" + tabIndex=0，Enter/Space 触发 onSelectSquad', () => {
    const onSelectSquad = vi.fn();
    render(
      <StudioSidebar
        squads={[mkSummary({ id: 's1' })]}
        selectedSquadId={null}
        onSelectSquad={onSelectSquad}
        onNewSquad={() => {}}
      />,
    );
    const row = squadRow(/Alpha 小队/);
    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('tabindex')).toBe('0');
    // 无 aria-expanded（无展开态）
    expect(row.hasAttribute('aria-expanded')).toBe(false);
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onSelectSquad).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(row, { key: ' ' });
    expect(onSelectSquad).toHaveBeenCalledTimes(2);
  });
});
