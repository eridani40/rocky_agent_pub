// @vitest-environment jsdom
/**
 * component-input-effort-picker 单测（v0.0.148 新增）
 * 参考: specs/ui/components/chat-page/component-input-effort-picker.md
 *       specs/prd/version_logs/v0.0.148/change_log.md §1.3
 *
 * 覆盖：
 *   - trigger testid chat-effort-picker + ZapIcon SVG 存在 + 21px 尺寸
 *   - 根容器 relative shrink-0（让 absolute 浮层基于根定位）
 *   - 4 档渲染（default/low/high/max）+ 当前档 selected 高亮
 *   - click 展开 effort-picker-menu + 4 个 effort-picker-item-{level}
 *   - 选中项触发 onChange 上抛 canonical level
 *   - null effort → 视为 default 缺省
 *   - disabled → 点击不展开菜单
 *   - hover 预览 effort-picker-preview（单条当前档）+ 与 menu 互斥
 */
import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { InputEffortPicker } from '../component-input-effort-picker';
import { initI18n } from '../../../i18n';

// 初始化真实 i18n resources（zh-CN），让 t() 返回翻译文案而非 key 本身
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

/** trigger 按钮（aria-haspopup=listbox，纯图标） */
function getTrigger(): HTMLButtonElement {
  return document.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement;
}

describe('InputEffortPicker — trigger 渲染', () => {
  it('trigger testid=chat-effort-picker + 内含 ZapIcon SVG', () => {
    render(<InputEffortPicker effort="default" onChange={() => {}} />);
    const trigger = getTrigger() as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(trigger.querySelector('svg')).toBeTruthy();
  });

  it('trigger 21px 尺寸（class 含 h-[21px] w-[21px]）', () => {
    render(<InputEffortPicker effort="default" onChange={() => {}} />);
    const trigger = getTrigger() as HTMLButtonElement;
    expect(trigger.className).toContain('h-[21px]');
    expect(trigger.className).toContain('w-[21px]');
  });

  it('根容器 relative + shrink-0（absolute 浮层基于根定位）', () => {
    const { container } = render(<InputEffortPicker effort="default" onChange={() => {}} />);
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain('relative');
    expect(root.className).toContain('shrink-0');
  });

  it('trigger aria-label 含当前档文案（i18n）', () => {
    render(<InputEffortPicker effort="high" onChange={() => {}} />);
    const trigger = getTrigger() as HTMLButtonElement;
    // 默认 locale = zh-CN（vitest setup），high → 「高」
    expect(trigger.getAttribute('aria-label')).toContain('高');
  });
});

describe('InputEffortPicker — click 菜单 4 档', () => {
  it('click trigger → 展开 effort-picker-menu + 4 个 item', () => {
    render(<InputEffortPicker effort="default" onChange={() => {}} />);
    fireEvent.click(getTrigger());
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByRole('button', { name: '默认' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '低' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '高' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '超高' })).toBeTruthy();
  });

  it('当前档项 selected 高亮（text-accent font-medium）', () => {
    render(<InputEffortPicker effort="low" onChange={() => {}} />);
    fireEvent.click(getTrigger());
    const lowItem = screen.getByRole('button', { name: '低' });
    expect(lowItem.className).toContain('text-accent');
    expect(lowItem.className).toContain('font-medium');
    // 其他档非 selected
    const highItem = screen.getByRole('button', { name: '高' });
    expect(highItem.className).not.toContain('text-accent');
  });

  it('click item → onChange 上抛 canonical level + 菜单关闭', () => {
    const onChange = vi.fn();
    render(<InputEffortPicker effort="default" onChange={onChange} />);
    fireEvent.click(getTrigger());
    fireEvent.click(screen.getByRole('button', { name: '超高' }));
    expect(onChange).toHaveBeenCalledWith('max');
    // 选中后菜单关闭
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('null effort → 视为 default 缺省（default 项 selected）', () => {
    render(<InputEffortPicker effort={null} onChange={() => {}} />);
    fireEvent.click(getTrigger());
    const defaultItem = screen.getByRole('button', { name: '默认' });
    expect(defaultItem.className).toContain('text-accent');
  });

  it('菜单项左对齐 + w-full 整行可点（同 model-picker 风格）', () => {
    render(<InputEffortPicker effort="default" onChange={() => {}} />);
    fireEvent.click(getTrigger());
    const item = screen.getByRole('button', { name: '低' });
    expect(item.className).toContain('text-left');
    expect(item.className).toContain('w-full');
  });
});

// ============================================================
// [v0.0.148 picker UI 统一] click 菜单顶部加题目行
// 参考: specs/ui/components/chat-page/component-input-effort-picker.md（pickerTitle）
// ============================================================
describe('InputEffortPicker — click 菜单题目行（picker UI 统一）', () => {
  it('click 菜单顶部渲染题目行 effort-picker-menu-title（文案=推理强度）', () => {
    render(<InputEffortPicker effort="default" onChange={() => {}} />);
    fireEvent.click(getTrigger());
    const title = screen.getByRole('heading', { name: '推理强度' });
    expect(title).toBeTruthy();
    expect(title.textContent).toContain('推理强度');
  });

  it('题目行在选项上方（DOM 顺序：title 在 item 之前）', () => {
    render(<InputEffortPicker effort="default" onChange={() => {}} />);
    fireEvent.click(getTrigger());
    const menu = screen.getByRole('listbox');
    const title = screen.getByRole('heading', { name: '推理强度' });
    const firstItem = screen.getByRole('button', { name: '默认' });
    // 题目 DOM 顺序在第一个选项之前（options 在题目下方）
    expect(title.compareDocumentPosition(firstItem) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    void menu;
  });

  it('未 click 展开时题目行不渲染（题目仅 click 菜单）', () => {
    render(<InputEffortPicker effort="default" onChange={() => {}} />);
    expect(screen.queryByRole('heading', { name: '推理强度' })).toBeNull();
  });
});

describe('InputEffortPicker — disabled + hover 预览', () => {
  it('disabled=true → trigger.disabled + 点击不展开菜单', () => {
    render(<InputEffortPicker effort="default" disabled={true} onChange={() => {}} />);
    const trigger = getTrigger() as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('hover → 渲染 effort-picker-preview（单条当前档 selected 高亮）', () => {
    render(<InputEffortPicker effort="high" onChange={() => {}} />);
    const root = getTrigger().parentElement as HTMLElement;
    fireEvent.mouseEnter(root);
    const preview = screen.getByRole('listbox');
    expect(preview).toBeTruthy();
    expect(preview.textContent).toContain('高');
    const item = preview.firstElementChild as HTMLElement;
    expect(item.className).toContain('text-accent');
  });

  it('mouseLeave → preview 消失', () => {
    render(<InputEffortPicker effort="default" onChange={() => {}} />);
    const root = getTrigger().parentElement as HTMLElement;
    fireEvent.mouseEnter(root);
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.mouseLeave(root);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('click 展开后 preview 不渲染（与 menu 互斥）', () => {
    render(<InputEffortPicker effort="default" onChange={() => {}} />);
    const root = getTrigger().parentElement as HTMLElement;
    fireEvent.click(getTrigger());
    expect(screen.getByRole('listbox')).toBeTruthy();
    // 再 hover —— preview 不应渲染（与 menu 互斥）；listbox 总数仍为 1（仅 menu）
    fireEvent.mouseEnter(root);
    expect(screen.getAllByRole('listbox')).toHaveLength(1);
  });
});
