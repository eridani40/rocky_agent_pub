/**
 * @vitest-environment jsdom
 * component-tuple-cards 单测 —— v0.0.219 四元组（无 Tools）+ Memory 卡查看入口
 * 参考: specs/ui/components/academy-page/component-tuple-cards.md
 *
 * 覆盖：
 * - 防回归（核心 v0.0.219）：Tools 卡已删（五元组 → 四元组）。
 * - Memory 卡：有 memory 条目 → 显条目数 + 「查看」按钮（onOpenMemoryModal）；空 → 显「暂无」无按钮。
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentTupleCards } from '../component-tuple-cards';
import type { VersionContent } from '../../../lib/academy-api';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

function makeContent(memory: VersionContent['content']['memory']): VersionContent['content'] {
  return {
    agentsMd: '',
    skills: [],
    memory,
    versionJson: { tools: ['search', 'calculator'], model: { providerId: 'p', modelId: 'm' } },
  };
}

describe('ComponentTupleCards — v0.0.219 四元组（Tools 删除）', () => {
  it('不渲染 Tools 卡（标题/图标不出现）', () => {
    render(
      <ComponentTupleCards
        studentName="学生"
        selLabel="1.0"
        selectedIsFormal={true}
        content={makeContent([])}
        modelSel={null}
        onOpenMdEditor={vi.fn()}
        onOpenSkillBrowser={vi.fn()}
        onOpenMemoryModal={vi.fn()}
        onModelChange={vi.fn()}
      />,
    );
    // Tools 标题与 chip 均不出现
    expect(screen.queryByText('Tools')).toBeNull();
    expect(screen.queryByText('search')).toBeNull();
    expect(screen.queryByText('calculator')).toBeNull();
  });

  it('渲染四张卡标题：System Prompt / Skills / Memory / 模型', () => {
    render(
      <ComponentTupleCards
        studentName="学生"
        selLabel="1.0"
        selectedIsFormal={true}
        content={makeContent([])}
        modelSel={null}
        onOpenMdEditor={vi.fn()}
        onOpenSkillBrowser={vi.fn()}
        onOpenMemoryModal={vi.fn()}
        onModelChange={vi.fn()}
      />,
    );
    expect(screen.getByText('System Prompt')).toBeTruthy();
    expect(screen.getByText('Skills')).toBeTruthy();
    expect(screen.getByText('Memory')).toBeTruthy();
    expect(screen.getByText('模型')).toBeTruthy();
  });
});

describe('ComponentTupleCards — Memory 卡查看入口（v0.0.219）', () => {
  it('memory 有条目 → 显条目数 + 「查看」按钮 → 点击触发 onOpenMemoryModal', () => {
    const onOpenMemoryModal = vi.fn();
    render(
      <ComponentTupleCards
        studentName="学生"
        selLabel="1.0"
        selectedIsFormal={true}
        content={makeContent([
          { name: 'a.md', size: 100, preview: 'preview-a' },
          { name: 'b.md', size: 200, preview: 'preview-b' },
        ])}
        modelSel={null}
        onOpenMdEditor={vi.fn()}
        onOpenSkillBrowser={vi.fn()}
        onOpenMemoryModal={onOpenMemoryModal}
        onModelChange={vi.fn()}
      />,
    );
    // 显「2 个条目」
    expect(screen.getByText('2 个条目')).toBeTruthy();
    // 点 Memory 卡的「查看」按钮（onAction → onOpenMemoryModal）
    // Memory 卡的查看按钮是 TupleCard head 内 BTN_GHOST/BTN_SM，文本「查看」
    const viewBtns = screen.getAllByRole('button', { name: '查看' });
    // Skills 卡也有「查看」，Memory 卡的查看按钮应在 Memory 卡 head 内；点最后一个（Memory）
    fireEvent.click(viewBtns[viewBtns.length - 1]!);
    expect(onOpenMemoryModal).toHaveBeenCalledTimes(1);
  });

  it('memory 空 → 显「暂无记忆条目」且无查看按钮（onOpenMemoryModal 不触发）', () => {
    const onOpenMemoryModal = vi.fn();
    render(
      <ComponentTupleCards
        studentName="学生"
        selLabel="1.0"
        selectedIsFormal={true}
        content={makeContent([])}
        modelSel={null}
        onOpenMdEditor={vi.fn()}
        onOpenSkillBrowser={vi.fn()}
        onOpenMemoryModal={onOpenMemoryModal}
        onModelChange={vi.fn()}
      />,
    );
    expect(screen.getByText('暂无记忆条目')).toBeTruthy();
    // 空 memory → Memory 卡无查看按钮（Skills 仍有一个查看按钮）
    expect(screen.getAllByRole('button', { name: '查看' }).length).toBe(1);
  });
});
