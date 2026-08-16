// @vitest-environment jsdom
/**
 * component-quota-ring 单测（v0.0.356 T1 + 圆环 stroke 修复防回归）
 * 参考: specs/prd/squad-quota-entry-demo-v2.html §②（.ring r-used/.r-time）
 *       outputs/bugs/quota-entry-ring-missing.md（text-* 类不设 stroke 的 bug 根因）
 *
 * 覆盖：
 *   - 底环 + 进度环两个 circle 均显式 stroke="currentColor"（防回归：仅靠 text-* 类时
 *     circle stroke 计算值 = none，圆环不渲染只剩百分比数字）
 *   - clamp 0-100 + dashoffset 方向（percent 越高 offset 越小）
 *   - role="progressbar" + aria-label 透传
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { QuotaRing } from '../component-quota-ring';

afterEach(() => cleanup());

describe('QuotaRing SVG 圆环 stroke 防回归（bug: 圆环缺失只剩数字）', () => {
  it('底环 + 进度环均显式 stroke="currentColor"（继承 text-* 类的 color）', () => {
    const { container } = render(<QuotaRing percent={40} label="5小时额度" centerText="40%" kind="used" />);
    const circles = container.querySelectorAll('circle');
    expect(circles.length).toBe(2);
    for (const c of circles) {
      expect(c.getAttribute('stroke')).toBe('currentColor');
    }
    // 底环走 track 色类、进度环走主色类
    expect(circles[0]!.classList.contains('text-border')).toBe(true);
    expect(circles[1]!.classList.contains('text-fg')).toBe(true);
  });

  it('fast=true → 进度环琥珀（text-gold）；kind=time → 时间环 text-muted + 底环 text-bg-warm', () => {
    const { container, rerender } = render(<QuotaRing percent={10} label="周额度" centerText="10%" kind="used" fast />);
    expect(container.querySelectorAll('circle')[1]!.classList.contains('text-gold')).toBe(true);
    rerender(<QuotaRing percent={10} label="5小时" centerText="1小时" kind="time" />);
    const circles = container.querySelectorAll('circle');
    expect(circles[0]!.classList.contains('text-bg-warm')).toBe(true);
    expect(circles[1]!.classList.contains('text-muted')).toBe(true);
  });

  it('percent clamp 0-100 且进度环 dashoffset 随 percent 递减', () => {
    const { container, rerender } = render(<QuotaRing percent={150} label="l" centerText="c" kind="used" />);
    const offset100 = Number(container.querySelectorAll('circle')[1]!.getAttribute('stroke-dashoffset'));
    expect(offset100).toBe(0); // clamp 到 100 → offset=0
    rerender(<QuotaRing percent={-5} label="l" centerText="c" kind="used" />);
    const off0 = Number(container.querySelectorAll('circle')[1]!.getAttribute('stroke-dashoffset'));
    const c = 2 * Math.PI * ((36 - 5) / 2);
    expect(off0).toBeCloseTo(c, 5); // clamp 到 0 → offset=周长（不画进度）
  });

  it('role="progressbar" + aria-label 透传', () => {
    const { container } = render(
      <QuotaRing percent={30} label="周额度" centerText="30%" kind="used" ariaLabel="anthropic 周额度: 30%" />,
    );
    const bar = container.querySelector('[role="progressbar"]')!;
    expect(bar).toBeTruthy();
    expect(bar.getAttribute('aria-label')).toBe('anthropic 周额度: 30%');
    expect(bar.getAttribute('aria-valuenow')).toBe('30');
  });
});
