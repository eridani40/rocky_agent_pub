// @vitest-environment jsdom
/**
 * component-subagent-tree 单测
 * 参考: specs/ui/components/chat-page/component-subagent-tree.md（视觉基线四维度）
 *       specs/ui/components/chat-page/_overview.md §4.2a + §8（tokens --color-indigo）
 *
 * 覆盖 acceptanceCriteria：
 *   - 三段结构渲染（running / 分割线 toggle「非运行中 (N)」 / terminated 展开/折叠）
 *   - subagent-item 视觉 token（padding / rounded-md 6px / hover bg-bg-warm / active accent-surface / name accent）
 *   - identity dot 11×11 rounded-3px var(--color-indigo)；terminated opacity 0.4
 *   - toggle 点击展开/折叠 terminated 段
 *   - 点 subagent-item → onSelectSub(sid) 被调
 */
import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ComponentSubagentTree } from '../component-subagent-tree';
import type { SubagentNode } from '../types';
import { initI18n } from '../../../i18n';

// 启动 i18next instance：terminatedCount 文案走 chat.subagent.terminatedCount
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

function mkNode(overrides: Partial<SubagentNode> = {}): SubagentNode {
  return {
    sessionId: 'child-1',
    name: 'explorer',
    state: 'running',
    subAgentTemplateType: 'explorer',
    updatedAt: '2026-06-28T00:00:00.000Z',
    ...overrides,
  };
}

/** 通过 name 文本定位 SubagentRow 容器（name span 的父元素即行 div） */
function getRow(name: string): HTMLElement {
  return screen.getByText(name).parentElement as HTMLElement;
}

/** terminated 段 toggle（button aria-expanded，文案「非运行中 (N)」） */
function getToggle(): HTMLElement {
  return screen.getByRole('button', { name: /非运行中/ });
}

describe('ComponentSubagentTree 三段结构', () => {
  it('三段结构齐全（running / toggle / terminated 默认折叠）', () => {
    const { container } = render(
      <ComponentSubagentTree
        parentSessionId="p1"
        running={[mkNode({ sessionId: 'r1', name: 'run-agent' })]}
        terminated={[mkNode({ sessionId: 't1', state: 'idle', name: 'term-agent' })]}
        onSelectSub={() => {}}
      />,
    );
    // root + running 段容器
    const root = container.firstElementChild as HTMLElement;
    expect(root).toBeTruthy();
    expect(root.firstElementChild).toBeTruthy();
    // toggle 在
    expect(getToggle()).toBeTruthy();
    // terminated 段默认折叠 → 不渲染
    expect(screen.queryByText('term-agent')).toBeNull();
    // running item + dot
    const row = getRow('run-agent');
    expect(row).toBeTruthy();
    expect(row.querySelector('span[aria-hidden]')).toBeTruthy();
  });

  it('terminated 段默认折叠，点 toggle 展开后渲染 terminated items', () => {
    render(
      <ComponentSubagentTree
        parentSessionId="p1"
        running={[mkNode({ sessionId: 'r1', name: 'run-a' })]}
        terminated={[mkNode({ sessionId: 't1', state: 'idle', name: 'term-1' }), mkNode({ sessionId: 't2', state: 'error', name: 'term-2' })]}
        onSelectSub={() => {}}
      />,
    );
    // 折叠态：terminated 项不存在
    expect(screen.queryByText('term-1')).toBeNull();

    // 点 toggle 展开
    fireEvent.click(getToggle());
    expect(screen.getByText('term-1')).toBeTruthy();
    expect(screen.getByText('term-2')).toBeTruthy();

    // 再点折叠
    fireEvent.click(getToggle());
    expect(screen.queryByText('term-1')).toBeNull();
  });

  it('分割线文案「非运行中 (N)」+ 数量随 terminated 长度', () => {
    render(
      <ComponentSubagentTree
        parentSessionId="p1"
        running={[]}
        terminated={[mkNode({ sessionId: 't1', state: 'idle' }), mkNode({ sessionId: 't2', state: 'interrupted' }), mkNode({ sessionId: 't3', state: 'error' })]}
        onSelectSub={() => {}}
      />,
    );
    const toggle = getToggle();
    expect(toggle.textContent).toContain('非运行中 (3)');
    // JetBrains Mono 10px（视觉基线）
    const textSpan = toggle.querySelector('span:last-of-type');
    expect(textSpan?.className).toContain('font-mono');
    expect(textSpan?.className).toContain('text-[10px]');
  });

  it('无 terminated 时不渲染 toggle（仅 running 段）', () => {
    render(
      <ComponentSubagentTree
        parentSessionId="p1"
        running={[mkNode({ sessionId: 'r1' })]}
        terminated={[]}
        onSelectSub={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /非运行中/ })).toBeNull();
  });

  it('running 空时 running 段容器仍渲染（三段结构稳定）', () => {
    const { container } = render(
      <ComponentSubagentTree
        parentSessionId="p1"
        running={[]}
        terminated={[mkNode({ sessionId: 't1', state: 'idle', name: 'term-x' })]}
        onSelectSub={() => {}}
      />,
    );
    // running 容器始终存在（即使内部无子项）= root 的第一个子元素
    const root = container.firstElementChild as HTMLElement;
    const runningSection = root.firstElementChild as HTMLElement;
    expect(runningSection).toBeTruthy();
    // running 段内无子项（running 空）
    expect(runningSection.children.length).toBe(0);
    // toggle 在（terminated 非空）
    expect(getToggle()).toBeTruthy();
  });
});

