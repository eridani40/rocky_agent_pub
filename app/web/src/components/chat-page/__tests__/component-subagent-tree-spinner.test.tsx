// @vitest-environment jsdom
/**
 * component-subagent-tree SubagentRow running spinner 单测
 * 参考: specs/ui/components/chat-page/component-subagent-tree.md（SubagentRow spinner）
 *
 * 覆盖 acceptanceCriteria：
 *   - node.state='running' → SubagentRow 渲染 SpinnerRing（size="sm" 10×10）
 *   - node.state='interrupting' → 仍渲染（仍属 running 态）
 *   - node.state='suspended' → 不渲染（subagent 是派生只读视图，无 suspended「?」）
 *   - node.state='idle' / 'error' / 'interrupted'（terminated 组）→ 不渲染
 *   - terminated 灰显 + 无 spinner 共存（terminated 全灰显）
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ComponentSubagentTree } from '../component-subagent-tree';
import type { SubagentNode } from '../types';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

function mkNode(overrides: Partial<SubagentNode> = {}): SubagentNode {
  return {
    sessionId: 'sub-1',
    name: 'explorer',
    state: 'running',
    subAgentTemplateType: 'explorer',
    updatedAt: '2026-06-28T00:00:00.000Z',
    ...overrides,
  };
}

function renderTree(running: SubagentNode[], terminated: SubagentNode[] = []) {
  return render(
    <ComponentSubagentTree
      parentSessionId="p1"
      running={running}
      terminated={terminated}
      onSelectSub={() => {}}
    />,
  );
}

/** 通过 name 文本定位 SubagentRow 容器（name span 的父元素即行 div） */
function getRow(name = 'explorer'): HTMLElement {
  return screen.getByText(name).parentElement as HTMLElement;
}

describe('SubagentRow running spinner', () => {
  it("node.state='running' → SubagentRow 内渲染 SpinnerRing（10×10 sm size）", () => {
    renderTree([mkNode({ sessionId: 'sub-run', state: 'running' })]);
    const row = getRow();
    // spinner 是 SubagentRow 内的 SpinnerRing 渲染产物——查 class animate-spin（border-t-accent 视觉）
    const spinner = row.querySelector('.animate-spin');
    expect(spinner).not.toBeNull();
    // sm size：10px（inline-block shrink-0 rounded-full）
    expect(spinner?.className).toContain('animate-spin');
    expect((spinner as HTMLElement).style.width).toBe('10px');
    expect((spinner as HTMLElement).style.height).toBe('10px');
  });

  it("node.state='interrupting' → 仍渲染 spinner（interrupting 属 running 态）", () => {
    renderTree([mkNode({ sessionId: 'sub-int', state: 'interrupting' })]);
    expect(getRow().querySelector('.animate-spin')).not.toBeNull();
  });

  it("node.state='suspended' → 不渲染 spinner（subagent 无 suspended「?」）", () => {
    renderTree([mkNode({ sessionId: 'sub-sus', state: 'suspended' as SubagentNode['state'] })]);
    expect(getRow().querySelector('.animate-spin')).toBeNull();
  });

  it("terminated 组（idle/error/interrupted）→ 不渲染 spinner（灰显 opacity 0.4）", () => {
    renderTree(
      [],
      [
        mkNode({ sessionId: 'sub-idle', state: 'idle' }),
        mkNode({ sessionId: 'sub-err', state: 'error' }),
        mkNode({ sessionId: 'sub-stop', state: 'interrupted' }),
      ],
    );
    // 展开 terminated 段（button aria-expanded，文案「非运行中 (3)」）
    fireEvent.click(screen.getByRole('button', { name: /非运行中/ }));
    const rows = screen.getAllByText('explorer').map((el) => el.parentElement as HTMLElement);
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.querySelector('.animate-spin')).toBeNull();
      // 灰显：terminated opacity 0.4
      expect(row.style.opacity).toBe('0.4');
    }
  });

  it('running spinner 槽位固定（layout 稳定性）：name 右侧 ml-auto shrink-0 12×12 槽位', () => {
    renderTree([mkNode({ sessionId: 'sub-layout', state: 'running' })]);
    const row = getRow();
    // 槽位 div：ml-auto + shrink-0 + 12×12 inline-flex
    const slot = row.querySelector('div.ml-auto');
    expect(slot).not.toBeNull();
    expect(slot?.className).toContain('shrink-0');
    expect(slot?.className).toContain('w-[12px]');
    expect(slot?.className).toContain('h-[12px]');
    // 槽位内含 spinner
    expect(slot?.querySelector('.animate-spin')).not.toBeNull();
  });

  it('多 running children 并存：每个 SubagentRow 各自渲染 spinner（独立）', () => {
    renderTree([
      mkNode({ sessionId: 'sub-a', state: 'running', name: 'agent-a' }),
      mkNode({ sessionId: 'sub-b', state: 'interrupting', name: 'agent-b' }),
      mkNode({ sessionId: 'sub-c', state: 'running', name: 'agent-c' }),
    ]);
    for (const name of ['agent-a', 'agent-b', 'agent-c']) {
      const row = getRow(name);
      expect(row.querySelector('.animate-spin')).not.toBeNull();
    }
  });
});
