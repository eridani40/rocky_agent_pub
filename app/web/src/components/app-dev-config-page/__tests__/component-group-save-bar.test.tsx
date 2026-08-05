/**
 * @vitest-environment jsdom
 * component-group-save-bar 单测：dirty 高亮 + saving 禁用 + onSave 触发
 * 参考: specs/ui/components/app-dev-config-page/component-group-save-bar.md
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentGroupSaveBar } from '../component-group-save-bar';
import { initI18n } from '../../../i18n';

// 启动 i18next instance（zh-CN），让 saveBar 内 useTranslation('common') 能查 locale 表
beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('ComponentGroupSaveBar', () => {
  afterEach(() => cleanup());

  it('渲染保存按钮', () => {
    render(<ComponentGroupSaveBar groupId="llm_request" dirty={false} saving={false} onSave={() => {}} />);
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
  });

  it('dirty=true 且非 saving → 按钮文案含 ● 标记，可点击，触发 onSave', () => {
    const onSave = vi.fn();
    render(<ComponentGroupSaveBar groupId="g1" dirty={true} saving={false} onSave={onSave} />);
    const btn = screen.getByRole('button', { name: '● 保存' }) as HTMLButtonElement;
    expect(btn.textContent).toContain('●');
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('saving=true → 按钮禁用 + 文案「保存中…」，点击不触发 onSave', () => {
    const onSave = vi.fn();
    render(<ComponentGroupSaveBar groupId="g1" dirty={true} saving={true} onSave={onSave} />);
    const btn = screen.getByRole('button', { name: '保存中…' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('保存中');
    fireEvent.click(btn);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('dirty=false 非 saving → 按钮文案「保存」无 ●，仍可点击', () => {
    const onSave = vi.fn();
    render(<ComponentGroupSaveBar groupId="g1" dirty={false} saving={false} onSave={onSave} />);
    const btn = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(btn.textContent).toBe('保存');
    expect(btn.textContent).not.toContain('●');
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  // ── BUG-011：「已保存」短暂反馈 ──

  it('saved=true 且非 dirty 非 saving → 显示「✓ 已保存」反馈节点（可见）', () => {
    render(<ComponentGroupSaveBar groupId="g1" dirty={false} saving={false} saved={true} onSave={() => {}} />);
    const savedNode = screen.getByText('✓ 已保存');
    // 可见态：opacity-100（非 opacity-0）
    expect(savedNode.className).toContain('opacity-100');
    expect(savedNode.className).not.toContain('opacity-0');
  });

  it('dirty=true 时即使 saved=true 也不显示已保存反馈（编辑后优先显示脏态提示）', () => {
    render(<ComponentGroupSaveBar groupId="g1" dirty={true} saving={false} saved={true} onSave={() => {}} />);
    const savedNode = screen.getByText('✓ 已保存');
    // dirty 期间隐藏已保存反馈（opacity-0 占位）
    expect(savedNode.className).toContain('opacity-0');
  });

  it('缺省 saved（不传）→ 已保存反馈节点存在但隐藏（opacity-0 占位，不位移按钮）', () => {
    render(<ComponentGroupSaveBar groupId="g1" dirty={false} saving={false} onSave={() => {}} />);
    const savedNode = screen.getByText('✓ 已保存');
    expect(savedNode.className).toContain('opacity-0');
  });
});