describe('ComponentSubagentTree subagent-item 视觉基线', () => {
  it('running subitem：padding 5px 10px 5px 48px + rounded-md 6px + hover bg-bg-warm', () => {
    render(
      <ComponentSubagentTree
        parentSessionId="p1"
        running={[mkNode({ sessionId: 'r1', name: 'vis-agent' })]}
        terminated={[]}
        onSelectSub={() => {}}
      />,
    );
    const item = getRow('vis-agent');
    const style = item.style;
    expect(style.padding).toBe('5px 10px 5px 48px');
    expect(style.borderRadius).toBe('6px');
    // 非终止态：opacity = 1
    expect(style.opacity).toBe('1');
    // hover bg-bg-warm（className 含 hover:bg-bg-warm）
    expect(item.className).toContain('hover:bg-bg-warm');
  });

  it('active subitem：bg-accent-surface + name accent', () => {
    render(
      <ComponentSubagentTree
        parentSessionId="p1"
        running={[mkNode({ sessionId: 'r1', name: 'active-agent' })]}
        terminated={[]}
        activeSubId="r1"
        onSelectSub={() => {}}
      />,
    );
    const item = getRow('active-agent');
    expect(item.className).toContain('bg-accent-surface');
    const nameSpan = item.querySelector('span:last-of-type');
    expect(nameSpan?.className).toContain('text-[var(--color-accent)]');
  });

  it('identity dot：11×11 + rounded-3px + var(--color-indigo)', () => {
    render(
      <ComponentSubagentTree
        parentSessionId="p1"
        running={[mkNode({ sessionId: 'r1', name: 'dot-agent' })]}
        terminated={[]}
        onSelectSub={() => {}}
      />,
    );
    const dot = getRow('dot-agent').querySelector('span[aria-hidden]') as HTMLElement;
    const style = dot.style;
    expect(style.width).toBe('11px');
    expect(style.height).toBe('11px');
    expect(style.borderRadius).toBe('3px');
    expect(dot.className).toContain('bg-[var(--color-indigo)]');
  });

  it('terminated subitem：opacity 0.4 + name muted', () => {
    render(
      <ComponentSubagentTree
        parentSessionId="p1"
        running={[]}
        terminated={[mkNode({ sessionId: 't1', state: 'idle', name: 'gray-agent' })]}
        onSelectSub={() => {}}
      />,
    );
    // 展开 terminated 段
    fireEvent.click(getToggle());
    const item = getRow('gray-agent');
    expect(item.style.opacity).toBe('0.4');
    const nameSpan = item.querySelector('span:last-of-type');
    expect(nameSpan?.className).toContain('text-muted');
  });

  it('subagent name：Inter 12.5px（font-sans + text-[12.5px]）', () => {
    render(
      <ComponentSubagentTree
        parentSessionId="p1"
        running={[mkNode({ sessionId: 'r1', name: 'font-agent' })]}
        terminated={[]}
        onSelectSub={() => {}}
      />,
    );
    const nameSpan = getRow('font-agent').querySelector('span:last-of-type');
    expect(nameSpan?.className).toContain('font-sans');
    expect(nameSpan?.className).toContain('text-[12.5px]');
  });
});

