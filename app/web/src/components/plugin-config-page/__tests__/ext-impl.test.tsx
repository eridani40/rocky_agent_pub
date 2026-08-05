/**
 * @vitest-environment jsdom
 * component-ext-impl-{radio,checkbox,ordered} 单测
 * 参考: specs/ui/components/plugin-config-page/component-ext-impl-*.md
 *
 * 核心覆盖：radio 互斥 / checkbox 独立 / ordered 拖拽与开关正交。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { ComponentExtImplRadio } from '../component-ext-impl-radio';
import { ComponentExtImplCheckbox } from '../component-ext-impl-checkbox';
import { ComponentExtImplOrdered } from '../component-ext-impl-ordered';
import { initI18n } from '../../../i18n';

// DragHandle aria-label 走 framework ns
beforeAll(async () => {
  await initI18n('zh-CN');
});

/** 按 implId 文本定位 impl 行（label 或 draggable div） */
function getImplRow(implId: string): HTMLElement {
  return screen.getByText(implId).closest('label, [draggable]') as HTMLElement;
}

describe('ComponentExtImplRadio（exclusive 互斥）', () => {
  afterEach(() => cleanup());

  const pointId = 'llm_provider';
  const impls = [
    { implId: 'impl_a', pluginId: 'p1', selected: true, hasSchemaConfig: false },
    { implId: 'impl_b', pluginId: 'p2', selected: false, hasSchemaConfig: false },
  ];

  it('渲染每个 impl 一行 radio 卡片', () => {
    render(<ComponentExtImplRadio pointId={pointId} impls={impls} onSelect={() => {}} />);
    expect(getImplRow('impl_a')).toBeTruthy();
    expect(getImplRow('impl_b')).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('点未选项 impl_b → onSelect(impl_b) 触发（父级负责互斥取消其余）', () => {
    const onSelect = vi.fn();
    render(<ComponentExtImplRadio pointId={pointId} impls={impls} onSelect={onSelect} />);
    // 点 impl_b 的 radio input（未选中态）
    const radioB = getImplRow('impl_b').querySelector('input[type=radio]')!;
    fireEvent.click(radioB);
    expect(onSelect).toHaveBeenCalledWith('impl_b');
  });

  it('已选中的 radio input 是 disabled（不可直接取消，由选别的实现）', () => {
    render(<ComponentExtImplRadio pointId={pointId} impls={impls} onSelect={() => {}} />);
    const radioA = getImplRow('impl_a').querySelector('input[type=radio]')!;
    expect(radioA.getAttribute('disabled')).not.toBeNull();
  });

  it('hasSchemaConfig 时渲染齿轮配置按钮', () => {
    const withCfg = [
      { implId: 'impl_a', pluginId: 'p1', selected: true, hasSchemaConfig: true },
    ];
    const onConfig = vi.fn();
    render(<ComponentExtImplRadio pointId={pointId} impls={withCfg} onSelect={() => {}} onConfig={onConfig} />);
    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    expect(onConfig).toHaveBeenCalledWith('impl_a');
  });

  it('[v0.0.71 D4] disabled=true 时齿轮按钮仍渲染 + 仍可点击 + pointer-events-auto 类', () => {
    // 回归：父级 disabled=true 时容器带 `pointer-events-none`，齿轮按钮加 `pointer-events-auto` 显式覆盖。
    const withCfg = [
      { implId: 'impl_a', pluginId: 'p1', selected: true, hasSchemaConfig: true },
    ];
    const onConfig = vi.fn();
    render(
      <ComponentExtImplRadio
        pointId={pointId}
        impls={withCfg}
        onSelect={() => {}}
        onConfig={onConfig}
        disabled
      />,
    );
    const btn = screen.getByRole('button', { name: '配置', hidden: true });
    // 齿轮按钮渲染（D4 删 !disabled 守卫）
    expect(btn).toBeTruthy();
    // 关键：按钮 className 含 pointer-events-auto（覆盖父级 pointer-events-none）
    expect(btn.className).toContain('pointer-events-auto');
    // 点击仍能触发 onConfig（事件不被父级 pointer-events-none 截走）
    fireEvent.click(btn);
    expect(onConfig).toHaveBeenCalledWith('impl_a');
  });
});

describe('ComponentExtImplCheckbox（list 独立勾选）', () => {
  afterEach(() => cleanup());

  const pointId = 'llm_protocol';
  const impls = [
    { implId: 'impl_a', pluginId: 'p1', enabled: true, hasSchemaConfig: false },
    { implId: 'impl_b', pluginId: 'p2', enabled: false, hasSchemaConfig: false },
  ];

  it('渲染每个 impl 一行独立 checkbox', () => {
    render(<ComponentExtImplCheckbox pointId={pointId} impls={impls} onToggle={() => {}} />);
    expect(getImplRow('impl_a')).toBeTruthy();
    expect(getImplRow('impl_b')).toBeTruthy();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  it('勾 impl_b（off→on）→ onToggle(impl_b, true)，不影响 impl_a', () => {
    const onToggle = vi.fn();
    render(<ComponentExtImplCheckbox pointId={pointId} impls={impls} onToggle={onToggle} />);
    const cb = getImplRow('impl_b').querySelector('input[type=checkbox]')!;
    fireEvent.click(cb);
    expect(onToggle).toHaveBeenCalledWith('impl_b', true);
    expect(onToggle).not.toHaveBeenCalledWith('impl_a', expect.anything());
  });

  it('取消 impl_a（on→off）→ onToggle(impl_a, false)', () => {
    const onToggle = vi.fn();
    render(<ComponentExtImplCheckbox pointId={pointId} impls={impls} onToggle={onToggle} />);
    const cb = getImplRow('impl_a').querySelector('input[type=checkbox]')!;
    fireEvent.click(cb);
    expect(onToggle).toHaveBeenCalledWith('impl_a', false);
  });

  it('[v0.0.71 D4] disabled=true 时齿轮按钮仍渲染 + 仍可点击（pointer-events-auto 覆盖父级）', () => {
    const withCfg = [
      { implId: 'impl_a', pluginId: 'p1', enabled: true, hasSchemaConfig: true },
    ];
    const onConfig = vi.fn();
    render(
      <ComponentExtImplCheckbox
        pointId={pointId}
        impls={withCfg}
        onToggle={() => {}}
        onConfig={onConfig}
        disabled
      />,
    );
    const btn = screen.getByRole('button', { name: '配置', hidden: true });
    expect(btn).toBeTruthy();
    expect(btn.className).toContain('pointer-events-auto');
    fireEvent.click(btn);
    expect(onConfig).toHaveBeenCalledWith('impl_a');
  });
});

describe('ComponentExtImplOrdered（拖拽 + 独立开关正交）', () => {
  afterEach(() => cleanup());

  const pointId = 'message_handler';
  const impls = [
    { implId: 'impl_a', pluginId: 'p1', enabled: true, order: 0, hasSchemaConfig: false },
    { implId: 'impl_b', pluginId: 'p2', enabled: false, order: 1, hasSchemaConfig: false },
  ];

  it('渲染每行 + 拖拽手柄 + 独立开关', () => {
    render(<ComponentExtImplOrdered pointId={pointId} impls={impls} onReorder={() => {}} onToggle={() => {}} />);
    const rowA = getImplRow('impl_a');
    expect(rowA).toBeTruthy();
    // 拖拽手柄（aria-label 拖拽排序）
    expect(within(rowA).getByLabelText('拖拽排序')).toBeTruthy();
    // 独立开关
    expect(within(rowA).getByRole('switch')).toBeTruthy();
  });

  it('拖拽 drop → onReorder(from=0, to=1)', () => {
    const onReorder = vi.fn();
    render(<ComponentExtImplOrdered pointId={pointId} impls={impls} onReorder={onReorder} onToggle={() => {}} />);
    const rowA = getImplRow('impl_a');
    const rowB = getImplRow('impl_b');
    fireEvent.dragStart(rowA);
    fireEvent.dragOver(rowB);
    fireEvent.drop(rowB);
    expect(onReorder).toHaveBeenCalledWith(0, 1);
  });

  it('开关独立翻转 → onToggle(impl_a, false)，不触发 onReorder（正交）', () => {
    const onToggle = vi.fn();
    const onReorder = vi.fn();
    render(<ComponentExtImplOrdered pointId={pointId} impls={impls} onReorder={onReorder} onToggle={onToggle} />);
    fireEvent.click(within(getImplRow('impl_a')).getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith('impl_a', false);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('拖拽手柄点击不触发 onToggle（事件不冒泡）', () => {
    const onToggle = vi.fn();
    render(<ComponentExtImplOrdered pointId={pointId} impls={impls} onReorder={() => {}} onToggle={onToggle} />);
    fireEvent.click(within(getImplRow('impl_a')).getByLabelText('拖拽排序'));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('[v0.0.71 D4] disabled=true 时齿轮按钮仍渲染 + 仍可点击（pointer-events-auto 覆盖父级）', () => {
    const withCfg = [
      { implId: 'impl_a', pluginId: 'p1', enabled: true, order: 1, hasSchemaConfig: true },
    ];
    const onConfig = vi.fn();
    render(
      <ComponentExtImplOrdered
        pointId={pointId}
        impls={withCfg}
        onReorder={() => {}}
        onToggle={() => {}}
        onConfig={onConfig}
        disabled
      />,
    );
    const btn = screen.getByRole('button', { name: '配置', hidden: true });
    expect(btn).toBeTruthy();
    expect(btn.className).toContain('pointer-events-auto');
    fireEvent.click(btn);
    expect(onConfig).toHaveBeenCalledWith('impl_a');
  });
});
