/**
 * @vitest-environment jsdom
 * component-bench-modal 单测（弹层元素契约 + reason 必填校验）
 * 参考: specs/ui/overall/06-studio.md §3.3（bench 弹层）
 *       specs/ui/components/studio-page/bench-modal.md
 *       specs/api/overall/11a-squad-endpoints.md §2.4（reason 必填，leader 403）
 *
 * 防御性锁定：bench 弹层是 v0.0.33.1 e2e 对齐补声明时发现的 spec gap
 * （impl 有弹层、spec 未声明、无 UT 覆盖）。本测锁定弹层契约防回归。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { BenchModal } from '../component-bench-modal';
import { mkMember } from './_fixtures';

// [v0.0.62 i18n] 启动 i18next：bench 弹层 title/label 走 studio ns
beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('BenchModal', () => {
  afterEach(() => cleanup());

  it('渲染 bench-modal 标题 + reason 输入 + 确认按钮（契约）', () => {
    render(<BenchModal member={mkMember({ id: 'm2', name: '张三' })} onClose={() => {}} onConfirm={() => {}} />);
    // 三个元素必须齐全（e2e member_bench_tc1 依赖）
    expect(screen.getByText('下岗 张三')).toBeTruthy();
    expect(screen.getByPlaceholderText('为什么下岗？')).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认下岗' })).toBeTruthy();
  });

  it('reason 为空时确认按钮 disabled；填入后激活并 onConfirm 上抛 trim 后的 reason', () => {
    const onConfirm = vi.fn();
    render(<BenchModal member={mkMember({ id: 'm2' })} onClose={() => {}} onConfirm={onConfirm} />);
    const confirm = screen.getByRole('button', { name: '确认下岗' }) as HTMLButtonElement;
    // 空 → disabled
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    // 填 reason → 激活
    fireEvent.change(screen.getByPlaceholderText('为什么下岗？'), { target: { value: '  临时下岗  ' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    // 上抛 trim 后的 reason（API 空串返 400，UI 同步 trim）
    expect(onConfirm).toHaveBeenCalledWith('临时下岗');
  });
});