describe('ComponentSubagentTree 交互', () => {
  it('点 subagent-item → onSelectSub(sessionId) 被调', () => {
    const onSelectSub = vi.fn();
    render(
      <ComponentSubagentTree
        parentSessionId="p1"
        running={[mkNode({ sessionId: 'r1', name: 'click-agent' })]}
        terminated={[]}
        onSelectSub={onSelectSub}
      />,
    );
    fireEvent.click(getRow('click-agent'));
    expect(onSelectSub).toHaveBeenCalledWith('r1');
  });

  it('点 subagent-item 不冒泡到 parent（stopPropagation）', () => {
    const parentClick = vi.fn();
    const onSelectSub = vi.fn();
    render(
      <div onClick={parentClick}>
        <ComponentSubagentTree
          parentSessionId="p1"
          running={[mkNode({ sessionId: 'r1', name: 'bubble-agent' })]}
          terminated={[]}
          onSelectSub={onSelectSub}
        />
      </div>,
    );
    fireEvent.click(getRow('bubble-agent'));
    expect(onSelectSub).toHaveBeenCalledWith('r1');
    // parent 未收到冒泡
    expect(parentClick).not.toHaveBeenCalled();
  });
});

describe('ComponentSubagentTree 共享形态（flat + onOpenNode，academy 训练观察树）', () => {
  it('flat：行/toggle 去 48px conv 缩进', () => {
    render(
      <ComponentSubagentTree
        flat
        running={[mkNode({ sessionId: 'r1', name: 'flat-agent' })]}
        terminated={[mkNode({ sessionId: 't1', state: 'idle', name: 'flat-term' })]}
      />,
    );
    expect(getRow('flat-agent').style.padding).toBe('6px 10px');
    expect(getToggle().style.padding).toBe('4px 10px');
  });

  it('onOpenNode：running 行渲观察链接（注入文案），点击回调且不触发行点击', () => {
    const onOpenNode = vi.fn();
    render(
      <ComponentSubagentTree
        flat
        running={[mkNode({ sessionId: 'r1', name: 'watch-agent' })]}
        terminated={[]}
        onOpenNode={onOpenNode}
        openNodeLabel="👁 观察 →"
      />,
    );
    const link = screen.getByRole('button', { name: '👁 观察 →' });
    fireEvent.click(link);
    expect(onOpenNode).toHaveBeenCalledWith('r1');
  });

  it('terminated 行无观察链接（design §8.8 跑完无入口）', () => {
    render(
      <ComponentSubagentTree
        flat
        running={[]}
        terminated={[mkNode({ sessionId: 't1', state: 'idle', name: 'done-agent' })]}
        onOpenNode={() => {}}
        openNodeLabel="👁 观察 →"
      />,
    );
    fireEvent.click(getToggle());
    expect(screen.getByText('done-agent')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '👁 观察 →' })).toBeNull();
  });

  it('terminatedLabel 注入覆盖缺省「非运行中 (N)」文案', () => {
    render(
      <ComponentSubagentTree
        flat
        running={[]}
        terminated={[mkNode({ sessionId: 't1', state: 'idle' }), mkNode({ sessionId: 't2', state: 'error' })]}
        terminatedLabel="… 共 2 条"
      />,
    );
    expect(screen.getByRole('button', { name: /共 2 条/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /非运行中/ })).toBeNull();
  });

  it('无 onSelectSub → 行不可点（无 action-key / 无 cursor-pointer）', () => {
    render(
      <ComponentSubagentTree
        flat
        running={[mkNode({ sessionId: 'r1', name: 'noclick-agent' })]}
        terminated={[]}
      />,
    );
    const row = getRow('noclick-agent');
    expect(row.getAttribute('data-action-key')).toBeNull();
    expect(row.className).not.toContain('cursor-pointer');
  });

  it('缺省（非 flat 无新 props）：既有形态零变化——48px 缩进 + 无观察链接', () => {
    render(
      <ComponentSubagentTree
        parentSessionId="p1"
        running={[mkNode({ sessionId: 'r1', name: 'legacy-agent' })]}
        terminated={[]}
        onSelectSub={() => {}}
      />,
    );
    const row = getRow('legacy-agent');
    expect(row.style.padding).toBe('5px 10px 5px 48px');
    expect(row.getAttribute('data-action-key')).toBe('chat.subagent.open');
    expect(row.querySelector('button')).toBeNull();
  });
});
