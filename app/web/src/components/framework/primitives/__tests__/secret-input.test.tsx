/**
 * @vitest-environment jsdom
 * primitive-secret-input 单测：maskSecret 纯函数 + 四态机流转
 * 参考: specs/ui/components/framework/primitive-secret-input.md
 *
 * 覆盖：
 *   1. maskSecret：空 / 短值 (1-4) / 中值 (5-8) / 边界 (8 vs 9) / 长值 (>8)
 *   2. 四态流转：空 → 编辑 → ✓ commit → dirty → mask 展示 → 编辑 → 自动清空 → 回车提交
 *   3. Esc cancel / 空态提交空 / disabled
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useState } from 'react';
import { SecretInput, maskSecret } from '../secret-input';
import { initI18n } from '../../../../i18n';

beforeAll(async () => {
  await initI18n('en');
});

/** 受控包装：commit 后更新 value，便于测试提交后回到 mask 展示态 */
function ControlledSecret({ initial = '', onCommitSpy }: { initial?: string; onCommitSpy?: (n: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <SecretInput
      value={v}
      onCommit={(n) => {
        setV(n);
        onCommitSpy?.(n);
      }}
    />
  );
}

/** 获取根容器（带 data-mode 属性的 div） */
function getRoot(container: HTMLElement) {
  return container.querySelector('[data-mode]')!;
}

describe('maskSecret', () => {
  it('空串 → 空串', () => {
    expect(maskSecret('')).toBe('');
  });

  it('len 1-4 → 全 *（避免泄露比例过大）', () => {
    expect(maskSecret('a')).toBe('*');
    expect(maskSecret('ab')).toBe('**');
    expect(maskSecret('abc')).toBe('***');
    expect(maskSecret('abcd')).toBe('****');
  });

  it('len 5-8 → 首 1 + * ×(len-2) + 末 1', () => {
    expect(maskSecret('abcde')).toBe('a***e');
    expect(maskSecret('abcdef')).toBe('a****f');
    expect(maskSecret('abcdefg')).toBe('a*****g');
    expect(maskSecret('abcdefgh')).toBe('a******h');
  });

  it('len > 8 → 首 4 + * ×(len-8) + 末 4', () => {
    expect(maskSecret('sk-abc123456')).toBe('sk-a****3456'); // len 12: sk-a + **** + 3456
    expect(maskSecret('123456789')).toBe('1234*6789'); // len 9: 1234 + * + 6789
    expect(maskSecret('12345678901234567890')).toBe('1234************7890'); // len 20: 1234 + 12 个 * + 7890
  });

  it('边界：len 8 vs len 9 跳变', () => {
    expect(maskSecret('abcdefgh')).toBe('a******h'); // len 8 走 1+6+1
    expect(maskSecret('abcdefghi')).toBe('abcd*fghi'); // len 9 走 4+1+4
  });

  it('总长 = 真实长（不变长不变短）', () => {
    const samples = ['', 'a', 'abcd', 'abcde', 'abcdefgh', 'abcdefghi', 'sk-abc123456789'];
    for (const s of samples) {
      expect(maskSecret(s).length).toBe(s.length);
    }
  });
});

describe('SecretInput', () => {
  afterEach(() => cleanup());

  it('空态展示 placeholder + data-mode=display + data-empty=true', () => {
    const { container } = render(<SecretInput value="" onCommit={() => {}} />);
    expect(getRoot(container).getAttribute('data-mode')).toBe('display');
    expect(getRoot(container).getAttribute('data-empty')).toBe('true');
    expect(screen.getByText('Enter new value').textContent).toBe('Enter new value');
    // 空态不渲染编辑按钮
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('非空展示态：展示 mask 而非原文 + 渲染 ✎ 编辑按钮', () => {
    render(<SecretInput value="sk-secret-12345" onCommit={() => {}} />);
    const display = screen.getByText(maskSecret('sk-secret-12345'));
    // 不能泄露原文中段
    expect(display.textContent).not.toContain('ecret');
    expect(display.textContent).not.toContain('12345');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
  });

  it('空态点击 display → 进入编辑态（input + ✓ commit 按钮）', () => {
    const { container } = render(<SecretInput value="" onCommit={() => {}} />);
    fireEvent.click(screen.getByText('Enter new value'));
    expect(getRoot(container).getAttribute('data-mode')).toBe('editing');
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Commit' })).toBeTruthy();
    // 编辑态无 display / edit 按钮
    expect(screen.queryByText('Enter new value', { selector: 'div' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('编辑态输入 → 回车提交 → onCommit 收到新值 + 退出到展示态', () => {
    const onCommit = vi.fn();
    const { container } = render(<SecretInput value="" onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Enter new value'));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'sk-newvalue-xyz' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('sk-newvalue-xyz');
    expect(getRoot(container).getAttribute('data-mode')).toBe('display');
  });

  it('点击 ✓ 按钮 → 提交 draft（与 Enter 等价）', () => {
    const onCommit = vi.fn();
    render(<SecretInput value="" onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Enter new value'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'val1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }));
    expect(onCommit).toHaveBeenCalledWith('val1');
  });

  it('编辑态 input blur → cancel：onCommit 未调 + 回展示态 + onCancel 触发 + 原值还原', () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(<SecretInput value="sk-original" onCommit={onCommit} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'typed-but-not-committed' } });
    // blur = 放弃编辑（焦点离开，非点 ✓）
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(getRoot(container).getAttribute('data-mode')).toBe('display');
    // 仍展示原值 mask（draft 丢弃，未被 draft 覆盖）
    expect(screen.getByText(maskSecret('sk-original')).textContent).toBe(maskSecret('sk-original'));
    // field 已卸载（回展示态）
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('点 ✓ 按钮 → 仍能 commit（mousedown preventDefault 防 blur 吞掉 click）', () => {
    const onCommit = vi.fn();
    render(<SecretInput value="" onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Enter new value'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'val1' } });
    const commit = screen.getByRole('button', { name: 'Commit' });
    // 走完整 mousedown → click 序列：真实浏览器中 mousedown 先于 input blur 触发，
    // preventDefault 阻止焦点迁移 → input 不 blur → click 正常 fire → commit 成功。
    fireEvent.mouseDown(commit);
    fireEvent.click(commit);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('val1');
  });

  it('提交后进入 mask 展示态（dirty 标记，data-empty=false）', () => {
    const { container } = render(<ControlledSecret initial="" />);
    fireEvent.click(screen.getByText('Enter new value'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'sk-committed-1' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    // 提交后展示 mask
    expect(getRoot(container).getAttribute('data-empty')).toBe('false');
    expect(screen.getByText(maskSecret('sk-committed-1')).textContent).toBe(maskSecret('sk-committed-1'));
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
  });

  it('非空 → 点击 ✎ 编辑 → draft 自动清空（编辑 secret = 重输）', () => {
    render(<SecretInput value="sk-existing-abc" onCommit={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('编辑态按 Esc → cancel：onCancel 触发 + 退出编辑 + 原值不变', () => {
    const onCancel = vi.fn();
    const { container } = render(<SecretInput value="sk-original" onCommit={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'something-typed' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(getRoot(container).getAttribute('data-mode')).toBe('display');
    // 仍展示原值 mask（未被 draft 覆盖）
    expect(screen.getByText(maskSecret('sk-original')).textContent).toBe(maskSecret('sk-original'));
  });

  it('空态下输入空白回车 → 不触发 onCommit，仅退出到 display', () => {
    const onCommit = vi.fn();
    const { container } = render(<SecretInput value="" onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Enter new value'));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(getRoot(container).getAttribute('data-mode')).toBe('display');
  });

  it('draft 提交时自动 trim（前后空白剥离）', () => {
    const onCommit = vi.fn();
    render(<SecretInput value="" onCommit={onCommit} />);
    fireEvent.click(screen.getByText('Enter new value'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  sk-trim-me  ' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('sk-trim-me');
  });

  it('disabled：不渲染编辑按钮，点击 display 不进入编辑态', () => {
    const { container } = render(<SecretInput value="sk-readonly" onCommit={() => {}} disabled />);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    fireEvent.click(screen.getByText(maskSecret('sk-readonly')));
    expect(getRoot(container).getAttribute('data-mode')).toBe('display');
  });

  it('完整流转：空 → 编辑 → commit → mask 展示 → 再编辑（清空）→ 回车提交新值', () => {
    const { container } = render(<ControlledSecret initial="" />);

    // 1. 空 → 编辑
    expect(getRoot(container).getAttribute('data-empty')).toBe('true');
    fireEvent.click(screen.getByText('Enter new value'));

    // 2. 输入 → 提交
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first-secret-value' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    // 3. mask 展示（dirty）
    expect(getRoot(container).getAttribute('data-empty')).toBe('false');
    expect(screen.getByText(maskSecret('first-secret-value')).textContent).toBe(maskSecret('first-secret-value'));

    // 4. 再编辑 → draft 必须清空
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');

    // 5. 输入新值 → 回车提交
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'second-value' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    // 6. mask 展示更新为新值
    expect(screen.getByText(maskSecret('second-value')).textContent).toBe(maskSecret('second-value'));
  });
});
