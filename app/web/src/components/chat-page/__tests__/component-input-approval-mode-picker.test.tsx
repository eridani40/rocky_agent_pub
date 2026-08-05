// @vitest-environment jsdom
/**
 * component-input-approval-mode-picker 单测（v0.0.148 新增）
 * 参考: specs/ui/components/chat-page/component-input-approval-mode-picker.md
 *       specs/prd/version_logs/v0.0.148/change_log.md §2.4
 *
 * 覆盖：
 *   - trigger testid chat-approval-mode-picker + AlertIcon SVG + 21px
 *   - 2 档渲染（normal/greenlight）+ 当前档 selected 高亮
 *   - click 展开 approval-mode-picker-menu + 2 item
 *   - 选中项触发 onChange 上抛 canonical mode
 *   - null → 视为 normal 缺省
 *   - greenlight 态 trigger 色调 text-accent（绿灯视觉强调）
 *   - disabled → 点击不展开
 *   - hover 预览 + 与 menu 互斥
 */
import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { InputApprovalModePicker } from '../component-input-approval-mode-picker';
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

describe('InputApprovalModePicker — trigger 渲染', () => {
  it('trigger testid=chat-approval-mode-picker + 内含 AlertIcon SVG', () => {
    render(<InputApprovalModePicker approvalMode="normal" onChange={() => {}} />);
    const trigger = getTrigger() as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(trigger.querySelector('svg')).toBeTruthy();
  });

  it('trigger 21px 尺寸 + 根容器 relative shrink-0', () => {
    const { container } = render(
      <InputApprovalModePicker approvalMode="normal" onChange={() => {}} />,
    );
    const trigger = getTrigger() as HTMLButtonElement;
    expect(trigger.className).toContain('h-[21px]');
    expect(trigger.className).toContain('w-[21px]');
    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain('relative');
    expect(root.className).toContain('shrink-0');
  });

  it('normal 态 trigger 色调 text-fg（缺省非强调）', () => {
    render(<InputApprovalModePicker approvalMode="normal" onChange={() => {}} />);
    const trigger = getTrigger() as HTMLButtonElement;
    expect(trigger.className).toContain('text-fg');
    expect(trigger.className).not.toContain('text-accent');
  });

  it('greenlight 态 trigger 色调 text-accent（绿灯视觉强调）', () => {
    render(<InputApprovalModePicker approvalMode="greenlight" onChange={() => {}} />);
    const trigger = getTrigger() as HTMLButtonElement;
    expect(trigger.className).toContain('text-accent');
  });

  it('trigger aria-label 含当前模式文案（i18n）', () => {
    render(<InputApprovalModePicker approvalMode="greenlight" onChange={() => {}} />);
    const trigger = getTrigger() as HTMLButtonElement;
    expect(trigger.getAttribute('aria-label')).toContain('绿灯');
  });
});

describe('InputApprovalModePicker — click 菜单 2 档', () => {
  it('click trigger → 展开 menu + normal/greenlight 2 item', () => {
    render(<InputApprovalModePicker approvalMode="normal" onChange={() => {}} />);
    fireEvent.click(getTrigger());
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByRole('button', { name: '普通' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '绿灯' })).toBeTruthy();
  });

  it('当前模式项 selected 高亮', () => {
    render(<InputApprovalModePicker approvalMode="greenlight" onChange={() => {}} />);
    fireEvent.click(getTrigger());
    const glItem = screen.getByRole('button', { name: '绿灯' });
    expect(glItem.className).toContain('text-accent');
    expect(glItem.className).toContain('font-medium');
    const normalItem = screen.getByRole('button', { name: '普通' });
    expect(normalItem.className).not.toContain('text-accent');
  });

  it('click item → onChange 上抛 canonical mode + 菜单关闭', () => {
    const onChange = vi.fn();
    render(<InputApprovalModePicker approvalMode="normal" onChange={onChange} />);
    fireEvent.click(getTrigger());
    fireEvent.click(screen.getByRole('button', { name: '绿灯' }));
    expect(onChange).toHaveBeenCalledWith('greenlight');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('null approvalMode → 视为 normal 缺省（normal 项 selected）', () => {
    render(<InputApprovalModePicker approvalMode={null} onChange={() => {}} />);
    fireEvent.click(getTrigger());
    const normalItem = screen.getByRole('button', { name: '普通' });
    expect(normalItem.className).toContain('text-accent');
  });
});

// ============================================================
// [v0.0.148 picker UI 统一] click 菜单顶部题目行
// 参考: specs/ui/components/chat-page/component-input-approval-mode-picker.md
// ============================================================
describe('InputApprovalModePicker — click 菜单题目行（picker UI 统一）', () => {
  it('click 菜单顶部渲染题目行 approval-mode-picker-menu-title（文案=审批模式）', () => {
    render(<InputApprovalModePicker approvalMode="normal" onChange={() => {}} />);
    fireEvent.click(getTrigger());
    const title = screen.getByRole('heading', { name: '审批模式' });
    expect(title).toBeTruthy();
    expect(title.textContent).toContain('审批模式');
  });

  it('题目行在选项上方（DOM 顺序：title 在 item 之前）', () => {
    render(<InputApprovalModePicker approvalMode="normal" onChange={() => {}} />);
    fireEvent.click(getTrigger());
    const title = screen.getByRole('heading', { name: '审批模式' });
    const firstItem = screen.getByRole('button', { name: '普通' });
    expect(title.compareDocumentPosition(firstItem) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('未 click 展开时题目行不渲染', () => {
    render(<InputApprovalModePicker approvalMode="normal" onChange={() => {}} />);
    expect(screen.queryByRole('heading', { name: '审批模式' })).toBeNull();
  });
});

describe('InputApprovalModePicker — disabled + hover 预览', () => {
  it('disabled=true → trigger.disabled + 点击不展开', () => {
    render(<InputApprovalModePicker approvalMode="normal" disabled={true} onChange={() => {}} />);
    const trigger = getTrigger() as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('hover → 渲染 preview（单条当前模式 selected 高亮）', () => {
    render(<InputApprovalModePicker approvalMode="greenlight" onChange={() => {}} />);
    const root = getTrigger().parentElement as HTMLElement;
    fireEvent.mouseEnter(root);
    const preview = screen.getByRole('listbox');
    expect(preview).toBeTruthy();
    expect(preview.textContent).toContain('绿灯');
  });

  it('mouseLeave → preview 消失', () => {
    render(<InputApprovalModePicker approvalMode="normal" onChange={() => {}} />);
    const root = getTrigger().parentElement as HTMLElement;
    fireEvent.mouseEnter(root);
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.mouseLeave(root);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('click 展开后 preview 不渲染（与 menu 互斥）', () => {
    render(<InputApprovalModePicker approvalMode="normal" onChange={() => {}} />);
    const root = getTrigger().parentElement as HTMLElement;
    fireEvent.click(getTrigger());
    expect(screen.getByRole('listbox')).toBeTruthy();
    // 再 hover —— preview 不应渲染（与 menu 互斥）；listbox 总数仍为 1（仅 menu）
    fireEvent.mouseEnter(root);
    expect(screen.getAllByRole('listbox')).toHaveLength(1);
  });
});
