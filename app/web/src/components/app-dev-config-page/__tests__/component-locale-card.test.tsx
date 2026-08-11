/**
 * @vitest-environment jsdom
 * component-locale-card 单测 — v0.0.317 D8 受控化测试。
 *
 * 校验点：
 *   - 受控模式：value 决定选中态（非 i18n.language）
 *   - onChange 仅上报父级（不调 changeLanguage）
 *   - 点选中当前语言 → 不触发 onChange
 *   - 选项 label 自指（中文/English 不随 locale 变）
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { ComponentLocaleCard } from '../component-locale-card';
import type { LocaleId } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('ComponentLocaleCard — v0.0.317 D8 受控化', () => {
  beforeEach(() => { cleanup(); });
  afterEach(() => { cleanup(); });

  it('value="zh-CN" 时「中文」选中（aria-pressed=true）', () => {
    render(
      <ComponentLocaleCard value="zh-CN" onChange={vi.fn()} />,
    );
    const zhBtn = screen.getByText('中文').closest('button')!;
    expect(zhBtn.getAttribute('aria-pressed')).toBe('true');
    const enBtn = screen.getByText('English').closest('button')!;
    expect(enBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('value="en" 时「English」选中（不受 i18n.language 影响）', () => {
    render(
      <ComponentLocaleCard value="en" onChange={vi.fn()} />,
    );
    const enBtn = screen.getByText('English').closest('button')!;
    expect(enBtn.getAttribute('aria-pressed')).toBe('true');
    const zhBtn = screen.getByText('中文').closest('button')!;
    expect(zhBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('点未选中语言 → onChange 被调用（仅上报，不调 changeLanguage）', () => {
    const onChange = vi.fn();
    render(
      <ComponentLocaleCard value="zh-CN" onChange={onChange} />,
    );
    fireEvent.click(screen.getByText('English'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('en');
  });

  it('点已选中语言 → 不触发 onChange', () => {
    const onChange = vi.fn();
    render(
      <ComponentLocaleCard value="zh-CN" onChange={onChange} />,
    );
    fireEvent.click(screen.getByText('中文'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('选项 label 自指（始终显示中文/English）', () => {
    const { rerender } = render(
      <ComponentLocaleCard value="zh-CN" onChange={vi.fn()} />,
    );
    expect(screen.getByText('中文')).toBeTruthy();
    expect(screen.getByText('English')).toBeTruthy();
    // 切 value 到 en，label 仍是自指
    rerender(
      <ComponentLocaleCard value="en" onChange={vi.fn()} />,
    );
    expect(screen.getByText('中文')).toBeTruthy();
    expect(screen.getByText('English')).toBeTruthy();
  });

  it('切换 value 后选中态视觉同步', () => {
    const { rerender } = render(
      <ComponentLocaleCard value="zh-CN" onChange={vi.fn()} />,
    );
    expect(screen.getByText('中文').closest('button')!.getAttribute('aria-pressed')).toBe('true');
    rerender(
      <ComponentLocaleCard value="en" onChange={vi.fn()} />,
    );
    expect(screen.getByText('English').closest('button')!.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('中文').closest('button')!.getAttribute('aria-pressed')).toBe('false');
  });
});
