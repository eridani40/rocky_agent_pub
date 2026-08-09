// @vitest-environment jsdom
/**
 * component-ws-tree-item 单测 —— 结构 + 布局稳定性 + 文件夹/文件分支 + symlink 渲染（v0.0.263）
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §4.3（展开/收起）
 *       + §4.4（hover 打开按钮 opacity 切换不位移）+ §6.5（视觉基线 .ws-item）
 *       + specs/prd/version_logs/v0.0.263.workspace_symlink_browse/prd.md §3.5（symlink 节点渲染）
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentWsTreeItem } from '../component-ws-tree-item';
import type { WsTreeNode } from '../workspace-types';

afterEach(() => cleanup());

const dir = (path: string, hasChildren = true): WsTreeNode => ({
  name: path.split('/').pop() ?? path,
  path,
  type: 'dir',
  hasChildren,
});

const file = (path: string): WsTreeNode => ({
  name: path.split('/').pop() ?? path,
  path,
  type: 'file',
  hasChildren: false,
});

describe('ComponentWsTreeItem - 文件夹分支', () => {
  it('hasChildren=true 显示 twisty + item + open 按钮', () => {
    const { container } = render(
      <ComponentWsTreeItem
        node={dir('src')}
        depth={0}
        expanded={false}
        onToggleExpand={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(container.querySelector('.ws-item')).toBeTruthy();
    // twisty（i18n 未初始化 → raw key）
    expect(screen.getByRole('button', { name: 'common:action.expand' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chat:workspace.tree.openFolder' })).toBeTruthy();
  });

  it('点 twisty 触发 onToggleExpand(path)', () => {
    const onToggle = vi.fn();
    render(
      <ComponentWsTreeItem
        node={dir('src')}
        depth={0}
        expanded={false}
        onToggleExpand={onToggle}
        onOpen={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'common:action.expand' }));
    expect(onToggle).toHaveBeenCalledWith('src');
  });

  it('hasChildren=false 不显示 twisty（占位 placeholder）', () => {
    const { container } = render(
      <ComponentWsTreeItem
        node={dir('empty', false)}
        depth={0}
        expanded={false}
        onToggleExpand={() => {}}
        onOpen={() => {}}
      />,
    );
    // 无 twisty
    expect(screen.queryByRole('button', { name: 'common:action.expand' })).toBeNull();
    // 但 item 本身存在 + open 按钮在
    expect(container.querySelector('.ws-item')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'chat:workspace.tree.openFolder' })).toBeTruthy();
  });
});

describe('ComponentWsTreeItem - 文件分支', () => {
  it('无 twisty expand 按钮；hover 打开按钮在', () => {
    const { container } = render(
      <ComponentWsTreeItem
        node={file('src/a.ts')}
        depth={1}
        expanded={false}
        onToggleExpand={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(container.querySelector('.ws-item')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'common:action.expand' })).toBeNull();
    expect(screen.getByRole('button', { name: 'chat:workspace.tree.openFile' })).toBeTruthy();
  });

  it('点 hover 打开按钮触发 onOpen(node)', () => {
    const onOpen = vi.fn();
    const node = file('a.ts');
    render(
      <ComponentWsTreeItem
        node={node}
        depth={0}
        expanded={false}
        onToggleExpand={() => {}}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'chat:workspace.tree.openFile' }));
    expect(onOpen).toHaveBeenCalledWith(node);
  });
});

describe('ComponentWsTreeItem - 布局稳定性（§4.4）', () => {
  it('ws-act 用 opacity-0 + group-hover:opacity-100（不 display:none 避免位移）', () => {
    const { container } = render(
      <ComponentWsTreeItem
        node={file('a.ts')}
        depth={0}
        expanded={false}
        onToggleExpand={() => {}}
        onOpen={() => {}}
      />,
    );
    const act = screen.getByRole('button', { name: 'chat:workspace.tree.openFile' });
    // opacity-0 class 在（默认隐藏），无 hidden/display:none
    expect(act.className).toContain('opacity-0');
    expect(act.className).toContain('group-hover:opacity-100');
    // ws-item 自身是 group（驱动 group-hover）
    const item = container.querySelector('.ws-item')!;
    expect(item.className).toContain('group');
  });

  it('缩进 paddingLeft = 6 + depth * 14（§6.5）', () => {
    const { container, rerender } = render(
      <ComponentWsTreeItem
        node={file('a.ts')}
        depth={0}
        expanded={false}
        onToggleExpand={() => {}}
        onOpen={() => {}}
      />,
    );
    let item = container.querySelector('.ws-item') as HTMLElement;
    expect(item.style.paddingLeft).toBe('6px');

    rerender(
      <ComponentWsTreeItem
        node={file('src/a.ts')}
        depth={2}
        expanded={false}
        onToggleExpand={() => {}}
        onOpen={() => {}}
      />,
    );
    item = container.querySelector('.ws-item') as HTMLElement;
    // 6 + 2*14 = 34
    expect(item.style.paddingLeft).toBe('34px');
  });
});

describe('ComponentWsTreeItem - symlink 渲染（v0.0.263）', () => {
  const symlinkFile = (path: string, linkTarget: string): WsTreeNode => ({
    name: path.split('/').pop() ?? path,
    path,
    type: 'file',
    hasChildren: false,
    isSymlink: true,
    linkTarget,
  });

  it('isSymlink=true → 渲染 link 角标（data-testid）+ name title 设 tooltip（i18n 未初始化 → raw key）', () => {
    const { container } = render(
      <ComponentWsTreeItem
        node={symlinkFile('link.md', '/real/path/link.md')}
        depth={0}
        expanded={false}
        onToggleExpand={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(container.querySelector('[data-testid="symlink-badge-link.md"]')).toBeTruthy();
    const name = container.querySelector('.ws-name') as HTMLElement;
    // i18n 未初始化 → raw key（既有测试风格一致）；非空证明 tooltip 分支已设（缺省时 title=''）
    expect(name.title).toBe('chat:workspace.tree.symlinkTooltip');
  });

  it('isSymlink 缺省（undefined）→ 与旧渲染零差异（无角标、无 title）', () => {
    const { container } = render(
      <ComponentWsTreeItem
        node={file('a.ts')}
        depth={0}
        expanded={false}
        onToggleExpand={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(container.querySelector('[data-testid^="symlink-badge-"]')).toBeNull();
    const name = container.querySelector('.ws-name') as HTMLElement;
    expect(name.title).toBe('');
  });

  it('dir-symlink（isSymlink + type=dir + hasChildren）→ twisty 正常 + 角标在', () => {
    const node: WsTreeNode = {
      name: 'linkdir',
      path: 'linkdir',
      type: 'dir',
      hasChildren: true,
      isSymlink: true,
      linkTarget: '/real/dir',
    };
    const { container } = render(
      <ComponentWsTreeItem
        node={node}
        depth={0}
        expanded={false}
        onToggleExpand={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'common:action.expand' })).toBeTruthy();
    expect(container.querySelector('[data-testid="symlink-badge-linkdir"]')).toBeTruthy();
  });
});
